require('dotenv').config();
const express = require('express');
const axios = require('axios').create({ timeout: 10000 });
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const { installSession, setupAuth, isAuthenticated, requireAdmin, requireManagerOrAdmin, requirePrivilege, requireOnboardingComplete, userIdExists, isAdminEmail, pool, logAdminAction, getReqPrivilege, scheduleConflictDigest } = require('./auth');
const {
  hubspotMutationLimiter,
  gmailSendLimiter,
  calendarEventLimiter,
  personalTaskCreateLimiter,
  tradesCreateLimiter,
  prefsWriteLimiter,
  whatsappSendLimiter,
} = require('./rate-limiters');
const qbRoutes = require('./quickbooks');
const { router: visitsRouter, ensureVisitsTable } = require('./visits');
const { router: designVisitsRouter, ensureDesignVisitTables } = require('./design-visits');
const { installDbEditorRoutes, ensureDbEditorAuditTable } = require('./db-editor');

const app = express();
const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';

function validateHsObjectId(value, fieldName) {
  if (value === undefined || value === null) return null;
  const id = String(value).trim();
  if (!/^\d+$/.test(id)) {
    const err = new Error(`${fieldName} must be a numeric ID`);
    err.status = 400;
    throw err;
  }
  return id;
}

// ── Mockup sandbox proxy ───────────────────────────────────────────────────────
const http = require('http');
const MOCKUP_PORT = 23636;
app.use('/__mockup', (req, res) => {
  const target = '/__mockup' + (req.url || '/');
  const options = {
    hostname: 'localhost',
    port: MOCKUP_PORT,
    path: target,
    method: req.method,
    headers: { ...req.headers, host: `localhost:${MOCKUP_PORT}` },
  };
  const proxy = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });
  proxy.on('error', () => res.status(502).send('Mockup sandbox not running'));
  req.pipe(proxy, { end: true });
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '25mb' }));

// Clean URLs for each page (no .html extension). Must precede express.static so the
// extensionless paths win over any default static-index handling.
const PAGE_ROUTES = {
  '/':          'index.html',
  '/customers': 'customers.html',
  '/calendar':  'calendar.html',
  '/profile':   'profile.html',
};

// /trades, /admin, /sales, /projects, /invoices are protected — handled below after auth middleware is set up
for (const [route, file] of Object.entries(PAGE_ROUTES)) {
  app.get(route, (_req, res) => res.sendFile(path.join(__dirname, 'public', file)));
}

// Dynamic customer detail page
app.get('/customers/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'customer-detail.html'));
});

// Canonicalise the admin URL: /admin.html → /admin so the protected route
// below is the single entry point (and static can't serve the page directly).
app.get('/admin.html', (req, res) => res.redirect(301, '/admin'));

// Redirect .html variants of privilege-restricted pages to their clean URL
// so the single protected route below is the only entry point.
app.get('/sales.html',    (req, res) => res.redirect(301, '/sales'));
app.get('/survey.html',   (req, res) => res.redirect(301, '/survey'));
app.get('/projects.html', (req, res) => res.redirect(301, '/projects'));
app.get('/invoices.html', (req, res) => res.redirect(301, '/invoices'));

// Public design-visit sign-off page (no auth required — token-gated)
app.get('/design-visit/sign-off', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'design-visit-signoff.html')));

// Public auth pages (no Replit/OIDC anymore — email + password handled in-app).
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/set-password', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'set-password.html')));
app.get('/onboarding', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'onboarding.html')));

// Hashed React chunks and assets are content-addressed (Vite appends a hash
// to every filename), so they can be cached indefinitely by the browser.
// These mounts must precede the general express.static below so that the
// long-lived headers are applied before the default (no-cache) fallback.
// main.js uses a stable filename and is intentionally excluded — it stays
// under the general static middleware so browsers always re-validate it.
app.use(
  '/react/chunks',
  express.static(path.join(__dirname, 'public', 'react', 'chunks'), {
    maxAge: '1y',
    immutable: true,
  })
);
app.use(
  '/react/assets',
  express.static(path.join(__dirname, 'public', 'react', 'assets'), {
    maxAge: '1y',
    immutable: true,
  })
);

app.use(express.static(path.join(__dirname, 'public')));
installSession(app);

// ── HubSpot ───────────────────────────────────────────────────────────────────
const HS = process.env.HUBSPOT_API_URL || 'https://api.hubapi.com';
const hsHeaders = () => ({
  Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
  'Content-Type': 'application/json'
});

// Shared HubSpot search retry helper. Retries on 429 (honouring Retry-After
// when present) and transient 5xx / network errors using bounded exponential
// backoff so a brief HubSpot hiccup doesn't surface as an error to the UI.
// Used by /api/contacts-lead-status-counts and /api/open-leads — the two
// search-API fan-outs that have been hitting per-second rate limits.
async function hubspotSearchWithRetry(body, { maxAttempts = 4, baseDelayMs = 300, maxDelayMs = 4000 } = {}) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const isTransient = err => {
    const s = err.response?.status;
    if (s === 429) return true;
    if (s && s >= 500 && s < 600) return true;
    if (!err.response) return true; // network / timeout
    return false;
  };
  const retryAfterMs = (err) => {
    const h = err.response?.headers?.['retry-after'];
    if (!h) return null;
    const asInt = parseInt(h, 10);
    if (!Number.isNaN(asInt) && asInt >= 0) return Math.min(asInt * 1000, maxDelayMs);
    const asDate = Date.parse(h);
    if (!Number.isNaN(asDate)) {
      const ms = asDate - Date.now();
      return ms > 0 ? Math.min(ms, maxDelayMs) : 0;
    }
    return null;
  };

  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await axios.post(
        `${HS}/crm/v3/objects/contacts/search`,
        body,
        { headers: hsHeaders(), timeout: 15000 }
      );
    } catch (err) {
      lastErr = err;
      if (!isTransient(err)) throw err;
      if (attempt === maxAttempts - 1) break;
      const hinted = retryAfterMs(err);
      const backoff = hinted != null
        ? hinted
        : Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      if (process.env.DEBUG_HUBSPOT) {
        console.warn('[hubspot-retry] attempt=%d status=%s backoff=%dms',
          attempt + 1, err.response?.status || 'network', backoff);
      }
      await sleep(backoff);
    }
  }
  console.error('[hubspot-retry] all %d attempts exhausted endpoint=POST /crm/v3/objects/contacts/search finalStatus=%s',
    maxAttempts, lastErr?.response?.status || 'network');
  throw lastErr;
}

// General HubSpot request retry helper. Wraps any HubSpot axios call with the
// same bounded exponential backoff + Retry-After honouring used by
// hubspotSearchWithRetry. Logs at console.error level when all attempts are
// exhausted so non-search endpoint failures are visible in server logs.
// method: 'get' | 'post' | 'patch' | 'put' | 'delete'
// data:   request body (null / undefined for GET and DELETE).
async function hubspotRequestWithRetry(method, url, data, { timeout = 15000, maxAttempts = 4, baseDelayMs = 300, maxDelayMs = 4000 } = {}) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const isTransient = err => {
    const s = err.response?.status;
    if (s === 429) return true;
    if (s && s >= 500 && s < 600) return true;
    if (!err.response) return true; // network / timeout
    return false;
  };
  const retryAfterMs = (err) => {
    const h = err.response?.headers?.['retry-after'];
    if (!h) return null;
    const asInt = parseInt(h, 10);
    if (!Number.isNaN(asInt) && asInt >= 0) return Math.min(asInt * 1000, maxDelayMs);
    const asDate = Date.parse(h);
    if (!Number.isNaN(asDate)) {
      const ms = asDate - Date.now();
      return ms > 0 ? Math.min(ms, maxDelayMs) : 0;
    }
    return null;
  };

  const cfg = { headers: hsHeaders(), timeout };
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (method === 'get' || method === 'delete') {
        return await axios[method](url, cfg);
      }
      return await axios[method](url, data, cfg);
    } catch (err) {
      lastErr = err;
      if (!isTransient(err)) throw err;
      if (attempt === maxAttempts - 1) break;
      const hinted = retryAfterMs(err);
      const backoff = hinted != null
        ? hinted
        : Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      if (process.env.DEBUG_HUBSPOT) {
        console.warn('[hubspot-retry] attempt=%d status=%s backoff=%dms endpoint=%s %s',
          attempt + 1, err.response?.status || 'network', backoff, method.toUpperCase(), url);
      }
      await sleep(backoff);
    }
  }
  const shortUrl = url.startsWith(HS) ? url.slice(HS.length) : url;
  console.error('[hubspot-retry] all %d attempts exhausted endpoint=%s %s finalStatus=%s',
    maxAttempts, method.toUpperCase(), shortUrl, lastErr?.response?.status || 'network');
  throw lastErr;
}

// Guard: return a clear error if no token is set
function requireHubspotToken(req, res, next) {
  if (!process.env.HUBSPOT_ACCESS_TOKEN) {
    return res.status(503).json({
      error: 'HUBSPOT_ACCESS_TOKEN is not set. Add it to your .env file and restart the server.'
    });
  }
  next();
}
// QuickBooks routes (auth enforced inside the router)
app.use(qbRoutes);
app.use(visitsRouter);
app.use(designVisitsRouter);

// Auth gate for all /api/* routes (whitelist endpoints reachable while
// signed-out: login, account requests, the public set-password flow).
const AUTH_WHITELIST = new Set([
  '/login', '/auth/user', '/request-access', '/check-email',
  '/set-password', '/set-password/validate',
  '/forgot-password', '/turnstile-config',
  // Public design-visit sign-off (token-gated, not session-gated)
]);
// Endpoints a logged-in user can still reach while in `more_info_required`
// (so they can read their session, complete onboarding, or sign back out).
const ONBOARDING_ALLOWED = new Set([
  '/auth/user', '/logout', '/onboarding/complete', '/onboarding/me', '/job-roles',
]);
app.use('/api', (req, res, next) => {
  if (AUTH_WHITELIST.has(req.path)) return next();
  // Public design-visit sign-off routes (/api/design-visits/sign-off/:token)
  if (/^\/design-visits\/sign-off\/[^/]+$/.test(req.path)) return next();
  return isAuthenticated(req, res, next);
});
app.use('/api', (req, res, next) => {
  if (!req.user || ONBOARDING_ALLOWED.has(req.path)) return next();
  return requireOnboardingComplete(req, res, next);
});

app.use('/api/pipeline', requireHubspotToken);
app.use('/api/account', requireHubspotToken);
app.use('/api/open-leads', requireHubspotToken);
app.use('/api/contacts-all', requireHubspotToken);
app.use('/api/workflow-stages', requireHubspotToken);
app.use('/api/localdata', requireHubspotToken);
// NOTE: /api/contacts, /api/deals, and /api/tasks are intentionally NOT
// covered by a blanket requireHubspotToken mount.  Those prefixes contain
// routes gated by requirePrivilege / requireManagerOrAdmin, and Express runs
// app.use() middleware before the route-specific guards.  A blanket mount
// would therefore return 503 (no token) before the privilege check fires,
// making it impossible to verify that low-privilege actors are correctly
// denied.  requireHubspotToken is instead placed inline in every individual
// route handler for those prefixes, always *after* the privilege middleware.

// ── HubSpot Custom Properties (workflow data stored on contacts) ──────────────
// Creates measure_once_rooms and measure_once_notes properties if they don't exist
async function ensureHubSpotProperties() {
  const props = [
    { name: 'measure_once_rooms',    label: 'Measure Once Rooms',    fieldType: 'textarea', type: 'string', description: 'JSON workflow rooms data (Measure Once CRM)' },
    { name: 'measure_once_notes',    label: 'Measure Once Notes',    fieldType: 'textarea', type: 'string', description: 'Customer notes (Measure Once CRM)' },
    { name: 'measure_once_stage',    label: 'Measure Once Stage',    fieldType: 'text',     type: 'string', description: 'Current workflow stage (Measure Once CRM)' },
    { name: 'measure_once_substage', label: 'Measure Once Substage', fieldType: 'text',     type: 'string', description: 'Current workflow substage/task (Measure Once CRM)' },
    { name: 'customer_number',       label: 'Customer Number',       fieldType: 'text',     type: 'string', description: 'Unique customer number (e.g. LL01234) — Measure Once CRM' },
  ];
  for (const prop of props) {
    try {
      await axios.post(
        `${HS}/crm/v3/properties/contacts`,
        { ...prop, groupName: 'contactinformation' },
        { headers: hsHeaders() }
      );
      console.log(`  Created HubSpot property: ${prop.name}`);
    } catch (e) {
      if (e.response?.status !== 409) {
        console.warn(`  Could not create property ${prop.name}: ${e.response?.data?.message || e.message}`);
      }
    }
  }
}

// Read one contact's workflow data from HubSpot custom properties
app.get('/api/contacts/:id/localdata', requireHubspotToken, async (req, res) => {
  const contactId = req.params.id;
  if (typeof contactId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(contactId)) {
    return res.status(400).json({ error: 'Invalid contact id.' });
  }

  try {
    const r = await axios.get(
      `${HS}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`,
      { headers: hsHeaders(), params: { properties: 'measure_once_rooms,measure_once_notes' } }
    );
    const roomsJson = r.data.properties?.measure_once_rooms;
    const notes     = r.data.properties?.measure_once_notes || '';
    if (!roomsJson) return res.json(null);
    const rooms = JSON.parse(roomsJson);
    return res.json({ rooms, notes });
  } catch { return res.json(null); }
});

// Save one contact's workflow data to HubSpot custom properties
app.post('/api/contacts/:id/localdata', isAuthenticated, requirePrivilege('member'), requireHubspotToken, hubspotMutationLimiter, async (req, res) => {
  try {
    const { rooms, notes, stage, substage } = req.body;
    const contactId = req.params.id;
    if (!/^[A-Za-z0-9_-]+$/.test(contactId)) {
      return res.status(400).json({ error: 'Invalid contact id' });
    }

    // Stage-derivation guard (defense-in-depth): a customer's workflow
    // stage is derived from lead status and sub-status / task logic only —
    // never set manually. Silently revert any stageKey change on an
    // existing room unless it is accompanied by a completedStatuses or
    // statusId change on the same room (the markers for the auto-advance /
    // auto-revert paths in setStatusChecked and the HubSpot lead-status
    // sync in syncRoomFromHubSpot). Room creation may still set an
    // initial stageKey.
    if (Array.isArray(rooms)) {
      try {
        let existingRoomsForStageGuard = [];
        try {
          const cur = await axios.get(
            `${HS}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`,
            { headers: hsHeaders(), params: { properties: 'measure_once_rooms' } }
          );
          const json = cur.data?.properties?.measure_once_rooms;
          if (json) existingRoomsForStageGuard = JSON.parse(json) || [];
        } catch { /* treat as no prior rooms */ }

        const sameCompletedForGuard = (a, b) => {
          const norm = c => {
            const out = {};
            const src = c || {};
            for (const k of Object.keys(src)) out[k] = [...(src[k] || [])].map(String).sort();
            return out;
          };
          const na = norm(a), nb = norm(b);
          const ka = Object.keys(na).sort(), kb = Object.keys(nb).sort();
          if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
          return ka.every(k => {
            const va = na[k], vb = nb[k] || [];
            if (va.length !== vb.length) return false;
            return va.every((v, i) => v === vb[i]);
          });
        };

        const pairLen = Math.min(rooms.length, existingRoomsForStageGuard.length);
        for (let i = 0; i < pairLen; i++) {
          const incoming = rooms[i] || {};
          const existing = existingRoomsForStageGuard[i] || {};
          const incomingStage = incoming.stageKey || '';
          const existingStage = existing.stageKey || '';
          if (incomingStage === existingStage) continue;
          const statusChanged    = (incoming.statusId || '') !== (existing.statusId || '');
          const completedChanged = !sameCompletedForGuard(incoming.completedStatuses, existing.completedStatuses);
          if (!statusChanged && !completedChanged) {
            // Standalone stageKey rewrite — silently revert, and drop the
            // stage-date stamp that the client may have added for the
            // rejected destination stage.
            incoming.stageKey = existingStage;
            if (incoming.stageDates && existing.stageDates && incoming.stageDates[incomingStage]
                && !existing.stageDates[incomingStage]) {
              delete incoming.stageDates[incomingStage];
            }
          }
        }
      } catch { /* on guard failure, fall through to existing privilege gate */ }
    }

    // Pipeline-field gate: only managers/admins may change stageKey or
    // completedStatuses on any room. Fetch current rooms to detect mutations
    // and reject the whole save with a clear 403 if a member/viewer attempts
    // to change pipeline state. Other fields (notes, comments, fitters, etc.)
    // remain editable at the route's base member privilege.
    if (Array.isArray(rooms)) {
      try {
        const userId = req.user?.claims?.sub;
        const ur = await pool.query(`SELECT privilege_level FROM users WHERE id = $1`, [userId]);
        const level = ur.rows[0]?.privilege_level || 'member';
        const isManagerOrAdmin = (level === 'manager' || level === 'admin');
        if (!isManagerOrAdmin) {
          let existingRooms = [];
          try {
            const cur = await axios.get(
              `${HS}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`,
              { headers: hsHeaders(), params: { properties: 'measure_once_rooms' } }
            );
            const json = cur.data?.properties?.measure_once_rooms;
            if (json) existingRooms = JSON.parse(json) || [];
          } catch { /* treat as no prior rooms */ }

          const normCompleted = c => {
            const out = {};
            const src = c || {};
            for (const k of Object.keys(src)) {
              out[k] = [...(src[k] || [])].map(String).sort();
            }
            return out;
          };
          const sameCompleted = (a, b) => {
            const na = normCompleted(a), nb = normCompleted(b);
            const ka = Object.keys(na).sort(), kb = Object.keys(nb).sort();
            if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
            return ka.every(k => {
              const va = na[k], vb = nb[k] || [];
              if (va.length !== vb.length) return false;
              return va.every((v, i) => v === vb[i]);
            });
          };

          // Only treat changes to pipeline fields on rooms that exist on BOTH
          // sides as pipeline mutations. Room add/remove (and pure reorder of
          // non-pipeline fields) remains a member-allowed CRUD operation.
          let pipelineChanged = false;
          const pairLen = Math.min(rooms.length, existingRooms.length);
          for (let i = 0; i < pairLen; i++) {
            const a = rooms[i] || {};
            const b = existingRooms[i] || {};
            if ((a.stageKey || '') !== (b.stageKey || '')) { pipelineChanged = true; break; }
            if ((a.statusId || '') !== (b.statusId || '')) { pipelineChanged = true; break; }
            if (!sameCompleted(a.completedStatuses, b.completedStatuses)) { pipelineChanged = true; break; }
          }
          if (pipelineChanged) {
            return res.status(403).json({
              message: 'Manager or admin privilege required to change stage, substage, or completed tasks.',
              code: 'PIPELINE_EDIT_FORBIDDEN',
            });
          }
        }
      } catch (gateErr) {
        return res.status(500).json({ error: 'Authorization check failed' });
      }
    }

    try {
      await hubspotRequestWithRetry('patch',
        `${HS}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`,
        {
          properties: {
            measure_once_rooms:    JSON.stringify(rooms),
            measure_once_notes:    notes    || '',
            measure_once_stage:    stage    || '',
            measure_once_substage: substage || '',
          }
        }
      );
    } catch (hsErr) {
      console.error('[localdata] HubSpot PATCH failed after retries (non-fatal):', hsErr.message);
    }
    bustSharedCache();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Unexpected error.' });
  }
});

// Shared full-contact scan — fetches all properties needed by both
// /api/localdata/all and /api/contacts-all in a single paginated crawl.
// Cache: one shared result, refreshed at most every 5 minutes.
// Concurrency guard: if a scan is already in progress, new requests wait for
// the same promise rather than each launching an independent HubSpot crawl.
// Stale fallback: `_allContactsLastGood` survives TTL expiry so a failed
// refresh can still serve the last-known list (up to 1 h old) instead of
// returning a hard 502 to callers.
const ALL_CONTACTS_CACHE_TTL_MS       = 300_000;          // 5 minutes
// Test suites can set ALL_CONTACTS_STALE_MAX_MS_OVERRIDE (milliseconds) to
// exercise the stale-cap-expired → 502 path without waiting a real hour.
const ALL_CONTACTS_STALE_MAX_MS       = process.env.ALL_CONTACTS_STALE_MAX_MS_OVERRIDE
  ? parseInt(process.env.ALL_CONTACTS_STALE_MAX_MS_OVERRIDE, 10)
  : 60 * 60 * 1_000;  // 1 h hard cap on staleness
let _allContactsCache    = null;  // { contacts: [...], fetchedAt } — used while fresh
let _allContactsLastGood = null;  // { contacts: [...], fetchedAt } — survives invalidation
let _allContactsInflight = null;  // Promise while a scan is running

const ALL_CONTACTS_PROPERTIES = [
  'firstname', 'lastname', 'email', 'phone', 'mobilephone', 'hs_lead_status', 'hw_lead_substatus',
  'address', 'city', 'zip', 'customer_number', 'createdate', 'closedate', 'lastmodifieddate',
  'measure_once_rooms',
  ...(process.env.NODE_ENV !== 'production' ? ['hw_test_user'] : []),
];

async function fetchAllContactsShared() {
  const allResults = [];
  let after;
  do {
    const body = {
      properties: ALL_CONTACTS_PROPERTIES,
      sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
      limit: 100
    };
    if (after) body.after = after;
    const r = await hubspotSearchWithRetry(body);
    allResults.push(...(r.data.results || []));
    after = r.data.paging?.next?.after;
  } while (after);
  return allResults;
}

// Returns { contacts, stale } where stale=true means HubSpot was unreachable
// and the last-good snapshot is being returned instead.
async function getSharedContactsCache() {
  if (_allContactsCache && Date.now() - _allContactsCache.fetchedAt < ALL_CONTACTS_CACHE_TTL_MS) {
    return { contacts: _allContactsCache.contacts, stale: false };
  }

  if (!_allContactsInflight) {
    _allContactsInflight = (async () => {
      try {
        const contacts = await fetchAllContactsShared();
        const entry = { contacts, fetchedAt: Date.now() };
        _allContactsCache    = entry;
        _allContactsLastGood = entry;
        return { ok: true, contacts };
      } catch (err) {
        return { ok: false, err };
      } finally {
        setImmediate(() => { _allContactsInflight = null; });
      }
    })();
  }

  const outcome = await _allContactsInflight;

  if (outcome.ok) {
    return { contacts: outcome.contacts, stale: false };
  }

  // Refresh failed — serve last-good snapshot regardless of age so callers
  // always get data (or an empty list) rather than a thrown error.
  // The staleness cap is intentionally not enforced here: stale-but-present
  // data is always better than a hard 502 reaching the client.
  if (_allContactsLastGood) {
    if (process.env.DEBUG_HUBSPOT) {
      const status = outcome.err?.response?.status;
      console.warn('[contacts-all] HubSpot fetch failed (status=%s); serving stale contacts age=%dms',
        status || 'network', Date.now() - _allContactsLastGood.fetchedAt);
    }
    return { contacts: _allContactsLastGood.contacts, stale: true };
  }

  // No snapshot at all (cold start with HubSpot unavailable).  Return an
  // empty list with unavailable=true so the route can respond with 502 and
  // the bootstrap error path dispatches sales-board-bootstrap-failed.
  // This is preferable to throwing from this function because the outer
  // route already handles the 502 path cleanly.
  if (process.env.DEBUG_HUBSPOT) {
    const status = outcome.err?.response?.status;
    console.warn('[contacts-all] HubSpot fetch failed (status=%s) and no stale snapshot available',
      status || 'network');
  }
  return { contacts: [], stale: true, unavailable: true, _err: outcome.err };
}

// Invalidate the shared contacts cache so the next request triggers a fresh
// HubSpot scan. Call this from every mutation route that changes contact data.
// `_allContactsLastGood` is intentionally preserved so a failed refetch can
// still serve the prior snapshot instead of returning a 502.
function bustSharedCache() {
  _allContactsCache = null;
}

