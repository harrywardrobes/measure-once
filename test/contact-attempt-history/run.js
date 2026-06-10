'use strict';

const PROBE_LABELS = [
  '(A) contact_attempt_history_log table has expected columns',
  '(B) advance-status returning 503 (no HubSpot token) leaves history log empty',
  '(C) advance-status returning 502 (fake HubSpot token → auth rejection) leaves history log empty',
];

// test/contact-attempt-history/run.js
//
// Regression guard for the contact_attempt_history_log write-ordering fix:
// verifies that a failed advance-status call (whether rejected by middleware
// or by HubSpot) does NOT insert a phantom row into contact_attempt_history_log.
//
// Probes:
//   (A) Schema: the contact_attempt_history_log table exists and carries all
//       expected columns (migration 1749200000018).
//   (B) When the server is started without HUBSPOT_TOKEN, POST advance-status
//       returns 503 (requireHubspotToken gate) and leaves the history log empty.
//       Guards the pre-fix bug where an INSERT ran before patchContactProperties.
//   (C) When HUBSPOT_TOKEN is set to a fake value (bypassing the middleware
//       gate) and a matching NO_RESPONSE key exists in lead_status_config,
//       patchContactProperties fails with a HubSpot 401, advance-status returns
//       502, and the history log is still empty.
//       Guards the specific ordering flaw: INSERT must NOT precede
//       patchContactProperties.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:contact-attempt-history
//   PRIVTEST_ALLOW_SHARED_DB=1      npm run test:contact-attempt-history

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');
const {
  spawnServer,
  waitForServer,
  seedUsers,
  cleanupTestData,
  resetRateLimitStore,
  login,
  setPool,
  PASSWORD,
} = require('../privileges/harness');

require('dotenv').config();

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'contact-attempt-history.md'
);

const FAKE_CONTACT_ID = '9999999901';
const NO_RESPONSE_KEY = 'NO_RESPONSE';

const findings = [];
function record(name, ok, detail = '') {
  findings.push({ name, ok, detail });
  const mark = ok ? '  ✓' : '  ✗';
  console.log(`${mark}  ${name}`);
  if (!ok && detail) console.log(`     detail: ${detail}`);
}

