/**
 * Shared catalogue components and helpers used by DesignVisitPage.
 * The underlying catalogue tables (catalog_handles, catalog_ranges,
 * catalog_doors) are shared between design and survey visit types — this module
 * provides the UI building-blocks to manage them from the admin Visits tab.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box, Button, CircularProgress, Stack, Typography,
} from '@mui/material';
import Alert from '@mui/material/Alert';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import TextField from '@mui/material/TextField';
import { FileUploadField, UploadStatus } from '../../components/FileUploadField';
import { GET, PATCH, POST, DELETE } from '../../utils/api';
import { useConnectionToast } from '../../contexts/ConnectionToastContext';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DvHandle    { id: number; name: string; style?: string; image_url?: string; sort_order?: number; }
export interface DvFurniture { id: number; name: string; description?: string; sort_order?: number; }
export interface DvDoorStyle { id: number; name: string; image_url?: string; sort_order?: number; }
export interface DvTerms     { id: number; version: number; text: string; published_at: string; published_by?: string; }
export interface Supplier    { id: number; name: string; description?: string; website_address?: string; account_number?: string; }
export type AnyItem = DvHandle | DvFurniture | DvDoorStyle;

// ── Constants ─────────────────────────────────────────────────────────────────

export const DV_HANDLE_STYLES = ['Cup', 'Bar', 'Knob', 'Pull', 'Finger Pull', 'Other'];

// ── Helpers ───────────────────────────────────────────────────────────────────

const W = window as unknown as Record<string, unknown>;

export function showToast(msg: string, err?: boolean) {
  if (typeof W.toast === 'function') (W.toast as (m: string, e?: boolean) => void)(msg, err);
}

export function broadcastCatalogueChange(type: string) {
  const chanMap: Record<string, string> = {
    handle:       'catalog_handles_changed',
    furniture:    'catalog_ranges_changed',
    'door-style': 'catalog_doors_changed',
  };
  const chanName = chanMap[type];
  if (!chanName) return;
  try { const ch = new BroadcastChannel(chanName); ch.postMessage({ ts: Date.now() }); ch.close(); } catch { /* ignore */ }
}

export function endpointFor(type: string) {
  return ({
    handle:       '/api/admin/catalog/handles',
    furniture:    '/api/admin/catalog/ranges',
    'door-style': '/api/admin/catalog/doors',
  } as Record<string, string>)[type] ?? '';
}

// ── DvItemEditorDialog ─────────────────────────────────────────────────────────