// Assign (or unassign) a fitter to a specific room on a contact (manager or admin only)
app.patch('/api/contacts/:id/rooms/:roomIdx/fitter', isAuthenticated, requireManagerOrAdmin, requireHubspotToken, async (req, res) => {
  const contactId = req.params.id;
  const roomIdx   = parseInt(req.params.roomIdx, 10);
  const { fitterId } = req.body; // string id or null/'' to unassign

  if (!/^[A-Za-z0-9_-]+$/.test(contactId)) {
    return res.status(400).json({ error: 'Invalid contact id' });
  }
  if (isNaN(roomIdx) || roomIdx < 0) {
    return res.status(400).json({ error: 'Invalid room index' });
  }

  try {
    const r = await axios.get(
      `${HS}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`,
      { headers: hsHeaders(), params: { properties: 'measure_once_rooms' } }
    );
    const roomsJson = r.data.properties?.measure_once_rooms;
    if (!roomsJson) return res.status(404).json({ error: 'No rooms found' });
    const rooms = JSON.parse(roomsJson);
    if (!Array.isArray(rooms) || roomIdx >= rooms.length) {
      return res.status(404).json({ error: 'Room not found' });
    }

    if (fitterId) {
      const exists = await userIdExists(fitterId);
      if (!exists) return res.status(400).json({ error: 'Fitter user not found' });
      rooms[roomIdx].assignedFitterId = fitterId;
    } else {
      delete rooms[roomIdx].assignedFitterId;
    }

    let syncFailed = false;
    try {
      await hubspotRequestWithRetry('patch',
        `${HS}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`,
        { properties: { measure_once_rooms: JSON.stringify(rooms) } }
      );
    } catch (hsErr) {
      syncFailed = true;
      console.error('[rooms-fitter] HubSpot PATCH failed after retries (non-fatal):', hsErr.message);
    }

    // Bust shared cache so next /api/localdata/all and /api/contacts-all reflect the new assignment
    bustSharedCache();

    res.json({ success: true, rooms, ...(syncFailed ? { syncFailed: true } : {}) });
  } catch (e) {
    const status = e.response?.status;
    if (status === 401 || status === 403) {
      return res.status(502).json({ error: 'HubSpot rejected the request — the token may be invalid or expired.', code: 'HUBSPOT_AUTH' });
    }
    if (status === 429) {
      return res.status(502).json({ error: 'HubSpot rate limit reached. Please wait a moment and try again.', code: 'HUBSPOT_RATE_LIMIT' });
    }
    res.status(502).json({ error: e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
  }
});

app.get('/api/localdata/all', isAuthenticated, async (req, res) => {
  function buildRoomMap(contacts) {
    const result = {};
    for (const contact of contacts) {
      const roomsJson = contact.properties?.measure_once_rooms;
      if (!roomsJson) continue;
      try {
        const rooms = JSON.parse(roomsJson);
        if (Array.isArray(rooms)) {
          result[contact.id] = rooms.map(r => ({
            room: r.room || 'Main', stageKey: r.stageKey || 'sales',
            assignedFitterId: r.assignedFitterId || null,
            installStart: r.installStart || null
          }));
        }
      } catch {}
    }
    return result;
  }

  try {
    const { contacts } = await getSharedContactsCache();
    res.set('X-Cache-Status', 'fresh');
    res.json(buildRoomMap(contacts));
  } catch {
    // getSharedContactsCache threw because either (a) no snapshot exists yet,
    // or (b) the last-good snapshot has aged past ALL_CONTACTS_STALE_MAX_MS
    // (default 1 h) and HubSpot is still unreachable.
    //
    // Deliberate deviation from the 1-hour hard cap enforced by
    // getSharedContactsCache / /api/contacts-all:
    //
    //   /api/contacts-all drives the main customer list and lead-status
    //   counts where stale data could mislead business decisions, so it
    //   returns a hard 502 once the snapshot is older than
    //   ALL_CONTACTS_STALE_MAX_MS.
    //
    //   /api/localdata/all drives the room-assignments view.  Showing a
    //   >1-hour-old room map is far less harmful than showing a blank
    //   board, so we fall through to _allContactsLastGood with no cap.
    //   If there is no snapshot at all (server just started, or the very
    //   first fetch failed) we return an empty object so the UI renders
    //   cleanly rather than 502-ing.
    if (_allContactsLastGood) {
      res.set('X-Cache-Status', 'stale');
      return res.json(buildRoomMap(_allContactsLastGood.contacts));
    }
    res.json({});
  }
});

// ── Local storage for personal tasks only ─────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// ── Google OAuth ──────────────────────────────────────────────────────────────
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`;


const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar'
];

// ── Auth Routes ───────────────────────────────────────────────────────────────
const crypto = require('crypto');

app.get('/auth/google', isAuthenticated, (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.googleOAuthState = state;
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: GOOGLE_SCOPES,
    prompt: 'consent',
    state,
  });
  res.redirect(url);
});

app.get('/auth/google/callback', isAuthenticated, async (req, res) => {
  const expectedState = req.session.googleOAuthState;
  delete req.session.googleOAuthState;
  if (!expectedState || req.query.state !== expectedState) {
    return res.redirect('/?error=google_auth_failed');
  }
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    req.session.googleTokens = tokens;
    res.redirect('/?connected=true');
  } catch (e) {
    res.redirect('/?error=google_auth_failed');
  }
});

app.post('/auth/logout-google', isAuthenticated, (req, res) => {
  delete req.session.googleTokens;
  res.json({ success: true });
});

// ── Google: Connection status (live token check) ───────────────────────────────
app.get('/api/google/status', isAuthenticated, async (req, res) => {
  if (!req.session.googleTokens) {
    return res.json({ connected: false, code: 'NO_TOKEN' });
  }
  try {
    const auth = getGoogleClient(req.session.googleTokens);
    const { token } = await auth.getAccessToken();
    if (!token) return res.json({ connected: false, code: 'NO_TOKEN' });
    req.session.googleTokens = auth.credentials;
    res.json({ connected: true });
  } catch (e) {
    const msg = (e.message || '').toLowerCase();
    if (msg.includes('invalid_grant') || msg.includes('token has been expired') || msg.includes('token has been revoked')) {
      delete req.session.googleTokens;
      return res.json({ connected: false, code: 'TOKEN_EXPIRED' });
    }
    if (e.response?.status === 401 || msg.includes('invalid_client')) {
      return res.json({ connected: false, code: 'GOOGLE_AUTH' });
    }
    res.json({ connected: false, code: 'GOOGLE_ERROR' });
  }
});


app.get('/auth/status', (req, res) => {
  res.json({
    google:  !!req.session.googleTokens,
    hubspot: !!process.env.HUBSPOT_ACCESS_TOKEN
  });
});

// ── HubSpot: Connection status (lightweight ping, no requireHubspotToken guard) ─
app.get('/api/hubspot/status', async (req, res) => {
  if (!process.env.HUBSPOT_ACCESS_TOKEN) {
    return res.json({ connected: false, code: 'NO_TOKEN' });
  }
  // Expose cooldown state from the lead-status-counts fan-out so the admin
  // panel can show a live countdown instead of a vague "try again shortly".
  const cooldownMs = _leadStatusCountsCooldownUntil - Date.now();
  if (cooldownMs > 0) {
    return res.json({
      connected: false,
      code: 'HUBSPOT_RATE_LIMIT',
      cooldownSecondsRemaining: Math.ceil(cooldownMs / 1000),
    });
  }
  try {
    await axios.get(`${HS}/account-info/v3/details`, { headers: hsHeaders(), timeout: 8000 });
    res.json({ connected: true });
  } catch (e) {
    const status = e.response?.status;
    if (status === 401 || status === 403) {
      return res.json({ connected: false, code: 'HUBSPOT_AUTH' });
    }
    if (status === 429) {
      return res.json({ connected: false, code: 'HUBSPOT_RATE_LIMIT' });
    }
    res.json({ connected: false, code: 'HUBSPOT_ERROR' });
  }
});

// ── HubSpot: Account ──────────────────────────────────────────────────────────
app.get('/api/account', async (req, res) => {
  try {
    const r = await axios.get(`${HS}/account-info/v3/details`, { headers: hsHeaders() });
    res.json(r.data);
  } catch (e) {
    const status = e.response?.status;
    if (status === 401 || status === 403) {
      return res.status(502).json({ error: 'HubSpot rejected the request — the token may be invalid or expired.', code: 'HUBSPOT_AUTH' });
    }
    if (status === 429) {
      return res.status(502).json({ error: 'HubSpot rate limit reached. Please wait a moment and try again.', code: 'HUBSPOT_RATE_LIMIT' });
    }
    res.status(502).json({ error: e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
  }
});

// ── HubSpot: Pipeline ─────────────────────────────────────────────────────────
app.get('/api/pipeline', async (req, res) => {
  try {
    const r = await axios.get(`${HS}/crm/v3/pipelines/deals`, { headers: hsHeaders() });
    res.json(r.data);
  } catch (e) {
    const status = e.response?.status;
    if (status === 401 || status === 403) {
      return res.status(502).json({ error: 'HubSpot rejected the request — the token may be invalid or expired.', code: 'HUBSPOT_AUTH' });
    }
    if (status === 429) {
      return res.status(502).json({ error: 'HubSpot rate limit reached. Please wait a moment and try again.', code: 'HUBSPOT_RATE_LIMIT' });
    }
    res.status(502).json({ error: e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
  }
});

// ── HubSpot: Deals ────────────────────────────────────────────────────────────
function normalizeHubspotObjectId(id) {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return encodeURIComponent(trimmed);
}

app.get('/api/deals', requireHubspotToken, async (req, res) => {
  try {
    const r = await axios.get(`${HS}/crm/v3/objects/deals`, {
      headers: hsHeaders(),
      params: {
        limit: 100,
        properties: 'dealname,dealstage,amount,closedate,pipeline,hs_lastmodifieddate,createdate,hubspot_owner_id',
        associations: 'contacts'
      }
    });
    res.json(r.data);
  } catch (e) {
    const status = e.response?.status;
    if (status === 401 || status === 403) {
      return res.status(502).json({ error: 'HubSpot rejected the request — the token may be invalid or expired.', code: 'HUBSPOT_AUTH' });
    }
    if (status === 429) {
      return res.status(502).json({ error: 'HubSpot rate limit reached. Please wait a moment and try again.', code: 'HUBSPOT_RATE_LIMIT' });
    }
    res.status(502).json({ error: e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
  }
});

app.get('/api/deals/:id', requireHubspotToken, async (req, res) => {
  try {
    const safeDealId = normalizeHubspotObjectId(req.params.id);
    if (!safeDealId) {
      return res.status(400).json({ error: 'Invalid deal id' });
    }
    const r = await axios.get(`${HS}/crm/v3/objects/deals/${safeDealId}`, {
      headers: hsHeaders(),
      params: {
        properties: 'dealname,dealstage,amount,closedate,pipeline,hs_lastmodifieddate,createdate',
        associations: 'contacts,notes'
      }
    });
    res.json(r.data);
  } catch (e) {
    const status = e.response?.status;
    if (status === 401 || status === 403) {
      return res.status(502).json({ error: 'HubSpot rejected the request — the token may be invalid or expired.', code: 'HUBSPOT_AUTH' });
    }
    if (status === 429) {
      return res.status(502).json({ error: 'HubSpot rate limit reached. Please wait a moment and try again.', code: 'HUBSPOT_RATE_LIMIT' });
    }
    res.status(502).json({ error: e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
  }
});

app.patch('/api/deals/:id', isAuthenticated, requirePrivilege('member'), requireHubspotToken, hubspotMutationLimiter, async (req, res) => {
  try {
    const safeDealId = normalizeHubspotObjectId(req.params.id);
    if (!safeDealId) {
      return res.status(400).json({ error: 'Invalid deal id' });
    }
    const DEAL_ALLOWED = ['dealname', 'dealstage', 'amount', 'closedate', 'pipeline', 'description'];
    const properties = {};
    for (const key of DEAL_ALLOWED) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        properties[key] = req.body[key];
      }
    }
    if (Object.keys(properties).length === 0) {
      return res.status(400).json({ error: 'No valid properties to update.' });
    }
    const r = await hubspotRequestWithRetry('patch',
      `${HS}/crm/v3/objects/deals/${safeDealId}`,
      { properties }
    );
    res.json(r.data);
  } catch (e) {
    const status = e.response?.status;
    if (status === 401 || status === 403) {
      return res.status(502).json({ error: 'HubSpot rejected the request — the token may be invalid or expired.', code: 'HUBSPOT_AUTH' });
    }
    if (status === 429) {
      return res.status(502).json({ error: 'HubSpot rate limit reached. Please wait a moment and try again.', code: 'HUBSPOT_RATE_LIMIT' });
    }
    console.error('PATCH /api/deals/:id HubSpot error:', e.response?.data || e.message);
    res.status(502).json({ error: e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
  }
});

// ── HubSpot: All Contacts (no lead status filter) ─────────────────────────────
app.get('/api/contacts-all', isAuthenticated, async (req, res) => {
  try {
    const page       = Math.max(1, parseInt(req.query.page  || '1',   10));
    const limit      = Math.min(100, Math.max(1, parseInt(req.query.limit || '25', 10)));
    const leadStatus = req.query.leadStatus || '';
    const sort       = req.query.sort || 'newest';
    const q          = (req.query.q || '').trim().toLowerCase();

    const sortComparators = {
      'newest':    (a, b) => (b.properties.createdate || '').localeCompare(a.properties.createdate || ''),
      'oldest':    (a, b) => (a.properties.createdate || '').localeCompare(b.properties.createdate || ''),
      'name-asc':  (a, b) => (a.properties.lastname || '').localeCompare(b.properties.lastname || ''),
      'name-desc': (a, b) => (b.properties.lastname || '').localeCompare(a.properties.lastname || ''),
    };
    const comparator = sortComparators[sort] || sortComparators['newest'];

    const cacheResult = await getSharedContactsCache();
    const { contacts: rawContacts, stale } = cacheResult;
    if (stale) res.setHeader('X-Cache-Status', 'stale');

    // Cold cache + HubSpot unavailable: no snapshot exists and HubSpot could
    // not be reached.  Return 502 so bootstrap()'s catch block fires and the
    // React board can display a proper in-board error state.
    if (cacheResult.unavailable) {
      const err = cacheResult._err;
      const status = err?.response?.status;
      if (status === 401 || status === 403) {
        return res.status(502).json({ error: 'HubSpot rejected the request — the token may be invalid or expired.', code: 'HUBSPOT_AUTH' });
      }
      if (status === 429) {
        return res.status(502).json({ error: 'HubSpot rate limit reached. Please wait a moment and try again.', code: 'HUBSPOT_RATE_LIMIT' });
      }
      return res.status(502).json({ error: 'HubSpot is currently unavailable. Please try again shortly.', code: 'HUBSPOT_UNAVAILABLE' });
    }

    let contacts = rawContacts;

    // Dev-only filter: hide contacts without hw_test_user = true in non-production,
    // unless the global dev-filter toggle has been turned off by an admin.
    // Admins may also pass ?all=1 to bypass (e.g. for the test-user management UI).
    if (process.env.NODE_ENV !== 'production') {
      const bypassForAdmin = req.query.all === '1' && getReqPrivilege(req) === 'admin';
      const devFilterOn = await getDevFilterEnabled();
      if (!bypassForAdmin && devFilterOn) {
        contacts = contacts.filter(c => c.properties?.hw_test_user === 'true');
      }
    }

    if (leadStatus) {
      if (leadStatus === '__no_status__') {
        contacts = contacts.filter(c => !c.properties?.hs_lead_status);
      } else {
        contacts = contacts.filter(c => c.properties?.hs_lead_status === leadStatus);
      }
    }

    const stageParam = (req.query.stage || '').trim();
    // archived=1 means show all rooms; archived=0 (default) means only active rooms.
    const showArchived = req.query.archived === '1';
    if (stageParam) {
      contacts = contacts.filter(c => {
        const roomsJson = c.properties?.measure_once_rooms;
        if (!roomsJson) return false;
        try {
          const rooms = JSON.parse(roomsJson);
          if (!Array.isArray(rooms)) return false;
          // Normalise missing stageKey to 'sales' (the default used throughout
          // the room-resolution layer in the client and localdata endpoint).
          const inStage = rooms.filter(r => (r.stageKey || 'sales') === stageParam);
          if (inStage.length === 0) return false;
          // When not showing archived, require at least one active room in the stage.
          if (!showArchived) {
            return inStage.some(r => (r.roomStatus || 'active') === 'active');
          }
          return true;
        } catch {
          return false;
        }
      });
    }

    if (q) {
      contacts = contacts.filter(c => {
        const first = (c.properties?.firstname || '').toLowerCase();
        const last  = (c.properties?.lastname  || '').toLowerCase();
        const email = (c.properties?.email     || '').toLowerCase();
        const phone = (c.properties?.phone     || '').toLowerCase();
        return `${first} ${last}`.includes(q) || first.includes(q) || last.includes(q) || email.includes(q) || phone.includes(q);
      });
    }

    contacts = [...contacts].sort(comparator);

    const total      = contacts.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const offset     = (page - 1) * limit;
    const results    = contacts.slice(offset, offset + limit);

    res.json({ results, total, page, totalPages });
  } catch (e) {
    const status = e.response?.status;
    if (status === 401 || status === 403) {
      return res.status(502).json({ error: 'HubSpot rejected the request — the token may be invalid or expired.', code: 'HUBSPOT_AUTH' });
    }
    if (status === 429) {
      return res.status(502).json({ error: 'HubSpot rate limit reached. Please wait a moment and try again.', code: 'HUBSPOT_RATE_LIMIT' });
    }
    res.status(502).json({ error: e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
  }
});

// ── HubSpot: Lead-status counts (for filter dropdown) ─────────────────────────
// In-memory cache. `fresh` is the latest successful counts within the 120s TTL.
// `lastGood` is the most recent successful counts of any age — used to serve a
// stale response when HubSpot is unavailable (rate-limited / 5xx) so the UI
// doesn't surface a red error toast for a transient hiccup.
// `inFlight` is a shared promise so concurrent callers on a cold cache trigger
// a single HubSpot fan-out instead of one per request.
const LEAD_STATUS_COUNTS_TTL_MS = 120_000;
const LEAD_STATUS_COUNTS_STALE_MAX_MS = 60 * 60 * 1000; // 1 h hard cap on staleness
const LEAD_STATUS_COUNTS_COOLDOWN_MS = 60_000; // 60 s post-429-wave cooldown
let _leadStatusCountsCache = null;   // { counts, fetchedAt } — used while fresh
let _leadStatusCountsLastGood = null; // { counts, fetchedAt } — survives invalidation, used on error
let _leadStatusCountsInFlight = null;
let _leadStatusCountsCooldownUntil = 0; // epoch ms — skip fan-out while active
function _invalidateLeadStatusCountsCache() {
  // Drop the freshness window so the next request refetches, but keep
  // `_leadStatusCountsLastGood` so a failed refetch can still serve stale
  // counts instead of erroring out to the UI.
  _leadStatusCountsCache = null;
}

// ── Open-Leads in-memory cache (single-flight + 60 s TTL) ────────────────────
// Mirrors the lead-status-counts cache pattern. Invalidated on any
// hs_lead_status mutation or dev-filter toggle.
const OPEN_LEADS_TTL_MS = 60_000;
let _openLeadsCache    = null; // { results, total, fetchedAt }
let _openLeadsInFlight = null;
function _invalidateOpenLeadsCache() {
  _openLeadsCache = null;
}

async function _fetchLeadStatusCounts() {
  const { rows: statusRows } = await pool.query(
    'SELECT key FROM lead_status_config WHERE is_null_row IS NOT TRUE ORDER BY sort_order ASC, key ASC'
  );
  const keys = statusRows.map(r => r.key);

  // In dev mode, counts are scoped to hw_test_user contacts only so the
  // filter-dropdown numbers stay consistent with what the contacts list shows.
  // This is skipped when the global dev-filter toggle is OFF.
  const devCountFilter = (process.env.NODE_ENV !== 'production' && await getDevFilterEnabled())
    ? [{ propertyName: 'hw_test_user', operator: 'EQ', value: 'true' }]
    : [];

  // Serialized searches — one at a time with a small inter-request pause so the
  // N+1 fan-out never bursts beyond HubSpot's 10 req/s limit. Using Promise.all
  // previously fired all searches simultaneously, which saturated the rate-limit
  // quota and caused the cache to never repopulate (feedback loop).
  const INTER_REQUEST_PAUSE_MS = 150;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const searchConfigs = [
    { key: '__no_status__', body: { filterGroups: [{ filters: [{ propertyName: 'hs_lead_status', operator: 'NOT_HAS_PROPERTY' }, ...devCountFilter] }], limit: 1 } },
    ...keys.map(key => ({ key, body: { filterGroups: [{ filters: [{ propertyName: 'hs_lead_status', operator: 'EQ', value: key }, ...devCountFilter] }], limit: 1 } })),
  ];

  const entries = [];
  for (let i = 0; i < searchConfigs.length; i++) {
    const { key, body } = searchConfigs[i];
    if (i > 0) await sleep(INTER_REQUEST_PAUSE_MS);
    const r = await hubspotSearchWithRetry(body);
    entries.push([key, r.data.total ?? 0]);
  }
  return Object.fromEntries(entries);
}

app.get('/api/contacts-lead-status-counts', isAuthenticated, requireHubspotToken, async (req, res) => {
  // Fresh cache hit — return immediately.
  if (_leadStatusCountsCache && Date.now() - _leadStatusCountsCache.fetchedAt < LEAD_STATUS_COUNTS_TTL_MS) {
    res.setHeader('X-Cache-Status', 'fresh');
    return res.json(_leadStatusCountsCache.counts);
  }

  // Post-429-wave cooldown: if a recent fan-out was rate-limited, skip starting
  // a new fan-out and serve stale counts immediately. This prevents the feedback
  // loop where every 120s TTL expiry triggers a fresh burst that also gets 429'd.
  if (Date.now() < _leadStatusCountsCooldownUntil) {
    if (_leadStatusCountsLastGood) {
      if (process.env.DEBUG_HUBSPOT) {
        console.warn('[lead-status-counts] cooldown active for %dms more; serving stale counts',
          _leadStatusCountsCooldownUntil - Date.now());
      }
      res.setHeader('X-Cache-Status', 'stale');
      return res.json(_leadStatusCountsLastGood.counts);
    }
    return res.status(502).json({ error: 'HubSpot rate limit reached. Please wait a moment and try again.', code: 'HUBSPOT_RATE_LIMIT' });
  }

  // Single-flight: all concurrent cold-cache callers share one fan-out.
  if (!_leadStatusCountsInFlight) {
    _leadStatusCountsInFlight = (async () => {
      try {
        const counts = await _fetchLeadStatusCounts();
        const entry = { counts, fetchedAt: Date.now() };
        _leadStatusCountsCache    = entry;
        _leadStatusCountsLastGood = entry;
        _leadStatusCountsCooldownUntil = 0; // reset cooldown on success
        return { ok: true, counts };
      } catch (err) {
        // If the fan-out hit rate limits, engage cooldown so the next 60 s of
        // requests are served from stale cache instead of hammering HubSpot again.
        if (err.response?.status === 429) {
          _leadStatusCountsCooldownUntil = Date.now() + LEAD_STATUS_COUNTS_COOLDOWN_MS;
          if (process.env.DEBUG_HUBSPOT) {
            console.warn('[lead-status-counts] 429 wave detected; cooldown engaged for %ds', LEAD_STATUS_COUNTS_COOLDOWN_MS / 1000);
          }
        }
        return { ok: false, err };
      } finally {
        // Release after a microtask tick so callers awaiting the same promise
        // all observe the resolved state before the next request starts a new
        // in-flight fetch.
        setImmediate(() => { _leadStatusCountsInFlight = null; });
      }
    })();
  }

  const outcome = await _leadStatusCountsInFlight;

  if (outcome.ok) {
    res.setHeader('X-Cache-Status', 'fresh');
    return res.json(outcome.counts);
  }

  // Fetch failed — serve last-good counts if we have any recent enough.
  const e = outcome.err;
  const status = e.response?.status;
  if (_leadStatusCountsLastGood && Date.now() - _leadStatusCountsLastGood.fetchedAt < LEAD_STATUS_COUNTS_STALE_MAX_MS) {
    if (process.env.DEBUG_HUBSPOT) {
      console.warn('[lead-status-counts] HubSpot fetch failed (status=%s); serving stale counts age=%dms',
        status || 'network', Date.now() - _leadStatusCountsLastGood.fetchedAt);
    }
    res.setHeader('X-Cache-Status', 'stale');
    return res.json(_leadStatusCountsLastGood.counts);
  }
  if (status === 401 || status === 403) {
    return res.status(502).json({ error: 'HubSpot rejected the request — the token may be invalid or expired.', code: 'HUBSPOT_AUTH' });
  }
  if (status === 429) {
    return res.status(502).json({ error: 'HubSpot rate limit reached. Please wait a moment and try again.', code: 'HUBSPOT_RATE_LIMIT' });
  }
  res.status(502).json({ error: e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
});

// ── HubSpot: Open Leads (contacts with hs_lead_status = OPEN_DEAL) ────────────
app.get('/api/open-leads', async (req, res) => {
  // Fresh cache hit — return immediately.
  if (_openLeadsCache && Date.now() - _openLeadsCache.fetchedAt < OPEN_LEADS_TTL_MS) {
    res.setHeader('X-Cache-Status', 'fresh');
    res.setHeader('X-Cache-Age', String(Math.round((Date.now() - _openLeadsCache.fetchedAt) / 1000)));
    return res.json({ results: _openLeadsCache.results, total: _openLeadsCache.total });
  }

  // Single-flight: all concurrent cold-cache callers share one HubSpot fan-out.
  if (!_openLeadsInFlight) {
    _openLeadsInFlight = (async () => {
      try {
        const allResults = [];
        let after = undefined;
        // In dev mode every listing endpoint is narrowed to hw_test_user contacts.
        // This is skipped when the global dev-filter toggle is OFF.
        const devFilters = (process.env.NODE_ENV !== 'production' && await getDevFilterEnabled())
          ? [{ propertyName: 'hw_test_user', operator: 'EQ', value: 'true' }]
          : [];
        do {
          const body = {
            filterGroups: [{
              filters: [
                { propertyName: 'hs_lead_status', operator: 'EQ', value: 'OPEN_DEAL' },
                ...devFilters,
              ]
            }],
            properties: ['firstname', 'lastname', 'email', 'phone', 'hs_lead_status', 'city', 'zip', 'customer_number', 'createdate', 'closedate', 'lastmodifieddate'],
            sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
            limit: 100
          };
          if (after) body.after = after;
          const r = await hubspotSearchWithRetry(body);
          allResults.push(...(r.data.results || []));
          after = r.data.paging?.next?.after;
        } while (after);
        _openLeadsCache = { results: allResults, total: allResults.length, fetchedAt: Date.now() };
        return { ok: true, results: allResults, total: allResults.length };
      } catch (err) {
        console.error('[open-leads] HubSpot fetch error (status=%s): %s', err.response?.status || 'network', err.message);
        return { ok: false, err };
      } finally {
        setImmediate(() => { _openLeadsInFlight = null; });
      }
    })();
  }

  const outcome = await _openLeadsInFlight;

  if (outcome.ok) {
    res.setHeader('X-Cache-Status', 'fresh');
    return res.json({ results: outcome.results, total: outcome.total });
  }

  // Fetch failed — serve stale cache if available rather than surfacing an error.
  if (_openLeadsCache) {
    if (process.env.DEBUG_HUBSPOT) {
      console.warn('[open-leads] HubSpot fetch failed; serving stale cache age=%dms', Date.now() - _openLeadsCache.fetchedAt);
    }
    res.setHeader('X-Cache-Status', 'stale');
    return res.json({ results: _openLeadsCache.results, total: _openLeadsCache.total });
  }

  const e = outcome.err;
  const status = e.response?.status;
  if (status === 401 || status === 403) {
    return res.status(502).json({ error: 'HubSpot rejected the request — the token may be invalid or expired.', code: 'HUBSPOT_AUTH' });
  }
  if (status === 429) {
    return res.status(502).json({ error: 'HubSpot rate limit reached. Please wait a moment and try again.', code: 'HUBSPOT_RATE_LIMIT' });
  }
  res.status(502).json({ error: e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
});

// ── HubSpot: Contacts ─────────────────────────────────────────────────────────

// Create a new contact in HubSpot and generate a customer number
app.post('/api/contacts', isAuthenticated, requirePrivilege('member'), requireHubspotToken, hubspotMutationLimiter, async (req, res) => {
  const { firstname, lastname, email, phone, postcode } = req.body || {};

  if (!firstname || !email || !postcode) {
    return res.status(400).json({ error: 'First name, email, and postcode are required.' });
  }

  // Extract the area letters from the postcode (leading alpha chars before first digit)
  const areaMatch = postcode.trim().match(/^([A-Za-z]+)/);
  const areaPrefix = areaMatch ? areaMatch[1].toUpperCase() : 'XX';

  try {
    // Create the contact in HubSpot
    const createBody = {
      properties: {
        firstname,
        lastname:       lastname  || '',
        email,
        phone:          phone     || '',
        zip:            postcode,
        hs_lead_status: 'OPEN_DEAL',
      }
    };
    const createRes = await axios.post(
      `${HS}/crm/v3/objects/contacts`,
      createBody,
      { headers: hsHeaders() }
    );
    const contact = createRes.data;
    const contactId = contact.id;

    // Generate customer number: area letters + zero-padded contact ID (5 digits min)
    const numPart = contactId.padStart(5, '0');
    const customerNumber = `${areaPrefix}${numPart}`;

    // Patch the contact with the generated customer number
    await axios.patch(
      `${HS}/crm/v3/objects/contacts/${contactId}`,
      { properties: { customer_number: customerNumber } },
      { headers: hsHeaders() }
    );

    contact.properties.customer_number = customerNumber;
    bustSharedCache();
    return res.status(201).json(contact);
  } catch (e) {
    const status = e.response?.status;
    if (status === 409) {
      return res.status(409).json({ error: 'A contact with this email address already exists in HubSpot.' });
    }
    if (status === 401 || status === 403) {
      return res.status(502).json({ error: 'HubSpot rejected the request — the token may be invalid or expired.', code: 'HUBSPOT_AUTH' });
    }
    if (status === 429) {
      return res.status(502).json({ error: 'HubSpot rate limit reached. Please wait a moment and try again.', code: 'HUBSPOT_RATE_LIMIT' });
    }
    res.status(502).json({ error: e.response?.data?.message || e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
  }
});

app.get('/api/contacts/:id', requireHubspotToken, async (req, res) => {
  try {
    const contactId = String(req.params.id || '');
    if (!/^\d+$/.test(contactId)) {
      return res.status(400).json({ error: 'Invalid contact id.' });
    }
    const safeContactId = encodeURIComponent(contactId);
    const r = await axios.get(`${HS}/crm/v3/objects/contacts/${safeContactId}`, {
      headers: hsHeaders(),
      params: { properties: 'firstname,lastname,email,phone,address,city,zip,customer_number,hs_lead_status,createdate' }
    });
    res.json(r.data);
  } catch (e) {
    const status = e.response?.status;
    if (status === 401 || status === 403) {
      return res.status(502).json({ error: 'HubSpot rejected the request — the token may be invalid or expired.', code: 'HUBSPOT_AUTH' });
    }
    if (status === 429) {
      return res.status(502).json({ error: 'HubSpot rate limit reached. Please wait a moment and try again.', code: 'HUBSPOT_RATE_LIMIT' });
    }
    res.status(502).json({ error: e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
  }
});

app.patch('/api/contacts/:id', isAuthenticated, requirePrivilege('member'), requireHubspotToken, hubspotMutationLimiter, async (req, res) => {
  try {
    const contactId = String(req.params.id || '');
    if (!/^\d+$/.test(contactId)) {
      return res.status(400).json({ error: 'Invalid contact id.' });
    }
    const allowed = ['hs_lead_status', 'hw_lead_substatus', 'firstname', 'lastname', 'email', 'phone', 'address', 'city', 'zip'];
    const properties = {};
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        properties[key] = req.body[key];
      }
    }
    if (Object.keys(properties).length === 0) {
      return res.status(400).json({ error: 'No valid properties to update.' });
    }
    // Pipeline-field gate: only managers/admins may change hs_lead_status or
    // hw_lead_substatus. Other contact fields remain editable at the route's
    // base member level.
    if (Object.prototype.hasOwnProperty.call(properties, 'hs_lead_status') ||
        Object.prototype.hasOwnProperty.call(properties, 'hw_lead_substatus')) {
      try {
        const userId = req.user?.claims?.sub;
        const ur = await pool.query(`SELECT privilege_level FROM users WHERE id = $1`, [userId]);
        const level = ur.rows[0]?.privilege_level || 'member';
        if (level !== 'manager' && level !== 'admin') {
          return res.status(403).json({
            message: 'Manager or admin privilege required to change lead status.',
            code: 'PIPELINE_EDIT_FORBIDDEN',
          });
        }
      } catch {
        return res.status(500).json({ error: 'Authorization check failed' });
      }
    }
    const safeContactId = encodeURIComponent(contactId);

    // Retry transient HubSpot failures (network errors, 429, 5xx) with small bounded backoff.
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const isTransient = err => {
      const s = err.response?.status;
      if (s === 429) return true;
      if (s && s >= 500 && s < 600) return true;
      if (!err.response) return true; // network / timeout
      return false;
    };

    let lastErr;
    let patchResp;
    const delays = [250, 750, 1500];
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        patchResp = await axios.patch(
          `${HS}/crm/v3/objects/contacts/${safeContactId}`,
          { properties },
          { headers: hsHeaders() }
        );
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < delays.length && isTransient(err)) {
          await sleep(delays[attempt]);
          continue;
        }
        throw err;
      }
    }

    // Verify all submitted properties were saved by reading back from HubSpot.
    const propsToVerify = Object.keys(properties);
    let verifyResp;
    let verifyErr;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        verifyResp = await axios.get(
          `${HS}/crm/v3/objects/contacts/${safeContactId}`,
          { headers: hsHeaders(), params: { properties: propsToVerify.join(',') } }
        );
        verifyErr = null;
        break;
      } catch (err) {
        verifyErr = err;
        if (attempt < delays.length && isTransient(err)) {
          await sleep(delays[attempt]);
          continue;
        }
        break;
      }
    }
    if (verifyErr) {
      return res.status(502).json({
        error: 'HubSpot accepted the update but could not be re-read to confirm. Please try again.',
        code: 'HUBSPOT_VERIFY_FAILED'
      });
    }
    const returnedProps = verifyResp.data?.properties || {};
    const _normCmp = v => (v === null || v === undefined) ? '' : String(v).trim();
    for (const key of propsToVerify) {
      const expected = _normCmp(properties[key]);
      const actual   = _normCmp(returnedProps[key]);
      if (actual !== expected) {
        return res.status(502).json({
          error: 'HubSpot did not save the updated contact details. Please try again.',
          code: 'HUBSPOT_VERIFY_FAILED'
        });
      }
    }

    bustSharedCache();
    if (Object.prototype.hasOwnProperty.call(properties, 'hs_lead_status')) {
      _invalidateLeadStatusCountsCache();
      _invalidateOpenLeadsCache();
    }
    res.json(patchResp.data);
  } catch (e) {
    const status = e.response?.status;
    if (status === 401 || status === 403) {
      return res.status(502).json({ error: 'HubSpot rejected the request — the token may be invalid or expired.', code: 'HUBSPOT_AUTH' });
    }
    if (status === 429) {
      return res.status(502).json({ error: 'HubSpot rate limit reached. Please wait a moment and try again.', code: 'HUBSPOT_RATE_LIMIT' });
    }
    res.status(502).json({ error: e.response?.data?.message || e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
  }
});

// ── HubSpot: Notes (for checklist storage) ────────────────────────────────────
app.get('/api/deals/:id/notes', requireHubspotToken, async (req, res) => {
  try {
    const dealId = req.params.id;
    if (!/^\d+$/.test(dealId)) {
      return res.status(400).json({ error: 'Invalid deal id' });
    }

    const assocR = await axios.get(
      `${HS}/crm/v3/objects/deals/${dealId}/associations/notes`,
      { headers: hsHeaders() }
    );
    const noteIds = assocR.data.results?.map(r => r.id) || [];
    if (!noteIds.length) return res.json({ results: [] });

    const noteR = await axios.post(
      `${HS}/crm/v3/objects/notes/batch/read`,
      {
        properties: ['hs_note_body', 'hs_timestamp'],
        inputs: noteIds.map(id => ({ id }))
      },
      { headers: hsHeaders() }
    );
    res.json(noteR.data);
  } catch (e) {
    console.error('GET /api/deals/:id/notes HubSpot error:', e.response?.data || e.message);
    res.json({ results: [] });
  }
});

// Verify that a HubSpot note is actually associated with the given object type + ID.
// Returns true if the association exists, false otherwise (or on error).
async function verifyNoteAssociation(noteId, objectType, objectId) {
  try {
    const r = await axios.get(
      `${HS}/crm/v3/objects/notes/${encodeURIComponent(noteId)}/associations/${encodeURIComponent(objectType)}`,
      { headers: hsHeaders(), timeout: 8000 }
    );
    const ids = (r.data?.results || []).map(a => String(a.id));
    return ids.includes(String(objectId));
  } catch (e) {
    // If the note doesn't exist or the association call fails, deny the update.
    return false;
  }
}

// Verify that a HubSpot task is actually associated with the given object type + ID.
// Returns true if the association exists, false otherwise (or on error).
async function verifyTaskAssociation(taskId, objectType, objectId) {
  try {
    const r = await axios.get(
      `${HS}/crm/v3/objects/tasks/${encodeURIComponent(taskId)}/associations/${encodeURIComponent(objectType)}`,
      { headers: hsHeaders(), timeout: 8000 }
    );
    const ids = (r.data?.results || []).map(a => String(a.id));
    return ids.includes(String(objectId));
  } catch (e) {
    // If the task doesn't exist or the association call fails, deny the update.
    return false;
  }
}

app.post('/api/deals/:id/checklist', isAuthenticated, requirePrivilege('member'), requireHubspotToken, hubspotMutationLimiter, async (req, res) => {
  try {
    const { checklistData, existingNoteId } = req.body;
    const noteBody = `WORKFLOW_CHECKLIST:${JSON.stringify(checklistData)}`;
    const dealId = String(req.params.id || '');

    // HubSpot deal IDs are numeric; reject anything else to prevent URL/path injection.
    if (!/^\d+$/.test(dealId)) {
      return res.status(400).json({ error: 'Invalid deal id' });
    }

    if (existingNoteId) {
      const validatedExistingNoteId = String(existingNoteId);
      if (!/^[A-Za-z0-9_-]+$/.test(validatedExistingNoteId)) {
        return res.status(400).json({ error: 'Invalid existingNoteId' });
      }

      const associated = await verifyNoteAssociation(validatedExistingNoteId, 'deals', dealId);
      if (!associated) {
        return res.status(403).json({ error: 'Note is not associated with this deal.' });
      }

      const r = await hubspotRequestWithRetry('patch',
        `${HS}/crm/v3/objects/notes/${validatedExistingNoteId}`,
        { properties: { hs_note_body: noteBody } }
      );
      return res.json(r.data);
    }

    // Create note then associate
    const noteR = await hubspotRequestWithRetry('post',
      `${HS}/crm/v3/objects/notes`,
      { properties: { hs_note_body: noteBody, hs_timestamp: new Date().toISOString() } }
    );
    await hubspotRequestWithRetry('put',
      `${HS}/crm/v3/objects/notes/${noteR.data.id}/associations/deals/${dealId}/note_to_deal`,
      {}
    );
    res.json(noteR.data);
  } catch (e) {
    const status = e.response?.status;
    if (status === 401 || status === 403) {
      return res.status(502).json({ error: 'HubSpot rejected the request — the token may be invalid or expired.', code: 'HUBSPOT_AUTH' });
    }
    if (status === 429) {
      return res.status(502).json({ error: 'HubSpot rate limit reached. Please wait a moment and try again.', code: 'HUBSPOT_RATE_LIMIT' });
    }
    console.error('POST /api/deals/:id/checklist HubSpot error:', e.response?.data || e.message);
    res.status(502).json({ error: e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
  }
});

// ── Gmail ─────────────────────────────────────────────────────────────────────
function getGoogleClient(tokens) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
  );
  client.setCredentials(tokens);
  return client;
}

function classifyGoogleError(e) {
  const msg = (e.message || '').toLowerCase();
  const status = e.code || e.response?.status || e.status;
  const errData = e.response?.data?.error || '';
  if (
    status === 401 ||
    errData === 'invalid_grant' ||
    msg.includes('invalid_grant') ||
    msg.includes('token has been expired') ||
    msg.includes('token has been revoked') ||
    msg.includes('invalid credentials') ||
    msg.includes('autherror')
  ) {
    return 'GOOGLE_AUTH';
  }
  return 'GOOGLE_ERROR';
}

app.get('/api/emails', async (req, res) => {
  if (!req.session.googleTokens) return res.status(401).json({ error: 'Not authenticated with Google', code: 'GOOGLE_AUTH' });
  try {
    const auth = getGoogleClient(req.session.googleTokens);
    const gmail = google.gmail({ version: 'v1', auth });
    const { email } = req.query;
    const q = email ? `from:${email} OR to:${email}` : '';
    const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 15 });

    if (!list.data.messages?.length) return res.json({ messages: [] });

    const messages = await Promise.all(list.data.messages.map(async m => {
      const msg = await gmail.users.messages.get({
        userId: 'me', id: m.id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'To', 'Date']
      });
      const h = msg.data.payload.headers;
      const get = name => h.find(x => x.name === name)?.value || '';
      return {
        id: m.id,
        subject: get('Subject'),
        from: get('From'),
        to: get('To'),
        date: get('Date'),
        snippet: msg.data.snippet
      };
    }));

    res.json({ messages });
  } catch (e) {
    const code = classifyGoogleError(e);
    res.status(code === 'GOOGLE_AUTH' ? 401 : 500).json({ error: e.message, code });
  }
});

app.post('/api/emails/send', isAuthenticated, requirePrivilege('member'), gmailSendLimiter, async (req, res) => {
  if (!req.session.googleTokens) return res.status(401).json({ error: 'Not authenticated with Google', code: 'GOOGLE_AUTH' });
  try {
    const auth = getGoogleClient(req.session.googleTokens);
    const gmail = google.gmail({ version: 'v1', auth });
    const { to, subject, body } = req.body;

    const raw = Buffer.from(
      `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
    ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

    await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    res.json({ success: true });
  } catch (e) {
    const code = classifyGoogleError(e);
    res.status(code === 'GOOGLE_AUTH' ? 401 : 500).json({ error: e.message, code });
  }
});

