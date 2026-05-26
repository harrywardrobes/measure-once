'use strict';
// test/sales-board-bootstrap/run.js
//
// End-to-end Puppeteer regression guard for the sales board stuck-skeleton bug.
//
// Task #1099 fixed a race condition where bootstrap() on /sales fails and
// dispatches 'sales-board-bootstrap-failed' BEFORE the React.lazy
// SalesBoardPage chunk finishes loading.  The React component missed the event
// and left the inline skeleton visible forever (the stuck-skeleton bug).
//
// The fix: SalesBoardPage reads `window.__salesBoardBootstrapFailed`
// synchronously as the `useState` initial value so a late-mounting component
// always detects a prior failure at mount time.
//
// Covers:
//   (H) Window-flag / late-mount path — hold the SalesBoardPage chunk while
//       bootstrap fails (natural 503 from no HUBSPOT_TOKEN); release the chunk;
//       React mounts and reads the window flag synchronously; error state
//       (not skeleton) is visible.
//   (L) Event-listener / early-mount path — let React mount normally (API
//       calls return empty-but-valid data); simulate a bootstrap failure by
//       setting the window flag and dispatching the event; React's listener
//       fires; error state replaces the board.
//
// Both probes assert:
//   • "HubSpot is currently unavailable" heading present in #sales-board-mount
//   • "Reload page" button present in #sales-board-mount
//   • The skeleton HTML injected by sales.html is gone (no .skeleton-pill)
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:sales-board-bootstrap
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:sales-board-bootstrap

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
  await page.setCookie({ name: kv.name, value: kv.value, domain: hostname, path: '/', httpOnly: true });
}

function findChromium() {
  const { findChromium: shared } = require('../shared/find-chromium');
  return shared() || undefined;
}

