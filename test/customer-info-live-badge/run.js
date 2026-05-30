'use strict';
const { makeSkip3 } = require('../helpers/report');

const PROBE_LABELS = [
  '(CI-LB-1) "Photos received" badge absent on initial page load',
  '(CI-LB-2) POST /api/customer-info/:token returns 200 ok:true',
  '(CI-LB-3) SSE push triggers re-fetch and badge appears without page reload',
];

// test/customer-info-live-badge/run.js
//
// Regression guard for the SSE → re-fetch → "Photos received" badge flow
// (task #1754 / task #1771).
//
// Three probes:
//
//   (CI-LB-1) Projects page loads with a contact whose hs_lead_status is
//             AWAITING_PHOTOS but hw_lead_substatus does not contain
//             AWPH_RECEIVED — badge is NOT shown initially.
//
//   (CI-LB-2) Customer submits their info via POST /api/customer-info/:token
//             (from the test harness, simulating the real customer flow).
//             Server must respond 200 ok=true.
//
//   (CI-LB-3) The projects board receives the customer_info_submitted SSE
//             event pushed by the server, re-fetches /api/project-contacts,
//             and the "Photos received" badge appears on the relevant card —
//             without a manual page reload.
//
// Strategy:
//   - Spawn a real Express server (mail transport file override).
//   - Insert a customer_info_submissions row directly into the test DB
//     (bypasses the send-link HubSpot call; no HubSpot mock needed).
//   - Open a headless Chromium browser via Puppeteer and inject a session
//     cookie for an admin user.
//   - Use Puppeteer request interception to stub /api/project-contacts:
//       • Call 1 (initial page load): contact with AWAITING_PHOTOS status,
//         no AWPH_RECEIVED substatus → badge absent.
//       • Call 2+ (triggered by SSE re-fetch): same contact WITH
//         AWPH_RECEIVED substatus → badge must appear.
//   - Let /api/hubspot/webhook-events (SSE) flow through to the real server
//     so the EventSource in useProjectsData receives the push event.
//   - POST /api/customer-info/:token from the test harness to trigger the
//     SSE push, then poll the page for the badge text.
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:customer-info-live-badge
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:customer-info-live-badge

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

require('dotenv').config();

const { pollUntil } = require('../helpers/poll');

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'customer-info-live-badge.md',
);
const findings = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}
const skip = makeSkip3(findings);

// ── DB helpers ────────────────────────────────────────────────────────────────

async function waitForTable(pool, tableName, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = $1 LIMIT 1`,
      [tableName],
    );
    if (r.rowCount) return;
    await new Promise(res => setTimeout(res, 200));
  }
  throw new Error(`Table ${tableName} did not appear within ${timeoutMs}ms`);
}

// Insert a customer-info submission row directly, returning the raw token.
// This bypasses the HubSpot contact-fetch step in the send-link handler so
// no mock HubSpot server is needed for this probe.
async function insertTokenRow(pool, contactId, contactEmail) {
  const rawToken  = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await pool.query(
    `INSERT INTO customer_info_submissions
       (contact_id, contact_name, contact_email, token_hash, expires_at,
        masked_email, masked_phone)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      contactId,
      'Live Badge Test',
      contactEmail,
      tokenHash,
      expiresAt.toISOString(),
      'l***@privtest.local',
      '07***0000',
    ],
  );

  return rawToken;
}

async function cleanupSubmissions(pool, contactId) {
  try {
    await pool.query(
      `DELETE FROM customer_info_submissions WHERE contact_id = $1`,
      [contactId],
    );
  } catch {}
}

// ── Puppeteer helpers ─────────────────────────────────────────────────────────

function parseCookieKV(jar) {
  if (!jar) return null;
  const idx = jar.indexOf('=');
  if (idx < 0) return null;
  return { name: jar.slice(0, idx), value: jar.slice(idx + 1) };
}

async function injectSession(page, jar, base) {
  const kv = parseCookieKV(jar);
  if (!kv) return;
  const { hostname } = new URL(base);
  await page.setCookie({
    name: kv.name, value: kv.value,
    domain: hostname, path: '/', httpOnly: true,
  });
}

