'use strict';
// test/calendar-page/run.js
//
// End-to-end live test for the new React + MUI Calendar page (task #790).
// Mirrors the pattern used by test/design-visit-list/run.js: boots a
// disposable server with the privileges harness, drives the UI with
// Puppeteer, writes a markdown report to test-results/calendar-page.md, and
// exits non-zero on failure.
//
// Covers:
//   [API] GET /api/visits with from/to params returns seeded rows.
//   [NAV] Week nav (prev/next/today) updates the agenda day cards
//         (header title + #of cal-day-card elements that match the new
//         week window).
//   [PRF] Workshop toggle persists via PATCH /api/users/me/prefs
//         (calShowWorkshop) and the saved value is read back via GET.
//   [TSK] Personal task add → toggle done → delete round-trip works
//         from the UI; assertions are cross-checked via the DB-backed
//         /api/personal-tasks endpoint.
//   [VIS] Visit modal can create, edit, and delete a visit; DB rows
//         reflect each step.
//   [GCL] When the Google-Calendar status is mocked to connected, the
//         "Also add to Google Calendar" toggle appears and persists the
//         pref via PATCH /api/users/me/prefs (gcal_sync_pref).
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:calendar-page
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:calendar-page

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

// ── helpers ───────────────────────────────────────────────────────────────────
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

async function pollPage(page, fn, arg, timeoutMs = 8000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let got = null;
    try { got = await page.evaluate(fn, arg); } catch {}
    if (got) return got;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

async function purgeFixtures(pool, userIds) {
  try {
    await pool.query(
      `DELETE FROM visits WHERE created_by = ANY($1::text[])`,
      [userIds],
    );
  } catch {}
}

// Open /calendar as the given user. Each user gets its own incognito
// context so injected `connect.sid` cookies for one user don't clobber
// another's in the shared default jar.
async function openCalendar(browser, jar, { mockGoogleConnected = false } = {}) {
  const ctx = await (browser.createBrowserContext
    ? browser.createBrowserContext()
    : browser.createIncognitoBrowserContext());
  const page = await ctx.newPage();
  page.__ctx = ctx;
  await page.setCacheEnabled(false);

  const pageLogs = [];
  page.on('console',       m => pageLogs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror',     e => pageLogs.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', r => pageLogs.push(`[reqfailed] ${r.url()} ${r.failure()?.errorText || ''}`));
  page.on('response',      r => {
    const s = r.status();
    if (s >= 400) pageLogs.push(`[resp ${s}] ${r.request().method()} ${r.url()}`);
  });

  if (mockGoogleConnected) {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      // Only intercept the /api/auth/status probe — it has no real backend
      // route and the page falls back to googleConnected=false otherwise.
      const u = req.url();
      if (u.endsWith('/api/auth/status')) {
        req.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ google: true }),
        });
      } else {
        req.continue();
      }
    });
  }

  await injectSession(page, jar);
  await page.goto(`${BASE}/calendar`, { waitUntil: 'domcontentloaded', timeout: 25000 });
  // Wait for the React island to mount — "New visit" button is a stable
  // anchor that only renders after CalendarPage finishes its first paint.
  await pollPage(page, () => {
    const btn = Array.from(document.querySelectorAll('button'))
      .find(b => (b.textContent || '').trim() === 'New visit');
    return btn ? 'ok' : null;
  }, null, 15000);
  // Wait for the header title to appear (the agenda's week is then computed).
  await pollPage(page, () => {
    const el = document.querySelector('[data-testid="cal-header-title"]');
    return el && el.textContent && el.textContent.trim() ? 'ok' : null;
  }, null, 8000);
  // Wait for the agenda to settle (loading → day cards).
  await pollPage(page, () => {
    const cards = document.querySelectorAll('[data-testid="cal-day-card"]');
    return cards.length === 7 ? 'ok' : null;
  }, null, 12000);

  page.__logs = pageLogs;
  return page;
}

function readHeaderTitle(page) {
  return page.evaluate(() =>
    (document.querySelector('[data-testid="cal-header-title"]')?.textContent || '').trim()
  );
}

