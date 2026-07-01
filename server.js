require('dotenv').config();
const express = require('express');
const compression = require('compression');
const axios = require('axios').create({ timeout: 10000 });
const { google } = require('googleapis');
// Test-only: helper functions that override rootUrl on individual API clients
// when GOOGLE_APIS_BASE_URL is set (non-production only).  google.options() does
// not propagate rootUrl in googleapis v128; it must be passed per-client.
function getCalendarClient(auth) {
  const opts = { version: 'v3', auth };
  if (process.env.GOOGLE_APIS_BASE_URL && process.env.NODE_ENV !== 'production') {
    opts.rootUrl = process.env.GOOGLE_APIS_BASE_URL;
  }
  return google.calendar(opts);
}
function getGmailClient(auth) {
  const opts = { version: 'v1', auth };
  if (process.env.GOOGLE_APIS_BASE_URL && process.env.NODE_ENV !== 'production') {
    opts.rootUrl = process.env.GOOGLE_APIS_BASE_URL;
  }
  return google.gmail(opts);
}
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const _emailAttachUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
});
const logger = require('./logger');
const { runMigrations, ensureRateLimitMigrations } = require('./db-migrate');
const { encrypt: encryptToken, decrypt: decryptToken, tryDecrypt: tryDecryptToken } = require('./google-token-crypto.cjs');
const { installSession, setupAuth, isAuthenticated, requirePageAuth, requireAdmin, requireManagerOrAdmin, requirePrivilege, requireOnboardingComplete, userIdExists, isAdminEmail, pool, logAdminAction, getRequestPrivilegeLevel, scheduleConflictDigest } = require('./auth');
const {
  hubspotMutationLimiter,
  gmailSendLimiter,
  calendarEventLimiter,
  personalTaskCreateLimiter,
  tradesCreateLimiter,
  prefsWriteLimiter,
  whatsappSendLimiter,
  quickbooksReadWriteLimiter,
} = require('./rate-limiters');
const quickbooksRoutes = require('./quickbooks');
const { router: googleMapsRouter, schedulePruneOldUsage } = require('./google-maps');
const {
  ARRANGE_VISIT_KEYS    : _ARRANGE_VISIT_KEYS,
  DVF_STATUS_MAP        : _DVF_STATUS_MAP,
  CONTACT_CUSTOMER_MAP  : _CONTACT_CUSTOMER_MAP,
  getArrangeVisitStatus,
} = require('./shared/handler-route-contracts.cjs');
// ↑ handler-route-contracts.cjs derives every accepted key set from the outcome registry
// (shared/handler-outcomes.cjs) so server routes and the WorkflowPage outcome chips
// always agree.  Exceptions are documented in handler-route-contracts.cjs.

// deposit_invoice_followup accepted keys are only used inside this file; keep inline.
const { getTerminalStatusMap, getOutcomeMeta, getRequiredOutcomeEmailTemplate } = require('./shared/handler-outcomes.cjs');
const { GLOBAL_NULL_STAGE_KEY } = require('./shared/slotConstants.cjs');
const { structuredAddressSchema, hubspotToAddress, addressToHubspot, formatAddress } = require('./shared/address.cjs');
const _DI_TERMINAL_STATUS   = getTerminalStatusMap('deposit_invoice_followup');
const { getCredential, CRED_MAP } = require('./hubspot-creds');
// visits.js retired — visits table dropped, all visit creation now via Google Calendar
const { router: designVisitsRouter, setPatchContactProperties: setDvPatchContactProperties, setHubSpotContactHelpers: setDvHubSpotContactHelpers, ensureStartDesignVisitHandlerBindings } = require('./design-visits');
const { router: surveyVisitsRouter, setPatchContactProperties: setSvPatchContactProperties, ensureStartSurveyVisitHandlerBindings } = require('./survey-visits');
const { router: customerInfoRouter, ensureResendLogTable, backfillMaskedEmails, logNullFormLinkCount, signCustomerPhotoUrl, setSharedSseClients: setCustomerInfoSseClients, setPatchContactProperties: setCiPatchContactProperties, searchHubSpotContactByEmail, createHubSpotContact } = require('./customer-info');
const { router: photoReviewsRouter, ensurePhotoReviewOutcomesTable, ensureContactCustomerHandlerBindings, setPatchContactProperties: setPrPatchContactProperties } = require('./photo-reviews');
const { ensureEmailTemplatesTable, getEmailTemplate, invalidateEmailTemplate, TEMPLATE_DEFS, TEMPLATE_KEYS, SAMPLE_VARS, renderEmail, escapeHtml, plainTextToHtml, buildUserSignature, getEmailCompanyName, buildSenderSignature } = require('./email-templates');
const { assertLeadStatusKey, invalidateLeadStatusCache } = require('./lead-status-guard');
const { logCustomerEmailAttempt } = require('./contact-attempt-log');
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
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

// ── HubSpot webhook receiver (raw body needed for HMAC) ───────────────────────
// Registered BEFORE express.json() so the raw Buffer is available for
// signature verification. A separate express.raw() middleware is applied
// inline to this single route only.
const _hsWebhookSseClients = new Set();
// Per-user connection tracking for SSE abuse prevention.
// Maps userId -> Set of active response objects.
const _hsWebhookSseByUser = new Map();
const HS_SSE_PER_USER_CAP = 5;   // max concurrent SSE connections per user
const HS_SSE_GLOBAL_CAP   = 100; // max total SSE connections across all users
const HS_SSE_MAX_DURATION = 30 * 60 * 1000; // forcibly close after 30 min
const HS_SSE_HEARTBEAT_MS = 25 * 1000;      // heartbeat interval to detect dead connections
setCustomerInfoSseClients(_hsWebhookSseClients);
// Wire the shared patchContactProperties helper into every module that mutates
// hs_lead_status so cache invalidation is guaranteed on every PATCH path.
setDvPatchContactProperties((contactId, properties) => patchContactProperties(contactId, properties));
setSvPatchContactProperties((contactId, properties) => patchContactProperties(contactId, properties));
setCiPatchContactProperties((contactId, properties) => patchContactProperties(contactId, properties));
setPrPatchContactProperties((contactId, properties) => patchContactProperties(contactId, properties));
// Wire HubSpot contact create-or-match into design-visits for the standalone
// offline design-visit page's brand-new-customer path (all HubSpot I/O stays
// server-side; the offline device never calls HubSpot directly).
setDvHubSpotContactHelpers({
  searchByEmail: searchHubSpotContactByEmail,
  create: createHubSpotContact,
});
quickbooksRoutes.setPatchContactProperties((contactId, properties) => patchContactProperties(contactId, properties));
quickbooksRoutes.setAssertLeadStatusKey((key) => assertLeadStatusKey(key));

app.post('/api/hubspot/webhook',
  express.raw({ type: '*/*', limit: '2mb' }),
  (req, res) => {
    const secret = getCredential('client_secret');
    if (!secret) {
      if (process.env.NODE_ENV === 'production') {
        logger.warn('[hs-webhook] HUBSPOT_CLIENT_SECRET not set — rejecting webhook (production)');
        return res.status(400).json({ error: 'Webhook signature verification not configured.' });
      }
      // Dev/staging: skip verification with a warning.
      logger.warn('[hs-webhook] HUBSPOT_CLIENT_SECRET not set — skipping signature verification (non-production dev convenience)');
    } else {
      // Verify HubSpot v3 HMAC signature.
      // Spec: HMAC-SHA256 of "{METHOD}{full URL}{raw body}{timestamp}", base64-encoded.
      const sigHeader = req.headers['x-hubspot-signature-v3'];
      const tsHeader  = req.headers['x-hubspot-request-timestamp'];
      if (!sigHeader || !tsHeader) {
        return res.status(400).json({ error: 'Missing HubSpot signature headers.' });
      }
      const ts = parseInt(tsHeader, 10);
      if (isNaN(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) {
        return res.status(400).json({ error: 'Request timestamp out of range — possible replay.' });
      }
      const rawBody  = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
      const fullUrl  = `${protocol}://${req.get('host')}${req.originalUrl}`;
      const toSign   = `POST${fullUrl}${rawBody.toString('utf8')}${tsHeader}`;
      const expected = crypto.createHmac('sha256', secret).update(toSign).digest('base64');
      const expBuf = Buffer.from(expected);
      const sigBuf = Buffer.from(sigHeader);
      if (expBuf.length !== sigBuf.length || !crypto.timingSafeEqual(expBuf, sigBuf)) {
        return res.status(400).json({ error: 'Signature mismatch.' });
      }
    }

    let events;
    try {
      const bodyStr = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '[]';
      const parsed  = JSON.parse(bodyStr);
      events = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return res.status(400).json({ error: 'Invalid JSON payload.' });
    }

    // Collect contact IDs where a relevant lead-status property changed.
    const WATCHED_PROPS = new Set(['hs_lead_status']);
    const affectedIds   = new Set();
    for (const ev of events) {
      if (ev.subscriptionType === 'contact.propertyChange' &&
          WATCHED_PROPS.has(ev.propertyName) && ev.objectId) {
        affectedIds.add(String(ev.objectId));
      }
    }

    if (affectedIds.size > 0) {
      // Bust server-side caches so the next poll returns fresh data.
      clearContactCache();
      _invalidateLeadStatusCountsCache();
      _invalidateOpenLeadsCache();
      _invalidateProjectContactsCache();

      // Push a lightweight SSE event to all connected browser tabs.
      const sseMsg = `data: ${JSON.stringify({ type: 'hs_lead_status_changed', contactIds: [...affectedIds] })}\n\n`;
      for (const client of _hsWebhookSseClients) {
        try { client.write(sseMsg); } catch { _hsWebhookSseClients.delete(client); }
      }
    }

    res.status(200).json({ ok: true, affected: affectedIds.size });
  }
);

// ── Middleware ────────────────────────────────────────────────────────────────
// Gzip all compressible responses (HTML, CSS, JS bundles, JSON API payloads).
// Cloud Run does not compress on our behalf, so without this every text asset is
// served at full size — the always-loaded React bundle alone is ~400kB raw but
// ~110kB gzipped. Respects the client's Accept-Encoding and skips already-binary
// assets (images, fonts/WOFF2). `Cache-Control: no-transform` responses are left
// untouched by the middleware automatically.
app.use(compression());
app.use(express.json({ limit: '25mb' }));

// Clean URLs for each page (no .html extension). Must precede express.static so the
// extensionless paths win over any default static-index handling.
// /trades, /admin, /projects are protected — handled below after auth middleware is set up
app.get('/',          (_req, res) => res.render('index',     { title: 'Home · Harry Wardrobes',      description: 'Your Harry Wardrobes project dashboard — track jobs, customers, and design visits in one place.' }));
app.get('/customers', (_req, res) => res.render('customers', { title: 'Customers · Harry Wardrobes',  description: 'Browse and manage your customer accounts, contact details, and project history.' }));
app.get('/profile',   (_req, res) => res.render('profile',   { title: 'Profile · Harry Wardrobes',    description: 'Update your personal details, preferences, and account settings.' }));

// Dynamic customer detail page
app.get('/customers/:id', (req, res) => {
  res.render('customer-detail', { title: 'Customer · Harry Wardrobes' });
});

// Canonicalise the admin URL: /admin.html → /admin so the protected route
// below is the single entry point (and static can't serve the page directly).
app.get('/admin.html', (req, res) => res.redirect(301, '/admin'));

// Redirect .html variants of privilege-restricted pages to their clean URL
// so the single protected route below is the only entry point.
app.get('/projects.html', (req, res) => res.redirect(301, '/projects'));

// Public design-visit sign-off page (no auth required — token-gated)
app.get('/design-visit/sign-off', async (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  let ogTitle = 'Design Visit Sign-Off · Harry Wardrobes';
  let ogDescription = 'Review and sign off on your design visit details with Harry Wardrobes.';
  let pageTitle = 'Design Visit Sign-Off · Harry Wardrobes';
  const rawToken = String(req.query.token || '').trim();
  if (rawToken && rawToken.length <= 200) {
    try {
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const { rows } = await pool.query(
        `SELECT contact_name FROM design_visits WHERE signoff_token_hash = $1 LIMIT 1`,
        [tokenHash]
      );
      if (rows.length && rows[0].contact_name) {
        const name = rows[0].contact_name;
        ogTitle = `Design Visit Sign-Off for ${name} · Harry Wardrobes`;
        ogDescription = `${name} has been sent a design visit sign-off request. Review and sign off on the details with Harry Wardrobes.`;
        pageTitle = `Design Visit Sign-Off for ${name} · Harry Wardrobes`;
      }
    } catch (_) {
      // Fall back to generic strings if lookup fails
    }
  }
  res.render('design-visit-signoff', {
    title: pageTitle,
    description: 'Review and sign off on your design visit details with Harry Wardrobes.',
    ogTitle,
    ogDescription,
    ogUrl: `${baseUrl}/design-visit/sign-off`,
    ogImage: `${baseUrl}/harry-wardrobes-logo.png`,
  });
});

// Public survey-visit sign-off page (no auth required — token-gated)
app.get('/survey-visit/sign-off', async (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  let ogTitle = 'Survey Visit Sign-Off · Harry Wardrobes';
  let ogDescription = 'Review and sign off on your survey visit details with Harry Wardrobes.';
  let pageTitle = 'Survey Visit Sign-Off · Harry Wardrobes';
  const rawToken = String(req.query.token || '').trim();
  if (rawToken && rawToken.length <= 200) {
    try {
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const { rows } = await pool.query(
        `SELECT contact_name FROM survey_visits WHERE signoff_token_hash = $1 LIMIT 1`,
        [tokenHash]
      );
      if (rows.length && rows[0].contact_name) {
        const name = rows[0].contact_name;
        ogTitle = `Survey Visit Sign-Off for ${name} · Harry Wardrobes`;
        ogDescription = `${name} has been sent a survey visit sign-off request. Review and sign off on the details with Harry Wardrobes.`;
        pageTitle = `Survey Visit Sign-Off for ${name} · Harry Wardrobes`;
      }
    } catch (_) {
      // Fall back to generic strings if lookup fails
    }
  }
  res.render('survey-visit-signoff', {
    title: pageTitle,
    description: 'Review and sign off on your survey visit details with Harry Wardrobes.',
    ogTitle,
    ogDescription,
    ogUrl: `${baseUrl}/survey-visit/sign-off`,
    ogImage: `${baseUrl}/harry-wardrobes-logo.png`,
  });
});

// Public customer-info form page — generic (no token) version
app.get('/customer-info', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.render('customer-info', {
    title: 'Tell us about your home · Harry Wardrobes',
    description: 'Share details about your home so we can tailor your wardrobe design to fit perfectly.',
    ogTitle: 'Tell us about your home · Harry Wardrobes',
    ogDescription: 'Share details about your home so we can tailor your wardrobe design to fit perfectly.',
    ogUrl: `${baseUrl}/customer-info`,
    ogImage: `${baseUrl}/harry-wardrobes-logo.png`,
  });
});

// Public customer-info form page (no auth required — token-gated)
app.get('/customer-info/:token', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.render('customer-info', {
    title: 'Tell us about your home · Harry Wardrobes',
    description: 'Share details about your home so we can tailor your wardrobe design to fit perfectly.',
    ogTitle: 'Tell us about your home · Harry Wardrobes',
    ogDescription: 'Share details about your home so we can tailor your wardrobe design to fit perfectly.',
    ogUrl: `${baseUrl}/customer-info/${req.params.token}`,
    ogImage: `${baseUrl}/harry-wardrobes-logo.png`,
  });
});

// Public auth pages — email + password handled in-app.
app.get('/login', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.render('login', {
    title: 'Sign in · Harry Wardrobes',
    description: 'Sign in to your Harry Wardrobes project dashboard.',
    ogTitle: 'Harry Wardrobes',
    ogDescription: 'Your Harry Wardrobes project dashboard — track jobs, customers, and design visits in one place.',
    ogUrl: `${baseUrl}/login`,
    ogImage: `${baseUrl}/og-image.png`,
  });
});
app.get('/set-password', (_req, res) => res.render('set-password', { title: 'Set password · Harry Wardrobes' }));
app.get('/onboarding', (_req, res) => res.render('onboarding', { title: 'Complete your profile · Harry Wardrobes' }));

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

// Service worker: served from the site root so it can control the whole origin
// (scope "/"). Sent with no-cache + Service-Worker-Allowed so browsers always
// re-validate it and pick up new builds promptly. Must precede express.static
// so these headers win over the default static handling.
app.get('/sw.js', (_req, res) => {
  const swPath = path.join(__dirname, 'public', 'sw.js');
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Service-Worker-Allowed', '/');
  res.type('application/javascript');
  res.sendFile(swPath, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// Self-hosted fonts change very rarely and are the largest static assets on the
// site. They are not content-hashed, so we use a month-long cache with normal
// revalidation rather than `immutable` — long enough to eliminate repeat-visit
// refetches, short enough that a future font swap propagates without a bust.
app.use(
  '/fonts',
  express.static(path.join(__dirname, 'public', 'fonts'), {
    maxAge: '30d',
  })
);

app.use(express.static(path.join(__dirname, 'public')));
installSession(app);

// ── HubSpot ───────────────────────────────────────────────────────────────────
const HS = process.env.HUBSPOT_API_URL || 'https://api.hubapi.com';
const getHubSpotHeaders = () => ({
  Authorization: `Bearer ${getCredential('access_token')}`,
  'Content-Type': 'application/json'
});

// Shared HubSpot search retry helper. Retries on 429 (honouring Retry-After
// when present) and transient 5xx / network errors using bounded exponential
// backoff so a brief HubSpot hiccup doesn't surface as an error to the UI.
// Used by the shared contacts crawl (fetchAllContactsShared) and /api/open-leads
// — the search-API callers that have been hitting per-second rate limits.
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
        { headers: getHubSpotHeaders(), timeout: 15000 }
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
        logger.warn('[hubspot-retry] attempt=%d status=%s backoff=%dms', attempt + 1, err.response?.status || 'network', backoff);
      }
      await sleep(backoff);
    }
  }
  logger.error('[hubspot-retry] all %d attempts exhausted endpoint=POST /crm/v3/objects/contacts/search finalStatus=%s', maxAttempts, lastErr?.response?.status || 'network');
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

  const cfg = { headers: getHubSpotHeaders(), timeout };
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
        logger.warn('[hubspot-retry] attempt=%d status=%s backoff=%dms endpoint=%s %s', attempt + 1, err.response?.status || 'network', backoff, method.toUpperCase(), url);
      }
      await sleep(backoff);
    }
  }
  const shortUrl = url.startsWith(HS) ? url.slice(HS.length) : url;
  logger.error('[hubspot-retry] all %d attempts exhausted endpoint=%s %s finalStatus=%s', maxAttempts, method.toUpperCase(), shortUrl, lastErr?.response?.status || 'network');
  throw lastErr;
}

// Guard: return a clear error if no token is set
function requireHubspotToken(req, res, next) {
  if (!getCredential('access_token')) {
    return res.status(503).json({
      error: 'HUBSPOT_ACCESS_TOKEN is not set. Add it to your .env file and restart the server.'
    });
  }
  next();
}
// QuickBooks routes (auth enforced inside the router)
app.use(quickbooksRoutes);
// Google Maps / Places settings + public config (auth enforced inside the
// router; the public /api/google-maps/config endpoint is intentionally open).
app.use(googleMapsRouter);
// Enforce onboarding completion for scoped routers that are mounted before the
// global /api auth gate.  requireOnboardingComplete already calls next() when
// req.user is absent, so public/token-gated routes inside these routers are
// unaffected.
app.use('/api/design-visits', requireOnboardingComplete);
app.use('/api/survey-visits', requireOnboardingComplete);
app.use('/api/customer-info', requireOnboardingComplete);
app.use('/api/photo-reviews', requireOnboardingComplete);
// Additional prefixes owned by the same early-mounted routers that fall outside
// the scoped prefixes above.  Without these guards a pre-onboarding session
// could reach /api/card-actions/*, /api/catalog/*, /api/design-visit-terms,
// /api/customer-info-photos/*, and /api/visit-questions via the routers before
// the global /api onboarding middleware runs.
app.use('/api/card-actions', requireOnboardingComplete);
app.use('/api/catalog', requireOnboardingComplete);
app.use('/api/design-visit-terms', requireOnboardingComplete);
app.use('/api/customer-info-photos', requireOnboardingComplete);
app.use('/api/visit-questions', requireOnboardingComplete);

app.use(designVisitsRouter);
app.use(surveyVisitsRouter);
app.use(customerInfoRouter);
app.use(photoReviewsRouter);

// Auth gate for all /api/* routes (whitelist endpoints reachable while
// signed-out: login, account requests, the public set-password flow).
const AUTH_WHITELIST = new Set([
  '/login', '/session', '/auth/user', '/request-access', '/check-email',
  '/set-password', '/set-password/validate',
  '/forgot-password', '/turnstile-config', '/identity-config', '/test-login',
  // Public Google Maps client config (browser key + runtime flags)
  '/google-maps/config',
  // Public Google Maps client usage beacon (in-memory diagnostics counters)
  '/google-maps/usage',
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
  // Public survey-visit sign-off routes (/api/survey-visits/sign-off/:token)
  if (/^\/survey-visits\/sign-off\/[^/]+$/.test(req.path)) return next();
  // Public customer-info routes (/api/customer-info/draft, /:token, /photos, /resend-expired)
  if (/^\/customer-info\/draft$/.test(req.path)) return next();
  if (/^\/customer-info\/[^/]+(\/photos|\/resend-expired)?$/.test(req.path)) return next();
  return isAuthenticated(req, res, next);
});
app.use('/api', (req, res, next) => {
  if (!req.user || ONBOARDING_ALLOWED.has(req.path)) return next();
  return requireOnboardingComplete(req, res, next);
});

app.use('/api/pipeline', requireHubspotToken);
app.use('/api/account', requireHubspotToken);
app.use('/api/open-leads', requireHubspotToken);
app.use('/api/project-contacts', requireHubspotToken);
app.use('/api/contacts-all', requireHubspotToken);
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
    { name: 'measure_once_rooms',    label: 'Harry Wardrobes Rooms',    fieldType: 'textarea', type: 'string', description: 'JSON workflow rooms data (Harry Wardrobes CRM)' },
    { name: 'measure_once_notes',    label: 'Harry Wardrobes Notes',    fieldType: 'textarea', type: 'string', description: 'Customer notes (Harry Wardrobes CRM)' },
    { name: 'measure_once_stage',    label: 'Harry Wardrobes Stage',    fieldType: 'text',     type: 'string', description: 'Current workflow stage (Harry Wardrobes CRM)' },
    { name: 'measure_once_substage', label: 'Harry Wardrobes Substage', fieldType: 'text',     type: 'string', description: 'Current workflow substage/task (Harry Wardrobes CRM)' },
    { name: 'customer_number',       label: 'Customer Number',       fieldType: 'text',     type: 'string', description: 'Unique customer number (e.g. LL01234) — Harry Wardrobes CRM' },
  ];
  for (const prop of props) {
    try {
      await axios.post(
        `${HS}/crm/v3/properties/contacts`,
        { ...prop, groupName: 'contactinformation' },
        { headers: getHubSpotHeaders() }
      );
      logger.info(`  Created HubSpot property: ${prop.name}`);
    } catch (e) {
      if (e.response?.status !== 409) {
        logger.warn(`  Could not create property ${prop.name}: ${e.response?.data?.message || e.message}`);
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
      { headers: getHubSpotHeaders(), params: { properties: 'measure_once_rooms,measure_once_notes' } }
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
            { headers: getHubSpotHeaders(), params: { properties: 'measure_once_rooms' } }
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
              { headers: getHubSpotHeaders(), params: { properties: 'measure_once_rooms' } }
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

          // Check existing rooms for pipeline mutations.
          let pipelineChanged = false;
          const pairLen = Math.min(rooms.length, existingRooms.length);
          for (let i = 0; i < pairLen; i++) {
            const a = rooms[i] || {};
            const b = existingRooms[i] || {};
            if ((a.stageKey || '') !== (b.stageKey || '')) { pipelineChanged = true; break; }
            if ((a.statusId || '') !== (b.statusId || '')) { pipelineChanged = true; break; }
            if (!sameCompleted(a.completedStatuses, b.completedStatuses)) { pipelineChanged = true; break; }
          }
          // Also check newly-appended rooms (indices beyond existingRooms.length).
          // Members may only create rooms at the canonical initial pipeline state
          // (stageKey 'sales', no statusId, no completedStatuses).
          for (let i = existingRooms.length; i < rooms.length; i++) {
            const a = rooms[i] || {};
            const hasNonInitialStage = (a.stageKey || 'sales') !== 'sales';
            const hasStatusId        = !!(a.statusId || '');
            const hasCompleted       = Object.keys(a.completedStatuses || {}).length > 0;
            if (hasNonInitialStage || hasStatusId || hasCompleted) { pipelineChanged = true; break; }
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
      logger.error({ err: hsErr.message }, '[localdata] HubSpot PATCH failed after retries (non-fatal):');
    }
    clearContactCache();
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

// Short-lived in-process cache for DB config rows fetched by /api/contacts-all.
// These values change only when an admin edits lead_status_config or app_settings,
// so a 60-second TTL eliminates serial DB round-trips on every API request while
// keeping the data fresh enough for practical use.
const CONTACTS_CONFIG_CACHE_TTL_MS = 60_000; // 60 s
let _devModeCache          = null; // { value: boolean, fetchedAt: number } | null
let _excludedKeysCache     = null; // { keys: Set<string>, fetchedAt: number } | null
let _stageConfigCache      = null; // { map: Map<string,string>, fetchedAt: number } | null
let _priorityActiveDaysCache = null; // { value: number, fetchedAt: number } | null

function _invalidateContactsConfigCache() {
  _excludedKeysCache       = null;
  _stageConfigCache        = null;
  _devModeCache            = null;
  _priorityActiveDaysCache = null;
}

const ALL_CONTACTS_PROPERTIES = [
  'firstname', 'lastname', 'email', 'phone', 'mobilephone', 'hs_lead_status',
  'address', 'city', 'zip', 'customer_number', 'createdate', 'closedate', 'lastmodifieddate',
  'measure_once_rooms', 'hw_test_user', 'notes_last_contacted',
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
      logger.warn('[contacts-all] HubSpot fetch failed (status=%s); serving stale contacts age=%dms', status || 'network', Date.now() - _allContactsLastGood.fetchedAt);
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
    logger.warn('[contacts-all] HubSpot fetch failed (status=%s) and no stale snapshot available', status || 'network');
  }
  return { contacts: [], stale: true, unavailable: true, _err: outcome.err };
}

/**
 * Invalidate the in-memory HubSpot contact list cache.
 *
 * Sets `_allContactsCache` to `null` so the next request that needs the
 * contact list triggers a fresh HubSpot scan. `_allContactsLastGood` is
 * intentionally left intact so that a failed refetch can still serve the
 * prior snapshot instead of returning a 502.
 *
 * Call this from every mutation route that creates, updates, or deletes
 * contact data so the UI reflects the change on the next poll.
 *
 * @returns {void}
 */
function clearContactCache() {
  _allContactsCache = null;
}

/**
 * Patch a single contact's properties in the in-process contacts cache
 * without invalidating the whole cache.  Called after a successful PATCH +
 * verify so /api/contacts-all reflects the new values immediately without
 * waiting for HubSpot's search index to catch up (which can lag by several
 * seconds after a direct object update).
 *
 * Updates both `_allContactsCache` and `_allContactsLastGood` so stale-
 * fallback responses also carry the correct data.
 */
function patchContactInCache(contactId, properties) {
  const idStr = String(contactId);
  const seen = new Set();
  for (const cache of [_allContactsCache, _allContactsLastGood]) {
    if (!cache?.contacts) continue;
    if (seen.has(cache)) continue; // skip if both refs point to the same object
    seen.add(cache);
    const contact = cache.contacts.find(c => String(c.id) === idStr);
    if (contact) {
      contact.properties = Object.assign(contact.properties || {}, properties);
    }
  }
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
      { headers: getHubSpotHeaders(), params: { properties: 'measure_once_rooms' } }
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
      logger.error({ err: hsErr.message }, '[rooms-fitter] HubSpot PATCH failed after retries (non-fatal):');
    }

    // Bust shared cache so next /api/localdata/all and /api/contacts-all reflect the new assignment
    clearContactCache();

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

// ── Google OAuth — DB helpers ─────────────────────────────────────────────────
// Mirror of the persistTokens / getStoredTokens pattern in quickbooks.js.
// access_token and refresh_token are stored AES-256-GCM encrypted (via
// google-token-crypto.cjs) using the GOOGLE_TOKEN_ENCRYPTION_KEY secret.

async function saveGoogleTokens(userSub, tokens) {
  const expiresAt = tokens.expiry_date ? new Date(tokens.expiry_date) : null;
  const encAccessToken  = tokens.access_token  ? encryptToken(tokens.access_token)  : null;
  const encRefreshToken = tokens.refresh_token ? encryptToken(tokens.refresh_token) : '';
  await pool.query(
    `INSERT INTO google_oauth_tokens
       (user_sub, access_token, refresh_token, scope, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (user_sub) DO UPDATE SET
       access_token  = EXCLUDED.access_token,
       refresh_token = COALESCE(
                         NULLIF(EXCLUDED.refresh_token, ''),
                         google_oauth_tokens.refresh_token
                       ),
       scope         = EXCLUDED.scope,
       expires_at    = EXCLUDED.expires_at,
       updated_at    = now()`,
    [
      userSub,
      encAccessToken,
      encRefreshToken,
      tokens.scope || null,
      expiresAt,
    ],
  );
}

async function loadGoogleTokens(userSub) {
  const r = await pool.query(
    'SELECT access_token, refresh_token, scope, expires_at FROM google_oauth_tokens WHERE user_sub = $1',
    [userSub],
  );
  if (!r.rows[0]) return null;
  const row = r.rows[0];

  // Decrypt each token field.  tryDecrypt returns { ok, plaintext } — if
  // decryption fails the value is stale plaintext (e.g. migration hasn't run
  // yet or key was rotated).  Treat stale rows as disconnected: return null
  // so the caller triggers a re-auth rather than crashing.
  let accessToken  = null;
  let refreshToken = null;

  if (row.access_token) {
    const { ok, plaintext } = tryDecryptToken(row.access_token);
    if (!ok) {
      logger.warn({ component: 'google-tokens', userSub }, 'loadGoogleTokens: access_token could not be decrypted — row treated as missing (reconnect required)');
      return null;
    }
    accessToken = plaintext;
  }

  if (row.refresh_token) {
    const { ok, plaintext } = tryDecryptToken(row.refresh_token);
    if (!ok) {
      logger.warn({ component: 'google-tokens', userSub }, 'loadGoogleTokens: refresh_token could not be decrypted — row treated as missing (reconnect required)');
      return null;
    }
    refreshToken = plaintext;
  }

  return {
    access_token:  accessToken,
    refresh_token: refreshToken,
    scope:         row.scope,
    expiry_date:   row.expires_at ? new Date(row.expires_at).getTime() : null,
  };
}

/**
 * Check whether a user's Google token row exists and whether it can be decrypted
 * with the current GOOGLE_TOKEN_ENCRYPTION_KEY.
 *
 * Returns one of:
 *   'missing'    — no row in google_oauth_tokens for this user
 *   'unreadable' — row exists but the token(s) cannot be decrypted (key rotation
 *                  or other corruption); user must reconnect
 *   'ok'         — row exists and tokens decrypt successfully
 */
async function checkGoogleTokenReadability(userSub) {
  const r = await pool.query(
    'SELECT access_token, refresh_token FROM google_oauth_tokens WHERE user_sub = $1',
    [userSub],
  );
  if (!r.rows[0]) return 'missing';
  const row = r.rows[0];

  if (row.access_token) {
    const { ok } = tryDecryptToken(row.access_token);
    if (!ok) return 'unreadable';
  }
  if (row.refresh_token) {
    const { ok } = tryDecryptToken(row.refresh_token);
    if (!ok) return 'unreadable';
  }
  return 'ok';
}

async function deleteGoogleTokens(userSub) {
  await pool.query('DELETE FROM google_oauth_tokens WHERE user_sub = $1', [userSub]);
}

// ── Google OAuth ──────────────────────────────────────────────────────────────
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI ||
  (process.env.APP_URL
    ? `${process.env.APP_URL.replace(/\/+$/, '')}/auth/google/callback`
    : `http://localhost:${PORT}/auth/google/callback`);


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

// Short-lived cookie helpers for Google OAuth CSRF state.
// express-session was removed in the Identity Platform migration; these
// cookies replace the session as the per-flow state carrier.
function getOAuthCookie(req, name) {
  const header = req.headers.cookie || '';
  const match = header.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[1]) : null;
}
function setOAuthCookies(res, state, isPopup) {
  const opts = { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 5 * 60 * 1000 };
  if (process.env.NODE_ENV === 'production') opts.secure = true;
  res.cookie('_goauth_state', state, opts);
  res.cookie('_goauth_popup', isPopup ? '1' : '0', opts);
}
function clearOAuthCookies(res) {
  const opts = { httpOnly: true, sameSite: 'lax', path: '/', expires: new Date(0) };
  if (process.env.NODE_ENV === 'production') opts.secure = true;
  res.cookie('_goauth_state', '', opts);
  res.cookie('_goauth_popup', '', opts);
}

// ── Auth Routes ───────────────────────────────────────────────────────────────

app.get('/auth/google', isAuthenticated, (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  // When the connect button opens a new tab (popup=1), record that so the
  // callback can post a message to the opener instead of doing a full redirect.
  setOAuthCookies(res, state, req.query.popup === '1');
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: GOOGLE_SCOPES,
    prompt: 'consent',
    state,
  });
  res.redirect(url);
});

