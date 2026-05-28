'use strict';
// test/upload-photos-copyable-link/run.js
//
// Regression guard for the "Copy & close" button in UploadPhotosModal.
// Task #1929 added the button; this suite ensures a future refactor cannot
// silently remove it or break its close-after-copy behaviour.
//
// Probes:
//   [CC-A] After the generate-link stub resolves, [data-testid="cah-copy-close"]
//          is present and enabled in the open dialog.
//
//   [CC-B] Clicking "Copy & close" causes the MuiDialog-root to leave the DOM
//          (i.e. the modal closes).
//
// Strategy:
//   - Boots a disposable test server with the privileges harness (same pattern
//     as test/info-card-review-resend/run.js).
//   - Sets up request interception to stub all page-level API calls so the
//     customer-detail React page mounts cleanly.
//   - Stubs POST /api/customer-info/by-contact/:id/generate-link to respond
//     immediately with a synthetic link — no delay, no real API.
//   - Overrides navigator.clipboard.writeText via evaluateOnNewDocument so the
//     copy step succeeds (or fails silently) in headless Chrome.
//   - Opens the modal by calling window.openCardActionModal() (the global bridge
//     exposed in src/react/main.tsx) rather than clicking a real card-action
//     strip button — keeps the test isolated from card-action-handler seeding.
//
// Usage:
//   DATABASE_URL_TEST=<disposable>  npm run test:upload-photos-copyable-link
//   PRIVTEST_ALLOW_SHARED_DB=1      npm run test:upload-photos-copyable-link

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

require('dotenv').config();

const { pollUntil } = require('../helpers/poll');

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'upload-photos-copyable-link.md',
);

const findings = [];
function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_LINK = 'https://measureonce.replit.app/customer-info/testtoken123abc';

function makeContactBody(contactId) {
  return JSON.stringify({
    id: contactId,
    properties: {
      firstname:         'CopyClose',
      lastname:          'ModalTest',
      email:             'copy-close-test@privtest.local',
      hs_lead_status:    null,
      hw_lead_substatus: null,
      company:           null,
      phone:             null,
      mobilephone:       null,
      createdate:        '2024-01-01T00:00:00Z',
      lastmodifieddate:  '2024-01-01T00:00:00Z',
    },
  });
}

const FAKE_USER_OBJ = {
  id:                'cc-test-admin',
  first_name:        'CopyClose',
  last_name:         'TestAdmin',
  privilege_level:   'admin',
  onboarding_status: 'active',
  has_custom_photo:  false,
  profile_image_url: null,
  photo_v:           null,
};
const FAKE_USER_JSON = JSON.stringify(FAKE_USER_OBJ);

// ── Stub map builder ──────────────────────────────────────────────────────────

function buildStubMap(contactId) {
  const contactApiPath    = `/api/contacts/${contactId}`;
  const generateLinkPath  = `/api/customer-info/by-contact/${contactId}/generate-link`;
  const generateLinkBody  = JSON.stringify({
    formLink:  MOCK_LINK,
    token:     'testtoken123abc',
    expiresAt: new Date(Date.now() + 28 * 86400000).toISOString(),
  });
  return {
    '/api/auth/user':            FAKE_USER_JSON,
    '/auth/status':              JSON.stringify({ google: false, hubspot: false }),
    '/api/quickbooks/status':    JSON.stringify({ connected: false }),
    '/api/hubspot/status':       JSON.stringify({ status: 'ok' }),
    '/api/google/status':        JSON.stringify({ status: 'ok' }),
    '/api/database/status':      JSON.stringify({ status: 'ok' }),
    '/api/lead-statuses':        '[]',
    '/api/lead-substatuses':     '[]',
    '/api/localdata/all':        '{}',
    '/api/workflow':             '{}',
    '/api/card-action-handlers': '[]',
    '/api/platform-users':       '[]',
    [contactApiPath]:                JSON.stringify({
      id: contactId,
      properties: {
        firstname:         'CopyClose',
        lastname:          'ModalTest',
        email:             'copy-close-test@privtest.local',
        hs_lead_status:    null,
        hw_lead_substatus: null,
        company:           null,
        phone:             null,
        mobilephone:       null,
        createdate:        '2024-01-01T00:00:00Z',
        lastmodifieddate:  '2024-01-01T00:00:00Z',
      },
    }),
    [`${contactApiPath}/localdata`]:   '{}',
    [`${contactApiPath}/tasks`]:       '{"results":[]}',
    [`${contactApiPath}/google`]:      '{"connected":false,"emails":[]}',
    [`${contactApiPath}/whatsapp`]:    '{"enabled":false,"messages":[]}',
    [generateLinkPath]:                generateLinkBody,
  };
}

