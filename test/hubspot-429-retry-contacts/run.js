'use strict';
// test/hubspot-429-retry-contacts/run.js
//
// Focused integration test confirming that GET /api/contacts-all and
// GET /api/open-leads recover from a transient HubSpot 429 via
// hubspotSearchWithRetry.
//
//   (CA) contacts-all retry — GET /api/contacts-all: first call to
//        /crm/v3/objects/contacts/search returns 429 + Retry-After: 0;
//        retry succeeds → endpoint returns a contact list.
//
//   (OL) open-leads retry — GET /api/open-leads: first call to
//        /crm/v3/objects/contacts/search returns 429 + Retry-After: 0;
//        retry succeeds → endpoint returns leads.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:hubspot-429-retry-contacts
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:hubspot-429-retry-contacts

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

require('dotenv').config();

const REPORT_PATH = path.join(__dirname, '..', '..', 'test-results', 'hubspot-429-retry-contacts.md');
const findings = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}

// ── Shared response fixtures ──────────────────────────────────────────────────

const CONTACTS_SEARCH_SUCCESS = {
  results: [
    {
      id: '42',
      properties: {
        firstname: 'Test',
        lastname: 'Contact',
        email: 'test@example.com',
        phone: '555-0100',
        hs_lead_status: 'OPEN_DEAL',
        createdate: '2024-01-01T00:00:00.000Z',
        hw_test_user: 'true',
      },
    },
  ],
  paging: null,
};

// ── Mock HubSpot server ───────────────────────────────────────────────────────
// Each endpoint rule has an independent hit counter. In 'retryOnce' mode the
// first hit returns 429 + Retry-After: 0 (instant retry so tests stay fast);
// subsequent hits return successBody with 200. 'ok' mode always returns 200.

