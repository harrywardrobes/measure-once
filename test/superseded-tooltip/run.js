'use strict';
// test/superseded-tooltip/run.js
//
// Regression guard for the Superseded chip and its tooltip in
// CustomerInfoSubmissionsRail.
//
// When two active-pending rows exist for the same contact the component marks
// the older one (lower expires_at) as superseded and wraps its Chip in a
// MUI Tooltip.  This test verifies:
//
//   [ST-A] The "Superseded" chip is rendered (not accidentally hidden or
//          removed by a future refactor).
//
//   [ST-B] Hovering the chip makes the tooltip text visible:
//          "A newer link has been generated — this one is no longer active"
//
//   [ST-C] The superseded card has no Copy, Open, or Resend action buttons
//          (copy-link-btn, open-link-btn, resend-link-btn are all absent).
//
//   [ST-D] The active (non-superseded) card has at least one of Copy, Open,
//          or Resend present — guards against regressions that strip buttons
//          from all cards simultaneously.
//
// Strategy: boots a disposable test server with the privileges harness.
// All customer-detail API calls are stubbed via evaluateOnNewDocument fetch
// interception — no HubSpot token or real contact data required.
//
// The superseded state is triggered by seeding TWO active rows (submitted_at
// null, expires_at in the future).  The component sorts active rows by
// expires_at descending, so the row with the LATER expiry becomes index 0
// (newest, receives Copy/Open buttons) and the EARLIER-expiry row becomes
// index 1 among active cards, receiving isSuperseded=true.
//
// Usage:
//   DATABASE_URL_TEST=<disposable>  npm run test:superseded-tooltip
//   PRIVTEST_ALLOW_SHARED_DB=1      npm run test:superseded-tooltip

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

const CONTACT_ID = '777222333';

const NOW    = Date.now();
const FUTURE_FAR  = new Date(NOW + 14 * 24 * 60 * 60 * 1000).toISOString(); // 14 days — newest active
const FUTURE_NEAR = new Date(NOW +  3 * 24 * 60 * 60 * 1000).toISOString(); //  3 days — older active → superseded

// Row 1: newest active row — will be index 0 (not superseded, gets Copy/Open).
const ROW_NEWEST = {
  id: 10,
  created_at: new Date(NOW - 1 * 24 * 60 * 60 * 1000).toISOString(),
  submitted_at: null,
  expires_at: FUTURE_FAR,
  contact_name: 'Superseded Test',
  contact_email: 'superseded@privtest.invalid',
  corrected_email: null,
  corrected_mobile: null,
  address_line1: null,
  city: null,
  postcode: null,
  room_count: null,
  room_notes: null,
  photo_keys: [],
  photoUrls: [],
  email_skipped_count: 0,
  form_link: 'https://example.com/form/newest',
};

// Row 2: older active row — will be index 1 among active cards → superseded.
const ROW_SUPERSEDED = {
  id: 11,
  created_at: new Date(NOW - 5 * 24 * 60 * 60 * 1000).toISOString(),
  submitted_at: null,
  expires_at: FUTURE_NEAR,
  contact_name: 'Superseded Test',
  contact_email: 'superseded@privtest.invalid',
  corrected_email: null,
  corrected_mobile: null,
  address_line1: null,
  city: null,
  postcode: null,
  room_count: null,
  room_notes: null,
  photo_keys: [],
  photoUrls: [],
  email_skipped_count: 0,
  form_link: 'https://example.com/form/older',
};

const ALL_ROWS = [ROW_NEWEST, ROW_SUPERSEDED];

// Expected number of submission-card roots the component should render.
// Equals the number of seeded rows — used in the ST-E guard probe.
const EXPECTED_CARD_COUNT = ALL_ROWS.length; // 2

const CONTACT_STUB = {
  id: CONTACT_ID,
  properties: {
    firstname: 'Superseded',
    lastname: 'PrivTest',
    email: 'superseded@privtest.invalid',
    phone: '',
    mobilephone: '',
    hs_lead_status: '',
    hw_lead_substatus: '',
    address: '',
    city: '',
    zip: '',
  },
};

const TOOLTIP_TEXT = 'A newer link has been generated — this one is no longer active';

// ── Helpers ───────────────────────────────────────────────────────────────────

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'superseded-tooltip.md',
);

const findings = [];