const PREFIX_STUBS = [
  { prefix: '/api/design-visits', body: '[]' },
  { prefix: '/api/rooms',         body: '[]' },
  { prefix: '/api/visits',        body: '[]' },
  { prefix: '/api/customer-info', body: '[]' },
];

// ── Page helper ───────────────────────────────────────────────────────────────

async function openCustomerDetail(browser, base, contactId) {
  const ctx  = await (browser.createBrowserContext
    ? browser.createBrowserContext()
    : browser.createIncognitoBrowserContext());
  const page = await ctx.newPage();
  page.__ctx = ctx;
  await page.setCacheEnabled(false);

  const pageLogs = [];
  page.on('console',   m => { if (m.type() === 'error') pageLogs.push(`[console.error] ${m.text()}`); });
  page.on('pageerror', e => pageLogs.push(`[pageerror] ${e.message}`));
  page.__logs = pageLogs;

  const stubMap = buildStubMap(contactId);

  await page.setRequestInterception(true);
  page.on('request', req => {
    const url      = req.url();
    const urlObj   = new URL(url);
    const pathname = urlObj.pathname;

    if (req.isNavigationRequest() && pathname === '/login') {
      req.abort('aborted').catch(() => {});
      return;
    }

    if (Object.prototype.hasOwnProperty.call(stubMap, pathname)) {
      req.respond({
        status:  200,
        headers: { 'Content-Type': 'application/json' },
        body:    stubMap[pathname],
      }).catch(() => {});
      return;
    }

    for (const p of PREFIX_STUBS) {
      if (pathname.startsWith(p.prefix)) {
        req.respond({
          status:  200,
          headers: { 'Content-Type': 'application/json' },
          body:    p.body,
        }).catch(() => {});
        return;
      }
    }

    req.continue().catch(() => {});
  });

  // Stub clipboard API so writeText resolves even in headless Chrome.
  await page.evaluateOnNewDocument(() => {
    window.__moHeaderUser = null; // overridden below
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: () => Promise.resolve(),
        readText:  () => Promise.resolve(''),
      },
    });
  });

  await page.evaluateOnNewDocument((fakeUserJson) => {
    window.__moHeaderUser = JSON.parse(fakeUserJson);
  }, FAKE_USER_JSON);

  await page.goto(`${base}/customers/${contactId}`, {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });

  return page;
}

function pollPage(page, fn, timeoutMs = 15000) {
  return pollUntil(page, fn, timeoutMs, 200);
}

// ── Report writer ─────────────────────────────────────────────────────────────

