'use strict';
const { makeSkip3 } = require('../helpers/report');
// test/stage-scoped-pills/run.js
//
// Verifies that the stage-scoped lead-status and substatus pill filtering
// on the Customers page updates correctly when switching stage tabs.
//
// All /api/* calls are intercepted at the browser level so the test does not
// need a live HubSpot connection.  The Express server is still used for auth
// and serving the HTML/JS bundle.
//
// Probes
// ──────
// [A] Stage tabs appear once the workflow API responds.
//     All, Sales, and Design Visit tabs are present in the ToggleButtonGroup.
//
// [B] Clicking a stage tab fires a request to
//     /api/contacts-lead-status-counts?stage=<key>.
//
// [C] After switching to the Sales tab, only pills with non-zero stage-scoped
//     counts are visible (NEW and DORMANT with count 0 are hidden).
//
// [D] When a lead status is clicked with an active stage filter,
//     /api/contacts-substatus-counts is called with both leadStatus and stage
//     query params.
//
// [E] Only substatuses with count > 0 appear in the substatus chip row
//     (WARM with count 0 is hidden; HOT with count 3 is visible).
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:stage-scoped-pills
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:stage-scoped-pills

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

require('dotenv').config();

const { pollUntil } = require('../helpers/poll');

const {
  spawnServer,
  waitForServer,
  seedUsers,
  cleanupTestData,
  resetRateLimitStore,
  login,
  setPool,
  BASE,
  PASSWORD,
} = require('../privileges/harness');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'stage-scoped-pills.md',
);

// ── Mock data ─────────────────────────────────────────────────────────────────

const MOCK_LEAD_STATUSES = [
  { key: 'OPEN_DEAL',  label: 'Open Deal',  excluded_from_sales: false, sort_order: 1 },
  { key: 'NEW',        label: 'New',         excluded_from_sales: false, sort_order: 2 },
  { key: 'DORMANT',    label: 'Dormant',     excluded_from_sales: false, sort_order: 3 },
];

// Counts used when no stage filter is active (all contacts).
const MOCK_COUNTS_GLOBAL = { OPEN_DEAL: 5, NEW: 3, DORMANT: 2 };

// Counts when stage=sales is active: only OPEN_DEAL has contacts.
const MOCK_COUNTS_SALES = { OPEN_DEAL: 5, NEW: 0, DORMANT: 0 };

// Counts when stage=designvisit is active: only NEW has contacts.
const MOCK_COUNTS_DESIGNVISIT = { OPEN_DEAL: 0, NEW: 3, DORMANT: 0 };

// Substatuses for OPEN_DEAL.
const MOCK_SUBSTATUSES = [
  { status_key: 'OPEN_DEAL', substatus_key: 'HOT',  label: 'Hot',  sort_order: 1 },
  { status_key: 'OPEN_DEAL', substatus_key: 'WARM', label: 'Warm', sort_order: 2 },
];

// Substatus counts when stage=sales + leadStatus=OPEN_DEAL: HOT has 3, WARM has 0.
// Key format is `${leadStatus.toUpperCase()}__${substatus_key.toUpperCase()}`.
const MOCK_SUBSTATUS_COUNTS_SALES = { OPEN_DEAL__HOT: 3, OPEN_DEAL__WARM: 0 };

// Workflow definition exposing Sales and Design Visit stage tabs.
const MOCK_WORKFLOW = {
  stages: {
    sales:       { label: 'Sales' },
    designvisit: { label: 'Design Visit' },
  },
};

// Minimal contacts-all response (we only need the pill logic, not card content).
const MOCK_CONTACTS_ALL = { results: [], total: 0, totalPages: 1, page: 1 };

// ── Puppeteer helpers ─────────────────────────────────────────────────────────

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
  await page.setCookie({ name: kv.name, value: kv.value, domain: hostname, path: '/', httpOnly: true });
}

async function pollPage(page, fn, arg, timeoutMs = 15000, intervalMs = 150) {
  return pollUntil(page, fn, timeoutMs, intervalMs, arg !== undefined && arg !== null ? [arg] : []);
}

