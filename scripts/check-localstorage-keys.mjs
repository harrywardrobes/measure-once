#!/usr/bin/env node
/**
 * scripts/check-localstorage-keys.mjs
 *
 * Static lint: every literal string passed directly to
 * localStorage.getItem / localStorage.setItem / localStorage.removeItem
 * (and the sessionStorage equivalents) in `src/react/` must come from the
 * central key registry at `src/react/constants/localStorageKeys.ts`.
 *
 * A violation is any call-site where one of the Storage methods is invoked
 * with a quoted string literal as its first argument:
 *
 *   localStorage.getItem('my-key')       ← VIOLATION
 *   localStorage.setItem("my-key", val)  ← VIOLATION
 *   localStorage.removeItem(`my-key`)    ← VIOLATION
 *   localStorage.getItem(MY_KEY)         ← OK — uses a constant
 *
 * ── Excluded files ────────────────────────────────────────────────────────
 *
 *   src/react/constants/localStorageKeys.ts
 *     The canonical registry — it defines the string literals, so having
 *     raw strings there is expected and correct.
 *
 *   *.stories.{ts,tsx}
 *     Storybook fixture files sometimes set up isolated localStorage state
 *     for story variants.  These are dev-only files and not shipped.
 *
 * ── Suppression ───────────────────────────────────────────────────────────
 *
 *   Any line that legitimately needs a raw string (e.g. a one-off migration
 *   shim that clears an old key by its original name) can be suppressed by
 *   appending:
 *     // ls-key-ok: <reason>
 *
 * Usage:
 *   node scripts/check-localstorage-keys.mjs    # exits 1 on any violation
 *
 * Wired into CI via: npm run test:ls-keys
 */

import { readFileSync, readdirSync } from 'fs';
import { resolve, relative, basename, dirname, sep } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT         = resolve(__dirname, '..');
const SRC_REACT    = resolve(ROOT, 'src', 'react');
const REGISTRY_ABS = resolve(SRC_REACT, 'constants', 'localStorageKeys.ts');
// Build-output directories under src/react/ — gitignored but still walked by the FS
const EXCLUDED_DIRS = [resolve(SRC_REACT, 'public')];

// ── Pattern ───────────────────────────────────────────────────────────────
//
// Matches:
//   localStorage.getItem(   '…'   )
//   localStorage.setItem(   "…"   , …)
//   localStorage.removeItem(`…`   )
//   sessionStorage.getItem( '…'   )
//   …and the other combinations
//
// The key part is that a quote character immediately follows the opening
// parenthesis, which means a string literal (not a variable/constant) is
// being passed as the first argument.

const LITERAL_STORAGE_RE =
  /(?:local|session)Storage\.(?:getItem|setItem|removeItem)\(\s*[`'"]/;

// ── File walker ───────────────────────────────────────────────────────────

function walkSync(dir, results = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.some(d => full === d || full.startsWith(d + sep))) continue;
      walkSync(full, results);
    } else if (entry.isFile() && /\.[tj]sx?$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function isExcluded(absPath) {
  if (absPath === REGISTRY_ABS) return true;
  if (/\.stories\.[tj]sx?$/.test(basename(absPath))) return true;
  return false;
}

function isPureComment(line) {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('*');
}

function hasSuppression(line) {
  return line.includes('ls-key-ok');
}

// ── Scan ──────────────────────────────────────────────────────────────────

const files = walkSync(SRC_REACT).filter(f => !isExcluded(f));

const violations = [];

for (const file of files) {
  const src   = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!LITERAL_STORAGE_RE.test(line)) continue;
    if (isPureComment(line)) continue;
    if (hasSuppression(line)) continue;
    violations.push({
      file: relative(ROOT, file),
      line: i + 1,
      text: line.trimEnd(),
    });
  }
}

// ── Report ────────────────────────────────────────────────────────────────

console.log(
  `check-localstorage-keys: scanned ${files.length} TS/TSX file(s) under src/react/ ` +
  `(localStorageKeys.ts registry and *.stories.* excluded)\n`
);

if (violations.length === 0) {
  console.log(
    '✓ No raw string literals passed to localStorage/sessionStorage methods.\n' +
    '  All storage reads and writes go through src/react/constants/localStorageKeys.ts.'
  );
  process.exit(0);
}

console.error(
  `✗ ${violations.length} raw string literal(s) passed directly to a ` +
  `localStorage/sessionStorage method:\n`
);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}`);
  console.error(`    ${v.text}\n`);
}
console.error(
  'Fix: import the matching constant from src/react/constants/localStorageKeys.ts\n' +
  '     instead of passing a raw string literal.  If the key does not exist yet,\n' +
  '     add it to the registry first.\n' +
  'Suppression: for lines that legitimately use a raw string (e.g. a one-off\n' +
  '     migration shim that must reference an old key by its original name), add\n' +
  '     a trailing `// ls-key-ok: <reason>` comment.'
);
process.exit(1);