/**
 * Returns a minimal HTML page for the Google popup/new-tab OAuth flow.
 * On success it posts { type: 'google-connected' } to the opener then closes.
 * On error it posts { type: 'google-error', reason } to the opener then closes.
 */
function googlePopupPage(outcome, reason) {
  const message = outcome === 'connected'
    ? JSON.stringify({ type: 'google-connected' })
    : JSON.stringify({ type: 'google-error', reason: reason || 'unknown' });
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Google Calendar${outcome === 'connected' ? ' Connected' : ' Error'}</title></head>
<body>
<script>
  (function () {
    try {
      if (window.opener) {
        window.opener.postMessage(${message}, window.location.origin);
      }
    } catch (e) {}
    window.close();
  })();
</script>
<p style="font-family:sans-serif;text-align:center;margin-top:2rem;color:#555">
  ${outcome === 'connected' ? 'Google Calendar connected — you can close this tab.' : 'Something went wrong — you can close this tab.'}
</p>
</body>
</html>`;
}

app.get('/auth/google/callback', isAuthenticated, async (req, res) => {
  const isPopup = getOAuthCookie(req, '_goauth_popup') === '1';
  const expectedState = getOAuthCookie(req, '_goauth_state');
  clearOAuthCookies(res);
  if (!expectedState || req.query.state !== expectedState) {
    if (isPopup) return res.send(googlePopupPage('error', 'invalid_state'));
    return res.redirect('/?error=google_auth_failed');
  }
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    await saveGoogleTokens(String(req.user.claims.sub), tokens);
    if (isPopup) return res.send(googlePopupPage('connected'));
    res.redirect('/?connected=true');
  } catch (e) {
    if (isPopup) return res.send(googlePopupPage('error', e.message));
    res.redirect('/?error=google_auth_failed');
  }
});

app.post('/auth/logout-google', isAuthenticated, async (req, res) => {
  try { await deleteGoogleTokens(String(req.user.claims.sub)); } catch {}
  res.json({ success: true });
});

// ── Google: Connection status (live token check) ───────────────────────────────
app.get('/api/google/status', isAuthenticated, async (req, res) => {
  const userSub = String(req.user.claims.sub);
  const googleTokens = await getVerifiedGoogleTokens(req);
  if (!googleTokens) {
    // Distinguish between "never connected" and "token exists but can't be
    // decrypted" (e.g. after a key rotation).  The latter gets a specific code
    // so the client can show a targeted "please reconnect" prompt.
    const readability = await checkGoogleTokenReadability(userSub);
    if (readability === 'unreadable') {
      return res.json({ connected: false, code: 'TOKEN_UNREADABLE' });
    }
    return res.json({ connected: false, code: 'NO_TOKEN' });
  }
  try {
    const auth = getGoogleClient(googleTokens);
    const { token } = await auth.getAccessToken();
    if (!token) return res.json({ connected: false, code: 'NO_TOKEN' });
    await saveGoogleTokens(userSub, auth.credentials);
    res.json({ connected: true });
  } catch (e) {
    const msg = (e.message || '').toLowerCase();
    if (msg.includes('invalid_grant') || msg.includes('token has been expired') || msg.includes('token has been revoked')) {
      try { await deleteGoogleTokens(userSub); } catch {}
      return res.json({ connected: false, code: 'TOKEN_EXPIRED' });
    }
    if (e.response?.status === 401 || msg.includes('invalid_client')) {
      return res.json({ connected: false, code: 'GOOGLE_AUTH' });
    }
    res.json({ connected: false, code: 'GOOGLE_ERROR' });
  }
});


app.get('/auth/status', async (req, res) => {
  const googleTokens = await getVerifiedGoogleTokens(req);
  res.json({
    google:  !!googleTokens,
    hubspot: !!getCredential('access_token')
  });
});

// ── Database: Connection status (lightweight SELECT 1 ping) ───────────────────
app.get('/api/database/status', isAuthenticated, async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ connected: true });
  } catch (e) {
    res.json({ connected: false, error: e.message });
  }
});

// ── HubSpot: Connection status (lightweight ping, no requireHubspotToken guard) ─
app.get('/api/hubspot/status', async (req, res) => {
  if (!getCredential('access_token')) {
    return res.json({ connected: false, code: 'NO_TOKEN' });
  }
  try {
    await axios.get(`${HS}/account-info/v3/details`, { headers: getHubSpotHeaders(), timeout: 8000 });
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

// ── HubSpot: Webhook SSE stream ───────────────────────────────────────────────
// Authenticated endpoint — browser tabs connect here to receive push
// notifications when a HubSpot webhook fires and busts the lead-status cache.
// Each connected response is held open and written to by the webhook handler.
app.get('/api/hubspot/webhook-events', isAuthenticated, (req, res) => {
  // Clients that don't explicitly accept SSE (e.g. health-checks, privilege
  // matrix probes that send Accept: application/json) get a plain 200 so
  // the connection is closed immediately rather than held open forever.
  if (!String(req.headers['accept'] || '').includes('text/event-stream')) {
    return res.status(200).json({ ok: true, info: 'SSE endpoint — connect with EventSource' });
  }

  // ── Abuse controls ────────────────────────────────────────────────────────
  // Reject if we are at the global connection ceiling.
  if (_hsWebhookSseClients.size >= HS_SSE_GLOBAL_CAP) {
    return res.status(503).json({ error: 'SSE connection limit reached. Try again later.' });
  }

  // Reject if this user already holds too many connections.
  const userId = String(req.user?.claims?.sub || 'unknown');
  const userConns = _hsWebhookSseByUser.get(userId);
  if (userConns && userConns.size >= HS_SSE_PER_USER_CAP) {
    return res.status(429).json({ error: 'Too many concurrent SSE connections.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  // Send a connected confirmation so the client can tell the SSE stream is live.
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

  // Register connection in both the broadcast set and the per-user map.
  _hsWebhookSseClients.add(res);
  if (!_hsWebhookSseByUser.has(userId)) _hsWebhookSseByUser.set(userId, new Set());
  _hsWebhookSseByUser.get(userId).add(res);

  // Heartbeat: keeps the TCP connection alive and allows the server to detect
  // dead sockets early (write will throw on a closed pipe).
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { cleanup(); } // eslint-disable-line no-use-before-define
  }, HS_SSE_HEARTBEAT_MS);

  // Hard ceiling: forcibly close the connection after HS_SSE_MAX_DURATION so
  // long-running tabs are not counted forever against the global cap.
  const maxDuration = setTimeout(() => {
    try { res.write(`data: ${JSON.stringify({ type: 'reconnect' })}\n\n`); } catch { /* ignore */ }
    cleanup(); // eslint-disable-line no-use-before-define
    res.end();
  }, HS_SSE_MAX_DURATION);

  function cleanup() {
    clearInterval(heartbeat);
    clearTimeout(maxDuration);
    _hsWebhookSseClients.delete(res);
    const uc = _hsWebhookSseByUser.get(userId);
    if (uc) {
      uc.delete(res);
      if (uc.size === 0) _hsWebhookSseByUser.delete(userId);
    }
  }

  req.on('close', () => { cleanup(); });
});

// ── HubSpot: Webhook subscription management (admin only) ─────────────────────
// Helpers for the admin Settings UI — lets an admin register or unregister the
// HubSpot webhook subscriptions without leaving the app.
// Requires: HUBSPOT_APP_ID (private app numeric ID) + the existing bearer token.

function _getWebhookBaseUrl(req) {
  if (process.env.WEBHOOK_BASE_URL) return process.env.WEBHOOK_BASE_URL.replace(/\/$/, '');
  return `${req.headers['x-forwarded-proto'] || req.protocol || 'https'}://${req.get('host')}`;
}

const HS_WATCHED_PROPS = ['hs_lead_status'];

// GET /api/admin/hubspot-webhook — returns webhook config status
app.get('/api/admin/hubspot-webhook', isAuthenticated, requireAdmin, async (req, res) => {
  const hasSecret      = !!getCredential('client_secret');
  const appId          = getCredential('app_id');
  const webhookBaseUrl = _getWebhookBaseUrl(req);
  const webhookUrl     = `${webhookBaseUrl}/api/hubspot/webhook`;

  if (!appId) {
    return res.json({ hasSecret, appIdConfigured: false, webhookUrl, subscriptions: [], configuredWebhookUrl: null });
  }

  try {
    const [subsResp, settingsResp] = await Promise.allSettled([
      axios.get(`${HS}/webhooks/v3/${encodeURIComponent(appId)}/subscriptions`, { headers: getHubSpotHeaders(), timeout: 10000 }),
      axios.get(`${HS}/webhooks/v3/${encodeURIComponent(appId)}/settings`,      { headers: getHubSpotHeaders(), timeout: 10000 }),
    ]);
    const subs     = subsResp.status === 'fulfilled'     ? (subsResp.value.data?.results || [])           : [];
    const settings = settingsResp.status === 'fulfilled' ? settingsResp.value.data                         : null;
    const relevant = subs.filter(s =>
      s.eventType === 'contact.propertyChange' && HS_WATCHED_PROPS.includes(s.propertyName)
    );
    return res.json({
      hasSecret,
      appIdConfigured: true,
      webhookUrl,
      configuredWebhookUrl: settings?.webhookUrl || null,
      subscriptions: relevant,
    });
  } catch (e) {
    if (e.response?.status === 404) {
      return res.json({ hasSecret, appIdConfigured: true, webhookUrl, subscriptions: [] });
    }
    return res.status(502).json({ error: e.response?.data?.message || e.message });
  }
});

// POST /api/admin/hubspot-webhook — register subscriptions + set webhook URL
app.post('/api/admin/hubspot-webhook', isAuthenticated, requireAdmin, async (req, res) => {
  const appId = getCredential('app_id');
  if (!appId) return res.status(400).json({ error: 'HUBSPOT_APP_ID is not configured.' });
  if (!getCredential('client_secret')) {
    return res.status(400).json({ error: 'HUBSPOT_CLIENT_SECRET is not configured — webhook signature verification would be disabled. Set the secret before registering.' });
  }

  const webhookUrl = _getWebhookBaseUrl(req) + '/api/hubspot/webhook';

  try {
    // 1. Configure the webhook URL at the app level.
    await axios.put(
      `${HS}/webhooks/v3/${encodeURIComponent(appId)}/settings`,
      { webhookUrl, maxConcurrentRequests: 10 },
      { headers: getHubSpotHeaders(), timeout: 10000 }
    );

    // 2. Fetch existing subscriptions to avoid duplicates.
    let existing = [];
    try {
      const r = await axios.get(
        `${HS}/webhooks/v3/${encodeURIComponent(appId)}/subscriptions`,
        { headers: getHubSpotHeaders(), timeout: 10000 }
      );
      existing = r.data?.results || [];
    } catch { /* treat as no existing subscriptions */ }

    const existingProps = new Set(
      existing.filter(s => s.eventType === 'contact.propertyChange').map(s => s.propertyName)
    );

    // 3. Create subscriptions for any watched property not yet registered.
    const created = [];
    for (const prop of HS_WATCHED_PROPS) {
      if (existingProps.has(prop)) continue;
      const r = await axios.post(
        `${HS}/webhooks/v3/${encodeURIComponent(appId)}/subscriptions`,
        { eventType: 'contact.propertyChange', propertyName: prop, active: true },
        { headers: getHubSpotHeaders(), timeout: 10000 }
      );
      created.push(r.data);
    }

    const allSubs = [...existing.filter(s => HS_WATCHED_PROPS.includes(s.propertyName)), ...created];
    return res.json({ ok: true, webhookUrl, subscriptions: allSubs, created: created.length });
  } catch (e) {
    logger.error({ err: e.response?.data || e.message }, '[hs-webhook] POST /api/admin/hubspot-webhook error:');
    return res.status(502).json({ error: e.response?.data?.message || e.message });
  }
});

// DELETE /api/admin/hubspot-webhook — unregister subscriptions for watched properties
app.delete('/api/admin/hubspot-webhook', isAuthenticated, requireAdmin, async (req, res) => {
  const appId = getCredential('app_id');
  if (!appId) return res.status(400).json({ error: 'HUBSPOT_APP_ID is not configured.' });

  try {
    const r = await axios.get(
      `${HS}/webhooks/v3/${encodeURIComponent(appId)}/subscriptions`,
      { headers: getHubSpotHeaders(), timeout: 10000 }
    );
    const toDelete = (r.data?.results || []).filter(
      s => s.eventType === 'contact.propertyChange' && HS_WATCHED_PROPS.includes(s.propertyName)
    );

    await Promise.all(toDelete.map(s =>
      axios.delete(
        `${HS}/webhooks/v3/${encodeURIComponent(appId)}/subscriptions/${encodeURIComponent(s.id)}`,
        { headers: getHubSpotHeaders(), timeout: 10000 }
      ).catch(err => logger.warn({ err: err.response?.data || err.message }, '[hs-webhook] delete subscription error:'))
    ));

    return res.json({ ok: true, deleted: toDelete.length });
  } catch (e) {
    logger.error({ err: e.response?.data || e.message }, '[hs-webhook] DELETE /api/admin/hubspot-webhook error:');
    return res.status(502).json({ error: e.response?.data?.message || e.message });
  }
});

// ── HubSpot credential management ────────────────────────────────────────────
// GET /api/admin/hubspot-credentials — returns which credential keys are
// configured (values are never returned; only presence is indicated).
app.get('/api/admin/hubspot-credentials', isAuthenticated, requireAdmin, (req, res) => {
  res.json({
    configured: {
      access_token: !!process.env.HUBSPOT_ACCESS_TOKEN,
    },
  });
});

// PATCH /api/admin/hubspot-credentials — update a credential key/value pair.
app.patch('/api/admin/hubspot-credentials', isAuthenticated, requireAdmin, (req, res) => {
  const { key } = req.body || {};
  const ALLOWED_KEYS = ['access_token'];
  if (!key || !ALLOWED_KEYS.includes(key)) {
    return res.status(400).json({ error: `key must be one of: ${ALLOWED_KEYS.join(', ')}` });
  }
  return res.status(501).json({ error: 'Credential updates via UI are not yet implemented. Set HUBSPOT_ACCESS_TOKEN in the environment.' });
});

// DELETE /api/admin/hubspot-credentials/:key — clear a stored credential.
app.delete('/api/admin/hubspot-credentials/:key', isAuthenticated, requireAdmin, (req, res) => {
  const ALLOWED_KEYS = ['access_token'];
  if (!ALLOWED_KEYS.includes(req.params.key)) {
    return res.status(400).json({ error: 'Unknown credential key.' });
  }
  return res.status(501).json({ error: 'Credential deletion via UI is not yet implemented.' });
});

