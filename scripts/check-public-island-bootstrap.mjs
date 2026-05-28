#!/usr/bin/env node
/**
 * check-public-island-bootstrap.mjs
 *
 * Guards the single-source-of-truth contract introduced in task #1909.
 *
 * Background
 * ----------
 * Public island wiring is now driven by one authoritative Set:
 *
 *   PUBLIC_ISLAND_IDS  (src/react/lib/publicIslands.ts)
 *     The canonical list of island ids that are served on pages accessible
 *     without an authenticated session.
 *
 * Both downstream consumers derive from it:
 *
 *   CONN_TOAST_EXCLUDED (main.tsx)
 *     Set to PUBLIC_ISLAND_IDS directly — no separate literal.
 *
 *   BOOTSTRAP_EXCLUDED (AppBootstrapContext.tsx)
 *     Derived as: new Set([...PUBLIC_ISLAND_IDS, ...BOOTSTRAP_ONLY_IDS])
 *     where BOOTSTRAP_ONLY_IDS holds error/restricted pages (not-found-root,
 *     access-restricted-root) that must also skip the auth-redirect guard but
 *     are never themselves public-facing pages.
 *
 * Because both consumers are derived, the only drift that matters is between
 * PUBLIC_ISLAND_IDS and the `// public-island` annotations in the MOUNTS table
 * of src/react/main.tsx (which serve as developer-visible documentation of
 * which islands are public-facing).
 *
 * Invariant A: every `// public-island`-annotated MOUNTS id ⊆ PUBLIC_ISLAND_IDS
 *   A developer annotated a MOUNTS entry but forgot to add the id to the Set.
 *   The island would silently receive ConnectionToastProvider and the bootstrap
 *   auth-redirect guard, breaking the public-facing page.
 *
 * Invariant B: PUBLIC_ISLAND_IDS ⊆ `// public-island`-annotated MOUNTS ids
 *   A developer added an id to PUBLIC_ISLAND_IDS but forgot the annotation on
 *   the MOUNTS entry — or the MOUNTS entry was removed without updating the Set.
 *
 * BOOTSTRAP_ONLY_IDS
 * ------------------
 * These ids appear in AppBootstrapContext's BOOTSTRAP_ONLY_IDS: they are
 * error/restricted pages that skip the bootstrap redirect but are not public.
 * They must NOT appear in PUBLIC_ISLAND_IDS.  This script checks that none of
 * them are accidentally present in PUBLIC_ISLAND_IDS.
 *
 *   not-found-root         — 404 page, rendered after auth; never public
 *   access-restricted-root — access-denied page, rendered after auth; never public
 *
 * Exit codes:
 *   0 — all invariants hold
 *   1 — one or more invariants are violated, or a source could not be parsed
 *
 * Usage:
 *   node scripts/check-public-island-bootstrap.mjs
 *
 * Wired into CI via: npm run test:public-island-bootstrap
 */

import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Ids that live in AppBootstrapContext's BOOTSTRAP_ONLY_IDS — they skip the
// bootstrap redirect guard but are NOT public-facing.  They must never appear
// in PUBLIC_ISLAND_IDS.
// ---------------------------------------------------------------------------
const BOOTSTRAP_ONLY_IDS = new Set([
  'not-found-root',         // 404 page, rendered after auth; never public
  'access-restricted-root', // access-denied page, rendered after auth; never public
]);

// ---------------------------------------------------------------------------
// Helper: extract string literals from a `new Set([…])` declaration
// ---------------------------------------------------------------------------

/**
 * Extracts the string values from a `const NAME = new Set([ 'a', 'b', … ]);`
 * declaration in the given source text.
 *
 * Returns the Set of string values, or null if the declaration cannot be found.
 *
 * @param {string} src
 * @param {string} varName
 * @returns {Set<string> | null}
 */
