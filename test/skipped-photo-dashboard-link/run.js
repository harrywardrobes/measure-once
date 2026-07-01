'use strict';
// test/skipped-photo-dashboard-link/run.js
//
// Regression guard: when photos are skipped (too large / not
// found in object storage), sendAdminNotificationEmail must include a
// clickable dashboard link so admins can still view the photos.
//
// Probes:
//   [DASH-A.html-link]   Admin email HTML body contains an <a> element whose
//                        href is the full customer dashboard URL
//                        ("/customers/:contactId") with link text
//                        "View all photos on the dashboard".
//   [DASH-A.text-url]    Admin email plain-text body contains the full
//                        dashboard URL (no HTML markup, just the raw URL).
//   [DASH-B.no-link]     When all photos attach successfully (nothing skipped),
//                        the admin email does NOT contain a dashboard link —
//                        ensures the link only appears when photos are skipped.
//
// Strategy: follows the customer-info-email-attachments pattern exactly.
//   • Spawns the test server with the fake object-storage stub so photo
//     downloads can be made to succeed or fail by controlling which keys
//     exist in the in-memory store.
//   • Uses MAIL_TRANSPORT_FILE_OVERRIDE to capture sendMail payloads as JSONL.
//   • Uses a local mock HubSpot server for the contact GET/PATCH calls that
//     sendAdminNotificationEmail triggers.
//   • Provides an absent storage key to force skippedCount ≥ 1 for DASH-A,
//     and a real uploaded photo for DASH-B (no skips).
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db>  npm run test:skipped-photo-dashboard-link
//   PRIVTEST_ALLOW_SHARED_DB=1       npm run test:skipped-photo-dashboard-link

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const http   = require('http');
const { Pool } = require('pg');
const { pollFn } = require('../helpers/poll');

require('dotenv').config();

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'skipped-photo-dashboard-link.md'
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

// ── Minimal JPEG buffer ───────────────────────────────────────────────────────
// Valid-enough for multer's mimetype filter.
const JPEG_BUF = Buffer.from(
  'ffd8ffe000104a46494600010100000100010000' +
  'ffdb004300080606070605080707070909080a0c' +
  '140d0c0b0b0c1912130f142124222321' +
  '1f272525202830212230322821' +
  'ffe2000c4943435f50524f46494c450001',
  'hex'
);

// ── Upload a photo via the public token endpoint ──────────────────────────────

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
      addressLine1:    '22 Dashboard Lane',
      city:            'London',
      postcode:        'EC1A 1AA',
      roomCount:       '2',
      roomNotes:       'dashboard link test',
      photoKeys,
    }),
  });
  return res;
}

// ── Get a fresh customer-info raw token from the invite email ─────────────────

