'use strict';
// test/hw-test-user/run.js
//
// End-to-end test suite for the hw_test_user dev filter and toggle endpoint.
// Mirrors the pattern in test/card-action-handlers/run.js.
//
// A lightweight mock HubSpot server (mock-hubspot.js) is started on a side
// port before the test server boots.  The test server is pointed at the mock
// via HUBSPOT_API_URL + HUBSPOT_ACCESS_TOKEN so that all three listing
// endpoints can be exercised without a real HubSpot account.
//
// Probes covered:
//   PRE       API pre-checks (seed endpoint, dev-mode flag)
//   DEV-MODE  /api/admin/hubspot/dev-mode is admin-only
//   FILTER    dev-filter hides non-flagged contacts from /api/contacts-all,
//             /api/open-leads, and /api/contacts-lead-status-counts
//   PRIV      PATCH /api/admin/hubspot/test-users/:id is admin-only
//   NEG       Input-validation probes on the PATCH endpoint
//   PROD      Second server with NODE_ENV=production — PATCH returns 404,
//             seed-contacts-cache returns 404, dev-mode returns false
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:hw-test-user
//   PRIVTEST_ALLOW_SHARED_DB=1      npm run test:hw-test-user

const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Pool } = require('pg');

const {
  waitForServer,
  seedUsers,
  cleanupTestData,
  resetRateLimitStore,
  login,
  setPool,
  PASSWORD,
  BASE,
  TEST_PORT,
} = require('../privileges/harness');

const { startMockHubspot, stopMockHubspot, MOCK_CONTACTS } = require('./mock-hubspot');

require('dotenv').config();

// ── ports ──────────────────────────────────────────────────────────────────────
const MOCK_HS_PORT = TEST_PORT + 2;   // e.g. 5052 — mock HubSpot
const PROD_PORT    = TEST_PORT + 1;   // e.g. 5051 — production server
const MOCK_HS_URL  = `http://127.0.0.1:${MOCK_HS_PORT}`;
const PROD_BASE    = `http://127.0.0.1:${PROD_PORT}`;

