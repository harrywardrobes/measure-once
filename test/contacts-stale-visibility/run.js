'use strict';
// test/contacts-stale-visibility/run.js
//
// Puppeteer integration test confirming that the stale-data banner in
// CustomersPage respects tab visibility:
//
//   (F1) Hidden → stale response deferred:
//        Set document.hidden=true, intercept /api/contacts-all at the network
//        level to return X-Cache-Status: stale, then trigger a re-fetch via the
//        search input.  The banner must NOT appear while the tab is hidden.
//        After a synthetic visibilitychange (→ visible) the banner MUST appear.
//
//   (F2) Hidden → fresh response, banner persists:
//        With the banner showing from (F1), set document.hidden=true, switch
//        the interceptor to return no stale header (fresh), trigger a re-fetch.
//        The banner must STILL show while hidden (the pending clear is deferred).
//        After a synthetic visibilitychange (→ visible) the banner MUST disappear.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:contacts-stale-visibility
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:contacts-stale-visibility

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

require('dotenv').config();

const REPORT_PATH = path.join(__dirname, '..', '..', 'test-results', 'contacts-stale-visibility.md');
const findings = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}

// ── Mock HubSpot server ───────────────────────────────────────────────────────
// Only needed so the Express server can bootstrap and serve /customers.
// The browser-level request interception handles /api/contacts-all responses
// directly, so the mock only sees the initial page-load requests.
function startMockHubspot() {
  const CONTACTS_RESPONSE = JSON.stringify({
    results: [
      {
        id: '42',
        properties: {
          firstname:      'Stale',
          lastname:       'Tester',
          email:          'stale-vis@example.com',
          phone:          '555-0142',
          hs_lead_status: 'OPEN_DEAL',
          createdate:     '2024-01-01T00:00:00.000Z',
          hw_test_user:   'true',
        },
      },
    ],
    paging: null,
  });

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      if (!req.url.startsWith('/crm/v3/objects/contacts/search')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'error', message: `no mock for ${req.url}` }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(CONTACTS_RESPONSE);
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function httpPost(base, urlPath, body, cookie) {
  return new Promise((resolve, reject) => {
    const u       = new URL(urlPath, base);
    const bodyStr = JSON.stringify(body);
    const req     = http.request({
      method:   'POST',
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

// ── Puppeteer helpers ─────────────────────────────────────────────────────────
function parseCookieKV(jar) {
  if (!jar) return null;
  const idx = jar.indexOf('=');
  if (idx < 0) return null;
  return { name: jar.slice(0, idx), value: jar.slice(idx + 1) };
}

async function injectSession(page, jar, base) {
  const kv = parseCookieKV(jar);
  if (!kv) return;
  const { hostname } = new URL(base);
  await page.setCookie({ name: kv.name, value: kv.value, domain: hostname, path: '/', httpOnly: true });
}

// Override document.hidden and visibilityState in the page via defineProperty.
async function setDocumentHidden(page, hidden) {
  await page.evaluate((isHidden) => {
    Object.defineProperty(document, 'hidden', {
      get: () => isHidden,
      configurable: true,
    });
    Object.defineProperty(document, 'visibilityState', {
      get: () => (isHidden ? 'hidden' : 'visible'),
      configurable: true,
    });
  }, hidden);
}

// Trigger a re-fetch of /api/contacts-all by typing a unique search string
// into the search input.  Uses Puppeteer's keyboard API (real browser events
// that React's synthetic event system reliably picks up).
let _searchSeq = 0;
async function triggerReFetch(page, waitMs = 800) {
  _searchSeq++;
  const val = `vis${_searchSeq}`;
  const sel = 'input[aria-label="Search customers"]';
  // Triple-click to select any existing text, then type the new value.
  await page.click(sel, { clickCount: 3 });
  await page.keyboard.type(val, { delay: 30 });
  // Wait for the 250 ms debounce + the intercepted (near-instant) fetch.
  await new Promise(r => setTimeout(r, waitMs));
}

// Returns true when #contacts-stale-banner is present in the DOM.
async function isBannerVisible(page) {
  return page.evaluate(() => !!document.getElementById('contacts-stale-banner'));
}

// Restore document.hidden to false, dispatch visibilitychange, and wait for
// React to apply any pending state update and re-render.
async function makeTabVisible(page, waitMs = 600) {
  await setDocumentHidden(page, false);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await new Promise(r => setTimeout(r, waitMs));
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
  console.log(`\n  contacts-stale-visibility  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL'}`);

  if (!puppeteer) {
    record('puppeteer available', false, 'puppeteer not installed — all probes skipped');
    await writeReport(runId);
    process.exit(findings.every(f => f.ok) ? 0 : 1);
    return;
  }

  const pool = new Pool({ connectionString: connStr });
  const mock = await startMockHubspot();
  console.log(`  mock HubSpot on http://127.0.0.1:${mock.port}`);

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

  const { findChromium } = require('../shared/find-chromium');
  const executablePath = findChromium() || undefined;

  // ── Per-request interception mode controlled from Node.js ─────────────────
  // 'passthrough' — forward as-is (initial page load)
  // 'stale'       — respond 200 with X-Cache-Status: stale
  // 'fresh'       — respond 200 without X-Cache-Status header
  let interceptMode = 'passthrough';
  let interceptHits = 0;

  const STUB_CONTACTS_BODY = JSON.stringify({
    results: [{
      id: '42',
      properties: {
        firstname: 'Stale', lastname: 'Tester',
        email: 'stale-vis@example.com',
        phone: '555-0142', hs_lead_status: 'OPEN_DEAL',
        createdate: '2024-01-01T00:00:00.000Z',
      },
    }],
    total: 1, totalPages: 1,
  });

  let browser;
  try {
    await waitForServer();
    await resetRateLimitStore(pool);
    console.log(`  test server up at ${BASE}\n`);

    const adminClient = await login(users.admin.email, PASSWORD);

    browser = await puppeteer.launch({
      headless:        true,
      executablePath,
      defaultViewport: { width: 1280, height: 800 },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    record('headless chromium launches', true, 'browser started');

    const page = await browser.newPage();
    await page.setCacheEnabled(false);
    await injectSession(page, adminClient.cookie, BASE);

    // Capture ALL browser console messages for diagnostics.
    page.on('console', msg => {
      const t = msg.text();
      if (t.startsWith('[diag') || t.startsWith('[test')) {
        console.log(`    [browser] ${t}`);
      }
    });

    // Wrap window.fetch in the browser with a logger so we can confirm exactly
    // what headers the React component sees when /api/contacts-all responds.
    // This runs once on page load, before any request interception.
    page.once('domcontentloaded', async () => {
      await page.evaluate(() => {
        const realFetch = window.fetch;
        window.fetch = async function(url, opts) {
          const r = await realFetch.call(this, url, opts);
          if (typeof url === 'string' && url.includes('/api/contacts-all')) {
            console.log(
              '[diag-fetch] contacts-all status=' + r.status
              + ' x-cache-status=' + r.headers.get('X-Cache-Status')
              + ' document.hidden=' + document.hidden,
            );
          }
          return r;
        };
      }).catch(() => {});
    });

    // Enable request interception so we can drive /api/contacts-all responses.
    await page.setRequestInterception(true);
    page.on('request', req => {
      const url = req.url();
      if (url.includes('/api/contacts-all')) {
        const mode = interceptMode;
        interceptHits++;
        console.log(`    [intercept] /api/contacts-all mode=${mode} hit=${interceptHits}`);
        if (mode === 'stale') {
          return req.respond({
            status:      200,
            contentType: 'application/json',
            headers:     { 'X-Cache-Status': 'stale' },
            body:        STUB_CONTACTS_BODY,
          });
        }
        if (mode === 'fresh') {
          return req.respond({
            status:      200,
            contentType: 'application/json',
            body:        STUB_CONTACTS_BODY,
          });
        }
        // passthrough
        return req.continue();
      }
      req.continue();
    });

    // ── Initial page load (interceptMode = 'passthrough') ─────────────────────
    // Let the real server handle the first /api/contacts-all request so the
    // page renders normally.
    interceptMode = 'passthrough';
    interceptHits = 0;

    await page.goto(`${BASE}/customers`, { waitUntil: 'domcontentloaded', timeout: 20000 });

    await page.waitForFunction(() => (
      !!document.querySelector('input[aria-label="Search customers"]')
    ), { timeout: 15000 }).catch(() => {});

    // Wait for the initial fetch to complete.
    await new Promise(r => setTimeout(r, 1500));

    const initialBanner = await isBannerVisible(page);
    record('initial load: no stale banner (fresh contacts)', !initialBanner,
      `bannerPresent=${initialBanner}`);

    // ── (F1) Stale response while hidden → banner deferred ────────────────────
    console.log('\n  [F1] Stale response while tab hidden → banner deferred');

    // Simulate the tab being hidden.
    await setDocumentHidden(page, true);

    const hiddenConfirm = await page.evaluate(() => document.hidden);
    record('F1 document.hidden override active', hiddenConfirm === true,
      `document.hidden=${hiddenConfirm}`);

    // Switch interceptor to stale mode.
    interceptMode = 'stale';
    interceptHits = 0;

    // Trigger a re-fetch via the search input.
    await triggerReFetch(page, 900);

    record('F1 /api/contacts-all request intercepted', interceptHits >= 1,
      `interceptHits=${interceptHits}`);

    // Banner must NOT be visible while the tab is hidden.
    const f1BannerHidden = await isBannerVisible(page);
    record('F1 stale banner absent while tab is hidden', !f1BannerHidden,
      `bannerPresent=${f1BannerHidden}`);

    // Confirm document.hidden is still true.
    const f1StillHidden = await page.evaluate(() => document.hidden);
    record('F1 document.hidden still true before visibilitychange', f1StillHidden,
      `document.hidden=${f1StillHidden}`);

    // Simulate the tab becoming visible.
    await makeTabVisible(page, 600);

    const f1BannerVisible = await isBannerVisible(page);
    record('F1 stale banner appears after visibilitychange → visible', f1BannerVisible,
      `bannerPresent=${f1BannerVisible}`);

    // ── (F2) Fresh response while hidden → pending clear deferred ────────────
    // With the banner showing from F1, hide the tab, switch the interceptor to
    // 'fresh' (no X-Cache-Status header), and trigger a real re-fetch.
    // Both the pre-fetch setContactsStale(false) and the response callback
    // are now deferred when document.hidden === true, so the banner must
    // remain visible until the user sees the tab again.
    console.log('\n  [F2] Fresh response while tab hidden → pending clear deferred');

    const f2Pre = await isBannerVisible(page);
    record('F2 precondition: stale banner is showing (from F1)', f2Pre,
      `bannerPresent=${f2Pre}`);

    // Simulate the tab being hidden while the banner is visible.
    await setDocumentHidden(page, true);

    const f2HiddenConfirm = await page.evaluate(() => document.hidden);
    record('F2 document.hidden override active', f2HiddenConfirm === true,
      `document.hidden=${f2HiddenConfirm}`);

    // Switch interceptor to fresh mode — next /api/contacts-all will respond
    // without X-Cache-Status, simulating a live HubSpot response.
    interceptMode = 'fresh';
    interceptHits = 0;

    // Trigger a real re-fetch via the search input.
    await triggerReFetch(page, 900);

    record('F2 /api/contacts-all request intercepted (fresh)', interceptHits >= 1,
      `interceptHits=${interceptHits}`);

    // Banner must STILL be visible — both the pre-fetch clear and the
    // response-callback clear were deferred because document.hidden === true.
    const f2BannerStillShowing = await isBannerVisible(page);
    record('F2 stale banner persists while tab is hidden (pending clear deferred)',
      f2BannerStillShowing, `bannerPresent=${f2BannerStillShowing}`);

    // Simulate the tab becoming visible — the pending false is applied.
    await makeTabVisible(page, 600);

    const f2BannerGone = await isBannerVisible(page);
    record('F2 stale banner disappears after visibilitychange → visible',
      !f2BannerGone, `bannerPresent=${f2BannerGone}`);

    await page.close();

    const failed = findings.filter(f => !f.ok).length;
    exitCode = failed === 0 ? 0 : 1;
    console.log(`\n  Results: ${findings.length - failed} passed, ${failed} failed`);
  } catch (e) {
    console.error('Test crashed:', e);
    console.error('--- server log (last 3000 chars) ---');
    console.error(logBuf.join('').slice(-3000));
  } finally {
    if (browser) await browser.close().catch(() => {});
    await writeReport(runId);
    await cleanup();
    process.exit(exitCode);
  }
}

async function writeReport(runId) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc   = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok).length;
  const lines = [
    '# Contacts Stale Banner Visibility — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:contacts-stale-visibility\``,
    '',
    '## Summary',
    '',
    `- Passed: ${passed} / ${findings.length}`,
    `- Failed: ${failed} / ${findings.length}`,
    '',
    '## Results',
    '',
    '| Result | Probe | Detail |',
    '|---|---|---|',
    ...findings.map(f => `| ${f.ok ? 'PASS' : 'FAIL'} | ${esc(f.id)} | ${esc(f.detail)} |`),
    '',
    '## Coverage',
    '',
    '- **(F1) Stale response while hidden**: overrides `document.hidden` to',
    '  `true`, uses Puppeteer request interception to return',
    '  `X-Cache-Status: stale` for `/api/contacts-all`, triggers a re-fetch',
    '  via the search input.  Confirms `#contacts-stale-banner` is absent while',
    '  hidden, then synthesises a `visibilitychange` event (→ visible) and',
    '  confirms the banner appears.',
    '- **(F2) Fresh response while hidden — pending clear deferred**: with the',
    '  banner showing from (F1), overrides `document.hidden` to `true` and',
    '  switches the interceptor to `fresh` mode (no `X-Cache-Status` header).',
    '  Triggers a real re-fetch via the search input.  Both the pre-fetch',
    '  `setContactsStale(false)` and the response-callback clear are deferred',
    '  because `document.hidden === true`.  Confirms the banner still shows,',
    '  then synthesises a `visibilitychange` event (→ visible) and confirms',
    '  the banner disappears.',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
}

main();