// ── Google Calendar ───────────────────────────────────────────────────────────
app.get('/api/events', async (req, res) => {
  if (!req.session.googleTokens) return res.status(401).json({ error: 'Not authenticated with Google', code: 'GOOGLE_AUTH' });
  try {
    const auth = getGoogleClient(req.session.googleTokens);
    const calendar = google.calendar({ version: 'v3', auth });
    const events = await calendar.events.list({
      calendarId: 'primary',
      timeMin: new Date().toISOString(),
      maxResults: 20,
      singleEvents: true,
      orderBy: 'startTime',
      q: req.query.search || undefined
    });
    res.json(events.data);
  } catch (e) {
    const code = classifyGoogleError(e);
    res.status(code === 'GOOGLE_AUTH' ? 401 : 500).json({ error: e.message, code });
  }
});

app.post('/api/events', isAuthenticated, requirePrivilege('member'), calendarEventLimiter, async (req, res) => {
  if (!req.session.googleTokens) return res.status(401).json({ error: 'Not authenticated with Google', code: 'GOOGLE_AUTH' });
  try {
    const auth = getGoogleClient(req.session.googleTokens);
    const calendar = google.calendar({ version: 'v3', auth });
    const event = await calendar.events.insert({ calendarId: 'primary', requestBody: req.body });
    res.json(event.data);
  } catch (e) {
    const code = classifyGoogleError(e);
    res.status(code === 'GOOGLE_AUTH' ? 401 : 500).json({ error: e.message, code });
  }
});

// ── HubSpot: Contact Notes + Workflow Data ────────────────────────────────────
app.get('/api/contacts/:id/notes', requireHubspotToken, async (req, res) => {
  const contactId = String(req.params.id || '');
  if (!/^\d+$/.test(contactId)) {
    return res.status(400).json({ error: 'Invalid contact id' });
  }
  try {
    const assocR = await axios.get(
      `${HS}/crm/v3/objects/contacts/${contactId}/associations/notes`,
      { headers: hsHeaders() }
    );
    const noteIds = assocR.data.results?.map(r => r.id) || [];
    if (!noteIds.length) return res.json({ results: [] });

    const noteR = await axios.post(
      `${HS}/crm/v3/objects/notes/batch/read`,
      {
        properties: ['hs_note_body', 'hs_timestamp'],
        inputs: noteIds.map(id => ({ id }))
      },
      { headers: hsHeaders() }
    );
    res.json(noteR.data);
  } catch (e) {
    console.error('GET /api/contacts/:id/notes HubSpot error:', e.response?.data || e.message);
    res.json({ results: [] });
  }
});

