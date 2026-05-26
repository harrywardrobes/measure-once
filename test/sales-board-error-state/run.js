'use strict';
// test/sales-board-error-state/run.js
//
// End-to-end Puppeteer test for SalesBoardPage error and stale-data states.
//
// Covers:
//   (A) Bootstrap failure — cold cache, HubSpot unavailable.
//       core.js catches the error, sets window.__salesBoardBootstrapFailed,
//       and dispatches 'sales-board-bootstrap-failed'. Unlike other pages, it
//       does NOT replace #sales-view innerHTML, so #sales-board-mount survives.
//       SalesBoardPage reads the flag synchronously (initial useState) and the
//       event listener catches it when the event fires first. Either way, the
//       error card is rendered: "HubSpot is currently unavailable" heading +
//       "Reload page" button. No contact cards appear.
//
//   (B) Pre-seeded window flag — race-condition path where bootstrap fires the
//       event before the React lazy chunk has finished loading. The component
//       reads window.__salesBoardBootstrapFailed synchronously as its initial
//       state, so the error card renders as soon as the chunk mounts — without
//       the event ever reaching the component's listener.
//       We simulate this via evaluateOnNewDocument (sets the flag before any
//       page script runs) plus request interception that returns valid-but-
//       empty responses so the regular bootstrap path also completes without
//       side effects.
//
//   (C) Stale contacts — stale-but-present data (server returns 200 with
//       X-Cache-Status: stale). The board should render contact cards, not
//       the error state. The stale Snackbar may appear as a secondary concern;
//       the primary assertion is that no error card is present and at least
//       one contact card is visible.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:sales-board-error-state
//   PRIVTEST_ALLOW_SHARED_DB=1    npm run test:sales-board-error-state

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

// ── Fixtures ───────────────────────────────────────────────────────────────────

const NOW = Date.now();

const CONTACTS = [
  {
    id: 'sbe-test-001',
    properties: {
      firstname: 'Stale',
      lastname: 'User',
      email: 'stale@sbetest.local',
      zip: 'E1 1AA',
      hs_lead_status: 'NEW',
      lastmodifieddate: new Date(NOW - 60 * 60 * 1000).toISOString(),
      createdate: String(NOW - 24 * 60 * 60 * 1000),
    },
  },
];

const CONTACT_STAGE_CACHE = {
  'sbe-test-001': [],
};

const WORKFLOW = {
  stages: {
    sales:       { label: 'Sales',        statuses: [] },
    designvisit: { label: 'Design Visit', statuses: [] },
    survey:      { label: 'Survey',       statuses: [] },
  },
};

