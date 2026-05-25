'use strict';
// test/sales-board/run.js
//
// End-to-end Puppeteer test for the SalesBoardPage React component.
//
// Covers:
//   (A) Desktop two-column layout — both columns present and visible at 1280px
//   (B) Card content — contact name, stage pill, substage pill, source pill,
//       and "Updated" timestamp all appear in the card body
//   (C) Terminal card is de-emphasised — opacity ≈ 0.55 for a contact whose
//       room statusId is in TERMINAL_SUBSTAGES (e.g. 'unqualified')
//   (D) Card body click navigates to /customers/:id
//   (E) Mobile single-column — only the active column is visible at 375px;
//       the switch button is visible and clicking it reveals the other column
//   (F) Action strip renders when cardActionHandlerFor returns a handler
//   (G) Snackbar visibility pause — refresh-failure Snackbar stays visible when
//       the tab is hidden (timer paused), then dismisses after tab returns
//
// React mount timing note: SalesBoardPage is a React.lazy chunk.  The browser
// loads the chunk asynchronously after the module entry point executes.
// Puppeteer's `waitUntil:'domcontentloaded'` resolves before the lazy chunk
// has mounted.  Each probe therefore calls waitForReactMount() before
// seedSalesBoard() so the DATA_READY_EVENT listener is registered before we
// dispatch.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:sales-board
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:sales-board

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
  PASSWORD,
  BASE,
} = require('../privileges/harness');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

require('dotenv').config();

// ── Test fixtures ──────────────────────────────────────────────────────────────

const NOW = Date.now();

// Three contacts:
//   sb-test-001  Jane Smith  — sales column (no room, hs_lead_status=NEW)
//   sb-test-002  Bob Jones   — designvisit column (room: stageKey=designvisit, open_deal)
//   sb-test-003  Alice Brown — sales column, terminal (room: statusId=unqualified)
const CONTACTS = [
  {
    id: 'sb-test-001',
    properties: {
      firstname: 'Jane',
      lastname: 'Smith',
      email: 'jane@sbtest.local',
      zip: 'SW1A 1AA',
      hs_lead_status: 'NEW',
      lastmodifieddate: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
      createdate: String(NOW - 24 * 60 * 60 * 1000),
    },
  },
  {
    id: 'sb-test-002',
    properties: {
      firstname: 'Bob',
      lastname: 'Jones',
      email: 'bob@sbtest.local',
      zip: 'EC1A 1BB',
      hs_lead_status: 'OPEN_DEAL',
      lastmodifieddate: new Date(NOW - 48 * 60 * 60 * 1000).toISOString(),
      createdate: String(NOW - 2 * 24 * 60 * 60 * 1000),
    },
  },
  {
    id: 'sb-test-003',
    properties: {
      firstname: 'Alice',
      lastname: 'Brown',
      email: 'alice@sbtest.local',
      zip: 'W1A 1CC',
      hs_lead_status: 'NEW',
      lastmodifieddate: new Date(NOW - 3 * 60 * 60 * 1000).toISOString(),
      createdate: String(NOW - 3 * 24 * 60 * 60 * 1000),
    },
  },
];

const CONTACT_STAGE_CACHE = {
  'sb-test-001': [],             // No room — falls back to lead status → sales column
  'sb-test-002': [{
    stageKey: 'designvisit',
    statusId: 'open_deal',
    roomStatus: 'active',
    sourceId: 'website',
    stageDates: { designvisit: '2024-01-15' },
    substateDates: { open_deal: '2024-01-15' },
  }],
  'sb-test-003': [{
    stageKey: 'sales',
    statusId: 'unqualified',    // TERMINAL_SUBSTAGES → opacity 0.55
    roomStatus: 'active',
    sourceId: '',
    stageDates: {},
    substateDates: {},
  }],
};

const WORKFLOW = {
  stages: {
    sales:       { label: 'Sales',        statuses: [{ id: 'open', label: 'Open' }] },
    designvisit: { label: 'Design Visit', statuses: [{ id: 'open_deal', label: 'Open Deal' }] },
    survey:      { label: 'Survey',       statuses: [] },
  },
};

const LEAD_STATUS_OPTIONS = [
  { value: 'NEW',       label: 'New',       stage: 'SALES',       excluded_from_sales: false },
  { value: 'OPEN_DEAL', label: 'Open Deal', stage: 'DESIGN_VISIT', excluded_from_sales: false },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

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
  await page.setCookie({ name: kv.name, value: kv.value, domain: hostname, path: '/', httpOnly: true });
}

