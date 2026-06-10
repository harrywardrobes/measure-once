'use strict';
const { makeSkip } = require('../helpers/report');

const PROBE_LABELS = [
  '(D) conflict-fix flow end-to-end — conflict banner, Fix button, resolver modal',
  '(E) POST handler with action_name="send_quote" returns 201',
  '(F) editor modal opens via openHandlerEditor() with #cah-action-name input',
  '(H) POST handler with intermediateLeadStatus returns 201',
  '(I) Group for no-label/no-handler lead status is hidden',
  '(J) [data-testid="no-label-warning"] chip visible for bound-but-unlabelled slot',
  '(M) Blank-action_label sub-status produces no .adm-handlers-slot-label row',
  '(Q) ensureSubstatusHandlerBindings auto-binds on boot',
  '(R) default_handler_type column drives the bound handler type',
];

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
//       (MUI DateTimePicker for add_design_visit_to_calendar, textarea
//       for summarise_phone_call) and submitting the form posts to the
//       expected backend route.
//   (C) Substatus binding wins over a label binding when both exist for the
//       same (stage_key, status_key) the substatus belongs to.
//   (D) Conflict-fix flow: the ⚠ Fix button appears for a duplicate-bound
//       slot and the resolver modal removes the conflict end-to-end. Also
//       covers the admin in-page conflict banner
//       (#card-action-handlers-conflict-banner) — D.banner-1: appears and
//       lists the conflicting slot; D.banner-2: its Fix button opens the
//       resolver modal for the right slot; D.banner-3: disappears once the
//       duplicate is removed.
//       D.modal-1: the resolver is a MuiDialog-root element whose visible
//       DialogTitle reads "Fix conflicting handlers" (guards the React Dialog
//       migration from task #1673).
//   (E) action_name field: a handler seeded with config.action_name =
//       'send_quote' shows the badge in the admin table (E.1), causes
//       cardActionHandlerAttrs() to emit data-card-action-name="send_quote"
//       (E.2), and the title-case label expansion yields "Send Quote" (E.3).
//   (F) action_name snake_case enforcement in the admin editor modal:
//       (F.1) Entering an invalid value ("Send Quote") into #cah-action-name
//             and blurring shows the #cah-action-name-err message, and
//             clicking Save leaves the modal open with a #cah-edit-err
//             message and does not POST a handler.
//       (F.2) Entering a valid snake_case value clears the inline error and
//             clicking Save closes the modal and creates the handler via
//             POST /api/admin/card-action-handlers.
//   (L) Sub-status slot rows render for labelled sub-statuses: a
//       lead_substatuses row with a non-empty action_label produces a visible
//       slot row — L.1 checks .adm-handlers-slot-label text equals the
//       action_label value; L.2 checks .adm-handlers-slot-sub text matches
//       the "Sub-status · <label>" pattern.  Guards ActionHandlersPage.tsx
//       lines 232-239 against regressions that hide or skip sub-status rows.
//   (M) Blank-action_label sub-status produces no slot row: a slot-level
//       negative guard complementing probe (I).  Uses the same
//       LBL_KEY_FALLBACK_STATUS fixture (no stage-action label, one sub-status
//       with empty action_label, no bound handler).  Asserts that no
//       .adm-handlers-slot-label element appears for that sub-status inside
//       #card-action-handlers-wrap — either the group is absent entirely or,
//       if present, it contains zero slot-label rows.  Guards the
//       `if (!action) continue` guard in ActionHandlersPage.tsx line 243.
//   (N) Sub-status delete bound-handler warning: seeds a sub-status + a
//       card_action_handler_bindings row pointing at it via substatus_id.
//       N.1 — clicking .adm-ca-sub-delete on the bound row opens the MUI
//       Dialog titled "Handler still bound to this sub-status".  N.2 — Cancel
//       closes the dialog; the row stays in the DOM.  N.3 — clicking delete
//       again and confirming "Delete anyway" removes the row from the DOM.
//       N.4 — the lead_substatuses DB row is gone.  N.5 — deleting an unbound
//       sub-status shows no dialog.  N.6 — unbound row is gone from the DOM.
//       Guards the deleteCardActionSubstatus callback in CardActionsPage.tsx.
//   (R) Handler-bound indicator: the Default handler type Select has opacity
//       0.5 when a handler binding exists for the substatus (R.1) and opacity
//       1 when no binding exists (R.2).  Guards the `hasBinding` dimming logic
//       in CardActionsPage.tsx against silent removal.
//   (Q) Startup seeding: ensureSubstatusHandlerBindings auto-binds on boot.
//       Pure-API + DB probe (no browser, requires one server restart).
//       Three lead_substatuses rows are seeded — one with no existing binding
//       (qSub1), one with a pre-existing summarise_phone_call binding
//       (qSub2), and one whose substatus_key is present in
//       SUBSTATUS_HANDLER_MAP (qSub3, key AWPH_RECEIVED) — then the server
//       is killed and a fresh instance is spawned.
//       Q.1 — qSub1 receives a new card_action_handler_bindings row with
//             handler type show_message (FALLBACK_HANDLER — substatus_key
//             PRIVTEST_Q_UNBOUND is absent from SUBSTATUS_HANDLER_MAP).
//             Binding is polled because ensureSubstatusHandlerBindings runs
//             async inside app.listen() after HTTP is already accepting.
//       Q.2 — qSub2 keeps the same handler_id after the restart (the routine
//             skips substatuses already present in the boundIds set so admin
//             overrides are never silently overwritten).
//       Q.3 — qSub3 receives a new binding whose handler type is
//             review_customer_photos — the value from SUBSTATUS_HANDLER_MAP
//             for the AWPH_RECEIVED key — not the show_message fallback.
//             Covers the map-lookup branch of ensureSubstatusHandlerBindings.
//   (R) default_handler_type column: verifies that the admin-configured
//       default_handler_type column on lead_substatuses takes priority over
//       SUBSTATUS_HANDLER_MAP when non-empty, and that SUBSTATUS_HANDLER_MAP
//       still wins when default_handler_type is NULL/empty.
//       Pure-API + DB probe (no browser, requires one server restart after Q).
//       Two lead_substatuses rows are seeded under a separate status_key —
//       rSub1 has default_handler_type = 'start_design_visit' (no prior
//       binding), rSub2 has NULL default_handler_type and substatus_key
//       AWPH_RECEIVED (present in SUBSTATUS_HANDLER_MAP) — then a fresh
//       server is spawned.
//       R.1 — rSub1 receives a binding with handler type start_design_visit,
//             confirming that default_handler_type is read from the column
//             and used directly, bypassing SUBSTATUS_HANDLER_MAP and
//             FALLBACK_HANDLER.
//       R.2 — rSub2 receives a binding with handler type
//             review_customer_photos (from SUBSTATUS_HANDLER_MAP), confirming
//             that SUBSTATUS_HANDLER_MAP lookup is not skipped when
//             default_handler_type is empty.
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

const { pollUntil, pollFn } = require('../helpers/poll');
const { clickMuiSelect } = require('../helpers/mui-select');

// ── fixtures ──────────────────────────────────────────────────────────────────
// Use lowercase letters/digits/underscores only — these are what the server-side
// label-binding validator (_validateHandlerBinding) accepts for status_key.
const LBL_KEY_DV       = 'privtest_cah_dv';       // bound to add_design_visit_to_calendar
const LBL_KEY_SV       = 'privtest_cah_sv';        // bound to schedule_visit (survey type)
const LBL_KEY_PC       = 'privtest_cah_pc';        // bound to summarise_phone_call
const LBL_KEY_OVR      = 'privtest_cah_ovr';       // (sales, this) -> handler A (label binding)
const SUB_STATUS_K     = 'PRIVTEST_CAH_OVR';       // matching status_key (uppercase in lead_substatuses)
const SUB_SUB_K        = 'PRIVTEST_SUB';
// (D) conflict-fix fixtures
const LBL_KEY_CONFLICT    = 'privtest_cah_conflict'; // status_key for conflicting bindings (lowercase)
const LBL_KEY_CONFLICT_LS = 'PRIVTEST_CAH_CONFLICT'; // key in lead_status_config (uppercase, stage=SALES)
// (E) action_name display fixtures
const LBL_KEY_ANAME       = 'privtest_cah_aname';    // status_key for the action_name probe
// (F) action_name snake_case enforcement fixtures
const LBL_KEY_NAMING      = 'privtest_cah_naming';   // status_key for the editor-modal naming probe
// (H) intermediateLeadStatus on wizard open
const LBL_KEY_ILS         = 'privtest_cah_ils';      // status_key for the intermediateLeadStatus probe
const INTERMEDIATE_LS     = 'PRIVTEST_INPROGRESS';   // value sent on PATCH /api/contacts/:id when wizard opens
// (I) fallback slot visibility — regression guard for task #1722
// Uppercase because it must match lead_status_config.key exactly for the FK on lead_substatuses.
const LBL_KEY_FALLBACK_STATUS = 'PRIVTEST_CAH_FALLBACK'; // lead_status_config.key + substatus status_key
// (L) sub-status slot row rendering — regression guard for task #1731
const LBL_KEY_SUB_ROW         = 'PRIVTEST_CAH_SUB_ROW';  // lead_status_config.key for sub-status slot row probe
// (N) bound-handler warning on label clear — regression guard for task #1741
const LBL_KEY_CLEAR_WARN       = 'PRIVTEST_CAH_CLEAR_WARN';  // lead_status_config.key (uppercase)
const LBL_KEY_CLEAR_WARN_LOWER = 'privtest_cah_clear_warn';  // binding status_key (lowercase)
const HANDLER_NAME_CLEAR_WARN  = 'PrivTest clear-warn handler';
const CLEAR_WARN_STATUS_LABEL  = 'PrivTest ClearWarn Status';
const CLEAR_WARN_LABEL         = 'PrivTest Book Appointment';
// (O) sub-status delete bound-handler warning — regression guard for task #1740
const LBL_KEY_DEL_WARN        = 'PRIVTEST_CAH_DEL_WARN'; // lead_status_config.key for probe (O)
// (P) stale lead-status warning in handler editor — regression guard for task #1761
const LBL_KEY_STALE_SLOT    = 'PRIVTEST_CAH_STALE'; // lead_status_config.key for the slot (uppercase)
const LBL_KEY_STALE_BINDING = 'privtest_cah_stale'; // binding status_key (lowercase)
const STALE_INTER_LS        = 'privtest_stale_inter_nonexistent'; // intermediateLeadStatus that no longer exists
const STALE_SUB_LS          = 'privtest_stale_sub_nonexistent';   // submittedLeadStatus that no longer exists
const HANDLER_NAME_STALE    = 'PrivTest stale-status handler';
const HANDLER_NAME_STALE_SUB = 'PrivTest stale-sub handler';
// (Q) startup seeding — ensureSubstatusHandlerBindings — regression guard for task #1818
// uppercase because lead_status_config.key is always stored uppercase
const LBL_KEY_STARTUP            = 'PRIVTEST_CAH_STARTUP';
// (R) handler-bound indicator — opacity on Default handler type selector
const LBL_KEY_BOUND_IND      = 'PRIVTEST_CAH_BOUND_IND'; // lead_status_config.key (uppercase)
const HANDLER_NAME_BOUND_IND = 'PrivTest bound-indicator handler';
// NOT in SUBSTATUS_HANDLER_MAP → falls through to FALLBACK_HANDLER (show_message, empty config)
const SUB_STARTUP_UNBOUND_K      = 'PRIVTEST_Q_UNBOUND';
// second substatus: pre-existing binding should survive the restart unchanged
const SUB_STARTUP_PREBOUND_K     = 'PRIVTEST_Q_PREBOUND';
const HANDLER_NAME_Q_PRE         = 'PrivTest Q pre-existing handler';
// third substatus: key present in SUBSTATUS_HANDLER_MAP → should resolve to review_customer_photos
const SUB_STARTUP_MAPPED_K       = 'AWPH_RECEIVED';
// (R) default_handler_type column — regression guard for task #1825
// Separate status_key so Q and R fixtures never collide in the same substatus group.
const LBL_KEY_DEFAULT_TYPE       = 'PRIVTEST_CAH_DEFTYPE';
// R.1: has default_handler_type = 'start_design_visit' → binding type must match
const SUB_DEFAULT_TYPE_K         = 'PRIVTEST_R_DEFTYPE';
// R.2: NULL default_handler_type + substatus_key in SUBSTATUS_HANDLER_MAP → review_customer_photos
const SUB_DEFAULT_MAPPED_K       = 'AWPH_RECEIVED';

