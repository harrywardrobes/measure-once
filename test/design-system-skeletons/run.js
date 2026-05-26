'use strict';
// test/design-system-skeletons/run.js
//
// End-to-end test that confirms ProfilePageSkeleton, AdminTeamPageSkeleton,
// AdminSettingsPageSkeleton, CardActionsPageSkeleton, and
// ActionHandlersPageSkeleton are rendered in the design system gallery
// (DesignSystemPage → Skeletons tab) when the page is opened as an admin.
//
// All five skeletons are rendered with `forceVisible` in DesignSystemPage, so
// they appear immediately without any network interaction.  No request
// interception is needed.
//
// Strategy:
//   1. Boot the server with the privileges harness.
//   2. Log in as admin and navigate to /admin.
//   3. Activate the #tab-designsystem panel via switchTab('designsystem').
//   4. Wait for DesignSystemPage to mount (Suspense chunk loads).
//   5. Click the MUI "Skeletons" tab within the design-system page.
//   6. Assert that the ComponentShowcase entries for ProfilePageSkeleton and
//      AdminTeamPageSkeleton each contain at least one .MuiSkeleton-root.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:design-system-skeletons
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:design-system-skeletons

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
 * Poll until a CSS selector resolves anywhere in the DOM.
 */
async function waitForSelector(page, selector, timeoutMs = 6000) {
  return pollPage(page, (sel) => !!document.querySelector(sel), selector, timeoutMs);
}

/**
 * Return the number of .MuiSkeleton-root elements inside a ComponentShowcase
 * whose h3 heading text exactly matches `componentName`.
 *
 * ComponentShowcase renders:
 *   <Paper variant="outlined">
 *     <Box>
 *       <Typography variant="h6" component="h3">{name}</Typography>
 *       …
 *     </Box>
 *     <Box> {demo} </Box>  ← skeletons live here
 *   </Paper>
 */