function record(name, expected, observed, ok, detail = '') {
  findings.push({ name, expected, observed, ok, skipped: false, detail });
  const mark = ok ? '  ✓' : '  ✗';
  console.log(`${mark}  ${name}`);
  if (!ok) {
    console.log(`     expected : ${expected}`);
    console.log(`     observed : ${observed}`);
    if (detail) console.log(`     detail   : ${detail}`);
  }
}

function skip(name, expected, reason) {
  findings.push({ name, expected, observed: reason, ok: false, skipped: true, detail: '' });
  console.log(`  –  ${name}`);
  console.log(`     skipped  : ${reason}`);
}

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
 * calls. Returns two active rows so the component marks the older one as
 * superseded.
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

  window.__stIntercepted = [];

  window.fetch = function (input, init) {
    var url      = typeof input === 'string' ? input : (input && input.url) || '';
    var parts    = url.startsWith('http') ? new URL(url) : null;
    var pathname = parts ? parts.pathname : url.split('?')[0];

    function json(body, status) {
      status = status || 200;
      window.__stIntercepted.push(pathname);
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: status,
        headers: { 'Content-Type': 'application/json' },
      }));
    }

    // Customer-info submissions (the rail's own endpoint).
    if (pathname === '/api/customer-info/by-contact/' + CONTACT_ID) {
      return json(ROWS);
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

    // Google / Gmail.
    if (pathname.startsWith('/api/emails'))   return json([]);
    if (pathname.startsWith('/api/google'))   return json({ connected: false });
    if (pathname.startsWith('/api/calendar')) return json({ connected: false, events: [] });

    // QuickBooks.
    if (pathname.startsWith('/api/quickbooks/status')) return json({ connected: false });
    if (pathname.startsWith('/api/quickbooks'))        return json({ invoices: [] });

    // SSE and auth — pass through.
    if (pathname.startsWith('/api/hubspot/webhook-events')) {
      return orig.call(this, input, init);
    }
    if (pathname === '/api/auth/user') {
      return orig.call(this, input, init);
    }

    // Catch-all.
    window.__stIntercepted.push('pass:' + pathname);
    return orig.call(this, input, init);
  };
})();
  `.trim();
}

/**
 * Open the customer-detail page with fetch stubs active. Waits until the
 * Customer Info rail section is present.
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

  await page.evaluateOnNewDocument(buildInterceptScript(CONTACT_ID, ALL_ROWS));

  await injectSession(page, jar);
  await page.goto(`${BASE}/customers/${CONTACT_ID}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  const railVisible = await pollPage(page, () => {
    return document.getElementById('customer-info-submissions-section') ? 'ok' : null;
  }, 20000).catch(() => null);

  if (!railVisible) {
    const intercepted = await page.evaluate(() => window.__stIntercepted || []);
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
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed  = findings.filter(f => f.ok).length;
  const skipped = findings.filter(f => f.skipped).length;
  const failed  = findings.filter(f => !f.ok && !f.skipped).length;
  const lines = [
    '# Superseded Tooltip — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:superseded-tooltip\``,
    '',
    '## Summary',
    '',
    `- Passed:  ${passed}  / ${findings.length}`,
    `- Failed:  ${failed}  / ${findings.length}`,
    `- Skipped: ${skipped} / ${findings.length}`,
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
    '- **(ST-A) Superseded chip present**: when two active-pending rows exist,',
    '  the older row renders a Chip with label "Superseded" rather than Copy/Open',
    '  action buttons.',
    '- **(ST-B) Tooltip text on hover**: hovering the Superseded chip reveals a',
    `  MUI Tooltip whose text is "${TOOLTIP_TEXT}".`,
    '- **(ST-C) No action buttons on superseded card**: the superseded card has no',
    '  `copy-link-btn`, `open-link-btn`, or `resend-link-btn` elements, confirming',
    '  that a future refactor cannot accidentally re-introduce those buttons.',
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
  console.log(`\n  superseded-tooltip E2E  run=${runId}`);
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
  console.log(`  Seeded users  admin=${users.admin.email}`);

  const adminClient = await login(users.admin.email, users.admin.password);

  // ── Puppeteer ───────────────────────────────────────────────────────────────
  const PROBE_LABELS = [
    '(ST-A) Superseded chip is present in the rail',
    '(ST-B) Hovering Superseded chip reveals tooltip text',
    '(ST-E) Exactly 2 submission-card roots are rendered',
    '(ST-C) Superseded card has no Copy, Open, or Resend buttons',
    '(ST-D) Active (non-superseded) card has at least one of Copy, Open, or Resend',
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
    console.log('\n  Opening customer-detail page');
    const page = await openDetailPage(browser, adminClient.cookie);

    // ── Probe ST-A: Superseded chip present ────────────────────────────────
    console.log('\n  [ST-A] Checking for Superseded chip');

    // The rail section opens collapsed by default — click the header to expand it.
    const headerClicked = await page.evaluate(() => {
      const section = document.getElementById('customer-info-submissions-section');
      if (!section) return false;
      // The header box is the first child of the section.
      const header = section.firstElementChild;
      if (header) { header.click(); return true; }
      return false;
    });

    if (!headerClicked) {
      console.log('  [ST-A] section header not found — section may not have rendered');
    }

    // Wait for the Superseded chip to appear after the Collapse opens.
    const supersededChipFound = await pollPage(page, () => {
      return document.querySelector('[data-testid="superseded-chip"]') ? 'ok' : null;
    }, 8000).then(() => true).catch(() => false);

    record(
      PROBE_LABELS[0],
      '"Superseded" chip label visible in rail',
      supersededChipFound
        ? '"Superseded" chip found (correct)'
        : '"Superseded" chip not found',
      supersededChipFound,
    );

    // ── Probe ST-B: Hover reveals tooltip text ─────────────────────────────
    console.log('\n  [ST-B] Hovering Superseded chip for tooltip');

    let tooltipSeen = false;

    if (supersededChipFound) {
      // Find the Superseded chip by its test id and hover it.
      const chipHandle = await page.evaluateHandle(() => {
        return document.querySelector('[data-testid="superseded-chip"]');
      });

      const chipElement = chipHandle.asElement();
      if (chipElement) {
        await chipElement.hover();

        // MUI Tooltip renders into a portal element with role="tooltip".
        // Poll until the tooltip text appears anywhere in the document.
        tooltipSeen = await pollPage(page, () => {
          const tooltips = Array.from(document.querySelectorAll('[role="tooltip"]'));
          const text = tooltips.map(t => (t.textContent || '').trim()).join(' ');
          return text.includes('A newer link has been generated') ? 'ok' : null;
        }, 5000).then(() => true).catch(() => false);
      } else {
        console.log('  [ST-B] chip element handle resolved to null');
      }
    } else {
      console.log('  [ST-B] skipping hover — chip was not found in ST-A');
    }

    record(
      PROBE_LABELS[1],
      `tooltip text contains "${TOOLTIP_TEXT}"`,
      tooltipSeen
        ? 'tooltip text appeared on hover (correct)'
        : supersededChipFound
          ? 'chip found but tooltip text did not appear'
          : 'chip not found — cannot hover',
      tooltipSeen,
    );

    // ── Probe ST-E: Exactly N submission-card roots exist ──────────────────────
    // This guard runs before the per-card probes so that a rendering regression
    // that hides ALL cards produces a clear "expected 2, found 0" message
    // instead of a generic "active card not found in DOM" from ST-D.
    console.log(`\n  [ST-E] Checking exactly ${EXPECTED_CARD_COUNT} submission-card roots are rendered`);

    const renderedCardCount = await page.evaluate(() =>
      document.querySelectorAll('[data-testid^="submission-card"]').length,
    );

    const steOk = renderedCardCount === EXPECTED_CARD_COUNT;

    record(
      PROBE_LABELS[2],
      `exactly ${EXPECTED_CARD_COUNT} submission-card roots rendered`,
      steOk
        ? `${renderedCardCount} submission-card roots found (correct)`
        : `expected ${EXPECTED_CARD_COUNT} submission cards, found ${renderedCardCount}`,
      steOk,
    );

    // ── Probe ST-C / ST-D: skip when ST-E failed ──────────────────────────────
    // When the card-count guard fails the DOM is fundamentally broken; running
    // the per-card probes would only produce misleading "card not found" errors.
    if (!steOk) {
      const skipReason = `ST-E card-count check failed (expected ${EXPECTED_CARD_COUNT}, found ${renderedCardCount}) — per-card probes not applicable`;
      console.log('\n  [ST-C]');
      skip(PROBE_LABELS[3], 'no copy-link-btn, open-link-btn, or resend-link-btn on the superseded card', skipReason);
      console.log('\n  [ST-D]');
      skip(PROBE_LABELS[4], 'at least one of copy-link-btn, open-link-btn, or resend-link-btn on the active card', skipReason);

      await page.__ctx.close().catch(() => {});
      return;
    }

    // ── Probe ST-C: Superseded card has no Copy, Open, or Resend buttons ──────
    console.log('\n  [ST-C] Checking superseded card has no Copy/Open/Resend buttons');

    // Find the card that contains the Superseded chip and check that none of
    // the three action button test-ids are present inside it.
    const absentButtons = await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('[class*="MuiChip-label"]'));
      const supersededLabel = labels.find(c => (c.textContent || '').trim() === 'Superseded');
      if (!supersededLabel) return { cardFound: false, copyPresent: false, openPresent: false, resendPresent: false };

      // Walk up to the submission card root using the stable data-testid anchor.
      const cardRoot = supersededLabel.closest('[data-testid^="submission-card"]');
      if (!cardRoot) return { cardFound: false, copyPresent: false, openPresent: false, resendPresent: false };

      return {
        cardFound: true,
        copyPresent:   !!cardRoot.querySelector('[data-testid="copy-link-btn"]'),
        openPresent:   !!cardRoot.querySelector('[data-testid="open-link-btn"]'),
        resendPresent: !!cardRoot.querySelector('[data-testid="resend-link-btn"]'),
      };
    });

    const stcOk = absentButtons.cardFound
      && !absentButtons.copyPresent
      && !absentButtons.openPresent
      && !absentButtons.resendPresent;

    let stcObserved;
    if (!absentButtons.cardFound) {
      stcObserved = 'superseded card not found in DOM';
    } else {
      const present = [];
      if (absentButtons.copyPresent)   present.push('copy-link-btn');
      if (absentButtons.openPresent)   present.push('open-link-btn');
      if (absentButtons.resendPresent) present.push('resend-link-btn');
      stcObserved = present.length === 0
        ? 'no Copy/Open/Resend buttons present on superseded card (correct)'
        : `unexpected buttons found: ${present.join(', ')}`;
    }

    record(
      PROBE_LABELS[3],
      'no copy-link-btn, open-link-btn, or resend-link-btn on the superseded card',
      stcObserved,
      stcOk,
    );

    // ── Probe ST-D: Active card has at least one Copy, Open, or Resend button ──
    console.log('\n  [ST-D] Checking active (non-superseded) card has Copy/Open/Resend buttons');

    const activeButtons = await page.evaluate(() => {
      const allCards = Array.from(document.querySelectorAll('[data-testid^="submission-card"]'));

      // Find the first card that does NOT contain the Superseded chip.
      const activeCard = allCards.find(card => {
        const labels = Array.from(card.querySelectorAll('[class*="MuiChip-label"]'));
        return !labels.some(l => (l.textContent || '').trim() === 'Superseded');
      });

      if (!activeCard) return { cardFound: false, copyPresent: false, openPresent: false, resendPresent: false };

      return {
        cardFound: true,
        copyPresent:   !!activeCard.querySelector('[data-testid="copy-link-btn"]'),
        openPresent:   !!activeCard.querySelector('[data-testid="open-link-btn"]'),
        resendPresent: !!activeCard.querySelector('[data-testid="resend-link-btn"]'),
      };
    });

    const stdOk = activeButtons.cardFound
      && (activeButtons.copyPresent || activeButtons.openPresent || activeButtons.resendPresent);

    let stdObserved;
    if (!activeButtons.cardFound) {
      stdObserved = 'active (non-superseded) card not found in DOM';
    } else {
      const present = [];
      if (activeButtons.copyPresent)   present.push('copy-link-btn');
      if (activeButtons.openPresent)   present.push('open-link-btn');
      if (activeButtons.resendPresent) present.push('resend-link-btn');
      stdObserved = present.length > 0
        ? `action buttons present on active card: ${present.join(', ')} (correct)`
        : 'no Copy/Open/Resend buttons found on the active card';
    }

    record(
      PROBE_LABELS[4],
      'at least one of copy-link-btn, open-link-btn, or resend-link-btn on the active card',
      stdObserved,
      stdOk,
    );

    await page.__ctx.close().catch(() => {});

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