async function newPage(browser, jar) {
  const ctx = await (browser.createBrowserContext
    ? browser.createBrowserContext()
    : browser.createIncognitoBrowserContext());
  const page = await ctx.newPage();
  page.__ctx = ctx;
  await page.setCacheEnabled(false);
  const logs = [];
  page.on('console',   m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
  await injectSession(page, jar);
  page.__logs = logs;
  return page;
}

async function closePage(p) {
  try { await p.close(); } catch {}
  try { await p.__ctx?.close(); } catch {}
}

/**
 * Set up browser-level request interception that returns mock data for all
 * HubSpot-backed /api/* endpoints.  Auth endpoints (auth/user, login, etc.)
 * and static assets are allowed through to the real server.
 *
 * Returns an object whose properties are updated in real time:
 *   { countsCalls: string[], substatusCalls: string[] }
 */
async function setupInterception(page) {
  const tracked = { countsCalls: [], substatusCalls: [] };

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();

    const respond = (obj) => req.respond({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(obj),
    });

    // ── /api/workflow ─────────────────────────────────────────────────────
    if (url.includes('/api/workflow') && !url.includes('/api/workflow/')) {
      return respond(MOCK_WORKFLOW);
    }

    // ── /api/lead-substatuses ─────────────────────────────────────────────
    // Must be checked before /api/lead-statuses to avoid substring match.
    if (url.includes('/api/lead-substatuses')) {
      return respond(MOCK_SUBSTATUSES);
    }

    // ── /api/lead-statuses ────────────────────────────────────────────────
    if (url.includes('/api/lead-statuses')) {
      return respond(MOCK_LEAD_STATUSES);
    }

    // ── /api/contacts-substatus-counts ────────────────────────────────────
    if (url.includes('/api/contacts-substatus-counts')) {
      tracked.substatusCalls.push(url);
      return respond(MOCK_SUBSTATUS_COUNTS_SALES);
    }

    // ── /api/contacts-lead-status-counts ─────────────────────────────────
    if (url.includes('/api/contacts-lead-status-counts')) {
      tracked.countsCalls.push(url);
      const u = new URL(url);
      const stage = u.searchParams.get('stage') || '';
      if (stage === 'sales')       return respond(MOCK_COUNTS_SALES);
      if (stage === 'designvisit') return respond(MOCK_COUNTS_DESIGNVISIT);
      return respond(MOCK_COUNTS_GLOBAL);
    }

    // ── /api/contacts-all ─────────────────────────────────────────────────
    if (url.includes('/api/contacts-all')) {
      return respond(MOCK_CONTACTS_ALL);
    }

    // ── /api/localdata/all ────────────────────────────────────────────────
    if (url.includes('/api/localdata/all')) {
      return respond({});
    }

    // ── /api/page-filter-config ───────────────────────────────────────────
    if (url.includes('/api/page-filter-config')) {
      return respond({});
    }

    // ── /api/contacts/urgency (POST) ──────────────────────────────────────
    if (url.includes('/api/contacts/urgency')) {
      return respond({ urgency: {} });
    }

    // Let auth, static assets, and everything else through.
    req.continue();
  });

  return tracked;
}

/**
 * Return all visible MUI chip labels in the lead-status chip row.
 * The FilterChipRow renders chips as .MuiChip-root with .MuiChip-label spans.
 * We exclude the "All statuses" chip which is always present.
 */
async function getLeadStatusChipLabels(page) {
  return page.evaluate(() => {
    // The lead-status chip row is the first FilterChipRow on the page
    // (the substatus row is the second, only visible when a status is selected).
    // We collect all chip labels from .MuiChip-label elements that are children
    // of a .MuiChip-root, excluding those inside the off-screen native select
    // wrapper (left: -9999).
    const chips = Array.from(document.querySelectorAll('[data-testid="filter-chip"]'));
    return chips
      .map((c) => c.textContent?.trim() || '')
      .filter(Boolean);
  });
}

/**
 * Return the text of all visible substatus chips (the second FilterChipRow).
 */
async function getSubstatusChipLabels(page) {
  return page.evaluate(() => {
    const chipRows = Array.from(document.querySelectorAll('[data-testid="filter-chip"]'));
    // After clicking a lead status, substatus chips appear. We distinguish them
    // by looking for chips whose text contains "All sub-statuses" or known
    // substatus labels ("Hot", "Warm"). We return all chip labels once the
    // substatus row appears.
    return chipRows
      .map((c) => c.textContent?.trim() || '')
      .filter(Boolean);
  });
}

/**
 * Wait for at least one ToggleButton with value=<key> to appear.
 */
async function waitForStageTab(page, key, timeoutMs = 12000) {
  return pollPage(page, (k) => {
    const btn = document.querySelector(`[data-testid="stage-filter-tab-${k}"]`);
    return btn ? 'ok' : null;
  }, key, timeoutMs);
}

/**
 * Wait until the chip row contains a chip matching the given label text.
 */
