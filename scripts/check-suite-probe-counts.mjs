#!/usr/bin/env node
/**
 * scripts/check-suite-probe-counts.mjs
 *
 * For each suite row in docs/TEST_SUITES.md that documents probe labels
 * (bold **(X)** callouts), this script:
 *
 *   1. Locates the suite's test file via the package.json script definition.
 *   2. Finds the PROBE_LABELS array in that file.
 *   3. Extracts the set of probe IDs present in the implementation.
 *   4. Compares them against the probe IDs documented in TEST_SUITES.md
 *      in BOTH directions:
 *        a. Forward: probes in the test file missing from docs (impl ahead of docs).
 *        b. Reverse: probes documented in TEST_SUITES.md missing from the test
 *           file (docs ahead of impl — stale documentation).
 *
 * Fails CI with a clear message for every suite with a mismatch in either
 * direction.
 *
 * Secondary scan (non-failing): detects suites whose docs row contains probe
 * callouts but whose test file does not declare a PROBE_LABELS array.  These
 * suites are invisible to the drift check.  Known legacy suites are listed in
 * NO_PROBE_LABELS_ALLOWLIST below with a reason comment.  Any suite NOT in
 * that allowlist emits a warning so new additions are visible immediately.
 *
 * Suites are fully skipped when:
 *   - The docs row has no bold **(X)** probe callouts, OR
 *   - The test file cannot be located from package.json scripts.
 *
 * Per-suite suppression for the reverse check:
 *   A test file may declare a PROBE_LABELS_DOC_EXTRAS constant — an array of
 *   plain probe-ID strings (e.g. ['CC-A2']) — listing IDs that appear in docs
 *   but intentionally have no dedicated entry in PROBE_LABELS (typically because
 *   two distinct doc IDs map to a single implementation probe label).  These IDs
 *   are excluded from the reverse-check failures.  Whenever PROBE_LABELS_DOC_EXTRAS
 *   is detected in any scanned test file, the script emits a non-failing advisory
 *   message naming the suite and suppressed IDs as a reminder that the preferred
 *   fix is to give each probe a distinct label so no suppression is needed.
 *
 * Run via:  npm run test:suite-probe-counts
 *
 * ---------------------------------------------------------------------------
 * Authoring contract — summary for new test suites
 * ---------------------------------------------------------------------------
 * When adding a new suite that covers distinct named probes (e.g. (A), (B),
 * (ST-A)), you must:
 *
 *   1. Declare a PROBE_LABELS array near the top of the test file, one entry
 *      per probe.  Each string must begin with the probe ID in parentheses or
 *      square brackets, e.g.:
 *
 *        const PROBE_LABELS = [
 *          '(A) happy-path description',
 *          '(B) error-state description',
 *        ];
 *
 *      IDs must start with an uppercase letter; digits, hyphens, and further
 *      letters are allowed (A, F1, ST-A, CC-A, A-open, A-open-blocked, …).
 *
 *   2. List every probe ID in the matching docs/TEST_SUITES.md row using bold
 *      callout notation: **(A)**, **(ST-A)**, slash-separated for groups:
 *      **(A-open/B-open/B2-open)**.
 *
 *   3. Keep PROBE_LABELS and the docs row in sync in both directions — this
 *      script fails CI for any mismatch.
 *
 * Suites with no named probes should omit PROBE_LABELS entirely; rows with no
 * bold callouts are silently skipped.
 *
 * See docs/TEST_SUITES.md § "Adding a new test suite" for the full checklist
 * and edge-case guidance (PROBE_LABELS_DOC_EXTRAS, NO_PROBE_LABELS_ALLOWLIST).
 * ---------------------------------------------------------------------------
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------------------
// Allowlist — suites with documented probes that intentionally have no
// PROBE_LABELS array (typically pre-dating the convention).  Each entry must
// carry a short reason explaining why it is exempt.  Any suite with doc probes
// and no PROBE_LABELS that is NOT listed here will trigger a non-failing
// warning so new omissions are visible immediately.
// ---------------------------------------------------------------------------

const NO_PROBE_LABELS_ALLOWLIST = new Map([
  // All legacy suites have been migrated to PROBE_LABELS.
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a map of suite name → absolute file path from package.json scripts.
 * Only considers non-:ci test:* entries whose command ends with a .js file.
 */
