'use strict';
const { makeSkip3 } = require('../helpers/report');
// test/copyable-link/run.js
//
// Regression guard for the generate-on-open copyable-link flow added in
// task #1924 to UploadPhotosModal.tsx.
//
// When the modal opens it immediately POSTs to generate-link to create a
// secure token, then displays the resulting URL in a read-only TextField so
// staff can copy it before (or instead of) sending the email.  When the
// "Send email" button is clicked the pre-generated token is forwarded to the
// upload-photos-and-info endpoint instead of creating a new DB row.
//
// Probes:
//   [CL-1] Link field appears in the modal after generate-link resolves —
//           the TextField value equals the formLink returned by the API.
//   [CL-2] Clicking "Send email" forwards the same token to the
//           upload-photos-and-info endpoint (token value matches; no new
//           token is minted on the send path).
//   [CL-3] The link field is still copyable after the send succeeds —
//           the "Link (still copyable):" section is visible in the
//           post-send confirmation state.
//   [CL-4] When generate-link returns a 4xx error the "Send email" button is
//           disabled and an error message is shown in the modal.
//
// Strategy:
//   - Boot a disposable test server (same harness as other Puppeteer suites).
//   - Open /customers/:contactId in a Puppeteer page.
//   - Use evaluateOnNewDocument to override window.fetch with a stub that:
//       • Returns controlled responses for generate-link and send endpoints.
//       • Captures the POST body of upload-photos-and-info into a window
//         variable so the Node.js side can inspect it via page.evaluate.
//       • Passes everything else through to the real (stubbed) server.
//   - Use page.setRequestInterception to stub all API calls needed by the
//     customer detail page itself (contact data, card-action-handlers, etc.).
//   - Inject window.__moHeaderUser via evaluateOnNewDocument so AuthContext
//     initialises synchronously (no /login redirect).
//   - After the page settles call window.openCardActionModal (the global
//     bridge registered in main.tsx) to open UploadPhotosModal.
//   - Poll the dialog for the expected DOM state after each user action.
//
// contactId must be all-digits (/^\d+$/) — CustomerDetailPage validates it
// with that regex and returns "Invalid customer ID." early if it fails.
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:copyable-link
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:copyable-link

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

require('dotenv').config();

const { pollUntil } = require('../helpers/poll');

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'copyable-link.md',
);

const findings = [];
function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}
const skip = makeSkip3(findings);

// ── Fake data ─────────────────────────────────────────────────────────────────

const FAKE_TOKEN    = 'aabbcc112233ddeeff445566778899aabbcc112233ddeeff44556677889900aa';
const FAKE_FORM_LINK = 'https://privtest.example.com/ci/' + FAKE_TOKEN;
const FAKE_EXPIRES  = '2099-12-31T23:59:59.000Z';

const FAKE_USER_OBJ = {
  id:                'cl-test-admin',
  first_name:        'CopyLink',
  last_name:         'TestAdmin',
  privilege_level:   'admin',
  onboarding_status: 'active',
  has_custom_photo:  false,
  profile_image_url: null,
  photo_v:           null,
};
const FAKE_USER_JSON = JSON.stringify(FAKE_USER_OBJ);

// ── Puppeteer helpers ─────────────────────────────────────────────────────────

async function pollPage(page, fn, timeoutMs = 15000, intervalMs = 200) {
  return pollUntil(page, fn, timeoutMs, intervalMs);
}

// Prefix stubs applied at the network layer for API calls the customer detail
// page makes on load (design-visits, rooms, visits sub-paths).
const PREFIX_STUBS = [
  { prefix: '/api/design-visits', body: '[]' },
  { prefix: '/api/rooms',         body: '[]' },
  { prefix: '/api/visits',        body: '[]' },
];

/**
 * Build the evaluateOnNewDocument script that:
 *   1. Sets window.__moHeaderUser (synchronous auth bootstrap).
 *   2. Overrides window.fetch to intercept generate-link and
 *      upload-photos-and-info with controlled stub responses.
 *      All other calls are forwarded to the original fetch.
 *
 * `generateLinkStatus` — HTTP status for the generate-link stub (200 or 400).
 * When 400, returns { error: 'No email address found' }.
 */
