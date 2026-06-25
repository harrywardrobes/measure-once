'use strict';
// test/photo-storage-errors/run.js
//
// Regression guard for Object Storage error handling:
//   - Upload routes must return friendly errors when Object Storage is broken.
//   - Delete and download routes must apply the same guard and never leak raw
//     SDK internals to callers.
//
// Probes:
//   (STO-1) POST /api/customer-info/:token/photos — public upload, no auth.
//   (STO-2) POST /api/design-visits/uploads — authenticated member upload.
//   (STO-5) DELETE /api/design-visits/uploads/:key — authenticated delete.
//   (STO-6) GET /api/design-visit-images/:key — public HMAC-signed download.
//   (STO-7) GET /api/customer-info-photos/:key — authenticated signed photo.
//   All Phase-1 probes use a stub whose Client constructor always throws.
//   Expected for all: SDK error NOT present in HTTP response body.
//
//   (STO-3) POST /api/customer-info/:token/photos — upload ok:false stub.
//   (STO-4) POST /api/design-visits/uploads — upload ok:false stub.
//   (STO-8) DELETE /api/design-visits/uploads/:key — delete ok:false stub.
//   (STO-9) GET /api/design-visit-images/:key — download ok:false stub.
//   All Phase-2 probes use a stub whose operations return { ok: false }.
//   Expected for all: SDK error NOT present in HTTP response body.
//
// Override used:
//   NODE_OPTIONS=--require .../preload-failing-storage-stub.js  — swaps the
//     real @google-cloud/storage SDK for a stub whose Storage constructor
//     always throws "A bucket name is needed to use Cloud Storage."
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db>  npm run test:photo-storage-errors
//   PRIVTEST_ALLOW_SHARED_DB=1       npm run test:photo-storage-errors

'use strict';

const fs     = require('fs');
const path   = require('path');
const http   = require('http');
const crypto = require('crypto');
const { Pool } = require('pg');
const { pollFn } = require('../helpers/poll');

require('dotenv').config();

const REPORT_PATH = path.join(__dirname, '..', '..', 'test-results', 'photo-storage-errors.md');
const FRIENDLY_RE = /temporarily unavailable/i;
const SDK_LEAK_RE = /bucket name|cloud storage/i;

// ── HMAC-signed URL helpers (mirrors design-visit-uploads.js + customer-info.js) ─
// The test generates its own valid signed URLs using the same SESSION_SECRET
// that is passed to the spawned server (via process.env pass-through).
function makeSignedDvImageUrl(storageKey) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET must be set to generate signed DV image URLs');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const sig = crypto.createHmac('sha256', secret).update(`${storageKey}|${exp}`).digest('hex');
  return `/api/design-visit-images/${encodeURIComponent(storageKey)}?exp=${exp}&sig=${sig}`;
}

function makeSignedCiPhotoUrl(storageKey) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET must be set to generate signed CI photo URLs');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const sig = crypto.createHmac('sha256', secret).update(`${storageKey}|${exp}`).digest('hex');
  return `/api/customer-info-photos/${encodeURIComponent(storageKey)}?exp=${exp}&sig=${sig}`;
}

const findings = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}

// ── Minimal mock HubSpot server ───────────────────────────────────────────────
// The server.js boot sequence calls syncLeadSubstatusesToHubSpot() which issues
// a PATCH to HubSpot. We intercept it so the test doesn't require real credentials.
function startMockHubSpot() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', results: [] }));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
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

// Insert a fresh, valid (non-expired, non-submitted) customer-info token row.
// Returns the raw token so we can hit the /photos endpoint directly.
async function insertValidRow(pool, contactId) {
  const rawToken  = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 86400000); // 24 h from now
  await pool.query(
    `INSERT INTO customer_info_submissions
       (contact_id, contact_name, contact_email, token_hash, expires_at,
        masked_email, masked_phone)
     VALUES ($1, 'Storage Test', 'storagetest@privtest.local', $2, $3,
             's***@privtest.local', '07***0000')`,
    [contactId, tokenHash, expiresAt.toISOString()]
  );
  return rawToken;
}

async function cleanup(pool, contactId) {
  try {
    await pool.query(
      `DELETE FROM customer_info_submissions WHERE contact_id = $1`, [contactId]
    );
  } catch {}
}

// ── Tiny valid PNG (1×1 pixel) as a data URL ─────────────────────────────────
// Used for the design-visits upload probe so the server can parse the data URL
// and reach the storage call before hitting the error.
const TINY_PNG_DATA_URL = (
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg=='
);

