'use strict';
const { makeSkip } = require('../helpers/report');

const PROBE_LABELS = [
  'seed schedule_visit handler',
  '[VCM] modal opens with DateTimePicker and Schedule button',
  '[VCM-PAST] past-confirm dialog appears when submitting with past startDt',
  '[VCM-BACK] "Go back" dismisses dialog; scheduling form stays open',
  '[VCM-PROCEED] "Schedule anyway" fires POST /api/visits',
  '[WARN-VCM] modal opens with DateTimePicker',
  '[WARN-VCM] 15-minute warning Alert appears in ScheduleVisitModal after DateTimePicker update',
];

// test/scheduling-past-time-guard/run.js
//
// Covers the past-time confirmation dialog and 15-minute start-time warning
// for ScheduleVisitModal (schedule_visit handler type).
//
// Probes:
//   [VCM-PAST]   ScheduleVisitModal: submitting with a past startDt opens the
//                "Schedule in the past?" confirmation dialog.
//   [VCM-BACK]   Clicking "Go back" dismisses the dialog; the scheduling form
//                stays open.
//   [VCM-PROCEED] Clicking "Schedule anyway" fires POST /api/visits and the
//                modal closes.
//   [WARN-VCM]   The 15-minute warning Alert appears in ScheduleVisitModal
//                when the DateTimePicker is updated to a near-future time.
//
// Strategy for VCM past-time probes:
//   Navigate to /customers (a real, authenticated page that loads main.js).
//   main.js mounts CardActionModalsHost on every page via
//   initCardActionModalsHost(); that component registers _opener via a
//   useEffect so window.openCardActionModal becomes functional within ~300 ms.
//   We retry calling window.openCardActionModal(handler, ctx) in a pollPage
//   loop until the modal dialog appears.
//   After the modal appears we mock Date/Date.now in the browser context to
//   return a time 100 h in the future; clicking Submit triggers handleSubmit
//   which calls dayjs() and finds startDt < dayjs() — the past-confirm dialog
//   appears.
//
// Strategy for WARN-VCM probe:
//   ScheduleVisitModal has no edit mode via the customer-detail flow, so the
//   warning cannot be triggered via a pre-populated startAt. Instead, we open
//   the modal via openCardActionModal (initialStart = now + 24 h), then use
//   Puppeteer keyboard interaction to overwrite the DateTimePicker (#cah-sv-start)
//   with a near-future time (now + 10 min). The onChange fires, React updates
//   startDt, the useEffect re-runs checkApproaching(), and the warning Alert
//   appears because minutesUntilStart ≈ 10 < 15.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:scheduling-past-time-guard
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:scheduling-past-time-guard

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

const { pollUntil, pollFn } = require('../helpers/poll');

// ── Fixture constants ──────────────────────────────────────────────────────────
const HANDLER_NAME_VCM = 'PrivTest scheduling-past-time visit calendar handler';

// Numeric ID required by customer-detail bootstrap (validates /^\d+$/)
const FAKE_CONTACT_ID = '989800001641';

// Privtest-prefixed so purgeFixtures can scope DELETEs on visits by
// customer_id, preventing stale rows from accumulating on a shared database
// across runs.
const FAKE_CONTACT_ID_VCM = 'privtest-sptg-vcm-001';

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'scheduling-past-time-guard.md',
);

// ── Helpers ────────────────────────────────────────────────────────────────────

const findings = [];
function record(name, expected, observed, ok, detail = '') {
  findings.push({ name, expected, observed, ok, detail });
  const mark = ok ? '  ✓' : '  ✗';
  console.log(`${mark}  ${name}`);
  if (!ok) {
    console.log(`     expected : ${expected}`);
    console.log(`     observed : ${observed}`);
    if (detail) console.log(`     detail   : ${detail}`);
  }
}
const skip = makeSkip(findings);

