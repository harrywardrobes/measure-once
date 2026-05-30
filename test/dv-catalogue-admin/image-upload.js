'use strict';
const { makeSkip } = require('../helpers/report');
// test/dv-catalogue-admin/image-upload.js
//
// End-to-end live test for the Design Visit Handle image-upload flow.
//
// Covers (per task #687):
//   (S) Success path — open the Add Handle modal, fill Name + Style, attach a
//       small PNG to #dvie-img-file, click Save:
//        • POST /api/admin/design-visit-handles creates the handle row.
//        • A follow-up POST /api/admin/dv-handles/:id/image uploads the file.
//        • The modal closes; #dv-handles-wrap re-renders an <img> whose src
//          is the /uploads/handles/... URL returned by the server.
//        • design_visit_handles.image_url in the DB is non-null and matches
//          the URL on the page.
//   (F) Failure path — open the Edit modal for the seeded handle, attach a
//       different PNG, intercept the image POST and force a 500:
//        • The modal stays open (#dvie-save still present in DOM).
//        • The #dvie-err element shows a visible "Image upload failed: …"
//          message.
//        • The DB row's image_url is left at its previous value (no clobber).
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:dv-catalogue-image-upload
//   PRIVTEST_ALLOW_SHARED_DB=1      npm run test:dv-catalogue-image-upload

const fs   = require('fs');
const path = require('path');
const os   = require('os');
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
const RUN_PREFIX = 'privtest-dvca-img';
const HANDLE_NAME  = `${RUN_PREFIX} handle`;
const HANDLE_STYLE = 'Bar';

