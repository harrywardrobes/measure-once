import React, { useCallback, useEffect, useState } from 'react';
import {
  Accordion, AccordionDetails, AccordionSummary,
  Box, Card, CardContent, Chip, CircularProgress, Divider, Stack, Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useToast } from '../../contexts/ToastContext';
import { STAGE_COLORS } from '../../theme';
import { GET } from '../../utils/api';
import { usePageTitle } from '../../hooks/usePageTitle';
import type { HandlerType } from '../../components/CardActionModalsHost';
import { DEFAULT_WORKFLOW, WorkflowDef, WorkflowStage } from '../../lib/workflowConfig';
import { HandlerSlotPicker } from './HandlerSlotPicker';
import type { SlotHandler } from './HandlerSlotPicker';

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
interface Binding  { stage_key?: string; status_key?: string; }
interface Handler  { id: number; name: string; type: HandlerType; config: Record<string, unknown>; bindings: Binding[]; }

interface StatusModel {
  key: string; label: string;
  defaultStatusKey: string; isNullRow: boolean;
}
interface StageModel { key: string; label: string; statuses: StatusModel[]; }
interface BuildResult { globalNull: StatusModel; stages: StageModel[]; unassigned: StatusModel[]; }

// ── Helpers ───────────────────────────────────────────────────────────────────

const W = window as unknown as Record<string, unknown>;

function buildModel(
  statuses: LeadStatus[],
  stages: Array<{ key: string; label: string }>,
): BuildResult {
  const stageMap = new Map<string, StageModel>();
  for (const cs of stages) {
    stageMap.set(cs.key, { key: cs.key, label: cs.label, statuses: [] });
  }

  const real = statuses.filter(s => !s.is_null_row);
  const unassigned: StatusModel[] = [];

  for (const s of real) {
    const sk    = lsStageToKey(s.stage || '');
    const lsKey = String(s.key || '');
    const defKey = lsKey.toLowerCase();
    if (!sk || !stageMap.has(sk)) {
      unassigned.push({ key: lsKey, label: s.label, defaultStatusKey: defKey, isNullRow: false });
      continue;
    }
    stageMap.get(sk)!.statuses.push({ key: lsKey, label: s.label, defaultStatusKey: defKey, isNullRow: false });
  }

  const globalNull: StatusModel = {
    key: '__NULL__', label: 'No lead status',
    defaultStatusKey: '', isNullRow: true,
  };

  return { globalNull, stages: Array.from(stageMap.values()), unassigned };
}

// ── SlotRow ───────────────────────────────────────────────────────────────────

