'use strict';
/**
 * google-maps.js — Google Maps / Places runtime configuration + diagnostics.
 *
 * Owns:
 *  - Persistent settings stored as a single JSON blob in app_settings under the
 *    key `google_maps_settings` (Zod-validated on write).
 *  - Admin endpoints to read/write settings, run a live connection test, and
 *    read usage diagnostics.
 *  - A public config endpoint (`GET /api/google-maps/config`) consumed by the
 *    browser. It exposes the browser API key (Google JS keys are referrer-
 *    restricted public keys) plus the client-relevant runtime flags, but only
 *    when the master switch is on and a key is configured.
 *  - DB-persisted server-side request counters (in `google_maps_usage` table)
 *    and a recent-errors ring buffer (in `app_settings` as JSON). Counters
 *    survive server restarts and are consistent across multiple instances.
 *    Incremented by the server-side Google REST calls used for connection
 *    testing and by the public client usage beacon.
 *
 * The browser API key lives in the GOOGLE_PLACES_API_KEY secret (never stored
 * in the database). The admin UI only ever sees the last 4 characters.
 */

const logger = require('./logger');
const express = require('express');
const { z } = require('zod');
const { Pool } = require('pg');
const { isAuthenticated, requireAdmin } = require('./auth');

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SETTINGS_KEY = 'google_maps_settings';

// ── Defaults ────────────────────────────────────────────────────────────────
const SURFACE_IDS = ['customerInfo', 'designVisit', 'arrangeVisit', 'contactEdit', 'genericVisit'];

const DEFAULT_SETTINGS = {
  enabled: false,
  autocomplete: {
    countries: ['GB'],
    language: 'en-GB',
    types: 'address', // 'address' | 'establishment' | 'geocode'
    debounceMs: 300,
    minChars: 3,
    sessionTokens: true,
  },
  surfaces: {
    customerInfo: { autocomplete: true, mapPreview: true },
    designVisit: { autocomplete: true, mapPreview: true },
    arrangeVisit: { autocomplete: true, mapPreview: true },
    contactEdit: { autocomplete: true, mapPreview: true },
    genericVisit: { autocomplete: true, mapPreview: false },
  },
  mapPreview: {
    enabled: true,
    zoom: 15,
    mapType: 'roadmap', // 'roadmap' | 'satellite' | 'hybrid' | 'terrain'
  },
  fallback: {
    mode: 'silent', // 'silent' | 'notice'
    allowManualEntry: true,
  },
};

// ── Zod schema (settings persisted to app_settings) ──────────────────────────
const surfaceSchema = z.object({
  autocomplete: z.boolean(),
  mapPreview: z.boolean(),
});

const settingsSchema = z.object({
  enabled: z.boolean(),
  autocomplete: z.object({
    countries: z.array(z.string().trim().length(2).toUpperCase()).max(5),
    language: z.string().trim().min(2).max(10),
    types: z.enum(['address', 'establishment', 'geocode']),
    debounceMs: z.number().int().min(0).max(2000),
    minChars: z.number().int().min(1).max(10),
    sessionTokens: z.boolean(),
  }),
  surfaces: z.object({
    customerInfo: surfaceSchema,
    designVisit: surfaceSchema,
    arrangeVisit: surfaceSchema,
    contactEdit: surfaceSchema,
    genericVisit: surfaceSchema,
  }),
  mapPreview: z.object({
    enabled: z.boolean(),
    zoom: z.number().int().min(1).max(21),
    mapType: z.enum(['roadmap', 'satellite', 'hybrid', 'terrain']),
  }),
  fallback: z.object({
    mode: z.enum(['silent', 'notice']),
    allowManualEntry: z.boolean(),
  }),
});

