'use strict';
// test/trades/run.js
//
// End-to-end test suite for the Trades page (React + MUI).
// Follows the pattern of test/calendar-page/run.js and
// test/new-customer-flow/run.js: boots a disposable server via the privileges
// harness, runs API pre-checks (CRUD, access-control by role), drives the UI
// with Puppeteer via incognito contexts, writes a markdown report to
// test-results/trades.md, and exits non-zero on any failure.
//
// Coverage:
//   (A) API: trade list loads (GET /api/trades) for admin + manager
//   (B) API: viewer / member are forbidden (403) from trade routes
//   (C) API: admin can create, update, audit, and delete a trade company
//   (D) API: manager can POST /api/trades/submissions; admin controls submissions list
//   (E) UI:  _cpGetTradeContacts() export is populated after page load
//   (F) UI:  search input filters by company name and by contact name
//   (G) UI:  category filter chip filters the list and persists to localStorage
//   (H) UI:  admin sees "Add Company" button; manager sees "Submit for Approval"
//   (I) UI:  viewer cannot reach /trades (redirected to /login or 403)
//   (J) UI:  duplicate phone warning appears in the Add Company dialog and
//             disables the submit button
//   (K) UI:  Snackbar visibility pause — "Company deleted" Snackbar stays
//             visible when the tab is hidden (timer paused), then dismisses
//   (L) UI:  each field of ContactSlot (name, role, phone, email,
//             preferred_contact) has a corresponding input in the contact
//             edit form — guards against wiring gaps when new fields are added
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:trades
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:trades

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

const { pollUntil } = require('../helpers/poll');

// ── fixture names (prefixed so shared-DB cleanup catches them) ─────────────

const CO_ALPHA   = 'PrivTest Trades Alpha';   // primary company
const CO_BETA    = 'PrivTest Trades Beta';    // secondary company (different type)
const CO_GAMMA   = 'PrivTest Trades Gamma';   // for search-by-contact-name test
const CO_KAPPA   = 'PrivTest Trades Kappa';   // ephemeral company for probe K (snackbar)
const CONTACT_GAMMA = 'PrivTest GammaContact';

// ── helpers ────────────────────────────────────────────────────────────────

function parseCookieKV(jar) {
  if (!jar) return null;
  const idx = jar.indexOf('=');
  if (idx < 0) return null;
  return { name: jar.slice(0, idx), value: jar.slice(idx + 1) };
}

// Open a new incognito page pre-loaded with the given session cookie.
async function openPage(browser, jar) {
  const ctx = await (browser.createBrowserContext
    ? browser.createBrowserContext()
    : browser.createIncognitoBrowserContext());
  const page = await ctx.newPage();
  page.__ctx = ctx;
  await page.setCacheEnabled(false);
  const logs = [];
  page.on('console',       m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror',     e => logs.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', r => logs.push(`[reqfailed] ${r.url()} ${r.failure()?.errorText || ''}`));
  page.on('response',      r => {
    const s = r.status();
    if (s >= 400) logs.push(`[resp ${s}] ${r.request().method()} ${r.url()}`);
  });
  page.__logs = logs;

  const kv = parseCookieKV(jar);
  if (kv) {
    const { hostname } = new URL(BASE);
    await page.setCookie({
      name: kv.name, value: kv.value,
      domain: hostname, path: '/', httpOnly: true,
    });
  }
  return page;
}

async function closePage(page) {
  try { await page.close(); } catch {}
  try { await page.__ctx?.close(); } catch {}
}

async function pollPage(page, fn, arg, timeoutMs = 10000, intervalMs = 200) {
  const evalArgs = arg !== undefined && arg !== null ? [arg] : [];
  const result = await pollUntil(page, fn, timeoutMs, intervalMs, evalArgs);
  if (result !== null) return result;
  try { return await page.evaluate(fn, ...evalArgs); } catch { return null; }
}

// Wait for the TradesPage React island to mount — the "Vendors & Trades"
// heading is emitted in the first render so it's a reliable mount signal.
async function waitForTradesPageMounted(page) {
  return pollPage(page, () => {
    const found = Array.from(document.querySelectorAll('h1, [class*="Anton"], .MuiTypography-root'))
      .some(el => /Vendors.*Trades/i.test(el.textContent || ''));
    return found ? 'mounted' : null;
  }, null, 15000);
}

// Wait for the page to finish loading trade data (loading skeletons disappear
// and either real cards or the empty-state are present).
async function waitForTradesLoaded(page, minCards = 0) {
  return pollPage(page, (min) => {
    const skeletons = document.querySelectorAll('.MuiSkeleton-root');
    if (skeletons.length > 0) return null;
    const cards = document.querySelectorAll('.MuiCard-root');
    return cards.length >= min ? cards.length : null;
  }, minCards, 15000);
}

async function purgeFixtures(pool) {
  for (const name of [CO_ALPHA, CO_BETA, CO_GAMMA, CO_KAPPA]) {
    try {
      await pool.query(
        `DELETE FROM trade_companies WHERE company_name = $1`,
        [name],
      );
    } catch (_) {}
  }
  try {
    await pool.query(
      `DELETE FROM trade_company_submissions WHERE company_name IN ($1, $2, $3)`,
      [CO_ALPHA, CO_BETA, CO_GAMMA],
    );
  } catch (_) {}
}