// Poll page.evaluate(fn) until it returns truthy or timeout elapses.
async function pollPage(page, fn, timeoutMs = 15000, intervalMs = 200) {
  return pollUntil(page, fn, timeoutMs, intervalMs);
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
  // contactId must be all-digit (the customer-info route validates /^\d+$/)
  const contactId = String(900000000 + Math.floor(Math.random() * 99999999));
  const contactEmail = `ci-badge-${runId}@privtest.local`;

  console.log(`\n  customer-info-live-badge  run=${runId}`);
  console.log(`  contactId=${contactId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  if (!puppeteer) {
    for (const l of PROBE_LABELS) skip(l, 'puppeteer not installed — all probes skipped');
    await writeReport(runId);
    process.exit(findings.every(f => f.ok) ? 0 : 1);
    return;
  }

  const pool = new Pool({ connectionString: connStr });

  // Mail transport override — captured to a temp file so email errors don't
  // crash the submission handler (which also tries to send thank-you email).
  const mailFile = path.join(os.tmpdir(), `ci-badge-${runId}.jsonl`);
  try { fs.unlinkSync(mailFile); } catch {}

  process.env.MAIL_TRANSPORT_FILE_OVERRIDE = mailFile;
  process.env.PRIVTEST_USE_ADMIN_EMAILS    = '1';
  process.env.ADMIN_EMAILS                 = `admin-ci-${runId}@privtest.local`;

  const harness = require('../privileges/harness');
  const {
    spawnServer, waitForServer, seedUsers, cleanupTestData,
    resetRateLimitStore, login, BASE,
  } = harness;
  harness.setPool(pool);

  await cleanupTestData(pool);
  await resetRateLimitStore(pool);
  await cleanupSubmissions(pool, contactId);

  const { child, logBuf } = spawnServer();
  let exitCode = 1;
  let browser;

  const cleanup = async () => {
    try { child.kill('SIGTERM'); } catch {}
    try { await cleanupSubmissions(pool, contactId); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
  };
  process.on('SIGINT',  () => cleanup().then(() => process.exit(130)));
  process.on('SIGTERM', () => cleanup().then(() => process.exit(130)));

  const { findChromium } = require('../shared/find-chromium');
  const executablePath = findChromium() || undefined;

  try {
    await waitForServer();
    await waitForTable(pool, 'customer_info_submissions');
    await resetRateLimitStore(pool);
    await cleanupTestData(pool);
    const users = await seedUsers(pool, runId);
    console.log(`  test server up at ${BASE}\n`);

    const adminClient = await login(users.admin.email, users.admin.password);

    // Insert the customer-info DB row so we have a valid token to submit.
    const rawToken = await insertTokenRow(pool, contactId, contactEmail);
    console.log(`  customer-info token inserted for contactId=${contactId}`);

    // ── Synthetic contact and room data ───────────────────────────────────
    // Contact with AWAITING_PHOTOS status but NO AWPH_RECEIVED substatus.
    // Badge must NOT appear on the first page load.
    const contactNoBadge = {
      id: contactId,
      properties: {
        firstname:         'LiveBadge',
        lastname:          'Test',
        email:             contactEmail,
        hs_lead_status:    'AWAITING_PHOTOS',
        hw_lead_substatus: null,
        createdate:        new Date().toISOString(),
        lastmodifieddate:  new Date().toISOString(),
      },
    };

    // Same contact after submission: AWPH_RECEIVED substatus applied.
    // Badge MUST appear after the SSE re-fetch.
    const contactWithBadge = {
      ...contactNoBadge,
      properties: {
        ...contactNoBadge.properties,
        hw_lead_substatus: 'AWAITING_PHOTOS__AWPH_RECEIVED',
      },
    };

    // Room data for /api/localdata/all — required so computeRows() includes
    // the contact.  (ProjectsPage skips contacts with no entries in stageCache.)
    // AWAITING_PHOTOS belongs to the 'sales' stage in the pipeline.
    const localdataBody = JSON.stringify({
      [contactId]: [
        {
          room:      'Living Room',
          stageKey:  'sales',
          roomStatus: 'active',
          statusId:  null,
        },
      ],
    });

    // ── Launch Puppeteer ───────────────────────────────────────────────────

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
      exitCode = 1;
      return;
    }

    const page = await browser.newPage();
    await page.setCacheEnabled(false);

    // Patch EventSource before any page scripts run so we can detect when the
    // /api/hubspot/webhook-events SSE stream sends its initial 'connected'
    // confirmation.  useProjectsData waits 500 ms before opening the source;
    // we need to know it is established before we POST the submission so the
    // server's pushSseEvent() finds at least one connected client.
    await page.evaluateOnNewDocument(() => {
      window.__sseWebhookConnected = false;
      const NativeEventSource = window.EventSource;
      window.EventSource = function PatchedEventSource(url, init) {
        const src = new NativeEventSource(url, init);
        if (typeof url === 'string' && url.includes('webhook-events')) {
          src.addEventListener('message', function (e) {
            try {
              const d = JSON.parse(e.data);
              if (d && d.type === 'connected') window.__sseWebhookConnected = true;
            } catch {}
          });
        }
        return src;
      };
      // Copy static properties so EventSource.OPEN etc. are still accessible.
      Object.assign(window.EventSource, NativeEventSource);
    });

    // Track how many times /api/project-contacts has been called so we can
    // switch the response after the first (initial) load.
    let projectContactsCallCount = 0;

    page.on('console', msg => {
      const t = msg.text();
      if (t.startsWith('[diag') || t.startsWith('[test') || t.includes('[customer-info]')) {
        console.log(`    [browser] ${t}`);
      }
    });

    await page.setRequestInterception(true);
    page.on('request', req => {
      const url = req.url();

      // Stub /api/project-contacts — return synthetic contact data.
      // First call: no AWPH_RECEIVED → badge absent.
      // Subsequent calls (triggered by SSE re-fetch): AWPH_RECEIVED → badge shown.
      if (url.includes('/api/project-contacts')) {
        projectContactsCallCount++;
        const contact = projectContactsCallCount <= 1 ? contactNoBadge : contactWithBadge;
        return req.respond({
          status:      200,
          contentType: 'application/json',
          headers:     { 'X-Cache-Status': 'fresh' },
          body:        JSON.stringify({ results: [contact], total: 1 }),
        });
      }

      // Stub /api/workflow → empty (ProjectsPage handles missing data gracefully).
      if (url.includes('/api/workflow')) {
        return req.respond({
          status:      200,
          contentType: 'application/json',
          body:        JSON.stringify({}),
        });
      }

      // Stub /api/localdata/all → room data for the synthetic contact so
      // computeRows() includes it.  Without at least one room entry the card
      // is silently skipped (ProjectsPage:197).
      if (url.includes('/api/localdata/all')) {
        return req.respond({
          status:      200,
          contentType: 'application/json',
          headers:     { 'X-Cache-Status': 'fresh' },
          body:        localdataBody,
        });
      }

      // Stub /api/platform-users → empty array.
      if (url.includes('/api/platform-users')) {
        return req.respond({
          status:      200,
          contentType: 'application/json',
          body:        JSON.stringify([]),
        });
      }

      // Stub /api/design-visits/in-progress → empty (no draft visits).
      if (url.includes('/api/design-visits/in-progress')) {
        return req.respond({
          status:      200,
          contentType: 'application/json',
          body:        JSON.stringify([]),
        });
      }

      // Stub /api/card-action-handlers → empty (no action strips needed).
      if (url.includes('/api/card-action-handlers')) {
        return req.respond({
          status:      200,
          contentType: 'application/json',
          body:        JSON.stringify([]),
        });
      }

      // Let all other requests (auth, SSE, lead-statuses, etc.) pass through
      // to the real server so the SSE connection and session checks work.
      req.continue();
    });

    await injectSession(page, adminClient.cookie, BASE);

    // ── Navigate to the projects board ────────────────────────────────────
    await page.goto(`${BASE}/projects`, { waitUntil: 'domcontentloaded', timeout: 25000 });

    // Wait for the React projects view to mount and the initial fetch to complete.
    // We poll for the card showing the contact name (LiveBadge Test).
    const initialLoad = await pollPage(page, () => {
      const texts = Array.from(document.querySelectorAll('*'))
        .map(el => el.textContent.trim())
        .filter(t => t === 'LiveBadge Test');
      return texts.length > 0 ? 'found' : null;
    }, 20000);

    record('CI-LB-1 projects board loads with synthetic contact', !!initialLoad,
      initialLoad
        ? `card for "LiveBadge Test" appeared after page load`
        : `timed out waiting for contact card (projectContactsCalls=${projectContactsCallCount})`);

    // Badge must NOT be visible on the initial load (no AWPH_RECEIVED yet).
    const badgeBeforeSubmit = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('*'))
        .some(el => el.textContent.trim() === 'Photos received' && el.children.length === 0);
    });
    record('CI-LB-1 "Photos received" badge absent before submission', !badgeBeforeSubmit,
      `badgePresent=${badgeBeforeSubmit}`);

    // ── Wait for the SSE connection to be established ────────────────────
    // useProjectsData opens its EventSource after a 500 ms delay.  We need
    // the SSE connection to be established before we POST the submission so
    // the server's pushSseEvent() finds at least one connected client.
    // The server sends { type: 'connected' } immediately on open; our patched
    // EventSource constructor sets window.__sseWebhookConnected = true.
    const sseConnected = await pollPage(page, () => window.__sseWebhookConnected === true ? 'ok' : null, 10000, 100);
    console.log(`  SSE connection established: ${!!sseConnected}`);

    // ── CI-LB-2: Submit the customer-info form ────────────────────────────
    // Simulate the customer submitting their info via direct HTTP POST.
    // The server will:
    //   1. Mark the DB row as submitted.
    //   2. Attempt HubSpot updates (non-fatal; no token set in test env).
    //   3. Bust the project-contacts cache (so next /api/project-contacts
    //      fetch misses the TTL and re-fetches from HubSpot — but the
    //      browser's request is intercepted so this doesn't matter).
    //   4. Push SSE: { type: 'customer_info_submitted', contactId }.
    const submitRes = await fetch(`${BASE}/api/customer-info/${rawToken}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        correctedEmail:  '',
        correctedMobile: '',
        addressLine1:    '1 Test Street',
        city:            'London',
        postcode:        'SW1A 1AA',
        roomCount:       '2',
        roomNotes:       '',
        photoKeys:       [],
      }),
    });
    const submitBody = await submitRes.json().catch(() => null);
    const submitOk   = submitRes.status === 200 && submitBody?.ok === true;
    record('CI-LB-2 POST /api/customer-info/:token returns 200 ok', submitOk,
      submitOk
        ? `status=200 ok=true`
        : `status=${submitRes.status} body=${JSON.stringify(submitBody).slice(0, 200)}`);

    // ── CI-LB-3: Badge appears without page reload ────────────────────────
    // The EventSource in useProjectsData listens on /api/hubspot/webhook-events.
    // When the server pushes { type: 'customer_info_submitted' }, the hook
    // increments fetchNonce → re-fetches /api/project-contacts → (intercepted)
    // returns contactWithBadge → React re-renders → badge appears.
    //
    // Wait up to 15 seconds for the "Photos received" badge to appear in a
    // leaf text node (same way the contact name was detected above).
    const badgeAppeared = await pollPage(page, () => {
      return Array.from(document.querySelectorAll('*'))
        .some(el => el.textContent.trim() === 'Photos received' && el.children.length === 0)
        ? 'found' : null;
    }, 15000, 200);

    record('CI-LB-3 "Photos received" badge appears after SSE push (no reload)',
      !!badgeAppeared,
      badgeAppeared
        ? `badge appeared after SSE event triggered re-fetch (projectContactsCalls=${projectContactsCallCount})`
        : `badge did NOT appear within 15 s (projectContactsCalls=${projectContactsCallCount})`);

    // Verify the SSE actually triggered at least one extra /api/project-contacts
    // fetch (i.e. the counter advanced beyond the initial load call).
    record('CI-LB-3 re-fetch triggered by SSE (call count > 1)',
      projectContactsCallCount > 1,
      `projectContactsCallCount=${projectContactsCallCount}`);

    await page.close();

    const failed = findings.filter(f => !f.ok && !f.skipped).length;
    const skipped = findings.filter(f => f.skipped).length;
    exitCode = failed === 0 ? 0 : 1;
    console.log(`\n  Results: ${findings.length - failed} passed, ${failed} failed`);

  } catch (e) {
    console.error('Test crashed:', e);
    console.error('--- server log (last 3000 chars) ---');
    console.error((logBuf || []).join('').slice(-3000));
  } finally {
    if (browser) await browser.close().catch(() => {});
    await writeReport(runId);
    await cleanup();
    process.exit(exitCode);
  }
}

