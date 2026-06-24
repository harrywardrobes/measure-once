// Email/password auth — replaces the prior Replit OIDC integration.
// Sessions are still managed by passport + connect-pg-simple, and req.user
// keeps its shape (`{ claims: { sub, email, ... }, expires_at, privilege_level,
// onboarding_status }`) so the rest of the app continues to work unchanged.
const logger = require('./logger');
const fs = require('fs');
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
const { getEmailTemplate, renderEmail } = require('./email-templates');

// ── Cloudflare Turnstile (captcha) ───────────────────────────────────────────
// Verifies the user-supplied token against Cloudflare's siteverify endpoint.
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Verify a Cloudflare Turnstile CAPTCHA token against the siteverify API.
 *
 * In production (`NODE_ENV=production`) the `TURNSTILE_SECRET_KEY` environment
 * variable is required — if it is absent the function fails closed so public
 * auth endpoints cannot be reached without a valid CAPTCHA response.
 * In development/test mode the check is a no-op when the key is absent,
 * allowing local operation without Turnstile credentials.
 * If Cloudflare is unreachable the function also fails closed so that a
 * network outage cannot be leveraged to bypass the CAPTCHA requirement.
 *
 * @param {string | undefined} token - The Cloudflare Turnstile response token
 *   submitted by the client (the `cf-turnstile-response` form field value).
 * @param {string | undefined} ip - Optional client IP address forwarded to
 *   Cloudflare as the `remoteip` binding hint.
 * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string}>}
 *   `ok: true` on success (or when skipped in dev/test mode).
 *   `ok: false` with a `reason` string on any failure.
 */
async function verifyCaptchaToken(token, ip) {
  if (!process.env.TURNSTILE_SECRET_KEY) {
    if (process.env.NODE_ENV === 'production') {
      // Fail closed: captcha is a required abuse control in production.
      // An operator must set TURNSTILE_SECRET_KEY before public auth endpoints
      // become reachable.
      logger.error('[SECURITY] TURNSTILE_SECRET_KEY is required in production but is not set — rejecting public auth request.');
      return { ok: false, reason: 'captcha-not-configured' };
    }
    return { ok: true, skipped: true };
  }

  // No token supplied — fail closed. The widget must complete before the form
  // can be submitted; omitting the token is a strong signal of automation.
  if (!token || typeof token !== 'string' || !token.trim()) {
    logger.warn('  Turnstile: no token supplied — rejecting request');
    return { ok: false, reason: 'missing-input-response' };
  }

  // Token present — verify it. If Cloudflare is unreachable, fail closed so
  // that a network outage cannot be leveraged to bypass the captcha requirement.
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
    // Cloudflare unreachable — fail closed; a verification outage must not open
    // the door to automated credential-stuffing or flood attacks.
    logger.warn({ err: e.message }, '  Turnstile: Cloudflare unreachable, rejecting request —');
    return { ok: false, reason: 'cloudflare-unreachable' };
  }
}
function turnstileError(res) {
  return res.status(400).json({ error: 'Captcha check failed — please try again.', code: 'CAPTCHA_FAILED' });
}

const MIN_PASSWORD_STRENGTH_SCORE = 2;

const PASSWORD_SET_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h (admin-issued)
const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000;    // 1h  (self-service reset)
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

// Escapes characters that have special meaning in HTML to prevent injection
// into email bodies or other HTML contexts.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


