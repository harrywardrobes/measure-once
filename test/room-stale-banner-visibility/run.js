'use strict';
const { makeSkip3 } = require('../helpers/report');

const PROBE_LABELS = [
  '(F1) stale response deferred until visibilitychange → visible',
  '(F2) pending clear deferred until visibility restores',
];

// test/room-stale-banner-visibility/run.js
//
// Verifies that the room-assignments stale-data banner respects tab visibility
// (the pause-while-hidden behaviour added to _loadWorkflowStagesImpl):
//
//   (F1) Hidden → stale response deferred:
//        Override document.hidden=true before page load.  Intercept
//        /api/localdata/all to return X-Cache-Status: stale.  The banner must
//        NOT appear immediately (state update is deferred).  After a synthetic
//        visibilitychange (→ visible) the banner MUST appear.
//
//   (F2) Hidden → fresh response, banner persists:
//        With the banner showing from (F1), set document.hidden=true and
//        use the window.__setTestPendingRoomStale(false) hook to simulate a
//        fresh response arriving while the tab is hidden.  The banner must
//        STILL show (the pending clear is deferred).  After a synthetic
//        visibilitychange (→ visible) the banner MUST disappear.
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:room-stale-banner-visibility
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:room-stale-banner-visibility

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

require('dotenv').config();

const { pollUntil } = require('../helpers/poll');

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'room-stale-banner-visibility.md',
);
const findings = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}
const skip = makeSkip3(findings);

// ── Puppeteer helpers ─────────────────────────────────────────────────────────

function parseCookieKV(jar) {
  if (!jar) return null;
  const idx = jar.indexOf('=');
  if (idx < 0) return null;
  return { name: jar.slice(0, idx), value: jar.slice(idx + 1) };
}

async function injectSession(page, jar, base) {
  const kv = parseCookieKV(jar);
  if (!kv) return;
  const { hostname } = new URL(base);
  await page.setCookie({
    name: kv.name, value: kv.value,
    domain: hostname, path: '/', httpOnly: true,
  });
}

// Override document.hidden / visibilityState in the page via defineProperty.
async function setDocumentHidden(page, hidden) {
  await page.evaluate((isHidden) => {
    Object.defineProperty(document, 'hidden', {
      get: () => isHidden,
      configurable: true,
    });
    Object.defineProperty(document, 'visibilityState', {
      get: () => (isHidden ? 'hidden' : 'visible'),
      configurable: true,
    });
  }, hidden);
}

// Restore document.hidden to false, dispatch visibilitychange, and wait for
// the pending state to be applied and the projects view to re-render.
async function makeTabVisible(page, waitMs = 600) {
  await setDocumentHidden(page, false);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await new Promise(r => setTimeout(r, waitMs));
}

// Returns true when #room-stale-banner is present in the DOM.
async function isBannerVisible(page) {
  return page.evaluate(() => !!document.getElementById('room-stale-banner'));
}

