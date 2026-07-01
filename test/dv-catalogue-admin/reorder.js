'use strict';
const { makeSkip } = require('../helpers/report');
// test/dv-catalogue-admin/reorder.js
//
// End-to-end live test for the catalogue up/down arrow reorder controls
// (Handles, Furniture Ranges, Door Styles).  Boots a disposable server with
// the privileges harness, drives the UI with Puppeteer, writes a markdown
// report to test-results/dv-catalogue-reorder.md.
//
// Covers:
//   For each catalogue type:
//     • Seeds two rows directly in the DB with known sort_order values
//       (top=0, bottom=1) under a fixture name prefix.
//     • Loads the Design Visit tab + catalogue and asserts the wrap
//       initially renders the two rows in seeded order.
//     • Asserts boundary disable-states pre-swap: top row's ▲ is
//       disabled, bottom row's ▼ is disabled, top row's ▼ + bottom
//       row's ▲ are enabled.
//     • Clicks ▼ on the top row, waits for the in-place re-render, and
//       asserts:
//        - window.__pageLoadToken is preserved (no full page reload).
//        - The wrap's tbody rows are now in the swapped DOM order.
//        - Boundary disable-states are flipped: the new top row's ▲
//          is disabled and the new bottom row's ▼ is disabled.
//        - The two DB rows' sort_order values are swapped.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:dv-catalogue-reorder
//   PRIVTEST_ALLOW_SHARED_DB=1      npm run test:dv-catalogue-reorder

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
const RUN_PREFIX = 'privtest-dvca-ro';

