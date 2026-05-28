'use strict';
// test/hubspot-credential-audit/run.js
//
// Integration test: PATCH and DELETE /api/admin/hubspot-credentials write
// admin_audit_log rows with the correct action_type, actor email, and details.
//
// Verifies:
//   (A) Auth gating — member gets 403 for PATCH and DELETE.
//   (B) PATCH /api/admin/hubspot-credentials → set_hubspot_credential row in
//       admin_audit_log with admin_email = actor, details = 'key=<name>'.
//   (C) DELETE /api/admin/hubspot-credentials/:key → clear_hubspot_credential
//       row in admin_audit_log with admin_email = actor, details = 'key=<name>'.
//   (D) All three valid credential keys (access_token, app_id, client_secret)
//       produce audit rows for both operations.
//   (E) Validation errors (bad key / empty value) do NOT produce audit rows.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:hubspot-credential-audit
//   PRIVTEST_ALLOW_SHARED_DB=1    npm run test:hubspot-credential-audit

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
  BASE,
} = require('../privileges/harness');

require('dotenv').config();

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'hubspot-credential-audit.md'
);

// ── helpers ───────────────────────────────────────────────────────────────────

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
    `# hubspot-credential-audit test report`,
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

// ── audit log query ───────────────────────────────────────────────────────────

// Returns the most-recent admin_audit_log row matching the given criteria, or
// null if none found.
async function findAuditRow(pool, { actionType, adminEmail, details }) {
  const r = await pool.query(
    `SELECT id, acted_at, admin_email, action_type, target_email, details
     FROM admin_audit_log
     WHERE action_type = $1
       AND admin_email = $2
       AND details     = $3
     ORDER BY acted_at DESC
     LIMIT 1`,
    [actionType, adminEmail, details]
  );
  return r.rows[0] || null;
}

// Count audit rows since a point in time (to verify no new rows were written).
async function countAuditRowsSince(pool, { actionType, since }) {
  const r = await pool.query(
    `SELECT COUNT(*) AS n
     FROM admin_audit_log
     WHERE action_type = $1
       AND acted_at > $2`,
    [actionType, since]
  );
  return parseInt(r.rows[0].n, 10);
}

