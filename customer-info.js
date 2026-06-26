// customer-info.js — upload_photos_and_info card action handler
// DB table, send-link route, public form routes (token-gated), photo upload,
// admin notification emails, HubSpot lead-status update, and dashboard viewer.

const logger = require('./logger');
const express    = require('express');
const crypto     = require('crypto');
const multer     = require('multer');
const { Pool }   = require('pg');
const { createMailTransport, appBaseUrl, buildFromHeader, buildReplyTo } = require('./email-transport');
const axios      = require('axios').create({ timeout: 12000 });
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const storage    = require('./storage');
const { isAuthenticated, requirePrivilege, requireAdmin } = require('./auth');
const rateLimit = require('express-rate-limit');
const { PostgresStoreIndividualIP } = require('@acpr/rate-limit-postgresql');
const { getEmailTemplate, renderEmail } = require('./email-templates');
const { assertLeadStatusKey } = require('./lead-status-guard');
const { getOutcomeEmailTemplates, getActionLevelEmailTemplates } = require('./shared/handler-outcomes.cjs');
const {
  structuredAddressSchema, hubspotToAddress, addressToHubspot, formatAddress, isAddressEmpty,
} = require('./shared/address.cjs');
const { normalizePhone, formatPhone } = require('./shared/phone.cjs');

// Email template keys resolved from the central registry (single source of
// truth). The customer invite is the upload_photos_and_info / link_sent
// outcome email; the admin notification and customer thank-you are the
// handler's two action-level emails (declaration order: admin, then customer).
const INVITE_TEMPLATE_KEY = getOutcomeEmailTemplates('upload_photos_and_info', 'link_sent')[0];
const [ADMIN_NOTIFICATION_TEMPLATE_KEY, CUSTOMER_THANK_YOU_TEMPLATE_KEY] =
  getActionLevelEmailTemplates('upload_photos_and_info');
if (!INVITE_TEMPLATE_KEY || !ADMIN_NOTIFICATION_TEMPLATE_KEY || !CUSTOMER_THANK_YOU_TEMPLATE_KEY) {
  throw new Error(
    '[customer-info] upload_photos_and_info email templates are not fully registered ' +
    'in shared/handler-outcomes.cjs (expected link_sent + 2 action-level templates).'
  );
}

const pool   = new Pool({ connectionString: process.env.DATABASE_URL });
const router = express.Router();

// ── Shared SSE client registry (wired by server.js at startup) ────────────────
let _sseClients = null;
function setSharedSseClients(clients) { _sseClients = clients; }

// ── patchContactProperties (wired by server.js at startup) ───────────────────
// Delegates hs_lead_status PATCHes to the shared helper so cache invalidation
// is guaranteed on every mutation, regardless of call site.
let _patchContactProperties = async (_contactId, _props) => {
  logger.warn('[customer-info] patchContactProperties called before wiring — HubSpot PATCH skipped');
};
function setPatchContactProperties(fn) { _patchContactProperties = fn; }

function pushSseEvent(payload) {
  if (!_sseClients) return;
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of _sseClients) {
    try { client.write(msg); } catch { _sseClients.delete(client); }
  }
}

