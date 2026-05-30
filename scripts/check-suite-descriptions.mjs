#!/usr/bin/env node
/**
 * scripts/check-suite-descriptions.mjs
 *
 * Bidirectional static lint between scripts/run-ci.mjs and
 * docs/TEST_SUITES.md:
 *
 *   Forward check  — every test:* entry in run-ci.mjs STEPS must have a
 *                    matching row in the "Suite reference" table.
 *   Reverse check  — every row in that table must appear in run-ci.mjs STEPS
 *                    (or be listed in STANDALONE_SUITES below).
 *
 * Fails with a clear error message for every violation found so drift is
 * caught automatically on every CI pass.
 *
 * Run via:  npm run test:suite-descriptions
 *
 * This script is referenced from both runner files so contributors know that
 * documentation coverage is enforced automatically — see the comment at the
 * top of each.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Suites intentionally excluded from the automated CI pipeline.
 * These appear in docs/TEST_SUITES.md but are NOT run by run-ci.mjs.
 *
 * Every entry here must have a brief reason comment.  To add a new entry:
 *   1. Add the suite name and a reason comment below.
 *   2. Make sure the TEST_SUITES.md row notes that it is standalone-only.
 */
const STANDALONE_SUITES = new Set([
  // Post-build gzip-size check; requires a pre-built bundle and a cached
  // history artefact — not wired into the standard CI pipeline.
  'test:bundle-sizes',
  // Static guard for picker-cluster function duplication; kept standalone
  // by design — see the "Standalone only" note in TEST_SUITES.md.
  'test:workflow-js-no-dups',
]);

/**
 * Extract every test script base-name from run-ci.mjs STEPS.
 * Handles both plain string entries ('test:foo', 'test:foo:ci') and object
 * entries ({ script: 'test:foo', ... }).  Strips the ':ci' suffix so the
 * result is always the canonical base name used in the docs table.
 * Non-test entries (build:*, etc.) are skipped.
 */
function extractStepsFromRunner(filePath) {
  const src = readFileSync(filePath, 'utf8');
  const found = new Set();
  for (const m of src.matchAll(/'(test:[^']+)'/g)) {
    const name = m[1].replace(/:ci$/, '');
    found.add(name);
  }
  return found;
}

/**
 * Extract every documented test suite name from the first column of table
 * rows in TEST_SUITES.md.  Only rows of the form `| \`test:…\` |` are
 * considered — description prose is ignored even when it mentions other
 * script names.
 */
function extractDocumentedSuites(filePath) {
  const src = readFileSync(filePath, 'utf8');
  const found = new Set();
  for (const line of src.split('\n')) {
    const m = line.match(/^\|\s*`(test:[^`]+)`\s*\|/);
    if (m) found.add(m[1]);
  }
  return found;
}

/**
 * Return a Map from suite name to the full table-row text for every documented
 * suite in TEST_SUITES.md.  Used by the standalone-note check.
 */
function extractDocumentedSuiteRows(filePath) {
  const src = readFileSync(filePath, 'utf8');
  const rows = new Map();
  for (const line of src.split('\n')) {
    const m = line.match(/^\|\s*`(test:[^`]+)`\s*\|/);
    if (m) rows.set(m[1], line);
  }
  return rows;
}

const runnerFile = join(ROOT, 'scripts', 'run-ci.mjs');
const docsFile   = join(ROOT, 'docs', 'TEST_SUITES.md');

const stepSuites       = extractStepsFromRunner(runnerFile);
const documentedSuites = extractDocumentedSuites(docsFile);
const documentedRows   = extractDocumentedSuiteRows(docsFile);

// Forward check: every CI step must have a docs row.
const missing = [...stepSuites].filter((s) => !documentedSuites.has(s)).sort();

// Reverse check: every docs row must appear in CI (or be explicitly standalone).
const stale = [...documentedSuites]
  .filter((s) => !stepSuites.has(s) && !STANDALONE_SUITES.has(s))
  .sort();