function buildEvaluateScript(contactId, fakeUserJson, generateLinkStatus) {
  const generatePath  = `/api/customer-info/by-contact/${contactId}/generate-link`;
  const sendPath      = '/api/card-actions/upload-photos-and-info';
  const fakeLinkBody  = JSON.stringify({
    formLink:  `https://privtest.example.com/ci/aabbcc112233ddeeff445566778899aabbcc112233ddeeff44556677889900aa`,
    token:     'aabbcc112233ddeeff445566778899aabbcc112233ddeeff44556677889900aa',
    expiresAt: '2099-12-31T23:59:59.000Z',
  });
  const generateErrorBody = JSON.stringify({ error: 'No email address found' });

  return `
(function() {
  // 1. Synchronous auth bootstrap — set directly as object (JSON is valid JS).
  window.__moHeaderUser = ${fakeUserJson};

  // 2. Shared capture state (accessed by the test via page.evaluate).
  window.__clTestCapture = {
    generateLinkCalled: false,
    sendCalled:         false,
    sendBody:           null,
  };

  var originalFetch = window.fetch;
  var GENERATE_PATH = ${JSON.stringify(generatePath)};
  var SEND_PATH     = ${JSON.stringify(sendPath)};
  var GENERATE_STATUS = ${generateLinkStatus};
  var FAKE_LINK_BODY  = ${JSON.stringify(fakeLinkBody)};
  var ERROR_BODY      = ${JSON.stringify(generateErrorBody)};

  window.fetch = function(input, init) {
    var url      = typeof input === 'string' ? input : (input && input.url) || '';
    var parts    = url.match(/^https?:\\/\\/[^/]+(\\/.*)$/);
    var pathname = parts ? parts[1].split('?')[0] : url.split('?')[0];
    var method   = (init && init.method && init.method.toUpperCase()) || 'GET';

    // ── generate-link stub ───────────────────────────────────────────────────
    if (pathname === GENERATE_PATH && method === 'POST') {
      window.__clTestCapture.generateLinkCalled = true;
      var linkStatus = GENERATE_STATUS;
      var linkBody   = linkStatus >= 400 ? ERROR_BODY : FAKE_LINK_BODY;
      return Promise.resolve(new Response(linkBody, {
        status:  linkStatus,
        headers: { 'Content-Type': 'application/json' },
      }));
    }

    // ── upload-photos-and-info stub ──────────────────────────────────────────
    if (pathname === SEND_PATH && method === 'POST') {
      window.__clTestCapture.sendCalled = true;
      var rawBody = (init && init.body) || '';
      try { window.__clTestCapture.sendBody = JSON.parse(rawBody); } catch {}
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
        status:  200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }

    // ── pass everything else through ─────────────────────────────────────────
    return originalFetch.call(this, input, init);
  };
})();
  `.trim();
}

/**
 * Open /customers/:contactId with the fetch stubs active.
 * Stubs page-level API calls via page.setRequestInterception so the contact
 * detail page loads cleanly without requiring real HubSpot data.
 */
