'use strict';
// test/customer-info-email-attachments/run.js
//
// Regression guard for the photo-attachment path in sendAdminNotificationEmail
// (customer-info.js:199-306).
//
// The production code downloads each photo from object storage and attaches it
// to the admin notification email.  Without a test a regression in the
// downloadAsBytes call or the nodemailer `attachments` field would be
// invisible.
//
// Two probes:
//
//   (ATT-1)  Happy path — 2 photos uploaded and submitted:
//              • admin email has 2 entries in `attachments`
//              • each entry has correct `contentType` (image/jpeg) and
//                non-empty `content`
//              • HTML body contains "2 photos attached" (no count mismatch)
//              • HTML body does NOT contain an `<a href` signed-URL link
//                (photos travel as attachments, not inline links)
//              • text body contains "2 attached"
//
//   (ATT-2)  Skip path — 1 real key + 1 key absent from storage:
//              • admin email has 1 entry in `attachments`
//              • HTML body contains "1 skipped"
//
// Overrides used:
//   HUBSPOT_API_BASE_OVERRIDE        — local mock for contact GET + PATCH
//   MAIL_TRANSPORT_FILE_OVERRIDE     — captures sendMail payloads as JSONL
//   NODE_OPTIONS=--require …/preload-object-storage-stub.js — in-memory store
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:customer-info-email-attachments
//   PRIVTEST_ALLOW_SHARED_DB=1       npm run test:customer-info-email-attachments

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const http   = require('http');
const crypto = require('crypto');
const { Pool } = require('pg');
const { pollFn } = require('../helpers/poll');

require('dotenv').config();

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'customer-info-email-attachments.md'
);
const findings = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}

// ── Mock HubSpot server ───────────────────────────────────────────────────────
function startMockHubSpot(contactId, contactProps) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url.startsWith(`/crm/v3/objects/contacts/${contactId}`)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: contactId, properties: contactProps }));
      }
      if (req.method === 'PATCH' && req.url.startsWith(`/crm/v3/objects/contacts/${contactId}`)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: contactId, properties: {} }));
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found', path: req.url }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

// ── Mail helpers ──────────────────────────────────────────────────────────────
function readMailJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

// Nodemailer serialises a Buffer attachment `content` field to JSON as
// { type: 'Buffer', data: [...] }.  Returns the byte-length, or 0 if absent.
function attachmentByteLength(att) {
  if (!att || !att.content) return 0;
  const c = att.content;
  if (typeof c === 'string') return c.length;
  if (Buffer.isBuffer(c)) return c.length;
  if (c.type === 'Buffer' && Array.isArray(c.data)) return c.data.length;
  return 0;
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

async function cleanup(pool, contactId) {
  try {
    await pool.query(
      `DELETE FROM customer_info_submissions WHERE contact_id = $1`, [contactId]
    );
  } catch {}
}

// ── JPEG stub buffer ──────────────────────────────────────────────────────────
// Minimal valid-enough JPEG so multer's mimetype filter passes.
const JPEG_BUF = Buffer.from(
  'ffd8ffe000104a46494600010100000100010000' +
  'ffdb004300080606070605080707070909080a0c' +
  '140d0c0b0b0c1912130f142124222321' +
  '1f272525202830212230322821' +
  'ffe2000c4943435f50524f46494c450001',
  'hex'
);

// ── Upload a photo and return the storage key ─────────────────────────────────
async function uploadPhoto(base, rawToken, buf, mime = 'image/jpeg', filename = 'photo.jpg') {
  const fd = new FormData();
  fd.append('photos', new Blob([buf], { type: mime }), filename);
  const res = await fetch(`${base}/api/customer-info/${rawToken}/photos`, {
    method: 'POST',
    body: fd,
  });
  const body = await res.json().catch(() => null);
  if (res.status !== 200 || !body?.ok || !Array.isArray(body.keys)) {
    throw new Error(`Photo upload failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body.keys[0];
}

// ── Submit the customer-info form ─────────────────────────────────────────────
async function submitForm(base, rawToken, photoKeys) {
  const res = await fetch(`${base}/api/customer-info/${rawToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      correctedEmail:  '',
      correctedMobile: '',
      addressLine1:    '10 Attachment Lane',
      city:            'Bristol',
      postcode:        'BS1 1AA',
      roomCount:       '2',
      roomNotes:       'attachment test',
      photoKeys,
    }),
  });
  return res;
}

