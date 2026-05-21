// Email/password auth — replaces the prior Replit OIDC integration.
// Sessions are still managed by passport + connect-pg-simple, and req.user
// keeps its shape (`{ claims: { sub, email, ... }, expires_at, privilege_level,
// onboarding_status }`) so the rest of the app continues to work unchanged.
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const { PostgresStoreIndividualIP } = require('@acpr/rate-limit-postgresql');
const { photoUploadLimiter } = require('./rate-limiters');
const passport = require('passport');
const connectPg = require('connect-pg-simple');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const zxcvbn = require('zxcvbn');

// ── Cloudflare Turnstile (captcha) ───────────────────────────────────────────
// Verifies the user-supplied token against Cloudflare's siteverify endpoint.
// If TURNSTILE_SECRET_KEY is not set the check is a no-op so local dev and
// fresh deploys continue to work; in production the key should always be set.
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
async function verifyTurnstile(token, ip) {
  if (!process.env.TURNSTILE_SECRET_KEY) return { ok: true, skipped: true };

  // No token: the widget either hasn't loaded yet or couldn't connect to
  // Cloudflare (e.g. sandbox / network-restricted environment). Fail open and
  // rely on the rate limiter — bots are still capped at 20 attempts / 15 min.
  if (!token || typeof token !== 'string' || !token.trim()) {
    console.warn('  Turnstile: no token supplied — failing open (rate limiter applies)');
    return { ok: true, skipped: true };
  }

  // Token present — verify it. If Cloudflare is unreachable, also fail open.
  try {
    const body = new URLSearchParams();
    body.set('secret', process.env.TURNSTILE_SECRET_KEY);
    body.set('response', token);
    if (ip) body.set('remoteip', ip);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let data;
    try {
      const r = await fetch(TURNSTILE_VERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
      });
      data = await r.json();
    } finally {
      clearTimeout(timer);
    }
    if (data && data.success) return { ok: true };
    return { ok: false, reason: (data && data['error-codes'] && data['error-codes'][0]) || 'verify-failed' };
  } catch (e) {
    // Cloudflare unreachable — fail open; rate limiter still applies.
    console.warn('  Turnstile: Cloudflare unreachable, failing open —', e.message);
    return { ok: true, skipped: true };
  }
}
function turnstileError(res) {
  return res.status(400).json({ error: 'Captcha check failed — please try again.', code: 'CAPTCHA_FAILED' });
}

const MIN_PASSWORD_STRENGTH_SCORE = 2;

const PASSWORD_SET_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h (admin-issued)
const PASSWORD_RESET_TOKEN_TTL_MS = 15 * 60 * 1000;    // 15m (self-service reset)
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function createMailTransport() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: parseInt(process.env.SMTP_PORT || '587', 10) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

function appBaseUrl() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '');
  if (process.env.REPLIT_DOMAINS) return `https://${process.env.REPLIT_DOMAINS.split(',')[0].trim()}`;
  return 'https://measureonce.replit.app';
}

// Build a friendly "Measure Once <address>" From header so recipients see a
// recognisable sender even when the underlying SMTP_FROM is a plain mailbox.
// If SMTP_FROM is already in `Name <addr>` form we leave it as-is.
function buildFromHeader() {
  const raw = (process.env.SMTP_FROM || process.env.SMTP_USER || '').trim();
  if (!raw) return raw;
  if (/</.test(raw)) return raw;
  return `Measure Once <${raw}>`;
}
function buildReplyTo() {
  return (process.env.SMTP_REPLY_TO || process.env.SMTP_FROM || process.env.SMTP_USER || '').trim();
}

async function notifyAdminsOfAccessRequest(name, email, timestamp) {
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (adminEmails.length === 0) return;

  const transport = createMailTransport();
  if (!transport) {
    console.warn('  SMTP not configured — skipping admin notification email.');
    return;
  }

  const from = buildFromHeader();
  const replyTo = buildReplyTo();
  const ts = timestamp ? new Date(timestamp).toUTCString() : new Date().toUTCString();

  try {
    await transport.sendMail({
      from,
      replyTo,
      to: adminEmails.join(', '),
      subject: 'New access request — Measure Once',
      text: [
        'A new access request has been submitted.',
        '',
        `Name:      ${name}`,
        `Email:     ${email}`,
        `Requested: ${ts}`,
        '',
        'Log in to the admin panel to approve or reject the request.',
      ].join('\n'),
      html: `
        <p>A new access request has been submitted.</p>
        <table cellpadding="4" cellspacing="0">
          <tr><td><strong>Name</strong></td><td>${name}</td></tr>
          <tr><td><strong>Email</strong></td><td>${email}</td></tr>
          <tr><td><strong>Requested</strong></td><td>${ts}</td></tr>
        </table>
        <p>Log in to the admin panel to approve or reject the request.</p>
      `,
    });
    console.log(`  Admin notification sent for access request: ${email}`);
  } catch (err) {
    console.error('  Failed to send admin notification email:', err.message);
  }
}

async function sendSetPasswordEmail(email, token, { resend = false, reset = false } = {}) {
  const transport = createMailTransport();
  if (!transport) {
    console.warn(`  SMTP not configured — skipping set-password email for ${email}.`);
    console.warn(`  Set-password link (manual delivery): ${appBaseUrl()}/set-password?token=${encodeURIComponent(token)}`);
    return;
  }
  const link = `${appBaseUrl()}/set-password?token=${encodeURIComponent(token)}`;
  const from = buildFromHeader();
  const replyTo = buildReplyTo();
  const subject = reset
    ? 'Reset your Measure Once password'
    : resend
      ? 'Set your Measure Once password (new link)'
      : 'Welcome to Measure Once — set your password';
  const intro = reset
    ? 'A password reset was requested for your Measure Once account.'
    : resend
      ? 'A new password setup link has been issued for your Measure Once account.'
      : "You've been granted access to Measure Once.";
  const introHtml = reset
    ? 'A password reset was requested for your <strong>Measure Once</strong> account.'
    : resend
      ? 'A new password setup link has been issued for your Measure Once account.'
      : "You've been granted access to <strong>Measure Once</strong>.";
  const action = reset
    ? 'Reset your password by clicking the link below (valid for 15 minutes):'
    : 'Set your password by clicking the link below (valid for 24 hours):';
  try {
    await transport.sendMail({
      from, replyTo, to: email, subject,
      text: [
        intro,
        '',
        action,
        `  ${link}`,
        '',
        "If you didn't request this, you can safely ignore this email.",
      ].join('\n'),
      html: `
        <p>${introHtml}</p>
        <p>${action}</p>
        <p><a href="${link}">${link}</a></p>
        <p>If you didn't request this, you can safely ignore this email.</p>
      `,
    });
    console.log(`  Set-password email sent to ${email}`);
  } catch (err) {
    console.error('  Failed to send set-password email:', err.message);
  }
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Rate limiters ────────────────────────────────────────────────────────────
const accessRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: new PostgresStoreIndividualIP(
    { connectionString: process.env.DATABASE_URL },
    'access_request'
  ),
  handler: (req, res) => {
    res.status(429).type('text').send('Too many requests. Please try again later.');
  },
});

// Per-IP login throttle: 20 failed attempts/15 min. Successful logins are
// not counted (skipSuccessfulRequests).
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  store: new PostgresStoreIndividualIP(
    { connectionString: process.env.DATABASE_URL },
    'login_attempt'
  ),
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
  },
});