function buildFileMap(scripts) {
  const map = new Map();
  for (const [key, cmd] of Object.entries(scripts)) {
    if (!key.startsWith('test:') || key.endsWith(':ci')) continue;
    const m = cmd.match(/\s((?:test|scripts)\/[^\s]+\.js)\s*$/);
    if (m) map.set(key, join(ROOT, m[1]));
  }
  return map;
}

/**
 * Extract probe IDs documented in a TEST_SUITES.md row.
 * Looks for bold **( X )** callouts.  Handles slash-separated combined
 * notation like **(A-open/B-open/B2-open)** by splitting on '/'.
 * Returns a Set of normalised ID strings such as 'A', 'ST-A', 'A-open', etc.
 */
function extractDocProbeIds(rowText) {
  const ids = new Set();
  for (const m of rowText.matchAll(/\*\*\(([^)]+)\)\*\*/g)) {
    for (const part of m[1].split('/')) {
      const trimmed = part.trim();
      if (trimmed) ids.add(trimmed);
    }
  }
  return ids;
}

/**
 * Extract probe IDs from a test file that uses a PROBE_LABELS array.
 * Returns null when no PROBE_LABELS is present (file uses a different style).
 * Otherwise returns a Set of IDs like 'A', 'F1', 'ST-A', 'A-open', etc.
 *
 * Probe IDs are the token immediately after the opening ( or [ in each string
 * literal within the array, e.g. '(A) description…' → 'A'.
 */