async function openCustomerDetailPage(browser, base, contactId, generateLinkStatus) {
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

  // Minimal contact JSON — must satisfy CustomerDetailPage validation.
  const contactBody    = JSON.stringify({
    id: contactId,
    properties: {
      firstname:         'CopyLink',
      lastname:          'TestContact',
      email:             'copy-link-test@privtest.local',
      hs_lead_status:    null,
      hw_lead_substatus: null,
      company:           null,
      phone:             null,
      mobilephone:       null,
      createdate:        '2024-01-01T00:00:00Z',
      lastmodifieddate:  '2024-01-01T00:00:00Z',
    },
  });
  const contactApiPath = `/api/contacts/${contactId}`;
  const byContactPath  = `/api/customer-info/by-contact/${contactId}`;

  // Exact-match stub map for the network-layer interceptor.
  // The generate-link and send endpoints are handled by the fetch override
  // installed via evaluateOnNewDocument (they never reach the network).
  const stubMap = {
    '/api/auth/user':               FAKE_USER_JSON,
    '/auth/status':                 JSON.stringify({ google: false, hubspot: false }),
    '/api/quickbooks/status':       JSON.stringify({ connected: false }),
    '/api/hubspot/status':          JSON.stringify({ status: 'ok' }),
    '/api/google/status':           JSON.stringify({ status: 'ok' }),
    '/api/database/status':         JSON.stringify({ status: 'ok' }),
    '/api/lead-statuses':           '[]',
    '/api/lead-substatuses':        '[]',
    '/api/localdata/all':           '{}',
    '/api/workflow':                '{}',
    '/api/card-action-handlers':    '[]',
    '/api/platform-users':          '[]',
    [contactApiPath]:               contactBody,
    [byContactPath]:                '[]',
    [`${contactApiPath}/localdata`]:'{}',
    [`${contactApiPath}/tasks`]:    '{"results":[]}',
    [`${contactApiPath}/google`]:   '{"connected":false,"emails":[]}',
    [`${contactApiPath}/whatsapp`]: '{"enabled":false,"messages":[]}',
  };

  await page.setRequestInterception(true);
  page.on('request', req => {
    const url      = req.url();
    const urlObj   = new URL(url);
    const pathname = urlObj.pathname;

    // Block navigation to /login.
    if (req.isNavigationRequest() && pathname === '/login') {
      req.abort('aborted').catch(() => {});
      return;
    }

    // Exact-match stubs.
    if (Object.prototype.hasOwnProperty.call(stubMap, pathname)) {
      req.respond({
        status:  200,
        headers: { 'Content-Type': 'application/json' },
        body:    stubMap[pathname],
      }).catch(() => {});
      return;
    }

    // Prefix-match stubs.
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

    // Pass everything else through (HTML, JS bundles, CSS, fonts, …).
    req.continue().catch(() => {});
  });

  // Install the fetch override + auth bootstrap BEFORE the page loads.
  await page.evaluateOnNewDocument(
    buildEvaluateScript(contactId, FAKE_USER_JSON, generateLinkStatus),
  );

  await page.goto(`${base}/customers/${contactId}`, {
    waitUntil: 'domcontentloaded',
    timeout:   30000,
  });

  return page;
}

/**
 * Open the UploadPhotosModal via window.openCardActionModal — the global
 * bridge registered in main.tsx (always available once the React bundle runs,
 * unlike window.dispatchCardActionHandler which requires useCardActionHandlers
 * to be mounted on the page).
 *
 * Waits for the #card-action-modals-host container, then poll-calls
 * openCardActionModal until the MUI Dialog appears.  Calls before the
 * CardActionModalsHost opener is registered are silent no-ops; subsequent
 * calls open the modal once the opener is ready.
 */
