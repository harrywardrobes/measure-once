// customer-info.js — upload_photos_and_info card action handler
// DB table, send-link route, public form routes (token-gated), photo upload,
// admin notification emails, HubSpot lead-status update, and dashboard viewer.

const express    = require('express');
const crypto     = require('crypto');
const multer     = require('multer');
const { Pool }   = require('pg');
const nodemailer = require('nodemailer');
const axios      = require('axios').create({ timeout: 12000 });
const path       = require('path');
const fs         = require('fs');
const { isAuthenticated, requirePrivilege } = require('./auth');

const pool   = new Pool({ connectionString: process.env.DATABASE_URL });
const router = express.Router();

// ── Shared SSE client registry (wired by server.js at startup) ────────────────
let _sseClients = null;
function setSharedSseClients(clients) { _sseClients = clients; }

// ── Cache invalidator (wired by server.js at startup) ─────────────────────────
// Called before emitting SSE so the next board refetch gets fresh HubSpot data.
let _invalidateProjectContactsCache = null;
function setProjectContactsCacheInvalidator(fn) { _invalidateProjectContactsCache = fn; }

function pushSseEvent(payload) {
  if (!_sseClients) return;
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of _sseClients) {
    try { client.write(msg); } catch { _sseClients.delete(client); }
  }
}

// ── Config ────────────────────────────────────────────────────────────────────
const LINK_TTL_DAYS = 7;

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
function hsBase() {
  return process.env.HUBSPOT_API_BASE_OVERRIDE || 'https://api.hubapi.com';
}
function hsHeaders() {
  return {
    Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

// ── Masking helpers ───────────────────────────────────────────────────────────
function maskEmail(email) {
  if (!email || typeof email !== 'string') return '';
  const [local, domain] = email.split('@');
  if (!domain) return email[0] + '***';
  const maskedLocal = local.length <= 2
    ? local[0] + '***'
    : local[0] + '***';
  const domainParts = domain.split('.');
  const maskedDomain = '***.' + domainParts[domainParts.length - 1];
  return `${maskedLocal}@${maskedDomain}`;
}
function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return digits.slice(0, 2) + '***' + digits.slice(-4);
}

// ── DB schema ─────────────────────────────────────────────────────────────────
async function ensureCustomerInfoSubmissionsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_info_submissions (
      id               SERIAL PRIMARY KEY,
      contact_id       TEXT NOT NULL,
      contact_name     TEXT,
      contact_email    TEXT,
      token_hash       TEXT NOT NULL UNIQUE,
      expires_at       TIMESTAMPTZ NOT NULL,
      submitted_at     TIMESTAMPTZ,
      masked_email     TEXT,
      masked_phone     TEXT,
      corrected_email  TEXT,
      corrected_mobile TEXT,
      address_line1    TEXT,
      city             TEXT,
      postcode         TEXT,
      room_count       TEXT,
      room_notes       TEXT,
      photo_keys       JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS cis_contact_id_idx ON customer_info_submissions (contact_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS cis_token_hash_idx ON customer_info_submissions (token_hash)
  `);
}

// ── Email templates ───────────────────────────────────────────────────────────
async function sendCustomerInviteEmail(contactEmail, maskedEmail, formLink) {
  const transport = createMailTransport();
  if (!transport) {
    console.warn('[customer-info] SMTP not configured — skipping invite email.');
    console.warn(`[customer-info] Form link (manual delivery): ${formLink}`);
    return;
  }
  const from    = buildFromHeader();
  const replyTo = buildReplyTo();
  try {
    await transport.sendMail({
      from, replyTo,
      to:      contactEmail,
      subject: 'Tell us about your home...',
      text: [
        `Hi,`,
        '',
        `We'd love to know a bit more about your home so we can put together the perfect quote for you.`,
        '',
        `This link is just for you (${maskedEmail}) — please click it to fill in a short form:`,
        '',
        `  ${formLink}`,
        '',
        `It only takes a few minutes and you can upload photos of the spaces you have in mind.`,
        '',
        `If you have any questions, just reply to this email.`,
        '',
        `Warm regards,`,
        `The Measure Once team`,
      ].join('\n'),
      html: `
        <p>Hi,</p>
        <p>We'd love to know a bit more about your home so we can put together the perfect quote for you.</p>
        <p>This link is just for you (${escapeHtml(maskedEmail)}) — please click the button below to fill in a short form:</p>
        <p style="margin:24px 0;">
          <a href="${escapeHtml(formLink)}"
             style="display:inline-block;padding:12px 24px;background:#7c3aed;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">
            Tell us about your home
          </a>
        </p>
        <p>It only takes a few minutes and you can upload photos of the spaces you have in mind.</p>
        <p>If you have any questions, just reply to this email.</p>
        <p>Warm regards,<br>The Measure Once team</p>
      `,
    });
    console.log(`[customer-info] Invite email sent to ${contactEmail}`);
  } catch (err) {
    console.error('[customer-info] Failed to send invite email:', err.message);
  }
}

