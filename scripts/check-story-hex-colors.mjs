#!/usr/bin/env node
/**
 * check-story-hex-colors.mjs
 *
 * Scans every *.stories.tsx file under src/react/ for raw hex colour values
 * (`#[0-9a-fA-F]{3,6}`) appearing in style-related properties: bgcolor,
 * background, color, borderColor, and fill.
 *
 * Hardcoded hex colours in story files should be replaced with semantic theme
 * tokens (STAGE_COLORS, STATUS_COLORS, MUI palette strings, etc.) so that
 * design-system changes propagate automatically and stay in sync with the
 * design tokens in src/react/theme.ts.
 *
 * Suppression
 * -----------
 * A trailing `// story-hex-ok: <reason>` comment on the same line suppresses
 * the violation.  Use it only for cases where a literal hex value is the
 * actual data under test (e.g. Swatch component demos that display colour
 * values as content, not as style properties).
 *
 * Algorithm
 * ---------
 * 1. Recursively find every *.stories.tsx file under src/react/.
 * 2. For each file, scan line by line.
 * 3. Flag any line that contains both:
 *    a. A hex colour token: #[0-9a-fA-F]{3,6} (not immediately followed by
 *       more hex digits — avoids over-matching 8-char colour constants or
 *       non-colour hex identifiers).
 *    b. A style prop name: bgcolor, background, color, borderColor, or fill.
 * 4. Skip flagged lines that carry a `// story-hex-ok: <reason>` suppression.
 * 5. Report all violations and exit 1 if any were found.
 *
 * Exit codes:
 *   0 — no violations found
 *   1 — one or more raw hex colours detected in style properties
 *
 * Usage:
 *   node scripts/check-story-hex-colors.mjs
 *
 * Wired into CI via: npm run test:story-hex-colors
 */

import { readFileSync, readdirSync } from 'fs';
import { resolve, join, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC_DIR = join(ROOT, 'src', 'react');

/**
 * Recursively collect every *.stories.tsx file under a directory.
 * @param {string} dir
 * @returns {string[]}
 */
function findStoriesFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findStoriesFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.stories.tsx')) {
      results.push(full);
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
 * "backgroundImage", for example — but bgcolor/background/color/borderColor/fill
 * are all distinct tokens in practice.
 */
const STYLE_PROP_RE = /\b(?:bgcolor|background|borderColor|fill|color)\b/;

/** Suppression comment that exempts a line from this check. */
const SUPPRESSION_RE = /\/\/\s*story-hex-ok\s*:/;

const storyFiles = findStoriesFiles(SRC_DIR);

/** @type {Array<{file: string, line: number, text: string}>} */
const violations = [];

for (const storyFile of storyFiles) {
  const relPath = relative(ROOT, storyFile);
  const src = readFileSync(storyFile, 'utf8');
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
  `[check-story-hex-colors] Scanned ${storyFiles.length} story file(s) under src/react/.`,
);

if (violations.length === 0) {
  console.log('[check-story-hex-colors] OK — no raw hex colours in style properties.');
  process.exit(0);
}

process.stderr.write(
  `\n[check-story-hex-colors] VIOLATIONS (${violations.length}):\n\n`,
);
for (const { file, line, text } of violations) {
  process.stderr.write(`  ${file}:${line}\n    ${text}\n\n`);
}
process.stderr.write(
  'Raw hex colours in style properties must be replaced with semantic theme tokens.\n' +
  'Use STAGE_COLORS / STATUS_COLORS from src/react/theme.ts, MUI palette strings\n' +
  '(e.g. "primary.main", "text.secondary"), or other design-system values.\n\n' +
  'If the hex value is genuinely the data under test (e.g. a Swatch story that\n' +
  'displays a colour value as content), suppress with a trailing comment:\n' +
  '  // story-hex-ok: <reason>\n\n',
);
process.exit(1);
