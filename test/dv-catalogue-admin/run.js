'use strict';
// test/dv-catalogue-admin/run.js
//
// End-to-end live test for the Design Visit admin catalogue modals
// (Handles, Furniture Ranges, Door Styles).  Boots a disposable server with
// the privileges harness, drives the UI with Puppeteer, writes a markdown
// report to test-results/dv-catalogue-admin.md.
//
// Covers (per task #668):
//   (API) Pre-checks — GET /api/admin/design-visit-handles,
//         /api/admin/design-visit-furniture-ranges and
//         /api/admin/design-visit-door-styles respond for admin.
//   (H)   Handle modal — open via "+ Add handle", fill Name + Style, click
//         Save: the Save button is disabled and shows "Saving…" while the
//         POST is in flight, the modal closes, the new row appears in
//         #dv-handles-wrap *without a page reload*, and the Style column
//         shows the value picked in the dropdown.
//   (F)   Furniture-range modal — open via "+ Add range", fill Name +
//         Description, click Save: Save disables + shows "Saving…", modal
//         closes, new row appears in #dv-furniture-wrap without reload.
//   (D)   Door-style modal — open via "+ Add style", fill Name + Image URL,
//         click Save: Save disables + shows "Saving…", modal closes, new
//         row appears in #dv-door-styles-wrap without reload.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:dv-catalogue-admin
//   PRIVTEST_ALLOW_SHARED_DB=1      npm run test:dv-catalogue-admin

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

// ── Fixtures ─────────────────────────────────────────────────────────────────
const RUN_PREFIX = 'privtest-dvca';

const HANDLE_NAME     = `${RUN_PREFIX} handle`;
const HANDLE_STYLE    = 'Bar';
const FURNITURE_NAME  = `${RUN_PREFIX} furniture`;
const FURNITURE_DESC  = `${RUN_PREFIX} furniture description`;
const DOOR_NAME       = `${RUN_PREFIX} door`;
const DOOR_IMG_URL    = 'https://example.invalid/privtest-door.png';

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