app.post('/api/contacts/:id/workflow', isAuthenticated, requirePrivilege('member'), requireHubspotToken, hubspotMutationLimiter, async (req, res) => {
  try {
    const { data, existingNoteId } = req.body;
    const contactId = String(req.params.id || '');
    if (!/^\d+$/.test(contactId)) {
      return res.status(400).json({ error: 'Invalid contact id' });
    }

    const noteBody = `WORKFLOW_DATA:${JSON.stringify(data)}`;

    if (existingNoteId) {
      const safeExistingNoteId = validateHsObjectId(existingNoteId, 'existingNoteId');
      const associated = await verifyNoteAssociation(safeExistingNoteId, 'contacts', contactId);
      if (!associated) {
        return res.status(403).json({ error: 'Note is not associated with this contact.' });
      }
      const r = await hubspotRequestWithRetry('patch',
        `${HS}/crm/v3/objects/notes/${safeExistingNoteId}`,
        { properties: { hs_note_body: noteBody } }
      );
      return res.json(r.data);
    }

    const noteR = await hubspotRequestWithRetry('post',
      `${HS}/crm/v3/objects/notes`,
      { properties: { hs_note_body: noteBody, hs_timestamp: new Date().toISOString() } }
    );
    await hubspotRequestWithRetry('put',
      `${HS}/crm/v3/objects/notes/${noteR.data.id}/associations/contacts/${encodeURIComponent(contactId)}/note_to_contact`,
      {}
    );
    res.json(noteR.data);
  } catch (e) {
    const status = e.response?.status;
    if (status === 401 || status === 403) {
      return res.status(502).json({ error: 'HubSpot rejected the request — the token may be invalid or expired.', code: 'HUBSPOT_AUTH' });
    }
    if (status === 429) {
      return res.status(502).json({ error: 'HubSpot rate limit reached. Please wait a moment and try again.', code: 'HUBSPOT_RATE_LIMIT' });
    }
    console.error('POST /api/contacts/:id/workflow HubSpot error:', e.response?.data || e.message);
    res.status(502).json({ error: e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
  }
});

// ── Workflow Data (per-deal status + comments) ────────────────────────────────
app.post('/api/deals/:id/workflow', isAuthenticated, requirePrivilege('member'), requireHubspotToken, hubspotMutationLimiter, async (req, res) => {
  try {
    const { data, existingNoteId } = req.body;
    const safeDealId = validateHsObjectId(req.params.id, 'id');
    const noteBody = `WORKFLOW_DATA:${JSON.stringify(data)}`;

    if (existingNoteId) {
      const safeExistingNoteId = validateHsObjectId(existingNoteId, 'existingNoteId');
      const associated = await verifyNoteAssociation(safeExistingNoteId, 'deals', safeDealId);
      if (!associated) {
        return res.status(403).json({ error: 'Note is not associated with this deal.' });
      }
      const r = await hubspotRequestWithRetry('patch',
        `${HS}/crm/v3/objects/notes/${safeExistingNoteId}`,
        { properties: { hs_note_body: noteBody } }
      );
      return res.json(r.data);
    }

    const noteR = await hubspotRequestWithRetry('post',
      `${HS}/crm/v3/objects/notes`,
      { properties: { hs_note_body: noteBody, hs_timestamp: new Date().toISOString() } }
    );
    await hubspotRequestWithRetry('put',
      `${HS}/crm/v3/objects/notes/${noteR.data.id}/associations/deals/${safeDealId}/note_to_deal`,
      {}
    );
    res.json(noteR.data);
  } catch (e) {
    const status = e.response?.status;
    if (status === 401 || status === 403) {
      return res.status(502).json({ error: 'HubSpot rejected the request — the token may be invalid or expired.', code: 'HUBSPOT_AUTH' });
    }
    if (status === 429) {
      return res.status(502).json({ error: 'HubSpot rate limit reached. Please wait a moment and try again.', code: 'HUBSPOT_RATE_LIMIT' });
    }
    console.error('POST /api/deals/:id/workflow HubSpot error:', e.response?.data || e.message);
    res.status(502).json({ error: e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
  }
});

// ── HubSpot: Tasks ────────────────────────────────────────────────────────────
app.get('/api/contacts/:id/tasks', requireHubspotToken, async (req, res) => {
  try {
    const contactId = req.params.id;
    if (!/^\d+$/.test(contactId)) {
      return res.status(400).json({ error: 'Invalid contact id' });
    }

    const assocR = await axios.get(
      `${HS}/crm/v3/objects/contacts/${contactId}/associations/tasks`,
      { headers: hsHeaders() }
    );
    const taskIds = assocR.data.results?.map(r => r.id) || [];
    if (!taskIds.length) return res.json({ results: [] });

    const taskR = await axios.post(
      `${HS}/crm/v3/objects/tasks/batch/read`,
      {
        properties: ['hs_task_subject', 'hs_timestamp', 'hs_task_status', 'hs_task_body'],
        inputs: taskIds.map(id => ({ id }))
      },
      { headers: hsHeaders() }
    );
    res.json(taskR.data);
  } catch (e) {
    console.error('GET /api/contacts/:id/tasks HubSpot error:', e.response?.data || e.message);
    res.json({ results: [] });
  }
});

// Bulk task-urgency aggregator used by the Customers list. Accepts up to 100
// contact ids and returns `{ urgency: { [id]: 'red'|'orange'|null } }` so the
// React page can populate the per-card urgency dot in a single round-trip
// instead of one tasks fetch per contact.
app.post('/api/contacts/urgency', isAuthenticated, requireHubspotToken, async (req, res) => {
  try {
    const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const ids = Array.from(new Set(rawIds.map(v => String(v)).filter(v => /^\d+$/.test(v)))).slice(0, 100);
    const urgency = {};
    for (const id of ids) urgency[id] = null;
    if (!ids.length) return res.json({ urgency });

    // Batch read contact→task associations.
    let assocResults = [];
    try {
      const assocR = await hubspotRequestWithRetry(
        'post',
        `${HS}/crm/v4/associations/contacts/tasks/batch/read`,
        { inputs: ids.map(id => ({ id })) }
      );
      assocResults = assocR.data?.results || [];
    } catch (e) {
      console.error('POST /api/contacts/urgency assoc batch error:', e.response?.data || e.message);
      return res.json({ urgency });
    }

    const taskIdsByContact = new Map();
    const allTaskIds = new Set();
    for (const row of assocResults) {
      const fromId = String(row?.from?.id || '');
      if (!fromId) continue;
      const tos = Array.isArray(row?.to) ? row.to : [];
      const taskIds = tos.map(t => String(t?.toObjectId ?? t?.id ?? '')).filter(Boolean);
      taskIdsByContact.set(fromId, taskIds);
      for (const t of taskIds) allTaskIds.add(t);
    }
    if (!allTaskIds.size) return res.json({ urgency });

    // Batch read task properties (HubSpot batch/read accepts up to 100 inputs).
    const tasksById = new Map();
    const allTaskIdList = Array.from(allTaskIds);
    for (let i = 0; i < allTaskIdList.length; i += 100) {
      const chunk = allTaskIdList.slice(i, i + 100);
      try {
        const taskR = await hubspotRequestWithRetry(
          'post',
          `${HS}/crm/v3/objects/tasks/batch/read`,
          {
            properties: ['hs_task_status', 'hs_timestamp'],
            inputs: chunk.map(id => ({ id })),
          }
        );
        for (const t of (taskR.data?.results || [])) tasksById.set(String(t.id), t);
      } catch (e) {
        console.error('POST /api/contacts/urgency task batch error (chunk skipped):', e.response?.data || e.message);
      }
    }

    // Compute urgency using the same working-day window as the client's
    // getTaskUrgency() in public/workflow-core.js.
    const workingDayDeadline = (n) => {
      const d = new Date();
      let added = 0;
      while (added < n) {
        d.setDate(d.getDate() + 1);
        if (d.getDay() !== 0 && d.getDay() !== 6) added++;
      }
      d.setHours(23, 59, 59, 999);
      return d.getTime();
    };
    const one = workingDayDeadline(1);
    const two = workingDayDeadline(2);

    for (const [contactId, taskIds] of taskIdsByContact) {
      let u = null;
      for (const tid of taskIds) {
        const t = tasksById.get(tid);
        if (!t) continue;
        if (t.properties?.hs_task_status === 'COMPLETED') continue;
        const due = parseInt(t.properties?.hs_timestamp || '0', 10);
        if (!due) continue;
        if (due <= one) { u = 'red'; break; }
        if (due <= two && u !== 'red') u = 'orange';
      }
      urgency[contactId] = u;
    }
    res.json({ urgency });
  } catch (_e) {
    res.json({ urgency: {} });
  }
});

app.post('/api/contacts/:id/tasks', isAuthenticated, requirePrivilege('member'), requireHubspotToken, hubspotMutationLimiter, async (req, res) => {
  try {
    const { subject, dueDate, stageKey } = req.body;
    const contactId = req.params.id;
    if (!/^\d+$/.test(contactId)) {
      return res.status(400).json({ error: 'Invalid contact id' });
    }

    const properties = {
      hs_task_subject: subject,
      hs_task_status: 'NOT_STARTED',
      hs_task_type: 'TODO'
    };
    if (dueDate) properties.hs_timestamp = new Date(dueDate + 'T12:00:00').toISOString();
    if (stageKey) properties.hs_task_body = `TASK_STAGE:${stageKey}`;

    const taskR = await hubspotRequestWithRetry('post',
      `${HS}/crm/v3/objects/tasks`,
      { properties }
    );
    await hubspotRequestWithRetry('put',
      `${HS}/crm/v3/objects/tasks/${taskR.data.id}/associations/contacts/${contactId}/task_to_contact`,
      {}
    );
    res.json(taskR.data);
  } catch (e) {
    const status = e.response?.status;
    if (status === 401 || status === 403) {
      return res.status(502).json({ error: 'HubSpot rejected the request — the token may be invalid or expired.', code: 'HUBSPOT_AUTH' });
    }
    if (status === 429) {
      return res.status(502).json({ error: 'HubSpot rate limit reached. Please wait a moment and try again.', code: 'HUBSPOT_RATE_LIMIT' });
    }
    console.error('POST /api/contacts/:id/tasks HubSpot error:', e.response?.data || e.message);
    res.status(502).json({ error: e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
  }
});

app.patch('/api/tasks/:id', isAuthenticated, requirePrivilege('member'), requireHubspotToken, hubspotMutationLimiter, async (req, res) => {
  try {
    const taskId = req.params.id;
    if (!/^\d+$/.test(taskId)) {
      return res.status(400).json({ error: 'Invalid task id' });
    }

    // Require the caller to identify the parent contact so we can verify the
    // task actually belongs to it before mutating it (object-binding check).
    const contactId = req.body.contactId != null ? String(req.body.contactId) : '';
    if (!contactId || !/^\d+$/.test(contactId)) {
      return res.status(400).json({ error: 'contactId is required.' });
    }
    const taskLinked = await verifyTaskAssociation(taskId, 'contacts', contactId);
    if (!taskLinked) {
      return res.status(403).json({ error: 'Task is not associated with this contact.' });
    }

    const TASK_ALLOWED = ['hs_task_status', 'hs_task_subject', 'hs_task_body', 'hs_timestamp', 'hs_task_priority', 'hs_task_type'];
    const properties = {};
    for (const key of TASK_ALLOWED) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        properties[key] = req.body[key];
      }
    }
    if (Object.keys(properties).length === 0) {
      return res.status(400).json({ error: 'No valid properties to update.' });
    }

    const r = await hubspotRequestWithRetry('patch',
      `${HS}/crm/v3/objects/tasks/${taskId}`,
      { properties }
    );
    res.json(r.data);
  } catch (e) {
    const status = e.response?.status;
    if (status === 401 || status === 403) {
      return res.status(502).json({ error: 'HubSpot rejected the request — the token may be invalid or expired.', code: 'HUBSPOT_AUTH' });
    }
    if (status === 429) {
      return res.status(502).json({ error: 'HubSpot rate limit reached. Please wait a moment and try again.', code: 'HUBSPOT_RATE_LIMIT' });
    }
    console.error('PATCH /api/tasks/:id HubSpot error:', e.response?.data || e.message);
    res.status(502).json({ error: e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
  }
});

app.delete('/api/tasks/:id', isAuthenticated, requirePrivilege('member'), requireHubspotToken, hubspotMutationLimiter, async (req, res) => {
  try {
    const taskId = req.params.id;
    if (!/^\d+$/.test(taskId)) {
      return res.status(400).json({ error: 'Invalid task id' });
    }

    // Require the caller to identify the parent contact so we can verify the
    // task actually belongs to it before deleting it (object-binding check).
    const contactId = req.body.contactId != null ? String(req.body.contactId) : '';
    if (!contactId || !/^\d+$/.test(contactId)) {
      return res.status(400).json({ error: 'contactId is required.' });
    }
    const taskLinked = await verifyTaskAssociation(taskId, 'contacts', contactId);
    if (!taskLinked) {
      return res.status(403).json({ error: 'Task is not associated with this contact.' });
    }

    await hubspotRequestWithRetry('delete',
      `${HS}/crm/v3/objects/tasks/${taskId}`,
      null
    );
    res.json({ success: true });
  } catch (e) {
    const status = e.response?.status;
    if (status === 401 || status === 403) {
      return res.status(502).json({ error: 'HubSpot rejected the request — the token may be invalid or expired.', code: 'HUBSPOT_AUTH' });
    }
    if (status === 429) {
      return res.status(502).json({ error: 'HubSpot rate limit reached. Please wait a moment and try again.', code: 'HUBSPOT_RATE_LIMIT' });
    }
    console.error('DELETE /api/tasks/:id HubSpot error:', e.response?.data || e.message);
    res.status(502).json({ error: e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
  }
});

// ── HubSpot: Batch Workflow Stages (for customer list pre-population) ─────────
const WORKFLOW_STAGES_CACHE_TTL_MS = 300_000; // 5 minutes
let _workflowStagesCache = null;    // { data, expiresAt }
let _workflowStagesInflight = null; // Promise while a scan is running

async function fetchWorkflowStagesFromHubspot() {
  // Search for all notes that store workflow data
  const searchR = await hubspotRequestWithRetry(
    'post',
    `${HS}/crm/v3/objects/notes/search`,
    {
      filterGroups: [{ filters: [{ propertyName: 'hs_note_body', operator: 'CONTAINS_TOKEN', value: 'WORKFLOW_DATA' }] }],
      properties: ['hs_note_body'],
      limit: 200
    }
  );

  const notes = (searchR.data.results || []).filter(n =>
    n.properties?.hs_note_body?.startsWith('WORKFLOW_DATA:')
  );
  if (!notes.length) return {};

  // Batch read note → contact associations
  const assocR = await hubspotRequestWithRetry(
    'post',
    `${HS}/crm/v4/associations/notes/contacts/batch/read`,
    { inputs: notes.map(n => ({ id: n.id })) }
  );

  // Parse each note into rooms array
  const noteData = {};
  notes.forEach(n => {
    try {
      const json = JSON.parse(n.properties.hs_note_body.slice('WORKFLOW_DATA:'.length));
      const arr = Array.isArray(json)
        ? json
        : [{ room: 'Main', stageKey: json.stageKey || 'sales' }];
      noteData[n.id] = arr.map(r => ({
        room:     r.room     || 'Main',
        stageKey: r.stageKey || 'sales',
      }));
    } catch {}
  });

  // Build contactId → rooms map
  const result = {};
  (assocR.data.results || []).forEach(r => {
    const noteId    = r.from?.id;
    const contactId = r.to?.[0]?.toObjectId;
    if (noteId && contactId && noteData[noteId]) {
      result[String(contactId)] = noteData[noteId];
    }
  });

  return result;
}

app.get('/api/workflow-stages', isAuthenticated, async (req, res) => {
  try {
    // Serve from cache if still fresh
    if (_workflowStagesCache && Date.now() < _workflowStagesCache.expiresAt) {
      return res.json(_workflowStagesCache.data);
    }

    // If a scan is already running, piggyback on it
    if (!_workflowStagesInflight) {
      _workflowStagesInflight = fetchWorkflowStagesFromHubspot().finally(() => {
        _workflowStagesInflight = null;
      });
    }

    const data = await _workflowStagesInflight;
    _workflowStagesCache = { data, expiresAt: Date.now() + WORKFLOW_STAGES_CACHE_TTL_MS };
    res.json(data);
  } catch (e) {
    console.error('GET /api/workflow-stages HubSpot error:', e.response?.data || e.message);
    res.json({});
  }
});

// ── Workflow Config ───────────────────────────────────────────────────────────
const WORKFLOW_FILE = path.join(__dirname, 'workflow.json');

app.get('/api/workflow', (req, res) => {
  try {
    const data = fs.existsSync(WORKFLOW_FILE)
      ? JSON.parse(fs.readFileSync(WORKFLOW_FILE, 'utf8'))
      : null;
    res.json(data);
  } catch {
    res.json(null);
  }
});

const IDENTIFIER_RE = /^[A-Za-z0-9_-]{1,64}$/;

function validateWorkflow(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Invalid workflow object';
  if (!body.stages || typeof body.stages !== 'object' || Array.isArray(body.stages)) return 'Missing or invalid stages';
  for (const [stageKey, stage] of Object.entries(body.stages)) {
    if (!IDENTIFIER_RE.test(stageKey)) return `Invalid stage key: "${stageKey}"`;
    if (stage && Array.isArray(stage.statuses)) {
      for (const status of stage.statuses) {
        if (status.id !== undefined && !IDENTIFIER_RE.test(String(status.id))) {
          return `Invalid status id: "${status.id}" in stage "${stageKey}"`;
        }
      }
    }
  }
  return null;
}

app.post('/api/workflow', isAuthenticated, requireManagerOrAdmin, (req, res) => {
  const err = validateWorkflow(req.body);
  if (err) return res.status(400).json({ error: err });
  fs.writeFileSync(WORKFLOW_FILE, JSON.stringify(req.body, null, 2));
  res.json({ success: true });
});

// ── Personal Tasks (local JSON) ───────────────────────────────────────────────
const PERSONAL_TASKS_FILE = path.join(DATA_DIR, '__personal_tasks.json');

function readPersonalTasks() {
  try { return JSON.parse(fs.readFileSync(PERSONAL_TASKS_FILE, 'utf8')); } catch { return []; }
}
function writePersonalTasks(tasks) {
  fs.writeFileSync(PERSONAL_TASKS_FILE, JSON.stringify(tasks, null, 2));
}

app.get('/api/users/me/prefs', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.claims.sub;
    const r = await pool.query('SELECT prefs FROM users WHERE id = $1', [userId]);
    res.json(r.rows[0]?.prefs || {});
  } catch (e) {
    console.error('GET /api/users/me/prefs error:', e);
    res.status(500).json({ error: 'Failed to load preferences' });
  }
});

const VALID_NAV_KEYS = new Set(['home', 'sales', 'survey', 'projects', 'calendar', 'invoices', 'trades', 'ideas']);
const NAV_BAR_SIZE = 3;

app.patch('/api/users/me/prefs', isAuthenticated, prefsWriteLimiter, async (req, res) => {
  try {
    const userId = req.user.claims.sub;
    const patch = req.body;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return res.status(400).json({ error: 'Body must be a JSON object' });
    }
    if ('nav_primary_keys' in patch) {
      const keys = patch.nav_primary_keys;
      if (
        !Array.isArray(keys) ||
        keys.length !== NAV_BAR_SIZE ||
        !keys.every((k) => typeof k === 'string' && VALID_NAV_KEYS.has(k)) ||
        new Set(keys).size !== NAV_BAR_SIZE
      ) {
        return res.status(400).json({
          error: `nav_primary_keys must be an array of exactly ${NAV_BAR_SIZE} unique valid nav keys`,
        });
      }
    }
    const r = await pool.query(
      `UPDATE users SET prefs = prefs || $1::jsonb, updated_at = NOW()
       WHERE id = $2 RETURNING prefs`,
      [JSON.stringify(patch), userId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'User not found' });
    res.json(r.rows[0].prefs);
  } catch (e) {
    console.error('PATCH /api/users/me/prefs error:', e);
    res.status(500).json({ error: 'Failed to save preferences' });
  }
});

app.get('/api/personal-tasks', (req, res) => {
  const userId = req.user.claims.sub;
  res.json(readPersonalTasks().filter(t => t.userId === userId));
});

app.post('/api/personal-tasks', isAuthenticated, requirePrivilege('member'), personalTaskCreateLimiter, (req, res) => {
  const userId = req.user.claims.sub;
  const tasks = readPersonalTasks();
  const task = {
    id: Date.now().toString(),
    userId,
    title: (req.body.title || '').trim(),
    dueDate: req.body.dueDate || null,
    done: false,
    createdAt: new Date().toISOString()
  };
  if (!task.title) return res.status(400).json({ error: 'Title required' });
  tasks.push(task);
  writePersonalTasks(tasks);
  res.json(task);
});

app.patch('/api/personal-tasks/:id', isAuthenticated, requirePrivilege('member'), (req, res) => {
  const userId = req.user.claims.sub;
  const tasks = readPersonalTasks();
  const idx = tasks.findIndex(t => t.id === req.params.id && t.userId === userId);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const { userId: _uid, id: _id, createdAt: _ca, ...allowed } = req.body;
  tasks[idx] = { ...tasks[idx], ...allowed };
  writePersonalTasks(tasks);
  res.json(tasks[idx]);
});

app.delete('/api/personal-tasks/:id', isAuthenticated, requirePrivilege('member'), (req, res) => {
  const userId = req.user.claims.sub;
  const tasks = readPersonalTasks();
  const idx = tasks.findIndex(t => t.id === req.params.id && t.userId === userId);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  writePersonalTasks(tasks.filter(t => t.id !== req.params.id || t.userId !== userId));
  res.json({ success: true });
});

// ── Trades Directory ──────────────────────────────────────────────────────────
const _tradesPool = new (require('pg').Pool)({ connectionString: process.env.DATABASE_URL });

function sanitizeWebsite(raw) {
  const url = (raw || '').trim();
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return url;
}

const TRADE_CATEGORIES = [
  'Carpentry / Roofing',
  'Carpet Fitting',
  'Electrical',
  'Handyman Services',
  'Internal Joinery',
  'Landscaping / Outdoors',
  'Painting + Decorating',
  'Plasterer',
  'Plumbing',
];

const TRADE_AREAS = [
  'Anglesey',
  'Chester Only',
  'Cheshire',
  'Greater Manchester',
  'Liverpool',
  'North Wales',
  'Wirral',
  'Wrexham',
];

function parseAreasServed(val) {
  if (!val) return [];
  try {
    const p = JSON.parse(val);
    if (Array.isArray(p)) return p;
  } catch {}
  return val.split(',').map(s => s.trim()).filter(Boolean);
}

function serializeAreasServed(val) {
  if (Array.isArray(val)) return JSON.stringify(val.filter(a => TRADE_AREAS.includes(a)));
  if (typeof val === 'string' && val.startsWith('[')) {
    try { return JSON.stringify(JSON.parse(val).filter(a => TRADE_AREAS.includes(a))); } catch {}
  }
  return JSON.stringify([]);
}

function actorDisplayName(claims) {
  if (!claims) return null;
  const name = [claims.first_name, claims.last_name].filter(Boolean).join(' ').trim();
  if (name) return name;
  if (claims.email) return claims.email;
  return claims.sub || null;
}

async function ensureTradesTable() {
  await _tradesPool.query(`
    CREATE TABLE IF NOT EXISTS trade_contacts (
      id             SERIAL PRIMARY KEY,
      name           VARCHAR NOT NULL,
      trade_type     VARCHAR NOT NULL,
      phone          VARCHAR,
      email          VARCHAR,
      areas_served   TEXT,
      company_name   VARCHAR,
      timescale      VARCHAR,
      invoice_method VARCHAR,
      payment_terms  VARCHAR,
      notes          TEXT,
      created_by     VARCHAR,
      created_at     TIMESTAMP DEFAULT NOW()
    );
  `);
  await _tradesPool.query(`
    CREATE TABLE IF NOT EXISTS trade_companies (
      id             SERIAL PRIMARY KEY,
      company_name   VARCHAR NOT NULL,
      trade_type     VARCHAR NOT NULL,
      areas_served   TEXT,
      timescale      VARCHAR,
      invoice_method VARCHAR,
      payment_terms  VARCHAR,
      notes          TEXT,
      created_by     VARCHAR,
      created_at     TIMESTAMP DEFAULT NOW(),
      legacy_id      INTEGER
    );
  `);
  await _tradesPool.query(`ALTER TABLE trade_companies ADD COLUMN IF NOT EXISTS updated_by VARCHAR`);
  await _tradesPool.query(`ALTER TABLE trade_companies ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP`);
  await _tradesPool.query(`ALTER TABLE trade_companies ADD COLUMN IF NOT EXISTS created_by_name VARCHAR`);
  await _tradesPool.query(`ALTER TABLE trade_companies ADD COLUMN IF NOT EXISTS updated_by_name VARCHAR`);
  await _tradesPool.query(`ALTER TABLE trade_companies ADD COLUMN IF NOT EXISTS timescale_updated_at TIMESTAMP`);
  await _tradesPool.query(`ALTER TABLE trade_companies ADD COLUMN IF NOT EXISTS website VARCHAR`);
  await _tradesPool.query(`ALTER TABLE trade_companies ADD COLUMN IF NOT EXISTS company_phone VARCHAR`);
  await _tradesPool.query(`ALTER TABLE trade_company_contacts ADD COLUMN IF NOT EXISTS preferred_contact VARCHAR`);
  await _tradesPool.query(`ALTER TABLE trade_company_submissions ADD COLUMN IF NOT EXISTS website VARCHAR`);
  await _tradesPool.query(`ALTER TABLE trade_company_submissions ADD COLUMN IF NOT EXISTS company_phone VARCHAR`);
  await _tradesPool.query(`
    CREATE TABLE IF NOT EXISTS trade_audit_log (
      id         SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES trade_companies(id) ON DELETE CASCADE,
      actor_id   VARCHAR,
      actor_name VARCHAR,
      action     VARCHAR NOT NULL,
      changed_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await _tradesPool.query(`
    CREATE TABLE IF NOT EXISTS trade_company_contacts (
      id         SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES trade_companies(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      name       VARCHAR NOT NULL,
      role       VARCHAR,
      phone      VARCHAR,
      email      VARCHAR
    );
  `);
  await _tradesPool.query(`
    CREATE TABLE IF NOT EXISTS trade_company_submissions (
      id               SERIAL PRIMARY KEY,
      company_name     VARCHAR NOT NULL,
      trade_type       VARCHAR NOT NULL,
      areas_served     TEXT,
      timescale        VARCHAR,
      invoice_method   VARCHAR,
      payment_terms    VARCHAR,
      notes            TEXT,
      contacts         JSONB NOT NULL DEFAULT '[]',
      submitter_id     VARCHAR,
      submitter_email  VARCHAR,
      submitter_name   VARCHAR,
      status           VARCHAR NOT NULL DEFAULT 'pending',
      reviewer_id      VARCHAR,
      reviewer_email   VARCHAR,
      reviewer_name    VARCHAR,
      rejection_reason TEXT,
      created_at       TIMESTAMP DEFAULT NOW(),
      reviewed_at      TIMESTAMP
    );
  `);
  const { rows: unmigratedRows } = await _tradesPool.query(`
    SELECT * FROM trade_contacts
    WHERE id NOT IN (
      SELECT legacy_id FROM trade_companies WHERE legacy_id IS NOT NULL
    )
    ORDER BY created_at ASC
  `);
  for (const row of unmigratedRows) {
    const coName = (row.company_name || '').trim() || row.name;
    const { rows: [co] } = await _tradesPool.query(
      `INSERT INTO trade_companies
        (company_name, trade_type, areas_served, timescale, invoice_method, payment_terms, notes, created_by, created_at, legacy_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [coName, row.trade_type, row.areas_served || '', row.timescale || '',
       row.invoice_method || '', row.payment_terms || '', row.notes || '',
       row.created_by, row.created_at, row.id]
    );
    await _tradesPool.query(
      `INSERT INTO trade_company_contacts (company_id, sort_order, name, role, phone, email)
       VALUES ($1, 0, $2, '', $3, $4)`,
      [co.id, row.name, row.phone || '', row.email || '']
    );
  }

  // Backfill audit log for companies that pre-date the audit feature
  const { rows: companiesWithoutAudit } = await _tradesPool.query(`
    SELECT tc.id, tc.created_by, tc.created_by_name, tc.created_at,
           tc.updated_by, tc.updated_by_name, tc.updated_at
    FROM trade_companies tc
    WHERE NOT EXISTS (
      SELECT 1 FROM trade_audit_log al WHERE al.company_id = tc.id
    )
    ORDER BY tc.created_at ASC
  `);
  for (const co of companiesWithoutAudit) {
    await _tradesPool.query(
      `INSERT INTO trade_audit_log (company_id, actor_id, actor_name, action, changed_at)
       VALUES ($1, $2, $3, 'Company created', $4)`,
      [co.id, co.created_by || null, co.created_by_name || null, co.created_at || new Date()]
    );
    if (co.updated_at) {
      await _tradesPool.query(
        `INSERT INTO trade_audit_log (company_id, actor_id, actor_name, action, changed_at)
         VALUES ($1, $2, $3, 'Updated (migrated)', $4)`,
        [co.id, co.updated_by || null, co.updated_by_name || null, co.updated_at]
      );
    }
  }
}

// Admin page: handle auth/authorization with page-friendly responses so users
// see a redirect to login or a friendly "no access" page instead of raw JSON
// or a confusing 404.
app.get('/admin', async (req, res) => {
  const isAuthed = req.isAuthenticated && req.isAuthenticated();
  if (!isAuthed || !req.user?.claims) {
    return res.redirect('/login');
  }
  const userId = req.user.claims.sub;
  let admin = false;
  if (userId) {
    try {
      const r = await pool.query('SELECT privilege_level FROM users WHERE id = $1', [userId]);
      admin = r.rows[0]?.privilege_level === 'admin';
    } catch (e) {
      console.error('GET /admin admin check failed:', e);
    }
  }
  if (!admin) {
    return res.status(403).send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Access denied · Measure Once</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background: #f5f4f1; color: #1c1917; margin: 0;
         min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card { background: #fff; border: 2px solid #d6d3d1; border-radius: 12px;
          max-width: 440px; width: 100%; padding: 36px; text-align: center;
          box-shadow: 0 2px 6px rgba(0,0,0,.06); }
  .logo-wrap { text-align: center; margin-bottom: 28px; }
  .logo-wrap img { max-width: 180px; width: 100%; height: auto; display: inline-block; }
  h1 { font-size: 1.4rem; font-weight: 700; margin: 0 0 8px; color: #0f0f0e; letter-spacing: -.01em; }
  p { color: #44403c; font-size: .95rem; margin: 0 0 28px; line-height: 1.5; }
  a { display: inline-block; background: #3d0f7a; color: #fff; text-decoration: none;
      padding: 14px 28px; border-radius: 8px; font-weight: 700; font-size: 1rem;
      letter-spacing: .02em; transition: background .15s ease; }
  a:hover { background: #5a1fad; }
</style></head>
<body><div class="card">
  <div class="logo-wrap"><img src="/harry-wardrobes-logo.png" alt="Harry Wardrobes"></div>
  <h1>Admin access required</h1>
  <p>You're signed in, but your account doesn't have admin permissions. If you think this is a mistake, contact an admin.</p>
  <a href="/profile">Back to your profile</a>
</div></body></html>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Admin database editor. Non-admins (including unauthenticated users) get a
// 404 so the page is indistinguishable from a non-existent route — we do not
// reveal that an admin-only editor lives at this path.
app.get('/admin/database', async (req, res) => {
  const notFound = () => res.status(404).type('html').send(
    '<!doctype html><meta charset="utf-8"><title>Not found</title>' +
    '<div style="font-family:system-ui;padding:40px;max-width:480px;margin:auto;">' +
    '<h1 style="margin:0 0 8px;font-size:1.4rem;">404 · Not found</h1>' +
    '<p style="color:#555;">The page you requested does not exist.</p></div>'
  );
  const isAuthed = req.isAuthenticated && req.isAuthenticated();
  if (!isAuthed || !req.user?.claims) return notFound();
  const userId = req.user.claims.sub;
  let admin = false;
  if (userId) {
    try {
      const r = await pool.query('SELECT privilege_level FROM users WHERE id = $1', [userId]);
      admin = r.rows[0]?.privilege_level === 'admin';
    } catch (e) {
      console.error('GET /admin/database admin check failed:', e);
    }
  }
  if (!admin) return notFound();
  res.sendFile(path.join(__dirname, 'public', 'database.html'));
});

installDbEditorRoutes(app, { isAuthenticated, requireAdmin });

app.get('/trades', isAuthenticated, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'trades.html'));
});

// Sales, Projects, Invoices — manager/admin only
function requireManagerOrAdminPage(req, res, next) {
  if (!req.isAuthenticated || !req.isAuthenticated()) return res.redirect('/login');
  const priv = getReqPrivilege(req);
  if (priv === 'manager' || priv === 'admin') return next();
  return res.redirect('/access-restricted');
}

app.get('/access-restricted', isAuthenticated, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'access-restricted.html'));
});

app.get('/sales',    isAuthenticated, requireManagerOrAdminPage, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sales.html'));
});
app.get('/survey',   isAuthenticated, requireManagerOrAdminPage, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'survey.html'));
});
app.get('/projects', isAuthenticated, requireManagerOrAdminPage, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'projects.html'));
});
app.get('/invoices', isAuthenticated, requireManagerOrAdminPage, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'invoices.html'));
});

app.get('/api/trades', isAuthenticated, requireManagerOrAdmin, async (req, res) => {
  try {
    const { rows: companies } = await _tradesPool.query(`
      SELECT
        tc.*,
        u_c.email AS created_email,
        u_c.first_name AS created_first, u_c.last_name AS created_last,
        u_u.email AS updated_email,
        u_u.first_name AS updated_first, u_u.last_name AS updated_last
      FROM trade_companies tc
      LEFT JOIN users u_c ON u_c.id = tc.created_by
      LEFT JOIN users u_u ON u_u.id = tc.updated_by
      ORDER BY tc.created_at DESC
    `);
    const { rows: contacts } = await _tradesPool.query(
      `SELECT * FROM trade_company_contacts ORDER BY company_id, sort_order, id`
    );
    const contactMap = {};
    for (const c of contacts) {
      if (!contactMap[c.company_id]) contactMap[c.company_id] = [];
      contactMap[c.company_id].push(c);
    }
    const result = companies.map(co => ({
      ...co,
      areas_served: parseAreasServed(co.areas_served),
      created_by_name: [co.created_first, co.created_last].filter(Boolean).join(' ') || co.created_email || co.created_by_name || null,
      updated_by_name: [co.updated_first, co.updated_last].filter(Boolean).join(' ') || co.updated_email || co.updated_by_name || null,
      contacts: contactMap[co.id] || []
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message, code: 'DB_ERROR' });
  }
});

app.post('/api/trades', isAuthenticated, requireManagerOrAdmin, tradesCreateLimiter, async (req, res) => {
  const { company_name, trade_type, areas_served, timescale, notes, website, company_phone, contacts } = req.body || {};
  if (!company_name || !company_name.trim()) return res.status(400).json({ error: 'Company name is required.' });
  if (!trade_type || !trade_type.trim()) return res.status(400).json({ error: 'Trade type is required.' });
  const validContacts = (contacts || []).filter(c => c && (c.name || '').trim());
  if (!validContacts.length) return res.status(400).json({ error: 'At least one contact person with a name is required.' });
  if (validContacts.length > 3) return res.status(400).json({ error: 'A maximum of 3 contacts per company is allowed.' });
  const websiteVal = sanitizeWebsite(website);
  if ((website || '').trim() && !websiteVal) return res.status(400).json({ error: 'Website must be a valid http or https URL.' });
  const client = await _tradesPool.connect();
  try {
    await client.query('BEGIN');
    const timescaleVal = (timescale || '').trim();
    const { rows: [co] } = await client.query(
      `INSERT INTO trade_companies
        (company_name, trade_type, areas_served, timescale, notes, website, company_phone, created_by, created_by_name, timescale_updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [company_name.trim(), trade_type.trim(), serializeAreasServed(areas_served),
       timescaleVal, (notes || '').trim(),
       websiteVal, (company_phone || '').trim() || null,
       req.user?.claims?.sub || null,
       actorDisplayName(req.user?.claims),
       timescaleVal ? new Date() : null]
    );
    const insertedContacts = [];
    for (let i = 0; i < validContacts.length; i++) {
      const ct = validContacts[i];
      const { rows: [cc] } = await client.query(
        `INSERT INTO trade_company_contacts (company_id, sort_order, name, role, phone, email, preferred_contact)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [co.id, i, ct.name.trim(), (ct.role || '').trim(), (ct.phone || '').trim(), (ct.email || '').trim(), (ct.preferred_contact || '').trim() || null]
      );
      insertedContacts.push(cc);
    }
    await client.query(
      `INSERT INTO trade_audit_log (company_id, actor_id, actor_name, action) VALUES ($1,$2,$3,$4)`,
      [co.id, req.user?.claims?.sub || null, actorDisplayName(req.user?.claims), 'Company created']
    );
    await client.query('COMMIT');
    res.status(201).json({ ...co, areas_served: parseAreasServed(co.areas_served), contacts: insertedContacts });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message, code: 'DB_ERROR' });
  } finally {
    client.release();
  }
});

