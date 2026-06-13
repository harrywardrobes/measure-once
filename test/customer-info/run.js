'use strict';
const { makeSkip3 } = require('../helpers/report');
// test/customer-info/run.js
//
// Regression coverage for the upload_photos_and_info card action handler.
// Exercises the full customer-info flow end-to-end via HTTP probes:
//
//   (CI-1)  POST /api/card-actions/upload-photos-and-info → 200 ok, token in DB
//   (CI-2)  GET  /api/customer-info/:token → 200, masked email + name
//   (CI-3)  POST /api/customer-info/:token/photos → 200, key list returned
//   (CI-4)  POST /api/customer-info/:token (submit) → 200, emails sent
//   (CI-5)  GET  /api/customer-info/by-contact/:contactId → list with photoUrls
//   (CI-R1) POST /api/customer-info/by-contact/:contactId/resend (admin) → 200, new DB row, old rows preserved
//   (CI-R2) POST /api/customer-info/by-contact/:contactId/resend (viewer) → 403
//   (CI-R3) POST /api/customer-info/by-contact/not-a-number/resend → 400
//   (CI-LS-1) GET /api/customer-info/by-contact/:contactId/link-status (admin) → hasActiveLink + formLink + token
//   (CI-LS-2) GET /api/customer-info/by-contact/:contactId/link-status (member) → hasActiveLink only, no formLink
//   (CI-6)  GET  /api/customer-info/:token (expired) → 410 status:expired
//   (CI-7)  GET  /api/customer-info/:token (already submitted) → 410 status:submitted
//   (CI-8)  POST /api/customer-info/:token (expired) → 410 status:expired
//   (CI-9)  POST /api/customer-info/:token (already submitted) → 410 status:submitted
//   (CI-UI-A) Admin on /customers/:contactId sees [data-testid="resend-link-btn"]
//   (CI-UI-B) Viewer on /customers/:contactId does NOT see [data-testid="resend-link-btn"]
//
// Overrides used:
//   HUBSPOT_API_BASE_OVERRIDE  — local mock HubSpot for contact fetch + PATCH
//   MAIL_TRANSPORT_FILE_OVERRIDE — captures sendMail payloads as JSONL
//   NODE_OPTIONS=--require .../preload-object-storage-stub.js — in-memory storage
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:customer-info
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:customer-info

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const http   = require('http');
const crypto = require('crypto');
const { Pool } = require('pg');
const { pollFn, pollUntil } = require('../helpers/poll');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

require('dotenv').config();

const REPORT_PATH = path.join(__dirname, '..', '..', 'test-results', 'customer-info.md');
const findings    = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${id} — ${detail}`);
}
const skip = makeSkip3(findings);

// ── Mock HubSpot server ────────────────────────────────────────────────────────
function startMockHubSpot(contactId, contactProps) {
  const state = { patches: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = raw ? (() => { try { return JSON.parse(raw); } catch { return {}; } })() : {};

      // GET contact — match any numeric contact ID so resend probes with a
      // fresh contactId don't hit the catch-all 404.
      const anyContactGet = req.method === 'GET'
        && /^\/crm\/v3\/objects\/contacts\/\d+/.test(req.url);
      if (anyContactGet) {
        const idM = req.url.match(/\/contacts\/(\d+)/);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          id: idM ? idM[1] : contactId,
          properties: contactProps,
        }));
      }
      // PATCH contact (lead status + substatus updates)
      if (req.method === 'PATCH' && req.url.startsWith(`/crm/v3/objects/contacts/${contactId}`)) {
        state.patches.push(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: contactId, properties: {} }));
      }
      // POST lead_substatuses are inserted in the DB, not HubSpot, so only
      // contacts calls are expected. Catch-all 404 for anything unexpected.
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found', path: req.url }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, state });
    });
  });
}

// ── Mail helper ───────────────────────────────────────────────────────────────
function readMailJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
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

async function getTokenHashForContact(pool, contactId) {
  const r = await pool.query(
    `SELECT token_hash FROM customer_info_submissions WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [contactId]
  );
  return r.rows[0]?.token_hash || null;
}

async function insertExpiredRow(pool, contactId) {
  const rawToken  = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiredAt = new Date(Date.now() - 60000); // 1 minute ago
  await pool.query(
    `INSERT INTO customer_info_submissions
       (contact_id, contact_name, contact_email, token_hash, expires_at,
        masked_email, masked_phone)
     VALUES ($1, 'Expired User', 'expired@test.local', $2, $3, 'e***@***.local', '07***1234')`,
    [contactId, tokenHash, expiredAt.toISOString()]
  );
  return rawToken;
}

async function insertSubmittedRow(pool, contactId) {
  const rawToken  = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 86400000);
  await pool.query(
    `INSERT INTO customer_info_submissions
       (contact_id, contact_name, contact_email, token_hash, expires_at, submitted_at,
        masked_email, masked_phone, address_line1, city, postcode, room_count, photo_keys)
     VALUES ($1, 'Done User', 'done@test.local', $2, $3, NOW(),
             'd***@***.local', '07***0000', '1 Main St', 'London', 'SW1A 1AA', '2', '[]'::jsonb)`,
    [contactId, tokenHash, expiresAt.toISOString()]
  );
  return rawToken;
}