// ── Config ────────────────────────────────────────────────────────────────────
const LINK_TTL_DAYS = 28;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function adminEmails() {
  return (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
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

// ── Masking helpers ───────────────────────────────────────────────────────────
function maskEmail(email) {
  if (!email || typeof email !== 'string') return '';
  const [local, domain] = email.split('@');
  if (!domain) return (local.slice(0, 3) || local[0] || '') + '***';
  // Local: first 3 chars + *** + last 3 chars (e.g. har***son), shorter names get first + ***
  let maskedLocal;
  if (local.length <= 3) {
    maskedLocal = local[0] + '***';
  } else if (local.length <= 6) {
    maskedLocal = local.slice(0, 3) + '***';
  } else {
    maskedLocal = local.slice(0, 3) + '***' + local.slice(-3);
  }
  // Domain: first char + ** + .TLD (e.g. g**.com)
  const domainParts = domain.split('.');
  const tld = domainParts[domainParts.length - 1];
  const maskedDomain = domain[0] + '**.' + tld;
  return `${maskedLocal}@${maskedDomain}`;
}
function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return digits.slice(0, 2) + '***' + digits.slice(-4);
}

// ── DB schema ─────────────────────────────────────────────────────────────────
async function ensureResendLogTable() {
  // Schema created by migrations; this boot step performs retention cleanup:
  // delete rows older than 48 hours to keep the table small.
  await pool.query(`DELETE FROM customer_info_resend_log WHERE requested_at < NOW() - INTERVAL '48 hours'`);
}

// ── Email templates ───────────────────────────────────────────────────────────

/** Render the customer invite email template with variable substitution. */
async function renderCustomerInviteEmail(maskedEmail, formLink) {
  const tmpl = await getEmailTemplate(INVITE_TEMPLATE_KEY);
  return renderEmail(tmpl, {
    textVars: { maskedEmail, formLink },
    htmlVars: { maskedEmail: escapeHtml(maskedEmail), formLink: escapeHtml(formLink) },
  });
}

/**
 * Send the customer invite email. Pass customSubject/customBody to override
 * the template (used when staff edited the email before sending).
 */
async function sendCustomerInviteEmail(contactEmail, maskedEmail, formLink, customSubject, customBody) {
  const transport = createMailTransport();
  if (!transport) {
    logger.warn('[customer-info] SMTP not configured — skipping invite email.');
    logger.warn(`[customer-info] Form link (manual delivery): ${formLink}`);
    return;
  }
  const from    = buildFromHeader();
  const replyTo = buildReplyTo();
  let subject, text, html;
  if (customSubject != null || customBody != null) {
    const tmpl = await getEmailTemplate(INVITE_TEMPLATE_KEY);
    const customBodyHtml = customBody != null
      ? customBody.split('\n').map(l => l.trim() === '' ? '' : `<p>${escapeHtml(l)}</p>`).join('')
      : null;
    const effectiveTmpl = {
      ...tmpl,
      ...(customBody    != null ? { body_text: customBody,    body_html: customBodyHtml } : {}),
      ...(customSubject != null ? { subject: customSubject } : {}),
    };
    ({ subject, text, html } = renderEmail(effectiveTmpl, {
      textVars: { maskedEmail, formLink },
      htmlVars: { maskedEmail: escapeHtml(maskedEmail), formLink: escapeHtml(formLink) },
    }));
  } else {
    ({ subject, text, html } = await renderCustomerInviteEmail(maskedEmail, formLink));
  }
  try {
    await transport.sendMail({ from, replyTo, to: contactEmail, subject, text, html });
    logger.info(`[customer-info] Invite email sent to ${contactEmail}`);
  } catch (err) {
    logger.error({ err: err.message }, '[customer-info] Failed to send invite email:');
  }
}

async function sendAdminNotificationEmail(submission) {
  const admins = adminEmails();
  if (!admins.length) return;
  const transport = createMailTransport();
  if (!transport) {
    logger.warn('[customer-info] SMTP not configured — skipping admin notification email.');
    return;
  }
  const from    = buildFromHeader();
  const replyTo = buildReplyTo();
  const { id: submissionId, contact_id, contact_name, contact_email,
          address_line1, city, postcode, room_count, room_notes, have_we_spoken,
          contact_phone } = submission;

  const roomLabel = room_count === '1' ? '1 room' : room_count === '2' ? '2 rooms' : '3+ rooms';
  const addressParts = [address_line1, city, postcode].filter(Boolean);
  const address = addressParts.join(', ') || '—';

  const photoKeys = submission.photo_keys || [];
  const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
  const attachments = [];
  let skippedCount = 0;

  if (photoKeys.length > 0) {
    const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' };
    // Download all files in parallel so 14 files take ~1× network RTT instead of 14×.
    const downloadResults = await Promise.all(photoKeys.map(async (key) => {
      const storagePath = 'customer-info-photos/' + key.replace(/^obj:ci_/, '');
      const ext = storagePath.split('.').pop()?.toLowerCase() || 'jpg';
      const contentType = mimeMap[ext] || 'image/jpeg';
      try {
        const buffer = await storage.downloadBytes(storagePath);
        if (!buffer) throw new Error('download failed');
        if (buffer.length > MAX_ATTACHMENT_BYTES) {
          logger.warn(`[customer-info] Skipping attachment for ${key}: ${buffer.length} bytes exceeds 8 MB limit`);
          return { skipped: true };
        }
        return { skipped: false, ext, contentType, buffer };
      } catch (err) {
        logger.warn({ err: err.message }, `[customer-info] Skipping attachment for key ${key}:`);
        return { skipped: true };
      }
    }));
    // Rebuild attachments in original order so filenames are sequential (photo-1/document-1, …).
    for (const result of downloadResults) {
      if (result.skipped) {
        skippedCount++;
      } else {
        const fileLabel = result.ext === 'pdf'
          ? `document-${attachments.length + 1}.pdf`
          : `photo-${attachments.length + 1}.${result.ext}`;
        attachments.push({
          filename: fileLabel,
          content: result.buffer,
          contentType: result.contentType,
        });
      }
    }
  }

  let photoSummaryHtml;
  let photoSummaryText;
  if (photoKeys.length === 0) {
    photoSummaryHtml = '<p>No files uploaded.</p>';
    photoSummaryText = 'Files: none uploaded';
  } else if (skippedCount === 0) {
    const n = attachments.length;
    photoSummaryHtml = `<p><strong>${n} file${n === 1 ? '' : 's'} attached.</strong></p>`;
    photoSummaryText = `Files: ${n} attached`;
  } else {
    const n = attachments.length;
    const dashboardUrl = contact_id
      ? `${appBaseUrl()}/customers/${encodeURIComponent(contact_id)}`
      : null;
    const dashboardLinkHtml = dashboardUrl
      ? ` <a href="${escapeHtml(dashboardUrl)}">View all files on the dashboard</a>`
      : ' See dashboard to view them.';
    const dashboardLinkText = dashboardUrl
      ? ` View all files on the dashboard: ${dashboardUrl}`
      : ' See dashboard to view them.';
    photoSummaryHtml = `<p><strong>${n} file${n === 1 ? '' : 's'} attached, ${skippedCount} skipped (too large) —${dashboardLinkHtml}</strong></p>`;
    photoSummaryText = `Files: ${n} attached, ${skippedCount} skipped (too large).${dashboardLinkText}`;
  }

  // Persist the skipped count so the dashboard can surface a warning notice.
  // Do this before sending so the count is recorded even if the send fails.
  if (submissionId) {
    try {
      await pool.query(
        `UPDATE customer_info_submissions SET email_skipped_count = $1 WHERE id = $2`,
        [skippedCount, submissionId]
      );
    } catch (dbErr) {
      logger.warn({ err: dbErr.message }, '[customer-info] Could not persist email_skipped_count:');
    }
  }

  const customerName  = contact_name || contact_email || 'Unknown';
  const customerEmail = contact_email || '—';
  const notesValue    = room_notes || '—';

  const formattedPhone = contact_phone ? formatPhone(contact_phone) : null;
  const contactPhoneText = formattedPhone ? `Phone:        ${formattedPhone}` : '';
  const contactPhoneHtml = formattedPhone
    ? `<tr><td><strong>Phone</strong></td><td>${escapeHtml(formattedPhone)}</td></tr>`
    : '';

  const tmpl = await getEmailTemplate(ADMIN_NOTIFICATION_TEMPLATE_KEY);
  let { subject, text, html } = renderEmail(tmpl, {
    textVars: {
      customerName, customerEmail, address, rooms: roomLabel,
      notes: notesValue, photoSummary: photoSummaryText,
      contactPhone: contactPhoneText,
    },
    htmlVars: {
      customerName:    escapeHtml(customerName),
      customerEmail:   escapeHtml(customerEmail),
      address:         escapeHtml(address),
      rooms:           escapeHtml(roomLabel),
      notes:           escapeHtml(notesValue),
      photoSummary:    photoSummaryHtml,
      contactPhone:    contactPhoneHtml,
    },
  });
  if (have_we_spoken && String(have_we_spoken).trim()) {
    const hws = String(have_we_spoken).trim();
    text += `\n\nHave we spoken?\n${hws}`;
    html += `\n<p><strong>Have we spoken?</strong><br>${escapeHtml(hws).replace(/\n/g, '<br>')}</p>`;
  }
  try {
    await transport.sendMail({
      from, replyTo,
      to:      admins.join(', '),
      subject,
      attachments,
      text,
      html,
    });
    logger.info(`[customer-info] Admin notification sent for contact ${contact_email}`);
  } catch (err) {
    logger.error({ err: err.message }, '[customer-info] Failed to send admin notification email:');
  }
}

async function sendCustomerThankYouEmail(contactEmail, contactName) {
  const transport = createMailTransport();
  if (!transport) {
    logger.warn('[customer-info] SMTP not configured — skipping thank-you email.');
    return;
  }
  const from    = buildFromHeader();
  const replyTo = buildReplyTo();
  const firstName = contactName ? contactName.split(' ')[0] : '';
  const tmpl = await getEmailTemplate(CUSTOMER_THANK_YOU_TEMPLATE_KEY);
  const { subject, text, html } = renderEmail(tmpl, {
    textVars: { firstName },
    htmlVars: { firstName: escapeHtml(firstName) },
  });
  try {
    await transport.sendMail({
      from, replyTo,
      to:      contactEmail,
      subject,
      text,
      html,
    });
    logger.info(`[customer-info] Thank-you email sent to ${contactEmail}`);
  } catch (err) {
    logger.error({ err: err.message }, '[customer-info] Failed to send thank-you email:');
  }
}

// ── HubSpot helpers ───────────────────────────────────────────────────────────
async function fetchContactFromHubSpot(contactId) {
  const url = `${getHubSpotBaseUrl()}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`;
  const r = await axios.get(url, {
    headers: getHubSpotHeaders(),
    params: { properties: 'email,phone,mobilephone,firstname,lastname,hs_lead_status' },
  });
  return r.data;
}

// Search HubSpot contacts by email. Returns the first matching contact or null.
async function searchHubSpotContactByEmail(email) {
  const url = `${getHubSpotBaseUrl()}/crm/v3/objects/contacts/search`;
  try {
    const r = await axios.post(url, {
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      properties: ['email', 'firstname', 'lastname', 'phone', 'mobilephone', 'hs_lead_status'],
      limit: 1,
    }, { headers: getHubSpotHeaders() });
    const results = r.data?.results || [];
    return results[0] || null;
  } catch (err) {
    logger.error({ err: err.message }, '[customer-info] HubSpot contact search failed:');
    return null;
  }
}

// Create a new HubSpot contact. Returns the created contact object.
async function createHubSpotContact(name, email, phone) {
  const url = `${getHubSpotBaseUrl()}/crm/v3/objects/contacts`;
  const nameParts = (name || '').trim().split(/\s+/);
  const firstname = nameParts[0] || '';
  const lastname  = nameParts.slice(1).join(' ') || '';
  const properties = { email, hs_lead_status: 'AWAITING_PHOTOS' };
  if (firstname) properties.firstname = firstname;
  if (lastname)  properties.lastname  = lastname;
  if (phone)     properties.phone     = phone;
  const r = await axios.post(url, { properties }, { headers: getHubSpotHeaders() });
  return r.data;
}

// Compare hs_lead_status against AWAITING_PHOTOS sort_order.
// Returns true when the current status is strictly past the photos stage
// (i.e. has a higher sort_order), meaning the status must not be downgraded.
async function isLeadStatusPastPhotos(currentStatus) {
  if (!currentStatus) return false;
  if (currentStatus === 'AWAITING_PHOTOS') return false;
  try {
    const r = await pool.query(
      `SELECT key, sort_order FROM lead_status_config
       WHERE key = ANY($1::text[]) AND is_null_row IS NOT TRUE`,
      [[currentStatus, 'AWAITING_PHOTOS']]
    );
    const rows = r.rows;
    const awaitingRow  = rows.find(x => x.key === 'AWAITING_PHOTOS');
    const currentRow   = rows.find(x => x.key === currentStatus);
    if (!awaitingRow || !currentRow) return false;
    return currentRow.sort_order > awaitingRow.sort_order;
  } catch (err) {
    logger.warn({ err: err.message }, '[customer-info] Could not compare lead status sort orders — defaulting to not past photos');
    return false;
  }
}

// Validates a customer-info object storage key.
// Keys are generated as obj:ci_<24-char base64url>.<ext> — enforce that format
// strictly so callers cannot probe storage paths outside the ci_ namespace.
const CI_KEY_RE = /^obj:ci_[A-Za-z0-9_-]{24}\.(jpg|jpeg|png|webp|pdf)$/;
function isValidCiKey(k) {
  return typeof k === 'string' && CI_KEY_RE.test(k);
}

// ── Photo upload (multer → object storage) ───────────────────────────────────
const ALLOWED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf']);
const MAX_PHOTO_BYTES = 15 * 1024 * 1024; // 15 MB per file (client compresses to ≤1.5 MB before upload)
const MAX_PHOTO_FILES = 15;
// Maximum total files that may be uploaded across all batches for a single token.
// Prevents storage exhaustion from repeated uploads against one bearer link.
const MAX_TOTAL_UPLOADS_PER_TOKEN = 50;

// Write upload data to disk (OS temp dir) rather than buffering in Node's heap.
// This eliminates the up-to-225 MB per-request RAM spike that memoryStorage()
// would cause, and lets us stream directly to object storage via storage.uploadFile.
const _photoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, _file, cb) =>
      cb(null, `ci-upload-${crypto.randomBytes(16).toString('hex')}`),
  }),
  limits: { fileSize: MAX_PHOTO_BYTES, files: MAX_PHOTO_FILES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype.toLowerCase())) cb(null, true);
    else cb(new Error('Only JPEG, PNG, WebP, and PDF files are allowed.'));
  },
});

const FRIENDLY_UPLOAD_MSG = 'Photo upload is temporarily unavailable. Please try again later.';

function _friendlyStorageError(err) {
  if (/bucket|object storage/i.test(err.message)) {
    logger.error({ err: err.message }, '[customer-info] Storage config error (original):');
    return new Error(FRIENDLY_UPLOAD_MSG);
  }
  return err;
}

// Upload a photo from a local temp file path directly to object storage.
// Using storage.uploadFile avoids loading the full file into Node's heap —
// the client streams from disk. The temp file is the caller's responsibility
// to delete after this function returns (whether it succeeds or throws).
async function uploadPhotoFileToStorage(filePath, mimeType) {
  const extMap = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
  const ext = extMap[mimeType.toLowerCase()] || 'jpg';
  const id  = crypto.randomBytes(18).toString('base64url');
  const name = `customer-info-photos/${id}.${ext}`;
  try {
    await storage.uploadFile(name, filePath);
  } catch (e) {
    throw _friendlyStorageError(e);
  }
  return `obj:ci_${id}.${ext}`;
}

function signCustomerPhotoUrl(storageKey) {
  // Reuse the signing scheme from design-visit-uploads but with a different route
  if (!storageKey || typeof storageKey !== 'string') return storageKey;
  if (!storageKey.startsWith('obj:ci_')) return storageKey;
  const secret = process.env.SESSION_SECRET;
  if (!secret) return storageKey;
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const sig = crypto.createHmac('sha256', secret).update(`${storageKey}|${exp}`).digest('hex');
  return `/api/customer-info-photos/${encodeURIComponent(storageKey)}?exp=${exp}&sig=${sig}`;
}

function signPublicCustomerPhotoUrl(storageKey) {
  // Like signCustomerPhotoUrl but signs for the unauthenticated preview route
  // so customers can view/download their own uploaded files after a draft restore.
  if (!storageKey || typeof storageKey !== 'string') return null;
  if (!storageKey.startsWith('obj:ci_')) return null;
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const sig = crypto.createHmac('sha256', secret).update(`${storageKey}|${exp}`).digest('hex');
  return `/api/customer-info-preview/${encodeURIComponent(storageKey)}?exp=${exp}&sig=${sig}`;
}