// ── HubSpot: Account ──────────────────────────────────────────────────────────
app.get('/api/account', async (req, res) => {
  try {
    const r = await axios.get(`${HS}/account-info/v3/details`, { headers: getHubSpotHeaders() });
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
    const r = await axios.get(`${HS}/crm/v3/pipelines/deals`, { headers: getHubSpotHeaders() });
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

app.get('/api/deals', isAuthenticated, requireManagerOrAdmin, requireHubspotToken, async (req, res) => {
  try {
    const r = await axios.get(`${HS}/crm/v3/objects/deals`, {
      headers: getHubSpotHeaders(),
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

app.get('/api/deals/:id', isAuthenticated, requireManagerOrAdmin, requireHubspotToken, async (req, res) => {
  try {
    const safeDealId = normalizeHubspotObjectId(req.params.id);
    if (!safeDealId) {
      return res.status(400).json({ error: 'Invalid deal id' });
    }
    const r = await axios.get(`${HS}/crm/v3/objects/deals/${safeDealId}`, {
      headers: getHubSpotHeaders(),
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
    // Financial-field gate: managers/admins only for amount, dealstage, pipeline.
    // Members may still edit dealname, closedate, description.
    const DEAL_FINANCIAL_FIELDS = ['amount', 'dealstage', 'pipeline'];
    const touchesFinancialField = DEAL_FINANCIAL_FIELDS.some(
      f => Object.prototype.hasOwnProperty.call(properties, f)
    );
    if (touchesFinancialField) {
      try {
        const userId = req.user?.claims?.sub;
        const ur = await pool.query(`SELECT privilege_level FROM users WHERE id = $1`, [userId]);
        const level = ur.rows[0]?.privilege_level || 'member';
        if (level !== 'manager' && level !== 'admin') {
          return res.status(403).json({
            message: 'Manager or admin privilege required to change deal financial fields.',
            code: 'PIPELINE_EDIT_FORBIDDEN',
          });
        }
      } catch {
        return res.status(500).json({ error: 'Authorization check failed' });
      }
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
    logger.error({ err: e.response?.data || e.message }, 'PATCH /api/deals/:id HubSpot error:');
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

    const _t0 = process.env.DEBUG_CONTACTS ? Date.now() : 0;
    const _timings = process.env.DEBUG_CONTACTS ? [] : null;

    let contacts = rawContacts;

    // Dev-mode filter — when dev_mode_enabled is true, only show hw_test_user contacts.
    // Result is cached for CONTACTS_CONFIG_CACHE_TTL_MS to avoid a DB round-trip
    // on every request.
    try {
      let devModeEnabled = false;
      if (_devModeCache && Date.now() - _devModeCache.fetchedAt < CONTACTS_CONFIG_CACHE_TTL_MS) {
        devModeEnabled = _devModeCache.value;
        if (_timings) _timings.push('dev_mode=hit');
      } else {
        const { rows: dmRows } = await pool.query(
          `SELECT value FROM app_settings WHERE key = 'dev_mode_enabled'`
        );
        devModeEnabled = dmRows.length > 0 && dmRows[0].value === 'true';
        _devModeCache = { value: devModeEnabled, fetchedAt: Date.now() };
        if (_timings) _timings.push('dev_mode=miss');
      }
      if (devModeEnabled) {
        contacts = contacts.filter(c => c.properties?.hw_test_user === 'true');
      } else {
        contacts = contacts.filter(c => c.properties?.hw_test_user !== 'true');
      }
    } catch (dbErr) {
      logger.warn({ err: dbErr.message }, '[contacts-all] could not read dev_mode_enabled:');
    }

    // Server-side excluded_from_sales filter — applied whenever `includeExcluded`
    // is absent or falsy (covers both the Sales board and the Customers list by
    // default).  Skipped when the caller is already filtering by a specific
    // excluded status so that explicitly-requested excluded-status views still
    // return results.  Result is cached to avoid a DB round-trip on every request.
    const includeExcluded = req.query.includeExcluded === '1';
    if (!includeExcluded) {
      try {
        let excludedKeys;
        if (_excludedKeysCache && Date.now() - _excludedKeysCache.fetchedAt < CONTACTS_CONFIG_CACHE_TTL_MS) {
          excludedKeys = _excludedKeysCache.keys;
          if (_timings) _timings.push('excluded_keys=hit');
        } else {
          const { rows: excludedRows } = await pool.query(
            'SELECT key FROM lead_status_config WHERE excluded_from_sales = TRUE'
          );
          excludedKeys = new Set(excludedRows.map(r => r.key));
          _excludedKeysCache = { keys: excludedKeys, fetchedAt: Date.now() };
          if (_timings) _timings.push('excluded_keys=miss');
        }
        const callerFilteringByExcluded = leadStatus && excludedKeys.has(leadStatus.toUpperCase());
        if (excludedKeys.size > 0 && !callerFilteringByExcluded) {
          contacts = contacts.filter(c => {
            const ls = (c.properties?.hs_lead_status || '').toUpperCase();
            return !excludedKeys.has(ls);
          });
        }
      } catch (dbErr) {
        logger.warn({ err: dbErr.message }, '[contacts-all] could not load excluded lead statuses:');
      }
    }

    // Staleness filter — exclude contacts not modified within the cutoff window
    const staleAfterDaysRaw = req.query.staleAfterDays;
    if (staleAfterDaysRaw !== undefined) {
      const staleAfterDays = parseInt(staleAfterDaysRaw, 10);
      if (Number.isFinite(staleAfterDays) && staleAfterDays > 0) {
        const cutoff = Date.now() - staleAfterDays * 24 * 60 * 60 * 1000;
        contacts = contacts.filter(c => {
          const raw = c.properties?.lastmodifieddate;
          if (!raw) return true;
          const ms = new Date(raw).getTime();
          return !isNaN(ms) && ms >= cutoff;
        });
      }
    }

    // Priority-active filter — when sorting "Priority first" with no search
    // query, hide contacts that have not been modified in the last N days.
    // N defaults to 60 but is admin-configurable via app_settings (key:
    // priority_active_days).  Missing or unparseable dates pass through (same
    // "keep" behaviour as the staleAfterDays filter above).  A non-empty
    // search bypasses this filter so users can still surface older contacts
    // when they know who to look for.
    // Keep in sync with the offline mirror in usePaginatedContacts.ts.
    const priorityActiveDays = await _getPriorityActiveDays();
    const priorityFirst = req.query.priorityFirst === '1';
    // The Sales tab with "Show all" off also hides leads with no activity in the
    // priority-active window even when not sorting by priority — the client sends
    // hideStale=1 for that case. A search query bypasses it (same as priority).
    const hideStale = req.query.hideStale === '1';
    if ((priorityFirst || hideStale) && !q) {
      contacts = _filterContactsByPriorityActive(contacts, priorityActiveDays);
    }

    // Per-stage badge counts, computed from the same filtered set the list is
    // built from (after dev-mode / excluded / priority filters, before the
    // lead-status, stage, and search filters + pagination). Returned with the
    // list so the stage-tab badges stay in lock-step with the list total — a
    // separate /api/contacts-stage-counts call could drift or go stale.
    let _stageMapForCounts;
    try {
      if (_stageConfigCache && Date.now() - _stageConfigCache.fetchedAt < CONTACTS_CONFIG_CACHE_TTL_MS) {
        _stageMapForCounts = _stageConfigCache.map;
      } else {
        const { rows: stageRows } = await pool.query(
          'SELECT key, stage FROM lead_status_config WHERE stage IS NOT NULL'
        );
        _stageMapForCounts = new Map(stageRows.map(r => [r.key, r.stage.toLowerCase().replace(/_/g, '')]));
        _stageConfigCache = { map: _stageMapForCounts, fetchedAt: Date.now() };
      }
    } catch (dbErr) {
      logger.warn({ err: dbErr.message }, '[contacts-all] could not load stage config for badge counts:');
      _stageMapForCounts = new Map();
    }
    const stageCounts = { __all__: contacts.length };
    for (const c of contacts) {
      const ls = c.properties?.hs_lead_status || '';
      const stg = ls ? (_stageMapForCounts.get(ls) || '') : 'sales';
      if (stg) stageCounts[stg] = (stageCounts[stg] || 0) + 1;
    }

    if (leadStatus) {
      if (leadStatus === '__no_status__') {
        contacts = contacts.filter(c => !c.properties?.hs_lead_status);
      } else {
        contacts = contacts.filter(c => c.properties?.hs_lead_status === leadStatus);
      }
    }

    const stageParam = (req.query.stage || '').trim().toLowerCase().replace(/_/g, '');
    if (stageParam) {
      // Reuse the stage map already loaded for the badge counts above.
      contacts = contacts.filter(c => {
        const ls = c.properties?.hs_lead_status || '';
        if (!ls && stageParam === 'sales') return true; // No status → include in sales
        const contactStage = _stageMapForCounts.get(ls) || '';
        return contactStage === stageParam;
      });
    }

    if (_timings) {
      logger.info('[contacts-all] q=%s timings=%s elapsed=%dms', q || '(none)', _timings.join(',') || 'none', Date.now() - _t0);
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

    let effectiveComparator;
    if (priorityFirst && !leadStatus) {
      // Build a map of contactId → max attempted_at from contact_attempt_log
      // for all contacts currently in the filtered set.  Coalesce with each
      // contact's HubSpot notes_last_contacted property so whichever is later
      // wins, then sort ascending (never-contacted → most-recently-contacted).
      const contactIds = contacts.map(c => c.id);
      let lastAttemptMap = {};
      if (contactIds.length > 0) {
        try {
          const { rows: attemptRows } = await pool.query(
            `SELECT hubspot_contact_id, MAX(attempted_at) AS last_attempt
             FROM contact_attempt_log
             WHERE hubspot_contact_id = ANY($1::text[])
             GROUP BY hubspot_contact_id`,
            [contactIds],
          );
          for (const r of attemptRows) {
            lastAttemptMap[r.hubspot_contact_id] = r.last_attempt ? new Date(r.last_attempt).toISOString() : null;
          }
        } catch (dbErr) {
          logger.warn({ err: dbErr.message }, '[contacts-all] could not load contact_attempt_log for priority sort:');
        }
      }

      const getLastContacted = (c) => {
        const fromLog = lastAttemptMap[c.id] || null;
        const fromHs  = c.properties?.notes_last_contacted || null;
        if (!fromLog && !fromHs) return null;
        if (!fromLog) return fromHs;
        if (!fromHs)  return fromLog;
        return fromLog > fromHs ? fromLog : fromHs;
      };

      effectiveComparator = (a, b) => {
        // Rank 0: contacts with no lead status sort above everyone else.
        const aNull = !a.properties?.hs_lead_status;
        const bNull = !b.properties?.hs_lead_status;
        if (aNull !== bNull) return aNull ? -1 : 1;

        const aLast = getLastContacted(a);
        const bLast = getLastContacted(b);
        // Never-contacted (null) sorts first (highest priority).
        if (!aLast && bLast) return -1;
        if (aLast && !bLast) return  1;
        if (!aLast && !bLast) {
          // Both never contacted ("awaiting a call") — first-come-first-serve:
          // tie-break by createdate ascending so the longest-waiting lead is first.
          return (a.properties?.createdate || '').localeCompare(b.properties?.createdate || '');
        }
        // Ascending by last-contacted (longest since contact = first).
        const cmp = aLast.localeCompare(bLast);
        if (cmp !== 0) return cmp;
        // Tie-break first-come-first-serve: createdate ascending (longest wait first).
        return (a.properties?.createdate || '').localeCompare(b.properties?.createdate || '');
      };
    } else {
      effectiveComparator = comparator;
    }
    contacts = [...contacts].sort(effectiveComparator);

    const total      = contacts.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const offset     = (page - 1) * limit;
    const results    = contacts.slice(offset, offset + limit);

    res.json({ results, total, page, totalPages, priorityActiveDays, stageCounts });
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
// Counts are derived on demand from the shared contacts cache (see the
// /api/contacts-lead-status-counts handler), so there is no separate counts
// cache to maintain. Invalidating "counts" just means busting the short-lived
// contacts-config cache (excluded keys / stage map / dev-mode flag) so the next
// request picks up updated lead_status_config rows; the contacts list itself is
// busted via clearContactCache() at the same mutation sites.
function _invalidateLeadStatusCountsCache() {
  _invalidateContactsConfigCache();
}

// Helper: load the lead-status → normalised-stage map (e.g. 'NEW' → 'sales',
// 'DESIGN_BOOKED' → 'designvisit') from lead_status_config, memoised on the
// shared 60 s config cache so repeated callers don't re-query. Stage values are
// stored UPPERCASE+underscore and normalised to lowercase, underscores stripped
// (matching the workflow stage keys and stage_action_labels.stage_key).
async function _getStatusStageMap() {
  if (_stageConfigCache && Date.now() - _stageConfigCache.fetchedAt < CONTACTS_CONFIG_CACHE_TTL_MS) {
    return _stageConfigCache.map;
  }
  const { rows: stageRows } = await pool.query(
    'SELECT key, stage FROM lead_status_config WHERE stage IS NOT NULL'
  );
  const map = new Map(stageRows.map(r => [r.key, r.stage.toLowerCase().replace(/_/g, '')]));
  _stageConfigCache = { map, fetchedAt: Date.now() };
  return map;
}

// Helper: apply the dev-mode / hw_test_user filter exactly as /api/contacts-all
// does — when dev_mode_enabled is true only test contacts are shown, otherwise
// test contacts are hidden. Used by the count endpoints so their totals reflect
// the same base set as the list. Memoised on the shared 60 s config cache.
async function _applyDevModeFilter(contacts) {
  let devModeEnabled = false;
  if (_devModeCache && Date.now() - _devModeCache.fetchedAt < CONTACTS_CONFIG_CACHE_TTL_MS) {
    devModeEnabled = _devModeCache.value;
  } else {
    const { rows: dmRows } = await pool.query(
      `SELECT value FROM app_settings WHERE key = 'dev_mode_enabled'`
    );
    devModeEnabled = dmRows.length > 0 && dmRows[0].value === 'true';
    _devModeCache = { value: devModeEnabled, fetchedAt: Date.now() };
  }
  return devModeEnabled
    ? contacts.filter(c => c.properties?.hw_test_user === 'true')
    : contacts.filter(c => c.properties?.hw_test_user !== 'true');
}

// Helper: filter a contacts array to the given stage. MUST mirror the stage
// filter in /api/contacts-all so stage-scoped counts match the list — i.e.
// assign each contact's stage from its lead status via lead_status_config
// (NOT from room stageKey, which can disagree), with a missing status counting
// as `sales` (the unassigned stage).
function _filterContactsByStage(contacts, stageParam, statusStageMap) {
  if (!stageParam) return contacts;
  return contacts.filter(c => {
    const ls = c.properties?.hs_lead_status || '';
    if (!ls) return stageParam === 'sales'; // No status → sales (unassigned)
    return (statusStageMap.get(ls) || '') === stageParam;
  });
}

// Helper: resolve the admin-configured priority-sort active window (days).
// Defaults to 60. Memoised on the shared 60 s config cache and invalidated by
// _invalidateContactsConfigCache() when the admin saves a new value. Never
// throws — falls back to 60 on any DB error.
async function _getPriorityActiveDays() {
  if (_priorityActiveDaysCache && Date.now() - _priorityActiveDaysCache.fetchedAt < CONTACTS_CONFIG_CACHE_TTL_MS) {
    return _priorityActiveDaysCache.value;
  }
  let value = 60;
  try {
    const { rows } = await pool.query(
      `SELECT value FROM app_settings WHERE key = 'priority_active_days'`
    );
    if (rows.length > 0) {
      const parsed = parseInt(rows[0].value, 10);
      if (!isNaN(parsed) && parsed > 0) value = parsed;
    }
    _priorityActiveDaysCache = { value, fetchedAt: Date.now() };
  } catch (_) { /* use default 60 on DB error */ }
  return value;
}

// Helper: hide contacts not modified within the priority-active window. MUST
// mirror the priority filter in /api/contacts-all so the stage-tab badge counts
// match the list when "Priority first" is active. Missing/unparseable dates
// pass through (same "keep" behaviour as the list).
function _filterContactsByPriorityActive(contacts, priorityActiveDays) {
  const cutoff = Date.now() - priorityActiveDays * 24 * 60 * 60 * 1000;
  return contacts.filter(c => {
    const raw = c.properties?.lastmodifieddate;
    if (!raw) return true;
    const ms = new Date(raw).getTime();
    return !isNaN(ms) && ms >= cutoff;
  });
}

// Compute lead-status counts from an in-memory contacts array.
// Returns { __no_status__: N, KEY: N, ... } — every configured status key is
// present (0 when no contacts hold it) so the filter pills can render a count.
async function _computeLeadStatusCountsFromContacts(contacts) {
  const { rows: statusRows } = await pool.query(
    'SELECT key FROM lead_status_config WHERE is_null_row IS NOT TRUE ORDER BY sort_order ASC, key ASC'
  );
  const keys = new Set(statusRows.map(r => r.key));
  const counts = { __no_status__: 0 };
  for (const key of keys) counts[key] = 0;
  for (const c of contacts) {
    const ls = c.properties?.hs_lead_status || '';
    if (!ls) {
      counts.__no_status__ = (counts.__no_status__ || 0) + 1;
    } else if (keys.has(ls)) {
      counts[ls] = (counts[ls] || 0) + 1;
    }
  }
  return counts;
}

// ── Open-Leads in-memory cache (single-flight + 60 s TTL) ────────────────────
// Mirrors the lead-status-counts cache pattern. Invalidated on any
// hs_lead_status mutation.
const OPEN_LEADS_TTL_MS = 60_000;
let _openLeadsCache    = null; // { results, total, fetchedAt }
let _openLeadsInFlight = null;
function _invalidateOpenLeadsCache() {
  _openLeadsCache = null;
}

// ── Project-Contacts in-memory cache (single-flight + 60 s TTL) ──────────────
// Fetches contacts across ALL pipeline stages (not just OPEN_DEAL). Used by
// the Projects page to show cards for every configured lead-status key.
const PROJECT_CONTACTS_TTL_MS = 60_000;
let _projectContactsCache    = null; // { results, total, fetchedAt }
let _projectContactsInFlight = null;
function _invalidateProjectContactsCache() {
  _projectContactsCache = null;
}

/**
 * Patch HubSpot contact properties and automatically bust the project-contacts
 * cache. Use this helper (or its injected counterpart in other modules) for
 * every HubSpot contact property PATCH so cache invalidation is structurally
 * guaranteed and cannot be forgotten at a future call-site.
 *
 * @param {string} contactId  - HubSpot numeric contact id (un-encoded)
 * @param {object} properties - property key/value map to patch
 * @returns {Promise<import('axios').AxiosResponse>} the HubSpot PATCH response
 */
async function patchContactProperties(contactId, properties) {
  const resp = await hubspotRequestWithRetry('patch',
    `${HS}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`,
    { properties }
  );
  _invalidateProjectContactsCache();
  return resp;
}

app.get('/api/contacts-lead-status-counts', isAuthenticated, requireHubspotToken, async (req, res) => {
  // Per-lead-status counts for the Customers filter pills. Computed from the
  // shared contacts cache (a full HubSpot crawl) rather than per-status Search
  // API calls, so the counts cover exactly the same set the list shows and need
  // no rate-limit-prone fan-out. The dev-mode / hw_test_user filter is applied
  // so the pills match the list; excluded_from_sales statuses are intentionally
  // NOT pre-filtered — every status carries its true count and the client hides
  // excluded ones unless "Show excluded" is on.
  //
  // With a `stage` param the contacts are first narrowed to that stage using the
  // same lead-status → stage mapping as /api/contacts-all (normalise the param
  // the same way: lowercase, strip underscores).
  const stageParam = (req.query.stage || '').trim().toLowerCase().replace(/_/g, '');
  try {
    const { contacts: allContacts, stale, unavailable } = await getSharedContactsCache();
    if (unavailable) {
      return res.status(502).json({ error: 'HubSpot is currently unavailable. Please try again shortly.', code: 'HUBSPOT_UNAVAILABLE' });
    }
    if (stale) res.setHeader('X-Cache-Status', 'stale');
    let contacts = await _applyDevModeFilter(allContacts);
    if (stageParam) {
      const statusStageMap = await _getStatusStageMap();
      contacts = _filterContactsByStage(contacts, stageParam, statusStageMap);
    }
    const counts = await _computeLeadStatusCountsFromContacts(contacts);
    return res.json(counts);
  } catch (e) {
    const status = e.response?.status;
    if (status === 401 || status === 403) return res.status(502).json({ error: 'HubSpot rejected the request — the token may be invalid or expired.', code: 'HUBSPOT_AUTH' });
    if (status === 429) return res.status(502).json({ error: 'HubSpot rate limit reached. Please wait a moment and try again.', code: 'HUBSPOT_RATE_LIMIT' });
    return res.status(502).json({ error: e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
  }
});

// ── HubSpot: per-stage contact counts (Customers page stage tabs) ─────────────
// Returns { __all__: N, <stageKey>: N, ... } where each stage count is the
// number of contacts the Customers list would show under that stage tab.
//
// This MUST mirror the stage-filtering logic in /api/contacts-all exactly so
// the tab badge matches the list:
//   • same base set — the shared contacts cache (a full HubSpot crawl);
//   • same dev-mode / hw_test_user filter;
//   • same excluded_from_sales filter (skipped when includeExcluded=1, which
//     the page sends while "Show excluded" is on);
//   • same stage assignment — lead_status_config.stage (NOT room stageKey),
//     with a missing status counting as `sales`.
//
// Deriving the tab counts instead from /api/contacts-lead-status-counts (raw
// per-status HubSpot Search totals) was the bug: those totals span the entire
// HubSpot database — including contacts beyond the crawl's 10k Search window —
// so a stage could show hundreds while the list held a handful.
app.get('/api/contacts-stage-counts', isAuthenticated, requireHubspotToken, async (req, res) => {
  try {
    const includeExcluded = req.query.includeExcluded === '1';
    const { contacts: rawContacts, stale, unavailable } = await getSharedContactsCache();
    if (unavailable) {
      return res.status(502).json({ error: 'HubSpot is currently unavailable. Please try again shortly.', code: 'HUBSPOT_UNAVAILABLE' });
    }
    if (stale) res.setHeader('X-Cache-Status', 'stale');

    let contacts = rawContacts;

    // Dev-mode / hw_test_user filter (mirror /api/contacts-all).
    try {
      let devModeEnabled = false;
      if (_devModeCache && Date.now() - _devModeCache.fetchedAt < CONTACTS_CONFIG_CACHE_TTL_MS) {
        devModeEnabled = _devModeCache.value;
      } else {
        const { rows: dmRows } = await pool.query(
          `SELECT value FROM app_settings WHERE key = 'dev_mode_enabled'`
        );
        devModeEnabled = dmRows.length > 0 && dmRows[0].value === 'true';
        _devModeCache = { value: devModeEnabled, fetchedAt: Date.now() };
      }
      contacts = devModeEnabled
        ? contacts.filter(c => c.properties?.hw_test_user === 'true')
        : contacts.filter(c => c.properties?.hw_test_user !== 'true');
    } catch (dbErr) {
      logger.warn({ err: dbErr.message }, '[contacts-stage-counts] could not read dev_mode_enabled:');
    }

    // Priority-active filter (mirror /api/contacts-all). When the Customers list
    // is sorted "Priority first" with no search, the list hides contacts not
    // modified within the admin-configured active window — so the stage-tab badge
    // counts must apply the same filter to stay in sync with the list. The
    // frontend sends priorityFirst=1 only when that sort is active and no search
    // is present, matching the `priorityFirst && !q` gate in /api/contacts-all.
    if (req.query.priorityFirst === '1') {
      const priorityActiveDays = await _getPriorityActiveDays();
      contacts = _filterContactsByPriorityActive(contacts, priorityActiveDays);
    }

    // excluded_from_sales filter (mirror /api/contacts-all default).
    if (!includeExcluded) {
      try {
        let excludedKeys;
        if (_excludedKeysCache && Date.now() - _excludedKeysCache.fetchedAt < CONTACTS_CONFIG_CACHE_TTL_MS) {
          excludedKeys = _excludedKeysCache.keys;
        } else {
          const { rows: excludedRows } = await pool.query(
            'SELECT key FROM lead_status_config WHERE excluded_from_sales = TRUE'
          );
          excludedKeys = new Set(excludedRows.map(r => r.key));
          _excludedKeysCache = { keys: excludedKeys, fetchedAt: Date.now() };
        }
        if (excludedKeys.size > 0) {
          contacts = contacts.filter(c => !excludedKeys.has((c.properties?.hs_lead_status || '').toUpperCase()));
        }
      } catch (dbErr) {
        logger.warn({ err: dbErr.message }, '[contacts-stage-counts] could not load excluded lead statuses:');
      }
    }

    // Stage assignment from lead_status_config (mirror /api/contacts-all).
    let statusStageMap;
    try {
      statusStageMap = await _getStatusStageMap();
    } catch (dbErr) {
      logger.warn({ err: dbErr.message }, '[contacts-stage-counts] could not load stage config:');
      statusStageMap = new Map();
    }

    const counts = { __all__: 0 };
    for (const c of contacts) {
      counts.__all__ += 1;
      const ls = c.properties?.hs_lead_status || '';
      // No status → counts toward sales (the "unassigned" stage), matching the
      // `if (!ls && stageParam === 'sales') return true` rule in /api/contacts-all.
      const stage = ls ? (statusStageMap.get(ls) || '') : 'sales';
      if (stage) counts[stage] = (counts[stage] || 0) + 1;
    }
    return res.json(counts);
  } catch (e) {
    const status = e.response?.status;
    if (status === 401 || status === 403) return res.status(502).json({ error: 'HubSpot rejected the request — the token may be invalid or expired.', code: 'HUBSPOT_AUTH' });
    if (status === 429) return res.status(502).json({ error: 'HubSpot rate limit reached. Please wait a moment and try again.', code: 'HUBSPOT_RATE_LIMIT' });
    return res.status(502).json({ error: e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
  }
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
        do {
          const body = {
            filterGroups: [{
              filters: [
                { propertyName: 'hs_lead_status', operator: 'EQ', value: 'OPEN_DEAL' },
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
        logger.error('[open-leads] HubSpot fetch error (status=%s): %s', err.response?.status || 'network', err.message);
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
      logger.warn('[open-leads] HubSpot fetch failed; serving stale cache age=%dms', Date.now() - _openLeadsCache.fetchedAt);
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

// ── HubSpot: Project Contacts (contacts across all pipeline stages) ───────────

// Dev-mode filter helper — applied at response time so the cache always holds
// the full unfiltered list (same pattern as /api/contacts-all).
async function applyProjectContactsDevModeFilter(results) {
  try {
    const { rows: dmRows } = await pool.query(
      `SELECT value FROM app_settings WHERE key = 'dev_mode_enabled'`
    );
    const devModeEnabled = dmRows.length > 0 && dmRows[0].value === 'true';
    if (devModeEnabled) {
      return results.filter(c => c.properties?.hw_test_user === 'true');
    } else {
      return results.filter(c => c.properties?.hw_test_user !== 'true');
    }
  } catch (dbErr) {
    logger.warn({ err: dbErr.message }, '[project-contacts] could not read dev_mode_enabled:');
  }
  return results.filter(c => c.properties?.hw_test_user !== 'true');
}

app.get('/api/project-contacts', async (req, res) => {
  // Fresh cache hit — return immediately.
  if (_projectContactsCache && Date.now() - _projectContactsCache.fetchedAt < PROJECT_CONTACTS_TTL_MS) {
    const results = await applyProjectContactsDevModeFilter(_projectContactsCache.results);
    res.setHeader('X-Cache-Status', 'fresh');
    res.setHeader('X-Cache-Age', String(Math.round((Date.now() - _projectContactsCache.fetchedAt) / 1000)));
    return res.json({ results, total: results.length });
  }

  // Single-flight: all concurrent cold-cache callers share one HubSpot fan-out.
  if (!_projectContactsInFlight) {
    _projectContactsInFlight = (async () => {
      try {
        // Fetch all configured lead-status keys from the DB so the query
        // spans every pipeline stage, not just OPEN_DEAL.
        const { rows: statusRows } = await pool.query(
          'SELECT key FROM lead_status_config WHERE is_null_row IS NOT TRUE ORDER BY sort_order ASC, key ASC'
        );
        const keys = statusRows.map(r => r.key);

        // If no keys are configured fall back to an empty result set so the
        // Projects page renders empty rather than erroring.
        if (!keys.length) {
          _projectContactsCache = { results: [], total: 0, fetchedAt: Date.now() };
          return { ok: true, results: [], total: 0 };
        }

        const allResults = [];
        let after = undefined;
        do {
          const body = {
            filterGroups: [{
              filters: [
                { propertyName: 'hs_lead_status', operator: 'IN', values: keys },
              ]
            }],
            properties: ['firstname', 'lastname', 'email', 'phone', 'hs_lead_status', 'city', 'zip', 'customer_number', 'createdate', 'closedate', 'lastmodifieddate', 'hw_test_user', 'notes_last_contacted'],
            sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
            limit: 100
          };
          if (after) body.after = after;
          const r = await hubspotSearchWithRetry(body);
          allResults.push(...(r.data.results || []));
          after = r.data.paging?.next?.after;
        } while (after);

        // Surface contacts that have room data (measure_once_rooms) but whose
        // hs_lead_status is absent or not in the configured key set.  These
        // contacts would otherwise disappear from the Projects board silently.
        // We read from the shared contacts cache (already in memory for
        // /api/localdata/all) to avoid an extra HubSpot round-trip.
        try {
          const returnedIdSet = new Set(allResults.map(r => r.id));
          const { contacts: allCached } = await getSharedContactsCache();
          for (const contact of allCached) {
            if (returnedIdSet.has(contact.id)) continue;
            if (!contact.properties?.measure_once_rooms) continue;
            // Contact has room data but wasn't matched by the IN-filter —
            // its status is absent or unconfigured.
            allResults.push({ ...contact, _statusUnknown: true });
          }
        } catch {
          // Shared cache unavailable (first boot / HubSpot down) — skip
          // the orphan check rather than blocking the whole response.
        }

        _projectContactsCache = { results: allResults, total: allResults.length, fetchedAt: Date.now() };
        return { ok: true, results: allResults, total: allResults.length };
      } catch (err) {
        logger.error('[project-contacts] HubSpot fetch error (status=%s): %s', err.response?.status || 'network', err.message);
        return { ok: false, err };
      } finally {
        setImmediate(() => { _projectContactsInFlight = null; });
      }
    })();
  }

  const outcome = await _projectContactsInFlight;

  if (outcome.ok) {
    const results = await applyProjectContactsDevModeFilter(outcome.results);
    res.setHeader('X-Cache-Status', 'fresh');
    return res.json({ results, total: results.length });
  }

  // Fetch failed — serve stale cache if available rather than surfacing an error.
  if (_projectContactsCache) {
    if (process.env.DEBUG_HUBSPOT) {
      logger.warn('[project-contacts] HubSpot fetch failed; serving stale cache age=%dms', Date.now() - _projectContactsCache.fetchedAt);
    }
    const results = await applyProjectContactsDevModeFilter(_projectContactsCache.results);
    res.setHeader('X-Cache-Status', 'stale');
    return res.json({ results, total: results.length });
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
  const { firstname, lastname, email, phone, mobilephone, structuredAddress, leadStatus } = req.body || {};

  // Normalise the contact fields up front so validation and the HubSpot
  // properties agree — a whitespace-only value must not pass the
  // "at least one contact method" check and then be stored as an empty string.
  const firstnameTrimmed   = (firstname   && String(firstname).trim())   || '';
  const emailTrimmed       = (email       && String(email).trim())       || '';
  const phoneTrimmed       = (phone       && String(phone).trim())       || '';
  const mobilephoneTrimmed = (mobilephone && String(mobilephone).trim()) || '';

  // First name is always required. Email is optional — customers often arrive
  // via WhatsApp/phone with no email yet — but we need at least one way to reach
  // them, so require an email, mobile, or phone.
  if (!firstnameTrimmed) {
    return res.status(400).json({ error: 'First name is required.' });
  }
  if (!emailTrimmed && !phoneTrimmed && !mobilephoneTrimmed) {
    return res.status(400).json({ error: 'Add at least one contact method (email, mobile, or phone).' });
  }

  // Address fields come from the canonical structured address (the same shape
  // every other contact surface posts). Postcode is optional — when present it
  // also supplies the customer-number area prefix. Validate via the shared
  // Zod schema; an empty/partial object is valid (no address given).
  const parsedAddr = structuredAddressSchema.safeParse(structuredAddress || {});
  if (!parsedAddr.success) {
    return res.status(400).json({ error: 'Invalid address.' });
  }
  const hsAddr = addressToHubspot(parsedAddr.data);

  // Extract the area letters from the postcode (leading alpha chars before the
  // first digit). With no postcode supplied, fall back to an 'XX' prefix.
  const areaMatch = (hsAddr.zip || '').match(/^([A-Za-z]+)/);
  const areaPrefix = areaMatch ? areaMatch[1].toUpperCase() : 'XX';

  // Lead status defaults to OPEN_DEAL but the caller may assign any configured
  // status (e.g. a customer who arrives part-way through the pipeline).
  const leadStatusKey = (leadStatus && String(leadStatus).trim()) || 'OPEN_DEAL';

  try {
    await assertLeadStatusKey(leadStatusKey);
    // Create the contact in HubSpot
    const createBody = {
      properties: {
        firstname:      firstnameTrimmed,
        lastname:       lastname  || '',
        email:          emailTrimmed,
        phone:          phoneTrimmed,
        mobilephone:    mobilephoneTrimmed,
        address:        hsAddr.address || '',
        city:           hsAddr.city    || '',
        state:          hsAddr.state   || '',
        zip:            hsAddr.zip,
        country:        hsAddr.country || '',
        hs_lead_status: leadStatusKey,
      }
    };
    const createRes = await axios.post(
      `${HS}/crm/v3/objects/contacts`,
      createBody,
      { headers: getHubSpotHeaders() }
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
      { headers: getHubSpotHeaders() }
    );

    contact.properties.customer_number = customerNumber;
    clearContactCache();
    return res.status(201).json(contact);
  } catch (e) {
    if (e.code === 'LEAD_STATUS_REMOVED') {
      return res.status(422).json({ error: e.message, code: 'LEAD_STATUS_REMOVED', removedKey: e.removedKey });
    }
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
      headers: getHubSpotHeaders(),
      params: { properties: 'firstname,lastname,email,phone,mobilephone,address,city,state,zip,country,customer_number,hs_lead_status,createdate' }
    });
    const payload = r.data || {};
    const p = payload.properties || {};
    payload.structuredAddress = hubspotToAddress({
      address: p.address, city: p.city, state: p.state, zip: p.zip, country: p.country,
    });
    res.json(payload);
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
    const allowed = ['hs_lead_status', 'firstname', 'lastname', 'email', 'phone', 'mobilephone'];
    const properties = {};
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        properties[key] = req.body[key];
      }
    }
    // Address is supplied as a structured object and expanded into the raw
    // HubSpot address/city/state/zip/country properties via addressToHubspot().
    if (Object.prototype.hasOwnProperty.call(req.body, 'structuredAddress')) {
      const parsedAddr = structuredAddressSchema.safeParse(req.body.structuredAddress || {});
      if (!parsedAddr.success) {
        return res.status(400).json({ error: 'Invalid address.' });
      }
      const hsAddr = addressToHubspot(parsedAddr.data);
      properties.address = hsAddr.address;
      properties.city    = hsAddr.city;
      properties.state   = hsAddr.state;
      properties.zip     = hsAddr.zip;
      properties.country = hsAddr.country;
    }
    if (Object.keys(properties).length === 0) {
      return res.status(400).json({ error: 'No valid properties to update.' });
    }
    // Privileged-field gate: managers/admins only for hs_lead_status and email.
    // Email is gated because a member who can change the email and then trigger
    // the customer-info bearer link would receive it in their own inbox
    // (impersonation vector). Other contact fields remain member-editable.
    const needsManagerForContact = ['hs_lead_status', 'email']
      .some(f => Object.prototype.hasOwnProperty.call(properties, f));
    if (needsManagerForContact) {
      try {
        const userId = req.user?.claims?.sub;
        const ur = await pool.query(`SELECT privilege_level FROM users WHERE id = $1`, [userId]);
        const level = ur.rows[0]?.privilege_level || 'member';
        if (level !== 'manager' && level !== 'admin') {
          const isEmail = Object.prototype.hasOwnProperty.call(properties, 'email');
          return res.status(403).json({
            message: isEmail
              ? 'Manager or admin privilege required to change a contact email address.'
              : 'Manager or admin privilege required to change lead status.',
            code: 'PIPELINE_EDIT_FORBIDDEN',
          });
        }
      } catch {
        return res.status(500).json({ error: 'Authorization check failed' });
      }
    }
    const safeContactId = encodeURIComponent(contactId);

    // patchContactProperties wraps hubspotRequestWithRetry + cache invalidation.
    // _invalidateProjectContactsCache is called inside it on every successful PATCH.
    const patchResp = await patchContactProperties(contactId, properties);

    // Verify all submitted properties were saved by reading back from HubSpot.
    const propsToVerify = Object.keys(properties);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const isTransient = err => {
      const s = err.response?.status;
      if (s === 429) return true;
      if (s && s >= 500 && s < 600) return true;
      if (!err.response) return true; // network / timeout
      return false;
    };
    let verifyResp;
    let verifyErr;
    const delays = [250, 750, 1500];
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        verifyResp = await axios.get(
          `${HS}/crm/v3/objects/contacts/${safeContactId}`,
          { headers: getHubSpotHeaders(), params: { properties: propsToVerify.join(',') } }
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

    // Patch the in-memory cache directly so the next contacts-all response
    // reflects the new values immediately.  Clearing the cache instead would
    // trigger a full HubSpot search re-fetch whose index may not yet reflect
    // the update, causing a page refresh to still show the old value.
    patchContactInCache(contactId, properties);
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
app.get('/api/deals/:id/notes', isAuthenticated, requireManagerOrAdmin, requireHubspotToken, async (req, res) => {
  try {
    const dealId = req.params.id;
    if (!/^\d+$/.test(dealId)) {
      return res.status(400).json({ error: 'Invalid deal id' });
    }

    const assocR = await axios.get(
      `${HS}/crm/v3/objects/deals/${dealId}/associations/notes`,
      { headers: getHubSpotHeaders() }
    );
    const noteIds = assocR.data.results?.map(r => r.id) || [];
    if (!noteIds.length) return res.json({ results: [] });

    const noteR = await axios.post(
      `${HS}/crm/v3/objects/notes/batch/read`,
      {
        properties: ['hs_note_body', 'hs_timestamp'],
        inputs: noteIds.map(id => ({ id }))
      },
      { headers: getHubSpotHeaders() }
    );
    res.json(noteR.data);
  } catch (e) {
    logger.error({ err: e.response?.data || e.message }, 'GET /api/deals/:id/notes HubSpot error:');
    res.json({ results: [] });
  }
});

// Verify that a HubSpot note is actually associated with the given object type + ID.
// Returns true if the association exists, false otherwise (or on error).
async function verifyNoteAssociation(noteId, objectType, objectId) {
  try {
    const r = await axios.get(
      `${HS}/crm/v3/objects/notes/${encodeURIComponent(noteId)}/associations/${encodeURIComponent(objectType)}`,
      { headers: getHubSpotHeaders(), timeout: 8000 }
    );
    const ids = (r.data?.results || []).map(a => String(a.id));
    return ids.includes(String(objectId));
  } catch (e) {
    // If the note doesn't exist or the association call fails, deny the update.
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
    logger.error({ err: e.response?.data || e.message }, 'POST /api/deals/:id/checklist HubSpot error:');
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

// ── Shared Google Calendar ────────────────────────────────────────────────────
// Every app-created event is written to a single shared calendar ("Measure
// Once", owned by Harry) rather than each user's personal `primary` calendar.
// The connected user's own OAuth credentials still perform the write — only the
// target calendar changes. The calendar ID is supplied via the
// GOOGLE_SHARED_CALENDAR_ID env var. Throws CALENDAR_NOT_CONFIGURED when unset
// so callers can surface a clear setup message instead of silently writing to
// the wrong calendar.
function getSharedCalendarId() {
  const id = (process.env.GOOGLE_SHARED_CALENDAR_ID || '').trim();
  if (!id) {
    const err = new Error('Shared calendar not configured — contact your administrator.');
    err.code = 'CALENDAR_NOT_CONFIGURED';
    err.statusCode = 503;
    throw err;
  }
  return id;
}

logger.info((process.env.GOOGLE_SHARED_CALENDAR_ID || '').trim()
    ? '[calendar] Shared calendar configured (GOOGLE_SHARED_CALENDAR_ID is set).'
    : '[calendar] WARNING: GOOGLE_SHARED_CALENDAR_ID is not set — scheduling actions will return a configuration error until it is set.');

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

// Returns the Google tokens for the currently authenticated user from the DB,
// or null if none are stored or the user is not authenticated.
async function getVerifiedGoogleTokens(req) {
  const currentUser = req.user?.claims?.sub != null
    ? String(req.user.claims.sub)
    : null;
  if (!currentUser) return null;

  // Test-only: bypass token DB lookup when GOOGLE_TEST_TOKENS is set.
  // Never active in production (NODE_ENV check) — used only by the
  // arrange-visit E2E test harness that runs a fake Google Calendar server.
  if (process.env.GOOGLE_TEST_TOKENS && process.env.NODE_ENV !== 'production') {
    try { return JSON.parse(process.env.GOOGLE_TEST_TOKENS); } catch {}
  }

  // Session caching removed (sessions migrated to Identity Platform cookies).
  // Always load from DB.
  const dbTokens = await loadGoogleTokens(currentUser);
  return dbTokens || null;
}

app.get('/api/emails', isAuthenticated, async (req, res) => {
  const googleTokens = await getVerifiedGoogleTokens(req);
  if (!googleTokens) return res.status(401).json({ error: 'Not authenticated with Google', code: 'GOOGLE_AUTH' });
  try {
    const auth = getGoogleClient(googleTokens);
    const gmail = getGmailClient(auth);
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
  const googleTokens = await getVerifiedGoogleTokens(req);
  if (!googleTokens) return res.status(401).json({ error: 'Not authenticated with Google', code: 'GOOGLE_AUTH' });
  try {
    const auth = getGoogleClient(googleTokens);
    const gmail = getGmailClient(auth);
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
app.get('/api/events', isAuthenticated, async (req, res) => {
  const googleTokens = await getVerifiedGoogleTokens(req);
  if (!googleTokens) return res.status(401).json({ error: 'Not authenticated with Google', code: 'GOOGLE_AUTH' });
  let calendarId;
  try { calendarId = getSharedCalendarId(); }
  catch (cfgErr) { return res.status(503).json({ error: cfgErr.message, code: cfgErr.code }); }
  try {
    const auth = getGoogleClient(googleTokens);
    const calendar = getCalendarClient(auth);
    const contactId = String(req.query.contactId || '').trim();
    // includePast=1 widens the window back a year (no upper bound) so the
    // "Done / Past" feeds can show events that have already happened alongside
    // upcoming ones. Default stays future-only for existing callers.
    const includePast = String(req.query.includePast || '') === '1';
    const listParams = {
      calendarId,
      timeMin: includePast
        ? new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString()
        : new Date().toISOString(),
      maxResults: includePast ? 100 : 50,
      singleEvents: true,
      orderBy: 'startTime',
    };
    if (contactId) {
      if (!/^\d+$/.test(contactId)) return res.status(400).json({ error: 'Invalid contactId.' });
      listParams.privateExtendedProperty = `moContactId=${contactId}`;
    } else {
      listParams.maxResults = includePast ? 100 : 20;
      listParams.q = req.query.search || undefined;
    }
    const events = await calendar.events.list(listParams);
    res.json(events.data);
  } catch (e) {
    const code = classifyGoogleError(e);
    res.status(code === 'GOOGLE_AUTH' ? 401 : 500).json({ error: e.message, code });
  }
});

app.post('/api/events', isAuthenticated, requirePrivilege('member'), calendarEventLimiter, async (req, res) => {
  const googleTokens = await getVerifiedGoogleTokens(req);
  if (!googleTokens) return res.status(401).json({ error: 'Not authenticated with Google', code: 'GOOGLE_AUTH' });
  let calendarId;
  try { calendarId = getSharedCalendarId(); }
  catch (cfgErr) { return res.status(503).json({ error: cfgErr.message, code: cfgErr.code }); }
  try {
    const auth = getGoogleClient(googleTokens);
    const calendar = getCalendarClient(auth);
    // Extract tagging fields from body and attach as extendedProperties.
    // These are used by GET /api/events?contactId to filter by contact.
    const { moContactId, moVisitType, ...eventBody } = req.body;
    if (moContactId) {
      const ep = eventBody.extendedProperties || {};
      ep.private = { ...(ep.private || {}), moContactId: String(moContactId), moSource: 'measure-once' };
      if (moVisitType) ep.private.moVisitType = String(moVisitType);
      eventBody.extendedProperties = ep;
    }
    const event = await calendar.events.insert({ calendarId, requestBody: eventBody });
    res.json(event.data);
  } catch (e) {
    const code = classifyGoogleError(e);
    res.status(code === 'GOOGLE_AUTH' ? 401 : 500).json({ error: e.message, code });
  }
});

app.patch('/api/events/:id', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const googleTokens = await getVerifiedGoogleTokens(req);
  if (!googleTokens) return res.status(401).json({ error: 'Not authenticated with Google', code: 'GOOGLE_AUTH' });
  const eventId = String(req.params.id || '').trim();
  if (!eventId) return res.status(400).json({ error: 'Invalid event id' });
  let calendarId;
  try { calendarId = getSharedCalendarId(); }
  catch (cfgErr) { return res.status(503).json({ error: cfgErr.message, code: cfgErr.code }); }
  try {
    const auth = getGoogleClient(googleTokens);
    const calendar = getCalendarClient(auth);
    const event = await calendar.events.patch({ calendarId, eventId, requestBody: req.body });
    res.json(event.data);
  } catch (e) {
    const code = classifyGoogleError(e);
    res.status(code === 'GOOGLE_AUTH' ? 401 : 500).json({ error: e.message, code });
  }
});

app.delete('/api/events/:id', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const googleTokens = await getVerifiedGoogleTokens(req);
  if (!googleTokens) return res.status(401).json({ error: 'Not authenticated with Google', code: 'GOOGLE_AUTH' });
  const eventId = String(req.params.id || '').trim();
  if (!eventId) return res.status(400).json({ error: 'Invalid event id' });
  let calendarId;
  try { calendarId = getSharedCalendarId(); }
  catch (cfgErr) { return res.status(503).json({ error: cfgErr.message, code: cfgErr.code }); }
  try {
    const auth = getGoogleClient(googleTokens);
    const calendar = getCalendarClient(auth);
    await calendar.events.delete({ calendarId, eventId });
    res.json({ success: true });
  } catch (e) {
    const code = classifyGoogleError(e);
    res.status(code === 'GOOGLE_AUTH' ? 401 : 500).json({ error: e.message, code });
  }
});

// DELETE /api/visits/:id — remove a legacy (pre-Google-Calendar) visit row.
// The visits table was dropped in production; if Postgres returns
// "undefined_table" (42P01) we treat it as already gone and return success.
// Any other DB error is re-thrown so the client receives an honest 500.
app.delete('/api/visits/:id', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid visit id' });
  }
  try {
    await pool.query('DELETE FROM visits WHERE id = $1', [id]);
  } catch (dbErr) {
    if (dbErr?.code !== '42P01') {
      // Not a missing-table error — surface it to the client.
      return res.status(500).json({ error: dbErr?.message || 'Database error' });
    }
    // visits table has been dropped — treat the row as already gone.
  }
  res.json({ success: true });
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
      { headers: getHubSpotHeaders() }
    );
    const noteIds = assocR.data.results?.map(r => r.id) || [];
    if (!noteIds.length) return res.json({ results: [] });

    const noteR = await axios.post(
      `${HS}/crm/v3/objects/notes/batch/read`,
      {
        properties: ['hs_note_body', 'hs_timestamp'],
        inputs: noteIds.map(id => ({ id }))
      },
      { headers: getHubSpotHeaders() }
    );
    res.json(noteR.data);
  } catch (e) {
    logger.error({ err: e.response?.data || e.message }, 'GET /api/contacts/:id/notes HubSpot error:');
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
    logger.error({ err: e.response?.data || e.message }, 'POST /api/contacts/:id/workflow HubSpot error:');
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
    logger.error({ err: e.response?.data || e.message }, 'POST /api/deals/:id/workflow HubSpot error:');
    res.status(502).json({ error: e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
  }
});

// ── Calendar-backed Tasks ─────────────────────────────────────────────────────
// Tasks are stored as Google Calendar events on the shared calendar, tagged
// with extendedProperties.private: moTask=1, moContactId, moAssignedUserId,
// moTaskStatus (open|completed).  These routes replace the former HubSpot-
// backed task endpoints.

function calendarEventToTask(ev) {
  const ep = (ev.extendedProperties && ev.extendedProperties.private) || {};
  return {
    id: ev.id,
    task_name: ev.summary || 'Untitled',
    task_description: ev.description || '',
    task_customer: {
      contactId:   ep.moContactId   || '',
      contactName: ep.moContactName || '',
    },
    task_assigned_user: {
      userId: ep.moAssignedUserId   || '',
      name:   ep.moAssignedUserName || '',
    },
    task_deadline: (ev.start && (ev.start.dateTime || ev.start.date)) || '',
    task_status: ep.moTaskStatus === 'completed' ? 'completed' : 'open',
    // When a task was marked complete (ISO). Older tasks completed before this
    // field existed return null; consumers fall back to task_deadline for
    // ordering the "Done / Past" lists.
    task_completed_at: ep.moCompletedAt || null,
  };
}

app.get('/api/tasks', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const googleTokens = await getVerifiedGoogleTokens(req);
  if (!googleTokens) return res.status(401).json({ error: 'Not authenticated with Google', code: 'GOOGLE_AUTH' });
  let calendarId;
  try { calendarId = getSharedCalendarId(); }
  catch (cfgErr) { return res.status(503).json({ error: cfgErr.message, code: cfgErr.code }); }
  try {
    const auth = getGoogleClient(googleTokens);
    const calendar = getCalendarClient(auth);
    const contactId      = String(req.query.contactId      || '').trim();
    const assignedUserId = String(req.query.assignedUserId || '').trim();
    if (contactId && !/^\d+$/.test(contactId)) return res.status(400).json({ error: 'Invalid contactId.' });

    const privateExtendedProperty = ['moTask=1'];
    if (contactId)      privateExtendedProperty.push(`moContactId=${contactId}`);
    if (assignedUserId) privateExtendedProperty.push(`moAssignedUserId=${assignedUserId}`);

    const listParams = {
      calendarId,
      maxResults: 100,
      singleEvents: true,
      orderBy: 'startTime',
      timeMin: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
      privateExtendedProperty,
    };
    const events = await calendar.events.list(listParams);
    const results = (events.data.items || []).map(ev => calendarEventToTask(ev));
    res.json({ results });
  } catch (e) {
    const code = classifyGoogleError(e);
    res.status(code === 'GOOGLE_AUTH' ? 401 : 500).json({ error: e.message, code });
  }
});

app.post('/api/tasks', isAuthenticated, requirePrivilege('member'), calendarEventLimiter, async (req, res) => {
  const googleTokens = await getVerifiedGoogleTokens(req);
  if (!googleTokens) return res.status(401).json({ error: 'Not authenticated with Google', code: 'GOOGLE_AUTH' });
  let calendarId;
  try { calendarId = getSharedCalendarId(); }
  catch (cfgErr) { return res.status(503).json({ error: cfgErr.message, code: cfgErr.code }); }
  try {
    const { task_name, task_description, task_customer, task_assigned_user, task_deadline } = req.body;
    if (!task_name || !String(task_name).trim()) return res.status(400).json({ error: 'task_name is required.' });
    if (!task_deadline) return res.status(400).json({ error: 'task_deadline is required.' });
    const deadlineDate = new Date(task_deadline);
    if (isNaN(deadlineDate.getTime())) return res.status(400).json({ error: 'task_deadline is not a valid date.' });

    const ep = {
      moTask: '1',
      moSource: 'measure-once',
      moTaskStatus: 'open',
    };
    if (task_customer?.contactId)      ep.moContactId   = String(task_customer.contactId);
    if (task_customer?.contactName)    ep.moContactName  = String(task_customer.contactName);
    if (task_assigned_user?.userId)    ep.moAssignedUserId   = String(task_assigned_user.userId);
    if (task_assigned_user?.name)      ep.moAssignedUserName = String(task_assigned_user.name);

    const auth = getGoogleClient(googleTokens);
    const calendar = getCalendarClient(auth);
    const endDate = new Date(deadlineDate.getTime() + 30 * 60 * 1000);
    const event = await calendar.events.insert({
      calendarId,
      requestBody: {
        summary: String(task_name).trim(),
        description: task_description ? String(task_description).trim() : '',
        start: { dateTime: deadlineDate.toISOString() },
        end:   { dateTime: endDate.toISOString() },
        extendedProperties: { private: ep },
      },
    });
    res.json(calendarEventToTask(event.data));

    // Fire-and-forget notification email when task is assigned to someone else
    const assignedUserId = task_assigned_user?.userId ? String(task_assigned_user.userId) : null;
    const creatorId = req.user?.claims?.sub ? String(req.user.claims.sub) : null;
    if (assignedUserId && creatorId && assignedUserId !== creatorId) {
      getPageFilterConfig().then(cfg => {
        if (cfg.task_assignment_emails_enabled === 'false') return;
        const creatorName = req.user?.first_name
          ? `${req.user.first_name} ${req.user.last_name || ''}`.trim()
          : (req.user?.email || 'A team member');
        return _sendTaskAssignmentNotification({
          assignedUserId,
          creatorName,
          taskName: String(task_name).trim(),
          taskDescription: task_description ? String(task_description).trim() : '',
          contactName: task_customer?.contactName ? String(task_customer.contactName) : '',
          deadline: deadlineDate,
        });
      }).catch(err => logger.warn({ err }, 'Task assignment notification failed (non-fatal)'));
    }
  } catch (e) {
    const code = classifyGoogleError(e);
    res.status(code === 'GOOGLE_AUTH' ? 401 : 500).json({ error: e.message, code });
  }
});

app.patch('/api/tasks/:id', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const googleTokens = await getVerifiedGoogleTokens(req);
  if (!googleTokens) return res.status(401).json({ error: 'Not authenticated with Google', code: 'GOOGLE_AUTH' });
  const eventId = String(req.params.id || '').trim();
  if (!eventId) return res.status(400).json({ error: 'Invalid task id.' });
  let calendarId;
  try { calendarId = getSharedCalendarId(); }
  catch (cfgErr) { return res.status(503).json({ error: cfgErr.message, code: cfgErr.code }); }
  try {
    const auth = getGoogleClient(googleTokens);
    const calendar = getCalendarClient(auth);
    const updates = {};
    const epUpdates = {};

    if (req.body.task_name !== undefined)        updates.summary     = String(req.body.task_name).trim();
    if (req.body.task_description !== undefined) updates.description = String(req.body.task_description);
    if (req.body.task_status !== undefined) {
      if (!['open', 'completed'].includes(req.body.task_status)) {
        return res.status(400).json({ error: 'task_status must be "open" or "completed".' });
      }
      epUpdates.moTaskStatus = req.body.task_status;
      // Stamp (or clear) the completion time so the "Done / Past" lists can sort
      // by when a task was actually completed rather than its deadline. Setting
      // an extended property to '' removes it from the calendar event.
      epUpdates.moCompletedAt = req.body.task_status === 'completed'
        ? new Date().toISOString()
        : '';
    }
    if (req.body.task_deadline !== undefined) {
      const dd = new Date(req.body.task_deadline);
      if (isNaN(dd.getTime())) return res.status(400).json({ error: 'task_deadline is not a valid date.' });
      updates.start = { dateTime: dd.toISOString() };
      updates.end   = { dateTime: new Date(dd.getTime() + 30 * 60 * 1000).toISOString() };
    }

    // Detect assignment changes so we can notify the new assignee
    let previousAssignedUserId = null;
    let newAssignedUserId = null;
    if (req.body.task_assigned_user !== undefined) {
      const task_assigned_user = req.body.task_assigned_user;
      if (task_assigned_user?.userId) {
        epUpdates.moAssignedUserId   = String(task_assigned_user.userId);
        epUpdates.moAssignedUserName = task_assigned_user.name ? String(task_assigned_user.name) : '';
        newAssignedUserId = String(task_assigned_user.userId);
      } else {
        epUpdates.moAssignedUserId   = '';
        epUpdates.moAssignedUserName = '';
      }
      // Fetch the existing event to find out who was previously assigned
      const existing = await calendar.events.get({ calendarId, eventId });
      previousAssignedUserId = existing.data?.extendedProperties?.private?.moAssignedUserId || null;
    }

    if (Object.keys(epUpdates).length > 0) {
      updates.extendedProperties = { private: epUpdates };
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update.' });
    }

    const event = await calendar.events.patch({ calendarId, eventId, requestBody: updates });
    res.json(calendarEventToTask(event.data));

    // Fire-and-forget notification emails on assignment changes
    const creatorId = req.user?.claims?.sub ? String(req.user.claims.sub) : null;
    const assignmentChanged = previousAssignedUserId &&
      (newAssignedUserId || '') !== previousAssignedUserId;
    if (assignmentChanged || (newAssignedUserId && newAssignedUserId !== (previousAssignedUserId || null))) {
      const creatorName = req.user?.first_name
        ? `${req.user.first_name} ${req.user.last_name || ''}`.trim()
        : (req.user?.email || 'A team member');
      const ep = event.data?.extendedProperties?.private || {};
      const deadlineRaw = event.data?.start?.dateTime || event.data?.start?.date;
      const deadlineDate = deadlineRaw ? new Date(deadlineRaw) : new Date();

      // Notify the new assignee (if there is one and they didn't self-assign)
      if (newAssignedUserId && newAssignedUserId !== (previousAssignedUserId || null) &&
          creatorId && newAssignedUserId !== creatorId) {
        getPageFilterConfig().then(cfg => {
          if (cfg.task_reassignment_emails_enabled === 'false') return;
          return _sendTaskAssignmentNotification({
            assignedUserId: newAssignedUserId,
            creatorName,
            taskName: event.data?.summary || '',
            taskDescription: event.data?.description || '',
            contactName: ep.moContactName || '',
            deadline: deadlineDate,
            isReassignment: true,
          });
        }).catch(err => logger.warn({ err }, 'Task reassignment notification failed (non-fatal)'));
      }

      // Notify the previous assignee that the task has been taken from them
      if (assignmentChanged) {
        getPageFilterConfig().then(cfg => {
          if (cfg.task_assignment_emails_enabled === 'false') return;
          return _sendTaskUnassignmentNotification({
            previousAssignedUserId,
            creatorName,
            taskName: event.data?.summary || '',
            contactName: ep.moContactName || '',
          });
        }).catch(err => logger.warn({ err }, 'Task unassignment notification failed (non-fatal)'));
      }
    }
  } catch (e) {
    const code = classifyGoogleError(e);
    res.status(code === 'GOOGLE_AUTH' ? 401 : 500).json({ error: e.message, code });
  }
});

app.delete('/api/tasks/:id', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const googleTokens = await getVerifiedGoogleTokens(req);
  if (!googleTokens) return res.status(401).json({ error: 'Not authenticated with Google', code: 'GOOGLE_AUTH' });
  const eventId = String(req.params.id || '').trim();
  if (!eventId) return res.status(400).json({ error: 'Invalid task id.' });
  let calendarId;
  try { calendarId = getSharedCalendarId(); }
  catch (cfgErr) { return res.status(503).json({ error: cfgErr.message, code: cfgErr.code }); }
  try {
    const auth = getGoogleClient(googleTokens);
    const calendar = getCalendarClient(auth);
    await calendar.events.delete({ calendarId, eventId });
    res.json({ success: true });
  } catch (e) {
    const code = classifyGoogleError(e);
    res.status(code === 'GOOGLE_AUTH' ? 401 : 500).json({ error: e.message, code });
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
    const lastAttempt = {};
    for (const id of ids) { urgency[id] = null; lastAttempt[id] = null; }
    if (!ids.length) return res.json({ urgency, lastAttempt });

    // Best-effort local DB query for contact attempt history (runs before HubSpot
    // calls so it is always included even if HubSpot returns early).
    // Returns total attempt count + most-recent method from contact_attempt_log
    // (per-attempt rows), falling back gracefully for contacts not yet backfilled.
    try {
      const { rows: attemptRows } = await pool.query(
        `WITH log_counts AS (
           SELECT hubspot_contact_id, COUNT(*) AS total_attempts
           FROM contact_attempt_log
           WHERE hubspot_contact_id = ANY($1)
           GROUP BY hubspot_contact_id
         ),
         log_latest AS (
           SELECT DISTINCT ON (hubspot_contact_id)
             hubspot_contact_id, method
           FROM contact_attempt_log
           WHERE hubspot_contact_id = ANY($1)
           ORDER BY hubspot_contact_id, attempted_at DESC
         ),
         log_method_counts AS (
           SELECT hubspot_contact_id,
                  jsonb_object_agg(method, cnt) AS method_counts
           FROM (
             SELECT hubspot_contact_id, method, COUNT(*) AS cnt
             FROM contact_attempt_log
             WHERE hubspot_contact_id = ANY($1)
             GROUP BY hubspot_contact_id, method
           ) mc
           GROUP BY hubspot_contact_id
         )
         SELECT cat.hubspot_contact_id,
                cat.attempted_at,
                COALESCE(lc.total_attempts, 0) AS total_attempts,
                ll.method                       AS last_method,
                lmc.method_counts,
                COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email) AS attempted_by_name
         FROM contact_attempt_tracking cat
         LEFT JOIN users u ON u.id = cat.attempted_by
         LEFT JOIN log_counts       lc  ON lc.hubspot_contact_id  = cat.hubspot_contact_id
         LEFT JOIN log_latest       ll  ON ll.hubspot_contact_id  = cat.hubspot_contact_id
         LEFT JOIN log_method_counts lmc ON lmc.hubspot_contact_id = cat.hubspot_contact_id
         WHERE cat.hubspot_contact_id = ANY($1)
           AND cat.attempted_at IS NOT NULL`,
        [ids]
      );
      for (const row of attemptRows) {
        lastAttempt[row.hubspot_contact_id] = {
          at:           row.attempted_at,
          by:           row.attempted_by_name || null,
          count:        Number(row.total_attempts),
          method:       row.last_method || null,
          methodCounts: row.method_counts || null,
        };
      }
    } catch (e) {
      logger.error({ err: e.message }, 'POST /api/contacts/urgency lastAttempt query error:');
    }

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
      logger.error({ err: e.response?.data || e.message }, 'POST /api/contacts/urgency assoc batch error:');
      return res.json({ urgency, lastAttempt });
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
    if (!allTaskIds.size) return res.json({ urgency, lastAttempt });

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
        logger.error({ err: e.response?.data || e.message }, 'POST /api/contacts/urgency task batch error (chunk skipped):');
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
    res.json({ urgency, lastAttempt });
  } catch (_e) {
    res.json({ urgency: {}, lastAttempt: {} });
  }
});

// Open (non-completed) Google Calendar task counts per contact.
// Returns { openTaskCounts: { [contactId]: number } } keyed by the requested
// IDs.  Falls back gracefully to all-zero counts when Google tokens are absent,
// the calendar is not configured, or the Calendar API call fails, so the client
// always receives a valid map and the badge simply does not appear.
app.post('/api/contacts/open-task-counts', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const ids = Array.from(new Set(rawIds.map(v => String(v)).filter(v => /^\d+$/.test(v)))).slice(0, 100);
  const openTaskCounts = {};
  for (const id of ids) { openTaskCounts[id] = 0; }
  if (!ids.length) return res.json({ openTaskCounts });

  const googleTokens = await getVerifiedGoogleTokens(req);
  if (!googleTokens) return res.json({ openTaskCounts });

  let calendarId;
  try { calendarId = getSharedCalendarId(); }
  catch (_e) { return res.json({ openTaskCounts }); }

  try {
    const auth = getGoogleClient(googleTokens);
    const calendar = getCalendarClient(auth);
    const events = await calendar.events.list({
      calendarId,
      maxResults: 2500,
      singleEvents: true,
      timeMin: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
      privateExtendedProperty: ['moTask=1'],
    });
    for (const ev of (events.data.items || [])) {
      const ep = (ev.extendedProperties && ev.extendedProperties.private) || {};
      if (ep.moTaskStatus === 'completed') continue;
      const contactId = ep.moContactId || '';
      if (!contactId || !(contactId in openTaskCounts)) continue;
      openTaskCounts[contactId] = (openTaskCounts[contactId] || 0) + 1;
    }
  } catch (_e) {
    // Best-effort; return whatever we accumulated (zeros for uncounted contacts)
  }

  res.json({ openTaskCounts });
});

// ── Team members ─────────────────────────────────────────────────────────────
// Returns all active users — used by TaskModal to populate the assignee picker.
app.get('/api/users', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, first_name, last_name, email
       FROM users
       WHERE onboarding_status = 'active'
       ORDER BY first_name, last_name, email`
    );
    res.json(rows.map(u => ({
      id:    String(u.id),
      name:  [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.email || '',
      email: u.email || '',
    })));
  } catch (e) {
    logger.error({ err: e.message }, 'GET /api/users error:');
    res.status(500).json({ error: 'Failed to load users.' });
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

app.post('/api/workflow', isAuthenticated, requireManagerOrAdmin, async (req, res) => {
  const err = validateWorkflow(req.body);
  if (err) return res.status(400).json({ error: err });

  // Capture existing stage keys before overwriting so we can detect additions.
  let prevStageKeys = new Set();
  try {
    if (fs.existsSync(WORKFLOW_FILE)) {
      const prev = JSON.parse(fs.readFileSync(WORKFLOW_FILE, 'utf8'));
      if (prev?.stages && typeof prev.stages === 'object') {
        prevStageKeys = new Set(Object.keys(prev.stages));
      }
    }
  } catch { /* treat as empty — safe to re-seed */ }

  fs.writeFileSync(WORKFLOW_FILE, JSON.stringify(req.body, null, 2));
  res.json({ success: true });

  // For each stage key that is new in this save and is a known pipeline stage,
  // seed a null-status row (stage_key, '', '') so the Card Actions tab shows the
  // "No lead status / stage default" row immediately without waiting for a restart.
  // ON CONFLICT DO NOTHING preserves any admin-set value.
  const newStageKeys = Object.keys(req.body.stages || {}).filter(k => !prevStageKeys.has(k));
  if (newStageKeys.length) {
    const knownNew = newStageKeys.filter(k => STAGE_ACTION_STAGE_KEYS.has(k));
    for (const sk of knownNew) {
      pool.query(
        `INSERT INTO stage_action_labels (stage_key, status_key, label)
         VALUES ($1, '', '')
         ON CONFLICT (stage_key, status_key) DO NOTHING`,
        [sk],
      ).catch(e => logger.warn({ err: e.message }, `stage-action-labels null-row seed for stage "${sk}" failed:`));
    }
    // Seed per-status rows for every lead status already assigned to any of the
    // newly added stages (idempotent — skips rows that already exist).
    seedStageActionLabelsDefaults().catch(e =>
      logger.warn({ err: e.message }, 'stage-action-labels seed after workflow stage add failed:'),
    );
  }
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
    logger.error({ err: e }, 'GET /api/users/me/prefs error:');
    res.status(500).json({ error: 'Failed to load preferences' });
  }
});

// 'invoices' is retained as a valid (non-rendered) nav key after the dedicated
// /invoices page was removed — BottomNav drops any stored key not in its NAV
// array. Must match VALID_NAV_KEYS_SERVER in auth.js (see test:nav-key-sync).
const VALID_NAV_KEYS = new Set(['home', 'customers', 'sales', 'survey', 'designvisit', 'projects', 'invoices', 'trades', 'ideas']);
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
      if (keys !== null) {
        if (
          !Array.isArray(keys) ||
          keys.length !== NAV_BAR_SIZE ||
          !keys.every((k) => typeof k === 'string' && VALID_NAV_KEYS.has(k)) ||
          new Set(keys).size !== NAV_BAR_SIZE
        ) {
          return res.status(400).json({
            error: `nav_primary_keys must be an array of exactly ${NAV_BAR_SIZE} unique valid nav keys, or null to clear`,
          });
        }
      }
    }
    // Build the update: for any key set to null, remove it from the JSONB
    // column (so GET /prefs returns null/absent rather than a JSON null).
    // For all other keys, merge them in with the || operator.
    const nullKeys = Object.keys(patch).filter((k) => patch[k] === null);
    const nonNullPatch = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null));
    let updateExpr = 'prefs';
    const queryParams = [userId];
    let paramIdx = 2;
    if (Object.keys(nonNullPatch).length > 0) {
      updateExpr = `${updateExpr} || $${paramIdx}::jsonb`;
      queryParams.splice(paramIdx - 1, 0, JSON.stringify(nonNullPatch));
      paramIdx++;
    }
    for (const k of nullKeys) {
      updateExpr = `${updateExpr} - $${paramIdx}`;
      queryParams.splice(paramIdx - 1, 0, k);
      paramIdx++;
    }
    const r = await pool.query(
      `UPDATE users SET prefs = ${updateExpr}, updated_at = NOW()
       WHERE id = $1 RETURNING prefs`,
      queryParams
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'User not found' });
    res.json(r.rows[0].prefs);
  } catch (e) {
    logger.error({ err: e }, 'PATCH /api/users/me/prefs error:');
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
  // Schema (trade_contacts/companies/contacts/submissions/audit + added columns)
  // is created by migrations. This boot step performs the one-time legacy data
  // migration: moving rows from the old trade_contacts table into the
  // company-first model and backfilling the audit log for pre-audit companies.
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
app.get('/admin', requirePageAuth, async (req, res) => {
  const userId = req.user.claims.sub;
  let admin = false;
  if (userId) {
    try {
      const r = await pool.query('SELECT privilege_level FROM users WHERE id = $1', [userId]);
      admin = r.rows[0]?.privilege_level === 'admin';
    } catch (e) {
      logger.error({ err: e }, 'GET /admin admin check failed:');
    }
  }
  if (!admin) {
    return res.status(403).send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Access denied · Harry Wardrobes</title>
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
  res.render('admin', { title: 'Admin · Harry Wardrobes', userId: req.user.claims.sub });
});

app.get('/trades', isAuthenticated, (_req, res) => {
  res.redirect('/');
});

app.get('/access-restricted', isAuthenticated, (_req, res) => {
  res.render('access-restricted', { title: 'Access Restricted · Harry Wardrobes' });
});

app.get('/projects', isAuthenticated, (_req, res) => {
  res.render('projects', { title: 'Projects · Harry Wardrobes', description: 'Track active and completed wardrobe projects from design through to installation.' });
});
app.get('/survey', isAuthenticated, (_req, res) => {
  res.render('survey', { title: 'Survey · Harry Wardrobes', description: 'View and manage survey visits.' });
});

// Standalone, offline-capable design-visit field tool. Exact-path match, so it
// never shadows the public token-gated /design-visit/sign-off route above.
app.get('/design-visit', isAuthenticated, (_req, res) => {
  res.render('design-visit', { title: 'Design visit · Harry Wardrobes', description: 'Start a design visit on this device — works offline and syncs when you reconnect.' });
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
// Used by the admin Team page (and formerly the Trades modal) to flag a phone
// number that is already in use somewhere else (team metadata, trade-company
// contacts, or HubSpot customer contacts). Restricted to admins because the
// response includes employee emergency-contact numbers and pending approved-user
// contact details from allowed_emails — personnel data that must stay behind the
// admin boundary.  Manager-only callers (TradesPage) receive an empty directory
// and lose duplicate-detection; that is the intended security tradeoff.
app.get('/api/admin/phone-directory', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const out = { team: [], trades: [], customers: [] };

    // Team: users joined with allowed_emails metadata.
    try {
      const r = await pool.query(
        `SELECT u.id, u.email, u.first_name, u.last_name, ae.metadata
           FROM users u
           LEFT JOIN allowed_emails ae ON LOWER(u.email) = ae.email
           WHERE u.onboarding_status != 'archived'
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
          WHERE u.id IS NULL AND ae.archived_at IS NULL`
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
      logger.error({ err: e.message }, 'phone-directory: team lookup failed:');
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
      logger.error({ err: e.message }, 'phone-directory: trades lookup failed:');
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
        logger.error({ err: e.message }, 'phone-directory: customer lookup failed:');
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
  const client = await _tradesPool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, company_name, trade_type, areas_served FROM trade_companies ORDER BY id`
    );

    const migrated  = [];
    const skipped   = [];
    const unmatched = [];

    if (!dryRun) await client.query('BEGIN');

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
        await client.query(
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

    if (!dryRun) await client.query('COMMIT');
    res.json({ dry_run: dryRun, migrated, skipped, unmatched });
  } catch (e) {
    if (!dryRun) await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── Ideas & Feedback ──────────────────────────────────────────────────────────
app.get('/ideas', isAuthenticated, (_req, res) => res.render('ideas', { title: 'Ideas · Harry Wardrobes', description: 'Submit and explore ideas, feature requests, and feedback for your Harry Wardrobes workspace.' }));


app.get('/api/ideas', async (req, res) => {
  try {
    const userId = req.user?.claims?.sub || null;
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
    logger.error({ err: e.message }, 'GET /api/ideas error:');
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
    logger.error({ err: e.message }, 'POST /api/ideas error:');
    res.status(500).json({ error: 'Could not save idea.' });
  }
});

app.post('/api/ideas/:id/vote', isAuthenticated, async (req, res) => {
  const ideaId = parseInt(req.params.id, 10);
  if (isNaN(ideaId)) return res.status(400).json({ error: 'Invalid idea id.' });
  const userId = req.user?.claims?.sub;
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
    logger.error({ err: e.message }, 'POST /api/ideas/:id/vote error:');
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
    logger.error({ err: e.message }, 'GET /api/ideas/:id/comments error:');
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
    logger.error({ err: e.message }, 'POST /api/ideas/:id/comments error:');
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
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err: e.message }, 'DELETE /api/ideas/:id error:');
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
    await client.query('COMMIT');
    res.json({ id: after.id, body: after.body, edited_at: after.edited_at });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err: e.message }, 'PATCH /api/ideas/:id error:');
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
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err: e.message }, 'DELETE /api/ideas/:id/comments/:commentId error:');
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
    await client.query('COMMIT');
    res.json({ id: after.id, body: after.body, edited_at: after.edited_at });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err: e.message }, 'PATCH /api/ideas/:id/comments/:commentId error:');
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
  if (!getCredential('access_token')) return;
  const { rows } = await pool.query(
    'SELECT key, label, sort_order FROM lead_status_config WHERE is_null_row IS NOT TRUE ORDER BY sort_order ASC, key ASC'
  );
  const options = rows.map((r, i) => ({
    value:        r.key,
    label:        r.label,
    displayOrder: i,
    hidden:       false,
  }));
  await axios.patch(
    `${HS}/crm/v3/properties/contacts/hs_lead_status`,
    { options },
    { headers: getHubSpotHeaders() }
  );
}

const LEAD_STATUS_STAGE_KEYS = [
  'SALES', 'DESIGN_VISIT', 'SURVEY', 'ORDER', 'WORKSHOP',
  'PACKING', 'DELIVERY', 'INSTALLATION', 'AFTERCARE', 'CUSTOMER_SERVICE',
];
const LEAD_STATUS_STAGE_SET = new Set(LEAD_STATUS_STAGE_KEYS);

const LEAD_STATUS_STAGE_SEEDS = {
  SALES: ['FORM_SUBMISSION', 'CONTACTED', 'ATTEMPTED_TO_CONTACT', 'IN_PROGRESS', 'AWAITING_PHOTOS', 'ROUGH_ESTIMATE', 'UNQUALIFIED', 'NOT_SUITABLE', 'BAD_TIMING', 'NO_RESPONSE', 'DECLINED_DEAL'],
  DESIGN_VISIT: ['DESIGN_SCHEDULED', 'DESIGN_IN_PROGRESS', 'DESIGN_SENT', 'DESIGN_ACCEPTED'],
  SURVEY: ['DEPOSIT_INVOICE', 'SURVEY_SCHEDULED', 'SURVEY_IN_PROGRESS', 'SURVEY_SENT', 'READY_FOR_PRODUCTION'],
};

async function ensureLeadStatusTable() {
  // Schema (lead_status_config + columns) is created by migrations. This boot
  // step seeds data: the null-status sentinel, stage
  // backfill for known seed keys, and initial statuses from HubSpot or defaults.

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
  if (getCredential('access_token')) {
    try {
      const r = await axios.get(
        `${HS}/crm/v3/properties/contacts/hs_lead_status`,
        { headers: getHubSpotHeaders() }
      );
      const options = (r.data.options || []).filter(o => !o.hidden);
      if (options.length > 0) {
        // Preserve any existing excluded_from_sales preferences; default UNQUALIFIED to true.
        const EXCLUDED_DEFAULTS = new Set(['UNQUALIFIED', 'NOT_SUITABLE', 'DECLINED_DEAL']);
        for (let i = 0; i < options.length; i++) {
          const o = options[i];
          const key = (o.value || '').toUpperCase();
          await pool.query(
            'INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales) VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO NOTHING',
            [key, o.label || key, o.displayOrder ?? i, EXCLUDED_DEFAULTS.has(key)]
          );
        }
        logger.info(`  Lead status config seeded from HubSpot (${options.length} statuses)`);
        return;
      }
    } catch (e) {
      logger.warn({ err: e.response?.data?.message || e.message }, '  Could not fetch hs_lead_status from HubSpot, falling back to defaults:');
    }
  }

  // ── Fallback: hardcoded defaults ───────────────────────────────────────────
  const DEFAULT_LEAD_STATUSES = [
    { key: 'NEW',                  label: 'New',                  sort_order: 0,  excluded_from_sales: false },
    { key: 'OPEN',                 label: 'Open',                 sort_order: 1,  excluded_from_sales: false },
    { key: 'IN_PROGRESS',          label: 'In Progress',          sort_order: 2,  excluded_from_sales: false },
    { key: 'OPEN_DEAL',            label: 'Open Deal',            sort_order: 3,  excluded_from_sales: false },
    { key: 'DEPOSIT_INVOICE',      label: 'Deposit Invoice',      sort_order: 4,  excluded_from_sales: false },
    { key: 'VISIT_SCHEDULED',      label: 'Visit Scheduled',      sort_order: 5,  excluded_from_sales: false },
    { key: 'ATTEMPTED_TO_CONTACT', label: 'Attempted to Contact', sort_order: 6,  excluded_from_sales: false },
    { key: 'UNQUALIFIED',          label: 'Unqualified',          sort_order: 7,  excluded_from_sales: true  },
    { key: 'BAD_TIMING',           label: 'Bad Timing',           sort_order: 8,  excluded_from_sales: false },
    { key: 'DECLINED_DEAL',        label: 'Declined Deal',        sort_order: 100, excluded_from_sales: true  },
  ];
  for (const s of DEFAULT_LEAD_STATUSES) {
    await pool.query(
      'INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales) VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO NOTHING',
      [s.key, s.label, s.sort_order, s.excluded_from_sales]
    );
  }
  logger.info('  Lead status config seeded with defaults (no HubSpot token)');
}

// Keys hardcoded in mutation paths across server.js, customer-info.js, photo-reviews.js.
// If an admin renames or deletes one of these in lead_status_config the corresponding
// HubSpot PATCH will silently send an INVALID_OPTION value.  This boot-time check
// logs a warning for each missing key so the problem is surfaced early.
//
// MAINTENANCE CONTRACT: whenever a new hardcoded hs_lead_status literal is added
// to a HubSpot mutation path anywhere in the codebase, add a matching entry here.
// The `source` field should identify the file and call-site so the warning message
// points maintainers directly to the affected code.
const HARDCODED_LEAD_STATUS_KEYS = [
  { key: 'OPEN_DEAL',           source: 'server.js — contact create',                                                   featureLabel: 'Creating new contacts' },
  { key: 'SURVEY_SCHEDULED',    source: 'server.js — arrange-visit OUTCOME_MAP',                                        featureLabel: 'Booking survey visits' },
  { key: 'DESIGN_SCHEDULED',    source: 'server.js — arrange-visit OUTCOME_MAP (booked), design-visit-followup outcome', featureLabel: 'Booking / confirming design visits' },
  { key: 'DESIGN_INVITED',      source: 'server.js — arrange-visit email_sent (design), design-visit-followup resend',   featureLabel: 'Sending design visit invite' },
  { key: 'NOT_SUITABLE',        source: 'server.js — arrange-visit OUTCOME_MAP, photo-reviews.js, design-visit-followup not_proceeding', featureLabel: 'Marking visits as not suitable & photo review outcomes' },
  { key: 'AWAITING_PHOTOS',     source: 'customer-info.js — photo submission',                                          featureLabel: 'Customer photo submission' },
  { key: 'ROUGH_ESTIMATE',      source: 'photo-reviews.js — review outcome',                                            featureLabel: 'Photo review outcomes' },
];

async function checkHardcodedLeadStatusKeys() {
  const { rows } = await pool.query(
    `SELECT key FROM lead_status_config WHERE is_null_row IS NOT TRUE`
  );
  const existing = new Set(rows.map(r => r.key));
  for (const { key, source } of HARDCODED_LEAD_STATUS_KEYS) {
    if (!existing.has(key)) {
      logger.warn(
        `  [lead-status] Hardcoded key "${key}" (used in ${source}) is missing from ` +
        `lead_status_config. HubSpot patches using this key will be rejected with INVALID_OPTION.`
      );
    }
  }
}

// Public authenticated: full ordered list for all frontend pages
app.get('/api/lead-statuses', isAuthenticated, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT key, label, sort_order, excluded_from_sales, stage, is_null_row FROM lead_status_config ORDER BY sort_order ASC, key ASC'
    );
    res.set('Cache-Control', 'no-store');
    res.json(rows);
  } catch (e) {
    logger.error({ err: e.message }, 'GET /api/lead-statuses error:');
    res.status(500).json({ error: 'Could not load lead statuses.' });
  }
});

// Admin: full list (same as public for now but separate for future extension)
app.get('/api/admin/lead-statuses', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT key, label, sort_order, excluded_from_sales, stage, is_null_row FROM lead_status_config ORDER BY sort_order ASC, key ASC'
    );
    res.json(rows);
  } catch (e) {
    logger.error({ err: e.message }, 'GET /api/admin/lead-statuses error:');
    res.status(500).json({ error: 'Could not load lead statuses.' });
  }
});

// Admin: pipeline configuration health — which hardcoded keys are missing from lead_status_config
app.get('/api/admin/lead-status-health', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT key FROM lead_status_config WHERE is_null_row IS NOT TRUE`
    );
    const existing = new Set(rows.map(r => r.key));
    const missing = HARDCODED_LEAD_STATUS_KEYS.filter(({ key }) => !existing.has(key));
    res.set('Cache-Control', 'no-store');
    res.json({ ok: missing.length === 0, missing, required: HARDCODED_LEAD_STATUS_KEYS });
  } catch (e) {
    logger.error({ err: e.message }, 'GET /api/admin/lead-status-health error:');
    res.status(500).json({ error: 'Could not check lead status health.' });
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
  try {
    const { rows: maxRows } = await pool.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM lead_status_config');
    const next = maxRows[0].next;
    const { rows } = await pool.query(
      'INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales, stage) VALUES ($1, $2, $3, FALSE, $4) RETURNING *',
      [key, label, next, stage]
    );
    invalidateLeadStatusCache();
    _invalidateLeadStatusCountsCache();
    _invalidateOpenLeadsCache();
    _invalidateProjectContactsCache();
    res.status(201).json(rows[0]);
    const _lscSseMsg = `data: ${JSON.stringify({ type: 'lead_statuses_changed' })}\n\n`;
    for (const client of _hsWebhookSseClients) {
      try { client.write(_lscSseMsg); } catch { _hsWebhookSseClients.delete(client); }
    }
    syncLeadStatusesToHubSpot().catch(e => logger.warn({ err: e.response?.data?.message || e.message }, 'HubSpot lead-status sync failed:'));
    // If the new status was created with a stage, seed its label row immediately
    // so the Card Actions tab shows it without a server restart.
    if (stage) {
      seedStageActionLabelsDefaults().catch(e => logger.warn({ err: e.message }, 'stage-action-labels seed after lead-status create failed:'));
    }
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'A status with that key already exists.' });
    }
    logger.error({ err: e.message }, 'POST /api/admin/lead-statuses error:');
    res.status(500).json({ error: 'Could not add lead status.' });
  }
});

// Admin: update label / sort_order / excluded_from_sales / key (key rename for empty-key rows)
app.patch('/api/admin/lead-statuses/:key', isAuthenticated, requireAdmin, async (req, res) => {
  const key = req.params.key;
  const { label, sort_order, excluded_from_sales, new_key, stage } = req.body || {};
  if (label !== undefined && !String(label).trim()) return res.status(400).json({ error: 'label cannot be empty.' });
  if (new_key !== undefined) {
    const nk = String(new_key).trim().toUpperCase();
    if (!nk || !/^[A-Z0-9_]+$/.test(nk)) return res.status(400).json({ error: 'new_key may only contain uppercase letters, digits, and underscores.' });
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

    // For the null sentinel row, only the label may be changed.
    if (cur.is_null_row) {
      const newLabel = label !== undefined ? String(label).trim() : cur.label;
      if (!newLabel) return res.status(400).json({ error: 'label cannot be empty.' });
      const { rows } = await pool.query(
        'UPDATE lead_status_config SET label = $1 WHERE key = $2 RETURNING *',
        [newLabel, key]
      );
      invalidateLeadStatusCache();
      const _lscSseMsg = `data: ${JSON.stringify({ type: 'lead_statuses_changed' })}\n\n`;
      for (const client of _hsWebhookSseClients) {
        try { client.write(_lscSseMsg); } catch { _hsWebhookSseClients.delete(client); }
      }
      return res.json(rows[0]);
    }

    const newLabel    = label     !== undefined ? String(label).trim()      : cur.label;
    const newOrder    = sort_order !== undefined ? parseInt(sort_order, 10) : cur.sort_order;
    const newExcluded = excluded_from_sales !== undefined ? !!excluded_from_sales : cur.excluded_from_sales;
    const finalKey    = new_key   !== undefined ? String(new_key).trim().toUpperCase() : key;
    const newStage    = stageProvided ? stageValue : cur.stage;
    const { rows } = await pool.query(
      'UPDATE lead_status_config SET key = $1, label = $2, sort_order = $3, excluded_from_sales = $4, stage = $5 WHERE key = $6 RETURNING *',
      [finalKey, newLabel, newOrder, newExcluded, newStage, key]
    );
    invalidateLeadStatusCache();
    _invalidateLeadStatusCountsCache();
    _invalidateOpenLeadsCache();
    _invalidateProjectContactsCache();
    res.json(rows[0]);
    const _lscSseMsg = `data: ${JSON.stringify({ type: 'lead_statuses_changed' })}\n\n`;
    for (const client of _hsWebhookSseClients) {
      try { client.write(_lscSseMsg); } catch { _hsWebhookSseClients.delete(client); }
    }
    syncLeadStatusesToHubSpot().catch(e => logger.warn({ err: e.response?.data?.message || e.message }, 'HubSpot lead-status sync failed:'));
    // If a stage was assigned or changed, ensure every lead status in that stage
    // has a stage_action_labels row so the Card Actions tab shows it immediately
    // without requiring a server restart.
    if (stageProvided && newStage) {
      seedStageActionLabelsDefaults().catch(e => logger.warn({ err: e.message }, 'stage-action-labels seed after stage assignment failed:'));
    }
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'A status with that key already exists.' });
    }
    logger.error({ err: e.message }, 'PATCH /api/admin/lead-statuses/:key error:');
    res.status(500).json({ error: 'Could not update lead status.' });
  }
});

// Admin: atomically swap the sort_order of two lead statuses.
//
// A naive reorder that PATCHes each row's sort_order independently fails: the
// partial unique index `lead_status_config_sort_order_uniq` rejects the
// transient state where both rows momentarily hold the same sort_order (raised
// as a 23505, previously surfaced as the misleading "A status with that key
// already exists"). We do the swap in a single transaction, parking one row at
// a temporary out-of-range sort_order so the unique index is never violated.
app.post('/api/admin/lead-statuses/reorder', isAuthenticated, requireAdmin, async (req, res) => {
  const a = String(req.body?.a ?? '').trim();
  const b = String(req.body?.b ?? '').trim();
  if (!a || !b) return res.status(400).json({ error: 'a and b keys are required.' });
  if (a === b) return res.status(400).json({ error: 'a and b must be different statuses.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock both rows to serialise concurrent reorders.
    const { rows } = await client.query(
      'SELECT key, sort_order, is_null_row FROM lead_status_config WHERE key IN ($1, $2) FOR UPDATE',
      [a, b]
    );
    const rowA = rows.find(r => r.key === a);
    const rowB = rows.find(r => r.key === b);
    if (!rowA || !rowB) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Status not found.' });
    }
    if (rowA.is_null_row || rowB.is_null_row) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'The null status row cannot be reordered.' });
    }
    // Park A at a temporary, guaranteed-free sort_order, then place B and A.
    const { rows: minRows } = await client.query(
      'SELECT COALESCE(MIN(sort_order), 0) - 1 AS tmp FROM lead_status_config'
    );
    const tmp = minRows[0].tmp;
    await client.query('UPDATE lead_status_config SET sort_order = $1 WHERE key = $2', [tmp, a]);
    await client.query('UPDATE lead_status_config SET sort_order = $1 WHERE key = $2', [rowA.sort_order, b]);
    await client.query('UPDATE lead_status_config SET sort_order = $1 WHERE key = $2', [rowB.sort_order, a]);
    await client.query('COMMIT');
    invalidateLeadStatusCache();
    _invalidateLeadStatusCountsCache();
    _invalidateOpenLeadsCache();
    _invalidateProjectContactsCache();
    res.json({ ok: true });
    const _lscSseMsg = `data: ${JSON.stringify({ type: 'lead_statuses_changed' })}\n\n`;
    for (const sseClient of _hsWebhookSseClients) {
      try { sseClient.write(_lscSseMsg); } catch { _hsWebhookSseClients.delete(sseClient); }
    }
    syncLeadStatusesToHubSpot().catch(e => logger.warn({ err: e.response?.data?.message || e.message }, 'HubSpot lead-status sync failed:'));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err: e.message }, 'POST /api/admin/lead-statuses/reorder error:');
    res.status(500).json({ error: 'Could not reorder lead statuses.' });
  } finally {
    client.release();
  }
});

// Admin: fetch hs_lead_status property options directly from HubSpot
app.get('/api/admin/hubspot-lead-statuses', isAuthenticated, requireAdmin, requireHubspotToken, async (req, res) => {
  try {
    const url = `${HS}/crm/v3/properties/contacts/hs_lead_status`;
    const r = await hubspotRequestWithRetry('get', url, null);
    const options = (r.data?.options || []).map(o => ({
      value:        o.value,
      label:        o.label,
      displayOrder: o.displayOrder ?? 0,
      hidden:       o.hidden ?? false,
    }));
    res.json({ options });
  } catch (e) {
    const status = e.response?.status || 502;
    logger.error({ err: e.response?.data?.message || e.message }, 'GET /api/admin/hubspot-lead-statuses error:');
    res.status(status).json({ error: e.response?.data?.message || 'Could not fetch HubSpot lead statuses.' });
  }
});

// Admin: import (upsert) hs_lead_status options into lead_status_config
app.post('/api/admin/hubspot-lead-statuses/import', isAuthenticated, requireAdmin, async (req, res) => {
  const raw = req.body?.options;
  if (!Array.isArray(raw)) return res.status(400).json({ error: 'options array is required.' });
  const options = raw.filter(o => !o.hidden);
  if (!options.length) return res.json({ upserted: 0, skipped: 0, syncError: false });
  let upserted = 0, skipped = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const opt of options) {
      const key        = String(opt.value || '').trim().toUpperCase();
      const label      = String(opt.label || '').trim();
      const sort_order = typeof opt.displayOrder === 'number' ? opt.displayOrder : 0;
      if (!key || !label) { skipped++; continue; }
      const result = await client.query(
        `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales)
         VALUES ($1, $2, $3, FALSE)
         ON CONFLICT (key) DO UPDATE SET sort_order = EXCLUDED.sort_order`,
        [key, label, sort_order]
      );
      if (result.rowCount > 0) upserted++;
    }
    await client.query('COMMIT');
    invalidateLeadStatusCache();
    _invalidateLeadStatusCountsCache();
    _invalidateOpenLeadsCache();
    _invalidateProjectContactsCache();
    let syncError = false;
    try {
      await Promise.race([
        syncLeadStatusesToHubSpot(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('sync timeout')), 10000)),
      ]);
    } catch (e) {
      syncError = true;
      logger.warn({ err: e.response?.data?.message || e.message }, 'HubSpot lead-status sync failed after import:');
    }
    res.json({ upserted, skipped, syncError });
  } catch (e) {
    await client.query('ROLLBACK');
    logger.error({ err: e.message }, 'POST /api/admin/hubspot-lead-statuses/import error:');
    res.status(500).json({ error: 'Could not import lead statuses.' });
  } finally {
    client.release();
  }
});

// ── Page filter config ────────────────────────────────────────────────────────
// Generic key/value config table for per-page defaults that admins can tune
// without a code deploy. Defaults are seeded on boot.

const PAGE_FILTER_CONFIG_DEFAULTS = {
  sales_staleness_days:              { value: 28,              label: 'Sales board — staleness cutoff (days)',       type: 'number', min: 1, max: 365 },
  sales_page_size:                   { value: 25,              label: 'Sales board — default page size',             type: 'number', min: 5, max: 100 },
  surveys_page_size:                 { value: 25,              label: 'Surveys board — default page size',           type: 'number', min: 5, max: 100 },
  customers_page_size:               { value: 25,              label: 'Customers list — default page size',          type: 'number', min: 5, max: 100 },
  surveys_hidden_substages_default:  { value: '[]',            label: 'Surveys board — hidden substages (JSON)',     type: 'json'                      },
  task_assignment_emails_enabled:    { value: 'true',          label: 'Task assignment — send email notifications',  type: 'string', allowedValues: ['true', 'false'] },
  task_reassignment_emails_enabled:  { value: 'true',          label: 'Task reassignment — send email notifications', type: 'string', allowedValues: ['true', 'false'] },
};

async function ensurePageFilterConfigTable() {
  // Schema created by migrations; this boot step seeds default rows.
  for (const [key, def] of Object.entries(PAGE_FILTER_CONFIG_DEFAULTS)) {
    await pool.query(
      `INSERT INTO page_filter_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [key, String(def.value)]
    );
  }
}

let _pageFilterConfigCache = null;
let _pageFilterConfigCachedAt = 0;
const PAGE_FILTER_CONFIG_TTL_MS = 60_000;

function _invalidatePageFilterConfig() {
  _pageFilterConfigCache = null;
  _pageFilterConfigCachedAt = 0;
}

async function getPageFilterConfig() {
  if (_pageFilterConfigCache && Date.now() - _pageFilterConfigCachedAt < PAGE_FILTER_CONFIG_TTL_MS) {
    return _pageFilterConfigCache;
  }
  const { rows } = await pool.query('SELECT key, value FROM page_filter_config');
  const config = {};
  for (const [key, def] of Object.entries(PAGE_FILTER_CONFIG_DEFAULTS)) {
    const row = rows.find(r => r.key === key);
    const raw = row ? row.value : String(def.value);
    config[key] = def.type === 'number' ? parseInt(raw, 10) : raw;
  }
  _pageFilterConfigCache = config;
  _pageFilterConfigCachedAt = Date.now();
  return config;
}

// GET /api/page-filter-config — public (authenticated) read of current values
// Returns a flat key→value map so pages can read their defaults without
// needing admin privilege. Only the numeric/string values are exposed; the
// metadata (label, min, max) lives in the admin endpoint below.
app.get('/api/page-filter-config', isAuthenticated, async (req, res) => {
  try {
    const config = await getPageFilterConfig();
    res.json(config);
  } catch (e) {
    logger.error({ err: e.message }, 'GET /api/page-filter-config error:');
    res.status(500).json({ error: 'Could not load page filter config.' });
  }
});

// GET /api/admin/page-filter-config — return all settings with metadata
app.get('/api/admin/page-filter-config', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const config = await getPageFilterConfig();
    const result = {};
    for (const [key, def] of Object.entries(PAGE_FILTER_CONFIG_DEFAULTS)) {
      result[key] = { ...def, currentValue: config[key] };
    }
    res.json(result);
  } catch (e) {
    logger.error({ err: e.message }, 'GET /api/admin/page-filter-config error:');
    res.status(500).json({ error: 'Could not load page filter config.' });
  }
});

// PATCH /api/admin/page-filter-config — update one or more settings
app.patch('/api/admin/page-filter-config', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const updates = req.body || {};
    const allowed = new Set(Object.keys(PAGE_FILTER_CONFIG_DEFAULTS));
    const results = {};
    for (const [key, val] of Object.entries(updates)) {
      if (!allowed.has(key)) continue;
      const def = PAGE_FILTER_CONFIG_DEFAULTS[key];
      let coerced;
      if (def.type === 'number') {
        coerced = parseInt(val, 10);
        if (!Number.isFinite(coerced) || coerced < (def.min ?? 1) || coerced > (def.max ?? 999)) {
          return res.status(400).json({ error: `${key}: value out of range (${def.min}–${def.max}).` });
        }
      } else {
        coerced = String(val);
        if (def.type === 'json') {
          try { JSON.parse(coerced); } catch {
            return res.status(400).json({ error: `${key}: invalid JSON.` });
          }
        } else if (def.allowedValues && !def.allowedValues.includes(coerced)) {
          return res.status(400).json({ error: `${key}: must be one of ${def.allowedValues.join(', ')}.` });
        }
      }
      await pool.query(
        `INSERT INTO page_filter_config (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, String(coerced)]
      );
      results[key] = coerced;
    }
    _invalidatePageFilterConfig();
    res.json(results);
  } catch (e) {
    logger.error({ err: e.message }, 'PATCH /api/admin/page-filter-config error:');
    res.status(500).json({ error: 'Could not update page filter config.' });
  }
});

// ── Email templates (admin-editable) ─────────────────────────────────────────
// Merge a DB row with its TEMPLATE_DEFS metadata (advertised variables, label).
function _extractVarsFromString(str) {
  const matches = [...(str || '').matchAll(/\{\{(\w+)\}\}/g)];
  return [...new Set(matches.map((m) => m[1]))];
}

function _emailTemplateWithMeta(row) {
  const def = TEMPLATE_DEFS[row.key] || {};
  const defaultUsed = new Set([
    ..._extractVarsFromString(def.subject),
    ..._extractVarsFromString(def.body_text),
    ..._extractVarsFromString(def.body_html),
  ]);
  return {
    key:                  row.key,
    label:                def.label || row.key,
    description:          def.description || '',
    audience:             def.audience || null,
    variables:            def.variables || [],
    variableDescriptions: def.variableDescriptions || {},
    defaultVariablesUsed: [...defaultUsed],
    subject:              row.subject,
    body_text:            row.body_text,
    body_html:            row.body_html,
    footer_text:          row.footer_text,
    updated_at:           row.updated_at,
    updated_by:           row.updated_by,
  };
}

// ── Email signature helpers ───────────────────────────────────────────────────

// Thin wrappers that bind pool so callers don't need to pass it.
const _getEmailCompanyName  = () => getEmailCompanyName(pool);
const _buildSenderSignature = (userId) => buildSenderSignature(pool, userId);

// GET /api/admin/settings/company-name
app.get('/api/admin/settings/company-name', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const companyName = await _getEmailCompanyName();
    res.json({ company_name: companyName });
  } catch (e) {
    logger.error({ err: e.message }, 'GET /api/admin/settings/company-name error:');
    res.status(500).json({ error: 'Could not load company name.' });
  }
});

// PATCH /api/admin/settings/company-name
app.patch('/api/admin/settings/company-name', isAuthenticated, requireAdmin, async (req, res) => {
  const companyName = (req.body?.company_name ?? '').toString().trim().slice(0, 200);
  try {
    await pool.query(
      `INSERT INTO admin_settings (key, value, updated_at)
       VALUES ('email_company_name', to_jsonb($1::text), NOW())
       ON CONFLICT (key) DO UPDATE SET value = to_jsonb($1::text), updated_at = NOW()`,
      [companyName]
    );
    await logAdminAction(req.user?.email, 'update_email_company_name', null, `company_name="${companyName}"`);
    res.json({ company_name: companyName });
  } catch (e) {
    logger.error({ err: e.message }, 'PATCH /api/admin/settings/company-name error:');
    res.status(500).json({ error: 'Could not save company name.' });
  }
});

// GET /api/users/me/email-signature — returns the current user's signature { text, html }.
app.get('/api/users/me/email-signature', isAuthenticated, async (req, res) => {
  // req.user has no top-level `id` — the canonical user id is claims.sub
  // (see isAuthenticated in auth.js). Reading req.user?.id always returned
  // undefined here, 401-ing every authenticated caller.
  const userId = req.user?.claims?.sub;
  if (!userId) return res.status(401).json({ error: 'Not authenticated.' });
  try {
    const sig = await _buildSenderSignature(userId);
    res.json(sig);
  } catch (e) {
    logger.error({ err: e.message }, 'GET /api/users/me/email-signature error:');
    res.status(500).json({ error: 'Could not build signature.' });
  }
});

// GET /api/admin/email-templates — all templates ordered by key.
app.get('/api/admin/email-templates', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT key, subject, body_text, body_html, footer_text, updated_at, updated_by
       FROM email_templates ORDER BY key`
    );
    res.json(r.rows.map(_emailTemplateWithMeta));
  } catch (e) {
    logger.error({ err: e.message }, 'GET /api/admin/email-templates error:');
    res.status(500).json({ error: 'Could not load email templates.' });
  }
});

// GET /api/admin/email-templates/:key — one template (404 if missing).
app.get('/api/admin/email-templates/:key', isAuthenticated, requireAdmin, async (req, res) => {
  const { key } = req.params;
  if (!TEMPLATE_KEYS.includes(key)) {
    return res.status(404).json({ error: 'Unknown email template key.' });
  }
  try {
    const r = await pool.query(
      `SELECT key, subject, body_text, body_html, footer_text, updated_at, updated_by
       FROM email_templates WHERE key = $1 LIMIT 1`,
      [key]
    );
    if (!r.rows.length) {
      return res.status(404).json({ error: 'Email template not found.' });
    }
    res.json(_emailTemplateWithMeta(r.rows[0]));
  } catch (e) {
    logger.error({ err: e.message }, 'GET /api/admin/email-templates/:key error:');
    res.status(500).json({ error: 'Could not load email template.' });
  }
});

// PATCH /api/admin/email-templates/:key — upsert subject/body/footer, audit-log.
app.patch('/api/admin/email-templates/:key', isAuthenticated, requireAdmin, async (req, res) => {
  const { key } = req.params;
  if (!TEMPLATE_KEYS.includes(key)) {
    return res.status(404).json({ error: 'Unknown email template key.' });
  }
  const { subject, body_text, body_html, footer_text } = req.body || {};
  if (typeof subject !== 'string' || !subject.trim()) {
    return res.status(400).json({ error: 'Subject is required.' });
  }
  const adminEmail = req.user?.email || req.user?.claims?.email || 'unknown';
  try {
    const r = await pool.query(
      `INSERT INTO email_templates (key, subject, body_text, body_html, footer_text, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6)
       ON CONFLICT (key) DO UPDATE SET
         subject     = EXCLUDED.subject,
         body_text   = EXCLUDED.body_text,
         body_html   = EXCLUDED.body_html,
         footer_text = EXCLUDED.footer_text,
         updated_at  = NOW(),
         updated_by  = EXCLUDED.updated_by
       RETURNING key, subject, body_text, body_html, footer_text, updated_at, updated_by`,
      [
        key,
        subject.trim(),
        typeof body_text === 'string' ? body_text : '',
        typeof body_html === 'string' ? body_html : '',
        typeof footer_text === 'string' ? footer_text : '',
        adminEmail,
      ]
    );
    invalidateEmailTemplate(key);
    await logAdminAction(adminEmail, 'update_email_template', null, `Updated email template: ${key}`);
    res.json(_emailTemplateWithMeta(r.rows[0]));
  } catch (e) {
    logger.error({ err: e.message }, 'PATCH /api/admin/email-templates/:key error:');
    res.status(500).json({ error: 'Could not update email template.' });
  }
});

// POST /api/email-templates/render — render a stored template with caller-supplied
// variable values and return { subject, body_text }. Available to all authenticated
// users (not admin-only) so in-product UIs can pre-populate editable email fields
// from the admin-customisable template rather than a hardcoded client-side string.
app.post('/api/email-templates/render', isAuthenticated, async (req, res) => {
  const { key, vars, body: customBody, subject: customSubject } = req.body || {};
  if (!TEMPLATE_KEYS.includes(key)) {
    return res.status(404).json({ error: 'Unknown email template key.' });
  }
  try {
    const template = await getEmailTemplate(key);
    if (!template) return res.status(404).json({ error: 'Template not found.' });
    const customBodyHtml = typeof customBody === 'string'
      ? customBody.split('\n').map(l => l.trim() === '' ? '' : `<p>${escapeHtml(l)}</p>`).join('')
      : null;
    const effectiveTemplate = (typeof customBody === 'string' || typeof customSubject === 'string') ? {
      ...template,
      ...(typeof customBody    === 'string' ? { body_text: customBody, body_html: customBodyHtml } : {}),
      ...(typeof customSubject === 'string' ? { subject:   customSubject                         } : {}),
    } : template;
    const rendered = renderEmail(effectiveTemplate, { textVars: vars || {}, htmlVars: vars || {} });
    res.json({ subject: rendered.subject, body_text: rendered.text, html: rendered.html });
  } catch (e) {
    logger.error({ err: e.message }, 'POST /api/email-templates/render error:');
    res.status(500).json({ error: 'Could not render template.' });
  }
});

// POST /api/admin/email-templates/:key/preview — render draft fields with sample
// variable values and return { subject, text, html } without saving anything.
// Mirrors the exact send-path semantics: when body_html is empty the html field
// is auto-generated from the rendered plain text (same line-wrapping logic used
// by sendReviewEmail in photo-reviews.js) so the preview matches real emails.
app.post('/api/admin/email-templates/:key/preview', isAuthenticated, requireAdmin, async (req, res) => {
  const { key } = req.params;
  if (!TEMPLATE_KEYS.includes(key)) {
    return res.status(404).json({ error: 'Unknown email template key.' });
  }
  const { subject, body_text, body_html, footer_text } = req.body || {};
  const sampleVars = SAMPLE_VARS[key] || {};
  const template = {
    subject:     typeof subject     === 'string' ? subject     : '',
    body_text:   typeof body_text   === 'string' ? body_text   : '',
    body_html:   typeof body_html   === 'string' ? body_html   : '',
    footer_text: typeof footer_text === 'string' ? footer_text : '',
  };
  // For the HTML vars we HTML-escape the sample values since they are plain
  // text placeholders (not pre-rendered HTML). The footer is always escaped
  // inside renderEmail itself.
  const htmlVars = Object.fromEntries(
    Object.entries(sampleVars).map(([k, v]) => [k, escapeHtml(String(v))])
  );
  const rendered = renderEmail(template, { textVars: sampleVars, htmlVars });

  // When body_html is empty, the production send path (sendReviewEmail) derives
  // HTML from the rendered plain text by wrapping each non-blank line in <p>.
  // Replicate that here so the preview matches what the recipient actually sees.
  if (!template.body_html.trim()) {
    rendered.html = rendered.text
      .split('\n')
      .map(l => l.trim() === '' ? '' : `<p>${escapeHtml(l)}</p>`)
      .join('');
  }

  // For customer-facing templates, append a sample personal email signature
  // so the preview shows how the email will look when sent by a staff member.
  const def = TEMPLATE_DEFS[key];
  if (def?.audience === 'customer') {
    const companyName = await _getEmailCompanyName();
    const sampleUser  = { first_name: 'Jane', last_name: 'Smith', email: 'jane@example.com', job_role: 'Designer', phone: '07700 900456' };
    const sig = buildUserSignature(sampleUser, companyName);
    if (sig.html) rendered.html += sig.html;
    if (sig.text) rendered.text += '\n\n' + sig.text;
  }

  res.json(rendered);
});

// (substatus helper functions removed)

app.get('/api/admin/lead-statuses/:key/usage', isAuthenticated, requireAdmin, async (req, res) => {
  const key = req.params.key;
  try {
    const { rows: existing } = await pool.query(
      'SELECT key FROM lead_status_config WHERE key = $1 AND is_null_row IS NOT TRUE',
      [key]
    );
    if (!existing.length) return res.status(404).json({ error: 'Status not found.' });

    const token = process.env.HUBSPOT_TOKEN || process.env.HUBSPOT_ACCESS_TOKEN || '';
    if (!token) {
      return res.json({ count: null, hubspotAvailable: false });
    }

    const r = await hubspotSearchWithRetry({
      filterGroups: [{ filters: [{ propertyName: 'hs_lead_status', operator: 'EQ', value: key }] }],
      limit: 1,
    });
    res.set('Cache-Control', 'no-store');
    res.json({ count: r.data.total ?? 0, hubspotAvailable: true });
  } catch (e) {
    const status = e.response?.status;
    if (status === 401 || status === 403) {
      return res.json({ count: null, hubspotAvailable: false });
    }
    if (status === 429) {
      return res.status(429).json({ error: 'HubSpot rate limit reached — try again in a moment.' });
    }
    logger.error({ err: e.message }, 'GET /api/admin/lead-statuses/:key/usage error:');
    res.status(500).json({ error: 'Could not check usage.' });
  }
});

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
    const hardcoded = HARDCODED_LEAD_STATUS_KEYS.find(({ key: k }) => k === key);
    if (hardcoded) {
      const featurePart = hardcoded.featureLabel ? ` Required by: ${hardcoded.featureLabel}.` : '';
      return res.status(409).json({ error: `"${key}" is a pipeline-critical status and cannot be deleted.${featurePart}` });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM card_action_handler_bindings
          WHERE status_key = LOWER($1) AND status_key <> ''`,
        [key]
      );
      await client.query('DELETE FROM lead_status_config WHERE key = $1', [key]);
      await client.query(`
        UPDATE lead_status_config lsc
        SET sort_order = sub.new_order
        FROM (
          SELECT key,
                 ROW_NUMBER() OVER (ORDER BY sort_order ASC, key ASC) - 1 AS new_order
          FROM lead_status_config
          WHERE is_null_row IS NOT TRUE
        ) sub
        WHERE lsc.key = sub.key
      `);
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
    invalidateLeadStatusCache();
    _invalidateLeadStatusCountsCache();
    _invalidateOpenLeadsCache();
    _invalidateProjectContactsCache();
    res.json({ ok: true });
    const _lscSseMsg = `data: ${JSON.stringify({ type: 'lead_statuses_changed' })}\n\n`;
    for (const client of _hsWebhookSseClients) {
      try { client.write(_lscSseMsg); } catch { _hsWebhookSseClients.delete(client); }
    }
    syncLeadStatusesToHubSpot().catch(e => logger.warn({ err: e.response?.data?.message || e.message }, 'HubSpot lead-status sync failed:'));
  } catch (e) {
    logger.error({ err: e.message }, 'DELETE /api/admin/lead-statuses/:key error:');
    res.status(500).json({ error: 'Could not delete lead status.' });
  }
});

// ── Stage action labels (per stage_key × status_key) ─────────────────────────
// Bottom-strip "next action" label shown on Sales/Survey cards. Driven by
// (stage_key, status_key) so admins can customize per-substage call-to-action.
// status_key is lowercase to match the substageId values rendered on cards;
// '' (empty) is a valid key for "no substage / null status".
// Maps uppercase lead_status_config.stage → lowercase card stage key.
// Rule: lowercase + strip underscores (e.g. DESIGN_VISIT → designvisit, ORDER → order).
// Derived from LEAD_STATUS_STAGE_KEYS so adding a new stage there is the only change needed.
function _normToCardStageKey(stage) {
  return stage.toLowerCase().replace(/_/g, '');
}
const STAGE_ACTION_STAGE_MAP = Object.fromEntries(
  LEAD_STATUS_STAGE_KEYS.map(k => [k, _normToCardStageKey(k)])
);
const STAGE_ACTION_STAGE_KEYS = new Set(Object.values(STAGE_ACTION_STAGE_MAP));

// Hardcoded action-button label defaults for specific stage+status combinations.
// These override the LS display label so the button reads as an action ("Start
// Design Visit") rather than a status description ("Design Scheduled").
// Keys are "stageKey:statusKey" (both lowercase, stage with underscores removed).
// ON CONFLICT DO NOTHING in the seed means admin customisations always win.
const STAGE_ACTION_LABEL_DEFAULTS = {
  'designvisit:design_scheduled':   'Start Design Visit',
  'designvisit:design_in_progress': 'Continue Design Visit',
  'designvisit:design_sent':        'View Design Visit',
  'designvisit:design_accepted':    'View Design Visit',
};

// Seed one row per (card stage × lead status) combination so every card has an
// editable per-LS row in the admin Card-actions tab. Idempotent: only inserts
// rows that are missing, and never overwrites existing values (admin edits
// always win). An admin who wants to suppress a specific LS uses the
// "clear" UX in the admin tab, which PUTs an empty label rather than
// DELETEing the row — so existing-row-with-empty-label is preserved and a
// re-run of this seed will not resurrect it.
// For stages listed in STAGE_ACTION_LABEL_DEFAULTS, the hardcoded action-
// oriented label is used as the default; all other statuses fall back to the
// LS display label.
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
    const defaultKey = `${stageKey}:${statusKey}`;
    const label = STAGE_ACTION_LABEL_DEFAULTS[defaultKey] ?? String(row.label || statusKey);
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
    logger.error({ err: e.message }, 'GET /api/stage-action-labels error:');
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
    logger.error({ err: e.message }, 'GET /api/admin/stage-action-labels error:');
    res.status(500).json({ error: 'Could not load stage action labels.' });
  }
});

// Upsert one mapping. Body: { stage_key, status_key, label }
app.put('/api/admin/stage-action-labels', isAuthenticated, requireAdmin, async (req, res) => {
  const { stage_key, status_key, label } = _normaliseStageActionInput(
    req.body?.stage_key, req.body?.status_key, req.body?.label
  );
  const isGlobal = stage_key === GLOBAL_NULL_STAGE_KEY;
  if (!stage_key || (!isGlobal && !STAGE_ACTION_STAGE_KEYS.has(stage_key))) {
    return res.status(400).json({ error: 'stage_key must be a valid pipeline stage key.' });
  }
  // The __global__ sentinel only supports status_key='' (the "No lead status" row).
  if (isGlobal && status_key !== '') {
    return res.status(400).json({ error: 'The __global__ stage only supports an empty status_key.' });
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
    logger.error({ err: e.message }, 'PUT /api/admin/stage-action-labels error:');
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
  if (!stage_key || (stage_key !== GLOBAL_NULL_STAGE_KEY && !STAGE_ACTION_STAGE_KEYS.has(stage_key))) {
    return res.status(400).json({ error: 'Invalid stage_key.' });
  }
  try {
    await pool.query(
      'DELETE FROM stage_action_labels WHERE stage_key = $1 AND status_key = $2',
      [stage_key, status_key]
    );
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e.message }, 'DELETE /api/admin/stage-action-labels error:');
    res.status(500).json({ error: 'Could not delete stage action label.' });
  }
});

// ── hw_test_user HubSpot property ─────────────────────────────────────────────
// Registers a boolean contact property used to mark dev/test contacts.
// Provisioned in all environments when HUBSPOT_ACCESS_TOKEN is present.
// A 409 (already exists) is treated as success.
async function ensureHwTestUserProperty() {
  if (!getCredential('access_token')) return;
  try {
    await axios.get(
      `${HS}/crm/v3/properties/contacts/hw_test_user`,
      { headers: getHubSpotHeaders() }
    );
    return; // already exists
  } catch (e) {
    if (e.response?.status !== 404) {
      logger.warn({ err: e.response?.data?.message || e.message }, '  hw_test_user probe failed:');
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
        description: 'Marks a contact as a dev/test contact in Harry Wardrobes. When dev mode is enabled in the admin panel, only contacts with this flag are shown.',
        options: [
          { label: 'Yes', value: 'true',  displayOrder: 0, hidden: false },
          { label: 'No',  value: 'false', displayOrder: 1, hidden: false },
        ],
      },
      { headers: getHubSpotHeaders() }
    );
    logger.info('  Created HubSpot property: hw_test_user');
  } catch (e) {
    if (e.response?.status !== 409) {
      logger.warn({ err: e.response?.data?.message || e.message }, '  Could not create hw_test_user:');
    }
  }
}

// ── Admin: dev-mode flag ──────────────────────────────────────────────────────
// Reads / writes the admin-controlled dev-mode flag stored in app_settings.
// When dev mode is on, /api/contacts-all filters to hw_test_user === 'true'.

app.get('/api/admin/hubspot/dev-mode', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM app_settings WHERE key = 'dev_mode_enabled'`
    );
    const devMode = rows.length > 0 ? rows[0].value === 'true' : false;
    res.json({ devMode });
  } catch (e) {
    logger.error({ err: e.message }, 'GET /api/admin/hubspot/dev-mode error:');
    res.status(500).json({ error: 'Could not read dev-mode setting.' });
  }
});

app.post('/api/admin/hubspot/dev-mode', isAuthenticated, requireAdmin, async (req, res) => {
  const { devMode } = req.body || {};
  if (typeof devMode !== 'boolean') {
    return res.status(400).json({ error: '`devMode` must be a boolean.' });
  }
  try {
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('dev_mode_enabled', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [devMode ? 'true' : 'false']
    );
    _invalidateContactsConfigCache();
    const adminEmail = req.user?.email || 'unknown';
    await logAdminAction(adminEmail, 'set_dev_mode', null, `devMode=${devMode}`);
    res.json({ ok: true, devMode });
  } catch (e) {
    logger.error({ err: e.message }, 'POST /api/admin/hubspot/dev-mode error:');
    res.status(500).json({ error: 'Could not save dev-mode setting.' });
  }
});

// ── Admin: priority-active-days setting ──────────────────────────────────────
// Reads / writes the admin-controlled priority-sort active window stored in
// app_settings.  When "Priority first" is active and there is no search query,
// contacts not modified within this many days are hidden from the list.

app.get('/api/admin/hubspot/priority-active-days', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM app_settings WHERE key = 'priority_active_days'`
    );
    const value = rows.length > 0 ? parseInt(rows[0].value, 10) : 60;
    res.json({ value: isNaN(value) ? 60 : value });
  } catch (e) {
    logger.error({ err: e.message }, 'GET /api/admin/hubspot/priority-active-days error:');
    res.status(500).json({ error: 'Could not read priority-active-days setting.' });
  }
});

app.post('/api/admin/hubspot/priority-active-days', isAuthenticated, requireAdmin, async (req, res) => {
  const { value } = req.body || {};
  const parsed = typeof value === 'number' ? value : parseInt(value, 10);
  if (isNaN(parsed) || parsed < 1 || parsed > 3650) {
    return res.status(400).json({ error: '`value` must be a whole number between 1 and 3650.' });
  }
  try {
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('priority_active_days', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [String(parsed)]
    );
    _invalidateContactsConfigCache();
    const adminEmail = req.user?.email || 'unknown';
    await logAdminAction(adminEmail, 'set_priority_active_days', null, `value=${parsed}`);
    res.json({ ok: true, value: parsed });
  } catch (e) {
    logger.error({ err: e.message }, 'POST /api/admin/hubspot/priority-active-days error:');
    res.status(500).json({ error: 'Could not save priority-active-days setting.' });
  }
});

// Returns whether the server is running in a non-production environment.
// Used by the DevEnvironmentPage cheatsheet to show the rename reference table.
app.get('/api/admin/server-env', isAuthenticated, requireAdmin, (_req, res) => {
  res.json({ isDevelopment: process.env.NODE_ENV !== 'production' });
});

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

// ── Dev-only: expire the project-contacts fresh cache ────────────────────────
// Mirrors the open-leads bust endpoint. Sets fetchedAt = 0 so the TTL check
// fails on the next request without clearing the cached data (preserving the
// stale-fallback path). Only available when NODE_ENV !== 'production'.
app.post('/api/admin/test/bust-project-contacts-cache', isAuthenticated, requireAdmin, (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  if (_projectContactsCache) _projectContactsCache.fetchedAt = 0;
  res.json({ ok: true, hadCache: _projectContactsCache !== null });
});

// ── Card action handlers ─────────────────────────────────────────────────────
// Admins can attach an interactive "handler" to a card action label. Built-in
// handler types:
//   • schedule_visit — click opens a date/time picker; on submit a Google
//     Calendar event is created via POST /api/events. Visit type (design,
//     survey, or other) is required via config.visitType.
//   • summarise_phone_call — click opens a textarea modal; on submit a HubSpot
//     note is created against the active contact, then the UI offers to draft
//     a follow-up email.
//
// A handler is bound to a (stage_key, status_key) pair.
// Each target slot can hold at most one handler.
// Per-type config validators. The set of valid handler types is derived from
// the keys of this map, so adding a new handler type here automatically adds
// it to CARD_ACTION_HANDLER_TYPES — the two cannot drift out of sync.
const CARD_ACTION_HANDLER_CONFIG_VALIDATORS = {
  schedule_visit(cfg) {
    const VALID_VISIT_TYPES = ['design', 'survey', 'other'];
    const vt = String(cfg.visitType || '').toLowerCase();
    if (!VALID_VISIT_TYPES.includes(vt)) {
      return { error: `visitType is required and must be one of: ${VALID_VISIT_TYPES.join(', ')}.` };
    }
    const out = { visitType: vt };
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
    if (cfg.termsAndConditions !== undefined) {
      const v = String(cfg.termsAndConditions || '');
      if (v.length > 4000) return { error: 'termsAndConditions must be 4000 characters or fewer.' };
      out.termsAndConditions = v;
    }
    return { value: out };
  },
  start_survey_visit(cfg) {
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
    if (cfg.termsAndConditions !== undefined) {
      const v = String(cfg.termsAndConditions || '');
      if (v.length > 4000) return { error: 'termsAndConditions must be 4000 characters or fewer.' };
      out.termsAndConditions = v;
    }
    return { value: out };
  },
  // No required config keys — the form link and email are generated at send time.
  upload_photos_and_info(_cfg) {
    return { value: {} };
  },
  // No required config keys — opens the review drawer which fetches submission at open time.
  review_customer_photos(_cfg) {
    return { value: {} };
  },
  // No required config keys — visit type (design vs survey) is resolved server-side from lead status.
  arrange_visit(_cfg) {
    return { value: {} };
  },
  // No required config keys — contact info and attempt state are fetched at open time.
  contact_customer(_cfg) {
    return { value: {} };
  },
  // Optional config: defaultDurationMin, defaultTitle — controls the scheduling step defaults.
  design_visit_followup(cfg) {
    const out = {};
    if (cfg.defaultDurationMin !== undefined) {
      const n = parseInt(cfg.defaultDurationMin, 10);
      if (!Number.isInteger(n) || n < 5 || n > 1440) {
        return { error: 'defaultDurationMin must be 5–1440.' };
      }
      out.defaultDurationMin = n;
    }
    if (cfg.defaultTitle !== undefined) {
      const v = String(cfg.defaultTitle || '');
      if (v.length > 120) return { error: 'defaultTitle must be 120 characters or fewer.' };
      out.defaultTitle = v;
    }
    return { value: out };
  },
  // No required config keys — contact info and QB estimates are fetched at open time.
  open_deal(_cfg) {
    return { value: {} };
  },
  // No required config keys — contact info and QB deposit invoice are fetched at open time.
  deposit_invoice_followup(_cfg) {
    return { value: {} };
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
  const stage  = b.stage_key  ? String(b.stage_key).trim().toLowerCase()  : '';
  const status = b.status_key !== undefined && b.status_key !== null
    ? String(b.status_key).trim().toLowerCase()
    : '';
  if (!stage) return { error: 'Each binding requires a stage_key.' };
  if (stage === GLOBAL_NULL_STAGE_KEY) {
    if (status.length > 0) {
      return { error: 'The __global__ stage only supports an empty status_key.' };
    }
    return { value: { stage_key: stage, status_key: '' } };
  }
  if (!STAGE_ACTION_STAGE_KEYS.has(stage)) {
    return { error: 'stage_key must be a valid pipeline stage key.' };
  }
  if (status.length > 64 || !/^[a-z0-9_]*$/.test(status)) {
    return { error: 'status_key may only contain lowercase letters, digits, and underscores.' };
  }
  return { value: { stage_key: stage, status_key: status } };
}


async function checkDuplicateHandlerBindings() {
  const labelDups = await pool.query(`
    SELECT stage_key, status_key, COUNT(*) AS cnt,
           array_agg(DISTINCT handler_id ORDER BY handler_id) AS handler_ids
    FROM card_action_handler_bindings
    GROUP BY stage_key, status_key
    HAVING COUNT(*) > 1
  `);
  const total = labelDups.rows.length;
  if (total === 0) return;
  logger.warn(`[WARN] card_action_handler_bindings: ${total} duplicate slot(s) detected.`);
  for (const r of labelDups.rows) {
    logger.warn(`  [DUPLICATE] label slot stage_key=${r.stage_key} status_key=${r.status_key} bound to handlers: ${r.handler_ids.join(', ')} (${r.cnt} entries)`);
  }
  logger.warn('  Use GET /api/admin/card-action-handlers/conflicts (admin) or the conflict resolver in admin.html to clean these up.');
}

async function _loadHandlerWithBindings(id) {
  const h = await pool.query(
    `SELECT id, name, type, config, created_at, updated_at
     FROM card_action_handlers WHERE id = $1`,
    [id]
  );
  if (!h.rows.length) return null;
  const b = await pool.query(
    `SELECT id, stage_key, status_key
     FROM card_action_handler_bindings WHERE handler_id = $1
     ORDER BY id ASC`,
    [id]
  );
  return { ...h.rows[0], bindings: b.rows };
}

async function _replaceHandlerBindings(client, handlerId, bindings) {
  await client.query(`DELETE FROM card_action_handler_bindings WHERE handler_id = $1`, [handlerId]);
  if (!Array.isArray(bindings) || !bindings.length) return;

  const validated = [];
  for (const raw of bindings) {
    const { error, value } = _validateHandlerBinding(raw);
    if (error) throw Object.assign(new Error(error), { _userError: true });
    validated.push(value);
  }

  const statusKeys = [...new Set(validated.map(v => v.status_key).filter(Boolean))];
  if (statusKeys.length) {
    // Binding status_key values are stored lowercase (normalised by
    // _validateHandlerBinding) while lead_status_config.key is stored in the
    // original HubSpot casing (typically uppercase).  Compare on LOWER(key) so
    // the check is case-consistent.
    const { rows } = await client.query(
      `SELECT LOWER(key) AS key FROM lead_status_config WHERE LOWER(key) = ANY($1::text[])`,
      [statusKeys]
    );
    const knownKeys = new Set(rows.map(r => r.key));
    for (const key of statusKeys) {
      if (!knownKeys.has(key)) {
        throw Object.assign(
          new Error(`status_key "${key}" does not exist in lead_status_config.`),
          { _userError: true }
        );
      }
    }
  }

  for (const value of validated) {
    await client.query(
      `INSERT INTO card_action_handler_bindings (handler_id, stage_key, status_key)
       VALUES ($1, $2, $3)`,
      [handlerId, value.stage_key, value.status_key]
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
      `SELECT handler_id, stage_key, status_key
       FROM card_action_handler_bindings`
    );
    const byId = {};
    for (const r of h.rows) byId[r.id] = { ...r, bindings: [] };
    for (const r of b.rows) {
      if (byId[r.handler_id]) byId[r.handler_id].bindings.push({
        stage_key: r.stage_key, status_key: r.status_key,
      });
    }
    res.set('Cache-Control', 'no-store');
    res.json(Object.values(byId));
  } catch (e) {
    logger.error({ err: e.message }, 'GET /api/card-action-handlers error:');
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
      `SELECT id, handler_id, stage_key, status_key
       FROM card_action_handler_bindings ORDER BY id ASC`
    );
    const byId = {};
    for (const r of h.rows) byId[r.id] = { ...r, bindings: [] };
    for (const r of b.rows) {
      if (byId[r.handler_id]) byId[r.handler_id].bindings.push({
        id: r.id, stage_key: r.stage_key, status_key: r.status_key,
      });
    }
    res.json(Object.values(byId));
  } catch (e) {
    logger.error({ err: e.message }, 'GET /api/admin/card-action-handlers error:');
    res.status(500).json({ error: 'Could not load card action handlers.' });
  }
});

app.get('/api/admin/card-action-handlers/conflicts', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const labelDups = await pool.query(`
      SELECT b.stage_key, b.status_key,
             COUNT(*) AS cnt,
             array_agg(DISTINCT b.handler_id ORDER BY b.handler_id) AS handler_ids,
             array_agg(DISTINCT h.name ORDER BY h.name) AS handler_names
      FROM card_action_handler_bindings b
      JOIN card_action_handlers h ON h.id = b.handler_id
      GROUP BY b.stage_key, b.status_key
      HAVING COUNT(*) > 1
    `);
    const conflicts = labelDups.rows.map(r => ({
      type: 'label',
      stage_key: r.stage_key,
      status_key: r.status_key,
      count: parseInt(r.cnt, 10),
      handler_ids: r.handler_ids,
      handler_names: r.handler_names,
    }));
    res.json({ conflicts, total: conflicts.length });
  } catch (e) {
    logger.error({ err: e.message }, 'GET /api/admin/card-action-handlers/conflicts error:');
    res.status(500).json({ error: 'Could not load handler binding conflicts.' });
  }
});

app.get('/api/admin/card-action-handlers/orphaned', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT COUNT(*) AS cnt
      FROM card_action_handler_bindings
      WHERE stage_key = 'sales' AND (status_key IS NULL OR status_key = '')
    `);
    const count = parseInt(result.rows[0]?.cnt ?? '0', 10);
    res.json({ count });
  } catch (e) {
    logger.error({ err: e.message }, 'GET /api/admin/card-action-handlers/orphaned error:');
    res.status(500).json({ error: 'Could not check orphaned handler bindings.' });
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
    logger.error({ err: e.message }, 'POST /api/admin/card-action-handlers error:');
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
    logger.error({ err: e.message }, 'PATCH /api/admin/card-action-handlers error:');
    res.status(500).json({ error: 'Could not update handler.' });
  } finally {
    client.release();
  }
});

app.delete('/api/admin/card-action-handlers/:id/binding', isAuthenticated, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id.' });

  const { error, value } = _validateHandlerBinding(req.body || {});
  if (error) return res.status(400).json({ error });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const delBinding = await client.query(
      `DELETE FROM card_action_handler_bindings
       WHERE handler_id = $1
         AND LOWER(COALESCE(stage_key, ''))  = $2
         AND LOWER(COALESCE(status_key, '')) = $3
       RETURNING id`,
      [id, value.stage_key || '', value.status_key || '']
    );

    if (!delBinding.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Binding not found.' });
    }

    const remaining = await client.query(
      `SELECT id FROM card_action_handler_bindings WHERE handler_id = $1 LIMIT 1`,
      [id]
    );
    let handlerDeleted = false;
    if (!remaining.rows.length) {
      await client.query(`DELETE FROM card_action_handlers WHERE id = $1`, [id]);
      handlerDeleted = true;
    }

    await client.query('COMMIT');
    res.json({ ok: true, handlerDeleted });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err: e.message }, 'DELETE /api/admin/card-action-handlers/:id/binding error:');
    res.status(500).json({ error: 'Could not remove binding.' });
  } finally {
    client.release();
  }
});

