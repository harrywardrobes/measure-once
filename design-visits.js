// design-visits.js — start_design_visit card action handler
// DB tables, admin catalogue routes, design visit CRUD, public sign-off routes.

const logger = require('./logger');
const express   = require('express');
const crypto    = require('crypto');
const axios     = require('axios').create({ timeout: 12000 });
const { Pool }  = require('pg');
const nodemailer = require('nodemailer');
const path      = require('path');
const fs        = require('fs');
const multer    = require('multer');
const { isAuthenticated, requireAdmin, requirePrivilege, getRequestPrivilegeLevel } = require('./auth');
const dvUploads = require('./design-visit-uploads');
const { getCredential: getHubSpotCredential } = require('./hubspot-creds');
const {
  structuredAddressSchema, hubspotToAddress, formatAddress, isAddressEmpty,
} = require('./shared/address.cjs');

// Normalises a design-visit address from the request body. Prefers the new
// structured object; falls back to wrapping a legacy free-text `location`
// string as a single address line. Returns { address, location } where
// `location` is the single-line formatAddress() rendering persisted to the
// legacy column for list/email read-fallback. Returns { error } on a malformed
// structured object.
function resolveDesignVisitAddress(structuredAddress, location) {
  if (structuredAddress !== undefined && structuredAddress !== null) {
    const parsed = structuredAddressSchema.safeParse(structuredAddress);
    if (!parsed.success) return { error: 'Invalid address.' };
    const address = isAddressEmpty(parsed.data) ? null : parsed.data;
    return { address, location: address ? formatAddress(address).replace(/\n/g, ', ') : null };
  }
  // Legacy path: wrap the free-text location string as a single address line.
  const loc = location ? String(location).trim() : '';
  if (!loc) return { address: null, location: null };
  const address = { addressLines: [loc.slice(0, 500)], countryCode: 'GB' };
  return { address, location: loc.slice(0, 500) };
}

let _patchContactProperties = async (_contactId, _props) => {
  logger.warn('[design-visits] patchContactProperties called before wiring — HubSpot PATCH skipped');
};
function setPatchContactProperties(fn) { _patchContactProperties = fn; }

// ── Catalogue image infra ─────────────────────────────────────────────────────
// Generic per-subdirectory image upload + local-file cleanup, shared by every
// catalogue table (handles, doors, finishes, ranges). The `door-styles` subdir
// name is preserved so existing door image URLs keep resolving after the
// design_visit_* -> catalog_* migration.
function makeCatalogImageInfra(subdir) {
  const uploadDir = path.join(__dirname, 'public', 'uploads', subdir);
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
  const urlPrefix = `/uploads/${subdir}/`;
  const matcher = new RegExp(`^/uploads/${subdir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^/\\\\]+)$`);

  function deleteLocal(imageUrl) {
    if (!imageUrl || typeof imageUrl !== 'string') return;
    const m = imageUrl.match(matcher);
    if (!m) return;
    const filename = m[1];
    if (filename === '.' || filename === '..') return;
    const resolved = path.resolve(path.join(uploadDir, filename));
    if (path.dirname(resolved) !== path.resolve(uploadDir)) return;
    fs.unlink(resolved, err => {
      if (err && err.code !== 'ENOENT') {
        logger.warn({ detail: resolved, err: err.message }, `[design-visits] Failed to delete ${subdir} image`);
      }
    });
  }

  const fileFilter = (_req, file, cb) => {
    if (/^image\//i.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  };
  const limits = { fileSize: 5 * 1024 * 1024 };

  const idStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const id  = parseInt(req.params.id, 10);
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg';
      cb(null, `${id}-${Date.now()}${ext}`);
    },
  });
  const preStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg';
      cb(null, `pre-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  });

  return {
    uploadDir, urlPrefix, deleteLocal,
    idUpload:  multer({ storage: idStorage,  limits, fileFilter }),
    preUpload: multer({ storage: preStorage, limits, fileFilter }),
  };
}

const CATALOG_IMG = {
  handles:  makeCatalogImageInfra('handles'),
  doors:    makeCatalogImageInfra('door-styles'),
  finishes: makeCatalogImageInfra('finishes'),
  ranges:   makeCatalogImageInfra('ranges'),
};

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
  // Test-only override so the integration suite can capture sendMail payloads
  // without standing up a real SMTP server. When set, returns a fake transport
  // that appends each JSON-serialised message to the named file. Never set in
  // production.
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
        logger.warn('[design-visits/hubspot-retry] attempt=%d status=%s backoff=%dms endpoint=%s %s', attempt + 1, err.response?.status || 'network', backoff, method.toUpperCase(), url);
      }
      await sleep(backoff);
    }
  }
  const base = hubspotApiBase();
  const shortUrl = url.startsWith(base) ? url.slice(base.length) : url;
  logger.error('[design-visits/hubspot-retry] all %d attempts exhausted endpoint=%s %s finalStatus=%s', maxAttempts, method.toUpperCase(), shortUrl, lastErr?.response?.status || 'network');
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
const DESIGN_VISIT_RATE_WINDOW_MS = 10 * 60 * 1000;
const DESIGN_VISIT_RATE_LIMIT     = 20;
const _designVisitRateMap = new Map();
function checkDesignVisitRateLimit(userId) {
  const now = Date.now();
  const cutoff = now - DESIGN_VISIT_RATE_WINDOW_MS;
  const ts = (_designVisitRateMap.get(userId) || []).filter(t => t > cutoff);
  if (ts.length >= DESIGN_VISIT_RATE_LIMIT) return false;
  ts.push(now);
  _designVisitRateMap.set(userId, ts);
  return true;
}

// ── DB schema ─────────────────────────────────────────────────────────────────
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
    LEFT JOIN catalog_handles               dvh  ON dvh.id  = dv.handle_id
    LEFT JOIN catalog_ranges                dvfr ON dvfr.id = dv.furniture_range_id
    LEFT JOIN terms_conditions_versions     tcv  ON tcv.id  = dv.terms_condition_version_id
    WHERE dv.id = $1`, [id]);
  if (!vr.rows.length) return null;
  const visit = vr.rows[0];
  const rooms = await pool.query(`
    SELECT dvr.*, dvds.name AS door_style_name
    FROM design_visit_rooms dvr
    LEFT JOIN catalog_doors            dvds ON dvds.id = dvr.door_style_id
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
    // `storageKey` keeps the opaque DB key so the client can round-trip it
    // back on PUT; `viewUrl` is a short-lived signed URL the browser can
    // load directly (or the legacy URL/data URI for older rows).
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
  // Surface a camelCase structured address. Prefer the stored JSONB column;
  // fall back to wrapping the legacy single-line `location` for old rows.
  visit.structuredAddress = visit.structured_address
    || (visit.location ? { addressLines: [String(visit.location)], countryCode: 'GB' } : null);
  return visit;
}

// ── Format currency helper ────────────────────────────────────────────────────
function penceToGbp(pence) {
  return (pence / 100).toFixed(2);
}

// ── Side-effect chain: submit visit ──────────────────────────────────────────

/**
 * Orchestrate all side effects that occur when a design visit is submitted
 * (or resubmitted after a revision request).
 *
 * Steps performed in order — steps 2–5 are non-fatal and log warnings on
 * failure rather than aborting the submission:
 *
 * 1. **Database update** (fatal) — sets `status = 'submitted'`, rotates the
 *    public sign-off token (archiving any prior token hash into
 *    `superseded_signoff_token_hashes`), and records the new expiry.
 * 2. **HubSpot lead status** (non-fatal) — if `handlerConfig.submittedLeadStatus`
 *    is set and the submitter is a manager or admin, updates the contact's
 *    `hs_lead_status` property in HubSpot.
 * 3. **HubSpot note** (non-fatal) — creates a CRM note summarising the visit
 *    (designer, handle, furniture range, visit date, room breakdown) and
 *    associates it with the contact.
 * 4. **QuickBooks estimate** (non-fatal) — creates a new QB estimate from the
 *    visit's room pricing, or sparse-updates the existing estimate if one is
 *    already on file and still editable. If the prior estimate cannot be
 *    updated the old id is appended to `qb_estimate_history` and a new one
 *    is created.
 * 5. **Sign-off email** (non-fatal) — sends the customer a sign-off link
 *    email containing the newly issued token.
 *
 * This function is idempotent across resubmissions: calling it on an already-
 * submitted visit replaces the sign-off token and re-runs the side-effect
 * chain without duplicating the QB estimate where avoidable.
 *
 * @param {string | number} visitId - Primary key of the design visit to submit.
 * @param {object} handlerConfig - Caller-supplied configuration object.
 *   @param {string} [handlerConfig.submittedLeadStatus] - HubSpot lead status
 *     value to apply on submission. Only honoured for manager/admin submitters.
 * @param {object} submitterUser - The authenticated user performing the
 *   submission (typically `req.user`). Used to check pipeline-edit privilege
 *   and to populate the HubSpot note's designer field.
 * @returns {Promise<void>}
 * @throws {Error} If the visit cannot be found in the database.
 */
async function submitDesignVisitAndSync(visitId, handlerConfig, submitterUser) {
  const visit = await loadVisitWithRooms(visitId);
  if (!visit) throw new Error('Visit not found');

  // 1. Update status to submitted
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  // If a previous sign-off token exists on this visit (e.g. designer re-opening
  // a submitted visit via POST /:id/submit), remember its hash so the public
  // sign-off route can recognise the stale link and explain the situation
  // instead of returning a generic 404.
  await pool.query(`
    UPDATE design_visits
    SET status = 'submitted',
        superseded_signoff_token_hashes = CASE WHEN signoff_token_hash IS NOT NULL
          AND signoff_token_hash <> $1
          THEN COALESCE(superseded_signoff_token_hashes, ARRAY[]::TEXT[]) || ARRAY[signoff_token_hash]
          ELSE superseded_signoff_token_hashes END,
        signoff_token_hash = $1,
        signoff_expires_at = $2,
        updated_at = NOW()
    WHERE id = $3`, [tokenHash, expiresAt.toISOString(), visitId]);

  // 2. HubSpot lead status update (non-fatal)
  // Only manager/admin users may drive pipeline changes through this path —
  // the same restriction enforced by PATCH /api/contacts/:id for direct updates.
  const submitterPrivilege = submitterUser?.privilege_level || 'member'; // privilege-read-ok: checking the submitter's privilege, not the current request user's
  const submitterCanEditPipeline = submitterPrivilege === 'admin' || submitterPrivilege === 'manager';
  const submittedLeadStatus = submitterCanEditPipeline ? handlerConfig?.submittedLeadStatus : null;
  if (submittedLeadStatus && getHubSpotCredential('access_token') && visit.contact_id) {
    try {
      await _patchContactProperties(visit.contact_id, { hs_lead_status: submittedLeadStatus });
    } catch (e) {
      logger.warn({ err: e.message }, '[design-visits] HubSpot lead status update failed:');
    }
  }

  // 3. HubSpot note (non-fatal)
  if (getHubSpotCredential('access_token') && visit.contact_id) {
    try {
      const roomLines = (visit.rooms || []).map(r =>
        `  • ${r.room_name}: ${r.unit_count} unit(s) @ £${penceToGbp(r.unit_price_pence)} each`
      ).join('\n');
      const noteBody = [
        `Design visit submitted`,
        `Designer: ${submitterUser?.claims?.email || submitterUser?.email || 'unknown'}`,
        visit.handle_name         ? `Handle: ${visit.handle_name}` : null,
        visit.furniture_range_name ? `Furniture range: ${visit.furniture_range_name}` : null,
        visit.visit_date          ? `Visit date: ${new Date(visit.visit_date).toLocaleString()}` : null,
        roomLines ? `Rooms:\n${roomLines}` : null,
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
      logger.warn({ err: e.message }, '[design-visits] HubSpot note creation failed:');
    }
  }

  // 4. QuickBooks Estimate (non-fatal)
  //
  // If this visit already has a `qb_estimate_id`, attempt a sparse update so we
  // edit the existing estimate in QuickBooks rather than orphaning it with a
  // duplicate. Re-opened visits (revision_requested → resubmit) keep the same
  // estimate id and doc number. If the prior estimate cannot be updated
  // (accepted/closed/rejected, voided, deleted, or otherwise unreachable),
  // fall back to creating a new one and append the old id to
  // `qb_estimate_history` for audit.
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

      // Try sparse-update path if we already have an estimate on file.
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
          // "Pending" is the only freely-editable state. Accepted / Closed /
          // Rejected estimates (and anything else QB hands back) should not be
          // mutated — fall through to creating a replacement.
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
                `UPDATE design_visits SET qb_estimate_id = $1, qb_estimate_doc_num = $2, updated_at = NOW() WHERE id = $3`,
                [est.Id, est.DocNumber || null, visitId]
              );
              updated = true;
            }
          } else {
            logger.warn(`[design-visits] QB estimate ${priorId} not updatable (TxnStatus=${existing?.TxnStatus || 'unknown'}); creating replacement.`);
          }
        } catch (e) {
          // 404 / deleted / voided / token issue — fall back to create.
          logger.warn(`[design-visits] QB estimate ${priorId} fetch/update failed (${e.response?.status || ''} ${e.message}); creating replacement.`);
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
          // If we are replacing an old estimate, append the old id to the
          // audit history so finance can see the orphaned record.
          if (priorId && priorId !== est.Id) {
            // Non-fatal: mark the superseded estimate as Rejected in QuickBooks
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
              logger.warn(`[design-visits] Could not mark superseded estimate ${priorId} as Rejected in QB: ${_rejErr.message}`);
            }
            await pool.query(
              `UPDATE design_visits
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
              `UPDATE design_visits SET qb_estimate_id = $1, qb_estimate_doc_num = $2, updated_at = NOW() WHERE id = $3`,
              [est.Id, est.DocNumber || null, visitId]
            );
          }
        }
      }
    }
  } catch (e) {
    logger.warn({ err: e.message }, '[design-visits] QuickBooks estimate sync failed:');
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
    logger.warn({ err: e.message }, '[design-visits] Customer email send failed:');
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
          `Design visit submitted by ${submitterUser?.claims?.email || submitterUser?.email || 'unknown'}`,
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
    logger.warn({ err: e.message }, '[design-visits] Team notification email failed:');
  }

  return { rawToken, expiresAt };
}

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Shared catalogue CRUD (handles / doors / finishes / ranges) ───────────────
// Generic CRUD + image-upload routes mounted under /api/admin/catalog/<slug>.
// Every catalogue table shares the same column set (plus a per-table extra such
// as the handle `style`), so one factory wires them up consistently.

