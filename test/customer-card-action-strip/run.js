'use strict';
// test/customer-card-action-strip/run.js
//
// End-to-end test verifying that the action-label strip renders correctly on
// customer cards in CustomersPage.tsx (task #1891), and that the QB invoice
// drawer opens correctly when the invoice badge is clicked (task #1933).
//
// The test fully stubs the customers-page API calls via evaluateOnNewDocument
// fetch interception so no HubSpot token or real data is required.
//
// Probes:
//   (A) A card whose (stage, lead-status) matches a bound handler shows a
//       coloured action strip with the handler's action_name label.
//   (B) A card with no matching handler shows no action strip at all.
//   (C) When /api/design-visits/in-progress returns a draft visit ID for the
//       contact AND the handler type is start_design_visit, the strip shows
//       "Continue designing" instead of the handler action_name.
//   (D) Clicking the action strip fires the handler dispatch (captured via a
//       window spy) and does NOT trigger the outer CardActionArea link
//       (URL remains /customers after the click).
//   (E) QB invoice badge click → InvoiceDetailDrawer opens. When QB is
//       connected and invoices are returned for a contact, clicking the red
//       invoice badge on the card opens the drawer
//       (data-testid="invoice-detail-drawer" present + open). Regression guard
//       for the accidental deletion of handleOpenInvoice (task #1920).
//   (F) UploadPhotosModal check-error phase: when the link-status fetch fails,
//       the button with data-testid="cah-proceed-anyway" reads "Generate
//       anyway", not "Send anyway". Regression guard for accidental label
//       revert on the proceed button.
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:customer-card-action-strip
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:customer-card-action-strip

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

// ── Fixture constants ─────────────────────────────────────────────────────────

// Contact with a bound handler (probe A + D).
const CONTACT_A_ID     = 'privtest-ccas-contact-a';
const CONTACT_A_NAME   = 'Alpha PrivTest';
const CONTACT_A_STATUS = 'privtest_ccas_strip';     // matches the handler binding

// Contact with no handler (probe B).
const CONTACT_B_ID     = 'privtest-ccas-contact-b';
const CONTACT_B_NAME   = 'Bravo PrivTest';
const CONTACT_B_STATUS = 'privtest_ccas_nomatch';   // not bound to any handler

// Contact with a start_design_visit handler + in-progress draft (probe C).
const CONTACT_C_ID     = 'privtest-ccas-contact-c';
const CONTACT_C_NAME   = 'Charlie PrivTest';
const CONTACT_C_STATUS = 'privtest_ccas_design';    // bound to start_design_visit handler
const DRAFT_VISIT_ID   = 77;

// Contact with a QB invoice (probe E).
const CONTACT_E_ID    = 'privtest-ccas-contact-e';
const CONTACT_E_EMAIL = 'echo@privtest.invalid';
const INV_E_ID        = 'inv-privtest-e';

// Contact with an upload_photos_and_info handler (probe F).
const CONTACT_F_ID     = 'privtest-ccas-contact-f';
const CONTACT_F_STATUS = 'privtest_ccas_upload';

// The action_name on the handler for contact A (rendered as "Strip Action" in Title Case).
const HANDLER_ACTION_NAME = 'strip_action';
const EXPECTED_STRIP_LABEL = 'Strip Action';

// ── Helpers ───────────────────────────────────────────────────────────────────

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'customer-card-action-strip.md',
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
 * Build the fetch-interceptor script fragment that stubs all customers-page
 * API calls. `opts` controls variable parts:
 *   contacts         – array of contact objects for /api/contacts-all
 *   handlers         – array for /api/card-action-handlers
 *   inProgress       – array for /api/design-visits/in-progress
 *   qbConnected      – boolean; when true, stubs QB status as connected + returns qbInvoices
 *   qbInvoices       – array of invoice summary objects returned by /api/quickbooks/invoices
 *   qbInvoiceDetails – map of id → detail object for /api/quickbooks/invoice/:id stubs
 *   linkStatusError  – when true, stub the link-status endpoint to return 500
 */