function readDayCardIsos(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="cal-day-card"]'))
      .map(c => c.getAttribute('data-iso')),
  );
}

// Click a hidden MUI Switch/Checkbox input. The visible track/thumb is
// `pointer-events:none`-ish in tests, and React's onChange for
// type=checkbox listens for native 'click' on the input. `el.click()`
// works in normal browsers but is unreliable here, so we dispatch a
// proper MouseEvent.
async function clickInput(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    // Native .click() on a checkbox toggles checked + fires React onChange
    // with the post-click target.checked, which is what controlled MUI
    // components rely on. dispatchEvent(MouseEvent) does NOT toggle.
    el.click();
    return true;
  }, selector);
}

function clickByText(page, text) {
  return page.evaluate((t) => {
    const btn = Array.from(document.querySelectorAll('button'))
      .find(b => (b.textContent || '').trim() === t);
    if (!btn) return false;
    btn.click();
    return true;
  }, text);
}

function clickByAriaLabel(page, label) {
  return page.evaluate((l) => {
    const el = document.querySelector(`button[aria-label="${l}"], [aria-label="${l}"]`);
    if (!el) return false;
    (el).click();
    return true;
  }, label);
}

// Set a value on a controlled MUI TextField input and dispatch a native
// 'input' event so React picks the change up.
async function setReactInputValue(page, selector, value) {
  return page.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, val); else el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, selector, value);
}

