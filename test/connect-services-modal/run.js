'use strict';
const { makeSkip } = require('../helpers/report');

const PROBE_LABELS = [
  // [CSM-A] Modal renders correct service rows
  '[CSM-A] modal dialog visible after opening',
  '[CSM-A] Google Calendar row present in modal',
  '[CSM-A] QuickBooks row present in modal',
  '[CSM-A] HubSpot row present in modal',
  '[CSM-A] Database row NOT present in modal (status-only)',
  // [CSM-B] Status chips reflect intercepted service statuses
  '[CSM-B] Google Calendar chip shows Disconnected when status=error',
  '[CSM-B] QuickBooks chip shows Connected when status=ok',
  // [CSM-C] Done button closes modal
  '[CSM-C] Done button closes modal',
  // [CSM-D] QuickBooks action cell respects privilege
  '[CSM-D] member sees admin-only note for QuickBooks',
  '[CSM-D] admin sees Connect button for QuickBooks (when disconnected)',
  // [CSM-E] Navbar icon click opens modal
  '[CSM-E] clicking navbar service icon opens modal',
  '[CSM-E] highlighted service row has distinct border when opened via icon click',
  // [CSM-F] Auto-open once-per-session contract
  '[CSM-F1] modal auto-opens when a service transitions to error state',
  '[CSM-F2] session flag prevents auto-open a second time in same session',
  '[CSM-F3] manual openConnectModal() still works after session flag is set',
];

// test/connect-services-modal/run.js
//
// Puppeteer coverage for ConnectServicesModal.
// Boots a disposable test server, navigates to a known authenticated page,
// intercepts /api/*/status endpoints, drives the modal via both the window bridge
// and the navbar icon click, and asserts correct row content / chip labels.
//
// Probes:
//   [CSM-A] After openConnectModal() via bridge: dialog is visible, Google/QB/HS
//           rows present, Database row absent (status-only).
//   [CSM-B] Status chips reflect the intercepted service statuses:
//           Google → Disconnected (error), QuickBooks → Connected (ok).
//   [CSM-C] Clicking Done button closes the dialog.
//   [CSM-D] QuickBooks action cell: member sees "Ask an admin…" note;
//           admin sees "Connect" button when QB status is error.
//   [CSM-E] Clicking a navbar service-status icon opens the dialog with the
//           corresponding row highlighted.
//
// Usage:
//   DATABASE_URL_TEST=<isolated> npm run test:connect-services-modal
//   PRIVTEST_ALLOW_SHARED_DB=1  npm run test:connect-services-modal

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
  __dirname, '..', '..', 'test-results', 'connect-services-modal.md',
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
const skip = makeSkip(findings);

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

async function pollPage(page, fn, timeoutMs = 15000, intervalMs = 150) {
  return pollUntil(page, fn, timeoutMs, intervalMs);
}

/**
 * Open the home page with all service status endpoints intercepted.
 * statusMap: partial map of { google, quickbooks, hubspot, database } → connected bool.
 */
