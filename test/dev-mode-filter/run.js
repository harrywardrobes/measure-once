'use strict';
// test/dev-mode-filter/run.js
//
// Integration test for the DB-driven dev-mode toggle and hw_test_user filter.
//
//   (A) Baseline (dev mode off): GET /api/contacts-all returns all contacts —
//       both the hw_test_user=true contact and the normal contact.
//
//   (B) Toggle ON: POST /api/admin/hubspot/dev-mode { devMode: true } followed
//       by GET /api/contacts-all returns only the hw_test_user=true contact.
//
//   (C) Toggle OFF: POST /api/admin/hubspot/dev-mode { devMode: false } followed
//       by GET /api/contacts-all returns all contacts again.
//
//   (D) Auth gate: a non-admin (member-level) user receives 403 on
//       POST /api/admin/hubspot/dev-mode.
//
//   (E) Audit log: toggling writes a row to admin_audit_log with
//       action_type = 'set_dev_mode'.
//
//   (F) GET /api/admin/hubspot/dev-mode reflects the persisted state.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:dev-mode-filter
//   PRIVTEST_ALLOW_SHARED_DB=1      npm run test:dev-mode-filter

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

require('dotenv').config();

const REPORT_PATH = path.join(__dirname, '..', '..', 'test-results', 'dev-mode-filter.md');
const findings = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}

// ── Mock HubSpot contacts ──────────────────────────────────────────────────────
// Two contacts: one marked hw_test_user=true, one hw_test_user=false.
const TEST_USER_CONTACT = {
  id: '101',
  properties: {
    firstname: 'Test',
    lastname: 'User',
    email: 'testuser@example.com',
    phone: '555-0101',
    hs_lead_status: 'OPEN_DEAL',
    createdate: '2024-01-01T00:00:00.000Z',
    lastmodifieddate: '2024-01-01T00:00:00.000Z',
    hw_test_user: 'true',
  },
};

const REAL_CONTACT = {
  id: '202',
  properties: {
    firstname: 'Real',
    lastname: 'Customer',
    email: 'real@example.com',
    phone: '555-0202',
    hs_lead_status: 'OPEN_DEAL',
    createdate: '2024-01-02T00:00:00.000Z',
    lastmodifieddate: '2024-01-02T00:00:00.000Z',
    hw_test_user: 'false',
  },
};

const CONTACTS_SEARCH_RESPONSE = {
  results: [TEST_USER_CONTACT, REAL_CONTACT],
  paging: null,
};

// ── Mock HubSpot server ────────────────────────────────────────────────────────
function startMockHubspot() {
  const state = { calls: [] };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const url = req.url.split('?')[0];

      state.calls.push({ url, method: req.method, at: Date.now() });

      if (url === '/crm/v3/objects/contacts/search') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(CONTACTS_SEARCH_RESPONSE));
      }

      // Other HubSpot probes (property creation, etc.) — return 200 OK so
      // startup side-effects don't produce noisy error logs.
      if (req.method === 'GET' && url.startsWith('/crm/v3/properties/contacts/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ name: 'hw_test_user', type: 'bool' }));
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: `no mock for ${req.method} ${url}` }));
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, state });
    });
  });
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────

