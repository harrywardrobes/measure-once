'use strict';
// test/db-editor/run.js
//
// End-to-end live test for the admin database editor (db-editor.js + the
// /api/admin/db/* surface). Mirrors the pattern in
// test/lead-status-sync/run.js and test/card-action-handlers/run.js: boot a
// disposable server via the privileges harness, exercise the API directly
// (no browser needed — this is a backend feature), write a markdown report
// to test-results/db-editor.md, and exit non-zero on any probe failure.
//
// Covers (per task #701):
//   (a) Non-admin (member) gets 403 on every /api/admin/db/* surface.
//   (b) Admin can insert / edit / delete a row on an allow-listed table
//       (lead_substatuses) and `db_editor_audit` gets exactly one matching
//       row per operation, with admin_email + before/after JSON populated.
//   (c) The API refuses any table outside the allow-list with 403, even
//       when the SQL identifier would otherwise be valid (e.g. `users`,
//       `sessions`, `password_set_tokens`).
//   (d) DELETE without the X-Confirm-Pk header (or with a mismatched
//       header) is rejected with 400.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:db-editor
//   # or against the shared DB with the privtest- prefix cleanup:
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:db-editor

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

// ── fixtures ──────────────────────────────────────────────────────────────────
// Use a synthetic lead_substatuses row scoped behind the privtest- prefix so
// cleanup is easy and we never collide with real production data. The table
// is on the db-editor allow-list (group "Pipeline") so insert/update/delete
// all flow through the editor.
const SUB_STATUS_KEY    = 'PRIVTEST_DBE';
const SUB_KEY           = 'PRIVTEST_DBE_SUB';
const SUB_LABEL_INSERT  = 'privtest db editor original';
const SUB_LABEL_UPDATE  = 'privtest db editor renamed';

// Tables that must always be rejected by the allow-list guard, even though
// they exist as real PostgreSQL tables in this project.
const FORBIDDEN_TABLES = ['users', 'sessions', 'password_set_tokens', 'db_editor_audit'];

// ── helpers ───────────────────────────────────────────────────────────────────
async function purgeFixtures(pool) {
  // Order: editor-audit purge first (free-text match), then the fixture row.
  try {
    await pool.query(
      `DELETE FROM db_editor_audit
         WHERE table_name = 'lead_substatuses'
           AND (after_data->>'status_key' = $1 OR before_data->>'status_key' = $1)`,
      [SUB_STATUS_KEY]
    );
  } catch (_) { /* table may not exist on a brand-new DB */ }
  try {
    await pool.query(
      `DELETE FROM lead_substatuses
         WHERE status_key = $1 AND substatus_key = $2`,
      [SUB_STATUS_KEY, SUB_KEY]
    );
  } catch (_) { /* table may not exist yet */ }
}

