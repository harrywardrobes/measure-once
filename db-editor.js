// Admin database editor (server side).
// Exposes a strict allow-list of tables for admins to read and edit via a
// generic API under /api/admin/db/*. The allow-list is the only source of
// truth for what is editable — never trust the client-provided table name
// without checking it here first. Sensitive auth/session/token tables are
// intentionally excluded (see task-692.md "Out of scope").

const { pool } = require('./auth');

// ── Allow-list ────────────────────────────────────────────────────────────────
// Each entry: { group, pk: [col,...], readOnly?: [col,...], readOnlyTable?: bool,
//               fkLabels?: { col: { table, key, label } } }
const TABLES = {
  // Pipeline
  lead_status_config: {
    group: 'Pipeline',
    pk: ['key'],
    readOnly: [],
  },
  lead_substatuses: {
    group: 'Pipeline',
    pk: ['id'],
    readOnly: ['id', 'updated_at'],
    fkLabels: { status_key: { table: 'lead_status_config', key: 'key', label: 'label' } },
  },
  stage_action_labels: {
    group: 'Pipeline',
    pk: ['stage_key', 'status_key'],
    readOnly: ['updated_at'],
  },

  // Card actions
  card_action_handlers: {
    group: 'Card actions',
    pk: ['id'],
    readOnly: ['id', 'created_at', 'updated_at'],
  },
  card_action_handler_bindings: {
    group: 'Card actions',
    pk: ['id'],
    readOnly: ['id'],
    fkLabels: {
      handler_id:   { table: 'card_action_handlers', key: 'id', label: 'name' },
      substatus_id: { table: 'lead_substatuses',     key: 'id', label: 'label' },
    },
  },

  // Trades
  trade_contacts:            { group: 'Trades', pk: ['id'], readOnly: ['id', 'created_at'] },
  trade_companies:           { group: 'Trades', pk: ['id'], readOnly: ['id', 'created_at', 'updated_at'] },
  trade_company_contacts:    { group: 'Trades', pk: ['id'], readOnly: ['id'] },
  trade_company_submissions: { group: 'Trades', pk: ['id'], readOnly: ['id'] },
  trade_audit_log:           { group: 'Trades', pk: ['id'], readOnly: ['id', 'changed_at'], readOnlyTable: true },

  // Design visits
  design_visits:                 { group: 'Design visits', pk: ['id'], readOnly: ['id', 'created_at', 'updated_at'] },
  design_visit_rooms:            { group: 'Design visits', pk: ['id'], readOnly: ['id', 'created_at'] },
  design_visit_room_images:      { group: 'Design visits', pk: ['id'], readOnly: ['id', 'uploaded_at'] },
  design_visit_handles:          { group: 'Design visits', pk: ['id'], readOnly: ['id', 'created_at', 'updated_at'] },
  design_visit_furniture_ranges: { group: 'Design visits', pk: ['id'], readOnly: ['id', 'created_at', 'updated_at'] },
  design_visit_door_styles:      { group: 'Design visits', pk: ['id'], readOnly: ['id', 'created_at', 'updated_at'] },
  terms_conditions_versions:     { group: 'Design visits', pk: ['id'], readOnly: ['id', 'created_at'] },

  // Visits
  visits: { group: 'Visits', pk: ['id'], readOnly: ['id', 'created_at', 'updated_at'] },

  // Ideas
  ideas:         { group: 'Ideas', pk: ['id'], readOnly: ['id', 'created_at'] },
  idea_comments: { group: 'Ideas', pk: ['id'], readOnly: ['id', 'created_at'] },

  // Workshop & settings
  app_settings:       { group: 'Workshop & settings', pk: ['key'],    readOnly: ['updated_at'] },
  workshop_settings:  { group: 'Workshop & settings', pk: ['key'],    readOnly: ['updated_at'] },
  search_settings:    { group: 'Workshop & settings', pk: ['id'],     readOnly: [] },
  whatsapp_messages:  { group: 'Workshop & settings', pk: ['id'],     readOnly: ['id', 'sent_at'] },
  job_roles:          { group: 'Workshop & settings', pk: ['job_id'], readOnly: ['job_id', 'created_at'] },
};

const ALLOWED = new Set(Object.keys(TABLES));

function isAllowed(table) {
  return typeof table === 'string' && ALLOWED.has(table);
}

