'use strict';
// test/admin-tab-skeletons/run.js
//
// End-to-end test that confirms the Permissions, Requests, and Audit Log admin
// tabs each show a skeleton while their data fetches, then replace it with real
// content once the API responds.
//
// Strategy: Puppeteer request interception holds the relevant API endpoints
// open while React components are mounted by activating each tab.  The test
// asserts that `.MuiSkeleton-root` elements appear in each panel before the
// requests resolve, then releases the requests and confirms the skeletons are
// gone and real content is present.
//
// Mount lifecycle (from main.tsx):
//   - Tab panels are only mounted into React when their tab is first activated
//     (the `tab-panel` + not `.active` skip in mountKnown).
//   - Activating a tab calls switchTab() → adds .active → __reactIslandMount()
//     → React mounts the component with loading:true → in-component skeleton
//     renders → component fires load() → fetch calls hit the intercepted URLs.
//
// Two skeleton layers exist for these tabs:
//   1. Suspense fallback (AdminPermissionsPageSkeleton etc.) — shown while the
//      lazy JS chunk loads; fires immediately on mount but disappears in < 200 ms.
//   2. In-component data skeleton — shown while the component's load() fetch
//      is in-flight; persists while requests are held.
// This suite targets layer 2 (data skeletons), the most stable surface to test.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:admin-tab-skeletons
//   # or against the shared DB:
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:admin-tab-skeletons

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
async function waitForSkeletonInPanel(page, panelId, timeoutMs = 5000) {
  return pollPage(page, (pid) => {
    const el = document.getElementById(pid);
    return !!el && el.querySelectorAll('.MuiSkeleton-root').length > 0;
  }, panelId, timeoutMs);
}

/**
 * Return the number of `.MuiSkeleton-root` elements inside a panel right now.
 */
async function skeletonCount(page, panelId) {
  return page.evaluate((pid) => {
    const el = document.getElementById(pid);
    return el ? el.querySelectorAll('.MuiSkeleton-root').length : -1;
  }, panelId);
}

/**
 * Poll until the panel has NO `.MuiSkeleton-root` elements, indicating that
 * the data skeleton has been replaced by real content.
 */
async function waitForSkeletonGone(page, panelId, timeoutMs = 8000) {
  return pollPage(page, (pid) => {
    const el = document.getElementById(pid);
    if (!el) return false;
    return el.querySelectorAll('.MuiSkeleton-root').length === 0;
  }, panelId, timeoutMs);
}

/**
 * Poll until a CSS selector resolves anywhere in the DOM.
 */
async function waitForSelector(page, selector, timeoutMs = 6000) {
  return pollPage(page, (sel) => !!document.querySelector(sel), selector, timeoutMs);
}

// ── API endpoint patterns to hold ────────────────────────────────────────────
//
// Each component fires these on mount.  Holding them keeps the component in
// `loading: true` so the data skeleton stays visible for inspection.
//
// job-roles is shared between Permissions and Requests pages; holding it keeps
// both in the loading state until we are ready to release.
const HELD_PATTERNS = [
  '/api/admin/job-roles',
  '/api/admin/capabilities',
  '/api/admin/requests',
  '/api/admin/photo-requests',
  '/api/admin/trades/submissions',
  '/api/admin/users',
  '/api/admin/allowed',
  '/api/admin/audit-log-unified',
];

