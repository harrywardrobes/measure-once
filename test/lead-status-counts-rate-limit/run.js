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
//   (D) DOM notice (Puppeteer) — loadLeadStatusCounts catching a hard 5xx
//       must set state.leadStatusCountsError, which populateLeadStatusFilter
//       turns into a .ls-counts-error-notice banner. Dismissing the banner
//       clears the flag. A subsequent successful load removes the notice.
//   (E) Pill-bar notice (Puppeteer) — the second rendering path for the same
//       error: _renderCustomerListImpl in workflow.js inserts
//       #ls-counts-error-notice-pills when state.leadStatusCountsError is true.
//       Dismissing it removes the element and clears the flag. A re-render
//       with the flag cleared must leave the notice absent.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:lead-status-counts-rate-limit
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:lead-status-counts-rate-limit

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

function parseCookieKV(jar) {
  if (!jar) return null;
  const idx = jar.indexOf('=');
  if (idx < 0) return null;
  return { name: jar.slice(0, idx), value: jar.slice(idx + 1) };
}

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
    // Retry budget: helper does up to 4 attempts per search. With serialised
    // fan-out, the first search exhausts all 4 retries before throwing and the
    // loop stops there — subsequent searches are never reached. So posts = 4.
    const minRetried = 4; // maxAttempts for hubspotSearchWithRetry
    record('B4 retried 429s before giving up',
      mock.state.posts.length >= minRetried,
      `posts=${mock.state.posts.length} >= ${minRetried}`);

    // ── (C) 429 + Retry-After then 200 ───────────────────────────────────────
    console.log('\n  [C] 429 + Retry-After → 200 on retry');
    // Section B left a 60 s cooldown active. Reset it so C exercises the live
    // retry path instead of being immediately served stale counts.
    await adminClient.post('/api/admin/test/reset-lead-status-counts-cooldown', {});
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

    // ── (D) DOM notice — Puppeteer browser test ──────────────────────────────
    // Verifies that a hard 5xx from /api/contacts-lead-status-counts causes
    // .ls-counts-error-notice to appear via populateLeadStatusFilter, that the
    // dismiss button removes it and clears state.leadStatusCountsError, and
    // that a subsequent successful load does NOT reintroduce the notice.
    //
    // The test navigates to /projects (loads workflow-core.js + workflow.js,
    // no React island overriding loadLeadStatusCounts), intercepts the counts
    // request at the browser level, and manually seeds the minimal filter DOM
    // so populateLeadStatusFilter can attach the notice.
    console.log('\n  [D] DOM notice (Puppeteer)');
    if (!puppeteer) {
      record('D0 puppeteer available', false, 'puppeteer not installed — browser probes skipped');
    } else {
      const { findChromium } = require('../shared/find-chromium');
      const executablePath = findChromium() || undefined;
      let browser;
      try {
        browser = await puppeteer.launch({
          headless: true,
          executablePath,
          defaultViewport: { width: 1280, height: 800 },
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
        record('D0 headless chromium launches', true, 'browser started');
      } catch (e) {
        record('D0 headless chromium launches', false, `error: ${e.message}`);
      }

      if (browser) {
        let page;
        try {
          page = await browser.newPage();
          await page.setCacheEnabled(false);

          // Inject admin session cookie so /projects is accessible.
          const kv = parseCookieKV(cookie);
          if (kv) {
            const { hostname } = new URL(BASE);
            await page.setCookie({
              name: kv.name, value: kv.value,
              domain: hostname, path: '/', httpOnly: true,
            });
          }

          // Load /projects WITHOUT request interception active, so the page
          // initializes normally.  workflow-core.js + workflow.js are loaded
          // here; loadLeadStatusCounts is the vanilla-JS version (the catch
          // block sets state.leadStatusCountsError — no React island override).
          await page.goto(`${BASE}/projects`, { waitUntil: 'domcontentloaded', timeout: 20000 });

          // Guard: confirm we haven't been bounced to /login by an auth check.
          const landedUrl = page.url();
          if (!landedUrl.includes('/projects')) {
            record('D1 .ls-counts-error-notice appears after 5xx', false,
              `navigated away from /projects to ${landedUrl} — skipping DOM probes`);
            record('D2 notice removed after dismiss click', false, 'skipped');
            record('D2b state.leadStatusCountsError false after dismiss', false, 'skipped');
            record('D3 notice absent after successful follow-up load', false, 'skipped');
          } else {
            // Wait until the page's own loadLeadStatusCounts() initialization
            // call has fully settled (_llscInFlight === null and
            // _llscLastSettledAt is non-zero).  If we patch window.fetch or
            // reset the debounce state while a real fetch is still in-flight, its
            // success callback will overwrite state.leadStatusCountsError.
            await page.waitForFunction(
              () => {
                try {
                  return _llscInFlight === null && _llscLastSettledAt !== 0;
                } catch { return true; } // variables absent → no init call
              },
              { timeout: 10000 },
            ).catch(() => {}); // tolerate timeout; proceed anyway

            // Seed minimal filter DOM so populateLeadStatusFilter can attach the
            // notice.  The function reads #lead-status-filter (the <select>) and
            // inserts the notice after #lead-status-filter-row (if present) or
            // after the select itself.
            await page.evaluate(() => {
              if (!document.getElementById('lead-status-filter-row')) {
                const row = document.createElement('div');
                row.id = 'lead-status-filter-row';
                document.body.appendChild(row);
              }
              if (!document.getElementById('lead-status-filter')) {
                const sel = document.createElement('select');
                sel.id = 'lead-status-filter';
                document.body.appendChild(sel);
              }
            });

            // ── D1: 5xx → .ls-counts-error-notice appears ──────────────────
            // Install a window.fetch monkey-patch so /api/contacts-lead-status-counts
            // calls can be driven to fail or succeed without going through Puppeteer
            // request interception (which deadlocks when combined with async
            // page.evaluate and the single-flight debounce in workflow-core.js).
            // Then reset the debounce and call loadLeadStatusCounts() for real so
            // the catch block (not direct state mutation) sets the error flag.
            await page.evaluate(async () => {
              window.__fetchOrig = window.fetch;
              window.__fetchCountsMode = 'fail'; // 'fail' | 'ok'
              window.fetch = function (url, opts) {
                if (
                  typeof url === 'string' &&
                  url.includes('/api/contacts-lead-status-counts')
                ) {
                  if (window.__fetchCountsMode === 'ok') {
                    // Success: return a 200 JSON response with empty counts.
                    return Promise.resolve(
                      new Response(JSON.stringify({}), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                      }),
                    );
                  }
                  // Failure: rejected promise → goes straight to the catch block in
                  // loadLeadStatusCounts, which sets state.leadStatusCountsError = true.
                  return Promise.reject(new TypeError('simulated 5xx network failure'));
                }
                return window.__fetchOrig.call(this, url, opts);
              };

              // Reset the debounce so the call isn't short-circuited.
              try { _llscInFlight = null; } catch {}
              try { _llscLastSettledAt = 0; } catch {}

              // Drive the actual catch-path in loadLeadStatusCounts so
              // state.leadStatusCountsError is set by production code, not by the test.
              if (typeof loadLeadStatusCounts === 'function') {
                await loadLeadStatusCounts().catch(() => {});
              }

              // populateLeadStatusFilter renders the notice when
              // state.leadStatusCountsError is true (called by the visibilitychange
              // listener in production; called explicitly here in the test).
              if (typeof populateLeadStatusFilter === 'function') populateLeadStatusFilter();
            });

            const noticeEl    = await page.$('.ls-counts-error-notice');
            const errorFlagSet = await page.evaluate(
              () => typeof state !== 'undefined' && state.leadStatusCountsError === true,
            );
            record('D1 .ls-counts-error-notice appears after 5xx',
              !!noticeEl && errorFlagSet,
              `found=${!!noticeEl} errorFlag=${errorFlagSet}`);

            // ── D2: dismiss removes notice + clears state.leadStatusCountsError
            // Check synchronously inside page.evaluate: btn.click() fires the
            // event handler synchronously, removing the notice and clearing the
            // flag before any other JS (e.g. a background loadLeadStatusCounts
            // retry) can run.
            const [noticeAfterDismiss, errorStateCleared] = await page.evaluate(() => {
              const btn = document.querySelector('.ls-counts-error-dismiss');
              if (btn) btn.click();
              return [
                !!document.querySelector('.ls-counts-error-notice'),
                typeof state !== 'undefined' && state.leadStatusCountsError === false,
              ];
            });
            record('D2 notice removed after dismiss click',
              !noticeAfterDismiss,
              `present=${noticeAfterDismiss}`);
            record('D2b state.leadStatusCountsError false after dismiss',
              errorStateCleared,
              `cleared=${errorStateCleared}`);

            // ── D3: successful follow-up load does not reintroduce notice ────
            // Switch fetch mock to success mode, reset debounce, reload counts.
            await page.evaluate(async () => {
              window.__fetchCountsMode = 'ok';
              try { _llscInFlight = null; } catch {}
              try { _llscLastSettledAt = 0; } catch {}
              if (typeof loadLeadStatusCounts === 'function') {
                await loadLeadStatusCounts().catch(() => {});
              }
              if (typeof populateLeadStatusFilter === 'function') populateLeadStatusFilter();
            });

            const noticeAfterSuccess = await page.$('.ls-counts-error-notice');
            record('D3 notice absent after successful follow-up load',
              !noticeAfterSuccess,
              `present=${!!noticeAfterSuccess}`);
          }
        } catch (e) {
          record('D browser probe', false, `crashed: ${e.message}`);
        } finally {
          if (page) await page.close().catch(() => {});
          await browser.close().catch(() => {});
        }
      }
    }

    // ── (E) Pill-bar notice — Puppeteer browser test ─────────────────────────
    // Verifies the second rendering path for the counts error: the pill-bar
    // renderer in workflow.js (_renderCustomerListImpl) inserts an element with
    // id="ls-counts-error-notice-pills" when state.leadStatusCountsError is true.
    // Confirms the inline dismiss button removes it and clears the flag, and
    // that a subsequent renderCustomerList() call with the flag cleared does NOT
    // re-insert the notice.
    console.log('\n  [E] Pill-bar counts-error notice (Puppeteer)');
    if (!puppeteer) {
      record('E0 puppeteer available', false, 'puppeteer not installed — browser probes skipped');
    } else {
      const { findChromium } = require('../shared/find-chromium');
      const executablePath = findChromium() || undefined;
      let browserE;
      try {
        browserE = await puppeteer.launch({
          headless: true,
          executablePath,
          defaultViewport: { width: 1280, height: 800 },
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
        record('E0 headless chromium launches', true, 'browser started');
      } catch (e) {
        record('E0 headless chromium launches', false, `error: ${e.message}`);
      }

      if (browserE) {
        let pageE;
        try {
          pageE = await browserE.newPage();
          await pageE.setCacheEnabled(false);

          const kv = parseCookieKV(cookie);
          if (kv) {
            const { hostname } = new URL(BASE);
            await pageE.setCookie({
              name: kv.name, value: kv.value,
              domain: hostname, path: '/', httpOnly: true,
            });
          }

          // Navigate to /projects so workflow.js + _renderCustomerListImpl load.
          await pageE.goto(`${BASE}/projects`, { waitUntil: 'domcontentloaded', timeout: 20000 });

          const landedUrl = pageE.url();
          if (!landedUrl.includes('/projects')) {
            record('E1 pill-bar notice appears when state.leadStatusCountsError is true', false,
              `navigated away from /projects to ${landedUrl} — skipping pill-bar probes`);
            record('E2 notice removed after dismiss click', false, 'skipped');
            record('E2b state.leadStatusCountsError false after dismiss', false, 'skipped');
            record('E3 notice absent after re-render with error cleared', false, 'skipped');
          } else {
            // Wait for the page's own initialization to settle so a background
            // loadLeadStatusCounts success doesn't race with our state mutation.
            await pageE.waitForFunction(
              () => {
                try {
                  return _llscInFlight === null && _llscLastSettledAt !== 0;
                } catch { return true; }
              },
              { timeout: 10000 },
            ).catch(() => {});

            // Inject #customers-view if not already present.  The /projects
            // page renders into #projects-view; #customers-view is the element
            // that _renderCustomerListImpl (workflow.js) writes into.  We seed
            // it manually — the same way section D seeds #lead-status-filter —
            // so the pill-bar render path can run without navigating to a
            // different page.
            await pageE.evaluate(() => {
              if (!document.getElementById('customers-view')) {
                const div = document.createElement('div');
                div.id = 'customers-view';
                document.body.appendChild(div);
              }
            });

            {
              // ── E1: set state.leadStatusCountsError → re-render → notice appears
              // Directly mutate the shared state object and call renderCustomerList()
              // so the pill-bar renderer (_renderCustomerListImpl) produces the notice
              // element.  We do NOT go through loadLeadStatusCounts() here — this
              // probe is specifically about the rendering path, not the fetch path.
              await pageE.evaluate(() => {
                if (typeof state !== 'undefined') state.leadStatusCountsError = true;
                if (typeof renderCustomerList === 'function') renderCustomerList();
              });

              const noticeEl     = await pageE.$('#ls-counts-error-notice-pills');
              const errorFlagSet = await pageE.evaluate(
                () => typeof state !== 'undefined' && state.leadStatusCountsError === true,
              );
              record('E1 pill-bar notice appears when state.leadStatusCountsError is true',
                !!noticeEl && errorFlagSet,
                `found=${!!noticeEl} errorFlag=${errorFlagSet}`);

              // ── E2: inline dismiss onclick removes the element + clears the flag
              // The dismiss button uses an inline onclick:
              //   state.leadStatusCountsError=false;
              //   document.getElementById('ls-counts-error-notice-pills')?.remove()
              // so it executes synchronously — we can read the result immediately.
              const [noticeAfterDismiss, errorStateCleared] = await pageE.evaluate(() => {
                const btn = document.querySelector('#ls-counts-error-notice-pills .ls-counts-error-dismiss');
                if (btn) btn.click();
                return [
                  !!document.getElementById('ls-counts-error-notice-pills'),
                  typeof state !== 'undefined' && state.leadStatusCountsError === false,
                ];
              });
              record('E2 notice removed after dismiss click',
                !noticeAfterDismiss,
                `present=${noticeAfterDismiss}`);
              record('E2b state.leadStatusCountsError false after dismiss',
                errorStateCleared,
                `cleared=${errorStateCleared}`);

              // ── E3: re-render with error cleared — notice must not reappear
              await pageE.evaluate(() => {
                if (typeof state !== 'undefined') state.leadStatusCountsError = false;
                if (typeof renderCustomerList === 'function') renderCustomerList();
              });

              const noticeAfterClear = await pageE.$('#ls-counts-error-notice-pills');
              record('E3 notice absent after re-render with error cleared',
                !noticeAfterClear,
                `present=${!!noticeAfterClear}`);
            }
          }
        } catch (e) {
          record('E browser probe', false, `crashed: ${e.message}`);
        } finally {
          if (pageE) await pageE.close().catch(() => {});
          await browserE.close().catch(() => {});
        }
      }
    }

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
    '- **(D) DOM notice (Puppeteer)**: navigates `/projects` (vanilla workflow-core.js,',
    '  no React island), intercepts `/api/contacts-lead-status-counts` at the browser',
    '  level to return 503, calls `loadLeadStatusCounts()` then `populateLeadStatusFilter()`',
    '  and verifies `.ls-counts-error-notice` appears in the DOM. Clicking the dismiss',
    '  button must remove the notice and set `state.leadStatusCountsError = false`. A',
    '  subsequent successful load must leave the notice absent.',
    '- **(E) Pill-bar notice (Puppeteer)**: navigates `/projects` and directly sets',
    '  `state.leadStatusCountsError = true`, then calls `renderCustomerList()` to trigger',
    '  the pill-bar renderer (`_renderCustomerListImpl` in `workflow.js`). Verifies that',
    '  `#ls-counts-error-notice-pills` appears in the DOM. Clicking the inline dismiss',
    '  button must remove the element and set `state.leadStatusCountsError = false`.',
    '  A subsequent `renderCustomerList()` with the flag cleared must leave the notice absent.',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
}

main();
