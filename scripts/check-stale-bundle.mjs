#!/usr/bin/env node
/**
 * Stale-bundle check for the React island.
 *
 * Parses src/react/main.tsx for React.lazy() page imports, then verifies that
 * a matching hashed chunk exists under public/react/chunks/.  Exits non-zero
 * if any chunk is missing so CI catches stale builds early.
 *
 * Run standalone:  node scripts/check-stale-bundle.mjs
 * Run via npm:     npm run test:stale-bundle
 *
 * How it works
 * ────────────
 * Vite names each lazy chunk after the page component, e.g.:
 *   React.lazy(() => import('./pages/TradesPage')) → chunks/TradesPage-<hash>.js
 *
 * This script extracts the component name from every React.lazy() call in
 * main.tsx and checks that at least one file matching `<Name>-*.js` (or just
 * `<Name>.js` for the rare un-hashed case) exists in public/react/chunks/.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const MAIN_TSX  = path.join(ROOT, 'src', 'react', 'main.tsx');
const CHUNKS_DIR = path.join(ROOT, 'public', 'react', 'chunks');

// ── 1. Parse lazy imports from main.tsx ────────────────────────────────────

if (!fs.existsSync(MAIN_TSX)) {
  console.error(`[stale-bundle] ERROR: ${MAIN_TSX} not found`);
  process.exit(1);
}

const source = fs.readFileSync(MAIN_TSX, 'utf8');

// Match: React.lazy(() => import('./pages/SomePage') or import('./pages/admin/SomePage')
// Capture the last path segment (the component file name without extension).
const LAZY_RE = /React\.lazy\(\s*\(\)\s*=>\s*import\(['"]\.\/pages\/(?:[^/'"]+\/)*([^/'"]+)['"]\)/g;

const pageNames = [];
let m;
while ((m = LAZY_RE.exec(source)) !== null) {
  pageNames.push(m[1]);
}

if (pageNames.length === 0) {
  console.error('[stale-bundle] ERROR: no React.lazy() page imports found in main.tsx — pattern mismatch?');
  process.exit(1);
}

// ── 2. List available chunks ────────────────────────────────────────────────

if (!fs.existsSync(CHUNKS_DIR)) {
  console.error(`[stale-bundle] ERROR: ${CHUNKS_DIR} does not exist — run npm run build:react first`);
  process.exit(1);
}

const chunkFiles = fs.readdirSync(CHUNKS_DIR).filter(f => f.endsWith('.js'));

// ── 3. Check each page has a matching chunk ─────────────────────────────────

const missing = [];

for (const name of pageNames) {
  // Vite uses "<Name>-<hash>.js" or sometimes "<Name>.js" (no hash).
  const hasChunk = chunkFiles.some(f => f === `${name}.js` || f.startsWith(`${name}-`));
  if (!hasChunk) {
    missing.push(name);
  }
}

// ── 4. Report ───────────────────────────────────────────────────────────────

const pad = s => `  ${s}`;
console.log('[stale-bundle] Checking React chunk coverage…');
console.log(pad(`main.tsx lazy imports : ${pageNames.length}`));
console.log(pad(`chunks found          : ${chunkFiles.length}`));

if (missing.length === 0) {
  console.log(pad('All lazy page chunks present ✓'));
  process.exit(0);
} else {
  console.error(`[stale-bundle] FAIL: ${missing.length} lazy import(s) have no matching chunk:`);
  for (const name of missing) {
    console.error(pad(`✗ ${name}  (expected chunks/${name}-*.js)`));
  }
  console.error('[stale-bundle] Run `npm run build:react` to regenerate the bundle.');
  process.exit(1);
}
