import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import BoltIcon from '@mui/icons-material/Bolt';
import EmailIcon from '@mui/icons-material/Email';
import RefreshIcon from '@mui/icons-material/Refresh';
import { GET } from '../../utils/api';
import { usePageTitle } from '../../hooks/usePageTitle';
import { HANDLER_MODAL_SUMMARY, HANDLER_EMAIL_TEMPLATES, HANDLER_TYPE_LABELS } from '../../utils/handlerMeta';
import { DEFAULT_WORKFLOW, WorkflowDef, WorkflowStage } from '../../lib/workflowConfig';

// ── Types ─────────────────────────────────────────────────────────────────────

interface LeadStatus {
  key: string; label: string; stage: string | null; shorthand: string;
  sort_order: number; excluded_from_sales: boolean; is_null_row: boolean;
}
interface Substatus {
  id: number; status_key: string; substatus_key: string;
  label: string; action_label: string; sort_order: number;
}
interface CALabel { stage_key: string; status_key: string; label: string; }
interface Binding { stage_key?: string; status_key?: string; substatus_id?: number | null; }
interface Handler {
  id: number; name: string; type: string;
  config: Record<string, unknown>; bindings: Binding[];
}
interface EmailTemplate { key: string; label: string; }

// ── Helpers ───────────────────────────────────────────────────────────────────