function extractRunJsProbeIds(src) {
  if (!src.includes('PROBE_LABELS')) return null;

  const ids = new Set();
  // Match string literals that start (after optional whitespace) with a
  // probe-label token: ( or [ followed by the ID, then ) or ] then a space.
  // The ID must begin with an uppercase letter (filters out lowercase-only
  // tokens like [pageerror] or [setup]).  After the first uppercase letter,
  // digits, hyphens, and further letters (any case) are allowed — covering
  // 'A', 'F1', 'ST-A', 'CC-A', 'A-open', 'A-open-blocked', 'SKP-A', etc.
  const pattern = /['"`]\s*[\(\[]([A-Z][A-Za-z0-9-]*)[\)\]]\s/g;
  for (const m of src.matchAll(pattern)) {
    ids.add(m[1]);
  }
  return ids.size > 0 ? ids : null;
}

/**
 * Extract the set of probe IDs listed in PROBE_LABELS_DOC_EXTRAS.
 * These are IDs that exist in docs but intentionally have no dedicated entry
 * in PROBE_LABELS (e.g. 'CC-A2' when two doc IDs map to a single impl label).
 * Returns an empty Set when the constant is absent.
 */
function extractDocExtrasProbeIds(src) {
  const arrayMatch = src.match(/PROBE_LABELS_DOC_EXTRAS\s*=\s*\[([^\]]*)\]/s);
  if (!arrayMatch) return new Set();
  const ids = new Set();
  for (const m of arrayMatch[1].matchAll(/['"`]([^'"`]+)['"`]/g)) {
    ids.add(m[1].trim());
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const docsFile = join(ROOT, 'docs', 'TEST_SUITES.md');
const pkgFile  = join(ROOT, 'package.json');

const docsSrc = readFileSync(docsFile, 'utf8');
const pkg     = JSON.parse(readFileSync(pkgFile, 'utf8'));
const fileMap = buildFileMap(pkg.scripts ?? {});

// Parse table rows: first column is the suite name, second is the description.
const suiteRows = new Map();
for (const line of docsSrc.split('\n')) {
  const m = line.match(/^\|\s*`(test:[^`]+)`\s*\|\s*(.*?)\s*\|?\s*$/);
  if (m) suiteRows.set(m[1], m[2]);
}

const forwardFailures      = [];
const reverseFailures      = [];
const docExtrasStaleFailures = [];  // PROBE_LABELS_DOC_EXTRAS entries not present in docs
const noArrayWarn          = [];  // suites with doc probes but no PROBE_LABELS, not in allowlist
const docExtrasWarn        = [];  // suites using PROBE_LABELS_DOC_EXTRAS (non-failing advisory)
let   checked              = 0;
let   skipped              = 0;
let   allowlisted          = 0;

for (const [suiteName, rowText] of suiteRows) {
  const docIds = extractDocProbeIds(rowText);

  if (docIds.size === 0) {
    // No probe callouts in docs — nothing to compare against.
    skipped++;
    continue;
  }

  const filePath = fileMap.get(suiteName);
  if (!filePath || !existsSync(filePath)) {
    // Cannot locate the test file from package.json scripts — skip.
    skipped++;
    continue;
  }

  const src    = readFileSync(filePath, 'utf8');
  const runIds = extractRunJsProbeIds(src);

  if (runIds === null) {
    // File does not use a PROBE_LABELS array — cannot compare reliably.
    // Check the allowlist: known legacy suites are explicitly documented there.
    // Anything NOT in the allowlist is a new omission and gets a warning.
    if (NO_PROBE_LABELS_ALLOWLIST.has(suiteName)) {
      allowlisted++;
    } else {
      noArrayWarn.push({
        suite:  suiteName,
        file:   filePath.replace(ROOT + '/', ''),
        docIds: [...docIds].sort(),
      });
    }
    continue;
  }

  // Forward check: probes in the test file not yet mentioned in docs.
  const undoc = [...runIds].filter((id) => !docIds.has(id)).sort();
  if (undoc.length > 0) {
    forwardFailures.push({
      suite:  suiteName,
      file:   filePath.replace(ROOT + '/', ''),
      undoc,
      docIds: [...docIds].sort(),
      runIds: [...runIds].sort(),
    });
  }

  // Reverse check: probes documented in docs not found in the test file.
  // PROBE_LABELS_DOC_EXTRAS in the test file suppresses known doc-only aliases.
  const docExtras = extractDocExtrasProbeIds(src);

  // Stale-extras check (failing): each ID in PROBE_LABELS_DOC_EXTRAS must
  // actually appear in the docs row.  An entry that doesn't appear in docs is
  // unnecessary — the suppression can never be triggered.
  if (docExtras.size > 0) {
    const staleExtras = [...docExtras].filter((id) => !docIds.has(id)).sort();
    if (staleExtras.length > 0) {
      docExtrasStaleFailures.push({
        suite:       suiteName,
        file:        filePath.replace(ROOT + '/', ''),
        staleExtras,
        docIds:      [...docIds].sort(),
      });
    }
  }

  // Advisory (non-failing): warn when PROBE_LABELS_DOC_EXTRAS is used.
  // The preferred fix is to give each probe a distinct label so no suppression
  // is needed.
  if (docExtras.size > 0) {
    docExtrasWarn.push({
      suite:     suiteName,
      file:      filePath.replace(ROOT + '/', ''),
      extraIds:  [...docExtras].sort(),
    });
  }

  const stale = [...docIds].filter((id) => !runIds.has(id) && !docExtras.has(id)).sort();
  if (stale.length > 0) {
    reverseFailures.push({
      suite:  suiteName,
      file:   filePath.replace(ROOT + '/', ''),
      stale,
      docIds: [...docIds].sort(),
      runIds: [...runIds].sort(),
    });
  }

  checked++;
}

// ---------------------------------------------------------------------------
// Report warnings (non-failing) for suites with doc probes but no PROBE_LABELS
// ---------------------------------------------------------------------------

if (noArrayWarn.length > 0) {
  console.warn(
    `⚠️   suite-probe-counts: ${noArrayWarn.length} suite` +
    `${noArrayWarn.length === 1 ? '' : 's'} document` +
    `${noArrayWarn.length === 1 ? 's' : ''} probe callouts in TEST_SUITES.md` +
    ` but ${noArrayWarn.length === 1 ? 'its' : 'their'} test file` +
    `${noArrayWarn.length === 1 ? '' : 's'} lack a PROBE_LABELS array` +
    ` (drift cannot be detected):\n`,
  );
  for (const { suite, file, docIds } of noArrayWarn) {
    console.warn(`  ${suite}  (${file})`);
    console.warn(`    Documented probes : ${docIds.join(', ')}`);
    console.warn(
      `    Fix: add a PROBE_LABELS array to ${file}, or add this suite` +
      ` to NO_PROBE_LABELS_ALLOWLIST in scripts/check-suite-probe-counts.mjs` +
      ` with a reason comment.\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Report advisories (non-failing) for suites using PROBE_LABELS_DOC_EXTRAS
// ---------------------------------------------------------------------------

if (docExtrasWarn.length > 0) {
  console.warn(
    `ℹ️   suite-probe-counts: ${docExtrasWarn.length} suite` +
    `${docExtrasWarn.length === 1 ? '' : 's'} use` +
    `${docExtrasWarn.length === 1 ? 's' : ''} PROBE_LABELS_DOC_EXTRAS` +
    ` to suppress the reverse check for` +
    ` ${docExtrasWarn.length === 1 ? 'a doc-only alias' : 'doc-only aliases'}.\n` +
    `    Preferred fix: give each probe a distinct label so no suppression is needed.\n`,
  );
  for (const { suite, file, extraIds } of docExtrasWarn) {
    console.warn(`  ${suite}  (${file})`);
    console.warn(`    Suppressed IDs : ${extraIds.join(', ')}\n`);
  }
}

// ---------------------------------------------------------------------------
// Report failures (exit 1) for probe mismatches in either direction
// ---------------------------------------------------------------------------

const totalFailures = forwardFailures.length + reverseFailures.length + docExtrasStaleFailures.length;

if (totalFailures === 0) {
  const parts = [`all ${checked} suites with documented probes are up-to-date`];
  if (skipped > 0)              parts.push(`${skipped} skipped (no probe callouts in docs or file not found)`);
  if (allowlisted > 0)          parts.push(`${allowlisted} allowlisted (no PROBE_LABELS array — see NO_PROBE_LABELS_ALLOWLIST)`);
  if (noArrayWarn.length > 0)   parts.push(`${noArrayWarn.length} warned (no PROBE_LABELS array — not in allowlist)`);
  if (docExtrasWarn.length > 0) parts.push(`${docExtrasWarn.length} advisory (PROBE_LABELS_DOC_EXTRAS used — prefer distinct labels)`);
  console.log(`✅  suite-probe-counts: ${parts.join('; ')}`);
  process.exit(0);
}

if (forwardFailures.length > 0) {
  console.error(
    `❌  suite-probe-counts: ${forwardFailures.length} suite` +
    `${forwardFailures.length === 1 ? '' : 's'} ` +
    `${forwardFailures.length === 1 ? 'has a probe' : 'have probes'} in the test` +
    ` file not mentioned in docs/TEST_SUITES.md:\n`,
  );

  for (const { suite, file, undoc, docIds, runIds } of forwardFailures) {
    console.error(`  ${suite}  (${file})`);
    console.error(`    Documented probes : ${docIds.join(', ')}`);
    console.error(`    Probes in test    : ${runIds.join(', ')}`);
    console.error(`    Missing from docs : ${undoc.join(', ')}\n`);
  }

  console.error(
    'Update the matching rows in docs/TEST_SUITES.md to include every probe\n' +
    "label present in the suite's test file.\n",
  );
}

if (reverseFailures.length > 0) {
  console.error(
    `❌  suite-probe-counts: ${reverseFailures.length} suite` +
    `${reverseFailures.length === 1 ? '' : 's'} ` +
    `${reverseFailures.length === 1 ? 'has a probe' : 'have probes'} documented in` +
    ` docs/TEST_SUITES.md that no longer exist in the test file:\n`,
  );

  for (const { suite, file, stale, docIds, runIds } of reverseFailures) {
    console.error(`  ${suite}  (${file})`);
    console.error(`    Documented probes : ${docIds.join(', ')}`);
    console.error(`    Probes in test    : ${runIds.join(', ')}`);
    console.error(`    Stale in docs     : ${stale.join(', ')}\n`);
  }

  console.error(
    'Either remove the stale probe IDs from the matching rows in\n' +
    "docs/TEST_SUITES.md, or add them back to the suite's PROBE_LABELS array.\n" +
    'If a doc ID is intentionally a finer-grained alias for an existing label,\n' +
    "add it to a PROBE_LABELS_DOC_EXTRAS = ['<id>'] constant in the test file.\n",
  );
}

if (docExtrasStaleFailures.length > 0) {
  console.error(
    `❌  suite-probe-counts: ${docExtrasStaleFailures.length} suite` +
    `${docExtrasStaleFailures.length === 1 ? '' : 's'} ` +
    `${docExtrasStaleFailures.length === 1 ? 'has' : 'have'} unnecessary` +
    ` PROBE_LABELS_DOC_EXTRAS entries — the suppressed IDs do not appear` +
    ` in docs/TEST_SUITES.md and can never be triggered:\n`,
  );

  for (const { suite, file, staleExtras, docIds } of docExtrasStaleFailures) {
    console.error(`  ${suite}  (${file})`);
    console.error(`    Documented probes       : ${docIds.join(', ')}`);
    console.error(`    Unnecessary suppressions: ${staleExtras.join(', ')}\n`);
  }

  console.error(
    'Remove the listed IDs from the PROBE_LABELS_DOC_EXTRAS array in each\n' +
    'test file above.  Only IDs that genuinely appear in the docs row as\n' +
    'bold **(X)** callouts should be listed there.\n',
  );
}

process.exit(1);