async function openUploadModal(page, contactId, contactName, contactEmail) {
  // Wait for window.openCardActionModal to be set (immediately after bundle
  // evaluates and main.tsx module code runs).
  const fnReady = await pollPage(page, () =>
    typeof window.openCardActionModal === 'function' ? 'ok' : null,
    20000,
  );
  if (!fnReady) return false;

  // Wait for initCardActionModalsHost() to create the host container.
  const containerReady = await pollPage(page, () =>
    document.getElementById('card-action-modals-host') ? 'ok' : null,
    10000,
  );
  if (!containerReady) return false;

  const handler = { id: 9999, type: 'upload_photos_and_info', config: {}, bindings: [] };
  const ctx     = { contactId, contactName, contactEmail };

  // Poll-retry: the opener is registered asynchronously by CardActionModalsHost
  // useEffect after the React component mounts.  Calls before that are no-ops.
  const dialogVisible = await (async () => {
    const deadline = Date.now() + 12000;
    let called = false;
    while (Date.now() < deadline) {
      // Only call openCardActionModal once — repeated calls while the modal is
      // already open would re-open it with new props, potentially aborting the
      // in-flight generate-link fetch via its AbortController cleanup.
      if (!called) {
        const opened = await page.evaluate((h, c) => {
          if (typeof window.openCardActionModal !== 'function') return false;
          window.openCardActionModal(h, c);
          return true;
        }, handler, ctx);
        if (opened) called = true;
      }

      const got = await page.evaluate(() => {
        // MUI Dialog uses position:fixed so offsetParent is null even when
        // visible.  Check aria-hidden to confirm it is actually open (not just
        // present in the DOM but hidden).
        const d = document.querySelector('[data-testid="upload-photos-dialog"]');
        return (d && d.getAttribute('aria-hidden') !== 'true') ? 'ok' : null;
      }).catch(() => null);
      if (got) return 'ok';

      await new Promise(r => setTimeout(r, 300));
    }
    return null;
  })();

  return !!dialogVisible;
}

// ── Report writer ─────────────────────────────────────────────────────────────

