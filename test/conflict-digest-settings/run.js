'use strict';

const PROBE_LABELS = [
  '[CD-1] SMTP not configured — "Send now" disabled, SMTP-missing Alert shown',
  '[CD-1a] "Conflict digest" heading visible in Settings panel',
  '[CD-1b] "Last sent:" text visible in conflict digest card',
  '[CD-1c] "Send now" button is present and disabled (SMTP unconfigured)',
  '[CD-1d] SMTP-missing Alert is shown',
  '[CD-2] SMTP configured — button enabled, "Last sent" reads "Never"',
  '[CD-2a] "Send now" button is enabled (SMTP configured)',
  '[CD-2b] no SMTP-missing Alert when SMTP is configured',
  '[CD-2c] "Last sent" value reads "Never" when lastSentAt is null',
  '[CD-3] clicking "Send now" updates the "Last sent" span to the formatted timestamp',
];

// test/conflict-digest-settings/run.js
//
// Integration test for the Conflict digest panel in Admin Settings.
//
// Covers:
//   [CD-1] Conflict digest card is visible with "Last sent" text and a
//          "Send now" button.  When GET /api/admin/conflict-digest-settings
//          returns { smtpConfigured: false, lastSentAt: null }, the button
//          is disabled and the SMTP-missing Alert is shown.
//   [CD-2] When GET /api/admin/conflict-digest-settings returns
//          { smtpConfigured: true, lastSentAt: null }, the button is enabled
//          and no SMTP warning Alert is shown.  "Last sent" reads "Never".
//   [CD-3] When the user clicks "Send now" and
//          POST /api/admin/conflict-digest/send-now returns
//          { sent: true, lastSentAt: '2026-05-26T12:00:00.000Z' }, the
//          "Last sent" label updates to the formatted timestamp.
//
// Strategy:
//   - Boot a disposable test server (via the shared harness).
//   - Drive /admin with Puppeteer, injecting an admin session cookie.
//   - Use page.evaluateOnNewDocument to override window.fetch before each
//     page navigation so the React island receives mock responses without
//     affecting dynamic module imports (React.lazy chunks).
//   - Open a fresh Puppeteer page for each scenario so the fetch override
//     applies cleanly.
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:conflict-digest-settings
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:conflict-digest-settings

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

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'conflict-digest-settings.md',
);

// Fake ISO timestamp used in the CD-3 send-now scenario.
const FAKE_LAST_SENT_AT = '2026-05-26T12:00:00.000Z';

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

async function pollPage(page, fn, timeoutMs = 12000, intervalMs = 150) {
  return pollUntil(page, fn, timeoutMs, intervalMs);
}

