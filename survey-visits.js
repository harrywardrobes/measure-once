// survey-visits.js — start_survey_visit card action handler
// Survey visit CRUD, submit side-effects, refund flow, public sign-off routes.
//
// The Survey Visit is a continuation of the Design Visit. This module mirrors
// design-visits.js under a parallel /api/survey-visits* surface but DELIBERATELY
// does NOT re-mount the shared catalogue CRUD (/api/admin/catalog/*), the public
// catalogue reads (/api/catalog/*), or the visit-questions admin/member routes —
// all of those are owned by design-visits.js and shared verbatim. Questionnaire
// answers are persisted via the shared saveAnswers/loadAnswers helpers with
// visit_type = 'survey'. Image upload/signing reuses design-visit-uploads, so
// survey photos live in the same bucket and are served by the existing
// /api/design-visit-images/:key route.

const logger = require('./logger');
const express   = require('express');
const crypto    = require('crypto');
const axios     = require('axios').create({ timeout: 12000 });
const { Pool }  = require('pg');
const nodemailer = require('nodemailer');
const path      = require('path');
const fs        = require('fs');
const { isAuthenticated, requireAdmin, requirePrivilege, getRequestPrivilegeLevel } = require('./auth');
const dvUploads = require('./design-visit-uploads');
const { getCredential: getHubSpotCredential } = require('./hubspot-creds');
const { loadAnswers, saveAnswers } = require('./design-visits');
const { getEmailTemplate, renderEmail } = require('./email-templates');
const {
  structuredAddressSchema, formatAddress, isAddressEmpty,
} = require('./shared/address.cjs');

// Normalises a survey-visit address from the request body. Prefers the new
// structured object; falls back to wrapping a legacy free-text `location`
// string as a single address line. Returns { address, location } where
// `location` is the single-line formatAddress() rendering persisted to the
// legacy column for list/email read-fallback. Returns { error } on a malformed
// structured object.
function resolveSurveyVisitAddress(structuredAddress, location) {
  if (structuredAddress !== undefined && structuredAddress !== null) {
    const parsed = structuredAddressSchema.safeParse(structuredAddress);
    if (!parsed.success) return { error: 'Invalid address.' };
    const address = isAddressEmpty(parsed.data) ? null : parsed.data;
    return { address, location: address ? formatAddress(address).replace(/\n/g, ', ') : null };
  }
  const loc = location ? String(location).trim() : '';
  if (!loc) return { address: null, location: null };
  const address = { addressLines: [loc.slice(0, 500)], countryCode: 'GB' };
  return { address, location: loc.slice(0, 500) };
}

let _patchContactProperties = async (_contactId, _props) => {
  logger.warn('[survey-visits] patchContactProperties called before wiring — HubSpot PATCH skipped');
};
function setPatchContactProperties(fn) { _patchContactProperties = fn; }

const pool   = new Pool({ connectionString: process.env.DATABASE_URL });
const router = express.Router();