async function sendAdminNotificationEmail(submission) {
  const admins = adminEmails();
  if (!admins.length) return;
  const transport = createMailTransport();
  if (!transport) {
    console.warn('[customer-info] SMTP not configured — skipping admin notification email.');
    return;
  }
  const from    = buildFromHeader();
  const replyTo = buildReplyTo();
  const { contact_name, contact_email, corrected_email, corrected_mobile,
          address_line1, city, postcode, room_count, room_notes } = submission;

  const roomLabel = room_count === '1' ? '1 room' : room_count === '2' ? '2 rooms' : '3+ rooms';
  const addressParts = [address_line1, city, postcode].filter(Boolean);
  const address = addressParts.join(', ') || '—';

  const base = appBaseUrl();
  const photoRows = (submission.photo_keys || [])
    .map(k => `${base}${signCustomerPhotoUrl(k)}`)
    .map(url => `<li><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></li>`)
    .join('');

  try {
    await transport.sendMail({
      from, replyTo,
      to:      admins.join(', '),
      subject: `New customer info submission – ${contact_name || contact_email || 'Unknown'}`,
      text: [
        `New customer info submission received.`,
        '',
        `Customer:     ${contact_name || '—'}`,
        `Email:        ${contact_email || '—'}`,
        corrected_email  ? `Corrected email:  ${corrected_email}`  : '',
        corrected_mobile ? `Corrected mobile: ${corrected_mobile}` : '',
        '',
        `Address:      ${address}`,
        `Rooms:        ${roomLabel}`,
        '',
        `Notes:`,
        room_notes || '—',
        '',
        `Photos: ${(submission.photo_keys || []).length} uploaded`,
      ].filter(l => l !== undefined && l !== false).join('\n'),
      html: `
        <p><strong>New customer info submission received.</strong></p>
        <table cellpadding="4" cellspacing="0">
          <tr><td><strong>Customer</strong></td><td>${escapeHtml(contact_name || '—')}</td></tr>
          <tr><td><strong>Email</strong></td><td>${escapeHtml(contact_email || '—')}</td></tr>
          ${corrected_email  ? `<tr><td><strong>Corrected email</strong></td><td>${escapeHtml(corrected_email)}</td></tr>`  : ''}
          ${corrected_mobile ? `<tr><td><strong>Corrected mobile</strong></td><td>${escapeHtml(corrected_mobile)}</td></tr>` : ''}
          <tr><td><strong>Address</strong></td><td>${escapeHtml(address)}</td></tr>
          <tr><td><strong>Rooms</strong></td><td>${escapeHtml(roomLabel)}</td></tr>
        </table>
        ${room_notes ? `<p><strong>Notes:</strong></p><p style="white-space:pre-wrap">${escapeHtml(room_notes)}</p>` : ''}
        ${photoRows ? `<p><strong>Photos:</strong></p><ul>${photoRows}</ul>` : '<p>No photos uploaded.</p>'}
      `,
    });
    console.log(`[customer-info] Admin notification sent for contact ${contact_email}`);
  } catch (err) {
    console.error('[customer-info] Failed to send admin notification email:', err.message);
  }
}

async function sendCustomerThankYouEmail(contactEmail, contactName) {
  const transport = createMailTransport();
  if (!transport) {
    console.warn('[customer-info] SMTP not configured — skipping thank-you email.');
    return;
  }
  const from    = buildFromHeader();
  const replyTo = buildReplyTo();
  const firstName = contactName ? contactName.split(' ')[0] : '';
  try {
    await transport.sendMail({
      from, replyTo,
      to:      contactEmail,
      subject: 'Thanks for sharing!',
      text: [
        `Hi${firstName ? ' ' + firstName : ''},`,
        '',
        'Thank you for the extra info about your home, we will be in touch shortly.',
        '',
        'Warm regards,',
        'The Measure Once team',
      ].join('\n'),
      html: `
        <p>Hi${firstName ? ' ' + firstName : ''},</p>
        <p>Thank you for the extra info about your home, we will be in touch shortly.</p>
        <p>Warm regards,<br>The Measure Once team</p>
      `,
    });
    console.log(`[customer-info] Thank-you email sent to ${contactEmail}`);
  } catch (err) {
    console.error('[customer-info] Failed to send thank-you email:', err.message);
  }
}

