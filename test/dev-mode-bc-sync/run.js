'use strict';
// test/dev-mode-bc-sync/run.js
//
// Regression guard for the `dev_mode_changed` BroadcastChannel wiring added
// in task #1837.  The full production code path is exercised:
//
//   Admin tab  →  DevEnvironmentPage toggle Switch
//            →  POST /api/admin/hubspot/dev-mode
//            →  BroadcastChannel('dev_mode_changed').postMessage({ devMode })
//            →  CustomersPage listener updates state
//            →  #dev-mode-banner appears / disappears (no full reload)
//
// Two pages share a single browser instance (same origin) so BroadcastChannel
// messages route across them exactly as they would in real browser tabs.
//
// Probes
// ──────
//   [BC-A] Enable: admin clicks the Switch on the Dev Environment tab.
//          CustomersPage shows #dev-mode-banner without a page reload.
//
//   [BC-B] Disable: admin clicks the Switch a second time.
//          Banner disappears — again without a reload.
//
// API calls made by CustomersPage on load are request-intercepted so the test
// does not require a live HubSpot token.  The DevEnvironmentPage in the sender
// tab hits the real Express server (real admin session cookie).
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:dev-mode-bc-sync
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:dev-mode-bc-sync

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

const {
  spawnServer,
  waitForServer,
  seedUsers,
  cleanupTestData,
  resetRateLimitStore,
  login,
  setPool,
  BASE,
  PASSWORD,
} = require('../privileges/harness');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

require('dotenv').config();

const { pollUntil } = require('../helpers/poll');

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'dev-mode-bc-sync.md',
);

const findings = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseCookieKV(jar) {
  if (!jar) return null;
  const idx = jar.indexOf('=');
  if (idx < 0) return null;
  return { name: jar.slice(0, idx), value: jar.slice(idx + 1) };
}

async function injectSession(page, jar) {
  const kv = parseCookieKV(jar);
  if (!kv) return;
  const { hostname } = new URL(BASE);
  await page.setCookie({
    name: kv.name, value: kv.value,
    domain: hostname, path: '/', httpOnly: true,
  });
}

function findChromium() {
  const { findChromium: shared } = require('../shared/find-chromium');
  return shared() || undefined;
}

// ── Mock HubSpot server ───────────────────────────────────────────────────────
// Minimal stub: contacts/search returns an empty result so the customers page
// loads without requiring real credentials.  Property GET endpoints return a
// minimal shape so startup side-effects don't error.

function startMockHubspot() {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const url = req.url.split('?')[0];

      if (url === '/crm/v3/objects/contacts/search') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ results: [], paging: null, total: 0 }));
      }

      if (req.method === 'GET' && url.startsWith('/crm/v3/properties/contacts/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ name: 'hw_test_user', type: 'bool' }));
      }

      if (req.method === 'GET' && url === '/crm/v3/properties/contacts') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ results: [] }));
      }

      if (req.method === 'POST' && url === '/crm/v3/properties/contacts') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: 'Property already exists' }));
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: `no mock for ${req.method} ${url}` }));
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

// ── Open customers page (listener) ────────────────────────────────────────────
//
// Intercepts the subset of API calls that CustomersPage makes on mount so
// the React island can render without real HubSpot credentials.
// Injects a per-load token so probes can confirm no full reload happened.

async function openCustomersPage(browser, adminCookie) {
  const page = await browser.newPage();
  page.on('pageerror', () => {});
  page.on('console',   () => {});

  // Record a page-load token once, before any scripts execute.
  await page.evaluateOnNewDocument(() => {
    window.__pageLoadToken = Math.random().toString(36).slice(2, 10);
  });

  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();

    // Dev-mode initial state — off, so the banner is initially absent.
    if (u.includes('/api/admin/hubspot/dev-mode') && req.method() === 'GET') {
      req.respond({
        status:      200,
        contentType: 'application/json',
        body:        JSON.stringify({ devMode: false }),
      });
      return;
    }

    // contacts-all — empty list so the page renders without HubSpot.
    if (u.includes('/api/contacts-all')) {
      req.respond({
        status:      200,
        contentType: 'application/json',
        body:        JSON.stringify({ results: [], total: 0 }),
      });
      return;
    }

    // contacts-lead-status-counts — filter bar.
    if (u.includes('/api/contacts-lead-status-counts')) {
      req.respond({
        status:      200,
        contentType: 'application/json',
        body:        JSON.stringify({}),
      });
      return;
    }

    // page-filter-config — stage tabs.
    if (u.includes('/api/page-filter-config')) {
      req.respond({
        status:      200,
        contentType: 'application/json',
        body:        JSON.stringify({ stages: [], filterGroupOrder: [] }),
      });
      return;
    }

    req.continue();
  });

  await injectSession(page, adminCookie);
  await page.goto(`${BASE}/customers`, {
    waitUntil: 'domcontentloaded',
    timeout:   30000,
  });

  // Wait for the React CustomersPage island to mount (any MUI element).
  const mounted = await pollUntil(
    page,
    () => {
      const el = document.querySelector('#lead-status-filter');
      return el ? 'ok' : null;
    },
    20000,
    200,
  );

  return { page, mounted: !!mounted };
}

