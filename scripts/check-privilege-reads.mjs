#!/usr/bin/env node
/**
 * check-privilege-reads.mjs
 *
 * Enforces the privilege-check convention documented in CLAUDE.md:
 *
 *   All privilege checks MUST go through the canonical helper for that surface:
 *     - React / TypeScript → usePrivilege()         (defined in src/react/hooks/usePrivilege.ts)
 *     - Server route code  → getRequestPrivilegeLevel(req)   (defined in auth.js)
 *
 *   Note: the former vanilla-JS helper getPrivilegeLevel() (previously in
 *   public/legacy-shim.js) was removed when legacy-shim.js was deleted. All
 *   client-side privilege checks now go through the React usePrivilege() hook.
 *
 * ── Surface 1 — hand-written public/*.js (RETIRED — currently 0 files) ────────
 *
 *   After the EJS/React migration there are no hand-written vanilla-JS source
 *   files left under public/ — the old vanilla client was replaced by the
 *   bundled React island (public/react/main.js). The only `.js` files that now
 *   live under public/ are auto-generated, gitignored build artifacts, all of
 *   which are excluded:
 *     - public/react/**         — compiled React island (auto-generated, gitignored)
 *     - public/storybook/**     — compiled Storybook output (auto-generated, gitignored)
 *     - public/sw.js            — Workbox service worker (auto-generated, gitignored)
 *
 *   This surface is kept as a guard: if a hand-written `.js` file is ever added
 *   back under public/, it will be scanned automatically. Until then it scans
 *   0 source files by design.
 *
 *   A line is a violation when ALL of the following are true:
 *     • it contains `privilege_level`
 *     • it is NOT a pure comment line (does not start with `//` or `*`)
 *     • it does NOT contain the inline suppression marker `privilege-read-ok`
 *
 * ── Surface 2 — src/react/**\/*.{ts,tsx} ────────────────────────────────────
 *
 *   Every TypeScript/TSX source file under src/react/ except:
 *     - src/react/hooks/usePrivilege.ts    — canonical React implementation
 *     - src/react/hooks/usePrivilegeSync.ts — canonical route-guard hook
 *     - any *.stories.{ts,tsx} file         — Storybook fixture (sets up window state)
 *
 *   Same violation rules as Surface 1, plus:
 *     • TypeScript property-declaration lines
 *       (`privilege_level?: string;`) are automatically skipped.
 *
 * ── Surface 3 — server-side JS modules ──────────────────────────────────────
 *
 *   The explicitly listed root-level server modules:
 *     server.js, design-visits.js, design-visit-uploads.js, quickbooks.js,
 *     visits.js, rate-limiters.js
 *
 *   auth.js is EXCLUDED — it is the canonical server-side implementation; it
 *   owns the `getRequestPrivilegeLevel` helper, the `requireAdmin` / `requirePrivilege` /
 *   `requireManagerOrAdmin` middleware, schema DDL, and user-management code.
 *
 *   Unlike the client surfaces, server-side files legitimately contain many
 *   references to `privilege_level` as a database column name, in SQL strings,
 *   and in data-management code.  Flagging every occurrence would produce far
 *   too many false positives.  Instead, this surface specifically detects
 *   direct reads of `req.user` → `privilege_level`, i.e. accessing the
 *   session-cached privilege without going through `getRequestPrivilegeLevel(req)`.
 *
 *   Pattern flagged: the token `req.user` (with optional `?`) immediately
 *   followed (possibly after a chain of optional-chaining steps) by
 *   `.privilege_level`.  Example violations:
 *     req.user?.privilege_level
 *     req.user.privilege_level
 *
 *   A line is a violation when ALL of the following are true:
 *     • it matches the req.user…privilege_level pattern (see above)
 *     • it is NOT a pure comment line (does not start with `//` or `*`)
 *     • it does NOT contain the inline suppression marker `privilege-read-ok`
 *
 * ── Suppression ──────────────────────────────────────────────────────────────
 *
 *   Any line may be suppressed by appending:
 *     // privilege-read-ok: <reason>
 *
 *   Reserved for lines that legitimately reference a DIFFERENT user's
 *   privilege_level (e.g. admin data-management code, cross-user checks).
 *
 * Usage:
 *   node scripts/check-privilege-reads.mjs    # exits 1 on any violation
 *
 * Wired into CI via: npm run test:privilege-reads
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, relative, dirname, sep, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT           = resolve(__dirname, '..');
const PUBLIC_DIR     = resolve(ROOT, 'public');
const SRC_REACT_DIR  = resolve(ROOT, 'src', 'react');

// ── Surface 1 exclusions — public/ ───────────────────────────────────────────

const EXCLUDED_FILES = new Set([
  // legacy-shim.js was deleted; no vanilla-JS canonical file remains.
  // sw.js is the Workbox service worker — an auto-generated, gitignored build
  // artifact (same category as react/ and storybook/), not hand-written source.
  resolve(PUBLIC_DIR, 'sw.js'),
]);

const EXCLUDED_DIRS = [
  resolve(PUBLIC_DIR, 'react'),
  resolve(PUBLIC_DIR, 'storybook'),
];

function isExcludedPublic(absPath) {
  if (EXCLUDED_FILES.has(absPath)) return true;
  return EXCLUDED_DIRS.some(d => absPath.startsWith(d + sep) || absPath === d);
}

// ── Surface 2 exclusions — src/react/ ────────────────────────────────────────

const EXCLUDED_TS_FILES = new Set([
  resolve(SRC_REACT_DIR, 'hooks', 'usePrivilege.ts'),
  resolve(SRC_REACT_DIR, 'hooks', 'usePrivilegeSync.ts'),
]);

function isExcludedTs(absPath) {
  if (EXCLUDED_TS_FILES.has(absPath)) return true;
  const base = basename(absPath);
  if (/\.stories\.[tj]sx?$/.test(base)) return true;
  return false;
}

// ── Surface 3 — server-side modules (explicit list) ──────────────────────────
//
// auth.js is the canonical owner of the privilege system and is excluded.
// Only files with routes / business logic are included.

const SERVER_FILES = [
  'server.js',
  'design-visits.js',
  'design-visit-uploads.js',
  'quickbooks.js',
  'visits.js',
  'rate-limiters.js',
].map(f => resolve(ROOT, f)).filter(f => existsSync(f));

// Pattern: req.user (optional ?) followed eventually by .privilege_level
// Matches: req.user?.privilege_level  req.user.privilege_level
const REQ_USER_PRIVILEGE_RE = /req\.user\??.*\.privilege_level/;

// ── Walk ──────────────────────────────────────────────────────────────────────

function walkSync(dir, extFilter, isExcluded, results = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (isExcluded(full)) continue;
    if (entry.isDirectory()) {
      walkSync(full, extFilter, isExcluded, results);
    } else if (entry.isFile() && extFilter(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

const jsFiles = walkSync(
  PUBLIC_DIR,
  name => name.endsWith('.js'),
  isExcludedPublic,
);

const tsFiles = walkSync(
  SRC_REACT_DIR,
  name => name.endsWith('.ts') || name.endsWith('.tsx'),
  isExcludedTs,
);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true when the line is a comment-only line.
 * Both `// …` and ` * …` (JSDoc / block comment) styles are accepted.
 */
