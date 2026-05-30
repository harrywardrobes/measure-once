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
 *   4. Compares them against the probe IDs documented in TEST_SUITES.md.
 *
 * Fails CI with a clear message for every suite whose run.js contains a probe
 * label not yet mentioned in the docs — i.e. the documentation is lagging
 * behind the implementation.
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
 * Run via:  npm run test:suite-probe-counts
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
  // Predates the PROBE_LABELS convention; probes encoded as // (X) comments.
  ['test:substatus-hubspot-label-format', 'Probes encoded as inline comments; predates PROBE_LABELS convention.'],
  ['test:lead-status-sync',               'Probes encoded as inline comments; predates PROBE_LABELS convention.'],
  ['test:lead-status-sync-customer-detail','Probes encoded as inline comments; predates PROBE_LABELS convention.'],
  ['test:card-action-handlers',           'Probes encoded as inline comments; predates PROBE_LABELS convention.'],
  ['test:workflow-map',                   'Probes encoded as inline comments; predates PROBE_LABELS convention.'],
  ['test:masked-email-backfill',          'Probes encoded as inline comments; predates PROBE_LABELS convention.'],
  ['test:customer-info-generate-link-reuse','Probes encoded as inline comments; predates PROBE_LABELS convention.'],
  ['test:active-link-expires',            'Probes encoded as inline comments; predates PROBE_LABELS convention.'],
  ['test:customer-info-resend',           'Probes encoded as inline comments; predates PROBE_LABELS convention.'],
  ['test:projects-top-spacing',           'Probes encoded as inline comments; predates PROBE_LABELS convention.'],
  ['test:open-leads-stale-visibility',    'Probes encoded as inline comments; predates PROBE_LABELS convention.'],
  ['test:conflict-digest-settings',       'Probes encoded as inline comments; predates PROBE_LABELS convention.'],
  ['test:room-stale-banner-visibility',   'Probes encoded as inline comments; predates PROBE_LABELS convention.'],
  ['test:contacts-all-stale-fallback',    'Probes encoded as inline comments; predates PROBE_LABELS convention.'],
  ['test:contacts-stale-visibility',      'Probes encoded as inline comments; predates PROBE_LABELS convention.'],
  ['test:login',                          'Probes encoded as inline comments; predates PROBE_LABELS convention.'],
  ['test:invoice-bc-sync',               'Probes encoded as inline comments; predates PROBE_LABELS convention.'],
  ['test:nav-customise-reset',            'Probes encoded as inline comments; predates PROBE_LABELS convention.'],
  ['test:room-stale-banner',              'Probes encoded as inline comments; predates PROBE_LABELS convention.'],
  ['test:permissions-ui',                 'Probes encoded as inline comments; predates PROBE_LABELS convention.'],
  ['test:profile-google-calendar',        'Probes encoded as inline comments; predates PROBE_LABELS convention.'],
  ['test:customer-info-live-badge',       'Probes encoded as inline comments; predates PROBE_LABELS convention.'],
  ['test:visits-past-time',               'Probes encoded as inline comments; predates PROBE_LABELS convention.'],
  ['test:customers-pagination',           'Probes encoded as inline comments; predates PROBE_LABELS convention.'],
  ['test:project-contacts-dev-mode',      'Probes encoded as inline comments; predates PROBE_LABELS convention.'],
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

const failures    = [];
const noArrayWarn = [];  // suites with doc probes but no PROBE_LABELS, not in allowlist
let   checked     = 0;
let   skipped     = 0;
let   allowlisted = 0;

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

  const undoc = [...runIds].filter((id) => !docIds.has(id)).sort();
  if (undoc.length > 0) {
    failures.push({
      suite: suiteName,
      file:  filePath.replace(ROOT + '/', ''),
      undoc,
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
// Report failures (exit 1) for undocumented probes found in PROBE_LABELS
// ---------------------------------------------------------------------------

if (failures.length === 0) {
  const parts = [`all ${checked} suites with documented probes are up-to-date`];
  if (skipped > 0)     parts.push(`${skipped} skipped (no probe callouts in docs or file not found)`);
  if (allowlisted > 0) parts.push(`${allowlisted} allowlisted (no PROBE_LABELS array — see NO_PROBE_LABELS_ALLOWLIST)`);
  if (noArrayWarn.length > 0) parts.push(`${noArrayWarn.length} warned (no PROBE_LABELS array — not in allowlist)`);
  console.log(`✅  suite-probe-counts: ${parts.join('; ')}`);
  process.exit(0);
}

console.error(
  `❌  suite-probe-counts: ${failures.length} suite` +
  `${failures.length === 1 ? '' : 's'} ` +
  `${failures.length === 1 ? 'has a probe' : 'have probes'} in the test` +
  ` file not mentioned in docs/TEST_SUITES.md:\n`,
);

for (const { suite, file, undoc, docIds, runIds } of failures) {
  console.error(`  ${suite}  (${file})`);
  console.error(`    Documented probes : ${docIds.join(', ')}`);
  console.error(`    Probes in test    : ${runIds.join(', ')}`);
  console.error(`    Missing from docs : ${undoc.join(', ')}\n`);
}

console.error(
  'Update the matching rows in docs/TEST_SUITES.md to include every probe\n' +
  "label present in the suite's test file.\n",
);

process.exit(1);
