#!/usr/bin/env node
/**
 * Generate the branded PWA icons for Measure Once.
 *
 * Produces four PNGs under public/icons/:
 *   icon-192.png            (purpose "any")
 *   icon-512.png            (purpose "any")
 *   icon-192-maskable.png   (purpose "maskable" — motif kept inside the safe zone)
 *   icon-512-maskable.png   (purpose "maskable")
 *
 * The icons composite the real Harry Wardrobes wood-grain brand mark
 * (public/assets/logo-mark-paper.png) over the plum brand field (#200842,
 * matching the manifest background_color / theme_color).
 *
 *   - "any" icons let the wood-grain mark fill the whole canvas (full bleed).
 *   - "maskable" icons inset the mark inside the central ~80% safe zone so
 *     platform masks (Android circles/squircles) don't clip the motif.
 *
 * The PNGs are committed to the repo (NOT gitignored) so a clean checkout has
 * installable icons without running a build. Re-run this script after updating
 * the source artwork:
 *
 *   node scripts/generate-pwa-icons.mjs
 *
 * Requires ImageMagick (`convert`) on PATH.
 */

import { execFileSync } from 'child_process';
import { mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = resolve(__dirname, '..', 'public', 'icons');
const SOURCE_MARK = resolve(__dirname, '..', 'public', 'assets', 'logo-mark-paper.png');

// Brand palette (mirrors src/react/theme.ts BRAND_COLORS).
const PLUM = '#200842';

mkdirSync(ICONS_DIR, { recursive: true });

/**
 * Composite the wood-grain mark over a plum field at a given size.
 *
 * @param {string} file   output filename
 * @param {number} size   canvas edge length in px
 * @param {number} scale  fraction of the canvas the mark occupies (1 = full bleed)
 */
function writeIcon(file, size, scale) {
  const out = resolve(ICONS_DIR, file);
  const motif = Math.round(size * scale);
  execFileSync('convert', [
    '-size', `${size}x${size}`,
    `xc:${PLUM}`,
    '(', SOURCE_MARK, '-resize', `${motif}x${motif}!`, ')',
    '-gravity', 'center',
    '-compose', 'over',
    '-composite',
    '-depth', '8',
    '-define', 'png:color-type=6',
    out,
  ]);
  console.log(`[pwa-icons] wrote public/icons/${file} (${size}x${size}, scale ${scale})`);
}

const targets = [
  // "any" — wood-grain fills the canvas edge to edge.
  { file: 'icon-192.png', size: 192, scale: 1 },
  { file: 'icon-512.png', size: 512, scale: 1 },
  // "maskable" — motif kept inside the ~80% safe zone, plum fills the rest.
  { file: 'icon-192-maskable.png', size: 192, scale: 0.8 },
  { file: 'icon-512-maskable.png', size: 512, scale: 0.8 },
];

for (const t of targets) writeIcon(t.file, t.size, t.scale);

console.log('[pwa-icons] done.');