// ── HubSpot helpers ───────────────────────────────────────────────────────────
async function fetchContactFromHubSpot(contactId) {
  const url = `${hsBase()}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`;
  const r = await axios.get(url, {
    headers: hsHeaders(),
    params: { properties: 'email,phone,mobilephone,firstname,lastname' },
  });
  return r.data;
}

async function updateHubSpotLeadStatus(contactId, status) {
  const url = `${hsBase()}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`;
  await axios.patch(url, { properties: { hs_lead_status: status } }, { headers: hsHeaders() });
}

async function ensureSubstatusExists(substatusKey, label, parentStatusKey) {
  // Check if sub-status exists in the local DB — schema: status_key + substatus_key are the unique pair
  const exists = await pool.query(
    `SELECT id FROM lead_substatuses WHERE status_key = $1 AND substatus_key = $2 LIMIT 1`,
    [parentStatusKey, substatusKey]
  );
  if (exists.rows.length) return exists.rows[0].id;
  // Insert, ignoring a race-condition duplicate
  const ins = await pool.query(
    `INSERT INTO lead_substatuses (status_key, substatus_key, label, action_label, sort_order)
     VALUES ($1, $2, $3, $4, 0)
     ON CONFLICT (status_key, substatus_key) DO UPDATE SET label = EXCLUDED.label
     RETURNING id`,
    [parentStatusKey, substatusKey, label, label]
  );
  return ins.rows[0].id;
}

async function updateHubSpotSubstatus(contactId, substatusKey) {
  const url = `${hsBase()}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`;
  await axios.patch(url, { properties: { hw_lead_substatus: substatusKey } }, { headers: hsHeaders() });
}

// ── Photo upload (multer → object storage) ───────────────────────────────────
const ALLOWED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const MAX_PHOTO_BYTES = 15 * 1024 * 1024; // 15 MB per file

const _photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: 20 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype.toLowerCase())) cb(null, true);
    else cb(new Error('Only JPEG, PNG, and WebP images are allowed.'));
  },
});