// ── Schema introspection ─────────────────────────────────────────────────────
const _columnsCache = new Map(); // table -> [{name, data_type, is_nullable, column_default, is_pk}]
let _columnsCacheAt = 0;
const COLUMNS_TTL_MS = 60_000;

async function getColumns(table) {
  if (!isAllowed(table)) throw new Error('Table not allowed');
  const now = Date.now();
  if (now - _columnsCacheAt > COLUMNS_TTL_MS) {
    _columnsCache.clear();
    _columnsCacheAt = now;
  }
  if (_columnsCache.has(table)) return _columnsCache.get(table);
  const { rows } = await pool.query(
    `SELECT column_name AS name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table]
  );
  const pkSet = new Set(TABLES[table].pk);
  const cols = rows.map(r => ({
    name:           r.name,
    data_type:      r.data_type,
    is_nullable:    r.is_nullable === 'YES',
    column_default: r.column_default,
    is_pk:          pkSet.has(r.name),
    read_only:      (TABLES[table].readOnly || []).includes(r.name),
  }));
  _columnsCache.set(table, cols);
  return cols;
}

function invalidateColumnsCache() {
  _columnsCache.clear();
  _columnsCacheAt = 0;
}

// ── Audit table ──────────────────────────────────────────────────────────────
async function ensureDbEditorAuditTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS db_editor_audit (
      id            SERIAL PRIMARY KEY,
      acted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      admin_email   TEXT NOT NULL,
      table_name    TEXT NOT NULL,
      pk            TEXT,
      op            TEXT NOT NULL CHECK (op IN ('insert','update','delete')),
      before_data   JSONB,
      after_data    JSONB
    );
    CREATE INDEX IF NOT EXISTS db_editor_audit_acted_idx ON db_editor_audit (acted_at DESC);
    CREATE INDEX IF NOT EXISTS db_editor_audit_table_idx ON db_editor_audit (table_name);
    CREATE INDEX IF NOT EXISTS db_editor_audit_admin_idx ON db_editor_audit (admin_email);
  `);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function adminEmailOf(req) {
  return req.user?.claims?.email || req.user?.email || 'unknown';
}

function quoteIdent(s) {
  // Whitelist check before quoting; we already constrain to known column names,
  // but double-belt-and-braces: only allow [A-Za-z0-9_].
  if (!/^[A-Za-z0-9_]+$/.test(s)) throw new Error('Invalid identifier: ' + s);
  return '"' + s + '"';
}

function parsePkParam(table, pkParam) {
  // PK may be composite — composite PKs come in as "val1|val2" matching pk[] order.
  const pkCols = TABLES[table].pk;
  const parts = String(pkParam).split('|');
  if (parts.length !== pkCols.length) {
    const err = new Error(`Expected ${pkCols.length} PK part(s), got ${parts.length}`);
    err.status = 400;
    throw err;
  }
  return parts;
}

function pkWhereClause(table, startIndex = 1) {
  const pkCols = TABLES[table].pk;
  const clauses = pkCols.map((c, i) => `${quoteIdent(c)} = $${startIndex + i}`);
  return { sql: clauses.join(' AND '), nParams: pkCols.length };
}

async function fetchRowByPk(table, pkValues) {
  const where = pkWhereClause(table);
  const { rows } = await pool.query(
    `SELECT * FROM ${quoteIdent(table)} WHERE ${where.sql} LIMIT 1`,
    pkValues
  );
  return rows[0] || null;
}

function pkOf(table, row) {
  return TABLES[table].pk.map(c => row[c]).join('|');
}

// Coerce value coming from JSON into something Postgres will accept for the
// target data_type. Best-effort; the DB will reject anything truly wrong.
// Map a Postgres error into a structured JSON response the frontend can use
// to surface inline, field-level messages. Falls back to the raw message for
// unknown error codes.
function formatPgError(e) {
  const out = {
    error:      e.message || 'Database error.',
    code:       e.code || null,
    column:     e.column || null,
    constraint: e.constraint || null,
    detail:     e.detail || null,
    table:      e.table || null,
  };
  // Friendly per-code message and try to pull a column name out of e.detail
  // (e.g. `Key (status_key)=(foo) is not present in table "lead_status_config".`).
  const colFromDetail = () => {
    if (!e.detail) return null;
    const m = /Key \(([^)]+)\)=/.exec(e.detail);
    return m ? m[1].split(',')[0].trim() : null;
  };
  switch (e.code) {
    case '23502': // not_null_violation
      out.column  = out.column || colFromDetail();
      out.message = out.column
        ? `“${out.column}” is required and cannot be left blank.`
        : 'A required field is missing.';
      break;
    case '23505': // unique_violation
      out.column  = out.column || colFromDetail();
      out.message = out.column
        ? `Another row already has this value for “${out.column}”.`
        : 'Another row already uses these values (uniqueness conflict).';
      break;
    case '23503': // foreign_key_violation
      out.column  = out.column || colFromDetail();
      out.message = out.column
        ? `“${out.column}” refers to a row that does not exist (or is still in use elsewhere).`
        : 'This change conflicts with related rows in another table.';
      break;
    case '23514': // check_violation
      out.message = `Value failed the “${out.constraint || 'check'}” constraint.`;
      break;
    case '22P02': // invalid_text_representation
      out.message = 'One of the values is the wrong type for its column.';
      break;
    default:
      out.message = out.error;
  }
  return out;
}

