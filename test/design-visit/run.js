'use strict';
const { makeSkip } = require('../helpers/report');
// test/design-visit/run.js
//
// End-to-end live test for the design-visit wizard and sign-off flow
// Mirrors the pattern in test/card-action-handlers/run.js:
// boot a disposable server with the privileges harness, drive the wizard
// with Puppeteer, write a markdown report to test-results/design-visit.md.
//
// Covers:
//   (CRUD)  Admin catalogue CRUD for handles, furniture ranges, door styles
//           and terms-conditions versions.
//   (WIZ)   Wizard dispatch from clicking a bound `.eq-card-action` strip:
//           the start_design_visit handler opens the multi-step wizard.
//   (ROOM)  Room add / remove UI validation in step 2 of the wizard
//           (add button appends a card; remove drops a card; the "Every room
//           needs a name" guard fires when a room is missing its name; the
//           Remove button is hidden when only one room remains).
//   (SUB)   POST /api/design-visits side-effect chain: 201 with
//           designVisitId, status transitions to 'submitted', QB skipped
//           non-fatally (qb_estimate_id NULL, no chain error logged), email
//           transport absent (silent skip).
//   (TOK)   sign-off token is generated and pinned to a 7-day expiry.
//   (PUB)   Public sign-off API: GET /api/design-visits/sign-off/:token
//           returns the visit, POST approve flips status to signed_off and
//           invalidates the token, POST revision flips status to
//           revision_requested and invalidates the token.
//
// API pre-checks run before any browser tab opens so failures in the API
// surface clearly.  Existing deeper-coverage probes for sign-off token
// security, multi-room images, T&C version pinning, BroadcastChannel
// catalogue refresh, etc. live in test/start-design-visit/run.js — this
// suite is intentionally focused on the wizard-UI and sign-off flow.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:design-visit
//   # or against the shared DB with the privtest- prefix cleanup:
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:design-visit

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
  BASE,
} = require('../privileges/harness');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

require('dotenv').config();

const { pollUntil, pollFn } = require('../helpers/poll');

// ── fixtures ──────────────────────────────────────────────────────────────────
const RUN_PREFIX     = 'privtest-dv-';
const FAKE_CONTACT_ID = 'privtest-dv-contact';

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

