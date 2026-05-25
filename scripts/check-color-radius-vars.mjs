#!/usr/bin/env node
/**
 * check-color-radius-vars.mjs
 *
 * Verifies that every brand-colour and radius CSS custom property in
 * public/style.css matches the corresponding value exported from
 * src/react/theme.ts (BRAND_COLORS and RADIUS).
 *
 * Usage:
 *   node scripts/check-color-radius-vars.mjs    # exits 1 on any mismatch
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

// ── camelCase → CSS var name conversion ──────────────────────────────────────
//
//   paper       → paper
//   paperDeep   → paper-deep
//   orchidTint  → orchid-tint
//   ink1        → ink-1
//   stoneLight  → stone-light
//   2xl         → 2xl  (already correct for radius keys)

function camelToKebab(name) {
  return name
    // Insert hyphen before uppercase letters (paperDeep → paper-Deep)
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    // Insert hyphen before digits following letters (ink1 → ink-1)
    .replace(/([a-zA-Z])(\d)/g, '$1-$2')
    .toLowerCase();
}

// ── Parse :root CSS custom properties into a flat map { varName → value } ────

function parseCssRootVars(css) {
  const vars = {};
  // Match lines like:  --paper:  #F6F1E7;  or  --radius-xs:  2px;
  const re = /--([\w-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    vars[m[1]] = m[2].trim();
  }
  return vars;
}

// ── Parse BRAND_COLORS object from theme.ts ───────────────────────────────────
//
// Looks for the block:
//   export const BRAND_COLORS = {
//     paper: '#F6F1E7',
//     ...
//   } as const;

function parseBrandColors(ts) {
  const blockMatch = ts.match(/export\s+const\s+BRAND_COLORS\s*=\s*\{([^}]+)\}/s);
  if (!blockMatch) return {};

  const block = blockMatch[1];
  const colors = {};
  const re = /(\w+)\s*:\s*'(#[0-9a-fA-F]{3,8})'/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    colors[m[1]] = m[2];
  }
  return colors;
}

// ── Parse RADIUS object from theme.ts ────────────────────────────────────────
//
// Looks for the block:
//   export const RADIUS = {
//     xs:   2,
//     ...
//   } as const;
//
// Values are unitless numbers in TS; the CSS vars append "px".

function parseRadius(ts) {
  const blockMatch = ts.match(/export\s+const\s+RADIUS\s*=\s*\{([^}]+)\}/s);
  if (!blockMatch) return {};

  const block = blockMatch[1];
  const radii = {};
  const re = /'?([\w]+)'?\s*:\s*(\d+)/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    radii[m[1]] = parseInt(m[2], 10);
  }
  return radii;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const css = readFileSync(CSS_PATH,   'utf8');
const ts  = readFileSync(THEME_PATH, 'utf8');

const cssVars     = parseCssRootVars(css);
const brandColors = parseBrandColors(ts);
const radius      = parseRadius(ts);

const mismatches = [];
let checked = 0;

console.log('check-color-radius-vars: comparing public/style.css ↔ src/react/theme.ts\n');

// ── Check BRAND_COLORS ───────────────────────────────────────────────────────

console.log('Checking BRAND_COLORS…');

for (const [tsKey, tsValue] of Object.entries(brandColors)) {
  const cssVarName = camelToKebab(tsKey);  // e.g. "paperDeep" → "paper-deep"
  const cssValue   = cssVars[cssVarName];

  if (cssValue === undefined) {
    mismatches.push(
      `  --${cssVarName}: MISSING in style.css  (theme.ts BRAND_COLORS.${tsKey} = ${tsValue})`
    );
    continue;
  }

  if (cssValue.toLowerCase() !== tsValue.toLowerCase()) {
    mismatches.push(
      `  --${cssVarName} (BRAND_COLORS.${tsKey}):\n` +
      `      style.css  = ${cssValue}\n` +
      `      theme.ts   = ${tsValue}`
    );
  } else {
    checked++;
  }
}

// ── Check RADIUS ─────────────────────────────────────────────────────────────

console.log('Checking RADIUS…');

for (const [tsKey, tsValue] of Object.entries(radius)) {
  const cssVarName = `radius-${tsKey}`;          // e.g. "xs" → "radius-xs"
  const expectedCss = `${tsValue}px`;            // 2 → "2px"
  const cssValue    = cssVars[cssVarName];

  if (cssValue === undefined) {
    mismatches.push(
      `  --${cssVarName}: MISSING in style.css  (theme.ts RADIUS.${tsKey} = ${tsValue})`
    );
    continue;
  }

  if (cssValue !== expectedCss) {
    mismatches.push(
      `  --${cssVarName} (RADIUS.${tsKey}):\n` +
      `      style.css  = ${cssValue}\n` +
      `      theme.ts   = ${expectedCss}`
    );
  } else {
    checked++;
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

console.log('');

if (mismatches.length === 0) {
  console.log(`✓ All ${checked} checked colour and radius variables are in sync.`);
  process.exit(0);
} else {
  console.error(`✗ ${mismatches.length} mismatch(es) found:\n`);
  mismatches.forEach(m => console.error(m));
  console.error(
    '\nFix: update public/style.css :root to match src/react/theme.ts (or vice-versa).'
  );
  process.exit(1);
}
