'use strict';
const { Pool } = require('pg');
const logger = require('./logger');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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
 */
async function assertLeadStatusKey(key) {
  let keys;
  try {
    keys = await _loadKeys();
  } catch (err) {
    logger.warn({ err: err.message }, '[lead-status-guard] Could not load lead_status_config — skipping pre-flight check');
    return;
  }
  if (!keys.has(key)) {
    const err = new Error(`Lead status '${key}' has been removed — contact an admin.`);
    err.code = 'LEAD_STATUS_REMOVED';
    err.statusCode = 422;
    err.removedKey = key;
    throw err;
  }
}

module.exports = { assertLeadStatusKey, invalidateLeadStatusCache };
