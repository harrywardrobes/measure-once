import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useConnectionCheck, useConnectionToast } from '../../context/ConnectionToastContext';
import {
  Box, Button, Card, CardContent, CircularProgress, Divider, Stack, Typography,
} from '@mui/material';
import Alert from '@mui/material/Alert';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import TextField from '@mui/material/TextField';
import { FileUploadField } from '../../components/FileUploadField';

// ── Types ─────────────────────────────────────────────────────────────────────

interface DvHandle    { id: number; name: string; style?: string; image_url?: string; sort_order?: number; }
interface DvFurniture { id: number; name: string; description?: string; sort_order?: number; }
interface DvDoorStyle { id: number; name: string; image_url?: string; sort_order?: number; }
interface DvTerms     { id: number; version: number; text: string; published_at: string; published_by?: string; }

// ── Module-level refs ──────────────────────────────────────────────────────────

const W = window as unknown as Record<string, unknown>;
const _reloadRef: { fn: (() => Promise<void>) | null } = { fn: null };
const _openEditorRef: { fn: ((type: string, existingId?: number) => void) | null } = { fn: null };

// ── Helpers ───────────────────────────────────────────────────────────────────

function callApi(method: string, path: string, body?: unknown): Promise<unknown> {
  if (typeof W.api === 'function')
    return (W.api as (m: string, p: string, b?: unknown) => Promise<unknown>)(method, path, body);
  return fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).then(r => r.ok ? r.json() : r.json().then((e: { error?: string }) => {
    throw new Error(e.error || r.statusText);
  }));
}

function showToast(msg: string, err?: boolean) {
  if (typeof W.toast === 'function') (W.toast as (m: string, e?: boolean) => void)(msg, err);
}

