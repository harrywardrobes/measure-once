'use strict';
// test/suite-probe-counts/run.js
//
// Meta-test: verifies that scripts/check-suite-probe-counts.mjs correctly
// emits the PROBE_LABELS_DOC_EXTRAS advisory when a test file declares that
// constant, stays silent (no advisory) when the constant is absent, emits the
// missing-PROBE_LABELS warning when a test file has doc probe callouts but
// omits the PROBE_LABELS array entirely, fails (exit 1) when
// PROBE_LABELS_DOC_EXTRAS contains an ID that is not present in the docs row,
// fails (exit 1) when PROBE_LABELS_DOC_EXTRAS contains an ID that is also
// already covered by a dedicated PROBE_LABELS entry (redundant suppression),
// AND suppresses the missing-array warning when the suite is listed in
// NO_PROBE_LABELS_ALLOWLIST.
//
// Strategy: for each scenario, build a minimal synthetic fixture in a temp
// directory that has its own docs/TEST_SUITES.md, package.json, and a test
// file, then copy the real script there so ROOT (derived from import.meta.url)
// resolves to the fixture root.  Run the copy as a subprocess and assert the
// combined stdout+stderr contains (or does not contain) the expected text.
//
// No server, no database, no Puppeteer — entirely self-contained.
//
// Usage:
//   npm run test:suite-probe-counts-advisory

const fs            = require('fs');
const os            = require('os');
const path          = require('path');
const { spawnSync } = require('child_process');

const SCRIPT_SRC = path.resolve(__dirname, '../../scripts/check-suite-probe-counts.mjs');
const OUT        = path.resolve(__dirname, '../../test-results/suite-probe-counts-advisory.md');

// ── synthetic fixture templates ───────────────────────────────────────────────

// TEST_SUITES.md row with three probe callouts: A, A2, B.
// A2 is the "doc alias" — it maps to the same implementation probe as A,
// so the test file will list it in PROBE_LABELS_DOC_EXTRAS rather than
// giving it a separate PROBE_LABELS entry.
const DOCS_WITH_ALIAS = `\
# Test Suites

| Suite | Description |
| --- | --- |
| \`test:synth\` | Synthetic suite with probes **(A)** **(A2)** **(B)**. |
`;

// TEST_SUITES.md row with only two probe callouts: A, B.  No alias — the
// PROBE_LABELS in the test file covers both IDs exactly.
const DOCS_WITHOUT_ALIAS = `\
# Test Suites

| Suite | Description |
| --- | --- |
| \`test:synth\` | Synthetic suite with probes **(A)** **(B)**. |
`;

// package.json that maps the synth suite to a test file inside the fixture dir.
const FIXTURE_PKG = JSON.stringify({
  scripts: {
    'test:synth': 'node test/synth/run.js',
  },
});

// Test file WITH PROBE_LABELS_DOC_EXTRAS.  The advisory should fire.
const SYNTH_WITH_EXTRAS = `\
'use strict';
const PROBE_LABELS = [
  '(A) first probe — also covers doc alias A2',
  '(B) second probe',
];
const PROBE_LABELS_DOC_EXTRAS = ['A2'];
`;

// Test file WITHOUT PROBE_LABELS_DOC_EXTRAS.  Probes match docs exactly,
// so no advisory and no failure should be emitted.
const SYNTH_WITHOUT_EXTRAS = `\
'use strict';
const PROBE_LABELS = [
  '(A) first probe',
  '(B) second probe',
];
`;

// Test file that omits PROBE_LABELS entirely.  The script should emit the
// non-failing missing-PROBE_LABELS warning (not a CI failure).
const SYNTH_NO_PROBE_LABELS = `\
'use strict';
// This suite intentionally omits PROBE_LABELS to exercise the warning path.
function runTests() {
  console.log('probe A done');
  console.log('probe B done');
}
runTests();
`;

// Test file with a PROBE_LABELS_DOC_EXTRAS entry ('STALE') that does NOT
// appear in the matching docs row (which only documents A and B).  The script
// should fail (exit 1) with a clear error about the unnecessary suppression.
const SYNTH_WITH_STALE_EXTRAS = `\
'use strict';
const PROBE_LABELS = [
  '(A) first probe',
  '(B) second probe',
];
const PROBE_LABELS_DOC_EXTRAS = ['STALE'];
`;

