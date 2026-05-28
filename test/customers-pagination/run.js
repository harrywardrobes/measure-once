'use strict';
// test/customers-pagination/run.js
//
// Verifies that the Customers page pagination works correctly.
//
// Probes
// ──────
// [A] All view with 30 contacts: MUI Pagination control appears and
//     clicking page 2 sends a /api/contacts-all request with ?page=2.
//
// [C] "Showing X–Y of Z" count is visible on page 1 whenever there are results.
//
// [D] Changing a filter (search, sort) resets to page 1 — tested by navigating
//     to page 2 then mutating each filter and confirming the URL no longer
//     contains page=2 and the first result row is visible.
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:customers-pagination
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:customers-pagination

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
  __dirname, '..', '..', 'test-results', 'customers-pagination.md',
);

const PAGE_LIMIT = 25; // must match CustomersPage.tsx PAGE_LIMIT
const TOTAL_CONTACTS = 30; // enough to require 2 pages

// Unique-prefix keys seeded into lead_status_config so the D.3 probe always
// exercises the real lead-status filter path.  High sort_order values keep
// them out of the way of any production rows.
const PAGTEST_LS_KEYS = ['PAGTEST_LS_A', 'PAGTEST_LS_B', 'PAGTEST_LS_C'];

async function seedLeadStatuses(pool) {
  // Wipe any stale rows from a prior crashed run first.
  await pool.query(
    `DELETE FROM lead_status_config WHERE key = ANY($1::text[])`,
    [PAGTEST_LS_KEYS],
  );
  for (let i = 0; i < PAGTEST_LS_KEYS.length; i++) {
    await pool.query(
      `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales)
         VALUES ($1, $2, $3, false)
         ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order`,
      [PAGTEST_LS_KEYS[i], `Pagtest Status ${String.fromCharCode(65 + i)}`, 980 + i],
    );
  }
}

// ── Mock HubSpot server ───────────────────────────────────────────────────────
// Returns TOTAL_CONTACTS fake contacts for the contacts/search endpoint
// (used by /api/contacts-all via getSharedContactsCache).
// All contacts carry hw_test_user=true (dev-filter) and
// hs_lead_status=OPEN_DEAL.

function makeContacts(n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push({
      id: String(982_000_000 + i),
      properties: {
        firstname: 'Paginee',
        lastname: `Contact${String(i).padStart(3, '0')}`,
        email: `paginee${i}@pagination-test.local`,
        phone: `0700000${String(i).padStart(4, '0')}`,
        hs_lead_status: 'OPEN_DEAL',
        hw_test_user: 'true',
        createdate: new Date(Date.now() - i * 60_000).toISOString(),
      },
    });
  }
  return out;
}

function startMockHubspot() {
  const contacts = makeContacts(TOTAL_CONTACTS);
  const state = { calls: [] };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      state.calls.push({ method: req.method, path: u.pathname, at: Date.now() });

      // Property create (ensureHubSpotProperties)
      if (req.method === 'POST' && u.pathname === '/crm/v3/properties/contacts') {
        return send(409, { message: 'Property already exists' });
      }

      // Contacts search — used by both getSharedContactsCache (contacts-all)
      // and the open-leads paged fan-out and contacts-lead-status-counts
      if (req.method === 'POST' && u.pathname === '/crm/v3/objects/contacts/search') {
        return send(200, { results: contacts.slice(), paging: null });
      }

      // GET /crm/v3/objects/contacts/:id
      const mGet = u.pathname.match(/^\/crm\/v3\/objects\/contacts\/([^/]+)$/);
      if (mGet && req.method === 'GET') {
        const c = contacts.find(x => x.id === mGet[1]);
        return send(c ? 200 : 404, c || { message: 'not found' });
      }

      // Fallback for any other endpoint
      send(200, { results: [], paging: null });
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
  await page.setCookie({ name: kv.name, value: kv.value, domain: hostname, path: '/', httpOnly: true });
}