function isPureComment(line) {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*');
}

/**
 * Returns true when a TypeScript property-declaration line carries
 * `privilege_level` only as the declared key name (not as an accessed value).
 *
 * Matches lines like:
 *   privilege_level?: string;
 *   privilege_level: string | null;
 *
 * Does NOT match:
 *   privilege_level: u.privilege_level || 'member'   (contains dot-access)
 *   { privilege_level?: string }                      (inline; does not START with privilege_level)
 */
function isTsTypeAnnotation(line) {
  const trimmed = line.trimStart();
  if (!/^(?:readonly\s+)?privilege_level\??:\s*\S/.test(trimmed)) return false;
  if (trimmed.includes('.privilege_level')) return false;
  const afterColon = trimmed.replace(/^(?:readonly\s+)?privilege_level\??:\s*/, '');
  if (/[=!<>({]/.test(afterColon.replace(/<[^>]*>/g, ''))) return false;
  return true;
}

/**
 * Returns true when the line has been explicitly suppressed with the inline
 * marker `privilege-read-ok`.  This is reserved for code that legitimately
 * references another user's privilege_level (e.g. admin data-management,
 * cross-user checks such as inspecting the submitter's privilege level).
 */
function hasSuppression(line) {
  return line.includes('privilege-read-ok');
}

// ── Check — client surfaces (all privilege_level occurrences) ─────────────────

function checkFiles(files, isTs) {
  const violations = [];
  for (const file of files) {
    const src   = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('privilege_level')) continue;
      if (isPureComment(line)) continue;
      if (hasSuppression(line)) continue;
      if (isTs && isTsTypeAnnotation(line)) continue;
      violations.push({
        file: relative(ROOT, file),
        line: i + 1,
        text: line.trimEnd(),
      });
    }
  }
  return violations;
}