function verifyCustomerPhotoUrl(storageKey, exp, sig) {
  if (!storageKey || !storageKey.startsWith('obj:ci_')) return false;
  const secret = process.env.SESSION_SECRET;
  if (!secret) return false;
  const expNum = parseInt(exp, 10);
  if (!Number.isFinite(expNum) || expNum < Math.floor(Date.now() / 1000)) return false;
  if (typeof sig !== 'string' || sig.length !== 64) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${storageKey}|${expNum}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(sig,      'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── Token validation helper ───────────────────────────────────────────────────
async function lookupToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string' || rawToken.length > 200) return null;
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const r = await pool.query(
    `SELECT * FROM customer_info_submissions WHERE token_hash = $1 LIMIT 1`,
    [tokenHash]
  );
  return r.rows[0] || null;
}

// ── Turnstile verification (used by the public resend endpoint) ───────────────
async function verifyTurnstileForResend(token, ip) {
  if (!process.env.TURNSTILE_SECRET_KEY) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('[SECURITY] TURNSTILE_SECRET_KEY is required in production — rejecting resend request.');
      return { ok: false };
    }
    return { ok: true }; // dev bypass when key not configured
  }
  try {
    const params = new URLSearchParams({
      secret:   process.env.TURNSTILE_SECRET_KEY,
      response: token || '',
      remoteip: ip || '',
    });
    const r = await axios.post(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 8000 }
    );
    return { ok: !!r.data?.success };
  } catch (err) {
    logger.error({ err: err.message }, '[customer-info] Turnstile verification error:');
    return { ok: false };
  }
}

// ── In-memory cooldown for the initial send (upload-photos-and-info) ──────────
// Rejects a second send for the same contactId within 10 seconds to prevent
// duplicate emails from rapid double-taps on a slow network.
// Map: contactId (string) → timestamp of last successful send (ms).
const _staffSendCooldown = new Map();
const STAFF_SEND_COOLDOWN_MS = 10 * 1000;
function checkStaffSendCooldown(contactId) {
  const now = Date.now();
  const last = _staffSendCooldown.get(contactId);
  if (last !== undefined && now - last < STAFF_SEND_COOLDOWN_MS) return false;
  _staffSendCooldown.set(contactId, now);
  return true;
}
function clearStaffSendCooldown(contactId) {
  _staffSendCooldown.delete(contactId);
}

// ── In-memory cooldown for the staff resend endpoint ──────────────────────────
// Rejects a second resend for the same contactId within 10 seconds to prevent
// duplicate emails from rapid double-taps on a slow network.
// Map: contactId (string) → timestamp of last successful resend (ms).
const _staffResendCooldown = new Map();
const STAFF_RESEND_COOLDOWN_MS = 10 * 1000;
/**
 * Returns { allowed: true } when the caller may proceed, or
 * { allowed: false, remainingMs: number } when the cooldown is still active.
 */
function checkStaffResendCooldown(contactId) {
  const now = Date.now();
  const last = _staffResendCooldown.get(contactId);
  if (last !== undefined && now - last < STAFF_RESEND_COOLDOWN_MS) {
    return { allowed: false, remainingMs: STAFF_RESEND_COOLDOWN_MS - (now - last) };
  }
  // Stamp now to block concurrent duplicate requests; clear on failure so retries are allowed.
  _staffResendCooldown.set(contactId, now);
  return { allowed: true };
}
function clearStaffResendCooldown(contactId) {
  _staffResendCooldown.delete(contactId);
}

// ── In-memory IP rate limiter for the public resend endpoint ──────────────────
// Max 5 requests per IP per hour. Map: ip → array of timestamps.
const _resendIpLog = new Map();
function checkIpResendLimit(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const max = 5;
  const hits = (_resendIpLog.get(ip) || []).filter(t => now - t < windowMs);
  if (hits.length >= max) return false;
  hits.push(now);
  _resendIpLog.set(ip, hits);
  return true;
}

// ── In-memory rate limiters for the public photo upload endpoint ───────────────
// Per-IP: max 10 upload requests per IP per 10 minutes (broad abuse shield).
// Per-token: max 5 upload requests per token per 10 minutes (per-link cap).
// Both are checked before multer writes any bytes, providing defense-in-depth.
const _uploadIpLog    = new Map();
const _uploadTokenLog = new Map();

function checkUploadIpRateLimit(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const max = 10;
  const hits = (_uploadIpLog.get(ip) || []).filter(t => now - t < windowMs);
  if (hits.length >= max) return false;
  hits.push(now);
  _uploadIpLog.set(ip, hits);
  return true;
}

function checkTokenUploadRateLimit(tokenHash) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const max = 5;
  const hits = (_uploadTokenLog.get(tokenHash) || []).filter(t => now - t < windowMs);
  if (hits.length >= max) return false;
  hits.push(now);
  _uploadTokenLog.set(tokenHash, hits);
  return true;
}

// IP-level rate limit on anonymous draft creation: 5 per IP per hour.
// Prevents bulk token minting that could be used for storage-exhaustion via uploads.
const genericDraftLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: new PostgresStoreIndividualIP(
    { connectionString: process.env.DATABASE_URL },
    'ci_generic_draft'
  ),
  handler: (_req, res) => {
    res.status(429).json({ error: 'Too many form requests from this IP. Please wait before trying again.' });
  },
});

// ── Routes ────────────────────────────────────────────────────────────────────

// Authenticated: check whether an active (non-expired, non-submitted) link
// already exists for a contact — read-only, no side effects.
// GET /api/customer-info/by-contact/:contactId/link-status
router.get('/api/customer-info/by-contact/:contactId/link-status',
  isAuthenticated,
  requirePrivilege('member'),
  async (req, res) => {
    const cid = String(req.params.contactId || '').trim();
    if (!cid || !/^\d+$/.test(cid)) {
      return res.status(400).json({ error: 'Invalid contactId.' });
    }

    const { rows } = await pool.query(
      `SELECT expires_at, form_link FROM customer_info_submissions
       WHERE contact_id = $1 AND expires_at > NOW() AND submitted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [cid]
    );

    if (rows.length === 0) {
      return res.json({ hasActiveLink: false });
    }

    const responseBody = { hasActiveLink: true, expiresAt: rows[0].expires_at };

    // Only managers and admins may receive the raw bearer URL.
    // Members can trigger email sends via POST card-actions but must not be
    // able to copy the link and impersonate the customer on the public form.
    const userId = req.user?.claims?.sub;
    let canReceiveLink = false;
    try {
      const privR = await pool.query(`SELECT privilege_level FROM users WHERE id = $1`, [userId]);
      const level = privR.rows[0]?.privilege_level || 'member';
      canReceiveLink = level === 'manager' || level === 'admin';
    } catch {
      // Default to not exposing the bearer link if the privilege lookup fails.
    }

    if (canReceiveLink && rows[0].form_link) {
      const formLink = rows[0].form_link;
      const token = formLink.split('/').pop() || null;
      responseBody.formLink = formLink;
      if (token) responseBody.token = token;
    }

    return res.json(responseBody);
  }
);

// Authenticated: revoke (immediately expire) any active link for a contact.
// Manager/admin only — same privilege tier that can receive the raw bearer URL.
// POST /api/customer-info/by-contact/:contactId/revoke-link
router.post('/api/customer-info/by-contact/:contactId/revoke-link',
  isAuthenticated,
  requirePrivilege('manager'),
  async (req, res) => {
    const cid = String(req.params.contactId || '').trim();
    if (!cid || !/^\d+$/.test(cid)) {
      return res.status(400).json({ error: 'Invalid contactId.' });
    }

    const { rowCount } = await pool.query(
      `UPDATE customer_info_submissions
       SET expires_at = NOW()
       WHERE contact_id = $1 AND expires_at > NOW() AND submitted_at IS NULL`,
      [cid]
    );

    logger.info(`[customer-info] Revoked ${rowCount} active link(s) for contact ${cid}`);
    return res.json({ ok: true, revokedCount: rowCount });
  }
);

// Authenticated: generate a customer link without sending email
// POST /api/customer-info/by-contact/:contactId/generate-link
router.post('/api/customer-info/by-contact/:contactId/generate-link',
  isAuthenticated,
  requirePrivilege('member'),
  async (req, res) => {
    const cid = String(req.params.contactId || '').trim();
    if (!cid || !/^\d+$/.test(cid)) {
      return res.status(400).json({ error: 'Invalid contactId.' });
    }

    let contact;
    try {
      contact = await fetchContactFromHubSpot(cid);
    } catch (err) {
      logger.error({ err: err.message }, '[customer-info] Failed to fetch contact from HubSpot:');
      return res.status(502).json({ error: 'Could not fetch contact from HubSpot.' });
    }

    const props = contact.properties || {};
    const email = (props.email || '').trim();
    if (!email) {
      return res.status(400).json({ error: 'Contact has no email address in HubSpot.' });
    }
    const phone     = (props.mobilephone || props.phone || '').trim();
    const firstName = (props.firstname || '').trim();
    const lastName  = (props.lastname  || '').trim();
    const name = [firstName, lastName].filter(Boolean).join(' ') || email;

    const rawToken  = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + LINK_TTL_DAYS * 24 * 60 * 60 * 1000);
    const formLink  = `${appBaseUrl()}/customer-info/${encodeURIComponent(rawToken)}`;

    // Serialise concurrent generate-link requests for the same contact with a
    // per-contact advisory lock held for the duration of the transaction.
    // This prevents two simultaneous requests from both observing "no active
    // row" and both inserting a fresh bearer token for the same contact.
    const genClient = await pool.connect();
    let isResend;
    try {
      await genClient.query('BEGIN');
      await genClient.query('SELECT pg_advisory_xact_lock(hashtext($1))', [cid]);

      const existingResult = await genClient.query(
        `SELECT id FROM customer_info_submissions
         WHERE contact_id = $1 AND expires_at > NOW() AND submitted_at IS NULL
         ORDER BY created_at DESC`,
        [cid]
      );
      const existingRows = existingResult.rows;
      isResend = existingRows.length > 0;

      if (isResend) {
        const keepId = existingRows[0].id;
        await genClient.query(
          `UPDATE customer_info_submissions
           SET token_hash = $1, expires_at = $2, form_link = $3
           WHERE id = $4`,
          [tokenHash, expiresAt.toISOString(), formLink, keepId]
        );
        if (existingRows.length > 1) {
          const staleIds = existingRows.slice(1).map(r => r.id);
          await genClient.query(
            `UPDATE customer_info_submissions
             SET expires_at = NOW()
             WHERE id = ANY($1::int[])`,
            [staleIds]
          );
          logger.info(`[customer-info] Expired ${staleIds.length} stale duplicate link(s) for contact ${cid}`);
        }
        logger.info(`[customer-info] Refreshed existing link (id=${keepId}) for contact ${cid} (isResend=true)`);
      } else {
        await genClient.query(
          `INSERT INTO customer_info_submissions
             (contact_id, contact_name, contact_email, token_hash, expires_at,
              masked_email, masked_phone, form_link)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [cid, name, email, tokenHash, expiresAt.toISOString(),
           maskEmail(email), maskPhone(phone), formLink]
        );
        logger.info(`[customer-info] Created new link for contact ${cid} (isResend=false)`);
      }

      await genClient.query('COMMIT');
    } catch (err) {
      await genClient.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      genClient.release();
    }

    // Only managers and admins may receive the raw bearer URL in the response.
    // Members can still trigger the send flow via POST /api/card-actions/upload-photos-and-info
    // (which uses the pre-generated token internally), but they must not be able
    // to copy the link and impersonate the customer on the public form.
    const userId = req.user?.claims?.sub;
    let canReceiveLink = false;
    try {
      const privR = await pool.query(`SELECT privilege_level FROM users WHERE id = $1`, [userId]);
      const level = privR.rows[0]?.privilege_level || 'member';
      canReceiveLink = level === 'manager' || level === 'admin';
    } catch {
      // Default to not exposing the bearer link if the privilege lookup fails.
    }

    const responseBody = { expiresAt: expiresAt.toISOString(), isResend };
    if (canReceiveLink) {
      responseBody.formLink = formLink;
      responseBody.token = rawToken;
    }
    res.status(201).json(responseBody);
  }
);

