const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const { Pool } = require('pg');
const { isAuthenticated, requireAdmin, requirePrivilege, isAdminEmail } = require('./auth');
const { quickbooksReadWriteLimiter } = require('./rate-limiters');

// ── Per-user rate limiter for sensitive send actions (Postgres-backed) ──────────
// Durable across restarts; safe in multi-instance deployments.
const SEND_LIMIT = 10; // max sends per user per rolling hour

const router = express.Router();
const pool   = new Pool({ connectionString: process.env.DATABASE_URL });

const QB_AUTH_BASE = 'https://appcenter.intuit.com/connect/oauth2';
const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

function qbBase() {
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

function qbRedirectUri() {
  if (process.env.QB_REDIRECT_URI) return process.env.QB_REDIRECT_URI;
  const domain = (process.env.REPLIT_DOMAINS || '').split(',')[0].trim();
  return domain ? `https://${domain}/auth/quickbooks/callback` : '';
}

// ── DB ─────────────────────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS qb_tokens (
      id            SERIAL PRIMARY KEY,
      access_token  TEXT   NOT NULL,
      refresh_token TEXT   NOT NULL,
      realm_id      TEXT   NOT NULL,
      expires_at    BIGINT NOT NULL,
      updated_at    TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS qb_send_log (
      id         SERIAL PRIMARY KEY,
      user_id    TEXT        NOT NULL,
      sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS qb_send_log_user_sent
      ON qb_send_log (user_id, sent_at)
  `);
}
initDB().catch(e => console.warn('QB DB init:', e.message));

// Purge rows older than 1 hour every 30 minutes to keep the table small.
setInterval(() => {
  pool.query(`DELETE FROM qb_send_log WHERE sent_at < NOW() - INTERVAL '1 hour'`)
    .catch(e => console.warn('QB send log cleanup:', e.message));
}, 30 * 60 * 1000);

// Returns true and records the attempt if under the limit; false if over limit.
async function checkSendRateLimit(userId) {
  const r = await pool.query(
    `SELECT COUNT(*) AS cnt FROM qb_send_log
     WHERE user_id = $1 AND sent_at > NOW() - INTERVAL '1 hour'`,
    [userId]
  );
  if (Number(r.rows[0].cnt) >= SEND_LIMIT) return false;
  await pool.query(`INSERT INTO qb_send_log (user_id) VALUES ($1)`, [userId]);
  return true;
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

async function qbGet(path, params = {}) {
  const t = await getValidTokens();
  if (!t) throw new Error('QuickBooks not connected');
  const r = await axios.get(
    `${qbBase()}/v3/company/${t.realm_id}${path}`,
    {
      headers: { Authorization: `Bearer ${t.access_token}`, Accept: 'application/json' },
      params:  { minorversion: 65, ...params },
      timeout: 12000
    }
  );
  return r.data;
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
    redirect_uri:  qbRedirectUri(),
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
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: qbRedirectUri() }).toString(),
      { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } }
    );
    await persistTokens({ ...r.data, realm_id: realmId });
    res.redirect('/?qb=connected');
  } catch (e) {
    console.error('QB OAuth callback error:', e.response?.data || e.message);
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
    const data = await qbGet(`/companyinfo/${t.realm_id}`);
    res.json({ connected: true, company: data.CompanyInfo?.CompanyName || 'QuickBooks' });
  } catch {
    res.json({ connected: false });
  }
});

// ── API: all outstanding invoices ──────────────────────────────────────────────
router.get('/api/quickbooks/invoices', isAuthenticated, requirePrivilege('manager'), quickbooksReadWriteLimiter, async (req, res) => {
  try {
    const data = await qbGet('/query', {
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
    console.error('QB invoices error:', e.response?.data || e.message);
    const isDb = !!(e.severity || e.routine || e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND');
    res.status(503).json({ error: e.message, code: isDb ? 'DB_ERROR' : 'QB_ERROR' });
  }
});

// ── API: single invoice detail ─────────────────────────────────────────────────
router.get('/api/quickbooks/invoice/:id', isAuthenticated, requirePrivilege('manager'), quickbooksReadWriteLimiter, async (req, res) => {
  try {
    const data = await qbGet(`/invoice/${req.params.id}`);
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
    console.error('QB invoice detail error:', e.response?.data || e.message);
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
      `${qbBase()}/v3/company/${t.realm_id}/invoice`,
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
    console.error('QB invoice update error:', e.response?.data || e.message);
    res.status(503).json({ error: e.response?.data?.Fault?.Error?.[0]?.Message || e.message });
  }
});

// ── API: download invoice PDF ──────────────────────────────────────────────────
router.get('/api/quickbooks/invoice/:id/pdf', isAuthenticated, requirePrivilege('manager'), quickbooksReadWriteLimiter, async (req, res) => {
  try {
    const t = await getValidTokens();
    if (!t) return res.status(503).json({ error: 'QuickBooks not connected' });

    const invoiceId = getValidatedInvoiceId(req.params.id);
    if (!invoiceId) return res.status(400).json({ error: 'Invalid invoice id' });

    const r = await axios.get(
      `${qbBase()}/v3/company/${t.realm_id}/invoice/${invoiceId}/pdf`,
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
    console.error('QB PDF error:', e.response?.data || e.message);
    res.status(503).json({ error: e.message });
  }
});

// ── API: send invoice by email ─────────────────────────────────────────────────
router.post('/api/quickbooks/invoice/:id/send', isAuthenticated, requireAdmin, async (req, res) => {
  // Rate-limit: cap sends per authenticated user to SEND_LIMIT per rolling hour.
  const userId = req.user?.claims?.sub || req.user?.id;
  try {
    const allowed = await checkSendRateLimit(userId);
    if (!allowed) {
      return res.status(429).json({ error: 'Too many invoice send requests. Please wait before sending again.' });
    }
  } catch (e) {
    console.error('QB send rate-limit check failed:', e.message);
    return res.status(500).json({ error: 'Could not verify send rate limit.' });
  }

  try {
    const { email } = req.body;
    const t = await getValidTokens();
    if (!t) return res.status(503).json({ error: 'QuickBooks not connected' });

    const invoiceId = getValidatedInvoiceId(req.params.id);
    if (!invoiceId) return res.status(400).json({ error: 'Invalid invoice id' });

    const params = { minorversion: 65 };
    if (email) {
      params.sendTo = email;
    }

    const r = await axios.post(
      `${qbBase()}/v3/company/${t.realm_id}/invoice/${invoiceId}/send`,
      {},
      {
        headers: { Authorization: `Bearer ${t.access_token}`, 'Content-Type': 'application/octet-stream', Accept: 'application/json' },
        params,
        timeout: 20000
      }
    );
    res.json({ success: true });
  } catch (e) {
    console.error('QB send error:', e.response?.data || e.message);
    res.status(503).json({ error: e.response?.data?.Fault?.Error?.[0]?.Message || e.message });
  }
});

module.exports = router;
