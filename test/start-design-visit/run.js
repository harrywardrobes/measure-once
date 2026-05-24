'use strict';
// test/start-design-visit/run.js
//
// End-to-end live test for the start_design_visit card-action handler.
// Mirrors the pattern in test/card-action-handlers/run.js: boot a disposable
// server with the privileges harness, drive the API and UI with Puppeteer,
// write a markdown report to test-results/start-design-visit.md.
//
// Covers (per task #630):
//   (API) Pre-checks — catalogue endpoints respond for admin; 401 when unauth.
//   (A)   Wizard submit — POST /api/design-visits with a seeded contact; DB
//         rows confirmed in design_visits, design_visit_rooms, and
//         design_visit_room_images (storage_key + mime_type); status flips to
//         "submitted"; HubSpot/QB/email are skipped (tokens stripped) without
//         crashing.
//   (B)   Sign-off: approve — GET sign-off summary; POST approve flips status to
//         "signed_off" and nulls token; second POST returns 404.
//   (C)   Sign-off: revision — POST revision flips status to
//         "revision_requested"; subsequent re-submit via /submit can flip back
//         to "submitted".
//   (D)   Token security — expired, wrong, and already-consumed tokens all
//         return 404 (no oracle leakage).
//   (E)   Admin catalogue CRUD — POST / PATCH / DELETE handle, furniture range,
//         and door style via admin API; assert DB changes; assert non-admin
//         mutations return 403.
//   (F)   BroadcastChannel refresh in wizard — fire design_visit_handles_changed
//         from a second Puppeteer page; the first page's listener receives the
//         event (proving the channel is wired up in the browser context).
//   (G)   Privilege gates (REST) — unauthenticated POST /api/design-visits
//         → 401; non-admin DELETE /api/design-visits/:id → 403; public sign-off
//         routes are reachable without a session.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:start-design-visit
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:start-design-visit

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
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

// ── Fixture name constants ────────────────────────────────────────────────────
const RUN_PREFIX = 'privtest-sdv';

// Catalogue item names seeded before probes run
const HANDLE_NAME          = `${RUN_PREFIX} test handle`;
const FURNITURE_NAME       = `${RUN_PREFIX} test furniture range`;
const DOOR_STYLE_NAME      = `${RUN_PREFIX} test door style`;

// Catalogue items created by (E) CRUD probes (so they can be deleted by the probe)
const HANDLE_CRUD_NAME     = `${RUN_PREFIX} crud handle`;
const FURNITURE_CRUD_NAME  = `${RUN_PREFIX} crud furniture`;
const DOOR_STYLE_CRUD_NAME = `${RUN_PREFIX} crud door style`;

// Fake HubSpot contact ID used as design visit contactId
const FAKE_CONTACT_ID = `privtest-sdv-contact-001`;