function SlotRow({
  title, subtitle, chip, stageKey, statusKey, handlers, reloadKey, onMutated,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  chip?: React.ReactNode;
  stageKey: string;
  statusKey: string;
  handlers: SlotHandler[];
  reloadKey: number;
  onMutated: () => void;
}) {
  return (
    <div className="adm-ca-block" data-testid="ca-default-row">
      <strong className="adm-ca-block-title">{title}</strong>
      {subtitle && (
        <span style={{ fontSize: '.72rem', color: 'var(--ink-4)', flexShrink: 0, whiteSpace: 'nowrap' }}>
          {subtitle}
        </span>
      )}
      {chip}
      <HandlerSlotPicker
        key={`${stageKey}-${statusKey}-${reloadKey}`}
        stageKey={stageKey}
        statusKey={statusKey}
        handlers={handlers}
        onMutated={onMutated}
      />
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CardActionsPage() {
  usePageTitle('Card Actions · Measure Once');
  useToast(); // keep context subscription alive
  const [statuses,       setStatuses]       = useState<LeadStatus[]>([]);
  const [handlers,       setHandlers]       = useState<Handler[]>([]);
  const [workflowStages, setWorkflowStages] = useState<Array<{ key: string; label: string }>>([]);
  const [loading,        setLoading]        = useState(true);
  const [reloadKey,      setReloadKey]      = useState(0);

  // ── Fetch ──────────────────────────────────────────────────────────────────

  const fetchAll = useCallback(async () => {
    try {
      const [wfl, sta, hdl] = await Promise.all([
        GET('/api/workflow'),
        GET('/api/admin/lead-statuses'),
        GET('/api/admin/card-action-handlers'),
      ]) as [WorkflowDef | null, LeadStatus[], Handler[]];
      const safeArr = <T,>(x: unknown): T[] => Array.isArray(x) ? x as T[] : [];
      const rawStages = (wfl ?? DEFAULT_WORKFLOW).stages ?? DEFAULT_WORKFLOW.stages!;
      const stages = Object.entries(rawStages).map(([key, data]) => ({
        key,
        label: (data as WorkflowStage).label ?? key,
      }));
      setWorkflowStages(stages);
      setStatuses(safeArr(sta));
      setHandlers(safeArr(hdl));
      setReloadKey(k => k + 1);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // ── BroadcastChannel sync (cross-tab) + window event sync (same-tab) ────────

  useEffect(() => {
    const onLsChanged = () => fetchAll();
    const onAhChanged = () => fetchAll();
    window.addEventListener('lead_statuses_changed', onLsChanged);
    window.addEventListener('card_action_handlers_changed', onAhChanged);

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
      window.removeEventListener('lead_statuses_changed', onLsChanged);
      window.removeEventListener('card_action_handlers_changed', onAhChanged);
      try { bc1?.close(); bc2?.close(); } catch { /* ignore */ }
    };
  }, [fetchAll]);

  // ── Window exposures ───────────────────────────────────────────────────────

  useEffect(() => {
    W.loadCardActionsAdmin = fetchAll;
    return () => { delete W.loadCardActionsAdmin; };
  }, [fetchAll]);

  // ── Render ─────────────────────────────────────────────────────────────────

  const { globalNull, stages, unassigned } = buildModel(statuses, workflowStages);
  const slotHandlers = handlers as SlotHandler[];

  return (
    <Stack spacing={2}>
      <Card variant="outlined">
        <CardContent>
          <Box sx={{ mb: 2 }}>
            <Typography variant="h6">Card action labels</Typography>
            <Typography variant="body2" color="text.secondary">
              The bottom strip on Sales &amp; Survey cards. Assign an action type to each slot —
              the action name set on the handler is what appears on the card. A stage default
              covers all statuses in that stage that have no per-status binding. Changes save
              immediately.
            </Typography>
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
                <div
                  className="adm-ca-block adm-ca-block--global-null"
                  data-ls-block={globalNull.key}
                  data-testid="ca-default-row-global"
                >
                  <strong className="adm-ca-block-title is-null">{globalNull.label}</strong>
                  <span className="adm-text-muted-xs" style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
                    no <code>hs_lead_status</code>
                  </span>
                  <HandlerSlotPicker
                    key={`__global__--${reloadKey}`}
                    stageKey="__global__"
                    statusKey=""
                    handlers={slotHandlers}
                    onMutated={fetchAll}
                  />
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
                        {/* Stage default row — fallback for any status without its own binding */}
                        <SlotRow
                          title={`${stage.label} default`}
                          chip={
                            <Chip
                              label="stage default"
                              size="small"
                              sx={{ fontSize: '0.65rem', height: 18, flexShrink: 0 }}
                            />
                          }
                          stageKey={stage.key}
                          statusKey=""
                          handlers={slotHandlers}
                          reloadKey={reloadKey}
                          onMutated={fetchAll}
                        />
                        {stage.statuses.length > 0 && <Divider />}

                        {/* Per-status rows */}
                        {stage.statuses.map(ls => (
                          <SlotRow
                            key={ls.key}
                            title={ls.label}
                            subtitle={ls.key}
                            stageKey={stage.key}
                            statusKey={ls.defaultStatusKey}
                            handlers={slotHandlers}
                            reloadKey={reloadKey}
                            onMutated={fetchAll}
                          />
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
                        <SlotRow
                          key={ls.key}
                          title={ls.label}
                          subtitle={ls.key}
                          stageKey=""
                          statusKey={ls.defaultStatusKey}
                          handlers={slotHandlers}
                          reloadKey={reloadKey}
                          onMutated={fetchAll}
                        />
                      ))}
                    </AccordionDetails>
                  </Accordion>
                )}
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </Stack>
  );
}

export default CardActionsPage;
