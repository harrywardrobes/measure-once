'use strict';
// test/skipped-photo-warning/run.js
//
// Regression guard for the skipped-photo warning alert added in task #1905.
//
// When photos are too large to attach to the admin notification email, the
// server stores email_skipped_count on the submission row.  The
// CustomerInfoSubmissionsRail must render an MUI Alert with that count inside
// the expanded SubmissionCard.
//
// Probes:
//   [SKP-A] Plural form  (email_skipped_count=2): warning Alert with
//           "2 photos were too large…" is visible after expanding the card.
//   [SKP-B] Singular form (email_skipped_count=1): warning Alert with
//           "1 photo was too large…" is visible after expanding the card.
//   [SKP-C] No warning   (email_skipped_count=0): the warning Alert is
//           absent even after expanding the card (negative case).
//
// Strategy: boots a disposable test server, drives /customers/:contactId
// with Puppeteer.  Uses two intercept layers:
//
//   1. page.setRequestInterception — intercepts at the network layer to:
//        • Return controlled JSON for the contact and customer-info APIs.
//        • Stub all other page-level API calls with minimal empty responses.
//        • Pre-emptively abort any navigation to /login (which WorkflowDataContext
//          might trigger on 401) so the page stays stable for assertions.
//
//   2. evaluateOnNewDocument — sets window.__moHeaderUser so the React
//        AuthContext initialises synchronously with a fake admin user (no
//        redirect to /login from AppBootstrapProvider).
//
// contactId must be all-digits (/^\d+$/) because CustomerDetailPage validates
// it with that regex and returns "Invalid customer ID." early if it fails.
//
// Usage:
//   DATABASE_URL_TEST=<disposable>  npm run test:skipped-photo-warning
//   PRIVTEST_ALLOW_SHARED_DB=1      npm run test:skipped-photo-warning

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

require('dotenv').config();

const { pollUntil } = require('../helpers/poll');

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'skipped-photo-warning.md',
);

const findings = [];
function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}

// ── Puppeteer helpers ─────────────────────────────────────────────────────────

async function pollPage(page, fn, timeoutMs = 15000, intervalMs = 200) {
  return pollUntil(page, fn, timeoutMs, intervalMs);
}