app.put('/api/trades/:id', isAuthenticated, requireManagerOrAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id.' });
  const { company_name, trade_type, areas_served, timescale, notes, website, company_phone, contacts } = req.body || {};
  if (!company_name || !company_name.trim()) return res.status(400).json({ error: 'Company name is required.' });
  if (!trade_type || !trade_type.trim()) return res.status(400).json({ error: 'Trade type is required.' });
  const validContacts = (contacts || []).filter(c => c && (c.name || '').trim());
  if (!validContacts.length) return res.status(400).json({ error: 'At least one contact person with a name is required.' });
  if (validContacts.length > 3) return res.status(400).json({ error: 'A maximum of 3 contacts per company is allowed.' });
  const websiteVal = sanitizeWebsite(website);
  if ((website || '').trim() && !websiteVal) return res.status(400).json({ error: 'Website must be a valid http or https URL.' });
  const client = await _tradesPool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [prev] } = await client.query(`SELECT * FROM trade_companies WHERE id=$1`, [id]);
    if (!prev) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Company not found.' }); }
    const { rows: prevContacts } = await client.query(
      `SELECT name, role, phone, email, preferred_contact FROM trade_company_contacts WHERE company_id=$1 ORDER BY sort_order, id`, [id]
    );
    const timescaleVal = (timescale || '').trim();
    const timescaleChanged = prev.timescale !== timescaleVal;
    const { rows: [co], rowCount } = await client.query(
      `UPDATE trade_companies
       SET company_name=$1, trade_type=$2, areas_served=$3, timescale=$4,
           notes=$5, updated_by=$6, updated_at=NOW(), updated_by_name=$8,
           timescale_updated_at = CASE WHEN $9 THEN NOW() ELSE timescale_updated_at END,
           website=$10, company_phone=$11
       WHERE id=$7 RETURNING *`,
      [company_name.trim(), trade_type.trim(), serializeAreasServed(areas_served),
       timescaleVal, (notes || '').trim(),
       req.user?.claims?.sub || null, id,
       actorDisplayName(req.user?.claims), timescaleChanged,
       websiteVal, (company_phone || '').trim() || null]
    );
    if (!rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Company not found.' }); }
    await client.query(`DELETE FROM trade_company_contacts WHERE company_id=$1`, [id]);
    const insertedContacts = [];
    for (let i = 0; i < validContacts.length; i++) {
      const ct = validContacts[i];
      const { rows: [cc] } = await client.query(
        `INSERT INTO trade_company_contacts (company_id, sort_order, name, role, phone, email, preferred_contact)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [id, i, ct.name.trim(), (ct.role || '').trim(), (ct.phone || '').trim(), (ct.email || '').trim(), (ct.preferred_contact || '').trim() || null]
      );
      insertedContacts.push(cc);
    }
    const changedFields = [];
    if (prev.company_name !== company_name.trim()) changedFields.push('company name');
    if (prev.trade_type !== trade_type.trim()) changedFields.push('category');
    if (timescaleChanged) changedFields.push('lead time');
    if (prev.notes !== (notes || '').trim()) changedFields.push('notes');
    if ((prev.website || '') !== ((website || '').trim())) changedFields.push('website');
    if ((prev.company_phone || '') !== ((company_phone || '').trim())) changedFields.push('company phone');
    const prevAreasStr = serializeAreasServed(parseAreasServed(prev.areas_served));
    const newAreasStr  = serializeAreasServed(areas_served);
    if (prevAreasStr !== newAreasStr) changedFields.push('areas served');
    const prevContactsSig = prevContacts.map(c => `${c.name}|${c.role}|${c.phone}|${c.email}|${c.preferred_contact||''}`).join(';');
    const newContactsSig  = validContacts.map(c => `${c.name.trim()}|${(c.role||'').trim()}|${(c.phone||'').trim()}|${(c.email||'').trim()}|${(c.preferred_contact||'').trim()}`).join(';');
    if (prevContactsSig !== newContactsSig) changedFields.push('contacts');
    const action = changedFields.length ? `Updated ${changedFields.join(', ')}` : 'Saved (no changes)';
    await client.query(
      `INSERT INTO trade_audit_log (company_id, actor_id, actor_name, action) VALUES ($1,$2,$3,$4)`,
      [id, req.user?.claims?.sub || null, actorDisplayName(req.user?.claims), action]
    );
    await client.query('COMMIT');
    res.json({ ...co, areas_served: parseAreasServed(co.areas_served), contacts: insertedContacts });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message, code: 'DB_ERROR' });
  } finally {
    client.release();
  }
});

app.get('/api/trades/:id/audit', isAuthenticated, requireManagerOrAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const { rows } = await _tradesPool.query(
      `SELECT actor_name, action, changed_at FROM trade_audit_log WHERE company_id=$1 ORDER BY changed_at DESC LIMIT 50`,
      [id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message, code: 'DB_ERROR' });
  }
});

app.delete('/api/trades/:id', isAuthenticated, requireManagerOrAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const r = await _tradesPool.query(`DELETE FROM trade_companies WHERE id=$1`, [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Company not found.' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message, code: 'DB_ERROR' });
  }
});

// ── Cross-surface phone-number directory ─────────────────────────────────────
// Used by the admin Team page and the Trades modal to flag a phone number that
// is already in use somewhere else (team metadata, trade-company contacts, or
// HubSpot customer contacts). Gated to manager+admin because trades surfaces
// require that level, and team-side callers are already admin-only.
app.get('/api/admin/phone-directory', isAuthenticated, requireManagerOrAdmin, async (req, res) => {
  try {
    const out = { team: [], trades: [], customers: [] };

    // Team: users joined with allowed_emails metadata.
    try {
      const r = await pool.query(
        `SELECT u.id, u.email, u.first_name, u.last_name, ae.metadata
           FROM users u
           LEFT JOIN allowed_emails ae ON LOWER(u.email) = ae.email
           ORDER BY u.created_at DESC LIMIT 500`
      );
      for (const row of r.rows) {
        const m = row.metadata || {};
        const label = [row.first_name, row.last_name].filter(Boolean).join(' ') || row.email || '—';
        if (m.mobile_number) {
          out.team.push({ kind: 'user', userId: row.id, email: row.email, label, field: 'mobile_number', phone: m.mobile_number });
        }
        if (m.ec_phone) {
          out.team.push({ kind: 'user', userId: row.id, email: row.email, label, field: 'ec_phone', phone: m.ec_phone });
        }
      }
      // Approved allow-list rows that don't yet have a corresponding users row
      // (rare, but possible). Include them under `kind: 'allowed'`.
      const a = await pool.query(
        `SELECT ae.email, ae.metadata
           FROM allowed_emails ae
           LEFT JOIN users u ON LOWER(u.email) = ae.email
          WHERE u.id IS NULL`
      );
      for (const row of a.rows) {
        const m = row.metadata || {};
        const label = [m.first_name, m.last_name].filter(Boolean).join(' ') || row.email;
        if (m.mobile_number) {
          out.team.push({ kind: 'allowed', email: row.email, label, field: 'mobile_number', phone: m.mobile_number });
        }
        if (m.ec_phone) {
          out.team.push({ kind: 'allowed', email: row.email, label, field: 'ec_phone', phone: m.ec_phone });
        }
      }
    } catch (e) {
      console.error('phone-directory: team lookup failed:', e.message);
    }

    // Trades: company_phone + each contact phone.
    try {
      const { rows: companies } = await _tradesPool.query(
        `SELECT id, company_name, company_phone FROM trade_companies`
      );
      const { rows: contacts } = await _tradesPool.query(
        `SELECT company_id, name, phone FROM trade_company_contacts`
      );
      const byId = new Map(companies.map(c => [c.id, c]));
      for (const co of companies) {
        if (co.company_phone) {
          out.trades.push({ tradeId: co.id, companyName: co.company_name || '', kind: 'company', phone: co.company_phone });
        }
      }
      for (const c of contacts) {
        if (!c.phone) continue;
        const co = byId.get(c.company_id);
        out.trades.push({
          tradeId: c.company_id,
          companyName: co ? (co.company_name || '') : '',
          kind: 'contact',
          contactName: c.name || '',
          phone: c.phone,
        });
      }
    } catch (e) {
      console.error('phone-directory: trades lookup failed:', e.message);
    }

    // Customers: HubSpot contacts (phone + mobilephone). If HubSpot is not
    // configured, return an empty list rather than failing the whole call.
    if (process.env.HUBSPOT_TOKEN) {
      try {
        const { contacts } = await getSharedContactsCache();
        for (const c of contacts) {
          if (!c || !c.id) continue;
          const p = c.properties || {};
          const label = [p.firstname, p.lastname].filter(Boolean).join(' ').trim()
            || p.email || `Contact ${c.id}`;
          if (p.phone) {
            out.customers.push({ contactId: c.id, label, field: 'phone', phone: p.phone });
          }
          if (p.mobilephone) {
            out.customers.push({ contactId: c.id, label, field: 'mobilephone', phone: p.mobilephone });
          }
        }
      } catch (e) {
        console.error('phone-directory: customer lookup failed:', e.message);
      }
    }

    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Trade Company Submissions ─────────────────────────────────────────────────

app.post('/api/trades/submissions', isAuthenticated, requireManagerOrAdmin, tradesCreateLimiter, async (req, res) => {
  const { company_name, trade_type, areas_served, timescale, invoice_method, payment_terms, notes, website, company_phone, contacts } = req.body || {};
  if (!company_name || !company_name.trim()) return res.status(400).json({ error: 'Company name is required.' });
  if (!trade_type || !trade_type.trim()) return res.status(400).json({ error: 'Trade type is required.' });
  if (!TRADE_CATEGORIES.includes(trade_type.trim())) return res.status(400).json({ error: 'Invalid trade category.' });
  const areasArr = Array.isArray(areas_served) ? areas_served : [];
  if (!areasArr.length) return res.status(400).json({ error: 'At least one area served is required.' });
  const invalidArea = areasArr.find(a => !TRADE_AREAS.includes(a));
  if (invalidArea) return res.status(400).json({ error: `Invalid area: ${invalidArea}` });
  const validContacts = (contacts || []).filter(c => c && (c.name || '').trim());
  if (!validContacts.length) return res.status(400).json({ error: 'At least one contact person with a name is required.' });
  if (validContacts.length > 3) return res.status(400).json({ error: 'A maximum of 3 contacts per company is allowed.' });
  const websiteVal = sanitizeWebsite(website);
  if ((website || '').trim() && !websiteVal) return res.status(400).json({ error: 'Website must be a valid http or https URL.' });

  const claims = req.user?.claims || {};
  const submitterId    = claims.sub || null;
  const submitterEmail = claims.email || null;
  const submitterName  = actorDisplayName(claims);

  try {
    const { rows: [sub] } = await _tradesPool.query(
      `INSERT INTO trade_company_submissions
        (company_name, trade_type, areas_served, timescale, invoice_method, payment_terms, notes,
         website, company_phone, contacts, submitter_id, submitter_email, submitter_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id, created_at`,
      [company_name.trim(), trade_type.trim(), serializeAreasServed(areas_served),
       (timescale || '').trim(), (invoice_method || '').trim(),
       (payment_terms || '').trim(), (notes || '').trim(),
       websiteVal, (company_phone || '').trim() || null,
       JSON.stringify(validContacts.map(c => ({
         name:             c.name.trim(),
         role:             (c.role             || '').trim(),
         phone:            (c.phone            || '').trim(),
         email:            (c.email            || '').trim(),
         preferred_contact:(c.preferred_contact|| '').trim(),
       }))),
       submitterId, submitterEmail, submitterName]
    );
    res.status(201).json({ id: sub.id, status: 'pending', created_at: sub.created_at });
  } catch (e) {
    res.status(500).json({ error: e.message, code: 'DB_ERROR' });
  }
});

app.get('/api/admin/trades/submissions', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const { rows } = await _tradesPool.query(
      `SELECT * FROM trade_company_submissions WHERE status='pending' ORDER BY created_at ASC`
    );
    res.json(rows.map(r => ({
      ...r,
      areas_served: parseAreasServed(r.areas_served),
      contacts: Array.isArray(r.contacts) ? r.contacts : (r.contacts ? JSON.parse(r.contacts) : []),
    })));
  } catch (e) {
    res.status(500).json({ error: e.message, code: 'DB_ERROR' });
  }
});

app.post('/api/admin/trades/submissions/:id/approve', isAuthenticated, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id.' });

  const claims = req.user?.claims || {};
  const reviewerId    = claims.sub || null;
  const reviewerEmail = claims.email || null;
  const reviewerName  = actorDisplayName(claims);

  const client = await _tradesPool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [sub] } = await client.query(
      `SELECT * FROM trade_company_submissions WHERE id=$1 AND status='pending'`, [id]
    );
    if (!sub) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Pending submission not found.' }); }

    const { rows: [co] } = await client.query(
      `INSERT INTO trade_companies
        (company_name, trade_type, areas_served, timescale, invoice_method, payment_terms, notes,
         website, company_phone, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [sub.company_name, sub.trade_type, sub.areas_served,
       sub.timescale, sub.invoice_method, sub.payment_terms, sub.notes,
       sub.website || null, sub.company_phone || null,
       sub.submitter_id, sub.submitter_name]
    );

    const contacts = Array.isArray(sub.contacts) ? sub.contacts : (sub.contacts ? JSON.parse(sub.contacts) : []);
    const insertedContacts = [];
    for (let i = 0; i < contacts.length; i++) {
      const ct = contacts[i];
      const { rows: [cc] } = await client.query(
        `INSERT INTO trade_company_contacts (company_id, sort_order, name, role, phone, email, preferred_contact)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [co.id, i, ct.name || '', ct.role || '', ct.phone || '', ct.email || '', ct.preferred_contact || null]
      );
      insertedContacts.push(cc);
    }

    await client.query(
      `INSERT INTO trade_audit_log (company_id, actor_id, actor_name, action) VALUES ($1,$2,$3,$4)`,
      [co.id, reviewerId, reviewerName,
       `Company created via submission (approved by ${reviewerName || reviewerEmail || 'admin'})`]
    );

    await client.query(
      `UPDATE trade_company_submissions
       SET status='approved', reviewer_id=$1, reviewer_email=$2, reviewer_name=$3, reviewed_at=NOW()
       WHERE id=$4`,
      [reviewerId, reviewerEmail, reviewerName, id]
    );

    await client.query('COMMIT');
    res.json({ success: true, company_id: co.id });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message, code: 'DB_ERROR' });
  } finally {
    client.release();
  }
});

app.post('/api/admin/trades/submissions/:id/reject', isAuthenticated, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id.' });

  const claims = req.user?.claims || {};
  const reviewerId    = claims.sub || null;
  const reviewerEmail = claims.email || null;
  const reviewerName  = actorDisplayName(claims);
  const reason = (req.body?.reason || '').trim();

  try {
    const { rowCount } = await _tradesPool.query(
      `UPDATE trade_company_submissions
       SET status='rejected', reviewer_id=$1, reviewer_email=$2, reviewer_name=$3,
           rejection_reason=$4, reviewed_at=NOW()
       WHERE id=$5 AND status='pending'`,
      [reviewerId, reviewerEmail, reviewerName, reason || null, id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Pending submission not found.' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message, code: 'DB_ERROR' });
  }
});

app.get('/api/admin/trades-audit', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const { rows } = await _tradesPool.query(`
      SELECT
        tal.id,
        tal.action,
        tal.actor_name,
        tal.changed_at,
        tc.id          AS company_id,
        tc.company_name,
        tc.trade_type
      FROM trade_audit_log tal
      JOIN trade_companies tc ON tc.id = tal.company_id
      ORDER BY tal.changed_at DESC
      LIMIT 500
    `);
    res.json(rows.map(r => ({
      id:           r.id,
      company_id:   r.company_id,
      company_name: r.company_name,
      trade_type:   r.trade_type,
      action:       r.action,
      actor_name:   r.actor_name,
      changed_at:   r.changed_at,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message, code: 'DB_ERROR' });
  }
});

// ── Unified Audit Log (admin actions + trade company changes) ─────────────────
app.get('/api/admin/audit-log-unified', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const limit  = Math.min(Math.max(parseInt(req.query.limit,  10) || 25, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const { rows } = await pool.query(`
      SELECT
        source,
        ts,
        admin_email,
        action_type,
        target_email,
        details,
        company_name,
        trade_type,
        action,
        actor_name
      FROM (
        SELECT
          'admin'      AS source,
          acted_at     AS ts,
          admin_email,
          action_type,
          target_email,
          details,
          NULL::text   AS company_name,
          NULL::text   AS trade_type,
          NULL::text   AS action,
          NULL::text   AS actor_name
        FROM admin_audit_log
        UNION ALL
        SELECT
          'trade'      AS source,
          tal.changed_at AS ts,
          NULL::text   AS admin_email,
          NULL::text   AS action_type,
          NULL::text   AS target_email,
          NULL::text   AS details,
          tc.company_name,
          tc.trade_type,
          tal.action,
          tal.actor_name
        FROM trade_audit_log tal
        JOIN trade_companies tc ON tc.id = tal.company_id
      ) combined
      ORDER BY ts DESC
      LIMIT $1 OFFSET $2
    `, [limit + 1, offset]);

    const hasMore = rows.length > limit;
    const items   = hasMore ? rows.slice(0, limit) : rows;
    res.json({ items, hasMore });
  } catch (e) {
    res.status(500).json({ error: e.message, code: 'DB_ERROR' });
  }
});

// ── Trade Companies Migration ─────────────────────────────────────────────────
// Keyword → fixed category mappings (order matters: more specific first)
const TRADE_TYPE_MAP = [
  { keywords: ['carpet fitting', 'carpet fitter', 'carpet'],                         category: 'Carpet Fitting' },
  { keywords: ['electrician', 'electrical', 'electric'],                              category: 'Electrical' },
  { keywords: ['internal joinery', 'joinery', 'joiner', 'cabinet maker',
               'fitted furniture', 'bespoke furniture', 'kitchen fitter',
               'kitchen fitting'],                                                    category: 'Internal Joinery' },
  { keywords: ['landscaping', 'landscape', 'landscaper', 'gardener', 'gardening',
               'outdoors', 'tree surgeon', 'turf', 'paving', 'decking', 'fencing'], category: 'Landscaping / Outdoors' },
  { keywords: ['painter & decorator', 'painter and decorator', 'painting & decorating',
               'painting and decorating', 'paint & dec', 'paint and dec',
               'painter', 'decorator', 'decorating', 'painting'],                   category: 'Painting + Decorating' },
  { keywords: ['plasterer', 'plastering', 'skimming', 'skim coat', 'rendering',
               'render', 'dry lining', 'dry-lining'],                               category: 'Plasterer' },
  { keywords: ['plumber', 'plumbing', 'heating engineer', 'boiler engineer',
               'gas engineer', 'heating', 'boiler', 'gas'],                         category: 'Plumbing' },
  { keywords: ['carpenter', 'carpentry', 'roofer', 'roofing', 'roof',
               'slater', 'slating', 'timber frame'],                                category: 'Carpentry / Roofing' },
  { keywords: ['handyman', 'general builder', 'general maintenance',
               'odd job', 'general'],                                               category: 'Handyman Services' },
];

// Keyword → fixed area mappings (longer/more specific phrases first)
const AREA_MAP = [
  { keywords: ['anglesey', 'ynys môn', 'ynys mon', 'holy island'],                  target: 'Anglesey' },
  { keywords: ['chester only'],                                                       target: 'Chester Only' },
  { keywords: ['cheshire', 'warrington', 'macclesfield', 'crewe', 'chester'],        target: 'Cheshire' },
  { keywords: ['greater manchester', 'manchester', 'salford', 'stockport',
               'trafford', 'oldham', 'rochdale', 'bolton', 'bury'],                 target: 'Greater Manchester' },
  { keywords: ['liverpool', 'merseyside', 'knowsley', 'sefton'],                     target: 'Liverpool' },
  { keywords: ['north wales', 'n. wales', 'n wales', 'gwynedd', 'conwy',
               'denbighshire', 'flintshire'],                                        target: 'North Wales' },
  { keywords: ['wirral'],                                                             target: 'Wirral' },
  { keywords: ['wrexham', 'wrecsam'],                                                target: 'Wrexham' },
];

function mapTradeType(raw) {
  if (!raw) return null;
  const lower = raw.toLowerCase().trim();
  const exact = TRADE_CATEGORIES.find(c => c.toLowerCase() === lower);
  if (exact) return exact;
  for (const { keywords, category } of TRADE_TYPE_MAP) {
    for (const kw of keywords) {
      if (lower === kw || lower.includes(kw)) return category;
    }
  }
  return null;
}

function mapAreaString(raw) {
  const lower = raw.toLowerCase().trim();
  const exact = TRADE_AREAS.find(a => a.toLowerCase() === lower);
  if (exact) return exact;
  for (const { keywords, target } of AREA_MAP) {
    for (const kw of keywords) {
      if (lower === kw || lower.includes(kw)) return target;
    }
  }
  return null;
}

app.patch('/api/trades/:id/category', isAuthenticated, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id.' });
  const { trade_type } = req.body || {};
  if (!trade_type || !trade_type.trim()) return res.status(400).json({ error: 'trade_type is required.' });
  if (!TRADE_CATEGORIES.includes(trade_type.trim())) return res.status(400).json({ error: 'Invalid trade category.' });
  const client = await _tradesPool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [prev] } = await client.query(`SELECT id, company_name, trade_type FROM trade_companies WHERE id=$1`, [id]);
    if (!prev) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Company not found.' }); }
    await client.query(
      `UPDATE trade_companies SET trade_type=$1, updated_by=$2, updated_at=NOW(), updated_by_name=$3 WHERE id=$4`,
      [trade_type.trim(), req.user?.claims?.sub || null, actorDisplayName(req.user?.claims), id]
    );
    await client.query(
      `INSERT INTO trade_audit_log (company_id, actor_id, actor_name, action) VALUES ($1,$2,$3,$4)`,
      [id, req.user?.claims?.sub || null, actorDisplayName(req.user?.claims),
       `Updated category: ${prev.trade_type} → ${trade_type.trim()} (migration quick-fix)`]
    );
    await client.query('COMMIT');
    res.json({ id, trade_type: trade_type.trim() });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.post('/api/admin/trades/migrate', isAuthenticated, requireAdmin, async (req, res) => {
  const dryRun = req.body?.dry_run !== false;
  try {
    const { rows } = await _tradesPool.query(
      `SELECT id, company_name, trade_type, areas_served FROM trade_companies ORDER BY id`
    );

    const migrated  = [];
    const skipped   = [];
    const unmatched = [];

    for (const row of rows) {
      const typeValid    = TRADE_CATEGORIES.includes(row.trade_type);
      const currentAreas = parseAreasServed(row.areas_served);
      const areasValid   = currentAreas.length === 0
        ? (row.areas_served === null || row.areas_served === '' || row.areas_served === '[]')
        : currentAreas.every(a => TRADE_AREAS.includes(a));
      const areasJson    = !row.areas_served || row.areas_served.startsWith('[');

      if (typeValid && areasValid && areasJson) {
        skipped.push({ id: row.id, company_name: row.company_name });
        continue;
      }

      const newTradeType = typeValid ? row.trade_type : mapTradeType(row.trade_type);
      if (!newTradeType) {
        unmatched.push({ id: row.id, company_name: row.company_name, trade_type: row.trade_type });
        continue;
      }

      const mappedAreas = [...new Set(currentAreas.map(mapAreaString).filter(Boolean))];

      if (!dryRun) {
        await _tradesPool.query(
          `UPDATE trade_companies SET trade_type=$1, areas_served=$2 WHERE id=$3`,
          [newTradeType, JSON.stringify(mappedAreas), row.id]
        );
      }

      migrated.push({
        id:             row.id,
        company_name:   row.company_name,
        old_trade_type: row.trade_type,
        new_trade_type: newTradeType,
        old_areas:      currentAreas,
        new_areas:      mappedAreas,
      });
    }

    res.json({ dry_run: dryRun, migrated, skipped, unmatched });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Google Calendar: upcoming events (14-day window) ──────────────────────────
app.get('/api/calendar/upcoming', async (req, res) => {
  if (!req.session.googleTokens) return res.json({ events: [], connected: false });
  try {
    const auth = getGoogleClient(req.session.googleTokens);
    const calendar = google.calendar({ version: 'v3', auth });
    const now = new Date();
    const twoWeeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: twoWeeks.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50
    });
    res.json({ events: response.data.items || [], connected: true });
  } catch (e) {
    const code = classifyGoogleError(e);
    if (code === 'GOOGLE_AUTH') {
      delete req.session.googleTokens;
      return res.json({ events: [], connected: false, error: e.message, code });
    }
    res.json({ events: [], connected: true, error: e.message, code });
  }
});

// ── Ideas & Feedback ──────────────────────────────────────────────────────────
app.get('/ideas', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'public', 'ideas.html')));

async function ensureIdeasTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ideas (
      id             SERIAL PRIMARY KEY,
      author_user_id VARCHAR NOT NULL,
      body           TEXT NOT NULL,
      created_at     TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS idea_comments (
      id             SERIAL PRIMARY KEY,
      idea_id        INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
      author_user_id VARCHAR NOT NULL,
      body           TEXT NOT NULL,
      created_at     TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE ideas ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP`);
  await pool.query(`ALTER TABLE idea_comments ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS idea_votes (
      idea_id  INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
      user_id  VARCHAR NOT NULL,
      CONSTRAINT idea_votes_pk PRIMARY KEY (idea_id, user_id)
    );
  `);
}

app.get('/api/ideas', async (req, res) => {
  try {
    const userId = req.user?.id || null;
    const { rows } = await pool.query(`
      SELECT i.id, i.body, i.created_at, i.edited_at,
             u.first_name, u.last_name, u.email AS author_email,
             COUNT(DISTINCT c.id)::int AS comment_count,
             COUNT(DISTINCT v.user_id)::int AS vote_count,
             MAX(CASE WHEN v.user_id = $1 THEN 1 ELSE 0 END)::int AS user_voted
      FROM ideas i
      LEFT JOIN users u ON u.id = i.author_user_id
      LEFT JOIN idea_comments c ON c.idea_id = i.id
      LEFT JOIN idea_votes v ON v.idea_id = i.id
      GROUP BY i.id, u.first_name, u.last_name, u.email
      ORDER BY i.created_at DESC
    `, [userId]);
    res.json(rows.map(r => ({
      id:            r.id,
      body:          r.body,
      created_at:    r.created_at,
      edited_at:     r.edited_at || null,
      author_name:   [r.first_name, r.last_name].filter(Boolean).join(' ') || r.author_email || 'Unknown',
      comment_count: r.comment_count,
      vote_count:    r.vote_count,
      user_voted:    r.user_voted === 1,
    })));
  } catch (e) {
    console.error('GET /api/ideas error:', e.message);
    res.status(500).json({ error: 'Could not load ideas.' });
  }
});

app.post('/api/ideas', async (req, res) => {
  const body = (req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Idea body is required.' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO ideas (author_user_id, body) VALUES ($1, $2) RETURNING id, body, created_at`,
      [req.user.claims?.sub, body]
    );
    const idea = rows[0];
    const c = req.user.claims || {};
    res.status(201).json({
      id:            idea.id,
      body:          idea.body,
      created_at:    idea.created_at,
      author_name:   [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'Unknown',
      comment_count: 0,
      vote_count:    0,
      user_voted:    false,
    });
  } catch (e) {
    console.error('POST /api/ideas error:', e.message);
    res.status(500).json({ error: 'Could not save idea.' });
  }
});

app.post('/api/ideas/:id/vote', isAuthenticated, async (req, res) => {
  const ideaId = parseInt(req.params.id, 10);
  if (isNaN(ideaId)) return res.status(400).json({ error: 'Invalid idea id.' });
  const userId = req.user.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ideaCheck = await client.query('SELECT id FROM ideas WHERE id = $1 FOR UPDATE', [ideaId]);
    if (!ideaCheck.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Idea not found.' });
    }
    const existing = await client.query(
      'SELECT 1 FROM idea_votes WHERE idea_id = $1 AND user_id = $2',
      [ideaId, userId]
    );
    let user_voted;
    if (existing.rows.length) {
      await client.query('DELETE FROM idea_votes WHERE idea_id = $1 AND user_id = $2', [ideaId, userId]);
      user_voted = false;
    } else {
      await client.query('INSERT INTO idea_votes (idea_id, user_id) VALUES ($1, $2)', [ideaId, userId]);
      user_voted = true;
    }
    const { rows } = await client.query(
      'SELECT COUNT(*)::int AS vote_count FROM idea_votes WHERE idea_id = $1',
      [ideaId]
    );
    await client.query('COMMIT');
    res.json({ vote_count: rows[0].vote_count, user_voted });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/ideas/:id/vote error:', e.message);
    res.status(500).json({ error: 'Could not update vote.' });
  } finally {
    client.release();
  }
});

app.get('/api/ideas/:id/comments', async (req, res) => {
  const ideaId = parseInt(req.params.id, 10);
  if (isNaN(ideaId)) return res.status(400).json({ error: 'Invalid idea id.' });
  try {
    const { rows } = await pool.query(`
      SELECT c.id, c.body, c.created_at, c.edited_at,
             u.first_name, u.last_name, u.email AS author_email
      FROM idea_comments c
      LEFT JOIN users u ON u.id = c.author_user_id
      WHERE c.idea_id = $1
      ORDER BY c.created_at ASC
    `, [ideaId]);
    res.json(rows.map(r => ({
      id:          r.id,
      body:        r.body,
      created_at:  r.created_at,
      edited_at:   r.edited_at || null,
      author_name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.author_email || 'Unknown',
    })));
  } catch (e) {
    console.error('GET /api/ideas/:id/comments error:', e.message);
    res.status(500).json({ error: 'Could not load comments.' });
  }
});

app.post('/api/ideas/:id/comments', async (req, res) => {
  const ideaId = parseInt(req.params.id, 10);
  if (isNaN(ideaId)) return res.status(400).json({ error: 'Invalid idea id.' });
  const body = (req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Comment body is required.' });
  try {
    const ideaCheck = await pool.query('SELECT id FROM ideas WHERE id = $1', [ideaId]);
    if (!ideaCheck.rows.length) return res.status(404).json({ error: 'Idea not found.' });
    const { rows } = await pool.query(
      `INSERT INTO idea_comments (idea_id, author_user_id, body) VALUES ($1, $2, $3) RETURNING id, body, created_at`,
      [ideaId, req.user.claims?.sub, body]
    );
    const comment = rows[0];
    const c = req.user.claims || {};
    res.status(201).json({
      id:          comment.id,
      body:        comment.body,
      created_at:  comment.created_at,
      author_name: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'Unknown',
    });
  } catch (e) {
    console.error('POST /api/ideas/:id/comments error:', e.message);
    res.status(500).json({ error: 'Could not save comment.' });
  }
});

app.delete('/api/ideas/:id', isAuthenticated, requireAdmin, async (req, res) => {
  const ideaId = parseInt(req.params.id, 10);
  if (isNaN(ideaId)) return res.status(400).json({ error: 'Invalid idea id.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const beforeR = await client.query('SELECT * FROM ideas WHERE id = $1 LIMIT 1', [ideaId]);
    if (!beforeR.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Idea not found.' });
    }
    const before = beforeR.rows[0];
    await client.query('DELETE FROM ideas WHERE id = $1', [ideaId]);
    const adminEmail = req.user?.claims?.email || req.user?.email || 'unknown';
    await client.query(
      `INSERT INTO db_editor_audit (admin_email, table_name, pk, op, before_data, after_data)
       VALUES ($1, 'ideas', $2, 'delete', $3::jsonb, NULL)`,
      [adminEmail, String(ideaId), JSON.stringify(before)]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('DELETE /api/ideas/:id error:', e.message);
    res.status(500).json({ error: 'Could not delete idea.' });
  } finally {
    client.release();
  }
});

app.patch('/api/ideas/:id', isAuthenticated, requireAdmin, async (req, res) => {
  const ideaId = parseInt(req.params.id, 10);
  if (isNaN(ideaId)) return res.status(400).json({ error: 'Invalid idea id.' });
  const body = (req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Idea body is required.' });
  if (body.length > 1000) return res.status(400).json({ error: 'Idea body too long.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const beforeR = await client.query('SELECT * FROM ideas WHERE id = $1 LIMIT 1', [ideaId]);
    if (!beforeR.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Idea not found.' });
    }
    const before = beforeR.rows[0];
    const { rows } = await client.query(
      `UPDATE ideas SET body = $1, edited_at = NOW() WHERE id = $2 RETURNING *`,
      [body, ideaId]
    );
    const after = rows[0];
    const adminEmail = req.user?.claims?.email || req.user?.email || 'unknown';
    await client.query(
      `INSERT INTO db_editor_audit (admin_email, table_name, pk, op, before_data, after_data)
       VALUES ($1, 'ideas', $2, 'update', $3::jsonb, $4::jsonb)`,
      [adminEmail, String(ideaId), JSON.stringify(before), JSON.stringify(after)]
    );
    await client.query('COMMIT');
    res.json({ id: after.id, body: after.body, edited_at: after.edited_at });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('PATCH /api/ideas/:id error:', e.message);
    res.status(500).json({ error: 'Could not update idea.' });
  } finally {
    client.release();
  }
});

app.delete('/api/ideas/:id/comments/:commentId', isAuthenticated, requireAdmin, async (req, res) => {
  const ideaId    = parseInt(req.params.id, 10);
  const commentId = parseInt(req.params.commentId, 10);
  if (isNaN(ideaId) || isNaN(commentId)) return res.status(400).json({ error: 'Invalid id.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const beforeR = await client.query(
      'SELECT * FROM idea_comments WHERE id = $1 AND idea_id = $2 LIMIT 1',
      [commentId, ideaId]
    );
    if (!beforeR.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Comment not found.' });
    }
    const before = beforeR.rows[0];
    await client.query('DELETE FROM idea_comments WHERE id = $1 AND idea_id = $2', [commentId, ideaId]);
    const adminEmail = req.user?.claims?.email || req.user?.email || 'unknown';
    await client.query(
      `INSERT INTO db_editor_audit (admin_email, table_name, pk, op, before_data, after_data)
       VALUES ($1, 'idea_comments', $2, 'delete', $3::jsonb, NULL)`,
      [adminEmail, String(commentId), JSON.stringify(before)]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('DELETE /api/ideas/:id/comments/:commentId error:', e.message);
    res.status(500).json({ error: 'Could not delete comment.' });
  } finally {
    client.release();
  }
});

app.patch('/api/ideas/:id/comments/:commentId', isAuthenticated, requireAdmin, async (req, res) => {
  const ideaId    = parseInt(req.params.id, 10);
  const commentId = parseInt(req.params.commentId, 10);
  if (isNaN(ideaId) || isNaN(commentId)) return res.status(400).json({ error: 'Invalid id.' });
  const body = (req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Comment body is required.' });
  if (body.length > 500) return res.status(400).json({ error: 'Comment body too long.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const beforeR = await client.query(
      'SELECT * FROM idea_comments WHERE id = $1 AND idea_id = $2 LIMIT 1',
      [commentId, ideaId]
    );
    if (!beforeR.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Comment not found.' });
    }
    const before = beforeR.rows[0];
    const { rows } = await client.query(
      `UPDATE idea_comments SET body = $1, edited_at = NOW() WHERE id = $2 AND idea_id = $3 RETURNING *`,
      [body, commentId, ideaId]
    );
    const after = rows[0];
    const adminEmail = req.user?.claims?.email || req.user?.email || 'unknown';
    await client.query(
      `INSERT INTO db_editor_audit (admin_email, table_name, pk, op, before_data, after_data)
       VALUES ($1, 'idea_comments', $2, 'update', $3::jsonb, $4::jsonb)`,
      [adminEmail, String(commentId), JSON.stringify(before), JSON.stringify(after)]
    );
    await client.query('COMMIT');
    res.json({ id: after.id, body: after.body, edited_at: after.edited_at });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('PATCH /api/ideas/:id/comments/:commentId error:', e.message);
    res.status(500).json({ error: 'Could not update comment.' });
  } finally {
    client.release();
  }
});

// ── Lead Status Config ─────────────────────────────────────────────────────────

// Push the full lead_status_config table to HubSpot as hs_lead_status options.
// Called after every create / update / delete so HubSpot stays in sync.
// Fire-and-forget callers should catch and log errors themselves.
async function syncLeadStatusesToHubSpot() {
  if (!process.env.HUBSPOT_ACCESS_TOKEN) return;
  const { rows } = await pool.query(
    'SELECT key, label, sort_order FROM lead_status_config WHERE is_null_row IS NOT TRUE ORDER BY sort_order ASC, key ASC'
  );
  const options = rows.map((r, i) => ({
    value:        r.key,
    label:        r.label,
    displayOrder: r.sort_order ?? i,
    hidden:       false,
  }));
  await axios.patch(
    `${HS}/crm/v3/properties/contacts/hs_lead_status`,
    { options },
    { headers: hsHeaders() }
  );
}

const LEAD_STATUS_STAGE_KEYS = [
  'SALES', 'DESIGN_VISIT', 'SURVEY', 'ORDER', 'WORKSHOP',
  'PACKING', 'DELIVERY', 'INSTALLATION', 'AFTERCARE', 'CUSTOMER_SERVICE',
];
const LEAD_STATUS_STAGE_SET = new Set(LEAD_STATUS_STAGE_KEYS);

const LEAD_STATUS_STAGE_SEEDS = {
  SALES: ['FORM_SUBMISSION', 'CONTACTED', 'ATTEMPTED_TO_CONTACT', 'IN_PROGRESS', 'AWAITING_PHOTOS', 'ROUGH_ESTIMATE', 'UNQUALIFIED', 'NOT_SUITABLE', 'BAD_TIMING', 'NO_RESPONSE'],
  DESIGN_VISIT: ['DESIGN_SCHEDULED', 'DESIGN_IN_PROGRESS', 'DESIGN_SENT', 'DESIGN_ACCEPTED'],
  SURVEY: ['DEPOSIT_INVOICE', 'SURVEY_SCHEDULED', 'SURVEY_IN_PROGRESS', 'SURVEY_SENT', 'READY_FOR_PRODUCTION'],
};

// ── Lead-status shorthand ────────────────────────────────────────────────────
// Each non-sentinel lead_status_config row gets a stable, unique 4-character
// shorthand (uppercase A-Z0-9). Used to prefix newly-created sub-status keys
// in the admin Card Actions tab. Generated from the label on create, kept
// stable across renames, editable by the admin (validated unique).
const _SHORTHAND_SKIP_WORDS = new Set([
  'to','of','the','a','an','and','in','on','for','with','or','at','by'
]);
const _SHORTHAND_VOWELS = new Set(['A','E','I','O','U']);

function generateShorthandCandidate(label) {
  const tokens = String(label || '')
    .split(/[^a-zA-Z0-9]+/)
    .filter(w => w && !_SHORTHAND_SKIP_WORDS.has(w.toLowerCase()));
  let out = '';
  if (tokens.length === 0) {
    const raw = String(label || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    out = raw.slice(0, 4);
  } else if (tokens.length === 1) {
    const w = tokens[0].toUpperCase();
    out = w[0] || '';
    for (let i = 1; i < w.length && out.length < 4; i++) {
      if (!_SHORTHAND_VOWELS.has(w[i])) out += w[i];
    }
    for (let i = 1; i < w.length && out.length < 4; i++) {
      if (_SHORTHAND_VOWELS.has(w[i])) out += w[i];
    }
  } else if (tokens.length === 2) {
    // Pattern that produces ATCT from "Attempted Contact", AWPH from "Awaiting Photos":
    // first letter of each word + first consonant after position 0 in each word.
    for (const w of tokens) {
      const u = w.toUpperCase();
      out += u[0] || '';
      let pad = '';
      for (let i = 1; i < u.length; i++) {
        if (!_SHORTHAND_VOWELS.has(u[i]) && /[A-Z0-9]/.test(u[i])) { pad = u[i]; break; }
      }
      if (!pad) {
        for (let i = 1; i < u.length; i++) {
          if (/[A-Z0-9]/.test(u[i])) { pad = u[i]; break; }
        }
      }
      out += pad || u[u.length - 1] || 'X';
    }
  } else {
    for (const w of tokens.slice(0, 4)) out += (w[0] || '').toUpperCase();
    const first = (tokens[0] || '').toUpperCase();
    for (let i = 1; i < first.length && out.length < 4; i++) out += first[i];
  }
  out = out.toUpperCase().replace(/[^A-Z0-9]/g, '');
  while (out.length < 4) out += 'X';
  return out.slice(0, 4);
}

async function generateUniqueShorthand(label, excludeKey) {
  const base = generateShorthandCandidate(label);
  const { rows } = await pool.query(
    `SELECT shorthand FROM lead_status_config
     WHERE shorthand IS NOT NULL AND ($1::text IS NULL OR key <> $1)`,
    [excludeKey || null]
  );
  const taken = new Set(rows.map(r => (r.shorthand || '').toUpperCase()));
  if (!taken.has(base)) return base;
  // Vary the 4th, then 3rd, character through a consonant-first alphabet.
  const ALPHA = 'BCDFGHJKLMNPQRSTVWXYZ0123456789AEIOU';
  for (const c of ALPHA) {
    const cand = base.slice(0, 3) + c;
    if (!taken.has(cand)) return cand;
  }
  for (const c of ALPHA) {
    const cand = base.slice(0, 2) + c + base[3];
    if (!taken.has(cand)) return cand;
  }
  for (let n = 0; n < 1000; n++) {
    const suf = String(n).padStart(2, '0');
    const cand = (base.slice(0, 2) + suf).slice(0, 4);
    if (!taken.has(cand)) return cand;
  }
  throw new Error('Could not generate a unique 4-character shorthand.');
}

async function ensureLeadStatusTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lead_status_config (
      key                 TEXT PRIMARY KEY,
      label               TEXT NOT NULL,
      sort_order          INT  NOT NULL DEFAULT 0,
      excluded_from_sales BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
  await pool.query(`ALTER TABLE lead_status_config ADD COLUMN IF NOT EXISTS stage VARCHAR(32)`);
  await pool.query(`ALTER TABLE lead_status_config ADD COLUMN IF NOT EXISTS is_null_row BOOLEAN NOT NULL DEFAULT FALSE`);
  // Stable 4-char shorthand per lead status. Nullable so the null-sentinel row
  // (is_null_row=TRUE) can stay without one; a partial UNIQUE index keeps
  // non-null values unique.
  await pool.query(`ALTER TABLE lead_status_config ADD COLUMN IF NOT EXISTS shorthand CHAR(4)`);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS lead_status_config_shorthand_uniq
       ON lead_status_config(shorthand) WHERE shorthand IS NOT NULL`
  );

  // Ensure the sentinel null-status row exists (never overwrite an admin-changed label).
  await pool.query(
    `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales, is_null_row)
     VALUES ('__NULL__', 'No status', -1, FALSE, TRUE)
     ON CONFLICT (key) DO NOTHING`
  );

  // Backfill stage for known seed keys (only where stage is still NULL — never overwrite admin choices).
  for (const [stage, keys] of Object.entries(LEAD_STATUS_STAGE_SEEDS)) {
    if (!keys.length) continue;
    await pool.query(
      `UPDATE lead_status_config SET stage = $1 WHERE stage IS NULL AND key = ANY($2::text[])`,
      [stage, keys]
    );
  }

  const { rows: countRows } = await pool.query('SELECT COUNT(*) AS cnt FROM lead_status_config WHERE is_null_row IS NOT TRUE');
  if (parseInt(countRows[0].cnt, 10) > 0) return;

  // ── Seed from HubSpot if a token is available ──────────────────────────────
  if (process.env.HUBSPOT_ACCESS_TOKEN) {
    try {
      const r = await axios.get(
        `${HS}/crm/v3/properties/contacts/hs_lead_status`,
        { headers: hsHeaders() }
      );
      const options = (r.data.options || []).filter(o => !o.hidden);
      if (options.length > 0) {
        // Preserve any existing excluded_from_sales preferences; default UNQUALIFIED to true.
        const EXCLUDED_DEFAULTS = new Set(['UNQUALIFIED', 'NOT_SUITABLE']);
        for (let i = 0; i < options.length; i++) {
          const o = options[i];
          const key = (o.value || '').toUpperCase();
          await pool.query(
            'INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales) VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO NOTHING',
            [key, o.label || key, o.displayOrder ?? i, EXCLUDED_DEFAULTS.has(key)]
          );
        }
        console.log(`  Lead status config seeded from HubSpot (${options.length} statuses)`);
        return;
      }
    } catch (e) {
      console.warn('  Could not fetch hs_lead_status from HubSpot, falling back to defaults:', e.response?.data?.message || e.message);
    }
  }

  // ── Fallback: hardcoded defaults ───────────────────────────────────────────
  const DEFAULT_LEAD_STATUSES = [
    { key: 'NEW',                  label: 'New',                  sort_order: 0,  excluded_from_sales: false },
    { key: 'OPEN',                 label: 'Open',                 sort_order: 1,  excluded_from_sales: false },
    { key: 'IN_PROGRESS',          label: 'In Progress',          sort_order: 2,  excluded_from_sales: false },
    { key: 'OPEN_DEAL',            label: 'Open Deal',            sort_order: 3,  excluded_from_sales: false },
    { key: 'VISIT_SCHEDULED',      label: 'Visit Scheduled',      sort_order: 4,  excluded_from_sales: false },
    { key: 'ATTEMPTED_TO_CONTACT', label: 'Attempted to Contact', sort_order: 5,  excluded_from_sales: false },
    { key: 'UNQUALIFIED',          label: 'Unqualified',          sort_order: 6,  excluded_from_sales: true  },
    { key: 'BAD_TIMING',           label: 'Bad Timing',           sort_order: 7,  excluded_from_sales: false },
  ];
  for (const s of DEFAULT_LEAD_STATUSES) {
    await pool.query(
      'INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales) VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO NOTHING',
      [s.key, s.label, s.sort_order, s.excluded_from_sales]
    );
  }
  console.log('  Lead status config seeded with defaults (no HubSpot token)');
}

// Backfill 4-char shorthand for any non-sentinel row that doesn't have one yet.
// Called after seeding so it covers both HubSpot-seeded and default-seeded rows.
async function backfillLeadStatusShorthands() {
  const { rows } = await pool.query(
    `SELECT key, label FROM lead_status_config
       WHERE shorthand IS NULL AND is_null_row IS NOT TRUE
       ORDER BY sort_order ASC, key ASC`
  );
  if (!rows.length) return;
  for (const r of rows) {
    try {
      const sh = await generateUniqueShorthand(r.label, r.key);
      await pool.query('UPDATE lead_status_config SET shorthand = $1 WHERE key = $2', [sh, r.key]);
    } catch (e) {
      console.warn(`  Could not backfill shorthand for lead status ${r.key}:`, e.message);
    }
  }
  console.log(`  Backfilled shorthand for ${rows.length} lead status(es).`);
}

// Public authenticated: full ordered list for all frontend pages
app.get('/api/lead-statuses', isAuthenticated, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT key, label, sort_order, excluded_from_sales, stage, is_null_row, shorthand FROM lead_status_config ORDER BY sort_order ASC, key ASC'
    );
    res.set('Cache-Control', 'no-store');
    res.json(rows);
  } catch (e) {
    console.error('GET /api/lead-statuses error:', e.message);
    res.status(500).json({ error: 'Could not load lead statuses.' });
  }
});

// Admin: full list (same as public for now but separate for future extension)
app.get('/api/admin/lead-statuses', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT key, label, sort_order, excluded_from_sales, stage, is_null_row, shorthand FROM lead_status_config ORDER BY sort_order ASC, key ASC'
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /api/admin/lead-statuses error:', e.message);
    res.status(500).json({ error: 'Could not load lead statuses.' });
  }
});

// Admin: add new status
app.post('/api/admin/lead-statuses', isAuthenticated, requireAdmin, async (req, res) => {
  const key   = (req.body?.key   || '').trim().toUpperCase().replace(/\s+/g, '_');
  const label = (req.body?.label || '').trim();
  if (!key || !label) return res.status(400).json({ error: 'key and label are required.' });
  if (!/^[A-Z0-9_]+$/.test(key)) return res.status(400).json({ error: 'key may only contain uppercase letters, digits, and underscores.' });
  let stage = null;
  if (req.body?.stage !== undefined && req.body.stage !== null && req.body.stage !== '') {
    stage = String(req.body.stage).trim().toUpperCase();
    if (!LEAD_STATUS_STAGE_SET.has(stage)) {
      return res.status(400).json({ error: 'stage must be one of the allowed stage keys.' });
    }
  }
  // Shorthand: caller may supply one (must be 4× [A-Z0-9]); otherwise auto-generated.
  let shorthand = null;
  if (req.body?.shorthand !== undefined && req.body.shorthand !== null && req.body.shorthand !== '') {
    shorthand = String(req.body.shorthand).trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(shorthand)) {
      return res.status(400).json({ error: 'shorthand must be exactly 4 characters (A–Z or 0–9).' });
    }
  } else {
    try { shorthand = await generateUniqueShorthand(label); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }
  try {
    const { rows: maxRows } = await pool.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM lead_status_config');
    const next = maxRows[0].next;
    const { rows } = await pool.query(
      'INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales, stage, shorthand) VALUES ($1, $2, $3, FALSE, $4, $5) RETURNING *',
      [key, label, next, stage, shorthand]
    );
    _invalidateLeadStatusCountsCache();
    _invalidateOpenLeadsCache();
    res.status(201).json(rows[0]);
    syncLeadStatusesToHubSpot().catch(e => console.warn('HubSpot lead-status sync failed:', e.response?.data?.message || e.message));
  } catch (e) {
    if (e.code === '23505') {
      // Could be key collision or shorthand collision — distinguish by constraint name.
      if (String(e.constraint || '').includes('shorthand')) {
        return res.status(409).json({ error: 'That shorthand is already in use.' });
      }
      return res.status(409).json({ error: 'A status with that key already exists.' });
    }
    console.error('POST /api/admin/lead-statuses error:', e.message);
    res.status(500).json({ error: 'Could not add lead status.' });
  }
});

// Admin: update label / sort_order / excluded_from_sales / key (key rename for empty-key rows)
app.patch('/api/admin/lead-statuses/:key', isAuthenticated, requireAdmin, async (req, res) => {
  const key = req.params.key;
  const { label, sort_order, excluded_from_sales, new_key, stage, shorthand } = req.body || {};
  if (label !== undefined && !String(label).trim()) return res.status(400).json({ error: 'label cannot be empty.' });
  if (new_key !== undefined) {
    const nk = String(new_key).trim().toUpperCase();
    if (!nk || !/^[A-Z0-9_]+$/.test(nk)) return res.status(400).json({ error: 'new_key may only contain uppercase letters, digits, and underscores.' });
  }
  // Shorthand is editable but stable across label renames (we only update it
  // when the caller explicitly sends it).
  let shorthandProvided = false;
  let shorthandValue = null;
  if (shorthand !== undefined) {
    shorthandProvided = true;
    const sv = String(shorthand || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(sv)) {
      return res.status(400).json({ error: 'shorthand must be exactly 4 characters (A–Z or 0–9).' });
    }
    shorthandValue = sv;
  }
  let stageProvided = false;
  let stageValue = null;
  if (stage !== undefined) {
    stageProvided = true;
    if (stage === null || stage === '') {
      stageValue = null;
    } else {
      stageValue = String(stage).trim().toUpperCase();
      if (!LEAD_STATUS_STAGE_SET.has(stageValue)) {
        return res.status(400).json({ error: 'stage must be one of the allowed stage keys.' });
      }
    }
  }
  try {
    const { rows: existing } = await pool.query('SELECT * FROM lead_status_config WHERE key = $1', [key]);
    if (!existing.length) return res.status(404).json({ error: 'Status not found.' });
    const cur = existing[0];

    // For the null sentinel row, only the label and shorthand may be changed.
    if (cur.is_null_row) {
      const newLabel     = label !== undefined ? String(label).trim() : cur.label;
      if (!newLabel) return res.status(400).json({ error: 'label cannot be empty.' });
      const newShorthand = shorthandProvided ? shorthandValue : cur.shorthand;
      const { rows } = await pool.query(
        'UPDATE lead_status_config SET label = $1, shorthand = $2 WHERE key = $3 RETURNING *',
        [newLabel, newShorthand, key]
      );
      return res.json(rows[0]);
    }

    const newLabel    = label     !== undefined ? String(label).trim()      : cur.label;
    const newOrder    = sort_order !== undefined ? parseInt(sort_order, 10) : cur.sort_order;
    const newExcluded = excluded_from_sales !== undefined ? !!excluded_from_sales : cur.excluded_from_sales;
    const finalKey    = new_key   !== undefined ? String(new_key).trim().toUpperCase() : key;
    const newStage    = stageProvided ? stageValue : cur.stage;
    const newShorthand = shorthandProvided ? shorthandValue : cur.shorthand;
    const { rows } = await pool.query(
      'UPDATE lead_status_config SET key = $1, label = $2, sort_order = $3, excluded_from_sales = $4, stage = $5, shorthand = $6 WHERE key = $7 RETURNING *',
      [finalKey, newLabel, newOrder, newExcluded, newStage, newShorthand, key]
    );
    _invalidateLeadStatusCountsCache();
    _invalidateOpenLeadsCache();
    res.json(rows[0]);
    syncLeadStatusesToHubSpot().catch(e => console.warn('HubSpot lead-status sync failed:', e.response?.data?.message || e.message));
  } catch (e) {
    if (e.code === '23505') {
      if (String(e.constraint || '').includes('shorthand')) {
        return res.status(409).json({ error: 'That shorthand is already in use.' });
      }
      return res.status(409).json({ error: 'A status with that key already exists.' });
    }
    console.error('PATCH /api/admin/lead-statuses/:key error:', e.message);
    res.status(500).json({ error: 'Could not update lead status.' });
  }
});

// Admin: delete a status row (null sentinel is protected)
app.delete('/api/admin/lead-statuses/:key', isAuthenticated, requireAdmin, async (req, res) => {
  const key = req.params.key;
  try {
    const { rows: existing } = await pool.query(
      'SELECT key, is_null_row FROM lead_status_config WHERE key = $1',
      [key]
    );
    if (!existing.length) return res.status(404).json({ error: 'Status not found.' });
    if (existing[0].is_null_row) {
      return res.status(400).json({ error: 'The null-status sentinel row cannot be deleted.' });
    }
    await pool.query('DELETE FROM lead_status_config WHERE key = $1', [key]);
    _invalidateLeadStatusCountsCache();
    _invalidateOpenLeadsCache();
    res.json({ ok: true });
    syncLeadStatusesToHubSpot().catch(e => console.warn('HubSpot lead-status sync failed:', e.response?.data?.message || e.message));
  } catch (e) {
    console.error('DELETE /api/admin/lead-statuses/:key error:', e.message);
    res.status(500).json({ error: 'Could not delete lead status.' });
  }
});

// ── Stage action labels (per stage_key × status_key) ─────────────────────────
// Bottom-strip "next action" label shown on Sales/Survey cards. Driven by
// (stage_key, status_key) so admins can customize per-substage call-to-action.
// status_key is lowercase to match the substageId values rendered on cards;
// '' (empty) is a valid key for "no substage / null status".
const STAGE_ACTION_STAGE_KEYS = new Set(['sales', 'designvisit', 'survey']);

async function ensureStageActionLabelsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stage_action_labels (
      stage_key   TEXT NOT NULL,
      status_key  TEXT NOT NULL,
      label       TEXT NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (stage_key, status_key)
    )
  `);
}

// Maps the uppercase lead_status_config.stage to the lowercase card stage key.
const STAGE_ACTION_STAGE_MAP = {
  SALES:        'sales',
  DESIGN_VISIT: 'designvisit',
  SURVEY:       'survey',
};

// Seed one row per (card stage × lead status) combination so every card has an
// editable per-LS row in the admin Card-actions tab. Idempotent: only inserts
// rows that are missing, and never overwrites existing values (admin edits
// always win). An admin who wants to suppress a specific LS uses the
// "clear" UX in the admin tab, which PUTs an empty label rather than
// DELETEing the row — so existing-row-with-empty-label is preserved and a
// re-run of this seed will not resurrect it.
// No hardcoded default labels are seeded — the admin fills them in via
// the Card-actions tab. The seed just ensures every live lead status has
// a row to edit (defaulting to the LS display label on first boot).
async function seedStageActionLabelsDefaults() {
  const { rows } = await pool.query(
    `SELECT key, label, stage FROM lead_status_config
     WHERE is_null_row IS NOT TRUE AND stage = ANY($1::text[])`,
    [Object.keys(STAGE_ACTION_STAGE_MAP)]
  );

  for (const row of rows) {
    const stageKey  = STAGE_ACTION_STAGE_MAP[row.stage];
    if (!stageKey) continue;
    const statusKey = String(row.key || '').toLowerCase();
    if (!statusKey) continue;
    const label = String(row.label || statusKey);
    await pool.query(
      `INSERT INTO stage_action_labels (stage_key, status_key, label)
       VALUES ($1, $2, $3)
       ON CONFLICT (stage_key, status_key) DO NOTHING`,
      [stageKey, statusKey, label]
    );
  }
}

function _normaliseStageActionInput(stage_key, status_key, label) {
  const s = String(stage_key || '').trim().toLowerCase();
  const k = String(status_key || '').trim().toLowerCase();
  const l = String(label || '').trim();
  return { stage_key: s, status_key: k, label: l };
}

// Public (authenticated): used by Sales/Survey pages to render the action strip.
app.get('/api/stage-action-labels', isAuthenticated, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT stage_key, status_key, label FROM stage_action_labels ORDER BY stage_key, status_key'
    );
    res.set('Cache-Control', 'no-store');
    res.json(rows);
  } catch (e) {
    console.error('GET /api/stage-action-labels error:', e.message);
    res.status(500).json({ error: 'Could not load stage action labels.' });
  }
});

app.get('/api/admin/stage-action-labels', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT stage_key, status_key, label, updated_at FROM stage_action_labels ORDER BY stage_key, status_key'
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /api/admin/stage-action-labels error:', e.message);
    res.status(500).json({ error: 'Could not load stage action labels.' });
  }
});

// Upsert one mapping. Body: { stage_key, status_key, label }
app.put('/api/admin/stage-action-labels', isAuthenticated, requireAdmin, async (req, res) => {
  const { stage_key, status_key, label } = _normaliseStageActionInput(
    req.body?.stage_key, req.body?.status_key, req.body?.label
  );
  if (!stage_key || !STAGE_ACTION_STAGE_KEYS.has(stage_key)) {
    return res.status(400).json({ error: 'stage_key must be one of: sales, designvisit, survey.' });
  }
  // An empty `label` is allowed and means "admin explicitly cleared this
  // per-LS row" — the row is still inserted so the client can distinguish
  // "no row" (use per-stage default) from "row present but cleared"
  // (suppress the action strip). See workflow-core.js for the resolver.
  if (label.length > 128) {
    return res.status(400).json({ error: 'label must be 128 characters or fewer.' });
  }
  if (status_key.length > 64 || !/^[a-z0-9_]*$/.test(status_key)) {
    return res.status(400).json({ error: 'status_key may only contain lowercase letters, digits, and underscores.' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO stage_action_labels (stage_key, status_key, label, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (stage_key, status_key)
       DO UPDATE SET label = EXCLUDED.label, updated_at = NOW()
       RETURNING stage_key, status_key, label, updated_at`,
      [stage_key, status_key, label]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error('PUT /api/admin/stage-action-labels error:', e.message);
    res.status(500).json({ error: 'Could not save stage action label.' });
  }
});

app.delete('/api/admin/stage-action-labels/:stage_key/:status_key', isAuthenticated, requireAdmin, async (req, res) => {
  const stage_key  = String(req.params.stage_key  || '').toLowerCase();
  // The (stage, '') "no lead status" row can't be represented in a URL
  // path segment, so the client sends the literal sentinel '_EMPTY_' which
  // we translate back to ''.
  const rawStatus  = String(req.params.status_key || '');
  const status_key = rawStatus === '_EMPTY_' ? '' : rawStatus.toLowerCase();
  if (!STAGE_ACTION_STAGE_KEYS.has(stage_key)) {
    return res.status(400).json({ error: 'Invalid stage_key.' });
  }
  try {
    await pool.query(
      'DELETE FROM stage_action_labels WHERE stage_key = $1 AND status_key = $2',
      [stage_key, status_key]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/admin/stage-action-labels error:', e.message);
    res.status(500).json({ error: 'Could not delete stage action label.' });
  }
});

// ── Lead sub-statuses (per lead_status, synced to HubSpot hw_lead_substatus) ──
// Each lead status can have any number of sub-statuses, each with its own
// action label. Sub-statuses are surfaced on the HubSpot contact via the
// `hw_lead_substatus` enumeration property (single-select radio). Option
// values are namespaced as `${STATUS_KEY}__${SUBSTATUS_KEY}` so the single
// HubSpot dropdown can list options for every parent lead status without
// collisions.
async function ensureLeadSubstatusesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lead_substatuses (
      id            SERIAL PRIMARY KEY,
      status_key    TEXT NOT NULL,
      substatus_key TEXT NOT NULL,
      label         TEXT NOT NULL,
      action_label  TEXT NOT NULL DEFAULT '',
      sort_order    INT  NOT NULL DEFAULT 0,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (status_key, substatus_key)
    )
  `);
  // Real FK so deleting a lead_status_config row that still has substatuses is
  // blocked at the DB layer (Postgres 23503), which lets the admin db-editor
  // surface its "blocking rows" preview instead of silently orphaning data.
  // ON DELETE NO ACTION (the default) is intentional: the admin must remove
  // or reassign the dependent substatuses first. There is no production code
  // path that deletes a lead_status_config row with live substatuses, so this
  // is a safety net, not a regression.
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'lead_substatuses_status_key_fk'
      ) THEN
        -- Drop orphans that would block the ALTER. None are expected, but a
        -- pre-existing data anomaly should not crash boot.
        DELETE FROM lead_substatuses s
          WHERE NOT EXISTS (
            SELECT 1 FROM lead_status_config c WHERE c.key = s.status_key
          );
        ALTER TABLE lead_substatuses
          ADD CONSTRAINT lead_substatuses_status_key_fk
          FOREIGN KEY (status_key) REFERENCES lead_status_config(key);
      END IF;
    END$$;
  `);
}

// ── hw_test_user HubSpot property ─────────────────────────────────────────────
// Registers a boolean contact property used to mark dev/test contacts.
// Only created in non-production environments and only when HUBSPOT_ACCESS_TOKEN
// is present. A 409 (already exists) is treated as success.
async function ensureHwTestUserProperty() {
  if (process.env.NODE_ENV === 'production') return;
  if (!process.env.HUBSPOT_ACCESS_TOKEN) return;
  try {
    await axios.get(
      `${HS}/crm/v3/properties/contacts/hw_test_user`,
      { headers: hsHeaders() }
    );
    return; // already exists
  } catch (e) {
    if (e.response?.status !== 404) {
      console.warn('  hw_test_user probe failed:', e.response?.data?.message || e.message);
      return;
    }
  }
  try {
    await axios.post(
      `${HS}/crm/v3/properties/contacts`,
      {
        name:        'hw_test_user',
        label:       'HW Test User',
        groupName:   'contactinformation',
        type:        'bool',
        fieldType:   'booleancheckbox',
        description: 'Marks a contact as a dev/test contact in Measure Once. In non-production environments only contacts with this flag are shown.',
        options: [
          { label: 'Yes', value: 'true',  displayOrder: 0, hidden: false },
          { label: 'No',  value: 'false', displayOrder: 1, hidden: false },
        ],
      },
      { headers: hsHeaders() }
    );
    console.log('  Created HubSpot property: hw_test_user');
  } catch (e) {
    if (e.response?.status !== 409) {
      console.warn('  Could not create hw_test_user:', e.response?.data?.message || e.message);
    }
  }
}

// ── Admin: dev-mode flag ──────────────────────────────────────────────────────
// Returns whether the server is running in dev (non-production) mode.
// The admin UI reads this to decide whether to render the test-users section.
app.get('/api/admin/hubspot/dev-mode', isAuthenticated, requireAdmin, (req, res) => {
  res.json({ devMode: process.env.NODE_ENV !== 'production' });
});

// ── App settings table ────────────────────────────────────────────────────────
// Generic key/value store for persistent server settings.
async function ensureAppSettingsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Seed dev_filter_enabled = true so existing behaviour is preserved on upgrade.
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('dev_filter_enabled', 'true') ON CONFLICT (key) DO NOTHING`
  );
}

// In-memory cache for dev_filter_enabled so the three filter sites don't each
// hit the DB on every request.  Invalidated on PATCH.
let _devFilterEnabledCache = null; // true | false | null (uncached)

async function getDevFilterEnabled() {
  if (process.env.NODE_ENV === 'production') return false;
  if (_devFilterEnabledCache !== null) return _devFilterEnabledCache;
  try {
    const { rows } = await pool.query(`SELECT value FROM app_settings WHERE key = 'dev_filter_enabled'`);
    _devFilterEnabledCache = rows.length > 0 ? rows[0].value === 'true' : true;
  } catch {
    _devFilterEnabledCache = true; // safe default
  }
  return _devFilterEnabledCache;
}

// ── Dev-only: get/set the global dev filter toggle ────────────────────────────
app.get('/api/admin/hubspot/dev-filter', isAuthenticated, requireAdmin, async (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'Not found' });
  try {
    const enabled = await getDevFilterEnabled();
    res.json({ enabled });
  } catch (e) {
    res.status(500).json({ error: 'Could not read dev filter setting.' });
  }
});

app.patch('/api/admin/hubspot/dev-filter', isAuthenticated, requireAdmin, async (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'Not found' });
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: '`enabled` must be a boolean.' });
  try {
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('dev_filter_enabled', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [enabled ? 'true' : 'false']
    );
    _devFilterEnabledCache = enabled;
    // Bust the contacts & lead-status-counts caches so the next request reflects
    // the new filter setting immediately.
    bustSharedCache();
    _invalidateLeadStatusCountsCache();
    _invalidateOpenLeadsCache();
    res.json({ ok: true, enabled });
  } catch (e) {
    console.error('PATCH /api/admin/hubspot/dev-filter error:', e.message);
    res.status(500).json({ error: 'Could not save dev filter setting.' });
  }
});