const HANDLER_NAME_DV         = 'PrivTest design visit handler';
const HANDLER_NAME_SV         = 'PrivTest schedule-visit handler';
const HANDLER_NAME_PC         = 'PrivTest phone summary handler';
const HANDLER_NAME_LBL        = 'PrivTest label-binding handler';
const HANDLER_NAME_SUB        = 'PrivTest substatus-binding handler';
const HANDLER_NAME_CONFLICT_A = 'PrivTest conflict handler A';
const HANDLER_NAME_CONFLICT_B = 'PrivTest conflict handler B';
const HANDLER_NAME_ANAME      = 'PrivTest action-name handler';
const HANDLER_NAME_NAMING     = 'PrivTest naming handler';
const HANDLER_NAME_ILS        = 'PrivTest intermediate-status handler';
const HANDLER_NAME_DEL_WARN   = 'PrivTest del-warn handler';

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
       WHERE name IN ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [HANDLER_NAME_DV, HANDLER_NAME_SV, HANDLER_NAME_PC, HANDLER_NAME_LBL, HANDLER_NAME_SUB,
     HANDLER_NAME_CONFLICT_A, HANDLER_NAME_CONFLICT_B, HANDLER_NAME_ANAME,
     HANDLER_NAME_NAMING, HANDLER_NAME_ILS, 'PrivTest orphan cleanup handler',
     HANDLER_NAME_CLEAR_WARN, HANDLER_NAME_DEL_WARN, HANDLER_NAME_STALE,
     HANDLER_NAME_STALE_SUB, HANDLER_NAME_BOUND_IND]
  );
  // Prefix sweep: a previously crashed or partly-validated probe run can
  // leave behind handlers whose names don't match the constants above
  // (e.g. an unnamed handler "" created before validation rejected it) but
  // whose bindings still occupy privtest_cah_* slots. Those stale bindings
  // poison later "no conflicts anywhere" assertions in probe (D). Delete
  // the parent handlers — the FK cascade clears the bindings.  Tables may
  // not exist on first run, so wrap in try/catch.
  try {
    await pool.query(
      `DELETE FROM card_action_handlers
         WHERE id IN (
           SELECT DISTINCT handler_id
             FROM card_action_handler_bindings
            WHERE status_key LIKE 'privtest_cah_%'
         )`
    );
  } catch (_) {}
  // Defensive: in case any binding ever exists without a parent handler
  // (shouldn't happen — FK is NOT NULL — but cheap insurance).
  try {
    await pool.query(
      `DELETE FROM card_action_handler_bindings
         WHERE status_key LIKE 'privtest_cah_%'`
    );
  } catch (_) {}
  // Catalogue-reorder fixtures (probe G).  Tables may not exist on first run.
  try {
    await pool.query(`DELETE FROM design_visit_handles          WHERE name LIKE 'privtest-reorder-%'`);
  } catch (_) {}
  try {
    await pool.query(`DELETE FROM design_visit_furniture_ranges WHERE name LIKE 'privtest-reorder-%'`);
  } catch (_) {}
  try {
    await pool.query(`DELETE FROM design_visit_door_styles      WHERE name LIKE 'privtest-reorder-%'`);
  } catch (_) {}
  await pool.query(
    `DELETE FROM lead_substatuses
       WHERE status_key = $1 AND substatus_key = $2`,
    [SUB_STATUS_K, SUB_SUB_K]
  );
  // (I) probe fallback-slot substatus
  try {
    await pool.query(
      `DELETE FROM lead_substatuses WHERE status_key = $1`,
      [LBL_KEY_FALLBACK_STATUS]
    );
  } catch (_) {}
  // (L) probe sub-status slot row substatus
  try {
    await pool.query(
      `DELETE FROM lead_substatuses WHERE status_key = $1`,
      [LBL_KEY_SUB_ROW]
    );
  } catch (_) {}
  // (N) probe del-warn substatuses
  try {
    await pool.query(
      `DELETE FROM lead_substatuses WHERE status_key = $1`,
      [LBL_KEY_DEL_WARN]
    );
  } catch (_) {}
  // (Q) probe startup-seeding substatuses
  try {
    await pool.query(
      `DELETE FROM lead_substatuses WHERE status_key = $1`,
      [LBL_KEY_STARTUP]
    );
  } catch (_) {}
  // (R) probe bound-indicator substatuses
  try {
    await pool.query(
      `DELETE FROM lead_substatuses WHERE status_key = $1`,
      [LBL_KEY_BOUND_IND]
    );
  } catch (_) {}
  // (Q) probe pre-existing handler (by name — binding and substatus cascade-delete separately)
  try {
    await pool.query(
      `DELETE FROM card_action_handlers WHERE name = $1`,
      [HANDLER_NAME_Q_PRE]
    );
  } catch (_) {}
  // (Q.3) auto-created review_customer_photos handler.  Only delete it when it
  // has no remaining bindings so shared-DB real AWPH bindings are never removed.
  // In an isolated test DB it will have no bindings once the Q substatus row
  // (and its cascade-deleted binding) are gone.  The substatus DELETE above runs
  // first so this NOT EXISTS check is safe.
  try {
    await pool.query(
      `DELETE FROM card_action_handlers
         WHERE name = 'Review customer photos'
           AND NOT EXISTS (
             SELECT 1 FROM card_action_handler_bindings
              WHERE handler_id = card_action_handlers.id
           )`
    );
  } catch (_) {}
  // (R) probe default_handler_type substatuses
  try {
    await pool.query(
      `DELETE FROM lead_substatuses WHERE status_key = $1`,
      [LBL_KEY_DEFAULT_TYPE]
    );
  } catch (_) {}
  // (R.1) auto-created start_design_visit handler.  Only delete when no
  // remaining bindings reference it — shared-DB real bindings are never removed.
  try {
    await pool.query(
      `DELETE FROM card_action_handlers
         WHERE name = 'Start design visit'
           AND NOT EXISTS (
             SELECT 1 FROM card_action_handler_bindings
              WHERE handler_id = card_action_handlers.id
           )`
    );
  } catch (_) {}
  // lead_status_config row for LBL_KEY_DEFAULT_TYPE is cleaned up by the
  // WHERE LOWER(key) LIKE 'privtest_cah_%' DELETE below.
  await pool.query(
    `DELETE FROM visits WHERE customer_id LIKE 'privtest-cah-%'`
  );
  // Remove all privtest_cah_* lead_status_config rows seeded by this suite.
  // Must run AFTER lead_substatuses deletes above so FK constraints don't
  // block this DELETE.  The LOWER(key) LIKE pattern covers both the
  // early-setup seeds (DV/SV/PC/OVR/ILS/NAMING) and the per-probe seeds
  // (CONFLICT, ANAME, FALLBACK, THROWAWAY, ORPHAN, etc.) regardless of
  // whether they were stored in upper- or lower-case.
  try {
    await pool.query(
      `DELETE FROM lead_status_config WHERE LOWER(key) LIKE 'privtest_cah_%'`
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
  return pollUntil(page, fn, timeoutMs, intervalMs, arg !== undefined && arg !== null ? [arg] : []);
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

  // ── boot test server ───────────────────────────────────────────────────────
  // The server creates all core schema tables (users, allowed_emails, sessions,
  // password_set_tokens, etc.) on boot, so seedUsers must run after the server
  // is up — especially when using a fresh isolated database.
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

  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  admin=${users.admin.email}`);

  // The server creates card_action_handlers / card_action_handler_bindings /
  // lead_substatuses asynchronously inside its app.listen() callback (after
  // HTTP starts accepting requests).  Wait for them to appear before touching
  // fixtures.
  const waitForTable = async (name) => {
    const found = await pollFn(async () => {
      const r = await pool.query(`SELECT to_regclass($1) AS t`, [name]);
      return r.rows[0].t || null;
    }, 15000, 200);
    if (!found) throw new Error(`Timed out waiting for table ${name} to be created on server boot`);
  };
  await waitForTable('card_action_handlers');
  await waitForTable('card_action_handler_bindings');
  await waitForTable('lead_substatuses');
  await waitForTable('visits');

  await purgeFixtures(pool);
  // Parent row required by lead_substatuses.status_key FK
  // (`lead_substatuses_status_key_fk`). Without this the seed insert below
  // crashes with a 23503 on a fresh DB.
  await pool.query(
    `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales, stage)
     VALUES ($1, 'PrivTest CAH OVR Status', 9997, false, 'SALES')
     ON CONFLICT (key) DO UPDATE
       SET label               = EXCLUDED.label,
           sort_order          = EXCLUDED.sort_order,
           excluded_from_sales = EXCLUDED.excluded_from_sales,
           stage               = EXCLUDED.stage`,
    [SUB_STATUS_K]
  );
  const subRes = await pool.query(
    `INSERT INTO lead_substatuses (status_key, substatus_key, label, action_label, sort_order)
     VALUES ($1, $2, 'PrivTest sub label', '', 9999)
     RETURNING id`,
    [SUB_STATUS_K, SUB_SUB_K]
  );
  const subId = subRes.rows[0].id;
  console.log(`  Inserted lead_substatus id=${subId} (${SUB_STATUS_K}__${SUB_SUB_K})`);

  // Seed the label-binding status keys used by probes (A), (B), (H), (F.2).
  // The server validates that every label binding's status_key exists in
  // lead_status_config (LOWER(key) match).  These keys are purged on both
  // entry (purgeFixtures above) and exit so they don't pollute the shared DB.
  const fixtureLabelKeys = [
    [LBL_KEY_DV,    'PrivTest CAH DV Status',     9990],
    [LBL_KEY_SV,    'PrivTest CAH SV Status',      9991],
    [LBL_KEY_PC,    'PrivTest CAH PC Status',      9992],
    [LBL_KEY_ILS,   'PrivTest CAH ILS Status',     9993],
    [LBL_KEY_NAMING,'PrivTest CAH Naming Status',  9994],
  ];
  for (const [key, label, sortOrder] of fixtureLabelKeys) {
    await pool.query(
      `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales, stage)
       VALUES ($1, $2, $3, false, 'SALES')
       ON CONFLICT (key) DO UPDATE
         SET label               = EXCLUDED.label,
             sort_order          = EXCLUDED.sort_order,
             excluded_from_sales = EXCLUDED.excluded_from_sales,
             stage               = EXCLUDED.stage`,
      [key, label, sortOrder]
    );
  }
  console.log(`  Seeded lead_status_config fixture keys: ${fixtureLabelKeys.map(r => r[0]).join(', ')}`);

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
  //
  // action_name format probes (POST):
  //   NEG-19  config.action_name with spaces + punctuation (not snake_case) → 400
  //   NEG-20  config.action_name with valid snake_case → 201 (happy path)
  //
  // status_key existence probes:
  //   NEG-21  POST with a well-formed but unknown status_key → 400
  //   NEG-22  PATCH with a well-formed but unknown status_key → 400
  //   NEG-23  POST with a known existing status_key → 201 (happy-path guard)
  //   NEG-24  PATCH with a known existing status_key → 200 (happy-path guard)
  //
  // __global__ binding probes:
  //   NEG-25  POST with stage_key='__global__' and status_key='' → 201 (accepted)
  //   NEG-26  POST with stage_key='__global__' and non-empty status_key → 400
  //   NEG-27  PATCH with stage_key='__global__' and status_key='' → 200 (accepted)
  //   NEG-28  PATCH with stage_key='__global__' and non-empty status_key → 400

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

  // NEG-19: POST handler with config.action_name containing spaces + punctuation
  // (not snake_case).  Once the dedicated snake_case validator lands (see the
  // "Block invalid action names from being saved via the API" project task),
  // the server must reject this with 400 before it reaches the database.
  {
    const r = await adminClient.post('/api/admin/card-action-handlers', {
      name: 'privtest-neg19',
      type: 'summarise_phone_call',
      config: { action_name: 'Send Quote!' },
      bindings: [],
    });
    assertBadRequest(
      'NEG-19: POST with non-snake_case config.action_name rejected',
      r,
      'action_name',
    );
    // Best-effort cleanup in case validation regressed and the row was created.
    if (r.json?.id) await adminClient.delete(`/api/admin/card-action-handlers/${r.json.id}`);
  }

  // NEG-20: happy-path companion to NEG-19 — a valid snake_case action_name
  // must still be accepted (201), confirming the validator does not over-reach.
  {
    const r = await adminClient.post('/api/admin/card-action-handlers', {
      name: 'privtest-neg20',
      type: 'summarise_phone_call',
      config: { action_name: 'send_quote' },
      bindings: [],
    });
    const ok = r.status === 201 && Number.isInteger(r.json?.id);
    record(
      'NEG-20: POST with valid snake_case config.action_name accepted',
      'status=201 with integer id',
      `status=${r.status} id=${JSON.stringify(r.json?.id)}`,
      ok,
    );
    if (r.json?.id) await adminClient.delete(`/api/admin/card-action-handlers/${r.json.id}`);
  }

  // NEG-21: POST with a well-formed but unknown status_key (does not exist in
  // lead_status_config) — must be rejected with 400 before hitting the FK.
  {
    const r = await adminClient.post('/api/admin/card-action-handlers', {
      name: '',
      type: 'summarise_phone_call',
      config: {},
      bindings: [{ stage_key: 'sales', status_key: 'nonexistent_status_key_xyz' }],
    });
    assertBadRequest('NEG-21: POST with unknown status_key rejected', r, 'status_key');
  }

  // NEG-22: PATCH with a well-formed but unknown status_key — must also be
  // rejected with 400 before hitting the FK.
  {
    const scaffoldRes = await adminClient.post('/api/admin/card-action-handlers', {
      name: 'privtest-neg22-scaffold',
      type: 'summarise_phone_call',
      config: {},
      bindings: [],
    });
    const scaffoldId = scaffoldRes.json?.id;
    if (scaffoldId) {
      const r = await adminClient.patch(`/api/admin/card-action-handlers/${scaffoldId}`, {
        bindings: [{ stage_key: 'sales', status_key: 'nonexistent_status_key_xyz' }],
      });
      assertBadRequest('NEG-22: PATCH with unknown status_key rejected', r, 'status_key');
      await adminClient.delete(`/api/admin/card-action-handlers/${scaffoldId}`);
    } else {
      record(
        'NEG-22: PATCH with unknown status_key rejected',
        'status=400 with error containing "status_key"',
        `skipped — scaffold POST failed (status=${scaffoldRes.status})`,
        false,
      );
    }
  }

  // NEG-23: POST with a known existing status_key — must be accepted (201).
  // Guards against over-rejection: the validator must not block valid bindings.
  // Fetches the first available key from lead_status_config dynamically so the
  // probe is correct regardless of whether the DB was seeded from HubSpot or
  // from the hardcoded defaults.
  {
    const statusListRes = await adminClient.get('/api/admin/lead-statuses');
    const firstStatus = Array.isArray(statusListRes.json)
      ? statusListRes.json.find(s => !s.is_null_row)
      : null;
    if (firstStatus?.key) {
      const knownKey = String(firstStatus.key).toLowerCase();
      const r = await adminClient.post('/api/admin/card-action-handlers', {
        name: 'privtest-neg23',
        type: 'summarise_phone_call',
        config: {},
        bindings: [{ stage_key: 'sales', status_key: knownKey }],
      });
      const ok = r.status === 201 && Number.isInteger(r.json?.id);
      record(
        'NEG-23: POST with known existing status_key accepted',
        'status=201 with integer id',
        `status=${r.status} id=${JSON.stringify(r.json?.id)} key="${knownKey}"`,
        ok,
      );
      if (r.json?.id) await adminClient.delete(`/api/admin/card-action-handlers/${r.json.id}`);
    } else {
      record(
        'NEG-23: POST with known existing status_key accepted',
        'status=201 with integer id',
        `skipped — no real lead statuses found in DB (statusList status=${statusListRes.status})`,
        false,
      );
    }
  }

  // NEG-24: PATCH with a known existing status_key — must be accepted (200).
  // Companion happy-path probe for PATCH, mirroring NEG-23.
  {
    const statusListRes = await adminClient.get('/api/admin/lead-statuses');
    const firstStatus = Array.isArray(statusListRes.json)
      ? statusListRes.json.find(s => !s.is_null_row)
      : null;
    const scaffoldRes = await adminClient.post('/api/admin/card-action-handlers', {
      name: 'privtest-neg24-scaffold',
      type: 'summarise_phone_call',
      config: {},
      bindings: [],
    });
    const scaffoldId = scaffoldRes.json?.id;
    if (scaffoldId && firstStatus?.key) {
      const knownKey = String(firstStatus.key).toLowerCase();
      const r = await adminClient.patch(`/api/admin/card-action-handlers/${scaffoldId}`, {
        bindings: [{ stage_key: 'sales', status_key: knownKey }],
      });
      const ok = r.status === 200 && Number.isInteger(r.json?.id);
      record(
        'NEG-24: PATCH with known existing status_key accepted',
        'status=200 with integer id',
        `status=${r.status} id=${JSON.stringify(r.json?.id)} key="${knownKey}"`,
        ok,
      );
      await adminClient.delete(`/api/admin/card-action-handlers/${scaffoldId}`);
    } else {
      if (scaffoldId) await adminClient.delete(`/api/admin/card-action-handlers/${scaffoldId}`);
      record(
        'NEG-24: PATCH with known existing status_key accepted',
        'status=200 with integer id',
        `skipped — scaffold POST failed (status=${scaffoldRes.status}) or no real statuses in DB`,
        false,
      );
    }
  }

  // NEG-25: POST with stage_key='__global__' and status_key='' — must be
  // accepted (201).  Guards against the validator rejecting the "No lead
  // status" binding slot that __global__ represents.
  {
    const r = await adminClient.post('/api/admin/card-action-handlers', {
      name: 'privtest-neg25',
      type: 'summarise_phone_call',
      config: {},
      bindings: [{ stage_key: '__global__', status_key: '' }],
    });
    const ok = r.status === 201 && Number.isInteger(r.json?.id);
    record(
      'NEG-25: POST with __global__ stage_key and empty status_key accepted',
      'status=201 with integer id',
      `status=${r.status} id=${JSON.stringify(r.json?.id)}`,
      ok,
      ok ? '' : JSON.stringify(r.json),
    );
    if (r.json?.id) await adminClient.delete(`/api/admin/card-action-handlers/${r.json.id}`);
  }

  // NEG-26: POST with stage_key='__global__' and a non-empty status_key —
  // must be rejected with 400.  The __global__ sentinel only supports
  // status_key='' (the "No lead status" row), mirroring the guard in the
  // label PUT endpoint.
  {
    const r = await adminClient.post('/api/admin/card-action-handlers', {
      name: '',
      type: 'summarise_phone_call',
      config: {},
      bindings: [{ stage_key: '__global__', status_key: 'some_status' }],
    });
    assertBadRequest('NEG-26: POST with __global__ stage_key and non-empty status_key rejected', r, '__global__');
  }

  // NEG-27: PATCH an existing handler with stage_key='__global__' and
  // status_key='' — must be accepted (200).  Companion PATCH happy-path for
  // the __global__ binding slot, mirroring NEG-25 for POST.
  {
    const scaffoldRes = await adminClient.post('/api/admin/card-action-handlers', {
      name: 'privtest-neg27-scaffold',
      type: 'summarise_phone_call',
      config: {},
      bindings: [],
    });
    const scaffoldId = scaffoldRes.json?.id;
    if (scaffoldId) {
      const r = await adminClient.patch(`/api/admin/card-action-handlers/${scaffoldId}`, {
        bindings: [{ stage_key: '__global__', status_key: '' }],
      });
      const ok = r.status === 200 && Number.isInteger(r.json?.id);
      record(
        'NEG-27: PATCH with __global__ stage_key and empty status_key accepted',
        'status=200 with integer id',
        `status=${r.status} id=${JSON.stringify(r.json?.id)}`,
        ok,
        ok ? '' : JSON.stringify(r.json),
      );
      await adminClient.delete(`/api/admin/card-action-handlers/${scaffoldId}`);
    } else {
      record(
        'NEG-27: PATCH with __global__ stage_key and empty status_key accepted',
        'status=200 with integer id',
        `skipped — scaffold POST failed (status=${scaffoldRes.status})`,
        false,
      );
    }
  }

  // NEG-28: PATCH an existing handler with stage_key='__global__' and a
  // non-empty status_key — must be rejected with 400.  Companion PATCH
  // negative probe, mirroring NEG-26 for POST.
  {
    const scaffoldRes = await adminClient.post('/api/admin/card-action-handlers', {
      name: 'privtest-neg28-scaffold',
      type: 'summarise_phone_call',
      config: {},
      bindings: [],
    });
    const scaffoldId = scaffoldRes.json?.id;
    if (scaffoldId) {
      const r = await adminClient.patch(`/api/admin/card-action-handlers/${scaffoldId}`, {
        bindings: [{ stage_key: '__global__', status_key: 'something' }],
      });
      assertBadRequest('NEG-28: PATCH with __global__ stage_key and non-empty status_key rejected', r, '__global__');
      await adminClient.delete(`/api/admin/card-action-handlers/${scaffoldId}`);
    } else {
      record(
        'NEG-28: PATCH with __global__ stage_key and non-empty status_key rejected',
        'status=400 with error containing "__global__"',
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
    for (const l of PROBE_LABELS) {
      skip(l, 'puppeteer installed', 'puppeteer not installed');
    }
    await writeReport(runId, findings);
    await cleanupAndExit(1);
    return;
  }

  // Locate the system Chromium via the shared helper (auto-discovers Nix paths).
  const { findChromium } = require('../shared/find-chromium');
  const executablePath = findChromium() || undefined;

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      defaultViewport: { width: 1280, height: 800 },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  } catch (e) {
    for (const l of PROBE_LABELS) {
      skip(l, 'browser launched', `browser launch failed: ${e.message}`);
    }
    await writeReport(runId, findings);
    await cleanupAndExit(1);
    return;
  }

  try {
    // ── (A) BroadcastChannel cross-tab refresh ────────────────────────────────
    //
    // Tab 1 = /projects — the React ProjectsPage island mounts
    //                     useCardActionHandlers, which registers
    //                     window.cardActionHandlerFor and hooks into the
    //                     card_action_handlers_changed BroadcastChannel.
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
    await salesTab.goto(`${BASE}/projects`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    // Wait for the React island (ProjectsPage → useCardActionHandlers) to
    // mount and register window.cardActionHandlerFor via its useEffect.
    await pollPage(salesTab, () => typeof window.cardActionHandlerFor === 'function', null, 15000);
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

    // (B.1) design visit handler → MUI DateTimePicker modal → POST /api/visits
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
        const m = document.querySelector('[role=dialog]');
        if (!m) return null;
        return {
          hasDatetime: !!m.querySelector('input#cah-dv-start'),
          hasTitle:    !!m.querySelector('input#cah-dv-title'),
          hasDuration: !!m.querySelector('input#cah-dv-duration'),
          hasTextarea: !!m.querySelector('textarea#cah-dv-notes'),
        };
      },
      null,
      4000,
    );
    record(
      'click on DV-bound card opens the design-visit modal (DateTimePicker)',
      'modal with #cah-dv-start, #cah-dv-title, #cah-dv-duration',
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
    await salesTab.click('[data-testid=cah-primary]');

    // Wait for the request to fire and the modal to close (or 6 s).
    await pollPage(
      salesTab,
      () => !document.querySelector('[data-testid=cah-primary]'),
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

    // (B.1b) schedule_visit handler (visitType=survey) → MUI DateTimePicker → POST /api/visits type=survey
    const FAKE_CONTACT_ID_SV = 'privtest-cah-sv-001';
    const createSvRes = await adminClient.post('/api/admin/card-action-handlers', {
      name: HANDLER_NAME_SV,
      type: 'schedule_visit',
      config: {
        visitType:          'survey',
        defaultDurationMin: 60,
      },
      bindings: [{ stage_key: 'sales', status_key: LBL_KEY_SV }],
    });
    record(
      'POST /api/admin/card-action-handlers creates schedule_visit handler (survey)',
      'status=201',
      `status=${createSvRes.status} id=${createSvRes.json?.id}`,
      createSvRes.status === 201 && !!createSvRes.json?.id,
    );
    const svHandlerId = createSvRes.json?.id;

    if (svHandlerId) {
      // Reload the handler cache so cardActionHandlerById returns the full SV
      // handler (including config.visitType:'survey') before the card is clicked.
      await salesTab.evaluate(async () => {
        if (typeof window.loadCardActionHandlers === 'function') await window.loadCardActionHandlers();
      });

      await salesTab.evaluate(({ id, name, email, handlerId }) => {
        const div = document.createElement('div');
        div.className = 'eq-card-action';
        div.id = '__cah-test-card-sv';
        div.setAttribute('data-card-action-handler-id',    handlerId);
        div.setAttribute('data-card-action-handler-type',  'schedule_visit');
        div.setAttribute('data-card-action-contact-id',    id);
        div.setAttribute('data-card-action-contact-name',  name);
        div.setAttribute('data-card-action-contact-email', email);
        div.textContent = 'Schedule survey';
        document.body.appendChild(div);
      }, { id: FAKE_CONTACT_ID_SV, name: 'PrivTest Contact SV', email: 'sv@privtest.local', handlerId: svHandlerId });

      await salesTab.evaluate(() => document.getElementById('__cah-test-card-sv').click());
      const svModalOpened = await pollPage(
        salesTab,
        () => {
          const m = document.querySelector('[role=dialog]');
          if (!m) return null;
          return {
            hasStart:    !!m.querySelector('input#cah-dv-start'),
            hasTitle:    !!m.querySelector('input#cah-dv-title'),
            hasDuration: !!m.querySelector('input#cah-dv-duration'),
          };
        },
        null,
        4000,
      );
      record(
        'click on schedule_visit-bound card opens the visit modal (DateTimePicker)',
        'modal with #cah-dv-start, #cah-dv-title, #cah-dv-duration',
        `got=${JSON.stringify(svModalOpened)}`,
        !!svModalOpened && svModalOpened.hasStart && svModalOpened.hasTitle && svModalOpened.hasDuration,
      );

      const svRequests = [];
      const svReqListener = (req) => {
        const u = req.url();
        if (u.includes('/api/visits')) svRequests.push({ url: u, method: req.method() });
      };
      salesTab.on('request', svReqListener);

      await salesTab.click('[data-testid=cah-primary]');
      await pollPage(
        salesTab,
        () => !document.querySelector('[data-testid=cah-primary]'),
        null,
        6000,
      );
      salesTab.off('request', svReqListener);

      const svVisitReq = svRequests.find(r => /\/api\/visits(?:$|\?)/.test(r.url) && r.method === 'POST');
      record(
        'schedule_visit modal submit POSTs /api/visits',
        'one POST to /api/visits',
        `requests=${JSON.stringify(svRequests)}`,
        !!svVisitReq,
      );

      const svPersisted = await pool.query(
        `SELECT id, type, customer_id FROM visits WHERE customer_id = $1`,
        [FAKE_CONTACT_ID_SV],
      );
      record(
        'schedule_visit submit persisted a survey row in the visits table',
        `1 row with type=survey and customer_id=${FAKE_CONTACT_ID_SV}`,
        `rows=${svPersisted.rows.length} types=${svPersisted.rows.map(r => r.type).join(',')}`,
        svPersisted.rows.length === 1 && svPersisted.rows[0].type === 'survey',
      );
    }

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
        const m = document.querySelector('[role=dialog]');
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
      const el = document.querySelector('#cah-pc-summary');
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      nativeSetter.call(el, 'PrivTest call summary body — discussed scope and next steps.');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await salesTab.click('[data-testid=cah-primary]');

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
      if (typeof window.loadLeadSubstatuses === 'function') {
        await window.loadLeadSubstatuses();
      } else {
        // Fallback for pages that don't mount WorkflowDataProvider (e.g. /projects):
        // fetch substatuses directly and populate the global used by the diagnostic check.
        try {
          const res = await fetch('/api/lead-substatuses');
          if (res.ok) window.LEAD_SUBSTATUSES = await res.json();
        } catch (_) {}
      }
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

    // (D.api-1) GET /api/admin/card-action-handlers/conflicts (admin) returns
    // the seeded duplicate slot.
    {
      const r = await adminClient.get('/api/admin/card-action-handlers/conflicts');
      const total = Number(r.json?.total);
      const arr   = Array.isArray(r.json?.conflicts) ? r.json.conflicts : [];
      const slot  = arr.find(c =>
        c && c.type === 'label'
          && c.stage_key === 'sales'
          && c.status_key === LBL_KEY_CONFLICT,
      );
      const handlerIds = Array.isArray(slot?.handler_ids) ? slot.handler_ids : [];
      const idsOk = handlerIds.includes(conflictAId) && handlerIds.includes(conflictBId);
      record(
        '(D) GET /api/admin/card-action-handlers/conflicts returns the seeded duplicate',
        `status=200, total>=1, conflict for (sales, ${LBL_KEY_CONFLICT}) listing handlers ${conflictAId} & ${conflictBId}`,
        `status=${r.status} total=${total} slot=${JSON.stringify(slot)}`,
        r.status === 200 && total >= 1 && !!slot && Number(slot.count) >= 2 && idsOk,
      );
    }

    // (D.api-2) Non-admin (member) is blocked from the conflicts endpoint.
    {
      const r = await memberClient.get('/api/admin/card-action-handlers/conflicts');
      const blocked = r.status === 401 || r.status === 403 || r.status === 302;
      record(
        '(D) GET /api/admin/card-action-handlers/conflicts blocks non-admin members',
        'status=403 (or 401/302)',
        `status=${r.status}`,
        blocked,
      );
    }

    // (D.api-3) Unauthenticated requests are rejected (no session cookie).
    {
      const res = await fetch(`${BASE}/api/admin/card-action-handlers/conflicts`, {
        redirect: 'manual',
      });
      const blocked = res.status === 401 || res.status === 403 || res.status === 302;
      record(
        '(D) GET /api/admin/card-action-handlers/conflicts blocks unauthenticated requests',
        'status=401/403/302',
        `status=${res.status}`,
        blocked,
      );
    }

    // Open a fresh admin page tab.
    const conflictAdminTab = await browser.newPage();
    await conflictAdminTab.setCacheEnabled(false);
    await injectSession(conflictAdminTab, adminClient.cookie);
    await conflictAdminTab.goto(`${BASE}/admin`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await new Promise(r => setTimeout(r, 400));

    // Switch to the Card actions tab so CardActionsPage mounts (needed so
    // the slot-label DOM inputs exist for _buildActionSlotGroups), then switch
    // to the Action handlers tab so ActionHandlersPage mounts and exposes
    // window.loadCardActionHandlersAdmin.  Both React components auto-fetch
    // on mount; after the page-function poll we also call the load helpers
    // explicitly to guarantee fresh data before the banner check.
    await conflictAdminTab.evaluate(() => {
      if (typeof switchTab === 'function') switchTab('cardactions');
    });
    // Brief pause for CardActionsPage to mount before switching away.
    await new Promise(r => setTimeout(r, 400));
    await conflictAdminTab.evaluate(() => {
      if (typeof switchTab === 'function') switchTab('actionhandlers');
    });
    // Wait for ActionHandlersPage to mount and expose loadCardActionHandlersAdmin.
    await pollPage(
      conflictAdminTab,
      () => typeof window.loadCardActionHandlersAdmin === 'function',
      null,
      10000,
    );
    await conflictAdminTab.evaluate(async () => {
      const p1 = typeof loadCardActionsAdmin === 'function'
        ? loadCardActionsAdmin() : Promise.resolve();
      const p2 = typeof loadCardActionHandlersAdmin === 'function'
        ? loadCardActionHandlersAdmin() : Promise.resolve();
      return Promise.all([p1, p2]);
    });

    // (D.banner-1) The in-page conflict banner
    // (#card-action-handlers-conflict-banner) appears once
    // loadCardActionHandlersAdmin() finishes and the conflict count > 0. Its
    // body must list our conflicted slot — the lead-status label
    // "PrivTest Conflict Status" — and both handler names.
    const bannerState = await pollPage(
      conflictAdminTab,
      () => {
        const banner = document.getElementById('card-action-handlers-conflict-banner');
        if (!banner) return null;
        if (banner.style.display === 'none') return null;
        if (!banner.innerHTML.trim()) return null;
        return {
          visible: true,
          text:    banner.textContent || '',
          fixBtns: banner.querySelectorAll('[data-cah-fix]').length,
        };
      },
      null,
      10000,
    );
    const bannerListsSlot =
      !!bannerState
      && bannerState.text.includes('PrivTest Conflict Status')
      && bannerState.text.includes(HANDLER_NAME_CONFLICT_A)
      && bannerState.text.includes(HANDLER_NAME_CONFLICT_B)
      && bannerState.fixBtns >= 1;
    record(
      '(D.banner-1) conflict banner is visible and lists the conflicting slot',
      '#card-action-handlers-conflict-banner shown; body mentions slot label + both handler names; ≥1 [data-cah-fix] button',
      `state=${JSON.stringify(bannerState)}`,
      bannerListsSlot,
    );

    // (D.banner-2) Clicking the banner's Fix button opens the conflict
    // resolver modal for the correct slot. We assert the modal lists both
    // seeded handlers, then close it so the existing in-table Fix flow below
    // remains the authoritative path that actually removes a handler.
    await conflictAdminTab.evaluate(() => {
      const banner = document.getElementById('card-action-handlers-conflict-banner');
      const btn    = banner && banner.querySelector('[data-cah-fix]');
      if (btn) btn.click();
    });
    const bannerModalState = await pollPage(
      conflictAdminTab,
      (names) => {
        const rows = document.querySelectorAll('.ca-conflict-row');
        if (rows.length < 2) return null;
        const text = document.body.textContent || '';
        // Modal heading mentions the slot via the lead-status label.
        const hasSlot = text.includes('PrivTest Conflict Status');
        const hasA    = text.includes(names[0]);
        const hasB    = text.includes(names[1]);
        return { rows: rows.length, hasSlot, hasA, hasB };
      },
      [HANDLER_NAME_CONFLICT_A, HANDLER_NAME_CONFLICT_B],
      5000,
    );
    record(
      '(D.banner-2) Banner Fix button opens the conflict-resolver modal for the right slot',
      'modal shows ≥2 .ca-conflict-row entries and references the conflicted slot + both handler names',
      `state=${JSON.stringify(bannerModalState)}`,
      !!bannerModalState
        && bannerModalState.rows >= 2
        && bannerModalState.hasSlot
        && bannerModalState.hasA
        && bannerModalState.hasB,
    );

    // Close the modal without removing anything so the existing in-table
    // flow below still has 2 handlers bound to the slot.
    await conflictAdminTab.evaluate(() => {
      const closeBtn = document.getElementById('ca-conflict-close');
      if (closeBtn) closeBtn.click();
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

    // (D.modal-1) The conflict resolver must be a MUI React Dialog
    // (.MuiDialog-root) whose visible DialogTitle reads exactly
    // "Fix conflicting handlers".  This guards the migration from the
    // old DOM-appended modal to a React Dialog (task #1673): if anyone
    // accidentally reverts to a plain DOM modal, or changes the title
    // text, this probe will fail.
    const muiDialogState = await pollPage(
      conflictAdminTab,
      () => {
        const root = document.querySelector('[data-testid="conflict-resolver-dialog"]');
        if (!root) return null;
        // DialogTitle renders as an element with role="heading" or an <h2>
        // inside the dialog; either way its text must include the expected string.
        const titleEl = root.querySelector('[data-testid="conflict-resolver-title"]');
        const titleText = titleEl ? (titleEl.textContent || '').trim() : '';
        return {
          hasMuiRoot: true,
          titleText,
          titleOk: titleText === 'Fix conflicting handlers',
        };
      },
      null,
      5000,
    );
    record(
      '(D.modal-1) conflict resolver is a MuiDialog-root with title "Fix conflicting handlers"',
      '.MuiDialog-root present; .MuiDialogTitle-root text = "Fix conflicting handlers"',
      `state=${JSON.stringify(muiDialogState)}`,
      !!muiDialogState && muiDialogState.hasMuiRoot && muiDialogState.titleOk,
    );

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
        const row = input.closest('[data-testid="ca-default-row"]');
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
      const row = input.closest('[data-testid="ca-default-row"]');
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

    // (D.banner-3) Once the duplicate is removed, the banner must no longer
    // reference our seeded slot. The banner may still be visible if the shared
    // DB has unrelated pre-existing conflicts from other (broken) probes, so
    // we assert per-slot rather than globally: either the banner is hidden
    // and empty, OR it remains visible but no longer mentions our slot label
    // or either seeded handler name.
    const bannerCleared = await pollPage(
      conflictAdminTab,
      ({ slotLabel, nameA, nameB }) => {
        const banner = document.getElementById('card-action-handlers-conflict-banner');
        if (!banner) return 'missing';
        const hidden = banner.style.display === 'none' && banner.innerHTML.trim() === '';
        if (hidden) return 'hidden';
        const text = banner.textContent || '';
        if (text.includes(slotLabel) || text.includes(nameA) || text.includes(nameB)) {
          return null;
        }
        return 'cleared';
      },
      {
        slotLabel: 'PrivTest Conflict Status',
        nameA: HANDLER_NAME_CONFLICT_A,
        nameB: HANDLER_NAME_CONFLICT_B,
      },
      6000,
    );
    record(
      '(D.banner-3) conflict banner no longer references the resolved slot',
      '#card-action-handlers-conflict-banner is hidden, OR visible but free of the seeded slot label + both seeded handler names',
      `result=${bannerCleared}`,
      bannerCleared === 'hidden' || bannerCleared === 'cleared',
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

    // Seed LBL_KEY_ANAME into lead_status_config so ActionHandlersPage
    // renders a slot for that binding and HandlerSummary shows the badge.
    await pool.query(
      `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales, stage)
       VALUES ($1, 'PrivTest ANAME Status', 9997, false, 'SALES')
       ON CONFLICT (key) DO UPDATE
         SET label               = EXCLUDED.label,
             sort_order          = EXCLUDED.sort_order,
             excluded_from_sales = EXCLUDED.excluded_from_sales,
             stage               = EXCLUDED.stage`,
      [LBL_KEY_ANAME],
    );
    console.log(`  Seeded lead_status_config key=${LBL_KEY_ANAME}`);

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
    });
    await new Promise(r => setTimeout(r, 400));
    await anameAdminTab.evaluate(() => {
      if (typeof switchTab === 'function') switchTab('actionhandlers');
    });
    await pollPage(
      anameAdminTab,
      () => typeof window.loadCardActionHandlersAdmin === 'function',
      null,
      10000,
    );
    await anameAdminTab.evaluate(() => {
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

    // ── (H) intermediateLeadStatus PATCH fired on wizard open ────────────────
    //
    // Seeds a `start_design_visit` handler with `config.intermediateLeadStatus`
    // set and bound to (sales, LBL_KEY_ILS).  Clicking a bound `.eq-card-action`
    // strip must:
    //   H.1  Fire a PATCH /api/contacts/:id whose JSON body carries
    //        `hs_lead_status` equal to the configured intermediate value.
    //   H.2  Still open the wizard (.dv-wizard-backdrop visible) even though
    //        the PATCH returns non-2xx — the harness strips HUBSPOT_TOKEN, so
    //        PATCH /api/contacts/:id naturally returns 503 via
    //        `requireHubspotToken`, exercising the .catch / non-ok branch in
    //        public/card-action-handlers.js lines 388–395.
    console.log('\n  [H] intermediateLeadStatus PATCH on wizard open');

    const createIlsRes = await adminClient.post('/api/admin/card-action-handlers', {
      name:     HANDLER_NAME_ILS,
      type:     'start_design_visit',
      config:   { intermediateLeadStatus: INTERMEDIATE_LS, defaultDurationMin: 90 },
      bindings: [{ stage_key: 'sales', status_key: LBL_KEY_ILS }],
    });
    record(
      '(H) POST handler with intermediateLeadStatus returns 201',
      `status=201; config.intermediateLeadStatus="${INTERMEDIATE_LS}"`,
      `status=${createIlsRes.status} id=${createIlsRes.json?.id} ils=${createIlsRes.json?.config?.intermediateLeadStatus}`,
      createIlsRes.status === 201
        && Number.isInteger(createIlsRes.json?.id)
        && createIlsRes.json?.config?.intermediateLeadStatus === INTERMEDIATE_LS,
    );
    const ilsHandlerId = createIlsRes.json?.id;

    // Capture PATCH /api/contacts/:id requests with their body.
    const ilsPatches = [];
    const ilsReqListener = (req) => {
      const u = req.url();
      if (req.method() === 'PATCH' && /\/api\/contacts\/[^/?#]+(?:$|\?)/.test(u)) {
        let body = null;
        try { body = JSON.parse(req.postData() || 'null'); } catch {}
        ilsPatches.push({ url: u, body });
      }
    };
    salesTab.on('request', ilsReqListener);

    const FAKE_CONTACT_ID_ILS = 'privtest-cah-ils-001';
    await salesTab.evaluate(({ id, name, email, handlerId }) => {
      if (typeof window.loadCardActionHandlers === 'function') {
        return window.loadCardActionHandlers().then(() => {
          const div = document.createElement('div');
          div.className = 'eq-card-action';
          div.id = '__cah-test-card-ils';
          div.setAttribute('data-card-action-handler-id',    handlerId);
          div.setAttribute('data-card-action-handler-type',  'start_design_visit');
          div.setAttribute('data-card-action-contact-id',    id);
          div.setAttribute('data-card-action-contact-name',  name);
          div.setAttribute('data-card-action-contact-email', email);
          div.textContent = 'Start design visit';
          document.body.appendChild(div);
        });
      }
    }, { id: FAKE_CONTACT_ID_ILS, name: 'PrivTest Contact ILS', email: 'ils@privtest.local', handlerId: ilsHandlerId });

    await salesTab.evaluate(() => document.getElementById('__cah-test-card-ils').click());

    // H.2 — wizard opens despite the PATCH failure path.
    const wizardOpened = await pollPage(
      salesTab,
      () => document.querySelector('.dv-wizard') ? 'open' : null,
      null,
      6000,
    );
    record(
      '(H.2) wizard opens even though PATCH /api/contacts/:id returns non-2xx',
      '.dv-wizard present (HUBSPOT_TOKEN-stripped harness → PATCH 503)',
      `result=${wizardOpened}`,
      wizardOpened === 'open',
    );

    // Give the in-flight PATCH a moment to land in our request log.
    await new Promise(r => setTimeout(r, 600));
    salesTab.off('request', ilsReqListener);

    // H.1 — PATCH /api/contacts/<FAKE_CONTACT_ID_ILS> was issued with the
    // configured intermediate status as the hs_lead_status body field.
    const ilsHit = ilsPatches.find(p =>
      p.url.includes(`/api/contacts/${FAKE_CONTACT_ID_ILS}`)
        && p.body && p.body.hs_lead_status === INTERMEDIATE_LS,
    );
    record(
      '(H.1) PATCH /api/contacts/:id fired with hs_lead_status on wizard open',
      `one PATCH to /api/contacts/${FAKE_CONTACT_ID_ILS} with body.hs_lead_status="${INTERMEDIATE_LS}"`,
      `patches=${JSON.stringify(ilsPatches)}`,
      !!ilsHit,
    );

    // Close the wizard so we leave the page clean for any later probes.
    await salesTab.evaluate(() => {
      const panel = document.querySelector('.dv-wizard');
      if (panel) {
        const btn = panel.querySelector('button[aria-label="Close"]');
        if (btn) btn.click();
      }
    });

    await salesTab.close();

    // ── (F) action_name snake_case enforcement in the editor modal ────────────
    //
    // Drives the admin "Add action" modal via openHandlerEditor() and asserts
    // both client-side validation paths added in task #623:
    //   (F.1) Invalid value ("Send Quote") + blur → #cah-action-name-err
    //         becomes visible; clicking #cah-save leaves the modal open with
    //         a non-empty #cah-edit-err message and does not create a handler
    //         (POST /api/admin/card-action-handlers count is unchanged).
    //   (F.2) Valid snake_case value + blur → inline error hidden; clicking
    //         #cah-save closes the modal (wrapper removed) and the new
    //         handler appears in GET /api/admin/card-action-handlers with the
    //         expected config.action_name.
    console.log('\n  [F] action_name snake_case enforcement in the editor modal');

    // Count existing fixtures before opening the modal so we can assert that
    // the invalid-save attempt did not create a handler.
    const beforeListRes = await adminClient.get('/api/admin/card-action-handlers');
    const beforeCount = Array.isArray(beforeListRes.json)
      ? beforeListRes.json.filter(h => h.name === HANDLER_NAME_NAMING).length
      : 0;

    const namingAdminTab = await browser.newPage();
    await namingAdminTab.setCacheEnabled(false);
    await injectSession(namingAdminTab, adminClient.cookie);
    await namingAdminTab.goto(`${BASE}/admin`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    // Switch to cardactions so CardActionsPage mounts (needed for slot-label
    // DOM inputs used by _buildActionSlotGroups), wait briefly, then switch to
    // actionhandlers so ActionHandlersPage mounts and exposes openHandlerEditor.
    await namingAdminTab.evaluate(() => {
      if (typeof switchTab === 'function') switchTab('cardactions');
    });
    await new Promise(r => setTimeout(r, 400));
    await namingAdminTab.evaluate(() => {
      if (typeof switchTab === 'function') switchTab('actionhandlers');
    });
    // Wait for ActionHandlersPage to mount and expose openHandlerEditor.
    await pollPage(
      namingAdminTab,
      () => typeof window.openHandlerEditor === 'function',
      null,
      10000,
    );
    await namingAdminTab.evaluate(async () => {
      const p1 = typeof loadCardActionsAdmin === 'function'
        ? loadCardActionsAdmin() : Promise.resolve();
      const p2 = typeof loadCardActionHandlersAdmin === 'function'
        ? loadCardActionHandlersAdmin() : Promise.resolve();
      return Promise.all([p1, p2]);
    });

    // Track POST requests to /api/admin/card-action-handlers so we can prove
    // the invalid-save attempt did not hit the network.
    const namingPosts = [];
    namingAdminTab.on('request', req => {
      const u = req.url();
      if (/\/api\/admin\/card-action-handlers(?:$|\?)/.test(u) && req.method() === 'POST') {
        namingPosts.push({ url: u });
      }
    });

    // Open the editor modal in "Add" mode for a fresh (sales, LBL_KEY_NAMING)
    // slot.  openHandlerEditor() does not require the slot to exist in the
    // card-actions table — it only uses stage_key/status_key for the binding.
    // openHandlerEditor() triggers a React state update so the modal DOM is not
    // present synchronously — poll until #cah-action-name appears.
    const fnMissing = await namingAdminTab.evaluate((statusKey) => {
      if (typeof window.openHandlerEditor !== 'function') return true;
      window.openHandlerEditor(
        { kind: 'label', stage_key: 'sales', status_key: statusKey },
        null,
      );
      return false;
    }, LBL_KEY_NAMING);
    const openedPoll = fnMissing
      ? null
      : await pollPage(
          namingAdminTab,
          () => document.querySelector('#cah-action-name') ? 'opened' : null,
          null,
          5000,
        );
    const opened = fnMissing ? 'fn-missing' : (openedPoll || 'no-input');
    record(
      '(F) editor modal opens via openHandlerEditor() with #cah-action-name input',
      'opened',
      `result=${opened}`,
      opened === 'opened',
    );

    // Switch the type to summarise_phone_call so no required config fields
    // block the save path; we only want to exercise the action_name guard.
    await namingAdminTab.evaluate(() => {
      const sel = document.querySelector('#cah-type');
      if (!sel) return;
      sel.value = 'summarise_phone_call';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // ── (F.1) invalid value path ──────────────────────────────────────────────
    await namingAdminTab.evaluate(() => {
      const input = document.querySelector('#cah-action-name');
      if (!input) return;
      // Use the native value setter so React's onChange fires on the controlled input.
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(input, 'Send Quote');
      input.dispatchEvent(new Event('input',  { bubbles: true }));
      input.dispatchEvent(new Event('blur',   { bubbles: true }));
    });

    const invalidErrShown = await namingAdminTab.evaluate(() => {
      const err = document.querySelector('#cah-action-name-err');
      if (!err) return 'err-missing';
      const style = window.getComputedStyle(err);
      return style.display !== 'none' ? 'visible' : 'hidden';
    });
    record(
      '(F.1) #cah-action-name-err becomes visible after blurring an invalid value',
      'computed style.display !== "none"',
      `result=${invalidErrShown}`,
      invalidErrShown === 'visible',
    );

    // Click Save — buildPayload() should return null, so the modal stays open,
    // #cah-edit-err shows an explanatory message, and no POST is sent.
    const beforeClickPosts = namingPosts.length;
    await namingAdminTab.evaluate(() => {
      const btn = document.querySelector('#cah-save');
      if (btn) btn.click();
    });
    // Give doSave() a chance to fire if validation accidentally let through.
    await new Promise(r => setTimeout(r, 400));

    const invalidSaveState = await namingAdminTab.evaluate(() => {
      const modal   = document.querySelector('#cah-action-name');
      const editErr = document.querySelector('#cah-edit-err');
      return {
        modalOpen: !!modal,
        editErrText: editErr ? editErr.textContent.trim() : null,
      };
    });
    record(
      '(F.1) clicking Save with an invalid action_name leaves the modal open with a #cah-edit-err message',
      'modalOpen=true, editErrText non-empty, no POST sent',
      `modalOpen=${invalidSaveState.modalOpen} editErrText=${JSON.stringify(invalidSaveState.editErrText)} postsDelta=${namingPosts.length - beforeClickPosts}`,
      invalidSaveState.modalOpen
        && typeof invalidSaveState.editErrText === 'string'
        && invalidSaveState.editErrText.length > 0
        && namingPosts.length === beforeClickPosts,
    );

    // Confirm no handler was created by the invalid-save attempt.
    const afterInvalidListRes = await adminClient.get('/api/admin/card-action-handlers');
    const afterInvalidCount = Array.isArray(afterInvalidListRes.json)
      ? afterInvalidListRes.json.filter(h => h.name === HANDLER_NAME_NAMING).length
      : 0;
    record(
      '(F.1) no handler is created by the invalid-save attempt',
      `count of HANDLER_NAME_NAMING unchanged (${beforeCount})`,
      `before=${beforeCount} after=${afterInvalidCount}`,
      afterInvalidCount === beforeCount,
    );

    // ── (F.2) valid value path ────────────────────────────────────────────────
    await namingAdminTab.evaluate(() => {
      const input = document.querySelector('#cah-action-name');
      if (!input) return;
      // Use the native value setter so React's onChange fires on the controlled input.
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(input, 'send_quote_ok');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('blur',  { bubbles: true }));
    });

    const validErrHidden = await namingAdminTab.evaluate(() => {
      const err = document.querySelector('#cah-action-name-err');
      if (!err) return 'err-missing';
      const style = window.getComputedStyle(err);
      return style.display === 'none' ? 'hidden' : 'visible';
    });
    record(
      '(F.2) #cah-action-name-err is hidden after blurring a valid snake_case value',
      'computed style.display === "none"',
      `result=${validErrHidden}`,
      validErrHidden === 'hidden',
    );

    await namingAdminTab.evaluate(() => {
      const btn = document.querySelector('#cah-save');
      if (btn) btn.click();
    });

    const modalClosedNaming = await pollPage(
      namingAdminTab,
      () => document.querySelector('#cah-action-name') ? null : 'closed',
      null,
      5000,
    );
    record(
      '(F.2) clicking Save with a valid action_name closes the modal',
      'modal wrapper removed (no #cah-action-name in DOM)',
      `result=${modalClosedNaming}`,
      modalClosedNaming === 'closed',
    );

    // Verify the handler was created with the expected config.action_name.
    // The modal posts name:'' so we look it up by binding + action_name.
    const afterValidListRes = await adminClient.get('/api/admin/card-action-handlers');
    const created = Array.isArray(afterValidListRes.json)
      ? afterValidListRes.json.find(h =>
          h.type === 'summarise_phone_call'
          && h?.config?.action_name === 'send_quote_ok'
          && (h.bindings || []).some(b =>
            String(b.stage_key) === 'sales' && String(b.status_key) === LBL_KEY_NAMING))
      : null;
    record(
      '(F.2) POST /api/admin/card-action-handlers created the handler with config.action_name="send_quote_ok"',
      'handler appears in GET /api/admin/card-action-handlers with matching binding and action_name',
      `created=${created ? `id=${created.id} action_name=${created?.config?.action_name}` : 'null'} posts=${namingPosts.length - beforeClickPosts}`,
      !!created && namingPosts.length - beforeClickPosts === 1,
    );

    // Rename the just-created handler so purgeFixtures() cleans it up.
    if (created && created.id) {
      try {
        await adminClient.patch(`/api/admin/card-action-handlers/${created.id}`, {
          name: HANDLER_NAME_NAMING,
        });
      } catch (_) {}
    }

    await namingAdminTab.close();

    // ── (G) DV catalogue arrow-reordering ────────────────────────────────────
    //
    // Exercises the moveDvItem path added in task #666 across all three
    // catalogues (handles, furniture ranges, door styles).  For each type:
    //   - Seeds 3 rows with distinct sort_order values via the admin REST API.
    //   - Opens a fresh admin tab on the Design visit panel.
    //   - Captures PATCH /api/admin/design-visit-<type>/:id requests and the
    //     BroadcastChannel `design_visit_<type>_changed` notification.
    //   - Asserts the first-row ▲ and last-row ▼ buttons render `disabled`.
    //   - Clicks ▲ on the last row, expects exactly two PATCH calls that
    //     swap the sort_order values of the last and middle rows.
    //   - Asserts the rendered row order updates in place (no full reload —
    //     verified by a sentinel `window.__reorderToken` set before the click
    //     and still present afterwards), and the BroadcastChannel fires once.
    console.log('\n  [G] DV catalogue arrow reordering');

    // Configuration per catalogue type.
    const REORDER_TYPES = [
      {
        type: 'handle',
        endpoint: '/api/admin/design-visit-handles',
        wrapId: 'dv-handles-wrap',
        broadcastChannel: 'design_visit_handles_changed',
        // POST requires `style` for handles; the other fields are optional.
        extraPostFields: { style: 'Bar' },
      },
      {
        type: 'furniture',
        endpoint: '/api/admin/design-visit-furniture-ranges',
        wrapId: 'dv-furniture-wrap',
        broadcastChannel: 'design_visit_furniture_ranges_changed',
        extraPostFields: {},
      },
      {
        type: 'door-style',
        endpoint: '/api/admin/design-visit-door-styles',
        wrapId: 'dv-door-styles-wrap',
        broadcastChannel: 'design_visit_door_styles_changed',
        extraPostFields: {},
      },
    ];

    for (const cfg of REORDER_TYPES) {
      const tag = cfg.type;
      // Seed three rows with sort_order 10/20/30 so swaps produce unambiguous
      // before/after values.  Names use the `privtest-reorder-` prefix so
      // purgeFixtures() can clean them up at the end of the run.
      const seedNames = [
        `privtest-reorder-${tag}-A-${runId}`,
        `privtest-reorder-${tag}-B-${runId}`,
        `privtest-reorder-${tag}-C-${runId}`,
      ];
      const seedIds = [];
      for (let i = 0; i < 3; i++) {
        const body = { name: seedNames[i], sort_order: 10 * (i + 1), ...cfg.extraPostFields };
        const r = await adminClient.post(cfg.endpoint, body);
        if (r.status !== 201 || !r.json?.id) {
          record(
            `(G/${tag}) seed row ${i + 1} via POST ${cfg.endpoint}`,
            'status=201 with numeric id',
            `status=${r.status} body=${JSON.stringify(r.json).slice(0, 160)}`,
            false,
          );
          seedIds.length = 0;
          break;
        }
        seedIds.push(r.json.id);
      }
      if (seedIds.length !== 3) continue;

      record(
        `(G/${tag}) seeded 3 rows with sort_order 10/20/30`,
        '3 ids returned',
        `ids=${seedIds.join(',')}`,
        true,
      );

      const reorderTab = await browser.newPage();
      await reorderTab.setCacheEnabled(false);
      await injectSession(reorderTab, adminClient.cookie);

      // Capture PATCH requests fired by moveDvItem().
      const patches = [];
      const patchListener = (req) => {
        const u = req.url();
        const m = new RegExp(`${cfg.endpoint.replace(/[-/]/g, '\\$&')}/(\\d+)$`).exec(u);
        if (m && req.method() === 'PATCH') {
          let body = null;
          try { body = JSON.parse(req.postData() || 'null'); } catch (_) {}
          patches.push({ id: Number(m[1]), body });
        }
      };
      reorderTab.on('request', patchListener);

      await reorderTab.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded', timeout: 20000 });

      // Install a BroadcastChannel listener for this catalogue's channel
      // before triggering the move, then switch to the Design visit panel.
      await reorderTab.evaluate((chanName) => {
        window.__reorderBcCount = 0;
        const ch = new BroadcastChannel(chanName);
        ch.onmessage = () => { window.__reorderBcCount++; };
        window.__reorderBc = ch;
      }, cfg.broadcastChannel);

      await reorderTab.evaluate(() => {
        if (typeof switchTab === 'function') switchTab('designvisit');
        return typeof loadDvCatalogue === 'function' ? loadDvCatalogue() : Promise.resolve();
      });

      // Wait for our 3 seeded rows to appear in the catalogue list.
      const initialRender = await pollPage(
        reorderTab,
        ({ wrapId, ids }) => {
          const wrap = document.getElementById(wrapId);
          if (!wrap) return null;
          // React renders onClick as a prop, not an onclick attribute — use data-move-id.
          const orderedIds = Array.from(wrap.querySelectorAll('tbody tr'))
            .map(tr => {
              const btn = tr.querySelector('button[data-move-id][data-move-dir="up"]');
              return btn ? Number(btn.getAttribute('data-move-id')) : null;
            })
            .filter(v => v !== null);
          const seedRows = orderedIds.filter(id => ids.includes(id));
          if (seedRows.length !== 3) return null;
          return { orderedIds: seedRows };
        },
        { wrapId: cfg.wrapId, ids: seedIds },
        8000,
      );
      record(
        `(G/${tag}) catalogue panel renders the seeded rows in sort_order`,
        `ordered ids = [${seedIds.join(',')}]`,
        `got=${initialRender ? JSON.stringify(initialRender.orderedIds) : 'null'}`,
        !!initialRender && JSON.stringify(initialRender.orderedIds) === JSON.stringify(seedIds),
      );
      if (!initialRender) {
        reorderTab.off('request', patchListener);
        await reorderTab.close();
        continue;
      }

      // Assert disabled state on the first row's ▲ and the last row's ▼.
      const disabledState = await reorderTab.evaluate(({ wrapId, ids }) => {
        const wrap = document.getElementById(wrapId);
        const rows = Array.from(wrap.querySelectorAll('tbody tr')).filter(tr => {
          const btn = tr.querySelector('button[data-move-id][data-move-dir="up"]');
          return btn && ids.includes(Number(btn.getAttribute('data-move-id')));
        });
        const first = rows[0];
        const last  = rows[rows.length - 1];
        const firstUp   = first.querySelector('button[data-move-dir="up"]');
        const lastDown  = last .querySelector('button[data-move-dir="down"]');
        const middleUp  = rows[1].querySelector('button[data-move-dir="up"]');
        const middleDown= rows[1].querySelector('button[data-move-dir="down"]');
        return {
          firstUpDisabled:  firstUp  ? firstUp.hasAttribute('disabled')  : null,
          lastDownDisabled: lastDown ? lastDown.hasAttribute('disabled') : null,
          middleUpEnabled:    middleUp   ? !middleUp.hasAttribute('disabled')   : null,
          middleDownEnabled:  middleDown ? !middleDown.hasAttribute('disabled') : null,
        };
      }, { wrapId: cfg.wrapId, ids: seedIds });
      record(
        `(G/${tag}) first row ▲ and last row ▼ render with disabled, middle row's are enabled`,
        'firstUpDisabled=true, lastDownDisabled=true, middleUpEnabled=true, middleDownEnabled=true',
        JSON.stringify(disabledState),
        disabledState.firstUpDisabled === true
          && disabledState.lastDownDisabled === true
          && disabledState.middleUpEnabled === true
          && disabledState.middleDownEnabled === true,
      );

      // Plant a sentinel so we can prove no full page reload happened.
      await reorderTab.evaluate(() => { window.__reorderToken = 'sentinel-' + Date.now(); });
      const tokenBefore = await reorderTab.evaluate(() => window.__reorderToken);

      // Click ▲ on the last row (id seedIds[2]) — this should swap it with the
      // middle row (seedIds[1]) via two PATCH calls and re-render with order
      // [A, C, B] (i.e. [seedIds[0], seedIds[2], seedIds[1]]).
      patches.length = 0;
      await reorderTab.evaluate(({ wrapId, lastId }) => {
        const wrap = document.getElementById(wrapId);
        const btn = wrap.querySelector(
          `button[data-move-id="${lastId}"][data-move-dir="up"]`
        );
        if (btn) btn.click();
      }, { wrapId: cfg.wrapId, lastId: seedIds[2] });

      // Wait for the two PATCH requests to land.
      const patchesDone = await pollPage(
        reorderTab,
        () => null,            // dummy — we drive timing via the outer loop
        null,
        50,
      );
      // Simpler: just sleep up to 5s polling the captured array.
      await pollFn(() => patches.length >= 2 ? true : null, 5000, 100);

      const patchById = new Map(patches.map(p => [p.id, p.body?.sort_order]));
      const swappedOk = patches.length === 2
        && patchById.get(seedIds[2]) === 20   // C moves up to B's slot
        && patchById.get(seedIds[1]) === 30;  // B moves down to C's slot
      record(
        `(G/${tag}) clicking ▲ on the last row sends 2 PATCH calls that swap sort_order`,
        `2 PATCHes — id ${seedIds[2]} → sort_order=20, id ${seedIds[1]} → sort_order=30`,
        `count=${patches.length} ${seedIds[2]}=${patchById.get(seedIds[2])} ${seedIds[1]}=${patchById.get(seedIds[1])}`,
        swappedOk,
      );

      // Wait for the in-place re-render to reflect the new order.
      const renderedAfter = await pollPage(
        reorderTab,
        ({ wrapId, ids }) => {
          const wrap = document.getElementById(wrapId);
          if (!wrap) return null;
          const orderedIds = Array.from(wrap.querySelectorAll('tbody tr'))
            .map(tr => {
              const btn = tr.querySelector('button[data-move-id][data-move-dir="up"]');
              return btn ? Number(btn.getAttribute('data-move-id')) : null;
            })
            .filter(v => v !== null)
            .filter(id => ids.includes(id));
          return orderedIds.length === 3 ? orderedIds : null;
        },
        { wrapId: cfg.wrapId, ids: seedIds },
        5000,
      );
      const expectedOrder = [seedIds[0], seedIds[2], seedIds[1]];
      record(
        `(G/${tag}) rows re-render in the new order after the swap (no page reload)`,
        `ordered ids = [${expectedOrder.join(',')}]`,
        `got=${JSON.stringify(renderedAfter)}`,
        !!renderedAfter && JSON.stringify(renderedAfter) === JSON.stringify(expectedOrder),
      );

      const tokenAfter = await reorderTab.evaluate(() => window.__reorderToken);
      record(
        `(G/${tag}) the page was not fully reloaded (window.__reorderToken preserved)`,
        `__reorderToken === "${tokenBefore}"`,
        `before=${tokenBefore} after=${tokenAfter}`,
        !!tokenBefore && tokenBefore === tokenAfter,
      );

      // BroadcastChannel: poll until the listener has observed at least one
      // message on the per-type channel.  Allow up to 3s.
      const bcCount = (await pollUntil(
        reorderTab,
        () => ((window.__reorderBcCount || 0) >= 1) ? (window.__reorderBcCount || 0) : null,
        3000,
        100,
      )) || 0;
      record(
        `(G/${tag}) BroadcastChannel "${cfg.broadcastChannel}" fires after a swap`,
        '__reorderBcCount >= 1',
        `count=${bcCount}`,
        bcCount >= 1,
      );

      // Also verify the swap is reflected server-side (durable, not just DOM).
      const verifyRes = await adminClient.get(cfg.endpoint);
      const verifyById = new Map(
        (Array.isArray(verifyRes.json) ? verifyRes.json : []).map(r => [r.id, r.sort_order]),
      );
      record(
        `(G/${tag}) GET ${cfg.endpoint} shows the swapped sort_order values persisted`,
        `id ${seedIds[2]} → 20, id ${seedIds[1]} → 30`,
        `${seedIds[2]}=${verifyById.get(seedIds[2])} ${seedIds[1]}=${verifyById.get(seedIds[1])}`,
        verifyById.get(seedIds[2]) === 20 && verifyById.get(seedIds[1]) === 30,
      );

      reorderTab.off('request', patchListener);
      await reorderTab.evaluate(() => { try { window.__reorderBc && window.__reorderBc.close(); } catch (_) {} });
      await reorderTab.close();
    }

    // ── (I) Fallback slot visibility ──────────────────────────────────────────
    //
    // Updated for task #1734: slots with no action label AND no bound handler
    // are now hidden entirely.  The old `lsSubs.length > 0` clause (task #1722)
    // has been removed from _buildActionSlotGroups() — a lead status with only
    // un-labelled sub-statuses and no handler must NOT appear in the slot list.
    //
    // Probe (I): assert the "Default action" slot is ABSENT for a lead status
    // that has sub-statuses (with empty action_label) but no stage-action label
    // and no bound handler.
    console.log('\n  [I] No-label/no-handler slot is hidden (task #1734)');

    // Seed the lead_status_config row.
    const FALLBACK_STATUS_LABEL = 'PrivTest Fallback Slot';
    await pool.query(
      `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales, stage)
       VALUES ($1, $2, 9996, false, 'SALES')
       ON CONFLICT (key) DO UPDATE
         SET label               = EXCLUDED.label,
             sort_order          = EXCLUDED.sort_order,
             excluded_from_sales = EXCLUDED.excluded_from_sales,
             stage               = EXCLUDED.stage`,
      [LBL_KEY_FALLBACK_STATUS, FALLBACK_STATUS_LABEL],
    );
    // Insert a sub-status with an empty action_label.
    await pool.query(
      `INSERT INTO lead_substatuses (status_key, substatus_key, label, action_label, sort_order)
       VALUES ($1, $2, 'PrivTest fallback sub', '', 9996)
       ON CONFLICT DO NOTHING`,
      [LBL_KEY_FALLBACK_STATUS, 'PRIVTEST_FALLBACK_SUB'],
    );
    console.log(`  Seeded lead_status_config key=${LBL_KEY_FALLBACK_STATUS} with one empty-action_label sub-status (no handler, no label)`);

    // Open a fresh admin tab and switch to the Action Handlers panel.
    const fallbackTab = await browser.newPage();
    await fallbackTab.setCacheEnabled(false);
    await injectSession(fallbackTab, adminClient.cookie);
    await fallbackTab.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await fallbackTab.evaluate(() => {
      if (typeof switchTab === 'function') switchTab('cardactions');
    });
    await new Promise(r => setTimeout(r, 400));
    await fallbackTab.evaluate(() => {
      if (typeof switchTab === 'function') switchTab('actionhandlers');
    });
    await pollPage(
      fallbackTab,
      () => typeof window.loadCardActionHandlersAdmin === 'function',
      null,
      10000,
    );
    await fallbackTab.evaluate(() => {
      const p1 = typeof loadCardActionsAdmin === 'function'
        ? loadCardActionsAdmin() : Promise.resolve();
      const p2 = typeof loadCardActionHandlersAdmin === 'function'
        ? loadCardActionHandlersAdmin() : Promise.resolve();
      return Promise.all([p1, p2]);
    });
    // Give React a moment to render.
    await new Promise(r => setTimeout(r, 800));

    // Assert the group for this status is NOT present (no label, no handler).
    const noLabelNoHandlerGroupAbsent = await fallbackTab.evaluate((statusLabel) => {
      const wrap = document.getElementById('card-action-handlers-wrap');
      if (!wrap) return 'wrap-missing';
      const groups = wrap.querySelectorAll('.adm-handlers-group');
      for (const grp of groups) {
        const head = grp.querySelector('.adm-handlers-group-head');
        if (head && head.textContent.includes(statusLabel)) return 'found';
      }
      return 'absent';
    }, FALLBACK_STATUS_LABEL);
    record(
      '(I) Group for no-label/no-handler lead status is hidden',
      '"absent" — group for FALLBACK_STATUS_LABEL must not appear in the slot list',
      `result=${noLabelNoHandlerGroupAbsent}`,
      noLabelNoHandlerGroupAbsent === 'absent',
    );

    // ── (M) Blank-action_label sub-status produces no slot row ────────────────
    //
    // Slot-level negative guard complementing probe (I).  The same
    // LBL_KEY_FALLBACK_STATUS fixture is used (no stage-action label, one
    // sub-status with empty action_label, no bound handler).  Where probe (I)
    // checks that the group header is absent, this probe checks directly at
    // the slot DOM level: no .adm-handlers-slot-label element should exist for
    // that sub-status inside #card-action-handlers-wrap.
    // Guards the `if (!action) continue` guard in ActionHandlersPage.tsx line 243.
    console.log('\n  [M] Blank-action_label sub-status produces no slot row');

    const blankSubstatusSlotAbsent = await fallbackTab.evaluate((statusLabel) => {
      const wrap = document.getElementById('card-action-handlers-wrap');
      if (!wrap) return 'wrap-missing';
      const groups = wrap.querySelectorAll('.adm-handlers-group');
      for (const grp of groups) {
        const head = grp.querySelector('.adm-handlers-group-head');
        if (head && head.textContent.includes(statusLabel)) {
          const slots = grp.querySelectorAll('.adm-handlers-slot-label');
          return slots.length > 0 ? `found:${slots.length}` : 'no-slots';
        }
      }
      return 'group-absent';
    }, FALLBACK_STATUS_LABEL);
    record(
      '(M) Blank-action_label sub-status produces no .adm-handlers-slot-label row',
      '"group-absent" or "no-slots" — no slot-label row must exist for a blank-label sub-status',
      `result=${blankSubstatusSlotAbsent}`,
      blankSubstatusSlotAbsent === 'group-absent' || blankSubstatusSlotAbsent === 'no-slots',
    );

    // ── (J) Bound-but-unlabelled slot shows warning chip ─────────────────────
    //
    // When a handler is bound to a slot that has no stage-action label the row
    // must appear (because hasHandler=true) AND carry a
    // [data-testid="no-label-warning"] chip explaining the handler won't fire
    // until a label is added in Card Actions.
    console.log('\n  [J] Bound-but-unlabelled slot shows no-label-warning chip');

    // Bind a handler to LBL_KEY_FALLBACK_STATUS (still has no stage-action label).
    const createFallbackHandlerRes = await adminClient.post('/api/admin/card-action-handlers', {
      name: 'privtest-fallback-unlabelled',
      type: 'summarise_phone_call',
      config: {},
      bindings: [{ stage_key: 'sales', status_key: LBL_KEY_FALLBACK_STATUS.toLowerCase() }],
    });
    const fallbackHandlerId = createFallbackHandlerRes.json?.id;
    record(
      '(J.setup) POST handler bound to unlabelled slot',
      'status=201 with numeric id',
      `status=${createFallbackHandlerRes.status} id=${fallbackHandlerId}`,
      createFallbackHandlerRes.status === 201 && Number.isInteger(fallbackHandlerId),
    );

    if (fallbackHandlerId) {
      // Reload the Action Handlers panel in the same fallback tab.
      await fallbackTab.evaluate(() => {
        if (typeof loadCardActionHandlersAdmin === 'function') loadCardActionHandlersAdmin();
      });

      // Poll for the warning chip.
      const warningChipVisible = await pollPage(
        fallbackTab,
        (statusLabel) => {
          const wrap = document.getElementById('card-action-handlers-wrap');
          if (!wrap) return null;
          const groups = wrap.querySelectorAll('.adm-handlers-group');
          for (const grp of groups) {
            const head = grp.querySelector('.adm-handlers-group-head');
            if (!head || !head.textContent.includes(statusLabel)) continue;
            if (grp.querySelector('[data-testid="no-label-warning"]')) return 'found';
          }
          return null;
        },
        FALLBACK_STATUS_LABEL,
        8000,
      );
      record(
        '(J) [data-testid="no-label-warning"] chip visible for bound-but-unlabelled slot',
        '"found" — warning chip must appear inside the group for FALLBACK_STATUS_LABEL',
        `result=${warningChipVisible}`,
        warningChipVisible === 'found',
      );

      // Clean up the handler.
      await adminClient.delete(`/api/admin/card-action-handlers/${fallbackHandlerId}`);
    }

    await fallbackTab.close();

    // ── (L) Sub-status slot rows render for labelled sub-statuses ─────────────
    //
    // Guard for ActionHandlersPage.tsx lines 232-239: a `lead_substatuses` row
    // whose `action_label` is non-empty must produce a visible slot row with:
    //   (L.1) `.adm-handlers-slot-label` text equal to the action_label value.
    //   (L.2) `.adm-handlers-slot-sub` text matching the "Sub-status · <label>"
    //         pattern.
    // A regression that skips or hides sub-status rows would fail both checks.
    console.log('\n  [L] Sub-status slot rows render for labelled sub-statuses');

    const SUB_ROW_STATUS_LABEL = 'PrivTest SubRow Status';
    const SUB_ROW_ACTION_LABEL = 'Book measurement';
    const SUB_ROW_SUB_LABEL    = 'Confirmed';
    const SUB_ROW_SUB_KEY      = 'PRIVTEST_SUB_ROW_LABELLED';

    // Seed a lead_status_config row with a sub-status that has a non-empty action_label.
    await pool.query(
      `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales, stage)
       VALUES ($1, $2, 9994, false, 'SALES')
       ON CONFLICT (key) DO UPDATE
         SET label               = EXCLUDED.label,
             sort_order          = EXCLUDED.sort_order,
             excluded_from_sales = EXCLUDED.excluded_from_sales,
             stage               = EXCLUDED.stage`,
      [LBL_KEY_SUB_ROW, SUB_ROW_STATUS_LABEL],
    );
    await pool.query(
      `INSERT INTO lead_substatuses (status_key, substatus_key, label, action_label, sort_order)
       VALUES ($1, $2, $3, $4, 9994)
       ON CONFLICT DO NOTHING`,
      [LBL_KEY_SUB_ROW, SUB_ROW_SUB_KEY, SUB_ROW_SUB_LABEL, SUB_ROW_ACTION_LABEL],
    );
    console.log(`  Seeded lead_status_config key=${LBL_KEY_SUB_ROW} with sub-status action_label="${SUB_ROW_ACTION_LABEL}"`);

    const subRowTab = await browser.newPage();
    await subRowTab.setCacheEnabled(false);
    await injectSession(subRowTab, adminClient.cookie);
    await subRowTab.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await subRowTab.evaluate(() => {
      if (typeof switchTab === 'function') switchTab('cardactions');
    });
    await new Promise(r => setTimeout(r, 400));
    await subRowTab.evaluate(() => {
      if (typeof switchTab === 'function') switchTab('actionhandlers');
    });
    await pollPage(
      subRowTab,
      () => typeof window.loadCardActionHandlersAdmin === 'function',
      null,
      10000,
    );
    await subRowTab.evaluate(() => {
      const p1 = typeof loadCardActionsAdmin === 'function'
        ? loadCardActionsAdmin() : Promise.resolve();
      const p2 = typeof loadCardActionHandlersAdmin === 'function'
        ? loadCardActionHandlersAdmin() : Promise.resolve();
      return Promise.all([p1, p2]);
    });
    await new Promise(r => setTimeout(r, 800));

    // K.1 — The slot label text matches the action_label value.
    const subRowSlotLabelFound = await pollPage(
      subRowTab,
      ([statusLabel, actionLabel]) => {
        const wrap = document.getElementById('card-action-handlers-wrap');
        if (!wrap) return null;
        const groups = wrap.querySelectorAll('.adm-handlers-group');
        for (const grp of groups) {
          const head = grp.querySelector('.adm-handlers-group-head');
          if (!head || !head.textContent.includes(statusLabel)) continue;
          const labels = grp.querySelectorAll('.adm-handlers-slot-label');
          for (const el of labels) {
            if (el.textContent.trim() === actionLabel) return 'found';
          }
        }
        return null;
      },
      [SUB_ROW_STATUS_LABEL, SUB_ROW_ACTION_LABEL],
      8000,
    );
    record(
      '(L.1) Sub-status slot row label text matches action_label',
      `"found" — .adm-handlers-slot-label text equals "${SUB_ROW_ACTION_LABEL}" inside group "${SUB_ROW_STATUS_LABEL}"`,
      `result=${subRowSlotLabelFound}`,
      subRowSlotLabelFound === 'found',
    );

    // L.2 — The rowLabel follows the "Sub-status · <sub.label>" pattern.
    const subRowRowLabelFound = await subRowTab.evaluate(([statusLabel, actionLabel, subLabel]) => {
      const wrap = document.getElementById('card-action-handlers-wrap');
      if (!wrap) return 'wrap-missing';
      const groups = wrap.querySelectorAll('.adm-handlers-group');
      for (const grp of groups) {
        const head = grp.querySelector('.adm-handlers-group-head');
        if (!head || !head.textContent.includes(statusLabel)) continue;
        const rows = grp.querySelectorAll('tr.adm-handlers-row');
        for (const row of rows) {
          const slotLabel = row.querySelector('.adm-handlers-slot-label');
          if (!slotLabel || slotLabel.textContent.trim() !== actionLabel) continue;
          const slotSub = row.querySelector('.adm-handlers-slot-sub');
          if (slotSub && slotSub.textContent.includes('Sub-status') && slotSub.textContent.includes(subLabel)) {
            return 'found';
          }
        }
      }
      return 'absent';
    }, [SUB_ROW_STATUS_LABEL, SUB_ROW_ACTION_LABEL, SUB_ROW_SUB_LABEL]);
    record(
      '(L.2) Sub-status slot rowLabel follows "Sub-status · <label>" pattern',
      `"found" — .adm-handlers-slot-sub contains "Sub-status" and "${SUB_ROW_SUB_LABEL}"`,
      `result=${subRowRowLabelFound}`,
      subRowRowLabelFound === 'found',
    );

    await subRowTab.close();

    // ── (N) Bound-handler warning on label clear ──────────────────────────────
    //
    // When a `ca-default-input` is cleared while a handler is still bound to
    // that slot, `saveAllCardActionLabels` must show the "Handler still bound
    // to this label" confirmation dialog and give the admin a chance to cancel.
    //
    // Flow:
    //   N.setup        — seed a lead status + stage-action label + bound handler.
    //   N.dialog-appears — clear the input and call Save; dialog must appear.
    //   N.cancel       — click Cancel; dialog closes, no PUT fires.
    //   N.clear        — call Save again, click "Clear label anyway"; PUT fires.
    console.log('\n  [N] Bound-handler warning on label clear');

    // N.setup: seed fixtures.
    await pool.query(
      `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales, stage)
       VALUES ($1, $2, 9991, false, 'SALES')
       ON CONFLICT (key) DO UPDATE
         SET label               = EXCLUDED.label,
             sort_order          = EXCLUDED.sort_order,
             excluded_from_sales = EXCLUDED.excluded_from_sales,
             stage               = EXCLUDED.stage`,
      [LBL_KEY_CLEAR_WARN, CLEAR_WARN_STATUS_LABEL],
    );
    const seedLabelRes = await adminClient.put('/api/admin/stage-action-labels', {
      stage_key: 'sales',
      status_key: LBL_KEY_CLEAR_WARN_LOWER,
      label: CLEAR_WARN_LABEL,
    });
    record(
      '(N.setup) PUT /api/admin/stage-action-labels seeds the label',
      'status=200',
      `status=${seedLabelRes.status}`,
      seedLabelRes.status === 200,
    );
    const createClearWarnRes = await adminClient.post('/api/admin/card-action-handlers', {
      name: HANDLER_NAME_CLEAR_WARN,
      type: 'summarise_phone_call',
      config: {},
      bindings: [{ stage_key: 'sales', status_key: LBL_KEY_CLEAR_WARN_LOWER }],
    });
    const clearWarnHandlerId = createClearWarnRes.json?.id;
    record(
      '(N.setup) POST handler bound to clear-warn slot',
      'status=201 with numeric id',
      `status=${createClearWarnRes.status} id=${clearWarnHandlerId}`,
      createClearWarnRes.status === 201 && Number.isInteger(clearWarnHandlerId),
    );

    // Open a fresh admin tab and navigate to the Card actions panel.
    const clearWarnTab = await browser.newPage();
    await clearWarnTab.setCacheEnabled(false);
    await injectSession(clearWarnTab, adminClient.cookie);
    await clearWarnTab.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await clearWarnTab.evaluate(() => {
      if (typeof switchTab === 'function') switchTab('cardactions');
    });
    await pollPage(
      clearWarnTab,
      () => typeof window.loadCardActionsAdmin === 'function',
      null,
      10000,
    );
    await clearWarnTab.evaluate(() =>
      typeof loadCardActionsAdmin === 'function' ? loadCardActionsAdmin() : Promise.resolve()
    );
    await new Promise(r => setTimeout(r, 800));

    // Expand the Sales section (all stages start collapsed).
    await clearWarnTab.evaluate(() => {
      const toggle = document.querySelector('[data-stage-toggle="sales"]');
      if (toggle) toggle.click();
    });
    await new Promise(r => setTimeout(r, 300));

    // Verify the target input exists and clear its value.
    const inputOriginal = await clearWarnTab.evaluate((statusKey) => {
      const input = document.querySelector(
        `#card-actions-table-wrap .ca-default-input[data-status="${statusKey}"]`,
      );
      if (!input) return null;
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value',
      ).set;
      nativeSetter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.dataset.original || '';
    }, LBL_KEY_CLEAR_WARN_LOWER);
    record(
      '(N.setup) ca-default-input found with correct data-original',
      `data-original="${CLEAR_WARN_LABEL}"`,
      `original=${JSON.stringify(inputOriginal)}`,
      inputOriginal === CLEAR_WARN_LABEL,
    );

    // Track PUT requests to /api/admin/stage-action-labels.
    const clearWarnPuts = [];
    const clearWarnReqListener = (req) => {
      if (req.url().includes('/api/admin/stage-action-labels') && req.method() === 'PUT') {
        clearWarnPuts.push(req.url());
      }
    };
    clearWarnTab.on('request', clearWarnReqListener);

    // M.dialog-appears: call save — dialog must appear.
    await clearWarnTab.evaluate(() => {
      if (typeof saveAllCardActionLabels === 'function') saveAllCardActionLabels();
    });
    const dialogAppeared = await pollPage(
      clearWarnTab,
      () => {
        for (const d of document.querySelectorAll('[role=dialog]')) {
          const title = d.querySelector('[data-testid="bound-handler-warning-title"]');
          if (title && title.textContent.includes('Handler still bound to this label')) return true;
        }
        return null;
      },
      null,
      6000,
    );
    record(
      '(N.dialog-appears) "Handler still bound to this label" dialog shown',
      'MuiDialog with matching DialogTitle appears',
      `appeared=${dialogAppeared}`,
      dialogAppeared === true,
    );

    // M.cancel: click Cancel — dialog must close and no PUT must have fired.
    const putsBeforeCancel = clearWarnPuts.length;
    await clearWarnTab.evaluate(() => {
      for (const d of document.querySelectorAll('[role=dialog]')) {
        for (const btn of d.querySelectorAll('button')) {
          if (btn.textContent.trim() === 'Cancel') { btn.click(); return; }
        }
      }
    });
    const dialogGoneAfterCancel = await pollPage(
      clearWarnTab,
      () => {
        for (const d of document.querySelectorAll('[role=dialog]')) {
          const title = d.querySelector('[data-testid="bound-handler-warning-title"]');
          if (title && title.textContent.includes('Handler still bound to this label')) return null;
        }
        return true;
      },
      null,
      4000,
    );
    record(
      '(N.cancel) Cancel closes the dialog',
      'dialog gone after Cancel click',
      `gone=${dialogGoneAfterCancel}`,
      dialogGoneAfterCancel === true,
    );
    record(
      '(N.cancel) Cancel does not fire a PUT to stage-action-labels',
      `same PUT count (${putsBeforeCancel}) before and after Cancel`,
      `puts_before=${putsBeforeCancel} puts_after=${clearWarnPuts.length}`,
      clearWarnPuts.length === putsBeforeCancel,
    );

    // M.clear: the input is still "" (Cancel aborted the save without restoring
    // the value). Call save again and click "Clear label anyway" this time.
    const putsBeforeClear = clearWarnPuts.length;
    await clearWarnTab.evaluate(() => {
      if (typeof saveAllCardActionLabels === 'function') saveAllCardActionLabels();
    });
    const dialog2Appeared = await pollPage(
      clearWarnTab,
      () => {
        for (const d of document.querySelectorAll('[role=dialog]')) {
          const title = d.querySelector('[data-testid="bound-handler-warning-title"]');
          if (title && title.textContent.includes('Handler still bound to this label')) return true;
        }
        return null;
      },
      null,
      6000,
    );
    record(
      '(N.clear) Dialog appears again on second save attempt',
      'dialog appears',
      `appeared=${dialog2Appeared}`,
      dialog2Appeared === true,
    );
    await clearWarnTab.evaluate(() => {
      for (const d of document.querySelectorAll('[role=dialog]')) {
        for (const btn of d.querySelectorAll('button')) {
          if (btn.textContent.includes('Clear label anyway')) { btn.click(); return; }
        }
      }
    });
    // Give the PUT a moment to fire (the route responds quickly).
    await new Promise(r => setTimeout(r, 1500));
    clearWarnTab.off('request', clearWarnReqListener);
    record(
      '(N.clear) "Clear label anyway" fires a PUT to stage-action-labels',
      '≥1 new PUT to /api/admin/stage-action-labels after confirming',
      `new_puts=${clearWarnPuts.length - putsBeforeClear}`,
      clearWarnPuts.length > putsBeforeClear,
    );

    // Clean up: delete the handler (bindings cascade) and the label row.
    if (clearWarnHandlerId) {
      await adminClient.delete(`/api/admin/card-action-handlers/${clearWarnHandlerId}`);
    }
    await adminClient.delete(
      `/api/admin/stage-action-labels/sales/${LBL_KEY_CLEAR_WARN_LOWER}`,
    ).catch(() => {});
    await clearWarnTab.close();

    // ── (O) Sub-status delete bound-handler warning ────────────────────────────
    //
    // Verifies that clicking ✕ on a sub-status that still has a
    // card_action_handler_bindings row (via substatus_id) shows the MUI Dialog
    // titled "Handler still bound to this sub-status" rather than silently
    // deleting the row.
    //
    // Six assertions:
    //   O.setup — seed a lead status + two sub-statuses + a bound handler.
    //   O.1 — dialog appears when delete is clicked on a bound sub-status.
    //   O.2 — clicking Cancel closes the dialog; row is still in the DOM.
    //   O.3 — clicking delete again → "Delete anyway" removes the row from DOM.
    //   O.4 — DB row is gone after the confirmed delete.
    //   O.5 — deleting an unbound sub-status shows no dialog (row just disappears).
    //   O.6 — unbound sub-status row is gone from DOM after the no-dialog delete.
    {
      console.log('\n  [O] Sub-status delete bound-handler warning');

      const DEL_WARN_STATUS_LABEL = 'PrivTest Del-Warn Status';

      // Seed the lead_status_config parent row required by the FK.
      await pool.query(
        `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales, stage)
         VALUES ($1, $2, 9992, false, 'SALES')
         ON CONFLICT (key) DO UPDATE
           SET label               = EXCLUDED.label,
               sort_order          = EXCLUDED.sort_order,
               excluded_from_sales = EXCLUDED.excluded_from_sales,
               stage               = EXCLUDED.stage`,
        [LBL_KEY_DEL_WARN, DEL_WARN_STATUS_LABEL],
      );

      // Seed a bound sub-status (will have a handler binding via substatus_id).
      const boundRes = await pool.query(
        `INSERT INTO lead_substatuses (status_key, substatus_key, label, action_label, sort_order)
         VALUES ($1, $2, 'Bound sub label', 'Bound action', 9992)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [LBL_KEY_DEL_WARN, 'PRIVTEST_CAH_DEL_WARN_BOUND'],
      );
      let boundSubId = boundRes.rows[0]?.id;
      if (!boundSubId) {
        const r = await pool.query(
          `SELECT id FROM lead_substatuses WHERE status_key = $1 AND substatus_key = $2`,
          [LBL_KEY_DEL_WARN, 'PRIVTEST_CAH_DEL_WARN_BOUND']
        );
        boundSubId = r.rows[0]?.id;
      }

      // Seed an unbound sub-status (no handler binding — for the O.5/O.6 case).
      const freeRes = await pool.query(
        `INSERT INTO lead_substatuses (status_key, substatus_key, label, action_label, sort_order)
         VALUES ($1, $2, 'Free sub label', 'Free action', 9991)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [LBL_KEY_DEL_WARN, 'PRIVTEST_CAH_DEL_WARN_FREE'],
      );
      let freeSubId = freeRes.rows[0]?.id;
      if (!freeSubId) {
        const r = await pool.query(
          `SELECT id FROM lead_substatuses WHERE status_key = $1 AND substatus_key = $2`,
          [LBL_KEY_DEL_WARN, 'PRIVTEST_CAH_DEL_WARN_FREE']
        );
        freeSubId = r.rows[0]?.id;
      }

      // Create a handler bound to the bound sub-status via substatus_id.
      let delWarnHandlerId = null;
      if (boundSubId) {
        const createRes = await adminClient.post('/api/admin/card-action-handlers', {
          name: HANDLER_NAME_DEL_WARN,
          type: 'summarise_phone_call',
          config: {},
          bindings: [{ substatus_id: boundSubId }],
        });
        delWarnHandlerId = createRes.json?.id ?? null;
        record(
          '(O.setup) POST handler bound to sub-status via substatus_id',
          'status=201 with numeric id',
          `status=${createRes.status} id=${delWarnHandlerId}`,
          createRes.status === 201 && Number.isInteger(delWarnHandlerId),
        );
      } else {
        skip('(O.setup) POST handler bound to sub-status via substatus_id', 'status=201', 'SKIPPED — seed failed');
      }

      if (delWarnHandlerId && boundSubId && freeSubId) {
        const delWarnTab = await browser.newPage();
        await delWarnTab.setCacheEnabled(false);
        await injectSession(delWarnTab, adminClient.cookie);
        await delWarnTab.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded', timeout: 20000 });

        // Switch to the Card Actions tab so CardActionsPage mounts and exposes
        // window.deleteCardActionSubstatus and window.loadCardActionsAdmin.
        await delWarnTab.evaluate(() => {
          if (typeof switchTab === 'function') switchTab('cardactions');
        });
        await pollPage(
          delWarnTab,
          () => typeof window.deleteCardActionSubstatus === 'function',
          null,
          10000,
        );

        // Trigger a fresh data load so the newly-seeded rows are visible.
        await delWarnTab.evaluate(() => {
          if (typeof window.loadCardActionsAdmin === 'function') window.loadCardActionsAdmin();
        });

        // Wait for the bound sub-status row to appear in the Card Actions DOM.
        await pollPage(
          delWarnTab,
          (id) => !!document.querySelector(`[data-sub-id="${id}"]`),
          String(boundSubId),
          8000,
        );

        // ── O.1 — dialog appears when delete is clicked on a bound sub-status ──
        await delWarnTab.evaluate((id) => {
          const row = document.querySelector(`[data-sub-id="${id}"]`);
          const btn = row && row.querySelector('.adm-ca-sub-delete');
          if (btn) btn.click();
        }, String(boundSubId));

        const dialogShown = await pollPage(
          delWarnTab,
          () => {
            const dlg = document.querySelector('[data-testid="substatus-delete-dialog"]');
            if (!dlg) return null;
            return dlg.textContent.includes('Handler still bound to this sub-status')
              ? 'shown' : null;
          },
          null,
          6000,
        );
        record(
          '(O.1) "Handler still bound to this sub-status" dialog appears on delete click',
          '"shown" — substatus-delete-dialog visible with correct title',
          `result=${dialogShown}`,
          dialogShown === 'shown',
        );

        // ── O.2 — Cancel: dialog closes, row still in DOM ────────────────────
        await delWarnTab.evaluate(() => {
          const dlg = document.querySelector('[data-testid="substatus-delete-dialog"]');
          const cancel = dlg && Array.from(dlg.querySelectorAll('button')).find(b => b.textContent.trim() === 'Cancel');
          if (cancel) cancel.click();
        });

        // Wait for the dialog to close.
        await pollPage(
          delWarnTab,
          () => !document.querySelector('[data-testid="substatus-delete-dialog"]') ? 'closed' : null,
          null,
          6000,
        );

        const rowStillPresent = await delWarnTab.evaluate(
          (id) => !!document.querySelector(`[data-sub-id="${id}"]`),
          String(boundSubId),
        );
        record(
          '(O.2) After Cancel: bound sub-status row still present in DOM',
          'true — [data-sub-id] element still in DOM',
          `rowPresent=${rowStillPresent}`,
          rowStillPresent === true,
        );

        // ── O.3 — Delete again → confirm: row removed from DOM ───────────────
        await delWarnTab.evaluate((id) => {
          const row = document.querySelector(`[data-sub-id="${id}"]`);
          const btn = row && row.querySelector('.adm-ca-sub-delete');
          if (btn) btn.click();
        }, String(boundSubId));

        // Wait for the dialog to reappear.
        await pollPage(
          delWarnTab,
          () => !!document.querySelector('[data-testid="substatus-delete-dialog"]') ? 'open' : null,
          null,
          6000,
        );

        // Click "Delete anyway".
        await delWarnTab.evaluate(() => {
          const dlg = document.querySelector('[data-testid="substatus-delete-dialog"]');
          const del = dlg && Array.from(dlg.querySelectorAll('button')).find(b => b.textContent.trim() === 'Delete anyway');
          if (del) del.click();
        });

        const rowGone = await pollPage(
          delWarnTab,
          (id) => !document.querySelector(`[data-sub-id="${id}"]`) ? 'gone' : null,
          String(boundSubId),
          8000,
        );
        record(
          '(O.3) After "Delete anyway": bound sub-status row removed from DOM',
          '"gone" — [data-sub-id] element no longer in DOM',
          `result=${rowGone}`,
          rowGone === 'gone',
        );

        // ── O.4 — DB row is deleted ───────────────────────────────────────────
        const dbAfter = await pool.query(
          `SELECT COUNT(*)::int AS cnt FROM lead_substatuses WHERE id = $1`,
          [boundSubId],
        );
        record(
          '(O.4) Bound sub-status DB row deleted after confirmed delete',
          '0 rows in lead_substatuses',
          `${dbAfter.rows[0].cnt} row(s)`,
          dbAfter.rows[0].cnt === 0,
        );

        // ── O.5 — Unbound sub-status: no dialog on delete ────────────────────
        // Wait for the unbound row to be in the DOM (it may already be there).
        await pollPage(
          delWarnTab,
          (id) => !!document.querySelector(`[data-sub-id="${id}"]`),
          String(freeSubId),
          6000,
        );

        await delWarnTab.evaluate((id) => {
          const row = document.querySelector(`[data-sub-id="${id}"]`);
          const btn = row && row.querySelector('.adm-ca-sub-delete');
          if (btn) btn.click();
        }, String(freeSubId));

        // Give MUI a moment to render any dialog that might appear.
        await new Promise(r => setTimeout(r, 600));

        const noDialogForFree = await delWarnTab.evaluate(
          () => !document.querySelector('[data-testid="substatus-delete-dialog"]'),
        );
        record(
          '(O.5) Deleting unbound sub-status shows no confirmation dialog',
          'true — no substatus-delete-dialog visible after click',
          `noDialog=${noDialogForFree}`,
          noDialogForFree === true,
        );

        // ── O.6 — Unbound row disappears from DOM ─────────────────────────────
        const freeRowGone = await pollPage(
          delWarnTab,
          (id) => !document.querySelector(`[data-sub-id="${id}"]`) ? 'gone' : null,
          String(freeSubId),
          8000,
        );
        record(
          '(O.6) Unbound sub-status row removed from DOM without dialog',
          '"gone" — [data-sub-id] element no longer in DOM',
          `result=${freeRowGone}`,
          freeRowGone === 'gone',
        );

        await delWarnTab.close();

        // Clean up the handler (FK cascade removes the binding).
        await adminClient.delete(`/api/admin/card-action-handlers/${delWarnHandlerId}`);
      } else {
        ['O.1', 'O.2', 'O.3', 'O.4', 'O.5', 'O.6'].forEach((p) => {
          skip(`(${p}) sub-status delete bound-handler warning`, 'n/a', 'SKIPPED — seed failed');
        });
      }
    }

  // ── (P) Stale lead-status warning in the handler editor ──────────────────
  //
  // Seeds a start_design_visit handler whose config.intermediateLeadStatus
  // references a key that does NOT exist in lead_status_config, making it
  // "stale" from the Action Handlers panel's perspective.  Three assertions:
  //   P.setup — handler created (201) with the stale intermediateLeadStatus.
  //   P.1     — HandlerSummary shows the "Status deleted" Chip
  //             ([data-testid="stale-status-warning"]).
  //   P.2     — Clicking "Change" opens the HandlerEditorModal and the
  //             warning Alert ("This lead status no longer exists…") is
  //             visible inside the dialog.
  //   P.3     — The Save/Add button inside the dialog is disabled while the
  //             stale reference is unresolved (hasStaleLsRefs=true).
  {
    console.log('\n  [P] Stale lead-status warning in the handler editor');

    // Seed the lead_status_config row for the binding slot so the group
    // appears in the Action Handlers table.
    await pool.query(
      `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales, stage)
       VALUES ($1, 'PrivTest Stale Status', 9988, false, 'SALES')
       ON CONFLICT (key) DO UPDATE
         SET label               = EXCLUDED.label,
             sort_order          = EXCLUDED.sort_order,
             excluded_from_sales = EXCLUDED.excluded_from_sales,
             stage               = EXCLUDED.stage`,
      [LBL_KEY_STALE_SLOT]
    );
    // Add a stage-action label so the slot is rendered in the table
    // (groups with no label and no handler are hidden by _buildActionSlotGroups).
    await adminClient.put('/api/admin/stage-action-labels', {
      stage_key: 'sales',
      status_key: LBL_KEY_STALE_BINDING,
      label: 'PrivTest Stale Slot',
    });

    // Create the handler.  config.intermediateLeadStatus is a key that does
    // not exist in lead_status_config, so it will be flagged as stale.
    const createStaleRes = await adminClient.post('/api/admin/card-action-handlers', {
      name: HANDLER_NAME_STALE,
      type: 'start_design_visit',
      config: { intermediateLeadStatus: STALE_INTER_LS, defaultDurationMin: 90 },
      bindings: [{ stage_key: 'sales', status_key: LBL_KEY_STALE_BINDING }],
    });
    const staleHandlerId = createStaleRes.json?.id;
    record(
      '(P.setup) POST start_design_visit handler with stale intermediateLeadStatus',
      `status=201 with numeric id; config.intermediateLeadStatus="${STALE_INTER_LS}"`,
      `status=${createStaleRes.status} id=${staleHandlerId} ils=${createStaleRes.json?.config?.intermediateLeadStatus}`,
      createStaleRes.status === 201 && Number.isInteger(staleHandlerId)
        && createStaleRes.json?.config?.intermediateLeadStatus === STALE_INTER_LS,
    );

    if (staleHandlerId) {
      // Open a fresh admin tab on the Action Handlers panel.
      const staleTab = await browser.newPage();
      await staleTab.setCacheEnabled(false);
      await injectSession(staleTab, adminClient.cookie);
      await staleTab.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      // Visit cardactions first so CardActionsPage mounts and loads stage-action
      // labels (required by _buildActionSlotGroups for the slot to be visible).
      await staleTab.evaluate(() => {
        if (typeof switchTab === 'function') switchTab('cardactions');
      });
      await new Promise(r => setTimeout(r, 400));
      await staleTab.evaluate(() => {
        if (typeof switchTab === 'function') switchTab('actionhandlers');
      });
      // Wait for ActionHandlersPage to mount and expose openHandlerEditor.
      await pollPage(
        staleTab,
        () => typeof window.openHandlerEditor === 'function',
        null,
        10000,
      );
      await staleTab.evaluate(async () => {
        const p1 = typeof loadCardActionsAdmin === 'function'
          ? loadCardActionsAdmin() : Promise.resolve();
        const p2 = typeof loadCardActionHandlersAdmin === 'function'
          ? loadCardActionHandlersAdmin() : Promise.resolve();
        return Promise.all([p1, p2]);
      });
      await new Promise(r => setTimeout(r, 800));

      // ── P.1: "Status deleted" chip visible in HandlerSummary ───────────────
      const staleChipVisible = await pollPage(
        staleTab,
        () => document.querySelector('[data-testid="stale-status-warning"]') ? 'visible' : null,
        null,
        8000,
      );
      record(
        '(P.1) HandlerSummary shows "Status deleted" chip for stale intermediateLeadStatus',
        '"visible" — [data-testid="stale-status-warning"] present in DOM',
        `result=${staleChipVisible}`,
        staleChipVisible === 'visible',
      );

      // ── P.2 + P.3: open the editor via the "Change" button ─────────────────
      // Find the row whose summary contains the stale-status chip and click
      // its "Change" (non-Remove ghost) button.
      const changeClicked = await staleTab.evaluate(() => {
        const rows = document.querySelectorAll('tr.adm-handlers-row');
        for (const row of rows) {
          if (!row.querySelector('[data-testid="stale-status-warning"]')) continue;
          const btns = row.querySelectorAll('button.btn-ghost:not(.adm-btn-remove)');
          for (const btn of btns) {
            if (btn.textContent.trim() === 'Change') { btn.click(); return 'clicked'; }
          }
        }
        return 'not-found';
      });
      record(
        '(P.2) "Change" button clicked to open HandlerEditorModal for stale handler',
        '"clicked" — "Change" button found in stale-chip row and clicked',
        `result=${changeClicked}`,
        changeClicked === 'clicked',
      );

      // Wait for the HandlerEditorModal dialog to appear.
      const dialogOpened = await pollPage(
        staleTab,
        () => document.querySelector('[data-testid="handler-editor-modal"]') ? 'open' : null,
        null,
        6000,
      );
      record(
        '(P.2) HandlerEditorModal dialog opens after clicking Change',
        '"open" — handler-editor-modal testid present in DOM',
        `result=${dialogOpened}`,
        dialogOpened === 'open',
      );

      if (dialogOpened === 'open') {
        // P.2 — warning Alert visible inside the dialog.
        const alertVisible = await staleTab.evaluate(() => {
          const dialog = document.querySelector('[data-testid="handler-editor-modal"]');
          if (!dialog) return 'no-dialog';
          const alerts = dialog.querySelectorAll('[role="alert"]');
          for (const a of alerts) {
            if (a.textContent.includes('no longer exists')) return 'visible';
          }
          return 'absent';
        });
        record(
          '(P.2) warning Alert "…no longer exists…" visible inside HandlerEditorModal',
          '"visible" — Alert with text containing "no longer exists" found in dialog',
          `result=${alertVisible}`,
          alertVisible === 'visible',
        );

        // P.3 — Save/Add button is disabled while stale reference is unresolved.
        const saveDisabled = await staleTab.evaluate(() => {
          const dialog = document.querySelector('[data-testid="handler-editor-modal"]');
          if (!dialog) return 'no-dialog';
          const btns = dialog.querySelectorAll('button');
          for (const btn of btns) {
            const text = btn.textContent.trim();
            if (text === 'Save' || text === 'Add') {
              return btn.disabled ? 'disabled' : 'enabled';
            }
          }
          return 'btn-not-found';
        });
        record(
          '(P.3) Save/Add button disabled while stale lead-status ref is unresolved',
          '"disabled" — Save/Add button in dialog has disabled attribute',
          `result=${saveDisabled}`,
          saveDisabled === 'disabled',
        );

        // P.4 — Select a valid intermediateLeadStatus; Save/Add must enable.
        // The stale Select is the only FormControl in Mui-error state.
        const interErrSelHandle = await clickMuiSelect(
          staleTab,
          '[data-testid="intermediate-ls-select-trigger"]',
        );
        let interSelectClicked;
        if (interErrSelHandle) {
          interSelectClicked = 'clicked';
        } else {
          interSelectClicked = await staleTab.evaluate(() => {
            return document.querySelector('[data-testid="handler-editor-modal"]') ? 'no-error-select' : 'no-dialog';
          });
        }
        await new Promise(r => setTimeout(r, 500));
        // The MUI listbox portal renders at document root (outside the dialog).
        // Option clicks via evaluate() are fine — they only need a synthetic
        // click to trigger the onChange handler.
        const interOptionPicked = await staleTab.evaluate(() => {
          const listbox = document.querySelector('[role="listbox"]');
          if (!listbox) return 'no-listbox';
          const opts = listbox.querySelectorAll('[role="option"]');
          for (const opt of opts) {
            const text = opt.textContent.trim();
            if (text && text !== '— none —' &&
                opt.getAttribute('aria-disabled') !== 'true') {
              opt.click();
              return `picked:${text}`;
            }
          }
          return 'no-pickable-option';
        });
        await new Promise(r => setTimeout(r, 400));
        const saveEnabled = await staleTab.evaluate(() => {
          const dialog = document.querySelector('[data-testid="handler-editor-modal"]');
          if (!dialog) return 'no-dialog';
          const btns = dialog.querySelectorAll('button');
          for (const btn of btns) {
            const text = btn.textContent.trim();
            if (text === 'Save' || text === 'Add') {
              return btn.disabled ? 'still-disabled' : 'enabled';
            }
          }
          return 'btn-not-found';
        });
        record(
          '(P.4) Save/Add enabled after selecting a valid intermediateLeadStatus',
          '"enabled" — Save/Add transitions disabled→enabled after valid option chosen',
          `click=${interSelectClicked} pick=${interOptionPicked} save=${saveEnabled}`,
          saveEnabled === 'enabled',
        );
      } else {
        skip('(P.2) warning Alert in HandlerEditorModal', 'n/a', 'SKIPPED — dialog did not open');
        skip('(P.3) Save/Add button disabled', 'n/a', 'SKIPPED — dialog did not open');
        skip('(P.4) Save/Add enabled after fix', 'n/a', 'SKIPPED — dialog did not open');
      }

      await staleTab.close();
      // Clean up the handler (FK cascade removes the binding).
      await adminClient.delete(`/api/admin/card-action-handlers/${staleHandlerId}`);

      // ── P.sub: stale submittedLeadStatus path ────────────────────────────────
      // Seed a separate handler whose submittedLeadStatus is a nonexistent key.
      const pSubHandlerRes = await adminClient.post('/api/admin/card-action-handlers', {
        name: HANDLER_NAME_STALE_SUB,
        type: 'start_design_visit',
        config: { submittedLeadStatus: STALE_SUB_LS, defaultDurationMin: 90 },
      });
      const pSubHandlerId = pSubHandlerRes.status === 201 ? pSubHandlerRes.json?.id : null;
      record(
        '(P.sub.setup) Seed start_design_visit handler with stale submittedLeadStatus',
        '201 — handler created with a submittedLeadStatus key absent from DB',
        `status=${pSubHandlerRes.status} id=${pSubHandlerId}`,
        pSubHandlerRes.status === 201,
      );

      if (pSubHandlerId) {
        const subTab = await browser.newPage();
        await subTab.setCacheEnabled(false);
        await injectSession(subTab, adminClient.cookie);
        await subTab.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        // Visit cardactions first so CardActionsPage mounts and loads stage-action
        // labels (required by _buildActionSlotGroups for slots to be visible).
        await subTab.evaluate(() => {
          if (typeof switchTab === 'function') switchTab('cardactions');
        });
        await new Promise(r => setTimeout(r, 400));
        await subTab.evaluate(() => {
          if (typeof switchTab === 'function') switchTab('actionhandlers');
        });
        await pollPage(
          subTab,
          () => typeof window.openHandlerEditor === 'function',
          null,
          10000,
        );
        await subTab.evaluate(async () => {
          const p1 = typeof loadCardActionsAdmin === 'function'
            ? loadCardActionsAdmin() : Promise.resolve();
          const p2 = typeof loadCardActionHandlersAdmin === 'function'
            ? loadCardActionHandlersAdmin() : Promise.resolve();
          return Promise.all([p1, p2]);
        });
        await new Promise(r => setTimeout(r, 800));

        // P.sub.1 — stale chip for submittedLeadStatus
        const subChip = await pollPage(
          subTab,
          () => document.querySelector('[data-testid="stale-status-warning"]') ? 'visible' : null,
          null,
          8000,
        );
        record(
          '(P.sub.1) HandlerSummary shows "Status deleted" chip for stale submittedLeadStatus',
          '"visible" — [data-testid="stale-status-warning"] present for submitted path',
          `result=${subChip}`,
          subChip === 'visible',
        );

        // P.sub.2 + P.sub.3 — open editor via the "Change" button
        const subChangeClicked = await subTab.evaluate(() => {
          const rows = document.querySelectorAll('tr.adm-handlers-row');
          for (const row of rows) {
            if (!row.querySelector('[data-testid="stale-status-warning"]')) continue;
            const btns = row.querySelectorAll('button');
            for (const btn of btns) {
              const text = btn.textContent.trim();
              if (text && text !== 'Remove' && text !== 'Delete') {
                btn.click();
                return 'clicked';
              }
            }
          }
          return 'no-change-btn';
        });
        await new Promise(r => setTimeout(r, 800));

        const subDialogOpen = await subTab.evaluate(
          () => !!document.querySelector('[data-testid="handler-editor-modal"]'),
        );
        record(
          '(P.sub.2 (dialog)) HandlerEditorModal opens for stale submittedLeadStatus handler',
          'true — handler-editor-modal testid present after clicking Change',
          `clicked=${subChangeClicked} dialog=${subDialogOpen}`,
          subDialogOpen,
        );

        if (subDialogOpen) {
          const subAlertText = await subTab.evaluate(() => {
            const dialog = document.querySelector('[data-testid="handler-editor-modal"]');
            if (!dialog) return null;
            const alert = dialog.querySelector('[role="alert"]');
            return alert ? alert.textContent : null;
          });
          record(
            '(P.sub.2 (alert)) Warning Alert visible in editor for stale submittedLeadStatus',
            'Alert contains "no longer exists"',
            `text=${(subAlertText || '').slice(0, 80)}`,
            (subAlertText || '').includes('no longer exists'),
          );

          const subSaveDisabled = await subTab.evaluate(() => {
            const dialog = document.querySelector('[data-testid="handler-editor-modal"]');
            if (!dialog) return 'no-dialog';
            const btns = dialog.querySelectorAll('button');
            for (const btn of btns) {
              const text = btn.textContent.trim();
              if (text === 'Save' || text === 'Add') {
                return btn.disabled ? 'disabled' : 'enabled';
              }
            }
            return 'btn-not-found';
          });
          record(
            '(P.sub.3) Save/Add disabled while stale submittedLeadStatus is unresolved',
            '"disabled" — Save/Add has disabled attribute',
            `result=${subSaveDisabled}`,
            subSaveDisabled === 'disabled',
          );

          // P.sub.4 — Select a valid submittedLeadStatus; Save/Add must enable.
          const subErrSelHandle = await clickMuiSelect(
            subTab,
            '[data-testid="submitted-ls-select-trigger"]',
          );
          let subSelectClicked;
          if (subErrSelHandle) {
            subSelectClicked = 'clicked';
          } else {
            subSelectClicked = await subTab.evaluate(() => {
              return document.querySelector('[data-testid="handler-editor-modal"]') ? 'no-error-select' : 'no-dialog';
            });
          }
          await new Promise(r => setTimeout(r, 500));
          const subOptionPicked = await subTab.evaluate(() => {
            const listbox = document.querySelector('[role="listbox"]');
            if (!listbox) return 'no-listbox';
            const opts = listbox.querySelectorAll('[role="option"]');
            for (const opt of opts) {
              const text = opt.textContent.trim();
              if (text && text !== '— none —' &&
                  opt.getAttribute('aria-disabled') !== 'true') {
                opt.click();
                return `picked:${text}`;
              }
            }
            return 'no-pickable-option';
          });
          await new Promise(r => setTimeout(r, 400));
          const subSaveEnabled = await subTab.evaluate(() => {
            const dialog = document.querySelector('[data-testid="handler-editor-modal"]');
            if (!dialog) return 'no-dialog';
            const btns = dialog.querySelectorAll('button');
            for (const btn of btns) {
              const text = btn.textContent.trim();
              if (text === 'Save' || text === 'Add') {
                return btn.disabled ? 'still-disabled' : 'enabled';
              }
            }
            return 'btn-not-found';
          });
          record(
            '(P.sub.4) Save/Add enabled after selecting a valid submittedLeadStatus',
            '"enabled" — Save/Add transitions disabled→enabled after valid option chosen',
            `click=${subSelectClicked} pick=${subOptionPicked} save=${subSaveEnabled}`,
            subSaveEnabled === 'enabled',
          );
        } else {
          skip('(P.sub.2 (alert))', 'n/a', 'SKIPPED — dialog did not open');
          skip('(P.sub.3) Save/Add disabled', 'n/a', 'SKIPPED — dialog did not open');
          skip('(P.sub.4) Save/Add enabled after fix', 'n/a', 'SKIPPED — dialog did not open');
        }

        await subTab.close();
        await adminClient.delete(`/api/admin/card-action-handlers/${pSubHandlerId}`);
      } else {
        [
          'P.sub.1', 'P.sub.2 (dialog)', 'P.sub.2 (alert)', 'P.sub.3', 'P.sub.4',
        ].forEach(p => {
          skip(`(${p}) stale submittedLeadStatus`, 'n/a', 'SKIPPED — P.sub handler seed failed');
        });
      }
    } else {
      [
        'P.1', 'P.2 (chip)', 'P.2 (dialog)', 'P.2 (alert)', 'P.3', 'P.4',
        'P.sub.setup', 'P.sub.1', 'P.sub.2 (dialog)', 'P.sub.2 (alert)', 'P.sub.3', 'P.sub.4',
      ].forEach(p => {
        skip(`(${p}) stale lead-status warning`, 'n/a', 'SKIPPED — handler seed failed');
      });
    }
    // Clean up the slot's lead_status_config row.
    await pool.query(`DELETE FROM lead_status_config WHERE key = $1`, [LBL_KEY_STALE_SLOT]).catch(() => {});
  }

  } finally {
    await browser.close().catch(() => {});
  }

  // ── (K) Orphan-binding cleanup on lead-status delete ──────────────────────
  //
  // Verifies that deleting a lead status via
  // DELETE /api/admin/lead-statuses/:key removes any card_action_handler_bindings
  // rows that pointed at that status_key, leaving no orphaned rows.
  //
  // This is a pure-API probe — no browser required.
  {
    console.log('\n  [K] Orphan-binding cleanup on lead-status delete');

    // lead_status_config.key is always stored uppercase (POST route forces .toUpperCase()).
    // card_action_handler_bindings.status_key is always stored lowercase
    // (_validateHandlerBinding forces .toLowerCase()).
    // The DELETE route uses LOWER($1) to bridge this gap.
    const LS_KEY_UPPER  = 'PRIVTEST_CAH_ORPHAN_LS'; // as stored in lead_status_config
    const LS_KEY_LOWER  = 'privtest_cah_orphan_ls'; // as stored in bindings

    // Seed the lead status using the POST admin route so it gets the canonical
    // uppercase key (the route enforces .toUpperCase() itself).
    const seedLsRes = await adminClient.post('/api/admin/lead-statuses', {
      key: LS_KEY_UPPER, label: 'PrivTest orphan LS', stage: 'SALES',
    });
    // Use ON CONFLICT fallback in case a prior crashed run left the row.
    if (seedLsRes.status !== 201 && seedLsRes.status !== 409) {
      await pool.query(
        `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales, stage)
         VALUES ($1, 'PrivTest orphan LS', 9995, false, 'SALES')
         ON CONFLICT (key) DO NOTHING`,
        [LS_KEY_UPPER]
      );
    }

    // Create a handler bound to the orphan status (binding API lowercases the key).
    const createOrphanRes = await adminClient.post('/api/admin/card-action-handlers', {
      name: 'PrivTest orphan cleanup handler',
      type: 'summarise_phone_call',
      config: {},
      bindings: [{ stage_key: 'sales', status_key: LS_KEY_LOWER }],
    });
    const orphanHandlerId = createOrphanRes.json?.id;
    record(
      '(K.setup) POST handler bound to orphan-test lead status',
      'status=201 with numeric id',
      `status=${createOrphanRes.status} id=${orphanHandlerId}`,
      createOrphanRes.status === 201 && Number.isInteger(orphanHandlerId),
    );

    if (orphanHandlerId) {
      // Confirm the binding row exists (stored as lowercase) before the delete.
      const beforeRows = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM card_action_handler_bindings
          WHERE handler_id = $1 AND status_key = $2`,
        [orphanHandlerId, LS_KEY_LOWER]
      );
      record(
        '(K.1) Binding row (lowercase key) exists before lead-status delete',
        '1 binding row',
        `${beforeRows.rows[0].cnt} row(s)`,
        beforeRows.rows[0].cnt === 1,
      );

      // Delete the lead status via the admin API (key is uppercase in the URL).
      // The route uses LOWER($1) so the lowercase binding is matched correctly.
      const delLsRes = await adminClient.delete(`/api/admin/lead-statuses/${LS_KEY_UPPER}`);
      record(
        '(K.2) DELETE /api/admin/lead-statuses/:key (uppercase) succeeds',
        'status=200, ok=true',
        `status=${delLsRes.status} ok=${delLsRes.json?.ok}`,
        delLsRes.status === 200 && delLsRes.json?.ok === true,
      );

      // Confirm the binding row is gone — LOWER($1) matched the lowercase stored key.
      const afterRows = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM card_action_handler_bindings
          WHERE handler_id = $1 AND status_key = $2`,
        [orphanHandlerId, LS_KEY_LOWER]
      );
      record(
        '(K.3) Binding row removed after lead-status delete (no orphan, case-insensitive match)',
        '0 binding rows',
        `${afterRows.rows[0].cnt} row(s)`,
        afterRows.rows[0].cnt === 0,
      );

      // (K.4) Stage-default binding (status_key='') survives an unrelated lead-status delete.
      // Seed a stage-default binding for the same handler temporarily.
      try {
        await pool.query(
          `INSERT INTO card_action_handler_bindings (handler_id, stage_key, status_key)
             VALUES ($1, 'sales', '')
           ON CONFLICT DO NOTHING`,
          [orphanHandlerId]
        );
        // Seed a second throwaway lead status and delete it.
        const LS_KEY_THROWAWAY = 'PRIVTEST_CAH_THROWAWAY';
        await pool.query(
          `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales, stage)
           VALUES ($1, 'PrivTest throwaway LS', 9994, false, 'SALES')
           ON CONFLICT (key) DO NOTHING`,
          [LS_KEY_THROWAWAY]
        );
        await adminClient.delete(`/api/admin/lead-statuses/${LS_KEY_THROWAWAY}`);
        const defaultAfter = await pool.query(
          `SELECT COUNT(*)::int AS cnt FROM card_action_handler_bindings
            WHERE handler_id = $1 AND status_key = '' AND stage_key = 'sales'`,
          [orphanHandlerId]
        );
        record(
          '(K.4) Stage-default binding (status_key=\'\') survives unrelated lead-status delete',
          '1 stage-default binding row',
          `${defaultAfter.rows[0].cnt} row(s)`,
          defaultAfter.rows[0].cnt === 1,
        );
      } catch (e) {
        skip('(K.4) Stage-default binding survival check', 'no error', e.message);
      }

      // Clean up the handler (and any remaining bindings via ON DELETE CASCADE).
      await adminClient.delete(`/api/admin/card-action-handlers/${orphanHandlerId}`);
    } else {
      // Handler creation failed — clean up the lead status we seeded.
      await pool.query(`DELETE FROM lead_status_config WHERE key = $1`, [LS_KEY_UPPER]);
    }
    // Also clean up the throwaway status in case it survived.
    await pool.query(`DELETE FROM lead_status_config WHERE key = 'PRIVTEST_CAH_THROWAWAY'`).catch(() => {});
  }

  // ── (R) Handler-bound indicator on Default handler type selector ──────────
  //
  // Verifies that the MUI Select for "Default handler type" in CardActionsPage
  // has opacity 0.5 when a card_action_handler_bindings row exists for that
  // substatus_id, and opacity 1 when no binding exists.
  //
  // Assertions:
  //   R.setup — seed a lead status + two sub-statuses + one bound handler.
  //   R.1     — Select in the BOUND sub-status row has computed opacity 0.5.
  //   R.2     — Select in the UNBOUND sub-status row has computed opacity 1.
  {
    console.log('\n  [R] Handler-bound indicator on Default handler type selector');

    // Seed the parent lead_status_config row.
    await pool.query(
      `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales, stage)
       VALUES ($1, 'PrivTest Bound-Ind Status', 9987, false, 'SALES')
       ON CONFLICT (key) DO UPDATE
         SET label               = EXCLUDED.label,
             sort_order          = EXCLUDED.sort_order,
             excluded_from_sales = EXCLUDED.excluded_from_sales,
             stage               = EXCLUDED.stage`,
      [LBL_KEY_BOUND_IND]
    );

    // Bound substatus — will receive a handler binding via substatus_id.
    const rBoundRes = await pool.query(
      `INSERT INTO lead_substatuses (status_key, substatus_key, label, action_label, sort_order)
       VALUES ($1, $2, 'PrivTest R bound sub', 'PrivTest R bound action', 9997)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [LBL_KEY_BOUND_IND, 'PRIVTEST_R_BOUND'],
    );
    let rBoundSubId = rBoundRes.rows[0]?.id;
    if (!rBoundSubId) {
      const r = await pool.query(
        `SELECT id FROM lead_substatuses WHERE status_key = $1 AND substatus_key = $2`,
        [LBL_KEY_BOUND_IND, 'PRIVTEST_R_BOUND'],
      );
      rBoundSubId = r.rows[0]?.id;
    }

    // Unbound substatus — no handler binding.
    const rFreeRes = await pool.query(
      `INSERT INTO lead_substatuses (status_key, substatus_key, label, action_label, sort_order)
       VALUES ($1, $2, 'PrivTest R free sub', 'PrivTest R free action', 9996)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [LBL_KEY_BOUND_IND, 'PRIVTEST_R_FREE'],
    );
    let rFreeSubId = rFreeRes.rows[0]?.id;
    if (!rFreeSubId) {
      const r = await pool.query(
        `SELECT id FROM lead_substatuses WHERE status_key = $1 AND substatus_key = $2`,
        [LBL_KEY_BOUND_IND, 'PRIVTEST_R_FREE'],
      );
      rFreeSubId = r.rows[0]?.id;
    }

    // Create a handler and bind it to the bound substatus via substatus_id.
    let rHandlerId = null;
    if (rBoundSubId) {
      const rCreateRes = await adminClient.post('/api/admin/card-action-handlers', {
        name: HANDLER_NAME_BOUND_IND,
        type: 'summarise_phone_call',
        config: {},
        bindings: [{ substatus_id: rBoundSubId }],
      });
      rHandlerId = rCreateRes.json?.id ?? null;
      record(
        '(R.setup) POST handler bound to sub-status via substatus_id',
        'status=201 with numeric id',
        `status=${rCreateRes.status} id=${rHandlerId}`,
        rCreateRes.status === 201 && Number.isInteger(rHandlerId),
      );
    } else {
      skip('(R.setup) POST handler bound to sub-status via substatus_id', 'status=201', 'SKIPPED — seed failed');
    }

    if (rHandlerId && rBoundSubId && rFreeSubId && browser) {
      const rTab = await browser.newPage();
      await rTab.setCacheEnabled(false);
      await injectSession(rTab, adminClient.cookie);
      await rTab.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded', timeout: 20000 });

      // Switch to Card Actions tab so CardActionsPage mounts.
      await rTab.evaluate(() => {
        if (typeof switchTab === 'function') switchTab('cardactions');
      });
      await pollPage(
        rTab,
        () => typeof window.loadCardActionsAdmin === 'function',
        null,
        10000,
      );

      // Trigger a fresh data load so the newly-seeded rows are visible.
      await rTab.evaluate(() => {
        if (typeof window.loadCardActionsAdmin === 'function') window.loadCardActionsAdmin();
      });

      // Wait for both substatus rows to appear in the DOM.
      await pollPage(
        rTab,
        (id) => !!document.querySelector(`[data-sub-id="${id}"]`),
        String(rBoundSubId),
        8000,
      );
      await pollPage(
        rTab,
        (id) => !!document.querySelector(`[data-sub-id="${id}"]`),
        String(rFreeSubId),
        8000,
      );

      // Give React a moment to finish rendering the MUI Select elements.
      await new Promise(r => setTimeout(r, 400));

      // ── R.1 — bound substatus row: Select opacity should be 0.5 ─────────────
      const boundOpacity = await rTab.evaluate((id) => {
        const row = document.querySelector(`[data-sub-id="${id}"]`);
        if (!row) return 'row-absent';
        const selectRoot = row.querySelector('[data-testid="handler-type-select-root"]');
        if (!selectRoot) return 'select-absent';
        return getComputedStyle(selectRoot).opacity;
      }, String(rBoundSubId));

      record(
        '(R.1) Default handler type Select has opacity 0.5 when handler binding exists',
        '0.5 — MuiInputBase-root computed opacity for bound substatus row',
        `opacity=${boundOpacity}`,
        boundOpacity === '0.5',
      );

      // ── R.2 — unbound substatus row: Select opacity should be 1 ─────────────
      const freeOpacity = await rTab.evaluate((id) => {
        const row = document.querySelector(`[data-sub-id="${id}"]`);
        if (!row) return 'row-absent';
        const selectRoot = row.querySelector('[data-testid="handler-type-select-root"]');
        if (!selectRoot) return 'select-absent';
        return getComputedStyle(selectRoot).opacity;
      }, String(rFreeSubId));

      record(
        '(R.2) Default handler type Select has opacity 1 when no binding exists',
        '1 — MuiInputBase-root computed opacity for unbound substatus row',
        `opacity=${freeOpacity}`,
        freeOpacity === '1',
      );

      await rTab.close();

      // Clean up: delete the handler (FK cascade removes the binding).
      await adminClient.delete(`/api/admin/card-action-handlers/${rHandlerId}`);
    } else if (!browser) {
      skip('(R.1) Select opacity 0.5 for bound substatus', 'n/a', 'SKIPPED — Puppeteer not available');
      skip('(R.2) Select opacity 1 for unbound substatus', 'n/a', 'SKIPPED — Puppeteer not available');
    } else {
      skip('(R.1) Select opacity 0.5 for bound substatus', 'n/a', 'SKIPPED — seed failed');
      skip('(R.2) Select opacity 1 for unbound substatus', 'n/a', 'SKIPPED — seed failed');
    }
  }

  // ── (Q) Startup seeding — ensureSubstatusHandlerBindings ──────────────────
  //
  // Verifies that the startup routine auto-inserts card_action_handler_bindings
  // rows for every lead_substatuses row that has a non-empty action_label and
  // no existing binding, and that it does NOT overwrite a binding that was
  // set by an admin before the server restarted.
  //
  // The probe is pure-API + DB: no browser required.  It requires one server
  // restart: fixtures are seeded while the current server is running (so the
  // admin API is available for creating the pre-existing handler/binding), then
  // the server is killed and a fresh one is spawned.  ensureSubstatusHandlerBindings
  // runs inside app.listen() so the DB is polled — not just waitForServer — to
  // confirm the async startup routine completed before asserting.
  //
  // Assertions:
  //   Q.1 — A substatus with action_label and no prior binding receives a new
  //          card_action_handler_bindings row after server boot.  The auto-chosen
  //          handler type is show_message (FALLBACK_HANDLER — SUB_STARTUP_UNBOUND_K
  //          is intentionally absent from SUBSTATUS_HANDLER_MAP).
  //   Q.2 — A substatus with action_label that already has a binding keeps the
  //          same handler_id after the restart.  The pre-existing binding is NOT
  //          overwritten (admin overrides are always respected).
  {
    console.log('\n  [Q] Startup seeding — ensureSubstatusHandlerBindings');

    // Seed the parent lead_status_config row (FK required by lead_substatuses).
    // LOWER('PRIVTEST_CAH_STARTUP') = 'privtest_cah_startup' matches the
    // 'privtest_cah_%' pattern in purgeFixtures, so no extra lead_status_config
    // cleanup is needed here.
    await pool.query(
      `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales, stage)
       VALUES ($1, 'PrivTest Q Startup Status', 9988, false, 'SALES')
       ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label`,
      [LBL_KEY_STARTUP]
    );

    // Q fixture 1: substatus with action_label, no existing binding.
    // ensureSubstatusHandlerBindings should create a binding for this one.
    const qSub1Res = await pool.query(
      `INSERT INTO lead_substatuses
         (status_key, substatus_key, label, action_label, sort_order)
       VALUES ($1, $2, 'PrivTest Q sub unbound', 'PrivTest Q action A', 9997)
       RETURNING id`,
      [LBL_KEY_STARTUP, SUB_STARTUP_UNBOUND_K]
    );
    const qSub1Id = qSub1Res.rows[0].id;

    // Q fixture 2: substatus with action_label + a manually-created binding.
    // ensureSubstatusHandlerBindings should SKIP this one (binding already exists).
    const qSub2Res = await pool.query(
      `INSERT INTO lead_substatuses
         (status_key, substatus_key, label, action_label, sort_order)
       VALUES ($1, $2, 'PrivTest Q sub prebound', 'PrivTest Q action B', 9998)
       RETURNING id`,
      [LBL_KEY_STARTUP, SUB_STARTUP_PREBOUND_K]
    );
    const qSub2Id = qSub2Res.rows[0].id;

    // Q fixture 3: substatus whose substatus_key is present in SUBSTATUS_HANDLER_MAP
    // (AWPH_RECEIVED → review_customer_photos).  No pre-existing binding so
    // ensureSubstatusHandlerBindings must create one with the mapped handler type,
    // not the show_message fallback.
    const qSub3Res = await pool.query(
      `INSERT INTO lead_substatuses
         (status_key, substatus_key, label, action_label, sort_order)
       VALUES ($1, $2, 'PrivTest Q sub mapped', 'PrivTest Q action C', 9996)
       RETURNING id`,
      [LBL_KEY_STARTUP, SUB_STARTUP_MAPPED_K]
    );
    const qSub3Id = qSub3Res.rows[0].id;

    // Create the pre-existing handler via the admin API (server is still running).
    const qPreRes = await adminClient.post('/api/admin/card-action-handlers', {
      name: HANDLER_NAME_Q_PRE,
      type: 'summarise_phone_call',
      config: {},
      bindings: [],
    });
    const qPreHandlerId = qPreRes.json?.id ?? null;
    const qPreOk = Number.isInteger(qPreHandlerId);

    if (qPreOk) {
      // Bind the pre-existing handler directly in the DB (substatus_id binding).
      await pool.query(
        `INSERT INTO card_action_handler_bindings (handler_id, substatus_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [qPreHandlerId, qSub2Id]
      );
      console.log(`  Q: pre-existing binding created — handler_id=${qPreHandlerId} substatus_id=${qSub2Id}`);
    } else {
      console.warn(`  Q: pre-existing handler create failed — Q.2 will be skipped`);
    }

    // Kill the current server and wait for it to exit cleanly.
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 2500));

    // Spawn a fresh server — ensureSubstatusHandlerBindings will run on boot.
    const { child: qChild, logBuf: qLogBuf } = spawnServer();
    let qChildExited = false;
    qChild.on('exit', () => { qChildExited = true; });

    let qBootOk = false;
    try {
      await waitForServer(20000);
      qBootOk = true;
    } catch (e) {
      console.error('Q server boot failed:', e.message);
      console.error(qLogBuf.join('').slice(-2000));
    }

    if (!qBootOk) {
      skip('(Q.1) ensureSubstatusHandlerBindings inserts binding on boot', '1 binding row', 'SKIPPED — server restart failed');
      skip('(Q.2) Pre-existing binding not overwritten on restart', 'same handler_id', 'SKIPPED — server restart failed');
      skip('(Q.3) SUBSTATUS_HANDLER_MAP key resolves to mapped handler type on boot', 'handler type=review_customer_photos', 'SKIPPED — server restart failed');
      try { qChild.kill('SIGTERM'); } catch {}
    } else {
      // Poll for the Q.1 auto-binding: ensureSubstatusHandlerBindings runs async
      // inside app.listen() so the server may respond to HTTP before the routine
      // finishes.  Poll up to 15 s.
      const qBindRow = await pollFn(async () => {
        const r = await pool.query(
          `SELECT b.handler_id, h.type
             FROM card_action_handler_bindings b
             JOIN card_action_handlers h ON h.id = b.handler_id
            WHERE b.substatus_id = $1`,
          [qSub1Id]
        );
        return r.rows.length > 0 ? r.rows[0] : null;
      }, 15000, 300);

      record(
        '(Q.1) ensureSubstatusHandlerBindings inserts binding for labelled substatus on boot',
        'binding row created with handler type=show_message (FALLBACK_HANDLER)',
        `row=${JSON.stringify(qBindRow)}`,
        qBindRow !== null && qBindRow.type === 'show_message',
      );

      // Q.2: verify the pre-existing binding is unchanged (same handler_id).
      if (qPreOk) {
        const qPreboundRow = await pool.query(
          `SELECT handler_id FROM card_action_handler_bindings WHERE substatus_id = $1`,
          [qSub2Id]
        );
        const q2HandlerId = qPreboundRow.rows[0]?.handler_id ?? null;
        record(
          '(Q.2) Pre-existing admin binding not overwritten by ensureSubstatusHandlerBindings',
          `handler_id=${qPreHandlerId} (unchanged after restart)`,
          `handler_id=${q2HandlerId}`,
          q2HandlerId === qPreHandlerId,
        );
      } else {
        record(
          '(Q.2) Pre-existing admin binding not overwritten by ensureSubstatusHandlerBindings',
          'handler_id unchanged after restart',
          'SKIPPED — pre-existing handler seed failed',
          false,
        );
      }

      // Q.3: verify that a substatus whose substatus_key is present in
      // SUBSTATUS_HANDLER_MAP receives a binding with the mapped handler type
      // (review_customer_photos), NOT the show_message fallback.
      // Poll alongside Q.1 because both bindings are created in the same
      // ensureSubstatusHandlerBindings pass on startup.
      const qMappedRow = await pollFn(async () => {
        const r = await pool.query(
          `SELECT b.handler_id, h.type
             FROM card_action_handler_bindings b
             JOIN card_action_handlers h ON h.id = b.handler_id
            WHERE b.substatus_id = $1`,
          [qSub3Id]
        );
        return r.rows.length > 0 ? r.rows[0] : null;
      }, 15000, 300);

      record(
        '(Q.3) SUBSTATUS_HANDLER_MAP key (AWPH_RECEIVED) resolves to review_customer_photos on boot',
        'binding row created with handler type=review_customer_photos (SUBSTATUS_HANDLER_MAP lookup)',
        `row=${JSON.stringify(qMappedRow)}`,
        qMappedRow !== null && qMappedRow.type === 'review_customer_photos',
      );

      // Shut down the restarted server.
      qChild.kill('SIGTERM');
      // Wait briefly so port 5050 is released before the process exits.
      await new Promise(r => setTimeout(r, 1500));
    }

    // Fixtures are cleaned up by purgeFixtures (called from cleanupAndExit):
    // - lead_substatuses WHERE status_key = LBL_KEY_STARTUP  (explicit entry above,
    //   covers qSub1, qSub2, and qSub3; bindings cascade-deleted with their substatus)
    // - card_action_handlers WHERE name = HANDLER_NAME_Q_PRE (explicit entry above)
    // - card_action_handlers WHERE name = 'Review customer photos' AND NOT EXISTS
    //   bindings (explicit entry above — only removes the auto-created handler in
    //   isolated-DB runs; in shared-DB the real AWPH binding keeps the handler alive)
    // - lead_status_config  WHERE LOWER(key) LIKE 'privtest_cah_%' (covers PRIVTEST_CAH_STARTUP)
    // Bindings are cascade-deleted when their substatus or handler is deleted.
  }

  // ── (R) default_handler_type column ──────────────────────────────────────
  //
  // Verifies that:
  //   R.1 — a lead_substatuses row whose default_handler_type column is set to
  //          'start_design_visit' causes ensureSubstatusHandlerBindings to create
  //          a binding pointing at a handler of that type, bypassing both
  //          SUBSTATUS_HANDLER_MAP and FALLBACK_HANDLER.
  //   R.2 — a row with NULL default_handler_type whose substatus_key is present
  //          in SUBSTATUS_HANDLER_MAP (AWPH_RECEIVED) still resolves to
  //          review_customer_photos, confirming that the map lookup is NOT
  //          skipped when the column is empty.
  //
  // No server is running at this point (qChild was shut down at the end of Q).
  // Fixtures are inserted directly into the DB, then a fresh server is spawned.
  {
    console.log('\n  [R] default_handler_type column — ensureSubstatusHandlerBindings');

    // Seed the parent lead_status_config row (FK required by lead_substatuses).
    // LOWER('PRIVTEST_CAH_DEFTYPE') = 'privtest_cah_deftype' matches the
    // 'privtest_cah_%' pattern in purgeFixtures.
    await pool.query(
      `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales, stage)
       VALUES ($1, 'PrivTest R Default-Type Status', 9987, false, 'SALES')
       ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label`,
      [LBL_KEY_DEFAULT_TYPE]
    );

    // R fixture 1: default_handler_type = 'start_design_visit', no prior binding.
    // ensureSubstatusHandlerBindings must create a binding with that handler type.
    const rSub1Res = await pool.query(
      `INSERT INTO lead_substatuses
         (status_key, substatus_key, label, action_label, sort_order, default_handler_type)
       VALUES ($1, $2, 'PrivTest R sub deftype', 'PrivTest R action A', 9995, 'start_design_visit')
       RETURNING id`,
      [LBL_KEY_DEFAULT_TYPE, SUB_DEFAULT_TYPE_K]
    );
    const rSub1Id = rSub1Res.rows[0].id;
    console.log(`  R: seeded rSub1 id=${rSub1Id} default_handler_type=start_design_visit`);

    // R fixture 2: NULL default_handler_type, substatus_key = AWPH_RECEIVED.
    // SUBSTATUS_HANDLER_MAP maps this key to review_customer_photos; with
    // default_handler_type empty, SUBSTATUS_HANDLER_MAP should win.
    const rSub2Res = await pool.query(
      `INSERT INTO lead_substatuses
         (status_key, substatus_key, label, action_label, sort_order)
       VALUES ($1, $2, 'PrivTest R sub mapped no-deftype', 'PrivTest R action B', 9994)
       RETURNING id`,
      [LBL_KEY_DEFAULT_TYPE, SUB_DEFAULT_MAPPED_K]
    );
    const rSub2Id = rSub2Res.rows[0].id;
    console.log(`  R: seeded rSub2 id=${rSub2Id} default_handler_type=NULL substatus_key=${SUB_DEFAULT_MAPPED_K}`);

    // Spawn a fresh server — ensureSubstatusHandlerBindings will run on boot.
    const { child: rChild, logBuf: rLogBuf } = spawnServer();
    let rChildExited = false;
    rChild.on('exit', () => { rChildExited = true; });

    let rBootOk = false;
    try {
      await waitForServer(20000);
      rBootOk = true;
    } catch (e) {
      console.error('R server boot failed:', e.message);
      console.error(rLogBuf.join('').slice(-2000));
    }

    if (!rBootOk) {
      skip('(R.1) default_handler_type column drives handler type on boot', 'handler type=start_design_visit', 'SKIPPED — server restart failed');
      skip('(R.2) SUBSTATUS_HANDLER_MAP wins when default_handler_type is empty', 'handler type=review_customer_photos', 'SKIPPED — server restart failed');
      try { if (!rChildExited) rChild.kill('SIGTERM'); } catch {}
    } else {
      // Poll for R.1: default_handler_type = 'start_design_visit' must produce
      // a binding with that exact handler type.
      const rBind1 = await pollFn(async () => {
        const r = await pool.query(
          `SELECT b.handler_id, h.type
             FROM card_action_handler_bindings b
             JOIN card_action_handlers h ON h.id = b.handler_id
            WHERE b.substatus_id = $1`,
          [rSub1Id]
        );
        return r.rows.length > 0 ? r.rows[0] : null;
      }, 15000, 300);

      record(
        '(R.1) default_handler_type column drives handler type on boot',
        'binding row created with handler type=start_design_visit (from default_handler_type column)',
        `row=${JSON.stringify(rBind1)}`,
        rBind1 !== null && rBind1.type === 'start_design_visit',
      );

      // Poll for R.2: NULL default_handler_type + AWPH_RECEIVED key in
      // SUBSTATUS_HANDLER_MAP → must resolve to review_customer_photos.
      const rBind2 = await pollFn(async () => {
        const r = await pool.query(
          `SELECT b.handler_id, h.type
             FROM card_action_handler_bindings b
             JOIN card_action_handlers h ON h.id = b.handler_id
            WHERE b.substatus_id = $1`,
          [rSub2Id]
        );
        return r.rows.length > 0 ? r.rows[0] : null;
      }, 15000, 300);

      record(
        '(R.2) SUBSTATUS_HANDLER_MAP wins when default_handler_type is empty',
        'binding row created with handler type=review_customer_photos (SUBSTATUS_HANDLER_MAP, default_handler_type=null)',
        `row=${JSON.stringify(rBind2)}`,
        rBind2 !== null && rBind2.type === 'review_customer_photos',
      );

      rChild.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1500));
    }

    // Fixtures are cleaned up by purgeFixtures (called from cleanupAndExit):
    // - lead_substatuses WHERE status_key = LBL_KEY_DEFAULT_TYPE (covers rSub1,
    //   rSub2; bindings cascade-deleted with their substatus rows)
    // - card_action_handlers WHERE name = 'Start design visit' AND NOT EXISTS
    //   bindings (explicit entry in purgeFixtures — removes the auto-created
    //   handler in isolated-DB runs; in shared-DB any real binding keeps it alive)
    // - card_action_handlers WHERE name = 'Review customer photos' AND NOT EXISTS
    //   bindings (shared with Q.3 cleanup — same guard applies)
    // - lead_status_config WHERE LOWER(key) LIKE 'privtest_cah_%'
    //   (covers PRIVTEST_CAH_DEFTYPE)
  }

  // ── summary & report ──────────────────────────────────────────────────────
  const pass = findings.filter(f => f.ok).length;
  const fail = findings.filter(f => !f.ok && !f.skipped).length;
  const skipped = findings.filter(f => f.skipped).length;
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
    '- **(API pre-checks)**: verify `GET /api/admin/card-action-handlers` and',
    '  `GET /api/card-action-handlers` respond before any browser tab opens.',
    '- **(PRIV) Member-privilege probes** — 3 pure-REST probes that confirm a',
    '  regular approved member is blocked (403) from mutating admin routes:',
    '  - PRIV-01: member POST `/api/admin/card-action-handlers` → 403.',
    '  - PRIV-02: member PATCH `/api/admin/card-action-handlers/:id` → 403.',
    '  - PRIV-03: member DELETE `/api/admin/card-action-handlers/:id` → 403.',
    '- **(NEG) Negative-path validation probes** — 28 pure-REST probes that',
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
    '  - NEG-19: POST with non-snake_case `config.action_name` (spaces + punctuation).',
    '  - NEG-20: happy-path companion — valid snake_case `config.action_name` accepted (201).',
    '  - NEG-21: POST with a well-formed but unknown `status_key` → 400.',
    '  - NEG-22: PATCH with a well-formed but unknown `status_key` → 400.',
    '  - NEG-23: POST with a known existing `status_key` → 201 (over-rejection guard).',
    '  - NEG-24: PATCH with a known existing `status_key` → 200 (over-rejection guard).',
    '  - NEG-25: POST with `stage_key=__global__` and empty `status_key` → 201 (accepted).',
    '  - NEG-26: POST with `stage_key=__global__` and non-empty `status_key` → 400.',
    '  - NEG-27: PATCH with `stage_key=__global__` and empty `status_key` → 200 (accepted).',
    '  - NEG-28: PATCH with `stage_key=__global__` and non-empty `status_key` → 400.',
    '  Both handler types (`add_design_visit_to_calendar`, `summarise_phone_call`)',
    '  and both binding shapes (label and substatus) are exercised.',
    '- **(A) BroadcastChannel cross-tab refresh**: a second same-browser tab',
    '  posts `card_action_handlers_changed`; the Sales-tab listener re-fetches',
    '  and its `cardActionHandlerFor()` lookup resolves the newly-created',
    '  handler.  Also confirms the lookup starts empty (no stale state).',
    '- **(B) Click → modal → backend route**: an injected `.eq-card-action`',
    '  element bound to each handler type is clicked.  The design-visit',
    '  handler must open a DateTimePicker and submit to `/api/visits`',
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
    '- **(G) DV catalogue arrow-reordering** (task #669): for each of the',
    '  three catalogues (handles, furniture ranges, door styles) the harness',
    '  seeds 3 rows with `sort_order` 10/20/30, opens a fresh admin tab on',
    '  the Design visit panel, and asserts:',
    '  - The first row\'s ▲ button and the last row\'s ▼ button render with',
    '    the `disabled` attribute; the middle row\'s ▲/▼ are enabled.',
    '  - Clicking ▲ on the last row sends exactly two PATCH calls to',
    '    `/api/admin/design-visit-<type>/:id` that swap the `sort_order`',
    '    values of the moved and previous rows.',
    '  - The list re-renders in the new order without a full page reload',
    '    (verified via a `window.__reorderToken` sentinel set before the',
    '    click and read back afterwards).',
    '  - The per-type `design_visit_<type>_changed` BroadcastChannel fires',
    '    after the swap (a listener installed in the same tab observes the',
    '    self-posted message — `_broadcastDvCatalogueChange()` runs in the',
    '    sender\'s context).',
    '  - A follow-up GET on the catalogue endpoint confirms the swapped',
    '    `sort_order` values were persisted server-side.',
    '- **(H) intermediateLeadStatus PATCH on wizard open** (task #652): a',
    '  `start_design_visit` handler with `config.intermediateLeadStatus` is',
    '  seeded and bound to `(sales, LBL_KEY_ILS)`.  An injected',
    '  `.eq-card-action` strip is clicked; the test asserts (H.1) a PATCH to',
    '  `/api/contacts/:id` was issued with `body.hs_lead_status` equal to the',
    '  configured value, and (H.2) the wizard (`.dv-wizard-backdrop .dv-wizard`)',
    '  still opens even though the PATCH naturally returns 503 in this harness',
    '  (HUBSPOT_TOKEN stripped → `requireHubspotToken` rejects).  This exercises',
    '  the `.catch` / non-ok branch in `public/card-action-handlers.js` 388–395.',
    '- **(I) No-label/no-handler slot is hidden** (task #1734): a lead status',
    '  row (stage=SALES) is seeded in `lead_status_config` together with one',
    '  `lead_substatuses` row whose `action_label` is empty — no stage-action',
    '  label entry and no bound handler.  A fresh admin tab switches to the',
    '  Action Handlers panel; the probe asserts the group for that status is',
    '  ABSENT from `#card-action-handlers-wrap`.  Guards the tightened',
    '  `if (dflt || hasHandler)` guard in `_buildActionSlotGroups()` against',
    '  regression (the old `lsSubs.length > 0` clause was intentionally removed',
    '  by task #1734 so that slots with no label and no handler stay hidden).',
    '- **(J) Bound-but-unlabelled slot shows warning chip** (task #1734): a',
    '  handler is POSTed and bound to the same status (which has no stage-action',
    '  label).  The probe reloads the panel in the same tab and polls until a',
    '  `[data-testid="no-label-warning"]` chip is visible inside the group for',
    '  that status.  Confirms the warning path in `ActionHandlersPage.tsx` fires',
    '  when `slot.hasLabel === false && handler !== null`.  The handler is',
    '  deleted as part of cleanup.',
    '- **(K) Orphan-binding cleanup on lead-status delete** (task #1736):',
    '  pure-API probes that verify the route-level DELETE cleanup added to',
    '  `DELETE /api/admin/lead-statuses/:key`. `lead_status_config.key` is',
    '  stored uppercase (POST route forces `.toUpperCase()`); bindings store',
    '  `status_key` lowercase (`_validateHandlerBinding` forces `.toLowerCase()`).',
    '  The route uses `LOWER($1)` to bridge the gap. A lead status',
    '  (`PRIVTEST_CAH_ORPHAN_LS`) is seeded, a `summarise_phone_call` handler',
    '  is bound to it with `status_key = "privtest_cah_orphan_ls"` (lowercase),',
    '  and then the status is deleted via the admin API.',
    '  - **K.setup** POST creates the handler (201 with numeric id).',
    '  - **K.1** Binding row (lowercase key) exists before the delete.',
    '  - **K.2** `DELETE /api/admin/lead-statuses/PRIVTEST_CAH_ORPHAN_LS`',
    '    returns 200 `{ ok: true }` — the uppercase URL key is accepted.',
    '  - **K.3** Binding row is gone — `LOWER($1)` matched the lowercase',
    '    stored `status_key` despite the uppercase URL argument.',
    '  - **K.4** A stage-default binding (`status_key=\'\'`) for the same',
    '    handler survives an unrelated lead-status delete, confirming the',
    '    `status_key <> \'\'` guard in the cleanup query prevents accidental',
    '    removal of stage-wide default bindings.',
    '- **(L) Sub-status slot rows render for labelled sub-statuses** (task #1731):',
    '  a fresh `lead_status_config` row (stage=SALES) is seeded together with a',
    '  `lead_substatuses` row whose `action_label` is non-empty ("Book measurement")',
    '  and whose `label` is "Confirmed".  A fresh admin tab switches to the Action',
    '  Handlers panel and two assertions run:',
    '  - **L.1** `.adm-handlers-slot-label` text equals the `action_label` value',
    '    inside the group for that status.',
    '  - **L.2** `.adm-handlers-slot-sub` text contains "Sub-status" and the',
    '    sub-status label, confirming the "Sub-status · <label>" rowLabel pattern.',
    '  Guards `ActionHandlersPage.tsx` lines 232-239 against a regression that',
    '  hides or skips sub-status slot rows.',
    '- **(M) Blank-action_label sub-status produces no slot row** (task #1742):',
    '  slot-level negative guard complementing probe (I).  Uses the same',
    '  `LBL_KEY_FALLBACK_STATUS` fixture (no stage-action label, one',
    '  `lead_substatuses` row with `action_label = \'\'`, no bound handler).',
    '  The probe runs on the same `fallbackTab` immediately after the probe (I)',
    '  group-absent check, querying `#card-action-handlers-wrap` directly for',
    '  any `.adm-handlers-slot-label` elements inside the group for that status.',
    '  Passes when the result is `"group-absent"` (the group does not appear at',
    '  all) or `"no-slots"` (the group exists but contains zero slot-label rows).',
    '  Guards the `if (!action) continue` guard in `ActionHandlersPage.tsx`',
    '  line 243 against a regression that would accidentally render a slot row',
    '  for a sub-status whose `action_label` is blank.',
    '- **(N) Bound-handler warning on label clear** (task #1741): guards the',
    '  `saveAllCardActionLabels` confirmation-dialog path in `CardActionsPage.tsx`',
    '  that blocks silent handler orphaning when a label input is cleared while a',
    '  handler is still bound to the slot.  A fresh `lead_status_config` row',
    '  (stage=SALES) is seeded, its stage-action label is set via',
    '  `PUT /api/admin/stage-action-labels`, and a `summarise_phone_call` handler',
    '  is bound to the slot.  The Card actions panel is opened in a fresh admin',
    '  tab; the input is cleared via the native `HTMLInputElement.value` setter',
    '  and `saveAllCardActionLabels()` is called.',
    '  - **N.setup** Fixtures created: lead status, stage-action label (200), and',
    '    bound handler (201). The `ca-default-input[data-status=…]` is found with',
    '    `data-original` equal to the seeded label text.',
    '  - **N.dialog-appears** The confirmation MuiDialog appears with',
    '    `DialogTitle` = "Handler still bound to this label".',
    '  - **N.cancel** Clicking Cancel closes the dialog without firing a PUT to',
    '    `/api/admin/stage-action-labels`.',
    '  - **N.clear** Calling save a second time and clicking "Clear label anyway"',
    '    fires ≥1 PUT to `/api/admin/stage-action-labels`, confirming the save',
    '    proceeds after confirmation.',
    '- **(O) Sub-status delete bound-handler warning** (task #1740): a',
    '  `lead_status_config` row (stage=SALES) is seeded together with two',
    '  `lead_substatuses` rows — one with a `card_action_handler_bindings` row',
    '  pointing at it via `substatus_id` (bound), and one with no binding (free).',
    '  A fresh admin tab switches to the Card Actions panel.  Six assertions run:',
    '  - **O.setup** POST creates the handler with a substatus_id binding (201).',
    '  - **O.1** Clicking `.adm-ca-sub-delete` on the bound row opens a',
    '    `[data-testid="substatus-delete-dialog"]` whose text includes "Handler still bound to this',
    '    sub-status" — the confirmation dialog from `deleteCardActionSubstatus`.',
    '  - **O.2** Clicking "Cancel" closes the dialog; the',
    '    `[data-sub-id]` row is still present in the DOM (delete was aborted).',
    '  - **O.3** Clicking delete again and then "Delete anyway" removes the row',
    '    from the DOM.',
    '  - **O.4** The `lead_substatuses` DB row count for the deleted id is 0.',
    '  - **O.5** Clicking `.adm-ca-sub-delete` on the unbound sub-status opens',
    '    no `[data-testid="substatus-delete-dialog"]` — the row is deleted silently.',
    '  - **O.6** The unbound `[data-sub-id]` row is gone from the DOM.',
    '  Guards the `deleteCardActionSubstatus` callback in `CardActionsPage.tsx`',
    '  against regressions that skip the `confirmDeleteSub` dialog or fail to',
    '  delete when the user confirms.',
    '- **(P) Stale lead-status warning in the handler editor** (task #1761): a',
    '  `start_design_visit` handler is seeded whose `config.intermediateLeadStatus`',
    '  references a key that does not exist in `lead_status_config` (making it',
    '  "stale").  The handler is bound to a labelled slot so the group appears in',
    '  the Action Handlers panel.  Four assertions run:',
    '  - **P.setup** POST creates the handler (201) with the stale',
    '    `intermediateLeadStatus` preserved in the response.',
    '  - **P.1** After loading the Action Handlers panel, `HandlerSummary` renders',
    '    a `[data-testid="stale-status-warning"]` Chip ("Status deleted") next to',
    '    the in-progress status row.',
    '  - **P.2** Clicking the "Change" button opens the `HandlerEditorModal`; a',
    '    `.MuiAlert-root` containing "no longer exists" is visible inside the dialog.',
    '  - **P.3** The Save/Add button inside the dialog has the `disabled` attribute',
    '    while `hasStaleLsRefs` is true (`intermediateLeadStatusInvalid` set by the',
    '    editor because the stored key is absent from the live status list).',
    '  - **P.4** After clicking the error-state Select and picking a valid',
    '    lead-status option from the MUI listbox portal, Save/Add transitions',
    '    from disabled to enabled (verifying the gate clears on resolution).',
    '  A companion **P.sub** sub-probe repeats the chip → editor → disabled →',
    '  enabled flow for a stale `config.submittedLeadStatus` (a key absent from',
    '  both `lead_status_config` and `lead_substatuses`), covering the',
    '  `submittedLeadStatusInvalid` flag independently from the intermediate path.',
    '  Guards the `intermediateLeadStatusInvalid` / `submittedLeadStatusInvalid`',
    '  props and the `hasStaleLsRefs` Save-button gate in `ActionHandlersPage.tsx`.',
    '- **(R) Handler-bound indicator on Default handler type selector**: a',
    '  `lead_status_config` row (stage=SALES) is seeded together with two',
    '  `lead_substatuses` rows — one that has a `card_action_handler_bindings`',
    '  row (via `substatus_id`) and one that does not.  A fresh admin tab',
    '  switches to the Card Actions panel and `loadCardActionsAdmin()` is',
    '  called to load the freshly-seeded data.  Two assertions run:',
    '  - **R.setup** POST creates the handler with a `substatus_id` binding (201).',
    '  - **R.1** The MUI Select (`.MuiInputBase-root`) inside the bound',
    '    `[data-sub-id]` row has `getComputedStyle().opacity === "0.5"` —',
    '    confirming the `opacity: hasBinding ? 0.5 : 1` sx prop fires when a',
    '    `HandlerBadge` is present for that substatus.',
    '  - **R.2** The MUI Select inside the unbound `[data-sub-id]` row has',
    '    `getComputedStyle().opacity === "1"` — confirming the indicator is',
    '    absent when there is no binding.',
    '  Guards the `hasBinding` branch in `CardActionsPage.tsx` against a',
    '  refactor that silently removes the dimming logic.',
    '- **(Q) Startup seeding — `ensureSubstatusHandlerBindings`** (task #1818):',
    '  pure-API + DB probe (no browser) that verifies the startup routine in',
    '  `photo-reviews.js` correctly auto-binds and correctly skips on restart.',
    '  Three `lead_substatuses` rows are seeded while the original server is running:',
    '  one with no existing binding (qSub1), one with a pre-existing',
    '  `summarise_phone_call` binding (qSub2), and one whose `substatus_key` is',
    '  present in `SUBSTATUS_HANDLER_MAP` (qSub3, key `AWPH_RECEIVED`).  The',
    '  server is then killed and a fresh instance is spawned so',
    '  `ensureSubstatusHandlerBindings` runs again.',
    '  - **Q.1** After the restart, `card_action_handler_bindings` contains a row',
    '    for qSub1 whose handler type is `show_message` — the `FALLBACK_HANDLER`',
    '    chosen because `SUB_STARTUP_UNBOUND_K` (`PRIVTEST_Q_UNBOUND`) is absent',
    '    from `SUBSTATUS_HANDLER_MAP`.  The binding is polled (not just',
    '    `waitForServer`) because `ensureSubstatusHandlerBindings` runs async',
    '    inside `app.listen()` after HTTP starts accepting connections.',
    '  - **Q.2** qSub2\'s binding still references the same `handler_id` it had',
    '    before the restart.  `ensureSubstatusHandlerBindings` skips any substatus',
    '    that already has a binding (`boundIds` set), so admin-configured',
    '    overrides survive a server restart without being replaced.',
    '  - **Q.3** qSub3 receives a new binding whose handler type is',
    '    `review_customer_photos` — the value from `SUBSTATUS_HANDLER_MAP` for',
    '    the `AWPH_RECEIVED` key — not the `show_message` fallback.  Covers the',
    '    map-lookup branch of `ensureSubstatusHandlerBindings` that was previously',
    '    untested.',
    '- **(R) `default_handler_type` column** (task #1825): pure-API + DB probe',
    '  (no browser) that verifies the admin-configured `default_handler_type`',
    '  column on `lead_substatuses` is correctly consumed by',
    '  `ensureSubstatusHandlerBindings` at startup.  Two `lead_substatuses` rows',
    '  are inserted directly into the DB (no server running) under a dedicated',
    '  `PRIVTEST_CAH_DEFTYPE` status key; then a fresh server is spawned.',
    '  - **R.1** The row with `default_handler_type = \'start_design_visit\'` and',
    '    no prior binding receives a `card_action_handler_bindings` row whose',
    '    joined handler type is `start_design_visit`.  Confirms that the column',
    '    value is read and used directly, bypassing both `SUBSTATUS_HANDLER_MAP`',
    '    and `FALLBACK_HANDLER`.',
    '  - **R.2** The row with `default_handler_type = NULL` and',
    '    `substatus_key = \'AWPH_RECEIVED\'` (present in `SUBSTATUS_HANDLER_MAP`)',
    '    receives a binding with handler type `review_customer_photos`,',
    '    confirming that the `SUBSTATUS_HANDLER_MAP` lookup is not bypassed',
    '    when `default_handler_type` is empty.',
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
