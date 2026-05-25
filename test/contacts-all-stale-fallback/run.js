'use strict';
// test/contacts-all-stale-fallback/run.js
//
// Focused integration test verifying that GET /api/contacts-all stays usable
// when HubSpot is down, and correctly expires the stale cache after the 1-hour
// hard cap (exercised via ALL_CONTACTS_STALE_MAX_MS_OVERRIDE).
//
//   (A) HubSpot 503 → stale: after a fresh cache is seeded, HubSpot starts
//       returning 503 on every attempt. The endpoint must serve the stale
//       contacts with X-Cache-Status: stale instead of a 502.
//
//   (B) Network error → stale: HubSpot drops the connection entirely (socket
//       closed). The endpoint must still serve the stale contacts.
//
//   (C) Stale cap exceeded → 502: when the stale snapshot is older than the
//       hard cap (200 ms in this test via override), the endpoint must return
//       502 instead of serving expired data.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:contacts-all-stale-fallback
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:contacts-all-stale-fallback

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

require('dotenv').config();

const REPORT_PATH = path.join(__dirname, '..', '..', 'test-results', 'contacts-all-stale-fallback.md');
const findings = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}

// ── Shared fixture ─────────────────────────────────────────────────────────────

const CONTACTS_SEARCH_SUCCESS = {
  results: [
    {
      id: '99',
      properties: {
        firstname: 'Stale',
        lastname: 'Tester',
        email: 'stale@example.com',
        phone: '555-0199',
        hs_lead_status: 'OPEN_DEAL',
        createdate: '2024-06-01T00:00:00.000Z',
        hw_test_user: 'true',
      },
    },
  ],
  paging: null,
};

