// design-visits.js — start_design_visit card action handler
// DB tables, admin catalogue routes, design visit CRUD, public sign-off routes.

const express   = require('express');
const crypto    = require('crypto');
const axios     = require('axios').create({ timeout: 12000 });
const { Pool }  = require('pg');
const nodemailer = require('nodemailer');
const path      = require('path');
const fs        = require('fs');
const multer    = require('multer');
const { isAuthenticated, requireAdmin, requirePrivilege } = require('./auth');

const HANDLES_UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'handles');
if (!fs.existsSync(HANDLES_UPLOAD_DIR)) fs.mkdirSync(HANDLES_UPLOAD_DIR, { recursive: true });

function _deleteLocalHandleImage(imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string') return;
  const m = imageUrl.match(/^\/uploads\/handles\/([^/\\]+)$/);
  if (!m) return;
  const filename = m[1];
  if (filename === '.' || filename === '..') return;
  const filePath = path.join(HANDLES_UPLOAD_DIR, filename);
  const resolved = path.resolve(filePath);
  if (path.dirname(resolved) !== path.resolve(HANDLES_UPLOAD_DIR)) return;
  fs.unlink(resolved, err => {
    if (err && err.code !== 'ENOENT') {
      console.warn('[design-visits] Failed to delete handle image', resolved, err.message);
    }
  });
}

const _handlesStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, HANDLES_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const id  = parseInt(req.params.id, 10);
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg';
    cb(null, `${id}-${Date.now()}${ext}`);
  },
});
const _handlesUpload = multer({
  storage: _handlesStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\//i.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

const pool   = new Pool({ connectionString: process.env.DATABASE_URL });
const router = express.Router();

// ── Utility helpers (mirrors auth.js private helpers) ─────────────────────────
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
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: parseInt(process.env.SMTP_PORT || '587', 10) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}
function adminEmails() {
  return (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
}

// ── QuickBooks helpers (reads from qb_tokens table) ───────────────────────────
const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
function qbBase() {
  return process.env.QB_ENVIRONMENT === 'sandbox'
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';
}
async function getQbTokens() {
  try {
    const r = await pool.query('SELECT * FROM qb_tokens ORDER BY id DESC LIMIT 1');
    const t = r.rows[0];
    if (!t) return null;
    if (Date.now() < Number(t.expires_at)) return t;
    // refresh
    const creds = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
    const resp = await axios.post(
      QB_TOKEN_URL,
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token }).toString(),
      { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } }
    );
    const expires_at = Date.now() + ((Number(resp.data.expires_in) || 3600) * 1000) - 60000;
    await pool.query('DELETE FROM qb_tokens');
    await pool.query(
      'INSERT INTO qb_tokens (access_token, refresh_token, realm_id, expires_at) VALUES ($1,$2,$3,$4)',
      [resp.data.access_token, resp.data.refresh_token, t.realm_id, expires_at]
    );
    return { ...t, access_token: resp.data.access_token, expires_at };
  } catch {
    return null;
  }
}

// ── Per-user rate limiter for design visit create/submit ──────────────────────
const DV_RATE_WINDOW_MS = 10 * 60 * 1000;
const DV_RATE_LIMIT     = 20;
const _dvRateMap = new Map();
function checkDvRateLimit(userId) {
  const now = Date.now();
  const cutoff = now - DV_RATE_WINDOW_MS;
  const ts = (_dvRateMap.get(userId) || []).filter(t => t > cutoff);
  if (ts.length >= DV_RATE_LIMIT) return false;
  ts.push(now);
  _dvRateMap.set(userId, ts);
  return true;
}

// ── DB schema ─────────────────────────────────────────────────────────────────
async function ensureDesignVisitTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS terms_conditions_versions (
      id             SERIAL PRIMARY KEY,
      version_number INT NOT NULL,
      terms_text     TEXT NOT NULL,
      created_by     TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS tcv_version_number_idx ON terms_conditions_versions (version_number)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS design_visit_handles (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      image_url   TEXT,
      sort_order  INT  NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE design_visit_handles ADD COLUMN IF NOT EXISTS style TEXT`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS design_visit_furniture_ranges (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      sort_order  INT  NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS design_visit_door_styles (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      image_url   TEXT,
      sort_order  INT  NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS design_visits (
      id                   SERIAL PRIMARY KEY,
      contact_id           TEXT NOT NULL,
      contact_name         TEXT,
      contact_email        TEXT,
      created_by           TEXT NOT NULL,
      handle_id            INT  REFERENCES design_visit_handles(id) ON DELETE SET NULL,
      furniture_range_id   INT  REFERENCES design_visit_furniture_ranges(id) ON DELETE SET NULL,
      visit_date           TIMESTAMPTZ,
      duration_min         INT  NOT NULL DEFAULT 90,
      location             TEXT,
      notes                TEXT,
      terms_accepted       BOOLEAN NOT NULL DEFAULT FALSE,
      status               TEXT NOT NULL DEFAULT 'draft',
      qb_estimate_id       TEXT,
      qb_estimate_doc_num  TEXT,
      signoff_token_hash   TEXT,
      signoff_expires_at   TIMESTAMPTZ,
      signed_off_at        TIMESTAMPTZ,
      revision_note        TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS design_visits_contact_id_idx ON design_visits (contact_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS design_visits_status_idx ON design_visits (status)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS design_visit_rooms (
      id               SERIAL PRIMARY KEY,
      design_visit_id  INT NOT NULL REFERENCES design_visits(id) ON DELETE CASCADE,
      room_name        TEXT NOT NULL,
      door_style_id    INT REFERENCES design_visit_door_styles(id) ON DELETE SET NULL,
      width_mm         INT,
      height_mm        INT,
      depth_mm         INT,
      unit_count       INT NOT NULL DEFAULT 1,
      unit_price_pence INT NOT NULL DEFAULT 0,
      notes            TEXT,
      sort_order       INT NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS design_visit_rooms_visit_id_idx ON design_visit_rooms (design_visit_id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS design_visit_room_images (
      id          SERIAL PRIMARY KEY,
      room_id     INT  NOT NULL REFERENCES design_visit_rooms(id) ON DELETE CASCADE,
      storage_key TEXT NOT NULL,
      mime_type   TEXT,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS dvri_room_id_idx ON design_visit_room_images (room_id)`);

  // Add terms_condition_version_id FK column if not present (idempotent migration)
  await pool.query(`
    ALTER TABLE design_visits
      ADD COLUMN IF NOT EXISTS terms_condition_version_id INT
        REFERENCES terms_conditions_versions(id) ON DELETE SET NULL
  `);

  // Seed: if versions table is empty but admin_settings has terms text, insert version 1
  try {
    const countR = await pool.query(`SELECT COUNT(*) FROM terms_conditions_versions`);
    if (parseInt(countR.rows[0].count, 10) === 0) {
      const settingsR = await pool.query(`SELECT value FROM admin_settings WHERE key='design_visit_terms'`);
      const existingText = settingsR.rows[0]?.value?.text || '';
      if (existingText.trim()) {
        await pool.query(
          `INSERT INTO terms_conditions_versions (version_number, terms_text, created_by)
           VALUES (1, $1, 'system')`,
          [existingText]
        );
        console.log('[design-visits] Seeded terms version 1 from existing admin_settings.');
      }
    }
  } catch (seedErr) {
    console.warn('[design-visits] Terms version seed failed (non-fatal):', seedErr.message);
  }
}

