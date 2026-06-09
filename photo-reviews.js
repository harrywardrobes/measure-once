// photo-reviews.js — review_customer_photos card action handler
// DB table, fetch-submission route, execute-review route.

const logger = require('./logger');
const express    = require('express');
const crypto     = require('crypto');
const { Pool }   = require('pg');
const nodemailer = require('nodemailer');
const axios      = require('axios').create({ timeout: 12000 });
const { isAuthenticated, requirePrivilege } = require('./auth');
const { signCustomerPhotoUrl } = require('./customer-info');
const { getEmailTemplate, renderEmail } = require('./email-templates');
const { assertLeadStatusKey } = require('./lead-status-guard');

const pool   = new Pool({ connectionString: process.env.DATABASE_URL });
const router = express.Router();

// ── Utility helpers ───────────────────────────────────────────────────────────
function appBaseUrl() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '');
  if (process.env.REPLIT_DOMAINS) return `https://${process.env.REPLIT_DOMAINS.split(',')[0].trim()}`;
  return 'https://measureonce.replit.app';
}
function buildFromHeader() {
  const raw = (process.env.SMTP_FROM || process.env.SMTP_USER || '').trim();
  if (!raw) return raw;
  if (/</.test(raw)) return raw;
  return `Measure Once <${raw}>`;
}
function buildReplyTo() {
  return (process.env.SMTP_REPLY_TO || process.env.SMTP_FROM || process.env.SMTP_USER || '').trim();
}
function createMailTransport() {
  if (process.env.MAIL_TRANSPORT_FILE_OVERRIDE) {
    const fs   = require('fs');
    const fpath = process.env.MAIL_TRANSPORT_FILE_OVERRIDE;
    return {
      sendMail(opts) {
        return new Promise((resolve, reject) => {
          try {
            fs.appendFileSync(fpath, JSON.stringify(opts) + '\n');
            resolve({ messageId: `override-${Date.now()}` });
          } catch (e) { reject(e); }
        });
      },
    };
  }
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587', 10),
    secure: parseInt(process.env.SMTP_PORT || '587', 10) === 465,
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}
function getHubSpotBaseUrl() {
  return process.env.HUBSPOT_API_BASE_OVERRIDE || 'https://api.hubapi.com';
}
function getHubSpotHeaders() {
  return {
    Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  };
}
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── DB schema ─────────────────────────────────────────────────────────────────
async function ensurePhotoReviewOutcomesTable() {
  // Schema created by migrations; this boot step runs the one-time data repair below.

  // One-time migration: rename the misspelled substatus_key 'AWPH_RECIEVED' to the
  // canonical 'AWPH_RECEIVED'.  The row was originally seeded with the typo by an
  // earlier version of customer-info.js.  customer-info.js already writes the
  // correct spelling to HubSpot (AWAITING_PHOTOS__AWPH_RECEIVED), so only the
  // local DB row needs updating.
  //
  // Conflict-safe: if BOTH rows exist (misspelled legacy + canonical inserted
  // by a later customer-info.js boot), re-point any card_action_handler_binding
  // from the typo row to the canonical row, then delete the typo row.
  // The FK has ON DELETE CASCADE, so the typo binding is removed automatically
  // after the re-point.  Idempotent — no-ops once the typo row is gone.
  {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const typoR = await client.query(
        `SELECT id FROM lead_substatuses
         WHERE status_key = 'AWAITING_PHOTOS' AND substatus_key = 'AWPH_RECIEVED'
         FOR UPDATE`
      );

      if (typoR.rows.length) {
        const typoId = typoR.rows[0].id;

        const canonR = await client.query(
          `SELECT id FROM lead_substatuses
           WHERE status_key = 'AWAITING_PHOTOS' AND substatus_key = 'AWPH_RECEIVED'
           FOR UPDATE`
        );

        if (canonR.rows.length) {
          // Both rows exist — migrate binding then delete typo row.
          const canonId = canonR.rows[0].id;

          // Move the binding only if the canonical slot is not already bound
          // (cahb_substatus_uniq prevents two bindings on the same substatus).
          const canonBound = await client.query(
            `SELECT id FROM card_action_handler_bindings WHERE substatus_id = $1 LIMIT 1`,
            [canonId]
          );
          if (!canonBound.rows.length) {
            await client.query(
              `UPDATE card_action_handler_bindings SET substatus_id = $1 WHERE substatus_id = $2`,
              [canonId, typoId]
            );
          }
          // Delete typo row (ON DELETE CASCADE removes any remaining binding).
          await client.query(`DELETE FROM lead_substatuses WHERE id = $1`, [typoId]);
          logger.info('[photo-reviews] Migration: removed duplicate AWPH_RECIEVED row; canonical AWPH_RECEIVED retained.');
        } else {
          // Only typo row exists — rename in place (no conflict possible).
          await client.query(
            `UPDATE lead_substatuses SET substatus_key = 'AWPH_RECEIVED' WHERE id = $1`,
            [typoId]
          );
          logger.info('[photo-reviews] Migration: renamed AWPH_RECIEVED → AWPH_RECEIVED.');
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

// ── HubSpot helpers ───────────────────────────────────────────────────────────
async function updateHubSpotLeadStatus(contactId, status) {
  const url = `${getHubSpotBaseUrl()}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`;
  await axios.patch(url, { properties: { hs_lead_status: status } }, { headers: getHubSpotHeaders() });
}

async function clearHubSpotSubstatus(contactId) {
  const url = `${getHubSpotBaseUrl()}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`;
  await axios.patch(url, { properties: { hw_lead_substatus: '' } }, { headers: getHubSpotHeaders() });
}

async function ensureLeadStatusExists(key, label) {
  await pool.query(
    `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales)
     VALUES ($1, $2, 0, FALSE)
     ON CONFLICT (key) DO NOTHING`,
    [key, label]
  );
}

// ── Send review outcome email ─────────────────────────────────────────────────
async function sendReviewEmail(toEmail, subject, textBody, htmlBody) {
  const transport = createMailTransport();
  if (!transport) {
    logger.warn('[photo-reviews] SMTP not configured — skipping review outcome email.');
    return;
  }
  const from    = buildFromHeader();
  const replyTo = buildReplyTo();
  const html = (htmlBody && htmlBody.trim())
    ? htmlBody
    : textBody
        .split('\n')
        .map(l => l.trim() === '' ? '' : `<p>${escapeHtml(l)}</p>`)
        .join('');
  try {
    await transport.sendMail({
      from, replyTo,
      to:      toEmail,
      subject,
      text:    textBody,
      html,
    });
    logger.info(`[photo-reviews] Review outcome email sent to ${toEmail}`);
  } catch (err) {
    logger.error({ err: err.message }, '[photo-reviews] Failed to send review outcome email:');
    throw err;
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/card-actions/review-customer-photos/:contactId
// Returns the most recent submitted-but-not-yet-reviewed submission for a contact,
// with HMAC-signed photo URLs.
// Requires member+ — response includes signed photo URLs and corrected contact details.
router.get('/api/card-actions/review-customer-photos/:contactId',
  isAuthenticated,
  requirePrivilege('member'),
  async (req, res) => {
    const cid = String(req.params.contactId || '').trim();
    if (!cid || !/^\d+$/.test(cid)) {
      return res.status(400).json({ error: 'Invalid contactId.' });
    }
    try {
      // Find the most recent submitted submission that has no review outcome yet
      const r = await pool.query(
        `SELECT cis.*
         FROM customer_info_submissions cis
         LEFT JOIN photo_review_outcomes pro ON pro.submission_id = cis.id
         WHERE cis.contact_id = $1
           AND cis.submitted_at IS NOT NULL
           AND pro.id IS NULL
         ORDER BY cis.submitted_at DESC
         LIMIT 1`,
        [cid]
      );
      if (!r.rows.length) {
        return res.json({ submission: null });
      }
      const row = r.rows[0];
      const photoUrls = (row.photo_keys || []).map(k => signCustomerPhotoUrl(k));
      return res.json({
        submission: {
          id:                row.id,
          contactId:         row.contact_id,
          contactName:       row.contact_name,
          contactEmail:      row.contact_email,
          maskedEmail:       row.masked_email,
          addressLine1:      row.address_line1,
          city:              row.city,
          postcode:          row.postcode,
          roomCount:         row.room_count,
          roomNotes:         row.room_notes,
          correctedEmail:    row.corrected_email,
          correctedMobile:   row.corrected_mobile,
          submittedAt:       row.submitted_at,
          emailSkippedCount: row.email_skipped_count ?? 0,
          photoUrls,
          // Sync-readiness fields so an offline-queued review can be conflict-
          // checked: if the submission changes on the server before the queued
          // outcome replays, the sync engine records a conflict.
          version:           row.version ?? null,
          updatedAt:         row.updated_at ?? null,
        },
      });
    } catch (err) {
      logger.error({ err: err.message }, '[photo-reviews] GET error:');
      return res.status(500).json({ error: 'Could not fetch submission.' });
    }
  }
);

// POST /api/card-actions/review-customer-photos
// Sends outcome email, updates HubSpot lead status, and records the review.
router.post('/api/card-actions/review-customer-photos',
  isAuthenticated,
  requirePrivilege('member'),
  async (req, res) => {
    const { contactId, submissionId, outcome, priceRange } = req.body;

    if (!contactId || typeof contactId !== 'string' || !/^\d+$/.test(String(contactId).trim())) {
      return res.status(400).json({ error: 'contactId is required.' });
    }
    if (!submissionId || !Number.isInteger(Number(submissionId)) || Number(submissionId) <= 0) {
      return res.status(400).json({ error: 'submissionId is required.' });
    }
    if (!['not_suitable', 'rough_estimate_sent'].includes(outcome)) {
      return res.status(400).json({ error: 'outcome must be not_suitable or rough_estimate_sent.' });
    }
    if (outcome === 'rough_estimate_sent' && (!priceRange || typeof priceRange !== 'string' || !priceRange.trim())) {
      return res.status(400).json({ error: 'priceRange is required for rough_estimate_sent.' });
    }

    const cid  = String(contactId).trim();
    const subId = Number(submissionId);
    const range = outcome === 'rough_estimate_sent' ? (priceRange || '').trim().slice(0, 200) : null;

    // Reject early if the target lead status no longer exists in lead_status_config,
    // so we never commit the review outcome and then fail the HubSpot patch.
    const hsStatusForCheck = outcome === 'not_suitable' ? 'NOT_SUITABLE' : 'ROUGH_ESTIMATE_SENT';
    try {
      await assertLeadStatusKey(hsStatusForCheck);
    } catch (e) {
      if (e.code === 'LEAD_STATUS_REMOVED') {
        return res.status(422).json({ error: e.message, code: 'LEAD_STATUS_REMOVED', removedKey: e.removedKey });
      }
      throw e;
    }

    // Use a transaction with a row-level lock on the submission to serialise
    // concurrent review requests.  The duplicate-outcome check and the outcome
    // INSERT both happen inside the transaction, so two parallel requests for
    // the same submission cannot both pass the check before either inserts.
    // The UNIQUE constraint on photo_review_outcomes(submission_id) added by
    // migration 1749200000011 provides an additional database backstop.
    let submission;
    let subject, body, htmlBody, toEmail;
    const reviewerId = req.user?.claims?.sub || req.user?.id || 'unknown';

    const reviewClient = await pool.connect();
    try {
      await reviewClient.query('BEGIN');

      // Lock the submission row for the duration of the transaction.
      let lockR;
      try {
        lockR = await reviewClient.query(
          `SELECT id, contact_id, contact_name, contact_email, corrected_email, submitted_at
           FROM customer_info_submissions
           WHERE id = $1 AND contact_id = $2
           FOR UPDATE`,
          [subId, cid]
        );
      } catch (err) {
        await reviewClient.query('ROLLBACK');
        logger.error({ err: err.message }, '[photo-reviews] Submission lock error:');
        return res.status(500).json({ error: 'Could not lock submission.' });
      }

      if (!lockR.rows.length) {
        await reviewClient.query('ROLLBACK');
        return res.status(404).json({ error: 'Submission not found.' });
      }
      submission = lockR.rows[0];

      if (!submission.submitted_at) {
        await reviewClient.query('ROLLBACK');
        return res.status(400).json({ error: 'Submission has not been submitted yet.' });
      }

      // Check for an existing outcome inside the transaction — the row lock
      // above ensures no concurrent request can insert one between this check
      // and our own INSERT below.
      let dup;
      try {
        dup = await reviewClient.query(
          `SELECT id FROM photo_review_outcomes WHERE submission_id = $1 LIMIT 1`,
          [subId]
        );
      } catch (err) {
        await reviewClient.query('ROLLBACK');
        logger.error({ err: err.message }, '[photo-reviews] Duplicate review check error:');
        return res.status(500).json({ error: 'Could not check for duplicate review.' });
      }

      if (dup.rows.length) {
        await reviewClient.query('ROLLBACK');
        return res.status(409).json({ error: 'This submission has already been reviewed.' });
      }

      toEmail = submission.corrected_email || submission.contact_email;
      if (!toEmail) {
        await reviewClient.query('ROLLBACK');
        return res.status(400).json({ error: 'No email address on record for this customer.' });
      }

      // Compose the outcome email from the admin-editable template.
      const firstName = submission.contact_name ? submission.contact_name.split(' ')[0] : '';
      const templateKey = outcome === 'not_suitable'
        ? 'photo_review_not_suitable'
        : 'photo_review_rough_estimate';
      const tmpl = await getEmailTemplate(templateKey);
      const rendered = renderEmail(tmpl, {
        textVars: { firstName, priceRange: range || '' },
        htmlVars: { firstName: escapeHtml(firstName), priceRange: escapeHtml(range || '') },
      });
      subject = rendered.subject.slice(0, 500);
      body    = rendered.text.slice(0, 10000);
      // Only pass rendered HTML when the template actually defines a body_html;
      // otherwise sendReviewEmail derives HTML from the text (preserving the
      // original behaviour for the default text-only photo-review templates).
      htmlBody = (tmpl && tmpl.body_html && tmpl.body_html.trim()) ? rendered.html : undefined;

      // Insert the outcome record inside the transaction before sending any
      // external side-effects.  This is the serialisation point: if a
      // concurrent request already inserted (or if the UNIQUE constraint fires
      // on a race that bypasses the lock), this INSERT will fail and we return
      // 409 without sending a duplicate email.
      try {
        await reviewClient.query(
          `INSERT INTO photo_review_outcomes
             (submission_id, contact_id, outcome, price_range, email_subject, email_body, reviewed_by_user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [subId, cid, outcome, range, subject, body, reviewerId]
        );
      } catch (err) {
        await reviewClient.query('ROLLBACK');
        // Unique-constraint violation means a concurrent request already recorded the outcome.
        if (err.code === '23505') {
          return res.status(409).json({ error: 'This submission has already been reviewed.' });
        }
        logger.error({ err: err.message }, '[photo-reviews] Failed to insert review outcome:');
        return res.status(500).json({ error: 'Could not record review outcome.' });
      }

      await reviewClient.query('COMMIT');
    } catch (err) {
      await reviewClient.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      reviewClient.release();
    }

    // Send email after the outcome is durably committed — if the email fails
    // the outcome is already recorded and no duplicate will be sent on retry.
    try {
      await sendReviewEmail(toEmail, subject, body, htmlBody);
    } catch (err) {
      logger.error({ err: err.message }, '[photo-reviews] Failed to send review email (outcome already recorded):');
      return res.status(502).json({ error: 'Failed to send email: ' + err.message });
    }

    // Update HubSpot (non-fatal — don't fail the whole request if HubSpot is down)
    const hsStatus = outcome === 'not_suitable' ? 'NOT_SUITABLE' : 'ROUGH_ESTIMATE_SENT';
    if (process.env.HUBSPOT_ACCESS_TOKEN) {
      try {
        if (outcome === 'rough_estimate_sent') {
          await ensureLeadStatusExists('ROUGH_ESTIMATE_SENT', 'Rough estimate sent');
        }
        await updateHubSpotLeadStatus(cid, hsStatus);
        await clearHubSpotSubstatus(cid);
      } catch (err) {
        logger.error({ err: err.message }, '[photo-reviews] HubSpot update failed (non-fatal):');
      }
    }

    return res.json({ ok: true });
  }
);

// ── Default handler + binding bootstrap ──────────────────────────────────────
// Run after ensureCardActionHandlersTables() and ensureCustomerInfoSubmissionsTable()
// have both completed (they create the tables this function references).
async function ensureDefaultReviewHandlerBinding() {
  // Step 1: resolve the AWPH_RECEIVED substatus.
  // The misspelled 'AWPH_RECIEVED' row is renamed to 'AWPH_RECEIVED' by the
  // one-time migration in ensurePhotoReviewOutcomesTable(), so only the
  // canonical spelling is needed here.
  const sub = await pool.query(
    `SELECT id FROM lead_substatuses
     WHERE status_key   = 'AWAITING_PHOTOS'
       AND substatus_key = 'AWPH_RECEIVED'
     LIMIT 1`
  );
  if (!sub.rows.length) {
    // Substatus not yet created (no submission has arrived yet) — defer until it exists.
    return;
  }
  const substatusId = sub.rows[0].id;

  // Step 2: skip if ANY handler is already bound to this substatus slot
  //         (cahb_substatus_uniq enforces one binding per substatus — respect admin choices)
  const binding = await pool.query(
    `SELECT id FROM card_action_handler_bindings WHERE substatus_id = $1 LIMIT 1`,
    [substatusId]
  );
  if (binding.rows.length) return;

  // Step 3: ensure at least one review_customer_photos handler exists
  let handlerId;
  const existing = await pool.query(
    `SELECT id FROM card_action_handlers WHERE type = 'review_customer_photos' ORDER BY id LIMIT 1`
  );
  if (existing.rows.length) {
    handlerId = existing.rows[0].id;
  } else {
    const ins = await pool.query(
      `INSERT INTO card_action_handlers (name, type, config)
       VALUES ('Review customer photos', 'review_customer_photos', '{}')
       RETURNING id`,
    );
    handlerId = ins.rows[0].id;
  }

  // Step 4: create the binding (ON CONFLICT DO NOTHING guards against any race)
  await pool.query(
    `INSERT INTO card_action_handler_bindings (handler_id, substatus_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [handlerId, substatusId]
  );
  logger.info('[photo-reviews] Default review_customer_photos handler bound to AWPH_RECEIVED substatus.');
}

// ── Substatus → handler-type mapping ─────────────────────────────────────────
// Maps known substatus_key values to the handler type (and optional config)
// that should be auto-bound on startup when the DB row has no default_handler_type set.
//
// Entries here cover well-known substatus keys whose intended handler type is
// unambiguous from their label or role in the workflow.  Existing bindings are
// never overwritten — admin choices always win.
//
// AWPH_RECEIVED / AWPH_RECIEVED  — the canonical and legacy-misspelled photo-
//   received substatus; both map to review_customer_photos.  AWPH_RECIEVED is
//   renamed to AWPH_RECEIVED by ensurePhotoReviewOutcomesTable(), but the entry
//   is kept here as a safety net for databases that haven't yet migrated.
// DSSC_AGREED    — "Design Date Agreed" → add_design_visit_to_calendar
// DSSC_CONFIRMED — "Design Date Confirmed" → start_design_visit (full wizard)
// SRSC_AGREED    — "Survey Date Agreed" → schedule_visit (visitType: survey)
// SRSC_CONFIRMED — "Survey Visit Confirmed" → schedule_visit (visitType: survey)
// NEWC_CALL      — "Phone Call" new-contact substatus → summarise_phone_call
//
const SUBSTATUS_HANDLER_MAP = {
  // ── Photo review ──────────────────────────────────────────────────────────
  AWPH_RECEIVED:  { type: 'review_customer_photos', name: 'Review customer photos', config: {} },
  AWPH_RECIEVED:  { type: 'review_customer_photos', name: 'Review customer photos', config: {} },

  // ── Design visit ──────────────────────────────────────────────────────────
  DSSC_AGREED:    { type: 'add_design_visit_to_calendar', name: 'Add design visit to calendar', config: {} },
  DSSC_CONFIRMED: { type: 'start_design_visit',           name: 'Start design visit',           config: {} },

  // ── Survey scheduling ─────────────────────────────────────────────────────
  SRSC_AGREED:    { type: 'schedule_visit', name: 'Schedule visit', config: { visitType: 'survey' } },
  SRSC_CONFIRMED: { type: 'schedule_visit', name: 'Schedule visit', config: { visitType: 'survey' } },

  // ── New contact ───────────────────────────────────────────────────────────
  NEWC_CALL:      { type: 'summarise_phone_call', name: 'Summarise phone call', config: {} },
};

// Human-readable names for handler types used when auto-creating handlers
// from the admin-configured default_handler_type column.
const HANDLER_TYPE_NAMES = {
  add_design_visit_to_calendar: 'Add design visit to calendar',
  schedule_visit:               'Schedule visit',
  summarise_phone_call:         'Summarise phone call',
  show_message:                 'Show message',
  start_design_visit:           'Start design visit',
  schedule_delivery_window:     'Schedule delivery window',
  schedule_installation_slot:   'Schedule installation slot',
  upload_photos_and_info:       'Upload photos and info',
  review_customer_photos:       'Review customer photos',
};

// Fallback used when neither default_handler_type nor SUBSTATUS_HANDLER_MAP has an entry.
const FALLBACK_HANDLER = { type: 'show_message', name: 'Show message', config: {} };

// ── Auto-bind handlers for all labelled substatuses ───────────────────────────
// Queries every lead_substatuses row that has a non-empty action_label and
// ensures a card_action_handler_bindings row exists for it. Existing bindings
// are never overwritten (admin overrides are always respected). Idempotent.
//
// Run after ensureCardActionHandlersTables() and seed data are in place.

// Produce a stable cache key that incorporates both the handler type and its
// config so that two mappings with the same type but different configs (e.g.
// schedule_visit with visitType:'survey' vs visitType:'remedial') are kept
// separate and never share a handler.
function _handlerCacheKey(type, config) {
  const sorted = Object.keys(config).sort().reduce((acc, k) => { acc[k] = config[k]; return acc; }, {});
  return `${type}|${JSON.stringify(sorted)}`;
}

// Find an existing card_action_handlers row that matches both the type and the
// required config properties, or create a new one if none exists.
//
// For config-sensitive types:
//   • schedule_visit — must match config.visitType exactly
//   • show_message   — must have no non-empty message or title (so it behaves
//                      as an inert placeholder until an admin configures it)
// For all other types, any existing handler of that type is reused.
async function _findOrCreateHandler(type, name, config) {
  let existing;

  if (type === 'schedule_visit' && config.visitType) {
    existing = await pool.query(
      `SELECT id FROM card_action_handlers
       WHERE type = 'schedule_visit' AND config->>'visitType' = $1
       ORDER BY id LIMIT 1`,
      [String(config.visitType)]
    );
  } else if (type === 'show_message') {
    // For the fallback show_message placeholder, only reuse handlers that have
    // not been configured with a message or title yet — so that clicking the
    // button does nothing until an admin explicitly sets content.
    existing = await pool.query(
      `SELECT id FROM card_action_handlers
       WHERE type = 'show_message'
         AND (config->>'message' IS NULL OR config->>'message' = '')
         AND (config->>'title'   IS NULL OR config->>'title'   = '')
       ORDER BY id LIMIT 1`
    );
  } else {
    // Config-agnostic types — any existing handler of this type is fine.
    existing = await pool.query(
      `SELECT id FROM card_action_handlers WHERE type = $1 ORDER BY id LIMIT 1`,
      [type]
    );
  }

  if (existing.rows.length) {
    return existing.rows[0].id;
  }

  const ins = await pool.query(
    `INSERT INTO card_action_handlers (name, type, config)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [name, type, JSON.stringify(config)]
  );
  return ins.rows[0].id;
}

async function ensureSubstatusHandlerBindings() {
  // Fetch every substatus that has an action label defined.
  const substatuses = await pool.query(
    `SELECT id, status_key, substatus_key, action_label, default_handler_type
     FROM lead_substatuses
     WHERE action_label IS NOT NULL AND action_label != ''
     ORDER BY id`
  );
  if (!substatuses.rows.length) return;

  // Pre-fetch all existing bindings in one query to avoid N+1 lookups.
  const bound = await pool.query(
    `SELECT substatus_id FROM card_action_handler_bindings WHERE substatus_id IS NOT NULL`
  );
  const boundIds = new Set(bound.rows.map(r => r.substatus_id));

  // Cache by (type + config fingerprint) so config-sensitive mappings each get
  // their own handler id without redundant DB round-trips.
  const handlerIdCache = {};

  let seeded = 0;
  for (const row of substatuses.rows) {
    // Skip if a binding already exists for this substatus — respect admin choices.
    if (boundIds.has(row.id)) continue;

    // Resolve handler: prefer admin-configured default_handler_type, then fall
    // back to SUBSTATUS_HANDLER_MAP (well-known substatus keys),
    // then fall back to the show_message placeholder.
    let mapping;
    if (row.default_handler_type) {
      const t = row.default_handler_type;
      mapping = { type: t, name: HANDLER_TYPE_NAMES[t] || t, config: {} };
    } else {
      const mapKey = String(row.substatus_key).toUpperCase();
      mapping = SUBSTATUS_HANDLER_MAP[mapKey] || FALLBACK_HANDLER;
    }
    const { type, name, config } = mapping;

    const cacheKey = _handlerCacheKey(type, config);
    if (!handlerIdCache[cacheKey]) {
      handlerIdCache[cacheKey] = await _findOrCreateHandler(type, name, config);
    }
    const handlerId = handlerIdCache[cacheKey];

    await pool.query(
      `INSERT INTO card_action_handler_bindings (handler_id, substatus_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [handlerId, row.id]
    );
    seeded++;
    logger.info(`[card-action-seeds] Bound ${type} handler to substatus ${row.status_key}/${row.substatus_key} ("${row.action_label}")`);
  }

  if (seeded > 0) {
    logger.info(`[card-action-seeds] Auto-bound ${seeded} substatus handler(s).`);
  }
  return seeded;
}

module.exports = {
  router,
  ensurePhotoReviewOutcomesTable,
  ensureDefaultReviewHandlerBinding,
  ensureSubstatusHandlerBindings,
};
