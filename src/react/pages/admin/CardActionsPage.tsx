import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Card, CardContent, CircularProgress, Stack, Typography } from '@mui/material';
import { useToast } from '../../contexts/ToastContext';
import { GET, POST, PATCH, PUT } from '../../utils/api';

// ── Constants ─────────────────────────────────────────────────────────────────

const CARD_ACTION_STAGES: Array<{ key: string; label: string; lsStage: string }> = [
  { key: 'sales',       label: 'Sales',        lsStage: 'SALES'        },
  { key: 'designvisit', label: 'Design Visit', lsStage: 'DESIGN_VISIT' },
  { key: 'survey',      label: 'Survey',       lsStage: 'SURVEY'       },
];
const STAGE_FOR_LS: Record<string, string> = Object.fromEntries(
  CARD_ACTION_STAGES.map(s => [s.lsStage, s.key]),
);

const HANDLER_TYPE_LABELS: Record<string, string> = {
  add_design_visit_to_calendar: 'Add design visit to calendar',
  summarise_phone_call:         'Summarise phone call',
  show_message:                 'Show informational message',
  start_design_visit:           'Start design visit wizard',
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface LeadStatus {
  key: string; label: string; stage: string | null; shorthand: string;
  sort_order: number; excluded_from_sales: boolean; is_null_row: boolean;
}
interface Substatus {
  id: number; status_key: string; substatus_key: string;
  label: string; action_label: string; sort_order: number;
  hubspotSyncWarning?: string;
}
interface CALabel  { stage_key: string; status_key: string; label: string; }
interface Binding  { stage_key?: string; status_key?: string; substatus_id?: number | null; }
interface Handler  { id: number; name: string; type: string; config: Record<string, unknown>; bindings: Binding[]; }

interface StatusModel {
  key: string; label: string; shorthand: string;
  defaultLabel: string; defaultStatusKey: string; isNullRow: boolean;
  substatuses: Substatus[];
}
interface StageModel { key: string; label: string; statuses: StatusModel[]; }
interface NewSubRow  { id: number; lsKey: string; prefix: string; }

// ── Helpers ───────────────────────────────────────────────────────────────────

const W = window as unknown as Record<string, unknown>;

function buildModel(
  labels: CALabel[], statuses: LeadStatus[], substatuses: Substatus[],
): StageModel[] {
  const labelByKey: Record<string, string> = {};
  for (const r of labels) labelByKey[`${r.stage_key}|${r.status_key}`] = r.label;

  const subsByLsUpper: Record<string, Substatus[]> = {};
  for (const s of substatuses) {
    const k = String(s.status_key).toUpperCase();
    (subsByLsUpper[k] = subsByLsUpper[k] || []).push(s);
  }

  const stageMap = new Map<string, StageModel>();
  for (const cs of CARD_ACTION_STAGES) {
    stageMap.set(cs.key, { key: cs.key, label: cs.label, statuses: [] });
  }

  const nullRow = statuses.find(s => s.is_null_row);
  const real    = statuses.filter(s => !s.is_null_row);

  for (const s of real) {
    const sk = STAGE_FOR_LS[s.stage || ''];
    if (!sk) continue;
    const stage  = stageMap.get(sk)!;
    const lsKey  = String(s.key || '');
    const defKey = lsKey.toLowerCase();
    stage.statuses.push({
      key: lsKey, label: s.label, shorthand: s.shorthand || '',
      defaultLabel: labelByKey[`${sk}|${defKey}`] || '',
      defaultStatusKey: defKey, isNullRow: false,
      substatuses: (subsByLsUpper[lsKey.toUpperCase()] || [])
        .slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)),
    });
  }

  // Null-status row goes first in the Sales stage
  const salesStage = stageMap.get('sales');
  if (salesStage && nullRow) {
    salesStage.statuses.unshift({
      key: '__NULL__', label: nullRow.label, shorthand: nullRow.shorthand || '',
      defaultLabel: labelByKey['sales|'] || '',
      defaultStatusKey: '', isNullRow: true,
      substatuses: [],
    });
  }

  return Array.from(stageMap.values());
}

