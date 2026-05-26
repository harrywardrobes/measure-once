import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box, Button, Card, CardContent, Divider, Stack, Typography,
} from '@mui/material';

// ── Types ─────────────────────────────────────────────────────────────────────

interface DvHandle    { id: number; name: string; style?: string; image_url?: string; sort_order?: number; }
interface DvFurniture { id: number; name: string; description?: string; sort_order?: number; }
interface DvDoorStyle { id: number; name: string; image_url?: string; sort_order?: number; }
interface DvTerms     { id: number; version: number; text: string; published_at: string; published_by?: string; }

// ── Module-level refs ──────────────────────────────────────────────────────────

const W = window as unknown as Record<string, unknown>;
const _reloadRef: { fn: (() => Promise<void>) | null } = { fn: null };

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

// ── Item editor modal (DOM-appended — handles file uploads and complex forms) ──

const DV_HANDLE_STYLES = ['Cup', 'Bar', 'Knob', 'Pull', 'Finger Pull', 'Other'];

async function openDvItemEditor(type: string, existingId?: number) {
  let item: Record<string, unknown> | null = null;
  if (existingId) {
    try {
      const listUrl: Record<string, string> = {
        handle:       '/api/admin/design-visit-handles',
        furniture:    '/api/admin/design-visit-furniture-ranges',
        'door-style': '/api/admin/design-visit-door-styles',
      };
      const list = await callApi('GET', listUrl[type]) as Array<Record<string, unknown>>;
      item = (Array.isArray(list) ? list.find(x => x.id === existingId) : null) || null;
    } catch { /* ignore */ }
  }
  const typeLabels: Record<string, string> = {
    handle: 'Handle', furniture: 'Furniture Range', 'door-style': 'Door Style',
  };
  const hasDescription = type === 'furniture';
  const hasStyleSelect = type === 'handle';
  const hasImageUrl    = type !== 'furniture';

  const wrap = document.createElement('div');
  wrap.className = 'js-modal-scrim js-modal-scrim--below';
  wrap.innerHTML = `
    <div class="adm-modal-card adm-modal-card--narrow">
      <h3 class="adm-modal-title">${item ? 'Edit' : 'Add'} ${esc(typeLabels[type] || type)}</h3>
      <label class="adm-modal-label adm-modal-label--first">Name <span class="adm-req">*</span></label>
      <input id="dvie-name" type="text" class="field adm-field-name" maxlength="200" value="${esc(item?.name || '')}">
      ${hasStyleSelect ? `
        <label class="adm-modal-label">Style${item ? '' : ' <span class="adm-req">*</span>'}</label>
        <select id="dvie-style" class="field adm-field-sm">
          <option value="">— select —</option>
          ${DV_HANDLE_STYLES.map(s => `<option value="${esc(s)}"${item?.style === s ? ' selected' : ''}>${esc(s)}</option>`).join('')}
        </select>
      ` : ''}
      ${hasDescription ? `
        <label class="adm-modal-label">Description</label>
        <textarea id="dvie-desc" class="field adm-field-resize" rows="2" maxlength="500">${esc(item?.description || '')}</textarea>
      ` : ''}
      ${hasImageUrl ? `
        <label class="adm-modal-label">Image${type === 'handle' ? '' : ' URL'}</label>
        ${type === 'handle' ? `
          <div id="dvie-img-preview-wrap" class="adm-dv-preview-wrap"${item?.image_url ? '' : ' hidden'}>
            <img id="dvie-img-preview" src="${esc(item?.image_url || '')}" alt="Current image" class="adm-dv-preview">
          </div>
          <input id="dvie-img-file" type="file" accept="image/*" class="field adm-field-file">
        ` : `<input id="dvie-img-url" type="url" class="field adm-field-name" maxlength="500" placeholder="https://…" value="${esc(item?.image_url || '')}">`}
      ` : ''}
      <div id="dvie-err" class="adm-err-line hidden"></div>
      <div class="adm-modal-actions">
        <button class="btn btn-ghost" id="dvie-cancel">Cancel</button>
        <button class="btn btn-primary" id="dvie-save">${item ? 'Save' : 'Add'}</button>
      </div>
    </div>`;

  document.body.appendChild(wrap);

  if (type === 'handle') {
    const fileInput   = wrap.querySelector<HTMLInputElement>('#dvie-img-file');
    const previewWrap = wrap.querySelector<HTMLElement>('#dvie-img-preview-wrap');
    const previewImg  = wrap.querySelector<HTMLImageElement>('#dvie-img-preview');
    if (fileInput && previewWrap && previewImg) {
      fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        previewImg.src = URL.createObjectURL(file);
        previewWrap.hidden = false;
      });
    }
  }

  wrap.addEventListener('click', e => { if (e.target === wrap) wrap.remove(); });
  wrap.querySelector('#dvie-cancel')!.addEventListener('click', () => wrap.remove());

  wrap.querySelector('#dvie-save')!.addEventListener('click', async () => {
    const errEl = wrap.querySelector<HTMLElement>('#dvie-err')!;
    errEl.textContent = '';
    const nameVal = (wrap.querySelector<HTMLInputElement>('#dvie-name')?.value || '').trim();
    if (!nameVal) { errEl.textContent = 'Name is required.'; errEl.className = 'adm-err-line'; return; }

    let imageUrl = item?.image_url as string | undefined;

    if (type === 'handle') {
      const fileInput = wrap.querySelector<HTMLInputElement>('#dvie-img-file');
      const file = fileInput?.files?.[0];
      if (file) {
        const formData = new FormData();
        formData.append('image', file);
        try {
          const res = await fetch('/api/admin/design-visit-handles/upload-image', { method: 'POST', body: formData });
          if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error((e as {error?: string}).error || res.statusText); }
          const j = await res.json() as { url: string };
          imageUrl = j.url;
        } catch (e) {
          errEl.textContent = 'Image upload failed: ' + (e as Error).message;
          errEl.className = 'adm-err-line';
          return;
        }
      }
    } else if (hasImageUrl) {
      const urlInput = wrap.querySelector<HTMLInputElement>('#dvie-img-url');
      imageUrl = (urlInput?.value || '').trim() || undefined;
    }

    const urlMap: Record<string, string> = {
      handle:       existingId ? `/api/admin/design-visit-handles/${existingId}` : '/api/admin/design-visit-handles',
      furniture:    existingId ? `/api/admin/design-visit-furniture-ranges/${existingId}` : '/api/admin/design-visit-furniture-ranges',
      'door-style': existingId ? `/api/admin/design-visit-door-styles/${existingId}` : '/api/admin/design-visit-door-styles',
    };
    const method = existingId ? 'PATCH' : 'POST';
    const body: Record<string, unknown> = { name: nameVal };
    if (hasStyleSelect) {
      const styleVal = (wrap.querySelector<HTMLSelectElement>('#dvie-style')?.value || '').trim();
      if (!existingId && !styleVal) { errEl.textContent = 'Style is required.'; errEl.className = 'adm-err-line'; return; }
      if (styleVal) body.style = styleVal;
    }
    if (hasDescription) {
      body.description = (wrap.querySelector<HTMLTextAreaElement>('#dvie-desc')?.value || '').trim();
    }
    if (hasImageUrl) body.image_url = imageUrl || null;

    try {
      await callApi(method, urlMap[type], body);
      wrap.remove();
      showToast(existingId ? 'Saved.' : 'Added.');
      _broadcastDvCatalogueChange(type);
      if (_reloadRef.fn) await _reloadRef.fn();
    } catch (e) {
      errEl.textContent = (e as Error).message || 'Save failed.';
      errEl.className = 'adm-err-line';
    }
  });
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
  const [handles,    setHandles]    = useState<DvHandle[]>([]);
  const [furniture,  setFurniture]  = useState<DvFurniture[]>([]);
  const [doorStyles, setDoorStyles] = useState<DvDoorStyle[]>([]);
  const [terms,      setTerms]      = useState<DvTerms[]>([]);
  const [termsEditorOpen, setTermsEditorOpen] = useState(false);
  const [termsNewText,    setTermsNewText]    = useState('');
  const [termsErr,        setTermsErr]        = useState('');

  const fetchAll = useCallback(async () => {
    const [hR, fR, dR, tR] = await Promise.allSettled([
      callApi('GET', '/api/admin/design-visit-handles'),
      callApi('GET', '/api/admin/design-visit-furniture-ranges'),
      callApi('GET', '/api/admin/design-visit-door-styles'),
      callApi('GET', '/api/admin/design-visit-terms'),
    ]);
    const h = hR.status === 'fulfilled' ? hR.value : [];
    const f = fR.status === 'fulfilled' ? fR.value : [];
    const d = dR.status === 'fulfilled' ? dR.value : [];
    const t = tR.status === 'fulfilled' ? tR.value : [];
    setHandles(Array.isArray(h) ? h as DvHandle[] : []);
    setFurniture(Array.isArray(f) ? f as DvFurniture[] : []);
    setDoorStyles(Array.isArray(d) ? d as DvDoorStyle[] : []);
    setTerms(Array.isArray(t) ? t as DvTerms[] : []);
  }, []);

  useEffect(() => {
    _reloadRef.fn = fetchAll;
    fetchAll();

    W.loadDvCatalogue       = fetchAll;
    W.openDvHandleEditor    = (id?: number) => openDvItemEditor('handle', id);
    W.openDvFurnitureEditor = (id?: number) => openDvItemEditor('furniture', id);
    W.openDvDoorStyleEditor = (id?: number) => openDvItemEditor('door-style', id);

    return () => {
      _reloadRef.fn = null;
      ['loadDvCatalogue', 'openDvHandleEditor', 'openDvFurnitureEditor', 'openDvDoorStyleEditor']
        .forEach(k => delete W[k]);
    };
  }, [fetchAll]);

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
      showToast(`Failed to reorder: ${(e as Error).message}`, true);
    }
  }, [itemsFor, setterFor, endpointFor]);

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
      showToast(`Failed to reorder: ${(e as Error).message}`, true);
      fetchAll();
    }
  }, [itemsFor, setterFor, endpointFor, fetchAll]);

  const deleteItem = useCallback(async (type: string, id: number) => {
    if (!confirm('Delete this item? This cannot be undone.')) return;
    const ep = endpointFor(type);
    try {
      await callApi('DELETE', `${ep}/${id}`);
      showToast('Deleted.');
      _broadcastDvCatalogueChange(type);
      await fetchAll();
    } catch (e) {
      showToast('Delete failed: ' + (e as Error).message, true);
    }
  }, [endpointFor, fetchAll]);

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
      setTermsErr((e as Error).message || 'Publish failed.');
    }
  }, [termsNewText, fetchAll]);

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
            <Button variant="contained" onClick={() => openDvItemEditor('handle')} sx={{ flexShrink: 0 }}>
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
              onEdit={openDvItemEditor}
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
            <Button variant="contained" onClick={() => openDvItemEditor('furniture')} sx={{ flexShrink: 0 }}>
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
              onEdit={openDvItemEditor}
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
            <Button variant="contained" onClick={() => openDvItemEditor('door-style')} sx={{ flexShrink: 0 }}>
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
              onEdit={openDvItemEditor}
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
  );
}

export default DesignVisitPage;
