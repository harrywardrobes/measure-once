const { spawn } = require('child_process');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

const TEST_PORT = parseInt(process.env.PRIV_TEST_PORT || '5050', 10);
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const PREFIX = 'privtest-';
const PASSWORD = 'Tr0ub4dor&3-VeryUnique-Pw!';

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
  // accounts, xss probe access-requests). The session purge also catches any
  // legacy '%@privtest.local' rows from older runs.
  await pool.query(`DELETE FROM sessions
    WHERE sess::text LIKE '%@privtest.local%'`);
  await pool.query(`DELETE FROM password_set_tokens WHERE email LIKE $1`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM allowed_emails WHERE email LIKE $1`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM account_requests WHERE email LIKE $1`, [`${PREFIX}%`]);
}

async function seedUsers(pool, runId) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const seeded = {};
  for (const role of ROLES) {
    const email = makeEmail(role, runId);
    await pool.query(
      `INSERT INTO allowed_emails (email, note) VALUES ($1, 'privilege test seed')
       ON CONFLICT (email) DO NOTHING`,
      [email]
    );
    const r = await pool.query(
      `INSERT INTO users (email, first_name, last_name, password_hash,
                          privilege_level, onboarding_status)
       VALUES ($1, $2, 'Test', $3, $4, 'active')
       RETURNING id`,
      [email, role.charAt(0).toUpperCase() + role.slice(1), hash, role]
    );
    seeded[role] = { email, id: r.rows[0].id, password: PASSWORD };
  }
  return seeded;
}

function spawnServer() {
  const env = {
    ...process.env,
    PORT: String(TEST_PORT),
    NODE_ENV: 'development',
    TURNSTILE_SECRET_KEY: '',
    TURNSTILE_SITE_KEY: '',
    HUBSPOT_ACCESS_TOKEN: '',
    HUBSPOT_TOKEN: '',
    SMTP_HOST: '',
    SMTP_PORT: '',
    SMTP_USER: '',
    SMTP_PASS: '',
    SMTP_FROM: '',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    QB_CLIENT_ID: '',
    QB_CLIENT_SECRET: '',
    APP_URL: BASE,
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
  const first = headerValue.split(',').find(p => p.trim().startsWith('connect.sid='))
             || headerValue;
  const kv = first.split(';')[0].trim();
  return kv.startsWith('connect.sid=') ? kv : null;
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

async function login(email, password) {
  const client = makeClient(null);
  const r = await client.post('/api/login', { email, password });
  if (r.status !== 200) {
    throw new Error(`login failed for ${email}: ${r.status} ${r.text}`);
  }
  return client;
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
};
