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
//   (CI-4)  POST /api/customer-info/:token (submit) → 200, emails sent; no mobile row when correctedMobile omitted
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
  // Counter for contacts created via the generic flow so each gets a unique id
  let genericContactSeq = 800000000;
  // searchResultsByEmail: optional map of email→contact to return for specific searches.
  // If not set for a given email, returns empty results (new contact path).
  const state = { patches: [], createdContacts: [], searchResultsByEmail: {} };
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
      // PATCH contact (lead status + substatus updates) — match any numeric id
      if (req.method === 'PATCH' && /^\/crm\/v3\/objects\/contacts\/\d+/.test(req.url)) {
        const idM = req.url.match(/\/contacts\/(\d+)/);
        state.patches.push({ id: idM ? idM[1] : contactId, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: idM ? idM[1] : contactId, properties: {} }));
      }
      // POST search — return configured contact for that email, or empty results
      if (req.method === 'POST' && req.url === '/crm/v3/objects/contacts/search') {
        const filters = body?.filterGroups?.[0]?.filters || [];
        const emailFilter = filters.find(f => f.propertyName === 'email');
        const emailVal = emailFilter?.value || '';
        const configured = state.searchResultsByEmail[emailVal] || null;
        const results = configured ? [configured] : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ results, total: results.length }));
      }
      // POST create contact — generic flow creates a new HubSpot contact
      if (req.method === 'POST' && req.url === '/crm/v3/objects/contacts') {
        genericContactSeq += 1;
        const newId = String(genericContactSeq);
        const created = { id: newId, properties: { ...(body.properties || {}) } };
        state.createdContacts.push(created);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(created));
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
  // Must be truthy so storage.js's getGcsBucket() proceeds to
  // require('@google-cloud/storage'), which the preload stub intercepts.
  process.env.GCS_BUCKET                     = 'fake-test-bucket';

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
    nodeOptions: `--require "${stubPath.split(path.sep).join('/')}"`,
  });

  let exitCode = 1;
  let rawToken = null;
  let genericToken = null;

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

    // Seed AWAITING_PHOTOS into lead_status_config so the submit handler's
    // assertLeadStatusKey guard passes. Uses ON CONFLICT DO NOTHING so it is
    // safe if the row is already present (e.g. when the full migration seed
    // ran first, or when CI-G7 has already seeded it on a re-run).
    try {
      await pool.query(`
        INSERT INTO lead_status_config (key, label, sort_order, is_null_row)
        VALUES ('AWAITING_PHOTOS', 'Awaiting Photos', 10, false)
        ON CONFLICT (key) DO NOTHING
      `);
    } catch { /* table may not exist in very old schemas; submit will 422 and CI-4 will fail naturally */ }

    // ── CI-4: POST /api/customer-info/:token (submit) ────────────────────────
    const mailsBeforeSubmit = readMailJsonl(mailFile).length;
    if (rawToken) {
      const submitRes = await fetch(`${BASE}/api/customer-info/${rawToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          structuredAddress: {
            addressLines: ['42 Test Road'],
            locality: 'Manchester', postalCode: 'M1 1AA',
            administrativeArea: '', country: 'GB',
          },
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
          : `DB row missing or incorrect: ${JSON.stringify(row ?? null).slice(0, 200)}`);

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

      // CI-4 submits without a phone number — the phone row must be absent from
      // both the text and HTML bodies of the admin notification email.
      // Text body: the template renders contactPhone as "Phone:        <number>"
      //   so an absent phone renders as an empty string (no "Phone:" line at all).
      // HTML body: an absent phone renders no <tr> row, so "<strong>Phone</strong>"
      //   must not appear.
      const noPhoneInText = adminEmail
        ? (typeof adminEmail.text !== 'string' || !adminEmail.text.includes('Phone:'))
        : null;
      record('CI-4.no-phone-in-email-text', noPhoneInText === true,
        noPhoneInText === true
          ? `phone row correctly absent from admin email text body`
          : noPhoneInText === null
            ? `skipped — no admin email captured`
            : `unexpected "Phone:" found in admin email text body (contact_phone should be null)`);

      const noPhoneInHtml = adminEmail
        ? (typeof adminEmail.html !== 'string' || !adminEmail.html.includes('<strong>Phone</strong>'))
        : null;
      record('CI-4.no-phone-in-email-html', noPhoneInHtml === true,
        noPhoneInHtml === true
          ? `phone row correctly absent from admin email HTML body`
          : noPhoneInHtml === null
            ? `skipped — no admin email captured`
            : `unexpected phone <tr> found in admin email HTML body (contact_phone should be null)`);

      // CI-4 submits with an empty correctedMobile — the mobile row must be absent
      // from both bodies of the admin notification email.
      // Text body: absent mobile renders as an empty string (no "Mobile:" line at all).
      // HTML body: absent mobile renders no <tr>, so "Mobile (corrected)" must not appear.
      const noMobileInText = adminEmail
        ? (typeof adminEmail.text !== 'string' || !adminEmail.text.includes('Mobile:'))
        : null;
      record('CI-4.no-mobile-in-email-text', noMobileInText === true,
        noMobileInText === true
          ? `mobile row correctly absent from admin email text body`
          : noMobileInText === null
            ? `skipped — no admin email captured`
            : `unexpected "Mobile:" found in admin email text body (corrected_mobile should be empty)`);

      const noMobileInHtml = adminEmail
        ? (typeof adminEmail.html !== 'string' || !adminEmail.html.includes('Mobile (corrected)'))
        : null;
      record('CI-4.no-mobile-in-email-html', noMobileInHtml === true,
        noMobileInHtml === true
          ? `mobile row correctly absent from admin email HTML body`
          : noMobileInHtml === null
            ? `skipped — no admin email captured`
            : `unexpected mobile <tr> found in admin email HTML body (corrected_mobile should be empty)`);
    } else {
      record('CI-4.submit', false, 'skipped — no rawToken');
      record('CI-4.submission-in-db', false, 'skipped — no rawToken');
      record('CI-4.admin-email', false, 'skipped — no rawToken');
      record('CI-4.thankyou-email', false, 'skipped — no rawToken');
      record('CI-4.no-phone-in-email-text', false, 'skipped — no rawToken');
      record('CI-4.no-phone-in-email-html', false, 'skipped — no rawToken');
      record('CI-4.no-mobile-in-email-text', false, 'skipped — no rawToken');
      record('CI-4.no-mobile-in-email-html', false, 'skipped — no rawToken');
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
          : `photoUrls missing on submitted row: ${JSON.stringify(submittedRow ?? null).slice(0, 200)}`);
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

    // ── CI-G1: POST /api/customer-info/draft → anonymous token returned ─────────
    const draftRes = await fetch(`${BASE}/api/customer-info/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const draftBody = await draftRes.json().catch(() => null);
    genericToken = draftBody?.token || null;
    const draftOk = draftRes.status === 200 && typeof genericToken === 'string' && genericToken.length === 64;
    record('CI-G1.draft-token', draftOk,
      draftOk
        ? `POST 200 token.length=${genericToken.length}`
        : `status=${draftRes.status} body=${JSON.stringify(draftBody).slice(0, 200)}`);

    // Verify DB row has is_generic=true and contact_id IS NULL
    if (genericToken) {
      const tokenHash = crypto.createHash('sha256').update(genericToken).digest('hex');
      const dbRow = await pool.query(
        `SELECT is_generic, contact_id FROM customer_info_submissions WHERE token_hash = $1`,
        [tokenHash]
      );
      const gRow = dbRow.rows[0];
      const dbOk = gRow && gRow.is_generic === true && gRow.contact_id === null;
      record('CI-G1.db-row', dbOk,
        dbOk
          ? `DB row: is_generic=true, contact_id=null`
          : `DB row: ${JSON.stringify(gRow)}`);
    } else {
      record('CI-G1.db-row', false, 'skipped — no generic token');
    }

    // ── CI-G2: GET /api/customer-info/:genericToken → { isGeneric: true } ──────
    if (genericToken) {
      const gGetRes = await fetch(`${BASE}/api/customer-info/${genericToken}`);
      const gGetBody = await gGetRes.json().catch(() => null);
      const gGetOk = gGetRes.status === 200 && gGetBody?.isGeneric === true;
      record('CI-G2.get-generic', gGetOk,
        gGetOk
          ? `GET 200 isGeneric=true`
          : `status=${gGetRes.status} body=${JSON.stringify(gGetBody).slice(0, 200)}`);
    } else {
      record('CI-G2.get-generic', false, 'skipped — no generic token');
    }

    // ── CI-G3: Generic submit — missing required fields → 400 ─────────────────
    if (genericToken) {
      const validGenericBase = {
        name: 'Jane Smith', email: 'jane@generic.local', phone: '07911123456',
        structuredAddress: {
          addressLines: ['10 Generic Lane'],
          locality: 'Manchester', postalCode: 'M1 1GG',
          administrativeArea: '', country: 'GB',
        },
        roomCount: '1', roomNotes: '', photoKeys: [],
      };

      // Missing name
      const gV1 = await postSubmit(BASE, genericToken, { ...validGenericBase, name: '' });
      record('CI-G3.missing-name',
        gV1.status === 400 && !!gV1.json?.error,
        gV1.status === 400 ? `400 error="${gV1.json.error}"` : `status=${gV1.status}`);

      // Missing email
      const gV2 = await postSubmit(BASE, genericToken, { ...validGenericBase, email: '' });
      record('CI-G3.missing-email',
        gV2.status === 400 && !!gV2.json?.error,
        gV2.status === 400 ? `400 error="${gV2.json.error}"` : `status=${gV2.status}`);

      // Invalid email (no @)
      const gV3 = await postSubmit(BASE, genericToken, { ...validGenericBase, email: 'not-an-email' });
      record('CI-G3.invalid-email',
        gV3.status === 400 && !!gV3.json?.error,
        gV3.status === 400 ? `400 error="${gV3.json.error}"` : `status=${gV3.status}`);

      // Missing phone
      const gV4 = await postSubmit(BASE, genericToken, { ...validGenericBase, phone: '' });
      record('CI-G3.missing-phone',
        gV4.status === 400 && !!gV4.json?.error,
        gV4.status === 400 ? `400 error="${gV4.json.error}"` : `status=${gV4.status}`);
    } else {
      for (const id of ['CI-G3.missing-name', 'CI-G3.missing-email', 'CI-G3.missing-email', 'CI-G3.missing-phone']) {
        record(id, false, 'skipped — no generic token');
      }
    }

    // ── CI-G4: Generic submit → creates HubSpot contact, populates DB row ──────
    const mailsBeforeGeneric = readMailJsonl(mailFile).length;
    if (genericToken) {
      const gSubmitBody = {
        name: 'Jane Generic', email: `jane-generic-${runId}@generic.local`,
        phone: '07902 819 990',
        haveWeSpoken: 'I emailed you last Tuesday about my walk-in wardrobe.',
        structuredAddress: {
          addressLines: ['10 Generic Lane'],
          locality: 'Manchester', postalCode: 'M1 1GG',
          administrativeArea: '', country: 'GB',
        },
        roomCount: '2', roomNotes: 'Two bedrooms needing fitted wardrobes.', photoKeys: [],
      };
      const gSubmitRes = await fetch(`${BASE}/api/customer-info/${genericToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gSubmitBody),
      });
      const gSubmitData = await gSubmitRes.json().catch(() => null);
      const gSubmitOk = gSubmitRes.status === 200 && gSubmitData?.ok === true;
      record('CI-G4.submit-200', gSubmitOk,
        gSubmitOk
          ? `POST 200 ok=true`
          : `status=${gSubmitRes.status} body=${JSON.stringify(gSubmitData).slice(0, 300)}`);

      if (gSubmitOk) {
        // DB row should have contact_name, contact_email, have_we_spoken populated
        const gTokenHash = crypto.createHash('sha256').update(genericToken).digest('hex');
        const gDbR = await pool.query(
          `SELECT contact_name, contact_email, have_we_spoken, submitted_at, address_line1
           FROM customer_info_submissions WHERE token_hash = $1`,
          [gTokenHash]
        );
        const gRow = gDbR.rows[0];
        const gDbOk = gRow
          && gRow.contact_name === 'Jane Generic'
          && gRow.contact_email === `jane-generic-${runId}@generic.local`
          && gRow.have_we_spoken === 'I emailed you last Tuesday about my walk-in wardrobe.'
          && gRow.submitted_at !== null
          && gRow.address_line1 === '10 Generic Lane';
        record('CI-G4.db-row-populated', gDbOk,
          gDbOk
            ? `DB: contact_name="${gRow.contact_name}" contact_email="${gRow.contact_email}" have_we_spoken present`
            : `DB row: ${JSON.stringify(gRow).slice(0, 300)}`);

        // HubSpot contact should have been created
        const hsCreated = mockHs.state.createdContacts.length > 0;
        record('CI-G4.hs-contact-created', hsCreated,
          hsCreated
            ? `HubSpot create called: id=${mockHs.state.createdContacts[0].id} email=${mockHs.state.createdContacts[0].properties.email}`
            : `No HubSpot contacts created in mock`);

        // Admin email should contain have_we_spoken text
        let adminEmailGeneric = null;
        await pollFn(async () => {
          const mails = readMailJsonl(mailFile);
          adminEmailGeneric = mails.slice(mailsBeforeGeneric)
            .find(m => typeof m.to === 'string' && m.to.includes(`admin-ci-${runId}@privtest.local`));
          return adminEmailGeneric ? true : null;
        }, 4000, 100);
        const hwsInEmail = adminEmailGeneric
          && (adminEmailGeneric.text || adminEmailGeneric.html || '')
            .includes('walk-in wardrobe');
        record('CI-G4.have-we-spoken-in-email', !!hwsInEmail,
          hwsInEmail
            ? `"have_we_spoken" text found in admin notification email`
            : `"have_we_spoken" text NOT found in admin email. Email captured: ${!!adminEmailGeneric}`);

        // Admin email should contain the formatted phone number (text body)
        const phoneInEmailText = adminEmailGeneric
          && typeof adminEmailGeneric.text === 'string'
          && adminEmailGeneric.text.includes('+44 7902 819990');
        record('CI-G4.phone-in-email-text', !!phoneInEmailText,
          phoneInEmailText
            ? `formatted phone "+44 7902 819990" found in admin email text body`
            : `formatted phone NOT found in admin email text body. Email captured: ${!!adminEmailGeneric}`);

        // Admin email should contain the formatted phone number (HTML body)
        const phoneInEmailHtml = adminEmailGeneric
          && typeof adminEmailGeneric.html === 'string'
          && adminEmailGeneric.html.includes('+44 7902 819990');
        record('CI-G4.phone-in-email-html', !!phoneInEmailHtml,
          phoneInEmailHtml
            ? `formatted phone "+44 7902 819990" found in admin email HTML body`
            : `formatted phone NOT found in admin email HTML body. Email captured: ${!!adminEmailGeneric}`);
      } else {
        record('CI-G4.db-row-populated', false, 'skipped — generic submit failed');
        record('CI-G4.hs-contact-created', false, 'skipped — generic submit failed');
        record('CI-G4.have-we-spoken-in-email', false, 'skipped — generic submit failed');
        record('CI-G4.phone-in-email-text', false, 'skipped — generic submit failed');
        record('CI-G4.phone-in-email-html', false, 'skipped — generic submit failed');
      }

      // ── CI-G5: Double-submit of same generic token → 410 submitted ──────────
      const gDouble = await postSubmit(BASE, genericToken, {
        name: 'Jane Generic', email: `jane-generic-${runId}@generic.local`,
        phone: '07902 819 990',
        structuredAddress: {
          addressLines: ['10 Generic Lane'],
          locality: 'Manchester', postalCode: 'M1 1GG',
          administrativeArea: '', country: 'GB',
        },
        roomCount: '1', roomNotes: '', photoKeys: [],
      });
      const gDoubleOk = gDouble.status === 410 && gDouble.json?.status === 'submitted';
      record('CI-G5.double-submit-rejected', gDoubleOk,
        gDoubleOk
          ? `410 status=submitted (duplicate prevented)`
          : `status=${gDouble.status} body=${JSON.stringify(gDouble.json).slice(0, 200)}`);
    } else {
      for (const id of ['CI-G4.submit-200', 'CI-G4.db-row-populated', 'CI-G4.hs-contact-created',
                         'CI-G4.have-we-spoken-in-email', 'CI-G4.phone-in-email-text',
                         'CI-G4.phone-in-email-html', 'CI-G5.double-submit-rejected']) {
        record(id, false, 'skipped — no generic token');
      }
    }

    // ── CI-G6: Expired generic token → GET returns 410 expired ──────────────
    // (Client redirects to generic mode; server-side contract is 410+status:expired.)
    {
      const expGenericToken  = crypto.randomBytes(32).toString('hex');
      const expGenericHash   = crypto.createHash('sha256').update(expGenericToken).digest('hex');
      const expiredAt        = new Date(Date.now() - 60000);
      await pool.query(
        `INSERT INTO customer_info_submissions
           (contact_id, token_hash, expires_at, is_generic)
         VALUES (NULL, $1, $2, true)`,
        [expGenericHash, expiredAt.toISOString()]
      );
      const expGRes = await fetch(`${BASE}/api/customer-info/${expGenericToken}`);
      const expGBody = await expGRes.json().catch(() => null);
      const expGOk = expGRes.status === 410 && expGBody?.status === 'expired';
      record('CI-G6.expired-generic-token',
        expGOk,
        expGOk
          ? `GET 410 status=expired for expired generic row`
          : `status=${expGRes.status} body=${JSON.stringify(expGBody).slice(0, 200)}`);
      // clean up
      await pool.query(`DELETE FROM customer_info_submissions WHERE token_hash = $1`, [expGenericHash]).catch(() => {});
    }

    // ── CI-G7: Generic submit with existing HubSpot contact past-photos ──────
    // Seed lead_status_config so isLeadStatusPastPhotos can do a real comparison,
    // then configure mock to return that contact for a specific email search.
    {
      const pastEmail = `past-photos-${runId}@generic.local`;
      const pastContactId = '800000099';

      // Seed AWAITING_PHOTOS (sort 10) and BOOKED_SURVEY (sort 30) into
      // lead_status_config. Use ON CONFLICT DO NOTHING so existing rows are
      // preserved and we don't upset other tests.
      let g7SeedOk = false;
      try {
        await pool.query(`
          INSERT INTO lead_status_config (key, label, sort_order, is_null_row)
          VALUES ('AWAITING_PHOTOS', 'Awaiting Photos', 10, false),
                 ('BOOKED_SURVEY',  'Booked Survey',   30, false)
          ON CONFLICT (key) DO NOTHING
        `);
        g7SeedOk = true;
      } catch (seedErr) {
        // Table may not exist or schema may differ — skip CI-G7 gracefully
        skip('CI-G7.submit-existing-contact', `skipped — lead_status_config seed failed: ${seedErr.message}`);
        skip('CI-G7.no-downgrade-on-past-photos', `skipped — lead_status_config seed failed: ${seedErr.message}`);
        skip('CI-G7.contact-id-stored', `skipped — lead_status_config seed failed: ${seedErr.message}`);
      }

      if (g7SeedOk) {
      // Configure mock to return an existing contact with BOOKED_SURVEY status
      // for this specific email address.
      mockHs.state.searchResultsByEmail[pastEmail] = {
        id: pastContactId,
        properties: { email: pastEmail, hs_lead_status: 'BOOKED_SURVEY', firstname: 'Past', lastname: 'Photos' },
      };

      // Capture PATCH calls count before this test
      const patchesBeforeG7 = mockHs.state.patches.length;

      // Create a draft token and submit
      const draftG7 = await fetch(`${BASE}/api/customer-info/draft`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
      });
      const draftG7Body = await draftG7.json().catch(() => null);
      const tokenG7 = draftG7Body?.token;

      if (tokenG7) {
        const subG7Res = await fetch(`${BASE}/api/customer-info/${tokenG7}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Past Photos', email: pastEmail, phone: '07911223344',
            structuredAddress: {
              addressLines: ['5 Past Road'],
              locality: 'Manchester', postalCode: 'M1 1PP',
              administrativeArea: '', country: 'GB',
            },
            roomCount: '1', roomNotes: '', photoKeys: [],
          }),
        });
        const subG7Data = await subG7Res.json().catch(() => null);
        const subG7Ok = subG7Res.status === 200 && subG7Data?.ok === true;
        record('CI-G7.submit-existing-contact', subG7Ok,
          subG7Ok
            ? `POST 200 ok=true for existing-contact path`
            : `status=${subG7Res.status} body=${JSON.stringify(subG7Data).slice(0, 300)}`);

        if (subG7Ok) {
          // The mock PATCH should have been called for the existing contact
          const newPatches = mockHs.state.patches.slice(patchesBeforeG7);
          const patchForExisting = newPatches.find(p => String(p.id) === pastContactId);

          // hs_lead_status must NOT be in the patch body (past photos guard)
          const noStatusInPatch = patchForExisting && !('hs_lead_status' in (patchForExisting.body?.properties || {}));
          record('CI-G7.no-downgrade-on-past-photos',
            !!noStatusInPatch,
            noStatusInPatch
              ? `PATCH called for existing contact ${pastContactId} without hs_lead_status (not downgraded)`
              : `PATCH: ${JSON.stringify(patchForExisting ?? null).slice(0, 300)}`);

          // But other side-effects must still run: DB row must have contact_id set
          const g7Hash = crypto.createHash('sha256').update(tokenG7).digest('hex');
          const g7DbR  = await pool.query(
            `SELECT contact_id, submitted_at FROM customer_info_submissions WHERE token_hash = $1`,
            [g7Hash]
          );
          const g7Row = g7DbR.rows[0];
          const contactIdSet = g7Row && String(g7Row.contact_id) === pastContactId && !!g7Row.submitted_at;
          record('CI-G7.contact-id-stored',
            !!contactIdSet,
            contactIdSet
              ? `DB contact_id=${g7Row.contact_id} set from existing contact`
              : `DB row: ${JSON.stringify(g7Row)}`);
        } else {
          record('CI-G7.no-downgrade-on-past-photos', false, 'skipped — submit failed');
          record('CI-G7.contact-id-stored', false, 'skipped — submit failed');
        }

        // clean up
        await pool.query(`DELETE FROM customer_info_submissions WHERE token_hash = $1`,
          [crypto.createHash('sha256').update(tokenG7).digest('hex')]).catch(() => {});
      } else {
        record('CI-G7.submit-existing-contact', false, 'skipped — draft token creation failed');
        record('CI-G7.no-downgrade-on-past-photos', false, 'skipped — draft token creation failed');
        record('CI-G7.contact-id-stored', false, 'skipped — draft token creation failed');
      }

      // Clean up seeded lead_status_config rows (only if we added them)
      await pool.query(`
        DELETE FROM lead_status_config WHERE key IN ('AWAITING_PHOTOS', 'BOOKED_SURVEY')
          AND label IN ('Awaiting Photos', 'Booked Survey')
      `).catch(() => {});
      // Clear the configured mock search result
      delete mockHs.state.searchResultsByEmail[pastEmail];

      // Also clean up any submission rows for past-photos contact
      await pool.query(
        `DELETE FROM customer_info_submissions WHERE contact_id = $1`, [pastContactId]
      ).catch(() => {});
      } // end if (g7SeedOk)
    }

    // ── CI-M1: correctedMobile is ignored (fields removed) ───────────────────
    // Verifies that:
    //   a) Sending correctedMobile is silently ignored (not a 400)
    //   b) corrected_mobile is always NULL in the DB after submit
    //   c) Admin notification email contains no mobile row
    {
      const contactIdM = String(600000000 + Math.floor(Math.random() * 99999999));

      const mValidAddress = {
        addressLines: ['10 Mobile Street'],
        locality: 'London', postalCode: 'SW1A 1AA',
        administrativeArea: '', country: 'GB',
      };

      // ── CI-M1a: correctedMobile is ignored, not a 400 ─────────────────────
      const mRawTokenA  = crypto.randomBytes(32).toString('hex');
      const mHashA      = crypto.createHash('sha256').update(mRawTokenA).digest('hex');
      const mExpiresA   = new Date(Date.now() + 86_400_000);
      await pool.query(
        `INSERT INTO customer_info_submissions
           (contact_id, contact_name, contact_email, token_hash, expires_at, is_generic,
            masked_email, masked_phone)
         VALUES ($1, 'Mobile Test User', 'mobiletest@privtest.local', $2, $3, false,
                 'm***@***.local', '07***0000')`,
        [contactIdM, mHashA, mExpiresA.toISOString()]
      );
      const mV1 = await postSubmit(BASE, mRawTokenA, {
        correctedMobile: '12345',
        structuredAddress: mValidAddress,
        roomCount: '1', roomNotes: '', photoKeys: [],
      });
      const mV1Ok = mV1.status === 200 && mV1.json?.ok === true;
      record('CI-M1a.corrected-mobile-ignored',
        mV1Ok,
        mV1Ok
          ? `200 ok=true (correctedMobile silently ignored)`
          : `status=${mV1.status} body=${JSON.stringify(mV1.json).slice(0, 200)}`);

      // ── CI-M1b: corrected_mobile is always NULL in DB ─────────────────────
      const mRawTokenB = crypto.randomBytes(32).toString('hex');
      const mHashB     = crypto.createHash('sha256').update(mRawTokenB).digest('hex');
      const mExpiresB  = new Date(Date.now() + 86_400_000);
      await pool.query(
        `INSERT INTO customer_info_submissions
           (contact_id, contact_name, contact_email, token_hash, expires_at, is_generic,
            masked_email, masked_phone)
         VALUES ($1, 'Mobile Test User', 'mobiletest@privtest.local', $2, $3, false,
                 'm***@***.local', '07***0000')`,
        [contactIdM, mHashB, mExpiresB.toISOString()]
      );
      const mailsBeforeM1b = readMailJsonl(mailFile).length;
      const mSubmitRes = await postSubmit(BASE, mRawTokenB, {
        correctedMobile: '07902 819 990',
        structuredAddress: mValidAddress,
        roomCount: '1', roomNotes: '', photoKeys: [],
      });
      const mSubmitOk = mSubmitRes.status === 200 && mSubmitRes.json?.ok === true;
      record('CI-M1b.submit-200',
        mSubmitOk,
        mSubmitOk
          ? `POST 200 ok=true`
          : `status=${mSubmitRes.status} body=${JSON.stringify(mSubmitRes.json).slice(0, 200)}`);

      if (mSubmitOk) {
        // Note: corrected_mobile column has been dropped from the schema; the
        // DB-level NULL check (CI-M1b.corrected-mobile-null-in-db) is no longer
        // applicable and has been removed.

        // Assert admin notification email does NOT contain mobile row
        let mAdminEmail = null;
        await pollFn(async () => {
          const mails = readMailJsonl(mailFile);
          mAdminEmail = mails.slice(mailsBeforeM1b)
            .find(m => typeof m.to === 'string' && m.to.includes(`admin-ci-${runId}@privtest.local`));
          return mAdminEmail ? true : null;
        }, 4000, 100);

        record('CI-M1b.admin-email-captured',
          !!mAdminEmail,
          mAdminEmail
            ? `admin notification email captured subject="${mAdminEmail.subject}"`
            : `no admin notification email after M1b submit`);

        const noMobileInText = mAdminEmail
          ? (typeof mAdminEmail.text !== 'string' || !mAdminEmail.text.includes('Mobile:'))
          : null;
        record('CI-M1b.no-mobile-in-email-text',
          noMobileInText === true,
          noMobileInText === true
            ? `mobile row correctly absent from admin email text body`
            : noMobileInText === null
              ? `skipped — no admin email captured`
              : `unexpected "Mobile:" found in admin email text body`);

        const noMobileInHtml = mAdminEmail
          ? (typeof mAdminEmail.html !== 'string' || !mAdminEmail.html.includes('Mobile (corrected)'))
          : null;
        record('CI-M1b.no-mobile-in-email-html',
          noMobileInHtml === true,
          noMobileInHtml === true
            ? `mobile row correctly absent from admin email HTML body`
            : noMobileInHtml === null
              ? `skipped — no admin email captured`
              : `unexpected mobile <tr> found in admin email HTML body`);
      } else {
        record('CI-M1b.corrected-mobile-null-in-db', false, 'skipped — submit failed');
        record('CI-M1b.admin-email-captured', false, 'skipped — submit failed');
        record('CI-M1b.no-mobile-in-email-text', false, 'skipped — submit failed');
        record('CI-M1b.no-mobile-in-email-html', false, 'skipped — submit failed');
      }

      // Clean up CI-M1 rows
      await pool.query(
        `DELETE FROM customer_info_submissions WHERE contact_id = $1`, [contactIdM]
      ).catch(() => {});
    }

    // ── CI-M2: Generic phone normalisation ───────────────────────────────────
    // Exercises the E.164 normalisation path for submittedPhone (generic flow):
    //   a) Invalid phone → POST returns 400
    //   b) Messy UK mobile → DB stores E.164 in contact_phone
    {
      const validAddress = {
        addressLines: ['5 Generic Road'],
        locality: 'Birmingham', postalCode: 'B1 1BB',
        administrativeArea: '', country: 'GB',
      };
      const genericBase = {
        name: 'Phone Test User', email: `phonetest-${runId}@generic.local`,
        structuredAddress: validAddress,
        roomCount: '1', roomNotes: '', photoKeys: [],
      };

      // ── CI-M2a: invalid phone → 400 ──────────────────────────────────────
      const m2TokenA = await (async () => {
        const r = await fetch(`${BASE}/api/customer-info/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        const d = await r.json().catch(() => ({}));
        return r.ok && d.token ? d.token : null;
      })();

      if (m2TokenA) {
        const m2V1 = await postSubmit(BASE, m2TokenA, { ...genericBase, phone: '12345' });
        const m2V1Ok = m2V1.status === 400 && !!m2V1.json?.error;
        record('CI-M2a.invalid-phone-400',
          m2V1Ok,
          m2V1Ok
            ? `400 error="${m2V1.json.error}"`
            : `status=${m2V1.status} body=${JSON.stringify(m2V1.json).slice(0, 200)}`);
      } else {
        record('CI-M2a.invalid-phone-400', false, 'skipped — could not create draft token');
      }

      // ── CI-M2b: messy UK mobile → DB stores E.164 ────────────────────────
      const m2TokenB = await (async () => {
        const r = await fetch(`${BASE}/api/customer-info/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        const d = await r.json().catch(() => ({}));
        return r.ok && d.token ? d.token : null;
      })();

      if (m2TokenB) {
        const m2SubmitRes = await postSubmit(BASE, m2TokenB, { ...genericBase, phone: '07902 819 990' });
        const m2SubmitOk = m2SubmitRes.status === 200 && m2SubmitRes.json?.ok === true;
        record('CI-M2b.messy-phone-submit-200',
          m2SubmitOk,
          m2SubmitOk
            ? `POST 200 ok=true`
            : `status=${m2SubmitRes.status} body=${JSON.stringify(m2SubmitRes.json).slice(0, 200)}`);

        if (m2SubmitOk) {
          const m2HashB = crypto.createHash('sha256').update(m2TokenB).digest('hex');
          const m2DbR = await pool.query(
            `SELECT contact_phone FROM customer_info_submissions WHERE token_hash = $1`,
            [m2HashB]
          );
          const m2DbPhone = m2DbR.rows[0]?.contact_phone;
          const m2DbOk = m2DbPhone === '+447902819990';
          record('CI-M2b.e164-in-db',
            m2DbOk,
            m2DbOk
              ? `contact_phone="${m2DbPhone}" (E.164)`
              : `expected "+447902819990", got "${m2DbPhone}"`);
        } else {
          record('CI-M2b.e164-in-db', false, 'skipped — submit failed');
        }
      } else {
        record('CI-M2b.messy-phone-submit-200', false, 'skipped — could not create draft token');
        record('CI-M2b.e164-in-db', false, 'skipped — could not create draft token');
      }
    }

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
    // Clean up generic rows (contact_id = NULL) created during this run.
    // They share no contact_id, so we identify them by a token hash we would have
    // computed during the test. Use the token if captured, otherwise clean up old
    // generic rows from this test via email column.
    if (typeof genericToken !== 'undefined' && genericToken) {
      try {
        const tHash = crypto.createHash('sha256').update(genericToken).digest('hex');
        await pool.query(
          `DELETE FROM customer_info_submissions WHERE token_hash = $1`,
          [tHash]
        );
      } catch {}
    }
    try {
      await pool.query(
        `DELETE FROM customer_info_submissions WHERE is_generic = true AND contact_email LIKE '%generic.local%'`
      );
    } catch {}
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
