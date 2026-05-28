// hubspot-creds.js — Shared HubSpot credential resolution.
// DB override takes precedence over env-var fallback for each credential.
// Both server.js and design-visits.js import this module; Node's module cache
// ensures the _cache is shared so a single refreshCredentialCache() call
// updates all callers immediately.

const { Pool } = require('pg');

const _pool = new Pool({ connectionString: process.env.DATABASE_URL });

const CRED_MAP = {
  access_token:  { dbKey: 'hubspot_access_token_override',  envKey: 'HUBSPOT_ACCESS_TOKEN' },
  app_id:        { dbKey: 'hubspot_app_id_override',        envKey: 'HUBSPOT_APP_ID' },
  client_secret: { dbKey: 'hubspot_client_secret_override', envKey: 'HUBSPOT_CLIENT_SECRET' },
};

const DB_KEYS = Object.values(CRED_MAP).map(e => e.dbKey);

// In-memory cache; refreshed on startup and after any write/delete.
let _cache = {};

async function refreshCredentialCache() {
  try {
    const r = await _pool.query(
      `SELECT key, value FROM admin_settings WHERE key = ANY($1)`,
      [DB_KEYS]
    );
    const next = {};
    for (const row of r.rows) {
      // Credentials stored as { "v": "<raw value>" }
      const raw = row.value?.v;
      if (typeof raw === 'string' && raw) next[row.key] = raw;
    }
    _cache = next;
  } catch (e) {
    console.warn('[hubspot-creds] Cache refresh failed (falling back to env vars):', e.message);
  }
}

// Returns the active credential value: DB override → env var → null.
function getCredential(name) {
  const entry = CRED_MAP[name];
  if (!entry) return null;
  return _cache[entry.dbKey] || process.env[entry.envKey] || null;
}

// Returns 'db' when a DB override is active, 'env' otherwise.
function getCredentialSource(name) {
  const entry = CRED_MAP[name];
  if (!entry) return 'env';
  return _cache[entry.dbKey] ? 'db' : 'env';
}

// Returns a masked representation, e.g. "••••••••abc1" (last 4 chars visible).
function maskCredential(value) {
  if (!value || typeof value !== 'string') return null;
  if (value.length <= 4) return '••••••••';
  return '••••••••' + value.slice(-4);
}

// Write a credential DB override and refresh the cache.
async function setCredential(name, value) {
  const entry = CRED_MAP[name];
  if (!entry) throw new Error(`Unknown credential name: ${name}`);
  await _pool.query(
    `INSERT INTO admin_settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
    [entry.dbKey, JSON.stringify({ v: value })]
  );
  await refreshCredentialCache();
}

// Remove a credential DB override and refresh the cache.
async function clearCredential(name) {
  const entry = CRED_MAP[name];
  if (!entry) throw new Error(`Unknown credential name: ${name}`);
  await _pool.query(`DELETE FROM admin_settings WHERE key = $1`, [entry.dbKey]);
  await refreshCredentialCache();
}

module.exports = {
  refreshCredentialCache,
  getCredential,
  getCredentialSource,
  maskCredential,
  setCredential,
  clearCredential,
  CRED_MAP,
};
