#!/usr/bin/env node
/**
 * check-public-island-bootstrap.mjs
 *
 * Guards three complementary contracts between the authoritative MOUNTS table
 * and the two Set literals that control which React islands receive which
 * wrappers.
 *
 * Background
 * ----------
 * Three related data structures control public-island wiring:
 *
 *   MOUNTS (main.tsx) — annotated with `// public-island`
 *     The authoritative source of truth.  Any island served on a page that is
 *     accessible without an authenticated session must carry this annotation.
 *
 *   CONN_TOAST_EXCLUDED (main.tsx)
 *     Islands that must NOT receive the ConnectionToastProvider because they
 *     are public-facing and the session APIs return 401 for them.
 *
 *   BOOTSTRAP_EXCLUDED (AppBootstrapContext.tsx)
 *     Islands that must NOT receive the AppBootstrapProvider auth-redirect
 *     guard.  If a public island is missing from this set the bootstrap guard
 *     fires immediately on load, redirecting the unauthenticated visitor to
 *     /login, silently breaking the page.
 *
 * Invariant A: CONN_TOAST_EXCLUDED ⊆ BOOTSTRAP_EXCLUDED
 *   A public island correctly added to CONN_TOAST_EXCLUDED but forgotten in
 *   BOOTSTRAP_EXCLUDED will silently redirect unauthenticated visitors to
 *   /login.
 *
 * Invariant B: (BOOTSTRAP_EXCLUDED − BOOTSTRAP_ONLY_ALLOWED) ⊆ CONN_TOAST_EXCLUDED
 *   A public island added to BOOTSTRAP_EXCLUDED but forgotten in
 *   CONN_TOAST_EXCLUDED still receives ConnectionToastProvider, which calls
 *   session APIs that return 401 for unauthenticated visitors — breaking the
 *   page in a subtler way.
 *
 * Invariant C: every `// public-island`-annotated MOUNTS id ⊆ CONN_TOAST_EXCLUDED
 * Invariant D: every `// public-island`-annotated MOUNTS id ⊆ BOOTSTRAP_EXCLUDED
 *   These two together close the gap that A and B cannot: a developer adds a
 *   new public island to MOUNTS (correctly annotated) but forgets to add its
 *   id to either or both exclusion sets.  Without C and D, neither A nor B
 *   would fire because both reason only about the existing set contents.
 *
 * (BOOTSTRAP_EXCLUDED is intentionally a superset of CONN_TOAST_EXCLUDED — it
 * also includes the BOOTSTRAP_ONLY_ALLOWED ids that are rendered after auth
 * failures and therefore must never themselves redirect, yet are not public.)
 *
 * What this catches
 * -----------------
 * Check A: id in CONN_TOAST_EXCLUDED but NOT in BOOTSTRAP_EXCLUDED — the
 *   bootstrap guard redirects unauthenticated visitors to /login.
 *
 * Check B: id in BOOTSTRAP_EXCLUDED (but not in BOOTSTRAP_ONLY_ALLOWED) and
 *   NOT in CONN_TOAST_EXCLUDED — the island receives ConnectionToastProvider
 *   even though session APIs return 401.
 *
 * Check C: id annotated `// public-island` in MOUNTS but NOT in
 *   CONN_TOAST_EXCLUDED — catches the case where a developer forgets to
 *   add the id to CONN_TOAST_EXCLUDED at all.
 *
 * Check D: id annotated `// public-island` in MOUNTS but NOT in
 *   BOOTSTRAP_EXCLUDED — catches the case where a developer forgets to
 *   add the id to BOOTSTRAP_EXCLUDED at all.
 *
 * BOOTSTRAP_ONLY_ALLOWED
 * ----------------------
 * These ids are permitted to appear in BOOTSTRAP_EXCLUDED without a
 * corresponding entry in CONN_TOAST_EXCLUDED.  They are error / restricted
 * pages that are rendered after auth failures, not true public-facing islands:
 *
 *   not-found-root         — 404 page, shown after auth; never public
 *   access-restricted-root — access-denied page, shown after auth; never public
 *
 * If you add a new id here you MUST also add a comment explaining why it is
 * exempt from the CONN_TOAST_EXCLUDED requirement.
 *
 * Exit codes:
 *   0 — all four invariants hold
 *   1 — one or more invariants are violated, or the extraction pattern failed
 *       for any of the three sources
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
// Ids that may appear in BOOTSTRAP_EXCLUDED without a matching entry in
// CONN_TOAST_EXCLUDED.  These are error / restricted pages rendered after
// auth failures — they must skip the bootstrap redirect guard but are NOT
// public-facing pages that unauthenticated visitors should reach.
// ---------------------------------------------------------------------------
const BOOTSTRAP_ONLY_ALLOWED = new Set([
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
  let foundMountEntry = false; // true only when a line has BOTH id: AND the annotation

  for (const line of src.split('\n')) {
    if (!line.includes(annotationMarker)) continue;
    const m = idPattern.exec(line);
    if (!m) continue; // annotation in a comment-only line (e.g. the convention block comment) — skip
    foundMountEntry = true;
    ids.add(m[1]);
  }

  // If no actual mount-entry lines carried the annotation, the convention may
  // have been removed or all annotations accidentally deleted.  Fail rather
  // than silently passing all checks with an empty set (which would vacuously
  // satisfy "∅ ⊆ anything").
  if (!foundMountEntry) return null;

  return ids;
}

// ---------------------------------------------------------------------------
// 1. Read source files
// ---------------------------------------------------------------------------

const mainTsxPath      = join(ROOT, 'src', 'react', 'main.tsx');
const bootstrapCtxPath = join(ROOT, 'src', 'react', 'contexts', 'AppBootstrapContext.tsx');

const mainSrc      = readFileSync(mainTsxPath, 'utf8');
const bootstrapSrc = readFileSync(bootstrapCtxPath, 'utf8');

// ---------------------------------------------------------------------------
// 2. Extract data from all three sources
// ---------------------------------------------------------------------------

const connToastExcluded = extractSetLiteral(mainSrc, 'CONN_TOAST_EXCLUDED');
const bootstrapExcluded = extractSetLiteral(bootstrapSrc, 'BOOTSTRAP_EXCLUDED');
const publicIslandIds   = extractPublicIslandIds(mainSrc);

let failed = false;

if (!connToastExcluded) {
  process.stderr.write(
    '[check-public-island-bootstrap] ERROR: Could not extract CONN_TOAST_EXCLUDED ' +
    'from src/react/main.tsx — the declaration may have been renamed or reformatted. ' +
    'Update this script to match.\n',
  );
  failed = true;
}

if (!bootstrapExcluded) {
  process.stderr.write(
    '[check-public-island-bootstrap] ERROR: Could not extract BOOTSTRAP_EXCLUDED ' +
    'from src/react/contexts/AppBootstrapContext.tsx — the declaration may have been ' +
    'renamed or reformatted. Update this script to match.\n',
  );
  failed = true;
}

if (!publicIslandIds) {
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
  `[check-public-island-bootstrap] Found ${publicIslandIds.size} // public-island annotation(s); ` +
  `CONN_TOAST_EXCLUDED has ${connToastExcluded.size} id(s); ` +
  `BOOTSTRAP_EXCLUDED has ${bootstrapExcluded.size} id(s).`,
);

// ---------------------------------------------------------------------------
// 3. Check A: CONN_TOAST_EXCLUDED ⊆ BOOTSTRAP_EXCLUDED
// ---------------------------------------------------------------------------

/** @type {string[]} */
const missingFromBootstrap = [];
for (const id of connToastExcluded) {
  if (!bootstrapExcluded.has(id)) {
    missingFromBootstrap.push(id);
  }
}

