'use strict';

// test/contact-customer-email-send/run.js
//
// Integration tests for the contact_customer send-email route.
// Spins up a mock HubSpot server and captures outgoing emails via
// MAIL_TRANSPORT_FILE_OVERRIDE, then asserts the DB rows written.
//
// Probes:
//   (A) A successful POST /send-email sets email_sent=true in
//       contact_attempt_tracking for the given contactId.
//   (B) A successful POST /send-email inserts a contact_attempt_log row
//       with method='email' and note='Follow-up email sent: "<subject>"'.
//   (C) When SMTP env vars are absent (no transport configured), the route
//       returns 500 and writes no DB rows.
//   (D) Missing subject field → 400.
//   (E) Missing body field → 400.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:contact-customer-email-send
//   PRIVTEST_ALLOW_SHARED_DB=1      npm run test:contact-customer-email-send

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

require('dotenv').config();

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

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'contact-customer-email-send.md'
);

const CONTACT_ID    = '9988101';
const CONTACT_EMAIL = 'privtest-cc-email@example.com';
const CONTACT_FIRST = 'PrivTest';

const findings = [];
function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${id} — ${detail}`);
}

// ── Mock HubSpot HTTP server ──────────────────────────────────────────────────
function startMockHubSpot(contactEmail) {
  const server = http.createServer((req, res) => {
    const u = req.url;
    if (u.includes(`/crm/v3/objects/contacts/${CONTACT_ID}`)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: CONTACT_ID,
        properties: {
          firstname: CONTACT_FIRST,
          lastname:  'EmailSend',
          email:     contactEmail || CONTACT_EMAIL,
        },
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Not found' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

async function purgeFixtures(pool) {
  await pool.query(
    `DELETE FROM contact_attempt_log WHERE hubspot_contact_id = $1`,
    [CONTACT_ID]
  );
  await pool.query(
    `DELETE FROM contact_attempt_tracking WHERE hubspot_contact_id = $1`,
    [CONTACT_ID]
  );
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
  console.log(`\n  contact-customer-email-send  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);
  await purgeFixtures(pool);

  // ── Set up shared fixtures ─────────────────────────────────────────────────
  const mailFile = path.join(os.tmpdir(), `cc-email-send-${runId}.jsonl`);
  const hsServer = await startMockHubSpot(CONTACT_EMAIL);
  const hsPort   = hsServer.address().port;
  const hsUrl    = `http://127.0.0.1:${hsPort}`;

  const users = await seedUsers(pool, runId);

  // ── Probes (A) + (B): successful send ─────────────────────────────────────
  const { child: childAB } = spawnServer({
    extraEnv: {
      HUBSPOT_TOKEN:              'privtest-fake-hs-token',
      HUBSPOT_API_URL:            hsUrl,
      MAIL_TRANSPORT_FILE_OVERRIDE: mailFile,
    },
  });
  let exitedAB = false;
  childAB.on('exit', () => { exitedAB = true; });

  const SUBJECT = 'Checking in with you';
  const BODY    = 'Hi there,\n\nJust following up on your enquiry.';

  try {
    await waitForServer();
    await resetRateLimitStore(pool);

    const member = await login(users.member.email, PASSWORD);
    const res = await member.post(
      `/api/card-actions/contact-customer/${encodeURIComponent(CONTACT_ID)}/send-email`,
      { subject: SUBJECT, body: BODY },
    );

    const ok = res.status === 200;
    const body = res.json || {};

    // (A) tracking row
    const trackRow = await pool.query(
      `SELECT email_sent FROM contact_attempt_tracking WHERE hubspot_contact_id = $1`,
      [CONTACT_ID]
    );
    const emailSentFlag = trackRow.rows[0]?.email_sent;

    record(
      '(A) send-email: email_sent=true in contact_attempt_tracking after successful send',
      ok && emailSentFlag === true,
      `status=${res.status} email_sent=${emailSentFlag} response_email_sent=${body.email_sent}`,
    );

    // (B) log row
    const logRow = await pool.query(
      `SELECT method, note FROM contact_attempt_log
        WHERE hubspot_contact_id = $1
        ORDER BY attempted_at DESC LIMIT 1`,
      [CONTACT_ID]
    );
    const lr       = logRow.rows[0] || {};
    const wantNote = `Follow-up email sent: "${SUBJECT}"`;
    record(
      '(B) send-email: contact_attempt_log row inserted with method=email and auto-note',
      ok && lr.method === 'email' && lr.note === wantNote,
      `method=${lr.method} note=${lr.note}`,
    );
  } catch (e) {
    record('(A) send-email: email_sent=true in contact_attempt_tracking after successful send', false, e.message);
    record('(B) send-email: contact_attempt_log row inserted with method=email and auto-note', false, e.message);
  }

  try { if (!exitedAB) childAB.kill('SIGTERM'); } catch {}
  await new Promise(r => setTimeout(r, 400));

  // ── Probe (C): no transport → 500 ─────────────────────────────────────────
  await purgeFixtures(pool);

  const { child: childC } = spawnServer({
    extraEnv: {
      HUBSPOT_TOKEN:   'privtest-fake-hs-token',
      HUBSPOT_API_URL: hsUrl,
    },
  });
  let exitedC = false;
  childC.on('exit', () => { exitedC = true; });

  try {
    await waitForServer();
    await resetRateLimitStore(pool);
    const users2 = await seedUsers(pool, runId + 'c');
    const member2 = await login(users2.member.email, PASSWORD);

    const res = await member2.post(
      `/api/card-actions/contact-customer/${encodeURIComponent(CONTACT_ID)}/send-email`,
      { subject: 'Test', body: 'Hello' },
    );

    const is500 = res.status === 500;
    const logRow = await pool.query(
      `SELECT COUNT(*)::int AS n FROM contact_attempt_log WHERE hubspot_contact_id = $1`,
      [CONTACT_ID]
    );
    const noLog = logRow.rows[0].n === 0;
    record(
      '(C) send-email: missing transport (no SMTP env) returns 500 without logging',
      is500 && noLog,
      `status=${res.status} log_rows=${logRow.rows[0].n}`,
    );
  } catch (e) {
    record('(C) send-email: missing transport (no SMTP env) returns 500 without logging', false, e.message);
  }

  try { if (!exitedC) childC.kill('SIGTERM'); } catch {}
  await new Promise(r => setTimeout(r, 400));

  // ── Probes (D) + (E): validation 400s ─────────────────────────────────────
  const { child: childDE } = spawnServer({
    extraEnv: {
      HUBSPOT_TOKEN:              'privtest-fake-hs-token',
      HUBSPOT_API_URL:            hsUrl,
      MAIL_TRANSPORT_FILE_OVERRIDE: mailFile,
    },
  });
  let exitedDE = false;
  childDE.on('exit', () => { exitedDE = true; });

  try {
    await waitForServer();
    await resetRateLimitStore(pool);
    const users3 = await seedUsers(pool, runId + 'de');
    const member3 = await login(users3.member.email, PASSWORD);

    const resD = await member3.post(
      `/api/card-actions/contact-customer/${encodeURIComponent(CONTACT_ID)}/send-email`,
      { body: 'Hello' },
    );
    record(
      '(D) send-email: missing subject returns 400',
      resD.status === 400,
      `status=${resD.status}`,
    );

    const resE = await member3.post(
      `/api/card-actions/contact-customer/${encodeURIComponent(CONTACT_ID)}/send-email`,
      { subject: 'Hello' },
    );
    record(
      '(E) send-email: missing body returns 400',
      resE.status === 400,
      `status=${resE.status}`,
    );
  } catch (e) {
    record('(D) send-email: missing subject returns 400', false, e.message);
    record('(E) send-email: missing body returns 400', false, e.message);
  }

  try { if (!exitedDE) childDE.kill('SIGTERM'); } catch {}

  // ── Teardown ───────────────────────────────────────────────────────────────
  hsServer.close();
  await purgeFixtures(pool);
  await cleanupTestData(pool);
  await pool.end().catch(() => {});
  try { fs.unlinkSync(mailFile); } catch {}

  // ── Write report ───────────────────────────────────────────────────────────
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok).length;
  const lines  = [
    '# contact-customer-email-send test',
    '',
    `Run: ${new Date().toISOString()}`,
    '',
    '| # | Probe | Result |',
    '|---|-------|--------|',
    ...findings.map((f, i) => `| ${i + 1} | ${f.id} | ${f.ok ? '✅ PASS' : '❌ FAIL'} |`),
    '',
    `**${passed} passed, ${failed} failed**`,
  ];
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, lines.join('\n'), 'utf8');
  console.log(`\n  ${passed}/${findings.length} passed  →  ${REPORT_PATH}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(2); });