// ── Open admin Dev Environment page (sender) ──────────────────────────────────
//
// Opens /admin in a second page, waits for the DevEnvironmentPage to load in
// its tab, and returns the page handle.  The caller can then click the Switch
// to trigger the full API→BC flow.

async function openDevEnvPage(browser, adminCookie) {
  const page = await browser.newPage();
  page.on('pageerror', () => {});
  page.on('console',   () => {});

  await injectSession(page, adminCookie);
  await page.goto(`${BASE}/admin`, {
    waitUntil: 'domcontentloaded',
    timeout:   30000,
  });

  // Switch to the Dev Environment tab using the admin page's JS API.
  await pollUntil(
    page,
    () => (typeof window.switchTab === 'function' ? 'ok' : null),
    15000,
    200,
  );
  await page.evaluate(() => window.switchTab('devenv'));

  // Wait for the React DevEnvironmentPage to mount and finish loading its
  // dev-mode state (the Switch exits the "disabled/loading" state).
  const ready = await pollUntil(
    page,
    () => {
      // The Switch input is a hidden <input type="checkbox"> inside the MUI
      // FormControlLabel.  It becomes enabled once devModeLoading=false.
      const inp = document.querySelector('#tab-devenv input[type="checkbox"]');
      return (inp && !inp.disabled) ? 'ok' : null;
    },
    20000,
    200,
  );

  return { page, ready: !!ready };
}

// Click the dev-mode Switch in the DevEnvironmentPage tab and wait for the
// toggle to complete (the switch re-enables after the API response).
async function clickDevModeSwitch(senderPage) {
  const inp = await senderPage.$('#tab-devenv input[type="checkbox"]');
  if (!inp) throw new Error('dev-mode checkbox not found in sender page');
  await inp.click();

  // Wait until the switch re-enables (devModeToggling → false).
  await pollUntil(
    senderPage,
    () => {
      const i = document.querySelector('#tab-devenv input[type="checkbox"]');
      return (i && !i.disabled) ? 'ok' : null;
    },
    10000,
    200,
  );
}

// ── Report ─────────────────────────────────────────────────────────────────────