/**
 * Insert an active (non-expired, non-submitted) row with form_link = NULL.
 * Simulates a pre-migration row where the raw token was never stored and the
 * Copy/Open URLs cannot be reconstructed without a staff resend.
 */
async function insertActiveNullFormLinkRow(pool, contactId) {
  const rawToken  = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 86_400_000); // 24 h from now
  await pool.query(
    `INSERT INTO customer_info_submissions
       (contact_id, contact_name, contact_email, token_hash, expires_at,
        masked_email, masked_phone, form_link)
     VALUES ($1, 'Pre-migration User', 'premig@test.local', $2, $3,
             'p***@***.local', '07***5678', NULL)`,
    [contactId, tokenHash, expiresAt.toISOString()]
  );
}

async function cleanup(pool, contactId) {
  try {
    await pool.query(`DELETE FROM customer_info_submissions WHERE contact_id = $1`, [contactId]);
  } catch {}
}

// ── Puppeteer helpers ─────────────────────────────────────────────────────────
function parseCookieKV(jar) {
  if (!jar) return null;
  const idx = jar.indexOf('=');
  if (idx < 0) return null;
  return { name: jar.slice(0, idx), value: jar.slice(idx + 1) };
}

async function injectSession(page, jar, base) {
  const kv = parseCookieKV(jar);
  if (!kv) return;
  const { hostname } = new URL(base);
  await page.setCookie({
    name: kv.name, value: kv.value,
    domain: hostname, path: '/', httpOnly: true,
  });
}

