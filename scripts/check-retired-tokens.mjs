#!/usr/bin/env node
/**
 * check-retired-tokens.mjs
 *
 * Detects usage of retired CSS custom-property tokens in `src/react/` and
 * `public/`.  The migration removed several token names; this script
 * prevents them from being reintroduced accidentally.
 *
 * ── Banned tokens ─────────────────────────────────────────────────────────────
 *
 *   --status-danger          standalone form only (without -bg / -text / -border
 *                            suffix).  The suffixed variants --status-danger-bg,
 *                            --status-danger-text, --status-danger-border are
 *                            the current canonical names and are NOT banned.
 *   --status-warn-bg         replaced by --status-warning-bg
 *   --status-warn-border     replaced by --status-warning-border
 *   --status-warn-text       replaced by --status-warning-text
 *
 * ── Scanned surfaces ──────────────────────────────────────────────────────────
 *
 *   src/react/**\/*.{ts,tsx,css}
 *   public/**\/*.{js,css,html}
 *
 *   Excluded from both surfaces:
 *     public/react/**      — compiled React island (auto-generated, gitignored)
 *     public/storybook/**  — compiled Storybook output (auto-generated, gitignored)
 *     public/tokens.css    — generated token definition sheet (DO NOT EDIT header);
 *                            it defines tokens, not consumes them.  Changes here
 *                            flow from src/react/theme.ts — fix the source there.
 *
 * ── Suppression ───────────────────────────────────────────────────────────────
 *
 *   Any line may be suppressed by appending:
 *     // retired-token-ok: <reason>
 *
 *   Use only when a reference is genuinely intentional (e.g. a migration script
 *   that renames the old token, or a comment explaining why it was retired).
 *
 * Usage:
 *   node scripts/check-retired-tokens.mjs    # exits 1 on any violation
 *
 * Wired into CI via: npm run test:retired-tokens
 */

import { readFileSync, readdirSync } from 'fs';
import { resolve, relative, dirname, sep, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT          = resolve(__dirname, '..');
const PUBLIC_DIR    = resolve(ROOT, 'public');
const SRC_REACT_DIR = resolve(ROOT, 'src', 'react');

// ── Banned token patterns ──────────────────────────────────────────────────────

/**
 * Each entry is { name, re } where `re` is a RegExp that matches a line
 * containing a banned token usage.
 */
const BANNED = [
  {
    name: '--status-danger (standalone)',
    // Match --status-danger NOT immediately followed by a hyphen+letter/digit
    // so --status-danger-bg / -text / -border are allowed.
    re: /--status-danger(?!-[a-z0-9])/,
  },
  {
    name: '--status-warn-bg',
    re: /--status-warn-bg/,
  },
  {
    name: '--status-warn-border',
    re: /--status-warn-border/,
  },
  {
    name: '--status-warn-text',
    re: /--status-warn-text/,
  },
];

// ── Exclusions ─────────────────────────────────────────────────────────────────

const EXCLUDED_DIRS = [
  resolve(PUBLIC_DIR, 'react'),
  resolve(PUBLIC_DIR, 'storybook'),
];

const EXCLUDED_FILES = new Set([
  resolve(PUBLIC_DIR, 'tokens.css'),
]);

function isExcluded(absPath) {
  if (EXCLUDED_FILES.has(absPath)) return true;
  return EXCLUDED_DIRS.some(d => absPath.startsWith(d + sep) || absPath === d);
}

// ── Walk ──────────────────────────────────────────────────────────────────────

function walkSync(dir, extFilter, results = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (isExcluded(full)) continue;
    if (entry.isDirectory()) {
      walkSync(full, extFilter, results);
    } else if (entry.isFile() && extFilter(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

const srcFiles = walkSync(
  SRC_REACT_DIR,
  name => /\.(ts|tsx|css)$/.test(name),
);

const publicFiles = walkSync(
  PUBLIC_DIR,
  name => /\.(js|css|html)$/.test(name),
);

const allFiles = [...srcFiles, ...publicFiles];

// ── Helpers ───────────────────────────────────────────────────────────────────

function isPureComment(line) {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function hasSuppression(line) {
  return line.includes('retired-token-ok');
}

// ── Check ─────────────────────────────────────────────────────────────────────

const violations = [];

for (const file of allFiles) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isPureComment(line)) continue;
    if (hasSuppression(line)) continue;
    for (const { name, re } of BANNED) {
      if (re.test(line)) {
        violations.push({
          file: relative(ROOT, file),
          line: i + 1,
          text: line.trimEnd(),
          token: name,
        });
      }
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

console.log(
  `check-retired-tokens: scanned ${srcFiles.length} file(s) under src/react/ ` +
  `and ${publicFiles.length} file(s) under public/ ` +
  `(react/, storybook/ excluded)\n`,
);

if (violations.length === 0) {
  console.log(
    '✓ No retired CSS token usage found.\n' +
    '  Banned: --status-danger (standalone), --status-warn-bg,\n' +
    '          --status-warn-border, --status-warn-text'
  );
  process.exit(0);
}

console.error(`✗ ${violations.length} retired CSS token usage(s) found:\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  [${v.token}]`);
  console.error(`    ${v.text}\n`);
}

console.error(
  'These token names were retired during the status-colour migration.\n' +
  'Use the current canonical tokens instead:\n' +
  '  --status-danger           →  --status-danger-bg / -text / -border (pick the right variant)\n' +
  '  --status-warn-bg          →  --status-warning-bg\n' +
  '  --status-warn-border      →  --status-warning-border\n' +
  '  --status-warn-text        →  --status-warning-text\n' +
  '\n' +
  'Suppression: for lines where the reference is intentional (e.g. a migration\n' +
  'comment), add a trailing `// retired-token-ok: <reason>` annotation.\n'
);
process.exit(1);