// Authenticated: preview the customer invite email before sending.
// POST /api/customer-info/by-contact/:contactId/upload-link-email-preview
// Body: { token?, subject?, body? }
// Returns: { subject, text, html }
router.post('/api/customer-info/by-contact/:contactId/upload-link-email-preview',
  isAuthenticated,
  requirePrivilege('member'),
  async (req, res) => {
    const cid = String(req.params.contactId || '').trim();
    if (!cid || !/^\d+$/.test(cid)) {
      return res.status(400).json({ error: 'Invalid contactId.' });
    }
    const preToken     = req.body && typeof req.body.token   === 'string' ? req.body.token   : null;
    const customSubject = req.body && typeof req.body.subject === 'string' ? req.body.subject : null;
    const customBody    = req.body && typeof req.body.body    === 'string' ? req.body.body    : null;
    try {
      // Resolve masked email and form link from existing token or DB
      let maskedEmail = null;
      let formLink    = null;
      if (preToken) {
        const tokenHash = crypto.createHash('sha256').update(preToken).digest('hex');
        const { rows } = await pool.query(
          `SELECT masked_email, form_link FROM customer_info_submissions
           WHERE token_hash = $1 AND contact_id = $2 LIMIT 1`,
          [tokenHash, cid]
        );
        if (rows.length) { maskedEmail = rows[0].masked_email; formLink = rows[0].form_link; }
      }
      if (!maskedEmail) {
        const { rows } = await pool.query(
          `SELECT masked_email, form_link FROM customer_info_submissions
           WHERE contact_id = $1 AND expires_at > NOW() AND submitted_at IS NULL
           ORDER BY created_at DESC LIMIT 1`,
          [cid]
        );
        if (rows.length) { maskedEmail = rows[0].masked_email; formLink = rows[0].form_link; }
      }
      maskedEmail = maskedEmail || '***@example.com';
      formLink    = formLink    || `${appBaseUrl()}/customer-info/[link]`;

      const tmpl = await getEmailTemplate(INVITE_TEMPLATE_KEY);
      const customBodyHtml = customBody != null
        ? customBody.split('\n').map(l => l.trim() === '' ? '' : `<p>${escapeHtml(l)}</p>`).join('')
        : null;
      const effectiveTmpl = {
        ...tmpl,
        ...(customBody    != null ? { body_text: customBody, body_html: customBodyHtml } : {}),
        ...(customSubject != null ? { subject: customSubject } : {}),
      };
      const rendered = renderEmail(effectiveTmpl, {
        textVars: { maskedEmail, formLink },
        htmlVars: { maskedEmail: escapeHtml(maskedEmail), formLink: escapeHtml(formLink) },
      });
      if (!effectiveTmpl.body_html || !effectiveTmpl.body_html.trim()) {
        rendered.html = rendered.text.split('\n')
          .map(l => l.trim() === '' ? '' : `<p>${escapeHtml(l)}</p>`).join('');
      }
      res.json(rendered);
    } catch (err) {
      logger.error({ err: err.message }, '[customer-info] upload-link-email-preview error:');
      res.status(500).json({ error: 'Could not render email preview.' });
    }
  }
);

