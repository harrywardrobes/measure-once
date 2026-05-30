'use strict';
const { makeSkip } = require('../helpers/report');
// test/admin-tab-skeletons/permissions-requests-auditlog.js
//
// End-to-end test that confirms the Suspense fallback skeletons for the
// Permissions, Requests, and Audit Log admin tabs appear while their lazy JS
// chunks are loading, then are replaced by real content once the chunks arrive.
//
// Strategy: Puppeteer request interception holds the three lazy JS chunks
// (AdminPermissionsPage-*.js, AdminRequestsPage-*.js, AdminAuditLogPage-*.js)
// while React is in the middle of loading them.  Activating each tab triggers
// a React.lazy() fetch that the interceptor holds open.  The Suspense fallback
// skeleton (AdminPermissionsPageSkeleton / AdminRequestsPageSkeleton /
// AdminAuditLogPageSkeleton) renders inside the panel with a 200 ms
// useVisible() delay — still long before the chunk is released.  The test
// waits for the skeleton to appear, then releases all held chunks and asserts
// that the skeleton disappears and the real component's static DOM is present.
//
// Mount lifecycle (from main.tsx):
//   - Tab panels are only mounted into React when their tab is first activated
//     (the `tab-panel` + not `.active` skip in mountKnown).
//   - Activating a tab calls switchTab() → adds .active → __reactIslandMount()
//     → React triggers React.lazy() → browser requests the chunk → interceptor
//     holds the request → Suspense fallback (skeleton) renders → after 200 ms
//     useVisible() flips → skeleton becomes visible in the DOM.
//
// Two skeleton layers exist for admin tab pages:
//   1. Suspense fallback — shown while the lazy JS chunk loads.  This is what
//      this suite tests; these skeletons (AdminPermissionsPageSkeleton etc.)
//      are shape-matched and persist for as long as the chunk is held.
//   2. In-component data skeleton — shown while the component's load() fetch
//      is in-flight; this is covered by test:admin-tab-skeletons (run.js).
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:admin-tab-skeletons-suspense
//   # or against the shared DB:
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:admin-tab-skeletons-suspense

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

// ── Helpers ──────────────────────────────────────────────────────────────────

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

/**
 * Poll until `fn` (run inside the page) returns a truthy value, or timeout.
 * Returns the truthy result or null on timeout.
 */
async function pollPage(page, fn, arg, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await page.evaluate(fn, arg);
    if (result) return result;
    await new Promise(r => setTimeout(r, 120));
  }
  return null;
}

/**
 * Poll until the panel has `.MuiSkeleton-root` elements inside it.
 * Panels can be display:none when inactive; we check DOM presence, not visibility.
 */
async function waitForSkeletonInPanel(page, panelId, timeoutMs = 6000) {
  return pollPage(page, (pid) => {
    const el = document.getElementById(pid);
    return !!el && el.querySelectorAll('[data-testid="loading-skeleton"]').length > 0;
  }, panelId, timeoutMs);
}

/**
 * Return the number of `.MuiSkeleton-root` elements inside a panel right now.
 */
async function skeletonCount(page, panelId) {
  return page.evaluate((pid) => {
    const el = document.getElementById(pid);
    return el ? el.querySelectorAll('[data-testid="loading-skeleton"]').length : -1;
  }, panelId);
}

/**
 * Poll until the panel has NO `.MuiSkeleton-root` elements, indicating that
 * the Suspense fallback has been replaced by the real component.
 */
async function waitForSkeletonGone(page, panelId, timeoutMs = 10000) {
  return pollPage(page, (pid) => {
    const el = document.getElementById(pid);
    if (!el) return false;
    return el.querySelectorAll('[data-testid="loading-skeleton"]').length === 0;
  }, panelId, timeoutMs);
}

/**
 * Poll until a CSS selector resolves anywhere in the DOM.
 */
async function waitForSelector(page, selector, timeoutMs = 8000) {
  return pollPage(page, (sel) => !!document.querySelector(sel), selector, timeoutMs);
}

// ── Chunk URL patterns to hold ────────────────────────────────────────────────
//
// Each pattern matches the lazy JS chunk for one page component.  The hash
// suffix differs per build so we match by the stable component-name prefix
// (the chunkFileNames config is `chunks/[name]-[hash].js`).
const HELD_CHUNK_PATTERNS = [
  '/react/chunks/AdminPermissionsPage-',
  '/react/chunks/AdminRequestsPage-',
  '/react/chunks/AdminAuditLogPage-',
];

