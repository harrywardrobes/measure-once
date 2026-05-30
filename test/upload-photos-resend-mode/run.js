'use strict';
// test/upload-photos-resend-mode/run.js
//
// Regression guard for the resend-mode detection in UploadPhotosModal.tsx.
//
// The modal fetches GET /api/customer-info/by-contact/:contactId on open and
// switches between two modes based on whether an active (non-submitted,
// non-expired) submission already exists for the contact.
//
// Probes:
//   (A) Pending row present  → title "Resend photo upload link", button "Resend link"
//   (B) No pending rows      → title "Send photo upload link",   button "Send email"
//   (C) Network error on GET → falls back to send mode:
//                              title "Send photo upload link",   button "Send email"
//
// Strategy: boots a disposable test server, drives /customers with
// Puppeteer, stubs ALL customers-page API calls via evaluateOnNewDocument
// fetch interception (so no HubSpot token is needed), waits for
// window.dispatchCardActionHandler to be available, then dispatches the
// upload_photos_and_info modal with different by-contact stubs for each probe.
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:upload-photos-resend-mode
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:upload-photos-resend-mode

const fs   = require('fs');
const path = require('path');
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
} = require('../privileges/harness');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

require('dotenv').config();

const { pollUntil } = require('../helpers/poll');

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'upload-photos-resend-mode.md',
);

// Contact fixture — stable id used in fetch stubs.
const CONTACT_ID   = 'privtest-upm-contact-1';
const CONTACT_NAME = 'Upload PrivTest';
const CONTACT_EMAIL = 'upload@privtest.invalid';

// Future expiry for pending-row stubs.
const FUTURE_EXPIRES = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

// ── Reporting ─────────────────────────────────────────────────────────────────

const findings = [];
function record(name, expected, observed, ok, detail = '') {
  findings.push({ name, expected, observed, ok, detail });
  const mark = ok ? '  ✓' : '  ✗';
  console.log(`${mark}  ${name}`);
  if (!ok) {
    console.log(`     expected : ${expected}`);
    console.log(`     observed : ${observed}`);
    if (detail) console.log(`     detail   : ${detail}`);
  }
}

