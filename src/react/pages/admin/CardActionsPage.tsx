import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Accordion, AccordionDetails, AccordionSummary,
  Alert, Box, Button, Card, CardContent, CircularProgress, Stack, Typography,
  Dialog, DialogTitle, DialogContent, DialogActions, List, ListItem, ListItemText,
  Tooltip,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useToast } from '../../contexts/ToastContext';
import { GLOBAL_NULL_STAGE_KEY, GLOBAL_NULL_STATUS_KEY, GLOBAL_NULL_SLOT_KEY } from './adminConstants';
import { STATUS_COLORS, STAGE_COLORS } from '../../theme';
import { GET, PUT } from '../../utils/api';
import { usePageTitle } from '../../hooks/usePageTitle';
import { HANDLER_MODAL_SUMMARY, HANDLER_TYPE_LABELS } from '../../utils/handlerMeta';
import type { HandlerType } from '../../components/CardActionModalsHost';
import { DEFAULT_WORKFLOW, WorkflowDef, WorkflowStage } from '../../lib/workflowConfig';

// ── Helpers ─────────────────────────────────────────────────────────────────

// Maps lead_status_config.stage (e.g. 'DESIGN_VISIT') → workflow key (e.g. 'designvisit').
// Mirrors the server-side _normToCardStageKey rule: lowercase + strip underscores.
function lsStageToKey(stage: string): string {
  return stage.toLowerCase().replace(/_/g, '');
}


// ── Types ─────────────────────────────────────────────────────────────────────

interface LeadStatus {
  key: string; label: string; stage: string | null;
  sort_order: number; excluded_from_sales: boolean; is_null_row: boolean;
}
interface CALabel  { stage_key: string; status_key: string; label: string; }
interface Binding  { stage_key?: string; status_key?: string; }
interface Handler  { id: number; name: string; type: HandlerType; config: Record<string, unknown>; bindings: Binding[]; }

interface StatusModel {
  key: string; label: string;
  defaultLabel: string; defaultStatusKey: string; isNullRow: boolean;
}
interface StageModel { key: string; label: string; statuses: StatusModel[]; }
interface BuildResult { globalNull: StatusModel; stages: StageModel[]; unassigned: StatusModel[]; }
// ── Helpers ───────────────────────────────────────────────────────────────────

const W = window as unknown as Record<string, unknown>;

function buildModel(
  labels: CALabel[], statuses: LeadStatus[],
  stages: Array<{ key: string; label: string }>,
): BuildResult {
  const labelByKey: Record<string, string> = {};
  for (const r of labels) labelByKey[`${r.stage_key}|${r.status_key}`] = r.label;

  const stageMap = new Map<string, StageModel>();
  for (const cs of stages) {
    stageMap.set(cs.key, { key: cs.key, label: cs.label, statuses: [] });
  }

  const real = statuses.filter(s => !s.is_null_row);

  const unassigned: StatusModel[] = [];

  for (const s of real) {
    const sk = lsStageToKey(s.stage || '');
    const lsKey  = String(s.key || '');
    const defKey = lsKey.toLowerCase();
    if (!sk || !stageMap.has(sk)) {
      unassigned.push({
        key: lsKey, label: s.label,
        defaultLabel: labelByKey[`|${defKey}`] || '',
        defaultStatusKey: defKey, isNullRow: false,
      });
      continue;
    }
    const stage  = stageMap.get(sk)!;
    stage.statuses.push({
      key: lsKey, label: s.label,
      defaultLabel: labelByKey[`${sk}|${defKey}`] || '',
      defaultStatusKey: defKey, isNullRow: false,
    });
  }

  // Single global "No lead status" row.
  // Write sentinel: stage_key='__global__', status_key=''.
  // Read: prefer '__global__' (new saves), fall back to 'sales' (legacy null-row data).
  // Runtime resolver now falls back to '__global__|' when no per-stage default row is found.
  const globalNullLabel = labelByKey[GLOBAL_NULL_SLOT_KEY] || labelByKey['sales|'] || '';
  const globalNull: StatusModel = {
    key: '__NULL__', label: 'No lead status',
    defaultLabel: globalNullLabel,
    defaultStatusKey: '', isNullRow: true,
  };

  return { globalNull, stages: Array.from(stageMap.values()), unassigned };
}