// Authenticated: send invite link to customer
// POST /api/card-actions/upload-photos-and-info
// Body: { contactId, token? } — if token provided, sends email for that pre-generated link
router.post('/api/card-actions/upload-photos-and-info',
  isAuthenticated,
  requirePrivilege('member'),
  async (req, res) => {
    const { contactId, token: preToken, emailSubject: customSubject, emailBody: customBody } = req.body;
    if (!contactId || typeof contactId !== 'string' || !/^\d+$/.test(String(contactId).trim())) {
      return res.status(400).json({ error: 'contactId is required.' });
    }
    const cid = String(contactId).trim();
    const emailOverride = {
      subject: typeof customSubject === 'string' ? customSubject : undefined,
      body:    typeof customBody    === 'string' ? customBody    : undefined,
    };

    if (!checkStaffSendCooldown(cid)) {
      return res.status(429).json({ error: 'Email was just sent for this contact. Please wait before sending again.' });
    }

    try {
      // If a pre-generated token is provided, use it — no new DB row
      if (preToken && typeof preToken === 'string') {
        const tokenHash = crypto.createHash('sha256').update(preToken).digest('hex');
        const { rows } = await pool.query(
          `SELECT contact_email, masked_email, contact_name FROM customer_info_submissions
           WHERE token_hash = $1 AND contact_id = $2`,
          [tokenHash, cid]
        );
        if (!rows.length) {
          clearStaffSendCooldown(cid);
          return res.status(404).json({ error: 'Pre-generated link not found.' });
        }
        const row = rows[0];
        const formLink = `${appBaseUrl()}/customer-info/${encodeURIComponent(preToken)}`;
        await sendCustomerInviteEmail(row.contact_email, row.masked_email, formLink, emailOverride.subject, emailOverride.body);
        return res.status(200).json({ ok: true });
      }

      // Original flow: fetch from HubSpot, generate token, create row, send email
      let contact;
      try {
        contact = await fetchContactFromHubSpot(cid);
      } catch (err) {
        logger.error({ err: err.message }, '[customer-info] Failed to fetch contact from HubSpot:');
        clearStaffSendCooldown(cid);
        return res.status(502).json({ error: 'Could not fetch contact from HubSpot.' });
      }

      const props = contact.properties || {};
      const email = (props.email || '').trim();
      if (!email) {
        clearStaffSendCooldown(cid);
        return res.status(400).json({ error: 'Contact has no email address in HubSpot.' });
      }
      const phone   = (props.mobilephone || props.phone || '').trim();
      const firstName = (props.firstname || '').trim();
      const lastName  = (props.lastname  || '').trim();
      const name = [firstName, lastName].filter(Boolean).join(' ') || email;

      const rawToken  = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = new Date(Date.now() + LINK_TTL_DAYS * 24 * 60 * 60 * 1000);

      const formLink = `${appBaseUrl()}/customer-info/${encodeURIComponent(rawToken)}`;

      // Atomically expire any existing active links and insert the new one so
      // concurrent send-invite requests cannot leave two live bearer tokens.
      const uploadClient = await pool.connect();
      try {
        await uploadClient.query('BEGIN');
        await uploadClient.query('SELECT pg_advisory_xact_lock(hashtext($1))', [cid]);

        const expireResult = await uploadClient.query(
          `UPDATE customer_info_submissions
           SET expires_at = NOW()
           WHERE contact_id = $1 AND expires_at > NOW() AND submitted_at IS NULL`,
          [cid]
        );
        if (expireResult.rowCount > 0) {
          logger.info(`[customer-info] Expired ${expireResult.rowCount} active link(s) for contact ${cid} before sending new one`);
        }

        await uploadClient.query(
          `INSERT INTO customer_info_submissions
             (contact_id, contact_name, contact_email, token_hash, expires_at,
              masked_email, masked_phone, form_link)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [cid, name, email, tokenHash, expiresAt.toISOString(),
           maskEmail(email), maskPhone(phone), formLink]
        );

        await uploadClient.query('COMMIT');
      } catch (err) {
        await uploadClient.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        uploadClient.release();
      }

      await sendCustomerInviteEmail(email, maskEmail(email), formLink, emailOverride.subject, emailOverride.body);

      res.status(201).json({ ok: true });
    } catch (err) {
      clearStaffSendCooldown(cid);
      throw err;
    }
  }
);

// Public: create an anonymous generic draft row and return its token
// POST /api/customer-info/draft
router.post('/api/customer-info/draft', genericDraftLimiter, express.json({ limit: '1kb' }), async (req, res) => {
  const rawToken  = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + LINK_TTL_DAYS * 24 * 60 * 60 * 1000);
  try {
    await pool.query(
      `INSERT INTO customer_info_submissions
         (contact_id, token_hash, expires_at, is_generic)
       VALUES (NULL, $1, $2, true)`,
      [tokenHash, expiresAt.toISOString()]
    );
  } catch (err) {
    logger.error({ err: err.message }, '[customer-info] Failed to create generic draft row:');
    return res.status(500).json({ error: 'Could not create form. Please try again.' });
  }
  res.json({ token: rawToken });
});

// Public: get form data for a token
// GET /api/customer-info/:token
router.get('/api/customer-info/:token', async (req, res) => {
  const row = await lookupToken(req.params.token);
  if (!row) {
    // Return 410 (same as expired) with status:"not_found" and no maskedEmail so
    // the frontend can use the same expired-page path but omit the resend button.
    return res.status(410).json({ error: 'Link not found.', status: 'not_found' });
  }
  if (new Date(row.expires_at) < new Date()) {
    return res.status(410).json({
      error: 'This link has expired.',
      status: 'expired',
      maskedEmail: row.masked_email || '',
    });
  }
  if (row.submitted_at) {
    return res.status(410).json({ error: 'You have already submitted this form. Thank you!', status: 'submitted' });
  }
  // Generic (token-less) rows: no masked contact info, just signal isGeneric
  if (row.is_generic) {
    return res.json({ isGeneric: true });
  }
  res.json({
    maskedEmail:  row.masked_email,
    maskedPhone:  row.masked_phone,
    contactName:  row.contact_name,
  });
});

// Public: sign saved PDF/photo keys so a customer can verify and preview them
// after a draft restore. Gated by a valid, unsubmitted form token.
// POST /api/customer-info/:token/sign
router.post('/api/customer-info/:token/sign', express.json({ limit: '4kb' }), async (req, res) => {
  const row = await lookupToken(req.params.token);
  if (!row) return res.status(404).json({ error: 'Link not found.' });
  if (row.submitted_at) return res.status(410).json({ error: 'Already submitted.' });
  if (new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'Link expired.' });

  const keys = req.body?.keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    return res.status(400).json({ error: 'keys must be a non-empty array.' });
  }
  if (keys.length > 20) {
    return res.status(400).json({ error: 'Too many keys — maximum 20 per request.' });
  }

  // Verify object existence for each key before signing so the caller can
  // immediately render "file no longer available" instead of getting a 404
  // only after clicking. Use storage.objectExists (header-only, no content
  // download) rather than downloadBytes (up to 15 MB per file) to keep this
  // cheap.
  const results = await Promise.all(keys.map(async key => {
    if (!isValidCiKey(key)) {
      return { key, url: null };
    }
    const storagePath = `customer-info-photos/${key.slice('obj:ci_'.length)}`;
    try {
      const exists = await storage.objectExists(storagePath);
      if (!exists) return { key, url: null };
    } catch {
      // If the existence check itself fails (e.g. storage misconfigured), sign
      // optimistically — better to give a potentially-broken link than a false
      // "unavailable" notice.
      return { key, url: signPublicCustomerPhotoUrl(key) };
    }
    return { key, url: signPublicCustomerPhotoUrl(key) };
  }));

  res.json({ results });
});

// Public: submit the form
// POST /api/customer-info/:token
router.post('/api/customer-info/:token', express.json({ limit: '1mb' }), async (req, res) => {
  // Fast pre-flight lookup (no lock) — avoids opening a transaction for bogus tokens.
  const preRow = await lookupToken(req.params.token);
  if (!preRow) {
    return res.status(404).json({ error: 'Link not found.' });
  }
  if (new Date(preRow.expires_at) < new Date()) {
    return res.status(410).json({ error: 'This link has expired.', status: 'expired' });
  }
  if (preRow.submitted_at) {
    return res.status(410).json({ error: 'Already submitted.', status: 'submitted' });
  }

  const {
    structuredAddress,
    roomCount, roomNotes,
    photoKeys,
    // Generic-mode fields (only required when row.is_generic is true)
    name: submittedName, email: submittedEmail, phone: submittedPhone,
    haveWeSpoken,
  } = req.body;

  // Generic-mode extra validation (before opening a transaction)
  if (preRow.is_generic) {
    if (!submittedName || typeof submittedName !== 'string' || !submittedName.trim()) {
      return res.status(400).json({ error: 'Full name is required.' });
    }
    if (!submittedEmail || typeof submittedEmail !== 'string' || !submittedEmail.trim() || !submittedEmail.includes('@')) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }
    if (!submittedPhone || typeof submittedPhone !== 'string' || !submittedPhone.trim()) {
      return res.status(400).json({ error: 'Phone number is required.' });
    }
  }

  // Normalise submittedPhone to E.164 (generic flow only).
  // Reject early if the number cannot be parsed as a valid phone number.
  let normalisedPhone = null;
  if (preRow.is_generic && submittedPhone && typeof submittedPhone === 'string' && submittedPhone.trim()) {
    normalisedPhone = normalizePhone(submittedPhone.trim(), 'GB');
    if (normalisedPhone === null) {
      return res.status(400).json({ error: 'Please enter a valid phone number (e.g. 07700 900123).' });
    }
  }

  // Validate inputs before opening the transaction.
  if (!['1', '2', '3+'].includes(roomCount)) {
    return res.status(400).json({ error: 'roomCount must be 1, 2, or 3+.' });
  }
  const parsedAddress = structuredAddressSchema.safeParse(structuredAddress || {});
  if (!parsedAddress.success) {
    return res.status(400).json({ error: 'A valid address is required.' });
  }
  const address = parsedAddress.data;
  if (isAddressEmpty(address) || !(address.addressLines[0] || '').trim()) {
    return res.status(400).json({ error: 'First line of address is required.' });
  }
  if (!(address.locality || '').trim()) {
    return res.status(400).json({ error: 'City is required.' });
  }
  if (!(address.postalCode || '').trim()) {
    return res.status(400).json({ error: 'Postcode is required.' });
  }
  // Legacy flat mirrors kept in sync for read-fallback on old display surfaces.
  const addressLine1 = address.addressLines[0] || '';
  const city = address.locality || '';
  const postcode = address.postalCode || '';
  const rawKeys = Array.isArray(photoKeys) ? photoKeys : [];
  const badKey = rawKeys.find(k => !isValidCiKey(k));
  if (badKey !== undefined) {
    return res.status(400).json({ error: 'Invalid photo key format.' });
  }
  const keys = rawKeys;

  // Reject early if AWAITING_PHOTOS no longer exists in lead_status_config
  // so the submission fails before we commit any DB changes.
  try {
    await assertLeadStatusKey('AWAITING_PHOTOS');
  } catch (e) {
    if (e.code === 'LEAD_STATUS_REMOVED') {
      return res.status(422).json({ error: e.message, code: 'LEAD_STATUS_REMOVED', removedKey: e.removedKey });
    }
    throw e;
  }

  // Atomically lock the row, re-verify it is still unsubmitted, and mark it
  // submitted — all inside a single transaction.  This prevents two concurrent
  // requests using the same valid bearer token from both succeeding.
  const client = await pool.connect();
  let fresh;
  let lockedContactId;
  let submittedRowId;
  let isGenericRow = false;
  try {
    await client.query('BEGIN');

    // Lock the row so any concurrent submission request blocks here until we commit.
    const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');
    const lockR = await client.query(
      `SELECT * FROM customer_info_submissions WHERE token_hash = $1 LIMIT 1 FOR UPDATE`,
      [tokenHash]
    );
    const row = lockR.rows[0];
    if (row) { lockedContactId = row.contact_id; isGenericRow = !!row.is_generic; }

    if (!row) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Link not found.' });
    }
    if (new Date(row.expires_at) < new Date()) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'This link has expired.', status: 'expired' });
    }
    if (row.submitted_at) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'Already submitted.', status: 'submitted' });
    }

    // Mark submitted (clear form_link so staff can no longer use the stale URL).
    // For generic rows, also persist contact_name/email from the submitted body and have_we_spoken.
    if (isGenericRow) {
      await client.query(
        `UPDATE customer_info_submissions SET
           submitted_at       = NOW(),
           form_link          = NULL,
           contact_name       = $1,
           contact_email      = $2,
           contact_phone      = $3,
           masked_email       = $4,
           address_line1      = $5,
           city               = $6,
           postcode           = $7,
           structured_address = $8::jsonb,
           room_count         = $9,
           room_notes         = $10,
           photo_keys         = $11::jsonb,
           have_we_spoken     = $12
         WHERE id = $13`,
        [
          submittedName.trim(),
          submittedEmail.trim().toLowerCase(),
          normalisedPhone || null,
          maskEmail(submittedEmail.trim().toLowerCase()),
          addressLine1.trim(),
          city.trim(),
          postcode.trim(),
          JSON.stringify(address),
          roomCount,
          roomNotes || null,
          JSON.stringify(keys),
          (haveWeSpoken && typeof haveWeSpoken === 'string' && haveWeSpoken.trim()) ? haveWeSpoken.trim() : null,
          row.id,
        ]
      );
    } else {
      await client.query(
        `UPDATE customer_info_submissions SET
           submitted_at       = NOW(),
           form_link          = NULL,
           address_line1      = $1,
           city               = $2,
           postcode           = $3,
           structured_address = $4::jsonb,
           room_count         = $5,
           room_notes         = $6,
           photo_keys         = $7::jsonb
         WHERE id = $8`,
        [
          addressLine1.trim(),
          city.trim(),
          postcode.trim(),
          JSON.stringify(address),
          roomCount,
          roomNotes || null,
          JSON.stringify(keys),
          row.id,
        ]
      );

      // Expire every other active-pending link for this contact so a spare bearer
      // token that was issued before this submission cannot be used to submit a
      // second, fraudulent response after the legitimate one has gone through.
      // (For generic rows, sibling invalidation happens after HubSpot contact resolution.)
      const siblingResult = await client.query(
        `UPDATE customer_info_submissions
         SET expires_at = NOW()
         WHERE contact_id = $1 AND id != $2
           AND submitted_at IS NULL AND expires_at > NOW()`,
        [row.contact_id, row.id]
      );
      if (siblingResult.rowCount > 0) {
        logger.info(`[customer-info] Expired ${siblingResult.rowCount} sibling link(s) for contact ${row.contact_id} after submission`);
      }
    }

    submittedRowId = row.id;
    await client.query('COMMIT');

    // Fetch fresh row for emails (outside the transaction — lock is released).
    const freshR = await client.query(`SELECT * FROM customer_info_submissions WHERE id = $1`, [row.id]);
    fresh = freshR.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // ── Generic-row post-submission: resolve or create HubSpot contact ─────────
  if (isGenericRow && process.env.HUBSPOT_ACCESS_TOKEN) {
    try {
      const normEmail = submittedEmail.trim().toLowerCase();
      let existingContact = null;
      try { existingContact = await searchHubSpotContactByEmail(normEmail); } catch (_) { /* non-fatal */ }

      let resolvedContactId = null;
      let resolvedName      = submittedName.trim();
      const hsAddr = addressToHubspot(address);

      if (existingContact) {
        resolvedContactId = String(existingContact.id);
        resolvedName = [
          existingContact.properties?.firstname,
          existingContact.properties?.lastname,
        ].filter(Boolean).join(' ') || resolvedName;
        const currentStatus = (existingContact.properties?.hs_lead_status || '').trim();
        const pastPhotos = await isLeadStatusPastPhotos(currentStatus);
        const patchProps = {
          address: hsAddr.address,
          city:    hsAddr.city,
          state:   hsAddr.state,
          zip:     hsAddr.zip,
          country: hsAddr.country,
        };
        if (!pastPhotos) patchProps.hs_lead_status = 'AWAITING_PHOTOS';
        await _patchContactProperties(resolvedContactId, patchProps);
      } else {
        try {
          const newContact = await createHubSpotContact(submittedName.trim(), normEmail, normalisedPhone || submittedPhone.trim());
          resolvedContactId = String(newContact.id);
          // Patch address fields onto the newly created contact
          const patchProps = {
            address: hsAddr.address,
            city:    hsAddr.city,
            state:   hsAddr.state,
            zip:     hsAddr.zip,
            country: hsAddr.country,
          };
          await _patchContactProperties(resolvedContactId, patchProps);
        } catch (createErr) {
          logger.error({ err: createErr.message }, '[customer-info] Failed to create HubSpot contact for generic submission (non-fatal):');
        }
      }

      if (resolvedContactId) {
        lockedContactId = resolvedContactId;
        // Store contact_id on the submission row and expire sibling links
        await pool.query(
          `UPDATE customer_info_submissions SET contact_id = $1, contact_name = $2 WHERE id = $3`,
          [resolvedContactId, resolvedName, submittedRowId]
        );
        // Refresh the fresh row with the resolved contact info
        const freshR2 = await pool.query(`SELECT * FROM customer_info_submissions WHERE id = $1`, [submittedRowId]);
        if (freshR2.rows[0]) fresh = freshR2.rows[0];
        // Expire any other active pending links for this contact (from non-generic or previous generic flows)
        const siblingResult = await pool.query(
          `UPDATE customer_info_submissions
           SET expires_at = NOW()
           WHERE contact_id = $1 AND id != $2
             AND submitted_at IS NULL AND expires_at > NOW()`,
          [resolvedContactId, submittedRowId]
        );
        if (siblingResult.rowCount > 0) {
          logger.info(`[customer-info] Generic: expired ${siblingResult.rowCount} sibling link(s) for contact ${resolvedContactId} after submission`);
        }
      }
    } catch (err) {
      logger.error({ err: err.message }, '[customer-info] Generic submission HubSpot resolution failed (non-fatal):');
    }
  } else if (isGenericRow) {
    // HubSpot not configured — just update the row with the submitted name/email
    logger.info('[customer-info] HUBSPOT_ACCESS_TOKEN not set — skipping contact resolution for generic submission');
  }

  // Notify all connected dashboard tabs so the "Photos received" badge appears
  // on the projects board without a page refresh.
  pushSseEvent({ type: 'customer_info_submitted', contactId: lockedContactId });

  // Run post-submission side effects concurrently:
  // — admin notification email (photo downloads + send)
  // — customer thank-you email
  // — HubSpot lead-status/address patch (non-generic path only; generic path
  //   resolved HubSpot above where it also populates `fresh` with contact_id)
  const emailTo = fresh.contact_email;
  const postSubmitTasks = [
    sendAdminNotificationEmail(fresh).catch(e => {
      logger.error({ err: e.message }, '[customer-info] Admin notification failed:');
    }),
    emailTo
      ? sendCustomerThankYouEmail(emailTo, fresh.contact_name).catch(e => {
          logger.error({ err: e.message }, '[customer-info] Thank-you email failed:');
        })
      : null,
  ];

  if (!isGenericRow && process.env.HUBSPOT_ACCESS_TOKEN) {
    const hsAddr = addressToHubspot(address);
    postSubmitTasks.push(
      _patchContactProperties(lockedContactId, {
        hs_lead_status: 'AWAITING_PHOTOS',
        address: hsAddr.address,
        city:    hsAddr.city,
        state:   hsAddr.state,
        zip:     hsAddr.zip,
        country: hsAddr.country,
      }).catch(err => {
        logger.error({ err: err.message }, '[customer-info] HubSpot update failed (non-fatal):');
      })
    );
  }

  await Promise.all(postSubmitTasks.filter(Boolean));

  res.json({ ok: true });
});

// Public: self-serve resend for an expired link (Turnstile + rate-limited)
// POST /api/customer-info/:token/resend-expired
router.post('/api/customer-info/:token/resend-expired', express.json({ limit: '4kb' }), async (req, res) => {
  // 1. Turnstile must be verified before any DB work or rate-limit checks.
  const captchaResult = await verifyTurnstileForResend(
    req.body?.captchaToken || req.body?.['cf-turnstile-response'],
    req.ip
  );
  if (!captchaResult.ok) {
    return res.status(400).json({ error: 'Captcha verification failed. Please try again.' });
  }

  // 2. IP rate limit (max 5 per IP per hour) — checked after Turnstile so bots
  //    can't exhaust this limit without solving the captcha first.
  if (!checkIpResendLimit(req.ip)) {
    return res.status(429).json({ error: 'Too many requests — please try again later.' });
  }

  // 3. Look up the original token (using constant-time hash comparison via lookupToken).
  const rawToken = req.params.token;
  const row = await lookupToken(rawToken);
  if (!row) {
    return res.status(404).json({ error: 'Link not found.' });
  }
  if (row.submitted_at) {
    return res.status(400).json({ error: 'This form has already been submitted.' });
  }
  // Must be expired (not still-active) to use self-serve resend.
  if (new Date(row.expires_at) >= new Date()) {
    return res.status(400).json({ error: 'This link has not expired yet — please use the original link.' });
  }

  // 4. Per-token rate limit (max 3 resends per token_hash per 24-hour rolling window).
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const countR = await pool.query(
    `SELECT COUNT(*) AS cnt FROM customer_info_resend_log
     WHERE token_hash = $1 AND requested_at > NOW() - INTERVAL '24 hours'`,
    [tokenHash]
  );
  if (parseInt(countR.rows[0]?.cnt ?? 0, 10) >= 3) {
    return res.status(429).json({ error: 'Too many requests — please try again later.' });
  }

  // 5. Generate fresh token + insert new submission row.
  //    First, expire all currently active pending rows for this contact so only
  //    one active link exists at a time (the new one we are about to insert).
  const freshRaw   = crypto.randomBytes(32).toString('hex');
  const freshHash  = crypto.createHash('sha256').update(freshRaw).digest('hex');
  const freshExpiry = new Date(Date.now() + LINK_TTL_DAYS * 24 * 60 * 60 * 1000);
  const formLink   = `${appBaseUrl()}/customer-info/${encodeURIComponent(freshRaw)}`;

  // Atomically expire any existing active links and insert the new one.
  // The advisory lock serialises concurrent self-serve resend requests for the
  // same contact so only one fresh bearer token is issued at a time.
  const resendExpClient = await pool.connect();
  try {
    await resendExpClient.query('BEGIN');
    await resendExpClient.query('SELECT pg_advisory_xact_lock(hashtext($1))', [row.contact_id]);

    const expireResult = await resendExpClient.query(
      `UPDATE customer_info_submissions
       SET expires_at = NOW()
       WHERE contact_id = $1 AND expires_at > NOW() AND submitted_at IS NULL`,
      [row.contact_id]
    );
    if (expireResult.rowCount > 0) {
      logger.info(`[customer-info] Self-serve resend: expired ${expireResult.rowCount} active link(s) for contact ${row.contact_id} before inserting new one`);
    }

    await resendExpClient.query(
      `INSERT INTO customer_info_submissions
         (contact_id, contact_name, contact_email, token_hash, expires_at,
          masked_email, masked_phone, form_link)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [row.contact_id, row.contact_name, row.contact_email, freshHash,
       freshExpiry.toISOString(), row.masked_email, row.masked_phone, formLink]
    );

    await resendExpClient.query('COMMIT');
  } catch (err) {
    await resendExpClient.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    resendExpClient.release();
  }

  // 6. Log the resend (stores token_hash only — never the raw token).
  await pool.query(
    `INSERT INTO customer_info_resend_log (token_hash) VALUES ($1)`,
    [tokenHash]
  );

  // 7. Send invitation email.
  await sendCustomerInviteEmail(row.contact_email, row.masked_email || maskEmail(row.contact_email || ''), formLink);

  logger.info(`[customer-info] Self-serve resend issued for contact ${row.contact_id}`);
  res.json({ ok: true, maskedEmail: row.masked_email || '' });
});

// Helper: delete a list of temp file paths left by diskStorage, ignoring errors.
async function _deleteTempFiles(paths) {
  for (const p of paths) {
    try { await fs.promises.unlink(p); } catch { /* ignore */ }
  }
}

// Public: upload photos (before form submission)
// POST /api/customer-info/:token/photos
router.post('/api/customer-info/:token/photos',
  async (req, res, next) => {
    // Validate token first — before accepting any upload bytes (even to disk).
    const row = await lookupToken(req.params.token);
    if (!row) return res.status(404).json({ error: 'Link not found.' });
    if (new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'Link expired.' });
    if (row.submitted_at) return res.status(410).json({ error: 'Already submitted.' });
    req._cisRow = row;
    next();
  },
  async (req, res, next) => {
    // IP rate limit: max 10 upload requests per IP per 10 minutes.
    if (!checkUploadIpRateLimit(req.ip)) {
      return res.status(429).json({ error: 'Too many photo uploads — please wait a few minutes before uploading more.' });
    }
    // Per-token rate limit: max 5 upload requests per token per 10 minutes.
    const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');
    if (!checkTokenUploadRateLimit(tokenHash)) {
      return res.status(429).json({ error: 'Too many photo uploads — please wait a few minutes before uploading more.' });
    }
    // Pre-check: reject early when the token is already at capacity so multer
    // never writes unnecessary temp files to disk.
    if ((req._cisRow.photo_upload_count || 0) >= MAX_TOTAL_UPLOADS_PER_TOKEN) {
      return res.status(429).json({ error: 'Photo upload limit reached for this link. Please contact us if you need to add more photos.' });
    }
    req._ciTokenHash = tokenHash;
    next();
  },
  // multer writes each file to the OS temp dir on disk — no heap buffering.
  _photoUpload.array('photos', MAX_PHOTO_FILES),
  async (req, res) => {
    const rawFiles = req.files;
    if (rawFiles != null && !Array.isArray(rawFiles)) {
      return res.status(400).json({ error: 'Invalid files payload.' });
    }
    const files = rawFiles || [];
    const filesAreValid = files.every((f) =>
      f &&
      typeof f === 'object' &&
      typeof f.path === 'string' &&
      f.path.length > 0 &&
      typeof f.mimetype === 'string'
    );
    if (!filesAreValid) {
      return res.status(400).json({ error: 'Invalid files payload.' });
    }
    const tempPaths = files.map(f => f.path);

    if (!files.length) {
      return res.status(400).json({ error: 'No files uploaded.' });
    }

    // Atomically claim quota slots before uploading to object storage.
    // The conditional WHERE clause ensures concurrent requests cannot together
    // push the total past MAX_TOTAL_UPLOADS_PER_TOKEN — PostgreSQL's row-level
    // lock on the UPDATE guarantees this is race-free.
    let quotaResult;
    try {
      quotaResult = await pool.query(
        `UPDATE customer_info_submissions
         SET photo_upload_count = photo_upload_count + $1
         WHERE id = $2 AND photo_upload_count + $1 <= $3
         RETURNING photo_upload_count`,
        [files.length, req._cisRow.id, MAX_TOTAL_UPLOADS_PER_TOKEN]
      );
    } catch (err) {
      await _deleteTempFiles(tempPaths);
      logger.error({ err: err.message }, '[customer-info] Quota claim failed:');
      return res.status(500).json({ error: 'Could not process upload. Please try again.' });
    }
    if (quotaResult.rowCount === 0) {
      await _deleteTempFiles(tempPaths);
      return res.status(429).json({ error: 'Photo upload limit reached for this link. Please contact us if you need to add more photos.' });
    }

    // Upload each file from disk to object storage via storage.uploadFile
    // (streams from disk — no heap buffering).
    const keys = [];
    for (const file of files) {
      try {
        const key = await uploadPhotoFileToStorage(file.path, file.mimetype);
        keys.push(key);
      } catch (err) {
        logger.error({ err: err.message }, '[customer-info] Photo upload failed:');
        await _deleteTempFiles(tempPaths);
        const isStorageConfigErr = /bucket|object storage/i.test(err.message);
        const userMsg = isStorageConfigErr
          ? 'Photo uploads are temporarily unavailable. Please contact us and we\'ll be in touch to collect your photos another way.'
          : 'Photo upload failed: ' + err.message;
        return res.status(500).json({ error: userMsg });
      }
    }

    // Always clean up all temp files before responding.
    await _deleteTempFiles(tempPaths);

    res.json({ ok: true, keys });
  }
);

