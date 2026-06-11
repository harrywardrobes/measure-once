'use strict';
const { makeSkip } = require('../helpers/report');
// test/settings-tab-load/run.js
//
// Regression guard for the waitForElement() race condition in loadHubspotStatus / loadLeadStatusesAdmin.
// waitForElement() in loadHubspotStatus / loadLeadStatusesAdmin replaces the
// early-return null checks that caused the badge to stay "Checking…" when the
// Settings tab was first opened before the React island had mounted the DOM.
//
// Covers:
//   [ST-A] #hubspot-status-badge text becomes "Connected" after the Settings
//          tab is opened (not "Checking…") — guards loadHubspotStatus race fix.
//   [ST-B] #lead-statuses-table-wrap contains a <table> element after
//          loadLeadStatusesAdmin runs — guards the waitForElement path that
//          previously returned early if the wrap div was not yet in the DOM.
//
// Strategy:
//   - Boot a disposable test server.
//   - Drive /admin with Puppeteer, injecting an admin session cookie.
//   - Use page.evaluateOnNewDocument to override window.fetch and intercept:
//       GET /api/hubspot/status          → { connected: true }
//       GET /api/admin/lead-statuses     → one-row fixture
//       GET /api/admin/hubspot/dev-mode  → { devMode: false }
//     All other requests pass through to the real test server.
//     This approach leaves dynamic module imports (React.lazy chunks) on the
//     normal network stack so the React island mounts successfully.
//   - Switch to the Settings tab via window.switchTab() and call the legacy
//     loaders (loadHubspotStatus, loadLeadStatusesAdmin, loadDevTestUsers).
//   - Poll for the expected DOM states.
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:settings-tab-load
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:settings-tab-load

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

const { pollUntil, waitForSwitchTab } = require('../helpers/poll');

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'settings-tab-load.md',
);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const LEAD_STATUSES_FIXTURE = [
  {
    key:                'NEW_LEAD',
    label:              'New Lead',
    stage:              'SALES',
    is_null_row:        false,
    sort_order:         1,
    exclude_from_sales: false,
  },
];