// ── Dev-only: backfill hw_test_user = false on contacts that have no value ────
app.post('/api/admin/hubspot/backfill-test-user-defaults',
  isAuthenticated,
  requireAdmin,
  (req, res, next) => {
    if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'Not found' });
    next();
  },
  requireHubspotToken,
  async (req, res) => {
    try {
      // Page through all contacts that have no hw_test_user value.
      let after;
      let patched = 0;
      do {
        const body = {
          filterGroups: [{ filters: [{ propertyName: 'hw_test_user', operator: 'NOT_HAS_PROPERTY' }] }],
          properties: ['id'],
          limit: 100,
        };
        if (after) body.after = after;
        const r = await axios.post(
          `${HS}/crm/v3/objects/contacts/search`,
          body,
          { headers: hsHeaders() }
        );
        const results = r.data.results || [];
        if (results.length) {
          // Batch-update in groups of 100 (HubSpot batch limit).
          await axios.post(
            `${HS}/crm/v3/objects/contacts/batch/update`,
            { inputs: results.map(c => ({ id: c.id, properties: { hw_test_user: false } })) },
            { headers: hsHeaders() }
          );
          patched += results.length;
        }
        after = r.data.paging?.next?.after;
      } while (after);

      bustSharedCache();
      res.json({ ok: true, patched });
    } catch (e) {
      const status = e.response?.status;
      if (status === 401 || status === 403) return res.status(502).json({ error: 'HubSpot auth error.' });
      if (status === 429) return res.status(502).json({ error: 'HubSpot rate limit — try again shortly.' });
      console.error('POST /api/admin/hubspot/backfill-test-user-defaults error:', e.message);
      res.status(502).json({ error: e.message || 'Backfill failed.' });
    }
  }
);