// Authenticated: serve a signed customer photo
// GET /api/customer-info-photos/:key
router.get('/api/customer-info-photos/:key', isAuthenticated, async (req, res) => {
  const key = decodeURIComponent(req.params.key);
  const { exp, sig } = req.query;
  if (!verifyCustomerPhotoUrl(key, exp, sig)) {
    return res.status(403).json({ error: 'Invalid or expired image URL.' });
  }
  try {
    const id   = key.slice('obj:ci_'.length);
    const name = `customer-info-photos/${id}`;
    let buf;
    try {
      buf = await storage.downloadBytes(name);
    } catch (e) {
      throw _friendlyStorageError(e);
    }
    if (!buf) {
      return res.status(404).json({ error: 'Image not found.' });
    }
    const ext = id.split('.').pop() || 'jpg';
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'pdf' ? 'application/pdf' : 'image/jpeg';
    res.set('Content-Type', mime);
    res.set('Cache-Control', 'private, max-age=3600');
    if (ext === 'pdf') {
      res.set('Content-Disposition', 'inline');
    }
    res.send(buf);
  } catch (err) {
    logger.error({ err: err.message }, '[customer-info] Failed to serve photo:');
    res.status(500).json({ error: 'Failed to serve image.' });
  }
});

// Public: serve a customer-uploaded file via a short-lived HMAC-signed URL.
// No staff authentication required — the HMAC signature is the sole gate.
// Used by the customer-info page after a draft restore to let customers
// verify and download PDFs they previously uploaded.
// GET /api/customer-info-preview/:key?exp=...&sig=...
router.get('/api/customer-info-preview/:key', async (req, res) => {
  const key = decodeURIComponent(req.params.key);
  const { exp, sig } = req.query;
  if (!verifyCustomerPhotoUrl(key, exp, sig)) {
    return res.status(403).json({ error: 'Invalid or expired preview URL.' });
  }
  try {
    const id   = key.slice('obj:ci_'.length);
    const name = `customer-info-photos/${id}`;
    let buf;
    try {
      buf = await storage.downloadBytes(name);
    } catch (e) {
      throw _friendlyStorageError(e);
    }
    if (!buf) {
      return res.status(404).json({ error: 'File not found.' });
    }
    const ext  = id.split('.').pop() || 'jpg';
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'pdf' ? 'application/pdf' : 'image/jpeg';
    res.set('Content-Type', mime);
    res.set('Cache-Control', 'private, max-age=3600');
    if (ext === 'pdf') {
      res.set('Content-Disposition', 'inline');
    }
    res.send(buf);
  } catch (err) {
    logger.error({ err: err.message }, '[customer-info] Failed to serve preview:');
    res.status(500).json({ error: 'Failed to serve file.' });
  }
});