async function openHomePage(browser, jar, statusMap = {}) {
  const ctx = await (browser.createBrowserContext
    ? browser.createBrowserContext()
    : browser.createIncognitoBrowserContext());
  const page = await ctx.newPage();
  page.__ctx = ctx;
  await page.setCacheEnabled(false);

  const pageLogs = [];
  page.on('console',       m => pageLogs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror',     e => pageLogs.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', r => pageLogs.push(`[reqfailed] ${r.url()} ${r.failure()?.errorText || ''}`));

  const statusMapJson = JSON.stringify({
    google:     statusMap.google     ?? true,
    quickbooks: statusMap.quickbooks ?? true,
    hubspot:    statusMap.hubspot    ?? true,
    database:   statusMap.database   ?? true,
  });

  // Intercept status endpoints and block real outbound calls that would fail.
  await page.evaluateOnNewDocument((smJson) => {
    const sm = JSON.parse(smJson);
    const originalFetch = window.fetch;
    window.fetch = function(input, init) {
      const url     = typeof input === 'string' ? input : (input && input.url) || '';
      const rawPath = url.startsWith('http') ? new URL(url).pathname : url.split('?')[0];
      const STATUS_ROUTES = {
        '/api/google/status':     sm.google,
        '/api/quickbooks/status': sm.quickbooks,
        '/api/hubspot/status':    sm.hubspot,
        '/api/database/status':   sm.database,
      };
      if (rawPath in STATUS_ROUTES) {
        return Promise.resolve(new Response(JSON.stringify({ connected: STATUS_ROUTES[rawPath] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return originalFetch.call(this, input, init);
    };
  }, statusMapJson);

  await injectSession(page, jar);
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  page.__logs = pageLogs;
  return page;
}

/** Open the Connect Services modal via the window bridge. */
async function openModalViaBridge(page, service) {
  await page.evaluate((svc) => {
    if (typeof window.__connectionToast?.openConnectModal === 'function') {
      window.__connectionToast.openConnectModal(svc);
    }
  }, service);
}

/** Wait until [data-testid="connect-services-modal"] is visible. */
async function waitForModal(page, timeoutMs = 10000) {
  return pollPage(page, () => {
    const el = document.querySelector('[data-testid="connect-services-modal"]');
    if (!el) return null;
    // MUI Dialog: check the paper is visible (not aria-hidden)
    const paper = el.querySelector('[role="dialog"]') || el;
    return paper && !paper.closest('[aria-hidden="true"]') ? 'visible' : null;
  }, timeoutMs);
}

/** Wait until the modal is gone. */
async function waitForModalClosed(page, timeoutMs = 8000) {
  return pollPage(page, () => {
    const el = document.querySelector('[data-testid="connect-services-modal"]');
    if (!el) return 'closed';
    const paper = el.querySelector('[role="dialog"]') || el;
    return (!paper || paper.closest('[aria-hidden="true"]')) ? 'closed' : null;
  }, timeoutMs);
}

/** Read the current state of the modal content. */
async function getModalState(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="connect-services-modal"]');
    if (!dialog) return { found: false };

    const rows = {
      google:     !!dialog.querySelector('[data-testid="connect-row-google"]'),
      quickbooks: !!dialog.querySelector('[data-testid="connect-row-quickbooks"]'),
      hubspot:    !!dialog.querySelector('[data-testid="connect-row-hubspot"]'),
      database:   !!dialog.querySelector('[data-testid="connect-row-database"]'),
    };

    function chipText(key) {
      const chip = dialog.querySelector(`[data-testid="connect-status-chip-${key}"]`);
      return chip ? (chip.textContent || '').trim() : null;
    }

    function actionText(key) {
      const action = dialog.querySelector(`[data-testid="connect-action-${key}"]`);
      return action ? (action.textContent || '').trim() : null;
    }

    function rowBorderColor(key) {
      const row = dialog.querySelector(`[data-testid="connect-row-${key}"]`);
      if (!row) return null;
      return window.getComputedStyle(row).borderColor;
    }

    const doneBtn = dialog.querySelector('[data-testid="connect-services-done"]');

    return {
      found: true,
      rows,
      chips: {
        google:     chipText('google'),
        quickbooks: chipText('quickbooks'),
        hubspot:    chipText('hubspot'),
      },
      actions: {
        quickbooks: actionText('quickbooks'),
      },
      rowBorderColors: {
        google:     rowBorderColor('google'),
        quickbooks: rowBorderColor('quickbooks'),
      },
      hasDoneBtn: !!doneBtn,
    };
  });
}

/** Click a navbar service status icon for the given service key. */
async function clickNavbarIcon(page, serviceKey) {
  return page.evaluate((key) => {
    // Find the button wrapping the service status icon for this service.
    // ServiceStatusBadge renders a box with data-testid="service-status-icon" inside.
    // We identify the correct one by aria-label containing the service name.
    const buttons = Array.from(document.querySelectorAll('[aria-label*="connections"]'));
    if (buttons.length === 0) {
      // Fallback: find any element with the service icon that is clickable
      const icons = Array.from(document.querySelectorAll('[data-testid="service-status-icon"]'));
      if (icons[0]) { icons[0].closest('button, [role="button"]')?.click(); return true; }
      return false;
    }
    // Find by aria-label containing the specific label
    const LABELS = { google: 'Google Calendar', quickbooks: 'QuickBooks', hubspot: 'HubSpot', database: 'Database' };
    const label = LABELS[key];
    const btn = buttons.find(b => (b.getAttribute('aria-label') || '').includes(label));
    if (btn) { btn.click(); return true; }
    // Fallback: click the first service icon button
    buttons[0].click();
    return true;
  }, serviceKey);
}

// ── report ─────────────────────────────────────────────────────────────────────

async function writeReport(runId) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed  = findings.filter(f => f.ok).length;
  const failed  = findings.filter(f => !f.ok && !f.skipped).length;
  const skipped = findings.filter(f => f.skipped).length;
  const lines = [
    '# Connect Services Modal — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:connect-services-modal\``,
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
    '- **[CSM-A] Row content**: modal rows match the non-status-only SERVICE_DESCRIPTORS.',
    '- **[CSM-B] Chips**: reflect the intercepted /api/*/status responses.',
    '- **[CSM-C] Done button**: closes the dialog.',
    '- **[CSM-D] QB privilege gate**: member sees admin note; admin sees Connect button.',
    '- **[CSM-E] Navbar icon click**: opens modal and highlights the clicked service row.',
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
  console.log(`\n  connect-services-modal  run=${runId}`);
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

  if (!puppeteer) {
    for (const l of PROBE_LABELS) skip(l, 'puppeteer installed', 'puppeteer not installed');
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
    for (const l of PROBE_LABELS) skip(l, 'browser launched', `browser launch failed: ${msg}`);
    await cleanupAndExit(1);
    return;
  }

  const memberClient = await login(users.member.email, users.member.password);
  const adminClient  = await login(users.admin.email,  users.admin.password);

  try {
    // ── [CSM-A/B/C] Open modal for member, google=error, quickbooks=ok ────────
    console.log('\n  [CSM-A/B/C] modal content and Done button (member)');
    const pageABC = await openHomePage(browser, memberClient.cookie, {
      google:     false, // → Disconnected chip
      quickbooks: true,  // → Connected chip
      hubspot:    true,
      database:   true,
    });

    // Wait for the header to mount (the navbar service icons are part of GlobalHeader).
    await pollPage(pageABC, () => {
      return document.querySelector('[data-testid="global-header"]') ? 'ok' : null;
    }, 15000);

    // Open modal via window bridge.
    await openModalViaBridge(pageABC, undefined);

    const modalVisible = await waitForModal(pageABC);
    record(PROBE_LABELS[0], 'modal visible', modalVisible ? 'visible' : 'not visible', !!modalVisible);

    const stateABC = await getModalState(pageABC);

    record(PROBE_LABELS[1], 'row present', stateABC.rows.google ? 'present' : 'absent', stateABC.rows.google);
    record(PROBE_LABELS[2], 'row present', stateABC.rows.quickbooks ? 'present' : 'absent', stateABC.rows.quickbooks);
    record(PROBE_LABELS[3], 'row present', stateABC.rows.hubspot ? 'present' : 'absent', stateABC.rows.hubspot);
    record(PROBE_LABELS[4], 'row absent', stateABC.rows.database ? 'present (unexpected)' : 'absent', !stateABC.rows.database);

    // Wait a moment for the status checks to settle (they're intercepted so fast).
    await new Promise(r => setTimeout(r, 500));
    const stateB = await getModalState(pageABC);

    record(
      PROBE_LABELS[5],
      'chip=Disconnected',
      `chip="${stateB.chips.google}"`,
      stateB.chips.google === 'Disconnected',
    );
    record(
      PROBE_LABELS[6],
      'chip=Connected',
      `chip="${stateB.chips.quickbooks}"`,
      stateB.chips.quickbooks === 'Connected',
    );

    // Click Done.
    await pageABC.evaluate(() => {
      const btn = document.querySelector('[data-testid="connect-services-done"]');
      if (btn) btn.click();
    });
    const closedC = await waitForModalClosed(pageABC);
    record(PROBE_LABELS[7], 'modal closed', closedC ? 'closed' : 'still open', !!closedC);

    await pageABC.__ctx.close().catch(() => {});

    // ── [CSM-D] QuickBooks privilege gate ─────────────────────────────────────
    console.log('\n  [CSM-D] QB action cell — member vs admin');

    // member: QB disconnected
    const pageD1 = await openHomePage(browser, memberClient.cookie, {
      quickbooks: false,
    });
    await pollPage(pageD1, () => document.querySelector('[data-testid="global-header"]') ? 'ok' : null, 15000);
    await openModalViaBridge(pageD1, 'quickbooks');
    await waitForModal(pageD1);
    await new Promise(r => setTimeout(r, 400));
    const stateD1 = await getModalState(pageD1);
    record(
      PROBE_LABELS[8],
      '"Ask an admin" note',
      `action="${stateD1.actions.quickbooks}"`,
      (stateD1.actions.quickbooks || '').toLowerCase().includes('ask an admin'),
    );
    await pageD1.__ctx.close().catch(() => {});

    // admin: QB disconnected → should see Connect button
    const pageD2 = await openHomePage(browser, adminClient.cookie, {
      quickbooks: false,
    });
    await pollPage(pageD2, () => document.querySelector('[data-testid="global-header"]') ? 'ok' : null, 15000);
    await openModalViaBridge(pageD2, 'quickbooks');
    await waitForModal(pageD2);
    await new Promise(r => setTimeout(r, 400));
    const stateD2 = await getModalState(pageD2);
    record(
      PROBE_LABELS[9],
      '"Connect" button',
      `action="${stateD2.actions.quickbooks}"`,
      (stateD2.actions.quickbooks || '').toLowerCase().includes('connect'),
    );
    await pageD2.__ctx.close().catch(() => {});

    // ── [CSM-E] Navbar icon click opens modal ─────────────────────────────────
    console.log('\n  [CSM-E] navbar icon click');

    const pageE = await openHomePage(browser, memberClient.cookie, {
      google: false, // icon has error state → should be visible
    });
    await pollPage(pageE, () => document.querySelector('[data-testid="global-header"]') ? 'ok' : null, 15000);
    // Wait for service icons to render.
    await pollPage(pageE, () => {
      const icons = document.querySelectorAll('[data-testid="service-status-icon"]');
      return icons.length > 0 ? 'ok' : null;
    }, 10000);

    await clickNavbarIcon(pageE, 'google');
    const visibleE = await waitForModal(pageE, 8000);

    record(PROBE_LABELS[10], 'modal visible', visibleE ? 'visible' : 'not visible', !!visibleE);

    // Check that the Google row has a distinct border color (highlighted).
    await new Promise(r => setTimeout(r, 200));
    const stateE = await getModalState(pageE);
    // The highlighted row has primary.main border; non-highlighted rows have 'divider'.
    // We verify the google row has a *different* border than quickbooks row.
    const googleBorder = stateE.rowBorderColors?.google || '';
    const qbBorder     = stateE.rowBorderColors?.quickbooks || '';
    record(
      PROBE_LABELS[11],
      'highlighted row has distinct border',
      `google="${googleBorder}" quickbooks="${qbBorder}"`,
      !!googleBorder && googleBorder !== qbBorder,
    );

    await pageE.__ctx.close().catch(() => {});

    // ── [CSM-F] Auto-open once-per-session contract ───────────────────────────
    console.log('\n  [CSM-F] auto-open once-per-session (member)');

    // Fresh page with all services initially connected. The session-storage flag
    // must be absent (fresh browser context) so the auto-open subscriber fires.
    const pageF = await openHomePage(browser, memberClient.cookie, {
      google:     true, // start connected — we'll trigger a transition below
      quickbooks: true,
      hubspot:    true,
      database:   true,
    });

    // Wait for GlobalHeader to mount and status checks to settle so the
    // auto-open subscriber has registered its callback and prevSnapshot is current.
    await pollPage(pageF, () => document.querySelector('[data-testid="global-header"]') ? 'ok' : null, 15000);
    await pageF.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 600));

    // Confirm the session flag is absent (fresh browser context).
    // Key: 'mo:connectModalShownThisSession' (localStorageKeys.ts:CONNECT_MODAL_SHOWN_KEY).
    const flagBefore = await pageF.evaluate(() =>
      sessionStorage.getItem('mo:connectModalShownThisSession'),
    );
    if (flagBefore) {
      // Flag already set — clear it so the auto-open subscriber can fire.
      await pageF.evaluate(() => sessionStorage.removeItem('mo:connectModalShownThisSession'));
    }

    // [CSM-F1] Trigger a new error transition via the window bridge.
    // notifyApiError with a 5xx error causes _fire('google','disconnected'),
    // which updates _lastKnown and calls _notifyAll() — the auto-open subscriber
    // detects the 'checking'→'error' or 'ok'→'error' transition.
    await pageF.evaluate(() => {
      window.__connectionToast && window.__connectionToast.notifyApiError('google', { status: 503 });
    });

    // The modal should auto-open within ~2 s (React re-render + state update).
    const autoOpenF1 = await waitForModal(pageF, 5000);
    record(
      PROBE_LABELS[12],
      'modal auto-opened after error transition',
      autoOpenF1 ? 'visible' : 'not visible',
      !!autoOpenF1,
    );

    // [CSM-F2] Session flag is now set; a second error transition must NOT auto-open.
    // Close the modal via JS (simulates the user dismissing it without clicking Done —
    // Done triggers onClose, which does not clear the flag).
    await pageF.evaluate(() => {
      // Press Escape to close without using the Done button.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await waitForModalClosed(pageF).catch(() => {});
    await new Promise(r => setTimeout(r, 400));

    // Re-connect google so we can trigger a genuine new error transition.
    await pageF.evaluate(() => {
      window.__connectionToast && window.__connectionToast.notifyReconnected('google');
    });
    await new Promise(r => setTimeout(r, 300));

    // Trigger a second error transition.
    await pageF.evaluate(() => {
      window.__connectionToast && window.__connectionToast.notifyApiError('google', { status: 503 });
    });

    // Wait 2s and assert the modal did NOT auto-open.
    await new Promise(r => setTimeout(r, 2000));
    const suppressedF2 = await pageF.evaluate(() => {
      const d = document.querySelector('[data-testid="connect-services-modal"]');
      return d ? d.offsetParent !== null : false;
    });
    record(
      PROBE_LABELS[13],
      'modal did NOT auto-open (session flag set)',
      suppressedF2 ? 'opened (unexpected)' : 'stayed closed',
      !suppressedF2,
    );

    // [CSM-F3] Manual openConnectModal() must still work even with the session flag.
    await pageF.evaluate(() => {
      window.__connectionToast && window.__connectionToast.openConnectModal();
    });
    const manualF3 = await waitForModal(pageF, 5000);
    record(
      PROBE_LABELS[14],
      'manual open works despite session flag',
      manualF3 ? 'visible' : 'not visible',
      !!manualF3,
    );

    await pageF.__ctx.close().catch(() => {});

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
