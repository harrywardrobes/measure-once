const logger = require('./logger');
const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const { isAuthenticated, requireAdmin, requireManagerOrAdmin, requirePrivilege, isAdminEmail } = require('./auth');
const { quickbooksReadWriteLimiter } = require('./rate-limiters');
const { getEmailTemplate, renderEmail } = require('./email-templates');

// ── Per-user rate limiter for sensitive send actions (Postgres-backed) ──────────
// Durable across restarts; safe in multi-instance deployments.
const SEND_LIMIT = 10; // max sends per user per rolling hour

const router = express.Router();
const pool   = new Pool({ connectionString: process.env.DATABASE_URL });

const QB_AUTH_BASE = 'https://appcenter.intuit.com/connect/oauth2';
const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

function getQuickBooksBaseUrl() {
  if (process.env.QB_API_BASE_OVERRIDE) return process.env.QB_API_BASE_OVERRIDE;
  return process.env.QB_ENVIRONMENT === 'sandbox'
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';
}

function getValidatedInvoiceId(rawId) {
  const id = String(rawId || '').trim();
  // QuickBooks invoice ids are numeric in this integration; reject anything else.
  if (!/^\d+$/.test(id)) return null;
  return id;
}

function getQuickBooksRedirectUri() {
  if (process.env.QB_REDIRECT_URI) return process.env.QB_REDIRECT_URI;
  const domain = (process.env.REPLIT_DOMAINS || '').split(',')[0].trim();
  return domain ? `https://${domain}/auth/quickbooks/callback` : '';
}

// ── DB ─────────────────────────────────────────────────────────────────────────
// Schema (qb_tokens, qb_send_log + index, qb_settings) is created by migrations on boot.

// Purge rows older than 1 hour every 30 minutes to keep the table small.
setInterval(() => {
  pool.query(`DELETE FROM qb_send_log WHERE sent_at < NOW() - INTERVAL '1 hour'`)
    .catch(e => logger.warn({ err: e.message }, 'QB send log cleanup:'));
}, 30 * 60 * 1000);

// Returns true and records the attempt if under the limit; false if over limit.
// Uses a per-user advisory transaction lock to serialize concurrent calls for
// the same user, preventing two simultaneous requests from both observing the
// same pre-insert count and both proceeding past the SEND_LIMIT.
async function checkSendRateLimit(userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // pg_advisory_xact_lock blocks until it can acquire an exclusive lock for
    // this transaction, keyed on a stable integer derived from the user id.
    // The lock is released automatically when the transaction ends.
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',
      [String(userId)]
    );
    const r = await client.query(
      `SELECT COUNT(*) AS cnt FROM qb_send_log
       WHERE user_id = $1 AND sent_at > NOW() - INTERVAL '1 hour'`,
      [userId]
    );
    if (Number(r.rows[0].cnt) >= SEND_LIMIT) {
      await client.query('COMMIT');
      return false;
    }
    await client.query(`INSERT INTO qb_send_log (user_id) VALUES ($1)`, [userId]);
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function getStoredTokens() {
  const r = await pool.query('SELECT * FROM qb_tokens ORDER BY id DESC LIMIT 1');
  return r.rows[0] || null;
}

async function persistTokens({ access_token, refresh_token, realm_id, expires_in }) {
  const expires_at = Date.now() + ((Number(expires_in) || 3600) * 1000) - 60000;
  await pool.query('DELETE FROM qb_tokens');
  await pool.query(
    'INSERT INTO qb_tokens (access_token, refresh_token, realm_id, expires_at) VALUES ($1, $2, $3, $4)',
    [access_token, refresh_token, realm_id, expires_at]
  );
  return { access_token, refresh_token, realm_id, expires_at };
}

async function getValidTokens() {
  const t = await getStoredTokens();
  if (!t) return null;
  if (Date.now() < Number(t.expires_at)) return t;

  const creds = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
  const r = await axios.post(
    QB_TOKEN_URL,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token }).toString(),
    { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } }
  );
  return persistTokens({ ...r.data, realm_id: t.realm_id });
}

async function fetchFromQuickBooks(path, params = {}) {
  const t = await getValidTokens();
  if (!t) throw new Error('QuickBooks not connected');
  const r = await axios.get(
    `${getQuickBooksBaseUrl()}/v3/company/${t.realm_id}${path}`,
    {
      headers: { Authorization: `Bearer ${t.access_token}`, Accept: 'application/json' },
      params:  { minorversion: 65, ...params },
      timeout: 12000
    }
  );
  return r.data;
}

