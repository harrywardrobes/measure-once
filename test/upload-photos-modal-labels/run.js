'use strict';
const { makeSkip3 } = require('../helpers/report');
// test/upload-photos-modal-labels/run.js
//
// Regression guard for button-label / data-testid drift in UploadPhotosModal.
//
// When the confirming phase is active (link-status returns hasActiveLink:true),
// the modal renders a single primary action button.  Its data-testid and
// visible label must stay in sync — a rename of one without the other silently
// breaks automated tests that target the old id.
//
// The original drift that motivated this suite: `cah-confirm-resend` was
// renamed to `cah-confirm-generate` alongside the label change from
// "Send new link anyway" → "Generate new link", but the rename was caught
// manually rather than by an automated guard.
//
// Probes:
//   (L-A) testid-present  — [data-testid="cah-confirm-generate"] exists in the
//                           DOM when the modal is in the confirming phase.
//                           Failure: the id was removed or renamed again.
//   (L-B) label-matches   — The button's visible text content includes
//                           "Generate new link".
//                           Failure: the label drifted away from the test id.
//   (L-C) stale-id-absent — [data-testid="cah-confirm-resend"] (the old,
//                           stale id) is NOT present.
//                           Failure: the old id was re-introduced.
//
// Strategy:
//   - Boots a disposable test server with the privileges harness.
//   - Uses Puppeteer Node-side request interception to stub:
//       GET  …/link-status   → { hasActiveLink: true }
//       POST …/generate-link → synthetic link (so the modal can progress if
//                              the button is clicked, though this suite only
//                              reads the label — it does not click)
//   - Opens the modal via window.openCardActionModal (the global bridge
//     registered in src/react/main.tsx) to avoid needing card-action-handler
//     DB seeding.
//
// Usage:
//   DATABASE_URL_TEST=<disposable>  npm run test:upload-photos-modal-labels
//   PRIVTEST_ALLOW_SHARED_DB=1      npm run test:upload-photos-modal-labels

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

require('dotenv').config();

const { pollUntil } = require('../helpers/poll');

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'upload-photos-modal-labels.md',
);

const findings = [];
function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}
const skip = makeSkip3(findings);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_LINK     = 'https://measure.harrywardrobes.co.uk/customer-info/lbl-testtoken';
const FUTURE_EXPIRY = new Date(Date.now() + 14 * 86400000).toISOString();

const FAKE_USER_OBJ = {
  id:                'lbl-test-admin',
  first_name:        'Label',
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
  const contactApiPath   = `/api/contacts/${contactId}`;
  const linkStatusPath   = `/api/customer-info/by-contact/${contactId}/link-status`;
  const generateLinkPath = `/api/customer-info/by-contact/${contactId}/generate-link`;

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
    [contactApiPath]: JSON.stringify({
      id: contactId,
      properties: {
        firstname:         'Label',
        lastname:          'DriftTest',
        email:             'lbl-test@privtest.local',
        hs_lead_status:    null,
        hw_lead_substatus: null,
        company:           null,
        phone:             null,
        mobilephone:       null,
        createdate:        '2024-01-01T00:00:00Z',
        lastmodifieddate:  '2024-01-01T00:00:00Z',
      },
    }),
    [`${contactApiPath}/localdata`]: '{}',
    [`${contactApiPath}/tasks`]:     '{"results":[]}',
    [`${contactApiPath}/google`]:    '{"connected":false,"emails":[]}',
    [`${contactApiPath}/whatsapp`]:  '{"enabled":false,"messages":[]}',
    [linkStatusPath]: JSON.stringify({
      hasActiveLink: true,
      expiresAt:     FUTURE_EXPIRY,
    }),
    [generateLinkPath]: JSON.stringify({
      formLink:  MOCK_LINK,
      token:     'lbl-testtoken',
      expiresAt: FUTURE_EXPIRY,
    }),
  };
}

const PREFIX_STUBS = [
  { prefix: '/api/design-visits', body: '[]' },
  { prefix: '/api/rooms',         body: '[]' },
  { prefix: '/api/visits',        body: '[]' },
  { prefix: '/api/customer-info', body: '[]' },
];

// ── Page factory ──────────────────────────────────────────────────────────────

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
    const urlObj   = new URL(req.url());
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