// ── Mock HubSpot server ────────────────────────────────────────────────────────
// Modes (per endpoint):
//   'ok'          — always 200 with successBody
//   'always503'   — every hit returns 503 with Retry-After: 0 (fast retries)
//   'dropSocket'  — closes the socket immediately (simulates network failure)
function startMockHubspot() {
  const state = {
    mode: 'ok',
    calls: [],
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const url = req.url.split('?')[0];

      if (!url.startsWith('/crm/v3/objects/contacts/search')) {
        state.calls.push({ url, status: 404, at: Date.now() });
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'error', message: `no mock for ${url}` }));
      }

      if (state.mode === 'always503') {
        state.calls.push({ url, status: 503, at: Date.now() });
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '0' });
        return res.end(JSON.stringify({ status: 'error', message: 'service unavailable' }));
      }

      if (state.mode === 'dropSocket') {
        state.calls.push({ url, status: 'drop', at: Date.now() });
        req.socket.destroy();
        return;
      }

      // 'ok'
      state.calls.push({ url, status: 200, at: Date.now() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(CONTACTS_SEARCH_SUCCESS));
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
  console.log(`\n  contacts-all-stale-fallback  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL'}`);

  const pool = new Pool({ connectionString: connStr });
  const mock = await startMockHubspot();
  console.log(`  mock HubSpot listening on http://127.0.0.1:${mock.port}`);

  process.env.HUBSPOT_API_URL                   = `http://127.0.0.1:${mock.port}`;
  process.env.HUBSPOT_ACCESS_TOKEN              = 'privtest-dummy-token';
  process.env.PRIVTEST_USE_HUBSPOT_ACCESS_TOKEN = '1';

  const {
    spawnServer, seedUsers, cleanupTestData,
    resetRateLimitStore, login, setPool, BASE, PASSWORD,
  } = require('../privileges/harness');
  setPool(pool);

  await cleanupTestData(pool);
  const users = await seedUsers(pool, runId);

  // Server 1 (port 5050): used for (A) and (B) — normal stale-on-failure tests.
  const { child: child1, logBuf: logBuf1 } = spawnServer();

  // Server 2 (port 5051): used for (C) — stale cap exceeded → 502.
  // Uses a 200 ms stale cap so the test doesn't have to wait a real hour.
  const BASE2 = 'http://127.0.0.1:5051';
  const { child: child2, logBuf: logBuf2 } = spawnServer({
    extraEnv: {
      PORT: '5051',
      ALL_CONTACTS_STALE_MAX_MS_OVERRIDE: '200',
    },
  });

  let exitCode = 1;

  const cleanup = async () => {
    try { child1.kill('SIGTERM'); } catch {}
    try { child2.kill('SIGTERM'); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    try { mock.server.close(); } catch {}
  };
  process.on('SIGINT',  () => cleanup().then(() => process.exit(130)));
  process.on('SIGTERM', () => cleanup().then(() => process.exit(130)));

  try {
    await Promise.all([
      waitForServer(BASE),
      waitForServer(BASE2),
    ]);
    await resetRateLimitStore(pool);
    console.log(`  test server 1 up at ${BASE}`);
    console.log(`  test server 2 up at ${BASE2}\n`);

    // Both servers share the same session store (same DB + SESSION_SECRET).
    const memberClient = await login(users.member.email, PASSWORD);
    const memberCookie = memberClient.cookie;
    const adminClient  = await login(users.admin.email, PASSWORD);
    const adminCookie  = adminClient.cookie;

    // ── (A) HubSpot 503 → stale ───────────────────────────────────────────────
    // Seed _allContactsLastGood on server 1 with a fresh successful fetch.
    // Then switch the mock to always-503 and bust the fresh cache.
    // The endpoint must return 200 with X-Cache-Status: stale.
    console.log('  [A] HubSpot 503 → stale cache fallback');
    mock.state.mode = 'ok';
    mock.state.calls = [];

    const aWarm = await httpGet(BASE, '/api/contacts-all', memberCookie);
    record('A.1 warm-up request returns 200',
      aWarm.status === 200,
      `status=${aWarm.status}`);
    record('A.2 warm-up response has contacts',
      aWarm.json && Array.isArray(aWarm.json.results) && aWarm.json.results.length >= 1,
      `count=${aWarm.json?.results?.length}`);

    // Bust the fresh cache while preserving _allContactsLastGood.
    const aBust = await httpPost(BASE, '/api/admin/test/bust-contacts-cache', {}, adminCookie);
    record('A.3 bust-contacts-cache returns 200',
      aBust.status === 200 && aBust.json?.ok === true,
      `status=${aBust.status} body=${aBust.body.slice(0, 80)}`);

    // Switch mock to always-503.
    mock.state.mode = 'always503';
    mock.state.calls = [];

    const aStale = await httpGet(BASE, '/api/contacts-all', memberCookie);
    const aSearchCalls = mock.state.calls.filter(c => c.url.startsWith('/crm/v3/objects/contacts/search'));

    record('A.4 endpoint returns 200 despite 503s',
      aStale.status === 200,
      `status=${aStale.status} body=${aStale.body.slice(0, 120)}`);
    record('A.5 X-Cache-Status is stale',
      aStale.headers['x-cache-status'] === 'stale',
      `x-cache-status=${aStale.headers['x-cache-status']}`);
    record('A.6 contacts in stale response match seed data',
      aStale.json && Array.isArray(aStale.json.results) && aStale.json.results.length >= 1,
      `count=${aStale.json?.results?.length}`);
    record('A.7 all HubSpot search calls returned 503',
      aSearchCalls.length > 0 && aSearchCalls.every(c => c.status === 503),
      `calls=${aSearchCalls.length} statuses=${aSearchCalls.map(c => c.status).join(',')}`);

    // ── (B) Network error (socket drop) → stale ────────────────────────────────
    // Same as (A) but the mock drops the socket instead of returning a status.
    // _allContactsLastGood is still warm from (A).
    console.log('\n  [B] Network error (socket drop) → stale cache fallback');
    mock.state.mode = 'dropSocket';
    mock.state.calls = [];

    const bStale = await httpGet(BASE, '/api/contacts-all', memberCookie);

    record('B.1 endpoint returns 200 despite socket drops',
      bStale.status === 200,
      `status=${bStale.status} body=${bStale.body.slice(0, 120)}`);
    record('B.2 X-Cache-Status is stale',
      bStale.headers['x-cache-status'] === 'stale',
      `x-cache-status=${bStale.headers['x-cache-status']}`);
    record('B.3 contacts in stale response match seed data',
      bStale.json && Array.isArray(bStale.json.results) && bStale.json.results.length >= 1,
      `count=${bStale.json?.results?.length}`);

    // ── (C) Stale cap exceeded → 502 ──────────────────────────────────────────
    // Server 2 uses ALL_CONTACTS_STALE_MAX_MS_OVERRIDE=200 (200 ms stale cap).
    // Seed _allContactsLastGood on server 2 via a successful fetch.
    // Bust the fresh cache, wait 300 ms (> 200 ms cap) so the snapshot expires.
    // With HubSpot still returning 503, the endpoint must return 502.
    console.log('\n  [C] Stale cap exceeded → 502');
    mock.state.mode = 'ok';
    mock.state.calls = [];

    const cWarm = await httpGet(BASE2, '/api/contacts-all', memberCookie);
    record('C.1 warm-up on server 2 returns 200',
      cWarm.status === 200,
      `status=${cWarm.status}`);

    const cBust = await httpPost(BASE2, '/api/admin/test/bust-contacts-cache', {}, adminCookie);
    record('C.2 bust-contacts-cache on server 2 succeeds',
      cBust.status === 200 && cBust.json?.ok === true,
      `status=${cBust.status} body=${cBust.body.slice(0, 80)}`);

    // Wait longer than the 200 ms stale cap so the snapshot is considered expired.
    await new Promise(r => setTimeout(r, 350));

    mock.state.mode = 'always503';
    mock.state.calls = [];

    const cExpired = await httpGet(BASE2, '/api/contacts-all', memberCookie);
    const cSearchCalls = mock.state.calls.filter(c => c.url.startsWith('/crm/v3/objects/contacts/search'));

    record('C.3 endpoint returns 502 after stale cap expired',
      cExpired.status === 502,
      `status=${cExpired.status} body=${cExpired.body.slice(0, 160)}`);
    record('C.4 error body has HUBSPOT_ERROR code',
      cExpired.json?.code === 'HUBSPOT_ERROR' || cExpired.json?.code === 'HUBSPOT_RATE_LIMIT',
      `code=${cExpired.json?.code}`);
    record('C.5 HubSpot search was attempted (not served from old stale)',
      cSearchCalls.length > 0,
      `search calls=${cSearchCalls.length}`);

    const failed = findings.filter(f => !f.ok).length;
    exitCode = failed === 0 ? 0 : 1;
    console.log(`\n  Results: ${findings.length - failed} passed, ${failed} failed`);
  } catch (e) {
    console.error('Test crashed:', e);
    console.error('--- server 1 log (last 2000 chars) ---');
    console.error(logBuf1.join('').slice(-2000));
    console.error('--- server 2 log (last 2000 chars) ---');
    console.error(logBuf2.join('').slice(-2000));
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
    '# Contacts-All Stale Fallback — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:contacts-all-stale-fallback\``,
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
    '- **(A) HubSpot 503 → stale**: after a fresh cache is seeded,',
    '  `/crm/v3/objects/contacts/search` returns 503 on every attempt',
    '  (all 4 retries exhausted). `GET /api/contacts-all` must serve the',
    '  previously-fetched contacts with `X-Cache-Status: stale` instead of',
    '  returning a 502.',
    '- **(B) Network error → stale**: same scenario but the mock drops the TCP',
    '  socket instead of returning an HTTP status. The stale fallback must still',
    '  apply — network-level failures are treated identically to 5xx errors.',
    '- **(C) Stale cap exceeded → 502**: when the stale snapshot is older than',
    '  the hard cap (exercised via `ALL_CONTACTS_STALE_MAX_MS_OVERRIDE=200`),',
    '  the endpoint must return 502 rather than serving an arbitrarily-old list.',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
}

main();
