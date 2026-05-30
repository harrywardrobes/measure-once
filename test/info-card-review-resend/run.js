'use strict';
const { makeSkip3 } = require('../helpers/report');
// test/info-card-review-resend/run.js
//
// Regression guard for the Review vs Resend-link button branching logic
// in SubmissionCard (CustomerInfoSubmissionsRail).
//
// Probes:
//   [RR-A] Submitted submission (submitted_at non-null):
//          "Review" button is visible; [data-testid="resend-link-btn"] is absent.
//
//   [RR-B] Pending submission (submitted_at null, expires_at in the future):
//          [data-testid="resend-link-btn"] is visible (admin role → canResend=true);
//          "Review" button is absent.
//
//   [RR-C] Clicking "Review" in probe A expands the detail panel:
//          [data-testid="submission-card-body"] becomes visible
//          (getBoundingClientRect().height > 0).
//
// Strategy: boots a disposable test server with the privileges harness.
// Uses two intercept layers for each probe (same pattern as
// test/skipped-photo-warning/run.js):
//
//   1. page.setRequestInterception — stubs GET /api/customer-info/by-contact/:id
//      with the appropriate fixture and provides minimal empty stubs for all
//      other page-level API calls so the React page mounts cleanly.
//
//   2. evaluateOnNewDocument — sets window.__moHeaderUser to a fake admin
//      user so AuthContext initialises synchronously without triggering a
//      /login redirect.
//
// contactId must be all-digits (/^\d+$/) because CustomerDetailPage validates
// it with that regex and returns "Invalid customer ID." early if it fails.
//
// Usage:
//   DATABASE_URL_TEST=<disposable>  npm run test:info-card-review-resend
//   PRIVTEST_ALLOW_SHARED_DB=1      npm run test:info-card-review-resend

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

require('dotenv').config();

const { pollUntil } = require('../helpers/poll');

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'info-card-review-resend.md',
);

