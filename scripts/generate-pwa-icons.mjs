#!/usr/bin/env node
/**
 * Generate placeholder PWA icons for Measure Once.
 *
 * Produces four PNGs under public/icons/:
 *   icon-192.png            (purpose "any")
 *   icon-512.png            (purpose "any")
 *   icon-192-maskable.png   (purpose "maskable" — motif kept inside the safe zone)
 *   icon-512-maskable.png   (purpose "maskable")
 *
 * These are intentionally simple brand-coloured placeholders (a paper ring on a
 * plum field). Re-run this script to regenerate them, or replace the files with
 * final artwork later. The PNGs are committed to the repo (NOT gitignored) so a
 * clean checkout has installable icons without running a build.
 *
 * Run:  node scripts/generate-pwa-icons.mjs
 */

import { deflateSync } from 'zlib';
import { mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = resolve(__dirname, '..', 'public', 'icons');

// Brand palette (mirrors src/react/theme.ts BRAND_COLORS).
const PLUM = [0x20, 0x08, 0x42]; // #200842
const PAPER = [0xf4, 0xef, 0xe3]; // warm paper

// ── Minimal PNG encoder (RGBA, no filtering) ──────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Raw scanlines: each row prefixed with filter byte 0.
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowBytes + 1)] = 0;
    rgba.copy(raw, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Draw the emblem ───────────────────────────────────────────────────────────

function drawIcon(size, motifScale) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size * motifScale;        // paper disc
  const rRing = rOuter * 0.58;             // plum disc (cuts the ring)
  const rDot = rOuter * 0.2;               // paper centre dot

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      let col = PLUM;
      if (dist <= rOuter) col = PAPER;
      if (dist <= rRing) col = PLUM;
      if (dist <= rDot) col = PAPER;
      const i = (y * size + x) * 4;
      rgba[i] = col[0];
      rgba[i + 1] = col[1];
      rgba[i + 2] = col[2];
      rgba[i + 3] = 0xff;
    }
  }
  return encodePng(size, size, rgba);
}

// ── Write the four icons ──────────────────────────────────────────────────────

mkdirSync(ICONS_DIR, { recursive: true });

// "any" icons fill more of the canvas; maskable icons keep the motif inside the
// central safe zone (~80%) so platform masks don't clip it.
const targets = [
  { file: 'icon-192.png', size: 192, scale: 0.42 },
  { file: 'icon-512.png', size: 512, scale: 0.42 },
  { file: 'icon-192-maskable.png', size: 192, scale: 0.32 },
  { file: 'icon-512-maskable.png', size: 512, scale: 0.32 },
];

for (const t of targets) {
  const png = drawIcon(t.size, t.scale);
  writeFileSync(resolve(ICONS_DIR, t.file), png);
  console.log(`[pwa-icons] wrote public/icons/${t.file} (${png.length} bytes)`);
}

console.log('[pwa-icons] done.');