// Authenticated: resend a fresh invite link for a contact
// POST /api/customer-info/by-contact/:contactId/resend
// Body: { token? } — if token provided, sends email for that pre-generated link
router.post('/api/customer-info/by-contact/:contactId/resend',
  isAuthenticated,
  requirePrivilege('member'),
  async (req, res) => {
    const cid = String(req.params.contactId || '').trim();
    if (!cid || !/^\d+$/.test(cid)) {
      return res.status(400).json({ error: 'Invalid contactId.' });
    }

    const resendCooldownCheck = checkStaffResendCooldown(cid);
    if (!resendCooldownCheck.allowed) {
      const retryAfterSeconds = Math.ceil(resendCooldownCheck.remainingMs / 1000);
      res.set('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        error: 'Re-send cooldown active — please wait a moment before trying again.',
        retryAfterSeconds,
      });
    }

    const preToken      = req.body && typeof req.body.token   === 'string' ? req.body.token   : null;
    const customSubject = req.body && typeof req.body.emailSubject === 'string' ? req.body.emailSubject : undefined;
    const customBody    = req.body && typeof req.body.emailBody    === 'string' ? req.body.emailBody    : undefined;

    try {
      // If a pre-generated token is provided, use it — no new DB row
      if (preToken) {
        const tokenHash = crypto.createHash('sha256').update(preToken).digest('hex');
        const { rows } = await pool.query(
          `SELECT contact_email, masked_email, contact_name, form_link FROM customer_info_submissions
           WHERE token_hash = $1 AND contact_id = $2`,
          [tokenHash, cid]
        );
        if (!rows.length) {
          clearStaffResendCooldown(cid);
          return res.status(404).json({ error: 'Pre-generated link not found.' });
        }
        const row = rows[0];
        const formLink = `${appBaseUrl()}/customer-info/${encodeURIComponent(preToken)}`;
        // Back-populate form_link for rows created before the column was added
        // (pre-migration rows have form_link = NULL; raw token is available here
        // so we can reconstruct and persist the URL now).
        if (!row.form_link) {
          await pool.query(
            `UPDATE customer_info_submissions SET form_link = $1 WHERE token_hash = $2`,
            [formLink, tokenHash]
          );
        }
        await sendCustomerInviteEmail(row.contact_email, row.masked_email, formLink, customSubject, customBody);
        logger.info(`[customer-info] Resent (pre-generated) invite link for contact ${cid}`);
        return res.json({ ok: true });
      }

      // Original flow: fetch from HubSpot, generate token, create row, send email
      let contact;
      try {
        contact = await fetchContactFromHubSpot(cid);
      } catch (err) {
        logger.error({ err: err.message }, '[customer-info] Failed to fetch contact from HubSpot:');
        clearStaffResendCooldown(cid);
        return res.status(502).json({ error: 'Could not fetch contact from HubSpot.' });
      }

      const props = contact.properties || {};
      const email = (props.email || '').trim();
      if (!email) {
        clearStaffResendCooldown(cid);
        return res.status(400).json({ error: 'Contact has no email address in HubSpot.' });
      }
      const phone     = (props.mobilephone || props.phone || '').trim();
      const firstName = (props.firstname || '').trim();
      const lastName  = (props.lastname  || '').trim();
      const name = [firstName, lastName].filter(Boolean).join(' ') || email;

      const rawToken  = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = new Date(Date.now() + LINK_TTL_DAYS * 24 * 60 * 60 * 1000);
      const formLink  = `${appBaseUrl()}/customer-info/${encodeURIComponent(rawToken)}`;

      // Atomically expire any existing active links and insert the new one so
      // concurrent staff resend requests cannot leave two live bearer tokens.
      const staffResendClient = await pool.connect();
      try {
        await staffResendClient.query('BEGIN');
        await staffResendClient.query('SELECT pg_advisory_xact_lock(hashtext($1))', [cid]);

        const staffExpireResult = await staffResendClient.query(
          `UPDATE customer_info_submissions
           SET expires_at = NOW()
           WHERE contact_id = $1 AND expires_at > NOW() AND submitted_at IS NULL`,
          [cid]
        );
        if (staffExpireResult.rowCount > 0) {
          logger.info(`[customer-info] Resend: expired ${staffExpireResult.rowCount} active link(s) for contact ${cid} before inserting new one`);
        }

        await staffResendClient.query(
          `INSERT INTO customer_info_submissions
             (contact_id, contact_name, contact_email, token_hash, expires_at,
              masked_email, masked_phone, form_link)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [cid, name, email, tokenHash, expiresAt.toISOString(),
           maskEmail(email), maskPhone(phone), formLink]
        );

        await staffResendClient.query('COMMIT');
      } catch (err) {
        await staffResendClient.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        staffResendClient.release();
      }

      await sendCustomerInviteEmail(email, maskEmail(email), formLink, customSubject, customBody);

      logger.info(`[customer-info] Resent invite link for contact ${cid}`);
      res.json({ ok: true });
    } catch (err) {
      // Clear the cooldown so staff can retry immediately after a transient error.
      clearStaffResendCooldown(cid);
      throw err;
    }
  }
);

// Authenticated (member+): list all submissions for a contact
// Viewers are intentionally excluded — the response includes form_link
// and signed photo URLs that a viewer must not see.
// form_link (a public bearer credential) is only returned to manager/admin
// users — a regular member can view submission history but cannot extract the
// live bearer URL to impersonate the customer on the public form.
// GET /api/customer-info/by-contact/:contactId
router.get('/api/customer-info/by-contact/:contactId', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const cid = String(req.params.contactId || '').trim();
  if (!cid || !/^\d+$/.test(cid)) {
    return res.status(400).json({ error: 'Invalid contactId.' });
  }

  // Re-query the acting user's privilege so it is always up-to-date after a
  // role change (the session-cached value lags until the next login).
  const userId = req.user?.claims?.sub;
  let canSeeFormLink = false;
  try {
    const privR = await pool.query(`SELECT privilege_level FROM users WHERE id = $1`, [userId]);
    const level = privR.rows[0]?.privilege_level || 'member';
    canSeeFormLink = level === 'manager' || level === 'admin';
  } catch {
    // If the privilege lookup fails, default to not exposing the bearer link.
  }

  const r = await pool.query(
    `SELECT id, contact_name, contact_email, contact_phone, created_at, expires_at, submitted_at,
            address_line1, city, postcode,
            structured_address,
            room_count, room_notes, photo_keys, masked_email, email_skipped_count,
            CASE WHEN submitted_at IS NULL THEN form_link ELSE NULL END AS form_link
     FROM customer_info_submissions
     WHERE contact_id = $1
     ORDER BY created_at DESC`,
    [cid]
  );
  const rows = r.rows.map(row => {
    // Prefer the stored structured address; fall back to the legacy flat columns
    // for old rows submitted before the structured_address column existed.
    const structuredAddress = row.structured_address
      || hubspotToAddress({ address: row.address_line1, city: row.city, zip: row.postcode, country: 'United Kingdom' });
    return {
      ...row,
      structuredAddress,
      email_skipped_count: row.email_skipped_count ?? 0,
      photoUrls: (row.photo_keys || []).map(k => signCustomerPhotoUrl(k)),
      // Strip the bearer link from the response for non-manager/admin callers.
      form_link: canSeeFormLink ? row.form_link : undefined,
    };
  });
  res.json(rows);
});

// One-time boot backfill: re-compute masked_email for rows that are NULL or
// still carry the old format (local: first-char-only, domain: ***.<tld>).
// Idempotent — rows already in the new format are unaffected.
// Runs fire-and-forget so it never blocks startup.
async function backfillMaskedEmails() {
  const label = '[backfill-masked-email]';
  // Old format domain was "***.<tld>" (three literal asterisks before the dot).
  // New format is "<char>**.<tld>" (one char + two asterisks).
  // Select rows that are NULL or whose masked_email still uses the old pattern.
  const { rows } = await pool.query(`
    SELECT id, contact_email
    FROM customer_info_submissions
    WHERE contact_email IS NOT NULL
      AND submitted_at IS NULL
      AND (masked_email IS NULL OR masked_email ~ '@\\*{3}\\.')
  `);
  if (rows.length === 0) return;
  logger.info(`${label} ${rows.length} row(s) need masked_email backfill`);
  let updated = 0;
  let failed  = 0;
  for (const row of rows) {
    try {
      const fresh = maskEmail(row.contact_email);
      await pool.query(
        `UPDATE customer_info_submissions SET masked_email = $1 WHERE id = $2`,
        [fresh, row.id]
      );
      updated++;
    } catch (e) {
      failed++;
      logger.warn({ err: e.message }, `${label} failed to update row ${row.id}:`);
    }
  }
  logger.info(`${label} done — updated ${updated}, failed ${failed}`);
}

// Boot-time diagnostic: count active-pending rows with no stored form_link.
// These rows were created before the form_link column was added; they cannot
// be backfilled (only the token_hash is stored, not the raw token).  Logging
// the count makes admins aware so they know to use Resend for affected rows.
async function logNullFormLinkCount() {
  const label = '[customer-info-boot]';
  try {
    const { rows } = await pool.query(`
      SELECT COUNT(*) AS cnt
      FROM customer_info_submissions
      WHERE submitted_at IS NULL
        AND expires_at > NOW()
        AND form_link IS NULL
    `);
    const cnt = parseInt(rows[0].cnt, 10);
    if (cnt > 0) {
      logger.info(`${label} ${cnt} active-pending submission(s) have no stored form_link ` +
        `(pre-migration rows — Copy/Open buttons will appear after the first staff resend).`);
    }
  } catch (e) {
    logger.warn({ err: e.message }, `${label} could not count null form_link rows:`);
  }
}

// Admin-only: list generic form submissions that could not be resolved to a
// HubSpot contact (contact_id IS NULL, is_generic = true, submitted_at IS NOT NULL).
// These rows were successfully submitted by the customer but the automatic
// HubSpot contact creation/lookup failed, so they are orphaned — no contact
// record links them, and they do not appear in any per-contact submission rail.
// GET /api/customer-info/unmatched
router.get('/api/customer-info/unmatched',
  isAuthenticated,
  requireAdmin,
  async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT id, contact_name, contact_email, contact_phone,
                address_line1, city, postcode, structured_address,
                room_count, room_notes, photo_keys, submitted_at, created_at,
                email_skipped_count
         FROM customer_info_submissions
         WHERE contact_id IS NULL
           AND is_generic = true
           AND submitted_at IS NOT NULL
         ORDER BY submitted_at DESC
         LIMIT 200`,
      );
      const rows = r.rows.map(row => {
        const structuredAddress = row.structured_address
          || hubspotToAddress({ address: row.address_line1, city: row.city, zip: row.postcode, country: 'United Kingdom' });
        return {
          ...row,
          structuredAddress,
          photoUrls: (row.photo_keys || []).map(k => signCustomerPhotoUrl(k)),
        };
      });
      res.json(rows);
    } catch (e) {
      logger.error({ err: e.message }, '[customer-info] GET /unmatched error');
      res.status(500).json({ error: 'Failed to load unmatched submissions.' });
    }
  }
);

