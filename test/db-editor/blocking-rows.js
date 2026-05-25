'use strict';
// test/db-editor/blocking-rows.js
//
// End-to-end live test for task #703's "blocking rows on FK-violation delete"
// preview in the admin database editor. Mirrors the pattern in
// test/db-editor/run.js and test/card-action-handlers/run.js: boot a disposable
// server via the privileges harness, exercise both the API and the UI flow
// against an allow-listed table pair, write a markdown report to
// test-results/db-editor-blocking-rows.md, and exit non-zero on any probe
// failure.
//
// Covers (per task #723):
//   (a) DELETE /api/admin/db/lead_status_config/rows/:pk for a row that is
//       referenced by lead_substatuses returns 409 with a `blockingSample`
//       array whose entry exposes table, refCols, targetCols, total and a
//       non-empty `rows` array with usable pk/label hints.
//   (b) GET /api/admin/db/:table/rows accepts ?fcol=…&fval=… (single +
//       composite) and silently drops unknown columns (no SQL injection,
//       no filter applied), surfacing the active filters in the response.
//   (c) Puppeteer smoke: open the delete drawer for the blocked row, assert
//       the in-drawer blocking section renders the referencing table, click
//       "Open in editor", and assert lead_substatuses loads with a filter
//       pill applied (status_key = …).
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:db-editor-blocking-rows
//   # or against the shared DB with the privtest- prefix cleanup:
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:db-editor-blocking-rows

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

// ── fixtures ──────────────────────────────────────────────────────────────────
// Both tables are on the db-editor allow-list. lead_substatuses has a real
// `lead_substatuses_status_key_fk` FK constraint installed by server boot
// (see ensureLeadSubstatusesTable in server.js, task #739), so the seeded
// status row genuinely cannot be deleted while substatuses reference it —
// this faithfully exercises the 23503 still-referenced branch +
// findBlockingRows without the test installing its own FK.
const STATUS_KEY     = 'privtest_blocks';     // lead_status_config.key (also lead_substatuses.status_key)
const STATUS_LABEL   = 'PrivTest blocked status';
const SUB_KEY        = 'privtest_sub_a';
const SUB_LABEL      = 'PrivTest blocking substatus';
const SUB_KEY_B      = 'privtest_sub_b';
const SUB_LABEL_B    = 'PrivTest second substatus';

// ── helpers ───────────────────────────────────────────────────────────────────
async function purgeFixtures(pool) {
  try {
    await pool.query(
      `DELETE FROM lead_substatuses WHERE status_key = $1`,
      [STATUS_KEY]
    );
  } catch (_) {}
  try {
    await pool.query(
      `DELETE FROM lead_status_config WHERE key = $1`,
      [STATUS_KEY]
    );
  } catch (_) {}
  try {
    await pool.query(
      `DELETE FROM db_editor_audit
         WHERE table_name IN ('lead_status_config','lead_substatuses')
           AND (after_data->>'key' = $1
                OR before_data->>'key' = $1
                OR after_data->>'status_key' = $1
                OR before_data->>'status_key' = $1)`,
      [STATUS_KEY]
    );
  } catch (_) {}
}