function writeReport(runId) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok).length;
  const lines = [
    '# Upload Photos Modal — Resend Mode Detection Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:upload-photos-resend-mode\``,
    '',
    '## Summary',
    '',
    `- Passed: ${passed} / ${findings.length}`,
    `- Failed: ${failed} / ${findings.length}`,
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
    '- **(A) Resend mode**: GET /api/customer-info/by-contact/:contactId returns a row',
    '  with submitted_at=null and expires_at in the future. Modal title must read',
    '  "Resend photo upload link" and the primary button must read "Resend link".',
    '- **(B) Send mode**: same endpoint returns an empty array. Modal title must read',
    '  "Send photo upload link" and the primary button must read "Send email".',
    '- **(C) Network error fallback**: endpoint throws a network error. Modal falls',
    '  back to send mode — title "Send photo upload link", button "Send email".',
    '',
    'All customers-page API calls are stubbed via evaluateOnNewDocument fetch',
    'interception so no HubSpot token or real contact data is required.',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
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

async function pollPage(page, fn, arg, timeoutMs = 12000, intervalMs = 150) {
  return pollUntil(page, fn, timeoutMs, intervalMs, arg !== undefined && arg !== null ? [arg] : []);
}

/**
 * Build a fetch-interceptor script that stubs all customers-page API calls
 * and the customer-info/by-contact endpoint.
 *
 * `byContactResponse` controls the stub:
 *   - An array → returned as JSON with status 200
 *   - The string 'network-error' → the fetch rejects with a TypeError
 */
function buildFetchInterceptScript(byContactResponse) {
  const isError = byContactResponse === 'network-error';
  const byContactJson = isError ? '[]' : JSON.stringify(byContactResponse);

  // A minimal contact to populate the customers grid.
  const contacts = [{
    id: CONTACT_ID,
    properties: {
      firstname: 'Upload',
      lastname: 'PrivTest',
      email: CONTACT_EMAIL,
      hs_lead_status: 'privtest_upm_status',
    },
  }];

  const stubs = {
    '/api/contacts-all':              JSON.stringify({ results: contacts, total: 1, totalPages: 1, page: 1 }),
    '/api/card-action-handlers':      JSON.stringify([]),
    '/api/stage-action-labels':       JSON.stringify([]),
    '/api/lead-substatuses':          JSON.stringify([]),
    '/api/lead-statuses':             JSON.stringify([]),
    '/api/workflow':                  JSON.stringify({ stages: { sales: { label: 'Sales' } } }),
    '/api/localdata/all':             JSON.stringify({}),
    '/api/contacts-lead-status-counts': JSON.stringify({}),
    '/api/contacts-substatus-counts':   JSON.stringify({}),
    '/api/page-filter-config':        JSON.stringify({ customers_page_size: 25 }),
    '/api/quickbooks/status':         JSON.stringify({ connected: false }),
  };

  return `
(function() {
  var STUBS = ${JSON.stringify(stubs)};
  var IS_ERROR = ${JSON.stringify(isError)};
  var BY_CONTACT_JSON = ${JSON.stringify(byContactJson)};
  var CONTACT_ID = ${JSON.stringify(CONTACT_ID)};

  var originalFetch = window.fetch;
  window.__upmIntercepted = [];

  window.fetch = function(input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var parts = url.startsWith('http') ? new URL(url) : null;
    var pathname = parts ? parts.pathname : url.split('?')[0];

    // POST generate-link — return a synthetic link so the modal copy field loads.
    if (
      init && init.method === 'POST' &&
      pathname.includes('/generate-link')
    ) {
      window.__upmIntercepted.push('generate-link:POST');
      return Promise.resolve(new Response(JSON.stringify({
        formLink: 'https://example.invalid/customer-info/test-token',
        token: 'test-token',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }

    // GET by-contact — returns pending rows, empty array, or a network error.
    if (
      (!init || !init.method || init.method === 'GET') &&
      pathname.includes('/by-contact/')
    ) {
      window.__upmIntercepted.push('by-contact:GET');
      if (IS_ERROR) {
        return Promise.reject(new TypeError('Network error (stubbed by test)'));
      }
      return Promise.resolve(new Response(BY_CONTACT_JSON, {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }

    // POST resend — acknowledge silently.
    if (init && init.method === 'POST' && pathname.includes('/resend')) {
      window.__upmIntercepted.push('resend:POST');
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }

    // Urgency endpoint (POST).
    if (pathname === '/api/contacts/urgency' && init && init.method === 'POST') {
      return Promise.resolve(new Response(JSON.stringify({ urgency: {} }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }

    if (STUBS[pathname] !== undefined) {
      window.__upmIntercepted.push(pathname);
      return Promise.resolve(new Response(STUBS[pathname], {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }

    window.__upmIntercepted.push('pass:' + pathname);
    return originalFetch.call(this, input, init);
  };
})();
  `.trim();
}

/**
 * Open /customers with the fetch stubs active and return the page once the
 * card grid has loaded.  `byContactResponse` is forwarded to the interceptor.
 */
async function openCustomersPage(browser, jar, byContactResponse) {
  const ctx = await (browser.createBrowserContext
    ? browser.createBrowserContext()
    : browser.createIncognitoBrowserContext());
  const page = await ctx.newPage();
  page.__ctx = ctx;
  await page.setCacheEnabled(false);

  const pageLogs = [];
  page.on('console', m => pageLogs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => pageLogs.push(`[pageerror] ${e.message}`));

  await page.evaluateOnNewDocument(buildFetchInterceptScript(byContactResponse));

  await injectSession(page, jar);
  await page.goto(`${BASE}/customers`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait for the customers grid to render at least one card.
  await pollPage(page, () => !!document.querySelector('#customers-results .MuiCard-root'), null, 20000);

  page.__logs = pageLogs;
  return page;
}

/**
 * Open the UploadPhotosModal on an already-loaded customers page by calling
 * window.dispatchCardActionHandler (registered by useCardActionHandlers).
 * Returns the page after the dialog is visible.
 */
async function openModal(page) {
  // Wait until dispatchCardActionHandler is exposed by the React island.
  await pollPage(page, () => typeof window.dispatchCardActionHandler === 'function', null, 15000);

  // Dispatch the upload_photos_and_info handler.
  await page.evaluate((contactId, contactName, contactEmail) => {
    window.dispatchCardActionHandler(
      { id: 9001, type: 'upload_photos_and_info', config: {} },
      { contactId, contactName, contactEmail },
    );
  }, CONTACT_ID, CONTACT_NAME, CONTACT_EMAIL);

  // Wait for the MUI Dialog to appear in the DOM.
  await pollPage(page, () => !!document.querySelector('[data-testid="upload-photos-dialog"]'), null, 10000);

  return page;
}

/**
 * Read the dialog title text and primary button label from the open modal.
 */
async function readModal(page) {
  return page.evaluate(() => {
    const titleEl   = document.querySelector('[data-testid="upload-photos-dialog-title"]');
    const primaryEl = document.querySelector('[data-testid="cah-primary"]');

    // The title element contains a Typography child — grab the first text node
    // (the first direct text content of the DialogTitle, not the subtitle).
    let titleText = '';
    if (titleEl) {
      for (const node of titleEl.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
          titleText = node.textContent.trim();
          break;
        }
      }
      // Fallback: first line of the full text content.
      if (!titleText) {
        titleText = (titleEl.textContent || '').trim().split('\n')[0].trim();
      }
    }

    return {
      title:   titleText,
      primary: primaryEl ? primaryEl.textContent.trim() : '',
    };
  });
}

/**
 * Close the open dialog and wait for it to disappear before the next probe.
 */
async function closeModal(page) {
  await page.evaluate(() => {
    const cancelBtn = Array.from(document.querySelectorAll('[data-testid="upload-photos-dialog"] button'))
      .find(b => b.textContent.trim() === 'Cancel');
    if (cancelBtn) cancelBtn.click();
  });
  // Wait for dialog to unmount.
  await pollPage(page, () => !document.querySelector('[data-testid="upload-photos-dialog"]'), null, 5000).catch(() => {});
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
  console.log(`\n  upload-photos-resend-mode E2E  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);
  await cleanupTestData(pool);

  const { child, logBuf } = spawnServer();
  let exited = false;
  child.on('exit', () => { exited = true; });

  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    writeReport(runId);
    process.exit(code);
  };
  process.on('SIGINT',  () => cleanupAndExit(130));
  process.on('SIGTERM', () => cleanupAndExit(130));
  process.on('uncaughtException',  e => { console.error('Uncaught:',  e); cleanupAndExit(2); });
  process.on('unhandledRejection', e => { console.error('Unhandled:', e); cleanupAndExit(2); });

  // ── Boot ──────────────────────────────────────────────────────────────────
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

  const users = await seedUsers(pool, runId);
  const memberClient = await login(users.member.email, users.member.password);
  console.log(`  Seeded users  member=${users.member.email}`);

  // ── Puppeteer ─────────────────────────────────────────────────────────────
  const PROBE_LABELS = [
    '(A) pending row → title "Resend photo upload link"',
    '(A) pending row → primary button "Resend link"',
    '(B) no pending rows → title "Send photo upload link"',
    '(B) no pending rows → primary button "Send email"',
    '(C) network error → title "Send photo upload link" (fallback)',
    '(C) network error → primary button "Send email" (fallback)',
  ];

  if (!puppeteer) {
    for (const l of PROBE_LABELS) record(l, 'puppeteer installed', 'puppeteer not installed', false);
    await cleanupAndExit(1);
    return;
  }

  const { findChromium } = require('../shared/find-chromium');
  let browser = null;
  let browserLaunchErr = null;
  const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox'];
  const launchAttempts = [{ args: launchArgs }];
  const sysChrome = findChromium();
  if (sysChrome) launchAttempts.push({ executablePath: sysChrome, args: launchArgs });
  for (const opts of launchAttempts) {
    try {
      browser = await puppeteer.launch({ headless: true, ...opts });
      browserLaunchErr = null;
      break;
    } catch (e) { browserLaunchErr = e; browser = null; }
  }

  if (!browser) {
    const msg = (browserLaunchErr?.message || String(browserLaunchErr)).slice(0, 200);
    for (const l of PROBE_LABELS) record(l, 'browser launched', `browser launch failed: ${msg}`, false);
    await cleanupAndExit(1);
    return;
  }

  try {
    // ── Probe A: pending row → resend mode ───────────────────────────────────
    console.log('\n  [A] Pending row → expect "Resend photo upload link" / "Resend link"');

    const pendingRows = [{ submitted_at: null, expires_at: FUTURE_EXPIRES }];
    const pageA = await openCustomersPage(browser, memberClient.cookie, pendingRows);
    await openModal(pageA);

    // Poll until the primary button shows the expected resend-mode label.
    await pollPage(
      pageA,
      () => {
        const btn = document.querySelector('[data-testid="cah-primary"]');
        return btn ? btn.textContent.trim() : '';
      },
      null, 8000,
    ).catch(() => {});

    const modalA = await readModal(pageA);
    record(
      PROBE_LABELS[0],
      'Resend photo upload link',
      modalA.title,
      modalA.title === 'Resend photo upload link',
    );
    record(
      PROBE_LABELS[1],
      'Resend link',
      modalA.primary,
      modalA.primary === 'Resend link',
    );

    await pageA.__ctx.close();

    // ── Probe B: no pending rows → send mode ─────────────────────────────────
    console.log('\n  [B] Empty array → expect "Send photo upload link" / "Send email"');

    const pageB = await openCustomersPage(browser, memberClient.cookie, []);
    await openModal(pageB);

    // Poll until the primary button stabilises (by-contact fetch has resolved).
    await pollPage(
      pageB,
      () => {
        const btn = document.querySelector('[data-testid="cah-primary"]');
        return btn ? btn.textContent.trim() : '';
      },
      null, 8000,
    ).catch(() => {});

    const modalB = await readModal(pageB);
    record(
      PROBE_LABELS[2],
      'Send photo upload link',
      modalB.title,
      modalB.title === 'Send photo upload link',
    );
    record(
      PROBE_LABELS[3],
      'Send email',
      modalB.primary,
      modalB.primary === 'Send email',
    );

    await pageB.__ctx.close();

    // ── Probe C: network error → fallback to send mode ───────────────────────
    console.log('\n  [C] Network error → expect fallback "Send photo upload link" / "Send email"');

    const pageC = await openCustomersPage(browser, memberClient.cookie, 'network-error');
    await openModal(pageC);

    // Network error causes the effect to resolve quickly (falls back immediately).
    // Poll until the primary button is present and stable.
    await pollPage(
      pageC,
      () => {
        const btn = document.querySelector('[data-testid="cah-primary"]');
        return btn ? btn.textContent.trim() : '';
      },
      null, 8000,
    ).catch(() => {});

    const modalC = await readModal(pageC);
    record(
      PROBE_LABELS[4],
      'Send photo upload link',
      modalC.title,
      modalC.title === 'Send photo upload link',
    );
    record(
      PROBE_LABELS[5],
      'Send email',
      modalC.primary,
      modalC.primary === 'Send email',
    );

    await pageC.__ctx.close();

  } catch (e) {
    console.error('Probe error:', e.message || e);
    for (const l of PROBE_LABELS) {
      if (!findings.find(f => f.name === l)) {
        record(l, 'probe completed', `error: ${e.message || e}`, false);
      }
    }
  } finally {
    try { await browser.close(); } catch {}
  }

  const failed = findings.filter(f => !f.ok).length;
  await cleanupAndExit(failed > 0 ? 1 : 0);
}

main();