function writeReport(runId) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc    = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok && !f.skipped).length;
  const skipped = findings.filter(f => f.skipped).length;
  const lines = [
    '# Upload-Photos Modal — Label / Test-ID Drift Guard',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:upload-photos-modal-labels\``,
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
      `| ${f.ok ? 'PASS' : f.skipped ? 'SKIP' : 'FAIL'} | ${esc(f.id)} | ${esc(f.detail)} |`,
    ),
    '',
    '## Coverage',
    '',
    '- **(L-A) testid-present**: When link-status returns `hasActiveLink:true`,',
    '  the modal enters the confirming phase and',
    '  `[data-testid="cah-confirm-generate"]` must be present in the DOM.',
    '  Failure indicates the id was removed or renamed without updating tests.',
    '- **(L-B) label-matches**: The visible text of the button found by probe L-A',
    '  must include "Generate new link". Failure indicates the label drifted',
    '  away from the test id — tests that find the button by id would pass while',
    '  asserting stale wording.',
    '- **(L-C) stale-id-absent**: `[data-testid="cah-confirm-resend"]` (the old',
    '  id from before the cah-confirm-resend → cah-confirm-generate rename) must',
    '  NOT appear in the DOM. Failure indicates the old id was re-introduced.',
    '',
    '## Relevant files',
    '',
    '- `src/react/components/modals/UploadPhotosModal.tsx`',
    '- `customer-info.js` — GET `/api/customer-info/by-contact/:contactId/link-status`',
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

  console.log(`\n  upload-photos-modal-labels  run=${runId}`);
  console.log(`  contactId=${contactId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const PROBE_LABELS = [
    '(L-A) testid-present — [data-testid="cah-confirm-generate"] present in confirming phase',
    '(L-B) label-matches — button text includes "Generate new link"',
    '(L-C) stale-id-absent — [data-testid="cah-confirm-resend"] not in DOM',
  ];

  if (!puppeteer) {
    for (const l of PROBE_LABELS) skip(l, 'puppeteer not installed — skipped');
    writeReport(runId);
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

    console.log('\n  Opening customer detail page…');
    const page = await openCustomerDetail(browser, BASE, contactId);

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
      // ── Open the modal programmatically ────────────────────────────────────

      console.log('\n  Opening modal via window.openCardActionModal…');

      await page.evaluate((cid) => {
        window.openCardActionModal(
          { id: 1, type: 'upload_photos_and_info', config: {}, bindings: [] },
          {
            contactId:    cid,
            contactName:  'Label DriftTest',
            contactEmail: 'lbl-test@privtest.local',
          },
        );
      }, contactId);

      // ── Wait for the confirming phase ───────────────────────────────────────

      console.log('\n  Waiting for confirming phase ("Active link exists" dialog title)…');

      const titleFound = await pollPage(page, () => {
        const titleEl = document.querySelector('[data-testid="upload-photos-dialog-title"]');
        return titleEl && titleEl.textContent.trim() === 'Active link exists'
          ? 'found'
          : null;
      }, 15000);

      if (!titleFound) {
        const err = page.__logs.slice(0, 3).join('; ');
        const msg = '"Active link exists" dialog title not found within 15 s'
          + (err ? ` | page errors: ${err}` : '');
        for (const l of PROBE_LABELS) record(l, false, msg);
        await page.__ctx.close().catch(() => {});
        exitCode = 1;
      } else {
        // ── (L-A) data-testid="cah-confirm-generate" present ─────────────────

        console.log('\n  [L-A] Checking [data-testid="cah-confirm-generate"] is present…');

        const btnInfo = await page.evaluate(() => {
          const btn = document.querySelector('[data-testid="cah-confirm-generate"]');
          if (!btn) return null;
          return { text: btn.textContent.trim() };
        });

        record(
          PROBE_LABELS[0],
          !!btnInfo,
          btnInfo
            ? `[data-testid="cah-confirm-generate"] found (text: "${btnInfo.text}")`
            : '[data-testid="cah-confirm-generate"] not found in confirming phase — testid was removed or renamed',
        );

        // ── (L-B) button text includes "Generate new link" ───────────────────

        console.log('\n  [L-B] Checking button label includes "Generate new link"…');

        const labelOk = !!(btnInfo && btnInfo.text.includes('Generate new link'));

        record(
          PROBE_LABELS[1],
          labelOk,
          labelOk
            ? `label is "${btnInfo.text}" — matches expected "Generate new link"`
            : btnInfo
              ? `label is "${btnInfo.text}" — does not contain "Generate new link" (label/testid drift)`
              : 'button not found — cannot check label',
        );

        // ── (L-C) stale data-testid="cah-confirm-resend" absent ──────────────

        console.log('\n  [L-C] Checking stale [data-testid="cah-confirm-resend"] is absent…');

        const stalePresent = await page.evaluate(() =>
          !!document.querySelector('[data-testid="cah-confirm-resend"]'),
        );

        record(
          PROBE_LABELS[2],
          !stalePresent,
          !stalePresent
            ? '[data-testid="cah-confirm-resend"] correctly absent from DOM'
            : '[data-testid="cah-confirm-resend"] found — stale id was re-introduced',
        );

        await page.__ctx.close().catch(() => {});
      }

      exitCode = findings.every(f => f.ok) ? 0 : 1;
      const failed = findings.filter(f => !f.ok && !f.skipped).length;
      console.log(`\n  Results: ${findings.length - failed} passed, ${failed} failed`);
    }

  } catch (e) {
    console.error('Test crashed:', e);
    console.error('--- server log (last 2000 chars) ---');
    console.error((logBuf || []).join('').slice(-2000));
    record('harness', false, `fatal: ${e.message}`);
    exitCode = 1;
  } finally {
    writeReport(runId);
    await teardown();
    process.exit(exitCode);
  }
}

main();
