'use strict';
const { makeSkip } = require('../helpers/report');
// test/start-survey-visit/run.js
//
// Backend end-to-end test for the start_survey_visit card-action handler.
// Mirrors the API/data-integrity portions of test/start-design-visit/run.js
// but stays backend-only (no Puppeteer/UI coverage) per the project test
// policy: cover auth, data integrity, and API error handling only.
//
// Covers:
//   (API) Pre-checks — shared catalogue endpoints respond for admin; public
//         survey sign-off route is reachable (404 not 401) for a bad token.
//   (G)   Privilege gates — unauthenticated POST /api/survey-visits → 401/403;
//         non-admin DELETE /api/survey-visits/:id → 403.
//   (A)   Wizard submit — POST /api/survey-visits with a seeded contact; DB
//         rows confirmed in survey_visits (status=submitted), survey_visit_rooms,
//         and survey_visit_room_images (storage_key + mime_type); sign-off token
//         minted; HubSpot/QB/email skipped (tokens stripped) without crashing.
//   (A2)  source_design_visit_room_id persisted on the created room.
//   (B)   Sign-off: approve — GET summary (no session); POST approve flips status
//         to "signed_off" and nulls token; second POST returns 404.
//   (C)   Sign-off: revision + re-submit — POST revision flips status to
//         "revision_requested" and supersedes the token; POST /:id/submit flips
//         back to "submitted".
//   (D)   Token security — wrong, expired, and already-signed-off tokens all
//         return 404 (no oracle leakage).
//   (N)   Note pre-fill — POST /api/card-actions/start-design-visit with a
//         stubbed contact returns visitNotes + visitNotesTimestamp; a contact
//         absent from the stub returns empty strings.
//   (R)   Refund — POST /api/survey-visits/refund records a refund_requested row.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:start-survey-visit
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:start-survey-visit

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
  makeClient,
  PASSWORD,
  BASE,
} = require('../privileges/harness');

require('dotenv').config();

const { pollFn } = require('../helpers/poll');

// ── Fixture name constants ────────────────────────────────────────────────────
const RUN_PREFIX = 'privtest-ssv';

const HANDLE_NAME     = `${RUN_PREFIX} test handle`;
const FURNITURE_NAME  = `${RUN_PREFIX} test furniture range`;
const DOOR_STYLE_NAME = `${RUN_PREFIX} test door style`;

const FAKE_CONTACT_ID = `privtest-ssv-contact-001`;

// ── Note pre-fill stub constants ──────────────────────────────────────────────
// Numeric contact IDs required by the /api/card-actions/start-design-visit
// endpoint (/^\d+$/ validation). These are outside any real HubSpot ID range
// used by the dev/prod accounts, and are only meaningful within the stub.
const NOTE_CONTACT_ID  = '99900001'; // present in HUBSPOT_NOTES_STUB → note returned
const EMPTY_CONTACT_ID = '99900002'; // absent from stub → empty strings returned

const STUB_NOTE_BODY      = 'Automated backend note pre-fill test — SSV suite';
const STUB_NOTE_TIMESTAMP = '2026-01-15T10:00:00.000Z';