function createMailTransport() {
  if (process.env.MAIL_TRANSPORT_THROW_OVERRIDE) {
    return {
      sendMail() {
        return Promise.reject(new Error('MAIL_TRANSPORT_THROW_OVERRIDE: simulated send failure'));
      },
    };
  }
  if (process.env.MAIL_TRANSPORT_FILE_OVERRIDE) {
    const fpath = process.env.MAIL_TRANSPORT_FILE_OVERRIDE;
    return {
      sendMail(opts) {
        return new Promise((resolve, reject) => {
          try {
            fs.appendFileSync(fpath, JSON.stringify(opts) + '\n');
            resolve({ messageId: `override-${Date.now()}` });
          } catch (e) { reject(e); }
        });
      },
    };
  }
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
    logger.warn('  SMTP not configured — skipping admin notification email.');
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
          <tr><td><strong>Name</strong></td><td>${escapeHtml(name)}</td></tr>
          <tr><td><strong>Email</strong></td><td>${escapeHtml(email)}</td></tr>
          <tr><td><strong>Requested</strong></td><td>${escapeHtml(ts)}</td></tr>
        </table>
        <p>Log in to the admin panel to approve or reject the request.</p>
      `,
    });
    logger.info(`  Admin notification sent for access request: ${email}`);
  } catch (err) {
    logger.error({ err: err.message }, '  Failed to send admin notification email:');
  }
}

async function sendSetPasswordEmail(email, token, { resend = false, reset = false } = {}) {
  const transport = createMailTransport();
  if (!transport) {
    logger.warn(`  SMTP not configured — skipping set-password email for ${email}.`);
    logger.warn(`  Set-password link (manual delivery): ${appBaseUrl()}/set-password?token=${encodeURIComponent(token)}`);
    return;
  }
  const link = `${appBaseUrl()}/set-password?token=${encodeURIComponent(token)}`;
  const from = buildFromHeader();
  const replyTo = buildReplyTo();
  const templateKey = reset
    ? 'set_password_reset'
    : resend
      ? 'set_password_resend'
      : 'set_password_welcome';
  const tmpl = await getEmailTemplate(templateKey);
  const { subject, text, html } = renderEmail(tmpl, {
    textVars: { link },
    htmlVars: { link: escapeHtml(link) },
  });
  try {
    await transport.sendMail({
      from, replyTo, to: email, subject,
      text,
      html,
    });
    logger.info(`  Set-password email sent to ${email}`);
  } catch (err) {
    logger.error({ err: err.message }, '  Failed to send set-password email:');
  }
}

async function notifyUserOfPhotoApproval(email) {
  const transport = createMailTransport();
  if (!transport) {
    logger.warn(`  SMTP not configured — skipping photo-approval email for ${email}.`);
    return 'skipped';
  }
  const profileUrl = `${appBaseUrl()}/profile`;
  const from = buildFromHeader();
  const replyTo = buildReplyTo();
  try {
    await transport.sendMail({
      from,
      replyTo,
      to: email,
      subject: 'Your profile photo has been approved — Measure Once',
      text: [
        'Your profile photo submission has been reviewed and approved.',
        '',
        'Your new photo is now live on your profile:',
        `  ${profileUrl}`,
      ].join('\n'),
      html: `
        <p>Your profile photo submission has been reviewed and <strong>approved</strong>.</p>
        <p>Your new photo is now live on your profile:</p>
        <p><a href="${profileUrl}">${profileUrl}</a></p>
      `,
    });
    logger.info(`  Photo-approval email sent to ${email}`);
    return 'sent';
  } catch (err) {
    logger.error({ err: err.message }, '  Failed to send photo-approval email:');
    return 'failed';
  }
}

async function notifyUserOfPhotoRejection(email) {
  const transport = createMailTransport();
  if (!transport) {
    logger.warn(`  SMTP not configured — skipping photo-rejection email for ${email}.`);
    return 'skipped';
  }
  const profileUrl = `${appBaseUrl()}/profile`;
  const from = buildFromHeader();
  const replyTo = buildReplyTo();
  try {
    await transport.sendMail({
      from,
      replyTo,
      to: email,
      subject: 'Your profile photo was not approved — Measure Once',
      text: [
        'Your profile photo submission was reviewed and was not approved.',
        '',
        'Please upload a new photo by visiting your profile page:',
        `  ${profileUrl}`,
        '',
        'If you have any questions, please contact your administrator.',
      ].join('\n'),
      html: `
        <p>Your profile photo submission was reviewed and was <strong>not approved</strong>.</p>
        <p>Please upload a new photo by visiting your profile page:</p>
        <p><a href="${profileUrl}">${profileUrl}</a></p>
        <p>If you have any questions, please contact your administrator.</p>
      `,
    });
    logger.info(`  Photo-rejection email sent to ${email}`);
    return 'sent';
  } catch (err) {
    logger.error({ err: err.message }, '  Failed to send photo-rejection email:');
    return 'failed';
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
  // Schema (sessions, users, allowed_emails, account_requests,
  // password_set_tokens, bootstrap_admin_emails, job_roles, nav_role_configs
  // …) plus their idempotent seeds/backfills are created by migrations on boot.
  // This boot step performs only the runtime ADMIN_EMAILS bootstrap below, which
  // depends on the process.env.ADMIN_EMAILS value and cannot live in a static
  // migration.

  // Seed admin emails from env var + create user rows for them so the very
  // first admin can sign in once they set a password via the emailed link.
  //
  // The allowed_emails seed is tracked in bootstrap_admin_emails so it runs
  // exactly once per email. If an admin is later deprovisioned (removed from
  // allowed_emails), a server restart will NOT re-add them because their email
  // is already in the sentinel table. The users insert uses ON CONFLICT DO
  // NOTHING for the same reason — a privilege downgrade must survive restarts.
  const admins = (process.env.ADMIN_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  for (const email of admins) {
    // Only seed into allowed_emails if this address has never been bootstrapped.
    const seeded = await pool.query(
      `SELECT 1 FROM bootstrap_admin_emails WHERE email = $1`, [email]
    );
    if (seeded.rowCount === 0) {
      await pool.query(
        `INSERT INTO allowed_emails (email, note) VALUES ($1, 'admin')
         ON CONFLICT (email) DO NOTHING`,
        [email]
      );
      await pool.query(
        `INSERT INTO bootstrap_admin_emails (email) VALUES ($1)
         ON CONFLICT (email) DO NOTHING`,
        [email]
      );
    }
    await pool.query(
      `INSERT INTO users (email, privilege_level, onboarding_status)
       VALUES ($1, 'admin', 'active')
       ON CONFLICT (email) DO NOTHING`,
      [email]
    );
  }
}

// ── Session / rate-limit cleanup (unchanged from before) ─────────────────────
async function cleanupExpiredRateLimitRecords() {
  try {
    const result = await pool.query(`DELETE FROM rate_limit.sessions WHERE expires_at < NOW()`);
    if (result.rowCount > 0) {
      logger.info(`[rate-limit cleanup] Removed ${result.rowCount} expired session(s).`);
    }
  } catch (err) {
    if (err.code !== '42P01') {
      logger.error({ err: err.message }, '[rate-limit cleanup] Failed to prune expired records:');
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
      logger.info(`[session cleanup] Removed ${result.rowCount} expired session(s).`);
    }
  } catch (err) {
    logger.error({ err: err.message }, '[session cleanup] Failed to prune expired sessions:');
  }
}

async function cleanupExpiredPasswordTokens() {
  try {
    // Only delete tokens that were never consumed. Consumed tokens (used_at IS NOT NULL)
    // are kept for audit history.
    const r = await pool.query(
      `DELETE FROM password_set_tokens WHERE expires_at < NOW() - INTERVAL '7 days' AND used_at IS NULL`
    );
    if (r.rowCount > 0) logger.info(`[password-token cleanup] Removed ${r.rowCount} expired unconsumed token(s).`);
  } catch (err) {
    logger.error({ err: err.message }, '[password-token cleanup] Failed:');
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
    return true;
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to write admin audit log:');
    return false;
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

/**
 * getRequestPrivilegeLevel(req)
 *
 * Canonical helper for reading the current request user's privilege level
 * from the Passport session object.  Always defaults to 'member' when
 * req.user is absent (unauthenticated) or the field is unset.
 *
 * Use this in route handlers that need the session-cached privilege level
 * for conditional logic (e.g. a dev-only bypass, a page-serve redirect)
 * rather than scattering `req.user?.privilege_level || 'member'` inline.
 *
 * For route-level gating prefer the middleware functions:
 *   requireAdmin, requireManagerOrAdmin, requirePrivilege(minLevel).
 * Those re-query the database and are therefore always up-to-date even if
 * the session was created before a privilege change.
 *
 * @param {import('express').Request} req
 * @returns {'viewer'|'member'|'manager'|'admin'}
 */
function getRequestPrivilegeLevel(req) {
  return req.user?.privilege_level || 'member';
}

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
            photo_version,
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
            job_role, privilege_level, onboarding_status, password_hash,
            (custom_photo IS NOT NULL) AS has_custom_photo
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
  const isProd = process.env.NODE_ENV === 'production';
  return session({
    secret: process.env.SESSION_SECRET,
    store,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      httpOnly: true,
      // Production runs behind HTTPS with cross-site OAuth, so the cookie must
      // be Secure + SameSite=None. Over plain http://localhost a Secure cookie
      // is silently dropped by the browser, breaking local login — so dev uses
      // secure:false + SameSite=Lax. Gated on NODE_ENV (server-side signal).
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      maxAge: ttl,
    },
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
    has_custom_photo: dbUser.has_custom_photo || false,
    privilege_level: dbUser.privilege_level || 'member',
    onboarding_status: dbUser.onboarding_status || 'active',
    expires_at: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
}

function loginSessionUser(req, sessionUser) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((regenerateErr) => {
      if (regenerateErr) return reject(regenerateErr);
      req.login(sessionUser, (loginErr) => {
        if (loginErr) return reject(loginErr);
        req.session.save((saveErr) => {
          if (saveErr) return reject(saveErr);
          resolve(sessionUser);
        });
      });
    });
  });
}

async function setupAuth(app) {
  await ensureAuthTables();
  scheduleRateLimitCleanup();
  scheduleSessionCleanup();

  // Warn operators when Turnstile is not configured. Without these keys every
  // public auth endpoint (/api/login, /api/forgot-password, /api/request-access)
  // runs with no bot challenge, leaving only rate limits as abuse protection.
  if (!process.env.TURNSTILE_SECRET_KEY || !process.env.TURNSTILE_SITE_KEY) {
    logger.warn('[SECURITY] TURNSTILE_SECRET_KEY and/or TURNSTILE_SITE_KEY are not set. ' +
      'Captcha protection is disabled on all public auth endpoints. ' +
      'Set both secrets in production to enable bot and credential-stuffing protection.');
  }

  passport.serializeUser((user, cb) => cb(null, user));
  passport.deserializeUser((user, cb) => cb(null, user));

  // ── Login / logout ─────────────────────────────────────────────────────────
  app.post('/api/login', loginLimiter, async (req, res) => {
    const email = (req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password;
    if (!email || !password || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter your email and password.' });
    }
    const captcha = await verifyCaptchaToken(req.body?.captchaToken || req.body?.['cf-turnstile-response'], req.ip);
    if (!captcha.ok) return turnstileError(res);
    try {
      if (!(await isEmailApproved(email))) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }
      const dbUser = await getUserByEmail(email);
      if (!dbUser) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }
      const normalOk = dbUser.password_hash && await bcrypt.compare(password, dbUser.password_hash);
      if (!normalOk) {
        // Return a uniform response for all auth failures — no distinction
        // between unknown email, unapproved email, no-password-set, or wrong
        // password — so the public login endpoint cannot be used to enumerate
        // account existence or approval state.
        return res.status(401).json({ error: 'Invalid email or password.' });
      }

      const sessionUser = buildSessionUser(dbUser);
      await loginSessionUser(req, sessionUser);
      res.json({
        ok: true,
        onboarding_status: sessionUser.onboarding_status,
        next: sessionUser.onboarding_status === 'more_info_required' ? '/onboarding' : '/',
      });
    } catch (e) {
      logger.error({ err: e.message }, 'Login failed:');
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
  // /api/check-email is retained for API compatibility but intentionally returns
  // a constant response to prevent unauthenticated email-address enumeration.
  // The access-request form relies on the 409 from POST /api/request-access for
  // its authoritative already-approved signal; this endpoint no longer leaks
  // approval status to unauthenticated callers.
  app.get('/api/check-email', accessRequestLimiter, async (req, res) => {
    const email = (req.query.email || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email address.' });
    }
    res.json({ approved: false });
  });

  app.post('/api/request-access', accessRequestLimiter, async (req, res) => {
    const wantsJson = req.is('application/json') || req.headers.accept?.includes('application/json');
    try {
      const rawName = (req.body?.name || '').trim();
      const nameTokens = rawName.split(/\s+/).filter(Boolean)
        .map(t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
      const name = nameTokens.length <= 1
        ? (nameTokens[0] || '')
        : nameTokens[0] + ' ' + nameTokens[nameTokens.length - 1];
      const email = (req.body?.email || '').trim().toLowerCase();
      if (!name || !email || !/^[a-zA-Z0-9.!#$%&*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(email)) {
        return res.status(400).json({ error: 'Please provide a valid name and email.' });
      }
      const captcha = await verifyCaptchaToken(req.body?.captchaToken || req.body?.['cf-turnstile-response'], req.ip);
      if (!captcha.ok) return turnstileError(res);
      // Intentionally return the same success shape whether the email is already
      // approved, already has a pending request, or is genuinely new. Returning
      // distinguishable 409 responses for each state leaks account existence and
      // approval status to unauthenticated callers. Approved users who land here
      // will receive the same confirmation and can proceed to /login.
      const alreadyApproved = await isEmailApproved(email);
      if (!alreadyApproved) {
        const insertResult = await pool.query(
          `INSERT INTO account_requests (name, email) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING created_at`,
          [name, email]
        );
        if (insertResult.rowCount > 0) {
          logger.info(`  Access request: ${name} <${email}>`);
          const createdAt = insertResult.rows[0].created_at;
          notifyAdminsOfAccessRequest(name, email, createdAt).catch(() => {});
        }
      }
      if (wantsJson) {
        res.json({ ok: true });
      } else {
        res.redirect('/login?access_requested=1');
      }
    } catch (e) {
      logger.error({ err: e.message }, 'request-access failed:');
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
    const captcha = await verifyCaptchaToken(req.body?.captchaToken || req.body?.['cf-turnstile-response'], req.ip);
    if (!captcha.ok) return turnstileError(res);
    try {
      if (await isEmailApproved(email)) {
        try {
          const token = await issuePasswordSetToken(email, { purpose: 'reset' });
          await sendSetPasswordEmail(email, token, { reset: true });
          logger.info(`  Password reset link issued for ${email}`);
        } catch (mailErr) {
          logger.error({ err: mailErr.message }, '  Failed to issue/send password reset email:');
        }
      } else {
        logger.info(`  Password reset requested for unknown email: ${email}`);
      }
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e.message }, 'forgot-password failed:');
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
    // Pre-flight check (outside transaction) — fast rejection for obviously
    // invalid or already-used tokens before we acquire a connection.
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
      // Re-check the token inside the transaction with a row-level lock so that
      // two concurrent requests using the same link cannot both succeed.  The
      // FOR UPDATE lock serialises them; the second request will see used_at
      // already set and bail out before touching the password hash.
      const lockedToken = await client.query(
        `SELECT used_at, expires_at FROM password_set_tokens
           WHERE token_hash = $1
           FOR UPDATE`,
        [hashToken(token)]
      );
      if (
        lockedToken.rowCount === 0 ||
        lockedToken.rows[0].used_at !== null ||
        new Date(lockedToken.rows[0].expires_at).getTime() < Date.now()
      ) {
        await client.query('ROLLBACK');
        return res.status(410).json({ error: 'This password link is no longer valid. Ask an admin to send a new one.' });
      }
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
        // INTENTIONAL: only password_hash and updated_at are updated here.
        // Do NOT widen this UPDATE — profile fields (custom_photo, profile_image_url,
        // first_name, last_name, onboarding_status, etc.) must never be touched
        // by a password-reset path.
        await client.query(
          `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
          [hash, u.rows[0].id]
        );
      }
      // Mark token consumed. The AND used_at IS NULL guard provides a final
      // safety net; rowCount = 0 here would indicate a logic error.
      const consumed = await client.query(
        `UPDATE password_set_tokens SET used_at = NOW()
          WHERE token_hash = $1 AND used_at IS NULL`,
        [hashToken(token)]
      );
      if (consumed.rowCount === 0) {
        // Should be unreachable given the FOR UPDATE check above, but treat it
        // as a concurrent replay and abort rather than silently proceeding.
        await client.query('ROLLBACK');
        return res.status(410).json({ error: 'This password link is no longer valid. Ask an admin to send a new one.' });
      }
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
          logger.info(`[set-password] Cleared ${del.rowCount} other session(s) for ${lower}.`);
        }
      }
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) {
      await client.query('ROLLBACK');
      logger.error({ err: e.message }, 'set-password failed:');
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
        logger.info(`[change-password] Cleared ${del.rowCount} other session(s) for ${email}.`);
      }
      await client.query('COMMIT');
      res.json({ ok: true, otherSessionsCleared: del.rowCount || 0 });
    } catch (e) {
      await client.query('ROLLBACK');
      logger.error({ err: e.message }, 'change-password failed:');
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
      const photo_v = user?.photo_version
        ? new Date(user.photo_version).getTime().toString(36)
        : null;
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

    const _fnRaw = str(body.first_name, 100);
    const _fnTok = _fnRaw ? (_fnRaw.split(/\s+/).filter(Boolean)[0] || '') : '';
    const first_name = _fnTok ? _fnTok.charAt(0).toUpperCase() + _fnTok.slice(1).toLowerCase() : null;

    const _lnRaw    = str(body.last_name, 100);
    const _lnTokens = _lnRaw ? _lnRaw.split(/\s+/).filter(Boolean) : [];
    const _lnTok    = _lnTokens[_lnTokens.length - 1] || '';
    const last_name  = _lnTok ? _lnTok.charAt(0).toUpperCase() + _lnTok.slice(1).toLowerCase() : null;
    // job_role is intentionally ignored — it is set by the admin at approval
    // time and must not be overwritten by user submission.
    const date_of_birth = str(body.date_of_birth, 20);
    const ni_number     = str(body.ni_number, 20);
    const mobile_number = str(body.mobile_number, 30);
    const _ecFnRaw  = str(body.ec_first_name, 100);
    const _ecFnTok  = _ecFnRaw ? (_ecFnRaw.split(/\s+/).filter(Boolean)[0] || '') : '';
    const ec_first_name = _ecFnTok ? _ecFnTok.charAt(0).toUpperCase() + _ecFnTok.slice(1).toLowerCase() : null;

    const _ecLnRaw    = str(body.ec_last_name, 100);
    const _ecLnTokens = _ecLnRaw ? _ecLnRaw.split(/\s+/).filter(Boolean) : [];
    const _ecLnTok    = _ecLnTokens[_ecLnTokens.length - 1] || '';
    const ec_last_name  = _ecLnTok ? _ecLnTok.charAt(0).toUpperCase() + _ecLnTok.slice(1).toLowerCase() : null;
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

      // Detect conflicts: fields where admin pre-filled a non-empty value that
      // differs from what the user submitted during onboarding.
      const conflictFields = {
        first_name, last_name,
        date_of_birth, ni_number, mobile_number,
        ec_first_name, ec_last_name, ec_phone,
      };
      const pendingUpdates = {};
      for (const [field, userVal] of Object.entries(conflictFields)) {
        const adminVal = (existingMeta[field] || '').trim();
        const uVal = (userVal || '').trim();
        if (adminVal && uVal && adminVal.toLowerCase() !== uVal.toLowerCase()) {
          pendingUpdates[field] = { admin: adminVal, user: uVal };
        }
      }
      const pendingJson = Object.keys(pendingUpdates).length
        ? JSON.stringify(pendingUpdates)
        : null;

      await client.query(
        `INSERT INTO allowed_emails (email, metadata, pending_profile_updates, conflict_created_at)
         VALUES ($1, $2::jsonb, $3::jsonb, CASE WHEN $3::jsonb IS NOT NULL THEN NOW() ELSE NULL END)
         ON CONFLICT (email) DO UPDATE SET
           metadata = $2::jsonb,
           pending_profile_updates = $3::jsonb,
           conflict_created_at = CASE
             WHEN $3::jsonb IS NULL THEN NULL
             WHEN allowed_emails.conflict_created_at IS NOT NULL THEN allowed_emails.conflict_created_at
             ELSE NOW()
           END`,
        [email, JSON.stringify(newMeta), pendingJson]
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
      logger.error({ err: e.message }, 'onboarding-complete failed:');
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

      // Optional contact details captured by the admin at approval time.
      const trimTo = (v, max) => (v || '').toString().trim().slice(0, max) || null;
      const approveMobile = trimTo(req.body?.mobile_number, 30);
      if (approveMobile) meta.mobile_number = approveMobile;
      const approveEcPhone = trimTo(req.body?.ec_phone, 30);
      if (approveEcPhone) meta.ec_phone = approveEcPhone;

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
        logger.error({ err: mailErr.message }, '  Failed to issue/send set-password email after approval:');
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
      if (str(body.first_name, 100)) {
        const tok = str(body.first_name, 100).split(/\s+/).filter(Boolean)[0] || '';
        if (tok) meta.first_name = tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
      }
      if (str(body.last_name, 100)) {
        const tokens = str(body.last_name, 100).split(/\s+/).filter(Boolean);
        const tok = tokens[tokens.length - 1] || '';
        if (tok) meta.last_name = tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
      }
      if (str(body.date_of_birth,  20)) meta.date_of_birth = str(body.date_of_birth, 20);
      if (str(body.ni_number,      20)) meta.ni_number     = str(body.ni_number,  20);
      if (str(body.mobile_number,  30)) meta.mobile_number = str(body.mobile_number, 30);
      if (str(body.ec_first_name, 100)) {
        const tok = str(body.ec_first_name, 100).split(/\s+/).filter(Boolean)[0] || '';
        if (tok) meta.ec_first_name = tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
      }
      if (str(body.ec_last_name, 100)) {
        const tokens = str(body.ec_last_name, 100).split(/\s+/).filter(Boolean);
        const tok = tokens[tokens.length - 1] || '';
        if (tok) meta.ec_last_name = tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
      }
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
        logger.error({ err: mailErr.message }, '  Failed to issue/send set-password email after add-allowed:');
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
        `SELECT email, approved_at, note, metadata, pending_profile_updates, conflict_created_at FROM allowed_emails ORDER BY approved_at DESC`
      );
      res.json(r.rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/admin/allowed/:email', isAuthenticated, requireAdmin, async (req, res) => {
    try {
      const email = req.params.email.toLowerCase();
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
      logger.error({ err: e.message }, 'resend set-password failed:');
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
      // INTENTIONAL: only password_hash and updated_at are cleared here.
      // Do NOT widen this UPDATE — profile fields (custom_photo, profile_image_url,
      // first_name, last_name, onboarding_status, etc.) must never be touched
      // by a force-password-reset path.
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
      logger.error({ err: e.message }, 'force password reset failed:');
      res.status(500).json({ error: 'Could not force password reset. Please try again.' });
    }
  });

  // Admin: resolve onboarding profile discrepancies for a team member.
  // Clears pending_profile_updates and optionally applies chosen field values.
  // Accepts: { resolutions: { [field]: chosenValue } }
  app.post('/api/admin/users/:id/resolve-profile-conflicts', isAuthenticated, requireAdmin, async (req, res) => {
    const userId = req.params.id;
    const resolutions = (req.body && typeof req.body.resolutions === 'object' && !Array.isArray(req.body.resolutions))
      ? req.body.resolutions
      : {};

    const ALLOWED_FIELDS = ['first_name', 'last_name', 'date_of_birth', 'ni_number',
      'mobile_number', 'ec_first_name', 'ec_last_name', 'ec_phone'];
    const safeResolutions = {};
    for (const f of ALLOWED_FIELDS) {
      if (resolutions[f] !== undefined) safeResolutions[f] = (resolutions[f] || '').trim().slice(0, 200);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const curR = await client.query(
        `SELECT u.email FROM users u WHERE u.id = $1`, [userId]
      );
      if (curR.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'User not found' });
      }
      const email = (curR.rows[0].email || '').toLowerCase();

      // Apply any field values specified in resolutions.
      const userFields = ['first_name', 'last_name'];
      const userCols = [];
      const userVals = [];
      for (const f of userFields) {
        if (safeResolutions[f] !== undefined) {
          const raw = safeResolutions[f];
          const tokens = raw.split(/\s+/).filter(Boolean);
          const tok = f === 'first_name' ? (tokens[0] || '') : (tokens[tokens.length - 1] || '');
          const normalised = tok ? tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase() : null;
          userCols.push(`${f} = $${userCols.length + 1}`);
          userVals.push(normalised);
        }
      }
      if (userCols.length > 0) {
        userVals.push(userId);
        await client.query(
          `UPDATE users SET ${userCols.join(', ')}, updated_at = NOW() WHERE id = $${userVals.length}`,
          userVals
        );
      }

      const metaFields = ['date_of_birth', 'ni_number', 'mobile_number', 'ec_first_name', 'ec_last_name', 'ec_phone'];
      const hasMetaResolutions = metaFields.some(f => safeResolutions[f] !== undefined)
        || (safeResolutions.first_name !== undefined) || (safeResolutions.last_name !== undefined);

      if (hasMetaResolutions) {
        const existingR = await client.query(
          `SELECT metadata FROM allowed_emails WHERE email = $1`, [email]
        );
        const existingMeta = existingR.rows[0]?.metadata || {};
        const newMeta = { ...existingMeta };
        for (const f of metaFields) {
          if (safeResolutions[f] !== undefined) {
            const v = safeResolutions[f];
            if (v) newMeta[f] = v; else delete newMeta[f];
          }
        }
        if (safeResolutions.first_name !== undefined) newMeta.first_name = safeResolutions.first_name || undefined;
        if (safeResolutions.last_name  !== undefined) newMeta.last_name  = safeResolutions.last_name  || undefined;
        await client.query(
          `INSERT INTO allowed_emails (email, metadata, pending_profile_updates, conflict_created_at)
           VALUES ($1, $2::jsonb, NULL, NULL)
           ON CONFLICT (email) DO UPDATE SET metadata = $2::jsonb, pending_profile_updates = NULL, conflict_created_at = NULL`,
          [email, JSON.stringify(newMeta)]
        );
      } else {
        await client.query(
          `UPDATE allowed_emails SET pending_profile_updates = NULL, conflict_created_at = NULL WHERE email = $1`,
          [email]
        );
      }

      await client.query('COMMIT');

      const adminEmail = req.user?.claims?.email || req.user?.email || null;
      const fieldList = Object.keys(safeResolutions).join(', ') || 'none';
      await logAdminAction(adminEmail, 'resolve_profile_conflicts', email,
        `Resolved onboarding discrepancies; fields: ${fieldList}`);

      res.json({ ok: true });
    } catch (e) {
      await client.query('ROLLBACK');
      logger.error({ err: e.message }, 'resolve-profile-conflicts failed:');
      res.status(500).json({ error: 'Could not resolve conflicts. Please try again.' });
    } finally {
      client.release();
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

  app.get('/api/platform-users', isAuthenticated, requireManagerOrAdmin, async (req, res) => {
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
      logger.error({ err: e.message }, 'GET /api/platform-users failed:');
      res.status(500).json({ error: 'Failed to load users' });
    }
  });

  app.get('/api/admin/users', isAuthenticated, requireAdmin, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT u.id, u.email, u.first_name, u.last_name, u.profile_image_url,
                u.job_role, u.privilege_level, u.onboarding_status, u.created_at, u.updated_at,
                (u.password_hash IS NOT NULL) AS has_password,
                (u.custom_photo  IS NOT NULL) AS has_custom_photo,
                (u.pending_photo IS NOT NULL) AS has_pending_photo,
                ae.note, ae.metadata, ae.pending_profile_updates, ae.conflict_created_at
         FROM users u
         LEFT JOIN allowed_emails ae ON LOWER(u.email) = ae.email
         ORDER BY u.created_at DESC LIMIT 500`
      );
      res.json(r.rows.map(u => ({ ...u, isAdmin: isAdminEmail(u.email) })));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/admin/conflict-summary', isAuthenticated, requireAdmin, async (req, res) => {
    try {
      const sd = await pool.query(`SELECT value FROM admin_settings WHERE key = 'conflict_digest_stale_days'`);
      const staleDays = sd.rowCount > 0 ? Number(sd.rows[0].value) || 7 : 7;
      const r = await pool.query(
        `SELECT u.id, u.email, u.first_name, u.last_name,
                ae.conflict_created_at, ae.pending_profile_updates
         FROM users u
         JOIN allowed_emails ae ON LOWER(u.email) = ae.email
         WHERE ae.pending_profile_updates IS NOT NULL
           AND COALESCE(ae.conflict_created_at, u.updated_at, u.created_at) < NOW() - ($1 || ' days')::INTERVAL`,
        [staleDays]
      );
      res.json({ count: r.rowCount, users: r.rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/admin/conflict-digest-settings', isAuthenticated, requireAdmin, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT key, value FROM admin_settings
         WHERE key IN ('last_conflict_digest_sent_at', 'conflict_digest_stale_days', 'conflict_digest_min_gap_days')`
      );
      const byKey = Object.fromEntries(r.rows.map(row => [row.key, row.value]));
      const lastSentAt = byKey['last_conflict_digest_sent_at'] ?? null;
      const staleDays  = (byKey['conflict_digest_stale_days']   != null ? Number(byKey['conflict_digest_stale_days'])   : 7) || 7;
      const minGapDays = (byKey['conflict_digest_min_gap_days'] != null ? Number(byKey['conflict_digest_min_gap_days']) : 7) || 7;
      const smtpConfigured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
      res.json({ lastSentAt, smtpConfigured, staleDays, minGapDays });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.patch('/api/admin/conflict-digest-settings', isAuthenticated, requireAdmin, async (req, res) => {
    try {
      const { staleDays, minGapDays } = req.body || {};
      const updates = [];
      if (staleDays !== undefined) {
        const v = parseInt(staleDays, 10);
        if (!Number.isFinite(v) || v < 1 || v > 365) {
          return res.status(400).json({ error: 'staleDays must be an integer between 1 and 365.' });
        }
        updates.push({ key: 'conflict_digest_stale_days', value: v });
      }
      if (minGapDays !== undefined) {
        const v = parseInt(minGapDays, 10);
        if (!Number.isFinite(v) || v < 1 || v > 365) {
          return res.status(400).json({ error: 'minGapDays must be an integer between 1 and 365.' });
        }
        updates.push({ key: 'conflict_digest_min_gap_days', value: v });
      }
      for (const { key, value } of updates) {
        await pool.query(
          `INSERT INTO admin_settings (key, value, updated_at)
           VALUES ($1, to_jsonb($2::int), NOW())
           ON CONFLICT (key) DO UPDATE SET value = to_jsonb($2::int), updated_at = NOW()`,
          [key, value]
        );
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/conflict-digest/send-now', isAuthenticated, requireAdmin, async (req, res) => {
    try {
      if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
        return res.status(400).json({ error: 'SMTP is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS to enable email.' });
      }
      const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
      if (adminEmails.length === 0) {
        return res.status(400).json({ error: 'No admin email addresses configured (ADMIN_EMAILS).' });
      }
      const sent = await sendConflictDigest();
      let lastSentAt = null;
      if (sent) {
        await pool.query(
          `INSERT INTO admin_settings (key, value, updated_at)
           VALUES ('last_conflict_digest_sent_at', to_jsonb(NOW()::text), NOW())
           ON CONFLICT (key) DO UPDATE SET value = to_jsonb(NOW()::text), updated_at = NOW()`
        );
        const ts = await pool.query(`SELECT value FROM admin_settings WHERE key = 'last_conflict_digest_sent_at'`);
        lastSentAt = ts.rowCount > 0 ? ts.rows[0].value : null;
      }
      res.json({ sent: !!sent, lastSentAt });
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
      if (first_name !== undefined) {
        const fnTok = (first_name || '').trim().split(/\s+/).filter(Boolean)[0] || '';
        userCols.push(`first_name = $${userCols.length+1}`);
        userVals.push(fnTok ? fnTok.charAt(0).toUpperCase() + fnTok.slice(1).toLowerCase() : null);
      }
      if (last_name !== undefined) {
        const lnTokens = (last_name || '').trim().split(/\s+/).filter(Boolean);
        const lnTok = lnTokens[lnTokens.length - 1] || '';
        userCols.push(`last_name = $${userCols.length+1}`);
        userVals.push(lnTok ? lnTok.charAt(0).toUpperCase() + lnTok.slice(1).toLowerCase() : null);
      }
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
        if (ec_first_name !== undefined) {
          const tok = (ec_first_name || '').trim().split(/\s+/).filter(Boolean)[0] || '';
          const v = tok ? tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase() : null;
          if (v) newMeta.ec_first_name = v; else delete newMeta.ec_first_name;
        }
        if (ec_last_name !== undefined) {
          const tokens = (ec_last_name || '').trim().split(/\s+/).filter(Boolean);
          const tok = tokens[tokens.length - 1] || '';
          const v = tok ? tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase() : null;
          if (v) newMeta.ec_last_name = v; else delete newMeta.ec_last_name;
        }
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
              logger.error({ err: e.message }, 'Failed to invalidate sessions after role change:');
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
    { feat: 'View invoices',              desc: 'See QuickBooks invoice list and details',   levels: ['admin'] },
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
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO job_roles (name, privilege_level) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET privilege_level = EXCLUDED.privilege_level`,
        [name, privilege_level]
      );
      await client.query(
        `INSERT INTO nav_role_configs (role_name, is_customized)
         VALUES ($1, FALSE)
         ON CONFLICT (role_name) DO NOTHING`,
        [name]
      );
      await client.query('COMMIT');
      const adminEmail = req.user?.claims?.email || req.user?.email || null;
      await logAdminAction(adminEmail, 'add_job_role', null, `Added job role "${name}" (${privilege_level})`);
      res.json({ ok: true, name, privilege_level });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
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

  // ── Nav role config ───────────────────────────────────────────────────────

  // Returns the nav primary_keys for the calling user's job role (falls back
  // to __default__ when the role has no explicit config or user has no role).
  app.get('/api/nav-role-config', isAuthenticated, async (req, res) => {
    try {
      const userId = req.user.claims.sub;
      const u = await pool.query('SELECT job_role FROM users WHERE id = $1', [userId]);
      const jobRole = u.rows[0]?.job_role || null;
      let primary_keys = null;
      if (jobRole) {
        const r = await pool.query(
          'SELECT primary_keys, is_customized FROM nav_role_configs WHERE role_name = $1',
          [jobRole]
        );
        if (r.rows.length > 0 && r.rows[0].is_customized) {
          primary_keys = r.rows[0].primary_keys;
        }
      }
      let default_is_customized = false;
      if (primary_keys === null) {
        const r = await pool.query(
          "SELECT primary_keys, is_customized FROM nav_role_configs WHERE role_name = '__default__'"
        );
        primary_keys = r.rows[0]?.primary_keys || ['home', 'customers', 'projects'];
        default_is_customized = r.rows[0]?.is_customized || false;
      }
      res.json({ primary_keys, role: jobRole, default_is_customized });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: list all nav role configs.
  // Uncustomised roles (is_customized=false, role_name !== '__default__') have
  // their primary_keys resolved to the current __default__ value so callers see
  // the live-inherited layout rather than a stale snapshot.
  app.get('/api/admin/nav-role-configs', isAuthenticated, requireAdmin, async (req, res) => {
    try {
      const r = await pool.query(
        'SELECT role_name, primary_keys, is_customized FROM nav_role_configs ORDER BY role_name ASC'
      );
      const defaultRow = r.rows.find(row => row.role_name === '__default__');
      const defaultKeys = defaultRow?.primary_keys || ['home', 'customers', 'projects'];
      const rows = r.rows.map(row => {
        if (!row.is_customized && row.role_name !== '__default__') {
          return { ...row, primary_keys: defaultKeys };
        }
        return row;
      });
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: upsert nav primary_keys for a specific role.
  const VALID_NAV_KEYS_SERVER = new Set([
    'home', 'customers', 'sales', 'survey', 'projects', 'invoices', 'trades', 'ideas',
  ]);
  app.patch('/api/admin/nav-role-config/:roleName', isAuthenticated, requireAdmin, async (req, res) => {
    const roleName = req.params.roleName;
    const primary_keys = req.body?.primary_keys;
    if (
      !Array.isArray(primary_keys) ||
      primary_keys.length !== 3 ||
      !primary_keys.every((k) => typeof k === 'string' && VALID_NAV_KEYS_SERVER.has(k)) ||
      new Set(primary_keys).size !== 3
    ) {
      return res.status(400).json({
        error: 'primary_keys must be an array of exactly 3 unique valid nav keys.',
      });
    }
    try {
      await pool.query(
        `INSERT INTO nav_role_configs (role_name, primary_keys, is_customized, updated_at)
         VALUES ($1, $2::jsonb, TRUE, NOW())
         ON CONFLICT (role_name) DO UPDATE
           SET primary_keys = EXCLUDED.primary_keys, is_customized = TRUE, updated_at = NOW()`,
        [roleName, JSON.stringify(primary_keys)]
      );
      const adminEmail = req.user?.claims?.email || null;
      await logAdminAction(
        adminEmail,
        'update_nav_role_config',
        null,
        `Updated nav config for role "${roleName}": ${primary_keys.join(', ')}`
      );
      res.json({ ok: true, role_name: roleName, primary_keys });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: reset a role's nav config back to default (clears is_customized).
  app.delete('/api/admin/nav-role-config/:roleName', isAuthenticated, requireAdmin, async (req, res) => {
    const roleName = req.params.roleName;
    if (roleName === '__default__') {
      return res.status(400).json({ error: 'Cannot reset the default layout itself.' });
    }
    try {
      await pool.query(
        `UPDATE nav_role_configs SET is_customized = FALSE, updated_at = NOW()
         WHERE role_name = $1`,
        [roleName]
      );
      const adminEmail = req.user?.claims?.email || null;
      await logAdminAction(
        adminEmail,
        'reset_nav_role_config',
        null,
        `Reset nav config for role "${roleName}" to default`
      );
      res.json({ ok: true, role_name: roleName });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Profile photo ────────────────────────────────────────────────────────────
  const ALLOWED_PHOTO_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

  app.post('/api/users/me/photo', isAuthenticated, photoUploadLimiter, async (req, res) => {
    const userId = req.user?.claims?.sub;
    const { data } = req.body || {};
    if (!data || typeof data !== 'string' || !data.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Invalid image data.' });
    }
    const detectedMime = (data.match(/^data:([^;,]+)/) || [])[1] || '';
    if (!ALLOWED_PHOTO_MIME_TYPES.has(detectedMime)) {
      return res.status(400).json({ error: 'Unsupported image type. Please upload a JPEG, PNG, WebP, or GIF.' });
    }
    if (data.length > 4 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image is too large. Max ~3 MB after compression.' });
    }
    try {
      await pool.query(
        `UPDATE users SET pending_photo = $1, photo_version = NOW(), updated_at = NOW() WHERE id = $2`,
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
      const storedMime = (header.match(/^data:([^;,]+)/) || [])[1] || '';
      const safeMime = ALLOWED_PHOTO_MIME_TYPES.has(storedMime) ? storedMime : 'image/jpeg';
      res.set('Content-Type', safeMime);
      res.set('Content-Disposition', 'attachment');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Cache-Control', 'private, max-age=3600');
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
      const check = await pool.query(
        `SELECT pending_photo FROM users WHERE id = $1 AND pending_photo IS NOT NULL`,
        [req.params.id]
      );
      if (check.rowCount === 0) return res.status(404).json({ error: 'No pending photo found.' });
      const pendingMime = (check.rows[0].pending_photo.match(/^data:([^;,]+)/) || [])[1] || '';
      if (!ALLOWED_PHOTO_MIME_TYPES.has(pendingMime)) {
        await pool.query(
          `UPDATE users SET pending_photo = NULL, updated_at = NOW() WHERE id = $1`,
          [req.params.id]
        );
        return res.status(400).json({ error: 'Pending photo has an unsupported type and has been cleared.' });
      }
      const r = await pool.query(
        `UPDATE users
           SET custom_photo = pending_photo, pending_photo = NULL,
               photo_version = NOW(), updated_at = NOW()
         WHERE id = $1 AND pending_photo IS NOT NULL
         RETURNING email`,
        [req.params.id]
      );
      if (r.rowCount === 0) return res.status(404).json({ error: 'No pending photo found.' });
      const approvalNotifyStatus = await notifyUserOfPhotoApproval(r.rows[0].email);
      const approvalDetails = approvalNotifyStatus === 'sent'
        ? `Profile photo approved; email notification sent to ${r.rows[0].email}`
        : approvalNotifyStatus === 'skipped'
          ? 'Profile photo approved; email notification skipped (SMTP not configured)'
          : 'Profile photo approved; email notification failed to send';
      await logAdminAction(req.user?.claims?.email || req.user?.email || null, 'approve_profile_photo', r.rows[0].email, approvalDetails);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/photo-requests/:id/reject', isAuthenticated, requireAdmin, async (req, res) => {
    try {
      const r = await pool.query(
        `UPDATE users SET pending_photo = NULL, photo_version = NOW(), updated_at = NOW()
         WHERE id = $1 AND pending_photo IS NOT NULL RETURNING email`,
        [req.params.id]
      );
      if (r.rowCount === 0) return res.status(404).json({ error: 'No pending photo found.' });
      const rejectNotifyStatus = await notifyUserOfPhotoRejection(r.rows[0].email);
      const rejectDetails = rejectNotifyStatus === 'sent'
        ? `Profile photo rejected; email notification sent to ${r.rows[0].email}`
        : rejectNotifyStatus === 'skipped'
          ? 'Profile photo rejected; email notification skipped (SMTP not configured)'
          : 'Profile photo rejected; email notification failed to send';
      await logAdminAction(req.user?.claims?.email || req.user?.email || null, 'reject_profile_photo', r.rows[0].email, rejectDetails);
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
    // request. All users, including those originally seeded from ADMIN_EMAILS,
    // must remain in allowed_emails to continue accessing the application.
    const email = req.user.claims?.email;
    if (email) {
      try {
        const approved = await isEmailApproved(email);
        if (!approved) {
          logger.warn({ email, path: req.path, method: req.method }, '[isAuthenticated] 401: email not in allowed_emails — session invalidated');
          req.logout(() => {});
          return res.status(401).json({ message: 'Unauthorized' });
        }
      } catch (err) {
        logger.error({ err: err.message, path: req.path, method: req.method }, '[isAuthenticated] 500: DB error during isEmailApproved');
        return res.status(500).json({ message: 'Authorization check failed' });
      }
    }
    return next();
  }
  logger.warn({
    path: req.path,
    method: req.method,
    hasSession: !!(req.session && req.session.id),
    passportAuth: !!(req.isAuthenticated && req.isAuthenticated()),
    hasUser: !!(req.user),
  }, '[isAuthenticated] 401: no valid session');
  return res.status(401).json({ message: 'Unauthorized' });
};

// ── Onboarding conflict digest ────────────────────────────────────────────────
// Sends a weekly email to admins listing team members whose onboarding
// conflicts (pending_profile_updates) have been unresolved for 7+ days.
// The last-sent timestamp is persisted in admin_settings so restarts don't
// trigger duplicate sends within the same week.

const CONFLICT_DIGEST_INTERVAL_MS = 24 * 60 * 60 * 1000; // check daily
// CONFLICT_DIGEST_MIN_GAP_MS is the compile-time default; the runtime value is
// read from admin_settings.conflict_digest_min_gap_days by runConflictDigestIfDue().
const CONFLICT_DIGEST_MIN_GAP_MS  = 7 * 24 * 60 * 60 * 1000; // fallback default (7 days)

async function sendConflictDigest() {
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (adminEmails.length === 0) return;

  const transport = createMailTransport();
  if (!transport) return;

  const sd = await pool.query(`SELECT value FROM admin_settings WHERE key = 'conflict_digest_stale_days'`);
  const staleDays = sd.rowCount > 0 ? Number(sd.rows[0].value) || 7 : 7;

  // Find users with unresolved conflicts older than staleDays.
  const r = await pool.query(
    `SELECT u.email, u.first_name, u.last_name,
            COALESCE(ae.conflict_created_at, u.updated_at, u.created_at) AS conflict_since
     FROM users u
     JOIN allowed_emails ae ON LOWER(u.email) = ae.email
     WHERE ae.pending_profile_updates IS NOT NULL
       AND COALESCE(ae.conflict_created_at, u.updated_at, u.created_at) < NOW() - ($1 || ' days')::INTERVAL
     ORDER BY conflict_since ASC`,
    [staleDays]
  );
  if (r.rowCount === 0) return false;

  const count = r.rowCount;
  const rows  = r.rows;

  const baseUrl = appBaseUrl();
  const adminUrl = `${baseUrl}/admin`;
  const from    = buildFromHeader();
  const replyTo = buildReplyTo();

  const listText = rows.map(u => {
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email;
    const since = new Date(u.conflict_since).toDateString();
    return `  • ${name} <${u.email}> — unresolved since ${since}`;
  }).join('\n');

  const listHtml = rows.map(u => {
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email;
    const since = new Date(u.conflict_since).toDateString();
    return `<li><strong>${escapeHtml(name)}</strong> &lt;${escapeHtml(u.email)}&gt; — unresolved since ${escapeHtml(since)}</li>`;
  }).join('\n');

  const subject = `Measure Once — ${count} unresolved onboarding conflict${count === 1 ? '' : 's'}`;

  await transport.sendMail({
    from, replyTo,
    to: adminEmails.join(', '),
    subject,
    text: [
      `${count} team member${count === 1 ? ' has' : 's have'} an onboarding conflict that has been unresolved for ${staleDays} or more days.`,
      '',
      listText,
      '',
      `Review and resolve conflicts in the admin panel:`,
      `  ${adminUrl}`,
    ].join('\n'),
    html: `
      <p>${count} team member${count === 1 ? ' has' : 's have'} an onboarding conflict that has been unresolved for <strong>${staleDays} or more days</strong>.</p>
      <ul>${listHtml}</ul>
      <p>Review and resolve conflicts in the <a href="${escapeHtml(adminUrl)}">admin panel → Team tab</a>.</p>
    `,
  });
  logger.info(`[conflict-digest] Sent digest to ${adminEmails.length} admin(s) — ${count} conflict(s) (stale after ${staleDays} days).`);
  return true;
}

async function runConflictDigestIfDue() {
  try {
    // Check whether enough time has passed since the last digest.
    const r = await pool.query(
      `SELECT key, value FROM admin_settings
       WHERE key IN ('last_conflict_digest_sent_at', 'conflict_digest_min_gap_days')`
    );
    const byKey = Object.fromEntries(r.rows.map(row => [row.key, row.value]));
    const minGapDays = byKey['conflict_digest_min_gap_days'] != null ? Number(byKey['conflict_digest_min_gap_days']) || 7 : 7;
    const minGapMs   = minGapDays * 24 * 60 * 60 * 1000;
    if (byKey['last_conflict_digest_sent_at']) {
      const lastSent = new Date(byKey['last_conflict_digest_sent_at']).getTime();
      if (Date.now() - lastSent < minGapMs) return;
    }

    const sent = await sendConflictDigest();

    // Only record the send time when an email was actually dispatched.
    // If SMTP is not configured or there are no conflicts, we skip stamping so
    // that a later run can fire as soon as conditions change (e.g. SMTP is
    // configured, or a conflict becomes stale).
    if (sent) {
      await pool.query(
        `INSERT INTO admin_settings (key, value, updated_at)
         VALUES ('last_conflict_digest_sent_at', to_jsonb(NOW()::text), NOW())
         ON CONFLICT (key) DO UPDATE SET value = to_jsonb(NOW()::text), updated_at = NOW()`
      );
    }
  } catch (e) {
    logger.error({ err: e.message }, '[conflict-digest] Error:');
  }
}

function scheduleConflictDigest() {
  // Run an initial check shortly after boot so we catch a missed weekly window
  // even after frequent Replit restarts.
  setTimeout(runConflictDigestIfDue, 60 * 1000);
  setInterval(runConflictDigestIfDue, CONFLICT_DIGEST_INTERVAL_MS);
}

module.exports = {
  installSession, setupAuth, isAuthenticated, requireAdmin,
  requireManagerOrAdmin, requirePrivilege, requireOnboardingComplete,
  isAdminEmail, userIdExists, pool, logAdminAction, getRequestPrivilegeLevel,
  scheduleConflictDigest,
};