async function writeReport(runId) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc    = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok && !f.skipped).length;
  const lines = [
    '# Customer-Info Live Badge — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:customer-info-live-badge\``,
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
    '- **(CI-LB-1) Initial load — badge absent**: Puppeteer intercepts',
    '  `/api/project-contacts` and returns a synthetic contact with',
    '  `hs_lead_status: AWAITING_PHOTOS` but no `AWPH_RECEIVED` substatus.',
    '  Asserts the "Photos received" badge text is absent from the DOM.',
    '- **(CI-LB-2) Customer submission**: POSTs to `/api/customer-info/:token`',
    '  (via a DB-inserted token row, no HubSpot fetch required).',
    '  Asserts the server returns `200 ok=true`.',
    '- **(CI-LB-3) SSE → re-fetch → badge appears**: The server pushes a',
    '  `customer_info_submitted` SSE event over `/api/hubspot/webhook-events`.',
    '  `useProjectsData` receives the event via its `EventSource` and increments',
    '  `fetchNonce`, triggering a re-fetch of `/api/project-contacts` (now',
    '  intercepted to return the contact with `AWPH_RECEIVED` substatus).',
    '  Polls up to 15 s for "Photos received" to appear in a leaf DOM node',
    '  — no `page.reload()` is called.',
    '',
    '## Relevant files',
    '',
    '- `customer-info.js` — `pushSseEvent({ type: "customer_info_submitted" })`',
    '  after a successful submission.',
    '- `src/react/hooks/useProjectsData.ts` — `EventSource` listener that',
    '  calls `setFetchNonce(n => n + 1)` on `customer_info_submitted`.',
    '- `src/react/pages/ProjectsPage.tsx` — `photosReceived` badge logic:',
    '  `leadStatusKey === "AWAITING_PHOTOS" && hwSubstatusValue.includes("AWPH_RECEIVED")`.',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
}

main();
