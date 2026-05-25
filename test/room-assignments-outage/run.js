'use strict';
// test/room-assignments-outage/run.js
//
// Integration test verifying that GET /api/localdata/all continues to serve
// room-assignment data during a prolonged HubSpot outage — even after the
// 1-hour stale cap that governs GET /api/contacts-all has been exceeded.
//
//   (E) Room assignments survive a prolonged outage:
//       1. Seed _allContactsLastGood by warming up the shared cache.
//       2. Bust the fresh cache so the next request must re-fetch.
//       3. Wait until the snapshot has aged past ALL_CONTACTS_STALE_MAX_MS_OVERRIDE.
//       4. Make HubSpot permanently unreachable.
//       5. GET /api/localdata/all must still return room data (200, non-empty
//          map) — the no-cap fallback for the room-assignments view.
//
//   (F) Contrast: GET /api/contacts-all returns 502 under the same conditions,
//       because the stale cap IS enforced for the main customer list.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:room-assignments-outage
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:room-assignments-outage

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

require('dotenv').config();

const REPORT_PATH = path.join(__dirname, '..', '..', 'test-results', 'room-assignments-outage.md');
const findings = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}

// ── Shared fixture ─────────────────────────────────────────────────────────────
// The contact includes a measure_once_rooms JSON array so buildRoomMap() in
// /api/localdata/all produces a non-empty room map.

const ROOMS_FIXTURE = JSON.stringify([
  { room: 'Living Room', stageKey: 'sales', assignedFitterId: null, installStart: null },
  { room: 'Bedroom',     stageKey: 'measure', assignedFitterId: null, installStart: null },
]);

const CONTACTS_SEARCH_SUCCESS = {
  results: [
    {
      id: '99',
      properties: {
        firstname: 'Room',
        lastname: 'Tester',
        email: 'room-tester@example.com',
        phone: '555-0199',
        hs_lead_status: 'OPEN_DEAL',
        createdate: '2024-06-01T00:00:00.000Z',
        hw_test_user: 'true',
        measure_once_rooms: ROOMS_FIXTURE,
      },
    },
  ],
  paging: null,
};

// ── Mock HubSpot server ────────────────────────────────────────────────────────
// Modes:
//   'ok'         — 200 with fixture contacts
//   'always503'  — 503 on every hit (HubSpot outage simulation)
//   'dropSocket' — closes socket immediately (network failure)