async function waitForTable(pool, name, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await pool.query(`SELECT to_regclass($1) AS t`, [name]);
    if (r.rows[0].t) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for table ${name}`);
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
      + '    Set DATABASE_URL_TEST=<disposable> or PRIVTEST_ALLOW_SHARED_DB=1.\n',
    );
    process.exit(2);
  }

  const runId = Math.random().toString(36).slice(2, 8);
  console.log(`\n  db-editor E2E  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);

  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  admin=${users.admin.email}  member=${users.member.email}`);

  const { child, logBuf } = spawnServer();
  let exited = false;
  child.on('exit', () => { exited = true; });

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

  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try {
      await purgeFixtures(pool);
      await cleanupTestData(pool);
    } catch {}
    await pool.end().catch(() => {});
    process.exit(code);
  };

  process.on('SIGINT',  () => cleanupAndExit(130));
  process.on('SIGTERM', () => cleanupAndExit(130));
  process.on('uncaughtException',  (e) => { console.error('Uncaught:', e);   cleanupAndExit(2); });
  process.on('unhandledRejection', (e) => { console.error('Unhandled:', e);  cleanupAndExit(2); });

  // ── boot test server ───────────────────────────────────────────────────────
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

  // The editor's tables / target tables are created on server boot;
  // wait for them before any requests.
  await waitForTable(pool, 'lead_substatuses');
  await waitForTable(pool, 'db_editor_audit');

  await purgeFixtures(pool);

  // ── log in as admin + member ───────────────────────────────────────────────
  const adminClient  = await login(users.admin.email,  PASSWORD);
  const memberClient = await login(users.member.email, PASSWORD);

  // ─────────────────────────────────────────────────────────────────────────
  // (a) Non-admin gets 403 on every /api/admin/db/* surface
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n  [a] Non-admin (member) is blocked from /api/admin/db/*');

  {
    const r = await memberClient.get('/api/admin/db/tables');
    record(
      'member GET /api/admin/db/tables → 403',
      'status=403',
      `status=${r.status}`,
      r.status === 403,
    );
  }
  {
    const r = await memberClient.get('/api/admin/db/lead_substatuses/rows');
    record(
      'member GET /api/admin/db/lead_substatuses/rows → 403',
      'status=403',
      `status=${r.status}`,
      r.status === 403,
    );
  }
  {
    const r = await memberClient.post('/api/admin/db/lead_substatuses/rows', {
      status_key: SUB_STATUS_KEY, substatus_key: SUB_KEY, label: 'x',
    });
    record(
      'member POST /api/admin/db/lead_substatuses/rows → 403',
      'status=403',
      `status=${r.status}`,
      r.status === 403,
    );
  }
  {
    const r = await memberClient.patch('/api/admin/db/lead_substatuses/rows/1', { label: 'x' });
    record(
      'member PATCH /api/admin/db/lead_substatuses/rows/:pk → 403',
      'status=403',
      `status=${r.status}`,
      r.status === 403,
    );
  }
  {
    const r = await memberClient.delete('/api/admin/db/lead_substatuses/rows/1', {
      headers: { 'X-Confirm-Pk': '1' },
    });
    record(
      'member DELETE /api/admin/db/lead_substatuses/rows/:pk → 403',
      'status=403',
      `status=${r.status}`,
      r.status === 403,
    );
  }
  {
    const r = await memberClient.get('/api/admin/db/audit');
    record(
      'member GET /api/admin/db/audit → 403',
      'status=403',
      `status=${r.status}`,
      r.status === 403,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // (c) Tables outside the allow-list are 403 even though the SQL identifier
  //     would be valid. Tested before (b) so any earlier admin failures do
  //     not pollute the audit counts.
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n  [c] Tables outside the allow-list are 403 for admin');

  for (const t of FORBIDDEN_TABLES) {
    const r = await adminClient.get(`/api/admin/db/${t}/rows`);
    record(
      `admin GET /api/admin/db/${t}/rows → 403 (not in allow-list)`,
      'status=403 with "allow-list" message',
      `status=${r.status} body=${JSON.stringify(r.json)}`,
      r.status === 403 && typeof r.json?.error === 'string' && /allow-list/i.test(r.json.error),
    );
  }
  {
    const r = await adminClient.post('/api/admin/db/users/rows', { email: 'x' });
    record(
      'admin POST /api/admin/db/users/rows → 403 (not in allow-list)',
      'status=403',
      `status=${r.status}`,
      r.status === 403,
    );
  }
  {
    const r = await adminClient.patch('/api/admin/db/sessions/rows/abc', { sess: '{}' }, {
      headers: { 'X-Confirm-Pk': 'abc' },
    });
    record(
      'admin PATCH /api/admin/db/sessions/rows/:pk → 403 (not in allow-list)',
      'status=403',
      `status=${r.status}`,
      r.status === 403,
    );
  }
  {
    const r = await adminClient.delete('/api/admin/db/password_set_tokens/rows/abc', {
      headers: { 'X-Confirm-Pk': 'abc' },
    });
    record(
      'admin DELETE /api/admin/db/password_set_tokens/rows/:pk → 403 (not in allow-list)',
      'status=403',
      `status=${r.status}`,
      r.status === 403,
    );
  }
  // The audit table itself is excluded entirely (it isn't in TABLES at all).
  {
    const r = await adminClient.post('/api/admin/db/db_editor_audit/rows', { op: 'insert' });
    record(
      'admin POST /api/admin/db/db_editor_audit/rows → 403 (audit table is not editable)',
      'status=403',
      `status=${r.status}`,
      r.status === 403,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // (b) Admin insert / edit / delete on an allow-listed table, with one
  //     matching audit row per op.
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n  [b] Admin insert / edit / delete on lead_substatuses');

  // GET /tables returns the allow-list and excludes forbidden tables.
  {
    const r = await adminClient.get('/api/admin/db/tables');
    const names = Array.isArray(r.json?.tables) ? r.json.tables.map(t => t.name) : [];
    const includesLs   = names.includes('lead_substatuses');
    const excludesUsrs = !names.includes('users') && !names.includes('sessions')
                       && !names.includes('password_set_tokens')
                       && !names.includes('db_editor_audit');
    record(
      'admin GET /api/admin/db/tables lists lead_substatuses and excludes auth tables',
      'lead_substatuses ∈ tables, users/sessions/password_set_tokens/db_editor_audit ∉ tables',
      `count=${names.length} lead_substatuses=${includesLs} excludesAuth=${excludesUsrs}`,
      includesLs && excludesUsrs,
    );
  }

  // INSERT
  const insertRes = await adminClient.post('/api/admin/db/lead_substatuses/rows', {
    status_key:    SUB_STATUS_KEY,
    substatus_key: SUB_KEY,
    label:         SUB_LABEL_INSERT,
    action_label:  ' ',
    sort_order:    9999,
  });
  record(
    'admin POST inserts a row on lead_substatuses',
    'status=201 with row.id set',
    `status=${insertRes.status} id=${insertRes.json?.row?.id} label=${JSON.stringify(insertRes.json?.row?.label)}`,
    insertRes.status === 201
      && insertRes.json?.row?.id
      && insertRes.json.row.status_key === SUB_STATUS_KEY
      && insertRes.json.row.label === SUB_LABEL_INSERT,
  );
  const insertedId = insertRes.json?.row?.id;
  if (!insertedId) {
    record(
      'continuation: insert returned an id',
      'numeric id from RETURNING',
      `body=${JSON.stringify(insertRes.json)}`,
      false,
      'Subsequent edit/delete probes cannot run without the inserted row.',
    );
    await writeReport(runId, findings);
    await cleanupAndExit(1);
    return;
  }

  // Audit log row for the insert.
  {
    const r = await pool.query(
      `SELECT op, admin_email, pk, before_data, after_data
         FROM db_editor_audit
        WHERE table_name = 'lead_substatuses'
          AND pk = $1
          AND op = 'insert'`,
      [String(insertedId)]
    );
    const row = r.rows[0];
    const ok = r.rowCount === 1
      && row.admin_email === users.admin.email
      && row.before_data === null
      && row.after_data
      && row.after_data.label === SUB_LABEL_INSERT;
    record(
      'db_editor_audit has exactly one matching insert row',
      'count=1 op=insert admin_email=admin before=null after.label=original',
      `count=${r.rowCount} admin=${row?.admin_email} before=${JSON.stringify(row?.before_data)} after.label=${JSON.stringify(row?.after_data?.label)}`,
      ok,
    );
  }

  // UPDATE
  const patchRes = await adminClient.patch(
    `/api/admin/db/lead_substatuses/rows/${insertedId}`,
    { label: SUB_LABEL_UPDATE },
  );
  record(
    'admin PATCH updates the row',
    'status=200 with row.label updated',
    `status=${patchRes.status} label=${JSON.stringify(patchRes.json?.row?.label)}`,
    patchRes.status === 200 && patchRes.json?.row?.label === SUB_LABEL_UPDATE,
  );

  // Audit log row for the update.
  {
    const r = await pool.query(
      `SELECT op, admin_email, pk, before_data, after_data
         FROM db_editor_audit
        WHERE table_name = 'lead_substatuses'
          AND pk = $1
          AND op = 'update'`,
      [String(insertedId)]
    );
    const row = r.rows[0];
    const ok = r.rowCount === 1
      && row.admin_email === users.admin.email
      && row.before_data?.label === SUB_LABEL_INSERT
      && row.after_data?.label  === SUB_LABEL_UPDATE;
    record(
      'db_editor_audit has exactly one matching update row',
      'count=1 op=update before.label=original after.label=renamed',
      `count=${r.rowCount} before.label=${JSON.stringify(row?.before_data?.label)} after.label=${JSON.stringify(row?.after_data?.label)}`,
      ok,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // (d) DELETE without (or with a mismatched) X-Confirm-Pk header → 400.
  //     Run before the successful delete so the row still exists.
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n  [d] DELETE requires matching X-Confirm-Pk header');

  {
    const r = await adminClient.delete(`/api/admin/db/lead_substatuses/rows/${insertedId}`);
    record(
      'admin DELETE without X-Confirm-Pk → 400',
      'status=400 with confirmation error',
      `status=${r.status} body=${JSON.stringify(r.json)}`,
      r.status === 400 && /confirm/i.test(r.json?.error || ''),
    );
  }
  {
    const r = await adminClient.delete(`/api/admin/db/lead_substatuses/rows/${insertedId}`, {
      headers: { 'X-Confirm-Pk': String(insertedId + 1) }, // wrong pk
    });
    record(
      'admin DELETE with mismatched X-Confirm-Pk → 400',
      'status=400 with confirmation error',
      `status=${r.status} body=${JSON.stringify(r.json)}`,
      r.status === 400 && /confirm/i.test(r.json?.error || ''),
    );
  }

  // The row must still exist (the failed deletes did not touch it).
  {
    const r = await pool.query(
      `SELECT id FROM lead_substatuses WHERE id = $1`,
      [insertedId]
    );
    record(
      'rejected DELETEs do not remove the row',
      'row still present',
      `present=${r.rowCount === 1}`,
      r.rowCount === 1,
    );
  }
  // No delete-op audit row should exist yet.
  {
    const r = await pool.query(
      `SELECT 1 FROM db_editor_audit
        WHERE table_name = 'lead_substatuses' AND pk = $1 AND op = 'delete'`,
      [String(insertedId)]
    );
    record(
      'rejected DELETEs write no audit row',
      'count=0 delete audit rows',
      `count=${r.rowCount}`,
      r.rowCount === 0,
    );
  }

  // Now the successful DELETE.
  const delRes = await adminClient.delete(
    `/api/admin/db/lead_substatuses/rows/${insertedId}`,
    { headers: { 'X-Confirm-Pk': String(insertedId) } },
  );
  record(
    'admin DELETE with matching X-Confirm-Pk succeeds',
    'status=200 body.ok=true',
    `status=${delRes.status} body=${JSON.stringify(delRes.json)}`,
    delRes.status === 200 && delRes.json?.ok === true,
  );

  // Audit log row for the delete.
  {
    const r = await pool.query(
      `SELECT op, admin_email, pk, before_data, after_data
         FROM db_editor_audit
        WHERE table_name = 'lead_substatuses'
          AND pk = $1
          AND op = 'delete'`,
      [String(insertedId)]
    );
    const row = r.rows[0];
    const ok = r.rowCount === 1
      && row.admin_email === users.admin.email
      && row.after_data === null
      && row.before_data?.label === SUB_LABEL_UPDATE;
    record(
      'db_editor_audit has exactly one matching delete row',
      'count=1 op=delete before.label=renamed after=null',
      `count=${r.rowCount} before.label=${JSON.stringify(row?.before_data?.label)} after=${JSON.stringify(row?.after_data)}`,
      ok,
    );
  }

  // Row is gone.
  {
    const r = await pool.query(
      `SELECT id FROM lead_substatuses WHERE id = $1`,
      [insertedId]
    );
    record(
      'successful DELETE removed the row',
      'count=0',
      `count=${r.rowCount}`,
      r.rowCount === 0,
    );
  }

  // Cross-check: exactly three audit rows for this fixture pk (insert + update + delete).
  {
    const r = await pool.query(
      `SELECT op FROM db_editor_audit
        WHERE table_name = 'lead_substatuses' AND pk = $1
        ORDER BY acted_at ASC`,
      [String(insertedId)]
    );
    const ops = r.rows.map(x => x.op).join(',');
    record(
      'db_editor_audit has exactly insert,update,delete for the fixture pk',
      'ops=insert,update,delete (count=3)',
      `ops=${ops} count=${r.rowCount}`,
      r.rowCount === 3 && ops === 'insert,update,delete',
    );
  }

  // GET /api/admin/db/audit surfaces those rows (filterable by table).
  {
    const r = await adminClient.get(
      `/api/admin/db/audit?table=lead_substatuses&pageSize=200`
    );
    const matching = Array.isArray(r.json?.rows)
      ? r.json.rows.filter(x => x.pk === String(insertedId))
      : [];
    const ops = matching.map(x => x.op).sort().join(',');
    record(
      'admin GET /api/admin/db/audit returns the fixture audit rows',
      'status=200 and ops contain delete,insert,update',
      `status=${r.status} matching=${matching.length} ops=${ops}`,
      r.status === 200 && matching.length === 3 && ops === 'delete,insert,update',
    );
  }

  // ── summary & report ──────────────────────────────────────────────────────
  const pass = findings.filter(f => f.ok).length;
  const fail = findings.filter(f => !f.ok).length;
  console.log(`\n  Results: ${pass} passed, ${fail} failed`);

  await writeReport(runId, findings);
  await cleanupAndExit(fail > 0 ? 1 : 0);
}

// ── report writer ─────────────────────────────────────────────────────────────
async function writeReport(runId, findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Admin Database Editor — E2E Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:db-editor\``,
    '',
    '## Summary',
    '',
    `- Passed: ${findings.filter(f => f.ok).length} / ${findings.length}`,
    `- Failed: ${findings.filter(f => !f.ok).length} / ${findings.length}`,
    '',
    '## Results',
    '',
    '| Result | Probe | Expected | Observed |',
    '|---|---|---|---|',
    ...findings.map(f =>
      `| ${f.ok ? 'PASS' : 'FAIL'} | ${esc(f.name)} | ${esc(f.expected)} | ${esc(f.observed)} |`,
    ),
    '',
    '## Coverage',
    '',
    '- **(a) Non-admin lockout**: a `member`-privilege session receives 403 on',
    '  GET /api/admin/db/tables, GET/POST/PATCH/DELETE',
    '  /api/admin/db/lead_substatuses/rows[/:pk], and GET /api/admin/db/audit.',
    '- **(b) Insert / edit / delete with audit**: an admin session inserts a',
    '  `lead_substatuses` row, edits its label, deletes it, and the test',
    '  asserts the `db_editor_audit` table contains exactly one matching row',
    '  per operation with the expected admin_email and before/after JSON.',
    '  A final cross-check confirms exactly three audit rows in',
    '  `insert,update,delete` order, and that `GET /api/admin/db/audit?table=…`',
    '  surfaces them.',
    '- **(c) Allow-list guard**: requests for `users`, `sessions`,',
    '  `password_set_tokens`, and `db_editor_audit` are rejected with 403',
    '  ("Table not in allow-list") on GET / POST / PATCH / DELETE — proving the',
    '  guard runs before any SQL is built, even for table names that exist as',
    '  real PostgreSQL identifiers. GET /tables also excludes them.',
    '- **(d) Delete confirmation header**: DELETE without `X-Confirm-Pk` is',
    '  rejected with 400, DELETE with a mismatched header is rejected with 400,',
    '  the row stays in the database, no delete audit row is written, and the',
    '  matching-header DELETE then succeeds.',
    '',
    '## Notes',
    '',
    '- The test server is booted via the shared privileges harness with the',
    '  same env-stripping defaults (no HUBSPOT_TOKEN, SMTP, Google or QB',
    '  credentials). The db-editor surface depends only on PostgreSQL so this',
    '  has no effect on the probes.',
    '- All synthetic rows are namespaced behind the `privtest-` / `PRIVTEST_`',
    '  prefix and the fixture row is cleaned up on exit (along with any audit',
    '  rows that reference it).',
  ];
  const outPath = path.join(dir, 'db-editor.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Report: test-results/db-editor.md`);
}

main();
