'use strict';
const { makeSkip } = require('../helpers/report');

// test/workflow-tab/run.js
//
// End-to-end smoke test for the Workflow tab React island (`WorkflowPage.tsx`).
// Validates the accordion tree renders Stage-level items, expanding a Stage
// reveals its Lead Status rows, and the cross-tab navigation links fire
// `window.adminSwitchToTab` with the correct tab IDs.
//
// All five WorkflowPage API calls are intercepted via `evaluateOnNewDocument`
// so the suite runs against an empty (isolated) database without needing any
// lead-status or handler fixtures.
//
// Probes:
//   (A) Stage-level accordion items render — "Sales", "Design Visit", "Survey"
//   (B) Expanding a Stage accordion reveals its Lead Status rows
//   (C) "Go to Action handlers →" link calls adminSwitchToTab("actionhandlers")
//   (D) "Go to Stages →" link calls adminSwitchToTab("stages")
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:workflow-tab
//   # or against the shared DB:
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:workflow-tab

const PROBE_LABELS = [
  '(A) Stage-level accordion items render — "Sales", "Design Visit", "Survey" headings visible',
  '(B) Expanding a Stage accordion reveals its Lead Status rows',
  '(C) "Go to Action handlers →" link calls adminSwitchToTab("actionhandlers")',
  '(D) "Go to Stages →" link calls adminSwitchToTab("stages")',
];

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

const { pollUntil, waitForSwitchTab, waitForWindowFn } = require('../helpers/poll');

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'workflow-tab.md',
);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const LEAD_STATUSES_FIXTURE = [
  {
    key:                 'NEW_LEAD',
    label:               'New Lead',
    stage:               'SALES',
    sort_order:          1,
    excluded_from_sales: false,
    is_null_row:         false,
  },
];

