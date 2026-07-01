'use strict';
// test/sign-off-stale-link/run.js
//
// End-to-end live test for the "superseded" sign-off path.
//
// A design-visit sign-off link must stop working (without leaking data) after
// the designer has re-opened the visit (PUT /api/design-visits/:id) or re-run
// the submit pipeline (POST /api/design-visits/:id/submit, which also fires
// from /:id/revision → /:id/submit). The page must:
//   - GET /api/design-visits/sign-off/:token returns 410 with
//     status='superseded' and NO visit data (old links must not act as
//     long-lived bearer tokens for current customer PII and room photos).
//   - POST /api/design-visits/sign-off/:token returns 409 with
//     status='superseded' for both action='approve' and action='revision'.
//   - Genuinely unknown tokens still return 404.
//
// Covered paths:
//   (PUT-A) Designer re-opens via PUT /api/design-visits/:id  — old token
//           moves into superseded_signoff_token_hashes; new token minted.
//   (PUT-B) PUT-superseded GET → 410 status=superseded, no visit data.
//   (PUT-C) PUT-superseded POST {approve} → 409 status=superseded.
//   (PUT-D) PUT-superseded POST {revision} → 409 status=superseded.
//   (RES-A) Designer requests-revision via POST /:id/revision then re-runs
//           POST /:id/submit — old token must end up superseded.
//   (RES-B) RES-superseded GET → 410 status=superseded, no visit data.
//   (RES-C) RES-superseded POST {approve} → 409 status=superseded.
//   (RES-D) RES-superseded POST {revision} → 409 status=superseded.
//   (UNK-A) Genuinely unknown token GET → 404.
//   (UNK-B) Genuinely unknown token POST → 404.
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:sign-off-stale-link
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:sign-off-stale-link

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { pollFn } = require('../helpers/poll');

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

require('dotenv').config();

const RUN_PREFIX      = 'privtest-stale-';
const FAKE_CONTACT_ID = 'privtest-stale-contact';

