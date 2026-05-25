#!/usr/bin/env node
/**
 * check-privilege-reads.mjs
 *
 * Enforces the privilege-check convention documented in replit.md:
 *
 *   All privilege checks MUST go through getPrivilegeLevel() (vanilla JS) or
 *   usePrivilege() (React).  Direct reads of `.privilege_level` on
 *   `window.__moHeaderUser` or `state.user` are forbidden outside the
 *   canonical implementation in public/core.js.
 *
 * The check scans every .js file under public/ except:
 *   - public/core.js          — canonical implementation (defines the helper)
 *   - public/react/**          — compiled React island (auto-generated, gitignored)
 *   - public/storybook/**      — compiled Storybook output (auto-generated, gitignored)
 *
 * A line is a violation when it contains `privilege_level` AND is not a pure
 * comment line (i.e. the non-whitespace content does not start with `//` or `*`).
 * This allows the word to appear freely in comments while still catching any
 * executable read.
 *
 * Usage:
 *   node scripts/check-privilege-reads.mjs    # exits 1 on any violation
 *
 * Wired into CI via: npm run test:privilege-reads
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, relative, dirname, sep } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT       = resolve(__dirname, '..');
const PUBLIC_DIR = resolve(ROOT, 'public');

// ── Exclusions ────────────────────────────────────────────────────────────────

const EXCLUDED_FILES = new Set([
  resolve(PUBLIC_DIR, 'core.js'),
]);

const EXCLUDED_DIRS = [
  resolve(PUBLIC_DIR, 'react'),
  resolve(PUBLIC_DIR, 'storybook'),
];

function isExcluded(absPath) {
  if (EXCLUDED_FILES.has(absPath)) return true;
  return EXCLUDED_DIRS.some(d => absPath.startsWith(d + sep) || absPath === d);
}

// ── Walk ──────────────────────────────────────────────────────────────────────

function walkSync(dir, results = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (isExcluded(full)) continue;
    if (entry.isDirectory()) {
      walkSync(full, results);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      results.push(full);
    }
  }
  return results;
}

// ── Check ─────────────────────────────────────────────────────────────────────

/**
 * Returns true when the line is a comment-only line.
 * Both `// …` and ` * …` (JSDoc / block comment) styles are accepted.
 */
function isPureComment(line) {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*');
}

const jsFiles    = walkSync(PUBLIC_DIR);
const violations = [];

for (const file of jsFiles) {
  const src   = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('privilege_level')) continue;
    if (isPureComment(line)) continue;
    violations.push({
      file: relative(ROOT, file),
      line: i + 1,
      text: line.trimEnd(),
    });
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

const TOTAL = jsFiles.length;

console.log(`check-privilege-reads: scanned ${TOTAL} file(s) under public/ (core.js, react/, storybook/ excluded)\n`);

if (violations.length === 0) {
  console.log('✓ No direct privilege_level reads found. All privilege checks use getPrivilegeLevel().');
  process.exit(0);
}

console.error(`✗ ${violations.length} direct privilege_level read(s) found:\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}`);
  console.error(`    ${v.text}\n`);
}
console.error(
  'Fix: replace direct .privilege_level reads with getPrivilegeLevel() (vanilla JS)\n' +
  '     or usePrivilege() (React). See the "Privilege checks" section in replit.md.'
);
process.exit(1);
