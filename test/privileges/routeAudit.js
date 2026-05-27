// Drift-detector for the privilege matrix's `/api/*` route coverage.
//
// Two related audits run against the same parse of the source files:
//   1. **Coverage audit** (`auditApiRoutes`) — every `/api/*` route registered
//      in source must have a matching row in `matrix.ROUTES` (or be listed in
//      PUBLIC_PATH_ALLOWLIST). This catches the "new route shipped without a
//      matrix row" drift class.
//   2. **Level audit** (`auditMatrixLevels`) — for every matrix row that the
//      coverage audit *can* find in source, the matrix's `level` must agree
//      with the middleware chain actually applied at the registration site
//      (`requireAdmin` / `requireManagerOrAdmin` / `requirePrivilege('member'
//      | 'manager')` / global `isAuthenticated`). This catches the drift
//      gap called out in task #706: a sensitive admin route registered under
//      a non-`/api/admin/*` prefix (the WhatsApp routes were the trigger)
//      whose matrix row accidentally says `level: 'auth'` instead of
//      `'admin'`. Without this check the matrix run still passes because
//      the gate decision is never measured against the source of truth.
//
// The level audit only covers `/api/*` registrations and skips matrix rows
// with `level: 'public'` (AUTH_WHITELIST is asserted separately by the
// coverage audit) and `level: 'self-or-admin'` (custom in-handler semantics
// that don't map to a single middleware identifier).

const fs = require('fs');
const path = require('path');

// Source files that register routes on the Express app/router. Add new files
// here if route registrations move.
const SOURCE_FILES = [
  'server.js',
  'auth.js',
  'design-visits.js',
  'visits.js',
  'quickbooks.js',
];