// ── main ───────────────────────────────────────────────────────────────────

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

  const bundlePath = path.resolve(__dirname, '..', '..', 'public', 'react', 'main.js');
  if (!fs.existsSync(bundlePath)) {
    console.error('\n  ✘ public/react/main.js is missing — run `npm run build:react` first.\n');
    process.exit(2);
  }

  const runId = Math.random().toString(36).slice(2, 8);
  console.log(`\n  trades E2E  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);
  await purgeFixtures(pool);

  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  admin=${users.admin.email}  manager=${users.manager.email}  viewer=${users.viewer.email}`);

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
    try {
      await purgeFixtures(pool);
      await cleanupTestData(pool);
    } catch {}
    await pool.end().catch(() => {});
    await writeReport(runId, findings);
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

  // ── login ──────────────────────────────────────────────────────────────

  const adminClient   = await login(users.admin.email,   PASSWORD);
  const managerClient = await login(users.manager.email, PASSWORD);
  const viewerClient  = await login(users.viewer.email,  PASSWORD);

  // ── (A) API: trade list ────────────────────────────────────────────────

  console.log('\n  ── (A) API: trade list ──');

  {
    const r = await adminClient.get('/api/trades');
    record(
      'A.1 GET /api/trades returns 200 for admin',
      '200', String(r.status), r.status === 200,
    );
    record(
      'A.2 GET /api/trades response body is an array',
      'Array', Array.isArray(r.json) ? 'Array' : typeof r.json, Array.isArray(r.json),
    );
  }

  {
    const r = await managerClient.get('/api/trades');
    record(
      'A.3 GET /api/trades returns 200 for manager',
      '200', String(r.status), r.status === 200,
    );
  }

  // ── (B) API: role-gating ───────────────────────────────────────────────

  console.log('\n  ── (B) API: role-gating ──');

  {
    const r = await viewerClient.get('/api/trades');
    record(
      'B.1 GET /api/trades returns 403 for viewer',
      '403', String(r.status), r.status === 403,
    );
  }

  {
    const memberClient = await login(users.member.email, PASSWORD);
    const r = await memberClient.get('/api/trades');
    record(
      'B.2 GET /api/trades returns 403 for member',
      '403', String(r.status), r.status === 403,
    );
  }

  // ── (C) API: CRUD ──────────────────────────────────────────────────────

  console.log('\n  ── (C) API: CRUD (admin) ──');

  let alphaId = null;

  {
    const body = {
      company_name: CO_ALPHA,
      trade_type: 'Electrical',
      areas_served: ['Wirral', 'Liverpool'],
      timescale: '1 week',
      notes: 'Test notes alpha',
      website: 'https://alpha.example.com',
      company_phone: '',
      contacts: [{ name: 'Alice Alpha', role: 'Owner', phone: '', email: 'alice@alpha.example.com', preferred_contact: 'Email' }],
    };
    const r = await adminClient.post('/api/trades', body);
    alphaId = r.json && r.json.id;
    record('C.1 POST /api/trades returns 201 for admin', '201', String(r.status), r.status === 201);
    record('C.2 POST /api/trades returns created company with id', 'id present', alphaId ? `id=${alphaId}` : 'no id', !!alphaId);
    record('C.3 POST /api/trades company_name echoed back', CO_ALPHA, r.json?.company_name, r.json?.company_name === CO_ALPHA);
  }

  {
    const r = await adminClient.get('/api/trades');
    const entry = Array.isArray(r.json) && r.json.find(c => c.id === alphaId);
    record('C.4 GET /api/trades includes new company', `id=${alphaId}`, `found=${!!entry}`, !!entry);
    const hasContact = entry && Array.isArray(entry.contacts) && entry.contacts.some(c => c.name === 'Alice Alpha');
    record('C.5 GET /api/trades embeds contacts', 'contacts[0].name = "Alice Alpha"',
      entry ? `contacts=${JSON.stringify((entry.contacts || []).map(c => c.name))}` : 'no entry', !!hasContact);
  }

  {
    const updateBody = {
      company_name: CO_ALPHA,
      trade_type: 'Plumbing',
      areas_served: ['Chester Only'],
      timescale: '2 weeks',
      notes: 'Updated notes',
      website: 'https://alpha2.example.com',
      company_phone: '01244900001',
      contacts: [{ name: 'Alice Alpha', role: 'Director', phone: '', email: 'alice@alpha.example.com', preferred_contact: 'Email' }],
    };
    const r = await adminClient.put(`/api/trades/${alphaId}`, updateBody);
    record('C.6 PUT /api/trades/:id returns 200 for admin', '200', String(r.status), r.status === 200);
    record('C.7 PUT /api/trades/:id reflects updated trade_type', 'Plumbing', r.json?.trade_type, r.json?.trade_type === 'Plumbing');
  }

  {
    const r = await viewerClient.post('/api/trades', {
      company_name: 'PrivTest Should Not Create',
      trade_type: 'Electrical', areas_served: ['Wirral'], timescale: '', notes: '', website: '',
      company_phone: '',
      contacts: [{ name: 'Blocked', role: '', phone: '', email: '', preferred_contact: '' }],
    });
    record('B.3 POST /api/trades returns 403 for viewer', '403', String(r.status), r.status === 403);
  }

  if (alphaId) {
    const r = await adminClient.get(`/api/trades/${alphaId}/audit`);
    record('C.8 GET /api/trades/:id/audit returns 200 for admin', '200', String(r.status), r.status === 200);
    record('C.9 GET /api/trades/:id/audit returns an array', 'Array',
      Array.isArray(r.json) ? 'Array' : typeof r.json, Array.isArray(r.json));
  }

  // ── (D) API: manager submission ────────────────────────────────────────

  console.log('\n  ── (D) API: manager submission ──');

  let betaId = null;
  {
    const r = await adminClient.post('/api/trades', {
      company_name: CO_BETA,
      trade_type: 'Plumbing',
      areas_served: ['Anglesey'],
      timescale: '', notes: '', website: '', company_phone: '',
      contacts: [{ name: 'Bob Beta', role: '', phone: '', email: '', preferred_contact: '' }],
    });
    betaId = r.json?.id || null;
    record('D.1 admin can seed CO_BETA (Plumbing) for filter tests', '201', String(r.status), r.status === 201);
  }

  {
    const r = await adminClient.post('/api/trades', {
      company_name: CO_GAMMA,
      trade_type: 'Carpentry / Roofing',
      areas_served: ['Wirral'],
      timescale: '', notes: '', website: '', company_phone: '',
      contacts: [{ name: CONTACT_GAMMA, role: 'Site manager', phone: '', email: '', preferred_contact: '' }],
    });
    record('D.2 admin can seed CO_GAMMA with distinctive contact name', '201', String(r.status), r.status === 201);
  }

  {
    // Manager submissions require at least one area served
    const r = await managerClient.post('/api/trades/submissions', {
      company_name: CO_ALPHA,
      trade_type: 'Handyman Services',
      areas_served: ['Wirral'],
      timescale: '', notes: 'Manager submitted this', website: '', company_phone: '',
      contacts: [{ name: 'Manager Sub', role: '', phone: '', email: '', preferred_contact: '' }],
    });
    record('D.3 POST /api/trades/submissions returns 201 for manager', '201', String(r.status), r.status === 201);
  }

  {
    const r = await viewerClient.post('/api/trades/submissions', {
      company_name: 'PrivTest Viewer Submit',
      trade_type: 'Electrical', areas_served: ['Wirral'], timescale: '', notes: '', website: '', company_phone: '',
      contacts: [{ name: 'Viewer', role: '', phone: '', email: '', preferred_contact: '' }],
    });
    record('D.4 POST /api/trades/submissions returns 403 for viewer', '403', String(r.status), r.status === 403);
  }

  {
    const r = await adminClient.get('/api/admin/trades/submissions');
    record('D.5 GET /api/admin/trades/submissions returns 200 for admin', '200', String(r.status), r.status === 200);
    record('D.6 GET /api/admin/trades/submissions returns an array', 'Array',
      Array.isArray(r.json) ? 'Array' : typeof r.json, Array.isArray(r.json));
  }

  {
    const r = await managerClient.get('/api/admin/trades/submissions');
    record('D.7 GET /api/admin/trades/submissions returns 403 for manager', '403', String(r.status), r.status === 403);
  }

  // ── Puppeteer UI tests ─────────────────────────────────────────────────

  if (!puppeteer) {
    record('puppeteer available', 'require("puppeteer") resolves', 'module not installed', false);
    const failed = findings.some(f => !f.ok);
    await cleanupAndExit(failed ? 1 : 0);
    return;
  }

  const { findChromium } = require('../shared/find-chromium');
  const executablePath = findChromium() || undefined;

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      defaultViewport: { width: 1280, height: 900 },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  } catch (e) {
    record('headless chromium launches', 'browser.launch() succeeds', `error: ${e.message}`, false);
    const failed = findings.some(f => !f.ok);
    await cleanupAndExit(failed ? 1 : 0);
    return;
  }

  try {

    // ── (E) _cpGetTradeContacts export ───────────────────────────────────
    console.log('\n  ── (E) UI: _cpGetTradeContacts export ──');
    {
      const page = await openPage(browser, adminClient.cookie);
      await page.goto(`${BASE}/trades`, { waitUntil: 'domcontentloaded', timeout: 25000 });

      const mounted = await waitForTradesPageMounted(page);
      record(
        'E.1 /trades page mounts (heading "Vendors & Trades" visible)',
        '"Vendors & Trades" heading present',
        `mounted=${mounted}`,
        mounted === 'mounted',
        mounted ? '' : `page logs: ${(page.__logs || []).slice(0, 10).join(' | ')}`,
      );

      // Wait for skeletons to go away and real content to appear
      await waitForTradesLoaded(page, 1);

      const exportFn = await pollPage(page, () => {
        return typeof window._cpGetTradeContacts === 'function' ? 'function' : null;
      }, null, 10000);

      record(
        'E.2 window._cpGetTradeContacts() is exported as a function',
        'typeof _cpGetTradeContacts === "function"',
        `type=${exportFn}`,
        exportFn === 'function',
        exportFn ? '' : `page logs: ${(page.__logs || []).slice(0, 10).join(' | ')}`,
      );

      if (exportFn === 'function') {
        const listLen = await page.evaluate(() => {
          const list = window._cpGetTradeContacts();
          return Array.isArray(list) ? list.length : -1;
        });
        record(
          'E.3 _cpGetTradeContacts() returns a non-empty array of companies',
          '>= 1 entry',
          `count=${listLen}`,
          listLen >= 1,
        );

        const hasExpectedShape = await page.evaluate((alphaName) => {
          const list = window._cpGetTradeContacts();
          const entry = list.find(c => c.company_name === alphaName);
          return !!(entry && Array.isArray(entry.contacts));
        }, CO_ALPHA);
        record(
          'E.4 _cpGetTradeContacts() entries have company_name and contacts array',
          `entry for "${CO_ALPHA}" with contacts array`,
          `hasShape=${hasExpectedShape}`,
          hasExpectedShape,
        );
      }

      await closePage(page);
    }

    // ── (F) Search filtering ─────────────────────────────────────────────
    console.log('\n  ── (F) UI: search filter ──');
    {
      const page = await openPage(browser, adminClient.cookie);
      await page.goto(`${BASE}/trades`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await waitForTradesPageMounted(page);
      await waitForTradesLoaded(page, 1);

      // Confirm CO_ALPHA is visible before searching
      const alphaCardBefore = await page.evaluate((name) => {
        return Array.from(document.querySelectorAll('.MuiCard-root'))
          .some(c => (c.textContent || '').includes(name));
      }, CO_ALPHA);
      record(
        'F.1 CO_ALPHA card visible before search',
        `card containing "${CO_ALPHA}"`,
        `visible=${alphaCardBefore}`,
        alphaCardBefore,
      );

      // Locate the search input — it's a MUI TextField near a Search icon.
      // We find it by placeholder or aria-label, falling back to the first visible input.
      const searched = await page.evaluate((searchTerm) => {
        const inputs = Array.from(document.querySelectorAll('input'));
        const searchInput = inputs.find(i =>
          (i.placeholder || '').toLowerCase().includes('search') ||
          (i.getAttribute('aria-label') || '').toLowerCase().includes('search') ||
          i.type === 'search'
        ) || inputs[0];
        if (!searchInput) return 'no-input';
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(searchInput, searchTerm);
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        searchInput.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok';
      }, 'Alpha');

      record(
        'F.2 Search input found and "Alpha" typed',
        '"ok"', searched, searched === 'ok',
      );

      await new Promise(r => setTimeout(r, 500));

      const alphaVisibleAfter = await page.evaluate((name) => {
        return Array.from(document.querySelectorAll('.MuiCard-root'))
          .some(c => (c.textContent || '').includes(name));
      }, CO_ALPHA);
      record(
        'F.3 CO_ALPHA card remains visible after searching "Alpha"',
        `card containing "${CO_ALPHA}"`,
        `visible=${alphaVisibleAfter}`,
        alphaVisibleAfter,
      );

      const betaHidden = await page.evaluate((name) => {
        return !Array.from(document.querySelectorAll('.MuiCard-root'))
          .some(c => (c.textContent || '').includes(name));
      }, CO_BETA);
      record(
        'F.4 CO_BETA card is hidden after searching "Alpha"',
        `no card for "${CO_BETA}"`,
        `hidden=${betaHidden}`,
        betaHidden,
      );

      // Clear and search by contact name
      await page.evaluate((searchTerm) => {
        const inputs = Array.from(document.querySelectorAll('input'));
        const searchInput = inputs.find(i =>
          (i.placeholder || '').toLowerCase().includes('search') ||
          (i.getAttribute('aria-label') || '').toLowerCase().includes('search') ||
          i.type === 'search'
        ) || inputs[0];
        if (!searchInput) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(searchInput, searchTerm);
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        searchInput.dispatchEvent(new Event('change', { bubbles: true }));
      }, 'GammaContact');

      await new Promise(r => setTimeout(r, 500));

      const gammaByContact = await page.evaluate((name) => {
        return Array.from(document.querySelectorAll('.MuiCard-root'))
          .some(c => (c.textContent || '').includes(name));
      }, CO_GAMMA);
      record(
        'F.5 Searching by contact name "GammaContact" shows CO_GAMMA',
        `card containing "${CO_GAMMA}"`,
        `visible=${gammaByContact}`,
        gammaByContact,
      );

      const alphaHiddenByContact = await page.evaluate((name) => {
        return !Array.from(document.querySelectorAll('.MuiCard-root'))
          .some(c => (c.textContent || '').includes(name));
      }, CO_ALPHA);
      record(
        'F.6 Searching "GammaContact" hides CO_ALPHA (different contact)',
        `no card for "${CO_ALPHA}"`,
        `hidden=${alphaHiddenByContact}`,
        alphaHiddenByContact,
      );

      await closePage(page);
    }

    // ── (G) Category filter + localStorage ──────────────────────────────
    console.log('\n  ── (G) UI: category filter + localStorage ──');
    {
      const page = await openPage(browser, adminClient.cookie);
      await page.goto(`${BASE}/trades`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await waitForTradesPageMounted(page);

      // Clear any leftover filter from a previous run
      await page.evaluate(() => {
        try { localStorage.removeItem('tradesTypeFilter'); } catch {}
      });
      // Reload so the cleared filter takes effect
      await page.goto(`${BASE}/trades`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await waitForTradesPageMounted(page);
      await waitForTradesLoaded(page, 1);

      // Verify both CO_ALPHA (Plumbing) and CO_GAMMA (Carpentry / Roofing) visible initially
      const bothBefore = await page.evaluate(([a, g]) => {
        const cards = Array.from(document.querySelectorAll('.MuiCard-root'));
        return cards.some(c => (c.textContent || '').includes(a))
            && cards.some(c => (c.textContent || '').includes(g));
      }, [CO_ALPHA, CO_GAMMA]);
      record(
        'G.1 Before filtering, both CO_ALPHA and CO_GAMMA are visible',
        'both visible', `both=${bothBefore}`, !!bothBefore,
      );

      // Click the "Carpentry / Roofing" chip
      const chipClicked = await page.evaluate(() => {
        const chips = Array.from(document.querySelectorAll('.MuiChip-root'));
        const chip = chips.find(c => (c.textContent || '').trim() === 'Carpentry / Roofing');
        if (!chip) return false;
        chip.click();
        return true;
      });
      record(
        'G.2 "Carpentry / Roofing" filter chip found and clicked',
        'true', `${chipClicked}`, chipClicked,
      );

      await new Promise(r => setTimeout(r, 500));

      const gammaOnly = await page.evaluate(([gammaName, alphaName]) => {
        const cards = Array.from(document.querySelectorAll('.MuiCard-root'));
        return cards.some(c => (c.textContent || '').includes(gammaName))
            && !cards.some(c => (c.textContent || '').includes(alphaName));
      }, [CO_GAMMA, CO_ALPHA]);
      record(
        'G.3 After "Carpentry / Roofing" filter, CO_GAMMA visible + CO_ALPHA hidden',
        `CO_GAMMA visible, CO_ALPHA hidden`,
        `result=${gammaOnly}`, !!gammaOnly,
      );

      const storedFilter = await page.evaluate(() => {
        try { return localStorage.getItem('tradesTypeFilter'); } catch { return null; }
      });
      record(
        'G.4 localStorage["tradesTypeFilter"] set after clicking category chip',
        '"Carpentry / Roofing"', storedFilter, storedFilter === 'Carpentry / Roofing',
      );

      // Reload and verify filter is restored
      await page.goto(`${BASE}/trades`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await waitForTradesPageMounted(page);
      await waitForTradesLoaded(page, 1);

      const filterRestored = await page.evaluate(([gammaName, alphaName]) => {
        const cards = Array.from(document.querySelectorAll('.MuiCard-root'));
        const hasGamma = cards.some(c => (c.textContent || '').includes(gammaName));
        const hasAlpha = cards.some(c => (c.textContent || '').includes(alphaName));
        return hasGamma && !hasAlpha;
      }, [CO_GAMMA, CO_ALPHA]);
      record(
        'G.5 Category filter restored from localStorage on page reload',
        'CO_GAMMA visible, CO_ALPHA hidden after reload',
        `restored=${filterRestored}`, !!filterRestored,
      );

      // Clean up filter for subsequent tests
      await page.evaluate(() => {
        try { localStorage.removeItem('tradesTypeFilter'); } catch {}
      });
      await closePage(page);
    }

    // ── (H) Role-gating button labels ────────────────────────────────────
    console.log('\n  ── (H) UI: role-gating button labels ──');
    {
      // Helper: wait for core.js to finish the auth fetch (it sets window.__moHeaderUser
      // from /api/auth/user and then fires the mo:user event that usePrivilege reads).
      // The button only renders once isAdmin or isManager is true.
      async function waitForPrivilege(page, expectedLevel) {
        return pollPage(page, (level) => {
          const u = window.__moHeaderUser || (window.state && window.state.user);
          const priv = u && u.privilege_level;
          return priv === level || (level === 'manager' && (priv === 'manager' || priv === 'admin'))
            ? priv : null;
        }, expectedLevel, 12000);
      }

      // Admin sees "Add Company"
      const adminPage = await openPage(browser, adminClient.cookie);
      await adminPage.goto(`${BASE}/trades`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await waitForTradesPageMounted(adminPage);
      await waitForPrivilege(adminPage, 'admin');

      const adminBtnText = await pollPage(adminPage, () => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => {
          const t = (b.textContent || '');
          return t.includes('Add Company') || t.includes('Submit for Approval');
        });
        if (!btn) return null;
        const t = btn.textContent || '';
        return t.includes('Add Company') ? 'Add Company'
          : t.includes('Submit for Approval') ? 'Submit for Approval'
          : null;
      }, null, 10000);

      record(
        'H.1 Admin sees "Add Company" button on /trades',
        '"Add Company"', adminBtnText, adminBtnText === 'Add Company',
      );
      await closePage(adminPage);

      // Manager sees "Submit for Approval"
      const managerPage = await openPage(browser, managerClient.cookie);
      await managerPage.goto(`${BASE}/trades`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await waitForTradesPageMounted(managerPage);
      await waitForPrivilege(managerPage, 'manager');

      const managerBtnText = await pollPage(managerPage, () => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => {
          const t = (b.textContent || '');
          return t.includes('Add Company') || t.includes('Submit for Approval');
        });
        if (!btn) return null;
        const t = btn.textContent || '';
        return t.includes('Add Company') ? 'Add Company'
          : t.includes('Submit for Approval') ? 'Submit for Approval'
          : null;
      }, null, 10000);

      record(
        'H.2 Manager sees "Submit for Approval" button on /trades',
        '"Submit for Approval"', managerBtnText, managerBtnText === 'Submit for Approval',
      );
      await closePage(managerPage);
    }

    // ── (I) Viewer access gating ─────────────────────────────────────────
    // The server-side /trades route uses isAuthenticated only (no role check),
    // so viewers get the HTML page with status 200. Access is gated by the React
    // component: it calls GET /api/trades which returns 403 for viewer, so the
    // component shows a load error. core.js also shows the viewer banner.
    console.log('\n  ── (I) UI: viewer access gating ──');
    {
      const viewerPage = await openPage(browser, viewerClient.cookie);
      const response = await viewerPage.goto(`${BASE}/trades`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      const status = response ? response.status() : null;

      record(
        'I.1 Viewer: /trades HTML is served (200) — auth-only server gate',
        '200',
        `status=${status}`,
        status === 200,
      );

      // The "Add Company"/"Submit for Approval" button requires isPriv (isAdmin||isManager).
      // For a viewer, usePrivilege returns isPriv=false so the button should never render.
      const noPrivBtn = await pollPage(viewerPage, () => {
        // Wait long enough for useCurrentUser to resolve the viewer user
        const u = window.__moHeaderUser;
        if (!u) return null; // user not loaded yet
        const btns = Array.from(document.querySelectorAll('button'));
        const hasPrivBtn = btns.some(b => (b.textContent || '').includes('Add Company')
          || (b.textContent || '').includes('Submit for Approval'));
        return !hasPrivBtn ? 'no-priv-button' : null;
      }, null, 15000);
      record(
        'I.2 Viewer: "Add Company"/"Submit for Approval" button absent (isPriv=false for viewer)',
        'no privilege button present',
        `result=${noPrivBtn}`,
        noPrivBtn === 'no-priv-button',
      );

      // React component should show a load error (API returns 403 for viewer)
      const loadError = await pollPage(viewerPage, () => {
        const alerts = Array.from(document.querySelectorAll('.MuiAlert-root'));
        if (alerts.some(a => (a.textContent || '').length > 0)) return 'error';
        const cards = document.querySelectorAll('.MuiCard-root');
        if (cards.length === 0) {
          const body = document.body.textContent || '';
          return /error|failed|unable|forbidden|403/i.test(body) ? 'error' : null;
        }
        return null;
      }, null, 15000);
      record(
        'I.3 Viewer: React TradesPage shows error state (API returns 403)',
        'error visible',
        `errorState=${loadError}`,
        loadError === 'error',
      );

      await closePage(viewerPage);
    }

    // ── (K) Snackbar visibility pause (tab-hide) ──────────────────────────
    // Probe K: trigger the "Company deleted" Snackbar by deleting a fresh
    // company via the UI, then simulate the document going hidden.  The MUI
    // Snackbar must still be visible after the 4 s autoHideDuration has
    // elapsed (proving the timer was paused), then auto-dismiss once the tab
    // returns to the foreground.
    console.log('\n  ── (K) UI: Snackbar visibility pause (tab-hide) ──');
    {
      // Seed a fresh company for this probe so deleting it does not interfere
      // with CO_ALPHA which is still needed by probe J.
      const kappaBody = {
        company_name: CO_KAPPA,
        trade_type: 'Electrical',
        areas_served: [],
        timescale: '',
        notes: '',
        website: '',
        company_phone: '',
        contacts: [{ name: 'Kappa Contact', role: '', phone: '', email: '', preferred_contact: 'Phone' }],
      };
      const kappaR = await adminClient.post('/api/trades', kappaBody);
      const kappaId = kappaR.json && kappaR.json.id;

      if (!kappaId) {
        record('K.1 Kappa company seeded for snackbar probe', 'id present', 'no id returned', false);
      } else {
        record('K.1 Kappa company seeded for snackbar probe', 'id present', `id=${kappaId}`, true);

        const kPage = await openPage(browser, adminClient.cookie);
        try {
          await kPage.goto(`${BASE}/trades`, { waitUntil: 'domcontentloaded', timeout: 25000 });
          await waitForTradesPageMounted(kPage);
          await waitForTradesLoaded(kPage, 1);

          // Find and click the delete button for "PrivTest Trades Kappa".
          const deleteClicked = await kPage.evaluate(() => {
            const cards = Array.from(document.querySelectorAll('.MuiCard-root'));
            for (const card of cards) {
              if ((card.textContent || '').includes('PrivTest Trades Kappa')) {
                const btn = card.querySelector('[aria-label="Delete company"]');
                if (btn) { btn.click(); return true; }
              }
            }
            return false;
          });

          record('K.2 Delete icon clicked for Kappa company', 'true', `${deleteClicked}`, deleteClicked);

          if (deleteClicked) {
            // Wait for the confirm dialog to open.
            const dialogReady = await pollPage(kPage, () => {
              const d = document.querySelector('[role="dialog"]');
              return d ? 'open' : null;
            }, null, 5000);

            if (!dialogReady) {
              record('K.3–K.5 Snackbar visibility pause', 'confirm dialog opened', 'dialog not found', false);
            } else {
              // Click the "Delete" confirm button inside the dialog.
              const confirmed = await kPage.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('[role="dialog"] button'));
                const btn = btns.find(b => /^delete$/i.test((b.textContent || '').trim()));
                if (btn) { btn.click(); return true; }
                return false;
              });

              if (!confirmed) {
                record('K.3–K.5 Snackbar visibility pause', '"Delete" button clicked', 'button not found', false);
              } else {
                // Step 1: Wait for "Company deleted" Snackbar to appear.
                const snackbarAppeared = await pollPage(kPage, () => {
                  const alerts = Array.from(document.querySelectorAll('[role="alert"]'));
                  return alerts.some(el => (el.textContent || '').includes('Company deleted')) ? 'visible' : null;
                }, null, 5000);

                if (snackbarAppeared !== 'visible') {
                  record('K.3 "Company deleted" Snackbar appears', 'visible', `snackbar=${snackbarAppeared}`, false);
                  record('K.4 Snackbar paused while tab hidden (>4 s)', 'skipped', 'snackbar never appeared', false);
                  record('K.5 Snackbar dismisses after tab returns visible', 'skipped', 'snackbar never appeared', false);
                } else {
                  record('K.3 "Company deleted" Snackbar appears', 'visible', 'visible', true);

                  // Step 2: Simulate the tab going hidden.
                  await kPage.evaluate(() => {
                    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
                    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
                    document.dispatchEvent(new Event('visibilitychange'));
                  });

                  // Step 3: Wait 5 s (> 4 s autoHideDuration). If the pause were broken
                  // the Snackbar would have dismissed by now.
                  await new Promise(r => setTimeout(r, 5000));

                  const stillVisible = await kPage.evaluate(() => {
                    const alerts = Array.from(document.querySelectorAll('[role="alert"]'));
                    return alerts.some(el => (el.textContent || '').includes('Company deleted'));
                  }).catch(() => false);

                  record(
                    'K.4 Snackbar paused while tab hidden (>4 s)',
                    'still visible (timer paused)',
                    stillVisible ? 'still visible — timer paused (good)' : 'already dismissed — timer NOT paused (bad)',
                    stillVisible,
                  );

                  // Step 4: Restore the tab to visible.
                  await kPage.evaluate(() => {
                    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
                    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
                    document.dispatchEvent(new Event('visibilitychange'));
                  });

                  // Step 5: Snackbar must now auto-dismiss (4 s timer restarts).
                  // Allow up to 8 s (4 s autoHide + animation buffer).
                  const deadline = Date.now() + 8000;
                  let gone = false;
                  while (Date.now() < deadline) {
                    const still = await kPage.evaluate(() => {
                      const alerts = Array.from(document.querySelectorAll('[role="alert"]'));
                      return alerts.some(el => (el.textContent || '').includes('Company deleted'));
                    }).catch(() => true);
                    if (!still) { gone = true; break; }
                    await new Promise(r => setTimeout(r, 100));
                  }

                  record(
                    'K.5 Snackbar dismisses after tab returns visible',
                    'dismissed within 8 s of tab-show',
                    gone ? 'dismissed (good)' : 'still visible after 8 s (bad)',
                    gone,
                  );
                }
              }
            }
          }
        } finally {
          // Kappa may already be deleted by the test; 404 is fine.
          await adminClient.delete(`/api/trades/${kappaId}`).catch(() => {});
          await closePage(kPage);
        }
      }
    }

    // ── (J) Duplicate phone warning in Add Company dialog ─────────────────
    console.log('\n  ── (J) UI: duplicate phone warning in dialog ──');
    {
      // CO_ALPHA has company_phone=01244900001 (set in C.6 update).
      // Open "Add Company" and type that number → duplicate alert should fire.
      const page = await openPage(browser, adminClient.cookie);
      await page.goto(`${BASE}/trades`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await waitForTradesPageMounted(page);
      await waitForTradesLoaded(page, 1);

      // Wait for _cpGetTradeContacts to include CO_ALPHA with company_phone
      const alphaLoaded = await pollPage(page, (alphaName) => {
        const fn = window._cpGetTradeContacts;
        if (typeof fn !== 'function') return null;
        const list = fn();
        const entry = list.find(c => c.company_name === alphaName);
        return entry && entry.company_phone ? 'ready' : null;
      }, CO_ALPHA, 10000);

      record(
        'J.1 CO_ALPHA with company_phone loaded in _cpGetTradeContacts',
        '"ready"', alphaLoaded, alphaLoaded === 'ready',
      );

      // Wait for privilege to be set so the "Add Company" button is visible
      await pollPage(page, () => {
        const u = window.__moHeaderUser || (window.state && window.state.user);
        return u && u.privilege_level === 'admin' ? 'admin' : null;
      }, null, 12000);

      // Wait for "Add Company" button to appear, then use native Puppeteer click
      // (avoids synthetic-click edge cases with MUI buttons).
      const addCompanyBtnHandle = await (async () => {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          const handles = await page.$$('button');
          for (const h of handles) {
            const text = await h.evaluate(el => el.textContent || '');
            if (text.includes('Add Company') && !text.includes('Cancel')) {
              const isInDialog = await h.evaluate(el => !!el.closest('[role="dialog"]'));
              if (!isInDialog) return h;
            }
          }
          await new Promise(r => setTimeout(r, 200));
        }
        return null;
      })();

      const btnClicked = !!addCompanyBtnHandle;
      if (addCompanyBtnHandle) {
        await addCompanyBtnHandle.click();
      }
      record(
        'J.2 "Add Company" button (outside dialog) found and clicked',
        'true', `${btnClicked}`, btnClicked,
      );

      // Wait for the Add Company dialog to open: poll until a tel input
      // (Company phone field) appears in the document.
      const telInputReady = await pollPage(page, () => {
        return document.querySelector('input[type="tel"]') ? 'ready' : null;
      }, null, 8000);

      const dialogOpen = !!telInputReady;
      record(
        'J.3 Add Company dialog opens (Company phone tel input visible)',
        '"ready"', telInputReady, telInputReady === 'ready',
      );

      if (dialogOpen) {
        // Type the duplicate phone number into the Company phone (tel) input.
        const typed = await page.evaluate(() => {
          const input = document.querySelector('input[type="tel"]');
          if (!input) return 'no-tel-input';
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, '01244900001');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return 'ok';
        });
        record(
          'J.4 Company phone tel input found and duplicate number entered',
          '"ok"', typed, typed === 'ok',
        );

        // Wait for the 300ms debounce + React re-render → duplicate warning
        const warnAppeared = await pollPage(page, () => {
          const alerts = Array.from(document.querySelectorAll('.MuiAlert-root'));
          return alerts.some(a => /phone number is already in use/i.test(a.textContent || ''))
            ? 'warning' : null;
        }, null, 3000);
        record(
          'J.5 MUI Alert "phone number is already in use" appears in dialog',
          '"warning"',
          `result=${warnAppeared}`,
          warnAppeared === 'warning',
        );

        const submitDisabled = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('[role="dialog"] button'));
          const btn = btns.find(b => {
            const t = b.textContent || '';
            return t.includes('Add Company') || t.includes('Adding');
          });
          return btn ? btn.disabled : null;
        });
        record(
          'J.6 Dialog submit button disabled while duplicate phone stands',
          'button.disabled === true',
          `disabled=${submitDisabled}`,
          submitDisabled === true,
        );
      }

      await closePage(page);
    }

    // ── (L) ContactSlot fields each have a form input ─────────────────────
    console.log('\n  ── (L) UI: ContactSlot fields all have form inputs ──');
    {
      const page = await openPage(browser, adminClient.cookie);
      await page.goto(`${BASE}/trades`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await waitForTradesPageMounted(page);
      await waitForTradesLoaded(page, 1);

      // Wait for admin privilege so the "Add Company" button renders
      await pollPage(page, () => {
        const u = window.__moHeaderUser || (window.state && window.state.user);
        return u && u.privilege_level === 'admin' ? 'admin' : null;
      }, null, 12000);

      // Locate and click the top-level "Add Company" button (not inside dialog)
      const addBtnHandle = await (async () => {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          const handles = await page.$$('button');
          for (const h of handles) {
            const text = await h.evaluate(el => el.textContent || '');
            if (text.includes('Add Company') && !text.includes('Cancel')) {
              const isInDialog = await h.evaluate(el => !!el.closest('[role="dialog"]'));
              if (!isInDialog) return h;
            }
          }
          await new Promise(r => setTimeout(r, 200));
        }
        return null;
      })();

      const dialogOpened = !!addBtnHandle;
      if (addBtnHandle) await addBtnHandle.click();

      record(
        'L.1 "Add Company" button found and clicked for ContactSlot field check',
        'true', `${dialogOpened}`, dialogOpened,
      );

      if (dialogOpened) {
        // Wait for the dialog to open: the contact "name" input has a distinctive placeholder
        const dialogReady = await pollPage(page, () => {
          return document.querySelector('input[placeholder="e.g. John Smith"]') ? 'ready' : null;
        }, null, 8000);

        record(
          'L.2 Add Company dialog opens (contact name input visible)',
          '"ready"', dialogReady, dialogReady === 'ready',
        );

        if (dialogReady === 'ready') {
          // Assert each ContactSlot field = Required<TradeContact> has a form input:
          //   name, role, phone, email, preferred_contact
          const fieldChecks = await page.evaluate(() => {
            const dialog = document.querySelector('[role="dialog"]');
            if (!dialog) return null;
            return {
              name:              !!dialog.querySelector('input[placeholder="e.g. John Smith"]'),
              role:              !!dialog.querySelector('input[placeholder="e.g. Director"]'),
              phone:             !!dialog.querySelector('input#tf-cphone-0'),
              email:             !!dialog.querySelector('input[type="email"]'),
              preferred_contact: !!dialog.querySelector('input[type="radio"]'),
            };
          });

          if (!fieldChecks) {
            for (const [i, f] of ['name', 'role', 'phone', 'email', 'preferred_contact'].entries()) {
              record(`L.${i + 3} ContactSlot field "${f}" has a form input`, 'true', 'dialog not found', false);
            }
          } else {
            record(
              'L.3 ContactSlot field "name" has a form input (placeholder "e.g. John Smith")',
              'true', `${fieldChecks.name}`, fieldChecks.name,
            );
            record(
              'L.4 ContactSlot field "role" has a form input (placeholder "e.g. Director")',
              'true', `${fieldChecks.role}`, fieldChecks.role,
            );
            record(
              'L.5 ContactSlot field "phone" has a form input (id=tf-cphone-0)',
              'true', `${fieldChecks.phone}`, fieldChecks.phone,
            );
            record(
              'L.6 ContactSlot field "email" has a form input (type=email)',
              'true', `${fieldChecks.email}`, fieldChecks.email,
            );
            record(
              'L.7 ContactSlot field "preferred_contact" has a form input (type=radio)',
              'true', `${fieldChecks.preferred_contact}`, fieldChecks.preferred_contact,
            );
          }
        }
      }

      await closePage(page);
    }

  } finally {
    try { await browser.close(); } catch {}
  }

  // ── API cleanup: DELETE ─────────────────────────────────────────────────

  if (alphaId) {
    const r = await adminClient.delete(`/api/trades/${alphaId}`);
    record('C.10 DELETE /api/trades/:id returns 200 for admin', '200', String(r.status), r.status === 200);
    const listR = await adminClient.get('/api/trades');
    const gone = Array.isArray(listR.json) && !listR.json.some(c => c.id === alphaId);
    record('C.11 Deleted company absent from GET /api/trades', 'absent', `gone=${gone}`, gone);
  }

  if (betaId) {
    await adminClient.delete(`/api/trades/${betaId}`).catch(() => {});
  }

  const failed = findings.some(f => !f.ok);
  console.log(`\n  Passed: ${findings.filter(f => f.ok).length} / ${findings.length}`);
  if (failed) console.log(`  Failed: ${findings.filter(f => !f.ok).length} / ${findings.length}`);
  await cleanupAndExit(failed ? 1 : 0);
}