// ── Dev-only: seed the shared contacts cache for automated tests ──────────────
// Accepts a JSON array of synthetic contact objects and injects them directly
// into _allContactsCache so filter-behaviour tests can run without a real
// HubSpot token.  Only available when NODE_ENV !== 'production'.
app.post('/api/admin/test/seed-contacts-cache', isAuthenticated, requireAdmin, (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  const { contacts } = req.body || {};
  if (!Array.isArray(contacts)) {
    return res.status(400).json({ error: '`contacts` must be an array.' });
  }
  _allContactsCache = { contacts, expiresAt: Date.now() + ALL_CONTACTS_CACHE_TTL_MS };
  res.json({ ok: true, count: contacts.length });
});

// ── Dev-only: bust the shared contacts fresh cache ────────────────────────────
// Clears _allContactsCache so the next request triggers a fresh HubSpot scan.
// Does NOT clear _allContactsLastGood, so the stale-fallback path is testable:
// after busting, a subsequent call that fails HubSpot will still serve stale.
// Only available when NODE_ENV !== 'production'.
app.post('/api/admin/test/bust-contacts-cache', isAuthenticated, requireAdmin, (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  _allContactsCache = null;
  res.json({ ok: true });
});

// ── Dev-only: expire the open-leads fresh cache ───────────────────────────────
// Sets _openLeadsCache.fetchedAt = 0 so the TTL check fails on the next
// request (triggering a fresh HubSpot fetch), while keeping the cached data
// intact so the stale-fallback path is exercisable: if that fresh fetch also
// fails, the handler falls back to the now-expired _openLeadsCache as stale.
// Does NOT clear _openLeadsCache to null — that would prevent stale fallback.
// Only available when NODE_ENV !== 'production'.
app.post('/api/admin/test/bust-open-leads-cache', isAuthenticated, requireAdmin, (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  if (_openLeadsCache) _openLeadsCache.fetchedAt = 0;
  res.json({ ok: true, hadCache: _openLeadsCache !== null });
});

// ── Dev-only: reset the lead-status-counts rate-limit cooldown ───────────────
// Clears _leadStatusCountsCooldownUntil so the next request performs a live
// fan-out rather than immediately serving stale counts. Only useful in tests
// that exercised the always-429 path (section B) and need section C to see a
// live retry. Only available when NODE_ENV !== 'production'.
app.post('/api/admin/test/reset-lead-status-counts-cooldown', isAuthenticated, requireAdmin, (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  _leadStatusCountsCooldownUntil = 0;
  res.json({ ok: true });
});

// ── Admin: toggle HW_test_user on a contact ───────────────────────────────────
// The production guard runs as a middleware *before* requireHubspotToken so
// the 404 is returned even when HUBSPOT_TOKEN is absent.
app.patch('/api/admin/hubspot/test-users/:contactId',
  isAuthenticated,
  requireAdmin,
  (req, res, next) => {
    if (process.env.NODE_ENV === 'production') {
      return res.status(404).json({ error: 'Not found' });
    }
    next();
  },
  requireHubspotToken,
  async (req, res) => {

  const contactId = String(req.params.contactId || '');
  if (!/^\d+$/.test(contactId)) {
    return res.status(400).json({ error: 'Invalid contact id.' });
  }

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: '`enabled` must be a boolean.' });
  }

  try {
    await axios.patch(
      `${HS}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`,
      { properties: { hw_test_user: enabled } },
      { headers: hsHeaders() }
    );
    bustSharedCache();
    res.json({ ok: true });
  } catch (e) {
    const status = e.response?.status;
    if (status === 404) return res.status(404).json({ error: 'Contact not found in HubSpot.' });
    if (status === 401 || status === 403) {
      return res.status(502).json({ error: 'HubSpot rejected the request — the token may be invalid or expired.', code: 'HUBSPOT_AUTH' });
    }
    if (status === 429) {
      return res.status(502).json({ error: 'HubSpot rate limit reached. Please wait a moment and try again.', code: 'HUBSPOT_RATE_LIMIT' });
    }
    res.status(502).json({ error: e.response?.data?.message || e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
  }
});

async function ensureHwLeadSubstatusProperty() {
  if (!process.env.HUBSPOT_ACCESS_TOKEN) return;
  try {
    await axios.get(
      `${HS}/crm/v3/properties/contacts/hw_lead_substatus`,
      { headers: hsHeaders() }
    );
    return; // already exists
  } catch (e) {
    if (e.response?.status !== 404) {
      console.warn('  hw_lead_substatus probe failed:', e.response?.data?.message || e.message);
      return;
    }
  }
  try {
    await axios.post(
      `${HS}/crm/v3/properties/contacts`,
      {
        name:        'hw_lead_substatus',
        label:       'HW Lead Sub-Status',
        groupName:   'contactinformation',
        type:        'enumeration',
        fieldType:   'radio',
        description: 'Sub-status within the current Lead Status (Measure Once CRM). Options are namespaced as STATUS_KEY__SUBSTATUS_KEY.',
        options: [{ value: '__placeholder__', label: '—', displayOrder: 0, hidden: true }],
      },
      { headers: hsHeaders() }
    );
    console.log('  Created HubSpot property: hw_lead_substatus');
  } catch (e) {
    console.warn('  Could not create hw_lead_substatus:', e.response?.data?.message || e.message);
  }
}

// Push the full lead_substatuses table to HubSpot as hw_lead_substatus options.
// Option label is `{Lead Status label} → {Sub-status label}` so the dropdown
// reads naturally in HubSpot. Called after every create / update / delete.
async function syncLeadSubstatusesToHubSpot() {
  if (!process.env.HUBSPOT_ACCESS_TOKEN) return;
  const { rows } = await pool.query(`
    SELECT s.status_key, s.substatus_key, s.label AS sub_label, s.sort_order AS sub_order,
           c.label AS ls_label, c.sort_order AS ls_order
    FROM lead_substatuses s
    LEFT JOIN lead_status_config c ON c.key = s.status_key
    ORDER BY COALESCE(c.sort_order, 9999) ASC, s.status_key ASC,
             s.sort_order ASC, s.substatus_key ASC
  `);
  const options = rows.map((r, i) => ({
    // Internal name: keep "{STATUS_KEY}__{SUBSTATUS_KEY}" for normal rows so
    // the value remains uniquely scoped to its lead status. The null sentinel
    // (__NULL__) would otherwise produce ugly "__NULL____{SUBSTATUS_KEY}"
    // values — drop the prefix for that row and emit just the substatus_key.
    value:        r.status_key === '__NULL__'
                    ? r.substatus_key
                    : `${r.status_key}__${r.substatus_key}`,
    // Label: only the sub-status label (no "{LS Label} → " prefix); the
    // shorthand prefix inside substatus_key already disambiguates in HubSpot.
    label:        r.sub_label,
    displayOrder: i,
    hidden:       false,
  }));
  // HubSpot requires at least one option on the property; keep a hidden
  // placeholder when the table is empty so the property stays valid.
  if (!options.length) {
    options.push({ value: '__placeholder__', label: '—', displayOrder: 0, hidden: true });
  }
  await axios.patch(
    `${HS}/crm/v3/properties/contacts/hw_lead_substatus`,
    { options },
    { headers: hsHeaders() }
  );
}

const _SUBSTATUS_KEY_RE = /^[A-Z0-9_]{1,64}$/;

function _validateSubstatusBody(body, { partial = false } = {}) {
  const out = {};
  if (body.status_key !== undefined || !partial) {
    const k = String(body.status_key || '').trim().toUpperCase();
    if (!_SUBSTATUS_KEY_RE.test(k)) return { error: 'status_key must be 1–64 uppercase letters, digits, or underscores.' };
    out.status_key = k;
  }
  if (body.substatus_key !== undefined || !partial) {
    const k = String(body.substatus_key || '').trim().toUpperCase();
    if (!_SUBSTATUS_KEY_RE.test(k)) return { error: 'substatus_key must be 1–64 uppercase letters, digits, or underscores.' };
    out.substatus_key = k;
  }
  if (body.label !== undefined || !partial) {
    const v = String(body.label || '').trim();
    if (!v) return { error: 'label cannot be empty.' };
    if (v.length > 128) return { error: 'label must be 128 characters or fewer.' };
    out.label = v;
  }
  if (body.action_label !== undefined) {
    const v = String(body.action_label || '').trim();
    if (v.length > 128) return { error: 'action_label must be 128 characters or fewer.' };
    out.action_label = v;
  }
  if (body.sort_order !== undefined) {
    const n = parseInt(body.sort_order, 10);
    if (Number.isNaN(n)) return { error: 'sort_order must be an integer.' };
    out.sort_order = n;
  }
  return { value: out };
}

// Authenticated read — used by the Sales/Survey card render to look up the
// action label for a contact's hw_lead_substatus value.
app.get('/api/lead-substatuses', isAuthenticated, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, status_key, substatus_key, label, action_label, sort_order
       FROM lead_substatuses
       ORDER BY status_key ASC, sort_order ASC, substatus_key ASC`
    );
    res.set('Cache-Control', 'no-store');
    res.json(rows);
  } catch (e) {
    console.error('GET /api/lead-substatuses error:', e.message);
    res.status(500).json({ error: 'Could not load lead sub-statuses.' });
  }
});

app.get('/api/admin/lead-substatuses', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, status_key, substatus_key, label, action_label, sort_order, updated_at
       FROM lead_substatuses
       ORDER BY status_key ASC, sort_order ASC, substatus_key ASC`
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /api/admin/lead-substatuses error:', e.message);
    res.status(500).json({ error: 'Could not load lead sub-statuses.' });
  }
});

app.post('/api/admin/lead-substatuses', isAuthenticated, requireAdmin, async (req, res) => {
  const { error, value } = _validateSubstatusBody(req.body || {});
  if (error) return res.status(400).json({ error });
  try {
    const { rows } = await pool.query(
      `INSERT INTO lead_substatuses (status_key, substatus_key, label, action_label, sort_order)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, status_key, substatus_key, label, action_label, sort_order, updated_at`,
      [value.status_key, value.substatus_key, value.label, value.action_label || '', value.sort_order ?? 0]
    );
    syncLeadSubstatusesToHubSpot().catch(e =>
      console.warn('  hw_lead_substatus sync failed after create:', e.response?.data?.message || e.message)
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'A sub-status with that key already exists for this lead status.' });
    }
    console.error('POST /api/admin/lead-substatuses error:', e.message);
    res.status(500).json({ error: 'Could not create sub-status.' });
  }
});

app.patch('/api/admin/lead-substatuses/:id', isAuthenticated, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id.' });
  const { error, value } = _validateSubstatusBody(req.body || {}, { partial: true });
  if (error) return res.status(400).json({ error });
  if (!Object.keys(value).length) return res.status(400).json({ error: 'No fields to update.' });

  const sets = [];
  const params = [];
  for (const [col, v] of Object.entries(value)) {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  }
  sets.push(`updated_at = NOW()`);
  params.push(id);
  try {
    const { rows } = await pool.query(
      `UPDATE lead_substatuses SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING id, status_key, substatus_key, label, action_label, sort_order, updated_at`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Sub-status not found.' });
    syncLeadSubstatusesToHubSpot().catch(e =>
      console.warn('  hw_lead_substatus sync failed after update:', e.response?.data?.message || e.message)
    );
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'A sub-status with that key already exists for this lead status.' });
    }
    console.error('PATCH /api/admin/lead-substatuses error:', e.message);
    res.status(500).json({ error: 'Could not update sub-status.' });
  }
});

// ── Card action handlers ─────────────────────────────────────────────────────
// Admins can attach an interactive "handler" to a card action label. Two
// built-in handler types:
//   • add_design_visit_to_calendar — click opens a date/time picker; on submit
//     a `visits` row + (optionally) a Google Calendar event are created via
//     existing endpoints (POST /api/visits, POST /api/events).
//   • summarise_phone_call — click opens a textarea modal; on submit a HubSpot
//     note is created against the active contact, then the UI offers to draft
//     a follow-up email.
//
// A handler can be bound to a (stage_key, status_key) pair OR a
// lead_substatus_id. Both binding shapes are mutually exclusive per row, and
// each target slot can hold at most one handler.
// Per-type config validators. The set of valid handler types is derived from
// the keys of this map, so adding a new handler type here automatically adds
// it to CARD_ACTION_HANDLER_TYPES — the two cannot drift out of sync.
const CARD_ACTION_HANDLER_CONFIG_VALIDATORS = {
  add_design_visit_to_calendar(cfg) {
    const out = {};
    if (cfg.defaultDurationMin !== undefined) {
      const n = parseInt(cfg.defaultDurationMin, 10);
      if (!Number.isInteger(n) || n < 5 || n > 24 * 60) {
        return { error: 'defaultDurationMin must be 5–1440.' };
      }
      out.defaultDurationMin = n;
    }
    if (cfg.defaultTitle !== undefined) {
      const v = String(cfg.defaultTitle || '');
      if (v.length > 120) return { error: 'defaultTitle must be 120 characters or fewer.' };
      out.defaultTitle = v;
    }
    if (cfg.addToGoogleCalendar !== undefined) {
      out.addToGoogleCalendar = !!cfg.addToGoogleCalendar;
    }
    return { value: out };
  },
  summarise_phone_call(cfg) {
    const out = {};
    if (cfg.notePrefix !== undefined) {
      const v = String(cfg.notePrefix || '');
      if (v.length > 120) return { error: 'notePrefix must be 120 characters or fewer.' };
      out.notePrefix = v;
    }
    if (cfg.draftEmailSubject !== undefined) {
      out.draftEmailSubject = String(cfg.draftEmailSubject || '').slice(0, 200);
    }
    return { value: out };
  },
  show_message(cfg) {
    const message = String(cfg.message || '').trim();
    if (!message) return { error: 'message is required for show_message handlers.' };
    if (message.length > 2000) return { error: 'message must be 2000 characters or fewer.' };
    const out = { message };
    if (cfg.title !== undefined) {
      out.title = String(cfg.title || '').slice(0, 120);
    }
    return { value: out };
  },
  start_design_visit(cfg) {
    const out = {};
    if (cfg.defaultDurationMin !== undefined) {
      const n = parseInt(cfg.defaultDurationMin, 10);
      if (!Number.isInteger(n) || n < 5 || n > 1440) {
        return { error: 'defaultDurationMin must be 5–1440.' };
      }
      out.defaultDurationMin = n;
    }
    if (cfg.intermediateLeadStatus !== undefined) {
      const v = String(cfg.intermediateLeadStatus || '').trim();
      if (v.length > 60) return { error: 'intermediateLeadStatus must be 60 characters or fewer.' };
      out.intermediateLeadStatus = v;
    }
    if (cfg.submittedLeadStatus !== undefined) {
      const v = String(cfg.submittedLeadStatus || '').trim();
      if (v.length > 60) return { error: 'submittedLeadStatus must be 60 characters or fewer.' };
      out.submittedLeadStatus = v;
    }
    if (cfg.addToGoogleCalendar !== undefined) {
      out.addToGoogleCalendar = !!cfg.addToGoogleCalendar;
    }
    if (cfg.termsAndConditions !== undefined) {
      const v = String(cfg.termsAndConditions || '');
      if (v.length > 4000) return { error: 'termsAndConditions must be 4000 characters or fewer.' };
      out.termsAndConditions = v;
    }
    return { value: out };
  },
};

const CARD_ACTION_HANDLER_TYPES = new Set(
  Object.keys(CARD_ACTION_HANDLER_CONFIG_VALIDATORS)
);

function _validateHandlerConfig(type, configRaw) {
  let cfg = configRaw;
  if (cfg == null) cfg = {};
  if (typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { error: 'config must be a JSON object.' };
  }
  if (JSON.stringify(cfg).length > 4096) {
    return { error: 'config payload is too large (max 4KB).' };
  }
  let validActionName = null;
  if (cfg.action_name !== undefined && cfg.action_name !== null && cfg.action_name !== '') {
    if (typeof cfg.action_name !== 'string' || !/^[a-z0-9_]+$/.test(cfg.action_name)) {
      return { error: 'action_name must contain only lowercase letters, digits, and underscores (snake_case), with no spaces or other characters.' };
    }
    validActionName = cfg.action_name;
  }
  const validator = CARD_ACTION_HANDLER_CONFIG_VALIDATORS[type];
  if (!validator) return { error: 'Unknown handler type.' };
  const result = validator(cfg);
  if (result.value && validActionName) result.value.action_name = validActionName;
  return result;
}

function _validateHandlerBinding(b) {
  const hasSubstatus = b.substatus_id !== undefined && b.substatus_id !== null && b.substatus_id !== '';
  const stage  = b.stage_key  ? String(b.stage_key).trim().toLowerCase()  : '';
  const status = b.status_key !== undefined && b.status_key !== null
    ? String(b.status_key).trim().toLowerCase()
    : '';
  if (hasSubstatus) {
    const id = parseInt(b.substatus_id, 10);
    if (!Number.isInteger(id) || id <= 0) return { error: 'substatus_id must be a positive integer.' };
    return { value: { substatus_id: id, stage_key: null, status_key: null } };
  }
  if (!stage) return { error: 'Each binding requires a stage_key or substatus_id.' };
  if (!STAGE_ACTION_STAGE_KEYS.has(stage)) {
    return { error: 'stage_key must be one of: sales, designvisit, survey.' };
  }
  if (status.length > 64 || !/^[a-z0-9_]*$/.test(status)) {
    return { error: 'status_key may only contain lowercase letters, digits, and underscores.' };
  }
  return { value: { stage_key: stage, status_key: status, substatus_id: null } };
}

