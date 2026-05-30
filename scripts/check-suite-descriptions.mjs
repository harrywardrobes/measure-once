#!/usr/bin/env node
/**
 * scripts/check-suite-descriptions.mjs
 *
 * Static lint: every `test:*` entry present in scripts/run-ci.mjs must also
 * have a matching row in docs/TEST_SUITES.md.  Fails with a clear error message
 * when any suite is undocumented so drift is caught automatically on every CI
 * pass.
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

const runnerFile = join(ROOT, 'scripts', 'run-ci.mjs');
const docsFile   = join(ROOT, 'docs', 'TEST_SUITES.md');

const stepSuites       = extractStepsFromRunner(runnerFile);
const documentedSuites = extractDocumentedSuites(docsFile);

const missing = [...stepSuites].filter((s) => !documentedSuites.has(s)).sort();

if (missing.length === 0) {
  console.log(
    `✅  suite-descriptions: all ${stepSuites.size} test suites in` +
    ` run-ci.mjs have a matching row in docs/TEST_SUITES.md`,
  );
  process.exit(0);
}

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
process.exit(1);