function extractSetLiteral(src, varName) {
  const startPattern = new RegExp(
    `(?:const|let|var)\\s+${varName}\\s*=\\s*new\\s+Set\\s*\\(\\s*\\[`,
  );
  const startMatch = startPattern.exec(src);
  if (!startMatch) return null;

  let depth = 1;
  let i = startMatch.index + startMatch[0].length;
  const bodyStart = i;
  while (i < src.length && depth > 0) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') depth--;
    i++;
  }
  if (depth !== 0) return null; // unterminated — parse error

  const body = src.slice(bodyStart, i - 1);

  const ids = new Set();
  const strPattern = /['"]([^'"]+)['"]/g;
  let m;
  while ((m = strPattern.exec(body)) !== null) {
    ids.add(m[1]);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Helper: extract ids from MOUNTS entries annotated with `// public-island`
// ---------------------------------------------------------------------------

/**
 * Scans `src` line by line for lines that contain both:
 *   - an `id:` property with a string value
 *   - the trailing annotation comment `// public-island`
 *
 * Returns the Set of matched id strings, or null if no `// public-island`
 * lines are found at all (which would mean the annotation convention has
 * been removed or renamed, and the check should fail rather than silently
 * pass with an empty set).
 *
 * @param {string} src
 * @returns {Set<string> | null}
 */
function extractPublicIslandIds(src) {
  const idPattern = /id:\s*['"]([^'"]+)['"]/;
  const annotationMarker = '// public-island';

  const ids = new Set();
  let foundMountEntry = false;

  for (const line of src.split('\n')) {
    if (!line.includes(annotationMarker)) continue;
    const m = idPattern.exec(line);
    if (!m) continue; // annotation in a comment-only line (e.g. the convention block) — skip
    foundMountEntry = true;
    ids.add(m[1]);
  }

  if (!foundMountEntry) return null;

  return ids;
}

// ---------------------------------------------------------------------------
// 1. Read source files
// ---------------------------------------------------------------------------

const publicIslandsPath = join(ROOT, 'src', 'react', 'lib', 'publicIslands.ts');
const mainTsxPath       = join(ROOT, 'src', 'react', 'main.tsx');

const publicIslandsSrc = readFileSync(publicIslandsPath, 'utf8');
const mainSrc          = readFileSync(mainTsxPath, 'utf8');

// ---------------------------------------------------------------------------
// 2. Extract data from both sources
// ---------------------------------------------------------------------------

const publicIslandIds  = extractSetLiteral(publicIslandsSrc, 'PUBLIC_ISLAND_IDS');
const annotatedIds     = extractPublicIslandIds(mainSrc);

let failed = false;

if (!publicIslandIds) {
  process.stderr.write(
    '[check-public-island-bootstrap] ERROR: Could not extract PUBLIC_ISLAND_IDS ' +
    'from src/react/lib/publicIslands.ts — the declaration may have been renamed ' +
    'or reformatted. Update this script to match.\n',
  );
  failed = true;
}

if (!annotatedIds) {
  process.stderr.write(
    '[check-public-island-bootstrap] ERROR: No `// public-island` annotations found ' +
    'in src/react/main.tsx — the annotation convention may have been removed or ' +
    'renamed. Either restore the annotations on public-facing MOUNTS entries or ' +
    'update this script to match.\n',
  );
  failed = true;
}

if (failed) process.exit(1);

console.log(
  `[check-public-island-bootstrap] Found ${annotatedIds.size} // public-island annotation(s) in MOUNTS; ` +
  `PUBLIC_ISLAND_IDS has ${publicIslandIds.size} id(s).`,
);

// ---------------------------------------------------------------------------
// 3. Check A: every annotated MOUNTS id ⊆ PUBLIC_ISLAND_IDS
//    Catches: annotation on MOUNTS entry without a matching entry in the Set.
// ---------------------------------------------------------------------------

/** @type {string[]} */
const annotatedNotInSet = [];
for (const id of annotatedIds) {
  if (!publicIslandIds.has(id)) {
    annotatedNotInSet.push(id);
  }
}

if (annotatedNotInSet.length > 0) {
  process.stderr.write('\n[check-public-island-bootstrap] CHECK A FAILED — ANNOTATIONS WITHOUT SET ENTRY:\n\n');
  for (const id of annotatedNotInSet) {
    process.stderr.write(`  "${id}" is annotated // public-island in MOUNTS (main.tsx) but NOT in PUBLIC_ISLAND_IDS (src/react/lib/publicIslands.ts)\n`);
  }
  process.stderr.write(
    '\nEvery MOUNTS entry annotated with `// public-island` in src/react/main.tsx\n' +
    'must also appear in the PUBLIC_ISLAND_IDS Set in\n' +
    'src/react/lib/publicIslands.ts.\n\n' +
    'Without this, the island still receives ConnectionToastProvider and the\n' +
    'AppBootstrapProvider auth-redirect guard, breaking the public-facing page.\n\n' +
    'Fix: add the missing id(s) above to PUBLIC_ISLAND_IDS in\n' +
    'src/react/lib/publicIslands.ts.\n',
  );
  failed = true;
} else {
  console.log(
    '[check-public-island-bootstrap] Check A OK — every // public-island annotation ' +
    'in MOUNTS is present in PUBLIC_ISLAND_IDS.',
  );
}

// ---------------------------------------------------------------------------
// 4. Check B: PUBLIC_ISLAND_IDS ⊆ annotated MOUNTS ids
//    Catches: an id added to the Set without a matching annotation in MOUNTS,
//    or a MOUNTS entry removed without updating the Set.
// ---------------------------------------------------------------------------

/** @type {string[]} */
const setNotAnnotated = [];
for (const id of publicIslandIds) {
  if (!annotatedIds.has(id)) {
    setNotAnnotated.push(id);
  }
}

if (setNotAnnotated.length > 0) {
  process.stderr.write('\n[check-public-island-bootstrap] CHECK B FAILED — SET ENTRIES WITHOUT ANNOTATION:\n\n');
  for (const id of setNotAnnotated) {
    process.stderr.write(`  "${id}" is in PUBLIC_ISLAND_IDS (src/react/lib/publicIslands.ts) but NOT annotated // public-island in MOUNTS (main.tsx)\n`);
  }
  process.stderr.write(
    '\nEvery id in PUBLIC_ISLAND_IDS in src/react/lib/publicIslands.ts must have a\n' +
    'corresponding MOUNTS entry annotated with `// public-island` in\n' +
    'src/react/main.tsx.\n\n' +
    'This may mean a MOUNTS entry was removed without updating PUBLIC_ISLAND_IDS,\n' +
    'or a new id was added to the Set without annotating its MOUNTS entry.\n\n' +
    'Fix: either add `// public-island` to the MOUNTS entry in src/react/main.tsx,\n' +
    'or remove the stale id from PUBLIC_ISLAND_IDS in src/react/lib/publicIslands.ts.\n',
  );
  failed = true;
} else {
  console.log(
    '[check-public-island-bootstrap] Check B OK — every id in PUBLIC_ISLAND_IDS ' +
    'has a // public-island annotation in MOUNTS.',
  );
}

// ---------------------------------------------------------------------------
// 5. Sanity check: BOOTSTRAP_ONLY_IDS must not appear in PUBLIC_ISLAND_IDS
//    Catches: an error/restricted page accidentally added to PUBLIC_ISLAND_IDS,
//    which would incorrectly route it through ConnectionToastProvider exclusion.
// ---------------------------------------------------------------------------

/** @type {string[]} */
const bootOnlyInPublic = [];
for (const id of BOOTSTRAP_ONLY_IDS) {
  if (publicIslandIds.has(id)) {
    bootOnlyInPublic.push(id);
  }
}

if (bootOnlyInPublic.length > 0) {
  process.stderr.write('\n[check-public-island-bootstrap] CHECK C FAILED — BOOTSTRAP_ONLY_IDS IN PUBLIC_ISLAND_IDS:\n\n');
  for (const id of bootOnlyInPublic) {
    process.stderr.write(`  "${id}" is a BOOTSTRAP_ONLY_IDS entry (error/restricted page) but also appears in PUBLIC_ISLAND_IDS\n`);
  }
  process.stderr.write(
    '\nThe following ids are designated error/restricted pages (BOOTSTRAP_ONLY_IDS\n' +
    'in AppBootstrapContext.tsx) and must NOT appear in PUBLIC_ISLAND_IDS:\n\n' +
    Array.from(BOOTSTRAP_ONLY_IDS).map(id => `  ${id}`).join('\n') + '\n\n' +
    'Remove the conflicting id(s) from PUBLIC_ISLAND_IDS in\n' +
    'src/react/lib/publicIslands.ts.\n',
  );
  failed = true;
} else {
  console.log(
    '[check-public-island-bootstrap] Check C OK — no BOOTSTRAP_ONLY_IDS appear in PUBLIC_ISLAND_IDS.',
  );
}

// ---------------------------------------------------------------------------
// 6. Final result
// ---------------------------------------------------------------------------

if (failed) process.exit(1);
