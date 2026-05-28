'use strict';
// test/new-customer-counts-retry/run.js
//
// Focused integration test for the retry logic inside the `onCreated` callback
// of CustomersPage.tsx (task #840 / task #850).
//
// The `attemptCreatedCounts` helper fires immediately after a new customer is
// created, retrying `loadLeadStatusCounts` up to MAX_CREATED_RETRIES=2 times
// (3 total attempts) with a 30 s gap.  On final failure it sets
// `bgRefreshFailed=true`, which renders the Snackbar:
//   "Couldn't refresh live data — fresh results will load on your next visit"
//
// Strategy
// ────────
// • Boot Express + a minimal mock HubSpot (for contact creation only).
// • Use Puppeteer request interception to control what `/api/contacts-lead-status-counts`
//   returns, avoiding the need to manipulate the server-side HubSpot layer.
// • Inject `evaluateOnNewDocument` to collapse any `setTimeout(fn, delay)`
//   with delay > 1 s to 10 ms so the 30 s retry gaps run almost instantly.
//
// Probes
// ──────
// [D] All retries fail — Snackbar "Couldn't refresh live data…" appears.
// [E] Second attempt succeeds — Snackbar does NOT appear.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:new-customer-counts-retry
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:new-customer-counts-retry

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

require('dotenv').config();

const { pollUntil } = require('../helpers/poll');

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

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'new-customer-counts-retry.md'
);

// ── Minimal mock HubSpot ──────────────────────────────────────────────────────
// Handles only the endpoints needed for the new-customer form flow.
// /api/contacts-lead-status-counts is intercepted at the browser level, so
// the mock never receives those search calls.
function startMockHubspot() {
  const state = {
    createPosts: [],
    nextContactId: 989800000850,
    contacts: [],
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch {}

      // POST /crm/v3/properties/contacts — ensureHubSpotProperties
      if (req.method === 'POST' && u.pathname === '/crm/v3/properties/contacts') {
        return send(409, { message: 'Property already exists' });
      }

      // POST /crm/v3/objects/contacts/search — contacts-all cache
      if (req.method === 'POST' && u.pathname === '/crm/v3/objects/contacts/search') {
        return send(200, { results: state.contacts.slice(), paging: {} });
      }

      // POST /crm/v3/objects/contacts — create new contact
      if (req.method === 'POST' && u.pathname === '/crm/v3/objects/contacts') {
        state.createPosts.push(body);
        const id = String(state.nextContactId++);
        const contact = {
          id,
          properties: { ...(body.properties || {}), hw_test_user: 'true' },
        };
        state.contacts.push(contact);
        return send(201, { id, properties: { ...contact.properties } });
      }

      // PATCH /crm/v3/objects/contacts/:id
      const m = u.pathname.match(/^\/crm\/v3\/objects\/contacts\/([^/]+)$/);
      if (m && req.method === 'PATCH') {
        return send(200, { id: decodeURIComponent(m[1]), properties: { ...(body.properties || {}) } });
      }
      if (m && req.method === 'GET') {
        return send(200, { id: decodeURIComponent(m[1]), properties: {} });
      }

      send(404, { error: 'mock: not_found', method: req.method, path: u.pathname });
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, state });
    });
  });
}

// ── Puppeteer helpers ─────────────────────────────────────────────────────────
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

async function pollPage(page, fn, arg, timeoutMs = 10000, intervalMs = 100) {
  return pollUntil(page, fn, timeoutMs, intervalMs, arg !== undefined && arg !== null ? [arg] : []);
}

async function newPageWithSession(browser, jar) {
  const ctx = await (browser.createBrowserContext
    ? browser.createBrowserContext()
    : browser.createIncognitoBrowserContext());
  const page = await ctx.newPage();
  page.__ctx = ctx;
  await page.setCacheEnabled(false);
  const logs = [];
  page.on('console',       m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror',     e => logs.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', r => logs.push(`[reqfailed] ${r.url()} ${r.failure()?.errorText || ''}`));
  page.on('response',      r => {
    const s = r.status();
    if (s >= 400) logs.push(`[resp ${s}] ${r.request().method()} ${r.url()}`);
  });
  await injectSession(page, jar);
  page.__logs = logs;
  return page;
}

async function closePage(p) {
  try { await p.close(); } catch {}
  try { await p.__ctx?.close(); } catch {}
}

