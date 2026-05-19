const express = require('express');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const { isAuthenticated, requirePrivilege } = require('./auth');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const router = express.Router();

const visitsRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false
});

const VALID_TYPES = ['design', 'survey', 'installation', 'remedial', 'workshop', 'other'];
const VALID_ROLES = ['designer', 'surveyor', 'fitter', 'manager'];

async function ensureVisitsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS visits (
      id              SERIAL PRIMARY KEY,
      created_by      VARCHAR NOT NULL,
      customer_id     VARCHAR,
      customer_name   VARCHAR,
      type            VARCHAR NOT NULL,
      title           VARCHAR,
      start_at        TIMESTAMPTZ NOT NULL,
      end_at          TIMESTAMPTZ NOT NULL,
      is_workshop     BOOLEAN NOT NULL DEFAULT FALSE,
      notes           TEXT,
      location        VARCHAR,
      google_event_id VARCHAR,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS visits_start_at_idx ON visits (start_at)`);
  await pool.query(`
    ALTER TABLE visits ADD COLUMN IF NOT EXISTS assignee_id   VARCHAR;
    ALTER TABLE visits ADD COLUMN IF NOT EXISTS assignee_role VARCHAR;
  `);
}

function rowToVisit(r) {
  return {
    id:             r.id,
    createdBy:      r.created_by,
    customerId:     r.customer_id,
    customerName:   r.customer_name,
    type:           r.type,
    title:          r.title,
    startAt:        r.start_at.toISOString(),
    endAt:          r.end_at.toISOString(),
    isWorkshop:     r.is_workshop,
    notes:          r.notes,
    location:       r.location,
    assigneeId:     r.assignee_id   || null,
    assigneeRole:   r.assignee_role || null,
    googleEventId:  r.google_event_id,
    createdAt:      r.created_at.toISOString(),
    updatedAt:      r.updated_at.toISOString()
  };
}

function validatePayload(body) {
  const type = String(body.type || '').trim().toLowerCase();
  if (!VALID_TYPES.includes(type)) return { error: 'Invalid type' };
  const start = new Date(body.startAt);
  const end   = new Date(body.endAt);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return { error: 'Invalid start/end' };
  if (end <= start) return { error: 'End must be after start' };
  const rawRole = body.assigneeRole ? String(body.assigneeRole).trim().toLowerCase() : null;
  return {
    type,
    title:        body.title ? String(body.title).slice(0, 200) : null,
    customerId:   body.customerId ? String(body.customerId) : null,
    customerName: body.customerName ? String(body.customerName).slice(0, 200) : null,
    notes:        body.notes ? String(body.notes).slice(0, 4000) : null,
    location:     body.location ? String(body.location).slice(0, 300) : null,
    isWorkshop:   type === 'workshop' ? true : !!body.isWorkshop,
    startAt:      start.toISOString(),
    endAt:        end.toISOString(),
    assigneeId:   body.assigneeId ? String(body.assigneeId) : null,
    assigneeRole: rawRole && VALID_ROLES.includes(rawRole) ? rawRole : null
  };
}

// Per-user POST rate limit: max 30 visits created per 10-minute sliding window
const VISITS_RATE_WINDOW_MS = 10 * 60 * 1000;
const VISITS_RATE_LIMIT     = 30;
const _visitsRateMap = new Map(); // userId -> number[]  (timestamps of recent requests)

function checkVisitsRateLimit(userId) {
  const now = Date.now();
  const cutoff = now - VISITS_RATE_WINDOW_MS;
  const timestamps = (_visitsRateMap.get(userId) || []).filter(t => t > cutoff);
  if (timestamps.length >= VISITS_RATE_LIMIT) return false;
  timestamps.push(now);
  _visitsRateMap.set(userId, timestamps);
  return true;
}

// Maximum allowed date range for GET /api/visits queries (366 days)
const VISITS_MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

function parseDateParam(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d;
}

// Visits are shared, organization-wide business data (same trust model as
// HubSpot CRM notes/tasks). Any authenticated user may create, edit, or delete
// any visit. created_by is stored for audit only.
router.get('/api/visits', isAuthenticated, visitsRateLimiter, async (req, res) => {
  const from = parseDateParam(req.query.from);
  const to   = parseDateParam(req.query.to);
  // Both from and to are required to prevent unbounded full-table scans
  if (!from || !to) return res.status(400).json({ error: 'from and to query parameters are required' });
  if (from === undefined || to === undefined) return res.status(400).json({ error: 'Invalid from/to' });
  if (to - from > VISITS_MAX_RANGE_MS) return res.status(400).json({ error: 'Date range must not exceed 366 days' });
  try {
    const sql = 'SELECT * FROM visits WHERE start_at < $1 AND end_at > $2 ORDER BY start_at ASC';
    const r = await pool.query(sql, [to.toISOString(), from.toISOString()]);
    res.json(r.rows.map(rowToVisit));
  } catch (e) {
    console.error('GET /api/visits failed:', e.message);
    res.status(500).json({ error: 'Failed to load visits' });
  }
});

router.post('/api/visits', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const userId = req.user.claims.sub;
  if (!checkVisitsRateLimit(userId)) {
    return res.status(429).json({ error: 'Too many requests. Please wait before creating more visits.' });
  }
  const v = validatePayload(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  try {
    const r = await pool.query(
      `INSERT INTO visits
       (created_by, customer_id, customer_name, type, title, start_at, end_at, is_workshop, notes, location, assignee_id, assignee_role)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [userId, v.customerId, v.customerName, v.type, v.title, v.startAt, v.endAt, v.isWorkshop, v.notes, v.location, v.assigneeId, v.assigneeRole]
    );
    res.json(rowToVisit(r.rows[0]));
  } catch (e) {
    console.error('POST /api/visits failed:', e.message);
    res.status(500).json({ error: 'Failed to create visit' });
  }
});

router.patch('/api/visits/:id', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const v = validatePayload(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  try {
    const r = await pool.query(
      `UPDATE visits SET
         customer_id=$1, customer_name=$2, type=$3, title=$4,
         start_at=$5, end_at=$6, is_workshop=$7, notes=$8, location=$9,
         assignee_id=$10, assignee_role=$11, updated_at=NOW()
       WHERE id=$12 RETURNING *`,
      [v.customerId, v.customerName, v.type, v.title, v.startAt, v.endAt, v.isWorkshop, v.notes, v.location, v.assigneeId, v.assigneeRole, id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rowToVisit(r.rows[0]));
  } catch (e) {
    console.error('PATCH /api/visits failed:', e.message);
    res.status(500).json({ error: 'Failed to update visit' });
  }
});

router.delete('/api/visits/:id', isAuthenticated, requirePrivilege('member'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const r = await pool.query('DELETE FROM visits WHERE id=$1 RETURNING id', [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /api/visits failed:', e.message);
    res.status(500).json({ error: 'Failed to delete visit' });
  }
});

module.exports = { router, ensureVisitsTable };
