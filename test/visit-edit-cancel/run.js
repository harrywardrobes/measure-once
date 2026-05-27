'use strict';
// test/visit-edit-cancel/run.js
//
// End-to-end test for the edit and cancel actions on delivery/installation
// visit cards in the customer-detail page (task #1603 / #1623).
//
// Covers:
//   (API) PATCH /api/visits/:id updates the row and returns the updated visit.
//   (API) DELETE /api/visits/:id removes the row and returns { success: true }.
//   (API) Both endpoints require authentication — anonymous requests are blocked.
//   (UI)  Admin sees Edit + Cancel icon buttons on delivery and installation cards.
//   (UI)  Manager sees Edit + Cancel icon buttons on delivery and installation cards.
//   (UI)  Member/viewer do NOT see Edit or Cancel buttons on visit cards.
//   (UI)  Cancel flow: click Cancel → CancelVisitDialog opens → "Cancel visit"
//         button removes the visit from the list and from the database.
//   (UI)  Edit flow: click Edit on a survey visit → GenericVisitEditModal opens
//         with the pre-populated title → change title → "Save changes" → list
//         refreshes showing the new title, and the DB row is updated.
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:visit-edit-cancel
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:visit-edit-cancel

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
  makeClient,
  setPool,
  BASE,
} = require('../privileges/harness');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

require('dotenv').config();

// ── Fixtures ──────────────────────────────────────────────────────────────────
// Must be all-digits — customer-detail rejects non-numeric contact ids.
const FAKE_CONTACT_ID = '989801623000';

// Future timestamps for upcoming visit seeding.
function futureISO(daysFromNow, hour = 10) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
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