// Delete a card-action handler and all its bindings (cascade via FK).
app.delete('/api/admin/card-action-handlers/:id', isAuthenticated, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const result = await pool.query(
      `DELETE FROM card_action_handlers WHERE id = $1 RETURNING id`,
      [id],
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Handler not found.' });
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e.message }, 'DELETE /api/admin/card-action-handlers/:id error:');
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
      logger.error({ err: e.response?.data || e.message }, 'POST /api/card-actions/phone-call-summary error:');
      res.status(502).json({ error: e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
    }
  }
);

/**
 * Best-effort: fetch the body and timestamp of the most recent HubSpot note
 * associated with a contact. Returns `{ visitNotes, visitNotesTimestamp }` —
 * both empty strings on any error or when no notes exist.
 */
async function fetchLatestContactNote(contactId) {
  // Dev-only test stub: when HUBSPOT_NOTES_STUB is set (never in production),
  // return canned data keyed by contactId without making any HubSpot network
  // calls. Format: JSON object of { "<contactId>": { body, ts } }.
  if (process.env.HUBSPOT_NOTES_STUB && process.env.NODE_ENV !== 'production') {
    try {
      const stub = JSON.parse(process.env.HUBSPOT_NOTES_STUB);
      const entry = stub[String(contactId)];
      if (entry) {
        return {
          visitNotes: String(entry.body || ''),
          visitNotesTimestamp: String(entry.ts || ''),
        };
      }
    } catch {}
    return { visitNotes: '', visitNotesTimestamp: '' };
  }
  let visitNotes = '';
  let visitNotesTimestamp = '';
  try {
    const assocR = await hubspotRequestWithRetry('get',
      `${HS}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}/associations/notes`,
      null,
      { timeout: 8000 }
    );
    const noteIds = (assocR.data?.results || []).map(r => r.id).filter(Boolean);
    if (noteIds.length) {
      const noteR = await hubspotRequestWithRetry('post',
        `${HS}/crm/v3/objects/notes/batch/read`,
        { properties: ['hs_note_body', 'hs_timestamp'], inputs: noteIds.map(id => ({ id })) },
        { timeout: 8000 }
      );
      const sorted = (noteR.data?.results || [])
        .filter(n => n.properties?.hs_note_body)
        .sort((a, b) => {
          const ta = new Date(a.properties?.hs_timestamp || 0).getTime();
          const tb = new Date(b.properties?.hs_timestamp || 0).getTime();
          return tb - ta;
        });
      if (sorted.length) {
        visitNotes = String(sorted[0].properties.hs_note_body || '');
        visitNotesTimestamp = String(sorted[0].properties.hs_timestamp || '');
      }
    }
  } catch { /* best-effort — empty on any HubSpot error */ }
  return { visitNotes, visitNotesTimestamp };
}

