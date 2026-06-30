#!/usr/bin/env node
/**
 * Generate the branded PWA icons for Harry Wardrobes.
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
const PUBLIC_DIR = resolve(__dirname, '..', 'public');
const ICONS_DIR = resolve(PUBLIC_DIR, 'icons');
const SOURCE_MARK = resolve(PUBLIC_DIR, 'assets', 'logo-mark-paper.png');
const FAVICON_SVG = resolve(PUBLIC_DIR, 'favicon.svg');

// Brand palette (mirrors src/react/theme.ts BRAND_COLORS).
const PLUM = '#200842';
const PAPER = '#F6F1E7';
const ORCHID = '#8B2BFF';

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

/**
 * Rasterise public/favicon.svg into a browser-tab PNG at a given size.
 * The SVG carries a simplified wood-knot motif on the plum field so it stays
 * legible down to 16px (the full wood-grain pattern turns to mush that small).
 *
 * @param {string} file  output filename (under public/)
 * @param {number} size  square edge length in px
 */
function writeFaviconPng(file, size) {
  const out = resolve(PUBLIC_DIR, file);
  execFileSync('convert', [
    '-background', 'none',
    FAVICON_SVG,
    '-resize', `${size}x${size}`,
    '-depth', '8',
    '-define', 'png:color-type=6',
    out,
  ]);
  console.log(`[pwa-icons] wrote public/${file} (${size}x${size})`);
}

writeFaviconPng('favicon-16.png', 16);
writeFaviconPng('favicon-32.png', 32);

/**
 * Generate the 1200x630 Open Graph / social-share preview image.
 *
 * Composites the wood-grain brand mark above the "Harry Wardrobes" wordmark on
 * the plum brand field, with a thin orchid accent rule. This is the image link
 * unfurls (Slack, WhatsApp, iMessage, etc.) show when a Harry Wardrobes URL is
 * shared. Committed to public/og-image.png (NOT gitignored).
 */
function writeOgImage() {
  const out = resolve(PUBLIC_DIR, 'og-image.png');
  execFileSync('convert', [
    '-size', '1200x630',
    `xc:${PLUM}`,
    // Wood-grain mark, centred and shifted up to leave room for the wordmark.
    '(', SOURCE_MARK, '-resize', '260x260', ')',
    '-gravity', 'center', '-geometry', '+0-110', '-compose', 'over', '-composite',
    // "Harry Wardrobes" wordmark in paper.
    '-gravity', 'center',
    '-font', 'DejaVu-Sans-Bold', '-fill', PAPER,
    '-pointsize', '108', '-kerning', '2',
    '-annotate', '+0+95', 'Harry Wardrobes',
    // Orchid accent rule + tagline beneath the wordmark.
    '-fill', ORCHID, '-pointsize', '26', '-kerning', '8',
    '-annotate', '+0+185', 'HARRY WARDROBES',
    '-depth', '8',
    '-define', 'png:color-type=6',
    out,
  ]);
  console.log('[pwa-icons] wrote public/og-image.png (1200x630)');
}

writeOgImage();

// Multi-resolution .ico fallback for legacy browsers that ignore SVG/PNG icons.
const ICO_OUT = resolve(PUBLIC_DIR, 'favicon.ico');
execFileSync('convert', [
  '-background', 'none',
  FAVICON_SVG,
  '-define', 'icon:auto-resize=16,32,48',
  ICO_OUT,
]);
console.log('[pwa-icons] wrote public/favicon.ico (16,32,48)');

console.log('[pwa-icons] done.');
