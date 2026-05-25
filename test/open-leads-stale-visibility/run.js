'use strict';
// test/open-leads-stale-visibility/run.js
//
// Verifies that the open-leads stale badge respects tab visibility
// (the pause-while-hidden behaviour added to _loadOpenLeadsImpl):
//
//   (F1) Hidden → stale response deferred:
//        Override document.hidden=true before page load.  Intercept
//        /api/open-leads to return X-Cache-Status: stale.  The badge must
//        NOT appear immediately (state update is deferred).  After a synthetic
//        visibilitychange (→ visible) the badge MUST appear.
//
//   (F2) Hidden → fresh response, badge persists:
//        With the badge showing from (F1), set document.hidden=true and
//        use the window.__setTestPendingOpenLeadsStale(false) hook to simulate
//        a fresh response arriving while the tab is hidden.  The badge must
//        STILL show (the pending clear is deferred).  After a synthetic
//        visibilitychange (→ visible) the badge MUST disappear.
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:open-leads-stale-visibility
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:open-leads-stale-visibility

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

require('dotenv').config();

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'open-leads-stale-visibility.md',
);
const findings = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}

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
// the pending state to be applied and the workflow view to re-render.
async function makeTabVisible(page, waitMs = 600) {
  await setDocumentHidden(page, false);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await new Promise(r => setTimeout(r, waitMs));
}

// Returns true when the .ls-stale-hint badge is present in the DOM.
async function isBadgeVisible(page) {
  return page.evaluate(() => !!document.querySelector('.ls-stale-hint'));
}

