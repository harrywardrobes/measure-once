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
 * Suites are skipped when:
 *   - The docs row has no bold **(X)** probe callouts, OR
 *   - The test file cannot be located from package.json scripts, OR
 *   - The test file does not contain a PROBE_LABELS array.
 *
 * Run via:  npm run test:suite-probe-counts
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

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

const failures  = [];
let   checked   = 0;
let   skipped   = 0;

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
    // File does not use a PROBE_LABELS array — cannot compare reliably, skip.
    skipped++;
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

if (failures.length === 0) {
  console.log(
    `✅  suite-probe-counts: all ${checked} suites with documented probes are` +
    ` up-to-date (${skipped} skipped — no probe callouts in docs or no` +
    ` PROBE_LABELS array found in test file)`,
  );
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
