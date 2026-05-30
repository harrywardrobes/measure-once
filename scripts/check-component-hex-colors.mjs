#!/usr/bin/env node
/**
 * check-component-hex-colors.mjs
 *
 * Scans every *.ts / *.tsx file under src/react/ — excluding *.stories.*,
 * *.d.ts, and theme.ts (which legitimately declares brand hex literals) — for
 * raw hex colour values (`#[0-9a-fA-F]{3,6}`) appearing in style-related
 * properties: bgcolor, background, backgroundColor, color, borderColor, fill,
 * stroke, outlineColor, textDecorationColor, caretColor, and boxShadow.
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
 * For multi-line sx prop objects where the value is on a separate line,
 * place the suppression comment on the hex-value line:
 *
 *   sx={{
 *     background:
 *       '#abc', // hex-color-ok: intentional brand colour
 *   }}
 *
 * Algorithm
 * ---------
 * Two passes over each file:
 *
 * Pass 1 — same-line scan (line by line):
 *   Flag any line that contains both a style prop name and a hex colour on
 *   the same line.
 *
 * Pass 2 — multi-line scan (full source):
 *   Flag MUI sx/style assignments where the style prop key and the hex value
 *   appear on consecutive lines, e.g.:
 *
 *     color:
 *       '#ff0000'   // ← caught by Pass 2, missed by Pass 1
 *
 *   The regex matches a style prop followed by ":" and a newline, then checks
 *   whether the very next line contains a hex colour token.  Suppression
 *   comments must be placed on the hex-value line.
 *
 * Both passes skip lines/occurrences that carry a suppression marker.
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
 * "backgroundImage", for example — but all listed tokens are distinct
 * in practice.
 */
const STYLE_PROP_RE = /\b(?:bgcolor|background|backgroundColor|borderColor|borderBottomColor|fill|color|stroke|outlineColor|textDecorationColor|caretColor|boxShadow)\b/;

/**
 * Suppression comments that exempt a line from this check.
 * Accepts both single-line (//) and block (/* *\/) comment forms so that
 * suppressions can be placed inside JSX attribute objects where // is not
 * possible after the closing '>'.
 */
const SUPPRESSION_RE = /(?:\/\/|\/\*)\s*(?:hex-color-ok|story-hex-ok)\s*:/;

/**
 * Multi-line pattern: a style prop key on one line followed by a newline,
 * with the hex value appearing on the very next line.
 *
 * Captures the entire next line as group 1 so we can:
 *   a. test it for a hex colour token, and
 *   b. check for a suppression comment on that same line.
 *
 * The [^:\n]* between the prop name and ":" allows for optional whitespace or
 * TypeScript type annotations before the colon.
 */
const MULTILINE_PROP_RE = /\b(?:bgcolor|background|backgroundColor|borderColor|borderBottomColor|fill|color|stroke|outlineColor|textDecorationColor|caretColor|boxShadow)\b[^:\n]*:\s*\r?\n([^\n]*)/g;

const componentFiles = findComponentFiles(SRC_DIR);

/** @type {Array<{file: string, line: number, text: string}>} */
const violations = [];

for (const componentFile of componentFiles) {
  const relPath = relative(ROOT, componentFile);
  const src = readFileSync(componentFile, 'utf8');
  const lines = src.split('\n');

  // Pass 1: same-line scan
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    if (!HEX_RE.test(raw)) continue;
    if (!STYLE_PROP_RE.test(raw)) continue;
    if (SUPPRESSION_RE.test(raw)) continue;

    violations.push({ file: relPath, line: i + 1, text: raw.trimStart() });
  }

  // Pass 2: multi-line scan — catches sx prop objects where the key and hex
  // value are on separate lines (e.g. `color:\n  '#ff0000'`).
  MULTILINE_PROP_RE.lastIndex = 0;
  let match;
  while ((match = MULTILINE_PROP_RE.exec(src)) !== null) {
    const hexLine = match[1];
    if (!HEX_RE.test(hexLine)) continue;
    if (SUPPRESSION_RE.test(hexLine)) continue;

    // Determine the 1-indexed line number of the hex-value line.
    // The hex line starts immediately after the newline that ends match[0]
    // minus match[1] in length — i.e. at offset (match.index + match[0].length
    // - match[1].length).
    const hexLineStart = match.index + match[0].length - match[1].length;
    const lineNum = src.slice(0, hexLineStart).split('\n').length;

    // Avoid duplicating a violation already emitted by Pass 1 (can only
    // happen if a line somehow satisfies both passes, which shouldn't occur
    // in practice, but guard anyway).
    if (!violations.some(v => v.file === relPath && v.line === lineNum)) {
      violations.push({ file: relPath, line: lineNum, text: hexLine.trimStart() });
    }
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
  'attribute, or a transitional value awaiting migration), suppress with a trailing\n' +
  'comment on the hex-value line:\n' +
  '  // hex-color-ok: <reason>\n\n',
);
process.exit(1);