const findings = [];
function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}
const skip = makeSkip3(findings);

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Synthetic contact JSON — minimal shape that satisfies CustomerDetailPage.
function makeContactBody(contactId) {
  return JSON.stringify({
    id: contactId,
    properties: {
      firstname:         'InfoCard',
      lastname:          'ReviewTest',
      email:             'info-card-test@privtest.local',
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

// Submitted submission — submitted_at is non-null → Review button.
function makeSubmittedBody() {
  return JSON.stringify([
    {
      id:                  1,
      created_at:          '2024-02-01T10:00:00Z',
      submitted_at:        '2024-02-02T12:00:00Z',
      expires_at:          '2099-01-01T00:00:00Z',
      contact_name:        'InfoCard ReviewTest',
      contact_email:       'info-card-test@privtest.local',
      corrected_email:     null,
      corrected_mobile:    null,
      address_line1:       '1 Test Street',
      city:                'London',
      postcode:            'SW1A 1AA',
      room_count:          '2',
      room_notes:          null,
      photo_keys:          [],
      photoUrls:           [],
      email_skipped_count: 0,
    },
  ]);
}

// Pending submission — submitted_at is null, expires well in the future.
function makePendingBody() {
  return JSON.stringify([
    {
      id:                  2,
      created_at:          '2024-03-01T10:00:00Z',
      submitted_at:        null,
      expires_at:          '2099-01-01T00:00:00Z',
      contact_name:        'InfoCard ReviewTest',
      contact_email:       'info-card-test@privtest.local',
      corrected_email:     null,
      corrected_mobile:    null,
      address_line1:       null,
      city:                null,
      postcode:            null,
      room_count:          null,
      room_notes:          null,
      photo_keys:          [],
      photoUrls:           [],
      email_skipped_count: 0,
    },
  ]);
}

// Fake admin user for window.__moHeaderUser.
const FAKE_USER_OBJ = {
  id:                'rr-test-admin',
  first_name:        'InfoCard',
  last_name:         'TestAdmin',
  privilege_level:   'admin',
  onboarding_status: 'active',
  has_custom_photo:  false,
  profile_image_url: null,
  photo_v:           null,
};
const FAKE_USER_JSON = JSON.stringify(FAKE_USER_OBJ);

// ── Stub map builder ──────────────────────────────────────────────────────────

function buildStubMap(contactId, byContactBody, contactBody) {
  const contactApiPath = `/api/contacts/${contactId}`;
  const byContactPath  = `/api/customer-info/by-contact/${contactId}`;
  return {
    '/api/auth/user':                  FAKE_USER_JSON,
    '/auth/status':                    JSON.stringify({ google: false, hubspot: false }),
    '/api/quickbooks/status':          JSON.stringify({ connected: false }),
    '/api/hubspot/status':             JSON.stringify({ status: 'ok' }),
    '/api/google/status':              JSON.stringify({ status: 'ok' }),
    '/api/database/status':            JSON.stringify({ status: 'ok' }),
    '/api/lead-statuses':              '[]',
    '/api/lead-substatuses':           '[]',
    '/api/localdata/all':              '{}',
    '/api/workflow':                   '{}',
    '/api/card-action-handlers':       '[]',
    '/api/platform-users':             '[]',
    [contactApiPath]:                  contactBody,
    [byContactPath]:                   byContactBody,
    [`${contactApiPath}/localdata`]:   '{}',
    [`${contactApiPath}/tasks`]:       '{"results":[]}',
    [`${contactApiPath}/google`]:      '{"connected":false,"emails":[]}',
    [`${contactApiPath}/whatsapp`]:    '{"enabled":false,"messages":[]}',
  };
}

const PREFIX_STUBS = [
  { prefix: '/api/design-visits', body: '[]' },
  { prefix: '/api/rooms',         body: '[]' },
  { prefix: '/api/visits',        body: '[]' },
];

// ── Page helper ───────────────────────────────────────────────────────────────

async function openCustomerDetail(browser, base, contactId, byContactBody) {
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

  const contactBody = makeContactBody(contactId);
  const stubMap     = buildStubMap(contactId, byContactBody, contactBody);

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

  await page.evaluateOnNewDocument((fakeUserJson) => {
    window.__moHeaderUser = JSON.parse(fakeUserJson);
  }, FAKE_USER_JSON);

  await page.goto(`${base}/customers/${contactId}`, {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });

  return page;
}

async function pollPage(page, fn, timeoutMs = 15000, intervalMs = 200) {
  return pollUntil(page, fn, timeoutMs, intervalMs);
}

// Wait for the CustomerInfoSubmissionsRail section to appear in the DOM.
async function waitForSection(page) {
  return pollPage(
    page,
    () => !!document.getElementById('customer-info-submissions-section'),
    25000,
  );
}

// Wait for the loading spinner inside the section to disappear (data loaded).
async function waitForSectionLoaded(page) {
  return pollPage(page, () => {
    const section = document.getElementById('customer-info-submissions-section');
    if (!section) return null;
    return !section.querySelector('[role="progressbar"]') ? 'ok' : null;
  }, 15000);
}

// ── Report writer ─────────────────────────────────────────────────────────────

async function writeReport(runId) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc    = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok && !f.skipped).length;
  const skipped = findings.filter(f => f.skipped).length;
  const lines = [
    '# Info-Card Review vs Resend Button — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:info-card-review-resend\``,
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
    '- **[RR-A] Submitted → Review button**: `GET /api/customer-info/by-contact/:id`',
    '  returns a submission with `submitted_at` set. Asserts the "Review" button is',
    '  visible inside `#customer-info-submissions-section` and',
    '  `[data-testid="resend-link-btn"]` is absent.',
    '- **[RR-B] Pending → Resend link button**: Same endpoint returns a submission with',
    '  `submitted_at: null` and `expires_at` in the future. Admin role means',
    '  `canResend=true`. Asserts `[data-testid="resend-link-btn"]` is visible and',
    '  the "Review" button is absent.',
    '- **[RR-C] Click Review → expands detail**: From probe A, clicks the "Review"',
    '  button and polls for `[data-testid="submission-card-body"]` with',
    '  `getBoundingClientRect().height > 0` to confirm the Collapse body is visible.',
    '',
    '## Relevant files',
    '',
    '- `src/react/pages/customer-detail/CustomerInfoSubmissionsRail.tsx`',
    '  (SubmissionCard, lines ~137–220)',
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
  const contactId = String(100000000000 + Math.floor(Math.random() * 899999999999));

  console.log(`\n  info-card-review-resend  run=${runId}`);
  console.log(`  contactId=${contactId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const PROBE_LABELS = [
    '[RR-A] Review button visible for submitted submission',
    '[RR-A] Resend link absent for submitted submission',
    '[RR-B] Resend link visible for pending submission',
    '[RR-B] Review button absent for pending submission',
    '[RR-C] Clicking Review expands the detail panel',
  ];

  if (!puppeteer) {
    for (const l of PROBE_LABELS) skip(l, 'puppeteer not installed — skipped');
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

    try {
      browser = await puppeteer.launch({
        headless:        true,
        executablePath,
        defaultViewport: { width: 1280, height: 900 },
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
    } catch (launchErr) {
      const msg = (launchErr?.message || String(launchErr)).slice(0, 200);
      for (const l of PROBE_LABELS) record(l, false, `browser launch failed: ${msg}`);
      throw launchErr;
    }

    // ── [RR-A] + [RR-C] Submitted submission ─────────────────────────────────

    console.log('\n  [RR-A] submitted submission → Review button');
    const pageA = await openCustomerDetail(browser, BASE, contactId, makeSubmittedBody());

    const sectionA = await waitForSection(pageA);
    if (!sectionA) {
      const errA = pageA.__logs.slice(0, 3).join('; ');
      const msg = '#customer-info-submissions-section did not appear within 25 s'
        + (errA ? ` | page errors: ${errA}` : '');
      record(PROBE_LABELS[0], false, msg);
      record(PROBE_LABELS[1], false, 'skipped — section not found');
      record(PROBE_LABELS[4], false, 'skipped — section not found');
    } else {
      await waitForSectionLoaded(pageA);

      // [RR-A-1] Review button visible
      const reviewBtnFound = await pollPage(pageA, () => {
        const section = document.getElementById('customer-info-submissions-section');
        if (!section) return null;
        const btns = section.querySelectorAll('button');
        for (const b of btns) {
          if ((b.textContent || '').trim() === 'Review') return 'found';
        }
        return null;
      }, 12000);

      record(
        PROBE_LABELS[0],
        !!reviewBtnFound,
        reviewBtnFound
          ? '"Review" button found in submitted submission card'
          : '"Review" button not found within 12 s',
      );

      // [RR-A-2] Resend link button absent (negative assertion)
      await new Promise(r => setTimeout(r, 300));
      const resendPresentA = await pageA.evaluate(() =>
        !!document.querySelector('[data-testid="resend-link-btn"]'),
      );
      record(
        PROBE_LABELS[1],
        !resendPresentA,
        !resendPresentA
          ? '[data-testid="resend-link-btn"] correctly absent for submitted submission'
          : '[data-testid="resend-link-btn"] unexpectedly present for submitted submission',
      );

      // [RR-C] Click Review → Collapse expands, "Submitted" text appears
      if (reviewBtnFound) {
        console.log('\n  [RR-C] clicking Review → detail panel expands');

        // Click the Review button
        await pageA.evaluate(() => {
          const section = document.getElementById('customer-info-submissions-section');
          if (!section) return;
          const btns = section.querySelectorAll('button');
          for (const b of btns) {
            if ((b.textContent || '').trim() === 'Review') { b.click(); return; }
          }
        });

        // Two-phase check for [data-testid="submission-card-body"]:
        //   Phase 1 — confirm the element exists in the DOM (3 s timeout).
        //             A timeout here means the testid was removed from the
        //             component, not a timing/animation issue.
        //   Phase 2 — wait for the element to have height > 0 (10 s timeout).
        //             A timeout here is the usual animation/render delay.
        const bodyPresent = await pollPage(pageA, () =>
          document.querySelector('[data-testid="submission-card-body"]') ? 'found' : null,
        3000);

        let collapseOpen = null;
        if (bodyPresent) {
          collapseOpen = await pollPage(pageA, () => {
            const body = document.querySelector('[data-testid="submission-card-body"]');
            if (!body) return null;
            return body.getBoundingClientRect().height > 0 ? 'ok' : null;
          }, 10000);
        }

        record(
          PROBE_LABELS[4],
          !!collapseOpen,
          collapseOpen
            ? '[data-testid="submission-card-body"] visible (height > 0) after clicking Review'
            : !bodyPresent
              ? '[data-testid="submission-card-body"] not found in DOM — testid may have been removed'
              : '[data-testid="submission-card-body"] did not become visible within 10 s',
        );
      } else {
        record(PROBE_LABELS[4], false, 'skipped — Review button was not found in probe A');
      }
    }
    await pageA.__ctx.close().catch(() => {});

    // ── [RR-B] Pending submission ─────────────────────────────────────────────

    console.log('\n  [RR-B] pending submission → Resend link button');
    const pageB = await openCustomerDetail(browser, BASE, contactId, makePendingBody());

    const sectionB = await waitForSection(pageB);
    if (!sectionB) {
      const errB = pageB.__logs.slice(0, 3).join('; ');
      const msg = '#customer-info-submissions-section did not appear within 25 s'
        + (errB ? ` | page errors: ${errB}` : '');
      record(PROBE_LABELS[2], false, msg);
      record(PROBE_LABELS[3], false, 'skipped — section not found');
    } else {
      await waitForSectionLoaded(pageB);

      // [RR-B-1] Resend link button visible (admin → canResend=true)
      const resendBtnFound = await pollPage(pageB, () =>
        !!document.querySelector('[data-testid="resend-link-btn"]'),
      12000);

      record(
        PROBE_LABELS[2],
        !!resendBtnFound,
        resendBtnFound
          ? '[data-testid="resend-link-btn"] found for pending submission (admin)'
          : '[data-testid="resend-link-btn"] not found within 12 s',
      );

      // [RR-B-2] Review button absent (negative assertion)
      await new Promise(r => setTimeout(r, 300));
      const reviewPresentB = await pageB.evaluate(() => {
        const section = document.getElementById('customer-info-submissions-section');
        if (!section) return false;
        const btns = section.querySelectorAll('button');
        for (const b of btns) {
          if ((b.textContent || '').trim() === 'Review') return true;
        }
        return false;
      });

      record(
        PROBE_LABELS[3],
        !reviewPresentB,
        !reviewPresentB
          ? '"Review" button correctly absent for pending submission'
          : '"Review" button unexpectedly present for pending submission',
      );
    }
    await pageB.__ctx.close().catch(() => {});

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
    await writeReport(runId);
    await teardown();
    process.exit(exitCode);
  }
}

main();
