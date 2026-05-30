'use strict';

const PROBE_LABELS = [
  '(A) startAt > 5 min in the past → 422 with code:START_IN_PAST',
  '(B) startAt just inside grace window → 200',
  '(C) startAt in the future → 200',
  '(D1) startAt 4 min past (inside 5-min grace) → 200',
  '(D2) startAt 6 min past (outside 5-min grace) → 422',
  '(E) type:delivery — past startAt → 422; future → 200',
  '(E1) type:delivery startAt 10 min past → 422 START_IN_PAST',
  '(E2) type:delivery startAt 30 min future → 200',
  '(F) type:installation — past startAt → 422; future → 200',
  '(F1) type:installation startAt 10 min past → 422 START_IN_PAST',
  '(F2) type:installation startAt 30 min future → 200',
];

// test/visits-past-time/run.js
//
// Focused integration test for the past-time guard on POST /api/visits.
//
// Verifies:
//   (A) A startAt more than the grace threshold (5 min) in the past returns
//       422 with code:'START_IN_PAST'.
//   (B) A startAt just inside the grace window (1 minute ago, grace=5) is
//       accepted — returns 200 and a visit id.
//   (C) A startAt in the future is accepted — returns 200.
//   (D1) startAt 4 min in the past (inside 5-min grace) → 200
//   (D2) startAt 6 min in the past (outside 5-min grace) → 422
//   (E) type:'delivery' — past startAt → 422; future → 200
//   (F) type:'installation' — past startAt → 422; future → 200
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:visits-past-time
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:visits-past-time

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

const REPORT_PATH = path.join(__dirname, '..', '..', 'test-results', 'visits-past-time.md');

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
    `# visits-past-time test report`,
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

function futureIso(offsetMinutes) {
  return new Date(Date.now() + offsetMinutes * 60 * 1000).toISOString();
}

function pastIso(offsetMinutes) {
  return new Date(Date.now() - offsetMinutes * 60 * 1000).toISOString();
}

// Privtest-prefixed so purgeTestVisits can scope deletes by customer_id,
// preventing stale rows from accumulating on a shared database across runs.
const FAKE_CONTACT_ID = 'privtest-visits-past-time-001';

function visitBody(startIso, type = 'design') {
  return {
    type,
    startAt:      startIso,
    endAt:        new Date(new Date(startIso).getTime() + 60 * 60 * 1000).toISOString(),
    customerId:   FAKE_CONTACT_ID,
    customerName: 'Past-time test customer',
  };
}

async function purgeTestVisits(pool) {
  try {
    await pool.query(
      `DELETE FROM visits WHERE customer_id = $1`,
      [FAKE_CONTACT_ID],
    );
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
  console.log(`\n  visits-past-time  run=${runId}`);
  console.log(`  DB: ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);
  await purgeTestVisits(pool);

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
    try {
      await purgeTestVisits(pool);
      await cleanupTestData(pool);
    } catch {}
    await pool.end().catch(() => {});
    writeReport(runId);
    process.exit(code);
  };

  process.on('SIGINT',  () => cleanupAndExit(130));
  process.on('SIGTERM', () => cleanupAndExit(130));
  process.on('uncaughtException',  (e) => { console.error('Uncaught:',  e); cleanupAndExit(2); });
  process.on('unhandledRejection', (e) => { console.error('Unhandled:', e); cleanupAndExit(2); });

  try {
    await waitForServer();
    await resetRateLimitStore(pool);
    console.log(`  Server up at ${BASE}\n`);
  } catch (e) {
    console.error('Server boot failed:', e.message);
    console.error(logBuf.join('').slice(-2000));
    await cleanupAndExit(2);
    return;
  }

  const client = await login(users.admin.email, PASSWORD);

  // ── (A) startAt well in the past (10 minutes) → 422 with START_IN_PAST ────
  {
    const r = await client.post('/api/visits', visitBody(pastIso(10)));
    const gotStatus = r.status === 422;
    const gotCode   = r.json && r.json.code === 'START_IN_PAST';
    record(
      '(A) startAt 10 min past → 422 START_IN_PAST',
      '422 + code:START_IN_PAST',
      `status=${r.status} code=${r.json?.code}`,
      gotStatus && gotCode,
    );
  }

  // ── (B) startAt 1 minute in the past (inside 5-min grace) → 200 ──────────
  {
    const r = await client.post('/api/visits', visitBody(pastIso(1)));
    const ok = r.status === 200 && r.json && typeof r.json.id === 'number';
    record(
      '(B) startAt 1 min past (inside 5-min grace) → 200',
      '200 + id present',
      `status=${r.status} id=${r.json?.id}`,
      ok,
    );
  }

  // ── (C) startAt in the future → 200 ──────────────────────────────────────
  {
    const r = await client.post('/api/visits', visitBody(futureIso(30)));
    const ok = r.status === 200 && r.json && typeof r.json.id === 'number';
    record(
      '(C) startAt 30 min in the future → 200',
      '200 + id present',
      `status=${r.status} id=${r.json?.id}`,
      ok,
    );
  }

  // ── (D) Boundary check: 4 min inside grace → 200; 6 min out → 422 ────────
  {
    const rIn = await client.post('/api/visits', visitBody(pastIso(4)));
    record(
      '(D1) startAt 4 min past (inside 5-min grace) → 200',
      '200 + id present',
      `status=${rIn.status} id=${rIn.json?.id}`,
      rIn.status === 200 && rIn.json && typeof rIn.json.id === 'number',
    );

    const rOut = await client.post('/api/visits', visitBody(pastIso(6)));
    record(
      '(D2) startAt 6 min past (outside 5-min grace) → 422',
      '422 + code:START_IN_PAST',
      `status=${rOut.status} code=${rOut.json?.code}`,
      rOut.status === 422 && rOut.json?.code === 'START_IN_PAST',
    );
  }

  // ── (E) delivery type: past → 422; future → 200 ──────────────────────────
  {
    const rPast = await client.post('/api/visits', visitBody(pastIso(10), 'delivery'));
    record(
      '(E1) type:delivery startAt 10 min past → 422 START_IN_PAST',
      '422 + code:START_IN_PAST',
      `status=${rPast.status} code=${rPast.json?.code}`,
      rPast.status === 422 && rPast.json?.code === 'START_IN_PAST',
    );

    const rFuture = await client.post('/api/visits', visitBody(futureIso(30), 'delivery'));
    record(
      '(E2) type:delivery startAt 30 min future → 200',
      '200 + id present',
      `status=${rFuture.status} id=${rFuture.json?.id}`,
      rFuture.status === 200 && rFuture.json && typeof rFuture.json.id === 'number',
    );
  }

  // ── (F) installation type: past → 422; future → 200 ──────────────────────
  {
    const rPast = await client.post('/api/visits', visitBody(pastIso(10), 'installation'));
    record(
      '(F1) type:installation startAt 10 min past → 422 START_IN_PAST',
      '422 + code:START_IN_PAST',
      `status=${rPast.status} code=${rPast.json?.code}`,
      rPast.status === 422 && rPast.json?.code === 'START_IN_PAST',
    );

    const rFuture = await client.post('/api/visits', visitBody(futureIso(30), 'installation'));
    record(
      '(F2) type:installation startAt 30 min future → 200',
      '200 + id present',
      `status=${rFuture.status} id=${rFuture.json?.id}`,
      rFuture.status === 200 && rFuture.json && typeof rFuture.json.id === 'number',
    );
  }

  const failed = findings.filter(f => !f.ok).length;
  await cleanupAndExit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
