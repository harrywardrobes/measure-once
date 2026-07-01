'use strict';
const { makeSkip3 } = require('../helpers/report');

const PROBE_LABELS = [
  'PR-A1 projects board loads card',
  'PR-A2 "Photos received" badge IS shown within #projects-view',
  'PR-B1 projects board loads card',
  'PR-B2 "Photos received" badge is NOT shown (no substatus)',
  'PR-C1 projects board loads card',
  'PR-C2 "Photos received" badge is NOT shown (wrong lead status)',
];

// test/photos-received-badge/run.js
//
// Regression guard for the PhotosReceivedBadge component in CustomersPage.tsx.
//
// Probes:
//   (PR-A) Badge IS shown on a Projects board card when hs_lead_status is
//          AWAITING_PHOTOS AND hw_lead_substatus contains AWPH_RECEIVED.
//   (PR-B) Badge is NOT shown when hs_lead_status is AWAITING_PHOTOS but
//          hw_lead_substatus does NOT contain AWPH_RECEIVED (condition 2 absent).
//   (PR-C) Badge is NOT shown when hw_lead_substatus contains AWPH_RECEIVED
//          but hs_lead_status is NOT AWAITING_PHOTOS (condition 1 absent).
//
// Strategy:
//   Boots a disposable test server (no mock HubSpot needed — all API calls
//   that the React island makes are intercepted by Puppeteer request
//   interception before they reach the server).  For each probe a fresh
//   browser page is opened at /projects with a synthetic /api/project-contacts
//   response that carries the contact properties under test.
//   /api/localdata/all is intercepted to provide room data so the card is
//   included in the board (ProjectsPage skips contacts with no stageCache entry).
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:photos-received-badge
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:photos-received-badge

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

require('dotenv').config();

const { pollUntil } = require('../helpers/poll');

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'photos-received-badge.md',
);
const findings = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}
const skip = makeSkip3(findings);

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

async function pollPage(page, fn, timeoutMs = 15000, intervalMs = 200, evalArgs = []) {
  return pollUntil(page, fn, timeoutMs, intervalMs, evalArgs);
}

// Open the Projects page with request interception active.
// `contactOverride` is the contact object returned by the /api/project-contacts stub.
// Returns the page instance (caller should close it).
async function openProjectsPage(browser, cookie, base, contactOverride) {
  const ctx = await (browser.createBrowserContext
    ? browser.createBrowserContext()
    : browser.createIncognitoBrowserContext());
  const page = await ctx.newPage();
  page.__ctx = ctx;
  await page.setCacheEnabled(false);

  page.on('console', msg => {
    const t = msg.text();
    if (t.startsWith('[diag') || t.startsWith('[test') || t.startsWith('[projects')) {
      console.log(`    [browser] ${t}`);
    }
  });
  page.on('pageerror', e => console.log(`    [pageerror] ${e.message}`));

  const contactJson = JSON.stringify(contactOverride);
  const localdataJson = JSON.stringify({
    [contactOverride.id]: [
      { room: 'Living Room', stageKey: 'sales', roomStatus: 'active', statusId: null },
    ],
  });

  await page.setRequestInterception(true);
  page.on('request', req => {
    const url = req.url();

    if (url.includes('/api/project-contacts')) {
      const c = JSON.parse(contactJson);
      return req.respond({
        status:      200,
        contentType: 'application/json',
        headers:     { 'X-Cache-Status': 'fresh' },
        body:        JSON.stringify({ results: [c], total: 1 }),
      });
    }

    if (url.includes('/api/localdata/all')) {
      return req.respond({
        status:      200,
        contentType: 'application/json',
        headers:     { 'X-Cache-Status': 'fresh' },
        body:        localdataJson,
      });
    }

    if (url.includes('/api/workflow')) {
      return req.respond({
        status:      200,
        contentType: 'application/json',
        body:        JSON.stringify({}),
      });
    }

    if (url.includes('/api/platform-users')) {
      return req.respond({
        status:      200,
        contentType: 'application/json',
        body:        JSON.stringify([]),
      });
    }

    if (url.includes('/api/design-visits/in-progress')) {
      return req.respond({
        status:      200,
        contentType: 'application/json',
        body:        JSON.stringify([]),
      });
    }

    if (url.includes('/api/card-action-handlers')) {
      return req.respond({
        status:      200,
        contentType: 'application/json',
        body:        JSON.stringify([]),
      });
    }

    req.continue();
  });

  await injectSession(page, cookie, base);
  await page.goto(`${base}/projects`, { waitUntil: 'domcontentloaded', timeout: 25000 });

  return page;
}