const LEAD_STATUS_OPTIONS = [
  { value: 'NEW', label: 'New', stage: 'SALES', excluded_from_sales: false },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function findChromium() {
  const { findChromium: shared } = require('../shared/find-chromium');
  return shared() || undefined;
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
  await page.setCookie({ name: kv.name, value: kv.value, domain: hostname, path: '/', httpOnly: true });
}

// Poll an in-page predicate until it returns truthy or timeout.
async function pollPage(page, fn, arg, timeoutMs = 15000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch {}
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

// Wait for text to appear inside #sales-board-mount (case-insensitive substring).
async function waitForMountText(page, text, timeoutMs = 20000) {
  return pollPage(page, (t) => {
    const mount = document.getElementById('sales-board-mount');
    if (!mount) return false;
    return (mount.innerText || mount.textContent || '').includes(t);
  }, text, timeoutMs);
}

// Wait for #sales-board-mount to contain at least one element with the given
// text and for that element to be an h6 (the error heading).
async function waitForErrorHeading(page, timeoutMs = 20000) {
  return pollPage(page, () => {
    const mount = document.getElementById('sales-board-mount');
    if (!mount) return false;
    // Check for the h6 heading with the known error text.
    const h6s = Array.from(mount.querySelectorAll('h6, [class*="h6"]'));
    if (h6s.some(el => (el.textContent || '').includes('HubSpot is currently unavailable'))) {
      return true;
    }
    // Fallback: any element with the text (MUI Typography may render as a div).
    return (mount.innerText || mount.textContent || '').includes('HubSpot is currently unavailable');
  }, null, timeoutMs);
}

// Wait for the mount to contain a button with "Reload page" text.
async function waitForReloadButton(page, timeoutMs = 5000) {
  return pollPage(page, () => {
    const mount = document.getElementById('sales-board-mount');
    if (!mount) return false;
    return Array.from(mount.querySelectorAll('button')).some(
      b => (b.textContent || '').trim() === 'Reload page',
    );
  }, null, timeoutMs);
}

// Wait for at least one contact card to appear in the mount.
async function waitForContactCard(page, contactId, timeoutMs = 12000) {
  return pollPage(page, (id) => !!document.querySelector(`[data-contact-id="${id}"]`), contactId, timeoutMs);
}

// Wait for SalesBoardPage to mount in normal (non-error) mode: the board
// renders a two-column flex container under the MuiScopedCssBaseline wrapper.
async function waitForNormalMount(page, timeoutMs = 20000) {
  return pollPage(page, () => {
    const mount = document.getElementById('sales-board-mount');
    if (!mount) return false;
    const themed = mount.firstElementChild;
    if (!themed) return false;
    const board = themed.firstElementChild;
    if (!board) return false;
    return board.children.length >= 2;
  }, null, timeoutMs);
}

// ── Main ───────────────────────────────────────────────────────────────────────

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

  // Verify the React bundle exists before bothering with the server.
  const bundlePath = path.resolve(__dirname, '..', '..', 'public', 'react', 'main.js');
  if (!fs.existsSync(bundlePath)) {
    console.error(
      '\n  ✘ public/react/main.js is missing.\n'
      + '    Run `npm run build:react` before this test.\n',
    );
    process.exit(2);
  }

  const runId = `sbe-${Date.now().toString(36)}`;
  console.log(`\n  sales-board-error-state E2E  run=${runId}`);
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
    const mark = ok ? '  ✓' : '  ✗';
    console.log(`${mark}  ${name}`);
    if (!ok) {
      console.log(`     expected : ${expected}`);
      console.log(`     observed : ${observed}`);
      if (detail) console.log(`     detail   : ${detail}`);
    }
  }

  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    process.exit(code);
  };

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
    // ── (A) Bootstrap failure: error card appears ──────────────────────────────
    // Navigate to /sales without intercepting API calls. The test harness
    // strips HUBSPOT_TOKEN, so /api/contacts-all returns 503. bootstrap()
    // catches the error and — specifically for the sales page — dispatches
    // 'sales-board-bootstrap-failed' and sets window.__salesBoardBootstrapFailed
    // WITHOUT replacing #sales-view innerHTML (unlike the customers page).
    // SalesBoardPage reads the flag synchronously or catches the event and
    // renders the error card.
    console.log('\n  [A] Bootstrap failure error card');
    {
      let page;
      try {
        page = await browser.newPage();
        page.on('pageerror', () => {});
        page.on('console',   () => {});

        await injectSession(page, adminClient.cookie);
        await page.goto(`${BASE}/sales`, { waitUntil: 'domcontentloaded', timeout: 20000 });

        // Wait for bootstrap to fail and the flag to be set (up to 15 s).
        const flagSet = await pollPage(page, () =>
          !!(window.__salesBoardBootstrapFailed), null, 15000,
        );
        record(
          '(A.1) window.__salesBoardBootstrapFailed set after bootstrap',
          'flag is truthy within 15 s',
          flagSet ? 'flag set' : 'not set within 15 s',
          !!flagSet,
        );

        // Wait for the error heading inside the React island.
        const headingVisible = await waitForErrorHeading(page, 20000);
        record(
          '(A.2) "HubSpot is currently unavailable" heading inside #sales-board-mount',
          '"HubSpot is currently unavailable" text present',
          headingVisible ? 'text found' : 'text not found within 20 s',
          !!headingVisible,
          headingVisible ? '' : 'Ensure npm run build:react has been run and core.js dispatches the event',
        );

        // Verify "Reload page" button.
        const reloadBtn = await waitForReloadButton(page, 8000);
        record(
          '(A.3) "Reload page" button present in error card',
          'button with text "Reload page"',
          reloadBtn ? 'button found' : 'button not found within 8 s',
          !!reloadBtn,
        );

        // Verify no contact cards are rendered (error state only).
        const hasCards = await page.evaluate(() => {
          return !!document.querySelector('[data-contact-id]');
        });
        record(
          '(A.4) No contact cards present in error state',
          'zero [data-contact-id] elements',
          hasCards ? 'contact card(s) found' : 'no contact cards (correct)',
          !hasCards,
        );

        // Verify #sales-board-mount still exists (was not destroyed by bootstrap).
        const mountExists = await page.evaluate(() => !!document.getElementById('sales-board-mount'));
        record(
          '(A.5) #sales-board-mount preserved after bootstrap failure',
          '#sales-board-mount exists in DOM',
          mountExists ? 'mount exists' : 'mount was destroyed',
          !!mountExists,
        );
      } catch (e) {
        record('(A) Bootstrap failure error card', 'no error', `error: ${e.message}`, false, e.stack || '');
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }

    // ── (B) Pre-seeded window flag: error shows on initial mount ───────────────
    // Use evaluateOnNewDocument to set window.__salesBoardBootstrapFailed before
    // any page script runs. Intercept API calls so regular bootstrap completes
    // without side effects. The React component reads the flag synchronously in
    // useState initialiser → error card renders immediately on mount.
    console.log('\n  [B] Pre-seeded window flag (race-condition path)');
    {
      let page;
      try {
        page = await browser.newPage();
        page.on('pageerror', () => {});
        page.on('console',   () => {});

        // Pre-seed the failure flag before the page runs any scripts.
        await page.evaluateOnNewDocument(() => {
          window.__salesBoardBootstrapFailed = {
            code: 'HUBSPOT_ERROR',
            message: 'Simulated HubSpot failure (pre-seeded for test)',
          };
        });

        // Intercept API calls so bootstrap completes without touching the DOM
        // (the pre-seeded flag is what we want the component to pick up, not
        // a real bootstrap failure that might race with our assertion).
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

        await injectSession(page, adminClient.cookie);
        await page.goto(`${BASE}/sales`, { waitUntil: 'domcontentloaded', timeout: 20000 });

        // The component reads the flag synchronously — error card should appear
        // as soon as the React lazy chunk mounts (no event needed).
        const headingVisible = await waitForErrorHeading(page, 20000);
        record(
          '(B.1) Error card appears from pre-seeded window.__salesBoardBootstrapFailed',
          '"HubSpot is currently unavailable" text in #sales-board-mount',
          headingVisible ? 'text found' : 'text not found within 20 s',
          !!headingVisible,
        );

        const reloadBtn = await waitForReloadButton(page, 5000);
        record(
          '(B.2) "Reload page" button present when flag is pre-seeded',
          'button with text "Reload page"',
          reloadBtn ? 'button found' : 'button not found within 5 s',
          !!reloadBtn,
        );
      } catch (e) {
        record('(B) Pre-seeded flag error state', 'no error', `error: ${e.message}`, false, e.stack || '');
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }

    // ── (C) Stale contacts: board renders cards, not error state ───────────────
    // Intercept API calls to return contacts with a stale cache header.
    // The board should render contact cards and NOT show the error card.
    // Seeding happens the same way as in test/sales-board/run.js: we wait for
    // the normal two-column mount, then seed window.state and dispatch
    // 'sales-board-data-ready'. After seeding, we also dispatch
    // 'sales-board-cache-status' with stale:true to simulate the stale path.
    console.log('\n  [C] Stale contacts render cards (not error state)');
    {
      let page;
      try {
        page = await browser.newPage();
        page.on('pageerror', () => {});
        page.on('console',   () => {});

        await page.setRequestInterception(true);
        page.on('request', req => {
          const u = req.url();
          if (u.includes('/api/contacts-all')) {
            req.respond({
              status: 200,
              contentType: 'application/json',
              headers: { 'X-Cache-Status': 'stale' },
              body: JSON.stringify({ results: CONTACTS, totalPages: 1, page: 1, total: CONTACTS.length }),
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

        await injectSession(page, adminClient.cookie);
        await page.goto(`${BASE}/sales`, { waitUntil: 'domcontentloaded', timeout: 20000 });

        // Wait for React to mount in normal (two-column) mode.
        const mounted = await waitForNormalMount(page, 20000);
        if (!mounted) {
          record('(C.0) SalesBoardPage mounts in normal mode for stale fixture',
            'two column divs present within 20 s', 'timed out', false,
            'Check build: npm run build:react');
          record('(C.1) Contact card visible with stale data', 'card present', 'skipped', false);
          record('(C.2) No error card with stale data', 'no error card', 'skipped', false);
        } else {
          // Seed window.state and trigger a render.
          await page.evaluate(
            ({ contacts, cache, workflow, lsOptions }) => {
              window.state                   = window.state || {};
              window.state.filteredContacts  = contacts;
              window.state.contactStageCache = cache;
              window.state.workflow          = workflow;
              window.state.user              = { privilege_level: 'admin' };
              window.LEAD_STATUS_OPTIONS     = lsOptions;
              window.LEAD_SUBSTATUSES        = [];
              window.cardActionHandlerFor    = () => null;
              window.stageOrLeadStatusActionLabel = () => '';
              window.substatusActionLabelLookup   = () => '';

              // Simulate the stale-cache status event that sales.js would dispatch
              // when it sees X-Cache-Status: stale from /api/contacts-all.
              document.dispatchEvent(
                new CustomEvent('sales-board-cache-status', { detail: { stale: true } }),
              );
              // Notify the React component to re-render with the seeded contacts.
              document.dispatchEvent(new CustomEvent('sales-board-data-ready'));
            },
            { contacts: CONTACTS, cache: CONTACT_STAGE_CACHE, workflow: WORKFLOW, lsOptions: LEAD_STATUS_OPTIONS },
          );

          // Wait for the contact card.
          const cardVisible = await waitForContactCard(page, 'sbe-test-001', 10000);
          record(
            '(C.1) Contact card visible when data is stale',
            '[data-contact-id="sbe-test-001"] present',
            cardVisible ? 'card found' : 'card not found within 10 s',
            !!cardVisible,
          );

          // Verify the error card is absent.
          const errorCardPresent = await page.evaluate(() => {
            const mount = document.getElementById('sales-board-mount');
            if (!mount) return false;
            return (mount.innerText || mount.textContent || '').includes('HubSpot is currently unavailable');
          });
          record(
            '(C.2) Error card absent when stale contacts are available',
            '"HubSpot is currently unavailable" NOT in mount',
            errorCardPresent ? 'error card found (wrong)' : 'no error card (correct)',
            !errorCardPresent,
          );
        }
      } catch (e) {
        record('(C) Stale contacts render cards', 'no error', `error: ${e.message}`, false, e.stack || '');
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  await writeReport(findings);

  const failed = findings.filter(f => !f.ok).length;
  console.log(`\n  ${findings.filter(f => f.ok).length}/${findings.length} passed`);
  await cleanupAndExit(failed > 0 ? 1 : 0);
}

function esc(s) {
  return String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

async function writeReport(findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });

  const lines = [
    '# Sales Board Error State — E2E Test Report',
    '',
    `- Date: ${new Date().toISOString()}`,
    '- Command: `npm run test:sales-board-error-state`',
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
    '- **(A) Bootstrap failure error card**: Navigate to `/sales` without intercepting',
    '  API calls. The test harness strips `HUBSPOT_TOKEN`, so bootstrap fails.',
    '  `core.js` dispatches `sales-board-bootstrap-failed` without replacing',
    '  `#sales-view` innerHTML. SalesBoardPage renders:',
    '  - "HubSpot is currently unavailable" heading',
    '  - "Reload page" button',
    '  - No contact cards',
    '  - `#sales-board-mount` still in DOM',
    '',
    '- **(B) Pre-seeded window flag (race-condition path)**: Sets',
    '  `window.__salesBoardBootstrapFailed` via `evaluateOnNewDocument` before',
    '  any page script runs. The React component reads the flag synchronously',
    '  in its `useState` initialiser. Error card renders immediately on mount,',
    '  without needing the event to fire.',
    '',
    '- **(C) Stale contacts render cards**: Intercepts `/api/contacts-all` to',
    '  return contacts with `X-Cache-Status: stale`. Seeds `window.state` and',
    '  dispatches `sales-board-cache-status` (`stale: true`) + `sales-board-data-ready`.',
    '  Asserts: contact card present, no error card.',
    '',
    '## Relevant files',
    '',
    '- `src/react/pages/SalesBoardPage.tsx` — `bootstrapFailed` state + error card UI',
    '- `public/core.js` — bootstrap error handler dispatches `sales-board-bootstrap-failed`',
    '- `server.js` — `getSharedContactsCache` stale fallback (lines ~541–591)',
  ];

  const outPath = path.join(dir, 'sales-board-error-state.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Report: test-results/sales-board-error-state.md`);
}

main();