function startMockHubspot() {
  const state = { mode: 'ok', calls: [] };

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

function waitForServer(base, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise(async (resolve, reject) => {
    while (Date.now() - start < timeoutMs) {
      try {
        const r = await httpGet(base, '/api/turnstile-config', null);
        if (r.status === 200) return resolve(true);
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    reject(new Error(`Test server did not start on ${base} within ${timeoutMs}ms`));
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

  const runId = Math.random().toString(36).slice(2, 8);
  console.log(`\n  room-assignments-outage  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL'}`);

  const pool = new Pool({ connectionString: connStr });
  const mock = await startMockHubspot();
  console.log(`  mock HubSpot listening on http://127.0.0.1:${mock.port}`);

  // Point the test server at the mock HubSpot and provide a dummy token so
  // requireHubspotToken passes.
  process.env.HUBSPOT_API_URL                   = `http://127.0.0.1:${mock.port}`;
  process.env.HUBSPOT_ACCESS_TOKEN              = 'privtest-dummy-token';
  process.env.PRIVTEST_USE_HUBSPOT_ACCESS_TOKEN = '1';

  const {
    spawnServer, seedUsers, cleanupTestData,
    resetRateLimitStore, login, BASE, PASSWORD,
    setPool,
  } = require('../privileges/harness');
  setPool(pool);

  await cleanupTestData(pool);
  const users = await seedUsers(pool, runId);

  // Use a 200 ms stale cap so the test can quickly exceed it without waiting
  // a real hour.  ALL_CONTACTS_STALE_MAX_MS_OVERRIDE is read at server startup.
  const { child, logBuf } = spawnServer({
    extraEnv: {
      ALL_CONTACTS_STALE_MAX_MS_OVERRIDE: '200',
    },
  });

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

    const memberClient = await login(users.member.email, PASSWORD);
    const memberCookie = memberClient.cookie;
    const adminClient  = await login(users.admin.email, PASSWORD);
    const adminCookie  = adminClient.cookie;

    // ── (E) Room assignments survive a prolonged HubSpot outage ───────────────
    // Strategy:
    //   1. Warm the cache so _allContactsLastGood is populated with contacts
    //      that include measure_once_rooms data.
    //   2. Bust the fresh cache (_allContactsCache = null).
    //   3. Wait > 200 ms so _allContactsLastGood is now older than
    //      ALL_CONTACTS_STALE_MAX_MS_OVERRIDE (the stale cap).
    //   4. Make HubSpot unreachable.
    //   5. /api/localdata/all must still return 200 with a non-empty room map —
    //      the no-cap fallback documented in the catch block of that route.
    //   6. /api/contacts-all must return 502 under the same conditions,
    //      confirming that the cap applies there (contrast case).

    console.log('  [E] Room assignments survive prolonged HubSpot outage');
    mock.state.mode = 'ok';
    mock.state.calls = [];

    // Step 1 — warm up: populate _allContactsLastGood.
    const eWarm = await httpGet(BASE, '/api/contacts-all', memberCookie);
    record('E.1 warm-up /api/contacts-all returns 200',
      eWarm.status === 200,
      `status=${eWarm.status}`);
    record('E.2 warm-up response contains the seeded contact',
      eWarm.json && Array.isArray(eWarm.json.results) && eWarm.json.results.length >= 1,
      `count=${eWarm.json?.results?.length}`);

    // Sanity-check that the seeded contact carries room data (prerequisite for
    // the localdata/all assertions below).
    const seededRooms = eWarm.json?.results?.find(c => c.id === '99')?.properties?.measure_once_rooms;
    record('E.3 seeded contact has measure_once_rooms',
      typeof seededRooms === 'string' && seededRooms.length > 0,
      `measure_once_rooms=${seededRooms?.slice(0, 60) ?? '(missing)'}`);

    // Step 2 — bust the fresh cache so the next request must re-fetch.
    const eBust = await httpPost(BASE, '/api/admin/test/bust-contacts-cache', {}, adminCookie);
    record('E.4 bust-contacts-cache returns 200',
      eBust.status === 200 && eBust.json?.ok === true,
      `status=${eBust.status} body=${eBust.body.slice(0, 80)}`);

    // Step 3 — wait for the snapshot to age past the 200 ms stale cap.
    await new Promise(r => setTimeout(r, 350));

    // Step 4 — make HubSpot permanently unreachable.
    mock.state.mode = 'always503';
    mock.state.calls = [];

    // Step 5 — /api/localdata/all must still return room data.
    const eRooms = await httpGet(BASE, '/api/localdata/all', memberCookie);
    record('E.5 /api/localdata/all returns 200 during prolonged outage',
      eRooms.status === 200,
      `status=${eRooms.status} body=${eRooms.body.slice(0, 160)}`);
    record('E.6 /api/localdata/all room map is non-empty (not {})',
      eRooms.json && typeof eRooms.json === 'object' && Object.keys(eRooms.json).length > 0,
      `keys=${Object.keys(eRooms.json ?? {}).join(',') || '(none)'}`);
    record('E.7 /api/localdata/all X-Cache-Status is stale',
      eRooms.headers['x-cache-status'] === 'stale',
      `x-cache-status=${eRooms.headers['x-cache-status']}`);
    record('E.8 room map entry for seeded contact id=99 has expected rooms',
      Array.isArray(eRooms.json?.['99']) && eRooms.json['99'].length === 2,
      `rooms=${JSON.stringify(eRooms.json?.['99'])?.slice(0, 120)}`);

    // Step 6 — contrast: /api/contacts-all must return 502 (stale cap enforced).
    console.log('\n  [F] Contrast: /api/contacts-all returns 502 under same conditions');
    mock.state.calls = [];
    const eContacts = await httpGet(BASE, '/api/contacts-all', memberCookie);
    record('F.1 /api/contacts-all returns 502 when stale cap exceeded',
      eContacts.status === 502,
      `status=${eContacts.status} body=${eContacts.body.slice(0, 160)}`);
    record('F.2 /api/contacts-all error body has HUBSPOT_ERROR code',
      eContacts.json?.code === 'HUBSPOT_ERROR' || eContacts.json?.code === 'HUBSPOT_RATE_LIMIT',
      `code=${eContacts.json?.code}`);

    // ── (G) Recovery: HubSpot comes back online ───────────────────────────────
    // After the prolonged-outage scenario, switch the mock back to 'ok'.
    // The next GET /api/localdata/all must:
    //   (G.1) return 200
    //   (G.2) carry X-Cache-Status: fresh (not stale — data came from HubSpot)
    //   (G.3) hit the mock HubSpot at least once (cache was not short-circuited
    //         to the old snapshot)

    console.log('\n  [G] Recovery: /api/localdata/all refreshes once HubSpot is back online');
    mock.state.mode  = 'ok';
    mock.state.calls = [];

    const gRecover = await httpGet(BASE, '/api/localdata/all', memberCookie);
    record('G.1 /api/localdata/all returns 200 after HubSpot recovery',
      gRecover.status === 200,
      `status=${gRecover.status} body=${gRecover.body.slice(0, 160)}`);
    record('G.2 /api/localdata/all X-Cache-Status is fresh (not stale) after recovery',
      gRecover.headers['x-cache-status'] === 'fresh',
      `x-cache-status=${gRecover.headers['x-cache-status']}`);
    const gMockCalls = mock.state.calls.filter(c => c.status === 200);
    record('G.3 mock HubSpot was called during recovery (cache actually refreshed)',
      gMockCalls.length >= 1,
      `mock 200 calls=${gMockCalls.length}`);

    // ── (H) Empty snapshot: first server start with HubSpot already down ────────
    // Strategy:
    //   1. HubSpot mock is already in 'always503' mode (from step 4 above).
    //   2. Spawn a second server on port 5051 — _allContactsLastGood starts null.
    //   3. GET /api/localdata/all must return 200 with {} (not 502).
    //   4. X-Cache-Status must NOT be 'stale' (no snapshot was served).

    console.log('\n  [H] Empty snapshot: first server start with HubSpot already down');
    mock.state.mode = 'always503';
    mock.state.calls = [];

    const H_PORT = '5051';
    const H_BASE = `http://127.0.0.1:${H_PORT}`;

    const { child: hChild, logBuf: hLogBuf } = spawnServer({
      extraEnv: {
        PORT: H_PORT,
        ALL_CONTACTS_STALE_MAX_MS_OVERRIDE: '200',
      },
    });

    try {
      await waitForServer(H_BASE);
      console.log(`  second server up at ${H_BASE}`);

      // Both servers share the same PostgreSQL session store and SESSION_SECRET,
      // so the session cookie obtained from the first server is valid here too.
      // Verify that the second server accepts it before proceeding.
      const hAuthCheck = await httpGet(H_BASE, '/api/auth/user', memberCookie);
      record('H.1 second server accepts shared session cookie',
        hAuthCheck.status === 200 && !!hAuthCheck.json?.email,
        `status=${hAuthCheck.status} email=${hAuthCheck.json?.email ?? '(none)'}`);

      // _allContactsLastGood is null — HubSpot was never reachable.
      const hRooms = await httpGet(H_BASE, '/api/localdata/all', memberCookie);
      record('H.2 /api/localdata/all returns 200 (not 502) when no snapshot exists',
        hRooms.status === 200,
        `status=${hRooms.status} body=${hRooms.body.slice(0, 160)}`);
      record('H.3 /api/localdata/all body is empty object {}',
        hRooms.json !== null
          && typeof hRooms.json === 'object'
          && Object.keys(hRooms.json).length === 0,
        `body=${hRooms.body.slice(0, 80)}`);
      record('H.4 /api/localdata/all X-Cache-Status is not stale (no snapshot)',
        hRooms.headers['x-cache-status'] !== 'stale',
        `x-cache-status=${hRooms.headers['x-cache-status'] ?? '(absent)'}`);
    } catch (hErr) {
      console.error('  [H] scenario crashed:', hErr.message);
      console.error('  --- second server log (last 1000 chars) ---');
      console.error(hLogBuf.join('').slice(-1000));
      record('H.0 scenario H did not crash', false, String(hErr.message));
    } finally {
      try { hChild.kill('SIGTERM'); } catch {}
    }

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
    '# Room Assignments Outage — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:room-assignments-outage\``,
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
    '- **(E) Room assignments survive prolonged outage**: the shared contacts',
    '  cache is warmed with fixture contacts that include `measure_once_rooms`.',
    '  The fresh cache is then busted and the snapshot is aged beyond the',
    '  `ALL_CONTACTS_STALE_MAX_MS_OVERRIDE` cap (200 ms). With HubSpot returning',
    '  503 on every attempt, `GET /api/localdata/all` must still return a',
    '  non-empty room map (`X-Cache-Status: stale`) — the no-cap fallback',
    '  documented in `server.js` lines 647–674.',
    '- **(F) Contrast — /api/contacts-all returns 502**: under the same',
    '  conditions (stale cap exceeded + HubSpot unreachable), the main customer-',
    '  list endpoint must return 502. This confirms the divergence is intentional',
    '  and that the no-cap exception is scoped only to the room-assignments view.',
    '- **(G) Recovery after prolonged outage**: after the outage, the mock is',
    '  switched back to `ok`. `GET /api/localdata/all` must return 200 with',
    '  `X-Cache-Status: fresh` (not `stale`) and the mock must record at least',
    '  one successful HubSpot call, proving the view recovers rather than staying',
    '  stuck on the old stale snapshot.',
    '- **(H) Empty snapshot — first server start with HubSpot already down**: a',
    '  fresh server is spawned on a second port with HubSpot already returning',
    '  503 on every request, so `_allContactsLastGood` is never populated.',
    '  `GET /api/localdata/all` must return 200 with an empty object `{}`',
    '  (not 502), and `X-Cache-Status` must not be `stale` (no snapshot was',
    '  served). Covers the `if (_allContactsLastGood)` false-branch in `server.js`.',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
}

main();
