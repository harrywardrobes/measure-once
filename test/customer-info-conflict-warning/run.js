'use strict';
const { makeSkip } = require('../helpers/report');
// test/customer-info-conflict-warning/run.js
//
// End-to-end test verifying the active-link conflict warning in the
// CustomerInfoSubmissionsRail component on the customer-detail page.
//
// When a staff member clicks "Copy link" on an active submission card the
// component fetches /api/customer-info/by-contact/:id/link-status and
// compares the returned expiresAt with the card's own expires_at.  If they
// differ by more than 2 seconds a conflict Alert is shown.
//
// Probes:
//   (A)  Link-status returns the SAME expiresAt as the displayed card →
//        no conflict Alert, clipboard is written immediately.
//   (B)  Link-status returns a DIFFERENT expiresAt →
//        the conflict Alert appears (data-testid="conflict-proceed-btn" visible).
//   (B2) Clicking "Copy anyway" dismisses the Alert.
//   (B3) Clicking "Cancel" dismisses the Alert without copying.
//   (A-open)         Same expiresAt, open-link button → provisional window
//                    navigated to form_link, no conflict Alert.
//   (B-open)         Different expiresAt, open-link → conflict Alert, provisional
//                    window closed.
//   (B2-open)        "Open anyway" dismisses Alert and calls window.open(formLink).
//   (B3-open)        "Cancel" dismisses Alert without an extra window.open call.
//   (A-open-blocked) window.open returns null on first call (popup blocked),
//                    same expiresAt → no conflict Alert, fallback window.open
//                    called with form_link URL.
//
// Strategy:
//   - Spawn a real Express server and log in as a member.
//   - Insert a real customer_info_submissions row so the rail renders an
//     active card with a known expires_at.
//   - Use Puppeteer request interception (network level) to:
//       • Stub HubSpot-backed and other external API calls so the page loads
//         without credentials.
//       • Return probe-specific responses for the link-status endpoint.
//   - Mock navigator.clipboard via evaluateOnNewDocument so clipboard writes
//     succeed silently in headless Chromium.
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:customer-info-conflict-warning
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:customer-info-conflict-warning

const crypto = require('crypto');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
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

// ── Constants ─────────────────────────────────────────────────────────────────

// Must be numeric — CustomerDetailPage rejects non-numeric IDs.
const CONTACT_ID   = '900001992';
const CONTACT_EMAIL = 'conflict-test@privtest.invalid';

// A future expires_at so the submission card is "active" (not expired).
const CARD_EXPIRES_AT = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

// A different expires_at — more than 2 seconds away — triggers the conflict.
const CONFLICT_EXPIRES_AT = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString();

// ── Report ────────────────────────────────────────────────────────────────────

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'customer-info-conflict-warning.md',
);

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
const skip = makeSkip(findings);