// ── Settings persistence ─────────────────────────────────────────────────────
function deepMerge(base, override) {
  if (override == null || typeof override !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function readSettings() {
  try {
    const { rows } = await pool.query(
      'SELECT value FROM app_settings WHERE key = $1',
      [SETTINGS_KEY],
    );
    if (!rows[0]) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(rows[0].value);
    // Merge over defaults so newly-added fields always have a value.
    return deepMerge(DEFAULT_SETTINGS, parsed);
  } catch (e) {
    logger.error({ err: e.message }, 'google-maps: readSettings failed');
    return { ...DEFAULT_SETTINGS };
  }
}

async function writeSettings(value) {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [SETTINGS_KEY, JSON.stringify(value)],
  );
}

function getApiKey() {
  return process.env.GOOGLE_PLACES_API_KEY || '';
}

function keyMeta() {
  const key = getApiKey();
  return {
    keyPresent: !!key,
    keyLast4: key ? key.slice(-4) : null,
  };
}

// ── Diagnostics (DB-persisted counters + recent-errors ring buffer) ───────────
// Counters are incremented both by the server-side REST wrapper (connection
// tests) and by the public client usage beacon (`POST /api/google-maps/usage`),
// so the figures reflect real autocomplete / place-details / static-map traffic
// performed directly by the browser.
//
// Counters are stored in the `google_maps_usage` table keyed by (period, api)
// where period is either an ISO date (YYYY-MM-DD) for daily counts or an
// ISO year-month (YYYY-MM) for monthly counts. Atomic DB increments make the
// figures correct across multiple server instances. Old rows (>62 days) are
// pruned once on startup (post-migration) and then daily so the table stays small.
//
// The recent-errors ring buffer is stored in app_settings under the key
// `google_maps_diagnostics_errors` as a JSON array. Read-modify-write is
// acceptable here because error entries are informational and low-frequency.
const RING_SIZE = 20;
const ERRORS_KEY = 'google_maps_diagnostics_errors';

function _periodKeys(d = new Date()) {
  const day = d.toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  return { day, month };
}

// Prune usage rows older than 62 days. Non-fatal; only affects table tidiness.
async function _pruneOldUsage() {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 62);
    const cutoffDay = cutoff.toISOString().slice(0, 10);
    await pool.query(
      "DELETE FROM google_maps_usage WHERE period < $1 AND length(period) = 10",
      [cutoffDay],
    );
    const cutoffMonth = cutoff.toISOString().slice(0, 7);
    await pool.query(
      "DELETE FROM google_maps_usage WHERE period < $1 AND length(period) = 7",
      [cutoffMonth],
    );
  } catch (e) {
    logger.warn({ err: e.message }, 'google-maps: _pruneOldUsage failed (non-fatal)');
  }
}

/**
 * Start the usage-pruner schedule.  Call this once after migrations have
 * completed so the first prune never races table creation.  Runs immediately
 * and then every 24 hours thereafter.  Idempotent — subsequent calls are no-ops.
 */
let _pruneScheduled = false;
function schedulePruneOldUsage() {
  if (_pruneScheduled) return;
  _pruneScheduled = true;
  _pruneOldUsage();
  setInterval(_pruneOldUsage, 24 * 60 * 60 * 1000).unref();
}