async function getToken(base, mailFile, contactProps, memberClient) {
  const before = readMailJsonl(mailFile).length;
  const createRes = await memberClient.post('/api/card-actions/upload-photos-and-info', {
    contactId: contactProps._contactId,
  });
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

  const runId = Math.random().toString(36).slice(2, 8);
  // contactId must be all-digit (the route validates /^\d+$/)
  const contactId = String(700000000 + Math.floor(Math.random() * 99999999));

  console.log(`\n  skipped-photo-dashboard-link  run=${runId}`);
  console.log(`  contactId=${contactId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });

  const contactProps = {
    _contactId:  contactId,
    email:       `dash-cust-${runId}@privtest.local`,
    mobilephone: '+447900000123',
    phone:       '+44200000123',
    firstname:   'Dashboard',
    lastname:    'LinkTester',
  };
  const adminRecipient = `dash-admin-${runId}@privtest.local`;

  const mockHs = await startMockHubSpot(contactId, contactProps);
  console.log(`  mock HubSpot on http://127.0.0.1:${mockHs.port}`);

  const mailFile = path.join(os.tmpdir(), `ci-dashboard-link-${runId}.jsonl`);
  try { fs.unlinkSync(mailFile); } catch {}

  const stubPath = path.join(__dirname, '..', 'customer-info', 'preload-object-storage-stub.js');

  process.env.HUBSPOT_API_BASE_OVERRIDE         = `http://127.0.0.1:${mockHs.port}`;
  process.env.MAIL_TRANSPORT_FILE_OVERRIDE      = mailFile;
  process.env.PRIVTEST_USE_HUBSPOT_ACCESS_TOKEN = '1';
  process.env.HUBSPOT_ACCESS_TOKEN              = process.env.HUBSPOT_ACCESS_TOKEN || 'dash-test-fake-hs-token';
  process.env.PRIVTEST_USE_ADMIN_EMAILS         = '1';
  process.env.ADMIN_EMAILS                      = adminRecipient;

  const harness = require('../privileges/harness');
  const { spawnServer, waitForServer, seedUsers, cleanupTestData,
          resetRateLimitStore, login, TEST_PORT } = harness;
  const BASE = `http://127.0.0.1:${TEST_PORT}`;
  harness.setPool(pool);

  // The dashboard URL the server will embed in the skipped-photo email.
  // The harness always sets APP_URL=BASE for the spawned server process.
  const expectedDashboardUrl = `${BASE}/customers/${contactId}`;

  await cleanupTestData(pool);
  await resetRateLimitStore(pool);
  await cleanup(pool, contactId);

  const { child } = spawnServer({ nodeOptions: `--require "${stubPath.split(path.sep).join('/')}"` });
  let exitCode = 1;

  try {
    await waitForServer();
    console.log('  test server up');
    await waitForTable(pool, 'customer_info_submissions');

    const users       = await seedUsers(pool, runId);
    const member      = users.member;
    const memberClient = await login(member.email, member.password);

    // ── [DASH-A] Skip path: 1 real key + 1 absent key → dashboard link ───────
    console.log('\n  --- DASH-A: skip path (1 real + 1 absent key) → dashboard link ---');

    const token1 = await getToken(BASE, mailFile, contactProps, memberClient);

    const realKey = await uploadPhoto(BASE, token1, JPEG_BUF, 'image/jpeg', 'room1.jpg');
    // This key looks valid (passes format validation) but is NOT in the
    // in-memory fake storage, so downloadAsBytes returns { ok: false } and
    // the code increments skippedCount — triggering the dashboard link.
    // Prefix is 18 chars so the total body (prefix + 6-char runId) = 24, matching CI_KEY_RE.
    const absentKey = `obj:ci_not_in_fake_store_${runId}.jpg`;
    record('DASH-A.upload', true,
      `uploaded 1 real photo ${realKey}; absent key=${absentKey}`);

    const mailsBefore1 = readMailJsonl(mailFile).length;
    const submit1 = await submitForm(BASE, token1, [realKey, absentKey]);
    const submit1Ok = submit1.status === 200;
    record('DASH-A.submit', submit1Ok,
      submit1Ok ? 'POST 200' : `status=${submit1.status}`);

    let adminMail1 = null;
    await pollFn(async () => {
      const mails = readMailJsonl(mailFile);
      adminMail1 = mails.slice(mailsBefore1).find(m =>
        typeof m.to === 'string' && m.to.includes(adminRecipient)
      );
      return adminMail1 ? true : null;
    }, 6000, 100);

    if (!adminMail1) {
      record('DASH-A.html-link', false, 'admin email not captured after skip-path submit');
      record('DASH-A.text-url', false, 'admin email not captured');
    } else {
      record('DASH-A.admin-email-captured', true, `subject="${adminMail1.subject}"`);

      // HTML must contain <a href="...dashboard URL...">View all photos on the dashboard</a>
      const html = adminMail1.html || '';
      const htmlHasHref = html.includes(`href="${expectedDashboardUrl}"`)
        || html.includes(`href='${expectedDashboardUrl}'`);
      const htmlHasLinkText = html.includes('View all photos on the dashboard');
      const htmlOk = htmlHasHref && htmlHasLinkText;
      record('DASH-A.html-link', htmlOk,
        htmlOk
          ? `HTML contains <a href="${expectedDashboardUrl}">View all photos on the dashboard</a>`
          : `HTML dashboard link missing or incorrect.\n`
            + `  href present: ${htmlHasHref}\n`
            + `  link text present: ${htmlHasLinkText}\n`
            + `  expected URL: ${expectedDashboardUrl}\n`
            + `  html snippet: ${html.slice(0, 500)}`);

      // Plain-text must contain the raw dashboard URL
      const text = adminMail1.text || '';
      const textOk = text.includes(expectedDashboardUrl);
      record('DASH-A.text-url', textOk,
        textOk
          ? `text contains dashboard URL: ${expectedDashboardUrl}`
          : `text does not contain dashboard URL "${expectedDashboardUrl}";\n`
            + `  text snippet: ${text.slice(0, 500)}`);
    }

    // ── [DASH-B] Happy path: all photos succeed → NO dashboard link ───────────
    console.log('\n  --- DASH-B: happy path (all photos succeed) → no dashboard link ---');

    const token2 = await getToken(BASE, mailFile, contactProps, memberClient);

    const realKey2 = await uploadPhoto(BASE, token2, JPEG_BUF, 'image/jpeg', 'room2.jpg');
    record('DASH-B.upload', true, `uploaded 1 real photo ${realKey2}`);

    const mailsBefore2 = readMailJsonl(mailFile).length;
    const submit2 = await submitForm(BASE, token2, [realKey2]);
    const submit2Ok = submit2.status === 200;
    record('DASH-B.submit', submit2Ok,
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
      record('DASH-B.no-link', false, 'admin email not captured after happy-path submit');
    } else {
      record('DASH-B.admin-email-captured', true, `subject="${adminMail2.subject}"`);

      // No photos skipped → no dashboard link should appear
      const html2 = adminMail2.html || '';
      const text2 = adminMail2.text || '';
      const noLinkInHtml = !html2.includes('View all photos on the dashboard')
        && !html2.includes(`/customers/${contactId}`);
      const noLinkInText = !text2.includes(`/customers/${contactId}`);
      const noLinkOk = noLinkInHtml && noLinkInText;
      record('DASH-B.no-link', noLinkOk,
        noLinkOk
          ? 'no dashboard link in HTML or text when no photos were skipped (correct)'
          : `unexpected dashboard link found.\n`
            + `  link in HTML: ${!noLinkInHtml}\n`
            + `  link in text: ${!noLinkInText}\n`
            + `  html snippet: ${html2.slice(0, 400)}\n`
            + `  text snippet: ${text2.slice(0, 400)}`);
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
      '# skipped-photo-dashboard-link findings',
      '',
      `Run: ${new Date().toISOString()}`,
      `Result: ${findings.every(f => f.ok) ? 'PASS' : 'FAIL'} (${findings.filter(f => f.ok).length}/${findings.length})`,
      '',
      '| ID | Result | Detail |',
      '|----|--------|--------|',
      ...findings.map(f =>
        `| ${f.id} | ${f.ok ? 'PASS' : 'FAIL'} | ${String(f.detail).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`
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