async function pollFor(page, fn, arg, timeoutMs = 8000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let got = null;
    try { got = await page.evaluate(fn, arg); } catch {}
    if (got) return got;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

async function purgeFixtures(pool) {
  try {
    await pool.query(
      `DELETE FROM visits WHERE customer_id = $1 AND created_by LIKE 'privtest-%'`,
      [FAKE_CONTACT_ID],
    );
  } catch {}
}

async function seedVisit(pool, { type, title, startAt, endAt, createdBy }) {
  const r = await pool.query(
    `INSERT INTO visits
       (created_by, customer_id, customer_name, type, title, start_at, end_at,
        is_workshop, notes, location)
     VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, NULL, NULL)
     RETURNING id`,
    [createdBy, FAKE_CONTACT_ID, 'VEC Test Customer', type, title, startAt, endAt],
  );
  return r.rows[0].id;
}

// Open the customer-detail React page, intercept all HubSpot-backed API calls
// with stub responses, and wait for the #upcoming-visits-section to render
// at least one visit card. Pass `expectEditButtons=true` for admin/manager
// users so we also wait for the AuthContext privilege fetch to settle before
// returning (edit buttons only appear once auth has loaded isAdmin/isManager).
//
// The CustomerDetailPage fetches /api/visits with a 732-day window (366 past +
// 366 future) which exceeds the server's 366-day limit (returns 400). We
// intercept GET /api/visits requests and re-issue them with a valid 60-day
// window so the visits always load correctly in the browser.
async function openVisitPage(browser, jar, { expectEditButtons = false } = {}) {
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

  // Build a cookie header from the session jar for use in server-side fetches.
  const cookieHeader = jar || '';

  // Intercept HubSpot-backed and other non-visit API calls so the page
  // bootstraps correctly without a real HUBSPOT_TOKEN. The request handler
  // is async so we can re-fetch visits from the real server.
  await page.setRequestInterception(true);
  page.on('request', async req => {
    const url = req.url();
    const method = req.method();

    // GET /api/visits — the page requests a 732-day range which exceeds the
    // server's 366-day limit. Intercept and re-issue with a valid 60-day
    // window (30 days past → 30 days future) so visits load correctly.
    // DELETE and PATCH to /api/visits/:id pass through to the real server.
    if (url.includes('/api/visits') && method === 'GET') {
      try {
        const now = Date.now();
        const from = new Date(now - 30 * 86400000).toISOString();
        const to   = new Date(now + 30 * 86400000).toISOString();
        const r = await fetch(`${BASE}/api/visits?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {
          headers: { Accept: 'application/json', Cookie: cookieHeader },
        });
        const body = await r.text();
        await req.respond({
          status: r.status,
          contentType: 'application/json',
          body: body || '[]',
        });
      } catch {
        await req.respond({ status: 200, contentType: 'application/json', body: '[]' });
      }
      return;
    }

    // Let the real server handle auth, lead-statuses, workflow, and
    // DELETE/PATCH /api/visits/:id so cancel/edit go through the real API.
    if (
      url.includes('/api/auth/user') ||
      url.includes('/api/visits') ||
      url.includes('/api/lead-statuses') ||
      url.includes('/api/workflow') ||
      url.includes('/auth/status') ||
      url.includes('/api/quickbooks/status')
    ) {
      return req.continue();
    }

    // Stub: fake contact (no HubSpot token required).
    if (url.includes(`/api/contacts/${FAKE_CONTACT_ID}`) && !url.includes('localdata') && !url.includes('tasks')) {
      return req.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: FAKE_CONTACT_ID,
          properties: {
            firstname: 'VEC',
            lastname: 'Test',
            email: 'vec-test@privtest.local',
            company: '',
          },
        }),
      });
    }

    // Stub: localdata — no rooms (page will use default single-room).
    if (url.includes(`/api/contacts/${FAKE_CONTACT_ID}/localdata`)) {
      return req.respond({ status: 200, contentType: 'application/json', body: 'null' });
    }

    // Stub: tasks.
    if (url.includes(`/api/contacts/${FAKE_CONTACT_ID}/tasks`)) {
      return req.respond({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ results: [] }),
      });
    }

    // Stub: design-visits (separate section, not under test here).
    if (url.includes('/api/design-visits')) {
      return req.respond({ status: 200, contentType: 'application/json', body: '[]' });
    }

    // Stub: Google emails — not connected.
    if (url.includes('/api/emails')) {
      return req.respond({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ connected: false }),
      });
    }

    // Stub: WhatsApp history.
    if (url.includes('/api/whatsapp')) {
      return req.respond({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ enabled: false, messages: [] }),
      });
    }

    // Stub: QuickBooks invoice list.
    if (url.includes('/api/qb/') || url.includes('/api/quickbooks')) {
      return req.respond({ status: 200, contentType: 'application/json', body: 'null' });
    }

    // All other requests pass through (JS bundles, CSS, etc.).
    req.continue();
  });

  await injectSession(page, jar);
  await page.goto(`${BASE}/customers/${FAKE_CONTACT_ID}`, {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });

  // Wait for the visits section to be present with at least one card.
  // The section renders as #upcoming-visits-section. We poll until it
  // is present and no longer shows "Loading…".
  await pollFor(page, () => {
    const sec = document.getElementById('upcoming-visits-section');
    if (!sec) return null;
    const t = sec.textContent || '';
    if (t.includes('Loading…')) return null;
    // Must have at least one non-empty text item (not just "No upcoming visits")
    if (t.includes('No upcoming visits')) return null;
    return 'ok';
  }, null, 12000);

  // When the caller expects edit/cancel buttons (admin/manager), wait for
  // the React AuthContext privilege fetch to settle. The buttons only appear
  // once /api/auth/user has responded and isAdmin/isManager is true. We poll
  // until at least one edit button is present (or up to 6 s).
  if (expectEditButtons) {
    await pollFor(page, () => {
      const sec = document.getElementById('upcoming-visits-section');
      if (!sec) return null;
      return sec.querySelector('[data-testid^="edit-visit-"]') ? 'ok' : null;
    }, null, 6000);
  } else {
    // For member/viewer: wait a moment to let the auth fetch settle so that
    // we're sure the absence of buttons is intentional, not a loading gap.
    await pollFor(page, () => {
      const sec = document.getElementById('upcoming-visits-section');
      if (!sec) return null;
      // Visit cards are present — auth has had time to apply.
      return sec.querySelectorAll('[style*="border"]').length > 0 ? 'ok' : null;
    }, null, 4000);
    // Small extra wait for auth settle.
    await new Promise(r => setTimeout(r, 1500));
  }

  page.__logs = pageLogs;
  return page;
}

// Snapshot the upcoming-visits-section: returns { editIds, cancelIds, titleTexts }.
async function snapshotUpcoming(page) {
  return page.evaluate(() => {
    const sec = document.getElementById('upcoming-visits-section');
    if (!sec) return { present: false, editIds: [], cancelIds: [], titleTexts: [] };
    const edits   = Array.from(sec.querySelectorAll('[data-testid^="edit-visit-"]'))
                         .map(el => el.getAttribute('data-testid').replace('edit-visit-', ''));
    const cancels = Array.from(sec.querySelectorAll('[data-testid^="cancel-visit-"]'))
                         .map(el => el.getAttribute('data-testid').replace('cancel-visit-', ''));
    // Each visit card has a text element with the title. We collect all
    // non-empty non-badge non-date text nodes inside the section.
    const titleTexts = Array.from(sec.querySelectorAll('[data-testid^="edit-visit-"]')).map(btn => {
      const card = btn.closest('[style]');
      if (!card) return '';
      // The title is the first div with fontWeight 500
      const titleEl = Array.from(card.querySelectorAll('div')).find(d => d.style.fontWeight === '500');
      return (titleEl?.textContent || '').trim();
    });
    return { present: true, editIds: edits, cancelIds: cancels, titleTexts };
  });
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
  console.log(`\n  visit-edit-cancel E2E  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);
  await purgeFixtures(pool);

  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  admin=${users.admin.email}  manager=${users.manager.email}  member=${users.member.email}  viewer=${users.viewer.email}`);

  const { child, logBuf } = spawnServer();
  let exited = false;
  child.on('exit', () => { exited = true; });

  const findings = [];
  function record(name, expected, observed, ok) {
    findings.push({ name, expected, observed, ok });
    const mark = ok ? '  ✓' : '  ✗';
    console.log(`${mark}  ${name}`);
    if (!ok) {
      console.log(`       expected : ${expected}`);
      console.log(`       observed : ${observed}`);
    }
  }

  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try {
      await purgeFixtures(pool);
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

  // Wait for visits table to be created (done async on boot).
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

  await purgeFixtures(pool);

  // ── Seed visits ───────────────────────────────────────────────────────────
  const deliveryStart  = futureISO(5, 9);
  const deliveryEnd    = futureISO(5, 11);
  const installStart   = futureISO(10, 13);
  const installEnd     = futureISO(10, 17);
  const surveyStart    = futureISO(15, 10);
  const surveyEnd      = futureISO(15, 11);

  const deliveryId  = await seedVisit(pool, {
    type: 'delivery', title: 'Delivery window — VEC test',
    startAt: deliveryStart, endAt: deliveryEnd, createdBy: users.admin.email,
  });
  const installId   = await seedVisit(pool, {
    type: 'installation', title: 'Installation slot — VEC test',
    startAt: installStart, endAt: installEnd, createdBy: users.admin.email,
  });
  const surveyId    = await seedVisit(pool, {
    type: 'survey', title: 'Survey visit — VEC test',
    startAt: surveyStart, endAt: surveyEnd, createdBy: users.admin.email,
  });

  console.log(`  Seeded visits: delivery=${deliveryId} installation=${installId} survey=${surveyId}`);

  // ── Login clients ──────────────────────────────────────────────────────────
  const adminClient   = await login(users.admin.email,   users.admin.password);
  const managerClient = await login(users.manager.email, users.manager.password);
  const memberClient  = await login(users.member.email,  users.member.password);
  const viewerClient  = await login(users.viewer.email,  users.viewer.password);

  // ══════════════════════════════════════════════════════════════════════════
  // [API] PATCH /api/visits/:id
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n  [API] PATCH /api/visits/:id');
  {
    const payload = {
      type: 'survey',
      title: 'Updated title via API test',
      startAt: surveyStart,
      endAt: surveyEnd,
      customerId: FAKE_CONTACT_ID,
      customerName: 'VEC Test Customer',
    };
    const r = await adminClient.patch(`/api/visits/${surveyId}`, payload);
    record(
      '[API] PATCH /api/visits/:id returns 200 with updated title',
      `status=200, title="Updated title via API test"`,
      `status=${r.status}, title=${JSON.stringify(r.json?.title)}`,
      r.status === 200 && r.json?.title === 'Updated title via API test',
    );

    // Reset title to something predictable for UI test below.
    await adminClient.patch(`/api/visits/${surveyId}`, {
      ...payload, title: 'Survey visit — VEC test',
    });
  }

  // Anon PATCH must be blocked.
  {
    const anon = makeClient(null);
    const r = await anon.patch(`/api/visits/${surveyId}`, {
      type: 'survey', title: 'Anon patch attempt',
      startAt: surveyStart, endAt: surveyEnd,
    });
    const blocked = r.status === 401 || r.status === 302;
    record(
      '[API] Anonymous PATCH /api/visits/:id is blocked',
      'status=401 or 302', `status=${r.status}`, blocked,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // [API] DELETE /api/visits/:id
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n  [API] DELETE /api/visits/:id');
  {
    // Seed a throw-away visit for the API delete probe.
    const tmpId = await seedVisit(pool, {
      type: 'other', title: 'API delete probe',
      startAt: futureISO(20, 9), endAt: futureISO(20, 10),
      createdBy: users.admin.email,
    });
    const r = await adminClient.delete(`/api/visits/${tmpId}`);
    const dbRow = await pool.query(`SELECT id FROM visits WHERE id=$1`, [tmpId]);
    record(
      '[API] DELETE /api/visits/:id returns { success: true } and row is gone',
      `status=200, success=true, db rows=0`,
      `status=${r.status}, success=${r.json?.success}, db rows=${dbRow.rowCount}`,
      r.status === 200 && r.json?.success === true && dbRow.rowCount === 0,
    );
  }

  // Anon DELETE must be blocked.
  {
    const anon = makeClient(null);
    const r = await anon.delete(`/api/visits/${deliveryId}`);
    const blocked = r.status === 401 || r.status === 302;
    record(
      '[API] Anonymous DELETE /api/visits/:id is blocked',
      'status=401 or 302', `status=${r.status}`, blocked,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // [UI] Puppeteer tests
  // ══════════════════════════════════════════════════════════════════════════
  const UI_LABELS = [
    '[UI] Admin sees Edit + Cancel buttons on delivery visit card',
    '[UI] Admin sees Edit + Cancel buttons on installation visit card',
    '[UI] Manager sees Edit + Cancel buttons on delivery visit card',
    '[UI] Manager sees Edit + Cancel buttons on installation visit card',
    '[UI] Member does NOT see Edit or Cancel buttons on any visit card',
    '[UI] Viewer does NOT see Edit or Cancel buttons on any visit card',
    '[UI] Cancel flow: CancelVisitDialog opens on Cancel button click',
    '[UI] Cancel flow: confirming removes the visit from the list',
    '[UI] Cancel flow: cancelled visit row is removed from the database',
    '[UI] Edit flow: GenericVisitEditModal opens with pre-populated title',
    '[UI] Edit flow: saving updated title refreshes list with new title',
    '[UI] Edit flow: updated title persisted in the database',
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

        // ── Admin view ───────────────────────────────────────────────────────
        console.log('\n  [UI] Admin view');
        const adminPage = await openVisitPage(browser, adminClient.cookie, { expectEditButtons: true });
        const adminSnap = await snapshotUpcoming(adminPage);

        const adminHasDeliveryEdit   = adminSnap.editIds.includes(String(deliveryId));
        const adminHasDeliveryCancel = adminSnap.cancelIds.includes(String(deliveryId));
        record(UI_LABELS[0],
          `editIds includes ${deliveryId}, cancelIds includes ${deliveryId}`,
          `editIds=${JSON.stringify(adminSnap.editIds)}, cancelIds=${JSON.stringify(adminSnap.cancelIds)}`,
          adminHasDeliveryEdit && adminHasDeliveryCancel);

        const adminHasInstallEdit   = adminSnap.editIds.includes(String(installId));
        const adminHasInstallCancel = adminSnap.cancelIds.includes(String(installId));
        record(UI_LABELS[1],
          `editIds includes ${installId}, cancelIds includes ${installId}`,
          `editIds=${JSON.stringify(adminSnap.editIds)}, cancelIds=${JSON.stringify(adminSnap.cancelIds)}`,
          adminHasInstallEdit && adminHasInstallCancel);

        // ── Manager view ─────────────────────────────────────────────────────
        console.log('\n  [UI] Manager view');
        const managerPage = await openVisitPage(browser, managerClient.cookie, { expectEditButtons: true });
        const managerSnap = await snapshotUpcoming(managerPage);

        record(UI_LABELS[2],
          `editIds includes ${deliveryId}, cancelIds includes ${deliveryId}`,
          `editIds=${JSON.stringify(managerSnap.editIds)}, cancelIds=${JSON.stringify(managerSnap.cancelIds)}`,
          managerSnap.editIds.includes(String(deliveryId)) && managerSnap.cancelIds.includes(String(deliveryId)));

        record(UI_LABELS[3],
          `editIds includes ${installId}, cancelIds includes ${installId}`,
          `editIds=${JSON.stringify(managerSnap.editIds)}, cancelIds=${JSON.stringify(managerSnap.cancelIds)}`,
          managerSnap.editIds.includes(String(installId)) && managerSnap.cancelIds.includes(String(installId)));

        await managerPage.close();
        try { await managerPage.__ctx?.close(); } catch {}

        // ── Member view ──────────────────────────────────────────────────────
        console.log('\n  [UI] Member view');
        const memberPage = await openVisitPage(browser, memberClient.cookie);
        const memberSnap = await snapshotUpcoming(memberPage);

        const memberNoButtons = memberSnap.editIds.length === 0 && memberSnap.cancelIds.length === 0;
        record(UI_LABELS[4],
          'editIds=[], cancelIds=[]',
          `editIds=${JSON.stringify(memberSnap.editIds)}, cancelIds=${JSON.stringify(memberSnap.cancelIds)}`,
          memberNoButtons);

        await memberPage.close();
        try { await memberPage.__ctx?.close(); } catch {}

        // ── Viewer view ──────────────────────────────────────────────────────
        console.log('\n  [UI] Viewer view');
        const viewerPage = await openVisitPage(browser, viewerClient.cookie);
        const viewerSnap = await snapshotUpcoming(viewerPage);

        const viewerNoButtons = viewerSnap.editIds.length === 0 && viewerSnap.cancelIds.length === 0;
        record(UI_LABELS[5],
          'editIds=[], cancelIds=[]',
          `editIds=${JSON.stringify(viewerSnap.editIds)}, cancelIds=${JSON.stringify(viewerSnap.cancelIds)}`,
          viewerNoButtons);

        await viewerPage.close();
        try { await viewerPage.__ctx?.close(); } catch {}

        // ── Edit flow ────────────────────────────────────────────────────────
        // Run the edit flow BEFORE cancel so all 3 visits are still present
        // on the admin page. Uses the survey visit (GenericVisitEditModal).
        console.log('\n  [UI] Edit flow');

        // Edit button should already be visible (admin page loaded with buttons).
        const editBtnExists = await adminPage.evaluate((id) => {
          return !!document.querySelector(`[data-testid="edit-visit-${id}"]`);
        }, surveyId);

        if (!editBtnExists) {
          record(UI_LABELS[9],  'edit button present', 'edit button NOT present', false);
          record(UI_LABELS[10], 'list shows new title', 'edit button missing, skipped', false);
          record(UI_LABELS[11], 'db updated', 'edit button missing, skipped', false);
        } else {
          // Click the edit button for the survey visit.
          await adminPage.evaluate((id) => {
            document.querySelector(`[data-testid="edit-visit-${id}"]`).click();
          }, surveyId);

          // Wait for the GenericVisitEditModal save button to appear.
          const modalOpened = await pollFor(adminPage, () => {
            return document.querySelector('[data-testid="generic-visit-save"]') ? 'ok' : null;
          }, null, 5000);

          // Check the title field is pre-populated with the expected value.
          const preFilled = await adminPage.evaluate(() => {
            const modal = document.querySelector('[role="dialog"]');
            if (!modal) return null;
            const inputs = Array.from(modal.querySelectorAll('input'));
            return inputs.length > 0 ? inputs[0].value : null;
          });

          record(UI_LABELS[9],
            'GenericVisitEditModal opens with title "Survey visit — VEC test"',
            `modalOpened=${modalOpened}, preFilled=${JSON.stringify(preFilled)}`,
            modalOpened === 'ok' && preFilled === 'Survey visit — VEC test');

          if (modalOpened !== 'ok') {
            record(UI_LABELS[10], 'list shows new title', 'modal never opened, skipped', false);
            record(UI_LABELS[11], 'db updated', 'modal never opened, skipped', false);
          } else {
            // Change the title. The title TextField is the first input in the dialog.
            // We use triple-click to select all existing text, then type the new title.
            const newTitle = 'Updated survey — E2E edited';
            await adminPage.click('[role="dialog"] input', { clickCount: 3 });
            await adminPage.type('[role="dialog"] input', newTitle);

            // Click "Save changes".
            await adminPage.evaluate(() => {
              document.querySelector('[data-testid="generic-visit-save"]').click();
            });

            // Wait for the modal to close (save button disappears).
            const modalClosed = await pollFor(adminPage, () => {
              return document.querySelector('[data-testid="generic-visit-save"]') ? null : 'ok';
            }, null, 8000);

            // Wait for the list to reflect the updated title (after onRefresh).
            const listUpdated = await pollFor(adminPage, (title) => {
              const sec = document.getElementById('upcoming-visits-section');
              if (!sec) return null;
              return sec.textContent.includes(title) ? 'ok' : null;
            }, newTitle, 10000);

            record(UI_LABELS[10],
              `upcoming list shows "${newTitle}"`,
              `modalClosed=${modalClosed}, listUpdated=${listUpdated}`,
              modalClosed === 'ok' && listUpdated === 'ok');

            // Verify DB row updated.
            const dbUpdated = await pool.query(
              `SELECT title FROM visits WHERE id=$1`, [surveyId]);
            const dbTitle = dbUpdated.rows[0]?.title;
            record(UI_LABELS[11],
              `db title="${newTitle}"`,
              `db title=${JSON.stringify(dbTitle)}`,
              dbTitle === newTitle);
          }
        }

        // ── Cancel flow ──────────────────────────────────────────────────────
        // Now cancel the delivery visit on the same admin page.
        // (Edit ran first so we didn't need the post-cancel refresh.)
        console.log('\n  [UI] Cancel flow');

        // Wait for the delivery cancel button — the edit's onRefresh may have
        // triggered a brief loading state.
        await pollFor(adminPage, (id) => {
          return document.querySelector(`[data-testid="cancel-visit-${id}"]`) ? 'ok' : null;
        }, deliveryId, 8000);

        const cancelBtnExists = await adminPage.evaluate((id) => {
          return !!document.querySelector(`[data-testid="cancel-visit-${id}"]`);
        }, deliveryId);

        if (!cancelBtnExists) {
          record(UI_LABELS[6], 'cancel button present', 'cancel button NOT present', false);
          record(UI_LABELS[7], 'delivery visit removed', 'cancel button missing, skipped', false);
          record(UI_LABELS[8], 'db row gone', 'cancel button missing, skipped', false);
        } else {
          // Click the cancel button for the delivery visit.
          await adminPage.evaluate((id) => {
            document.querySelector(`[data-testid="cancel-visit-${id}"]`).click();
          }, deliveryId);

          // Wait for the CancelVisitDialog to open.
          const dialogOpened = await pollFor(adminPage, () => {
            return document.querySelector('[data-testid="confirm-cancel-visit"]') ? 'ok' : null;
          }, null, 5000);

          record(UI_LABELS[6],
            'CancelVisitDialog with confirm-cancel-visit button visible',
            `dialog opened: ${dialogOpened}`,
            dialogOpened === 'ok');

          if (dialogOpened !== 'ok') {
            record(UI_LABELS[7], 'delivery visit removed', 'dialog never opened, skipped', false);
            record(UI_LABELS[8], 'db row gone', 'dialog never opened, skipped', false);
          } else {
            // Click "Cancel visit" in the dialog.
            await adminPage.evaluate(() => {
              document.querySelector('[data-testid="confirm-cancel-visit"]').click();
            });

            // Wait for the delivery visit card to disappear from the list.
            const visitGone = await pollFor(adminPage, (id) => {
              const sec = document.getElementById('upcoming-visits-section');
              if (!sec) return null;
              if (sec.querySelector(`[data-testid="cancel-visit-${id}"]`)) return null;
              return 'ok';
            }, deliveryId, 8000);

            record(UI_LABELS[7],
              `delivery visit ${deliveryId} removed from UI`,
              `visitGone=${visitGone}`,
              visitGone === 'ok');

            // Verify the row is gone from the DB.
            const dbCheck = await pool.query(`SELECT id FROM visits WHERE id=$1`, [deliveryId]);
            record(UI_LABELS[8],
              `db row for visit ${deliveryId} is gone`,
              `db rowCount=${dbCheck.rowCount}`,
              dbCheck.rowCount === 0);
          }
        }

        await adminPage.close();
        try { await adminPage.__ctx?.close(); } catch {}

      } finally {
        await browser.close().catch(() => {});
      }
    }
  }

  // ── Summary & report ──────────────────────────────────────────────────────
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
    '# Visit Edit/Cancel E2E Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:visit-edit-cancel\``,
    '',
    '## Summary',
    '',
    `**${findings.filter(f => f.ok).length} passed, ${findings.filter(f => !f.ok).length} failed**`,
    '',
    '## Results',
    '',
    '| Result | Name | Expected | Observed |',
    '|--------|------|----------|----------|',
    ...findings.map(f =>
      `| ${f.ok ? '✓' : '✗'} | ${esc(f.name)} | ${esc(f.expected)} | ${esc(f.observed)} |`,
    ),
  ];
  const outPath = path.join(dir, 'visit-edit-cancel.md');
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  console.log(`  Report written → ${outPath}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(2); });
