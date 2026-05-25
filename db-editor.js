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
    ALTER TABLE db_editor_audit
      ADD COLUMN IF NOT EXISTS reverts_audit_id INTEGER
        REFERENCES db_editor_audit(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS db_editor_audit_acted_idx ON db_editor_audit (acted_at DESC);
    CREATE INDEX IF NOT EXISTS db_editor_audit_table_idx ON db_editor_audit (table_name);
    CREATE INDEX IF NOT EXISTS db_editor_audit_admin_idx ON db_editor_audit (admin_email);
    CREATE INDEX IF NOT EXISTS db_editor_audit_reverts_idx
      ON db_editor_audit (reverts_audit_id) WHERE reverts_audit_id IS NOT NULL;
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
  // Pull `(col)=(value)` parts out of e.detail (which Postgres formats like
  //   `Key (status_key)=(foo) is not present in table "lead_status_config".`
  //   `Key (key)=(foo) is still referenced from table "lead_substatuses".`
  //   `Key (key)=(foo) already exists.`)
  const parseDetail = () => {
    if (!e.detail) return {};
    const kv  = /Key \(([^)]+)\)=\(([^)]*)\)/.exec(e.detail);
    const ref = /referenced from table "([^"]+)"/.exec(e.detail);
    const np  = /not present in table "([^"]+)"/.exec(e.detail);
    return {
      column:    kv ? kv[1].split(',')[0].trim() : null,
      value:     kv ? kv[2] : null,
      refTable:  (ref && ref[1]) || (np && np[1]) || null,
    };
  };
  const d = parseDetail();
  const valuePart  = d.value !== null && d.value !== undefined && d.value !== ''
    ? ` (value “${d.value}”)` : '';
  switch (e.code) {
    case '23502': // not_null_violation
      out.column  = out.column || d.column;
      out.message = out.column
        ? `“${out.column}” is required and cannot be left blank.`
        : 'A required field is missing.';
      break;
    case '23505': // unique_violation
      out.column  = out.column || d.column;
      out.message = out.column
        ? `Another row already has${valuePart ? ` ${valuePart.trim()} for` : ''} “${out.column}”. Pick a different value.`
        : 'Another row already uses these values (uniqueness conflict).';
      break;
    case '23503': { // foreign_key_violation
      out.column = out.column || d.column;
      // Distinguish "delete/update blocked because rows still reference this"
      // from "insert/update points at a missing row".
      const isReferenced  = /still referenced from table/i.test(e.detail || '');
      const isNotPresent  = /not present in table/i.test(e.detail || '');
      if (isReferenced) {
        out.kind = 'still_referenced';
        out.message = d.refTable
          ? `This row is still used by rows in “${d.refTable}”${valuePart}. Remove or reassign those rows first, then try again.`
          : `This row is still used elsewhere${valuePart}. Remove or reassign the related rows first, then try again.`;
      } else if (isNotPresent) {
        out.kind = 'missing_reference';
        out.message = (out.column && d.refTable)
          ? `“${out.column}”${valuePart} refers to a row that does not exist in “${d.refTable}”. Pick an existing row.`
          : (out.column
              ? `“${out.column}”${valuePart} refers to a row that does not exist. Pick an existing row.`
              : 'This change refers to a row that does not exist.');
      } else {
        out.message = out.column
          ? `“${out.column}” conflicts with related rows in another table.`
          : 'This change conflicts with related rows in another table.';
      }
      break;
    }
    case '23514': // check_violation
      out.column  = out.column || d.column;
      out.message = out.column
        ? `Value for “${out.column}” failed the “${out.constraint || 'check'}” rule.`
        : `Value failed the “${out.constraint || 'check'}” rule.`;
      break;
    case '22P02': // invalid_text_representation
      out.message = 'One of the values is the wrong type for its column.';
      break;
    default:
      out.message = out.error;
  }
  return out;
}

