'use strict';
// test/hubspot-429-retry-contacts/run.js
//
// Focused integration test confirming that GET /api/contacts-all and
// GET /api/open-leads recover from a transient HubSpot 429 via
// hubspotSearchWithRetry, that contacts-all behaves correctly when all
// retries are exhausted (both the no-cache error path and the stale-cache
// fallback path), that the endpoint recovers and fetches fresh data once
// HubSpot stops rate-limiting, and that GET /api/localdata/all serves
// stale room data from the catch-block fallback when the stale cap has expired.
//
//   (CA) contacts-all retry — GET /api/contacts-all: first call to
//        /crm/v3/objects/contacts/search returns 429 + Retry-After: 0;
//        retry succeeds → endpoint returns a contact list.
//
//   (OL) open-leads retry — GET /api/open-leads: first call to
//        /crm/v3/objects/contacts/search returns 429 + Retry-After: 0;
//        retry succeeds → endpoint returns leads.
//
//   (OL-R) open-leads recovery — after _openLeadsCache is warmed (OL state),
//          its TTL is expired via bust-open-leads-cache, a 429 storm causes
//          stale data to be served, then switching HubSpot back to ok causes
//          the next request to perform a fresh fetch (HubSpot is actually
//          called, X-Cache-Status is not stale). A follow-up request is served
//          from the newly populated in-memory cache with no new HubSpot call.
//
//   (OL-F) open-leads exhausted — all retry attempts return 429 with no
//          prior _openLeadsCache → endpoint returns 502 with code HUBSPOT_RATE_LIMIT.
//          Uses Server 2 (cold for open-leads) to keep the scenario isolated.
//
//   (CA-F) contacts-all exhausted — all retry attempts return 429 with no
//          prior good cache → endpoint returns 502 with code HUBSPOT_RATE_LIMIT.
//
//   (CA-S) contacts-all stale fallback — after a prior good response was
//          cached, a sustained HubSpot outage (all retries 429) causes the
//          endpoint to serve the stale cache with X-Cache-Status: stale
//          instead of returning an error.
//
//   (CA-R) contacts-all recovery — after a 429 storm has caused stale data
//          to be served (CA-S state), switching HubSpot back to ok causes the
//          next request to perform a fresh fetch (HubSpot is actually called,
//          X-Cache-Status is not stale). A follow-up request is then served
//          from the newly populated in-memory cache with no new HubSpot call.
//
//   (LD) localdata/all catch-block stale fallback — after _allContactsLastGood
//        is populated with rooms data and the stale cap has expired (via
//        ALL_CONTACTS_STALE_MAX_MS_OVERRIDE=1), a sustained HubSpot outage
//        causes getSharedContactsCache() to throw; the catch block in
//        GET /api/localdata/all falls back to _allContactsLastGood and returns
//        the room map instead of {}.
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

const CONTACTS_WITH_ROOMS_SUCCESS = {
  results: [
    {
      id: '77',
      properties: {
        firstname: 'Room',
        lastname: 'Contact',
        email: 'rooms@example.com',
        phone: '555-0300',
        hs_lead_status: 'OPEN_DEAL',
        createdate: '2024-01-01T00:00:00.000Z',
        hw_test_user: 'true',
        measure_once_rooms: JSON.stringify([
          { room: 'Kitchen', stageKey: 'measure', assignedFitterId: null, installStart: null },
        ]),
      },
    },
  ],
  paging: null,
};

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
// Each endpoint rule has an independent hit counter. Modes:
//   'retryOnce'  — first hit returns 429 + Retry-After: 0; subsequent hits 200
//   'ok'         — always returns 200 with successBody
//   'alwaysFail' — every hit returns 429 (simulates all retries exhausted)

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

      if (rule.mode === 'alwaysFail') {
        calls.push({ url, status: 429, at: Date.now() });
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
        return res.end(JSON.stringify({ status: 'error', message: 'rate limited (exhausted)' }));
      }

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

// ── HTTP helpers ──────────────────────────────────────────────────────────────
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