function httpGet(base, urlPath, cookie) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, base);
    const req = http.request({
      method: 'GET',
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: cookie ? { Cookie: cookie } : {},
    }, res => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: raw, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function httpPost(base, urlPath, body, cookie) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, base);
    const bodyStr = JSON.stringify(body);
    const req = http.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, res => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: raw, json });
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function waitForServer(base, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await httpGet(base, '/api/turnstile-config', null);
      if (r.status === 200) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Test server did not start on ${base} within ${timeoutMs}ms`);
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
  console.log(`\n  dev-mode-filter  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL'}`);

  const pool = new Pool({ connectionString: connStr });
  const mock = await startMockHubspot();
  console.log(`  mock HubSpot listening on http://127.0.0.1:${mock.port}`);

  process.env.HUBSPOT_API_URL                   = `http://127.0.0.1:${mock.port}`;
  process.env.HUBSPOT_ACCESS_TOKEN              = 'privtest-dummy-token';
  process.env.PRIVTEST_USE_HUBSPOT_ACCESS_TOKEN = '1';
  process.env.PRIVTEST_USE_HUBSPOT_API_URL      = '1';

  const {
    spawnServer, seedUsers, cleanupTestData,
    resetRateLimitStore, login, setPool, BASE, PASSWORD,
  } = require('../privileges/harness');
  setPool(pool);

  await cleanupTestData(pool);
  const users = await seedUsers(pool, runId);

  const { child, logBuf } = spawnServer();

  let exitCode = 1;

  const cleanup = async () => {
    try { child.kill('SIGTERM'); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    try { mock.server.close(); } catch {}
  };
  process.on('SIGINT',  () => cleanup().then(() => process.exit(130)));
  process.on('SIGTERM', () => cleanup().then(() => process.exit(130)));

  try {
    await waitForServer(BASE);
    await resetRateLimitStore(pool);
    console.log(`  test server up at ${BASE}\n`);

    // Log in as admin and as a plain member.
    const adminClient  = await login(users.admin.email,  PASSWORD);
    const memberClient = await login(users.member.email, PASSWORD);
    const adminCookie  = adminClient.cookie;
    const memberCookie = memberClient.cookie;

    // Ensure dev mode starts as OFF (default after DB bootstrap).
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('dev_mode_enabled', 'false')
       ON CONFLICT (key) DO UPDATE SET value = 'false'`,
    );

    // Bust the contacts cache so the first GET fetches fresh from mock HubSpot.
    await httpPost(BASE, '/api/admin/test/bust-contacts-cache', {}, adminCookie);

    // ── (A) Baseline: dev mode OFF → all contacts returned ────────────────────
    console.log('  [A] Baseline — dev mode off, all contacts visible');

    const aRes = await httpGet(BASE, '/api/contacts-all', memberCookie);
    const aIds = (aRes.json?.results || []).map(c => c.id);

    record('A.1 contacts-all returns 200',
      aRes.status === 200,
      `status=${aRes.status}`);
    record('A.2 test-user contact is present',
      aIds.includes(TEST_USER_CONTACT.id),
      `ids=${JSON.stringify(aIds)}`);
    record('A.3 real contact is present',
      aIds.includes(REAL_CONTACT.id),
      `ids=${JSON.stringify(aIds)}`);
    record('A.4 total count includes both contacts',
      aRes.json?.total >= 2,
      `total=${aRes.json?.total}`);

    // ── (B) Toggle ON: only hw_test_user contacts shown ───────────────────────
    console.log('\n  [B] Toggle dev mode ON → only test-user contacts');

    const bToggle = await httpPost(BASE, '/api/admin/hubspot/dev-mode', { devMode: true }, adminCookie);

    record('B.1 POST dev-mode true returns 200',
      bToggle.status === 200,
      `status=${bToggle.status} body=${bToggle.body.slice(0, 80)}`);
    record('B.2 response echoes devMode=true',
      bToggle.json?.devMode === true,
      `devMode=${bToggle.json?.devMode}`);

    const bContacts = await httpGet(BASE, '/api/contacts-all', memberCookie);
    const bIds = (bContacts.json?.results || []).map(c => c.id);

    record('B.3 contacts-all returns 200',
      bContacts.status === 200,
      `status=${bContacts.status}`);
    record('B.4 test-user contact is present',
      bIds.includes(TEST_USER_CONTACT.id),
      `ids=${JSON.stringify(bIds)}`);
    record('B.5 real contact is absent (filtered out)',
      !bIds.includes(REAL_CONTACT.id),
      `ids=${JSON.stringify(bIds)}`);
    record('B.6 total count is 1 (only test-user contact)',
      bContacts.json?.total === 1,
      `total=${bContacts.json?.total}`);

    // ── (C) Toggle OFF: all contacts visible again ────────────────────────────
    console.log('\n  [C] Toggle dev mode OFF → all contacts visible again');

    const cToggle = await httpPost(BASE, '/api/admin/hubspot/dev-mode', { devMode: false }, adminCookie);

    record('C.1 POST dev-mode false returns 200',
      cToggle.status === 200,
      `status=${cToggle.status} body=${cToggle.body.slice(0, 80)}`);
    record('C.2 response echoes devMode=false',
      cToggle.json?.devMode === false,
      `devMode=${cToggle.json?.devMode}`);

    const cContacts = await httpGet(BASE, '/api/contacts-all', memberCookie);
    const cIds = (cContacts.json?.results || []).map(c => c.id);

    record('C.3 contacts-all returns 200',
      cContacts.status === 200,
      `status=${cContacts.status}`);
    record('C.4 test-user contact is present',
      cIds.includes(TEST_USER_CONTACT.id),
      `ids=${JSON.stringify(cIds)}`);
    record('C.5 real contact is present again',
      cIds.includes(REAL_CONTACT.id),
      `ids=${JSON.stringify(cIds)}`);
    record('C.6 total count includes both contacts again',
      cContacts.json?.total >= 2,
      `total=${cContacts.json?.total}`);

    // ── (D) Auth gate: non-admin gets 403 ─────────────────────────────────────
    console.log('\n  [D] Auth gate — non-admin user cannot toggle dev mode');

    const dToggle = await httpPost(BASE, '/api/admin/hubspot/dev-mode', { devMode: true }, memberCookie);

    record('D.1 member POST returns 403',
      dToggle.status === 403,
      `status=${dToggle.status} body=${dToggle.body.slice(0, 80)}`);

    // Confirm dev mode is still OFF (member toggle was rejected).
    const dGet = await httpGet(BASE, '/api/admin/hubspot/dev-mode', adminCookie);
    record('D.2 dev mode is still false after rejected member toggle',
      dGet.json?.devMode === false,
      `devMode=${dGet.json?.devMode}`);

    // ── (E) Audit log written on toggle ───────────────────────────────────────
    console.log('\n  [E] Audit log — set_dev_mode entries recorded');

    // We toggled twice via admin (B=true, C=false). Both should appear in the log.
    const { rows: auditRows } = await pool.query(
      `SELECT action_type, details FROM admin_audit_log
       WHERE action_type = 'set_dev_mode'
       ORDER BY acted_at DESC
       LIMIT 10`,
    );

    const auditDetails = auditRows.map(r => r.details);

    record('E.1 at least two set_dev_mode entries in audit log',
      auditRows.length >= 2,
      `count=${auditRows.length} details=${JSON.stringify(auditDetails)}`);
    record('E.2 audit log contains devMode=true entry',
      auditDetails.some(d => d && d.includes('devMode=true')),
      `details=${JSON.stringify(auditDetails)}`);
    record('E.3 audit log contains devMode=false entry',
      auditDetails.some(d => d && d.includes('devMode=false')),
      `details=${JSON.stringify(auditDetails)}`);

    // ── (F) GET /api/admin/hubspot/dev-mode reflects state ────────────────────
    console.log('\n  [F] GET dev-mode endpoint reflects current persisted state');

    // Toggle ON via DB directly to test the GET reflects it.
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('dev_mode_enabled', 'true')
       ON CONFLICT (key) DO UPDATE SET value = 'true'`,
    );

    const fGet = await httpGet(BASE, '/api/admin/hubspot/dev-mode', adminCookie);
    record('F.1 GET returns 200',
      fGet.status === 200,
      `status=${fGet.status}`);
    record('F.2 devMode is true after DB write',
      fGet.json?.devMode === true,
      `devMode=${fGet.json?.devMode}`);

    // Reset to false.
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('dev_mode_enabled', 'false')
       ON CONFLICT (key) DO UPDATE SET value = 'false'`,
    );

    const fGet2 = await httpGet(BASE, '/api/admin/hubspot/dev-mode', adminCookie);
    record('F.3 devMode is false after reset',
      fGet2.json?.devMode === false,
      `devMode=${fGet2.json?.devMode}`);

    // ── (G) Bad request: missing / non-boolean devMode body ───────────────────
    console.log('\n  [G] Validation — non-boolean devMode body rejected');

    const gBad = await httpPost(BASE, '/api/admin/hubspot/dev-mode', { devMode: 'yes' }, adminCookie);
    record('G.1 string devMode returns 400',
      gBad.status === 400,
      `status=${gBad.status} body=${gBad.body.slice(0, 80)}`);

    const failed = findings.filter(f => !f.ok).length;
    exitCode = failed === 0 ? 0 : 1;
    console.log(`\n  Results: ${findings.length - failed} passed, ${failed} failed`);
  } catch (e) {
    console.error('Test crashed:', e);
    console.error('--- server log (last 2000 chars) ---');
    console.error(logBuf.join('').slice(-2000));
  } finally {
    await writeReport(runId);
    await cleanup();
    process.exit(exitCode);
  }
}

async function writeReport(runId) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Dev-Mode Filter — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:dev-mode-filter\``,
    '',
    '## Summary',
    '',
    `- Passed: ${findings.filter(f => f.ok).length} / ${findings.length}`,
    `- Failed: ${findings.filter(f => !f.ok).length} / ${findings.length}`,
    '',
    '## Results',
    '',
    '| Result | Probe | Detail |',
    '|---|---|---|',
    ...findings.map(f => `| ${f.ok ? 'PASS' : 'FAIL'} | ${esc(f.id)} | ${esc(f.detail)} |`),
    '',
    '## Coverage',
    '',
    '- **(A) Baseline (dev mode off)**: `GET /api/contacts-all` returns all contacts',
    '  — both the `hw_test_user=true` and `hw_test_user=false` contact.',
    '- **(B) Toggle ON**: `POST /api/admin/hubspot/dev-mode { devMode: true }` persists the',
    '  flag in `app_settings`; subsequent `GET /api/contacts-all` returns only the',
    '  `hw_test_user=true` contact, filtering out the real customer.',
    '- **(C) Toggle OFF**: `POST /api/admin/hubspot/dev-mode { devMode: false }` restores',
    '  full visibility — both contacts are returned again.',
    '- **(D) Auth gate**: a non-admin (member-level) session receives 403 on the toggle',
    '  endpoint; the setting is unchanged.',
    '- **(E) Audit log**: each admin toggle writes an `admin_audit_log` row with',
    '  `action_type = \'set_dev_mode\'` and the correct `devMode=<bool>` details.',
    '- **(F) GET reflects state**: `GET /api/admin/hubspot/dev-mode` reads directly from',
    '  `app_settings` and reflects the current persisted value immediately.',
    '- **(G) Validation**: a non-boolean `devMode` body value is rejected with 400.',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
}

main();