// ── Validation probe helper ───────────────────────────────────────────────────
// Used by CI-V probes: POST the submit endpoint with a partial / invalid body
// and assert the server returns 400 with an `error` field.
async function postSubmit(base, token, body) {
  const res = await fetch(`${base}/api/customer-info/${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
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

  const runId    = Math.random().toString(36).slice(2, 8);
  // contactId must be all-digit (the route validates /^\d+$/)
  const contactId  = String(900000000 + Math.floor(Math.random() * 99999999));
  // Separate contactId for CI-UI-C: a contact with only a pre-migration row
  // (form_link = NULL) so Copy/Open buttons are absent until after a resend.
  const contactIdC = String(700000000 + Math.floor(Math.random() * 99999999));

  console.log(`\n  customer-info  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });

  const contactProps = {
    email:       `cust-${runId}@privtest.local`,
    mobilephone: '+447911000001',
    phone:       '+44201000001',
    firstname:   'TestFirst',
    lastname:    'TestLast',
  };

  const mockHs = await startMockHubSpot(contactId, contactProps);
  console.log(`  mock HubSpot on http://127.0.0.1:${mockHs.port}`);

  const mailFile = path.join(os.tmpdir(), `ci-mail-${runId}.jsonl`);
  try { fs.unlinkSync(mailFile); } catch {}

  const stubPath = path.join(__dirname, 'preload-object-storage-stub.js');

  // Set env vars before requiring the harness so spawnServer picks them up.
  process.env.HUBSPOT_API_BASE_OVERRIDE      = `http://127.0.0.1:${mockHs.port}`;
  process.env.MAIL_TRANSPORT_FILE_OVERRIDE   = mailFile;
  process.env.PRIVTEST_USE_HUBSPOT_ACCESS_TOKEN = '1';
  process.env.HUBSPOT_ACCESS_TOKEN           = process.env.HUBSPOT_ACCESS_TOKEN || 'ci-test-fake-hs-token';
  process.env.PRIVTEST_USE_ADMIN_EMAILS      = '1';
  process.env.ADMIN_EMAILS                   = `admin-ci-${runId}@privtest.local`;

  const harness = require('../privileges/harness');
  const { spawnServer, waitForServer, seedUsers, cleanupTestData,
          resetRateLimitStore, login, TEST_PORT } = harness;
  const BASE = `http://127.0.0.1:${TEST_PORT}`;
  harness.setPool(pool);

  await cleanupTestData(pool);
  await resetRateLimitStore(pool);
  await cleanup(pool, contactId);
  await cleanup(pool, contactIdC);

  const { child } = spawnServer({
    nodeOptions: `--require ${stubPath}`,
  });

  let exitCode = 1;
  let rawToken = null;

  try {
    await waitForServer();
    console.log('  test server up');

    await waitForTable(pool, 'customer_info_submissions');

    const users  = await seedUsers(pool, runId);
    const member = users.member;
    const admin  = users.admin;
    const viewer = users.viewer;
    const client = await login(member.email, member.password);
    const adminClient  = await login(admin.email,  admin.password);
    const viewerClient = await login(viewer.email, viewer.password);

    // ── CI-1: POST /api/card-actions/upload-photos-and-info ─────────────────
    const createRes = await client.post('/api/card-actions/upload-photos-and-info', { contactId });
    const createOk  = createRes.status === 201 && createRes.json?.ok === true;
    record('CI-1.create-link', createOk,
      createOk
        ? `POST returned 201 ok=true`
        : `status=${createRes.status} body=${createRes.text.slice(0, 200)}`);

    // Verify DB row exists
    const tokenHash = await getTokenHashForContact(pool, contactId);
    record('CI-1.token-in-db', !!tokenHash,
      tokenHash ? `token_hash stored in DB` : `no row found for contactId=${contactId}`);

    // Verify invite email was sent
    const inviteMails = readMailJsonl(mailFile);
    const inviteEmail = inviteMails.find(m =>
      typeof m.to === 'string' && m.to.includes(contactProps.email)
    );
    record('CI-1.invite-email', !!inviteEmail,
      inviteEmail
        ? `invite email captured to ${contactProps.email} subject="${inviteEmail.subject}"`
        : `no invite email to ${contactProps.email} (${inviteMails.length} mail(s): ${inviteMails.map(m => m.to).join(', ')})`);

    // ── Derive the raw token from the invite email link ──────────────────────
    if (inviteEmail) {
      const src = (inviteEmail.text || '') + (inviteEmail.html || '');
      const m = src.match(/customer-info\/([a-f0-9]{64})/);
      rawToken = m ? m[1] : null;
    }
    // Fallback: look up raw token by hash from DB (derive cannot without collision)
    // If the email link couldn't be parsed we'll skip dependent probes gracefully.

    // ── CI-2: GET /api/customer-info/:token ──────────────────────────────────
    if (rawToken) {
      const getRes = await fetch(`${BASE}/api/customer-info/${rawToken}`);
      const getBody = await getRes.json().catch(() => null);
      const getOk = getRes.status === 200
        && getBody
        && typeof getBody.maskedEmail === 'string'
        && typeof getBody.contactName === 'string';
      record('CI-2.get-form-data', getOk,
        getOk
          ? `GET 200 maskedEmail="${getBody.maskedEmail}" name="${getBody.contactName}"`
          : `status=${getRes.status} body=${JSON.stringify(getBody).slice(0, 200)}`);

      const maskedOk = getOk && !getBody.maskedEmail.includes(contactProps.email)
        && getBody.maskedEmail.includes('***');
      record('CI-2.email-masked', maskedOk,
        maskedOk
          ? `email is masked (contains ***)`
          : `email not properly masked: "${getBody?.maskedEmail}"`);
    } else {
      record('CI-2.get-form-data', false, 'skipped — no rawToken extracted from invite email');
      record('CI-2.email-masked', false, 'skipped — no rawToken');
    }

    // ── CI-3: POST /api/customer-info/:token/photos ──────────────────────────
    let uploadedKeys = [];
    if (rawToken) {
      // Build a minimal JPEG-like buffer (valid enough for multer's mimetype filter)
      const jpegBuf = Buffer.from(
        'ffd8ffe000104a46494600010100000100010000ffdb004300' +
        '080606070605080707070909080a0c140d0c0b0b0c1912130f1421242223211f' +
        '2725252028302122303228 ffe2000c4943435f50524f46494c450001',
        'hex'
      );

      const fd = new FormData();
      fd.append('photos', new Blob([jpegBuf], { type: 'image/jpeg' }), 'room.jpg');

      const uploadRes = await fetch(`${BASE}/api/customer-info/${rawToken}/photos`, {
        method: 'POST',
        body: fd,
      });
      const uploadBody = await uploadRes.json().catch(() => null);
      const uploadOk = uploadRes.status === 200
        && uploadBody?.ok === true
        && Array.isArray(uploadBody?.keys)
        && uploadBody.keys.length === 1
        && uploadBody.keys[0].startsWith('obj:ci_');
      record('CI-3.photo-upload', uploadOk,
        uploadOk
          ? `POST 200 keys=${JSON.stringify(uploadBody.keys)}`
          : `status=${uploadRes.status} body=${JSON.stringify(uploadBody).slice(0, 300)}`);
      if (uploadOk) uploadedKeys = uploadBody.keys;
    } else {
      record('CI-3.photo-upload', false, 'skipped — no rawToken');
    }

    // ── CI-V: Input validation probes ────────────────────────────────────────
    // CI-V1 – no contactId on the upload-photos-and-info action
    const noContactIdRes = await client.post('/api/card-actions/upload-photos-and-info', {});
    const noContactId400 = noContactIdRes.status === 400 && noContactIdRes.json?.error;
    record('CI-V1.no-contactId',
      noContactId400,
      noContactId400
        ? `400 error="${noContactIdRes.json.error}"`
        : `status=${noContactIdRes.status} body=${noContactIdRes.text.slice(0, 200)}`);

    if (rawToken) {
      // Base for valid fields (roomCount and photoKeys are fine; we vary address fields)
      const validBase = {
        correctedEmail: '', correctedMobile: '',
        addressLine1: '42 Test Road', city: 'Manchester', postcode: 'M1 1AA',
        roomCount: '2', roomNotes: '', photoKeys: uploadedKeys,
      };

      // CI-V2 – missing addressLine1 → 400
      const v2 = await postSubmit(BASE, rawToken, { ...validBase, addressLine1: '' });
      const v2Ok = v2.status === 400 && v2.json?.error;
      record('CI-V2.missing-addressLine1',
        v2Ok,
        v2Ok
          ? `400 error="${v2.json.error}"`
          : `status=${v2.status} body=${JSON.stringify(v2.json).slice(0, 200)}`);

      // CI-V3 – invalid roomCount ('5') → 400
      const v3 = await postSubmit(BASE, rawToken, { ...validBase, roomCount: '5' });
      const v3Ok = v3.status === 400 && v3.json?.error;
      record('CI-V3.invalid-roomCount',
        v3Ok,
        v3Ok
          ? `400 error="${v3.json.error}"`
          : `status=${v3.status} body=${JSON.stringify(v3.json).slice(0, 200)}`);

      // CI-V4 – missing city → 400
      const v4 = await postSubmit(BASE, rawToken, { ...validBase, city: '' });
      const v4Ok = v4.status === 400 && v4.json?.error;
      record('CI-V4.missing-city',
        v4Ok,
        v4Ok
          ? `400 error="${v4.json.error}"`
          : `status=${v4.status} body=${JSON.stringify(v4.json).slice(0, 200)}`);

      // CI-V5 – missing postcode → 400
      const v5 = await postSubmit(BASE, rawToken, { ...validBase, postcode: '' });
      const v5Ok = v5.status === 400 && v5.json?.error;
      record('CI-V5.missing-postcode',
        v5Ok,
        v5Ok
          ? `400 error="${v5.json.error}"`
          : `status=${v5.status} body=${JSON.stringify(v5.json).slice(0, 200)}`);

      // CI-V6 – photo upload with no files → 400
      const emptyFd = new FormData();
      const noFileRes = await fetch(`${BASE}/api/customer-info/${rawToken}/photos`, {
        method: 'POST',
        body: emptyFd,
      });
      const noFileBody = await noFileRes.json().catch(() => null);
      const v6Ok = noFileRes.status === 400 && noFileBody?.error;
      record('CI-V6.no-photos',
        v6Ok,
        v6Ok
          ? `400 error="${noFileBody.error}"`
          : `status=${noFileRes.status} body=${JSON.stringify(noFileBody).slice(0, 200)}`);

      // CI-V7 – photoKeys entry with wrong namespace prefix → 400
      const v7 = await postSubmit(BASE, rawToken, { ...validBase, photoKeys: ['obj:dv_badkey'] });
      const v7Ok = v7.status === 400 && v7.json?.error;
      record('CI-V7.bad-photo-key-prefix',
        v7Ok,
        v7Ok
          ? `400 error="${v7.json.error}"`
          : `status=${v7.status} body=${JSON.stringify(v7.json).slice(0, 200)}`);

      // CI-V7b – empty-string key → 400
      const v7b = await postSubmit(BASE, rawToken, { ...validBase, photoKeys: [''] });
      const v7bOk = v7b.status === 400 && v7b.json?.error;
      record('CI-V7.empty-photo-key',
        v7bOk,
        v7bOk
          ? `400 error="${v7b.json.error}"`
          : `status=${v7b.status} body=${JSON.stringify(v7b.json).slice(0, 200)}`);

      // CI-V7c – non-string key (integer) → 400
      const v7c = await postSubmit(BASE, rawToken, { ...validBase, photoKeys: [42] });
      const v7cOk = v7c.status === 400 && v7c.json?.error;
      record('CI-V7.non-string-photo-key',
        v7cOk,
        v7cOk
          ? `400 error="${v7c.json.error}"`
          : `status=${v7c.status} body=${JSON.stringify(v7c.json).slice(0, 200)}`);

      // CI-V7d – bare prefix with no suffix ('obj:ci_') → 400
      const v7d = await postSubmit(BASE, rawToken, { ...validBase, photoKeys: ['obj:ci_'] });
      const v7dOk = v7d.status === 400 && v7d.json?.error;
      record('CI-V7.bare-prefix-photo-key',
        v7dOk,
        v7dOk
          ? `400 error="${v7d.json.error}"`
          : `status=${v7d.status} body=${JSON.stringify(v7d.json).slice(0, 200)}`);
    } else {
      for (const id of ['CI-V2.missing-addressLine1', 'CI-V3.invalid-roomCount',
                         'CI-V4.missing-city', 'CI-V5.missing-postcode', 'CI-V6.no-photos',
                         'CI-V7.bad-photo-key-prefix', 'CI-V7.empty-photo-key',
                         'CI-V7.non-string-photo-key', 'CI-V7.bare-prefix-photo-key']) {
        record(id, false, 'skipped — no rawToken');
      }
    }

    // ── CI-4: POST /api/customer-info/:token (submit) ────────────────────────
    const mailsBeforeSubmit = readMailJsonl(mailFile).length;
    if (rawToken) {
      const submitRes = await fetch(`${BASE}/api/customer-info/${rawToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          correctedEmail:  '',
          correctedMobile: '',
          addressLine1:    '42 Test Road',
          city:            'Manchester',
          postcode:        'M1 1AA',
          roomCount:       '2',
          roomNotes:       'Living room and bedroom',
          photoKeys:       uploadedKeys,
        }),
      });
      const submitBody = await submitRes.json().catch(() => null);
      const submitOk = submitRes.status === 200 && submitBody?.ok === true;
      record('CI-4.submit', submitOk,
        submitOk
          ? `POST 200 ok=true`
          : `status=${submitRes.status} body=${JSON.stringify(submitBody).slice(0, 200)}`);

      // Verify submission recorded in DB
      const subR = await pool.query(
        `SELECT submitted_at, address_line1, room_count, photo_keys
         FROM customer_info_submissions WHERE contact_id = $1 AND submitted_at IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
        [contactId]
      );
      const row = subR.rows[0];
      const dbOk = !!row && row.address_line1 === '42 Test Road' && row.room_count === '2';
      record('CI-4.submission-in-db', dbOk,
        dbOk
          ? `DB row has submitted_at, address_line1="${row.address_line1}", room_count="${row.room_count}"`
          : `DB row missing or incorrect: ${JSON.stringify(row).slice(0, 200)}`);

      // Wait briefly for emails to land
      let mailsAfter = readMailJsonl(mailFile);
      await pollFn(async () => {
        mailsAfter = readMailJsonl(mailFile);
        return mailsAfter.length > mailsBeforeSubmit ? true : null;
      }, 4000, 100);

      const newMails = mailsAfter.slice(mailsBeforeSubmit);
      const adminEmail = newMails.find(m =>
        typeof m.to === 'string' && m.to.includes(`admin-ci-${runId}@privtest.local`)
      );
      record('CI-4.admin-email', !!adminEmail,
        adminEmail
          ? `admin notification email captured subject="${adminEmail.subject}"`
          : `no admin notification email (${newMails.length} new mail(s): ${newMails.map(m => m.to).join(', ')})`);

      const thankYouEmail = newMails.find(m =>
        typeof m.to === 'string' && m.to.includes(contactProps.email)
        && typeof m.subject === 'string' && m.subject.toLowerCase().includes('thank')
      );
      record('CI-4.thankyou-email', !!thankYouEmail,
        thankYouEmail
          ? `thank-you email captured subject="${thankYouEmail.subject}"`
          : `no thank-you email (${newMails.length} new mail(s): ${newMails.map(m => m.to + ' subj=' + m.subject).join(' | ')})`);
    } else {
      record('CI-4.submit', false, 'skipped — no rawToken');
      record('CI-4.submission-in-db', false, 'skipped — no rawToken');
      record('CI-4.admin-email', false, 'skipped — no rawToken');
      record('CI-4.thankyou-email', false, 'skipped — no rawToken');
    }

    // ── CI-5: GET /api/customer-info/by-contact/:contactId ───────────────────
    const listRes = await adminClient.get(`/api/customer-info/by-contact/${contactId}`);
    const listBody = listRes.json;
    const listOk = listRes.status === 200
      && Array.isArray(listBody)
      && listBody.length >= 1;
    record('CI-5.by-contact', listOk,
      listOk
        ? `GET 200, ${listBody.length} row(s) returned`
        : `status=${listRes.status} body=${listRes.text.slice(0, 200)}`);

    if (listOk) {
      const submittedRow = listBody.find(r => r.submitted_at);
      const hasPhotoUrls = submittedRow && Array.isArray(submittedRow.photoUrls);
      record('CI-5.photo-urls', hasPhotoUrls,
        hasPhotoUrls
          ? `photoUrls field present (${submittedRow.photoUrls.length} url(s))`
          : `photoUrls missing on submitted row: ${JSON.stringify(submittedRow).slice(0, 200)}`);
    } else {
      record('CI-5.photo-urls', false, 'skipped — list response was not 200 array');
    }

    // ── CI-R1: POST resend (admin) → 200, new row in DB, old rows preserved ──
    const rowsBeforeResend = await pool.query(
      `SELECT id FROM customer_info_submissions WHERE contact_id = $1`,
      [contactId]
    );
    const countBefore = rowsBeforeResend.rowCount;

    const mailsBeforeResend = readMailJsonl(mailFile).length;
    const resendRes = await adminClient.post(`/api/customer-info/by-contact/${contactId}/resend`);
    const resendOk = resendRes.status === 200 && resendRes.json?.ok === true;
    record('CI-R1.resend-200', resendOk,
      resendOk
        ? `POST 200 ok=true`
        : `status=${resendRes.status} body=${resendRes.text.slice(0, 200)}`);

    const rowsAfterResend = await pool.query(
      `SELECT id FROM customer_info_submissions WHERE contact_id = $1`,
      [contactId]
    );
    const countAfter = rowsAfterResend.rowCount;
    const newRowAdded = countAfter === countBefore + 1;
    record('CI-R1.new-row-added', newRowAdded,
      newRowAdded
        ? `row count grew from ${countBefore} to ${countAfter}`
        : `row count before=${countBefore} after=${countAfter} (expected +1)`);

    // Wait briefly for resend invite email to land
    const mailsAfterResend = await pollFn(
      () => {
        const mails = readMailJsonl(mailFile);
        return mails.length > mailsBeforeResend ? mails : null;
      },
      4000,
      100,
    ) ?? readMailJsonl(mailFile);
    const resendNewMails = mailsAfterResend.slice(mailsBeforeResend);
    const resendInviteEmail = resendNewMails.find(m =>
      typeof m.to === 'string' && m.to.includes(contactProps.email)
    );
    record('CI-R1.resend-email-sent', !!resendInviteEmail,
      resendInviteEmail
        ? `resend invite email captured to ${contactProps.email} subject="${resendInviteEmail.subject}"`
        : `no resend invite email (${resendNewMails.length} new mail(s): ${resendNewMails.map(m => m.to).join(', ')})`);

    // ── CI-R2: Viewer → 403 ───────────────────────────────────────────────────
    const viewerResendRes = await viewerClient.post(`/api/customer-info/by-contact/${contactId}/resend`);
    const viewerResend403 = viewerResendRes.status === 403;
    record('CI-R2.viewer-403', viewerResend403,
      viewerResend403
        ? `viewer correctly received 403`
        : `status=${viewerResendRes.status} body=${viewerResendRes.text.slice(0, 200)}`);

    // ── CI-R3: Invalid (non-numeric) contactId → 400 ──────────────────────────
    const badIdResendRes = await adminClient.post(`/api/customer-info/by-contact/not-a-valid-id/resend`);
    const badIdResend400 = badIdResendRes.status === 400;
    record('CI-R3.invalid-id-400', badIdResend400,
      badIdResend400
        ? `non-numeric contactId correctly received 400`
        : `status=${badIdResendRes.status} body=${badIdResendRes.text.slice(0, 200)}`);

    // ── CI-LS-1: link-status (admin) → hasActiveLink + formLink + token ──────
    // At this point CI-R1 has created a fresh unsubmitted row so link-status
    // should report hasActiveLink: true with bearer details for admin/manager.
    const lsAdminRes = await adminClient.get(`/api/customer-info/by-contact/${contactId}/link-status`);
    const lsAdminBody = lsAdminRes.json;
    const lsAdminOk = lsAdminRes.status === 200
      && lsAdminBody?.hasActiveLink === true
      && typeof lsAdminBody?.formLink === 'string' && lsAdminBody.formLink.length > 0
      && typeof lsAdminBody?.token === 'string'    && lsAdminBody.token.length > 0;
    record('CI-LS-1.admin-gets-form-link', lsAdminOk,
      lsAdminOk
        ? `GET 200 hasActiveLink=true formLink present token present`
        : `status=${lsAdminRes.status} hasActiveLink=${lsAdminBody?.hasActiveLink} `
          + `formLink=${JSON.stringify(lsAdminBody?.formLink)} token=${JSON.stringify(lsAdminBody?.token)}`);

    // ── CI-LS-2: link-status (member) → hasActiveLink only, no formLink ──────
    const lsMemberRes = await client.get(`/api/customer-info/by-contact/${contactId}/link-status`);
    const lsMemberBody = lsMemberRes.json;
    const lsMemberOk = lsMemberRes.status === 200
      && lsMemberBody?.hasActiveLink === true
      && lsMemberBody?.formLink === undefined
      && lsMemberBody?.token === undefined;
    record('CI-LS-2.member-no-form-link', lsMemberOk,
      lsMemberOk
        ? `GET 200 hasActiveLink=true formLink absent token absent (as expected for member)`
        : `status=${lsMemberRes.status} hasActiveLink=${lsMemberBody?.hasActiveLink} `
          + `formLink=${JSON.stringify(lsMemberBody?.formLink)} token=${JSON.stringify(lsMemberBody?.token)}`);

    // ── CI-6: Expired token → 410 status:expired (GET) ──────────────────────
    const expiredToken = await insertExpiredRow(pool, `${contactId}-exp`);
    const expGetRes = await fetch(`${BASE}/api/customer-info/${expiredToken}`);
    const expGetBody = await expGetRes.json().catch(() => null);
    const expGetOk = expGetRes.status === 410 && expGetBody?.status === 'expired';
    record('CI-6.expired-get', expGetOk,
      expGetOk
        ? `GET 410 status=expired`
        : `status=${expGetRes.status} body=${JSON.stringify(expGetBody).slice(0, 200)}`);

    // ── CI-7: Already-submitted token → 410 status:submitted (GET) ───────────
    const submittedToken = await insertSubmittedRow(pool, `${contactId}-sub`);
    const subGetRes = await fetch(`${BASE}/api/customer-info/${submittedToken}`);
    const subGetBody = await subGetRes.json().catch(() => null);
    const subGetOk = subGetRes.status === 410 && subGetBody?.status === 'submitted';
    record('CI-7.submitted-get', subGetOk,
      subGetOk
        ? `GET 410 status=submitted`
        : `status=${subGetRes.status} body=${JSON.stringify(subGetBody).slice(0, 200)}`);

    // ── CI-8: Expired token → 410 on POST submit ─────────────────────────────
    const expPostRes = await fetch(`${BASE}/api/customer-info/${expiredToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        addressLine1: '1 Exp St', city: 'London', postcode: 'EC1A 1BB',
        roomCount: '1', roomNotes: '', photoKeys: [],
      }),
    });
    const expPostBody = await expPostRes.json().catch(() => null);
    const expPostOk = expPostRes.status === 410 && expPostBody?.status === 'expired';
    record('CI-8.expired-post', expPostOk,
      expPostOk
        ? `POST 410 status=expired`
        : `status=${expPostRes.status} body=${JSON.stringify(expPostBody).slice(0, 200)}`);

    // ── CI-9: Already-submitted token → 410 on POST submit ───────────────────
    const subPostRes = await fetch(`${BASE}/api/customer-info/${submittedToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        addressLine1: '2 Sub St', city: 'London', postcode: 'EC2A 2BB',
        roomCount: '1', roomNotes: '', photoKeys: [],
      }),
    });
    const subPostBody = await subPostRes.json().catch(() => null);
    const subPostOk = subPostRes.status === 410 && subPostBody?.status === 'submitted';
    record('CI-9.submitted-post', subPostOk,
      subPostOk
        ? `POST 410 status=submitted`
        : `status=${subPostRes.status} body=${JSON.stringify(subPostBody).slice(0, 200)}`);

    // ── CI-UI-A/B: Puppeteer — Resend button visible for admin, hidden for viewer
    const CI_UI_PROBE_LABELS = [
      'CI-UI-A.admin-sees-resend-btn',
      'CI-UI-B.viewer-no-resend-btn',
    ];
    if (!puppeteer) {
      for (const l of CI_UI_PROBE_LABELS) {
        skip(l, 'skipped — puppeteer not installed');
      }
    } else {
      const { findChromium } = require('../shared/find-chromium');
      const executablePath = findChromium() || undefined;
      let uiBrowser;
      try {
        uiBrowser = await puppeteer.launch({
          headless: true,
          executablePath,
          defaultViewport: { width: 1280, height: 900 },
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
      } catch (e) {
        for (const l of CI_UI_PROBE_LABELS) {
          skip(l, `skipped — browser launch failed: ${e.message}`);
        }
        uiBrowser = null;
      }

      if (uiBrowser) {
        // ── CI-UI-A: admin sees the Resend button ──────────────────────────
        let adminUiOk = false;
        let adminUiDetail = '';
        try {
          const adminCtx = await (uiBrowser.createBrowserContext
            ? uiBrowser.createBrowserContext()
            : uiBrowser.createIncognitoBrowserContext());
          const adminPage = await adminCtx.newPage();
          await adminPage.setCacheEnabled(false);
          await injectSession(adminPage, adminClient.cookie, BASE);
          await adminPage.goto(`${BASE}/customers/${contactId}`, {
            waitUntil: 'domcontentloaded', timeout: 25000,
          });
          // Poll directly for the Resend button — which only appears once the
          // CustomerInfoSubmissionsRail fetch completes AND privilege is non-viewer.
          // This avoids a race where we find the section element during its
          // loading state (before submissions arrive) and check too early.
          const btnFound = await pollUntil(adminPage, () =>
            !!document.querySelector('[data-testid="resend-link-btn"]'),
          12000, 200);
          adminUiOk = btnFound;
          adminUiDetail = btnFound
            ? '[data-testid="resend-link-btn"] found in admin view'
            : '[data-testid="resend-link-btn"] NOT found in admin view within 12s';
          await adminPage.close();
          await adminCtx.close().catch(() => {});
        } catch (e) {
          adminUiDetail = `error: ${e.message}`;
        }
        record('CI-UI-A.admin-sees-resend-btn', adminUiOk, adminUiDetail);

        // ── CI-UI-B: viewer does NOT see the Resend button ─────────────────
        let viewerUiOk = false;
        let viewerUiDetail = '';
        try {
          const viewerCtx = await (uiBrowser.createBrowserContext
            ? uiBrowser.createBrowserContext()
            : uiBrowser.createIncognitoBrowserContext());
          const viewerPage = await viewerCtx.newPage();
          await viewerPage.setCacheEnabled(false);
          await injectSession(viewerPage, viewerClient.cookie, BASE);
          await viewerPage.goto(`${BASE}/customers/${contactId}`, {
            waitUntil: 'domcontentloaded', timeout: 25000,
          });
          // Wait for the section to render AND for the loading state to clear
          // (spinner gone), so we confirm submissions loaded before asserting
          // button absence — this avoids a false pass on a still-loading section.
          const sectionLoaded = await pollUntil(viewerPage, () => {
            const section = document.getElementById('customer-info-submissions-section');
            if (!section) return false;
            // A loading state shows a CircularProgress; once gone, data has loaded.
            return !section.querySelector('[role="progressbar"]');
          }, 12000, 200);
          if (!sectionLoaded) {
            viewerUiDetail = '#customer-info-submissions-section did not finish loading within 12s';
          } else {
            // Brief fixed wait after load: this is a negative assertion.
            await new Promise(r => setTimeout(r, 300));
            const btnPresent = await viewerPage.evaluate(() =>
              !!document.querySelector('[data-testid="resend-link-btn"]')
            );
            viewerUiOk = !btnPresent;
            viewerUiDetail = !btnPresent
              ? '[data-testid="resend-link-btn"] correctly absent in viewer view'
              : '[data-testid="resend-link-btn"] unexpectedly present in viewer view';
          }
          await viewerPage.close();
          await viewerCtx.close().catch(() => {});
        } catch (e) {
          viewerUiDetail = `error: ${e.message}`;
        }
        record('CI-UI-B.viewer-no-resend-btn', viewerUiOk, viewerUiDetail);

        // ── CI-UI-C: form_link=NULL → Resend → Copy/Open appear (no reload) ─
        // Seed an active row with form_link = NULL for a fresh contact so the
        // rail shows the Resend button but NOT the Copy/Open buttons on first
        // load.  After clicking Resend the onResendSuccess callback triggers a
        // fresh GET .../by-contact/:contactId; the new row returned by the
        // server carries form_link, so Copy/Open buttons must appear without a
        // full page reload.
        let ciUiCOk = false;
        let ciUiCDetail = '';
        try {
          await insertActiveNullFormLinkRow(pool, contactIdC);

          const cCtx = await (uiBrowser.createBrowserContext
            ? uiBrowser.createBrowserContext()
            : uiBrowser.createIncognitoBrowserContext());
          const cPage = await cCtx.newPage();
          await cPage.setCacheEnabled(false);
          await injectSession(cPage, adminClient.cookie, BASE);
          await cPage.goto(`${BASE}/customers/${contactIdC}`, {
            waitUntil: 'domcontentloaded', timeout: 25000,
          });

          // Wait for the Resend button — confirms the null-form_link row loaded
          // and that the admin privilege gate passed.
          const resendVisibleC = await pollUntil(cPage, () =>
            !!document.querySelector('[data-testid="resend-link-btn"]'),
          12000, 200);

          if (!resendVisibleC) {
            ciUiCDetail = '[data-testid="resend-link-btn"] not found before clicking';
          } else {
            // Confirm Copy/Open buttons are absent before resend (form_link = NULL)
            const copyBeforeResend = await cPage.evaluate(() =>
              !!document.querySelector('[data-testid="copy-link-btn"]')
            );

            // Click the Resend button — triggers POST .../resend which creates a
            // new DB row with form_link populated, then calls onSuccess() →
            // loadSubmissions() → GET .../by-contact/:contactId.
            await cPage.click('[data-testid="resend-link-btn"]');

            // Poll until the Copy link button appears (new row with form_link)
            const copyFound = await pollUntil(cPage, () =>
              !!document.querySelector('[data-testid="copy-link-btn"]'),
            15000, 300);
            const openFound = await cPage.evaluate(() =>
              !!document.querySelector('[data-testid="open-link-btn"]')
            );

            ciUiCOk = !copyBeforeResend && !!copyFound && openFound;
            ciUiCDetail = ciUiCOk
              ? 'Copy/Open buttons appeared after resend without a full page reload'
              : `copyBeforeResend=${copyBeforeResend} copyAfterResend=${!!copyFound} openAfterResend=${openFound}`;
          }
          await cPage.close();
          await cCtx.close().catch(() => {});
        } catch (e) {
          ciUiCDetail = `error: ${e.message}`;
        }
        record('CI-UI-C.copy-open-after-resend', ciUiCOk, ciUiCDetail);

        await uiBrowser.close().catch(() => {});
      }
    }

    exitCode = findings.every(f => f.ok) ? 0 : 1;
  } catch (e) {
    console.error('  fatal:', e.stack || e.message);
    record('harness', false, `fatal: ${e.message}`);
    exitCode = 1;
  } finally {
    try { await cleanup(pool, contactId); } catch {}
    try { await cleanup(pool, `${contactId}-exp`); } catch {}
    try { await cleanup(pool, `${contactId}-sub`); } catch {}
    try { await cleanup(pool, contactIdC); } catch {}
    try { await cleanupTestData(pool); } catch {}
    try { child.kill('SIGTERM'); } catch {}
    try { mockHs.server.close(); } catch {}
    try { fs.unlinkSync(mailFile); } catch {}
    await pool.end().catch(() => {});

    const lines = [
      '# customer-info findings',
      '',
      `Run: ${new Date().toISOString()}`,
      `Result: ${findings.every(f => f.ok) ? 'PASS' : 'FAIL'} (${findings.filter(f => f.ok).length}/${findings.length})`,
      '',
      '| ID | Result | Detail |',
      '|----|--------|--------|',
      ...findings.map(f => `| ${f.id} | ${f.ok ? 'PASS' : f.skipped ? 'SKIP' : 'FAIL'} | ${String(f.detail).replace(/\|/g, '\\|')} |`),
    ];
    try {
      fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
      fs.writeFileSync(REPORT_PATH, lines.join('\n') + '\n');
      console.log(`  report -> ${REPORT_PATH}`);
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