// Endpoints intercepted by the window.fetch override.  Values are the JSON
// objects to resolve; everything else passes through to the real server.
const INTERCEPT_RESPONSES = {
  '/api/hubspot/status':         { connected: true },
  '/api/admin/lead-statuses':    LEAD_STATUSES_FIXTURE,
  '/api/admin/hubspot/dev-mode': { devMode: false },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

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

async function pollPage(page, fn, arg, timeoutMs = 10000, intervalMs = 150) {
  return pollUntil(page, fn, timeoutMs, intervalMs, arg !== undefined && arg !== null ? [arg] : []);
}

// ── Report ────────────────────────────────────────────────────────────────────

function writeReport(runId, findings) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok && !f.skipped).length;
  const skipped = findings.filter(f => f.skipped).length;
  const lines = [
    '# Settings Tab Load — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:settings-tab-load\``,
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
    '- **[ST-A] HubSpot badge text**: Opens the Settings tab while intercepting',
    '  `GET /api/hubspot/status` to return `{ connected: true }`. Polls until',
    '  `#hubspot-status-badge` text is "Connected" (not "Checking…"). Regression',
    '  guard for the `waitForElement` fix in `loadHubspotStatus`.',
    '- **[ST-B] Lead statuses table**: Intercepts `GET /api/admin/lead-statuses`',
    '  to return a one-row fixture. Polls until `#lead-statuses-table-wrap`',
    '  contains a `<table>` element. Guards the `waitForElement` fix in',
    '  `loadLeadStatusesAdmin`.',
    '- **[runtime errors]**: Asserts no `pageerror` or `console.error` events',
    '  occur during the tab load.',
    '',
    '## Notes',
    '',
    '- Requires `public/react/main.js`; run `npm run build:react` first.',
    '- Uses `page.evaluateOnNewDocument` to override `window.fetch` for the',
    '  three intercepted endpoints. This leaves dynamic module imports',
    '  (React.lazy chunks) on the normal network stack so the React island mounts',
    '  successfully and `waitForElement` can find the badge and wrap elements.',
    '- `GET /api/admin/hubspot/dev-mode` is also intercepted to return',
    '  `{ devMode: false }` so `loadDevTestUsers()` gracefully hides the dev',
    '  section without making a real HubSpot call.',
    '- All other requests (auth, team data, etc.) pass through to the test server',
    '  (authenticated via the seeded admin session cookie).',
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

  const bundlePath = path.resolve(__dirname, '..', '..', 'public', 'react', 'main.js');
  if (!fs.existsSync(bundlePath)) {
    console.error(
      '\n  ✘ public/react/main.js is missing.\n'
      + '    Run `npm run build:react` before this test.\n',
    );
    process.exit(2);
  }

  const runId = Math.random().toString(36).slice(2, 8);
  console.log(`\n  settings-tab-load  run=${runId}`);
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
  function record(name, expected, observed, ok) {
    findings.push({ name, expected, observed, ok });
    const mark = ok ? '  ✓' : '  ✗';
    console.log(`${mark}  ${name}`);
    if (!ok) {
      console.log(`     expected : ${expected}`);
      console.log(`     observed : ${observed}`);
    }
  }
  const skip = makeSkip(findings);

  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    writeReport(runId, findings);
    process.exit(code);
  };

  process.on('SIGINT',  () => cleanupAndExit(130));
  process.on('SIGTERM', () => cleanupAndExit(130));
  process.on('uncaughtException',  e => { console.error('Uncaught:',  e); cleanupAndExit(2); });
  process.on('unhandledRejection', e => { console.error('Unhandled:', e); cleanupAndExit(2); });

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

  const UI_LABELS = [
    '[ST-A] #hubspot-status-badge text is "Connected" after Settings tab opens',
    '[ST-B] #lead-statuses-table-wrap contains a <table> after Settings tab opens',
    'no uncaught page errors during Settings tab load',
  ];

  if (!puppeteer) {
    for (const l of UI_LABELS) {
      skip(l, 'puppeteer installed', 'puppeteer not installed');
    }
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
      browser = await puppeteer.launch({
        headless: true,
        defaultViewport: { width: 1280, height: 900 },
        ...opts,
      });
      browserLaunchErr = null;
      break;
    } catch (e) { browserLaunchErr = e; browser = null; }
  }

  if (!browser) {
    const msg = (browserLaunchErr?.message || String(browserLaunchErr)).slice(0, 200);
    for (const l of UI_LABELS) skip(l, 'browser launched', `browser launch failed: ${msg}`);
    await cleanupAndExit(1);
    return;
  }

  const adminClient = await login(users.admin.email, PASSWORD);

  const pageErrors = [];
  const IGNORE_RE = /(favicon\.ico|\/storybook\/|\.map\b|Failed to load resource)/;

  try {
    const page = await browser.newPage();
    await page.setCacheEnabled(false);

    page.on('pageerror', err => { pageErrors.push(String(err)); });
    page.on('console', msg => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (IGNORE_RE.test(text)) return;
      pageErrors.push(`console.error: ${text}`);
    });

    // Install a fetch override BEFORE any page JS runs.
    // This intercepts the three admin API calls at the JS engine level so
    // the real network stack (and therefore dynamic module imports) is
    // completely unaffected.
    const interceptJson = JSON.stringify(INTERCEPT_RESPONSES);
    await page.evaluateOnNewDocument((mapJson) => {
      const map = JSON.parse(mapJson);
      const originalFetch = window.fetch;
      window.fetch = function (input, init) {
        const raw = typeof input === 'string' ? input : (input && input.url) || '';
        const pathname = raw.startsWith('http')
          ? (() => { try { return new URL(raw).pathname; } catch { return raw; } })()
          : raw.split('?')[0];
        if (Object.prototype.hasOwnProperty.call(map, pathname)) {
          const body = JSON.stringify(map[pathname]);
          return Promise.resolve(
            new Response(body, {
              status:  200,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        }
        return originalFetch.call(this, input, init);
      };
    }, interceptJson);

    await injectSession(page, adminClient.cookie);

    // Navigate to /admin. The default active tab (team) mounts on page load;
    // the Settings panel is NOT mounted by React until switchTab('settings')
    // is called for the first time — that is what triggers the React.lazy()
    // fetch for the SettingsPage chunk, which then renders #hubspot-status-badge
    // and #lead-statuses-table-wrap into the DOM.
    await page.goto(`${BASE}/admin`, {
      waitUntil: 'domcontentloaded',
      timeout: 25000,
    });

    // Wait for window.switchTab to be defined — the React bundle must have
    // evaluated and registered admin tab handlers before we can call it.
    await waitForSwitchTab(page, 10000);

    // ── Activate the Settings tab ────────────────────────────────────────────
    //
    // Mirrors the real onclick on the Settings tab button:
    //   switchTab('settings'); loadHubspotStatus(); loadLeadStatusesAdmin(); loadDevTestUsers()
    //
    // switchTab() triggers React.lazy() for the SettingsPage chunk.  Once the
    // chunk loads, React renders the panel — including #hubspot-status-badge
    // (initial text "Checking…") and #lead-statuses-table-wrap (initial
    // content "<p>Loading…</p>").  waitForElement() in each loader detects the
    // newly-inserted elements and then makes the mocked API calls, updating
    // the badge text and injecting the <table>.
    console.log('\n  Activating Settings tab…');
    await page.evaluate(() => {
      if (typeof window.switchTab === 'function') {
        window.switchTab('settings');
      }
      if (typeof window.loadHubspotStatus === 'function') {
        window.loadHubspotStatus();
      }
      if (typeof window.loadLeadStatusesAdmin === 'function') {
        window.loadLeadStatusesAdmin();
      }
      if (typeof window.loadDevTestUsers === 'function') {
        window.loadDevTestUsers();
      }
    });

    // ── [ST-A] HubSpot badge ─────────────────────────────────────────────────
    //
    // Poll until the badge text has moved away from "Checking…".  With the
    // mocked { connected: true } response the text should become "Connected".
    console.log('\n  [ST-A] Waiting for #hubspot-status-badge to show "Connected"…');
    const badgeText = await pollPage(page, () => {
      const el = document.getElementById('hubspot-status-badge');
      if (!el) return null;
      const t = (el.textContent || '').trim();
      return (t && t !== 'Checking…') ? t : null;
    }, null, 15000);

    record(
      UI_LABELS[0],
      '"Connected"',
      badgeText ? `"${badgeText}"` : '"Checking…" (timed out — badge never updated)',
      badgeText === 'Connected',
    );

    // ── [ST-B] Lead statuses table ───────────────────────────────────────────
    //
    // Poll until #lead-statuses-table-wrap contains a <table>.
    // renderLeadStatusesTable() writes the full <table> into the div once the
    // mocked /api/admin/lead-statuses response arrives.
    console.log('\n  [ST-B] Waiting for #lead-statuses-table-wrap to contain a <table>…');
    const tablePresent = await pollPage(page, () => {
      const wrap = document.getElementById('lead-statuses-table-wrap');
      if (!wrap) return null;
      return wrap.querySelector('table') ? 'found' : null;
    }, null, 15000);

    record(
      UI_LABELS[1],
      '<table> inside #lead-statuses-table-wrap',
      tablePresent ? 'found' : 'not found (timed out)',
      tablePresent === 'found',
    );

    // ── Runtime errors ───────────────────────────────────────────────────────
    record(
      UI_LABELS[2],
      '0 pageerror / console.error events',
      `count=${pageErrors.length}${pageErrors.length ? ' first=' + JSON.stringify(pageErrors[0]).slice(0, 200) : ''}`,
      pageErrors.length === 0,
    );

    await page.close();
  } catch (e) {
    console.error('Test error:', e);
    console.error('--- server log (last 2000 chars) ---');
    console.error(logBuf.join('').slice(-2000));
  } finally {
    try { await browser.close(); } catch {}
    const failed = findings.filter(f => !f.ok && !f.skipped).length;
    console.log(`\n  Results: ${findings.length - failed} passed, ${failed} failed`);
    await cleanupAndExit(failed === 0 ? 0 : 1);
  }
}

main();