// Collapse any large setTimeout delays so the 30 s retry gaps run instantly.
// thresholdMs (default 1000) controls which delays are collapsed — only delays
// strictly greater than the threshold are replaced with 10 ms.  Probe G uses
// thresholdMs=10000 so the 30 s retry gaps collapse while the 8 s autoHideDuration
// stays at its real value, giving the test time to simulate tab-hide.
async function installFastTimers(page, thresholdMs = 1000) {
  await page.evaluateOnNewDocument((threshold) => {
    const _orig = window.setTimeout.bind(window);
    window.setTimeout = (fn, delay, ...args) => _orig(fn, delay > threshold ? 10 : delay, ...args);
  }, thresholdMs);
}

// Enable request interception and install a counts interceptor.
// Returns an object whose `mode` property can be updated by the caller.
async function installCountsInterceptor(page) {
  const ctrl = { mode: 'succeed', failCount: 0 };

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('/api/contacts-lead-status-counts')) {
      const body502 = JSON.stringify({ error: 'mock-fail', code: 'HUBSPOT_ERROR' });
      const body200 = JSON.stringify({});
      const ct = 'application/json';

      if (ctrl.mode === 'always-fail') {
        req.respond({ status: 502, contentType: ct, body: body502 });
      } else if (ctrl.mode === 'fail-once') {
        ctrl.failCount++;
        if (ctrl.failCount <= 1) {
          req.respond({ status: 502, contentType: ct, body: body502 });
        } else {
          req.respond({ status: 200, contentType: ct, body: body200 });
        }
      } else {
        // 'succeed'
        req.respond({ status: 200, contentType: ct, body: body200 });
      }
      return;
    }
    req.continue();
  });

  return ctrl;
}

// Wait for the Snackbar with the bgRefreshFailed message.
// MUI Snackbar renders with role="alert" inside role="presentation".
async function waitForRefreshFailedSnackbar(page, timeoutMs = 10000) {
  return pollPage(page, () => {
    // MUI Snackbar with message sets role="alert" on the content
    const alerts = Array.from(document.querySelectorAll('[role="alert"]'));
    return alerts.some(el =>
      (el.textContent || '').includes("Couldn't refresh live data")
    ) ? 'visible' : null;
  }, null, timeoutMs);
}

// Wait for the Snackbar to disappear after it was visible.
// Used to confirm autoHideDuration fires and dismisses the alert.
async function waitForSnackbarGone(page, timeoutMs = 5000) {
  return pollUntil(
    page,
    () => {
      const alerts = Array.from(document.querySelectorAll('[role="alert"]'));
      return alerts.some(el => (el.textContent || '').includes("Couldn't refresh live data"))
        ? null : 'gone';
    },
    timeoutMs,
    100,
  );
}

// Assert the Snackbar does NOT appear within a window.
// Returns 'appeared' if the snackbar shows up (bad), null if it never appears (good).
async function assertNoSnackbar(page, waitMs = 4000) {
  return pollUntil(
    page,
    () => {
      const alerts = Array.from(document.querySelectorAll('[role="alert"]'));
      return alerts.some(el => (el.textContent || '').includes("Couldn't refresh live data"))
        ? 'appeared' : null;
    },
    waitMs,
    100,
  );
}

async function waitForCustomersMounted(page) {
  await pollPage(page, () => {
    const hs = Array.from(document.querySelectorAll('h1'))
      .some(h => /Customers/i.test(h.textContent || ''));
    return hs ? 'ok' : null;
  }, null, 15000);
}

