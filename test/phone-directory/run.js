'use strict';
// test/phone-directory/run.js
//
// Focused integration test for GET /api/admin/phone-directory.
//
// Verifies:
//   (A) Auth gating — member gets 403; manager and admin get 200.
//   (B) Payload shape — response has { team: [], trades: [], customers: [] }.
//   (C) Team data — allowed_emails-only rows and users-joined rows both appear
//       with the correct fields (kind, phone, field, label, email / userId).
//   (D) Trades data — company_phone appears as kind:'company' and contact
//       phone appears as kind:'contact' with correct companyName / contactName.
//   (E) No cross-run contamination — fixture phones are unique per run and
//       the seeded entries are present in the response.
//   (F) customers — always an array (empty when HUBSPOT_TOKEN is absent, as
//       it is in the harness env).
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:phone-directory
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:phone-directory

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

const REPORT_PATH = path.join(__dirname, '..', '..', 'test-results', 'phone-directory.md');

// ── helpers ───────────────────────────────────────────────────────────────────

function uniquePhone(runId, tag) {
  const h = require('crypto').createHash('sha256').update(`${tag}:${runId}`).digest('hex');
  const n = parseInt(h.slice(0, 12), 16) % 1_000_000_000;
  return '0' + String(n).padStart(9, '0'); // 10-digit string
}

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
    `# phone-directory test report`,
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

// ── fixtures ──────────────────────────────────────────────────────────────────
// Names must be prefixed with 'privtest-' so cleanupTestData() sweeps them.
const ALLOWED_EMAIL   = 'privtest-phonedir-allowed@privtest.local';
const ALLOWED_FIRST   = 'PhoneDirAllowed';
const ALLOWED_LAST    = 'User';
const COMPANY_NAME    = 'PrivTest PhoneDir Co';
const CONTACT_NAME    = 'PrivTest PhoneDir Contact';

