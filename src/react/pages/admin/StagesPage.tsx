import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import SyncIcon from '@mui/icons-material/Sync';
import { GET, POST, PATCH, DELETE } from '../../utils/api';
import { usePageTitle } from '../../hooks/usePageTitle';
import { useAdminUnsavedChanges } from '../../hooks/useAdminUnsavedChanges';
import { STAGE_COLORS } from '../../theme';

// ── Stage option constants ──────────────────────────────────────────────────

const STAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '—' },
  { value: 'SALES', label: 'Sales' },
  { value: 'DESIGN_VISIT', label: 'Design Visit' },
  { value: 'SURVEY', label: 'Survey' },
  { value: 'ORDER', label: 'Order' },
  { value: 'WORKSHOP', label: 'Workshop' },
  { value: 'PACKING', label: 'Packing' },
  { value: 'DELIVERY', label: 'Delivery' },
  { value: 'INSTALLATION', label: 'Installation' },
  { value: 'AFTERCARE', label: 'Aftercare' },
  { value: 'CUSTOMER_SERVICE', label: 'Customer Service' },
];

/** Maps lead_status_config.stage → STAGE_COLORS key (for row tints). */
const LS_STAGE_TO_COLORS_KEY: Record<string, string> = {
  SALES:            'sales',
  DESIGN_VISIT:     'designvisit',
  SURVEY:           'survey',
  ORDER:            'order',
  WORKSHOP:         'workshop',
  PACKING:          'packing',
  DELIVERY:         'delivery',
  INSTALLATION:     'installation',
  AFTERCARE:        'aftercare',
  CUSTOMER_SERVICE: 'customerservice',
};

/** Display order for stage groups (matches STAGE_OPTIONS order). */
const STAGE_DISPLAY_ORDER = [
  'SALES', 'DESIGN_VISIT', 'SURVEY', 'ORDER', 'WORKSHOP',
  'PACKING', 'DELIVERY', 'INSTALLATION', 'AFTERCARE', 'CUSTOMER_SERVICE',
];

// ── Types ──────────────────────────────────────────────────────────────────

interface LeadStatus {
  key: string;
  label: string;
  stage: string | null;
  sort_order: number;
  excluded_from_sales: boolean;
  is_null_row: boolean;
}

interface HandlerBinding {
  stage_key?: string;
  status_key?: string;
  substatus_id?: number | null;
}


interface LeadStatusHealthEntry {
  key: string;
  source: string;
  featureLabel?: string;
}

interface LeadStatusHealth {
  ok: boolean;
  missing: LeadStatusHealthEntry[];
  required: LeadStatusHealthEntry[];
}

// ── Table style constants ──────────────────────────────────────────────────

const TH: React.CSSProperties = {
  padding: '6px 8px',
  textAlign: 'left',
  borderBottom: '1px solid var(--neutral-200)',
  background: 'var(--neutral-50)',
  fontSize: '0.75rem',
  fontWeight: 600,
  color: 'var(--neutral-500)',
  whiteSpace: 'nowrap',
};
const TD: React.CSSProperties = {
  padding: '4px 8px',
  borderBottom: '1px solid #f3f4f6',
  verticalAlign: 'middle',
};

// ── Helpers ────────────────────────────────────────────────────────────────

const W = window as unknown as Record<string, unknown>;

function showToast(msg: string, err?: boolean) {
  if (typeof W.toast === 'function') (W.toast as (m: string, e?: boolean) => void)(msg, err);
}

function notifyLsChanged() {
  try { new BroadcastChannel('lead_statuses_changed').postMessage('changed'); } catch {}
  try { window.dispatchEvent(new CustomEvent('lead_statuses_changed')); } catch {}
  if (typeof W.loadCardActionsAdmin === 'function') (W.loadCardActionsAdmin as () => void)();
}

// ── NullStatusRow ──────────────────────────────────────────────────────────