async function writeReport(runId) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc    = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok && !f.skipped).length;
  const skipped = findings.filter(f => f.skipped).length;
  const lines = [
    '# Copyable-Link Flow — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:copyable-link\``,
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
    '- **[CL-1] Link field appears**: after `POST generate-link` resolves the modal',
    '  renders a read-only TextField whose value equals `formLink`.  Regression',
    '  guard for the generate-on-open pattern in `UploadPhotosModal.tsx`.',
    '- **[CL-2] Token forwarded on send**: clicking "Send email" POSTs',
    '  `{ contactId, token }` to `upload-photos-and-info` where `token` matches',
    '  the value returned by `generate-link` — no new token is minted.',
    '- **[CL-3] Link still copyable post-send**: after the send succeeds the',
    '  confirmation view shows the "Link (still copyable):" section with the',
    '  same `formLink` value.',
    '- **[CL-4] Generate-link error disables send**: when `generate-link` returns',
    '  a 4xx the modal shows an error message and the "Send email" button is',
    '  disabled (`disabled` attribute present).',
    '',
    '## Relevant files',
    '',
    '- `src/react/components/modals/UploadPhotosModal.tsx`',
    '- `customer-info.js` (generate-link and upload-photos-and-info endpoints)',
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

  const runId = Math.random().toString(36).slice(2, 8);
  // contactId must be all-digits: CustomerDetailPage validates with /^\d+$/
  const contactId = String(200000000000 + Math.floor(Math.random() * 799999999999));

  console.log(`\n  copyable-link E2E  run=${runId}`);
  console.log(`  contactId=${contactId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const ALL_PROBE_LABELS = [
    '[CL-1] link field appears after generate-link resolves',
    '[CL-2] send email forwards the generated token to upload-photos-and-info',
    '[CL-3] link field still visible in post-send confirmation state',
    '[CL-4] generate-link failure disables Send email and shows error message',
  ];

  if (!puppeteer) {
    for (const l of ALL_PROBE_LABELS) skip(l, 'puppeteer not installed — skipped');
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
  process.on('uncaughtException',  e  => { console.error('Uncaught:',  e);  teardown().then(() => process.exit(2)); });
  process.on('unhandledRejection', e  => { console.error('Unhandled:', e);  teardown().then(() => process.exit(2)); });

  try {
    await waitForServer();
    await resetRateLimitStore(pool);
    console.log(`  Server up at ${BASE}`);

    await seedUsers(pool, runId);

    const { findChromium } = require('../shared/find-chromium');
    const executablePath   = findChromium() || undefined;

    const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
    let browserLaunchErr = null;
    const launchAttempts = [{ args: launchArgs }];
    if (executablePath) launchAttempts.push({ executablePath, args: launchArgs });
    for (const opts of launchAttempts) {
      try {
        browser = await puppeteer.launch({ headless: true, ...opts });
        browserLaunchErr = null;
        break;
      } catch (e) { browserLaunchErr = e; browser = null; }
    }

    if (!browser) {
      const msg = (browserLaunchErr?.message || String(browserLaunchErr)).slice(0, 200);
      for (const l of ALL_PROBE_LABELS) skip(l, `browser launch failed: ${msg}`);
      await writeReport(runId);
      await teardown();
      process.exit(1);
      return;
    }

    // ── Probes CL-1, CL-2, CL-3 — happy-path flow ────────────────────────────
    console.log('\n  [CL-1/2/3] happy-path: generate-link succeeds → send email');

    const pageHappy = await openCustomerDetailPage(browser, BASE, contactId, 200);

    const modalOpened = await openUploadModal(
      pageHappy, contactId,
      'CopyLink TestContact',
      'copy-link-test@privtest.local',
    );

    if (!modalOpened) {
      const errMsg = (pageHappy.__logs || []).slice(0, 3).join('; ');
      for (const l of ALL_PROBE_LABELS.slice(0, 3)) {
        record(l, false, 'MUI Dialog did not open' + (errMsg ? ` | page errors: ${errMsg}` : ''));
      }
    } else {
      // ── [CL-1] Link field appears ──────────────────────────────────────────
      console.log('  [CL-1] waiting for link field…');

      // Wait for generate-link to complete: poll for a readonly input whose
      // value contains our fake token's marker string.
      const linkFieldValue = await pollPage(pageHappy, () => {
        const dialog = document.querySelector('[data-testid="upload-photos-dialog"]');
        if (!dialog) return null;
        // Look for all inputs — MUI TextField with readOnly renders a standard
        // <input readonly> element.  Also accept inputs whose .readOnly JS
        // property is true (which React sets even without the HTML attribute
        // when using slotProps.input.readOnly).
        const inputs = Array.from(dialog.querySelectorAll('input'));
        for (const inp of inputs) {
          if (inp.readOnly && inp.value && inp.value.includes('privtest.example.com')) {
            return inp.value;
          }
        }
        return null;
      }, 12000);

      const cl1ok = linkFieldValue === FAKE_FORM_LINK;
      record(
        ALL_PROBE_LABELS[0],
        cl1ok,
        cl1ok
          ? `link field value = "${FAKE_FORM_LINK}"`
          : `link field value = "${linkFieldValue || 'not found'}" (expected "${FAKE_FORM_LINK}")`,
      );

      // ── [CL-2] Send email forwards the token ──────────────────────────────
      console.log('  [CL-2] clicking Send email…');

      // Wait for the Send email button to be enabled (generate-link settled
      // and generatingLink is back to false).
      const sendEnabled = await pollPage(pageHappy, () => {
        const btn = document.querySelector('[data-testid="cah-primary"]');
        if (!btn) return null;
        return !btn.disabled ? 'ok' : null;
      }, 10000);

      if (!sendEnabled) {
        record(ALL_PROBE_LABELS[1], false, '"Send email" button never became enabled');
        record(ALL_PROBE_LABELS[2], false, 'skipped — send button not enabled');
      } else {
        await pageHappy.evaluate(() => {
          const btn = document.querySelector('[data-testid="cah-primary"]');
          if (btn) btn.click();
        });

        // Wait for the send to complete (confirmation state).
        const confirmVisible = await pollPage(pageHappy, () => {
          const dialog = document.querySelector('[data-testid="upload-photos-dialog"]');
          if (!dialog) return null;
          return (dialog.textContent || '').includes('email has been sent') ? 'ok' : null;
        }, 10000);

        // Read capture state from the browser context.
        const capture = await pageHappy.evaluate(() => window.__clTestCapture || {});

        const cl2ok = (
          !!capture.sendCalled
          && capture.sendBody !== null
          && capture.sendBody.contactId === contactId
          && capture.sendBody.token     === FAKE_TOKEN
          && !!confirmVisible
        );
        record(
          ALL_PROBE_LABELS[1],
          cl2ok,
          cl2ok
            ? `upload-photos-and-info received token="${FAKE_TOKEN}" and contactId="${contactId}"`
            : `capture=${JSON.stringify(capture)} confirmVisible=${confirmVisible}`,
        );

        // ── [CL-3] Link field still visible post-send ──────────────────────
        console.log('  [CL-3] checking link field in confirmation state…');

        if (!confirmVisible) {
          record(ALL_PROBE_LABELS[2], false, 'confirmation state ("email has been sent") not reached');
        } else {
          const postSendState = await pageHappy.evaluate((expectedLink) => {
            const dialog = document.querySelector('[data-testid="upload-photos-dialog"]');
            if (!dialog) return { confirmText: false, linkVisible: false, linkValue: null };
            const text   = dialog.textContent || '';
            const inputs = Array.from(dialog.querySelectorAll('input'));
            const linkInp = inputs.find(i => i.readOnly && i.value && i.value.includes('privtest.example.com'));
            return {
              confirmText:          text.includes('email has been sent'),
              linkVisible:          !!linkInp,
              linkValue:            linkInp ? linkInp.value : null,
              stillCopyableCaption: text.includes('still copyable'),
            };
          }, FAKE_FORM_LINK);

          const cl3ok = (
            postSendState.confirmText
            && postSendState.linkVisible
            && postSendState.linkValue === FAKE_FORM_LINK
            && postSendState.stillCopyableCaption
          );
          record(
            ALL_PROBE_LABELS[2],
            cl3ok,
            cl3ok
              ? 'post-send: "Link (still copyable):" caption and link field present'
              : `post-send state: ${JSON.stringify(postSendState)}`,
          );
        }
      }
    }
    await pageHappy.__ctx.close().catch(() => {});

    // ── Probe CL-4 — generate-link failure ────────────────────────────────────
    console.log('\n  [CL-4] generate-link 400 error → Send email disabled + error shown');

    const pageError = await openCustomerDetailPage(browser, BASE, contactId, 400);

    const modalOpenedErr = await openUploadModal(
      pageError, contactId,
      'CopyLink TestContact',
      'copy-link-test@privtest.local',
    );

    if (!modalOpenedErr) {
      const errMsg2 = (pageError.__logs || []).slice(0, 3).join('; ');
      record(ALL_PROBE_LABELS[3], false, 'MUI Dialog did not open' + (errMsg2 ? ` | ${errMsg2}` : ''));
    } else {
      // Wait for generate-link to complete.  While generate-link is in flight
      // the modal shows "Generating link…" and the button is disabled.
      // After completion with an error, the button stays disabled and the
      // error message appears.  We poll until the "Generating link…" spinner
      // is gone, then snapshot the error state.
      const errorState = await pollPage(pageError, () => {
        const dialog = document.querySelector('[data-testid="upload-photos-dialog"]');
        if (!dialog) return null;
        const text = dialog.textContent || '';
        // Still loading — wait for it to settle.
        if (text.includes('Generating link')) return null;
        const btn     = dialog.querySelector('[data-testid="cah-primary"]');
        const hasErr  = text.includes('Could not generate link') || text.includes('No email address found');
        const btnDisabled = btn ? btn.disabled : true;
        return { hasErr, btnDisabled, text: text.slice(0, 300) };
      }, 15000);

      const cl4ok = !!(
        errorState
        && errorState.hasErr
        && errorState.btnDisabled
      );
      record(
        ALL_PROBE_LABELS[3],
        cl4ok,
        cl4ok
          ? '"Could not generate link" / "No email address found" shown; Send email button disabled'
          : `error state: ${JSON.stringify(errorState)}`,
      );
    }
    await pageError.__ctx.close().catch(() => {});

    exitCode = findings.every(f => f.ok) ? 0 : 1;
    const failedCount = findings.filter(f => !f.ok).length;
    console.log(`\n  Results: ${findings.length - failedCount} passed, ${failedCount} failed`);

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