// ── BroadcastChannel event helper ─────────────────────────────────────────────
// For server-side we can't use real BroadcastChannel; we signal via SSE or
// simply rely on the admin UI's manual channel post. The server routes set a
// custom response header that triggers the client to fire the channel.
// (The client-side admin.html already does this after each CRUD operation.)

// ── Admin: ensure admin_settings table exists (created in auth.js but guard) ─
async function ensureAdminSettings() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_settings (
      key        VARCHAR PRIMARY KEY,
      value      JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

// ── Helper: load visit with rooms ─────────────────────────────────────────────
async function loadVisitWithRooms(id) {
  const vr = await pool.query(`
    SELECT dv.*,
           dvh.name   AS handle_name,
           dvfr.name  AS furniture_range_name,
           tcv.version_number AS terms_version_number
    FROM design_visits dv
    LEFT JOIN design_visit_handles          dvh  ON dvh.id  = dv.handle_id
    LEFT JOIN design_visit_furniture_ranges dvfr ON dvfr.id = dv.furniture_range_id
    LEFT JOIN terms_conditions_versions     tcv  ON tcv.id  = dv.terms_condition_version_id
    WHERE dv.id = $1`, [id]);
  if (!vr.rows.length) return null;
  const visit = vr.rows[0];
  const rooms = await pool.query(`
    SELECT dvr.*, dvds.name AS door_style_name
    FROM design_visit_rooms dvr
    LEFT JOIN design_visit_door_styles dvds ON dvds.id = dvr.door_style_id
    WHERE dvr.design_visit_id = $1
    ORDER BY dvr.sort_order ASC, dvr.id ASC`, [id]);
  const images = await pool.query(`
    SELECT dvri.room_id, dvri.storage_key, dvri.mime_type
    FROM design_visit_room_images dvri
    JOIN design_visit_rooms dvr ON dvr.id = dvri.room_id
    WHERE dvr.design_visit_id = $1
    ORDER BY dvri.id ASC`, [id]);
  const imagesByRoom = {};
  for (const img of images.rows) {
    if (!imagesByRoom[img.room_id]) imagesByRoom[img.room_id] = [];
    imagesByRoom[img.room_id].push({ storageKey: img.storage_key, mimeType: img.mime_type });
  }
  visit.rooms = rooms.rows.map(r => ({
    ...r,
    images: imagesByRoom[r.id] || [],
  }));
  return visit;
}

// ── Format currency helper ────────────────────────────────────────────────────
function penceToGbp(pence) {
  return (pence / 100).toFixed(2);
}

// ── Side-effect chain: submit visit ──────────────────────────────────────────
async function runSubmitSideEffects(visitId, handlerConfig, submitterUser) {
  const visit = await loadVisitWithRooms(visitId);
  if (!visit) throw new Error('Visit not found');

  // 1. Update status to submitted
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await pool.query(`
    UPDATE design_visits
    SET status = 'submitted', signoff_token_hash = $1, signoff_expires_at = $2, updated_at = NOW()
    WHERE id = $3`, [tokenHash, expiresAt.toISOString(), visitId]);

  // 2. HubSpot lead status update (non-fatal)
  const submittedLeadStatus = handlerConfig?.submittedLeadStatus;
  if (submittedLeadStatus && process.env.HUBSPOT_ACCESS_TOKEN && visit.contact_id) {
    try {
      await axios.patch(
        `https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(visit.contact_id)}`,
        { properties: { hs_lead_status: submittedLeadStatus } },
        { headers: { Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
      );
    } catch (e) {
      console.warn('[design-visits] HubSpot lead status update failed:', e.message);
    }
  }

  // 3. HubSpot note (non-fatal)
  if (process.env.HUBSPOT_ACCESS_TOKEN && visit.contact_id) {
    try {
      const roomLines = (visit.rooms || []).map(r =>
        `  • ${r.room_name}: ${r.unit_count} unit(s) @ £${penceToGbp(r.unit_price_pence)} each`
      ).join('\n');
      const noteBody = [
        `Design visit submitted`,
        `Designer: ${submitterUser?.email || 'unknown'}`,
        visit.handle_name         ? `Handle: ${visit.handle_name}` : null,
        visit.furniture_range_name ? `Furniture range: ${visit.furniture_range_name}` : null,
        visit.visit_date          ? `Visit date: ${new Date(visit.visit_date).toLocaleString()}` : null,
        roomLines ? `Rooms:\n${roomLines}` : null,
      ].filter(Boolean).join('\n');
      await axios.post(
        'https://api.hubapi.com/crm/v3/objects/notes',
        {
          properties: {
            hs_note_body:       noteBody,
            hs_timestamp:       Date.now().toString(),
            hubspot_owner_id:   '',
          },
          associations: [{
            to: { id: visit.contact_id },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }],
          }],
        },
        { headers: { Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
      );
    } catch (e) {
      console.warn('[design-visits] HubSpot note creation failed:', e.message);
    }
  }

  // 4. QuickBooks Estimate (non-fatal)
  try {
    const qbt = await getQbTokens();
    if (qbt && visit.rooms && visit.rooms.length) {
      const lines = visit.rooms.map(r => ({
        DetailType: 'SalesItemLineDetail',
        Amount:     parseFloat(penceToGbp(r.unit_price_pence * r.unit_count)),
        Description: [
          r.room_name,
          r.door_style_name ? `— ${r.door_style_name}` : null,
          r.width_mm && r.height_mm ? `(${r.width_mm}mm × ${r.height_mm}mm` + (r.depth_mm ? ` × ${r.depth_mm}mm)` : ')') : null,
          `${r.unit_count} unit(s)`,
        ].filter(Boolean).join(' '),
        SalesItemLineDetail: {
          ItemRef: { value: '1', name: 'Design & Fit' },
          Qty: r.unit_count,
          UnitPrice: parseFloat(penceToGbp(r.unit_price_pence)),
        },
      }));
      const expDate = new Date(visit.visit_date || Date.now());
      expDate.setDate(expDate.getDate() + 30);
      const memo = [
        `Design visit — ${visit.contact_name || ''}`,
        visit.handle_name          ? `Handle: ${visit.handle_name}` : null,
        visit.furniture_range_name ? `Furniture range: ${visit.furniture_range_name}` : null,
      ].filter(Boolean).join('\n');
      const qbResp = await axios.post(
        `${qbBase()}/v3/company/${qbt.realm_id}/estimate`,
        {
          TxnDate:       new Date().toISOString().slice(0, 10),
          CustomerRef:   { value: visit.contact_id },
          BillEmail:     visit.contact_email ? { Address: visit.contact_email } : undefined,
          CustomerMemo:  { value: memo },
          ExpirationDate: expDate.toISOString().slice(0, 10),
          Line: lines,
        },
        {
          headers: { Authorization: `Bearer ${qbt.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          params: { minorversion: 65 },
        }
      );
      const est = qbResp.data?.Estimate;
      if (est?.Id) {
        await pool.query(
          `UPDATE design_visits SET qb_estimate_id = $1, qb_estimate_doc_num = $2, updated_at = NOW() WHERE id = $3`,
          [est.Id, est.DocNumber || null, visitId]
        );
      }
    }
  } catch (e) {
    console.warn('[design-visits] QuickBooks estimate creation failed:', e.message);
  }

  // 5. Customer confirmation email (non-fatal)
  const signOffUrl = `${appBaseUrl()}/design-visit/sign-off?token=${rawToken}`;
  try {
    const transport = createMailTransport();
    if (transport && visit.contact_email) {
      const from    = buildFromHeader();
      const replyTo = buildReplyTo();
      const terms   = handlerConfig?.termsAndConditions || '';
      const firstName = (visit.contact_name || '').split(' ')[0] || 'there';
      const grandTotal = (visit.rooms || []).reduce((s, r) => s + r.unit_price_pence * r.unit_count, 0);
      const roomRows = (visit.rooms || []).map(r => {
        const total = r.unit_price_pence * r.unit_count;
        return `
          <tr>
            <td style="padding:8px 12px;border-top:1px solid #e5e7eb;">${_esc(r.room_name)}</td>
            <td style="padding:8px 12px;border-top:1px solid #e5e7eb;">${_esc(r.door_style_name || '—')}</td>
            <td style="padding:8px 12px;border-top:1px solid #e5e7eb;text-align:right;">£${penceToGbp(total)}</td>
          </tr>`;
      }).join('');
      const roomRowsText = (visit.rooms || []).map(r => {
        const total = r.unit_price_pence * r.unit_count;
        return `  ${r.room_name} (${r.door_style_name || '—'}): £${penceToGbp(total)}`;
      }).join('\n');
      await transport.sendMail({
        from, replyTo,
        to: visit.contact_email,
        subject: `Your design visit — ${visit.contact_name || ''}`,
        text: [
          `Hi ${firstName},`,
          '',
          'Thank you for your time today. Here\'s a summary of the design options we discussed.',
          '',
          '--- Room Breakdown ---',
          roomRowsText,
          '',
          `Estimate total: £${penceToGbp(grandTotal)}`,
          '',
          'See Your Design & Sign Off:',
          signOffUrl,
          '',
          'This link is personal to you and expires in 7 days.',
          'If you have questions, reply to this email.',
          terms ? `\n--- Terms & Conditions ---\n${terms}` : '',
        ].join('\n'),
        html: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;color:#1f2937;max-width:600px;margin:0 auto;padding:24px;">
  <h1 style="font-size:1.4rem;margin-bottom:4px;">Your design visit summary</h1>
  <p style="color:#6b7280;margin-top:0;">Hi ${_esc(firstName)},</p>
  <p>Thank you for your time today. Here's a summary of the design options we discussed.</p>
  <table style="width:100%;border-collapse:collapse;margin:20px 0;">
    <thead>
      <tr style="background:#f3f4f6;">
        <th style="text-align:left;padding:8px 12px;font-size:.85rem;">Room</th>
        <th style="text-align:left;padding:8px 12px;font-size:.85rem;">Style</th>
        <th style="text-align:right;padding:8px 12px;font-size:.85rem;">Total</th>
      </tr>
    </thead>
    <tbody>${roomRows}</tbody>
    <tfoot>
      <tr>
        <td colspan="2" style="padding:8px 12px;font-weight:600;">Estimate total</td>
        <td style="padding:8px 12px;font-weight:600;text-align:right;">£${penceToGbp(grandTotal)}</td>
      </tr>
    </tfoot>
  </table>
  <div style="text-align:center;margin:28px 0;">
    <a href="${signOffUrl}"
       style="display:inline-block;background:#8B2BFF;color:#fff;padding:14px 32px;
              border-radius:8px;text-decoration:none;font-weight:600;font-size:1rem;">
      See Your Design &amp; Sign Off
    </a>
  </div>
  <p style="font-size:.82rem;color:#6b7280;">
    This link is personal to you and expires in 7 days.
    If you have questions, reply to this email.
  </p>
  ${terms ? `<details style="margin-top:24px;font-size:.78rem;color:#6b7280;">
    <summary style="cursor:pointer;font-weight:600;">Terms &amp; Conditions</summary>
    <div style="margin-top:8px;white-space:pre-line;">${_esc(terms)}</div>
  </details>` : ''}
</body>
</html>`,
      });
    }
  } catch (e) {
    console.warn('[design-visits] Customer email send failed:', e.message);
  }

  // 6. Team notification email (non-fatal)
  try {
    const transport = createMailTransport();
    const admins = adminEmails();
    if (transport && admins.length) {
      const from    = buildFromHeader();
      const replyTo = buildReplyTo();
      const roomRowsTeam = (visit.rooms || []).map(r => `
        <tr>
          <td style="padding:6px 10px;border-top:1px solid #e5e7eb;">${_esc(r.room_name)}</td>
          <td style="padding:6px 10px;border-top:1px solid #e5e7eb;">${_esc(r.door_style_name || '—')}</td>
          <td style="padding:6px 10px;border-top:1px solid #e5e7eb;">${r.unit_count} unit(s)</td>
        </tr>`).join('');
      const dashboardUrl = `${appBaseUrl()}/customers/${visit.contact_id}`;
      await transport.sendMail({
        from, replyTo,
        to: admins.join(', '),
        subject: `Design visit submitted — ${visit.contact_name || visit.contact_id}`,
        text: [
          `Design visit submitted by ${submitterUser?.email || 'unknown'}`,
          '',
          `Contact: ${visit.contact_name || '—'} (${visit.contact_id})`,
          visit.visit_date ? `Visit date: ${new Date(visit.visit_date).toLocaleString()}` : '',
          visit.location   ? `Location: ${visit.location}` : '',
          visit.handle_name          ? `Handle: ${visit.handle_name}` : '',
          visit.furniture_range_name ? `Furniture range: ${visit.furniture_range_name}` : '',
          '',
          'Rooms:',
          ...(visit.rooms || []).map(r => `  • ${r.room_name} (${r.door_style_name || '—'}): ${r.unit_count} unit(s)`),
          '',
          `Dashboard: ${dashboardUrl}`,
        ].filter(s => s !== null).join('\n'),
        html: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;color:#1f2937;max-width:600px;margin:0 auto;padding:24px;">
  <h2 style="font-size:1.2rem;">Design visit submitted</h2>
  <p>Submitted by <strong>${_esc(submitterUser?.email || 'unknown')}</strong></p>
  <table cellpadding="0" cellspacing="0" style="margin:12px 0;font-size:.9rem;">
    <tr><td style="padding:3px 14px 3px 0;font-weight:600;">Contact</td><td>${_esc(visit.contact_name || '—')} (${_esc(visit.contact_id)})</td></tr>
    ${visit.visit_date ? `<tr><td style="padding:3px 14px 3px 0;font-weight:600;">Visit date</td><td>${new Date(visit.visit_date).toLocaleString()}</td></tr>` : ''}
    ${visit.location   ? `<tr><td style="padding:3px 14px 3px 0;font-weight:600;">Location</td><td>${_esc(visit.location)}</td></tr>` : ''}
    ${visit.handle_name          ? `<tr><td style="padding:3px 14px 3px 0;font-weight:600;">Handle</td><td>${_esc(visit.handle_name)}</td></tr>` : ''}
    ${visit.furniture_range_name ? `<tr><td style="padding:3px 14px 3px 0;font-weight:600;">Furniture range</td><td>${_esc(visit.furniture_range_name)}</td></tr>` : ''}
  </table>
  <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:.88rem;">
    <thead>
      <tr style="background:#f3f4f6;">
        <th style="text-align:left;padding:6px 10px;">Room</th>
        <th style="text-align:left;padding:6px 10px;">Style</th>
        <th style="text-align:left;padding:6px 10px;">Units</th>
      </tr>
    </thead>
    <tbody>${roomRowsTeam}</tbody>
  </table>
  <p><a href="${dashboardUrl}">View in dashboard</a></p>
</body>
</html>`,
      });
    }
  } catch (e) {
    console.warn('[design-visits] Team notification email failed:', e.message);
  }

  return { rawToken, expiresAt };
}

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Admin: Handles CRUD ───────────────────────────────────────────────────────
router.get('/api/admin/design-visit-handles', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM design_visit_handles ORDER BY sort_order ASC, id ASC`);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const HANDLE_STYLE_VALUES = ['Cup', 'Bar', 'Knob', 'Pull', 'Finger Pull', 'Other'];

router.post('/api/admin/design-visit-handles', isAuthenticated, requireAdmin, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const description = req.body?.description ? String(req.body.description).slice(0, 500) : null;
  const image_url   = req.body?.image_url   ? String(req.body.image_url).slice(0, 500)  : null;
  const sort_order  = parseInt(req.body?.sort_order, 10) || 0;
  const styleRaw    = req.body?.style !== undefined && req.body?.style !== null ? String(req.body.style).trim() : '';
  if (!styleRaw) {
    return res.status(400).json({ error: 'style is required' });
  }
  if (!HANDLE_STYLE_VALUES.includes(styleRaw)) {
    return res.status(400).json({ error: `style must be one of: ${HANDLE_STYLE_VALUES.join(', ')}` });
  }
  const style = styleRaw;
  try {
    const r = await pool.query(
      `INSERT INTO design_visit_handles (name, description, image_url, sort_order, style)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, description, image_url, sort_order, style]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/api/admin/design-visit-handles/:id', isAuthenticated, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const name        = req.body?.name        !== undefined ? String(req.body.name).trim()               : undefined;
  const description = req.body?.description !== undefined ? String(req.body.description).slice(0, 500) : undefined;
  const image_url   = req.body?.image_url   !== undefined ? String(req.body.image_url).slice(0, 500)   : undefined;
  const sort_order  = req.body?.sort_order  !== undefined ? parseInt(req.body.sort_order, 10) || 0     : undefined;
  if (name !== undefined && !name) return res.status(400).json({ error: 'name cannot be empty' });
  let style = undefined;
  if (req.body?.style !== undefined) {
    const styleRaw = req.body.style === null || req.body.style === '' ? null : String(req.body.style).trim();
    if (styleRaw !== null && !HANDLE_STYLE_VALUES.includes(styleRaw)) {
      return res.status(400).json({ error: `style must be one of: ${HANDLE_STYLE_VALUES.join(', ')}` });
    }
    style = styleRaw;
  }
  const styleIsSet = style !== undefined;
  try {
    const r = await pool.query(
      `UPDATE design_visit_handles SET
        name        = COALESCE($1, name),
        description = COALESCE($2, description),
        image_url   = COALESCE($3, image_url),
        sort_order  = COALESCE($4, sort_order),
        style       = CASE WHEN $6 THEN $5 ELSE style END,
        updated_at  = NOW()
       WHERE id = $7 RETURNING *`,
      [name ?? null, description ?? null, image_url ?? null, sort_order ?? null, style ?? null, styleIsSet, id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/api/admin/design-visit-handles/:id', isAuthenticated, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const r = await pool.query(`DELETE FROM design_visit_handles WHERE id=$1 RETURNING id, image_url`, [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    _deleteLocalHandleImage(r.rows[0].image_url);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/admin/dv-handles/:id/image', isAuthenticated, requireAdmin,
  (req, res, next) => _handlesUpload.single('image')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  }),
  async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });
    const image_url = `/uploads/handles/${req.file.filename}`;
    try {
      const existing = await pool.query(
        `SELECT image_url FROM design_visit_handles WHERE id=$1`,
        [id]
      );
      if (!existing.rows.length) {
        fs.unlink(req.file.path, () => {});
        return res.status(404).json({ error: 'Handle not found' });
      }
      const oldImageUrl = existing.rows[0].image_url;
      const r = await pool.query(
        `UPDATE design_visit_handles SET image_url=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
        [image_url, id]
      );
      if (!r.rows.length) {
        fs.unlink(req.file.path, () => {});
        return res.status(404).json({ error: 'Handle not found' });
      }
      if (oldImageUrl && oldImageUrl !== image_url) {
        _deleteLocalHandleImage(oldImageUrl);
      }
      res.json({ image_url });
    } catch (e) {
      fs.unlink(req.file.path, () => {});
      res.status(500).json({ error: e.message });
    }
  }
);

// ── Admin: Furniture Ranges CRUD ──────────────────────────────────────────────
router.get('/api/admin/design-visit-furniture-ranges', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM design_visit_furniture_ranges ORDER BY sort_order ASC, id ASC`);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/admin/design-visit-furniture-ranges', isAuthenticated, requireAdmin, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const description = req.body?.description ? String(req.body.description).slice(0, 500) : null;
  const sort_order  = parseInt(req.body?.sort_order, 10) || 0;
  try {
    const r = await pool.query(
      `INSERT INTO design_visit_furniture_ranges (name, description, sort_order)
       VALUES ($1,$2,$3) RETURNING *`,
      [name, description, sort_order]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/api/admin/design-visit-furniture-ranges/:id', isAuthenticated, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const name        = req.body?.name        !== undefined ? String(req.body.name).trim()               : undefined;
  const description = req.body?.description !== undefined ? String(req.body.description).slice(0, 500) : undefined;
  const sort_order  = req.body?.sort_order  !== undefined ? parseInt(req.body.sort_order, 10) || 0     : undefined;
  if (name !== undefined && !name) return res.status(400).json({ error: 'name cannot be empty' });
  try {
    const r = await pool.query(
      `UPDATE design_visit_furniture_ranges SET
        name        = COALESCE($1, name),
        description = COALESCE($2, description),
        sort_order  = COALESCE($3, sort_order),
        updated_at  = NOW()
       WHERE id = $4 RETURNING *`,
      [name ?? null, description ?? null, sort_order ?? null, id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/api/admin/design-visit-furniture-ranges/:id', isAuthenticated, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const r = await pool.query(`DELETE FROM design_visit_furniture_ranges WHERE id=$1 RETURNING id`, [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: Door Styles CRUD ───────────────────────────────────────────────────
router.get('/api/admin/design-visit-door-styles', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM design_visit_door_styles ORDER BY sort_order ASC, id ASC`);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/admin/design-visit-door-styles', isAuthenticated, requireAdmin, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const image_url  = req.body?.image_url  ? String(req.body.image_url).slice(0, 500) : null;
  const sort_order = parseInt(req.body?.sort_order, 10) || 0;
  try {
    const r = await pool.query(
      `INSERT INTO design_visit_door_styles (name, image_url, sort_order)
       VALUES ($1,$2,$3) RETURNING *`,
      [name, image_url, sort_order]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/api/admin/design-visit-door-styles/:id', isAuthenticated, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const name       = req.body?.name       !== undefined ? String(req.body.name).trim()             : undefined;
  const image_url  = req.body?.image_url  !== undefined ? String(req.body.image_url).slice(0, 500) : undefined;
  const sort_order = req.body?.sort_order !== undefined ? parseInt(req.body.sort_order, 10) || 0   : undefined;
  if (name !== undefined && !name) return res.status(400).json({ error: 'name cannot be empty' });
  try {
    const r = await pool.query(
      `UPDATE design_visit_door_styles SET
        name       = COALESCE($1, name),
        image_url  = COALESCE($2, image_url),
        sort_order = COALESCE($3, sort_order),
        updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [name ?? null, image_url ?? null, sort_order ?? null, id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/api/admin/design-visit-door-styles/:id', isAuthenticated, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const r = await pool.query(`DELETE FROM design_visit_door_styles WHERE id=$1 RETURNING id`, [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Non-admin read of T&C text (any authenticated user — used by wizard) ─────
router.get('/api/design-visit-terms', isAuthenticated, async (req, res) => {
  try {
    // Return the latest published version (falls back to admin_settings for legacy installs)
    const vr = await pool.query(
      `SELECT id, version_number, terms_text FROM terms_conditions_versions ORDER BY version_number DESC LIMIT 1`
    );
    if (vr.rows.length) {
      return res.json({ terms: vr.rows[0].terms_text, versionNumber: vr.rows[0].version_number, versionId: vr.rows[0].id });
    }
    const r = await pool.query(`SELECT value FROM admin_settings WHERE key='design_visit_terms'`);
    res.json({ terms: r.rows[0]?.value?.text || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: T&C settings (legacy kept for backward compat) ────────────────────
router.get('/api/admin/settings/design-visit-terms', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(`SELECT value FROM admin_settings WHERE key='design_visit_terms'`);
    res.json({ terms: r.rows[0]?.value?.text || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/api/admin/settings/design-visit-terms', isAuthenticated, requireAdmin, async (req, res) => {
  const terms = String(req.body?.terms || '').slice(0, 4000);
  try {
    await pool.query(`
      INSERT INTO admin_settings (key, value, updated_at)
      VALUES ('design_visit_terms', $1::jsonb, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify({ text: terms })]
    );
    res.json({ success: true, terms });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: Terms & Conditions version history ─────────────────────────────────
router.get('/api/admin/terms-conditions/versions', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, version_number, terms_text, created_by, created_at
       FROM terms_conditions_versions
       ORDER BY version_number DESC`
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/admin/terms-conditions/versions', isAuthenticated, requireAdmin, async (req, res) => {
  const termsText = String(req.body?.terms_text || '').trim().slice(0, 4000);
  if (!termsText) return res.status(400).json({ error: 'terms_text is required' });
  const createdBy = req.user?.claims?.email || req.user?.email || req.user?.claims?.sub || 'admin';
  try {
    // Determine next version number
    const maxR = await pool.query(`SELECT COALESCE(MAX(version_number), 0) AS max_ver FROM terms_conditions_versions`);
    const nextVer = parseInt(maxR.rows[0].max_ver, 10) + 1;
    const r = await pool.query(
      `INSERT INTO terms_conditions_versions (version_number, terms_text, created_by)
       VALUES ($1, $2, $3) RETURNING *`,
      [nextVer, termsText, createdBy]
    );
    // Also update admin_settings so the legacy path stays in sync
    await pool.query(`
      INSERT INTO admin_settings (key, value, updated_at)
      VALUES ('design_visit_terms', $1::jsonb, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify({ text: termsText })]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Public catalogue reads (for wizard) ───────────────────────────────────────
router.get('/api/design-visit-handles', isAuthenticated, async (req, res) => {
  try {
    const r = await pool.query(`SELECT id, name, description, image_url, sort_order FROM design_visit_handles ORDER BY sort_order ASC, id ASC`);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/design-visit-furniture-ranges', isAuthenticated, async (req, res) => {
  try {
    const r = await pool.query(`SELECT id, name, description, sort_order FROM design_visit_furniture_ranges ORDER BY sort_order ASC, id ASC`);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/design-visit-door-styles', isAuthenticated, async (req, res) => {
  try {
    const r = await pool.query(`SELECT id, name, image_url, sort_order FROM design_visit_door_styles ORDER BY sort_order ASC, id ASC`);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Design Visits: CRUD ───────────────────────────────────────────────────────
router.get('/api/design-visits', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT dv.*, dvh.name AS handle_name, dvfr.name AS furniture_range_name,
             tcv.version_number AS terms_version_number
      FROM design_visits dv
      LEFT JOIN design_visit_handles          dvh  ON dvh.id  = dv.handle_id
      LEFT JOIN design_visit_furniture_ranges dvfr ON dvfr.id = dv.furniture_range_id
      LEFT JOIN terms_conditions_versions     tcv  ON tcv.id  = dv.terms_condition_version_id
      ORDER BY dv.created_at DESC LIMIT 500`);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/design-visits/:id', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const visit = await loadVisitWithRooms(id);
    if (!visit) return res.status(404).json({ error: 'Not found' });
    res.json(visit);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/design-visits — create + run full side-effect chain
router.post('/api/design-visits', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const userId = req.user?.claims?.sub;
  if (!checkDvRateLimit(userId)) {
    return res.status(429).json({ error: 'Too many requests. Please wait before submitting another design visit.' });
  }

  const {
    contactId, contactName, contactEmail,
    handleId, furnitureRangeId, visitDate, durationMin,
    location, notes, termsAccepted, rooms = [],
    handlerConfig,
  } = req.body;

  if (!contactId) return res.status(400).json({ error: 'contactId is required' });
  if (!Array.isArray(rooms) || !rooms.length) return res.status(400).json({ error: 'At least one room is required' });
  if (!termsAccepted) return res.status(400).json({ error: 'Terms and conditions must be accepted' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Look up the latest terms version to stamp on the visit
    let termsVersionId = null;
    try {
      const tvr = await pool.query(
        `SELECT id FROM terms_conditions_versions ORDER BY version_number DESC LIMIT 1`
      );
      termsVersionId = tvr.rows[0]?.id || null;
    } catch {}

    // Insert master visit record (status: draft)
    const vr = await client.query(`
      INSERT INTO design_visits
        (contact_id, contact_name, contact_email, created_by, handle_id, furniture_range_id,
         visit_date, duration_min, location, notes, terms_accepted, terms_condition_version_id, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft')
      RETURNING id`,
      [
        String(contactId),
        contactName  ? String(contactName).slice(0, 300)  : null,
        contactEmail ? String(contactEmail).slice(0, 300)  : null,
        String(userId),
        handleId        ? parseInt(handleId, 10)        || null : null,
        furnitureRangeId ? parseInt(furnitureRangeId, 10) || null : null,
        visitDate ? new Date(visitDate).toISOString() : null,
        durationMin ? parseInt(durationMin, 10) || 90 : 90,
        location ? String(location).slice(0, 500) : null,
        notes    ? String(notes).slice(0, 4000)   : null,
        !!termsAccepted,
        termsVersionId,
      ]
    );
    const visitId = vr.rows[0].id;

    // Insert rooms
    for (let i = 0; i < rooms.length; i++) {
      const rm = rooms[i];
      const rr = await client.query(`
        INSERT INTO design_visit_rooms
          (design_visit_id, room_name, door_style_id, width_mm, height_mm, depth_mm,
           unit_count, unit_price_pence, notes, sort_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING id`,
        [
          visitId,
          String(rm.roomName || rm.room_name || 'Room').slice(0, 200),
          rm.doorStyleId || rm.door_style_id ? parseInt(rm.doorStyleId || rm.door_style_id, 10) || null : null,
          rm.widthMm  || rm.width_mm  ? parseInt(rm.widthMm  || rm.width_mm,  10) || null : null,
          rm.heightMm || rm.height_mm ? parseInt(rm.heightMm || rm.height_mm, 10) || null : null,
          rm.depthMm  || rm.depth_mm  ? parseInt(rm.depthMm  || rm.depth_mm,  10) || null : null,
          Math.max(1, parseInt(rm.unitCount || rm.unit_count || 1, 10)),
          Math.max(0, parseInt(rm.unitPricePence || rm.unit_price_pence || 0, 10)),
          rm.notes ? String(rm.notes).slice(0, 2000) : null,
          i,
        ]
      );
      const roomId = rr.rows[0].id;
      // Insert images (base64 data URIs or URLs)
      const images = Array.isArray(rm.images) ? rm.images : [];
      for (const img of images) {
        const storageKey = String(img.storageKey || img.storage_key || img.url || '').slice(0, 2000);
        if (!storageKey) continue;
        await client.query(
          `INSERT INTO design_visit_room_images (room_id, storage_key, mime_type) VALUES ($1,$2,$3)`,
          [roomId, storageKey, img.mimeType || img.mime_type || null]
        );
      }
    }

    await client.query('COMMIT');

    // Run the full side-effect chain (status → submitted, HubSpot, QB, email).
    // Non-fatal integration failures are caught inside; we await so the DB
    // status transition to 'submitted' is guaranteed before we respond.
    try {
      await runSubmitSideEffects(visitId, handlerConfig || {}, req.user);
    } catch (e) {
      console.error('[design-visits] Side effect chain error:', e.message);
    }

    res.status(201).json({ ok: true, designVisitId: visitId });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[design-visits] POST /api/design-visits error:', e.message);
    res.status(500).json({ error: 'Could not save design visit.' });
  } finally {
    client.release();
  }
});

router.patch('/api/design-visits/:id', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const { location, notes, visitDate, durationMin, handleId, furnitureRangeId } = req.body;
  try {
    const r = await pool.query(`
      UPDATE design_visits SET
        location           = COALESCE($1, location),
        notes              = COALESCE($2, notes),
        visit_date         = COALESCE($3, visit_date),
        duration_min       = COALESCE($4, duration_min),
        handle_id          = COALESCE($5, handle_id),
        furniture_range_id = COALESCE($6, furniture_range_id),
        updated_at         = NOW()
      WHERE id = $7 AND status = 'draft'
      RETURNING id`,
      [
        location     ? String(location).slice(0, 500) : null,
        notes        ? String(notes).slice(0, 4000)   : null,
        visitDate    ? new Date(visitDate).toISOString() : null,
        durationMin  ? parseInt(durationMin, 10) || null : null,
        handleId     ? parseInt(handleId, 10) || null : null,
        furnitureRangeId ? parseInt(furnitureRangeId, 10) || null : null,
        id,
      ]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Visit not found or not in draft status' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/api/design-visits/:id', isAuthenticated, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const r = await pool.query(`DELETE FROM design_visits WHERE id=$1 RETURNING id`, [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/design-visits/:id/submit — re-run side effects on a draft visit
router.post('/api/design-visits/:id/submit', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const userId = req.user?.claims?.sub;
  if (!checkDvRateLimit(userId)) {
    return res.status(429).json({ error: 'Too many requests.' });
  }
  try {
    const vr = await pool.query(`SELECT status FROM design_visits WHERE id=$1`, [id]);
    if (!vr.rows.length) return res.status(404).json({ error: 'Visit not found' });
    const status = vr.rows[0].status;
    if (status !== 'draft' && status !== 'revision_requested') {
      return res.status(400).json({ error: `Cannot submit from status: ${status}` });
    }
    await runSubmitSideEffects(id, req.body?.handlerConfig || {}, req.user);
    res.json({ ok: true });
  } catch (e) {
    console.error('[design-visits] POST /api/design-visits/:id/submit error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/design-visits/:id/revision — mark revision requested
router.post('/api/design-visits/:id/revision', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const note = req.body?.note ? String(req.body.note).slice(0, 2000) : null;
  try {
    const r = await pool.query(`
      UPDATE design_visits SET status='revision_requested', revision_note=$1, updated_at=NOW()
      WHERE id=$2 AND status='submitted' RETURNING id`, [note, id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Visit not found or not in submitted status' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Public sign-off routes ────────────────────────────────────────────────────
// These are public — no isAuthenticated. Added to AUTH_WHITELIST in server.js.
router.get('/api/design-visits/sign-off/:token', async (req, res) => {
  const rawToken = String(req.params.token || '').trim();
  if (!rawToken || rawToken.length > 200) return res.status(404).json({ error: 'Not found' });
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  try {
    const vr = await pool.query(`
      SELECT dv.id, dv.contact_name, dv.contact_email, dv.status,
             dv.signoff_expires_at, dv.visit_date, dv.location, dv.notes,
             dv.terms_accepted, dvh.name AS handle_name, dvfr.name AS furniture_range_name
      FROM design_visits dv
      LEFT JOIN design_visit_handles          dvh  ON dvh.id  = dv.handle_id
      LEFT JOIN design_visit_furniture_ranges dvfr ON dvfr.id = dv.furniture_range_id
      WHERE dv.signoff_token_hash = $1`, [tokenHash]);
    if (!vr.rows.length) return res.status(404).json({ error: 'Not found' });
    const visit = vr.rows[0];
    // Always 404 for any token state that is not the expected sign-off window
    // (submitted + not expired). Avoids oracle leakage on consumed/expired tokens.
    if (visit.status !== 'submitted') return res.status(404).json({ error: 'Not found' });
    if (visit.signoff_expires_at && new Date() > new Date(visit.signoff_expires_at)) {
      return res.status(404).json({ error: 'Not found' });
    }
    // Load rooms
    const rooms = await pool.query(`
      SELECT dvr.room_name, dvr.width_mm, dvr.height_mm, dvr.depth_mm,
             dvr.unit_count, dvr.unit_price_pence, dvr.notes,
             dvds.name AS door_style_name
      FROM design_visit_rooms dvr
      LEFT JOIN design_visit_door_styles dvds ON dvds.id = dvr.door_style_id
      WHERE dvr.design_visit_id = $1
      ORDER BY dvr.sort_order ASC, dvr.id ASC`, [visit.id]);
    // Load T&C: prefer pinned version from visit row, fall back to latest, then admin_settings
    let terms = '';
    let termsVersionNumber = null;
    try {
      // Re-fetch visit with terms version FK
      const visitFull = await pool.query(
        `SELECT terms_condition_version_id FROM design_visits WHERE id = $1`, [visit.id]
      );
      const pinnedVersionId = visitFull.rows[0]?.terms_condition_version_id;
      if (pinnedVersionId) {
        const tv = await pool.query(
          `SELECT version_number, terms_text FROM terms_conditions_versions WHERE id = $1`,
          [pinnedVersionId]
        );
        if (tv.rows.length) {
          terms = tv.rows[0].terms_text;
          termsVersionNumber = tv.rows[0].version_number;
        }
      }
      if (!terms) {
        // Fall back to latest version
        const lv = await pool.query(
          `SELECT version_number, terms_text FROM terms_conditions_versions ORDER BY version_number DESC LIMIT 1`
        );
        if (lv.rows.length) {
          terms = lv.rows[0].terms_text;
          termsVersionNumber = lv.rows[0].version_number;
        }
      }
      if (!terms) {
        // Last resort: admin_settings (legacy)
        const ts = await pool.query(`SELECT value FROM admin_settings WHERE key='design_visit_terms'`);
        terms = ts.rows[0]?.value?.text || '';
      }
    } catch {}
    res.json({
      id:                 visit.id,
      contactName:        visit.contact_name,
      status:             visit.status,
      visitDate:          visit.visit_date,
      location:           visit.location,
      notes:              visit.notes,
      handleName:         visit.handle_name,
      furnitureRange:     visit.furniture_range_name,
      expiresAt:          visit.signoff_expires_at,
      termsVersionNumber,
      rooms:              rooms.rows.map(r => ({
        roomName:       r.room_name,
        doorStyleName:  r.door_style_name,
        widthMm:        r.width_mm,
        heightMm:       r.height_mm,
        depthMm:        r.depth_mm,
        unitCount:      r.unit_count,
        unitPricePence: r.unit_price_pence,
        totalPence:     r.unit_count * r.unit_price_pence,
        notes:          r.notes,
      })),
      terms,
    });
  } catch (e) {
    console.error('[design-visits] GET sign-off error:', e.message);
    res.status(500).json({ error: 'Could not load visit.' });
  }
});

router.post('/api/design-visits/sign-off/:token', async (req, res) => {
  const rawToken = String(req.params.token || '').trim();
  if (!rawToken || rawToken.length > 200) return res.status(404).json({ error: 'Not found' });
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const action = String(req.body?.action || '').trim();
  if (!['approve', 'revision'].includes(action)) {
    return res.status(400).json({ error: 'action must be "approve" or "revision"' });
  }
  const note = req.body?.note ? String(req.body.note).slice(0, 2000) : null;
  try {
    const vr = await pool.query(`
      SELECT id, status, signoff_expires_at, contact_name
      FROM design_visits WHERE signoff_token_hash = $1`, [tokenHash]);
    if (!vr.rows.length) return res.status(404).json({ error: 'Not found' });
    const visit = vr.rows[0];
    // Token is only actionable while the visit is in submitted state + not expired.
    if (visit.status !== 'submitted') return res.status(404).json({ error: 'Not found' });
    if (visit.signoff_expires_at && new Date() > new Date(visit.signoff_expires_at)) {
      return res.status(404).json({ error: 'Not found' });
    }
    if (action === 'approve') {
      await pool.query(`
        UPDATE design_visits SET status='signed_off', signed_off_at=NOW(),
          signoff_token_hash=NULL, updated_at=NOW()
        WHERE id=$1`, [visit.id]);
      // Notify team
      try {
        const transport = createMailTransport();
        const admins = adminEmails();
        if (transport && admins.length) {
          await transport.sendMail({
            from: buildFromHeader(), replyTo: buildReplyTo(),
            to: admins.join(', '),
            subject: `Design visit signed off — ${visit.contact_name || visit.id}`,
            text: `${visit.contact_name || 'The customer'} has approved and signed off their design visit (#${visit.id}).`,
          });
        }
      } catch {}
      res.json({ success: true, status: 'signed_off' });
    } else {
      // Invalidate the token on revision too — prevents replay
      await pool.query(`
        UPDATE design_visits SET status='revision_requested', revision_note=$1,
          signoff_token_hash=NULL, updated_at=NOW()
        WHERE id=$2`, [note, visit.id]);
      // Notify team
      try {
        const transport = createMailTransport();
        const admins = adminEmails();
        if (transport && admins.length) {
          await transport.sendMail({
            from: buildFromHeader(), replyTo: buildReplyTo(),
            to: admins.join(', '),
            subject: `Design visit revision requested — ${visit.contact_name || visit.id}`,
            text: `${visit.contact_name || 'The customer'} has requested changes to design visit #${visit.id}.\n\nNote: ${note || '(none)'}`,
          });
        }
      } catch {}
      res.json({ success: true, status: 'revision_requested' });
    }
  } catch (e) {
    console.error('[design-visits] POST sign-off error:', e.message);
    res.status(500).json({ error: 'Could not process sign-off.' });
  }
});

module.exports = { router: router, ensureDesignVisitTables };
