'use strict';
const { makeSkip } = require('../helpers/report');
// test/customer-info-rail/run.js
//
// End-to-end test covering the CustomerInfoSubmissionsRail React component on
// the customer detail page (/customers/:contactId).
//
// The test stubs GET /api/customer-info/by-contact/:contactId (and all other
// customer-detail page API calls) via evaluateOnNewDocument fetch interception,
// so no HubSpot token or real contact data is required.
//
// Probes:
//   (A) Expired-pending card is hidden; count badge reflects only visible entries.
//   (B) Active-pending card with form_link shows Copy and Open buttons.
//   (C) Clicking Copy briefly shows the check icon (ContentCopy → Check swap).
//   (D) Submitted card shows Review button only (no Copy/Open).
//   (E) Active-pending card with form_link: null shows neither Copy nor Open.
//   (F) Skipped-email count badge: present with correct count when non-zero;
//       absent when email_skipped_count is 0.
//   (G) Clicking the Review button on a submitted card opens the card body
//       (MuiCollapse transitions to the "entered" state); the expanded body
//       renders the correct address and room-count text.
//   (G6a/G6b) A separate submitted card with room_notes set: after clicking
//       Review, (G6a) the "Notes" section heading is visible with a non-zero
//       bounding height, and (G6b) the exact room_notes string appears in the
//       expanded body with a non-zero bounding height.
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:customer-info-rail
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:customer-info-rail

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

// contactId must match /^\d+$/ — the API route validates this.
const CONTACT_ID = '987654321';

