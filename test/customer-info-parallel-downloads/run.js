'use strict';
// test/customer-info-parallel-downloads/run.js
//
// Perf regression guard for the parallel photo-download path in
// sendAdminNotificationEmail (customer-info.js).
//
// The production code downloads photos in parallel via Promise.all so that
// N photos take ~1× network RTT instead of N×. This test confirms that
// 10 photos — each backed by a stub that waits 50 ms — complete well under
// 10 × 50 ms = 500 ms, proving the downloads run concurrently.
//
// One probe:
//
//   (PAR-1)  10 photos, each download stub waits 50 ms:
//              • admin notification email arrives within PARALLEL_BUDGET_MS
//                (default: 500 ms) of the form-submit response
//              • budget is intentionally generous — parallel should finish in
//                ~50–150 ms; serial would need ~500 ms + overhead
//              • the email has exactly 10 attachments (all downloads succeeded)
//
// Overrides used:
//   HUBSPOT_API_BASE_OVERRIDE        — local mock for contact GET + PATCH
//   MAIL_TRANSPORT_FILE_OVERRIDE     — captures sendMail payloads as JSONL
//   NODE_OPTIONS=--require …/preload-slow-storage.js — slow in-memory store
//   SLOW_STORAGE_DELAY_MS=50         — per-download artificial delay
//
// Skipped automatically when the CI environment variable is set (the timing
// sensitivity makes it unsuitable for shared CI runners).
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:customer-info-parallel-downloads
//   PRIVTEST_ALLOW_SHARED_DB=1       npm run test:customer-info-parallel-downloads

if (process.env.CI) {
  console.log('  [SKIP] customer-info-parallel-downloads: CI=true — timing test skipped on CI runners.');
  process.exit(0);
}

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const http   = require('http');
const crypto = require('crypto');
const { Pool } = require('pg');
const { pollFn } = require('../helpers/poll');

require('dotenv').config();

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'customer-info-parallel-downloads.md'
);

// Budget: parallel downloads of 10×50 ms should finish in well under 500 ms
// even with server overhead.  Serial would need ≥500 ms of download time alone.
const PARALLEL_BUDGET_MS = Number(process.env.PARALLEL_BUDGET_MS) || 500;
const SLOW_STORAGE_DELAY_MS = 50;

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

// ── Minimal JPEG stub ─────────────────────────────────────────────────────────
const JPEG_BUF = Buffer.from(
  'ffd8ffe000104a46494600010100000100010000' +
  'ffdb004300080606070605080707070909080a0c' +
  '140d0c0b0b0c1912130f142124222321' +
  '1f272525202830212230322821' +
  'ffe2000c4943435f50524f46494c450001',
  'hex'
);

