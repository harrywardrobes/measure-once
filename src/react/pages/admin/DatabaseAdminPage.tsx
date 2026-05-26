/**
 * Admin → Database page (/admin/database)
 *
 * Full React migration of public/database.html (legacy vanilla-JS version retired).
 * Provides:
 *  - Searchable table sidebar with paginated/sortable/filterable row grid
 *  - Insert / Edit (with diff-review step) / Delete drawer
 *  - Blocking-rows display on FK constraint failures
 *  - Paginated audit log with diff expansion and one-click revert
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Skeleton,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import RefreshIcon from '@mui/icons-material/Refresh';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';

// ── Types ─────────────────────────────────────────────────────────────────

interface Column {
  name: string;
  data_type: string;
  is_pk: boolean;
  is_nullable: boolean;
  column_default: unknown;
  read_only?: boolean;
}

interface TableDef {
  name: string;
  group: string;
  pk: string[];
  columns: Column[];
  fkLabels?: Record<string, string>;
  readOnlyTable?: boolean;
}

type RowData = Record<string, unknown>;
type FkResolved = Record<string, Record<string, string>>;

interface AuditRow {
  id: number;
  acted_at: string;
  admin_email: string;
  table_name: string;
  pk: string;
  op: 'insert' | 'update' | 'delete';
  before_data: RowData | null;
  after_data: RowData | null;
  reverted_by_id?: number;
  reverted_by_at?: string;
  reverted_by_email?: string;
  reverts_audit_id?: number;
}

interface BlockingRow {
  pk?: string;
  label?: string;
  row?: RowData;
}

interface BlockingEntry {
  table: string;
  allowed: boolean;
  rows: BlockingRow[];
  total: number;
  refCols: string[];
  targetCols: string[];
}

// ── API helper ────────────────────────────────────────────────────────────

async function apiFetch<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const headers: Record<string, string> = { ...(extraHeaders || {}) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(path, {
    method,
    credentials: 'include',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { window.location.href = '/login'; throw new Error('Unauthenticated'); }
  if (r.status === 403) throw Object.assign(new Error('Admin access required'), { forbidden: true });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw Object.assign(
      new Error((data && (data.message || data.error)) || 'HTTP ' + r.status),
      { serverPayload: data },
    );
  }
  return data as T;
}

// ── Value helpers ──────────────────────────────────────────────────────────

function typeHint(col: Column): string {
  const t = (col.data_type || '').toLowerCase();
  if (t === 'jsonb' || t === 'json') return 'json';
  if (t === 'boolean') return 'bool';
  if (t.includes('timestamp') || t === 'date') return 'date';
  if (['integer', 'bigint', 'smallint', 'numeric', 'real', 'double precision'].includes(t)) return 'number';
  return 'text';
}

function fmtDate(v: unknown): string {
  if (!v) return '';
  try {
    const d = new Date(v as string);
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleString();
  } catch { return String(v); }
}

function pkOf(row: RowData, pk: string[]): string {
  return pk.map(c => String(row[c] ?? '')).join('|');
}

type DiffLine = { type: 'del' | 'add'; text: string };

function diffLines(before: RowData | null, after: RowData | null): DiffLine[] {
  const keys = Array.from(new Set([
    ...Object.keys(before || {}),
    ...Object.keys(after || {}),
  ])).sort();
  const lines: DiffLine[] = [];
  for (const k of keys) {
    const b = before ? before[k] : undefined;
    const a = after ? after[k] : undefined;
    const bs = b === undefined ? '(unset)' : b === null ? 'null' : typeof b === 'object' ? JSON.stringify(b) : String(b);
    const as2 = a === undefined ? '(unset)' : a === null ? 'null' : typeof a === 'object' ? JSON.stringify(a) : String(a);
    if (bs === as2) continue;
    if (before !== null) lines.push({ type: 'del', text: `- ${k}: ${bs}` });
    if (after !== null) lines.push({ type: 'add', text: `+ ${k}: ${as2}` });
  }
  return lines;
}

// Tables that benefit from a cleaner, text-focused diff display.
const IDEA_TABLES = new Set(['ideas', 'idea_comments']);

// Changed-field pairs for structured display (field, before value, after value).
type FieldChange = { field: string; before: string; after: string };

function fieldChanges(before: RowData | null, after: RowData | null): FieldChange[] {
  const keys = Array.from(new Set([
    ...Object.keys(before || {}),
    ...Object.keys(after || {}),
  ])).sort();
  const out: FieldChange[] = [];
  for (const k of keys) {
    const b = before ? before[k] : undefined;
    const a = after ? after[k] : undefined;
    const bs = b === undefined ? '(unset)' : b === null ? 'null' : typeof b === 'object' ? JSON.stringify(b) : String(b);
    const as2 = a === undefined ? '(unset)' : a === null ? 'null' : typeof a === 'object' ? JSON.stringify(a) : String(a);
    if (bs === as2) continue;
    out.push({ field: k, before: before !== null ? bs : '', after: after !== null ? as2 : '' });
  }
  return out;
}

// Structured diff block for ideas / idea_comments — shows field-level before/after
// in a readable way instead of a monospace git-style patch.
function IdeaFieldDiff({ before, after }: { before: RowData | null; after: RowData | null }) {
  const changes = fieldChanges(before, after);
  if (!changes.length) {
    return <Typography variant="caption" color="text.secondary">No diff data.</Typography>;
  }
  return (
    <Stack spacing={1.5}>
      {changes.map(({ field, before: bv, after: av }) => (
        <Box key={field}>
          <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: '0.62rem', display: 'block', mb: 0.5 }}>
            {field}
          </Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: bv && av ? '1fr 1fr' : '1fr', gap: 1 }}>
            {bv && (
              <Box sx={{ bgcolor: '#fff1f2', border: '1px solid #fecdd3', borderRadius: 1, p: 1, fontSize: '0.78rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#9f1239' }}>
                <Typography variant="caption" sx={{ display: 'block', fontWeight: 700, mb: 0.25, color: '#e11d48', fontSize: '0.64rem' }}>Before</Typography>
                {bv}
              </Box>
            )}
            {av && (
              <Box sx={{ bgcolor: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 1, p: 1, fontSize: '0.78rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#14532d' }}>
                <Typography variant="caption" sx={{ display: 'block', fontWeight: 700, mb: 0.25, color: '#16a34a', fontSize: '0.64rem' }}>After</Typography>
                {av}
              </Box>
            )}
          </Box>
        </Box>
      ))}
    </Stack>
  );
}

// Diff block used in the revert confirmation dialog — shows what the row will look like
// after the revert completes, compared to the current state.
function RevertPreviewDiff({ auditRow, tableName }: { auditRow: AuditRow; tableName: string }) {
  // For a revert:
  //   update → restores before_data onto the row (current: after_data, result: before_data)
  //   delete → re-inserts before_data (current: nothing, result: before_data)
  //   insert → deletes the inserted row (current: after_data, result: nothing)
  const [revertFrom, revertTo] = (() => {
    if (auditRow.op === 'update') return [auditRow.after_data, auditRow.before_data];
    if (auditRow.op === 'delete') return [null, auditRow.before_data];
    return [auditRow.after_data, null]; // insert → undo delete
  })();

  if (IDEA_TABLES.has(tableName)) {
    return <IdeaFieldDiff before={revertFrom} after={revertTo} />;
  }
  const lines = diffLines(revertFrom, revertTo);
  if (!lines.length) {
    return <Typography variant="caption" color="text.secondary">No changes to preview.</Typography>;
  }
  return (
    <Box sx={{ fontFamily: 'monospace', fontSize: '0.72rem', bgcolor: 'grey.50', borderRadius: 1, p: 1.5, maxHeight: 280, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      {lines.map((l, i) => (
        <Box key={i} sx={{ color: l.type === 'add' ? '#166534' : '#991b1b', textDecoration: l.type === 'del' ? 'line-through' : 'none' }}>
          {l.text}
        </Box>
      ))}
    </Box>
  );
}

// ── CellValue ─────────────────────────────────────────────────────────────

function CellValue({ col, value, fkResolved }: { col: Column; value: unknown; fkResolved: FkResolved }) {
  if (value === null || value === undefined) {
    return <Typography component="span" variant="caption" sx={{ color: 'text.disabled', fontStyle: 'italic' }}>null</Typography>;
  }
  const t = (col.data_type || '').toLowerCase();
  if (t === 'boolean') {
    const bv = value === true || value === 'true';
    return <Chip size="small" label={bv ? 'true' : 'false'} sx={{ fontSize: '0.65rem', height: 18, bgcolor: bv ? '#dcfce7' : '#f3f4f6', color: bv ? '#166534' : '#6b7280' }} />;
  }
  if (t === 'jsonb' || t === 'json') {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    return (
      <Tooltip title={s} placement="top">
        <Typography component="span" variant="caption" sx={{ fontFamily: 'monospace', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', display: 'inline-block', verticalAlign: 'bottom', color: 'text.secondary' }}>
          {s}
        </Typography>
      </Tooltip>
    );
  }
  if (t.includes('timestamp') || t === 'date') {
    return <Tooltip title={String(value)} placement="top"><span>{fmtDate(value)}</span></Tooltip>;
  }
  const fkMap = fkResolved[col.name];
  if (fkMap && Object.prototype.hasOwnProperty.call(fkMap, String(value))) {
    return (
      <Tooltip title={String(value)} placement="top">
        <Typography component="span" variant="caption">
          {fkMap[String(value)]} <Typography component="span" variant="caption" color="text.disabled">({String(value)})</Typography>
        </Typography>
      </Tooltip>
    );
  }
  const s = String(value);
  return (
    <Tooltip title={s} placement="top">
      <Typography component="span" variant="caption" sx={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', display: 'inline-block', verticalAlign: 'bottom' }}>
        {s}
      </Typography>
    </Tooltip>
  );
}

// ── FieldInput ────────────────────────────────────────────────────────────

function FieldInput({ col, value, onChange, error }: { col: Column; value: string; onChange: (v: string) => void; error?: string }) {
  const t = (col.data_type || '').toLowerCase();
  const label = `${col.name} (${typeHint(col)})${col.is_nullable ? ' · optional' : ''}${col.read_only ? ' · read-only' : ''}`;

  if (col.read_only) {
    return <TextField fullWidth size="small" label={label} value={value} disabled />;
  }
  if (t === 'boolean') {
    return (
      <FormControl fullWidth size="small" error={!!error}>
        <InputLabel>{label}</InputLabel>
        <Select value={value} label={label} onChange={e => onChange(e.target.value as string)}>
          {col.is_nullable && <MenuItem value="">(null)</MenuItem>}
          <MenuItem value="true">true</MenuItem>
          <MenuItem value="false">false</MenuItem>
        </Select>
        {error && <Typography variant="caption" color="error" sx={{ mt: 0.5 }}>{error}</Typography>}
      </FormControl>
    );
  }
  if (t === 'jsonb' || t === 'json') {
    return (
      <TextField
        fullWidth size="small" multiline minRows={3} label={label} value={value}
        onChange={e => onChange(e.target.value)} error={!!error} helperText={error}
        placeholder="JSON value"
        sx={{ '& textarea': { fontFamily: 'monospace', fontSize: '0.8rem' } }}
      />
    );
  }
  if (t.includes('timestamp') || t === 'date') {
    return (
      <TextField
        fullWidth size="small" label={label} type="datetime-local" value={value}
        onChange={e => onChange(e.target.value)} error={!!error} helperText={error}
        sx={{ '& label': { transform: value ? 'translate(14px, -9px) scale(0.75)' : undefined } }}
      />
    );
  }
  if (['integer', 'bigint', 'smallint', 'numeric', 'real', 'double precision'].includes(t)) {
    return (
      <TextField fullWidth size="small" label={label} type="number" value={value}
        onChange={e => onChange(e.target.value)} error={!!error} helperText={error} />
    );
  }
  const isLong = value.length > 80 || value.includes('\n');
  return (
    <TextField fullWidth size="small" label={label} multiline={isLong} minRows={isLong ? 3 : undefined}
      value={value} onChange={e => onChange(e.target.value)} error={!!error} helperText={error} />
  );
}

// ── RowDrawer ─────────────────────────────────────────────────────────────

type DrawerMode = 'insert' | 'edit' | 'delete';

interface DrawerState {
  mode: DrawerMode | null;
  table: TableDef | null;
  row: RowData | null;
}

const DRAWER_PAPER_SX = {
  '& .MuiDrawer-paper': {
    width: 480,
    maxWidth: '100%',
    p: 3,
    display: 'flex',
    flexDirection: 'column',
  },
};

function initFieldValues(table: TableDef, row: RowData | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of table.columns) {
    const v = row ? row[c.name] : c.column_default;
    if (v === null || v === undefined) { out[c.name] = ''; continue; }
    const t = (c.data_type || '').toLowerCase();
    if (t === 'jsonb' || t === 'json') {
      out[c.name] = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
    } else if (t.includes('timestamp') || t === 'date') {
      try {
        const d = new Date(v as string);
        if (!isNaN(d.getTime())) {
          const p = (n: number) => String(n).padStart(2, '0');
          out[c.name] = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
        } else { out[c.name] = String(v); }
      } catch { out[c.name] = String(v); }
    } else if (t === 'boolean') {
      out[c.name] = v === true ? 'true' : v === false ? 'false' : '';
    } else {
      out[c.name] = String(v);
    }
  }
  return out;
}

function parseFieldValue(col: Column, raw: string, mode: 'insert' | 'edit'): unknown {
  const t = (col.data_type || '').toLowerCase();
  if (raw === '' && mode === 'insert') return undefined;
  if (raw === '' && col.is_nullable) return null;
  if (raw === '' && (t === 'jsonb' || t === 'json' || t === 'boolean')) return null;
  if (t === 'boolean') return raw === 'true' ? true : raw === 'false' ? false : null;
  if (t === 'jsonb' || t === 'json') { return raw.trim() === '' ? null : JSON.parse(raw); }
  if (t.includes('timestamp') || t === 'date') return raw ? new Date(raw).toISOString() : null;
  return raw;
}

function RowDrawer({
  state, onClose, onSuccess, onNavigate,
}: {
  state: DrawerState;
  onClose: () => void;
  onSuccess: (msg: string) => void;
  onNavigate: (tableName: string, filters: Array<{ column: string; value: string }>) => void;
}) {
  const { mode, table, row } = state;
  const [fields, setFields] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [bannerErr, setBannerErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [blocking, setBlocking] = useState<BlockingEntry[] | null>(null);
  // Confirm-edit step: non-null = diff-review screen
  const [pendingChanges, setPendingChanges] = useState<RowData | null>(null);

  useEffect(() => {
    setBannerErr(''); setErrors({}); setBlocking(null); setDeleteConfirm(''); setPendingChanges(null); setSaving(false);
    if (!table) { setFields({}); return; }
    setFields(initFieldValues(table, mode === 'edit' ? row : null));
  }, [mode, table, row]);

  if (!mode || !table) return null;

  const pkVal = row ? pkOf(row, table.pk) : '';

  function setField(name: string, v: string) {
    setFields(prev => ({ ...prev, [name]: v }));
    if (errors[name]) setErrors(prev => { const n = { ...prev }; delete n[name]; return n; });
  }

  function readAllFields(m: 'insert' | 'edit'): RowData | null {
    const out: RowData = {};
    for (const c of table!.columns) {
      if (c.read_only) continue;
      const raw = fields[c.name] ?? '';
      try {
        const v = parseFieldValue(c, raw, m);
        if (v !== undefined) out[c.name] = v;
      } catch (e) {
        setErrors(prev => ({ ...prev, [c.name]: 'Invalid JSON: ' + (e as Error).message }));
        return null;
      }
    }
    return out;
  }

  function validateRequired(body: RowData, m: 'insert' | 'edit'): boolean {
    for (const c of table!.columns) {
      if (c.read_only || c.is_nullable) continue;
      if (c.column_default !== null && c.column_default !== undefined) continue;
      if (m === 'edit' && c.is_pk) continue;
      const present = Object.prototype.hasOwnProperty.call(body, c.name) && body[c.name] !== null && body[c.name] !== '';
      if (!present) {
        setErrors(prev => ({ ...prev, [c.name]: `"${c.name}" is required.` }));
        return false;
      }
    }
    return true;
  }

  async function handleInsert() {
    setBannerErr(''); setErrors({});
    const body = readAllFields('insert');
    if (!body) return;
    if (!validateRequired(body, 'insert')) return;
    setSaving(true);
    try {
      await apiFetch('POST', `/api/admin/db/${encodeURIComponent(table!.name)}/rows`, body);
      onSuccess('Row inserted.');
    } catch (e: unknown) {
      const p = (e as { serverPayload?: Record<string, string> }).serverPayload;
      const msg = (p && (p.message || p.error)) || (e as Error).message;
      if (p?.column) setErrors(prev => ({ ...prev, [p.column]: msg }));
      else setBannerErr(msg);
    } finally { setSaving(false); }
  }

  function handleEditReview() {
    setBannerErr(''); setErrors({});
    const next = readAllFields('edit');
    if (!next) return;
    if (!validateRequired({ ...row, ...next }, 'edit')) return;
    const changes: RowData = {};
    for (const c of table!.columns) {
      if (c.read_only || c.is_pk) continue;
      if (!Object.prototype.hasOwnProperty.call(next, c.name)) continue;
      let oldV = row ? row[c.name] : undefined;
      const newV = next[c.name];
      const dt = (c.data_type || '').toLowerCase();
      if (dt === 'jsonb' || dt === 'json') {
        try { if (typeof oldV === 'string') oldV = JSON.parse(oldV); } catch {}
        if (JSON.stringify(oldV) === JSON.stringify(newV)) continue;
      } else if (String(oldV ?? '') === String(newV ?? '')) {
        continue;
      }
      changes[c.name] = newV;
    }
    if (!Object.keys(changes).length) { setBannerErr('No changes to save.'); return; }
    setPendingChanges(changes); // transitions to diff-review screen (drawer stays open)
  }

  async function handleEditSave() {
    if (!pendingChanges) return;
    setSaving(true); setBannerErr('');
    try {
      await apiFetch('PATCH', `/api/admin/db/${encodeURIComponent(table!.name)}/rows/${encodeURIComponent(pkVal)}`, pendingChanges);
      onSuccess('Row updated.');
    } catch (e: unknown) {
      const p = (e as { serverPayload?: Record<string, string> }).serverPayload;
      const msg = (p && (p.message || p.error)) || (e as Error).message;
      setBannerErr(msg); setPendingChanges(null); // back to edit form
    } finally { setSaving(false); }
  }

  async function handleDelete() {
    setSaving(true); setBlocking(null); setBannerErr('');
    try {
      await apiFetch('DELETE', `/api/admin/db/${encodeURIComponent(table!.name)}/rows/${encodeURIComponent(pkVal)}`, undefined, { 'X-Confirm-Pk': pkVal });
      onSuccess('Row deleted.');
    } catch (e: unknown) {
      const p = (e as { serverPayload?: Record<string, string | BlockingEntry[]> }).serverPayload;
      const msg = (p && (p.message || p.error)) || (e as Error).message;
      setBannerErr(msg as string);
      if (p?.blockingSample) setBlocking(p.blockingSample as BlockingEntry[]);
    } finally { setSaving(false); }
  }

  // ── Diff-review step ─────────────────────────────────────────────────
  if (pendingChanges) {
    const before: RowData = {};
    const after: RowData = {};
    for (const k of Object.keys(pendingChanges)) { before[k] = row ? row[k] : undefined; after[k] = pendingChanges[k]; }
    const lines = diffLines(before, after);
    return (
      <Drawer anchor="right" open sx={DRAWER_PAPER_SX}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 2 }}>
          <Box>
            <Typography variant="h6">Confirm changes · {table.name}</Typography>
            <Typography variant="caption" color="text.secondary">PK: {pkVal}</Typography>
          </Box>
          <IconButton size="small" onClick={() => setPendingChanges(null)} disabled={saving}><CloseIcon fontSize="small" /></IconButton>
        </Box>
        {bannerErr && <Alert severity="error" sx={{ mb: 2 }}>{bannerErr}</Alert>}
        <Box sx={{ fontFamily: 'monospace', fontSize: '0.75rem', bgcolor: 'grey.50', borderRadius: 1, p: 1.5, mb: 2, maxHeight: 240, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1 }}>
          {lines.length === 0
            ? <Box sx={{ color: 'text.secondary' }}>No changes.</Box>
            : lines.map((l, i) => (
              <Box key={i} sx={{ color: l.type === 'add' ? '#166534' : '#991b1b', textDecoration: l.type === 'del' ? 'line-through' : 'none' }}>
                {l.text}
              </Box>
            ))}
        </Box>
        <Box sx={{ pt: 2, borderTop: 1, borderColor: 'divider', display: 'flex', gap: 1 }}>
          <Button variant="contained" onClick={handleEditSave} disabled={saving || lines.length === 0}>
            {saving ? <CircularProgress size={18} /> : 'Save'}
          </Button>
          <Button variant="outlined" onClick={() => setPendingChanges(null)} disabled={saving}>Back</Button>
        </Box>
      </Drawer>
    );
  }

  // ── Main drawer ───────────────────────────────────────────────────────
  return (
    <Drawer anchor="right" open onClose={saving ? undefined : onClose} sx={DRAWER_PAPER_SX}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1.5 }}>
        <Box>
          <Typography variant="h6">
            {mode === 'insert' ? 'Add row' : mode === 'edit' ? 'Edit row' : 'Delete row'} · {table.name}
          </Typography>
          {mode !== 'insert' && <Typography variant="caption" color="text.secondary">PK: {pkVal}</Typography>}
          {mode === 'insert' && <Typography variant="caption" color="text.secondary">Leave optional fields blank to use the database default.</Typography>}
        </Box>
        <IconButton size="small" onClick={onClose} disabled={saving}><CloseIcon fontSize="small" /></IconButton>
      </Box>

      {bannerErr && <Alert severity="error" sx={{ mb: 1.5 }}>{bannerErr}</Alert>}

      {(mode === 'insert' || mode === 'edit') && (
        <Box sx={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1.5, pb: 1 }}>
          {table.columns.map(c =>
            c.read_only && mode === 'insert' ? null : (
              <FieldInput key={c.name} col={c} value={fields[c.name] ?? ''}
                onChange={v => setField(c.name, v)} error={errors[c.name]} />
            ),
          )}
        </Box>
      )}

      {mode === 'delete' && (
        <Box sx={{ flex: 1, overflowY: 'auto' }}>
          <Alert severity="warning" sx={{ mb: 2 }}>
            This will permanently remove the row from <strong>{table.name}</strong>.
          </Alert>
          <Typography variant="body2" sx={{ mb: 1 }}>
            Type the primary key <strong>{pkVal}</strong> to confirm:
          </Typography>
          <TextField fullWidth size="small" autoComplete="off" value={deleteConfirm}
            onChange={e => setDeleteConfirm(e.target.value)} placeholder={pkVal} />

          {blocking && blocking.length > 0 && (
            <Box sx={{ mt: 2 }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                Blocking rows — remove or reassign these first, then try again:
              </Typography>
              {blocking.map((entry, gi) => (
                <Box key={gi} sx={{ mt: 1, p: 1.5, border: 1, borderColor: 'divider', borderRadius: 1 }}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {entry.table}
                      {!entry.allowed && <Typography component="span" variant="caption" color="text.secondary"> (not editable here)</Typography>}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">{entry.total} row{entry.total === 1 ? '' : 's'}</Typography>
                  </Box>
                  {entry.rows.map((br, ri) => {
                    const filters = (entry.refCols || []).map((col, ci) => {
                      const targetCol = (entry.targetCols || [])[ci];
                      const val = br.row ? br.row[col] : (row && targetCol ? row[targetCol] : null);
                      return { column: col, value: val == null ? '' : String(val) };
                    });
                    return (
                      <Box key={ri} sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', pt: 0.5, mt: 0.5, borderTop: 1, borderColor: 'divider' }}>
                        <Typography variant="caption">
                          {br.label || '(no label)'}
                          {br.pk && <Typography component="span" variant="caption" color="text.secondary"> pk={br.pk}</Typography>}
                        </Typography>
                        {entry.allowed && br.pk && (
                          <Button size="small" variant="outlined" sx={{ fontSize: '0.7rem', py: 0.25, px: 1 }}
                            onClick={() => { onClose(); onNavigate(entry.table, filters); }}>
                            Open in editor
                          </Button>
                        )}
                      </Box>
                    );
                  })}
                  {entry.allowed && (
                    <Button size="small" sx={{ mt: 0.5, fontSize: '0.7rem' }}
                      onClick={() => {
                        const filters = (entry.refCols || []).map((col, ci) => {
                          const targetCol = (entry.targetCols || [])[ci];
                          const val = row && targetCol ? row[targetCol] : null;
                          return { column: col, value: val == null ? '' : String(val) };
                        });
                        onClose(); onNavigate(entry.table, filters);
                      }}>
                      {entry.total > entry.rows.length ? `View all ${entry.total} in "${entry.table}"` : `Open "${entry.table}" filtered`}
                    </Button>
                  )}
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )}

      <Box sx={{ mt: 'auto', pt: 2, borderTop: 1, borderColor: 'divider', display: 'flex', gap: 1 }}>
        {mode === 'insert' && (
          <>
            <Button variant="contained" onClick={handleInsert} disabled={saving}>
              {saving ? <CircularProgress size={18} /> : 'Insert'}
            </Button>
            <Button variant="outlined" onClick={onClose} disabled={saving}>Cancel</Button>
          </>
        )}
        {mode === 'edit' && (
          <>
            <Button variant="contained" onClick={handleEditReview} disabled={saving}>
              {saving ? <CircularProgress size={18} /> : 'Review changes'}
            </Button>
            <Button variant="outlined" onClick={onClose} disabled={saving}>Cancel</Button>
          </>
        )}
        {mode === 'delete' && (
          <>
            <Button variant="contained" color="error" onClick={handleDelete} disabled={saving || deleteConfirm !== pkVal}>
              {saving ? <CircularProgress size={18} /> : 'Delete row'}
            </Button>
            <Button variant="outlined" onClick={onClose} disabled={saving}>Cancel</Button>
          </>
        )}
      </Box>
    </Drawer>
  );
}

// ── TableBrowser ──────────────────────────────────────────────────────────

interface RowMeta {
  page: number;
  pageSize: number;
  total: number;
  sort: string;
  dir: 'asc' | 'desc';
  search: string;
  filters: Array<{ column: string; value: string }>;
}

interface JumpRequest {
  tableName: string;
  filters: Array<{ column: string; value: string }>;
  seq: number;
}

function TableBrowser({
  tables, jumpRequest, onToast,
}: {
  tables: TableDef[];
  jumpRequest: JumpRequest | null;
  onToast: (msg: string, err?: boolean) => void;
}) {
  const [sidebarSearch, setSidebarSearch] = useState('');
  const [selectedTable, setSelectedTable] = useState<TableDef | null>(null);
  const [rows, setRows] = useState<RowData[]>([]);
  const [columns, setColumns] = useState<Column[]>([]);
  const [fkResolved, setFkResolved] = useState<FkResolved>({});
  const [meta, setMeta] = useState<RowMeta>({ page: 1, pageSize: 50, total: 0, sort: '', dir: 'asc', search: '', filters: [] });
  const [loading, setLoading] = useState(false);
  const [rowSearch, setRowSearch] = useState('');
  const rowSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [drawer, setDrawer] = useState<DrawerState>({ mode: null, table: null, row: null });

  const grouped: Record<string, TableDef[]> = {};
  const q = sidebarSearch.trim().toLowerCase();
  for (const t of tables) {
    if (q && !t.name.toLowerCase().includes(q) && !t.group.toLowerCase().includes(q)) continue;
    (grouped[t.group] = grouped[t.group] || []).push(t);
  }
  const groups = Object.keys(grouped).sort();

  const loadRows = useCallback(async (table: TableDef, m: RowMeta) => {
    setLoading(true);
    const params = new URLSearchParams({ search: m.search, sort: m.sort, dir: m.dir, page: String(m.page), pageSize: String(m.pageSize) });
    for (const f of (m.filters || [])) {
      if (!f?.column) continue;
      params.append('fcol', f.column);
      params.append('fval', f.value == null ? '' : String(f.value));
    }
    try {
      const data = await apiFetch<{ rows: RowData[]; total: number; columns: Column[]; fkResolved: FkResolved }>(
        'GET', `/api/admin/db/${encodeURIComponent(table.name)}/rows?${params}`,
      );
      setRows(data.rows || []);
      setColumns(data.columns || table.columns);
      setFkResolved(data.fkResolved || {});
      setMeta(prev => ({ ...prev, total: data.total || 0 }));
    } catch (e: unknown) {
      onToast((e as Error).message, true);
    } finally { setLoading(false); }
  }, [onToast]);

  function selectTable(table: TableDef, overrides?: Partial<RowMeta>) {
    const newMeta: RowMeta = { page: 1, pageSize: 50, total: 0, sort: table.pk[0] || '', dir: 'asc', search: '', filters: [], ...(overrides || {}) };
    setSelectedTable(table);
    setRowSearch(newMeta.search);
    setMeta(newMeta);
    loadRows(table, newMeta);
  }

  const lastJumpSeq = useRef(-1);
  useEffect(() => {
    if (!jumpRequest || jumpRequest.seq === lastJumpSeq.current) return;
    lastJumpSeq.current = jumpRequest.seq;
    const t = tables.find(x => x.name === jumpRequest.tableName);
    if (t) selectTable(t, { filters: jumpRequest.filters });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpRequest, tables]);

  function handleSort(col: string) {
    if (!selectedTable) return;
    const newMeta = { ...meta, page: 1, sort: col, dir: (meta.sort === col && meta.dir === 'asc' ? 'desc' : 'asc') as 'asc' | 'desc' };
    setMeta(newMeta); loadRows(selectedTable, newMeta);
  }

  function handlePage(delta: number) {
    if (!selectedTable) return;
    const newMeta = { ...meta, page: meta.page + delta };
    setMeta(newMeta); loadRows(selectedTable, newMeta);
  }

  function handleRowSearchChange(v: string) {
    setRowSearch(v);
    if (rowSearchTimer.current) clearTimeout(rowSearchTimer.current);
    rowSearchTimer.current = setTimeout(() => {
      if (!selectedTable) return;
      const newMeta = { ...meta, search: v, page: 1 };
      setMeta(newMeta); loadRows(selectedTable, newMeta);
    }, 300);
  }

  function removeFilter(i: number) {
    if (!selectedTable) return;
    const newMeta = { ...meta, filters: meta.filters.filter((_, j) => j !== i), page: 1 };
    setMeta(newMeta); loadRows(selectedTable, newMeta);
  }

  function clearFilters() {
    if (!selectedTable) return;
    const newMeta = { ...meta, filters: [], page: 1 };
    setMeta(newMeta); loadRows(selectedTable, newMeta);
  }

  const pageCount = Math.max(1, Math.ceil(meta.total / meta.pageSize));
  const isReadOnly = !!selectedTable?.readOnlyTable;

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '240px 1fr' }, gap: 2, alignItems: 'start' }}>
      {/* Sidebar */}
      <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 1.5, maxHeight: '80vh', overflowY: 'auto', position: 'sticky', top: 16, bgcolor: 'background.paper' }}>
        <TextField fullWidth size="small" placeholder="Search tables…" value={sidebarSearch} onChange={e => setSidebarSearch(e.target.value)} sx={{ mb: 1.5 }} />
        {groups.length === 0
          ? <Typography variant="caption" color="text.secondary">No tables match.</Typography>
          : groups.map(g => (
            <Box key={g}>
              <Typography variant="caption" sx={{ fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'text.disabled', display: 'block', mt: 1.5, mb: 0.5 }}>
                {g}
              </Typography>
              {grouped[g].map(t => (
                <Box key={t.name} component="button" onClick={() => selectTable(t)}
                  sx={{
                    width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer',
                    p: '5px 8px', borderRadius: 1, fontFamily: 'inherit', fontSize: '0.82rem', display: 'block',
                    bgcolor: selectedTable?.name === t.name ? 'primary.main' : 'transparent',
                    color: selectedTable?.name === t.name ? 'primary.contrastText' : 'text.secondary',
                    fontWeight: selectedTable?.name === t.name ? 600 : 400,
                    transition: 'background 0.12s',
                    '&:hover': { bgcolor: selectedTable?.name === t.name ? 'primary.main' : 'action.hover' },
                  }}>
                  {t.name}
                </Box>
              ))}
            </Box>
          ))}
      </Box>

      {/* Main content */}
      <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 2, minHeight: 300, bgcolor: 'background.paper' }}>
        {!selectedTable ? (
          <Typography color="text.secondary" sx={{ textAlign: 'center', py: 4 }}>Select a table from the sidebar.</Typography>
        ) : (
          <>
            <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, justifyContent: 'space-between', alignItems: { sm: 'flex-start' }, mb: 1.5, gap: 1, flexWrap: 'wrap' }}>
              <Box>
                <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                  {selectedTable.name}
                  {isReadOnly && <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>(read-only)</Typography>}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {meta.total} row{meta.total === 1 ? '' : 's'} · PK: {selectedTable.pk.join(', ')}
                </Typography>
                {meta.filters.length > 0 && (
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.5, mt: 0.5 }}>
                    <Typography variant="caption" color="text.secondary">Filtered to:</Typography>
                    {meta.filters.map((f, i) => (
                      <Chip key={i} size="small" label={`${f.column} = ${f.value}`} onDelete={() => removeFilter(i)} sx={{ fontSize: '0.7rem', height: 20 }} />
                    ))}
                    <Button size="small" sx={{ fontSize: '0.7rem', py: 0.25 }} onClick={clearFilters}>Clear all</Button>
                  </Box>
                )}
              </Box>
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexShrink: 0 }}>
                <TextField size="small" placeholder="Search text columns…" value={rowSearch} onChange={e => handleRowSearchChange(e.target.value)} sx={{ width: 200 }} />
                {!isReadOnly && (
                  <Button variant="contained" size="small" startIcon={<AddIcon />}
                    onClick={() => setDrawer({ mode: 'insert', table: selectedTable, row: null })}>
                    Add row
                  </Button>
                )}
              </Box>
            </Box>

            <Box sx={{ overflowX: 'auto', border: 1, borderColor: 'divider', borderRadius: 1 }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    {columns.map(c => (
                      <TableCell key={c.name} onClick={() => handleSort(c.name)}
                        sx={{ cursor: 'pointer', whiteSpace: 'nowrap', bgcolor: 'grey.50', fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'text.secondary', userSelect: 'none' }}>
                        <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                          <span>{c.name}</span>
                          <Typography component="span" variant="caption" color="text.disabled" sx={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>{typeHint(c)}</Typography>
                          {c.is_pk && <Typography component="span" variant="caption" color="primary" sx={{ fontSize: '0.62rem' }}>PK</Typography>}
                          {meta.sort === c.name && (meta.dir === 'asc' ? <ArrowUpwardIcon sx={{ fontSize: '0.8rem' }} /> : <ArrowDownwardIcon sx={{ fontSize: '0.8rem' }} />)}
                        </Box>
                      </TableCell>
                    ))}
                    {!isReadOnly && <TableCell sx={{ bgcolor: 'grey.50', width: 120 }} />}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {loading ? (
                    <TableRow><TableCell colSpan={columns.length + (isReadOnly ? 0 : 1)}><Skeleton height={80} /></TableCell></TableRow>
                  ) : rows.length === 0 ? (
                    <TableRow><TableCell colSpan={columns.length + (isReadOnly ? 0 : 1)}>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textAlign: 'center', py: 2 }}>No rows.</Typography>
                    </TableCell></TableRow>
                  ) : rows.map((row, ri) => (
                    <TableRow key={ri} hover>
                      {columns.map(c => (
                        <TableCell key={c.name} sx={{ whiteSpace: 'nowrap', fontSize: '0.8rem', verticalAlign: 'top' }}>
                          <CellValue col={c} value={row[c.name]} fkResolved={fkResolved} />
                        </TableCell>
                      ))}
                      {!isReadOnly && (
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>
                          <Box sx={{ display: 'flex', gap: 0.5 }}>
                            <Button size="small" variant="outlined" sx={{ fontSize: '0.72rem', py: 0.25, px: 1 }}
                              onClick={() => setDrawer({ mode: 'edit', table: selectedTable, row })}>
                              Edit
                            </Button>
                            <Button size="small" variant="outlined" color="error" sx={{ fontSize: '0.72rem', py: 0.25, px: 1 }}
                              onClick={() => setDrawer({ mode: 'delete', table: selectedTable, row })}>
                              Delete
                            </Button>
                          </Box>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>

            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, pt: 1.5 }}>
              <Button size="small" variant="outlined" disabled={meta.page <= 1} onClick={() => handlePage(-1)}>Prev</Button>
              <Typography variant="caption">Page {meta.page} / {pageCount}</Typography>
              <Button size="small" variant="outlined" disabled={meta.page >= pageCount} onClick={() => handlePage(1)}>Next</Button>
            </Box>
          </>
        )}
      </Box>

      <RowDrawer
        state={drawer}
        onClose={() => setDrawer({ mode: null, table: null, row: null })}
        onSuccess={(msg) => {
          onToast(msg);
          setDrawer({ mode: null, table: null, row: null });
          if (selectedTable) loadRows(selectedTable, meta);
        }}
        onNavigate={(tableName, filters) => {
          const t = tables.find(x => x.name === tableName);
          if (t) selectTable(t, { filters });
        }}
      />
    </Box>
  );
}

