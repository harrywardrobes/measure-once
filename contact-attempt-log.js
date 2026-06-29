// contact-attempt-log.js — shared "last contacted" logging helper.
//
// Records that a staff member contacted a customer so the activity surfaces in
// the "last contacted" card / priority sort on the customers page. Mirrors the
// logging done inline by the contact_customer send-email route
// (POST /api/card-actions/contact-customer/:contactId/send-email): it upserts
// contact_attempt_tracking (email_sent = TRUE) and inserts a contact_attempt_log
// row (method = 'email').
//
// Used by every staff→customer email send site (upload-photos invite/resend,
// design- & survey-visit summaries and resends, QuickBooks accept/decline,
// deposit-invoice follow-up, photo-review outcomes) so they all reflect in the
// same "last contacted" surface that the contact-customer modal already feeds.

const logger = require('./logger');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/** Coerce a user id (numeric string or integer) to an integer PK, else null. */
function toUserId(userId) {
  if (Number.isInteger(userId)) return userId;
  if (typeof userId === 'string' && /^\d+$/.test(userId)) return parseInt(userId, 10);
  return null;
}

/**
 * Record an email contact attempt against a HubSpot contact.
 *
 * Best-effort: never throws. A logging failure must never roll back or surface
 * on an email that already went out — the customer was still contacted.
 *
 * @param {string|number} contactId  HubSpot contact id (numeric)
 * @param {string|number|null} userId  staff user PK (req.user?.claims?.sub / req.user?.id)
 * @param {string} note  short auto-note describing the email (e.g. 'Photo upload link sent')
 */
async function logCustomerEmailAttempt(contactId, userId, note) {
  const cid = String(contactId == null ? '' : contactId).trim();
  if (!/^\d+$/.test(cid)) return;
  const uid = toUserId(userId);
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO contact_attempt_tracking
         (hubspot_contact_id, email_sent, attempted_at, attempted_by, updated_at)
       VALUES ($1, TRUE, NOW(), $2, NOW())
       ON CONFLICT (hubspot_contact_id) DO UPDATE
       SET email_sent = TRUE, attempted_at = NOW(), attempted_by = $2, updated_at = NOW()`,
      [cid, uid]
    );
    await client.query(
      `INSERT INTO contact_attempt_log (hubspot_contact_id, method, attempted_by, note)
       VALUES ($1, 'email', $2, $3)`,
      [cid, uid, note ? String(note).slice(0, 500) : null]
    );
    await client.query('COMMIT');
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    logger.warn({ err: err.message, contactId: cid }, '[contact-attempt-log] Failed to log customer email attempt');
  } finally {
    if (client) client.release();
  }
}

module.exports = { logCustomerEmailAttempt };
