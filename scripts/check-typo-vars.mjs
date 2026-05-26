#!/usr/bin/env node
/**
 * check-typo-vars.mjs
 *
 * Verifies that every --typo-* CSS custom property derived from
 * src/react/theme.ts typography values is present in BOTH:
 *
 *   1. public/tokens.css   — static :root block linked by every HTML page
 *   2. src/react/AppThemeProvider.tsx — GlobalStyles injection for React pages
 *
 * Usage:
 *   node scripts/check-typo-vars.mjs    # exits 1 on any missing entry
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const TOKENS_PATH   = resolve(ROOT, 'public/tokens.css');
const PROVIDER_PATH = resolve(ROOT, 'src/react/AppThemeProvider.tsx');
const THEME_PATH    = resolve(ROOT, 'src/react/theme.ts');

const VARIANTS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'subtitle1', 'subtitle2',
  'body1', 'body2',
  'button', 'caption', 'overline',
];

const PROP_MAP = {
  'font-size':   'fontSize',
  'font-weight': 'fontWeight',
  'line-height': 'lineHeight',
};

function parseCssVars(css) {
  const vars = {};
  const re = /--typo-([\w]+)-(font-size|font-weight|line-height)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const variant  = m[1];
    const propSufx = m[2];
    const rawValue = m[3].trim();
    if (!vars[variant]) vars[variant] = {};
    vars[variant][propSufx] = rawValue;
  }
  return vars;
}

function parseRootTokenKeys(tsx) {
  const keys = new Set();
  const re = /'(--[\w-]+)'\s*:/g;
  let m;
  while ((m = re.exec(tsx)) !== null) keys.add(m[1].slice(2));
  return keys;
}

function parseThemeTypography(ts) {
  const result = {};
  for (const variant of VARIANTS) {
    const lineRe = new RegExp(`(?:^|,|\\s)${variant}\\s*:\\s*\\{([^}]+)\\}`, 'm');
    const lineMatch = ts.match(lineRe);
    if (!lineMatch) continue;
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

function normalise(value) { return String(value).trim(); }

const tokensCss   = readFileSync(TOKENS_PATH,   'utf8');
const tsx         = readFileSync(PROVIDER_PATH, 'utf8');
const ts          = readFileSync(THEME_PATH,    'utf8');

const cssVars       = parseCssVars(tokensCss);
const providerKeys  = parseRootTokenKeys(tsx);
const themeTypo     = parseThemeTypography(ts);

const mismatches = [];
const skipped    = [];

console.log('check-typo-vars: public/tokens.css + AppThemeProvider.tsx ↔ src/react/theme.ts\n');

for (const variant of VARIANTS) {
  const cssVariant   = cssVars[variant]   || {};
  const themeVariant = themeTypo[variant] || {};

  for (const [cssSuffix, tsProp] of Object.entries(PROP_MAP)) {
    const cssVal   = cssVariant[cssSuffix];
    const themeVal = themeVariant[tsProp];
    const varName  = `typo-${variant}-${cssSuffix}`;

    if (cssVal === undefined && themeVal === undefined) continue;

    if (cssVal === undefined) {
      mismatches.push(`  --${varName}: MISSING in tokens.css  (theme.ts = ${themeVal})`);
    } else if (themeVal === undefined) {
      skipped.push(`  --${varName}: ${cssVal}  (not set in theme.ts — skipped)`);
    } else if (normalise(cssVal) !== normalise(themeVal)) {
      mismatches.push(`  --${varName}: tokens.css=${cssVal}  theme.ts=${themeVal}`);
    }

    if (themeVal !== undefined && !providerKeys.has(varName))
      mismatches.push(`  '--${varName}' missing in AppThemeProvider.tsx rootTokens`);
  }
}

if (skipped.length) {
  console.log('Skipped (not explicitly set in theme.ts):');
  skipped.forEach(s => console.log(s));
  console.log('');
}

if (mismatches.length === 0) {
  const checked = VARIANTS.flatMap(v =>
    Object.keys(PROP_MAP).filter(p =>
      cssVars[v]?.[p] !== undefined && themeTypo[v]?.[PROP_MAP[p]] !== undefined
    )
  ).length;
  console.log(`✓ All ${checked} --typo-* variables are in sync across tokens.css, AppThemeProvider.tsx, and theme.ts.`);
  process.exit(0);
} else {
  console.error(`✗ ${mismatches.length} issue(s) found:\n`);
  mismatches.forEach(m => console.error(m));
  console.error('\nFix: update public/tokens.css and/or src/react/AppThemeProvider.tsx to match src/react/theme.ts.');
  process.exit(1);
}