const HANDLE_STYLE_VALUES = ['Cup', 'Bar', 'Knob', 'Pull', 'Finger Pull', 'Other'];

// Optional string columns common to every catalogue table, with max lengths.
const CATALOG_TEXT_COLS = {
  description:   500,
  image_url:     500,
  supplier_name: 200,
  supplier_code: 100,
  notes:         2000,
  colour:        100,
  finish:        100,
  material_type: 100,
};
const CATALOG_INT_COLS = ['sort_order', 'price_pence'];

// Build INSERT column/value lists from a create body for the shared columns.
function catalogInsertFields(body, extraCols) {
  const cols = [], vals = [];
  for (const [col, max] of Object.entries(CATALOG_TEXT_COLS)) {
    if (body?.[col] !== undefined) {
      cols.push(col);
      vals.push(body[col] === null || body[col] === '' ? null : String(body[col]).slice(0, max));
    }
  }
  for (const col of CATALOG_INT_COLS) {
    if (body?.[col] !== undefined) { cols.push(col); vals.push(parseInt(body[col], 10) || 0); }
  }
  for (const col of extraCols) {
    if (body?.[col] !== undefined) {
      cols.push(col);
      vals.push(body[col] === null || body[col] === '' ? null : String(body[col]).trim());
    }
  }
  return { cols, vals };
}

// Build UPDATE SET fragments + values from a patch body for the shared columns.
// Returns a fresh { sets, vals } pair; the caller prepends name first and then
// renumbers the placeholders sequentially.
function catalogUpdateFields(body, extraCols) {
  const sets = [];
  const vals = [];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  for (const [col, max] of Object.entries(CATALOG_TEXT_COLS)) {
    if (body?.[col] !== undefined) add(col, body[col] === null || body[col] === '' ? null : String(body[col]).slice(0, max));
  }
  for (const col of CATALOG_INT_COLS) {
    if (body?.[col] !== undefined) add(col, parseInt(body[col], 10) || 0);
  }
  for (const col of extraCols) {
    if (body?.[col] !== undefined) add(col, body[col] === null || body[col] === '' ? null : String(body[col]).trim());
  }
  return { sets, vals };
}