function coerceValue(value, dataType) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  switch (dataType) {
    case 'jsonb':
    case 'json':
      // Accept either a parsed object or a JSON string.
      if (typeof value === 'string') return value;
      return JSON.stringify(value);
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 1 || value === '1') return true;
      if (value === 'false' || value === 0 || value === '0') return false;
      return Boolean(value);
    case 'integer':
    case 'bigint':
    case 'smallint': {
      const n = parseInt(value, 10);
      if (Number.isNaN(n)) return value; // let PG complain
      return n;
    }
    case 'numeric':
    case 'real':
    case 'double precision': {
      const n = Number(value);
      if (Number.isNaN(n)) return value;
      return n;
    }
    default:
      return value;
  }
}

// ── Router installation ──────────────────────────────────────────────────────
function installDbEditorRoutes(app, { isAuthenticated, requireAdmin }) {
  // Allow-list + metadata.
  app.get('/api/admin/db/tables', isAuthenticated, requireAdmin, async (req, res) => {
    try {
      const out = [];
      for (const name of Object.keys(TABLES)) {
        const meta = TABLES[name];
        let columns = [];
        try { columns = await getColumns(name); } catch (_) {}
        out.push({
          name,
          group: meta.group,
          pk: meta.pk,
          readOnlyTable: !!meta.readOnlyTable,
          fkLabels: meta.fkLabels || {},
          columns,
        });
      }
      res.set('Cache-Control', 'no-store');
      res.json({ tables: out });
    } catch (e) {
      console.error('GET /api/admin/db/tables error:', e.message);
      res.status(500).json({ error: 'Could not load table list.' });
    }
  });

  // Paginated rows.
  app.get('/api/admin/db/:table/rows', isAuthenticated, requireAdmin, async (req, res) => {
    const { table } = req.params;
    if (!isAllowed(table)) return res.status(403).json({ error: 'Table not in allow-list.' });
    try {
      const cols = await getColumns(table);
      const colNames = new Set(cols.map(c => c.name));
      const textCols = cols.filter(c =>
        ['text','character varying','varchar','character'].includes(c.data_type) ||
        c.data_type.startsWith('character')
      ).map(c => c.name);

      const search   = String(req.query.search || '').trim();
      const sortCol  = colNames.has(req.query.sort) ? req.query.sort : TABLES[table].pk[0];
      const sortDir  = String(req.query.dir || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
      const page     = Math.max(1, parseInt(req.query.page, 10) || 1);
      const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
      const offset   = (page - 1) * pageSize;

      const params = [];
      let where = '';
      if (search && textCols.length) {
        const clauses = textCols.map(c => {
          params.push('%' + search + '%');
          return `${quoteIdent(c)}::text ILIKE $${params.length}`;
        });
        where = 'WHERE ' + clauses.join(' OR ');
      }

      const countR = await pool.query(
        `SELECT COUNT(*)::int AS n FROM ${quoteIdent(table)} ${where}`,
        params
      );
      const total = countR.rows[0].n;

      params.push(pageSize, offset);
      const dataR = await pool.query(
        `SELECT * FROM ${quoteIdent(table)} ${where}
         ORDER BY ${quoteIdent(sortCol)} ${sortDir} NULLS LAST
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );

      // FK label resolution for known references.
      const fkLabels = TABLES[table].fkLabels || {};
      const fkResolved = {};
      for (const [col, ref] of Object.entries(fkLabels)) {
        if (!isAllowed(ref.table)) continue;
        const ids = Array.from(new Set(
          dataR.rows.map(r => r[col]).filter(v => v !== null && v !== undefined)
        ));
        if (!ids.length) { fkResolved[col] = {}; continue; }
        try {
          const r = await pool.query(
            `SELECT ${quoteIdent(ref.key)} AS k, ${quoteIdent(ref.label)} AS v
             FROM ${quoteIdent(ref.table)}
             WHERE ${quoteIdent(ref.key)} = ANY($1)`,
            [ids]
          );
          const map = {};
          for (const row of r.rows) map[row.k] = row.v;
          fkResolved[col] = map;
        } catch (_) { fkResolved[col] = {}; }
      }

      res.set('Cache-Control', 'no-store');
      res.json({
        table,
        columns: cols,
        rows: dataR.rows,
        total,
        page,
        pageSize,
        fkResolved,
      });
    } catch (e) {
      console.error(`GET /api/admin/db/${table}/rows error:`, e.message);
      res.status(500).json({ error: e.message || 'Could not load rows.' });
    }
  });

  // Insert a row.
  app.post('/api/admin/db/:table/rows', isAuthenticated, requireAdmin, async (req, res) => {
    const { table } = req.params;
    if (!isAllowed(table)) return res.status(403).json({ error: 'Table not in allow-list.' });
    if (TABLES[table].readOnlyTable) return res.status(403).json({ error: 'This table is read-only.' });
    try {
      const cols = await getColumns(table);
      const body = req.body || {};
      const insertCols = [];
      const insertVals = [];
      for (const c of cols) {
        if (c.read_only) continue;
        if (!Object.prototype.hasOwnProperty.call(body, c.name)) continue;
        insertCols.push(c.name);
        insertVals.push(coerceValue(body[c.name], c.data_type));
      }
      if (!insertCols.length) return res.status(400).json({ error: 'No editable fields provided.' });

      const placeholders = insertVals.map((_, i) => `$${i + 1}`).join(', ');
      const colsSql = insertCols.map(quoteIdent).join(', ');

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await client.query(
          `INSERT INTO ${quoteIdent(table)} (${colsSql}) VALUES (${placeholders}) RETURNING *`,
          insertVals
        );
        const inserted = r.rows[0];
        await client.query(
          `INSERT INTO db_editor_audit (admin_email, table_name, pk, op, before_data, after_data)
           VALUES ($1, $2, $3, 'insert', NULL, $4::jsonb)`,
          [adminEmailOf(req), table, pkOf(table, inserted), JSON.stringify(inserted)]
        );
        await client.query('COMMIT');
        res.status(201).json({ row: inserted });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } catch (e) {
      console.error(`POST /api/admin/db/${table}/rows error:`, e.message);
      const status = e.code === '23505' ? 409 : (e.code && e.code.startsWith('23') ? 400 : 500);
      res.status(status).json(formatPgError(e));
    }
  });

  // Update a row.
  app.patch('/api/admin/db/:table/rows/:pk', isAuthenticated, requireAdmin, async (req, res) => {
    const { table } = req.params;
    if (!isAllowed(table)) return res.status(403).json({ error: 'Table not in allow-list.' });
    if (TABLES[table].readOnlyTable) return res.status(403).json({ error: 'This table is read-only.' });
    try {
      const cols = await getColumns(table);
      const pkValues = parsePkParam(table, req.params.pk);
      const body = req.body || {};
      const setCols = [];
      const setVals = [];
      for (const c of cols) {
        if (c.read_only || c.is_pk) continue;
        if (!Object.prototype.hasOwnProperty.call(body, c.name)) continue;
        setCols.push(c.name);
        setVals.push(coerceValue(body[c.name], c.data_type));
      }
      if (!setCols.length) return res.status(400).json({ error: 'No editable fields provided.' });

      const setSql = setCols.map((n, i) => `${quoteIdent(n)} = $${i + 1}`).join(', ');
      const where = pkWhereClause(table, setCols.length + 1);
      const params = [...setVals, ...pkValues];

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const beforeR = await client.query(
          `SELECT * FROM ${quoteIdent(table)} WHERE ${where.sql} LIMIT 1`,
          pkValues
        );
        if (!beforeR.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Row not found.' });
        }
        const before = beforeR.rows[0];
        const r = await client.query(
          `UPDATE ${quoteIdent(table)} SET ${setSql} WHERE ${where.sql} RETURNING *`,
          params
        );
        const after = r.rows[0];
        await client.query(
          `INSERT INTO db_editor_audit (admin_email, table_name, pk, op, before_data, after_data)
           VALUES ($1, $2, $3, 'update', $4::jsonb, $5::jsonb)`,
          [adminEmailOf(req), table, pkOf(table, after), JSON.stringify(before), JSON.stringify(after)]
        );
        await client.query('COMMIT');
        res.json({ row: after });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } catch (e) {
      console.error(`PATCH /api/admin/db/${table}/rows error:`, e.message);
      const status = e.status || (e.code === '23505' ? 409 : (e.code && e.code.startsWith('23') ? 400 : 500));
      res.status(status).json(formatPgError(e));
    }
  });

  // Delete a row. Client must confirm by sending the PK in
  // X-Confirm-Pk header matching the URL :pk segment.
  app.delete('/api/admin/db/:table/rows/:pk', isAuthenticated, requireAdmin, async (req, res) => {
    const { table } = req.params;
    if (!isAllowed(table)) return res.status(403).json({ error: 'Table not in allow-list.' });
    if (TABLES[table].readOnlyTable) return res.status(403).json({ error: 'This table is read-only.' });
    const confirm = req.get('X-Confirm-Pk') || '';
    if (confirm !== req.params.pk) {
      return res.status(400).json({ error: 'PK confirmation header missing or does not match.' });
    }
    try {
      const pkValues = parsePkParam(table, req.params.pk);
      const where = pkWhereClause(table);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const beforeR = await client.query(
          `SELECT * FROM ${quoteIdent(table)} WHERE ${where.sql} LIMIT 1`,
          pkValues
        );
        if (!beforeR.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Row not found.' });
        }
        const before = beforeR.rows[0];
        await client.query(
          `DELETE FROM ${quoteIdent(table)} WHERE ${where.sql}`,
          pkValues
        );
        await client.query(
          `INSERT INTO db_editor_audit (admin_email, table_name, pk, op, before_data, after_data)
           VALUES ($1, $2, $3, 'delete', $4::jsonb, NULL)`,
          [adminEmailOf(req), table, pkOf(table, before), JSON.stringify(before)]
        );
        await client.query('COMMIT');
        res.json({ ok: true });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } catch (e) {
      console.error(`DELETE /api/admin/db/${table}/rows error:`, e.message);
      const status = e.status || (e.code && e.code.startsWith('23') ? 400 : 500);
      res.status(status).json(formatPgError(e));
    }
  });

  // Audit log.
  app.get('/api/admin/db/audit', isAuthenticated, requireAdmin, async (req, res) => {
    try {
      const tableFilter = req.query.table && isAllowed(req.query.table) ? req.query.table : null;
      const adminFilter = req.query.admin ? String(req.query.admin) : null;
      const page     = Math.max(1, parseInt(req.query.page, 10) || 1);
      const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
      const offset   = (page - 1) * pageSize;
      const params = [];
      const where = [];
      if (tableFilter) { params.push(tableFilter); where.push(`table_name = $${params.length}`); }
      if (adminFilter) { params.push(adminFilter); where.push(`admin_email = $${params.length}`); }
      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

      const countR = await pool.query(
        `SELECT COUNT(*)::int AS n FROM db_editor_audit ${whereSql}`,
        params
      );

      params.push(pageSize, offset);
      const r = await pool.query(
        `SELECT id, acted_at, admin_email, table_name, pk, op, before_data, after_data
         FROM db_editor_audit ${whereSql}
         ORDER BY acted_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
      res.set('Cache-Control', 'no-store');
      res.json({ rows: r.rows, total: countR.rows[0].n, page, pageSize });
    } catch (e) {
      console.error('GET /api/admin/db/audit error:', e.message);
      res.status(500).json({ error: 'Could not load audit log.' });
    }
  });
}

module.exports = {
  TABLES,
  isAllowed,
  ensureDbEditorAuditTable,
  installDbEditorRoutes,
  invalidateColumnsCache,
};
