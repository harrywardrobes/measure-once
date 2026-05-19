// Replit Auth (OpenID Connect) — JavaScript adaptation for plain Express app.
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const { PostgresStoreIndividualIP } = require('@acpr/rate-limit-postgresql');
const passport = require('passport');
const memoize = require('memoizee');
const connectPg = require('connect-pg-simple');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');

function createMailTransport() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: parseInt(process.env.SMTP_PORT || '587', 10) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
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

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const ts = timestamp ? new Date(timestamp).toUTCString() : new Date().toUTCString();

  try {
    await transport.sendMail({
      from,
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

async function notifyNewTeamMember(email) {
  const transport = createMailTransport();
  if (!transport) {
    console.warn('  SMTP not configured — skipping new team member notification email.');
    return;
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const appUrl = process.env.REPLIT_DOMAINS
    ? `https://${process.env.REPLIT_DOMAINS.split(',')[0].trim()}`
    : 'https://measureonce.replit.app';

  try {
    await transport.sendMail({
      from,
      to: email,
      subject: "You've been added to Measure Once",
      text: [
        "You've been granted access to Measure Once.",
        '',
        'Sign in at any time using the link below:',
        `  ${appUrl}`,
        '',
        'If you have any questions, please reach out to your administrator.',
      ].join('\n'),
      html: `
        <p>You've been granted access to <strong>Measure Once</strong>.</p>
        <p>Sign in at any time using the link below:</p>
        <p><a href="${appUrl}">${appUrl}</a></p>
        <p>If you have any questions, please reach out to your administrator.</p>
      `,
    });
    console.log(`  Welcome notification sent to new team member: ${email}`);
  } catch (err) {
    console.error('  Failed to send new team member notification email:', err.message);
  }
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Rate limiter for POST /api/request-access ──────────────────────────────
// At most 5 requests per IP per hour; backed by PostgreSQL so counts survive
// server restarts, deploys, and crash-loops.
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

// Ensure required tables exist.
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
  /* Deduplicate account_requests by email before enforcing uniqueness — keeps
     the earliest record per email so existing data is not lost. */
  await pool.query(`
    DELETE FROM account_requests a
      USING account_requests b
      WHERE a.id > b.id AND a.email = b.email;
    CREATE UNIQUE INDEX IF NOT EXISTS "IDX_account_requests_email_unique" ON account_requests (email);
  `);

  /* Add profile columns to users if they don't exist yet (idempotent). */
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS job_role TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS privilege_level TEXT NOT NULL DEFAULT 'member';
  `);

  /* Extra HR fields captured when an admin pre-approves a team member. */
  await pool.query(`
    ALTER TABLE allowed_emails ADD COLUMN IF NOT EXISTS metadata JSONB;
  `);

  /* Key/value store for admin-configurable settings (e.g. permission overrides). */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_settings (
      key VARCHAR PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  /* Job roles catalogue — admin-managed list of available role labels.
     Schema: job_id SERIAL PK, name UNIQUE, privilege_level, created_at.
     Migration is fully idempotent: safe to run against both fresh DBs and
     the legacy schema where name was the primary key. */
  await pool.query(`
    DO $$
    BEGIN
      /* ── 1. Create table with new schema if it does not exist yet ── */
      CREATE TABLE IF NOT EXISTS job_roles (
        job_id         SERIAL PRIMARY KEY,
        name           VARCHAR NOT NULL UNIQUE,
        privilege_level TEXT    NOT NULL DEFAULT 'member',
        created_at     TIMESTAMP DEFAULT NOW()
      );

      /* ── 2. Add job_id column if missing (legacy table had name as PK) ── */
      BEGIN
        ALTER TABLE job_roles ADD COLUMN job_id SERIAL;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END;

      /* ── 3. Add privilege_level column if missing ── */
      BEGIN
        ALTER TABLE job_roles ADD COLUMN privilege_level TEXT NOT NULL DEFAULT 'member';
      EXCEPTION WHEN duplicate_column THEN NULL;
      END;

      /* ── 4. Promote job_id to PRIMARY KEY if name is still the PK ── */
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
        /* name should already be unique via old PK; add explicit constraint if absent */
        BEGIN
          ALTER TABLE job_roles ADD CONSTRAINT job_roles_name_key UNIQUE (name);
        EXCEPTION WHEN duplicate_table THEN NULL;
        END;
      END IF;

      /* ── 5. Seed default roles with correct privilege levels ── */
      INSERT INTO job_roles (name, privilege_level) VALUES
        ('Site Manager', 'manager'),
        ('Fitter',       'member'),
        ('Sales',        'member'),
        ('Admin',        'admin'),
        ('Office',       'manager')
      ON CONFLICT (name) DO NOTHING;

      /* ── 6. Back-fill privilege levels that were left at the default ── */
      UPDATE job_roles SET privilege_level = 'admin'   WHERE name = 'Admin'        AND privilege_level = 'member';
      UPDATE job_roles SET privilege_level = 'manager' WHERE name = 'Office'       AND privilege_level = 'member';
      UPDATE job_roles SET privilege_level = 'manager' WHERE name = 'Site Manager' AND privilege_level = 'member';
    END
    $$;
  `);

  /* Profile photo storage — pending awaiting approval, custom is approved & served. */
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_photo TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_photo  TEXT;
  `);

  /* Admin audit log — immutable record of every admin action. */
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

  /* Role-permissions matrix — stores which privilege levels have each feature enabled.
     Columns: permission_key (feature name), privilege_level (viewer/member/manager/admin), allowed BOOLEAN.
     Seeded from the CAPABILITIES constant on first boot; admin UI overrides land here. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      permission_key  VARCHAR NOT NULL,
      privilege_level VARCHAR NOT NULL,
      allowed         BOOLEAN NOT NULL DEFAULT false,
      PRIMARY KEY (permission_key, privilege_level)
    );
  `);

  // Seed admin emails from env var.
  const admins = (process.env.ADMIN_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  for (const email of admins) {
    await pool.query(
      `INSERT INTO allowed_emails (email, note) VALUES ($1, 'admin')
       ON CONFLICT (email) DO NOTHING`,
      [email]
    );
  }
}

// ── Rate-limit record cleanup ───────────────────────────────────────────────
// Deletes expired sessions from rate_limit.sessions. Because individual_records
// and records_aggregated reference sessions with ON DELETE CASCADE, removing
// an expired session automatically removes all of its associated records.
// Called once on startup, then on a 1-hour interval.
async function cleanupExpiredRateLimitRecords() {
  try {
    const result = await pool.query(
      `DELETE FROM rate_limit.sessions WHERE expires_at < NOW()`
    );
    if (result.rowCount > 0) {
      console.log(`[rate-limit cleanup] Removed ${result.rowCount} expired session(s).`);
    }
  } catch (err) {
    // 42P01 = undefined_table: rate_limit schema not yet created by the store.
    // This is expected on a fresh database; silently skip until the first
    // rate-limited request causes the store to run its own migrations.
    if (err.code !== '42P01') {
      console.error('[rate-limit cleanup] Failed to prune expired records:', err.message);
    }
  }
}

function scheduleRateLimitCleanup() {
  cleanupExpiredRateLimitRecords();
  setInterval(cleanupExpiredRateLimitRecords, 60 * 60 * 1000);
}

// Audit-failure policy: log errors but do not abort the parent admin action.
// A database write failure for the audit entry is operationally visible via
// server logs, but we intentionally avoid propagating the error so that a
// transient DB blip does not prevent valid admin operations.  If strict
// auditability is required in future, replace with a transaction that rolls
// back the parent mutation on audit-write failure.
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

const requireAdmin = async (req, res, next) => {
  const email  = req.user?.claims?.email;
  const userId = req.user?.claims?.sub;
  if (!email) return res.status(403).json({ message: 'Admin access required' });
  if (isAdminEmail(email)) return next();
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
    const email  = req.user?.claims?.email;
    const userId = req.user?.claims?.sub;
    if (!email || !userId) return res.status(403).json({ message: 'Forbidden' });
    if (isAdminEmail(email)) return next();
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
  const email  = req.user?.claims?.email;
  const userId = req.user?.claims?.sub;
  if (!email || !userId) return res.status(403).json({ message: 'Forbidden' });
  if (isAdminEmail(email)) return next();
  try {
    const r = await pool.query(
      `SELECT privilege_level FROM users WHERE id = $1`, [userId]
    );
    const level = r.rows[0]?.privilege_level || 'member';
    if (level === 'manager' || level === 'admin') return next();
    return res.status(403).json({ message: 'Manager or admin access required' });
  } catch {
    return res.status(500).json({ message: 'Authorization check failed' });
  }
};

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

async function upsertUser(claims) {
  const email = claims.email || null;
  try {
    await pool.query(
      `INSERT INTO users (id, email, first_name, last_name, profile_image_url, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (id) DO UPDATE
         SET email = EXCLUDED.email,
             first_name = EXCLUDED.first_name,
             last_name = EXCLUDED.last_name,
             profile_image_url = EXCLUDED.profile_image_url,
             updated_at = NOW()`,
      [
        claims.sub,
        email,
        claims.first_name || null,
        claims.last_name || null,
        claims.profile_image_url || null,
      ]
    );
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'users_email_key') {
      const conflict = new Error('This email address is already registered to another account.');
      conflict.code = 'EMAIL_CONFLICT';
      throw conflict;
    }
    throw err;
  }
}

async function getUser(id) {
  const r = await pool.query(
    `SELECT id, email, first_name, last_name, profile_image_url,
            job_role, privilege_level, created_at, updated_at,
            (custom_photo  IS NOT NULL) AS has_custom_photo,
            (pending_photo IS NOT NULL) AS has_pending_photo
     FROM users WHERE id = $1`,
    [id]
  );
  return r.rows[0];
}

const getOidcConfig = memoize(
  async () => {
    const client = await import('openid-client');
    return {
      client,
      config: await client.discovery(
        new URL(process.env.ISSUER_URL || 'https://replit.com/oidc'),
        process.env.REPL_ID
      ),
    };
  },
  { maxAge: 3600 * 1000, promise: true }
);

function getSession() {
  const ttl = 7 * 24 * 60 * 60 * 1000;
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
    cookie: { httpOnly: true, secure: true, maxAge: ttl },
  });
}

function updateUserSession(user, tokens) {
  user.claims = tokens.claims();
  user.access_token = tokens.access_token;
  user.refresh_token = tokens.refresh_token;
  user.expires_at = user.claims && user.claims.exp;
}

function installSession(app) {
  if (!process.env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET is required for Replit Auth.');
  }
  app.set('trust proxy', 1);
  app.use(getSession());
  app.use(passport.initialize());
  app.use(passport.session());
}

async function setupAuth(app) {
  if (!process.env.REPL_ID) {
    console.warn('  REPL_ID not set — Replit Auth will not initialize.');
    return false;
  }

  await ensureAuthTables();
  scheduleRateLimitCleanup();

  const { client, config } = await getOidcConfig();
  const { Strategy } = await import('openid-client/passport');

  const verify = async (tokens, verified) => {
    try {
      const claims = tokens.claims();
      const email = (claims.email || '').toLowerCase();
      if (!(await isEmailApproved(email))) {
        const name = [claims.first_name, claims.last_name].filter(Boolean).join(' ')
          || claims.name || email;
        const insertResult = await pool.query(
          `INSERT INTO account_requests (name, email)
           VALUES ($1, $2)
           ON CONFLICT (email) DO NOTHING
           RETURNING created_at`,
          [name, email]
        );
        console.log(`  Auto access request: ${name} <${email}>`);
        if (insertResult.rowCount > 0) {
          const createdAt = insertResult.rows[0].created_at;
          notifyAdminsOfAccessRequest(name, email, createdAt).catch(() => {});
        }
        return verified(null, false, { message: 'not_approved' });
      }
      const user = {};
      updateUserSession(user, tokens);
      await upsertUser(claims);
      const dbUser = await getUser(claims.sub);
      user.privilege_level = dbUser?.privilege_level || 'member';
      verified(null, user);
    } catch (e) {
      if (e.code === 'EMAIL_CONFLICT') {
        return verified(null, false, { message: 'email_conflict' });
      }
      verified(e);
    }
  };

  const registered = new Set();
  const ensureStrategy = (domain) => {
    const name = `replitauth:${domain}`;
    if (registered.has(name)) return;
    passport.use(
      new Strategy(
        {
          name,
          config,
          scope: 'openid email profile offline_access',
          callbackURL: `https://${domain}/api/callback`,
        },
        verify
      )
    );
    registered.add(name);
  };

  passport.serializeUser((user, cb) => cb(null, user));
  passport.deserializeUser((user, cb) => cb(null, user));

  app.get('/api/login', (req, res, next) => {
    ensureStrategy(req.hostname);
    passport.authenticate(`replitauth:${req.hostname}`, {
      prompt: 'login consent',
      scope: ['openid', 'email', 'profile', 'offline_access'],
    })(req, res, next);
  });

  app.get('/api/callback', (req, res, next) => {
    ensureStrategy(req.hostname);
    passport.authenticate(`replitauth:${req.hostname}`, (err, user, info) => {
      if (err) return next(err);
      if (!user) {
        if (info?.message === 'email_conflict') {
          return res.redirect('/?email_conflict=1');
        }
        return res.redirect('/?access_requested=1');
      }
      req.logIn(user, (loginErr) => {
        if (loginErr) return next(loginErr);
        const returnTo = req.session?.returnTo || '/';
        delete req.session?.returnTo;
        res.redirect(returnTo);
      });
    })(req, res, next);
  });

  app.get('/api/logout', (req, res) => {
    req.logout(() => {
      res.redirect(
        client.buildEndSessionUrl(config, {
          client_id: process.env.REPL_ID,
          post_logout_redirect_uri: `${req.protocol}://${req.hostname}`,
        }).href
      );
    });
  });

  // Public: anyone can request access by submitting their name + email.
  app.post('/api/request-access', accessRequestLimiter, async (req, res) => {
    try {
      const name  = (req.body?.name  || '').trim();
      const email = (req.body?.email || '').trim().toLowerCase();
      if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Please provide a valid name and email.' });
      }
      // If already approved, tell the user to just sign in.
      if (await isEmailApproved(email)) {
        return res.json({ ok: true, alreadyApproved: true });
      }
      const insertResult = await pool.query(
        `INSERT INTO account_requests (name, email) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING created_at`,
        [name, email]
      );
      if (insertResult.rowCount === 0) {
        return res.json({ ok: true, alreadyPending: true });
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

  app.get('/api/auth/user', isAuthenticated, async (req, res) => {
    try {
      const user = await getUser(req.user.claims.sub);
      const isAdmin = isAdminEmail(req.user.claims.email);
      res.json(user ? { ...user, isAdmin } : null);
    } catch (e) {
      res.status(500).json({ message: 'Failed to fetch user' });
    }
  });

  // ── Admin: review access requests & manage allow-list ──────────────────────
  app.get('/api/admin/requests', isAuthenticated, requireManagerOrAdmin, async (req, res) => {
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

  app.post('/api/admin/requests/:id/approve', isAuthenticated, requireManagerOrAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `SELECT email FROM account_requests WHERE id = $1`,
        [req.params.id]
      );
      if (r.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Request not found' });
      }
      const email = r.rows[0].email.toLowerCase();
      await client.query(
        `INSERT INTO allowed_emails (email, note) VALUES ($1, 'approved via admin')
         ON CONFLICT (email) DO NOTHING`,
        [email]
      );
      await client.query(
        `UPDATE account_requests SET status = 'approved' WHERE id = $1`,
        [req.params.id]
      );
      await client.query('COMMIT');
      const adminEmail = req.user?.claims?.email;
      await logAdminAction(adminEmail, 'approve_request', email, `Approved access request id=${req.params.id}`);
      res.json({ ok: true, email });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  app.post('/api/admin/requests/:id/reject', isAuthenticated, requireManagerOrAdmin, async (req, res) => {
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
      const adminEmail = req.user?.claims?.email;
      await logAdminAction(adminEmail, 'reject_request', email, `Rejected access request id=${req.params.id}`);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/allowed', isAuthenticated, requireAdmin, async (req, res) => {
    try {
      const body  = req.body || {};
      const email = (body.email || '').trim().toLowerCase();
      const note  = (body.note  || '').trim().slice(0, 200) || null;
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Please provide a valid email address.' });
      }

      // Collect optional HR fields into a metadata object (stored as JSONB).
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

      const r = await pool.query(
        `INSERT INTO allowed_emails (email, note, metadata)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (email) DO NOTHING
         RETURNING email, approved_at, note, metadata`,
        [email, note, metaJson]
      );
      if (r.rowCount === 0) {
        return res.status(409).json({ error: 'This email is already on the approved list.' });
      }
      const adminEmail = req.user?.claims?.email;
      const nameStr = [meta.first_name, meta.last_name].filter(Boolean).join(' ');
      await logAdminAction(adminEmail, 'add_allowed_email', email,
        [nameStr ? `Name: ${nameStr}` : null, note ? `Note: ${note}` : null].filter(Boolean).join('; ') || null);
      notifyNewTeamMember(email).catch(() => {});
      res.json({ ok: true, row: r.rows[0] });
    } catch (e) {
      res.status(500).json({ error: e.message });
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
      // Don't let admins lock themselves out by removing their own admin email.
      if (isAdminEmail(email)) {
        return res.status(400).json({ error: 'Cannot revoke an ADMIN_EMAILS address.' });
      }
      const del = await pool.query(`DELETE FROM allowed_emails WHERE email = $1`, [email]);
      if (del.rowCount > 0) {
        const adminEmail = req.user?.claims?.email;
        await logAdminAction(adminEmail, 'revoke_allowed_email', email, null);
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── User Profile ─────────────────────────────────────────────────────────────
  // Accessible only by the user themselves or an admin.
  app.get('/api/users/:id/profile', isAuthenticated, async (req, res) => {
    const requestingId    = req.user?.claims?.sub;
    const requestingEmail = req.user?.claims?.email;
    const targetId        = req.params.id;
    if (targetId !== requestingId && !isAdminEmail(requestingEmail)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    try {
      const r = await pool.query(
        `SELECT id, email, first_name, last_name, profile_image_url, job_role, privilege_level, created_at,
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

  // Platform users — all registered users, for the visit assignee picker.
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

  // Admin: list all users with profile fields (including HR metadata from allowed_emails).
  app.get('/api/admin/users', isAuthenticated, requireAdmin, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT u.id, u.email, u.first_name, u.last_name, u.profile_image_url,
                u.job_role, u.privilege_level, u.created_at,
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

      // Fetch current user to get their current email
      const curR = await client.query('SELECT email FROM users WHERE id = $1', [req.params.id]);
      if (curR.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'User not found' });
      }
      const currentEmail = (curR.rows[0].email || '').toLowerCase();

      // Build update for users table
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
           RETURNING id, email, first_name, last_name, profile_image_url, job_role, privilege_level`,
          userVals
        );
        if (r.rowCount === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'User not found' });
        }
        updated = r.rows[0];
      } else {
        const r = await client.query(
          `SELECT id, email, first_name, last_name, profile_image_url, job_role, privilege_level
           FROM users WHERE id = $1`,
          [req.params.id]
        );
        if (r.rowCount === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'User not found' });
        }
        updated = r.rows[0];
      }

      // Determine the email key for allowed_emails lookups
      const targetEmail = (updated.email || currentEmail).toLowerCase();

      // If email changed, rename the allowed_emails row
      if (newEmail !== undefined && currentEmail && targetEmail && currentEmail !== targetEmail) {
        await client.query(
          `UPDATE allowed_emails SET email = $1 WHERE email = $2`,
          [targetEmail, currentEmail]
        );
      }

      // Update metadata / note in allowed_emails
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
        // Keep metadata first_name / last_name in sync with users table
        if (first_name !== undefined) { const v = (first_name || '').trim(); if (v) newMeta.first_name = v; else delete newMeta.first_name; }
        if (last_name !== undefined)  { const v = (last_name || '').trim();  if (v) newMeta.last_name = v;  else delete newMeta.last_name; }

        const noteVal = hasNoteUpdate ? (str(note, 200)) : existingNote;

        await client.query(
          `INSERT INTO allowed_emails (email, metadata, note)
           VALUES ($1, $2::jsonb, $3)
           ON CONFLICT (email) DO UPDATE SET metadata = $2::jsonb, note = $3`,
          [targetEmail, JSON.stringify(newMeta), noteVal]
        );

        // Return metadata in response so the frontend can update locally
        updated = { ...updated, metadata: newMeta, note: noteVal };
      } else {
        // Fetch existing metadata/note to include in response
        const metaR = await client.query(
          `SELECT metadata, note FROM allowed_emails WHERE email = $1`, [targetEmail]
        );
        updated = { ...updated, metadata: metaR.rows[0]?.metadata || null, note: metaR.rows[0]?.note ?? null };
      }

      await client.query('COMMIT');

      const adminEmail = req.user?.claims?.email;
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

  // ── Capabilities map — single source of truth for the permissions matrix ──
  // Mirrors the actual middleware rules (isAuthenticated / requireManagerOrAdmin
  // / requireAdmin) so the admin UI always reflects what the server enforces.
  const CAPABILITIES = [
    { group: 'General access' },
    { feat: 'View customers & projects',  desc: 'Browse CRM contacts and project rooms',    levels: ['viewer','member','manager','admin'] },
    { feat: 'View invoices',              desc: 'See QuickBooks invoice list and details',   levels: ['viewer','member','manager','admin'] },
    { feat: 'View calendar & visits',     desc: 'See the site-visit calendar',               levels: ['viewer','member','manager','admin'] },
    { group: 'Member actions' },
    { feat: 'Add notes & comments',       desc: 'Create notes on customer workflow records', levels: ['member','manager','admin'] },
    { feat: 'Edit workflow stages',       desc: 'Move customers through workflow stages',    levels: ['member','manager','admin'] },
    { feat: 'Log & manage site visits',   desc: 'Create, edit, and remove visit records',   levels: ['member','manager','admin'] },
    { feat: 'Send invoices',              desc: 'Trigger invoice emails via QuickBooks',     levels: ['member','manager','admin'] },
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
      /* Read overrides from role_permissions table */
      const rpRows = await pool.query(
        `SELECT permission_key, privilege_level, allowed FROM role_permissions`
      );
      /* Build a lookup: { [feat]: Set of allowed levels } from DB rows */
      const dbMap = {};
      for (const row of rpRows.rows) {
        if (!dbMap[row.permission_key]) dbMap[row.permission_key] = new Set();
        if (row.allowed) dbMap[row.permission_key].add(row.privilege_level);
      }
      /* Also read legacy admin_settings overrides and merge (DB table wins) */
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
      /* Write each (feature, level) combination into role_permissions */
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
      /* Also keep admin_settings in sync for legacy reads */
      await pool.query(
        `INSERT INTO admin_settings (key, value)
         VALUES ('permission_overrides', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
        [JSON.stringify(overrides)]
      );
      const adminEmail = req.user?.claims?.email;
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
      const adminEmail = req.user?.claims?.email;
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
        const adminEmail = req.user?.claims?.email;
        await logAdminAction(adminEmail, 'delete_job_role', null, `Deleted job role "${name}"`);
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Profile photo: upload (self) ─────────────────────────────────────────────
  app.post('/api/users/me/photo', isAuthenticated, async (req, res) => {
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

  // ── Profile photo: serve approved photo ──────────────────────────────────────
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

  // ── Profile photo: admin approval queue ──────────────────────────────────────
  app.get('/api/admin/photo-requests', isAuthenticated, requireManagerOrAdmin, async (req, res) => {
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

  app.post('/api/admin/photo-requests/:id/approve', isAuthenticated, requireManagerOrAdmin, async (req, res) => {
    try {
      const r = await pool.query(
        `UPDATE users
           SET custom_photo = pending_photo, pending_photo = NULL, updated_at = NOW()
         WHERE id = $1 AND pending_photo IS NOT NULL
         RETURNING email`,
        [req.params.id]
      );
      if (r.rowCount === 0) return res.status(404).json({ error: 'No pending photo found.' });
      await logAdminAction(req.user?.claims?.email, 'approve_profile_photo', r.rows[0].email, 'Profile photo approved');
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/photo-requests/:id/reject', isAuthenticated, requireManagerOrAdmin, async (req, res) => {
    try {
      const r = await pool.query(
        `UPDATE users SET pending_photo = NULL, updated_at = NOW()
         WHERE id = $1 RETURNING email`,
        [req.params.id]
      );
      if (r.rowCount === 0) return res.status(404).json({ error: 'User not found.' });
      await logAdminAction(req.user?.claims?.email, 'reject_profile_photo', r.rows[0].email, 'Profile photo rejected');
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Admin audit log ─────────────────────────────────────────────────────────
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
  const user = req.user;
  if (!req.isAuthenticated || !req.isAuthenticated() || !user || !user.expires_at) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  const now = Math.floor(Date.now() / 1000);
  if (now <= user.expires_at) return next();

  const refreshToken = user.refresh_token;
  if (!refreshToken) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const { client, config } = await getOidcConfig();
    const tokens = await client.refreshTokenGrant(config, refreshToken);
    updateUserSession(user, tokens);
    try {
      const dbUser = await getUser(user.claims?.sub);
      if (dbUser) user.privilege_level = dbUser.privilege_level || 'member';
    } catch {}
    return next();
  } catch (e) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
};

module.exports = { installSession, setupAuth, isAuthenticated, requireAdmin, requireManagerOrAdmin, requirePrivilege, isAdminEmail, userIdExists };