function writeReport(runId) {
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok && !f.skipped).length;
  const skipped = findings.filter(f => f.skipped).length;
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const rows = findings
    .map(f => `| ${f.ok ? 'PASS' : f.skipped ? 'SKIP' : 'FAIL'} | ${esc(f.name)} | ${esc(f.expected)} | ${esc(f.observed)} |`)
    .join('\n');
  const md = [
    `# scheduling-past-time-guard test report`,
    ``,
    `run: \`${runId}\`  date: ${new Date().toISOString()}`,
    ``,
    `## Summary`,
    ``,
    `- Passed: ${passed} / ${findings.length}`,
    `- Skipped: ${skipped} / ${findings.length}`,
    `- Failed: ${failed} / ${findings.length}`,
    ``,
    `## Results`,
    ``,
    `| Result | Probe | Expected | Observed |`,
    `|---|---|---|---|`,
    rows,
    ``,
    `## Coverage`,
    ``,
    `Tests the past-time confirmation dialog and 15-minute warning in`,
    `ScheduleVisitModal (schedule_visit handler type).`,
    ``,
    `## Relevant files`,
    ``,
    `- \`src/react/components/modals/ScheduleVisitModal.tsx\``,
  ].join('\n');
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, md, 'utf8');
  console.log(`\n  Report written to ${REPORT_PATH}`);
}

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

function findChromium() {
  const { findChromium: shared } = require('../shared/find-chromium');
  return shared() || undefined;
}

async function pollPage(page, fn, arg, timeoutMs = 8000, intervalMs = 150) {
  return pollUntil(page, fn, timeoutMs, intervalMs, arg !== undefined && arg !== null ? [arg] : []);
}

// Mock Date/Date.now in the browser to return `farFuture` ms since epoch.
// Saves originals in window.__savedDate so restoreDateMock() can undo it.
async function applyDateMock(page, farFutureMs) {
  await page.evaluate((ff) => {
    const OrigDate = window.Date;
    window.__savedDate    = OrigDate;
    window.__savedDateNow = OrigDate.now;

    // Proxy the Date constructor so `new Date()` (no args) returns farFuture.
    const FakeDate = new Proxy(OrigDate, {
      construct(target, args) {
        if (args.length === 0) return new target(ff);
        return new target(...args);
      },
    });
    FakeDate.now   = () => ff;
    FakeDate.parse = OrigDate.parse.bind(OrigDate);
    FakeDate.UTC   = OrigDate.UTC.bind(OrigDate);
    window.Date = FakeDate;
  }, farFutureMs);
}

async function restoreDateMock(page) {
  await page.evaluate(() => {
    if (window.__savedDate) {
      window.Date = window.__savedDate;
      delete window.__savedDate;
      delete window.__savedDateNow;
    }
  });
}