function httpPost(base, urlPath, body, cookie) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, base);
    const bodyStr = JSON.stringify(body);
    const req = http.request({
      method: 'POST',
      hostname: u.hostname,
      port:     u.port,
      path:     u.pathname + u.search,
      headers: {
        'Content-Type':   'application/json',
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
    spawnServer, waitForServer: harnessWait, seedUsers, cleanupTestData,
    resetRateLimitStore, login, setPool, BASE, PASSWORD,
  } = require('../privileges/harness');
  setPool(pool);

  await cleanupTestData(pool);
  const users = await seedUsers(pool, runId);

  // ── Server 1 (port 5050): transient-retry tests (CA + OL) ────────────────
  const { child: child1, logBuf: logBuf1 } = spawnServer();

  // ── Server 2 (port 5051): exhausted-retry + stale-fallback tests (CA-F + CA-S) ──
  const BASE2 = 'http://127.0.0.1:5051';
  const { child: child2, logBuf: logBuf2 } = spawnServer({ extraEnv: { PORT: '5051' } });

  // ── Server 3 (port 5052): localdata/all catch-block stale fallback (LD) ──
  // ALL_CONTACTS_STALE_MAX_MS_OVERRIDE=1 makes the stale cap expire in 1 ms,
  // so getSharedContactsCache() throws instead of returning stale contacts.
  // This exercises the new catch block in GET /api/localdata/all.
  const BASE3 = 'http://127.0.0.1:5052';
  const { child: child3, logBuf: logBuf3 } = spawnServer({
    extraEnv: { PORT: '5052', ALL_CONTACTS_STALE_MAX_MS_OVERRIDE: '1' },
  });

  let exitCode = 1;

  const cleanup = async () => {
    try { child1.kill('SIGTERM'); } catch {}
    try { child2.kill('SIGTERM'); } catch {}
    try { child3.kill('SIGTERM'); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    try { mock.server.close(); } catch {}
  };
  process.on('SIGINT',  () => cleanup().then(() => process.exit(130)));
  process.on('SIGTERM', () => cleanup().then(() => process.exit(130)));

  try {
    // All servers start in parallel to save time.
    await Promise.all([
      harnessWait(),
      waitForServer(BASE2),
      waitForServer(BASE3),
    ]);
    await resetRateLimitStore(pool);
    console.log(`  test server 1 up at ${BASE}`);
    console.log(`  test server 2 up at ${BASE2}`);
    console.log(`  test server 3 up at ${BASE3}\n`);

    const client = await login(users.member.email, PASSWORD);
    const cookie = client.cookie;

    // Both servers share the same session store (same DB + SESSION_SECRET), so
    // sessions created on server 1 are valid on server 2.  We create all needed
    // cookies once here and reuse them across both servers.
    const adminClient = await login(users.admin.email, PASSWORD);
    const adminCookie = adminClient.cookie;

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

    // ── (OL-R) open-leads: recovery after 429 storm ───────────────────────────
    // Continues directly from OL state on Server 1:
    //   _openLeadsCache — populated with a fresh result from the OL test
    // Step 1: expire the cache via bust-open-leads-cache (sets fetchedAt = 0).
    //         The data is kept so the stale-fallback path can be exercised.
    // Step 2: switch mock to alwaysFail and make a GET — cache is expired so a
    //         fresh HubSpot fetch is attempted; all retries fail; _openLeadsCache
    //         is still non-null so the handler falls back to stale data.
    // Step 3: switch mock back to 'ok' — the cache is still expired (fetchedAt
    //         was not updated during the stale serve), so the next request must
    //         perform a real HubSpot fetch.  The response must:
    //           • return 200
    //           • NOT have X-Cache-Status: stale (fresh data returned)
    //           • show at least one successful HubSpot search call in mock.calls
    //         A follow-up GET must be served from the newly populated in-memory
    //         cache with no additional HubSpot call.
    console.log('\n  [OL-R] open-leads: recovery after 429 storm → stale → fresh → cached');

    // Step 1: expire _openLeadsCache so the TTL check fails on the next request.
    const olrBust = await httpPost(BASE, '/api/admin/test/bust-open-leads-cache', {}, adminCookie);
    record('OL-R.1 bust-open-leads-cache succeeds',
      olrBust.status === 200 && olrBust.json?.ok === true,
      `status=${olrBust.status} body=${olrBust.body.slice(0, 120)}`);

    // Step 2: exhaust retries — stale data should be served.
    mock.resetHits();
    mock.calls.length = 0;
    mock.configEndpoint(
      '/crm/v3/objects/contacts/search',
      'alwaysFail',
      null,
    );

    const olrStale = await httpGet(BASE, '/api/open-leads', cookie);

    const olrStaleSearchCalls = mock.calls.filter(c =>
      c.url.startsWith('/crm/v3/objects/contacts/search'),
    );

    record('OL-R.2 stale response returns 200',
      olrStale.status === 200,
      `status=${olrStale.status}`);
    record('OL-R.3 results array present in stale response',
      olrStale.json && Array.isArray(olrStale.json.results),
      `body=${olrStale.body.slice(0, 160)}`);
    record('OL-R.4 X-Cache-Status is stale',
      olrStale.headers['x-cache-status'] === 'stale',
      `x-cache-status=${olrStale.headers['x-cache-status']}`);
    record('OL-R.5 all search attempts during stale request were 429s (4 attempts)',
      olrStaleSearchCalls.length === 4 && olrStaleSearchCalls.every(c => c.status === 429),
      `search calls=${olrStaleSearchCalls.length} statuses=${olrStaleSearchCalls.map(c => c.status).join(',')}`);

    // Step 3: switch mock back to ok — recovery fetch must not return stale.
    mock.resetHits();
    mock.calls.length = 0;
    mock.configEndpoint(
      '/crm/v3/objects/contacts/search',
      'ok',
      CONTACTS_SEARCH_SUCCESS,
    );

    const olrFresh = await httpGet(BASE, '/api/open-leads', cookie);

    const olrFreshSearchCalls = mock.calls.filter(c =>
      c.url.startsWith('/crm/v3/objects/contacts/search'),
    );

    record('OL-R.6 endpoint returns 200 after storm clears',
      olrFresh.status === 200,
      `status=${olrFresh.status}`);
    record('OL-R.7 results array present in fresh response',
      olrFresh.json && Array.isArray(olrFresh.json.results),
      `body=${olrFresh.body.slice(0, 160)}`);
    record('OL-R.8 X-Cache-Status is not stale (fresh data returned)',
      olrFresh.headers['x-cache-status'] !== 'stale',
      `x-cache-status=${olrFresh.headers['x-cache-status']}`);
    record('OL-R.9 HubSpot was actually called during recovery fetch',
      olrFreshSearchCalls.length >= 1 && olrFreshSearchCalls.every(c => c.status === 200),
      `search calls=${olrFreshSearchCalls.length} statuses=${olrFreshSearchCalls.map(c => c.status).join(',')}`);

    // Follow-up GET — must be served from the newly populated in-memory cache
    // with no new outbound HubSpot call.
    mock.calls.length = 0;

    const olrCached = await httpGet(BASE, '/api/open-leads', cookie);

    const olrCachedSearchCalls = mock.calls.filter(c =>
      c.url.startsWith('/crm/v3/objects/contacts/search'),
    );

    record('OL-R.10 follow-up GET returns 200 (in-memory cache hit)',
      olrCached.status === 200,
      `status=${olrCached.status}`);
    record('OL-R.11 no new HubSpot call for follow-up GET (served from cache)',
      olrCachedSearchCalls.length === 0,
      `search calls=${olrCachedSearchCalls.length}`);

    // ── (OL-F) open-leads: all retries exhausted, no prior cache → 502 ─────────
    // Server 2 starts cold for open-leads (_openLeadsCache is null — none of the
    // preceding tests called /api/open-leads on Server 2). Mock is set to
    // alwaysFail so every attempt returns 429. With no _openLeadsCache to fall
    // back on the endpoint must return 502 with code HUBSPOT_RATE_LIMIT.
    console.log('\n  [OL-F] open-leads: all retries exhausted, no cache → 502');
    mock.resetHits();
    mock.calls.length = 0;
    mock.configEndpoint(
      '/crm/v3/objects/contacts/search',
      'alwaysFail',
      null,
    );

    const olf = await httpGet(BASE2, '/api/open-leads', cookie);

    const olfSearchCalls = mock.calls.filter(c =>
      c.url.startsWith('/crm/v3/objects/contacts/search'),
    );

    record('OL-F.1 endpoint returns 502',
      olf.status === 502,
      `status=${olf.status}`);
    record('OL-F.2 error code is HUBSPOT_RATE_LIMIT',
      olf.json?.code === 'HUBSPOT_RATE_LIMIT',
      `code=${olf.json?.code} body=${olf.body.slice(0, 160)}`);
    record('OL-F.3 all search attempts were 429s (4 attempts)',
      olfSearchCalls.length === 4 && olfSearchCalls.every(c => c.status === 429),
      `search calls=${olfSearchCalls.length} statuses=${olfSearchCalls.map(c => c.status).join(',')}`);

    // ── (CA-F) contacts-all: all retries exhausted, no prior cache → 502 ──────
    // Server 2 starts cold (no caches). Mock is set to alwaysFail so every
    // attempt returns 429. With no _allContactsLastGood to fall back on the
    // endpoint must return 502 with code HUBSPOT_RATE_LIMIT.
    console.log('\n  [CA-F] contacts-all: all retries exhausted, no cache → 502');
    mock.resetHits();
    mock.calls.length = 0;
    mock.configEndpoint(
      '/crm/v3/objects/contacts/search',
      'alwaysFail',
      null,
    );

    const caf = await httpGet(BASE2, '/api/contacts-all', cookie);

    const cafSearchCalls = mock.calls.filter(c =>
      c.url.startsWith('/crm/v3/objects/contacts/search'),
    );

    record('CA-F.1 endpoint returns 502',
      caf.status === 502,
      `status=${caf.status}`);
    record('CA-F.2 error code is HUBSPOT_RATE_LIMIT',
      caf.json?.code === 'HUBSPOT_RATE_LIMIT',
      `code=${caf.json?.code} body=${caf.body.slice(0, 160)}`);
    record('CA-F.3 all search attempts were 429s (4 attempts)',
      cafSearchCalls.length === 4 && cafSearchCalls.every(c => c.status === 429),
      `search calls=${cafSearchCalls.length} statuses=${cafSearchCalls.map(c => c.status).join(',')}`);

    // ── (CA-S) contacts-all: all retries exhausted, stale cache available → 200 ─
    // On server 2, first make a successful request (sets _allContactsLastGood).
    // Then bust the fresh cache so the next request hits HubSpot again. With
    // mock set to alwaysFail, the fresh fetch fails but the endpoint should
    // serve the stale contacts with X-Cache-Status: stale.
    console.log('\n  [CA-S] contacts-all: all retries exhausted, stale cache fallback → 200');
    mock.resetHits();
    mock.calls.length = 0;
    mock.configEndpoint(
      '/crm/v3/objects/contacts/search',
      'ok',
      CONTACTS_SEARCH_SUCCESS,
    );

    // Warm up both _allContactsCache and _allContactsLastGood via a successful fetch.
    const casWarm = await httpGet(BASE2, '/api/contacts-all', cookie);
    record('CA-S.1 warm-up request succeeds',
      casWarm.status === 200,
      `status=${casWarm.status}`);

    // Bust only the fresh cache (_allContactsLastGood survives) — admin required.
    const bust = await httpPost(BASE2, '/api/admin/test/bust-contacts-cache', {}, adminCookie);
    record('CA-S.2 bust-contacts-cache succeeds',
      bust.status === 200 && bust.json?.ok === true,
      `status=${bust.status} body=${bust.body.slice(0, 120)}`);

    // Switch mock to alwaysFail so every retry returns 429.
    mock.resetHits();
    mock.calls.length = 0;
    mock.configEndpoint(
      '/crm/v3/objects/contacts/search',
      'alwaysFail',
      null,
    );

    const cas = await httpGet(BASE2, '/api/contacts-all', cookie);

    const casSearchCalls = mock.calls.filter(c =>
      c.url.startsWith('/crm/v3/objects/contacts/search'),
    );

    record('CA-S.3 endpoint returns 200 (stale fallback)',
      cas.status === 200,
      `status=${cas.status}`);
    record('CA-S.4 results array present in stale response',
      cas.json && Array.isArray(cas.json.results),
      `body=${cas.body.slice(0, 160)}`);
    record('CA-S.5 at least one contact in stale response',
      cas.json && Array.isArray(cas.json.results) && cas.json.results.length >= 1,
      `count=${cas.json?.results?.length}`);
    record('CA-S.6 X-Cache-Status header is stale',
      cas.headers['x-cache-status'] === 'stale',
      `x-cache-status=${cas.headers['x-cache-status']}`);
    record('CA-S.7 all search attempts for stale request were 429s (4 attempts)',
      casSearchCalls.length === 4 && casSearchCalls.every(c => c.status === 429),
      `search calls=${casSearchCalls.length} statuses=${casSearchCalls.map(c => c.status).join(',')}`);

    // ── (CA-R) contacts-all: recovery after 429 storm ────────────────────────
    // Continues directly from CA-S state on Server 2:
    //   _allContactsCache  — null (bust + failed refresh left it empty)
    //   _allContactsLastGood — still holds the warm-up snapshot
    // Switching mock back to 'ok' means the next request must perform a fresh
    // HubSpot fetch.  The response must:
    //   • return 200
    //   • NOT have X-Cache-Status: stale (i.e. real fresh data)
    //   • show at least one successful HubSpot search call in mock.calls
    // A follow-up GET must be served from the newly populated in-memory cache
    // with no additional HubSpot call.
    console.log('\n  [CA-R] contacts-all: recovery after 429 storm → fresh data, then cached');
    mock.resetHits();
    mock.calls.length = 0;
    mock.configEndpoint(
      '/crm/v3/objects/contacts/search',
      'ok',
      CONTACTS_SEARCH_SUCCESS,
    );

    const carFresh = await httpGet(BASE2, '/api/contacts-all', cookie);

    const carFreshSearchCalls = mock.calls.filter(c =>
      c.url.startsWith('/crm/v3/objects/contacts/search'),
    );

    record('CA-R.1 endpoint returns 200 after storm clears',
      carFresh.status === 200,
      `status=${carFresh.status}`);
    record('CA-R.2 results array present in fresh response',
      carFresh.json && Array.isArray(carFresh.json.results),
      `body=${carFresh.body.slice(0, 160)}`);
    record('CA-R.3 X-Cache-Status is not stale (fresh data returned)',
      carFresh.headers['x-cache-status'] !== 'stale',
      `x-cache-status=${carFresh.headers['x-cache-status']}`);
    record('CA-R.4 HubSpot was actually called during recovery fetch',
      carFreshSearchCalls.length >= 1 && carFreshSearchCalls.every(c => c.status === 200),
      `search calls=${carFreshSearchCalls.length} statuses=${carFreshSearchCalls.map(c => c.status).join(',')}`);

    // Second GET — must be served from the newly populated in-memory cache
    // with no new outbound HubSpot call.
    mock.calls.length = 0;

    const carCached = await httpGet(BASE2, '/api/contacts-all', cookie);

    const carCachedSearchCalls = mock.calls.filter(c =>
      c.url.startsWith('/crm/v3/objects/contacts/search'),
    );

    record('CA-R.5 follow-up GET returns 200 (in-memory cache hit)',
      carCached.status === 200,
      `status=${carCached.status}`);
    record('CA-R.6 no new HubSpot call for follow-up GET (served from cache)',
      carCachedSearchCalls.length === 0,
      `search calls=${carCachedSearchCalls.length}`);

    // ── (LD) localdata/all: catch-block stale fallback ────────────────────────
    // Server 3 has ALL_CONTACTS_STALE_MAX_MS_OVERRIDE=1 so the stale cap
    // expires in 1 ms.  The sequence is:
    //   1. Warm _allContactsCache + _allContactsLastGood with rooms data.
    //   2. Bust the fresh cache so the next request triggers a re-fetch.
    //   3. Wait 2 ms so _allContactsLastGood is beyond the 1 ms cap.
    //   4. Set mock to alwaysFail → getSharedContactsCache() throws.
    //   5. The catch block in /api/localdata/all falls back to
    //      _allContactsLastGood and returns the room map instead of {}.
    console.log('\n  [LD] localdata/all: catch-block stale fallback → room map returned');
    mock.resetHits();
    mock.calls.length = 0;
    mock.configEndpoint(
      '/crm/v3/objects/contacts/search',
      'ok',
      CONTACTS_WITH_ROOMS_SUCCESS,
    );

    const ldWarm = await httpGet(BASE3, '/api/contacts-all', cookie);
    record('LD.1 warm-up request succeeds',
      ldWarm.status === 200,
      `status=${ldWarm.status}`);
    record('LD.2 warm-up returns the rooms contact',
      ldWarm.json && Array.isArray(ldWarm.json.results) && ldWarm.json.results.length >= 1,
      `count=${ldWarm.json?.results?.length}`);

    const ldBust = await httpPost(BASE3, '/api/admin/test/bust-contacts-cache', {}, adminCookie);
    record('LD.3 bust-contacts-cache succeeds',
      ldBust.status === 200 && ldBust.json?.ok === true,
      `status=${ldBust.status} body=${ldBust.body.slice(0, 120)}`);

    // Wait long enough for the 1 ms stale cap to expire so
    // getSharedContactsCache() throws rather than returning stale contacts.
    await new Promise(r => setTimeout(r, 10));

    mock.resetHits();
    mock.calls.length = 0;
    mock.configEndpoint(
      '/crm/v3/objects/contacts/search',
      'alwaysFail',
      null,
    );

    const ld = await httpGet(BASE3, '/api/localdata/all', cookie);

    record('LD.4 endpoint returns 200 (catch-block fallback)',
      ld.status === 200,
      `status=${ld.status}`);
    record('LD.5 response is a non-empty object (not {})',
      ld.json && typeof ld.json === 'object' && Object.keys(ld.json).length > 0,
      `keys=${JSON.stringify(Object.keys(ld.json || {}))}`);
    record('LD.6 rooms contact (id=77) appears in the map',
      ld.json && Array.isArray(ld.json['77']),
      `entry=${JSON.stringify(ld.json?.['77'])}`);
    record('LD.7 room name is Kitchen',
      ld.json?.['77']?.[0]?.room === 'Kitchen',
      `room=${ld.json?.['77']?.[0]?.room}`);

    const failed = findings.filter(f => !f.ok).length;
    exitCode = failed === 0 ? 0 : 1;
    console.log(`\n  Results: ${findings.length - failed} passed, ${failed} failed`);
  } catch (e) {
    console.error('Test crashed:', e);
    console.error(logBuf1.join('').slice(-2000));
    console.error(logBuf2.join('').slice(-2000));
    console.error(logBuf3.join('').slice(-2000));
  } finally {
    await writeReport(runId);
    await cleanup();
    process.exit(exitCode);
  }
}

async function writeReport(runId) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
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
    '- **(OL-R) open-leads recovery after 429 storm**: after `_openLeadsCache` is',
    '  warmed by OL, `bust-open-leads-cache` expires the TTL (sets `fetchedAt=0`).',
    '  A sustained HubSpot outage (all 4 retries returning 429) causes stale data',
    '  to be served (`X-Cache-Status: stale`). Once HubSpot stops rate-limiting',
    '  (mock switches from `alwaysFail` back to `ok`), the next request performs',
    '  a fresh fetch — `X-Cache-Status` is not `stale` and at least one successful',
    '  search call is recorded. A follow-up request is served from the newly',
    '  populated `_openLeadsCache` with no new HubSpot call (`search calls = 0`).',
    '- **(OL-F) open-leads exhausted, no cache**: `GET /api/open-leads` with',
    '  `/crm/v3/objects/contacts/search` returning 429 on every attempt',
    '  (all 4 retries exhausted) and no prior `_openLeadsCache` → returns 502 with',
    '  `code: HUBSPOT_RATE_LIMIT`. Tested on Server 2 which has a cold open-leads',
    '  cache throughout (none of the preceding tests call `/api/open-leads` on S2).',
    '- **(CA-F) contacts-all exhausted, no cache**: `GET /api/contacts-all` with',
    '  `/crm/v3/objects/contacts/search` returning 429 on every attempt',
    '  (all 4 retries exhausted) and no prior good cache → returns 502 with',
    '  `code: HUBSPOT_RATE_LIMIT`.',
    '- **(CA-S) contacts-all stale-cache fallback**: after a prior good response',
    '  populates `_allContactsLastGood`, a sustained HubSpot outage (all 4 retries',
    '  returning 429) causes the endpoint to serve the stale contacts list with',
    '  `X-Cache-Status: stale` instead of surfacing an error.',
    '- **(CA-R) contacts-all recovery after 429 storm**: once HubSpot stops',
    '  rate-limiting (mock switches from `alwaysFail` back to `ok`), the next',
    '  request performs a fresh HubSpot fetch — `X-Cache-Status` is not `stale`',
    '  and at least one successful search call is recorded. A follow-up request',
    '  is served from the newly populated in-memory cache with no new HubSpot',
    '  call (`search calls = 0`).',
    '- **(LD) localdata/all catch-block stale fallback**: with',
    '  `ALL_CONTACTS_STALE_MAX_MS_OVERRIDE=1` the stale cap expires immediately.',
    '  After warming `_allContactsLastGood` with rooms data, busting the fresh',
    '  cache, and switching HubSpot to always-429, `getSharedContactsCache()`',
    '  throws (cap exceeded). The catch block in `GET /api/localdata/all` falls',
    '  back to `_allContactsLastGood` and returns the room map instead of `{}`.',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
}

main();
