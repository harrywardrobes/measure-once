'use strict';
// test/photo-approval-notification/run.js
//
// Regression test for richer audit log details in
// approve_profile_photo / reject_profile_photo entries.
//
// Guards against regressions where:
//  - the notification status is dropped from the audit log `details` column,
//  - or the details revert to a plain string without the notification status.
//
// The test uses MAIL_TRANSPORT_FILE_OVERRIDE to intercept sendMail calls in
// auth.js (which now supports this override, matching design-visits.js). The
// harness strips SMTP_* vars by default, so omitting the override gives the
// "skipped (SMTP not configured)" path without any extra configuration.
//
// Probes (Pass 1 — SMTP via file override):
//   (APPROVE-SENT-AUDIT)  audit log details contains
//                         "email notification sent to <email>"
//   (APPROVE-SENT-MAIL)   file-override mail file contains an email to <email>
//   (REJECT-SENT-AUDIT)   audit log details contains
//                         "email notification sent to <email>"
//   (REJECT-SENT-MAIL)    file-override mail file contains an email to <email>
//
// Probes (Pass 2 — no SMTP):
//   (APPROVE-SKIP-AUDIT)  audit log details contains
//                         "email notification skipped (SMTP not configured)"
//   (REJECT-SKIP-AUDIT)   audit log details contains
//                         "email notification skipped (SMTP not configured)"
//
// Probes (Pass 3 — broken SMTP transport, always throws):
//   (APPROVE-FAIL-AUDIT)  audit log details contains
//                         "email notification failed to send"
//   (REJECT-FAIL-AUDIT)   audit log details contains
//                         "email notification failed to send"
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:photo-approval-notification
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:photo-approval-notification

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { Pool } = require('pg');

require('dotenv').config();