function handlersForSlot(
  handlers: Handler[],
  stageKey: string,
  statusKey: string,
): Handler[] {
  return handlers.filter(h => h.bindings?.some(b =>
    (b.stage_key  || '').toLowerCase() === (stageKey  || '').toLowerCase()
    && (b.status_key || '').toLowerCase() === (statusKey || '').toLowerCase(),
  ));
}

// ── HandlerBadges ─────────────────────────────────────────────────────────────

function HandlerBadges({
  stageKey, statusKey, handlers,
}: {
  stageKey: string; statusKey: string; handlers: Handler[];
}) {
  const matched = handlersForSlot(handlers, stageKey, statusKey);
  if (!matched.length) return null;

  const openFix = () => {
    if (typeof W.openConflictResolver !== 'function') return;
    const fn = W.openConflictResolver as (a: string | null, b: string | null, c: number | null) => void;
    fn(stageKey, statusKey, null);
  };

  return (
    <span style={{ marginLeft: 6, display: 'inline-flex', alignItems: 'center', gap: 4, verticalAlign: 'middle' }}>
      {matched.map(h => {
        const summary = HANDLER_MODAL_SUMMARY[h.type];
        const tooltipTitle = summary
          ? `${HANDLER_TYPE_LABELS[h.type] || h.type}\n${summary.steps}\n${summary.hubspot}`
          : `${HANDLER_TYPE_LABELS[h.type] || h.type} — manage in Action handlers`;
        return (
          <Tooltip key={h.id} title={<span style={{ whiteSpace: 'pre-line' }}>{tooltipTitle}</span>} arrow placement="top">
            <span className="ca-handler-badge adm-handler-badge"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                padding: '1px 7px', background: STATUS_COLORS.violet.bg, color: STATUS_COLORS.violet.text,
                borderRadius: 999, fontSize: '.7rem', fontWeight: 600, cursor: 'default',
              }}>
              <span aria-hidden="true">⚡</span>
              <span>{String(h.config?.action_name || HANDLER_TYPE_LABELS[h.type] || h.type)}</span>
            </span>
          </Tooltip>
        );
      })}
      {matched.length > 1 && (
        <button type="button" className="ca-fix-conflict-btn"
          title="Multiple handlers bound to this slot — click to resolve"
          onClick={openFix}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            padding: '1px 8px', marginLeft: 4, background: STATUS_COLORS.warning.bg,
            color: STATUS_COLORS.warning.text, border: `1px solid ${STATUS_COLORS.warning.border}`,
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
  usePageTitle('Card Actions · Measure Once');
  const showToast = useToast();
  const [labels,         setLabels]         = useState<CALabel[]>([]);
  const [statuses,       setStatuses]       = useState<LeadStatus[]>([]);
  const [handlers,       setHandlers]       = useState<Handler[]>([]);
  const [workflowStages, setWorkflowStages] = useState<Array<{ key: string; label: string }>>([]);
  const [loading,       setLoading]       = useState(true);
  const [reloadKey,     setReloadKey]     = useState(0);
  const [resolvedSlots, setResolvedSlots] = useState<Set<string>>(new Set());

  const statusesRef    = useRef<LeadStatus[]>([]);
  type ClearSlot = { stageKey: string; statusKey: string; label: string; boundHandlers: Handler[] };
  const [clearConfirm, setClearConfirm] = useState<{
    slots: ClearSlot[];
    resolve: (confirmed: boolean) => void;
  } | null>(null);

  const confirmClear = useCallback((slots: ClearSlot[]): Promise<boolean> => {
    return new Promise(resolve => setClearConfirm({ slots, resolve }));
  }, []);

  // ── Fetch ──────────────────────────────────────────────────────────────────

  const fetchAll = useCallback(async () => {
    try {
      const [wfl, lbl, sta, hdl] = await Promise.all([
        GET('/api/workflow'),
        GET('/api/admin/stage-action-labels'),
        GET('/api/admin/lead-statuses'),
        GET('/api/admin/card-action-handlers'),
      ]) as [WorkflowDef | null, CALabel[], LeadStatus[], Handler[]];
      const safeArr = <T,>(x: unknown): T[] => Array.isArray(x) ? x as T[] : [];
      const rawStages = (wfl ?? DEFAULT_WORKFLOW).stages ?? DEFAULT_WORKFLOW.stages!;
      const stages = Object.entries(rawStages).map(([key, data]) => ({
        key,
        label: (data as WorkflowStage).label ?? key,
      }));
      setWorkflowStages(stages);
      setLabels(safeArr(lbl));
      setStatuses(safeArr(sta));
      setHandlers(safeArr(hdl));
      statusesRef.current = safeArr(sta);
      setReloadKey(k => k + 1);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // ── BroadcastChannel sync (cross-tab) + window event sync (same-tab) ────────

  useEffect(() => {
    const onWinLsChanged = () => fetchAll();
    const onWinAhChanged = () => fetchAll();
    window.addEventListener('lead_statuses_changed', onWinLsChanged);
    window.addEventListener('card_action_handlers_changed', onWinAhChanged);

    let bc1: BroadcastChannel | undefined;
    let bc2: BroadcastChannel | undefined;
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        bc1 = new BroadcastChannel('lead_statuses_changed');
        bc1.onmessage = () => fetchAll();
        bc2 = new BroadcastChannel('card_action_handlers_changed');
        bc2.onmessage = () => fetchAll();
      } catch { /* ignore */ }
    }
    return () => {
      window.removeEventListener('lead_statuses_changed', onWinLsChanged);
      window.removeEventListener('card_action_handlers_changed', onWinAhChanged);
      try { bc1?.close(); bc2?.close(); } catch { /* ignore */ }
    };
  }, [fetchAll]);

  // ── Window exposures ───────────────────────────────────────────────────────

  const saveAllCardActionLabels = useCallback(async () => {
    let saved = 0, failed = 0;
    const failures: string[] = [];

    // Before saving, check if any default-label inputs are being cleared while
    // they still have a handler bound. Warn the admin and let them cancel.
    const clearingWithHandlers: ClearSlot[] = [];
    for (const input of Array.from(
      document.querySelectorAll<HTMLInputElement>('#card-actions-table-wrap .ca-default-input')
    )) {
      const value    = input.value.trim();
      const original = input.dataset.original || '';
      if (!value && original) {
        const stageKey  = input.dataset.stage  || '';
        const statusKey = input.dataset.status || '';
        const bound = handlersForSlot(handlers, stageKey, statusKey);
        if (bound.length) {
          clearingWithHandlers.push({ stageKey, statusKey, label: original, boundHandlers: bound });
        }
      }
    }
    if (clearingWithHandlers.length) {
      const confirmed = await confirmClear(clearingWithHandlers);
      setClearConfirm(null);
      if (!confirmed) return;
    }

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


    if (saved === 0 && failed === 0) { showToast('No changes to save.'); return; }
    if (failed) showToast(`Saved ${saved}, failed ${failed}.`, true);
    else {
        showToast(`${saved} change${saved !== 1 ? 's' : ''} saved.`);
    }
    try { new BroadcastChannel('stage_action_labels_changed').postMessage({ ts: Date.now() }); } catch { /* ignore */ }
    fetchAll();
  }, [fetchAll, showToast, handlers, confirmClear]);

  useEffect(() => {
    W.loadCardActionsAdmin    = fetchAll;
    W.saveAllCardActionLabels = saveAllCardActionLabels;
    return () => {
      delete W.loadCardActionsAdmin;
      delete W.saveAllCardActionLabels;
    };
  }, [fetchAll, saveAllCardActionLabels]);

  useEffect(() => {
    W.flashResolvedSlot = (stageKey: string, statusKey: string) => {
      const k = `ls:${stageKey}:${statusKey}`;
      setResolvedSlots(prev => new Set([...prev, k]));
      setTimeout(() => setResolvedSlots(prev => { const n = new Set(prev); n.delete(k); return n; }), 1900);
    };
    return () => { delete W.flashResolvedSlot; };
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────

  const { globalNull, stages, unassigned } = buildModel(labels, statuses, workflowStages);

  return (
    <Stack spacing={2}>
      <Card variant="outlined">
        <CardContent>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, mb: 2 }}>
            <Box>
              <Typography variant="h6">Card action labels</Typography>
              <Typography variant="body2" color="text.secondary">
                The bottom strip on Sales &amp; Survey cards. A single global row covers contacts
                with no lead status, followed by per-stage rows for each configured lead status.
                Rows mirror the Lead Statuses table order and refresh automatically when renamed.
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
            ) : (
              <>
                {/* ── Global "No lead status" block ──────────────────────── */}
                <div className="adm-ca-block adm-ca-block--global-null" data-ls-block={globalNull.key} data-testid="ca-default-row-global" key={`${GLOBAL_NULL_STAGE_KEY}-${reloadKey}`}>
                  <strong className="adm-ca-block-title is-null">{globalNull.label}</strong>
                  <span className="adm-text-muted-xs" style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
                    no <code>hs_lead_status</code>
                  </span>
                  <input type="text" className="field ca-default-input adm-ca-default-input"
                    maxLength={128}
                    data-kind="ls-default"
                    data-stage={GLOBAL_NULL_STAGE_KEY}
                    data-status={GLOBAL_NULL_STATUS_KEY}
                    data-original={globalNull.defaultLabel}
                    defaultValue={globalNull.defaultLabel}
                    placeholder="(Action label)"
                    onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                  />
                  <HandlerBadges stageKey={GLOBAL_NULL_STAGE_KEY} statusKey={GLOBAL_NULL_STATUS_KEY} handlers={handlers} />
                  {resolvedSlots.has(`ls:${GLOBAL_NULL_STAGE_KEY}:${GLOBAL_NULL_STATUS_KEY}`) && (
                    <span className="ca-resolved-pill" style={{
                      display: 'inline-flex', alignItems: 'center',
                      padding: '1px 8px', marginLeft: 6,
                      background: STATUS_COLORS.successDeep.bg, color: STATUS_COLORS.successDeep.text,
                      borderRadius: 999, fontSize: '.7rem', fontWeight: 600,
                      lineHeight: 1.5, whiteSpace: 'nowrap', verticalAlign: 'middle',
                    }}>✓ Resolved</span>
                  )}
                </div>

                {/* ── Per-stage accordion sections ────────────────────────── */}
                {!stages.length ? (
                  <p className="admin-msg admin-msg--muted">No card action stages configured.</p>
                ) : stages.map(stage => {
                  const colors = STAGE_COLORS[stage.key];
                  const borderColor = colors?.bg ?? '#8B2BFF';
                  const count = stage.statuses.length;
                  return (
                    <Accordion
                      key={stage.key}
                      defaultExpanded={false}
                      disableGutters
                      variant="outlined"
                      sx={{
                        borderLeft: `4px solid ${borderColor}`,
                        borderRadius: 1,
                        mb: 1,
                        '&:before': { display: 'none' },
                      }}
                    >
                      <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: 44, px: 1.5 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                          <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: borderColor, flexShrink: 0 }} />
                          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{stage.label}</Typography>
                          <Typography variant="caption" color="text.secondary">{count} status{count !== 1 ? 'es' : ''}</Typography>
                        </Box>
                      </AccordionSummary>
                      <AccordionDetails sx={{ p: 0 }}>
                        {stage.statuses.length === 0 ? (
                          <div className="adm-ca-empty"><em>No lead statuses configured for this stage yet.</em></div>
                        ) : stage.statuses.map(ls => (
                          <div key={`${ls.key}-${reloadKey}`} className="adm-ca-block" data-ls-block={ls.key} data-testid="ca-default-row">
                            <strong className="adm-ca-block-title">{ls.label}</strong>
                            <span style={{ fontSize: '.72rem', color: 'var(--ink-4)', flexShrink: 0, whiteSpace: 'nowrap' }}>{ls.key}</span>
                            <input type="text" className="field ca-default-input adm-ca-default-input"
                              maxLength={128}
                              data-kind="ls-default"
                              data-stage={stage.key}
                              data-status={ls.defaultStatusKey}
                              data-original={ls.defaultLabel}
                              defaultValue={ls.defaultLabel}
                              placeholder="(Action label)"
                              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                            />
                            <HandlerBadges stageKey={stage.key} statusKey={ls.defaultStatusKey} handlers={handlers} />
                            {resolvedSlots.has(`ls:${stage.key}:${ls.defaultStatusKey}`) && (
                              <span className="ca-resolved-pill" style={{
                                display: 'inline-flex', alignItems: 'center',
                                padding: '1px 8px', marginLeft: 6,
                                background: STATUS_COLORS.successDeep.bg, color: STATUS_COLORS.successDeep.text,
                                borderRadius: 999, fontSize: '.7rem', fontWeight: 600,
                                lineHeight: 1.5, whiteSpace: 'nowrap', verticalAlign: 'middle',
                              }}>✓ Resolved</span>
                            )}
                          </div>
                        ))}
                      </AccordionDetails>
                    </Accordion>
                  );
                })}

                {/* ── Unassigned (no stage) accordion ─────────────────── */}
                {unassigned.length > 0 && (
                  <Accordion
                    defaultExpanded={false}
                    disableGutters
                    variant="outlined"
                    sx={{
                      borderLeft: '4px solid var(--neutral-300)',
                      borderRadius: 1,
                      mb: 1,
                      '&:before': { display: 'none' },
                    }}
                  >
                    <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: 44, px: 1.5 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                        <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: 'var(--neutral-300)', flexShrink: 0 }} />
                        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>No stage assigned</Typography>
                        <Typography variant="caption" color="text.secondary">{unassigned.length} status{unassigned.length !== 1 ? 'es' : ''}</Typography>
                      </Box>
                    </AccordionSummary>
                    <AccordionDetails sx={{ p: 0 }}>
                      {unassigned.map(ls => (
                        <div key={`unassigned-${ls.key}-${reloadKey}`} className="adm-ca-block" data-ls-block={ls.key} data-testid="ca-default-row">
                          <strong className="adm-ca-block-title">{ls.label}</strong>
                          <span style={{ fontSize: '.72rem', color: 'var(--ink-4)', flexShrink: 0, whiteSpace: 'nowrap' }}>{ls.key}</span>
                          <input type="text" className="field ca-default-input adm-ca-default-input"
                            maxLength={128}
                            data-kind="ls-default"
                            data-stage=""
                            data-status={ls.defaultStatusKey}
                            data-original={ls.defaultLabel}
                            defaultValue={ls.defaultLabel}
                            placeholder="(Action label)"
                            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                          />
                          <HandlerBadges stageKey="" statusKey={ls.defaultStatusKey} handlers={handlers} />
                          {resolvedSlots.has(`ls::${ls.defaultStatusKey}`) && (
                            <span className="ca-resolved-pill" style={{
                              display: 'inline-flex', alignItems: 'center',
                              padding: '1px 8px', marginLeft: 6,
                              background: STATUS_COLORS.successDeep.bg, color: STATUS_COLORS.successDeep.text,
                              borderRadius: 999, fontSize: '.7rem', fontWeight: 600,
                              lineHeight: 1.5, whiteSpace: 'nowrap', verticalAlign: 'middle',
                            }}>✓ Resolved</span>
                          )}
                        </div>
                      ))}
                    </AccordionDetails>
                  </Accordion>
                )}
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {clearConfirm && (
        <Dialog
          open
          onClose={() => { clearConfirm.resolve(false); setClearConfirm(null); }}
          maxWidth="sm"
          fullWidth
        >
          <DialogTitle data-testid="bound-handler-warning-title">Handler still bound to this label</DialogTitle>
          <DialogContent>
            <Alert severity="warning" sx={{ mb: 2 }}>
              {clearConfirm.slots.length === 1
                ? 'The label you\'re clearing has a handler bound to it.'
                : `${clearConfirm.slots.length} labels you're clearing have handlers bound to them.`}
              {' '}If you proceed, the handler will still exist but won't appear on any card — it will show as an unlabelled binding in the Action handlers tab.
            </Alert>
            <List dense disablePadding>
              {clearConfirm.slots.map(s => (
                <ListItem key={`${s.stageKey}:${s.statusKey}`} disableGutters>
                  <ListItemText
                    primary={`"${s.label}" — ${s.stageKey} / ${s.statusKey || 'stage default'}`}
                    secondary={`Bound handler${s.boundHandlers.length > 1 ? 's' : ''}: ${s.boundHandlers.map(h => h.name || h.type).join(', ')}`}
                  />
                </ListItem>
              ))}
            </List>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
              To avoid orphaning the handler, cancel and remove its binding first in the <strong>Action handlers</strong> tab.
            </Typography>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => { clearConfirm.resolve(false); setClearConfirm(null); }}>
              Cancel
            </Button>
            <Button
              color="warning"
              variant="contained"
              onClick={() => { clearConfirm.resolve(true); setClearConfirm(null); }}
            >
              Clear label anyway
            </Button>
          </DialogActions>
        </Dialog>
      )}

    </Stack>
  );
}

export default CardActionsPage;
