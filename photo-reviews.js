// photo-reviews.js — review_customer_photos card action handler
// DB table, fetch-submission route, execute-review route.

const express    = require('express');
const crypto     = require('crypto');
const { Pool }   = require('pg');
const nodemailer = require('nodemailer');
const axios      = require('axios').create({ timeout: 12000 });
const { isAuthenticated, requirePrivilege } = require('./auth');
const { signCustomerPhotoUrl } = require('./customer-info');

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
function hsBase() {
  return process.env.HUBSPOT_API_BASE_OVERRIDE || 'https://api.hubapi.com';
}
function hsHeaders() {
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
function companyName() {
  return process.env.COMPANY_NAME || 'Measure Once';
}

// ── DB schema ─────────────────────────────────────────────────────────────────
async function ensurePhotoReviewOutcomesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS photo_review_outcomes (
      id                  SERIAL PRIMARY KEY,
      submission_id       INT  NOT NULL REFERENCES customer_info_submissions(id) ON DELETE CASCADE,
      contact_id          TEXT NOT NULL,
      outcome             TEXT NOT NULL CHECK (outcome IN ('not_suitable', 'rough_estimate_sent')),
      price_range         TEXT,
      email_subject       TEXT NOT NULL,
      email_body          TEXT NOT NULL,
      reviewed_by_user_id TEXT NOT NULL,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS pro_submission_id_idx ON photo_review_outcomes (submission_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS pro_contact_id_idx ON photo_review_outcomes (contact_id)
  `);
}

// ── Email templates ───────────────────────────────────────────────────────────
function notSuitableSubject() {
  return 'Regarding your enquiry';
}
function notSuitableBody(contactName) {
  const firstName = contactName ? contactName.split(' ')[0] : '';
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  return [
    greeting,
    '',
    'Thank you so much for getting in touch with us and sharing details about your home.',
    '',
    "Unfortunately, after reviewing your enquiry, we don't think this is a project we'd be able to help with at this time.",
    '',
    "We're sorry we can't be of more help on this occasion, and we wish you all the best in finding the right team for your project.",
    '',
    'Warm regards,',
    companyName(),
  ].join('\n');
}

function roughEstimateSubject() {
  return `Your rough estimate from ${companyName()}`;
}
function roughEstimateBody(contactName, priceRange) {
  const firstName = contactName ? contactName.split(' ')[0] : '';
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  return [
    greeting,
    '',
    'Thank you for sharing details about your home — we really appreciate it.',
    '',
    `Based on the information you've provided, our rough estimate for the work is:`,
    '',
    `  ${priceRange || '—'}`,
    '',
    'Please note that this is a rough guide only and is subject to change once we have had a chance to see your space in person.',
    '',
    "One of our team will be in touch shortly to arrange a design visit, where we can discuss your project in detail, take accurate measurements, and give you a precise quote.",
    '',
    "We're looking forward to helping you create your dream space!",
    '',
    'Warm regards,',
    companyName(),
  ].join('\n');
}

// ── HubSpot helpers ───────────────────────────────────────────────────────────
async function updateHubSpotLeadStatus(contactId, status) {
  const url = `${hsBase()}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`;
  await axios.patch(url, { properties: { hs_lead_status: status } }, { headers: hsHeaders() });
}

async function clearHubSpotSubstatus(contactId) {
  const url = `${hsBase()}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`;
  await axios.patch(url, { properties: { hw_lead_substatus: '' } }, { headers: hsHeaders() });
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
async function sendReviewEmail(toEmail, subject, textBody) {
  const transport = createMailTransport();
  if (!transport) {
    console.warn('[photo-reviews] SMTP not configured — skipping review outcome email.');
    return;
  }
  const from    = buildFromHeader();
  const replyTo = buildReplyTo();
  const htmlBody = textBody
    .split('\n')
    .map(l => l.trim() === '' ? '' : `<p>${escapeHtml(l)}</p>`)
    .join('');
  try {
    await transport.sendMail({
      from, replyTo,
      to:      toEmail,
      subject,
      text:    textBody,
      html:    htmlBody,
    });
    console.log(`[photo-reviews] Review outcome email sent to ${toEmail}`);
  } catch (err) {
    console.error('[photo-reviews] Failed to send review outcome email:', err.message);
    throw err;
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/card-actions/review-customer-photos/:contactId
// Returns the most recent submitted-but-not-yet-reviewed submission for a contact,
// with HMAC-signed photo URLs.
router.get('/api/card-actions/review-customer-photos/:contactId',
  isAuthenticated,
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
          id:              row.id,
          contactId:       row.contact_id,
          contactName:     row.contact_name,
          contactEmail:    row.contact_email,
          maskedEmail:     row.masked_email,
          addressLine1:    row.address_line1,
          city:            row.city,
          postcode:        row.postcode,
          roomCount:       row.room_count,
          roomNotes:       row.room_notes,
          correctedEmail:  row.corrected_email,
          correctedMobile: row.corrected_mobile,
          submittedAt:     row.submitted_at,
          photoUrls,
        },
      });
    } catch (err) {
      console.error('[photo-reviews] GET error:', err.message);
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
    const { contactId, submissionId, outcome, priceRange, emailSubject, emailBody } = req.body;

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
    if (!emailSubject || typeof emailSubject !== 'string' || !emailSubject.trim()) {
      return res.status(400).json({ error: 'emailSubject is required.' });
    }
    if (!emailBody || typeof emailBody !== 'string' || !emailBody.trim()) {
      return res.status(400).json({ error: 'emailBody is required.' });
    }

    const cid  = String(contactId).trim();
    const subId = Number(submissionId);
    const subject = emailSubject.trim().slice(0, 500);
    const body    = emailBody.trim().slice(0, 10000);
    const range   = outcome === 'rough_estimate_sent' ? (priceRange || '').trim().slice(0, 200) : null;

    // Verify submission belongs to this contact and exists
    let submission;
    try {
      const r = await pool.query(
        `SELECT id, contact_id, contact_name, contact_email, corrected_email, submitted_at
         FROM customer_info_submissions
         WHERE id = $1 AND contact_id = $2`,
        [subId, cid]
      );
      if (!r.rows.length) {
        return res.status(404).json({ error: 'Submission not found.' });
      }
      submission = r.rows[0];
    } catch (err) {
      console.error('[photo-reviews] Submission lookup error:', err.message);
      return res.status(500).json({ error: 'Could not look up submission.' });
    }

    if (!submission.submitted_at) {
      return res.status(400).json({ error: 'Submission has not been submitted yet.' });
    }

    // Check not already reviewed
    try {
      const dup = await pool.query(
        `SELECT id FROM photo_review_outcomes WHERE submission_id = $1 LIMIT 1`,
        [subId]
      );
      if (dup.rows.length) {
        return res.status(409).json({ error: 'This submission has already been reviewed.' });
      }
    } catch (err) {
      console.error('[photo-reviews] Duplicate review check error:', err.message);
      return res.status(500).json({ error: 'Could not check for duplicate review.' });
    }

    const toEmail = submission.corrected_email || submission.contact_email;
    if (!toEmail) {
      return res.status(400).json({ error: 'No email address on record for this customer.' });
    }

    // Send email
    try {
      await sendReviewEmail(toEmail, subject, body);
    } catch (err) {
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
        console.error('[photo-reviews] HubSpot update failed (non-fatal):', err.message);
      }
    }

    // Record outcome
    try {
      const reviewerId = req.user?.claims?.sub || req.user?.id || 'unknown';
      await pool.query(
        `INSERT INTO photo_review_outcomes
           (submission_id, contact_id, outcome, price_range, email_subject, email_body, reviewed_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [subId, cid, outcome, range, subject, body, reviewerId]
      );
    } catch (err) {
      console.error('[photo-reviews] Failed to record review outcome (non-fatal):', err.message);
    }

    return res.json({ ok: true });
  }
);

// ── Default handler + binding bootstrap ──────────────────────────────────────
// Run after ensureCardActionHandlersTables() and ensureCustomerInfoSubmissionsTable()
// have both completed (they create the tables this function references).
async function ensureDefaultReviewHandlerBinding() {
  // Step 1: resolve the AWPH_RECEIVED substatus
  const sub = await pool.query(
    `SELECT id FROM lead_substatuses
     WHERE status_key = 'AWAITING_PHOTOS' AND substatus_key = 'AWPH_RECEIVED'
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
  console.log('[photo-reviews] Default review_customer_photos handler bound to AWPH_RECEIVED substatus.');
}

module.exports = {
  router,
  ensurePhotoReviewOutcomesTable,
  ensureDefaultReviewHandlerBinding,
};