// PATCH /api/customer-info/:id/link-contact
// Admin-only: manually link an unmatched generic submission to a HubSpot contact.
// Body: { contact_id: string, contact_name?: string }
// The row must still be unmatched (contact_id IS NULL) — linking an already-linked
// submission is rejected with 409 to prevent accidental overwrites.
router.patch('/api/customer-info/:id/link-contact',
  isAuthenticated,
  requireAdmin,
  async (req, res) => {
    const submissionId = parseInt(req.params.id, 10);
    if (!Number.isFinite(submissionId) || submissionId <= 0) {
      return res.status(400).json({ error: 'Invalid submission ID.' });
    }
    const { contact_id, contact_name } = req.body || {};
    if (!contact_id || typeof contact_id !== 'string' || !contact_id.trim()) {
      return res.status(400).json({ error: 'contact_id is required.' });
    }
    const contactIdStr = contact_id.trim();

    try {
      const result = await pool.query(
        `UPDATE customer_info_submissions
            SET contact_id   = $2,
                contact_name = CASE
                                 WHEN $3::text IS NOT NULL AND $3::text <> ''
                                 THEN $3::text
                                 ELSE contact_name
                               END,
                updated_at   = NOW()
          WHERE id         = $1
            AND contact_id IS NULL
            AND is_generic = true
            AND submitted_at IS NOT NULL
          RETURNING id`,
        [submissionId, contactIdStr, contact_name || null],
      );

      if (result.rowCount === 0) {
        // Check whether the row exists at all vs. was already linked.
        const check = await pool.query(
          `SELECT contact_id FROM customer_info_submissions WHERE id = $1`,
          [submissionId],
        );
        if (check.rowCount === 0) {
          return res.status(404).json({ error: 'Submission not found.' });
        }
        if (check.rows[0].contact_id !== null) {
          return res.status(409).json({ error: 'Submission is already linked to a contact.' });
        }
        return res.status(404).json({ error: 'Submission cannot be linked (not a generic submitted form).' });
      }

      logger.info(
        { submissionId, contactId: contactIdStr, adminUser: req.user?.id },
        '[customer-info] Admin manually linked unmatched submission to contact',
      );
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e.message }, '[customer-info] PATCH /link-contact error');
      res.status(500).json({ error: 'Failed to link submission.' });
    }
  },
);

// PATCH /api/customer-info/:id/unlink-contact
// Admin-only: undo a recent manual link, setting contact_id back to NULL.
// Only works on generic submitted rows that were manually linked
// (is_generic = true, submitted_at IS NOT NULL, contact_id IS NOT NULL).
router.patch('/api/customer-info/:id/unlink-contact',
  isAuthenticated,
  requireAdmin,
  async (req, res) => {
    const submissionId = parseInt(req.params.id, 10);
    if (!Number.isFinite(submissionId) || submissionId <= 0) {
      return res.status(400).json({ error: 'Invalid submission ID.' });
    }

    try {
      const result = await pool.query(
        `UPDATE customer_info_submissions
            SET contact_id   = NULL,
                contact_name = NULL,
                updated_at   = NOW()
          WHERE id           = $1
            AND contact_id   IS NOT NULL
            AND is_generic   = true
            AND submitted_at IS NOT NULL
          RETURNING id`,
        [submissionId],
      );

      if (result.rowCount === 0) {
        const check = await pool.query(
          `SELECT contact_id, is_generic, submitted_at FROM customer_info_submissions WHERE id = $1`,
          [submissionId],
        );
        if (check.rowCount === 0) {
          return res.status(404).json({ error: 'Submission not found.' });
        }
        return res.status(409).json({ error: 'Submission cannot be unlinked.' });
      }

      logger.info(
        { submissionId, adminUser: req.user?.id },
        '[customer-info] Admin unlinked submission from contact (undo)',
      );
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e.message }, '[customer-info] PATCH /unlink-contact error');
      res.status(500).json({ error: 'Failed to unlink submission.' });
    }
  },
);

module.exports = {
  router,
  ensureResendLogTable,
  backfillMaskedEmails,
  logNullFormLinkCount,
  signCustomerPhotoUrl,
  setSharedSseClients,
  setPatchContactProperties,
};
