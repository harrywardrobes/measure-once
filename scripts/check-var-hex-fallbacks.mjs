#!/usr/bin/env node
/**
 * check-var-hex-fallbacks.mjs
 *
 * Scans source files for CSS custom-property usages that still carry a raw hex
 * colour as a fallback value — e.g. `var(--orchid, #8B2BFF)`.
 *
 * Since `public/tokens.css` is always loaded before any component renders,
 * hex fallbacks inside `var()` are redundant and create a second source of
 * truth that can silently drift from `src/react/theme.ts`.
 *
 * Files scanned
 * -------------
 * • public/*.js (excludes the generated public/react/ and public/storybook/ dirs)
 * • views/*.ejs (the server-rendered EJS view markup)
 * • src/react/**\/*.ts and src/react/**\/*.tsx
 *   (excludes *.stories.*, *.d.ts, and theme.ts — the canonical hex source)
 *
 * What is flagged
 * ---------------
 * Any line containing the pattern:
 *   var(--<token-name>, #<3–8 hex digits>)
 *
 * Numeric fallbacks (e.g. `var(--header-h, 56px)`) and named-colour fallbacks
 * (e.g. `var(--orchid, transparent)`) are intentionally NOT flagged — only
 * `#`-prefixed hex literals are an error here.
 *
 * Suppression
 * -----------
 * A trailing `// var-hex-ok: <reason>` comment (or `/* var-hex-ok: … *\/`)
 * on the same line suppresses the violation.  Use only when the hex value is
 * genuinely necessary (e.g. an inline SVG fill that cannot accept a CSS
 * variable, or a third-party embed that injects its own style attribute).
 *
 * Exit codes:
 *   0 — no violations found
 *   1 — one or more hex fallbacks detected
 *
 * Usage:
 *   node scripts/check-var-hex-fallbacks.mjs
 *
 * Wired into CI via: npm run test:var-hex-fallbacks
 */

import { readFileSync, readdirSync } from 'fs';
import { resolve, join, relative, extname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');

/**
 * Matches `var(--anything, #hhh)` where the hex part is 3–8 hex digits.
 * The negative look-ahead avoids over-matching inside longer hex strings.
 */
const VAR_HEX_RE = /var\(--[^,)]+,\s*#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])/;

/** Suppression comment that exempts a line from this check. */
const SUPPRESSION_RE = /(?:\/\/|\/\*)\s*var-hex-ok\s*:/;

// ─── Collect public/*.js ───────────────────────────────────────────────────────

const PUBLIC_DIR = join(ROOT, 'public');
const EXCLUDED_PUBLIC_DIRS = new Set(['react', 'storybook']);

function findPublicFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (dir === PUBLIC_DIR && EXCLUDED_PUBLIC_DIRS.has(entry.name)) continue;
      results.push(...findPublicFiles(join(dir, entry.name)));
    } else if (entry.isFile()) {
      if (extname(entry.name) === '.js') results.push(join(dir, entry.name));
    }
  }
  return results.sort();
}

// ─── Collect views/*.ejs ───────────────────────────────────────────────────────

const VIEWS_DIR = join(ROOT, 'views');

function findViewFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.ejs'))
    .map(entry => join(dir, entry.name))
    .sort();
}

// ─── Collect src/react/**/*.ts and *.tsx ─────────────────────────────────────

const SRC_DIR = join(ROOT, 'src', 'react');

function findReactFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findReactFiles(full));
    } else if (entry.isFile()) {
      const n = entry.name;
      if (
        (n.endsWith('.ts') || n.endsWith('.tsx')) &&
        !n.includes('.stories.') &&
        !n.endsWith('.d.ts') &&
        n !== 'theme.ts'
      ) {
        results.push(full);
      }
    }
  }
  return results.sort();
}

// ─── Scan ─────────────────────────────────────────────────────────────────────

const publicFiles = findPublicFiles(PUBLIC_DIR);
const viewFiles   = findViewFiles(VIEWS_DIR);
const reactFiles  = findReactFiles(SRC_DIR);
const allFiles    = [...publicFiles, ...viewFiles, ...reactFiles];

/** @type {Array<{file: string, line: number, text: string}>} */
const violations = [];

for (const filePath of allFiles) {
  const relPath = relative(ROOT, filePath);
  const src = readFileSync(filePath, 'utf8');
  const lines = src.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!VAR_HEX_RE.test(raw)) continue;
    if (SUPPRESSION_RE.test(raw)) continue;
    violations.push({ file: relPath, line: i + 1, text: raw.trimStart() });
  }
}

console.log(
  `[check-var-hex-fallbacks] Scanned ${publicFiles.length} public file(s), ` +
  `${viewFiles.length} EJS view(s), and ${reactFiles.length} React file(s).`,
);

if (violations.length === 0) {
  console.log('[check-var-hex-fallbacks] OK — no hex fallbacks inside var() expressions.');
  process.exit(0);
}

process.stderr.write(
  `\n[check-var-hex-fallbacks] VIOLATIONS (${violations.length}):\n\n`,
);
for (const { file, line, text } of violations) {
  process.stderr.write(`  ${file}:${line}\n    ${text}\n\n`);
}
process.stderr.write(
  'Hex fallbacks inside var() are redundant — public/tokens.css is always\n' +
  'loaded before any component renders.\n\n' +
  'Replace  var(--orchid, #8B2BFF)  with  var(--orchid)\n\n' +
  'If the hex fallback is genuinely required (e.g. an SVG fill that cannot\n' +
  'accept a CSS variable), suppress with a trailing comment:\n' +
  '  // var-hex-ok: <reason>\n\n',
);
process.exit(1);
