#!/usr/bin/env node
/**
 * check-color-radius-vars.mjs
 *
 * Verifies that every brand-colour, stage-colour, and radius CSS custom
 * property defined in src/react/theme.ts (BRAND_COLORS, STAGE_COLORS, RADIUS)
 * appears in public/tokens.css with the correct value.
 *
 * AppThemeProvider.tsx no longer needs a separate check here because it
 * derives its rootTokens entries automatically by looping over BRAND_COLORS,
 * STAGE_COLORS, and RADIUS — any new token added to those constants will
 * appear in the injected :root block without any change to AppThemeProvider.tsx.
 *
 * Usage:
 *   node scripts/check-color-radius-vars.mjs    # exits 1 on any mismatch
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const TOKENS_PATH = resolve(ROOT, 'public/tokens.css');
const THEME_PATH  = resolve(ROOT, 'src/react/theme.ts');

function camelToKebab(name) {
  return name
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([a-zA-Z])(\d)/g, '$1-$2')
    .toLowerCase();
}

function parseCssRootVars(css) {
  const vars = {};
  const re = /--([\w-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(css)) !== null) vars[m[1]] = m[2].trim();
  return vars;
}

function parseBrandColors(ts) {
  const blockMatch = ts.match(/export\s+const\s+BRAND_COLORS\s*=\s*\{([^}]+)\}/s);
  if (!blockMatch) return {};
  const block = blockMatch[1];
  const colors = {};
  const re = /(\w+)\s*:\s*'(#[0-9a-fA-F]{3,8})'/g;
  let m;
  while ((m = re.exec(block)) !== null) colors[m[1]] = m[2];
  return colors;
}

function parseStageColors(ts) {
  const declMatch = ts.match(/export\s+const\s+STAGE_COLORS[^=]*=\s*\{/);
  if (!declMatch) return {};
  const start = declMatch.index + declMatch[0].length;
  let depth = 1, i = start;
  while (i < ts.length && depth > 0) {
    if (ts[i] === '{') depth++;
    else if (ts[i] === '}') depth--;
    i++;
  }
  const block = ts.slice(start, i - 1);
  const stages = {};
  const entryRe = /(\w+)\s*:\s*\{([^}]+)\}/g;
  let entry;
  while ((entry = entryRe.exec(block)) !== null) {
    const key = entry[1];
    const props = entry[2];
    const bgMatch    = props.match(/bg\s*:\s*'(#[0-9a-fA-F]{3,8})'/);
    const lightMatch = props.match(/light\s*:\s*'(#[0-9a-fA-F]{3,8})'/);
    const textMatch  = props.match(/text\s*:\s*'(#[0-9a-fA-F]{3,8})'/);
    if (bgMatch && lightMatch && textMatch)
      stages[key] = { bg: bgMatch[1], light: lightMatch[1], text: textMatch[1] };
  }
  return stages;
}

function parseRadius(ts) {
  const blockMatch = ts.match(/export\s+const\s+RADIUS\s*=\s*\{([^}]+)\}/s);
  if (!blockMatch) return {};
  const block = blockMatch[1];
  const radii = {};
  const re = /'?([\w]+)'?\s*:\s*(\d+)/g;
  let m;
  while ((m = re.exec(block)) !== null) radii[m[1]] = parseInt(m[2], 10);
  return radii;
}

const tokensCss  = readFileSync(TOKENS_PATH, 'utf8');
const ts         = readFileSync(THEME_PATH,  'utf8');

const cssVars     = parseCssRootVars(tokensCss);
const brandColors = parseBrandColors(ts);
const stageColors = parseStageColors(ts);
const radius      = parseRadius(ts);

const mismatches = [];
let checked = 0;

console.log('check-color-radius-vars: public/tokens.css ↔ src/react/theme.ts\n');

// ── BRAND_COLORS ──────────────────────────────────────────────────────────────

console.log('Checking BRAND_COLORS…');

for (const [tsKey, tsValue] of Object.entries(brandColors)) {
  const varName = camelToKebab(tsKey);

  const cssValue = cssVars[varName];
  if (cssValue === undefined) {
    mismatches.push(`  --${varName}: MISSING in tokens.css  (theme.ts = ${tsValue})`);
  } else if (cssValue.toLowerCase() !== tsValue.toLowerCase()) {
    mismatches.push(`  --${varName}: tokens.css=${cssValue}  theme.ts=${tsValue}`);
  } else {
    checked++;
  }
}

// ── STAGE_COLORS ──────────────────────────────────────────────────────────────

console.log('Checking STAGE_COLORS…');

for (const [stageName, tsColor] of Object.entries(stageColors)) {
  for (const prop of ['bg', 'light', 'text']) {
    const varName = `stage-${stageName}-${prop}`;
    const tsValue = tsColor[prop];

    const cssValue = cssVars[varName];
    if (cssValue === undefined) {
      mismatches.push(`  --${varName}: MISSING in tokens.css  (theme.ts = ${tsValue})`);
    } else if (cssValue.toLowerCase() !== tsValue.toLowerCase()) {
      mismatches.push(`  --${varName}: tokens.css=${cssValue}  theme.ts=${tsValue}`);
    } else {
      checked++;
    }
  }
}

// ── Reverse: CSS stage vars not in STAGE_COLORS ───────────────────────────────

console.log('Checking for orphaned stage vars in tokens.css…');

const stageVarRe = /^stage-([a-z]+)-(bg|light|text)$/;
for (const cssVarName of Object.keys(cssVars)) {
  const m = stageVarRe.exec(cssVarName);
  if (!m) continue;
  const stageName = m[1];
  if (!stageColors[stageName])
    mismatches.push(`  --${cssVarName}: in tokens.css but "${stageName}" missing from STAGE_COLORS`);
}

// ── RADIUS ────────────────────────────────────────────────────────────────────

console.log('Checking RADIUS…');

for (const [tsKey, tsValue] of Object.entries(radius)) {
  const varName    = `radius-${tsKey}`;
  const expectedCss = `${tsValue}px`;

  const cssValue = cssVars[varName];
  if (cssValue === undefined) {
    mismatches.push(`  --${varName}: MISSING in tokens.css  (theme.ts = ${tsValue})`);
  } else if (cssValue !== expectedCss) {
    mismatches.push(`  --${varName}: tokens.css=${cssValue}  theme.ts=${expectedCss}`);
  } else {
    checked++;
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

console.log('');

if (mismatches.length === 0) {
  console.log(`✓ All ${checked} colour and radius variables are in sync across tokens.css and theme.ts.`);
  process.exit(0);
} else {
  console.error(`✗ ${mismatches.length} issue(s) found:\n`);
  mismatches.forEach(m => console.error(m));
  console.error('\nFix: re-run `node scripts/generate-tokens-css.mjs` (or `npm run build:react:dev`) to regenerate tokens.css from theme.ts.');
  console.error('Note: AppThemeProvider.tsx derives its :root tokens automatically — no changes needed there.');
  process.exit(1);
}
