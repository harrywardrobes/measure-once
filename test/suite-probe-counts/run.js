'use strict';
// test/suite-probe-counts/run.js
//
// Meta-test: verifies that scripts/check-suite-probe-counts.mjs correctly
// emits the PROBE_LABELS_DOC_EXTRAS advisory when a test file declares that
// constant, and stays silent (no advisory) when the constant is absent.
//
// Strategy: for each scenario, build a minimal synthetic fixture in a temp
// directory that has its own docs/TEST_SUITES.md, package.json, and a test
// file, then copy the real script there so ROOT (derived from import.meta.url)
// resolves to the fixture root.  Run the copy as a subprocess and assert the
// combined stdout+stderr contains (or does not contain) the advisory text.
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

// ── helpers ───────────────────────────────────────────────────────────────────

function buildFixture(docsSrc, synthSrc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-probe-counts-'));

  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'docs', 'TEST_SUITES.md'), docsSrc, 'utf8');

  fs.writeFileSync(path.join(dir, 'package.json'), FIXTURE_PKG, 'utf8');

  fs.mkdirSync(path.join(dir, 'test', 'synth'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'test', 'synth', 'run.js'), synthSrc, 'utf8');

  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(SCRIPT_SRC, path.join(dir, 'scripts', 'check-suite-probe-counts.mjs'));

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
    name:        'advisory fires when PROBE_LABELS_DOC_EXTRAS is present',
    docsSrc:     DOCS_WITH_ALIAS,
    synthSrc:    SYNTH_WITH_EXTRAS,
    expectAdvisory:  true,
    expectExit0:     true,
    expectIds:       ['A2'],
  },
  {
    name:        'no advisory when PROBE_LABELS_DOC_EXTRAS is absent and probes match docs',
    docsSrc:     DOCS_WITHOUT_ALIAS,
    synthSrc:    SYNTH_WITHOUT_EXTRAS,
    expectAdvisory:  false,
    expectExit0:     true,
    expectIds:       [],
  },
];

// ── run ───────────────────────────────────────────────────────────────────────

const results = [];

for (const sc of scenarios) {
  const dir = buildFixture(sc.docsSrc, sc.synthSrc);
  let result;
  try {
    result = runScript(dir);
  } finally {
    cleanFixture(dir);
  }

  const combined = (result.stdout || '') + (result.stderr || '');
  const hasAdvisory = combined.includes('PROBE_LABELS_DOC_EXTRAS');
  const exit0       = result.status === 0;

  const pass_advisory = sc.expectAdvisory ? hasAdvisory : !hasAdvisory;
  const pass_exit     = sc.expectExit0 ? exit0 : !exit0;
  const pass_ids      = sc.expectIds.every((id) => !sc.expectAdvisory || combined.includes(id));

  const pass = pass_advisory && pass_exit && pass_ids;
  results.push({ sc, pass, pass_advisory, pass_exit, pass_ids, combined, status: result.status });
}

// ── report ────────────────────────────────────────────────────────────────────

const failures = results.filter((r) => !r.pass);
const passed   = results.length - failures.length;

const lines = [
  '# suite-probe-counts-advisory',
  '',
  'Meta-test: verifies that `check-suite-probe-counts.mjs` emits the',
  '`PROBE_LABELS_DOC_EXTRAS` advisory exactly when the constant is present,',
  'and stays silent otherwise.',
  '',
  `Ran ${results.length} scenario${results.length === 1 ? '' : 's'}.`,
  '',
  '| Scenario | advisory correct | exit 0 | suppressed IDs found | result |',
  '| --- | --- | --- | --- | --- |',
];

for (const { sc, pass, pass_advisory, pass_exit, pass_ids } of results) {
  lines.push(
    `| ${sc.name} | ${pass_advisory ? '✓' : '✗'} | ${pass_exit ? '✓' : '✗'} | ${pass_ids ? '✓' : '✗'} | ${pass ? 'PASS' : '**FAIL**'} |`,
  );
}

lines.push('');

if (failures.length === 0) {
  lines.push(`**All ${passed} scenario${passed === 1 ? '' : 's'} passed.**`);
} else {
  lines.push(`**${failures.length} scenario${failures.length === 1 ? '' : 's'} failed:**`);
  for (const { sc, pass_advisory, pass_exit, pass_ids, combined, status } of failures) {
    lines.push('');
    lines.push(`### ${sc.name}`);
    if (!pass_advisory) {
      lines.push(
        sc.expectAdvisory
          ? '- Expected advisory containing `PROBE_LABELS_DOC_EXTRAS` but it was absent from output.'
          : '- Expected no advisory but `PROBE_LABELS_DOC_EXTRAS` appeared in output.',
      );
    }
    if (!pass_exit) {
      lines.push(`- Expected exit 0 but script exited with status ${status}.`);
    }
    if (!pass_ids) {
      lines.push(`- Expected suppressed IDs [${sc.expectIds.join(', ')}] to appear in advisory output.`);
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
  for (const { sc, pass_advisory, pass_exit, pass_ids, status } of failures) {
    console.error(`  • ${sc.name}`);
    if (!pass_advisory) {
      console.error(
        sc.expectAdvisory
          ? '    advisory expected but not found in output'
          : '    advisory unexpectedly present in output',
      );
    }
    if (!pass_exit)  console.error(`    expected exit 0, got ${status}`);
    if (!pass_ids)   console.error(`    suppressed IDs [${sc.expectIds.join(', ')}] not found in output`);
  }
  process.exit(1);
}