// ── main ──────────────────────────────────────────────────────────────────────
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
  console.log(`\n  calendar-page E2E  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);

  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  admin=${users.admin.email}  member=${users.member.email}`);

  const { child, logBuf } = spawnServer();
  let exited = false;
  child.on('exit', () => { exited = true; });

  const findings = [];
  function record(name, expected, observed, ok) {
    findings.push({ name, expected, observed, ok });
    const mark = ok ? '  ✓' : '  ✗';
    console.log(`${mark}  ${name}`);
    if (!ok) {
      console.log(`     expected : ${expected}`);
      console.log(`     observed : ${observed}`);
    }
  }

  const allUserIds = Object.values(users).map(u => u.id);
  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try {
      await purgeFixtures(pool, allUserIds);
      // Wipe synthetic personal tasks (JSON file) for our seeded users.
      try {
        const tasksFile = path.resolve(__dirname, '..', '..', 'data', '__personal_tasks.json');
        if (fs.existsSync(tasksFile)) {
          const raw = fs.readFileSync(tasksFile, 'utf8');
          const arr = JSON.parse(raw);
          const filtered = arr.filter(t => !allUserIds.includes(t.userId));
          fs.writeFileSync(tasksFile, JSON.stringify(filtered));
        }
      } catch {}
      await cleanupTestData(pool);
    } catch {}
    await pool.end().catch(() => {});
    process.exit(code);
  };
  process.on('SIGINT',  () => cleanupAndExit(130));
  process.on('SIGTERM', () => cleanupAndExit(130));
  process.on('uncaughtException',  (e) => { console.error('Uncaught:',  e); cleanupAndExit(2); });
  process.on('unhandledRejection', (e) => { console.error('Unhandled:', e); cleanupAndExit(2); });

  // ── Boot test server ───────────────────────────────────────────────────────
  try {
    await waitForServer();
    await resetRateLimitStore(pool);
    console.log(`  Server up at ${BASE}`);
  } catch (e) {
    console.error('Server boot failed:', e.message);
    console.error(logBuf.join('').slice(-2000));
    await cleanupAndExit(2);
    return;
  }

  // Wait for visits table (created async on boot).
  const waitForTable = async (name) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const r = await pool.query(`SELECT to_regclass($1) AS t`, [name]);
      if (r.rows[0].t) return;
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`Timed out waiting for table ${name}`);
  };
  await waitForTable('visits');
  console.log('  visits table ready');

  await purgeFixtures(pool, allUserIds);

  // ── Logins ─────────────────────────────────────────────────────────────────
  const adminClient  = await login(users.admin.email,  users.admin.password);
  const memberClient = await login(users.member.email, users.member.password);

  // Seed one visit owned by admin so the calendar has at least one row.
  const now = new Date();
  const seedStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0);
  const seedEnd   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 11, 0, 0);
  const seedRow = await pool.query(
    `INSERT INTO visits (created_by, customer_id, customer_name, type, title,
                         start_at, end_at, is_workshop, notes, location)
     VALUES ($1, NULL, NULL, 'design', 'seeded calendar visit', $2, $3, false,
             'seeded by test', 'Workshop')
     RETURNING id, start_at, end_at`,
    [users.admin.id, seedStart.toISOString(), seedEnd.toISOString()],
  );
  const seededVisitId = seedRow.rows[0].id;
  console.log(`  Seeded visit id=${seededVisitId} at ${seedStart.toISOString()}`);

  // ════════════════════════════════════════════════════════════════════════════
  // [API] GET /api/visits with from/to params returns seeded visit
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n  [API] GET /api/visits?from=…&to=…');
  {
    const from = new Date(seedStart.getTime() - 24 * 3600 * 1000).toISOString();
    const to   = new Date(seedStart.getTime() + 24 * 3600 * 1000).toISOString();
    const r = await adminClient.get(
      `/api/visits?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
    const rows = Array.isArray(r.json) ? r.json : [];
    const found = rows.find(v => v.id === seededVisitId);
    record(
      '[API] /api/visits returns seeded visit within window',
      `status=200, contains id=${seededVisitId}`,
      `status=${r.status}, rows=${rows.length}, ids=[${rows.map(v => v.id).join(',')}]`,
      r.status === 200 && !!found && found.type === 'design',
    );

    // Sanity: from/to required.
    const r400 = await adminClient.get('/api/visits');
    record(
      '[API] /api/visits without from/to is rejected (400)',
      'status=400',
      `status=${r400.status}`,
      r400.status === 400,
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // [UI] Puppeteer-driven probes
  // ════════════════════════════════════════════════════════════════════════════
  const UI_LABELS = [
    '[NAV] /calendar renders 7 day cards under React mount',
    '[NAV] Next week button updates the header title + day-card ISOs',
    '[NAV] Today button restores the current week',
    '[PRF] Workshop toggle PATCHes /api/users/me/prefs (calShowWorkshop)',
    '[PRF] Workshop pref read-back via GET reflects the toggled value',
    '[TSK] Add personal task from UI persists via /api/personal-tasks',
    '[TSK] Toggling a task done flips the persisted record',
    '[TSK] Deleting a task removes it from /api/personal-tasks',
    '[VIS] Visit modal can create a visit (DB row appears)',
    '[VIS] Visit modal can edit a visit (notes update in DB)',
    '[VIS] Visit modal can delete a visit (DB row disappears)',
    '[GCL] When /api/auth/status is mocked connected, gcal toggle is visible',
    '[GCL] Toggling gcal persists gcal_sync_pref via /api/users/me/prefs',
  ];

  if (!puppeteer) {
    for (const l of UI_LABELS) record(l, 'puppeteer installed', 'puppeteer not installed', false);
  } else {
    const { findChromium } = require('../shared/find-chromium');
    let browser = null;
    let browserLaunchErr = null;
    const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox'];
    const launchAttempts = [{ args: launchArgs }];
    const sysChrome = findChromium();
    if (sysChrome) launchAttempts.push({ executablePath: sysChrome, args: launchArgs });
    for (const opts of launchAttempts) {
      try {
        browser = await puppeteer.launch({ headless: true, ...opts });
        browserLaunchErr = null;
        break;
      } catch (e) { browserLaunchErr = e; browser = null; }
    }

    if (!browser) {
      const msg = (browserLaunchErr?.message || String(browserLaunchErr)).slice(0, 200);
      for (const l of UI_LABELS) record(l, 'browser launched', `browser launch failed: ${msg}`, false);
    } else {
      try {
        // ── NAV (admin) ─────────────────────────────────────────────────────
        const adminPage = await openCalendar(browser, adminClient.cookie);

        const initialIsos = await readDayCardIsos(adminPage);
        const initialTitle = await readHeaderTitle(adminPage);
        record(UI_LABELS[0],
          '7 day cards rendered + header title non-empty',
          `cards=${initialIsos.length}, title="${initialTitle}"`,
          initialIsos.length === 7 && !!initialTitle);

        // Click "Next" week.
        await clickByAriaLabel(adminPage, 'Next week');
        const nextOk = await pollPage(adminPage, (prevFirst) => {
          const cards = Array.from(document.querySelectorAll('[data-testid="cal-day-card"]'));
          if (cards.length !== 7) return null;
          const first = cards[0].getAttribute('data-iso');
          if (first === prevFirst) return null;
          return { first, title: (document.querySelector('[data-testid="cal-header-title"]')?.textContent || '').trim() };
        }, initialIsos[0], 6000);
        record(UI_LABELS[1],
          `header title changes and first day ISO is +7 days from ${initialIsos[0]}`,
          `next=${JSON.stringify(nextOk)}`,
          !!nextOk
            && nextOk.title !== initialTitle
            && new Date(nextOk.first).getTime() - new Date(initialIsos[0]).getTime() === 7 * 24 * 3600 * 1000);

        // Click "Today".
        await clickByText(adminPage, 'Today');
        const todayOk = await pollPage(adminPage, (wantFirst) => {
          const cards = Array.from(document.querySelectorAll('[data-testid="cal-day-card"]'));
          if (cards.length !== 7) return null;
          if (cards[0].getAttribute('data-iso') !== wantFirst) return null;
          return 'ok';
        }, initialIsos[0], 6000);
        record(UI_LABELS[2],
          `first day ISO back to ${initialIsos[0]}`,
          `restored=${todayOk === 'ok'}`,
          todayOk === 'ok');

        // ── PRF (admin) ─────────────────────────────────────────────────────
        // Read current value first so we toggle to the opposite.
        // Use the UI state as the baseline — the React component defaults
        // showWorkshop=true and only later overwrites it from prefs, so the
        // raw GET (which can be {}) is not a reliable mirror of the toggle.
        const uiBefore = await adminPage.evaluate(() =>
          !!document.querySelector('[data-testid="cal-workshop-wrap"] input')?.checked);
        await clickInput(adminPage, '[data-testid="cal-workshop-wrap"] input');
        // Wait for the PATCH to land — we observe via a server-side GET.
        const targetVal = !uiBefore;
        const prefMatched = await (async () => {
          const deadline = Date.now() + 6000;
          while (Date.now() < deadline) {
            const r = await adminClient.get('/api/users/me/prefs');
            if (r.status === 200 && r.json && !!r.json.calShowWorkshop === targetVal) return true;
            await new Promise(r => setTimeout(r, 150));
          }
          return false;
        })();
        record(UI_LABELS[3],
          `PATCH succeeds; pref toggles from ${uiBefore} → ${targetVal}`,
          `matched=${prefMatched}`,
          prefMatched);

        const prefsAfter = await adminClient.get('/api/users/me/prefs');
        record(UI_LABELS[4],
          `GET /api/users/me/prefs returns calShowWorkshop=${targetVal}`,
          `prefs=${JSON.stringify(prefsAfter.json)}`,
          prefsAfter.status === 200
            && !!prefsAfter.json
            && !!prefsAfter.json.calShowWorkshop === targetVal);

        // ── TSK (member) ────────────────────────────────────────────────────
        // Use member so requirePrivilege('member') is honoured. Open a
        // dedicated calendar tab for the member.
        const memberPage = await openCalendar(browser, memberClient.cookie);

        // Open the <details> for personal tasks.
        await memberPage.evaluate(() => {
          const det = document.querySelector('[data-testid="cal-tasks"]');
          if (det && !det.hasAttribute('open')) det.setAttribute('open', '');
        });
        // Click "Add task" → reveals the form.
        await memberPage.evaluate(() => {
          const b = document.querySelector('[data-testid="cal-task-add-btn"]');
          if (b) b.click();
        });
        await pollPage(memberPage, () => {
          const input = document.querySelector('[data-testid="cal-tasks"] input[placeholder="Task title"]');
          return input ? 'ok' : null;
        }, null, 4000);
        const taskTitle = `e2e cal task ${runId}`;
        await setReactInputValue(
          memberPage,
          '[data-testid="cal-tasks"] input[placeholder="Task title"]',
          taskTitle,
        );
        // Click the "Add task" submit button (small contained button in
        // the form, with the same label).
        await memberPage.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('[data-testid="cal-tasks"] button'));
          const sub = btns.find(b => (b.textContent || '').trim() === 'Add task'
            && b.classList.contains('MuiButton-contained'));
          if (sub) sub.click();
        });
        const newTaskId = await pollPage(memberPage, (t) => {
          const rows = Array.from(document.querySelectorAll('[data-testid^="cal-task-row-"]'));
          for (const r of rows) {
            if ((r.textContent || '').includes(t)) return r.getAttribute('data-task-id');
          }
          return null;
        }, taskTitle, 8000);
        const taskAddedApi = await memberClient.get('/api/personal-tasks');
        const taskInApi = Array.isArray(taskAddedApi.json)
          && taskAddedApi.json.some(t => t.id === newTaskId && t.title === taskTitle);
        record(UI_LABELS[5],
          `UI shows new task + /api/personal-tasks contains it`,
          `id=${newTaskId} present=${taskInApi}`,
          !!newTaskId && taskInApi);

        // Toggle the checkbox.
        if (newTaskId) {
          await clickInput(memberPage, `.cal-task-checkbox-${newTaskId} input`);
        }
        const toggledOk = await (async () => {
          const deadline = Date.now() + 6000;
          while (Date.now() < deadline) {
            const r = await memberClient.get('/api/personal-tasks');
            const row = Array.isArray(r.json) ? r.json.find(t => t.id === newTaskId) : null;
            if (row && row.done === true) return true;
            await new Promise(r => setTimeout(r, 150));
          }
          return false;
        })();
        record(UI_LABELS[6],
          'task.done === true after UI click',
          `toggled=${toggledOk}`,
          toggledOk);

        // Delete the row.
        if (newTaskId) {
          await memberPage.evaluate((tid) => {
            const btn = document.querySelector(`[data-testid="cal-task-row-${tid}-delete"]`);
            if (btn) btn.click();
          }, newTaskId);
        }
        const deletedOk = await (async () => {
          const deadline = Date.now() + 6000;
          while (Date.now() < deadline) {
            const r = await memberClient.get('/api/personal-tasks');
            const row = Array.isArray(r.json) ? r.json.find(t => t.id === newTaskId) : null;
            if (!row) return true;
            await new Promise(r => setTimeout(r, 150));
          }
          return false;
        })();
        record(UI_LABELS[7],
          'task gone from /api/personal-tasks after Delete',
          `deleted=${deletedOk}`,
          deletedOk);

        // ── VIS — create (member) ───────────────────────────────────────────
        // Click "New visit" → modal opens.
        await clickByText(memberPage, 'New visit');
        await pollPage(memberPage, () =>
          document.querySelector('[data-testid="cal-visit-modal"]') ? 'ok' : null,
          null, 4000);
        // Type into the Notes textarea (`textarea:not([aria-hidden="true"])`
        // skips the hidden shadow textarea MUI renders for size measurement
        // on multiline TextField). Defaults for type/date/start/end are valid.
        const notesMarker = `e2e-cal-notes-${runId}`;
        await setReactInputValue(
          memberPage,
          '.MuiDialog-paper textarea:not([aria-hidden="true"])',
          notesMarker,
        );
        // Click Save.
        await memberPage.evaluate(() => {
          const b = document.querySelector('[data-testid="cal-visit-save"]');
          if (b) b.click();
        });
        // Modal closes; verify DB row.
        const created = await (async () => {
          const deadline = Date.now() + 6000;
          while (Date.now() < deadline) {
            const r = await pool.query(
              `SELECT id, notes FROM visits WHERE created_by = $1 AND notes = $2
               ORDER BY id DESC LIMIT 1`,
              [users.member.id, notesMarker],
            );
            if (r.rows[0]) return r.rows[0];
            await new Promise(r => setTimeout(r, 150));
          }
          return null;
        })();
        record(UI_LABELS[8],
          `visits row inserted with notes="${notesMarker}"`,
          `created=${JSON.stringify(created)}`,
          !!created);

        // ── VIS — edit ──────────────────────────────────────────────────────
        // Re-open by clicking the agenda row. Wait for the seeded visit
        // owned by this member to be present in the agenda (the page
        // reloaded after onSaved).
        const editTarget = created ? created.id : null;
        let editOk = false;
        if (editTarget) {
          await pollPage(memberPage, (id) =>
            document.querySelector(`[data-testid="cal-visit-row-${id}"]`) ? 'ok' : null,
            editTarget, 8000);
          await memberPage.evaluate((id) => {
            const r = document.querySelector(`[data-testid="cal-visit-row-${id}"]`);
            if (r) r.click();
          }, editTarget);
          await pollPage(memberPage, () =>
            document.querySelector('[data-testid="cal-visit-modal"]') ? 'ok' : null,
            null, 4000);
          const editedNotes = `${notesMarker}-edited`;
          await setReactInputValue(
            memberPage,
            '.MuiDialog-paper textarea:not([aria-hidden="true"])',
            editedNotes,
          );
          await memberPage.evaluate(() => {
            const b = document.querySelector('[data-testid="cal-visit-save"]');
            if (b) b.click();
          });
          editOk = await (async () => {
            const deadline = Date.now() + 6000;
            while (Date.now() < deadline) {
              const r = await pool.query(
                `SELECT notes FROM visits WHERE id = $1`, [editTarget]);
              if (r.rows[0]?.notes === editedNotes) return true;
              await new Promise(r => setTimeout(r, 150));
            }
            return false;
          })();
        }
        record(UI_LABELS[9],
          'visits.notes updates after Save in edit mode',
          `editOk=${editOk}`,
          editOk);

        // ── VIS — delete ────────────────────────────────────────────────────
        let deleteOk = false;
        if (editTarget) {
          // Auto-accept the confirm() dialog.
          memberPage.on('dialog', d => { d.accept().catch(() => {}); });
          // Re-open the modal.
          await pollPage(memberPage, (id) =>
            document.querySelector(`[data-testid="cal-visit-row-${id}"]`) ? 'ok' : null,
            editTarget, 6000);
          await memberPage.evaluate((id) => {
            const r = document.querySelector(`[data-testid="cal-visit-row-${id}"]`);
            if (r) r.click();
          }, editTarget);
          await pollPage(memberPage, () =>
            document.querySelector('[data-testid="cal-visit-modal"]') ? 'ok' : null,
            null, 4000);
          await memberPage.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('.MuiDialog-paper button'))
              .find(b => (b.textContent || '').trim() === 'Delete');
            if (btn) btn.click();
          });
          deleteOk = await (async () => {
            const deadline = Date.now() + 6000;
            while (Date.now() < deadline) {
              const r = await pool.query(`SELECT id FROM visits WHERE id = $1`, [editTarget]);
              if (r.rowCount === 0) return true;
              await new Promise(r => setTimeout(r, 150));
            }
            return false;
          })();
        }
        record(UI_LABELS[10],
          'visits row deleted after Delete in edit mode',
          `deleteOk=${deleteOk}`,
          deleteOk);

        await memberPage.close();
        try { await memberPage.__ctx?.close(); } catch {}
        await adminPage.close();
        try { await adminPage.__ctx?.close(); } catch {}

        // ── GCL — open a fresh page that mocks /api/auth/status ────────────
        const gcalPage = await openCalendar(browser, memberClient.cookie, { mockGoogleConnected: true });
        // Open the "New visit" modal.
        await clickByText(gcalPage, 'New visit');
        await pollPage(gcalPage, () =>
          document.querySelector('[data-testid="cal-visit-modal"]') ? 'ok' : null,
          null, 4000);
        const gcalVisible = await pollPage(gcalPage, () =>
          document.querySelector('[data-testid="cal-visit-gcal-wrap"] input') ? 'ok' : null,
          null, 6000);
        record(UI_LABELS[11],
          'cal-visit-gcal checkbox is rendered',
          `gcalVisible=${gcalVisible === 'ok'}`,
          gcalVisible === 'ok');

        // Clear any existing gcal pref then click the toggle.
        await memberClient.patch('/api/users/me/prefs', { gcal_sync_pref: false });
        await clickInput(gcalPage, '[data-testid="cal-visit-gcal-wrap"] input');
        const prefSaved = await (async () => {
          const deadline = Date.now() + 6000;
          while (Date.now() < deadline) {
            const r = await memberClient.get('/api/users/me/prefs');
            if (r.json && r.json.gcal_sync_pref === true) return true;
            await new Promise(r => setTimeout(r, 150));
          }
          return false;
        })();
        record(UI_LABELS[12],
          'gcal_sync_pref === true after clicking the toggle',
          `prefSaved=${prefSaved}`,
          prefSaved);

        await gcalPage.close();
        try { await gcalPage.__ctx?.close(); } catch {}
      } finally {
        await browser.close().catch(() => {});
      }
    }
  }

  // ── summary & report ──────────────────────────────────────────────────────
  const pass = findings.filter(f => f.ok).length;
  const fail = findings.filter(f => !f.ok).length;
  console.log(`\n  Results: ${pass} passed, ${fail} failed`);

  await writeReport(runId, findings);
  await cleanupAndExit(fail > 0 ? 1 : 0);
}

async function writeReport(runId, findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Calendar Page — E2E Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:calendar-page\``,
    '',
    '## Summary',
    '',
    `- Passed: ${findings.filter(f => f.ok).length} / ${findings.length}`,
    `- Failed: ${findings.filter(f => !f.ok).length} / ${findings.length}`,
    '',
    '## Results',
    '',
    '| Result | Probe | Expected | Observed |',
    '|---|---|---|---|',
    ...findings.map(f =>
      `| ${f.ok ? 'PASS' : 'FAIL'} | ${esc(f.name)} | ${esc(f.expected)} | ${esc(f.observed)} |`,
    ),
    '',
    '## Coverage',
    '',
    '- **[API]** `GET /api/visits` returns the seeded visit within a',
    '  ±24-hour window, and is rejected (400) without `from`/`to`.',
    '- **[NAV]** Loads `/calendar`, asserts 7 `cal-day-card` elements are',
    '  rendered, then clicks "Next week" / "Today" and verifies the',
    '  header title plus `data-iso` of each day card update accordingly.',
    '- **[PRF]** Clicks the workshop `Switch` and verifies the',
    '  `calShowWorkshop` value persisted via `PATCH /api/users/me/prefs`',
    '  is then returned by a follow-up `GET`.',
    '- **[TSK]** Opens the Personal Tasks section, drives the Add → toggle',
    '  done → Delete flow from the UI, and cross-checks each step against',
    '  the server-side `/api/personal-tasks` endpoint.',
    '- **[VIS]** Drives the New-visit → Save flow (creating a `visits` row',
    '  with a unique notes marker), re-opens the freshly created visit by',
    '  clicking the agenda row, edits the notes and saves, then re-opens',
    '  again and deletes — each step asserted against the `visits` table.',
    '- **[GCL]** Mocks `GET /api/auth/status` to `{ google: true }` via',
    '  Puppeteer request interception so the "Also add to Google Calendar"',
    '  toggle renders. Clicks the toggle and asserts',
    '  `gcal_sync_pref === true` in `GET /api/users/me/prefs`.',
    '',
    '## Notes',
    '',
    '- Synthetic visits, personal tasks, and `privtest-` user fixtures are',
    '  purged on exit (and on SIGINT/SIGTERM). Personal tasks live in',
    '  `data/__personal_tasks.json`, so the cleanup hook filters out any',
    '  rows belonging to the seeded user ids.',
    '- The harness strips `GOOGLE_CLIENT_*` so the calendar page reports',
    '  Google as disconnected by default; the `[GCL]` probe mocks',
    '  `/api/auth/status` on a dedicated page so the gcal-toggle code path',
    '  can be exercised end-to-end without real OAuth.',
  ];
  const outPath = path.join(dir, 'calendar-page.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Report: test-results/calendar-page.md`);
}

main();