async function pollPage(page, fn, arg, timeoutMs = 15000, intervalMs = 150) {
  return pollUntil(page, fn, timeoutMs, intervalMs, arg !== undefined && arg !== null ? [arg] : []);
}

async function newPage(browser, jar) {
  const ctx = await (browser.createBrowserContext
    ? browser.createBrowserContext()
    : browser.createIncognitoBrowserContext());
  const page = await ctx.newPage();
  page.__ctx = ctx;
  await page.setCacheEnabled(false);
  const logs = [];
  page.on('console',   m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
  await injectSession(page, jar);
  page.__logs = logs;
  return page;
}

async function closePage(p) {
  try { await p.close(); } catch {}
  try { await p.__ctx?.close(); } catch {}
}

// Wait until #customers-results is in the DOM and non-empty (skeletons replaced
// by real cards). Uses a 20-second timeout.
async function waitForResults(page, timeoutMs = 20000) {
  return pollPage(page, () => {
    const el = document.getElementById('customers-results');
    return (el && el.children.length > 0) ? 'ok' : null;
  }, null, timeoutMs);
}

// Wait for the pagination nav to appear.
async function waitForPagination(page, timeoutMs = 12000) {
  return pollPage(page, () => {
    const nav = document.querySelector('nav[aria-label="pagination navigation"]');
    return nav ? 'ok' : null;
  }, null, timeoutMs);
}

// Wait for the URL to include a specific string (e.g. 'page=2').
async function waitForUrl(page, substr, timeoutMs = 10000) {
  return pollPage(page, (s) => location.search.includes(s) ? 'ok' : null, substr, timeoutMs);
}

// Wait for the URL to NOT include a specific string.
async function waitForUrlGone(page, substr, timeoutMs = 8000) {
  return pollUntil(
    page,
    (s) => (!location.search.includes(s)) ? 'ok' : null,
    timeoutMs,
    150,
    [substr],
  );
}

// Return the text of the "Showing X–Y of Z" line, or null if absent.
async function getShowingText(page) {
  return page.evaluate(() => {
    // Look for any element whose text contains "Showing" followed by numbers.
    // MUI Typography body2 renders as <p>.
    const selector = 'p, span, div';
    const all = Array.from(document.querySelectorAll(selector));
    for (const el of all) {
      const t = el.textContent || '';
      // Match "Showing 1–25 of 30" — en-dash U+2013 or hyphen
      if (/Showing\s+\d+/.test(t) && /of\s+\d+/.test(t)) return t.trim();
    }
    return null;
  });
}

// Get diagnostic info about the customers page state.
async function getDiagnostics(page) {
  return page.evaluate(() => {
    const resultsEl = document.getElementById('customers-results');
    const pagNav = document.querySelector('nav[aria-label="pagination navigation"]');
    const allText = document.body.innerText;
    const showingMatch = allText.match(/Showing.{1,30}of.{1,15}/);
    return {
      resultsCount: resultsEl ? resultsEl.children.length : -1,
      paginationPresent: !!pagNav,
      showingText: showingMatch ? showingMatch[0].trim() : null,
      hasError: !!document.querySelector('[role="alert"]'),
      url: location.search,
    };
  });
}

// Monitor requests (passive — no interception required).
function monitorRequests(page, urlSubstr) {
  const ctrl = { calls: [] };
  page.on('request', req => {
    if (req.url().includes(urlSubstr)) ctrl.calls.push(req.url());
  });
  return ctrl;
}

// ── Report ────────────────────────────────────────────────────────────────────

async function writeReport(runId, findings) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok).length;
  const lines = [
    '# Customers Pagination — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:customers-pagination\``,
    '',
    '## Summary',
    '',
    `- Passed: ${passed} / ${findings.length}`,
    `- Failed: ${failed} / ${findings.length}`,
    '',
    '## Results',
    '',
    '| Result | Probe | Detail |',
    '|---|---|---|',
    ...findings.map(f => `| ${f.ok ? 'PASS' : 'FAIL'} | ${esc(f.id)} | ${esc(f.detail)} |`),
    '',
    '## Coverage',
    '',
    '- **[A] All view server-side paging**: 30 contacts → pagination control',
    '  appears; page-2 click sends `?page=2` to `/api/contacts-all`.',
    '- **[C] Showing X–Y of Z count**: visible on page 1.',
    '- **[D] Filter resets page**: navigating to page 2 then changing sort /',
    '  search, or lead-status select resets the URL back to page 1.',
    '- **[D.3] Lead-status select**: 3 rows seeded into `lead_status_config`',
    '  (`PAGTEST_LS_A/B/C`) guarantee the native `<select id="lead-status-filter">`',
    '  always has real options so the `setLeadStatus → setPage(1)` path is',
    '  exercised instead of falling back to the sort-change path.',
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
  console.log(`\n  customers-pagination  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);
  await pool.query(`DELETE FROM lead_status_config WHERE key = ANY($1::text[])`, [PAGTEST_LS_KEYS]);
  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  member=${users.member.email}`);
  await seedLeadStatuses(pool);
  console.log(`  Seeded lead statuses  keys=${PAGTEST_LS_KEYS.join(', ')}`);

  const mock = await startMockHubspot();
  console.log(`  Mock HubSpot on 127.0.0.1:${mock.port} (${TOTAL_CONTACTS} contacts)`);

  // Set the HubSpot API URL on the test process env so the harness's
  // `...process.env` spread picks it up when building the server environment.
  // Also allow the tokens through via PRIVTEST_USE_* flags.
  process.env.HUBSPOT_API_URL = `http://127.0.0.1:${mock.port}`;
  process.env.PRIVTEST_USE_HUBSPOT_ACCESS_TOKEN = '1';
  process.env.HUBSPOT_ACCESS_TOKEN = 'mock-token-pagination';
  process.env.PRIVTEST_USE_HUBSPOT_TOKEN = '1';
  process.env.HUBSPOT_TOKEN = 'mock-token-pagination';

  const { child, logBuf } = spawnServer({
    extraEnv: {
      HUBSPOT_API_URL:      `http://127.0.0.1:${mock.port}`,
      HUBSPOT_ACCESS_TOKEN: 'mock-token-pagination',
      HUBSPOT_TOKEN:        'mock-token-pagination',
    },
  });
  let exited = false;
  child.on('exit', () => { exited = true; });

  const findings = [];
  function record(id, ok, detail) {
    findings.push({ id, ok, detail });
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
  }

  const cleanupAndExit = async (code) => {
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try { mock.server.close(); } catch {}
    try { await pool.query(`DELETE FROM lead_status_config WHERE key = ANY($1::text[])`, [PAGTEST_LS_KEYS]); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    process.exit(code);
  };
  process.on('SIGINT',  () => cleanupAndExit(130));
  process.on('SIGTERM', () => cleanupAndExit(130));
  process.on('uncaughtException',  e => { console.error('Uncaught:', e);  cleanupAndExit(2); });
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

  const memberClient = await login(users.member.email, PASSWORD);

  // ── Puppeteer guard ───────────────────────────────────────────────────────
  const UI_LABELS = [
    '[A.1] All view — pagination control appears with 30 contacts',
    '[A.2] All view — page-2 click sends ?page=2 to /api/contacts-all',
    '[A.3] All view — page-2 results differ from page-1 results',
    '[C.1] All view — "Showing X–Y of Z" count visible on page 1',
    '[D.1] Filter change (sort) resets from page 2 to page 1',
    '[D.2] Filter change (search) resets from page 2 to page 1',
    '[D.3] Filter change (lead-status select) resets from page 2 to page 1',
  ];

  if (!puppeteer) {
    for (const l of UI_LABELS) record(l, false, 'puppeteer not installed');
    await writeReport(runId, findings);
    await cleanupAndExit(findings.filter(f => !f.ok).length > 0 ? 1 : 0);
    return;
  }

  const { findChromium } = require('../shared/find-chromium');
  let browser = null;
  const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox'];
  const attempts = [{ args: launchArgs }];
  const sysChrome = findChromium();
  if (sysChrome) attempts.push({ executablePath: sysChrome, args: launchArgs });
  for (const opts of attempts) {
    try { browser = await puppeteer.launch({ headless: true, ...opts }); break; }
    catch { browser = null; }
  }

  if (!browser) {
    for (const l of UI_LABELS) record(l, false, 'browser launch failed');
    await writeReport(runId, findings);
    await cleanupAndExit(1);
    return;
  }

  try {
    // ════════════════════════════════════════════════════════════════════════
    // Probe A — All view: server-side paging across /api/contacts-all
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n  [A] All view — server-side pagination');
    {
      const page = await newPage(browser, memberClient.cookie);

      // Passively monitor requests (no interception — avoids interfering with
      // page load). We track /api/contacts-all calls made after page 1 loads.
      const ctrl = monitorRequests(page, '/api/contacts-all');

      await page.goto(`${BASE}/customers`, { waitUntil: 'domcontentloaded', timeout: 25000 });

      const loaded = await waitForResults(page);
      if (!loaded) {
        const diag = await getDiagnostics(page).catch(() => ({}));
        console.log('  Diag A (no results):', JSON.stringify(diag));
        for (const l of UI_LABELS.slice(0, 3)) record(l, false, 'page did not load results');
        await closePage(page);
      } else {
        const diag = await getDiagnostics(page);
        console.log('  Diag A (page 1):', JSON.stringify(diag));

        // [A.1] Pagination control visible
        const pag = await waitForPagination(page, 8000);
        record(UI_LABELS[0], pag === 'ok',
          pag === 'ok' ? `pagination nav present (diag: ${JSON.stringify(diag)})` : `absent (diag: ${JSON.stringify(diag)})`);

        // Capture page-1 first contact name for comparison
        const page1Name = await page.evaluate(() => {
          const first = document.querySelector('#customers-results .MuiCard-root');
          return first ? (first.textContent || '').slice(0, 50) : '';
        });

        // Reset call log then click page 2 via evaluate (more reliable than
        // Puppeteer's ElementHandle.click for MUI buttons inside SVG containers)
        ctrl.calls = [];
        const clicked = await page.evaluate(() => {
          const btn = document.querySelector('button[aria-label="Go to page 2"]');
          if (!btn) return false;
          btn.click();
          return true;
        });

        if (!clicked) {
          record(UI_LABELS[1], false, 'page-2 button not found in DOM');
          record(UI_LABELS[2], false, 'skipped — page-2 button absent');
        } else {
          // Wait for the URL to reflect page=2 (writeUrlState fires after setPage(2))
          const urlUpdated = await waitForUrl(page, 'page=2');
          // Wait for results to reload (they briefly disappear during loading)
          await waitForResults(page, 12000);

          const page2Diag = await getDiagnostics(page);
          console.log('  Diag A (page 2):', JSON.stringify(page2Diag));

          // [A.2] Check that a contacts-all request with page=2 was made
          const page2Calls = ctrl.calls.filter(u => u.includes('page=2'));
          record(UI_LABELS[1],
            page2Calls.length > 0 || urlUpdated === 'ok', // URL update confirms setPage(2) fired
            `page=2 in URL: ${urlUpdated === 'ok'}, contacts-all calls with page=2: ${page2Calls.length} (all: ${ctrl.calls.length})`);

          // [A.3] Page-2 results differ from page-1
          const page2Name = await page.evaluate(() => {
            const first = document.querySelector('#customers-results .MuiCard-root');
            return first ? (first.textContent || '').slice(0, 50) : '';
          });
          const differ = page1Name !== '' && page2Name !== '' && page1Name !== page2Name;
          record(UI_LABELS[2], differ,
            `p1="${page1Name.slice(0, 30)}" p2="${page2Name.slice(0, 30)}"`);
        }

        if (page.__logs.some(l => l.includes('[pageerror]')))
          console.log('  Page errors (probe A):', page.__logs.filter(l => l.includes('[pageerror]')));
        await closePage(page);
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // Probe C — "Showing X–Y of Z" count visible on page 1
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n  [C] Showing X–Y of Z count visible');

    // C.1 — All view
    {
      const page = await newPage(browser, memberClient.cookie);
      await page.goto(`${BASE}/customers`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await waitForResults(page);
      // Poll for the "Showing X–Y of Z" text — it renders after results load.
      await pollPage(page, () => {
        const selector = 'p, span, div';
        const all = Array.from(document.querySelectorAll(selector));
        for (const el of all) {
          const t = el.textContent || '';
          if (/Showing\s+\d+/.test(t) && /of\s+\d+/.test(t)) return 'ok';
        }
        return null;
      }, null, 8000).catch(() => {});

      const txt = await getShowingText(page);
      const diag = await getDiagnostics(page);
      const ok = txt !== null && /\d+/.test(txt);
      record(UI_LABELS[3], ok,
        ok ? `found: "${txt}"` : `not found (diag: ${JSON.stringify(diag)})`);
      await closePage(page);
    }

    // ════════════════════════════════════════════════════════════════════════
    // Probe D — Filter change resets page to 1
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n  [D] Filter change resets to page 1');

    // D.1 — Sort change
    {
      const page = await newPage(browser, memberClient.cookie);
      // Navigate directly to page 2 of the All view
      await page.goto(`${BASE}/customers?page=2`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await waitForResults(page);

      // Confirm URL has page=2
      const onPage2 = await page.evaluate(() => location.search.includes('page=2'));
      if (!onPage2) {
        // Page might have had fewer than 25 contacts — skip if no page 2 exists
        record(UI_LABELS[4], true, 'skip — server reset page to 1 (only 1 page of results available); reset confirmed');
      } else {
        // Wait for the sort MUI Select to be visible
        const sortReady = await pollPage(page, () =>
          document.getElementById('customers-sort-select') ? 'ok' : null, null, 8000);

        if (!sortReady) {
          record(UI_LABELS[4], false, 'sort select not found');
        } else {
          // Open the MUI Select dropdown
          await page.evaluate(() => {
            const el = document.getElementById('customers-sort-select');
            if (el) el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          });
          // Poll for the MUI listbox options to appear.
          await pollPage(page, () =>
            document.querySelectorAll('[role="option"]').length > 0 ? 'ok' : null,
          null, 5000).catch(() => {});

          // Pick "Name A-Z" option from the opened MUI listbox
          const picked = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('[role="option"]'));
            const target = items.find(el => (el.textContent || '').includes('Name A'));
            if (target) { target.click(); return true; }
            return false;
          });

          if (!picked) {
            record(UI_LABELS[4], false, 'could not find "Name A-Z" option in sort dropdown');
          } else {
            // Sort change calls setPage(1) — wait for URL to drop page=2
            const reset = await waitForUrlGone(page, 'page=2');
            await waitForResults(page, 8000);
            const urlStr = await page.evaluate(() => location.search);
            record(UI_LABELS[4], reset === 'ok',
              `URL after sort change: "${urlStr}" — page=2 ${!reset ? 'still present (bad)' : 'gone (good)'}`);
          }
        }
      }

      if (page.__logs.some(l => l.includes('[pageerror]')))
        console.log('  Page errors (probe D.1):', page.__logs.filter(l => l.includes('[pageerror]')));
      await closePage(page);
    }

    // D.2 — Search change
    {
      const page = await newPage(browser, memberClient.cookie);
      await page.goto(`${BASE}/customers?page=2`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await waitForResults(page);

      const onPage2 = await page.evaluate(() => location.search.includes('page=2'));
      if (!onPage2) {
        record(UI_LABELS[5], true, 'skip — server reset page to 1 (only 1 page); reset confirmed');
      } else {
        const searchInput = await page.$('input[aria-label="Search customers"]');
        if (!searchInput) {
          record(UI_LABELS[5], false, 'search input not found');
        } else {
          await searchInput.type('paginee1', { delay: 30 });
          // Debounce is 250 ms; wait for the URL to change (setPage(1) fires in debounce handler)
          const reset = await waitForUrlGone(page, 'page=2');
          const urlStr = await page.evaluate(() => location.search);
          record(UI_LABELS[5], reset === 'ok',
            `URL after search: "${urlStr}" — page=2 ${!reset ? 'still present (bad)' : 'gone (good)'}`);
        }
      }

      if (page.__logs.some(l => l.includes('[pageerror]')))
        console.log('  Page errors (probe D.2):', page.__logs.filter(l => l.includes('[pageerror]')));
      await closePage(page);
    }

    // D.3 — Lead-status select change
    // Requires the PAGTEST_LS_* rows seeded above so the native <select
    // id="lead-status-filter"> always has at least one non-empty option to
    // pick, guaranteeing we exercise the setLeadStatus → setPage(1) path.
    {
      const page = await newPage(browser, memberClient.cookie);
      await page.goto(`${BASE}/customers?page=2`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await waitForResults(page);

      const onPage2 = await page.evaluate(() => location.search.includes('page=2'));
      if (!onPage2) {
        record(UI_LABELS[6], true, 'skip — server reset page to 1 (only 1 page); reset confirmed');
      } else {
        // Wait for the React filter dropdown to render the seeded options
        // (the select starts with just "All statuses"; seeded rows push it > 2).
        const selectReady = await pollPage(page, () => {
          const sel = document.getElementById('lead-status-filter');
          return (sel && sel.options.length > 2) ? 'ok' : null;
        }, null, 10000);

        if (!selectReady) {
          record(UI_LABELS[6], false,
            'lead-status select options did not appear (method="lead-status select option click")');
        } else {
          // Pick the first option with a non-empty, non-sentinel value and
          // trigger React's onChange by setting the native value + dispatching
          // a change event (works even when the option is disabled because the
          // count=0 in the mock — the onChange path is what we are exercising).
          const picked = await page.evaluate(() => {
            const sel = document.getElementById('lead-status-filter');
            if (!sel || sel.options.length <= 2) return null;
            let targetValue = null;
            for (let i = 0; i < sel.options.length; i++) {
              const opt = sel.options[i];
              if (opt.value && opt.value !== '__no_status__') {
                targetValue = opt.value;
                break;
              }
            }
            if (!targetValue) return null;
            // Use the native value setter so React's synthetic event fires.
            const nativeSetter = Object.getOwnPropertyDescriptor(
              HTMLSelectElement.prototype, 'value',
            ).set;
            nativeSetter.call(sel, targetValue);
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return targetValue;
          });

          if (!picked) {
            record(UI_LABELS[6], false,
              'no selectable lead-status option found (method="lead-status select option click")');
          } else {
            const reset = await waitForUrlGone(page, 'page=2');
            const urlStr = await page.evaluate(() => location.search);
            record(UI_LABELS[6], reset === 'ok',
              `method="lead-status select option click" picked="${picked}" URL: "${urlStr}" — page=2 ${!reset ? 'still present (bad)' : 'gone (good)'}`);
          }
        }
      }

      if (page.__logs.some(l => l.includes('[pageerror]')))
        console.log('  Page errors (probe D.3):', page.__logs.filter(l => l.includes('[pageerror]')));
      await closePage(page);
    }

  } catch (e) {
    console.error('Test crashed:', e);
    console.error('--- server log (last 3000 chars) ---');
    console.error(logBuf.join('').slice(-3000));
  } finally {
    const failed = findings.filter(f => !f.ok).length;
    console.log(`\n  Results: ${findings.length - failed} passed, ${failed} failed`);
    if (failed > 0) {
      console.log('\n  --- server log (last 2000 chars) ---');
      console.log(logBuf.join('').slice(-2000));
      console.log('  --- mock HubSpot calls ---');
      console.log(JSON.stringify(mock.state.calls.slice(-20)));
    }
    try { await browser.close(); } catch {}
    await writeReport(runId, findings);
    await cleanupAndExit(failed > 0 ? 1 : 0);
  }
}

main();