async function waitForTable(pool, name, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await pool.query(`SELECT to_regclass($1) AS t`, [name]);
    if (r.rows[0].t) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for table ${name}`);
}

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

async function pollPage(page, fn, arg, timeoutMs = 6000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const got = await page.evaluate(fn, arg);
    if (got) return got;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

// ── main ──────────────────────────────────────────────────────────────────────
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
  console.log(`\n  db-editor blocking-rows E2E  run=${runId}`);
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

  let browser = null;
  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (browser) await browser.close(); } catch {}
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

  // ── boot test server ───────────────────────────────────────────────────────
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

  await waitForTable(pool, 'lead_status_config');
  await waitForTable(pool, 'lead_substatuses');
  await purgeFixtures(pool);

  // Seed fixtures: one lead_status_config row + two substatuses referencing it,
  // then install a real FK so DELETE of the status row produces 23503.
  await pool.query(
    `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales)
       VALUES ($1, $2, 999, FALSE)`,
    [STATUS_KEY, STATUS_LABEL]
  );
  await pool.query(
    `INSERT INTO lead_substatuses (status_key, substatus_key, label, sort_order)
       VALUES ($1, $2, $3, 1), ($1, $4, $5, 2)`,
    [STATUS_KEY, SUB_KEY, SUB_LABEL, SUB_KEY_B, SUB_LABEL_B]
  );
  // The lead_substatuses.status_key → lead_status_config(key) FK is installed
  // permanently by server boot (task #739), so no test-scoped ALTER is needed.

  const adminClient = await login(users.admin.email, PASSWORD);

  // ─────────────────────────────────────────────────────────────────────────
  // (a) DELETE on a referenced row → 409 + blockingSample
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n  [a] DELETE on FK-referenced row returns 409 + blockingSample');

  const delRes = await adminClient.delete(
    `/api/admin/db/lead_status_config/rows/${encodeURIComponent(STATUS_KEY)}`,
    { headers: { 'X-Confirm-Pk': STATUS_KEY } },
  );
  record(
    'DELETE lead_status_config returns 409 still_referenced',
    'status=409 kind=still_referenced',
    `status=${delRes.status} kind=${delRes.json?.kind}`,
    delRes.status === 409 && delRes.json?.kind === 'still_referenced',
  );

  const sample = Array.isArray(delRes.json?.blockingSample) ? delRes.json.blockingSample : [];
  const entry  = sample.find(s => s && s.table === 'lead_substatuses');
  record(
    'blockingSample contains a lead_substatuses entry',
    'an entry with table="lead_substatuses"',
    `sample.length=${sample.length} entries=${sample.map(s => s && s.table).join(',')}`,
    !!entry,
  );

  if (entry) {
    const refOk    = Array.isArray(entry.refCols)    && entry.refCols.join(',')    === 'status_key';
    const targetOk = Array.isArray(entry.targetCols) && entry.targetCols.join(',') === 'key';
    const totalOk  = entry.total === 2;
    const rowsOk   = Array.isArray(entry.rows) && entry.rows.length === 2;
    const allowed  = entry.allowed === true;
    const pkOk     = rowsOk && entry.rows.every(r => r.pk && /^\d+$/.test(String(r.pk)));
    const labelOk  = rowsOk && entry.rows.some(r => r.label === SUB_LABEL)
                            && entry.rows.some(r => r.label === SUB_LABEL_B);
    record(
      'blockingSample entry has refCols=[status_key], targetCols=[key]',
      'refCols=status_key targetCols=key',
      `refCols=${(entry.refCols || []).join(',')} targetCols=${(entry.targetCols || []).join(',')}`,
      refOk && targetOk,
    );
    record(
      'blockingSample entry reports total=2 with a 2-row sample',
      'total=2 rows.length=2',
      `total=${entry.total} rows.length=${(entry.rows || []).length}`,
      totalOk && rowsOk,
    );
    record(
      'blockingSample entry is marked allowed (referencing table is on the allow-list)',
      'allowed=true',
      `allowed=${entry.allowed}`,
      allowed,
    );
    record(
      'blockingSample rows expose a usable pk + label hint',
      'every row has numeric pk; labels match seeded substatuses',
      `pkOk=${pkOk} labelOk=${labelOk} rows=${JSON.stringify((entry.rows || []).map(r => ({ pk: r.pk, label: r.label })))}`,
      pkOk && labelOk,
    );
  }

  // The row must still exist after the failed delete.
  {
    const r = await pool.query(
      `SELECT 1 FROM lead_status_config WHERE key = $1`,
      [STATUS_KEY]
    );
    record(
      'failed FK-blocked delete does not remove the row',
      'row still present',
      `present=${r.rowCount === 1}`,
      r.rowCount === 1,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // (b) fcol / fval exact-match filter on /rows
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n  [b] GET /:table/rows fcol/fval exact-match filter');

  {
    const r = await adminClient.get(
      `/api/admin/db/lead_substatuses/rows?fcol=status_key&fval=${encodeURIComponent(STATUS_KEY)}&pageSize=200`
    );
    const rows = Array.isArray(r.json?.rows) ? r.json.rows : [];
    const af   = Array.isArray(r.json?.activeFilters) ? r.json.activeFilters : [];
    const onlyOurs = rows.length === 2 && rows.every(x => x.status_key === STATUS_KEY);
    const filterOk = af.length === 1 && af[0].column === 'status_key' && af[0].value === STATUS_KEY;
    record(
      'single fcol/fval filter returns only matching rows',
      'status=200 rows=2 (both with our status_key) activeFilters=[status_key]',
      `status=${r.status} rows=${rows.length} af=${JSON.stringify(af)}`,
      r.status === 200 && onlyOurs && filterOk,
    );
  }

  {
    const params = new URLSearchParams();
    params.append('fcol', 'status_key');    params.append('fval', STATUS_KEY);
    params.append('fcol', 'substatus_key'); params.append('fval', SUB_KEY);
    params.append('pageSize', '200');
    const r = await adminClient.get(
      `/api/admin/db/lead_substatuses/rows?${params}`
    );
    const rows = Array.isArray(r.json?.rows) ? r.json.rows : [];
    const af   = Array.isArray(r.json?.activeFilters) ? r.json.activeFilters : [];
    const cols = af.map(x => x.column).sort().join(',');
    const oneRow = rows.length === 1
      && rows[0].status_key === STATUS_KEY
      && rows[0].substatus_key === SUB_KEY;
    record(
      'composite fcol/fval (status_key + substatus_key) narrows to one row',
      'status=200 rows=1 activeFilters=[status_key,substatus_key]',
      `status=${r.status} rows=${rows.length} af.cols=${cols}`,
      r.status === 200 && oneRow && cols === 'status_key,substatus_key',
    );
  }

  {
    // Unknown column must be silently dropped (no SQL injection, no filter).
    // Pair it with our real filter so we can verify activeFilters reports
    // only the legitimate one.
    const params = new URLSearchParams();
    params.append('fcol', 'no_such_col');  params.append('fval', 'anything');
    params.append('fcol', 'status_key');   params.append('fval', STATUS_KEY);
    params.append('pageSize', '200');
    const r = await adminClient.get(
      `/api/admin/db/lead_substatuses/rows?${params}`
    );
    const af = Array.isArray(r.json?.activeFilters) ? r.json.activeFilters : [];
    const rows = Array.isArray(r.json?.rows) ? r.json.rows : [];
    const onlyStatusKey = af.length === 1 && af[0].column === 'status_key';
    record(
      'unknown fcol is silently dropped (no SQL error, not surfaced in activeFilters)',
      'status=200 activeFilters=[status_key only] rows=2 (still scoped by status_key)',
      `status=${r.status} af=${JSON.stringify(af)} rows=${rows.length}`,
      r.status === 200 && onlyStatusKey && rows.length === 2,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // (c) Puppeteer smoke: delete drawer renders the blocking section and
  //     "Open in editor" deep-links to lead_substatuses with a filter pill.
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n  [c] UI smoke: blocking section + "Open in editor" deep-link');

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

  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      defaultViewport: { width: 1280, height: 800 },
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
    page.on('pageerror', err => console.log('   [pageerror]', err.message));
    await injectSession(page, adminClient.cookie);
    await page.goto(`${BASE}/admin/database`, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Wait for the table sidebar to populate.
    const sidebarOk = await pollPage(
      page,
      () => !!document.querySelector('#db-table-list button[data-table="lead_status_config"]'),
      null,
      8000,
    );
    record(
      'GET /admin/database renders the table sidebar incl. lead_status_config',
      'sidebar contains <button data-table="lead_status_config">',
      `present=${!!sidebarOk}`,
      !!sidebarOk,
    );

    // Click into lead_status_config and wait for the grid.
    await page.evaluate(() => {
      document.querySelector('#db-table-list button[data-table="lead_status_config"]').click();
    });
    const gridReady = await pollPage(
      page,
      (k) => {
        const rows = Array.from(document.querySelectorAll('#db-main tr[data-pk]'));
        return rows.some(r => r.getAttribute('data-pk') === k) ? true : null;
      },
      STATUS_KEY,
      8000,
    );
    record(
      'lead_status_config grid loads with our fixture row',
      `<tr data-pk="${STATUS_KEY}"> present`,
      `present=${!!gridReady}`,
      !!gridReady,
    );

    // Open the delete drawer for the fixture row.
    await page.evaluate((k) => {
      const tr = document.querySelector(`#db-main tr[data-pk="${k}"]`);
      tr.querySelector('button[data-act="del"]').click();
    }, STATUS_KEY);
    const drawerOpen = await pollPage(
      page,
      () => !!document.querySelector('#db-drawer #del-confirm') && !!document.querySelector('#db-drawer #del-go'),
      null,
      4000,
    );
    record(
      'delete drawer opens with confirm input + Delete row button',
      '#del-confirm and #del-go present',
      `open=${!!drawerOpen}`,
      !!drawerOpen,
    );

    // Type the PK to enable the button, then submit. The server replies with
    // a 409 — the drawer's onerror handler appends the #del-blocking preview.
    await page.evaluate((k) => {
      const input = document.getElementById('del-confirm');
      input.value = k;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, STATUS_KEY);
    await page.evaluate(() => document.getElementById('del-go').click());

    const blockingInfo = await pollPage(
      page,
      () => {
        const wrap = document.getElementById('del-blocking');
        if (!wrap) return null;
        const openBtn = wrap.querySelector('.del-blocking-open');
        const viewAll = wrap.querySelector('.del-blocking-viewall');
        return {
          hasWrap:   true,
          mentionsSub: /lead_substatuses/.test(wrap.textContent || ''),
          openCount: wrap.querySelectorAll('.del-blocking-open').length,
          hasViewAll: !!viewAll,
          openBtnOk: !!openBtn,
        };
      },
      null,
      6000,
    );
    record(
      'delete drawer appends #del-blocking with the lead_substatuses section',
      '#del-blocking present, mentions lead_substatuses, has Open-in-editor buttons',
      `info=${JSON.stringify(blockingInfo)}`,
      !!blockingInfo
        && blockingInfo.hasWrap
        && blockingInfo.mentionsSub
        && blockingInfo.openCount === 2
        && blockingInfo.openBtnOk,
    );

    // Click the first "Open in editor" → drawer should close, lead_substatuses
    // should load, and a filter pill should appear scoping to status_key=PK.
    if (blockingInfo && blockingInfo.openBtnOk) {
      await page.evaluate(() => {
        document.querySelector('#del-blocking .del-blocking-open').click();
      });
      const filterPillOk = await pollPage(
        page,
        (k) => {
          const title = document.querySelector('.db-main-title');
          if (!title || !/lead_substatuses/.test(title.textContent || '')) return null;
          const pill = document.querySelector('.db-filter-pill');
          if (!pill) return null;
          const text = pill.textContent || '';
          return text.includes('status_key') && text.includes(k) ? text.trim().replace(/\s+/g, ' ') : null;
        },
        STATUS_KEY,
        8000,
      );
      record(
        'Open-in-editor deep-link loads lead_substatuses with a status_key filter pill',
        `title="lead_substatuses" and filter pill "status_key = ${STATUS_KEY}"`,
        `pill=${JSON.stringify(filterPillOk)}`,
        typeof filterPillOk === 'string' && filterPillOk.includes(STATUS_KEY),
      );

      // Grid should be narrowed to exactly our 2 fixture rows.
      const rowCount = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#db-main tr[data-pk]'));
        return rows.length;
      });
      record(
        'deep-linked grid shows only the rows that were blocking the delete',
        '2 data rows in #db-main',
        `rows=${rowCount}`,
        rowCount === 2,
      );
    }
  } catch (e) {
    record('UI smoke flow', 'no exceptions', `error: ${e.message}`, false, e.stack);
  }

  // ── summary & report ──────────────────────────────────────────────────────
  const pass = findings.filter(f => f.ok).length;
  const fail = findings.filter(f => !f.ok).length;
  console.log(`\n  Results: ${pass} passed, ${fail} failed`);

  await writeReport(runId, findings);
  await cleanupAndExit(fail > 0 ? 1 : 0);
}

