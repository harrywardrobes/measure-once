const { spawn } = require('child_process');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

const TEST_PORT = parseInt(process.env.PRIV_TEST_PORT || '5050', 10);
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const PREFIX = 'privtest-';
const PASSWORD = 'Tr0ub4dor&3-VeryUnique-Pw!';

// Module-level pool reference (kept for callers that pass it in).
let _pool = null;
function setPool(pool) { _pool = pool; }

const ROLES = ['viewer', 'member', 'manager', 'admin'];

function makeEmail(role, runId) {
  return `${PREFIX}${role}-${runId}@privtest.local`;
}

async function resetRateLimitStore(pool) {
  // The @acpr/rate-limit-postgresql package uses a `rate_limit` schema; wipe
  // the per-IP buckets so a repeated run doesn't blow through the 20-login/
  // 15-min loginLimiter cap (the harness logs in many times: seed + probes).
  try {
    await pool.query(`TRUNCATE rate_limit.individual_records,
                              rate_limit.records_aggregated,
                              rate_limit.sessions`);
  } catch { /* schema may not exist yet on a brand-new DB */ }
}

async function cleanupTestData(pool) {
  // Everything synthetic uses the privtest- prefix (seed users, lifecycle
  // accounts, xss probe access-requests).
  // Each statement is wrapped in try/catch so that missing tables on a
  // fresh isolated DB (before the server has booted and run schema migrations)
  // are silently ignored — matching the pattern used in resetRateLimitStore.
  try {
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${PREFIX}%`]);
  } catch { /* table may not exist yet on a brand-new DB */ }
  try {
    await pool.query(`DELETE FROM allowed_emails WHERE email LIKE $1`, [`${PREFIX}%`]);
  } catch { /* table may not exist yet on a brand-new DB */ }
  try {
    await pool.query(`DELETE FROM account_requests WHERE email LIKE $1`, [`${PREFIX}%`]);
  } catch { /* table may not exist yet on a brand-new DB */ }
}

async function seedUsers(pool, runId) {
  const seeded = {};
  for (const role of ROLES) {
    const email = makeEmail(role, runId);
    await pool.query(
      `INSERT INTO allowed_emails (email, note) VALUES ($1, 'privilege test seed')
       ON CONFLICT (email) DO NOTHING`,
      [email]
    );
    const r = await pool.query(
      `INSERT INTO users (email, first_name, last_name,
                          privilege_level, onboarding_status)
       VALUES ($1, $2, 'Test', $3, 'active')
       ON CONFLICT (email) DO UPDATE
         SET privilege_level = EXCLUDED.privilege_level,
             onboarding_status = EXCLUDED.onboarding_status
       RETURNING id`,
      [email, role.charAt(0).toUpperCase() + role.slice(1), role]
    );
    // Identity Platform user is created lazily by /api/test-login on first use.
    seeded[role] = { email, id: r.rows[0].id, password: PASSWORD };
  }
  return seeded;
}

function spawnServer(opts = {}) {
  const { extraEnv = {}, nodeOptions = '' } = opts;
  // External credentials are stripped by default so the harness runs without
  // third-party access. Each can be *opted back in* by exporting it before
  // invoking the suite (e.g. `TURNSTILE_SECRET_KEY=… npm run test:privileges`)
  // — the harness then passes it through verbatim so the relevant gate path
  // (captcha tampering, HubSpot-token authz cells, etc.) is exercised live.
  const optionalPassthrough = (name) =>
    process.env[`PRIVTEST_USE_${name}`] === '1' && process.env[name]
      ? process.env[name]
      : '';
  const env = {
    ...process.env,
    // Allow callers to point the test server at an isolated database
    // (DATABASE_URL_TEST) — when unset, falls back to DATABASE_URL with
    // prefix-based cleanup (`privtest-`) for synthetic rows.
    DATABASE_URL: process.env.DATABASE_URL_TEST || process.env.DATABASE_URL,
    PORT: String(TEST_PORT),
    NODE_ENV: 'development',
    TURNSTILE_SECRET_KEY: optionalPassthrough('TURNSTILE_SECRET_KEY'),
    TURNSTILE_SITE_KEY:   optionalPassthrough('TURNSTILE_SITE_KEY'),
    HUBSPOT_ACCESS_TOKEN: optionalPassthrough('HUBSPOT_ACCESS_TOKEN'),
    HUBSPOT_TOKEN:        optionalPassthrough('HUBSPOT_TOKEN'),
    SMTP_HOST: '', SMTP_PORT: '', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '',
    GOOGLE_CLIENT_ID:     optionalPassthrough('GOOGLE_CLIENT_ID'),
    GOOGLE_CLIENT_SECRET: optionalPassthrough('GOOGLE_CLIENT_SECRET'),
    QB_CLIENT_ID:         optionalPassthrough('QB_CLIENT_ID'),
    QB_CLIENT_SECRET:     optionalPassthrough('QB_CLIENT_SECRET'),
    APP_URL: BASE,
    ADMIN_EMAILS: optionalPassthrough('ADMIN_EMAILS'),
    ...extraEnv,
  };
  if (nodeOptions) {
    env.NODE_OPTIONS = [process.env.NODE_OPTIONS, nodeOptions].filter(Boolean).join(' ');
  }
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

async function waitForServer(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/turnstile-config`);
      if (r.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Test server did not start on ${BASE} within ${timeoutMs}ms`);
}

function parseSetCookie(headerValue) {
  if (!headerValue) return null;
  // Look for the Identity Platform session cookie (__session=...).
  const first = headerValue.split(',').find(p => p.trim().startsWith('__session='))
             || headerValue;
  const kv = first.split(';')[0].trim();
  return kv.startsWith('__session=') ? kv : null;
}

function makeClient(cookie) {
  let jar = cookie || null;
  async function req(method, urlPath, { body, headers = {}, forwardedProto = 'https' } = {}) {
    const h = {
      'Accept': 'application/json',
      'X-Forwarded-Proto': forwardedProto,
      ...headers,
    };
    if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
    if (jar) h['Cookie'] = jar;
    const res = await fetch(`${BASE}${urlPath}`, {
      method,
      headers: h,
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      redirect: 'manual',
    });
    const setCookie = res.headers.get('set-cookie');
    const updated = parseSetCookie(setCookie);
    if (updated) jar = updated;
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, headers: res.headers, text, json, cookie: jar, setCookieRaw: setCookie };
  }
  return {
    req,
    get cookie() { return jar; },
    set cookie(v) { jar = v; },
    get: (p, o) => req('GET', p, o),
    post: (p, body, o = {}) => req('POST', p, { ...o, body }),
    patch: (p, body, o = {}) => req('PATCH', p, { ...o, body }),
    put: (p, body, o = {}) => req('PUT', p, { ...o, body }),
    delete: (p, o) => req('DELETE', p, o),
  };
}

// Log in as `email` via the dev-only /api/test-login endpoint which creates
// a real Identity Platform session cookie without requiring a password.
// The password parameter is accepted for API compatibility but ignored.
async function login(email, _password, { retries = 3, retryDelayMs = 200 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const client = makeClient(null);
    const r = await client.post('/api/test-login', { email });
    if (r.status === 200) return client;
    lastErr = new Error(`test-login failed for ${email}: ${r.status} ${r.text}`);
    if (attempt < retries) {
      console.warn(`  login attempt ${attempt}/${retries} failed (${r.status}) — retrying in ${retryDelayMs}ms`);
      await new Promise(res => setTimeout(res, retryDelayMs));
    }
  }
  throw lastErr;
}

module.exports = {
  BASE,
  PASSWORD,
  ROLES,
  TEST_PORT,
  PREFIX,
  makeEmail,
  cleanupTestData,
  resetRateLimitStore,
  seedUsers,
  spawnServer,
  waitForServer,
  makeClient,
  login,
  setPool,
};