async function writeReport(runId) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Dev-Mode BroadcastChannel Sync — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:dev-mode-bc-sync\``,
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
    '- **(setup)** React CustomersPage mounts with API stubs; banner absent initially.',
    '- **(BC-A) Enable**: admin clicks the dev-mode Switch in the DevEnvironmentPage.',
    '  The click drives `handleDevModeToggle` → `POST /api/admin/hubspot/dev-mode`',
    '  → `BroadcastChannel(\'dev_mode_changed\').postMessage({ devMode: true })`',
    '  → `#dev-mode-banner` appears on the listener tab without a full reload.',
    '- **(BC-B) Disable**: admin clicks the Switch again; banner disappears, no reload.',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
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

  if (!puppeteer) {
    console.error('puppeteer is not installed — skipping browser tests.');
    process.exit(1);
  }

  const runId = Math.random().toString(36).slice(2, 8);
  console.log(`\n  dev-mode-bc-sync  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL'}`);

  const pool = new Pool({ connectionString: connStr });
  const mock = await startMockHubspot();
  console.log(`  mock HubSpot listening on http://127.0.0.1:${mock.port}`);

  process.env.HUBSPOT_API_URL                   = `http://127.0.0.1:${mock.port}`;
  process.env.HUBSPOT_ACCESS_TOKEN              = 'privtest-dummy-token';
  process.env.PRIVTEST_USE_HUBSPOT_ACCESS_TOKEN = '1';
  process.env.PRIVTEST_USE_HUBSPOT_API_URL      = '1';

  setPool(pool);
  await cleanupTestData(pool);
  const users = await seedUsers(pool, runId);

  // Ensure dev mode starts OFF in the DB so the first toggle enables it.
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('dev_mode_enabled', 'false')
     ON CONFLICT (key) DO UPDATE SET value = 'false'`,
  );

  const { child, logBuf } = spawnServer();
  let exitCode = 1;

  const cleanup = async () => {
    try { child.kill('SIGTERM'); } catch {}
    try { await cleanupTestData(pool); } catch {}
    // Reset dev mode to OFF so a crashed run doesn't leave it on.
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('dev_mode_enabled', 'false')
       ON CONFLICT (key) DO UPDATE SET value = 'false'`,
    ).catch(() => {});
    await pool.end().catch(() => {});
    try { mock.server.close(); } catch {}
  };
  process.on('SIGINT',  () => cleanup().then(() => process.exit(130)));
  process.on('SIGTERM', () => cleanup().then(() => process.exit(130)));

  let browser = null;

  try {
    await waitForServer();
    await resetRateLimitStore(pool);
    console.log(`  test server up at ${BASE}\n`);

    const execPath = findChromium();
    browser = await puppeteer.launch({
      executablePath: execPath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    // Log in as admin.
    const adminClient = await login(users.admin.email, PASSWORD);
    const adminCookie = adminClient.cookie;

    // ── Open the customers page (listener) ──────────────────────────────────
    console.log('  Opening customers page (listener tab)…');
    const { page: listenerPage, mounted } = await openCustomersPage(browser, adminCookie);

    record('setup.mount',
      mounted,
      `React CustomersPage mounted: ${mounted}`);

    if (!mounted) {
      console.error('  React island did not mount — aborting browser probes.');
      exitCode = 1;
      await writeReport(runId);
      return;
    }

    // Capture the initial page-load token.
    const tokenBefore = await listenerPage.evaluate(() => window.__pageLoadToken);

    // Confirm banner is absent before any toggle.
    const bannerBefore = await listenerPage.evaluate(() =>
      !!document.getElementById('dev-mode-banner'),
    );
    record('setup.no-banner-initially',
      !bannerBefore,
      `banner present before toggle: ${bannerBefore}`);

    // ── Open admin Dev Environment page (sender) ─────────────────────────────
    console.log('  Opening admin Dev Environment page (sender tab)…');
    const { page: senderPage, ready } = await openDevEnvPage(browser, adminCookie);

    record('setup.devenv-ready',
      ready,
      `DevEnvironmentPage Switch ready: ${ready}`);

    if (!ready) {
      console.error('  DevEnvironmentPage Switch did not become ready — aborting.');
      exitCode = 1;
      await writeReport(runId);
      return;
    }

    // ── [BC-A] Enable dev mode via the DevEnvironmentPage Switch ─────────────
    console.log('\n  [BC-A] Clicking dev-mode Switch ON via DevEnvironmentPage…');

    await clickDevModeSwitch(senderPage);

    // Poll for the banner to appear on the listener tab.
    const bannerAppeared = await pollUntil(
      listenerPage,
      () => !!document.getElementById('dev-mode-banner') || null,
      10000,
      200,
    );

    record('BC-A.1 banner appears after Switch clicked ON',
      !!bannerAppeared,
      `bannerAppeared=${!!bannerAppeared}`);

    // Confirm no full reload.
    const tokenAfterEnable = await listenerPage.evaluate(() => window.__pageLoadToken);
    record('BC-A.2 no full reload (page token unchanged)',
      tokenAfterEnable === tokenBefore,
      `before=${tokenBefore} after=${tokenAfterEnable}`);

    // Banner text is correct.
    const bannerText = await listenerPage.evaluate(() => {
      const el = document.getElementById('dev-mode-banner');
      return el ? el.textContent.trim() : '';
    });
    record('BC-A.3 banner carries correct text',
      bannerText.includes('Dev mode is ON'),
      `text="${bannerText}"`);

    // Sender Switch is now checked (confirm state propagated).
    const switchChecked = await senderPage.evaluate(() => {
      const inp = document.querySelector('#tab-devenv input[type="checkbox"]');
      return inp ? inp.checked : null;
    });
    record('BC-A.4 sender Switch reflects ON state',
      switchChecked === true,
      `checked=${switchChecked}`);

    // ── [BC-B] Disable dev mode via the DevEnvironmentPage Switch ─────────────
    console.log('\n  [BC-B] Clicking dev-mode Switch OFF via DevEnvironmentPage…');

    await clickDevModeSwitch(senderPage);

    // Poll for the banner to disappear.
    const bannerGone = await pollUntil(
      listenerPage,
      () => !document.getElementById('dev-mode-banner') || null,
      10000,
      200,
    );

    record('BC-B.1 banner disappears after Switch clicked OFF',
      !!bannerGone,
      `bannerGone=${!!bannerGone}`);

    // Confirm still no full reload.
    const tokenAfterDisable = await listenerPage.evaluate(() => window.__pageLoadToken);
    record('BC-B.2 no full reload (page token unchanged)',
      tokenAfterDisable === tokenBefore,
      `before=${tokenBefore} after=${tokenAfterDisable}`);

    // Sender Switch is unchecked.
    const switchUnchecked = await senderPage.evaluate(() => {
      const inp = document.querySelector('#tab-devenv input[type="checkbox"]');
      return inp ? inp.checked : null;
    });
    record('BC-B.3 sender Switch reflects OFF state',
      switchUnchecked === false,
      `checked=${switchUnchecked}`);

    const failed = findings.filter(f => !f.ok).length;
    exitCode = failed === 0 ? 0 : 1;
    console.log(`\n  Results: ${findings.length - failed} passed, ${failed} failed`);
  } catch (e) {
    console.error('Test crashed:', e);
    console.error('--- server log (last 2000 chars) ---');
    console.error(logBuf.join('').slice(-2000));
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
    await writeReport(runId);
    await cleanup();
    process.exit(exitCode);
  }
}

main();
