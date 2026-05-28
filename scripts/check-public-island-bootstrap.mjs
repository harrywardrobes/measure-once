#!/usr/bin/env node
/**
 * check-public-island-bootstrap.mjs
 *
 * Guards the single-source-of-truth contract introduced in task #1909 and
 * extended in task #1919.
 *
 * Background
 * ----------
 * All island-id sets are now authoritative in ONE file:
 *
 *   src/react/lib/publicIslands.ts
 *
 *     PUBLIC_ISLAND_IDS  — islands on pages accessible without an auth session.
 *     BOOTSTRAP_ONLY_IDS — error/restricted pages that skip the bootstrap
 *                          auth-redirect guard but are NOT public-facing.
 *
 * Downstream consumers derive from those sets at runtime:
 *
 *   CONN_TOAST_EXCLUDED (main.tsx)
 *     Set to PUBLIC_ISLAND_IDS directly — no separate literal.
 *
 *   BOOTSTRAP_EXCLUDED (AppBootstrapContext.tsx)
 *     Derived as: new Set([...PUBLIC_ISLAND_IDS, ...BOOTSTRAP_ONLY_IDS])
 *
 * Checks
 * ------
 *   A: every `// public-island`-annotated MOUNTS id ⊆ PUBLIC_ISLAND_IDS
 *      Catches: annotation without a matching Set entry.
 *
 *   B: PUBLIC_ISLAND_IDS ⊆ `// public-island`-annotated MOUNTS ids
 *      Catches: stale Set entry or MOUNTS entry removed without updating the Set.
 *
 *   C: no BOOTSTRAP_ONLY_IDS id ∈ PUBLIC_ISLAND_IDS
 *      Catches: error/restricted page accidentally added to PUBLIC_ISLAND_IDS.
 *
 *   D: every BOOTSTRAP_ONLY_IDS id ∈ MOUNTS ids (src/react/main.tsx)
 *      Catches: a typo in BOOTSTRAP_ONLY_IDS, or a stale entry left behind
 *      after an error page is removed from MOUNTS.
 *
 *   E: every BOOTSTRAP_ONLY_IDS entry carries a `// public/<file>.html` annotation
 *      Catches: a new error/restricted page added without the required file
 *      annotation (mirrors the Pass 4a rule in check-mount-id-conflicts.mjs).
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
// Helper: extract ALL mount ids from the MOUNTS array in main.tsx
// ---------------------------------------------------------------------------

/**
 * Extracts every id string from `{ id: 'some-id', … }` entries in the MOUNTS
 * array of src/react/main.tsx.
 *
 * Returns the Set of id strings, or null if no entries are found (indicating
 * the MOUNTS pattern has changed and this script needs updating).
 *
 * @param {string} src
 * @returns {Set<string> | null}
 */