function findChromium() {
  const { findChromium: shared } = require('../shared/find-chromium');
  return shared() || undefined;
}

// Poll a predicate (run in page context) until it returns truthy or timeout.
async function pollPage(page, fn, arg, timeoutMs = 12000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch {}
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

// Wait for React to mount SalesBoardPage by detecting the two column divs it
// always renders (even with empty data).  The React.lazy chunk is fetched
// asynchronously, so DOMContentLoaded may fire before the component mounts.
//
// DOM structure (AppThemeProvider wraps every island in MuiScopedCssBaseline):
//   #sales-board-mount          ← React root
//     div.MuiScopedCssBaseline  ← AppThemeProvider shell
//       div (flex row)          ← SalesBoardPage outer Box  ← children.length === 2
//         div (sales col)
//         div (designvisit col)
async function waitForReactMount(page) {
  return pollPage(page, () => {
    const mount = document.getElementById('sales-board-mount');
    if (!mount) return false;
    const themed = mount.firstElementChild;          // MuiScopedCssBaseline wrapper
    if (!themed) return false;
    const board = themed.firstElementChild;          // SalesBoardPage outer Box
    if (!board) return false;
    // Two column divs are always present once SalesBoardPage has rendered.
    return board.children.length >= 2;
  }, null, 20000);
}

// Inject window.state globals then fire the DATA_READY_EVENT so the component
// re-renders with the fixture contacts.  Always call waitForReactMount() first.
async function seedSalesBoard(page, { withHandler = false } = {}) {
  await page.evaluate(
    ({ contacts, cache, workflow, lsOptions, withHandler }) => {
      window.state                    = window.state || {};
      window.state.filteredContacts   = contacts;
      window.state.contactStageCache  = cache;
      window.state.workflow           = workflow;
      window.state.user               = { privilege_level: 'admin' };
      window.LEAD_STATUS_OPTIONS      = lsOptions;
      window.LEAD_SUBSTATUSES         = [];

      if (withHandler) {
        // Return a handler for every card so the action strip always shows.
        window.cardActionHandlerFor = () => ({
          id: 999,
          type: 'summarise_phone_call',
          config: { action_name: 'call_summary' },
          bindings: [],
        });
      } else {
        window.cardActionHandlerFor = () => null;
      }
      // Stub label helpers — returning '' suppresses the fallback action strip.
      window.stageOrLeadStatusActionLabel = () => '';
      window.substatusActionLabelLookup   = () => '';

      document.dispatchEvent(new CustomEvent('sales-board-data-ready'));
    },
    { contacts: CONTACTS, cache: CONTACT_STAGE_CACHE, workflow: WORKFLOW, lsOptions: LEAD_STATUS_OPTIONS, withHandler },
  );
}

// Wait for a specific contact's card body to appear in the DOM.
async function waitForCard(page, contactId) {
  return pollPage(page, (id) => !!document.querySelector(`[data-contact-id="${id}"]`), contactId, 10000);
}

// Open /sales, wait for React to mount, seed state, and wait for a card.
// Returns { page, mounted, cardReady } — caller must close the page.
//
// Bootstrap on the sales page calls loadAllContacts() → /api/contacts-all
// and loadWorkflow() → /api/localdata/all, both of which 503 when the server
// runs without HUBSPOT_TOKEN (as the test harness does).  A 503 causes
// bootstrap() to replace #sales-view with an error message, destroying
// #sales-board-mount before React can mount into it.  We intercept those
// requests and return empty-but-valid responses so bootstrap() completes
// normally and the mount point survives.
async function openBoardPage(browser, cookie, contactId = 'sb-test-001', opts = {}) {
  const page = await browser.newPage();
  page.on('pageerror', () => {});
  page.on('console',   () => {});

  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    if (u.includes('/api/contacts-all')) {
      req.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ results: [], totalPages: 1, page: 1, total: 0 }),
      });
    } else if (u.includes('/api/localdata/all')) {
      req.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({}),
      });
    } else {
      req.continue();
    }
  });

  await injectSession(page, cookie);
  await page.goto(`${BASE}/sales`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  const mounted = await waitForReactMount(page);
  await seedSalesBoard(page, opts);
  const cardReady = contactId ? await waitForCard(page, contactId) : true;
  return { page, mounted, cardReady };
}