// Poll a predicate (run in page context) until it returns truthy or timeout.
async function pollPage(page, fn, arg, timeoutMs = 12000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch {}
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

// Wait for #sales-board-mount to show the bootstrap-failed error state.
// Polls for "HubSpot is currently unavailable" text inside the mount point.
async function waitForErrorState(page, timeoutMs = 20000) {
  return pollPage(page, () => {
    const mount = document.getElementById('sales-board-mount');
    if (!mount) return false;
    return (mount.innerText || mount.textContent || '').includes('HubSpot is currently unavailable');
  }, null, timeoutMs);
}

// Wait for window.__salesBoardBootstrapFailed to be set by core.js, which
// happens when bootstrap() throws on the sales page.
async function waitForWindowFlag(page, timeoutMs = 12000) {
  return pollPage(page, () => !!(window.__salesBoardBootstrapFailed), null, timeoutMs);
}

// Collect the observable error-state properties from #sales-board-mount.
async function inspectErrorState(page) {
  return page.evaluate(() => {
    const mount = document.getElementById('sales-board-mount');
    if (!mount) return { error: 'no #sales-board-mount' };
    const text = mount.innerText || mount.textContent || '';
    const buttons = Array.from(mount.querySelectorAll('button'));
    return {
      hasHeading:    text.includes('HubSpot is currently unavailable'),
      hasReloadBtn:  buttons.some(b => (b.textContent || '').toLowerCase().includes('reload')),
      hasSkeletonPill: !!mount.querySelector('.skeleton-pill'),
    };
  });
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

  const bundlePath = path.resolve(__dirname, '..', '..', 'public', 'react', 'main.js');
  if (!fs.existsSync(bundlePath)) {
    console.error(
      '\n  ✘ public/react/main.js is missing.\n'
      + '    Run `npm run build:react` before this test.\n',
    );
    process.exit(2);
  }

  const runId = `sbboot-${Date.now().toString(36)}`;
  console.log(`\n  sales-board-bootstrap E2E  run=${runId}`);
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
    const mark = ok ? '  \u2713' : '  \u2717';
    console.log(`${mark}  ${name}`);
    if (!ok) {
      console.log(`     expected : ${expected}`);
      console.log(`     observed : ${observed}`);
      if (detail) console.log(`     detail   : ${detail}`);
    }
  }

  let teardownInFlight = false;
  async function cleanupAndExit(code) {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    process.exit(code);
  }

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
    record('puppeteer available', 'module installed', 'not installed', false,
      'Install puppeteer: npm i -D puppeteer');
    await writeReport(findings);
    await cleanupAndExit(1);
    return;
  }

  const adminClient = await login(users.admin.email, PASSWORD);
  const executablePath = findChromium();

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      defaultViewport: { width: 1280, height: 900 },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  } catch (e) {
    record('browser launch', 'launched successfully', `error: ${e.message}`, false, e.stack || '');
    await writeReport(findings);
    await cleanupAndExit(1);
    return;
  }

  try {

    // ── (H) Window-flag / late-mount path ─────────────────────────────────────
    //
    // Scenario: bootstrap() fails and fires the window flag + event BEFORE the
    // React lazy chunk finishes loading.  The chunk is held via request
    // interception to ensure this ordering.  After the flag is confirmed set,
    // the chunk is released.  React mounts and must read the flag synchronously
    // (via the useState initialiser) to show the error state without ever
    // seeing the event.
    //
    // This directly reproduces the stuck-skeleton bug: before the fix the
    // component would mount into the empty initialState (bootstrapFailed=false)
    // and remain on the skeleton forever.
    console.log('\n  [H] Window-flag / late-mount path (stuck-skeleton regression)');
    {
      let page;
      try {
        page = await browser.newPage();
        page.on('pageerror', () => {});
        page.on('console',   () => {});
        await page.setCacheEnabled(false);

        // Hold the SalesBoardPage lazy chunk.  All other requests pass through,
        // including the API calls that will 503 (no HUBSPOT_TOKEN) and trigger
        // the bootstrap failure.
        await page.setRequestInterception(true);
        const heldChunkRequests = [];
        let holdingActive = true;

        page.on('request', req => {
          const url = req.url();
          if (holdingActive && url.includes('/react/chunks/SalesBoardPage-')) {
            heldChunkRequests.push(req);
          } else {
            try { req.continue(); } catch {}
          }
        });

        await injectSession(page, adminClient.cookie);
        await page.goto(`${BASE}/sales`, { waitUntil: 'domcontentloaded', timeout: 15000 });

        // Wait for bootstrap to set the window flag (bootstrap will 503 because
        // HUBSPOT_TOKEN is stripped in the test harness).
        const flagSet = await waitForWindowFlag(page, 12000);

        if (!flagSet) {
          record(
            '(H.1) window.__salesBoardBootstrapFailed is set when bootstrap fails',
            'truthy window flag',
            'flag never set within 12 s',
            false,
            'bootstrap() may not have run or the 503 path did not fire',
          );
          record('(H.2) Error heading visible after chunk released (late mount)', 'skipped', 'skipped', false);
          record('(H.3) Reload page button visible (late mount)',               'skipped', 'skipped', false);
          record('(H.4) Skeleton pills absent after error state renders',        'skipped', 'skipped', false);
        } else {
          record(
            '(H.1) window.__salesBoardBootstrapFailed is set when bootstrap fails',
            'truthy window flag within 12 s',
            'flag set',
            true,
          );

          // Release the held chunk now that the flag is confirmed set.
          holdingActive = false;
          for (const req of heldChunkRequests) {
            try { req.continue(); } catch {}
          }
          heldChunkRequests.length = 0;
          page.off('request', () => {});
          await page.setRequestInterception(false);

          // Wait for the React component to mount and show the error state.
          const errorVisible = await waitForErrorState(page, 20000);

          if (!errorVisible) {
            const state = await inspectErrorState(page);
            record(
              '(H.2) Error heading visible after chunk released (late mount)',
              '"HubSpot is currently unavailable" in #sales-board-mount',
              `heading=${state.hasHeading} mount=${JSON.stringify(state).slice(0, 120)}`,
              false,
              'Component may have ignored the window flag (stuck-skeleton bug regression)',
            );
            record('(H.3) Reload page button visible (late mount)', 'skipped', 'skipped', false);
            record('(H.4) Skeleton pills absent after error state renders', 'skipped', 'skipped', false);
          } else {
            const state = await inspectErrorState(page);
            record(
              '(H.2) Error heading visible after chunk released (late mount)',
              '"HubSpot is currently unavailable" in #sales-board-mount',
              `heading=${state.hasHeading}`,
              !!state.hasHeading,
            );
            record(
              '(H.3) Reload page button visible (late mount)',
              '"Reload page" button in #sales-board-mount',
              `reloadBtn=${state.hasReloadBtn}`,
              !!state.hasReloadBtn,
            );
            record(
              '(H.4) Skeleton pills absent after error state renders',
              'no .skeleton-pill elements',
              `hasSkeletonPill=${state.hasSkeletonPill}`,
              !state.hasSkeletonPill,
            );
          }
        }
      } catch (e) {
        record('(H) Window-flag late-mount path', 'no error', `error: ${e.message}`, false, e.stack || '');
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }

    // ── (L) Event-listener / early-mount path ─────────────────────────────────
    //
    // Scenario: the React chunk loads and the component mounts before bootstrap
    // fails (the happy path for most page loads).  The component registers its
    // 'sales-board-bootstrap-failed' listener in useEffect.  We then simulate a
    // bootstrap failure by:
    //   1. Setting window.__salesBoardBootstrapFailed (as core.js would).
    //   2. Dispatching the 'sales-board-bootstrap-failed' CustomEvent.
    // The component's listener fires and must flip bootstrapFailed → true,
    // replacing the board with the error state.
    console.log('\n  [L] Event-listener / early-mount path');
    {
      let page;
      try {
        page = await browser.newPage();
        page.on('pageerror', () => {});
        page.on('console',   () => {});
        await page.setCacheEnabled(false);

        // Intercept API calls to return empty-but-valid data so bootstrap
        // completes normally and the React mount point survives.
        await page.setRequestInterception(true);
        page.on('request', req => {
          const u = req.url();
          if (u.includes('/api/contacts-all')) {
            req.respond({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({ results: [], totalPages: 1, page: 1, total: 0 }),
            });
          } else if (u.includes('/api/localdata/all')) {
            req.respond({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({}),
            });
          } else {
            req.continue();
          }
        });

        await injectSession(page, adminClient.cookie);
        await page.goto(`${BASE}/sales`, { waitUntil: 'domcontentloaded', timeout: 15000 });

        // Wait for the React component to mount (it renders the board, not the
        // error state, because bootstrap succeeded).
        const mounted = await pollPage(page, () => {
          const mount = document.getElementById('sales-board-mount');
          if (!mount) return false;
          const themed = mount.firstElementChild;
          if (!themed) return false;
          const board = themed.firstElementChild;
          if (!board) return false;
          // The normal board renders 2 column children; the error state renders
          // a single centred box.  Either means React has mounted.
          return board.children.length >= 1;
        }, null, 20000);

        if (!mounted) {
          record(
            '(L.1) SalesBoardPage mounts before bootstrap-failure simulation',
            'React renders within 20 s',
            'timed out (20 s)',
            false,
            'React.lazy chunk did not mount — rebuild with npm run build:react',
          );
          record('(L.2) Error heading visible after event dispatch', 'skipped', 'skipped', false);
          record('(L.3) Reload page button visible (event path)',     'skipped', 'skipped', false);
          record('(L.4) Skeleton pills absent (event path)',          'skipped', 'skipped', false);
        } else {
          record(
            '(L.1) SalesBoardPage mounts before bootstrap-failure simulation',
            'React renders within 20 s',
            'mounted',
            true,
          );

          // Give React's useEffect a chance to register the event listener.
          // The component renders to the DOM first, then effects fire on the
          // next animation frame.  A brief pause avoids a race where the event
          // fires before the listener is attached.
          await new Promise(r => setTimeout(r, 600));

          // Simulate the bootstrap failure exactly as core.js would do it.
          // Poll-dispatch so we survive any remaining race: keep re-firing every
          // 400 ms until the error state appears (max 8 s total).
          const dispatchDeadline = Date.now() + 8000;
          let errorVisible = false;
          while (Date.now() < dispatchDeadline) {
            await page.evaluate(() => {
              window.__salesBoardBootstrapFailed = { code: undefined, message: 'Test-simulated HubSpot error' };
              document.dispatchEvent(new CustomEvent('sales-board-bootstrap-failed', {
                detail: { code: undefined, message: 'Test-simulated HubSpot error' },
              }));
            });
            const check = await pollPage(page, () => {
              const mount = document.getElementById('sales-board-mount');
              return !!(mount && (mount.innerText || mount.textContent || '').includes('HubSpot is currently unavailable'));
            }, null, 600, 100);
            if (check) { errorVisible = true; break; }
          }

          if (!errorVisible) {
            const state = await inspectErrorState(page);
            record(
              '(L.2) Error heading visible after event dispatch',
              '"HubSpot is currently unavailable" in #sales-board-mount',
              `heading=${state.hasHeading} mount=${JSON.stringify(state).slice(0, 120)}`,
              false,
              'Component may not have registered the sales-board-bootstrap-failed listener',
            );
            record('(L.3) Reload page button visible (event path)', 'skipped', 'skipped', false);
            record('(L.4) Skeleton pills absent (event path)',       'skipped', 'skipped', false);
          } else {
            const state = await inspectErrorState(page);
            record(
              '(L.2) Error heading visible after event dispatch',
              '"HubSpot is currently unavailable" in #sales-board-mount',
              `heading=${state.hasHeading}`,
              !!state.hasHeading,
            );
            record(
              '(L.3) Reload page button visible (event path)',
              '"Reload page" button in #sales-board-mount',
              `reloadBtn=${state.hasReloadBtn}`,
              !!state.hasReloadBtn,
            );
            record(
              '(L.4) Skeleton pills absent after error state renders (event path)',
              'no .skeleton-pill elements',
              `hasSkeletonPill=${state.hasSkeletonPill}`,
              !state.hasSkeletonPill,
            );
          }
        }
      } catch (e) {
        record('(L) Event-listener early-mount path', 'no error', `error: ${e.message}`, false, e.stack || '');
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }

  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  // ── Results ───────────────────────────────────────────────────────────────────
  const pass = findings.filter(f => f.ok).length;
  const fail = findings.filter(f => !f.ok).length;
  console.log(`\n  Results: ${pass} passed, ${fail} failed`);
  await writeReport(findings);
  await cleanupAndExit(fail > 0 ? 1 : 0);
}

async function writeReport(findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Sales Board Bootstrap — E2E Test Report',
    '',
    `- Date: ${new Date().toISOString()}`,
    '- Command: `npm run test:sales-board-bootstrap`',
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
    '- **(H)** Window-flag / late-mount path: holds the `SalesBoardPage` lazy chunk',
    '  via Puppeteer request interception while bootstrap() fails (503 from no',
    '  `HUBSPOT_TOKEN`). Waits for `window.__salesBoardBootstrapFailed` to be set,',
    '  then releases the chunk. React mounts and reads the flag synchronously via',
    '  the `useState` initialiser. Asserts the error state (heading + Reload button)',
    '  is visible and no `.skeleton-pill` elements remain. Guards the',
    '  stuck-skeleton bug (Task #1099).',
    '- **(L)** Event-listener / early-mount path: intercepts API calls to return',
    '  empty-but-valid data so bootstrap succeeds and React mounts normally.',
    '  Then simulates a bootstrap failure by setting the window flag and',
    '  dispatching `sales-board-bootstrap-failed`. Asserts the event listener',
    '  fires and the component transitions to the error state.',
    '',
    '## Relevant files',
    '',
    '- `src/react/pages/SalesBoardPage.tsx` — `bootstrapFailed` state +',
    '  `useState` initialiser + event listener',
    '- `public/core.js` — bootstrap failure handler that sets',
    '  `window.__salesBoardBootstrapFailed` and dispatches the event',
    '- `public/sales.html` — inline skeleton paint + script load order',
  ];
  const outPath = path.join(dir, 'sales-board-bootstrap.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Report: test-results/sales-board-bootstrap.md`);
}

main();
