#!/usr/bin/env node
/**
 * scripts/check-ci-doc-sync.mjs
 *
 * Static lint: every `test:*:ci` entry present in scripts/run-ci.mjs must
 * have a matching row in the "Suite reference" table in docs/TEST_SUITES.md.
 * Specifically targets the `:ci`-suffixed suites — the heavier integration /
 * database-backed suites — and verifies each has been documented before it
 * can be enrolled in the automated CI pipeline.
 *
 * Strips the `:ci` suffix before looking up the docs row, so
 * `test:foo:ci` must match a `| \`test:foo\` |` row in the table.
 *
 * Fails with a clear error message when any `:ci` suite is missing from
 * the docs so undocumented suites are caught automatically on every CI pass.
 *
 * Run via:  npm run test:ci-doc-sync
 *
 * This script is referenced from the CI runner files so contributors know
 * that documentation coverage for :ci suites is enforced automatically —
 * see the comment at the top of scripts/run-ci.mjs.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Extract every `test:*:ci` base name from run-ci.mjs STEPS.
 * Handles both plain string entries ('test:foo:ci') and object entries
 * ({ script: 'test:foo:ci', ... }).  Strips the ':ci' suffix so the result
 * is always the canonical base name used in the docs table.
 */
function extractCiSuites(filePath) {
  const src = readFileSync(filePath, 'utf8');
  const found = new Set();
  for (const m of src.matchAll(/'(test:[^']+:ci)'/g)) {
    found.add(m[1].replace(/:ci$/, ''));
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

const runnerFile = join(ROOT, 'scripts', 'run-ci.mjs');
const docsFile   = join(ROOT, 'docs', 'TEST_SUITES.md');

const ciSuites         = extractCiSuites(runnerFile);
const documentedSuites = extractDocumentedSuites(docsFile);

const missing = [...ciSuites].filter((s) => !documentedSuites.has(s)).sort();

if (missing.length === 0) {
  console.log(
    `✅  ci-doc-sync: all ${ciSuites.size} test:*:ci suites in` +
    ` scripts/run-ci.mjs have a matching row in docs/TEST_SUITES.md`,
  );
  process.exit(0);
}

console.error(
  `❌  ci-doc-sync: ${missing.length} test:*:ci ` +
  `${missing.length === 1 ? 'suite' : 'suites'} enrolled in ` +
  `scripts/run-ci.mjs but missing from docs/TEST_SUITES.md:\n`,
);
for (const s of missing) {
  console.error(`   - ${s}`);
}
console.error(
  '\nAdd a row for each missing suite to the "Suite reference" table in' +
  ' docs/TEST_SUITES.md before enrolling it in CI.\n',
);
process.exit(1);
