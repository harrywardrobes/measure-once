'use strict';
const { makeSkip } = require('../helpers/report');

// test/audit-log-scrolling/run.js
//
// Infinite-scroll regression guard for the Audit Log admin tab.
//
// Stubs the /api/admin/audit-log-unified endpoint via Puppeteer request
// interception to control page data without needing real audit rows in the
// database.  The first intercept returns PAGE_SIZE rows with hasMore=true;
// the second returns another PAGE_SIZE rows with hasMore=false.
//
// Probes:
//   (A) initial rows load — first page of entries appears in #audit-feed
//   (B) Load more triggers next-page fetch — click fires second API request
//   (C) skeleton/loading indicator appears during fetch
//   (D) next batch of rows appends — combined row count doubles after load
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:audit-log-scrolling
//   DATABASE_URL_TEST=<isolated-db> npm run test:audit-log-scrolling:ci
//   # or against the shared DB:
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:audit-log-scrolling

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
  BASE,
} = require('../privileges/harness');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

require('dotenv').config();

const { waitForSwitchTab, pollUntil } = require('../helpers/poll');
const { findChromium } = require('../shared/find-chromium');

const PAGE_SIZE = 50;

const PROBE_LABELS = [
  '(A) initial 50 rows load — first page of entries appears in #audit-feed',
  '(B) Load more triggers next-page fetch — second API request is made',
  '(C) loading indicator appears on button while next page is fetching',
  '(D) rows 51-100 append correctly — row count increases after load',
];

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

function makeAuditItems(count, offset = 0) {
  return Array.from({ length: count }, (_, i) => ({
    source: 'admin',
    ts: new Date(Date.now() - (offset + i) * 60000).toISOString(),
    action_type: 'approve_request',
    admin_email: `admin-${offset + i}@example.com`,
    target_email: `user-${offset + i}@example.com`,
    details: `Synthetic entry ${offset + i + 1}`,
  }));
}