// ── Utility helpers (mirror design-visits.js private helpers) ─────────────────
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
  // Test-only override so the integration suite can capture sendMail payloads
  // without standing up a real SMTP server. Never set in production.
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
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: parseInt(process.env.SMTP_PORT || '587', 10) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}
function hubspotApiBase() {
  // Test-only override so the integration suite can point HubSpot HTTP traffic
  // at a local mock server. Never set in production.
  return process.env.HUBSPOT_API_BASE_OVERRIDE || 'https://api.hubapi.com';
}
function getHubSpotHeaders() {
  return {
    Authorization: `Bearer ${getHubSpotCredential('access_token')}`,
    'Content-Type': 'application/json',
  };
}
async function hubspotRequestWithRetry(method, url, data, { timeout = 15000, maxAttempts = 4, baseDelayMs = 300, maxDelayMs = 4000 } = {}) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const isTransient = err => {
    const s = err.response?.status;
    if (s === 429) return true;
    if (s && s >= 500 && s < 600) return true;
    if (!err.response) return true;
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
      if (method === 'get' || method === 'delete') return await axios[method](url, cfg);
      return await axios[method](url, data, cfg);
    } catch (err) {
      lastErr = err;
      if (!isTransient(err)) throw err;
      if (attempt === maxAttempts - 1) break;
      const hinted = retryAfterMs(err);
      const backoff = hinted != null ? hinted : Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      if (process.env.DEBUG_HUBSPOT) {
        logger.warn('[survey-visits/hubspot-retry] attempt=%d status=%s backoff=%dms endpoint=%s %s', attempt + 1, err.response?.status || 'network', backoff, method.toUpperCase(), url);
      }
      await sleep(backoff);
    }
  }
  const base = hubspotApiBase();
  const shortUrl = url.startsWith(base) ? url.slice(base.length) : url;
  logger.error('[survey-visits/hubspot-retry] all %d attempts exhausted endpoint=%s %s finalStatus=%s', maxAttempts, method.toUpperCase(), shortUrl, lastErr?.response?.status || 'network');
  throw lastErr;
}
function adminEmails() {
  return (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
}

// ── QuickBooks helpers (reads from qb_tokens table) ───────────────────────────
const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
function getQuickBooksBaseUrl() {
  // Test-only override so the integration suite can point QuickBooks HTTP
  // traffic at a local mock server. Never set in production.
  if (process.env.QB_API_BASE_OVERRIDE) return process.env.QB_API_BASE_OVERRIDE;
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

// ── Per-user rate limiter for survey visit create/submit ──────────────────────
const SURVEY_VISIT_RATE_WINDOW_MS = 10 * 60 * 1000;
const SURVEY_VISIT_RATE_LIMIT     = 20;
const _surveyVisitRateMap = new Map();
function checkSurveyVisitRateLimit(userId) {
  const now = Date.now();
  const cutoff = now - SURVEY_VISIT_RATE_WINDOW_MS;
  const ts = (_surveyVisitRateMap.get(userId) || []).filter(t => t > cutoff);
  if (ts.length >= SURVEY_VISIT_RATE_LIMIT) return false;
  ts.push(now);
  _surveyVisitRateMap.set(userId, ts);
  return true;
}

// ── Helper: load survey visit with rooms ──────────────────────────────────────
async function loadVisitWithRooms(id) {
  const vr = await pool.query(`
    SELECT sv.*,
           svh.name   AS handle_name,
           svfr.name  AS furniture_range_name,
           tcv.version_number AS terms_version_number
    FROM survey_visits sv
    LEFT JOIN catalog_handles               svh  ON svh.id  = sv.handle_id
    LEFT JOIN catalog_ranges                svfr ON svfr.id = sv.furniture_range_id
    LEFT JOIN terms_conditions_versions     tcv  ON tcv.id  = sv.terms_condition_version_id
    WHERE sv.id = $1`, [id]);
  if (!vr.rows.length) return null;
  const visit = vr.rows[0];
  const rooms = await pool.query(`
    SELECT svr.*, svds.name AS door_style_name
    FROM survey_visit_rooms svr
    LEFT JOIN catalog_doors            svds ON svds.id = svr.door_style_id
    WHERE svr.survey_visit_id = $1
    ORDER BY svr.sort_order ASC, svr.id ASC`, [id]);
  const images = await pool.query(`
    SELECT svri.room_id, svri.storage_key, svri.mime_type
    FROM survey_visit_room_images svri
    JOIN survey_visit_rooms svr ON svr.id = svri.room_id
    WHERE svr.survey_visit_id = $1
    ORDER BY svri.id ASC`, [id]);
  const imagesByRoom = {};
  for (const img of images.rows) {
    if (!imagesByRoom[img.room_id]) imagesByRoom[img.room_id] = [];
    imagesByRoom[img.room_id].push({
      storageKey: img.storage_key,
      mimeType:   img.mime_type,
      viewUrl:    dvUploads.signImageUrl(img.storage_key),
    });
  }
  visit.rooms = rooms.rows.map(r => ({
    ...r,
    images: imagesByRoom[r.id] || [],
  }));
  visit.structuredAddress = visit.structured_address
    || (visit.location ? { addressLines: [String(visit.location)], countryCode: 'GB' } : null);
  return visit;
}

// ── Format currency helper ────────────────────────────────────────────────────
function penceToGbp(pence) {
  return (pence / 100).toFixed(2);
}

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Side-effect chain: submit survey visit ────────────────────────────────────
//
// Mirrors submitDesignVisitAndSync. Orchestrates all side effects that occur
// when a survey visit is submitted (or resubmitted after a revision request):
//   1. DB update (fatal)         — status='submitted', rotate sign-off token.
//   2. HubSpot lead status       — manager/admin only, from submittedLeadStatus.
//   3. HubSpot note              — CRM note summarising the survey.
//   4. QuickBooks estimate       — sparse-update existing or create + history.
//   5. Customer sign-off email   — link to /survey-visit/sign-off.
//   6. Team notification email.
async function submitSurveyVisitAndSync(visitId, handlerConfig, submitterUser) {
  const visit = await loadVisitWithRooms(visitId);
  if (!visit) throw new Error('Visit not found');

  // 1. Update status to submitted + rotate sign-off token.
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await pool.query(`
    UPDATE survey_visits
    SET status = 'submitted',
        superseded_signoff_token_hashes = CASE WHEN signoff_token_hash IS NOT NULL
          AND signoff_token_hash <> $1
          THEN COALESCE(superseded_signoff_token_hashes, ARRAY[]::TEXT[]) || ARRAY[signoff_token_hash]
          ELSE superseded_signoff_token_hashes END,
        signoff_token_hash = $1,
        signoff_expires_at = $2,
        updated_at = NOW()
    WHERE id = $3`, [tokenHash, expiresAt.toISOString(), visitId]);

  // 2. HubSpot lead status update (non-fatal). Only manager/admin users may
  // drive pipeline changes through this path.
  const submitterPrivilege = submitterUser?.privilege_level || 'member'; // privilege-read-ok: checking the submitter's privilege, not the current request user's
  const submitterCanEditPipeline = submitterPrivilege === 'admin' || submitterPrivilege === 'manager';
  const submittedLeadStatus = submitterCanEditPipeline ? handlerConfig?.submittedLeadStatus : null;
  if (submittedLeadStatus && getHubSpotCredential('access_token') && visit.contact_id) {
    try {
      await _patchContactProperties(visit.contact_id, { hs_lead_status: submittedLeadStatus });
    } catch (e) {
      logger.warn({ err: e.message }, '[survey-visits] HubSpot lead status update failed:');
    }
  }

  // 3. HubSpot note (non-fatal)
  if (getHubSpotCredential('access_token') && visit.contact_id) {
    try {
      const roomLines = (visit.rooms || []).map(r =>
        `  • ${r.room_name}: ${r.unit_count} unit(s) @ £${penceToGbp(r.unit_price_pence)} each`
      ).join('\n');
      const noteBody = [
        `Survey visit submitted`,
        `Surveyor: ${submitterUser?.claims?.email || submitterUser?.email || 'unknown'}`,
        visit.handle_name         ? `Handle: ${visit.handle_name}` : null,
        visit.furniture_range_name ? `Furniture range: ${visit.furniture_range_name}` : null,
        visit.visit_date          ? `Visit date: ${new Date(visit.visit_date).toLocaleString()}` : null,
        roomLines ? `Rooms:\n${roomLines}` : null,
        visit.visit_notes ? `Visit notes:\n${visit.visit_notes}` : null,
      ].filter(Boolean).join('\n');
      await hubspotRequestWithRetry('post',
        `${hubspotApiBase()}/crm/v3/objects/notes`,
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
        }
      );
    } catch (e) {
      logger.warn({ err: e.message }, '[survey-visits] HubSpot note creation failed:');
    }
  }

  // 4. QuickBooks Estimate (non-fatal). Sparse-update the existing estimate if
  // one is on file and still editable, else create a replacement and append the
  // old id to qb_estimate_history.
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
        `Survey visit — ${visit.contact_name || ''}`,
        visit.handle_name          ? `Handle: ${visit.handle_name}` : null,
        visit.furniture_range_name ? `Furniture range: ${visit.furniture_range_name}` : null,
      ].filter(Boolean).join('\n');
      const basePayload = {
        TxnDate:        new Date().toISOString().slice(0, 10),
        CustomerRef:    { value: visit.contact_id },
        BillEmail:      visit.contact_email ? { Address: visit.contact_email } : undefined,
        CustomerMemo:   { value: memo },
        ExpirationDate: expDate.toISOString().slice(0, 10),
        Line:           lines,
      };
      const qbHeaders = {
        headers: { Authorization: `Bearer ${qbt.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        params:  { minorversion: 65 },
      };

      let updated = false;
      const priorId = visit.qb_estimate_id;
      if (priorId) {
        try {
          const getResp = await axios.get(
            `${getQuickBooksBaseUrl()}/v3/company/${qbt.realm_id}/estimate/${encodeURIComponent(priorId)}`,
            qbHeaders
          );
          const existing = getResp.data?.Estimate;
          const txnStatus = String(existing?.TxnStatus || '').toLowerCase();
          const isUpdatable = existing && existing.SyncToken != null &&
            (txnStatus === '' || txnStatus === 'pending');
          if (isUpdatable) {
            const updResp = await axios.post(
              `${getQuickBooksBaseUrl()}/v3/company/${qbt.realm_id}/estimate`,
              { ...basePayload, Id: existing.Id, SyncToken: existing.SyncToken, sparse: true },
              qbHeaders
            );
            const est = updResp.data?.Estimate;
            if (est?.Id) {
              await pool.query(
                `UPDATE survey_visits SET qb_estimate_id = $1, qb_estimate_doc_num = $2, updated_at = NOW() WHERE id = $3`,
                [est.Id, est.DocNumber || null, visitId]
              );
              updated = true;
            }
          } else {
            logger.warn(`[survey-visits] QB estimate ${priorId} not updatable (TxnStatus=${existing?.TxnStatus || 'unknown'}); creating replacement.`);
          }
        } catch (e) {
          logger.warn(`[survey-visits] QB estimate ${priorId} fetch/update failed (${e.response?.status || ''} ${e.message}); creating replacement.`);
        }
      }

      if (!updated) {
        const qbResp = await axios.post(
          `${getQuickBooksBaseUrl()}/v3/company/${qbt.realm_id}/estimate`,
          basePayload,
          qbHeaders
        );
        const est = qbResp.data?.Estimate;
        if (est?.Id) {
          if (priorId && priorId !== est.Id) {
            try {
              const _priorResp = await axios.get(
                `${getQuickBooksBaseUrl()}/v3/company/${qbt.realm_id}/estimate/${encodeURIComponent(priorId)}`,
                qbHeaders
              );
              const _priorEst = _priorResp.data?.Estimate;
              if (_priorEst?.SyncToken != null) {
                await axios.post(
                  `${getQuickBooksBaseUrl()}/v3/company/${qbt.realm_id}/estimate`,
                  { sparse: true, Id: priorId, SyncToken: _priorEst.SyncToken, TxnStatus: 'Rejected' },
                  qbHeaders
                );
              }
            } catch (_rejErr) {
              logger.warn(`[survey-visits] Could not mark superseded estimate ${priorId} as Rejected in QB: ${_rejErr.message}`);
            }
            await pool.query(
              `UPDATE survey_visits
                  SET qb_estimate_id      = $1,
                      qb_estimate_doc_num = $2,
                      qb_estimate_history = qb_estimate_history || $3::jsonb,
                      updated_at          = NOW()
                WHERE id = $4`,
              [
                est.Id,
                est.DocNumber || null,
                JSON.stringify([{
                  qb_estimate_id:      priorId,
                  qb_estimate_doc_num: visit.qb_estimate_doc_num || null,
                  replaced_at:         new Date().toISOString(),
                  replaced_by:         submitterUser?.claims?.email || submitterUser?.email || null,
                  reason:              'prior_estimate_not_updatable',
                }]),
                visitId,
              ]
            );
          } else {
            await pool.query(
              `UPDATE survey_visits SET qb_estimate_id = $1, qb_estimate_doc_num = $2, updated_at = NOW() WHERE id = $3`,
              [est.Id, est.DocNumber || null, visitId]
            );
          }
        }
      }
    }
  } catch (e) {
    logger.warn({ err: e.message }, '[survey-visits] QuickBooks estimate sync failed:');
  }

  // 5. Customer confirmation email (non-fatal)
  const signOffUrl = `${appBaseUrl()}/survey-visit/sign-off?token=${rawToken}`;
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
        subject: `Your survey visit — ${visit.contact_name || ''}`,
        text: [
          `Hi ${firstName},`,
          '',
          'Thank you for your time today. Here\'s a summary of the survey we completed.',
          '',
          '--- Room Breakdown ---',
          roomRowsText,
          '',
          `Estimate total: £${penceToGbp(grandTotal)}`,
          visit.visit_notes ? `\n--- Visit Notes ---\n${visit.visit_notes}` : '',
          '',
          'See Your Survey & Sign Off:',
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
  <h1 style="font-size:1.4rem;margin-bottom:4px;">Your survey visit summary</h1>
  <p style="color:#6b7280;margin-top:0;">Hi ${_esc(firstName)},</p>
  <p>Thank you for your time today. Here's a summary of the survey we completed.</p>
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
  ${visit.visit_notes ? `<div style="margin:20px 0;padding:14px 16px;background:#f9fafb;border-left:3px solid #e5e7eb;border-radius:4px;">
    <p style="margin:0 0 6px;font-size:.8rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;">Visit Notes</p>
    <p style="margin:0;white-space:pre-line;font-size:.9rem;">${_esc(visit.visit_notes)}</p>
  </div>` : ''}
  <div style="text-align:center;margin:28px 0;">
    <a href="${signOffUrl}"
       style="display:inline-block;background:#8B2BFF;color:#fff;padding:14px 32px;
              border-radius:8px;text-decoration:none;font-weight:600;font-size:1rem;">
      See Your Survey &amp; Sign Off
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
    logger.warn({ err: e.message }, '[survey-visits] Customer email send failed:');
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
        subject: `Survey visit submitted — ${visit.contact_name || visit.contact_id}`,
        text: [
          `Survey visit submitted by ${submitterUser?.claims?.email || submitterUser?.email || 'unknown'}`,
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
  <h2 style="font-size:1.2rem;">Survey visit submitted</h2>
  <p>Submitted by <strong>${_esc(submitterUser?.claims?.email || submitterUser?.email || 'unknown')}</strong></p>
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
    logger.warn({ err: e.message }, '[survey-visits] Team notification email failed:');
  }

  return { rawToken, expiresAt };
}

// Resolve a submitted room image into a durable storage key + mime type. Offline
// data: URIs are materialised into object storage; opaque/http/app-path keys are
// passed through. Mirrors design-visits resolveRoomImageForStorage.
async function resolveRoomImageForStorage(img) {
  const raw = String(img.storageKey || img.storage_key || img.url || '');
  if (!raw) return null;
  const isOpaque    = dvUploads.isOpaqueKey(raw);
  const isDataImage = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i.test(raw);
  const isHttpUrl   = /^https?:\/\//i.test(raw);
  const isAppPath   = raw.startsWith('/');
  if (!isOpaque && !isDataImage && !isHttpUrl && !isAppPath) return null;
  const MAX_IMG_BYTES = 10 * 1024 * 1024;
  if (raw.length > MAX_IMG_BYTES) return null;
  if (isDataImage) {
    try {
      const up = await dvUploads.uploadFromDataUrl(raw);
      return { key: up.storageKey, mimeType: up.mimeType };
    } catch (e) {
      logger.warn({ err: e.message }, '[survey-visits] inline image materialise failed; storing data URI inline');
      return { key: raw, mimeType: img.mimeType || img.mime_type || null };
    }
  }
  return { key: raw, mimeType: img.mimeType || img.mime_type || null };
}

// ── Survey Visits: CRUD ───────────────────────────────────────────────────────
router.get('/api/survey-visits', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  try {
    const contactId = req.query.contactId;
    const callerPrivilege = getRequestPrivilegeLevel(req);
    const isMemberOnly = callerPrivilege === 'member';
    const callerId = req.user?.claims?.sub;
    const conditions = [];
    const params = [];
    if (contactId !== undefined && contactId !== null && String(contactId).length) {
      params.push(String(contactId));
      conditions.push(`sv.contact_id = $${params.length}`);
    }
    if (isMemberOnly) {
      params.push(String(callerId));
      conditions.push(`sv.created_by = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const r = await pool.query(`
      SELECT sv.*, svh.name AS handle_name, svfr.name AS furniture_range_name,
             tcv.version_number AS terms_version_number,
             COALESCE((
               SELECT SUM(svr.unit_count * svr.unit_price_pence)
               FROM survey_visit_rooms svr
               WHERE svr.survey_visit_id = sv.id
             ), 0) AS estimate_total_pence
      FROM survey_visits sv
      LEFT JOIN catalog_handles               svh  ON svh.id  = sv.handle_id
      LEFT JOIN catalog_ranges                svfr ON svfr.id = sv.furniture_range_id
      LEFT JOIN terms_conditions_versions     tcv  ON tcv.id  = sv.terms_condition_version_id
      ${where}
      ORDER BY sv.created_at DESC LIMIT 500`, params);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/survey-visits/in-progress', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  try {
    let contactIds = req.query.contactIds;
    if (!contactIds) return res.json([]);
    if (typeof contactIds === 'string') contactIds = contactIds.split(',');
    contactIds = Array.from(
      new Set(
        (Array.isArray(contactIds) ? contactIds : [contactIds])
          .map(id => String(id).trim())
          .filter(Boolean),
      ),
    ).slice(0, 100);
    if (!contactIds.length) return res.json([]);
    const callerPrivilege = getRequestPrivilegeLevel(req);
    const isMemberOnly = callerPrivilege === 'member';
    const callerId = req.user?.claims?.sub;
    let r;
    if (isMemberOnly) {
      r = await pool.query(
        `SELECT id, contact_id FROM survey_visits
         WHERE contact_id = ANY($1) AND status = 'draft' AND created_by = $2
         ORDER BY created_at DESC`,
        [contactIds, String(callerId)],
      );
    } else {
      r = await pool.query(
        `SELECT id, contact_id FROM survey_visits
         WHERE contact_id = ANY($1) AND status = 'draft'
         ORDER BY created_at DESC`,
        [contactIds],
      );
    }
    const seen = new Set();
    const result = [];
    for (const row of r.rows) {
      if (!seen.has(row.contact_id)) {
        seen.add(row.contact_id);
        result.push({ id: row.id, contactId: row.contact_id });
      }
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/survey-visits/prefill?contactId= — continuation pre-fill loader.
// Loads the contact's most recent signed-off design visit (with rooms, doors,
// dimensions, pricing, and signed photo URLs) so the survey wizard can pre-fill
// every room. Available to member+ because the survey is a cross-role
// continuation handoff (the surveyor is frequently not the original designer);
// only catalogue/room data needed to run the survey is returned.
//
// TODO(future): when the open-deal / deposit "rooms going ahead" set exists,
// prefer that subset over the full design-visit room list.
router.get('/api/survey-visits/prefill', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const contactId = req.query.contactId ? String(req.query.contactId).trim() : '';
  if (!contactId) return res.status(400).json({ error: 'contactId is required' });
  try {
    const dvr = await pool.query(`
      SELECT dv.*, dvh.name AS handle_name, dvfr.name AS furniture_range_name
      FROM design_visits dv
      LEFT JOIN catalog_handles dvh  ON dvh.id  = dv.handle_id
      LEFT JOIN catalog_ranges  dvfr ON dvfr.id = dv.furniture_range_id
      WHERE dv.contact_id = $1 AND dv.status = 'signed_off'
      ORDER BY dv.signed_off_at DESC NULLS LAST, dv.created_at DESC
      LIMIT 1`, [contactId]);
    if (!dvr.rows.length) {
      return res.status(404).json({ error: 'No signed-off design visit found for this contact.' });
    }
    const dv = dvr.rows[0];
    const rooms = await pool.query(`
      SELECT dvr.*, dvds.name AS door_style_name
      FROM design_visit_rooms dvr
      LEFT JOIN catalog_doors dvds ON dvds.id = dvr.door_style_id
      WHERE dvr.design_visit_id = $1
      ORDER BY dvr.sort_order ASC, dvr.id ASC`, [dv.id]);
    const images = await pool.query(`
      SELECT dvri.room_id, dvri.storage_key, dvri.mime_type
      FROM design_visit_room_images dvri
      JOIN design_visit_rooms dvr ON dvr.id = dvri.room_id
      WHERE dvr.design_visit_id = $1
      ORDER BY dvri.id ASC`, [dv.id]);
    const imagesByRoom = {};
    for (const img of images.rows) {
      if (!imagesByRoom[img.room_id]) imagesByRoom[img.room_id] = [];
      imagesByRoom[img.room_id].push({
        storageKey: img.storage_key,
        mimeType:   img.mime_type,
        viewUrl:    dvUploads.signImageUrl(img.storage_key),
      });
    }
    res.json({
      designVisitId:    dv.id,
      contactId:        dv.contact_id,
      contactName:      dv.contact_name,
      contactEmail:     dv.contact_email,
      handleId:         dv.handle_id,
      handleName:       dv.handle_name,
      furnitureRangeId: dv.furniture_range_id,
      furnitureRangeName: dv.furniture_range_name,
      durationMin:      dv.duration_min,
      structuredAddress: dv.structured_address
        || (dv.location ? { addressLines: [String(dv.location)], countryCode: 'GB' } : null),
      location:         dv.location,
      notes:            dv.notes,
      qbEstimateId:     dv.qb_estimate_id,
      qbEstimateDocNum: dv.qb_estimate_doc_num,
      rooms: rooms.rows.map(r => ({
        sourceDesignVisitRoomId: r.id,
        roomName:       r.room_name,
        doorStyleId:    r.door_style_id,
        doorStyleName:  r.door_style_name,
        widthMm:        r.width_mm,
        heightMm:       r.height_mm,
        depthMm:        r.depth_mm,
        unitCount:      r.unit_count,
        unitPricePence: r.unit_price_pence,
        notes:          r.notes,
        images:         imagesByRoom[r.id] || [],
      })),
    });
  } catch (e) {
    logger.error({ err: e.message }, '[survey-visits] GET prefill error:');
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/survey-visits/:id', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const visit = await loadVisitWithRooms(id);
    if (!visit) return res.status(404).json({ error: 'Not found' });
    const callerPrivilege = getRequestPrivilegeLevel(req);
    if (callerPrivilege === 'member') {
      const callerId = req.user?.claims?.sub;
      if (visit.created_by !== String(callerId)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }
    res.json(visit);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/survey-visits — create + run full side-effect chain
router.post('/api/survey-visits', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const userId = req.user?.claims?.sub;
  if (!checkSurveyVisitRateLimit(userId)) {
    return res.status(429).json({ error: 'Too many requests. Please wait before submitting another survey visit.' });
  }

  const {
    contactId, contactName, contactEmail,
    designVisitId, handleId, furnitureRangeId, visitDate, durationMin,
    structuredAddress, location, notes, visitNotes, termsAccepted, rooms = [],
    handlerConfig, answers,
  } = req.body;

  if (!contactId) return res.status(400).json({ error: 'contactId is required' });
  if (!Array.isArray(rooms) || !rooms.length) return res.status(400).json({ error: 'At least one room is required' });
  if (!termsAccepted) return res.status(400).json({ error: 'Terms and conditions must be accepted' });

  const createAddr = resolveSurveyVisitAddress(structuredAddress, location);
  if (createAddr.error) return res.status(400).json({ error: createAddr.error });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let termsVersionId = null;
    try {
      const tvr = await pool.query(
        `SELECT id FROM terms_conditions_versions ORDER BY version_number DESC LIMIT 1`
      );
      termsVersionId = tvr.rows[0]?.id || null;
    } catch {}

    const vr = await client.query(`
      INSERT INTO survey_visits
        (contact_id, contact_name, contact_email, created_by, design_visit_id, handle_id, furniture_range_id,
         visit_date, duration_min, location, structured_address, notes, visit_notes, terms_accepted, terms_condition_version_id, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,'draft')
      RETURNING id`,
      [
        String(contactId),
        contactName  ? String(contactName).slice(0, 300)  : null,
        contactEmail ? String(contactEmail).slice(0, 300)  : null,
        String(userId),
        designVisitId ? parseInt(designVisitId, 10) || null : null,
        handleId        ? parseInt(handleId, 10)        || null : null,
        furnitureRangeId ? parseInt(furnitureRangeId, 10) || null : null,
        visitDate ? new Date(visitDate).toISOString() : null,
        durationMin ? parseInt(durationMin, 10) || 90 : 90,
        createAddr.location,
        createAddr.address ? JSON.stringify(createAddr.address) : null,
        notes      ? String(notes).slice(0, 4000)      : null,
        visitNotes ? String(visitNotes).slice(0, 4000) : null,
        !!termsAccepted,
        termsVersionId,
      ]
    );
    const visitId = vr.rows[0].id;

    // For member callers, verify they own every opaque cloud-storage key being
    // submitted (recorded in survey_visit_pending_uploads with created_by =
    // caller). Prevents attaching a leaked foreign key.
    const postCallerPrivilege = getRequestPrivilegeLevel(req);
    if (postCallerPrivilege === 'member') {
      const opaqueKeys = [];
      for (const rm of rooms) {
        for (const img of (Array.isArray(rm.images) ? rm.images : [])) {
          const raw = String(img.storageKey || img.storage_key || img.url || '');
          if (dvUploads.isOpaqueKey(raw)) opaqueKeys.push(raw);
        }
      }
      if (opaqueKeys.length) {
        const owned = await client.query(
          `SELECT storage_key FROM survey_visit_pending_uploads
           WHERE storage_key = ANY($1) AND created_by = $2`,
          [opaqueKeys, String(userId)],
        );
        const ownedSet = new Set(owned.rows.map(r => r.storage_key));
        const foreign = opaqueKeys.filter(k => !ownedSet.has(k));
        if (foreign.length) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'Forbidden: one or more image keys were not uploaded by this user' });
        }
      }
    }

    const collectedRoomAnswers = [];
    for (let i = 0; i < rooms.length; i++) {
      const rm = rooms[i];
      const rr = await client.query(`
        INSERT INTO survey_visit_rooms
          (survey_visit_id, source_design_visit_room_id, room_name, door_style_id, width_mm, height_mm, depth_mm,
           unit_count, unit_price_pence, notes, sort_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING id`,
        [
          visitId,
          rm.sourceDesignVisitRoomId || rm.source_design_visit_room_id
            ? parseInt(rm.sourceDesignVisitRoomId || rm.source_design_visit_room_id, 10) || null : null,
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
      if (Array.isArray(rm.answers)) {
        for (const a of rm.answers) {
          if (a && a.question_id != null) {
            collectedRoomAnswers.push({ question_id: a.question_id, room_id: roomId, answer: a.answer });
          }
        }
      }
      const images = Array.isArray(rm.images) ? rm.images : [];
      for (const img of images) {
        const resolved = await resolveRoomImageForStorage(img);
        if (!resolved) continue;
        await client.query(
          `INSERT INTO survey_visit_room_images (room_id, storage_key, mime_type) VALUES ($1,$2,$3)`,
          [roomId, resolved.key, resolved.mimeType]
        );
      }
    }

    await client.query('COMMIT');

    const visitAnswers = Array.isArray(answers)
      ? answers.map(a => ({ question_id: a.question_id, room_id: null, answer: a.answer }))
      : [];
    const combinedAnswers = [...visitAnswers, ...collectedRoomAnswers];
    if (combinedAnswers.length) {
      try {
        await saveAnswers('survey', visitId, combinedAnswers);
      } catch (e) {
        logger.error({ err: e.message }, '[survey-visits] saveAnswers (create) error:');
      }
    }

    try {
      await submitSurveyVisitAndSync(visitId, handlerConfig || {}, req.user);
    } catch (e) {
      logger.error({ err: e.message }, '[survey-visits] Side effect chain error:');
    }

    res.status(201).json({ ok: true, surveyVisitId: visitId });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err: e.message }, '[survey-visits] POST /api/survey-visits error:');
    res.status(500).json({ error: 'Could not save survey visit.' });
  } finally {
    client.release();
  }
});

router.patch('/api/survey-visits/:id', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const { structuredAddress, location, notes, visitNotes: patchVisitNotes, visitDate, durationMin, handleId, furnitureRangeId } = req.body;
  try {
    let patchAddr = { address: undefined, location: undefined };
    if (structuredAddress !== undefined || location !== undefined) {
      patchAddr = resolveSurveyVisitAddress(structuredAddress, location);
      if (patchAddr.error) return res.status(400).json({ error: patchAddr.error });
    }
    const callerPrivilege = getRequestPrivilegeLevel(req);
    const isMemberOnly = callerPrivilege === 'member';
    const callerId = req.user?.claims?.sub;
    const ownerClause = isMemberOnly ? `AND created_by = $10` : '';
    const params = [
      patchAddr.location === undefined ? null : patchAddr.location,
      notes           ? String(notes).slice(0, 4000)           : null,
      patchVisitNotes ? String(patchVisitNotes).slice(0, 4000) : null,
      visitDate    ? new Date(visitDate).toISOString() : null,
      durationMin  ? parseInt(durationMin, 10) || null : null,
      handleId     ? parseInt(handleId, 10) || null : null,
      furnitureRangeId ? parseInt(furnitureRangeId, 10) || null : null,
      patchAddr.address === undefined ? null : (patchAddr.address ? JSON.stringify(patchAddr.address) : null),
      id,
    ];
    if (isMemberOnly) params.push(String(callerId));
    const r = await pool.query(`
      UPDATE survey_visits SET
        location           = COALESCE($1, location),
        notes              = COALESCE($2, notes),
        visit_notes        = COALESCE($3, visit_notes),
        visit_date         = COALESCE($4, visit_date),
        duration_min       = COALESCE($5, duration_min),
        handle_id          = COALESCE($6, handle_id),
        furniture_range_id = COALESCE($7, furniture_range_id),
        structured_address = COALESCE($8::jsonb, structured_address),
        updated_at         = NOW()
      WHERE id = $9 AND status = 'draft' ${ownerClause}
      RETURNING id`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Visit not found or not in draft status' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/survey-visits/:id — re-open and replace a submitted / revision_requested
// visit, then re-run the full side-effect chain (fresh sign-off token, QB
// estimate, customer email). The previous sign-off link is invalidated.
router.put('/api/survey-visits/:id', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const userId = req.user?.claims?.sub;
  if (!checkSurveyVisitRateLimit(userId)) {
    return res.status(429).json({ error: 'Too many requests. Please wait before resubmitting.' });
  }

  const {
    contactName, contactEmail,
    handleId, furnitureRangeId, visitDate, durationMin,
    structuredAddress, location, notes, visitNotes: putVisitNotes, termsAccepted, rooms = [],
    handlerConfig, answers,
  } = req.body;

  if (!Array.isArray(rooms) || !rooms.length) return res.status(400).json({ error: 'At least one room is required' });
  if (!termsAccepted) return res.status(400).json({ error: 'Terms and conditions must be accepted' });

  const putAddr = resolveSurveyVisitAddress(structuredAddress, location);
  if (putAddr.error) return res.status(400).json({ error: putAddr.error });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cur = await client.query(
      `SELECT status, created_by FROM survey_visits WHERE id=$1 FOR UPDATE`, [id]
    );
    if (!cur.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Visit not found' });
    }
    const status = cur.rows[0].status;
    const callerPrivilegeForPut = getRequestPrivilegeLevel(req);
    if (callerPrivilegeForPut === 'member' && cur.rows[0].created_by !== String(userId)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (status !== 'submitted' && status !== 'revision_requested' && status !== 'draft') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Cannot edit visit in status: ${status}` });
    }

    let termsVersionId = null;
    try {
      const tvr = await client.query(
        `SELECT id FROM terms_conditions_versions ORDER BY version_number DESC LIMIT 1`
      );
      termsVersionId = tvr.rows[0]?.id || null;
    } catch {}

    await client.query(`
      UPDATE survey_visits SET
        contact_name               = $1,
        contact_email              = $2,
        handle_id                  = $3,
        furniture_range_id         = $4,
        visit_date                 = $5,
        duration_min               = $6,
        location                   = $7,
        structured_address         = $8::jsonb,
        notes                      = $9,
        visit_notes                = $10,
        terms_accepted             = $11,
        terms_condition_version_id = $12,
        status                     = 'draft',
        superseded_signoff_token_hashes = CASE WHEN signoff_token_hash IS NOT NULL
          THEN COALESCE(superseded_signoff_token_hashes, ARRAY[]::TEXT[]) || ARRAY[signoff_token_hash]
          ELSE superseded_signoff_token_hashes END,
        signoff_token_hash         = NULL,
        signoff_expires_at         = NULL,
        updated_at                 = NOW()
      WHERE id = $13`,
      [
        contactName  ? String(contactName).slice(0, 300)  : null,
        contactEmail ? String(contactEmail).slice(0, 300) : null,
        handleId         ? parseInt(handleId, 10)         || null : null,
        furnitureRangeId ? parseInt(furnitureRangeId, 10) || null : null,
        visitDate ? new Date(visitDate).toISOString() : null,
        durationMin ? parseInt(durationMin, 10) || 90 : 90,
        putAddr.location,
        putAddr.address ? JSON.stringify(putAddr.address) : null,
        notes         ? String(notes).slice(0, 4000)         : null,
        putVisitNotes ? String(putVisitNotes).slice(0, 4000) : null,
        !!termsAccepted,
        termsVersionId,
        id,
      ]
    );

    if (callerPrivilegeForPut === 'member') {
      const opaqueKeys = [];
      for (const rm of rooms) {
        for (const img of (Array.isArray(rm.images) ? rm.images : [])) {
          const raw = String(img.storageKey || img.storage_key || img.url || '');
          if (dvUploads.isOpaqueKey(raw)) opaqueKeys.push(raw);
        }
      }
      if (opaqueKeys.length) {
        const owned = await client.query(
          `SELECT storage_key FROM survey_visit_pending_uploads
           WHERE storage_key = ANY($1) AND created_by = $2
           UNION
           SELECT svri.storage_key
           FROM survey_visit_room_images svri
           JOIN survey_visit_rooms svr ON svr.id = svri.room_id
           JOIN survey_visits sv       ON sv.id  = svr.survey_visit_id
           WHERE svri.storage_key = ANY($1) AND sv.created_by = $2`,
          [opaqueKeys, String(userId)],
        );
        const ownedSet = new Set(owned.rows.map(r => r.storage_key));
        const foreign = opaqueKeys.filter(k => !ownedSet.has(k));
        if (foreign.length) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'Forbidden: one or more image keys were not uploaded by this user' });
        }
      }
    }

    // Replace all rooms (cascades to images)
    await client.query(`DELETE FROM survey_visit_rooms WHERE survey_visit_id=$1`, [id]);

    const collectedRoomAnswers = [];
    for (let i = 0; i < rooms.length; i++) {
      const rm = rooms[i];
      const rr = await client.query(`
        INSERT INTO survey_visit_rooms
          (survey_visit_id, source_design_visit_room_id, room_name, door_style_id, width_mm, height_mm, depth_mm,
           unit_count, unit_price_pence, notes, sort_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING id`,
        [
          id,
          rm.sourceDesignVisitRoomId || rm.source_design_visit_room_id
            ? parseInt(rm.sourceDesignVisitRoomId || rm.source_design_visit_room_id, 10) || null : null,
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
      if (Array.isArray(rm.answers)) {
        for (const a of rm.answers) {
          if (a && a.question_id != null) {
            collectedRoomAnswers.push({ question_id: a.question_id, room_id: roomId, answer: a.answer });
          }
        }
      }
      const images = Array.isArray(rm.images) ? rm.images : [];
      const MAX_IMG_BYTES = 10 * 1024 * 1024;
      for (const img of images) {
        const raw = String(img.storageKey || img.storage_key || img.url || '');
        if (!raw) continue;
        const isOpaque    = dvUploads.isOpaqueKey(raw);
        const isDataImage = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i.test(raw);
        const isHttpUrl   = /^https?:\/\//i.test(raw);
        const isAppPath   = raw.startsWith('/');
        if (!isOpaque && !isDataImage && !isHttpUrl && !isAppPath) continue;
        if (raw.length > MAX_IMG_BYTES) continue;
        await client.query(
          `INSERT INTO survey_visit_room_images (room_id, storage_key, mime_type) VALUES ($1,$2,$3)`,
          [roomId, raw, img.mimeType || img.mime_type || null]
        );
      }
    }

    await client.query('COMMIT');

    const hasVisitAnswers = Array.isArray(answers);
    if (hasVisitAnswers || collectedRoomAnswers.length) {
      const visitAnswers = hasVisitAnswers
        ? answers.map(a => ({ question_id: a.question_id, room_id: null, answer: a.answer }))
        : [];
      const combinedAnswers = [...visitAnswers, ...collectedRoomAnswers];
      try {
        await saveAnswers('survey', id, combinedAnswers);
      } catch (e) {
        logger.error({ err: e.message }, '[survey-visits] saveAnswers (update) error:');
      }
    }

    try {
      await submitSurveyVisitAndSync(id, handlerConfig || {}, req.user);
    } catch (e) {
      logger.error({ err: e.message }, '[survey-visits] Side effect chain error on PUT:');
    }

    res.json({ ok: true, surveyVisitId: id });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err: e.message }, '[survey-visits] PUT /api/survey-visits/:id error:');
    res.status(500).json({ error: 'Could not update survey visit.' });
  } finally {
    client.release();
  }
});

// Best-effort delete of the cloud / local object backing a survey-visit room
// image. Mirrors the design-visit helper. Failures are logged and swallowed.
function _bestEffortDeleteSurveyVisitStorageObject(storageKey) {
  const keyPreview = String(storageKey || '').slice(0, 80);
  try {
    if (!storageKey || typeof storageKey !== 'string') {
      logger.info(`[survey-visits] storage delete skip (empty key)`);
      return;
    }
    if (/^data:/i.test(storageKey)) {
      logger.info(`[survey-visits] storage delete skip (inline data URI) key=${keyPreview}`);
      return;
    }
    if (/^https?:\/\//i.test(storageKey)) {
      logger.info(`[survey-visits] storage delete skip (external url) key=${keyPreview}`);
      return;
    }
    if (storageKey.startsWith('/uploads/')) {
      const rel = storageKey.replace(/^\/+/, '');
      const filePath = path.join(__dirname, 'public', rel);
      const resolved = path.resolve(filePath);
      const uploadsRoot = path.resolve(path.join(__dirname, 'public', 'uploads'));
      if (!resolved.startsWith(uploadsRoot + path.sep)) {
        logger.warn(`[survey-visits] storage delete refuse (path escapes uploads) key=${keyPreview}`);
        return;
      }
      fs.unlink(resolved, err => {
        if (err && err.code === 'ENOENT') {
          logger.info(`[survey-visits] storage delete skip (file missing) key=${keyPreview}`);
        } else if (err) {
          logger.warn(`[survey-visits] storage delete fail key=${keyPreview} err=${err.message}`);
        } else {
          logger.info(`[survey-visits] storage delete ok key=${keyPreview}`);
        }
      });
      return;
    }
    if (dvUploads.isOpaqueKey(storageKey)) {
      dvUploads.deleteOpaqueKey(storageKey).then(
        () => logger.info(`[survey-visits] storage delete ok (cloud) key=${keyPreview}`),
        err => logger.warn(`[survey-visits] storage delete fail (cloud) key=${keyPreview} err=${err.message}`)
      );
      return;
    }
    logger.info(`[survey-visits] storage delete skip (unrecognised key shape) key=${keyPreview}`);
  } catch (e) {
    logger.warn(`[survey-visits] storage delete fail key=${keyPreview} err=${e.message}`);
  }
}

router.delete('/api/survey-visits/:id', isAuthenticated, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    let storageKeys = [];
    try {
      const k = await pool.query(
        `SELECT svri.storage_key
           FROM survey_visit_room_images svri
           JOIN survey_visit_rooms svr ON svr.id = svri.room_id
          WHERE svr.survey_visit_id = $1`,
        [id]
      );
      storageKeys = k.rows.map(r => r.storage_key).filter(Boolean);
    } catch (lookupErr) {
      logger.warn({ err: lookupErr.message }, '[survey-visits] storage_key lookup failed before delete:');
    }

    const r = await pool.query(`DELETE FROM survey_visits WHERE id=$1 RETURNING id`, [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });

    for (const key of storageKeys) {
      _bestEffortDeleteSurveyVisitStorageObject(key);
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/survey-visits/:id/submit — re-run side effects on a draft visit
router.post('/api/survey-visits/:id/submit', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const userId = req.user?.claims?.sub;
  if (!checkSurveyVisitRateLimit(userId)) {
    return res.status(429).json({ error: 'Too many requests.' });
  }
  try {
    const vr = await pool.query(`SELECT status, created_by FROM survey_visits WHERE id=$1`, [id]);
    if (!vr.rows.length) return res.status(404).json({ error: 'Visit not found' });
    const callerPrivilege = getRequestPrivilegeLevel(req);
    if (callerPrivilege === 'member' && vr.rows[0].created_by !== String(userId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const status = vr.rows[0].status;
    if (status !== 'draft' && status !== 'revision_requested') {
      return res.status(400).json({ error: `Cannot submit from status: ${status}` });
    }
    await submitSurveyVisitAndSync(id, req.body?.handlerConfig || {}, req.user);
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e.message }, '[survey-visits] POST /api/survey-visits/:id/submit error:');
    res.status(500).json({ error: e.message });
  }
});

// POST /api/survey-visits/:id/revision — mark revision requested (admin only)
router.post('/api/survey-visits/:id/revision', isAuthenticated, requirePrivilege('admin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const rawNote = req.body?.revisionNote ?? req.body?.note;
  const note = rawNote ? String(rawNote).slice(0, 2000) : null;
  try {
    const r = await pool.query(`
      UPDATE survey_visits SET
        status='revision_requested',
        revision_note=$1,
        superseded_signoff_token_hashes = CASE WHEN signoff_token_hash IS NOT NULL
          THEN COALESCE(superseded_signoff_token_hashes, ARRAY[]::TEXT[]) || ARRAY[signoff_token_hash]
          ELSE superseded_signoff_token_hashes END,
        signoff_token_hash=NULL,
        updated_at=NOW()
      WHERE id=$2 AND status='submitted' RETURNING id`, [note, id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Visit not found or not in submitted status' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/survey-visits/refund — "Customer changed their mind" refund request.
// Available while the lead is SURVEY_SCHEDULED (before the wizard is opened, so
// no survey_visit row exists yet). Records the request as a survey_visits row
// (status='refund_requested'), emails the admin all details for manual
// QuickBooks processing, and sets the lead to DECLINED_DEAL. No automatic QB
// refund is performed. The lead-status change is only driven for manager/admin
// callers (the same restriction enforced across the submit pipeline); the
// record + admin email always happen.
router.post('/api/survey-visits/refund', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const userId = req.user?.claims?.sub;
  const {
    contactId, contactName, contactEmail, designVisitId,
    reason, amountPence, depositInvoiceRef, handlerConfig,
  } = req.body || {};
  if (!contactId) return res.status(400).json({ error: 'contactId is required' });
  const reasonText = reason ? String(reason).slice(0, 2000) : null;
  const refundEmail = req.user?.claims?.email || req.user?.email || String(userId);
  try {
    const ins = await pool.query(`
      INSERT INTO survey_visits
        (contact_id, contact_name, contact_email, created_by, design_visit_id, status,
         terms_accepted, refund_requested_at, refund_requested_by, refund_reason)
      VALUES ($1,$2,$3,$4,$5,'refund_requested',FALSE,NOW(),$6,$7)
      RETURNING id`,
      [
        String(contactId),
        contactName  ? String(contactName).slice(0, 300)  : null,
        contactEmail ? String(contactEmail).slice(0, 300) : null,
        String(userId),
        designVisitId ? parseInt(designVisitId, 10) || null : null,
        refundEmail,
        reasonText,
      ]
    );
    const refundId = ins.rows[0].id;

    // Set lead status to DECLINED_DEAL (manager/admin only — pipeline change).
    const callerPrivilege = getRequestPrivilegeLevel(req);
    const canEditPipeline = callerPrivilege === 'admin' || callerPrivilege === 'manager';
    if (canEditPipeline && getHubSpotCredential('access_token')) {
      try {
        await _patchContactProperties(String(contactId), { hs_lead_status: 'DECLINED_DEAL' });
      } catch (e) {
        logger.warn({ err: e.message }, '[survey-visits] refund lead status update failed:');
      }
    } else if (!canEditPipeline) {
      logger.info('[survey-visits] refund recorded but lead status change skipped (caller lacks pipeline privilege)');
    }

    // Notify admins (non-fatal) using the survey_refund_request email template
    // so the copy is admin-editable in the email-templates UI.
    try {
      const transport = createMailTransport();
      const admins = adminEmails();
      if (transport && admins.length) {
        const amountStr = amountPence != null && amountPence !== ''
          ? `£${penceToGbp(Math.max(0, parseInt(amountPence, 10) || 0))}` : '(not specified)';
        const dashboardUrl = `${appBaseUrl()}/customers/${contactId}`;
        const leadStatusNote = canEditPipeline
          ? 'Lead status set to DECLINED_DEAL.'
          : 'Lead status change skipped — requester lacks pipeline privilege; please update the lead manually.';
        const vars = {
          customerName:      contactName || '',
          contactId:         String(contactId),
          customerEmail:     contactEmail || '',
          designVisitRef:    designVisitId ? `#${designVisitId}` : '',
          depositInvoiceRef: depositInvoiceRef ? String(depositInvoiceRef) : '',
          refundAmount:      amountStr,
          reason:            reasonText || '(none)',
          requestedBy:       refundEmail,
          leadStatusNote,
          dashboardUrl,
        };
        const tmpl = await getEmailTemplate('survey_refund_request');
        const { subject, text, html } = renderEmail(tmpl, { textVars: vars, htmlVars: vars });
        await transport.sendMail({
          from: buildFromHeader(), replyTo: buildReplyTo(),
          to: admins.join(', '),
          subject, text, html,
        });
      }
    } catch (e) {
      logger.warn({ err: e.message }, '[survey-visits] refund admin email failed:');
    }

    res.status(201).json({ ok: true, refundId });
  } catch (e) {
    logger.error({ err: e.message }, '[survey-visits] POST /api/survey-visits/refund error:');
    res.status(500).json({ error: 'Could not record refund request.' });
  }
});

// ── Admin: resend sign-off email ─────────────────────────────────────────────
// POST /api/survey-visits/:id/resend-signoff
// Generates a fresh sign-off token, invalidates the previous one, and resends
// the customer sign-off email. Admin-only.
router.post('/api/survey-visits/:id/resend-signoff', isAuthenticated, requireAdmin, async (req, res) => {
  const visitId = parseInt(req.params.id, 10);
  if (!Number.isFinite(visitId)) return res.status(400).json({ error: 'Invalid visit id' });
  try {
    const vr = await pool.query(
      `SELECT sv.*, svh.name AS handle_name, svfr.name AS furniture_range_name
       FROM survey_visits sv
       LEFT JOIN catalog_handles   svh  ON svh.id  = sv.handle_id
       LEFT JOIN catalog_ranges    svfr ON svfr.id = sv.furniture_range_id
       WHERE sv.id = $1`, [visitId]
    );
    if (!vr.rows.length) return res.status(404).json({ error: 'Visit not found' });
    const visit = vr.rows[0];
    if (visit.status !== 'submitted') {
      return res.status(409).json({ error: 'Sign-off email can only be resent for submitted visits' });
    }
    if (!visit.contact_email) {
      return res.status(422).json({ error: 'Visit has no contact email address' });
    }

    // Generate fresh token and rotate the old one.
    const rawToken  = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await pool.query(`
      UPDATE survey_visits
      SET superseded_signoff_token_hashes = CASE WHEN signoff_token_hash IS NOT NULL
            THEN COALESCE(superseded_signoff_token_hashes, ARRAY[]::TEXT[]) || ARRAY[signoff_token_hash]
            ELSE superseded_signoff_token_hashes END,
          signoff_token_hash = $1,
          signoff_expires_at = $2,
          updated_at = NOW()
      WHERE id = $3`, [tokenHash, expiresAt.toISOString(), visitId]);

    // Load rooms for the email body.
    const rr = await pool.query(`
      SELECT svr.*, ds.name AS door_style_name
      FROM survey_visit_rooms svr
      LEFT JOIN catalog_door_styles ds ON ds.id = svr.door_style_id
      WHERE svr.survey_visit_id = $1
      ORDER BY svr.id`, [visitId]);
    const rooms = rr.rows;

    // Send customer sign-off email (non-fatal — token rotation already committed).
    const signOffUrl = `${appBaseUrl()}/survey-visit/sign-off?token=${rawToken}`;
    let emailSent = false;
    try {
      const transport = createMailTransport();
      if (transport) {
        const from      = buildFromHeader();
        const replyTo   = buildReplyTo();
        const firstName = (visit.contact_name || '').split(' ')[0] || 'there';
        const grandTotal = rooms.reduce((s, r) => s + r.unit_price_pence * r.unit_count, 0);
        const roomRows = rooms.map(r => {
          const total = r.unit_price_pence * r.unit_count;
          return `
          <tr>
            <td style="padding:8px 12px;border-top:1px solid #e5e7eb;">${_esc(r.room_name)}</td>
            <td style="padding:8px 12px;border-top:1px solid #e5e7eb;">${_esc(r.door_style_name || '—')}</td>
            <td style="padding:8px 12px;border-top:1px solid #e5e7eb;text-align:right;">£${penceToGbp(total)}</td>
          </tr>`;
        }).join('');
        const roomRowsText = rooms.map(r => {
          const total = r.unit_price_pence * r.unit_count;
          return `  ${r.room_name} (${r.door_style_name || '—'}): £${penceToGbp(total)}`;
        }).join('\n');
        await transport.sendMail({
          from, replyTo,
          to: visit.contact_email,
          subject: `Your survey visit — ${visit.contact_name || ''}`,
          text: [
            `Hi ${firstName},`,
            '',
            'Here\'s an updated link to view your survey summary and sign off.',
            '',
            '--- Room Breakdown ---',
            roomRowsText,
            '',
            `Estimate total: £${penceToGbp(grandTotal)}`,
            visit.visit_notes ? `\n--- Visit Notes ---\n${visit.visit_notes}` : '',
            '',
            'See Your Survey & Sign Off:',
            signOffUrl,
            '',
            'This link is personal to you and expires in 7 days.',
            'If you have questions, reply to this email.',
          ].join('\n'),
          html: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;color:#1f2937;max-width:600px;margin:0 auto;padding:24px;">
  <h1 style="font-size:1.4rem;margin-bottom:4px;">Your survey visit summary</h1>
  <p style="color:#6b7280;margin-top:0;">Hi ${_esc(firstName)},</p>
  <p>Here's an updated link to view your survey summary and sign off.</p>
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
  ${visit.visit_notes ? `<div style="margin:20px 0;padding:14px 16px;background:#f9fafb;border-left:3px solid #e5e7eb;border-radius:4px;">
    <p style="margin:0 0 6px;font-size:.8rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;">Visit Notes</p>
    <p style="margin:0;white-space:pre-line;font-size:.9rem;">${_esc(visit.visit_notes)}</p>
  </div>` : ''}
  <div style="text-align:center;margin:28px 0;">
    <a href="${signOffUrl}"
       style="display:inline-block;background:#8B2BFF;color:#fff;padding:14px 32px;
              border-radius:8px;text-decoration:none;font-weight:600;font-size:1rem;">
      See Your Survey &amp; Sign Off
    </a>
  </div>
  <p style="font-size:.82rem;color:#6b7280;">
    This link is personal to you and expires in 7 days.
    If you have questions, reply to this email.
  </p>
</body>
</html>`,
        });
        emailSent = true;
      }
    } catch (e) {
      logger.warn({ err: e.message }, '[survey-visits] resend sign-off email failed:');
    }

    res.json({
      ok: true,
      emailSent,
      expiresAt: expiresAt.toISOString(),
      signoff_expires_at: expiresAt.toISOString(),
      signoff_token_hash: tokenHash,
    });
  } catch (e) {
    logger.error({ err: e.message }, '[survey-visits] POST resend-signoff error:');
    res.status(500).json({ error: 'Could not resend sign-off email.' });
  }
});

// ── Public sign-off routes ────────────────────────────────────────────────────
// These are public — no isAuthenticated. Added to AUTH_WHITELIST in server.js.
router.get('/api/survey-visits/sign-off/:token', async (req, res) => {
  const rawToken = String(req.params.token || '').trim();
  if (!rawToken || rawToken.length > 200) return res.status(404).json({ error: 'Not found' });
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  try {
    const vr = await pool.query(`
      SELECT sv.id, sv.contact_name, sv.contact_email, sv.status,
             sv.signoff_expires_at, sv.visit_date, sv.location, sv.notes, sv.visit_notes,
             sv.terms_accepted, svh.name AS handle_name, svfr.name AS furniture_range_name
      FROM survey_visits sv
      LEFT JOIN catalog_handles               svh  ON svh.id  = sv.handle_id
      LEFT JOIN catalog_ranges                svfr ON svfr.id = sv.furniture_range_id
      WHERE sv.signoff_token_hash = $1`, [tokenHash]);
    if (!vr.rows.length) {
      const sup = await pool.query(
        `SELECT 1 FROM survey_visits WHERE $1 = ANY(superseded_signoff_token_hashes) LIMIT 1`,
        [tokenHash],
      );
      if (sup.rows.length) {
        return res.status(410).json({
          status: 'superseded',
          error: 'Your surveyor is currently making changes to this visit. A new link will be sent when it\'s ready for your approval.',
        });
      }
      return res.status(404).json({ error: 'Not found' });
    }
    const visit = vr.rows[0];
    if (visit.status !== 'submitted') return res.status(404).json({ error: 'Not found' });
    if (visit.signoff_expires_at && new Date() > new Date(visit.signoff_expires_at)) {
      return res.status(410).json({
        status: 'expired',
        error: 'This sign-off link has expired. Please contact us to receive a fresh link.',
        expiresAt: visit.signoff_expires_at,
      });
    }
    const rooms = await pool.query(`
      SELECT svr.id, svr.room_name, svr.width_mm, svr.height_mm, svr.depth_mm,
             svr.unit_count, svr.unit_price_pence, svr.notes,
             svds.name AS door_style_name
      FROM survey_visit_rooms svr
      LEFT JOIN catalog_doors            svds ON svds.id = svr.door_style_id
      WHERE svr.survey_visit_id = $1
      ORDER BY svr.sort_order ASC, svr.id ASC`, [visit.id]);
    const imagesRes = await pool.query(`
      SELECT svri.room_id, svri.storage_key, svri.mime_type
      FROM survey_visit_room_images svri
      JOIN survey_visit_rooms svr ON svr.id = svri.room_id
      WHERE svr.survey_visit_id = $1
      ORDER BY svri.id ASC`, [visit.id]);
    const imagesByRoom = {};
    for (const img of imagesRes.rows) {
      if (!imagesByRoom[img.room_id]) imagesByRoom[img.room_id] = [];
      imagesByRoom[img.room_id].push({
        storageKey: dvUploads.signImageUrl(img.storage_key),
        mimeType:   img.mime_type,
      });
    }
    let terms = '';
    let termsVersionNumber = null;
    try {
      const visitFull = await pool.query(
        `SELECT terms_condition_version_id FROM survey_visits WHERE id = $1`, [visit.id]
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
        const lv = await pool.query(
          `SELECT version_number, terms_text FROM terms_conditions_versions ORDER BY version_number DESC LIMIT 1`
        );
        if (lv.rows.length) {
          terms = lv.rows[0].terms_text;
          termsVersionNumber = lv.rows[0].version_number;
        }
      }
      if (!terms) {
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
      visitNotes:         visit.visit_notes || null,
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
        images:         imagesByRoom[r.id] || [],
      })),
      terms,
    });
  } catch (e) {
    logger.error({ err: e.message }, '[survey-visits] GET sign-off error:');
    res.status(500).json({ error: 'Could not load visit.' });
  }
});

router.post('/api/survey-visits/sign-off/:token', async (req, res) => {
  const rawToken = String(req.params.token || '').trim();
  if (!rawToken || rawToken.length > 200) return res.status(404).json({ error: 'Not found' });
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const action = String(req.body?.action || '').trim();
  if (!['approve', 'revision'].includes(action)) {
    return res.status(400).json({ error: 'action must be "approve" or "revision"' });
  }
  const note = req.body?.note ? String(req.body.note).slice(0, 2000) : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const vr = await client.query(`
      SELECT id, status, signoff_expires_at, contact_name, signoff_token_hash
      FROM survey_visits WHERE signoff_token_hash = $1 FOR UPDATE`, [tokenHash]);
    if (!vr.rows.length) {
      await client.query('ROLLBACK');
      const sup = await pool.query(
        `SELECT 1 FROM survey_visits WHERE $1 = ANY(superseded_signoff_token_hashes) LIMIT 1`,
        [tokenHash]
      );
      if (sup.rows.length) {
        return res.status(409).json({
          status: 'superseded',
          error: 'Your surveyor is currently making changes to this visit. A new link will be sent when it\'s ready for your approval.',
        });
      }
      return res.status(404).json({ error: 'Not found' });
    }
    const visit = vr.rows[0];
    if (visit.status !== 'submitted') {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }
    if (visit.signoff_expires_at && new Date() > new Date(visit.signoff_expires_at)) {
      await client.query('ROLLBACK');
      return res.status(410).json({
        status: 'expired',
        error: 'This sign-off link has expired. Please contact us to receive a fresh link.',
      });
    }
    if (action === 'approve') {
      await client.query(`
        UPDATE survey_visits SET status='signed_off', signed_off_at=NOW(),
          signoff_token_hash=NULL, updated_at=NOW()
        WHERE id=$1`, [visit.id]);
    } else {
      await client.query(`
        UPDATE survey_visits SET
          status='revision_requested',
          revision_note=$1,
          superseded_signoff_token_hashes = CASE WHEN signoff_token_hash IS NOT NULL
            THEN COALESCE(superseded_signoff_token_hashes, ARRAY[]::TEXT[]) || ARRAY[signoff_token_hash]
            ELSE superseded_signoff_token_hashes END,
          signoff_token_hash=NULL,
          updated_at=NOW()
        WHERE id=$2`, [note, visit.id]);
    }
    await client.query('COMMIT');
    try {
      const transport = createMailTransport();
      const admins = adminEmails();
      if (transport && admins.length) {
        if (action === 'approve') {
          await transport.sendMail({
            from: buildFromHeader(), replyTo: buildReplyTo(),
            to: admins.join(', '),
            subject: `Survey visit signed off — ${visit.contact_name || visit.id}`,
            text: `${visit.contact_name || 'The customer'} has approved and signed off their survey visit (#${visit.id}).`,
          });
        } else {
          await transport.sendMail({
            from: buildFromHeader(), replyTo: buildReplyTo(),
            to: admins.join(', '),
            subject: `Survey visit revision requested — ${visit.contact_name || visit.id}`,
            text: `${visit.contact_name || 'The customer'} has requested changes to survey visit #${visit.id}.\n\nNote: ${note || '(none)'}`,
          });
        }
      }
    } catch {}
    res.json({ success: true, status: action === 'approve' ? 'signed_off' : 'revision_requested' });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    logger.error({ err: e.message }, '[survey-visits] POST sign-off error:');
    res.status(500).json({ error: 'Could not process sign-off.' });
  } finally {
    client.release();
  }
});

// ── Cloud-storage image upload & signing ─────────────────────────────────────
// Survey photos share the same bucket as design-visit photos; serving is handled
// by the existing public GET /api/design-visit-images/:key route. Uploads are
// tracked in survey_visit_pending_uploads so the survey submit/PUT ownership
// checks can enforce per-uploader ownership.
router.post('/api/survey-visits/uploads', isAuthenticated, requirePrivilege('member'), express.json({ limit: '15mb' }), async (req, res) => {
  try {
    const dataUrl = String(req.body?.dataUrl || '');
    if (!dataUrl) return res.status(400).json({ error: 'dataUrl is required' });
    const out = await dvUploads.uploadFromDataUrl(dataUrl);
    const callerId = req.user?.claims?.sub;
    if (dvUploads.isOpaqueKey(out.storageKey)) {
      await pool.query(
        `INSERT INTO survey_visit_pending_uploads (storage_key, created_by)
         VALUES ($1, $2) ON CONFLICT (storage_key) DO NOTHING`,
        [out.storageKey, String(callerId)],
      ).catch(err => logger.warn({ err: err.message }, '[survey-visits] pending upload insert failed (non-fatal):'));
    }
    return res.json({
      storageKey: out.storageKey,
      mimeType:   out.mimeType,
      byteLength: out.byteLength,
      viewUrl:    dvUploads.signImageUrl(out.storageKey),
    });
  } catch (e) {
    const status = e.statusCode || 500;
    logger.warn({ err: e.message }, '[survey-visits] upload failed:');
    return res.status(status).json({ error: e.message || 'Upload failed' });
  }
});

router.post('/api/survey-visits/sign-image-urls', isAuthenticated, requirePrivilege('member'), express.json({ limit: '256kb' }), async (req, res) => {
  const keys = Array.isArray(req.body?.storageKeys) ? req.body.storageKeys : null;
  if (!keys) return res.status(400).json({ error: 'storageKeys array is required' });

  const opaqueKeys = keys.filter(k => typeof k === 'string' && dvUploads.isOpaqueKey(k));

  if (opaqueKeys.length > 0 && getRequestPrivilegeLevel(req) === 'member') {
    const userId = String(req.user?.claims?.sub ?? '');
    const owned = await pool.query(
      `SELECT storage_key FROM survey_visit_pending_uploads
       WHERE storage_key = ANY($1) AND created_by = $2
       UNION
       SELECT svri.storage_key
       FROM survey_visit_room_images svri
       JOIN survey_visit_rooms svr ON svr.id = svri.room_id
       JOIN survey_visits sv       ON sv.id  = svr.survey_visit_id
       WHERE svri.storage_key = ANY($1) AND sv.created_by = $2`,
      [opaqueKeys, userId],
    );
    const ownedSet = new Set(owned.rows.map(r => r.storage_key));
    const foreign = opaqueKeys.filter(k => !ownedSet.has(k));
    if (foreign.length) {
      return res.status(403).json({ error: 'Forbidden: one or more image keys are not accessible to this user' });
    }
  }

  const urls = {};
  for (const k of opaqueKeys) {
    urls[k] = dvUploads.signImageUrl(k);
  }
  return res.json({ urls });
});

router.delete('/api/survey-visits/uploads/:storageKey', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const key = String(req.params.storageKey || '');
  if (!dvUploads.isOpaqueKey(key)) {
    return res.status(204).send();
  }
  const callerPrivilege = getRequestPrivilegeLevel(req);
  if (callerPrivilege === 'member') {
    const callerId = String(req.user?.claims?.sub);
    try {
      const pending = await pool.query(
        `SELECT 1 FROM survey_visit_pending_uploads WHERE storage_key=$1 AND created_by=$2`,
        [key, callerId],
      );
      if (!pending.rows.length) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    } catch (e) {
      logger.warn({ err: e.message }, '[survey-visits] upload ownership check failed:');
      return res.status(500).json({ error: 'Ownership check failed' });
    }
  }
  try {
    await dvUploads.deleteOpaqueKey(key);
    pool.query(`DELETE FROM survey_visit_pending_uploads WHERE storage_key=$1`, [key])
      .catch(err => logger.warn({ err: err.message }, '[survey-visits] pending upload cleanup failed (non-fatal):'));
    const kp = key.slice(0, 40);
    logger.info(`[survey-visits] upload delete ok key=${kp} user=${req.user?.email || '?'}`);
    return res.status(204).send();
  } catch (e) {
    logger.warn({ err: e.message }, '[survey-visits] upload delete failed:');
    return res.status(500).json({ error: 'Delete failed' });
  }
});

// ── Member: load/save answers for a survey visit ─────────────────────────────
// Shared questionnaire engine (visit_questions / visit_answers) with
// visit_type = 'survey'. The admin question CRUD + member question read routes
// are owned by design-visits.js and shared verbatim.
router.get('/api/survey-visits/:id/answers', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    res.json(await loadAnswers('survey', id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/survey-visits/:id/answers', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const payload = Array.isArray(req.body?.answers) ? req.body.answers : Array.isArray(req.body) ? req.body : null;
  if (!payload) return res.status(400).json({ error: 'answers array is required' });
  try {
    res.json(await saveAnswers('survey', id, payload));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Seed start_survey_visit handler + SURVEY stage bindings ───────────────────
// Ensures a start_survey_visit handler row exists and bindings for the survey
// stage statuses the wizard launches from:
//   (survey, 'survey_scheduled')   → "Start Survey Visit Wizard"
//   (survey, 'survey_in_progress') → (same handler, in-progress visits)
// Uses WHERE NOT EXISTS so admin-configured overrides are never clobbered.
// Idempotent — safe to call on every boot.
async function ensureStartSurveyVisitHandlerBindings() {
  let handlerId;
  const existing = await pool.query(
    `SELECT id FROM card_action_handlers WHERE type = 'start_survey_visit' ORDER BY id LIMIT 1`
  );
  if (existing.rows.length) {
    handlerId = existing.rows[0].id;
  } else {
    const ins = await pool.query(
      `INSERT INTO card_action_handlers (name, type, config)
       VALUES ('Start Survey Visit Wizard', 'start_survey_visit', '{}')
       RETURNING id`
    );
    handlerId = ins.rows[0].id;
  }

  const bindings = [
    { stage_key: 'survey', status_key: 'survey_scheduled' },
    { stage_key: 'survey', status_key: 'survey_in_progress' },
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

  logger.info('[card-action-seeds] start_survey_visit handler and bindings ensured.');
}

module.exports = {
  router: router,
  setPatchContactProperties,
  ensureStartSurveyVisitHandlerBindings,
  submitSurveyVisitAndSync,
};