function NullStatusRow({ status }: { status: LeadStatus }) {
  return (
    <tr style={{ background: 'var(--neutral-50)' }} data-ls-key={status.key} data-ls-no-delete="1">
      <td style={{ ...TD, textAlign: 'center' }}>
        <button className="btn btn-ghost" disabled style={{ fontSize: '.75rem', padding: '0 4px', opacity: 0.35 }}>↑</button>
        <button className="btn btn-ghost" disabled style={{ fontSize: '.75rem', padding: '0 4px', opacity: 0.35 }}>↓</button>
      </td>
      <td style={{ ...TD, color: 'var(--neutral-400)' }}>—</td>
      <td style={{ ...TD, fontFamily: 'var(--font-mono)', color: 'var(--neutral-400)', fontSize: '0.75rem' }}>— none —</td>
      <td style={TD}>
        <input type="text" className="field ls-label-input" defaultValue={status.label} data-key={status.key}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          style={{ width: '100%', minWidth: 140 }}
        />
      </td>
      <td style={{ ...TD, textAlign: 'center', color: 'var(--neutral-400)' }}>—</td>
      <td style={{ ...TD, textAlign: 'center', color: 'var(--neutral-400)' }}>—</td>
    </tr>
  );
}

// ── StatusRow ──────────────────────────────────────────────────────────────