// Poll page.evaluate(fn) until it returns truthy or timeout elapses.
async function pollPage(page, fn, timeoutMs = 12000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let got = null;
    try { got = await page.evaluate(fn); } catch {}
    if (got) return got;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
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
  console.log(`\n  open-leads-stale-visibility  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL'}`);

  if (!puppeteer) {
    record('puppeteer available', false, 'puppeteer not installed — all probes skipped');
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

    browser = await puppeteer.launch({
      headless:        true,
      executablePath,
      defaultViewport: { width: 1280, height: 800 },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    record('headless chromium launches', true, 'browser started');

    // ── (F1) Stale response deferred while tab hidden ─────────────────────────
    console.log('\n  [F1] Stale response while tab hidden → badge deferred');

    const page = await browser.newPage();
    await page.setCacheEnabled(false);

    // Override document.hidden BEFORE any page scripts run so that
    // _loadOpenLeadsImpl sees document.hidden === true when the
    // /api/open-leads response arrives.
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

    // Stub /api/open-leads → stale.  Stub /api/localdata/all → empty.
    await page.setRequestInterception(true);
    page.on('request', req => {
      const url = req.url();
      if (url.includes('/api/open-leads')) {
        return req.respond({
          status:      200,
          contentType: 'application/json',
          headers:     { 'X-Cache-Status': 'stale' },
          body:        JSON.stringify({ results: [], total: 0 }),
        });
      }
      if (url.includes('/api/localdata/all')) {
        return req.respond({
          status:      200,
          contentType: 'application/json',
          body:        JSON.stringify({}),
        });
      }
      req.continue();
    });

    await injectSession(page, adminClient.cookie, BASE);
    await page.goto(`${BASE}/projects`, { waitUntil: 'domcontentloaded', timeout: 25000 });

    // Wait for bootstrap to complete: #projects-view receives content once
    // renderProjectsView() / renderWorkflowStages() has run.
    await pollPage(page, () => {
      const v = document.getElementById('projects-view');
      return v && v.innerHTML.trim().length > 0 ? 'ok' : null;
    }, 15000);

    const f1HiddenConfirm = await page.evaluate(() => document.hidden);
    record('F1 document.hidden override active during load', f1HiddenConfirm === true,
      `document.hidden=${f1HiddenConfirm}`);

    // Badge must NOT be visible — update was deferred.
    const f1BadgeBeforeVisible = await isBadgeVisible(page);
    record('F1 stale badge absent while tab is hidden', !f1BadgeBeforeVisible,
      `badgePresent=${f1BadgeBeforeVisible}`);

    // Verify the test hook is available.
    const f1HookPresent = await page.evaluate(() => {
      return typeof window.__setTestPendingOpenLeadsStale === 'function';
    });
    record('F1 __setTestPendingOpenLeadsStale hook available', f1HookPresent,
      `hookAvailable=${f1HookPresent}`);

    // Simulate the tab becoming visible.
    await makeTabVisible(page, 700);

    const f1BadgeAfterVisible = await isBadgeVisible(page);
    record('F1 stale badge appears after visibilitychange → visible', f1BadgeAfterVisible,
      `badgePresent=${f1BadgeAfterVisible}`);

    // ── (F2) Fresh response while hidden → pending clear deferred ─────────────
    // With the badge now showing (from F1), simulate a tab-hidden state and a
    // fresh response arriving.  Use the test hook to set the pending ref to
    // false directly (simulating the fetch callback path) without triggering a
    // full re-fetch.
    console.log('\n  [F2] Fresh response while tab hidden → pending clear deferred');

    const f2Pre = await isBadgeVisible(page);
    record('F2 precondition: stale badge is showing (from F1)', f2Pre,
      `badgePresent=${f2Pre}`);

    await setDocumentHidden(page, true);
    const f2HiddenConfirm = await page.evaluate(() => document.hidden);
    record('F2 document.hidden override active', f2HiddenConfirm === true,
      `document.hidden=${f2HiddenConfirm}`);

    // Use the test hook to simulate a fresh response arriving while hidden.
    const hookUsed = await page.evaluate(() => {
      if (typeof window.__setTestPendingOpenLeadsStale !== 'function') return false;
      window.__setTestPendingOpenLeadsStale(false);
      return true;
    });
    record('F2 test hook sets pendingOpenLeadsStale=false while hidden', hookUsed,
      `hookUsed=${hookUsed}`);

    // Wait a tick — the pending false must NOT have been applied yet.
    await new Promise(r => setTimeout(r, 300));

    const f2BadgeStillShowing = await isBadgeVisible(page);
    record('F2 stale badge persists while tab is hidden (pending clear deferred)',
      f2BadgeStillShowing, `badgePresent=${f2BadgeStillShowing}`);

    // Simulate the tab becoming visible — pending false is applied.
    await makeTabVisible(page, 700);

    const f2BadgeGone = await isBadgeVisible(page);
    record('F2 stale badge disappears after visibilitychange → visible',
      !f2BadgeGone, `badgePresent=${f2BadgeGone}`);

    await page.close();

    const failed = findings.filter(f => !f.ok).length;
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
  const esc    = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok).length;
  const lines = [
    '# Open-Leads Stale-Badge Visibility — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:open-leads-stale-visibility\``,
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
      `| ${f.ok ? 'PASS' : 'FAIL'} | ${esc(f.id)} | ${esc(f.detail)} |`,
    ),
    '',
    '## Coverage',
    '',
    '- **(F1) Stale response while hidden**: overrides `document.hidden` to',
    '  `true` via `evaluateOnNewDocument` before page load, uses Puppeteer',
    '  request interception to return `X-Cache-Status: stale` for',
    '  `/api/open-leads`.  Confirms `.ls-stale-hint` is absent after',
    '  bootstrap (state update deferred), then synthesises a `visibilitychange`',
    '  event (→ visible) and confirms the badge appears.',
    '- **(F2) Fresh response while hidden — pending clear deferred**: with the',
    '  badge showing from (F1), overrides `document.hidden` to `true`.  Uses',
    '  the `__setTestPendingOpenLeadsStale(false)` hook (exposed by',
    '  `workflow-core.js`) to set `_pendingOpenLeadsStale = false`',
    '  directly, simulating a fresh response arriving while the tab is hidden.',
    '  Confirms the badge still shows (the deferred false has not been',
    '  applied yet), then synthesises a `visibilitychange` event (→ visible)',
    '  and confirms the badge disappears.',
    '',
    '## Relevant files',
    '',
    '- `public/workflow-core.js` — `_loadOpenLeadsImpl` reads the',
    '  `X-Cache-Status` header; defers `state.openLeadsStale` update',
    '  when `document.hidden` is true.  The `visibilitychange` listener applies',
    '  any pending update and calls `renderWorkflowStages()`.',
    '- `public/workflow.js` — `renderWorkflowStages` checks',
    '  `state.openLeadsStale` and inlines the `.ls-stale-hint` badge HTML.',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
}

main();