// Introspect every foreign-key constraint that points AT `targetTable`, then
// for each referencing table run a small sample query to find the actual rows
// that are blocking a delete. Returns `[]` if nothing blocks.
//
// Each entry shape:
//   { table, allowed, pkCols, labelCol, refCols, targetCols, total,
//     rows: [{ pk, label, row }, ...] }
//
// `allowed` reflects whether the referencing table is in our allow-list
// (only allow-listed tables get a deep-link / editor URL on the frontend).
async function findBlockingRows(targetTable, beforeRow, limitPerTable = 5) {
  if (!isAllowed(targetTable) || !beforeRow) return [];
  let fks;
  try {
    const r = await pool.query(
      `SELECT con.conname AS constraint_name,
              cl.relname  AS ref_table,
              (SELECT array_agg(a.attname ORDER BY u.ord)
                 FROM unnest(con.conkey) WITH ORDINALITY u(attnum, ord)
                 JOIN pg_attribute a
                   ON a.attrelid = con.conrelid AND a.attnum = u.attnum) AS ref_cols,
              (SELECT array_agg(a.attname ORDER BY u.ord)
                 FROM unnest(con.confkey) WITH ORDINALITY u(attnum, ord)
                 JOIN pg_attribute a
                   ON a.attrelid = con.confrelid AND a.attnum = u.attnum) AS target_cols
         FROM pg_constraint con
         JOIN pg_class cl     ON cl.oid = con.conrelid
         JOIN pg_class ct     ON ct.oid = con.confrelid
         JOIN pg_namespace ns ON ns.oid = ct.relnamespace
        WHERE con.contype = 'f'
          AND ct.relname  = $1
          AND ns.nspname  = 'public'`,
      [targetTable]
    );
    fks = r.rows;
  } catch (_) { return []; }

  const out = [];
  for (const fk of fks) {
    const refTable   = fk.ref_table;
    const refCols    = fk.ref_cols    || [];
    const targetCols = fk.target_cols || [];
    if (!refCols.length || refCols.length !== targetCols.length) continue;
    const vals = targetCols.map(c => beforeRow[c]);
    if (vals.some(v => v === null || v === undefined)) continue;

    let whereSql;
    try {
      whereSql = refCols.map((c, i) => `${quoteIdent(c)} = $${i + 1}`).join(' AND ');
    } catch (_) { continue; }

    let countR, sampleR;
    try {
      countR  = await pool.query(
        `SELECT COUNT(*)::int AS n FROM ${quoteIdent(refTable)} WHERE ${whereSql}`,
        vals
      );
      sampleR = await pool.query(
        `SELECT * FROM ${quoteIdent(refTable)} WHERE ${whereSql} LIMIT ${limitPerTable}`,
        vals
      );
    } catch (_) { continue; }

    const total = countR.rows[0]?.n || 0;
    if (!total) continue;

    const allowed = isAllowed(refTable);
    let pkCols   = allowed ? TABLES[refTable].pk : [];
    let labelCol = null;
    if (allowed) {
      try {
        const cols = await getColumns(refTable);
        const names = new Set(cols.map(c => c.name));
        for (const cand of ['label', 'name', 'title', 'description', 'email', 'key']) {
          if (names.has(cand) && !pkCols.includes(cand)) { labelCol = cand; break; }
        }
        if (!labelCol && pkCols.length === 1) labelCol = pkCols[0];
      } catch (_) {}
    }

    out.push({
      table:     refTable,
      allowed,
      pkCols,
      labelCol,
      refCols,
      targetCols,
      total,
      rows: sampleR.rows.map(row => ({
        pk:    allowed ? pkCols.map(c => row[c]).join('|') : null,
        label: labelCol ? (row[labelCol] == null ? null : String(row[labelCol])) : null,
        row,
      })),
    });
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
      const whereClauses = [];
      if (search && textCols.length) {
        const clauses = textCols.map(c => {
          params.push('%' + search + '%');
          return `${quoteIdent(c)}::text ILIKE $${params.length}`;
        });
        whereClauses.push('(' + clauses.join(' OR ') + ')');
      }
      // Exact-match column filters (used by the "Open in editor" deep-link
      // from the delete drawer's blocking-rows preview). Accept repeated
      // ?fcol=…&fval=… pairs or single string values; only allow columns that
      // actually exist on this table.
      const toArr = v => (Array.isArray(v) ? v : (v === undefined ? [] : [v]));
      const fcols = toArr(req.query.fcol).map(String);
      const fvals = toArr(req.query.fval).map(String);
      const activeFilters = [];
      for (let i = 0; i < fcols.length && i < fvals.length; i++) {
        const c = fcols[i];
        if (!colNames.has(c)) continue;
        params.push(fvals[i]);
        whereClauses.push(`${quoteIdent(c)}::text = $${params.length}`);
        activeFilters.push({ column: c, value: fvals[i] });
      }
      const where = whereClauses.length ? 'WHERE ' + whereClauses.join(' AND ') : '';

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
        activeFilters,
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
      const whereBefore = pkWhereClause(table); // starts at $1 — for the SELECT below
      const params = [...setVals, ...pkValues];

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const beforeR = await client.query(
          `SELECT * FROM ${quoteIdent(table)} WHERE ${whereBefore.sql} LIMIT 1`,
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
    let beforeRow = null;
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
        beforeRow = beforeR.rows[0];
        await client.query(
          `DELETE FROM ${quoteIdent(table)} WHERE ${where.sql}`,
          pkValues
        );
        await client.query(
          `INSERT INTO db_editor_audit (admin_email, table_name, pk, op, before_data, after_data)
           VALUES ($1, $2, $3, 'delete', $4::jsonb, NULL)`,
          [adminEmailOf(req), table, pkOf(table, beforeRow), JSON.stringify(beforeRow)]
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
      const status = e.status || (e.code === '23503' ? 409 : (e.code && e.code.startsWith('23') ? 400 : 500));
      const payload = formatPgError(e);
      // On still-referenced FK violations, surface a sample of blocking rows
      // so the admin can jump straight to them in the editor.
      if (e.code === '23503' && payload.kind === 'still_referenced' && beforeRow) {
        try {
          payload.blockingSample = await findBlockingRows(table, beforeRow);
        } catch (_) { /* non-fatal */ }
      }
      res.status(status).json(payload);
    }
  });

  // Revert a previous audit entry.
  //   delete  → re-insert before_data
  //   update  → re-apply before_data to the current row
  //   insert  → delete the inserted row (matched by PK)
  // The revert itself is recorded as its own audit row inside the same
  // transaction. Conflicts (PK already re-used, row no longer exists, etc.)
  // are surfaced with a clear status + message so the UI can show them inline.
  app.post('/api/admin/db/audit/:id/revert', isAuthenticated, requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid audit id.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const auditR = await client.query(
        `SELECT id, table_name, pk, op, before_data, after_data
         FROM db_editor_audit WHERE id = $1 LIMIT 1`,
        [id]
      );
      if (!auditR.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Audit entry not found.' });
      }
      const audit = auditR.rows[0];
      const table = audit.table_name;
      if (!isAllowed(table)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Table not in allow-list.' });
      }
      if (TABLES[table].readOnlyTable) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'This table is read-only.' });
      }

      const cols = await getColumns(table);
      const adminEmail = adminEmailOf(req);

      if (audit.op === 'insert') {
        // Revert an insert by deleting the row at the recorded PK.
        const pkValues = parsePkParam(table, audit.pk);
        const where = pkWhereClause(table);
        const beforeR = await client.query(
          `SELECT * FROM ${quoteIdent(table)} WHERE ${where.sql} LIMIT 1`,
          pkValues
        );
        if (!beforeR.rows.length) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: 'Cannot revert: the row no longer exists (already deleted or PK changed).',
          });
        }
        const before = beforeR.rows[0];
        await client.query(
          `DELETE FROM ${quoteIdent(table)} WHERE ${where.sql}`,
          pkValues
        );
        await client.query(
          `INSERT INTO db_editor_audit (admin_email, table_name, pk, op, before_data, after_data, reverts_audit_id)
           VALUES ($1, $2, $3, 'delete', $4::jsonb, NULL, $5)`,
          [adminEmail, table, pkOf(table, before), JSON.stringify(before), audit.id]
        );
        await client.query('COMMIT');
        return res.json({ ok: true, revertedOp: 'insert', newOp: 'delete' });
      }

      if (audit.op === 'update') {
        // Revert an update by restoring the before_data values onto the current row.
        const before = audit.before_data || {};
        const pkValues = TABLES[table].pk.map(c => before[c]);
        if (pkValues.some(v => v === undefined || v === null)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Cannot revert: original PK missing from audit data.' });
        }
        const where = pkWhereClause(table);
        const curR = await client.query(
          `SELECT * FROM ${quoteIdent(table)} WHERE ${where.sql} LIMIT 1`,
          pkValues
        );
        if (!curR.rows.length) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: 'Cannot revert: the original row no longer exists.',
          });
        }
        const cur = curR.rows[0];
        // Only restore columns that still exist on the table and are not PKs.
        const setCols = [];
        const setVals = [];
        for (const c of cols) {
          if (c.is_pk) continue;
          if (!Object.prototype.hasOwnProperty.call(before, c.name)) continue;
          setCols.push(c.name);
          setVals.push(coerceValue(before[c.name], c.data_type));
        }
        if (!setCols.length) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Nothing to revert (no editable columns recorded).' });
        }
        const setSql = setCols.map((n, i) => `${quoteIdent(n)} = $${i + 1}`).join(', ');
        const w2 = pkWhereClause(table, setCols.length + 1);
        const updR = await client.query(
          `UPDATE ${quoteIdent(table)} SET ${setSql} WHERE ${w2.sql} RETURNING *`,
          [...setVals, ...pkValues]
        );
        const after = updR.rows[0];
        await client.query(
          `INSERT INTO db_editor_audit (admin_email, table_name, pk, op, before_data, after_data, reverts_audit_id)
           VALUES ($1, $2, $3, 'update', $4::jsonb, $5::jsonb, $6)`,
          [adminEmail, table, pkOf(table, after), JSON.stringify(cur), JSON.stringify(after), audit.id]
        );
        await client.query('COMMIT');
        return res.json({ ok: true, revertedOp: 'update', newOp: 'update' });
      }

      if (audit.op === 'delete') {
        // Revert a delete by re-inserting the row from before_data.
        const before = audit.before_data || {};
        const insertCols = [];
        const insertVals = [];
        for (const c of cols) {
          if (!Object.prototype.hasOwnProperty.call(before, c.name)) continue;
          insertCols.push(c.name);
          insertVals.push(coerceValue(before[c.name], c.data_type));
        }
        if (!insertCols.length) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Nothing to restore (no columns recorded).' });
        }
        const placeholders = insertVals.map((_, i) => `$${i + 1}`).join(', ');
        const colsSql = insertCols.map(quoteIdent).join(', ');
        const r = await client.query(
          `INSERT INTO ${quoteIdent(table)} (${colsSql}) VALUES (${placeholders}) RETURNING *`,
          insertVals
        );
        const inserted = r.rows[0];
        await client.query(
          `INSERT INTO db_editor_audit (admin_email, table_name, pk, op, before_data, after_data, reverts_audit_id)
           VALUES ($1, $2, $3, 'insert', NULL, $4::jsonb, $5)`,
          [adminEmail, table, pkOf(table, inserted), JSON.stringify(inserted), audit.id]
        );
        await client.query('COMMIT');
        return res.json({ ok: true, revertedOp: 'delete', newOp: 'insert', row: inserted });
      }

      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Unknown audit op: ' + audit.op });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error(`POST /api/admin/db/audit/${id}/revert error:`, e.message);
      const status = e.status || (e.code === '23505' ? 409 : (e.code && e.code.startsWith('23') ? 400 : 500));
      const payload = formatPgError(e);
      if (e.code === '23505') {
        payload.message = 'Cannot restore this row: another row already uses its primary key. ' +
          'Delete or rename the conflicting row first.';
      }
      res.status(status).json(payload);
    } finally {
      client.release();
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
      // Self-join to attach (a) the audit entry this row reverts (reverts_audit_id)
      // and (b) the audit entry that reverted this row (reverted_by_*), so the UI
      // can render badges + back-links and disable the Revert button for entries
      // that have already been undone.
      const r = await pool.query(
        `SELECT a.id, a.acted_at, a.admin_email, a.table_name, a.pk, a.op,
                a.before_data, a.after_data, a.reverts_audit_id,
                rb.id        AS reverted_by_id,
                rb.acted_at  AS reverted_by_at,
                rb.admin_email AS reverted_by_email
         FROM db_editor_audit a
         LEFT JOIN db_editor_audit rb ON rb.reverts_audit_id = a.id
         ${whereSql ? whereSql.replace(/\btable_name\b/g, 'a.table_name')
                              .replace(/\badmin_email\b/g, 'a.admin_email') : ''}
         ORDER BY a.acted_at DESC
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