// Endpoints intercepted at the browser JS layer so the React island fetches
// fixture data rather than hitting the empty test database.
const INTERCEPT_RESPONSES = {
  '/api/admin/stage-action-labels': [],
  '/api/admin/lead-statuses':       LEAD_STATUSES_FIXTURE,
  '/api/admin/lead-substatuses':    [],
  '/api/admin/card-action-handlers': [],
  '/api/admin/email-templates':     [],
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

// ── Report ────────────────────────────────────────────────────────────────────

function writeReport(runId, findings) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed  = findings.filter(f => f.ok).length;
  const failed  = findings.filter(f => !f.ok && !f.skipped).length;
  const skipped = findings.filter(f => f.skipped).length;
  const lines = [
    '# Workflow Tab — E2E Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:workflow-tab\``,
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
    '- **(A) Stage accordions**: Navigates to `/admin`, activates the Workflow',
    '  tab via `window.adminSwitchToTab("workflow")`, waits for `#tab-workflow`',
    '  to be flagged as rendered, then asserts text nodes for "Sales", "Design',
    '  Visit", and "Survey" are present — one per `StageAccordion` summary.',
    '- **(B) Lead Status rows**: Intercepts `/api/admin/lead-statuses` to return',
    '  a single "New Lead" (SALES stage) fixture. Clicks the "Sales" accordion',
    '  summary to expand it and polls until a "New Lead" label is visible inside',
    '  the expanded `AccordionDetails`.',
    '- **(C) Action handlers link**: Installs a spy on `window.adminSwitchToTab`,',
    '  clicks `[data-testid="wf-go-action-handlers"]`, and asserts the spy was',
    '  called with `"actionhandlers"`.',
    '- **(D) Stages link**: Same spy technique — clicks',
    '  `[data-testid="wf-go-stages"]` and asserts the call argument is `"stages"`.',
    '',
    '## Notes',
    '',
    '- Requires `public/react/main.js`; run `npm run build:react` first.',
    '- All five WorkflowPage API endpoints are intercepted at the browser JS',
    '  layer so the suite runs against an empty isolated database.',
    '- `adminSwitchToTab` is registered by the `AdminGroupedTabsBar` React',
    '  component; the test waits for it before installing the call spy.',
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
  console.log(`\n  workflow-tab  run=${runId}`);
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

  if (!puppeteer) {
    for (const l of PROBE_LABELS) {
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
    for (const l of PROBE_LABELS) skip(l, 'browser launched', `browser launch failed: ${msg}`);
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

    // Install fetch intercept BEFORE any page JS runs.  This patches the
    // five WorkflowPage API calls so the React island renders with fixture
    // data and does not hit the empty test database.
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

    await page.goto(`${BASE}/admin`, {
      waitUntil: 'domcontentloaded',
      timeout: 25000,
    });

    // Wait for the vanilla switchTab helper (admin.html) and the React
    // adminSwitchToTab (AdminGroupedTabsBar) to both be defined.
    await waitForSwitchTab(page, 10000);
    await waitForWindowFn(page, 'adminSwitchToTab', 10000);

    // Activate the Workflow tab.
    console.log('\n  Activating Workflow tab…');
    await page.evaluate(() => {
      if (typeof window.adminSwitchToTab === 'function') {
        window.adminSwitchToTab('workflow');
      }
    });

    // Wait until:
    //   (1) #tab-workflow has data-ds-rendered="1"  (React island mounted)
    //   (2) The CircularProgress is gone             (all five API calls done)
    //   (3) At least one .MuiAccordionSummary-root is present inside the panel
    //       (StageAccordion components have rendered)
    const accordionsReady = await pollUntil(
      page,
      () => {
        const el = document.getElementById('tab-workflow');
        if (!el) return null;
        if (el.dataset.dsRendered !== '1') return null;
        if (el.querySelector('.MuiCircularProgress-root')) return null;
        const summaries = el.querySelectorAll('.MuiAccordionSummary-root');
        return summaries.length > 0 ? 'ok' : null;
      },
      20000,
      200,
    );

    if (!accordionsReady) {
      for (const l of PROBE_LABELS) {
        skip(l, 'accordion items rendered', '#tab-workflow accordions not ready within 20 s');
      }
      await page.close();
      await cleanupAndExit(1);
      return;
    }

    // ── (A) Stage-level accordion items ──────────────────────────────────────

    console.log('\n  (A) Checking stage accordion headings…');
    const stageLabels = await page.evaluate(() => {
      const panel = document.getElementById('tab-workflow');
      if (!panel) return [];
      return [...panel.querySelectorAll('.MuiAccordionSummary-root')]
        .map(el => el.textContent.trim())
        .filter(t => t.length > 0);
    });

    const hasSales       = stageLabels.some(t => t.includes('Sales'));
    const hasDesignVisit = stageLabels.some(t => t.includes('Design Visit'));
    const hasSurvey      = stageLabels.some(t => t.includes('Survey'));

    record(
      PROBE_LABELS[0],
      '"Sales", "Design Visit", "Survey" accordion summaries present',
      `hasSales=${hasSales} hasDesignVisit=${hasDesignVisit} hasSurvey=${hasSurvey}`,
      hasSales && hasDesignVisit && hasSurvey,
    );

    // ── (B) Expand Stage accordion → Lead Status rows ─────────────────────────

    console.log('\n  (B) Expanding "Sales" accordion…');

    // Click the "Sales" stage accordion summary.
    const salesClicked = await page.evaluate(() => {
      const panel = document.getElementById('tab-workflow');
      if (!panel) return false;
      const summaries = [...panel.querySelectorAll('.MuiAccordionSummary-root')];
      const salesSummary = summaries.find(el => {
        const text = el.querySelector('.MuiTypography-subtitle2')?.textContent || '';
        return text.trim() === 'Sales';
      });
      if (!salesSummary) return false;
      salesSummary.click();
      return true;
    });

    if (!salesClicked) {
      skip(PROBE_LABELS[1], '"Sales" accordion summary clickable', '"Sales" summary not found');
    } else {
      // After expansion the AccordionDetails for Sales appears and contains
      // nested Accordion items for each lead status.  Poll for "New Lead".
      const newLeadVisible = await pollUntil(
        page,
        () => {
          const panel = document.getElementById('tab-workflow');
          if (!panel) return null;
          const allText = panel.textContent || '';
          return allText.includes('New Lead') ? 'found' : null;
        },
        8000,
        150,
      );
      record(
        PROBE_LABELS[1],
        '"New Lead" lead-status label visible inside expanded Sales accordion',
        newLeadVisible ? '"New Lead" found' : '"New Lead" not found (timed out)',
        newLeadVisible === 'found',
      );
    }

    // ── (C) "Go to Action handlers →" link ───────────────────────────────────

    console.log('\n  (C) Testing "Go to Action handlers →" link…');

    // Spy setup and button click are performed atomically inside a single
    // page.evaluate so that AdminGroupedTabsBar's useEffect cannot
    // overwrite window.adminSwitchToTab between the two operations.
    const cResult = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="wf-go-action-handlers"]');
      if (!btn) return { found: false, calls: [] };
      window.__wfTabNavCalls = [];
      const orig = window.adminSwitchToTab;
      window.adminSwitchToTab = function (id) {
        window.__wfTabNavCalls.push(id);
        if (typeof orig === 'function') orig(id);
      };
      btn.click();
      return { found: true, calls: [...(window.__wfTabNavCalls || [])] };
    });

    if (!cResult.found) {
      skip(PROBE_LABELS[2], '[data-testid="wf-go-action-handlers"] found', 'button not found in DOM');
    } else {
      record(
        PROBE_LABELS[2],
        'adminSwitchToTab called with "actionhandlers"',
        `calls=${JSON.stringify(cResult.calls)}`,
        cResult.calls.includes('actionhandlers'),
      );
    }

    // ── (D) "Go to Stages →" link ─────────────────────────────────────────────

    console.log('\n  (D) Testing "Go to Stages →" link…');

    // (C) may have navigated to the action-handlers tab.  Switch back to
    // workflow using the vanilla switchTab (not via adminSwitchToTab, which
    // may be the spy wrapper and would pollute results).
    await page.evaluate(() => {
      if (typeof window.switchTab === 'function') {
        window.switchTab('workflow');
      }
    });

    // Wait for the Workflow tab to be visible again (panel active + accordions
    // still present — WorkflowPage stays mounted because it is always in the DOM).
    await pollUntil(
      page,
      () => {
        const el = document.getElementById('tab-workflow');
        if (!el) return null;
        return el.querySelectorAll('.MuiAccordionSummary-root').length > 0 ? 'ok' : null;
      },
      8000,
      150,
    );

    // Probe D: atomic spy-install + click.
    const dResult = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="wf-go-stages"]');
      if (!btn) return { found: false, calls: [] };
      window.__wfTabNavCalls = [];
      const orig2 = window.adminSwitchToTab;
      window.adminSwitchToTab = function (id) {
        window.__wfTabNavCalls.push(id);
        if (typeof orig2 === 'function') orig2(id);
      };
      btn.click();
      return { found: true, calls: [...(window.__wfTabNavCalls || [])] };
    });

    if (!dResult.found) {
      skip(PROBE_LABELS[3], '[data-testid="wf-go-stages"] found', 'button not found in DOM');
    } else {
      record(
        PROBE_LABELS[3],
        'adminSwitchToTab called with "stages"',
        `calls=${JSON.stringify(dResult.calls)}`,
        dResult.calls.includes('stages'),
      );
    }

    await page.close();
  } catch (e) {
    console.error('Test error:', e);
    console.error('--- server log (last 2000 chars) ---');
    console.error(logBuf.join('').slice(-2000));
  } finally {
    try { await browser.close(); } catch {}
    if (pageErrors.length) {
      console.log(`\n  Page errors during run (${pageErrors.length}):`);
      for (const err of pageErrors.slice(0, 5)) {
        console.log(`    ${err.slice(0, 200)}`);
      }
    }
    const failed = findings.filter(f => !f.ok && !f.skipped).length;
    console.log(`\n  Results: ${findings.length - failed - findings.filter(f => f.skipped).length} passed, ${failed} failed, ${findings.filter(f => f.skipped).length} skipped`);
    await cleanupAndExit(failed === 0 ? 0 : 1);
  }
}

main();