// Fill and submit the NewCustomerDialog for a given email.
async function submitNewCustomerDialog(page, runId, suffix) {
  // Click the New Customer button.
  await page.evaluate(() => {
    const b = document.getElementById('new-customer-btn');
    if (b) b.click();
  });
  // Wait for the dialog to open.
  const opened = await pollPage(page,
    () => document.getElementById('new-customer-form') ? 'ok' : null, null, 8000);
  if (!opened) throw new Error('new-customer-form did not appear');

  // Fill fields.
  const email = `nc-retry-${suffix}-${runId}@privtest.local`;
  await page.evaluate((args) => {
    const setVal = (id, v) => {
      const el = document.getElementById(id);
      if (!el) return;
      const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter ? setter.call(el, v) : (el.value = v);
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setVal('nc-firstname', args.fn);
    setVal('nc-lastname',  args.ln);
    setVal('nc-email',     args.email);
    setVal('nc-phone',     '07900111222');
    setVal('nc-postcode',  'EC1A 1BB');
  }, { fn: 'Retry', ln: 'Probe', email });

  // Submit the form.
  await page.evaluate(() => {
    const form = document.getElementById('new-customer-form');
    if (!form) return;
    if (form.requestSubmit) form.requestSubmit();
    else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });

  return email;
}

// ── main ─────────────────────────────────────────────────────────────────────
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
  console.log(`\n  new-customer-counts-retry  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);
  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  member=${users.member.email}`);

  const mock = await startMockHubspot();
  console.log(`  Mock HubSpot on 127.0.0.1:${mock.port}`);

  const { child, logBuf } = spawnServer({
    extraEnv: {
      HUBSPOT_API_URL:      `http://127.0.0.1:${mock.port}`,
      HUBSPOT_ACCESS_TOKEN: 'mock-token-counts-retry',
      HUBSPOT_TOKEN:        'mock-token-counts-retry',
    },
  });
  let exited = false;
  child.on('exit', () => { exited = true; });

  const findings = [];
  function record(name, expected, observed, ok) {
    findings.push({ name, expected, observed, ok });
    const mark = ok ? '  ✓' : '  ✗';
    console.log(`${mark}  ${name}`);
    if (!ok) {
      console.log(`     expected : ${expected}`);
      console.log(`     observed : ${observed}`);
    }
  }

  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try { mock.server.close(); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    process.exit(code);
  };
  process.on('SIGINT',  () => cleanupAndExit(130));
  process.on('SIGTERM', () => cleanupAndExit(130));
  process.on('uncaughtException',  (e) => { console.error('Uncaught:',  e); cleanupAndExit(2); });
  process.on('unhandledRejection', (e) => { console.error('Unhandled:', e); cleanupAndExit(2); });

  try {
    await waitForServer();
    await resetRateLimitStore(pool);
    console.log(`  Server up at ${BASE}`);
  } catch (e) {
    console.error('Server boot failed:', e.message);
    console.error(logBuf.join('').slice(-2000));
    await cleanupAndExit(2);
    return;
  }

  const memberClient = await login(users.member.email, PASSWORD);

  // ── Puppeteer probes ──────────────────────────────────────────────────────
  const UI_LABELS = [
    '[D] all retries fail — Snackbar "Couldn\'t refresh live data…" appears',
    '[E] second attempt succeeds — Snackbar does NOT appear',
    '[F] Snackbar auto-dismisses after autoHideDuration (8 s)',
    '[G] Snackbar survives tab-hide — still auto-dismisses when tab returns visible',
  ];

  if (!puppeteer) {
    for (const l of UI_LABELS) record(l, 'puppeteer installed', 'puppeteer not installed', false);
    const fail = findings.filter(f => !f.ok).length;
    await writeReport(runId, findings);
    await cleanupAndExit(fail > 0 ? 1 : 0);
    return;
  }

  const { findChromium } = require('../shared/find-chromium');
  let browser = null;
  let launchErr = null;
  const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox'];
  const attempts = [{ args: launchArgs }];
  const sysChrome = findChromium();
  if (sysChrome) attempts.push({ executablePath: sysChrome, args: launchArgs });
  for (const opts of attempts) {
    try {
      browser = await puppeteer.launch({ headless: true, ...opts });
      launchErr = null;
      break;
    } catch (e) { launchErr = e; browser = null; }
  }

  if (!browser) {
    const msg = (launchErr?.message || String(launchErr)).slice(0, 200);
    for (const l of UI_LABELS) record(l, 'browser launched', `browser launch failed: ${msg}`, false);
    const fail = findings.filter(f => !f.ok).length;
    await writeReport(runId, findings);
    await cleanupAndExit(fail > 0 ? 1 : 0);
    return;
  }

  try {
    // ══════════════════════════════════════════════════════════════════════════
    // Probe D — all counts calls fail → Snackbar appears
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [D] All retries fail → Snackbar expected');
    {
      const page = await newPageWithSession(browser, memberClient.cookie);

      // Collapse large setTimeout delays before any page script runs.
      await installFastTimers(page);

      // Intercept /api/contacts-lead-status-counts — always return 502.
      const ctrl = await installCountsInterceptor(page);
      ctrl.mode = 'always-fail';

      await page.goto(`${BASE}/customers`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await waitForCustomersMounted(page);

      // Wait for the New Customer button to appear.
      const btnPresent = await pollPage(page,
        () => document.getElementById('new-customer-btn') ? 'ok' : null, null, 8000);

      if (!btnPresent) {
        record(UI_LABELS[0],
          'Snackbar visible after all retries',
          '#new-customer-btn not found — page may not have mounted correctly',
          false);
      } else {
        // Submit a new customer.
        await submitNewCustomerDialog(page, runId, 'd');

        // All 3 attempts (0 + 2 retries) fail → Snackbar must appear.
        // With fast timers the 30 s gaps collapse to ~10 ms each.
        const snackbar = await waitForRefreshFailedSnackbar(page, 10000);
        record(UI_LABELS[0],
          'Snackbar visible after all retries',
          `snackbar=${snackbar === 'visible' ? 'visible' : 'not seen'}`,
          snackbar === 'visible');
      }

      if (page.__logs.some(l => l.includes('[pageerror]'))) {
        console.log('  Page errors (probe D):', page.__logs.filter(l => l.includes('[pageerror]')));
      }
      await closePage(page);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Probe E — second attempt succeeds → Snackbar must NOT appear
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [E] Second attempt succeeds → no Snackbar expected');
    {
      const page = await newPageWithSession(browser, memberClient.cookie);

      // Collapse large setTimeout delays.
      await installFastTimers(page);

      // Start in 'succeed' mode so page load counts call (which is silently
      // caught) succeeds.  We switch to 'fail-once' just before submitting
      // so the first onCreated attempt fails and the retry succeeds.
      const ctrl = await installCountsInterceptor(page);
      ctrl.mode = 'succeed';

      await page.goto(`${BASE}/customers`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await waitForCustomersMounted(page);

      const btnPresent = await pollPage(page,
        () => document.getElementById('new-customer-btn') ? 'ok' : null, null, 8000);

      if (!btnPresent) {
        record(UI_LABELS[1],
          'Snackbar absent after successful retry',
          '#new-customer-btn not found — page may not have mounted correctly',
          false);
      } else {
        // Switch interceptor to 'fail-once' right before triggering onCreated:
        // first counts call → 502, second counts call → 200.
        ctrl.mode = 'fail-once';
        ctrl.failCount = 0;

        await submitNewCustomerDialog(page, runId, 'e');

        // Give the retry enough time to fire and resolve (fast timers + network).
        // The second attempt should succeed before this window closes.
        const appeared = await assertNoSnackbar(page, 5000);
        record(UI_LABELS[1],
          'Snackbar absent after successful retry',
          `snackbar=${appeared === 'appeared' ? 'appeared (bad)' : 'never appeared (good)'}`,
          appeared === null);
      }

      if (page.__logs.some(l => l.includes('[pageerror]'))) {
        console.log('  Page errors (probe E):', page.__logs.filter(l => l.includes('[pageerror]')));
      }
      await closePage(page);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Probe F — Snackbar auto-dismisses after autoHideDuration (8 s)
    //
    // Scenario: all counts calls fail (always-fail), so the Snackbar appears.
    // The fast-timer override collapses the 8 s autoHideDuration to ~10 ms, so
    // MUI's internal setTimeout fires almost immediately.  We confirm that the
    // Snackbar element disappears from the DOM without any user interaction.
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [F] Snackbar auto-dismisses after autoHideDuration');
    {
      const page = await newPageWithSession(browser, memberClient.cookie);

      // Collapse large setTimeout delays (including MUI's autoHideDuration).
      await installFastTimers(page);

      const ctrl = await installCountsInterceptor(page);
      ctrl.mode = 'always-fail';

      await page.goto(`${BASE}/customers`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await waitForCustomersMounted(page);

      const btnPresent = await pollPage(page,
        () => document.getElementById('new-customer-btn') ? 'ok' : null, null, 8000);

      if (!btnPresent) {
        record(UI_LABELS[2],
          'Snackbar appears then auto-dismisses',
          '#new-customer-btn not found — page may not have mounted correctly',
          false);
      } else {
        await submitNewCustomerDialog(page, runId, 'f');

        // Step 1: Snackbar must appear (all 3 attempts fail).
        const appeared = await waitForRefreshFailedSnackbar(page, 10000);

        if (appeared !== 'visible') {
          record(UI_LABELS[2],
            'Snackbar appears then auto-dismisses',
            'Snackbar never appeared — cannot test auto-dismiss',
            false);
        } else {
          // Step 2: With fast timers the 8 s autoHideDuration fires in ~10 ms.
          // Wait up to 5 s for the Snackbar to disappear from the DOM.
          const gone = await waitForSnackbarGone(page, 5000);
          record(UI_LABELS[2],
            'Snackbar appears then auto-dismisses',
            `snackbar=${gone === 'gone' ? 'appeared then dismissed (good)' : 'still visible after timeout (bad)'}`,
            gone === 'gone');
        }
      }

      if (page.__logs.some(l => l.includes('[pageerror]'))) {
        console.log('  Page errors (probe F):', page.__logs.filter(l => l.includes('[pageerror]')));
      }
      await closePage(page);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Probe G — Snackbar survives tab-hide and auto-dismisses when tab returns
    //
    // Scenario: all counts calls fail → Snackbar appears.  While the Snackbar is
    // visible the document is hidden (Page Visibility API: both visibilityState
    // and document.hidden are overridden; visibilitychange is dispatched).  MUI
    // Snackbar clears its autoHideDuration timer in response.  The tab stays
    // hidden for 9.5 s — longer than the 8 s autoHideDuration.  If MUI's pause
    // logic were absent the timer would have fired and dismissed the Snackbar
    // during this window, so a Snackbar that is still visible at 9.5 s proves
    // the pause is working.  The tab is then restored to visible; MUI restarts
    // the full 8 s autoHideDuration and the Snackbar must dismiss within 12 s.
    //
    // Fast-timers use thresholdMs=10000 so the 30 s retry gaps collapse to 10 ms
    // while the 8 s autoHideDuration stays at its real value — this is what makes
    // the 9.5 s hidden wait a discriminating assertion.
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [G] Snackbar survives tab-hide → auto-dismisses on tab return');
    {
      const page = await newPageWithSession(browser, memberClient.cookie);

      // Only collapse delays > 10 s (30 s retries → 10 ms; 8 s autoHide stays).
      await installFastTimers(page, 10000);

      const ctrl = await installCountsInterceptor(page);
      ctrl.mode = 'always-fail';

      await page.goto(`${BASE}/customers`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await waitForCustomersMounted(page);

      const btnPresent = await pollPage(page,
        () => document.getElementById('new-customer-btn') ? 'ok' : null, null, 8000);

      if (!btnPresent) {
        record(UI_LABELS[3],
          'Snackbar appears, stays visible while hidden (>8 s), then dismisses on tab-show',
          '#new-customer-btn not found — page may not have mounted correctly',
          false);
      } else {
        await submitNewCustomerDialog(page, runId, 'g');

        // Step 1: Snackbar must appear (all 3 retries fail; gaps collapse to 10 ms).
        const appeared = await waitForRefreshFailedSnackbar(page, 10000);

        if (appeared !== 'visible') {
          record(UI_LABELS[3],
            'Snackbar appears, stays visible while hidden (>8 s), then dismisses on tab-show',
            'Snackbar never appeared — cannot test visibility-hide behaviour',
            false);
        } else {
          // Step 2: Simulate the tab going hidden.
          // Override both document.visibilityState and document.hidden, then
          // dispatch visibilitychange so MUI's event listener clears the timer.
          await page.evaluate(() => {
            Object.defineProperty(document, 'visibilityState', {
              configurable: true,
              get: () => 'hidden',
            });
            Object.defineProperty(document, 'hidden', {
              configurable: true,
              get: () => true,
            });
            document.dispatchEvent(new Event('visibilitychange'));
          });

          // Step 3: Wait 9.5 s while the tab is "hidden".
          // The autoHideDuration (8 s) is NOT collapsed for this probe, so if MUI's
          // timer-pause logic were broken the timer would fire at ~8 s and dismiss
          // the Snackbar.  We check AFTER 9.5 s: a Snackbar that is still visible
          // here confirms the timer was properly paused.
          await new Promise(r => setTimeout(r, 9500));

          const stillVisibleWhileHidden = await page.evaluate(() => {
            const alerts = Array.from(document.querySelectorAll('[role="alert"]'));
            return alerts.some(el =>
              (el.textContent || '').includes("Couldn't refresh live data")
            );
          }).catch(() => false);

          // Step 4: Restore the tab to visible.
          // MUI reacts to visibilitychange by restarting the full autoHideDuration.
          await page.evaluate(() => {
            Object.defineProperty(document, 'visibilityState', {
              configurable: true,
              get: () => 'visible',
            });
            Object.defineProperty(document, 'hidden', {
              configurable: true,
              get: () => false,
            });
            document.dispatchEvent(new Event('visibilitychange'));
          });

          // Step 5: Snackbar must now auto-dismiss.
          // MUI restarts the full 8 s autoHideDuration on visibility restore;
          // allow up to 12 s (8 s + animation buffer).
          const gone = await waitForSnackbarGone(page, 12000);

          record(UI_LABELS[3],
            'Snackbar appears, stays visible while hidden (>8 s), then dismisses on tab-show',
            [
              `visible_while_hidden=${stillVisibleWhileHidden ? 'yes — timer paused (good)' : 'prematurely dismissed — timer NOT paused (bad)'}`,
              `final=${gone === 'gone' ? 'dismissed after tab-show (good)' : 'still visible after timeout (bad)'}`,
            ].join(', '),
            stillVisibleWhileHidden && gone === 'gone');
        }
      }

      if (page.__logs.some(l => l.includes('[pageerror]'))) {
        console.log('  Page errors (probe G):', page.__logs.filter(l => l.includes('[pageerror]')));
      }
      await closePage(page);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const pass = findings.filter(f => f.ok).length;
  const fail = findings.filter(f => !f.ok).length;
  console.log(`\n  Results: ${pass} passed, ${fail} failed`);

  await writeReport(runId, findings);
  await cleanupAndExit(fail > 0 ? 1 : 0);
}

async function writeReport(runId, findings) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# New Customer Counts Retry — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:new-customer-counts-retry\``,
    '',
    '## Summary',
    '',
    `- Passed: ${findings.filter(f => f.ok).length} / ${findings.length}`,
    `- Failed: ${findings.filter(f => !f.ok).length} / ${findings.length}`,
    '',
    '## Results',
    '',
    '| Result | Probe | Expected | Observed |',
    '|---|---|---|---|',
    ...findings.map(f =>
      `| ${f.ok ? 'PASS' : 'FAIL'} | ${esc(f.name)} | ${esc(f.expected)} | ${esc(f.observed)} |`,
    ),
    '',
    '## Coverage',
    '',
    '- **[D] All retries fail**: after `NewCustomerDialog.onCreated` fires,',
    '  `loadLeadStatusCounts` is called immediately and twice more (3 total,',
    '  `MAX_CREATED_RETRIES=2`).  When every attempt returns HTTP 502 the',
    '  `bgRefreshFailed` Snackbar ("Couldn\'t refresh live data…") must appear.',
    '  Large `setTimeout` delays (30 s) are collapsed to 10 ms via',
    '  `evaluateOnNewDocument`; `/api/contacts-lead-status-counts` is',
    '  intercepted at the Puppeteer layer and always returns 502.',
    '- **[E] Second attempt succeeds**: first `onCreated` counts call returns',
    '  502, the retry (second call) returns 200.  The Snackbar must NOT appear.',
    '- **[F] Snackbar auto-dismisses**: same always-fail scenario as [D];',
    '  after the Snackbar appears the test waits for it to disappear.  The',
    '  `autoHideDuration={8000}` on the MUI Snackbar uses `setTimeout`',
    '  internally, which the fast-timer override collapses to ~10 ms.  The',
    '  Snackbar must be gone from the DOM within 5 s of appearing.',
    '- **[G] Snackbar survives tab-hide**: all counts calls fail so the Snackbar',
    '  appears.  Both `document.visibilityState` and `document.hidden` are',
    '  overridden and a `visibilitychange` event is dispatched — simulating the',
    '  user switching away from the tab.  MUI Snackbar clears its',
    '  `autoHideDuration` timer in response.  The test waits **9.5 s** while',
    '  the document is hidden — longer than the 8 s `autoHideDuration`.  If',
    '  the pause logic were absent the timer would have fired during this',
    '  window; a Snackbar that is still visible at 9.5 s proves the timer was',
    '  paused.  The document is then restored to `\'visible\'`; MUI restarts the',
    '  full 8 s `autoHideDuration` and the Snackbar must dismiss within 12 s.',
    '  Fast-timers use `thresholdMs=10000` so the 30 s retry gaps collapse to',
    '  10 ms while the 8 s `autoHideDuration` stays at its real value —',
    '  making the 9.5 s hidden-wait a discriminating (not vacuous) assertion.',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
}

main();