// Synthetic contact JSON — minimal shape that satisfies CustomerDetailPage.
function makeContactBody(contactId) {
  return JSON.stringify({
    id: contactId,
    properties: {
      firstname:         'Skipped',
      lastname:          'PhotoTest',
      email:             'skipped-photo@privtest.local',
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

// Synthetic by-contact response.  photoUrls must be non-empty so the Photos
// section is rendered by SubmissionCard (the warning only renders inside it).
function makeByContactBody(emailSkippedCount) {
  // Use a data URI so no real image request is made to the test server.
  const dataImg = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  return JSON.stringify([
    {
      id:                  1,
      created_at:          '2024-02-01T10:00:00Z',
      submitted_at:        '2024-02-02T12:00:00Z',
      expires_at:          '2099-01-01T00:00:00Z',
      contact_name:        'Skipped PhotoTest',
      contact_email:       'skipped-photo@privtest.local',
      corrected_email:     null,
      corrected_mobile:    null,
      address_line1:       '1 Test Street',
      city:                'London',
      postcode:            'SW1A 1AA',
      room_count:          '2',
      room_notes:          null,
      photo_keys:          ['obj:ci_key1'],
      photoUrls:           [dataImg],
      email_skipped_count: emailSkippedCount,
    },
  ]);
}

// A minimal fake CurrentUser object.
const FAKE_USER_OBJ = {
  id:                'skptest-admin',
  first_name:        'Skipped',
  last_name:         'TestAdmin',
  privilege_level:   'admin',
  onboarding_status: 'active',
  has_custom_photo:  false,
  profile_image_url: null,
  photo_v:           null,
};
const FAKE_USER_JSON = JSON.stringify(FAKE_USER_OBJ);

// Build the flat map of pathname → response body used by the request interceptor.
// This is constructed fresh for each probe (contactId-dependent paths vary).
function buildStubMap(contactId, byContactBody, contactBody) {
  const contactApiPath = `/api/contacts/${contactId}`;
  const byContactPath  = `/api/customer-info/by-contact/${contactId}`;
  return {
    '/api/auth/user':                            FAKE_USER_JSON,
    '/auth/status':                              JSON.stringify({ google: false, hubspot: false }),
    '/api/quickbooks/status':                    JSON.stringify({ connected: false }),
    '/api/hubspot/status':                       JSON.stringify({ status: 'ok' }),
    '/api/google/status':                        JSON.stringify({ status: 'ok' }),
    '/api/database/status':                      JSON.stringify({ status: 'ok' }),
    '/api/lead-statuses':                        '[]',
    '/api/lead-substatuses':                     '[]',
    '/api/localdata/all':                        '{}',
    '/api/workflow':                             '{}',
    '/api/card-action-handlers':                 '[]',
    '/api/platform-users':                       '[]',
    [contactApiPath]:                            contactBody,
    [byContactPath]:                             byContactBody,
    [`${contactApiPath}/localdata`]:             '{}',
    [`${contactApiPath}/tasks`]:                 '{"results":[]}',
    [`${contactApiPath}/google`]:                '{"connected":false,"emails":[]}',
    [`${contactApiPath}/whatsapp`]:              '{"enabled":false,"messages":[]}',
  };
}

// Prefix-match stubs (any API path starting with these patterns).
const PREFIX_STUBS = [
  { prefix: '/api/design-visits', body: '[]' },
  { prefix: '/api/rooms',         body: '[]' },
  { prefix: '/api/visits',        body: '[]' },
];

// Open /customers/:contactId in a fresh incognito context.
// Installs two intercept layers before navigating:
//   1. setRequestInterception — stubs API calls and aborts /login redirects.
//   2. evaluateOnNewDocument — sets window.__moHeaderUser for synchronous auth.
async function openCustomerDetail(browser, base, contactId, emailSkippedCount) {
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

  const byContactBody = makeByContactBody(emailSkippedCount);
  const contactBody   = makeContactBody(contactId);
  const stubMap       = buildStubMap(contactId, byContactBody, contactBody);

  // ── Layer 1: Network interception ─────────────────────────────────────────
  // Intercept at the HTTP level so no actual requests reach the test server
  // for any of the API endpoints.  This is more reliable than window.fetch
  // overrides because it fires before any JS runs and cannot be bypassed by
  // code that caches the original fetch.
  await page.setRequestInterception(true);
  page.on('request', req => {
    const url      = req.url();
    const resType  = req.resourceType();
    const urlObj   = new URL(url);
    const pathname = urlObj.pathname;

    // Block navigation to /login — WorkflowDataContext may attempt this if
    // it sees a 401.  With all API calls stubbed this should never happen,
    // but abort it as a safety net so the test page stays stable.
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

    // Pass everything else through (HTML page, JS bundles, CSS, fonts, …).
    req.continue().catch(() => {});
  });

  // ── Layer 2: evaluateOnNewDocument — synchronous auth bootstrap ───────────
  // Sets window.__moHeaderUser so that AuthContext initialises with the fake
  // user before any React code runs.  This prevents the first-render from
  // having user=null which would trigger a /login redirect in AppBootstrapInner
  // before the async fetchUser() promise resolves.
  await page.evaluateOnNewDocument((fakeUserJson) => {
    window.__moHeaderUser = JSON.parse(fakeUserJson);
  }, FAKE_USER_JSON);

  await page.goto(`${base}/customers/${contactId}`, {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });

  return page;
}

// Wait for the CustomerInfoSubmissionsRail section mount point to appear.
// The section renders when loading=true (initial fetch in flight) or when
// submissions.length > 0 (fetch complete).
async function waitForSection(page) {
  return pollPage(
    page,
    () => !!document.getElementById('customer-info-submissions-section'),
    25000,
  );
}

// Expand the first SubmissionCard by clicking the header area.
// The CustomerInfoSubmissionsRail section header has cursor:pointer on the
// Box that wraps the title row; an inner text of "Customer Info" is present.
// We also try clicking anything containing "Sent " date text inside the card.
async function expandFirstCard(page) {
  await page.evaluate(() => {
    const section = document.getElementById('customer-info-submissions-section');
    if (!section) return;
    // The SubmissionCard header is a Box with cursor:pointer containing date text.
    const elements = Array.from(section.querySelectorAll('*'));
    for (const el of elements) {
      const style = window.getComputedStyle(el);
      const text  = el.textContent || '';
      if (style.cursor === 'pointer' && (text.includes('Sent ') || text.includes('Feb'))) {
        el.click();
        return;
      }
    }
    // Fallback: click any pointer-cursor element inside the section.
    for (const el of elements) {
      if (window.getComputedStyle(el).cursor === 'pointer') {
        el.click();
        return;
      }
    }
  });
}

// Wait until the Collapse transition ends and the expanded content is present.
async function waitForExpanded(page) {
  return pollPage(page, () => {
    const s = document.getElementById('customer-info-submissions-section');
    if (!s) return null;
    const t = s.textContent || '';
    return (t.includes('Submitted') || t.includes('photo') || t.includes('No photos')) ? 'ok' : null;
  }, 12000);
}

// ── Report writer ─────────────────────────────────────────────────────────────

async function writeReport(runId) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc    = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok).length;
  const lines = [
    '# Skipped-Photo Warning — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:skipped-photo-warning\``,
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
    '- **[SKP-A] Plural warning**: `GET /api/customer-info/by-contact/:id` is stubbed to',
    '  return `email_skipped_count: 2` with one `photoUrl`. After expanding the',
    '  `SubmissionCard`, the MUI Alert (role="alert") must contain the plural copy.',
    '- **[SKP-B] Singular warning**: Same stub with `email_skipped_count: 1`. The Alert',
    '  must contain the singular copy.',
    '- **[SKP-C] No warning**: `email_skipped_count: 0`. The Alert must be absent even',
    '  after expanding the card.',
    '',
    '## Relevant files',
    '',
    '- `src/react/pages/customer-detail/CustomerInfoSubmissionsRail.tsx`',
    '- `customer-info.js` (email_skipped_count column)',
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
  // and returns "Invalid customer ID." early if it fails.
  // Use a large random 12-digit number to avoid colliding with real HubSpot IDs;
  // all fetches are stubbed so no real DB/HubSpot call is made.
  const contactId = String(100000000000 + Math.floor(Math.random() * 899999999999));

  console.log(`\n  skipped-photo-warning  run=${runId}`);
  console.log(`  contactId=${contactId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const PROBE_LABELS = [
    '[SKP-A] plural warning alert visible (email_skipped_count=2)',
    '[SKP-A] plural warning text correct',
    '[SKP-B] singular warning alert visible (email_skipped_count=1)',
    '[SKP-B] singular warning text correct',
    '[SKP-C] no warning alert when email_skipped_count=0',
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

    // Seed users so the test server starts in a known clean state.
    await seedUsers(pool, runId);

    const { findChromium } = require('../shared/find-chromium');
    const executablePath   = findChromium() || undefined;

    browser = await puppeteer.launch({
      headless:        true,
      executablePath,
      defaultViewport: { width: 1280, height: 900 },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    // ── [SKP-A] email_skipped_count=2 — plural warning ───────────────────────

    console.log('\n  [SKP-A] email_skipped_count=2');
    const pageA = await openCustomerDetail(browser, BASE, contactId, 2);

    const sectionA = await waitForSection(pageA);
    if (!sectionA) {
      const errA = pageA.__logs.slice(0, 3).join('; ');
      record(PROBE_LABELS[0], false, '#customer-info-submissions-section did not appear within 25 s'
        + (errA ? ` | page errors: ${errA}` : ''));
      record(PROBE_LABELS[1], false, 'skipped — section not found');
    } else {
      await expandFirstCard(pageA);
      await waitForExpanded(pageA);

      // Poll until the warning Alert appears.  MUI Alert with severity="warning"
      // renders with role="alert" on its root element.
      const alertTextA = await pollPage(pageA, () => {
        const section = document.getElementById('customer-info-submissions-section');
        if (!section) return null;
        const alerts = section.querySelectorAll('[role="alert"]');
        for (const a of alerts) {
          const t = a.textContent || '';
          if (t.includes('too large to attach')) return t.trim();
        }
        return null;
      }, 10000);

      record(
        PROBE_LABELS[0],
        !!alertTextA,
        alertTextA
          ? `warning Alert found: "${alertTextA.slice(0, 120)}"`
          : 'warning Alert [role="alert"] with "too large to attach" text not found within 10 s',
      );

      const pluralOk = !!alertTextA
        && alertTextA.includes('2 photos were')
        && alertTextA.includes('they are still viewable here');
      record(
        PROBE_LABELS[1],
        pluralOk,
        pluralOk
          ? 'plural copy correct ("2 photos were … they are still viewable here")'
          : `alert text: "${(alertTextA || '').slice(0, 200)}"`,
      );
    }
    await pageA.__ctx.close().catch(() => {});

    // ── [SKP-B] email_skipped_count=1 — singular warning ─────────────────────

    console.log('\n  [SKP-B] email_skipped_count=1');
    const pageB = await openCustomerDetail(browser, BASE, contactId, 1);

    const sectionB = await waitForSection(pageB);
    if (!sectionB) {
      const errB = pageB.__logs.slice(0, 3).join('; ');
      record(PROBE_LABELS[2], false, '#customer-info-submissions-section did not appear within 25 s'
        + (errB ? ` | page errors: ${errB}` : ''));
      record(PROBE_LABELS[3], false, 'skipped — section not found');
    } else {
      await expandFirstCard(pageB);
      await waitForExpanded(pageB);

      const alertTextB = await pollPage(pageB, () => {
        const section = document.getElementById('customer-info-submissions-section');
        if (!section) return null;
        const alerts = section.querySelectorAll('[role="alert"]');
        for (const a of alerts) {
          const t = a.textContent || '';
          if (t.includes('too large to attach')) return t.trim();
        }
        return null;
      }, 10000);

      record(
        PROBE_LABELS[2],
        !!alertTextB,
        alertTextB
          ? `warning Alert found: "${alertTextB.slice(0, 120)}"`
          : 'warning Alert [role="alert"] with "too large to attach" text not found within 10 s',
      );

      const singularOk = !!alertTextB
        && alertTextB.includes('1 photo was')
        && alertTextB.includes('it is still viewable here');
      record(
        PROBE_LABELS[3],
        singularOk,
        singularOk
          ? 'singular copy correct ("1 photo was … it is still viewable here")'
          : `alert text: "${(alertTextB || '').slice(0, 200)}"`,
      );
    }
    await pageB.__ctx.close().catch(() => {});

    // ── [SKP-C] email_skipped_count=0 — no warning ───────────────────────────

    console.log('\n  [SKP-C] email_skipped_count=0');
    const pageC = await openCustomerDetail(browser, BASE, contactId, 0);

    const sectionC = await waitForSection(pageC);
    if (!sectionC) {
      const errC = pageC.__logs.slice(0, 3).join('; ');
      record(PROBE_LABELS[4], false, '#customer-info-submissions-section did not appear within 25 s'
        + (errC ? ` | page errors: ${errC}` : ''));
    } else {
      await expandFirstCard(pageC);
      await waitForExpanded(pageC);

      // Give a short settle time then assert the Alert is absent.
      await new Promise(r => setTimeout(r, 1500));

      const alertPresentC = await pageC.evaluate(() => {
        const section = document.getElementById('customer-info-submissions-section');
        if (!section) return false;
        const alerts = section.querySelectorAll('[role="alert"]');
        for (const a of alerts) {
          if ((a.textContent || '').includes('too large to attach')) return true;
        }
        return false;
      });

      record(
        PROBE_LABELS[4],
        !alertPresentC,
        !alertPresentC
          ? 'no warning Alert present when email_skipped_count=0 (correct)'
          : 'warning Alert found unexpectedly when email_skipped_count=0',
      );
    }
    await pageC.__ctx.close().catch(() => {});

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