async function uploadPhotoBufferToStorage(buffer, mimeType) {
  const { Client } = require('@replit/object-storage');
  const client = new Client();
  const extMap = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  const ext = extMap[mimeType.toLowerCase()] || 'jpg';
  const id  = crypto.randomBytes(18).toString('base64url');
  const name = `customer-info-photos/${id}.${ext}`;
  const res = await client.uploadFromBytes(name, buffer, { compress: false });
  if (res && res.ok === false) {
    throw new Error('Object storage upload failed: ' + (res.error?.message || 'unknown'));
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

// ── Routes ────────────────────────────────────────────────────────────────────

// Authenticated: send invite link to customer
// POST /api/card-actions/upload-photos-and-info
router.post('/api/card-actions/upload-photos-and-info',
  isAuthenticated,
  requirePrivilege('member'),
  async (req, res) => {
    const { contactId } = req.body;
    if (!contactId || typeof contactId !== 'string' || !/^\d+$/.test(String(contactId).trim())) {
      return res.status(400).json({ error: 'contactId is required.' });
    }
    const cid = String(contactId).trim();

    // Fetch contact from HubSpot
    let contact;
    try {
      contact = await fetchContactFromHubSpot(cid);
    } catch (err) {
      console.error('[customer-info] Failed to fetch contact from HubSpot:', err.message);
      return res.status(502).json({ error: 'Could not fetch contact from HubSpot.' });
    }

    const props = contact.properties || {};
    const email = (props.email || '').trim();
    if (!email) {
      return res.status(400).json({ error: 'Contact has no email address in HubSpot.' });
    }
    const phone   = (props.mobilephone || props.phone || '').trim();
    const firstName = (props.firstname || '').trim();
    const lastName  = (props.lastname  || '').trim();
    const name = [firstName, lastName].filter(Boolean).join(' ') || email;

    // Generate token
    const rawToken  = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + LINK_TTL_DAYS * 24 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO customer_info_submissions
         (contact_id, contact_name, contact_email, token_hash, expires_at,
          masked_email, masked_phone)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [cid, name, email, tokenHash, expiresAt.toISOString(),
       maskEmail(email), maskPhone(phone)]
    );

    const formLink = `${appBaseUrl()}/customer-info/${encodeURIComponent(rawToken)}`;
    await sendCustomerInviteEmail(email, maskEmail(email), formLink);

    res.status(201).json({ ok: true });
  }
);

// Public: get form data for a token
// GET /api/customer-info/:token
router.get('/api/customer-info/:token', async (req, res) => {
  const row = await lookupToken(req.params.token);
  if (!row) {
    return res.status(404).json({ error: 'Link not found.' });
  }
  if (new Date(row.expires_at) < new Date()) {
    return res.status(410).json({ error: 'This link has expired. Please contact us for a new one.', status: 'expired' });
  }
  if (row.submitted_at) {
    return res.status(410).json({ error: 'You have already submitted this form. Thank you!', status: 'submitted' });
  }
  res.json({
    maskedEmail:  row.masked_email,
    maskedPhone:  row.masked_phone,
    contactName:  row.contact_name,
  });
});

// Public: submit the form
// POST /api/customer-info/:token
router.post('/api/customer-info/:token', express.json({ limit: '1mb' }), async (req, res) => {
  const row = await lookupToken(req.params.token);
  if (!row) {
    return res.status(404).json({ error: 'Link not found.' });
  }
  if (new Date(row.expires_at) < new Date()) {
    return res.status(410).json({ error: 'This link has expired.', status: 'expired' });
  }
  if (row.submitted_at) {
    return res.status(410).json({ error: 'Already submitted.', status: 'submitted' });
  }

  const {
    correctedEmail, correctedMobile,
    addressLine1, city, postcode,
    roomCount, roomNotes,
    photoKeys,
  } = req.body;

  // Validate
  if (!['1', '2', '3+'].includes(roomCount)) {
    return res.status(400).json({ error: 'roomCount must be 1, 2, or 3+.' });
  }
  if (!addressLine1 || typeof addressLine1 !== 'string' || !addressLine1.trim()) {
    return res.status(400).json({ error: 'First line of address is required.' });
  }
  if (!city || typeof city !== 'string' || !city.trim()) {
    return res.status(400).json({ error: 'City is required.' });
  }
  if (!postcode || typeof postcode !== 'string' || !postcode.trim()) {
    return res.status(400).json({ error: 'Postcode is required.' });
  }
  const rawKeys = Array.isArray(photoKeys) ? photoKeys : [];
  const badKey = rawKeys.find(k => typeof k !== 'string' || !k.startsWith('obj:ci_') || k.length <= 'obj:ci_'.length);
  if (badKey !== undefined) {
    return res.status(400).json({ error: 'Invalid photo key: all keys must start with obj:ci_.' });
  }
  const keys = rawKeys;

  // Mark submitted
  await pool.query(
    `UPDATE customer_info_submissions SET
       submitted_at     = NOW(),
       corrected_email  = $1,
       corrected_mobile = $2,
       address_line1    = $3,
       city             = $4,
       postcode         = $5,
       room_count       = $6,
       room_notes       = $7,
       photo_keys       = $8::jsonb
     WHERE id = $9`,
    [
      correctedEmail  || null,
      correctedMobile || null,
      addressLine1.trim(),
      city.trim(),
      postcode.trim(),
      roomCount,
      roomNotes || null,
      JSON.stringify(keys),
      row.id,
    ]
  );

  // Fetch fresh row for emails
  const freshR = await pool.query(`SELECT * FROM customer_info_submissions WHERE id = $1`, [row.id]);
  const fresh  = freshR.rows[0];

  // Update HubSpot lead status (non-fatal)
  try {
    if (process.env.HUBSPOT_ACCESS_TOKEN) {
      await updateHubSpotLeadStatus(row.contact_id, 'AWAITING_PHOTOS');
      // Ensure sub-status exists locally, then patch HubSpot.
      // HubSpot hw_lead_substatus values are namespaced: STATUS_KEY__SUBSTATUS_KEY
      const awphId = await ensureSubstatusExists('AWPH_RECEIVED', 'Photos Received', 'AWAITING_PHOTOS');
      // Set action label to "Review Photos" so the review handler is naturally surfaced
      await pool.query(
        `UPDATE lead_substatuses SET action_label = 'Review Photos' WHERE id = $1 AND (action_label IS NULL OR action_label = '' OR action_label = 'Photos Received')`,
        [awphId]
      );
      await updateHubSpotSubstatus(row.contact_id, 'AWAITING_PHOTOS__AWPH_RECEIVED');
    }
  } catch (err) {
    console.error('[customer-info] HubSpot update failed (non-fatal):', err.message);
  }

  // Bust the project-contacts cache so the board refetch gets fresh HubSpot data
  // (the cache has a 60 s TTL; without this the refetch would return the
  // pre-submission snapshot and the badge would not appear).
  if (typeof _invalidateProjectContactsCache === 'function') {
    _invalidateProjectContactsCache();
  }

  // Notify all connected dashboard tabs so the "Photos received" badge appears
  // on the projects board without a page refresh.
  pushSseEvent({ type: 'customer_info_submitted', contactId: row.contact_id });

  // Send emails (non-fatal)
  try { await sendAdminNotificationEmail(fresh); } catch (e) {
    console.error('[customer-info] Admin notification failed:', e.message);
  }
  try {
    const emailTo = fresh.corrected_email || fresh.contact_email;
    if (emailTo) await sendCustomerThankYouEmail(emailTo, fresh.contact_name);
  } catch (e) {
    console.error('[customer-info] Thank-you email failed:', e.message);
  }

  res.json({ ok: true });
});

// Public: upload photos (before form submission)
// POST /api/customer-info/:token/photos
router.post('/api/customer-info/:token/photos',
  async (req, res, next) => {
    // Validate token before accepting upload bytes
    const row = await lookupToken(req.params.token);
    if (!row) return res.status(404).json({ error: 'Link not found.' });
    if (new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'Link expired.' });
    if (row.submitted_at) return res.status(410).json({ error: 'Already submitted.' });
    req._cisRow = row;
    next();
  },
  _photoUpload.array('photos', 20),
  async (req, res) => {
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ error: 'No files uploaded.' });
    }
    const keys = [];
    for (const file of files) {
      try {
        const key = await uploadPhotoBufferToStorage(file.buffer, file.mimetype);
        keys.push(key);
      } catch (err) {
        console.error('[customer-info] Photo upload failed:', err.message);
        return res.status(500).json({ error: 'Photo upload failed: ' + err.message });
      }
    }
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
    const { Client } = require('@replit/object-storage');
    const client = new Client();
    const id   = key.slice('obj:ci_'.length);
    const name = `customer-info-photos/${id}`;
    const dl   = await client.downloadAsBytes(name);
    if (!dl || dl.ok === false) {
      return res.status(404).json({ error: 'Image not found.' });
    }
    const buf = Array.isArray(dl.value) ? dl.value[0] : dl.value;
    const ext = id.split('.').pop() || 'jpg';
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    res.set('Content-Type', mime);
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(buf);
  } catch (err) {
    console.error('[customer-info] Failed to serve photo:', err.message);
    res.status(500).json({ error: 'Failed to serve image.' });
  }
});