export interface DvItemEditorDialogProps {
  open: boolean;
  type: string;
  existingId?: number;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

export function DvItemEditorDialog({ open, type, existingId, onClose, onSaved }: DvItemEditorDialogProps) {
  const { notifyApiError } = useConnectionToast();
  const [loading, setLoading] = useState(false);
  const [saving,  setSaving]  = useState(false);
  const [errMsg,  setErrMsg]  = useState('');
  const [imageUploadStatus,   setImageUploadStatus]   = useState<UploadStatus>('idle');
  const [imageUploadProgress, setImageUploadProgress] = useState<number | undefined>(undefined);

  const [name,        setName]        = useState('');
  const [style,       setStyle]       = useState('');
  const [description, setDescription] = useState('');
  const [imageUrl,    setImageUrl]     = useState('');
  const [imageFile,   setImageFile]    = useState<File | null>(null);
  const [previewSrc,  setPreviewSrc]   = useState('');

  const [allSuppliers, setAllSuppliers] = useState<Supplier[]>([]);
  const [supplierId,   setSupplierId]   = useState<number | ''>('');

  const typeLabels: Record<string, string> = {
    handle: 'Handle', furniture: 'Furniture Range', 'door-style': 'Door Style',
  };
  const hasDescription  = type === 'furniture';
  const hasStyleSelect  = type === 'handle';
  const hasImageUrl     = type !== 'furniture';
  const hasFileUpload   = type === 'handle' || type === 'door-style';
  const hasSuppliers    = type === 'handle' || type === 'door-style';

  useEffect(() => {
    if (!open) {
      setName(''); setStyle(''); setDescription(''); setImageUrl('');
      setImageFile(null); setPreviewSrc(''); setErrMsg('');
      setImageUploadStatus('idle'); setImageUploadProgress(undefined);
      setSupplierId('');
      return;
    }

    GET('/api/admin/catalog/suppliers')
      .then((list) => setAllSuppliers(Array.isArray(list) ? list as Supplier[] : []))
      .catch(() => { /* non-fatal */ });

    if (!existingId) return;

    setLoading(true);
    const fetches: Promise<unknown>[] = [
      GET(endpointFor(type)).then((list) => {
        const arr = Array.isArray(list) ? list as Array<Record<string, unknown>> : [];
        const item = arr.find(x => x.id === existingId) ?? null;
        if (item) {
          setName(String(item.name ?? ''));
          setStyle(String(item.style ?? ''));
          setDescription(String(item.description ?? ''));
          setImageUrl(String(item.image_url ?? ''));
          if (item.image_url) setPreviewSrc(String(item.image_url));
          if (hasSuppliers) setSupplierId(item.supplier_id != null ? (item.supplier_id as number) : '');
        }
      }),
    ];

    Promise.allSettled(fetches).finally(() => setLoading(false));
  }, [open, existingId, type]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    setErrMsg('');
    const nameVal = name.trim();
    if (!nameVal) { setErrMsg('Name is required.'); return; }

    let finalImageUrl: string | undefined = imageUrl || undefined;

    if (hasFileUpload && imageFile) {
      const uploadUrlMap: Record<string, string> = {
        handle:       '/api/admin/catalog/handles/upload-image',
        'door-style': '/api/admin/catalog/doors/upload-image',
      };
      const formData = new FormData();
      formData.append('image', imageFile);
      setSaving(true);
      setImageUploadStatus('uploading');
      setImageUploadProgress(0);
      try {
        const j = await new Promise<{ url: string }>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', uploadUrlMap[type]);
          xhr.upload.onprogress = (evt) => {
            if (evt.lengthComputable) {
              setImageUploadProgress(Math.round((evt.loaded / evt.total) * 100));
            }
          };
          xhr.onload = () => {
            setImageUploadProgress(100);
            try {
              const data = JSON.parse(xhr.responseText) as { url?: string; error?: string };
              if (xhr.status >= 400 || !data.url) {
                reject(new Error(data.error || xhr.statusText));
              } else {
                resolve(data as { url: string });
              }
            } catch {
              reject(new Error('Invalid server response'));
            }
          };
          xhr.onerror = () => reject(new Error('Network error'));
          xhr.onabort = () => reject(new Error('Upload aborted'));
          xhr.send(formData);
        });
        finalImageUrl = j.url;
        setImageUploadStatus('success');
      } catch (e) {
        setImageUploadStatus('error');
        setImageUploadProgress(undefined);
        setErrMsg('Image upload failed: ' + (e as Error).message);
        setSaving(false);
        return;
      }
    }

    const ep = endpointFor(type);
    const url = existingId ? `${ep}/${existingId}` : ep;
    const body: Record<string, unknown> = { name: nameVal };
    if (hasStyleSelect) {
      if (!existingId && !style) { setErrMsg('Style is required.'); setSaving(false); return; }
      if (style) body.style = style;
    }
    if (hasDescription) body.description = description.trim();
    if (hasImageUrl) body.image_url = finalImageUrl || null;
    if (hasSuppliers) body.supplier_id = supplierId !== '' ? supplierId : null;