async function pollPage(page, fn, arg, timeoutMs = 6000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const got = await page.evaluate(fn, arg);
    if (got) return got;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

async function purgeFixtures(pool) {
  await pool.query(
    `DELETE FROM design_visit_handles WHERE name LIKE $1`,
    [`${RUN_PREFIX}%`],
  );
  await pool.query(
    `DELETE FROM design_visit_furniture_ranges WHERE name LIKE $1`,
    [`${RUN_PREFIX}%`],
  );
  await pool.query(
    `DELETE FROM design_visit_door_styles WHERE name LIKE $1`,
    [`${RUN_PREFIX}%`],
  );
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

  const runId = Math.random().toString(36).slice(2, 8);
  console.log(`\n  dv-catalogue-admin E2E  run=${runId}`);
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
    try {
      await purgeFixtures(pool);
      await cleanupTestData(pool);
    } catch {}
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

  // Wait for catalogue tables to exist (auto-created on boot).
  const waitForTable = async (name) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const r = await pool.query(`SELECT to_regclass($1) AS t`, [name]);
      if (r.rows[0].t) return;
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`Timed out waiting for table ${name}`);
  };
  await waitForTable('design_visit_handles');
  await waitForTable('design_visit_furniture_ranges');
  await waitForTable('design_visit_door_styles');

  await purgeFixtures(pool);

  // ── API pre-checks ─────────────────────────────────────────────────────────
  const adminClient = await login(users.admin.email, PASSWORD);

  for (const [label, url] of [
    ['handles',        '/api/admin/design-visit-handles'],
    ['furniture',      '/api/admin/design-visit-furniture-ranges'],
    ['door-styles',    '/api/admin/design-visit-door-styles'],
  ]) {
    const r = await adminClient.get(url);
    record(
      `GET ${url} responds for admin`,
      'status=200, JSON array',
      `status=${r.status} type=${Array.isArray(r.json) ? 'array' : typeof r.json}`,
      r.status === 200 && Array.isArray(r.json),
    );
  }

  if (!puppeteer) {
    record('puppeteer is installed', 'puppeteer required', 'module not found', false);
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

  try {
    const page = await browser.newPage();
    await page.setCacheEnabled(false);
    await injectSession(page, adminClient.cookie);

    // Stamp a reload sentinel so we can detect a full document reload mid-test.
    await page.evaluateOnNewDocument(() => {
      window.__reloadSentinelEverSet = true;
    });

    await page.goto(`${BASE}/admin`, {
      waitUntil: 'load',
      timeout: 25000,
    });

    // The page also stamps a per-load token in a global; set our own so we
    // can detect navigations.
    await page.evaluate(() => { window.__pageLoadToken = Math.random().toString(36).slice(2); });
    const pageLoadToken = await page.evaluate(() => window.__pageLoadToken);

    // Open the Design Visit tab and load the catalogue.
    const tabSwitched = await pollPage(
      page,
      () => typeof window.switchTab === 'function' && typeof window.loadDvCatalogue === 'function',
      null,
      8000,
    );
    record(
      'admin page exposes switchTab + loadDvCatalogue',
      'both globals available',
      `ready=${!!tabSwitched}`,
      !!tabSwitched,
    );

    await page.evaluate(() => {
      window.switchTab('designvisit');
      return window.loadDvCatalogue();
    });

    // Wait for at least one of the catalogue wraps to render the empty state
    // (no leading "Loading…").
    const emptyReady = await pollPage(page, () => {
      const wraps = ['dv-handles-wrap', 'dv-furniture-wrap', 'dv-door-styles-wrap'];
      return wraps.every(id => {
        const el = document.getElementById(id);
        return el && !/Loading…/.test(el.textContent);
      });
    }, null, 10000);
    record(
      'design-visit catalogue lists load (no "Loading…")',
      'all three wraps replaced their Loading placeholders',
      `ready=${!!emptyReady}`,
      !!emptyReady,
    );

    // Helper: drive one Add-modal flow and assert the in-flight UX +
    // in-place list refresh.
    //
    //   spec.addBtnSelector  — CSS selector for the "+ Add …" button.
    //   spec.endpoint        — POST URL to intercept and delay (so we can
    //                          observe Save being disabled mid-request).
    //   spec.fillForm(page)  — async; fills the modal's inputs.
    //   spec.wrapId          — id of the list wrap that should refresh.
    //   spec.assertRow(text) — predicate run on wrap.textContent after the
    //                          modal closes.
    async function runAddFlow(label, spec) {
      console.log(`\n  [${label}] add via "${spec.addBtnLabel}" button`);

      // Reset the row count baseline for this wrap.
      const baselineRows = await page.evaluate((id) => {
        const w = document.getElementById(id);
        return w ? w.querySelectorAll('tbody tr').length : -1;
      }, spec.wrapId);

      // Intercept the POST so we can hold it open while we sample the
      // Save-button state.  Puppeteer's setRequestInterception is process-
      // wide for the page, but it's safe to enable/disable around each flow.
      await page.setRequestInterception(true);
      const interceptHold = { release: null };
      const holdPromise = new Promise(res => { interceptHold.release = res; });
      const reqListener = async (req) => {
        const u = req.url();
        if (req.method() === 'POST' && u.endsWith(spec.endpoint)) {
          // Hold the request for ~600 ms so the in-flight UI is observable.
          await holdPromise;
          try { await req.continue(); } catch {}
        } else {
          try { await req.continue(); } catch {}
        }
      };
      page.on('request', reqListener);

      // Click "+ Add …".  We dispatch via in-page click() so a re-render
      // can't move the element from under Puppeteer.
      const addClicked = await page.evaluate((sel) => {
        const btn = document.querySelector(sel);
        if (!btn) return false;
        btn.click();
        return true;
      }, spec.addBtnSelector);
      record(
        `[${label}] click + Add opens the modal`,
        'modal with #dvie-name appears',
        `clicked=${addClicked}`,
        addClicked,
      );

      const modalReady = await pollPage(page, () => {
        const name = document.querySelector('#dvie-name');
        const save = document.querySelector('#dvie-save');
        return !!name && !!save;
      }, null, 4000);
      record(
        `[${label}] modal renders #dvie-name + #dvie-save`,
        'modal inputs present',
        `ready=${!!modalReady}`,
        !!modalReady,
      );

      // Fill in the modal-specific fields.
      await spec.fillForm(page);

      // Click Save (in-page), then immediately sample the in-flight state.
      await page.evaluate(() => document.querySelector('#dvie-save').click());

      const inflight = await pollPage(page, () => {
        const btn = document.querySelector('#dvie-save');
        if (!btn) return null;
        return { disabled: btn.disabled, text: (btn.textContent || '').trim() };
      }, null, 3000);
      // Only flag failure if we couldn't observe the saving state.
      record(
        `[${label}] Save button is disabled and shows "Saving…" while POST is in flight`,
        '#dvie-save.disabled === true && text === "Saving…"',
        `state=${JSON.stringify(inflight)}`,
        !!inflight && inflight.disabled === true && /Saving/i.test(inflight.text),
      );

      // Release the held request and let the modal close + list refresh.
      interceptHold.release();
      // Wait a moment for the response to be applied.
      await pollPage(page, () => !document.querySelector('#dvie-save'), null, 6000);

      page.off('request', reqListener);
      await page.setRequestInterception(false);

      // Assert the wrap refreshed in place (no page reload).
      const stillSameLoad = await page.evaluate(t => window.__pageLoadToken === t, pageLoadToken);
      record(
        `[${label}] no full page reload (window.__pageLoadToken preserved)`,
        `__pageLoadToken === "${pageLoadToken}"`,
        `preserved=${stillSameLoad}`,
        stillSameLoad === true,
      );

      // Assert the new row landed in the wrap.
      const wrapState = await pollPage(page, ({ id, baseline }) => {
        const w = document.getElementById(id);
        if (!w) return null;
        const rows = w.querySelectorAll('tbody tr');
        if (rows.length <= baseline) return null;
        return { rows: rows.length, text: w.textContent || '' };
      }, { id: spec.wrapId, baseline: baselineRows }, 6000);
      record(
        `[${label}] list at #${spec.wrapId} grew by ≥1 row after save`,
        `row count > ${baselineRows}`,
        `state=${JSON.stringify(wrapState)}`,
        !!wrapState && wrapState.rows > baselineRows,
      );

      const rowOk = !!wrapState && spec.assertRow(wrapState.text);
      record(
        `[${label}] new row shows the values entered in the modal`,
        spec.assertExpected,
        wrapState ? `text-includes=${spec.assertObserved(wrapState.text)}` : 'no wrap state',
        rowOk,
      );
    }

    // ── (H) Handle ────────────────────────────────────────────────────────────
    await runAddFlow('H', {
      addBtnLabel:     '+ Add handle',
      addBtnSelector:  'button[onclick="openDvHandleEditor()"]',
      endpoint:        '/api/admin/design-visit-handles',
      wrapId:          'dv-handles-wrap',
      assertExpected:  `wrap contains "${HANDLE_NAME}" and "${HANDLE_STYLE}"`,
      assertObserved:  t => `name=${t.includes(HANDLE_NAME)} style=${t.includes(HANDLE_STYLE)}`,
      assertRow:       t => t.includes(HANDLE_NAME) && t.includes(HANDLE_STYLE),
      fillForm: async (p) => {
        await p.evaluate(({ name, style }) => {
          const n = document.querySelector('#dvie-name');
          n.value = name;
          n.dispatchEvent(new Event('input', { bubbles: true }));
          const s = document.querySelector('#dvie-style');
          s.value = style;
          s.dispatchEvent(new Event('change', { bubbles: true }));
        }, { name: HANDLE_NAME, style: HANDLE_STYLE });
      },
    });

    // Verify style persisted via the API (server returned style="Bar").
    const handlesAfter = await adminClient.get('/api/admin/design-visit-handles');
    const createdHandle = Array.isArray(handlesAfter.json)
      ? handlesAfter.json.find(h => h.name === HANDLE_NAME)
      : null;
    record(
      '[H] style dropdown value persisted in DB and returned by API',
      `handle.style === "${HANDLE_STYLE}"`,
      `got=${JSON.stringify(createdHandle && { id: createdHandle.id, name: createdHandle.name, style: createdHandle.style })}`,
      !!createdHandle && createdHandle.style === HANDLE_STYLE,
    );

    // ── (F) Furniture range ───────────────────────────────────────────────────
    await runAddFlow('F', {
      addBtnLabel:     '+ Add range',
      addBtnSelector:  'button[onclick="openDvFurnitureEditor()"]',
      endpoint:        '/api/admin/design-visit-furniture-ranges',
      wrapId:          'dv-furniture-wrap',
      assertExpected:  `wrap contains "${FURNITURE_NAME}" and "${FURNITURE_DESC}"`,
      assertObserved:  t => `name=${t.includes(FURNITURE_NAME)} desc=${t.includes(FURNITURE_DESC)}`,
      assertRow:       t => t.includes(FURNITURE_NAME) && t.includes(FURNITURE_DESC),
      fillForm: async (p) => {
        await p.evaluate(({ name, desc }) => {
          const n = document.querySelector('#dvie-name');
          n.value = name;
          n.dispatchEvent(new Event('input', { bubbles: true }));
          const d = document.querySelector('#dvie-desc');
          d.value = desc;
          d.dispatchEvent(new Event('input', { bubbles: true }));
        }, { name: FURNITURE_NAME, desc: FURNITURE_DESC });
      },
    });

    // ── (D) Door style ────────────────────────────────────────────────────────
    await runAddFlow('D', {
      addBtnLabel:     '+ Add style',
      addBtnSelector:  'button[onclick="openDvDoorStyleEditor()"]',
      endpoint:        '/api/admin/design-visit-door-styles',
      wrapId:          'dv-door-styles-wrap',
      assertExpected:  `wrap contains "${DOOR_NAME}" and the image URL`,
      assertObserved:  t => `name=${t.includes(DOOR_NAME)} url=${t.includes(DOOR_IMG_URL)}`,
      assertRow:       t => t.includes(DOOR_NAME) && t.includes(DOOR_IMG_URL),
      fillForm: async (p) => {
        await p.evaluate(({ name, url }) => {
          const n = document.querySelector('#dvie-name');
          n.value = name;
          n.dispatchEvent(new Event('input', { bubbles: true }));
          const i = document.querySelector('#dvie-img');
          i.value = url;
          i.dispatchEvent(new Event('input', { bubbles: true }));
        }, { name: DOOR_NAME, url: DOOR_IMG_URL });
      },
    });

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
    '# Design Visit Catalogue Admin Modals — E2E Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:dv-catalogue-admin\``,
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
    '- **(API pre-checks)**: `GET /api/admin/design-visit-handles`,',
    '  `/api/admin/design-visit-furniture-ranges`, and',
    '  `/api/admin/design-visit-door-styles` respond 200 + array for admin.',
    '- **(H/F/D) Add via modal**: for handle, furniture range, and door style:',
    '  - The "+ Add …" button opens the editor modal (`#dvie-name`,',
    '    `#dvie-save` present).',
    '  - With the POST request held open via Puppeteer request interception,',
    '    `#dvie-save.disabled === true` and its label flips to "Saving…"',
    '    (regression guard against the double-save / non-locking bug).',
    '  - After the response is released, the modal closes and the matching',
    '    catalogue wrap (`#dv-handles-wrap` / `#dv-furniture-wrap` /',
    '    `#dv-door-styles-wrap`) gains at least one row whose text contains',
    '    the values entered in the modal — *without a full page reload*',
    '    (`window.__pageLoadToken` is preserved across the save).',
    '- **(H) Style dropdown persistence**: after saving the handle, the',
    '  follow-up `GET /api/admin/design-visit-handles` returns the row with',
    '  `style === "Bar"`, proving the dropdown value reached the database.',
    '',
    '## Notes',
    '',
    '- Fixtures use the `privtest-dvca` name prefix and are purged in',
    '  `cleanupAndExit()` (including on signal / crash). The harness strips',
    '  `HUBSPOT_TOKEN` / `SMTP_*` / OAuth credentials; the design-visit',
    '  catalogue endpoints are PostgreSQL-only, so no third-party access is',
    '  needed.',
  ];
  const outPath = path.join(dir, 'dv-catalogue-admin.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Report: test-results/dv-catalogue-admin.md`);
}

main();
