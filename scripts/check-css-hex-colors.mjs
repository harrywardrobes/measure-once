#!/usr/bin/env node
/**
 * check-css-hex-colors.mjs
 *
 * Scans every *.css file directly under public/ — excluding tokens.css (which
 * is the generated canonical token source) and the auto-generated public/react/
 * and public/storybook/ sub-directories — for raw hex colour literals.
 *
 * Raw hex colours in shared CSS files should be replaced with the semantic
 * CSS custom-property tokens defined in public/tokens.css (generated from
 * src/react/theme.ts) so that design-system changes propagate automatically
 * and the palette stays consistent across all pages.
 *
 * Suppression
 * -----------
 * A trailing  /* hex-color-ok: <reason> *\/  comment on the same line suppresses
 * the violation.  Use it only when the literal hex value is genuinely
 * necessary (e.g. a third-party UI colour, a transitional pre-existing value
 * awaiting a dedicated token, or a colour with no close semantic equivalent).
 *
 * Algorithm
 * ---------
 * 1. Collect every *.css file directly under public/ whose name is NOT
 *    "tokens.css" (the token source).
 * 2. For each file, scan line by line.
 * 3. Flag any line that:
 *    a. Contains a hex colour: #[0-9a-fA-F]{3,8} (not followed by more hex
 *       digits, so 8-digit alpha hex like #aabbccdd is matched in full and
 *       not split into a false 6-digit hit).
 *    b. Is not a pure comment (line whose first non-whitespace characters
 *       are  /*  or  //).
 *    c. Does not carry a  /* hex-color-ok:  suppression anywhere on the line.
 * 4. Report all violations and exit 1 if any are found.
 *
 * Exit codes:
 *   0 — no violations found
 *   1 — one or more raw hex colours detected
 *
 * Usage:
 *   node scripts/check-css-hex-colors.mjs
 *
 * Wired into CI via: npm run test:css-hex-colors
 */

import { readFileSync, readdirSync } from 'fs';
import { resolve, join, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT      = resolve(__dirname, '..');
const PUBLIC    = join(ROOT, 'public');

/**
 * Collect every *.css file directly under public/ that is not tokens.css.
 * Does NOT recurse into sub-directories (public/react/ and public/storybook/
 * are auto-generated and excluded by design).
 */
function findCssFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.css')) continue;
    if (entry.name === 'tokens.css') continue;
    results.push(join(dir, entry.name));
  }
  return results.sort();
}

/**
 * Matches a hex colour token that is 3–8 hex digits long (covering 3-digit
 * shorthand, 6-digit full, and 8-digit alpha), not immediately followed by
 * another hex digit or a hyphen.
 *
 * The hyphen exclusion prevents CSS ID selectors whose name happens to start
 * with 3+ hex-compatible characters (e.g. `#add-task-btn` → `#add` would
 * otherwise be matched as a 3-digit hex colour) from being flagged.
 */
const HEX_RE = /#[0-9a-fA-F]{3,8}(?![0-9a-fA-F\-])/;

/**
 * A line is a "pure comment" if its first non-whitespace content is the start
 * of a CSS block comment (/*) or a double-slash comment (//).  Such lines are
 * skipped because they are documentation, not live style values.
 */
const PURE_COMMENT_RE = /^\s*(?:\/\*|\/\/)/;

/**
 * Suppression comment that exempts a line from this check.
 * Must appear somewhere on the same line as the hex value.
 */
const SUPPRESSION_RE = /\/\*\s*hex-color-ok\s*:/;

const cssFiles = findCssFiles(PUBLIC);

/** @type {Array<{file: string, line: number, text: string}>} */
const violations = [];

for (const cssFile of cssFiles) {
  const relPath = relative(ROOT, cssFile);
  const src = readFileSync(cssFile, 'utf8');
  const lines = src.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    if (!HEX_RE.test(raw)) continue;
    if (PURE_COMMENT_RE.test(raw)) continue;
    if (SUPPRESSION_RE.test(raw)) continue;

    violations.push({ file: relPath, line: i + 1, text: raw.trimStart() });
  }
}

console.log(
  `[check-css-hex-colors] Scanned ${cssFiles.length} CSS file(s) under public/.`,
);

if (violations.length === 0) {
  console.log('[check-css-hex-colors] OK — no raw hex colours found.');
  process.exit(0);
}

process.stderr.write(
  `\n[check-css-hex-colors] VIOLATIONS (${violations.length}):\n\n`,
);
for (const { file, line, text } of violations) {
  process.stderr.write(`  ${file}:${line}\n    ${text}\n\n`);
}
process.stderr.write(
  'Raw hex colours in public CSS files must be replaced with CSS custom-property\n' +
  'tokens from public/tokens.css (e.g. var(--status-warning-text), var(--orchid),\n' +
  'var(--status-error-bg), etc.).\n\n' +
  'If no suitable token exists and the value is genuinely necessary, suppress with:\n' +
  '  /* hex-color-ok: <reason> */\n\n',
);
process.exit(1);