function lsStageToKey(stage: string): string {
  return stage.toLowerCase().replace(/_/g, '');
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

function handlerDisplayName(h: Handler): string {
  return String(h.config?.action_name || HANDLER_TYPE_LABELS[h.type] || h.name || h.type);
}

function navigateToTab(tabId: string) {
  if (typeof (window as unknown as Record<string, unknown>).adminSwitchToTab === 'function') {
    ((window as unknown as Record<string, unknown>).adminSwitchToTab as (id: string) => void)(tabId);
  } else {
    try {
      localStorage.setItem('adminActiveGroup', 'configuration');
      localStorage.setItem('adminActiveTab', tabId);
    } catch { /* ignore */ }
    location.href = '/admin';
  }
}

// ── HandlerRow ────────────────────────────────────────────────────────────────

function HandlerRow({
  handler,
  buttonLabel,
  emailTemplates,
}: {
  handler: Handler;
  buttonLabel?: string;
  emailTemplates: EmailTemplate[];
}) {
  const displayName = handlerDisplayName(handler);
  const summary = HANDLER_MODAL_SUMMARY[handler.type];

  const hubspotText = handler.type === 'start_design_visit' && handler.config?.submittedLeadStatus
    ? `Sets lead status to in-progress on open; to ${handler.config.submittedLeadStatus} on submit`
    : summary?.hubspot ?? '';

  const templateKeys = HANDLER_EMAIL_TEMPLATES[handler.type] ?? [];
  const templateItems = templateKeys
    .map(k => emailTemplates.find(t => t.key === k))
    .filter((t): t is EmailTemplate => t !== undefined);

  return (
    <Box sx={{ pl: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0.75, mb: 0.5 }}>
        <Tooltip title={`Handler type: ${handler.type}`} arrow>
          <Chip
            icon={<BoltIcon sx={{ fontSize: 13 }} />}
            label={displayName}
            size="small"
            clickable
            onClick={() => navigateToTab('actionhandlers')}
            sx={{
              fontWeight: 600,
              bgcolor: 'rgba(124,58,237,0.1)',
              color: 'rgb(109,40,217)',
              '&:hover': { bgcolor: 'rgba(124,58,237,0.2)' },
              '.MuiChip-icon': { color: 'rgb(109,40,217) !important' },
            }}
          />
        </Tooltip>
        {buttonLabel && (
          <Typography variant="caption" color="text.secondary">
            Button: <strong>{buttonLabel}</strong>
          </Typography>
        )}
      </Box>
      {summary && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.25 }}>
          {summary.steps}
        </Typography>
      )}
      {hubspotText && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.25, fontStyle: 'italic' }}>
          HubSpot: {hubspotText}
        </Typography>
      )}
      {templateItems.length > 0 && (
        <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
          <Typography variant="caption" color="text.secondary" sx={{ mr: 0.25 }}>Emails:</Typography>
          {templateItems.map(t => (
            <Chip
              key={t.key}
              icon={<EmailIcon sx={{ fontSize: 12 }} />}
              label={t.label}
              size="small"
              clickable
              onClick={() => navigateToTab('emailtemplates')}
              sx={{
                fontSize: '0.68rem',
                height: 20,
                bgcolor: 'rgba(16,185,129,0.08)',
                color: 'rgb(5,150,105)',
                '&:hover': { bgcolor: 'rgba(16,185,129,0.15)' },
                '.MuiChip-icon': { color: 'rgb(5,150,105) !important', fontSize: '11px !important' },
                '.MuiChip-label': { px: 0.75 },
              }}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}

// ── NoHandler ─────────────────────────────────────────────────────────────────

function NoHandlerNote() {
  return (
    <Typography variant="caption" color="text.secondary" sx={{ fontStyle: 'italic' }}>
      No handler bound
    </Typography>
  );
}

// ── SlotRow ───────────────────────────────────────────────────────────────────

function SlotRow({
  label,
  rowKind,
  handlers,
  buttonLabel,
  emailTemplates,
}: {
  label: string;
  rowKind: 'status' | 'substatus';
  handlers: Handler[];
  buttonLabel?: string;
  emailTemplates: EmailTemplate[];
}) {
  const isFirst = handlers.length > 0;
  return (
    <Box
      sx={{
        py: 1,
        pl: rowKind === 'substatus' ? 3 : 0,
        pr: 1,
        borderBottom: '1px solid',
        borderColor: 'divider',
        '&:last-child': { borderBottom: 'none' },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, mb: isFirst ? 0.75 : 0 }}>
        <Typography
          variant="body2"
          sx={{
            fontWeight: rowKind === 'status' ? 600 : 400,
            fontSize: rowKind === 'substatus' ? '0.8125rem' : '0.875rem',
            color: rowKind === 'substatus' ? 'text.secondary' : 'text.primary',
            minWidth: 120,
            pt: 0.15,
          }}
        >
          {label}
        </Typography>
      </Box>
      {handlers.length === 0 ? (
        <Box sx={{ pl: rowKind === 'substatus' ? 0 : 0 }}>
          <NoHandlerNote />
        </Box>
      ) : (
        <Stack spacing={1}>
          {handlers.map(h => (
            <HandlerRow
              key={h.id}
              handler={h}
              buttonLabel={buttonLabel}
              emailTemplates={emailTemplates}
            />
          ))}
        </Stack>
      )}
    </Box>
  );
}

// ── StageAccordion ────────────────────────────────────────────────────────────

function StageAccordion({
  stageKey,
  stageLabel,
  statuses,
  substatuses,
  labels,
  handlers,
  emailTemplates,
}: {
  stageKey: string;
  stageLabel: string;
  statuses: LeadStatus[];
  substatuses: Substatus[];
  labels: CALabel[];
  handlers: Handler[];
  emailTemplates: EmailTemplate[];
}) {
  const stageStatuses = statuses
    .filter(s => lsStageToKey(s.stage || '') === stageKey)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  const labelMap = new Map<string, string>();
  for (const l of labels) {
    if (l.stage_key === stageKey) {
      labelMap.set(l.status_key, l.label);
    }
  }

  const subsByLs = new Map<string, Substatus[]>();
  for (const s of substatuses) {
    const k = String(s.status_key).toUpperCase();
    const list = subsByLs.get(k) ?? [];
    list.push(s);
    subsByLs.set(k, list);
  }

  const hasAnyHandler = stageStatuses.some(ls => {
    const lsKey = String(ls.key || '').toLowerCase();
    if (handlersForSlot(handlers, stageKey, lsKey).length > 0) return true;
    const subs = (subsByLs.get(ls.key.toUpperCase()) ?? []);
    return subs.some(s => handlersForSlot(handlers, stageKey, lsKey, s.id).length > 0);
  });

  return (
    <Accordion defaultExpanded={false} disableGutters variant="outlined" sx={{ '&:not(:last-child)': { borderBottom: 0 } }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, width: '100%' }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{stageLabel}</Typography>
          {!hasAnyHandler && (
            <Typography variant="caption" color="text.secondary" sx={{ fontStyle: 'italic' }}>
              No action handlers configured
            </Typography>
          )}
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ p: 0 }}>
        {stageStatuses.length === 0 ? (
          <Box sx={{ px: 2, py: 1.5 }}>
            <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
              No lead statuses configured for this stage.
            </Typography>
          </Box>
        ) : (
          stageStatuses.map(ls => {
            const lsKey = String(ls.key || '').toLowerCase();
            const statusHandlers = handlersForSlot(handlers, stageKey, lsKey);
            const buttonLabel = labelMap.get(lsKey) || labelMap.get(ls.key.toLowerCase()) || undefined;
            const subs = (subsByLs.get(ls.key.toUpperCase()) ?? [])
              .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

            return (
              <Accordion
                key={ls.key}
                defaultExpanded={false}
                disableGutters
                variant="outlined"
                sx={{
                  borderRadius: '0 !important',
                  borderLeft: 'none',
                  borderRight: 'none',
                  '&:not(:last-child)': { borderBottom: 0 },
                  '&:before': { display: 'none' },
                }}
              >
                <AccordionSummary
                  expandIcon={<ExpandMoreIcon sx={{ fontSize: 18 }} />}
                  sx={{ minHeight: 44, pl: 2, '& .MuiAccordionSummary-content': { my: 0.5 } }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, width: '100%', pr: 1 }}>
                    <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 160 }}>
                      {ls.label}
                      {ls.is_null_row && (
                        <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.75 }}>
                          (stage default)
                        </Typography>
                      )}
                    </Typography>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
                      {statusHandlers.length > 0 ? (
                        statusHandlers.map(h => (
                          <Chip
                            key={h.id}
                            icon={<BoltIcon sx={{ fontSize: 12 }} />}
                            label={handlerDisplayName(h)}
                            size="small"
                            sx={{
                              height: 20,
                              fontSize: '0.7rem',
                              fontWeight: 600,
                              bgcolor: 'rgba(124,58,237,0.1)',
                              color: 'rgb(109,40,217)',
                              '.MuiChip-icon': { color: 'rgb(109,40,217) !important', fontSize: '11px !important' },
                              '.MuiChip-label': { px: 0.75 },
                            }}
                          />
                        ))
                      ) : (
                        <Typography variant="caption" color="text.secondary" sx={{ fontStyle: 'italic' }}>
                          No handler bound
                        </Typography>
                      )}
                    </Box>
                  </Box>
                </AccordionSummary>
                <AccordionDetails sx={{ px: 2, pt: 0, pb: 1 }}>
                  <Box sx={{ borderTop: '1px solid', borderColor: 'divider', pt: 1.5, mb: subs.length > 0 ? 1.5 : 0 }}>
                    {statusHandlers.length > 0 ? (
                      <Stack spacing={1.5}>
                        {statusHandlers.map(h => (
                          <HandlerRow
                            key={h.id}
                            handler={h}
                            buttonLabel={buttonLabel}
                            emailTemplates={emailTemplates}
                          />
                        ))}
                      </Stack>
                    ) : (
                      <NoHandlerNote />
                    )}
                  </Box>

                  {subs.length > 0 && (
                    <Box sx={{ mt: 1 }}>
                      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', mb: 0.75 }}>
                        Sub-statuses
                      </Typography>
                      <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
                        {subs.map(sub => {
                          const subHandlers = handlersForSlot(handlers, stageKey, lsKey, sub.id);
                          const subButtonLabel = sub.action_label || undefined;
                          return (
                            <Accordion
                              key={sub.id}
                              defaultExpanded={false}
                              disableGutters
                              variant="outlined"
                              sx={{
                                borderRadius: '0 !important',
                                borderLeft: 'none',
                                borderRight: 'none',
                                borderTop: 'none',
                                '&:first-of-type': { borderTop: 'none' },
                                '&:not(:last-child)': { borderBottom: '1px solid', borderBottomColor: 'divider' },
                                '&:last-child': { borderBottom: 'none' },
                                '&:before': { display: 'none' },
                                bgcolor: 'background.default',
                              }}
                            >
                              <AccordionSummary
                                expandIcon={<ExpandMoreIcon sx={{ fontSize: 16 }} />}
                                sx={{ minHeight: 36, pl: 1.5, '& .MuiAccordionSummary-content': { my: 0.5 } }}
                              >
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, width: '100%', pr: 1 }}>
                                  <Typography variant="caption" sx={{ fontWeight: 600, minWidth: 120 }}>
                                    {sub.label}
                                  </Typography>
                                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
                                    {subHandlers.length > 0 ? (
                                      subHandlers.map(h => (
                                        <Chip
                                          key={h.id}
                                          icon={<BoltIcon sx={{ fontSize: 10 }} />}
                                          label={handlerDisplayName(h)}
                                          size="small"
                                          sx={{
                                            height: 18,
                                            fontSize: '0.68rem',
                                            fontWeight: 600,
                                            bgcolor: 'rgba(124,58,237,0.1)',
                                            color: 'rgb(109,40,217)',
                                            '.MuiChip-icon': { color: 'rgb(109,40,217) !important', fontSize: '10px !important' },
                                            '.MuiChip-label': { px: 0.5 },
                                          }}
                                        />
                                      ))
                                    ) : (
                                      <Typography variant="caption" color="text.secondary" sx={{ fontStyle: 'italic' }}>
                                        No handler bound
                                      </Typography>
                                    )}
                                  </Box>
                                </Box>
                              </AccordionSummary>
                              <AccordionDetails sx={{ px: 1.5, pt: 0.5, pb: 1.5 }}>
                                {subHandlers.length > 0 ? (
                                  <Stack spacing={1}>
                                    {subHandlers.map(h => (
                                      <HandlerRow
                                        key={h.id}
                                        handler={h}
                                        buttonLabel={subButtonLabel}
                                        emailTemplates={emailTemplates}
                                      />
                                    ))}
                                  </Stack>
                                ) : (
                                  <NoHandlerNote />
                                )}
                              </AccordionDetails>
                            </Accordion>
                          );
                        })}
                      </Box>
                    </Box>
                  )}
                </AccordionDetails>
              </Accordion>
            );
          })
        )}
      </AccordionDetails>
    </Accordion>
  );
}

