#!/usr/bin/env node
/**
 * check-privilege-reads.mjs
 *
 * Enforces the privilege-check convention documented in replit.md:
 *
 *   All privilege checks MUST go through getPrivilegeLevel() (vanilla JS) or
 *   usePrivilege() (React).  Direct reads of `.privilege_level` on
 *   `window.__moHeaderUser` or `state.user` are forbidden outside the
 *   canonical implementations.
 *
 * Scanned surfaces:
 *
 *   1. public/*.js — every .js file under public/ except:
 *        - public/core.js          — canonical implementation (defines the helper)
 *        - public/react/**          — compiled React island (auto-generated, gitignored)
 *        - public/storybook/**      — compiled Storybook output (auto-generated, gitignored)
 *
 *   2. src/react/**\/*.{ts,tsx} — every TypeScript/TSX source file except:
 *        - src/react/hooks/usePrivilege.ts   — canonical React implementation
 *        - src/react/hooks/usePrivilegeSync.ts — canonical route-guard hook
 *        - any *.stories.{ts,tsx} file        — Storybook fixture (sets up window state)
 *
 * A line is a violation when ALL of the following are true:
 *   • it contains `privilege_level`
 *   • it is NOT a pure comment line (does not start with `//` or `*`)
 *   • it does NOT contain the inline suppression marker `privilege-read-ok`
 *   • (TypeScript only) it is NOT a TypeScript property-declaration line
 *     (i.e. trimmed content starts with `privilege_level` followed by `?:` or `:` and
 *      then only a TypeScript type expression — no dot-access `.privilege_level`)
 *
 * Usage:
 *   node scripts/check-privilege-reads.mjs    # exits 1 on any violation
 *
 * Wired into CI via: npm run test:privilege-reads
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, relative, dirname, sep, extname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT           = resolve(__dirname, '..');
const PUBLIC_DIR     = resolve(ROOT, 'public');
const SRC_REACT_DIR  = resolve(ROOT, 'src', 'react');

// ── Exclusions — public/ ──────────────────────────────────────────────────────

const EXCLUDED_FILES = new Set([
  resolve(PUBLIC_DIR, 'core.js'),
]);

const EXCLUDED_DIRS = [
  resolve(PUBLIC_DIR, 'react'),
  resolve(PUBLIC_DIR, 'storybook'),
];

function isExcludedPublic(absPath) {
  if (EXCLUDED_FILES.has(absPath)) return true;
  return EXCLUDED_DIRS.some(d => absPath.startsWith(d + sep) || absPath === d);
}

// ── Exclusions — src/react/ ───────────────────────────────────────────────────

const EXCLUDED_TS_FILES = new Set([
  resolve(SRC_REACT_DIR, 'hooks', 'usePrivilege.ts'),
  resolve(SRC_REACT_DIR, 'hooks', 'usePrivilegeSync.ts'),
]);

function isExcludedTs(absPath) {
  if (EXCLUDED_TS_FILES.has(absPath)) return true;
  // Storybook fixture files (*.stories.ts / *.stories.tsx)
  const base = basename(absPath);
  if (/\.stories\.[tj]sx?$/.test(base)) return true;
  return false;
}

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
  // Must start with the key name (possibly readonly/optional)
  if (!/^(?:readonly\s+)?privilege_level\??:\s*\S/.test(trimmed)) return false;
  // Must not contain a dot-access (which would indicate reading a value)
  if (trimmed.includes('.privilege_level')) return false;
  // The value portion should only be a type expression (no object literals, no comparisons)
  const afterColon = trimmed.replace(/^(?:readonly\s+)?privilege_level\??:\s*/, '');
  // Reject if the value portion contains characters that indicate runtime expressions
  if (/[=!<>({]/.test(afterColon.replace(/<[^>]*>/g, ''))) return false;
  return true;
}

/**
 * Returns true when the line has been explicitly suppressed with the inline
 * marker `privilege-read-ok`.  This is reserved for admin data-management
 * code that legitimately references another user's privilege_level field.
 */
function hasSuppression(line) {
  return line.includes('privilege-read-ok');
}

// ── Check ─────────────────────────────────────────────────────────────────────

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

const jsViolations = checkFiles(jsFiles, false);
const tsViolations = checkFiles(tsFiles, true);
const violations   = [...jsViolations, ...tsViolations];

// ── Report ────────────────────────────────────────────────────────────────────

console.log(
  `check-privilege-reads: scanned ${jsFiles.length} JS file(s) under public/ ` +
  `(core.js, react/, storybook/ excluded)\n` +
  `                        and ${tsFiles.length} TS/TSX file(s) under src/react/ ` +
  `(usePrivilege.ts, usePrivilegeSync.ts, *.stories.* excluded)\n`
);

if (violations.length === 0) {
  console.log(
    '✓ No direct privilege_level reads found.\n' +
    '  All privilege checks use getPrivilegeLevel() (vanilla JS) or usePrivilege() (React).'
  );
  process.exit(0);
}

console.error(`✗ ${violations.length} direct privilege_level read(s) found:\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}`);
  console.error(`    ${v.text}\n`);
}
console.error(
  'Fix: replace direct .privilege_level reads with getPrivilegeLevel() (vanilla JS)\n' +
  '     or usePrivilege() (React). See the "Privilege checks" section in replit.md.\n' +
  '     For admin data-management lines that legitimately reference another user\'s\n' +
  '     privilege_level, add a trailing `// privilege-read-ok: <reason>` comment.'
);
process.exit(1);