function mountCatalogCrud(slug, table, opts = {}) {
  const img = opts.imgKey ? CATALOG_IMG[opts.imgKey] : null;
  const extraCols = opts.extraCols || [];
  const validate = opts.validate || (() => null);
  const base = `/api/admin/catalog/${slug}`;

  router.get(base, isAuthenticated, requireAdmin, async (req, res) => {
    try {
      const r = await pool.query(`SELECT * FROM ${table} ORDER BY sort_order ASC, id ASC`);
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post(base, isAuthenticated, requireAdmin, async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const verr = validate(req.body, true);
    if (verr) return res.status(400).json({ error: verr });
    const { cols, vals } = catalogInsertFields(req.body, extraCols);
    const allCols = ['name', ...cols];
    const allVals = [name, ...vals];
    const placeholders = allVals.map((_, i) => `$${i + 1}`).join(', ');
    try {
      const r = await pool.query(
        `INSERT INTO ${table} (${allCols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
        allVals,
      );
      res.status(201).json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.patch(`${base}/:id`, isAuthenticated, requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    if (req.body?.name !== undefined && !String(req.body.name).trim()) {
      return res.status(400).json({ error: 'name cannot be empty' });
    }
    const verr = validate(req.body, false);
    if (verr) return res.status(400).json({ error: verr });
    const { sets, vals } = catalogUpdateFields(req.body, extraCols);
    if (req.body?.name !== undefined) { vals.unshift(String(req.body.name).trim()); sets.unshift('name = $0'); }
    try {
      const oldImg = (img && req.body?.image_url !== undefined)
        ? (await pool.query(`SELECT image_url FROM ${table} WHERE id=$1`, [id])).rows[0]?.image_url ?? null
        : null;
      if (!sets.length) {
        const cur = await pool.query(`SELECT * FROM ${table} WHERE id=$1`, [id]);
        if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
        return res.json(cur.rows[0]);
      }
      // Re-number placeholders sequentially (name was unshifted with a $0 marker).
      let n = 0;
      const renumbered = sets.map(s => s.replace(/\$\d+/, () => `$${++n}`));
      vals.push(id);
      const r = await pool.query(
        `UPDATE ${table} SET ${renumbered.join(', ')}, updated_at = NOW() WHERE id = $${vals.length} RETURNING *`,
        vals,
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
      if (img && oldImg && req.body.image_url && oldImg !== req.body.image_url) img.deleteLocal(oldImg);
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete(`${base}/:id`, isAuthenticated, requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    try {
      const r = await pool.query(`DELETE FROM ${table} WHERE id=$1 RETURNING *`, [id]);
      if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
      if (img) img.deleteLocal(r.rows[0].image_url);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  if (img) {
    // Pre-create upload (no id yet) — returns a URL to attach on save.
    router.post(`${base}/upload-image`, isAuthenticated, requireAdmin,
      (req, res, next) => img.preUpload.single('image')(req, res, err => {
        if (err) return res.status(400).json({ error: err.message });
        next();
      }),
      (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'No image file provided' });
        res.json({ url: `${img.urlPrefix}${req.file.filename}` });
      },
    );
    // Upload + attach to an existing row.
    router.post(`${base}/:id/image`, isAuthenticated, requireAdmin,
      (req, res, next) => img.idUpload.single('image')(req, res, err => {
        if (err) return res.status(400).json({ error: err.message });
        next();
      }),
      async (req, res) => {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
        if (!req.file) return res.status(400).json({ error: 'No image file provided' });
        const image_url = `${img.urlPrefix}${req.file.filename}`;
        try {
          const existing = await pool.query(`SELECT image_url FROM ${table} WHERE id=$1`, [id]);
          if (!existing.rows.length) { fs.unlink(req.file.path, () => {}); return res.status(404).json({ error: 'Not found' }); }
          const oldImg = existing.rows[0].image_url;
          const r = await pool.query(`UPDATE ${table} SET image_url=$1, updated_at=NOW() WHERE id=$2 RETURNING *`, [image_url, id]);
          if (!r.rows.length) { fs.unlink(req.file.path, () => {}); return res.status(404).json({ error: 'Not found' }); }
          if (oldImg && oldImg !== image_url) img.deleteLocal(oldImg);
          res.json({ image_url });
        } catch (e) { fs.unlink(req.file.path, () => {}); res.status(500).json({ error: e.message }); }
      },
    );
  }
}

function validateHandleStyle(body, isCreate) {
  if (isCreate) {
    const styleRaw = body?.style !== undefined && body?.style !== null ? String(body.style).trim() : '';
    if (!styleRaw) return 'style is required';
    if (!HANDLE_STYLE_VALUES.includes(styleRaw)) return `style must be one of: ${HANDLE_STYLE_VALUES.join(', ')}`;
    return null;
  }
  if (body?.style !== undefined && body.style !== null && body.style !== '') {
    if (!HANDLE_STYLE_VALUES.includes(String(body.style).trim())) return `style must be one of: ${HANDLE_STYLE_VALUES.join(', ')}`;
  }
  return null;
}

mountCatalogCrud('handles',  'catalog_handles',  { imgKey: 'handles',  extraCols: ['style'], validate: validateHandleStyle });
mountCatalogCrud('doors',    'catalog_doors',    { imgKey: 'doors' });
mountCatalogCrud('finishes', 'catalog_finishes', { imgKey: 'finishes' });
mountCatalogCrud('ranges',   'catalog_ranges',   { imgKey: 'ranges' });

// ── Admin: catalogue pairings (door -> suggested handle/finish) ───────────────
router.get('/api/admin/catalog/pairings', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM catalog_pairings ORDER BY sort_order ASC, id ASC`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/admin/catalog/pairings', isAuthenticated, requireAdmin, async (req, res) => {
  const doorId = parseInt(req.body?.door_id, 10);
  if (!Number.isFinite(doorId)) return res.status(400).json({ error: 'door_id is required' });
  const handleId = req.body?.handle_id != null && req.body.handle_id !== '' ? parseInt(req.body.handle_id, 10) : null;
  const finishId = req.body?.finish_id != null && req.body.finish_id !== '' ? parseInt(req.body.finish_id, 10) : null;
  const sortOrder = parseInt(req.body?.sort_order, 10) || 0;
  const notes = req.body?.notes ? String(req.body.notes).slice(0, 2000) : null;
  try {
    const r = await pool.query(
      `INSERT INTO catalog_pairings (door_id, handle_id, finish_id, sort_order, notes)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [doorId, handleId, finishId, sortOrder, notes],
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/api/admin/catalog/pairings/:id', isAuthenticated, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const sets = [], vals = [];
  const add = (c, v) => { vals.push(v); sets.push(`${c} = $${vals.length}`); };
  if (req.body?.door_id !== undefined)   add('door_id', parseInt(req.body.door_id, 10));
  if (req.body?.handle_id !== undefined) add('handle_id', req.body.handle_id != null && req.body.handle_id !== '' ? parseInt(req.body.handle_id, 10) : null);
  if (req.body?.finish_id !== undefined) add('finish_id', req.body.finish_id != null && req.body.finish_id !== '' ? parseInt(req.body.finish_id, 10) : null);
  if (req.body?.sort_order !== undefined) add('sort_order', parseInt(req.body.sort_order, 10) || 0);
  if (req.body?.notes !== undefined)      add('notes', req.body.notes ? String(req.body.notes).slice(0, 2000) : null);
  if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
  vals.push(id);
  try {
    const r = await pool.query(`UPDATE catalog_pairings SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length} RETURNING *`, vals);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/api/admin/catalog/pairings/:id', isAuthenticated, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const r = await pool.query(`DELETE FROM catalog_pairings WHERE id=$1 RETURNING id`, [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Legacy admin catalogue route aliases (308 redirects) ──────────────────────
// TODO remove after migration
function catalogAdminAlias(legacyPrefix, newPrefix) {
  router.all([legacyPrefix, `${legacyPrefix}/*`], isAuthenticated, requireAdmin, (req, res) => {
    const rest = req.params[0] ? `/${req.params[0]}` : '';
    res.redirect(308, `${newPrefix}${rest}`);
  });
}
catalogAdminAlias('/api/admin/design-visit-handles',          '/api/admin/catalog/handles');  // TODO remove after migration
catalogAdminAlias('/api/admin/design-visit-door-styles',      '/api/admin/catalog/doors');    // TODO remove after migration
catalogAdminAlias('/api/admin/design-visit-furniture-ranges', '/api/admin/catalog/ranges');   // TODO remove after migration
// Legacy existing-row handle image upload used a separate prefix. // TODO remove after migration
router.all('/api/admin/dv-handles/:id/image', isAuthenticated, requireAdmin, (req, res) => {
  res.redirect(308, `/api/admin/catalog/handles/${req.params.id}/image`);  // TODO remove after migration
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

// ── Public catalogue reads (for wizard — any authenticated user) ──────────────
function mountCatalogRead(slug, table, cols) {
  router.get(`/api/catalog/${slug}`, isAuthenticated, async (req, res) => {
    try {
      const r = await pool.query(`SELECT ${cols} FROM ${table} ORDER BY sort_order ASC, id ASC`);
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
mountCatalogRead('handles',  'catalog_handles',  'id, name, description, image_url, style, sort_order, colour, finish, material_type, price_pence');
mountCatalogRead('doors',    'catalog_doors',    'id, name, description, image_url, sort_order, colour, finish, material_type, price_pence');
mountCatalogRead('finishes', 'catalog_finishes', 'id, name, description, image_url, sort_order, colour, finish, material_type, price_pence');
mountCatalogRead('ranges',   'catalog_ranges',   'id, name, description, image_url, sort_order, colour, finish, material_type, price_pence');

// Member-facing pairings read (suggested handle/finish for a selected door).
router.get('/api/catalog/pairings', isAuthenticated, async (req, res) => {
  try {
    const doorId = req.query.door_id != null && req.query.door_id !== '' ? parseInt(req.query.door_id, 10) : null;
    const params = [];
    let where = '';
    if (doorId != null && Number.isFinite(doorId)) { params.push(doorId); where = 'WHERE door_id = $1'; }
    const r = await pool.query(
      `SELECT id, door_id, handle_id, finish_id, sort_order, notes FROM catalog_pairings ${where} ORDER BY sort_order ASC, id ASC`,
      params,
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Legacy member catalogue read aliases (308 redirects) ──────────────────────
// TODO remove after migration
router.get('/api/design-visit-handles',          isAuthenticated, (req, res) => res.redirect(308, '/api/catalog/handles'));  // TODO remove after migration
router.get('/api/design-visit-furniture-ranges', isAuthenticated, (req, res) => res.redirect(308, '/api/catalog/ranges'));   // TODO remove after migration
router.get('/api/design-visit-door-styles',      isAuthenticated, (req, res) => res.redirect(308, '/api/catalog/doors'));    // TODO remove after migration

// ── Design Visits: CRUD ───────────────────────────────────────────────────────
router.get('/api/design-visits', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  try {
    const contactId = req.query.contactId;
    const callerPrivilege = getRequestPrivilegeLevel(req);
    const isMemberOnly = callerPrivilege === 'member';
    const callerId = req.user?.claims?.sub;
    const conditions = [];
    const params = [];
    if (contactId !== undefined && contactId !== null && String(contactId).length) {
      params.push(String(contactId));
      conditions.push(`dv.contact_id = $${params.length}`);
    }
    // Members may only see their own visits; managers and admins see all.
    if (isMemberOnly) {
      params.push(String(callerId));
      conditions.push(`dv.created_by = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const r = await pool.query(`
      SELECT dv.*, dvh.name AS handle_name, dvfr.name AS furniture_range_name,
             tcv.version_number AS terms_version_number,
             COALESCE((
               SELECT SUM(dvr.unit_count * dvr.unit_price_pence)
               FROM design_visit_rooms dvr
               WHERE dvr.design_visit_id = dv.id
             ), 0) AS estimate_total_pence
      FROM design_visits dv
      LEFT JOIN catalog_handles               dvh  ON dvh.id  = dv.handle_id
      LEFT JOIN catalog_ranges                dvfr ON dvfr.id = dv.furniture_range_id
      LEFT JOIN terms_conditions_versions     tcv  ON tcv.id  = dv.terms_condition_version_id
      ${where}
      ORDER BY dv.created_at DESC LIMIT 500`, params);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/design-visits/in-progress', isAuthenticated, requirePrivilege('member'), async (req, res) => {
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
        `SELECT id, contact_id FROM design_visits
         WHERE contact_id = ANY($1) AND status = 'draft' AND created_by = $2
         ORDER BY created_at DESC`,
        [contactIds, String(callerId)],
      );
    } else {
      r = await pool.query(
        `SELECT id, contact_id FROM design_visits
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

router.get('/api/design-visits/deposit-invoices', isAuthenticated, requirePrivilege('member'), async (req, res) => {
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
        `SELECT DISTINCT ON (contact_id) contact_id, deposit_invoice_id, deposit_invoice_doc_num
           FROM design_visits
          WHERE contact_id = ANY($1)
            AND deposit_invoice_id IS NOT NULL
            AND created_by = $2
          ORDER BY contact_id, created_at DESC`,
        [contactIds, String(callerId)],
      );
    } else {
      r = await pool.query(
        `SELECT DISTINCT ON (contact_id) contact_id, deposit_invoice_id, deposit_invoice_doc_num
           FROM design_visits
          WHERE contact_id = ANY($1)
            AND deposit_invoice_id IS NOT NULL
          ORDER BY contact_id, created_at DESC`,
        [contactIds],
      );
    }
    res.json(r.rows.map(row => ({
      contactId:           row.contact_id,
      depositInvoiceId:    row.deposit_invoice_id,
      depositInvoiceDocNum: row.deposit_invoice_doc_num,
    })));
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
    // Members may only read their own visits; managers and admins may read all.
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

// Resolve a submitted room image into a durable storage key + mime type.
//
// Offline-captured photos arrive as inline `data:image/*;base64,…` URIs: while
// offline the client could not reach POST /api/design-visits/uploads, so it
// embedded the bytes directly in the (queued) submit. When that queued submit
// finally replays online we materialise those data URIs into proper object
// storage here, so an offline photo ends up identical to a normally-uploaded
// one. If object storage is unavailable we fall back to persisting the inline
// data URI (the legacy path the GET handler already serves) rather than drop
// the photo. Returns `null` for empty / invalid / oversized input.
async function resolveRoomImageForStorage(img) {
  const raw = String(img.storageKey || img.storage_key || img.url || '');
  if (!raw) return null;
  const isOpaque    = dvUploads.isOpaqueKey(raw);
  const isDataImage = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i.test(raw);
  const isHttpUrl   = /^https?:\/\//i.test(raw);
  const isAppPath   = raw.startsWith('/');
  if (!isOpaque && !isDataImage && !isHttpUrl && !isAppPath) return null;
  const MAX_IMG_BYTES = 10 * 1024 * 1024; // 10MB per image (string length)
  if (raw.length > MAX_IMG_BYTES) return null;
  if (isDataImage) {
    try {
      const up = await dvUploads.uploadFromDataUrl(raw);
      return { key: up.storageKey, mimeType: up.mimeType };
    } catch (e) {
      logger.warn({ err: e.message }, '[design-visits] inline image materialise failed; storing data URI inline');
      return { key: raw, mimeType: img.mimeType || img.mime_type || null };
    }
  }
  return { key: raw, mimeType: img.mimeType || img.mime_type || null };
}

// POST /api/design-visits — create + run full side-effect chain
router.post('/api/design-visits', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const userId = req.user?.claims?.sub;
  if (!checkDesignVisitRateLimit(userId)) {
    return res.status(429).json({ error: 'Too many requests. Please wait before submitting another design visit.' });
  }

  const {
    contactId, contactName, contactEmail,
    handleId, furnitureRangeId, visitDate, durationMin,
    structuredAddress, location, notes, termsAccepted, rooms = [],
    handlerConfig, answers,
  } = req.body;

  if (!contactId) return res.status(400).json({ error: 'contactId is required' });
  if (!Array.isArray(rooms) || !rooms.length) return res.status(400).json({ error: 'At least one room is required' });
  if (!termsAccepted) return res.status(400).json({ error: 'Terms and conditions must be accepted' });

  // Resolve the structured address (preferred) and keep the legacy `location`
  // column populated with a single-line rendering for list/email read-fallback.
  const createAddr = resolveDesignVisitAddress(structuredAddress, location);
  if (createAddr.error) return res.status(400).json({ error: createAddr.error });

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
         visit_date, duration_min, location, structured_address, notes, terms_accepted, terms_condition_version_id, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,'draft')
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
        createAddr.location,
        createAddr.address ? JSON.stringify(createAddr.address) : null,
        notes    ? String(notes).slice(0, 4000)   : null,
        !!termsAccepted,
        termsVersionId,
      ]
    );
    const visitId = vr.rows[0].id;

    // For member callers, verify they own every opaque cloud-storage key being
    // submitted. Keys must be present in design_visit_pending_uploads with
    // created_by matching the caller — this is the immutable record minted by
    // POST /api/design-visits/uploads. This prevents a member from attaching a
    // leaked foreign key to their visit and then using the DELETE endpoint to
    // destroy another user's object.
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
          `SELECT storage_key FROM design_visit_pending_uploads
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

    // Insert rooms. Room-scoped questionnaire answers travel inline with each
    // room (rm.answers); we tag them with the freshly-inserted room id here
    // because room DB ids are not stable across edits (rooms are fully replaced
    // on every save).
    const collectedRoomAnswers = [];
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
      if (Array.isArray(rm.answers)) {
        for (const a of rm.answers) {
          if (a && a.question_id != null) {
            collectedRoomAnswers.push({ question_id: a.question_id, room_id: roomId, answer: a.answer });
          }
        }
      }
      // Insert images. Accepts opaque cloud-storage keys (POST
      // /api/design-visits/uploads), inline data:image/* URIs from offline
      // capture (materialised into storage by the helper), http(s) URLs, or
      // server-relative paths; anything else (e.g. javascript: URIs) is dropped.
      const images = Array.isArray(rm.images) ? rm.images : [];
      for (const img of images) {
        const resolved = await resolveRoomImageForStorage(img);
        if (!resolved) continue;
        await client.query(
          `INSERT INTO design_visit_room_images (room_id, storage_key, mime_type) VALUES ($1,$2,$3)`,
          [roomId, resolved.key, resolved.mimeType]
        );
      }
    }

    await client.query('COMMIT');

    // Persist questionnaire answers carried inline with the submit so they
    // survive the offline queue: whole-visit answers (room_id null) plus the
    // per-room answers collected above. Non-fatal — a failure here must not lose
    // the saved visit.
    const visitAnswers = Array.isArray(answers)
      ? answers.map(a => ({ question_id: a.question_id, room_id: null, answer: a.answer }))
      : [];
    const combinedAnswers = [...visitAnswers, ...collectedRoomAnswers];
    if (combinedAnswers.length) {
      try {
        await saveAnswers('design', visitId, combinedAnswers);
      } catch (e) {
        logger.error({ err: e.message }, '[design-visits] saveAnswers (create) error:');
      }
    }

    // Run the full side-effect chain (status → submitted, HubSpot, QB, email).
    // Non-fatal integration failures are caught inside; we await so the DB
    // status transition to 'submitted' is guaranteed before we respond.
    try {
      await submitDesignVisitAndSync(visitId, handlerConfig || {}, req.user);
    } catch (e) {
      logger.error({ err: e.message }, '[design-visits] Side effect chain error:');
    }

    res.status(201).json({ ok: true, designVisitId: visitId });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err: e.message }, '[design-visits] POST /api/design-visits error:');
    res.status(500).json({ error: 'Could not save design visit.' });
  } finally {
    client.release();
  }
});

router.patch('/api/design-visits/:id', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const { structuredAddress, location, notes, visitDate, durationMin, handleId, furnitureRangeId } = req.body;
  try {
    // Resolve the address only when the caller supplied one (structured or
    // legacy). When neither is present, leave both columns untouched via COALESCE.
    let patchAddr = { address: undefined, location: undefined };
    if (structuredAddress !== undefined || location !== undefined) {
      patchAddr = resolveDesignVisitAddress(structuredAddress, location);
      if (patchAddr.error) return res.status(400).json({ error: patchAddr.error });
    }
    const callerPrivilege = getRequestPrivilegeLevel(req);
    const isMemberOnly = callerPrivilege === 'member';
    const callerId = req.user?.claims?.sub;
    // Members may only patch their own draft visits; managers and admins may patch any.
    const ownerClause = isMemberOnly ? `AND created_by = $9` : '';
    const params = [
      patchAddr.location === undefined ? null : patchAddr.location,
      notes        ? String(notes).slice(0, 4000)   : null,
      visitDate    ? new Date(visitDate).toISOString() : null,
      durationMin  ? parseInt(durationMin, 10) || null : null,
      handleId     ? parseInt(handleId, 10) || null : null,
      furnitureRangeId ? parseInt(furnitureRangeId, 10) || null : null,
      patchAddr.address === undefined ? null : (patchAddr.address ? JSON.stringify(patchAddr.address) : null),
      id,
    ];
    if (isMemberOnly) params.push(String(callerId));
    const r = await pool.query(`
      UPDATE design_visits SET
        location           = COALESCE($1, location),
        notes              = COALESCE($2, notes),
        visit_date         = COALESCE($3, visit_date),
        duration_min       = COALESCE($4, duration_min),
        handle_id          = COALESCE($5, handle_id),
        furniture_range_id = COALESCE($6, furniture_range_id),
        structured_address = COALESCE($7::jsonb, structured_address),
        updated_at         = NOW()
      WHERE id = $8 AND status = 'draft' ${ownerClause}
      RETURNING id`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Visit not found or not in draft status' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/design-visits/:id — re-open and replace a submitted / revision_requested
// visit so designers can correct mistakes. Rooms (and their images) are fully
// replaced from the request body, then the full side-effect chain re-runs:
// status → submitted, fresh sign-off token, new QB estimate, new customer
// email. The previous sign-off link is invalidated because the token hash
// changes.
router.put('/api/design-visits/:id', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const userId = req.user?.claims?.sub;
  if (!checkDesignVisitRateLimit(userId)) {
    return res.status(429).json({ error: 'Too many requests. Please wait before resubmitting.' });
  }

  const {
    contactName, contactEmail,
    handleId, furnitureRangeId, visitDate, durationMin,
    structuredAddress, location, notes, termsAccepted, rooms = [],
    handlerConfig, answers,
  } = req.body;

  if (!Array.isArray(rooms) || !rooms.length) return res.status(400).json({ error: 'At least one room is required' });
  if (!termsAccepted) return res.status(400).json({ error: 'Terms and conditions must be accepted' });

  const putAddr = resolveDesignVisitAddress(structuredAddress, location);
  if (putAddr.error) return res.status(400).json({ error: putAddr.error });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cur = await client.query(
      `SELECT status, created_by FROM design_visits WHERE id=$1 FOR UPDATE`, [id]
    );
    if (!cur.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Visit not found' });
    }
    const status = cur.rows[0].status;
    // Members may only replace their own visits; managers and admins may replace any.
    const callerPrivilegeForPut = getRequestPrivilegeLevel(req);
    if (callerPrivilegeForPut === 'member' && cur.rows[0].created_by !== String(userId)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (status !== 'submitted' && status !== 'revision_requested' && status !== 'draft') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Cannot edit visit in status: ${status}` });
    }

    // Stamp the visit with the latest T&C version (mirrors POST behaviour)
    let termsVersionId = null;
    try {
      const tvr = await client.query(
        `SELECT id FROM terms_conditions_versions ORDER BY version_number DESC LIMIT 1`
      );
      termsVersionId = tvr.rows[0]?.id || null;
    } catch {}

    await client.query(`
      UPDATE design_visits SET
        contact_name               = $1,
        contact_email              = $2,
        handle_id                  = $3,
        furniture_range_id         = $4,
        visit_date                 = $5,
        duration_min               = $6,
        location                   = $7,
        structured_address         = $8::jsonb,
        notes                      = $9,
        terms_accepted             = $10,
        terms_condition_version_id = $11,
        status                     = 'draft',
        superseded_signoff_token_hashes = CASE WHEN signoff_token_hash IS NOT NULL
          THEN COALESCE(superseded_signoff_token_hashes, ARRAY[]::TEXT[]) || ARRAY[signoff_token_hash]
          ELSE superseded_signoff_token_hashes END,
        signoff_token_hash         = NULL,
        signoff_expires_at         = NULL,
        updated_at                 = NOW()
      WHERE id = $12`,
      [
        contactName  ? String(contactName).slice(0, 300)  : null,
        contactEmail ? String(contactEmail).slice(0, 300) : null,
        handleId         ? parseInt(handleId, 10)         || null : null,
        furnitureRangeId ? parseInt(furnitureRangeId, 10) || null : null,
        visitDate ? new Date(visitDate).toISOString() : null,
        durationMin ? parseInt(durationMin, 10) || 90 : 90,
        putAddr.location,
        putAddr.address ? JSON.stringify(putAddr.address) : null,
        notes    ? String(notes).slice(0, 4000)   : null,
        !!termsAccepted,
        termsVersionId,
        id,
      ]
    );

    // For member callers, verify they own every opaque cloud-storage key in the
    // updated rooms. Newly uploaded keys must be in design_visit_pending_uploads
    // with created_by = callerId. Keys that were already attached to a visit
    // owned by this caller (round-tripped from a previous GET) are also allowed,
    // because the caller already had write access to those keys when the visit
    // was originally saved.
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
          `SELECT storage_key FROM design_visit_pending_uploads
           WHERE storage_key = ANY($1) AND created_by = $2
           UNION
           SELECT dvri.storage_key
           FROM design_visit_room_images dvri
           JOIN design_visit_rooms dvr ON dvr.id = dvri.room_id
           JOIN design_visits dv       ON dv.id  = dvr.design_visit_id
           WHERE dvri.storage_key = ANY($1) AND dv.created_by = $2`,
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
    await client.query(`DELETE FROM design_visit_rooms WHERE design_visit_id=$1`, [id]);

    // Room-scoped questionnaire answers travel inline with each room; collect
    // them tagged with the new room id (rooms are fully re-inserted here so old
    // room ids are gone).
    const collectedRoomAnswers = [];
    for (let i = 0; i < rooms.length; i++) {
      const rm = rooms[i];
      const rr = await client.query(`
        INSERT INTO design_visit_rooms
          (design_visit_id, room_name, door_style_id, width_mm, height_mm, depth_mm,
           unit_count, unit_price_pence, notes, sort_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING id`,
        [
          id,
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
          `INSERT INTO design_visit_room_images (room_id, storage_key, mime_type) VALUES ($1,$2,$3)`,
          [roomId, raw, img.mimeType || img.mime_type || null]
        );
      }
    }

    await client.query('COMMIT');

    // Replace questionnaire answers carried inline with the edit: whole-visit
    // answers (room_id null) plus the per-room answers collected above. saveAnswers
    // replaces the full set atomically. Non-fatal — a failure must not lose the
    // saved edit.
    const hasVisitAnswers = Array.isArray(answers);
    if (hasVisitAnswers || collectedRoomAnswers.length) {
      const visitAnswers = hasVisitAnswers
        ? answers.map(a => ({ question_id: a.question_id, room_id: null, answer: a.answer }))
        : [];
      const combinedAnswers = [...visitAnswers, ...collectedRoomAnswers];
      try {
        await saveAnswers('design', id, combinedAnswers);
      } catch (e) {
        logger.error({ err: e.message }, '[design-visits] saveAnswers (update) error:');
      }
    }

    // Re-run the full submit pipeline (sets status back to 'submitted', mints a
    // new sign-off token, creates a new QB estimate, re-sends the customer
    // email). The previous sign-off link is invalidated by the new token hash.
    try {
      await submitDesignVisitAndSync(id, handlerConfig || {}, req.user);
    } catch (e) {
      logger.error({ err: e.message }, '[design-visits] Side effect chain error on PUT:');
    }

    res.json({ ok: true, designVisitId: id });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err: e.message }, '[design-visits] PUT /api/design-visits/:id error:');
    res.status(500).json({ error: 'Could not update design visit.' });
  } finally {
    client.release();
  }
});

// Best-effort delete of the cloud / local object backing a design-visit room
// image. Each `storage_key` may be a data: URI (inline bytes — nothing to
// delete), an http(s) URL (external — we don't fan out to third parties), or
// a server-relative `/uploads/...` path (a real file on disk we can unlink).
// Failures are logged and swallowed so DB cleanup is never blocked.
function _bestEffortDeleteDesignVisitStorageObject(storageKey) {
  const keyPreview = String(storageKey || '').slice(0, 80);
  try {
    if (!storageKey || typeof storageKey !== 'string') {
      logger.info(`[design-visits] storage delete skip (empty key)`);
      return;
    }
    if (/^data:/i.test(storageKey)) {
      logger.info(`[design-visits] storage delete skip (inline data URI) key=${keyPreview}`);
      return;
    }
    if (/^https?:\/\//i.test(storageKey)) {
      logger.info(`[design-visits] storage delete skip (external url) key=${keyPreview}`);
      return;
    }
    if (storageKey.startsWith('/uploads/')) {
      const rel = storageKey.replace(/^\/+/, '');
      const filePath = path.join(__dirname, 'public', rel);
      const resolved = path.resolve(filePath);
      const uploadsRoot = path.resolve(path.join(__dirname, 'public', 'uploads'));
      if (!resolved.startsWith(uploadsRoot + path.sep)) {
        logger.warn(`[design-visits] storage delete refuse (path escapes uploads) key=${keyPreview}`);
        return;
      }
      fs.unlink(resolved, err => {
        if (err && err.code === 'ENOENT') {
          logger.info(`[design-visits] storage delete skip (file missing) key=${keyPreview}`);
        } else if (err) {
          logger.warn(`[design-visits] storage delete fail key=${keyPreview} err=${err.message}`);
        } else {
          logger.info(`[design-visits] storage delete ok key=${keyPreview}`);
        }
      });
      return;
    }
    if (dvUploads.isOpaqueKey(storageKey)) {
      // Cloud-storage key — fire-and-forget delete from the bucket. Failures
      // are logged but never block DB cleanup.
      dvUploads.deleteOpaqueKey(storageKey).then(
        () => logger.info(`[design-visits] storage delete ok (cloud) key=${keyPreview}`),
        err => logger.warn(`[design-visits] storage delete fail (cloud) key=${keyPreview} err=${err.message}`)
      );
      return;
    }
    // Anything else — log so external cleanup tooling has a trail to follow.
    logger.info(`[design-visits] storage delete skip (unrecognised key shape) key=${keyPreview}`);
  } catch (e) {
    logger.warn(`[design-visits] storage delete fail key=${keyPreview} err=${e.message}`);
  }
}

router.delete('/api/design-visits/:id', isAuthenticated, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    // Collect storage_keys BEFORE the DB delete so we still know what to clean
    // up after `ON DELETE CASCADE` drops `design_visit_room_images`.
    let storageKeys = [];
    try {
      const k = await pool.query(
        `SELECT dvri.storage_key
           FROM design_visit_room_images dvri
           JOIN design_visit_rooms dvr ON dvr.id = dvri.room_id
          WHERE dvr.design_visit_id = $1`,
        [id]
      );
      storageKeys = k.rows.map(r => r.storage_key).filter(Boolean);
    } catch (lookupErr) {
      logger.warn({ err: lookupErr.message }, '[design-visits] storage_key lookup failed before delete:');
    }

    const r = await pool.query(`DELETE FROM design_visits WHERE id=$1 RETURNING id`, [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });

    // Fire-and-forget storage cleanup so the API response is not blocked by
    // slow object-store deletes. Each helper invocation logs its own outcome.
    for (const key of storageKeys) {
      _bestEffortDeleteDesignVisitStorageObject(key);
    }

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
  if (!checkDesignVisitRateLimit(userId)) {
    return res.status(429).json({ error: 'Too many requests.' });
  }
  try {
    const vr = await pool.query(`SELECT status, created_by FROM design_visits WHERE id=$1`, [id]);
    if (!vr.rows.length) return res.status(404).json({ error: 'Visit not found' });
    // Members may only submit their own visits; managers and admins may submit any.
    const callerPrivilege = getRequestPrivilegeLevel(req);
    if (callerPrivilege === 'member' && vr.rows[0].created_by !== String(userId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const status = vr.rows[0].status;
    if (status !== 'draft' && status !== 'revision_requested') {
      return res.status(400).json({ error: `Cannot submit from status: ${status}` });
    }
    await submitDesignVisitAndSync(id, req.body?.handlerConfig || {}, req.user);
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e.message }, '[design-visits] POST /api/design-visits/:id/submit error:');
    res.status(500).json({ error: e.message });
  }
});

// POST /api/design-visits/:id/revision — mark revision requested (admin only)
router.post('/api/design-visits/:id/revision', isAuthenticated, requirePrivilege('admin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const rawNote = req.body?.revisionNote ?? req.body?.note;
  const note = rawNote ? String(rawNote).slice(0, 2000) : null;
  try {
    const r = await pool.query(`
      UPDATE design_visits SET
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
      LEFT JOIN catalog_handles               dvh  ON dvh.id  = dv.handle_id
      LEFT JOIN catalog_ranges                dvfr ON dvfr.id = dv.furniture_range_id
      WHERE dv.signoff_token_hash = $1`, [tokenHash]);
    if (!vr.rows.length) {
      // No active token matched — check whether this is a superseded link.
      // Do NOT expose any visit data for superseded tokens: the old email link
      // must not become a long-lived bearer token for current visit contents.
      // Return a 410 with a clear message so the page can show a friendly
      // "changes in progress" state without leaking any customer PII.
      const sup = await pool.query(
        `SELECT 1 FROM design_visits WHERE $1 = ANY(superseded_signoff_token_hashes) LIMIT 1`,
        [tokenHash],
      );
      if (sup.rows.length) {
        return res.status(410).json({
          status: 'superseded',
          error: 'Your designer is currently making changes to this visit. A new link will be sent when it\'s ready for your approval.',
        });
      }
      return res.status(404).json({ error: 'Not found' });
    }
    const visit = vr.rows[0];
    // Always 404 for any token state that is not the expected sign-off window
    // (submitted + not expired). Avoids oracle leakage on consumed tokens.
    if (visit.status !== 'submitted') return res.status(404).json({ error: 'Not found' });
    // Expired-but-recognised: surface a friendly "this link has expired"
    // state instead of a generic 404 so customers clicking an old email
    // know to ask for a fresh link.
    if (visit.signoff_expires_at && new Date() > new Date(visit.signoff_expires_at)) {
      return res.status(410).json({
        status: 'expired',
        error: 'This sign-off link has expired. Please contact us to receive a fresh link.',
        expiresAt: visit.signoff_expires_at,
      });
    }
    // Load rooms
    const rooms = await pool.query(`
      SELECT dvr.id, dvr.room_name, dvr.width_mm, dvr.height_mm, dvr.depth_mm,
             dvr.unit_count, dvr.unit_price_pence, dvr.notes,
             dvds.name AS door_style_name
      FROM design_visit_rooms dvr
      LEFT JOIN catalog_doors            dvds ON dvds.id = dvr.door_style_id
      WHERE dvr.design_visit_id = $1
      ORDER BY dvr.sort_order ASC, dvr.id ASC`, [visit.id]);
    // Load images per room
    const imagesRes = await pool.query(`
      SELECT dvri.room_id, dvri.storage_key, dvri.mime_type
      FROM design_visit_room_images dvri
      JOIN design_visit_rooms dvr ON dvr.id = dvri.room_id
      WHERE dvr.design_visit_id = $1
      ORDER BY dvri.id ASC`, [visit.id]);
    const imagesByRoom = {};
    for (const img of imagesRes.rows) {
      if (!imagesByRoom[img.room_id]) imagesByRoom[img.room_id] = [];
      // For sign-off we hand the browser a short-lived signed URL (or the
      // legacy URL / data URI for rows pre-dating the cloud bucket) — never
      // the opaque DB key.
      imagesByRoom[img.room_id].push({
        storageKey: dvUploads.signImageUrl(img.storage_key),
        mimeType:   img.mime_type,
      });
    }
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
        images:         imagesByRoom[r.id] || [],
      })),
      terms,
    });
  } catch (e) {
    logger.error({ err: e.message }, '[design-visits] GET sign-off error:');
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the row while we inspect + consume the token. Any concurrent request
    // carrying the same token will block here until we COMMIT or ROLLBACK, then
    // will see the token already cleared and fall through to the 404/409 paths.
    const vr = await client.query(`
      SELECT id, status, signoff_expires_at, contact_name, signoff_token_hash
      FROM design_visits WHERE signoff_token_hash = $1 FOR UPDATE`, [tokenHash]);
    if (!vr.rows.length) {
      await client.query('ROLLBACK');
      // No active token — check whether this is a stale link the designer has
      // since superseded. Reject with a clear 409 so a customer who submits via
      // a cached form sees a meaningful message instead of a generic error.
      const sup = await pool.query(
        `SELECT 1 FROM design_visits WHERE $1 = ANY(superseded_signoff_token_hashes) LIMIT 1`,
        [tokenHash]
      );
      if (sup.rows.length) {
        return res.status(409).json({
          status: 'superseded',
          error: 'Your designer is currently making changes to this visit. A new link will be sent when it\'s ready for your approval.',
        });
      }
      return res.status(404).json({ error: 'Not found' });
    }
    const visit = vr.rows[0];
    // Token is only actionable while the visit is in submitted state + not expired.
    if (visit.status !== 'submitted') {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }
    if (visit.signoff_expires_at && new Date() > new Date(visit.signoff_expires_at)) {
      await client.query('ROLLBACK');
      // Match the GET handler: a recognised-but-expired token gets a friendly
      // 410 payload so the page can show a "link expired" state with a contact
      // prompt instead of a generic error.
      return res.status(410).json({
        status: 'expired',
        error: 'This sign-off link has expired. Please contact us to receive a fresh link.',
      });
    }
    if (action === 'approve') {
      await client.query(`
        UPDATE design_visits SET status='signed_off', signed_off_at=NOW(),
          signoff_token_hash=NULL, updated_at=NOW()
        WHERE id=$1`, [visit.id]);
    } else {
      // Invalidate the token on revision too — prevents replay. Track the old
      // hash so a second click on the link surfaces the "designer is making
      // changes" notice rather than a generic 404.
      await client.query(`
        UPDATE design_visits SET
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
    // Notify team (non-fatal, outside transaction)
    try {
      const transport = createMailTransport();
      const admins = adminEmails();
      if (transport && admins.length) {
        if (action === 'approve') {
          await transport.sendMail({
            from: buildFromHeader(), replyTo: buildReplyTo(),
            to: admins.join(', '),
            subject: `Design visit signed off — ${visit.contact_name || visit.id}`,
            text: `${visit.contact_name || 'The customer'} has approved and signed off their design visit (#${visit.id}).`,
          });
        } else {
          await transport.sendMail({
            from: buildFromHeader(), replyTo: buildReplyTo(),
            to: admins.join(', '),
            subject: `Design visit revision requested — ${visit.contact_name || visit.id}`,
            text: `${visit.contact_name || 'The customer'} has requested changes to design visit #${visit.id}.\n\nNote: ${note || '(none)'}`,
          });
        }
      }
    } catch {}
    res.json({ success: true, status: action === 'approve' ? 'signed_off' : 'revision_requested' });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    logger.error({ err: e.message }, '[design-visits] POST sign-off error:');
    res.status(500).json({ error: 'Could not process sign-off.' });
  } finally {
    client.release();
  }
});

// ── Cloud-storage image upload & serving ─────────────────────────────────────
// POST /api/design-visits/uploads — authenticated. Designers POST a data URL
// (the wizard reads files with FileReader as data URLs to avoid wiring up a
// second multipart form-data path) and we hand back the opaque cloud key
// they'll round-trip into the design-visit submission payload.
router.post('/api/design-visits/uploads', isAuthenticated, requirePrivilege('member'), express.json({ limit: '15mb' }), async (req, res) => {
  try {
    const dataUrl = String(req.body?.dataUrl || '');
    if (!dataUrl) return res.status(400).json({ error: 'dataUrl is required' });
    const out = await dvUploads.uploadFromDataUrl(dataUrl);
    // Record the uploader so the delete endpoint can enforce ownership.
    const callerId = req.user?.claims?.sub;
    if (dvUploads.isOpaqueKey(out.storageKey)) {
      await pool.query(
        `INSERT INTO design_visit_pending_uploads (storage_key, created_by)
         VALUES ($1, $2) ON CONFLICT (storage_key) DO NOTHING`,
        [out.storageKey, String(callerId)],
      ).catch(err => logger.warn({ err: err.message }, '[design-visits] pending upload insert failed (non-fatal):'));
    }
    return res.json({
      storageKey: out.storageKey,
      mimeType:   out.mimeType,
      byteLength: out.byteLength,
      viewUrl:    dvUploads.signImageUrl(out.storageKey),
    });
  } catch (e) {
    const status = e.statusCode || 500;
    logger.warn({ err: e.message }, '[design-visits] upload failed:');
    return res.status(status).json({ error: e.message || 'Upload failed' });
  }
});

// POST /api/design-visits/sign-image-urls — authenticated (member+). Takes a
// list of opaque storage keys and returns freshly signed, short-lived view URLs
// keyed by storage key. Used when resuming a queued (unsynced) design-visit edit
// whose photos were uploaded while online: the queued payload preserves the real
// `storageKey` but not the expired signed `viewUrl`, so on resume the client
// re-derives a working thumbnail URL here. Non-opaque keys (offline data: URIs,
// legacy URLs) are skipped — they render directly without signing.
router.post('/api/design-visits/sign-image-urls', isAuthenticated, requirePrivilege('member'), express.json({ limit: '256kb' }), async (req, res) => {
  const keys = Array.isArray(req.body?.storageKeys) ? req.body.storageKeys : null;
  if (!keys) return res.status(400).json({ error: 'storageKeys array is required' });

  const opaqueKeys = keys.filter(k => typeof k === 'string' && dvUploads.isOpaqueKey(k));

  // Members may only re-sign keys they own (uploaded by them, or committed to a
  // visit they created). Managers and admins may re-sign any valid key.
  if (opaqueKeys.length > 0 && getRequestPrivilegeLevel(req) === 'member') {
    const userId = String(req.user?.claims?.sub ?? '');
    const owned = await pool.query(
      `SELECT storage_key FROM design_visit_pending_uploads
       WHERE storage_key = ANY($1) AND created_by = $2
       UNION
       SELECT dvri.storage_key
       FROM design_visit_room_images dvri
       JOIN design_visit_rooms dvr ON dvr.id = dvri.room_id
       JOIN design_visits dv       ON dv.id  = dvr.design_visit_id
       WHERE dvri.storage_key = ANY($1) AND dv.created_by = $2`,
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

// DELETE /api/design-visits/uploads/:storageKey — authenticated (member+).
// Removes an opaque cloud-storage key that was minted by the POST endpoint
// above. Called fire-and-forget from the wizard when a user removes a photo
// thumbnail before the visit is saved. Only opaque `obj:…` keys are accepted;
// legacy data URIs, /uploads/ paths, and external URLs are ignored (204) since
// they are not stored in the bucket.
router.delete('/api/design-visits/uploads/:storageKey', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const key = String(req.params.storageKey || '');
  if (!dvUploads.isOpaqueKey(key)) {
    // Not a bucket key — nothing to do. Return 204 so the client doesn't retry.
    return res.status(204).send();
  }
  // Verify ownership: managers and admins may delete any key; members may only
  // delete keys they personally uploaded, as recorded in design_visit_pending_uploads.
  // The "belongs to my visit" heuristic is intentionally NOT used here because a
  // member could attach a foreign key to their own visit (via POST/PUT) and then
  // pass that check to destroy another user's object.
  const callerPrivilege = getRequestPrivilegeLevel(req);
  if (callerPrivilege === 'member') {
    const callerId = String(req.user?.claims?.sub);
    try {
      const pending = await pool.query(
        `SELECT 1 FROM design_visit_pending_uploads WHERE storage_key=$1 AND created_by=$2`,
        [key, callerId],
      );
      if (!pending.rows.length) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    } catch (e) {
      logger.warn({ err: e.message }, '[design-visits] upload ownership check failed:');
      return res.status(500).json({ error: 'Ownership check failed' });
    }
  }
  try {
    await dvUploads.deleteOpaqueKey(key);
    // Clean up the pending-upload tracking row if it exists.
    pool.query(`DELETE FROM design_visit_pending_uploads WHERE storage_key=$1`, [key])
      .catch(err => logger.warn({ err: err.message }, '[design-visits] pending upload cleanup failed (non-fatal):'));
    const kp = key.slice(0, 40);
    logger.info(`[design-visits] upload delete ok key=${kp} user=${req.user?.email || '?'}`);
    return res.status(204).send();
  } catch (e) {
    logger.warn({ err: e.message }, '[design-visits] upload delete failed:');
    return res.status(500).json({ error: 'Delete failed' });
  }
});

// GET /api/design-visit-images/:key?exp=&sig= — public, gated by HMAC.
// Streams bytes for opaque cloud-storage keys. The signature is minted by
// `signImageUrl` for both authenticated admin previews and the public
// sign-off page; it always carries a short expiry (default 1h) so a leaked
// URL stops working quickly.
router.get('/api/design-visit-images/:key', async (req, res) => {
  const key = String(req.params.key || '');
  const exp = req.query.exp;
  const sig = String(req.query.sig || '');
  if (!dvUploads.verifySignedUrl(key, exp, sig)) {
    return res.status(403).send('Forbidden');
  }
  try {
    const buf = await dvUploads.downloadOpaqueKey(key);
    if (!buf) return res.status(404).send('Not found');
    // Infer content-type from the key's extension (jpg/png/etc).
    const m = key.match(/\.([a-z0-9]{1,8})$/i);
    const ext = (m && m[1].toLowerCase()) || 'bin';
    const contentType = ({
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
      gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
    })[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.send(buf);
  } catch (e) {
    logger.warn({ err: e.message }, '[design-visits] image fetch failed:');
    return res.status(500).send('Error');
  }
});

// ── Seed start_design_visit handler + DESIGN_VISIT stage bindings ─────────────
// Ensures a start_design_visit handler row exists and bindings for the four
// DESIGN_VISIT stage statuses:
//   (designvisit, 'design_scheduled')   → "Start Design Visit Wizard"
//   (designvisit, 'design_in_progress') → (same handler, in-progress visits)
//   (designvisit, 'design_sent')        → (same handler, sent visits)
//   (designvisit, 'design_accepted')    → (same handler, accepted visits)
// Uses WHERE NOT EXISTS so admin-configured overrides are never clobbered.
// Idempotent — safe to call on every boot.
async function ensureStartDesignVisitHandlerBindings() {
  // Step 1: ensure a start_design_visit handler exists.
  let handlerId;
  const existing = await pool.query(
    `SELECT id FROM card_action_handlers WHERE type = 'start_design_visit' ORDER BY id LIMIT 1`
  );
  if (existing.rows.length) {
    handlerId = existing.rows[0].id;
  } else {
    const ins = await pool.query(
      `INSERT INTO card_action_handlers (name, type, config)
       VALUES ('Start Design Visit Wizard', 'start_design_visit', '{}')
       RETURNING id`
    );
    handlerId = ins.rows[0].id;
  }

  // Step 2: ensure bindings for each DESIGN_VISIT stage status.
  // WHERE NOT EXISTS prevents duplicate rows (no unique constraint on the
  // table) and preserves any binding an admin has manually configured.
  const bindings = [
    { stage_key: 'designvisit', status_key: 'design_scheduled' },
    { stage_key: 'designvisit', status_key: 'design_in_progress' },
    { stage_key: 'designvisit', status_key: 'design_sent' },
    { stage_key: 'designvisit', status_key: 'design_accepted' },
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

  logger.info('[card-action-seeds] start_design_visit handler and bindings ensured.');
}

// ── Questionnaire engine ──────────────────────────────────────────────────────
// Shared question catalogue (admin-managed) + per-visit captured answers. Used
// by the Design Visit wizard now and any future visit type (Survey Visit).

const VISIT_QUESTION_SCOPES = ['room', 'visit'];
const VISIT_QUESTION_TYPES  = ['yesno', 'choice', 'text', 'number'];

function normaliseAppliesTo(v) {
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return v.split(',').map(x => x.trim()).filter(Boolean);
  return [];
}
function normaliseOptions(v) {
  if (Array.isArray(v)) return v.map(x => String(x));
  return [];
}

// Reusable server helpers — any visit type can load/save its answers.
async function loadAnswers(visitType, visitId) {
  const r = await pool.query(
    `SELECT id, visit_type, visit_id, room_id, question_id, answer, created_at
       FROM visit_answers
      WHERE visit_type = $1 AND visit_id = $2
      ORDER BY id ASC`,
    [visitType, visitId],
  );
  return r.rows;
}

// Replace the full answer set for a visit atomically. `payload` is an array of
// { question_id, room_id?, answer } entries; answers are stored as JSONB.
async function saveAnswers(visitType, visitId, payload) {
  const entries = Array.isArray(payload) ? payload : [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM visit_answers WHERE visit_type = $1 AND visit_id = $2`, [visitType, visitId]);
    for (const e of entries) {
      const qid = parseInt(e?.question_id, 10);
      if (!Number.isFinite(qid)) continue;
      const roomId = e?.room_id != null && e.room_id !== '' ? parseInt(e.room_id, 10) : null;
      const answer = e?.answer === undefined ? null : e.answer;
      await client.query(
        `INSERT INTO visit_answers (visit_type, visit_id, room_id, question_id, answer)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [visitType, visitId, roomId, qid, JSON.stringify(answer)],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return loadAnswers(visitType, visitId);
}

// Admin: list every question (active + inactive).
router.get('/api/admin/visit-questions', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM visit_questions ORDER BY scope ASC, sort_order ASC, id ASC`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: create a question.
router.post('/api/admin/visit-questions', isAuthenticated, requireAdmin, async (req, res) => {
  const label = String(req.body?.label || '').trim();
  if (!label) return res.status(400).json({ error: 'label is required' });
  const scope = String(req.body?.scope || 'visit');
  if (!VISIT_QUESTION_SCOPES.includes(scope)) return res.status(400).json({ error: `scope must be one of: ${VISIT_QUESTION_SCOPES.join(', ')}` });
  const type = String(req.body?.type || 'text');
  if (!VISIT_QUESTION_TYPES.includes(type)) return res.status(400).json({ error: `type must be one of: ${VISIT_QUESTION_TYPES.join(', ')}` });
  const appliesTo = normaliseAppliesTo(req.body?.applies_to);
  const options = normaliseOptions(req.body?.options);
  const required = !!req.body?.required;
  const active = req.body?.active === undefined ? true : !!req.body.active;
  const sortOrder = parseInt(req.body?.sort_order, 10) || 0;
  try {
    const r = await pool.query(
      `INSERT INTO visit_questions (scope, applies_to, label, type, options, required, active, sort_order)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8) RETURNING *`,
      [scope, appliesTo, label, type, JSON.stringify(options), required, active, sortOrder],
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: bulk reorder (array of { id, sort_order }). Must precede the :id route.
router.patch('/api/admin/visit-questions/reorder', isAuthenticated, requireAdmin, async (req, res) => {
  const items = Array.isArray(req.body?.order) ? req.body.order : Array.isArray(req.body) ? req.body : null;
  if (!items) return res.status(400).json({ error: 'order array is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const it of items) {
      const id = parseInt(it?.id, 10);
      const so = parseInt(it?.sort_order, 10);
      if (!Number.isFinite(id) || !Number.isFinite(so)) continue;
      await client.query(`UPDATE visit_questions SET sort_order = $1, updated_at = NOW() WHERE id = $2`, [so, id]);
    }
    await client.query('COMMIT');
    const r = await client.query(`SELECT * FROM visit_questions ORDER BY scope ASC, sort_order ASC, id ASC`);
    res.json(r.rows);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// Admin: update a question.
router.patch('/api/admin/visit-questions/:id', isAuthenticated, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const sets = [], vals = [];
  const add = (c, v) => { vals.push(v); sets.push(`${c} = $${vals.length}`); };
  if (req.body?.label !== undefined) {
    const label = String(req.body.label).trim();
    if (!label) return res.status(400).json({ error: 'label cannot be empty' });
    add('label', label);
  }
  if (req.body?.scope !== undefined) {
    if (!VISIT_QUESTION_SCOPES.includes(String(req.body.scope))) return res.status(400).json({ error: `scope must be one of: ${VISIT_QUESTION_SCOPES.join(', ')}` });
    add('scope', String(req.body.scope));
  }
  if (req.body?.type !== undefined) {
    if (!VISIT_QUESTION_TYPES.includes(String(req.body.type))) return res.status(400).json({ error: `type must be one of: ${VISIT_QUESTION_TYPES.join(', ')}` });
    add('type', String(req.body.type));
  }
  if (req.body?.applies_to !== undefined) add('applies_to', normaliseAppliesTo(req.body.applies_to));
  if (req.body?.options !== undefined) { vals.push(JSON.stringify(normaliseOptions(req.body.options))); sets.push(`options = $${vals.length}::jsonb`); }
  if (req.body?.required !== undefined) add('required', !!req.body.required);
  if (req.body?.active !== undefined) add('active', !!req.body.active);
  if (req.body?.sort_order !== undefined) add('sort_order', parseInt(req.body.sort_order, 10) || 0);
  if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
  vals.push(id);
  try {
    const r = await pool.query(`UPDATE visit_questions SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length} RETURNING *`, vals);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: delete a question (cascades its answers).
router.delete('/api/admin/visit-questions/:id', isAuthenticated, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const r = await pool.query(`DELETE FROM visit_questions WHERE id=$1 RETURNING id`, [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Member: read active questions, optionally filtered by applies_to + scope.
router.get('/api/visit-questions', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  try {
    const params = [];
    const where = ['active = TRUE'];
    if (req.query.applies_to) { params.push(String(req.query.applies_to)); where.push(`$${params.length} = ANY(applies_to)`); }
    if (req.query.scope && VISIT_QUESTION_SCOPES.includes(String(req.query.scope))) { params.push(String(req.query.scope)); where.push(`scope = $${params.length}`); }
    const r = await pool.query(
      `SELECT id, scope, applies_to, label, type, options, required, sort_order
         FROM visit_questions
        WHERE ${where.join(' AND ')}
        ORDER BY scope ASC, sort_order ASC, id ASC`,
      params,
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Member: load/save answers for a design visit.
router.get('/api/design-visits/:id/answers', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    res.json(await loadAnswers('design', id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/design-visits/:id/answers', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const payload = Array.isArray(req.body?.answers) ? req.body.answers : Array.isArray(req.body) ? req.body : null;
  if (!payload) return res.status(400).json({ error: 'answers array is required' });
  try {
    res.json(await saveAnswers('design', id, payload));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = {
  router: router,
  setPatchContactProperties,
  ensureStartDesignVisitHandlerBindings,
  loadAnswers,
  saveAnswers,
};