// Fetch the contact's structured postal address from HubSpot, best-effort.
// Returns null on any error or when the contact has no address on file so
// callers (e.g. the design-visit wizard) can fall back to manual entry.
// Mirrors fetchLatestContactNote's dev-only stub guard: when HUBSPOT_NOTES_STUB
// is set (test runs) no live HubSpot call is made.
async function fetchContactStructuredAddress(contactId) {
  if (process.env.HUBSPOT_NOTES_STUB && process.env.NODE_ENV !== 'production') {
    return null;
  }
  try {
    const r = await hubspotRequestWithRetry('get',
      `${HS}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`,
      null,
      { params: { properties: 'address,city,state,zip,country' }, timeout: 8000 },
    );
    const props = r.data?.properties || {};
    const addr = hubspotToAddress({
      address: props.address, city: props.city, state: props.state, zip: props.zip, country: props.country,
    });
    return formatAddress(addr).trim() ? addr : null;
  } catch {
    return null;
  }
}

// Execute: arrange_visit → fetch contact info, determine visit type from lead status.
app.post('/api/card-actions/arrange-visit',
  isAuthenticated, requirePrivilege('member'), requireHubspotToken, hubspotMutationLimiter,
  async (req, res) => {
    const contactId = String(req.body?.contactId || '');
    if (!/^\d+$/.test(contactId)) return res.status(400).json({ error: 'Invalid contactId.' });
    try {
      const r = await hubspotRequestWithRetry('get',
        `${HS}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`,
        null,
        { params: { properties: 'firstname,lastname,email,phone,mobilephone,address,city,state,zip,country,hs_lead_status' }, timeout: 15000 }
      );
      const props = r.data?.properties || {};
      const leadStatus = String(props.hs_lead_status || '').toLowerCase();
      const visitType = (leadStatus === 'awaiting_deposit' || leadStatus === 'deposit_invoice') ? 'survey' : 'design';
      const firstName = String(props.firstname || '');
      const lastName  = String(props.lastname  || '');
      const contactName        = [firstName, lastName].filter(Boolean).join(' ') || '';
      const contactPhone       = String(props.phone || '');
      const contactMobilePhone = String(props.mobilephone || '');
      const contactEmail       = String(props.email || '');
      const contactStructuredAddress = hubspotToAddress({
        address: props.address, city: props.city, state: props.state, zip: props.zip, country: props.country,
      });
      const contactAddress = formatAddress(contactStructuredAddress);

      const { visitNotes, visitNotesTimestamp } = await fetchLatestContactNote(contactId);

      res.json({ visitType, contactName, contactPhone, contactMobilePhone, contactEmail, contactAddress, contactStructuredAddress, leadStatus: props.hs_lead_status, visitNotes, visitNotesTimestamp });
    } catch (e) {
      const status = e.response?.status;
      if (status === 401 || status === 403) {
        return res.status(502).json({ error: 'HubSpot rejected the request.', code: 'HUBSPOT_AUTH' });
      }
      if (status === 429) {
        return res.status(502).json({ error: 'HubSpot rate limit reached.', code: 'HUBSPOT_RATE_LIMIT' });
      }
      logger.error({ err: e.response?.data || e.message }, 'POST /api/card-actions/arrange-visit error:');
      res.status(502).json({ error: e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
    }
  }
);

/**
 * Best-effort lookup of the duration (in minutes) of the visit already booked
 * for a contact. Visits are booked via the "arrange visit" step, which creates
 * a Google Calendar event on the shared calendar tagged with
 * `moContactId` + `moVisitType`. We return the duration of the soonest upcoming
 * matching event so the visit wizards can inherit it instead of re-asking.
 *
 * Returns `null` on any failure (Google not connected, no shared calendar
 * configured, or no matching booking) — callers fall back to their default
 * duration. Never throws.
 */
async function getScheduledVisitDurationMin(req, contactId, visitType) {
  try {
    const googleTokens = await getVerifiedGoogleTokens(req);
    if (!googleTokens) return null;
    const calendarId = getSharedCalendarId();
    const calendar = getCalendarClient(getGoogleClient(googleTokens));
    const evRes = await calendar.events.list({
      calendarId,
      timeMin: new Date().toISOString(),
      maxResults: 10,
      singleEvents: true,
      orderBy: 'startTime',
      privateExtendedProperty: [`moContactId=${contactId}`, `moVisitType=${visitType}`],
    });
    const ev = (evRes.data?.items || []).find(e => e.start?.dateTime && e.end?.dateTime);
    if (!ev) return null;
    const mins = Math.round(
      (new Date(ev.end.dateTime).getTime() - new Date(ev.start.dateTime).getTime()) / 60000,
    );
    return Number.isFinite(mins) && mins > 0 ? mins : null;
  } catch {
    // Best-effort: Google not connected, calendar not configured, or no match.
    return null;
  }
}

// Execute: start_design_visit → fetch the most recent HubSpot note to pre-fill
// the wizard's visit notes field, plus the contact's structured address so the
// design-visit wizard can show it read-only (the address is captured once when
// the visit is scheduled / on the customer record, not re-entered per visit).
// Returns { visitNotes, visitNotesTimestamp, contactStructuredAddress,
// scheduledDurationMin }.
app.post('/api/card-actions/start-design-visit',
  isAuthenticated, requirePrivilege('member'), requireHubspotToken, hubspotMutationLimiter,
  async (req, res) => {
    const contactId = String(req.body?.contactId || '');
    if (!/^\d+$/.test(contactId)) return res.status(400).json({ error: 'Invalid contactId.' });
    try {
      const { visitNotes, visitNotesTimestamp } = await fetchLatestContactNote(contactId);
      // Best-effort: a failure here must not break note pre-fill, so the wizard
      // simply falls back to manual address entry. Returns null when the contact
      // has no address on file.
      const contactStructuredAddress = await fetchContactStructuredAddress(contactId);
      // Best-effort: the visit duration is set when the visit is booked (the
      // "arrange visit" step creates a Google Calendar event tagged
      // moVisitType=design). The wizard inherits that duration rather than
      // asking for it again. Any failure — Google not connected, no shared
      // calendar configured, or no matching booking — leaves this null and the
      // wizard falls back to the handler's default duration.
      const scheduledDurationMin = await getScheduledVisitDurationMin(req, contactId, 'design');
      res.json({ visitNotes, visitNotesTimestamp, contactStructuredAddress, scheduledDurationMin });
    } catch (e) {
      const status = e.response?.status;
      if (status === 401 || status === 403) {
        return res.status(502).json({ error: 'HubSpot rejected the request.', code: 'HUBSPOT_AUTH' });
      }
      if (status === 429) {
        return res.status(502).json({ error: 'HubSpot rate limit reached.', code: 'HUBSPOT_RATE_LIMIT' });
      }
      logger.error({ err: e.response?.data || e.message }, 'POST /api/card-actions/start-design-visit error:');
      res.status(502).json({ error: e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
    }
  }
);

// Execute: arrange_visit outcome → update HubSpot lead status based on outcome.
app.post('/api/card-actions/arrange-visit/outcome',
  isAuthenticated, requirePrivilege('member'), requireHubspotToken, hubspotMutationLimiter,
  async (req, res) => {
    const contactId = String(req.body?.contactId || '');
    if (!/^\d+$/.test(contactId)) return res.status(400).json({ error: 'Invalid contactId.' });
    const outcome   = String(req.body?.outcome   || '');
    const visitType = String(req.body?.visitType || 'design').toLowerCase();

    if (!_ARRANGE_VISIT_KEYS.has(outcome)) {
      return res.status(400).json({ error: `outcome must be one of: ${[..._ARRANGE_VISIT_KEYS].join(', ')}.` });
    }
    const newLeadStatus = getArrangeVisitStatus(outcome, visitType);

    try {
      await assertLeadStatusKey(newLeadStatus);
      await patchContactProperties(contactId, { hs_lead_status: newLeadStatus });
      const meta = getOutcomeMeta('arrange_visit', outcome, { visitType });
      res.json({ ok: true, hs_lead_status: newLeadStatus, ...meta });
    } catch (e) {
      if (e.code === 'LEAD_STATUS_REMOVED') {
        return res.status(422).json({ error: e.message, code: 'LEAD_STATUS_REMOVED', removedKey: e.removedKey });
      }
      const status = e.response?.status;
      if (status === 401 || status === 403) {
        return res.status(502).json({ error: 'HubSpot rejected the request.', code: 'HUBSPOT_AUTH' });
      }
      if (status === 429) {
        return res.status(502).json({ error: 'HubSpot rate limit reached.', code: 'HUBSPOT_RATE_LIMIT' });
      }
      logger.error({ err: e.response?.data || e.message }, 'POST /api/card-actions/arrange-visit/outcome error:');
      res.status(502).json({ error: e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
    }
  }
);

// ── HubSpot activity helpers (contact_customer enriched timeline) ────────────
// Short in-memory cache so reopening the Contact Customer modal doesn't re-hit
// HubSpot for the same contact within a minute.
const _ccActivityCache = new Map(); // contactId -> { at: epochMs, payload }
const CC_ACTIVITY_TTL_MS = 60 * 1000;

// HubSpot owner id → display name, cached process-wide (owners change rarely).
let _hsOwnersCache = null; // { at: epochMs, byId: Map<string,string> }
const HS_OWNERS_TTL_MS = 5 * 60 * 1000;

async function getHubspotOwnerNames() {
  const now = Date.now();
  if (_hsOwnersCache && (now - _hsOwnersCache.at) < HS_OWNERS_TTL_MS) {
    return _hsOwnersCache.byId;
  }
  const byId = new Map();
  try {
    let after;
    for (let page = 0; page < 20; page++) {
      const r = await hubspotRequestWithRetry('get',
        `${HS}/crm/v3/owners/?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`,
        null, { timeout: 10000 });
      for (const o of (r.data?.results || [])) {
        const name = [o.firstName, o.lastName].filter(Boolean).join(' ').trim() || o.email || null;
        if (o.id && name) byId.set(String(o.id), name);
      }
      after = r.data?.paging?.next?.after;
      if (!after) break;
    }
    _hsOwnersCache = { at: now, byId };
  } catch (e) {
    // Owner names are best-effort. Reuse a stale cache if we have one; otherwise
    // activities simply render without an actor name.
    if (_hsOwnersCache) return _hsOwnersCache.byId;
  }
  return byId;
}

// Render a plain-text snippet from a possibly-HTML engagement body.
function stripHtmlToText(s) {
  if (!s) return '';
  return String(s)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    // A closing paragraph is a paragraph break (blank line) so multi-paragraph
    // bodies keep their spacing when rendered to text. Other block closes
    // (div/li/tr/heading) stay a single newline — e.g. Gmail wraps each line
    // in its own <div>, which should not become double-spaced.
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/(div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    // Trim whitespace around every line break so whitespace-only lines become
    // truly empty — otherwise a stray space between two newlines survives the
    // blank-line collapse below and renders as a visible gap under `pre-wrap`.
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Fetch every engagement of `type` (emails/calls/meetings/notes/tasks)
// associated with a contact, then batch-read the requested properties.
async function fetchContactEngagements(contactId, type, properties) {
  const assoc = await hubspotRequestWithRetry('get',
    `${HS}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}/associations/${type}`,
    null, { timeout: 12000 });
  const ids = (assoc.data?.results || []).map(r => String(r.id)).filter(Boolean);
  if (!ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const r = await hubspotRequestWithRetry('post',
      `${HS}/crm/v3/objects/${type}/batch/read`,
      { properties, inputs: batch.map(id => ({ id })) },
      { timeout: 12000 });
    out.push(...(r.data?.results || []));
  }
  return out;
}

// Engagement source descriptors (emails/calls/meetings/notes/tasks). Built per
// request because the normalizers close over the owner-id → name resolver.
// Shared by the Contact Customer modal endpoint and the customer detail page.
function makeEngagementSources(ownerName) {
  return [
    {
      key: 'email', type: 'emails',
      props: ['hs_timestamp', 'hs_email_subject', 'hs_email_text', 'hs_email_html',
              'hs_email_direction', 'hs_email_status', 'hs_email_from_email',
              'hs_email_to_email', 'hubspot_owner_id'],
      norm: (e) => {
        const p = e.properties || {};
        const dir = String(p.hs_email_direction || '');
        return {
          id: `email:${e.id}`,
          type: 'email',
          timestamp: p.hs_timestamp || e.createdAt || null,
          title: p.hs_email_subject || '(no subject)',
          direction: dir === 'INCOMING_EMAIL' ? 'incoming' : (dir ? 'outgoing' : null),
          actor: ownerName(p.hubspot_owner_id),
          body: stripHtmlToText(p.hs_email_text || p.hs_email_html || ''),
          meta: {
            from: p.hs_email_from_email || null,
            to: p.hs_email_to_email || null,
            status: p.hs_email_status || null,
          },
        };
      },
    },
    {
      key: 'call', type: 'calls',
      props: ['hs_timestamp', 'hs_call_title', 'hs_call_body', 'hs_call_direction',
              'hs_call_duration', 'hs_call_disposition', 'hubspot_owner_id'],
      norm: (e) => {
        const p = e.properties || {};
        const dir = String(p.hs_call_direction || '');
        return {
          id: `call:${e.id}`,
          type: 'call',
          timestamp: p.hs_timestamp || e.createdAt || null,
          title: p.hs_call_title || 'Call',
          direction: dir === 'INBOUND' ? 'incoming' : (dir ? 'outgoing' : null),
          actor: ownerName(p.hubspot_owner_id),
          body: stripHtmlToText(p.hs_call_body || ''),
          meta: {
            durationMs: p.hs_call_duration != null ? Number(p.hs_call_duration) : null,
            disposition: p.hs_call_disposition || null,
          },
        };
      },
    },
    {
      key: 'meeting', type: 'meetings',
      props: ['hs_timestamp', 'hs_meeting_title', 'hs_meeting_body',
              'hs_meeting_outcome', 'hubspot_owner_id'],
      norm: (e) => {
        const p = e.properties || {};
        return {
          id: `meeting:${e.id}`,
          type: 'meeting',
          timestamp: p.hs_timestamp || e.createdAt || null,
          title: p.hs_meeting_title || 'Meeting',
          direction: null,
          actor: ownerName(p.hubspot_owner_id),
          body: stripHtmlToText(p.hs_meeting_body || ''),
          meta: { outcome: p.hs_meeting_outcome || null },
        };
      },
    },
    {
      key: 'note', type: 'notes',
      props: ['hs_timestamp', 'hs_note_body', 'hubspot_owner_id'],
      norm: (e) => {
        const p = e.properties || {};
        return {
          id: `note:${e.id}`,
          type: 'note',
          timestamp: p.hs_timestamp || e.createdAt || null,
          title: 'Note',
          direction: null,
          actor: ownerName(p.hubspot_owner_id),
          body: stripHtmlToText(p.hs_note_body || ''),
          meta: {},
        };
      },
    },
    {
      key: 'task', type: 'tasks',
      props: ['hs_timestamp', 'hs_task_subject', 'hs_task_body',
              'hs_task_status', 'hubspot_owner_id'],
      norm: (e) => {
        const p = e.properties || {};
        return {
          id: `task:${e.id}`,
          type: 'task',
          timestamp: p.hs_timestamp || e.createdAt || null,
          title: p.hs_task_subject || 'Task',
          direction: null,
          actor: ownerName(p.hubspot_owner_id),
          body: stripHtmlToText(p.hs_task_body || ''),
          meta: { status: p.hs_task_status || null },
        };
      },
    },
  ];
}

// Form submissions live on the legacy contact profile (forms scope), not as CRM
// engagement objects. The profile path yields form name + page URL + timestamp;
// per-field values require the Forms submissions API (see fetchFormSubmissionValues).
async function fetchContactFormSubmissions(contactId) {
  const r = await hubspotRequestWithRetry('get',
    `${HS}/contacts/v1/contact/vid/${encodeURIComponent(contactId)}/profile` +
    `?formSubmissionMode=all&propertyMode=value_only&showListMemberships=false`,
    null, { timeout: 12000 });
  const subs = Array.isArray(r.data?.['form-submissions']) ? r.data['form-submissions'] : [];
  return subs.map((s, i) => ({
    id: `form:${s['conversion-id'] || `${s['form-id'] || 'form'}:${s.timestamp || i}`}`,
    type: 'form_submission',
    timestamp: s.timestamp ? new Date(Number(s.timestamp)).toISOString() : null,
    title: s.title || s['form-title'] || 'Form submission',
    direction: 'incoming',
    actor: null,
    body: null,
    meta: { pageUrl: s['page-url'] || null, formId: s['form-id'] || null, fields: null },
    _rawTs: s.timestamp ? Number(s.timestamp) : null,
  }));
}

// Per-form submission rows (incl. field values) via the Forms submissions API
// (requires the `forms` scope). Returns the API's raw result list for a form,
// cached briefly per form GUID to avoid refetching for repeated submissions.
const _hsFormSubmissionsCache = new Map(); // formGuid -> { at, results }
const HS_FORM_SUBS_TTL_MS = 60 * 1000;
async function fetchFormSubmissionValues(formGuid) {
  const cached = _hsFormSubmissionsCache.get(formGuid);
  if (cached && (Date.now() - cached.at) < HS_FORM_SUBS_TTL_MS) return cached.results;
  const r = await hubspotRequestWithRetry('get',
    `${HS}/form-integrations/v1/submissions/forms/${encodeURIComponent(formGuid)}?limit=50`,
    null, { timeout: 12000 });
  const results = Array.isArray(r.data?.results) ? r.data.results : [];
  _hsFormSubmissionsCache.set(formGuid, { at: Date.now(), results });
  return results;
}

// Enrich form-submission activities in place with submitted field values. Each
// distinct form GUID is fetched at most once; a submission is matched to an
// activity by closest submittedAt (within a 5-minute window). Best-effort and
// fail-soft per form — a missing `forms` scope leaves the rows showing name/page
// only, exactly as the un-enriched path does.
async function enrichFormFieldValues(formActivities, unavailable) {
  const formIds = [...new Set(formActivities.map(a => a.meta?.formId).filter(Boolean))];
  let anyFailed = false;
  await Promise.all(formIds.map(async (formId) => {
    let results;
    try {
      results = await fetchFormSubmissionValues(formId);
    } catch (err) {
      anyFailed = true;
      const status = err.response?.status;
      if (status !== 403 && status !== 404) {
        logger.warn({ err: err.response?.data || err.message, formId },
          'contact activity: form submission values failed');
      }
      return;
    }
    for (const act of formActivities) {
      if (act.meta?.formId !== formId || act._rawTs == null) continue;
      let best = null, bestDelta = Infinity;
      for (const sub of results) {
        const subTs = Number(sub.submittedAt);
        if (!Number.isFinite(subTs)) continue;
        const delta = Math.abs(subTs - act._rawTs);
        if (delta < bestDelta) { bestDelta = delta; best = sub; }
      }
      if (best && bestDelta <= 5 * 60 * 1000 && Array.isArray(best.values)) {
        act.meta.fields = best.values
          .filter(v => v && v.name)
          .map(v => ({ name: String(v.name), value: v.value == null ? '' : String(v.value) }));
        if (!act.meta.pageUrl && best.pageUrl) act.meta.pageUrl = best.pageUrl;
      }
    }
  }));
  if (anyFailed) unavailable.push('form_values');
}

// Marketing email events (sends + opens + clicks) for a recipient via the legacy
// email-events API (requires the marketing email / `content` scope). Paginated.
async function fetchMarketingEmailEvents(email) {
  const events = [];
  let offset;
  for (let page = 0; page < 8; page++) {
    const url = `${HS}/email/public/v1/events?recipient=${encodeURIComponent(email)}&limit=300` +
      (offset ? `&offset=${encodeURIComponent(offset)}` : '');
    const r = await hubspotRequestWithRetry('get', url, null, { timeout: 12000 });
    events.push(...(r.data?.events || []));
    if (!r.data?.hasMore || !r.data?.offset) break;
    offset = r.data.offset;
  }
  return events;
}

// Best-effort marketing-campaign id → { name, subject }, cached process-wide.
const _hsCampaignCache = new Map(); // campaignId -> { name, subject }
async function getCampaignMeta(id) {
  const key = String(id);
  if (_hsCampaignCache.has(key)) return _hsCampaignCache.get(key);
  let meta = { name: null, subject: null };
  try {
    const r = await hubspotRequestWithRetry('get',
      `${HS}/email/public/v1/campaigns/${encodeURIComponent(key)}`, null, { timeout: 8000 });
    meta = { name: r.data?.name || null, subject: r.data?.subject || null };
  } catch { /* best-effort — fall back to a generic label */ }
  _hsCampaignCache.set(key, meta);
  return meta;
}

// Collapse marketing email events into one activity per campaign, carrying open
// and click counts plus the last open/click timestamps. Only true campaign sends
// (events with an emailCampaignId) are surfaced.
async function buildMarketingEmailActivities(email) {
  const events = await fetchMarketingEmailEvents(email);
  const SENT_TYPES = new Set(['SENT', 'DELIVERED', 'PROCESSED']);
  const byCampaign = new Map();
  for (const ev of events) {
    if (!ev.emailCampaignId) continue;
    const cid = String(ev.emailCampaignId);
    let g = byCampaign.get(cid);
    if (!g) { g = { sentAt: null, opens: 0, clicks: 0, lastOpen: null, lastClick: null }; byCampaign.set(cid, g); }
    const t = Number(ev.created || ev.timestamp) || null;
    const type = String(ev.type || '').toUpperCase();
    if (SENT_TYPES.has(type)) { if (t && (!g.sentAt || t < g.sentAt)) g.sentAt = t; }
    else if (type === 'OPEN') { g.opens++; if (t && (!g.lastOpen || t > g.lastOpen)) g.lastOpen = t; }
    else if (type === 'CLICK') { g.clicks++; if (t && (!g.lastClick || t > g.lastClick)) g.lastClick = t; }
  }
  const campaignIds = [...byCampaign.keys()].slice(0, 40); // bound campaign-name lookups
  const out = [];
  for (const cid of campaignIds) {
    const g = byCampaign.get(cid);
    const meta = await getCampaignMeta(cid);
    const ts = g.sentAt || g.lastOpen || g.lastClick;
    out.push({
      id: `marketing:${cid}`,
      type: 'marketing_email',
      timestamp: ts ? new Date(ts).toISOString() : null,
      title: meta.subject || meta.name || 'Marketing email',
      direction: 'outgoing',
      actor: null,
      body: null,
      meta: {
        opens: g.opens,
        clicks: g.clicks,
        lastOpenedAt: g.lastOpen ? new Date(g.lastOpen).toISOString() : null,
        lastClickedAt: g.lastClick ? new Date(g.lastClick).toISOString() : null,
        campaignName: meta.name || null,
      },
    });
  }
  return out;
}

// Page-view (website-visit) behavioural events via the analytics events API
// (requires an analytics scope). Newest first, capped server-side.
async function fetchContactPageViews(contactId) {
  const r = await hubspotRequestWithRetry('get',
    `${HS}/events/v3/events?objectType=contact&objectId=${encodeURIComponent(contactId)}` +
    `&eventType=e_visited_page&limit=100`,
    null, { timeout: 12000 });
  const results = Array.isArray(r.data?.results) ? r.data.results : [];
  return results.map((ev, i) => {
    const p = ev.properties || {};
    return {
      id: `pageview:${ev.id || `${ev.occurredAt || i}`}`,
      type: 'page_view',
      timestamp: ev.occurredAt || null,
      title: p.hs_page_title || p.hs_url || 'Page view',
      direction: 'incoming',
      actor: null,
      body: null,
      meta: { pageUrl: p.hs_url || null },
    };
  });
}

// ── Shared contact-activity builder ──────────────────────────────────────────
// Produces the normalized, reverse-chronological activity list used by both the
// Contact Customer modal (engagements + form name/page only) and the customer
// detail page (additionally marketing emails, page views and form field values).
// Every source degrades independently: a source that errors (e.g. a missing
// scope → 403) is dropped and its key is added to `unavailable`, so a partial
// timeline always renders. `opts.include` toggles the heavier detail-page-only
// sources; `opts.email` is required for the marketing-email source.
async function buildContactActivity(contactId, opts = {}) {
  const include = opts.include || {};
  const email = opts.email || null;
  const ownerNames = await getHubspotOwnerNames();
  const ownerName = (id) => (id != null ? ownerNames.get(String(id)) : null) || null;
  const unavailable = [];

  const sources = makeEngagementSources(ownerName);
  const engagementGroups = await Promise.all(sources.map(async (s) => {
    try {
      const raw = await fetchContactEngagements(contactId, s.type, s.props);
      return raw.map(s.norm);
    } catch (err) {
      unavailable.push(s.key);
      const status = err.response?.status;
      if (status !== 403 && status !== 404) {
        logger.warn({ err: err.response?.data || err.message, source: s.type },
          'contact activity: engagement source failed');
      }
      return [];
    }
  }));

  let formActivities = [];
  try {
    formActivities = await fetchContactFormSubmissions(contactId);
    if (include.formValues && formActivities.length) {
      await enrichFormFieldValues(formActivities, unavailable);
    }
  } catch (err) {
    unavailable.push('form_submission');
    const status = err.response?.status;
    if (status !== 403 && status !== 404) {
      logger.warn({ err: err.response?.data || err.message },
        'contact activity: form submissions failed');
    }
  }
  // Drop the internal matching field before returning to the client.
  formActivities.forEach(a => { delete a._rawTs; });

  let marketingActivities = [];
  if (include.marketing && email) {
    try {
      marketingActivities = await buildMarketingEmailActivities(email);
    } catch (err) {
      unavailable.push('marketing_email');
      const status = err.response?.status;
      if (status !== 403 && status !== 404) {
        logger.warn({ err: err.response?.data || err.message },
          'contact activity: marketing emails failed');
      }
    }
  }

  let pageViewActivities = [];
  if (include.pageViews) {
    try {
      pageViewActivities = await fetchContactPageViews(contactId);
    } catch (err) {
      unavailable.push('page_view');
      const status = err.response?.status;
      if (status !== 403 && status !== 404) {
        logger.warn({ err: err.response?.data || err.message },
          'contact activity: page views failed');
      }
    }
  }

  const MAX_ITEMS = 200;
  const all = [
    ...engagementGroups.flat(),
    ...formActivities,
    ...marketingActivities,
    ...pageViewActivities,
  ]
    .map(a => ({ ...a, source: 'hubspot' }))
    .sort((x, y) => {
      const tx = x.timestamp ? Date.parse(x.timestamp) : 0;
      const ty = y.timestamp ? Date.parse(y.timestamp) : 0;
      return ty - tx;
    });
  const truncated = all.length > MAX_ITEMS;
  return { activities: all.slice(0, MAX_ITEMS), unavailable, truncated };
}

// ── contact_customer: load contact info + attempt tracking ───────────────────
app.post('/api/card-actions/contact-customer',
  isAuthenticated, requirePrivilege('member'), requireHubspotToken,
  async (req, res) => {
    const contactId = String(req.body?.contactId || '');
    if (!/^\d+$/.test(contactId)) return res.status(400).json({ error: 'Invalid contactId.' });
    try {
      const r = await hubspotRequestWithRetry('get',
        `${HS}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`,
        null,
        { params: { properties: 'firstname,lastname,email,phone,mobilephone,hs_lead_status' }, timeout: 15000 }
      );
      const props = r.data?.properties || {};
      const firstName = String(props.firstname || '');
      const lastName  = String(props.lastname  || '');
      const contactName  = [firstName, lastName].filter(Boolean).join(' ') || '';
      const contactEmail = String(props.email || '');
      const phone        = String(props.phone || '');
      const mobile       = String(props.mobilephone || '');
      const leadStatus   = props.hs_lead_status || null;

      const [trackingResult, historyResult] = await Promise.all([
        pool.query(
          `SELECT cat.call_attempted, cat.email_sent, cat.whatsapp_sent,
                  cat.attempted_at,
                  COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email) AS attempted_by_name
           FROM contact_attempt_tracking cat
           LEFT JOIN users u ON u.id = cat.attempted_by
           WHERE cat.hubspot_contact_id = $1`,
          [contactId]
        ),
        pool.query(
          `SELECT
             COUNT(*)::int                                                                    AS total_sessions,
             COALESCE(SUM(call_attempted::int + email_sent::int + whatsapp_sent::int), 0)::int AS total_attempts,
             BOOL_OR(call_attempted)  AS ever_called,
             BOOL_OR(email_sent)      AS ever_emailed,
             BOOL_OR(whatsapp_sent)   AS ever_whatsapped
           FROM contact_attempt_history_log
           WHERE hubspot_contact_id = $1`,
          [contactId]
        ),
      ]);
      const attempts = trackingResult.rows[0] || { call_attempted: false, email_sent: false, whatsapp_sent: false };
      const hist     = historyResult.rows[0]  || { total_sessions: 0, total_attempts: 0, ever_called: false, ever_emailed: false, ever_whatsapped: false };

      const [{ rows: logRows }, { rows: histLogRows }] = await Promise.all([
        pool.query(
          `SELECT cal.method, cal.attempted_at, cal.note,
                  COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email) AS attempted_by_name
           FROM contact_attempt_log cal
           LEFT JOIN users u ON u.id = cal.attempted_by
           WHERE cal.hubspot_contact_id = $1
             AND cal.attempted_at > COALESCE(
               (SELECT MAX(attempted_at) FROM contact_attempt_history_log
                 WHERE hubspot_contact_id = $1),
               '-infinity'::timestamptz)
           ORDER BY cal.attempted_at DESC`,
          [contactId]
        ),
        pool.query(
          `SELECT cahl.attempted_at, cahl.call_attempted, cahl.email_sent, cahl.whatsapp_sent, cahl.notes,
                  COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email) AS attempted_by_name
           FROM contact_attempt_history_log cahl
           LEFT JOIN users u ON u.id::text = cahl.attempted_by
           WHERE cahl.hubspot_contact_id = $1
           ORDER BY cahl.attempted_at DESC`,
          [contactId]
        ),
      ]);

      res.json({
        contactName,
        contactEmail,
        phone,
        mobile,
        leadStatus,
        callAttempted:        attempts.call_attempted,
        emailSent:            attempts.email_sent,
        whatsappSent:         attempts.whatsapp_sent,
        lastAttemptAt:        attempts.attempted_at || null,
        lastAttemptBy:        attempts.attempted_by_name || null,
        attemptLog: logRows.map(r => ({
          method:      r.method,
          attemptedAt: r.attempted_at,
          attemptedBy: r.attempted_by_name || null,
          note:        r.note || null,
        })),
        historySessionCount:  hist.total_sessions,
        historyTotalAttempts: hist.total_attempts,
        historyEverCalled:    hist.ever_called    || false,
        historyEverEmailed:   hist.ever_emailed   || false,
        historyEverWhatsapped: hist.ever_whatsapped || false,
        historyAttemptLog: histLogRows.map(r => ({
          attemptedAt:   r.attempted_at,
          attemptedBy:   r.attempted_by_name || null,
          callAttempted: r.call_attempted    || false,
          emailSent:     r.email_sent        || false,
          whatsappSent:  r.whatsapp_sent     || false,
          notes:         Array.isArray(r.notes) ? r.notes : [],
        })),
      });
    } catch (e) {
      const status = e.response?.status;
      if (status === 401 || status === 403) {
        return res.status(502).json({ error: 'HubSpot rejected the request.', code: 'HUBSPOT_AUTH' });
      }
      if (status === 429) {
        return res.status(502).json({ error: 'HubSpot rate limit reached.', code: 'HUBSPOT_RATE_LIMIT' });
      }
      logger.error({ err: e.response?.data || e.message }, 'POST /api/card-actions/contact-customer error:');
      res.status(502).json({ error: e.message || 'Unexpected error.', code: 'HUBSPOT_ERROR' });
    }
  }
);

// ── contact_customer: enriched HubSpot activity timeline (lazy-loaded) ────────
// Returns a normalized, reverse-chronological list of HubSpot activities
// (emails, calls, meetings, notes, tasks, form submissions) for the contact.
// Each source degrades independently: if the token lacks a scope (403) or one
// source errors, the rest still return and `unavailable` lists the sources that
// could not be read. The modal intentionally omits the heavier marketing-email /
// page-view / form-field-value sources, which are surfaced only on the customer
// detail page (GET /api/contacts/:contactId/activity).
app.get('/api/card-actions/contact-customer/:contactId/activity',
  isAuthenticated, requirePrivilege('member'), requireHubspotToken,
  async (req, res) => {
    const contactId = String(req.params.contactId || '');
    if (!/^\d+$/.test(contactId)) return res.status(400).json({ error: 'Invalid contactId.' });

    const cached = _ccActivityCache.get(contactId);
    if (cached && (Date.now() - cached.at) < CC_ACTIVITY_TTL_MS) {
      return res.json(cached.payload);
    }

    try {
      const payload = await buildContactActivity(contactId);
      _ccActivityCache.set(contactId, { at: Date.now(), payload });
      res.json(payload);
    } catch (e) {
      const status = e.response?.status;
      if (status === 401 || status === 403) {
        return res.status(502).json({ error: 'HubSpot rejected the request.', code: 'HUBSPOT_AUTH' });
      }
      if (status === 429) {
        return res.status(502).json({ error: 'HubSpot rate limit reached.', code: 'HUBSPOT_RATE_LIMIT' });
      }
      logger.error({ err: e.response?.data || e.message }, 'GET /api/card-actions/contact-customer/:contactId/activity error:');
      res.status(502).json({ error: e.message || 'Unexpected error.', code: 'HUBSPOT_ERROR' });
    }
  }
);

// ── customer detail page: full HubSpot activity feed (lazy-loaded) ────────────
// The richer sibling of the modal timeline. In addition to engagements + form
// submissions it includes marketing emails (with open/click counts), page-view
// analytics and form-submission field values. Marketing / page-view sources need
// the marketing + analytics token scopes; without them those sources are simply
// listed in `unavailable` and the rest of the feed renders normally.
const _detailActivityCache = new Map(); // contactId -> { at, payload }
app.get('/api/contacts/:contactId/activity',
  isAuthenticated, requirePrivilege('member'), requireHubspotToken,
  async (req, res) => {
    const contactId = String(req.params.contactId || '');
    if (!/^\d+$/.test(contactId)) return res.status(400).json({ error: 'Invalid contactId.' });

    const cached = _detailActivityCache.get(contactId);
    if (cached && (Date.now() - cached.at) < CC_ACTIVITY_TTL_MS) {
      return res.json(cached.payload);
    }

    try {
      // The marketing-email source is keyed by recipient email, so resolve the
      // contact's email first (best-effort — marketing just degrades without it).
      let email = null;
      try {
        const r = await hubspotRequestWithRetry('get',
          `${HS}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`,
          null, { params: { properties: 'email' }, timeout: 12000 });
        email = r.data?.properties?.email || null;
      } catch { /* best-effort — handled by marketing source degradation below */ }

      const payload = await buildContactActivity(contactId, {
        email,
        include: { marketing: true, pageViews: true, formValues: true },
      });
      _detailActivityCache.set(contactId, { at: Date.now(), payload });
      res.json(payload);
    } catch (e) {
      const status = e.response?.status;
      if (status === 401 || status === 403) {
        return res.status(502).json({ error: 'HubSpot rejected the request.', code: 'HUBSPOT_AUTH' });
      }
      if (status === 429) {
        return res.status(502).json({ error: 'HubSpot rate limit reached.', code: 'HUBSPOT_RATE_LIMIT' });
      }
      logger.error({ err: e.response?.data || e.message }, 'GET /api/contacts/:contactId/activity error:');
      res.status(502).json({ error: e.message || 'Unexpected error.', code: 'HUBSPOT_ERROR' });
    }
  }
);

// ── contact_customer: log a contact attempt with a required note ──────────────
app.post('/api/card-actions/contact-customer/:contactId/attempts',
  isAuthenticated, requirePrivilege('member'),
  async (req, res) => {
    const contactId = req.params.contactId;
    if (!/^\d+$/.test(contactId)) return res.status(400).json({ error: 'Invalid contactId.' });

    const VALID_METHODS = ['call', 'email', 'whatsapp'];
    const method = String(req.body?.method || '');
    const note   = String(req.body?.note   || '').trim();

    if (!VALID_METHODS.includes(method)) {
      return res.status(400).json({ error: 'method must be call, email, or whatsapp.' });
    }
    if (!note) {
      return res.status(400).json({ error: 'note is required and must not be empty.' });
    }

    const methodColMap = { call: 'call_attempted', email: 'email_sent', whatsapp: 'whatsapp_sent' };
    const col    = methodColMap[method];
    const userId = req.user?.claims?.sub;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `INSERT INTO contact_attempt_tracking
           (hubspot_contact_id, ${col}, attempted_at, attempted_by, updated_at)
         VALUES ($1, TRUE, NOW(), $2, NOW())
         ON CONFLICT (hubspot_contact_id) DO UPDATE
         SET ${col} = TRUE, attempted_at = NOW(), attempted_by = $2, updated_at = NOW()
         RETURNING call_attempted, email_sent, whatsapp_sent, attempted_at`,
        [contactId, userId || null]
      );

      await client.query(
        `INSERT INTO contact_attempt_log (hubspot_contact_id, method, attempted_by, note)
         VALUES ($1, $2, $3, $4)`,
        [contactId, method, userId || null, note]
      );

      const { rows: logRows } = await client.query(
        `SELECT cal.method, cal.attempted_at, cal.note,
                COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email) AS attempted_by_name
         FROM contact_attempt_log cal
         LEFT JOIN users u ON u.id = cal.attempted_by
         WHERE cal.hubspot_contact_id = $1
           AND cal.attempted_at > COALESCE(
             (SELECT MAX(attempted_at) FROM contact_attempt_history_log
               WHERE hubspot_contact_id = $1),
             '-infinity'::timestamptz)
         ORDER BY cal.attempted_at DESC`,
        [contactId]
      );

      await client.query('COMMIT');

      res.json({
        ...rows[0],
        attemptLog: logRows.map(r => ({
          method:      r.method,
          attemptedAt: r.attempted_at,
          attemptedBy: r.attempted_by_name || null,
          note:        r.note || null,
        })),
      });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error({ err: e.message }, 'POST /api/card-actions/contact-customer/:contactId/attempts error:');
      res.status(500).json({ error: 'Could not save attempt.' });
    } finally {
      client.release();
    }
  }
);

// ── contact_customer: render follow-up email preview ─────────────────────────
// Member-accessible. Loads the live contact_customer_followup template, derives
// firstName from HubSpot, and returns { subject, text, html } using the same
// renderEmail pipeline as other preview endpoints.
//
// Optional body: accepts { body, subject } overrides so the client can re-render
// with edited text while still getting the template footer/branding applied.
app.post('/api/card-actions/contact-customer/:contactId/email-preview',
  isAuthenticated, requirePrivilege('member'), requireHubspotToken,
  async (req, res) => {
    const contactId = req.params.contactId;
    if (!/^\d+$/.test(contactId)) return res.status(400).json({ error: 'Invalid contactId.' });
    try {
      const r = await hubspotRequestWithRetry('get',
        `${HS}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`,
        null,
        { params: { properties: 'firstname' }, timeout: 15000 }
      );
      const rawFirst = String(r.data?.properties?.firstname || '').trim();
      const firstName = rawFirst.split(' ')[0].trim() || 'there';
      const template = await getEmailTemplate('contact_customer_followup');

      // Optional overrides — when provided the client is re-rendering with edited
      // text; we substitute the custom body/subject but keep the template footer.
      const customBody    = typeof req.body?.body    === 'string' ? req.body.body    : null;
      const customSubject = typeof req.body?.subject === 'string' ? req.body.subject : null;
      // Convert plain-text custom body to HTML paragraphs so that renderEmail
      // can append the template footer (branding/signature). Setting body_html
      // to '' would strip the footer from the rendered output. Paragraph-aware
      // so the author's blank lines (e.g. a sign-off) survive into the email.
      const customBodyHtml = customBody !== null
        ? plainTextToHtml(customBody)
        : null;
      const effectiveTemplate = (customBody !== null || customSubject !== null) ? {
        ...template,
        ...(customBody    !== null ? { body_text: customBody, body_html: customBodyHtml } : {}),
        ...(customSubject !== null ? { subject:   customSubject                         } : {}),
      } : template;

      const vars     = { firstName };
      const htmlVars = Object.fromEntries(
        Object.entries(vars).map(([k, v]) => [k, escapeHtml(String(v))])
      );
      const rendered = renderEmail(effectiveTemplate, { textVars: vars, htmlVars });
      if (!effectiveTemplate.body_html || !effectiveTemplate.body_html.trim()) {
        rendered.html = plainTextToHtml(rendered.text);
      }

      // Append the sender's personal signature to the preview HTML so what
      // the user sees in the preview matches what the customer will receive.
      const sig = await _buildSenderSignature(req.user?.claims?.sub);
      if (sig.html) rendered.html += sig.html;

      res.json(rendered);
    } catch (e) {
      const status = e.response?.status;
      if (status === 401 || status === 403) {
        return res.status(502).json({ error: 'HubSpot rejected the request.', code: 'HUBSPOT_AUTH' });
      }
      if (status === 429) {
        return res.status(502).json({ error: 'HubSpot rate limit reached.', code: 'HUBSPOT_RATE_LIMIT' });
      }
      logger.error({ err: e.message }, 'POST /api/card-actions/contact-customer/:contactId/email-preview error:');
      res.status(500).json({ error: 'Could not render email preview.' });
    }
  }
);

// ── contact_customer: send follow-up email + log attempt atomically ───────────
// Member-accessible. Fetches the contact email from HubSpot, sends via SMTP
// transport, then in a single transaction upserts contact_attempt_tracking
// (email_sent=true) and inserts a contact_attempt_log row with the auto-note.
// Returns the same response shape as /attempts.
app.post('/api/card-actions/contact-customer/:contactId/send-email',
  isAuthenticated, requirePrivilege('member'), requireHubspotToken,
  _emailAttachUpload.array('attachments', 10),
  async (req, res) => {
    const contactId = req.params.contactId;
    if (!/^\d+$/.test(contactId)) return res.status(400).json({ error: 'Invalid contactId.' });

    const subject = String(req.body?.subject || '').trim();
    const body    = String(req.body?.body    || '').trim();
    if (!subject) return res.status(400).json({ error: 'subject is required.' });
    if (!body)    return res.status(400).json({ error: 'body is required.' });

    try {
      const r = await hubspotRequestWithRetry('get',
        `${HS}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`,
        null,
        { params: { properties: 'email' }, timeout: 15000 }
      );
      const contactEmail = String(r.data?.properties?.email || '').trim();
      if (!contactEmail) {
        return res.status(400).json({ error: 'This contact has no email address on record.' });
      }

      const transport = _createMailTransport();
      if (!transport) {
        return res.status(500).json({ error: 'Email is not configured on this server. Please contact your administrator.' });
      }

      const replyTo = _buildReplyTo();
      const sig = await _buildSenderSignature(req.user?.claims?.sub);
      const fullText = sig.text ? body + '\n\n' + sig.text : body;
      const bodyHtml = plainTextToHtml(body);
      const fullHtml = sig.html ? bodyHtml + sig.html : bodyHtml;
      const attachments = (req.files || []).map(f => ({
        filename:    f.originalname,
        content:     f.buffer,
        contentType: f.mimetype,
      }));
      await transport.sendMail({
        from:    _buildFromHeader(),
        ...(replyTo ? { replyTo } : {}),
        to:      contactEmail,
        subject,
        text:    fullText,
        html:    fullHtml || fullText,
        ...(attachments.length ? { attachments } : {}),
      });

      const userId   = req.user?.claims?.sub;
      const autoNote = `Follow-up email sent: "${subject}"`;
      const client   = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `INSERT INTO contact_attempt_tracking
             (hubspot_contact_id, email_sent, attempted_at, attempted_by, updated_at)
           VALUES ($1, TRUE, NOW(), $2, NOW())
           ON CONFLICT (hubspot_contact_id) DO UPDATE
           SET email_sent = TRUE, attempted_at = NOW(), attempted_by = $2, updated_at = NOW()
           RETURNING call_attempted, email_sent, whatsapp_sent, attempted_at`,
          [contactId, userId || null]
        );
        await client.query(
          `INSERT INTO contact_attempt_log (hubspot_contact_id, method, attempted_by, note)
           VALUES ($1, 'email', $2, $3)`,
          [contactId, userId || null, autoNote]
        );
        const { rows: logRows } = await client.query(
          `SELECT cal.method, cal.attempted_at, cal.note,
                  COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email) AS attempted_by_name
           FROM contact_attempt_log cal
           LEFT JOIN users u ON u.id = cal.attempted_by
           WHERE cal.hubspot_contact_id = $1
             AND cal.attempted_at > COALESCE(
               (SELECT MAX(attempted_at) FROM contact_attempt_history_log
                 WHERE hubspot_contact_id = $1),
               '-infinity'::timestamptz)
           ORDER BY cal.attempted_at DESC`,
          [contactId]
        );
        await client.query('COMMIT');
        res.json({
          ...rows[0],
          attemptLog: logRows.map(row => ({
            method:      row.method,
            attemptedAt: row.attempted_at,
            attemptedBy: row.attempted_by_name || null,
            note:        row.note || null,
          })),
        });
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    } catch (e) {
      if (res.headersSent) return;
      const status = e.response?.status;
      if (status === 401 || status === 403) {
        return res.status(502).json({ error: 'HubSpot rejected the request.', code: 'HUBSPOT_AUTH' });
      }
      if (status === 429) {
        return res.status(502).json({ error: 'HubSpot rate limit reached.', code: 'HUBSPOT_RATE_LIMIT' });
      }
      logger.error({ err: e.message }, 'POST /api/card-actions/contact-customer/:contactId/send-email error:');
      res.status(500).json({ error: 'Could not send email. Please try again.' });
    }
  }
);

// ── contact_customer: advance lead status ────────────────────────────────────
app.post('/api/card-actions/contact-customer/:contactId/advance-status',
  isAuthenticated, requirePrivilege('member'), requireHubspotToken, hubspotMutationLimiter,
  async (req, res) => {
    const contactId = req.params.contactId;
    if (!/^\d+$/.test(contactId)) return res.status(400).json({ error: 'Invalid contactId.' });

    const target = String(req.body?.target || '').toLowerCase();
    const key = _CONTACT_CUSTOMER_MAP[target];
    if (!key) {
      return res.status(400).json({ error: `target must be one of: ${Object.keys(_CONTACT_CUSTOMER_MAP).join(', ')}.` });
    }

    try {
      await assertLeadStatusKey(key);
      await patchContactProperties(contactId, { hs_lead_status: key });

      if (key === 'NO_RESPONSE') {
        const catRow = await pool.query(
          'SELECT call_attempted, email_sent, whatsapp_sent FROM contact_attempt_tracking WHERE hubspot_contact_id = $1',
          [contactId]
        );
        const a = catRow.rows[0] || {};

        // Aggregate the notes logged during this session (every attempt made
        // since the previous committed history row for this contact) so the
        // "Across all sessions" history retains note context.
        const notesRes = await pool.query(
          `SELECT method, note, attempted_at
             FROM contact_attempt_log
            WHERE hubspot_contact_id = $1
              AND note IS NOT NULL
              AND attempted_at > COALESCE(
                (SELECT MAX(attempted_at) FROM contact_attempt_history_log
                  WHERE hubspot_contact_id = $1),
                '-infinity'::timestamptz)
            ORDER BY attempted_at ASC`,
          [contactId]
        );
        const sessionNotes = notesRes.rows.map(r => ({
          method:      r.method,
          note:        r.note,
          attemptedAt: r.attempted_at,
        }));

        await pool.query(
          `INSERT INTO contact_attempt_history_log
             (hubspot_contact_id, attempted_by, call_attempted, email_sent, whatsapp_sent, notes)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            contactId,
            req.user?.claims?.sub || null,
            !!a.call_attempted,
            !!a.email_sent,
            !!a.whatsapp_sent,
            sessionNotes.length ? JSON.stringify(sessionNotes) : null,
          ]
        );
      }

      clearContactCache();
      _invalidateLeadStatusCountsCache();
      _invalidateOpenLeadsCache();
      const meta = getOutcomeMeta('contact_customer', target);
      res.json({ ok: true, advancedTo: key, ...meta });
    } catch (e) {
      if (e.code === 'LEAD_STATUS_REMOVED') {
        return res.status(422).json({ error: e.message, code: 'LEAD_STATUS_REMOVED', removedKey: e.removedKey });
      }
      const status = e.response?.status;
      if (status === 401 || status === 403) {
        return res.status(502).json({ error: 'HubSpot rejected the request.', code: 'HUBSPOT_AUTH' });
      }
      if (status === 429) {
        return res.status(502).json({ error: 'HubSpot rate limit reached.', code: 'HUBSPOT_RATE_LIMIT' });
      }
      logger.error({ err: e.response?.data || e.message }, 'POST /api/card-actions/contact-customer/:contactId/advance-status error:');
      res.status(502).json({ error: e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
    }
  }
);

// ── design_visit_followup: load contact info ─────────────────────────────────
app.post('/api/card-actions/design-visit-followup',
  isAuthenticated, requirePrivilege('member'), requireHubspotToken,
  async (req, res) => {
    const contactId = String(req.body?.contactId || '');
    if (!/^\d+$/.test(contactId)) return res.status(400).json({ error: 'Invalid contactId.' });
    try {
      const r = await hubspotRequestWithRetry('get',
        `${HS}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`,
        null,
        { params: { properties: 'firstname,lastname,email,phone,mobilephone,hs_lead_status,address,city,state,zip,country' }, timeout: 15000 }
      );
      const props = r.data?.properties || {};
      const firstName    = String(props.firstname || '');
      const lastName     = String(props.lastname  || '');
      const contactName  = [firstName, lastName].filter(Boolean).join(' ') || '';
      const contactEmail = String(props.email || '');
      const phone        = String(props.phone || '');
      const mobile       = String(props.mobilephone || '');
      const leadStatus   = props.hs_lead_status || null;
      const contactStructuredAddress = hubspotToAddress({
        address: props.address, city: props.city, state: props.state, zip: props.zip, country: props.country,
      });
      const contactAddress = formatAddress(contactStructuredAddress);
      res.json({ contactName, contactEmail, phone, mobile, leadStatus, contactAddress, contactStructuredAddress });
    } catch (e) {
      const status = e.response?.status;
      if (status === 401 || status === 403) {
        return res.status(502).json({ error: 'HubSpot rejected the request.', code: 'HUBSPOT_AUTH' });
      }
      if (status === 429) {
        return res.status(502).json({ error: 'HubSpot rate limit reached.', code: 'HUBSPOT_RATE_LIMIT' });
      }
      logger.error({ err: e.response?.data || e.message }, 'POST /api/card-actions/design-visit-followup error:');
      res.status(502).json({ error: e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
    }
  }
);

// ── design_visit_followup: record outcome → update HubSpot lead status ────────
app.post('/api/card-actions/design-visit-followup/outcome',
  isAuthenticated, requirePrivilege('member'), requireHubspotToken, hubspotMutationLimiter,
  async (req, res) => {
    const contactId = String(req.body?.contactId || '');
    if (!/^\d+$/.test(contactId)) return res.status(400).json({ error: 'Invalid contactId.' });
    const outcome = String(req.body?.outcome || '');

    // outcome → new lead status (derived from the outcome registry)
    const newLeadStatus = _DVF_STATUS_MAP[outcome];
    if (!newLeadStatus) {
      return res.status(400).json({ error: `outcome must be one of: ${Object.keys(_DVF_STATUS_MAP).join(', ')}.` });
    }

    try {
      await assertLeadStatusKey(newLeadStatus);
      await patchContactProperties(contactId, { hs_lead_status: newLeadStatus });
      const meta = getOutcomeMeta('design_visit_followup', outcome);
      res.json({ ok: true, hs_lead_status: newLeadStatus, ...meta });
    } catch (e) {
      if (e.code === 'LEAD_STATUS_REMOVED') {
        return res.status(422).json({ error: e.message, code: 'LEAD_STATUS_REMOVED', removedKey: e.removedKey });
      }
      const status = e.response?.status;
      if (status === 401 || status === 403) {
        return res.status(502).json({ error: 'HubSpot rejected the request.', code: 'HUBSPOT_AUTH' });
      }
      if (status === 429) {
        return res.status(502).json({ error: 'HubSpot rate limit reached.', code: 'HUBSPOT_RATE_LIMIT' });
      }
      logger.error({ err: e.response?.data || e.message }, 'POST /api/card-actions/design-visit-followup/outcome error:');
      res.status(502).json({ error: e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
    }
  }
);

// ── open_deal: render deposit invoice email preview with real contact vars ────
// Member-accessible (mirrors the access level of the open-deal card action).
// Loads the live email template from the DB, substitutes the caller-supplied
// firstName / depositPercent, and returns { subject, html, text } using the
// same renderEmail pipeline used by the actual send path.
app.post('/api/card-actions/open-deal/deposit-invoice-email-preview',
  isAuthenticated, requirePrivilege('member'),
  async (req, res) => {
    const firstName     = String(req.body?.firstName     ?? '');
    const depositPercent = String(req.body?.depositPercent ?? '10');
    try {
      const template = await getEmailTemplate(getRequiredOutcomeEmailTemplate('open_deal', 'accept'));
      const vars = { firstName, depositPercent };
      const htmlVars = Object.fromEntries(
        Object.entries(vars).map(([k, v]) => [k, escapeHtml(String(v))])
      );
      const rendered = renderEmail(template, { textVars: vars, htmlVars });
      if (!template.body_html.trim()) {
        rendered.html = rendered.text
          .split('\n')
          .map(l => l.trim() === '' ? '' : `<p>${escapeHtml(l)}</p>`)
          .join('');
      }
      res.json(rendered);
    } catch (e) {
      logger.error({ err: e.message }, 'POST /api/card-actions/open-deal/deposit-invoice-email-preview error:');
      res.status(500).json({ error: 'Could not render email preview.' });
    }
  }
);

// ── open_deal: load contact info + QB estimates ──────────────────────────────
app.post('/api/card-actions/open-deal',
  isAuthenticated, requirePrivilege('member'), requireHubspotToken,
  async (req, res) => {
    const contactId = String(req.body?.contactId || '');
    if (!/^\d+$/.test(contactId)) return res.status(400).json({ error: 'Invalid contactId.' });
    try {
      const r = await hubspotRequestWithRetry('get',
        `${HS}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`,
        null,
        { params: { properties: 'firstname,lastname,email,phone,mobilephone,address,city,state,zip,country,hs_lead_status' }, timeout: 15000 }
      );
      const props = r.data?.properties || {};
      const firstName  = String(props.firstname || '');
      const lastName   = String(props.lastname  || '');
      const contactName  = [firstName, lastName].filter(Boolean).join(' ') || '';
      const contactEmail = String(props.email || '');
      const contactPhone = String(props.phone || '');
      const contactMobile = String(props.mobilephone || '');
      const contactStructuredAddress = hubspotToAddress({
        address: props.address, city: props.city, state: props.state, zip: props.zip, country: props.country,
      });
      const contactAddress = formatAddress(contactStructuredAddress);

      // Read deposit percent from qb_settings
      let depositPercent = 10;
      try {
        const sr = await pool.query('SELECT deposit_percent FROM qb_settings LIMIT 1');
        if (sr.rows[0]) depositPercent = Number(sr.rows[0].deposit_percent ?? 10);
      } catch {}

      // Try to fetch QB estimates for this contact (graceful if QB not connected)
      let qbConnected = false;
      let estimates = [];
      try {
        const estData = await quickbooksRoutes.fetchFromQuickBooks('/query', {
          query: `SELECT * FROM Estimate WHERE CustomerRef = '${contactId}' MAXRESULTS 100`,
        });
        qbConnected = true;
        estimates = (estData.QueryResponse?.Estimate || []).map(e => ({
          id:           e.Id,
          docNumber:    e.DocNumber || null,
          txnDate:      e.TxnDate  || null,
          totalAmt:     parseFloat(e.TotalAmt || 0),
          txnStatus:    e.TxnStatus || 'Pending',
          billEmail:    e.BillEmail?.Address || null,
          customerRef:  e.CustomerRef?.value || null,
        }));
      } catch (qbErr) {
        if (!String(qbErr.message).includes('not connected')) {
          logger.warn({ err: qbErr.message }, '[open-deal] QB estimates fetch failed:');
        }
      }

      res.json({
        contactName,
        contactEmail,
        contactPhone,
        contactMobile,
        contactAddress,
        contactStructuredAddress,
        depositPercent,
        qbConnected,
        estimates,
      });
    } catch (e) {
      const status = e.response?.status;
      if (status === 401 || status === 403) {
        return res.status(502).json({ error: 'HubSpot rejected the request.', code: 'HUBSPOT_AUTH' });
      }
      if (status === 429) {
        return res.status(502).json({ error: 'HubSpot rate limit reached.', code: 'HUBSPOT_RATE_LIMIT' });
      }
      logger.error({ err: e.response?.data || e.message }, 'POST /api/card-actions/open-deal error:');
      res.status(502).json({ error: e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
    }
  }
);

// ── deposit_invoice_followup: loader ─────────────────────────────────────────
// Fetches HubSpot contact props + deposit invoice from QB (via stored
// deposit_invoice_id on design_visits).  Returns payment-state summary.
app.post('/api/card-actions/deposit-invoice',
  isAuthenticated, requireManagerOrAdmin, requireHubspotToken,
  async (req, res) => {
    const contactId = String(req.body?.contactId || '');
    if (!/^\d+$/.test(contactId)) return res.status(400).json({ error: 'Invalid contactId.' });

    try {
      const r = await hubspotRequestWithRetry('get',
        `${HS}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`,
        null,
        { params: { properties: 'firstname,lastname,email,phone,mobilephone,address,city,state,zip,country' }, timeout: 15000 }
      );
      const props = r.data?.properties || {};
      const firstName     = String(props.firstname || '');
      const lastName      = String(props.lastname  || '');
      const contactName   = [firstName, lastName].filter(Boolean).join(' ') || '';
      const contactEmail  = String(props.email   || '');
      const contactPhone  = String(props.phone   || '');
      const contactMobile = String(props.mobilephone || '');
      const contactStructuredAddress = hubspotToAddress({
        address: props.address, city: props.city, state: props.state, zip: props.zip, country: props.country,
      });
      const contactAddress = formatAddress(contactStructuredAddress);

      // Look up deposit_invoice_id + qb_estimate_id from the most-recent design_visit
      let storedInvoiceId  = null;
      let storedDocNum     = null;
      let storedEstimateId = null;
      try {
        const dvRow = await pool.query(
          `SELECT deposit_invoice_id, deposit_invoice_doc_num, qb_estimate_id
           FROM design_visits
           WHERE contact_id = $1
             AND deposit_invoice_id IS NOT NULL
           ORDER BY created_at DESC
           LIMIT 1`,
          [contactId]
        );
        if (dvRow.rows[0]) {
          storedInvoiceId  = dvRow.rows[0].deposit_invoice_id;
          storedDocNum     = dvRow.rows[0].deposit_invoice_doc_num || null;
          storedEstimateId = dvRow.rows[0].qb_estimate_id || null;
        }
      } catch {}

      let qbConnected      = false;
      let invoiceId        = storedInvoiceId;
      let invoiceDocNum    = storedDocNum;
      let invoiceTotalAmt  = 0;
      let invoiceBalance   = 0;
      let invoicePaidAmt   = 0;
      let invoiceTxnDate   = null;
      let invoiceLink      = null;
      let paymentState     = 'unknown';

      try {
        let invoiceData = null;
        if (invoiceId) {
          // Fetch by stored ID with ownership validation
          const invData = await quickbooksRoutes.fetchFromQuickBooks(`/invoice/${encodeURIComponent(invoiceId)}`);
          invoiceData = invData?.Invoice ?? null;
          if (invoiceData) {
            const owner = String(invoiceData.CustomerRef?.value || '');
            if (owner && owner !== contactId) {
              logger.warn(
                { invoiceId, owner, contactId },
                '[deposit-invoice] Stored invoice belongs to different contact — ignoring'
              );
              invoiceData = null;
              invoiceId   = null;
            }
          }
        } else {
          // Fall back to querying by CustomerRef
          const qResult = await quickbooksRoutes.fetchFromQuickBooks('/query', {
            query: `SELECT * FROM Invoice WHERE CustomerRef = '${contactId}' MAXRESULTS 1`,
          });
          const rows = qResult?.QueryResponse?.Invoice || [];
          if (rows.length > 0) invoiceData = rows[0];
        }
        qbConnected = true;

        if (invoiceData) {
          invoiceId       = invoiceData.Id || invoiceId;
          invoiceDocNum   = invoiceData.DocNumber || invoiceDocNum || null;
          invoiceTotalAmt = parseFloat(invoiceData.TotalAmt || 0);
          invoiceBalance  = parseFloat(invoiceData.Balance  || 0);
          invoicePaidAmt  = invoiceTotalAmt - invoiceBalance;
          invoiceTxnDate  = invoiceData.TxnDate || null;
          invoiceLink     = invoiceData.InvoiceLink || null;

          if (invoiceBalance <= 0 && invoiceTotalAmt > 0) {
            paymentState = 'paid';
          } else if (invoicePaidAmt > 0 && invoiceBalance > 0) {
            paymentState = 'partial';
          } else {
            paymentState = 'unpaid';
          }
        }
      } catch (qbErr) {
        if (!String(qbErr.message).includes('not connected')) {
          logger.warn({ err: qbErr.message }, '[deposit-invoice] QB invoice fetch failed:');
        }
      }

      res.json({
        contactName,
        contactEmail,
        contactPhone,
        contactMobile,
        contactAddress,
        contactStructuredAddress,
        qbConnected,
        paymentState,
        invoiceId,
        invoiceDocNum,
        invoiceTotalAmt,
        invoiceBalance,
        invoicePaidAmt,
        invoiceTxnDate,
        invoiceLink,
        qbEstimateId: storedEstimateId || null,
      });
    } catch (e) {
      const status = e.response?.status;
      if (status === 401 || status === 403) {
        return res.status(502).json({ error: 'HubSpot rejected the request.', code: 'HUBSPOT_AUTH' });
      }
      if (status === 429) {
        return res.status(502).json({ error: 'HubSpot rate limit reached.', code: 'HUBSPOT_RATE_LIMIT' });
      }
      logger.error({ err: e.response?.data || e.message }, 'POST /api/card-actions/deposit-invoice error:');
      res.status(502).json({ error: e.message || 'Unexpected error reaching HubSpot.', code: 'HUBSPOT_ERROR' });
    }
  }
);

// ── deposit_invoice_followup: resend invoice via QB email ────────────────────
app.post('/api/card-actions/deposit-invoice/resend',
  isAuthenticated, requireManagerOrAdmin,
  async (req, res) => {
    const contactId  = String(req.body?.contactId  || '');
    const invoiceId  = String(req.body?.invoiceId  || '');
    const recipientEmail = String(req.body?.recipientEmail || '').trim();
    if (!/^\d+$/.test(contactId)) return res.status(400).json({ error: 'Invalid contactId.' });
    if (!/^\d+$/.test(invoiceId)) return res.status(400).json({ error: 'Invalid invoiceId.' });

    try {
      const allowed = await quickbooksRoutes.checkSendRateLimit(req.user.claims.sub);
      if (!allowed) {
        return res.status(429).json({ error: 'Send rate limit reached. Please wait before re-sending.', code: 'RATE_LIMIT' });
      }

      // Ownership check: ensure the invoice belongs to this contact
      const invData = await quickbooksRoutes.fetchFromQuickBooks(`/invoice/${encodeURIComponent(invoiceId)}`);
      const inv = invData?.Invoice;
      if (!inv) return res.status(404).json({ error: 'Invoice not found in QuickBooks.', code: 'INVOICE_NOT_FOUND' });
      const invOwner = String(inv?.CustomerRef?.value || '');
      if (invOwner !== contactId) {
        return res.status(403).json({ error: 'Invoice does not belong to this contact.', code: 'INVOICE_OWNER_MISMATCH' });
      }

      await quickbooksRoutes.sendQbTransactionEmail('invoice', invoiceId, {
        sendTo: recipientEmail || undefined,
      });

      res.json({ ok: true });
    } catch (e) {
      if (String(e.message).includes('not connected')) {
        return res.status(503).json({ error: 'QuickBooks is not connected.', code: 'QB_NOT_CONNECTED' });
      }
      if (e.response?.status === 429) {
        return res.status(429).json({ error: 'QuickBooks rate limit reached.', code: 'QB_RATE_LIMIT' });
      }
      logger.error({ err: e.response?.data || e.message }, 'POST /api/card-actions/deposit-invoice/resend error:');
      res.status(502).json({ error: e.message || 'Could not re-send invoice.', code: 'QB_ERROR' });
    }
  }
);

// Mail helpers shared by deposit-invoice handlers ─────────────────────────────
function _depInv_buildFromHeader() {
  const raw = (process.env.SMTP_FROM || process.env.SMTP_USER || '').trim();
  if (!raw) return raw;
  if (/</.test(raw)) return raw;
  return `Harry Wardrobes <${raw}>`;
}
function _depInv_buildReplyTo() {
  return (process.env.SMTP_REPLY_TO || process.env.SMTP_FROM || process.env.SMTP_USER || '').trim();
}
function _createMailTransport() {
  if (process.env.MAIL_TRANSPORT_FILE_OVERRIDE) {
    const fpath = process.env.MAIL_TRANSPORT_FILE_OVERRIDE;
    return {
      sendMail(opts) {
        return new Promise((resolve, reject) => {
          try {
            require('fs').appendFileSync(fpath, JSON.stringify(opts) + '\n');
            resolve({ messageId: `override-${Date.now()}` });
          } catch (e) { reject(e); }
        });
      },
    };
  }
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return require('nodemailer').createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: parseInt(process.env.SMTP_PORT || '587', 10) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}
function _buildFromHeader() { return _depInv_buildFromHeader(); }
function _buildReplyTo()    { return _depInv_buildReplyTo(); }

async function _sendTaskAssignmentNotification({ assignedUserId, creatorName, taskName, taskDescription, contactName, deadline, isReassignment = false }) {
  const transport = _createMailTransport();
  if (!transport) return;

  const { rows } = await pool.query(
    'SELECT email, first_name FROM users WHERE id = $1',
    [assignedUserId]
  );
  if (!rows.length || !rows[0].email) return;

  const assignee = rows[0];
  const deadlineStr = deadline.toLocaleString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const subject = isReassignment
    ? (contactName ? `Task reassigned to you – ${contactName}` : 'Task reassigned to you')
    : (contactName ? `New task assigned to you – ${contactName}` : 'New task assigned to you');

  const actionLine = isReassignment
    ? `${creatorName} has reassigned a task to you.`
    : `${creatorName} has assigned you a new task.`;

  const lines = [
    `Hi ${assignee.first_name || 'there'},`,
    '',
    actionLine,
    '',
    `Task: ${taskName}`,
    ...(taskDescription ? [`Description: ${taskDescription}`] : []),
    ...(contactName    ? [`Customer: ${contactName}`]         : []),
    `Due: ${deadlineStr}`,
    '',
    'Log in to Harry Wardrobes to view your tasks.',
  ];
  const text = lines.join('\n');
  const html = lines
    .map(l => l === '' ? '<br>' : `<p style="margin:0 0 4px">${escapeHtml(l)}</p>`)
    .join('');

  await transport.sendMail({
    from: _buildFromHeader(),
    to: assignee.email,
    subject,
    text,
    html,
  });
}

async function _sendTaskUnassignmentNotification({ previousAssignedUserId, creatorName, taskName, contactName }) {
  const transport = _createMailTransport();
  if (!transport) return;

  const { rows } = await pool.query(
    'SELECT email, first_name FROM users WHERE id = $1',
    [previousAssignedUserId]
  );
  if (!rows.length || !rows[0].email) return;

  const assignee = rows[0];

  const subject = contactName
    ? `Task unassigned – ${contactName}`
    : 'A task has been unassigned from you';

  const lines = [
    `Hi ${assignee.first_name || 'there'},`,
    '',
    `${creatorName} has reassigned the following task away from you.`,
    '',
    `Task: ${taskName}`,
    ...(contactName ? [`Customer: ${contactName}`] : []),
    '',
    'Log in to Harry Wardrobes to view your current tasks.',
  ];
  const text = lines.join('\n');
  const html = lines
    .map(l => l === '' ? '<br>' : `<p style="margin:0 0 4px">${escapeHtml(l)}</p>`)
    .join('');

  await transport.sendMail({
    from: _buildFromHeader(),
    to: assignee.email,
    subject,
    text,
    html,
  });
}

// ── deposit_invoice_followup: not-proceeding → DECLINED_DEAL ─────────────────
// Shares the decline-deal pipeline: reject pending estimate, optionally void
// the invoice, optionally send an editable thank-you email, then set lead
// status to DECLINED_DEAL.
app.post('/api/card-actions/deposit-invoice/not-proceeding',
  isAuthenticated, requireManagerOrAdmin,
  async (req, res) => {
    const contactId    = String(req.body?.contactId    || '');
    const contactEmail = String(req.body?.contactEmail || '').trim() || null;
    const contactName  = String(req.body?.contactName  || '').trim() || '';
    const sendThankYou = req.body?.sendThankYou === true;
    const voidInvoice  = req.body?.voidInvoice  === true;
    const invoiceId    = req.body?.invoiceId ? String(req.body.invoiceId).trim() : null;
    const emailSubject = req.body?.emailSubject ? String(req.body.emailSubject).trim() : null;
    const emailBody    = req.body?.emailBody    ? String(req.body.emailBody).trim()    : null;

    if (!/^\d+$/.test(contactId)) return res.status(400).json({ error: 'Invalid contactId.' });
    if (invoiceId && !/^\d+$/.test(invoiceId)) return res.status(400).json({ error: 'Invalid invoiceId.' });

    const steps = {
      estimateRejected:  false,
      invoiceVoided:     false,
      thankYouSent:      false,
      statusUpdated:     false,
    };

    try {
      // Look up linked estimate from design_visits (non-fatal if absent)
      let linkedEstimateId = null;
      try {
        const dvEst = await pool.query(
          `SELECT qb_estimate_id FROM design_visits
           WHERE contact_id = $1 AND qb_estimate_id IS NOT NULL
           ORDER BY created_at DESC LIMIT 1`,
          [contactId]
        );
        linkedEstimateId = dvEst.rows[0]?.qb_estimate_id || null;
      } catch {}

      // 1. Reject linked estimate in QB (delegates to same logic as decline-deal; non-fatal)
      if (linkedEstimateId) {
        try {
          const t = await quickbooksRoutes.getValidTokens();
          if (t) {
            const qbBase  = quickbooksRoutes.getQuickBooksBaseUrl();
            const authHdr = { Authorization: `Bearer ${t.access_token}` };
            const jsonHdr = { ...authHdr, 'Content-Type': 'application/json', Accept: 'application/json' };
            const qbPrm   = { minorversion: 65 };
            const oResp = await require('axios').get(
              `${qbBase}/v3/company/${t.realm_id}/estimate/${encodeURIComponent(linkedEstimateId)}`,
              { headers: { ...authHdr, Accept: 'application/json' }, params: qbPrm, timeout: 8000 }
            );
            const est = oResp.data?.Estimate;
            const estOwner = String(est?.CustomerRef?.value || '');
            if (est && estOwner === contactId && est.SyncToken != null) {
              await require('axios').post(
                `${qbBase}/v3/company/${t.realm_id}/estimate`,
                { sparse: true, Id: linkedEstimateId, SyncToken: est.SyncToken, TxnStatus: 'Rejected' },
                { headers: jsonHdr, params: qbPrm, timeout: 8000 }
              );
              steps.estimateRejected = true;
            }
          }
        } catch (e) {
          logger.warn({ err: e.message }, '[deposit-invoice/not-proceeding] reject estimate failed (non-fatal):');
        }
      } else {
        steps.estimateRejected = true; // nothing to reject
      }

      // 2. Optionally void the deposit invoice.
      //    ENFORCEMENT: only unpaid invoices (Balance > 0) may be voided.
      //    Attempting to void a paid invoice is a hard 400 — callers cannot
      //    bypass the UI restriction by posting directly to this route.
      if (voidInvoice && invoiceId) {
        const vt = await quickbooksRoutes.getValidTokens();
        if (vt) {
          const vBase    = quickbooksRoutes.getQuickBooksBaseUrl();
          const vAuthHdr = { Authorization: `Bearer ${vt.access_token}` };
          const vPrm     = { minorversion: 65 };
          const vResp = await require('axios').get(
            `${vBase}/v3/company/${vt.realm_id}/invoice/${encodeURIComponent(invoiceId)}`,
            { headers: { ...vAuthHdr, Accept: 'application/json' }, params: vPrm, timeout: 8000 }
          );
          const vInv = vResp.data?.Invoice;
          if (vInv && Number(vInv.Balance || 0) <= 0) {
            return res.status(400).json({
              error: 'Invoice is already paid and cannot be voided.',
              code: 'INVOICE_ALREADY_PAID',
              steps,
            });
          }
          // Invoice is unpaid — proceed with void (non-fatal for QB write errors)
          try {
            const vOwner  = String(vInv?.CustomerRef?.value || '');
            if (vInv && vOwner === contactId && vInv.SyncToken != null) {
              const vJsonHdr = { ...vAuthHdr, 'Content-Type': 'application/json', Accept: 'application/json' };
              await require('axios').post(
                `${vBase}/v3/company/${vt.realm_id}/invoice`,
                { sparse: true, Id: invoiceId, SyncToken: vInv.SyncToken, void: true },
                { headers: vJsonHdr, params: vPrm, timeout: 8000 }
              );
              steps.invoiceVoided = true;
            }
          } catch (e) {
            logger.warn({ err: e.message }, '[deposit-invoice/not-proceeding] void invoice failed (non-fatal):');
          }
        } else {
          steps.invoiceVoided = false;
        }
      } else {
        steps.invoiceVoided = !voidInvoice;
      }

      // 3. Optional thank-you email — uses caller-provided subject/body when supplied,
      //    otherwise falls back to the open_deal_declined_thank_you template.
      if (sendThankYou && contactEmail) {
        try {
          const { getEmailTemplate, renderEmail } = require('./email-templates');
          const template  = await getEmailTemplate(getRequiredOutcomeEmailTemplate('deposit_invoice_followup', 'not_proceeding'));
          const firstName = contactName.split(' ')[0] || 'there';
          const rendered  = renderEmail(template, { textVars: { firstName } });
          const sig       = await _buildSenderSignature(req.user?.claims?.sub);
          const transport = _createMailTransport();
          if (transport) {
            const replyTo  = _buildReplyTo();
            const baseText = emailBody    || rendered.text;
            const baseHtml = emailBody    || rendered.html || rendered.text;
            const fullText = sig.text ? baseText + '\n\n' + sig.text : baseText;
            const fullHtml = sig.html ? baseHtml + sig.html             : baseHtml;
            await transport.sendMail({
              from:    _buildFromHeader(),
              ...(replyTo ? { replyTo } : {}),
              to:      contactEmail,
              subject: emailSubject || rendered.subject,
              text:    fullText,
              html:    fullHtml,
            });
            steps.thankYouSent = true;
            await logCustomerEmailAttempt(contactId, req.user?.claims?.sub, 'Deposit/decline thank-you email sent');
          }
        } catch (e) {
          logger.warn({ err: e.message }, '[deposit-invoice/not-proceeding] thank-you email failed (non-fatal):');
        }
      } else {
        steps.thankYouSent = !sendThankYou;
      }

      // 4. Update lead status (from outcome registry: deposit_invoice_followup not_proceeding)
      const _diNotProceedingStatus = _DI_TERMINAL_STATUS['not_proceeding'] ?? 'DECLINED_DEAL';
      try {
        await assertLeadStatusKey(_diNotProceedingStatus);
        await patchContactProperties(contactId, { hs_lead_status: _diNotProceedingStatus });
        steps.statusUpdated = true;
      } catch (e) {
        if (e.code === 'LEAD_STATUS_REMOVED') {
          return res.status(422).json({
            error: e.message, code: 'LEAD_STATUS_REMOVED', removedKey: e.removedKey, steps,
          });
        }
        logger.error({ err: e.message }, '[deposit-invoice/not-proceeding] lead status update failed:');
        return res.status(502).json({
          error: `Steps completed but lead status could not be updated: ${e.message}`, steps,
        });
      }

      const meta = getOutcomeMeta('deposit_invoice_followup', 'not_proceeding');
      res.json({ ok: true, steps, hs_lead_status: _diNotProceedingStatus, ...meta });
    } catch (e) {
      logger.error({ err: e.response?.data || e.message }, 'POST /api/card-actions/deposit-invoice/not-proceeding error:');
      res.status(503).json({ error: e.message, steps });
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
    logger.error({ err: e.response?.data || e.message }, 'GET /api/whatsapp/templates error:');
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
  if (!getCredential('access_token')) {
    return res.status(503).json({ error: 'HubSpot is not configured — cannot verify contact phone number.' });
  }
  try {
    const hsContact = await axios.get(`${HS}/crm/v3/objects/contacts/${encodeURIComponent(safeContactId)}`, {
      headers: getHubSpotHeaders(),
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
    logger.error({ err: e.response?.data || e.message }, 'WhatsApp send — HubSpot contact lookup error:');
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
      [safeContactId, req.user?.claims?.sub, mode, tplName, tplParams, messageText]
    ).catch(e => logger.error({ err: e.message }, 'whatsapp_messages insert error:'));

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
    logger.error({ err: metaErr || e.message }, 'POST /api/whatsapp/send error:');
    res.status(502).json({ error: metaMsg || 'Failed to send WhatsApp message.' });
  }
});

// ── WhatsApp Message Log ──────────────────────────────────────────────────────

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
    logger.error({ err: e.message }, 'GET /api/whatsapp/history error:');
    res.status(500).json({ error: 'Could not load WhatsApp history.' });
  }
});


app.get('/api/search-settings', isAuthenticated, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT disabled_actions, hint_placeholder, action_order FROM search_settings WHERE id = 1'
    );
    res.json(rows[0] || { disabled_actions: [], hint_placeholder: '', action_order: [] });
  } catch (e) {
    logger.error({ err: e.message }, 'GET /api/search-settings error:');
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
    logger.error({ err: e.message }, 'GET /api/admin/search-settings error:');
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
    logger.error({ err: e.message }, 'PUT /api/admin/search-settings error:');
    res.status(500).json({ error: 'Could not save search settings.' });
  }
});

// ── One-time startup cleanup ───────────────────────────────────────────────────
// Removes HubSpot credential override rows that were previously stored in
// admin_settings but are no longer read by any code path.  Safe to re-run on
// every boot because DELETE WHERE key = '…' is a no-op once the rows are gone.
async function cleanupStaleHubSpotCredentialRows() {
  const STALE_KEYS = [
    'hubspot_access_token_override',
    'hubspot_app_id_override',
    'hubspot_client_secret_override',
  ];
  const { rowCount, rows } = await pool.query(
    `DELETE FROM admin_settings WHERE key = ANY($1::text[]) RETURNING key`,
    [STALE_KEYS],
  );
  if (rowCount > 0) {
    const removed = rows.map(r => r.key).join(', ');
    logger.info(`  [migration] Removed ${rowCount} stale HubSpot credential row(s) from admin_settings.`);
    await logAdminAction(
      '[system]',
      'startup_migration',
      null,
      `cleanupStaleHubSpotCredentialRows: removed ${rowCount} stale admin_settings row(s): ${removed}`,
    );
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
(async () => {
  // Run database migrations FIRST so the full schema exists before auth/session
  // setup or any route handling.  A migration failure is fatal — the process must
  // not start serving against an unknown/partial schema.
  //
  // Migrations are the sole source of truth for the schema. In production the
  // default deploy path (docs/deploy.md) applies them with a pre-deploy
  // `npm run db:migrate` against the target DATABASE_URL, before rolling out
  // new instances — this avoids every instance racing to run migrations at
  // boot on a multi-instance host (Cloud Run). Setting RUN_MIGRATIONS_ON_BOOT=true
  // opts production into running migrations at boot exactly as development does
  // instead (suited to single-instance hosts). When the flag is unset, production
  // behaviour skips boot-time migrations and only self-heals the rate-limit
  // records.
  if (process.env.NODE_ENV !== 'production' || process.env.RUN_MIGRATIONS_ON_BOOT === 'true') {
    try {
      await runMigrations();
      logger.info('  Database migrations applied');
    } catch (e) {
      logger.error({ err: e }, '  Database migrations failed — aborting startup');
      process.exit(1);
    }
  } else {
    logger.info('  Skipping boot-time migrations (set RUN_MIGRATIONS_ON_BOOT=true to enable)');
  }

  // The rate-limit package's migration records must be present in the
  // public.migrations table or it crashes on boot with
  // "relation unique_session_key already exists".  This self-heal is safe to run
  // in all environments — it only inserts missing rows — and must fire on every
  // path (runMigrations() also calls it, but the skip path above does not, so we
  // run it here unconditionally to guarantee it always happens).
  try {
    await ensureRateLimitMigrations(process.env.DATABASE_URL);
    logger.info('  Rate-limit migration records verified');
  } catch (e) {
    logger.error({ err: e }, '  ensureRateLimitMigrations failed — aborting startup');
    process.exit(1);
  }

  // In development, force dev_mode_enabled ON on every startup so real HubSpot
  // contacts are never accidentally exposed on localhost. Uses DO UPDATE so an
  // existing row (e.g. previously toggled OFF) is reset to true on each restart.
  if (process.env.NODE_ENV !== 'production') {
    try {
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ('dev_mode_enabled', 'true')
         ON CONFLICT (key) DO UPDATE SET value = 'true'`
      );
      logger.info('  HubSpot dev mode forced ON (development)');
    } catch (e) {
      logger.warn({ err: e.message }, '  Could not set dev_mode_enabled — contacts may show without filter');
    }
  }

  // Schedule the google_maps_usage pruner now that the schema is guaranteed to
  // exist.  Running it here (post-migration) prevents the spurious
  // "relation does not exist" warning that occurred when it ran at module load.
  schedulePruneOldUsage();

  try {
    const ok = await setupAuth(app);
    if (ok) logger.info('  Auth (email + password) initialized');
  } catch (e) {
    logger.error({ err: e.message }, '  Auth setup failed:');
  }

  // 404 catch-all must be registered AFTER setupAuth so auth routes are matched first.
  app.use((req, res) => {
    res.status(404).render('404', { title: 'Page Not Found · Harry Wardrobes' });
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
          logger.warn(`[STALE BUNDLE] public/react/main.js is older than ${rel} — run npm run build:react`);
        }
      } else {
        logger.warn('[STALE BUNDLE] public/react/main.js not found — run npm run build:react');
      }
    } catch (e) {
      // Non-fatal: a warning failure must not prevent startup.
    }
  }

  app.listen(PORT, HOST, async () => {
    logger.info(`\n  Harry Wardrobes`);
    logger.info(`  Running at: http://localhost:${PORT}\n`);
    if (process.env.DEBUG_HUBSPOT) {
      logger.warn('[DEBUG] DEBUG_HUBSPOT is enabled — verbose HubSpot rate-limit and stale-cache logs are active. Unset this flag in production.');
    }
    await ensureHubSpotProperties();
    // NOTE: all table / column / index DDL is now owned by the migration
    // framework (see migrations/ and runMigrations() at the top of this IIFE).
    // The steps below perform non-DDL boot work only: HubSpot property sync,
    // one-time data backfills/migrations, default seeds, retention cleanup,
    // and handler auto-binding.
    try { await ensureTradesTable(); }
    catch (e) { logger.error({ err: e }, '  Trades legacy data migration failed'); }
    try { await ensureLeadStatusTable(); }
    catch (e) { logger.error({ err: e }, '  Lead status seed failed'); }
    try { await checkHardcodedLeadStatusKeys(); }
    catch (e) { logger.error({ err: e }, '  Hardcoded lead status key check failed'); }
    try { await ensureContactCustomerHandlerBindings(); }
    catch (e) { logger.error({ err: e }, '  Contact customer handler binding setup failed'); }
    try { await ensureStartDesignVisitHandlerBindings(); }
    catch (e) { logger.error({ err: e }, '  Start design visit handler binding setup failed'); }
    try { await ensureStartSurveyVisitHandlerBindings(); }
    catch (e) { logger.error({ err: e }, '  Start survey visit handler binding setup failed'); }
    try { await seedStageActionLabelsDefaults(); }
    catch (e) { logger.error({ err: e }, '  Stage action labels seed failed'); }
    try { await ensureHwTestUserProperty(); }
    catch (e) { logger.error({ err: e }, '  hw_test_user property setup failed'); }
    try { await checkDuplicateHandlerBindings(); }
    catch (e) { logger.error({ err: e }, '  Card action handler duplicate-binding check failed'); }
    try { await ensureResendLogTable(); }
    catch (e) { logger.error({ err: e }, '  Customer info resend log cleanup failed'); }
    backfillMaskedEmails().catch(e => logger.warn({ err: e }, '  masked_email backfill error'));
    logNullFormLinkCount().catch(e => logger.warn({ err: e }, '  null form_link count error'));
    try { await ensurePhotoReviewOutcomesTable(); }
    catch (e) { logger.error({ err: e }, '  Photo review outcomes backfill failed'); }
    try { await ensurePageFilterConfigTable(); }
    catch (e) { logger.error({ err: e }, '  Page filter config seed failed'); }
    try { await ensureEmailTemplatesTable(); }
    catch (e) { logger.error({ err: e }, '  Email templates seed failed'); }
    try { await cleanupStaleHubSpotCredentialRows(); }
    catch (e) { logger.error({ err: e }, '  HubSpot credential row cleanup failed'); }
    scheduleConflictDigest();
  });
})();
