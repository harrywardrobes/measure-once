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

const whatsappSendLimiter = createUserRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 30,
  prefix: 'whatsapp_send',
  message: 'WhatsApp send limit reached. Please wait before sending more messages.',
});

module.exports = {
  createUserRateLimiter,
  getUserRateLimitKey,
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
