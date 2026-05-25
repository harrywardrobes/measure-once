// Drift-detector for the privilege matrix's `/api/*` route coverage.
//
// Parses every Express route registration in the production source files and
// asserts that every `/api/*` route is represented in `matrix.ROUTES` (or
// listed in the documented PUBLIC_PATH_ALLOWLIST below). The matrix is
// hand-maintained, so adding a new endpoint without adding a matching matrix
// row used to silently leave a member→403 / viewer→403 cell uncovered for
// `/api/admin/*` routes. The audit originally only covered the admin prefix;
// it now covers every `/api/*` route so member- and manager-gated endpoints
// (`requirePrivilege('member')`, `requireManagerOrAdmin`, etc.) also fail the
// run when they drift.

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
  'db-editor.js',
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
      found.push({ method, pattern, file: rel, line: lineNo });
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
    .map(r => ({ method: r.method.toUpperCase(), path: r.path }));
}

function getMatrixAdminRoutes(matrixRoutes) {
  return matrixRoutes
    .filter(r => r.path.startsWith('/api/admin/'))
    .map(r => ({ method: r.method.toUpperCase(), path: r.path }));
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

module.exports = {
  SOURCE_FILES,
  PUBLIC_PATH_ALLOWLIST,
  isPublicPath,
  extractApiRoutesFromSource,
  extractAdminRoutesFromSource,
  getMatrixApiRoutes,
  getMatrixAdminRoutes,
  literalMatchesPattern,
  auditApiRoutes,
  auditAdminRoutes,
  formatMissingMessage,
};