const REPORT_PATH = path.join(__dirname, '..', '..', 'test-results', 'photo-approval-notification.md');
const findings    = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${id} — ${detail}`);
}

function readMailJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

async function seedUserWithPendingPhoto(pool, email) {
  await pool.query(
    `INSERT INTO allowed_emails (email, note) VALUES ($1, 'photo-notif test seed')
     ON CONFLICT (email) DO NOTHING`,
    [email]
  );
  const r = await pool.query(
    `INSERT INTO users
       (email, first_name, last_name, password_hash, privilege_level, onboarding_status,
        pending_photo)
     VALUES ($1, 'Photo', 'User', '$2b$10$unused', 'member', 'active',
             'data:image/jpeg;base64,/9j/fakedata')
     ON CONFLICT (email) DO UPDATE
       SET pending_photo = 'data:image/jpeg;base64,/9j/fakedata'
     RETURNING id`,
    [email]
  );
  return r.rows[0].id;
}

async function restorePendingPhoto(pool, userId) {
  await pool.query(
    `UPDATE users SET pending_photo = 'data:image/jpeg;base64,/9j/fakedata' WHERE id = $1`,
    [userId]
  );
}

async function getLatestAuditLog(pool, actionType, targetEmail) {
  const r = await pool.query(
    `SELECT details FROM admin_audit_log
     WHERE action_type = $1 AND target_email = $2
     ORDER BY acted_at DESC LIMIT 1`,
    [actionType, targetEmail]
  );
  return r.rows[0]?.details || null;
}

async function cleanup(pool, emails) {
  for (const email of emails) {
    try { await pool.query(`DELETE FROM users WHERE email = $1`, [email]); } catch {}
    try { await pool.query(`DELETE FROM allowed_emails WHERE email = $1`, [email]); } catch {}
    try { await pool.query(`DELETE FROM admin_audit_log WHERE target_email = $1`, [email]); } catch {}
    try { await pool.query(`DELETE FROM sessions WHERE sess::text LIKE $1`, [`%${email}%`]); } catch {}
  }
}

async function runPass(label, pool, harness, extraEnv) {
  const { spawnServer, waitForServer, seedUsers, cleanupTestData, resetRateLimitStore, login, TEST_PORT } = harness;
  const BASE = `http://127.0.0.1:${TEST_PORT}`;

  const runId    = Math.random().toString(36).slice(2, 8);
  const approveEmail = `privtest-photo-appr-${runId}@privtest.local`;
  const rejectEmail  = `privtest-photo-rej-${runId}@privtest.local`;

  console.log(`\n  ${label} run=${runId}`);

  const { child, logBuf } = spawnServer({ extraEnv });
  let passOk = true;
  try {
    await waitForServer();
    console.log('  test server up');

    await cleanupTestData(pool);
    await resetRateLimitStore(pool);

    const users = await seedUsers(pool, runId);
    const admin = users.admin;

    const approveUserId = await seedUserWithPendingPhoto(pool, approveEmail);
    const rejectUserId  = await seedUserWithPendingPhoto(pool, rejectEmail);

    const client = await login(admin.email, admin.password);

    // ── Approve ──────────────────────────────────────────────────────────────
    const approveRes = await client.post(`/api/admin/photo-requests/${approveUserId}/approve`, {});
    if (approveRes.status !== 200) {
      record(`${label}.APPROVE-audit`, false,
        `approve returned ${approveRes.status} body=${approveRes.text.slice(0, 200)}`);
      passOk = false;
    } else {
      const details = await getLatestAuditLog(pool, 'approve_profile_photo', approveEmail);
      if (extraEnv.MAIL_TRANSPORT_THROW_OVERRIDE) {
        const wantDetail = 'email notification failed to send';
        const ok = typeof details === 'string' && details.includes(wantDetail);
        record(`${label}.APPROVE-FAIL-AUDIT`, ok,
          ok
            ? `audit details contained "${wantDetail}"`
            : `audit details did not contain "${wantDetail}"; got: ${JSON.stringify(details)}`);
        passOk = passOk && ok;
      } else if (extraEnv.MAIL_TRANSPORT_FILE_OVERRIDE) {
        const wantDetail = `email notification sent to ${approveEmail}`;
        const ok = typeof details === 'string' && details.includes(wantDetail);
        record(`${label}.APPROVE-SENT-AUDIT`, ok,
          ok
            ? `audit details contained "${wantDetail}"`
            : `audit details did not contain "${wantDetail}"; got: ${JSON.stringify(details)}`);
        passOk = passOk && ok;

        const mails = readMailJsonl(extraEnv.MAIL_TRANSPORT_FILE_OVERRIDE);
        const approvalMail = mails.find(m =>
          typeof m.to === 'string' && m.to.includes(approveEmail)
        );
        const mailOk = !!approvalMail && typeof approvalMail.subject === 'string'
          && approvalMail.subject.toLowerCase().includes('approved');
        record(`${label}.APPROVE-SENT-MAIL`, mailOk,
          mailOk
            ? `approval email captured for ${approveEmail} subject="${approvalMail.subject}"`
            : `no approval email for ${approveEmail} (${mails.length} mail(s) in file: ${mails.map(m => m.to).join(', ')})`);
        passOk = passOk && mailOk;
      } else {
        const wantDetail = 'email notification skipped (SMTP not configured)';
        const ok = typeof details === 'string' && details.includes(wantDetail);
        record(`${label}.APPROVE-SKIP-AUDIT`, ok,
          ok
            ? `audit details contained "${wantDetail}"`
            : `audit details did not contain "${wantDetail}"; got: ${JSON.stringify(details)}`);
        passOk = passOk && ok;
      }
    }

    // ── Reject ───────────────────────────────────────────────────────────────
    const rejectRes = await client.post(`/api/admin/photo-requests/${rejectUserId}/reject`, {});
    if (rejectRes.status !== 200) {
      record(`${label}.REJECT-audit`, false,
        `reject returned ${rejectRes.status} body=${rejectRes.text.slice(0, 200)}`);
      passOk = false;
    } else {
      const details = await getLatestAuditLog(pool, 'reject_profile_photo', rejectEmail);
      if (extraEnv.MAIL_TRANSPORT_THROW_OVERRIDE) {
        const wantDetail = 'email notification failed to send';
        const ok = typeof details === 'string' && details.includes(wantDetail);
        record(`${label}.REJECT-FAIL-AUDIT`, ok,
          ok
            ? `audit details contained "${wantDetail}"`
            : `audit details did not contain "${wantDetail}"; got: ${JSON.stringify(details)}`);
        passOk = passOk && ok;
      } else if (extraEnv.MAIL_TRANSPORT_FILE_OVERRIDE) {
        const wantDetail = `email notification sent to ${rejectEmail}`;
        const ok = typeof details === 'string' && details.includes(wantDetail);
        record(`${label}.REJECT-SENT-AUDIT`, ok,
          ok
            ? `audit details contained "${wantDetail}"`
            : `audit details did not contain "${wantDetail}"; got: ${JSON.stringify(details)}`);
        passOk = passOk && ok;

        const mails = readMailJsonl(extraEnv.MAIL_TRANSPORT_FILE_OVERRIDE);
        const rejectionMail = mails.find(m =>
          typeof m.to === 'string' && m.to.includes(rejectEmail)
        );
        const mailOk = !!rejectionMail && typeof rejectionMail.subject === 'string'
          && rejectionMail.subject.toLowerCase().includes('not approved');
        record(`${label}.REJECT-SENT-MAIL`, mailOk,
          mailOk
            ? `rejection email captured for ${rejectEmail} subject="${rejectionMail.subject}"`
            : `no rejection email for ${rejectEmail} (${mails.length} mail(s) in file: ${mails.map(m => m.to).join(', ')})`);
        passOk = passOk && mailOk;
      } else {
        const wantDetail = 'email notification skipped (SMTP not configured)';
        const ok = typeof details === 'string' && details.includes(wantDetail);
        record(`${label}.REJECT-SKIP-AUDIT`, ok,
          ok
            ? `audit details contained "${wantDetail}"`
            : `audit details did not contain "${wantDetail}"; got: ${JSON.stringify(details)}`);
        passOk = passOk && ok;
      }
    }
  } catch (e) {
    console.error('  fatal:', e.stack || e.message);
    record(`${label}.harness`, false, `fatal: ${e.message}`);
    passOk = false;
  } finally {
    try { await cleanup(pool, [approveEmail, rejectEmail]); } catch {}
    try { await harness.cleanupTestData(pool); } catch {}
    try { child.kill('SIGTERM'); } catch {}
    if (extraEnv.MAIL_TRANSPORT_FILE_OVERRIDE) {
      try { fs.unlinkSync(extraEnv.MAIL_TRANSPORT_FILE_OVERRIDE); } catch {}
    }
  }
  return passOk;
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

  console.log('\n  photo-approval-notification');
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });

  const harness = require('../privileges/harness');
  harness.setPool(pool);

  const mailFile = path.join(os.tmpdir(), `photo-notif-${Date.now()}.jsonl`);
  try { fs.unlinkSync(mailFile); } catch {}

  try {
    // Pass 1: SMTP active via file override → notifications are "sent"
    await runPass('SMTP', pool, harness, {
      MAIL_TRANSPORT_FILE_OVERRIDE: mailFile,
    });

    // Pass 2: No SMTP, no file override → notifications are "skipped"
    await runPass('NO-SMTP', pool, harness, {});

    // Pass 3: Transport configured but sendMail always throws → notifications are "failed"
    await runPass('SMTP-FAIL', pool, harness, {
      MAIL_TRANSPORT_THROW_OVERRIDE: '1',
    });
  } finally {
    await pool.end().catch(() => {});
  }

  const lines = [
    '# photo-approval-notification findings',
    '',
    `Run: ${new Date().toISOString()}`,
    `Result: ${findings.every(f => f.ok) ? 'PASS' : 'FAIL'} (${findings.filter(f => f.ok).length}/${findings.length})`,
    '',
    '| ID | Result | Detail |',
    '|----|--------|--------|',
    ...findings.map(f => `| ${f.id} | ${f.ok ? 'PASS' : 'FAIL'} | ${String(f.detail).replace(/\\/g, '\\\\').replace(/\|/g, '\\|')} |`),
  ];
  try {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, lines.join('\n') + '\n');
    console.log(`\n  report -> ${REPORT_PATH}`);
  } catch (e) {
    console.warn('  report write failed:', e.message);
  }

  process.exit(findings.every(f => f.ok) ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
