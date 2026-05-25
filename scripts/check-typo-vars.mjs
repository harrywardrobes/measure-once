#!/usr/bin/env node
/**
 * check-typo-vars.mjs
 *
 * Verifies that every --typo-* CSS custom property in public/style.css
 * matches the corresponding typography value exported from src/react/theme.ts.
 *
 * Usage:
 *   node scripts/check-typo-vars.mjs        # exits 1 on any mismatch
 *
 * The script is intentionally dependency-free (plain Node.js + regex) so it
 * runs without building the TypeScript bundle.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── File paths ────────────────────────────────────────────────────────────────

const CSS_PATH   = resolve(ROOT, 'public/style.css');
const THEME_PATH = resolve(ROOT, 'src/react/theme.ts');

// ── Variants and property map ─────────────────────────────────────────────────

const VARIANTS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'subtitle1', 'subtitle2',
  'body1', 'body2',
  'button', 'caption', 'overline',
];

// CSS var suffix → TypeScript key in the typography variant object
const PROP_MAP = {
  'font-size':   'fontSize',
  'font-weight': 'fontWeight',
  'line-height': 'lineHeight',
};

// ── Parse --typo-* vars from CSS ──────────────────────────────────────────────

function parseCssVars(css) {
  const vars = {};
  // Matches:  --typo-h1-font-size:   2rem;
  const re = /--typo-([\w]+)-(font-size|font-weight|line-height)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const variant  = m[1];   // e.g. "h1", "subtitle1"
    const propSufx = m[2];   // e.g. "font-size"
    const rawValue = m[3].trim();
    if (!vars[variant]) vars[variant] = {};
    vars[variant][propSufx] = rawValue;
  }
  return vars;
}

// ── Parse typography from theme.ts using regex ────────────────────────────────
//
// theme.ts contains lines like:
//   h1:       { fontFamily: FONT_FAMILY, fontWeight: 700, fontSize: '2rem',  lineHeight: 1.2 },
//
// We match per-variant using a single-line regex that captures everything
// between the opening { and the closing }.  This is safe because each variant
// is defined on a single line in the current file.

function parseThemeTypography(ts) {
  const result = {};

  for (const variant of VARIANTS) {
    // Anchor to the exact variant name (not a substring of another word).
    // The colon after the name distinguishes it from comments / identifiers.
    const lineRe = new RegExp(`(?:^|,|\\s)${variant}\\s*:\\s*\\{([^}]+)\\}`, 'm');
    const lineMatch = ts.match(lineRe);
    if (!lineMatch) {
      // Variant not found in theme — treat as entirely missing so mismatches
      // will be reported per-property below.
      continue;
    }

    const block = lineMatch[1];
    result[variant] = {};

    const fsMatch  = block.match(/fontSize\s*:\s*'([^']+)'/);
    const fwMatch  = block.match(/fontWeight\s*:\s*(\d+)/);
    const lhMatch  = block.match(/lineHeight\s*:\s*([\d.]+)/);

    if (fsMatch) result[variant].fontSize   = fsMatch[1];
    if (fwMatch) result[variant].fontWeight = fwMatch[1];
    if (lhMatch) result[variant].lineHeight = lhMatch[1];
  }

  return result;
}

// ── Normalise a raw CSS value so it can be compared to a TS string ────────────
//
// CSS stores font-weight as "700", TS as 700 (number parsed to "700").
// Both should normalise to the same string.
// Numeric lineHeight/fontWeight values are already plain numbers in both.

function normalise(value) {
  return String(value).trim();
}

// ── Main ──────────────────────────────────────────────────────────────────────

const css   = readFileSync(CSS_PATH,   'utf8');
const ts    = readFileSync(THEME_PATH, 'utf8');

const cssVars = parseCssVars(css);
const themeTypo = parseThemeTypography(ts);

const mismatches = [];
const skipped    = [];

for (const variant of VARIANTS) {
  const cssVariant   = cssVars[variant]   || {};
  const themeVariant = themeTypo[variant] || {};

  for (const [cssSuffix, tsProp] of Object.entries(PROP_MAP)) {
    const cssVal   = cssVariant[cssSuffix];
    const themeVal = themeVariant[tsProp];

    if (cssVal === undefined && themeVal === undefined) continue;

    if (cssVal === undefined) {
      mismatches.push(
        `  --typo-${variant}-${cssSuffix}: MISSING in style.css  (theme.ts = ${themeVal})`
      );
      continue;
    }

    if (themeVal === undefined) {
      // Property exists in CSS but is not explicitly set in theme.ts (MUI
      // uses its own default).  We cannot verify the value, so we skip it
      // rather than false-fail.
      skipped.push(`  --typo-${variant}-${cssSuffix}: ${cssVal}  (not set in theme.ts — skipped)`);
      continue;
    }

    if (normalise(cssVal) !== normalise(themeVal)) {
      mismatches.push(
        `  --typo-${variant}-${cssSuffix}:\n` +
        `      style.css  = ${cssVal}\n` +
        `      theme.ts   = ${themeVal}`
      );
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

console.log('check-typo-vars: comparing public/style.css ↔ src/react/theme.ts\n');

if (skipped.length) {
  console.log('Skipped (property not explicitly set in theme.ts):');
  skipped.forEach(s => console.log(s));
  console.log('');
}

if (mismatches.length === 0) {
  const checked = VARIANTS.flatMap(v =>
    Object.keys(PROP_MAP)
      .filter(p => cssVars[v]?.[p] !== undefined && themeTypo[v]?.[PROP_MAP[p]] !== undefined)
  ).length;
  console.log(`✓ All ${checked} checked --typo-* variables are in sync.`);
  process.exit(0);
} else {
  console.error(`✗ ${mismatches.length} mismatch(es) found:\n`);
  mismatches.forEach(m => console.error(m));
  console.error(
    '\nFix: update public/style.css :root to match src/react/theme.ts (or vice-versa).'
  );
  process.exit(1);
}