// ── Centralised QB email send ───────────────────────────────────────────────────
// Reads qb_settings fresh from the DB, sparse-updates BillEmailCc/BillEmailBcc
// on the transaction, then calls the QB send endpoint.
//
// txnType  — 'invoice' | 'estimate' (lowercase, as used in QB API paths)
// txnId    — numeric QB transaction ID (string or number)
// options  — { sendTo?: string } — optional override for the recipient address
async function sendQbTransactionEmail(txnType, txnId, { sendTo } = {}) {
  const t = await getValidTokens();
  if (!t) throw new Error('QuickBooks not connected');

  const id = String(txnId || '').trim();
  if (!/^\d+$/.test(id)) throw new Error('Invalid transaction id');

  // Capitalise for QB response envelope key (e.g. 'invoice' → 'Invoice')
  const txnTypeCap = txnType.charAt(0).toUpperCase() + txnType.slice(1);

  // Read settings fresh from DB on every send (never cached at startup)
  let copyMeEmail = null;
  let copyMeMode  = 'bcc';
  try {
    const sr = await pool.query('SELECT copy_me_email, copy_me_mode FROM qb_settings LIMIT 1');
    if (sr.rows[0]) {
      copyMeEmail = sr.rows[0].copy_me_email || null;
      copyMeMode  = sr.rows[0].copy_me_mode  || 'bcc';
    }
  } catch (e) {
    logger.warn({ err: e.message }, 'QB sendQbTransactionEmail: could not read qb_settings; proceeding without CC/BCC');
  }

  // Sparse-update BillEmailCc / BillEmailBcc if a copy-me address is configured
  if (copyMeEmail) {
    try {
      // Fetch current SyncToken so the sparse update is valid
      const currentData = await fetchFromQuickBooks(`/${txnType}/${id}`);
      const txn = currentData[txnTypeCap];
      const syncToken = txn?.SyncToken;

      const updateBody = {
        sparse:    true,
        Id:        id,
        SyncToken: String(syncToken ?? 0),
      };
      if (copyMeMode === 'cc') {
        updateBody.BillEmailCc  = { Address: copyMeEmail };
      } else {
        updateBody.BillEmailBcc = { Address: copyMeEmail };
      }

      await axios.post(
        `${getQuickBooksBaseUrl()}/v3/company/${t.realm_id}/${txnType}`,
        updateBody,
        {
          headers: { Authorization: `Bearer ${t.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          params:  { minorversion: 65 },
          timeout: 12000
        }
      );
    } catch (e) {
      // Non-fatal: log the failure but continue to send the email
      logger.warn({ err: e.response?.data || e.message }, `QB sendQbTransactionEmail: could not set ${copyMeMode.toUpperCase()} on ${txnType} ${id}; continuing with send`);
    }
  }

  // Call the QB send endpoint
  const params = { minorversion: 65 };
  if (sendTo) params.sendTo = sendTo;

  const r = await axios.post(
    `${getQuickBooksBaseUrl()}/v3/company/${t.realm_id}/${txnType}/${id}/send`,
    {},
    {
      headers: { Authorization: `Bearer ${t.access_token}`, 'Content-Type': 'application/octet-stream', Accept: 'application/json' },
      params,
      timeout: 20000
    }
  );
  return r.data;
}

// ── Wired helpers (injected by server.js on startup) ──────────────────────────
let _patchContactProperties = async (_contactId, _props) => {
  logger.warn('[quickbooks] patchContactProperties called before server wiring — skipping HubSpot update');
};
let _assertLeadStatusKey = async (_key) => {
  logger.warn('[quickbooks] assertLeadStatusKey called before server wiring — skipping');
};
function setPatchContactProperties(fn) { _patchContactProperties = fn; }
function setAssertLeadStatusKey(fn)    { _assertLeadStatusKey    = fn; }

// ── Mail transport helpers (same pattern as design-visits.js) ─────────────────
function _buildFromHeader() {
  const raw = (process.env.SMTP_FROM || process.env.SMTP_USER || '').trim();
  if (!raw) return raw;
  if (/</.test(raw)) return raw;
  return `Measure Once <${raw}>`;
}
function _buildReplyTo() {
  return (process.env.SMTP_REPLY_TO || process.env.SMTP_FROM || process.env.SMTP_USER || '').trim();
}
function _createMailTransport() {
  if (process.env.MAIL_TRANSPORT_FILE_OVERRIDE) {
    const fpath = process.env.MAIL_TRANSPORT_FILE_OVERRIDE;
    return {
      sendMail(opts) {
        return new Promise((resolve, reject) => {
          try {
            const fs = require('fs');
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

// ── OAuth: start ───────────────────────────────────────────────────────────────
router.get('/auth/quickbooks', isAuthenticated, requireAdmin, (req, res) => {
  if (!process.env.QB_CLIENT_ID) {
    return res.status(503).send('QB_CLIENT_ID secret is not set. Add it in Replit Secrets.');
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.qbOAuthState = state;
  const params = new URLSearchParams({
    client_id:     process.env.QB_CLIENT_ID,
    redirect_uri:  getQuickBooksRedirectUri(),
    response_type: 'code',
    scope:         'com.intuit.quickbooks.accounting',
    state,
  });
  res.redirect(`${QB_AUTH_BASE}?${params}`);
});

// ── OAuth: callback ────────────────────────────────────────────────────────────
router.get('/auth/quickbooks/callback', isAuthenticated, requireAdmin, async (req, res) => {
  const { code, realmId, error, state } = req.query;
  if (error) return res.redirect(`/?qb=error&reason=${encodeURIComponent(error)}`);

  const savedState = req.session.qbOAuthState;
  delete req.session.qbOAuthState;
  if (!savedState || savedState !== state) {
    return res.redirect('/?qb=error&reason=invalid_state');
  }

  try {
    const creds = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
    const r = await axios.post(
      QB_TOKEN_URL,
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: getQuickBooksRedirectUri() }).toString(),
      { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } }
    );
    await persistTokens({ ...r.data, realm_id: realmId });
    res.redirect('/?qb=connected');
  } catch (e) {
    logger.error({ err: e.response?.data || e.message }, 'QB OAuth callback error:');
    res.redirect('/?qb=error');
  }
});

// ── OAuth: disconnect ──────────────────────────────────────────────────────────
router.post('/auth/quickbooks/disconnect', isAuthenticated, requireAdmin, async (req, res) => {
  try { await pool.query('DELETE FROM qb_tokens'); } catch {}
  res.json({ success: true });
});

// ── API: connection status ─────────────────────────────────────────────────────
router.get('/api/quickbooks/status', isAuthenticated, async (req, res) => {
  try {
    const t = await getValidTokens();
    if (!t) return res.json({ connected: false });
    const data = await fetchFromQuickBooks(`/companyinfo/${t.realm_id}`);
    res.json({
      connected:   true,
      company:     data.CompanyInfo?.CompanyName || 'QuickBooks',
      environment: process.env.QB_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production',
    });
  } catch {
    res.json({ connected: false });
  }
});

// ── API: admin QB settings ─────────────────────────────────────────────────────
router.get('/api/admin/qb-settings', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM qb_settings LIMIT 1');
    if (!r.rows[0]) {
      return res.json({
        copyMeEmail:    'harry@harrywardrobes.co.uk',
        copyMeMode:     'bcc',
        depositPercent: 10,
        paymentStages:  [],
      });
    }
    const row = r.rows[0];
    res.json({
      copyMeEmail:    row.copy_me_email    ?? '',
      copyMeMode:     row.copy_me_mode     ?? 'bcc',
      depositPercent: Number(row.deposit_percent ?? 10),
      paymentStages:  Array.isArray(row.payment_stages) ? row.payment_stages : [],
    });
  } catch (e) {
    logger.error({ err: e.message }, 'GET /api/admin/qb-settings error:');
    res.status(500).json({ error: e.message });
  }
});

router.put('/api/admin/qb-settings', isAuthenticated, requireAdmin, async (req, res) => {
  try {
    const { copyMeEmail, copyMeMode, depositPercent, paymentStages } = req.body;

    // Validate inputs
    if (copyMeMode !== undefined && !['cc', 'bcc'].includes(copyMeMode)) {
      return res.status(400).json({ error: 'copyMeMode must be "cc" or "bcc"' });
    }
    if (depositPercent !== undefined) {
      const n = Number(depositPercent);
      if (isNaN(n) || n < 0 || n > 100) {
        return res.status(400).json({ error: 'depositPercent must be a number between 0 and 100' });
      }
    }
    if (paymentStages !== undefined && !Array.isArray(paymentStages)) {
      return res.status(400).json({ error: 'paymentStages must be an array' });
    }

    // Upsert: ensure exactly one row exists, then update the provided fields
    await pool.query(`
      INSERT INTO qb_settings (copy_me_email, copy_me_mode, deposit_percent, payment_stages)
      SELECT 'harry@harrywardrobes.co.uk', 'bcc', 10, '[]'::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM qb_settings)
    `);

    const sets  = [];
    const vals  = [];
    let   idx   = 1;

    if (copyMeEmail    !== undefined) { sets.push(`copy_me_email = $${idx++}`);    vals.push(String(copyMeEmail ?? '')); }
    if (copyMeMode     !== undefined) { sets.push(`copy_me_mode = $${idx++}`);     vals.push(copyMeMode); }
    if (depositPercent !== undefined) { sets.push(`deposit_percent = $${idx++}`);  vals.push(Number(depositPercent)); }
    if (paymentStages  !== undefined) { sets.push(`payment_stages = $${idx++}`);   vals.push(JSON.stringify(paymentStages)); }

    if (sets.length > 0) {
      sets.push(`updated_at = NOW()`);
      await pool.query(`UPDATE qb_settings SET ${sets.join(', ')}`, vals);
    }

    const r = await pool.query('SELECT * FROM qb_settings LIMIT 1');
    const row = r.rows[0];
    res.json({
      copyMeEmail:    row.copy_me_email    ?? '',
      copyMeMode:     row.copy_me_mode     ?? 'bcc',
      depositPercent: Number(row.deposit_percent ?? 10),
      paymentStages:  Array.isArray(row.payment_stages) ? row.payment_stages : [],
    });
  } catch (e) {
    logger.error({ err: e.message }, 'PUT /api/admin/qb-settings error:');
    res.status(500).json({ error: e.message });
  }
});

// ── API: all outstanding invoices ──────────────────────────────────────────────
router.get('/api/quickbooks/invoices', isAuthenticated, requireAdmin, quickbooksReadWriteLimiter, async (req, res) => {
  try {
    const data = await fetchFromQuickBooks('/query', {
      query: "SELECT * FROM Invoice WHERE Balance > '0.0' MAXRESULTS 1000"
    });
    const invoices = (data.QueryResponse?.Invoice || []).map(inv => ({
      id:           inv.Id,
      docNumber:    inv.DocNumber,
      customerName: inv.CustomerRef?.name || '',
      customerRef:  inv.CustomerRef?.value,
      email:        inv.BillEmail?.Address || '',
      balance:      parseFloat(inv.Balance || 0),
      totalAmt:     parseFloat(inv.TotalAmt || 0),
      dueDate:      inv.DueDate || null,
      txnDate:      inv.TxnDate || null,
    }));
    res.json({ invoices });
  } catch (e) {
    logger.error({ err: e.response?.data || e.message }, 'QB invoices error:');
    const isDb = !!(e.severity || e.routine || e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND');
    res.status(503).json({ error: e.message, code: isDb ? 'DB_ERROR' : 'QB_ERROR' });
  }
});

// ── API: single invoice detail ─────────────────────────────────────────────────
router.get('/api/quickbooks/invoice/:id', isAuthenticated, requireAdmin, quickbooksReadWriteLimiter, async (req, res) => {
  try {
    const data = await fetchFromQuickBooks(`/invoice/${req.params.id}`);
    const inv  = data.Invoice;
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });

    const lines = (inv.Line || [])
      .filter(l => l.DetailType === 'SalesItemLineDetail' || l.DetailType === 'SubTotalLineDetail' || l.Amount)
      .map(l => ({
        id:          l.Id,
        description: l.Description || l.SalesItemLineDetail?.ItemRef?.name || '',
        qty:         l.SalesItemLineDetail?.Qty || null,
        unitPrice:   l.SalesItemLineDetail?.UnitPrice || null,
        amount:      parseFloat(l.Amount || 0),
        detailType:  l.DetailType,
      }));

    res.json({
      id:           inv.Id,
      syncToken:    inv.SyncToken,
      docNumber:    inv.DocNumber,
      customerName: inv.CustomerRef?.name || '',
      customerRef:  inv.CustomerRef?.value,
      email:        inv.BillEmail?.Address || '',
      memo:         inv.CustomerMemo?.value || '',
      balance:      parseFloat(inv.Balance || 0),
      totalAmt:     parseFloat(inv.TotalAmt || 0),
      dueDate:      inv.DueDate || null,
      txnDate:      inv.TxnDate || null,
      lines,
    });
  } catch (e) {
    logger.error({ err: e.response?.data || e.message }, 'QB invoice detail error:');
    res.status(503).json({ error: e.message });
  }
});

// ── API: update invoice (sparse) ───────────────────────────────────────────────
router.post('/api/quickbooks/invoice/:id', isAuthenticated, requireAdmin, quickbooksReadWriteLimiter, async (req, res) => {
  try {
    const { syncToken, dueDate, memo, email } = req.body;
    const t = await getValidTokens();
    if (!t) return res.status(503).json({ error: 'QuickBooks not connected' });

    const body = {
      sparse:    true,
      Id:        req.params.id,
      SyncToken: String(syncToken),
    };
    if (dueDate !== undefined) body.DueDate = dueDate;
    if (memo    !== undefined) body.CustomerMemo = { value: memo };
    if (email   !== undefined) body.BillEmail    = { Address: email };

    const r = await axios.post(
      `${getQuickBooksBaseUrl()}/v3/company/${t.realm_id}/invoice`,
      body,
      {
        headers: { Authorization: `Bearer ${t.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        params:  { minorversion: 65 },
        timeout: 12000
      }
    );
    const inv = r.data.Invoice;
    res.json({ success: true, syncToken: inv.SyncToken });
  } catch (e) {
    logger.error({ err: e.response?.data || e.message }, 'QB invoice update error:');
    res.status(503).json({ error: e.response?.data?.Fault?.Error?.[0]?.Message || e.message });
  }
});

// ── API: download invoice PDF ──────────────────────────────────────────────────
router.get('/api/quickbooks/invoice/:id/pdf', isAuthenticated, requireAdmin, quickbooksReadWriteLimiter, async (req, res) => {
  try {
    const t = await getValidTokens();
    if (!t) return res.status(503).json({ error: 'QuickBooks not connected' });

    const invoiceId = getValidatedInvoiceId(req.params.id);
    if (!invoiceId) return res.status(400).json({ error: 'Invalid invoice id' });

    const r = await axios.get(
      `${getQuickBooksBaseUrl()}/v3/company/${t.realm_id}/invoice/${invoiceId}/pdf`,
      {
        headers: { Authorization: `Bearer ${t.access_token}`, Accept: 'application/pdf' },
        params:  { minorversion: 65 },
        responseType: 'arraybuffer',
        timeout: 20000
      }
    );
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="invoice-${req.params.id}.pdf"`);
    res.send(r.data);
  } catch (e) {
    logger.error({ err: e.response?.data || e.message }, 'QB PDF error:');
    res.status(503).json({ error: e.message });
  }
});

// ── API: send invoice by email ─────────────────────────────────────────────────
router.post('/api/quickbooks/invoice/:id/send', isAuthenticated, requireAdmin, quickbooksReadWriteLimiter, async (req, res) => {
  // Rate-limit: cap sends per authenticated user to SEND_LIMIT per rolling hour.
  const userId = req.user?.claims?.sub || req.user?.id;
  try {
    const allowed = await checkSendRateLimit(userId);
    if (!allowed) {
      return res.status(429).json({ error: 'Too many invoice send requests. Please wait before sending again.' });
    }
  } catch (e) {
    logger.error({ err: e.message }, 'QB send rate-limit check failed:');
    return res.status(500).json({ error: 'Could not verify send rate limit.' });
  }

  try {
    const invoiceId = getValidatedInvoiceId(req.params.id);
    if (!invoiceId) return res.status(400).json({ error: 'Invalid invoice id' });

    const { email } = req.body;
    await sendQbTransactionEmail('invoice', invoiceId, { sendTo: email || undefined });
    res.json({ success: true });
  } catch (e) {
    logger.error({ err: e.response?.data || e.message }, 'QB send error:');
    res.status(503).json({ error: e.response?.data?.Fault?.Error?.[0]?.Message || e.message });
  }
});

// ── open_deal: accept deal ────────────────────────────────────────────────────
router.post('/api/quickbooks/contacts/:contactId/accept-deal',
  isAuthenticated, requireManagerOrAdmin, quickbooksReadWriteLimiter,
  async (req, res) => {
    const contactId = String(req.params.contactId || '');
    if (!/^\d+$/.test(contactId)) return res.status(400).json({ error: 'Invalid contactId.' });

    const estimateId = String(req.body?.estimateId || '').trim();
    if (!/^\d+$/.test(estimateId)) {
      return res.status(400).json({ error: 'estimateId is required and must be a numeric QB ID.' });
    }
    const otherEstimateIdsToDecline = (req.body?.otherEstimateIdsToDecline || [])
      .map(id => String(id).trim()).filter(id => /^\d+$/.test(id));
    const contactEmail = String(req.body?.contactEmail || '').trim() || null;
    const contactName  = String(req.body?.contactName  || '').trim() || '';
    const userId = req.user?.claims?.sub || req.user?.id;

    const steps = {
      estimateAccepted:       false,
      invoiceCreated:         false,
      invoiceSent:            false,
      appEmailSent:           false,
      otherEstimatesDeclined: false,
      invoiceStoredOnVisit:   false,
      statusUpdated:          false,
    };

    try {
      const t = await getValidTokens();
      if (!t) return res.status(503).json({ error: 'QuickBooks is not connected.', steps });

      const qbBase   = getQuickBooksBaseUrl();
      const authHdr  = { Authorization: `Bearer ${t.access_token}` };
      const jsonHdr  = { ...authHdr, 'Content-Type': 'application/json', Accept: 'application/json' };
      const qbParams = { minorversion: 65 };

      // Read deposit percent fresh from qb_settings
      let depositPercent = 10;
      try {
        const sr = await pool.query('SELECT deposit_percent FROM qb_settings LIMIT 1');
        if (sr.rows[0]) depositPercent = Number(sr.rows[0].deposit_percent ?? 10);
      } catch {}

      // 1. Fetch the selected estimate
      const estResp = await axios.get(
        `${qbBase}/v3/company/${t.realm_id}/estimate/${encodeURIComponent(estimateId)}`,
        { headers: { ...authHdr, Accept: 'application/json' }, params: qbParams, timeout: 12000 }
      );
      const estimate = estResp.data?.Estimate;
      if (!estimate) return res.status(404).json({ error: 'Estimate not found in QuickBooks.', steps });

      // Ownership check: estimate must belong to this contact (BOLA guard)
      const estimateOwner = String(estimate.CustomerRef?.value || '');
      if (estimateOwner !== contactId) {
        logger.warn(`[accept-deal] Estimate ${estimateId} belongs to CustomerRef ${estimateOwner}, not contact ${contactId} — rejecting`);
        return res.status(409).json({
          error: `Estimate ${estimateId} does not belong to contact ${contactId}. Request rejected.`,
          steps,
        });
      }

      const estimateTotal  = parseFloat(estimate.TotalAmt || 0);
      const depositAmt     = Math.round(estimateTotal * (depositPercent / 100) * 100) / 100;
      const estimateDocNum = estimate.DocNumber || estimateId;

      // 2. Idempotency check — if an invoice was already created for this estimate
      //    (e.g. a prior call timed out before its response arrived), skip the
      //    invoice-create step but still complete all remaining steps so a partial
      //    failure on the first call is correctly retried to completion.
      //
      //    A session-level advisory lock keyed on hashtext(estimateId) serializes
      //    concurrent accept-deal calls for the same estimate.  Without the lock,
      //    two simultaneous requests could both pass the SELECT check before either
      //    INSERT completes, resulting in two QuickBooks invoices for one estimate.
      //    The lock is held for the duration of the QB accept + invoice-create calls
      //    and released once the idempotency row is committed (or on any error).
      let invoiceId     = null;
      let invoiceDocNum = null;
      let idempotentRetry = false;

      const lockClient = await pool.connect();
      let advisoryLockHeld = false;
      try {
        await lockClient.query(
          'SELECT pg_advisory_lock(hashtext($1)::bigint)',
          [estimateId]
        );
        advisoryLockHeld = true;

        // Re-check idempotency table under the advisory lock so a concurrent
        // request that also passed the pre-lock SELECT now sees the committed row.
        const existing = await lockClient.query(
          'SELECT invoice_id, invoice_doc_num FROM open_deal_invoices WHERE estimate_id = $1',
          [estimateId]
        );
        if (existing.rows.length > 0) {
          invoiceId     = existing.rows[0].invoice_id;
          invoiceDocNum = existing.rows[0].invoice_doc_num;
          idempotentRetry = true;
          steps.estimateAccepted = true; // was accepted on the prior call
          steps.invoiceCreated   = true;
          logger.warn(
            { estimateId, contactId, invoiceId },
            '[accept-deal] idempotency: existing invoice found — skipping create, completing remaining steps'
          );
        } else {
          // 3. Mark estimate as Accepted
          await axios.post(
            `${qbBase}/v3/company/${t.realm_id}/estimate`,
            { sparse: true, Id: estimateId, SyncToken: estimate.SyncToken, TxnStatus: 'Accepted' },
            { headers: jsonHdr, params: qbParams, timeout: 12000 }
          );
          steps.estimateAccepted = true;

          // 4. Create deposit invoice (single line linked to the estimate via LinkedTxn)
          const invoiceBody = {
            TxnDate:     new Date().toISOString().slice(0, 10),
            CustomerRef: { value: contactId },
            ...(contactEmail ? { BillEmail: { Address: contactEmail } } : {}),
            Line: [{
              DetailType: 'SalesItemLineDetail',
              Amount:     depositAmt,
              Description: `Deposit — ${depositPercent}% of Estimate #${estimateDocNum}`,
              SalesItemLineDetail: {
                ItemRef:   { value: '1', name: 'Services' },
                Qty:       1,
                UnitPrice: depositAmt,
              },
            }],
            LinkedTxn: [{ TxnId: estimateId, TxnType: 'Estimate' }],
          };
          const invResp = await axios.post(
            `${qbBase}/v3/company/${t.realm_id}/invoice`,
            invoiceBody,
            { headers: jsonHdr, params: qbParams, timeout: 15000 }
          );
          const invoice = invResp.data?.Invoice;
          if (!invoice?.Id) {
            // Throw so the finally block releases the lock and connection, then
            // the outer catch handles the response.  We cannot call res.json
            // inside the advisory-lock try block because the finally would still
            // run regardless and could double-release the client.
            throw Object.assign(
              new Error('Invoice was created but no ID was returned from QuickBooks.'),
              { _qbNoInvoiceId: true, _steps: steps }
            );
          }
          invoiceId     = invoice.Id;
          invoiceDocNum = invoice.DocNumber || null;
          steps.invoiceCreated = true;

          // Record in the idempotency table while still holding the advisory lock
          // so that any concurrent waiter sees the committed row immediately after
          // we release.  ON CONFLICT DO NOTHING is a belt-and-braces guard only.
          await lockClient.query(
            `INSERT INTO open_deal_invoices (estimate_id, contact_id, invoice_id, invoice_doc_num)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (estimate_id) DO NOTHING`,
            [estimateId, contactId, invoiceId, invoiceDocNum]
          );
        }
      } catch (lockErr) {
        // Propagate — the finally block releases the lock and connection.
        throw lockErr;
      } finally {
        if (advisoryLockHeld) {
          await lockClient.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [estimateId]).catch(() => {});
        }
        lockClient.release();
      }

      // 5a. Advisory lock on the send step — serializes concurrent retries for
      //     the same estimate so exactly one caller fires the QB send and
      //     follow-up email even when both callers skipped straight past the
      //     invoice-create lock (both saw the idempotency row and both are
      //     different users, so the per-user rate-limit alone is insufficient).
      //
      //     Under the lock we check open_deal_invoices.sent_at: if already
      //     set by a prior successful send, we skip.  If the send succeeds we
      //     write sent_at before releasing the lock so the next waiter sees it.
      //     If the send fails we leave sent_at NULL so a future retry can try
      //     again — the lock is still released via the finally clause.
      //
      //     A distinct key suffix (':send') avoids any hash collision with the
      //     invoice-create lock that uses the bare estimateId as its key.
      const sendLockKey    = estimateId + ':send';
      const sendLockClient = await pool.connect();
      let sendLockHeld  = false;
      let sendAlreadyDone = false;
      try {
        await sendLockClient.query(
          'SELECT pg_advisory_lock(hashtext($1)::bigint)',
          [sendLockKey]
        );
        sendLockHeld = true;

        // Re-check sent_at under the lock so the waiter sees the committed value.
        const sentCheck = await sendLockClient.query(
          'SELECT sent_at FROM open_deal_invoices WHERE estimate_id = $1',
          [estimateId]
        );
        if (sentCheck.rows[0]?.sent_at != null) {
          sendAlreadyDone = true;
          logger.warn(
            { estimateId, invoiceId },
            '[accept-deal] send already done (sent_at set) — skipping send and app email'
          );
          steps.invoiceSent  = true;
          steps.appEmailSent = true;
        } else {
          // 5b. Rate-limit check then send invoice via QB (includes CC/BCC from qb_settings)
          let allowed;
          try {
            allowed = await checkSendRateLimit(userId);
          } catch (e) {
            logger.error({ err: e.message }, '[accept-deal] send rate-limit check failed:');
            return res.status(500).json({ error: 'Could not verify send rate limit.', steps, invoiceId, invoiceDocNum });
          }
          if (!allowed) {
            return res.status(429).json({
              error: 'Too many invoice sends. Please wait before trying again.', steps, invoiceId, invoiceDocNum,
            });
          }
          try {
            await sendQbTransactionEmail('invoice', invoiceId, { sendTo: contactEmail || undefined });
            steps.invoiceSent = true;
          } catch (e) {
            const qbMsg = e.response?.data?.Fault?.Error?.[0]?.Message || e.message;
            logger.error({ err: qbMsg }, '[accept-deal] QB invoice send failed:');
            return res.status(502).json({
              error: `Invoice created but could not be sent: ${qbMsg}`, steps, invoiceId, invoiceDocNum,
            });
          }

          // 5c. Follow-up app email — fatal: if template/send fails, status does NOT advance
          try {
            const template = await getEmailTemplate('open_deal_deposit_invoice_sent');
            const firstName = contactName.split(' ')[0] || 'there';
            const rendered  = renderEmail(template, { textVars: { firstName, depositPercent: String(depositPercent) } });
            const transport = _createMailTransport();
            if (transport && contactEmail) {
              const replyTo = _buildReplyTo();
              await transport.sendMail({
                from:    _buildFromHeader(),
                ...(replyTo ? { replyTo } : {}),
                to:      contactEmail,
                subject: rendered.subject,
                text:    rendered.text,
                html:    rendered.html || rendered.text,
              });
            }
            // Mark as sent whether SMTP was configured or not — "not applicable" is not a failure
            steps.appEmailSent = true;
          } catch (e) {
            logger.error({ err: e.message }, '[accept-deal] follow-up app email failed — halting before status update:');
            return res.status(502).json({
              error: `Invoice sent but follow-up email could not be prepared or sent: ${e.message}`,
              steps, invoiceId, invoiceDocNum,
            });
          }

          // Both send + app email succeeded — record the timestamp under the lock
          // so the next waiter sees sent_at IS NOT NULL and skips.
          // This update is part of the duplicate-send safety guarantee: if it
          // fails the send DID go out but the guard state is not persisted, which
          // could allow a future retry to re-send.  Treat failure as fatal so the
          // caller can surface the problem rather than silently losing the guard.
          const sentAtResult = await sendLockClient.query(
            'UPDATE open_deal_invoices SET sent_at = NOW() WHERE estimate_id = $1 RETURNING 1',
            [estimateId]
          );
          if ((sentAtResult.rowCount ?? 0) === 0) {
            // Row is unexpectedly missing (e.g. manual deletion) — log loudly but
            // do not treat as fatal since the send already happened and the user
            // should still receive their invoice.
            logger.error(
              { estimateId, invoiceId },
              '[accept-deal] sent_at UPDATE matched 0 rows — idempotency row missing after send; future retries may re-send'
            );
          }
        }
      } catch (sendLockErr) {
        logger.error({ err: sendLockErr.message }, '[accept-deal] send advisory lock error:');
        return res.status(500).json({ error: 'Could not acquire send step lock.', steps, invoiceId, invoiceDocNum });
      } finally {
        if (sendLockHeld) {
          await sendLockClient.query(
            'SELECT pg_advisory_unlock(hashtext($1)::bigint)', [sendLockKey]
          ).catch(() => {});
        }
        sendLockClient.release();
      }

      // 6. Mark other estimates as Rejected (non-fatal)
      for (const otherId of otherEstimateIdsToDecline) {
        try {
          const oResp = await axios.get(
            `${qbBase}/v3/company/${t.realm_id}/estimate/${encodeURIComponent(otherId)}`,
            { headers: { ...authHdr, Accept: 'application/json' }, params: qbParams, timeout: 8000 }
          );
          const other = oResp.data?.Estimate;
          // Ownership check: only reject estimates that belong to this contact
          const otherOwner = String(other?.CustomerRef?.value || '');
          if (otherOwner !== contactId) {
            logger.warn(`[accept-deal] Estimate ${otherId} belongs to CustomerRef ${otherOwner}, not contact ${contactId} — skipping`);
            continue;
          }
          if (other?.SyncToken != null) {
            await axios.post(
              `${qbBase}/v3/company/${t.realm_id}/estimate`,
              { sparse: true, Id: otherId, SyncToken: other.SyncToken, TxnStatus: 'Rejected' },
              { headers: jsonHdr, params: qbParams, timeout: 8000 }
            );
          }
        } catch (e) {
          logger.warn({ err: e.message }, `[accept-deal] Could not mark estimate ${otherId} Rejected (non-fatal):`);
        }
      }
      steps.otherEstimatesDeclined = true;

      // 7. Store deposit invoice ID on the most recent design visit for this contact (non-fatal)
      try {
        await pool.query(
          `UPDATE design_visits
              SET deposit_invoice_id      = $1,
                  deposit_invoice_doc_num = $2,
                  updated_at              = NOW()
            WHERE id = (
              SELECT id FROM design_visits
               WHERE contact_id = $3
               ORDER BY created_at DESC
               LIMIT 1
            )`,
          [invoiceId, invoiceDocNum, contactId]
        );
        steps.invoiceStoredOnVisit = true;
      } catch (e) {
        logger.warn({ err: e.message }, '[accept-deal] Could not store invoice on design_visit (non-fatal):');
      }

      // 8. Update lead status to DEPOSIT_INVOICE
      try {
        await _assertLeadStatusKey('DEPOSIT_INVOICE');
        await _patchContactProperties(contactId, { hs_lead_status: 'DEPOSIT_INVOICE' });
        steps.statusUpdated = true;
      } catch (e) {
        if (e.code === 'LEAD_STATUS_REMOVED') {
          return res.status(422).json({
            error: e.message, code: 'LEAD_STATUS_REMOVED', removedKey: e.removedKey,
            steps, invoiceId, invoiceDocNum,
          });
        }
        logger.error({ err: e.message }, '[accept-deal] lead status update failed:');
        return res.status(502).json({
          error: `Invoice sent but lead status could not be updated: ${e.message}`,
          steps, invoiceId, invoiceDocNum,
        });
      }

      res.json({ ok: true, steps, invoiceId, invoiceDocNum, hs_lead_status: 'DEPOSIT_INVOICE', ...(idempotentRetry ? { idempotent: true } : {}), ...(sendAlreadyDone ? { sendSkipped: true } : {}) });
    } catch (e) {
      if (e._qbNoInvoiceId) {
        // Thrown from inside the advisory-lock block to ensure the finally clause
        // releases the lock/client before we respond (avoids a double-release).
        return res.status(502).json({ error: e.message, steps: e._steps });
      }
      const qbMsg = e.response?.data?.Fault?.Error?.[0]?.Message || e.message;
      logger.error({ err: qbMsg }, 'POST /api/quickbooks/contacts/:contactId/accept-deal error:');
      res.status(503).json({ error: qbMsg, steps });
    }
  }
);