// ── AuditLog ──────────────────────────────────────────────────────────────

function AuditLog({
  tables, onToast, onNavigate,
}: {
  tables: TableDef[];
  onToast: (msg: string, err?: boolean) => void;
  onNavigate: (tableName: string, filters: Array<{ column: string; value: string }>) => void;
}) {
  const [tableFilter, setTableFilter] = useState('');
  const [adminFilter, setAdminFilter] = useState('');
  const [page, setPage] = useState(1);
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [pageSz, setPageSz] = useState(50);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [revertingId, setRevertingId] = useState<number | null>(null);
  const [revertErrors, setRevertErrors] = useState<Record<number, string>>({});
  const [revertPending, setRevertPending] = useState<AuditRow | null>(null);
  const debRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tablesByName = new Map(tables.map(t => [t.name, t]));

  const fetchAudit = useCallback(async (p: number, tbl: string, admin: string) => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(p), pageSize: '50' });
    if (tbl) params.set('table', tbl);
    if (admin.trim()) params.set('admin', admin.trim());
    try {
      const data = await apiFetch<{ rows: AuditRow[]; total: number; pageSize: number }>('GET', '/api/admin/db/audit?' + params);
      setAuditRows(data.rows || []);
      setTotal(data.total || 0);
      setPageSz(data.pageSize || 50);
    } catch (e: unknown) {
      onToast((e as Error).message, true);
    } finally { setLoading(false); }
  }, [onToast]);

  useEffect(() => { fetchAudit(1, '', ''); }, [fetchAudit]);

  function handleTableFilter(v: string) { setTableFilter(v); setPage(1); fetchAudit(1, v, adminFilter); }
  function handleAdminFilter(v: string) {
    setAdminFilter(v);
    if (debRef.current) clearTimeout(debRef.current);
    debRef.current = setTimeout(() => { setPage(1); fetchAudit(1, tableFilter, v); }, 350);
  }

  function toggleExpand(id: number) {
    setExpanded(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  async function confirmRevert() {
    if (!revertPending) return;
    const row = revertPending;
    setRevertPending(null);
    setRevertingId(row.id);
    setRevertErrors(prev => { const n = { ...prev }; delete n[row.id]; return n; });
    try {
      await apiFetch('POST', `/api/admin/db/audit/${encodeURIComponent(row.id)}/revert`);
      onToast('Reverted. A new audit entry has been recorded.');
      fetchAudit(page, tableFilter, adminFilter);
    } catch (e: unknown) {
      setRevertErrors(prev => ({ ...prev, [row.id]: (e as Error).message }));
    } finally { setRevertingId(null); }
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSz));

  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 2, bgcolor: 'background.paper' }}>
      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, justifyContent: 'space-between', alignItems: { sm: 'center' }, mb: 2, gap: 1 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Audit log</Typography>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          <FormControl size="small" sx={{ minWidth: 160 }}>
            <InputLabel>All tables</InputLabel>
            <Select value={tableFilter} label="All tables" onChange={e => handleTableFilter(e.target.value as string)}>
              <MenuItem value="">All tables</MenuItem>
              {tables.map(t => <MenuItem key={t.name} value={t.name}>{t.name}</MenuItem>)}
            </Select>
          </FormControl>
          <TextField size="small" placeholder="Filter by admin email…" value={adminFilter} onChange={e => handleAdminFilter(e.target.value)} sx={{ width: 220 }} />
          <Button size="small" variant="outlined" startIcon={<RefreshIcon />} onClick={() => fetchAudit(page, tableFilter, adminFilter)}>
            Refresh
          </Button>
        </Box>
      </Box>

      {loading ? (
        <Skeleton variant="rectangular" height={200} />
      ) : auditRows.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 4 }}>No audit entries.</Typography>
      ) : (
        <Stack divider={<Divider />} spacing={0}>
          {auditRows.map(row => {
            const meta = tablesByName.get(row.table_name);
            const alreadyReverted = !!row.reverted_by_id;
            const revertLabel = row.op === 'delete' ? 'Restore row' : row.op === 'insert' ? 'Undo insert' : 'Revert change';
            const isExpanded = expanded.has(row.id);
            const lines = diffLines(row.before_data, row.after_data);

            return (
              <Box key={row.id} id={`audit-row-${row.id}`} sx={{ py: 1.5 }}>
                <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: 2 }}>
                  <Box sx={{ minWidth: 160 }}>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{fmtDate(row.acted_at)}</Typography>
                    <Typography variant="caption" color="text.secondary">{row.admin_email}</Typography>
                  </Box>
                  <Box sx={{ minWidth: 80 }}>
                    <Chip size="small" label={row.op} sx={{
                      fontSize: '0.65rem', height: 18, fontWeight: 700, textTransform: 'uppercase',
                      bgcolor: row.op === 'insert' ? '#dcfce7' : row.op === 'delete' ? '#fee2e2' : '#dbeafe',
                      color: row.op === 'insert' ? '#166534' : row.op === 'delete' ? '#991b1b' : '#1e40af',
                    }} />
                  </Box>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body2">
                      <strong>{row.table_name}</strong>{' '}
                      <Typography component="span" variant="caption" color="text.secondary">pk={row.pk}</Typography>
                    </Typography>

                    {row.reverts_audit_id && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        Reverts{' '}
                        <Box component="a" href={`#audit-row-${row.reverts_audit_id}`} sx={{ color: 'primary.main', textDecoration: 'none', fontWeight: 600, '&:hover': { textDecoration: 'underline' } }}>
                          #{row.reverts_audit_id}
                        </Box>
                      </Typography>
                    )}

                    {alreadyReverted && (
                      <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, bgcolor: '#fef3c7', color: '#78350f', border: '1px solid #fde68a', borderRadius: '999px', px: 1, py: 0.25, fontSize: '0.68rem', fontWeight: 600, mt: 0.5 }}>
                        ↩ Reverted {fmtDate(row.reverted_by_at)} by {row.reverted_by_email || 'unknown'} ·{' '}
                        <Box component="a" href={`#audit-row-${row.reverted_by_id}`} sx={{ color: '#78350f', textDecoration: 'underline', fontWeight: 700 }}>
                          View revert #{row.reverted_by_id}
                        </Box>
                      </Box>
                    )}

                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5, flexWrap: 'wrap' }}>
                      <Button size="small" sx={{ fontSize: '0.7rem', p: '1px 8px' }}
                        endIcon={isExpanded ? <ExpandLessIcon sx={{ fontSize: '0.85rem !important' }} /> : <ExpandMoreIcon sx={{ fontSize: '0.85rem !important' }} />}
                        onClick={() => toggleExpand(row.id)}>
                        {isExpanded ? 'Hide diff' : 'Show diff'}
                      </Button>

                      {(!meta || meta.readOnlyTable) ? (
                        <Typography variant="caption" color="text.secondary" sx={{ fontStyle: 'italic' }}>Revert unavailable</Typography>
                      ) : alreadyReverted ? (
                        <Tooltip title={`Already reverted by audit #${row.reverted_by_id}. A second revert would undo the revert, not the original change.`}>
                          <Typography variant="caption" color="text.secondary" sx={{ fontStyle: 'italic', cursor: 'help' }}>
                            {revertLabel} (already reverted)
                          </Typography>
                        </Tooltip>
                      ) : (
                        <Button size="small" variant="outlined" sx={{ fontSize: '0.7rem', p: '1px 10px' }}
                          disabled={revertingId === row.id}
                          onClick={() => setRevertPending(row)}>
                          {revertingId === row.id ? <CircularProgress size={14} /> : revertLabel}
                        </Button>
                      )}
                    </Box>

                    {revertErrors[row.id] && <Alert severity="error" sx={{ mt: 0.5, py: 0.25 }}>{revertErrors[row.id]}</Alert>}

                    {isExpanded && (
                      <Box sx={{ mt: 0.75, maxHeight: 280, overflowY: 'auto' }}>
                        {IDEA_TABLES.has(row.table_name) ? (
                          <IdeaFieldDiff before={row.before_data} after={row.after_data} />
                        ) : (
                          <Box sx={{ fontFamily: 'monospace', fontSize: '0.72rem', bgcolor: 'grey.50', borderRadius: 1, p: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                            {lines.length === 0
                              ? <Box sx={{ color: 'text.secondary' }}>No diff data.</Box>
                              : lines.map((l, i) => (
                                <Box key={i} sx={{ color: l.type === 'add' ? '#166534' : '#991b1b', textDecoration: l.type === 'del' ? 'line-through' : 'none' }}>
                                  {l.text}
                                </Box>
                              ))}
                          </Box>
                        )}
                      </Box>
                    )}
                  </Box>
                </Box>
              </Box>
            );
          })}
        </Stack>
      )}

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, pt: 1.5 }}>
        <Button size="small" variant="outlined" disabled={page <= 1} onClick={() => { const p = page - 1; setPage(p); fetchAudit(p, tableFilter, adminFilter); }}>Prev</Button>
        <Typography variant="caption">Page {page} / {pageCount}</Typography>
        <Button size="small" variant="outlined" disabled={page >= pageCount} onClick={() => { const p = page + 1; setPage(p); fetchAudit(p, tableFilter, adminFilter); }}>Next</Button>
      </Box>

      {/* Revert confirmation Dialog */}
      <Dialog
        open={!!revertPending}
        onClose={() => setRevertPending(null)}
        maxWidth="sm"
        fullWidth
      >
        {revertPending && (
          <>
            <DialogTitle sx={{ pb: 1 }}>
              {revertPending.op === 'delete'
                ? `Restore deleted row — ${revertPending.table_name}`
                : revertPending.op === 'insert'
                  ? `Undo insert — ${revertPending.table_name}`
                  : `Revert change — ${revertPending.table_name}`}
            </DialogTitle>
            <DialogContent dividers>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                {revertPending.op === 'delete'
                  ? `This will re-insert the row that was deleted (pk=${revertPending.pk}). The row will be restored to its state at the time of deletion.`
                  : revertPending.op === 'insert'
                    ? `This will delete the row that was inserted (pk=${revertPending.pk}). The row will be permanently removed.`
                    : `This will restore the row (pk=${revertPending.pk}) to its state before this edit was made.`}
              </Typography>
              <Typography variant="caption" sx={{ fontWeight: 700, display: 'block', mb: 1, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: '0.65rem' }}>
                {revertPending.op === 'delete' ? 'Row to restore' : revertPending.op === 'insert' ? 'Row to remove' : 'What will change'}
              </Typography>
              <RevertPreviewDiff auditRow={revertPending} tableName={revertPending.table_name} />
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setRevertPending(null)}>Cancel</Button>
              <Button
                variant="contained"
                color={revertPending.op === 'insert' ? 'error' : 'primary'}
                onClick={confirmRevert}
                disabled={!!revertingId}
              >
                {revertingId
                  ? <CircularProgress size={18} />
                  : revertPending.op === 'delete' ? 'Restore row' : revertPending.op === 'insert' ? 'Undo insert' : 'Revert change'}
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>
    </Box>
  );
}