// Allowlist staleness check: every STANDALONE_SUITES entry must have a docs row.
const deadAllowlist = [...STANDALONE_SUITES]
  .filter((s) => !documentedSuites.has(s))
  .sort();

// Standalone-note check: every STANDALONE_SUITES entry whose docs row exists
// must contain the word "Standalone" (case-insensitive) somewhere in that row.
const missingStandaloneNote = [...STANDALONE_SUITES]
  .filter((s) => {
    const row = documentedRows.get(s);
    return row !== undefined && !/standalone/i.test(row);
  })
  .sort();

if (
  missing.length === 0 &&
  stale.length === 0 &&
  deadAllowlist.length === 0 &&
  missingStandaloneNote.length === 0
) {
  console.log(
    `✅  suite-descriptions: all ${stepSuites.size} CI test suites have a` +
    ` matching row in docs/TEST_SUITES.md, and all ${documentedSuites.size}` +
    ` documented suites are either in run-ci.mjs or listed as standalone`,
  );
  process.exit(0);
}

let failed = false;

if (missing.length > 0) {
  failed = true;
  console.error(
    `❌  suite-descriptions: ${missing.length} test ` +
    `${missing.length === 1 ? 'suite' : 'suites'} present in ` +
    `scripts/run-ci.mjs but missing from docs/TEST_SUITES.md:\n`,
  );
  for (const s of missing) {
    console.error(`   - ${s}`);
  }
  console.error(
    '\nAdd a row for each missing suite to the "Suite reference" table in' +
    ' docs/TEST_SUITES.md.\n',
  );
}

if (stale.length > 0) {
  failed = true;
  console.error(
    `❌  suite-descriptions: ${stale.length} test ` +
    `${stale.length === 1 ? 'suite' : 'suites'} documented in` +
    ` docs/TEST_SUITES.md but absent from scripts/run-ci.mjs STEPS:\n`,
  );
  for (const s of stale) {
    console.error(`   - ${s}`);
  }
  console.error(
    '\nFor each stale row, do one of the following:\n' +
    '  • Add the suite to run-ci.mjs STEPS so it runs in CI, or\n' +
    '  • Add it to the STANDALONE_SUITES allowlist in' +
    ' scripts/check-suite-descriptions.mjs with a reason comment.\n',
  );
}

if (deadAllowlist.length > 0) {
  failed = true;
  console.error(
    `❌  suite-descriptions: ${deadAllowlist.length} STANDALONE_SUITES ` +
    `${deadAllowlist.length === 1 ? 'entry' : 'entries'} in ` +
    `scripts/check-suite-descriptions.mjs no longer ` +
    `${deadAllowlist.length === 1 ? 'has' : 'have'} a matching row in` +
    ` docs/TEST_SUITES.md:\n`,
  );
  for (const s of deadAllowlist) {
    console.error(`   - ${s}`);
  }
  console.error(
    '\nRemove each stale entry from the STANDALONE_SUITES set in' +
    ' scripts/check-suite-descriptions.mjs.\n',
  );
}

if (missingStandaloneNote.length > 0) {
  failed = true;
  console.error(
    `❌  suite-descriptions: ${missingStandaloneNote.length} STANDALONE_SUITES ` +
    `${missingStandaloneNote.length === 1 ? 'entry' : 'entries'} in ` +
    `scripts/check-suite-descriptions.mjs ` +
    `${missingStandaloneNote.length === 1 ? 'is' : 'are'} missing the ` +
    `"Standalone" note in its docs/TEST_SUITES.md row:\n`,
  );
  for (const s of missingStandaloneNote) {
    console.error(`   - ${s}`);
  }
  console.error(
    '\nAdd a "Standalone only" note to each suite\'s row in the' +
    ' "Suite reference" table in docs/TEST_SUITES.md.\n',
  );
}

if (failed) process.exit(1);
