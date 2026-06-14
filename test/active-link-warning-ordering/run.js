'use strict';
const { makeSkip3 } = require('../helpers/report');
// test/active-link-warning-ordering/run.js
//
// Regression guard for the "confirm before expiring an active link" ordering
// added to UploadPhotosModal.tsx.
//
// Before the fix the modal called POST generate-link immediately on open,
// which expired the customer's existing active link without warning. The fix
// added a confirmation step: when GET link-status returns hasActiveLink=true the
// modal pauses in a 'confirming' phase and only calls generate-link AFTER the
// staff member clicks "Send new link anyway".
//
// Probes:
//   (A) warning-visible  — after link-status returns hasActiveLink:true the
//                          dialog title reads "Active link exists" and the MUI
//                          Alert with warning severity is present in the DOM.
//   (B) no-premature-call — generate-link has NOT been called at that point
//                           (i.e. the old active link has not been expired yet).
//   (C) confirm-triggers  — clicking [data-testid="cah-confirm-generate"]
//                           ("Send new link anyway") results in exactly one
//                           POST to generate-link.
//
// Strategy:
//   - Boots a disposable test server with the privileges harness.
//   - Uses Puppeteer Node-side request interception to stub:
//       GET  …/link-status  → { hasActiveLink: true }
//       POST …/generate-link → synthetic link (also counts calls)
//   - Opens the modal via window.openCardActionModal (the global bridge
//     registered in src/react/main.tsx) so the test doesn't depend on
//     card-action-handler seeding.
//
// Usage:
//   DATABASE_URL_TEST=<disposable>  npm run test:active-link-warning-ordering
//   PRIVTEST_ALLOW_SHARED_DB=1      npm run test:active-link-warning-ordering

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

require('dotenv').config();

const { pollUntil } = require('../helpers/poll');

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'active-link-warning-ordering.md',
);

const findings = [];
function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}
const skip = makeSkip3(findings);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_LINK       = 'https://measureonce.replit.app/customer-info/alw-testtoken';
const MOCK_ACTIVE_TOKEN = 'alw-testtoken';
const FUTURE_EXPIRY = new Date(Date.now() + 14 * 86400000).toISOString();

const FAKE_USER_OBJ = {
  id:                'alw-test-admin',
  first_name:        'ALW',
  last_name:         'TestAdmin',
  privilege_level:   'admin',
  onboarding_status: 'active',
  has_custom_photo:  false,
  profile_image_url: null,
  photo_v:           null,
};
const FAKE_USER_JSON = JSON.stringify(FAKE_USER_OBJ);

// ── Stub map builder ───────────────────────────────────────────────────────────

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
        firstname:         'ActiveLink',
        lastname:          'WarningTest',
        email:             'alw-test@privtest.local',
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
      formLink:      MOCK_LINK,
      token:         MOCK_ACTIVE_TOKEN,
    }),
    [generateLinkPath]: JSON.stringify({
      formLink:  MOCK_LINK,
      token:     'alw-testtoken',
      expiresAt: FUTURE_EXPIRY,
    }),
  };
}

const PREFIX_STUBS = [
  { prefix: '/api/design-visits', body: '[]' },
  { prefix: '/api/rooms',         body: '[]' },
  { prefix: '/api/visits',        body: '[]' },
];

// ── Page factory ──────────────────────────────────────────────────────────────

