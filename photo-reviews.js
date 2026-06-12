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
const { REVIEW_OUTCOME_STATUS: _REVIEW_OUTCOME_STATUS } = require('./shared/handler-route-contracts.cjs');
const { GLOBAL_NULL_STAGE_KEY } = require('./shared/slotConstants.cjs');
const { getOutcomeMeta, getOutcomeEmailTemplates } = require('./shared/handler-outcomes.cjs');
const _REVIEW_VALID_OUTCOMES  = new Set(Object.keys(_REVIEW_OUTCOME_STATUS));

const pool   = new Pool({ connectionString: process.env.DATABASE_URL });
const router = express.Router();

// ── patchContactProperties (wired by server.js at startup) ───────────────────
// Delegates hs_lead_status PATCHes to the shared helper so cache invalidation
// is guaranteed on every mutation, regardless of call site.
let _patchContactProperties = async (_contactId, _props) => {
  logger.warn('[photo-reviews] patchContactProperties called before wiring — HubSpot PATCH skipped');
};
function setPatchContactProperties(fn) { _patchContactProperties = fn; }

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
  // Schema created by migrations; no data repairs needed.
}

// ── HubSpot helpers ───────────────────────────────────────────────────────────
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
    if (!_REVIEW_VALID_OUTCOMES.has(outcome)) {
      return res.status(400).json({ error: `outcome must be one of: ${[..._REVIEW_VALID_OUTCOMES].join(', ')}.` });
    }
    if (outcome === 'rough_estimate_sent' && (!priceRange || typeof priceRange !== 'string' || !priceRange.trim())) {
      return res.status(400).json({ error: 'priceRange is required for rough_estimate_sent.' });
    }

    const cid  = String(contactId).trim();
    const subId = Number(submissionId);
    const range = outcome === 'rough_estimate_sent' ? (priceRange || '').trim().slice(0, 200) : null;

    // Reject early if the target lead status no longer exists in lead_status_config,
    // so we never commit the review outcome and then fail the HubSpot patch.
    const hsStatusForCheck = _REVIEW_OUTCOME_STATUS[outcome];
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
      // Resolve the outcome's email template from the central registry (single
      // source of truth) rather than hardcoding the key per outcome.
      const templateKey = getOutcomeEmailTemplates('review_customer_photos', outcome)[0];
      if (!templateKey) {
        await reviewClient.query('ROLLBACK');
        logger.error({ outcome }, '[photo-reviews] No email template registered for outcome');
        return res.status(500).json({ error: 'No email template configured for this outcome.' });
      }
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
    const hsStatus = _REVIEW_OUTCOME_STATUS[outcome];
    if (process.env.HUBSPOT_ACCESS_TOKEN) {
      try {
        await _patchContactProperties(cid, { hs_lead_status: hsStatus });
      } catch (err) {
        logger.error({ err: err.message }, '[photo-reviews] HubSpot update failed (non-fatal):');
      }
    }

    const meta = getOutcomeMeta('review_customer_photos', outcome);
    return res.json({ ok: true, ...meta });
  }
);

// ── Seed contact_customer handler + stage-based bindings ─────────────────────
// Ensures a contact_customer handler row exists and two stage-based bindings:
//   (__global__, '')                → the "no lead status" card slot → "Call Customer"
//   (sales, 'attempted_to_contact') → the ATTEMPTED_TO_CONTACT card slot → "Call Again"
// Also seeds initial stage_action_labels rows (ON CONFLICT DO NOTHING so admin
// edits always win). Idempotent.
async function ensureContactCustomerHandlerBindings() {
  // Step 1: ensure a contact_customer handler exists.
  let handlerId;
  const existing = await pool.query(
    `SELECT id FROM card_action_handlers WHERE type = 'contact_customer' ORDER BY id LIMIT 1`
  );
  if (existing.rows.length) {
    handlerId = existing.rows[0].id;
  } else {
    const ins = await pool.query(
      `INSERT INTO card_action_handlers (name, type, config)
       VALUES ('Contact customer', 'contact_customer', '{}')
       RETURNING id`
    );
    handlerId = ins.rows[0].id;
  }

  // Step 2: ensure bindings for (__global__, '') and (sales, 'attempted_to_contact').
  // Note: the global "no lead status" slot uses '__global__' as the sentinel stage key —
  // NOT 'sales'. Using 'sales' here creates a legacy orphaned row flagged as invalid.
  //
  // Use WHERE NOT EXISTS rather than ON CONFLICT DO NOTHING — card_action_handler_bindings
  // has no unique constraint on (stage_key, status_key), so ON CONFLICT DO NOTHING is a
  // no-op that lets the seed insert duplicate rows on every boot.
  const bindings = [
    { stage_key: GLOBAL_NULL_STAGE_KEY, status_key: '' },
    { stage_key: 'sales',               status_key: 'attempted_to_contact' },
  ];
  for (const b of bindings) {
    await pool.query(
      `INSERT INTO card_action_handler_bindings (handler_id, stage_key, status_key)
       SELECT $1, $2, $3
       WHERE NOT EXISTS (
         SELECT 1 FROM card_action_handler_bindings
         WHERE stage_key IS NOT DISTINCT FROM $2
           AND status_key IS NOT DISTINCT FROM $3
       )`,
      [handlerId, b.stage_key, b.status_key]
    );
  }

  // Step 3: seed stage_action_labels defaults (ON CONFLICT DO NOTHING preserves admin edits).
  const labels = [
    { stage_key: GLOBAL_NULL_STAGE_KEY, status_key: '',                     label: 'Call Customer' },
    { stage_key: 'sales',               status_key: 'attempted_to_contact', label: 'Call Again' },
  ];
  for (const l of labels) {
    await pool.query(
      `INSERT INTO stage_action_labels (stage_key, status_key, label)
       VALUES ($1, $2, $3)
       ON CONFLICT (stage_key, status_key) DO NOTHING`,
      [l.stage_key, l.status_key, l.label]
    );
  }

  logger.info('[card-action-seeds] contact_customer handler and bindings ensured.');
}

module.exports = {
  router,
  ensurePhotoReviewOutcomesTable,
  ensureContactCustomerHandlerBindings,
  setPatchContactProperties,
};
