'use strict';
const { makeSkip } = require('../helpers/report');
// test/design-visit-list/run.js
//
// End-to-end live test for the per-contact "Design visits" section on the
// customer-detail page (task #683). Mirrors the pattern used by
// test/design-visit/run.js and test/lead-status-sync/customer-detail.js:
// boot a disposable server with the privileges harness, drive the UI with
// Puppeteer, write a markdown report to test-results/design-visit-list.md,
// and exit non-zero on failure.
//
// Covers:
//   (API) GET /api/design-visits?contactId=... returns only that contact's
//         rows (filter is honoured); rows include estimate_total_pence.
//   (UI)  Navigating to /customers/:id as admin renders the
//         #design-visits-section with one .comment-item per seeded visit,
//         each showing the correct status pill label, "Estimate: £N.NN"
//         total, and visit_date formatted as e.g. "24 May 2024".
//   (ADM) The Request-revision button is shown for admin on visits with
//         status submitted/signed_off; the Delete button is shown for admin
//         on every visit; both buttons are hidden for non-admin (member);
//         Delete invokes DELETE /api/design-visits/:id and the row goes
//         away; Request-revision invokes POST /api/design-visits/:id/revision
//         and flips status to revision_requested.
//
// Note on HUBSPOT_TOKEN: the privileges harness strips HUBSPOT_TOKEN, so
// GET /api/contacts/:id 503s and the customer-detail bootstrap replaces
// #workflow-view with an error. The Design-visits section is rendered from
// a separate code path (renderDesignVisits) keyed off state.selectedContactId
// and not bound to #workflow-view, so we compensate the same way the
// lead-status-sync-customer-detail test does — seed state.selectedContactId,
// re-inject the section mount, and call renderDesignVisits() directly. The
// renderer paths under test are exercised faithfully against the live API.
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:design-visit-list
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:design-visit-list

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

const { pollUntil, pollFn } = require('../helpers/poll');

// ── fixtures ──────────────────────────────────────────────────────────────────
// Must be all-digits — customer-detail.html bootstrap refuses non-numeric
// contact ids with "Invalid customer ID.".
const FAKE_CONTACT_ID       = '989800000683';
const OTHER_FAKE_CONTACT_ID = '989800000684';

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

async function pollPage(page, fn, arg, timeoutMs = 6000, intervalMs = 150) {
  return pollUntil(page, fn, timeoutMs, intervalMs, arg !== undefined && arg !== null ? [arg] : []);
}