async function historyRowCount(pool, contactId) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM contact_attempt_history_log WHERE hubspot_contact_id = $1`,
    [contactId]
  );
  return r.rows[0].n;
}

async function seedTrackingRow(pool, contactId) {
  await pool.query(
    `INSERT INTO contact_attempt_tracking
       (hubspot_contact_id, call_attempted, email_sent, whatsapp_sent, updated_at)
     VALUES ($1, TRUE, TRUE, FALSE, NOW())
     ON CONFLICT (hubspot_contact_id) DO NOTHING`,
    [contactId]
  );
}

async function seedLeadStatusConfig(pool, key) {
  await pool.query(
    `INSERT INTO lead_status_config (key, label, stage_key, display_order)
     VALUES ($1, $1, 'SALES', 99)
     ON CONFLICT (key) DO NOTHING`,
    [key]
  );
}

async function purgeFixtures(pool) {
  await pool.query(
    `DELETE FROM contact_attempt_history_log WHERE hubspot_contact_id = $1`,
    [FAKE_CONTACT_ID]
  );
  await pool.query(
    `DELETE FROM contact_attempt_tracking WHERE hubspot_contact_id = $1`,
    [FAKE_CONTACT_ID]
  );
  try {
    await pool.query(
      `DELETE FROM lead_status_config WHERE key = $1`,
      [NO_RESPONSE_KEY]
    );
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
  console.log(`\n  contact-attempt-history  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);

  // ── probe (A): schema check — no server needed ──────────────────────────────
  const EXPECTED_COLS = [
    'id', 'hubspot_contact_id', 'attempted_at', 'attempted_by',
    'call_attempted', 'email_sent', 'whatsapp_sent',
  ];
  try {
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'contact_attempt_history_log'
        ORDER BY ordinal_position`,
    );
    const found = r.rows.map(row => row.column_name);
    const missing = EXPECTED_COLS.filter(c => !found.includes(c));
    record(
      '(A) contact_attempt_history_log table has expected columns',
      missing.length === 0,
      missing.length ? `missing columns: ${missing.join(', ')}` : `found: ${found.join(', ')}`,
    );
  } catch (e) {
    record(
      '(A) contact_attempt_history_log table has expected columns',
      false,
      `query failed: ${e.message}`,
    );
  }

  // ── probe (B): no token → 503, no history row ──────────────────────────────
  const { child: childB, logBuf: logBufB } = spawnServer();
  let exitedB = false;
  childB.on('exit', () => { exitedB = true; });

  let memberClient = null;
  try {
    await waitForServer();
    await resetRateLimitStore(pool);
    const users = await seedUsers(pool, runId);
    await seedTrackingRow(pool, FAKE_CONTACT_ID);

    memberClient = await login(users.member.email, PASSWORD);

    const res = await memberClient.post(
      `/api/card-actions/contact-customer/${encodeURIComponent(FAKE_CONTACT_ID)}/advance-status`,
      { target: 'no_response' },
    );

    const got503 = res.status === 503;
    const rowCount = await historyRowCount(pool, FAKE_CONTACT_ID);
    record(
      '(B) advance-status returning 503 (no HubSpot token) leaves history log empty',
      got503 && rowCount === 0,
      `status=${res.status} history_rows=${rowCount}`,
    );
  } catch (e) {
    record(
      '(B) advance-status returning 503 (no HubSpot token) leaves history log empty',
      false,
      e.message,
    );
  }

  try { if (!exitedB) childB.kill('SIGTERM'); } catch {}
  await new Promise(r => setTimeout(r, 500));

  // ── probe (C): fake token → HubSpot 401 → 502, no history row ───────────────
  // Spawn a second server instance with a fake HUBSPOT_TOKEN so requireHubspotToken
  // passes, but patchContactProperties will fail when HubSpot rejects it.
  const { child: childC, logBuf: logBufC } = spawnServer({
    extraEnv: { HUBSPOT_TOKEN: 'privtest-fake-token-for-ordering-guard' },
  });
  let exitedC = false;
  childC.on('exit', () => { exitedC = true; });

  try {
    await waitForServer();
    await resetRateLimitStore(pool);
    await seedLeadStatusConfig(pool, NO_RESPONSE_KEY);
    await seedTrackingRow(pool, FAKE_CONTACT_ID);

    const users2 = await seedUsers(pool, runId + 'c');
    const member2 = await login(users2.member.email, PASSWORD);

    // Advance with a fake token — patchContactProperties will call HubSpot and
    // get a 401 (auth rejection), causing the server to return 502.  The INSERT
    // must NOT have run, leaving history_rows = 0.
    const res = await member2.post(
      `/api/card-actions/contact-customer/${encodeURIComponent(FAKE_CONTACT_ID)}/advance-status`,
      { target: 'no_response' },
      { timeout: 20000 },
    );

    const wasError = res.status >= 500;
    const rowCount = await historyRowCount(pool, FAKE_CONTACT_ID);
    record(
      '(C) advance-status returning 502 (fake HubSpot token → auth rejection) leaves history log empty',
      wasError && rowCount === 0,
      `status=${res.status} history_rows=${rowCount}`,
    );
  } catch (e) {
    record(
      '(C) advance-status returning 502 (fake HubSpot token → auth rejection) leaves history log empty',
      false,
      e.message,
    );
  }

  try { if (!exitedC) childC.kill('SIGTERM'); } catch {}

  // ── teardown ────────────────────────────────────────────────────────────────
  await purgeFixtures(pool);
  await cleanupTestData(pool);
  await pool.end().catch(() => {});

  // ── write report ────────────────────────────────────────────────────────────
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok).length;
  const lines  = [
    '# contact-attempt-history regression test',
    '',
    `Run: ${new Date().toISOString()}`,
    '',
    '| # | Probe | Result |',
    '|---|-------|--------|',
    ...findings.map((f, i) => `| ${i + 1} | ${f.name} | ${f.ok ? '✅ PASS' : '❌ FAIL'} |`),
    '',
    `**${passed} passed, ${failed} failed**`,
  ];
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, lines.join('\n'), 'utf8');
  console.log(`\n  ${passed}/${findings.length} passed  →  ${REPORT_PATH}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(2); });