// ── Get a fresh customer-info raw token from the invite email ─────────────────
async function getToken(base, mailFile, adminEmail, contactId, contactProps, member) {
  const before = readMailJsonl(mailFile).length;
  const createRes = await member.post('/api/card-actions/upload-photos-and-info', { contactId });
  if (createRes.status !== 201) {
    throw new Error(`create-link failed: ${createRes.status} ${createRes.text}`);
  }

  let inviteEmail = null;
  await pollFn(async () => {
    const mails = readMailJsonl(mailFile);
    inviteEmail = mails.slice(before).find(m =>
      typeof m.to === 'string' && m.to.includes(contactProps.email)
    );
    return inviteEmail ? true : null;
  }, 5000, 100);

  if (!inviteEmail) throw new Error('Invite email not captured');
  const src = (inviteEmail.text || '') + (inviteEmail.html || '');
  const m = src.match(/customer-info\/([a-f0-9]{64})/);
  if (!m) throw new Error('Could not extract raw token from invite email');
  return m[1];
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
  const contactId = String(800000000 + Math.floor(Math.random() * 99999999));

  console.log(`\n  customer-info-email-attachments  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });

  const contactProps = {
    email:       `att-cust-${runId}@privtest.local`,
    mobilephone: '+447911000099',
    phone:       '+44201000099',
    firstname:   'Attachment',
    lastname:    'Tester',
  };
  const adminRecipient = `att-admin-${runId}@privtest.local`;

  const mockHs = await startMockHubSpot(contactId, contactProps);
  console.log(`  mock HubSpot on http://127.0.0.1:${mockHs.port}`);

  const mailFile = path.join(os.tmpdir(), `ci-attach-${runId}.jsonl`);
  try { fs.unlinkSync(mailFile); } catch {}

  // Reuse the existing fake-object-storage stub from the customer-info test.
  const stubPath = path.join(__dirname, '..', 'customer-info', 'preload-object-storage-stub.js');

  // Set env vars before requiring the harness.
  process.env.HUBSPOT_API_BASE_OVERRIDE         = `http://127.0.0.1:${mockHs.port}`;
  process.env.MAIL_TRANSPORT_FILE_OVERRIDE      = mailFile;
  process.env.PRIVTEST_USE_HUBSPOT_ACCESS_TOKEN = '1';
  process.env.HUBSPOT_ACCESS_TOKEN              = process.env.HUBSPOT_ACCESS_TOKEN || 'att-test-fake-hs-token';
  process.env.PRIVTEST_USE_ADMIN_EMAILS         = '1';
  process.env.ADMIN_EMAILS                      = adminRecipient;

  const harness = require('../privileges/harness');
  const { spawnServer, waitForServer, seedUsers, cleanupTestData,
          resetRateLimitStore, login, TEST_PORT } = harness;
  const BASE = `http://127.0.0.1:${TEST_PORT}`;
  harness.setPool(pool);

  await cleanupTestData(pool);
  await resetRateLimitStore(pool);
  await cleanup(pool, contactId);

  const { child } = spawnServer({ nodeOptions: `--require ${stubPath}` });
  let exitCode = 1;

  try {
    await waitForServer();
    console.log('  test server up');
    await waitForTable(pool, 'customer_info_submissions');

    const users  = await seedUsers(pool, runId);
    const member = users.member;
    const memberClient = await login(member.email, member.password);

    // ── (ATT-1) Happy path: 2 photos, both attachments land in admin email ────
    console.log('\n  --- ATT-1: 2-photo happy path ---');
    const token1 = await getToken(BASE, mailFile, adminRecipient, contactId, contactProps, memberClient);

    const key1 = await uploadPhoto(BASE, token1, JPEG_BUF, 'image/jpeg', 'room1.jpg');
    const key2 = await uploadPhoto(BASE, token1, JPEG_BUF, 'image/jpeg', 'room2.jpg');
    record('ATT-1.upload', true, `uploaded 2 photos: ${key1}, ${key2}`);

    const mailsBefore1 = readMailJsonl(mailFile).length;
    const submit1 = await submitForm(BASE, token1, [key1, key2]);
    const submit1Ok = submit1.status === 200;
    record('ATT-1.submit', submit1Ok,
      submit1Ok ? 'POST 200' : `status=${submit1.status}`);

    // Wait for admin email to land
    let adminMail1 = null;
    await pollFn(async () => {
      const mails = readMailJsonl(mailFile);
      adminMail1 = mails.slice(mailsBefore1).find(m =>
        typeof m.to === 'string' && m.to.includes(adminRecipient)
      );
      return adminMail1 ? true : null;
    }, 6000, 100);

    if (!adminMail1) {
      record('ATT-1.admin-email-captured', false, 'admin email not found in mail file');
      record('ATT-1.attachment-count', false, 'no email to inspect');
      record('ATT-1.attachment-content-type', false, 'no email to inspect');
      record('ATT-1.attachment-non-empty', false, 'no email to inspect');
      record('ATT-1.html-photo-summary', false, 'no email to inspect');
      record('ATT-1.html-no-signed-url', false, 'no email to inspect');
      record('ATT-1.text-photo-summary', false, 'no email to inspect');
    } else {
      record('ATT-1.admin-email-captured', true, `subject="${adminMail1.subject}"`);

      const atts = Array.isArray(adminMail1.attachments) ? adminMail1.attachments : [];

      // Attachment count
      const countOk = atts.length === 2;
      record('ATT-1.attachment-count', countOk,
        countOk
          ? `attachments.length === 2`
          : `attachments.length === ${atts.length} (expected 2); keys: ${JSON.stringify(atts.map(a => a.filename))}`);

      // Content-type on each attachment
      const jpegAtts = atts.filter(a => a.contentType === 'image/jpeg');
      const ctOk = jpegAtts.length === atts.length && atts.length === 2;
      record('ATT-1.attachment-content-type', ctOk,
        ctOk
          ? `both attachments have contentType=image/jpeg`
          : `contentTypes: ${JSON.stringify(atts.map(a => a.contentType))}`);

      // Non-empty content buffer
      const nonEmpty = atts.every(a => attachmentByteLength(a) > 0);
      record('ATT-1.attachment-non-empty', nonEmpty,
        nonEmpty
          ? `all attachments have non-empty content`
          : `byte lengths: ${atts.map(a => attachmentByteLength(a)).join(', ')}`);

      // HTML body: "2 photos attached" (exact wording from sendAdminNotificationEmail)
      const html = adminMail1.html || '';
      const htmlSummaryOk = html.includes('2 photos attached');
      record('ATT-1.html-photo-summary', htmlSummaryOk,
        htmlSummaryOk
          ? 'HTML contains "2 photos attached"'
          : `HTML photo summary missing; html snippet: ${html.slice(0, 400)}`);

      // HTML body: must NOT contain a signed-URL <a href (photos are attachments, not links)
      const noSignedUrl = !html.includes('<a href');
      record('ATT-1.html-no-signed-url', noSignedUrl,
        noSignedUrl
          ? 'HTML has no <a href links (photos travel as attachments)'
          : 'HTML unexpectedly contains an <a href link');

      // Text body: "2 attached"
      const text = adminMail1.text || '';
      const textSummaryOk = text.includes('2 attached');
      record('ATT-1.text-photo-summary', textSummaryOk,
        textSummaryOk
          ? 'text contains "2 attached"'
          : `text photo summary missing; text snippet: ${text.slice(0, 400)}`);
    }

    // ── (ATT-2) Skip path: 1 real key + 1 absent key → 1 attachment, 1 skipped
    console.log('\n  --- ATT-2: skip path (1 real + 1 absent key) ---');

    // Need a fresh token because the first submission consumed the original one.
    // Create a second DB row for the same contactId.
    const token2 = await getToken(BASE, mailFile, adminRecipient, contactId, contactProps, memberClient);

    const key3 = await uploadPhoto(BASE, token2, JPEG_BUF, 'image/jpeg', 'room3.jpg');
    // A key that looks valid (passes server-side validation) but is NOT in
    // the in-memory fake storage, so downloadAsBytes returns { ok: false }.
    const absentKey = `obj:ci_does_not_exist_${runId}.jpg`;
    record('ATT-2.upload', true, `uploaded 1 real photo ${key3}; absent key=${absentKey}`);

    const mailsBefore2 = readMailJsonl(mailFile).length;
    const submit2 = await submitForm(BASE, token2, [key3, absentKey]);
    const submit2Ok = submit2.status === 200;
    record('ATT-2.submit', submit2Ok,
      submit2Ok ? 'POST 200' : `status=${submit2.status}`);

    let adminMail2 = null;
    await pollFn(async () => {
      const mails = readMailJsonl(mailFile);
      adminMail2 = mails.slice(mailsBefore2).find(m =>
        typeof m.to === 'string' && m.to.includes(adminRecipient)
      );
      return adminMail2 ? true : null;
    }, 6000, 100);

    if (!adminMail2) {
      record('ATT-2.admin-email-captured', false, 'admin email not found after skip-path submit');
      record('ATT-2.attachment-count', false, 'no email to inspect');
      record('ATT-2.html-skipped-summary', false, 'no email to inspect');
    } else {
      record('ATT-2.admin-email-captured', true, `subject="${adminMail2.subject}"`);

      const atts2 = Array.isArray(adminMail2.attachments) ? adminMail2.attachments : [];

      // Only the real photo should be attached
      const count2Ok = atts2.length === 1;
      record('ATT-2.attachment-count', count2Ok,
        count2Ok
          ? `attachments.length === 1 (the absent key was skipped)`
          : `attachments.length === ${atts2.length} (expected 1); keys: ${JSON.stringify(atts2.map(a => a.filename))}`);

      // HTML must mention "1 skipped"
      const html2 = adminMail2.html || '';
      const skippedOk = html2.includes('1 skipped');
      record('ATT-2.html-skipped-summary', skippedOk,
        skippedOk
          ? 'HTML contains "1 skipped"'
          : `HTML skipped summary missing; html snippet: ${html2.slice(0, 400)}`);
    }

    exitCode = findings.every(f => f.ok) ? 0 : 1;
  } catch (e) {
    console.error('  fatal:', e.stack || e.message);
    record('harness', false, `fatal: ${e.message}`);
    exitCode = 1;
  } finally {
    try { await cleanup(pool, contactId); } catch {}
    try { await cleanupTestData(pool); } catch {}
    try { child.kill('SIGTERM'); } catch {}
    try { mockHs.server.close(); } catch {}
    try { fs.unlinkSync(mailFile); } catch {}
    await pool.end().catch(() => {});

    const lines = [
      '# customer-info-email-attachments findings',
      '',
      `Run: ${new Date().toISOString()}`,
      `Result: ${findings.every(f => f.ok) ? 'PASS' : 'FAIL'} (${findings.filter(f => f.ok).length}/${findings.length})`,
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