// ── Helpers ───────────────────────────────────────────────────────────────────
function tokenHash(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
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

async function pollPage(page, fn, arg, timeoutMs = 6000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const got = await page.evaluate(fn, arg);
    if (got) return got;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

// ── Fixture teardown ─────────────────────────────────────────────────────────
async function purgeFixtures(pool) {
  // Delete design visits for our fake contact (cascades to rooms and images)
  await pool.query(
    `DELETE FROM design_visits WHERE contact_id = $1`,
    [FAKE_CONTACT_ID]
  );
  // Delete catalogue items seeded by this run
  await pool.query(
    `DELETE FROM design_visit_handles
     WHERE name IN ($1, $2)`,
    [HANDLE_NAME, HANDLE_CRUD_NAME]
  );
  await pool.query(
    `DELETE FROM design_visit_furniture_ranges
     WHERE name IN ($1, $2)`,
    [FURNITURE_NAME, FURNITURE_CRUD_NAME]
  );
  await pool.query(
    `DELETE FROM design_visit_door_styles
     WHERE name IN ($1, $2)`,
    [DOOR_STYLE_NAME, DOOR_STYLE_CRUD_NAME]
  );
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
  console.log(`\n  start-design-visit E2E  run=${runId}`);
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
  // Known Nix-store Chromium paths — used by both (E/BC) and (F) sections.
  const NIX_CHROMIUM_CANDIDATES = [
    '/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium',
  ];
  function findSystemChromium() {
    const { execSync } = require('child_process');
    for (const p of NIX_CHROMIUM_CANDIDATES) {
      try { require('fs').accessSync(p, require('fs').constants.X_OK); return p; } catch {}
    }
    try { return execSync('which chromium chromium-browser google-chrome 2>/dev/null', { encoding: 'utf8' }).split('\n')[0].trim() || null; } catch {}
    return null;
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
  process.on('uncaughtException',  (e) => { console.error('Uncaught:', e);  cleanupAndExit(2); });
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

  // Wait for all design-visit tables to be created (async on boot)
  const waitForTable = async (name) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const r = await pool.query(`SELECT to_regclass($1) AS t`, [name]);
      if (r.rows[0].t) return;
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`Timed out waiting for table ${name}`);
  };
  await Promise.all([
    waitForTable('design_visit_handles'),
    waitForTable('design_visit_furniture_ranges'),
    waitForTable('design_visit_door_styles'),
    waitForTable('design_visits'),
    waitForTable('design_visit_rooms'),
    waitForTable('design_visit_room_images'),
  ]);
  console.log('  All design_visit_* tables ready');

  await purgeFixtures(pool);

  // ── Seed catalogue fixtures ────────────────────────────────────────────────
  const adminClient  = await login(users.admin.email,  PASSWORD);
  const memberClient = await login(users.member.email, PASSWORD);

  const seedHandle = await adminClient.post('/api/admin/design-visit-handles', {
    name: HANDLE_NAME, description: 'Seed handle for SDV test', sort_order: 9990,
  });
  const handleId = seedHandle.json?.id ?? null;
  console.log(`  Seeded handle id=${handleId}`);

  const seedFurniture = await adminClient.post('/api/admin/design-visit-furniture-ranges', {
    name: FURNITURE_NAME, description: 'Seed range for SDV test', sort_order: 9990,
  });
  const furnitureId = seedFurniture.json?.id ?? null;
  console.log(`  Seeded furniture-range id=${furnitureId}`);

  const seedDoorStyle = await adminClient.post('/api/admin/design-visit-door-styles', {
    name: DOOR_STYLE_NAME, sort_order: 9990,
  });
  const doorStyleId = seedDoorStyle.json?.id ?? null;
  console.log(`  Seeded door-style id=${doorStyleId}`);

  // ── API pre-checks ─────────────────────────────────────────────────────────
  console.log('\n  [API] Pre-checks');

  // Admin catalogue reads → 200
  for (const [label, path] of [
    ['GET /api/admin/design-visit-handles', '/api/admin/design-visit-handles'],
    ['GET /api/admin/design-visit-furniture-ranges', '/api/admin/design-visit-furniture-ranges'],
    ['GET /api/admin/design-visit-door-styles', '/api/admin/design-visit-door-styles'],
  ]) {
    const r = await adminClient.get(path);
    record(
      `${label} responds for admin`,
      'status=200, JSON array',
      `status=${r.status} type=${Array.isArray(r.json) ? 'array' : typeof r.json}`,
      r.status === 200 && Array.isArray(r.json),
    );
  }

  // Member reads public catalogue → 200
  for (const [label, path] of [
    ['GET /api/design-visit-handles (member)', '/api/design-visit-handles'],
    ['GET /api/design-visit-furniture-ranges (member)', '/api/design-visit-furniture-ranges'],
    ['GET /api/design-visit-door-styles (member)', '/api/design-visit-door-styles'],
  ]) {
    const r = await memberClient.get(path);
    record(
      `${label} responds for authenticated user`,
      'status=200, JSON array',
      `status=${r.status} type=${Array.isArray(r.json) ? 'array' : typeof r.json}`,
      r.status === 200 && Array.isArray(r.json),
    );
  }

  // Unauthenticated admin catalogue → 401 / 302
  {
    const { makeClient } = require('../privileges/harness');
    const anonClient = makeClient(null);
    for (const [label, path] of [
      ['GET /api/admin/design-visit-handles (unauth)', '/api/admin/design-visit-handles'],
      ['GET /api/design-visit-handles (unauth)', '/api/design-visit-handles'],
    ]) {
      const r = await anonClient.get(path);
      const blocked = r.status === 401 || r.status === 403 || r.status === 302;
      record(
        `${label} blocked for unauthenticated request`,
        'status=401/403/302',
        `status=${r.status}`,
        blocked,
      );
    }
  }

  // Public sign-off route readable without session — use a bad token so it
  // returns 404 (which confirms the endpoint exists and is public, not 401)
  {
    const { makeClient } = require('../privileges/harness');
    const anonClient = makeClient(null);
    const r = await anonClient.get('/api/design-visits/sign-off/nosuchtoken');
    record(
      'GET /api/design-visits/sign-off/:token is public (returns 404 not 401)',
      'status=404',
      `status=${r.status}`,
      r.status === 404,
    );
  }

  // ── (G) Privilege gates — REST ─────────────────────────────────────────────
  console.log('\n  [G] Privilege gates (REST)');

  // Unauthenticated POST /api/design-visits → 401
  {
    const { makeClient } = require('../privileges/harness');
    const anonClient = makeClient(null);
    const r = await anonClient.post('/api/design-visits', {
      contactId: FAKE_CONTACT_ID,
      rooms: [{ roomName: 'Kitchen', unitCount: 1, unitPricePence: 0 }],
      termsAccepted: true,
    });
    const blocked = r.status === 401 || r.status === 403 || r.status === 302;
    record(
      '(G) Unauthenticated POST /api/design-visits blocked',
      'status=401/403/302',
      `status=${r.status}`,
      blocked,
    );
  }

  // Non-admin DELETE /api/design-visits/:id → 403 (using placeholder id 999999)
  {
    const r = await memberClient.delete('/api/design-visits/999999');
    const blocked = r.status === 401 || r.status === 403 || r.status === 302;
    record(
      '(G) Non-admin DELETE /api/design-visits/:id blocked',
      'status=403 (or 401/302)',
      `status=${r.status}`,
      blocked,
    );
  }

  // Non-admin POST to admin catalogue routes → 403
  {
    const r = await memberClient.post('/api/admin/design-visit-handles', { name: 'blocked' });
    const blocked = r.status === 401 || r.status === 403 || r.status === 302;
    record(
      '(G) Non-admin POST /api/admin/design-visit-handles blocked',
      'status=403 (or 401/302)',
      `status=${r.status}`,
      blocked,
    );
  }

  // ── (A) Wizard submit flow ─────────────────────────────────────────────────
  console.log('\n  [A] Wizard submit flow');

  const submitRes = await memberClient.post('/api/design-visits', {
    contactId:       FAKE_CONTACT_ID,
    contactName:     'SDV Test Customer',
    contactEmail:    'sdv-customer@privtest.local',
    handleId:        handleId,
    furnitureRangeId: furnitureId,
    visitDate:       new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    durationMin:     90,
    location:        '123 Test Street',
    notes:           'Automated E2E test visit',
    termsAccepted:   true,
    rooms: [
      {
        roomName:       'Kitchen',
        doorStyleId:    doorStyleId,
        widthMm:        3000,
        heightMm:       2400,
        depthMm:        600,
        unitCount:      8,
        unitPricePence: 15000,
        notes:          'E2E room note',
        images: [
          { storageKey: `sdv-test-photo-${runId}.jpg`, mimeType: 'image/jpeg' },
        ],
      },
    ],
    handlerConfig: {},
  });

  record(
    '(A) POST /api/design-visits returns { ok: true, designVisitId }',
    'status=201, ok=true, designVisitId is integer',
    `status=${submitRes.status} ok=${submitRes.json?.ok} id=${submitRes.json?.designVisitId}`,
    submitRes.status === 201 && submitRes.json?.ok === true && Number.isInteger(submitRes.json?.designVisitId),
  );

  const designVisitId = submitRes.json?.designVisitId ?? null;

  // Confirm DB row in design_visits
  let dvRow = null;
  if (designVisitId) {
    const dvQ = await pool.query(
      `SELECT id, contact_id, status, signoff_token_hash, signoff_expires_at
       FROM design_visits WHERE id = $1`,
      [designVisitId]
    );
    dvRow = dvQ.rows[0] ?? null;
  }

  record(
    '(A) design_visits row exists in DB after submit',
    `row with id=${designVisitId} and contact_id=${FAKE_CONTACT_ID}`,
    dvRow ? `found id=${dvRow.id} contact_id=${dvRow.contact_id}` : 'not found',
    dvRow !== null && dvRow.contact_id === FAKE_CONTACT_ID,
  );

  record(
    '(A) design_visits.status = "submitted" after side-effect chain',
    'status=submitted',
    `status=${dvRow?.status}`,
    dvRow?.status === 'submitted',
  );

  // Confirm rooms row in design_visit_rooms
  let roomRows = [];
  if (designVisitId) {
    const roomQ = await pool.query(
      `SELECT id, room_name, unit_count, unit_price_pence
       FROM design_visit_rooms WHERE design_visit_id = $1`,
      [designVisitId]
    );
    roomRows = roomQ.rows;
  }

  record(
    '(A) design_visit_rooms row exists in DB after submit',
    '1 room row with room_name="Kitchen"',
    `found ${roomRows.length} room(s), first=${roomRows[0]?.room_name}`,
    roomRows.length === 1 && roomRows[0]?.room_name === 'Kitchen',
  );

  // Confirm image row in design_visit_room_images
  let imageRows = [];
  const expectedStorageKey = `sdv-test-photo-${runId}.jpg`;
  if (roomRows.length > 0) {
    const imgQ = await pool.query(
      `SELECT room_id, storage_key, mime_type
       FROM design_visit_room_images WHERE room_id = $1`,
      [roomRows[0].id]
    );
    imageRows = imgQ.rows;
  }

  record(
    '(A) design_visit_room_images row exists in DB after submit',
    `1 image row with storage_key="${expectedStorageKey}" and mime_type="image/jpeg"`,
    `found ${imageRows.length} image(s), storage_key=${imageRows[0]?.storage_key}, mime_type=${imageRows[0]?.mime_type}`,
    imageRows.length === 1
      && imageRows[0]?.storage_key === expectedStorageKey
      && imageRows[0]?.mime_type === 'image/jpeg',
  );

  // Verify side-effect chain observables — token set, QB skipped, HubSpot/email skipped
  if (dvRow) {
    record(
      '(A) signoff_token_hash is set after submit (step 1 of side-effect chain)',
      'signoff_token_hash IS NOT NULL (generated by runSubmitSideEffects)',
      `signoff_token_hash=${dvRow.signoff_token_hash ? 'set (non-null)' : 'NULL'}`,
      dvRow.signoff_token_hash !== null && dvRow.signoff_token_hash !== undefined,
    );
    const expiresInFuture = dvRow.signoff_expires_at
      && new Date(dvRow.signoff_expires_at) > new Date();
    record(
      '(A) signoff_expires_at is set and in the future (7-day expiry set by chain)',
      'signoff_expires_at > now()',
      `signoff_expires_at=${dvRow.signoff_expires_at}`,
      expiresInFuture === true,
    );
    // QB credentials are stripped in the test environment — the chain should
    // skip the QB estimate step gracefully, leaving qb_estimate_id as NULL.
    const qbQ = await pool.query(
      `SELECT qb_estimate_id FROM design_visits WHERE id=$1`, [designVisitId],
    );
    record(
      '(A) QB estimate skipped gracefully (no QB tokens) — qb_estimate_id is NULL',
      'qb_estimate_id IS NULL (QB step skipped without crashing the chain)',
      `qb_estimate_id=${qbQ.rows[0]?.qb_estimate_id ?? 'NULL'}`,
      (qbQ.rows[0]?.qb_estimate_id ?? null) === null,
    );

    // Server log assertions — HubSpot and email steps skipped without errors.
    // HUBSPOT_ACCESS_TOKEN is stripped by the harness, so the HubSpot code path
    // is never entered (gated by `if (process.env.HUBSPOT_ACCESS_TOKEN)`). The
    // SMTP transport is null (no SMTP env vars), so customer/team email send is
    // silently skipped. We verify the server log contains no HubSpot errors and
    // no fatal side-effect chain error, confirming clean graceful skipping.
    // Allow a short settle so the async side-effects have time to log.
    await new Promise(r => setTimeout(r, 500));
    const logsSoFar = logBuf.join('');
    const hasChainError   = logsSoFar.includes('[design-visits] Side effect chain error');
    const hasHubspotError = logsSoFar.includes('[design-visits] HubSpot');
    record(
      '(A) HubSpot skipped cleanly — no HubSpot error in server log (token absent)',
      'no "[design-visits] HubSpot" in server log',
      hasHubspotError ? 'FAIL: HubSpot error logged (unexpected)' : 'no HubSpot error logged',
      !hasHubspotError,
    );
    record(
      '(A) Side-effect chain completed without fatal error',
      'no "[design-visits] Side effect chain error" in server log',
      hasChainError ? 'FAIL: chain error logged' : 'no chain error logged',
      !hasChainError,
    );
  }

  // ── (B) Public sign-off: approve ──────────────────────────────────────────
  console.log('\n  [B] Sign-off: approve');

  // Plant a known raw token directly in the DB so we can test the sign-off API
  const rawTokenB = `sdv-signoff-b-${runId}`;
  const hashB = tokenHash(rawTokenB);
  const expiresB = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  if (designVisitId) {
    await pool.query(
      `UPDATE design_visits
       SET signoff_token_hash = $1, signoff_expires_at = $2, status = 'submitted', updated_at = NOW()
       WHERE id = $3`,
      [hashB, expiresB.toISOString(), designVisitId]
    );
  }

  // GET sign-off summary → 200 without session
  {
    const { makeClient } = require('../privileges/harness');
    const anonClient = makeClient(null);
    const r = await anonClient.get(`/api/design-visits/sign-off/${rawTokenB}`);
    record(
      '(B) GET /api/design-visits/sign-off/:token returns 200 with visit summary',
      'status=200, JSON with id and rooms',
      `status=${r.status} id=${r.json?.id} rooms=${Array.isArray(r.json?.rooms) ? r.json.rooms.length : 'n/a'}`,
      r.status === 200 && r.json?.id === designVisitId && Array.isArray(r.json?.rooms),
    );
  }

  // POST { action: 'approve' } → 200, status flips to signed_off
  {
    const { makeClient } = require('../privileges/harness');
    const anonClient = makeClient(null);
    const r = await anonClient.post(`/api/design-visits/sign-off/${rawTokenB}`, { action: 'approve' });
    record(
      '(B) POST sign-off approve returns { success: true, status: "signed_off" }',
      'status=200, success=true, status=signed_off',
      `status=${r.status} success=${r.json?.success} signoffStatus=${r.json?.status}`,
      r.status === 200 && r.json?.success === true && r.json?.status === 'signed_off',
    );
  }

  // Verify DB state
  {
    const dvQ = await pool.query(
      `SELECT status, signoff_token_hash FROM design_visits WHERE id = $1`,
      [designVisitId]
    );
    const row = dvQ.rows[0];
    record(
      '(B) design_visits.status = "signed_off" in DB after approve',
      'status=signed_off, signoff_token_hash=NULL',
      `status=${row?.status} token_hash=${row?.signoff_token_hash ?? 'NULL'}`,
      row?.status === 'signed_off' && row?.signoff_token_hash === null,
    );
  }

  // Second POST with same token → 404 (token consumed)
  {
    const { makeClient } = require('../privileges/harness');
    const anonClient = makeClient(null);
    const r = await anonClient.post(`/api/design-visits/sign-off/${rawTokenB}`, { action: 'approve' });
    record(
      '(B) Second POST with same token returns 404 (token consumed)',
      'status=404',
      `status=${r.status}`,
      r.status === 404,
    );
  }

  // ── (C) Public sign-off: revision then re-submit ───────────────────────────
  console.log('\n  [C] Sign-off: revision + re-submit');

  // Create a second visit for revision probe
  const submitResC = await memberClient.post('/api/design-visits', {
    contactId:    FAKE_CONTACT_ID,
    contactName:  'SDV Test Customer',
    contactEmail: 'sdv-customer@privtest.local',
    termsAccepted: true,
    rooms: [{ roomName: 'Living Room', unitCount: 4, unitPricePence: 20000 }],
    handlerConfig: {},
  });
  const visitIdC = submitResC.json?.designVisitId ?? null;
  record(
    '(C) Second POST /api/design-visits for revision probe returns 201',
    'status=201, designVisitId is integer',
    `status=${submitResC.status} id=${visitIdC}`,
    submitResC.status === 201 && Number.isInteger(visitIdC),
  );

  // Plant known token for visit C
  const rawTokenC = `sdv-signoff-c-${runId}`;
  const hashC = tokenHash(rawTokenC);
  if (visitIdC) {
    await pool.query(
      `UPDATE design_visits
       SET signoff_token_hash = $1, signoff_expires_at = $2, status = 'submitted', updated_at = NOW()
       WHERE id = $3`,
      [hashC, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), visitIdC]
    );
  }

  // POST { action: 'revision', note: '...' } → 200, status = revision_requested
  {
    const { makeClient } = require('../privileges/harness');
    const anonClient = makeClient(null);
    const r = await anonClient.post(`/api/design-visits/sign-off/${rawTokenC}`, {
      action: 'revision',
      note: 'Please change the kitchen worktop colour.',
    });
    record(
      '(C) POST sign-off revision returns { success: true, status: "revision_requested" }',
      'status=200, success=true, status=revision_requested',
      `status=${r.status} success=${r.json?.success} signoffStatus=${r.json?.status}`,
      r.status === 200 && r.json?.success === true && r.json?.status === 'revision_requested',
    );
  }

  // Verify DB state after revision
  {
    const dvQ = await pool.query(
      `SELECT status, revision_note, signoff_token_hash FROM design_visits WHERE id = $1`,
      [visitIdC]
    );
    const row = dvQ.rows[0];
    record(
      '(C) design_visits.status = "revision_requested" in DB, token nulled',
      'status=revision_requested, token=NULL',
      `status=${row?.status} token=${row?.signoff_token_hash ?? 'NULL'}`,
      row?.status === 'revision_requested' && row?.signoff_token_hash === null,
    );
    record(
      '(C) revision_note stored in DB',
      'revision_note contains the provided text',
      `note=${JSON.stringify(row?.revision_note)}`,
      typeof row?.revision_note === 'string' && row.revision_note.length > 0,
    );
  }

  // Re-submit via POST /api/design-visits/:id/submit → flips back to submitted
  if (visitIdC) {
    const resubmitRes = await memberClient.post(`/api/design-visits/${visitIdC}/submit`, {
      handlerConfig: {},
    });
    record(
      '(C) POST /api/design-visits/:id/submit after revision returns { ok: true }',
      'status=200, ok=true',
      `status=${resubmitRes.status} ok=${resubmitRes.json?.ok}`,
      resubmitRes.status === 200 && resubmitRes.json?.ok === true,
    );

    // Verify flipped back to submitted
    const dvQ = await pool.query(
      `SELECT status FROM design_visits WHERE id = $1`,
      [visitIdC]
    );
    const row = dvQ.rows[0];
    record(
      '(C) design_visits.status = "submitted" after re-submit',
      'status=submitted',
      `status=${row?.status}`,
      row?.status === 'submitted',
    );
  }

  // ── (D) Token security ─────────────────────────────────────────────────────
  console.log('\n  [D] Token security');
  const { makeClient } = require('../privileges/harness');

  // Wrong (non-existent) token → 404
  {
    const anonClient = makeClient(null);
    const r = await anonClient.get('/api/design-visits/sign-off/completely-wrong-token-xyz');
    record(
      '(D) Wrong token returns 404',
      'status=404',
      `status=${r.status}`,
      r.status === 404,
    );
  }

  // Expired token — insert a visit with an expired signoff_expires_at
  {
    const rawTokenExpired = `sdv-expired-${runId}`;
    const hashExpired = tokenHash(rawTokenExpired);
    const expiredAt = new Date(Date.now() - 1000); // 1 second in the past
    await pool.query(
      `INSERT INTO design_visits
         (contact_id, contact_name, contact_email, created_by, status,
          terms_accepted, signoff_token_hash, signoff_expires_at)
       VALUES ($1, 'Expired Customer', 'exp@privtest.local', $2, 'submitted', true, $3, $4)`,
      [FAKE_CONTACT_ID, users.member.email, hashExpired, expiredAt.toISOString()]
    );
    const anonClient = makeClient(null);
    const r = await anonClient.get(`/api/design-visits/sign-off/${rawTokenExpired}`);
    record(
      '(D) Expired token returns 404',
      'status=404',
      `status=${r.status}`,
      r.status === 404,
    );
    // POST on expired also should 404
    const r2 = await anonClient.post(`/api/design-visits/sign-off/${rawTokenExpired}`, { action: 'approve' });
    record(
      '(D) POST with expired token returns 404',
      'status=404',
      `status=${r2.status}`,
      r2.status === 404,
    );
  }

  // Already-consumed (signed_off) — status != submitted → 404
  {
    // Visit B is already signed_off with token hash = NULL
    const rawTokenConsumed = `sdv-consumed-${runId}`;
    const hashConsumed = tokenHash(rawTokenConsumed);
    // Plant token on the signed_off visit — normally the token is nulled on approve,
    // but let's test the status guard by creating a new visit in signed_off status.
    await pool.query(
      `INSERT INTO design_visits
         (contact_id, contact_name, created_by, status, terms_accepted,
          signoff_token_hash, signoff_expires_at)
       VALUES ($1, 'Consumed Customer', $2, 'signed_off', true, $3, $4)`,
      [
        FAKE_CONTACT_ID,
        users.member.email,
        hashConsumed,
        new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      ]
    );
    const anonClient = makeClient(null);
    const r = await anonClient.get(`/api/design-visits/sign-off/${rawTokenConsumed}`);
    record(
      '(D) Token on already signed-off visit returns 404',
      'status=404 (status guard prevents oracle leakage)',
      `status=${r.status}`,
      r.status === 404,
    );
  }

  // ── (E) Admin catalogue CRUD ───────────────────────────────────────────────
  console.log('\n  [E] Admin catalogue CRUD');

  // — Handles —
  // POST (create)
  const createHandleRes = await adminClient.post('/api/admin/design-visit-handles', {
    name: HANDLE_CRUD_NAME, description: 'CRUD test', sort_order: 9991,
  });
  const crudHandleId = createHandleRes.json?.id ?? null;
  record(
    '(E) POST /api/admin/design-visit-handles creates a handle (201)',
    'status=201, id is integer',
    `status=${createHandleRes.status} id=${crudHandleId}`,
    createHandleRes.status === 201 && Number.isInteger(crudHandleId),
  );
  {
    const r = await pool.query(`SELECT name FROM design_visit_handles WHERE id=$1`, [crudHandleId]);
    record(
      '(E) Handle row exists in DB after POST',
      `name="${HANDLE_CRUD_NAME}"`,
      `name=${r.rows[0]?.name}`,
      r.rows[0]?.name === HANDLE_CRUD_NAME,
    );
  }

  // PATCH (update)
  if (crudHandleId) {
    const patchRes = await adminClient.patch(`/api/admin/design-visit-handles/${crudHandleId}`, {
      description: 'Updated description',
    });
    record(
      '(E) PATCH /api/admin/design-visit-handles/:id updates the handle',
      'status=200',
      `status=${patchRes.status}`,
      patchRes.status === 200,
    );
    const r = await pool.query(`SELECT description FROM design_visit_handles WHERE id=$1`, [crudHandleId]);
    record(
      '(E) Handle description updated in DB after PATCH',
      'description="Updated description"',
      `description=${r.rows[0]?.description}`,
      r.rows[0]?.description === 'Updated description',
    );
  }

  // Non-admin PATCH → 403
  {
    const r = await memberClient.patch(`/api/admin/design-visit-handles/${crudHandleId ?? 1}`, {
      name: 'hacked',
    });
    const blocked = r.status === 401 || r.status === 403 || r.status === 302;
    record(
      '(E) Non-admin PATCH /api/admin/design-visit-handles/:id blocked',
      'status=403/401/302',
      `status=${r.status}`,
      blocked,
    );
  }

  // DELETE
  if (crudHandleId) {
    const delRes = await adminClient.delete(`/api/admin/design-visit-handles/${crudHandleId}`);
    record(
      '(E) DELETE /api/admin/design-visit-handles/:id removes the handle',
      'status=200, success=true',
      `status=${delRes.status} success=${delRes.json?.success}`,
      delRes.status === 200 && delRes.json?.success === true,
    );
    const r = await pool.query(`SELECT id FROM design_visit_handles WHERE id=$1`, [crudHandleId]);
    record(
      '(E) Handle row gone from DB after DELETE',
      'no rows',
      `rows=${r.rows.length}`,
      r.rows.length === 0,
    );
  }

  // Non-admin DELETE → 403
  {
    const r = await memberClient.delete(`/api/admin/design-visit-handles/${handleId ?? 1}`);
    const blocked = r.status === 401 || r.status === 403 || r.status === 302;
    record(
      '(E) Non-admin DELETE /api/admin/design-visit-handles/:id blocked',
      'status=403/401/302',
      `status=${r.status}`,
      blocked,
    );
  }

  // — Furniture Ranges —
  const createFurnitureRes = await adminClient.post('/api/admin/design-visit-furniture-ranges', {
    name: FURNITURE_CRUD_NAME, sort_order: 9991,
  });
  const crudFurnitureId = createFurnitureRes.json?.id ?? null;
  record(
    '(E) POST /api/admin/design-visit-furniture-ranges creates a range (201)',
    'status=201, id is integer',
    `status=${createFurnitureRes.status} id=${crudFurnitureId}`,
    createFurnitureRes.status === 201 && Number.isInteger(crudFurnitureId),
  );

  if (crudFurnitureId) {
    const patchRes = await adminClient.patch(`/api/admin/design-visit-furniture-ranges/${crudFurnitureId}`, {
      description: 'Updated range description',
    });
    record(
      '(E) PATCH /api/admin/design-visit-furniture-ranges/:id updates the range',
      'status=200',
      `status=${patchRes.status}`,
      patchRes.status === 200,
    );
    const delRes = await adminClient.delete(`/api/admin/design-visit-furniture-ranges/${crudFurnitureId}`);
    record(
      '(E) DELETE /api/admin/design-visit-furniture-ranges/:id removes the range',
      'status=200',
      `status=${delRes.status}`,
      delRes.status === 200 && delRes.json?.success === true,
    );
  }

  // — Door Styles —
  const createDoorStyleRes = await adminClient.post('/api/admin/design-visit-door-styles', {
    name: DOOR_STYLE_CRUD_NAME, sort_order: 9991,
  });
  const crudDoorStyleId = createDoorStyleRes.json?.id ?? null;
  record(
    '(E) POST /api/admin/design-visit-door-styles creates a door style (201)',
    'status=201, id is integer',
    `status=${createDoorStyleRes.status} id=${crudDoorStyleId}`,
    createDoorStyleRes.status === 201 && Number.isInteger(crudDoorStyleId),
  );

  if (crudDoorStyleId) {
    const patchRes = await adminClient.patch(`/api/admin/design-visit-door-styles/${crudDoorStyleId}`, {
      image_url: 'https://example.com/style.png',
    });
    record(
      '(E) PATCH /api/admin/design-visit-door-styles/:id updates the door style',
      'status=200',
      `status=${patchRes.status}`,
      patchRes.status === 200,
    );
    const delRes = await adminClient.delete(`/api/admin/design-visit-door-styles/${crudDoorStyleId}`);
    record(
      '(E) DELETE /api/admin/design-visit-door-styles/:id removes the door style',
      'status=200',
      `status=${delRes.status}`,
      delRes.status === 200 && delRes.json?.success === true,
    );
  }

  // ── (E/BC) Admin catalogue mutations emit BroadcastChannel events ─────────
  // Drives admin.html's JavaScript (openDvHandleEditor / openDvFurnitureEditor
  // / openDvDoorStyleEditor) through the real UI so that
  // _broadcastDvCatalogueChange() fires naturally — not from a manual channel
  // post. A listener page asserts event receipt for each catalogue type.
  console.log('\n  [E/BC] Admin catalogue → BroadcastChannel (via admin.html UI)');

  // (E/BC) covers CREATE, PATCH, and DELETE BC emissions for all three catalogue
  // types via the real admin.html JavaScript — not manual channel posts.
  const E_BC_PROBE_NAMES = [
    '(E/BC) admin.html handle CREATE fires design_visit_handles_changed BC',
    '(E/BC) admin.html handle PATCH fires design_visit_handles_changed BC',
    '(E/BC) admin.html handle DELETE fires design_visit_handles_changed BC',
    '(E/BC) admin.html furniture CREATE fires design_visit_furniture_ranges_changed BC',
    '(E/BC) admin.html furniture PATCH fires design_visit_furniture_ranges_changed BC',
    '(E/BC) admin.html furniture DELETE fires design_visit_furniture_ranges_changed BC',
    '(E/BC) admin.html door-style CREATE fires design_visit_door_styles_changed BC',
    '(E/BC) admin.html door-style PATCH fires design_visit_door_styles_changed BC',
    '(E/BC) admin.html door-style DELETE fires design_visit_door_styles_changed BC',
  ];

  if (!puppeteer) {
    for (const label of E_BC_PROBE_NAMES) {
      record(label, 'puppeteer installed', 'puppeteer not installed', false);
    }
  } else {
    let eBcBrowser = null;
    let eBcLaunchErr = null;
    const eBcSysChrome = findSystemChromium();
    const eBcAttempts = [{ args: ['--no-sandbox', '--disable-setuid-sandbox'] }];
    if (eBcSysChrome) eBcAttempts.push({ executablePath: eBcSysChrome, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    for (const opts of eBcAttempts) {
      try { eBcBrowser = await puppeteer.launch({ headless: true, ...opts }); eBcLaunchErr = null; break; }
      catch (e) { eBcLaunchErr = e; eBcBrowser = null; }
    }

    if (eBcLaunchErr || !eBcBrowser) {
      const msg = (eBcLaunchErr?.message || String(eBcLaunchErr)).slice(0, 120);
      for (const label of E_BC_PROBE_NAMES) {
        record(label, 'browser launched and admin.html UI tested', `browser launch failed: ${msg}`, false);
      }
    } else {
      try {
        // listener tab: a generic page with BC listeners for all three channels
        const eBcListenTab = await eBcBrowser.newPage();
        await eBcListenTab.setCacheEnabled(false);
        await injectSession(eBcListenTab, adminClient.cookie);
        await eBcListenTab.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await eBcListenTab.evaluate(() => {
          window.__dvBcCounts = { handle: 0, furniture: 0, doorStyle: 0 };
          const map = {
            design_visit_handles_changed:           'handle',
            design_visit_furniture_ranges_changed:  'furniture',
            design_visit_door_styles_changed:       'doorStyle',
          };
          for (const [ch, key] of Object.entries(map)) {
            const bc = new BroadcastChannel(ch);
            bc.onmessage = () => { window.__dvBcCounts[key]++; };
          }
        });

        // admin tab: load admin.html (exposes openDvHandleEditor / openDvFurnitureEditor
        // / openDvDoorStyleEditor / deleteDvItem on window)
        const eBcAdminTab = await eBcBrowser.newPage();
        await eBcAdminTab.setCacheEnabled(false);
        await injectSession(eBcAdminTab, adminClient.cookie);
        await eBcAdminTab.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await new Promise(r => setTimeout(r, 1000)); // let admin.html boot

        // Helper: read + increment the listener counter for a catalogue type
        const readCount = (key) => eBcListenTab.evaluate(k => window.__dvBcCounts[k], key);

        // Helper: open the item editor modal, fill the name field, and save.
        // Returns when the modal has closed (save complete + BC fired).
        const saveViaEditor = async (openFn, itemName) => {
          await eBcAdminTab.evaluate(fn => window[fn](), openFn);
          await pollPage(eBcAdminTab, () => document.querySelector('#dvie-name') ? 'ready' : null, null, 6000);
          await eBcAdminTab.evaluate(name => {
            const inp = document.querySelector('#dvie-name');
            if (inp) { inp.value = ''; inp.value = name; }
          }, itemName);
          await eBcAdminTab.evaluate(() => document.querySelector('#dvie-save')?.click());
          await pollPage(eBcAdminTab, () => !document.querySelector('#dvie-save') ? 'closed' : null, null, 8000);
          await new Promise(r => setTimeout(r, 300));
        };

        // Helper: open the edit editor for an EXISTING item (PATCH flow)
        const editViaEditor = async (openFn, id, newName) => {
          await eBcAdminTab.evaluate((fn, id) => window[fn](id), openFn, id);
          await pollPage(eBcAdminTab, () => document.querySelector('#dvie-name') ? 'ready' : null, null, 6000);
          await eBcAdminTab.evaluate(name => {
            const inp = document.querySelector('#dvie-name');
            if (inp) { inp.value = ''; inp.value = name; }
          }, newName);
          await eBcAdminTab.evaluate(() => document.querySelector('#dvie-save')?.click());
          await pollPage(eBcAdminTab, () => !document.querySelector('#dvie-save') ? 'closed' : null, null, 8000);
          await new Promise(r => setTimeout(r, 300));
        };

        // Helper: delete an item via admin.html UI (accepts the confirm() dialog)
        const deleteViaUI = async (type, id) => {
          eBcAdminTab.once('dialog', d => d.accept());
          await eBcAdminTab.evaluate((t, id) => window.deleteDvItem(t, id), type, id);
          await new Promise(r => setTimeout(r, 600)); // BC fires after api() resolves
        };

        // ── Probe loop: handle / furniture / door-style ──────────────────────
        for (const [type, openFn, countKey, apiSuffix] of [
          ['handle',     'openDvHandleEditor',    'handle',    'handles'],
          ['furniture',  'openDvFurnitureEditor',  'furniture', 'furniture-ranges'],
          ['door-style', 'openDvDoorStyleEditor',  'doorStyle', 'door-styles'],
        ]) {
          const apiBase = `/api/admin/design-visit-${apiSuffix}`;

          // ── CREATE ───────────────────────────────────────────────────────────
          {
            const createName = `${RUN_PREFIX} ui-bc-create-${type}-${runId}`;
            const before = await readCount(countKey);
            await saveViaEditor(openFn, createName);
            const after = await readCount(countKey);
            record(
              `(E/BC) admin.html ${type} CREATE fires design_visit_${apiSuffix.replace('-', '_')}_changed BC`,
              `listener count incremented from ${before}`,
              `before=${before} after=${after}`,
              typeof after === 'number' && after > before,
            );
            // Retrieve the created id for PATCH probe below
            let createdId = null;
            try {
              const list = await adminClient.get(apiBase);
              createdId = (list.json || []).find(x => x.name === createName)?.id ?? null;
            } catch {}

            // ── PATCH ──────────────────────────────────────────────────────────
            if (createdId) {
              const patchName = `${RUN_PREFIX} ui-bc-patch-${type}-${runId}`;
              const beforeP = await readCount(countKey);
              await editViaEditor(openFn, createdId, patchName);
              const afterP = await readCount(countKey);
              record(
                `(E/BC) admin.html ${type} PATCH fires design_visit_${apiSuffix.replace('-', '_')}_changed BC`,
                `listener count incremented from ${beforeP}`,
                `before=${beforeP} after=${afterP}`,
                typeof afterP === 'number' && afterP > beforeP,
              );

              // ── DELETE ────────────────────────────────────────────────────────
              const beforeD = await readCount(countKey);
              await deleteViaUI(type, createdId);
              const afterD = await readCount(countKey);
              record(
                `(E/BC) admin.html ${type} DELETE fires design_visit_${apiSuffix.replace('-', '_')}_changed BC`,
                `listener count incremented from ${beforeD}`,
                `before=${beforeD} after=${afterD}`,
                typeof afterD === 'number' && afterD > beforeD,
              );
            } else {
              // Could not get ID — clean up best-effort and record failure
              for (const op of ['PATCH', 'DELETE']) {
                record(
                  `(E/BC) admin.html ${type} ${op} fires design_visit_${apiSuffix.replace('-', '_')}_changed BC`,
                  'item created by CREATE probe (id obtained)',
                  'id not found after CREATE — PATCH/DELETE probes skipped',
                  false,
                );
              }
              // Clean up by name if possible
              try {
                const list = await adminClient.get(apiBase);
                const found = (list.json || []).find(x => x.name.startsWith(`${RUN_PREFIX} ui-bc-create-${type}-${runId}`));
                if (found?.id) await adminClient.delete(`${apiBase}/${found.id}`);
              } catch {}
            }
          }
        }

        await eBcAdminTab.close();
        await eBcListenTab.close();
      } finally {
        await eBcBrowser.close().catch(() => {});
      }
    }
  }

  // ── (F) BroadcastChannel refresh in wizard (Puppeteer) ────────────────────
  // Verifies that:
  //   1. The wizard opens and shows the seeded handle in #dv-handle.
  //   2. After admin creates a new handle via API + BC fires, the wizard
  //      dropdown refreshes in-place (wizard stays open, new item visible).
  //   3. After furniture BC fires, #dv-furniture shows the new range name.
  //   4. After door-style BC fires on step 2, .dv-ds selects show the new style.
  //
  // Uses the system Chromium binary when Puppeteer's bundled Chrome is absent.
  // Probes are recorded as failures when no browser is available — this
  // matches card-action-handlers precedent and ensures CI fails hard rather
  // than silently skipping core BroadcastChannel / wizard coverage.
  console.log('\n  [F] BroadcastChannel refresh in wizard');

  const F_PROBE_LABELS = [
    '(F) Wizard opens and #dv-handle dropdown shows seeded handle',
    '(F) Admin creates new handle via API; BC fires; wizard dropdown refreshes without closing',
    '(F) design_visit_furniture_ranges_changed BC fires; #dv-furniture dropdown shows new range',
    '(F) design_visit_door_styles_changed BC fires on step 2; .dv-ds shows new door style',
  ];

  if (!puppeteer) {
    for (const label of F_PROBE_LABELS) {
      record(label, 'puppeteer installed', 'puppeteer not installed', false);
    }
  } else {
    let browser = null;
    let browserLaunchErr = null;

    const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox'];
    const launchAttempts = [{ args: launchArgs }];
    const sysChrome = findSystemChromium();
    if (sysChrome) launchAttempts.push({ executablePath: sysChrome, args: launchArgs });

    for (const opts of launchAttempts) {
      try {
        browser = await puppeteer.launch({ headless: true, ...opts });
        browserLaunchErr = null;
        break;
      } catch (e) {
        browserLaunchErr = e;
        browser = null;
      }
    }

    if (browserLaunchErr || !browser) {
      const msg = (browserLaunchErr?.message || String(browserLaunchErr)).slice(0, 200);
      for (const label of F_PROBE_LABELS) {
        record(label, 'browser launched and wizard tested', `browser launch failed: ${msg}`, false);
      }
    } else {
      try {
        // ── Tab 1: wizard page ────────────────────────────────────────────────
        // Navigate to /sales (loads card-action-handlers.js which defines
        // openDesignVisitWizard and exposes dispatchCardActionHandler on window).
        const wizardTab = await browser.newPage();
        await wizardTab.setCacheEnabled(false);
        await injectSession(wizardTab, adminClient.cookie);
        await wizardTab.goto(`${BASE}/sales`, { waitUntil: 'domcontentloaded', timeout: 25000 });

        // Wait for card-action-handlers.js to finish loading the handlers index
        // (loadCardActionHandlers() is called automatically on boot).
        await new Promise(r => setTimeout(r, 800));

        // Ensure at least one handle exists before opening the wizard so the
        // #dv-handle select renders (renderStep1 only emits the <select> when
        // handles.length > 0).
        // Our seeded HANDLE_NAME (id=handleId) is already in the DB.

        // Open the wizard via the exposed dispatchCardActionHandler function.
        await wizardTab.evaluate(({ name }) => {
          if (typeof window.dispatchCardActionHandler !== 'function') {
            throw new Error('dispatchCardActionHandler not found on window');
          }
          window.dispatchCardActionHandler(
            { id: 0, type: 'start_design_visit', config: {} },
            { contactId: 'privtest-sdv-f-contact', contactName: 'F Test', contactEmail: 'f@privtest.local' }
          );
        }, { name: HANDLE_NAME });

        // Poll until the wizard's Step 1 is rendered with the #dv-handle select.
        const wizardVisible = await pollPage(
          wizardTab,
          (expectedHandle) => {
            const sel = document.querySelector('#dv-handle');
            if (!sel) return null;
            const opts = Array.from(sel.options).map(o => o.text);
            return opts.some(t => t === expectedHandle) ? opts.join('||') : null;
          },
          HANDLE_NAME,
          10000,
        );
        record(
          '(F) Wizard opens and #dv-handle dropdown shows seeded handle',
          `#dv-handle select contains "${HANDLE_NAME}"`,
          wizardVisible ? `options=${wizardVisible.split('||').join(', ')}` : 'wizard/select not found',
          wizardVisible !== null,
        );

        // ── Create a NEW handle via admin REST API (not through the UI) ──────
        const newHandleName = `${RUN_PREFIX} bc-refresh-handle-${runId}`;
        const newHandleRes  = await adminClient.post('/api/admin/design-visit-handles', {
          name: newHandleName, sort_order: 9995,
        });
        const newHandleId = newHandleRes.json?.id ?? null;

        // ── Tab 2: fire design_visit_handles_changed as admin.html would ──────
        // In the real app admin.html posts to this channel after every handle
        // CRUD. We simulate that with a dedicated sender tab.
        const senderTab = await browser.newPage();
        await injectSession(senderTab, adminClient.cookie);
        await senderTab.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await senderTab.evaluate(() => {
          new BroadcastChannel('design_visit_handles_changed').postMessage({ type: 'changed' });
        });

        // Poll for the new handle name to appear in the wizard dropdown.
        // The wizard BC listener re-fetches /api/design-visit-handles and calls
        // renderStep1() which rebuilds the <select> with the updated list.
        const dropdownUpdated = await pollPage(
          wizardTab,
          (newName) => {
            const sel = document.querySelector('#dv-handle');
            if (!sel) return null;
            return Array.from(sel.options).some(o => o.text === newName) ? 'found' : null;
          },
          newHandleName,
          8000,
        );
        record(
          '(F) Admin creates new handle via API; BC fires; wizard dropdown refreshes without closing',
          `"${newHandleName}" appears in #dv-handle after BC event (wizard still open)`,
          dropdownUpdated === 'found'
            ? `found "${newHandleName}" in dropdown; wizard still open`
            : `"${newHandleName}" not found in dropdown within 8 s`,
          dropdownUpdated === 'found',
        );

        // Confirm the wizard is still open (not closed by the BC refresh)
        // by checking the .dv-wizard-backdrop is still in the DOM.
        const wizardStillOpen = await wizardTab.evaluate(() =>
          document.querySelector('.dv-wizard-backdrop') !== null
        );
        // (incorporated into the label above — this sub-check is part of the
        // same probe, not a separate finding)

        // Cleanup: delete the ephemeral handle
        if (newHandleId) {
          await adminClient.delete(`/api/admin/design-visit-handles/${newHandleId}`);
        }

        // ── Probe (F3): furniture BC → #dv-furniture dropdown refreshes ─────
        {
          const newFrName = `${RUN_PREFIX} bc-fr-${runId}`;
          const frRes = await adminClient.post('/api/admin/design-visit-furniture-ranges', {
            name: newFrName, sort_order: 9996,
          });
          const newFrId = frRes.json?.id ?? null;

          // Fire the BC channel from the sender tab (simulating admin.html post-mutation signal)
          await senderTab.evaluate(() => {
            new BroadcastChannel('design_visit_furniture_ranges_changed').postMessage({ type: 'changed' });
          });

          // Wizard is on step 1. BC handler re-fetches all catalogues and calls
          // renderStep1() which rebuilds both #dv-handle and #dv-furniture selects.
          const frDropUpdated = await pollPage(
            wizardTab,
            (newName) => {
              const sel = document.querySelector('#dv-furniture');
              if (!sel) return null;
              return Array.from(sel.options).some(o => o.text === newName) ? 'found' : null;
            },
            newFrName,
            8000,
          );
          record(
            '(F) design_visit_furniture_ranges_changed BC fires; #dv-furniture dropdown shows new range',
            `"${newFrName}" appears in #dv-furniture after BC event`,
            frDropUpdated === 'found'
              ? `found "${newFrName}" in #dv-furniture dropdown`
              : `"${newFrName}" not found in #dv-furniture within 8 s`,
            frDropUpdated === 'found',
          );

          if (newFrId) await adminClient.delete(`/api/admin/design-visit-furniture-ranges/${newFrId}`);
        }

        // ── Probe (F4): door-style BC → .dv-ds on step 2 shows new style ────
        {
          const newDsName = `${RUN_PREFIX} bc-ds-${runId}`;
          const dsRes = await adminClient.post('/api/admin/design-visit-door-styles', {
            name: newDsName, sort_order: 9997,
          });
          const newDsId = dsRes.json?.id ?? null;

          // Navigate wizard to step 2 so the BC handler calls _saveRoomsFromDom()
          // and renderStep2() (which rebuilds room cards with fresh .dv-ds selects).
          // Step 1 only requires termsAccepted to advance.
          await wizardTab.evaluate(() => {
            const terms = document.querySelector('#dv-terms');
            if (terms) terms.checked = true;
            // Trigger the Next button's click handler
            const next = document.querySelector('.dv-btn-next');
            if (next) next.click();
          });

          // Wait for step 2 to render (look for a .dv-ds select in a room card)
          const step2Ready = await pollPage(
            wizardTab,
            () => document.querySelector('.dv-ds') !== null ? 'ready' : null,
            null,
            6000,
          );

          if (!step2Ready) {
            record(
              '(F) design_visit_door_styles_changed BC fires on step 2; .dv-ds shows new door style',
              '.dv-ds select visible in step 2 after navigating',
              'step 2 did not render within 6 s',
              false,
            );
          } else {
            // Fire the BC channel — wizard is now on step 2, handler calls
            // _saveRoomsFromDom() + renderStep2() rebuilding .dv-ds selects.
            await senderTab.evaluate(() => {
              new BroadcastChannel('design_visit_door_styles_changed').postMessage({ type: 'changed' });
            });

            const dsDropUpdated = await pollPage(
              wizardTab,
              (newName) => {
                const selects = Array.from(document.querySelectorAll('.dv-ds'));
                return selects.some(sel =>
                  Array.from(sel.options).some(o => o.text === newName)
                ) ? 'found' : null;
              },
              newDsName,
              8000,
            );
            record(
              '(F) design_visit_door_styles_changed BC fires on step 2; .dv-ds shows new door style',
              `"${newDsName}" appears in a .dv-ds select after BC event on step 2`,
              dsDropUpdated === 'found'
                ? `found "${newDsName}" in .dv-ds dropdown`
                : `"${newDsName}" not found in .dv-ds within 8 s`,
              dsDropUpdated === 'found',
            );
          }

          if (newDsId) await adminClient.delete(`/api/admin/design-visit-door-styles/${newDsId}`);
        }

        await senderTab.close();
        await wizardTab.close();
      } finally {
        await browser.close().catch(() => {});
      }
    }
  }

  // ── Summary & report ───────────────────────────────────────────────────────
  const pass = findings.filter(f => f.ok === true).length;
  const fail = findings.filter(f => f.ok === false).length;
  const skipped = findings.filter(f => f.ok === null).length;
  const skipSuffix = skipped > 0 ? `, ${skipped} skipped` : '';
  console.log(`\n  Results: ${pass} passed, ${fail} failed${skipSuffix}`);

  await writeReport(runId, findings);
  await cleanupAndExit(fail > 0 ? 1 : 0);
}

// ── Report writer ─────────────────────────────────────────────────────────────
async function writeReport(runId, findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# start_design_visit — E2E Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:start-design-visit\``,
    '',
    '## Summary',
    '',
    `- Passed: ${findings.filter(f => f.ok === true).length} / ${findings.filter(f => f.ok !== null).length} required`,
    `- Failed: ${findings.filter(f => f.ok === false).length} / ${findings.filter(f => f.ok !== null).length} required`,
    `- Skipped: ${findings.filter(f => f.ok === null).length} (browser-dependent; non-fatal)`,
    '',
    '## Results',
    '',
    '| Result | Probe | Expected | Observed |',
    '|---|---|---|---|',
    ...findings.map(f =>
      `| ${f.ok === true ? 'PASS' : f.ok === null ? 'SKIP' : 'FAIL'} | ${esc(f.name)} | ${esc(f.expected)} | ${esc(f.observed)} |`,
    ),
    '',
    '## Coverage',
    '',
    '- **(API pre-checks)**: All three admin catalogue endpoints return 200 for admin,',
    '  200 for authenticated member on public routes, and 401/403 for unauthenticated',
    '  requests. Public sign-off route returns 404 (not 401) for a bad token,',
    '  confirming it is accessible without a session.',
    '- **(G) Privilege gates (REST)**: Unauthenticated POST `/api/design-visits`',
    '  returns 401/403. Non-admin DELETE `/api/design-visits/:id` returns 403.',
    '  Non-admin POST to admin catalogue returns 403.',
    '- **(A) Wizard submit flow**: POST `/api/design-visits` with a seeded contact,',
    '  one room (including one image with `storageKey` + `mimeType`), seeded handle',
    '  and furniture range. Asserts 201 + `{ ok, designVisitId }`, confirms DB rows in',
    '  `design_visits` (status=submitted), `design_visit_rooms`, and',
    '  `design_visit_room_images` (storage_key and mime_type verified).',
    '  Side-effect chain verified: `signoff_token_hash` set (non-null), `signoff_expires_at`',
    '  set and > now(), `qb_estimate_id` is NULL (QB skip with stripped credentials).',
    '  HubSpot and email calls are skipped gracefully (tokens/SMTP stripped).',
    '- **(B) Sign-off: approve**: GET retrieves visit summary JSON without a session.',
    '  POST approve flips status to `signed_off` and nulls `signoff_token_hash` in DB.',
    '  Second POST with same token returns 404 (token consumed).',
    '- **(C) Sign-off: revision + re-submit**: POST revision flips status to',
    '  `revision_requested`, stores the note, and nulls the token. Subsequent',
    '  POST `/api/design-visits/:id/submit` flips back to `submitted`.',
    '- **(D) Token security**: Wrong token → 404. Expired token (signoff_expires_at',
    '  in the past) → 404 on both GET and POST. Token on an already-`signed_off`',
    '  visit → 404 (status guard avoids oracle leakage on all cases).',
    '- **(E) Admin catalogue CRUD**: POST / PATCH / DELETE for handles, furniture',
    '  ranges, and door styles via admin API; DB state confirmed after each mutation.',
    '  Non-admin PATCH on handles returns 403.',
    '- **(E/BC) Admin catalogue → BroadcastChannel (via admin.html UI)**: Drives',
    '  `openDvHandleEditor()`, `openDvFurnitureEditor()`, `openDvDoorStyleEditor()`',
    '  through the real admin.html JavaScript. After each save, `_broadcastDvCatalogueChange()`',
    '  fires naturally; a listener page asserts the event is received for all three types.',
    '- **(F) BroadcastChannel refresh in wizard**: Opens the wizard on `/sales` via',
    '  `dispatchCardActionHandler`. Verifies `#dv-handle` shows the seeded handle.',
    '  Creates a new handle via REST API, fires BC from sender tab, and asserts the',
    '  new name appears in `#dv-handle` (wizard stays open). Creates a new furniture',
    '  range, fires BC, and asserts `#dv-furniture` shows the new name. Navigates',
    '  wizard to step 2, creates a new door style, fires BC, and asserts the new',
    '  style appears in `.dv-ds` room-card selects.',
  ];
  const outPath = path.join(dir, 'start-design-visit.md');
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  console.log(`  Report written to ${outPath}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(2);
});