function handlersForSlot(
  handlers: Handler[],
  stageKey: string,
  statusKey: string,
  substatusId?: number | null,
): Handler[] {
  return handlers.filter(h => h.bindings?.some(b => {
    if (substatusId != null) return Number(b.substatus_id) === substatusId;
    if (b.substatus_id != null) return false;
    return (b.stage_key || '').toLowerCase()  === (stageKey  || '').toLowerCase()
        && (b.status_key || '').toLowerCase() === (statusKey || '').toLowerCase();
  }));
}

// ── HandlerBadges ─────────────────────────────────────────────────────────────

function HandlerBadges({
  stageKey, statusKey, substatusId, handlers,
}: {
  stageKey: string; statusKey: string; substatusId?: number | null; handlers: Handler[];
}) {
  const matched = handlersForSlot(handlers, stageKey, statusKey, substatusId);
  if (!matched.length) return null;

  const openFix = () => {
    if (typeof W.openConflictResolver !== 'function') return;
    const fn = W.openConflictResolver as (a: string | null, b: string | null, c: number | null) => void;
    if (substatusId != null) fn(null, null, substatusId);
    else fn(stageKey, statusKey, null);
  };

  return (
    <span style={{ marginLeft: 6, display: 'inline-flex', alignItems: 'center', gap: 4, verticalAlign: 'middle' }}>
      {matched.map(h => (
        <span key={h.id} className="ca-handler-badge adm-handler-badge"
          title={`${HANDLER_TYPE_LABELS[h.type] || h.type} — manage in Action handlers`}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            padding: '1px 7px', background: '#ede9fe', color: '#5b21b6',
            borderRadius: 999, fontSize: '.7rem', fontWeight: 600,
          }}>
          <span aria-hidden="true">⚡</span>
          <span>{String(h.config?.action_name || HANDLER_TYPE_LABELS[h.type] || h.type)}</span>
        </span>
      ))}
      {matched.length > 1 && (
        <button type="button" className="ca-fix-conflict-btn"
          title="Multiple handlers bound to this slot — click to resolve"
          onClick={openFix}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            padding: '1px 8px', marginLeft: 4, background: '#fef3c7',
            color: '#92400e', border: '1px solid #fbbf24',
            borderRadius: 999, fontSize: '.7rem', fontWeight: 700,
            lineHeight: 1.5, whiteSpace: 'nowrap', cursor: 'pointer',
          }}>
          ⚠ Fix
        </button>
      )}
    </span>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CardActionsPage() {
  const showToast = useToast();
  const [labels,      setLabels]      = useState<CALabel[]>([]);
  const [statuses,    setStatuses]    = useState<LeadStatus[]>([]);
  const [substatuses, setSubstatuses] = useState<Substatus[]>([]);
  const [handlers,    setHandlers]    = useState<Handler[]>([]);
  const [collapsed,   setCollapsed]   = useState<Set<string>>(
    new Set(CARD_ACTION_STAGES.map(s => s.key)),
  );
  const [newSubRows,    setNewSubRows]    = useState<NewSubRow[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [reloadKey,     setReloadKey]     = useState(0);
  const [resolvedSlots, setResolvedSlots] = useState<Set<string>>(new Set());

  const substatusesRef = useRef<Substatus[]>([]);
  const statusesRef    = useRef<LeadStatus[]>([]);
  const [syncWarning, setSyncWarning] = useState<string | null>(null);

  // ── Fetch ──────────────────────────────────────────────────────────────────

  const fetchAll = useCallback(async () => {
    try {
      const [lbl, sta, sub, hdl] = await Promise.all([
        GET('/api/admin/stage-action-labels'),
        GET('/api/admin/lead-statuses'),
        GET('/api/admin/lead-substatuses'),
        GET('/api/admin/card-action-handlers'),
      ]) as [CALabel[], LeadStatus[], Substatus[], Handler[]];
      const safeArr = <T,>(x: unknown): T[] => Array.isArray(x) ? x as T[] : [];
      setLabels(safeArr(lbl));
      setStatuses(safeArr(sta));
      setSubstatuses(safeArr(sub));
      setHandlers(safeArr(hdl));
      substatusesRef.current = safeArr(sub);
      statusesRef.current    = safeArr(sta);
      setNewSubRows([]);
      setReloadKey(k => k + 1);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // ── BroadcastChannel sync ──────────────────────────────────────────────────

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    let bc1: BroadcastChannel | undefined;
    let bc2: BroadcastChannel | undefined;
    try {
      bc1 = new BroadcastChannel('lead_statuses_changed');
      bc1.onmessage = () => fetchAll();
      bc2 = new BroadcastChannel('card_action_handlers_changed');
      bc2.onmessage = () => fetchAll();
    } catch { /* ignore */ }
    return () => { try { bc1?.close(); bc2?.close(); } catch { /* ignore */ } };
  }, [fetchAll]);

  // ── Window exposures ───────────────────────────────────────────────────────

  const saveAllCardActionLabels = useCallback(async () => {
    let saved = 0, failed = 0;
    const failures: string[] = [];
    let hubSyncFailed = false;

    // Default-label inputs
    for (const input of Array.from(
      document.querySelectorAll<HTMLInputElement>('#card-actions-table-wrap .ca-default-input')
    )) {
      const value = input.value.trim();
      const original = input.dataset.original || '';
      if (!value) {
        if (original) {
          try {
            await PUT('/api/admin/stage-action-labels',
              { stage_key: input.dataset.stage, status_key: input.dataset.status, label: '' });
            input.dataset.original = ''; saved++;
          } catch (e) {
            input.value = original; failed++;
            failures.push(`default (${input.dataset.stage}/${input.dataset.status || '—'}): ${(e as Error).message}`);
          }
        }
        continue;
      }
      if (value === original) continue;
      try {
        await PUT('/api/admin/stage-action-labels',
          { stage_key: input.dataset.stage, status_key: input.dataset.status, label: value });
        input.dataset.original = value; saved++;
      } catch (e) {
        input.value = original; failed++;
        failures.push(`default (${input.dataset.stage}/${input.dataset.status || '—'}): ${(e as Error).message}`);
      }
    }

    // Sub-status rows
    for (const row of Array.from(
      document.querySelectorAll<HTMLElement>('#card-actions-table-wrap .ca-sub-row')
    )) {
      const isNew    = !!row.dataset.subNew;
      const idStr    = row.dataset.subId;
      const lsKey    = row.dataset.subLs;
      const keyInput   = row.querySelector<HTMLInputElement>('.ca-sub-key');
      const labelInput = row.querySelector<HTMLInputElement>('.ca-sub-label');
      const actInput   = row.querySelector<HTMLInputElement>('.ca-sub-action');
      if (!keyInput || !labelInput || !actInput) continue;
      const keyPrefix = keyInput.dataset.keyPrefix || '';
      const keySuffix = keyInput.value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
      const subKey    = (keyPrefix + keySuffix).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
      const label     = labelInput.value.trim();
      const action    = actInput.value.trim();

      if (isNew) {
        if (keyPrefix && !keySuffix) { if (label || action) { failed++; failures.push(`new sub-status (${lsKey}): type a suffix after ${keyPrefix}`); } continue; }
        if (!subKey || !label) { if (subKey || label || action) { failed++; failures.push(`new sub-status (${lsKey}): key and display label are required.`); } continue; }
        try {
          const created = await POST<Substatus>('/api/admin/lead-substatuses',
            { status_key: lsKey, substatus_key: subKey, label, action_label: action, sort_order: 0 });
          if (created.hubspotSyncWarning) hubSyncFailed = true;
          row.removeAttribute('data-sub-new');
          row.dataset.subId      = String(created.id);
          row.dataset.origKey    = created.substatus_key;
          row.dataset.origLabel  = created.label;
          row.dataset.origAction = created.action_label || '';
          keyInput.value = keyPrefix && created.substatus_key.startsWith(keyPrefix)
            ? created.substatus_key.slice(keyPrefix.length) : created.substatus_key;
          saved++;
        } catch (e) {
          failed++; failures.push(`new sub-status (${lsKey}/${subKey}): ${(e as Error).message}`);
        }
      } else {
        const origKey    = row.dataset.origKey    || '';
        const origLabel  = row.dataset.origLabel  || '';
        const origAction = row.dataset.origAction || '';
        const patch: Record<string, unknown> = {};
        if (subKey  !== origKey)    patch.substatus_key = subKey;
        if (label   !== origLabel)  patch.label         = label;
        if (action  !== origAction) patch.action_label  = action;
        if (!Object.keys(patch).length) continue;
        if (patch.label === '') { failed++; failures.push(`sub-status #${idStr}: label cannot be empty.`); continue; }
        try {
          const updated = await PATCH<Substatus>(`/api/admin/lead-substatuses/${idStr}`, patch);
          if (updated.hubspotSyncWarning) hubSyncFailed = true;
          row.dataset.origKey    = updated.substatus_key;
          row.dataset.origLabel  = updated.label;
          row.dataset.origAction = updated.action_label || '';
          keyInput.value = keyPrefix && updated.substatus_key.startsWith(keyPrefix)
            ? updated.substatus_key.slice(keyPrefix.length) : updated.substatus_key;
          saved++;
        } catch (e) {
          failed++; failures.push(`sub-status #${idStr}: ${(e as Error).message}`);
        }
      }
    }

    // Persist sort order
    const groups = new Map<string, number[]>();
    for (const row of Array.from(
      document.querySelectorAll<HTMLElement>('#card-actions-table-wrap .ca-sub-row')
    )) {
      const ls = row.dataset.subLs;
      const id = row.dataset.subId ? Number(row.dataset.subId) : null;
      if (!ls || !id) continue;
      if (!groups.has(ls)) groups.set(ls, []);
      groups.get(ls)!.push(id);
    }
    for (const [, ids] of groups) {
      for (let i = 0; i < ids.length; i++) {
        const sub = substatusesRef.current.find(s => Number(s.id) === ids[i]);
        if ((sub?.sort_order ?? -1) === i) continue;
        try {
          const reordered = await PATCH<Substatus>(`/api/admin/lead-substatuses/${ids[i]}`, { sort_order: i });
          if (reordered.hubspotSyncWarning) hubSyncFailed = true;
          if (sub) sub.sort_order = i;
          saved++;
        } catch (e) {
          failed++; failures.push(`reorder sub-status #${ids[i]}: ${(e as Error).message}`);
        }
      }
    }

    if (saved === 0 && failed === 0) { showToast('No changes to save.'); return; }
    if (failed) showToast(`Saved ${saved}, failed ${failed}.`, true);
    else        showToast(`${saved} change${saved !== 1 ? 's' : ''} saved.`);
    if (hubSyncFailed) setSyncWarning('Sub-status saved locally, but the HubSpot property sync failed. Use the Re-sync button in the Settings tab to retry.');

    try { new BroadcastChannel('stage_action_labels_changed').postMessage({ ts: Date.now() }); } catch { /* ignore */ }
    try { new BroadcastChannel('lead_substatuses_changed').postMessage({ ts: Date.now() }); } catch { /* ignore */ }
    fetchAll();
  }, [fetchAll, showToast]);

  const addCardActionSubstatus = useCallback((lsKey: string) => {
    const ls = statusesRef.current.find(s => s.key === lsKey);
    const sh = ls?.shorthand ? String(ls.shorthand).toUpperCase() : '';
    const prefix = sh ? `${sh}_` : '';
    setNewSubRows(prev => [...prev, { id: Date.now(), lsKey, prefix }]);
    const stageKey = STAGE_FOR_LS[ls?.stage || ''];
    if (stageKey) setCollapsed(prev => { const n = new Set(prev); n.delete(stageKey); return n; });
  }, []);

  const moveCardActionSubstatus = useCallback(async (id: number, direction: 'up' | 'down') => {
    const me = substatusesRef.current.find(s => Number(s.id) === id);
    if (!me) return;
    const siblings = substatusesRef.current
      .filter(s => String(s.status_key).toUpperCase() === String(me.status_key).toUpperCase())
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    const idx     = siblings.findIndex(s => Number(s.id) === id);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= siblings.length) return;
    const a = siblings[idx], b = siblings[swapIdx];
    if ((a.sort_order || 0) === (b.sort_order || 0)) siblings.forEach((s, i) => { s.sort_order = i; });
    const aOrder = a.sort_order, bOrder = b.sort_order;
    try {
      const [ra, rb] = await Promise.all([
        PATCH<Substatus>(`/api/admin/lead-substatuses/${a.id}`, { sort_order: bOrder }),
        PATCH<Substatus>(`/api/admin/lead-substatuses/${b.id}`, { sort_order: aOrder }),
      ]);
      if (ra.hubspotSyncWarning || rb.hubspotSyncWarning) {
        setSyncWarning('Sub-status saved locally, but the HubSpot property sync failed. Use the Re-sync button in the Settings tab to retry.');
      }
      a.sort_order = bOrder; b.sort_order = aOrder;
      fetchAll();
    } catch (e) { showToast(`Failed to reorder: ${(e as Error).message}`, true); }
  }, [fetchAll, showToast]);

  useEffect(() => {
    W.loadCardActionsAdmin    = fetchAll;
    W.saveAllCardActionLabels = saveAllCardActionLabels;
    W.addCardActionSubstatus  = addCardActionSubstatus;
    W.moveCardActionSubstatus = (id: number, dir: 'up' | 'down') => moveCardActionSubstatus(id, dir);
    return () => {
      delete W.loadCardActionsAdmin;
      delete W.saveAllCardActionLabels;
      delete W.addCardActionSubstatus;
      delete W.moveCardActionSubstatus;
    };
  }, [fetchAll, saveAllCardActionLabels, addCardActionSubstatus, moveCardActionSubstatus]);

  useEffect(() => {
    W.flashResolvedSlot = (stageKey: string, statusKey: string, substatusId: number | null) => {
      const k = substatusId != null ? `sub:${substatusId}` : `ls:${stageKey}:${statusKey}`;
      setResolvedSlots(prev => new Set([...prev, k]));
      setTimeout(() => setResolvedSlots(prev => { const n = new Set(prev); n.delete(k); return n; }), 1900);
    };
    return () => { delete W.flashResolvedSlot; };
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────

  const stages = buildModel(labels, statuses, substatuses);

  const toggleStage = (key: string) => setCollapsed(prev => {
    const n = new Set(prev);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  return (
    <Stack spacing={2}>
      {syncWarning && (
        <Alert
          severity="warning"
          onClose={() => setSyncWarning(null)}
          sx={{ mb: 0 }}
        >
          {syncWarning}
        </Alert>
      )}
      <Card variant="outlined">
        <CardContent>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, mb: 2 }}>
            <Box>
              <Typography variant="h6">Card action labels</Typography>
              <Typography variant="body2" color="text.secondary">
                The bottom strip on Sales &amp; Survey cards. One row per (stage × lead status);
                rows mirror the Lead Statuses table order and refresh automatically when renamed.
              </Typography>
            </Box>
            <Button variant="contained" onClick={saveAllCardActionLabels} sx={{ flexShrink: 0 }}>Save</Button>
          </Box>

          <div id="card-actions-table-wrap">
            {loading ? (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1 }}>
                <CircularProgress size={16} />
                <Typography variant="body2" color="text.secondary">Loading…</Typography>
              </Box>
            ) : !stages.length ? (
              <p className="admin-msg admin-msg--muted">No card action stages configured.</p>
            ) : stages.map(stage => {
              const isCollapsed = collapsed.has(stage.key);
              const bodyId = `ca-stage-body-${stage.key}`;
              return (
                <section className="adm-ca-stage" key={stage.key} data-stage-section={stage.key}>
                  <button type="button"
                    className={`ca-stage-toggle adm-ca-stage-toggle${isCollapsed ? ' is-collapsed' : ''}`}
                    data-stage-toggle={stage.key}
                    aria-expanded={!isCollapsed}
                    aria-controls={bodyId}
                    onClick={() => toggleStage(stage.key)}>
                    <span className={`ca-stage-chevron adm-ca-chevron${isCollapsed ? ' is-collapsed' : ''}`} aria-hidden="true">▾</span>
                    <span className="fw-600">{stage.label}</span>
                  </button>
                  <div id={bodyId} data-stage-body={stage.key} style={isCollapsed ? { display: 'none' } : undefined}>
                    {stage.statuses.length === 0 ? (
                      <div className="adm-ca-empty"><em>No lead statuses configured for this stage yet.</em></div>
                    ) : stage.statuses.map(ls => {
                      const stageNewRows = newSubRows.filter(r => r.lsKey === ls.key);
                      return (
                        <div key={`${ls.key}-${reloadKey}`} className="adm-ca-block" data-ls-block={ls.key}>
                          <div className="adm-ca-block-head">
                            <strong className={`adm-ca-block-title${ls.isNullRow ? ' is-null' : ''}`}>{ls.label}</strong>
                            {ls.isNullRow
                              ? <span className="adm-text-muted-xs">contact has no <code>hs_lead_status</code> — also used as the <strong>stage default</strong> for any lead status without a per-LS row below</span>
                              : <span className="adm-text-faint-mono">{ls.key}</span>}
                          </div>

                          <div className="adm-ca-default-row">
                            <div className="adm-ca-default-label">Default action label</div>
                            <input type="text" className="field ca-default-input adm-ca-default-input"
                              maxLength={128}
                              data-kind="ls-default"
                              data-stage={stage.key}
                              data-status={ls.defaultStatusKey}
                              data-original={ls.defaultLabel}
                              defaultValue={ls.defaultLabel}
                              placeholder="(used when no sub-status set)"
                              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                            />
                            <HandlerBadges stageKey={stage.key} statusKey={ls.defaultStatusKey} handlers={handlers} />
                            {resolvedSlots.has(`ls:${stage.key}:${ls.defaultStatusKey}`) && (
                              <span className="ca-resolved-pill" style={{
                                display: 'inline-flex', alignItems: 'center',
                                padding: '1px 8px', marginLeft: 6,
                                background: '#d1fae5', color: '#065f46',
                                borderRadius: 999, fontSize: '.7rem', fontWeight: 600,
                                lineHeight: 1.5, whiteSpace: 'nowrap', verticalAlign: 'middle',
                              }}>✓ Resolved</span>
                            )}
                          </div>

                          <div className="adm-ca-sub-list" data-sub-list={ls.key}>
                            {ls.substatuses.map((sub, i) => {
                              const sh     = ls.shorthand ? String(ls.shorthand).toUpperCase() : '';
                              const prefix = (sh && sub.substatus_key.toUpperCase().startsWith(`${sh}_`)) ? `${sh}_` : '';
                              const suffix = prefix ? sub.substatus_key.slice(prefix.length) : sub.substatus_key;
                              const isFirst = i === 0;
                              const isLast  = i === ls.substatuses.length - 1 && stageNewRows.length === 0;
                              return (
                                <div key={sub.id} className="ca-sub-row adm-ca-sub-row"
                                  data-sub-id={sub.id} data-sub-ls={ls.key}
                                  data-orig-key={sub.substatus_key} data-orig-label={sub.label}
                                  data-orig-action={sub.action_label || ''}>
                                  <div className="adm-ca-sub-arrows">
                                    <button type="button" className={`btn btn-ghost adm-ca-sub-arrow${isFirst ? ' adm-ca-sub-arrow--dim' : ''}`}
                                      title="Move up" disabled={isFirst}
                                      onClick={() => moveCardActionSubstatus(sub.id, 'up')}>▲</button>
                                    <button type="button" className={`btn btn-ghost adm-ca-sub-arrow${isLast ? ' adm-ca-sub-arrow--dim' : ''}`}
                                      title="Move down" disabled={isLast}
                                      onClick={() => moveCardActionSubstatus(sub.id, 'down')}>▼</button>
                                  </div>
                                  <div className="adm-ca-sub-key-wrap">
                                    {prefix && (
                                      <span className="ca-sub-key-prefix adm-ca-sub-key-prefix"
                                        title="Lead-status shorthand (not editable)">{prefix}</span>
                                    )}
                                    <input type="text"
                                      className={`field ca-sub-key adm-ca-sub-key${prefix ? ' adm-ca-sub-key--has-prefix' : ''}`}
                                      maxLength={64} data-key-prefix={prefix} defaultValue={suffix}
                                      placeholder={prefix ? 'SUFFIX' : 'KEY'} />
                                  </div>
                                  <input type="text" className="field ca-sub-label adm-ca-sub-input"
                                    maxLength={128} defaultValue={sub.label} placeholder="Display label" />
                                  <input type="text" className="field ca-sub-action adm-ca-sub-input"
                                    maxLength={128} defaultValue={sub.action_label || ''} placeholder="Action label" />
                                  <HandlerBadges stageKey={stage.key} statusKey={ls.defaultStatusKey}
                                    substatusId={sub.id} handlers={handlers} />
                                  {resolvedSlots.has(`sub:${sub.id}`) && (
                                    <span className="ca-resolved-pill" style={{
                                      display: 'inline-flex', alignItems: 'center',
                                      padding: '1px 8px', marginLeft: 6,
                                      background: '#d1fae5', color: '#065f46',
                                      borderRadius: 999, fontSize: '.7rem', fontWeight: 600,
                                      lineHeight: 1.5, whiteSpace: 'nowrap', verticalAlign: 'middle',
                                    }}>✓ Resolved</span>
                                  )}
                                </div>
                              );
                            })}
                            {stageNewRows.map(nr => (
                              <div key={nr.id} className="ca-sub-row adm-ca-sub-row adm-ca-sub-row--new"
                                data-sub-new="1" data-sub-ls={nr.lsKey}
                                data-orig-key="" data-orig-label="" data-orig-action="">
                                <div className="adm-ca-sub-key-wrap">
                                  {nr.prefix && (
                                    <span className="ca-sub-key-prefix adm-ca-sub-key-prefix"
                                      title="Lead-status shorthand (not editable)">{nr.prefix}</span>
                                  )}
                                  <input type="text"
                                    className={`field ca-sub-key adm-ca-sub-key${nr.prefix ? ' adm-ca-sub-key--has-prefix' : ''}`}
                                    maxLength={64} data-key-prefix={nr.prefix}
                                    placeholder={nr.prefix ? 'SUFFIX' : 'KEY'} autoFocus />
                                </div>
                                <input type="text" className="field ca-sub-label adm-ca-sub-input" maxLength={128} placeholder="Display label" />
                                <input type="text" className="field ca-sub-action adm-ca-sub-input" maxLength={128} placeholder="Action label" />
                              </div>
                            ))}
                          </div>

                          <div className="adm-ca-add-sub">
                            <button type="button" className="btn btn-ghost"
                              onClick={() => addCardActionSubstatus(ls.key)}>
                              + Add sub-status
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </Stack>
  );
}

export default CardActionsPage;