// ── main ──────────────────────────────────────────────────────────────────────

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
      + '    Set DATABASE_URL_TEST=<disposable> or PRIVTEST_ALLOW_SHARED_DB=1.\n'
    );
    process.exit(2);
  }

  const runId = Math.random().toString(36).slice(2, 8);
  console.log(`\n  hubspot-credential-audit test  run=${runId}`);
  console.log(`  DB: ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);

  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  admin=${users.admin.email}  member=${users.member.email}`);

  const { child, logBuf } = spawnServer();
  let exited = false;
  child.on('exit', () => { exited = true; });

  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    writeReport(runId);
    process.exit(code);
  };

  process.on('SIGINT',  () => cleanupAndExit(130));
  process.on('SIGTERM', () => cleanupAndExit(130));
  process.on('uncaughtException',  (e) => { console.error('Uncaught:', e);  cleanupAndExit(2); });
  process.on('unhandledRejection', (e) => { console.error('Unhandled:', e); cleanupAndExit(2); });

  try {
    await waitForServer();
    await resetRateLimitStore(pool);
    console.log(`  Server up at ${BASE}`);
  } catch (e) {
    console.error('Server boot failed:', e.message);
    console.error(logBuf.join('').slice(-2000));
    await cleanupAndExit(2);
    return;
  }

  const adminClient  = await login(users.admin.email, PASSWORD);
  const memberClient = await login(users.member.email, PASSWORD);

  // ── (A) Auth gating ───────────────────────────────────────────────────────

  {
    const r = await memberClient.patch('/api/admin/hubspot-credentials', {
      key: 'access_token',
      value: 'test-token-value',
    });
    record(
      'Auth: member PATCH gets 403',
      '403',
      `${r.status}`,
      r.status === 403,
    );
  }

  {
    const r = await memberClient.delete('/api/admin/hubspot-credentials/access_token');
    record(
      'Auth: member DELETE gets 403',
      '403',
      `${r.status}`,
      r.status === 403,
    );
  }

  // ── (B) PATCH → set_hubspot_credential audit log ──────────────────────────

  const credKeys = ['access_token', 'app_id', 'client_secret'];

  for (const key of credKeys) {
    const before = new Date();
    const r = await adminClient.patch('/api/admin/hubspot-credentials', {
      key,
      value: `privtest-${runId}-${key}-value`,
    });
    record(
      `PATCH ${key}: response status 200`,
      '200',
      `${r.status}`,
      r.status === 200,
    );

    const row = await findAuditRow(pool, {
      actionType: 'set_hubspot_credential',
      adminEmail: users.admin.email,
      details:    `key=${key}`,
    });

    record(
      `PATCH ${key}: audit row action_type=set_hubspot_credential`,
      `set_hubspot_credential row with details=key=${key}`,
      row ? `found (id=${row.id})` : 'NOT FOUND',
      !!row,
    );

    if (row) {
      record(
        `PATCH ${key}: audit row admin_email matches actor`,
        users.admin.email,
        row.admin_email,
        row.admin_email === users.admin.email,
      );
      record(
        `PATCH ${key}: audit row details matches key`,
        `key=${key}`,
        row.details,
        row.details === `key=${key}`,
      );
      record(
        `PATCH ${key}: audit row target_email is null (no contact target)`,
        'null',
        String(row.target_email),
        row.target_email === null,
      );
      const withinWindow = new Date(row.acted_at) >= before;
      record(
        `PATCH ${key}: audit row acted_at is recent`,
        `>= ${before.toISOString()}`,
        new Date(row.acted_at).toISOString(),
        withinWindow,
      );
    }
  }

  // ── (C) DELETE → clear_hubspot_credential audit log ───────────────────────

  for (const key of credKeys) {
    const before = new Date();
    const r = await adminClient.delete(`/api/admin/hubspot-credentials/${key}`);
    record(
      `DELETE ${key}: response status 200`,
      '200',
      `${r.status}`,
      r.status === 200,
    );

    const row = await findAuditRow(pool, {
      actionType: 'clear_hubspot_credential',
      adminEmail: users.admin.email,
      details:    `key=${key}`,
    });

    record(
      `DELETE ${key}: audit row action_type=clear_hubspot_credential`,
      `clear_hubspot_credential row with details=key=${key}`,
      row ? `found (id=${row.id})` : 'NOT FOUND',
      !!row,
    );

    if (row) {
      record(
        `DELETE ${key}: audit row admin_email matches actor`,
        users.admin.email,
        row.admin_email,
        row.admin_email === users.admin.email,
      );
      record(
        `DELETE ${key}: audit row details matches key`,
        `key=${key}`,
        row.details,
        row.details === `key=${key}`,
      );
      record(
        `DELETE ${key}: audit row target_email is null`,
        'null',
        String(row.target_email),
        row.target_email === null,
      );
      const withinWindow = new Date(row.acted_at) >= before;
      record(
        `DELETE ${key}: audit row acted_at is recent`,
        `>= ${before.toISOString()}`,
        new Date(row.acted_at).toISOString(),
        withinWindow,
      );
    }
  }

  // ── (E) Validation errors do NOT produce audit rows ───────────────────────

  {
    const badKeyBefore = new Date();
    const r = await adminClient.patch('/api/admin/hubspot-credentials', {
      key:   'invalid_key_name',
      value: 'some-value',
    });
    record(
      'Validation: PATCH with invalid key → 400',
      '400',
      `${r.status}`,
      r.status === 400,
    );

    // Wait a moment, then confirm no audit row was written
    await new Promise(res => setTimeout(res, 200));
    const count = await countAuditRowsSince(pool, {
      actionType: 'set_hubspot_credential',
      since: badKeyBefore,
    });
    // The only set_hubspot_credential rows produced should be from the valid
    // key tests above (which ran before badKeyBefore).  Zero means none for
    // this invalid-key attempt.
    record(
      'Validation: PATCH with invalid key → no audit row written',
      '0 new audit rows',
      `${count} new audit rows`,
      count === 0,
    );
  }

  {
    const emptyValBefore = new Date();
    const r = await adminClient.patch('/api/admin/hubspot-credentials', {
      key:   'access_token',
      value: '   ',
    });
    record(
      'Validation: PATCH with blank value → 400',
      '400',
      `${r.status}`,
      r.status === 400,
    );

    await new Promise(res => setTimeout(res, 200));
    const count = await countAuditRowsSince(pool, {
      actionType: 'set_hubspot_credential',
      since: emptyValBefore,
    });
    record(
      'Validation: PATCH with blank value → no audit row written',
      '0 new audit rows',
      `${count} new audit rows`,
      count === 0,
    );
  }

  {
    const badDelBefore = new Date();
    const r = await adminClient.delete('/api/admin/hubspot-credentials/not_a_real_key');
    record(
      'Validation: DELETE with invalid key → 400',
      '400',
      `${r.status}`,
      r.status === 400,
    );

    await new Promise(res => setTimeout(res, 200));
    const count = await countAuditRowsSince(pool, {
      actionType: 'clear_hubspot_credential',
      since: badDelBefore,
    });
    record(
      'Validation: DELETE with invalid key → no audit row written',
      '0 new audit rows',
      `${count} new audit rows`,
      count === 0,
    );
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok).length;
  console.log(`\n  ${passed} passed, ${failed} failed`);

  await cleanupAndExit(failed > 0 ? 1 : 0);
}

main();