function buildFetchInterceptScript(opts) {
  const {
    contacts,
    handlers,
    inProgress,
    qbConnected = false,
    qbInvoices = [],
    qbInvoiceDetails = {},
    linkStatusError = false,
  } = opts;

  // Build a minimal stub for every endpoint the page fetches on load.
  const stubs = {
    '/api/contacts-all':              JSON.stringify({ results: contacts, total: contacts.length, totalPages: 1, page: 1 }),
    '/api/card-action-handlers':      JSON.stringify(handlers),
    '/api/stage-action-labels':       JSON.stringify([]),
    '/api/lead-substatuses':          JSON.stringify([]),
    '/api/lead-statuses':             JSON.stringify([]),
    '/api/workflow':                  JSON.stringify({ stages: { sales: { label: 'Sales' } } }),
    '/api/localdata/all':             JSON.stringify({}),
    '/api/contacts-lead-status-counts': JSON.stringify({}),
    '/api/contacts-substatus-counts':   JSON.stringify({}),
    '/api/page-filter-config':        JSON.stringify({ customers_page_size: 25 }),
    '/api/quickbooks/status':         JSON.stringify(qbConnected ? { connected: true } : { connected: false }),
    '/api/quickbooks/invoices':       JSON.stringify({ invoices: qbInvoices }),
  };

  const inProgressJson       = JSON.stringify(inProgress || []);
  const qbInvoiceDetailsJson = JSON.stringify(qbInvoiceDetails);
  const linkStatusErrorFlag  = linkStatusError ? 'true' : 'false';

  return `
(function() {
  var STUBS = ${JSON.stringify(stubs)};
  var IN_PROGRESS = ${inProgressJson};
  var QB_INV_DETAILS = ${qbInvoiceDetailsJson};
  var LINK_STATUS_ERROR = ${linkStatusErrorFlag};

  var originalFetch = window.fetch;

  window.__ccasDispatchCalls = [];
  window.__ccasIntercepted = [];

  window.fetch = function(input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var parts = url.startsWith('http') ? new URL(url) : null;
    var pathname = parts ? parts.pathname : url.split('?')[0];

    // Urgency endpoint (POST) — return empty urgency map.
    if (pathname === '/api/contacts/urgency' && init && init.method === 'POST') {
      window.__ccasIntercepted.push('urgency');
      return Promise.resolve(new Response(JSON.stringify({ urgency: {} }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }

    // In-progress design visits — keyed by contactIds query param.
    if (pathname === '/api/design-visits/in-progress') {
      window.__ccasIntercepted.push('in-progress:' + JSON.stringify(IN_PROGRESS));
      return Promise.resolve(new Response(JSON.stringify(IN_PROGRESS), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }

    // QB invoice detail — /api/quickbooks/invoice/:id
    var invDetailMatch = pathname.match(/^\\/api\\/quickbooks\\/invoice\\/(.+)$/);
    if (invDetailMatch) {
      var invId = invDetailMatch[1];
      var detail = QB_INV_DETAILS[invId];
      window.__ccasIntercepted.push('qb-inv-detail:' + invId);
      if (detail) {
        return Promise.resolve(new Response(JSON.stringify(detail), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      }));
    }

    // link-status — return a 500 error when LINK_STATUS_ERROR is true.
    if (LINK_STATUS_ERROR && pathname.match(/^\\/api\\/customer-info\\/by-contact\\/.+\\/link-status$/)) {
      window.__ccasIntercepted.push('link-status-error:' + pathname);
      return Promise.resolve(new Response(JSON.stringify({ error: 'Stub: link-status unavailable' }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      }));
    }

    if (STUBS[pathname] !== undefined) {
      window.__ccasIntercepted.push(pathname);
      return Promise.resolve(new Response(STUBS[pathname], {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }

    // Pass-through: log unhandled URLs for debugging.
    window.__ccasIntercepted.push('pass:' + pathname);
    return originalFetch.call(this, input, init);
  };
})();
  `.trim();
}

/**
 * Open /customers with the fetch stubs active. Returns a Puppeteer page
 * once the customer cards grid has rendered (or timed out).
 */
