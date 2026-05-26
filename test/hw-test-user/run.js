'use strict';
// test/hw-test-user/run.js
//
// Smoke test for the hw-test-user dev-mode endpoint.
//
// NOTE: the dev-filter toggle and PATCH /api/admin/hubspot/test-users/:id
// routes were removed in task #1293. This file now only covers the two
// endpoints that remain:
//   PRE       /api/admin/test/seed-contacts-cache is reachable in dev
//   DEV-MODE  /api/admin/hubspot/dev-mode is admin-only, returns devMode=true
//   PROD      seed-contacts-cache returns 404 in prod; dev-mode returns false
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

const { startMockHubspot, stopMockHubspot } = require('./mock-hubspot');

require('dotenv').config();

const MOCK_HS_PORT = TEST_PORT + 2;
const PROD_PORT    = TEST_PORT + 1;
const MOCK_HS_URL  = `http://127.0.0.1:${MOCK_HS_PORT}`;
const PROD_BASE    = `http://127.0.0.1:${PROD_PORT}`;

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
  };
}

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
  console.log(`\n  hw-test-user smoke  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const mockHsServer = await startMockHubspot(MOCK_HS_PORT);
  console.log(`  Mock HubSpot at ${MOCK_HS_URL}`);

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
    try { if (!devExited)              child.kill('SIGTERM'); } catch {}
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
    {
      const r = await prodClientAdmin.post('/api/admin/test/seed-contacts-cache', {
        contacts: [],
      });
      record(
        'PROD-01: POST /api/admin/test/seed-contacts-cache returns 404 in production',
        'status=404',
        `status=${r.status}`,
        r.status === 404,
      );
    }

    {
      const r = await prodClientAdmin.get('/api/admin/hubspot/dev-mode');
      record(
        'PROD-02: GET /api/admin/hubspot/dev-mode returns devMode=false in production',
        'status=200 devMode=false',
        `status=${r.status} devMode=${r.json?.devMode}`,
        r.status === 200 && r.json?.devMode === false,
      );
    }
  } else {
    for (const name of ['PROD-01', 'PROD-02']) {
      record(
        `${name}: production-mode probe (skipped — server did not start)`,
        'prod server available',
        'skipped',
        false,
        'Investigate why the production test server failed to start',
      );
    }
  }

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