// Install the window.fetch override before any page JS runs.
// interceptMap: { 'GET /path': responseBody, 'POST /path': responseBody }
// All other requests are forwarded to the real server.
async function installFetchOverride(page, interceptMap) {
  await page.evaluateOnNewDocument((mapJson) => {
    const map = JSON.parse(mapJson);
    const originalFetch = window.fetch;
    window.fetch = function (input, init) {
      const method = (init && init.method ? init.method : 'GET').toUpperCase();
      const raw = typeof input === 'string' ? input : (input && input.url) || '';
      const pathname = raw.startsWith('http')
        ? (() => { try { return new URL(raw).pathname; } catch { return raw; } })()
        : raw.split('?')[0];
      const key = `${method} ${pathname}`;
      if (Object.prototype.hasOwnProperty.call(map, key)) {
        const body = JSON.stringify(map[key]);
        return Promise.resolve(
          new Response(body, {
            status:  200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return originalFetch.call(this, input, init);
    };
  }, JSON.stringify(interceptMap));
}

// Navigate to /admin and open the Settings tab.
async function openSettingsTab(page) {
  await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded', timeout: 25000 });
  // Wait for the React island to evaluate and the initial team tab to mount.
  await new Promise(r => setTimeout(r, 800));
  await page.evaluate(() => {
    if (typeof window.switchTab === 'function') window.switchTab('settings');
  });
}

// ── Report ────────────────────────────────────────────────────────────────────

function writeReport(runId, findings) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok).length;
  const lines = [
    '# Conflict Digest Settings — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:conflict-digest-settings\``,
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
    '- **[CD-1] SMTP unconfigured**: Intercepts GET /api/admin/conflict-digest-settings',
    '  with { smtpConfigured: false, lastSentAt: null }. Asserts "Conflict digest"',
    '  heading visible, "Last sent" text present, "Send now" button present and',
    '  disabled, and the SMTP-missing Alert is shown.',
    '- **[CD-2] SMTP configured**: Intercepts with { smtpConfigured: true, lastSentAt: null }.',
    '  Asserts "Send now" button is enabled and no SMTP warning Alert is present.',
    '  "Last sent" value is "Never".',
    '- **[CD-3] Send now updates timestamp**: Intercepts GET as smtpConfigured:true and',
    '  POST /api/admin/conflict-digest/send-now as { sent: true, lastSentAt: FAKE_LAST_SENT_AT }.',
    '  Clicks the "Send now" button; polls until "Last sent" shows the formatted',
    '  timestamp of FAKE_LAST_SENT_AT.',
    '- **[runtime errors]**: Asserts no pageerror or console.error events during the',
    '  Settings tab load in any scenario.',
    '',
    '## Notes',
    '',
    '- Requires public/react/main.js; run `npm run build:react` first.',
    '- Each scenario uses a fresh Puppeteer page with its own evaluateOnNewDocument',
    '  fetch override to keep scenarios fully isolated.',
    '- Fetch override matches on "METHOD /pathname" keys, so GET and POST are handled',
    '  separately. Dynamic module imports (React.lazy chunks) are unaffected.',
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
  console.log(`\n  conflict-digest-settings  run=${runId}`);
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
    '[CD-1a] "Conflict digest" heading visible in Settings panel',
    '[CD-1b] "Last sent:" text visible in conflict digest card',
    '[CD-1c] "Send now" button is present and disabled (SMTP unconfigured)',
    '[CD-1d] SMTP-missing Alert is shown',
    '[CD-2a] "Send now" button is enabled (SMTP configured)',
    '[CD-2b] No SMTP-missing Alert when SMTP is configured',
    '[CD-2c] "Last sent" value reads "Never" when lastSentAt is null',
    '[CD-3]  "Last sent" updates to formatted timestamp after Send now',
    'no uncaught page errors across all scenarios',
  ];

  if (!puppeteer) {
    for (const l of UI_LABELS) {
      record(l, 'puppeteer installed', 'puppeteer not installed', false);
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
    for (const l of UI_LABELS) record(l, 'browser launched', `browser launch failed: ${msg}`, false);
    await cleanupAndExit(1);
    return;
  }

  const adminClient = await login(users.admin.email, PASSWORD);

  const pageErrors = [];
  const IGNORE_RE = /(favicon\.ico|\/storybook\/|\.map\b|Failed to load resource)/;

  // Common intercept overrides that are the same across all scenarios.
  // These prevent unrelated API calls from hitting the real server and
  // producing noise (e.g. HubSpot, dev-mode, lead statuses).
  const BASE_INTERCEPTS = {
    'GET /api/hubspot/status':         { connected: false },
    'GET /api/admin/lead-statuses':    [],
    'GET /api/admin/hubspot/dev-mode': { devMode: false },
  };

  try {
    // ── Scenario CD-1: SMTP unconfigured ─────────────────────────────────────

    console.log('\n  === Scenario CD-1: SMTP unconfigured ===');

    const page1 = await browser.newPage();
    await page1.setCacheEnabled(false);
    page1.on('pageerror', err => { pageErrors.push(String(err)); });
    page1.on('console', msg => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (IGNORE_RE.test(text)) return;
      pageErrors.push(`console.error: ${text}`);
    });

    await installFetchOverride(page1, {
      ...BASE_INTERCEPTS,
      'GET /api/admin/conflict-digest-settings': { smtpConfigured: false, lastSentAt: null },
    });
    await injectSession(page1, adminClient.cookie);
    await openSettingsTab(page1);

    // Poll for the conflict digest heading to appear (indicates Settings panel rendered).
    console.log('  [CD-1a] Polling for "Conflict digest" heading…');
    const headingFound = await pollPage(page1, () => {
      const headings = Array.from(document.querySelectorAll('h6'));
      return headings.some(el => (el.textContent || '').includes('Conflict digest')) ? 'found' : null;
    }, 15000);

    record(UI_LABELS[0],
      '"Conflict digest" h6 heading present',
      headingFound ? 'found' : 'not found (timed out)',
      headingFound === 'found',
    );

    // Poll for "Last sent:" text.
    console.log('  [CD-1b] Polling for "Last sent:" text…');
    const lastSentLabelFound = await pollPage(page1, () => {
      const spans = Array.from(document.querySelectorAll('span, p'));
      return spans.some(el => (el.textContent || '').trim() === 'Last sent:') ? 'found' : null;
    }, 10000);

    record(UI_LABELS[1],
      '"Last sent:" span present',
      lastSentLabelFound ? 'found' : 'not found',
      lastSentLabelFound === 'found',
    );

    // Poll for "Send now" button that is disabled.
    console.log('  [CD-1c] Polling for disabled "Send now" button…');
    const sendBtnDisabled = await pollPage(page1, () => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b => (b.textContent || '').trim().includes('Send now'));
      if (!btn) return null;
      return btn.disabled ? 'disabled' : 'enabled';
    }, 10000);

    record(UI_LABELS[2],
      '"Send now" button present and disabled',
      sendBtnDisabled || 'not found',
      sendBtnDisabled === 'disabled',
    );

    // Poll for SMTP warning Alert.
    console.log('  [CD-1d] Polling for SMTP-missing Alert…');
    const smtpAlertFound = await pollPage(page1, () => {
      const alerts = Array.from(document.querySelectorAll('[role="alert"]'));
      return alerts.some(el => (el.textContent || '').includes('SMTP is not configured')) ? 'found' : null;
    }, 10000);

    record(UI_LABELS[3],
      'SMTP-missing Alert with role="alert" present',
      smtpAlertFound ? 'found' : 'not found',
      smtpAlertFound === 'found',
    );

    await page1.close();

    // ── Scenario CD-2: SMTP configured ───────────────────────────────────────

    console.log('\n  === Scenario CD-2: SMTP configured, lastSentAt: null ===');

    const page2 = await browser.newPage();
    await page2.setCacheEnabled(false);
    page2.on('pageerror', err => { pageErrors.push(String(err)); });
    page2.on('console', msg => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (IGNORE_RE.test(text)) return;
      pageErrors.push(`console.error: ${text}`);
    });

    await installFetchOverride(page2, {
      ...BASE_INTERCEPTS,
      'GET /api/admin/conflict-digest-settings': { smtpConfigured: true, lastSentAt: null },
    });
    await injectSession(page2, adminClient.cookie);
    await openSettingsTab(page2);

    // Wait for the conflict digest heading (panel rendered).
    await pollPage(page2, () => {
      const headings = Array.from(document.querySelectorAll('h6'));
      return headings.some(el => (el.textContent || '').includes('Conflict digest')) ? 'found' : null;
    }, 15000);

    // Poll for "Send now" button that is ENABLED.
    console.log('  [CD-2a] Polling for enabled "Send now" button…');
    const sendBtnEnabled = await pollPage(page2, () => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b => (b.textContent || '').trim().includes('Send now'));
      if (!btn) return null;
      return !btn.disabled ? 'enabled' : 'disabled';
    }, 12000);

    record(UI_LABELS[4],
      '"Send now" button present and enabled',
      sendBtnEnabled || 'not found',
      sendBtnEnabled === 'enabled',
    );

    // Confirm no SMTP-missing Alert.
    console.log('  [CD-2b] Checking SMTP-missing Alert is absent…');
    const smtpAlertAbsent = await page2.evaluate(() => {
      const alerts = Array.from(document.querySelectorAll('[role="alert"]'));
      return !alerts.some(el => (el.textContent || '').includes('SMTP is not configured'));
    });

    record(UI_LABELS[5],
      'No SMTP-missing Alert',
      smtpAlertAbsent ? 'no alert' : 'alert found unexpectedly',
      smtpAlertAbsent,
    );

    // Confirm "Last sent" shows "Never".
    console.log('  [CD-2c] Polling for "Last sent" value = "Never"…');
    const lastSentNever = await pollPage(page2, () => {
      const spans = Array.from(document.querySelectorAll('span'));
      return spans.some(el => (el.textContent || '').trim() === 'Never') ? 'found' : null;
    }, 10000);

    record(UI_LABELS[6],
      '"Never" span present next to "Last sent:"',
      lastSentNever ? 'found' : 'not found',
      lastSentNever === 'found',
    );

    await page2.close();

    // ── Scenario CD-3: Send now updates timestamp ─────────────────────────────

    console.log('\n  === Scenario CD-3: Click "Send now" → timestamp updates ===');

    const page3 = await browser.newPage();
    await page3.setCacheEnabled(false);
    page3.on('pageerror', err => { pageErrors.push(String(err)); });
    page3.on('console', msg => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (IGNORE_RE.test(text)) return;
      pageErrors.push(`console.error: ${text}`);
    });

    await installFetchOverride(page3, {
      ...BASE_INTERCEPTS,
      'GET /api/admin/conflict-digest-settings': { smtpConfigured: true, lastSentAt: null },
      'POST /api/admin/conflict-digest/send-now': { sent: true, lastSentAt: FAKE_LAST_SENT_AT },
    });
    // Expose the fake ISO string to the browser so the in-page pollPage callback
    // can call new Date(isoStr).toLocaleString() — matching exactly the format
    // the React component uses — rather than relying on Node's locale.
    await page3.evaluateOnNewDocument((iso) => {
      window.__cdTestFakeLastSentAt = iso;
    }, FAKE_LAST_SENT_AT);
    await injectSession(page3, adminClient.cookie);
    await openSettingsTab(page3);

    // Wait for the "Send now" button to become enabled before clicking.
    console.log('  [CD-3] Waiting for enabled "Send now" button before clicking…');
    const sendBtnHandle = await pollPage(page3, () => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b => (b.textContent || '').trim().includes('Send now'));
      if (!btn || btn.disabled) return null;
      return 'ready';
    }, 15000);

    if (sendBtnHandle === 'ready') {
      console.log('  [CD-3] Clicking "Send now"…');
      await page3.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => (b.textContent || '').trim().includes('Send now'));
        if (btn && !btn.disabled) btn.click();
      });

      // Pass FAKE_LAST_SENT_AT into the browser so it computes toLocaleString()
      // there — same locale/timezone the component uses — then compares in-page.
      console.log(`  [CD-3] Polling for "Last sent" to update away from "Never"…`);

      const tsObserved = await pollPage(page3, () => {
        const isoStr = window.__cdTestFakeLastSentAt;
        if (!isoStr) return null;
        const expected = new Date(isoStr).toLocaleString();
        const spans = Array.from(document.querySelectorAll('span'));
        return spans.some(el => (el.textContent || '').trim() === expected) ? expected : null;
      }, 12000);

      record(UI_LABELS[7],
        `"Last sent" span shows formatted timestamp of ${FAKE_LAST_SENT_AT}`,
        tsObserved ? `"${tsObserved}"` : 'not updated (still "Never" or timed out)',
        !!tsObserved,
      );
    } else {
      record(UI_LABELS[7],
        '"Send now" button ready to click',
        'button did not become enabled (timed out)',
        false,
      );
    }

    await page3.close();

    // ── Runtime errors ────────────────────────────────────────────────────────
    record(
      UI_LABELS[8],
      '0 pageerror / console.error events across all scenarios',
      `count=${pageErrors.length}${pageErrors.length ? ' first=' + JSON.stringify(pageErrors[0]).slice(0, 200) : ''}`,
      pageErrors.length === 0,
    );

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