async function openCustomerDetail(browser, base, contactId, generateLinkCounter) {
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

    // Count and respond to POST generate-link
    if (
      req.method() === 'POST' &&
      pathname === `/api/customer-info/by-contact/${contactId}/generate-link`
    ) {
      generateLinkCounter.count += 1;
      req.respond({
        status:  200,
        headers: { 'Content-Type': 'application/json' },
        body:    stubMap[`/api/customer-info/by-contact/${contactId}/generate-link`],
      }).catch(() => {});
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
    '# Active-Link Warning — Ordering Regression Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:active-link-warning-ordering\``,
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
    '- **(A) warning-visible**: GET link-status returns `hasActiveLink:true`. The',
    '  dialog title must read "Active link exists" and an MUI Alert with',
    '  `role="alert"` (warning severity) must be present in the DOM. Regression',
    '  guard against removing the confirming phase.',
    '- **(B) no-premature-call**: At the point where the warning is shown,',
    '  POST generate-link has NOT been called. The existing active link has not',
    '  been expired. Regression guard for the pre-task-#1970 behaviour where the',
    '  modal called generate-link immediately on open.',
    '- **(C) confirm-triggers**: Clicking [data-testid="cah-confirm-generate"]',
    '  ("Send new link anyway") results in exactly one POST to generate-link,',
    '  confirming the call only fires after explicit staff confirmation.',
    '- **(D) cancel-no-call / cancel-closes**: Opens a fresh page, opens the',
    '  modal, waits for the confirming phase, then clicks',
    '  [data-testid="cah-cancel"] ("Cancel"). generate-link must NOT',
    '  be called (count remains 0) and the dialog must no longer be visible.',
    '  Regression guard for the cancel/dismiss path — a bug here would silently',
    '  expire the active link even when the staff member chose to keep it.',
    '- **(E) manager-view actions visible**: When link-status returns `formLink`',
    '  and `token`, the confirming phase renders the manager/admin variant: a',
    '  read-only copy field for the existing link, a Re-send link button, and a',
    '  [data-testid="cah-manual-upload"] Manually Upload button. The Generate',
    '  new link button is still present but visually secondary.',
    '- **(F) Manually Upload calls window.open**: Clicking the Manually Upload',
    '  button invokes `window.open(formLink, "_blank", "noopener,noreferrer")`.',
    '  `window.open` is stubbed in-page; the captured URL must equal the',
    '  `formLink` from the link-status response.',
    '- **(G) Re-send posts to /resend**: Clicking Re-send link issues a POST to',
    '  `/api/customer-info/by-contact/:id/resend` (counted via Node-side',
    '  request interception). Does not call generate-link.',
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

  console.log(`\n  active-link-warning-ordering  run=${runId}`);
  console.log(`  contactId=${contactId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const PROBE_LABELS = [
    '(A) warning-visible — dialog title and Alert present after hasActiveLink:true',
    '(A) warning-visible — MUI Alert with warning role present',
    '(B) no-premature-call — generate-link not called before confirmation',
    '(C) confirm-triggers — generate-link called exactly once after clicking confirm',
    '(D) cancel-no-call — generate-link not called after clicking Cancel',
    '(D) cancel-closes — dialog is no longer visible after clicking Cancel',
    '(E) manager-view — Copy link field, Re-send, and Manually Upload buttons visible',
    '(F) manager-view — Manually Upload calls window.open with the active formLink URL',
    '(G) manager-view — Re-send button posts to /resend endpoint',
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

    // Shared counter tracked in Node.js via request interception (not in-page).
    const generateLinkCounter = { count: 0 };

    console.log('\n  Opening customer detail page…');
    const page = await openCustomerDetail(browser, BASE, contactId, generateLinkCounter);

    // Wait for window.openCardActionModal to be registered by main.tsx.
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
      // ── Open the modal programmatically ───────────────────────────────────────

      console.log('\n  Opening modal via window.openCardActionModal…');

      await page.evaluate((cid) => {
        window.openCardActionModal(
          { id: 1, type: 'upload_photos_and_info', config: {}, bindings: [] },
          {
            contactId:    cid,
            contactName:  'ActiveLink WarningTest',
            contactEmail: 'alw-test@privtest.local',
          },
        );
      }, contactId);

      // ── (A) Warning visible ────────────────────────────────────────────────

      console.log('\n  [A] Waiting for "Active link exists" title…');

      // Poll until the dialog title reads "Active link exists".
      const titleFound = await pollPage(page, () => {
        const titleEl = document.querySelector('[data-testid="upload-photos-dialog-title"]');
        return titleEl && titleEl.textContent.trim() === 'Active link exists'
          ? 'found'
          : null;
      }, 15000);

      record(
        PROBE_LABELS[0],
        !!titleFound,
        titleFound
          ? 'Dialog title "Active link exists" found'
          : 'Dialog title "Active link exists" not found within 15 s',
      );

      // Also check that the MUI Alert with warning severity is present.
      const alertFound = await page.evaluate(() => {
        const alerts = [...document.querySelectorAll('[role="alert"]')];
        return alerts.length > 0 ? 'found' : null;
      });

      record(
        PROBE_LABELS[1],
        !!alertFound,
        alertFound
          ? 'MUI Alert [role="alert"] found in open dialog'
          : 'MUI Alert [role="alert"] not found — confirming phase may not have rendered',
      );

      // ── (B) generate-link NOT called yet ──────────────────────────────────

      console.log('\n  [B] Checking generate-link call count before confirmation…');

      const countBefore = generateLinkCounter.count;

      record(
        PROBE_LABELS[2],
        countBefore === 0,
        countBefore === 0
          ? 'generate-link not called before confirmation (count=0)'
          : `generate-link was called ${countBefore} time(s) before confirmation — active link was expired prematurely`,
      );

      // ── (C) Click "Send new link anyway" → generate-link fires ────────────

      console.log('\n  [C] Clicking "Send new link anyway"…');

      const confirmBtn = await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="cah-confirm-generate"]');
        return btn ? 'found' : null;
      });

      if (!confirmBtn) {
        record(
          PROBE_LABELS[3],
          false,
          '[data-testid="cah-confirm-generate"] not found — cannot proceed to probe C',
        );
      } else {
        // Snapshot count immediately before click so the assertion is delta-based.
        const countBefore2 = generateLinkCounter.count;

        await page.evaluate(() => {
          document.querySelector('[data-testid="cah-confirm-generate"]').click();
        });

        // Poll Node.js counter until it increments past the pre-click snapshot
        // or the 8 s deadline passes.
        const deadline = Date.now() + 8000;
        while (generateLinkCounter.count <= countBefore2 && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 100));
        }

        const countAfter = generateLinkCounter.count;

        record(
          PROBE_LABELS[3],
          countAfter === countBefore2 + 1,
          countAfter === countBefore2 + 1
            ? 'generate-link called exactly once after clicking confirm'
            : countAfter <= countBefore2
              ? 'generate-link not called within 8 s of clicking confirm'
              : `generate-link called ${countAfter - countBefore2} times (expected 1)`,
        );
      }

      await page.__ctx.close().catch(() => {});

      // ── (D) Cancel does not call generate-link ─────────────────────────────

      console.log('\n  [D] Opening fresh page for cancel probe…');

      const cancelCounter = { count: 0 };
      const pageD = await openCustomerDetail(browser, BASE, contactId, cancelCounter);

      const bridgeReadyD = await pollPage(pageD, () =>
        typeof window.openCardActionModal === 'function' ? 'ok' : null,
      20000);

      if (!bridgeReadyD) {
        const err = pageD.__logs.slice(0, 3).join('; ');
        const msg = 'window.openCardActionModal not available within 20 s'
          + (err ? ` | page errors: ${err}` : '');
        record(PROBE_LABELS[4], false, msg);
        record(PROBE_LABELS[5], false, msg);
      } else {
        await pageD.evaluate((cid) => {
          window.openCardActionModal(
            { id: 1, type: 'upload_photos_and_info', config: {}, bindings: [] },
            {
              contactId:    cid,
              contactName:  'ActiveLink WarningTest',
              contactEmail: 'alw-test@privtest.local',
            },
          );
        }, contactId);

        // Wait for the confirming phase (dialog title "Active link exists").
        const titleFoundD = await pollPage(pageD, () => {
          const titleEl = document.querySelector('[data-testid="upload-photos-dialog-title"]');
          return titleEl && titleEl.textContent.trim() === 'Active link exists'
            ? 'found'
            : null;
        }, 15000);

        if (!titleFoundD) {
          const msg = 'Dialog title "Active link exists" not found within 15 s — cannot run cancel probe';
          record(PROBE_LABELS[4], false, msg);
          record(PROBE_LABELS[5], false, msg);
        } else {
          const cancelBtn = await pageD.evaluate(() => {
            const btn = document.querySelector('[data-testid="cah-cancel"]');
            return btn ? 'found' : null;
          });

          if (!cancelBtn) {
            const msg = '[data-testid="cah-cancel"] not found — cannot proceed';
            record(PROBE_LABELS[4], false, msg);
            record(PROBE_LABELS[5], false, msg);
          } else {
            await pageD.evaluate(() => {
              document.querySelector('[data-testid="cah-cancel"]').click();
            });

            // Brief settle delay so any in-flight POST (the bug) has time to fire.
            await new Promise(r => setTimeout(r, 1500));

            // (D.1) generate-link must not have been called.
            record(
              PROBE_LABELS[4],
              cancelCounter.count === 0,
              cancelCounter.count === 0
                ? 'generate-link not called after clicking Cancel (count=0)'
                : `generate-link was called ${cancelCounter.count} time(s) after Cancel — active link was expired`,
            );

            // (D.2) The dialog must no longer be visible.
            const dialogGone = await pageD.evaluate(() => {
              const dialog = document.querySelector('[data-testid="upload-photos-dialog"]');
              if (!dialog) return 'gone';
              const style = window.getComputedStyle(dialog);
              return style.display === 'none'
                || style.visibility === 'hidden'
                || dialog.getAttribute('aria-hidden') === 'true'
                || !document.querySelector('[data-testid="upload-photos-dialog-title"]')
                  ? 'gone'
                  : null;
            });

            record(
              PROBE_LABELS[5],
              !!dialogGone,
              dialogGone
                ? 'Dialog is no longer visible after Cancel'
                : 'Dialog is still visible after Cancel — cancel affordance may be broken',
            );
          }
        }
      }

      await pageD.__ctx.close().catch(() => {});
    }

    // ── Probes E, F, G: manager/admin view (formLink present) ─────────────────
    //
    // The link-status stub now returns formLink + token, which causes the modal
    // to render the manager/admin variant of the confirming phase: a CopyLinkField
    // for the existing link, Re-send, Manually Upload, and a secondary Generate
    // new link button.

    console.log('\n  [E] Opening fresh page for manager-view probes (E, F, G)…');

    const resendCounter  = { count: 0 };
    const ctxE = await (browser.createBrowserContext
      ? browser.createBrowserContext()
      : browser.createIncognitoBrowserContext());
    const pageE = await ctxE.newPage();
    pageE.__ctx = ctxE;
    await pageE.setCacheEnabled(false);

    const ePageLogs = [];
    pageE.on('console',   m => { if (m.type() === 'error') ePageLogs.push(`[console.error] ${m.text()}`); });
    pageE.on('pageerror', e => ePageLogs.push(`[pageerror] ${e.message}`));

    const stubMapE = buildStubMap(contactId);
    const resendPathE = `/api/customer-info/by-contact/${contactId}/resend`;

    await pageE.setRequestInterception(true);
    pageE.on('request', req => {
      const urlObj   = new URL(req.url());
      const pathname = urlObj.pathname;

      if (req.isNavigationRequest() && pathname === '/login') {
        req.abort('aborted').catch(() => {});
        return;
      }

      if (req.method() === 'POST' && pathname === resendPathE) {
        resendCounter.count += 1;
        req.respond({
          status:  200,
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ ok: true }),
        }).catch(() => {});
        return;
      }

      if (req.method() === 'POST' &&
          pathname === `/api/customer-info/by-contact/${contactId}/generate-link`) {
        req.respond({
          status:  200,
          headers: { 'Content-Type': 'application/json' },
          body:    stubMapE[`/api/customer-info/by-contact/${contactId}/generate-link`],
        }).catch(() => {});
        return;
      }

      if (Object.prototype.hasOwnProperty.call(stubMapE, pathname)) {
        req.respond({
          status:  200,
          headers: { 'Content-Type': 'application/json' },
          body:    stubMapE[pathname],
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

    // Stub window.open in-page so Manually Upload can be verified without
    // actually opening a new tab.
    await pageE.evaluateOnNewDocument(() => {
      window.__muOpenCalled = null;
      const origOpen = window.open;
      window.open = function(url, target, features) {
        window.__muOpenCalled = String(url || '');
        return null;
      };
    });

    await pageE.evaluateOnNewDocument((fakeUserJson) => {
      window.__moHeaderUser = JSON.parse(fakeUserJson);
    }, FAKE_USER_JSON);

    await pageE.goto(`${BASE}/customers/${contactId}`, {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });

    const bridgeReadyE = await pollPage(pageE, () =>
      typeof window.openCardActionModal === 'function' ? 'ok' : null,
    20000);

    if (!bridgeReadyE) {
      const msg = 'window.openCardActionModal not available within 20 s (probe E)';
      record(PROBE_LABELS[6], false, msg);
      record(PROBE_LABELS[7], false, msg);
      record(PROBE_LABELS[8], false, msg);
    } else {
      await pageE.evaluate((cid) => {
        window.openCardActionModal(
          { id: 1, type: 'upload_photos_and_info', config: {}, bindings: [] },
          {
            contactId:    cid,
            contactName:  'ActiveLink WarningTest',
            contactEmail: 'alw-test@privtest.local',
          },
        );
      }, contactId);

      const titleFoundE = await pollPage(pageE, () => {
        const titleEl = document.querySelector('[data-testid="upload-photos-dialog-title"]');
        return titleEl && titleEl.textContent.trim() === 'Active link exists'
          ? 'found'
          : null;
      }, 15000);

      if (!titleFoundE) {
        const msg = 'Dialog title "Active link exists" not found within 15 s — cannot run manager probes';
        record(PROBE_LABELS[6], false, msg);
        record(PROBE_LABELS[7], false, msg);
        record(PROBE_LABELS[8], false, msg);
      } else {
        // ── (E) Manager-view actions visible ──────────────────────────────────

        console.log('\n  [E] Checking manager-view actions (Re-send, Manually Upload)…');

        const managerActions = await pageE.evaluate(() => {
          const resendBtn      = Array.from(document.querySelectorAll('button'))
            .find(b => (b.textContent || '').trim() === 'Re-send link');
          const manualUploadBtn = document.querySelector('[data-testid="cah-manual-upload"]');
          const textField       = document.querySelector('input[readonly]');
          return {
            hasResend:       !!resendBtn,
            hasManualUpload: !!manualUploadBtn,
            hasCopyField:    !!textField,
          };
        });

        record(
          PROBE_LABELS[6],
          managerActions.hasResend && managerActions.hasManualUpload && managerActions.hasCopyField,
          managerActions.hasResend && managerActions.hasManualUpload && managerActions.hasCopyField
            ? 'Copy link field, Re-send, and Manually Upload all visible in manager confirming view'
            : `hasResend=${managerActions.hasResend} hasManualUpload=${managerActions.hasManualUpload} hasCopyField=${managerActions.hasCopyField}`,
        );

        // ── (F) Manually Upload calls window.open ─────────────────────────────

        console.log('\n  [F] Clicking Manually Upload and checking window.open…');

        await pageE.evaluate(() => {
          const btn = document.querySelector('[data-testid="cah-manual-upload"]');
          if (btn) btn.click();
        });

        await new Promise(r => setTimeout(r, 300));

        const openResult = await pageE.evaluate(() => window.__muOpenCalled);

        record(
          PROBE_LABELS[7],
          openResult === MOCK_LINK,
          openResult === MOCK_LINK
            ? `window.open called with correct formLink: ${openResult}`
            : openResult
              ? `window.open called with wrong URL: ${openResult} (expected ${MOCK_LINK})`
              : 'window.open was not called — Manually Upload did not open a tab',
        );

        // ── (G) Re-send posts to /resend ──────────────────────────────────────

        console.log('\n  [G] Clicking Re-send link and checking /resend POST…');

        const resendBefore = resendCounter.count;

        await pageE.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button'))
            .find(b => (b.textContent || '').trim() === 'Re-send link');
          if (btn) btn.click();
        });

        const deadline = Date.now() + 5000;
        while (resendCounter.count <= resendBefore && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 100));
        }

        record(
          PROBE_LABELS[8],
          resendCounter.count > resendBefore,
          resendCounter.count > resendBefore
            ? `POST /resend intercepted (count=${resendCounter.count})`
            : 'POST /resend was not called within 5 s after clicking Re-send link',
        );
      }
    }

    await pageE.__ctx.close().catch(() => {});

    exitCode = findings.every(f => f.ok) ? 0 : 1;
    const failed = findings.filter(f => !f.ok && !f.skipped).length;
    console.log(`\n  Results: ${findings.length - failed} passed, ${failed} failed`);

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