// Capture every `app.<verb>('/api/…')` and `router.<verb>('/api/…')` call.
// (The matrix exclusively assesses `/api/*` routes; non-API pages like
// `/admin` or `/trades` are still represented by hand-curated rows.)
const REGISTER_RE =
  /\b(?:app|router)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*(['"`])(\/api\/[^'"`]*)\2/gi;

// Documented public `/api/*` paths that are intentionally reachable without
// a session. Mirrors the AUTH_WHITELIST in server.js plus the regex-matched
// design-visit sign-off routes. Keep this list in sync with the gate in
// server.js. Entries are either literal paths or RegExp instances matched
// against the full pattern (e.g. `/api/design-visits/sign-off/:token`).
const PUBLIC_PATH_ALLOWLIST = [
  '/api/turnstile-config',
  '/api/login',
  '/api/check-email',
  '/api/request-access',
  '/api/forgot-password',
  '/api/set-password',
  '/api/set-password/validate',
  // Token-gated public design-visit sign-off (server.js gate at line 138).
  /^\/api\/design-visits\/sign-off\/:[^/]+$/,
  // HMAC-signed image stream (design-visits.js). The router is mounted
  // BEFORE the global /api isAuthenticated gate in server.js, so this
  // route is intentionally public and gated by the signature in `sig`.
  /^\/api\/design-visit-images\/:[^/]+$/,
];

function isPublicPath(pattern) {
  for (const allow of PUBLIC_PATH_ALLOWLIST) {
    if (typeof allow === 'string') {
      if (allow === pattern) return true;
    } else if (allow instanceof RegExp) {
      if (allow.test(pattern)) return true;
    }
  }
  return false;
}

// Inspect the source slice immediately after a route-registration match and
// return the privilege middleware identifiers found before the request
// handler begins. The slice is bounded to 1KB and trimmed at the first
// `, (req…` or `, async (req…`, so multi-line registrations (e.g.
// design-visits.js: `requireAdmin,\n  upload.single(...),`) are still
// captured but the handler body is excluded from the scan.
function extractMiddlewareNames(src, startIdx) {
  const chunk = src.slice(startIdx, startIdx + 1024);
  const handlerIdx = chunk.search(/,\s*(?:async\s*)?\(\s*(?:_?req|_)\b/);
  const slice = handlerIdx > -1 ? chunk.slice(0, handlerIdx) : chunk;
  const found = [];
  if (/\brequireAdmin\b/.test(slice)) found.push('requireAdmin');
  if (/\brequireManagerOrAdmin\b/.test(slice)) found.push('requireManagerOrAdmin');
  if (/\brequirePrivilege\s*\(\s*['"]admin['"]\s*\)/.test(slice)) {
    found.push("requirePrivilege('admin')");
  }
  if (/\brequirePrivilege\s*\(\s*['"]manager['"]\s*\)/.test(slice)) {
    found.push("requirePrivilege('manager')");
  }
  if (/\brequirePrivilege\s*\(\s*['"]member['"]\s*\)/.test(slice)) {
    found.push("requirePrivilege('member')");
  }
  if (/\bisAuthenticated\b/.test(slice)) found.push('isAuthenticated');
  return found;
}

// Map the middleware chain at a registration site to one of the matrix's
// level buckets. Higher-privilege middleware wins (requireAdmin beats
// requirePrivilege('member'), etc.). For `/api/*` routes the global gate
// in server.js (`app.use('/api', isAuthenticated)`) provides at least
// `'auth'` even when no per-route middleware appears in the chain — so
// `/api/logout` (no per-route middleware, not in AUTH_WHITELIST) is `'auth'`,
// not `'public'`.
function chainToSourceLevel(middleware, pattern) {
  if (middleware.includes('requireAdmin')) return 'admin';
  if (middleware.includes("requirePrivilege('admin')")) return 'admin';
  if (middleware.includes('requireManagerOrAdmin')) return 'manager';
  if (middleware.includes("requirePrivilege('manager')")) return 'manager';
  if (middleware.includes("requirePrivilege('member')")) return 'member';
  if (middleware.includes('isAuthenticated')) return 'auth';
  // Implicit global `/api` gate: any /api/* route not in PUBLIC_PATH_ALLOWLIST
  // is wrapped by isAuthenticated even without per-route middleware.
  if (pattern.startsWith('/api/') && !isPublicPath(pattern)) return 'auth';
  return 'public';
}

function extractApiRoutesFromSource(repoRoot = path.resolve(__dirname, '..', '..')) {
  const found = [];
  for (const rel of SOURCE_FILES) {
    const abs = path.join(repoRoot, rel);
    let src;
    try { src = fs.readFileSync(abs, 'utf8'); }
    catch { continue; }
    let m;
    REGISTER_RE.lastIndex = 0;
    while ((m = REGISTER_RE.exec(src)) !== null) {
      const method = m[1].toUpperCase();
      const pattern = m[3];
      const lineNo = src.slice(0, m.index).split('\n').length;
      const middleware = extractMiddlewareNames(src, m.index);
      const sourceLevel = chainToSourceLevel(middleware, pattern);
      found.push({ method, pattern, file: rel, line: lineNo, middleware, sourceLevel });
    }
  }
  return found;
}

// Backwards-compatible alias — older callers only cared about admin routes.
function extractAdminRoutesFromSource(repoRoot) {
  return extractApiRoutesFromSource(repoRoot)
    .filter(r => r.pattern.startsWith('/api/admin/'));
}

// Strip a `?query=...` suffix and split into segments.
function splitPath(p) {
  return p.replace(/\?.*$/, '').split('/').filter(s => s.length > 0);
}

// True when a concrete literal path (`/api/admin/lead-statuses/foo`) is an
// instance of an Express route pattern (`/api/admin/lead-statuses/:key`).
function literalMatchesPattern(literal, pattern) {
  const a = splitPath(literal);
  const b = splitPath(pattern);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (b[i].startsWith(':')) continue;
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function getMatrixApiRoutes(matrixRoutes) {
  return matrixRoutes
    .filter(r => r.path.startsWith('/api/'))
    .map(r => ({ method: r.method.toUpperCase(), path: r.path, level: r.level }));
}

function getMatrixAdminRoutes(matrixRoutes) {
  return matrixRoutes
    .filter(r => r.path.startsWith('/api/admin/'))
    .map(r => ({ method: r.method.toUpperCase(), path: r.path, level: r.level }));
}

// Returns `{ missing: [{method, pattern, file, line, scope}, …] }` listing
// source routes with no matching matrix row. `scope` is `'admin'` for
// `/api/admin/*` paths and `'non-admin'` for everything else, so the
// formatter can group the failure message.
function auditApiRoutes(matrixRoutes, opts = {}) {
  const sourceRoutes = extractApiRoutesFromSource(opts.repoRoot);
  const matrixRows = getMatrixApiRoutes(matrixRoutes);
  const missing = [];
  for (const src of sourceRoutes) {
    if (isPublicPath(src.pattern)) continue;
    const covered = matrixRows.some(mx =>
      mx.method === src.method && literalMatchesPattern(mx.path, src.pattern)
    );
    if (!covered) {
      missing.push({
        ...src,
        scope: src.pattern.startsWith('/api/admin/') ? 'admin' : 'non-admin',
      });
    }
  }
  return { sourceRoutes, matrixRows, missing };
}

// Backwards-compatible wrapper. Older callers only audited admin routes;
// they now get the full audit so non-admin drift fails the run too.
function auditAdminRoutes(matrixRoutes, opts = {}) {
  return auditApiRoutes(matrixRoutes, opts);
}

// Compare matrix `level` against the middleware actually applied at every
// `/api/*` registration site. Returns `{ mismatches: [{method, path, file,
// line, middleware, sourceLevel, matrixLevel}, …] }`. Matrix rows whose
// level is `'public'` (asserted by PUBLIC_PATH_ALLOWLIST) or
// `'self-or-admin'` (custom in-handler semantics) are skipped. Source
// routes not represented in the matrix are skipped too — those are reported
// by `auditApiRoutes`.
function auditMatrixLevels(matrixRoutes, opts = {}) {
  const sourceRoutes = opts.sourceRoutes || extractApiRoutesFromSource(opts.repoRoot);
  const matrixRows = getMatrixApiRoutes(matrixRoutes);
  const mismatches = [];
  for (const mx of matrixRows) {
    if (mx.level === 'public' || mx.level === 'self-or-admin') continue;
    const src = sourceRoutes.find(s =>
      s.method === mx.method && literalMatchesPattern(mx.path, s.pattern)
    );
    if (!src) continue; // coverage audit will already flag this
    if (src.sourceLevel !== mx.level) {
      mismatches.push({
        method: mx.method,
        path: mx.path,
        pattern: src.pattern,
        file: src.file,
        line: src.line,
        middleware: src.middleware,
        sourceLevel: src.sourceLevel,
        matrixLevel: mx.level,
      });
    }
  }
  return { mismatches, sourceRoutes, matrixRows };
}

function formatMissingMessage(missing) {
  const adminMisses = missing.filter(m => m.scope === 'admin');
  const otherMisses = missing.filter(m => m.scope !== 'admin');
  const lines = [
    `Privilege matrix is missing ${missing.length} /api/* route(s).`,
    `Add a row to test/privileges/matrix.js for each entry below so the`,
    `gate decision is exercised for every actor (member, viewer, etc).`,
    `If a route is intentionally public, add it to PUBLIC_PATH_ALLOWLIST in`,
    `test/privileges/routeAudit.js instead.`,
    '',
  ];
  if (adminMisses.length) {
    lines.push(`  /api/admin/* (${adminMisses.length}):`);
    for (const m of adminMisses) {
      lines.push(`    - ${m.method.padEnd(6)} ${m.pattern}   (${m.file}:${m.line})`);
    }
  }
  if (otherMisses.length) {
    if (adminMisses.length) lines.push('');
    lines.push(`  other /api/* (${otherMisses.length}):`);
    for (const m of otherMisses) {
      lines.push(`    - ${m.method.padEnd(6)} ${m.pattern}   (${m.file}:${m.line})`);
    }
  }
  return lines.join('\n');
}

function formatLevelMismatchMessage(mismatches) {
  const lines = [
    `Privilege matrix level disagrees with source middleware for `
      + `${mismatches.length} /api/* route(s).`,
    `Each row below names the route, the middleware chain found at the`,
    `registration site, and the level recorded in test/privileges/matrix.js.`,
    `Either correct the matrix \`level\` to match the gate, or update the`,
    `route's middleware chain to match the intended privilege level.`,
    '',
  ];
  for (const m of mismatches) {
    const mw = m.middleware.length ? m.middleware.join(' + ') : '(none — global /api gate only)';
    lines.push(
      `  - ${m.method.padEnd(6)} ${m.path}`
      + `\n      source : ${m.sourceLevel.padEnd(8)} (${mw})`
      + `\n      matrix : ${m.matrixLevel}`
      + `\n      site   : ${m.file}:${m.line}`
    );
  }
  return lines.join('\n');
}

module.exports = {
  SOURCE_FILES,
  PUBLIC_PATH_ALLOWLIST,
  isPublicPath,
  extractApiRoutesFromSource,
  extractAdminRoutesFromSource,
  extractMiddlewareNames,
  chainToSourceLevel,
  getMatrixApiRoutes,
  getMatrixAdminRoutes,
  literalMatchesPattern,
  auditApiRoutes,
  auditAdminRoutes,
  auditMatrixLevels,
  formatMissingMessage,
  formatLevelMismatchMessage,
};