// Smallest valid PNG: 1×1 transparent pixel.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

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
  console.log(`\n  dv-catalogue-admin image-upload E2E  run=${runId}`);
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

  // Write fixture PNGs to a temp dir we clean up at exit.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `${RUN_PREFIX}-`));
  const pngSuccessPath = path.join(tmpDir, 'success.png');
  const pngFailurePath = path.join(tmpDir, 'failure.png');
  fs.writeFileSync(pngSuccessPath, PNG_1x1);
  fs.writeFileSync(pngFailurePath, PNG_1x1);

  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try {
      await purgeFixtures(pool);
      await cleanupTestData(pool);
    } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
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

  // Wait for the handle table to exist.
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
  await purgeFixtures(pool);

  // ── API pre-check ──────────────────────────────────────────────────────────
  const adminClient = await login(users.admin.email, PASSWORD);
  const handlesPre = await adminClient.get('/api/admin/design-visit-handles');
  record(
    'GET /api/admin/design-visit-handles responds for admin',
    'status=200, JSON array',
    `status=${handlesPre.status} type=${Array.isArray(handlesPre.json) ? 'array' : typeof handlesPre.json}`,
    handlesPre.status === 200 && Array.isArray(handlesPre.json),
  );

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

    const tabReady = await pollPage(
      page,
      () => typeof window.switchTab === 'function' && typeof window.loadDvCatalogue === 'function',
      null, 8000,
    );
    record(
      'admin page exposes switchTab + loadDvCatalogue',
      'both globals available',
      `ready=${!!tabReady}`,
      !!tabReady,
    );
    await page.evaluate(() => {
      window.switchTab('designvisit');
      return window.loadDvCatalogue();
    });
    await pollPage(page, () => {
      const el = document.getElementById('dv-handles-wrap');
      return el && !/Loading…/.test(el.textContent);
    }, null, 10000);

    // ── (S) Success path ─────────────────────────────────────────────────────
    console.log('\n  [S] success: create handle + upload PNG');

    // Open the Add Handle modal.
    const sAddClicked = await page.evaluate(() => {
      const btn = document.querySelector('button[onclick="openDvHandleEditor()"]');
      if (!btn) return false;
      btn.click();
      return true;
    });
    record(
      '[S] click + Add handle opens the modal',
      'modal with #dvie-name + #dvie-img-file appears',
      `clicked=${sAddClicked}`,
      sAddClicked,
    );

    const sModalReady = await pollPage(page, () => {
      return !!document.querySelector('#dvie-name')
        && !!document.querySelector('#dvie-img-file')
        && !!document.querySelector('#dvie-save');
    }, null, 4000);
    record(
      '[S] modal renders #dvie-name + #dvie-img-file + #dvie-save',
      'all three inputs present',
      `ready=${!!sModalReady}`,
      !!sModalReady,
    );

    // Fill name + style.
    await page.evaluate(({ name, style }) => {
      const n = document.querySelector('#dvie-name');
      n.value = name;
      n.dispatchEvent(new Event('input', { bubbles: true }));
      const s = document.querySelector('#dvie-style');
      s.value = style;
      s.dispatchEvent(new Event('change', { bubbles: true }));
    }, { name: HANDLE_NAME, style: HANDLE_STYLE });

    // Attach the PNG via Puppeteer's native file input handle.
    const sFileInput = await page.$('#dvie-img-file');
    await sFileInput.uploadFile(pngSuccessPath);

    // Save.
    await page.evaluate(() => document.querySelector('#dvie-save').click());

    // Wait for the modal to close.
    const sClosed = await pollPage(page, () => !document.querySelector('#dvie-save'), null, 8000);
    record(
      '[S] modal closes after successful save + upload',
      '#dvie-save no longer in DOM',
      `closed=${!!sClosed}`,
      !!sClosed,
    );

    // No full page reload.
    const sSameLoad = await page.evaluate(t => window.__pageLoadToken === t, pageLoadToken);
    record(
      '[S] no full page reload (window.__pageLoadToken preserved)',
      `__pageLoadToken === "${pageLoadToken}"`,
      `preserved=${sSameLoad}`,
      sSameLoad === true,
    );

    // Wait for the new row to render with an /uploads/handles/ <img>.
    const sRowState = await pollPage(page, ({ name }) => {
      const w = document.getElementById('dv-handles-wrap');
      if (!w) return null;
      const rows = Array.from(w.querySelectorAll('tbody tr'));
      const row = rows.find(r => (r.textContent || '').includes(name));
      if (!row) return null;
      const img = row.querySelector('img');
      const src = img ? img.getAttribute('src') : null;
      return { hasRow: true, src };
    }, { name: HANDLE_NAME }, 8000);
    record(
      '[S] new row in #dv-handles-wrap shows uploaded image src=/uploads/handles/...',
      'row contains <img src="/uploads/handles/...">',
      `state=${JSON.stringify(sRowState)}`,
      !!sRowState && !!sRowState.src && /^\/uploads\/handles\//.test(sRowState.src),
    );

    // Confirm the DB row carries the same image_url.
    const dbRow = await pool.query(
      `SELECT id, image_url FROM design_visit_handles WHERE name=$1`,
      [HANDLE_NAME],
    );
    const dbImageUrl = dbRow.rows[0] && dbRow.rows[0].image_url;
    record(
      '[S] design_visit_handles.image_url is non-null in DB',
      'row.image_url starts with "/uploads/handles/"',
      `row=${JSON.stringify(dbRow.rows[0] || null)}`,
      !!dbImageUrl && /^\/uploads\/handles\//.test(dbImageUrl),
    );
    record(
      '[S] DB image_url matches the URL rendered on the page',
      `row.image_url === img.src (${sRowState && sRowState.src})`,
      `db=${dbImageUrl}`,
      !!dbImageUrl && !!sRowState && dbImageUrl === sRowState.src,
    );

    const seededHandleId = dbRow.rows[0] && dbRow.rows[0].id;

    // ── (F) Failure path ─────────────────────────────────────────────────────
    console.log('\n  [F] failure: image POST returns 500, modal stays open');

    if (!seededHandleId) {
      record(
        '[F] precondition: seeded handle exists for failure-path edit',
        'handle id from success-path test',
        `id=${seededHandleId}`,
        false,
      );
    } else {
      // Re-open the same handle in the editor.
      const fEditClicked = await page.evaluate((id) => {
        if (typeof window.openDvItemEditor !== 'function') return false;
        window.openDvItemEditor('handle', id);
        return true;
      }, seededHandleId);
      record(
        '[F] re-open Edit modal for the seeded handle',
        'openDvItemEditor("handle", id) callable',
        `clicked=${fEditClicked}`,
        fEditClicked,
      );

      const fModalReady = await pollPage(page, () => {
        return !!document.querySelector('#dvie-name')
          && !!document.querySelector('#dvie-img-file')
          && !!document.querySelector('#dvie-save')
          && !!document.querySelector('#dvie-err');
      }, null, 4000);
      record(
        '[F] Edit modal renders inputs + #dvie-err',
        'all four elements present',
        `ready=${!!fModalReady}`,
        !!fModalReady,
      );

      // Attach a fresh PNG.
      const fFileInput = await page.$('#dvie-img-file');
      await fFileInput.uploadFile(pngFailurePath);

      // Intercept the image POST and respond with 500.
      await page.setRequestInterception(true);
      const reqListener = async (req) => {
        const u = req.url();
        if (req.method() === 'POST' && /\/api\/admin\/dv-handles\/\d+\/image$/.test(u)) {
          try {
            await req.respond({
              status: 500,
              contentType: 'application/json',
              body: JSON.stringify({ error: 'forced failure for test' }),
            });
          } catch {}
        } else {
          try { await req.continue(); } catch {}
        }
      };
      page.on('request', reqListener);

      // Click Save.
      await page.evaluate(() => document.querySelector('#dvie-save').click());

      // Modal must remain open with the error visible.
      const errState = await pollPage(page, () => {
        const save = document.querySelector('#dvie-save');
        const err  = document.querySelector('#dvie-err');
        if (!save || !err) return null;
        const txt = (err.textContent || '').trim();
        if (!txt) return null;
        return {
          modalOpen: true,
          saveDisabled: save.disabled,
          saveLabel: (save.textContent || '').trim(),
          errText: txt,
        };
      }, null, 8000);
      record(
        '[F] modal stays open after failed image upload (#dvie-save still in DOM)',
        '#dvie-save present, #dvie-err non-empty',
        `state=${JSON.stringify(errState)}`,
        !!errState && errState.modalOpen === true,
      );
      record(
        '[F] visible error message mentions image upload failure',
        '#dvie-err text contains "Image upload failed"',
        `err=${errState && errState.errText}`,
        !!errState && /image upload failed/i.test(errState.errText || ''),
      );
      record(
        '[F] Save button is re-enabled for retry after failure',
        '#dvie-save.disabled === false and label is not "Saving…"',
        `state=${JSON.stringify(errState)}`,
        !!errState && errState.saveDisabled === false && !/Saving/i.test(errState.saveLabel || ''),
      );

      // DB image_url must not have been clobbered.
      const dbRow2 = await pool.query(
        `SELECT image_url FROM design_visit_handles WHERE id=$1`,
        [seededHandleId],
      );
      const dbImageUrl2 = dbRow2.rows[0] && dbRow2.rows[0].image_url;
      record(
        '[F] DB image_url is preserved (not overwritten) on failed upload',
        `image_url === "${dbImageUrl}"`,
        `db=${dbImageUrl2}`,
        dbImageUrl2 === dbImageUrl,
      );

      page.off('request', reqListener);
      await page.setRequestInterception(false).catch(() => {});
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
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Design Visit Catalogue Admin — Handle Image Upload E2E',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:dv-catalogue-image-upload\``,
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
    '- **(S) Success path**: open the "+ Add handle" modal, attach a 1×1 PNG to',
    '  `#dvie-img-file`, save. The modal closes without a full page reload,',
    '  `#dv-handles-wrap` re-renders an `<img>` whose `src` starts with',
    '  `/uploads/handles/`, and `design_visit_handles.image_url` is non-null',
    '  and equal to the rendered URL.',
    '- **(F) Failure path**: re-open the same handle in the Edit modal, attach',
    '  a different PNG, intercept `POST /api/admin/dv-handles/:id/image` and',
    '  force a 500. The modal stays open, `#dvie-err` shows an "Image upload',
    '  failed" message, `#dvie-save` is re-enabled for retry, and the DB',
    '  `image_url` is preserved (not overwritten).',
    '',
    '## Notes',
    '',
    '- Fixtures use the `privtest-dvca-img` name prefix and are purged in',
    '  `cleanupAndExit()` (including on signal / crash). Temp PNGs are written',
    '  to `os.tmpdir()` and removed at exit.',
  ];
  const outPath = path.join(dir, 'dv-catalogue-image-upload.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Report: test-results/dv-catalogue-image-upload.md`);
}

main();