async function openCustomers(browser, jar, opts) {
  const ctx = await (browser.createBrowserContext
    ? browser.createBrowserContext()
    : browser.createIncognitoBrowserContext());
  const page = await ctx.newPage();
  page.__ctx = ctx;
  await page.setCacheEnabled(false);

  const pageLogs = [];
  page.on('console', m => pageLogs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => pageLogs.push(`[pageerror] ${e.message}`));

  await page.evaluateOnNewDocument(buildFetchInterceptScript(opts));

  await injectSession(page, jar);
  await page.goto(`${BASE}/customers`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait until the customers grid container is in the DOM.
  await pollPage(page, () => !!document.getElementById('customers-results'), null, 20000);

  // Wait until at least one MuiCard is rendered (contacts loaded).
  await pollPage(page, () => !!document.querySelector('#customers-results .MuiCard-root'), null, 15000);

  page.__logs = pageLogs;
  return page;
}

// ── Report ────────────────────────────────────────────────────────────────────

function writeReport(runId) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok).length;
  const lines = [
    '# Customer Card Action Strip — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:customer-card-action-strip\``,
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
    '- **(A) Strip renders with correct label**: card whose (stage=sales, lead-status=privtest_ccas_strip)',
    '  matches a bound handler shows a `[role="button"]` action strip inside the card',
    '  with the text derived from `action_name` ("Strip Action").',
    '- **(B) No strip when handler absent**: card with lead-status=privtest_ccas_nomatch',
    '  (no handler binding) renders no `[role="button"]` action strip element.',
    '- **(C) Continue designing**: when /api/design-visits/in-progress returns a draft visit',
    '  for the contact and the handler type is start_design_visit, the strip shows',
    '  "Continue designing" instead of the action_name label.',
    '- **(D) Click isolation**: clicking the action strip does NOT trigger the outer',
    '  CardActionArea link — the page URL remains /customers after the click.',
    '- **(E) QB invoice badge → InvoiceDetailDrawer**: when QB is connected and the',
    '  stubbed /api/quickbooks/invoices list contains an invoice matching the contact',
    '  by email, the card renders a red badge button; clicking it opens the',
    '  `InvoiceDetailDrawer` (`data-testid="invoice-detail-drawer"` present and not',
    '  aria-hidden). Regression guard for the accidental deletion of handleOpenInvoice.',
    '- **(F) UploadPhotosModal "Generate anyway" button label**: clicking an',
    '  `upload_photos_and_info` strip opens the modal; the link-status fetch is',
    '  stubbed to return a 500 error so the modal enters check-error phase. Asserts',
    '  the `[data-testid="cah-proceed-anyway"]` button reads "Generate anyway" and',
    '  does NOT read "Send anyway". Regression guard against accidental label revert.',
    '',
    'All customers-page API calls are stubbed via evaluateOnNewDocument fetch',
    'interception so no HubSpot token or real contact data is required.',
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
  console.log(`\n  customer-card-action-strip E2E  run=${runId}`);
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
  console.log(`  Seeded users  member=${users.member.email}`);

  const memberClient = await login(users.member.email, users.member.password);

  // ── Puppeteer ─────────────────────────────────────────────────────────────
  const UI_PROBE_LABELS = [
    '(A) card with matching handler shows action strip',
    '(A) action strip contains correct label',
    '(B) card with no handler shows no action strip',
    '(C) start_design_visit + in-progress draft shows "Continue designing" strip',
    '(D) clicking action strip does not navigate away from /customers',
    '(E) QB invoice badge click opens InvoiceDetailDrawer',
    '(F) UploadPhotosModal check-error: proceed button reads "Generate anyway"',
    '(F) UploadPhotosModal check-error: proceed button does NOT read "Send anyway"',
  ];

  if (!puppeteer) {
    for (const l of UI_PROBE_LABELS) record(l, 'puppeteer installed', 'puppeteer not installed', false);
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
    for (const l of UI_PROBE_LABELS) record(l, 'browser launched', `browser launch failed: ${msg}`, false);
    await cleanupAndExit(1);
    return;
  }

  // ── Fixtures shared across probes A/B/D ───────────────────────────────────
  //
  // Handler bound to contact A's (sales, privtest_ccas_strip) slot.
  // action_name = 'strip_action' → title-case label "Strip Action".
  const handlerForA = {
    id: 1001,
    type: 'show_message',
    config: { action_name: HANDLER_ACTION_NAME, message: 'PrivTest strip action message' },
    bindings: [{ stage_key: 'sales', status_key: CONTACT_A_STATUS }],
  };

  const contactA = {
    id: CONTACT_A_ID,
    properties: {
      firstname: 'Alpha',
      lastname: 'PrivTest',
      email: 'alpha@privtest.invalid',
      hs_lead_status: CONTACT_A_STATUS,
    },
  };

  const contactB = {
    id: CONTACT_B_ID,
    properties: {
      firstname: 'Bravo',
      lastname: 'PrivTest',
      email: 'bravo@privtest.invalid',
      hs_lead_status: CONTACT_B_STATUS,
    },
  };

  try {
    // ── Probes A + B: page with two contacts, one bound, one unbound ─────────
    console.log('\n  [A+B] Strip presence/absence probes');

    const pageAB = await openCustomers(browser, memberClient.cookie, {
      contacts: [contactA, contactB],
      handlers: [handlerForA],
      inProgress: [],
    });

    // Wait for the React hook to fetch handlers and re-render.
    // The strip is rendered as role="button" inside the card.
    await pollPage(pageAB, () => {
      const cards = Array.from(document.querySelectorAll('#customers-results .MuiCard-root'));
      return cards.length >= 2 ? 'ok' : null;
    }, null, 12000);

    // Additional wait: the card action handlers fetch is async — poll until
    // at least one strip appears OR 5 s elapse (absence is also valid).
    await pollPage(pageAB, () => {
      const strips = document.querySelectorAll('#customers-results [role="button"]');
      // Either we see a strip (handler loaded) or we've waited long enough to
      // be confident the no-strip card truly has no strip.
      return strips.length > 0 ? 'ok' : null;
    }, null, 8000).catch(() => 'timeout');

    // Snapshot the DOM once settled.
    const abState = await pageAB.evaluate((contactAId, contactBId) => {
      const cards = Array.from(document.querySelectorAll('#customers-results .MuiCard-root'));

      function cardStrip(nameFragment) {
        const card = cards.find(c => (c.textContent || '').includes(nameFragment));
        if (!card) return null;
        const strip = card.querySelector('[role="button"]');
        return strip ? (strip.textContent || '').trim() : null;
      }

      return {
        totalCards: cards.length,
        alphaStripText: cardStrip('Alpha PrivTest'),
        bravoStripText: cardStrip('Bravo PrivTest'),
        intercepted: window.__ccasIntercepted || [],
      };
    }, CONTACT_A_ID, CONTACT_B_ID);

    // Print diagnostics if strip not found.
    if (abState.alphaStripText === null) {
      const abLogs = (pageAB.__logs || []).filter(l =>
        l.includes('draftVisitIds') || l.includes('contacts') || l.includes('error') || l.includes('Error')
      );
      console.log(`  [A] debug: totalCards=${abState.totalCards} intercepted=${JSON.stringify(abState.intercepted)}`);
      if (abLogs.length) console.log(`  [A] page logs:\n    ${abLogs.join('\n    ')}`);
    }

    // (A) strip present
    record(
      UI_PROBE_LABELS[0],
      'action strip (role=button) present inside Alpha card',
      abState.alphaStripText !== null
        ? `strip found, text="${abState.alphaStripText}"`
        : 'no strip found',
      abState.alphaStripText !== null,
    );

    // (A) strip label
    const alphaLabel = abState.alphaStripText || '';
    record(
      UI_PROBE_LABELS[1],
      `strip text contains "${EXPECTED_STRIP_LABEL}"`,
      `strip text="${alphaLabel}"`,
      alphaLabel.includes(EXPECTED_STRIP_LABEL),
    );

    // (B) no strip for unbound card
    record(
      UI_PROBE_LABELS[2],
      'no action strip inside Bravo card',
      abState.bravoStripText !== null
        ? `strip found unexpectedly, text="${abState.bravoStripText}"`
        : 'no strip (correct)',
      abState.bravoStripText === null,
    );

    await pageAB.__ctx.close().catch(() => {});

    // ── Probe C: "Continue designing" ────────────────────────────────────────
    console.log('\n  [C] Continue designing probe');

    // No action_name in config so cahName is empty; the "Continue designing"
    // draft-visit label path then takes priority (hasDraft=true).
    const handlerForC = {
      id: 1002,
      type: 'start_design_visit',
      config: {},
      bindings: [{ stage_key: 'sales', status_key: CONTACT_C_STATUS }],
    };

    const contactC = {
      id: CONTACT_C_ID,
      properties: {
        firstname: 'Charlie',
        lastname: 'PrivTest',
        email: 'charlie@privtest.invalid',
        hs_lead_status: CONTACT_C_STATUS,
      },
    };

    const pageC = await openCustomers(browser, memberClient.cookie, {
      contacts: [contactC],
      handlers: [handlerForC],
      inProgress: [{ id: DRAFT_VISIT_ID, contactId: CONTACT_C_ID }],
    });

    // Wait for the card to appear first so contacts are settled in the
    // React state before we trigger the draftRefreshTick.
    await pollPage(pageC, () => !!document.querySelector('#customers-results .MuiCard-root'), null, 15000);

    // Trigger draftRefreshTick via BroadcastChannel from a SEPARATE page in
    // the same browser context.  BC spec says messages are NOT delivered to
    // the sender's own browsing context, so we must use a different page.
    // We open a helper page on the same origin (so BC works), post, then
    // close it immediately.
    const helperC = await pageC.__ctx.newPage();
    await helperC.goto(`${BASE}/api/auth/user`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await helperC.evaluate(() => {
      const bc = new BroadcastChannel('design_visit_draft_changed');
      bc.postMessage({});
      bc.close();
    });
    await helperC.close().catch(() => {});

    // Now poll for "Continue designing" to appear (the draftRefreshTick
    // increment causes the draftVisitIds effect to re-run → fetches
    // in-progress → draftVisitId=77 → hasDraft=true → label renders).
    const continueSeen = await pollPage(pageC, () => {
      const cards = Array.from(document.querySelectorAll('#customers-results .MuiCard-root'));
      return cards.some(c => (c.textContent || '').includes('Continue designing')) ? 'ok' : null;
    }, null, 10000).catch(() => null);

    // Debug: capture strip state and intercepted-URL list for diagnostics.
    const cDebug = await pageC.evaluate((cId) => {
      const cards = Array.from(document.querySelectorAll('#customers-results .MuiCard-root'));
      const card = cards.find(c => (c.textContent || '').includes('Charlie PrivTest'));
      const strip = card ? card.querySelector('[role="button"]') : null;
      return {
        cardFound: !!card,
        stripFound: !!strip,
        stripText: strip ? (strip.textContent || '').trim() : null,
        // Check background — hasDraft sets '#F0FDF4' green tint
        stripBg: strip ? window.getComputedStyle(strip).backgroundColor : null,
        intercepted: window.__ccasIntercepted || [],
      };
    }, CONTACT_C_ID);

    // Log diagnostics when the probe doesn't pass — helps future debugging.
    if (!continueSeen) {
      const pageLogs = (pageC.__logs || []).filter(l => l.includes('draftVisitIds') || l.includes('in-progress') || l.includes('contacts.length'));
      console.log(`  [C] debug: cardFound=${cDebug.cardFound} stripFound=${cDebug.stripFound} stripText="${cDebug.stripText}"`);
      console.log(`  [C] intercepted=${JSON.stringify(cDebug.intercepted)}`);
      if (pageLogs.length) console.log(`  [C] effect logs:\n    ${pageLogs.join('\n    ')}`);
      else console.log(`  [C] effect logs: (none)`);
    }

    const cStripText = cDebug.stripText;

    record(
      UI_PROBE_LABELS[3],
      'action strip contains "Continue designing"',
      cStripText !== null ? `strip text="${cStripText}"` : 'no strip found',
      typeof cStripText === 'string' && cStripText.includes('Continue designing'),
    );

    await pageC.__ctx.close().catch(() => {});

    // ── Probe D: click isolation ──────────────────────────────────────────────
    console.log('\n  [D] Click isolation probe');

    const pageD = await openCustomers(browser, memberClient.cookie, {
      contacts: [contactA],
      handlers: [handlerForA],
      inProgress: [],
    });

    // Wait for the strip to appear.
    await pollPage(pageD, () => {
      const strip = document.querySelector('#customers-results [role="button"]');
      return strip ? 'ok' : null;
    }, null, 10000);

    const urlBefore = pageD.url();

    // Set up a navigation listener.  We expect NO navigation.
    let navigated = false;
    const navListener = () => { navigated = true; };
    pageD.on('framenavigated', navListener);

    // Click the action strip.
    await pageD.evaluate(() => {
      const strip = document.querySelector('#customers-results [role="button"]');
      if (strip) strip.click();
    });

    // Wait briefly to allow any navigation to start.
    await new Promise(r => setTimeout(r, 600));

    pageD.off('framenavigated', navListener);

    const urlAfter = pageD.url();
    const urlUnchanged = urlAfter === urlBefore || urlAfter.endsWith('/customers');

    record(
      UI_PROBE_LABELS[4],
      'URL remains /customers after strip click (CardActionArea NOT triggered)',
      navigated
        ? `navigation fired → url=${urlAfter}`
        : `no navigation, url=${urlAfter}`,
      !navigated && urlUnchanged,
    );

    await pageD.__ctx.close().catch(() => {});

    // ── Probe E: QB invoice badge click → InvoiceDetailDrawer opens ─────────
    console.log('\n  [E] QB invoice badge → InvoiceDetailDrawer probe');

    const invSummary = {
      id: INV_E_ID,
      docNumber: 'INV-PRIVTEST-E',
      customerName: 'Echo PrivTest',
      email: CONTACT_E_EMAIL,
      balance: 250,
      totalAmt: 500,
      dueDate: '2026-06-30',
      txnDate: '2026-05-01',
    };

    const invDetail = {
      id: INV_E_ID,
      docNumber: 'INV-PRIVTEST-E',
      customerName: 'Echo PrivTest',
      email: CONTACT_E_EMAIL,
      balance: 250,
      totalAmt: 500,
      dueDate: '2026-06-30',
      txnDate: '2026-05-01',
      syncToken: '0',
      memo: null,
      lines: [{ description: 'Test service', qty: 1, unitPrice: 500, amount: 500 }],
    };

    const contactE = {
      id: CONTACT_E_ID,
      properties: {
        firstname: 'Echo',
        lastname: 'PrivTest',
        email: CONTACT_E_EMAIL,
        hs_lead_status: 'privtest_ccas_nomatch',
      },
    };

    const pageE = await openCustomers(browser, memberClient.cookie, {
      contacts:         [contactE],
      handlers:         [],
      inProgress:       [],
      qbConnected:      true,
      qbInvoices:       [invSummary],
      qbInvoiceDetails: { [INV_E_ID]: invDetail },
    });

    // Wait for the QB badge button to appear. The qbInvoicesStore fetches
    // status+invoices asynchronously; once loaded the QBBadge renders a
    // <button> with a title containing "outstanding invoice".
    const badgeVisible = await pollPage(pageE, () => {
      const btn = document.querySelector('button[title*="outstanding invoice"]');
      return btn ? 'ok' : null;
    }, null, 12000).catch(() => null);

    if (!badgeVisible) {
      const pageLogs = (pageE.__logs || []).filter(l =>
        l.includes('invoice') || l.includes('qb') || l.includes('error') || l.includes('Error'),
      );
      const intercepted = await pageE.evaluate(() => window.__ccasIntercepted || []);
      console.log(`  [E] debug: badge not visible. intercepted=${JSON.stringify(intercepted)}`);
      if (pageLogs.length) console.log(`  [E] page logs:\n    ${pageLogs.join('\n    ')}`);
    }

    // Click the QB badge.
    await pageE.evaluate(() => {
      const btn = document.querySelector('button[title*="outstanding invoice"]');
      if (btn) btn.click();
    });

    // Wait for the InvoiceDetailDrawer to appear in the DOM
    // (data-testid="invoice-detail-drawer" is set on the MUI Drawer root).
    const drawerOpened = await pollPage(pageE, () => {
      const drawer = document.querySelector('[data-testid="invoice-detail-drawer"]');
      return drawer ? 'ok' : null;
    }, null, 8000).catch(() => null);

    const eState = await pageE.evaluate(() => {
      const drawer = document.querySelector('[data-testid="invoice-detail-drawer"]');
      const badge  = document.querySelector('button[title*="outstanding invoice"]');
      return {
        badgeFound:  !!badge,
        drawerFound: !!drawer,
        drawerOpen:  drawer ? !drawer.hasAttribute('aria-hidden') ||
          drawer.getAttribute('aria-hidden') !== 'true' : false,
        intercepted: window.__ccasIntercepted || [],
      };
    });

    if (!eState.drawerFound || !eState.drawerOpen) {
      const pageLogs = (pageE.__logs || []).filter(l =>
        l.includes('invoice') || l.includes('handleOpen') || l.includes('error'),
      );
      console.log(`  [E] debug: badgeFound=${eState.badgeFound} drawerFound=${eState.drawerFound} drawerOpen=${eState.drawerOpen}`);
      console.log(`  [E] intercepted=${JSON.stringify(eState.intercepted)}`);
      if (pageLogs.length) console.log(`  [E] page logs:\n    ${pageLogs.join('\n    ')}`);
    }

    record(
      UI_PROBE_LABELS[5],
      'InvoiceDetailDrawer present and open after badge click',
      eState.drawerFound
        ? `drawer found, open=${eState.drawerOpen}`
        : 'drawer element not found in DOM',
      eState.drawerFound && eState.drawerOpen,
    );

    await pageE.__ctx.close().catch(() => {});

    // ── Probe F: UploadPhotosModal "Generate anyway" button label ────────────
    console.log('\n  [F] UploadPhotosModal check-error button label probe');

    const handlerForF = {
      id: 1005,
      type: 'upload_photos_and_info',
      config: { action_name: 'upload_photos' },
      bindings: [{ stage_key: 'sales', status_key: CONTACT_F_STATUS }],
    };

    const contactF = {
      id: CONTACT_F_ID,
      properties: {
        firstname: 'Foxtrot',
        lastname: 'PrivTest',
        email: 'foxtrot@privtest.invalid',
        hs_lead_status: CONTACT_F_STATUS,
      },
    };

    const pageF = await openCustomers(browser, memberClient.cookie, {
      contacts:       [contactF],
      handlers:       [handlerForF],
      inProgress:     [],
      linkStatusError: true,
    });

    // Wait for the action strip to appear.
    const fStripVisible = await pollPage(pageF, () => {
      const strip = document.querySelector('#customers-results [role="button"]');
      return strip ? 'ok' : null;
    }, null, 12000).catch(() => null);

    if (!fStripVisible) {
      const intercepted = await pageF.evaluate(() => window.__ccasIntercepted || []);
      console.log(`  [F] debug: strip not visible. intercepted=${JSON.stringify(intercepted)}`);
      const fLogs = (pageF.__logs || []).filter(l =>
        l.includes('error') || l.includes('Error') || l.includes('handler'),
      );
      if (fLogs.length) console.log(`  [F] page logs:\n    ${fLogs.join('\n    ')}`);
    }

    // Click the action strip to open the UploadPhotosModal.
    await pageF.evaluate(() => {
      const strip = document.querySelector('#customers-results [role="button"]');
      if (strip) strip.click();
    });

    // Wait for the modal to reach the check-error phase, indicated by the
    // presence of the data-testid="cah-proceed-anyway" button.
    const fProceedVisible = await pollPage(pageF, () => {
      const btn = document.querySelector('[data-testid="cah-proceed-anyway"]');
      return btn ? 'ok' : null;
    }, null, 12000).catch(() => null);

    const fState = await pageF.evaluate(() => {
      const btn = document.querySelector('[data-testid="cah-proceed-anyway"]');
      return {
        buttonFound: !!btn,
        buttonText:  btn ? (btn.textContent || '').trim() : null,
        intercepted: window.__ccasIntercepted || [],
      };
    });

    if (!fState.buttonFound || !fProceedVisible) {
      const fLogs = (pageF.__logs || []).filter(l =>
        l.includes('link-status') || l.includes('check-error') || l.includes('error') || l.includes('Error'),
      );
      console.log(`  [F] debug: buttonFound=${fState.buttonFound} buttonText="${fState.buttonText}"`);
      console.log(`  [F] intercepted=${JSON.stringify(fState.intercepted)}`);
      if (fLogs.length) console.log(`  [F] page logs:\n    ${fLogs.join('\n    ')}`);
    }

    record(
      UI_PROBE_LABELS[6],
      'button text is "Generate anyway"',
      fState.buttonFound
        ? `button text="${fState.buttonText}"`
        : 'cah-proceed-anyway button not found in DOM',
      fState.buttonFound && fState.buttonText === 'Generate anyway',
    );

    record(
      UI_PROBE_LABELS[7],
      'button text does NOT contain "Send anyway"',
      fState.buttonFound
        ? `button text="${fState.buttonText}"`
        : 'cah-proceed-anyway button not found in DOM',
      fState.buttonFound && !(fState.buttonText || '').includes('Send anyway'),
    );

    await pageF.__ctx.close().catch(() => {});

  } catch (e) {
    console.error('Test error:', e);
    console.error('--- server log (last 2000 chars) ---');
    console.error(logBuf.join('').slice(-2000));
  } finally {
    try { await browser.close(); } catch {}
    const failed = findings.filter(f => !f.ok).length;
    await cleanupAndExit(failed > 0 ? 1 : 0);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(2); });