function shouldHold(url) {
  return HELD_PATTERNS.some(p => url.includes(p));
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
  console.log(`\n  admin-tab-skeletons  run=${runId}`);
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
    record('headless chromium launches', 'browser.launch() succeeds', `error: ${e.message}`, false);
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

    // Enable request interception BEFORE navigating.  All relevant admin API
    // calls are held until we explicitly release them after asserting the
    // skeletons, so every component stays in `loading: true` throughout the
    // skeleton-assertion phase.
    await page.setRequestInterception(true);

    const heldRequests = [];
    let holdingActive = true;

    const requestListener = (req) => {
      const url = req.url();
      if (holdingActive && shouldHold(url)) {
        heldRequests.push(req);
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

    // ── Permissions tab ───────────────────────────────────────────────────
    //
    // Activating the tab triggers:
    //   switchTab('permissions') → adds .active to #tab-permissions
    //   → __reactIslandMount() → mountKnown() mounts AdminPermissionsPage
    //   → component renders with loading:true → in-component skeleton renders
    //   → useEffect fires → load() → fetch calls held by interceptor
    console.log('\n  Phase 1 — skeleton visibility while API is intercepted');
    console.log('\n  [permissions]');

    await page.evaluate(() => {
      if (typeof window.switchTab === 'function') window.switchTab('permissions');
    });

    // Wait for React to mount and render the initial loading state.
    const permSkeletonFound = await waitForSkeletonInPanel(page, 'tab-permissions', 5000);
    const permSkeletonCount = await skeletonCount(page, 'tab-permissions');
    record(
      '[skel] AdminPermissionsPage shows .MuiSkeleton-root while data is pending',
      'at least one .MuiSkeleton-root inside #tab-permissions',
      `found=${!!permSkeletonFound} count=${permSkeletonCount}`,
      !!permSkeletonFound && permSkeletonCount > 0,
    );

    // ── Requests tab ──────────────────────────────────────────────────────
    console.log('\n  [requests]');

    await page.evaluate(() => {
      if (typeof window.switchTab === 'function') window.switchTab('requests');
    });

    const reqSkeletonFound = await waitForSkeletonInPanel(page, 'tab-requests', 5000);
    const reqSkeletonCount = await skeletonCount(page, 'tab-requests');
    record(
      '[skel] AdminRequestsPage shows .MuiSkeleton-root while data is pending',
      'at least one .MuiSkeleton-root inside #tab-requests',
      `found=${!!reqSkeletonFound} count=${reqSkeletonCount}`,
      !!reqSkeletonFound && reqSkeletonCount > 0,
    );

    // ── Audit Log tab ─────────────────────────────────────────────────────
    console.log('\n  [auditlog]');

    await page.evaluate(() => {
      if (typeof window.switchTab === 'function') window.switchTab('auditlog');
    });

    const auditSkeletonFound = await waitForSkeletonInPanel(page, 'tab-auditlog', 5000);
    const auditSkeletonCount = await skeletonCount(page, 'tab-auditlog');
    record(
      '[skel] AdminAuditLogPage shows .MuiSkeleton-root while data is pending',
      'at least one .MuiSkeleton-root inside #tab-auditlog',
      `found=${!!auditSkeletonFound} count=${auditSkeletonCount}`,
      !!auditSkeletonFound && auditSkeletonCount > 0,
    );

    // ── Phase 2: release held requests, assert real content appears ───────
    console.log('\n  Phase 2 — real content after API responses are released');

    holdingActive = false;
    for (const req of heldRequests) {
      try { req.continue(); } catch {}
    }
    heldRequests.length = 0;

    page.off('request', requestListener);
    await page.setRequestInterception(false);

    // ── Permissions real content ─────────────────────────────────────────
    //
    // AdminPermissionsPage renders <Box id="roles-list"> in both the loading
    // and loaded states (the Skeleton is inside it while loading).  After
    // loading, the skeleton disappears and either role rows or an empty-state
    // message are rendered.  Checking skeleton-gone + #roles-list present
    // together confirms a successful data load.
    const permSkeletonGone = await waitForSkeletonGone(page, 'tab-permissions', 8000);
    record(
      '[content] AdminPermissionsPage skeleton replaced by real content',
      'no .MuiSkeleton-root in #tab-permissions after API resolves',
      `skeletonGone=${!!permSkeletonGone}`,
      !!permSkeletonGone,
    );

    const rolesListPresent = await waitForSelector(page, '#roles-list', 5000);
    record(
      '[content] AdminPermissionsPage renders #roles-list after load',
      '#roles-list element present in DOM',
      `present=${!!rolesListPresent}`,
      !!rolesListPresent,
    );

    // ── Requests real content ────────────────────────────────────────────
    //
    // AdminRequestsPage renders <Stack id="requests-content"> in both states
    // (loading wraps a single Skeleton; loaded wraps the full section stack).
    const reqSkeletonGone = await waitForSkeletonGone(page, 'tab-requests', 8000);
    record(
      '[content] AdminRequestsPage skeleton replaced by real content',
      'no .MuiSkeleton-root in #tab-requests after API resolves',
      `skeletonGone=${!!reqSkeletonGone}`,
      !!reqSkeletonGone,
    );

    const requestsContentPresent = await waitForSelector(page, '#requests-content', 5000);
    record(
      '[content] AdminRequestsPage renders #requests-content after load',
      '#requests-content element present in DOM',
      `present=${!!requestsContentPresent}`,
      !!requestsContentPresent,
    );

    // ── Audit log real content ───────────────────────────────────────────
    //
    // AdminAuditLogPage renders <Box id="audit-feed"> in both states (loading
    // shows a Skeleton; loaded shows entries or an empty-state message).
    const auditSkeletonGone = await waitForSkeletonGone(page, 'tab-auditlog', 8000);
    record(
      '[content] AdminAuditLogPage skeleton replaced by real content',
      'no .MuiSkeleton-root in #tab-auditlog after API resolves',
      `skeletonGone=${!!auditSkeletonGone}`,
      !!auditSkeletonGone,
    );

    const auditFeedPresent = await waitForSelector(page, '#audit-feed', 5000);
    record(
      '[content] AdminAuditLogPage renders #audit-feed after load',
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

  const pass = findings.filter(f => f.ok).length;
  const fail = findings.filter(f => !f.ok).length;
  console.log(`\n  Results: ${pass} passed, ${fail} failed`);

  await writeReport(runId, findings);
  await cleanupAndExit(fail > 0 ? 1 : 0);
}

async function writeReport(runId, findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Admin Tab Skeletons — Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:admin-tab-skeletons\``,
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
    '- **(Permissions — skeleton)** Activates `#tab-permissions` via `switchTab`',
    '  (triggering the first React mount of `AdminPermissionsPage`) while',
    '  `/api/admin/job-roles` and `/api/admin/capabilities` are intercepted',
    '  and held.  Asserts that `.MuiSkeleton-root` elements appear in the panel',
    '  before any API response arrives.',
    '- **(Permissions — content)** Releases held requests; waits for all',
    '  `.MuiSkeleton-root` to disappear from `#tab-permissions` and for the',
    '  `#roles-list` element (rendered by the component in both empty and',
    '  populated states) to be present.',
    '- **(Requests — skeleton)** Same pattern, activating `#tab-requests` and',
    '  holding `/api/admin/requests`, `/api/admin/photo-requests`,',
    '  `/api/admin/trades/submissions`, `/api/admin/users`, and',
    '  `/api/admin/allowed`.',
    '- **(Requests — content)** Waits for skeleton to clear and',
    '  `#requests-content` to remain present (the element is rendered in both',
    '  loading and loaded states, so its persistence confirms a clean',
    '  skeleton-to-content transition).',
    '- **(Audit log — skeleton)** Activates `#tab-auditlog` while',
    '  `/api/admin/audit-log-unified` is held.',
    '- **(Audit log — content)** Waits for skeleton to clear and `#audit-feed`',
    '  to be present.',
    '- **(runtime errors)** Asserts no `pageerror` or `console.error` events',
    '  during the skeleton → content transition.',
    '',
    '## Notes',
    '',
    '- Requires `public/react/main.js`; run `npm run build:react` first.',
    '- Tab panels in admin.html are only mounted into React when first activated',
    '  (main.tsx skips panels with class `tab-panel` that lack `.active`).',
    '  Each `switchTab()` call in this test triggers a first-time React mount,',
    '  which is the moment the in-component data skeleton first appears.',
    '- Tests the in-component data skeleton (the `loading` state in each page',
    '  component), not the Suspense fallback skeletons which flash < 200 ms.',
    '- All API responses are held across all three tab activations so each',
    '  component stays in `loading: true` throughout the skeleton-assertion phase.',
  ];
  const outPath = path.join(dir, 'admin-tab-skeletons.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Report: test-results/admin-tab-skeletons.md`);
}

main();
