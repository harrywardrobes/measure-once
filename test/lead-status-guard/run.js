'use strict';
// test/lead-status-guard/run.js
//
// Unit test for the lead-status-guard module's cache invalidation behaviour.
//
// Verifies:
//   (A) assertLeadStatusKey passes when the key exists (cache warm path)
//   (B) invalidateLeadStatusCache() forces a DB re-fetch so the next
//       assertLeadStatusKey call throws LEAD_STATUS_REMOVED after the row
//       has been deleted from lead_status_config
//
// Does NOT spawn an Express server — it exercises the module directly.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:lead-status-guard
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:lead-status-guard

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

require('dotenv').config();

const PROBE_LABELS = [
  '(A) assertLeadStatusKey passes when the key exists (cache warm)',
  '(B) assertLeadStatusKey throws LEAD_STATUS_REMOVED after invalidation',
];

const REPORT_PATH = path.join(__dirname, '..', '..', 'test-results', 'lead-status-guard.md');

const TEST_KEY   = `privtest_guard_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const TEST_LABEL = 'PrivTest Guard Status';

const findings = [];
function record(name, expected, observed, ok, detail = '') {
  findings.push({ name, expected, observed, ok, detail });
  const mark = ok ? '  ✓' : '  ✗';
  console.log(`${mark}  ${name}`);
  if (!ok) {
    console.log(`     expected : ${expected}`);
    console.log(`     observed : ${observed}`);
    if (detail) console.log(`     detail   : ${detail}`);
  }
}

function writeReport(runId) {
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok).length;
  const rows = findings.map(f =>
    `| ${f.ok ? '✅' : '❌'} | ${f.name} | ${f.expected} | ${f.observed} |`
  ).join('\n');
  const md = [
    `# lead-status-guard test report`,
    ``,
    `run: \`${runId}\`  date: ${new Date().toISOString()}`,
    ``,
    `**${passed} passed / ${failed} failed**`,
    ``,
    `| | Test | Expected | Observed |`,
    `|---|---|---|---|`,
    rows,
  ].join('\n');
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, md, 'utf8');
  console.log(`\n  Report written to ${REPORT_PATH}`);
}

async function purgeFixture(pool) {
  try {
    await pool.query(`DELETE FROM lead_status_config WHERE key = $1`, [TEST_KEY]);
  } catch (_) {}
}

async function main() {
  const hasTestDb   = !!process.env.DATABASE_URL_TEST;
  const allowShared = process.env.PRIVTEST_ALLOW_SHARED_DB === '1';
  const connStr     = process.env.DATABASE_URL_TEST || process.env.DATABASE_URL;

  if (!connStr) {
    console.error('DATABASE_URL_TEST (preferred) or DATABASE_URL is required.');
    process.exit(2);
  }
  if (!hasTestDb && !allowShared) {
    console.error(
      '\n  ✘ Refuses to run against the shared DATABASE_URL by default.\n'
      + '    Set DATABASE_URL_TEST=<disposable> or PRIVTEST_ALLOW_SHARED_DB=1.\n',
    );
    process.exit(2);
  }

  const runId = Math.random().toString(36).slice(2, 8);
  console.log(`\n  lead-status-guard test  run=${runId}  key=${TEST_KEY}`);
  console.log(`  DB: ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  // Point lead-status-guard at the test DB by setting DATABASE_URL before
  // the module is first required (it creates its Pool at load time).
  process.env.DATABASE_URL = connStr;

  const pool = new Pool({ connectionString: connStr });

  const cleanupAndExit = async (code) => {
    try { await purgeFixture(pool); } catch (_) {}
    await pool.end().catch(() => {});
    writeReport(runId);
    process.exit(code);
  };

  process.on('SIGINT',  () => cleanupAndExit(130));
  process.on('SIGTERM', () => cleanupAndExit(130));
  process.on('uncaughtException',  (e) => { console.error('Uncaught:', e);  cleanupAndExit(2); });
  process.on('unhandledRejection', (e) => { console.error('Unhandled:', e); cleanupAndExit(2); });

  await purgeFixture(pool);

  // Require AFTER setting DATABASE_URL so the module's Pool uses the test DB.
  const { assertLeadStatusKey, invalidateLeadStatusCache } = require('../../lead-status-guard');

  // Ensure the cache is cold before starting.
  invalidateLeadStatusCache();

  // ── Insert the test status row ────────────────────────────────────────────
  await pool.query(
    `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales)
     VALUES ($1, $2, 999, FALSE)
     ON CONFLICT (key) DO NOTHING`,
    [TEST_KEY, TEST_LABEL],
  );
  console.log(`  Inserted test row: key=${TEST_KEY}`);

  // ── (A) assertLeadStatusKey passes when the key exists ───────────────────
  {
    let threw = false;
    let errCode = null;
    try {
      await assertLeadStatusKey(TEST_KEY);
    } catch (e) {
      threw = true;
      errCode = e.code;
    }
    record(
      '(A) assertLeadStatusKey passes for existing key (cache warm)',
      'no throw',
      threw ? `threw code=${errCode}` : 'no throw',
      !threw,
    );
  }

  // ── Delete the row from the DB ────────────────────────────────────────────
  await pool.query(`DELETE FROM lead_status_config WHERE key = $1`, [TEST_KEY]);
  console.log(`  Deleted test row from DB; calling invalidateLeadStatusCache()`);

  // ── (B) After invalidation the next call re-fetches and throws ────────────
  {
    invalidateLeadStatusCache();

    let threw = false;
    let errCode = null;
    let statusCode = null;
    try {
      await assertLeadStatusKey(TEST_KEY);
    } catch (e) {
      threw = true;
      errCode = e.code;
      statusCode = e.statusCode;
    }
    record(
      '(B) assertLeadStatusKey throws LEAD_STATUS_REMOVED after invalidation',
      'code=LEAD_STATUS_REMOVED statusCode=422',
      threw ? `code=${errCode} statusCode=${statusCode}` : 'no throw',
      threw && errCode === 'LEAD_STATUS_REMOVED' && statusCode === 422,
    );
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok).length;
  console.log(`\n  ${passed} passed, ${failed} failed`);

  await cleanupAndExit(failed > 0 ? 1 : 0);
}

main();
