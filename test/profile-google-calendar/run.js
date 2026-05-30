'use strict';

const PROBE_LABELS = [
  '[GC-A] disconnected state: "Not connected" chip visible, connect button visible',
  '[GC-B] connected state: "Connected" chip visible, disconnect button visible',
  '[GC-C] clicking Disconnect calls POST /auth/logout-google and transitions to disconnected',
];

// test/profile-google-calendar/run.js
//
// End-to-end test for the GoogleCalendarCard on /profile (task #1171).
// Boots a disposable test server, drives the profile page with Puppeteer,
// intercepts /api/google/status and /auth/logout-google via evaluateOnNewDocument,
// and asserts the correct UI states.
//
// Probes:
//   [GC-A] Disconnected state: status returns { connected: false }
//          → "Not connected" chip is visible
//          → "Connect Google Calendar" button is visible
//          → "Disconnect" button is absent
//   [GC-B] Connected state: status returns { connected: true }
//          → "Connected" chip is visible
//          → "Disconnect" button is visible
//          → "Connect Google Calendar" button is absent
//   [GC-C] Clicking Disconnect calls POST /auth/logout-google, UI updates to
//          disconnected state ("Not connected" chip, "Connect Google Calendar"
//          button appear; "Disconnect" button disappears)
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:profile-google-calendar
//   PRIVTEST_ALLOW_SHARED_DB=1      npm run test:profile-google-calendar

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
  __dirname, '..', '..', 'test-results', 'profile-google-calendar.md',
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

async function pollPage(page, fn, timeoutMs = 15000, intervalMs = 150) {
  return pollUntil(page, fn, timeoutMs, intervalMs);
}