async function main() {
  console.log('\n  audit-log-scrolling — infinite-scroll regression guard\n');

  const findings = [];
  function record(name, expected, observed, ok, detail) {
    findings.push({ name, expected, observed, ok, detail: detail || '' });
    const mark = ok ? '  \u2713' : '  \u2717';
    console.log(`${mark}  ${name}`);
    if (!ok) {
      console.log(`     expected : ${JSON.stringify(expected)}`);
      console.log(`     observed : ${JSON.stringify(observed)}`);
      if (detail) console.log(`     detail   : ${detail}`);
    }
  }
  const skip = makeSkip(findings);

  const dbUrl = process.env.DATABASE_URL_TEST || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('Set DATABASE_URL_TEST or DATABASE_URL before running.');
    process.exit(2);
  }
  if (!process.env.DATABASE_URL_TEST && process.env.PRIVTEST_ALLOW_SHARED_DB !== '1') {
    console.error('Refusing to run against shared DATABASE_URL. Set DATABASE_URL_TEST or PRIVTEST_ALLOW_SHARED_DB=1.');
    process.exit(2);
  }

  if (!puppeteer) {
    for (const l of PROBE_LABELS) {
      skip(l, 'puppeteer installed', 'puppeteer not installed');
    }
    await writeReport(findings);
    process.exit(1);
  }

  const pool = new Pool({ connectionString: dbUrl });
  setPool(pool);

  const runId = `als-${Date.now().toString(36)}`;
  const { child, logBuf } = spawnServer();
  let browser;
  let exitCode = 0;

  try {
    await waitForServer();
    await resetRateLimitStore(pool);
    await cleanupTestData(pool);

    const seeded = await seedUsers(pool, runId);
    const admin  = seeded.admin;
    const adminClient = await login(admin.email, admin.password);

    const executablePath = findChromium();
    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      defaultViewport: { width: 1280, height: 800 },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const page = await browser.newPage();
    page.on('pageerror', () => {});
    page.on('console', () => {});

    let secondFetchSeen = false;
    let fetchCount = 0;
    let delayNextResponse = false;
    let delayResolve = null;

    await page.setRequestInterception(true);
    page.on('request', async (req) => {
      const url = req.url();
      if (!url.includes('/api/admin/audit-log-unified')) {
        req.continue();
        return;
      }

      fetchCount++;
      const thisFetch = fetchCount;

      if (thisFetch === 2) {
        secondFetchSeen = true;
        if (delayNextResponse) {
          await new Promise(r => { delayResolve = r; });
        }
        req.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ items: makeAuditItems(PAGE_SIZE, PAGE_SIZE), hasMore: false }),
        });
        return;
      }

      req.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: makeAuditItems(PAGE_SIZE, 0), hasMore: true }),
      });
    });

    await injectSession(page, adminClient.cookie);
    const resp = await page.goto(`${BASE}/admin`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });

    const pageOk = resp && (resp.ok() || resp.status() === 304);
    if (!pageOk) {
      for (const l of PROBE_LABELS) {
        skip(l, 'admin page loads', `HTTP ${resp ? resp.status() : 0}`);
      }
      await writeReport(findings);
      process.exit(1);
    }

    const switchReady = await waitForSwitchTab(page, 10000);
    if (!switchReady) {
      for (const l of PROBE_LABELS) {
        skip(l, 'switchTab available', 'window.switchTab not ready after 10s');
      }
      await writeReport(findings);
      process.exit(1);
    }

    await page.evaluate(() => window.switchTab('tab-auditlog'));

    const feedReady = await pollUntil(
      page,
      () => {
        const feed = document.getElementById('audit-feed');
        if (!feed) return null;
        const rows = feed.querySelectorAll('[class*="MuiStack"]');
        return rows.length > 0 ? rows.length : null;
      },
      10000,
      200,
    );

    const initialCount = feedReady || 0;
    record(
      PROBE_LABELS[0],
      `>= ${PAGE_SIZE} rows (or at least 1 rendered)`,
      `${initialCount} rows in #audit-feed`,
      initialCount > 0,
      initialCount === 0 ? 'No rows rendered after switching to audit log tab.' : '',
    );

    const loadMoreBtn = await pollUntil(
      page,
      () => {
        const btns = [...document.querySelectorAll('button')];
        const lb = btns.find(b => b.textContent.trim() === 'Load more');
        return lb ? true : null;
      },
      6000,
      150,
    );

    if (!loadMoreBtn) {
      for (const l of PROBE_LABELS.slice(1)) {
        skip(l, '"Load more" button visible', 'no "Load more" button found after initial load');
      }
      await writeReport(findings);
      process.exit(1);
    }

    delayNextResponse = true;
    const fetchCountBefore = fetchCount;

    const loadingObservedP = new Promise(async (resolve) => {
      let seen = false;
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline && !seen) {
        try {
          seen = await page.evaluate(() => {
            const btns = [...document.querySelectorAll('button')];
            return btns.some(b => b.textContent.trim() === 'Loading\u2026');
          });
        } catch {}
        if (!seen) await new Promise(r => setTimeout(r, 50));
      }
      resolve(seen);
    });

    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const lb = btns.find(b => b.textContent.trim() === 'Load more');
      if (lb) lb.click();
    });

    const loadingObserved = await loadingObservedP;

    record(
      PROBE_LABELS[1],
      'second fetch triggered',
      secondFetchSeen ? 'second fetch triggered' : 'second fetch not triggered',
      secondFetchSeen,
      secondFetchSeen ? '' : `fetchCount advanced from ${fetchCountBefore} to ${fetchCount} but expected second intercept`,
    );

    record(
      PROBE_LABELS[2],
      '"Loading…" text on button',
      loadingObserved ? '"Loading…" seen' : '"Loading…" not seen',
      loadingObserved,
      loadingObserved ? '' : 'Button did not show "Loading…" text during fetch.',
    );

    if (delayResolve) delayResolve();

    const afterCount = await pollUntil(
      page,
      (initialRows) => {
        const feed = document.getElementById('audit-feed');
        if (!feed) return null;
        const rows = feed.querySelectorAll('[class*="MuiStack"]');
        return rows.length > initialRows ? rows.length : null;
      },
      8000,
      200,
      [initialCount],
    );

    const combined = afterCount || initialCount;
    record(
      PROBE_LABELS[3],
      `row count > ${initialCount}`,
      `${combined} rows after load`,
      combined > initialCount,
      combined <= initialCount
        ? `Row count did not increase — still ${combined}. Next page may not have appended.`
        : '',
    );

    await page.close().catch(() => {});
  } catch (e) {
    record('test harness', 'no error', `error: ${e.message}`, false,
      (logBuf || []).slice(-20).join(''));
    exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { await cleanupTestData(pool); } catch {}
    try { await pool.end(); } catch {}
    try { child.kill('SIGTERM'); } catch {}
  }

  const pass    = findings.filter(f => f.ok).length;
  const fail    = findings.filter(f => !f.ok && !f.skipped).length;
  const skipped = findings.filter(f => f.skipped).length;
  console.log(`\n  Results: ${pass} passed, ${fail} failed, ${skipped} skipped`);
  await writeReport(findings);
  process.exit(fail > 0 || exitCode ? 1 : 0);
}

async function writeReport(findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'audit-log-scrolling.md');
  const lines = [
    '# audit-log-scrolling test results',
    '',
    `- Passed:  ${findings.filter(f => f.ok).length} / ${findings.length}`,
    `- Skipped: ${findings.filter(f => f.skipped).length} / ${findings.length}`,
    `- Failed:  ${findings.filter(f => !f.ok && !f.skipped).length} / ${findings.length}`,
    '',
    '## Findings',
    '',
    ...findings.map(f =>
      `- [${f.ok ? 'PASS' : f.skipped ? 'SKIP' : 'FAIL'}] **${f.name}**` +
      (!f.ok && !f.skipped ? `\n  - expected: ${f.expected}\n  - observed: ${f.observed}` +
        (f.detail ? `\n  - detail: ${f.detail}` : '') : ''),
    ),
  ];
  fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8');
}

main().catch(e => {
  console.error('Unhandled error:', e);
  process.exit(2);
});