// ── main ──────────────────────────────────────────────────────────────────────

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

  const runId = `sb-${Date.now().toString(36)}`;
  console.log(`\n  sales-board E2E  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);
  await cleanupTestData(pool);

  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  admin=${users.admin.email}`);

  const { child, logBuf } = spawnServer();
  let exited = false;
  child.on('exit', () => { exited = true; });

  const findings = [];
  function record(name, expected, observed, ok, detail = '') {
    findings.push({ name, expected, observed, ok, detail });
    const mark = ok ? '  \u2713' : '  \u2717';
    console.log(`${mark}  ${name}`);
    if (!ok) {
      console.log(`     expected : ${expected}`);
      console.log(`     observed : ${observed}`);
      if (detail) console.log(`     detail   : ${detail}`);
    }
  }

  let teardownInFlight = false;
  async function cleanupAndExit(code) {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    process.exit(code);
  }

  process.on('SIGINT',  () => cleanupAndExit(130));
  process.on('SIGTERM', () => cleanupAndExit(130));
  process.on('uncaughtException',  (e) => { console.error('Uncaught:', e);  cleanupAndExit(2); });
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

  if (!puppeteer) {
    record('puppeteer available', 'module installed', 'not installed', false,
      'Install puppeteer: npm i -D puppeteer');
    await writeReport(findings);
    await cleanupAndExit(1);
    return;
  }

  const adminClient = await login(users.admin.email, PASSWORD);
  const executablePath = findChromium();

  // ── Desktop probes (A, B, C, D, F) at 1280×900 ──────────────────────────────
  console.log('\n  [Desktop probes]');
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      defaultViewport: { width: 1280, height: 900 },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  } catch (e) {
    record('browser launch', 'launched successfully', `error: ${e.message}`, false, e.stack || '');
    await writeReport(findings);
    await cleanupAndExit(1);
    return;
  }

  try {
    // ── (A) Two-column layout ──────────────────────────────────────────────────
    {
      let page;
      try {
        const opened = await openBoardPage(browser, adminClient.cookie);
        page = opened.page;

        if (!opened.mounted) {
          record('(A) Desktop: SalesBoardPage mounts', 'two column divs present', 'timed out (20 s)', false,
            'React.lazy chunk did not render within 20 s — rebuild with npm run build:react');
          record('(A.1) Desktop: two column containers present', '2', 'skipped', false);
          record('(A.2) Desktop: both columns visible (display ≠ none)', 'both flex', 'skipped', false);
        } else {
          const layout = await page.evaluate(() => {
            const mount = document.getElementById('sales-board-mount');
            if (!mount) return { error: 'no #sales-board-mount' };
            const themed = mount.firstElementChild;   // MuiScopedCssBaseline wrapper
            if (!themed) return { error: 'no themed wrapper' };
            const board = themed.firstElementChild;   // SalesBoardPage outer flex Box
            if (!board) return { error: 'no board container' };
            const cols = Array.from(board.children);
            return {
              count:    cols.length,
              displays: cols.map(c => window.getComputedStyle(c).display),
            };
          });
          record(
            '(A.1) Desktop: two column containers present',
            'count=2',
            layout.error || `count=${layout.count}`,
            !layout.error && layout.count === 2,
          );
          record(
            '(A.2) Desktop: both columns visible (display ≠ none)',
            'both flex',
            layout.error || `displays=${JSON.stringify(layout.displays)}`,
            !layout.error && Array.isArray(layout.displays) && layout.displays.every(d => d !== 'none'),
          );
        }
      } catch (e) {
        record('(A) Desktop two-column layout', 'no error', `error: ${e.message}`, false, e.stack || '');
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }

    // ── (B) Card content ───────────────────────────────────────────────────────
    {
      let page;
      try {
        const opened = await openBoardPage(browser, adminClient.cookie, 'sb-test-001');
        page = opened.page;

        if (!opened.cardReady) {
          for (const label of ['B.1','B.2','B.3','B.4','B.5','B.6']) {
            record(`(${label}) Card content`, 'card visible', 'timed out waiting for card', false);
          }
        } else {
          // sb-test-001: Jane Smith in the sales column
          const salesCard = await page.evaluate(() => {
            const body = document.querySelector('[data-contact-id="sb-test-001"]');
            if (!body) return { error: 'sb-test-001 card body not found' };
            const text  = body.innerText || body.textContent || '';
            const spans = Array.from(body.querySelectorAll('span'));
            return {
              hasName:      text.includes('Jane Smith'),
              hasPostcode:  text.includes('SW1A'),
              hasTime:      text.toLowerCase().includes('updated'),
              hasStagePill: spans.some(s => s.textContent.trim() === 'Sales'),
            };
          });

          record('(B.1) Card renders contact name ("Jane Smith")',
            'Jane Smith visible',
            salesCard.error || `found=${salesCard.hasName}`,
            !!salesCard.hasName);
          record('(B.2) Card renders postcode ("SW1A")',
            'SW1A visible',
            salesCard.error || `found=${salesCard.hasPostcode}`,
            !!salesCard.hasPostcode);
          record('(B.3) Card renders "Updated" timestamp',
            '"Updated …" text present',
            salesCard.error || `found=${salesCard.hasTime}`,
            !!salesCard.hasTime);
          record('(B.4) Card renders stage pill ("Sales")',
            'span with text "Sales"',
            salesCard.error || `found=${salesCard.hasStagePill}`,
            !!salesCard.hasStagePill);

          // sb-test-002: Bob Jones — Design Visit column; substage + source pills
          await waitForCard(page, 'sb-test-002');
          const dvCard = await page.evaluate(() => {
            const body = document.querySelector('[data-contact-id="sb-test-002"]');
            if (!body) return { error: 'sb-test-002 card body not found' };
            const spans = Array.from(body.querySelectorAll('span'));
            return {
              hasSubstage: spans.some(s => s.textContent.trim() === 'Open Deal'),
              hasSource:   spans.some(s => s.textContent.trim() === 'Web'),
            };
          });
          record('(B.5) Design Visit card renders substage pill ("Open Deal")',
            '"Open Deal" span',
            dvCard.error || `found=${dvCard.hasSubstage}`,
            !!dvCard.hasSubstage);
          record('(B.6) Design Visit card renders source pill ("Web")',
            '"Web" span',
            dvCard.error || `found=${dvCard.hasSource}`,
            !!dvCard.hasSource);
        }
      } catch (e) {
        record('(B) Card content', 'no error', `error: ${e.message}`, false, e.stack || '');
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }

    // ── (C) Terminal card opacity ──────────────────────────────────────────────
    {
      let page;
      try {
        const opened = await openBoardPage(browser, adminClient.cookie, 'sb-test-003');
        page = opened.page;

        if (!opened.cardReady) {
          record('(C) Terminal card has opacity ≈ 0.55', 'opacity ≈ 0.55', 'timed out waiting for card', false);
        } else {
          const termInfo = await page.evaluate(() => {
            const body = document.querySelector('[data-contact-id="sb-test-003"]');
            if (!body) return { error: 'sb-test-003 card body not found' };
            // Walk up from the card body to find the first ancestor with reduced
            // opacity. The MUI Card element gets opacity:0.55 via its sx prop.
            let el = body.parentElement;
            while (el && el.id !== 'sales-board-mount') {
              const op = parseFloat(window.getComputedStyle(el).opacity);
              if (op < 1) return { opacity: op };
              el = el.parentElement;
            }
            return { opacity: 1, note: 'no reduced-opacity ancestor found' };
          });
          const opacityOk = !termInfo.error
            && typeof termInfo.opacity === 'number'
            && Math.abs(termInfo.opacity - 0.55) < 0.05;
          record(
            '(C) Terminal card (statusId=unqualified) has opacity ≈ 0.55',
            'opacity ≈ 0.55',
            termInfo.error || `opacity=${termInfo.opacity}${termInfo.note ? ' (' + termInfo.note + ')' : ''}`,
            opacityOk,
          );
        }
      } catch (e) {
        record('(C) Terminal card opacity', 'no error', `error: ${e.message}`, false, e.stack || '');
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }

    // ── (D) Card click navigates to /customers/:id ─────────────────────────────
    {
      let page;
      try {
        const opened = await openBoardPage(browser, adminClient.cookie, 'sb-test-001');
        page = opened.page;

        if (!opened.cardReady) {
          record('(D) Card click navigates to /customers/:id', 'navigation to /customers/sb-test-001', 'timed out', false);
        } else {
          const expectedPath = '/customers/sb-test-001';
          let navigatedTo = null;
          page.on('request', req => {
            if (req.isNavigationRequest() && req.resourceType() === 'document') {
              navigatedTo = req.url();
            }
          });
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => null),
            page.click('[data-contact-id="sb-test-001"]'),
          ]);
          const navOk = !!navigatedTo && navigatedTo.includes(expectedPath);
          record(
            '(D) Card click navigates to /customers/:id',
            `URL contains ${expectedPath}`,
            navigatedTo || 'no navigation request captured',
            navOk,
          );
        }
      } catch (e) {
        record('(D) Card click navigation', 'no error', `error: ${e.message}`, false, e.stack || '');
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }

    // ── (F) Action strip renders with handler ──────────────────────────────────
    {
      let page;
      try {
        // Open with handler enabled — all non-terminal cards get an action strip.
        const opened = await openBoardPage(browser, adminClient.cookie, 'sb-test-001', { withHandler: true });
        page = opened.page;

        if (!opened.cardReady) {
          record('(F) Action strip renders when handler configured', 'strip visible', 'timed out', false);
        } else {
          // Dispatch a second event so React re-renders with the updated
          // cardActionHandlerFor function that was injected by seedSalesBoard.
          await page.evaluate(() => {
            document.dispatchEvent(new CustomEvent('sales-board-data-ready'));
          });
          await new Promise(r => setTimeout(r, 800));

          // The action strip carries data-card-action-handler-id and shows the
          // title-cased action_name: 'call_summary' → 'Call Summary'.
          const stripInfo = await page.evaluate(() => {
            const strip = document.querySelector('[data-card-action-handler-id="999"]');
            if (!strip) return { found: false };
            return { found: true, text: (strip.textContent || '').trim() };
          });

          record(
            '(F) Action strip renders when cardActionHandlerFor returns a handler',
            '"Call Summary" in action strip with data-card-action-handler-id="999"',
            stripInfo.found ? `text="${stripInfo.text}"` : 'strip not found in DOM',
            stripInfo.found && (stripInfo.text || '').includes('Call Summary'),
          );
        }
      } catch (e) {
        record('(F) Action strip', 'no error', `error: ${e.message}`, false, e.stack || '');
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }

    // ── (G) Snackbar visibility pause (tab-hide) ──────────────────────────────
    // Probe G: dispatch the sales-board-bg-refresh-failed event to trigger the
    // warning Snackbar, then simulate the document going hidden.  The MUI
    // Snackbar must still be visible after the 8 s autoHideDuration has elapsed
    // (proving the timer was paused), then auto-dismiss once the tab returns to
    // the foreground.
    {
      let page;
      try {
        const opened = await openBoardPage(browser, adminClient.cookie, 'sb-test-001');
        page = opened.page;

        if (!opened.mounted) {
          record('(G.1) Snackbar probe — board mounted', 'mounted', 'timed out', false);
          record('(G.2) Snackbar paused while tab hidden (>8 s)', 'skipped', 'board not mounted', false);
          record('(G.3) Snackbar dismisses after tab returns visible', 'skipped', 'board not mounted', false);
        } else {
          // Dispatch the refresh-failure event directly — mirrors what sales.js
          // does when loadAllContacts() throws inside the localdata-updated handler.
          await page.evaluate(() => {
            document.dispatchEvent(new CustomEvent('sales-board-bg-refresh-failed'));
          });

          // Step 1: Snackbar must appear.
          const snackbarAppeared = await pollPage(page, () => {
            const alerts = Array.from(document.querySelectorAll('[role="alert"]'));
            return alerts.some(el =>
              (el.textContent || '').includes("Couldn't refresh live data")
            ) ? 'visible' : null;
          }, null, 8000);

          if (snackbarAppeared !== 'visible') {
            record('(G.1) "Couldn\'t refresh live data" Snackbar appears', 'visible', `snackbar=${snackbarAppeared}`, false);
            record('(G.2) Snackbar paused while tab hidden (>8 s)', 'skipped', 'snackbar never appeared', false);
            record('(G.3) Snackbar dismisses after tab returns visible', 'skipped', 'snackbar never appeared', false);
          } else {
            record('(G.1) "Couldn\'t refresh live data" Snackbar appears', 'visible', 'visible', true);

            // Step 2: Simulate the tab going hidden.
            await page.evaluate(() => {
              Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
              Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
              document.dispatchEvent(new Event('visibilitychange'));
            });

            // Step 3: Wait 9.5 s (> 8 s autoHideDuration). If the pause were
            // broken the Snackbar would have dismissed by now.
            await new Promise(r => setTimeout(r, 9500));

            const stillVisible = await page.evaluate(() => {
              const alerts = Array.from(document.querySelectorAll('[role="alert"]'));
              return alerts.some(el =>
                (el.textContent || '').includes("Couldn't refresh live data")
              );
            }).catch(() => false);

            record(
              '(G.2) Snackbar paused while tab hidden (>8 s)',
              'still visible (timer paused)',
              stillVisible ? 'still visible — timer paused (good)' : 'already dismissed — timer NOT paused (bad)',
              stillVisible,
            );

            // Step 4: Restore the tab to visible.
            await page.evaluate(() => {
              Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
              Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
              document.dispatchEvent(new Event('visibilitychange'));
            });

            // Step 5: Snackbar must now auto-dismiss (8 s timer restarts).
            // Allow up to 12 s (8 s autoHide + animation buffer).
            const dismissDeadline = Date.now() + 12000;
            let gone = false;
            while (Date.now() < dismissDeadline) {
              const still = await page.evaluate(() => {
                const alerts = Array.from(document.querySelectorAll('[role="alert"]'));
                return alerts.some(el =>
                  (el.textContent || '').includes("Couldn't refresh live data")
                );
              }).catch(() => true);
              if (!still) { gone = true; break; }
              await new Promise(r => setTimeout(r, 100));
            }

            record(
              '(G.3) Snackbar dismisses after tab returns visible',
              'dismissed within 12 s of tab-show',
              gone ? 'dismissed (good)' : 'still visible after 12 s (bad)',
              gone,
            );
          }
        }
      } catch (e) {
        record('(G) Snackbar visibility pause', 'no error', `error: ${e.message}`, false, e.stack || '');
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }

  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  // ── Mobile probes (E) at 375×812 ────────────────────────────────────────────
  console.log('\n  [Mobile probes]');
  let mobileBrowser;
  try {
    mobileBrowser = await puppeteer.launch({
      headless: true,
      executablePath,
      defaultViewport: { width: 375, height: 812 },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  } catch (e) {
    record('mobile browser launch', 'launched successfully', `error: ${e.message}`, false, e.stack || '');
    await writeReport(findings);
    await cleanupAndExit(1);
    return;
  }

  try {
    let page;
    try {
      const opened = await openBoardPage(mobileBrowser, adminClient.cookie, 'sb-test-001');
      page = opened.page;

      if (!opened.mounted) {
        for (const label of ['E.1','E.2','E.3']) {
          record(`(${label}) Mobile layout`, 'board mounted', 'timed out', false);
        }
      } else if (!opened.cardReady) {
        for (const label of ['E.1','E.2','E.3']) {
          record(`(${label}) Mobile layout`, 'card visible', 'timed out', false);
        }
      } else {
        const mobileLayout = await page.evaluate(() => {
          const mount = document.getElementById('sales-board-mount');
          if (!mount) return { error: 'no #sales-board-mount' };
          const themed = mount.firstElementChild;   // MuiScopedCssBaseline wrapper
          if (!themed) return { error: 'no themed wrapper' };
          const outer = themed.firstElementChild;   // SalesBoardPage outer flex Box
          if (!outer) return { error: 'no outer box' };
          const cols     = Array.from(outer.children);
          const displays = cols.map(c => window.getComputedStyle(c).display);

          // Switch buttons use display:{xs:'flex',md:'none'}.  A button inside
          // a column with display:none has a zero bounding rect even though its
          // own computed display is flex — filter by actual rendered size.
          const allBtns = Array.from(document.querySelectorAll('#sales-board-mount button'));
          const visibleBtns = allBtns.filter(b => {
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });

          return {
            count:          cols.length,
            displays,
            visibleCount:   displays.filter(d => d !== 'none').length,
            hiddenCount:    displays.filter(d => d === 'none').length,
            switchBtnCount: visibleBtns.length,
          };
        });

        record(
          '(E.1) Mobile: only one column is visible',
          'visibleCount=1, hiddenCount=1',
          mobileLayout.error || `visible=${mobileLayout.visibleCount} hidden=${mobileLayout.hiddenCount}`,
          !mobileLayout.error && mobileLayout.visibleCount === 1 && mobileLayout.hiddenCount === 1,
        );
        record(
          '(E.2) Mobile: switch button has non-zero size (visible)',
          'at least 1 visible switch button',
          mobileLayout.error || `count=${mobileLayout.switchBtnCount}`,
          !mobileLayout.error && mobileLayout.switchBtnCount >= 1,
        );

        // Click the visible switch button and verify the active column changes.
        const prevDisplays = mobileLayout.displays || [];
        const clicked = await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('#sales-board-mount button')).find(b => {
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          if (!btn) return false;
          btn.click();
          return true;
        });

        if (clicked) {
          await new Promise(r => setTimeout(r, 500));   // allow React state update

          const afterDisplays = await page.evaluate(() => {
            const mount = document.getElementById('sales-board-mount');
            const themed = mount && mount.firstElementChild;
            const outer  = themed && themed.firstElementChild;
            if (!outer) return null;
            return Array.from(outer.children).map(c => window.getComputedStyle(c).display);
          });

          // Exactly one column should now be visible, and the previously-active
          // first column (index 0) should have changed state.
          const switchWorked = Array.isArray(afterDisplays)
            && afterDisplays.filter(d => d !== 'none').length === 1
            && afterDisplays[0] !== prevDisplays[0];

          record(
            '(E.3) Mobile: switch button toggles active column',
            'previously-visible column is now hidden',
            afterDisplays ? `before=${JSON.stringify(prevDisplays)} after=${JSON.stringify(afterDisplays)}` : 'null',
            switchWorked,
          );
        } else {
          record('(E.3) Mobile: switch button toggles active column',
            'button found and clickable', 'no visible button found or click failed', false);
        }
      }
    } catch (e) {
      record('(E) Mobile probes', 'no error', `error: ${e.message}`, false, e.stack || '');
    } finally {
      if (page) await page.close().catch(() => {});
    }
  } finally {
    if (mobileBrowser) await mobileBrowser.close().catch(() => {});
  }

  // ── Results ───────────────────────────────────────────────────────────────────
  const pass = findings.filter(f => f.ok).length;
  const fail = findings.filter(f => !f.ok).length;
  console.log(`\n  Results: ${pass} passed, ${fail} failed`);
  await writeReport(findings);
  await cleanupAndExit(fail > 0 ? 1 : 0);
}

async function writeReport(findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Sales Board — E2E Test Report',
    '',
    `- Date: ${new Date().toISOString()}`,
    '- Command: `npm run test:sales-board`',
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
    '- **(A)** Desktop two-column layout: both MUI column containers present',
    '  and `display ≠ none` at 1280 × 900 px',
    '- **(B)** Card content: contact name, postcode, stage pill, substage pill,',
    '  source pill, and "Updated …" timestamp all appear in the card body',
    '- **(C)** Terminal card de-emphasis: ancestor element has `opacity ≈ 0.55`',
    "  when the contact's room `statusId` is in `TERMINAL_SUBSTAGES`",
    '  (e.g. `unqualified`)',
    '- **(D)** Card body click navigates to `/customers/:id`',
    '- **(E)** Mobile single-column (375 px): only the active column is visible;',
    '  the switch button has a non-zero bounding rect; clicking it reveals the',
    '  other column',
    '- **(F)** Action strip renders with the correct action name when',
    '  `cardActionHandlerFor` returns a handler',
    '- **(G)** Snackbar visibility pause: dispatching `sales-board-bg-refresh-failed`',
    '  shows the warning Snackbar; simulating tab-hide proves the MUI',
    '  autoHideDuration timer is paused (Snackbar still visible after 9.5 s > 8 s),',
    '  then auto-dismisses once the tab returns to the foreground.',
    '',
    '## React mount timing',
    '',
    '`SalesBoardPage` is a `React.lazy` chunk.  Each probe calls',
    '`waitForReactMount()` (polls for two column divs up to 20 s) before',
    'seeding `window.state` and dispatching `sales-board-data-ready`, so the',
    'component event listener is guaranteed to be registered before the event',
    'fires.',
    '',
    '## Relevant files',
    '',
    '- `src/react/pages/SalesBoardPage.tsx` — React component under test',
    '- `public/sales.html` — page that mounts the component',
    '- `public/sales.js` — dispatches `sales-board-data-ready` and',
    '  `sales-board-bg-refresh-failed` (on error) after data load',
  ];
  const outPath = path.join(dir, 'sales-board.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Report: test-results/sales-board.md`);
}

main();