function startMockHubspot() {
  const rules = {};

  function configEndpoint(urlPrefix, mode, successBody) {
    rules[urlPrefix] = { mode, hits: 0, successBody };
  }

  function resetHits() {
    for (const r of Object.values(rules)) r.hits = 0;
  }

  const calls = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const url = req.url.split('?')[0];

      let matched = null;
      for (const prefix of Object.keys(rules)) {
        if (url.startsWith(prefix)) {
          if (!matched || prefix.length > matched.length) matched = prefix;
        }
      }

      if (!matched) {
        calls.push({ url, status: 404, at: Date.now() });
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'error', message: `no mock for ${url}` }));
      }

      const rule = rules[matched];
      rule.hits++;

      if (rule.mode === 'retryOnce' && rule.hits === 1) {
        calls.push({ url, status: 429, at: Date.now() });
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
        return res.end(JSON.stringify({ status: 'error', message: 'rate limited' }));
      }

      calls.push({ url, status: 200, at: Date.now() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rule.successBody));
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, rules, calls, configEndpoint, resetHits });
    });
  });
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function httpGet(base, urlPath, cookie) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, base);
    const req = http.request({
      method: 'GET',
      hostname: u.hostname,
      port:     u.port,
      path:     u.pathname + u.search,
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

// ── Main ─────────────────────────────────────────────────────────────────────
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
  console.log(`\n  hubspot-429-retry-contacts  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL'}`);

  const pool = new Pool({ connectionString: connStr });
  const mock = await startMockHubspot();
  console.log(`  mock HubSpot listening on http://127.0.0.1:${mock.port}`);

  process.env.HUBSPOT_API_URL                   = `http://127.0.0.1:${mock.port}`;
  process.env.HUBSPOT_ACCESS_TOKEN              = 'privtest-dummy-token';
  process.env.PRIVTEST_USE_HUBSPOT_ACCESS_TOKEN = '1';

  const {
    spawnServer, waitForServer, seedUsers, cleanupTestData,
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
    await waitForServer();
    await resetRateLimitStore(pool);
    console.log(`  test server up at ${BASE}\n`);

    const client = await login(users.member.email, PASSWORD);
    const cookie = client.cookie;

    // ── (CA) contacts-all: search 429 → retry → success ───────────────────────
    // The shared contacts cache starts cold on a fresh server. The first call to
    // fetchAllContactsShared hits hubspotSearchWithRetry which returns 429 on the
    // first attempt then succeeds on the retry. The endpoint must return a
    // non-empty contact list (pagination = null so one page only).
    console.log('  [CA] contacts-all: search 429 → retry → success');
    mock.configEndpoint(
      '/crm/v3/objects/contacts/search',
      'retryOnce',
      CONTACTS_SEARCH_SUCCESS,
    );
    mock.calls.length = 0;

    const ca = await httpGet(BASE, '/api/contacts-all', cookie);

    const caSearchCalls = mock.calls.filter(c =>
      c.url.startsWith('/crm/v3/objects/contacts/search'),
    );

    record('CA.1 endpoint returns 200',
      ca.status === 200,
      `status=${ca.status}`);
    record('CA.2 results array present in response',
      ca.json && Array.isArray(ca.json.results),
      `body=${ca.body.slice(0, 160)}`);
    record('CA.3 at least one contact returned',
      ca.json && Array.isArray(ca.json.results) && ca.json.results.length >= 1,
      `count=${ca.json?.results?.length}`);
    record('CA.4 search was called twice (429 + retry)',
      caSearchCalls.length === 2,
      `search calls=${caSearchCalls.length} statuses=${caSearchCalls.map(c => c.status).join(',')}`);
    record('CA.5 first search call was a 429',
      caSearchCalls[0]?.status === 429,
      `first status=${caSearchCalls[0]?.status}`);
    record('CA.6 second search call succeeded (200)',
      caSearchCalls[1]?.status === 200,
      `second status=${caSearchCalls[1]?.status}`);

    // ── (OL) open-leads: fan-out search 429 → retry → success ─────────────────
    // The open-leads cache starts cold on a fresh server. The first call to the
    // _openLeadsInFlight async fn hits hubspotSearchWithRetry which returns 429
    // on the first attempt then succeeds on the retry. The endpoint must return
    // a results array.
    // The contacts-all test populated the shared contacts cache, but open-leads
    // has its own separate _openLeadsCache, which is still cold.
    console.log('\n  [OL] open-leads: fan-out search 429 → retry → success');
    mock.resetHits();
    mock.calls.length = 0;
    mock.configEndpoint(
      '/crm/v3/objects/contacts/search',
      'retryOnce',
      CONTACTS_SEARCH_SUCCESS,
    );

    const ol = await httpGet(BASE, '/api/open-leads', cookie);

    const olSearchCalls = mock.calls.filter(c =>
      c.url.startsWith('/crm/v3/objects/contacts/search'),
    );

    record('OL.1 endpoint returns 200',
      ol.status === 200,
      `status=${ol.status}`);
    record('OL.2 results array present in response',
      ol.json && Array.isArray(ol.json.results),
      `body=${ol.body.slice(0, 160)}`);
    record('OL.3 search was called twice (429 + retry)',
      olSearchCalls.length === 2,
      `search calls=${olSearchCalls.length} statuses=${olSearchCalls.map(c => c.status).join(',')}`);
    record('OL.4 first search call was a 429',
      olSearchCalls[0]?.status === 429,
      `first status=${olSearchCalls[0]?.status}`);
    record('OL.5 second search call succeeded (200)',
      olSearchCalls[1]?.status === 200,
      `second status=${olSearchCalls[1]?.status}`);

    const failed = findings.filter(f => !f.ok).length;
    exitCode = failed === 0 ? 0 : 1;
    console.log(`\n  Results: ${findings.length - failed} passed, ${failed} failed`);
  } catch (e) {
    console.error('Test crashed:', e);
    console.error(logBuf.join('').slice(-3000));
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
    '# HubSpot 429 Retry Recovery — contacts-all & open-leads — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:hubspot-429-retry-contacts\``,
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
    '- **(CA) contacts-all retry**: `GET /api/contacts-all` with',
    '  `/crm/v3/objects/contacts/search` returning 429 on the first attempt',
    '  recovers via `hubspotSearchWithRetry` (now used by `fetchAllContactsShared`)',
    '  and returns a valid contact list.',
    '- **(OL) open-leads retry**: `GET /api/open-leads` with',
    '  `/crm/v3/objects/contacts/search` returning 429 on the first attempt',
    '  recovers via `hubspotSearchWithRetry` and returns a valid leads list.',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
}

main();