// ── report writer ─────────────────────────────────────────────────────────────
async function writeReport(runId, findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Admin Database Editor — Blocking Rows Preview E2E Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:db-editor-blocking-rows\``,
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
    '- **(a) Server-side blocking sample**: a real FK constraint is installed',
    '  between `lead_substatuses.status_key` and `lead_status_config.key` for',
    '  the duration of the run; DELETE of the referenced status row returns',
    '  409 with `kind="still_referenced"` and a `blockingSample` array whose',
    '  entry exposes `table`, `refCols=[status_key]`, `targetCols=[key]`,',
    '  `total`, `allowed=true`, and a non-empty `rows` array carrying usable',
    '  pk + label hints. The row also remains present after the failed delete.',
    '- **(b) fcol/fval query params**: a single filter narrows the row set and',
    '  surfaces `activeFilters`; a composite (status_key + substatus_key)',
    '  filter narrows further; unknown columns are silently dropped (no SQL',
    '  error, not surfaced in `activeFilters`), so the "Open in editor"',
    '  deep-link is safe even if the referencing schema changes.',
    '- **(c) UI smoke (Puppeteer)**: an authenticated admin opens the delete',
    '  drawer for the blocked row, sees `#del-blocking` with a',
    '  `lead_substatuses` section and per-row Open-in-editor buttons, clicks',
    '  the first one, and the editor switches to `lead_substatuses` with a',
    '  `status_key = …` filter pill applied and the grid narrowed to the',
    '  2 blocking rows.',
    '',
  ];
  const out = path.join(dir, 'db-editor-blocking-rows.md');
  fs.writeFileSync(out, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), out)}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(2);
});
