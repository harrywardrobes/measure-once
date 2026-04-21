// Replit Auth (OpenID Connect) — JavaScript adaptation for plain Express app.
const session = require('express-session');
const passport = require('passport');
const memoize = require('memoizee');
const connectPg = require('connect-pg-simple');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Ensure required tables exist (sessions + users).
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
  `);
}

async function upsertUser(claims) {
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
      claims.email || null,
      claims.first_name || null,
      claims.last_name || null,
      claims.profile_image_url || null,
    ]
  );
}

async function getUser(id) {
  const r = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
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

  const { client, config } = await getOidcConfig();
  const { Strategy } = await import('openid-client/passport');

  const verify = async (tokens, verified) => {
    const user = {};
    updateUserSession(user, tokens);
    try {
      await upsertUser(tokens.claims());
      verified(null, user);
    } catch (e) {
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
    passport.authenticate(`replitauth:${req.hostname}`, {
      successReturnToOrRedirect: '/',
      failureRedirect: '/api/login',
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

  app.get('/api/auth/user', isAuthenticated, async (req, res) => {
    try {
      const user = await getUser(req.user.claims.sub);
      res.json(user || null);
    } catch (e) {
      res.status(500).json({ message: 'Failed to fetch user' });
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
    return next();
  } catch (e) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
};

module.exports = { installSession, setupAuth, isAuthenticated };