async function waitForChip(page, labelText, timeoutMs = 10000) {
  return pollPage(page, (lbl) => {
    const chips = Array.from(document.querySelectorAll('[data-testid="filter-chip"]'));
    return chips.some((c) => (c.textContent || '').trim() === lbl) ? 'ok' : null;
  }, labelText, timeoutMs);
}

/**
 * Wait until the chip row does NOT contain a chip matching the given label text.
 */
async function waitForChipAbsent(page, labelText, timeoutMs = 10000) {
  return pollPage(page, (lbl) => {
    const chips = Array.from(document.querySelectorAll('[data-testid="filter-chip"]'));
    return chips.every((c) => (c.textContent || '').trim() !== lbl) ? 'ok' : null;
  }, labelText, timeoutMs);
}

// ── Report ─────────────────────────────────────────────────────────────────────

async function writeReport(runId, findings) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok && !f.skipped).length;
  const skipped = findings.filter(f => f.skipped).length;
  const lines = [
    '# Stage-Scoped Pills — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:stage-scoped-pills\``,
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
    ...findings.map(f => `| ${f.ok ? 'PASS' : f.skipped ? 'SKIP' : 'FAIL'} | ${esc(f.id)} | ${esc(f.detail)} |`),
    '',
    '## Coverage',
    '',
    '- **[A] Stage tabs appear**: workflow API response populates All, Sales, and',
    '  Design Visit tabs in the ToggleButtonGroup.',
    '- **[B] Stage tab fires scoped request**: clicking Sales sends',
    '  `/api/contacts-lead-status-counts?stage=sales`.',
    '- **[C] Zero-count pills are hidden**: after switching to Sales only OPEN_DEAL',
    '  (count 5) is visible; NEW (0) and DORMANT (0) are not rendered.',
    '- **[D] Substatus counts are stage-scoped**: clicking OPEN_DEAL with an active',
    '  stage filter calls `/api/contacts-substatus-counts?leadStatus=OPEN_DEAL&stage=sales`.',
    '- **[E] Zero-count substatus chips hidden**: only HOT (3) appears; WARM (0) is absent.',
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

  const runId = Math.random().toString(36).slice(2, 8);
  console.log(`\n  stage-scoped-pills  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);
  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  member=${users.member.email}`);

  const { child, logBuf } = spawnServer();
  let exited = false;
  child.on('exit', () => { exited = true; });

  const findings = [];
  function record(id, ok, detail) {
    findings.push({ id, ok, detail });
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
  }
  const skip = makeSkip3(findings);

  const cleanupAndExit = async (code) => {
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    process.exit(code);
  };
  process.on('SIGINT',  () => cleanupAndExit(130));
  process.on('SIGTERM', () => cleanupAndExit(130));
  process.on('uncaughtException',  e => { console.error('Uncaught:', e);  cleanupAndExit(2); });
  process.on('unhandledRejection', e => { console.error('Unhandled:', e); cleanupAndExit(2); });

  // ── Boot ──────────────────────────────────────────────────────────────────
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

  const memberClient = await login(users.member.email, PASSWORD);

  // ── Puppeteer guard ───────────────────────────────────────────────────────
  const UI_LABELS = [
    '[A.1] Stage tabs appear (All, Sales, Design Visit)',
    '[B.1] Sales tab click fires /api/contacts-lead-status-counts?stage=sales',
    '[C.1] After stage=sales: OPEN_DEAL (5) chip visible',
    '[C.2] After stage=sales: NEW (0) chip absent',
    '[C.3] After stage=sales: DORMANT (0) chip absent',
    '[D.1] OPEN_DEAL click triggers /api/contacts-substatus-counts with leadStatus+stage',
    '[E.1] Substatus chip HOT (3) is visible',
    '[E.2] Substatus chip WARM (0) is absent',
  ];

  if (!puppeteer) {
    for (const l of UI_LABELS) skip(l, 'puppeteer not installed');
    await writeReport(runId, findings);
    await cleanupAndExit(findings.filter(f => !f.ok).length > 0 ? 1 : 0);
    return;
  }

  const { findChromium } = require('../shared/find-chromium');
  let browser = null;
  const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
  const attempts = [{ args: launchArgs }];
  const sysChrome = findChromium();
  if (sysChrome) attempts.push({ executablePath: sysChrome, args: launchArgs });
  for (const opts of attempts) {
    try {
      browser = await puppeteer.launch({
        headless: true,
        defaultViewport: { width: 1280, height: 800 },
        ...opts,
      });
      break;
    } catch {
      browser = null;
    }
  }

  if (!browser) {
    for (const l of UI_LABELS) skip(l, 'browser launch failed');
    await writeReport(runId, findings);
    await cleanupAndExit(1);
    return;
  }

  let page = null;
  try {
    page = await newPage(browser, memberClient.cookie);
    const tracked = await setupInterception(page);

    // ══════════════════════════════════════════════════════════════════════
    // Navigate to /customers and wait for the page to load
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n  Navigating to /customers …');
    await page.goto(`${BASE}/customers`, { waitUntil: 'domcontentloaded', timeout: 25000 });

    // Wait for the lead-status chip row to appear (store.loaded = true).
    // The "All statuses" chip is always the first chip in the row.
    const chipsLoaded = await pollPage(page, () => {
      const chips = Array.from(document.querySelectorAll('[data-testid="filter-chip"]'));
      return chips.some((c) => (c.textContent || '').trim() === 'All statuses') ? 'ok' : null;
    }, null, 15000);

    if (!chipsLoaded) {
      const err = 'lead-status chip row did not appear within 15 s';
      console.log(`  Diag: chips not loaded — ${err}`);
      console.log('  Page errors:', page.__logs.filter(l => l.includes('[pageerror]')));
      for (const l of UI_LABELS) record(l, false, err);
      await closePage(page);
      await browser.close().catch(() => {});
      await writeReport(runId, findings);
      await cleanupAndExit(1);
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // Probe A — Stage tabs appear
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n  [A] Stage tabs appear');
    {
      // The workflow mock returns sales and designvisit stages.
      // The "All" tab is always added first in the component.
      const allPresent = await waitForStageTab(page, '__all__', 10000);
      const salesPresent = await waitForStageTab(page, 'sales', 10000);
      const dvPresent = await waitForStageTab(page, 'designvisit', 10000);

      const ok = allPresent === 'ok' && salesPresent === 'ok' && dvPresent === 'ok';
      record(UI_LABELS[0], ok,
        `all=${allPresent} sales=${salesPresent} designvisit=${dvPresent}`);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Probe B — Clicking the Sales tab fires a stage-scoped counts request
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n  [B] Sales tab fires stage-scoped counts request');
    {
      // Clear tracked calls accumulated during page load.
      tracked.countsCalls = [];

      // Click the Sales tab.
      const clicked = await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="stage-filter-tab-sales"]');
        if (!btn) return false;
        btn.click();
        return true;
      });

      if (!clicked) {
        record(UI_LABELS[1], false, 'sales tab button not found in DOM');
      } else {
        // Wait for the stage-scoped counts request to be made.
        const stageCalled = await pollPage(page, () => {
          // We poll from the Node.js side; use a small helper exposed on window.
          // Actually, tracked.countsCalls is in Node scope, not the browser.
          // We'll just return 'ok' from here and check in Node after the poll.
          return 'ok';
        }, null, 50);
        // Give the request up to 5 seconds to fire.
        let stageReqFound = false;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if (tracked.countsCalls.some(u => u.includes('stage=sales'))) {
            stageReqFound = true;
            break;
          }
          await new Promise(r => setTimeout(r, 100));
        }
        record(UI_LABELS[1], stageReqFound,
          `stage=sales found=${stageReqFound}  all calls: [${tracked.countsCalls.join(', ')}]`);
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // Probe C — Zero-count pills are hidden in the Sales stage view
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n  [C] Zero-count pills hidden after stage=sales');
    {
      // MOCK_COUNTS_SALES = { OPEN_DEAL: 5, NEW: 0, DORMANT: 0 }
      // Expected: "Open Deal (5)" chip present, "New (0)" and "Dormant (0)" absent.

      // Wait for the "Open Deal (5)" chip to appear (counts have been applied).
      const openDealChip = await waitForChip(page, 'Open Deal (5)', 10000);
      record(UI_LABELS[2], openDealChip === 'ok',
        `"Open Deal (5)" chip present=${openDealChip === 'ok'}`);

      // "New" should NOT appear as a chip (count 0 → filtered out by FilterChipRow).
      const newAbsent = await waitForChipAbsent(page, 'New (0)', 5000)
        .catch(() => null);
      // Also check it's not present without a count suffix.
      const newChipAbsent = await page.evaluate(() => {
        const chips = Array.from(document.querySelectorAll('[data-testid="filter-chip"]'));
        return chips.every((c) => {
          const t = (c.textContent || '').trim();
          return t !== 'New (0)' && t !== 'New';
        }) ? 'ok' : null;
      });
      record(UI_LABELS[3], newChipAbsent === 'ok',
        `"New" chip absent=${newChipAbsent === 'ok'}`);

      // "Dormant" should NOT appear as a chip (count 0).
      const dormantChipAbsent = await page.evaluate(() => {
        const chips = Array.from(document.querySelectorAll('[data-testid="filter-chip"]'));
        return chips.every((c) => {
          const t = (c.textContent || '').trim();
          return t !== 'Dormant (0)' && t !== 'Dormant';
        }) ? 'ok' : null;
      });
      record(UI_LABELS[4], dormantChipAbsent === 'ok',
        `"Dormant" chip absent=${dormantChipAbsent === 'ok'}`);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Probe D — Clicking OPEN_DEAL calls substatus-counts with stage+leadStatus
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n  [D] OPEN_DEAL click triggers stage-scoped substatus-counts request');
    {
      tracked.substatusCalls = [];

      // Click the "Open Deal (5)" chip to select the OPEN_DEAL lead status.
      const chipClicked = await page.evaluate(() => {
        const chips = Array.from(document.querySelectorAll('[data-testid="filter-chip"]'));
        const target = chips.find((c) => {
          return (c.textContent || '').trim() === 'Open Deal (5)';
        });
        if (!target) return false;
        target.click();
        return true;
      });

      if (!chipClicked) {
        record(UI_LABELS[5], false, '"Open Deal (5)" chip not found — cannot click');
      } else {
        // Wait for the substatus-counts call with both params.
        let subsCallFound = false;
        const deadline = Date.now() + 6000;
        while (Date.now() < deadline) {
          if (tracked.substatusCalls.some(u =>
            u.includes('leadStatus=OPEN_DEAL') && u.includes('stage=sales')
          )) {
            subsCallFound = true;
            break;
          }
          await new Promise(r => setTimeout(r, 100));
        }
        record(UI_LABELS[5], subsCallFound,
          `leadStatus+stage found=${subsCallFound}  calls: [${tracked.substatusCalls.join(', ')}]`);
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // Probe E — Only HOT (3) appears in substatus chip row; WARM (0) absent
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n  [E] Substatus chip row: HOT visible, WARM absent');
    {
      // MOCK_SUBSTATUS_COUNTS_SALES = { OPEN_DEAL__HOT: 3, OPEN_DEAL__WARM: 0 }
      // The substatus chip keys are OPEN_DEAL__HOT and OPEN_DEAL__WARM.
      // The labels are "Hot (3)" and "Warm" — WARM's count is 0 so the component
      // filters it out (visibleSubstatuses only keeps count > 0 when stageFilter is active).

      // Wait for the "Hot (3)" substatus chip to appear.
      const hotChip = await waitForChip(page, 'Hot (3)', 10000);
      record(UI_LABELS[6], hotChip === 'ok',
        `"Hot (3)" substatus chip present=${hotChip === 'ok'}`);

      // "Warm" should NOT appear (count 0 is filtered out).
      const warmAbsent = await page.evaluate(() => {
        const chips = Array.from(document.querySelectorAll('[data-testid="filter-chip"]'));
        return chips.every((c) => {
          const t = (c.textContent || '').trim();
          return t !== 'Warm (0)' && t !== 'Warm';
        }) ? 'ok' : null;
      });
      record(UI_LABELS[7], warmAbsent === 'ok',
        `"Warm" substatus chip absent=${warmAbsent === 'ok'}`);
    }

    // ── Diagnostics ───────────────────────────────────────────────────────
    if (page.__logs.some(l => l.includes('[pageerror]'))) {
      console.log('  Page errors:', page.__logs.filter(l => l.includes('[pageerror]')));
    }
    const chipLabels = await getLeadStatusChipLabels(page).catch(() => []);
    console.log(`  Final chip labels: [${chipLabels.join(', ')}]`);

  } catch (e) {
    console.error('  Probe crashed:', e.message, e.stack);
    for (const l of UI_LABELS) {
      if (!findings.some(f => f.id === l)) record(l, false, `crashed: ${e.message}`);
    }
  } finally {
    if (page) await closePage(page).catch(() => {});
    await browser.close().catch(() => {});
  }

  const failed = findings.filter(f => !f.ok && !f.skipped).length;
  console.log(`\n  Results: ${findings.length - failed} passed, ${failed} failed`);

  await writeReport(runId, findings);
  await cleanupAndExit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(2);
});
