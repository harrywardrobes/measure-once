'use strict';
// test/dv-catalogue-admin/run.js
//
// End-to-end live test for the Design Visit admin catalogue modals
// (Handles, Furniture Ranges, Door Styles).  Boots a disposable server with
// the privileges harness, drives the UI with Puppeteer, writes a markdown
// report to test-results/dv-catalogue-admin.md.
//
// Covers (per task #668 + #688):
//   (API)    Pre-checks — GET /api/admin/design-visit-handles,
//            /api/admin/design-visit-furniture-ranges and
//            /api/admin/design-visit-door-styles respond for admin.
//   (H)      Handle modal — open via "+ Add handle", fill Name + Style, click
//            Save: the Save button is disabled and shows "Saving…" while the
//            POST is in flight, the modal closes, the new row appears in
//            #dv-handles-wrap *without a page reload*, and the Style column
//            shows the value picked in the dropdown.
//   (F)      Furniture-range modal — open via "+ Add range", fill Name +
//            Description, click Save: Save disables + shows "Saving…", modal
//            closes, new row appears in #dv-furniture-wrap without reload.
//   (D)      Door-style modal — open via "+ Add style", fill Name + Image URL,
//            click Save: Save disables + shows "Saving…", modal closes, new
//            row appears in #dv-door-styles-wrap without reload.
//   (H/edit) Handle edit — re-open the seeded handle via openDvItemEditor,
//            assert Save button label reads "Save" (not "Add"), the modal is
//            pre-filled with the existing name + style (the handle style
//            dropdown's "preserve existing value" branch), rename + change
//            style, hold the PATCH in flight to assert the Saving… lock, then
//            verify the wrap refreshes in place and the DB row reflects the
//            edit.
//   (F/edit) Furniture-range edit — same shape against the seeded furniture
//            row (rename + new description, PATCH .../furniture-ranges/:id).
//   (D/edit) Door-style edit — same shape against the seeded door-style row
//            (rename + new image URL, PATCH .../door-styles/:id).
//   (H/del)  Handle delete — stub window.confirm=true, click the row's Delete
//            button, assert the DELETE hits /api/admin/design-visit-handles/:id,
//            the row disappears from #dv-handles-wrap without a page reload,
//            the DB row is gone, AND the seeded local image file under
//            public/uploads/handles/ is unlinked by the server
//            (_deleteLocalHandleImage).
//   (F/del)  Furniture-range delete — same shape against the seeded furniture
//            row (DELETE .../furniture-ranges/:id; no local-file side effect).
//   (D/del)  Door-style delete — same shape against the seeded door-style row
//            (DELETE .../door-styles/:id; no local-file side effect).
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

const { pollUntil, pollFn } = require('../helpers/poll');

// ── Fixtures ─────────────────────────────────────────────────────────────────
const RUN_PREFIX = 'privtest-dvca';

// Local file path that mirrors design-visits.js HANDLES_UPLOAD_DIR. Used by
// the (H/del) probe to prove _deleteLocalHandleImage() runs server-side.
const HANDLES_UPLOAD_DIR = path.resolve(__dirname, '..', '..', 'public', 'uploads', 'handles');

const HANDLE_NAME     = `${RUN_PREFIX} handle`;
const HANDLE_STYLE    = 'Bar';
const FURNITURE_NAME  = `${RUN_PREFIX} furniture`;
const FURNITURE_DESC  = `${RUN_PREFIX} furniture description`;
const DOOR_NAME       = `${RUN_PREFIX} door`;
const DOOR_IMG_URL    = 'https://example.invalid/privtest-door.png';