    setSaving(true);
    try {
      await (existingId ? PATCH(url, body) : POST(url, body));
      showToast(existingId ? 'Saved.' : 'Added.');
      broadcastCatalogueChange(type);
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
                  disabled={saving}
                  uploadStatus={imageUploadStatus}
                  progress={imageUploadProgress}
                  resetDelay={2500}
                  onStatusReset={() => setImageUploadStatus('idle')}
                  onChange={(files) => {
                    const file = files?.[0] ?? null;
                    setImageFile(file);
                    setImageUploadStatus('idle');
                    setImageUploadProgress(undefined);
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
            {hasSuppliers && allSuppliers.length > 0 && (
              <FormControl size="small" fullWidth>
                <InputLabel id="dvie-supplier-label">Supplier</InputLabel>
                <Select
                  labelId="dvie-supplier-label"
                  label="Supplier"
                  value={supplierId}
                  onChange={(e) => { const v = e.target.value as number | ''; setSupplierId(v === '' ? '' : Number(v)); }}
                >
                  <MenuItem value=""><em>— none —</em></MenuItem>
                  {allSuppliers.map((s) => (
                    <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>
                  ))}
                </Select>
              </FormControl>
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

// ── CatalogueTable ─────────────────────────────────────────────────────────────

export interface CatalogueTableProps<T extends AnyItem> {
  type: string;
  items: T[];
  columns: Array<{ field: keyof T; label: string }>;
  showImage?: boolean;
  onMove:    (type: string, id: number, dir: 'up' | 'down') => Promise<void>;
  onReorder: (type: string, newOrderIds: number[]) => Promise<void>;
  onEdit:    (type: string, id: number) => void;
  onDelete:  (type: string, id: number) => void;
}

export function CatalogueTable<T extends AnyItem>({
  type, items, columns, showImage, onMove, onReorder, onEdit, onDelete,
}: CatalogueTableProps<T>) {
  const sorted = [...items].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
  const dragId     = useRef<number | null>(null);
  const dragOverEl = useRef<HTMLElement | null>(null);
  // Pending rAF id for deferred border writes — cancelled on dragend/unmount.
  const dragRafId  = useRef<number | null>(null);

  const clearMarkers = () => {
    if (dragRafId.current !== null) {
      cancelAnimationFrame(dragRafId.current);
      dragRafId.current = null;
    }
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
                // Read bounding rect immediately while the event is live so
                // cursor position is accurate. Style writes are deferred to the
                // next animation frame so rapid dragover events don't interleave
                // reads and writes across frames (layout thrashing).
                const rect = tr.getBoundingClientRect();
                const before = (e.clientY - rect.top) < rect.height / 2;
                const prevEl = (dragOverEl.current !== tr) ? dragOverEl.current : null;
                dragOverEl.current = tr;
                if (dragRafId.current !== null) cancelAnimationFrame(dragRafId.current);
                dragRafId.current = requestAnimationFrame(() => {
                  dragRafId.current = null;
                  if (prevEl) {
                    prevEl.style.borderTop = '';
                    prevEl.style.borderBottom = '';
                  }
                  tr.style.borderTop    = before ? '2px solid #2563eb' : '';
                  tr.style.borderBottom = before ? '' : '2px solid #2563eb';
                });
              }}
              onDrop={(e) => {
                e.preventDefault();
                clearMarkers();
                if (dragId.current == null || dragId.current === item.id) return;
                // reflow-ok: fires once per drop (not a hot path); no style write follows in the same frame.
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
                  onClick={() => onMove(type, item.id, 'up')}>▲</button>
                <button className="btn btn-ghost adm-iconbtn--xs" title="Move down"
                  disabled={i === sorted.length - 1}
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

// ── useCatalogueData hook ──────────────────────────────────────────────────────

export interface CatalogueDataState {
  handles:    DvHandle[];
  furniture:  DvFurniture[];
  doorStyles: DvDoorStyle[];
  dialogState: { open: boolean; type: string; existingId?: number };
  fetchAll:    () => Promise<void>;
  openEditor:  (type: string, existingId?: number) => void;
  closeDialog: () => void;
  moveItem:    (type: string, id: number, dir: 'up' | 'down') => Promise<void>;
  reorderItems:(type: string, newOrderIds: number[]) => Promise<void>;
  deleteItem:  (type: string, id: number) => Promise<void>;
}

export function useCatalogueData(): CatalogueDataState {
  const { notifyApiError } = useConnectionToast();
  const [handles,    setHandles]    = useState<DvHandle[]>([]);
  const [furniture,  setFurniture]  = useState<DvFurniture[]>([]);
  const [doorStyles, setDoorStyles] = useState<DvDoorStyle[]>([]);
  const [dialogState, setDialogState] = useState<{ open: boolean; type: string; existingId?: number }>(
    { open: false, type: 'handle' }
  );

  const openEditor = useCallback((type: string, existingId?: number) => {
    setDialogState({ open: true, type, existingId });
  }, []);

  const closeDialog = useCallback(() => {
    setDialogState(s => ({ ...s, open: false }));
  }, []);

  const fetchAll = useCallback(async () => {
    const [hR, fR, dR] = await Promise.allSettled([
      GET('/api/admin/catalog/handles'),
      GET('/api/admin/catalog/ranges'),
      GET('/api/admin/catalog/doors'),
    ]);
    const firstRejection = [hR, fR, dR].find(r => r.status === 'rejected');
    if (firstRejection) notifyApiError('database', (firstRejection as PromiseRejectedResult).reason);
    const h = hR.status === 'fulfilled' ? hR.value : [];
    const f = fR.status === 'fulfilled' ? fR.value : [];
    const d = dR.status === 'fulfilled' ? dR.value : [];
    setHandles(Array.isArray(h) ? h as DvHandle[] : []);
    setFurniture(Array.isArray(f) ? f as DvFurniture[] : []);
    setDoorStyles(Array.isArray(d) ? d as DvDoorStyle[] : []);
  }, [notifyApiError]);

  const setterFor = useCallback((type: string) => {
    if (type === 'handle')    return setHandles as React.Dispatch<React.SetStateAction<AnyItem[]>>;
    if (type === 'furniture') return setFurniture as React.Dispatch<React.SetStateAction<AnyItem[]>>;
    return setDoorStyles as React.Dispatch<React.SetStateAction<AnyItem[]>>;
  }, []);

  const itemsFor = useCallback((type: string): AnyItem[] => {
    if (type === 'handle')    return handles;
    if (type === 'furniture') return furniture;
    return doorStyles;
  }, [handles, furniture, doorStyles]);

  const moveItem = useCallback(async (type: string, id: number, dir: 'up' | 'down') => {
    const cache  = itemsFor(type);
    const sorted = [...cache].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
    const idx    = sorted.findIndex(s => s.id === id);
    if (idx === -1) return;
    const si = dir === 'up' ? idx - 1 : idx + 1;
    if (si < 0 || si >= sorted.length) return;
    const a = sorted[idx], b = sorted[si];
    if ((a.sort_order || 0) === (b.sort_order || 0)) sorted.forEach((s, i) => { s.sort_order = i; });
    const aOrder = a.sort_order, bOrder = b.sort_order;
    const ep = endpointFor(type);
    try {
      await Promise.all([
        PATCH(`${ep}/${a.id}`, { sort_order: bOrder }),
        PATCH(`${ep}/${b.id}`, { sort_order: aOrder }),
      ]);
      const next = [...cache];
      const ai = next.findIndex(x => x.id === a.id);
      const bi = next.findIndex(x => x.id === b.id);
      if (ai !== -1) next[ai] = { ...a, sort_order: bOrder };
      if (bi !== -1) next[bi] = { ...b, sort_order: aOrder };
      setterFor(type)(next as never);
      broadcastCatalogueChange(type);
    } catch (e) {
      notifyApiError('database', e);
      showToast(`Failed to reorder: ${(e as Error).message}`, true);
    }
  }, [itemsFor, setterFor, notifyApiError]);

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
      await Promise.all(patches.map(p => PATCH(`${ep}/${p.id}`, { sort_order: p.newOrder })));
      const next = cache.map(x => {
        const patch = patches.find(p => p.id === x.id);
        return patch ? { ...x, sort_order: patch.newOrder } : x;
      });
      setterFor(type)(next as never);
      broadcastCatalogueChange(type);
    } catch (e) {
      notifyApiError('database', e);
      showToast(`Failed to reorder: ${(e as Error).message}`, true);
      fetchAll();
    }
  }, [itemsFor, setterFor, fetchAll, notifyApiError]);

  const deleteItem = useCallback(async (type: string, id: number) => {
    if (!confirm('Delete this item? This cannot be undone.')) return;
    const ep = endpointFor(type);
    try {
      await DELETE(`${ep}/${id}`);
      showToast('Deleted.');
      broadcastCatalogueChange(type);
      await fetchAll();
    } catch (e) {
      notifyApiError('database', e);
      showToast('Delete failed: ' + (e as Error).message, true);
    }
  }, [fetchAll, notifyApiError]);

  return {
    handles, furniture, doorStyles,
    dialogState, fetchAll,
    openEditor, closeDialog,
    moveItem, reorderItems, deleteItem,
  };
}

// ── SuppliersTab ───────────────────────────────────────────────────────────────

interface SupplierEditorDialogProps {
  open: boolean;
  supplier: Supplier | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

function SupplierEditorDialog({ open, supplier, onClose, onSaved }: SupplierEditorDialogProps) {
  const { notifyApiError } = useConnectionToast();
  const [saving,  setSaving]  = useState(false);
  const [errMsg,  setErrMsg]  = useState('');
  const [name,           setName]           = useState('');
  const [description,    setDescription]    = useState('');
  const [websiteAddress, setWebsiteAddress] = useState('');
  const [accountNumber,  setAccountNumber]  = useState('');

  useEffect(() => {
    if (!open) { setErrMsg(''); return; }
    setName(supplier?.name ?? '');
    setDescription(supplier?.description ?? '');
    setWebsiteAddress(supplier?.website_address ?? '');
    setAccountNumber(supplier?.account_number ?? '');
  }, [open, supplier]);

  async function handleSave() {
    setErrMsg('');
    const nameVal = name.trim();
    if (!nameVal) { setErrMsg('Name is required.'); return; }
    setSaving(true);
    try {
      const body = {
        name: nameVal,
        description:     description.trim()    || null,
        website_address: websiteAddress.trim() || null,
        account_number:  accountNumber.trim()  || null,
      };
      if (supplier) {
        await PATCH(`/api/admin/catalog/suppliers/${supplier.id}`, body);
      } else {
        await POST('/api/admin/catalog/suppliers', body);
      }
      showToast(supplier ? 'Saved.' : 'Supplier added.');
      await onSaved();
      onClose();
    } catch (e) {
      notifyApiError('database', e);
      setErrMsg((e as Error).message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{supplier ? 'Edit Supplier' : 'Add Supplier'}</DialogTitle>
      <DialogContent>
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
          <TextField
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            slotProps={{ htmlInput: { maxLength: 500 } }}
            size="small"
            fullWidth
          />
          <TextField
            label="Website"
            type="url"
            value={websiteAddress}
            onChange={(e) => setWebsiteAddress(e.target.value)}
            slotProps={{ htmlInput: { maxLength: 500 } }}
            placeholder="https://…"
            size="small"
            fullWidth
          />
          <TextField
            label="Account number"
            value={accountNumber}
            onChange={(e) => setAccountNumber(e.target.value)}
            slotProps={{ htmlInput: { maxLength: 100 } }}
            size="small"
            fullWidth
          />
          {errMsg && <Alert severity="error">{errMsg}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="contained" onClick={handleSave} disabled={saving}>
          {saving ? <CircularProgress size={16} sx={{ mr: 1 }} /> : null}
          {supplier ? 'Save' : 'Add'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function SuppliersTab() {
  const { notifyApiError } = useConnectionToast();
  const [suppliers,    setSuppliers]    = useState<Supplier[]>([]);
  const [loading,      setLoading]      = useState(false);
  const [editorOpen,   setEditorOpen]   = useState(false);
  const [editTarget,   setEditTarget]   = useState<Supplier | null>(null);

  const fetchSuppliers = useCallback(async () => {
    setLoading(true);
    try {
      const list = await GET('/api/admin/catalog/suppliers');
      setSuppliers(Array.isArray(list) ? list as Supplier[] : []);
    } catch (e) {
      notifyApiError('database', e);
    } finally {
      setLoading(false);
    }
  }, [notifyApiError]);

  useEffect(() => { fetchSuppliers(); }, [fetchSuppliers]);

  async function handleDelete(s: Supplier) {
    if (!confirm(`Delete supplier "${s.name}"? This will remove it from all linked handles and door styles.`)) return;
    try {
      await DELETE(`/api/admin/catalog/suppliers/${s.id}`);
      showToast('Supplier deleted.');
      await fetchSuppliers();
    } catch (e) {
      notifyApiError('database', e);
      showToast('Delete failed: ' + (e as Error).message, true);
    }
  }

  return (
    <>
      <Stack spacing={2} sx={{ mt: 2 }}>
        <Card variant="outlined" sx={{ bgcolor: 'action.hover' }}>
          <CardContent sx={{ py: '10px !important' }}>
            <Typography variant="body2" color="text.secondary">
              Suppliers can be linked to handles and door styles from within their edit dialogs in the Catalogues tab.
            </Typography>
          </CardContent>
        </Card>

        <Card variant="outlined">
          <CardContent>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, mb: 2 }}>
              <Box>
                <Typography variant="h6">Suppliers</Typography>
                <Typography variant="body2" color="text.secondary">
                  Companies that supply handles, door styles, and other catalogue items.
                </Typography>
              </Box>
              <Button variant="contained" sx={{ flexShrink: 0 }} onClick={() => { setEditTarget(null); setEditorOpen(true); }}>
                + Add supplier
              </Button>
            </Box>

            {loading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
                <CircularProgress size={28} />
              </Box>
            ) : suppliers.length === 0 ? (
              <p className="admin-msg admin-msg--muted">No suppliers added yet.</p>
            ) : (
              <Box sx={{ overflowX: 'auto' }}>
                <table className="adm-table" style={{ width: '100%' }}>
                  <thead>
                    <tr className="adm-tr">
                      <th className="adm-th">Name</th>
                      <th className="adm-th">Description</th>
                      <th className="adm-th">Website</th>
                      <th className="adm-th">Account no.</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {suppliers.map((s, i) => (
                      <tr key={s.id} className={`adm-tr${i % 2 ? ' adm-tr--alt' : ''}`}>
                        <td className="adm-td"><strong>{s.name}</strong></td>
                        <td className="adm-td">{s.description || <span style={{ color: 'var(--color-text-muted)' }}>—</span>}</td>
                        <td className="adm-td">
                          {s.website_address
                            ? <a href={s.website_address} target="_blank" rel="noopener noreferrer">{s.website_address}</a>
                            : <span style={{ color: 'var(--color-text-muted)' }}>—</span>}
                        </td>
                        <td className="adm-td">{s.account_number || <span style={{ color: 'var(--color-text-muted)' }}>—</span>}</td>
                        <td className="adm-td adm-td--right adm-td--nowrap">
                          <button className="btn btn-ghost adm-btn-xs" onClick={() => { setEditTarget(s); setEditorOpen(true); }}>Edit</button>
                          <button className="btn btn-ghost adm-btn-xs adm-btn-xs--danger" onClick={() => handleDelete(s)}>Delete</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Box>
            )}
          </CardContent>
        </Card>
      </Stack>

      <SupplierEditorDialog
        open={editorOpen}
        supplier={editTarget}
        onClose={() => setEditorOpen(false)}
        onSaved={fetchSuppliers}
      />
    </>
  );
}
