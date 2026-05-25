const { spawn } = require('child_process');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

const TEST_PORT = parseInt(process.env.PRIV_TEST_PORT || '5050', 10);
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const PREFIX = 'privtest-';
const PASSWORD = 'Tr0ub4dor&3-VeryUnique-Pw!';

// Module-level pool reference, set by run.js once the pool is created.
// Needed by loginViaDb when captcha enforcement is active.
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

// Sign a session id the same way express-session / cookie-signature does:
//   s:<sid>.<hmac-sha256(sid, secret) as plain base64 with trailing = stripped>
function signSid(sid, secret) {
  const sig = crypto.createHmac('sha256', secret)
    .update(sid)
    .digest('base64')
    .replace(/=+$/, '');
  return 's:' + sid + '.' + sig;
}

// Inject a session row directly into the `sessions` table and return an
// authenticated client.  Used when the spawned server has TURNSTILE_SECRET_KEY
// set (i.e. captcha is enforced), which means the HTTP /api/login endpoint
// would reject harness requests that carry no captcha token.
async function loginViaDb(email) {
  const pool = _pool;
  if (!pool) throw new Error('loginViaDb: call setPool(pool) before login when captcha is active');
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is required for loginViaDb');
  const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
  const r = await pool.query(
    `SELECT id, email, first_name, last_name, profile_image_url,
            privilege_level, onboarding_status
     FROM users WHERE LOWER(email) = LOWER($1)`,
    [email]
  );
  if (!r.rows[0]) {
    // Diagnostic: show how many privtest users currently exist
    const diag = await pool.query(
      `SELECT email, privilege_level FROM users WHERE email LIKE 'privtest-%' ORDER BY email`
    );
    console.error(`loginViaDb: user not found — ${email}`);
    console.error(`loginViaDb: privtest users in DB (${diag.rows.length}):`, diag.rows.map(u => u.email).join(', ') || '(none)');
    throw new Error(`loginViaDb: user not found — ${email}`);
  }
  const dbUser = r.rows[0];
  const sessionUser = {
    claims: {
      sub: dbUser.id,
      email: dbUser.email,
      first_name: dbUser.first_name || null,
      last_name: dbUser.last_name || null,
      profile_image_url: dbUser.profile_image_url || null,
    },
    privilege_level: dbUser.privilege_level || 'member',
    onboarding_status: dbUser.onboarding_status || 'active',
    expires_at: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const sid = crypto.randomUUID();
  const expire = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  const sess = JSON.stringify({
    cookie: {
      originalMaxAge: SESSION_TTL_SECONDS * 1000,
      expires: expire.toISOString(),
      secure: false,
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
    },
    passport: { user: sessionUser },
  });
  await pool.query(
    `INSERT INTO sessions (sid, sess, expire) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
    [sid, sess, expire]
  );
  const cookieValue = `connect.sid=${encodeURIComponent(signSid(sid, secret))}`;
  return makeClient(cookieValue);
}

// Log in as `email` using the best available method:
//   • If TURNSTILE_SECRET_KEY is passed through to the test server
//     (PRIVTEST_USE_TURNSTILE_SECRET_KEY=1), the HTTP login endpoint enforces
//     captcha and the harness cannot send a valid token — use DB session
//     injection instead.
//   • Otherwise use the normal HTTP /api/login path (captcha is a no-op when
//     the key is absent).
async function login(email, password) {
  const captchaActive = process.env.PRIVTEST_USE_TURNSTILE_SECRET_KEY === '1'
    && !!process.env.TURNSTILE_SECRET_KEY;
  if (captchaActive) {
    return loginViaDb(email);
  }
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
  setPool,
};