const HUBSPOT_NOTES_STUB_JSON = JSON.stringify({
  [NOTE_CONTACT_ID]: { body: STUB_NOTE_BODY, ts: STUB_NOTE_TIMESTAMP },
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function tokenHash(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// ── Fixture teardown ─────────────────────────────────────────────────────────
async function purgeFixtures(pool) {
  // survey_visits cascades to rooms + images. Scope to created_by LIKE
  // 'privtest-%' so a shared-DB run never removes unrelated rows.
  await pool.query(
    `DELETE FROM survey_visits
      WHERE contact_id = $1
        AND created_by LIKE 'privtest-%'`,
    [FAKE_CONTACT_ID]
  );
  await pool.query(`DELETE FROM catalog_handles WHERE name = $1`, [HANDLE_NAME]);
  await pool.query(`DELETE FROM catalog_ranges  WHERE name = $1`, [FURNITURE_NAME]);
  await pool.query(`DELETE FROM catalog_doors   WHERE name = $1`, [DOOR_STYLE_NAME]);
  try {
    await pool.query(
      `DELETE FROM terms_conditions_versions WHERE terms_text LIKE 'privtest-tcv-%'`
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

  const runId = Math.random().toString(36).slice(2, 8);
  console.log(`\n  start-survey-visit E2E (backend)  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);

  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  admin=${users.admin.email}  member=${users.member.email}`);

  const { child, logBuf } = spawnServer({
    extraEnv: {
      // A fake access token satisfies requireHubspotToken without live calls.
      HUBSPOT_ACCESS_TOKEN: 'stub-token-for-ssv-note-test',
      // Stub canned note data for NOTE_CONTACT_ID; absent IDs return empty.
      HUBSPOT_NOTES_STUB: HUBSPOT_NOTES_STUB_JSON,
    },
  });
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

  // Wait for survey + shared catalogue tables.
  const waitForTable = async (name) => {
    const found = await pollFn(async () => {
      const r = await pool.query(`SELECT to_regclass($1) AS t`, [name]);
      return r.rows[0].t || null;
    }, 15000, 200);
    if (!found) throw new Error(`Timed out waiting for table ${name}`);
  };
  await Promise.all([
    waitForTable('catalog_handles'),
    waitForTable('catalog_ranges'),
    waitForTable('catalog_doors'),
    waitForTable('survey_visits'),
    waitForTable('survey_visit_rooms'),
    waitForTable('survey_visit_room_images'),
  ]);
  console.log('  All survey_visit_* + catalog_* tables ready');

  await purgeFixtures(pool);

  // ── Seed catalogue fixtures (shared catalogue via canonical admin routes) ───
  const adminClient  = await login(users.admin.email,  PASSWORD);
  const memberClient = await login(users.member.email, PASSWORD);

  const seedHandle = await adminClient.post('/api/admin/catalog/handles', {
    name: HANDLE_NAME, description: 'Seed handle for SSV test', sort_order: 9990,
  });
  const handleId = seedHandle.json?.id ?? null;

  const seedFurniture = await adminClient.post('/api/admin/catalog/ranges', {
    name: FURNITURE_NAME, description: 'Seed range for SSV test', sort_order: 9990,
  });
  const furnitureId = seedFurniture.json?.id ?? null;

  const seedDoorStyle = await adminClient.post('/api/admin/catalog/doors', {
    name: DOOR_STYLE_NAME, sort_order: 9990,
  });
  const doorStyleId = seedDoorStyle.json?.id ?? null;
  console.log(`  Seeded catalogue  handle=${handleId} range=${furnitureId} door=${doorStyleId}`);

  // ── API pre-checks ─────────────────────────────────────────────────────────
  console.log('\n  [API] Pre-checks');

  for (const [label, p] of [
    ['GET /api/admin/catalog/handles', '/api/admin/catalog/handles'],
    ['GET /api/admin/catalog/ranges',  '/api/admin/catalog/ranges'],
    ['GET /api/admin/catalog/doors',   '/api/admin/catalog/doors'],
  ]) {
    const r = await adminClient.get(p);
    record(
      `${label} responds for admin`,
      'status=200, JSON array',
      `status=${r.status} type=${Array.isArray(r.json) ? 'array' : typeof r.json}`,
      r.status === 200 && Array.isArray(r.json),
    );
  }

  // Public survey sign-off route reachable without a session — bad token → 404
  {
    const anonClient = makeClient(null);
    const r = await anonClient.get('/api/survey-visits/sign-off/nosuchtoken');
    record(
      'GET /api/survey-visits/sign-off/:token is public (returns 404 not 401)',
      'status=404',
      `status=${r.status}`,
      r.status === 404,
    );
  }

  // ── (G) Privilege gates — REST ─────────────────────────────────────────────
  console.log('\n  [G] Privilege gates (REST)');

  {
    const anonClient = makeClient(null);
    const r = await anonClient.post('/api/survey-visits', {
      contactId: FAKE_CONTACT_ID,
      rooms: [{ roomName: 'Kitchen', unitCount: 1, unitPricePence: 0 }],
      termsAccepted: true,
    });
    const blocked = r.status === 401 || r.status === 403 || r.status === 302;
    record(
      '(G) Unauthenticated POST /api/survey-visits blocked',
      'status=401/403/302',
      `status=${r.status}`,
      blocked,
    );
  }

  {
    const r = await memberClient.delete('/api/survey-visits/999999');
    const blocked = r.status === 401 || r.status === 403 || r.status === 302;
    record(
      '(G) Non-admin DELETE /api/survey-visits/:id blocked',
      'status=403 (or 401/302)',
      `status=${r.status}`,
      blocked,
    );
  }

  {
    const r = await memberClient.post('/api/admin/catalog/handles', { name: 'blocked' });
    const blocked = r.status === 401 || r.status === 403 || r.status === 302;
    record(
      '(G) Non-admin POST /api/admin/catalog/handles blocked',
      'status=403 (or 401/302)',
      `status=${r.status}`,
      blocked,
    );
  }

  // ── (A) Wizard submit flow ─────────────────────────────────────────────────
  console.log('\n  [A] Wizard submit flow');

  const expectedStorageKey = `/uploads/ssv-test-photo-${runId}.jpg`;
  const submitRes = await memberClient.post('/api/survey-visits', {
    contactId:        FAKE_CONTACT_ID,
    contactName:      'SSV Test Customer',
    contactEmail:     'ssv-customer@privtest.local',
    handleId,
    furnitureRangeId: furnitureId,
    visitDate:        new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    durationMin:      90,
    location:         '123 Survey Street',
    notes:            'Automated backend survey-visit test',
    termsAccepted:    true,
    rooms: [
      {
        roomName:               'Kitchen',
        sourceDesignVisitRoomId: null,
        doorStyleId,
        widthMm:                3000,
        heightMm:               2400,
        depthMm:                600,
        unitCount:              8,
        unitPricePence:         15000,
        notes:                  'E2E room note',
        images: [
          { storageKey: expectedStorageKey, mimeType: 'image/jpeg' },
        ],
      },
    ],
    handlerConfig: {},
  });

  record(
    '(A) POST /api/survey-visits returns { ok: true, surveyVisitId }',
    'status=201, ok=true, surveyVisitId is integer',
    `status=${submitRes.status} ok=${submitRes.json?.ok} id=${submitRes.json?.surveyVisitId}`,
    submitRes.status === 201 && submitRes.json?.ok === true && Number.isInteger(submitRes.json?.surveyVisitId),
  );

  const surveyVisitId = submitRes.json?.surveyVisitId ?? null;

  let svRow = null;
  if (surveyVisitId) {
    const q = await pool.query(
      `SELECT id, contact_id, status, signoff_token_hash, signoff_expires_at
       FROM survey_visits WHERE id = $1`,
      [surveyVisitId]
    );
    svRow = q.rows[0] ?? null;
  }

  record(
    '(A) survey_visits row exists after submit with correct contact_id',
    `row id=${surveyVisitId} contact_id=${FAKE_CONTACT_ID}`,
    svRow ? `found id=${svRow.id} contact_id=${svRow.contact_id}` : 'not found',
    svRow !== null && svRow.contact_id === FAKE_CONTACT_ID,
  );

  record(
    '(A) survey_visits.status = "submitted" after side-effect chain',
    'status=submitted',
    `status=${svRow?.status}`,
    svRow?.status === 'submitted',
  );

  record(
    '(A) sign-off token minted (signoff_token_hash non-null, expires in future)',
    'signoff_token_hash set and signoff_expires_at > now()',
    `hash=${svRow?.signoff_token_hash ? 'set' : 'null'} expires=${svRow?.signoff_expires_at}`,
    !!svRow?.signoff_token_hash
      && !!svRow?.signoff_expires_at
      && new Date(svRow.signoff_expires_at) > new Date(),
  );

  let roomRows = [];
  if (surveyVisitId) {
    const q = await pool.query(
      `SELECT id, room_name, unit_count, unit_price_pence, source_design_visit_room_id
       FROM survey_visit_rooms WHERE survey_visit_id = $1`,
      [surveyVisitId]
    );
    roomRows = q.rows;
  }

  record(
    '(A) survey_visit_rooms row exists after submit',
    '1 room row with room_name="Kitchen"',
    `found ${roomRows.length} room(s), first=${roomRows[0]?.room_name}`,
    roomRows.length === 1 && roomRows[0]?.room_name === 'Kitchen',
  );

  let imageRows = [];
  if (roomRows.length > 0) {
    const q = await pool.query(
      `SELECT room_id, storage_key, mime_type
       FROM survey_visit_room_images WHERE room_id = $1`,
      [roomRows[0].id]
    );
    imageRows = q.rows;
  }

  record(
    '(A) survey_visit_room_images row exists with storage_key + mime_type',
    `1 image row storage_key="${expectedStorageKey}" mime_type="image/jpeg"`,
    `found ${imageRows.length} image(s) storage_key=${imageRows[0]?.storage_key} mime_type=${imageRows[0]?.mime_type}`,
    imageRows.length === 1
      && imageRows[0]?.storage_key === expectedStorageKey
      && imageRows[0]?.mime_type === 'image/jpeg',
  );

  // ── (A2) source_design_visit_room_id continuation linkage ──────────────────
  console.log('\n  [A2] Continuation room linkage');

  // Seed a real design_visits + design_visit_rooms row to link against, then
  // submit a survey visit carrying sourceDesignVisitRoomId.
  let sourceRoomId = null;
  try {
    const dv = await pool.query(
      `INSERT INTO design_visits (contact_id, created_by, terms_accepted, status)
       VALUES ($1, $2, TRUE, 'signed_off') RETURNING id`,
      [FAKE_CONTACT_ID, 'privtest-ssv-seed']
    );
    const dvId = dv.rows[0].id;
    const dvr = await pool.query(
      `INSERT INTO design_visit_rooms (design_visit_id, room_name, unit_count, unit_price_pence, sort_order)
       VALUES ($1, 'Kitchen', 1, 0, 0) RETURNING id`,
      [dvId]
    );
    sourceRoomId = dvr.rows[0].id;
  } catch (e) {
    skip('(A2) seed design_visit_rooms source row', 'seeded source room', e.message);
  }

  if (sourceRoomId) {
    const r = await memberClient.post('/api/survey-visits', {
      contactId:     FAKE_CONTACT_ID,
      contactName:   'SSV Test Customer',
      termsAccepted: true,
      rooms: [
        {
          roomName:                'Kitchen (continued)',
          sourceDesignVisitRoomId: sourceRoomId,
          unitCount:               1,
          unitPricePence:          0,
        },
      ],
      handlerConfig: {},
    });
    const newVisitId = r.json?.surveyVisitId ?? null;
    let linkedRoom = null;
    if (newVisitId) {
      const q = await pool.query(
        `SELECT source_design_visit_room_id FROM survey_visit_rooms WHERE survey_visit_id = $1`,
        [newVisitId]
      );
      linkedRoom = q.rows[0] ?? null;
    }
    record(
      '(A2) survey_visit_rooms.source_design_visit_room_id persisted from continuation',
      `source_design_visit_room_id=${sourceRoomId}`,
      `status=${r.status} stored=${linkedRoom?.source_design_visit_room_id}`,
      r.status === 201 && Number(linkedRoom?.source_design_visit_room_id) === Number(sourceRoomId),
    );
  }

  // ── Mint a known sign-off token for the (A) visit so the public flows are
  //    deterministic regardless of email side effects. ────────────────────────
  const rawToken = `ssv-token-${runId}`;
  const expiresFuture = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  if (surveyVisitId) {
    await pool.query(
      `UPDATE survey_visits
       SET signoff_token_hash = $1, signoff_expires_at = $2, status = 'submitted'
       WHERE id = $3`,
      [tokenHash(rawToken), expiresFuture, surveyVisitId]
    );
  }

  // ── (D) Token security ─────────────────────────────────────────────────────
  console.log('\n  [D] Token security');
  {
    const anonClient = makeClient(null);
    const rWrong = await anonClient.get('/api/survey-visits/sign-off/totally-wrong-token');
    record(
      '(D) Wrong token → 404 on GET sign-off',
      'status=404',
      `status=${rWrong.status}`,
      rWrong.status === 404,
    );

    // Expired token on a separate freshly-minted visit
    const rawExpired = `ssv-expired-${runId}`;
    if (surveyVisitId) {
      await pool.query(
        `UPDATE survey_visits
         SET signoff_token_hash = $1, signoff_expires_at = $2
         WHERE id = $3`,
        [tokenHash(rawExpired), new Date(Date.now() - 60_000).toISOString(), surveyVisitId]
      );
      const rExp = await anonClient.get(`/api/survey-visits/sign-off/${rawExpired}`);
      record(
        '(D) Expired token → 410 on GET sign-off',
        'status=410',
        `status=${rExp.status}`,
        rExp.status === 410,
      );
      // restore the valid future token for (B)
      await pool.query(
        `UPDATE survey_visits
         SET signoff_token_hash = $1, signoff_expires_at = $2, status = 'submitted'
         WHERE id = $3`,
        [tokenHash(rawToken), expiresFuture, surveyVisitId]
      );
    }
  }

  // ── (B) Sign-off: approve ──────────────────────────────────────────────────
  console.log('\n  [B] Sign-off approve');
  {
    const anonClient = makeClient(null);
    const rGet = await anonClient.get(`/api/survey-visits/sign-off/${rawToken}`);
    record(
      '(B) GET sign-off summary readable without a session',
      'status=200 with id + rooms array',
      `status=${rGet.status} id=${rGet.json?.id} rooms=${Array.isArray(rGet.json?.rooms) ? rGet.json.rooms.length : 'n/a'}`,
      rGet.status === 200 && rGet.json?.id === surveyVisitId && Array.isArray(rGet.json?.rooms),
    );

    const rApprove = await anonClient.post(`/api/survey-visits/sign-off/${rawToken}`, { action: 'approve' });
    record(
      '(B) POST approve → success, status=signed_off',
      'status=200 success=true status=signed_off',
      `status=${rApprove.status} success=${rApprove.json?.success} st=${rApprove.json?.status}`,
      rApprove.status === 200 && rApprove.json?.success === true && rApprove.json?.status === 'signed_off',
    );

    let approvedRow = null;
    if (surveyVisitId) {
      const q = await pool.query(
        `SELECT status, signoff_token_hash, signed_off_at FROM survey_visits WHERE id = $1`,
        [surveyVisitId]
      );
      approvedRow = q.rows[0] ?? null;
    }
    record(
      '(B) DB: status=signed_off and token nulled after approve',
      'status=signed_off, signoff_token_hash=null, signed_off_at set',
      `status=${approvedRow?.status} hash=${approvedRow?.signoff_token_hash ? 'set' : 'null'} signed=${approvedRow?.signed_off_at ? 'set' : 'null'}`,
      approvedRow?.status === 'signed_off'
        && approvedRow?.signoff_token_hash === null
        && !!approvedRow?.signed_off_at,
    );

    const rReplay = await anonClient.post(`/api/survey-visits/sign-off/${rawToken}`, { action: 'approve' });
    record(
      '(B) Second POST with consumed token → 404 (no replay)',
      'status=404',
      `status=${rReplay.status}`,
      rReplay.status === 404,
    );
  }

  // ── (C) Sign-off: revision + re-submit ─────────────────────────────────────
  console.log('\n  [C] Sign-off revision + re-submit');
  {
    const rawRev = `ssv-rev-${runId}`;
    await pool.query(
      `UPDATE survey_visits
       SET signoff_token_hash = $1, signoff_expires_at = $2, status = 'submitted'
       WHERE id = $3`,
      [tokenHash(rawRev), expiresFuture, surveyVisitId]
    );
    const anonClient = makeClient(null);
    const rRev = await anonClient.post(`/api/survey-visits/sign-off/${rawRev}`, {
      action: 'revision', note: 'Please widen the island',
    });
    record(
      '(C) POST revision → success, status=revision_requested',
      'status=200 success=true status=revision_requested',
      `status=${rRev.status} success=${rRev.json?.success} st=${rRev.json?.status}`,
      rRev.status === 200 && rRev.json?.success === true && rRev.json?.status === 'revision_requested',
    );

    let revRow = null;
    {
      const q = await pool.query(
        `SELECT status, revision_note, signoff_token_hash FROM survey_visits WHERE id = $1`,
        [surveyVisitId]
      );
      revRow = q.rows[0] ?? null;
    }
    record(
      '(C) DB: status=revision_requested, note stored, token nulled',
      'status=revision_requested, revision_note set, token null',
      `status=${revRow?.status} note=${revRow?.revision_note ? 'set' : 'null'} hash=${revRow?.signoff_token_hash ? 'set' : 'null'}`,
      revRow?.status === 'revision_requested'
        && !!revRow?.revision_note
        && revRow?.signoff_token_hash === null,
    );

    const rResubmit = await memberClient.post(`/api/survey-visits/${surveyVisitId}/submit`, { handlerConfig: {} });
    let resubRow = null;
    {
      const q = await pool.query(`SELECT status FROM survey_visits WHERE id = $1`, [surveyVisitId]);
      resubRow = q.rows[0] ?? null;
    }
    record(
      '(C) POST /:id/submit flips revision_requested → submitted',
      'status=200, DB status=submitted',
      `status=${rResubmit.status} dbStatus=${resubRow?.status}`,
      (rResubmit.status === 200 || rResubmit.status === 201) && resubRow?.status === 'submitted',
    );
  }

  // ── (N) Note pre-fill via /api/card-actions/start-design-visit ────────────
  //
  // The survey-visit wizard calls the same start-design-visit card-action
  // endpoint to pre-fill the visit notes field.  We exercise it here with a
  // dev-only HUBSPOT_NOTES_STUB (injected into the server via extraEnv when
  // this server was spawned), which makes fetchLatestContactNote return canned
  // data without touching HubSpot.  A fake HUBSPOT_ACCESS_TOKEN is also passed
  // so requireHubspotToken() does not reject the request.
  console.log('\n  [N] Note pre-fill (POST /api/card-actions/start-design-visit)');

  {
    // Contact whose ID is present in the stub → visitNotes + timestamp returned.
    const r = await memberClient.post('/api/card-actions/start-design-visit', {
      contactId: NOTE_CONTACT_ID,
    });
    record(
      '(N) POST /api/card-actions/start-design-visit returns visitNotes + visitNotesTimestamp for a contact with a note',
      `status=200, visitNotes="${STUB_NOTE_BODY}", visitNotesTimestamp="${STUB_NOTE_TIMESTAMP}"`,
      `status=${r.status} visitNotes=${JSON.stringify(r.json?.visitNotes)} visitNotesTimestamp=${JSON.stringify(r.json?.visitNotesTimestamp)}`,
      r.status === 200
        && r.json?.visitNotes === STUB_NOTE_BODY
        && r.json?.visitNotesTimestamp === STUB_NOTE_TIMESTAMP,
    );
  }

  {
    // Contact whose ID is absent from the stub → both fields are empty strings.
    const r = await memberClient.post('/api/card-actions/start-design-visit', {
      contactId: EMPTY_CONTACT_ID,
    });
    record(
      '(N) POST /api/card-actions/start-design-visit returns empty visitNotes for a contact without notes',
      'status=200, visitNotes="", visitNotesTimestamp=""',
      `status=${r.status} visitNotes=${JSON.stringify(r.json?.visitNotes)} visitNotesTimestamp=${JSON.stringify(r.json?.visitNotesTimestamp)}`,
      r.status === 200
        && r.json?.visitNotes === ''
        && r.json?.visitNotesTimestamp === '',
    );
  }

  // ── (R) Refund flow ────────────────────────────────────────────────────────
  console.log('\n  [R] Refund flow');
  {
    const r = await memberClient.post('/api/survey-visits/refund', {
      contactId:    FAKE_CONTACT_ID,
      contactName:  'SSV Test Customer',
      contactEmail: 'ssv-customer@privtest.local',
      reason:       'Customer changed their mind',
      amountPence:  5000,
      handlerConfig: {},
    });
    record(
      '(R) POST /api/survey-visits/refund returns { ok: true, refundId }',
      'status=201 ok=true refundId integer',
      `status=${r.status} ok=${r.json?.ok} refundId=${r.json?.refundId}`,
      r.status === 201 && r.json?.ok === true && Number.isInteger(r.json?.refundId),
    );

    let refundRow = null;
    if (r.json?.refundId) {
      const q = await pool.query(
        `SELECT status, refund_reason, refund_requested_at FROM survey_visits WHERE id = $1`,
        [r.json.refundId]
      );
      refundRow = q.rows[0] ?? null;
    }
    record(
      '(R) DB: refund row has status=refund_requested + reason + timestamp',
      'status=refund_requested, refund_reason set, refund_requested_at set',
      `status=${refundRow?.status} reason=${refundRow?.refund_reason ? 'set' : 'null'} at=${refundRow?.refund_requested_at ? 'set' : 'null'}`,
      refundRow?.status === 'refund_requested'
        && !!refundRow?.refund_reason
        && !!refundRow?.refund_requested_at,
    );

    const rNoContact = await memberClient.post('/api/survey-visits/refund', { reason: 'x' });
    record(
      '(R) POST refund without contactId → 400',
      'status=400',
      `status=${rNoContact.status}`,
      rNoContact.status === 400,
    );
  }

  // ── Summary & report ───────────────────────────────────────────────────────
  const pass = findings.filter(f => f.ok === true).length;
  const fail = findings.filter(f => f.ok === false && !f.skipped).length;
  const skipped = findings.filter(f => f.ok === null || f.skipped).length;
  const skipSuffix = skipped > 0 ? `, ${skipped} skipped` : '';
  console.log(`\n  Results: ${pass} passed, ${fail} failed${skipSuffix}`);

  await writeReport(runId, findings);
  await cleanupAndExit(fail > 0 ? 1 : 0);
}

// ── Report writer ─────────────────────────────────────────────────────────────
async function writeReport(runId, findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}

  const pass = findings.filter(f => f.ok === true).length;
  const fail = findings.filter(f => f.ok === false && !f.skipped).length;
  const skipped = findings.filter(f => f.ok === null || f.skipped).length;

  const lines = [
    '# Start Survey Visit — backend E2E report',
    '',
    `Run: \`${runId}\``,
    '',
    `**${pass} passed, ${fail} failed, ${skipped} skipped**`,
    '',
    '| Result | Check | Expected | Observed |',
    '| ------ | ----- | -------- | -------- |',
    ...findings.map(f => {
      const result = f.ok ? 'PASS' : f.skipped ? 'SKIP' : 'FAIL';
      const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      return `| ${result} | ${esc(f.name)} | ${esc(f.expected)} | ${esc(f.observed)} |`;
    }),
    '',
    '## Coverage',
    '',
    '- **(API pre-checks)**: Shared catalogue admin endpoints return 200 for admin.',
    '  Public survey sign-off route returns 404 (not 401) for a bad token,',
    '  confirming it is reachable without a session.',
    '- **(G) Privilege gates**: Unauthenticated POST `/api/survey-visits` → 401/403.',
    '  Non-admin DELETE `/api/survey-visits/:id` → 403. Non-admin POST to admin',
    '  catalogue → 403.',
    '- **(A) Wizard submit**: POST `/api/survey-visits` with a seeded contact, one',
    '  room (with an image), seeded handle/range/door. Asserts 201 +',
    '  `{ ok, surveyVisitId }`; confirms DB rows in `survey_visits` (status=submitted,',
    '  sign-off token minted), `survey_visit_rooms`, and `survey_visit_room_images`',
    '  (storage_key + mime_type). HubSpot/QB/email skipped gracefully.',
    '- **(A2) Continuation linkage**: A survey visit carrying',
    '  `sourceDesignVisitRoomId` persists it on the created `survey_visit_rooms` row.',
    '- **(B) Sign-off approve**: GET summary without a session; POST approve flips',
    '  status to `signed_off` and nulls the token; replay POST → 404.',
    '- **(C) Sign-off revision + re-submit**: POST revision flips status to',
    '  `revision_requested` (note stored, token nulled); POST `/:id/submit` flips',
    '  back to `submitted`.',
    '- **(D) Token security**: Wrong token → 404; expired token → 410 (no oracle',
    '  leakage on either GET path).',
    '- **(N) Note pre-fill**: POST `/api/card-actions/start-design-visit` with a',
    '  stubbed contact (via `HUBSPOT_NOTES_STUB` + fake `HUBSPOT_ACCESS_TOKEN`)',
    '  returns the canned `visitNotes` + `visitNotesTimestamp`. A contact absent',
    '  from the stub returns both fields as empty strings. No live HubSpot calls.',
    '- **(R) Refund**: POST `/api/survey-visits/refund` records a `refund_requested`',
    '  row with reason + timestamp; missing `contactId` → 400.',
  ];
  const outPath = path.join(dir, 'start-survey-visit.md');
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  console.log(`  Report written to ${outPath}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(2);
});
