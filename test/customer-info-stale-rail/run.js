'use strict';
const { makeSkip } = require('../helpers/report');
// test/customer-info-stale-rail/run.js
//
// End-to-end test verifying that CustomerInfoSubmissionsRail re-fetches and
// re-renders after the UploadPhotosModal dispatches the
// `customer-info-link-generated` CustomEvent (introduced in task #2010).
//
// Without the window event listener wiring the rail would remain stale after a
// new upload link is generated — this test is the regression guard for that
// signal/listener connection.
//
// Probes:
//   (A) Initial load: rail renders with the first submission record (initial
//       fetch happened and data is displayed).
//   (B) Dispatching `customer-info-link-generated` on `window` (with the
//       matching contactId) triggers a second GET to
//       /api/customer-info/by-contact/:id.
//   (C) Rail re-renders with the updated data returned by the second fetch
//       (a second submission card now appears in the section).
//   (D) Dispatching the event with a DIFFERENT contactId does NOT trigger an
//       extra fetch for this contact's rail (filter guard).
//   (E) After the re-render the submitted card body (ROW_SUBMITTED, id=3)
//       opens and shows the correct address text — catching regressions where
//       the body renders empty even though data was present in the response.
//   (F) The same expanded card body shows corrected_email and corrected_mobile
//       — catching regressions where the corrections section renders blank even
//       though corrected contact details were present in the fetch response.
//
// Strategy:
//   - Spawn a real Express server and log in as an admin.
//   - Stub all customer-detail API calls via evaluateOnNewDocument fetch
//     interception so no HubSpot token or real contact data is required.
//   - The customer-info stub uses an in-page mutable counter: fetch #1 returns
//     one active card; fetch #2 returns three cards (two pending + one
//     submitted with address data, simulating a resubmission refresh).
//   - After the rail renders the initial data (probe A), dispatch the event via
//     page.evaluate and poll for the updated data (probes B + C).
//   - Run a second dispatch with a foreign contactId and confirm the fetch
//     counter does not advance further (probe D).
//   - Click the Review button on the submitted card and assert the address text
//     is visible in the expanded body (probe E).
//   - With the body still expanded, assert that corrected_email and
//     corrected_mobile text are visible in the corrections section (probe F).
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:customer-info-stale-rail
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:customer-info-stale-rail

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

// ── Constants ─────────────────────────────────────────────────────────────────

// Must be numeric — CustomerDetailPage validates this.
const CONTACT_ID = '900002012';

const NOW    = Date.now();
const FUTURE = new Date(NOW + 7 * 24 * 60 * 60 * 1000).toISOString();
// A second expiry slightly further in the future (simulates the freshly
// generated link returned by the second fetch).
const FUTURE2 = new Date(NOW + 14 * 24 * 60 * 60 * 1000).toISOString();

// Minimal contact object for the detail-page stub.
const CONTACT_STUB = {
  id: CONTACT_ID,
  properties: {
    firstname: 'Stale',
    lastname:  'RailTest',
    email:     'stale-rail@privtest.invalid',
    phone:     '',
    mobilephone: '',
    hs_lead_status:    '',
    hw_lead_substatus: '',
    address: '',
    city:    '',
    zip:     '',
  },
};

// First-fetch payload: one active-pending card.
const ROW_INITIAL = {
  id:           1,
  created_at:   new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString(),
  submitted_at: null,
  expires_at:   FUTURE,
  contact_name:     'Stale RailTest',
  contact_email:    'stale-rail@privtest.invalid',
  corrected_email:  null,
  corrected_mobile: null,
  address_line1: null,
  city:          null,
  postcode:      null,
  room_count:    null,
  room_notes:    null,
  photo_keys:    [],
  photoUrls:     [],
  email_skipped_count: 0,
  form_link: 'https://example.com/form/old-link',
};