async function skeletonCountForComponent(page, componentName) {
  return page.evaluate((name) => {
    // Find the h3 whose text matches the component name.
    const headings = Array.from(document.querySelectorAll('h3'));
    const heading = headings.find((h) => h.textContent.trim() === name);
    if (!heading) return -1;

    // Walk up to the Paper wrapper (first <section> or element with
    // role="presentation", or just the closest parent Paper).  The
    // ComponentShowcase root is a Paper with variant="outlined"; in the DOM
    // this is a <div class="MuiPaper-root …">.  We look for the closest
    // ancestor that contains "MuiPaper-root".
    let el = heading.parentElement;
    while (el && !el.classList.contains('MuiPaper-root')) {
      el = el.parentElement;
    }
    if (!el) return -1;

    return el.querySelectorAll('.MuiSkeleton-root').length;
  }, componentName);
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
  console.log(`\n  design-system-skeletons  run=${runId}`);
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

    await injectSession(page, adminClient.cookie);

    // Navigate to /admin — the designsystem tab panel is inactive on load.
    await page.goto(`${BASE}/admin`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });

    // Give the React bundle a tick to evaluate and mount the initial (team) tab.
    await new Promise(r => setTimeout(r, 800));

    // ── Activate the Design System tab ────────────────────────────────────
    console.log('\n  Activating #tab-designsystem …');

    await page.evaluate(() => {
      if (typeof window.switchTab === 'function') window.switchTab('designsystem');
    });

    // Wait for DesignSystemPage React component to appear in the panel.
    // The panel contains MUI Tabs once the lazy chunk has loaded.
    const designSystemPanelReady = await pollPage(page, () => {
      const panel = document.getElementById('tab-designsystem');
      return !!panel && panel.querySelectorAll('.MuiTabs-root').length > 0;
    }, null, 10000);

    record(
      'DesignSystemPage mounts inside #tab-designsystem',
      '.MuiTabs-root present inside #tab-designsystem',
      `found=${!!designSystemPanelReady}`,
      !!designSystemPanelReady,
    );

    if (!designSystemPanelReady) {
      // No point continuing if the page didn't mount.
      await writeReport(runId, findings);
      await browser.close().catch(() => {});
      await cleanupAndExit(1);
      return;
    }

    // ── Click the "Skeletons" tab ─────────────────────────────────────────
    console.log('  Clicking "Skeletons" tab …');

    // Find and click the MUI Tab button whose text includes "Skeletons".
    // The tab is inside #tab-designsystem to avoid colliding with the outer
    // admin tab bar.  MUI Tab buttons may contain extra child spans (ripple,
    // icon wrapper) so we use includes() rather than an exact text match.
    const skeletonsTabClicked = await page.evaluate(() => {
      const panel = document.getElementById('tab-designsystem');
      if (!panel) return false;
      const tabs = Array.from(panel.querySelectorAll('[role="tab"]'));
      const skeletonsTab = tabs.find((t) => {
        const text = (t.innerText || t.textContent || '').trim();
        return text === 'Skeletons' || text.startsWith('Skeletons');
      });
      if (!skeletonsTab) return false;
      skeletonsTab.click();
      return true;
    });

    record(
      '"Skeletons" tab found and clicked in DesignSystemPage',
      'tab button with text "Skeletons" exists inside #tab-designsystem',
      `clicked=${skeletonsTabClicked}`,
      !!skeletonsTabClicked,
    );

    if (!skeletonsTabClicked) {
      await writeReport(runId, findings);
      await browser.close().catch(() => {});
      await cleanupAndExit(1);
      return;
    }

    // Wait for skeleton content to appear — forceVisible renders immediately.
    // We poll for any .MuiSkeleton-root inside the panel.
    const anySkeletonAppeared = await pollPage(page, () => {
      const panel = document.getElementById('tab-designsystem');
      return !!panel && panel.querySelectorAll('.MuiSkeleton-root').length > 0;
    }, null, 6000);

    record(
      '.MuiSkeleton-root elements appear in #tab-designsystem after tab click',
      'at least one .MuiSkeleton-root visible',
      `found=${!!anySkeletonAppeared}`,
      !!anySkeletonAppeared,
    );

    // ── ProfilePageSkeleton ───────────────────────────────────────────────
    console.log('\n  [ProfilePageSkeleton]');

    const profileCount = await skeletonCountForComponent(page, 'ProfilePageSkeleton');
    record(
      'ProfilePageSkeleton ComponentShowcase contains .MuiSkeleton-root elements',
      'count > 0 inside the ProfilePageSkeleton Paper wrapper',
      `count=${profileCount}`,
      profileCount > 0,
    );

    // ── AdminTeamPageSkeleton ─────────────────────────────────────────────
    console.log('\n  [AdminTeamPageSkeleton]');

    const adminTeamCount = await skeletonCountForComponent(page, 'AdminTeamPageSkeleton');
    record(
      'AdminTeamPageSkeleton ComponentShowcase contains .MuiSkeleton-root elements',
      'count > 0 inside the AdminTeamPageSkeleton Paper wrapper',
      `count=${adminTeamCount}`,
      adminTeamCount > 0,
    );

    // ── AdminSettingsPageSkeleton ─────────────────────────────────────────
    console.log('\n  [AdminSettingsPageSkeleton]');

    const adminSettingsCount = await skeletonCountForComponent(page, 'AdminSettingsPageSkeleton');
    record(
      'AdminSettingsPageSkeleton ComponentShowcase contains .MuiSkeleton-root elements',
      'count > 0 inside the AdminSettingsPageSkeleton Paper wrapper',
      `count=${adminSettingsCount}`,
      adminSettingsCount > 0,
    );

    // ── CardActionsPageSkeleton ───────────────────────────────────────────
    console.log('\n  [CardActionsPageSkeleton]');

    const cardActionsCount = await skeletonCountForComponent(page, 'CardActionsPageSkeleton');
    record(
      'CardActionsPageSkeleton ComponentShowcase contains .MuiSkeleton-root elements',
      'count > 0 inside the CardActionsPageSkeleton Paper wrapper',
      `count=${cardActionsCount}`,
      cardActionsCount > 0,
    );

    // ── ActionHandlersPageSkeleton ────────────────────────────────────────
    console.log('\n  [ActionHandlersPageSkeleton]');

    const actionHandlersCount = await skeletonCountForComponent(page, 'ActionHandlersPageSkeleton');
    record(
      'ActionHandlersPageSkeleton ComponentShowcase contains .MuiSkeleton-root elements',
      'count > 0 inside the ActionHandlersPageSkeleton Paper wrapper',
      `count=${actionHandlersCount}`,
      actionHandlersCount > 0,
    );

    // ── Page errors ───────────────────────────────────────────────────────
    record(
      'no uncaught page errors during design-system skeleton rendering',
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
    '# Design System Skeletons — Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:design-system-skeletons\``,
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
    '- **(mount)** Activates `#tab-designsystem` via `switchTab` and waits for',
    '  `.MuiTabs-root` to appear inside the panel, confirming the lazy',
    '  `DesignSystemPage` chunk has loaded and rendered.',
    '- **(tab click)** Finds the MUI Tab button with text "Skeletons" inside the',
    '  design-system panel (distinct from the outer admin tab bar) and clicks it.',
    '- **(ProfilePageSkeleton)** Locates the `<h3>ProfilePageSkeleton</h3>`',
    '  heading rendered by `ComponentShowcase`, walks up to the nearest',
    '  `.MuiPaper-root` ancestor, and asserts that `.MuiSkeleton-root` elements',
    '  are present inside it.  The skeleton renders immediately because',
    '  `DesignSystemPage` passes `forceVisible` to the component.',
    '- **(AdminTeamPageSkeleton)** Same pattern for `AdminTeamPageSkeleton`.',
    '- **(AdminSettingsPageSkeleton)** Same pattern for `AdminSettingsPageSkeleton`.',
    '- **(CardActionsPageSkeleton)** Same pattern for `CardActionsPageSkeleton`.',
    '- **(ActionHandlersPageSkeleton)** Same pattern for `ActionHandlersPageSkeleton`.',
    '- **(runtime errors)** Asserts no `pageerror` or `console.error` events',
    '  during the design-system skeleton rendering.',
    '',
    '## Notes',
    '',
    '- Requires `public/react/main.js`; run `npm run build:react` first.',
    '- No request interception is needed because all skeletons use `forceVisible`',
    '  and render without any API calls.',
    '- The test targets the design-system gallery showcase, not the real',
    '  page-load Suspense skeletons.',
  ];
  const outPath = path.join(dir, 'design-system-skeletons.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Report: test-results/design-system-skeletons.md`);
}

main();
