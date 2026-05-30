'use strict';
// test/customer-info-resend/run.js
//
// Integration test for the POST /api/customer-info/:token/resend-expired
// endpoint added in task #1911.  Boots a disposable Express server against an
// isolated test database and exercises the full self-serve resend flow:
//
//   (A) Expired token — GET returns 410 with status:"expired" and maskedEmail
//   (B) Successful resend — creates a new customer_info_submissions row and
//       logs the resend in customer_info_resend_log
//   (C) Per-token rate limit — max 3 resends per token per 24-hour window;
//       4th attempt returns 429 (pre-seeded via direct DB insert to avoid
//       consuming IP-rate-limit budget on the 3 preceding requests)
//   (D) Submitted token — returns 400, not a new link
//   (E) Non-existent token — returns 404
//   (F) New link validity — token extracted from the invitation email is valid
//       and GET /api/customer-info/:freshToken returns 200 with form data
//
// Overrides used:
//   MAIL_TRANSPORT_FILE_OVERRIDE — captures sendMail payloads as JSONL so
//     probe F can extract the fresh raw token from the invitation email
//   TURNSTILE_SECRET_KEY unset — verifyTurnstileForResend() uses dev bypass
//     (ok: true) when the key is absent and NODE_ENV !== 'production'
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:customer-info-resend
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:customer-info-resend

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const http   = require('http');
const crypto = require('crypto');
const { Pool } = require('pg');
const { pollFn } = require('../helpers/poll');

require('dotenv').config();

const REPORT_PATH = path.join(__dirname, '..', '..', 'test-results', 'customer-info-resend.md');
const findings    = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${id} — ${detail}`);
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function waitForTable(pool, tableName, timeoutMs = 15000) {
  const found = await pollFn(async () => {
    const r = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = $1 LIMIT 1`,
      [tableName]
    );
    return r.rowCount || null;
  }, timeoutMs, 200);
  if (!found) throw new Error(`Table ${tableName} did not appear within ${timeoutMs}ms`);
}

/**
 * Insert an already-expired customer_info_submissions row and return the raw
 * token (needed to call the resend endpoint) plus its SHA-256 hash.
 */
async function insertExpiredRow(pool, contactId, opts = {}) {
  const rawToken     = crypto.randomBytes(32).toString('hex');
  const tokenHash    = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiredAt    = new Date(Date.now() - 60_000); // 1 minute ago
  const contactEmail = opts.contactEmail || `resend-${rawToken.slice(0, 8)}@privtest.local`;
  const maskedEmail  = 're***@***.local';
  await pool.query(
    `INSERT INTO customer_info_submissions
       (contact_id, contact_name, contact_email, token_hash, expires_at,
        masked_email, masked_phone)
     VALUES ($1, 'Resend Test User', $2, $3, $4, $5, '07***1234')`,
    [contactId, contactEmail, tokenHash, expiredAt.toISOString(), maskedEmail]
  );
  return { rawToken, tokenHash, maskedEmail, contactEmail };
}

/**
 * Insert an already-submitted customer_info_submissions row and return the
 * raw token.  The row has a future expires_at so the "expired" branch is NOT
 * taken — only the "submitted" branch fires.
 */
async function insertSubmittedRow(pool, contactId) {
  const rawToken  = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 86_400_000); // 24 h from now
  await pool.query(
    `INSERT INTO customer_info_submissions
       (contact_id, contact_name, contact_email, token_hash, expires_at,
        submitted_at, masked_email, masked_phone, address_line1, city,
        postcode, room_count, photo_keys)
     VALUES ($1, 'Done User', 'done@privtest.local', $2, $3, NOW(),
             'd***@***.local', '07***0000', '1 Main St', 'London',
             'SW1A 1AA', '2', '[]'::jsonb)`,
    [contactId, tokenHash, expiresAt.toISOString()]
  );
  return rawToken;
}

async function cleanup(pool, contactId) {
  try {
    const r = await pool.query(
      `SELECT token_hash FROM customer_info_submissions WHERE contact_id = $1`,
      [contactId]
    );
    for (const row of r.rows) {
      await pool.query(
        `DELETE FROM customer_info_resend_log WHERE token_hash = $1`,
        [row.token_hash]
      );
    }
    await pool.query(
      `DELETE FROM customer_info_submissions WHERE contact_id = $1`,
      [contactId]
    );
  } catch { /* ignore on fresh DB */ }
}

// ── Plain HTTP helpers ────────────────────────────────────────────────────────