// ── Schema bootstrap ─────────────────────────────────────────────────────────
async function ensureAuthTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid VARCHAR PRIMARY KEY,
      sess JSONB NOT NULL,
      expire TIMESTAMP NOT NULL
    );
    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON sessions (expire);
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
      email VARCHAR UNIQUE,
      first_name VARCHAR,
      last_name VARCHAR,
      profile_image_url VARCHAR,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS allowed_emails (
      email VARCHAR PRIMARY KEY,
      approved_at TIMESTAMP DEFAULT NOW(),
      note VARCHAR
    );
    CREATE TABLE IF NOT EXISTS account_requests (
      id SERIAL PRIMARY KEY,
      name VARCHAR NOT NULL,
      email VARCHAR NOT NULL,
      status VARCHAR NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS "IDX_account_requests_email" ON account_requests (email);
  `);
  await pool.query(`
    DELETE FROM account_requests a
      USING account_requests b
      WHERE a.id > b.id AND a.email = b.email;
    CREATE UNIQUE INDEX IF NOT EXISTS "IDX_account_requests_email_unique" ON account_requests (email);
  `);

  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS job_role TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS privilege_level TEXT NOT NULL DEFAULT 'member';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_status TEXT NOT NULL DEFAULT 'active';
  `);

  /* Existing users (migrated from Replit Auth) are treated as already-active
     so they don't get pushed through the new "Complete your profile" flow,
     but they will still need to set a password via the emailed link before
     they can sign in again. */
  await pool.query(`
    UPDATE users SET onboarding_status = 'active'
     WHERE onboarding_status IS NULL OR onboarding_status NOT IN ('active','more_info_required');
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_set_tokens (
      token_hash TEXT PRIMARY KEY,
      email      VARCHAR NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      used_at    TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS "IDX_password_set_tokens_email" ON password_set_tokens (email);
    CREATE INDEX IF NOT EXISTS "IDX_password_set_tokens_expire" ON password_set_tokens (expires_at);
    ALTER TABLE password_set_tokens ADD COLUMN IF NOT EXISTS purpose TEXT;
  `);

  await pool.query(`
    ALTER TABLE allowed_emails ADD COLUMN IF NOT EXISTS metadata JSONB;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_settings (
      key VARCHAR PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    DO $$
    BEGIN
      CREATE TABLE IF NOT EXISTS job_roles (
        job_id         SERIAL PRIMARY KEY,
        name           VARCHAR NOT NULL UNIQUE,
        privilege_level TEXT    NOT NULL DEFAULT 'member',
        created_at     TIMESTAMP DEFAULT NOW()
      );

      BEGIN
        ALTER TABLE job_roles ADD COLUMN job_id SERIAL;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END;

      BEGIN
        ALTER TABLE job_roles ADD COLUMN privilege_level TEXT NOT NULL DEFAULT 'member';
      EXCEPTION WHEN duplicate_column THEN NULL;
      END;

      IF EXISTS (
        SELECT 1
        FROM   information_schema.key_column_usage kcu
        JOIN   information_schema.table_constraints tc
               ON  tc.constraint_name = kcu.constraint_name
               AND tc.table_name      = kcu.table_name
        WHERE  tc.table_name      = 'job_roles'
          AND  tc.constraint_type = 'PRIMARY KEY'
          AND  kcu.column_name    = 'name'
      ) THEN
        ALTER TABLE job_roles DROP CONSTRAINT job_roles_pkey;
        ALTER TABLE job_roles ADD  PRIMARY KEY (job_id);
        BEGIN
          ALTER TABLE job_roles ADD CONSTRAINT job_roles_name_key UNIQUE (name);
        EXCEPTION WHEN duplicate_table THEN NULL;
        END;
      END IF;

      INSERT INTO job_roles (name, privilege_level) VALUES
        ('Site Manager', 'manager'),
        ('Fitter',       'member'),
        ('Sales',        'member'),
        ('Admin',        'admin'),
        ('Office',       'manager')
      ON CONFLICT (name) DO NOTHING;

      UPDATE job_roles SET privilege_level = 'admin'   WHERE name = 'Admin'        AND privilege_level = 'member';
      UPDATE job_roles SET privilege_level = 'manager' WHERE name = 'Office'       AND privilege_level = 'member';
      UPDATE job_roles SET privilege_level = 'manager' WHERE name = 'Site Manager' AND privilege_level = 'member';
    END
    $$;
  `);

  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_photo TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_photo  TEXT;
  `);

  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS prefs JSONB NOT NULL DEFAULT '{}';
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id SERIAL PRIMARY KEY,
      acted_at TIMESTAMP DEFAULT NOW(),
      admin_email VARCHAR NOT NULL,
      action_type VARCHAR NOT NULL,
      target_email VARCHAR,
      details TEXT
    );
    CREATE INDEX IF NOT EXISTS "IDX_admin_audit_log_acted_at" ON admin_audit_log (acted_at DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      permission_key  VARCHAR NOT NULL,
      privilege_level VARCHAR NOT NULL,
      allowed         BOOLEAN NOT NULL DEFAULT false,
      PRIMARY KEY (permission_key, privilege_level)
    );
  `);

  // Seed admin emails from env var + create user rows for them so the very
  // first admin can sign in once they set a password via the emailed link.
  const admins = (process.env.ADMIN_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  for (const email of admins) {
    await pool.query(
      `INSERT INTO allowed_emails (email, note) VALUES ($1, 'admin')
       ON CONFLICT (email) DO NOTHING`,
      [email]
    );
    await pool.query(
      `INSERT INTO users (email, privilege_level, onboarding_status)
       VALUES ($1, 'admin', 'active')
       ON CONFLICT (email) DO UPDATE SET privilege_level = 'admin'`,
      [email]
    );
  }
}

// ── Session / rate-limit cleanup (unchanged from before) ─────────────────────
async function cleanupExpiredRateLimitRecords() {
  try {
    const result = await pool.query(`DELETE FROM rate_limit.sessions WHERE expires_at < NOW()`);
    if (result.rowCount > 0) {
      console.log(`[rate-limit cleanup] Removed ${result.rowCount} expired session(s).`);
    }
  } catch (err) {
    if (err.code !== '42P01') {
      console.error('[rate-limit cleanup] Failed to prune expired records:', err.message);
    }
  }
}

function scheduleRateLimitCleanup() {
  cleanupExpiredRateLimitRecords();
  setInterval(cleanupExpiredRateLimitRecords, 60 * 60 * 1000);
}

async function cleanupExpiredSessions() {
  try {
    const result = await pool.query(`DELETE FROM sessions WHERE expire < NOW()`);
    if (result.rowCount > 0) {
      console.log(`[session cleanup] Removed ${result.rowCount} expired session(s).`);
    }
  } catch (err) {
    console.error('[session cleanup] Failed to prune expired sessions:', err.message);
  }
}

async function cleanupExpiredPasswordTokens() {
  try {
    const r = await pool.query(`DELETE FROM password_set_tokens WHERE expires_at < NOW() - INTERVAL '7 days'`);
    if (r.rowCount > 0) console.log(`[password-token cleanup] Removed ${r.rowCount} expired token(s).`);
  } catch (err) {
    console.error('[password-token cleanup] Failed:', err.message);
  }
}

function scheduleSessionCleanup() {
  const raw = parseInt(process.env.SESSION_CLEANUP_INTERVAL_MS, 10);
  const intervalMs = raw > 0 ? raw : 60 * 60 * 1000;
  cleanupExpiredSessions();
  cleanupExpiredPasswordTokens();
  setInterval(() => { cleanupExpiredSessions(); cleanupExpiredPasswordTokens(); }, intervalMs);
}

// ── Audit log helper ─────────────────────────────────────────────────────────
async function logAdminAction(adminEmail, actionType, targetEmail, details) {
  try {
    await pool.query(
      `INSERT INTO admin_audit_log (admin_email, action_type, target_email, details)
       VALUES ($1, $2, $3, $4)`,
      [adminEmail || 'unknown', actionType, targetEmail || null, details || null]
    );
  } catch (err) {
    console.error('Failed to write admin audit log:', err.message);
  }
}