// Poll until the contact's name appears in the projects view (card rendered).
async function waitForCard(page, name, timeoutMs = 20000) {
  return pollPage(page, (n) => {
    const texts = Array.from(document.querySelectorAll('*'))
      .map(el => el.textContent.trim())
      .filter(t => t === n);
    return texts.length > 0 ? 'found' : null;
  }, timeoutMs, 200, [name]);
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
  console.log(`\n  photos-received-badge  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  if (!puppeteer) {
    for (const l of PROBE_LABELS) {
      skip(l, 'puppeteer not installed — all probes skipped');
    }
    await writeReport(runId);
    process.exit(findings.every(f => f.ok) ? 0 : 1);
    return;
  }

  const pool = new Pool({ connectionString: connStr });

  const harness = require('../privileges/harness');
  const {
    spawnServer, waitForServer, seedUsers, cleanupTestData,
    resetRateLimitStore, login, BASE,
  } = harness;
  harness.setPool(pool);

  await cleanupTestData(pool);
  await resetRateLimitStore(pool);

  const { child, logBuf } = spawnServer();
  let exitCode = 1;
  let browser;

  const cleanup = async () => {
    try { child.kill('SIGTERM'); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
  };
  process.on('SIGINT',  () => cleanup().then(() => process.exit(130)));
  process.on('SIGTERM', () => cleanup().then(() => process.exit(130)));

  const { findChromium } = require('../shared/find-chromium');
  const executablePath = findChromium() || undefined;

  try {
    await waitForServer();
    await resetRateLimitStore(pool);
    await cleanupTestData(pool);
    const users = await seedUsers(pool, runId);
    console.log(`  test server up at ${BASE}\n`);

    const adminClient = await login(users.admin.email, users.admin.password);
    const cookie = adminClient.cookie;

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
    record('PR-0 headless chromium launches', true, 'browser started');

    // ── Synthetic contacts ─────────────────────────────────────────────────────

    const CONTACT_ID_A = `prb-a-${runId}`;
    const CONTACT_ID_B = `prb-b-${runId}`;
    const CONTACT_ID_C = `prb-c-${runId}`;

    // PR-A: AWAITING_PHOTOS + AWPH_RECEIVED → badge SHOWN
    const contactA = {
      id: CONTACT_ID_A,
      properties: {
        firstname:         'BadgeShown',
        lastname:          'Test',
        email:             `prb-a-${runId}@privtest.local`,
        hs_lead_status:    'AWAITING_PHOTOS',
        hw_lead_substatus: 'AWAITING_PHOTOS__AWPH_RECEIVED',
        createdate:        new Date().toISOString(),
        lastmodifieddate:  new Date().toISOString(),
      },
    };

    // PR-B: AWAITING_PHOTOS + NO AWPH_RECEIVED → badge ABSENT
    const contactB = {
      id: CONTACT_ID_B,
      properties: {
        firstname:         'BadgeAbsentNoSub',
        lastname:          'Test',
        email:             `prb-b-${runId}@privtest.local`,
        hs_lead_status:    'AWAITING_PHOTOS',
        hw_lead_substatus: null,
        createdate:        new Date().toISOString(),
        lastmodifieddate:  new Date().toISOString(),
      },
    };

    // PR-C: DELIVERED (not AWAITING_PHOTOS) + AWPH_RECEIVED → badge ABSENT
    const contactC = {
      id: CONTACT_ID_C,
      properties: {
        firstname:         'BadgeAbsentWrongStatus',
        lastname:          'Test',
        email:             `prb-c-${runId}@privtest.local`,
        hs_lead_status:    'DELIVERED',
        hw_lead_substatus: 'AWAITING_PHOTOS__AWPH_RECEIVED',
        createdate:        new Date().toISOString(),
        lastmodifieddate:  new Date().toISOString(),
      },
    };

    // Helper: poll #projects-view for "Photos received" badge text.
    // For the presence check (PR-A) we poll up to timeoutMs until it appears.
    // For the absence checks (PR-B/C) we wait up to 4 s and expect it to stay
    // absent — the card is already confirmed rendered, so this is a short
    // stabilisation window, not a long wait.
    async function pollForBadge(page, expectPresent, timeoutMs = 8000) {
      if (expectPresent) {
        return pollPage(page, () => {
          const view = document.getElementById('projects-view');
          if (!view) return null;
          return Array.from(view.querySelectorAll('*'))
            .some(el => el.textContent.trim() === 'Photos received' && el.children.length === 0)
            ? 'found' : null;
        }, timeoutMs, 150);
      }
      // For absence: poll until #projects-view is rendered and stable, then
      // do a final scoped snapshot.  We use a short stabilisation wait (≤ 4 s)
      // to let React commit the render before concluding the badge is absent.
      const stabilised = await pollPage(page, () => {
        const view = document.getElementById('projects-view');
        return (view && view.innerHTML.trim().length > 100) ? 'ok' : null;
      }, timeoutMs, 150);
      if (!stabilised) return 'timeout';
      // One more tick to let any pending state flushes land.
      await new Promise(r => setTimeout(r, 300));
      const hasBadge = await page.evaluate(() => {
        const view = document.getElementById('projects-view');
        if (!view) return false;
        return Array.from(view.querySelectorAll('*'))
          .some(el => el.textContent.trim() === 'Photos received' && el.children.length === 0);
      });
      return hasBadge ? 'found' : 'absent';
    }

    // ── PR-A: Badge shown ──────────────────────────────────────────────────────

    console.log('\n  [PR-A] AWAITING_PHOTOS + AWPH_RECEIVED → badge shown');
    {
      const page = await openProjectsPage(browser, cookie, BASE, contactA);

      const loaded = await waitForCard(page, 'BadgeShown Test');
      record('PR-A1 projects board loads card', loaded === 'found',
        loaded === 'found' ? 'contact card rendered' : 'timed out waiting for card');

      // Poll #projects-view until the badge leaf node appears.
      const badgeResult = await pollForBadge(page, true, 10000);
      record('PR-A2 "Photos received" badge IS shown within #projects-view',
        badgeResult === 'found', `result=${badgeResult}`);

      await page.close();
      await page.__ctx.close().catch(() => {});
    }

    // ── PR-B: Badge absent — no AWPH substatus ────────────────────────────────

    console.log('\n  [PR-B] AWAITING_PHOTOS + no AWPH substatus → badge absent');
    {
      const page = await openProjectsPage(browser, cookie, BASE, contactB);

      const loaded = await waitForCard(page, 'BadgeAbsentNoSub Test');
      record('PR-B1 projects board loads card', loaded === 'found',
        loaded === 'found' ? 'contact card rendered' : 'timed out waiting for card');

      // Wait for view stabilisation, then confirm badge is absent.
      const badgeResult = await pollForBadge(page, false, 4000);
      record('PR-B2 "Photos received" badge is NOT shown (no substatus)',
        badgeResult === 'absent', `result=${badgeResult}`);

      await page.close();
      await page.__ctx.close().catch(() => {});
    }

    // ── PR-C: Badge absent — wrong lead status ────────────────────────────────

    console.log('\n  [PR-C] Non-AWAITING_PHOTOS status + AWPH substatus → badge absent');
    {
      const page = await openProjectsPage(browser, cookie, BASE, contactC);

      const loaded = await waitForCard(page, 'BadgeAbsentWrongStatus Test');
      record('PR-C1 projects board loads card', loaded === 'found',
        loaded === 'found' ? 'contact card rendered' : 'timed out waiting for card');

      // Wait for view stabilisation, then confirm badge is absent.
      const badgeResult = await pollForBadge(page, false, 4000);
      record('PR-C2 "Photos received" badge is NOT shown (wrong lead status)',
        badgeResult === 'absent', `result=${badgeResult}`);

      await page.close();
      await page.__ctx.close().catch(() => {});
    }

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
  const esc    = s => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok && !f.skipped).length;
  const lines = [
    '# Photos-Received Badge — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:photos-received-badge\``,
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
    '- **(PR-A) Badge shown**: Puppeteer opens `/projects` with a synthetic',
    '  `/api/project-contacts` response carrying `hs_lead_status: AWAITING_PHOTOS`',
    '  and `hw_lead_substatus: "AWAITING_PHOTOS__AWPH_RECEIVED"`. Asserts that',
    '  a leaf DOM node with text "Photos received" is present in `#projects-view`.',
    '- **(PR-B) Badge absent — no substatus**: Same setup but `hw_lead_substatus`',
    '  is `null`. Asserts "Photos received" does NOT appear — condition 2 of',
    '  `isPhotosReceived()` is unmet.',
    '- **(PR-C) Badge absent — wrong lead status**: `hw_lead_substatus` contains',
    '  `AWPH_RECEIVED` but `hs_lead_status` is `DELIVERED` (not `AWAITING_PHOTOS`).',
    '  Asserts "Photos received" does NOT appear — condition 1 of',
    '  `isPhotosReceived()` is unmet.',
    '',
    '## Relevant files',
    '',
    '- `src/react/components/PhotosReceivedBadge.tsx` — `isPhotosReceived()` logic',
    '  and `<PhotosReceivedBadge />` component.',
    '- `src/react/pages/ProjectsPage.tsx` — badge rendered at line ~616.',
    '- `src/react/hooks/useProjectsData.ts` — `ProjectContact` type with',
    '  `hs_lead_status` / `hw_lead_substatus` properties.',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
}

main();
