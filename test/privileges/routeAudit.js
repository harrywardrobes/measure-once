// Drift-detector for the privilege matrix's admin-route coverage.
//
// Parses the Express route registrations in the production source files and
// asserts every `/api/admin/*` route is represented in `matrix.ROUTES`. The
// matrix is hand-maintained, so adding a new admin endpoint without adding a
// matching matrix row used to silently leave a member→403 / viewer→403 cell
// uncovered. This audit fails the privilege suite when that happens.

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

const REGISTER_RE =
  /\b(?:app|router)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*(['"`])(\/api\/admin\/[^'"`]*)\2/gi;

function extractAdminRoutesFromSource(repoRoot = path.resolve(__dirname, '..', '..')) {
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

function getMatrixAdminRoutes(matrixRoutes) {
  return matrixRoutes
    .filter(r => r.path.startsWith('/api/admin/'))
    .map(r => ({ method: r.method.toUpperCase(), path: r.path }));
}

// Returns `{ missing: [{method, pattern, file, line}, …] }` listing source
// routes with no matching matrix row.
function auditAdminRoutes(matrixRoutes, opts = {}) {
  const sourceRoutes = extractAdminRoutesFromSource(opts.repoRoot);
  const matrixRows = getMatrixAdminRoutes(matrixRoutes);
  const missing = [];
  for (const src of sourceRoutes) {
    const covered = matrixRows.some(mx =>
      mx.method === src.method && literalMatchesPattern(mx.path, src.pattern)
    );
    if (!covered) missing.push(src);
  }
  return { sourceRoutes, matrixRows, missing };
}

function formatMissingMessage(missing) {
  const lines = [
    `Privilege matrix is missing ${missing.length} /api/admin/* route(s).`,
    `Add a row to test/privileges/matrix.js for each entry below so the`,
    `member→403 / viewer→403 cell is exercised:`,
    '',
  ];
  for (const m of missing) {
    lines.push(`  - ${m.method.padEnd(6)} ${m.pattern}   (${m.file}:${m.line})`);
  }
  return lines.join('\n');
}

module.exports = {
  SOURCE_FILES,
  extractAdminRoutesFromSource,
  getMatrixAdminRoutes,
  literalMatchesPattern,
  auditAdminRoutes,
  formatMissingMessage,
};
