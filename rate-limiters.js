const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { PostgresStoreIndividualIP } = require('@acpr/rate-limit-postgresql');

function getUserRateLimitKey(req) {
  return req.user?.claims?.sub || ipKeyGenerator(req.ip);
}

function createUserRateLimiter({ windowMs, max, prefix, message }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: getUserRateLimitKey,
    store: new PostgresStoreIndividualIP(
      { connectionString: process.env.DATABASE_URL },
      prefix
    ),
    handler: (req, res) => {
      res.status(429).json({ error: message || 'Too many requests. Please slow down and try again later.' });
    },
  });
}

const hubspotMutationLimiter = createUserRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 120,
  prefix: 'hs_mutation',
  message: 'Too many HubSpot updates from your account. Please wait a few minutes and try again.',
});

const gmailSendLimiter = createUserRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 20,
  prefix: 'gmail_send',
  message: 'Email send limit reached. Please wait before sending more emails.',
});

const photoUploadLimiter = createUserRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  prefix: 'photo_upload',
  message: 'Too many profile photo uploads. Please wait an hour before trying again.',
});

const quickbooksReadWriteLimiter = createUserRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 60,
  prefix: 'qb_rw',
  message: 'Too many QuickBooks requests. Please wait a few minutes and try again.',
});

const calendarEventLimiter = createUserRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 30,
  prefix: 'gcal_event',
  message: 'Calendar event limit reached. Please wait before creating more events.',
});

const personalTaskCreateLimiter = createUserRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 60,
  prefix: 'personal_task_create',
  message: 'Too many personal tasks created. Please wait before adding more.',
});

const tradesCreateLimiter = createUserRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 30,
  prefix: 'trades_create',
  message: 'Too many trade entries created. Please wait before adding more.',
});

const prefsWriteLimiter = createUserRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 60,
  prefix: 'prefs_write',
  message: 'Too many preference updates. Please wait a moment and try again.',
});

// ── Universal API backstop ───────────────────────────────────────────────────
// Shared options for the generous "backstop" limiter mounted at the *front* of
// every middleware chain: app-level in server.js (before any route, so even
// public pages, the webhook receiver, and authorization middleware sit behind
// it) and router-level in each feature router. The strict per-feature limiters
// above still guard the expensive endpoints; this one exists so that no
// authorization- or database-touching handler is reachable without passing
// some rate limit (CodeQL js/missing-rate-limiting).
//
// Design notes:
// - Default in-memory store, not Postgres: this runs on every request, so a
//   DB round-trip per hit would be pure overhead. Per-Cloud-Run-instance
//   counting is acceptable for a coarse abuse backstop.
// - Enforced in production only: the test harnesses replay hundreds of
//   requests per minute from a single process (e.g. the privilege matrix) and
//   cannot reset an in-memory store between suites the way
//   resetRateLimitStore() wipes the Postgres store.
// - Callers construct the limiter with their own in-file `rateLimit()` call
//   (one instance per mount) — sharing a single instance across mounts would
//   double-count any request that passes through two of them.
const backstopEnforced = process.env.NODE_ENV === 'production';

function apiBackstopOptions({ windowMs = 60 * 1000, max = 600 } = {}) {
  return {
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => !backstopEnforced,
    keyGenerator: getUserRateLimitKey,
    handler: (req, res) => {
      res.status(429).json({ error: 'Too many requests. Please slow down and try again later.' });
    },
  };
}

const whatsappSendLimiter = createUserRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 30,
  prefix: 'whatsapp_send',
  message: 'WhatsApp send limit reached. Please wait before sending more messages.',
});

module.exports = {
  createUserRateLimiter,
  getUserRateLimitKey,
  apiBackstopOptions,
  hubspotMutationLimiter,
  gmailSendLimiter,
  photoUploadLimiter,
  quickbooksReadWriteLimiter,
  calendarEventLimiter,
  personalTaskCreateLimiter,
  tradesCreateLimiter,
  prefsWriteLimiter,
  whatsappSendLimiter,
};