function getAdminEmails() {
  return new Set(
    (process.env.ADMIN_EMAILS || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  );
}

function isAdminEmail(email) {
  return !!email && getAdminEmails().has(email.toLowerCase());
}

// Authorization is based on the user's stored `privilege_level`, not on
// `ADMIN_EMAILS`. The env var is only a bootstrap mechanism that sets a new
// user's level to `admin` on first creation (see auth init paths); after that
// an admin can downgrade an account and the downgrade must take effect even
// if the email is still listed in ADMIN_EMAILS.
const requireAdmin = async (req, res, next) => {
  const userId = req.user?.claims?.sub;
  if (!userId) return res.status(403).json({ message: 'Admin access required' });
  try {
    const r = await pool.query(`SELECT privilege_level FROM users WHERE id = $1`, [userId]);
    if (r.rows[0]?.privilege_level === 'admin') return next();
  } catch {
    // fall through to 403
  }
  return res.status(403).json({ message: 'Admin access required' });
};

const PRIVILEGE_HIERARCHY = { viewer: 0, member: 1, manager: 2, admin: 3 };

function requirePrivilege(minLevel) {
  return async (req, res, next) => {
    const userId = req.user?.claims?.sub;
    if (!userId) return res.status(403).json({ message: 'Forbidden' });
    try {
      const r = await pool.query(`SELECT privilege_level FROM users WHERE id = $1`, [userId]);
      const level    = r.rows[0]?.privilege_level || 'member';
      const userRank = PRIVILEGE_HIERARCHY[level]    ?? 1;
      const minRank  = PRIVILEGE_HIERARCHY[minLevel] ?? 1;
      if (userRank >= minRank) return next();
      return res.status(403).json({ message: `${minLevel} privilege or higher is required` });
    } catch {
      return res.status(500).json({ message: 'Authorization check failed' });
    }
  };
}

const requireManagerOrAdmin = async (req, res, next) => {
  const userId = req.user?.claims?.sub;
  if (!userId) return res.status(403).json({ message: 'Forbidden' });
  try {
    const r = await pool.query(`SELECT privilege_level FROM users WHERE id = $1`, [userId]);
    const level = r.rows[0]?.privilege_level || 'member';
    if (level === 'manager' || level === 'admin') return next();
    return res.status(403).json({ message: 'Manager or admin access required' });
  } catch {
    return res.status(500).json({ message: 'Authorization check failed' });
  }
};

// ── Onboarding gate ──────────────────────────────────────────────────────────
// Used after isAuthenticated to block users still in 'more_info_required'
// from any API except the small set of onboarding/logout endpoints. The list
// of allowed paths is enforced by the caller in server.js, so this middleware
// only checks the user's current status.
async function requireOnboardingComplete(req, res, next) {
  const userId = req.user?.claims?.sub;
  if (!userId) return next();
  if (req.user.onboarding_status === 'active') return next();
  try {
    const r = await pool.query(`SELECT onboarding_status FROM users WHERE id = $1`, [userId]);
    const status = r.rows[0]?.onboarding_status || 'active';
    req.user.onboarding_status = status;
    if (status === 'active') return next();
    return res.status(403).json({ message: 'Complete your profile to continue.', code: 'ONBOARDING_REQUIRED' });
  } catch {
    return res.status(500).json({ message: 'Authorization check failed' });
  }
}

async function userIdExists(id) {
  if (!id) return false;
  try {
    const r = await pool.query('SELECT 1 FROM users WHERE id = $1', [id]);
    return r.rowCount > 0;
  } catch {
    return false;
  }
}

async function isEmailApproved(email) {
  if (!email) return false;
  const lower = email.toLowerCase();
  const r = await pool.query('SELECT 1 FROM allowed_emails WHERE email = $1', [lower]);
  return r.rowCount > 0;
}

async function getUser(id) {
  const r = await pool.query(
    `SELECT id, email, first_name, last_name, profile_image_url,
            job_role, privilege_level, onboarding_status, created_at, updated_at,
            (custom_photo  IS NOT NULL) AS has_custom_photo,
            (pending_photo IS NOT NULL) AS has_pending_photo
     FROM users WHERE id = $1`,
    [id]
  );
  return r.rows[0];
}

async function getUserByEmail(email) {
  if (!email) return null;
  const r = await pool.query(
    `SELECT id, email, first_name, last_name, profile_image_url,
            job_role, privilege_level, onboarding_status, password_hash
     FROM users WHERE LOWER(email) = LOWER($1)`,
    [email]
  );
  return r.rows[0] || null;
}

// ── Password / onboarding helpers ────────────────────────────────────────────
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function issuePasswordSetToken(email, { purpose = 'set' } = {}) {
  const lower = email.toLowerCase();
  const raw = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(raw);
  const ttlMs = purpose === 'reset' ? PASSWORD_RESET_TOKEN_TTL_MS : PASSWORD_SET_TOKEN_TTL_MS;
  const expiresAt = new Date(Date.now() + ttlMs);
  // Invalidate any prior unused tokens for this email so only the newest link works.
  await pool.query(
    `UPDATE password_set_tokens SET used_at = NOW()
       WHERE email = $1 AND used_at IS NULL`,
    [lower]
  );
  await pool.query(
    `INSERT INTO password_set_tokens (token_hash, email, expires_at, purpose)
     VALUES ($1, $2, $3, $4)`,
    [tokenHash, lower, expiresAt, purpose]
  );
  return raw;
}

async function lookupPasswordSetToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const r = await pool.query(
    `SELECT email, expires_at, used_at, purpose FROM password_set_tokens WHERE token_hash = $1`,
    [hashToken(rawToken)]
  );
  const row = r.rows[0];
  if (!row) return null;
  if (row.used_at) return { ...row, invalid: 'used' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ...row, invalid: 'expired' };
  return { ...row, invalid: null };
}

async function ensureUserForApprovedEmail(client, email, meta, { job_role = null, privilege_level = null } = {}) {
  const lower = email.toLowerCase();
  const m = meta || {};
  const first = m.first_name || null;
  const last  = m.last_name  || null;
  const isAdmin = isAdminEmail(lower);
  const privilege = isAdmin ? 'admin' : (privilege_level || 'member');
  // INSERT or update names if user already exists from prior approval/edit.
  // job_role and privilege_level are set on insert and only updated when
  // explicitly provided (admin chose them at approval time).
  const r = await client.query(
    `INSERT INTO users (email, first_name, last_name, privilege_level, job_role, onboarding_status)
     VALUES ($1, $2, $3, $4, $5, 'more_info_required')
     ON CONFLICT (email) DO UPDATE
       SET first_name      = COALESCE(EXCLUDED.first_name, users.first_name),
           last_name       = COALESCE(EXCLUDED.last_name,  users.last_name),
           privilege_level = EXCLUDED.privilege_level,
           job_role        = CASE WHEN EXCLUDED.job_role IS NOT NULL THEN EXCLUDED.job_role ELSE users.job_role END,
           updated_at      = NOW()
     RETURNING id, email, password_hash, onboarding_status`,
    [lower, first, last, privilege, job_role || null]
  );
  return r.rows[0];
}

function validatePasswordPolicy(pw, userInputs = []) {
  if (typeof pw !== 'string') return 'Password is required.';
  if (pw.length < 8)  return 'Password must be at least 8 characters.';
  if (pw.length > 200) return 'Password is too long.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) {
    return 'Password must contain both letters and numbers.';
  }
  const sanitizedInputs = (userInputs || [])
    .filter(v => typeof v === 'string' && v.trim().length > 0);
  // zxcvbn is capped at 100 chars for performance; the policy already rejects
  // anything longer above.
  const result = zxcvbn(pw, sanitizedInputs);
  if (result.score < MIN_PASSWORD_STRENGTH_SCORE) {
    const warning = result.feedback && result.feedback.warning;
    return warning
      ? `Password is too easy to guess: ${warning}`
      : 'Password is too easy to guess — please choose something less common.';
  }
  return null;
}

// ── Session install / setup ──────────────────────────────────────────────────
function getSession() {
  const ttl = SESSION_TTL_SECONDS * 1000;
  const PgStore = connectPg(session);
  const store = new PgStore({
    conString: process.env.DATABASE_URL,
    createTableIfMissing: false,
    ttl,
    tableName: 'sessions',
  });
  return session({
    secret: process.env.SESSION_SECRET,
    store,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: true, sameSite: 'lax', maxAge: ttl },
  });
}

function installSession(app) {
  if (!process.env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET is required.');
  }
  app.set('trust proxy', 1);
  app.use(getSession());
  app.use(passport.initialize());
  app.use(passport.session());
}