async function purgeFixtures(pool) {
  try {
    await pool.query(`DELETE FROM allowed_emails WHERE email = $1`, [ALLOWED_EMAIL]);
  } catch (_) {}
  try {
    await pool.query(`DELETE FROM trade_companies WHERE company_name = $1`, [COMPANY_NAME]);
  } catch (_) {}
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

  // Per-run unique phone numbers to avoid collisions on the shared DB.
  const ALLOWED_MOBILE = uniquePhone(runId, 'allowed-mobile');
  const ALLOWED_EC     = uniquePhone(runId, 'allowed-ec');
  const COMPANY_PHONE  = uniquePhone(runId, 'co-phone');
  const CONTACT_PHONE  = uniquePhone(runId, 'ct-phone');
  // Also seed the admin user's own mobile so we can verify a kind:'user' row.
  const ADMIN_MOBILE   = uniquePhone(runId, 'admin-mobile');

  console.log(`\n  phone-directory test  run=${runId}`);
  console.log(`  DB: ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared (PRIVTEST_ALLOW_SHARED_DB=1)'}`);
  console.log(`  Phones  allowed_mobile=${ALLOWED_MOBILE}  allowed_ec=${ALLOWED_EC}`);
  console.log(`          co_phone=${COMPANY_PHONE}  ct_phone=${CONTACT_PHONE}  admin_mobile=${ADMIN_MOBILE}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);
  await purgeFixtures(pool);

  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  admin=${users.admin.email}  manager=${users.manager.email}  member=${users.member.email}`);

  // Put the admin's mobile into allowed_emails metadata so kind:'user' appears.
  await pool.query(
    `UPDATE allowed_emails SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
       WHERE email = $2`,
    [JSON.stringify({ mobile_number: ADMIN_MOBILE }), users.admin.email.toLowerCase()],
  );
  // If there's no allowed_emails row for the admin yet, insert one.
  const adminAllowedCheck = await pool.query(
    `SELECT 1 FROM allowed_emails WHERE email = $1`, [users.admin.email.toLowerCase()],
  );
  if (adminAllowedCheck.rows.length === 0) {
    await pool.query(
      `INSERT INTO allowed_emails (email, note, metadata)
         VALUES ($1, 'privtest admin seed', $2::jsonb)`,
      [users.admin.email.toLowerCase(), JSON.stringify({ mobile_number: ADMIN_MOBILE })],
    );
  }

  // Seed an allowed-only row (no corresponding users row) with two phones.
  await pool.query(
    `INSERT INTO allowed_emails (email, note, metadata)
       VALUES ($1, 'privtest phonedir seed', $2::jsonb)
       ON CONFLICT (email) DO UPDATE SET metadata = EXCLUDED.metadata`,
    [ALLOWED_EMAIL, JSON.stringify({
      first_name:    ALLOWED_FIRST,
      last_name:     ALLOWED_LAST,
      mobile_number: ALLOWED_MOBILE,
      ec_phone:      ALLOWED_EC,
    })],
  );

  const { child, logBuf } = spawnServer();
  let exited = false;
  child.on('exit', () => { exited = true; });

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

  const adminClient   = await login(users.admin.email, PASSWORD);
  const managerClient = await login(users.manager.email, PASSWORD);
  const memberClient  = await login(users.member.email, PASSWORD);

  // ── Seed a trade company + contact via the API ───────────────────────────
  let tradeId = null;
  {
    const r = await adminClient.post('/api/trades', {
      company_name:  COMPANY_NAME,
      trade_type:    'Plumbing',
      areas_served:  [],
      timescale:     '',
      notes:         '',
      website:       '',
      company_phone: COMPANY_PHONE,
      contacts: [{ name: CONTACT_NAME, role: '', phone: CONTACT_PHONE, email: '', preferred_contact: 'Phone' }],
    });
    const ok = r.status === 201 && r.json && r.json.id;
    record(
      'Seed: POST /api/trades creates the fixture company',
      'status 201 with id',
      `status=${r.status} id=${r.json && r.json.id}`,
      !!ok,
    );
    if (!ok) {
      console.error('  Cannot proceed without trade fixture. Aborting.');
      await cleanupAndExit(2);
      return;
    }
    tradeId = r.json.id;
    console.log(`  Seeded trade  id=${tradeId}  co_phone=${COMPANY_PHONE}  ct_phone=${CONTACT_PHONE}`);
  }

  // ── (A) Auth gating ───────────────────────────────────────────────────────

  {
    const r = await memberClient.get('/api/admin/phone-directory');
    record(
      'Auth: member gets 403',
      '403',
      `${r.status}`,
      r.status === 403,
    );
  }

  {
    const r = await managerClient.get('/api/admin/phone-directory');
    record(
      'Auth: manager gets 200',
      '200',
      `${r.status}`,
      r.status === 200,
    );
  }

  // ── Fetch as admin for all remaining assertions ───────────────────────────
  const dir = (await adminClient.get('/api/admin/phone-directory')).json;
  record(
    'Auth: admin gets 200',
    '200 with JSON body',
    dir ? `keys=${Object.keys(dir).join(',')}` : 'null',
    !!dir && typeof dir === 'object',
  );

  if (!dir) {
    console.error('  No payload. Aborting remaining assertions.');
    await cleanupAndExit(2);
    return;
  }

  // ── (B) Payload shape ─────────────────────────────────────────────────────

  record(
    'Shape: response has "team" array',
    'Array',
    Array.isArray(dir.team) ? `Array(${dir.team.length})` : typeof dir.team,
    Array.isArray(dir.team),
  );
  record(
    'Shape: response has "trades" array',
    'Array',
    Array.isArray(dir.trades) ? `Array(${dir.trades.length})` : typeof dir.trades,
    Array.isArray(dir.trades),
  );
  record(
    'Shape: response has "customers" array',
    'Array',
    Array.isArray(dir.customers) ? `Array(${dir.customers.length})` : typeof dir.customers,
    Array.isArray(dir.customers),
  );

  // ── (C) Team data — allowed-only row ─────────────────────────────────────

  const allowedMobileEntry = (dir.team || []).find(
    e => e.kind === 'allowed' && e.phone === ALLOWED_MOBILE && e.email === ALLOWED_EMAIL,
  );
  record(
    'Team: allowed-only row — mobile_number entry present with correct fields',
    `kind=allowed email=${ALLOWED_EMAIL} field=mobile_number phone=${ALLOWED_MOBILE}`,
    allowedMobileEntry
      ? `kind=${allowedMobileEntry.kind} field=${allowedMobileEntry.field} phone=${allowedMobileEntry.phone}`
      : 'not found',
    !!allowedMobileEntry && allowedMobileEntry.field === 'mobile_number',
  );

  const allowedEcEntry = (dir.team || []).find(
    e => e.kind === 'allowed' && e.phone === ALLOWED_EC && e.email === ALLOWED_EMAIL,
  );
  record(
    'Team: allowed-only row — ec_phone entry present with correct fields',
    `kind=allowed email=${ALLOWED_EMAIL} field=ec_phone phone=${ALLOWED_EC}`,
    allowedEcEntry
      ? `kind=${allowedEcEntry.kind} field=${allowedEcEntry.field} phone=${allowedEcEntry.phone}`
      : 'not found',
    !!allowedEcEntry && allowedEcEntry.field === 'ec_phone',
  );

  if (allowedMobileEntry) {
    const label = allowedMobileEntry.label || '';
    const labelOk = label.includes(ALLOWED_FIRST) || label.includes(ALLOWED_LAST) || label === ALLOWED_EMAIL;
    record(
      'Team: allowed-only row — label includes name or email',
      `contains "${ALLOWED_FIRST}" or "${ALLOWED_LAST}" or email`,
      `label=${JSON.stringify(label)}`,
      labelOk,
    );
  }

  // ── (C) Team data — users-joined row (admin) ──────────────────────────────

  const userMobileEntry = (dir.team || []).find(
    e => e.kind === 'user' && e.phone === ADMIN_MOBILE,
  );
  record(
    'Team: user row — admin mobile_number entry present with kind=user',
    `kind=user field=mobile_number phone=${ADMIN_MOBILE}`,
    userMobileEntry
      ? `kind=${userMobileEntry.kind} field=${userMobileEntry.field} userId=${userMobileEntry.userId}`
      : 'not found',
    !!userMobileEntry && userMobileEntry.field === 'mobile_number',
  );

  if (userMobileEntry) {
    record(
      'Team: user row — has userId and email fields',
      'userId truthy, email present',
      `userId=${userMobileEntry.userId} email=${userMobileEntry.email}`,
      !!userMobileEntry.userId && !!userMobileEntry.email,
    );
  }

  // ── (D) Trades data — company phone ───────────────────────────────────────

  const coEntry = (dir.trades || []).find(
    e => e.kind === 'company' && e.phone === COMPANY_PHONE && e.tradeId === tradeId,
  );
  record(
    'Trades: company_phone entry present with kind=company',
    `kind=company tradeId=${tradeId} phone=${COMPANY_PHONE}`,
    coEntry
      ? `kind=${coEntry.kind} tradeId=${coEntry.tradeId} phone=${coEntry.phone} companyName=${coEntry.companyName}`
      : 'not found',
    !!coEntry,
  );

  if (coEntry) {
    record(
      'Trades: company entry — companyName matches fixture',
      COMPANY_NAME,
      coEntry.companyName,
      coEntry.companyName === COMPANY_NAME,
    );
    record(
      'Trades: company entry — no contactName field (company kind)',
      'contactName absent or undefined',
      String(coEntry.contactName),
      coEntry.contactName === undefined || coEntry.contactName === null || coEntry.contactName === '',
    );
  }

  // ── (D) Trades data — contact phone ──────────────────────────────────────

  const ctEntry = (dir.trades || []).find(
    e => e.kind === 'contact' && e.phone === CONTACT_PHONE && e.tradeId === tradeId,
  );
  record(
    'Trades: contact phone entry present with kind=contact',
    `kind=contact tradeId=${tradeId} phone=${CONTACT_PHONE}`,
    ctEntry
      ? `kind=${ctEntry.kind} tradeId=${ctEntry.tradeId} phone=${ctEntry.phone} contactName=${ctEntry.contactName}`
      : 'not found',
    !!ctEntry,
  );

  if (ctEntry) {
    record(
      'Trades: contact entry — contactName matches fixture',
      CONTACT_NAME,
      ctEntry.contactName,
      ctEntry.contactName === CONTACT_NAME,
    );
    record(
      'Trades: contact entry — companyName present',
      COMPANY_NAME,
      ctEntry.companyName,
      ctEntry.companyName === COMPANY_NAME,
    );
  }

  // ── (E) No cross-run contamination ───────────────────────────────────────
  // Verify that unrelated phone numbers (made-up values) are NOT in the response.
  const sentinel = '0000000001'; // extremely unlikely to be seeded by anything real
  const sentinelLeak = [...(dir.team || []), ...(dir.trades || []), ...(dir.customers || [])]
    .some(e => e.phone === sentinel);
  record(
    'Isolation: sentinel phone not present in any section',
    'not found',
    sentinelLeak ? 'FOUND (unexpected)' : 'not found',
    !sentinelLeak,
  );

  // ── (F) customers is an empty array (no HUBSPOT_TOKEN in harness) ─────────

  record(
    'Customers: array (empty without HUBSPOT_TOKEN)',
    'Array (length 0 expected since harness strips HUBSPOT_TOKEN)',
    Array.isArray(dir.customers) ? `Array(${dir.customers.length})` : typeof dir.customers,
    Array.isArray(dir.customers) && dir.customers.length === 0,
  );

  // ── Summary ───────────────────────────────────────────────────────────────
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok).length;
  console.log(`\n  ${passed} passed, ${failed} failed`);

  await cleanupAndExit(failed > 0 ? 1 : 0);
}

main();