// Poll page.evaluate(fn) until it returns truthy or timeout elapses.
async function pollPage(page, fn, timeoutMs = 12000, intervalMs = 150) {
  return pollUntil(page, fn, timeoutMs, intervalMs);
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
  console.log(`\n  room-stale-banner-visibility  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL'}`);

  if (!puppeteer) {
    for (const l of PROBE_LABELS) {
      skip(l, 'puppeteer not installed — all probes skipped');
    }
    await writeReport(runId);
    process.exit(findings.every(f => f.ok) ? 0 : 1);
    return;
  }

  const pool = new Pool({ connectionString: connStr });

  const {
    spawnServer, waitForServer, seedUsers, cleanupTestData,
    resetRateLimitStore, login, setPool, BASE,
  } = require('../privileges/harness');
  setPool(pool);

  const { child, logBuf } = spawnServer();
  let exitCode = 1;
  let browser;

  const cleanup = async () => {
    try { child.kill('SIGTERM'); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
  };
  process.on('SIGINT',  () => cleanup().then(() => process.exit(130)));
  process.on('SIGTERM', () => cleanup().then(() => process.exit(130)));

  const { findChromium } = require('../shared/find-chromium');
  const executablePath = findChromium() || undefined;

  try {
    await waitForServer();
    await resetRateLimitStore(pool);
    await cleanupTestData(pool);
    const users = await seedUsers(pool, runId);
    console.log(`  test server up at ${BASE}\n`);

    const adminClient = await login(users.admin.email, users.admin.password);

    try {
      browser = await puppeteer.launch({
        headless:        true,
        executablePath,
        defaultViewport: { width: 1280, height: 800 },
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
    } catch (launchErr) {
      const msg = (launchErr?.message || String(launchErr)).slice(0, 200);
      for (const l of PROBE_LABELS) record(l, false, `browser launch failed: ${msg}`);
      exitCode = 1;
      return;
    }

    // ── (F1) Stale response deferred while tab hidden ─────────────────────────
    console.log('\n  [F1] Stale response while tab hidden → banner deferred');

    const page = await browser.newPage();
    await page.setCacheEnabled(false);

    // Override document.hidden BEFORE any page scripts run so that
    // _loadWorkflowStagesImpl sees document.hidden === true when the
    // /api/localdata/all response arrives.
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(document, 'hidden', {
        get: () => true,
        configurable: true,
      });
      Object.defineProperty(document, 'visibilityState', {
        get: () => 'hidden',
        configurable: true,
      });
    });

    // Capture console messages for diagnostics.
    page.on('console', msg => {
      const t = msg.text();
      if (t.startsWith('[diag') || t.startsWith('[test')) {
        console.log(`    [browser] ${t}`);
      }
    });

    // Stub /api/localdata/all → stale.  Stub /api/open-leads → empty results.
    await page.setRequestInterception(true);
    page.on('request', req => {
      const url = req.url();
      if (url.includes('/api/localdata/all')) {
        return req.respond({
          status:      200,
          contentType: 'application/json',
          headers:     { 'X-Cache-Status': 'stale' },
          body:        JSON.stringify({}),
        });
      }
      if (url.includes('/api/open-leads')) {
        return req.respond({
          status:      200,
          contentType: 'application/json',
          body:        JSON.stringify({ results: [], total: 0 }),
        });
      }
      req.continue();
    });

    await injectSession(page, adminClient.cookie, BASE);
    await page.goto(`${BASE}/projects`, { waitUntil: 'domcontentloaded', timeout: 25000 });

    // Wait for the React ProjectsPage fetch to start (skeleton appears) but
    // NOT for loading to finish — when document.hidden=true the stale update
    // is deferred, and we want to verify the banner is absent *before* the
    // tab becomes visible.  Waiting for the skeleton to appear is sufficient:
    // the skeleton renders as soon as the React island mounts (before the
    // fetch resolves), so once it's present we know the page script has run
    // and the fetch has been issued.  We then give it a brief extra wait so
    // the Promise.all has time to complete and store the pending stale value.
    await pollPage(page, () => {
      const v = document.getElementById('projects-view');
      return v && v.innerHTML.trim().length > 0 ? 'ok' : null;
    }, 15000);
    // Allow the in-flight fetch to complete and store pendingRoomStaleRef.
    await new Promise(r => setTimeout(r, 1500));

    const f1HiddenConfirm = await page.evaluate(() => document.hidden);
    record('F1 document.hidden override active during load', f1HiddenConfirm === true,
      `document.hidden=${f1HiddenConfirm}`);

    // Banner must NOT be visible — update was deferred.
    const f1BannerBeforeVisible = await isBannerVisible(page);
    record('F1 stale banner absent while tab is hidden', !f1BannerBeforeVisible,
      `bannerPresent=${f1BannerBeforeVisible}`);

    // Verify pending state was stored.
    const f1PendingSet = await page.evaluate(() => {
      return typeof window.__setTestPendingRoomStale === 'function';
    });
    record('F1 __setTestPendingRoomStale hook available', f1PendingSet,
      `hookAvailable=${f1PendingSet}`);

    // Simulate the tab becoming visible.
    await makeTabVisible(page, 700);

    const f1BannerAfterVisible = await isBannerVisible(page);
    record('F1 stale banner appears after visibilitychange → visible', f1BannerAfterVisible,
      `bannerPresent=${f1BannerAfterVisible}`);

    if (f1BannerAfterVisible) {
      const f1Text = await page.evaluate(() => {
        const el = document.getElementById('room-stale-banner');
        return el ? el.textContent.trim() : '';
      });
      const f1TextOk = f1Text.includes('Room data may be out of date');
      record('F1 banner contains expected text', f1TextOk,
        `text="${f1Text.slice(0, 80)}"`);
    }

    // ── (F2) Fresh response while hidden → pending clear deferred ─────────────
    // With the banner now showing (from F1), simulate a tab-hidden state and a
    // fresh response arriving.  Use the test hook to set the pending ref to
    // false directly (simulating the fetch callback path) without triggering a
    // full re-fetch that would reset contactsStale in the effect.
    console.log('\n  [F2] Fresh response while tab hidden → pending clear deferred');

    const f2Pre = await isBannerVisible(page);
    record('F2 precondition: stale banner is showing (from F1)', f2Pre,
      `bannerPresent=${f2Pre}`);

    await setDocumentHidden(page, true);
    const f2HiddenConfirm = await page.evaluate(() => document.hidden);
    record('F2 document.hidden override active', f2HiddenConfirm === true,
      `document.hidden=${f2HiddenConfirm}`);

    // Use the test hook to simulate a fresh response arriving while hidden.
    const hookUsed = await page.evaluate(() => {
      if (typeof window.__setTestPendingRoomStale !== 'function') return false;
      window.__setTestPendingRoomStale(false);
      return true;
    });
    record('F2 test hook sets pendingRoomStale=false while hidden', hookUsed,
      `hookUsed=${hookUsed}`);

    // Wait a tick — the pending false must NOT have been applied yet.
    await new Promise(r => setTimeout(r, 300));

    const f2BannerStillShowing = await isBannerVisible(page);
    record('F2 stale banner persists while tab is hidden (pending clear deferred)',
      f2BannerStillShowing, `bannerPresent=${f2BannerStillShowing}`);

    // Simulate the tab becoming visible — pending false is applied.
    await makeTabVisible(page, 700);

    const f2BannerGone = await isBannerVisible(page);
    record('F2 stale banner disappears after visibilitychange → visible',
      !f2BannerGone, `bannerPresent=${f2BannerGone}`);

    await page.close();

    const failed = findings.filter(f => !f.ok && !f.skipped).length;
    const skipped = findings.filter(f => f.skipped).length;
    exitCode = failed === 0 ? 0 : 1;
    console.log(`\n  Results: ${findings.length - failed} passed, ${failed} failed`);

  } catch (e) {
    console.error('Test crashed:', e);
    console.error('--- server log (last 3000 chars) ---');
    console.error((logBuf || []).join('').slice(-3000));
  } finally {
    if (browser) await browser.close().catch(() => {});
    await writeReport(runId);
    await cleanup();
    process.exit(exitCode);
  }
}

async function writeReport(runId) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc    = s => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok && !f.skipped).length;
  const lines = [
    '# Room Stale-Banner Visibility — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:room-stale-banner-visibility\``,
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
    ...findings.map(f =>
      `| ${f.ok ? 'PASS' : f.skipped ? 'SKIP' : 'FAIL'} | ${esc(f.id)} | ${esc(f.detail)} |`,
    ),
    '',
    '## Coverage',
    '',
    '- **(F1) Stale response while hidden**: overrides `document.hidden` to',
    '  `true` via `evaluateOnNewDocument` before page load, uses Puppeteer',
    '  request interception to return `X-Cache-Status: stale` for',
    '  `/api/localdata/all`.  Confirms `#room-stale-banner` is absent after',
    '  bootstrap (state update deferred), then synthesises a `visibilitychange`',
    '  event (→ visible) and confirms the banner appears.',
    '- **(F2) Fresh response while hidden — pending clear deferred**: with the',
    '  banner showing from (F1), overrides `document.hidden` to `true`.  Uses',
    '  the `__setTestPendingRoomStale(false)` hook (exposed by',
    '  `WorkflowDataContext.tsx`) to set `_pendingRoomAssignmentsStale = false`',
    '  directly, simulating a fresh response arriving while the tab is hidden.',
    '  Confirms the banner still shows (the deferred false has not been',
    '  applied yet), then synthesises a `visibilitychange` event (→ visible)',
    '  and confirms the banner disappears.',
    '',
    '## Relevant files',
    '',
    '- `src/react/context/WorkflowDataContext.tsx` — `_loadWorkflowStagesImpl` reads the',
    '  `X-Cache-Status` header; defers `state.roomAssignmentsStale` update',
    '  when `document.hidden` is true.  The `visibilitychange` listener applies',
    '  any pending update and calls `_renderRoomAssignmentsStaleBanner()`.',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
}

main();