// Second-fetch payload: two cards — the original (now superseded by the newer
// expiry date) plus a brand-new active card representing the generated link.
const ROW_GENERATED = {
  id:           2,
  created_at:   new Date(NOW - 1 * 60 * 60 * 1000).toISOString(), // 1 hour ago
  submitted_at: null,
  expires_at:   FUTURE2,
  contact_name:     'Stale RailTest',
  contact_email:    'stale-rail@privtest.invalid',
  corrected_email:  null,
  corrected_mobile: null,
  address_line1: null,
  city:          null,
  postcode:      null,
  room_count:    null,
  room_notes:    null,
  photo_keys:    [],
  photoUrls:     [],
  email_skipped_count: 0,
  form_link: 'https://example.com/form/new-link',
};

// Third row included in the second-fetch payload: a submitted card with address,
// room data, AND corrected contact details populated.  Probe E opens this card's
// body and asserts the address text is rendered.  Probe F (added here) asserts
// that corrected_email and corrected_mobile also appear in the expanded body,
// catching regressions where the corrections section renders blank even though
// data was present in the fetch response.
const ROW_SUBMITTED = {
  id:           3,
  created_at:   new Date(NOW - 5 * 24 * 60 * 60 * 1000).toISOString(),
  submitted_at: new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString(),
  expires_at:   FUTURE,
  contact_name:     'Stale RailTest',
  contact_email:    'stale-rail@privtest.invalid',
  corrected_email:  'corrected@example.com',
  corrected_mobile: '07700900123',
  address_line1: '42 Resubmit Lane',
  city:          'Testville',
  postcode:      'TV1 2AB',
  room_count:    2,
  room_notes:    'Two rooms updated',
  photo_keys:    [],
  photoUrls:     [],
  email_skipped_count: 0,
  form_link: 'https://example.com/form/submitted-link',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'customer-info-stale-rail.md',
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

async function pollPage(page, fn, timeoutMs = 12000, intervalMs = 150) {
  return pollUntil(page, fn, timeoutMs, intervalMs, []);
}

/**
 * Build the fetch-interceptor script injected via evaluateOnNewDocument.
 *
 * window.__cisrFetchCount tracks how many times the customer-info endpoint
 * has been fetched so probes can assert re-fetch behaviour without relying on
 * timing.  The first call returns [ROW_INITIAL] alone; every subsequent call
 * returns [ROW_GENERATED, ROW_INITIAL, ROW_SUBMITTED] — newest pending cards
 * first, then the submitted card with address/room data (as the real endpoint
 * sorts active-then-submitted).  ROW_SUBMITTED is the anchor for probe E.
 */
function buildInterceptScript(contactId) {
  const contactJson   = JSON.stringify(CONTACT_STUB);
  const rowInitial    = JSON.stringify(ROW_INITIAL);
  const rowGenerated  = JSON.stringify(ROW_GENERATED);
  const rowSubmitted  = JSON.stringify(ROW_SUBMITTED);

  return `
(function () {
  var CONTACT_ID    = ${JSON.stringify(contactId)};
  var ROW_INITIAL   = ${rowInitial};
  var ROW_GENERATED = ${rowGenerated};
  var ROW_SUBMITTED = ${rowSubmitted};
  var CONTACT_STUB  = ${contactJson};

  var orig = window.fetch;

  window.__cisrFetchCount = 0;
  window.__cisrIntercepted = [];

  window.fetch = function (input, init) {
    var url      = typeof input === 'string' ? input : (input && input.url) || '';
    var parts    = url.startsWith('http') ? new URL(url) : null;
    var pathname = parts ? parts.pathname : url.split('?')[0];

    function json(body, status) {
      status = status || 200;
      window.__cisrIntercepted.push(pathname);
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: status,
        headers: { 'Content-Type': 'application/json' },
      }));
    }

    // Customer-info submissions — the rail's own endpoint.
    // Tracks how many times it has been called so probe B can verify a
    // second fetch is triggered by the CustomEvent.
    // The second fetch also includes ROW_SUBMITTED (a completed card with
    // address data) so probe E can open its body and verify content renders.
    if (pathname === '/api/customer-info/by-contact/' + CONTACT_ID) {
      window.__cisrFetchCount += 1;
      var rows = window.__cisrFetchCount === 1
        ? [ROW_INITIAL]
        : [ROW_GENERATED, ROW_INITIAL, ROW_SUBMITTED];
      return json(rows);
    }

    // Link-status endpoint (used by the modal — pass through to server).
    if (pathname === '/api/customer-info/by-contact/' + CONTACT_ID + '/link-status') {
      return json({ hasActiveLink: false });
    }

    // Contact fetch.
    if (pathname === '/api/contacts/' + CONTACT_ID) {
      return json(CONTACT_STUB);
    }

    // Contact localdata.
    if (pathname === '/api/contacts/' + CONTACT_ID + '/localdata') {
      return json({});
    }

    // Contact tasks.
    if (pathname === '/api/contacts/' + CONTACT_ID + '/tasks') {
      return json({ results: [] });
    }

    // Lead statuses + substatuses.
    if (pathname === '/api/lead-statuses')    return json([]);
    if (pathname === '/api/lead-substatuses') return json([]);

    // Workflow.
    if (pathname === '/api/workflow') return json({ stages: {} });

    // Design visits.
    if (pathname.startsWith('/api/design-visits')) return json([]);

    // Room-assignment visits.
    if (pathname.startsWith('/api/visits')) return json([]);

    // WhatsApp.
    if (pathname.startsWith('/api/whatsapp')) return json([]);

    // Google / Gmail / Calendar.
    if (pathname.startsWith('/api/emails'))   return json([]);
    if (pathname.startsWith('/api/google'))   return json({ connected: false });
    if (pathname.startsWith('/api/calendar')) return json({ connected: false, events: [] });

    // QuickBooks — not connected.
    if (pathname.startsWith('/api/quickbooks/status')) return json({ connected: false });
    if (pathname.startsWith('/api/quickbooks'))        return json({ invoices: [] });

    // SSE (EventSource) and auth — pass through.
    if (pathname.startsWith('/api/hubspot/webhook-events')) {
      return orig.call(this, input, init);
    }
    if (pathname === '/api/auth/user') {
      return orig.call(this, input, init);
    }

    // Catch-all pass-through.
    window.__cisrIntercepted.push('pass:' + pathname);
    return orig.call(this, input, init);
  };
})();
  `.trim();
}

/**
 * Open the customer-detail page with fetch stubs active. Returns the Puppeteer
 * page once the rail section has appeared (or timed out).
 */
async function openDetailPage(browser, jar) {
  const ctx = await (browser.createBrowserContext
    ? browser.createBrowserContext()
    : browser.createIncognitoBrowserContext());
  const page = await ctx.newPage();
  page.__ctx = ctx;
  await page.setCacheEnabled(false);

  const pageLogs = [];
  page.on('console', m => pageLogs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => pageLogs.push(`[pageerror] ${e.message}`));

  await page.evaluateOnNewDocument(buildInterceptScript(CONTACT_ID));

  // Harden clipboard so clipboard API calls in the rail don't throw.
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.resolve() },
      writable: true,
      configurable: true,
    });
  });

  await injectSession(page, jar);
  await page.goto(`${BASE}/customers/${CONTACT_ID}`, {
    waitUntil: 'domcontentloaded',
    timeout:   30000,
  });

  // Wait until the rail section appears.  With our fixture it must render
  // (the initial row is active, so the rail is not null).
  const railVisible = await pollPage(page, () => {
    const el = document.getElementById('customer-info-submissions-section');
    return el ? 'ok' : null;
  }, 20000).catch(() => null);

  if (!railVisible) {
    const intercepted = await page.evaluate(() => window.__cisrIntercepted || []);
    const fc          = await page.evaluate(() => window.__cisrFetchCount);
    console.log(`  [setup] rail did not appear. fetchCount=${fc} intercepted=${JSON.stringify(intercepted)}`);
    const errLogs = pageLogs.filter(l => l.includes('error') || l.includes('Error'));
    if (errLogs.length) console.log(`  [setup] page errors:\n    ${errLogs.join('\n    ')}`);
  }

  page.__logs = pageLogs;
  return page;
}

