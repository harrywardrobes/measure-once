#!/usr/bin/env node
/**
 * check-mount-id-conflicts.mjs
 *
 * Two-pass static check for React mount-point wiring in public/*.html.
 *
 * Pass 1 — Duplicate-mount detection:
 *   Every id in the MOUNTS table in src/react/main.tsx must appear in at most
 *   ONE HTML page under public/.  When the same mount id shows up in two
 *   different pages (e.g. sales.html accidentally reusing id="tab-customers"
 *   that belongs to customers.html), mountKnown() will render the wrong React
 *   island into the structural element on the wrong page, making the intended
 *   island invisible.
 *
 * Pass 2 — Missing-mount detection:
 *   Every HTML page that loads /react/main.js must also declare at least one
 *   element id that is present in the MOUNTS table.  A page that loads the
 *   bundle but has no matching mount element loads dead JS and likely indicates
 *   a mis-wired new page or a forgotten container element.
 *
 * Exit codes:
 *   0 — no issues found
 *   1 — one or more mount ids appear in multiple HTML files (Pass 1), or
 *       one or more pages load main.js without any mount element (Pass 2)
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
// Lines annotated with  // chrome-global  are intentionally present in every
// HTML shell (they replaced the synchronous chrome.js injection); they are
// excluded from the duplicate-detection check (Pass 1) but still counted
// toward Pass 2 so pages that load main.js are confirmed to have at least
// one mount element.
const mountIdPattern = /\{\s*id:\s*['"]([^'"]+)['"]/g;
const mountIds = new Set();
const chromeGlobalIds = new Set();
let m;
while ((m = mountIdPattern.exec(mainTsxSrc)) !== null) {
  const id = m[1];
  mountIds.add(id);
  // Check if this line ends with a // chrome-global comment (allowing
  // trailing whitespace between the end of the object literal and the comment).
  const lineStart = mainTsxSrc.lastIndexOf('\n', m.index) + 1;
  const lineEnd   = mainTsxSrc.indexOf('\n', m.index);
  const fullLine  = mainTsxSrc.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  if (/\/\/\s*chrome-global\b/.test(fullLine)) {
    chromeGlobalIds.add(id);
  }
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
  if (files.length > 1 && !chromeGlobalIds.has(id)) {
    conflicts.push({ id, files });
  }
}

if (conflicts.length === 0) {
  console.log('[check-mount-id-conflicts] Pass 1 OK — no duplicate mount ids found.');
} else {
  process.stderr.write('\n[check-mount-id-conflicts] Pass 1 CONFLICTS DETECTED:\n\n');
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
}

// ---------------------------------------------------------------------------
// Pass 2: Every HTML page that loads main.js must have at least one mount id
// ---------------------------------------------------------------------------
//
// Suppression: pages where mount elements are injected dynamically (e.g. by
// chrome.js) can opt out of this check by adding a comment anywhere in the
// HTML file:
//
//   <!-- main-js-no-mount-ok: <reason> -->
//
// This follows the same suppression pattern used by the inline-style and
// privilege-read checks elsewhere in the codebase.

// Matches a <script … src="…main.js"… > tag (handles any attribute order).
const mainJsScriptPattern = /src=['"][^'"]*\/react\/main\.js['"]/;

// Matches the suppression comment.
const noMountOkPattern = /<!--\s*main-js-no-mount-ok:/;

/** @type {string[]} pages that load main.js but declare no mount element */
const missingMounts = [];

for (const htmlFile of htmlFiles) {
  const src = readFileSync(htmlFile, 'utf8');
  if (!mainJsScriptPattern.test(src)) continue; // doesn't load main.js
  if (noMountOkPattern.test(src)) continue;      // suppressed intentionally

  const relPath = relative(ROOT, htmlFile);
  const hasMountId = [...mountIds].some(id => src.includes(`id="${id}"`) || src.includes(`id='${id}'`));
  if (!hasMountId) {
    missingMounts.push(relPath);
  }
}

if (missingMounts.length === 0) {
  console.log('[check-mount-id-conflicts] Pass 2 OK — every page that loads main.js has a mount element.');
} else {
  process.stderr.write('\n[check-mount-id-conflicts] Pass 2 MISSING MOUNT ELEMENTS:\n\n');
  for (const f of missingMounts) {
    process.stderr.write(`  ${f} loads /react/main.js but declares no element with a MOUNTS id\n`);
  }
  process.stderr.write(
    '\nEvery HTML page that loads /react/main.js must contain at least one\n' +
    'element whose id matches an entry in the MOUNTS table in\n' +
    'src/react/main.tsx.  A page with no mount element loads dead JS and\n' +
    'likely has a missing or mis-named container element.\n\n' +
    'Fix: add the correct mount container element (e.g.\n' +
    '  <div id="react-my-page"></div>\n' +
    ') to the HTML page, and ensure its id is registered in the MOUNTS\n' +
    'table in src/react/main.tsx.\n',
  );
}

if (conflicts.length > 0 || missingMounts.length > 0) {
  process.exit(1);
}
process.exit(0);