function buildSessionUser(dbUser) {
  return {
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
}

function loginSessionUser(req, sessionUser) {
  return new Promise((resolve, reject) => {
    req.login(sessionUser, (err) => err ? reject(err) : resolve(sessionUser));
  });
}

async function setupAuth(app) {
  await ensureAuthTables();
  scheduleRateLimitCleanup();
  scheduleSessionCleanup();

  passport.serializeUser((user, cb) => cb(null, user));
  passport.deserializeUser((user, cb) => cb(null, user));

  // ── Login / logout ─────────────────────────────────────────────────────────
  app.post('/api/login', loginLimiter, async (req, res) => {
    const email = (req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password;
    if (!email || !password || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter your email and password.' });
    }
    const captcha = await verifyTurnstile(req.body?.captchaToken || req.body?.['cf-turnstile-response'], req.ip);
    if (!captcha.ok) return turnstileError(res);
    try {
      if (!(await isEmailApproved(email))) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }
      const dbUser = await getUserByEmail(email);
      if (!dbUser || !dbUser.password_hash) {
        return res.status(401).json({
          error: "This account hasn't set a password yet. Ask an admin to send you the set-password link.",
          code: 'NO_PASSWORD',
        });
      }
      const ok = await bcrypt.compare(password, dbUser.password_hash);
      if (!ok) return res.status(401).json({ error: 'Invalid email or password.' });

      const sessionUser = buildSessionUser(dbUser);
      await loginSessionUser(req, sessionUser);
      if (req.session) req.session.photoVersion = Date.now().toString(36);
      res.json({
        ok: true,
        onboarding_status: sessionUser.onboarding_status,
        next: sessionUser.onboarding_status === 'more_info_required' ? '/onboarding' : '/',
      });
    } catch (e) {
      console.error('Login failed:', e.message);
      res.status(500).json({ error: 'Could not sign in. Please try again later.' });
    }
  });

  // Public: surface the Turnstile site key (and whether captcha is enabled)
  // so the signed-out login page can render the widget without hard-coding
  // the key in HTML.
  app.get('/api/turnstile-config', (_req, res) => {
    res.json({
      enabled: !!process.env.TURNSTILE_SECRET_KEY && !!process.env.TURNSTILE_SITE_KEY,
      siteKey: process.env.TURNSTILE_SITE_KEY || null,
    });
  });

  app.post('/api/logout', (req, res) => {
    const wantsJson = req.get('accept')?.includes('application/json')
                   && !req.get('accept')?.includes('text/html');
    const finish = () => {
      const done = () => {
        res.clearCookie('connect.sid');
        if (wantsJson) return res.json({ ok: true });
        return res.redirect('/login?signed_out=1');
      };
      if (req.session) req.session.destroy(done);
      else done();
    };
    if (req.logout) req.logout(() => finish());
    else finish();
  });

  // ── Public: email helpers / access requests (unchanged behaviour) ──────────
  app.get('/api/check-email', accessRequestLimiter, async (req, res) => {
    try {
      const email = (req.query.email || '').trim().toLowerCase();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Invalid email address.' });
      }
      const approved = await isEmailApproved(email);
      res.json({ approved });
    } catch (e) {
      console.error('check-email failed:', e.message);
      res.status(500).json({ error: 'Could not check email. Please try again later.' });
    }
  });

  app.post('/api/request-access', accessRequestLimiter, async (req, res) => {
    const wantsJson = req.is('application/json') || req.headers.accept?.includes('application/json');
    try {
      const name  = (req.body?.name  || '').trim();
      const email = (req.body?.email || '').trim().toLowerCase();
      if (!name || !email || !/^[a-zA-Z0-9.!#$%&*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(email)) {
        return res.status(400).json({ error: 'Please provide a valid name and email.' });
      }
      const captcha = await verifyTurnstile(req.body?.captchaToken || req.body?.['cf-turnstile-response'], req.ip);
      if (!captcha.ok) return turnstileError(res);
      if (await isEmailApproved(email)) {
        return wantsJson
          ? res.status(409).json({ status: 'approved' })
          : res.redirect('/login?access_approved=1');
      }
      const insertResult = await pool.query(
        `INSERT INTO account_requests (name, email) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING created_at`,
        [name, email]
      );
      if (insertResult.rowCount === 0) {
        return wantsJson
          ? res.status(409).json({ status: 'pending' })
          : res.redirect('/login?access_pending=1');
      }
      console.log(`  Access request: ${name} <${email}>`);
      const createdAt = insertResult.rows[0].created_at;
      notifyAdminsOfAccessRequest(name, email, createdAt).catch(() => {});
      res.json({ ok: true });
    } catch (e) {
      console.error('request-access failed:', e.message);
      res.status(500).json({ error: 'Could not submit request. Please try again later.' });
    }
  });

  // ── Public: forgot-password ────────────────────────────────────────────────
  // Always returns 200 with the same response shape regardless of whether the
  // email is on the approved list, so attackers can't use it to enumerate
  // accounts. Rate-limited via accessRequestLimiter (same 5/hr/IP cap as the
  // request-access endpoint).
  app.post('/api/forgot-password', accessRequestLimiter, async (req, res) => {
    const email = (req.body?.email || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }
    const captcha = await verifyTurnstile(req.body?.captchaToken || req.body?.['cf-turnstile-response'], req.ip);
    if (!captcha.ok) return turnstileError(res);
    try {
      if (await isEmailApproved(email)) {
        try {
          const token = await issuePasswordSetToken(email, { purpose: 'reset' });
          await sendSetPasswordEmail(email, token, { reset: true });
          console.log(`  Password reset link issued for ${email}`);
        } catch (mailErr) {
          console.error('  Failed to issue/send password reset email:', mailErr.message);
        }
      } else {
        console.log(`  Password reset requested for unknown email: ${email}`);
      }
      res.json({ ok: true });
    } catch (e) {
      console.error('forgot-password failed:', e.message);
      res.json({ ok: true });
    }
  });

  // ── Public: set-password flow ──────────────────────────────────────────────
  app.get('/api/set-password/validate', async (req, res) => {
    const token = (req.query?.token || '').toString();
    const row = await lookupPasswordSetToken(token);
    if (!row) return res.status(404).json({ valid: false, reason: 'invalid' });
    if (row.invalid) return res.status(410).json({ valid: false, reason: row.invalid, email: row.email, purpose: row.purpose || null });
    res.json({ valid: true, email: row.email, purpose: row.purpose || null });
  });

  app.post('/api/set-password', async (req, res) => {
    const token = (req.body?.token || '').toString();
    const password = req.body?.password;
    const row = await lookupPasswordSetToken(token);
    if (!row || row.invalid) {
      return res.status(410).json({ error: 'This password link is no longer valid. Ask an admin to send a new one.' });
    }
    const lower = row.email.toLowerCase();
    const localPart = lower.split('@')[0] || '';
    const policyErr = validatePasswordPolicy(password, [lower, localPart, 'measure once', 'measureonce']);
    if (policyErr) return res.status(400).json({ error: policyErr });
    if (!(await isEmailApproved(lower))) {
      return res.status(403).json({ error: 'This account is no longer approved. Contact an admin.' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const hash = await bcrypt.hash(password, 10);
      // Ensure user row exists (it should — created at approval time).
      const u = await client.query(
        `SELECT id FROM users WHERE LOWER(email) = LOWER($1)`,
        [lower]
      );
      if (u.rowCount === 0) {
        await client.query(
          `INSERT INTO users (email, password_hash, onboarding_status, privilege_level)
           VALUES ($1, $2, 'more_info_required', $3)`,
          [lower, hash, isAdminEmail(lower) ? 'admin' : 'member']
        );
      } else {
        await client.query(
          `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
          [hash, u.rows[0].id]
        );
      }
      await client.query(
        `UPDATE password_set_tokens SET used_at = NOW() WHERE token_hash = $1`,
        [hashToken(token)]
      );
      const userIdRow = u.rowCount === 0
        ? await client.query(`SELECT id FROM users WHERE LOWER(email) = LOWER($1)`, [lower])
        : u;
      const userId = userIdRow.rows[0]?.id;
      const currentSid = req.sessionID || null;
      if (userId) {
        const del = await client.query(
          `DELETE FROM sessions
             WHERE sid <> COALESCE($2, '')
               AND (
                 (sess #>> '{passport,user,claims,sub}') = $1::text
                 OR LOWER(sess #>> '{passport,user,claims,email}') = LOWER($3)
               )`,
          [String(userId), currentSid, lower]
        );
        if (del.rowCount) {
          console.log(`[set-password] Cleared ${del.rowCount} other session(s) for ${lower}.`);
        }
      }
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('set-password failed:', e.message);
      res.status(500).json({ error: 'Could not set password. Please try again.' });
    } finally {
      client.release();
    }
  });

  // ── Authenticated: change own password ────────────────────────────────────
  app.post('/api/change-password', isAuthenticated, loginLimiter, async (req, res) => {
    const currentPassword = req.body?.currentPassword;
    const newPassword = req.body?.newPassword;
    if (typeof currentPassword !== 'string' || !currentPassword ||
        typeof newPassword !== 'string' || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required.' });
    }
    const email = (req.user?.claims?.email || '').toLowerCase();
    const userId = req.user?.claims?.sub;
    if (!email || !userId) {
      return res.status(401).json({ error: 'Not signed in.' });
    }
    const dbUser = await getUserByEmail(email);
    if (!dbUser || !dbUser.password_hash) {
      return res.status(400).json({
        error: "This account doesn't have a password set. Ask an admin to send a set-password link.",
        code: 'NO_PASSWORD',
      });
    }
    const ok = await bcrypt.compare(currentPassword, dbUser.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }
    const localPart = email.split('@')[0] || '';
    const policyErr = validatePasswordPolicy(newPassword, [
      email, localPart, 'measure once', 'measureonce',
      dbUser.first_name || '', dbUser.last_name || '',
    ]);
    if (policyErr) return res.status(400).json({ error: policyErr });
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: 'New password must be different from your current password.' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const hash = await bcrypt.hash(newPassword, 10);
      await client.query(
        `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
        [hash, dbUser.id]
      );
      const currentSid = req.sessionID || null;
      const del = await client.query(
        `DELETE FROM sessions
           WHERE sid <> COALESCE($2, '')
             AND (
               (sess #>> '{passport,user,claims,sub}') = $1::text
               OR LOWER(sess #>> '{passport,user,claims,email}') = LOWER($3)
             )`,
        [String(dbUser.id), currentSid, email]
      );
      if (del.rowCount) {
        console.log(`[change-password] Cleared ${del.rowCount} other session(s) for ${email}.`);
      }
      await client.query('COMMIT');
      res.json({ ok: true, otherSessionsCleared: del.rowCount || 0 });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('change-password failed:', e.message);
      res.status(500).json({ error: 'Could not change password. Please try again.' });
    } finally {
      client.release();
    }
  });

  // ── Current user / onboarding status ───────────────────────────────────────
  app.get('/api/auth/user', isAuthenticated, async (req, res) => {
    try {
      const user = await getUser(req.user.claims.sub);
      // `isAdmin` is derived from the user's stored privilege_level so the
      // frontend's admin-only affordances stay in sync with what the server
      // will actually allow. ADMIN_EMAILS is only a bootstrap mechanism and
      // must not grant admin powers to a downgraded account.
      const isAdmin = user?.privilege_level === 'admin';
      const photo_v = req.session?.photoVersion || null;
      res.json(user ? { ...user, isAdmin, photo_v } : null);
    } catch (e) {
      res.status(500).json({ message: 'Failed to fetch user' });
    }
  });

  // List job roles for the onboarding form (auth required, names + privilege only).
  app.get('/api/job-roles', isAuthenticated, async (req, res) => {
    try {
      const r = await pool.query(`SELECT name FROM job_roles ORDER BY name ASC`);
      res.json(r.rows.map(row => row.name));
    } catch (e) {
      res.status(500).json({ error: 'Failed to load job roles' });
    }
  });

  app.get('/api/onboarding/me', isAuthenticated, async (req, res) => {
    try {
      const userId = req.user.claims.sub;
      const r = await pool.query(
        `SELECT u.id, u.email, u.first_name, u.last_name, u.job_role, u.onboarding_status,
                ae.metadata
           FROM users u
           LEFT JOIN allowed_emails ae ON LOWER(u.email) = ae.email
          WHERE u.id = $1`,
        [userId]
      );
      const row = r.rows[0];
      if (!row) return res.status(404).json({ error: 'User not found' });
      res.json(row);
    } catch (e) {
      res.status(500).json({ error: 'Failed to load profile' });
    }
  });

  app.post('/api/onboarding/complete', isAuthenticated, async (req, res) => {
    const userId = req.user.claims.sub;
    const body = req.body || {};
    const str  = (v, max) => (v || '').toString().trim().slice(0, max) || null;

    const first_name = str(body.first_name, 100);
    const last_name  = str(body.last_name, 100);
    // job_role is intentionally ignored — it is set by the admin at approval
    // time and must not be overwritten by user submission.
    const date_of_birth = str(body.date_of_birth, 20);
    const ni_number     = str(body.ni_number, 20);
    const mobile_number = str(body.mobile_number, 30);
    const ec_first_name = str(body.ec_first_name, 100);
    const ec_last_name  = str(body.ec_last_name, 100);
    const ec_phone      = str(body.ec_phone, 30);

    const missing = [];
    if (!first_name)    missing.push('first name');
    if (!last_name)     missing.push('last name');
    if (!date_of_birth) missing.push('date of birth');
    if (!ni_number)     missing.push('National Insurance number');
    if (!mobile_number) missing.push('mobile number');
    if (!ec_first_name) missing.push('emergency contact first name');
    if (!ec_last_name)  missing.push('emergency contact last name');
    if (!ec_phone)      missing.push('emergency contact phone');
    if (missing.length) {
      return res.status(400).json({ error: `Please fill in: ${missing.join(', ')}.` });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query(`SELECT email FROM users WHERE id = $1`, [userId]);
      if (cur.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'User not found' });
      }
      const email = (cur.rows[0].email || '').toLowerCase();

      await client.query(
        `UPDATE users
            SET first_name = $1, last_name = $2,
                onboarding_status = 'active', updated_at = NOW()
          WHERE id = $3`,
        [first_name, last_name, userId]
      );

      const existingR = await client.query(
        `SELECT metadata FROM allowed_emails WHERE email = $1`, [email]
      );
      const existingMeta = existingR.rows[0]?.metadata || {};
      const newMeta = {
        ...existingMeta,
        first_name, last_name,
        date_of_birth, ni_number, mobile_number,
        ec_first_name, ec_last_name, ec_phone,
      };
      await client.query(
        `INSERT INTO allowed_emails (email, metadata)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (email) DO UPDATE SET metadata = $2::jsonb`,
        [email, JSON.stringify(newMeta)]
      );

      await client.query('COMMIT');
      // Refresh session copy so subsequent requests aren't blocked by the gate.
      if (req.user) {
        req.user.onboarding_status = 'active';
        req.user.claims.first_name = first_name;
        req.user.claims.last_name  = last_name;
      }
      res.json({ ok: true });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('onboarding-complete failed:', e.message);
      res.status(500).json({ error: 'Could not save your profile. Please try again.' });
    } finally {
      client.release();
    }
  });

  // ── Admin: review access requests & manage allow-list ──────────────────────
  app.get('/api/admin/pending-count', isAuthenticated, requireAdmin, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT COUNT(*) AS count FROM account_requests WHERE status = 'pending'`
      );
      res.json({ count: parseInt(r.rows[0].count, 10) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/admin/requests', isAuthenticated, requireAdmin, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT id, name, email, status, created_at
         FROM account_requests
         ORDER BY (status = 'pending') DESC, created_at DESC
         LIMIT 200`
      );
      res.json(r.rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/requests/:id/approve', isAuthenticated, requireAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `SELECT name, email FROM account_requests WHERE id = $1`,
        [req.params.id]
      );
      if (r.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Request not found' });
      }
      const email = r.rows[0].email.toLowerCase();
      const name  = r.rows[0].name || '';
      const [firstGuess, ...rest] = name.split(/\s+/).filter(Boolean);
      const lastGuess = rest.join(' ') || null;
      const meta = {};
      if (firstGuess) meta.first_name = firstGuess;
      if (lastGuess)  meta.last_name  = lastGuess;

      // Admin-chosen role at approval time (optional — defaults to member).
      const requestedRole = (req.body?.job_role || '').trim() || null;
      let chosenRole = null;
      let chosenPrivilege = 'member';
      if (requestedRole) {
        const roleRow = await client.query(
          `SELECT name, privilege_level FROM job_roles WHERE name = $1`, [requestedRole]
        );
        if (roleRow.rowCount > 0) {
          chosenRole      = roleRow.rows[0].name;
          chosenPrivilege = roleRow.rows[0].privilege_level || 'member';
        }
      }

      await client.query(
        `INSERT INTO allowed_emails (email, note, metadata)
         VALUES ($1, 'approved via admin', $2::jsonb)
         ON CONFLICT (email) DO UPDATE
           SET note = COALESCE(allowed_emails.note, EXCLUDED.note),
               metadata = COALESCE(allowed_emails.metadata, EXCLUDED.metadata)`,
        [email, Object.keys(meta).length ? JSON.stringify(meta) : null]
      );
      await client.query(
        `UPDATE account_requests SET status = 'approved' WHERE id = $1`,
        [req.params.id]
      );
      await ensureUserForApprovedEmail(client, email, meta, { job_role: chosenRole, privilege_level: chosenPrivilege });
      await client.query('COMMIT');

      // Issue token + email outside the transaction so a mailer hiccup doesn't
      // roll back the approval. Admin can always resend.
      try {
        const token = await issuePasswordSetToken(email);
        await sendSetPasswordEmail(email, token);
      } catch (mailErr) {
        console.error('  Failed to issue/send set-password email after approval:', mailErr.message);
      }

      const adminEmail = req.user?.claims?.email || req.user?.email || null;
      const approveRoleDetail = chosenRole
        ? `Role: ${chosenRole} · Privilege: ${chosenPrivilege}`
        : `Privilege: ${chosenPrivilege}`;
      await logAdminAction(adminEmail, 'approve_request', email, `Approved access request id=${req.params.id}; ${approveRoleDetail}`);
      res.json({ ok: true, email });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  app.post('/api/admin/requests/:id/reject', isAuthenticated, requireAdmin, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT email FROM account_requests WHERE id = $1`,
        [req.params.id]
      );
      if (r.rowCount === 0) return res.status(404).json({ error: 'Request not found' });
      const email = r.rows[0].email;
      const upd = await pool.query(
        `UPDATE account_requests SET status = 'rejected' WHERE id = $1`,
        [req.params.id]
      );
      if (upd.rowCount === 0) return res.status(404).json({ error: 'Request not found' });
      const adminEmail = req.user?.claims?.email || req.user?.email || null;
      await logAdminAction(adminEmail, 'reject_request', email, `Rejected access request id=${req.params.id}`);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/allowed', isAuthenticated, requireAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
      const body  = req.body || {};
      const email = (body.email || '').trim().toLowerCase();
      const note  = (body.note  || '').trim().slice(0, 200) || null;
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Please provide a valid email address.' });
      }

      const meta = {};
      const str  = (v, max) => (v || '').toString().trim().slice(0, max) || null;
      if (str(body.first_name,    100)) meta.first_name    = str(body.first_name, 100);
      if (str(body.last_name,     100)) meta.last_name     = str(body.last_name,  100);
      if (str(body.date_of_birth,  20)) meta.date_of_birth = str(body.date_of_birth, 20);
      if (str(body.ni_number,      20)) meta.ni_number     = str(body.ni_number,  20);
      if (str(body.mobile_number,  30)) meta.mobile_number = str(body.mobile_number, 30);
      if (str(body.ec_first_name,  100)) meta.ec_first_name  = str(body.ec_first_name, 100);
      if (str(body.ec_last_name,   100)) meta.ec_last_name   = str(body.ec_last_name,  100);
      if (str(body.ec_phone,        30)) meta.ec_phone        = str(body.ec_phone, 30);
      const metaJson = Object.keys(meta).length ? JSON.stringify(meta) : null;

      // Admin-chosen role at invite time (optional — defaults to member).
      const requestedRole = str(body.job_role, 64);
      let chosenRole = null;
      let chosenPrivilege = 'member';

      await client.query('BEGIN');

      if (requestedRole) {
        const roleRow = await client.query(
          `SELECT name, privilege_level FROM job_roles WHERE name = $1`, [requestedRole]
        );
        if (roleRow.rowCount > 0) {
          chosenRole      = roleRow.rows[0].name;
          chosenPrivilege = roleRow.rows[0].privilege_level || 'member';
        }
      }

      const r = await client.query(
        `INSERT INTO allowed_emails (email, note, metadata)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (email) DO NOTHING
         RETURNING email, approved_at, note, metadata`,
        [email, note, metaJson]
      );
      if (r.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'This email is already on the approved list.' });
      }
      await ensureUserForApprovedEmail(client, email, meta, { job_role: chosenRole, privilege_level: chosenPrivilege });
      await client.query('COMMIT');

      try {
        const token = await issuePasswordSetToken(email);
        await sendSetPasswordEmail(email, token);
      } catch (mailErr) {
        console.error('  Failed to issue/send set-password email after add-allowed:', mailErr.message);
      }

      const adminEmail = req.user?.claims?.email || req.user?.email || null;
      const nameStr = [meta.first_name, meta.last_name].filter(Boolean).join(' ');
      const inviteRoleDetail = chosenRole
        ? `Role: ${chosenRole} · Privilege: ${chosenPrivilege}`
        : `Privilege: ${chosenPrivilege}`;
      await logAdminAction(adminEmail, 'add_allowed_email', email,
        [nameStr ? `Name: ${nameStr}` : null, note ? `Note: ${note}` : null, inviteRoleDetail].filter(Boolean).join('; ') || null);
      res.json({ ok: true, row: r.rows[0] });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  app.get('/api/admin/allowed', isAuthenticated, requireAdmin, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT email, approved_at, note, metadata FROM allowed_emails ORDER BY approved_at DESC`
      );
      const adminSet = getAdminEmails();
      res.json(r.rows.map(row => ({ ...row, protected: adminSet.has(row.email) })));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/admin/allowed/:email', isAuthenticated, requireAdmin, async (req, res) => {
    try {
      const email = req.params.email.toLowerCase();
      if (isAdminEmail(email)) {
        return res.status(400).json({ error: 'Cannot revoke an ADMIN_EMAILS address.' });
      }
      const del = await pool.query(`DELETE FROM allowed_emails WHERE email = $1`, [email]);
      if (del.rowCount > 0) {
        const adminEmail = req.user?.claims?.email || req.user?.email || null;
        await logAdminAction(adminEmail, 'revoke_allowed_email', email, null);
        // Immediately invalidate all active sessions for the revoked user so they
        // cannot continue using the application until the session naturally expires.
        await pool.query(
          `DELETE FROM sessions WHERE sess->'passport'->'user'->'claims'->>'email' = $1`,
          [email]
        );
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: re-issue a set-password link for any approved team member.
  app.post('/api/admin/users/:email/resend-set-password', isAuthenticated, requireAdmin, async (req, res) => {
    const email = (req.params.email || '').toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email.' });
    }
    if (!(await isEmailApproved(email))) {
      return res.status(404).json({ error: 'This email is not on the approved list.' });
    }
    try {
      const token = await issuePasswordSetToken(email);
      await sendSetPasswordEmail(email, token, { resend: true });
      const adminEmail = req.user?.claims?.email || req.user?.email || null;
      await logAdminAction(adminEmail, 'resend_set_password_email', email, null);
      res.json({ ok: true });
    } catch (e) {
      console.error('resend set-password failed:', e.message);
      res.status(500).json({ error: 'Could not send the email. Please try again.' });
    }
  });

  // Admin: force a password reset for a team member whose password may be
  // compromised. Clears the existing password hash, issues a fresh single-use
  // set-password token, emails the link, and destroys the target user's
  // active sessions so they cannot continue using the app with the old
  // credentials.
  app.post('/api/admin/users/:email/force-password-reset', isAuthenticated, requireAdmin, async (req, res) => {
    const email = (req.params.email || '').toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email.' });
    }
    if (!(await isEmailApproved(email))) {
      return res.status(404).json({ error: 'This email is not on the approved list.' });
    }
    const adminEmail = req.user?.claims?.email || req.user?.email || null;
    if (adminEmail && adminEmail.toLowerCase() === email) {
      return res.status(400).json({ error: 'Use the change-password flow to reset your own password.' });
    }
    try {
      await pool.query(
        `UPDATE users SET password_hash = NULL, updated_at = NOW() WHERE LOWER(email) = LOWER($1)`,
        [email]
      );
      await pool.query(
        `DELETE FROM sessions WHERE sess->'passport'->'user'->'claims'->>'email' = $1`,
        [email]
      );
      const token = await issuePasswordSetToken(email, { purpose: 'reset' });
      await sendSetPasswordEmail(email, token, { reset: true });
      await logAdminAction(adminEmail, 'force_password_reset', email, null);
      res.json({ ok: true });
    } catch (e) {
      console.error('force password reset failed:', e.message);
      res.status(500).json({ error: 'Could not force password reset. Please try again.' });
    }
  });

  // ── User Profile ─────────────────────────────────────────────────────────────
  app.get('/api/users/:id/profile', isAuthenticated, async (req, res) => {
    const requestingId    = req.user?.claims?.sub;
    const requestingEmail = req.user?.claims?.email;
    const targetId        = req.params.id;
    if (targetId !== requestingId) {
      // Only actual admins (by privilege_level) may view other users' profiles.
      let isAdmin = false;
      try {
        const a = await pool.query(`SELECT privilege_level FROM users WHERE id = $1`, [requestingId]);
        isAdmin = a.rows[0]?.privilege_level === 'admin';
      } catch { /* fall through to 403 */ }
      if (!isAdmin) return res.status(403).json({ error: 'Access denied' });
    }
    try {
      const r = await pool.query(
        `SELECT id, email, first_name, last_name, profile_image_url, job_role, privilege_level,
                onboarding_status, created_at,
                (custom_photo  IS NOT NULL) AS has_custom_photo,
                (pending_photo IS NOT NULL) AS has_pending_photo
         FROM users WHERE id = $1`,
        [targetId]
      );
      if (r.rowCount === 0) return res.status(404).json({ error: 'User not found' });
      const u = r.rows[0];
      res.json({ ...u, isAdmin: isAdminEmail(u.email) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/platform-users', isAuthenticated, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT id, first_name, last_name, email, profile_image_url, job_role,
                (custom_photo IS NOT NULL) AS has_custom_photo
         FROM users ORDER BY first_name ASC, last_name ASC LIMIT 200`
      );
      res.json(r.rows.map(u => ({
        id:              u.id,
        firstName:       u.first_name  || '',
        lastName:        u.last_name   || '',
        email:           u.email       || '',
        profileImageUrl: u.profile_image_url || null,
        jobRole:         u.job_role    || null,
        hasCustomPhoto:  u.has_custom_photo  || false,
      })));
    } catch (e) {
      console.error('GET /api/platform-users failed:', e.message);
      res.status(500).json({ error: 'Failed to load users' });
    }
  });

  app.get('/api/admin/users', isAuthenticated, requireAdmin, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT u.id, u.email, u.first_name, u.last_name, u.profile_image_url,
                u.job_role, u.privilege_level, u.onboarding_status, u.created_at,
                (u.password_hash IS NOT NULL) AS has_password,
                (u.custom_photo  IS NOT NULL) AS has_custom_photo,
                (u.pending_photo IS NOT NULL) AS has_pending_photo,
                ae.note, ae.metadata
         FROM users u
         LEFT JOIN allowed_emails ae ON LOWER(u.email) = ae.email
         ORDER BY u.created_at DESC LIMIT 500`
      );
      res.json(r.rows.map(u => ({ ...u, isAdmin: isAdminEmail(u.email) })));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  const ALLOWED_PRIVILEGE_LEVELS = ['viewer', 'member', 'manager', 'admin'];

  app.patch('/api/users/:id/profile', isAuthenticated, requireAdmin, async (req, res) => {
    const body = req.body || {};
    const { job_role, first_name, last_name,
            date_of_birth, ni_number, mobile_number,
            ec_first_name, ec_last_name, ec_phone, note } = body;
    const newEmail = body.email !== undefined ? (body.email || '').trim().toLowerCase() : undefined;

    const privilege_level = typeof body.privilege_level === 'string'
      ? body.privilege_level.trim().toLowerCase()
      : body.privilege_level;
    if (privilege_level !== undefined && !ALLOWED_PRIVILEGE_LEVELS.includes(privilege_level)) {
      return res.status(400).json({ error: 'Invalid privilege level' });
    }
    if (newEmail !== undefined && newEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const curR = await client.query('SELECT email, privilege_level FROM users WHERE id = $1', [req.params.id]);
      if (curR.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'User not found' });
      }
      const currentEmail = (curR.rows[0].email || '').toLowerCase();
      const currentPrivilegeLevel = curR.rows[0].privilege_level || 'member';

      const userCols = [];
      const userVals = [];
      if (first_name !== undefined)      { userCols.push(`first_name = $${userCols.length+1}`);      userVals.push(first_name?.trim() || null); }
      if (last_name !== undefined)       { userCols.push(`last_name = $${userCols.length+1}`);       userVals.push(last_name?.trim() || null); }
      if (job_role !== undefined)        { userCols.push(`job_role = $${userCols.length+1}`);        userVals.push(job_role || null); }
      if (privilege_level !== undefined) { userCols.push(`privilege_level = $${userCols.length+1}`); userVals.push(privilege_level); }
      if (newEmail !== undefined)        { userCols.push(`email = $${userCols.length+1}`);           userVals.push(newEmail || null); }

      let updated;
      if (userCols.length > 0) {
        userVals.push(req.params.id);
        const r = await client.query(
          `UPDATE users SET ${userCols.join(', ')}, updated_at = NOW()
           WHERE id = $${userVals.length}
           RETURNING id, email, first_name, last_name, profile_image_url, job_role, privilege_level, onboarding_status`,
          userVals
        );
        if (r.rowCount === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'User not found' });
        }
        updated = r.rows[0];
      } else {
        const r = await client.query(
          `SELECT id, email, first_name, last_name, profile_image_url, job_role, privilege_level, onboarding_status
           FROM users WHERE id = $1`,
          [req.params.id]
        );
        if (r.rowCount === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'User not found' });
        }
        updated = r.rows[0];
      }

      const targetEmail = (updated.email || currentEmail).toLowerCase();
      if (newEmail !== undefined && currentEmail && targetEmail && currentEmail !== targetEmail) {
        await client.query(
          `UPDATE allowed_emails SET email = $1 WHERE email = $2`,
          [targetEmail, currentEmail]
        );
      }

      const hasMetaUpdate = [date_of_birth, ni_number, mobile_number, ec_first_name, ec_last_name, ec_phone].some(v => v !== undefined);
      const hasNoteUpdate  = note !== undefined;
      const hasNameUpdate  = first_name !== undefined || last_name !== undefined;

      if (hasMetaUpdate || hasNoteUpdate || hasNameUpdate) {
        const str = (v, max) => (v || '').toString().trim().slice(0, max) || null;
        const existingR = await client.query(
          `SELECT metadata, note FROM allowed_emails WHERE email = $1`, [targetEmail]
        );
        const existingMeta = existingR.rows[0]?.metadata || {};
        const existingNote = existingR.rows[0]?.note ?? null;

        const newMeta = { ...existingMeta };
        if (date_of_birth !== undefined) { const v = str(date_of_birth, 20);  if (v) newMeta.date_of_birth = v; else delete newMeta.date_of_birth; }
        if (ni_number !== undefined)     { const v = str(ni_number, 20);       if (v) newMeta.ni_number = v;     else delete newMeta.ni_number; }
        if (mobile_number !== undefined) { const v = str(mobile_number, 30);   if (v) newMeta.mobile_number = v; else delete newMeta.mobile_number; }
        if (ec_first_name !== undefined) { const v = str(ec_first_name, 100);  if (v) newMeta.ec_first_name = v; else delete newMeta.ec_first_name; }
        if (ec_last_name !== undefined)  { const v = str(ec_last_name, 100);   if (v) newMeta.ec_last_name = v;  else delete newMeta.ec_last_name; }
        if (ec_phone !== undefined)      { const v = str(ec_phone, 30);        if (v) newMeta.ec_phone = v;      else delete newMeta.ec_phone; }
        if (first_name !== undefined) { const v = (first_name || '').trim(); if (v) newMeta.first_name = v; else delete newMeta.first_name; }
        if (last_name !== undefined)  { const v = (last_name || '').trim();  if (v) newMeta.last_name = v;  else delete newMeta.last_name; }

        const noteVal = hasNoteUpdate ? (str(note, 200)) : existingNote;

        await client.query(
          `INSERT INTO allowed_emails (email, metadata, note)
           VALUES ($1, $2::jsonb, $3)
           ON CONFLICT (email) DO UPDATE SET metadata = $2::jsonb, note = $3`,
          [targetEmail, JSON.stringify(newMeta), noteVal]
        );

        updated = { ...updated, metadata: newMeta, note: noteVal };
      } else {
        const metaR = await client.query(
          `SELECT metadata, note FROM allowed_emails WHERE email = $1`, [targetEmail]
        );
        updated = { ...updated, metadata: metaR.rows[0]?.metadata || null, note: metaR.rows[0]?.note ?? null };
      }

      await client.query('COMMIT');

      // If the privilege level changed, immediately invalidate the target
      // user's active sessions so cached `state.user` in their browser cannot
      // keep showing admin/manager affordances after a downgrade (or stale
      // reduced UI after an upgrade). They'll be bounced to /login on the
      // next request and pick up the new level on sign-in.
      if (privilege_level !== undefined && privilege_level !== currentPrivilegeLevel) {
        const actorId = req.user?.claims?.sub;
        if (actorId !== req.params.id) {
          const sessionEmail = (updated.email || currentEmail || '').toLowerCase();
          if (sessionEmail) {
            try {
              await pool.query(
                `DELETE FROM sessions WHERE sess->'passport'->'user'->'claims'->>'email' = $1`,
                [sessionEmail]
              );
              if (currentEmail && currentEmail !== sessionEmail) {
                await pool.query(
                  `DELETE FROM sessions WHERE sess->'passport'->'user'->'claims'->>'email' = $1`,
                  [currentEmail]
                );
              }
            } catch (e) {
              console.error('Failed to invalidate sessions after role change:', e.message);
            }
          }
        }
      }

      const adminEmail = req.user?.claims?.email || req.user?.email || null;
      const parts = [];
      if (first_name !== undefined)      parts.push(`first_name="${first_name?.trim() || 'none'}"`);
      if (last_name !== undefined)       parts.push(`last_name="${last_name?.trim() || 'none'}"`);
      if (job_role !== undefined)        parts.push(`job_role="${job_role || 'none'}"`);
      if (privilege_level !== undefined) parts.push(`privilege_level="${privilege_level}"`);
      if (newEmail !== undefined)        parts.push(`email="${newEmail}"`);
      if (date_of_birth !== undefined)   parts.push('date_of_birth updated');
      if (ni_number !== undefined)       parts.push('ni_number updated');
      if (mobile_number !== undefined)   parts.push('mobile_number updated');
      if (ec_first_name !== undefined || ec_last_name !== undefined || ec_phone !== undefined) parts.push('emergency_contact updated');
      if (note !== undefined)            parts.push(`note="${note}"`);
      await logAdminAction(adminEmail, 'edit_user_profile', updated.email, parts.join(', '));

      res.json(updated);
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ── Capabilities matrix ───────────────────────────────────────────────────
  const CAPABILITIES = [
    { group: 'General access' },
    { feat: 'View customers & projects',  desc: 'Browse CRM contacts and project rooms',    levels: ['viewer','member','manager','admin'] },
    { feat: 'View invoices',              desc: 'See QuickBooks invoice list and details',   levels: ['manager','admin'] },
    { feat: 'View calendar & visits',     desc: 'See the site-visit calendar',               levels: ['viewer','member','manager','admin'] },
    { group: 'Member actions' },
    { feat: 'Add notes & comments',       desc: 'Create notes on customer workflow records', levels: ['member','manager','admin'] },
    { feat: 'Edit workflow stages',       desc: 'Move customers through workflow stages',    levels: ['member','manager','admin'] },
    { feat: 'Log & manage site visits',   desc: 'Create, edit, and remove visit records',   levels: ['member','manager','admin'] },
    { feat: 'Edit & send invoices',       desc: 'Modify and dispatch QuickBooks invoices',   levels: ['admin'] },
    { group: 'Manager actions' },
    { feat: 'Assign fitters to rooms',    desc: 'Set which fitter handles a specific room', levels: ['manager','admin'] },
    { group: 'Admin-only actions' },
    { feat: 'Access admin panel',         desc: 'View and manage this admin control panel', levels: ['admin'] },
    { feat: 'Approve / reject users',     desc: 'Grant or deny platform access requests',   levels: ['manager','admin'] },
    { feat: 'Manage team & privileges',   desc: 'Edit job roles and privilege levels',       levels: ['admin'] },
    { feat: 'Manage job role catalogue',  desc: 'Add and remove available job role labels',  levels: ['admin'] },
  ];

  app.get('/api/admin/capabilities', isAuthenticated, requireAdmin, async (req, res) => {
    try {
      const LEVELS = ['viewer', 'member', 'manager', 'admin'];
      const rpRows = await pool.query(
        `SELECT permission_key, privilege_level, allowed FROM role_permissions`
      );
      const dbMap = {};
      for (const row of rpRows.rows) {
        if (!dbMap[row.permission_key]) dbMap[row.permission_key] = new Set();
        if (row.allowed) dbMap[row.permission_key].add(row.privilege_level);
      }
      const overRow = await pool.query(
        `SELECT value FROM admin_settings WHERE key = 'permission_overrides'`
      );
      const legacyOverrides = overRow.rows[0]?.value || {};

      const merged = CAPABILITIES.map(row => {
        if (row.group) return row;
        if (dbMap[row.feat] !== undefined) {
          return { ...row, levels: LEVELS.filter(l => dbMap[row.feat].has(l)) };
        }
        if (legacyOverrides[row.feat] !== undefined) {
          return { ...row, levels: legacyOverrides[row.feat] };
        }
        return row;
      });
      res.json({ levels: LEVELS, features: merged });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.patch('/api/admin/capabilities', isAuthenticated, requireAdmin, async (req, res) => {
    try {
      const overrides = req.body?.overrides;
      if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
        return res.status(400).json({ error: 'overrides must be an object' });
      }
      const validLevels = new Set(['viewer', 'member', 'manager', 'admin']);
      const validFeats  = new Set(CAPABILITIES.filter(f => f.feat).map(f => f.feat));
      for (const [feat, levels] of Object.entries(overrides)) {
        if (!validFeats.has(feat)) return res.status(400).json({ error: `Unknown feature: ${feat}` });
        if (!Array.isArray(levels) || !levels.every(l => validLevels.has(l))) {
          return res.status(400).json({ error: `Invalid levels for feature: ${feat}` });
        }
      }
      const allLevels = ['viewer', 'member', 'manager', 'admin'];
      for (const [feat, allowedLevels] of Object.entries(overrides)) {
        for (const lvl of allLevels) {
          await pool.query(
            `INSERT INTO role_permissions (permission_key, privilege_level, allowed)
             VALUES ($1, $2, $3)
             ON CONFLICT (permission_key, privilege_level)
             DO UPDATE SET allowed = EXCLUDED.allowed`,
            [feat, lvl, allowedLevels.includes(lvl)]
          );
        }
      }
      await pool.query(
        `INSERT INTO admin_settings (key, value)
         VALUES ('permission_overrides', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
        [JSON.stringify(overrides)]
      );
      const adminEmail = req.user?.claims?.email || req.user?.email || null;
      await logAdminAction(adminEmail, 'edit_permissions', null,
        `Updated ${Object.keys(overrides).length} feature permission(s) in role_permissions`);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Job Roles catalogue ───────────────────────────────────────────────────
  app.get('/api/admin/job-roles', isAuthenticated, requireAdmin, async (req, res) => {
    try {
      const r = await pool.query(`SELECT name, privilege_level FROM job_roles ORDER BY name ASC`);
      res.json(r.rows.map(row => ({ name: row.name, privilege_level: row.privilege_level || 'member' })));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/job-roles', isAuthenticated, requireAdmin, async (req, res) => {
    const name = (req.body?.name || '').trim();
    const VALID_LEVELS = ['viewer', 'member', 'manager', 'admin'];
    const privilege_level = VALID_LEVELS.includes(req.body?.privilege_level) ? req.body.privilege_level : 'member';
    if (!name || name.length > 64) {
      return res.status(400).json({ error: 'Role name must be 1–64 characters.' });
    }
    try {
      await pool.query(
        `INSERT INTO job_roles (name, privilege_level) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET privilege_level = EXCLUDED.privilege_level`,
        [name, privilege_level]
      );
      const adminEmail = req.user?.claims?.email || req.user?.email || null;
      await logAdminAction(adminEmail, 'add_job_role', null, `Added job role "${name}" (${privilege_level})`);
      res.json({ ok: true, name, privilege_level });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/admin/job-roles/:name', isAuthenticated, requireAdmin, async (req, res) => {
    const name = req.params.name;
    try {
      const del = await pool.query(`DELETE FROM job_roles WHERE name = $1`, [name]);
      if (del.rowCount > 0) {
        const adminEmail = req.user?.claims?.email || req.user?.email || null;
        await logAdminAction(adminEmail, 'delete_job_role', null, `Deleted job role "${name}"`);
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Profile photo ────────────────────────────────────────────────────────────
  app.post('/api/users/me/photo', isAuthenticated, photoUploadLimiter, async (req, res) => {
    const userId = req.user?.claims?.sub;
    const { data } = req.body || {};
    if (!data || typeof data !== 'string' || !data.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Invalid image data.' });
    }
    if (data.length > 4 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image is too large. Max ~3 MB after compression.' });
    }
    try {
      await pool.query(
        `UPDATE users SET pending_photo = $1, updated_at = NOW() WHERE id = $2`,
        [data, userId]
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/users/:id/photo', isAuthenticated, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT custom_photo FROM users WHERE id = $1`, [req.params.id]
      );
      const photo = r.rows[0]?.custom_photo;
      if (!photo) return res.status(404).end();
      const [header, b64] = photo.split(',');
      const mime = (header.match(/data:([^;]+)/) || [])[1] || 'image/jpeg';
      res.set('Content-Type', mime);
      res.set('Cache-Control', 'public, max-age=3600');
      res.send(Buffer.from(b64, 'base64'));
    } catch (e) {
      res.status(500).end();
    }
  });

  app.get('/api/admin/photo-requests', isAuthenticated, requireAdmin, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT id, email, first_name, last_name, pending_photo
         FROM users WHERE pending_photo IS NOT NULL
         ORDER BY updated_at DESC`
      );
      res.json(r.rows.map(u => ({
        id: u.id, email: u.email,
        first_name: u.first_name, last_name: u.last_name,
        pending_photo: u.pending_photo,
      })));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/photo-requests/:id/approve', isAuthenticated, requireAdmin, async (req, res) => {
    try {
      const r = await pool.query(
        `UPDATE users
           SET custom_photo = pending_photo, pending_photo = NULL, updated_at = NOW()
         WHERE id = $1 AND pending_photo IS NOT NULL
         RETURNING email`,
        [req.params.id]
      );
      if (r.rowCount === 0) return res.status(404).json({ error: 'No pending photo found.' });
      await logAdminAction(req.user?.claims?.email || req.user?.email || null, 'approve_profile_photo', r.rows[0].email, 'Profile photo approved');
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/photo-requests/:id/reject', isAuthenticated, requireAdmin, async (req, res) => {
    try {
      const r = await pool.query(
        `UPDATE users SET pending_photo = NULL, updated_at = NOW()
         WHERE id = $1 RETURNING email`,
        [req.params.id]
      );
      if (r.rowCount === 0) return res.status(404).json({ error: 'User not found.' });
      await logAdminAction(req.user?.claims?.email || req.user?.email || null, 'reject_profile_photo', r.rows[0].email, 'Profile photo rejected');
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/admin/audit-log', isAuthenticated, requireAdmin, async (req, res) => {
    try {
      const limit  = Math.min(Math.max(parseInt(req.query.limit,  10) || 200, 1), 500);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const r = await pool.query(
        `SELECT id, acted_at, admin_email, action_type, target_email, details
         FROM admin_audit_log
         ORDER BY acted_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      res.json(r.rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return true;
}

const isAuthenticated = async (req, res, next) => {
  if (req.isAuthenticated && req.isAuthenticated() && req.user && req.user.claims?.sub) {
    // Defense-in-depth: re-verify the user is still on the allow-list on every
    // request. ADMIN_EMAILS addresses are exempt (they are never in allowed_emails).
    const email = req.user.claims?.email;
    if (email && !isAdminEmail(email)) {
      try {
        const approved = await isEmailApproved(email);
        if (!approved) {
          req.logout(() => {});
          return res.status(401).json({ message: 'Unauthorized' });
        }
      } catch {
        return res.status(500).json({ message: 'Authorization check failed' });
      }
    }
    return next();
  }
  return res.status(401).json({ message: 'Unauthorized' });
};

module.exports = {
  installSession, setupAuth, isAuthenticated, requireAdmin,
  requireManagerOrAdmin, requirePrivilege, requireOnboardingComplete,
  isAdminEmail, userIdExists, pool,
};
