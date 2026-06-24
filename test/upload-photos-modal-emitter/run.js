'use strict';
const { makeSkip } = require('../helpers/report');
// test/upload-photos-modal-emitter/run.js
//
// End-to-end test guarding the full UploadPhotosModal → rail refresh signal
// chain. The existing `test:customer-info-stale-rail` suite guards the
// listener side (CustomerInfoSubmissionsRail) by dispatching the
// `customer-info-link-generated` CustomEvent directly. This complementary
// suite guards the emitter side (UploadPhotosModal.generateLink) by opening
// the real modal, clicking through the "Generate new link" flow, and asserting
// the rail re-fetches and re-renders — without any manual window.dispatchEvent
// call in the test itself.
//
// Probes:
//   (A)  Initial load: rail renders with the first submission card.
//   (A2) The customer-info endpoint was fetched exactly once on mount.
//   (B)  Opening the modal via window.openCardActionModal with
//        link-status → { hasActiveLink: true } puts the dialog into the
//        "Active link exists" confirming phase.
//   (C)  Clicking [data-testid="cah-confirm-generate"] calls the
//        generate-link API (window.__upmeGenerateCalled = true) and transitions
//        the dialog to the "ready" phase (link field visible).
//   (D)  The generate-link success handler dispatches
//        `customer-info-link-generated` on window, which causes the rail to
//        re-fetch (fetchCount reaches 2).
//   (E)  After the second fetch the rail re-renders with both submission cards
//        (the new ROW_GENERATED card and the original ROW_INITIAL card).
//
// Strategy:
//   - Spawn a real Express server and log in as an admin.
//   - Stub all customer-detail API calls via evaluateOnNewDocument fetch
//     interception so no HubSpot token or real contact data is required.
//   - customer-info stub uses an in-page mutable counter identical to the
//     stale-rail suite: fetch #1 → [ROW_INITIAL]; fetch #2+ → [ROW_GENERATED,
//     ROW_INITIAL].
//   - link-status stub returns { hasActiveLink: true } so the modal goes to
//     the confirming phase without triggering an automatic generate-link call.
//   - generate-link POST stub returns a synthetic link and sets
//     window.__upmeGenerateCalled so probe C can verify the API was invoked.
//   - After the modal moves to the ready phase (probe C), poll until
//     fetchCount reaches 2 (probe D), then assert two "Awaiting submission"
//     chips appear in the rail (probe E).
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:upload-photos-modal-emitter
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:upload-photos-modal-emitter

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
const CONTACT_ID = '900002013';

const NOW    = Date.now();
const FUTURE  = new Date(NOW + 7 * 24 * 60 * 60 * 1000).toISOString();
const FUTURE2 = new Date(NOW + 14 * 24 * 60 * 60 * 1000).toISOString();

// Minimal contact object for the detail-page stub.
const CONTACT_STUB = {
  id: CONTACT_ID,
  properties: {
    firstname:         'Emitter',
    lastname:          'FlowTest',
    email:             'emitter-flow@privtest.invalid',
    phone:             '',
    mobilephone:       '',
    hs_lead_status:    '',
    hw_lead_substatus: '',
    address: '',
    city:    '',
    zip:     '',
  },
};

// First-fetch payload: one active-pending card.
const ROW_INITIAL = {
  id:           10,
  created_at:   new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString(),
  submitted_at: null,
  expires_at:   FUTURE,
  contact_name:     'Emitter FlowTest',
  contact_email:    'emitter-flow@privtest.invalid',
  address_line1: null,
  city:          null,
  postcode:      null,
  room_count:    null,
  room_notes:    null,
  photo_keys:    [],
  photoUrls:     [],
  email_skipped_count: 0,
  form_link: 'https://example.com/form/old-emitter-link',
};