function shouldHoldChunk(url) {
  return HELD_CHUNK_PATTERNS.some(p => url.includes(p));
}

// ── Main ─────────────────────────────────────────────────────────────────────

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
  console.log(`\n  admin-tab-skeletons-suspense  run=${runId}`);
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
    findings.push({ name, expected, observed, ok, skipped: false, detail });
    const mark = ok ? '  ✓' : '  ✗';
    console.log(`${mark}  ${name}`);
    if (!ok) {
      console.log(`     expected : ${expected}`);
      console.log(`     observed : ${observed}`);
      if (detail) console.log(`     detail   : ${detail}`);
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
    record(
      'puppeteer available',
      'require("puppeteer") resolves',
      'module not installed',
      false,
      'Install puppeteer (npm i -D puppeteer) and rerun.',
    );
    await writeReport(runId, findings);
    await cleanupAndExit(1);
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
    skip('headless chromium launches', 'browser.launch() succeeds', `error: ${e.message}`);
    await writeReport(runId, findings);
    await cleanupAndExit(1);
    return;
  }

  const adminClient = await login(users.admin.email, PASSWORD);

  try {
    const page = await browser.newPage();
    await page.setCacheEnabled(false);

    const pageErrors = [];
    const IGNORE_RE = /(favicon\.ico|\/storybook\/|\.map\b|Failed to load resource)/;
    page.on('pageerror', (err) => { pageErrors.push(String(err)); });
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (IGNORE_RE.test(text)) return;
      pageErrors.push(`console.error: ${text}`);
    });

    // Enable request interception BEFORE navigating.  Lazy chunk requests for
    // the three page components are held until we have asserted each skeleton,
    // keeping the Suspense fallback visible for the full assertion window.
    await page.setRequestInterception(true);

    const heldChunkRequests = [];
    let holdingActive = true;

    const requestListener = (req) => {
      const url = req.url();
      if (holdingActive && shouldHoldChunk(url)) {
        heldChunkRequests.push(req);
      } else {
        try { req.continue(); } catch {}
      }
    };
    page.on('request', requestListener);

    await injectSession(page, adminClient.cookie);

    // Load admin.html — inactive tab panels are NOT mounted by React yet.
    // Only the initially-active "team" panel mounts on page load.
    await page.goto(`${BASE}/admin`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });

    // Give the React bundle a tick to evaluate and mount the initial (team) tab.
    await new Promise(r => setTimeout(r, 800));

    // ── Phase 1: skeleton visibility while chunks are intercepted ─────────
    //
    // Each `switchTab()` call triggers a first-time React mount for that panel.
    // React.lazy() fires the dynamic import, the browser requests the chunk,
    // the interceptor holds the request, and the Suspense fallback skeleton
    // renders.  The skeleton's useVisible() hook delays its own visibility by
    // 200 ms — we wait up to 6 s, comfortably longer.
    console.log('\n  Phase 1 — skeleton visibility while chunks are intercepted');

    // ── Permissions tab ───────────────────────────────────────────────────
    console.log('\n  [permissions]');

    await page.evaluate(() => {
      if (typeof window.switchTab === 'function') window.switchTab('permissions');
    });

    const permSkeletonFound = await waitForSkeletonInPanel(page, 'tab-permissions', 6000);
    const permSkeletonCount = await skeletonCount(page, 'tab-permissions');
    record(
      '[skel] AdminPermissionsPageSkeleton shows .MuiSkeleton-root while chunk is pending',
      'at least one .MuiSkeleton-root inside #tab-permissions',
      `found=${!!permSkeletonFound} count=${permSkeletonCount}`,
      !!permSkeletonFound && permSkeletonCount > 0,
    );

    // ── Requests tab ──────────────────────────────────────────────────────
    console.log('\n  [requests]');

    await page.evaluate(() => {
      if (typeof window.switchTab === 'function') window.switchTab('requests');
    });

    const reqSkeletonFound = await waitForSkeletonInPanel(page, 'tab-requests', 6000);
    const reqSkeletonCount = await skeletonCount(page, 'tab-requests');
    record(
      '[skel] AdminRequestsPageSkeleton shows .MuiSkeleton-root while chunk is pending',
      'at least one .MuiSkeleton-root inside #tab-requests',
      `found=${!!reqSkeletonFound} count=${reqSkeletonCount}`,
      !!reqSkeletonFound && reqSkeletonCount > 0,
    );

    // ── Audit Log tab ─────────────────────────────────────────────────────
    console.log('\n  [auditlog]');

    await page.evaluate(() => {
      if (typeof window.switchTab === 'function') window.switchTab('auditlog');
    });

    const auditSkeletonFound = await waitForSkeletonInPanel(page, 'tab-auditlog', 6000);
    const auditSkeletonCount = await skeletonCount(page, 'tab-auditlog');
    record(
      '[skel] AdminAuditLogPageSkeleton shows .MuiSkeleton-root while chunk is pending',
      'at least one .MuiSkeleton-root inside #tab-auditlog',
      `found=${!!auditSkeletonFound} count=${auditSkeletonCount}`,
      !!auditSkeletonFound && auditSkeletonCount > 0,
    );

    // ── Phase 2: release held chunks, assert real content appears ─────────
    //
    // Once the chunks are released, React resolves the lazy() promises and
    // replaces the Suspense fallback skeletons with the real page components.
    // The components immediately begin data fetches and render their in-component
    // loading skeletons (layer 2), which will themselves resolve; for this
    // test we only assert that the Suspense fallback skeleton is gone and a
    // stable static DOM anchor is present — not that all data has loaded.
    console.log('\n  Phase 2 — real content after chunks are released');

    holdingActive = false;
    for (const req of heldChunkRequests) {
      try { req.continue(); } catch {}
    }
    heldChunkRequests.length = 0;

    page.off('request', requestListener);
    await page.setRequestInterception(false);

    // ── Permissions real content ──────────────────────────────────────────
    //
    // AdminPermissionsPage renders <Box id="roles-list"> in both the loading
    // and loaded states.  Its presence confirms the chunk resolved and the
    // component mounted; the Suspense skeleton is therefore gone.
    const permSkeletonGone = await waitForSkeletonGone(page, 'tab-permissions', 10000);
    record(
      '[content] AdminPermissionsPageSkeleton replaced by real AdminPermissionsPage content',
      'no .MuiSkeleton-root in #tab-permissions after chunk resolves',
      `skeletonGone=${!!permSkeletonGone}`,
      !!permSkeletonGone,
    );

    const rolesListPresent = await waitForSelector(page, '#roles-list', 8000);
    record(
      '[content] AdminPermissionsPage renders #roles-list after chunk loads',
      '#roles-list element present in DOM',
      `present=${!!rolesListPresent}`,
      !!rolesListPresent,
    );

    // ── Requests real content ─────────────────────────────────────────────
    //
    // AdminRequestsPage renders <Stack id="requests-content"> in both the
    // loading and loaded states (loading wraps a single Skeleton; loaded wraps
    // the full section stack).  Its presence confirms the chunk resolved.
    const reqSkeletonGone = await waitForSkeletonGone(page, 'tab-requests', 10000);
    record(
      '[content] AdminRequestsPageSkeleton replaced by real AdminRequestsPage content',
      'no .MuiSkeleton-root in #tab-requests after chunk resolves',
      `skeletonGone=${!!reqSkeletonGone}`,
      !!reqSkeletonGone,
    );

    const requestsContentPresent = await waitForSelector(page, '#requests-content', 8000);
    record(
      '[content] AdminRequestsPage renders #requests-content after chunk loads',
      '#requests-content element present in DOM',
      `present=${!!requestsContentPresent}`,
      !!requestsContentPresent,
    );

    // ── Audit Log real content ────────────────────────────────────────────
    //
    // AdminAuditLogPage renders <Box id="audit-feed"> in both loading and
    // loaded states.  Its presence confirms the chunk resolved and the
    // component mounted.
    const auditSkeletonGone = await waitForSkeletonGone(page, 'tab-auditlog', 10000);
    record(
      '[content] AdminAuditLogPageSkeleton replaced by real AdminAuditLogPage content',
      'no .MuiSkeleton-root in #tab-auditlog after chunk resolves',
      `skeletonGone=${!!auditSkeletonGone}`,
      !!auditSkeletonGone,
    );

    const auditFeedPresent = await waitForSelector(page, '#audit-feed', 8000);
    record(
      '[content] AdminAuditLogPage renders #audit-feed after chunk loads',
      '#audit-feed element present in DOM',
      `present=${!!auditFeedPresent}`,
      !!auditFeedPresent,
    );

    record(
      'no uncaught page errors during skeleton → content transition',
      '0 pageerror / console.error events',
      `count=${pageErrors.length}${pageErrors.length ? ' first=' + JSON.stringify(pageErrors[0]).slice(0, 200) : ''}`,
      pageErrors.length === 0,
    );

    await page.close();
  } finally {
    await browser.close().catch(() => {});
  }

  const pass    = findings.filter(f => f.ok).length;
  const skipped = findings.filter(f => f.skipped).length;
  const fail    = findings.filter(f => !f.ok && !f.skipped).length;
  console.log(`\n  Results: ${pass} passed, ${skipped} skipped, ${fail} failed`);

  await writeReport(runId, findings);
  await cleanupAndExit(fail > 0 ? 1 : 0);
}