// Test file with a PROBE_LABELS_DOC_EXTRAS entry ('A') that IS already
// covered by a dedicated PROBE_LABELS entry.  The suppression is redundant
// because the ID will pass the reverse check naturally via PROBE_LABELS.
// The script should fail (exit 1) with a clear error about the redundant entry.
const SYNTH_WITH_REDUNDANT_EXTRAS = `\
'use strict';
const PROBE_LABELS = [
  '(A) first probe',
  '(B) second probe',
];
const PROBE_LABELS_DOC_EXTRAS = ['A'];
`;

// ── helpers ───────────────────────────────────────────────────────────────────

function buildFixture(docsSrc, synthSrc, { allowlistSuites = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-probe-counts-'));

  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'docs', 'TEST_SUITES.md'), docsSrc, 'utf8');

  fs.writeFileSync(path.join(dir, 'package.json'), FIXTURE_PKG, 'utf8');

  fs.mkdirSync(path.join(dir, 'test', 'synth'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'test', 'synth', 'run.js'), synthSrc, 'utf8');

  fs.mkdirSync(path.join(dir, 'scripts'));
  const scriptDest = path.join(dir, 'scripts', 'check-suite-probe-counts.mjs');
  fs.copyFileSync(SCRIPT_SRC, scriptDest);

  if (allowlistSuites.length > 0) {
    const entries = allowlistSuites
      .map((s) => `  ['${s}', 'synthetic fixture for meta-test — no PROBE_LABELS by design'],`)
      .join('\n');
    let scriptSrc = fs.readFileSync(scriptDest, 'utf8');
    scriptSrc = scriptSrc.replace(
      /const NO_PROBE_LABELS_ALLOWLIST = new Map\(\[[\s\S]*?\]\);/,
      `const NO_PROBE_LABELS_ALLOWLIST = new Map([\n${entries}\n]);`,
    );
    fs.writeFileSync(scriptDest, scriptSrc, 'utf8');
  }

  return dir;
}

function runScript(fixtureDir) {
  const scriptPath = path.join(fixtureDir, 'scripts', 'check-suite-probe-counts.mjs');
  return spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    timeout: 15_000,
  });
}