function StatusRow({ status, index, total, bgColor, onMove, onDelete, isRequired, featureLabel, source }: {
  status: LeadStatus;
  index: number;
  total: number;
  bgColor: string;
  onMove: (key: string, dir: 'up' | 'down') => void;
  onDelete: (key: string) => void;
  isRequired: boolean;
  featureLabel?: string;
  source?: string;
}) {
  return (
    <tr style={{ background: bgColor }} data-ls-key={status.key}>
      <td style={{ ...TD, textAlign: 'center', whiteSpace: 'nowrap' }}>
        <button className="btn btn-ghost" title="Move up" disabled={index === 0}
          onClick={() => onMove(status.key, 'up')} style={{ fontSize: '.75rem', padding: '0 4px' }}>↑</button>
        <button className="btn btn-ghost" title="Move down" disabled={index === total - 1}
          onClick={() => onMove(status.key, 'down')} style={{ fontSize: '.75rem', padding: '0 4px' }}>↓</button>
      </td>
      <td style={TD}>
        <select className="field ls-stage-select" data-key={status.key} defaultValue={status.stage || ''}
          style={{ width: '100%', minWidth: 120 }}>
          {STAGE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </td>
      <td style={{ ...TD, fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>{status.key}</td>
      <td style={TD}>
        <input type="text" className="field ls-label-input" defaultValue={status.label} data-key={status.key}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          style={{ width: '100%', minWidth: 140 }}
        />
      </td>
      <td style={{ ...TD, textAlign: 'center' }}>
        <input type="checkbox" defaultChecked={!!status.excluded_from_sales} data-key={status.key} />
      </td>
      <td style={{ ...TD, textAlign: 'center' }}>
        {isRequired ? (
          <Tooltip title={
            <Box>
              <Box>{featureLabel
                ? `Required by: ${featureLabel} — cannot be deleted.`
                : 'This status is required by the application and cannot be deleted.'
              }</Box>
              {source && (
                <Box sx={{ mt: 0.5, fontSize: '0.8em', opacity: 0.8 }}>Used in: {source}</Box>
              )}
            </Box>
          }>
            <span style={{ display: 'inline-block', cursor: 'not-allowed' }}>
              <button
                className="btn btn-ghost"
                disabled
                style={{ fontSize: '.75rem', padding: '0 6px', color: 'var(--neutral-300)', pointerEvents: 'none' }}
              >✕</button>
            </span>
          </Tooltip>
        ) : (
          <button
            className="btn btn-ghost"
            title={`Delete ${status.key}`}
            onClick={() => onDelete(status.key)}
            style={{ fontSize: '.75rem', padding: '0 6px', color: 'var(--error-600)' }}
          >✕</button>
        )}
      </td>
    </tr>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export function StagesPage() {
  usePageTitle('Stages · Harry Wardrobes');

  // ── Lead statuses ──
  const [statuses, setStatuses] = useState<LeadStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [newKey, setNewKey] = useState('');
  const [newStage, setNewStage] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [addErr, setAddErr] = useState('');
  const [healthData,   setHealthData]   = useState<LeadStatusHealth | null>(null);
  // True when the table has pending (unsaved) label / stage / exclusion edits.
  const [tableDirty, setTableDirty] = useState(false);

  interface HsOption { value: string; label: string; displayOrder: number; hidden: boolean; }
  type ImportTag = 'NEW' | 'REORDERED' | 'OK';
  interface PreviewRow { option: HsOption; tag: ImportTag; }
  const [importOpen, setImportOpen] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [importConfirming, setImportConfirming] = useState(false);
  const [importRows, setImportRows] = useState<PreviewRow[]>([]);
  const [importOptions, setImportOptions] = useState<HsOption[]>([]);

  interface DeleteDialogState {
    open: boolean;
    key: string;
    usageCount: number | null;
    usageError: string | null;
    loading: boolean;
    deleting: boolean;
    deleteError: string | null;
  }
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState | null>(null);

  const statusesRef = useRef<LeadStatus[]>([]);

  // ── Fetch lead statuses ──

  const fetchStatuses = useCallback(async () => {
    try {
      const data = await GET<LeadStatus[]>('/api/admin/lead-statuses');
      const list = Array.isArray(data) ? data : [];
      setStatuses(list);
      statusesRef.current = list;
      setLoading(false);
      setReloadKey(k => k + 1);
      setTableDirty(false); // re-render resets uncontrolled inputs to the new baseline
    } catch {
      setLoading(false);
    }
  }, []);

  const fetchHealthData = useCallback(async () => {
    try {
      const data = await GET<LeadStatusHealth>('/api/admin/lead-status-health');
      setHealthData(data);
    } catch {
      setHealthData(null);
    }
  }, []);

  // ── Import from HubSpot ──

  const openImportModal = useCallback(async () => {
    setImportLoading(true);
    setImportOpen(true);
    setImportRows([]);
    try {
      const data = await GET<{ options: HsOption[] }>('/api/admin/hubspot-lead-statuses');
      const visible = (data.options || []).filter(o => !o.hidden);
      const localMap = new Map(statusesRef.current.map(s => [s.key, s]));
      const rows: PreviewRow[] = visible.map(opt => {
        const key = opt.value.toUpperCase();
        const local = localMap.get(key);
        let tag: ImportTag;
        if (!local) tag = 'NEW';
        else if (local.sort_order !== opt.displayOrder) tag = 'REORDERED';
        else tag = 'OK';
        return { option: { ...opt, value: key }, tag };
      });
      setImportRows(rows);
      setImportOptions(visible.map(o => ({ ...o, value: o.value.toUpperCase() })));
    } catch (e) {
      showToast((e as Error).message || 'Could not fetch HubSpot statuses.', true);
      setImportOpen(false);
    } finally {
      setImportLoading(false);
    }
  }, []);

  const confirmImport = useCallback(async () => {
    setImportConfirming(true);
    try {
      const data = await POST<{ upserted: number; skipped: number; syncError: boolean }>('/api/admin/hubspot-lead-statuses/import', { options: importOptions });
      if (data.syncError) {
        showToast(`Synced ${data.upserted} status${data.upserted !== 1 ? 'es' : ''} from HubSpot — HubSpot push failed, try re-syncing manually`, true);
      } else {
        showToast(`Synced ${data.upserted} status${data.upserted !== 1 ? 'es' : ''} from HubSpot and pushed options back`);
      }
      setImportOpen(false);
      await fetchStatuses();
      fetchHealthData();
      notifyLsChanged();
    } catch (e) {
      showToast((e as Error).message || 'Import failed.', true);
    } finally {
      setImportConfirming(false);
    }
  }, [importOptions, fetchStatuses, fetchHealthData]);

  // ── Save all ──

  const saveAll = useCallback(async () => {
    const wrap = document.getElementById('lead-statuses-table-wrap');
    if (!wrap) return;
    type RowChange = {
      key: string;
      diff: Record<string, unknown>;
      els: { lbl?: HTMLInputElement; stg?: HTMLSelectElement; excl?: HTMLInputElement };
      orig: LeadStatus;
    };
    const changes: RowChange[] = [];
    wrap.querySelectorAll<HTMLTableRowElement>('tr[data-ls-key]').forEach(row => {
      const key = row.dataset.lsKey!;
      const orig = statusesRef.current.find(s => s.key === key);
      if (!orig) return;
      const lbl  = row.querySelector<HTMLInputElement>('.ls-label-input') ?? undefined;
      const stg  = row.querySelector<HTMLSelectElement>('.ls-stage-select') ?? undefined;
      const excl = row.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? undefined;
      const newLbl  = lbl?.value.trim() ?? orig.label;
      const newStg2 = stg?.value || null;
      const newExcl = excl?.checked ?? orig.excluded_from_sales;
      if (!newLbl) return;
      const diff: Record<string, unknown> = {};
      if (newLbl !== orig.label) diff.label = newLbl;
      if (newStg2 !== (orig.stage || null)) diff.stage = newStg2;
      if (newExcl !== orig.excluded_from_sales) diff.excluded_from_sales = newExcl;
      if (Object.keys(diff).length) changes.push({ key, diff, els: { lbl, stg, excl }, orig });
    });
    if (!changes.length) { showToast('No changes to save.'); return; }
    let saved = 0, failed = 0;
    const msgs: string[] = [];
    for (const { key, diff, els, orig } of changes) {
      try {
        const updated = await PATCH<LeadStatus>(`/api/admin/lead-statuses/${encodeURIComponent(key)}`, diff);
        const next = [...statusesRef.current];
        const i = next.findIndex(s => s.key === key);
        if (i !== -1) next[i] = updated;
        setStatuses(next); statusesRef.current = next;
        saved++;
      } catch (e) {
        if (els.lbl)  els.lbl.value    = orig.label;
        if (els.stg)  els.stg.value    = orig.stage || '';
        if (els.excl) els.excl.checked = orig.excluded_from_sales;
        msgs.push(`${key}: ${(e as Error).message}`); failed++;
      }
    }
    if (failed) showToast(`Saved ${saved}, failed ${failed}. ${msgs[0] || ''}`.trim(), true);
    else showToast(`${saved} change${saved !== 1 ? 's' : ''} saved.`);
    notifyLsChanged();
  }, []);

  // ── Unsaved-changes guard ──
  // The table rows are uncontrolled inputs scraped on save, so dirtiness is
  // derived by comparing the live DOM against the loaded baseline.

  const recomputeDirty = useCallback(() => {
    const wrap = document.getElementById('lead-statuses-table-wrap');
    if (!wrap) { setTableDirty(false); return; }
    let dirty = false;
    wrap.querySelectorAll<HTMLTableRowElement>('tr[data-ls-key]').forEach(row => {
      if (dirty) return;
      const orig = statusesRef.current.find(s => s.key === row.dataset.lsKey);
      if (!orig) return;
      const lbl  = row.querySelector<HTMLInputElement>('.ls-label-input');
      const stg  = row.querySelector<HTMLSelectElement>('.ls-stage-select');
      const excl = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
      const newLbl  = lbl ? lbl.value.trim() : orig.label;
      const newStg  = stg ? (stg.value || null) : (orig.stage || null);
      const newExcl = excl ? excl.checked : orig.excluded_from_sales;
      if (!newLbl) return; // an empty label is ignored by saveAll, so don't flag it
      if (newLbl !== orig.label || newStg !== (orig.stage || null) || newExcl !== orig.excluded_from_sales) {
        dirty = true;
      }
    });
    setTableDirty(dirty);
  }, []);

  const discardTable = useCallback(() => {
    // Re-key the rows so the uncontrolled inputs reset to the loaded baseline.
    setReloadKey(k => k + 1);
    setTableDirty(false);
  }, []);

  const saveTable = useCallback(async () => {
    await saveAll();
    // saveAll either persists a row (baseline updated) or reverts the input on
    // failure, so nothing unsaved remains afterwards.
    recomputeDirty();
  }, [saveAll, recomputeDirty]);

  useAdminUnsavedChanges({ id: 'stages', isDirty: tableDirty, onSave: saveTable, onDiscard: discardTable });

  // ── Move status ──

  const moveStatus = useCallback(async (key: string, dir: 'up' | 'down', peers?: LeadStatus[]) => {
    if (!peers) {
      const target = statusesRef.current.find(s => s.key === key);
      const sameStage = statusesRef.current.filter(s => !s.is_null_row && s.stage === (target?.stage ?? null));
      peers = [...sameStage].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    }
    const idx = peers.findIndex(s => s.key === key);
    if (idx < 0) return;
    const si = dir === 'up' ? idx - 1 : idx + 1;
    if (si < 0 || si >= peers.length) return;
    const a = peers[idx], b = peers[si];
    try {
      // Swap atomically server-side: a partial unique index on sort_order
      // rejects the transient state two independent PATCHes would create.
      await POST('/api/admin/lead-statuses/reorder', { a: a.key, b: b.key });
      const next = [...statusesRef.current];
      const ai = next.findIndex(s => s.key === a.key);
      const bi = next.findIndex(s => s.key === b.key);
      if (ai !== -1) next[ai] = { ...next[ai], sort_order: b.sort_order };
      if (bi !== -1) next[bi] = { ...next[bi], sort_order: a.sort_order };
      setStatuses(next); statusesRef.current = next;
      setReloadKey(k => k + 1);
      setTableDirty(false); // re-keyed rows reset uncontrolled inputs to baseline
      notifyLsChanged();
    } catch (e) { showToast(`Failed to reorder: ${(e as Error).message}`, true); }
  }, []);

  // ── Add status ──

  const addStatus = useCallback(async () => {
    const k = newKey.trim().toUpperCase();
    const l = newLabel.trim();
    const s = newStage || null;
    if (!k) { setAddErr('Key is required.'); return; }
    if (!l) { setAddErr('Display label is required.'); return; }
    setAddErr('');
    try {
      const created = await POST<LeadStatus>('/api/admin/lead-statuses', { key: k, label: l, stage: s });
      const next = [...statusesRef.current, created];
      setStatuses(next); statusesRef.current = next;
      setNewKey(''); setNewStage(''); setNewLabel('');
      setReloadKey(rk => rk + 1);
      setTableDirty(false);
      notifyLsChanged();
      fetchHealthData();
    } catch (e) { setAddErr((e as Error).message || 'Failed to add status.'); }
  }, [newKey, newLabel, newStage, fetchHealthData]);

  // ── Delete status ──

  const deleteStatus = useCallback(async (key: string) => {
    setDeleteDialog({ open: true, key, usageCount: null, usageError: null, loading: true, deleting: false, deleteError: null });
    try {
      const data = await GET<{ count: number | null; hubspotAvailable: boolean }>(
        `/api/admin/lead-statuses/${encodeURIComponent(key)}/usage`
      );
      if (!data.hubspotAvailable) {
        setDeleteDialog(d => d?.key === key ? { ...d, loading: false, usageCount: null, usageError: 'HubSpot is not connected — could not verify usage' } : d);
      } else {
        setDeleteDialog(d => d?.key === key ? { ...d, loading: false, usageCount: data.count, usageError: null } : d);
      }
    } catch (e) {
      const msg = (e as Error).message || 'Could not check usage.';
      setDeleteDialog(d => d?.key === key ? { ...d, loading: false, usageCount: null, usageError: msg } : d);
    }
  }, []);

  const confirmDeleteStatus = useCallback(async () => {
    if (!deleteDialog) return;
    const { key } = deleteDialog;
    setDeleteDialog(d => d ? { ...d, deleting: true } : d);
    try {
      await DELETE(`/api/admin/lead-statuses/${encodeURIComponent(key)}`);
      const next = statusesRef.current.filter(s => s.key !== key);
      setStatuses(next); statusesRef.current = next;
      setReloadKey(rk => rk + 1);
      setTableDirty(false);
      setDeleteDialog(null);
      showToast(`Status "${key}" deleted.`);
      notifyLsChanged();
      fetchHealthData();
    } catch (e) {
      const msg = (e as Error).message || 'Failed to delete status.';
      setDeleteDialog(d => d ? { ...d, deleting: false, deleteError: msg } : d);
    }
  }, [deleteDialog, fetchHealthData]);

  // ── Window globals (cross-tab interop) ──

  useEffect(() => {
    W.saveAllLeadStatuses      = saveAll;
    W.moveLeadStatus           = (key: string, dir: 'up' | 'down') => moveStatus(key, dir);
    W.addLeadStatus            = addStatus;
    W.deleteLeadStatus         = deleteStatus;
    W.loadLeadStatusesAdmin    = fetchStatuses;
    W.reloadLeadStatusHealth   = fetchHealthData;
    return () => {
      delete W.saveAllLeadStatuses;
      delete W.moveLeadStatus;
      delete W.addLeadStatus;
      delete W.deleteLeadStatus;
      delete W.loadLeadStatusesAdmin;
      delete W.reloadLeadStatusHealth;
    };
  }, [saveAll, moveStatus, addStatus, deleteStatus, fetchStatuses, fetchHealthData]);

  // ── BroadcastChannel listener ──

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    let bc: BroadcastChannel;
    try {
      bc = new BroadcastChannel('lead_statuses_changed');
      bc.onmessage = () => { fetchStatuses(); fetchHealthData(); };
    } catch { return; }
    return () => bc.close();
  }, [fetchStatuses, fetchHealthData]);

  // ── Initial load ──

  useEffect(() => {
    fetchStatuses();
    fetchHealthData();
  }, [fetchStatuses, fetchHealthData]);

  // ── Derived data ──

  const real    = statuses.filter(s => !s.is_null_row);
  const nullRow = statuses.find(s => s.is_null_row);

  // Sort real statuses by stage display order, then sort_order within each stage.
  const sortedReal = [...real].sort((a, b) => {
    const ai = STAGE_DISPLAY_ORDER.indexOf(a.stage || '');
    const bi = STAGE_DISPLAY_ORDER.indexOf(b.stage || '');
    const stageDiff = (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    return stageDiff !== 0 ? stageDiff : (a.sort_order ?? 0) - (b.sort_order ?? 0);
  });

  // Group into consecutive stage buckets for rendering.
  const stageGroups: { stage: string | null; items: LeadStatus[] }[] = [];
  for (const s of sortedReal) {
    const last = stageGroups[stageGroups.length - 1];
    if (!last || last.stage !== s.stage) stageGroups.push({ stage: s.stage, items: [s] });
    else last.items.push(s);
  }

  // ── Render ──

  return (
    <Stack spacing={2}>

      {/* ── Lead Statuses ───────────────────────────────────────────────────── */}
      <Card variant="outlined">
        <CardContent>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, mb: 2 }}>
            <Box>
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Lead Statuses</Typography>
              <Typography variant="body2" color="text.secondary">
                Define the HubSpot lead status values and their display labels. Statuses marked
                "Excl. from Sales" are hidden from the Sales board.
              </Typography>
            </Box>
            <Box sx={{ display: 'flex', gap: 1, flexShrink: 0 }}>
              <Button
                variant="outlined"
                size="small"
                startIcon={<SyncIcon />}
                onClick={openImportModal}
                disabled={importLoading}
              >
                Import from HubSpot
              </Button>
              <Button variant="contained" onClick={saveTable}>Save</Button>
            </Box>
          </Box>

          {healthData && !healthData.ok && healthData.missing.length > 0 && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
                Pipeline configuration issue — {healthData.missing.length} required{' '}
                {healthData.missing.length === 1 ? 'status is' : 'statuses are'} missing
              </Typography>
              <Typography variant="body2" sx={{ mb: 1 }}>
                The following keys are used by the application but are not present in this list.
                Staff actions that rely on them will fail with an error until the keys are restored.
              </Typography>
              <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
                {healthData.missing.map(({ key, featureLabel, source }) => (
                  <Box component="li" key={key} sx={{ mb: 0.5 }}>
                    <Box component="code" sx={{ fontSize: '0.8em', fontWeight: 600 }}>{key}</Box>
                    {featureLabel && (
                      <Box component="span" sx={{ color: 'text.secondary', ml: 0.75, fontSize: '0.85em' }}>
                        — {featureLabel}
                      </Box>
                    )}
                    {source && (
                      <Box sx={{ fontSize: '0.78em', color: 'text.disabled', mt: 0.1, fontFamily: 'var(--font-mono)' }}>
                        Used in: {source}
                      </Box>
                    )}
                  </Box>
                ))}
              </Box>
            </Alert>
          )}

          <div id="lead-statuses-table-wrap" onInput={recomputeDirty} onChange={recomputeDirty}>
            {loading ? (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1 }}>
                <CircularProgress size={16} />
                <Typography variant="body2" color="text.secondary">Loading…</Typography>
              </Box>
            ) : (!nullRow && !real.length) ? (
              <p className="admin-msg admin-msg--muted">No statuses configured yet.</p>
            ) : (
              <Box sx={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
                  <thead>
                    <tr>
                      <th style={{ ...TH, textAlign: 'center' }}>Order</th>
                      <th style={TH}>Stage</th>
                      <th style={TH}>Key</th>
                      <th style={TH}>Display Label</th>
                      <th style={{ ...TH, textAlign: 'center' }}>Excl.</th>
                      <th style={{ ...TH, textAlign: 'center' }}>Delete</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* No Status row: show at top only if there is no SALES stage group.
                        When SALES exists it renders inside that group (contacts with no
                        status appear in the Sales stage tab). */}
                    {nullRow && !stageGroups.some(g => g.stage === 'SALES') && (
                      <NullStatusRow
                        key={`${nullRow.key}-${reloadKey}`}
                        status={nullRow}
                      />
                    )}
                    {stageGroups.map(({ stage, items }) => {
                      const ck = stage ? (LS_STAGE_TO_COLORS_KEY[stage] ?? '') : '';
                      const colors = ck ? STAGE_COLORS[ck] : null;
                      const stageLabel = STAGE_OPTIONS.find(o => o.value === stage)?.label ?? (stage || 'No stage assigned');
                      const rowBg = colors ? colors.light : '#f9fafb';
                      const isSales = stage === 'SALES';
                      return (
                        <React.Fragment key={stage ?? '__none__'}>
                          <tr>
                            <td colSpan={8} style={{
                              padding: '3px 8px',
                              fontSize: '0.7rem',
                              fontWeight: 700,
                              letterSpacing: '0.06em',
                              textTransform: 'uppercase',
                              background: colors ? colors.bg : 'var(--neutral-300)',
                              color: 'white',
                              borderTop: '2px solid transparent',
                            }}>
                              {stageLabel}
                            </td>
                          </tr>
                          {isSales && nullRow && (
                            <NullStatusRow
                              key={`${nullRow.key}-${reloadKey}`}
                              status={nullRow}
                            />
                          )}
                          {items.map((s, i) => (
                            <StatusRow
                              key={`${s.key}-${reloadKey}`}
                              status={s}
                              index={i}
                              total={items.length}
                              bgColor={rowBg}
                              onMove={(key, dir) => moveStatus(key, dir, items)}
                              onDelete={deleteStatus}
                              isRequired={healthData === null || (healthData.required?.some(r => r.key === s.key) ?? false)}
                              featureLabel={healthData?.required?.find(r => r.key === s.key)?.featureLabel}
                              source={healthData?.required?.find(r => r.key === s.key)?.source}
                            />
                          ))}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </Box>
            )}
          </div>

          <Box sx={{ mt: 3, p: 2, borderRadius: 1, border: 1, borderColor: 'divider', bgcolor: 'background.default' }}>
            <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>Add new status</Typography>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ alignItems: { md: 'flex-end' } }}>
              <TextField size="small" label="Key (e.g. AWAITING_PHOTOS)" placeholder="KEY"
                value={newKey} onChange={(e) => setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
                slotProps={{ htmlInput: { id: 'ls-new-key', maxLength: 64 }}} sx={{ flex: 1 }} />
              <Box sx={{ minWidth: 160, display: 'flex', flexDirection: 'column' }}>
                <Typography component="label" htmlFor="ls-new-stage" variant="caption" color="text.secondary" sx={{ mb: 0.5 }}>Stage</Typography>
                <select id="ls-new-stage" value={newStage} onChange={(e) => setNewStage(e.target.value)}
                  style={{ height: 40, padding: '8px 12px', borderRadius: 4, border: '1px solid rgba(0,0,0,0.23)', background: 'white', font: 'inherit' }}>
                  {STAGE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </Box>
              <TextField size="small" label="Display label" placeholder="Human-readable label"
                value={newLabel} onChange={(e) => setNewLabel(e.target.value)}
                slotProps={{ htmlInput: { id: 'ls-new-label', maxLength: 128 }}} sx={{ flex: 2 }} />
              <Button variant="contained" onClick={addStatus}>Add status</Button>
            </Stack>
            {addErr && <Typography variant="caption" color="error" sx={{ mt: 1, display: 'block' }}>{addErr}</Typography>}
            <div id="ls-add-error" style={{ display: 'none' }} />
          </Box>
        </CardContent>
      </Card>

      {/* ── Delete dialog ────────────────────────────────────────────────────── */}
      <Dialog
        open={!!deleteDialog?.open}
        onClose={() => { if (!deleteDialog?.deleting) setDeleteDialog(null); }}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Delete lead status</DialogTitle>
        <DialogContent dividers>
          {deleteDialog?.loading ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 1 }}>
              <CircularProgress size={18} />
              <Typography variant="body2" color="text.secondary">Checking HubSpot contacts…</Typography>
            </Box>
          ) : deleteDialog?.usageError ? (
            <Stack spacing={1.5}>
              <Typography variant="body2">
                Delete lead status <strong style={{ fontFamily: 'var(--font-mono)' }}>{deleteDialog?.key}</strong>? This cannot be undone.
              </Typography>
              <Alert severity="warning" sx={{ fontSize: '0.8125rem' }}>
                Could not check HubSpot usage ({deleteDialog.usageError}). Proceed with caution.
              </Alert>
            </Stack>
          ) : (deleteDialog?.usageCount ?? 0) > 0 ? (
            <Stack spacing={1.5}>
              <Typography variant="body2">
                Delete lead status <strong style={{ fontFamily: 'var(--font-mono)' }}>{deleteDialog?.key}</strong>? This cannot be undone.
              </Typography>
              <Alert severity="warning" sx={{ fontSize: '0.8125rem' }}>
                <strong>{deleteDialog!.usageCount} contact{deleteDialog!.usageCount === 1 ? '' : 's'}</strong> currently
                {deleteDialog!.usageCount === 1 ? ' has' : ' have'} this status in HubSpot — deleting it will break their pipeline card until their HubSpot record is updated.
              </Alert>
            </Stack>
          ) : (
            <Typography variant="body2">
              Delete lead status <strong style={{ fontFamily: 'var(--font-mono)' }}>{deleteDialog?.key}</strong>? This cannot be undone.
              {deleteDialog?.usageCount === 0 && (
                <> No HubSpot contacts are currently using this status.</>
              )}
            </Typography>
          )}
          {deleteDialog?.deleteError && (
            <Alert severity="error" sx={{ fontSize: '0.8125rem', mt: 1.5 }}>
              {deleteDialog.deleteError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialog(null)} disabled={deleteDialog?.deleting}>Cancel</Button>
          <Button
            variant="contained"
            color="error"
            onClick={confirmDeleteStatus}
            disabled={deleteDialog?.loading || deleteDialog?.deleting}
            startIcon={deleteDialog?.deleting ? <CircularProgress size={14} color="inherit" /> : undefined}
          >
            {deleteDialog?.deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* ── Import from HubSpot dialog ──────────────────────────────────────── */}
      <Dialog open={importOpen} onClose={() => { if (!importConfirming) setImportOpen(false); }} maxWidth="sm" fullWidth>
        <DialogTitle>Import lead statuses from HubSpot</DialogTitle>
        <DialogContent dividers>
          {importLoading ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 2 }}>
              <CircularProgress size={18} />
              <Typography variant="body2" color="text.secondary">Fetching HubSpot statuses…</Typography>
            </Box>
          ) : importRows.length === 0 ? (
            <Typography variant="body2" color="text.secondary">No visible statuses found in HubSpot.</Typography>
          ) : (
            <Stack spacing={0}>
              {importRows.map(({ option, tag }) => (
                <Box key={option.value} sx={{
                  display: 'flex', alignItems: 'center', gap: 1.5, py: 0.75,
                  borderBottom: '1px solid', borderColor: 'divider',
                }}>
                  <Box sx={{ flex: 1 }}>
                    <Typography variant="body2" sx={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>{option.value}</Typography>
                    <Typography variant="caption" color="text.secondary">{option.label}</Typography>
                  </Box>
                  <Box component="span" sx={{
                    fontSize: '0.7rem', fontWeight: 600, px: 0.75, py: 0.25, borderRadius: 0.5,
                    bgcolor: tag === 'NEW' ? 'success.light' : tag === 'REORDERED' ? 'warning.light' : 'action.hover',
                    color: tag === 'NEW' ? 'success.dark' : tag === 'REORDERED' ? 'warning.dark' : 'text.secondary',
                  }}>
                    {tag}
                  </Box>
                </Box>
              ))}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setImportOpen(false)} disabled={importConfirming}>Cancel</Button>
          <Button
            variant="contained"
            onClick={confirmImport}
            disabled={importLoading || importRows.length === 0 || importConfirming}
            startIcon={importConfirming ? <CircularProgress size={14} color="inherit" /> : undefined}
          >
            {importConfirming ? 'Importing…' : 'Import'}
          </Button>
        </DialogActions>
      </Dialog>

    </Stack>
  );
}
