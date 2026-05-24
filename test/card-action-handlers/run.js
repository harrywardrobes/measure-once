'use strict';
// test/card-action-handlers/run.js
//
// End-to-end live test for the card-action-handlers feature.  Mirrors the
// pattern in test/lead-status-sync/run.js: boot a disposable server with the
// privileges harness, drive the UI with Puppeteer, write a markdown report to
// test-results/card-action-handlers.md.
//
// Covers (per task #587):
//   (A) Admin creates a handler in admin.html → the
//       `card_action_handlers_changed` BroadcastChannel fires → another open
//       Sales tab refreshes its in-page handler lookup.
//   (B) Clicking a bound `.eq-card-action` strip opens the correct modal
//       (datetime-local picker for add_design_visit_to_calendar, textarea
//       for summarise_phone_call) and submitting the form posts to the
//       expected backend route.
//   (C) Substatus binding wins over a label binding when both exist for the
//       same (stage_key, status_key) the substatus belongs to.
//   (D) Conflict-fix flow: the ⚠ Fix button appears for a duplicate-bound
//       slot and the resolver modal removes the conflict end-to-end.
//   (E) action_name field: a handler seeded with config.action_name =
//       'send_quote' shows the badge in the admin table (E.1), causes
//       cardActionHandlerAttrs() to emit data-card-action-name="send_quote"
//       (E.2), and the title-case label expansion yields "Send Quote" (E.3).
//
// API pre-checks run before any browser tab opens so failures in the API
// surface clearly.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:card-action-handlers
//   # or against the shared DB with the privtest- prefix cleanup:
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:card-action-handlers

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

// ── fixtures ──────────────────────────────────────────────────────────────────
// Use lowercase letters/digits/underscores only — these are what the server-side
// label-binding validator (_validateHandlerBinding) accepts for status_key.
const LBL_KEY_DV       = 'privtest_cah_dv';       // bound to add_design_visit_to_calendar
const LBL_KEY_PC       = 'privtest_cah_pc';        // bound to summarise_phone_call
const LBL_KEY_OVR      = 'privtest_cah_ovr';       // (sales, this) -> handler A (label binding)
const SUB_STATUS_K     = 'PRIVTEST_CAH_OVR';       // matching status_key (uppercase in lead_substatuses)
const SUB_SUB_K        = 'PRIVTEST_SUB';
// (D) conflict-fix fixtures
const LBL_KEY_CONFLICT    = 'privtest_cah_conflict'; // status_key for conflicting bindings (lowercase)
const LBL_KEY_CONFLICT_LS = 'PRIVTEST_CAH_CONFLICT'; // key in lead_status_config (uppercase, stage=SALES)
// (E) action_name display fixtures
const LBL_KEY_ANAME       = 'privtest_cah_aname';    // status_key for the action_name probe

const HANDLER_NAME_DV         = 'PrivTest design visit handler';
const HANDLER_NAME_PC         = 'PrivTest phone summary handler';
const HANDLER_NAME_LBL        = 'PrivTest label-binding handler';
const HANDLER_NAME_SUB        = 'PrivTest substatus-binding handler';
const HANDLER_NAME_CONFLICT_A = 'PrivTest conflict handler A';
const HANDLER_NAME_CONFLICT_B = 'PrivTest conflict handler B';
const HANDLER_NAME_ANAME      = 'PrivTest action-name handler';

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