// ── Toast ─────────────────────────────────────────────────────────────────

function useToast(): [{ open: boolean; msg: string; err: boolean }, (msg: string, err?: boolean) => void] {
  const [state, setState] = useState({ open: false, msg: '', err: false });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((msg: string, err = false) => {
    if (timer.current) clearTimeout(timer.current);
    setState({ open: true, msg, err });
    timer.current = setTimeout(() => setState(prev => ({ ...prev, open: false })), 2800);
  }, []);
  return [state, show];
}

// ── Main Page ─────────────────────────────────────────────────────────────

export function DatabaseAdminPage() {
  const [tab, setTab] = useState(0);
  const [tables, setTables] = useState<TableDef[]>([]);
  const [loadErr, setLoadErr] = useState('');
  const [loadingTables, setLoadingTables] = useState(true);
  const [toast, showToast] = useToast();
  const jumpSeq = useRef(0);
  const [jumpRequest, setJumpRequest] = useState<JumpRequest | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const data = await apiFetch<{ tables: TableDef[] }>('GET', '/api/admin/db/tables');
        setTables(data.tables || []);
      } catch (e: unknown) {
        const err = e as { forbidden?: boolean; message?: string };
        setLoadErr(err.forbidden ? 'admin-access' : (err.message || 'Could not load tables'));
      } finally { setLoadingTables(false); }
    })();
  }, []);

  if (loadErr === 'admin-access') {
    return (
      <Box sx={{ maxWidth: 440, mx: 'auto', mt: 10, p: 4, border: '1px solid #fecaca', borderRadius: 3, textAlign: 'center' }}>
        <Typography variant="h6" color="error" sx={{ mb: 1 }}>Admin access required</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>This page is only available to admins.</Typography>
        <Button variant="contained" href="/">Back to home</Button>
      </Box>
    );
  }

  if (loadErr) {
    return (
      <Box sx={{ maxWidth: 600, mx: 'auto', p: 3 }}>
        <Alert severity="error">{loadErr}</Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ maxWidth: 1400, mx: 'auto', px: { xs: 2, md: 3 }, py: 3 }}>
      {/* Page header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 2.5, flexWrap: 'wrap', gap: 1.5 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 700 }}>Database</Typography>
          <Typography variant="body2" color="text.secondary">
            Browse and edit the local PostgreSQL database. Sensitive auth tables are excluded.
          </Typography>
        </Box>
        <Button variant="outlined" startIcon={<ArrowBackIcon />} href="/admin" size="small">Back to admin</Button>
      </Box>

      {/* Tabs */}
      <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 2.5 }}>
        <Tabs value={tab} onChange={(_, v) => setTab(v)}>
          <Tab label="Tables" />
          <Tab label="Audit log" />
        </Tabs>
      </Box>

      {loadingTables ? (
        <Skeleton variant="rectangular" height={300} />
      ) : (
        <>
          {tab === 0 && (
            <TableBrowser
              tables={tables}
              jumpRequest={jumpRequest}
              onToast={showToast}
            />
          )}
          {tab === 1 && (
            <AuditLog
              tables={tables}
              onToast={showToast}
              onNavigate={(tableName, filters) => {
                setTab(0);
                jumpSeq.current += 1;
                setJumpRequest({ tableName, filters, seq: jumpSeq.current });
              }}
            />
          )}
        </>
      )}

      {/* Toast notification */}
      {toast.open && (
        <Box sx={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          bgcolor: toast.err ? '#991b1b' : 'primary.main', color: '#fff',
          px: 2.5, py: 1.25, borderRadius: 2, fontSize: '0.875rem',
          zIndex: 2000, pointerEvents: 'none', whiteSpace: 'nowrap',
          boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
        }}>
          {toast.msg}
        </Box>
      )}
    </Box>
  );
}