function writeReport(runId) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok && !f.skipped).length;
  const skipped = findings.filter(f => f.skipped).length;
  const lines = [
    '# Customer-Info Conflict Warning — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:customer-info-conflict-warning\``,
    '',
    '## Summary',
    '',
    `- Passed: ${passed} / ${findings.length}`,
    `- Skipped: ${skipped} / ${findings.length}`,
    `- Failed: ${failed} / ${findings.length}`,
    '',
    '## Results',
    '',
    '| Result | Probe | Expected | Observed |',
    '|---|---|---|---|',
    ...findings.map(f =>
      `| ${f.ok ? 'PASS' : f.skipped ? 'SKIP' : 'FAIL'} | ${esc(f.name)} | ${esc(f.expected)} | ${esc(f.observed)} |`,
    ),
    '',
    '## Coverage',
    '',
    '### Copy-link path',
    '- **(A) No conflict when link matches**: When /api/customer-info/by-contact/:id/link-status',
    '  returns the same expiresAt as the active submission card, clicking "Copy link" writes',
    '  to the clipboard immediately and the conflict Alert does NOT appear.',
    '- **(B) Conflict Alert appears**: When link-status returns a DIFFERENT expiresAt the',
    '  conflict Alert (data-testid="conflict-proceed-btn") becomes visible after clicking',
    '  "Copy link". Confirms the warning guards stale-link sharing.',
    '- **(B2) Copy anyway dismisses Alert**: Clicking data-testid="conflict-proceed-btn"',
    '  executes the copy and hides the Alert.',
    '- **(B3) Cancel dismisses without action**: Clicking data-testid="conflict-cancel-btn"',
    '  hides the Alert without writing a new entry to the clipboard. Alert text is verified',
    '  to contain "A newer link has already been sent for this contact" before clicking Cancel.',
    '',
    '### Open-link path',
    '- **(A-open) No conflict when link matches**: When link-status returns the same',
    '  expiresAt, clicking "Open link" opens a provisional blank window and navigates',
    '  it to form_link — no conflict Alert appears.',
    '- **(B-open) Conflict Alert appears**: When link-status returns a DIFFERENT expiresAt',
    '  the provisional blank window is closed and the conflict Alert becomes visible. Alert text',
    '  is verified to contain "A newer link has already been sent for this contact".',
    '- **(B2-open) Open anyway dismisses Alert**: Clicking data-testid="conflict-proceed-btn"',
    '  hides the Alert and calls window.open with the form_link URL.',
    '- **(B3-open) Cancel dismisses without action**: Clicking data-testid="conflict-cancel-btn"',
    '  hides the Alert without making any additional window.open call. Alert text is verified',
    '  to contain "A newer link has already been sent for this contact" before clicking Cancel.',
    '',
    '### Open-link path — popup-blocked fallback',
    '- **(A-open-blocked) No conflict Alert when popup is blocked**: When window.open returns null',
    '  on the first call (popup blocked) and link-status returns the same expiresAt, no conflict',
    '  Alert appears — the fallback path in checkThenAct is taken instead.',
    '- **(A-open-blocked) Fallback window.open called with form_link URL**: After the no-conflict',
    '  check completes, a second window.open call is made with the form_link URL so the user',
    '  still gets the link even though the provisional window was blocked.',
    '',
    'Uses a real customer_info_submissions row inserted into the test DB so the',
    'rail renders an authentic active card with a known expires_at.  Only the',
    'link-status endpoint and HubSpot-backed routes are stubbed via Puppeteer',
    'request interception — no external credentials required.',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

async function waitForTable(pool, tableName, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = $1 LIMIT 1`,
      [tableName],
    );
    if (r.rowCount) return;
    await new Promise(res => setTimeout(res, 200));
  }
  throw new Error(`Table ${tableName} did not appear within ${timeoutMs}ms`);
}

/**
 * Insert one active customer_info_submissions row with a known expires_at.
 * Returns the form_link URL that the rail will display on the card.
 */
async function insertSubmissionRow(pool, contactId, contactEmail, expiresAt) {
  const rawToken  = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const baseUrl   = BASE.replace(/\/$/, '');
  const formLink  = `${baseUrl}/customer-info/${encodeURIComponent(rawToken)}`;

  await pool.query(
    `INSERT INTO customer_info_submissions
       (contact_id, contact_name, contact_email, token_hash, expires_at,
        masked_email, masked_phone, form_link)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      contactId,
      'Conflict Test',
      contactEmail,
      tokenHash,
      expiresAt,
      'c***@privtest.invalid',
      null,
      formLink,
    ],
  );

  return formLink;
}