// ── WorkflowPage ──────────────────────────────────────────────────────────────

export function WorkflowPage() {
  usePageTitle('Workflow · Measure Once');

  const [labels,         setLabels]         = useState<CALabel[]>([]);
  const [statuses,       setStatuses]       = useState<LeadStatus[]>([]);
  const [substatuses,    setSubstatuses]    = useState<Substatus[]>([]);
  const [handlers,       setHandlers]       = useState<Handler[]>([]);
  const [emailTemplates, setEmailTemplates] = useState<EmailTemplate[]>([]);
  const [workflowStages, setWorkflowStages] = useState<Array<{ key: string; label: string }>>([]);
  const [loading,        setLoading]        = useState(true);
  const [refreshing,     setRefreshing]     = useState(false);
  const [lastRefreshed,  setLastRefreshed]  = useState<Date | null>(null);
  const [error,          setError]          = useState<string | null>(null);

  const isFirstLoad = useRef(true);

  const fetchAll = useCallback(async (showRefreshing = false) => {
    if (isFirstLoad.current) {
      setLoading(true);
    } else if (showRefreshing) {
      setRefreshing(true);
    }
    setError(null);
    try {
      const [lbl, sta, sub, hdl, tpl, wf] = await Promise.all([
        GET<CALabel[]>('/api/admin/stage-action-labels'),
        GET<LeadStatus[]>('/api/admin/lead-statuses'),
        GET<Substatus[]>('/api/admin/lead-substatuses'),
        GET<Handler[]>('/api/admin/card-action-handlers'),
        GET<EmailTemplate[]>('/api/admin/email-templates'),
        GET<WorkflowDef | null>('/api/workflow'),
      ]);
      const safeArr = <T,>(x: unknown): T[] => Array.isArray(x) ? x as T[] : [];
      setLabels(safeArr(lbl));
      setStatuses(safeArr(sta));
      setSubstatuses(safeArr(sub));
      setHandlers(safeArr(hdl));
      setEmailTemplates(safeArr(tpl));

      const wfDef: WorkflowDef = (wf && typeof wf === 'object' && wf.stages) ? wf : DEFAULT_WORKFLOW;
      const stages = Object.entries(wfDef.stages ?? {}).map(([key, val]: [string, WorkflowStage]) => ({
        key,
        label: val.label ?? key,
      }));
      setWorkflowStages(stages);
      setLastRefreshed(new Date());
    } catch (e) {
      setError((e as Error).message || 'Failed to load workflow data.');
    } finally {
      setLoading(false);
      setRefreshing(false);
      isFirstLoad.current = false;
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Re-fetch when the workflow tab becomes active
  useEffect(() => {
    const tabBtn = document.querySelector('.tab-btn[data-tab="workflow"]');
    if (!tabBtn) return;
    const observer = new MutationObserver(() => {
      if (tabBtn.classList.contains('active')) {
        fetchAll();
      }
    });
    observer.observe(tabBtn, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [fetchAll]);

  // Re-fetch when sibling tabs save changes
  useEffect(() => {
    const EVENTS = ['lead_statuses_changed', 'card_action_handlers_changed'] as const;
    const handler = () => fetchAll();

    for (const evt of EVENTS) {
      window.addEventListener(evt, handler);
    }

    let channels: BroadcastChannel[] = [];
    try {
      channels = EVENTS.map(evt => {
        const bc = new BroadcastChannel(evt);
        bc.addEventListener('message', handler);
        return bc;
      });
    } catch { /* BroadcastChannel not available */ }

    return () => {
      for (const evt of EVENTS) {
        window.removeEventListener(evt, handler);
      }
      for (const bc of channels) {
        bc.close();
      }
    };
  }, [fetchAll]);

  const formattedTime = lastRefreshed
    ? lastRefreshed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null;

  return (
    <Stack spacing={2} sx={{ py: 1 }}>
      <Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 0.5 }}>
          <Typography variant="h6" sx={{ flexGrow: 1 }}>Workflow</Typography>
          {!isFirstLoad.current && formattedTime && (
            <Typography variant="caption" color="text.secondary">
              Updated {formattedTime}
            </Typography>
          )}
          <Button
            size="small"
            variant="outlined"
            startIcon={refreshing ? <CircularProgress size={14} color="inherit" /> : <RefreshIcon />}
            disabled={refreshing || loading}
            onClick={() => fetchAll(true)}
            data-testid="wf-refresh"
          >
            Refresh
          </Button>
        </Box>
        <Alert severity="info" sx={{ mb: 2 }}>
          Read-only reference showing each stage's card-action bindings — which handler fires, what steps it runs, what HubSpot status changes, and which emails are sent.
        </Alert>
      </Box>

      {loading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      )}

      {error && !loading && (
        <Alert severity="error">{error}</Alert>
      )}

      {!loading && !error && (
        <Box>
          <Divider sx={{ mb: 2 }} />
          {workflowStages.length === 0 ? (
            <Alert severity="warning" sx={{ mb: 2 }}>
              No stages configured. Add stages in the <strong>Stages</strong> tab to set up your workflow.
            </Alert>
          ) : (
            <Stack spacing={0}>
              {workflowStages.map(stage => (
                <StageAccordion
                  key={stage.key}
                  stageKey={stage.key}
                  stageLabel={stage.label}
                  statuses={statuses}
                  substatuses={substatuses}
                  labels={labels}
                  handlers={handlers}
                  emailTemplates={emailTemplates}
                />
              ))}
            </Stack>
          )}
          <Stack direction="row" spacing={1.5} sx={{ mt: 2.5 }}>
            <Button
              size="small"
              variant="text"
              data-testid="wf-go-action-handlers"
              onClick={() => navigateToTab('actionhandlers')}
            >
              Go to Action handlers →
            </Button>
            <Button
              size="small"
              variant="text"
              data-testid="wf-go-stages"
              onClick={() => navigateToTab('stages')}
            >
              Go to Stages →
            </Button>
          </Stack>
        </Box>
      )}
    </Stack>
  );
}

export default WorkflowPage;