async function writeReport(runId) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc    = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok).length;
  const lines = [
    '# Upload Photos — Copy & Close Button Regression Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:upload-photos-copyable-link\``,
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
    ...findings.map(f =>
      `| ${f.ok ? 'PASS' : 'FAIL'} | ${esc(f.id)} | ${esc(f.detail)} |`,
    ),
    '',
    '## Coverage',
    '',
    '- **[CC-A] Copy & close button visible**: Opens `UploadPhotosModal` via the',
    '  global `window.openCardActionModal` bridge with an `upload_photos_and_info`',
    '  handler. The generate-link API stub responds immediately with a synthetic',
    '  link. Asserts `[data-testid="cah-copy-close"]` is present and not disabled.',
    '- **[CC-B] Modal closes after click**: Clicks the button and asserts the',
    '  `MuiDialog-root` element leaves the DOM within the polling window.',
    '  `navigator.clipboard.writeText` is stubbed to resolve immediately so the',
    '  `.finally()` path that calls `onClose()` is always reached.',
    '',
    '## Relevant files',
    '',
    '- `src/react/components/modals/UploadPhotosModal.tsx`',
    '- `src/react/components/modals/UploadPhotosModal.stories.tsx`',
    '- `src/react/main.tsx` (exposes `window.openCardActionModal`)',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n') + '\n');
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

  const runId     = Math.random().toString(36).slice(2, 8);
  const contactId = String(100000000000 + Math.floor(Math.random() * 899999999999));

  console.log(`\n  upload-photos-copyable-link  run=${runId}`);
  console.log(`  contactId=${contactId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const PROBE_LABELS = [
    '[CC-A] Copy & close button appears once link is ready',
    '[CC-A] Copy & close button is not disabled',
    '[CC-B] Clicking Copy & close closes the modal',
  ];

  if (!puppeteer) {
    for (const l of PROBE_LABELS) record(l, false, 'puppeteer not installed — skipped');
    await writeReport(runId);
    process.exit(1);
    return;
  }

  const pool = new Pool({ connectionString: connStr });

  const harness = require('../privileges/harness');
  const {
    spawnServer, waitForServer, seedUsers, cleanupTestData,
    resetRateLimitStore, BASE,
  } = harness;
  harness.setPool(pool);

  await cleanupTestData(pool);
  await resetRateLimitStore(pool);

  const { child, logBuf } = spawnServer();
  let exitCode = 1;
  let browser  = null;

  const teardown = async () => {
    if (browser) { try { await browser.close(); } catch {} }
    try { child.kill('SIGTERM'); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
  };

  process.on('SIGINT',             () => teardown().then(() => process.exit(130)));
  process.on('SIGTERM',            () => teardown().then(() => process.exit(130)));
  process.on('uncaughtException',  e  => { console.error('Uncaught:',  e); teardown().then(() => process.exit(2)); });
  process.on('unhandledRejection', e  => { console.error('Unhandled:', e); teardown().then(() => process.exit(2)); });

  try {
    await waitForServer();
    await resetRateLimitStore(pool);
    console.log(`  Server up at ${BASE}`);

    await seedUsers(pool, runId);

    const { findChromium } = require('../shared/find-chromium');
    const executablePath   = findChromium() || undefined;

    browser = await puppeteer.launch({
      headless:        true,
      executablePath,
      defaultViewport: { width: 1280, height: 900 },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    // ── Open customer detail page ─────────────────────────────────────────────

    console.log('\n  Opening customer detail page…');
    const page = await openCustomerDetail(browser, BASE, contactId);

    // Wait for the React island to mount (window.openCardActionModal is
    // registered by main.tsx as soon as the bundle evaluates).
    const bridgeReady = await pollPage(page, () =>
      typeof window.openCardActionModal === 'function' ? 'ok' : null,
    20000);

    if (!bridgeReady) {
      const err = page.__logs.slice(0, 3).join('; ');
      const msg = 'window.openCardActionModal not available within 20 s'
        + (err ? ` | page errors: ${err}` : '');
      for (const l of PROBE_LABELS) record(l, false, msg);
      await page.__ctx.close().catch(() => {});
      exitCode = 1;
    } else {
      // ── Open the modal programmatically ───────────────────────────────────

      console.log('\n  [CC-A] opening modal via window.openCardActionModal…');

      await page.evaluate((cid) => {
        window.openCardActionModal(
          { id: 1, type: 'upload_photos_and_info', config: {}, bindings: [] },
          { contactId: cid, contactName: 'CopyClose ModalTest', contactEmail: 'copy-close-test@privtest.local' },
        );
      }, contactId);

      // ── [CC-A] Copy & close button appears ────────────────────────────────

      // The modal calls POST /api/customer-info/by-contact/:id/generate-link on
      // mount; our stub responds immediately, so the button should appear fast.
      const btnFound = await pollPage(page, () => {
        const btn = document.querySelector('[data-testid="cah-copy-close"]');
        return btn ? 'found' : null;
      }, 15000);

      record(
        PROBE_LABELS[0],
        !!btnFound,
        btnFound
          ? '[data-testid="cah-copy-close"] found in open dialog'
          : '[data-testid="cah-copy-close"] not found within 15 s',
      );

      if (btnFound) {
        // ── [CC-A] Button must not be disabled ──────────────────────────────

        const btnEnabled = await page.evaluate(() => {
          const btn = document.querySelector('[data-testid="cah-copy-close"]');
          return btn && !btn.disabled ? 'ok' : null;
        });

        record(
          PROBE_LABELS[1],
          !!btnEnabled,
          btnEnabled
            ? 'Copy & close button is enabled'
            : 'Copy & close button is disabled (unexpected)',
        );

        // ── [CC-B] Click and verify modal closes ─────────────────────────────

        console.log('\n  [CC-B] clicking Copy & close…');

        await page.evaluate(() => {
          const btn = document.querySelector('[data-testid="cah-copy-close"]');
          if (btn) btn.click();
        });

        // Poll until the MuiDialog-root leaves the DOM.
        const dialogGone = await pollPage(page, () =>
          !document.querySelector('.MuiDialog-root') ? 'gone' : null,
        10000);

        record(
          PROBE_LABELS[2],
          !!dialogGone,
          dialogGone
            ? 'MuiDialog-root left the DOM after clicking Copy & close'
            : 'MuiDialog-root still present 10 s after clicking Copy & close',
        );
      } else {
        record(PROBE_LABELS[1], false, 'skipped — button not found in probe A');
        record(PROBE_LABELS[2], false, 'skipped — button not found in probe A');
      }

      await page.__ctx.close().catch(() => {});
    }

    exitCode = findings.every(f => f.ok) ? 0 : 1;
    const failed = findings.filter(f => !f.ok).length;
    console.log(`\n  Results: ${findings.length - failed} passed, ${failed} failed`);

  } catch (e) {
    console.error('Test crashed:', e);
    console.error('--- server log (last 2000 chars) ---');
    console.error((logBuf || []).join('').slice(-2000));
    record('harness', false, `fatal: ${e.message}`);
    exitCode = 1;
  } finally {
    await writeReport(runId);
    await teardown();
    process.exit(exitCode);
  }
}

main();