function tokenHash(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

async function purgeFixtures(pool) {
  // Wipe synthetic catalogue rows / design visits.  Cascading FKs will clean
  // up design_visit_rooms / design_visit_room_images / handler bindings.
  try {
    await pool.query(`DELETE FROM design_visits WHERE contact_id LIKE 'privtest-dv-%'`);
  } catch {}
  try {
    await pool.query(`DELETE FROM card_action_handlers WHERE name LIKE 'PrivTest DV %'`);
  } catch {}
  try {
    await pool.query(`DELETE FROM catalog_handles  WHERE name LIKE 'privtest-dv-%'`);
  } catch {}
  try {
    await pool.query(`DELETE FROM catalog_ranges   WHERE name LIKE 'privtest-dv-%'`);
  } catch {}
  try {
    await pool.query(`DELETE FROM catalog_doors    WHERE name LIKE 'privtest-dv-%'`);
  } catch {}
  try {
    await pool.query(`DELETE FROM visit_questions  WHERE label LIKE 'privtest-dv-%'`);
  } catch {}
  try {
    await pool.query(`DELETE FROM terms_conditions_versions     WHERE terms_text LIKE 'privtest-dv-%'`);
  } catch {}
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
  console.log(`\n  design-visit E2E  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);

  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  admin=${users.admin.email}  member=${users.member.email}`);

  const { child, logBuf } = spawnServer({
    // Stub @replit/object-storage so the upload + signed-image-serve probes
    // run without a real Replit bucket. The preload hooks Module._resolve
    // before server.js loads, so design-visit-uploads.js's lazy
    // `require('@replit/object-storage')` resolves to an in-memory client.
    nodeOptions: `--require ${path.resolve(__dirname, 'preload-object-storage-stub.js')}`,
  });
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

  // Wait for design-visit tables to be created (async on boot)
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
    waitForTable('design_visits'),
    waitForTable('design_visit_rooms'),
    waitForTable('visit_questions'),
    waitForTable('visit_answers'),
    waitForTable('terms_conditions_versions'),
    waitForTable('card_action_handlers'),
  ]);
  console.log('  All catalogue / design_visit tables ready');

  await purgeFixtures(pool);

  const adminClient  = await login(users.admin.email,  users.admin.password);
  const memberClient = await login(users.member.email, users.member.password);
  const anonClient   = makeClient(null);

  // ════════════════════════════════════════════════════════════════════════════
  // [API] Pre-checks
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n  [API] Pre-checks');

  for (const [label, p] of [
    ['GET /api/admin/catalog/handles', '/api/admin/catalog/handles'],
    ['GET /api/admin/catalog/ranges',  '/api/admin/catalog/ranges'],
    ['GET /api/admin/catalog/doors',   '/api/admin/catalog/doors'],
    ['GET /api/admin/terms-conditions/versions', '/api/admin/terms-conditions/versions'],
  ]) {
    const r = await adminClient.get(p);
    record(
      `[API] ${label} responds for admin`,
      'status=200, JSON array',
      `status=${r.status} type=${Array.isArray(r.json) ? 'array' : typeof r.json}`,
      r.status === 200 && Array.isArray(r.json),
    );
  }

  {
    const r = await anonClient.get('/api/design-visits/sign-off/nosuchtoken');
    record(
      '[API] GET /api/design-visits/sign-off/:token is public (404 not 401)',
      'status=404',
      `status=${r.status}`,
      r.status === 404,
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // [CRUD] Admin catalogue CRUD
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n  [CRUD] Admin catalogue CRUD');

  // -- handles --
  const handleName  = `${RUN_PREFIX}handle-${runId}`;
  const handleNameU = `${handleName}-updated`;
  const hCreate = await adminClient.post('/api/admin/catalog/handles',
    { name: handleName, description: 'created', sort_order: 9990, style: 'Bar' });
  record('[CRUD] POST /api/admin/catalog/handles creates row',
    'status=201, integer id', `status=${hCreate.status} id=${hCreate.json?.id}`,
    hCreate.status === 201 && Number.isInteger(hCreate.json?.id));
  const handleId = hCreate.json?.id ?? null;

  if (handleId) {
    const hPatch = await adminClient.patch(`/api/admin/catalog/handles/${handleId}`,
      { name: handleNameU });
    record('[CRUD] PATCH /api/admin/catalog/handles/:id renames row',
      `status=200, name="${handleNameU}"`,
      `status=${hPatch.status} name=${hPatch.json?.name}`,
      hPatch.status === 200 && hPatch.json?.name === handleNameU);

    const hList = await adminClient.get('/api/admin/catalog/handles');
    const hHit  = Array.isArray(hList.json) && hList.json.find(x => x.id === handleId);
    record('[CRUD] GET /api/admin/catalog/handles includes updated row',
      `row id=${handleId} with name="${handleNameU}" in list`,
      hHit ? `found name=${hHit.name}` : 'not found in list',
      !!hHit && hHit.name === handleNameU);
  } else {
    for (const lbl of [
      '[CRUD] PATCH /api/admin/catalog/handles/:id renames row',
      '[CRUD] GET /api/admin/catalog/handles includes updated row',
    ]) skip(lbl, 'handle created in previous step', 'create failed');
  }

  // -- furniture ranges --
  const furnitureName  = `${RUN_PREFIX}fr-${runId}`;
  const fCreate = await adminClient.post('/api/admin/catalog/ranges',
    { name: furnitureName, sort_order: 9991 });
  record('[CRUD] POST /api/admin/catalog/ranges creates row',
    'status=201, integer id', `status=${fCreate.status} id=${fCreate.json?.id}`,
    fCreate.status === 201 && Number.isInteger(fCreate.json?.id));
  const furnitureId = fCreate.json?.id ?? null;

  // -- door styles --
  const doorStyleName = `${RUN_PREFIX}ds-${runId}`;
  const dCreate = await adminClient.post('/api/admin/catalog/doors',
    { name: doorStyleName, sort_order: 9992 });
  record('[CRUD] POST /api/admin/catalog/doors creates row',
    'status=201, integer id', `status=${dCreate.status} id=${dCreate.json?.id}`,
    dCreate.status === 201 && Number.isInteger(dCreate.json?.id));
  const doorStyleId = dCreate.json?.id ?? null;

  // -- terms-conditions versions --
  const tcvText = `${RUN_PREFIX}tcv-${runId} — terms text for design-visit E2E`;
  const tcvRes  = await adminClient.post('/api/admin/terms-conditions/versions',
    { terms_text: tcvText });
  record('[CRUD] POST /api/admin/terms-conditions/versions publishes a version',
    'status=201, integer id and version_number',
    `status=${tcvRes.status} id=${tcvRes.json?.id} v=${tcvRes.json?.version_number}`,
    tcvRes.status === 201 && Number.isInteger(tcvRes.json?.id) && Number.isInteger(tcvRes.json?.version_number));
  const tcvId = tcvRes.json?.id ?? null;

  // -- room-scoped visit question (drives the per-room answer round-trip) --
  const roomQuestionLabel = `${RUN_PREFIX}room-q-${runId}`;
  const vqRes = await adminClient.post('/api/admin/visit-questions',
    { label: roomQuestionLabel, scope: 'room', type: 'text', applies_to: ['design'], active: true, sort_order: 9993 });
  record('[CRUD] POST /api/admin/visit-questions creates a room-scoped question',
    'status=201, integer id, scope="room"',
    `status=${vqRes.status} id=${vqRes.json?.id} scope=${vqRes.json?.scope}`,
    vqRes.status === 201 && Number.isInteger(vqRes.json?.id) && vqRes.json?.scope === 'room');
  const roomQuestionId = vqRes.json?.id ?? null;

  // -- privilege gate: member POST to admin catalogue → 403 --
  {
    const r = await memberClient.post('/api/admin/catalog/handles', { name: 'blocked' });
    const blocked = r.status === 401 || r.status === 403 || r.status === 302;
    record('[CRUD] Non-admin POST /api/admin/catalog/handles is blocked',
      'status=403 (or 401/302)', `status=${r.status}`, blocked);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // [SUB] POST /api/design-visits — side-effect chain
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n  [SUB] POST /api/design-visits side-effect chain');

  const submitRes = await memberClient.post('/api/design-visits', {
    contactId:        FAKE_CONTACT_ID,
    contactName:      'DV Test Customer',
    contactEmail:     'dv-customer@privtest.local',
    handleId,
    furnitureRangeId: furnitureId,
    visitDate:        new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
    durationMin:      90,
    location:         '123 Test Street',
    notes:            'design-visit E2E',
    termsAccepted:    true,
    rooms: [{
      roomName: 'Kitchen', doorStyleId, widthMm: 3000, heightMm: 2400, depthMm: 600,
      unitCount: 8, unitPricePence: 15000, notes: 'kitchen note',
      answers: roomQuestionId
        ? [{ question_id: roomQuestionId, answer: 'shaker-white' }]
        : [],
    }],
    handlerConfig: {},
  });

  record('[SUB] POST /api/design-visits returns 201 with designVisitId',
    'status=201, ok=true, integer designVisitId',
    `status=${submitRes.status} ok=${submitRes.json?.ok} id=${submitRes.json?.designVisitId}`,
    submitRes.status === 201 && submitRes.json?.ok === true && Number.isInteger(submitRes.json?.designVisitId));
  const designVisitId = submitRes.json?.designVisitId ?? null;

  // Allow the async side-effect chain to settle
  await new Promise(r => setTimeout(r, 700));

  let dvRow = null;
  if (designVisitId) {
    const q = await pool.query(
      `SELECT id, status, signoff_token_hash, signoff_expires_at, qb_estimate_id
       FROM design_visits WHERE id = $1`, [designVisitId]);
    dvRow = q.rows[0] ?? null;
  }

  record('[SUB] status transitions to "submitted" after side-effect chain',
    'status=submitted',
    `status=${dvRow?.status}`,
    dvRow?.status === 'submitted');

  record('[SUB] QB estimate skipped non-fatally (no credentials → qb_estimate_id NULL)',
    'qb_estimate_id IS NULL',
    `qb_estimate_id=${dvRow?.qb_estimate_id ?? 'NULL'}`,
    (dvRow?.qb_estimate_id ?? null) === null);

  {
    const logs = logBuf.join('');
    const chainErr = logs.includes('[design-visits] Side effect chain error');
    record('[SUB] Side-effect chain completed without fatal error in server log',
      'no "[design-visits] Side effect chain error" entry',
      chainErr ? 'FAIL: chain error logged' : 'no chain error logged',
      !chainErr);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // [ANS] Per-room questionnaire answer round-trip (create → read)
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n  [ANS] Per-room questionnaire answer round-trip');

  if (designVisitId && roomQuestionId) {
    const r = await memberClient.get(`/api/design-visits/${designVisitId}/answers`);
    const rows = Array.isArray(r.json) ? r.json : [];
    const hit  = rows.find(a => a.question_id === roomQuestionId);
    record('[ANS] room-scoped answer submitted with the visit round-trips via GET /answers',
      `status=200, an answer for question ${roomQuestionId} with room_id set and answer="shaker-white"`,
      `status=${r.status} hit=${hit ? `room_id=${hit.room_id} answer=${JSON.stringify(hit.answer)}` : 'not found'}`,
      r.status === 200 && !!hit && hit.room_id != null && hit.answer === 'shaker-white');
  } else {
    skip('[ANS] room-scoped answer submitted with the visit round-trips via GET /answers',
      'visit + room question created in previous steps',
      designVisitId ? 'room question create failed' : 'visit submit failed');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // [TOK] sign-off token generation
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n  [TOK] Sign-off token generation');

  record('[TOK] signoff_token_hash is generated by the submit side-effect chain',
    'signoff_token_hash IS NOT NULL',
    `signoff_token_hash=${dvRow?.signoff_token_hash ? 'set' : 'NULL'}`,
    !!dvRow?.signoff_token_hash);

  {
    const exp = dvRow?.signoff_expires_at ? new Date(dvRow.signoff_expires_at) : null;
    const inFuture = exp && exp > new Date();
    // 7-day expiry — allow a 12h fudge window
    const daysAhead = exp ? (exp - new Date()) / 86400000 : 0;
    const sevenDayish = daysAhead > 6.5 && daysAhead < 7.5;
    record('[TOK] signoff_expires_at is set ~7 days in the future',
      '6.5 < days-from-now < 7.5',
      `signoff_expires_at=${dvRow?.signoff_expires_at} (days=${daysAhead.toFixed(2)})`,
      inFuture && sevenDayish);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // [PUB] Public sign-off — APPROVE flow
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n  [PUB] Public sign-off — approve');

  // Inject a known token for the existing visit (side-effect chain generates an
  // unguessable raw token we cannot read back), then exercise GET → POST(approve).
  const approveRaw = `${RUN_PREFIX}approve-tok-${runId}`;
  if (designVisitId) {
    await pool.query(
      `UPDATE design_visits
         SET status='submitted',
             signoff_token_hash=$1,
             signoff_expires_at=$2,
             signed_off_at=NULL,
             updated_at=NOW()
       WHERE id=$3`,
      [tokenHash(approveRaw),
       new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
       designVisitId],
    );
  }

  {
    const r = await anonClient.get(`/api/design-visits/sign-off/${approveRaw}`);
    record('[PUB] GET /api/design-visits/sign-off/:token returns the visit (public, no session)',
      'status=200, JSON body with id and rooms array',
      `status=${r.status} id=${r.json?.id} rooms=${Array.isArray(r.json?.rooms) ? r.json.rooms.length : 'N/A'}`,
      r.status === 200 && r.json?.id === designVisitId && Array.isArray(r.json?.rooms) && r.json.rooms.length === 1);
  }

  {
    const r = await anonClient.post(`/api/design-visits/sign-off/${approveRaw}`,
      { action: 'approve' });
    record('[PUB] POST /api/design-visits/sign-off/:token { action: "approve" } succeeds',
      'status=200, success=true, status="signed_off"',
      `status=${r.status} success=${r.json?.success} status=${r.json?.status}`,
      r.status === 200 && r.json?.success === true && r.json?.status === 'signed_off');
  }

  let afterApprove = null;
  if (designVisitId) {
    const q = await pool.query(
      `SELECT status, signoff_token_hash, signed_off_at
         FROM design_visits WHERE id=$1`, [designVisitId]);
    afterApprove = q.rows[0] ?? null;
  }
  record('[PUB] approve flips status to "signed_off" and invalidates the token',
    'status=signed_off, signoff_token_hash=NULL, signed_off_at IS NOT NULL',
    `status=${afterApprove?.status} token=${afterApprove?.signoff_token_hash ? 'set' : 'NULL'} signed_off_at=${afterApprove?.signed_off_at ? 'set' : 'NULL'}`,
    afterApprove?.status === 'signed_off'
      && !afterApprove?.signoff_token_hash
      && !!afterApprove?.signed_off_at);

  {
    // Token must now 404 (consumed)
    const r = await anonClient.get(`/api/design-visits/sign-off/${approveRaw}`);
    record('[PUB] consumed approve token returns 404 on re-use',
      'status=404',
      `status=${r.status}`,
      r.status === 404);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // [PUB] Public sign-off — REVISION flow
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n  [PUB] Public sign-off — revision');

  // Re-submit the same visit so we have a fresh submitted state, then inject
  // a new raw token and exercise POST(revision).
  const revisionRaw = `${RUN_PREFIX}revision-tok-${runId}`;
  if (designVisitId) {
    await pool.query(
      `UPDATE design_visits
         SET status='submitted',
             signoff_token_hash=$1,
             signoff_expires_at=$2,
             signed_off_at=NULL,
             revision_note=NULL,
             updated_at=NOW()
       WHERE id=$3`,
      [tokenHash(revisionRaw),
       new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
       designVisitId],
    );
  }

  {
    const r = await anonClient.post(`/api/design-visits/sign-off/${revisionRaw}`,
      { action: 'revision', note: 'Please change the door style.' });
    record('[PUB] POST /api/design-visits/sign-off/:token { action: "revision" } succeeds',
      'status=200, success=true, status="revision_requested"',
      `status=${r.status} success=${r.json?.success} status=${r.json?.status}`,
      r.status === 200 && r.json?.success === true && r.json?.status === 'revision_requested');
  }

  let afterRevision = null;
  if (designVisitId) {
    const q = await pool.query(
      `SELECT status, signoff_token_hash, revision_note
         FROM design_visits WHERE id=$1`, [designVisitId]);
    afterRevision = q.rows[0] ?? null;
  }
  record('[PUB] revision flips status to "revision_requested", saves note, invalidates token',
    'status=revision_requested, signoff_token_hash=NULL, revision_note saved',
    `status=${afterRevision?.status} token=${afterRevision?.signoff_token_hash ? 'set' : 'NULL'} note=${JSON.stringify(afterRevision?.revision_note)}`,
    afterRevision?.status === 'revision_requested'
      && !afterRevision?.signoff_token_hash
      && afterRevision?.revision_note === 'Please change the door style.');

  {
    // After a revision is accepted, the prior hash is moved into
    // superseded_signoff_token_hashes and POST replies 409 + status="superseded"
    // (so a customer who re-submits via a cached form sees a "your designer is
    // making changes" notice rather than a generic 404).
    const r = await anonClient.post(`/api/design-visits/sign-off/${revisionRaw}`,
      { action: 'approve' });
    record('[PUB] revision-consumed token returns 409 superseded on re-use',
      'status=409, body.status="superseded"',
      `status=${r.status} body.status=${r.json?.status}`,
      r.status === 409 && r.json?.status === 'superseded');
  }

  // POST with bogus action
  {
    const r = await anonClient.post(`/api/design-visits/sign-off/anything`,
      { action: 'unknown' });
    record('[PUB] POST with unknown action is rejected',
      'status=400 with error message',
      `status=${r.status} err=${r.json?.error || ''}`,
      r.status === 400);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // [PHOTO] Cloud-hosted room photos — upload + signed serve + visit round-trip
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n  [PHOTO] Upload + signed-image serve');

  // 1×1 transparent PNG.
  const TINY_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_B64}`;

  // (A) Upload a 1×1 PNG via the wizard endpoint.
  let uploadStorageKey = null;
  let uploadViewUrl = null;
  {
    const r = await memberClient.post('/api/design-visits/uploads', { dataUrl: TINY_PNG_DATA_URL });
    const ok = r.status === 200
      && typeof r.json?.storageKey === 'string'
      && /^obj:[A-Za-z0-9_-]+\.png$/.test(r.json.storageKey)
      && typeof r.json?.viewUrl === 'string'
      && /^\/api\/design-visit-images\/obj%3A[A-Za-z0-9_.-]+\?exp=\d+&sig=[a-f0-9]{64}$/.test(r.json.viewUrl);
    record('[PHOTO] POST /api/design-visits/uploads stores object and returns signed viewUrl',
      'status=200, storageKey=obj:<id>.png, viewUrl=/api/design-visit-images/...?exp=&sig=',
      `status=${r.status} storageKey=${r.json?.storageKey} viewUrl=${r.json?.viewUrl ? 'set' : 'NULL'}`,
      ok);
    if (ok) {
      uploadStorageKey = r.json.storageKey;
      uploadViewUrl    = r.json.viewUrl;
    }
  }

  // (B) Fetching the signed viewUrl returns the bytes with image/png CT.
  if (uploadViewUrl) {
    const r = await fetch(`${BASE}${uploadViewUrl}`);
    const ct  = r.headers.get('content-type') || '';
    const buf = Buffer.from(await r.arrayBuffer());
    const bytesOk = buf.length > 0 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    record('[PHOTO] GET signed image URL returns PNG bytes with content-type image/png',
      'status=200, content-type=image/png, body starts with PNG magic bytes',
      `status=${r.status} ct=${ct} bytes=${buf.length} pngMagic=${bytesOk}`,
      r.status === 200 && /^image\/png/.test(ct) && bytesOk);
  } else {
    record('[PHOTO] GET signed image URL returns PNG bytes with content-type image/png',
      'depends on upload succeeding', 'upload failed', false);
  }

  // (C) Tampered signature → 403.
  if (uploadViewUrl) {
    const tampered = uploadViewUrl.replace(/sig=([a-f0-9]+)/, (_, s) =>
      'sig=' + (s[0] === '0' ? '1' : '0') + s.slice(1));
    const r = await fetch(`${BASE}${tampered}`);
    record('[PHOTO] GET signed image URL with tampered signature → 403',
      'status=403', `status=${r.status}`, r.status === 403);
  } else {
    record('[PHOTO] GET signed image URL with tampered signature → 403',
      'depends on upload succeeding', 'upload failed', false);
  }

  // (D) Expired signature (correctly signed with a past exp) → 403.
  // Mints the same HMAC the server does, so this proves the time-window check
  // is enforced (not just the signature check).
  if (uploadStorageKey) {
    const sessionSecret = process.env.SESSION_SECRET;
    if (!sessionSecret) {
      record('[PHOTO] GET signed image URL with expired exp (validly signed) → 403',
        'SESSION_SECRET set so the test can mint an expired signature',
        'SESSION_SECRET missing in test env', false);
    } else {
      const pastExp = Math.floor(Date.now() / 1000) - 60;
      const sig = crypto.createHmac('sha256', sessionSecret)
        .update(`${uploadStorageKey}|${pastExp}`)
        .digest('hex');
      const url = `/api/design-visit-images/${encodeURIComponent(uploadStorageKey)}?exp=${pastExp}&sig=${sig}`;
      const r = await fetch(`${BASE}${url}`);
      record('[PHOTO] GET signed image URL with expired exp (validly signed) → 403',
        'status=403 because the exp timestamp is in the past',
        `status=${r.status}`,
        r.status === 403);
    }
  } else {
    record('[PHOTO] GET signed image URL with expired exp (validly signed) → 403',
      'depends on upload succeeding', 'upload failed', false);
  }

  // (E) Non-image data URL → 400.
  {
    const r = await memberClient.post('/api/design-visits/uploads',
      { dataUrl: 'data:text/plain;base64,aGVsbG8=' });
    record('[PHOTO] POST /api/design-visits/uploads with non-image data URL → 400',
      'status=400 with JSON error', `status=${r.status} err=${JSON.stringify(r.json?.error)}`,
      r.status === 400 && typeof r.json?.error === 'string');
  }

  // (F) Oversized upload (>10MB) → 400.
  // MAX_UPLOAD_BYTES in design-visit-uploads.js is 10 MB; express.json caps
  // the body at 15 MB. 10.5 MB of raw bytes (~14 MB base64) sits comfortably
  // between those two so the request reaches parseDataUrl, which then rejects
  // it for exceeding MAX_UPLOAD_BYTES.
  {
    const big = Buffer.alloc(10.5 * 1024 * 1024).toString('base64');
    const r = await memberClient.post('/api/design-visits/uploads',
      { dataUrl: `data:image/png;base64,${big}` });
    record('[PHOTO] POST /api/design-visits/uploads with oversized image → 4xx',
      'status in 4xx (parseDataUrl rejects buf.length > MAX_UPLOAD_BYTES)',
      `status=${r.status}`,
      r.status >= 400 && r.status < 500);
  }

  // (G) Round-trip a storage key through POST /api/design-visits → load the
  // visit and assert the DB stores `obj:` and the API returns a signed URL.
  if (uploadStorageKey && handleId && furnitureId && doorStyleId) {
    const photoVisit = await memberClient.post('/api/design-visits', {
      contactId:        `${FAKE_CONTACT_ID}-photo`,
      contactName:      'DV Photo Customer',
      contactEmail:     'dv-photo-customer@privtest.local',
      handleId, furnitureRangeId: furnitureId,
      visitDate: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
      durationMin: 90, location: '1 Photo Lane', notes: '[PHOTO] round-trip',
      termsAccepted: true,
      rooms: [{
        roomName: 'Kitchen', doorStyleId,
        widthMm: 3000, heightMm: 2400, depthMm: 600,
        unitCount: 1, unitPricePence: 9900,
        images: [{ storageKey: uploadStorageKey, mimeType: 'image/png' }],
      }],
      handlerConfig: {},
    });
    const photoVisitId = photoVisit.json?.designVisitId;
    record('[PHOTO] POST /api/design-visits with a storageKey-bearing room → 201',
      'status=201, ok=true, integer designVisitId',
      `status=${photoVisit.status} id=${photoVisitId}`,
      photoVisit.status === 201 && Number.isInteger(photoVisitId));

    if (Number.isInteger(photoVisitId)) {
      const dbRow = await pool.query(`
        SELECT dvri.storage_key
        FROM design_visit_room_images dvri
        JOIN design_visit_rooms dvr ON dvr.id = dvri.room_id
        WHERE dvr.design_visit_id = $1`, [photoVisitId]);
      const dbKey = dbRow.rows[0]?.storage_key;
      record('[PHOTO] design_visit_room_images.storage_key persists the obj: key',
        `storage_key === "${uploadStorageKey}"`,
        `storage_key=${dbKey}`,
        dbKey === uploadStorageKey);

      const getR = await memberClient.get(`/api/design-visits/${photoVisitId}`);
      const room = getR.json?.rooms?.[0];
      const img  = room?.images?.[0];
      const sigUrlOk = typeof img?.viewUrl === 'string'
        && /^\/api\/design-visit-images\/obj%3A[A-Za-z0-9_.-]+\?exp=\d+&sig=[a-f0-9]{64}$/.test(img.viewUrl);
      record('[PHOTO] GET /api/design-visits/:id returns image.viewUrl as a signed /api/design-visit-images/... URL',
        'rooms[0].images[0].viewUrl matches /api/design-visit-images/<key>?exp=&sig=<64 hex>',
        `viewUrl=${img?.viewUrl}`,
        getR.status === 200 && sigUrlOk);

      if (sigUrlOk) {
        const r2 = await fetch(`${BASE}${img.viewUrl}`);
        record('[PHOTO] viewUrl from GET /api/design-visits/:id resolves to the uploaded PNG bytes',
          'status=200, content-type=image/png',
          `status=${r2.status} ct=${r2.headers.get('content-type')}`,
          r2.status === 200 && /^image\/png/.test(r2.headers.get('content-type') || ''));
      } else {
        record('[PHOTO] viewUrl from GET /api/design-visits/:id resolves to the uploaded PNG bytes',
          'depends on prior probe', 'viewUrl shape failed', false);
      }
    } else {
      for (const lbl of [
        '[PHOTO] design_visit_room_images.storage_key persists the obj: key',
        '[PHOTO] GET /api/design-visits/:id returns image.viewUrl as a signed /api/design-visit-images/... URL',
        '[PHOTO] viewUrl from GET /api/design-visits/:id resolves to the uploaded PNG bytes',
      ]) skip(lbl, 'depends on visit creation', 'visit creation failed');
    }
  } else {
    for (const lbl of [
      '[PHOTO] POST /api/design-visits with a storageKey-bearing room → 201',
      '[PHOTO] design_visit_room_images.storage_key persists the obj: key',
      '[PHOTO] GET /api/design-visits/:id returns image.viewUrl as a signed /api/design-visit-images/... URL',
      '[PHOTO] viewUrl from GET /api/design-visits/:id resolves to the uploaded PNG bytes',
    ]) skip(lbl, 'depends on upload + catalogue rows', 'prerequisites missing');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // [WIZ] + [ROOM] — wizard dispatch from a card action and room add/remove
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n  [WIZ/ROOM] Wizard dispatch + room add/remove validation');

  const WIZ_LABELS = [
    '[WIZ] Clicking bound .eq-card-action of type=start_design_visit opens .dv-wizard-backdrop',
    '[WIZ] Step 1 Next without terms shows "terms and conditions" error',
    '[WIZ] Accepting terms advances to step 2 (#dv-add-room visible)',
    '[ROOM] Step 2 initially shows exactly 1 .dv-room-card with no Remove button',
    '[ROOM] Clicking #dv-add-room once yields 2 .dv-room-card with 2 .dv-rm-room buttons',
    '[ROOM] Clicking #dv-add-room a second time yields 3 .dv-room-card with 3 .dv-rm-room buttons',
    '[ROOM] Clicking .dv-rm-room reduces the rendered card count',
    '[ROOM] Review with an empty room name shows "Every room needs a name" error (fresh wizard)',
    '[ROOM] Filling the room name lets Review advance to step 3 (#dv-submit visible)',
  ];

  if (!puppeteer) {
    for (const l of WIZ_LABELS) skip(l, 'puppeteer installed', 'puppeteer not installed');
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
      for (const l of WIZ_LABELS) skip(l, 'browser launched', `browser launch failed: ${msg}`);
    } else {
      try {
        // Seed a start_design_visit handler bound to a placeholder label so we
        // can render an .eq-card-action element with the matching attributes.
        const handlerInsert = await pool.query(
          `INSERT INTO card_action_handlers (name, type, config)
           VALUES ($1, 'start_design_visit',
                   '{"defaultTitle":"Start design visit","defaultDurationMin":90}'::jsonb)
           RETURNING id`,
          [`PrivTest DV wizard-dispatch ${runId}`],
        );
        const handlerId = handlerInsert.rows[0].id;

        const salesTab = await browser.newPage();
        await salesTab.setCacheEnabled(false);
        const pageLogs = [];
        salesTab.on('console',     m => pageLogs.push(`[${m.type()}] ${m.text()}`));
        salesTab.on('pageerror',   e => pageLogs.push(`[pageerror] ${e.message}`));
        salesTab.on('requestfailed', r => pageLogs.push(`[reqfailed] ${r.url()} ${r.failure()?.errorText || ''}`));
        await injectSession(salesTab, adminClient.cookie);
        const navResp = await salesTab.goto(`${BASE}/sales`, { waitUntil: 'domcontentloaded', timeout: 25000 });
        const navStatus = navResp?.status();

        // Wait for card-action-handlers.js to expose dispatchCardActionHandler.
        const handlersReady = await pollPage(salesTab,
          () => typeof window.dispatchCardActionHandler === 'function',
          null, 10000);
        if (!handlersReady) {
          console.log(`     [debug] nav status=${navStatus}`);
          console.log(`     [debug] page logs:\n${pageLogs.slice(0, 30).join('\n')}`);
        }

        // Inject a bound .eq-card-action element and click it. This is the
        // same dispatch path the real Sales card strip uses — the click
        // listener on .eq-card-action looks up the handler by id and routes
        // start_design_visit to openDesignVisitWizard().
        await salesTab.evaluate((hid) => {
          const div = document.createElement('div');
          div.className = 'eq-card-action';
          div.setAttribute('data-card-action-handler-id', String(hid));
          div.setAttribute('data-card-action-handler-type', 'start_design_visit');
          div.setAttribute('data-card-action-contact-id',    'privtest-dv-wiz');
          div.setAttribute('data-card-action-contact-name',  'Wiz Test');
          div.setAttribute('data-card-action-contact-email', 'wiz@privtest.local');
          div.style.cssText = 'position:fixed;top:8px;left:8px;padding:6px;background:#eef;z-index:9999;';
          div.id = 'dv-wiz-trigger';
          div.textContent = 'open wizard';
          document.body.appendChild(div);
          div.click();
        }, handlerId);

        const opened = await pollPage(salesTab,
          () => !!document.querySelector('.dv-wizard-backdrop')
                && !!document.querySelector('#dv-terms')
                ? 'open' : null,
          null, 8000);
        record(WIZ_LABELS[0],
          '.dv-wizard-backdrop appears and step-1 #dv-terms checkbox is visible',
          opened ? 'wizard backdrop + step 1 visible' : 'wizard did not open within 8 s',
          opened === 'open');

        // Helper: open a fresh wizard via the injected trigger and advance to
        // step 2 (terms accepted).  Returns true if step 2 rendered.
        const openWizardToStep2 = async () => {
          await salesTab.evaluate(() => {
            document.querySelector('.dv-wizard-backdrop')?.remove();
            document.getElementById('dv-wiz-trigger')?.click();
          });
          const onStep1 = await pollPage(salesTab,
            () => document.querySelector('#dv-terms') ? 'ok' : null, null, 6000);
          if (!onStep1) return false;
          await salesTab.evaluate(() => {
            const t = document.querySelector('#dv-terms');
            if (t) { t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true })); }
            const btns = Array.from(document.querySelectorAll('.dv-wizard .dv-btn-next'));
            const next = btns.find(b => /Next/i.test(b.textContent || ''));
            if (next) next.click();
          });
          const onStep2 = await pollPage(salesTab,
            () => document.querySelector('#dv-add-room') ? 'ok' : null, null, 6000);
          return onStep2 === 'ok';
        };

        if (opened !== 'open') {
          for (let i = 1; i < WIZ_LABELS.length; i++) {
            skip(WIZ_LABELS[i], 'depends on wizard opening', 'wizard did not open');
          }
        } else {
          // (1) Step-1 Next without terms → inline error
          const errText = await salesTab.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('.dv-wizard .dv-btn-next'));
            const next = btns.find(b => /Next/i.test(b.textContent || ''));
            if (next) next.click();
            return (document.querySelector('#dv-s1-err')?.textContent || '').trim();
          });
          record(WIZ_LABELS[1],
            '#dv-s1-err contains "terms and conditions"',
            `errText=${JSON.stringify(errText)}`,
            /terms and conditions/i.test(errText));

          // (2) Accept terms → step 2
          await salesTab.evaluate(() => {
            const t = document.querySelector('#dv-terms');
            if (t) { t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true })); }
            const btns = Array.from(document.querySelectorAll('.dv-wizard .dv-btn-next'));
            const next = btns.find(b => /Next/i.test(b.textContent || ''));
            if (next) next.click();
          });
          const step2 = await pollPage(salesTab,
            () => !!document.querySelector('#dv-add-room') ? 'on-step-2' : null,
            null, 6000);
          record(WIZ_LABELS[2],
            '#dv-add-room button is visible (step 2 rendered)',
            step2 ? 'step 2 visible' : 'step 2 did not render within 6 s',
            step2 === 'on-step-2');

          if (step2 !== 'on-step-2') {
            for (let i = 3; i < WIZ_LABELS.length; i++) {
              skip(WIZ_LABELS[i], 'depends on step 2 rendering', 'step 2 did not render');
            }
          } else {
            // (3) Initial state: 1 card, no Remove button
            const initial = await salesTab.evaluate(() => ({
              cards:   document.querySelectorAll('.dv-room-card').length,
              remBtns: document.querySelectorAll('.dv-rm-room').length,
            }));
            record(WIZ_LABELS[3],
              'cards=1, remBtns=0',
              `cards=${initial.cards}, remBtns=${initial.remBtns}`,
              initial.cards === 1 && initial.remBtns === 0);

            // (4) Click Add Room once → 2 cards, 2 Remove buttons
            await salesTab.evaluate(() => document.querySelector('#dv-add-room')?.click());
            const after1add = await pollPage(salesTab,
              () => document.querySelectorAll('.dv-room-card').length === 2 ? 'ok' : null,
              null, 4000);
            const a1 = await salesTab.evaluate(() => ({
              cards:   document.querySelectorAll('.dv-room-card').length,
              remBtns: document.querySelectorAll('.dv-rm-room').length,
            }));
            record(WIZ_LABELS[4],
              'cards=2, remBtns=2',
              `cards=${a1.cards}, remBtns=${a1.remBtns}`,
              after1add === 'ok' && a1.cards === 2 && a1.remBtns === 2);

            // (5) Click Add Room a second time → 3 cards, 3 Remove buttons
            await salesTab.evaluate(() => document.querySelector('#dv-add-room')?.click());
            const after2adds = await pollPage(salesTab,
              () => document.querySelectorAll('.dv-room-card').length === 3 ? 'ok' : null,
              null, 4000);
            const a2 = await salesTab.evaluate(() => ({
              cards:   document.querySelectorAll('.dv-room-card').length,
              remBtns: document.querySelectorAll('.dv-rm-room').length,
            }));
            record(WIZ_LABELS[5],
              'cards=3, remBtns=3',
              `cards=${a2.cards}, remBtns=${a2.remBtns}`,
              after2adds === 'ok' && a2.cards === 3 && a2.remBtns === 3);

            // (6) Click Remove → card count must decrease by exactly 1.
            const beforeRem = await salesTab.evaluate(() =>
              document.querySelectorAll('.dv-room-card').length);
            await salesTab.evaluate(() => {
              const first = document.querySelector('.dv-room-card .dv-rm-room');
              if (first) first.click();
            });
            await new Promise(r => setTimeout(r, 600));
            const afterRem = await salesTab.evaluate(() =>
              document.querySelectorAll('.dv-room-card').length);
            record(WIZ_LABELS[6],
              `cards count after Remove === ${beforeRem - 1}`,
              `cards before=${beforeRem}, after=${afterRem}`,
              afterRem === beforeRem - 1);

            // (7) "Every room needs a name" guard — open a FRESH wizard so the
            // click-handler stack is clean.  Leave the default room name
            // empty and click Review.
            const reopened = await openWizardToStep2();
            if (!reopened) {
              record(WIZ_LABELS[7], 'fresh wizard re-opens to step 2',
                'fresh wizard did not reach step 2', false);
              record(WIZ_LABELS[8], 'depends on fresh wizard opening',
                'fresh wizard did not reach step 2', false);
            } else {
              await salesTab.evaluate(() => {
                document.querySelectorAll('.dv-rn').forEach(el => { el.value = ''; });
                const btns = Array.from(document.querySelectorAll('.dv-wizard .dv-btn-next'));
                const review = btns.find(b => /Review/i.test(b.textContent || ''));
                if (review) review.click();
              });
              const s2err = await pollPage(salesTab,
                () => {
                  const t = (document.querySelector('#dv-s2-err')?.textContent || '').trim();
                  return /Every room needs a name/i.test(t) ? t : null;
                }, null, 4000);
              record(WIZ_LABELS[7],
                '#dv-s2-err contains "Every room needs a name"',
                s2err ? `errText=${JSON.stringify(s2err)}` : '#dv-s2-err did not match within 4 s',
                !!s2err);

              // (8) Fill the room name, click Review → step 3 (#dv-submit)
              await salesTab.evaluate(() => {
                document.querySelectorAll('.dv-rn').forEach((el, i) => {
                  el.value = `WizRoom${i+1}`;
                });
                const btns = Array.from(document.querySelectorAll('.dv-wizard .dv-btn-next'));
                const review = btns.find(b => /Review/i.test(b.textContent || ''));
                if (review) review.click();
              });
              const step3 = await pollPage(salesTab,
                () => document.querySelector('#dv-submit') ? 'ok' : null,
                null, 6000);
              record(WIZ_LABELS[8],
                '#dv-submit button is visible (step 3 rendered)',
                step3 ? 'step 3 visible' : 'step 3 did not render within 6 s',
                step3 === 'ok');
            }
          }
        }

        await salesTab.close();
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
    '# Design Visit — Wizard & Sign-off E2E Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:design-visit\``,
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
    '- **[API] Pre-checks** — admin catalogue and T&C-versions endpoints respond',
    '  before any browser tab opens; the public sign-off route is reachable',
    '  without a session (404 on a bogus token, not 401).',
    '- **[CRUD] Admin catalogue CRUD** — create + rename + list-includes round',
    '  trip for `catalog_handles`; create probes for furniture ranges,',
    '  door styles, and `terms_conditions_versions`; a non-admin POST is',
    '  blocked with 403 to verify the admin gate.',
    '- **[SUB] POST /api/design-visits side-effect chain** — submitting a',
    '  single-room visit returns 201 with `designVisitId`; the chain flips',
    '  `status` to `submitted`, leaves `qb_estimate_id` NULL (QB credentials',
    '  stripped → step skipped non-fatally), and the server log contains no',
    '  `[design-visits] Side effect chain error` entry (email transport',
    '  similarly absent → silent skip).',
    '- **[ANS] Per-room questionnaire answer round-trip** — a room-scoped',
    '  `visit_questions` row is created, an answer for it is carried inline on',
    '  the submitted room, and GET `/api/design-visits/:id/answers` returns it',
    '  with a non-null `room_id` and the original answer value (verifying the',
    '  create-path persistence into `visit_answers`).',
    '- **[TOK] Sign-off token generation** — `signoff_token_hash` is set on',
    '  the visit row and `signoff_expires_at` is ~7 days in the future.',
    '- **[PUB] Public sign-off — approve** — a known raw token is injected',
    '  for the existing visit (the chain-generated token is unguessable). The',
    '  public GET returns the visit with `rooms.length === 1`. POST with',
    '  `{ action: "approve" }` flips status to `signed_off`, sets',
    '  `signed_off_at`, and clears the token hash. Re-using the consumed',
    '  token returns 404.',
    '- **[PUB] Public sign-off — revision** — after re-arming the visit with',
    '  a fresh token, POST `{ action: "revision", note: ... }` flips status',
    '  to `revision_requested`, persists the note, and clears the token.',
    '  Re-using the consumed token returns 404. A POST with an unknown',
    '  `action` is rejected with 400.',
    '- **[PHOTO] Cloud-hosted room photos** — the spawned server preloads an',
    '  in-memory `@replit/object-storage` stub (',
    '  `test/design-visit/fake-object-storage.js` via',
    '  `preload-object-storage-stub.js`) so the upload/serve probes run',
    '  without a real Replit bucket. POST `/api/design-visits/uploads` with a',
    '  1×1 PNG data URL must return an opaque `obj:<id>.png` storage key and a',
    '  signed `/api/design-visit-images/<key>?exp=&sig=<64-hex>` viewUrl.',
    '  Fetching that URL must return the PNG bytes with `Content-Type:',
    '  image/png`. Tampering the signature must 403; supplying a validly',
    '  signed but past-`exp` URL must also 403 (proving the time window is',
    '  enforced, not just the HMAC). Upload negatives: a non-image data URL',
    '  must 400 and an oversized image (>10 MB but under the 15 MB JSON',
    '  body limit) must return 4xx. A round-trip POST `/api/design-visits`',
    '  carrying the storage key must persist `obj:` in',
    '  `design_visit_room_images.storage_key` and the follow-up',
    '  GET `/api/design-visits/:id` must hand the key back as a signed',
    '  `/api/design-visit-images/...` viewUrl that itself resolves to the',
    '  uploaded PNG bytes.',
    '- **[WIZ] Wizard dispatch from a card action** — a `start_design_visit`',
    '  handler is seeded directly in the DB; the test navigates `/sales`,',
    '  injects an `.eq-card-action` element bound to that handler with the',
    '  required contact attributes, and clicks it. The dispatch is asserted',
    '  by the appearance of `.dv-wizard-backdrop` and the `#dv-terms`',
    '  checkbox (step 1). Clicking Next without ticking terms must surface',
    '  the inline error containing "terms and conditions"; ticking terms',
    '  must advance to step 2 (`#dv-add-room` visible).',
    '- **[ROOM] Room add / remove validation** — step 2 must initially show',
    '  exactly 1 `.dv-room-card` with no `.dv-rm-room` (Remove hidden for the',
    '  last remaining card). Clicking `#dv-add-room` twice yields 3 cards',
    '  with 3 visible Remove buttons; clicking Remove on the first card',
    '  drops the count to 2. Clearing all room names and clicking Review must',
    '  surface `#dv-s2-err` containing "Every room needs a name". Filling',
    '  the names then clicking Review must advance to step 3, asserted by',
    '  the appearance of `#dv-submit`.',
    '',
    '## Notes',
    '',
    '- The harness strips `HUBSPOT_TOKEN`, SMTP and QB credentials so all',
    '  external side-effects either skip silently (email, HubSpot) or no-op',
    '  (QB estimate). This is the documented production-of-record skip',
    '  behaviour for the design-visit chain in development.',
    '- The chain-generated sign-off raw token is unguessable, so the',
    '  approve/revision probes inject a known raw token directly into the',
    '  `signoff_token_hash` column using the same sha256 hash the API uses.',
    '  This faithfully exercises the route handler — only the token-delivery',
    '  email step is bypassed.',
    '- Deeper coverage for sign-off token security, multi-room images, T&C',
    '  version pinning, and BroadcastChannel catalogue refresh inside an',
    '  open wizard lives in `test/start-design-visit/run.js`.',
    '- Fixtures created with the `privtest-dv-` prefix (catalogue rows,',
    '  `PrivTest DV %` handlers, `privtest-dv-%` visits and contact ids,',
    '  `privtest-dv-` T&C texts) are purged on exit alongside the standard',
    '  privtest user fixtures.',
  ];
  const outPath = path.join(dir, 'design-visit.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Report: test-results/design-visit.md`);
}

main();