// Authenticated: resend a fresh invite link for a contact
// POST /api/customer-info/by-contact/:contactId/resend
router.post('/api/customer-info/by-contact/:contactId/resend',
  isAuthenticated,
  requirePrivilege('member'),
  async (req, res) => {
    const cid = String(req.params.contactId || '').trim();
    if (!cid || !/^\d+$/.test(cid)) {
      return res.status(400).json({ error: 'Invalid contactId.' });
    }

    // Fetch contact from HubSpot
    let contact;
    try {
      contact = await fetchContactFromHubSpot(cid);
    } catch (err) {
      console.error('[customer-info] Failed to fetch contact from HubSpot:', err.message);
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

    // Generate a fresh token
    const rawToken  = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + LINK_TTL_DAYS * 24 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO customer_info_submissions
         (contact_id, contact_name, contact_email, token_hash, expires_at,
          masked_email, masked_phone)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [cid, name, email, tokenHash, expiresAt.toISOString(),
       maskEmail(email), maskPhone(phone)]
    );

    const formLink = `${appBaseUrl()}/customer-info/${encodeURIComponent(rawToken)}`;
    await sendCustomerInviteEmail(email, maskEmail(email), formLink);

    console.log(`[customer-info] Resent invite link for contact ${cid}`);
    res.json({ ok: true });
  }
);

// Authenticated: list all submissions for a contact (dashboard viewer)
// GET /api/customer-info/by-contact/:contactId
router.get('/api/customer-info/by-contact/:contactId', isAuthenticated, async (req, res) => {
  const cid = String(req.params.contactId || '').trim();
  if (!cid || !/^\d+$/.test(cid)) {
    return res.status(400).json({ error: 'Invalid contactId.' });
  }
  const r = await pool.query(
    `SELECT id, contact_name, contact_email, created_at, expires_at, submitted_at,
            corrected_email, corrected_mobile, address_line1, city, postcode,
            room_count, room_notes, photo_keys, masked_email
     FROM customer_info_submissions
     WHERE contact_id = $1
     ORDER BY created_at DESC`,
    [cid]
  );
  const rows = r.rows.map(row => ({
    ...row,
    photoUrls: (row.photo_keys || []).map(k => signCustomerPhotoUrl(k)),
  }));
  res.json(rows);
});

module.exports = {
  router,
  ensureCustomerInfoSubmissionsTable,
  signCustomerPhotoUrl,
  setSharedSseClients,
  setProjectContactsCacheInvalidator,
};