// ── open_deal: decline deal ───────────────────────────────────────────────────
router.post('/api/quickbooks/contacts/:contactId/decline-deal',
  isAuthenticated, requireManagerOrAdmin, quickbooksReadWriteLimiter,
  async (req, res) => {
    const contactId = String(req.params.contactId || '');
    if (!/^\d+$/.test(contactId)) return res.status(400).json({ error: 'Invalid contactId.' });

    const estimateIds  = (req.body?.estimateIds || [])
      .map(id => String(id).trim()).filter(id => /^\d+$/.test(id));
    const sendThankYou = req.body?.sendThankYou === true;
    const contactEmail = String(req.body?.contactEmail || '').trim() || null;
    const contactName  = String(req.body?.contactName  || '').trim() || '';

    const steps = {
      estimatesDeclined: false,
      thankYouSent:      false,
      statusUpdated:     false,
    };

    try {
      // 1. Mark estimates as Rejected in QB (non-fatal; QB might not be connected)
      if (estimateIds.length > 0) {
        try {
          const t = await getValidTokens();
          if (t) {
            const qbBase   = getQuickBooksBaseUrl();
            const authHdr  = { Authorization: `Bearer ${t.access_token}` };
            const jsonHdr  = { ...authHdr, 'Content-Type': 'application/json', Accept: 'application/json' };
            const qbParams = { minorversion: 65 };
            for (const estId of estimateIds) {
              try {
                const oResp = await axios.get(
                  `${qbBase}/v3/company/${t.realm_id}/estimate/${encodeURIComponent(estId)}`,
                  { headers: { ...authHdr, Accept: 'application/json' }, params: qbParams, timeout: 8000 }
                );
                const est = oResp.data?.Estimate;
                // Ownership check: only reject estimates that belong to this contact
                const estOwner = String(est?.CustomerRef?.value || '');
                if (estOwner !== contactId) {
                  logger.warn(`[decline-deal] Estimate ${estId} belongs to CustomerRef ${estOwner}, not contact ${contactId} — skipping`);
                  continue;
                }
                if (est?.SyncToken != null) {
                  await axios.post(
                    `${qbBase}/v3/company/${t.realm_id}/estimate`,
                    { sparse: true, Id: estId, SyncToken: est.SyncToken, TxnStatus: 'Rejected' },
                    { headers: jsonHdr, params: qbParams, timeout: 8000 }
                  );
                }
              } catch (e) {
                logger.warn({ err: e.message }, `[decline-deal] Could not mark estimate ${estId} Rejected (non-fatal):`);
              }
            }
          }
        } catch (e) {
          logger.warn({ err: e.message }, '[decline-deal] QB reject estimates failed (non-fatal):');
        }
      }
      steps.estimatesDeclined = true;

      // 2. Optional thank-you email — serialized with a session-level advisory
      //    lock so concurrent retries from different users send at most one email.
      //    Under the lock we check open_deal_declines.declined_at: if already set
      //    by a prior successful send we skip.  If the send succeeds we write
      //    declined_at before releasing the lock so the next waiter sees it.
      //    If the send fails we leave declined_at unset so a future retry can try
      //    again — the lock is still released via the finally clause.
      if (sendThankYou && contactEmail) {
        const declineLockKey    = contactId + ':decline';
        const declineLockClient = await pool.connect();
        let declineLockHeld = false;
        try {
          await declineLockClient.query(
            'SELECT pg_advisory_lock(hashtext($1)::bigint)',
            [declineLockKey]
          );
          declineLockHeld = true;

          // Re-check declined_at under the lock so the waiter sees committed state.
          const declineCheck = await declineLockClient.query(
            'SELECT declined_at FROM open_deal_declines WHERE contact_id = $1',
            [contactId]
          );
          if (declineCheck.rows[0]?.declined_at != null) {
            logger.warn(
              { contactId },
              '[decline-deal] thank-you email already sent (declined_at set) — skipping'
            );
            steps.thankYouSent = true;
          } else {
            try {
              const template = await getEmailTemplate('open_deal_declined_thank_you');
              const firstName = contactName.split(' ')[0] || 'there';
              const rendered  = renderEmail(template, { textVars: { firstName } });
              const transport = _createMailTransport();
              if (transport) {
                const replyTo = _buildReplyTo();
                await transport.sendMail({
                  from:    _buildFromHeader(),
                  ...(replyTo ? { replyTo } : {}),
                  to:      contactEmail,
                  subject: rendered.subject,
                  text:    rendered.text,
                  html:    rendered.html || rendered.text,
                });
                steps.thankYouSent = true;
                // Record declined_at while still holding the lock so the next
                // waiter sees it IS NOT NULL and skips the send.
                await declineLockClient.query(
                  `INSERT INTO open_deal_declines (contact_id, declined_at)
                   VALUES ($1, NOW())
                   ON CONFLICT (contact_id) DO UPDATE SET declined_at = NOW()`,
                  [contactId]
                );
              }
            } catch (e) {
              logger.warn({ err: e.message }, '[decline-deal] thank-you email failed (non-fatal):');
            }
          }
        } catch (declineLockErr) {
          logger.error({ err: declineLockErr.message }, '[decline-deal] decline advisory lock error:');
        } finally {
          if (declineLockHeld) {
            await declineLockClient.query(
              'SELECT pg_advisory_unlock(hashtext($1)::bigint)', [declineLockKey]
            ).catch(() => {});
          }
          declineLockClient.release();
        }
      } else {
        steps.thankYouSent = !sendThankYou;
      }

      // 3. Update lead status to DECLINED_DEAL
      try {
        await _assertLeadStatusKey('DECLINED_DEAL');
        await _patchContactProperties(contactId, { hs_lead_status: 'DECLINED_DEAL' });
        steps.statusUpdated = true;
      } catch (e) {
        if (e.code === 'LEAD_STATUS_REMOVED') {
          return res.status(422).json({
            error: e.message, code: 'LEAD_STATUS_REMOVED', removedKey: e.removedKey, steps,
          });
        }
        logger.error({ err: e.message }, '[decline-deal] lead status update failed:');
        return res.status(502).json({
          error: `Estimates declined but lead status could not be updated: ${e.message}`, steps,
        });
      }

      res.json({ ok: true, steps, hs_lead_status: 'DECLINED_DEAL' });
    } catch (e) {
      logger.error({ err: e.response?.data || e.message }, 'POST /api/quickbooks/contacts/:contactId/decline-deal error:');
      res.status(503).json({ error: e.message, steps });
    }
  }
);