function fmtGbpDate(iso) {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

async function purgeFixtures(pool) {
  // Rooms cascade via FK on design_visit_id.
  // Scope to created_by LIKE 'privtest-%' so that a broad DELETE on a shared
  // DB never removes rows seeded by a concurrently-running suite or real data
  // that happens to share the same contact_id.
  try {
    await pool.query(
      `DELETE FROM design_visits
        WHERE contact_id IN ($1, $2)
          AND created_by LIKE 'privtest-%'`,
      [FAKE_CONTACT_ID, OTHER_FAKE_CONTACT_ID],
    );
  } catch {}
}

// Seed a design_visit row + a single room. Returns { id, visitDateIso }.
async function seedVisit(pool, { contactId, status, createdBy, visitDateIso,
  roomName, unitCount, unitPricePence }) {
  const r = await pool.query(
    `INSERT INTO design_visits
       (contact_id, contact_name, contact_email, created_by, visit_date,
        duration_min, location, notes, terms_accepted, status)
     VALUES ($1, $2, $3, $4, $5, 90, '1 Test Lane', 'seeded by test', TRUE, $6)
     RETURNING id`,
    [contactId, 'DV List Test', 'dv-list@privtest.local', createdBy,
     visitDateIso, status],
  );
  const id = r.rows[0].id;
  await pool.query(
    `INSERT INTO design_visit_rooms
       (design_visit_id, room_name, unit_count, unit_price_pence, sort_order)
     VALUES ($1, $2, $3, $4, 0)`,
    [id, roomName, unitCount, unitPricePence],
  );
  return { id, visitDateIso };
}

// Open the customer-detail page as the given user, seed state.selectedContactId
// directly (HUBSPOT_TOKEN is stripped so GET /api/contacts/:id 503s), then
// re-render the design-visits section against the live API.
async function openCustomerDetail(browser, jar, contactId) {
  // Each user gets its own incognito context so injected `connect.sid`
  // cookies for one user don't clobber another's in the shared default jar.
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
  await injectSession(page, jar);
  await page.goto(`${BASE}/customers/${contactId}`, {
    waitUntil: 'domcontentloaded', timeout: 25000,
  });
  // Wait for state.user to be populated (bootstrap calls /api/auth/user).
  await pollPage(page,
    () => typeof state !== 'undefined' && state && state.user ? 'ok' : null,
    null, 10000);
  // Wait for the DOMContentLoaded handler in customer-detail.html to settle.
  // HUBSPOT_TOKEN is stripped, so GET /api/contacts/:id 503s and the handler
  // replaces #workflow-view innerHTML with "Failed to load customer:" — which
  // would wipe any #design-visits-section we inject. Poll for that error so
  // we know the handler is done mutating #workflow-view before we mount.
  await pollPage(page, () => {
    const wv = document.getElementById('workflow-view');
    if (!wv) return null;
    const t = wv.textContent || '';
    return /Failed to load customer/.test(t) ? 'ok' : null;
  }, null, 10000);
  // Seed selection + ensure the section mount exists, then render.
  await page.evaluate((cid) => {
    state.selectedContactId = cid;
    state.selectedContact = state.selectedContact || {
      id: cid,
      properties: { firstname: 'DV', lastname: 'List', email: 'dv@privtest.local' },
    };
    if (!document.getElementById('design-visits-section')) {
      const wv = document.getElementById('workflow-view') || document.body;
      const div = document.createElement('div');
      div.id = 'design-visits-section';
      wv.appendChild(div);
    }
  }, contactId);
  await page.evaluate(() => renderDesignVisits());
  // Wait for actual .comment-item rows (not just non-loading) so we don't
  // return early on the initial "No design visits yet." empty-state that the
  // React component shows before the fetch completes.
  await pollPage(page, () => {
    const list = document.getElementById('design-visits-list');
    if (!list) return null;
    if (/Loading…/.test(list.textContent)) return null;
    if (list.querySelectorAll('[data-dv-id]').length === 0) return null;
    return 'ok';
  }, null, 8000);
  page.__logs = pageLogs;
  return page;
}

// Read what the design-visits-list rendered, in a stable shape.
async function snapshotList(page) {
  return page.evaluate(() => {
    const list = document.getElementById('design-visits-list');
    if (!list) return { present: false };
    const empty = /No design visits yet/.test(list.textContent);
    const error = /Could not load design visits/.test(list.textContent);
    const items = Array.from(list.querySelectorAll('[data-dv-id]')).map(el => {
      const buttons = Array.from(el.querySelectorAll('button')).map(b => ({
        text:    (b.textContent || '').trim(),
        onclick: b.getAttribute('onclick') || '',
      }));
      return {
        when:    (el.querySelector('[data-testid="dv-when"]')?.textContent || '').trim(),
        // Status pill carries data-testid="dv-status-pill".
        pill:    (el.querySelector('[data-testid="dv-status-pill"]')?.textContent || '').trim(),
        // Every element with data-testid="dv-date" — we want the "Estimate: £..." one.
        meta:    Array.from(el.querySelectorAll('[data-testid="dv-date"]'))
                   .map(s => (s.textContent || '').trim()),
        buttons,
      };
    });
    return { present: true, empty, error, items };
  });
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
  console.log(`\n  design-visit-list E2E  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);
  await purgeFixtures(pool);

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
  const skip = makeSkip(findings);

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

  // Wait for design-visit tables (created async on boot).
  const waitForTable = async (name) => {
    const found = await pollFn(async () => {
      const r = await pool.query(`SELECT to_regclass($1) AS t`, [name]);
      return r.rows[0].t || null;
    }, 15000, 200);
    if (!found) throw new Error(`Timed out waiting for table ${name}`);
  };
  await Promise.all([
    waitForTable('design_visits'),
    waitForTable('design_visit_rooms'),
  ]);
  console.log('  design_visits + design_visit_rooms ready');

  await purgeFixtures(pool);

  // ── Seed: two visits for FAKE_CONTACT_ID, one decoy for OTHER ──────────────
  const visitDateA = new Date('2024-05-24T10:00:00Z').toISOString();
  const visitDateB = new Date('2024-08-12T14:30:00Z').toISOString();
  const visitDateOther = new Date('2024-07-01T09:00:00Z').toISOString();

  // Visit A: submitted, 8 × £150.00 = £1200.00
  const visitA = await seedVisit(pool, {
    contactId: FAKE_CONTACT_ID, status: 'submitted', createdBy: users.admin.email,
    visitDateIso: visitDateA, roomName: 'Kitchen',
    unitCount: 8, unitPricePence: 15000,
  });
  // Visit B: signed_off, 2 × £75.50 = £151.00
  const visitB = await seedVisit(pool, {
    contactId: FAKE_CONTACT_ID, status: 'signed_off', createdBy: users.admin.email,
    visitDateIso: visitDateB, roomName: 'Bathroom',
    unitCount: 2, unitPricePence: 7550,
  });
  // Decoy on a different contact — must NOT appear in our list.
  const visitOther = await seedVisit(pool, {
    contactId: OTHER_FAKE_CONTACT_ID, status: 'submitted', createdBy: users.admin.email,
    visitDateIso: visitDateOther, roomName: 'Hallway',
    unitCount: 1, unitPricePence: 99900,
  });
  console.log(`  Seeded visits: A=${visitA.id} (submitted, £1200.00),`
            + ` B=${visitB.id} (signed_off, £151.00),`
            + ` decoy=${visitOther.id} on contact ${OTHER_FAKE_CONTACT_ID}`);

  // ── Login clients ──────────────────────────────────────────────────────────
  const adminClient  = await login(users.admin.email,  users.admin.password);
  const memberClient = await login(users.member.email, users.member.password);

  // ════════════════════════════════════════════════════════════════════════════
  // [API] GET /api/design-visits?contactId=... filter + estimate totals
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n  [API] GET /api/design-visits?contactId=…');
  {
    const r = await adminClient.get(
      `/api/design-visits?contactId=${encodeURIComponent(FAKE_CONTACT_ID)}`,
    );
    const rows = Array.isArray(r.json) ? r.json : [];
    const ids  = rows.map(v => v.id).sort((a, b) => a - b);
    const wantIds = [visitA.id, visitB.id].sort((a, b) => a - b);
    record(
      '[API] contactId filter returns only that contact\'s visits',
      `status=200, ids=[${wantIds.join(',')}], no decoy`,
      `status=${r.status}, ids=[${ids.join(',')}]`,
      r.status === 200
        && ids.length === 2
        && ids[0] === wantIds[0] && ids[1] === wantIds[1]
        && !ids.includes(visitOther.id),
    );

    const rowA = rows.find(v => v.id === visitA.id);
    record(
      '[API] estimate_total_pence summed from rooms (visit A = 120000)',
      'estimate_total_pence=120000 (8 × 15000)',
      `estimate_total_pence=${rowA?.estimate_total_pence}`,
      String(rowA?.estimate_total_pence) === '120000',
    );
    const rowB = rows.find(v => v.id === visitB.id);
    record(
      '[API] estimate_total_pence summed from rooms (visit B = 15100)',
      'estimate_total_pence=15100 (2 × 7550)',
      `estimate_total_pence=${rowB?.estimate_total_pence}`,
      String(rowB?.estimate_total_pence) === '15100',
    );
  }

  // Anonymous filter probe — must be gated by isAuthenticated.
  {
    const { makeClient } = require('../privileges/harness');
    const anon = makeClient(null);
    const r = await anon.get(
      `/api/design-visits?contactId=${encodeURIComponent(FAKE_CONTACT_ID)}`,
    );
    const blocked = r.status === 401 || r.status === 302;
    record(
      '[API] anonymous GET /api/design-visits is blocked',
      'status=401 (or 302)', `status=${r.status}`, blocked,
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // [UI] / [ADM] Puppeteer probes
  // ════════════════════════════════════════════════════════════════════════════
  const UI_LABELS = [
    '[UI] Admin /customers/:id renders #design-visits-section with 2 .comment-item',
    '[UI] Each item shows the expected status pill label',
    '[UI] Each item shows the expected "Estimate: £N.NN" total',
    '[UI] Each item shows the expected visit_date (en-GB d MMM yyyy)',
    '[ADM] Admin sees both Request-revision and Delete buttons per visit',
    '[ADM] Non-admin (member) sees neither Request-revision nor Delete',
    '[ADM] Admin DELETE /api/design-visits/:id removes the visit from the list',
    '[ADM] Admin Request-revision flips status to revision_requested',
    '[ADM] Admin Request-revision persists the typed note to revision_note',
  ];

  if (!puppeteer) {
    for (const l of UI_LABELS) skip(l, 'puppeteer installed', 'puppeteer not installed');
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
      for (const l of UI_LABELS) skip(l, 'browser launched', `browser launch failed: ${msg}`);
    } else {
      try {
        // ── Admin view ──────────────────────────────────────────────────────
        const adminPage = await openCustomerDetail(browser, adminClient.cookie, FAKE_CONTACT_ID);
        const adminSnap = await snapshotList(adminPage);

        // Items are ordered by created_at DESC; visitB was inserted second
        // so it appears first.
        const wantOrder = [
          { id: visitB.id, when: fmtGbpDate(visitDateB), pill: 'Signed off',
            estimate: 'Estimate: £151.00', canRevise: true },
          { id: visitA.id, when: fmtGbpDate(visitDateA), pill: 'Submitted',
            estimate: 'Estimate: £1200.00', canRevise: true },
        ];

        record(UI_LABELS[0],
          'present=true, error=false, items.length=2',
          `present=${adminSnap.present}, error=${adminSnap.error}, items.length=${adminSnap.items?.length}`,
          adminSnap.present && !adminSnap.error && adminSnap.items?.length === 2);

        const pillsOk = adminSnap.items?.length === 2
          && adminSnap.items[0].pill === wantOrder[0].pill
          && adminSnap.items[1].pill === wantOrder[1].pill;
        record(UI_LABELS[1],
          `pills=["${wantOrder[0].pill}","${wantOrder[1].pill}"]`,
          `pills=${JSON.stringify(adminSnap.items?.map(i => i.pill))}`,
          pillsOk);

        const totalsOk = adminSnap.items?.length === 2
          && adminSnap.items[0].meta?.includes(wantOrder[0].estimate)
          && adminSnap.items[1].meta?.includes(wantOrder[1].estimate);
        record(UI_LABELS[2],
          `meta includes ["${wantOrder[0].estimate}","${wantOrder[1].estimate}"]`,
          `meta=${JSON.stringify(adminSnap.items?.map(i => i.meta))}`,
          totalsOk);

        const datesOk = adminSnap.items?.length === 2
          && adminSnap.items[0].when === wantOrder[0].when
          && adminSnap.items[1].when === wantOrder[1].when;
        record(UI_LABELS[3],
          `when=["${wantOrder[0].when}","${wantOrder[1].when}"]`,
          `when=${JSON.stringify(adminSnap.items?.map(i => i.when))}`,
          datesOk);

        // Admin buttons: every visit in submitted/signed_off must show
        // Request-revision + Delete. React attaches handlers via addEventListener
        // (not the onclick attribute), so we match by button text only.
        const adminButtonsOk = adminSnap.items?.length === 2
          && wantOrder.every((w, ix) => {
            const btns = adminSnap.items[ix].buttons || [];
            const rev = btns.find(b => b.text === 'Request revision');
            const del = btns.find(b => b.text === 'Delete');
            return !!rev && !!del;
          });
        record(UI_LABELS[4],
          'each item has Request-revision + Delete buttons',
          `buttons=${JSON.stringify(adminSnap.items?.map(i => i.buttons))}`,
          adminButtonsOk);

        // ── Member view ─────────────────────────────────────────────────────
        const memberPage = await openCustomerDetail(browser, memberClient.cookie, FAKE_CONTACT_ID);
        const memberSnap = await snapshotList(memberPage);
        const memberButtonsHidden = memberSnap.items?.length === 2
          && memberSnap.items.every(i => {
            const texts = (i.buttons || []).map(b => b.text);
            return !texts.includes('Request revision')
                && !texts.includes('Delete');
          });
        record(UI_LABELS[5],
          'no Request-revision or Delete button on any item',
          `buttons=${JSON.stringify(memberSnap.items?.map(i => i.buttons.map(b => b.text)))}`,
          memberButtonsHidden);
        await memberPage.close();
        try { await memberPage.__ctx?.close(); } catch {}

        // ── Admin DELETE round-trip ─────────────────────────────────────────
        // Click the actual Delete button; the confirm() prompt is accepted by
        // the dialog handler below. React buttons don't have onclick attrs so
        // we locate each button via its closest [data-dv-id] ancestor.
        adminPage.on('dialog', d => {
          if (d.type() === 'prompt') d.accept('e2e revision note').catch(() => {});
          else d.accept().catch(() => {});
        });
        await adminPage.evaluate((id) => {
          const item = document.querySelector(`[data-dv-id="${id}"]`);
          const btn = item
            ? Array.from(item.querySelectorAll('button')).find(b => b.textContent.trim() === 'Delete')
            : null;
          if (btn) btn.click();
        }, visitB.id);
        const deletedOk = await pollPage(adminPage, (id) => {
          const list = document.getElementById('design-visits-list');
          if (!list) return null;
          const items = list.querySelectorAll('[data-dv-id]');
          if (items.length !== 1) return null;
          // Confirm the deleted item's [data-dv-id] row is gone.
          if (list.querySelector(`[data-dv-id="${id}"]`)) return null;
          return 'ok';
        }, visitB.id, 6000);
        const dbAfterDelete = await pool.query(
          `SELECT id FROM design_visits WHERE id = $1`, [visitB.id]);
        const deletePassed = deletedOk === 'ok' && dbAfterDelete.rowCount === 0;
        record(UI_LABELS[6],
          'visitB removed from UI and from DB',
          `uiOk=${deletedOk === 'ok'}, dbRows=${dbAfterDelete.rowCount}`,
          deletePassed);

        // ── Admin Request-revision round-trip ───────────────────────────────
        // Click the actual Request-revision button. React buttons use
        // addEventListener (not onclick attrs), so locate via [data-dv-id].
        // The prompt() dialog handler above already accepts it.
        await adminPage.evaluate((id) => {
          const item = document.querySelector(`[data-dv-id="${id}"]`);
          const btn = item
            ? Array.from(item.querySelectorAll('button')).find(b => b.textContent.trim() === 'Request revision')
            : null;
          if (btn) btn.click();
        }, visitA.id);
        const revisionOk = await pollPage(adminPage, (id) => {
          const list = document.getElementById('design-visits-list');
          if (!list) return null;
          const items = Array.from(list.querySelectorAll('[data-dv-id]'));
          if (items.length !== 1) return null;
          // After revision_requested, canRevise becomes false → no
          // Request-revision button, but Delete remains.
          const btnTexts = Array.from(items[0].querySelectorAll('button'))
            .map(b => (b.textContent || '').trim());
          const pill = (items[0].querySelector('[data-testid="dv-status-pill"]')?.textContent || '').trim();
          if (pill !== 'Revision requested') return null;
          if (btnTexts.includes('Request revision')) return null;
          return 'ok';
        }, visitA.id, 6000);
        const dbAfterRevision = await pool.query(
          `SELECT status, revision_note FROM design_visits WHERE id = $1`, [visitA.id]);
        const dbRow = dbAfterRevision.rows[0];
        record(UI_LABELS[7],
          'visitA status=revision_requested in DB + pill flips in UI',
          `uiOk=${revisionOk === 'ok'}, dbStatus=${dbRow?.status}`,
          revisionOk === 'ok' && dbRow?.status === 'revision_requested');
        record(UI_LABELS[8],
          'visitA revision_note = "e2e revision note"',
          `dbNote=${JSON.stringify(dbRow?.revision_note)}`,
          dbRow?.revision_note === 'e2e revision note');

        await adminPage.close();
        try { await adminPage.__ctx?.close(); } catch {}
      } finally {
        await browser.close().catch(() => {});
      }
    }
  }

  // ── summary & report ──────────────────────────────────────────────────────
  const pass = findings.filter(f => f.ok).length;
  const fail = findings.filter(f => !f.ok && !f.skipped).length;
  const skipped = findings.filter(f => f.skipped).length;
  console.log(`\n  Results: ${pass} passed, ${fail} failed`);

  await writeReport(runId, findings);
  await cleanupAndExit(fail > 0 ? 1 : 0);
}

async function writeReport(runId, findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Design Visit List (customer-detail) — E2E Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:design-visit-list\``,
    '',
    '## Summary',
    '',
    `- Passed: ${findings.filter(f => f.ok).length} / ${findings.length}`,
    `- Skipped: ${findings.filter(f => f.skipped).length} / ${findings.length}`,
    `- Failed: ${findings.filter(f => !f.ok && !f.skipped).length} / ${findings.length}`,
    '',
    '## Results',
    '',
    '| Result | Probe | Expected | Observed |',
    '|---|---|---|---|',
    ...findings.map(f =>
      `| ${f.ok ? 'PASS' : f.skipped ? 'SKIP' : 'FAIL'} | ${esc(f.name)} | ${esc(f.expected)} | ${esc(f.observed)} |`,
    ),
    '',
    '## Coverage',
    '',
    '- **[API] `GET /api/design-visits?contactId=…`** — seeds two visits for one',
    '  contact and a decoy visit for a different contact, then asserts the',
    '  filter returns only the target contact\'s rows (no decoy) and that',
    '  `estimate_total_pence` is computed from the seeded rooms.',
    '- **[API] anonymous gate** — unauthenticated `GET /api/design-visits`',
    '  is rejected (401/302) by `isAuthenticated`.',
    '- **[UI] customer-detail renders the section** — navigates to',
    '  `/customers/:id` as admin, seeds `state.selectedContactId`, calls',
    '  `renderDesignVisits()`, and asserts the rendered `#design-visits-list`',
    '  contains one `.comment-item` per visit with the correct status-pill',
    '  label (`Signed off` / `Submitted`), `Estimate: £N.NN` total, and the',
    '  visit date formatted as en-GB `d MMM yyyy`.',
    '- **[ADM] admin-only action buttons** — asserts each item shows',
    '  `Request revision` and `Delete` buttons (matched by text; React attaches',
    '  handlers via `addEventListener`, not the `onclick` attribute) when viewed',
    '  as admin, and that **neither** button appears when viewed as a member.',
    '- **[ADM] Delete round-trip** — invokes `deleteDesignVisit(id)` (accepts',
    '  the `confirm()` dialog), then asserts the row disappears from the UI',
    '  *and* from the `design_visits` table.',
    '- **[ADM] Request-revision round-trip** — invokes',
    '  `markDesignVisitRevision(id)` (accepts the `prompt()` dialog with a',
    '  test note), then asserts the pill flips to `Revision requested` in the',
    '  UI, the `Request revision` button is no longer shown for that row, and',
    '  the database row has `status=revision_requested` with the persisted',
    '  note.',
    '',
    '## Notes',
    '',
    '- The privileges harness strips `HUBSPOT_TOKEN`, so',
    '  `GET /api/contacts/:id` 503s and the customer-detail bootstrap replaces',
    '  `#workflow-view` with an error message. The Design-visits section is',
    '  rendered from a separate code path (`renderDesignVisits` in',
    '  `src/react/pages/CustomerDetailPage.tsx`) keyed off `state.selectedContactId`, so',
    '  the test seeds `state.selectedContactId`, re-injects the section mount',
    '  if needed, and calls `renderDesignVisits()` directly. The renderer',
    '  paths under test run against the live `/api/design-visits` endpoint.',
    '- Fixtures seeded with the synthetic contact ids',
    '  (`989800000683`, `989800000684`) are purged on exit alongside the',
    '  standard `privtest-` user fixtures.',
  ];
  const outPath = path.join(dir, 'design-visit-list.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Report: test-results/design-visit-list.md`);
}

main();