// Per-type fixture spec.  Each test seeds two rows: ${prefix} A / B with
// sort_order 0 / 1 respectively.
const TYPES = [
  {
    label:     'handle',
    type:      'handle',
    table:     'design_visit_handles',
    wrapId:    'dv-handles-wrap',
    insertSql: `INSERT INTO design_visit_handles (name, style, sort_order)
                VALUES ($1, $2, $3) RETURNING id`,
    insertArgs: (name, order) => [name, 'Bar', order],
  },
  {
    label:     'furniture',
    type:      'furniture',
    table:     'design_visit_furniture_ranges',
    wrapId:    'dv-furniture-wrap',
    insertSql: `INSERT INTO design_visit_furniture_ranges (name, description, sort_order)
                VALUES ($1, $2, $3) RETURNING id`,
    insertArgs: (name, order) => [name, `${name} desc`, order],
  },
  {
    label:     'door-style',
    type:      'door-style',
    table:     'design_visit_door_styles',
    wrapId:    'dv-door-styles-wrap',
    insertSql: `INSERT INTO design_visit_door_styles (name, image_url, sort_order)
                VALUES ($1, $2, $3) RETURNING id`,
    insertArgs: (name, order) =>
      [name, `https://example.invalid/${encodeURIComponent(name)}.png`, order],
  },
];

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
  for (const t of TYPES) {
    await pool.query(`DELETE FROM ${t.table} WHERE name LIKE $1`, [`${RUN_PREFIX}%`]);
  }
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
  console.log(`\n  dv-catalogue-reorder E2E  run=${runId}`);
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
  for (const t of TYPES) await waitForTable(t.table);

  await purgeFixtures(pool);

  // Seed two rows per type with sort_order 0 (A=top) and 1 (B=bottom).
  const seeded = {};
  for (const t of TYPES) {
    const aName = `${RUN_PREFIX} ${t.label} A`;
    const bName = `${RUN_PREFIX} ${t.label} B`;
    const aRow = await pool.query(t.insertSql, t.insertArgs(aName, 0));
    const bRow = await pool.query(t.insertSql, t.insertArgs(bName, 1));
    seeded[t.type] = {
      a: { id: aRow.rows[0].id, name: aName },
      b: { id: bRow.rows[0].id, name: bName },
    };
  }

  const adminClient = await login(users.admin.email, PASSWORD);

  if (!puppeteer) {
    skip('puppeteer is installed', 'puppeteer required', 'module not found');
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

  try {
    const page = await browser.newPage();
    await page.setCacheEnabled(false);
    await injectSession(page, adminClient.cookie);

    await page.goto(`${BASE}/admin`, { waitUntil: 'load', timeout: 25000 });
    await page.evaluate(() => { window.__pageLoadToken = Math.random().toString(36).slice(2); });
    const pageLoadToken = await page.evaluate(() => window.__pageLoadToken);

    const ready = await pollPage(
      page,
      () => typeof window.switchTab === 'function'
         && typeof window.loadDvCatalogue === 'function'
         && typeof window.moveDvItem === 'function',
      null, 8000,
    );
    record(
      'admin page exposes switchTab + loadDvCatalogue + moveDvItem',
      'all three globals available',
      `ready=${!!ready}`,
      !!ready,
    );

    await page.evaluate(() => {
      window.switchTab('designvisit');
      return window.loadDvCatalogue();
    });

    // Wait for all three wraps to load (replace "Loading…").
    const loaded = await pollPage(page, () => {
      return ['dv-handles-wrap', 'dv-furniture-wrap', 'dv-door-styles-wrap'].every(id => {
        const el = document.getElementById(id);
        return el && !/Loading…/.test(el.textContent);
      });
    }, null, 10000);
    record(
      'design-visit catalogue lists load (no "Loading…")',
      'all three wraps replaced their Loading placeholders',
      `ready=${!!loaded}`,
      !!loaded,
    );

    // Snapshot of a wrap's rows in DOM order plus per-row arrow disabled states.
    async function snapshotWrap(wrapId) {
      return page.evaluate((id) => {
        const w = document.getElementById(id);
        if (!w) return null;
        const trs = Array.from(w.querySelectorAll('tbody tr[data-id]'));
        return trs.map(tr => {
          const up   = tr.querySelector('button[onclick*=", \'up\')"]');
          const down = tr.querySelector('button[onclick*=", \'down\')"]');
          return {
            id:           Number(tr.dataset.id),
            text:         tr.textContent.replace(/\s+/g, ' ').trim(),
            upDisabled:   up ? up.disabled : null,
            downDisabled: down ? down.disabled : null,
          };
        });
      }, wrapId);
    }

    for (const t of TYPES) {
      const fix = seeded[t.type];
      console.log(`\n  [${t.label}] reorder via ▼ on top row id=${fix.a.id}`);

      const pre = await snapshotWrap(t.wrapId);
      const preIds = (pre || []).map(r => r.id);
      const preAIdx = preIds.indexOf(fix.a.id);
      const preBIdx = preIds.indexOf(fix.b.id);
      record(
        `[${t.label}] wrap initially renders seeded rows in order A then B`,
        `A(id=${fix.a.id}) at index ${preIds.length - 2}, B(id=${fix.b.id}) at index ${preIds.length - 1}`,
        `aIdx=${preAIdx} bIdx=${preBIdx} ids=${JSON.stringify(preIds)}`,
        preAIdx >= 0 && preBIdx === preAIdx + 1,
      );

      const topRow    = pre && pre[preAIdx];
      const bottomRow = pre && pre[preBIdx];
      record(
        `[${t.label}] pre-swap: top row's ▲ disabled, top row's ▼ enabled`,
        'upDisabled === true && downDisabled === false on top row',
        `top=${JSON.stringify(topRow)}`,
        !!topRow && topRow.upDisabled === true && topRow.downDisabled === false,
      );
      record(
        `[${t.label}] pre-swap: bottom row's ▼ disabled, bottom row's ▲ enabled`,
        'downDisabled === true && upDisabled === false on bottom row',
        `bottom=${JSON.stringify(bottomRow)}`,
        !!bottomRow && bottomRow.downDisabled === true && bottomRow.upDisabled === false,
      );

      // Click ▼ on the top row.  Click the actual rendered button so we
      // exercise the wired-up onclick handler end-to-end.
      const clicked = await page.evaluate((args) => {
        const w = document.getElementById(args.wrapId);
        if (!w) return false;
        const tr = w.querySelector(`tbody tr[data-id="${args.id}"]`);
        if (!tr) return false;
        const btn = tr.querySelector('button[onclick*=", \'down\')"]');
        if (!btn || btn.disabled) return false;
        btn.click();
        return true;
      }, { wrapId: t.wrapId, id: fix.a.id });
      record(
        `[${t.label}] click ▼ on top row dispatches moveDvItem(..., 'down')`,
        'rendered ▼ button is present, enabled, and clickable',
        `clicked=${clicked}`,
        clicked === true,
      );

      // Wait for the in-place re-render: A now sits after B.
      const swappedSnap = await pollPage(page, (args) => {
        const w = document.getElementById(args.wrapId);
        if (!w) return null;
        const ids = Array.from(w.querySelectorAll('tbody tr[data-id]'))
          .map(r => Number(r.dataset.id));
        const aIdx = ids.indexOf(args.aId);
        const bIdx = ids.indexOf(args.bId);
        if (aIdx < 0 || bIdx < 0) return null;
        return (bIdx < aIdx) ? { ids, aIdx, bIdx } : null;
      }, { wrapId: t.wrapId, aId: fix.a.id, bId: fix.b.id }, 6000);
      record(
        `[${t.label}] after click, A and B swap DOM order in #${t.wrapId}`,
        `B(id=${fix.b.id}) appears before A(id=${fix.a.id}) in tbody`,
        `state=${JSON.stringify(swappedSnap)}`,
        !!swappedSnap,
      );

      const stillSameLoad = await page.evaluate(t => window.__pageLoadToken === t, pageLoadToken);
      record(
        `[${t.label}] no full page reload during reorder (window.__pageLoadToken preserved)`,
        `__pageLoadToken === "${pageLoadToken}"`,
        `preserved=${stillSameLoad}`,
        stillSameLoad === true,
      );

      // Post-swap snapshot: assert boundary disable-states flipped.
      const post = await snapshotWrap(t.wrapId);
      const postIds = (post || []).map(r => r.id);
      const newTop    = post && post.find(r => r.id === fix.b.id);
      const newBottom = post && post.find(r => r.id === fix.a.id);
      const topIsFirst = postIds.indexOf(fix.b.id) === Math.max(0, postIds.length - 2);
      const bottomIsLast = postIds.indexOf(fix.a.id) === postIds.length - 1;
      record(
        `[${t.label}] post-swap: B is now the top row, A is now the bottom row`,
        `B at index ${postIds.length - 2}, A at index ${postIds.length - 1}`,
        `ids=${JSON.stringify(postIds)} topIsB=${topIsFirst} bottomIsA=${bottomIsLast}`,
        topIsFirst && bottomIsLast,
      );
      record(
        `[${t.label}] post-swap: new top row's ▲ disabled, ▼ enabled`,
        'upDisabled === true && downDisabled === false on new top row (B)',
        `newTop=${JSON.stringify(newTop)}`,
        !!newTop && newTop.upDisabled === true && newTop.downDisabled === false,
      );
      record(
        `[${t.label}] post-swap: new bottom row's ▼ disabled, ▲ enabled`,
        'downDisabled === true && upDisabled === false on new bottom row (A)',
        `newBottom=${JSON.stringify(newBottom)}`,
        !!newBottom && newBottom.downDisabled === true && newBottom.upDisabled === false,
      );

      // DB-level assertion: the two rows' sort_order values are swapped.
      const dbRows = await pool.query(
        `SELECT id, sort_order FROM ${t.table} WHERE id = ANY($1::int[])`,
        [[fix.a.id, fix.b.id]],
      );
      const byId = Object.fromEntries(dbRows.rows.map(r => [r.id, r.sort_order]));
      record(
        `[${t.label}] DB sort_order values swapped (A was 0/B was 1 → A=1, B=0)`,
        `A.sort_order === 1 && B.sort_order === 0`,
        `A=${byId[fix.a.id]} B=${byId[fix.b.id]}`,
        byId[fix.a.id] === 1 && byId[fix.b.id] === 0,
      );
    }

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
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Design Visit Catalogue — Up/Down Reorder — E2E Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:dv-catalogue-reorder\``,
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
    '- For each catalogue type (handle / furniture / door-style):',
    '  - Two rows are seeded directly in the DB with sort_order 0 (A) and',
    '    1 (B), under the `privtest-dvca-ro` fixture prefix.',
    '  - The admin Design Visit tab is opened and `loadDvCatalogue()` is',
    '    awaited; the wrap renders A then B in seeded order.',
    '  - Pre-swap, the top row\'s ▲ button is disabled and its ▼ is',
    '    enabled; the bottom row\'s ▼ is disabled and its ▲ is enabled.',
    '  - The actual rendered ▼ button on the top row is clicked (so the',
    '    `onclick="moveDvItem(...)"` binding is exercised end-to-end).',
    '  - After the two PATCHes resolve, the wrap re-renders in place with',
    '    A and B swapped, `window.__pageLoadToken` is preserved (no full',
    '    page reload), and the new top/bottom disable states are flipped.',
    '  - The DB rows for A/B now hold sort_order 1 and 0 respectively.',
    '',
    '## Notes',
    '',
    '- Fixtures use the `privtest-dvca-ro` name prefix and are purged in',
    '  `cleanupAndExit()` (including on signal / crash). The harness strips',
    '  `HUBSPOT_TOKEN` / `SMTP_*` / OAuth credentials; the catalogue',
    '  endpoints are PostgreSQL-only, so no third-party access is needed.',
  ];
  const outPath = path.join(dir, 'dv-catalogue-reorder.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Report: test-results/dv-catalogue-reorder.md`);
}

main();
