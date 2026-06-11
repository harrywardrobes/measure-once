'use strict';
const { Pool } = require('pg');
const logger = require('./logger');

let pool = new Pool({ connectionString: process.env.DATABASE_URL });

let _cache = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 60_000;

async function _loadKeys() {
  const now = Date.now();
  if (_cache && (now - _cacheAt) < CACHE_TTL_MS) return _cache;
  const { rows } = await pool.query(
    `SELECT key FROM lead_status_config WHERE is_null_row IS NOT TRUE`
  );
  _cache = new Set(rows.map(r => r.key));
  _cacheAt = now;
  return _cache;
}

/**
 * Immediately clears the in-memory lead-status key cache.
 * Call this after any admin mutation to lead_status_config so the guard
 * re-reads from the DB on the very next request rather than waiting for
 * the 60-second TTL to expire.
 */
function invalidateLeadStatusCache() {
  _cache = null;
  _cacheAt = 0;
}

/**
 * Asserts that `key` exists in lead_status_config (results cached for 60 s).
 * Throws an error with `err.code = 'LEAD_STATUS_REMOVED'` and `err.statusCode = 422`
 * if the key is absent, so callers can return a structured error before touching HubSpot.
 *
 * DB-unreachable behaviour (intentional fail-safe):
 *
 *   • Stale cache present — the previous successful read is used as a best-effort
 *     check and a warning is logged.  This avoids blocking all deal-acceptance on
 *     a transient DB hiccup when the cache is at most 60 s old.
 *
 *   • No cache at all (first request after boot or after invalidateLeadStatusCache)
 *     — throws LEAD_STATUS_DB_UNAVAILABLE / 503 so the caller returns a structured
 *     error rather than silently proceeding without any guard.
 */
async function assertLeadStatusKey(key) {
  let keys;
  try {
    keys = await _loadKeys();
  } catch (err) {
    if (_cache) {
      logger.warn(
        { err: err.message, staleAgeMs: Date.now() - _cacheAt },
        '[lead-status-guard] DB unreachable — using stale lead-status cache for pre-flight check',
      );
      keys = _cache;
    } else {
      logger.error(
        { err: err.message },
        '[lead-status-guard] DB unreachable and no cached lead-status keys — rejecting request',
      );
      const guardErr = new Error(
        'Lead status check unavailable — database unreachable. Please try again shortly.',
      );
      guardErr.code = 'LEAD_STATUS_DB_UNAVAILABLE';
      guardErr.statusCode = 503;
      throw guardErr;
    }
  }
  if (!keys.has(key)) {
    const err = new Error(`Lead status '${key}' has been removed — contact an admin.`);
    err.code = 'LEAD_STATUS_REMOVED';
    err.statusCode = 422;
    err.removedKey = key;
    throw err;
  }
}

/**
 * Test-only hook — replaces the internal pg pool with an arbitrary object.
 * This allows tests to inject a broken pool after warming the cache in order
 * to exercise the stale-cache fallback path (probe C).
 * Never call this in production code.
 */
function _setPool(p) {
  pool = p;
}

/**
 * Test-only hook — ages the cache timestamp to zero so the next call to
 * _loadKeys() will attempt a DB re-fetch even though _cache is still
 * populated.  Combined with _setPool(brokenPool) this lets tests exercise
 * the stale-cache fallback branch of assertLeadStatusKey without waiting
 * for the 60-second TTL.
 * Never call this in production code.
 */
function _forceStaleForTest() {
  _cacheAt = 0;
}

module.exports = { assertLeadStatusKey, invalidateLeadStatusCache, _setPool, _forceStaleForTest };