// Atomically increment counters for both the day and month periods.
// Both upserts run inside a single transaction so the two rows stay in sync
// even if there is a partial failure.
// Fire-and-forget — callers do not await this so hot paths stay fast.
async function recordRequest(api) {
  const { day, month } = _periodKeys();
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO google_maps_usage (period, api, count) VALUES ($1, $2, 1)
       ON CONFLICT (period, api) DO UPDATE SET count = google_maps_usage.count + 1`,
      [day, api],
    );
    await client.query(
      `INSERT INTO google_maps_usage (period, api, count) VALUES ($1, $2, 1)
       ON CONFLICT (period, api) DO UPDATE SET count = google_maps_usage.count + 1`,
      [month, api],
    );
    await client.query('COMMIT');
  } catch (e) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    }
    logger.warn({ err: e.message, api }, 'google-maps: recordRequest DB write failed');
  } finally {
    if (client) client.release();
  }
}

// Prepend a new entry to the errors ring buffer stored in app_settings.
// Fire-and-forget — callers do not await this so hot paths stay fast.
async function recordError(api, info = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    api,
    surface: info.surface || null,
    errorCode: info.errorCode ? String(info.errorCode).slice(0, 60) : null,
    message: info.message ? String(info.message).slice(0, 300) : null,
  };
  try {
    const { rows } = await pool.query(
      'SELECT value FROM app_settings WHERE key = $1',
      [ERRORS_KEY],
    );
    const errors = rows[0] ? JSON.parse(rows[0].value) : [];
    errors.unshift(entry);
    if (errors.length > RING_SIZE) errors.length = RING_SIZE;
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [ERRORS_KEY, JSON.stringify(errors)],
    );
  } catch (e) {
    logger.warn({ err: e.message, api }, 'google-maps: recordError DB write failed');
  }
}

// Read counters for today + this month from the DB, plus the stored error ring.
// `days` controls how many daily rows to return in `history` (7 or 30).
async function diagnosticsSnapshot(days = 7) {
  const { day, month } = _periodKeys();

  const histStart = new Date();
  histStart.setDate(histStart.getDate() - (days - 1));
  const startDay = histStart.toISOString().slice(0, 10);

  const [usageRes, historyRes, errorsRes] = await Promise.all([
    pool.query(
      'SELECT period, api, count FROM google_maps_usage WHERE period = $1 OR period = $2',
      [day, month],
    ),
    pool.query(
      `SELECT period, api, count FROM google_maps_usage
       WHERE period >= $1 AND period <= $2 AND length(period) = 10
       ORDER BY period ASC`,
      [startDay, day],
    ),
    pool.query('SELECT value FROM app_settings WHERE key = $1', [ERRORS_KEY]),
  ]);

  const today = {};
  const monthCounts = {};
  for (const row of usageRes.rows) {
    const n = Number(row.count);
    if (row.period === day) today[row.api] = n;
    else if (row.period === month) monthCounts[row.api] = n;
  }

  // Pivot history rows into { date, counts } objects, one per day in the range.
  const historyMap = {};
  for (const row of historyRes.rows) {
    if (!historyMap[row.period]) historyMap[row.period] = {};
    historyMap[row.period][row.api] = Number(row.count);
  }
  const history = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    history.push({ date: dateStr, counts: historyMap[dateStr] || {} });
  }

  const errors = errorsRes.rows[0] ? JSON.parse(errorsRes.rows[0].value) : [];
  return {
    today,
    month: monthCounts,
    history,
    recentErrors: errors.slice(0, RING_SIZE),
  };
}

// Classify a Google Maps failure so the admin UI can point at the right fix.
// Returns 'disabled' (the API is switched off in Cloud Console), 'restriction'
// (the key is blocked by an HTTP-referrer / IP / API restriction or a denied
// permission), or undefined when we can't tell. Reason codes in the new Places
// API error `details[]` are the most reliable signal, so they win over the
// free-text message; HTTP 401/403 is the last-resort fallback.
function classifyMapsFailure({ httpStatus, googleStatus, errorObj, message } = {}) {
  const reasons = Array.isArray(errorObj?.details)
    ? errorObj.details.map((d) => d && d.reason).filter(Boolean)
    : [];
  if (reasons.includes('SERVICE_DISABLED')) return 'disabled';
  if (reasons.some((r) => /^API_KEY_/.test(r))) return 'restriction';
  const text = `${message || ''} ${googleStatus || ''}`.toUpperCase();
  if (/HAS NOT BEEN USED|IS DISABLED|NOT BEEN USED IN PROJECT|PLEASE (ENABLE|ACTIVATE)|ENABLE IT|ACTIVATE/.test(text)) {
    return 'disabled';
  }
  if (/REFERER|REFERRER|RESTRICT|BLOCKED|NOT AUTHORIZED|FORBIDDEN|PERMISSION_DENIED|REQUEST_DENIED|INVALID.*KEY|KEY.*INVALID/.test(text)) {
    return 'restriction';
  }
  if (httpStatus === 401 || httpStatus === 403) return 'restriction';
  return undefined;
}

// ── Server-side Google REST wrapper (used for connection testing) ────────────
async function callGoogle(api, url, surface = 'admin-test', fetchOpts = {}) {
  recordRequest(api);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { signal: controller.signal, ...fetchOpts });
    const latencyMs = Date.now() - started;
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const body = await res.json();
      // Legacy Google REST APIs report logical errors via a `status` field.
      // The new Places API (New) uses HTTP status codes with a nested `error`
      // object; there is no top-level `status` field on success.
      const status = body.status;
      const ok = res.ok && (status === undefined || status === 'OK' || status === 'ZERO_RESULTS');
      if (!ok) {
        const msg = body.error_message || body.error?.message || status || `HTTP ${res.status}`;
        recordError(api, { surface, errorCode: status || `HTTP_${res.status}`, message: msg });
        const reason = classifyMapsFailure({
          httpStatus: res.status,
          googleStatus: status,
          errorObj: body.error,
          message: msg,
        });
        return { ok: false, latencyMs, status: status || res.status, error: msg, reason, body };
      }
      return { ok: true, latencyMs, status: status || 'OK', body };
    }
    // Non-JSON (e.g. static map image or the Maps JS bootstrap): HTTP status is
    // the only signal available server-side.
    if (!res.ok) {
      recordError(api, { surface, errorCode: `HTTP_${res.status}`, message: `HTTP ${res.status}` });
      const reason = classifyMapsFailure({ httpStatus: res.status });
      return { ok: false, latencyMs, status: res.status, error: `HTTP ${res.status}`, reason };
    }
    return { ok: true, latencyMs, status: res.status };
  } catch (e) {
    const latencyMs = Date.now() - started;
    const msg = e.name === 'AbortError' ? 'Request timed out' : e.message;
    recordError(api, {
      surface,
      errorCode: e.name === 'AbortError' ? 'TIMEOUT' : 'FETCH_ERROR',
      message: msg,
    });
    return { ok: false, latencyMs, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

// Admin: read full settings + key presence metadata.
router.get('/api/admin/google-maps-settings', isAuthenticated, requireAdmin, async (_req, res) => {
  try {
    const settings = await readSettings();
    res.json({ settings, ...keyMeta() });
  } catch (e) {
    logger.error({ err: e.message }, 'GET /api/admin/google-maps-settings error');
    res.status(500).json({ error: 'Could not load Google Maps settings.' });
  }
});

// Admin: persist settings (Zod-validated).
router.put('/api/admin/google-maps-settings', isAuthenticated, requireAdmin, async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body?.settings ?? req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid Google Maps settings.',
      details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  try {
    await writeSettings(parsed.data);
    res.json({ settings: parsed.data, ...keyMeta() });
  } catch (e) {
    logger.error({ err: e.message }, 'PUT /api/admin/google-maps-settings error');
    res.status(500).json({ error: 'Could not save Google Maps settings.' });
  }
});

// Admin: live connection test covering the full client round-trip — Places
// Autocomplete → Place Details — plus Geocoding, Static Maps and the Maps JS
// bootstrap the browser loads.
router.post('/api/admin/google-maps/test-connection', isAuthenticated, requireAdmin, async (_req, res) => {
  const key = getApiKey();
  if (!key) {
    return res.json({
      ok: false,
      keyPresent: false,
      error: 'No GOOGLE_PLACES_API_KEY configured.',
      checks: {},
    });
  }
  const enc = encodeURIComponent;
  // Never leak the raw Google response body back to the client.
  const slim = (c) => ({ ok: c.ok, latencyMs: c.latencyMs, status: c.status, error: c.error, reason: c.reason });
  const checks = {};

  // 1) Places Autocomplete (New) — drives the address search box. Keep a
  //    placeId from the first suggestion so we can exercise the details lookup.
  const ac = await callGoogle(
    'autocomplete',
    'https://places.googleapis.com/v1/places:autocomplete',
    'admin-test',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
      },
      body: JSON.stringify({
        input: '10 Downing Street',
        includedRegionCodes: ['gb'],
      }),
    },
  );
  checks.autocomplete = slim(ac);
  const placeId =
    ac.body && Array.isArray(ac.body.suggestions)
      ? ac.body.suggestions[0]?.placePrediction?.placeId
      : null;

  // 2) Place Details (New) — completes the autocomplete → details round-trip
  //    the client performs when a prediction is chosen.
  if (placeId) {
    const det = await callGoogle(
      'details',
      `https://places.googleapis.com/v1/places/${enc(placeId)}?fields=addressComponents`,
      'admin-test',
      { headers: { 'X-Goog-Api-Key': key } },
    );
    checks.placeDetails = slim(det);
  } else {
    checks.placeDetails = {
      ok: false,
      error: ac.ok ? 'No prediction returned to look up' : 'Skipped — autocomplete failed',
    };
  }

  // 3) Geocoding — backs static map centering.
  const geo = await callGoogle(
    'geocode',
    `https://maps.googleapis.com/maps/api/geocode/json?address=${enc('10 Downing Street, London')}&key=${enc(key)}`,
  );
  checks.geocode = slim(geo);

  // 4) Static Maps — the address preview thumbnail.
  const sm = await callGoogle(
    'staticmap',
    `https://maps.googleapis.com/maps/api/staticmap?center=${enc('London')}&zoom=12&size=1x1&key=${enc(key)}`,
  );
  checks.staticmap = slim(sm);

  // 5) Maps JavaScript API — the library the browser injects for autocomplete.
  //    Server-side we can only confirm the bootstrap is reachable and not
  //    blocked; key/referer restrictions surface fully only in the browser.
  //    Uses v=weekly&loading=async to match the new client loader.
  const js = await callGoogle(
    'mapsjs',
    `https://maps.googleapis.com/maps/api/js?v=weekly&loading=async&key=${enc(key)}`,
  );
  checks.mapsJs = slim(js);

  const ok = Object.values(checks).every((c) => c.ok);
  res.json({ ok, keyPresent: true, keyLast4: key.slice(-4), checks });
});