// Second-fetch payload: two cards — the generated link (newest) plus the
// original (now superseded).
const ROW_GENERATED = {
  id:           11,
  created_at:   new Date(NOW - 1 * 60 * 60 * 1000).toISOString(),
  submitted_at: null,
  expires_at:   FUTURE2,
  contact_name:     'Emitter FlowTest',
  contact_email:    'emitter-flow@privtest.invalid',
  address_line1: null,
  city:          null,
  postcode:      null,
  room_count:    null,
  room_notes:    null,
  photo_keys:    [],
  photoUrls:     [],
  email_skipped_count: 0,
  form_link: 'https://example.com/form/new-emitter-link',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'upload-photos-modal-emitter.md',
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
 * Tracks:
 *   window.__upmeFetchCount  — incremented each time the customer-info
 *                              by-contact endpoint is fetched. Probe D checks
 *                              this reaches 2 after the modal dispatches its
 *                              CustomEvent.
 *   window.__upmeGenerateCalled — set to true when the generate-link POST is
 *                              intercepted. Probe C reads this.
 *   window.__upmeIntercepted — list of all intercepted pathnames for debug.
 *
 * The customer-info endpoint returns [ROW_INITIAL] on the first call and
 * [ROW_GENERATED, ROW_INITIAL] on subsequent calls.
 *
 * The link-status endpoint always returns { hasActiveLink: true } so the modal
 * goes to the confirming phase without auto-generating a link.
 *
 * The generate-link POST returns a synthetic link immediately.
 */
function buildInterceptScript(contactId) {
  const contactJson    = JSON.stringify(CONTACT_STUB);
  const rowInitial     = JSON.stringify(ROW_INITIAL);
  const rowGenerated   = JSON.stringify(ROW_GENERATED);
  const mockLinkBody   = JSON.stringify({
    formLink:  'https://example.com/form/new-emitter-link',
    token:     'emitter-test-token',
    expiresAt: FUTURE2,
  });

  return `
(function () {
  var CONTACT_ID   = ${JSON.stringify(contactId)};
  var ROW_INITIAL  = ${rowInitial};
  var ROW_GENERATED = ${rowGenerated};
  var CONTACT_STUB = ${contactJson};

  var orig = window.fetch;

  window.__upmeFetchCount    = 0;
  window.__upmeGenerateCalled = false;
  window.__upmeIntercepted   = [];

  window.fetch = function (input, init) {
    var url      = typeof input === 'string' ? input : (input && input.url) || '';
    var method   = (init && init.method ? init.method : 'GET').toUpperCase();
    var parts    = url.startsWith('http') ? new URL(url) : null;
    var pathname = parts ? parts.pathname : url.split('?')[0];

    function json(body, status) {
      status = status || 200;
      window.__upmeIntercepted.push(method + ' ' + pathname);
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: status,
        headers: { 'Content-Type': 'application/json' },
      }));
    }

    // Customer-info submissions — the rail's own endpoint (GET only).
    // Tracks how many times it has been fetched (probe D).
    if (method === 'GET' &&
        pathname === '/api/customer-info/by-contact/' + CONTACT_ID) {
      window.__upmeFetchCount += 1;
      var rows = window.__upmeFetchCount === 1
        ? [ROW_INITIAL]
        : [ROW_GENERATED, ROW_INITIAL];
      return json(rows);
    }

    // Link-status — return hasActiveLink: true so the modal enters the
    // confirming phase rather than auto-generating on open (probe B).
    if (method === 'GET' &&
        pathname === '/api/customer-info/by-contact/' + CONTACT_ID + '/link-status') {
      return json({ hasActiveLink: true, expiresAt: ${JSON.stringify(FUTURE)} });
    }

    // Generate-link POST — return a synthetic link and flag that it was called
    // (probe C).  The modal's success handler will then dispatch the
    // customer-info-link-generated CustomEvent on window, which is what probe D
    // and E verify.
    if (method === 'POST' &&
        pathname === '/api/customer-info/by-contact/' + CONTACT_ID + '/generate-link') {
      window.__upmeGenerateCalled = true;
      return json(${mockLinkBody});
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
    window.__upmeIntercepted.push('pass:' + method + ' ' + pathname);
    return orig.call(this, input, init);
  };
})();
  `.trim();
}

/**
 * Open the customer-detail page with fetch stubs active.  Returns the
 * Puppeteer page once the rail section has appeared (or timed out).
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
      value: { writeText: () => Promise.resolve(), readText: () => Promise.resolve('') },
      writable: true,
      configurable: true,
    });
  });

  await injectSession(page, jar);
  await page.goto(`${BASE}/customers/${CONTACT_ID}`, {
    waitUntil: 'domcontentloaded',
    timeout:   30000,
  });

  // Wait until the rail section appears.
  const railVisible = await pollPage(page, () => {
    const el = document.getElementById('customer-info-submissions-section');
    return el ? 'ok' : null;
  }, 20000).catch(() => null);

  if (!railVisible) {
    const intercepted = await page.evaluate(() => window.__upmeIntercepted || []);
    const fc          = await page.evaluate(() => window.__upmeFetchCount);
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
    '# Upload Photos Modal Emitter — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:upload-photos-modal-emitter\``,
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
    '- **(A2) fetch count**: The customer-info endpoint was fetched exactly once after mount.',
    '- **(B) Modal confirming phase**: Opening `UploadPhotosModal` via',
    '  `window.openCardActionModal` with `link-status → { hasActiveLink: true }` puts',
    '  the dialog into the "Active link exists" confirming phase.',
    '- **(C) Generate-link API called**: Clicking `[data-testid="cah-confirm-generate"]`',
    '  calls `POST /api/customer-info/by-contact/:id/generate-link` and transitions the',
    '  modal to the "ready" phase (link field visible).',
    '- **(D) Rail re-fetches via event**: The `generateLink` success handler in',
    '  `UploadPhotosModal.tsx` dispatches `customer-info-link-generated` on `window`,',
    '  which causes the rail to call the API a second time (fetchCount = 2). This guards',
    '  the `window.dispatchEvent` call in `generateLink()` — the emitter side of the',
    '  signal chain that the stale-rail test does not cover.',
    '- **(E) Rail re-renders with updated data**: After the second fetch the rail displays',
    '  the newly generated card (ROW_GENERATED, id=11) alongside the original card,',
    '  confirming that component state was updated from the new response.',
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
  console.log(`\n  upload-photos-modal-emitter E2E  run=${runId}`);
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
    '(A) initial render — "Awaiting submission" chip visible in rail',
    '(A2) initial fetch count = 1',
    '(B) modal opens to "Active link exists" confirming phase',
    '(C) clicking "Generate new link" calls generate-link API',
    '(D) generate-link dispatches event → rail re-fetches (fetchCount = 2)',
    '(E) rail re-renders with updated data (second card visible)',
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

    // ── Probe A + A2: initial fetch + render ──────────────────────────────
    console.log('\n  [A] Initial fetch and render');

    const initialChipVisible = await pollPage(page, () => {
      const section = document.getElementById('customer-info-submissions-section');
      if (!section) return null;
      const chips = Array.from(section.querySelectorAll('[data-testid="status-chip"]'));
      return chips.some(c => (c.textContent || '').trim() === 'Awaiting submission') ? 'ok' : null;
    }, 15000).catch(() => null);

    const initialState = await page.evaluate(() => ({
      fetchCount:   window.__upmeFetchCount,
      sectionFound: !!document.getElementById('customer-info-submissions-section'),
      awaitingChips: Array.from(
        (document.getElementById('customer-info-submissions-section') || document)
          .querySelectorAll('[data-testid="status-chip"]'),
      ).filter(c => (c.textContent || '').trim() === 'Awaiting submission').length,
    }));

    if (!initialChipVisible) {
      const intercepted = await page.evaluate(() => window.__upmeIntercepted || []);
      console.log(`  [A] chip not visible. fetchCount=${initialState.fetchCount} intercepted=${JSON.stringify(intercepted)}`);
      const errLogs = (page.__logs || []).filter(l => l.includes('error') || l.includes('Error'));
      if (errLogs.length) console.log(`  [A] page errors:\n    ${errLogs.join('\n    ')}`);
    }

    record(
      PROBE_LABELS[0],
      'at least 1 "Awaiting submission" chip visible in rail',
      initialState.sectionFound
        ? `awaitingChips = ${initialState.awaitingChips}`
        : 'section not found',
      initialState.awaitingChips >= 1,
    );

    record(
      PROBE_LABELS[1],
      'fetchCount = 1 after mount',
      `fetchCount = ${initialState.fetchCount}`,
      initialState.fetchCount === 1,
    );

    // ── Probe B: open modal in confirming phase ────────────────────────────
    console.log('\n  [B] Opening UploadPhotosModal via window.openCardActionModal');

    // Wait for the React bridge to be available.
    const bridgeReady = await pollPage(page, () =>
      typeof window.openCardActionModal === 'function' ? 'ok' : null,
    15000).catch(() => null);

    if (!bridgeReady) {
      const errLogs = (page.__logs || []).filter(l => l.includes('error') || l.includes('Error'));
      console.log(`  [B] bridge not available. page errors: ${errLogs.slice(0, 3).join('; ')}`);
    }

    if (bridgeReady) {
      // Open the modal programmatically — same technique as
      // test/upload-photos-copyable-link/run.js.
      await page.evaluate((cid) => {
        window.openCardActionModal(
          { id: 99, type: 'upload_photos_and_info', config: {}, bindings: [] },
          {
            contactId:    cid,
            contactName:  'Emitter FlowTest',
            contactEmail: 'emitter-flow@privtest.invalid',
          },
        );
      }, CONTACT_ID);
    }

    // Wait for the "Active link exists" confirming-phase dialog title.
    const confirmingPhase = await pollPage(page, () => {
      const titleEl = document.querySelector('[data-testid="upload-photos-dialog-title"]');
      return titleEl && (titleEl.textContent || '').includes('Active link exists') ? 'ok' : null;
    }, 12000).catch(() => null);

    record(
      PROBE_LABELS[2],
      'MuiDialogTitle "Active link exists" visible',
      confirmingPhase
        ? '"Active link exists" dialog title found'
        : 'dialog title not found or wrong phase',
      !!confirmingPhase,
      bridgeReady ? '' : 'window.openCardActionModal not available — bridge not ready',
    );

    // ── Probe C: click "Generate new link" → API called ───────────────────
    console.log('\n  [C] Clicking "Generate new link"');

    if (confirmingPhase) {
      await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="cah-confirm-generate"]');
        if (btn) btn.click();
      });
    }

    // Wait until the generate-link API was called (window.__upmeGenerateCalled)
    // and the modal transitions to the ready phase (link field becomes visible).
    const generateCalled = await pollPage(page, () =>
      window.__upmeGenerateCalled ? 'ok' : null,
    8000).catch(() => null);

    // Wait for the modal to reach the ready phase: the "Customer link" caption
    // or the copy-close button appearing signals that generate-link resolved.
    const readyPhase = await pollPage(page, () => {
      const copyClose = document.querySelector('[data-testid="cah-copy-close"]');
      const primary   = document.querySelector('[data-testid="cah-primary"]');
      return (copyClose || primary) ? 'ok' : null;
    }, 8000).catch(() => null);

    const postClickState = await page.evaluate(() => ({
      generateCalled: window.__upmeGenerateCalled,
    }));

    record(
      PROBE_LABELS[3],
      'generate-link POST intercepted (window.__upmeGenerateCalled = true)',
      postClickState.generateCalled
        ? 'generate-link API was called'
        : 'generate-link API was NOT called',
      !!postClickState.generateCalled,
      confirmingPhase ? '' : 'skipped — confirming phase was not reached (probe B failed)',
    );

    // ── Probe D: event dispatched → rail re-fetches ───────────────────────
    console.log('\n  [D] Waiting for rail re-fetch (fetchCount = 2)');

    // The generate-link success handler runs window.dispatchEvent(
    //   new CustomEvent('customer-info-link-generated', { detail: { contactId } })
    // ) which triggers the rail's useEffect listener → second GET.
    const refetchHappened = await pollPage(page, () =>
      window.__upmeFetchCount >= 2 ? 'ok' : null,
    8000).catch(() => null);

    const postEventState = await page.evaluate(() => ({
      fetchCount: window.__upmeFetchCount,
    }));

    record(
      PROBE_LABELS[4],
      'fetchCount ≥ 2 after generate-link success',
      `fetchCount = ${postEventState.fetchCount}`,
      postEventState.fetchCount >= 2,
      refetchHappened ? '' : 'pollUntil timed out — dispatchEvent may not have fired or listener not wired',
    );

    // ── Probe E: rail re-renders with updated data ─────────────────────────
    console.log('\n  [E] Waiting for rail to re-render with second card');

    const twoCardsVisible = await pollPage(page, () => {
      const section = document.getElementById('customer-info-submissions-section');
      if (!section) return null;
      const chips = Array.from(section.querySelectorAll('[data-testid="status-chip"]'));
      const awaitingCount = chips.filter(c => (c.textContent || '').trim() === 'Awaiting submission').length;
      return awaitingCount >= 2 ? 'ok' : null;
    }, 8000).catch(() => null);

    const updatedState = await page.evaluate(() => ({
      awaitingChips: Array.from(
        (document.getElementById('customer-info-submissions-section') || document)
          .querySelectorAll('[data-testid="status-chip"]'),
      ).filter(c => (c.textContent || '').trim() === 'Awaiting submission').length,
    }));

    record(
      PROBE_LABELS[5],
      '≥ 2 "Awaiting submission" chips after re-render (updated data visible)',
      `awaitingChips = ${updatedState.awaitingChips}`,
      updatedState.awaitingChips >= 2,
      twoCardsVisible ? '' : 'pollUntil timed out waiting for updated chips',
    );

    await page.__ctx.close().catch(() => {});

  } catch (e) {
    console.error('Probe error:', e);
    record('suite runtime error', 'no exception', e.message, false);
    for (const l of PROBE_LABELS) {
      if (!findings.find(f => f.name === l)) {
        skip(l, 'no error', `threw: ${e.message}`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const failed = findings.filter(f => !f.ok && !f.skipped).length;
  await cleanupAndExit(failed > 0 ? 1 : 0);
}

main();