// ── In-memory payment-history cache (60-second TTL, keyed by contactId) ──────────
const _paymentHistoryCache = new Map();

function _getCachedPaymentHistory(contactId) {
  const entry = _paymentHistoryCache.get(contactId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _paymentHistoryCache.delete(contactId); return null; }
  return entry.data;
}

function _setCachedPaymentHistory(contactId, data) {
  _paymentHistoryCache.set(contactId, { data, expiresAt: Date.now() + 60000 });
}

// ── API: contact payment history ───────────────────────────────────────────────
//
// Returns real QuickBooks Payment entities joined to their invoices, with a
// derived paid/partial/unpaid status per invoice and an overall summary.
// Deposit invoices are labelled "Deposit" by matching against design_visits;
// remaining invoices fall back to qb_settings.payment_stages labels where
// possible, then "INV-<DocNumber>".
//
// Auth: requireManagerOrAdmin (same level as accept-deal / decline-deal).
// Ownership: all Payment rows are filtered to CustomerRef === contactId.
// Cache: 60-second in-memory cache keyed by contactId.
router.get('/api/quickbooks/contacts/:contactId/payments',
  isAuthenticated, requireManagerOrAdmin, quickbooksReadWriteLimiter,
  async (req, res) => {
    const contactId = String(req.params.contactId || '');
    if (!/^\d+$/.test(contactId)) return res.status(400).json({ error: 'Invalid contactId.' });

    try {
      const cached = _getCachedPaymentHistory(contactId);
      if (cached) return res.json(cached);

      const t = await getValidTokens();
      if (!t) return res.json({ qbConnected: false });

      // Fetch payments and invoices for this customer in parallel
      const [rawPayments, rawInvoices] = await Promise.all([
        fetchFromQuickBooks('/query', {
          query: `SELECT * FROM Payment WHERE CustomerRef = '${contactId}' MAXRESULTS 200`,
        }).then(d => d.QueryResponse?.Payment || []).catch(e => {
          logger.warn({ err: e.message }, '[payments] QB payments query failed:');
          return [];
        }),
        fetchFromQuickBooks('/query', {
          query: `SELECT * FROM Invoice WHERE CustomerRef = '${contactId}' MAXRESULTS 200`,
        }).then(d => d.QueryResponse?.Invoice || []).catch(e => {
          logger.warn({ err: e.message }, '[payments] QB invoices query failed:');
          return [];
        }),
      ]);

      // Ownership guard: discard any payment not belonging to this contact
      const payments = rawPayments.filter(
        p => String(p.CustomerRef?.value || '') === contactId
      );

      // Fetch deposit invoice IDs and payment_stages labels in parallel
      const [depositInvoiceIds, paymentStages] = await Promise.all([
        pool.query(
          'SELECT deposit_invoice_id FROM design_visits WHERE contact_id = $1 AND deposit_invoice_id IS NOT NULL',
          [contactId]
        ).then(r => new Set(r.rows.map(row => String(row.deposit_invoice_id)))).catch(() => new Set()),
        pool.query('SELECT payment_stages FROM qb_settings LIMIT 1')
          .then(r => (Array.isArray(r.rows[0]?.payment_stages) ? r.rows[0].payment_stages : [])).catch(() => []),
      ]);

      // Label helper: "Deposit" > payment_stages match > "INV-<DocNumber>"
      function getInvoiceLabel(inv) {
        const invId = String(inv.Id);
        if (depositInvoiceIds.has(invId)) return 'Deposit';
        for (const stage of paymentStages) {
          if (stage.label && stage.invoiceId && String(stage.invoiceId) === invId) return stage.label;
        }
        return inv.DocNumber ? `INV-${inv.DocNumber}` : `Invoice ${invId}`;
      }

      // Format payment rows (extract linked invoice IDs from Line[].LinkedTxn)
      const formattedPayments = payments.map(p => ({
        id:                p.Id,
        reference:         p.DocNumber || null,
        txnDate:           p.TxnDate || null,
        totalAmt:          parseFloat(p.TotalAmt || 0),
        unappliedAmt:      parseFloat(p.UnappliedAmt || 0),
        paymentMethodName: p.PaymentMethodRef?.name || null,
        linkedInvoiceIds:  (p.Line || [])
          .flatMap(l => (l.LinkedTxn || [])
            .filter(lt => lt.TxnType === 'Invoice')
            .map(lt => String(lt.TxnId)))
          .filter(Boolean),
      }));

      // Format invoice summaries with derived paid/partial/unpaid status
      const invoiceSummaries = rawInvoices.map(inv => {
        const totalAmt = parseFloat(inv.TotalAmt || 0);
        const balance  = parseFloat(inv.Balance  || 0);
        const paidAmt  = Math.max(0, totalAmt - balance);
        const status   = balance <= 0 ? 'paid' : paidAmt > 0 ? 'partial' : 'unpaid';
        return {
          invoiceId:        String(inv.Id),
          invoiceDocNumber: inv.DocNumber || null,
          invoiceLabel:     getInvoiceLabel(inv),
          invoiceTotalAmt:  totalAmt,
          invoiceBalance:   balance,
          invoicePaidAmt:   paidAmt,
          status,
        };
      });

      // Overall summary
      const summary = invoiceSummaries.reduce(
        (acc, inv) => ({
          totalInvoiced:    acc.totalInvoiced    + inv.invoiceTotalAmt,
          totalPaid:        acc.totalPaid        + inv.invoicePaidAmt,
          totalOutstanding: acc.totalOutstanding + inv.invoiceBalance,
        }),
        { totalInvoiced: 0, totalPaid: 0, totalOutstanding: 0 }
      );

      const result = {
        qbConnected: true,
        payments:    formattedPayments,
        invoices:    invoiceSummaries,
        summary,
      };

      _setCachedPaymentHistory(contactId, result);
      res.json(result);
    } catch (e) {
      logger.error({ err: e.response?.data || e.message }, 'GET /api/quickbooks/contacts/:contactId/payments error:');
      res.status(503).json({ error: e.message });
    }
  }
);

module.exports = router;
module.exports.sendQbTransactionEmail    = sendQbTransactionEmail;
module.exports.getValidTokens            = getValidTokens;
module.exports.getQuickBooksBaseUrl      = getQuickBooksBaseUrl;
module.exports.fetchFromQuickBooks       = fetchFromQuickBooks;
module.exports.checkSendRateLimit        = checkSendRateLimit;
module.exports.setPatchContactProperties = setPatchContactProperties;
module.exports.setAssertLeadStatusKey    = setAssertLeadStatusKey;
