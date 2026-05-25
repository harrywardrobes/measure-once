'use strict';
// test/lead-status-counts-rate-limit/run.js
//
// Focused integration test for the rate-limit / coalescing behaviour of
// /api/contacts-lead-status-counts. Boots a disposable Express server pointed
// at a mock HubSpot HTTP server (via HUBSPOT_API_URL) so we can:
//
//   (A) Single-flight — two concurrent cold-cache requests must result in one
//       HubSpot fan-out, not two.
//   (B) Stale-on-error — after seeding a fresh successful cache, the mock
//       starts returning 429; the route must serve the previously-cached
//       counts with `X-Cache-Status: stale` instead of bubbling
//       HUBSPOT_RATE_LIMIT to the UI.
//   (C) 429 retry/backoff — a single request that sees a 429 + Retry-After
//       on the first attempt then a 200 on the retry must succeed.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:lead-status-counts-rate-limit
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:lead-status-counts-rate-limit

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

require('dotenv').config();

const REPORT_PATH = path.join(__dirname, '..', '..', 'test-results', 'lead-status-counts-rate-limit.md');
const LS_KEYS = ['PRIVTEST_LSC_A', 'PRIVTEST_LSC_B'];
const findings = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}

// ── Mock HubSpot server ──────────────────────────────────────────────────────
function startMockHubspot() {
  const state = {
    posts: [],              // every POST body received
    // mode controls how the next /search responses behave:
    //   'ok'                 — always 200 with total=1
    //   'always429'          — always 429
    //   'retryAfterOnce'     — first call 429 + Retry-After: 1, then 200
    mode: 'ok',
    retryAfterUsed: false,
    slowMs: 0,              // artificial delay before responding
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', async () => {
      if (!req.url.startsWith('/crm/v3/objects/contacts/search')) {
        res.writeHead(404); return res.end();
      }
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch {}
      state.posts.push({ body, at: Date.now() });

      const respond = () => {
        if (state.mode === 'always429') {
          res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
          return res.end(JSON.stringify({ status: 'error', message: 'rate limited' }));
        }
        if (state.mode === 'retryAfterOnce' && !state.retryAfterUsed) {
          state.retryAfterUsed = true;
          res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
          return res.end(JSON.stringify({ status: 'error', message: 'rate limited' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ total: 1, results: [] }));
      };

      if (state.slowMs > 0) {
        setTimeout(respond, state.slowMs);
      } else {
        respond();
      }
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state }));
  });
}