async function writeReport(runId, findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Admin Tab Skeletons — Suspense Fallbacks (Permissions, Requests, Audit Log) — Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:admin-tab-skeletons-suspense\``,
    '',
    '## Summary',
    '',
    `- Passed: ${findings.filter(f => f.ok).length} / ${findings.length}`,
    `- Skipped: ${findings.filter(f => f.skipped).length} / ${findings.length}`,
    `- Failed: ${findings.filter(f => !f.ok && !f.skipped).length} / ${findings.length}`,
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
    '- **(Permissions — skeleton)** Activates `#tab-permissions` via `switchTab` while',
    '  `/react/chunks/AdminPermissionsPage-*.js` is intercepted and held.  The Suspense',
    '  fallback `AdminPermissionsPageSkeleton` renders inside the panel with its',
    '  200 ms `useVisible()` delay.  Asserts `.MuiSkeleton-root` elements appear',
    '  before the chunk response arrives.',
    '- **(Permissions — content)** Releases held chunk; waits for all',
    '  `.MuiSkeleton-root` to disappear from `#tab-permissions` and for `#roles-list`',
    '  (rendered by `AdminPermissionsPage` in both loading and loaded states) to',
    '  be present.',
    '- **(Requests — skeleton)** Same pattern, activating `#tab-requests` and holding',
    '  `/react/chunks/AdminRequestsPage-*.js`.',
    '- **(Requests — content)** Waits for skeleton to clear and `#requests-content`',
    '  (rendered in both loading and loaded states) to be present.',
    '- **(Audit Log — skeleton)** Activates `#tab-auditlog` while',
    '  `/react/chunks/AdminAuditLogPage-*.js` is held.',
    '- **(Audit Log — content)** Waits for skeleton to clear and `#audit-feed`',
    '  (rendered in both loading and loaded states) to be present.',
    '- **(runtime errors)** Asserts no `pageerror` or `console.error` events during',
    '  the skeleton → content transition.',
    '',
    '## Notes',
    '',
    '- Requires `public/react/main.js`; run `npm run build:react` first.',
    '- This suite tests layer 1: the Suspense fallback skeleton shown while the lazy',
    '  JS chunk is downloading.  Layer 2 (in-component data skeletons for these same',
    '  three tabs) is covered by `test:admin-tab-skeletons` (run.js).',
    '- The `useVisible()` hook inside each skeleton delays skeleton DOM insertion by',
    '  200 ms; the test polls for up to 6 s, well beyond that window.',
    '- Chunk filenames follow `chunks/[name]-[hash].js` (Vite `chunkFileNames`',
    '  config); matching is done on the stable `[name]-` prefix so the test does',
    '  not need updating when the content hash changes.',
    '- After releasing the chunks, the components immediately begin their own data',
    '  fetches (layer 2).  We assert only that the Suspense fallback is gone and a',
    '  stable DOM anchor is present — not that all data has loaded — since the data',
    '  layer is already covered by test:admin-tab-skeletons.',
  ];
  const outPath = path.join(dir, 'admin-tab-skeletons-suspense.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Report: test-results/admin-tab-skeletons-suspense.md`);
}

main();
