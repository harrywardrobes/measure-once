'use strict';

const PROBE_LABELS = [
  '(A) upload-photos send sets email_sent=true in contact_attempt_tracking',
  '(B) upload-photos send inserts contact_attempt_log row method=email with auto-note',
  '(C) no mail transport → 200 but no contact_attempt_log row (logging gated on a real send)',
];

// test/upload-photos-contact-log/run.js
//
// Integration test for the "last contacted" logging added to the
// upload_photos_and_info send flow.  When staff send a photo-upload link to a
// customer, the email must surface in the customer's "Last contacted" card —
// which reads from contact_attempt_log / contact_attempt_tracking.  This suite
// asserts the POST /api/card-actions/upload-photos-and-info route writes those
// rows on a successful send, and (crucially) does NOT write them when no email
// actually went out.
//
// It exercises the pre-generated-token branch (body { contactId, token }) so no
// HubSpot call is needed — the route looks the link up by token_hash in
// customer_info_submissions and emails the row's contact_email.
//
//   (A) Successful send → contact_attempt_tracking.email_sent = true
//   (B) Successful send → contact_attempt_log row, method='email',
//       note='Photo upload & info link sent'
//   (C) No SMTP transport configured → route still returns 200 (the link is
//       still copyable) but logs NOTHING, because logCustomerEmailAttempt is
//       gated on sendCustomerInviteEmail reporting an actual send.
//
// Overrides used:
//   MAIL_TRANSPORT_FILE_OVERRIDE — present for (A)/(B) so a transport exists and
//     the send "succeeds"; absent for (C) so createMailTransport() returns null.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:upload-photos-contact-log
//   PRIVTEST_ALLOW_SHARED_DB=1      npm run test:upload-photos-contact-log

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');
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
  __dirname, '..', '..', 'test-results', 'upload-photos-contact-log.md'
);

const NOTE_EXPECTED = 'Photo upload & info link sent';

const findings = [];
function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${id} — ${detail}`);
}

// Insert a customer_info_submissions row with a known raw token so the
// pre-generated-token branch of the send route finds it (no HubSpot call).
async function insertLinkRow(pool, contactId) {
  const rawToken     = crypto.randomBytes(32).toString('hex');
  const tokenHash    = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt    = new Date(Date.now() + 86_400_000); // 24 h from now
  const contactEmail = `upl-${rawToken.slice(0, 8)}@privtest.local`;
  const formLink     = `https://example.test/customer-info/${rawToken}`;
  await pool.query(
    `INSERT INTO customer_info_submissions
       (contact_id, contact_name, contact_email, token_hash, expires_at,
        masked_email, masked_phone, form_link)
     VALUES ($1, 'Upload Log User', $2, $3, $4, 'up***@***.local', '07***1234', $5)`,
    [contactId, contactEmail, tokenHash, expiresAt.toISOString(), formLink]
  );
  return { rawToken, tokenHash, contactEmail };
}

async function purgeFixtures(pool, contactId) {
  try {
    await pool.query(`DELETE FROM contact_attempt_log      WHERE hubspot_contact_id = $1`, [contactId]);
    await pool.query(`DELETE FROM contact_attempt_tracking WHERE hubspot_contact_id = $1`, [contactId]);
    await pool.query(`DELETE FROM customer_info_submissions WHERE contact_id        = $1`, [contactId]);
  } catch { /* ignore on fresh DB */ }
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
  // contactIds must be all-digit (the route validates /^\d+$/).
  const contactOk = String(810_000_000 + Math.floor(Math.random() * 89_999_999));
  const contactNo = String(810_000_000 + Math.floor(Math.random() * 89_999_999));

  console.log(`\n  upload-photos-contact-log  run=${runId}  ok=${contactOk}  no=${contactNo}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);
  await purgeFixtures(pool, contactOk);
  await purgeFixtures(pool, contactNo);

  const mailFile = path.join(os.tmpdir(), `upl-contact-log-${runId}.jsonl`);
  try { fs.unlinkSync(mailFile); } catch {}

  const users = await seedUsers(pool, runId);

  // ── Probes (A) + (B): successful send with a mail transport configured ──────
  const { child: childAB } = spawnServer({
    extraEnv: { MAIL_TRANSPORT_FILE_OVERRIDE: mailFile },
  });
  let exitedAB = false;
  childAB.on('exit', () => { exitedAB = true; });

  try {
    await waitForServer();
    await resetRateLimitStore(pool);

    const { rawToken } = await insertLinkRow(pool, contactOk);
    const member = await login(users.member.email, PASSWORD);
    const res = await member.post('/api/card-actions/upload-photos-and-info',
      { contactId: contactOk, token: rawToken });

    const ok = res.status === 200;

    const trackRow = await pool.query(
      `SELECT email_sent FROM contact_attempt_tracking WHERE hubspot_contact_id = $1`,
      [contactOk]
    );
    const emailSentFlag = trackRow.rows[0]?.email_sent;
    record(PROBE_LABELS[0],
      ok && emailSentFlag === true,
      `status=${res.status} email_sent=${emailSentFlag}`);

    const logRow = await pool.query(
      `SELECT method, note FROM contact_attempt_log
        WHERE hubspot_contact_id = $1
        ORDER BY attempted_at DESC LIMIT 1`,
      [contactOk]
    );
    const lr = logRow.rows[0] || {};
    record(PROBE_LABELS[1],
      ok && lr.method === 'email' && lr.note === NOTE_EXPECTED,
      `method=${lr.method} note=${JSON.stringify(lr.note)}`);
  } catch (e) {
    record(PROBE_LABELS[0], false, e.message);
    record(PROBE_LABELS[1], false, e.message);
  }

  try { if (!exitedAB) childAB.kill('SIGTERM'); } catch {}
  await new Promise(r => setTimeout(r, 400));

  // ── Probe (C): no transport → 200 with no logging ───────────────────────────
  const { child: childC } = spawnServer({ extraEnv: {} });
  let exitedC = false;
  childC.on('exit', () => { exitedC = true; });

  try {
    await waitForServer();
    await resetRateLimitStore(pool);

    const { rawToken } = await insertLinkRow(pool, contactNo);
    const users2 = await seedUsers(pool, runId + 'c');
    const member2 = await login(users2.member.email, PASSWORD);
    const res = await member2.post('/api/card-actions/upload-photos-and-info',
      { contactId: contactNo, token: rawToken });

    const is200 = res.status === 200;
    const logCount = parseInt(
      (await pool.query(
        `SELECT COUNT(*)::int AS n FROM contact_attempt_log WHERE hubspot_contact_id = $1`,
        [contactNo]
      )).rows[0].n, 10
    );
    record(PROBE_LABELS[2],
      is200 && logCount === 0,
      `status=${res.status} log_rows=${logCount} (expected 200 / 0 rows)`);
  } catch (e) {
    record(PROBE_LABELS[2], false, e.message);
  }

  try { if (!exitedC) childC.kill('SIGTERM'); } catch {}

  // ── Teardown ────────────────────────────────────────────────────────────────
  await purgeFixtures(pool, contactOk);
  await purgeFixtures(pool, contactNo);
  await cleanupTestData(pool);
  await pool.end().catch(() => {});
  try { fs.unlinkSync(mailFile); } catch {}

  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok).length;
  const lines  = [
    '# upload-photos-contact-log test',
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