// ── Multipart POST helper (no extra deps) ─────────────────────────────────────
// Builds a minimal multipart/form-data body containing one JPEG-like file
// and sends it via Node.js http.request. Returns { status, json }.
function postMultipart(base, path, fieldName, fileBuffer, mimeType, filename) {
  return new Promise((resolve, reject) => {
    const boundary = `----FormBoundary${crypto.randomBytes(8).toString('hex')}`;
    const CRLF = '\r\n';
    const head = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"`,
      `Content-Type: ${mimeType}`,
      '',
      '',
    ].join(CRLF);
    const tail = `${CRLF}--${boundary}--${CRLF}`;
    const bodyBuf = Buffer.concat([
      Buffer.from(head),
      fileBuffer,
      Buffer.from(tail),
    ]);

    const url = new URL(path, base);
    const opts = {
      hostname: url.hostname,
      port:     parseInt(url.port, 10),
      path:     url.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(bodyBuf.length),
      },
    };

    const req = http.request(opts, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, json, text: raw });
      });
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Kill a child process and wait until it exits (or timeout).
function killAndWait(child, timeoutMs = 5000) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    child.on('exit', finish);
    child.kill();
    setTimeout(finish, timeoutMs);
  });
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
  const contactId = String(800000000 + Math.floor(Math.random() * 99999999));

  console.log(`\n  photo-storage-errors  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });

  const mockHs = await startMockHubSpot();
  console.log(`  mock HubSpot on http://127.0.0.1:${mockHs.port}`);

  process.env.HUBSPOT_API_BASE_OVERRIDE          = `http://127.0.0.1:${mockHs.port}`;
  process.env.PRIVTEST_USE_HUBSPOT_ACCESS_TOKEN  = '1';
  process.env.HUBSPOT_ACCESS_TOKEN               = process.env.HUBSPOT_ACCESS_TOKEN || 'ci-test-fake-hs-token';
  process.env.PRIVTEST_USE_ADMIN_EMAILS          = '1';
  process.env.ADMIN_EMAILS                       = `admin-ci-${runId}@privtest.local`;
  // Ensure SESSION_SECRET is set so the test can generate valid HMAC-signed
  // image URLs (same value is forwarded to the spawned server via ...process.env).
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || `ci-test-session-secret-${runId}`;
  // Must be truthy so storage.js's getGcsBucket() proceeds to
  // require('@google-cloud/storage'), which the preload stubs intercept.
  process.env.GCS_BUCKET      = 'fake-test-bucket';

  const harness = require('../privileges/harness');
  const { spawnServer, waitForServer, seedUsers, cleanupTestData,
          resetRateLimitStore, login, makeClient, TEST_PORT } = harness;
  const BASE = `http://127.0.0.1:${TEST_PORT}`;
  harness.setPool(pool);

  await cleanupTestData(pool);
  await resetRateLimitStore(pool);
  await cleanup(pool, contactId);

  // Build a minimal JPEG-like buffer (SOI + APP0 marker — enough for multer)
  const jpegBuf = Buffer.from(
    'ffd8ffe000104a46494600010100000100010000' +
    'ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f142124',
    'hex'
  );

  let exitCode = 1;
  let child1, child2;

  try {
    // ── Phase 1: constructor-throws stub (STO-1, STO-2) ──────────────────────
    console.log('\n  --- Phase 1: constructor-throws stub ---');
    const stubPath1 = path.join(__dirname, 'preload-failing-storage-stub.js');
    ({ child: child1 } = spawnServer({ nodeOptions: `--require "${stubPath1.split(path.sep).join('/')}"` }));

    await waitForServer();
    console.log('  test server up (phase 1)');

    await waitForTable(pool, 'customer_info_submissions');

    const users  = await seedUsers(pool, runId);
    const member = users.member;

    // ── STO-1: POST /api/customer-info/:token/photos ────────────────────────
    const rawToken1 = await insertValidRow(pool, contactId);

    const uploadRes1 = await postMultipart(
      BASE,
      `/api/customer-info/${rawToken1}/photos`,
      'photos',
      jpegBuf,
      'image/jpeg',
      'room.jpg'
    );

    const sto1Msg = uploadRes1.json?.error || '';

    record('STO-1.status',
      uploadRes1.status === 500,
      `HTTP ${uploadRes1.status} (expected 500)`
    );
    record('STO-1.friendly-message',
      FRIENDLY_RE.test(sto1Msg),
      FRIENDLY_RE.test(sto1Msg)
        ? `error contains "temporarily unavailable" ✓`
        : `error="${sto1Msg.slice(0, 200)}"`
    );
    record('STO-1.no-sdk-leak',
      !SDK_LEAK_RE.test(sto1Msg),
      !SDK_LEAK_RE.test(sto1Msg)
        ? `error does not contain raw SDK internals ✓`
        : `SDK error LEAKED: "${sto1Msg.slice(0, 200)}"`
    );

    // ── STO-2: POST /api/design-visits/uploads ──────────────────────────────
    const memberClient1 = await login(member.email, member.password);
    const dvUploadRes1  = await memberClient1.post(
      '/api/design-visits/uploads',
      { dataUrl: TINY_PNG_DATA_URL }
    );

    const sto2Msg = dvUploadRes1.json?.error || '';

    record('STO-2.status',
      dvUploadRes1.status === 503,
      `HTTP ${dvUploadRes1.status} (expected 503)`
    );
    record('STO-2.friendly-message',
      FRIENDLY_RE.test(sto2Msg),
      FRIENDLY_RE.test(sto2Msg)
        ? `error contains "temporarily unavailable" ✓`
        : `error="${sto2Msg.slice(0, 200)}"`
    );
    record('STO-2.no-sdk-leak',
      !SDK_LEAK_RE.test(sto2Msg),
      !SDK_LEAK_RE.test(sto2Msg)
        ? `error does not contain raw SDK internals ✓`
        : `SDK error LEAKED: "${sto2Msg.slice(0, 200)}"`
    );

    // ── STO-5: DELETE /api/design-visits/uploads/:key ───────────────────────
    // Opaque key — must pass isOpaqueKey() regex (/^obj:[A-Za-z0-9_-]{16,}(\.[a-z0-9]{1,8})?$/)
    // Use manager login to bypass ownership check and reach deleteOpaqueKey.
    const manager = users.manager;
    const managerClient1 = await login(manager.email, manager.password);
    const dvDeleteKey = 'obj:AAAAAAAAAAAAAAAAAABB.png';
    const dvDeleteRes = await managerClient1.delete(
      `/api/design-visits/uploads/${encodeURIComponent(dvDeleteKey)}`
    );
    const sto5Body = dvDeleteRes.json?.error || dvDeleteRes.text || '';
    record('STO-5.status',
      dvDeleteRes.status === 500,
      `HTTP ${dvDeleteRes.status} (expected 500)`
    );
    record('STO-5.no-sdk-leak',
      !SDK_LEAK_RE.test(sto5Body),
      !SDK_LEAK_RE.test(sto5Body)
        ? `response does not contain raw SDK internals ✓`
        : `SDK error LEAKED: "${sto5Body.slice(0, 200)}"`
    );

    // ── STO-6: GET /api/design-visit-images/:key (public, HMAC-signed) ──────
    const dvImageKey = 'obj:AAAAAAAAAAAAAAAAAABB.png';
    const dvImageUrl = makeSignedDvImageUrl(dvImageKey);
    const anonClient = makeClient(null);
    const dvImageRes = await anonClient.get(dvImageUrl);
    const sto6Body = dvImageRes.text || '';
    record('STO-6.status',
      dvImageRes.status === 500,
      `HTTP ${dvImageRes.status} (expected 500)`
    );
    record('STO-6.no-sdk-leak',
      !SDK_LEAK_RE.test(sto6Body),
      !SDK_LEAK_RE.test(sto6Body)
        ? `response does not contain raw SDK internals ✓`
        : `SDK error LEAKED: "${sto6Body.slice(0, 200)}"`
    );

    // ── STO-7: GET /api/customer-info-photos/:key (authenticated, HMAC-signed)
    const ciPhotoKey = 'obj:ci_AAAAAAAAAAAAAAAAAABB.jpg';
    const ciPhotoUrl = makeSignedCiPhotoUrl(ciPhotoKey);
    const ciPhotoRes = await memberClient1.get(ciPhotoUrl);
    const sto7Body = ciPhotoRes.json?.error || ciPhotoRes.text || '';
    record('STO-7.status',
      ciPhotoRes.status === 500,
      `HTTP ${ciPhotoRes.status} (expected 500)`
    );
    record('STO-7.no-sdk-leak',
      !SDK_LEAK_RE.test(sto7Body),
      !SDK_LEAK_RE.test(sto7Body)
        ? `response does not contain raw SDK internals ✓`
        : `SDK error LEAKED: "${sto7Body.slice(0, 200)}"`
    );

    // Tear down phase-1 server before reusing the port.
    await killAndWait(child1);
    child1 = null;
    await cleanup(pool, contactId);

    // ── Phase 2: uploadFromBytes ok:false stub (STO-3, STO-4) ────────────────
    console.log('\n  --- Phase 2: uploadFromBytes ok:false stub ---');
    const stubPath2 = path.join(__dirname, 'preload-failing-upload-storage-stub.js');
    ({ child: child2 } = spawnServer({ nodeOptions: `--require "${stubPath2.split(path.sep).join('/')}"` }));

    await waitForServer();
    console.log('  test server up (phase 2)');

    // ── STO-3: customer-info upload with ok:false SDK response ───────────────
    const rawToken2 = await insertValidRow(pool, contactId);

    const uploadRes2 = await postMultipart(
      BASE,
      `/api/customer-info/${rawToken2}/photos`,
      'photos',
      jpegBuf,
      'image/jpeg',
      'room2.jpg'
    );

    const sto3Msg = uploadRes2.json?.error || '';

    record('STO-3.status',
      uploadRes2.status === 500,
      `HTTP ${uploadRes2.status} (expected 500)`
    );
    record('STO-3.friendly-message',
      FRIENDLY_RE.test(sto3Msg),
      FRIENDLY_RE.test(sto3Msg)
        ? `error contains "temporarily unavailable" ✓`
        : `error="${sto3Msg.slice(0, 200)}"`
    );
    record('STO-3.no-sdk-leak',
      !SDK_LEAK_RE.test(sto3Msg),
      !SDK_LEAK_RE.test(sto3Msg)
        ? `error does not contain raw SDK internals ✓`
        : `SDK error LEAKED: "${sto3Msg.slice(0, 200)}"`
    );

    // ── STO-4: design-visits upload with ok:false SDK response ───────────────
    const memberClient2 = await login(member.email, member.password);
    const dvUploadRes2  = await memberClient2.post(
      '/api/design-visits/uploads',
      { dataUrl: TINY_PNG_DATA_URL }
    );

    const sto4Msg = dvUploadRes2.json?.error || '';

    record('STO-4.status',
      dvUploadRes2.status === 503,
      `HTTP ${dvUploadRes2.status} (expected 503)`
    );
    record('STO-4.friendly-message',
      FRIENDLY_RE.test(sto4Msg),
      FRIENDLY_RE.test(sto4Msg)
        ? `error contains "temporarily unavailable" ✓`
        : `error="${sto4Msg.slice(0, 200)}"`
    );
    record('STO-4.no-sdk-leak',
      !SDK_LEAK_RE.test(sto4Msg),
      !SDK_LEAK_RE.test(sto4Msg)
        ? `error does not contain raw SDK internals ✓`
        : `SDK error LEAKED: "${sto4Msg.slice(0, 200)}"`
    );

    // ── STO-8: DELETE /api/design-visits/uploads/:key — ok:false from delete()
    const managerClient2 = await login(manager.email, manager.password);
    const dvDeleteRes2 = await managerClient2.delete(
      `/api/design-visits/uploads/${encodeURIComponent(dvDeleteKey)}`
    );
    const sto8Body = dvDeleteRes2.json?.error || dvDeleteRes2.text || '';
    record('STO-8.status',
      dvDeleteRes2.status === 500,
      `HTTP ${dvDeleteRes2.status} (expected 500)`
    );
    record('STO-8.no-sdk-leak',
      !SDK_LEAK_RE.test(sto8Body),
      !SDK_LEAK_RE.test(sto8Body)
        ? `response does not contain raw SDK internals ✓`
        : `SDK error LEAKED: "${sto8Body.slice(0, 200)}"`
    );

    // ── STO-9: GET /api/design-visit-images/:key — ok:false from downloadAsBytes
    // downloadOpaqueKey sees ok:false with a bucket error message, applies
    // _friendlyStorageError, throws; the route returns 500.
    const dvImageUrl2 = makeSignedDvImageUrl(dvImageKey);
    const dvImageRes2 = await anonClient.get(dvImageUrl2);
    const sto9Body = dvImageRes2.text || '';
    record('STO-9.status',
      dvImageRes2.status === 500,
      `HTTP ${dvImageRes2.status} (expected 500)`
    );
    record('STO-9.no-sdk-leak',
      !SDK_LEAK_RE.test(sto9Body),
      !SDK_LEAK_RE.test(sto9Body)
        ? `response does not contain raw SDK internals ✓`
        : `SDK error LEAKED: "${sto9Body.slice(0, 200)}"`
    );

    const failed = findings.filter(f => !f.ok);
    exitCode = failed.length > 0 ? 1 : 0;

  } finally {
    if (child1) child1.kill();
    if (child2) child2.kill();
    await cleanup(pool, contactId);
    await pool.end().catch(() => {});
    mockHs.server.close();

    // ── Write markdown report ────────────────────────────────────────────────
    const lines = [
      '# photo-storage-errors test results',
      '',
      '| probe | result | detail |',
      '| ----- | ------ | ------ |',
      ...findings.map(f =>
        `| ${f.id} | ${f.ok ? '✅ PASS' : '❌ FAIL'} | ${f.detail} |`
      ),
    ];
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, lines.join('\n') + '\n');
    console.log(`\n  Report written to ${REPORT_PATH}`);

    if (exitCode === 0) {
      console.log('\n  ✅ All probes passed.\n');
    } else {
      const failed = findings.filter(f => !f.ok);
      console.error(`\n  ❌ ${failed.length} probe(s) failed.\n`);
    }

    process.exit(exitCode);
  }
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