if (missingFromBootstrap.length > 0) {
  process.stderr.write('\n[check-public-island-bootstrap] CHECK A FAILED — MISSING BOOTSTRAP EXCLUSIONS:\n\n');
  for (const id of missingFromBootstrap) {
    process.stderr.write(`  "${id}" is in CONN_TOAST_EXCLUDED (main.tsx) but NOT in BOOTSTRAP_EXCLUDED (AppBootstrapContext.tsx)\n`);
  }
  process.stderr.write(
    '\nEvery public island id added to CONN_TOAST_EXCLUDED in src/react/main.tsx\n' +
    'must also be added to BOOTSTRAP_EXCLUDED in\n' +
    'src/react/contexts/AppBootstrapContext.tsx.\n\n' +
    'Without this, AppBootstrapProvider will fire its auth-redirect guard for\n' +
    'unauthenticated visitors, immediately redirecting them to /login and\n' +
    'silently breaking the public-facing page.\n\n' +
    'Fix: add the missing id(s) above to the BOOTSTRAP_EXCLUDED Set in\n' +
    'src/react/contexts/AppBootstrapContext.tsx.\n',
  );
  failed = true;
} else {
  console.log(
    '[check-public-island-bootstrap] Check A OK — every id in CONN_TOAST_EXCLUDED ' +
    'is also in BOOTSTRAP_EXCLUDED.',
  );
}

// ---------------------------------------------------------------------------
// 4. Check B: (BOOTSTRAP_EXCLUDED − BOOTSTRAP_ONLY_ALLOWED) ⊆ CONN_TOAST_EXCLUDED
// ---------------------------------------------------------------------------

/** @type {string[]} */
const missingFromConnToast = [];
for (const id of bootstrapExcluded) {
  if (!BOOTSTRAP_ONLY_ALLOWED.has(id) && !connToastExcluded.has(id)) {
    missingFromConnToast.push(id);
  }
}