// ── Upload a photo via the public API ─────────────────────────────────────────
async function uploadPhoto(base, rawToken, buf, filename) {
  const fd = new FormData();
  fd.append('photos', new Blob([buf], { type: 'image/jpeg' }), filename);
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
  return fetch(`${base}/api/customer-info/${rawToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      correctedEmail:  '',
      correctedMobile: '',
      addressLine1:    '1 Parallel Street',
      city:            'Manchester',
      postcode:        'M1 1AA',
      roomCount:       '3',
      roomNotes:       'parallel download perf test',
      photoKeys,
    }),
  });
}

// ── Get a fresh customer-info raw token from the invite email ─────────────────
async function getToken(base, mailFile, contactId, contactProps, member) {
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
  const contactId = String(700000000 + Math.floor(Math.random() * 99999999));

  console.log(`\n  customer-info-parallel-downloads  run=${runId}`);
  console.log(`  Slow storage delay: ${SLOW_STORAGE_DELAY_MS} ms per download`);
  console.log(`  Parallel budget:    ${PARALLEL_BUDGET_MS} ms (serial would need ≥${10 * SLOW_STORAGE_DELAY_MS} ms)`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });

  const contactProps = {
    email:       `par-cust-${runId}@privtest.local`,
    mobilephone: '+447911000199',
    phone:       '+44201000199',
    firstname:   'Parallel',
    lastname:    'Tester',
  };
  const adminRecipient = `par-admin-${runId}@privtest.local`;

  const mockHs = await startMockHubSpot(contactId, contactProps);
  console.log(`  mock HubSpot on http://127.0.0.1:${mockHs.port}`);

  const mailFile = path.join(os.tmpdir(), `ci-parallel-${runId}.jsonl`);
  try { fs.unlinkSync(mailFile); } catch {}

  const stubPath = path.join(__dirname, 'preload-slow-storage.js');

  process.env.HUBSPOT_API_BASE_OVERRIDE         = `http://127.0.0.1:${mockHs.port}`;
  process.env.MAIL_TRANSPORT_FILE_OVERRIDE      = mailFile;
  process.env.PRIVTEST_USE_HUBSPOT_ACCESS_TOKEN = '1';
  process.env.HUBSPOT_ACCESS_TOKEN              = process.env.HUBSPOT_ACCESS_TOKEN || 'par-test-fake-hs-token';
  process.env.PRIVTEST_USE_ADMIN_EMAILS         = '1';
  process.env.ADMIN_EMAILS                      = adminRecipient;
  process.env.SLOW_STORAGE_DELAY_MS             = String(SLOW_STORAGE_DELAY_MS);

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

    const users       = await seedUsers(pool, runId);
    const member      = users.member;
    const memberClient = await login(member.email, member.password);

    // ── (PAR-1) 10 photos, each download takes 50 ms — must arrive in < 500 ms
    console.log(`\n  --- PAR-1: 10 photos, ${SLOW_STORAGE_DELAY_MS} ms/download, budget=${PARALLEL_BUDGET_MS} ms ---`);

    const token = await getToken(BASE, mailFile, contactId, contactProps, memberClient);

    // Upload 10 photos concurrently (uploads are fast; storage is in-memory)
    const photoKeys = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        uploadPhoto(BASE, token, JPEG_BUF, `room${i + 1}.jpg`)
      )
    );
    record('PAR-1.uploads', true, `uploaded ${photoKeys.length} photos`);

    const mailsBefore = readMailJsonl(mailFile).length;

    // Timer starts just before the fetch call so the budget includes the full
    // round-trip (submit request + async photo downloads + email send).  This
    // is intentionally stricter than measuring from the submit *response*:
    // starting earlier means more overhead is absorbed by the budget, giving
    // us a conservative but reliable gate — parallel downloads must still
    // complete well within the window even counting all server processing.
    const submitStart = Date.now();
    const submitRes = await submitForm(BASE, token, photoKeys);
    const submitOk  = submitRes.status === 200;
    record('PAR-1.submit', submitOk,
      submitOk ? 'POST 200' : `status=${submitRes.status}`);

    if (!submitOk) {
      record('PAR-1.email-timing', false, 'submit failed — cannot check timing');
    } else {
      // Poll tightly for the admin email.  With parallel downloads the email
      // should arrive well within PARALLEL_BUDGET_MS of the submit response.
      let adminMail  = null;
      let emailArrivalMs = null;

      await pollFn(async () => {
        const mails = readMailJsonl(mailFile);
        const found = mails.slice(mailsBefore).find(m =>
          typeof m.to === 'string' && m.to.includes(adminRecipient)
        );
        if (found) {
          emailArrivalMs = Date.now() - submitStart;
          adminMail = found;
          return true;
        }
        return null;
      }, PARALLEL_BUDGET_MS + 200, 25);

      if (!adminMail) {
        record('PAR-1.email-timing', false,
          `admin email did NOT arrive within ${PARALLEL_BUDGET_MS + 200} ms — ` +
          `likely regressed to serial downloads (10 × ${SLOW_STORAGE_DELAY_MS} ms = ` +
          `${10 * SLOW_STORAGE_DELAY_MS} ms + overhead would exceed budget)`);
      } else {
        const withinBudget = emailArrivalMs < PARALLEL_BUDGET_MS;
        record('PAR-1.email-timing', withinBudget,
          withinBudget
            ? `admin email arrived ${emailArrivalMs} ms after submit (< ${PARALLEL_BUDGET_MS} ms budget — downloads ran in parallel)`
            : `admin email arrived ${emailArrivalMs} ms after submit (≥ ${PARALLEL_BUDGET_MS} ms budget — downloads may be serial)`
        );

        // Also verify all 10 photos were attached successfully
        const atts = Array.isArray(adminMail.attachments) ? adminMail.attachments : [];
        const countOk = atts.length === 10;
        record('PAR-1.attachment-count', countOk,
          countOk
            ? `all 10 photos attached (no downloads failed)`
            : `expected 10 attachments, got ${atts.length}`);
      }
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
      '# customer-info-parallel-downloads findings',
      '',
      `Run: ${new Date().toISOString()}`,
      `Slow storage delay: ${SLOW_STORAGE_DELAY_MS} ms per download`,
      `Parallel budget: ${PARALLEL_BUDGET_MS} ms`,
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