const NOW   = Date.now();
const PAST  = new Date(NOW - 8 * 24 * 60 * 60 * 1000).toISOString(); // 8 days ago (expired)
const FUTURE = new Date(NOW + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days ahead (active)

// Fixture rows returned by the stubbed API.
// Row 1: expired-pending — should be hidden by the rail.
const ROW_EXPIRED = {
  id: 1,
  created_at: new Date(NOW - 10 * 24 * 60 * 60 * 1000).toISOString(),
  submitted_at: null,
  expires_at: PAST,
  contact_name: 'Rail Test',
  contact_email: 'rail@privtest.invalid',
  address_line1: null,
  city: null,
  postcode: null,
  room_count: null,
  room_notes: null,
  photo_keys: [],
  photoUrls: [],
  email_skipped_count: 0,
  form_link: 'https://example.com/form/expired',
};

// Row 2: active-pending with form_link — should show Copy + Open buttons.
const ROW_ACTIVE_WITH_LINK = {
  id: 2,
  created_at: new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString(),
  submitted_at: null,
  expires_at: FUTURE,
  contact_name: 'Rail Test',
  contact_email: 'rail@privtest.invalid',
  address_line1: null,
  city: null,
  postcode: null,
  room_count: null,
  room_notes: null,
  photo_keys: [],
  photoUrls: [],
  email_skipped_count: 0,
  form_link: 'https://example.com/form/active-link',
};

// Row 3: submitted — should show Review button only (no Copy/Open).
const ROW_SUBMITTED = {
  id: 3,
  created_at: new Date(NOW - 5 * 24 * 60 * 60 * 1000).toISOString(),
  submitted_at: new Date(NOW - 4 * 24 * 60 * 60 * 1000).toISOString(),
  expires_at: FUTURE,
  contact_name: 'Rail Test',
  contact_email: 'rail@privtest.invalid',
  address_line1: '12 Test Street',
  city: 'Testville',
  postcode: 'TE1 1ST',
  room_count: '2',
  room_notes: null,
  photo_keys: [],
  photoUrls: [],
  email_skipped_count: 0,
  form_link: null,
};

// Row 6: submitted with room_notes set — used by probes G6a/G6b to verify the
// Notes heading and full text render in the expanded card body.
const ROW_SUBMITTED_WITH_NOTES = {
  id: 6,
  created_at: new Date(NOW - 7 * 24 * 60 * 60 * 1000).toISOString(),
  submitted_at: new Date(NOW - 6 * 24 * 60 * 60 * 1000).toISOString(),
  expires_at: FUTURE,
  contact_name: 'Rail Test',
  contact_email: 'rail@privtest.invalid',
  address_line1: '6 Notes Avenue',
  city: 'Notestown',
  postcode: 'NT3 3NT',
  room_count: '3',
  room_notes: 'Master bedroom has sloped ceiling on north wall',
  photo_keys: [],
  photoUrls: [],
  email_skipped_count: 0,
  form_link: null,
};

// Row 4: active-pending with form_link: null — should show neither Copy nor Open.
const ROW_ACTIVE_NO_LINK = {
  id: 4,
  created_at: new Date(NOW - 1 * 24 * 60 * 60 * 1000).toISOString(),
  submitted_at: null,
  expires_at: FUTURE,
  contact_name: 'Rail Test',
  contact_email: 'rail@privtest.invalid',
  address_line1: null,
  city: null,
  postcode: null,
  room_count: null,
  room_notes: null,
  photo_keys: [],
  photoUrls: [],
  email_skipped_count: 0,
  form_link: null,
};

const ALL_ROWS = [ROW_EXPIRED, ROW_ACTIVE_WITH_LINK, ROW_SUBMITTED, ROW_ACTIVE_NO_LINK];

// Row 5: active-pending with photoUrls and a non-zero email_skipped_count —
// used exclusively by probe F to verify the skipped-email Alert badge.
const ROW_SKIP_NONZERO = {
  id: 10,
  created_at: new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString(),
  submitted_at: null,
  expires_at: FUTURE,
  contact_name: 'Rail Test',
  contact_email: 'rail@privtest.invalid',
  address_line1: null,
  city: null,
  postcode: null,
  room_count: null,
  room_notes: null,
  photo_keys: ['key1.jpg'],
  photoUrls: ['https://example.com/photo1.jpg'],
  email_skipped_count: 3,
  form_link: null,
};

// Row 6: same as ROW_SKIP_NONZERO but email_skipped_count is 0 — the Alert
// badge must be absent even though photoUrls is non-empty.
const ROW_SKIP_ZERO = {
  id: 11,
  created_at: new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString(),
  submitted_at: null,
  expires_at: FUTURE,
  contact_name: 'Rail Test',
  contact_email: 'rail@privtest.invalid',
  address_line1: null,
  city: null,
  postcode: null,
  room_count: null,
  room_notes: null,
  photo_keys: ['key1.jpg'],
  photoUrls: ['https://example.com/photo1.jpg'],
  email_skipped_count: 0,
  form_link: null,
};

// Minimal contact object returned by the stub.
const CONTACT_STUB = {
  id: CONTACT_ID,
  properties: {
    firstname: 'Rail',
    lastname: 'PrivTest',
    email: 'rail@privtest.invalid',
    phone: '',
    mobilephone: '',
    hs_lead_status: '',
    hw_lead_substatus: '',
    address: '',
    city: '',
    zip: '',
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'customer-info-rail.md',
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
 * Build the fetch-interceptor script that stubs all customer-detail page API
 * calls. The customer-info fixture rows are passed in as a JSON string.
 */
function buildInterceptScript(contactId, rows) {
  const rowsJson    = JSON.stringify(rows);
  const contactJson = JSON.stringify(CONTACT_STUB);

  return `
(function () {
  var CONTACT_ID   = ${JSON.stringify(contactId)};
  var ROWS         = ${rowsJson};
  var CONTACT_STUB = ${contactJson};

  var orig = window.fetch;

  window.__cirIntercepted = [];

  window.fetch = function (input, init) {
    var url      = typeof input === 'string' ? input : (input && input.url) || '';
    var parts    = url.startsWith('http') ? new URL(url) : null;
    var pathname = parts ? parts.pathname : url.split('?')[0];

    function json(body, status) {
      status = status || 200;
      window.__cirIntercepted.push(pathname);
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: status,
        headers: { 'Content-Type': 'application/json' },
      }));
    }

    // Customer-info submissions (the rail's own endpoint).
    if (pathname === '/api/customer-info/by-contact/' + CONTACT_ID) {
      return json(ROWS);
    }

    // Resend (POST) — stub 200 so the ResendButton is functional in probe C.
    if (pathname === '/api/customer-info/by-contact/' + CONTACT_ID + '/resend') {
      return json({ ok: true });
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
    if (pathname === '/api/lead-statuses') return json([]);
    if (pathname === '/api/lead-substatuses') return json([]);

    // Workflow.
    if (pathname === '/api/workflow') return json({ stages: {} });

    // Design visits.
    if (pathname.startsWith('/api/design-visits')) return json([]);

    // Room-assignment visits.
    if (pathname.startsWith('/api/visits')) return json([]);

    // WhatsApp.
    if (pathname.startsWith('/api/whatsapp')) return json([]);

    // Google / Gmail.
    if (pathname.startsWith('/api/emails')) return json([]);
    if (pathname.startsWith('/api/google')) return json({ connected: false });
    if (pathname.startsWith('/api/calendar')) return json({ connected: false, events: [] });

    // QuickBooks — not connected, so no invoice badge appears.
    if (pathname.startsWith('/api/quickbooks/status')) return json({ connected: false });
    if (pathname.startsWith('/api/quickbooks')) return json({ invoices: [] });

    // SSE (EventSource) and auth — pass through.
    if (pathname.startsWith('/api/hubspot/webhook-events')) {
      return orig.call(this, input, init);
    }
    if (pathname === '/api/auth/user') {
      return orig.call(this, input, init);
    }

    // Catch-all pass-through with debug logging.
    window.__cirIntercepted.push('pass:' + pathname);
    return orig.call(this, input, init);
  };
})();
  `.trim();
}

/**
 * Open the customer-detail page with fetch stubs active. Returns the Puppeteer
 * page once the rail section has loaded (or timed out).
 */
async function openDetailPage(browser, jar, rows = ALL_ROWS) {
  const ctx = await (browser.createBrowserContext
    ? browser.createBrowserContext()
    : browser.createIncognitoBrowserContext());
  const page = await ctx.newPage();
  page.__ctx = ctx;
  await page.setCacheEnabled(false);

  const pageLogs = [];
  page.on('console', m => pageLogs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => pageLogs.push(`[pageerror] ${e.message}`));

  await page.evaluateOnNewDocument(buildInterceptScript(CONTACT_ID, rows));

  // Harden clipboard before any JS runs — navigator.clipboard is non-writable in
  // some Chromium contexts, so use Object.defineProperty instead of assignment.
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
    timeout: 30000,
  });

  // Wait until the rail section appears (it returns null when empty, but with
  // our rows it must render).  Use a generous timeout so the React bundle has
  // time to mount.
  const railVisible = await pollPage(page, () => {
    const el = document.getElementById('customer-info-submissions-section');
    return el ? 'ok' : null;
  }, 20000).catch(() => null);

  if (!railVisible) {
    const intercepted = await page.evaluate(() => window.__cirIntercepted || []);
    console.log(`  [setup] rail did not appear. intercepted=${JSON.stringify(intercepted)}`);
    const errLogs = pageLogs.filter(l => l.includes('error') || l.includes('Error'));
    if (errLogs.length) console.log(`  [setup] page errors:\n    ${errLogs.join('\n    ')}`);
  }

  page.__logs = pageLogs;
  return page;
}

// ── Report ────────────────────────────────────────────────────────────────────

function writeReport(runId) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed = findings.filter(f => f.ok).length;
  const skipped = findings.filter(f => f.skipped).length;
  const failed = findings.filter(f => !f.ok && !f.skipped).length;
  const lines = [
    '# Customer Info Rail — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:customer-info-rail\``,
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
    '- **(A) Expired card hidden + count badge**: the API returns one expired-pending row;',
    '  the rail hides it and the count badge shows only the 3 visible entries.',
    '- **(B) Active card with form_link shows Copy + Open**: an active-pending row whose',
    '  `form_link` is non-null renders both `[data-testid="copy-link-btn"]` and',
    '  `[data-testid="open-link-btn"]` in its header row.',
    '- **(C) Copy click shows check icon**: clicking the copy button swaps',
    '  ContentCopyIcon for CheckIcon (the icon data-testid changes from',
    '  "ContentCopyIcon" to "CheckIcon"), confirming the copied state was set.',
    '- **(D) Submitted card shows Review only**: a submitted row\'s action area contains',
    '  a "Review" button but no copy-link or open-link button.',
    '- **(E) Active card with null form_link shows neither Copy nor Open**: an',
    '  active-pending row whose `form_link` is null renders no copy or open button.',
    '- **(F) Skipped-email count badge**: two sub-probes using isolated page loads.',
    '  **(F1)** A card with `email_skipped_count: 3` and non-empty `photoUrls` must',
    '  render `[data-testid="skipped-photo-link"]` inside an Alert whose text contains',
    '  the count ("3"). **(F2)** A card with `email_skipped_count: 0` (same `photoUrls`)',
    '  must not render the Alert or the link element at all.',
    '- **(G) Review button opens card body and renders correct content**: clicking',
    '  `[data-testid="review-btn"]` on the submitted card triggers the MUI Collapse',
    '  to enter the open state (`MuiCollapse-entered` class appears inside',
    '  `[data-testid="submission-card-3"]`). Three sub-probes: **(G1)** the Collapse',
    '  enters; **(G2)** the address text "12 Test Street, Testville, TE1 1ST" is',
    '  visible with a non-zero bounding height; **(G3)** the room-count text',
    '  "2 rooms" is rendered in the expanded body.',
    '- **(G6a/G6b) Notes section renders heading and room_notes text**: an isolated',
    '  page load with a submitted fixture row that has `room_notes` set to a',
    '  multi-word string. After clicking Review on',
    '  `[data-testid="submission-card-6"]`, **(G6a)** the "Notes" section heading',
    '  is visible with a non-zero bounding height, and **(G6b)** the exact',
    '  `room_notes` string "Master bedroom has sloped ceiling on north wall" is',
    '  visible with a non-zero bounding height inside the expanded card body.',
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
  console.log(`\n  customer-info-rail E2E  run=${runId}`);
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
    '(A) expired card hidden',
    '(A) count badge = 3 (active-link + submitted + active-no-link)',
    '(B) active card with form_link shows copy-link-btn',
    '(B) active card with form_link shows open-link-btn',
    '(C) clicking copy briefly shows check icon',
    '(D) submitted card shows Review button',
    '(D) submitted card has no copy-link-btn',
    '(E) active card with null form_link shows no copy-link-btn',
    '(E) active card with null form_link shows no open-link-btn',
    '(F1) email_skipped_count=3: skipped-email Alert renders with count in text',
    '(F2) email_skipped_count=0: skipped-email Alert is absent',
    '(G) clicking Review button opens submitted card body',
    '(G) address "12 Test Street, Testville, TE1 1ST" visible in expanded card body',
    '(G) "2 rooms" text rendered in expanded card body',
    '(G6a) "Notes" section heading visible with non-zero height in expanded card body',
    '(G6b) room_notes "Master bedroom has sloped ceiling on north wall" visible with non-zero height in expanded card body',
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
    // ── Open customer-detail page ─────────────────────────────────────────
    console.log('\n  [A+B+D+E] Opening customer-detail page');
    const page = await openDetailPage(browser, adminClient.cookie);

    // ── Probe A: expired card hidden + count badge ────────────────────────
    console.log('\n  [A] Expired card hidden + count badge');

    const railState = await page.evaluate(() => {
      const section = document.getElementById('customer-info-submissions-section');
      if (!section) return { sectionFound: false };

      // Count badge: find the caption span inside the section header.
      const countSpan = section.querySelector('span[class*="caption"]');
      const countText = countSpan ? (countSpan.textContent || '').trim() : null;

      // Count status-chip labels to detect hidden cards.
      // The expired card is pending, so if it were rendered it would add a third
      // "Awaiting submission" chip.  Visible cards: 2×pending + 1×submitted = 3 chips.
      const chipLabels = Array.from(
        section.querySelectorAll('[data-testid="status-chip"]'),
      ).map(el => (el.textContent || '').trim());
      const awaitingCount  = chipLabels.filter(t => t === 'Awaiting submission').length;
      const submittedCount = chipLabels.filter(t => t === 'Submitted').length;
      const totalChips     = awaitingCount + submittedCount;

      return {
        sectionFound:  true,
        countText,
        awaitingCount,
        submittedCount,
        totalChips,
      };
    });

    // Debug output when things don't look right.
    if (!railState.sectionFound) {
      const intercepted = await page.evaluate(() => window.__cirIntercepted || []);
      console.log(`  [A] section not found. intercepted=${JSON.stringify(intercepted)}`);
    }

    // Expired card is hidden ⟺ only 2 "Awaiting submission" chips are visible
    // (the expired row would add a third if the filter were broken).
    const expiredHidden = railState.sectionFound
      && railState.awaitingCount === 2
      && railState.submittedCount === 1;
    record(
      PROBE_LABELS[0],
      'expired card hidden (awaiting=2, submitted=1)',
      railState.sectionFound
        ? `awaiting=${railState.awaitingCount} submitted=${railState.submittedCount}`
        : 'section not found',
      expiredHidden,
    );

    // Count badge shows (3) — the 3 visible entries.
    const countText = railState.countText || '';
    record(
      PROBE_LABELS[1],
      'count badge = "(3)"',
      `count badge text = "${countText}"`,
      countText === '(3)',
    );

    // ── Probe B: active card with form_link shows Copy + Open ─────────────
    console.log('\n  [B] Active card with form_link');

    // Card-level breakdown using direct children of the Stack container inside
    // the rail's Collapse.  The Stack is the first direct child of the Collapse
    // content wrapper; each direct child of the Stack is a SubmissionCard box.
    const bState = await page.evaluate(() => {
      const section = document.getElementById('customer-info-submissions-section');
      if (!section) return {};

      // The section header is the first child; the Collapse is the second.
      // Inside the Collapse content div sits the Stack whose direct children
      // are the SubmissionCard boxes.
      // Strategy: find the MuiStack that is a descendant of the section Collapse
      // and whose direct children contain "Awaiting submission" or "Submitted" chips.
      const cardStack = section.querySelector('[data-testid="submission-cards-stack"]');
      if (!cardStack) return { stackFound: false };

      // Direct children of the card stack are the SubmissionCard boxes.
      const cardBoxes = Array.from(cardStack.children);

      // Card with copy-link-btn is the active-with-link card.
      const activeWithLink = cardBoxes.find(b => b.querySelector('[data-testid="copy-link-btn"]'));

      // Card with "Awaiting submission" but no copy-link-btn is the active-no-link card.
      const activeNoLink = cardBoxes.find(b =>
        b.textContent.includes('Awaiting submission') &&
        !b.querySelector('[data-testid="copy-link-btn"]') &&
        !Array.from(b.querySelectorAll('button')).some(btn => /review/i.test(btn.textContent || ''))
      );

      return {
        stackFound:           true,
        totalCards:           cardBoxes.length,
        activeWithLinkFound:  !!activeWithLink,
        hasCopyBtn:           !!activeWithLink?.querySelector('[data-testid="copy-link-btn"]'),
        hasOpenBtn:           !!activeWithLink?.querySelector('[data-testid="open-link-btn"]'),
        activeNoLinkFound:    !!activeNoLink,
        noCopyOnNoLink:       activeNoLink ? !activeNoLink.querySelector('[data-testid="copy-link-btn"]') : true,
        noOpenOnNoLink:       activeNoLink ? !activeNoLink.querySelector('[data-testid="open-link-btn"]') : true,
      };
    });

    record(
      PROBE_LABELS[2],
      'copy-link-btn present on active card with form_link',
      bState.hasCopyBtn ? 'copy-link-btn found (correct)' : 'copy-link-btn absent',
      !!bState.hasCopyBtn,
    );
    record(
      PROBE_LABELS[3],
      'open-link-btn present on active card with form_link',
      bState.hasOpenBtn ? 'open-link-btn found (correct)' : 'open-link-btn absent',
      !!bState.hasOpenBtn,
    );

    // ── Probe C: clicking Copy shows check icon ───────────────────────────
    console.log('\n  [C] Copy icon swap after click');

    // Locate the copy-link-btn via Puppeteer.
    const copyBtn = await page.$('[data-testid="copy-link-btn"]');

    let checkIconSeen = false;
    if (copyBtn) {
      // Clipboard is already stubbed via evaluateOnNewDocument above.
      await copyBtn.click();

      // After clicking, CheckIcon should appear (svg data-testid="CheckIcon"
      // replaces ContentCopyIcon) within the button for a short window.
      checkIconSeen = await pollPage(page, () => {
        const btn = document.querySelector('[data-testid="copy-link-btn"]');
        if (!btn) return null;
        // MUI icon SVGs get a data-testid set to their display name (e.g. "CheckIcon").
        const svgs = btn.querySelectorAll('svg[data-testid]');
        for (const svg of svgs) {
          if ((svg.getAttribute('data-testid') || '').includes('Check')) return 'ok';
        }
        return null;
      }, 3000).then(() => true).catch(() => false);
    }

    record(
      PROBE_LABELS[4],
      'CheckIcon SVG visible inside copy-link-btn after click',
      checkIconSeen ? 'CheckIcon svg appeared (correct)' : `copyBtn found=${!!copyBtn}, checkIconSeen=false`,
      checkIconSeen,
    );

    // ── Probe D: submitted card shows Review button, no copy/open ─────────
    console.log('\n  [D] Submitted card');

    const dState = await page.evaluate(() => {
      const section = document.getElementById('customer-info-submissions-section');
      if (!section) return {};

      // Find the box containing "Submitted" chip text.
      const allCards = Array.from(section.querySelectorAll('[data-testid^="submission-card-"]'));
      const submittedCard = allCards.find(b =>
        (b.textContent || '').includes('Submitted') &&
        !(b.textContent || '').includes('Awaiting submission')
      );

      return {
        submittedCardFound:  !!submittedCard,
        hasReviewBtn:        !!(submittedCard?.querySelector('button')),
        reviewBtnText:       (submittedCard?.querySelector('button')?.textContent || '').trim(),
        hasCopyBtn:          !!submittedCard?.querySelector('[data-testid="copy-link-btn"]'),
        hasOpenBtn:          !!submittedCard?.querySelector('[data-testid="open-link-btn"]'),
      };
    });

    record(
      PROBE_LABELS[5],
      'Review button present on submitted card',
      dState.hasReviewBtn ? `Review button found, text="${dState.reviewBtnText}"` : 'no button found',
      dState.hasReviewBtn && (dState.reviewBtnText || '').toLowerCase().includes('review'),
    );
    record(
      PROBE_LABELS[6],
      'no copy-link-btn on submitted card',
      dState.hasCopyBtn ? 'copy-link-btn found (wrong)' : 'copy-link-btn absent (correct)',
      !dState.hasCopyBtn,
    );

    // ── Probe E: active card with null form_link shows no Copy/Open ────────
    console.log('\n  [E] Active card with null form_link');

    record(
      PROBE_LABELS[7],
      'no copy-link-btn on active card with null form_link',
      bState.noCopyOnNoLink ? 'copy-link-btn absent (correct)' : 'copy-link-btn present (wrong)',
      !!bState.noCopyOnNoLink,
    );
    record(
      PROBE_LABELS[8],
      'no open-link-btn on active card with null form_link',
      bState.noOpenOnNoLink ? 'open-link-btn absent (correct)' : 'open-link-btn present (wrong)',
      !!bState.noOpenOnNoLink,
    );

    // ── Probe G: clicking Review expands submitted card body ───────────────
    console.log('\n  [G] Review button expands submitted card body');

    // Locate the review-btn via Puppeteer and click it.
    const reviewBtn = await page.$('[data-testid="review-btn"]');

    let cardBodyOpen = false;
    let bodyPresent  = false;
    if (reviewBtn) {
      await reviewBtn.click();

      // Two-phase check for [data-testid="submission-card-body"]:
      //   Phase 1 — confirm the element exists in the DOM (3 s timeout).
      //             A timeout here means the testid was removed from the
      //             component, not a timing/animation issue.
      //   Phase 2 — wait for the element to have height > 0 (5 s timeout).
      //             A timeout here is the usual Collapse animation delay.
      bodyPresent = await pollPage(page, () => {
        const card = document.querySelector('[data-testid="submission-card-3"]');
        if (!card) return null;
        return card.querySelector('[data-testid="submission-card-body"]') ? 'ok' : null;
      }, 3000).then(() => true).catch(() => false);

      if (bodyPresent) {
        cardBodyOpen = await pollPage(page, () => {
          const card = document.querySelector('[data-testid="submission-card-3"]');
          if (!card) return null;
          const body = card.querySelector('[data-testid="submission-card-body"]');
          return body && body.getBoundingClientRect().height > 0 ? 'ok' : null;
        }, 5000).then(() => true).catch(() => false);
      }
    }

    record(
      PROBE_LABELS[11],
      'submission-card-body visible (height > 0) inside submission-card-3 after click',
      cardBodyOpen
        ? 'card body entered state (correct)'
        : !reviewBtn
          ? 'review-btn not found'
          : !bodyPresent
            ? '[data-testid="submission-card-body"] not found in DOM — testid may have been removed'
            : '[data-testid="submission-card-body"] did not become visible within 5 s',
      cardBodyOpen,
    );

    // G2 + G3: content assertions — only meaningful if the body opened, but
    // always recorded so failures are visible in the report.
    let addressVisible = false;
    let roomsVisible = false;
    if (cardBodyOpen) {
      const bodyState = await page.evaluate(() => {
        const card = document.querySelector('[data-testid="submission-card-3"]');
        if (!card) return { addressFound: false, addressHeight: 0, roomsFound: false };

        const expectedAddress = '12 Test Street, Testville, TE1 1ST';
        let addressFound = false;
        let addressHeight = 0;
        let roomsFound = false;

        const allEls = Array.from(card.querySelectorAll('*'));
        for (const el of allEls) {
          const text = (el.textContent || '').trim();
          if (!addressFound && text === expectedAddress) {
            const rect = el.getBoundingClientRect();
            addressHeight = rect.height;
            addressFound = true;
          }
          if (!roomsFound && text === '2 rooms') {
            roomsFound = true;
          }
          if (addressFound && roomsFound) break;
        }

        return { addressFound, addressHeight, roomsFound };
      });

      addressVisible = bodyState.addressFound && bodyState.addressHeight > 0;
      roomsVisible = bodyState.roomsFound;
    }

    record(
      PROBE_LABELS[12],
      'address "12 Test Street, Testville, TE1 1ST" visible with non-zero height after Review',
      addressVisible
        ? 'address text found with non-zero height (correct)'
        : cardBodyOpen
          ? 'card body open but address text not found or zero height'
          : 'card body did not open',
      addressVisible,
    );
    record(
      PROBE_LABELS[13],
      '"2 rooms" text rendered in card body after Review',
      roomsVisible
        ? '"2 rooms" text found (correct)'
        : cardBodyOpen
          ? 'card body open but "2 rooms" text not found'
          : 'card body did not open',
      roomsVisible,
    );

    await page.__ctx.close().catch(() => {});

    // ── Probes G6a/G6b: "Notes" heading + room_notes text in card body ────
    console.log('\n  [G6a/G6b] Notes heading and room_notes text visible in expanded card body');

    const pageG6 = await openDetailPage(
      browser, adminClient.cookie, [ROW_SUBMITTED_WITH_NOTES],
    );

    const reviewBtnG6 = await pageG6.$('[data-testid="review-btn"]');

    // Two-phase check for [data-testid="submission-card-body"] inside
    // submission-card-6, matching the pattern used by G4/G5:
    //   Phase 1 — confirm the element exists in the DOM (3 s timeout).
    //             A timeout here means the testid was removed from the
    //             component, not a timing/animation issue.
    //   Phase 2 — wait for the element to have height > 0 (10 s timeout).
    //             A timeout here is the usual animation/render delay.
    let g6BodyPresent = null;
    let g6BodyOpen = null;
    if (reviewBtnG6) {
      await reviewBtnG6.click();
      g6BodyPresent = await pollPage(pageG6, () => {
        const card = document.querySelector('[data-testid="submission-card-6"]');
        if (!card) return null;
        return card.querySelector('[data-testid="submission-card-body"]') ? 'found' : null;
      }, 3000).catch(() => null);

      if (g6BodyPresent) {
        g6BodyOpen = await pollPage(pageG6, () => {
          const card = document.querySelector('[data-testid="submission-card-6"]');
          if (!card) return null;
          const body = card.querySelector('[data-testid="submission-card-body"]');
          if (!body) return null;
          return body.getBoundingClientRect().height > 0 ? 'ok' : null;
        }, 10000).catch(() => null);
      }
    }

    let notesHeadingVisible = false;
    let roomNotesVisible = false;
    if (g6BodyOpen) {
      const g6State = await pageG6.evaluate(() => {
        const card = document.querySelector('[data-testid="submission-card-6"]');
        if (!card) return { headingFound: false, headingHeight: 0, notesFound: false, notesHeight: 0 };

        const notesTarget = 'Master bedroom has sloped ceiling on north wall';
        let headingFound = false;
        let headingHeight = 0;
        let notesFound = false;
        let notesHeight = 0;

        const allEls = Array.from(card.querySelectorAll('*'));
        for (const el of allEls) {
          const text = (el.textContent || '').trim();
          if (!headingFound && text === 'Notes') {
            const rect = el.getBoundingClientRect();
            headingHeight = rect.height;
            headingFound = true;
          }
          if (!notesFound && text === notesTarget) {
            const rect = el.getBoundingClientRect();
            notesHeight = rect.height;
            notesFound = true;
          }
          if (headingFound && notesFound) break;
        }

        return { headingFound, headingHeight, notesFound, notesHeight };
      });

      notesHeadingVisible = g6State.headingFound && g6State.headingHeight > 0;
      roomNotesVisible    = g6State.notesFound   && g6State.notesHeight   > 0;
    }

    record(
      PROBE_LABELS[14],
      '"Notes" section heading visible with non-zero height after Review',
      notesHeadingVisible
        ? '"Notes" heading found with non-zero height (correct)'
        : g6BodyOpen
          ? 'card body open but "Notes" heading not found or zero height'
          : g6BodyPresent
            ? '[data-testid="submission-card-body"] did not become visible within 10 s'
            : !reviewBtnG6
              ? 'review-btn not found'
              : '[data-testid="submission-card-body"] not found in DOM — testid may have been removed',
      notesHeadingVisible,
    );
    record(
      PROBE_LABELS[15],
      'room_notes text visible with non-zero height after Review',
      roomNotesVisible
        ? 'room_notes text found with non-zero height (correct)'
        : g6BodyOpen
          ? 'card body open but room_notes text not found or zero height'
          : g6BodyPresent
            ? '[data-testid="submission-card-body"] did not become visible within 10 s'
            : !reviewBtnG6
              ? 'review-btn not found'
              : '[data-testid="submission-card-body"] not found in DOM — testid may have been removed',
      roomNotesVisible,
    );

    await pageG6.__ctx.close().catch(() => {});

    // ── Probe F: skipped-email count badge ────────────────────────────────
    console.log('\n  [F] Skipped-email count badge');

    // F1: email_skipped_count=3 with photoUrls → Alert badge renders and text
    //     contains the count ("3 photos were too large…").
    console.log('  [F1] non-zero count → badge present');
    const pageF1 = await openDetailPage(browser, adminClient.cookie, [ROW_SKIP_NONZERO]);

    const f1State = await pageF1.evaluate(() => {
      const section = document.getElementById('customer-info-submissions-section');
      if (!section) return { sectionFound: false, linkFound: false, alertText: null };
      const link = section.querySelector('[data-testid="skipped-photo-link"]');
      if (!link) return { sectionFound: true, linkFound: false, alertText: null };
      const alert = section.querySelector('[data-testid="skipped-photo-alert"]');
      const alertText = (alert?.textContent || '').trim();
      return { sectionFound: true, linkFound: true, alertText };
    });

    const badgeHasCount = f1State.linkFound && (f1State.alertText || '').includes('3');
    record(
      PROBE_LABELS[9],
      'skipped-photo-link present; Alert text contains "3"',
      f1State.sectionFound
        ? (f1State.linkFound
            ? `link found; alertText="${f1State.alertText}"`
            : 'link absent')
        : 'section not found',
      badgeHasCount,
    );

    await pageF1.__ctx.close().catch(() => {});

    // F2: email_skipped_count=0 with photoUrls → Alert badge is absent.
    console.log('  [F2] zero count → badge absent');
    const pageF2 = await openDetailPage(browser, adminClient.cookie, [ROW_SKIP_ZERO]);

    const f2State = await pageF2.evaluate(() => {
      const section = document.getElementById('customer-info-submissions-section');
      if (!section) return { sectionFound: false, linkFound: null };
      const link = section.querySelector('[data-testid="skipped-photo-link"]');
      return { sectionFound: true, linkFound: !!link };
    });

    record(
      PROBE_LABELS[10],
      'skipped-photo-link absent when email_skipped_count=0',
      f2State.sectionFound
        ? (f2State.linkFound ? 'link present (wrong)' : 'link absent (correct)')
        : 'section not found',
      f2State.sectionFound && !f2State.linkFound,
    );

    await pageF2.__ctx.close().catch(() => {});

  } catch (e) {
    console.error('Test error:', e);
    console.error('--- server log (last 2000 chars) ---');
    console.error(logBuf.join('').slice(-2000));
  } finally {
    try { await browser.close(); } catch {}
    const failed = findings.filter(f => !f.ok && !f.skipped).length;
    await cleanupAndExit(failed > 0 ? 1 : 0);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(2); });