// ── Report ────────────────────────────────────────────────────────────────────

function writeReport(runId) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc  = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok && !f.skipped).length;
  const skipped = findings.filter(f => f.skipped).length;
  const lines = [
    '# Customer Info Stale Rail — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:customer-info-stale-rail\``,
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
    '- **(A) Initial fetch + render**: The rail calls `/api/customer-info/by-contact/:id`',
    '  on mount and displays the initial active-pending submission card.',
    '- **(B) Re-fetch on event**: Dispatching `customer-info-link-generated` on `window`',
    '  (with the matching contactId) causes the rail to call the API a second time.',
    '  This guards the `window.addEventListener` wiring added in task #2010.',
    '- **(C) Re-render with updated data**: After the second fetch the rail displays',
    '  the newly generated card (ROW_GENERATED, `id=2`) alongside the original card,',
    '  confirming that the component state was updated from the new response.',
    '- **(D) Foreign contactId ignored**: Dispatching the event with a different',
    '  contactId does not trigger an additional fetch for this contact\'s rail,',
    '  confirming the `detail.contactId === contactId` guard is in place.',
    '- **(E) Submitted card body renders address after re-render**: The second fetch',
    '  also returns ROW_SUBMITTED (`id=3`) — a completed card with address, room data,',
    '  and corrected contact details. After the re-render the "Review" button is clicked',
    '  to open the card body and the address text ("42 Resubmit Lane") is asserted to',
    '  be visible. This catches regressions where the card body renders empty despite',
    '  data being present in the fetch response.',
    '- **(F) Corrected contact details visible in expanded card body**: With the card body',
    '  already expanded from probe E, both `corrected_email` ("corrected@example.com")',
    '  and `corrected_mobile` ("07700900123") are asserted to be visible. This catches',
    '  regressions where the corrections section renders blank even though corrected',
    '  contact details were present in the fetch response.',
    '',
    'All API calls are stubbed via evaluateOnNewDocument fetch interception.',
    'No HubSpot token or real contact data is required.',
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

  const runId = Math.random().toString(36).slice(2, 8);
  console.log(`\n  customer-info-stale-rail E2E  run=${runId}`);
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
  console.log(`  Seeded users  admin=${users.admin.email}`);

  const adminClient = await login(users.admin.email, users.admin.password);

  // ── Puppeteer ─────────────────────────────────────────────────────────────
  const PROBE_LABELS = [
    '(A) initial fetch happened (fetchCount = 1)',
    '(A) rail renders initial submission card',
    '(B) dispatching customer-info-link-generated triggers a second fetch',
    '(C) rail re-renders with updated data (second card visible)',
    '(D) foreign contactId dispatch does not trigger extra fetch',
    '(E) submitted card body shows updated address after re-render',
    '(F) submitted card body shows corrected email and mobile',
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
    // ── Open the customer-detail page ─────────────────────────────────────
    console.log('\n  [A] Opening customer-detail page and waiting for rail');
    const page = await openDetailPage(browser, adminClient.cookie);

    // ── Probe A: initial fetch + render ───────────────────────────────────
    console.log('\n  [A] Initial fetch and render');

    // Wait for at least one "Awaiting submission" chip to appear in the rail
    // (confirms the first fetch resolved and React rendered the card).
    const initialChipVisible = await pollPage(page, () => {
      const section = document.getElementById('customer-info-submissions-section');
      if (!section) return null;
      const chips = Array.from(section.querySelectorAll('[class*="MuiChip-label"]'));
      return chips.some(c => (c.textContent || '').trim() === 'Awaiting submission') ? 'ok' : null;
    }, 15000).catch(() => null);

    const initialState = await page.evaluate(() => ({
      fetchCount:   window.__cisrFetchCount,
      sectionFound: !!document.getElementById('customer-info-submissions-section'),
      awaitingChips: Array.from(
        (document.getElementById('customer-info-submissions-section') || document)
          .querySelectorAll('[class*="MuiChip-label"]'),
      ).filter(c => (c.textContent || '').trim() === 'Awaiting submission').length,
    }));

    if (!initialChipVisible) {
      const intercepted = await page.evaluate(() => window.__cisrIntercepted || []);
      console.log(`  [A] chip not visible. fetchCount=${initialState.fetchCount} intercepted=${JSON.stringify(intercepted)}`);
      const errLogs = (page.__logs || []).filter(l => l.includes('error') || l.includes('Error'));
      if (errLogs.length) console.log(`  [A] page errors:\n    ${errLogs.join('\n    ')}`);
    }

    record(
      PROBE_LABELS[0],
      'fetchCount = 1 after mount',
      `fetchCount = ${initialState.fetchCount}`,
      initialState.fetchCount === 1,
    );

    record(
      PROBE_LABELS[1],
      'at least 1 "Awaiting submission" chip visible in rail',
      initialState.sectionFound
        ? `awaitingChips = ${initialState.awaitingChips}`
        : 'section not found',
      initialState.awaitingChips >= 1,
    );

    // ── Probe B: event triggers re-fetch ──────────────────────────────────
    console.log('\n  [B+C] Dispatching customer-info-link-generated and waiting for re-render');

    // React's useEffect (which registers the event listener) is scheduled to
    // run after the browser has painted (after requestAnimationFrame).  Wait
    // for two rAF cycles to guarantee the listener is registered before we
    // dispatch.  This is more reliable than a fixed setTimeout in headless
    // Chromium where paint timing is non-deterministic.
    await page.evaluate(() => new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));

    // Dispatch the event from within the page — this is exactly what
    // UploadPhotosModal does after a successful generate-link call.
    await page.evaluate((contactId) => {
      window.dispatchEvent(
        new CustomEvent('customer-info-link-generated', { detail: { contactId } }),
      );
    }, CONTACT_ID);

    // Poll until the fetch count reaches 2 (re-fetch triggered) or 8 s elapse.
    const refetchHappened = await pollPage(page, () => {
      return window.__cisrFetchCount >= 2 ? 'ok' : null;
    }, 8000).catch(() => null);

    const postEventState = await page.evaluate(() => ({
      fetchCount:   window.__cisrFetchCount,
      awaitingChips: Array.from(
        (document.getElementById('customer-info-submissions-section') || document)
          .querySelectorAll('[class*="MuiChip-label"]'),
      ).filter(c => (c.textContent || '').trim() === 'Awaiting submission').length,
    }));

    record(
      PROBE_LABELS[2],
      'fetchCount ≥ 2 after event dispatch',
      `fetchCount = ${postEventState.fetchCount}`,
      postEventState.fetchCount >= 2,
      refetchHappened ? '' : 'pollUntil timed out waiting for second fetch',
    );

    // ── Probe C: rail re-renders with updated data ─────────────────────────
    // The second fetch returns [ROW_GENERATED, ROW_INITIAL, ROW_SUBMITTED] —
    // two active-pending cards + one submitted card.  Poll until 2 "Awaiting
    // submission" chips appear (the pending cards); ROW_SUBMITTED is submitted
    // so it carries a different chip and is the target of probe E, not here.
    const twoCardsVisible = await pollPage(page, () => {
      const section = document.getElementById('customer-info-submissions-section');
      if (!section) return null;
      const chips = Array.from(section.querySelectorAll('[class*="MuiChip-label"]'));
      const awaitingCount = chips.filter(c => (c.textContent || '').trim() === 'Awaiting submission').length;
      return awaitingCount >= 2 ? 'ok' : null;
    }, 8000).catch(() => null);

    const updatedState = await page.evaluate(() => ({
      awaitingChips: Array.from(
        (document.getElementById('customer-info-submissions-section') || document)
          .querySelectorAll('[class*="MuiChip-label"]'),
      ).filter(c => (c.textContent || '').trim() === 'Awaiting submission').length,
    }));

    record(
      PROBE_LABELS[3],
      '≥ 2 "Awaiting submission" chips after re-render (updated data visible)',
      `awaitingChips = ${updatedState.awaitingChips}`,
      updatedState.awaitingChips >= 2,
      twoCardsVisible ? '' : 'pollUntil timed out waiting for updated chips',
    );

    // ── Probe D: foreign contactId does not trigger extra fetch ───────────
    console.log('\n  [D] Dispatching event with foreign contactId');

    const fetchCountBeforeD = await page.evaluate(() => window.__cisrFetchCount);

    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('customer-info-link-generated', {
          detail: { contactId: '999999999' },
        }),
      );
    });

    // Give React a moment to process (150 ms) — if the guard is absent a
    // fetch would fire almost immediately.
    await new Promise(r => setTimeout(r, 400));

    const fetchCountAfterD = await page.evaluate(() => window.__cisrFetchCount);

    record(
      PROBE_LABELS[4],
      `fetchCount unchanged (= ${fetchCountBeforeD}) after foreign-contactId event`,
      `fetchCount = ${fetchCountAfterD}`,
      fetchCountAfterD === fetchCountBeforeD,
    );

    // ── Probe E: submitted card body shows updated address after re-render ─
    // After the re-fetch the rail includes ROW_SUBMITTED (id=3) — a completed
    // card with address_line1="42 Resubmit Lane", city="Testville".  We click
    // the "Review" button (data-testid="review-btn") inside
    // [data-testid="submission-card-3"] to expand the body, then poll for the
    // address text.  A regression would show an empty body even though the
    // data was present in the fetch response.
    console.log('\n  [E] Opening submitted card body and checking address text');

    const submittedCardSelector = '[data-testid="submission-card-3"]';

    // Wait for the submitted card to appear in the DOM (it was part of the
    // second-fetch response so it should already be rendered after probe C).
    const submittedCardFound = await pollPage(page, () => {
      return document.querySelector('[data-testid="submission-card-3"]') ? 'ok' : null;
    }, 6000).catch(() => null);

    if (submittedCardFound) {
      // Click the Review button to open the card body.
      await page.click(`${submittedCardSelector} [data-testid="review-btn"]`).catch(() => {
        // Fallback: click the card header itself (the clickable summary area).
        return page.click(submittedCardSelector);
      });
    }

    // Poll for the address text within the card body, requiring the matching
    // text node to be *visually expanded* (height > 0).  MUI Collapse keeps
    // children in the DOM even when closed (height: 0; overflow: hidden), so
    // a plain textContent check could pass even if the body never opened.
    // We use TreeWalker to find the deepest text node that contains the address
    // string, then check its parent element's bounding box height as a proxy
    // for "rendered and visible in the expanded body".
    const addressVisible = await pollPage(page, () => {
      const card = document.querySelector('[data-testid="submission-card-3"]');
      if (!card) return null;
      const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT, null);
      let node;
      while ((node = walker.nextNode())) {
        if ((node.nodeValue || '').includes('42 Resubmit Lane')) {
          const el = node.parentElement;
          if (el && el.getBoundingClientRect().height > 0) return 'ok';
        }
      }
      return null;
    }, 8000).catch(() => null);

    const probeEState = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="submission-card-3"]');
      if (!card) return { cardFound: false, cardText: '', bodyHeight: 0 };
      // Measure the height of the MUI Collapse wrapper (first child of the card
      // accordion detail area) as a signal of whether the body is expanded.
      const collapseRoot = card.querySelector('[class*="MuiCollapse-root"]');
      const bodyHeight = collapseRoot ? collapseRoot.getBoundingClientRect().height : -1;
      return {
        cardFound:  true,
        cardText:   (card.textContent || '').slice(0, 300),
        bodyHeight,
      };
    });

    if (!addressVisible) {
      console.log(
        `  [E] address not visibly expanded. cardFound=${probeEState.cardFound}`
        + ` bodyHeight=${probeEState.bodyHeight}`
        + ` cardText="${probeEState.cardText}"`,
      );
    }

    record(
      PROBE_LABELS[5],
      'address "42 Resubmit Lane" visible in expanded submission-card-3 body',
      probeEState.cardFound
        ? (addressVisible
          ? 'address text found in expanded body'
          : `bodyHeight=${probeEState.bodyHeight} text="${probeEState.cardText}"`)
        : 'submission-card-3 not found in DOM',
      !!addressVisible,
      submittedCardFound ? '' : 'submission-card-3 did not appear after re-fetch',
    );

    // ── Probe F: corrected email and mobile appear in the card body ────────
    // ROW_SUBMITTED now carries corrected_email="corrected@example.com" and
    // corrected_mobile="07700900123".  The card body is already expanded from
    // probe E, so we can poll immediately for those text values.  A regression
    // would show an empty corrections section even though the values were
    // present in the fetch response.
    console.log('\n  [F] Checking corrected email and mobile in expanded card body');

    const correctedEmailVisible = await pollPage(page, () => {
      const card = document.querySelector('[data-testid="submission-card-3"]');
      if (!card) return null;
      const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT, null);
      let node;
      while ((node = walker.nextNode())) {
        if ((node.nodeValue || '').includes('corrected@example.com')) {
          const el = node.parentElement;
          if (el && el.getBoundingClientRect().height > 0) return 'ok';
        }
      }
      return null;
    }, 6000).catch(() => null);

    const correctedMobileVisible = await pollPage(page, () => {
      const card = document.querySelector('[data-testid="submission-card-3"]');
      if (!card) return null;
      const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT, null);
      let node;
      while ((node = walker.nextNode())) {
        if ((node.nodeValue || '').includes('07700900123')) {
          const el = node.parentElement;
          if (el && el.getBoundingClientRect().height > 0) return 'ok';
        }
      }
      return null;
    }, 6000).catch(() => null);

    const probeFState = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="submission-card-3"]');
      if (!card) return { cardFound: false, cardText: '' };
      return { cardFound: true, cardText: (card.textContent || '').slice(0, 500) };
    });

    if (!correctedEmailVisible || !correctedMobileVisible) {
      console.log(
        `  [F] corrections not visibly expanded.`
        + ` emailOk=${!!correctedEmailVisible} mobileOk=${!!correctedMobileVisible}`
        + ` cardText="${probeFState.cardText}"`,
      );
    }

    const bothCorrectionsVisible = !!correctedEmailVisible && !!correctedMobileVisible;
    record(
      PROBE_LABELS[6],
      'corrected email "corrected@example.com" and mobile "07700900123" visible in expanded card body',
      probeFState.cardFound
        ? (bothCorrectionsVisible
          ? 'both corrections visible in expanded body'
          : `emailOk=${!!correctedEmailVisible} mobileOk=${!!correctedMobileVisible} text="${probeFState.cardText}"`)
        : 'submission-card-3 not found in DOM',
      bothCorrectionsVisible,
      submittedCardFound ? '' : 'submission-card-3 did not appear after re-fetch',
    );

    await page.__ctx.close().catch(() => {});

  } catch (e) {
    console.error('Probe error:', e);
    for (const l of PROBE_LABELS) {
      if (!findings.find(f => f.name === l)) {
        record(l, 'no error', `threw: ${e.message}`, false);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const failed = findings.filter(f => !f.ok && !f.skipped).length;
  await cleanupAndExit(failed > 0 ? 1 : 0);
}

main();