async function purgeFixtures(pool) {
  try {
    await pool.query(
      `DELETE FROM card_action_handlers WHERE name = $1`,
      [HANDLER_NAME_VCM],
    );
  } catch (_) {}
  try {
    await pool.query(
      `DELETE FROM visits WHERE customer_id = $1`,
      [FAKE_CONTACT_ID_VCM],
    );
  } catch (_) {}
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

  if (!puppeteer) {
    for (const l of PROBE_LABELS) {
      skip(l, 'puppeteer installed', 'puppeteer not installed');
    }
    writeReport('no-puppeteer');
    process.exit(1);
  }

  const runId = Math.random().toString(36).slice(2, 8);
  console.log(`\n  scheduling-past-time-guard  run=${runId}`);
  console.log(`  DB: ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);

  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  admin=${users.admin.email}`);

  const { child, logBuf } = spawnServer();
  let exited = false;
  child.on('exit', () => { exited = true; });

  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try { await purgeFixtures(pool); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    writeReport(runId);
    process.exit(code);
  };

  process.on('SIGINT',  () => cleanupAndExit(130));
  process.on('SIGTERM', () => cleanupAndExit(130));
  process.on('uncaughtException',  (e) => { console.error('Uncaught:',  e); cleanupAndExit(2); });
  process.on('unhandledRejection', (e) => { console.error('Unhandled:', e); cleanupAndExit(2); });

  try {
    await waitForServer(30000);
    await resetRateLimitStore(pool);
    console.log(`  Server up at ${BASE}\n`);
  } catch (e) {
    console.error('Server boot failed:', e.message);
    console.error(logBuf.join('').slice(-2000));
    await cleanupAndExit(2);
    return;
  }

  // Wait for visits table to exist (created async on server boot).
  const waitForTable = async (name) => {
    const found = await pollFn(async () => {
      const r = await pool.query(`SELECT to_regclass($1) AS t`, [name]);
      return r.rows[0].t || null;
    }, 15000, 200);
    if (!found) throw new Error(`Timed out waiting for table "${name}"`);
  };
  await waitForTable('visits');
  await waitForTable('card_action_handlers');
  await purgeFixtures(pool);

  const adminClient = await login(users.admin.email, PASSWORD);

  // ── Seed card-action handlers ──────────────────────────────────────────────
  const vcmHandlerRes = await adminClient.post('/api/admin/card-action-handlers', {
    name: HANDLER_NAME_VCM,
    type: 'schedule_visit',
    config: { visitType: 'survey', defaultDurationMin: 60 },
    bindings: [],
  });
  const vcmHandlerId = vcmHandlerRes.json?.id;
  record(
    'seed schedule_visit handler',
    'status=201 with numeric id',
    `status=${vcmHandlerRes.status} id=${vcmHandlerId}`,
    vcmHandlerRes.status === 201 && Number.isInteger(vcmHandlerId),
  );

  if (!vcmHandlerId) {
    console.error('  Handler seeding failed — skipping Puppeteer probes.');
    await cleanupAndExit(1);
    return;
  }

  // ── Launch Puppeteer ───────────────────────────────────────────────────────
  const executablePath = findChromium();
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      defaultViewport: { width: 1280, height: 900 },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  } catch (launchErr) {
    const msg = (launchErr?.message || String(launchErr)).slice(0, 200);
    for (const l of PROBE_LABELS) skip(l, 'browser launched', `browser launch failed: ${msg}`);
    await cleanupAndExit(1);
    return;
  }

  try {
    // ── [VCM-PAST / VCM-BACK / VCM-PROCEED] ScheduleVisitModal past-time guard

    console.log('\n  [VCM] ScheduleVisitModal past-time guard');
    const vcmPage = await browser.newPage();
    vcmPage.on('pageerror', () => {});
    vcmPage.on('console',   () => {});
    await vcmPage.setCacheEnabled(false);
    await injectSession(vcmPage, adminClient.cookie);
    await vcmPage.goto(`${BASE}/customers`, { waitUntil: 'domcontentloaded', timeout: 25000 });

    const vcmHandlerObj = {
      id:       vcmHandlerId,
      type:     'schedule_visit',
      config:   { visitType: 'survey', defaultDurationMin: 60 },
      bindings: [],
    };
    const vcmCtxObj = {
      contactId:    FAKE_CONTACT_ID_VCM,
      contactName:  'PrivTest VCM Contact',
      contactEmail: 'vcm@privtest.local',
    };
    const vcmModalOpened = await pollPage(vcmPage, (arg) => {
      if (typeof window.openCardActionModal === 'function') {
        window.openCardActionModal(arg.handler, arg.ctx);
      }
      const m = document.querySelector('[role=dialog]');
      if (!m) return null;
      return {
        hasPrimary: !!m.querySelector('[data-testid=cah-primary]'),
        hasTitle:   !!m.querySelector('input#cah-sv-title'),
      };
    }, { handler: vcmHandlerObj, ctx: vcmCtxObj }, 10000, 300);

    record(
      '[VCM] modal opens with DateTimePicker and Schedule button',
      'dialog with #cah-sv-title and [data-testid=cah-primary]',
      `got=${JSON.stringify(vcmModalOpened)}`,
      !!vcmModalOpened && vcmModalOpened.hasPrimary && vcmModalOpened.hasTitle,
    );

    if (vcmModalOpened) {
      const farFutureVcm = Date.now() + 100 * 3600 * 1000;
      await applyDateMock(vcmPage, farFutureVcm);

      // [VCM-PAST] Submit → past-confirm dialog.
      await vcmPage.evaluate(() => document.querySelector('[data-testid=cah-primary]').click());
      const vcmPastDialog = await pollPage(vcmPage, () => {
        const dialogs = [...document.querySelectorAll('[role=dialog]')];
        const past = dialogs.find(d => d.textContent.includes('Schedule in the past?'));
        if (!past) return null;
        return {
          hasTitle:    past.textContent.includes('Schedule in the past?'),
          hasBody:     past.textContent.includes('already passed'),
          hasGoBack:   !!([...past.querySelectorAll('button')].find(b => b.textContent.trim() === 'Go back')),
          hasSchedule: !!past.querySelector('[data-testid=cah-past-confirm]'),
        };
      }, null, 6000);

      record(
        '[VCM-PAST] past-confirm dialog appears when submitting with past startDt',
        'dialog with "Schedule in the past?" + "Go back" + "Schedule anyway"',
        `got=${JSON.stringify(vcmPastDialog)}`,
        !!vcmPastDialog && vcmPastDialog.hasTitle && vcmPastDialog.hasGoBack && vcmPastDialog.hasSchedule,
      );

      // [VCM-BACK] "Go back" dismisses dialog, form stays open.
      await vcmPage.evaluate(() => {
        const dialogs = [...document.querySelectorAll('[role=dialog]')];
        const past = dialogs.find(d => d.textContent.includes('Schedule in the past?'));
        const btn = past && [...past.querySelectorAll('button')].find(b => b.textContent.trim() === 'Go back');
        if (btn) btn.click();
      });
      const vcmAfterGoBack = await pollPage(vcmPage, () => {
        const dialogs = [...document.querySelectorAll('[role=dialog]')];
        const pastGone      = !dialogs.some(d => d.textContent.includes('Schedule in the past?'));
        const formStillOpen = dialogs.some(d => !!d.querySelector('[data-testid=cah-primary]'));
        if (!pastGone) return null;
        return { pastGone, formStillOpen };
      }, null, 5000);
      record(
        '[VCM-BACK] "Go back" dismisses dialog; scheduling form stays open',
        'past-confirm gone, primary button still present',
        `got=${JSON.stringify(vcmAfterGoBack)}`,
        !!vcmAfterGoBack && vcmAfterGoBack.pastGone && vcmAfterGoBack.formStillOpen,
      );

      // [VCM-PROCEED] "Schedule anyway" → POST /api/visits.
      const vcmRequests = [];
      const vcmReqListener = (req) => {
        const u = req.url();
        if (u.includes('/api/visits') || u.includes('/api/events')) {
          vcmRequests.push({ url: u, method: req.method() });
        }
      };
      vcmPage.on('request', vcmReqListener);

      await vcmPage.evaluate(() => document.querySelector('[data-testid=cah-primary]')?.click());
      const vcmPastDialog2 = await pollPage(vcmPage, () => {
        const dialogs = [...document.querySelectorAll('[role=dialog]')];
        return dialogs.some(d => d.textContent.includes('Schedule in the past?')) || null;
      }, null, 5000);

      if (vcmPastDialog2) {
        await vcmPage.evaluate(() => {
          const btn = document.querySelector('[data-testid=cah-past-confirm]');
          if (btn) btn.click();
        });
        await pollPage(
          vcmPage,
          () => !document.querySelector('[data-testid=cah-primary]') || null,
          null,
          6000,
        );
      }
      vcmPage.off('request', vcmReqListener);

      const vcmVisitReq = vcmRequests.find(r => /\/api\/visits(?:$|\?)/.test(r.url) && r.method === 'POST');
      record(
        '[VCM-PROCEED] "Schedule anyway" fires POST /api/visits',
        'one POST to /api/visits',
        `requests=${JSON.stringify(vcmRequests)}`,
        !!vcmVisitReq,
      );

      await restoreDateMock(vcmPage);
    } else {
      skip('[VCM-PAST] past-confirm dialog appears when submitting with past startDt', 'dialog present', 'modal did not open — skipped');
      skip('[VCM-BACK] "Go back" dismisses dialog; scheduling form stays open', 'dialog gone', 'skipped');
      skip('[VCM-PROCEED] "Schedule anyway" fires POST /api/visits', 'POST /api/visits', 'skipped');
    }

    await vcmPage.close();

    // ── [WARN-VCM] 15-minute warning in ScheduleVisitModal via DateTimePicker ──
    //
    // ScheduleVisitModal has no edit mode from the customer-detail flow; it
    // always opens with initialStart = now + 24 h. To trigger the warning we:
    //   1. Open the modal via openCardActionModal.
    //   2. Interact with the #cah-sv-start DateTimePicker to type a near-future
    //      time (now + 10 min). MUI DateTimePicker segments accept digit input.
    //   3. React fires onChange → startDt state updates → useEffect re-runs
    //      checkApproaching() → startTimeWarning = true → Alert appears.

    console.log('\n  [WARN-VCM] ScheduleVisitModal 15-minute warning');

    const vcmWarnPage = await browser.newPage();
    vcmWarnPage.on('pageerror', () => {});
    vcmWarnPage.on('console',   () => {});
    await vcmWarnPage.setCacheEnabled(false);
    await injectSession(vcmWarnPage, adminClient.cookie);
    await vcmWarnPage.goto(`${BASE}/customers`, { waitUntil: 'domcontentloaded', timeout: 25000 });

    const vcmWarnHandlerObj = {
      id:       vcmHandlerId,
      type:     'schedule_visit',
      config:   { visitType: 'survey', defaultDurationMin: 60 },
      bindings: [],
    };
    const vcmWarnCtxObj = {
      contactId:    FAKE_CONTACT_ID_VCM,
      contactName:  'PrivTest VCM Warn Contact',
      contactEmail: 'vcmwarn@privtest.local',
    };

    // Wait for the modal to open with the DateTimePicker.
    const vcmWarnModalOpened = await pollPage(vcmWarnPage, (arg) => {
      if (typeof window.openCardActionModal === 'function') {
        window.openCardActionModal(arg.handler, arg.ctx);
      }
      const m = document.querySelector('[role=dialog]');
      if (!m) return null;
      return !!m.querySelector('input#cah-sv-start') || null;
    }, { handler: vcmWarnHandlerObj, ctx: vcmWarnCtxObj }, 10000, 300);

    if (!vcmWarnModalOpened) {
      record(
        '[WARN-VCM] modal opens with DateTimePicker',
        'dialog with input#cah-sv-start present',
        'modal did not open — skipped',
        false,
      );
    } else {
      // Compute near-future time: real now + 10 min.
      const nearFutureMs = Date.now() + 10 * 60 * 1000;
      const nf = new Date(nearFutureMs);
      const pad = n => String(n).padStart(2, '0');
      // Segments for MUI DateTimePicker (en-US locale): MM DD YYYY hh mm AM/PM
      const monthStr   = pad(nf.getMonth() + 1);
      const dayStr     = pad(nf.getDate());
      const yearStr    = String(nf.getFullYear());
      const hourRaw    = nf.getHours() % 12 || 12; // 1–12
      const hourStr    = pad(hourRaw);
      const minuteStr  = pad(nf.getMinutes());
      const ampmKey    = nf.getHours() < 12 ? 'a' : 'p'; // a/p triggers AM/PM in MUI

      // Click the start input to focus the first segment (month).
      await vcmWarnPage.click('input#cah-sv-start');
      await new Promise(r => setTimeout(r, 200));

      // MUI DateTimePicker segments auto-advance when the segment is filled.
      // Typing the digits for each segment in sequence fills the full date/time.
      await vcmWarnPage.keyboard.type(monthStr);  // month (MM)
      await vcmWarnPage.keyboard.type(dayStr);    // day   (DD)
      await vcmWarnPage.keyboard.type(yearStr);   // year  (YYYY)
      await vcmWarnPage.keyboard.type(hourStr);   // hour  (hh)
      await vcmWarnPage.keyboard.type(minuteStr); // min   (mm)
      // Toggle AM/PM by pressing 'a' or 'p'.
      await vcmWarnPage.keyboard.press(ampmKey === 'a' ? 'KeyA' : 'KeyP');
      // The pollPage below waits for the alert — no fixed delay needed here.

      // Assert the warning Alert appeared.
      const vcmWarnAlert = await pollPage(vcmWarnPage, () => {
        const alerts = [...document.querySelectorAll('[role=alert]')];
        const warn = alerts.find(a =>
          a.textContent.includes('less than 15 minutes') ||
          a.textContent.includes('already passed')
        );
        if (!warn) return null;
        return { text: warn.textContent.trim().slice(0, 120) };
      }, null, 8000);

      record(
        '[WARN-VCM] 15-minute warning Alert appears in ScheduleVisitModal after DateTimePicker update',
        'Alert with "less than 15 minutes" or "already passed" text',
        vcmWarnAlert ? `text="${vcmWarnAlert.text}"` : 'not found',
        !!vcmWarnAlert,
      );
    }

    await vcmWarnPage.close();
  } catch (e) {
    console.error('Unexpected error in test body:', e);
    record('test-body', 'no uncaught error', String(e), false);
  } finally {
    await browser.close().catch(() => {});
  }

  const failed = findings.filter(f => !f.ok && !f.skipped).length;
  await cleanupAndExit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