// Admin: usage diagnostics (DB-persisted counters + recent errors).
// Accepts ?range=7d (default) or ?range=30d to control the history window.
router.get('/api/admin/google-maps/diagnostics', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const days = req.query.range === '30d' ? 30 : 7;
    res.json(await diagnosticsSnapshot(days));
  } catch (e) {
    logger.error({ err: e.message }, 'GET /api/admin/google-maps/diagnostics error');
    res.status(500).json({ error: 'Could not load diagnostics.' });
  }
});

// Public: client runtime config. Exposes the browser key ONLY when the master
// switch is on and a key is configured. Reachable without auth because the
// public customer-info form needs it.
router.get('/api/google-maps/config', async (_req, res) => {
  try {
    const settings = await readSettings();
    const key = getApiKey();
    const active = !!settings.enabled && !!key;
    res.set('Cache-Control', 'no-store');
    res.json({
      enabled: active,
      apiKey: active ? key : null,
      autocomplete: settings.autocomplete,
      surfaces: settings.surfaces,
      mapPreview: settings.mapPreview,
      fallback: settings.fallback,
    });
  } catch (e) {
    logger.error({ err: e.message }, 'GET /api/google-maps/config error');
    res.json({
      enabled: false,
      apiKey: null,
      autocomplete: DEFAULT_SETTINGS.autocomplete,
      surfaces: DEFAULT_SETTINGS.surfaces,
      mapPreview: DEFAULT_SETTINGS.mapPreview,
      fallback: DEFAULT_SETTINGS.fallback,
    });
  }
});

// Public: lightweight client usage beacon. Autocomplete, place-details and
// static-map requests are made directly by the browser against Google, so the
// server never sees them otherwise. The client posts a tiny record here so the
// usage diagnostics reflect real traffic. Counter writes go to the DB
// (fire-and-forget), strictly validated, and naturally bounded by the counters /
// ring buffer — safe to expose on the unauthenticated customer-info surface.
const usageSchema = z.object({
  api: z.enum(['autocomplete', 'details', 'staticmap']),
  surface: z.enum(['customerInfo', 'designVisit', 'arrangeVisit', 'contactEdit', 'genericVisit']).optional(),
  ok: z.boolean().optional().default(true),
  errorCode: z.string().trim().max(60).optional(),
});

router.post('/api/google-maps/usage', (req, res) => {
  const parsed = usageSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(204).end();
  const { api, surface, ok, errorCode } = parsed.data;
  recordRequest(api);
  if (!ok) {
    recordError(api, { surface: surface || null, errorCode: errorCode || 'CLIENT_ERROR' });
  }
  res.status(204).end();
});

module.exports = {
  router,
  DEFAULT_SETTINGS,
  SURFACE_IDS,
  readSettings,
  schedulePruneOldUsage,
};