// ── spawn dev server (with mock HubSpot) ──────────────────────────────────────
function spawnDevServer(connStr) {
  const env = {
    ...process.env,
    DATABASE_URL:        connStr,
    PORT:                String(TEST_PORT),
    NODE_ENV:            'development',
    HUBSPOT_API_URL:     MOCK_HS_URL,
    HUBSPOT_ACCESS_TOKEN: 'test-mock-token',
    HUBSPOT_TOKEN:        'test-mock-token',
    TURNSTILE_SECRET_KEY: '',
    TURNSTILE_SITE_KEY:   '',
    SMTP_HOST: '', SMTP_PORT: '', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '',
    GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
    QB_CLIENT_ID: '', QB_CLIENT_SECRET: '',
    APP_URL:  BASE,
    ADMIN_EMAILS: '',
  };
  const child = spawn('node', ['server.js'], {
    cwd: path.resolve(__dirname, '..', '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logBuf = [];
  child.stdout.on('data', d => logBuf.push(d.toString()));
  child.stderr.on('data', d => logBuf.push(d.toString()));
  return { child, logBuf };
}

// ── spawn production server ────────────────────────────────────────────────────
function spawnProdServer(connStr) {
  const env = {
    ...process.env,
    DATABASE_URL:         connStr,
    PORT:                 String(PROD_PORT),
    NODE_ENV:             'production',
    HUBSPOT_API_URL:      MOCK_HS_URL,
    HUBSPOT_ACCESS_TOKEN: 'test-mock-token',
    HUBSPOT_TOKEN:        'test-mock-token',
    TURNSTILE_SECRET_KEY: '',
    TURNSTILE_SITE_KEY:   '',
    SMTP_HOST: '', SMTP_PORT: '', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '',
    GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
    QB_CLIENT_ID: '', QB_CLIENT_SECRET: '',
    APP_URL:  PROD_BASE,
    ADMIN_EMAILS: '',
  };
  const child = spawn('node', ['server.js'], {
    cwd: path.resolve(__dirname, '..', '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logBuf = [];
  child.stdout.on('data', d => logBuf.push(d.toString()));
  child.stderr.on('data', d => logBuf.push(d.toString()));
  return { child, logBuf };
}

async function waitForProdServer(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${PROD_BASE}/api/turnstile-config`);
      if (r.status < 500) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Production test server did not start on ${PROD_BASE} within ${timeoutMs}ms`);
}

// ── prod client: scoped to PROD_BASE ─────────────────────────────────────────
function makeProdClient(initialCookie = null) {
  let jar = initialCookie;
  async function req(method, urlPath, { body } = {}) {
    const h = { 'Accept': 'application/json' };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (jar) h['Cookie'] = jar;
    const res = await fetch(`${PROD_BASE}${urlPath}`, {
      method, headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    const sc = res.headers.get('set-cookie');
    if (sc) {
      const first = sc.split(',').find(p => p.trim().startsWith('connect.sid=')) || sc;
      const kv = first.split(';')[0].trim();
      if (kv.startsWith('connect.sid=')) jar = kv;
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, json };
  }
  return {
    get:   (p)       => req('GET',   p),
    post:  (p, body) => req('POST',  p, { body }),
    patch: (p, body) => req('PATCH', p, { body }),
  };
}

// Inject a session for `email` directly into the DB and return a prod client.
// Both dev and prod servers share the same SESSION_SECRET + database, so the
// injected session is valid on either server.
async function loginProd(pool, email) {
  const crypto = require('crypto');
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is required for loginProd');
  const TTL = 7 * 24 * 60 * 60;
  const r = await pool.query(
    `SELECT id, email, first_name, last_name, profile_image_url,
            privilege_level, onboarding_status
     FROM users WHERE LOWER(email) = LOWER($1)`,
    [email],
  );
  if (!r.rows[0]) throw new Error(`loginProd: user not found — ${email}`);
  const u = r.rows[0];
  const sessionUser = {
    claims: {
      sub: u.id, email: u.email,
      first_name: u.first_name || null,
      last_name:  u.last_name  || null,
      profile_image_url: u.profile_image_url || null,
    },
    privilege_level:   u.privilege_level   || 'member',
    onboarding_status: u.onboarding_status || 'active',
    expires_at: Math.floor(Date.now() / 1000) + TTL,
  };
  const sid    = crypto.randomUUID();
  const expire = new Date(Date.now() + TTL * 1000);
  const sess   = JSON.stringify({
    cookie: {
      originalMaxAge: TTL * 1000, expires: expire.toISOString(),
      secure: false, httpOnly: true, path: '/', sameSite: 'lax',
    },
    passport: { user: sessionUser },
  });
  await pool.query(
    `INSERT INTO sessions (sid, sess, expire) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
    [sid, sess, expire],
  );
  const sig = crypto.createHmac('sha256', secret)
    .update(sid).digest('base64').replace(/=+$/, '');
  const cookie = `connect.sid=${encodeURIComponent('s:' + sid + '.' + sig)}`;
  return makeProdClient(cookie);
}

// ── mock-contact helpers ───────────────────────────────────────────────────────
// IDs of the flagged and non-flagged contacts served by the mock.
const FLAGGED_IDS   = MOCK_CONTACTS.filter(c => c.properties.hw_test_user === 'true').map(c => c.id);
const UNFLAGGED_IDS = MOCK_CONTACTS.filter(c => c.properties.hw_test_user !== 'true').map(c => c.id);
const OPEN_DEAL_FLAGGED_IDS   = MOCK_CONTACTS
  .filter(c => c.properties.hw_test_user === 'true' && c.properties.hs_lead_status === 'OPEN_DEAL')
  .map(c => c.id);
const OPEN_DEAL_UNFLAGGED_IDS = MOCK_CONTACTS
  .filter(c => c.properties.hw_test_user !== 'true' && c.properties.hs_lead_status === 'OPEN_DEAL')
  .map(c => c.id);

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
  console.log(`\n  hw-test-user E2E  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  // ── start mock HubSpot ────────────────────────────────────────────────────
  const mockHsServer = await startMockHubspot(MOCK_HS_PORT);
  console.log(`  Mock HubSpot at ${MOCK_HS_URL}  (${MOCK_CONTACTS.length} contacts)`);
  console.log(`    flagged   : ${FLAGGED_IDS.join(', ')}`);
  console.log(`    unflagged : ${UNFLAGGED_IDS.join(', ')}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);
  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  admin=${users.admin.email}`);

  const { child, logBuf } = spawnDevServer(connStr);
  let devExited  = false;
  child.on('exit', () => { devExited = true; });

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

  let prodChild  = null;
  let prodExited = false;
  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (!devExited)          child.kill('SIGTERM'); } catch {}
    try { if (prodChild && !prodExited) prodChild.kill('SIGTERM'); } catch {}
    try { await stopMockHubspot(mockHsServer); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    writeReport(findings);
    process.exit(code);
  };

  process.on('SIGINT',  () => cleanupAndExit(130));
  process.on('SIGTERM', () => cleanupAndExit(130));
  process.on('uncaughtException',  (e) => { console.error('Uncaught:', e);  cleanupAndExit(2); });
  process.on('unhandledRejection', (e) => { console.error('Unhandled:', e); cleanupAndExit(2); });

  // ── boot dev server ────────────────────────────────────────────────────────
  try {
    await waitForServer();
    await resetRateLimitStore(pool);
    console.log(`  Dev server up at ${BASE}`);
  } catch (e) {
    console.error('Dev server boot failed:', e.message);
    console.error(logBuf.join('').slice(-2000));
    await cleanupAndExit(2);
    return;
  }

  // Bust the shared contacts cache so the next request actually fetches from
  // the mock (the server may have fired one HubSpot call during boot for the
  // property-creation check — the cache is populated by an explicit contact
  // search, which only fires on the first /api/contacts-all request).
  // Nothing to do here; the cache starts empty on a fresh server boot.

  // ── login ──────────────────────────────────────────────────────────────────
  const adminClient  = await login(users.admin.email,  PASSWORD);
  const memberClient = await login(users.member.email, PASSWORD);

  // ── [PRE] API pre-checks ───────────────────────────────────────────────────
  console.log('\n  [PRE] API pre-checks');

  {
    const r = await adminClient.post('/api/admin/test/seed-contacts-cache', {
      contacts: [],
    });
    record(
      'PRE-01: POST /api/admin/test/seed-contacts-cache reachable for admin (dev mode)',
      'status=200 ok=true',
      `status=${r.status} ok=${r.json?.ok}`,
      r.status === 200 && r.json?.ok === true,
    );
  }

  {
    const r = await adminClient.get('/api/admin/hubspot/dev-mode');
    record(
      'PRE-02: GET /api/admin/hubspot/dev-mode returns devMode=true in dev',
      'status=200 devMode=true',
      `status=${r.status} devMode=${r.json?.devMode}`,
      r.status === 200 && r.json?.devMode === true,
    );
  }

  // ── [DEV-MODE] admin-only guard ────────────────────────────────────────────
  console.log('\n  [DEV-MODE] Privilege probe for /api/admin/hubspot/dev-mode');

  {
    const r = await memberClient.get('/api/admin/hubspot/dev-mode');
    const blocked = r.status === 403 || r.status === 401 || r.status === 302;
    record(
      'DEV-MODE-01: non-admin GET /api/admin/hubspot/dev-mode is blocked',
      'status=403 (or 401/302)',
      `status=${r.status}`,
      blocked,
    );
  }

  // ── [FILTER-A] /api/contacts-all dev filter ────────────────────────────────
  //
  // The shared contacts cache is populated from the mock HubSpot server the
  // first time /api/contacts-all is called.  In dev mode the server filters
  // the cached list to hw_test_user=true only.
  console.log('\n  [FILTER-A] /api/contacts-all dev-filter');

  // Bust the cache so it re-fetches from the mock on the next request.
  await adminClient.post('/api/admin/test/seed-contacts-cache', { contacts: [] });
  // A zero-length seed makes the cache "expired immediately" — actually the
  // TTL is still set.  Instead, use a special seed to clear and re-populate:
  // re-seed with an intentionally wrong single-contact array so the next real
  // call repopulates from mock.
  // Actually the easiest is to seed with the REAL contacts from the mock — but
  // we want to verify the server fetches from HubSpot, not that our seed works.
  // So: bust the cache by seeding with 0 contacts but a TTL already expired.
  // The simplest approach: call seed-contacts-cache with contacts=[] — this
  // populates the cache with an empty list (valid TTL).  To force a real fetch
  // from the mock we need to clear the cache entirely.  We don't have a
  // "clear cache" endpoint, so instead we DON'T pre-seed: the server starts
  // with an empty cache and the first /api/contacts-all call triggers a real
  // fetch from the mock.
  //
  // NOTE: the pre-check above (PRE-01) seeded the cache with [] — so the
  // cache is currently populated with 0 contacts (TTL=5 min).  We need to
  // bust it.  The only way without adding a new endpoint is to wait for the
  // TTL or seed with the real mock data (since we control both).
  // We seed the correct mock data so the filter assertions are still valid.
  const mockContactsPayload = MOCK_CONTACTS.map(c => ({ ...c }));
  await adminClient.post('/api/admin/test/seed-contacts-cache', {
    contacts: mockContactsPayload,
  });

  const allRes = await adminClient.get('/api/contacts-all');
  record(
    'FILTER-A-01: /api/contacts-all responds 200 in dev (mock HubSpot active)',
    'status=200',
    `status=${allRes.status}`,
    allRes.status === 200,
  );

  if (allRes.status === 200) {
    const results = allRes.json?.results || [];
    const ids = results.map(c => c.id);

    // Every flagged contact must be present.
    for (const id of FLAGGED_IDS) {
      record(
        `FILTER-A-02: flagged contact ${id} is present in /api/contacts-all`,
        `id=${id} in results`,
        `ids=[${ids.join(',')}]`,
        ids.includes(id),
      );
    }

    // Every unflagged contact must be absent.
    for (const id of UNFLAGGED_IDS) {
      record(
        `FILTER-A-03: unflagged contact ${id} is absent from /api/contacts-all`,
        `id=${id} NOT in results`,
        `ids=[${ids.join(',')}]`,
        !ids.includes(id),
      );
    }
  } else {
    for (const label of ['FILTER-A-02', 'FILTER-A-03']) {
      record(`${label}: skipped (contacts-all returned ${allRes.status})`, 'status=200', `status=${allRes.status}`, false);
    }
  }

  // Admin bypass (?all=1) must show all contacts.
  const bypassRes = await adminClient.get('/api/contacts-all?all=1');
  record(
    'FILTER-A-04: admin ?all=1 bypass responds 200',
    'status=200',
    `status=${bypassRes.status}`,
    bypassRes.status === 200,
  );
  if (bypassRes.status === 200) {
    const bypassIds = (bypassRes.json?.results || []).map(c => c.id);
    for (const id of UNFLAGGED_IDS) {
      record(
        `FILTER-A-05: admin ?all=1 includes unflagged contact ${id}`,
        `id=${id} in bypass results`,
        `ids=[${bypassIds.join(',')}]`,
        bypassIds.includes(id),
      );
    }
  }

  // Member ?all=1 must NOT bypass.
  const memberBypassRes = await memberClient.get('/api/contacts-all?all=1');
  if (memberBypassRes.status === 200) {
    const mbIds = (memberBypassRes.json?.results || []).map(c => c.id);
    for (const id of UNFLAGGED_IDS) {
      record(
        `FILTER-A-06: member ?all=1 bypass is ignored — unflagged ${id} still absent`,
        `id=${id} NOT in member results`,
        `ids=[${mbIds.join(',')}]`,
        !mbIds.includes(id),
      );
    }
  }

  // ── [FILTER-B] /api/open-leads dev filter ─────────────────────────────────
  //
  // /api/open-leads sends its HubSpot search with an additional
  // hw_test_user=true filter in dev mode.  The mock evaluates real filter
  // groups so only flagged contacts with hs_lead_status=OPEN_DEAL are returned.
  console.log('\n  [FILTER-B] /api/open-leads dev-filter');

  const openLeadsRes = await adminClient.get('/api/open-leads');
  record(
    'FILTER-B-01: /api/open-leads responds 200 in dev (mock HubSpot active)',
    'status=200',
    `status=${openLeadsRes.status}`,
    openLeadsRes.status === 200,
  );

  if (openLeadsRes.status === 200) {
    const olIds = (openLeadsRes.json?.results || []).map(c => c.id);

    for (const id of OPEN_DEAL_FLAGGED_IDS) {
      record(
        `FILTER-B-02: flagged OPEN_DEAL contact ${id} present in /api/open-leads`,
        `id=${id} in results`,
        `ids=[${olIds.join(',')}]`,
        olIds.includes(id),
      );
    }
    for (const id of OPEN_DEAL_UNFLAGGED_IDS) {
      record(
        `FILTER-B-03: unflagged OPEN_DEAL contact ${id} absent from /api/open-leads`,
        `id=${id} NOT in results`,
        `ids=[${olIds.join(',')}]`,
        !olIds.includes(id),
      );
    }
  } else {
    record('FILTER-B-02: skipped (open-leads returned non-200)', 'status=200', `status=${openLeadsRes.status}`, false);
  }

  // ── [FILTER-C] /api/contacts-lead-status-counts dev filter ─────────────────
  //
  // This endpoint calls HubSpot search for each lead-status key and counts
  // matching contacts, applying hw_test_user=true as an extra filter in dev
  // mode.  The mock has two contacts with hs_lead_status=OPEN_DEAL:
  //   mock-1  hw_test_user=true   → counted in dev
  //   mock-2  hw_test_user=false  → excluded in dev (would be included without filter)
  //
  // We seed lead_status_config with key='OPEN_DEAL' before the first call so
  // the endpoint includes that key in its searches.  In dev mode the count
  // must be 1, not 2.  If the hw_test_user filter were removed the count
  // would be 2, causing these probes to fail.
  //
  // A second key (privtest-unique) has no matching mock contacts; its count
  // must be 0 regardless — this rules out accidents from stale cache.
  console.log('\n  [FILTER-C] /api/contacts-lead-status-counts dev-filter');

  const LSC_KEY_OPEN = 'OPEN_DEAL';          // 2 mock contacts (1 flagged, 1 unflagged)
  const LSC_KEY_NONE = `privtest_hwtu_lsc_${runId}`; // 0 mock contacts

  // Track whether we inserted OPEN_DEAL (so we can clean it up only if we
  // added it, leaving real data intact).
  const openDealInserted = await pool.query(
    `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales, stage)
     VALUES ($1, 'Mock Open Deal (hw-test-user E2E)', 9996, false, 'SALES')
     ON CONFLICT (key) DO NOTHING`,
    [LSC_KEY_OPEN],
  );
  await pool.query(
    `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales, stage)
     VALUES ($1, 'HW Test LSC', 9997, false, 'SALES')
     ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label`,
    [LSC_KEY_NONE],
  );

  // The lead-status-counts endpoint has a 120 s in-process cache.  No prior
  // call in this test run has hit it, so the first request populates the
  // cache with both seeded keys included.
  const countsRes = await adminClient.get('/api/contacts-lead-status-counts');
  record(
    'FILTER-C-01: /api/contacts-lead-status-counts responds 200 in dev',
    'status=200',
    `status=${countsRes.status}`,
    countsRes.status === 200,
  );

  if (countsRes.status === 200) {
    const counts = countsRes.json || {};

    // ── FILTER-SENSITIVE assertion ──────────────────────────────────────────
    // In dev mode the endpoint applies the hw_test_user=true filter to every
    // HubSpot search.  OPEN_DEAL has 1 flagged (mock-1) + 1 unflagged (mock-2).
    // Expected in dev mode:  1
    // If filter were absent: 2  ← the probe would fail, catching regressions.
    const openDealCount = counts[LSC_KEY_OPEN];
    record(
      'FILTER-C-02: OPEN_DEAL count=1 in dev mode (only flagged mock-1 counted, not unflagged mock-2)',
      `counts[${LSC_KEY_OPEN}] === 1`,
      `counts[${LSC_KEY_OPEN}]=${openDealCount}`,
      openDealCount === 1,
    );

    // Sanity: no mock contact has the unique-key status; must always be 0.
    const noneCount = counts[LSC_KEY_NONE];
    record(
      `FILTER-C-03: count for unique key ${LSC_KEY_NONE} is 0`,
      `counts[${LSC_KEY_NONE}] === 0`,
      `counts[${LSC_KEY_NONE}]=${noneCount}`,
      noneCount === 0,
    );
  } else {
    record('FILTER-C-02: skipped (counts returned non-200)', 'status=200', `status=${countsRes.status}`, false);
    record('FILTER-C-03: skipped (counts returned non-200)', 'status=200', `status=${countsRes.status}`, false);
  }

  // Cleanup seeded lead_status_config rows.
  if (openDealInserted.rowCount > 0) {
    await pool.query(`DELETE FROM lead_status_config WHERE key = $1`, [LSC_KEY_OPEN]).catch(() => {});
  }
  await pool.query(`DELETE FROM lead_status_config WHERE key = $1`, [LSC_KEY_NONE]).catch(() => {});

  // ── [PRIV] Privilege probes for PATCH /api/admin/hubspot/test-users/:id ───
  console.log('\n  [PRIV] Privilege probes for PATCH /api/admin/hubspot/test-users/:contactId');

  // PRIV-01: non-admin authenticated user is blocked.
  {
    const r = await memberClient.patch('/api/admin/hubspot/test-users/12345', {
      enabled: true,
    });
    const blocked = r.status === 403 || r.status === 401 || r.status === 302;
    record(
      'PRIV-01: member PATCH /api/admin/hubspot/test-users/:id blocked',
      'status=403 (or 401/302)',
      `status=${r.status}`,
      blocked,
    );
  }

  // PRIV-02: unauthenticated request is blocked.
  {
    const { makeClient } = require('../privileges/harness');
    const anonClient = makeClient(null);
    const r = await anonClient.patch('/api/admin/hubspot/test-users/12345', {
      enabled: true,
    });
    const blocked = r.status === 403 || r.status === 401 || r.status === 302;
    record(
      'PRIV-02: unauthenticated PATCH /api/admin/hubspot/test-users/:id blocked',
      'status=401/403/302',
      `status=${r.status}`,
      blocked,
    );
  }

  // ── [NEG] Input validation on PATCH ───────────────────────────────────────
  // With the mock token set, requireHubspotToken passes, so the handler body
  // runs and validation errors are returned as 400.
  console.log('\n  [NEG] Input validation probes for PATCH /api/admin/hubspot/test-users/:contactId');

  // NEG-01: non-numeric contactId.
  {
    const r = await adminClient.patch('/api/admin/hubspot/test-users/not-a-number', {
      enabled: true,
    });
    record(
      'NEG-01: PATCH with non-numeric contactId returns 400',
      'status=400',
      `status=${r.status} error=${JSON.stringify(r.json?.error)}`,
      r.status === 400,
    );
  }

  // NEG-02: enabled missing.
  {
    const r = await adminClient.patch('/api/admin/hubspot/test-users/12345', {});
    record(
      'NEG-02: PATCH with missing `enabled` returns 400',
      'status=400',
      `status=${r.status} error=${JSON.stringify(r.json?.error)}`,
      r.status === 400,
    );
  }

  // NEG-03: enabled is a string.
  {
    const r = await adminClient.patch('/api/admin/hubspot/test-users/12345', {
      enabled: 'yes',
    });
    record(
      'NEG-03: PATCH with string `enabled` returns 400',
      'status=400',
      `status=${r.status} error=${JSON.stringify(r.json?.error)}`,
      r.status === 400,
    );
  }

  // ── [PROD] Production-mode probes (second server) ─────────────────────────
  console.log('\n  [PROD] Production-mode probes (second server at port ' + PROD_PORT + ')');

  let prodClientAdmin = null;
  try {
    const prodSpawn = spawnProdServer(connStr);
    prodChild = prodSpawn.child;
    prodChild.on('exit', () => { prodExited = true; });
    await waitForProdServer();
    console.log(`  Production server up at ${PROD_BASE}`);
    prodClientAdmin = await loginProd(pool, users.admin.email);
    console.log(`  [PROD] Session injected for ${users.admin.email}`);
  } catch (e) {
    console.warn(`  [PROD] production server failed to start: ${e.message} — skipping prod probes`);
  }

  if (prodClientAdmin) {
    // PROD-01: PATCH returns 404 in production.
    {
      const r = await prodClientAdmin.patch('/api/admin/hubspot/test-users/12345', {
        enabled: true,
      });
      record(
        'PROD-01: PATCH /api/admin/hubspot/test-users/:id returns 404 in production',
        'status=404',
        `status=${r.status}`,
        r.status === 404,
      );
    }

    // PROD-02: seed-contacts-cache endpoint returns 404 in production.
    {
      const r = await prodClientAdmin.post('/api/admin/test/seed-contacts-cache', {
        contacts: [],
      });
      record(
        'PROD-02: POST /api/admin/test/seed-contacts-cache returns 404 in production',
        'status=404',
        `status=${r.status}`,
        r.status === 404,
      );
    }

    // PROD-03: dev-mode flag returns devMode=false in production.
    {
      const r = await prodClientAdmin.get('/api/admin/hubspot/dev-mode');
      record(
        'PROD-03: GET /api/admin/hubspot/dev-mode returns devMode=false in production',
        'status=200 devMode=false',
        `status=${r.status} devMode=${r.json?.devMode}`,
        r.status === 200 && r.json?.devMode === false,
      );
    }
  } else {
    for (const name of ['PROD-01', 'PROD-02', 'PROD-03']) {
      record(
        `${name}: production-mode probe (skipped — server did not start)`,
        'prod server available',
        'skipped',
        false,
        'Investigate why the production test server failed to start',
      );
    }
  }

  // ── tear down and report ───────────────────────────────────────────────────
  const failed = findings.filter(f => !f.ok).length;
  console.log(`\n  ${findings.length} probes  ${failed} failed`);
  if (failed > 0) {
    console.log('\n  Failed probes:');
    for (const f of findings.filter(f => !f.ok)) {
      console.log(`    ✗  ${f.name}`);
      console.log(`       expected : ${f.expected}`);
      console.log(`       observed : ${f.observed}`);
      if (f.detail) console.log(`       detail   : ${f.detail}`);
    }
  }

  await cleanupAndExit(failed > 0 ? 1 : 0);
}

// ── report ─────────────────────────────────────────────────────────────────────
function writeReport(findings) {
  const outDir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'hw-test-user.md');
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok).length;
  const lines = [
    '# hw-test-user test results',
    '',
    `**${findings.length} probes — ${passed} passed — ${failed} failed**`,
    '',
    '| Result | Probe | Expected | Observed |',
    '|--------|-------|----------|----------|',
    ...findings.map(f =>
      `| ${f.ok ? '✓' : '✗'} | ${f.name} | ${f.expected} | ${f.observed} |`
    ),
  ];
  if (failed > 0) {
    lines.push('', '## Failed probes', '');
    for (const f of findings.filter(f => !f.ok)) {
      lines.push(`### ${f.name}`, `- **Expected:** ${f.expected}`, `- **Observed:** ${f.observed}`);
      if (f.detail) lines.push(`- **Detail:** ${f.detail}`);
      lines.push('');
    }
  }
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`\n  Report written to ${outPath}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(2); });