function httpGet(base, urlPath) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, base);
    const req = http.request({
      method: 'GET',
      hostname: u.hostname,
      port:     u.port,
      path:     u.pathname,
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, json, text: raw });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function httpPost(base, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u       = new URL(urlPath, base);
    const payload = JSON.stringify(body);
    const req = http.request({
      method:   'POST',
      hostname: u.hostname,
      port:     u.port,
      path:     u.pathname,
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, json, text: raw });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function readMailJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n').filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

// ── Main ──────────────────────────────────────────────────────────────────────

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

  const runId     = Math.random().toString(36).slice(2, 8);
  // contactId must be all-digit (the route validates /^\d+$/)
  const contactId = String(800_000_000 + Math.floor(Math.random() * 99_999_999));

  console.log(`\n  customer-info-resend  run=${runId}  contactId=${contactId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool     = new Pool({ connectionString: connStr });
  const mailFile = path.join(os.tmpdir(), `ci-mail-resend-${runId}.jsonl`);
  try { fs.unlinkSync(mailFile); } catch {}

  // ── Env overrides — must be set before requiring the harness so that
  //    spawnServer inherits them via its `...process.env` spread ────────────
  process.env.MAIL_TRANSPORT_FILE_OVERRIDE = mailFile;
  // No TURNSTILE_SECRET_KEY → verifyTurnstileForResend() uses dev bypass
  // (NODE_ENV is set to 'development' by the harness, so ok:true fires).
  delete process.env.TURNSTILE_SECRET_KEY;

  const harness = require('../privileges/harness');
  const { spawnServer, waitForServer, cleanupTestData, resetRateLimitStore, TEST_PORT } = harness;
  const BASE = `http://127.0.0.1:${TEST_PORT}`;
  harness.setPool(pool);

  await cleanupTestData(pool);
  await resetRateLimitStore(pool);
  await cleanup(pool, contactId);

  const { child } = spawnServer({});

  let exitCode = 1;
  try {
    await waitForServer();
    console.log('  test server up');

    await waitForTable(pool, 'customer_info_submissions');
    await waitForTable(pool, 'customer_info_resend_log');

    // ── Probe A: Expired token — GET returns 410 with maskedEmail ─────────────
    console.log('\n  --- Probe A: expired token GET ---');
    const { rawToken: expTokenA, maskedEmail: maskedA } = await insertExpiredRow(pool, contactId);
    const resA = await httpGet(BASE, `/api/customer-info/${expTokenA}`);
    record('A.status', resA.status === 410,
      `GET expired token → status=${resA.status} (expected 410)`);
    record('A.status-field', resA.json?.status === 'expired',
      `status field="${resA.json?.status}" (expected "expired")`);
    record('A.masked-email', typeof resA.json?.maskedEmail === 'string' && resA.json.maskedEmail.length > 0,
      `maskedEmail="${resA.json?.maskedEmail}"`);

    // ── Probe B: Successful resend — new DB row + resend log entry ─────────────
    console.log('\n  --- Probe B: successful resend ---');
    const { rawToken: expTokenB } = await insertExpiredRow(pool, contactId);
    const rowsBefore = parseInt(
      (await pool.query(
        `SELECT COUNT(*) AS cnt FROM customer_info_submissions WHERE contact_id = $1`,
        [contactId]
      )).rows[0].cnt, 10
    );

    const resB = await httpPost(BASE, `/api/customer-info/${expTokenB}/resend-expired`,
      { captchaToken: 'ci-bypass' });
    record('B.status', resB.status === 200,
      `status=${resB.status} body=${JSON.stringify(resB.json).slice(0, 200)}`);
    record('B.ok-flag', resB.json?.ok === true, `ok=${resB.json?.ok}`);
    record('B.masked-email', typeof resB.json?.maskedEmail === 'string',
      `maskedEmail="${resB.json?.maskedEmail}"`);

    const rowsAfter = parseInt(
      (await pool.query(
        `SELECT COUNT(*) AS cnt FROM customer_info_submissions WHERE contact_id = $1`,
        [contactId]
      )).rows[0].cnt, 10
    );
    record('B.new-row', rowsAfter === rowsBefore + 1,
      `rows before=${rowsBefore} after=${rowsAfter} (expected +1)`);

    const hashB = crypto.createHash('sha256').update(expTokenB).digest('hex');
    const logCntB = parseInt(
      (await pool.query(
        `SELECT COUNT(*) AS cnt FROM customer_info_resend_log WHERE token_hash = $1`,
        [hashB]
      )).rows[0].cnt, 10
    );
    record('B.resend-log', logCntB === 1,
      `customer_info_resend_log entries for token=${logCntB} (expected 1)`);

    // B.form-link: the new submission row must have form_link populated
    const freshRowB = await pool.query(
      `SELECT form_link FROM customer_info_submissions
       WHERE contact_id = $1 AND token_hash != $2
       ORDER BY created_at DESC LIMIT 1`,
      [contactId, crypto.createHash('sha256').update(expTokenB).digest('hex')]
    );
    const formLinkB = freshRowB.rows[0]?.form_link;
    record('B.form-link',
      typeof formLinkB === 'string' && formLinkB.includes('/customer-info/'),
      `form_link="${formLinkB}"`);

    // ── Probe F: New link validity — extracted from invitation email ───────────
    // Run F immediately after B so the mail file only contains B's email.
    console.log('\n  --- Probe F: new link validity ---');
    const mails = readMailJsonl(mailFile);
    let freshRawToken = null;
    for (const mail of mails) {
      // The invitation email body contains the full form URL:
      // <appBaseUrl>/customer-info/<64-hex-token>
      const text = typeof mail.text === 'string' ? mail.text : '';
      const html = typeof mail.html === 'string' ? mail.html : '';
      const m = (text + html).match(/\/customer-info\/([a-f0-9]{64})/);
      if (m) { freshRawToken = m[1]; break; }
    }
    if (!freshRawToken) {
      record('F.token-extracted', false, 'Could not extract fresh token from mail file');
    } else {
      record('F.token-extracted', true, `extracted 64-char hex token from invitation email`);
      const resF = await httpGet(BASE, `/api/customer-info/${freshRawToken}`);
      record('F.status', resF.status === 200,
        `GET fresh token → status=${resF.status} (expected 200)`);
      const hasData = typeof resF.json?.maskedEmail === 'string' || typeof resF.json?.contactName === 'string';
      record('F.has-data', hasData,
        `maskedEmail="${resF.json?.maskedEmail}" contactName="${resF.json?.contactName}"`);
    }

    // ── Probe C: Per-token rate limit (max 3 per 24h) ─────────────────────────
    // Pre-seed 3 log entries directly into the DB so we don't spend IP budget
    // on 3 real HTTP round-trips before the limit fires.
    console.log('\n  --- Probe C: per-token rate limit ---');
    const { rawToken: expTokenC } = await insertExpiredRow(pool, contactId);
    const hashC = crypto.createHash('sha256').update(expTokenC).digest('hex');
    for (let i = 0; i < 3; i++) {
      await pool.query(
        `INSERT INTO customer_info_resend_log (token_hash) VALUES ($1)`,
        [hashC]
      );
    }
    const resC = await httpPost(BASE, `/api/customer-info/${expTokenC}/resend-expired`,
      { captchaToken: 'ci-bypass' });
    record('C.status', resC.status === 429,
      `status=${resC.status} (expected 429 per-token rate limit)`);

    // ── Probe D: Submitted token returns 400 ──────────────────────────────────
    console.log('\n  --- Probe D: submitted token ---');
    const subToken = await insertSubmittedRow(pool, contactId);
    const resD = await httpPost(BASE, `/api/customer-info/${subToken}/resend-expired`,
      { captchaToken: 'ci-bypass' });
    record('D.status', resD.status === 400,
      `status=${resD.status} (expected 400 already submitted)`);

    // ── Probe E: Non-existent token returns 404 ───────────────────────────────
    console.log('\n  --- Probe E: non-existent token ---');
    const fakeToken = crypto.randomBytes(32).toString('hex');
    const resE = await httpPost(BASE, `/api/customer-info/${fakeToken}/resend-expired`,
      { captchaToken: 'ci-bypass' });
    record('E.status', resE.status === 404,
      `status=${resE.status} (expected 404 not found)`);

    exitCode = findings.every(f => f.ok) ? 0 : 1;
  } catch (e) {
    console.error('  fatal:', e.stack || e.message);
    record('harness', false, `fatal: ${e.message}`);
    exitCode = 1;
  } finally {
    try { await cleanup(pool, contactId); } catch {}
    try { await cleanupTestData(pool); } catch {}
    try { child.kill('SIGTERM'); } catch {}
    await pool.end().catch(() => {});
    try { fs.unlinkSync(mailFile); } catch {}

    const allOk  = findings.every(f => f.ok);
    const lines  = [
      '# customer-info-resend findings',
      '',
      `Run: ${new Date().toISOString()}`,
      `Result: ${allOk ? 'PASS' : 'FAIL'} (${findings.filter(f => f.ok).length}/${findings.length})`,
      '',
      '| ID | Result | Detail |',
      '|----|--------|--------|',
      ...findings.map(f =>
        `| ${f.id} | ${f.ok ? 'PASS' : 'FAIL'} | ${String(f.detail).replace(/\|/g, '\\|')} |`
      ),
    ];
    try {
      fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
      fs.writeFileSync(REPORT_PATH, lines.join('\n') + '\n');
      console.log(`\n  report -> ${REPORT_PATH}`);
    } catch (e) {
      console.warn('  report write failed:', e.message);
    }
  }

  process.exit(exitCode);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