// ── report ──────────────────────────────────────────────────────────────────

async function writeReport(runId, findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Trades Page — E2E Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:trades\``,
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
    '- **(A) API trade list**: `GET /api/trades` → 200 + array for admin and manager.',
    '- **(B) API role-gating**: viewer and member receive 403 from all trades write routes.',
    '- **(C) API CRUD (admin)**: `POST`, `PUT`, `DELETE` companies; audit endpoint.',
    '- **(D) API manager submission**: manager `POST /api/trades/submissions` → 201;',
    '  viewer → 403; admin submissions list gated from manager.',
    '- **(E) UI `_cpGetTradeContacts` export**: `window._cpGetTradeContacts()` is a',
    '  function populated with the seeded companies, including correct shape.',
    '- **(F) UI search filter**: search by company name shows matching companies and',
    '  hides others; search by contact name also filters correctly.',
    '- **(G) UI category filter + localStorage**: clicking a category chip filters the',
    '  list, writes `tradesTypeFilter` to localStorage, and is restored on reload.',
    '- **(H) UI role-gating button label**: admin → "Add Company";',
    '  manager → "Submit for Approval".',
    '- **(I) UI viewer access gating**: server serves /trades HTML to all authenticated users',
    '  (isAuthenticated only, no role check). Viewer gets 200 but core.js shows the viewer',
    '  banner and the React component shows a load error (API returns 403 for viewer).',
    '- **(J) UI duplicate phone warning**: typing a known-duplicate company phone in the',
    '  Add Company dialog shows an MUI Alert and disables the submit button.',
    '- **(K) UI Snackbar visibility pause**: deleting a company shows the "Company deleted"',
    '  Snackbar; simulating tab-hide proves the MUI autoHideDuration timer is paused',
    '  (Snackbar still visible after 5 s > 4 s), then auto-dismisses once the tab',
    '  returns to the foreground.',
    '- **(L) UI ContactSlot field coverage**: opens the Add Company dialog and asserts',
    '  that each field of `ContactSlot` (`name`, `role`, `phone`, `email`,',
    '  `preferred_contact`) has a corresponding input element. Guards against wiring',
    '  gaps when a new field is added to the type but not wired into the form.',
    '',
  ];
  const outPath = path.resolve(dir, 'trades.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Report: test-results/trades.md`);
}

main();