// Edit-flow targets — applied to the rows the add flow created above.
const HANDLE_NAME_EDITED    = `${RUN_PREFIX} handle (edited)`;
const HANDLE_STYLE_EDITED   = 'Knob';
const FURNITURE_NAME_EDITED = `${RUN_PREFIX} furniture (edited)`;
const FURNITURE_DESC_EDITED = `${RUN_PREFIX} furniture description (edited)`;
const DOOR_NAME_EDITED      = `${RUN_PREFIX} door (edited)`;
const DOOR_IMG_URL_EDITED   = 'https://example.invalid/privtest-door-edited.png';

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
  return pollUntil(page, fn, timeoutMs, intervalMs, arg !== undefined && arg !== null ? [arg] : []);
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
    const found = await pollFn(async () => {
      const r = await pool.query(`SELECT to_regclass($1) AS t`, [name]);
      return r.rows[0].t || null;
    }, 15000, 200);
    if (!found) throw new Error(`Timed out waiting for table ${name}`);
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

    // Helper: drive one Edit-modal flow against a row already in the wrap, and
    // assert the modal pre-fills, the in-flight UX, the in-place list refresh,
    // and the DB row reflects the edit.
    //
    //   spec.type            — 'handle' | 'furniture' | 'door-style' (used to
    //                          look up openDvItemEditor(type, id)).
    //   spec.endpoint        — base URL (no trailing id) for the PATCH route.
    //   spec.wrapId          — id of the list wrap that should refresh.
    //   spec.targetId        — id of the seeded row to edit.
    //   spec.expectedPrefill — { name, ...extras } expected pre-fill values
    //                          (asserted against the modal inputs before edit).
    //   spec.fillEdits(page) — async; mutates modal inputs to the new values.
    //   spec.assertRow(text) — predicate on wrap.textContent after save.
    //   spec.dbProbe()       — async () returning the post-edit row from DB;
    //                          used to assert the persisted state.
    //   spec.dbExpected      — predicate against the dbProbe row.
    async function runEditFlow(label, spec) {
      console.log(`\n  [${label}] edit existing row id=${spec.targetId}`);

      // Open the editor for the seeded row directly (avoids fishing the Edit
      // button out of a row that just re-rendered).
      const opened = await page.evaluate(({ type, id }) => {
        if (typeof window.openDvItemEditor !== 'function') return false;
        window.openDvItemEditor(type, id);
        return true;
      }, { type: spec.type, id: spec.targetId });
      record(
        `[${label}/edit] openDvItemEditor('${spec.type}', ${spec.targetId}) is callable`,
        'window.openDvItemEditor exists and was called',
        `opened=${opened}`,
        opened,
      );

      const modalReady = await pollPage(page, () => {
        const name = document.querySelector('#dvie-name');
        const save = document.querySelector('#dvie-save');
        return !!name && !!save;
      }, null, 6000);
      record(
        `[${label}/edit] edit modal renders #dvie-name + #dvie-save`,
        'modal inputs present',
        `ready=${!!modalReady}`,
        !!modalReady,
      );

      // Save button on edit must read "Save" (not "Add").
      const saveLabel = await page.evaluate(() => {
        const btn = document.querySelector('#dvie-save');
        return btn ? (btn.textContent || '').trim() : null;
      });
      record(
        `[${label}/edit] Save button reads "Save" (not "Add") in edit mode`,
        'textContent === "Save"',
        `label=${JSON.stringify(saveLabel)}`,
        saveLabel === 'Save',
      );

      // Pre-fill snapshot.
      const prefill = await page.evaluate(() => {
        const get = sel => {
          const el = document.querySelector(sel);
          return el ? el.value : null;
        };
        return {
          name:  get('#dvie-name'),
          style: get('#dvie-style'),
          desc:  get('#dvie-desc'),
          img:   get('#dvie-img'),
        };
      });
      const prefillOk = Object.entries(spec.expectedPrefill).every(
        ([k, v]) => prefill[k] === v,
      );
      record(
        `[${label}/edit] modal pre-fills existing values`,
        `inputs match ${JSON.stringify(spec.expectedPrefill)}`,
        `got=${JSON.stringify(prefill)}`,
        prefillOk,
      );

      // Intercept the PATCH so we can hold it open while we sample the
      // Save-button state.
      await page.setRequestInterception(true);
      const interceptHold = { release: null };
      const holdPromise = new Promise(res => { interceptHold.release = res; });
      const patchUrl = `${spec.endpoint}/${spec.targetId}`;
      const reqListener = async (req) => {
        const u = req.url();
        if (req.method() === 'PATCH' && u.endsWith(patchUrl)) {
          await holdPromise;
          try { await req.continue(); } catch {}
        } else {
          try { await req.continue(); } catch {}
        }
      };
      page.on('request', reqListener);

      // Mutate the inputs with the new values, then click Save.
      await spec.fillEdits(page);
      await page.evaluate(() => document.querySelector('#dvie-save').click());

      const inflight = await pollPage(page, () => {
        const btn = document.querySelector('#dvie-save');
        if (!btn) return null;
        return { disabled: btn.disabled, text: (btn.textContent || '').trim() };
      }, null, 3000);
      record(
        `[${label}/edit] Save button is disabled and shows "Saving…" while PATCH is in flight`,
        '#dvie-save.disabled === true && text === "Saving…"',
        `state=${JSON.stringify(inflight)}`,
        !!inflight && inflight.disabled === true && /Saving/i.test(inflight.text),
      );

      // Release the held request and let the modal close + list refresh.
      interceptHold.release();
      await pollPage(page, () => !document.querySelector('#dvie-save'), null, 6000);

      page.off('request', reqListener);
      await page.setRequestInterception(false);

      const stillSameLoad = await page.evaluate(t => window.__pageLoadToken === t, pageLoadToken);
      record(
        `[${label}/edit] no full page reload (window.__pageLoadToken preserved)`,
        `__pageLoadToken === "${pageLoadToken}"`,
        `preserved=${stillSameLoad}`,
        stillSameLoad === true,
      );

      const wrapState = await pollPage(page, (id) => {
        const w = document.getElementById(id);
        if (!w) return null;
        return { rows: w.querySelectorAll('tbody tr').length, text: w.textContent || '' };
      }, spec.wrapId, 6000);
      const rowOk = !!wrapState && spec.assertRow(wrapState.text);
      record(
        `[${label}/edit] list at #${spec.wrapId} reflects the edited values in place`,
        spec.assertExpected,
        wrapState ? `text-includes=${spec.assertObserved(wrapState.text)}` : 'no wrap state',
        rowOk,
      );

      // DB-level assertion that the PATCH persisted.
      const dbRow = await spec.dbProbe();
      record(
        `[${label}/edit] DB row reflects the edit`,
        spec.dbExpectedText,
        `row=${JSON.stringify(dbRow)}`,
        !!dbRow && spec.dbExpected(dbRow),
      );
    }

    // Helper: drive one row-level Delete flow against a seeded row.
    //
    //   spec.type            — 'handle' | 'furniture' | 'door-style'.
    //   spec.endpoint        — base URL (no trailing id) for the DELETE route.
    //   spec.wrapId          — id of the list wrap that should refresh.
    //   spec.targetId        — id of the seeded row to delete.
    //   spec.rowMarkerText   — substring whose disappearance from the wrap
    //                          text proves the row is gone (e.g. the row's
    //                          current name).
    //   spec.dbProbe()       — async () returning the post-delete row (or
    //                          null) for the DB-gone assertion.
    async function runDeleteFlow(label, spec) {
      console.log(`\n  [${label}/del] delete row id=${spec.targetId}`);

      // Stub window.confirm so deleteDvItem() proceeds.  Re-installed every
      // probe in case a prior flow swapped it back.
      await page.evaluate(() => { window.confirm = () => true; });

      // Sanity: the row's Delete button is rendered with the expected onclick.
      const btnSelector =
        `button[onclick="deleteDvItem('${spec.type}', ${spec.targetId})"]`;
      const baselineRows = await page.evaluate((id) => {
        const w = document.getElementById(id);
        return w ? w.querySelectorAll('tbody tr').length : -1;
      }, spec.wrapId);
      const btnPresent = await page.evaluate((sel) =>
        !!document.querySelector(sel), btnSelector);
      record(
        `[${label}/del] row Delete button rendered (${btnSelector})`,
        'button present in wrap',
        `present=${btnPresent} baselineRows=${baselineRows}`,
        btnPresent === true && baselineRows > 0,
      );

      // Intercept DELETE so we can assert the right endpoint was hit.
      await page.setRequestInterception(true);
      const deleteUrl = `${spec.endpoint}/${spec.targetId}`;
      let deleteSeen = null; // { url, method, status }
      const reqListener = async (req) => {
        try { await req.continue(); } catch {}
      };
      const respListener = (resp) => {
        const req = resp.request();
        if (req.method() === 'DELETE' && resp.url().endsWith(deleteUrl)) {
          deleteSeen = { url: resp.url(), method: req.method(), status: resp.status() };
        }
      };
      page.on('request',  reqListener);
      page.on('response', respListener);

      // Click the row's Delete button in-page.
      await page.evaluate((sel) => {
        const btn = document.querySelector(sel);
        if (btn) btn.click();
      }, btnSelector);

      // Wait for the wrap to refresh (row count drops) and the DELETE to land.
      const shrank = await pollPage(page, ({ id, baseline }) => {
        const w = document.getElementById(id);
        if (!w) return null;
        const rows = w.querySelectorAll('tbody tr').length;
        return rows < baseline ? { rows } : null;
      }, { id: spec.wrapId, baseline: baselineRows }, 8000);

      page.off('request',  reqListener);
      page.off('response', respListener);
      await page.setRequestInterception(false);

      record(
        `[${label}/del] DELETE ${deleteUrl} fired and returned 2xx`,
        `method=DELETE url ends with ${deleteUrl}, status 200`,
        `seen=${JSON.stringify(deleteSeen)}`,
        !!deleteSeen && deleteSeen.status >= 200 && deleteSeen.status < 300,
      );

      record(
        `[${label}/del] row removed from #${spec.wrapId} (row count dropped)`,
        `row count < ${baselineRows}`,
        `state=${JSON.stringify(shrank)}`,
        !!shrank,
      );

      // Row-text gone from the wrap.
      const wrapText = await page.evaluate((id) => {
        const w = document.getElementById(id);
        return w ? (w.textContent || '') : '';
      }, spec.wrapId);
      record(
        `[${label}/del] wrap no longer mentions "${spec.rowMarkerText}"`,
        `wrap.textContent excludes "${spec.rowMarkerText}"`,
        `includes=${wrapText.includes(spec.rowMarkerText)}`,
        !wrapText.includes(spec.rowMarkerText),
      );

      const stillSameLoad = await page.evaluate(t => window.__pageLoadToken === t, pageLoadToken);
      record(
        `[${label}/del] no full page reload (window.__pageLoadToken preserved)`,
        `__pageLoadToken === "${pageLoadToken}"`,
        `preserved=${stillSameLoad}`,
        stillSameLoad === true,
      );

      const dbRow = await spec.dbProbe();
      record(
        `[${label}/del] DB row is gone`,
        'dbProbe() returns null',
        `row=${JSON.stringify(dbRow)}`,
        dbRow === null,
      );

      if (typeof spec.assertLocalFileGone === 'string' && spec.assertLocalFileGone) {
        // _deleteLocalHandleImage is fire-and-forget (async fs.unlink), so
        // poll briefly for the file to disappear.
        const fileGone = !!(await pollFn(async () => (
          !fs.existsSync(spec.assertLocalFileGone) ? true : null
        ), 4000, 100));
        record(
          `[${label}/del] local handle image file unlinked by server`,
          `${spec.assertLocalFileGone} no longer exists`,
          `exists=${!fileGone}`,
          fileGone,
        );
      }
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

    // ── (H) Handle — edit existing row ───────────────────────────────────────
    if (createdHandle) {
      await runEditFlow('H', {
        type:           'handle',
        endpoint:       '/api/admin/design-visit-handles',
        wrapId:         'dv-handles-wrap',
        targetId:       createdHandle.id,
        expectedPrefill: { name: HANDLE_NAME, style: HANDLE_STYLE },
        assertExpected: `wrap contains "${HANDLE_NAME_EDITED}" and "${HANDLE_STYLE_EDITED}"`,
        assertObserved: t => `name=${t.includes(HANDLE_NAME_EDITED)} style=${t.includes(HANDLE_STYLE_EDITED)} oldGone=${!t.includes(HANDLE_NAME)}`,
        assertRow:      t => t.includes(HANDLE_NAME_EDITED) && t.includes(HANDLE_STYLE_EDITED) && !t.includes(HANDLE_NAME + '<'),
        dbExpectedText: `name === "${HANDLE_NAME_EDITED}" && style === "${HANDLE_STYLE_EDITED}"`,
        dbExpected:     row => row.name === HANDLE_NAME_EDITED && row.style === HANDLE_STYLE_EDITED,
        dbProbe:        async () => {
          const r = await pool.query(
            `SELECT id, name, style FROM design_visit_handles WHERE id=$1`,
            [createdHandle.id],
          );
          return r.rows[0] || null;
        },
        fillEdits: async (p) => {
          await p.evaluate(({ name, style }) => {
            const n = document.querySelector('#dvie-name');
            n.value = name;
            n.dispatchEvent(new Event('input', { bubbles: true }));
            const s = document.querySelector('#dvie-style');
            s.value = style;
            s.dispatchEvent(new Event('change', { bubbles: true }));
          }, { name: HANDLE_NAME_EDITED, style: HANDLE_STYLE_EDITED });
        },
      });
    } else {
      record(
        '[H/edit] seeded handle row available for edit probe',
        'createdHandle is non-null after add flow',
        'add flow did not surface a handle row to edit',
        false,
      );
    }

    // ── (H) Handle — delete existing row ─────────────────────────────────────
    if (createdHandle) {
      // Seed a local image file under public/uploads/handles/ and point the
      // row's image_url at it, so DELETE exercises _deleteLocalHandleImage.
      const handleImgFilename = `${RUN_PREFIX}-${runId}-${createdHandle.id}.png`;
      const handleImgPath     = path.join(HANDLES_UPLOAD_DIR, handleImgFilename);
      try {
        fs.mkdirSync(HANDLES_UPLOAD_DIR, { recursive: true });
        // 1×1 transparent PNG
        fs.writeFileSync(handleImgPath, Buffer.from(
          '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4'
          + '890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
          'hex',
        ));
      } catch (e) {
        record(
          '[H/del] seed local handle image file on disk',
          `write ${handleImgPath}`,
          `error: ${e.message}`,
          false,
        );
      }
      await pool.query(
        `UPDATE design_visit_handles SET image_url=$1 WHERE id=$2`,
        [`/uploads/handles/${handleImgFilename}`, createdHandle.id],
      );

      // Re-render the wrap so the Delete button for the seeded row is in DOM.
      await page.evaluate(() => window.loadDvHandles && window.loadDvHandles());
      await pollPage(page, (sel) => !!document.querySelector(sel),
        `button[onclick="deleteDvItem('handle', ${createdHandle.id})"]`, 6000);

      await runDeleteFlow('H', {
        type:          'handle',
        endpoint:      '/api/admin/design-visit-handles',
        wrapId:        'dv-handles-wrap',
        targetId:      createdHandle.id,
        rowMarkerText: HANDLE_NAME_EDITED,
        assertLocalFileGone: handleImgPath,
        dbProbe: async () => {
          const r = await pool.query(
            `SELECT id FROM design_visit_handles WHERE id=$1`,
            [createdHandle.id],
          );
          return r.rows[0] || null;
        },
      });
    } else {
      record(
        '[H/del] seeded handle row available for delete probe',
        'createdHandle is non-null after add flow',
        'add flow did not surface a handle row to delete',
        false,
      );
    }

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

    // ── (F) Furniture range — edit existing row ──────────────────────────────
    const furnitureRow = (await pool.query(
      `SELECT id, name, description FROM design_visit_furniture_ranges WHERE name=$1`,
      [FURNITURE_NAME],
    )).rows[0] || null;
    if (furnitureRow) {
      await runEditFlow('F', {
        type:           'furniture',
        endpoint:       '/api/admin/design-visit-furniture-ranges',
        wrapId:         'dv-furniture-wrap',
        targetId:       furnitureRow.id,
        expectedPrefill: { name: FURNITURE_NAME, desc: FURNITURE_DESC },
        assertExpected: `wrap contains "${FURNITURE_NAME_EDITED}" and "${FURNITURE_DESC_EDITED}"`,
        assertObserved: t => `name=${t.includes(FURNITURE_NAME_EDITED)} desc=${t.includes(FURNITURE_DESC_EDITED)}`,
        assertRow:      t => t.includes(FURNITURE_NAME_EDITED) && t.includes(FURNITURE_DESC_EDITED),
        dbExpectedText: `name === "${FURNITURE_NAME_EDITED}" && description === "${FURNITURE_DESC_EDITED}"`,
        dbExpected:     row => row.name === FURNITURE_NAME_EDITED && row.description === FURNITURE_DESC_EDITED,
        dbProbe:        async () => {
          const r = await pool.query(
            `SELECT id, name, description FROM design_visit_furniture_ranges WHERE id=$1`,
            [furnitureRow.id],
          );
          return r.rows[0] || null;
        },
        fillEdits: async (p) => {
          await p.evaluate(({ name, desc }) => {
            const n = document.querySelector('#dvie-name');
            n.value = name;
            n.dispatchEvent(new Event('input', { bubbles: true }));
            const d = document.querySelector('#dvie-desc');
            d.value = desc;
            d.dispatchEvent(new Event('input', { bubbles: true }));
          }, { name: FURNITURE_NAME_EDITED, desc: FURNITURE_DESC_EDITED });
        },
      });
    } else {
      record(
        '[F/edit] seeded furniture row available for edit probe',
        'furniture row exists in DB after add flow',
        'add flow did not produce a furniture row to edit',
        false,
      );
    }

    // ── (F) Furniture range — delete existing row ────────────────────────────
    if (furnitureRow) {
      await page.evaluate(() => window.loadDvFurniture && window.loadDvFurniture());
      await pollPage(page, (sel) => !!document.querySelector(sel),
        `button[onclick="deleteDvItem('furniture', ${furnitureRow.id})"]`, 6000);

      await runDeleteFlow('F', {
        type:          'furniture',
        endpoint:      '/api/admin/design-visit-furniture-ranges',
        wrapId:        'dv-furniture-wrap',
        targetId:      furnitureRow.id,
        rowMarkerText: FURNITURE_NAME_EDITED,
        dbProbe: async () => {
          const r = await pool.query(
            `SELECT id FROM design_visit_furniture_ranges WHERE id=$1`,
            [furnitureRow.id],
          );
          return r.rows[0] || null;
        },
      });
    } else {
      record(
        '[F/del] seeded furniture row available for delete probe',
        'furniture row exists in DB after add flow',
        'add flow did not produce a furniture row to delete',
        false,
      );
    }

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

    // ── (D) Door style — edit existing row ───────────────────────────────────
    const doorRow = (await pool.query(
      `SELECT id, name, image_url FROM design_visit_door_styles WHERE name=$1`,
      [DOOR_NAME],
    )).rows[0] || null;
    if (doorRow) {
      await runEditFlow('D', {
        type:           'door-style',
        endpoint:       '/api/admin/design-visit-door-styles',
        wrapId:         'dv-door-styles-wrap',
        targetId:       doorRow.id,
        expectedPrefill: { name: DOOR_NAME, img: DOOR_IMG_URL },
        assertExpected: `wrap contains "${DOOR_NAME_EDITED}" and the new image URL`,
        assertObserved: t => `name=${t.includes(DOOR_NAME_EDITED)} url=${t.includes(DOOR_IMG_URL_EDITED)}`,
        assertRow:      t => t.includes(DOOR_NAME_EDITED) && t.includes(DOOR_IMG_URL_EDITED),
        dbExpectedText: `name === "${DOOR_NAME_EDITED}" && image_url === "${DOOR_IMG_URL_EDITED}"`,
        dbExpected:     row => row.name === DOOR_NAME_EDITED && row.image_url === DOOR_IMG_URL_EDITED,
        dbProbe:        async () => {
          const r = await pool.query(
            `SELECT id, name, image_url FROM design_visit_door_styles WHERE id=$1`,
            [doorRow.id],
          );
          return r.rows[0] || null;
        },
        fillEdits: async (p) => {
          await p.evaluate(({ name, url }) => {
            const n = document.querySelector('#dvie-name');
            n.value = name;
            n.dispatchEvent(new Event('input', { bubbles: true }));
            const i = document.querySelector('#dvie-img');
            i.value = url;
            i.dispatchEvent(new Event('input', { bubbles: true }));
          }, { name: DOOR_NAME_EDITED, url: DOOR_IMG_URL_EDITED });
        },
      });
    } else {
      record(
        '[D/edit] seeded door-style row available for edit probe',
        'door-style row exists in DB after add flow',
        'add flow did not produce a door-style row to edit',
        false,
      );
    }

    // ── (D) Door style — delete existing row ─────────────────────────────────
    if (doorRow) {
      await page.evaluate(() => window.loadDvDoorStyles && window.loadDvDoorStyles());
      await pollPage(page, (sel) => !!document.querySelector(sel),
        `button[onclick="deleteDvItem('door-style', ${doorRow.id})"]`, 6000);

      await runDeleteFlow('D', {
        type:          'door-style',
        endpoint:      '/api/admin/design-visit-door-styles',
        wrapId:        'dv-door-styles-wrap',
        targetId:      doorRow.id,
        rowMarkerText: DOOR_NAME_EDITED,
        dbProbe: async () => {
          const r = await pool.query(
            `SELECT id FROM design_visit_door_styles WHERE id=$1`,
            [doorRow.id],
          );
          return r.rows[0] || null;
        },
      });
    } else {
      record(
        '[D/del] seeded door-style row available for delete probe',
        'door-style row exists in DB after add flow',
        'add flow did not produce a door-style row to delete',
        false,
      );
    }

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
    '- **(H/F/D) Edit via modal**: for the row each add-flow just created:',
    '  - `openDvItemEditor(type, id)` is called directly so the modal opens',
    '    in edit mode for a known target id.',
    '  - The Save button reads "Save" (not "Add") and the modal pre-fills',
    '    the existing values (`#dvie-name`; plus `#dvie-style` for the',
    '    handle — exercising the dropdown\'s "preserve existing value"',
    '    branch — `#dvie-desc` for furniture, and `#dvie-img` for door',
    '    styles).',
    '  - With the PATCH held open via Puppeteer request interception,',
    '    `#dvie-save.disabled === true` and its label flips to "Saving…".',
    '  - After the response is released, the modal closes, the matching',
    '    catalogue wrap refreshes with the edited values in place — without',
    '    a full page reload (`window.__pageLoadToken` preserved) — and the',
    '    DB row for the same id reflects the edit (`name`, plus `style` /',
    '    `description` / `image_url`).',
    '- **(H/F/D) Delete via row button**: for the row each add/edit flow just',
    '  produced:',
    '  - `window.confirm` is stubbed to return `true` so `deleteDvItem()`',
    '    proceeds past its confirm-prompt branch.',
    '  - The row\'s Delete button (rendered with',
    '    `onclick="deleteDvItem(\'<type>\', <id>)"`) is clicked in-page.',
    '  - A `DELETE` request lands on the matching endpoint',
    '    (`/api/admin/design-visit-handles/:id`, `/...furniture-ranges/:id`,',
    '    `/...door-styles/:id`) and returns a 2xx (response listener).',
    '  - The matching catalogue wrap loses the row in place (row count',
    '    drops, the row\'s name no longer appears in `wrap.textContent`)',
    '    without a full page reload (`window.__pageLoadToken` preserved).',
    '  - The DB row for the deleted id is gone.',
    '- **(H/del) Local image file cleanup**: before the handle delete probe',
    '  runs, a real 1×1 PNG is written to',
    '  `public/uploads/handles/privtest-dvca-<runId>-<id>.png` and the row\'s',
    '  `image_url` is pointed at it. After the DELETE returns, the test',
    '  polls for the file to disappear from disk, proving',
    '  `_deleteLocalHandleImage()` ran server-side.',
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