// ── Auth-cookie HTTP helper ───────────────────────────────────────────────────
function httpJson(base, method, urlPath, cookie) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, base);
    const req = http.request({
      method,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: cookie ? { Cookie: cookie } : {},
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
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

async function main() {
  const hasTestDb   = !!process.env.DATABASE_URL_TEST;
  const allowShared = process.env.PRIVTEST_ALLOW_SHARED_DB === '1';
  const connStr     = process.env.DATABASE_URL_TEST || process.env.DATABASE_URL;
  if (!connStr) {
    console.error('DATABASE_URL_TEST (preferred) or DATABASE_URL is required.');
    process.exit(2);
  }
  if (!hasTestDb && !allowShared) {
    console.error('\n  ✘ Refuses to run against the shared DATABASE_URL by default.\n'
      + '    Set DATABASE_URL_TEST=<disposable> or PRIVTEST_ALLOW_SHARED_DB=1.\n');
    process.exit(2);
  }

  const runId = Math.random().toString(36).slice(2, 8);
  console.log(`\n  lead-status-counts rate-limit  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL'}`);

  const pool = new Pool({ connectionString: connStr });

  const mock = await startMockHubspot();
  console.log(`  mock HubSpot listening on http://127.0.0.1:${mock.port}`);

  // Point the spawned server's HubSpot HTTP calls at the mock, with a dummy
  // token so requireHubspotToken passes.
  process.env.HUBSPOT_API_URL                   = `http://127.0.0.1:${mock.port}`;
  process.env.HUBSPOT_ACCESS_TOKEN              = 'privtest-dummy-token';
  process.env.PRIVTEST_USE_HUBSPOT_ACCESS_TOKEN = '1';

  const {
    spawnServer, waitForServer, seedUsers, cleanupTestData,
    resetRateLimitStore, login, setPool, BASE, PASSWORD,
  } = require('../privileges/harness');
  setPool(pool);

  // Pre-clean prior runs.
  await cleanupTestData(pool);
  await pool.query(`DELETE FROM lead_status_config WHERE key = ANY($1::text[])`, [LS_KEYS]);

  // Seed two lead-status rows so the fan-out is non-trivial.
  for (let i = 0; i < LS_KEYS.length; i++) {
    await pool.query(
      `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales)
         VALUES ($1, $2, $3, false)
         ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label`,
      [LS_KEYS[i], `PrivTest LSC ${i}`, 990 + i],
    );
  }

  const users = await seedUsers(pool, runId);

  const { child, logBuf } = spawnServer();
  let exitCode = 1;

  const cleanup = async () => {
    try { child.kill('SIGTERM'); } catch {}
    try {
      await pool.query(`DELETE FROM lead_status_config WHERE key = ANY($1::text[])`, [LS_KEYS]);
      await cleanupTestData(pool);
    } catch {}
    await pool.end().catch(() => {});
    try { mock.server.close(); } catch {}
  };
  process.on('SIGINT',  () => cleanup().then(() => process.exit(130)));
  process.on('SIGTERM', () => cleanup().then(() => process.exit(130)));

  try {
    await waitForServer();
    await resetRateLimitStore(pool);
    console.log(`  test server up at ${BASE}\n`);

    const adminClient = await login(users.admin.email, PASSWORD);
    const cookie = adminClient.cookie;

    // ── (A) Single-flight ────────────────────────────────────────────────────
    // Two concurrent requests on a cold cache must trigger only ONE fan-out
    // (which is `1 + LS_KEYS.length` POSTs — the null bucket + one per key).
    console.log('  [A] Single-flight on cold cache');
    mock.state.posts = [];
    mock.state.mode = 'ok';
    mock.state.slowMs = 300; // hold responses so requests overlap

    // Force-clear server cache via a PATCH that invalidates it.
    // (The simplest cold start is to wait for boot: cache is null until first hit.)

    const [r1, r2] = await Promise.all([
      httpJson(BASE, 'GET', '/api/contacts-lead-status-counts', cookie),
      httpJson(BASE, 'GET', '/api/contacts-lead-status-counts', cookie),
    ]);
    // The test DB may contain other production lead-status rows in addition
    // to our two seeded ones, so size the expected fan-out by the actual key
    // count. The key check is that the SECOND concurrent caller did NOT
    // double the fan-out — both callers share one in-flight fetch.
    const keysInDb = (await pool.query(
      'SELECT COUNT(*)::int AS c FROM lead_status_config WHERE is_null_row IS NOT TRUE'
    )).rows[0].c;
    const expectedFanout = 1 + keysInDb;
    record('A1 both requests return 200',
      r1.status === 200 && r2.status === 200,
      `r1=${r1.status} r2=${r2.status}`);
    record('A2 only one fan-out for two concurrent callers',
      mock.state.posts.length === expectedFanout,
      `posts=${mock.state.posts.length} expected=${expectedFanout} (1+${keysInDb})`);
    record('A3 fresh cache header set',
      r1.headers['x-cache-status'] === 'fresh' && r2.headers['x-cache-status'] === 'fresh',
      `r1=${r1.headers['x-cache-status']} r2=${r2.headers['x-cache-status']}`);

    mock.state.slowMs = 0;

    // ── (B) Stale-on-error ───────────────────────────────────────────────────
    // The cache from (A) is fresh; flip the mock to always-429, invalidate the
    // cache (so the route must call HubSpot), and verify the response still
    // serves the cached counts marked stale.
    console.log('\n  [B] Stale-on-error');
    mock.state.mode = 'always429';
    mock.state.posts = [];

    // Reach into the server: there is no public invalidation route, but a
    // contact PATCH would invalidate. Easier path — mock the TTL by deleting
    // and reinserting the lead-status row, which doesn't reset the cache.
    // Instead, use a request after the cache TTL would naturally still be
    // fresh — so we need to invalidate via the documented hook. We rely on
    // the fact that POST to /api/contacts/.../localdata invalidates; but the
    // simplest path is the admin lead-status PATCH which calls
    // _invalidateLeadStatusCountsCache.
    const patch = await adminClient.patch(
      `/api/admin/lead-statuses/${encodeURIComponent(LS_KEYS[0])}`,
      { label: `PrivTest LSC 0 renamed ${runId}` },
    );
    record('B0 admin PATCH invalidates cache (precondition)',
      patch.status === 200,
      `status=${patch.status}`);

    const r3 = await httpJson(BASE, 'GET', '/api/contacts-lead-status-counts', cookie);
    record('B1 returns 200 even though HubSpot is 429',
      r3.status === 200,
      `status=${r3.status} body=${r3.body.slice(0, 120)}`);
    record('B2 served from stale cache',
      r3.headers['x-cache-status'] === 'stale',
      `x-cache-status=${r3.headers['x-cache-status']}`);
    record('B3 stale body matches earlier fresh body',
      JSON.stringify(r3.json) === JSON.stringify(r1.json),
      `stale=${JSON.stringify(r3.json)} fresh=${JSON.stringify(r1.json)}`);
    // Retry budget: helper does up to 4 attempts per search × (1 + N) searches.
    // Just assert *some* retries happened (more than one POST per search).
    const minRetried = (1 + LS_KEYS.length) * 2; // at least 2 attempts per search
    record('B4 retried 429s before giving up',
      mock.state.posts.length >= minRetried,
      `posts=${mock.state.posts.length} >= ${minRetried}`);

    // ── (C) 429 + Retry-After then 200 ───────────────────────────────────────
    console.log('\n  [C] 429 + Retry-After → 200 on retry');
    mock.state.mode = 'retryAfterOnce';
    mock.state.retryAfterUsed = false;
    mock.state.posts = [];
    // Invalidate cache again.
    await adminClient.patch(
      `/api/admin/lead-statuses/${encodeURIComponent(LS_KEYS[0])}`,
      { label: `PrivTest LSC 0 again ${runId}` },
    );

    const r4 = await httpJson(BASE, 'GET', '/api/contacts-lead-status-counts', cookie);
    record('C1 returns 200 after Retry-After + retry',
      r4.status === 200,
      `status=${r4.status} body=${r4.body.slice(0, 120)}`);
    record('C2 marked fresh (came from successful retry, not stale)',
      r4.headers['x-cache-status'] === 'fresh',
      `x-cache-status=${r4.headers['x-cache-status']}`);
    record('C3 at least one 429 was retried',
      mock.state.retryAfterUsed === true,
      `retryAfterUsed=${mock.state.retryAfterUsed}`);

    const failed = findings.filter(f => !f.ok).length;
    exitCode = failed === 0 ? 0 : 1;
    console.log(`\n  Results: ${findings.length - failed} passed, ${failed} failed`);
  } catch (e) {
    console.error('Test crashed:', e);
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
    '# Lead-Status Counts Rate-Limit / Coalescing — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:lead-status-counts-rate-limit\``,
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
    '- **(A) Single-flight**: two concurrent cold-cache GETs against',
    '  `/api/contacts-lead-status-counts` must trigger only `1 + N` HubSpot',
    '  searches (the null bucket + one per configured status), not `2 * (1 + N)`.',
    '- **(B) Stale-on-error**: after the cache is invalidated and HubSpot returns',
    '  429 for every retry, the route must serve the previously-cached counts',
    '  with `X-Cache-Status: stale` instead of bubbling `HUBSPOT_RATE_LIMIT` to',
    '  the UI.',
    '- **(C) 429 + Retry-After**: a single 429 with `Retry-After: 1` followed by',
    '  a 200 must succeed via the retry helper and return `X-Cache-Status: fresh`.',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
}

main();