// ── Check — server surface (req.user privilege reads only) ───────────────────

function checkServerFiles(files) {
  const violations = [];
  for (const file of files) {
    const src   = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!REQ_USER_PRIVILEGE_RE.test(line)) continue;
      if (isPureComment(line)) continue;
      if (hasSuppression(line)) continue;
      violations.push({
        file: relative(ROOT, file),
        line: i + 1,
        text: line.trimEnd(),
      });
    }
  }
  return violations;
}

const jsViolations     = checkFiles(jsFiles, false);
const tsViolations     = checkFiles(tsFiles, true);
const serverViolations = checkServerFiles(SERVER_FILES);
const violations       = [...jsViolations, ...tsViolations, ...serverViolations];

// ── Report ────────────────────────────────────────────────────────────────────

console.log(
  `check-privilege-reads: scanned ${jsFiles.length} hand-written JS file(s) under public/ ` +
  `(react/, storybook/, sw.js auto-generated — vanilla JS retired post-migration)\n` +
  `                        and ${tsFiles.length} TS/TSX file(s) under src/react/ ` +
  `(usePrivilege.ts, usePrivilegeSync.ts, *.stories.* excluded)\n` +
  `                        and ${SERVER_FILES.length} server-side module(s) ` +
  `(auth.js excluded — canonical owner)\n`
);

if (violations.length === 0) {
  console.log(
    '✓ No direct privilege_level reads found.\n' +
    '  Client checks use usePrivilege() (React hook).\n' +
    '  Server checks use getRequestPrivilegeLevel(req) (Express route code).'
  );
  process.exit(0);
}

const clientCount = jsViolations.length + tsViolations.length;
const serverCount = serverViolations.length;

if (clientCount > 0) {
  console.error(`✗ ${clientCount} direct privilege_level read(s) found in client files:\n`);
  for (const v of [...jsViolations, ...tsViolations]) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.text}\n`);
  }
}

if (serverCount > 0) {
  console.error(`✗ ${serverCount} direct req.user privilege_level read(s) found in server files:\n`);
  for (const v of serverViolations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.text}\n`);
  }
}

console.error(
  'Fix (client): replace direct .privilege_level reads with usePrivilege() (React hook).\n' +
  '              See the "Privilege checks" section in CLAUDE.md.\n' +
  'Fix (server): replace req.user?.privilege_level reads with getRequestPrivilegeLevel(req) (auth.js).\n' +
  '              For route-level gating prefer requireAdmin / requirePrivilege / requireManagerOrAdmin\n' +
  '              — those re-query the database and are always up-to-date after a privilege change.\n' +
  'Suppression:  for lines that legitimately reference ANOTHER user\'s privilege_level field,\n' +
  '              add a trailing `// privilege-read-ok: <reason>` comment.'
);
process.exit(1);