function extractAllMountIds(src) {
  const pattern = /\{\s*id:\s*['"]([^'"]+)['"]/g;
  const ids = new Set();
  let m;
  while ((m = pattern.exec(src)) !== null) {
    ids.add(m[1]);
  }
  return ids.size > 0 ? ids : null;
}

// ---------------------------------------------------------------------------
// Helper: check BOOTSTRAP_ONLY_IDS entries for `// public/<file>.html` annotations
// ---------------------------------------------------------------------------

/**
 * Parses the body of the BOOTSTRAP_ONLY_IDS Set literal in `src` and returns
 * an array of `{ id, hasAnnotation }` objects — one per line that contains a
 * string literal.
 *
 * The required annotation format is `// public/<file>.html` anywhere on the
 * same line as the id string.  This mirrors Pass 4a in
 * check-mount-id-conflicts.mjs.
 *
 * Returns null if the BOOTSTRAP_ONLY_IDS declaration cannot be located (parse
 * error — the caller should treat this as a hard failure).
 *
 * @param {string} src
 * @returns {Array<{ id: string, hasAnnotation: boolean }> | null}
 */
function extractBootstrapAnnotations(src) {
  const startPattern = /(?:const|let|var)\s+BOOTSTRAP_ONLY_IDS\s*=\s*new\s+Set\s*\(\s*\[/;
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
  if (depth !== 0) return null; // unterminated

  const body = src.slice(bodyStart, i - 1);
  const annotationPattern = /\/\/\s*public\/\S+\.html/;
  const strPattern = /['"]([^'"]+)['"]/g;
  const results = [];

  for (const line of body.split('\n')) {
    const m = strPattern.exec(line);
    strPattern.lastIndex = 0; // reset for next line
    if (!m) continue; // no string literal on this line — skip (e.g. blank or comment-only)
    results.push({ id: m[1], hasAnnotation: annotationPattern.test(line) });
  }

  return results;
}

// ---------------------------------------------------------------------------
// 1. Read source files
// ---------------------------------------------------------------------------

const publicIslandsPath = join(ROOT, 'src', 'react', 'lib', 'publicIslands.ts');
const mainTsxPath       = join(ROOT, 'src', 'react', 'main.tsx');

const publicIslandsSrc = readFileSync(publicIslandsPath, 'utf8');
const mainSrc          = readFileSync(mainTsxPath, 'utf8');

// ---------------------------------------------------------------------------
// 2. Extract data from source files
// ---------------------------------------------------------------------------

const publicIslandIds        = extractSetLiteral(publicIslandsSrc, 'PUBLIC_ISLAND_IDS');
const bootstrapOnlyIds       = extractSetLiteral(publicIslandsSrc, 'BOOTSTRAP_ONLY_IDS');
const annotatedIds           = extractPublicIslandIds(mainSrc);
const allMountIds            = extractAllMountIds(mainSrc);
const bootstrapAnnotations   = extractBootstrapAnnotations(publicIslandsSrc);

let failed = false;

if (!publicIslandIds) {
  process.stderr.write(
    '[check-public-island-bootstrap] ERROR: Could not extract PUBLIC_ISLAND_IDS ' +
    'from src/react/lib/publicIslands.ts — the declaration may have been renamed ' +
    'or reformatted. Update this script to match.\n',
  );
  failed = true;
}

if (!bootstrapOnlyIds) {
  process.stderr.write(
    '[check-public-island-bootstrap] ERROR: Could not extract BOOTSTRAP_ONLY_IDS ' +
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

if (!allMountIds) {
  process.stderr.write(
    '[check-public-island-bootstrap] ERROR: Could not extract any MOUNTS ids from ' +
    'src/react/main.tsx — the MOUNTS pattern may have changed. Update this script ' +
    'to match.\n',
  );
  failed = true;
}

if (!bootstrapAnnotations) {
  process.stderr.write(
    '[check-public-island-bootstrap] ERROR: Could not locate BOOTSTRAP_ONLY_IDS body ' +
    'in src/react/lib/publicIslands.ts for annotation scanning — the declaration may ' +
    'have been renamed or reformatted. Update this script to match.\n',
  );
  failed = true;
}

if (failed) process.exit(1);

console.log(
  `[check-public-island-bootstrap] Found ${annotatedIds.size} // public-island annotation(s) in MOUNTS; ` +
  `PUBLIC_ISLAND_IDS has ${publicIslandIds.size} id(s); ` +
  `BOOTSTRAP_ONLY_IDS has ${bootstrapOnlyIds.size} id(s); ` +
  `MOUNTS has ${allMountIds.size} total id(s).`,
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
// 5. Check C: BOOTSTRAP_ONLY_IDS ∩ PUBLIC_ISLAND_IDS must be empty
//    Catches: an error/restricted page accidentally added to PUBLIC_ISLAND_IDS,
//    which would incorrectly route it through ConnectionToastProvider exclusion.
// ---------------------------------------------------------------------------

/** @type {string[]} */
const bootOnlyInPublic = [];
for (const id of bootstrapOnlyIds) {
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
    '\nError/restricted pages in BOOTSTRAP_ONLY_IDS must NOT appear in\n' +
    'PUBLIC_ISLAND_IDS (src/react/lib/publicIslands.ts).\n\n' +
    'Remove the conflicting id(s) from PUBLIC_ISLAND_IDS.\n',
  );
  failed = true;
} else {
  console.log(
    '[check-public-island-bootstrap] Check C OK — no BOOTSTRAP_ONLY_IDS appear in PUBLIC_ISLAND_IDS.',
  );
}

// ---------------------------------------------------------------------------
// 6. Check D: every BOOTSTRAP_ONLY_IDS id ∈ all MOUNTS ids
//    Catches: a typo in BOOTSTRAP_ONLY_IDS, or a stale entry left after an
//    error page's MOUNTS entry is removed.
// ---------------------------------------------------------------------------

/** @type {string[]} */
const bootOnlyNotInMounts = [];
for (const id of bootstrapOnlyIds) {
  if (!allMountIds.has(id)) {
    bootOnlyNotInMounts.push(id);
  }
}

if (bootOnlyNotInMounts.length > 0) {
  process.stderr.write('\n[check-public-island-bootstrap] CHECK D FAILED — BOOTSTRAP_ONLY_IDS WITHOUT MOUNTS ENTRY:\n\n');
  for (const id of bootOnlyNotInMounts) {
    process.stderr.write(`  "${id}" is in BOOTSTRAP_ONLY_IDS (src/react/lib/publicIslands.ts) but has no matching entry in the MOUNTS array (src/react/main.tsx)\n`);
  }
  process.stderr.write(
    '\nEvery id in BOOTSTRAP_ONLY_IDS must correspond to an actual MOUNTS entry\n' +
    'in src/react/main.tsx.\n\n' +
    'This may mean:\n' +
    '  - A typo was introduced in BOOTSTRAP_ONLY_IDS.\n' +
    '  - An error page was removed from MOUNTS without removing its id from\n' +
    '    BOOTSTRAP_ONLY_IDS in src/react/lib/publicIslands.ts.\n\n' +
    'Fix: either correct the id in BOOTSTRAP_ONLY_IDS, or remove the stale\n' +
    'entry from BOOTSTRAP_ONLY_IDS.\n',
  );
  failed = true;
} else {
  console.log(
    '[check-public-island-bootstrap] Check D OK — every BOOTSTRAP_ONLY_IDS id ' +
    'has a corresponding MOUNTS entry.',
  );
}

// ---------------------------------------------------------------------------
// 7. Check E: every BOOTSTRAP_ONLY_IDS entry has a `// public/<file>.html` annotation
//    Catches: a new error/restricted page added to BOOTSTRAP_ONLY_IDS without
//    the required file annotation (mirrors Pass 4a in check-mount-id-conflicts).
// ---------------------------------------------------------------------------

/** @type {string[]} */
const missingAnnotation = bootstrapAnnotations
  .filter((entry) => !entry.hasAnnotation)
  .map((entry) => entry.id);

if (missingAnnotation.length > 0) {
  process.stderr.write('\n[check-public-island-bootstrap] CHECK E FAILED — BOOTSTRAP_ONLY_IDS ENTRIES WITHOUT ANNOTATION:\n\n');
  for (const id of missingAnnotation) {
    process.stderr.write(`  "${id}" is in BOOTSTRAP_ONLY_IDS but its line lacks a // public/<file>.html annotation\n`);
  }
  process.stderr.write(
    '\nEvery entry in BOOTSTRAP_ONLY_IDS (src/react/lib/publicIslands.ts) must carry\n' +
    'a trailing `// public/<file>.html — <description>` annotation on the same line.\n\n' +
    'Example:\n' +
    "  'not-found-root', // public/404.html — 404 page, rendered after auth; never public\n\n" +
    'Fix: add the missing annotation to each id listed above.\n',
  );
  failed = true;
} else {
  console.log(
    '[check-public-island-bootstrap] Check E OK — every BOOTSTRAP_ONLY_IDS entry ' +
    'has a // public/<file>.html annotation.',
  );
}

// ---------------------------------------------------------------------------
// 8. Final result
// ---------------------------------------------------------------------------

if (failed) process.exit(1);
