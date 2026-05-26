#!/usr/bin/env node
/**
 * check-mount-id-conflicts.mjs
 *
 * Detects React mount-point id collisions across HTML pages.
 *
 * Every id in the MOUNTS table in src/react/main.tsx must appear in at most
 * ONE HTML page under public/.  When the same mount id shows up in two
 * different pages (e.g. sales.html accidentally reusing id="tab-customers"
 * that belongs to customers.html), mountKnown() will render the wrong React
 * island into the structural element on the wrong page, making the intended
 * island invisible.
 *
 * Legitimate use: each HTML page provides the container element(s) that
 * React mounts into — those containers must carry the correct MOUNTS id and
 * must not appear in any other page file.
 *
 * Algorithm:
 *   1. Parse the MOUNTS array in src/react/main.tsx to collect all mount ids.
 *   2. Scan every public/*.html file for id="…" attributes.
 *   3. For each mount id, if it appears in more than one HTML file → conflict.
 *
 * Exit codes:
 *   0 — no conflicts found
 *   1 — one or more mount ids appear in multiple HTML files
 *
 * Usage:
 *   node scripts/check-mount-id-conflicts.mjs
 *
 * Wired into CI via: npm run test:mount-ids
 */

import { readFileSync, readdirSync } from 'fs';
import { resolve, join, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// 1. Extract mount ids from src/react/main.tsx
// ---------------------------------------------------------------------------

const mainTsxPath = join(ROOT, 'src', 'react', 'main.tsx');
const mainTsxSrc = readFileSync(mainTsxPath, 'utf8');

// Match every  { id: 'some-id', …  entry in the MOUNTS array.
const mountIdPattern = /\{\s*id:\s*['"]([^'"]+)['"]/g;
const mountIds = new Set();
let m;
while ((m = mountIdPattern.exec(mainTsxSrc)) !== null) {
  mountIds.add(m[1]);
}

if (mountIds.size === 0) {
  process.stderr.write(
    '[check-mount-id-conflicts] ERROR: No mount ids extracted from ' +
    'src/react/main.tsx — the MOUNTS pattern may have changed. Update ' +
    'this script to match.\n',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Scan public/*.html and record which files contain each mount id
// ---------------------------------------------------------------------------

const publicDir = join(ROOT, 'public');
const htmlFiles = readdirSync(publicDir)
  .filter(f => f.endsWith('.html'))
  .map(f => join(publicDir, f));

// For each mount id → array of html files that contain it
/** @type {Map<string, string[]>} */
const idToFiles = new Map([...mountIds].map(id => [id, []]));

// Matches  id="value"  or  id='value'  anywhere in HTML.
const htmlIdPattern = /\bid=['"]([^'"]+)['"]/g;

for (const htmlFile of htmlFiles) {
  const src = readFileSync(htmlFile, 'utf8');
  const relPath = relative(ROOT, htmlFile);
  const seen = new Set();
  let hm;
  while ((hm = htmlIdPattern.exec(src)) !== null) {
    const id = hm[1];
    if (mountIds.has(id) && !seen.has(id)) {
      seen.add(id);
      idToFiles.get(id).push(relPath);
    }
  }
  htmlIdPattern.lastIndex = 0;
}

// ---------------------------------------------------------------------------
// 3. Report conflicts (mount ids that appear in more than one HTML file)
// ---------------------------------------------------------------------------

console.log(
  `[check-mount-id-conflicts] Scanned ${htmlFiles.length} HTML file(s) ` +
  `against ${mountIds.size} React mount id(s).`,
);

/** @type {Array<{id: string, files: string[]}>} */
const conflicts = [];
for (const [id, files] of idToFiles) {
  if (files.length > 1) {
    conflicts.push({ id, files });
  }
}

if (conflicts.length === 0) {
  console.log('[check-mount-id-conflicts] OK — no conflicts found.');
  process.exit(0);
}

process.stderr.write('\n[check-mount-id-conflicts] CONFLICTS DETECTED:\n\n');
for (const { id, files } of conflicts) {
  process.stderr.write(`  id="${id}" appears in:\n`);
  for (const f of files) {
    process.stderr.write(`    ${f}\n`);
  }
}
process.stderr.write(
  '\nEach React mount id must appear in exactly one HTML page.\n' +
  'When the same id appears in multiple pages, mountKnown() will render\n' +
  'the React island into whichever element it finds first, making the\n' +
  'correct page\'s island invisible.\n\n' +
  'Fix: rename the element id in the HTML file that should NOT be the\n' +
  'mount target, so it no longer collides with the MOUNTS table in\n' +
  'src/react/main.tsx.\n',
);
process.exit(1);
