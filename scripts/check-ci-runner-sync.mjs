#!/usr/bin/env node
/**
 * scripts/check-ci-runner-sync.mjs
 *
 * Static lint: every `test:*:ci` entry present in scripts/run-ci.mjs must
 * also appear in scripts/run-ci-parallel.mjs, and vice-versa.  Fails with a
 * clear error message when any entry is missing so drift between the two
 * runners is caught automatically on every CI pass.
 *
 * Run via:  npm run test:ci-runner-sync
 *
 * This script is referenced from both runner files so contributors know
 * that drift is caught automatically — see the comment at the top of each.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Scan a source file for every single-quoted `test:...:ci` string literal
 * and return them as a Set.  Matches both plain string entries and entries
 * inside object literals ({ script: 'test:...:ci', ... }).
 */
function extractCiEntries(filePath) {
  const src = readFileSync(filePath, 'utf8');
  const found = new Set();
  for (const m of src.matchAll(/'(test:[^']+:ci)'/g)) {
    found.add(m[1]);
  }
  return found;
}

const seqFile = join(ROOT, 'scripts', 'run-ci.mjs');
const parFile = join(ROOT, 'scripts', 'run-ci-parallel.mjs');

const seqEntries = extractCiEntries(seqFile);
const parEntries = extractCiEntries(parFile);

const missingFromParallel = [...seqEntries].filter((e) => !parEntries.has(e)).sort();
const missingFromSequential = [...parEntries].filter((e) => !seqEntries.has(e)).sort();

let failed = false;

if (missingFromParallel.length > 0) {
  failed = true;
  console.error(
    `❌  ci-runner-sync: ${missingFromParallel.length} test:*:ci ` +
    `${missingFromParallel.length === 1 ? 'entry' : 'entries'} present in ` +
    `scripts/run-ci.mjs but missing from scripts/run-ci-parallel.mjs:\n`,
  );
  for (const e of missingFromParallel) {
    console.error(`   - ${e}`);
  }
  console.error(
    '\nAdd the missing entries to the appropriate suite list ' +
    '(STATIC_SUITES or DB_SUITES) in scripts/run-ci-parallel.mjs.\n',
  );
}

if (missingFromSequential.length > 0) {
  failed = true;
  console.error(
    `❌  ci-runner-sync: ${missingFromSequential.length} test:*:ci ` +
    `${missingFromSequential.length === 1 ? 'entry' : 'entries'} present in ` +
    `scripts/run-ci-parallel.mjs but missing from scripts/run-ci.mjs:\n`,
  );
  for (const e of missingFromSequential) {
    console.error(`   - ${e}`);
  }
  console.error(
    '\nAdd the missing entries to the appropriate position in ' +
    'scripts/run-ci.mjs.\n',
  );
}

if (!failed) {
  console.log(
    `✅  ci-runner-sync: all ${seqEntries.size} test:*:ci entries are ` +
    `present in both run-ci.mjs and run-ci-parallel.mjs`,
  );
  process.exit(0);
}

process.exit(1);