// Open /profile with fetch interception for /api/google/status.
// googleStatusResp: the JSON to return for that endpoint.
// logoutResp: the JSON to return for POST /auth/logout-google (optional,
//   defaults to { success: true }).
async function openProfile(browser, jar, googleStatusResp, logoutResp) {
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

  const statusJson  = JSON.stringify(googleStatusResp);
  const logoutJson  = JSON.stringify(logoutResp || { success: true });

  // Intercept the Google status and logout endpoints at the JS engine level so
  // the test never touches real Google OAuth credentials.
  await page.evaluateOnNewDocument((sJson, lJson) => {
    const originalFetch = window.fetch;
    window.__gcLogoutCalled = 0;

    window.fetch = function(input, init) {
      const url      = typeof input === 'string' ? input : (input && input.url) || '';
      const rawPath  = url.startsWith('http') ? new URL(url).pathname : url.split('?')[0];
      const method   = (init && init.method || 'GET').toUpperCase();

      if (rawPath === '/api/google/status') {
        return Promise.resolve(new Response(sJson, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (rawPath === '/auth/logout-google' && method === 'POST') {
        window.__gcLogoutCalled++;
        return Promise.resolve(new Response(lJson, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return originalFetch.call(this, input, init);
    };
  }, statusJson, logoutJson);

  await injectSession(page, jar);
  await page.goto(`${BASE}/profile`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  page.__logs = pageLogs;
  return page;
}

// Wait until the ProfilePage React island has fully mounted (Sign out button
// is a reliable anchor because it is always rendered by AccountActionsCard).
async function waitForProfileMounted(page) {
  return pollPage(page, () => {
    const pv = document.getElementById('profile-view');
    if (!pv || !pv.firstElementChild) return null;
    const allBtns = Array.from(document.querySelectorAll('button'));
    const signOutBtn = allBtns.find(b => /sign out/i.test(b.textContent || ''));
    return signOutBtn ? 'ok' : null;
  }, 25000);
}

// Wait for the GoogleCalendarCard to resolve its loading state (chip appears).
async function waitForGoogleCardLoaded(page) {
  return pollPage(page, () => {
    const pv = document.getElementById('profile-view');
    if (!pv) return null;
    const chips = Array.from(pv.querySelectorAll('.MuiChip-root'));
    const gcChip = chips.find(c => {
      const t = (c.textContent || '').trim();
      return t === 'Connected' || t === 'Not connected';
    });
    return gcChip ? gcChip.textContent.trim() : null;
  }, 15000);
}

// Get a snapshot of the GoogleCalendarCard UI state.
async function getGoogleCardState(page) {
  return page.evaluate(() => {
    const pv = document.getElementById('profile-view');
    if (!pv) return { found: false };

    // Locate the Google Calendar card by its overline heading.
    const cards = Array.from(pv.querySelectorAll('.MuiCard-root'));
    let gcCard = null;
    for (const card of cards) {
      const overlines = Array.from(card.querySelectorAll('[class*="MuiTypography-overline"]'));
      if (overlines.some(el => /google calendar/i.test((el.textContent || '').trim()))) {
        gcCard = card;
        break;
      }
    }
    if (!gcCard) return { found: false };

    const cardText = gcCard.textContent || '';
    const chips    = Array.from(gcCard.querySelectorAll('.MuiChip-root'));
    const chipText = chips.map(c => (c.textContent || '').trim());

    const btns     = Array.from(gcCard.querySelectorAll('button'));
    const btnText  = btns.map(b => (b.textContent || '').trim());

    // "Connect Google Calendar" is rendered as an <a> (MUI Button href)
    const links    = Array.from(gcCard.querySelectorAll('a'));
    const linkText = links.map(l => (l.textContent || '').trim());

    return {
      found:            true,
      chipText,
      btnText,
      linkText,
      hasConnectedChip:    chipText.includes('Connected'),
      hasNotConnectedChip: chipText.includes('Not connected'),
      hasDisconnectBtn:    btns.some(b => /disconnect/i.test(b.textContent || '')),
      hasConnectLink:      links.some(l => /connect google calendar/i.test(l.textContent || '')),
      cardText,
    };
  });
}

// ── report ─────────────────────────────────────────────────────────────────────

async function writeReport(runId) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok).length;
  const lines = [
    '# Profile — Google Calendar Card — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:profile-google-calendar\``,
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
    '- **[GC-A] Disconnected**: `/api/google/status` intercepted to return',
    '  `{ connected: false }`. Card must show "Not connected" chip and',
    '  "Connect Google Calendar" button; "Disconnect" button must be absent.',
    '- **[GC-B] Connected**: `/api/google/status` intercepted to return',
    '  `{ connected: true }`. Card must show "Connected" chip and "Disconnect"',
    '  button; "Connect Google Calendar" button must be absent.',
    '- **[GC-C] Disconnect flow**: clicking the "Disconnect" button triggers',
    '  `POST /auth/logout-google` (intercepted) and the card UI updates to the',
    '  disconnected state without a page reload.',
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
  console.log(`\n  profile-google-calendar  run=${runId}`);
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

  const UI_LABELS = [
    '[GC-A] GoogleCalendarCard found in #profile-view when disconnected',
    '[GC-A] "Not connected" chip visible when connected=false',
    '[GC-A] "Connect Google Calendar" button visible when connected=false',
    '[GC-A] "Disconnect" button absent when connected=false',
    '[GC-B] GoogleCalendarCard found in #profile-view when connected',
    '[GC-B] "Connected" chip visible when connected=true',
    '[GC-B] "Disconnect" button visible when connected=true',
    '[GC-B] "Connect Google Calendar" button absent when connected=true',
    '[GC-C] Clicking Disconnect calls POST /auth/logout-google',
    '[GC-C] UI updates to "Not connected" chip after disconnect',
    '[GC-C] "Connect Google Calendar" button appears after disconnect',
    '[GC-C] "Disconnect" button disappears after disconnect',
  ];

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

  // Login as a member user (Google Calendar card is not privilege-gated).
  const memberClient = await login(users.member.email, users.member.password);

  try {
    // ── [GC-A] connected=false ────────────────────────────────────────────────
    console.log('\n  [GC-A] connected=false');
    const pageA = await openProfile(browser, memberClient.cookie, { connected: false });

    const mountedA = await waitForProfileMounted(pageA);
    if (!mountedA) {
      console.warn('  ⚠ ProfilePage did not mount in time for [GC-A]');
      console.warn('  Server log (last 1000 chars):', logBuf.join('').slice(-1000));
    }

    const chipA = await waitForGoogleCardLoaded(pageA);
    const stateA = await getGoogleCardState(pageA);

    record(UI_LABELS[0], 'card found', stateA.found ? 'found' : 'not found', stateA.found);
    record(
      UI_LABELS[1],
      '"Not connected" chip present',
      stateA.hasNotConnectedChip ? 'found' : `chips=${JSON.stringify(stateA.chipText)}`,
      stateA.hasNotConnectedChip,
    );
    record(
      UI_LABELS[2],
      '"Connect Google Calendar" link/button present',
      stateA.hasConnectLink ? 'found' : `links=${JSON.stringify(stateA.linkText)} btns=${JSON.stringify(stateA.btnText)}`,
      stateA.hasConnectLink,
    );
    record(
      UI_LABELS[3],
      '"Disconnect" button absent',
      stateA.hasDisconnectBtn ? 'present (unexpected)' : 'absent',
      !stateA.hasDisconnectBtn,
    );

    await pageA.__ctx.close().catch(() => {});

    // ── [GC-B] connected=true ─────────────────────────────────────────────────
    console.log('\n  [GC-B] connected=true');
    const pageB = await openProfile(browser, memberClient.cookie, { connected: true });

    const mountedB = await waitForProfileMounted(pageB);
    if (!mountedB) {
      console.warn('  ⚠ ProfilePage did not mount in time for [GC-B]');
    }

    await waitForGoogleCardLoaded(pageB);
    const stateB = await getGoogleCardState(pageB);

    record(UI_LABELS[4], 'card found', stateB.found ? 'found' : 'not found', stateB.found);
    record(
      UI_LABELS[5],
      '"Connected" chip present',
      stateB.hasConnectedChip ? 'found' : `chips=${JSON.stringify(stateB.chipText)}`,
      stateB.hasConnectedChip,
    );
    record(
      UI_LABELS[6],
      '"Disconnect" button present',
      stateB.hasDisconnectBtn ? 'found' : `btns=${JSON.stringify(stateB.btnText)}`,
      stateB.hasDisconnectBtn,
    );
    record(
      UI_LABELS[7],
      '"Connect Google Calendar" button absent',
      stateB.hasConnectLink ? 'present (unexpected)' : 'absent',
      !stateB.hasConnectLink,
    );

    // ── [GC-C] Disconnect button click ────────────────────────────────────────
    console.log('\n  [GC-C] Disconnect flow');

    // Click the Disconnect button (still on pageB, which is connected=true).
    const clicked = await pageB.evaluate(() => {
      const pv = document.getElementById('profile-view');
      if (!pv) return false;
      const btns = Array.from(pv.querySelectorAll('button'));
      const btn  = btns.find(b => /disconnect/i.test(b.textContent || ''));
      if (!btn) return false;
      btn.click();
      return true;
    });

    if (!clicked) {
      console.warn('  ⚠ Disconnect button not found to click');
    }

    // Wait for the card to show "Not connected" after the logout call settles.
    const chipAfter = await pollPage(pageB, () => {
      const pv = document.getElementById('profile-view');
      if (!pv) return null;
      const chips = Array.from(pv.querySelectorAll('.MuiChip-root'));
      const chip  = chips.find(c => (c.textContent || '').trim() === 'Not connected');
      return chip ? 'found' : null;
    }, 8000);

    // Check how many times the intercepted logout endpoint was called.
    const logoutCallCount = await pageB.evaluate(() => window.__gcLogoutCalled || 0);

    record(
      UI_LABELS[8],
      'POST /auth/logout-google called at least once',
      `called ${logoutCallCount} time(s)`,
      logoutCallCount >= 1,
    );

    const stateC = await getGoogleCardState(pageB);

    record(
      UI_LABELS[9],
      '"Not connected" chip visible after disconnect',
      chipAfter ? 'found' : `chips=${JSON.stringify(stateC.chipText)}`,
      !!chipAfter,
    );
    record(
      UI_LABELS[10],
      '"Connect Google Calendar" link appears after disconnect',
      stateC.hasConnectLink ? 'found' : `links=${JSON.stringify(stateC.linkText)}`,
      stateC.hasConnectLink,
    );
    record(
      UI_LABELS[11],
      '"Disconnect" button disappears after disconnect',
      stateC.hasDisconnectBtn ? 'still present (unexpected)' : 'absent',
      !stateC.hasDisconnectBtn,
    );

    await pageB.__ctx.close().catch(() => {});

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
