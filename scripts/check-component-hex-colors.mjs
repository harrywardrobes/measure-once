#!/usr/bin/env node
/**
 * check-component-hex-colors.mjs
 *
 * Scans every *.ts / *.tsx file under src/react/ — excluding *.stories.*,
 * *.d.ts, and theme.ts (which legitimately declares brand hex literals) — for
 * raw hex colour values (`#[0-9a-fA-F]{3,6}`) appearing in style-related
 * properties: bgcolor, background, color, borderColor, and fill.
 *
 * Hardcoded hex colours in component files should be replaced with semantic
 * theme tokens (STAGE_COLORS, STATUS_COLORS, MUI palette strings, CSS custom
 * properties, etc.) so that design-system changes propagate automatically and
 * stay in sync with the design tokens in src/react/theme.ts.
 *
 * Suppression
 * -----------
 * A trailing `// hex-color-ok: <reason>` comment on the same line suppresses
 * the violation.  Use it only when the literal hex value is genuinely
 * necessary (e.g. a third-party brand colour, an inline SVG attribute that
 * cannot accept a CSS variable, or a transitional pre-existing value awaiting
 * migration).
 *
 * The older `// story-hex-ok: <reason>` marker is also accepted so that any
 * files shared between production components and Storybook stories only need
 * one suppression style.
 *
 * Algorithm
 * ---------
 * 1. Recursively find every *.ts / *.tsx file under src/react/ that is NOT a
 *    stories file, NOT a .d.ts declaration, and NOT theme.ts.
 * 2. For each file, scan line by line.
 * 3. Flag any line that contains both:
 *    a. A hex colour token: #[0-9a-fA-F]{3,6} (not immediately followed by
 *       more hex digits).
 *    b. A style prop name: bgcolor, background, color, borderColor, or fill.
 * 4. Skip lines that carry a `// hex-color-ok:` or `// story-hex-ok:`
 *    suppression comment.
 * 5. Report all violations and exit 1 if any were found.
 *
 * Exit codes:
 *   0 — no violations found
 *   1 — one or more raw hex colours detected in style properties
 *
 * Usage:
 *   node scripts/check-component-hex-colors.mjs
 *
 * Wired into CI via: npm run test:component-hex-colors
 */

import { readFileSync, readdirSync } from 'fs';
import { resolve, join, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC_DIR = join(ROOT, 'src', 'react');

/**
 * Recursively collect every *.ts / *.tsx file under a directory, excluding:
 *   - *.stories.* (covered by check-story-hex-colors.mjs)
 *   - *.d.ts (generated type declarations)
 *   - theme.ts (canonical token source — defines the brand hex literals)
 * @param {string} dir
 * @returns {string[]}
 */
function findComponentFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findComponentFiles(full));
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

/**
 * Matches a hex colour token that is 3–6 hex digits long, not immediately
 * followed by another hex digit (so an 8-digit alpha hex like #aabbccdd is
 * not matched as a false 6-digit hit, and a bare 3-char prefix of a longer
 * token is not matched either).
 */
const HEX_RE = /#[0-9a-fA-F]{3,6}(?![0-9a-fA-F])/;

/**
 * Style-related prop names that must not use raw hex colours.
 * Anchored with word boundaries so "background" doesn't match inside
 * "backgroundImage", for example.
 */
const STYLE_PROP_RE = /\b(?:bgcolor|background|borderColor|fill|color)\b/;

/**
 * Suppression comments that exempt a line from this check.
 * Accepts both single-line (//) and block (/* *\/) comment forms so that
 * suppressions can be placed inside JSX attribute objects where // is not
 * possible after the closing '>'.
 */
const SUPPRESSION_RE = /(?:\/\/|\/\*)\s*(?:hex-color-ok|story-hex-ok)\s*:/;

const componentFiles = findComponentFiles(SRC_DIR);

/** @type {Array<{file: string, line: number, text: string}>} */
const violations = [];

for (const componentFile of componentFiles) {
  const relPath = relative(ROOT, componentFile);
  const src = readFileSync(componentFile, 'utf8');
  const lines = src.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    if (!HEX_RE.test(raw)) continue;
    if (!STYLE_PROP_RE.test(raw)) continue;
    if (SUPPRESSION_RE.test(raw)) continue;

    violations.push({ file: relPath, line: i + 1, text: raw.trimStart() });
  }
}

console.log(
  `[check-component-hex-colors] Scanned ${componentFiles.length} component file(s) under src/react/.`,
);

if (violations.length === 0) {
  console.log('[check-component-hex-colors] OK — no raw hex colours in style properties.');
  process.exit(0);
}

process.stderr.write(
  `\n[check-component-hex-colors] VIOLATIONS (${violations.length}):\n\n`,
);
for (const { file, line, text } of violations) {
  process.stderr.write(`  ${file}:${line}\n    ${text}\n\n`);
}
process.stderr.write(
  'Raw hex colours in style properties must be replaced with semantic theme tokens.\n' +
  'Use STAGE_COLORS / STATUS_COLORS from src/react/theme.ts, MUI palette strings\n' +
  '(e.g. "primary.main", "text.secondary"), CSS custom properties (e.g. var(--plum)),\n' +
  'or other design-system values.\n\n' +
  'If the hex value is genuinely necessary (third-party brand colour, SVG fill\n' +
  'attribute, or a transitional value awaiting migration), suppress with:\n' +
  '  // hex-color-ok: <reason>\n\n',
);
process.exit(1);
