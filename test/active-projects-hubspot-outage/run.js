'use strict';
// test/active-projects-hubspot-outage/run.js
//
// Regression guard for the Active Projects error branch added in task #1797.
//
// Covers:
//   [AP-A] /api/contacts-all returns 502 →
//          "Active Projects" section header is visible,
//          the MUI Alert "Unable to retrieve customer info" is visible,
//          and no customer cards are rendered.
//
// Strategy: boots a disposable test server, drives the home page (/) with
// Puppeteer, and overrides window.fetch (via evaluateOnNewDocument) so that
// /api/contacts-all resolves to a 502 response while all other home-page APIs
// return minimal stubs. Asserts the three DOM conditions above without needing
// real HubSpot credentials.
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:active-projects-hubspot-outage
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:active-projects-hubspot-outage

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

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'active-projects-hubspot-outage.md',
);

const findings = [];
function record(name, expected, observed, ok) {
  findings.push({ name, expected, observed, ok });
  const mark = ok ? '  ✓' : '  ✗';
  console.log(`${mark}  ${name}`);
  if (!ok) {
    console.log(`     expected : ${expected}`);
    console.log(`     observed : ${observed}`);
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────

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

async function pollPage(page, fn, timeoutMs = 10000, intervalMs = 150) {
  return pollUntil(page, fn, timeoutMs, intervalMs, []);
}

// Open the home page with request interception active.
// /api/contacts-all is intercepted to return 502.
// All other home-page API calls are stubbed with minimal responses so the test
// runs without third-party credentials (no HubSpot, no Google, no QB).
async function openHome(browser, jar) {
  const ctx = await (browser.createBrowserContext
    ? browser.createBrowserContext()
    : browser.createIncognitoBrowserContext());
  const page = await ctx.newPage();
  page.__ctx = ctx;
  await page.setCacheEnabled(false);

  const pageLogs = [];
  page.on('console',   m => pageLogs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => pageLogs.push(`[pageerror] ${e.message}`));

  // Override window.fetch before any page JS runs so every home-page fetch is
  // under our control. The interception rules:
  //
  //   /api/contacts-all          → 502  (simulates HubSpot outage)
  //   /api/personal-tasks        → 200  []
  //   /api/calendar/upcoming     → 200  { connected: false, events: [] }
  //   /api/workflow              → 200  {}
  //   /api/localdata/all         → 200  {}
  //   /api/quickbooks/*          → 200  { connected: false, statusKnown: true, invoices: [] }
  //   everything else            → pass through to the real test server
  await page.evaluateOnNewDocument(() => {
    const originalFetch = window.fetch;

    function matchPath(input) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      return url.startsWith('http') ? new URL(url).pathname : url.split('?')[0];
    }

    function jsonResp(body, status) {
      return Promise.resolve(new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }));
    }

    window.fetch = function(input, init) {
      const pathname = matchPath(input);

      if (pathname.startsWith('/api/contacts-all')) {
        return jsonResp({ error: 'HubSpot unavailable', code: 'HUBSPOT_ERROR' }, 502);
      }
      if (pathname === '/api/personal-tasks') {
        return jsonResp([], 200);
      }
      if (pathname === '/api/calendar/upcoming') {
        return jsonResp({ connected: false, events: [] }, 200);
      }
      if (pathname === '/api/workflow') {
        return jsonResp({}, 200);
      }
      if (pathname === '/api/localdata/all') {
        return jsonResp({}, 200);
      }
      if (pathname.startsWith('/api/quickbooks')) {
        return jsonResp({ connected: false, statusKnown: true, invoices: [] }, 200);
      }

      return originalFetch.call(this, input, init);
    };
  });

  await injectSession(page, jar);
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait for the React island to mount: the DateHeader always renders a day name.
  await pollPage(page, () => {
    const el = document.querySelector('#home-view');
    return el && el.textContent && el.textContent.length > 20 ? 'ok' : null;
  }, 20000);

  // Wait until the Active Projects section resolves to either an error state or
  // a card list. We detect settlement by waiting for the loading skeletons to
  // disappear from that section or for the error Alert text to appear.
  await pollPage(page, () => {
    const el = document.querySelector('#home-view');
    if (!el) return null;
    const text = el.textContent || '';
    // Settled when "Unable to retrieve customer info" is present, or when
    // "Active Projects" is present and skeletons are gone.
    if (text.includes('Unable to retrieve customer info')) return 'ok';
    // Alternatively, if projects loaded successfully (no error), also settled.
    if (text.includes('Active Projects') && !el.querySelector('[role="progressbar"]')) return 'ok';
    return null;
  }, 15000);

  page.__logs = pageLogs;
  return page;
}