async function cleanupSubmissions(pool, contactId) {
  try {
    await pool.query(
      `DELETE FROM customer_info_submissions WHERE contact_id = $1`,
      [contactId],
    );
  } catch {}
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

async function pollPage(page, fn, timeoutMs = 15000, intervalMs = 200) {
  return pollUntil(page, fn, timeoutMs, intervalMs);
}

/**
 * Build a request-interception handler for a given probe.
 *
 * linkStatusBody – the JSON object returned for the link-status endpoint.
 * contactId      – the numeric contact ID string.
 */
function makeRequestHandler(contactId, linkStatusBody) {
  const linkStatusJson = JSON.stringify(linkStatusBody);

  // Responses for external / HubSpot-backed APIs that the customer-detail
  // page fetches on mount.  Providing stubs here avoids errors when no
  // HubSpot token is configured in the test environment.
  const STUBS = {
    '/api/workflow':          JSON.stringify({ stages: { sales: { label: 'Sales' } } }),
    '/api/lead-statuses':     JSON.stringify([]),
    '/api/lead-substatuses':  JSON.stringify([]),
    '/api/design-visits':     JSON.stringify([]),
    '/api/visits':            JSON.stringify([]),
    '/api/emails':            JSON.stringify({ connected: false }),
    '/api/calendar/upcoming': JSON.stringify({ connected: false, events: [] }),
    '/api/quickbooks/status': JSON.stringify({ connected: false }),
  };

  return function handleRequest(req) {
    const url  = req.url();
    let parts;
    try { parts = new URL(url); } catch { return req.continue(); }
    const pathname = parts.pathname;

    // ── Link-status — probe-specific ─────────────────────────────────────
    const linkStatusRe = new RegExp(
      `^/api/customer-info/by-contact/${contactId}/link-status`,
    );
    if (linkStatusRe.test(pathname)) {
      return req.respond({
        status:      200,
        contentType: 'application/json',
        body:        linkStatusJson,
      });
    }

    // ── Contacts — stub a minimal valid contact record ────────────────────
    const contactRe = new RegExp(`^/api/contacts/${contactId}(?:/|$)`);
    if (contactRe.test(pathname)) {
      // Localdata and tasks sub-routes return empty.
      if (pathname.includes('/localdata') || pathname.includes('/tasks')) {
        return req.respond({
          status:      200,
          contentType: 'application/json',
          body:        JSON.stringify([]),
        });
      }
      return req.respond({
        status:      200,
        contentType: 'application/json',
        body:        JSON.stringify({
          id: contactId,
          properties: {
            firstname:        'Conflict',
            lastname:         'Test',
            email:            CONTACT_EMAIL,
            hs_lead_status:   null,
            hw_lead_substatus: null,
            createdate:       new Date().toISOString(),
            lastmodifieddate: new Date().toISOString(),
            phone:            null,
            mobilephone:      null,
            company:          null,
          },
        }),
      });
    }

    // ── WhatsApp ──────────────────────────────────────────────────────────
    if (pathname.startsWith('/api/whatsapp/')) {
      return req.respond({
        status:      200,
        contentType: 'application/json',
        body:        JSON.stringify({ enabled: false, messages: [] }),
      });
    }

    // ── Simple JSON stubs ─────────────────────────────────────────────────
    const stubBody = STUBS[pathname];
    if (stubBody !== undefined) {
      return req.respond({
        status:      200,
        contentType: 'application/json',
        body:        stubBody,
      });
    }

    // Pass everything else through (auth, session, customer-info rails, etc.)
    req.continue();
  };
}

/**
 * Open /customers/:contactId with request interception active.
 * Returns a Puppeteer page once the active submission card's copy button is
 * present and clickable.
 *
 * options.popupBlockFirstCall – when true, window.open returns null on the
 *   first call to simulate a browser popup blocker, then behaves normally for
 *   subsequent calls (covers the fallback branch in checkThenAct).
 */
async function openCustomerDetail(browser, cookie, contactId, linkStatusBody, options = {}) {
  const ctx = await (browser.createBrowserContext
    ? browser.createBrowserContext()
    : browser.createIncognitoBrowserContext());
  const page = await ctx.newPage();
  page.__ctx = ctx;
  await page.setCacheEnabled(false);

  const pageLogs = [];
  page.on('console', m => pageLogs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => pageLogs.push(`[pageerror] ${e.message}`));

  // Mock navigator.clipboard so writes succeed silently in headless Chromium.
  // Mock window.open so the "open link" path doesn't open real tabs.
  if (options.popupBlockFirstCall) {
    // First call returns null (popup blocked); subsequent calls return a real
    // mock window object so the fallback window.open can be verified.
    await page.evaluateOnNewDocument(() => {
      window.__clipboardWrites = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        get() {
          return {
            writeText(text) {
              window.__clipboardWrites.push(text);
              return Promise.resolve();
            },
          };
        },
      });
      window.__windowOpenCalls = [];
      window.__windowOpenResults = [];
      var __openCallCount = 0;
      window.open = function(url, target, features) {
        window.__windowOpenCalls.push({ url, target, features });
        __openCallCount++;
        if (__openCallCount === 1) {
          // Simulate popup blocked — return null, no result object.
          window.__windowOpenResults.push(null);
          return null;
        }
        var _href = url || '';
        var _closed = false;
        var loc = {};
        Object.defineProperty(loc, 'href', {
          get: function() { return _href; },
          set: function(v) { _href = v; },
          enumerable: true,
          configurable: true,
        });
        var win = {
          location: loc,
          get closed() { return _closed; },
          close: function() { _closed = true; },
          getHref: function() { return _href; },
          isClosed: function() { return _closed; },
        };
        window.__windowOpenResults.push(win);
        return win;
      };
    });
  } else {
    await page.evaluateOnNewDocument(() => {
      window.__clipboardWrites = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        get() {
          return {
            writeText(text) {
              window.__clipboardWrites.push(text);
              return Promise.resolve();
            },
          };
        },
      });
      window.__windowOpenCalls = [];
      window.__windowOpenResults = [];
      window.open = function(url, target, features) {
        window.__windowOpenCalls.push({ url, target, features });
        // Track location.href mutations and close() calls so open-link probes
        // can verify the provisional-window lifecycle.
        var _href = url || '';
        var _closed = false;
        var loc = {};
        Object.defineProperty(loc, 'href', {
          get: function() { return _href; },
          set: function(v) { _href = v; },
          enumerable: true,
          configurable: true,
        });
        var win = {
          location: loc,
          get closed() { return _closed; },
          close: function() { _closed = true; },
          getHref: function() { return _href; },
          isClosed: function() { return _closed; },
        };
        window.__windowOpenResults.push(win);
        return win;
      };
    });
  }

  // Network-level interception — reliable across React bundle changes.
  await page.setRequestInterception(true);
  page.on('request', makeRequestHandler(contactId, linkStatusBody));

  await injectSession(page, cookie);
  await page.goto(`${BASE}/customers/${contactId}`, {
    waitUntil: 'domcontentloaded',
    timeout:   30000,
  });

  // Wait for the CustomerInfoSubmissionsRail section to appear.
  await pollPage(page, () =>
    document.getElementById('customer-info-submissions-section') ? 'ok' : null,
    20000,
  );

  // Wait for the copy button (active submission card rendered).
  await pollPage(page, () =>
    document.querySelector('[data-testid="copy-link-btn"]') ? 'ok' : null,
    10000,
  );

  page.__logs = pageLogs;
  return page;
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
  console.log(`\n  customer-info-conflict-warning E2E  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const mailFile = path.join(os.tmpdir(), `ci-conflict-${runId}.jsonl`);
  process.env.MAIL_TRANSPORT_FILE_OVERRIDE = mailFile;

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);
  await cleanupTestData(pool);
  await cleanupSubmissions(pool, CONTACT_ID);

  const { child, logBuf } = spawnServer();
  let exited = false;
  child.on('exit', () => { exited = true; });

  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try { await cleanupSubmissions(pool, CONTACT_ID); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    writeReport(runId);
    process.exit(code);
  };
  process.on('SIGINT',  () => cleanupAndExit(130));
  process.on('SIGTERM', () => cleanupAndExit(130));
  process.on('uncaughtException',  e => { console.error('Uncaught:',  e); cleanupAndExit(2); });
  process.on('unhandledRejection', e => { console.error('Unhandled:', e); cleanupAndExit(2); });

  // ── Boot ────────────────────────────────────────────────────────────────────
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
  console.log(`  Seeded users  member=${users.member.email}`);

  await waitForTable(pool, 'customer_info_submissions');

  // Insert a real submission row so the rail shows an active card.
  const formLink = await insertSubmissionRow(
    pool, CONTACT_ID, CONTACT_EMAIL, CARD_EXPIRES_AT,
  );
  console.log(`  Inserted active submission for contactId=${CONTACT_ID}`);
  console.log(`  card expires_at: ${CARD_EXPIRES_AT}`);
  console.log(`  conflict expires_at: ${CONFLICT_EXPIRES_AT}`);

  const memberClient = await login(users.member.email, users.member.password);

  const PROBE_LABELS = [
    '(A) no conflict when link-status expiresAt matches card',
    '(A) clipboard written immediately (no Alert)',
    '(B) conflict Alert appears when expiresAt differs',
    '(B2) clicking "Copy anyway" dismisses the Alert',
    '(B3) clicking "Cancel" dismisses the Alert without copying',
    '(A-open) no conflict Alert when open-link expiresAt matches',
    '(A-open) provisional window navigated to form_link URL',
    '(B-open) conflict Alert appears and provisional window is closed',
    '(B2-open) clicking "Open anyway" dismisses Alert and opens URL',
    '(B3-open) clicking "Cancel" dismisses Alert without extra open call',
    '(A-open-blocked) no conflict Alert when popup is blocked',
    '(A-open-blocked) fallback window.open called with form_link URL',
    '(B) conflict Alert text correct',
    '(B-open) conflict Alert text correct',
    '(B3) conflict Alert text correct',
    '(B3-open) conflict Alert text correct',
  ];

  if (!puppeteer) {
    for (const l of PROBE_LABELS) skip(l, 'puppeteer installed', 'puppeteer not installed');
    await cleanupAndExit(1);
    return;
  }

  const { findChromium } = require('../shared/find-chromium');
  let browser = null;
  let browserLaunchErr = null;
  const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
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
    for (const l of PROBE_LABELS) skip(l, 'browser launched', `browser launch failed: ${msg}`);
    await cleanupAndExit(1);
    return;
  }

  try {
    // ── Probe A: no conflict (expiresAt matches) ───────────────────────────
    console.log('\n  [A] No-conflict probe');
    const pageA = await openCustomerDetail(
      browser,
      memberClient.cookie,
      CONTACT_ID,
      { hasActiveLink: true, expiresAt: CARD_EXPIRES_AT },   // same → no conflict
    );

    // Click "Copy link".
    await pageA.click('[data-testid="copy-link-btn"]');

    // Conflict Alert must NOT appear within 4 s.
    const conflictAppearedA = await pollPage(pageA, () =>
      document.querySelector('[data-testid="conflict-proceed-btn"]') ? 'yes' : null,
      4000,
    );

    record(
      PROBE_LABELS[0],
      'conflict Alert absent',
      conflictAppearedA ? 'conflict Alert appeared unexpectedly' : 'no conflict Alert (correct)',
      !conflictAppearedA,
    );

    // Clipboard spy must have been called with the form link.
    const clipboardA = await pageA.evaluate(() => window.__clipboardWrites || []);
    record(
      PROBE_LABELS[1],
      `clipboard written with "${formLink}"`,
      clipboardA.length ? `clipboard[0]="${clipboardA[0]}"` : 'clipboard not written',
      clipboardA.length > 0 && clipboardA[0] === formLink,
    );

    if (!conflictAppearedA && clipboardA.length === 0) {
      // Print diagnostics to help debug if both A probes fail.
      const logs = (pageA.__logs || []).filter(l =>
        l.toLowerCase().includes('error') || l.includes('[pageerror]'),
      );
      if (logs.length) console.log(`  [A] page errors:\n    ${logs.join('\n    ')}`);
    }

    await pageA.__ctx.close().catch(() => {});

    // ── Probe B: conflict (different expiresAt) ────────────────────────────
    console.log('\n  [B] Conflict-warning probe');
    const pageB = await openCustomerDetail(
      browser,
      memberClient.cookie,
      CONTACT_ID,
      { hasActiveLink: true, expiresAt: CONFLICT_EXPIRES_AT },  // different → conflict!
    );

    // Click "Copy link".
    await pageB.click('[data-testid="copy-link-btn"]');

    // Poll for the conflict Alert to appear.
    const conflictBtn = await pollPage(pageB, () => {
      const el = document.querySelector('[data-testid="conflict-proceed-btn"]');
      return el && el.offsetParent !== null ? 'ok' : null;
    }, 8000);

    record(
      PROBE_LABELS[2],
      'conflict-proceed-btn visible',
      conflictBtn ? 'conflict-proceed-btn visible (correct)' : 'conflict-proceed-btn not found/hidden',
      !!conflictBtn,
    );

    if (conflictBtn) {
      // ── Probe B-text: conflict Alert contains expected message ────────────
      const alertText = await pageB.evaluate(() => {
        const el = document.querySelector('[data-testid="conflict-alert"]');
        return el ? el.textContent || '' : '';
      });

      const expectedFragment = 'A newer link has already been sent for this contact';
      const alertTextOk = alertText.includes(expectedFragment);
      record(
        PROBE_LABELS[12],
        'conflict Alert contains expected message text',
        alertTextOk
          ? `Alert text correct (found "${expectedFragment}")`
          : `Alert text wrong — got: "${alertText.slice(0, 120)}"`,
        alertTextOk,
      );

      // ── Probe B2: "Copy anyway" dismisses Alert ──────────────────────────
      console.log('\n  [B2] Copy-anyway probe');
      await pageB.click('[data-testid="conflict-proceed-btn"]');

      const alertGoneB2 = await pollPage(pageB, () => {
        const el = document.querySelector('[data-testid="conflict-proceed-btn"]');
        return (!el || el.offsetParent === null) ? 'gone' : null;
      }, 5000);

      record(
        PROBE_LABELS[3],
        'conflict Alert dismissed after "Copy anyway"',
        alertGoneB2 ? 'Alert dismissed (correct)' : 'Alert still visible',
        !!alertGoneB2,
      );
    } else {
      skip(PROBE_LABELS[3], 'probe B must pass first', 'skipped — probe B failed');
      skip(PROBE_LABELS[12], 'probe B must pass first', 'skipped — probe B failed');
    }

    await pageB.__ctx.close().catch(() => {});

    // ── Probe B3: "Cancel" dismisses Alert without copying ─────────────────
    console.log('\n  [B3] Cancel probe');
    const pageB3 = await openCustomerDetail(
      browser,
      memberClient.cookie,
      CONTACT_ID,
      { hasActiveLink: true, expiresAt: CONFLICT_EXPIRES_AT },
    );

    await pageB3.click('[data-testid="copy-link-btn"]');

    const conflictForCancel = await pollPage(pageB3, () => {
      const el = document.querySelector('[data-testid="conflict-proceed-btn"]');
      return el && el.offsetParent !== null ? 'ok' : null;
    }, 8000);

    if (conflictForCancel) {
      // ── Probe B3-text: conflict Alert contains expected message ───────────
      const alertTextB3 = await pageB3.evaluate(() => {
        const el = document.querySelector('[data-testid="conflict-alert"]');
        return el ? el.textContent || '' : '';
      });

      const expectedFragmentB3 = 'A newer link has already been sent for this contact';
      const alertTextB3Ok = alertTextB3.includes(expectedFragmentB3);
      record(
        PROBE_LABELS[14],
        'conflict Alert contains expected message text',
        alertTextB3Ok
          ? `Alert text correct (found "${expectedFragmentB3}")`
          : `Alert text wrong — got: "${alertTextB3.slice(0, 120)}"`,
        alertTextB3Ok,
      );

      const clipBeforeCancel = await pageB3.evaluate(() =>
        (window.__clipboardWrites || []).length,
      );

      await pageB3.click('[data-testid="conflict-cancel-btn"]');

      const alertGoneB3 = await pollPage(pageB3, () => {
        const el = document.querySelector('[data-testid="conflict-proceed-btn"]');
        return (!el || el.offsetParent === null) ? 'gone' : null;
      }, 5000);

      const clipAfterCancel = await pageB3.evaluate(() =>
        (window.__clipboardWrites || []).length,
      );

      const noExtraWrite = clipAfterCancel === clipBeforeCancel;
      record(
        PROBE_LABELS[4],
        'Alert dismissed, no new clipboard write',
        alertGoneB3
          ? `dismissed=${!!alertGoneB3} noExtraWrite=${noExtraWrite} (before=${clipBeforeCancel} after=${clipAfterCancel})`
          : 'Alert was not dismissed',
        !!alertGoneB3 && noExtraWrite,
      );
    } else {
      record(
        PROBE_LABELS[4],
        'conflict Alert must appear first',
        'skipped — conflict Alert did not appear for probe B3',
        false,
      );
      record(
        PROBE_LABELS[14],
        'conflict Alert must appear first',
        'skipped — conflict Alert did not appear for probe B3',
        false,
      );
    }

    await pageB3.__ctx.close().catch(() => {});

    // ── Probe A-open: no conflict (expiresAt matches), open link path ─────────
    console.log('\n  [A-open] No-conflict open-link probe');
    const pageAOpen = await openCustomerDetail(
      browser,
      memberClient.cookie,
      CONTACT_ID,
      { hasActiveLink: true, expiresAt: CARD_EXPIRES_AT },   // same → no conflict
    );

    // Wait for the open-link button to confirm it is rendered.
    await pollPage(pageAOpen, () =>
      document.querySelector('[data-testid="open-link-btn"]') ? 'ok' : null,
      5000,
    );

    await pageAOpen.click('[data-testid="open-link-btn"]');

    // Conflict Alert must NOT appear within 4 s.
    const conflictAppearedAOpen = await pollPage(pageAOpen, () =>
      document.querySelector('[data-testid="conflict-proceed-btn"]') ? 'yes' : null,
      4000,
    );

    record(
      PROBE_LABELS[5],
      'conflict Alert absent',
      conflictAppearedAOpen ? 'conflict Alert appeared unexpectedly' : 'no conflict Alert (correct)',
      !conflictAppearedAOpen,
    );

    // Provisional window's location.href must have been navigated to formLink.
    const openResultHrefAOpen = await pageAOpen.evaluate(() => {
      const r = window.__windowOpenResults && window.__windowOpenResults[0];
      return r ? r.getHref() : null;
    });
    const openCallsAOpen = await pageAOpen.evaluate(() =>
      (window.__windowOpenCalls || []).map(c => c.url),
    );

    record(
      PROBE_LABELS[6],
      `provisional window navigated to "${formLink}"`,
      openResultHrefAOpen != null
        ? `location.href="${openResultHrefAOpen}" calls=[${openCallsAOpen.join(',')}]`
        : `no result object (calls=[${openCallsAOpen.join(',')}])`,
      openResultHrefAOpen === formLink,
    );

    await pageAOpen.__ctx.close().catch(() => {});

    // ── Probe B-open: conflict (different expiresAt), open link path ──────────
    console.log('\n  [B-open] Conflict open-link probe');
    const pageBOpen = await openCustomerDetail(
      browser,
      memberClient.cookie,
      CONTACT_ID,
      { hasActiveLink: true, expiresAt: CONFLICT_EXPIRES_AT },  // different → conflict!
    );

    await pollPage(pageBOpen, () =>
      document.querySelector('[data-testid="open-link-btn"]') ? 'ok' : null,
      5000,
    );

    await pageBOpen.click('[data-testid="open-link-btn"]');

    // Poll for the conflict Alert to appear.
    const conflictBtnBOpen = await pollPage(pageBOpen, () => {
      const el = document.querySelector('[data-testid="conflict-proceed-btn"]');
      return el && el.offsetParent !== null ? 'ok' : null;
    }, 8000);

    // Also verify the provisional window was closed.
    const provisionalClosedBOpen = await pageBOpen.evaluate(() => {
      const r = window.__windowOpenResults && window.__windowOpenResults[0];
      return r ? r.isClosed() : null;
    });

    record(
      PROBE_LABELS[7],
      'conflict-proceed-btn visible and provisional window closed',
      conflictBtnBOpen
        ? `conflict-proceed-btn visible, provisionalClosed=${provisionalClosedBOpen}`
        : 'conflict-proceed-btn not found/hidden',
      !!conflictBtnBOpen && provisionalClosedBOpen === true,
    );

    if (conflictBtnBOpen) {
      // ── Probe B-open-text: conflict Alert contains expected message ───────
      const alertTextBOpen = await pageBOpen.evaluate(() => {
        const el = document.querySelector('[data-testid="conflict-alert"]');
        return el ? el.textContent || '' : '';
      });

      const expectedFragmentBOpen = 'A newer link has already been sent for this contact';
      const alertTextBOpenOk = alertTextBOpen.includes(expectedFragmentBOpen);
      record(
        PROBE_LABELS[13],
        'conflict Alert contains expected message text',
        alertTextBOpenOk
          ? `Alert text correct (found "${expectedFragmentBOpen}")`
          : `Alert text wrong — got: "${alertTextBOpen.slice(0, 120)}"`,
        alertTextBOpenOk,
      );

      // ── Probe B2-open: "Open anyway" dismisses Alert and calls window.open ──
      console.log('\n  [B2-open] Open-anyway probe');
      const openCallsBeforeB2Open = await pageBOpen.evaluate(() =>
        (window.__windowOpenCalls || []).length,
      );

      await pageBOpen.click('[data-testid="conflict-proceed-btn"]');

      const alertGoneB2Open = await pollPage(pageBOpen, () => {
        const el = document.querySelector('[data-testid="conflict-proceed-btn"]');
        return (!el || el.offsetParent === null) ? 'gone' : null;
      }, 5000);

      // performAction('open') calls window.open(formLink, ...) directly.
      const openCallsAfterB2Open = await pageBOpen.evaluate(() =>
        (window.__windowOpenCalls || []).map(c => c.url),
      );
      const extraOpenUrl = openCallsAfterB2Open[openCallsBeforeB2Open] || null;

      record(
        PROBE_LABELS[8],
        `Alert dismissed and window.open("${formLink}") called`,
        alertGoneB2Open
          ? `dismissed=${!!alertGoneB2Open} extraOpenUrl="${extraOpenUrl}"`
          : 'Alert still visible',
        !!alertGoneB2Open && extraOpenUrl === formLink,
      );
    } else {
      skip(PROBE_LABELS[8], 'probe B-open must pass first', 'skipped — probe B-open failed');
      skip(PROBE_LABELS[13], 'probe B-open must pass first', 'skipped — probe B-open failed');
    }

    await pageBOpen.__ctx.close().catch(() => {});

    // ── Probe B3-open: "Cancel" dismisses Alert, no extra window.open ─────────
    console.log('\n  [B3-open] Cancel open-link probe');
    const pageB3Open = await openCustomerDetail(
      browser,
      memberClient.cookie,
      CONTACT_ID,
      { hasActiveLink: true, expiresAt: CONFLICT_EXPIRES_AT },
    );

    await pollPage(pageB3Open, () =>
      document.querySelector('[data-testid="open-link-btn"]') ? 'ok' : null,
      5000,
    );

    await pageB3Open.click('[data-testid="open-link-btn"]');

    const conflictForCancelOpen = await pollPage(pageB3Open, () => {
      const el = document.querySelector('[data-testid="conflict-proceed-btn"]');
      return el && el.offsetParent !== null ? 'ok' : null;
    }, 8000);

    if (conflictForCancelOpen) {
      // ── Probe B3-open-text: conflict Alert contains expected message ───────
      const alertTextB3Open = await pageB3Open.evaluate(() => {
        const el = document.querySelector('[data-testid="conflict-alert"]');
        return el ? el.textContent || '' : '';
      });

      const expectedFragmentB3Open = 'A newer link has already been sent for this contact';
      const alertTextB3OpenOk = alertTextB3Open.includes(expectedFragmentB3Open);
      record(
        PROBE_LABELS[15],
        'conflict Alert contains expected message text',
        alertTextB3OpenOk
          ? `Alert text correct (found "${expectedFragmentB3Open}")`
          : `Alert text wrong — got: "${alertTextB3Open.slice(0, 120)}"`,
        alertTextB3OpenOk,
      );

      const openCallsBeforeCancel = await pageB3Open.evaluate(() =>
        (window.__windowOpenCalls || []).length,
      );

      await pageB3Open.click('[data-testid="conflict-cancel-btn"]');

      const alertGoneB3Open = await pollPage(pageB3Open, () => {
        const el = document.querySelector('[data-testid="conflict-proceed-btn"]');
        return (!el || el.offsetParent === null) ? 'gone' : null;
      }, 5000);

      const openCallsAfterCancel = await pageB3Open.evaluate(() =>
        (window.__windowOpenCalls || []).length,
      );

      const noExtraOpenCall = openCallsAfterCancel === openCallsBeforeCancel;
      record(
        PROBE_LABELS[9],
        'Alert dismissed, no new window.open call',
        alertGoneB3Open
          ? `dismissed=${!!alertGoneB3Open} noExtraOpenCall=${noExtraOpenCall} (before=${openCallsBeforeCancel} after=${openCallsAfterCancel})`
          : 'Alert was not dismissed',
        !!alertGoneB3Open && noExtraOpenCall,
      );
    } else {
      record(
        PROBE_LABELS[9],
        'conflict Alert must appear first',
        'skipped — conflict Alert did not appear for probe B3-open',
        false,
      );
      record(
        PROBE_LABELS[15],
        'conflict Alert must appear first',
        'skipped — conflict Alert did not appear for probe B3-open',
        false,
      );
    }

    await pageB3Open.__ctx.close().catch(() => {});

    // ── Probe A-open-blocked: popup blocked on first call, no conflict ─────────
    console.log('\n  [A-open-blocked] Popup-blocked fallback probe');
    const pageAOpenBlocked = await openCustomerDetail(
      browser,
      memberClient.cookie,
      CONTACT_ID,
      { hasActiveLink: true, expiresAt: CARD_EXPIRES_AT },   // same → no conflict
      { popupBlockFirstCall: true },
    );

    await pollPage(pageAOpenBlocked, () =>
      document.querySelector('[data-testid="open-link-btn"]') ? 'ok' : null,
      5000,
    );

    await pageAOpenBlocked.click('[data-testid="open-link-btn"]');

    // Conflict Alert must NOT appear within 4 s.
    const conflictAppearedAOpenBlocked = await pollPage(pageAOpenBlocked, () =>
      document.querySelector('[data-testid="conflict-proceed-btn"]') ? 'yes' : null,
      4000,
    );

    record(
      PROBE_LABELS[10],
      'conflict Alert absent',
      conflictAppearedAOpenBlocked
        ? 'conflict Alert appeared unexpectedly'
        : 'no conflict Alert (correct)',
      !conflictAppearedAOpenBlocked,
    );

    // The component must have made two window.open calls total:
    //   call[0] — the provisional blank window (returned null, popup blocked)
    //   call[1] — the fallback call once no-conflict is confirmed
    // We assert that call[1] URL equals formLink.
    const openCallsAOpenBlocked = await pollPage(pageAOpenBlocked, () => {
      const calls = window.__windowOpenCalls || [];
      return calls.length >= 2 ? JSON.stringify(calls.map(c => c.url)) : null;
    }, 6000);

    let fallbackUrl = null;
    if (openCallsAOpenBlocked) {
      try {
        const urls = JSON.parse(openCallsAOpenBlocked);
        fallbackUrl = urls[1] || null;
      } catch {}
    }

    record(
      PROBE_LABELS[11],
      `fallback window.open called with "${formLink}"`,
      openCallsAOpenBlocked
        ? `calls=${openCallsAOpenBlocked} fallbackUrl="${fallbackUrl}"`
        : 'second window.open call never made',
      fallbackUrl === formLink,
    );

    await pageAOpenBlocked.__ctx.close().catch(() => {});

  } catch (e) {
    console.error('\n  Test crashed:', e);
    console.error('  Server log (last 2000 chars):');
    console.error(logBuf.join('').slice(-2000));
  } finally {
    try { await browser.close(); } catch {}
  }

  const failed = findings.filter(f => !f.ok && !f.skipped).length;
  console.log(`\n  Results: ${findings.length - failed} / ${findings.length} passed`);
  await cleanupAndExit(failed === 0 ? 0 : 1);
}

main();