function cleanFixture(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── scenarios ─────────────────────────────────────────────────────────────────

const scenarios = [
  {
    name:                      'advisory fires when PROBE_LABELS_DOC_EXTRAS is present',
    docsSrc:                   DOCS_WITH_ALIAS,
    synthSrc:                  SYNTH_WITH_EXTRAS,
    expectAdvisory:            true,
    expectMissingWarn:         false,
    expectExit0:               true,
    expectIds:                 ['A2'],
    expectStaleExtrasFail:     false,
    expectRedundantExtrasFail: false,
  },
  {
    name:                      'no advisory when PROBE_LABELS_DOC_EXTRAS is absent and probes match docs',
    docsSrc:                   DOCS_WITHOUT_ALIAS,
    synthSrc:                  SYNTH_WITHOUT_EXTRAS,
    expectAdvisory:            false,
    expectMissingWarn:         false,
    expectExit0:               true,
    expectIds:                 [],
    expectStaleExtrasFail:     false,
    expectRedundantExtrasFail: false,
  },
  {
    name:                      'missing-PROBE_LABELS warning fires when test file omits PROBE_LABELS entirely',
    docsSrc:                   DOCS_WITHOUT_ALIAS,
    synthSrc:                  SYNTH_NO_PROBE_LABELS,
    expectAdvisory:            false,
    expectMissingWarn:         true,
    expectExit0:               true,
    expectIds:                 [],
    expectStaleExtrasFail:     false,
    expectRedundantExtrasFail: false,
  },
  {
    name:                      'stale PROBE_LABELS_DOC_EXTRAS entry causes failure when ID absent from docs',
    docsSrc:                   DOCS_WITHOUT_ALIAS,
    synthSrc:                  SYNTH_WITH_STALE_EXTRAS,
    expectAdvisory:            true,
    expectMissingWarn:         false,
    expectExit0:               false,
    expectIds:                 ['STALE'],
    expectStaleExtrasFail:     true,
    expectRedundantExtrasFail: false,
  },
  {
    name:                      'redundant PROBE_LABELS_DOC_EXTRAS entry causes failure when ID is already in PROBE_LABELS',
    docsSrc:                   DOCS_WITHOUT_ALIAS,
    synthSrc:                  SYNTH_WITH_REDUNDANT_EXTRAS,
    expectAdvisory:            true,
    expectMissingWarn:         false,
    expectExit0:               false,
    expectIds:                 ['A'],
    expectStaleExtrasFail:     false,
    expectRedundantExtrasFail: true,
  },
  {
    name:                      'missing-PROBE_LABELS warning suppressed when suite is in NO_PROBE_LABELS_ALLOWLIST',
    docsSrc:                   DOCS_WITHOUT_ALIAS,
    synthSrc:                  SYNTH_NO_PROBE_LABELS,
    allowlistSuites:           ['test:synth'],
    expectAdvisory:            false,
    expectMissingWarn:         false,
    expectExit0:               true,
    expectIds:                 [],
    expectStaleExtrasFail:     false,
    expectRedundantExtrasFail: false,
  },
];

// ── run ───────────────────────────────────────────────────────────────────────

// Phrase emitted by check-suite-probe-counts.mjs when a suite has doc probe
// callouts but its test file lacks a PROBE_LABELS array.
const MISSING_WARN_PHRASE = 'lack a PROBE_LABELS array';

// Phrase emitted when PROBE_LABELS_DOC_EXTRAS contains IDs absent from docs.
const STALE_EXTRAS_PHRASE = 'Unnecessary suppressions';

// Phrase emitted when PROBE_LABELS_DOC_EXTRAS contains IDs already covered
// by a dedicated PROBE_LABELS entry (redundant suppressions).
const REDUNDANT_EXTRAS_PHRASE = 'Redundant suppressions';

const results = [];

for (const sc of scenarios) {
  const dir = buildFixture(sc.docsSrc, sc.synthSrc, { allowlistSuites: sc.allowlistSuites || [] });
  let result;
  try {
    result = runScript(dir);
  } finally {
    cleanFixture(dir);
  }

  const combined               = (result.stdout || '') + (result.stderr || '');
  const hasAdvisory            = combined.includes('PROBE_LABELS_DOC_EXTRAS');
  const hasMissingWarn         = combined.includes(MISSING_WARN_PHRASE);
  const hasStaleExtrasFail     = combined.includes(STALE_EXTRAS_PHRASE);
  const hasRedundantExtrasFail = combined.includes(REDUNDANT_EXTRAS_PHRASE);
  const exit0                  = result.status === 0;

  const pass_advisory          = sc.expectAdvisory            ? hasAdvisory            : !hasAdvisory;
  const pass_missing_warn      = sc.expectMissingWarn         ? hasMissingWarn         : !hasMissingWarn;
  const pass_stale_extras      = sc.expectStaleExtrasFail     ? hasStaleExtrasFail     : !hasStaleExtrasFail;
  const pass_redundant_extras  = sc.expectRedundantExtrasFail ? hasRedundantExtrasFail : !hasRedundantExtrasFail;
  const pass_exit              = sc.expectExit0               ? exit0                  : !exit0;
  const pass_ids               = sc.expectIds.every((id) => combined.includes(id));

  const pass = pass_advisory && pass_missing_warn && pass_stale_extras && pass_redundant_extras && pass_exit && pass_ids;
  results.push({
    sc,
    pass, pass_advisory, pass_missing_warn, pass_stale_extras, pass_redundant_extras, pass_exit, pass_ids,
    combined,
    status: result.status,
  });
}

// ── report ────────────────────────────────────────────────────────────────────

const failures = results.filter((r) => !r.pass);
const passed   = results.length - failures.length;

const lines = [
  '# suite-probe-counts-advisory',
  '',
  'Meta-test: verifies that `check-suite-probe-counts.mjs` emits the',
  '`PROBE_LABELS_DOC_EXTRAS` advisory exactly when the constant is present,',
  'stays silent otherwise, emits the missing-PROBE_LABELS warning when a',
  'test file omits PROBE_LABELS entirely, fails when PROBE_LABELS_DOC_EXTRAS',
  'contains an ID absent from the docs row, fails when PROBE_LABELS_DOC_EXTRAS',
  'contains an ID already covered by a dedicated PROBE_LABELS entry (redundant),',
  'and suppresses the missing-array warning when the suite is in NO_PROBE_LABELS_ALLOWLIST.',
  '',
  `Ran ${results.length} scenario${results.length === 1 ? '' : 's'}.`,
  '',
  '| Scenario | advisory correct | missing-array warning correct | stale-extras failure correct | redundant-extras failure correct | exit correct | IDs found | result |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
];

for (const { sc, pass, pass_advisory, pass_missing_warn, pass_stale_extras, pass_redundant_extras, pass_exit, pass_ids } of results) {
  lines.push(
    `| ${sc.name} | ${pass_advisory ? '✓' : '✗'} | ${pass_missing_warn ? '✓' : '✗'} | ${pass_stale_extras ? '✓' : '✗'} | ${pass_redundant_extras ? '✓' : '✗'} | ${pass_exit ? '✓' : '✗'} | ${pass_ids ? '✓' : '✗'} | ${pass ? 'PASS' : '**FAIL**'} |`,
  );
}

lines.push('');

if (failures.length === 0) {
  lines.push(`**All ${passed} scenario${passed === 1 ? '' : 's'} passed.**`);
} else {
  lines.push(`**${failures.length} scenario${failures.length === 1 ? '' : 's'} failed:**`);
  for (const { sc, pass_advisory, pass_missing_warn, pass_stale_extras, pass_redundant_extras, pass_exit, pass_ids, combined, status } of failures) {
    lines.push('');
    lines.push(`### ${sc.name}`);
    if (!pass_advisory) {
      lines.push(
        sc.expectAdvisory
          ? '- Expected advisory containing `PROBE_LABELS_DOC_EXTRAS` but it was absent from output.'
          : '- Expected no advisory but `PROBE_LABELS_DOC_EXTRAS` appeared in output.',
      );
    }
    if (!pass_missing_warn) {
      lines.push(
        sc.expectMissingWarn
          ? `- Expected missing-PROBE_LABELS warning ("${MISSING_WARN_PHRASE}") but it was absent from output.`
          : `- Expected no missing-PROBE_LABELS warning but "${MISSING_WARN_PHRASE}" appeared in output.`,
      );
    }
    if (!pass_stale_extras) {
      lines.push(
        sc.expectStaleExtrasFail
          ? `- Expected stale-extras failure ("${STALE_EXTRAS_PHRASE}") but it was absent from output.`
          : `- Expected no stale-extras failure but "${STALE_EXTRAS_PHRASE}" appeared in output.`,
      );
    }
    if (!pass_redundant_extras) {
      lines.push(
        sc.expectRedundantExtrasFail
          ? `- Expected redundant-extras failure ("${REDUNDANT_EXTRAS_PHRASE}") but it was absent from output.`
          : `- Expected no redundant-extras failure but "${REDUNDANT_EXTRAS_PHRASE}" appeared in output.`,
      );
    }
    if (!pass_exit) {
      lines.push(
        sc.expectExit0
          ? `- Expected exit 0 but script exited with status ${status}.`
          : `- Expected non-zero exit but script exited with status ${status}.`,
      );
    }
    if (!pass_ids) {
      lines.push(`- Expected IDs [${sc.expectIds.join(', ')}] to appear in output.`);
    }
    lines.push('');
    lines.push('Script output:');
    lines.push('```');
    lines.push(combined.trim() || '(empty)');
    lines.push('```');
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');

// ── console summary ───────────────────────────────────────────────────────────

if (failures.length === 0) {
  console.log(`[suite-probe-counts-advisory] All ${passed} scenario${passed === 1 ? '' : 's'} passed. ✓`);
} else {
  console.error(`[suite-probe-counts-advisory] ${failures.length} scenario${failures.length === 1 ? '' : 's'} failed:`);
  for (const { sc, pass_advisory, pass_missing_warn, pass_stale_extras, pass_redundant_extras, pass_exit, pass_ids, status } of failures) {
    console.error(`  • ${sc.name}`);
    if (!pass_advisory) {
      console.error(
        sc.expectAdvisory
          ? '    advisory expected but not found in output'
          : '    advisory unexpectedly present in output',
      );
    }
    if (!pass_missing_warn) {
      console.error(
        sc.expectMissingWarn
          ? '    missing-PROBE_LABELS warning expected but not found in output'
          : '    missing-PROBE_LABELS warning unexpectedly present in output',
      );
    }
    if (!pass_stale_extras) {
      console.error(
        sc.expectStaleExtrasFail
          ? '    stale-extras failure expected but not found in output'
          : '    stale-extras failure unexpectedly present in output',
      );
    }
    if (!pass_redundant_extras) {
      console.error(
        sc.expectRedundantExtrasFail
          ? '    redundant-extras failure expected but not found in output'
          : '    redundant-extras failure unexpectedly present in output',
      );
    }
    if (!pass_exit) {
      console.error(
        sc.expectExit0
          ? `    expected exit 0, got ${status}`
          : `    expected non-zero exit, got ${status}`,
      );
    }
    if (!pass_ids)   console.error(`    IDs [${sc.expectIds.join(', ')}] not found in output`);
  }
  process.exit(1);
}