function esc(s: unknown): string {
  return (s == null ? '' : String(s))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _broadcastDvCatalogueChange(type: string) {
  const chanMap: Record<string, string> = {
    handle:       'design_visit_handles_changed',
    furniture:    'design_visit_furniture_ranges_changed',
    'door-style': 'design_visit_door_styles_changed',
  };
  const chanName = chanMap[type];
  if (!chanName) return;
  try { const ch = new BroadcastChannel(chanName); ch.postMessage({ ts: Date.now() }); ch.close(); } catch { /* ignore */ }
}

// ── Constants ──────────────────────────────────────────────────────────────────

const DV_HANDLE_STYLES = ['Cup', 'Bar', 'Knob', 'Pull', 'Finger Pull', 'Other'];

// ── DvItemEditorDialog component ───────────────────────────────────────────────

interface DvItemEditorDialogProps {
  open: boolean;
  type: string;
  existingId?: number;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

function DvItemEditorDialog({ open, type, existingId, onClose, onSaved }: DvItemEditorDialogProps) {
  const { notifyApiError } = useConnectionToast();
  const [loading, setLoading] = useState(false);
  const [saving,  setSaving]  = useState(false);
  const [errMsg,  setErrMsg]  = useState('');

  const [name,        setName]        = useState('');
  const [style,       setStyle]       = useState('');
  const [description, setDescription] = useState('');
  const [imageUrl,    setImageUrl]     = useState('');
  const [imageFile,   setImageFile]    = useState<File | null>(null);
  const [previewSrc,  setPreviewSrc]   = useState('');

  const typeLabels: Record<string, string> = {
    handle: 'Handle', furniture: 'Furniture Range', 'door-style': 'Door Style',
  };
  const hasDescription = type === 'furniture';
  const hasStyleSelect = type === 'handle';
  const hasImageUrl    = type !== 'furniture';
  const hasFileUpload  = type === 'handle' || type === 'door-style';

  useEffect(() => {
    if (!open) {
      setName(''); setStyle(''); setDescription(''); setImageUrl('');
      setImageFile(null); setPreviewSrc(''); setErrMsg('');
      return;
    }
    if (!existingId) return;

    setLoading(true);
    const listUrl: Record<string, string> = {
      handle:       '/api/admin/design-visit-handles',
      furniture:    '/api/admin/design-visit-furniture-ranges',
      'door-style': '/api/admin/design-visit-door-styles',
    };
    callApi('GET', listUrl[type])
      .then((list) => {
        const arr = Array.isArray(list) ? list as Array<Record<string, unknown>> : [];
        const item = arr.find(x => x.id === existingId) ?? null;
        if (item) {
          setName(String(item.name ?? ''));
          setStyle(String(item.style ?? ''));
          setDescription(String(item.description ?? ''));
          setImageUrl(String(item.image_url ?? ''));
          if (item.image_url) setPreviewSrc(String(item.image_url));
        }
      })
      .catch(() => { /* ignore — fields stay blank */ })
      .finally(() => setLoading(false));
  }, [open, existingId, type]);

  async function handleSave() {
    setErrMsg('');
    const nameVal = name.trim();
    if (!nameVal) { setErrMsg('Name is required.'); return; }

    let finalImageUrl: string | undefined = imageUrl || undefined;

    if (hasFileUpload && imageFile) {
      const uploadUrlMap: Record<string, string> = {
        handle:       '/api/admin/design-visit-handles/upload-image',
        'door-style': '/api/admin/design-visit-door-styles/upload-image',
      };
      const formData = new FormData();
      formData.append('image', imageFile);
      setSaving(true);
      try {
        const res = await fetch(uploadUrlMap[type], { method: 'POST', body: formData });
        if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error((e as {error?: string}).error || res.statusText); }
        const j = await res.json() as { url: string };
        finalImageUrl = j.url;
      } catch (e) {
        setErrMsg('Image upload failed: ' + (e as Error).message);
        setSaving(false);
        return;
      }
    }

    const urlMap: Record<string, string> = {
      handle:       existingId ? `/api/admin/design-visit-handles/${existingId}` : '/api/admin/design-visit-handles',
      furniture:    existingId ? `/api/admin/design-visit-furniture-ranges/${existingId}` : '/api/admin/design-visit-furniture-ranges',
      'door-style': existingId ? `/api/admin/design-visit-door-styles/${existingId}` : '/api/admin/design-visit-door-styles',
    };
    const method = existingId ? 'PATCH' : 'POST';
    const body: Record<string, unknown> = { name: nameVal };
    if (hasStyleSelect) {
      if (!existingId && !style) { setErrMsg('Style is required.'); setSaving(false); return; }
      if (style) body.style = style;
    }
    if (hasDescription) body.description = description.trim();
    if (hasImageUrl) body.image_url = finalImageUrl || null;

    setSaving(true);
    try {
      await callApi(method, urlMap[type], body);
      showToast(existingId ? 'Saved.' : 'Added.');
      _broadcastDvCatalogueChange(type);
      await onSaved();
      onClose();
    } catch (e) {
      notifyApiError('database', e);
      setErrMsg((e as Error).message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  const title = `${existingId ? 'Edit' : 'Add'} ${typeLabels[type] ?? type}`;

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress size={32} />
          </Box>
        ) : (
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            <TextField
              label="Name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              slotProps={{ htmlInput: { maxLength: 200 } }}
              size="small"
              fullWidth
              autoFocus
            />
            {hasStyleSelect && (
              <FormControl size="small" fullWidth required={!existingId}>
                <InputLabel id="dvie-style-label">Style{existingId ? '' : ' *'}</InputLabel>
                <Select
                  labelId="dvie-style-label"
                  label={`Style${existingId ? '' : ' *'}`}
                  value={style}
                  onChange={(e) => setStyle(e.target.value)}
                >
                  <MenuItem value=""><em>— select —</em></MenuItem>
                  {DV_HANDLE_STYLES.map((s) => (
                    <MenuItem key={s} value={s}>{s}</MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}
            {hasDescription && (
              <TextField
                label="Description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                slotProps={{ htmlInput: { maxLength: 500 } }}
                multiline
                rows={2}
                size="small"
                fullWidth
              />
            )}
            {hasFileUpload && (
              <>
                {previewSrc && !imageFile && (
                  <Box>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                      Current image
                    </Typography>
                    <Box
                      component="img"
                      src={previewSrc}
                      alt="Current image"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                      sx={{ maxWidth: 120, maxHeight: 80, borderRadius: 1, border: '1px solid', borderColor: 'divider', display: 'block' }}
                    />
                  </Box>
                )}
                <FileUploadField
                  label="Image (optional)"
                  accept="image/*"
                  onChange={(files) => {
                    const file = files?.[0] ?? null;
                    setImageFile(file);
                  }}
                  helperText="Replace the current image by selecting a new file"
                />
              </>
            )}
            {!hasFileUpload && hasImageUrl && (
              <TextField
                label="Image URL"
                type="url"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                slotProps={{ htmlInput: { maxLength: 500 } }}
                placeholder="https://…"
                size="small"
                fullWidth
              />
            )}
            {errMsg && (
              <Alert severity="error" sx={{ mt: 0.5 }}>{errMsg}</Alert>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="contained" onClick={handleSave} disabled={loading || saving}>
          {saving ? <CircularProgress size={16} sx={{ mr: 1 }} /> : null}
          {existingId ? 'Save' : 'Add'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ── CatalogueTable component ───────────────────────────────────────────────────

type AnyItem = DvHandle | DvFurniture | DvDoorStyle;

interface CatalogueTableProps<T extends AnyItem> {
  type: string;
  items: T[];
  columns: Array<{ field: keyof T; label: string }>;
  showImage?: boolean;
  onMove:    (type: string, id: number, dir: 'up' | 'down') => Promise<void>;
  onReorder: (type: string, newOrderIds: number[]) => Promise<void>;
  onEdit:    (type: string, id: number) => void;
  onDelete:  (type: string, id: number) => void;
}

function CatalogueTable<T extends AnyItem>({
  type, items, columns, showImage, onMove, onReorder, onEdit, onDelete,
}: CatalogueTableProps<T>) {
  const sorted = [...items].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
  const dragId  = useRef<number | null>(null);
  const dragOverEl = useRef<HTMLElement | null>(null);

  const clearMarkers = () => {
    if (dragOverEl.current) {
      dragOverEl.current.style.borderTop = '';
      dragOverEl.current.style.borderBottom = '';
      dragOverEl.current = null;
    }
  };

  if (!sorted.length) {
    return <p className="admin-msg admin-msg--muted">None added yet.</p>;
  }

  return (
    <Box sx={{ overflowX: 'auto' }}>
      <table className="adm-table" style={{ width: '100%' }}>
        <thead>
          <tr className="adm-tr">
            <th className="adm-dv-drag-th" />
            {showImage && <th className="adm-th">Image</th>}
            {columns.map(c => (
              <th key={String(c.field)} className="adm-th">{c.label}</th>
            ))}
            <th className="adm-dv-actions-th" />
            <th />
          </tr>
        </thead>
        <tbody>
          {sorted.map((item, i) => (
            <tr
              key={item.id}
              className={`adm-tr${i % 2 ? ' adm-tr--alt' : ''}`}
              draggable
              onDragStart={() => { dragId.current = item.id; (document.activeElement as HTMLElement)?.blur?.(); }}
              onDragEnd={(e) => {
                (e.currentTarget as HTMLElement).style.opacity = '';
                clearMarkers();
                dragId.current = null;
              }}
              onDragOver={(e) => {
                if (dragId.current === item.id) return;
                e.preventDefault();
                const tr = e.currentTarget as HTMLElement;
                const rect = tr.getBoundingClientRect();
                const before = (e.clientY - rect.top) < rect.height / 2;
                if (dragOverEl.current && dragOverEl.current !== tr) {
                  dragOverEl.current.style.borderTop = '';
                  dragOverEl.current.style.borderBottom = '';
                }
                dragOverEl.current = tr;
                tr.style.borderTop    = before ? '2px solid #2563eb' : '';
                tr.style.borderBottom = before ? '' : '2px solid #2563eb';
              }}
              onDrop={(e) => {
                e.preventDefault();
                clearMarkers();
                if (dragId.current == null || dragId.current === item.id) return;
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const before = (e.clientY - rect.top) < rect.height / 2;
                const fromIdx = sorted.findIndex(x => x.id === dragId.current);
                const toIdx   = sorted.findIndex(x => x.id === item.id);
                if (fromIdx === -1 || toIdx === -1) return;
                const newOrder = [...sorted];
                const [moved] = newOrder.splice(fromIdx, 1);
                const insertAt = before ? (fromIdx < toIdx ? toIdx - 1 : toIdx) : (fromIdx < toIdx ? toIdx : toIdx + 1);
                newOrder.splice(insertAt, 0, moved);
                onReorder(type, newOrder.map(x => x.id));
                dragId.current = null;
              }}
            >
              <td className="adm-dv-drag-cell" title="Drag to reorder" aria-hidden="true">⋮⋮</td>
              {showImage && (
                <td className="adm-td">
                  {(item as DvHandle).image_url
                    ? <img src={(item as DvHandle).image_url} alt={item.name} className="adm-dv-thumb" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                    : <span className="adm-dv-thumb-empty">—</span>}
                </td>
              )}
              {columns.map(c => (
                <td key={String(c.field)} className="adm-td">
                  {String((item as unknown as Record<string, unknown>)[c.field as string] ?? '—')}
                </td>
              ))}
              <td className="adm-td--actions">
                <button className="btn btn-ghost adm-iconbtn--xs" title="Move up"
                  disabled={i === 0}
                  data-move-id={item.id}
                  data-move-dir="up"
                  onClick={() => onMove(type, item.id, 'up')}>▲</button>
                <button className="btn btn-ghost adm-iconbtn--xs" title="Move down"
                  disabled={i === sorted.length - 1}
                  data-move-id={item.id}
                  data-move-dir="down"
                  onClick={() => onMove(type, item.id, 'down')}>▼</button>
              </td>
              <td className="adm-td adm-td--right adm-td--nowrap">
                <button className="btn btn-ghost adm-btn-xs"
                  onClick={() => onEdit(type, item.id)}>Edit</button>
                <button className="btn btn-ghost adm-btn-xs adm-btn-xs--danger"
                  onClick={() => onDelete(type, item.id)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Box>
  );
}

// ── TermsDisplay component ─────────────────────────────────────────────────────

function TermsDisplay({ terms }: { terms: DvTerms[] }) {
  const sorted  = [...terms].sort((a, b) => b.version - a.version);
  const current = sorted[0];
  const older   = sorted.slice(1);

  if (!current) {
    return <p className="admin-msg admin-msg--muted">No terms published yet.</p>;
  }

  const fmt = (d: string) =>
    new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <>
      <div className="adm-terms-current-wrap">
        <div className="adm-terms-version-row">
          <span className="adm-terms-version-badge">v{current.version}</span>
          <span className="adm-terms-version-date">{fmt(current.published_at)}</span>
          {current.published_by && (
            <span className="adm-terms-version-by">by {current.published_by}</span>
          )}
        </div>
        <pre className="adm-terms-preview">{current.text}</pre>
      </div>
      {older.length > 0 && (
        <details className="adm-terms-history" style={{ marginTop: 10 }}>
          <summary className="adm-terms-history-toggle">
            Show {older.length} older version{older.length !== 1 ? 's' : ''}
          </summary>
          <div className="adm-terms-history-list">
            {older.map(t => (
              <div key={t.id} className="adm-terms-history-item">
                <div className="adm-terms-version-row">
                  <span className="adm-terms-version-badge adm-terms-version-badge--old">v{t.version}</span>
                  <span className="adm-terms-version-date">{fmt(t.published_at)}</span>
                </div>
                <pre className="adm-terms-preview adm-terms-preview--old">{t.text}</pre>
              </div>
            ))}
          </div>
        </details>
      )}
    </>
  );
}

// ── Component ──────────────────────────────────────────────────────────────────

export function DesignVisitPage() {
  useConnectionCheck();
  const { notifyApiError } = useConnectionToast();
  const [handles,    setHandles]    = useState<DvHandle[]>([]);
  const [furniture,  setFurniture]  = useState<DvFurniture[]>([]);
  const [doorStyles, setDoorStyles] = useState<DvDoorStyle[]>([]);
  const [terms,      setTerms]      = useState<DvTerms[]>([]);
  const [termsEditorOpen, setTermsEditorOpen] = useState(false);
  const [termsNewText,    setTermsNewText]    = useState('');
  const [termsErr,        setTermsErr]        = useState('');

  const [dialogState, setDialogState] = useState<{
    open: boolean; type: string; existingId?: number;
  }>({ open: false, type: 'handle' });

  const openEditor = useCallback((type: string, existingId?: number) => {
    setDialogState({ open: true, type, existingId });
  }, []);

  const fetchAll = useCallback(async () => {
    const [hR, fR, dR, tR] = await Promise.allSettled([
      callApi('GET', '/api/admin/design-visit-handles'),
      callApi('GET', '/api/admin/design-visit-furniture-ranges'),
      callApi('GET', '/api/admin/design-visit-door-styles'),
      callApi('GET', '/api/admin/design-visit-terms'),
    ]);
    const firstRejection = [hR, fR, dR, tR].find(r => r.status === 'rejected');
    if (firstRejection) notifyApiError('database', (firstRejection as PromiseRejectedResult).reason);
    const h = hR.status === 'fulfilled' ? hR.value : [];
    const f = fR.status === 'fulfilled' ? fR.value : [];
    const d = dR.status === 'fulfilled' ? dR.value : [];
    const t = tR.status === 'fulfilled' ? tR.value : [];
    setHandles(Array.isArray(h) ? h as DvHandle[] : []);
    setFurniture(Array.isArray(f) ? f as DvFurniture[] : []);
    setDoorStyles(Array.isArray(d) ? d as DvDoorStyle[] : []);
    setTerms(Array.isArray(t) ? t as DvTerms[] : []);
  }, [notifyApiError]);

  useEffect(() => {
    _reloadRef.fn = fetchAll;
    _openEditorRef.fn = openEditor;
    fetchAll();

    W.loadDvCatalogue       = fetchAll;
    W.openDvHandleEditor    = (id?: number) => _openEditorRef.fn?.('handle', id);
    W.openDvFurnitureEditor = (id?: number) => _openEditorRef.fn?.('furniture', id);
    W.openDvDoorStyleEditor = (id?: number) => _openEditorRef.fn?.('door-style', id);

    return () => {
      _reloadRef.fn = null;
      _openEditorRef.fn = null;
      ['loadDvCatalogue', 'openDvHandleEditor', 'openDvFurnitureEditor', 'openDvDoorStyleEditor']
        .forEach(k => delete W[k]);
    };
  }, [fetchAll, openEditor]);

  const endpointFor = (type: string) => ({
    handle:       '/api/admin/design-visit-handles',
    furniture:    '/api/admin/design-visit-furniture-ranges',
    'door-style': '/api/admin/design-visit-door-styles',
  }[type] ?? '');

  const setterFor = useCallback((type: string) => {
    if (type === 'handle')     return setHandles as React.Dispatch<React.SetStateAction<AnyItem[]>>;
    if (type === 'furniture')  return setFurniture as React.Dispatch<React.SetStateAction<AnyItem[]>>;
    return setDoorStyles as React.Dispatch<React.SetStateAction<AnyItem[]>>;
  }, []);

  const itemsFor = useCallback((type: string): AnyItem[] => {
    if (type === 'handle')     return handles;
    if (type === 'furniture')  return furniture;
    return doorStyles;
  }, [handles, furniture, doorStyles]);

  const moveItem = useCallback(async (type: string, id: number, dir: 'up' | 'down') => {
    const cache = itemsFor(type);
    const sorted = [...cache].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
    const idx = sorted.findIndex(s => s.id === id);
    if (idx === -1) return;
    const si = dir === 'up' ? idx - 1 : idx + 1;
    if (si < 0 || si >= sorted.length) return;
    const a = sorted[idx], b = sorted[si];
    if ((a.sort_order || 0) === (b.sort_order || 0)) sorted.forEach((s, i) => { s.sort_order = i; });
    const aOrder = a.sort_order, bOrder = b.sort_order;
    const ep = endpointFor(type);
    try {
      await Promise.all([
        callApi('PATCH', `${ep}/${a.id}`, { sort_order: bOrder }),
        callApi('PATCH', `${ep}/${b.id}`, { sort_order: aOrder }),
      ]);
      const next = [...cache];
      const ai = next.findIndex(x => x.id === a.id);
      const bi = next.findIndex(x => x.id === b.id);
      if (ai !== -1) next[ai] = { ...a, sort_order: bOrder };
      if (bi !== -1) next[bi] = { ...b, sort_order: aOrder };
      setterFor(type)(next as never);
      _broadcastDvCatalogueChange(type);
    } catch (e) {
      notifyApiError('database', e);
      showToast(`Failed to reorder: ${(e as Error).message}`, true);
    }
  }, [itemsFor, setterFor, endpointFor, notifyApiError]);

  const reorderItems = useCallback(async (type: string, newOrderIds: number[]) => {
    const cache = itemsFor(type);
    const byId  = new Map(cache.map(x => [x.id, x]));
    const ep    = endpointFor(type);
    const patches: Array<{ id: number; newOrder: number }> = [];
    newOrderIds.forEach((id, i) => {
      const item = byId.get(id);
      if (item && (item.sort_order || 0) !== i) patches.push({ id, newOrder: i });
    });
    if (!patches.length) return;
    try {
      await Promise.all(patches.map(p =>
        callApi('PATCH', `${ep}/${p.id}`, { sort_order: p.newOrder }),
      ));
      const next = cache.map(x => {
        const patch = patches.find(p => p.id === x.id);
        return patch ? { ...x, sort_order: patch.newOrder } : x;
      });
      setterFor(type)(next as never);
      _broadcastDvCatalogueChange(type);
    } catch (e) {
      notifyApiError('database', e);
      showToast(`Failed to reorder: ${(e as Error).message}`, true);
      fetchAll();
    }
  }, [itemsFor, setterFor, endpointFor, fetchAll, notifyApiError]);

  const deleteItem = useCallback(async (type: string, id: number) => {
    if (!confirm('Delete this item? This cannot be undone.')) return;
    const ep = endpointFor(type);
    try {
      await callApi('DELETE', `${ep}/${id}`);
      showToast('Deleted.');
      _broadcastDvCatalogueChange(type);
      await fetchAll();
    } catch (e) {
      notifyApiError('database', e);
      showToast('Delete failed: ' + (e as Error).message, true);
    }
  }, [endpointFor, fetchAll, notifyApiError]);

  const publishTerms = useCallback(async () => {
    const text = termsNewText.trim();
    if (!text) { setTermsErr('Terms text cannot be empty.'); return; }
    try {
      await callApi('POST', '/api/admin/design-visit-terms', { text });
      setTermsEditorOpen(false);
      setTermsNewText('');
      setTermsErr('');
      showToast('Terms published.');
      try { new BroadcastChannel('design_visit_terms_changed').postMessage({ ts: Date.now() }); } catch { /* ignore */ }
      await fetchAll();
    } catch (e) {
      notifyApiError('database', e);
      setTermsErr((e as Error).message || 'Publish failed.');
    }
  }, [termsNewText, fetchAll, notifyApiError]);

  const handleCols: Array<{ field: keyof DvHandle; label: string }> = [
    { field: 'name', label: 'Name' },
    { field: 'style', label: 'Style' },
  ];
  const furnitureCols: Array<{ field: keyof DvFurniture; label: string }> = [
    { field: 'name', label: 'Name' },
    { field: 'description', label: 'Description' },
  ];
  const doorStyleCols: Array<{ field: keyof DvDoorStyle; label: string }> = [
    { field: 'name', label: 'Name' },
    { field: 'image_url', label: 'Image URL' },
  ];

  return (
    <>
      <Stack spacing={2}>
        <Card variant="outlined">
          <CardContent>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, mb: 2 }}>
              <Box>
                <Typography variant="h6">Design Visit — Handles</Typography>
                <Typography variant="body2" color="text.secondary">
                  Handle options displayed in the design visit wizard for the customer to choose from.
                </Typography>
              </Box>
              <Button variant="contained" onClick={() => openEditor('handle')} sx={{ flexShrink: 0 }}>
                + Add handle
              </Button>
            </Box>
            <div id="dv-handles-wrap">
              <CatalogueTable
                type="handle"
                items={handles}
                columns={handleCols}
                showImage
                onMove={moveItem}
                onReorder={reorderItems}
                onEdit={openEditor}
                onDelete={deleteItem}
              />
            </div>
          </CardContent>
        </Card>

        <Card variant="outlined">
          <CardContent>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, mb: 2 }}>
              <Box>
                <Typography variant="h6">Design Visit — Furniture Ranges</Typography>
                <Typography variant="body2" color="text.secondary">
                  Furniture ranges displayed in the design visit wizard.
                </Typography>
              </Box>
              <Button variant="contained" onClick={() => openEditor('furniture')} sx={{ flexShrink: 0 }}>
                + Add range
              </Button>
            </Box>
            <div id="dv-furniture-wrap">
              <CatalogueTable
                type="furniture"
                items={furniture}
                columns={furnitureCols}
                onMove={moveItem}
                onReorder={reorderItems}
                onEdit={openEditor}
                onDelete={deleteItem}
              />
            </div>
          </CardContent>
        </Card>

        <Card variant="outlined">
          <CardContent>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, mb: 2 }}>
              <Box>
                <Typography variant="h6">Design Visit — Door Styles</Typography>
                <Typography variant="body2" color="text.secondary">
                  Door styles the designer can select per room in the wizard.
                </Typography>
              </Box>
              <Button variant="contained" onClick={() => openEditor('door-style')} sx={{ flexShrink: 0 }}>
                + Add style
              </Button>
            </Box>
            <div id="dv-door-styles-wrap">
              <CatalogueTable
                type="door-style"
                items={doorStyles}
                columns={doorStyleCols}
                onMove={moveItem}
                onReorder={reorderItems}
                onEdit={openEditor}
                onDelete={deleteItem}
              />
            </div>
          </CardContent>
        </Card>

        <Card variant="outlined" id="dv-terms-card">
          <CardContent>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, mb: 2 }}>
              <Box>
                <Typography variant="h6">Design Visit — Terms &amp; Conditions</Typography>
                <Typography variant="body2" color="text.secondary">
                  Each published revision is versioned and stamped on the visit at submission time.
                  Customers always see the version that was active when their visit was submitted.
                </Typography>
              </Box>
              {!termsEditorOpen && (
                <Button variant="contained" onClick={() => { setTermsEditorOpen(true); setTermsNewText(''); setTermsErr(''); }} sx={{ flexShrink: 0 }}>
                  Publish new version
                </Button>
              )}
            </Box>

            <div id="dv-terms-current">
              <TermsDisplay terms={terms} />
            </div>

            {termsEditorOpen && (
              <>
                <Divider sx={{ my: 2 }} />
                <Typography variant="subtitle2" sx={{ mb: 1 }}>
                  New terms text (will become the active version)
                </Typography>
                <textarea
                  className="field adm-terms-textarea"
                  rows={8}
                  maxLength={4000}
                  placeholder="Enter the full terms and conditions text…"
                  value={termsNewText}
                  onChange={e => setTermsNewText(e.target.value)}
                  style={{ width: '100%', marginBottom: 4 }}
                />
                {termsErr && (
                  <Typography variant="caption" color="error" sx={{ display: 'block', mb: 1 }}>
                    {termsErr}
                  </Typography>
                )}
                <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 1 }}>
                  <Button variant="text" onClick={() => { setTermsEditorOpen(false); setTermsErr(''); }}>Cancel</Button>
                  <Button variant="contained" onClick={publishTerms}>Publish</Button>
                </Box>
              </>
            )}
          </CardContent>
        </Card>
      </Stack>

      <DvItemEditorDialog
        open={dialogState.open}
        type={dialogState.type}
        existingId={dialogState.existingId}
        onClose={() => setDialogState(s => ({ ...s, open: false }))}
        onSaved={fetchAll}
      />
    </>
  );
}

export default DesignVisitPage;