function tokenHash(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

async function purgeFixtures(pool) {
  try {
    await pool.query(`DELETE FROM design_visits WHERE contact_id LIKE 'privtest-stale-%'`);
  } catch {}
  try {
    await pool.query(`DELETE FROM design_visit_handles          WHERE name LIKE 'privtest-stale-%'`);
  } catch {}
  try {
    await pool.query(`DELETE FROM design_visit_furniture_ranges WHERE name LIKE 'privtest-stale-%'`);
  } catch {}
  try {
    await pool.query(`DELETE FROM design_visit_door_styles      WHERE name LIKE 'privtest-stale-%'`);
  } catch {}
  try {
    await pool.query(`DELETE FROM terms_conditions_versions     WHERE terms_text LIKE 'privtest-stale-%'`);
  } catch {}
}

// Seed a `design_visit` row + one room in 'submitted' status with a known
// signoff token. Returns { id, rawToken }.
async function seedSubmittedVisit(pool, { contactId, createdBy, rawToken,
  handleId, furnitureRangeId, doorStyleId, termsVersionId }) {
  const expires = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
  const r = await pool.query(
    `INSERT INTO design_visits
       (contact_id, contact_name, contact_email, created_by, visit_date,
        duration_min, location, notes, terms_accepted, status,
        handle_id, furniture_range_id, terms_condition_version_id,
        signoff_token_hash, signoff_expires_at)
     VALUES ($1, 'Stale Link Customer', 'stale@privtest.local', $2,
             $3, 90, '1 Stale Lane', 'seeded by stale-link test', TRUE, 'submitted',
             $4, $5, $6, $7, $8)
     RETURNING id`,
    [contactId, createdBy,
     new Date(Date.now() + 14 * 86400 * 1000).toISOString(),
     handleId, furnitureRangeId, termsVersionId,
     tokenHash(rawToken), expires],
  );
  const id = r.rows[0].id;
  await pool.query(
    `INSERT INTO design_visit_rooms
       (design_visit_id, room_name, door_style_id,
        unit_count, unit_price_pence, sort_order)
     VALUES ($1, 'Kitchen', $2, 4, 25000, 0)`,
    [id, doorStyleId],
  );
  return { id, rawToken };
}

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
  console.log(`\n  sign-off-stale-link E2E  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);
  await purgeFixtures(pool);

  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  admin=${users.admin.email}`);

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
    writeReport(findings);
    process.exit(code);
  };
  process.on('SIGINT',  () => cleanupAndExit(130));
  process.on('SIGTERM', () => cleanupAndExit(130));
  process.on('uncaughtException',  (e) => { console.error('Uncaught:',  e); cleanupAndExit(2); });
  process.on('unhandledRejection', (e) => { console.error('Unhandled:', e); cleanupAndExit(2); });

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

  // Wait for design-visit tables to be created (async on boot).
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
    waitForTable('design_visit_handles'),
    waitForTable('design_visit_furniture_ranges'),
    waitForTable('design_visit_door_styles'),
    waitForTable('terms_conditions_versions'),
  ]);

  await purgeFixtures(pool);

  // ── Seed catalogue rows referenced by PUT body ────────────────────────────
  const handleRow = await pool.query(
    `INSERT INTO design_visit_handles (name, sort_order) VALUES ($1, 9990)
     RETURNING id`, [`${RUN_PREFIX}handle-${runId}`]);
  const handleId = handleRow.rows[0].id;
  const furnRow = await pool.query(
    `INSERT INTO design_visit_furniture_ranges (name, sort_order) VALUES ($1, 9991)
     RETURNING id`, [`${RUN_PREFIX}fr-${runId}`]);
  const furnitureRangeId = furnRow.rows[0].id;
  const doorRow = await pool.query(
    `INSERT INTO design_visit_door_styles (name, sort_order) VALUES ($1, 9992)
     RETURNING id`, [`${RUN_PREFIX}ds-${runId}`]);
  const doorStyleId = doorRow.rows[0].id;
  const tcvRow = await pool.query(
    `INSERT INTO terms_conditions_versions (terms_text, version_number)
     VALUES ($1, COALESCE((SELECT MAX(version_number) FROM terms_conditions_versions), 0) + 1)
     RETURNING id`,
    [`${RUN_PREFIX}tcv-${runId}`]);
  const termsVersionId = tcvRow.rows[0].id;

  const adminClient = await login(users.admin.email, users.admin.password);
  const anonClient  = makeClient(null);

  // ════════════════════════════════════════════════════════════════════════════
  // [PUT-*] Designer re-opens via PUT /api/design-visits/:id
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n  [PUT] PUT /api/design-visits/:id supersedes the prior sign-off link');

  const putRawToken = `${RUN_PREFIX}put-tok-${runId}`;
  const putVisit = await seedSubmittedVisit(pool, {
    contactId: `${FAKE_CONTACT_ID}-put-${runId}`,
    createdBy: users.admin.email,
    rawToken:  putRawToken,
    handleId, furnitureRangeId, doorStyleId, termsVersionId,
  });
  console.log(`  Seeded PUT visit id=${putVisit.id} rawToken=${putRawToken.slice(0, 24)}…`);

  // PUT re-opens: rooms[] is replaced, status flips to 'draft' (then back to
  // 'submitted' inside runSubmitSideEffects), old token hash is appended to
  // superseded_signoff_token_hashes, new token is minted.
  const putRes = await adminClient.put(`/api/design-visits/${putVisit.id}`, {
    contactName:  'Stale Link Customer',
    contactEmail: 'stale@privtest.local',
    handleId,
    furnitureRangeId,
    visitDate:    new Date(Date.now() + 21 * 86400 * 1000).toISOString(),
    durationMin:  90,
    location:     '1 Stale Lane',
    notes:        'reopened by stale-link test',
    termsAccepted: true,
    rooms: [{
      roomName: 'Kitchen v2', doorStyleId,
      widthMm: 3000, heightMm: 2400, depthMm: 600,
      unitCount: 6, unitPricePence: 18000, notes: 'reopened',
    }],
    handlerConfig: {},
  });
  record('[PUT] PUT /api/design-visits/:id returns ok=true',
    'status=200, ok=true, designVisitId matches',
    `status=${putRes.status} ok=${putRes.json?.ok} id=${putRes.json?.designVisitId}`,
    putRes.status === 200 && putRes.json?.ok === true && putRes.json?.designVisitId === putVisit.id);

  // Poll the DB until the async side-effect chain writes superseded_signoff_token_hashes.
  const putOldHashEarly = tokenHash(putRawToken);
  await pollFn(async () => {
    const r = await pool.query(
      `SELECT superseded_signoff_token_hashes FROM design_visits WHERE id=$1`,
      [putVisit.id]);
    const hashes = r.rows[0]?.superseded_signoff_token_hashes;
    return (Array.isArray(hashes) && hashes.includes(putOldHashEarly)) ? true : null;
  }, 8000, 100);

  // Confirm the DB shape: old hash now lives in superseded_signoff_token_hashes
  // and signoff_token_hash is the new value.
  const putAfter = await pool.query(
    `SELECT signoff_token_hash, superseded_signoff_token_hashes, status
     FROM design_visits WHERE id=$1`, [putVisit.id]);
  const putRow = putAfter.rows[0] || {};
  const putOldHash = tokenHash(putRawToken);
  const putWasSuperseded = Array.isArray(putRow.superseded_signoff_token_hashes)
    && putRow.superseded_signoff_token_hashes.includes(putOldHash);
  record('[PUT] old token hash moves into superseded_signoff_token_hashes',
    'old hash present in superseded array AND signoff_token_hash differs',
    `superseded=${JSON.stringify(putRow.superseded_signoff_token_hashes)} new=${putRow.signoff_token_hash}`,
    putWasSuperseded && putRow.signoff_token_hash !== putOldHash);

  // GET with the old token → 410, status='superseded' (no visit data exposed).
  {
    const r = await anonClient.get(`/api/design-visits/sign-off/${putRawToken}`);
    record('[PUT-B] GET /sign-off/:oldToken returns 410 status="superseded" (no visit data)',
      'status=410, body.status="superseded", body.id absent',
      `status=${r.status} bodyStatus=${r.json?.status} id=${r.json?.id ?? '(none)'}`,
      r.status === 410
        && r.json?.status === 'superseded'
        && r.json?.id === undefined);
  }

  // POST {approve} with the old token → 409, status='superseded'.
  {
    const r = await anonClient.post(`/api/design-visits/sign-off/${putRawToken}`,
      { action: 'approve' });
    record('[PUT-C] POST /sign-off/:oldToken {action:"approve"} returns 409 status="superseded"',
      'status=409, body.status="superseded"',
      `status=${r.status} bodyStatus=${r.json?.status}`,
      r.status === 409 && r.json?.status === 'superseded');
  }

  // POST {revision} with the old token → 409, status='superseded'.
  {
    const r = await anonClient.post(`/api/design-visits/sign-off/${putRawToken}`,
      { action: 'revision', note: 'attempting revision via stale link' });
    record('[PUT-D] POST /sign-off/:oldToken {action:"revision"} returns 409 status="superseded"',
      'status=409, body.status="superseded"',
      `status=${r.status} bodyStatus=${r.json?.status}`,
      r.status === 409 && r.json?.status === 'superseded');
  }

  // Sanity: the live (new) DB token must be unaffected — its status is
  // 'submitted' (per the API contract, even though it's not exposed in JSON).
  record('[PUT] visit status is back to "submitted" after PUT side-effects',
    'status=submitted',
    `status=${putRow.status}`,
    putRow.status === 'submitted');

  // ════════════════════════════════════════════════════════════════════════════
  // [RES-*] POST /:id/revision then POST /:id/submit supersedes the old link
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n  [RES] POST /:id/revision + POST /:id/submit supersedes the prior sign-off link');

  const resRawToken = `${RUN_PREFIX}res-tok-${runId}`;
  const resVisit = await seedSubmittedVisit(pool, {
    contactId: `${FAKE_CONTACT_ID}-res-${runId}`,
    createdBy: users.admin.email,
    rawToken:  resRawToken,
    handleId, furnitureRangeId, doorStyleId, termsVersionId,
  });
  console.log(`  Seeded RES visit id=${resVisit.id} rawToken=${resRawToken.slice(0, 24)}…`);

  // Step 1: designer requests revision — this supersedes the old token and
  // flips the visit to 'revision_requested'.
  {
    const r = await adminClient.post(
      `/api/design-visits/${resVisit.id}/revision`,
      { note: 'designer-driven revision' });
    record('[RES] POST /:id/revision flips visit to revision_requested',
      'status=200, success=true',
      `status=${r.status} success=${r.json?.success}`,
      r.status === 200 && r.json?.success === true);
  }

  // Step 2: designer re-submits — POST /:id/submit must mint a fresh token.
  {
    const r = await adminClient.post(
      `/api/design-visits/${resVisit.id}/submit`,
      { handlerConfig: {} });
    record('[RES] POST /:id/submit re-runs the side-effect chain',
      'status=200, ok=true',
      `status=${r.status} ok=${r.json?.ok}`,
      r.status === 200 && r.json?.ok === true);
  }

  // Poll the DB until the async side-effect chain writes superseded_signoff_token_hashes.
  const resOldHashEarly = tokenHash(resRawToken);
  await pollFn(async () => {
    const r = await pool.query(
      `SELECT superseded_signoff_token_hashes FROM design_visits WHERE id=$1`,
      [resVisit.id]);
    const hashes = r.rows[0]?.superseded_signoff_token_hashes;
    return (Array.isArray(hashes) && hashes.includes(resOldHashEarly)) ? true : null;
  }, 8000, 100);

  const resAfter = await pool.query(
    `SELECT signoff_token_hash, superseded_signoff_token_hashes, status
     FROM design_visits WHERE id=$1`, [resVisit.id]);
  const resRow = resAfter.rows[0] || {};
  const resOldHash = tokenHash(resRawToken);
  const resWasSuperseded = Array.isArray(resRow.superseded_signoff_token_hashes)
    && resRow.superseded_signoff_token_hashes.includes(resOldHash);
  record('[RES] old token hash present in superseded_signoff_token_hashes after revision+submit',
    'old hash in superseded array AND signoff_token_hash differs',
    `superseded=${JSON.stringify(resRow.superseded_signoff_token_hashes)} new=${resRow.signoff_token_hash}`,
    resWasSuperseded && resRow.signoff_token_hash !== resOldHash);

  {
    const r = await anonClient.get(`/api/design-visits/sign-off/${resRawToken}`);
    record('[RES-B] GET /sign-off/:oldToken returns 410 status="superseded" (no visit data)',
      'status=410, body.status="superseded", body.id absent',
      `status=${r.status} bodyStatus=${r.json?.status} id=${r.json?.id ?? '(none)'}`,
      r.status === 410
        && r.json?.status === 'superseded'
        && r.json?.id === undefined);
  }

  {
    const r = await anonClient.post(`/api/design-visits/sign-off/${resRawToken}`,
      { action: 'approve' });
    record('[RES-C] POST /sign-off/:oldToken {action:"approve"} returns 409 status="superseded"',
      'status=409, body.status="superseded"',
      `status=${r.status} bodyStatus=${r.json?.status}`,
      r.status === 409 && r.json?.status === 'superseded');
  }

  {
    const r = await anonClient.post(`/api/design-visits/sign-off/${resRawToken}`,
      { action: 'revision', note: 'stale revision attempt' });
    record('[RES-D] POST /sign-off/:oldToken {action:"revision"} returns 409 status="superseded"',
      'status=409, body.status="superseded"',
      `status=${r.status} bodyStatus=${r.json?.status}`,
      r.status === 409 && r.json?.status === 'superseded');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // [EXP-*] Expired-but-recognised tokens return a friendly 410 status="expired"
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n  [EXP] Expired sign-off tokens get a friendly 410 status="expired"');

  const expRawToken = `${RUN_PREFIX}exp-tok-${runId}`;
  const expVisit = await seedSubmittedVisit(pool, {
    contactId: `${FAKE_CONTACT_ID}-exp-${runId}`,
    createdBy: users.admin.email,
    rawToken:  expRawToken,
    handleId, furnitureRangeId, doorStyleId, termsVersionId,
  });
  // Force the seeded visit's signoff window into the past.
  await pool.query(
    `UPDATE design_visits SET signoff_expires_at = NOW() - INTERVAL '1 hour'
     WHERE id = $1`, [expVisit.id]);
  console.log(`  Seeded EXP visit id=${expVisit.id} rawToken=${expRawToken.slice(0, 24)}… (expired 1h ago)`);

  {
    const r = await anonClient.get(`/api/design-visits/sign-off/${expRawToken}`);
    record('[EXP-A] GET /sign-off/:expiredToken returns 410 status="expired"',
      'status=410, body.status="expired", body.error mentions expired',
      `status=${r.status} bodyStatus=${r.json?.status} error=${r.json?.error || ''}`,
      r.status === 410
        && r.json?.status === 'expired'
        && /expired/i.test(String(r.json?.error || '')));
  }

  {
    const r = await anonClient.post(`/api/design-visits/sign-off/${expRawToken}`,
      { action: 'approve' });
    record('[EXP-B] POST /sign-off/:expiredToken {action:"approve"} returns 410 status="expired"',
      'status=410, body.status="expired"',
      `status=${r.status} bodyStatus=${r.json?.status}`,
      r.status === 410 && r.json?.status === 'expired');
  }

  {
    const r = await anonClient.post(`/api/design-visits/sign-off/${expRawToken}`,
      { action: 'revision', note: 'attempting revision via expired link' });
    record('[EXP-C] POST /sign-off/:expiredToken {action:"revision"} returns 410 status="expired"',
      'status=410, body.status="expired"',
      `status=${r.status} bodyStatus=${r.json?.status}`,
      r.status === 410 && r.json?.status === 'expired');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // [UNK-*] Genuinely unknown tokens still return 404 (not superseded)
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n  [UNK] Unknown tokens still 404');
  const unknownToken = `${RUN_PREFIX}never-existed-${runId}`;
  {
    const r = await anonClient.get(`/api/design-visits/sign-off/${unknownToken}`);
    record('[UNK-A] GET /sign-off/:unknownToken returns 404',
      'status=404',
      `status=${r.status} bodyStatus=${r.json?.status || ''}`,
      r.status === 404);
  }
  {
    const r = await anonClient.post(`/api/design-visits/sign-off/${unknownToken}`,
      { action: 'approve' });
    record('[UNK-B] POST /sign-off/:unknownToken returns 404',
      'status=404',
      `status=${r.status} bodyStatus=${r.json?.status || ''}`,
      r.status === 404);
  }

  // ── Report + exit ─────────────────────────────────────────────────────────
  const failed = findings.filter(f => !f.ok).length;
  console.log(`\n  Done — ${findings.length - failed}/${findings.length} probes passed`);
  await cleanupAndExit(failed ? 1 : 0);
}

function writeReport(findings) {
  try {
    const outDir = path.join(__dirname, '..', '..', 'test-results');
    fs.mkdirSync(outDir, { recursive: true });
    const lines = [];
    lines.push('# Sign-off stale-link E2E report');
    lines.push('');
    lines.push(`Run timestamp: ${new Date().toISOString()}`);
    lines.push('');
    lines.push('Covers the "superseded" sign-off path: after a designer');
    lines.push('re-opens a submitted design visit (PUT /api/design-visits/:id)');
    lines.push('or re-runs the submit pipeline (POST /:id/revision +');
    lines.push('POST /:id/submit), the old customer-facing sign-off link must');
    lines.push('return 410 status="superseded" with NO visit data (stale links');
    lines.push('must not expose current customer PII and room photos), and any');
    lines.push('sign-off attempts via that stale link must be rejected with');
    lines.push('409 status="superseded".');
    lines.push('Genuinely unknown tokens continue to return 404.');
    lines.push('');
    const pass = findings.filter(f => f.ok).length;
    lines.push(`**Summary:** ${pass}/${findings.length} probes passed`);
    lines.push('');
    lines.push('| ✓ | Probe | Expected | Observed |');
    lines.push('|---|-------|----------|----------|');
    for (const f of findings) {
      const mark = f.ok ? '✓' : '✗';
      const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      lines.push(`| ${mark} | ${esc(f.name)} | ${esc(f.expected)} | ${esc(f.observed)} |`);
    }
    lines.push('');
    fs.writeFileSync(path.join(outDir, 'sign-off-stale-link.md'), lines.join('\n'));
  } catch (e) {
    console.error('writeReport failed:', e.message);
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