if (missingFromConnToast.length > 0) {
  process.stderr.write('\n[check-public-island-bootstrap] CHECK B FAILED — MISSING CONN_TOAST EXCLUSIONS:\n\n');
  for (const id of missingFromConnToast) {
    process.stderr.write(`  "${id}" is in BOOTSTRAP_EXCLUDED (AppBootstrapContext.tsx) but NOT in CONN_TOAST_EXCLUDED (main.tsx)\n`);
  }
  process.stderr.write(
    '\nEvery public-facing island id added to BOOTSTRAP_EXCLUDED in\n' +
    'src/react/contexts/AppBootstrapContext.tsx must also be added to\n' +
    'CONN_TOAST_EXCLUDED in src/react/main.tsx.\n\n' +
    'Without this, the island receives ConnectionToastProvider even though\n' +
    'session APIs return 401 for unauthenticated visitors, silently breaking\n' +
    'the public-facing page.\n\n' +
    'If the island is NOT public-facing (e.g. an error/restricted page rendered\n' +
    'only after auth failures) add its id to the BOOTSTRAP_ONLY_ALLOWED Set\n' +
    'at the top of scripts/check-public-island-bootstrap.mjs with a comment\n' +
    'explaining why it is exempt.\n\n' +
    'Fix: either add the missing id(s) above to CONN_TOAST_EXCLUDED in\n' +
    'src/react/main.tsx, or (for non-public error pages) add them to\n' +
    'BOOTSTRAP_ONLY_ALLOWED in scripts/check-public-island-bootstrap.mjs.\n',
  );
  failed = true;
} else {
  console.log(
    '[check-public-island-bootstrap] Check B OK — every non-error id in BOOTSTRAP_EXCLUDED ' +
    'is also in CONN_TOAST_EXCLUDED.',
  );
}

// ---------------------------------------------------------------------------
// 5. Check C: every `// public-island` MOUNTS id ⊆ CONN_TOAST_EXCLUDED
//    Closes the gap where a developer annotates a new public mount correctly
//    but forgets to add its id to CONN_TOAST_EXCLUDED.
// ---------------------------------------------------------------------------

/** @type {string[]} */
const publicNotInConnToast = [];
for (const id of publicIslandIds) {
  if (!connToastExcluded.has(id)) {
    publicNotInConnToast.push(id);
  }
}

if (publicNotInConnToast.length > 0) {
  process.stderr.write('\n[check-public-island-bootstrap] CHECK C FAILED — PUBLIC ISLANDS MISSING FROM CONN_TOAST_EXCLUDED:\n\n');
  for (const id of publicNotInConnToast) {
    process.stderr.write(`  "${id}" is annotated // public-island in MOUNTS (main.tsx) but NOT in CONN_TOAST_EXCLUDED\n`);
  }
  process.stderr.write(
    '\nEvery MOUNTS entry annotated with `// public-island` in src/react/main.tsx\n' +
    'must also appear in the CONN_TOAST_EXCLUDED Set in the same file.\n\n' +
    'Without this, the island receives ConnectionToastProvider even though\n' +
    'session APIs return 401 for unauthenticated visitors, silently breaking\n' +
    'the public-facing page.\n\n' +
    'Fix: add the missing id(s) above to the CONN_TOAST_EXCLUDED Set in\n' +
    'src/react/main.tsx.\n',
  );
  failed = true;
} else {
  console.log(
    '[check-public-island-bootstrap] Check C OK — every // public-island annotation ' +
    'in MOUNTS is present in CONN_TOAST_EXCLUDED.',
  );
}

// ---------------------------------------------------------------------------
// 6. Check D: every `// public-island` MOUNTS id ⊆ BOOTSTRAP_EXCLUDED
//    Closes the gap where a developer annotates a new public mount correctly
//    but forgets to add its id to BOOTSTRAP_EXCLUDED.
// ---------------------------------------------------------------------------

/** @type {string[]} */
const publicNotInBootstrap = [];
for (const id of publicIslandIds) {
  if (!bootstrapExcluded.has(id)) {
    publicNotInBootstrap.push(id);
  }
}

if (publicNotInBootstrap.length > 0) {
  process.stderr.write('\n[check-public-island-bootstrap] CHECK D FAILED — PUBLIC ISLANDS MISSING FROM BOOTSTRAP_EXCLUDED:\n\n');
  for (const id of publicNotInBootstrap) {
    process.stderr.write(`  "${id}" is annotated // public-island in MOUNTS (main.tsx) but NOT in BOOTSTRAP_EXCLUDED (AppBootstrapContext.tsx)\n`);
  }
  process.stderr.write(
    '\nEvery MOUNTS entry annotated with `// public-island` in src/react/main.tsx\n' +
    'must also appear in the BOOTSTRAP_EXCLUDED Set in\n' +
    'src/react/contexts/AppBootstrapContext.tsx.\n\n' +
    'Without this, AppBootstrapProvider will fire its auth-redirect guard for\n' +
    'unauthenticated visitors, immediately redirecting them to /login and\n' +
    'silently breaking the public-facing page.\n\n' +
    'Fix: add the missing id(s) above to the BOOTSTRAP_EXCLUDED Set in\n' +
    'src/react/contexts/AppBootstrapContext.tsx.\n',
  );
  failed = true;
} else {
  console.log(
    '[check-public-island-bootstrap] Check D OK — every // public-island annotation ' +
    'in MOUNTS is present in BOOTSTRAP_EXCLUDED.',
  );
}

// ---------------------------------------------------------------------------
// 7. Final result
// ---------------------------------------------------------------------------

if (failed) process.exit(1);