async function ensureCardActionHandlersTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS card_action_handlers (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL,
      config      JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS card_action_handler_bindings (
      id            SERIAL PRIMARY KEY,
      handler_id    INT  NOT NULL REFERENCES card_action_handlers(id) ON DELETE CASCADE,
      stage_key     TEXT,
      status_key    TEXT,
      substatus_id  INT  REFERENCES lead_substatuses(id) ON DELETE CASCADE,
      CHECK (
        (stage_key IS NOT NULL AND substatus_id IS NULL) OR
        (stage_key IS NULL AND substatus_id IS NOT NULL)
      )
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS cahb_label_uniq
      ON card_action_handler_bindings (stage_key, status_key)
      WHERE substatus_id IS NULL
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS cahb_substatus_uniq
      ON card_action_handler_bindings (substatus_id)
      WHERE substatus_id IS NOT NULL
  `);
}

async function checkDuplicateHandlerBindings() {
  const labelDups = await pool.query(`
    SELECT stage_key, status_key, COUNT(*) AS cnt,
           array_agg(DISTINCT handler_id ORDER BY handler_id) AS handler_ids
    FROM card_action_handler_bindings
    WHERE substatus_id IS NULL
    GROUP BY stage_key, status_key
    HAVING COUNT(*) > 1
  `);
  const substatusDups = await pool.query(`
    SELECT substatus_id, COUNT(*) AS cnt,
           array_agg(DISTINCT handler_id ORDER BY handler_id) AS handler_ids
    FROM card_action_handler_bindings
    WHERE substatus_id IS NOT NULL
    GROUP BY substatus_id
    HAVING COUNT(*) > 1
  `);
  const total = labelDups.rows.length + substatusDups.rows.length;
  if (total === 0) return;
  console.warn(`[WARN] card_action_handler_bindings: ${total} duplicate slot(s) detected.`);
  for (const r of labelDups.rows) {
    console.warn(`  [DUPLICATE] label slot stage_key=${r.stage_key} status_key=${r.status_key} bound to handlers: ${r.handler_ids.join(', ')} (${r.cnt} entries)`);
  }
  for (const r of substatusDups.rows) {
    console.warn(`  [DUPLICATE] substatus slot substatus_id=${r.substatus_id} bound to handlers: ${r.handler_ids.join(', ')} (${r.cnt} entries)`);
  }
  console.warn('  Use GET /api/admin/card-action-handlers/conflicts (admin) or the conflict resolver in admin.html to clean these up.');
}

async function _loadHandlerWithBindings(id) {
  const h = await pool.query(
    `SELECT id, name, type, config, created_at, updated_at
     FROM card_action_handlers WHERE id = $1`,
    [id]
  );
  if (!h.rows.length) return null;
  const b = await pool.query(
    `SELECT id, stage_key, status_key, substatus_id
     FROM card_action_handler_bindings WHERE handler_id = $1
     ORDER BY id ASC`,
    [id]
  );
  return { ...h.rows[0], bindings: b.rows };
}

async function _replaceHandlerBindings(client, handlerId, bindings) {
  await client.query(`DELETE FROM card_action_handler_bindings WHERE handler_id = $1`, [handlerId]);
  if (!Array.isArray(bindings) || !bindings.length) return;
  for (const raw of bindings) {
    const { error, value } = _validateHandlerBinding(raw);
    if (error) throw Object.assign(new Error(error), { _userError: true });
    await client.query(
      `INSERT INTO card_action_handler_bindings (handler_id, stage_key, status_key, substatus_id)
       VALUES ($1, $2, $3, $4)`,
      [handlerId, value.stage_key, value.status_key, value.substatus_id]
    );
  }
}

// Authenticated read — used by Sales/Survey/customer-detail to discover which
// label slots are clickable and what they do.
app.get('/api/card-action-handlers', isAuthenticated, async (req, res) => {
  try {
    const h = await pool.query(
      `SELECT id, name, type, config FROM card_action_handlers ORDER BY id ASC`
    );
    const b = await pool.query(
      `SELECT handler_id, stage_key, status_key, substatus_id
       FROM card_action_handler_bindings`
    );
    const byId = {};
    for (const r of h.rows) byId[r.id] = { ...r, bindings: [] };
    for (const r of b.rows) {
      if (byId[r.handler_id]) byId[r.handler_id].bindings.push({
        stage_key: r.stage_key, status_key: r.status_key, substatus_id: r.substatus_id,
      });
    }
    res.set('Cache-Control', 'no-store');
    res.json(Object.values(byId));
  } catch (e) {
    console.error('GET /api/card-action-handlers error:', e.message);
    res.status(500).json({ error: 'Could not load card action handlers.' });
  }
});

app.get('/api/admin/card-action-handlers', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const h = await pool.query(
      `SELECT id, name, type, config, created_at, updated_at
       FROM card_action_handlers ORDER BY id ASC`
    );
    const b = await pool.query(
      `SELECT id, handler_id, stage_key, status_key, substatus_id
       FROM card_action_handler_bindings ORDER BY id ASC`
    );
    const byId = {};
    for (const r of h.rows) byId[r.id] = { ...r, bindings: [] };
    for (const r of b.rows) {
      if (byId[r.handler_id]) byId[r.handler_id].bindings.push({
        id: r.id, stage_key: r.stage_key, status_key: r.status_key, substatus_id: r.substatus_id,
      });
    }
    res.json(Object.values(byId));
  } catch (e) {
    console.error('GET /api/admin/card-action-handlers error:', e.message);
    res.status(500).json({ error: 'Could not load card action handlers.' });
  }
});

app.get('/api/admin/card-action-handlers/conflicts', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const labelDups = await pool.query(`
      SELECT b.stage_key, b.status_key, NULL::int AS substatus_id,
             COUNT(*) AS cnt,
             array_agg(DISTINCT b.handler_id ORDER BY b.handler_id) AS handler_ids,
             array_agg(DISTINCT h.name ORDER BY h.name) AS handler_names
      FROM card_action_handler_bindings b
      JOIN card_action_handlers h ON h.id = b.handler_id
      WHERE b.substatus_id IS NULL
      GROUP BY b.stage_key, b.status_key
      HAVING COUNT(*) > 1
    `);
    const substatusDups = await pool.query(`
      SELECT NULL AS stage_key, NULL AS status_key, b.substatus_id,
             COUNT(*) AS cnt,
             array_agg(DISTINCT b.handler_id ORDER BY b.handler_id) AS handler_ids,
             array_agg(DISTINCT h.name ORDER BY h.name) AS handler_names
      FROM card_action_handler_bindings b
      JOIN card_action_handlers h ON h.id = b.handler_id
      WHERE b.substatus_id IS NOT NULL
      GROUP BY b.substatus_id
      HAVING COUNT(*) > 1
    `);
    const conflicts = [
      ...labelDups.rows.map(r => ({
        type: 'label',
        stage_key: r.stage_key,
        status_key: r.status_key,
        substatus_id: null,
        count: parseInt(r.cnt, 10),
        handler_ids: r.handler_ids,
        handler_names: r.handler_names,
      })),
      ...substatusDups.rows.map(r => ({
        type: 'substatus',
        stage_key: null,
        status_key: null,
        substatus_id: r.substatus_id,
        count: parseInt(r.cnt, 10),
        handler_ids: r.handler_ids,
        handler_names: r.handler_names,
      })),
    ];
    res.json({ conflicts, total: conflicts.length });
  } catch (e) {
    console.error('GET /api/admin/card-action-handlers/conflicts error:', e.message);
    res.status(500).json({ error: 'Could not load handler binding conflicts.' });
  }
});

app.post('/api/admin/card-action-handlers', isAuthenticated, requireAdmin, async (req, res) => {
  // `name` is optional and now derives from the bound row's action label
  // on the client. Empty/missing is accepted; a non-empty value is still
  // length-checked for safety.
  const name = String(req.body?.name || '').trim();
  const type = String(req.body?.type || '').trim();
  if (name.length > 80) return res.status(400).json({ error: 'name must be 80 characters or fewer.' });
  if (!CARD_ACTION_HANDLER_TYPES.has(type)) {
    return res.status(400).json({ error: `type must be ${[...CARD_ACTION_HANDLER_TYPES].join(', ')}.` });
  }
  const cfgValidation = _validateHandlerConfig(type, req.body?.config);
  if (cfgValidation.error) return res.status(400).json({ error: cfgValidation.error });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO card_action_handlers (name, type, config)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id`,
      [name, type, JSON.stringify(cfgValidation.value)]
    );
    const handlerId = rows[0].id;
    await _replaceHandlerBindings(client, handlerId, req.body?.bindings || []);
    await client.query('COMMIT');
    const full = await _loadHandlerWithBindings(handlerId);
    res.status(201).json(full);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e._userError) return res.status(400).json({ error: e.message });
    if (e.code === '23505') return res.status(409).json({ error: 'A handler is already bound to that slot.' });
    console.error('POST /api/admin/card-action-handlers error:', e.message);
    res.status(500).json({ error: 'Could not create handler.' });
  } finally {
    client.release();
  }
});

app.patch('/api/admin/card-action-handlers/:id', isAuthenticated, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id.' });

  const existing = await _loadHandlerWithBindings(id);
  if (!existing) return res.status(404).json({ error: 'Handler not found.' });

  const updates = [];
  const params  = [];
  if (req.body?.name !== undefined) {
    const v = String(req.body.name || '').trim();
    if (v.length > 80) return res.status(400).json({ error: 'name must be 80 characters or fewer.' });
    params.push(v); updates.push(`name = $${params.length}`);
  }
  let effectiveType = existing.type;
  if (req.body?.type !== undefined) {
    const t = String(req.body.type || '').trim();
    if (!CARD_ACTION_HANDLER_TYPES.has(t)) {
      return res.status(400).json({ error: `type must be ${[...CARD_ACTION_HANDLER_TYPES].join(', ')}.` });
    }
    effectiveType = t;
    params.push(t); updates.push(`type = $${params.length}`);
  }
  if (req.body?.config !== undefined) {
    const cv = _validateHandlerConfig(effectiveType, req.body.config);
    if (cv.error) return res.status(400).json({ error: cv.error });
    params.push(JSON.stringify(cv.value)); updates.push(`config = $${params.length}::jsonb`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (updates.length) {
      updates.push(`updated_at = NOW()`);
      params.push(id);
      await client.query(
        `UPDATE card_action_handlers SET ${updates.join(', ')} WHERE id = $${params.length}`,
        params
      );
    }
    if (req.body?.bindings !== undefined) {
      await _replaceHandlerBindings(client, id, req.body.bindings || []);
    }
    await client.query('COMMIT');
    const full = await _loadHandlerWithBindings(id);
    res.json(full);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e._userError) return res.status(400).json({ error: e.message });
    if (e.code === '23505') return res.status(409).json({ error: 'A handler is already bound to that slot.' });
    console.error('PATCH /api/admin/card-action-handlers error:', e.message);
    res.status(500).json({ error: 'Could not update handler.' });
  } finally {
    client.release();
  }
});

app.delete('/api/admin/card-action-handlers/:id', isAuthenticated, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const r = await pool.query(`DELETE FROM card_action_handlers WHERE id = $1 RETURNING id`, [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Handler not found.' });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/admin/card-action-handlers error:', e.message);
    res.status(500).json({ error: 'Could not delete handler.' });
  }
});

// Execute: summarise_phone_call → posts a HubSpot note against the contact.
app.post('/api/card-actions/phone-call-summary',
  isAuthenticated, requirePrivilege('member'), requireHubspotToken, hubspotMutationLimiter,
  async (req, res) => {
    const contactId = String(req.body?.contactId || '');
    if (!/^\d+$/.test(contactId)) return res.status(400).json({ error: 'Invalid contactId.' });
    const summary = String(req.body?.summary || '').trim();
    if (!summary) return res.status(400).json({ error: 'summary is required.' });
    if (summary.length > 8000) return res.status(400).json({ error: 'summary must be 8000 characters or fewer.' });
    const prefix = String(req.body?.notePrefix || '').slice(0, 120);
    const body = prefix ? `${prefix}\n\n${summary}` : summary;
    try {
      const noteR = await hubspotRequestWithRetry('post',
        `${HS}/crm/v3/objects/notes`,
        { properties: { hs_note_body: body, hs_timestamp: new Date().toISOString() } }
      );
      await hubspotRequestWithRetry('put',
        `${HS}/crm/v3/objects/notes/${noteR.data.id}/associations/contacts/${encodeURIComponent(contactId)}/note_to_contact`,
        {}
      );
      res.json({ ok: true, noteId: noteR.data.id });
    } catch (e) {
      const status = e.response?.status;
      if (status === 401 || status === 403) {
        return res.status(502).json({ error: 'HubSpot rejected the request.', code: 'HUBSPOT_AUTH' });
      }
      if (status === 429) {
        return res.status(502).json({ error: 'HubSpot rate limit reached.', code: 'HUBSPOT_RATE_LIMIT' });
      }
      console.error('POST /api/card-actions/phone-call-summary error:', e.response?.data || e.message);
      res.status(502).json({ error: e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
    }
  }
);

// ── WhatsApp config probe (no creds needed — just reports if configured) ──────
app.get('/api/whatsapp/config', isAuthenticated, (req, res) => {
  res.json({
    enabled: !!(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID),
  });
});

// ── WhatsApp (Meta Cloud API) ─────────────────────────────────────────────────
const META_GRAPH = 'https://graph.facebook.com/v19.0';

function requireWhatsAppConfig(req, res, next) {
  if (!process.env.WHATSAPP_ACCESS_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) {
    return res.status(503).json({
      error: 'WhatsApp is not configured. Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID in your environment secrets.'
    });
  }
  next();
}

// Cache the WABA ID (valid for server lifetime).
// Uses WHATSAPP_BUSINESS_ACCOUNT_ID directly if set; otherwise derives it
// from the phone number ID via the Graph API.
let _wabaId = null;
async function getWabaId() {
  if (_wabaId) return _wabaId;
  if (process.env.WHATSAPP_BUSINESS_ACCOUNT_ID) {
    _wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
    return _wabaId;
  }
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const r = await axios.get(
    `${META_GRAPH}/${encodeURIComponent(phoneNumberId)}`,
    {
      params: { fields: 'whatsapp_business_account', access_token: process.env.WHATSAPP_ACCESS_TOKEN },
      timeout: 8000,
    }
  );
  _wabaId = r.data?.whatsapp_business_account?.id || null;
  return _wabaId;
}

app.get('/api/whatsapp/templates', isAuthenticated, requireAdmin, requireWhatsAppConfig, async (req, res) => {
  try {
    const wabaId = await getWabaId();
    if (!wabaId) return res.json([]);
    const r = await axios.get(
      `${META_GRAPH}/${encodeURIComponent(wabaId)}/message_templates`,
      {
        params: { status: 'APPROVED', limit: 100, access_token: process.env.WHATSAPP_ACCESS_TOKEN },
        timeout: 10000,
      }
    );
    const templates = (r.data?.data || []).map(t => ({
      name:     t.name,
      language: t.language,
      category: t.category,
      components: (t.components || []).map(c => ({
        type:       c.type,
        text:       c.text || '',
        parameters: (c.example?.body_text?.[0] || []).map((ex, i) => ({
          index:   i + 1,
          example: ex,
        })),
      })),
    }));
    res.json(templates);
  } catch (e) {
    const status = e.response?.status;
    if (status === 401 || status === 403) {
      return res.status(502).json({ error: 'Meta API rejected the request — check your WHATSAPP_ACCESS_TOKEN.' });
    }
    console.error('GET /api/whatsapp/templates error:', e.response?.data || e.message);
    res.status(502).json({ error: e.response?.data?.error?.message || 'Could not fetch WhatsApp templates.' });
  }
});

app.post('/api/whatsapp/send', isAuthenticated, requireAdmin, requireWhatsAppConfig, whatsappSendLimiter, async (req, res) => {
  const { contactPhone, contactId, mode, templateName, templateLanguage, templateParams, message } = req.body;

  if (!contactPhone || typeof contactPhone !== 'string') {
    return res.status(400).json({ error: 'contactPhone is required.' });
  }
  // Normalise phone: strip everything except digits and leading +
  const digitsOnly = contactPhone.replace(/[^\d]/g, '');
  if (!digitsOnly || digitsOnly.length < 7) {
    return res.status(400).json({ error: 'Invalid phone number.' });
  }

  // contactId is required — we must be able to verify the phone belongs to this contact
  if (!contactId || !/^\d+$/.test(String(contactId))) {
    return res.status(400).json({ error: 'contactId is required and must be numeric.' });
  }
  const safeContactId = String(contactId);

  // Verify the supplied phone number matches the contact's phone in HubSpot
  // to prevent sending to arbitrary numbers or poisoning the audit log
  if (!process.env.HUBSPOT_ACCESS_TOKEN) {
    return res.status(503).json({ error: 'HubSpot is not configured — cannot verify contact phone number.' });
  }
  try {
    const hsContact = await axios.get(`${HS}/crm/v3/objects/contacts/${encodeURIComponent(safeContactId)}`, {
      headers: hsHeaders(),
      params: { properties: 'phone,mobilephone' },
    });
    const hsPhone       = (hsContact.data?.properties?.phone       || '').replace(/[^\d]/g, '');
    const hsMobilePhone = (hsContact.data?.properties?.mobilephone || '').replace(/[^\d]/g, '');
    const phoneMatches  = (hsPhone && hsPhone === digitsOnly) || (hsMobilePhone && hsMobilePhone === digitsOnly);
    if (!phoneMatches) {
      return res.status(403).json({ error: 'The supplied phone number does not match this contact\'s phone on record.' });
    }
  } catch (e) {
    const status = e.response?.status;
    if (status === 404) return res.status(404).json({ error: 'Contact not found in HubSpot.' });
    if (status === 401 || status === 403) return res.status(502).json({ error: 'HubSpot rejected the request — check the token.' });
    console.error('WhatsApp send — HubSpot contact lookup error:', e.response?.data || e.message);
    return res.status(502).json({ error: 'Could not verify contact phone number with HubSpot.' });
  }

  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  let body;

  if (mode === 'template') {
    if (!templateName) return res.status(400).json({ error: 'templateName is required for template mode.' });
    const components = [];
    if (Array.isArray(templateParams) && templateParams.length > 0) {
      components.push({
        type: 'body',
        parameters: templateParams.map(v => ({ type: 'text', text: String(v) })),
      });
    }
    body = {
      messaging_product: 'whatsapp',
      to: digitsOnly,
      type: 'template',
      template: {
        name: templateName,
        language: { code: templateLanguage || 'en_US' },
        ...(components.length ? { components } : {}),
      },
    };
  } else if (mode === 'freeform') {
    if (!message || !message.trim()) return res.status(400).json({ error: 'message is required for freeform mode.' });
    body = {
      messaging_product: 'whatsapp',
      to: digitsOnly,
      type: 'text',
      text: { body: message.trim() },
    };
  } else {
    return res.status(400).json({ error: 'mode must be "template" or "freeform".' });
  }

  try {
    await axios.post(
      `${META_GRAPH}/${encodeURIComponent(phoneNumberId)}/messages`,
      body,
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );

    const messageText = mode === 'freeform' ? (message || '').trim() : null;
    const tplName = mode === 'template' ? (templateName || null) : null;
    const tplParams = (mode === 'template' && Array.isArray(templateParams) && templateParams.length > 0)
      ? JSON.stringify(templateParams.map(v => String(v)))
      : null;
    pool.query(
      `INSERT INTO whatsapp_messages (contact_id, sender_user_id, mode, template_name, template_params, message_text)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [safeContactId, req.user.id, mode, tplName, tplParams, messageText]
    ).catch(e => console.error('whatsapp_messages insert error:', e.message));

    res.json({ ok: true });
  } catch (e) {
    const status   = e.response?.status;
    const metaErr  = e.response?.data?.error;
    const metaCode = metaErr?.code;
    const metaMsg  = metaErr?.message || e.message;

    if (status === 401 || status === 403) {
      return res.status(502).json({ error: 'Meta API rejected the request — check your WHATSAPP_ACCESS_TOKEN.' });
    }
    // 131047 = message failed to send because more than 24 hours have passed
    if (metaCode === 131047 || (metaMsg || '').includes('24 hour')) {
      return res.status(422).json({ error: 'Outside the 24-hour messaging window. You can only send template messages to this customer right now.', code: 'OUTSIDE_WINDOW' });
    }
    // 131026 = recipient phone number not in allowed list / not a WhatsApp user
    if (metaCode === 131026) {
      return res.status(422).json({ error: 'That phone number is not registered on WhatsApp.', code: 'NOT_ON_WHATSAPP' });
    }
    console.error('POST /api/whatsapp/send error:', metaErr || e.message);
    res.status(502).json({ error: metaMsg || 'Failed to send WhatsApp message.' });
  }
});

// ── WhatsApp Message Log ──────────────────────────────────────────────────────
async function ensureWhatsAppMessagesTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id              SERIAL PRIMARY KEY,
    contact_id      TEXT        NOT NULL,
    sender_user_id  VARCHAR     NOT NULL REFERENCES users(id),
    mode            TEXT        NOT NULL CHECK (mode IN ('template','freeform')),
    template_name   TEXT,
    template_params TEXT,
    message_text    TEXT,
    sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS template_params TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS whatsapp_messages_contact_idx ON whatsapp_messages(contact_id, sent_at DESC)`);
}

app.get('/api/whatsapp/history/:contactId', isAuthenticated, requireAdmin, async (req, res) => {
  const { contactId } = req.params;
  if (!contactId || !/^\d+$/.test(contactId)) {
    return res.status(400).json({ error: 'Invalid contactId.' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT w.id, w.contact_id, w.mode, w.template_name, w.template_params, w.message_text, w.sent_at,
              u.first_name, u.last_name, u.email AS sender_email
       FROM whatsapp_messages w
       JOIN users u ON u.id = w.sender_user_id
       WHERE w.contact_id = $1
       ORDER BY w.sent_at DESC
       LIMIT 50`,
      [contactId]
    );
    res.json({ messages: rows });
  } catch (e) {
    console.error('GET /api/whatsapp/history error:', e.message);
    res.status(500).json({ error: 'Could not load WhatsApp history.' });
  }
});

// ── Workshop Settings ─────────────────────────────────────────────────────────
const WORKSHOP_SETTINGS_DEFAULTS = [
  { key: 'integral_lead_time_days',       label: 'Integral Lead Times',            value: '14' },
  { key: 'interfit_drawer_box_lead_time_days', label: 'Interfit Drawer Box Lead Times', value: '14' },
];

async function ensureWorkshopSettingsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workshop_settings (
      key        TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      value      TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMP DEFAULT NOW(),
      updated_by TEXT
    )
  `);
  for (const row of WORKSHOP_SETTINGS_DEFAULTS) {
    await pool.query(
      `INSERT INTO workshop_settings (key, label, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO NOTHING`,
      [row.key, row.label, row.value]
    );
  }
}

app.get('/api/admin/workshop-settings', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT key, label, value, updated_at, updated_by FROM workshop_settings ORDER BY key ASC'
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /api/admin/workshop-settings error:', e.message);
    res.status(500).json({ error: 'Could not load workshop settings.' });
  }
});

app.patch('/api/admin/workshop-settings', isAuthenticated, requireAdmin, async (req, res) => {
  const { key, value } = req.body || {};
  if (!key || typeof key !== 'string') return res.status(400).json({ error: 'key is required.' });
  const trimmedValue = typeof value === 'string' ? value.trim() : String(value ?? '');
  const adminEmail = req.user?.claims?.email || req.user?.email || 'unknown';
  try {
    const existing = await pool.query('SELECT value, label FROM workshop_settings WHERE key = $1', [key]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Setting not found.' });
    const oldValue = existing.rows[0].value;
    const label    = existing.rows[0].label;
    await pool.query(
      `UPDATE workshop_settings SET value = $1, updated_at = NOW(), updated_by = $2 WHERE key = $3`,
      [trimmedValue, adminEmail, key]
    );
    await logAdminAction(
      adminEmail,
      'edit_workshop_setting',
      null,
      `${label} (${key}): ${oldValue} → ${trimmedValue}`
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('PATCH /api/admin/workshop-settings error:', e.message);
    res.status(500).json({ error: 'Could not save workshop setting.' });
  }
});

async function ensureSearchSettingsTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS search_settings (
    id INTEGER PRIMARY KEY DEFAULT 1,
    disabled_actions JSONB NOT NULL DEFAULT '[]',
    hint_placeholder TEXT NOT NULL DEFAULT '',
    action_order JSONB NOT NULL DEFAULT '[]'
  )`);
  await pool.query(`INSERT INTO search_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
}

app.get('/api/search-settings', isAuthenticated, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT disabled_actions, hint_placeholder, action_order FROM search_settings WHERE id = 1'
    );
    res.json(rows[0] || { disabled_actions: [], hint_placeholder: '', action_order: [] });
  } catch (e) {
    console.error('GET /api/search-settings error:', e.message);
    res.status(500).json({ error: 'Could not load search settings.' });
  }
});

app.get('/api/admin/search-settings', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT disabled_actions, hint_placeholder, action_order FROM search_settings WHERE id = 1'
    );
    res.json(rows[0] || { disabled_actions: [], hint_placeholder: '', action_order: [] });
  } catch (e) {
    console.error('GET /api/admin/search-settings error:', e.message);
    res.status(500).json({ error: 'Could not load search settings.' });
  }
});

app.put('/api/admin/search-settings', isAuthenticated, requireAdmin, async (req, res) => {
  const { disabled_actions, hint_placeholder, action_order } = req.body;
  try {
    await pool.query(
      `UPDATE search_settings
       SET disabled_actions = $1::jsonb, hint_placeholder = $2, action_order = $3::jsonb
       WHERE id = 1`,
      [
        JSON.stringify(Array.isArray(disabled_actions) ? disabled_actions : []),
        typeof hint_placeholder === 'string' ? hint_placeholder.slice(0, 200) : '',
        JSON.stringify(Array.isArray(action_order) ? action_order : []),
      ]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/admin/search-settings error:', e.message);
    res.status(500).json({ error: 'Could not save search settings.' });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    const ok = await setupAuth(app);
    if (ok) console.log('  Auth (email + password) initialized');
  } catch (e) {
    console.error('  Auth setup failed:', e.message);
  }

  // 404 catch-all must be registered AFTER setupAuth so auth routes are matched first.
  app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  });

  // Warn when the React bundle is older than any source file it was built from.
  // This catches stale bundles in development (e.g. after a git pull without
  // running build:react).  Skipped in production where the build step always
  // runs before deployment.
  if (process.env.NODE_ENV !== 'production') {
    try {
      const bundleEntry = path.join(__dirname, 'public', 'react', 'main.js');
      if (fs.existsSync(bundleEntry)) {
        const bundleMtime = fs.statSync(bundleEntry).mtimeMs;
        const srcDir = path.join(__dirname, 'src', 'react');
        let newestSrcMtime = 0;
        let newestSrcFile = '';
        (function scanDir(dir) {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              scanDir(full);
            } else if (/\.(ts|tsx|css)$/.test(entry.name)) {
              const mtime = fs.statSync(full).mtimeMs;
              if (mtime > newestSrcMtime) { newestSrcMtime = mtime; newestSrcFile = full; }
            }
          }
        })(srcDir);
        if (newestSrcMtime > bundleMtime) {
          const rel = path.relative(__dirname, newestSrcFile);
          console.warn(`[STALE BUNDLE] public/react/main.js is older than ${rel} — run npm run build:react`);
        }
      } else {
        console.warn('[STALE BUNDLE] public/react/main.js not found — run npm run build:react');
      }
    } catch (e) {
      // Non-fatal: a warning failure must not prevent startup.
    }
  }

  app.listen(PORT, HOST, async () => {
    console.log(`\n  Measure Once`);
    console.log(`  Running at: http://localhost:${PORT}\n`);
    if (process.env.DEBUG_HUBSPOT) {
      console.warn('[DEBUG] DEBUG_HUBSPOT is enabled — verbose HubSpot rate-limit and stale-cache logs are active. Unset this flag in production.');
    }
    await ensureHubSpotProperties();
    try { await ensureVisitsTable(); console.log('  Visits table ready'); }
    catch (e) { console.error('  Visits table setup failed:', e.message); }
    try { await ensureTradesTable(); console.log('  Trades table ready'); }
    catch (e) { console.error('  Trades table setup failed:', e.message); }
    try { await ensureIdeasTables(); console.log('  Ideas tables ready'); }
    catch (e) { console.error('  Ideas tables setup failed:', e.message); }
    try { await ensureLeadStatusTable(); console.log('  Lead status config table ready'); }
    catch (e) { console.error('  Lead status table setup failed:', e.message); }
    try { await backfillLeadStatusShorthands(); }
    catch (e) { console.error('  Lead status shorthand backfill failed:', e.message); }
    try { await ensureStageActionLabelsTable(); console.log('  Stage action labels table ready'); }
    catch (e) { console.error('  Stage action labels table setup failed:', e.message); }
    try { await seedStageActionLabelsDefaults(); console.log('  Stage action labels defaults seeded'); }
    catch (e) { console.error('  Stage action labels seed failed:', e.message); }
    try { await ensureLeadSubstatusesTable(); console.log('  Lead sub-statuses table ready'); }
    catch (e) { console.error('  Lead sub-statuses table setup failed:', e.message); }
    try { await ensureHwTestUserProperty(); console.log('  hw_test_user HubSpot property ready (dev)'); }
    catch (e) { console.error('  hw_test_user property setup failed:', e.message); }
    try { await ensureHwLeadSubstatusProperty(); console.log('  hw_lead_substatus HubSpot property ready'); }
    catch (e) { console.error('  hw_lead_substatus property setup failed:', e.message); }
    try { await syncLeadSubstatusesToHubSpot(); console.log('  hw_lead_substatus options synced'); }
    catch (e) { console.warn('  hw_lead_substatus sync skipped:', e.response?.data?.message || e.message); }
    try { await ensureCardActionHandlersTables(); console.log('  Card action handlers tables ready'); }
    catch (e) { console.error('  Card action handlers tables setup failed:', e.message); }
    try { await checkDuplicateHandlerBindings(); }
    catch (e) { console.error('  Card action handler duplicate-binding check failed:', e.message); }
    try { await ensureSearchSettingsTable(); console.log('  Search settings table ready'); }
    catch (e) { console.error('  Search settings table setup failed:', e.message); }
    try { await ensureWorkshopSettingsTable(); console.log('  Workshop settings table ready'); }
    catch (e) { console.error('  Workshop settings table setup failed:', e.message); }
    try { await ensureAppSettingsTable(); console.log('  App settings table ready'); }
    catch (e) { console.error('  App settings table setup failed:', e.message); }
    try { await ensureWhatsAppMessagesTable(); console.log('  WhatsApp messages table ready'); }
    catch (e) { console.error('  WhatsApp messages table setup failed:', e.message); }
    try { await ensureDesignVisitTables(); console.log('  Design visit tables ready'); }
    catch (e) { console.error('  Design visit tables setup failed:', e.message); }
    try { await ensureDbEditorAuditTable(); console.log('  DB editor audit table ready'); }
    catch (e) { console.error('  DB editor audit table setup failed:', e.message); }
    scheduleConflictDigest();
  });
})();