// ── report ─────────────────────────────────────────────────────────────────────

async function writeReport(runId) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok).length;
  const lines = [
    '# Active Projects HubSpot Outage — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:active-projects-hubspot-outage\``,
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
    '- **[AP-A] HubSpot 502 → error state**: `/api/contacts-all` is intercepted',
    '  to return a 502. The `ProjectsSection` in `HomePage.tsx` must:',
    '  - render the "Active Projects" section header,',
    '  - show an MUI Alert with "Unable to retrieve customer info",',
    '  - render no customer `<HomeCard>` elements.',
    '',
    '- **[AP-B] Retry button present**: The error Alert must include a Retry',
    '  button (`<button>Retry</button>` inside `[role="alert"]`) so users can',
    '  re-trigger `loadProjects()` without a full page refresh.',
    '',
    'All other home-page APIs (`/api/personal-tasks`, `/api/calendar/upcoming`,',
    '`/api/workflow`, `/api/localdata/all`, `/api/quickbooks/*`) are stubbed with',
    'minimal responses so the test runs without third-party credentials.',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
}

// ── main ───────────────────────────────────────────────────────────────────────

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
  console.log(`\n  active-projects-hubspot-outage  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);
  await cleanupTestData(pool);

  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  admin=${users.admin.email}  member=${users.member.email}`);

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
    await writeReport(runId);
    process.exit(code);
  };
  process.on('SIGINT',  () => cleanupAndExit(130));
  process.on('SIGTERM', () => cleanupAndExit(130));
  process.on('uncaughtException',  e => { console.error('Uncaught:',  e); cleanupAndExit(2); });
  process.on('unhandledRejection', e => { console.error('Unhandled:', e); cleanupAndExit(2); });

  const UI_LABELS = [
    '[AP-A] "Active Projects" section header is visible when /api/contacts-all returns 502',
    '[AP-A] Alert "Unable to retrieve customer info" is visible',
    '[AP-A] No customer cards are rendered',
    '[AP-B] Retry button is present inside the error Alert',
  ];

  // ── Boot test server ────────────────────────────────────────────────────────
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

  // ── Login ───────────────────────────────────────────────────────────────────
  const memberClient = await login(users.member.email, users.member.password);

  if (!puppeteer) {
    for (const l of UI_LABELS) record(l, 'puppeteer installed', 'puppeteer not installed', false);
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
    for (const l of UI_LABELS) record(l, 'browser launched', `browser launch failed: ${msg}`, false);
    await cleanupAndExit(1);
    return;
  }

  try {
    // ── [AP-A] /api/contacts-all returns 502 ─────────────────────────────────
    console.log('\n  [AP-A] /api/contacts-all → 502 (HubSpot outage)');
    const page = await openHome(browser, memberClient.cookie);

    // [AP-A.1] "Active Projects" section header is visible
    const headingFound = await page.evaluate(() => {
      const el = document.querySelector('#home-view');
      if (!el) return false;
      const nodes = Array.from(el.querySelectorAll('*'));
      return nodes.some(n => n.children.length === 0 && (n.textContent || '').trim() === 'Active Projects');
    });
    record(
      UI_LABELS[0],
      '"Active Projects" text node present in #home-view',
      headingFound ? 'found' : 'not found',
      headingFound,
    );

    // [AP-A.2] Alert with "Unable to retrieve customer info" is visible.
    // MUI Alert renders as role="alert" — we require that specifically, not
    // just any element in the page containing the text.
    const alertFound = await page.evaluate(() => {
      const el = document.querySelector('#home-view');
      if (!el) return false;
      const alerts = Array.from(el.querySelectorAll('[role="alert"]'));
      return alerts.some(a => (a.textContent || '').includes('Unable to retrieve customer info'));
    });
    record(
      UI_LABELS[1],
      'Alert with "Unable to retrieve customer info" present in #home-view',
      alertFound ? 'found' : 'not found',
      alertFound,
    );

    // [AP-A.3] No customer cards — the ProjectsSection error branch renders
    // only the SectionHeader + Alert, not any HomeCard elements (which are
    // rendered as MuiCard-root > CardActionArea in the happy path).
    // We count clickable HomeCards within the Active Projects section.
    // The error branch renders zero <CardActionArea> children.
    const cardCount = await page.evaluate(() => {
      const el = document.querySelector('#home-view');
      if (!el) return -1;
      // Find the Active Projects section container.
      // The SectionHeader renders a Typography with text "Active Projects".
      // Its parent Box is the ProjectsSection wrapper — we look for it by
      // traversing up from the heading node.
      const allNodes = Array.from(el.querySelectorAll('*'));
      const heading = allNodes.find(
        n => n.children.length === 0 && (n.textContent || '').trim() === 'Active Projects',
      );
      if (!heading) return -1;
      // Walk up to find the section Box (the element that contains both the
      // heading and any cards). Stop at #home-view.
      let section = heading.parentElement;
      while (section && section !== el) {
        // The section Box has mb:3 styling — it contains the SectionHeader stack.
        // The heading is nested: Box > Stack > Stack > Typography.
        // We want the outermost Box that directly wraps both header and content.
        // A reliable heuristic: the element that contains both "Active Projects"
        // and an Alert or a Card. Walk up until we reach an element whose
        // direct children include the heading's ancestor AND sibling content.
        if (section.children.length >= 2) break;
        section = section.parentElement;
      }
      if (!section || section === el) return 0;
      // Count clickable cards (CardActionArea renders as a button) inside section.
      return section.querySelectorAll('button.MuiCardActionArea-root').length;
    });
    record(
      UI_LABELS[2],
      'zero customer cards rendered in Active Projects section',
      cardCount === -1 ? 'heading not found (section absent)' : `${cardCount} card(s) found`,
      cardCount === 0,
    );

    // [AP-B] Retry button is present inside the error Alert.
    // The Alert action renders a <button> with text "Retry" inside [role="alert"].
    const retryFound = await page.evaluate(() => {
      const el = document.querySelector('#home-view');
      if (!el) return false;
      const alerts = Array.from(el.querySelectorAll('[role="alert"]'));
      return alerts.some(a => {
        const buttons = Array.from(a.querySelectorAll('button'));
        return buttons.some(b => (b.textContent || '').trim() === 'Retry');
      });
    });
    record(
      UI_LABELS[3],
      'Retry button present inside [role="alert"] in #home-view',
      retryFound ? 'found' : 'not found',
      retryFound,
    );

    if (page.__logs.some(l => l.includes('pageerror'))) {
      console.log('  Page errors during test:');
      page.__logs.filter(l => l.includes('pageerror')).forEach(l => console.log('   ', l));
    }

    await page.__ctx.close().catch(() => {});

  } catch (e) {
    console.error('Test error:', e);
    console.error('--- server log (last 2000 chars) ---');
    console.error(logBuf.join('').slice(-2000));
  } finally {
    try { await browser.close(); } catch {}
    const failed = findings.filter(f => !f.ok).length;
    console.log(`\n  Results: ${findings.length - failed} passed, ${failed} failed`);
    await cleanupAndExit(failed === 0 ? 0 : 1);
  }
}

main();