async function purgeFixtures(pool) {
  // Order matters: handler deletion cascades to bindings; substatus deletion
  // cascades to any binding pointing at it.
  await pool.query(
    `DELETE FROM card_action_handlers
       WHERE name IN ($1, $2, $3, $4, $5, $6, $7)`,
    [HANDLER_NAME_DV, HANDLER_NAME_PC, HANDLER_NAME_LBL, HANDLER_NAME_SUB,
     HANDLER_NAME_CONFLICT_A, HANDLER_NAME_CONFLICT_B, HANDLER_NAME_ANAME]
  );
  await pool.query(
    `DELETE FROM lead_substatuses
       WHERE status_key = $1 AND substatus_key = $2`,
    [SUB_STATUS_K, SUB_SUB_K]
  );
  await pool.query(
    `DELETE FROM visits WHERE customer_id LIKE 'privtest-cah-%'`
  );
  // Remove the conflict-test lead status if it was seeded.
  try {
    await pool.query(
      `DELETE FROM lead_status_config WHERE key = $1`,
      [LBL_KEY_CONFLICT_LS]
    );
  } catch (_) {}
  // Recreate the unique label-binding index if it was temporarily dropped
  // during probe (D) to seed the conflict state.  Safe to run even if the
  // index still exists — CREATE … IF NOT EXISTS is a no-op in that case.
  // If conflicting rows somehow remain this will throw; that is intentional.
  try {
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS cahb_label_uniq
        ON card_action_handler_bindings (stage_key, status_key)
        WHERE substatus_id IS NULL
    `);
  } catch (_) {}
}

// Poll an in-page predicate until it returns truthy or the deadline expires.
async function pollPage(page, fn, arg, timeoutMs = 6000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const got = await page.evaluate(fn, arg);
    if (got) return got;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
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
  console.log(`\n  card-action-handlers E2E  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  // Pre-clean stale users from a prior crashed run (other fixture tables may
  // not exist yet — they're created on server boot).
  await cleanupTestData(pool);

  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  admin=${users.admin.email}`);

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

  // ── boot test server ───────────────────────────────────────────────────────
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

  // The server creates card_action_handlers / card_action_handler_bindings /
  // lead_substatuses asynchronously inside its app.listen() callback (after
  // HTTP starts accepting requests).  Wait for them to appear before touching
  // fixtures.
  const waitForTable = async (name) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const r = await pool.query(`SELECT to_regclass($1) AS t`, [name]);
      if (r.rows[0].t) return;
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`Timed out waiting for table ${name} to be created on server boot`);
  };
  await waitForTable('card_action_handlers');
  await waitForTable('card_action_handler_bindings');
  await waitForTable('lead_substatuses');
  await waitForTable('visits');

  await purgeFixtures(pool);
  const subRes = await pool.query(
    `INSERT INTO lead_substatuses (status_key, substatus_key, label, action_label, sort_order)
     VALUES ($1, $2, 'PrivTest sub label', '', 9999)
     RETURNING id`,
    [SUB_STATUS_K, SUB_SUB_K]
  );
  const subId = subRes.rows[0].id;
  console.log(`  Inserted lead_substatus id=${subId} (${SUB_STATUS_K}__${SUB_SUB_K})`);

  // ── API pre-checks ─────────────────────────────────────────────────────────
  const adminClient = await login(users.admin.email, PASSWORD);

  const adminListRes = await adminClient.get('/api/admin/card-action-handlers');
  record(
    'GET /api/admin/card-action-handlers responds for admin',
    'status=200, JSON array',
    `status=${adminListRes.status} type=${Array.isArray(adminListRes.json) ? 'array' : typeof adminListRes.json}`,
    adminListRes.status === 200 && Array.isArray(adminListRes.json),
  );

  const pubListRes = await adminClient.get('/api/card-action-handlers');
  record(
    'GET /api/card-action-handlers (authenticated) responds',
    'status=200, JSON array',
    `status=${pubListRes.status} type=${Array.isArray(pubListRes.json) ? 'array' : typeof pubListRes.json}`,
    pubListRes.status === 200 && Array.isArray(pubListRes.json),
  );

  // ── (NEG) Negative-path validation probes ─────────────────────────────────
  //
  // Each probe sends a known-bad payload to POST or PATCH
  // /api/admin/card-action-handlers and asserts a 400 with a non-empty error
  // string.  This section is pure REST — no browser required.
  //
  // Handler-config probes (add_design_visit_to_calendar):
  //   NEG-01  defaultDurationMin below minimum (4)
  //   NEG-02  defaultDurationMin above maximum (1441)
  //   NEG-03  defaultDurationMin is not a number
  //   NEG-04  config is an array (not a JSON object)
  //   NEG-05  config payload exceeds 4 KB
  //   NEG-06  defaultTitle longer than 120 chars is silently truncated (201, not 400)
  //
  // Handler-config probes (summarise_phone_call):
  //   NEG-07  notePrefix longer than 120 chars is silently truncated (201, not 400)
  //
  // Handler-config probes (show_message):
  //   NEG-08  message field is absent → required error
  //   NEG-09  message field exceeds 2000 chars
  //
  // Handler-level probes:
  //   NEG-10  unknown handler type
  //   NEG-11  name longer than 80 chars
  //
  // Binding probes (POST):
  //   NEG-12  stage_key is not one of the allowed values
  //   NEG-13  status_key contains uppercase letters / special chars
  //   NEG-14  binding with neither stage_key nor substatus_id
  //   NEG-15  substatus_id = 0 (not positive)
  //   NEG-16  substatus_id is a non-numeric string
  //
  // PATCH config probes:
  //   NEG-17  PATCH sends defaultDurationMin < 5 → 400
  //   NEG-18  PATCH sends invalid binding stage_key → 400

  console.log('\n  [NEG] Negative-path validation probes');

  // Helper: assert 400 with a non-empty error string.
  function assertBadRequest(probeName, res, fragmentIfAny) {
    const is400      = res.status === 400;
    const hasMessage = typeof res.json?.error === 'string' && res.json.error.length > 0;
    const fragOk     = !fragmentIfAny || (hasMessage && res.json.error.includes(fragmentIfAny));
    record(
      probeName,
      `status=400 with error message${fragmentIfAny ? ` containing "${fragmentIfAny}"` : ''}`,
      `status=${res.status} error=${JSON.stringify(res.json?.error)}`,
      is400 && hasMessage && fragOk,
    );
  }

  // NEG-01: defaultDurationMin below minimum
  {
    const r = await adminClient.post('/api/admin/card-action-handlers', {
      name: '',
      type: 'add_design_visit_to_calendar',
      config: { defaultDurationMin: 4 },
      bindings: [],
    });
    assertBadRequest('NEG-01: defaultDurationMin < 5 rejected', r, 'defaultDurationMin');
  }

  // NEG-02: defaultDurationMin above maximum
  {
    const r = await adminClient.post('/api/admin/card-action-handlers', {
      name: '',
      type: 'add_design_visit_to_calendar',
      config: { defaultDurationMin: 1441 },
      bindings: [],
    });
    assertBadRequest('NEG-02: defaultDurationMin > 1440 rejected', r, 'defaultDurationMin');
  }

  // NEG-03: defaultDurationMin is not a number
  {
    const r = await adminClient.post('/api/admin/card-action-handlers', {
      name: '',
      type: 'add_design_visit_to_calendar',
      config: { defaultDurationMin: 'banana' },
      bindings: [],
    });
    assertBadRequest('NEG-03: defaultDurationMin non-numeric rejected', r, 'defaultDurationMin');
  }

  // NEG-04: config is an array
  {
    const r = await adminClient.post('/api/admin/card-action-handlers', {
      name: '',
      type: 'add_design_visit_to_calendar',
      config: [1, 2, 3],
      bindings: [],
    });
    assertBadRequest('NEG-04: config as array rejected', r, 'config must be a JSON object');
  }

  // NEG-05: config payload exceeds 4 KB
  {
    const r = await adminClient.post('/api/admin/card-action-handlers', {
      name: '',
      type: 'add_design_visit_to_calendar',
      config: { pad: 'x'.repeat(5000) },
      bindings: [],
    });
    assertBadRequest('NEG-05: config > 4 KB rejected', r, 'too large');
  }

  // NEG-06: defaultTitle > 120 chars must be rejected with 400
  {
    const r = await adminClient.post('/api/admin/card-action-handlers', {
      name: '',
      type: 'add_design_visit_to_calendar',
      config: { defaultTitle: 'A'.repeat(121) },
      bindings: [],
    });
    assertBadRequest('NEG-06: defaultTitle > 120 chars rejected', r, 'defaultTitle');
  }

  // NEG-07: notePrefix > 120 chars must be rejected with 400
  {
    const r = await adminClient.post('/api/admin/card-action-handlers', {
      name: '',
      type: 'summarise_phone_call',
      config: { notePrefix: 'B'.repeat(121) },
      bindings: [],
    });
    assertBadRequest('NEG-07: notePrefix > 120 chars rejected', r, 'notePrefix');
  }

  // NEG-08: show_message with no message → required error
  {
    const r = await adminClient.post('/api/admin/card-action-handlers', {
      name: '',
      type: 'show_message',
      config: {},
      bindings: [],
    });
    assertBadRequest('NEG-08: show_message with absent message rejected', r, 'message');
  }

  // NEG-09: show_message with message > 2000 chars
  {
    const r = await adminClient.post('/api/admin/card-action-handlers', {
      name: '',
      type: 'show_message',
      config: { message: 'Z'.repeat(2001) },
      bindings: [],
    });
    assertBadRequest('NEG-09: show_message with message > 2000 chars rejected', r, '2000');
  }

  // NEG-10: unknown handler type
  {
    const r = await adminClient.post('/api/admin/card-action-handlers', {
      name: '',
      type: 'fly_to_moon',
      config: {},
      bindings: [],
    });
    assertBadRequest('NEG-10: unknown handler type rejected', r, null);
  }

  // NEG-11: name exceeds 80 chars
  {
    const r = await adminClient.post('/api/admin/card-action-handlers', {
      name: 'N'.repeat(81),
      type: 'summarise_phone_call',
      config: {},
      bindings: [],
    });
    assertBadRequest('NEG-11: name > 80 chars rejected', r, '80');
  }

  // NEG-12: binding with invalid stage_key
  {
    const r = await adminClient.post('/api/admin/card-action-handlers', {
      name: '',
      type: 'summarise_phone_call',
      config: {},
      bindings: [{ stage_key: 'bogus_stage', status_key: 'some_key' }],
    });
    assertBadRequest('NEG-12: binding with invalid stage_key rejected', r, 'stage_key');
  }

  // NEG-13: binding with status_key containing uppercase / illegal chars
  {
    const r = await adminClient.post('/api/admin/card-action-handlers', {
      name: '',
      type: 'summarise_phone_call',
      config: {},
      bindings: [{ stage_key: 'sales', status_key: 'UPPER_CASE_KEY!' }],
    });
    assertBadRequest('NEG-13: binding with illegal status_key chars rejected', r, 'status_key');
  }

  // NEG-14: binding with neither stage_key nor substatus_id
  {
    const r = await adminClient.post('/api/admin/card-action-handlers', {
      name: '',
      type: 'summarise_phone_call',
      config: {},
      bindings: [{}],
    });
    assertBadRequest('NEG-14: binding missing both stage_key and substatus_id rejected', r, 'stage_key');
  }

  // NEG-15: substatus_id = 0 (not a positive integer)
  {
    const r = await adminClient.post('/api/admin/card-action-handlers', {
      name: '',
      type: 'add_design_visit_to_calendar',
      config: {},
      bindings: [{ substatus_id: 0 }],
    });
    assertBadRequest('NEG-15: substatus_id = 0 rejected', r, 'substatus_id');
  }

  // NEG-16: substatus_id is a non-numeric string
  {
    const r = await adminClient.post('/api/admin/card-action-handlers', {
      name: '',
      type: 'add_design_visit_to_calendar',
      config: {},
      bindings: [{ substatus_id: 'not-a-number' }],
    });
    assertBadRequest('NEG-16: substatus_id non-numeric string rejected', r, 'substatus_id');
  }

  // NEG-17: PATCH with defaultDurationMin < 5
  // Scaffold: create a valid DV handler to patch against.
  {
    const scaffoldRes = await adminClient.post('/api/admin/card-action-handlers', {
      name: 'privtest-neg17-scaffold',
      type: 'add_design_visit_to_calendar',
      config: { defaultDurationMin: 60 },
      bindings: [],
    });
    const scaffoldId = scaffoldRes.json?.id;
    if (scaffoldId) {
      const r = await adminClient.patch(`/api/admin/card-action-handlers/${scaffoldId}`, {
        config: { defaultDurationMin: 2 },
      });
      assertBadRequest('NEG-17: PATCH with defaultDurationMin < 5 rejected', r, 'defaultDurationMin');
      await adminClient.delete(`/api/admin/card-action-handlers/${scaffoldId}`);
    } else {
      record(
        'NEG-17: PATCH with defaultDurationMin < 5 rejected',
        'status=400 with error',
        `skipped — scaffold POST failed (status=${scaffoldRes.status})`,
        false,
      );
    }
  }

  // NEG-18: PATCH with invalid binding stage_key
  {
    const scaffoldRes = await adminClient.post('/api/admin/card-action-handlers', {
      name: 'privtest-neg18-scaffold',
      type: 'summarise_phone_call',
      config: {},
      bindings: [],
    });
    const scaffoldId = scaffoldRes.json?.id;
    if (scaffoldId) {
      const r = await adminClient.patch(`/api/admin/card-action-handlers/${scaffoldId}`, {
        bindings: [{ stage_key: 'not_valid', status_key: 'some_key' }],
      });
      assertBadRequest('NEG-18: PATCH with invalid binding stage_key rejected', r, 'stage_key');
      await adminClient.delete(`/api/admin/card-action-handlers/${scaffoldId}`);
    } else {
      record(
        'NEG-18: PATCH with invalid binding stage_key rejected',
        'status=400 with error',
        `skipped — scaffold POST failed (status=${scaffoldRes.status})`,
        false,
      );
    }
  }

  // ── (PRIV) Member-privilege probes ────────────────────────────────────────
  //
  // Verify that the `requireAdmin` middleware on the /api/admin/card-action-
  // handlers routes actually blocks a regular approved member.  Each attempt
  // must return 403 (or a redirect to login, which node-fetch follows to a
  // non-2xx page — either way, NOT 2xx).
  //
  //   PRIV-01  member POST  /api/admin/card-action-handlers        → 403
  //   PRIV-02  member PATCH /api/admin/card-action-handlers/:id    → 403
  //   PRIV-03  member DELETE /api/admin/card-action-handlers/:id   → 403

  console.log('\n  [PRIV] Member-privilege probes');

  const memberClient = await login(users.member.email, PASSWORD);

  // Create a scaffold handler as admin so PRIV-02 / PRIV-03 have a real ID.
  let privScaffoldId = null;
  {
    const r = await adminClient.post('/api/admin/card-action-handlers', {
      name: 'privtest-priv-scaffold',
      type: 'summarise_phone_call',
      config: {},
      bindings: [],
    });
    privScaffoldId = r.json?.id ?? null;
  }

  // PRIV-00: member GET
  {
    const r = await memberClient.get('/api/admin/card-action-handlers');
    const blocked = r.status === 403 || r.status === 401 || r.status === 302;
    record(
      'PRIV-00: member GET /api/admin/card-action-handlers blocked',
      'status=403 (or 401/302)',
      `status=${r.status}`,
      blocked,
    );
  }

  // PRIV-01: member POST
  {
    const r = await memberClient.post('/api/admin/card-action-handlers', {
      name: 'privtest-member-attempt',
      type: 'summarise_phone_call',
      config: {},
      bindings: [],
    });
    const blocked = r.status === 403 || r.status === 401 || r.status === 302;
    record(
      'PRIV-01: member POST /api/admin/card-action-handlers blocked',
      'status=403 (or 401/302)',
      `status=${r.status}`,
      blocked,
    );
  }

  // PRIV-02: member PATCH
  {
    const targetId = privScaffoldId ?? 999999;
    const r = await memberClient.patch(`/api/admin/card-action-handlers/${targetId}`, {
      config: {},
    });
    const blocked = r.status === 403 || r.status === 401 || r.status === 302;
    record(
      'PRIV-02: member PATCH /api/admin/card-action-handlers/:id blocked',
      'status=403 (or 401/302)',
      `status=${r.status}`,
      blocked,
    );
  }

  // PRIV-03: member DELETE
  {
    const targetId = privScaffoldId ?? 999999;
    const r = await memberClient.delete(`/api/admin/card-action-handlers/${targetId}`);
    const blocked = r.status === 403 || r.status === 401 || r.status === 302;
    record(
      'PRIV-03: member DELETE /api/admin/card-action-handlers/:id blocked',
      'status=403 (or 401/302)',
      `status=${r.status}`,
      blocked,
    );
  }

  // Clean up the scaffold handler (admin delete).
  if (privScaffoldId) {
    await adminClient.delete(`/api/admin/card-action-handlers/${privScaffoldId}`);
  }

  // ── puppeteer required ─────────────────────────────────────────────────────
  if (!puppeteer) {
    record(
      'puppeteer available',
      'require("puppeteer") resolves',
      'module not installed',
      false,
      'Install puppeteer (npm i -D puppeteer) and rerun.',
    );
    await writeReport(runId, findings);
    await cleanupAndExit(1);
    return;
  }

  // Locate the system Chromium (mirrors test/lead-status-sync/run.js).
  let executablePath;
  const chromiumCandidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium',
  ].filter(Boolean);
  for (const p of chromiumCandidates) {
    try { fs.accessSync(p); executablePath = p; break; } catch {}
  }
  if (!executablePath) {
    try {
      const { execSync } = require('child_process');
      executablePath = execSync('which chromium', { encoding: 'utf8' }).trim() || undefined;
    } catch {}
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      defaultViewport: { width: 1280, height: 800 },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  } catch (e) {
    record('headless chromium launches', 'browser.launch() succeeds', `error: ${e.message}`, false);
    await writeReport(runId, findings);
    await cleanupAndExit(1);
    return;
  }

  try {
    // ── (A) BroadcastChannel cross-tab refresh ────────────────────────────────
    //
    // Tab 1 = /sales — loads card-action-handlers.js, registers the
    //                  card_action_handlers_changed BroadcastChannel listener.
    // Tab 2 = /admin — second same-browser tab (BC does not deliver back to
    //                  the sender's own port).
    //
    // Flow:
    //   1. Verify the salesTab lookup has no entry for our test label yet.
    //   2. Admin creates a handler via POST /api/admin/card-action-handlers.
    //   3. adminTab posts a card_action_handlers_changed BC message.
    //   4. salesTab's listener re-fetches and re-indexes; verify lookup hit.
    console.log('\n  [A] BroadcastChannel cross-tab refresh');

    const salesTab = await browser.newPage();
    await salesTab.setCacheEnabled(false);
    await injectSession(salesTab, adminClient.cookie);
    await salesTab.goto(`${BASE}/sales`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    // Wait for the global to be installed (the IIFE in card-action-handlers.js
    // runs synchronously when the script evaluates).
    await pollPage(salesTab, () => typeof window.cardActionHandlerFor === 'function');
    // Give the bootstrap GET /api/card-action-handlers a moment to complete.
    await new Promise(r => setTimeout(r, 600));

    const initiallyMissing = await salesTab.evaluate(
      (k) => cardActionHandlerFor('sales', k) === null,
      LBL_KEY_DV,
    );
    record(
      'salesTab lookup starts with no handler for our test label',
      `cardActionHandlerFor('sales', '${LBL_KEY_DV}') === null`,
      `null=${initiallyMissing}`,
      initiallyMissing === true,
    );

    // Create the DV handler via the admin REST API (representative of what
    // admin.html's save flow does).
    const createDvRes = await adminClient.post('/api/admin/card-action-handlers', {
      name: HANDLER_NAME_DV,
      type: 'add_design_visit_to_calendar',
      config: {
        defaultDurationMin: 60,
        defaultTitle:       'PrivTest visit title',
        addToGoogleCalendar: false,
      },
      bindings: [{ stage_key: 'sales', status_key: LBL_KEY_DV }],
    });
    record(
      'POST /api/admin/card-action-handlers creates DV handler',
      'status=201 with numeric id and one binding',
      `status=${createDvRes.status} id=${createDvRes.json?.id} bindings=${createDvRes.json?.bindings?.length}`,
      createDvRes.status === 201
        && Number.isInteger(createDvRes.json?.id)
        && createDvRes.json?.bindings?.length === 1,
    );
    const dvHandlerId = createDvRes.json?.id;

    // Open a second admin tab purely to post the BroadcastChannel message
    // (BC does not deliver to the sending port).
    const adminTab = await browser.newPage();
    await adminTab.setCacheEnabled(false);
    await injectSession(adminTab, adminClient.cookie);
    await adminTab.goto(`${BASE}/admin`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await new Promise(r => setTimeout(r, 300));
    await adminTab.evaluate(() => {
      new BroadcastChannel('card_action_handlers_changed').postMessage({ ts: Date.now() });
    });

    // The listener in salesTab calls loadCardActionHandlers() which re-fetches
    // and re-indexes; poll until the new label resolves.
    const afterBc = await pollPage(
      salesTab,
      (k) => {
        const h = cardActionHandlerFor('sales', k);
        return h ? { id: h.id, type: h.type, name: h.name } : null;
      },
      LBL_KEY_DV,
      7000,
    );
    record(
      'BroadcastChannel triggers salesTab to refresh its handler lookup',
      `cardActionHandlerFor('sales', '${LBL_KEY_DV}') returns the new handler`,
      `got=${JSON.stringify(afterBc)}`,
      !!afterBc && afterBc.id === dvHandlerId && afterBc.type === 'add_design_visit_to_calendar',
    );

    await adminTab.close();

    // ── (B) Click bound label → correct modal → correct backend route ─────────
    //
    // We inject a fake .eq-card-action element with the handler attributes that
    // cardActionHandlerAttrs() would normally emit, then click it.  The
    // delegated capture-phase listener in card-action-handlers.js dispatches
    // based on data-card-action-handler-type.
    console.log('\n  [B] Click-to-open modal + submit to backend');

    // (B.1) design visit handler → datetime-local picker → POST /api/visits
    const FAKE_CONTACT_ID_DV = 'privtest-cah-dv-001';
    await salesTab.evaluate(({ id, name, email, handlerId }) => {
      const div = document.createElement('div');
      div.className = 'eq-card-action';
      div.id = '__cah-test-card-dv';
      div.setAttribute('data-card-action-handler-id',    handlerId);
      div.setAttribute('data-card-action-handler-type',  'add_design_visit_to_calendar');
      div.setAttribute('data-card-action-contact-id',    id);
      div.setAttribute('data-card-action-contact-name',  name);
      div.setAttribute('data-card-action-contact-email', email);
      div.textContent = 'Schedule design visit';
      document.body.appendChild(div);
    }, { id: FAKE_CONTACT_ID_DV, name: 'PrivTest Contact DV', email: 'dv@privtest.local', handlerId: dvHandlerId });

    // Dispatch via JS click() rather than page.click() so we bypass Puppeteer's
    // visibility/scroll heuristics — the element is a bare injected div without
    // explicit positioning and the in-page render loop may have moved DOM
    // around it.  The delegated capture-phase listener still fires.
    await salesTab.evaluate(() => document.getElementById('__cah-test-card-dv').click());
    const dvModalOpened = await pollPage(
      salesTab,
      () => {
        const m = document.querySelector('.cah-backdrop .cah-modal');
        if (!m) return null;
        return {
          hasDatetime: !!m.querySelector('input#cah-dv-start[type="datetime-local"]'),
          hasTitle:    !!m.querySelector('input#cah-dv-title'),
          hasDuration: !!m.querySelector('input#cah-dv-duration'),
          hasTextarea: !!m.querySelector('textarea#cah-dv-notes'),
        };
      },
      null,
      4000,
    );
    record(
      'click on DV-bound card opens the design-visit modal (datetime-local)',
      'modal with #cah-dv-start[type=datetime-local], #cah-dv-title, #cah-dv-duration',
      `got=${JSON.stringify(dvModalOpened)}`,
      !!dvModalOpened && dvModalOpened.hasDatetime && dvModalOpened.hasTitle && dvModalOpened.hasDuration,
    );

    // Capture network requests fired by the modal submit.
    const dvRequests = [];
    const dvReqListener = (req) => {
      const u = req.url();
      if (u.includes('/api/visits') || u.includes('/api/events')) {
        dvRequests.push({ url: u, method: req.method() });
      }
    };
    salesTab.on('request', dvReqListener);

    // The modal pre-fills "Start" with tomorrow at the top of the next hour,
    // so we can submit immediately and accept the default.  Uncheck Google
    // Calendar to keep this test off any /api/events path (which needs OAuth).
    await salesTab.evaluate(() => {
      const cb = document.querySelector('#cah-dv-google');
      if (cb && cb.checked) cb.click();
    });
    await salesTab.click('.cah-backdrop .cah-primary');

    // Wait for the request to fire and the modal to close (or 6 s).
    await pollPage(
      salesTab,
      () => !document.querySelector('.cah-backdrop'),
      null,
      6000,
    );
    salesTab.off('request', dvReqListener);

    const dvVisitReq = dvRequests.find(r => /\/api\/visits(?:$|\?)/.test(r.url) && r.method === 'POST');
    record(
      'DV modal submit POSTs /api/visits',
      'one POST request to /api/visits',
      `requests=${JSON.stringify(dvRequests)}`,
      !!dvVisitReq,
    );
    const dvNotEvents = !dvRequests.some(r => /\/api\/events(?:$|\?)/.test(r.url) && r.method === 'POST');
    record(
      'DV modal submit did NOT call /api/events when Google checkbox is off',
      'no POST /api/events',
      `requests=${JSON.stringify(dvRequests)}`,
      dvNotEvents,
    );
    // Confirm the visit actually landed in the DB.
    const persisted = await pool.query(
      `SELECT id, type, customer_id FROM visits WHERE customer_id = $1`,
      [FAKE_CONTACT_ID_DV],
    );
    record(
      'DV submit persisted a row in the visits table',
      `1 row with type=design and customer_id=${FAKE_CONTACT_ID_DV}`,
      `rows=${persisted.rows.length} types=${persisted.rows.map(r => r.type).join(',')}`,
      persisted.rows.length === 1 && persisted.rows[0].type === 'design',
    );

    // (B.2) phone-summary handler → textarea modal → POST
    //        /api/card-actions/phone-call-summary
    const createPcRes = await adminClient.post('/api/admin/card-action-handlers', {
      name: HANDLER_NAME_PC,
      type: 'summarise_phone_call',
      config: { notePrefix: 'PrivTest call summary' },
      bindings: [{ stage_key: 'sales', status_key: LBL_KEY_PC }],
    });
    record(
      'POST /api/admin/card-action-handlers creates phone-summary handler',
      'status=201 with bindings.length === 1',
      `status=${createPcRes.status} id=${createPcRes.json?.id} bindings=${createPcRes.json?.bindings?.length}`,
      createPcRes.status === 201 && createPcRes.json?.bindings?.length === 1,
    );
    const pcHandlerId = createPcRes.json?.id;

    const FAKE_CONTACT_ID_PC = '7777777777'; // numeric (server validator requires /^\d+$/)
    await salesTab.evaluate(({ id, name, email, handlerId }) => {
      // Force a re-fetch so the in-page lookup knows about the new handler.
      if (typeof window.loadCardActionHandlers === 'function') {
        return window.loadCardActionHandlers().then(() => {
          const div = document.createElement('div');
          div.className = 'eq-card-action';
          div.id = '__cah-test-card-pc';
          div.setAttribute('data-card-action-handler-id',    handlerId);
          div.setAttribute('data-card-action-handler-type',  'summarise_phone_call');
          div.setAttribute('data-card-action-contact-id',    id);
          div.setAttribute('data-card-action-contact-name',  name);
          div.setAttribute('data-card-action-contact-email', email);
          div.textContent = 'Phone call';
          document.body.appendChild(div);
        });
      }
    }, { id: FAKE_CONTACT_ID_PC, name: 'PrivTest Contact PC', email: 'pc@privtest.local', handlerId: pcHandlerId });

    await salesTab.evaluate(() => document.getElementById('__cah-test-card-pc').click());
    const pcModalOpened = await pollPage(
      salesTab,
      () => {
        const m = document.querySelector('.cah-backdrop .cah-modal');
        if (!m) return null;
        return {
          hasTextarea:  !!m.querySelector('textarea#cah-pc-summary'),
          // The phone modal must NOT show the design-visit datetime picker.
          hasDatetime:  !!m.querySelector('input#cah-dv-start'),
        };
      },
      null,
      4000,
    );
    record(
      'click on PC-bound card opens the phone-summary modal (textarea, no datetime)',
      'modal with textarea#cah-pc-summary and no input#cah-dv-start',
      `got=${JSON.stringify(pcModalOpened)}`,
      !!pcModalOpened && pcModalOpened.hasTextarea && !pcModalOpened.hasDatetime,
    );

    const pcRequests = [];
    const pcReqListener = (req) => {
      const u = req.url();
      if (u.includes('/api/card-actions/phone-call-summary')) {
        pcRequests.push({ url: u, method: req.method() });
      }
    };
    salesTab.on('request', pcReqListener);

    await salesTab.evaluate(() => {
      document.querySelector('#cah-pc-summary').value = 'PrivTest call summary body — discussed scope and next steps.';
    });
    await salesTab.click('.cah-backdrop .cah-primary');

    // Wait for the network request to fire (give a generous window — the route
    // returns 503 quickly because HUBSPOT_TOKEN is stripped by the harness, but
    // we only care that the request happened against the right URL).
    await new Promise(r => setTimeout(r, 1200));
    salesTab.off('request', pcReqListener);

    const pcHit = pcRequests.find(
      r => /\/api\/card-actions\/phone-call-summary$/.test(r.url) && r.method === 'POST',
    );
    record(
      'PC modal submit POSTs /api/card-actions/phone-call-summary',
      'one POST request to /api/card-actions/phone-call-summary',
      `requests=${JSON.stringify(pcRequests)}`,
      !!pcHit,
    );

    // ── (C) Substatus binding overrides label binding ─────────────────────────
    //
    // Create handler A (label binding on (sales, LBL_KEY_OVR)) and handler B
    // (substatus binding on subId, whose status_key matches LBL_KEY_OVR
    // uppercased).  cardActionHandlerFor with a substatus value must return B;
    // without one must return A.
    console.log('\n  [C] Substatus binding overrides label binding');

    const createLblRes = await adminClient.post('/api/admin/card-action-handlers', {
      name: HANDLER_NAME_LBL,
      type: 'add_design_visit_to_calendar',
      config: {},
      bindings: [{ stage_key: 'sales', status_key: LBL_KEY_OVR }],
    });
    const createSubRes = await adminClient.post('/api/admin/card-action-handlers', {
      name: HANDLER_NAME_SUB,
      type: 'summarise_phone_call',
      config: {},
      bindings: [{ substatus_id: subId }],
    });
    record(
      'two override-test handlers created (label + substatus)',
      'both 201; substatus binding has substatus_id set',
      `lbl.status=${createLblRes.status} sub.status=${createSubRes.status} sub.bindings=${JSON.stringify(createSubRes.json?.bindings)}`,
      createLblRes.status === 201 && createSubRes.status === 201
        && createSubRes.json?.bindings?.[0]?.substatus_id === subId,
    );
    const lblHandlerId = createLblRes.json?.id;
    const subHandlerId = createSubRes.json?.id;

    // Refresh the salesTab lookup and ensure LEAD_SUBSTATUSES contains our row
    // (the page bootstrap loaded it before, but in case the substatus channel
    // hasn't ticked, re-fetch directly).
    await salesTab.evaluate(async () => {
      if (typeof window.loadCardActionHandlers === 'function') await window.loadCardActionHandlers();
      if (typeof window.loadLeadSubstatuses     === 'function') await window.loadLeadSubstatuses();
    });

    const subsLoaded = await salesTab.evaluate(
      ({ s, k }) => Array.isArray(window.LEAD_SUBSTATUSES)
        && window.LEAD_SUBSTATUSES.some(
          r => String(r.status_key).toUpperCase() === s
            && String(r.substatus_key).toUpperCase() === k
        ),
      { s: SUB_STATUS_K, k: SUB_SUB_K },
    );
    record(
      'salesTab has the test lead_substatus loaded into window.LEAD_SUBSTATUSES',
      `row with status_key=${SUB_STATUS_K} substatus_key=${SUB_SUB_K} present`,
      `present=${subsLoaded}`,
      subsLoaded === true,
    );

    // Without a substatus value → label binding wins.
    const labelOnly = await salesTab.evaluate(
      (k) => {
        const h = cardActionHandlerFor('sales', k);
        return h ? { id: h.id, type: h.type } : null;
      },
      LBL_KEY_OVR,
    );
    record(
      'label binding resolves when no substatus value is passed',
      `cardActionHandlerFor('sales', '${LBL_KEY_OVR}') returns handler A (id=${lblHandlerId})`,
      `got=${JSON.stringify(labelOnly)}`,
      !!labelOnly && labelOnly.id === lblHandlerId,
    );

    // With the matching substatus value → substatus binding wins.
    const subWins = await salesTab.evaluate(
      ({ lbl, sub }) => {
        const h = cardActionHandlerFor('sales', lbl, sub);
        return h ? { id: h.id, type: h.type } : null;
      },
      { lbl: LBL_KEY_OVR, sub: `${SUB_STATUS_K}__${SUB_SUB_K}` },
    );
    record(
      'substatus binding overrides label binding when both exist',
      `cardActionHandlerFor('sales', '${LBL_KEY_OVR}', '${SUB_STATUS_K}__${SUB_SUB_K}') returns handler B (id=${subHandlerId})`,
      `got=${JSON.stringify(subWins)}`,
      !!subWins && subWins.id === subHandlerId && subWins.type === 'summarise_phone_call',
    );

    // Sanity: a substatus value that does NOT match any row must fall back to
    // the label binding (proves the override is not an unconditional bypass).
    const bogusFallsBack = await salesTab.evaluate(
      ({ lbl }) => {
        const h = cardActionHandlerFor('sales', lbl, `${lbl.toUpperCase()}__NOSUCH_${Date.now()}`);
        return h ? { id: h.id, type: h.type } : null;
      },
      { lbl: LBL_KEY_OVR },
    );
    record(
      'unknown substatus value falls back to the label binding',
      `returns handler A (id=${lblHandlerId})`,
      `got=${JSON.stringify(bogusFallsBack)}`,
      !!bogusFallsBack && bogusFallsBack.id === lblHandlerId,
    );

    // ── (D) Conflict-fix flow ─────────────────────────────────────────────────
    //
    // The unique binding index normally prevents two handlers sharing a slot.
    // We temporarily drop it to seed the conflict state that the ⚠ Fix button
    // is designed to resolve, then verify the end-to-end fix flow.
    //
    // Flow:
    //   1. Seed a test lead-status row (stage=SALES) so the slot appears in
    //      the card-actions table, then POST handler A via the API.
    //   2. Drop the unique label-binding index and insert handler B + its
    //      duplicate binding directly in the DB.
    //   3. Open a fresh admin tab, switch to Card actions, wait for the ⚠ Fix
    //      button to appear next to the conflicted slot.
    //   4. Click Fix — assert the resolver modal opens with 2 handler rows.
    //   5. Click Remove on the first row — assert the modal closes and the
    //      ⚠ Fix button is no longer shown for the slot.
    console.log('\n  [D] Conflict-fix flow');

    // Seed a lead status so the conflict slot renders in the card-actions
    // table (the table only shows statuses that have stage=SALES/DESIGN_VISIT/SURVEY).
    await pool.query(
      `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales, stage)
       VALUES ($1, 'PrivTest Conflict Status', 9998, false, 'SALES')
       ON CONFLICT (key) DO UPDATE
         SET label             = EXCLUDED.label,
             sort_order        = EXCLUDED.sort_order,
             excluded_from_sales = EXCLUDED.excluded_from_sales,
             stage             = EXCLUDED.stage`,
      [LBL_KEY_CONFLICT_LS],
    );
    console.log(`  Seeded lead_status_config key=${LBL_KEY_CONFLICT_LS}`);

    // Create handler A via API — this also creates the binding normally.
    const createConflictARes = await adminClient.post('/api/admin/card-action-handlers', {
      name:     HANDLER_NAME_CONFLICT_A,
      type:     'add_design_visit_to_calendar',
      config:   {},
      bindings: [{ stage_key: 'sales', status_key: LBL_KEY_CONFLICT }],
    });
    record(
      '(D) POST handler A for conflict slot returns 201',
      'status=201 with numeric id',
      `status=${createConflictARes.status} id=${createConflictARes.json?.id}`,
      createConflictARes.status === 201 && Number.isInteger(createConflictARes.json?.id),
    );
    const conflictAId = createConflictARes.json?.id;

    // Temporarily drop the unique label-binding index so we can insert a
    // second binding for the same slot — this is the only way to reproduce
    // the conflict state that the Fix button is designed to clear.
    await pool.query('DROP INDEX IF EXISTS cahb_label_uniq');

    // Insert handler B and its duplicate binding directly in the DB.
    const hbInsert = await pool.query(
      `INSERT INTO card_action_handlers (name, type, config)
       VALUES ($1, $2, '{}'::jsonb) RETURNING id`,
      [HANDLER_NAME_CONFLICT_B, 'summarise_phone_call'],
    );
    const conflictBId = hbInsert.rows[0].id;
    await pool.query(
      `INSERT INTO card_action_handler_bindings
         (handler_id, stage_key, status_key, substatus_id)
       VALUES ($1, $2, $3, null)`,
      [conflictBId, 'sales', LBL_KEY_CONFLICT],
    );
    record(
      '(D) handler B seeded directly with the same (sales, LBL_KEY_CONFLICT) binding',
      'DB insert succeeds after unique index drop',
      `conflictAId=${conflictAId} conflictBId=${conflictBId}`,
      Number.isInteger(conflictAId) && Number.isInteger(conflictBId),
    );

    // Open a fresh admin page tab.
    const conflictAdminTab = await browser.newPage();
    await conflictAdminTab.setCacheEnabled(false);
    await injectSession(conflictAdminTab, adminClient.cookie);
    await conflictAdminTab.goto(`${BASE}/admin`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await new Promise(r => setTimeout(r, 400));

    // Switch to the Card actions tab and trigger the data load.
    await conflictAdminTab.evaluate(() => {
      if (typeof switchTab === 'function') switchTab('cardactions');
      const p1 = typeof loadCardActionsAdmin === 'function'
        ? loadCardActionsAdmin() : Promise.resolve();
      const p2 = typeof loadCardActionHandlersAdmin === 'function'
        ? loadCardActionHandlersAdmin() : Promise.resolve();
      return Promise.all([p1, p2]);
    });

    // Wait for the ⚠ Fix button to appear next to our conflict slot.
    const fixBtnVisible = await pollPage(
      conflictAdminTab,
      (lsKey) => {
        const block = document.querySelector(`[data-ls-block="${lsKey}"]`);
        if (!block) return null;
        return block.querySelector('.ca-fix-conflict-btn') ? 'found' : null;
      },
      LBL_KEY_CONFLICT_LS,
      10000,
    );
    record(
      '(D) ⚠ Fix button appears in the card-actions table for the conflicted slot',
      `button.ca-fix-conflict-btn inside [data-ls-block="${LBL_KEY_CONFLICT_LS}"]`,
      `found=${fixBtnVisible}`,
      fixBtnVisible === 'found',
    );

    // Click the Fix button (JS click bypasses Puppeteer visibility checks).
    await conflictAdminTab.evaluate((lsKey) => {
      const block = document.querySelector(`[data-ls-block="${lsKey}"]`);
      const btn   = block && block.querySelector('.ca-fix-conflict-btn');
      if (btn) btn.click();
    }, LBL_KEY_CONFLICT_LS);

    // Assert the conflict-resolver modal opens with 2 handler rows.
    const conflictModalRows = await pollPage(
      conflictAdminTab,
      () => {
        const rows = document.querySelectorAll('.ca-conflict-row');
        return rows.length >= 2 ? rows.length : null;
      },
      null,
      5000,
    );
    record(
      '(D) conflict-resolver modal opens with 2 handler rows',
      '2 .ca-conflict-row elements present',
      `rows=${conflictModalRows}`,
      conflictModalRows === 2,
    );

    // Click Remove on the first row.
    await conflictAdminTab.evaluate(() => {
      const btn = document.querySelector('.ca-conflict-remove-btn');
      if (btn) btn.click();
    });

    // Assert the modal closes once only one handler remains.
    const modalClosed = await pollPage(
      conflictAdminTab,
      () => document.querySelectorAll('.ca-conflict-row').length === 0 ? 'closed' : null,
      null,
      7000,
    );
    record(
      '(D) conflict-resolver modal closes after removing one handler',
      'no .ca-conflict-row elements (modal wrapper removed from DOM)',
      `result=${modalClosed}`,
      modalClosed === 'closed',
    );

    // Assert the "✓ Resolved" green pill appears on the target table row
    // immediately after the modal auto-closes (_flashResolvedBadge is called
    // synchronously right after wrap.remove()).
    const pillVisible = await pollPage(
      conflictAdminTab,
      (statusKey) => {
        const input = document.querySelector(
          `.ca-default-input[data-stage="sales"][data-status="${statusKey}"]`,
        );
        if (!input) return null;
        const row = input.parentElement;
        if (!row) return null;
        return row.querySelector('.ca-resolved-pill') ? 'visible' : null;
      },
      LBL_KEY_CONFLICT,
      3000,
    );
    record(
      '(D) "✓ Resolved" flash pill appears on the table row after modal closes',
      '.ca-resolved-pill visible in the target row within 3 s',
      `result=${pillVisible}`,
      pillVisible === 'visible',
    );

    // The pill fades out after 1500 ms and is removed from the DOM after a
    // further 400 ms (total ~1900 ms).  Wait 2200 ms then assert it is gone.
    await new Promise(r => setTimeout(r, 2200));
    const pillGone = await conflictAdminTab.evaluate((statusKey) => {
      const input = document.querySelector(
        `.ca-default-input[data-stage="sales"][data-status="${statusKey}"]`,
      );
      if (!input) return 'input-missing';
      const row = input.parentElement;
      if (!row) return 'row-missing';
      return row.querySelector('.ca-resolved-pill') ? 'still-present' : 'gone';
    }, LBL_KEY_CONFLICT);
    record(
      '(D) "✓ Resolved" flash pill disappears from DOM after ~2 s',
      '.ca-resolved-pill removed from DOM ~2 s after appearing',
      `result=${pillGone}`,
      pillGone === 'gone',
    );

    // Assert the ⚠ Fix button is no longer shown for the slot.
    // loadCardActionHandlersAdmin() is called inside the Remove handler
    // before the modal is closed, so the badge area is already re-rendered.
    const fixBtnGone = await pollPage(
      conflictAdminTab,
      (lsKey) => {
        const block = document.querySelector(`[data-ls-block="${lsKey}"]`);
        if (!block) return 'block-missing';
        return block.querySelector('.ca-fix-conflict-btn') ? null : 'gone';
      },
      LBL_KEY_CONFLICT_LS,
      6000,
    );
    record(
      '(D) ⚠ Fix button no longer shown after conflict is resolved',
      `no .ca-fix-conflict-btn inside [data-ls-block="${LBL_KEY_CONFLICT_LS}"]`,
      `result=${fixBtnGone}`,
      fixBtnGone === 'gone',
    );

    await conflictAdminTab.close();

    // ── (E) action_name field: badge · data-attr · card-strip label ───────────
    //
    // Seeds a handler with config.action_name = 'send_quote' (type
    // summarise_phone_call, bound to (sales, LBL_KEY_ANAME)) and verifies three
    // things without requiring a real HubSpot token:
    //
    //   E.1  The admin card-actions table renders a badge span whose text
    //        content is exactly "send_quote".
    //   E.2  cardActionHandlerAttrs() returns a string that contains
    //        data-card-action-name="send_quote".
    //   E.3  The title-case expansion used by the Sales card strip label
    //        produces "Send Quote" from the data-card-action-name value.
    console.log('\n  [E] action_name display (badge · data-attr · card-strip label)');

    const createAnameRes = await adminClient.post('/api/admin/card-action-handlers', {
      name:     HANDLER_NAME_ANAME,
      type:     'summarise_phone_call',
      config:   { action_name: 'send_quote' },
      bindings: [{ stage_key: 'sales', status_key: LBL_KEY_ANAME }],
    });
    record(
      '(E) POST handler with action_name="send_quote" returns 201',
      'status=201 with numeric id and one binding',
      `status=${createAnameRes.status} id=${createAnameRes.json?.id} bindings=${createAnameRes.json?.bindings?.length}`,
      createAnameRes.status === 201
        && Number.isInteger(createAnameRes.json?.id)
        && createAnameRes.json?.bindings?.length === 1,
    );

    // E.1 — admin table shows the badge.
    // Open a fresh admin tab, switch to Card actions, poll for a <span> whose
    // text is exactly "send_quote" inside the card-action-handlers panel.
    const anameAdminTab = await browser.newPage();
    await anameAdminTab.setCacheEnabled(false);
    await injectSession(anameAdminTab, adminClient.cookie);
    await anameAdminTab.goto(`${BASE}/admin`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await anameAdminTab.evaluate(() => {
      if (typeof switchTab === 'function') switchTab('cardactions');
      const p1 = typeof loadCardActionsAdmin === 'function'
        ? loadCardActionsAdmin() : Promise.resolve();
      const p2 = typeof loadCardActionHandlersAdmin === 'function'
        ? loadCardActionHandlersAdmin() : Promise.resolve();
      return Promise.all([p1, p2]);
    });

    const anameBadge = await pollPage(
      anameAdminTab,
      (name) => {
        const panel = document.getElementById('card-action-handlers-wrap') || document.body;
        const spans = panel.querySelectorAll('span');
        for (const s of spans) {
          if (s.textContent.trim() === name) return 'found';
        }
        return null;
      },
      'send_quote',
      10000,
    );
    record(
      '(E.1) admin card-actions table renders the send_quote badge',
      'a <span> with text "send_quote" is visible in the card-action-handlers panel',
      `result=${anameBadge}`,
      anameBadge === 'found',
    );

    await anameAdminTab.close();

    // E.2 — cardActionHandlerAttrs() emits data-card-action-name="send_quote".
    // Re-fetch handlers in salesTab so the new binding is indexed, then call
    // cardActionHandlerAttrs() for the (sales, LBL_KEY_ANAME) slot.
    await salesTab.evaluate(() => {
      if (typeof window.loadCardActionHandlers === 'function') {
        return window.loadCardActionHandlers();
      }
    });

    const attrStr = await salesTab.evaluate((lsKey) => {
      if (typeof window.cardActionHandlerAttrs !== 'function') return null;
      return window.cardActionHandlerAttrs('sales', lsKey, null, {
        contactId:    'test-aname-001',
        contactName:  'PrivTest ActionName',
        contactEmail: 'aname@privtest.local',
      });
    }, LBL_KEY_ANAME);
    record(
      '(E.2) cardActionHandlerAttrs emits data-card-action-name="send_quote"',
      'returned string contains data-card-action-name="send_quote"',
      `attrStr=${JSON.stringify(attrStr)}`,
      typeof attrStr === 'string' && attrStr.includes('data-card-action-name="send_quote"'),
    );

    // E.3 — Sales card strip renders "Send Quote" as the .eq-card-action-label.
    // Call enquiryRowHtml() in-page (the actual sales.js rendering function)
    // with a fake contact whose hs_lead_status matches LBL_KEY_ANAME.
    // enquiryRowHtml() calls cardActionHandlerAttrs() internally, extracts
    // data-card-action-name, title-cases it, and writes it into
    // .eq-card-action-label.  Reading the text from the injected HTML proves
    // the real rendering path produces "Send Quote" and not the
    // nextActionLabel fallback (which is empty for this synthetic status key).
    const stripLabel = await salesTab.evaluate((lsKey) => {
      if (typeof enquiryRowHtml !== 'function') return { err: 'enquiryRowHtml not found' };
      const fakeContact = {
        id: 'privtest-cah-e3-contact',
        properties: {
          hs_lead_status:     lsKey,
          hw_lead_substatus:  null,
          email:              'e3@privtest.local',
          firstname:          'PrivTest',
          lastname:           'E3',
          customer_number:    '',
          zip:                '',
          lastmodifieddate:   String(Date.now()),
        },
      };
      const fakeEntry = {
        contact:    fakeContact,
        stageKey:   'sales',
        substageId: null,
        sourceId:   null,
        stageTime:  Date.now(),
        priority:   2,
        badgeLabel: null,
        roomIdx:    undefined,
      };
      try {
        const html = enquiryRowHtml(fakeEntry);
        const wrap = document.createElement('div');
        wrap.id = '__cah-e3-card-wrap';
        wrap.innerHTML = html;
        document.body.appendChild(wrap);
        const labelEl = wrap.querySelector('.eq-card-action-label');
        const text = labelEl ? labelEl.textContent.trim() : null;
        wrap.remove();
        return { label: text };
      } catch (ex) {
        return { err: String(ex) };
      }
    }, LBL_KEY_ANAME);
    record(
      '(E.3) Sales card strip .eq-card-action-label reads "Send Quote" via enquiryRowHtml()',
      '"Send Quote" (title-cased action_name overrides nextActionLabel fallback)',
      `got=${JSON.stringify(stripLabel)}`,
      stripLabel?.label === 'Send Quote',
    );

    await salesTab.close();
  } finally {
    await browser.close().catch(() => {});
  }

  // ── summary & report ──────────────────────────────────────────────────────
  const pass = findings.filter(f => f.ok).length;
  const fail = findings.filter(f => !f.ok).length;
  console.log(`\n  Results: ${pass} passed, ${fail} failed`);

  await writeReport(runId, findings);
  await cleanupAndExit(fail > 0 ? 1 : 0);
}

// ── report writer ─────────────────────────────────────────────────────────────
async function writeReport(runId, findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Card Action Handlers — E2E Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:card-action-handlers\``,
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
    '- **(API pre-checks)**: verify `GET /api/admin/card-action-handlers` and',
    '  `GET /api/card-action-handlers` respond before any browser tab opens.',
    '- **(PRIV) Member-privilege probes** — 3 pure-REST probes that confirm a',
    '  regular approved member is blocked (403) from mutating admin routes:',
    '  - PRIV-01: member POST `/api/admin/card-action-handlers` → 403.',
    '  - PRIV-02: member PATCH `/api/admin/card-action-handlers/:id` → 403.',
    '  - PRIV-03: member DELETE `/api/admin/card-action-handlers/:id` → 403.',
    '- **(NEG) Negative-path validation probes** — 18 pure-REST probes that',
    '  POST or PATCH `/api/admin/card-action-handlers` with each known-bad',
    '  payload and assert the server returns 400 with a descriptive error:',
    '  - NEG-01/02/03: `defaultDurationMin` below 5, above 1440, non-numeric.',
    '  - NEG-04: `config` is an array (not a JSON object).',
    '  - NEG-05: `config` payload > 4 KB.',
    '  - NEG-06: `defaultTitle` > 120 chars is rejected with 400.',
    '  - NEG-07: `notePrefix` > 120 chars is rejected with 400.',
    '  - NEG-08/09: `show_message` with absent or overlong `message`.',
    '  - NEG-10: unknown handler type.',
    '  - NEG-11: `name` > 80 chars.',
    '  - NEG-12: binding with an invalid `stage_key`.',
    '  - NEG-13: binding with illegal `status_key` characters (uppercase / special).',
    '  - NEG-14: binding with neither `stage_key` nor `substatus_id`.',
    '  - NEG-15/16: `substatus_id` = 0 or a non-numeric string.',
    '  - NEG-17: PATCH with `defaultDurationMin` < 5.',
    '  - NEG-18: PATCH with an invalid binding `stage_key`.',
    '  Both handler types (`add_design_visit_to_calendar`, `summarise_phone_call`)',
    '  and both binding shapes (label and substatus) are exercised.',
    '- **(A) BroadcastChannel cross-tab refresh**: a second same-browser tab',
    '  posts `card_action_handlers_changed`; the Sales-tab listener re-fetches',
    '  and its `cardActionHandlerFor()` lookup resolves the newly-created',
    '  handler.  Also confirms the lookup starts empty (no stale state).',
    '- **(B) Click → modal → backend route**: an injected `.eq-card-action`',
    '  element bound to each handler type is clicked.  The design-visit',
    '  handler must open a datetime-local picker and submit to `/api/visits`',
    '  (verified both via Puppeteer network interception and a follow-up DB',
    '  query confirming the row landed).  The phone-summary handler must open',
    '  a textarea modal and submit to `/api/card-actions/phone-call-summary`',
    '  (verified via network interception — the route returns 503 in this',
    '  harness because HUBSPOT_TOKEN is stripped, which is irrelevant to the',
    '  URL-routing assertion).',
    '- **(C) Substatus binding overrides label binding**: with handler A bound',
    '  to (sales, LBL) and handler B bound to a substatus whose status_key',
    '  matches LBL, `cardActionHandlerFor()` returns A when no substatus value',
    '  is passed and B when the matching substatus value is passed.  A bogus',
    '  substatus value falls back to A, confirming the override is conditional.',
    '- **(D) Conflict-fix flow**: a test lead-status row (stage=SALES) is',
    '  seeded so the slot appears in the card-actions table.  Handler A is',
    '  created via the API; the unique label-binding index is then temporarily',
    '  dropped and handler B is inserted directly in the DB with the same',
    '  (sales, LBL_KEY_CONFLICT) binding — the only way to reproduce the',
    '  conflict state the Fix button is designed to clear.  The harness then',
    '  opens a fresh admin tab, switches to the Card actions panel, and waits',
    '  for the ⚠ Fix button to appear beside the conflicted slot.  Clicking Fix',
    '  must open the conflict-resolver modal with exactly 2 handler rows;',
    '  clicking Remove on one row must close the modal, flash a "✓ Resolved"',
    '  green pill on the target table row (visible within 3 s of modal close,',
    '  gone from the DOM within ~2 s after appearing), and remove the ⚠ Fix',
    '  button from the badge area.  `purgeFixtures()` re-creates the unique',
    '  index after deleting the conflicting rows.',
    '- **(E) action_name display**: a handler is seeded with',
    '  `config.action_name = "send_quote"` bound to `(sales, LBL_KEY_ANAME)`.',
    '  Three assertions confirm the field flows end-to-end:',
    '  - **E.1** A fresh admin tab switches to the Card actions panel and',
    '    polls until a `<span>` whose text is exactly `"send_quote"` is',
    '    visible inside `#card-action-handlers-wrap` (the badge rendered by',
    '    `_handlerSummaryHtml` in `admin.html`).',
    '  - **E.2** After re-fetching handlers in the Sales tab,',
    '    `cardActionHandlerAttrs(\'sales\', LBL_KEY_ANAME, null, ctx)` returns',
    '    a string containing `data-card-action-name="send_quote"`.',
    '  - **E.3** `enquiryRowHtml()` is called in-page (the real `sales.js`',
    '    rendering function) with a fake contact whose `hs_lead_status`',
    '    matches `LBL_KEY_ANAME`.  The resulting HTML is injected into the',
    '    DOM and the text of `.eq-card-action-label` is read directly,',
    '    asserting it equals `"Send Quote"`.  Because `LBL_KEY_ANAME` is a',
    '    synthetic key absent from the workflow config, `nextActionLabel()`',
    '    returns empty — proving `_cahName` wins over the fallback.',
    '',
    '## Notes',
    '',
    '- The test server strips `HUBSPOT_TOKEN`, so the phone-summary route is',
    '  exercised at the URL-routing level only (its HubSpot mutation cannot',
    '  succeed in this harness).  The design-visit handler\'s primary backend',
    '  (`/api/visits`) does not require HubSpot, so the database write is',
    '  verified end-to-end.',
    '- Fixtures (handlers by name, the test lead_substatus row, the conflict',
    '  test lead-status row, and the synthetic `privtest-cah-*` visits) are',
    '  purged in `cleanupAndExit()`.  The unique label-binding index is',
    '  recreated there after the conflicting rows are removed.',
  ];
  const outPath = path.join(dir, 'card-action-handlers.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Report: test-results/card-action-handlers.md`);
}

main();
