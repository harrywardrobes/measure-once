#!/usr/bin/env node
/**
 * generate-tokens-css.mjs
 *
 * Reads BRAND_COLORS, STAGE_COLORS, RADIUS, and typography from
 * src/react/theme.ts and writes public/tokens.css.
 *
 * Run automatically as part of `build:react` and `build:react:dev`.
 * Do NOT edit public/tokens.css by hand — edit src/react/theme.ts instead.
 *
 * Usage:
 *   node scripts/generate-tokens-css.mjs
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT       = resolve(__dirname, '..');
const THEME_PATH  = resolve(ROOT, 'src/react/theme.ts');
const TOKENS_PATH = resolve(ROOT, 'public/tokens.css');

// ── Parsers (mirrors check-color-radius-vars.mjs) ────────────────────────────

function camelToKebab(name) {
  return name
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([a-zA-Z])(\d)/g, '$1-$2')
    .toLowerCase();
}

function parseBrandColors(ts) {
  const blockMatch = ts.match(/export\s+const\s+BRAND_COLORS\s*=\s*\{([^}]+)\}/s);
  if (!blockMatch) throw new Error('BRAND_COLORS not found in theme.ts');
  const colors = {};
  const re = /(\w+)\s*:\s*'(#[0-9a-fA-F]{3,8})'/g;
  let m;
  while ((m = re.exec(blockMatch[1])) !== null) colors[m[1]] = m[2];
  return colors;
}

function parseStageColors(ts) {
  const declMatch = ts.match(/export\s+const\s+STAGE_COLORS[^=]*=\s*\{/);
  if (!declMatch) throw new Error('STAGE_COLORS not found in theme.ts');
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
    const key   = entry[1];
    const props = entry[2];
    const bgM    = props.match(/bg\s*:\s*'(#[0-9a-fA-F]{3,8})'/);
    const lightM = props.match(/light\s*:\s*'(#[0-9a-fA-F]{3,8})'/);
    const textM  = props.match(/text\s*:\s*'(#[0-9a-fA-F]{3,8})'/);
    if (bgM && lightM && textM)
      stages[key] = { bg: bgM[1], light: lightM[1], text: textM[1] };
  }
  return stages;
}

function parseRadius(ts) {
  const blockMatch = ts.match(/export\s+const\s+RADIUS\s*=\s*\{([^}]+)\}/s);
  if (!blockMatch) throw new Error('RADIUS not found in theme.ts');
  const radii = {};
  const re = /'?([\w]+)'?\s*:\s*(\d+)/g;
  let m;
  while ((m = re.exec(blockMatch[1])) !== null) radii[m[1]] = parseInt(m[2], 10);
  return radii;
}

const TYPO_VARIANTS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'subtitle1', 'subtitle2',
  'body1', 'body2',
  'button', 'caption', 'overline',
];

function parseTypography(ts) {
  const result = {};
  for (const variant of TYPO_VARIANTS) {
    const lineRe    = new RegExp(`(?:^|,|\\s)${variant}\\s*:\\s*\\{([^}]+)\\}`, 'm');
    const lineMatch = ts.match(lineRe);
    if (!lineMatch) continue;
    const block = lineMatch[1];
    result[variant] = {};
    const fsM = block.match(/fontSize\s*:\s*'([^']+)'/);
    const fwM = block.match(/fontWeight\s*:\s*(\d+)/);
    const lhM = block.match(/lineHeight\s*:\s*([\d.]+)/);
    if (fsM) result[variant].fontSize   = fsM[1];
    if (fwM) result[variant].fontWeight = fwM[1];
    if (lhM) result[variant].lineHeight = lhM[1];
  }
  return result;
}

// ── Parse theme.ts ───────────────────────────────────────────────────────────

const ts          = readFileSync(THEME_PATH, 'utf8');
const brandColors = parseBrandColors(ts);
const stageColors = parseStageColors(ts);
const radius      = parseRadius(ts);
const typography  = parseTypography(ts);

// ── Emit helpers ─────────────────────────────────────────────────────────────

function col(name, value, width = 18) {
  const pad = ' '.repeat(Math.max(1, width - name.length));
  return `  --${name}:${pad}${value};`;
}

// ── Build brand-colour section ───────────────────────────────────────────────

const brandLines = Object.entries(brandColors).map(([key, value]) =>
  col(camelToKebab(key), value)
);

// ── Build radius section ─────────────────────────────────────────────────────

const radiusLines = Object.entries(radius).map(([key, value]) =>
  col(`radius-${key}`, `${value}px`)
);

// ── Build stage-colour section ───────────────────────────────────────────────

const stageLines = [];
const stageEntries = Object.entries(stageColors);
for (let si = 0; si < stageEntries.length; si++) {
  const [name, colors] = stageEntries[si];
  const w = 30;
  stageLines.push(col(`stage-${name}-bg`,    colors.bg,    w));
  stageLines.push(col(`stage-${name}-light`, colors.light, w));
  stageLines.push(col(`stage-${name}-text`,  colors.text,  w));
  if (si < stageEntries.length - 1) stageLines.push('');
}

// ── Build typography section ─────────────────────────────────────────────────

// lineHeight is not defined in theme.ts for `button` and `overline`; those
// values are hardcoded in AppThemeProvider.tsx and preserved here too.
const HARDCODED_LINE_HEIGHT = { button: '1.75', overline: '2.66' };

const typoLines = [];
for (let vi = 0; vi < TYPO_VARIANTS.length; vi++) {
  const variant = TYPO_VARIANTS[vi];
  const t = typography[variant] || {};
  const lh = t.lineHeight ?? HARDCODED_LINE_HEIGHT[variant];
  const prefix = `typo-${variant}`;
  const w = 28;
  if (t.fontSize)   typoLines.push(col(`${prefix}-font-size`,   t.fontSize,   w));
  if (t.fontWeight) typoLines.push(col(`${prefix}-font-weight`, t.fontWeight, w));
  if (lh)           typoLines.push(col(`${prefix}-line-height`, lh,           w));
  if (vi < TYPO_VARIANTS.length - 1) typoLines.push('');
}

// ── Compose the full file ────────────────────────────────────────────────────

const css = `/* ── Brand Tokens ──────────────────────────────────────────────────────────────
   DO NOT EDIT — this file is generated by scripts/generate-tokens-css.mjs.
   To change a token value, edit src/react/theme.ts and re-run the build.

   This file is linked by every HTML page (React and non-React) so that
   var(--orchid), var(--paper), var(--stage-sales-bg), etc. resolve on all
   pages regardless of whether a React island is mounted.

   AppThemeProvider.tsx also injects a GlobalStyles :root block derived from
   the same constants, which reinforces these values at React runtime.
─────────────────────────────────────────────────────────────────────────── */
:root {
  color-scheme: light;

  /* ── Layout ─────────────────────────────────────────────────────────────── */
  --header-h: calc(52px + env(safe-area-inset-top));
  --banner-h: 37px;

  /* ── Brand colours ───────────────────────────────────────────────────────── */
${brandLines.join('\n')}

  /* ── Shadows ─────────────────────────────────────────────────────────────── */
  --shadow-sm:  0 1px 3px rgba(30,24,14,0.10), 0 1px 2px rgba(30,24,14,0.06);
  --shadow-md:  0 4px 12px rgba(30,24,14,0.12), 0 2px 4px rgba(30,24,14,0.08);
  --shadow-lg:  0 8px 24px rgba(30,24,14,0.14), 0 4px 8px rgba(30,24,14,0.08);

  /* ── Radius ──────────────────────────────────────────────────────────────── */
${radiusLines.join('\n')}

  /* ── Z-index ladder ──────────────────────────────────────────────────────── */
  --z-base:     1;
  --z-raised:   5;
  --z-sticky:   20;
  --z-nav:      90;
  --z-header:   100;
  --z-dropdown: 300;
  --z-panel:    900;
  --z-overlay:  1000;
  --z-modal:    9000;
  --z-toast:    9500;
  --z-tooltip:  9999;

  /* ── Neutral / semantic surface tokens ───────────────────────────────────── */
  --surface-card:     #ffffff;
  --surface-muted:    #f8f7f4;
  --surface-soft:     #f9fafb;
  --border-soft:      #e7e5e0;
  --border-strong:    #d6d3d1;
  --shadow-card-xs:   0 1px 3px rgba(0,0,0,.04);
  --shadow-card-sm:   0 2px 6px rgba(0,0,0,.06);
  --shadow-modal:     0 20px 60px rgba(0,0,0,0.25);
  --overlay-scrim:    rgba(0,0,0,0.45);

  /* ── Status colours ──────────────────────────────────────────────────────── */
  --status-danger:        #dc2626;
  --status-danger-text:   #991b1b;
  --status-danger-bg:     #fef2f2;
  --status-danger-border: #fecaca;
  --status-success:       #16a34a;
  --status-success-text:  #14532d;
  --status-success-bg:    #f0fdf4;
  --status-success-border:#86efac;
  --status-warn-bg:       #fef9c3;
  --status-warn-border:   #fde047;
  --status-warn-text:     #713f12;

  /* ── Brand action accents ────────────────────────────────────────────────── */
  --brand-accent:       #3d0f7a;
  --brand-accent-hover: #5a1fad;
  --brand-accent-ring:  rgba(61,15,122,.12);

  /* ── Stage colours ───────────────────────────────────────────────────────── */
${stageLines.join('\n')}

  /* ── Typography scale ────────────────────────────────────────────────────── */
${typoLines.join('\n')}

  /* ── Spacing unit ────────────────────────────────────────────────────────── */
  --spacing-unit: 8;
}
`;

writeFileSync(TOKENS_PATH, css, 'utf8');
console.log(`generate-tokens-css: wrote ${TOKENS_PATH}`);
