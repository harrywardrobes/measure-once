import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  Popover,
  Snackbar,
  Typography,
} from '@mui/material';
import FilterListIcon from '@mui/icons-material/FilterList';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { STAGE_COLORS } from '../theme';
import { usePrivilege } from '../hooks/usePrivilege';
import { useCardActionHandlers, CardActionHandlerData } from '../hooks/useCardActionHandlers';
import { usePaginatedContacts, PaginatedContact, PAGINATED_CONTACTS_PAGE_LIMIT } from '../hooks/usePaginatedContacts';
import { LeadStatusPicker } from '../components/pickers/LeadStatusPicker';
import { SubstagePicker } from '../components/pickers/SubstagePicker';
import { ContactsPagination } from '../components/ContactsPagination';

// ── Types ──────────────────────────────────────────────────────────────────────

interface Contact {
  id: string;
  properties?: {
    firstname?: string;
    lastname?: string;
    email?: string;
    zip?: string;
    hs_lead_status?: string;
    hw_lead_substatus?: string;
    customer_number?: string;
    createdate?: string;
    lastmodifieddate?: string;
  };
}

interface Room {
  roomStatus?: string;
  stageKey?: string;
  statusId?: string;
  sourceId?: string;
  substateDates?: Record<string, string>;
  stageDates?: Record<string, string>;
}

interface RoomWithIdx extends Room {
  roomIdx: number;
}

interface LeadStatusOption {
  value: string;
  label: string;
  stage?: string;
}

interface LeadSubstatus {
  id: number;
  status_key: string;
  substatus_key: string;
  label?: string;
}

interface WorkflowStage {
  label?: string;
  statuses?: Array<{ id: string; label: string }>;
}

interface WorkflowDef {
  stages?: Record<string, WorkflowStage>;
}

interface StateGlobal {
  filteredContacts?: Contact[];
  contactStageCache?: Record<string, Room[]>;
  workflow?: WorkflowDef;
}

interface WindowGlobals {
  state?: StateGlobal;
  LEAD_STATUS_OPTIONS?: LeadStatusOption[];
  LEAD_SUBSTATUSES?: LeadSubstatus[];
  loadWorkflow?: () => Promise<void>;
  loadLeadStatuses?: () => Promise<void>;
  __surveyBoardBootstrapFailed?: { code: string | undefined; message: string } | undefined;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const SURVEY_STAGE_KEY = 'survey';

const PIPELINE_ALL_STAGES = ['sales', 'designvisit', 'survey'] as const;

const SURVEY_TERMINAL_SUBSTAGES = new Set([
  'unqualified',
  'not_suitable',
  'bad_timing',
  'no_response_x3',
]);

const SURVEY_SUBSTAGE_FILTER_OPTIONS = [
  { id: 'unqualified',    label: 'Unqualified' },
  { id: 'not_suitable',   label: 'Not Suitable' },
  { id: 'bad_timing',     label: 'Bad Timing' },
  { id: 'no_response_x3', label: 'No Response ×3' },
];

const SURVEY_HIDDEN_KEY = 'surveyHiddenSubstages';

const SOURCE_LABELS: Record<string, string> = {
  website:   'Web',
  whatsapp:  'WhatsApp',
  call:      'Call',
  instagram: 'IG',
  facebook:  'FB',
  email:     'Email',
};

const STAGE_ACCENT: Record<string, string> = {
  sales:       '#8B2BFF',
  designvisit: '#0d9488',
  survey:      '#d97706',
};

const STAGE_LABEL_FALLBACK: Record<string, string> = {
  sales:       'Sales',
  designvisit: 'Design Visit',
  survey:      'Survey',
};

const DATA_READY_EVENT = 'survey-board-data-ready';

// ── BoardEntry type ────────────────────────────────────────────────────────────

interface BoardEntry {
  contact: Contact;
  substageId: string;
  sourceId: string;
  createdate: number;
  stageTime: number;
  priority: number;
  roomIdx?: number;
}

// ── Pure helpers ───────────────────────────────────────────────────────────────

function priorityScore(substageId: string): number {
  if (substageId === 'design_accepted') return 1;
  if (SURVEY_TERMINAL_SUBSTAGES.has(substageId)) return 3;
  return 2;
}

function relativeTime(input: number | string | null | undefined): string {
  if (!input) return '';
  const ts = typeof input === 'number' ? input : Number(input);
  if (!ts || isNaN(ts)) return '';
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return mins <= 1 ? 'just now' : `${mins}m ago`;
  const hours = Math.floor(diff / 3600000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(diff / 86400000);
  if (days < 14) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 8) return `${weeks}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function getStageLabel(stageKey: string, workflow: WorkflowDef | undefined): string {
  return workflow?.stages?.[stageKey]?.label || STAGE_LABEL_FALLBACK[stageKey] || stageKey;
}

function getSubstageLabel(
  substageId: string,
  workflow: WorkflowDef | undefined,
): string {
  if (!substageId) return '';
  const stage = workflow?.stages?.[SURVEY_STAGE_KEY];
  if (!stage) return substageId;
  const status = (stage.statuses || []).find((s) => s.id === substageId);
  return status ? status.label : substageId;
}

function getContactName(c: Contact): string {
  const first = c.properties?.firstname || '';
  const last = c.properties?.lastname || '';
  const both = `${first} ${last}`.trim();
  if (both) return both;
  return c.properties?.email || `Contact ${c.id}`;
}

function bestSurveyRoom(cached: Room[] | undefined | null): RoomWithIdx | null {
  if (!cached || cached.length === 0) return null;
  let best: RoomWithIdx | null = null;
  let bestScore = Infinity;
  for (let idx = 0; idx < cached.length; idx++) {
    const r = cached[idx];
    if ((r.roomStatus || 'active') !== 'active') continue;
    if (r.stageKey !== SURVEY_STAGE_KEY) continue;
    const score = priorityScore(r.statusId || '');
    if (score < bestScore) {
      bestScore = score;
      best = { ...r, roomIdx: idx };
    }
  }
  return best;
}

function loadHiddenSubstages(): Set<string> {
  try {
    const saved = localStorage.getItem(SURVEY_HIDDEN_KEY);
    return saved !== null
      ? new Set(JSON.parse(saved))
      : new Set(['unqualified', 'not_suitable']);
  } catch {
    return new Set(['unqualified', 'not_suitable']);
  }
}

function saveHiddenSubstages(hidden: Set<string>): void {
  try {
    localStorage.setItem(SURVEY_HIDDEN_KEY, JSON.stringify([...hidden]));
  } catch {
    /* ignore */
  }
}

// ── Data processing ────────────────────────────────────────────────────────────

function buildSurveyEntries(contacts: PaginatedContact[]): BoardEntry[] {
  const w = window as unknown as WindowGlobals;
  const contactStageCache = w.state?.contactStageCache || {};

  const entries: BoardEntry[] = [];

  for (const contact of contacts) {
    const cached = contactStageCache[contact.id];
    const best = bestSurveyRoom(cached);
    if (!best) continue;

    const createdate = parseInt(contact.properties?.createdate || '0', 10);
    const statusId = best.statusId || '';
    const substageDate =
      statusId && best.substateDates?.[statusId]
        ? new Date(best.substateDates[statusId] + 'T00:00:00').getTime()
        : null;
    const stageEntryDate = best.stageDates?.[SURVEY_STAGE_KEY]
      ? new Date(
          (best.stageDates as Record<string, string>)[SURVEY_STAGE_KEY] + 'T00:00:00',
        ).getTime()
      : null;

    entries.push({
      contact: contact as Contact,
      substageId: statusId,
      sourceId: best.sourceId || '',
      createdate,
      stageTime: substageDate || stageEntryDate || createdate,
      priority: priorityScore(statusId),
      roomIdx: best.roomIdx,
    });
  }

  // Sort within the current page: highest priority first, then newest
  entries.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.createdate - a.createdate;
  });

  return entries;
}

// ── StageTrail ─────────────────────────────────────────────────────────────────

function StageTrail({
  isTerminal,
  workflow,
}: {
  isTerminal: boolean;
  workflow: WorkflowDef | undefined;
}) {
  const activeIdx = PIPELINE_ALL_STAGES.indexOf(SURVEY_STAGE_KEY as (typeof PIPELINE_ALL_STAGES)[number]);

  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', mt: 0.75, mb: 0.25 }}>
      {PIPELINE_ALL_STAGES.map((sk, i) => {
        const done = i < activeIdx;
        const active = i === activeIdx;
        const isLast = i === PIPELINE_ALL_STAGES.length - 1;
        const hex = isTerminal ? '#B8AE99' : (STAGE_ACCENT[sk] || '#8B2BFF');
        const dotColor = done || active ? hex : '#D9D2C2';
        const lineColor = done ? hex : '#D9D2C2';
        const labelColor = done || active ? hex : '#97927F';
        const dotSize = active ? 8 : 6;
        const label = getStageLabel(sk, workflow);

        return (
          <React.Fragment key={sk}>
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.3 }}>
              <Box
                sx={{
                  width: dotSize,
                  height: dotSize,
                  borderRadius: '50%',
                  bgcolor: dotColor,
                  flexShrink: 0,
                  mt: active ? 0 : '1px',
                  ...(active
                    ? { outline: `3px solid ${dotColor}26`, outlineOffset: '1px' }
                    : {}),
                }}
              />
              <Typography
                variant="caption"
                sx={{
                  color: labelColor,
                  fontWeight: active ? 700 : 400,
                  opacity: done ? 0.65 : 1,
                  fontSize: '0.6rem',
                  lineHeight: 1.2,
                  whiteSpace: 'nowrap',
                }}
              >
                {label}
              </Typography>
            </Box>
            {!isLast && (
              <Box
                sx={{
                  flex: 1,
                  height: '2px',
                  bgcolor: lineColor,
                  opacity: done ? 0.7 : 0.35,
                  mx: 0.4,
                  mt: '3px',
                  mb: 'auto',
                }}
              />
            )}
          </React.Fragment>
        );
      })}
    </Box>
  );
}

// ── SurveyCard ─────────────────────────────────────────────────────────────────

function SurveyCard({
  entry,
  isManager,
  workflow,
  cardActionHandlerFor,
  resolveActionLabel,
}: {
  entry: BoardEntry;
  isManager: boolean;
  workflow: WorkflowDef | undefined;
  cardActionHandlerFor: (
    stageKey: string,
    leadStatusKey: string | undefined,
    hwSubstatusValue: string | undefined,
  ) => CardActionHandlerData | null;
  resolveActionLabel: (
    stageKey: string,
    leadStatusKey: string | undefined,
    substageId: string | undefined,
    hwSubstatusValue: string | undefined,
  ) => string;
}) {
  const { contact, substageId, sourceId, stageTime, priority, roomIdx } = entry;
  const isTerminal = priority === 3;
  const surveyColor = STAGE_COLORS[SURVEY_STAGE_KEY];
  const accent = isTerminal ? '#B8AE99' : (STAGE_ACCENT[SURVEY_STAGE_KEY] || '#d97706');
  const hasRoom = Number.isInteger(roomIdx);

  const name = getContactName(contact);
  const customerNum = contact.properties?.customer_number || '';
  const postcode = (contact.properties?.zip || '').trim().toUpperCase().split(/\s+/)[0];
  const subLabel = getSubstageLabel(substageId, workflow);

  const lmdRaw = contact.properties?.lastmodifieddate;
  const lmdMs = lmdRaw ? new Date(lmdRaw).getTime() : NaN;
  const displayTime = !isNaN(lmdMs) ? lmdMs : stageTime;
  const timeStr = relativeTime(displayTime);

  const leadStatusKey = contact.properties?.hs_lead_status;
  const hwSubstatusValue = contact.properties?.hw_lead_substatus;

  const [lsAnchor, setLsAnchor] = useState<HTMLElement | null>(null);
  const [subAnchor, setSubAnchor] = useState<HTMLElement | null>(null);

  const surveyStatuses: Array<{ id: string; label?: string }> =
    (workflow?.stages?.[SURVEY_STAGE_KEY]?.statuses as Array<{ id: string; label?: string }>) || [];

  const w = window as unknown as WindowGlobals;
  const handler = cardActionHandlerFor(SURVEY_STAGE_KEY, leadStatusKey, hwSubstatusValue);
  const cahName = handler?.config?.action_name
    ? handler.config.action_name
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c: string) => c.toUpperCase())
    : '';

  const actionLabel = isTerminal
    ? ''
    : cahName || resolveActionLabel(SURVEY_STAGE_KEY, leadStatusKey, substageId, hwSubstatusValue);

  const actionTint = surveyColor?.light || '#fef3c7';
  const actionTextColor = surveyColor?.text || '#b45309';

  const subPillBg = isTerminal ? '#F1EDE3' : `rgba(${hexToRgb(accent)},0.09)`;
  const subPillText = isTerminal ? '#97927F' : accent;
  const subPillBorder = isTerminal ? '#E8E3D8' : `rgba(${hexToRgb(accent)},0.22)`;

  const handleSubstagePillClick = (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    if (isManager && hasRoom && !isTerminal) {
      setSubAnchor(e.currentTarget);
    }
  };

  const handleLeadStatusClick = (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    if (isManager) {
      setLsAnchor(e.currentTarget);
    }
  };

  const navigateToContact = () => {
    location.href = `/customers/${encodeURIComponent(contact.id)}`;
  };

  return (
    <Card
      variant="outlined"
      sx={{
        mb: 1,
        opacity: isTerminal ? 0.55 : 1,
        borderRadius: 1.5,
        overflow: 'hidden',
        borderTop: `3px solid ${accent}`,
        borderColor: 'divider',
        transition: 'box-shadow 0.15s',
        '&:hover': { boxShadow: '0 2px 8px rgba(0,0,0,0.1)' },
      }}
    >
      <Box
        onClick={navigateToContact}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') navigateToContact();
        }}
        data-contact-id={contact.id}
        sx={{ px: 1.5, pt: 1.25, pb: 1, cursor: 'pointer', userSelect: 'none' }}
      >
        {/* Name row */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 1,
            mb: 0.5,
          }}
        >
          <Box
            sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0, flexShrink: 1 }}
          >
            <Typography
              variant="subtitle2"
              sx={{
                fontWeight: 700,
                lineHeight: 1.3,
                fontSize: '0.88rem',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {name}
            </Typography>
            {customerNum && (
              <Typography
                component="span"
                variant="caption"
                sx={{ color: 'text.secondary', fontSize: '0.72rem', whiteSpace: 'nowrap', flexShrink: 0 }}
              >
                {customerNum}
              </Typography>
            )}
          </Box>
          {postcode && (
            <Typography
              component="span"
              variant="caption"
              sx={{ color: 'text.secondary', fontSize: '0.72rem', fontWeight: 500, whiteSpace: 'nowrap', flexShrink: 0 }}
            >
              {postcode}
            </Typography>
          )}
        </Box>

        {/* Pills row */}
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 0.75 }}>
          {/* Stage pill */}
          {!isTerminal && (
            <Box
              component="span"
              sx={{
                display: 'inline-block',
                px: 0.9,
                py: 0.2,
                borderRadius: 0.75,
                fontSize: '0.72rem',
                fontWeight: 600,
                lineHeight: 1.4,
                bgcolor: accent,
                color: '#fff',
              }}
            >
              {getStageLabel(SURVEY_STAGE_KEY, workflow)}
            </Box>
          )}

          {/* Substage pill */}
          {substageId && (
            <Box
              component="span"
              onClick={isManager && hasRoom && !isTerminal ? handleSubstagePillClick : undefined}
              data-card-edit={isManager && hasRoom && !isTerminal ? 'substage' : undefined}
              data-contact-id={isManager && hasRoom && !isTerminal ? contact.id : undefined}
              data-room-idx={isManager && hasRoom && !isTerminal ? roomIdx : undefined}
              title={isManager && hasRoom && !isTerminal ? 'Change substage' : undefined}
              sx={{
                display: 'inline-block',
                px: 0.9,
                py: 0.2,
                borderRadius: 0.75,
                fontSize: '0.72rem',
                fontWeight: 600,
                lineHeight: 1.4,
                bgcolor: subPillBg,
                color: subPillText,
                border: `1px solid ${subPillBorder}`,
                cursor: isManager && hasRoom && !isTerminal ? 'pointer' : 'default',
              }}
            >
              {subLabel}
            </Box>
          )}

          {/* Source pill */}
          {sourceId && SOURCE_LABELS[sourceId] && (
            <Box
              component="span"
              sx={{
                display: 'inline-block',
                px: 0.9,
                py: 0.2,
                borderRadius: 0.75,
                fontSize: '0.72rem',
                fontWeight: 500,
                lineHeight: 1.4,
                border: '1px solid #D9D2C2',
                color: '#6B6860',
              }}
            >
              {SOURCE_LABELS[sourceId]}
            </Box>
          )}
        </Box>

        {/* Stage trail */}
        <StageTrail isTerminal={isTerminal} workflow={workflow} />

        {/* Footer */}
        <Typography
          variant="caption"
          sx={{ color: 'text.secondary', fontSize: '0.7rem', display: 'block', mt: 0.5 }}
        >
          Updated {timeStr}
        </Typography>
      </Box>

      {/* Action strip */}
      {actionLabel && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            px: 1.5,
            py: 0.75,
            bgcolor: actionTint,
            borderTop: '1px solid',
            borderTopColor: 'divider',
            cursor: handler ? 'pointer' : isManager ? 'pointer' : 'default',
          }}
          {...(handler
            ? {
                'data-card-action-handler-id': handler.id,
                'data-card-action-handler-type': handler.type,
                ...(handler.config?.action_name
                  ? { 'data-card-action-name': handler.config.action_name }
                  : {}),
                'data-card-action-contact-id': contact.id,
                'data-card-action-contact-name': name,
                'data-card-action-contact-email': contact.properties?.email || '',
                role: 'button' as const,
                tabIndex: -1,
                title: 'Run action',
              }
            : isManager
              ? {
                  'data-card-edit': 'leadstatus',
                  'data-contact-id': contact.id,
                  onClick: handleLeadStatusClick,
                  role: 'button' as const,
                  tabIndex: -1,
                  title: 'Change lead status',
                }
              : {})}
        >
          <Typography
            variant="caption"
            sx={{ color: actionTextColor, fontWeight: 600, fontSize: '0.78rem' }}
          >
            {actionLabel}
          </Typography>
          <ChevronRightIcon sx={{ fontSize: 15, color: actionTextColor, flexShrink: 0 }} />
        </Box>
      )}
      <LeadStatusPicker
        anchorEl={lsAnchor}
        open={Boolean(lsAnchor)}
        onClose={() => setLsAnchor(null)}
        contactId={contact.id}
        currentStatus={leadStatusKey || ''}
        currentHwSubstatus={hwSubstatusValue || ''}
      />
      <SubstagePicker
        anchorEl={subAnchor}
        open={Boolean(subAnchor)}
        onClose={() => setSubAnchor(null)}
        contactId={contact.id}
        roomIdx={roomIdx as number}
        stageKey={SURVEY_STAGE_KEY}
        statuses={surveyStatuses}
        currentSubId={substageId}
      />
    </Card>
  );
}

function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r},${g},${b}`;
}

// ── SurveyBoardPage ────────────────────────────────────────────────────────────

export function SurveyBoardPage() {
  const [tick, setTick] = useState(0);
  const [hiddenSubstages, setHiddenSubstages] = useState<Set<string>>(loadHiddenSubstages);
  const [filterAnchor, setFilterAnchor] = useState<HTMLButtonElement | null>(null);
  const filterBtnRef = useRef<HTMLButtonElement>(null);
  const { isManager } = usePrivilege();
  const { cardActionHandlerFor, resolveActionLabel } = useCardActionHandlers();
  const forceUpdate = useCallback(() => setTick((t) => t + 1), []);

  // Bootstrap-failure error state — fires when core.js bootstrap() throws and
  // dispatches 'survey-board-bootstrap-failed' instead of writing to #survey-view
  // innerHTML (which would orphan this React tree).
  // Read the window flag synchronously as the initial value so the component
  // shows the error immediately even when the event fired before this chunk
  // finished loading (race condition: bootstrap can fail before React mounts).
  const [bootstrapFailed, setBootstrapFailed] = useState(
    () => !!(window as unknown as WindowGlobals).__surveyBoardBootstrapFailed,
  );
  useEffect(() => {
    const onBootstrapFail = () => setBootstrapFailed(true);
    document.addEventListener('survey-board-bootstrap-failed', onBootstrapFail);
    return () => document.removeEventListener('survey-board-bootstrap-failed', onBootstrapFail);
  }, []);

  useEffect(() => {
    const onReady = () => {
      // Clear the window flag so a successful reload after a failure doesn't
      // immediately re-show the error on the next mount.
      (window as unknown as WindowGlobals).__surveyBoardBootstrapFailed = undefined;
      setBootstrapFailed(false);
      forceUpdate();
    };
    document.addEventListener(DATA_READY_EVENT, onReady);
    return () => document.removeEventListener(DATA_READY_EVENT, onReady);
  }, [forceUpdate]);

  // Retry-failure Snackbar with Page Visibility pause — mirrors the pattern
  // in SalesBoardPage.tsx.  autoHideDuration is set to null while the document
  // is hidden so the MUI timer is paused; restored to 8 s on tab focus.
  const [bgRefreshFailed, setBgRefreshFailed] = useState(false);
  const [snackbarHideDuration, setSnackbarHideDuration] = useState<number | null>(8000);
  const bgRefreshFailedRef = useRef(false);
  useEffect(() => { bgRefreshFailedRef.current = bgRefreshFailed; }, [bgRefreshFailed]);
  useEffect(() => {
    const onVis = () => {
      if (!bgRefreshFailedRef.current) return;
      setSnackbarHideDuration(document.hidden ? null : 8000);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  useEffect(() => {
    const onFail = () => setBgRefreshFailed(true);
    document.addEventListener('survey-board-bg-refresh-failed', onFail);
    return () => document.removeEventListener('survey-board-bg-refresh-failed', onFail);
  }, []);

  // Stale-data Snackbar — shown when loadAllContacts detects X-Cache-Status: stale.
  // Clears automatically when the next load returns fresh data (detail.stale === false).
  // Auto-dismisses after 10 s and can also be closed manually.
  // Mirrors the bgRefreshFailed visibility-pause pattern: autoHideDuration is null
  // while the tab is hidden so the MUI timer is suspended; restored to 10 s on focus.
  const [staleData, setStaleData] = useState(false);
  const [staleDataHideDuration, setStaleDataHideDuration] = useState<number | null>(10000);
  const staleDataRef = useRef(false);
  useEffect(() => { staleDataRef.current = staleData; }, [staleData]);
  useEffect(() => {
    const onVis = () => {
      if (!staleDataRef.current) return;
      setStaleDataHideDuration(document.hidden ? null : 10000);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  useEffect(() => {
    const onCacheStatus = (e: Event) => {
      const detail = (e as CustomEvent<{ stale: boolean }>).detail;
      setStaleData(detail?.stale === true);
    };
    document.addEventListener('survey-board-cache-status', onCacheStatus);
    return () => document.removeEventListener('survey-board-cache-status', onCacheStatus);
  }, []);

  useEffect(() => {
    const refresh = () => {
      const w = window as unknown as WindowGlobals;
      Promise.all([
        w.loadWorkflow?.() ?? Promise.resolve(),
        w.loadLeadStatuses?.() ?? Promise.resolve(),
      ])
        .then(() => forceUpdate())
        .catch(() => forceUpdate());
    };

    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);

    let bc: BroadcastChannel | null = null;
    let subBc: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      bc = new BroadcastChannel('lead_statuses_changed');
      bc.addEventListener('message', refresh);
      subBc = new BroadcastChannel('lead_substatuses_changed');
      subBc.addEventListener('message', refresh);
    }

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (bc) bc.close();
      if (subBc) subBc.close();
    };
  }, [forceUpdate]);

  // ── usePaginatedContacts: survey column ─────────────────────────────────
  // Server filters to contacts with a room in the survey stage.  Room/substage
  // data is augmented client-side from window.state.contactStageCache; tick
  // keeps the useMemo in sync when room data refreshes without forcing a refetch.
  const surveyHook = usePaginatedContacts({
    initialPage: 1, leadStatus: '', substatus: '',
    stage: 'survey', sortBy: 'newest', search: '', showArchived: false,
  });

  const allEntries = useMemo(
    () => buildSurveyEntries(surveyHook.contacts),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [surveyHook.contacts, tick],
  );
  const workflow = (window as unknown as WindowGlobals).state?.workflow;

  const visibleEntries = useMemo(
    () => allEntries.filter((e) => !hiddenSubstages.has(e.substageId)),
    [allEntries, hiddenSubstages],
  );

  // Reset to page 1 when the substage filter changes — done in an effect
  // (not inside useMemo) so it is never a render-phase side effect.
  useEffect(() => {
    surveyHook.setPage(1);
  // surveyHook.setPage is a stable useState setter; only hiddenSubstages matters.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiddenSubstages]);

  const surveyColor = STAGE_COLORS[SURVEY_STAGE_KEY];
  const accent = STAGE_ACCENT[SURVEY_STAGE_KEY];
  const label = getStageLabel(SURVEY_STAGE_KEY, workflow);
  const count = surveyHook.total;

  const hiddenCount = hiddenSubstages.size;
  const filterOpen = Boolean(filterAnchor);

  const toggleSubstage = (id: string) => {
    setHiddenSubstages((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveHiddenSubstages(next);
      return next;
    });
  };

  if (bootstrapFailed) {
    return (
      <Box
        sx={{
          display: 'flex',
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          p: 4,
          bgcolor: 'background.default',
        }}
      >
        <Box
          sx={{
            maxWidth: 420,
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 2,
          }}
        >
          <WarningAmberIcon sx={{ fontSize: 48, color: 'warning.main', opacity: 0.8 }} />
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            HubSpot is currently unavailable
          </Typography>
          <Typography variant="body2" color="text.secondary">
            The survey board couldn&apos;t load because HubSpot couldn&apos;t be reached.
            This is usually a temporary issue.
          </Typography>
          <Button
            variant="contained"
            onClick={() => window.location.reload()}
            sx={{ mt: 1 }}
          >
            Reload page
          </Button>
        </Box>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
        bgcolor: 'background.default',
      }}
    >
      {/* Column header */}
      <Box
        sx={{
          borderTop: `3px solid ${accent}`,
          borderBottom: '1px solid',
          borderBottomColor: 'divider',
          bgcolor: 'background.paper',
          px: 1.5,
          py: 1.25,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
          position: 'sticky',
          top: 0,
          zIndex: 1,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700, fontSize: '0.9rem', lineHeight: 1.4 }}>
            {label}
          </Typography>
          {count > 0 && (
            <Box
              component="span"
              sx={{
                display: 'inline-block',
                px: 0.75,
                py: 0.1,
                borderRadius: '999px',
                fontSize: '0.72rem',
                fontWeight: 600,
                lineHeight: 1.6,
                bgcolor: surveyColor?.light || '#fef3c7',
                color: surveyColor?.text || '#b45309',
              }}
            >
              {count}
            </Box>
          )}
        </Box>

        {/* Substage filter button */}
        <Box
          component="button"
          ref={filterBtnRef}
          onClick={(e: React.MouseEvent<HTMLButtonElement>) =>
            setFilterAnchor(filterOpen ? null : e.currentTarget)
          }
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.5,
            fontSize: '0.75rem',
            fontWeight: 600,
            fontFamily: 'inherit',
            color: filterOpen || hiddenCount > 0 ? '#fff' : 'text.secondary',
            bgcolor: filterOpen || hiddenCount > 0 ? accent : 'background.paper',
            border: '1.5px solid',
            borderColor: filterOpen || hiddenCount > 0 ? accent : 'divider',
            borderRadius: '999px',
            px: 1.25,
            py: 0.5,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            transition: 'background 0.12s, color 0.12s, border-color 0.12s',
            WebkitTapHighlightColor: 'transparent',
            '&:hover': {
              bgcolor: filterOpen || hiddenCount > 0 ? accent : 'action.hover',
              borderColor: accent,
              color: filterOpen || hiddenCount > 0 ? '#fff' : accent,
            },
          }}
        >
          <FilterListIcon sx={{ fontSize: 14 }} />
          <span>Filter</span>
          {hiddenCount > 0 && (
            <Box
              component="span"
              sx={{
                fontSize: '0.65rem',
                fontWeight: 700,
                bgcolor: 'rgba(255,255,255,0.25)',
                borderRadius: '999px',
                px: 0.6,
                py: 0.1,
                ml: 0.25,
              }}
            >
              {hiddenCount} hidden
            </Box>
          )}
        </Box>
      </Box>

      {/* Substage filter popover */}
      <Popover
        open={filterOpen}
        anchorEl={filterAnchor}
        onClose={() => setFilterAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{
          paper: {
            sx: {
              mt: 0.75,
              minWidth: 168,
              p: 1.5,
              border: '1.5px solid',
              borderColor: 'divider',
              borderRadius: 1.5,
            },
          },
        }}
      >
        <Typography
          variant="caption"
          sx={{
            display: 'block',
            fontWeight: 700,
            color: 'text.secondary',
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
            fontSize: '0.68rem',
            mb: 1,
          }}
        >
          Show substages
        </Typography>
        {SURVEY_SUBSTAGE_FILTER_OPTIONS.map((opt) => (
          <FormControlLabel
            key={opt.id}
            control={
              <Checkbox
                size="small"
                checked={!hiddenSubstages.has(opt.id)}
                onChange={() => toggleSubstage(opt.id)}
                sx={{ py: 0.25, '& .MuiSvgIcon-root': { fontSize: 16 } }}
              />
            }
            label={opt.label}
            sx={{
              display: 'flex',
              m: 0,
              '& .MuiFormControlLabel-label': { fontSize: '0.8rem', fontWeight: 500 },
            }}
          />
        ))}
      </Popover>

      {/* Card list */}
      <Box
        sx={{
          flex: 1,
          overflowY: 'auto',
          px: 1,
          py: 1,
          WebkitOverflowScrolling: 'touch',
        }}
      >
        {surveyHook.loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', pt: 4 }}>
            <CircularProgress size={24} />
          </Box>
        ) : surveyHook.error ? (
          <Alert severity="error" sx={{ m: 1 }}>{surveyHook.error}</Alert>
        ) : visibleEntries.length === 0 ? (
          <Typography
            variant="body2"
            sx={{ color: 'text.secondary', textAlign: 'center', py: 6, opacity: 0.55 }}
          >
            No surveys yet.
          </Typography>
        ) : (
          visibleEntries.map((e) => (
            <SurveyCard
              key={e.contact.id}
              entry={e}
              isManager={isManager}
              workflow={workflow}
              cardActionHandlerFor={cardActionHandlerFor}
              resolveActionLabel={resolveActionLabel}
            />
          ))
        )}
        {!surveyHook.loading && !surveyHook.error && surveyHook.total > 0 && (
          <Box sx={{ px: 0.5, pb: 1 }}>
            <ContactsPagination
              page={surveyHook.page}
              totalPages={surveyHook.totalPages}
              total={surveyHook.total}
              visibleCount={visibleEntries.length}
              pageLimit={PAGINATED_CONTACTS_PAGE_LIMIT}
              onPageChange={surveyHook.setPage}
            />
          </Box>
        )}
      </Box>

      <Snackbar
        open={bgRefreshFailed}
        autoHideDuration={snackbarHideDuration}
        onClose={() => setBgRefreshFailed(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity="warning"
          onClose={() => setBgRefreshFailed(false)}
          variant="filled"
          sx={{ minWidth: 280 }}
        >
          Couldn&apos;t refresh live data — fresh results will load on your next visit
        </Alert>
      </Snackbar>

      <Snackbar
        open={staleData}
        autoHideDuration={staleDataHideDuration}
        onClose={() => setStaleData(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity="info"
          onClose={() => setStaleData(false)}
          variant="filled"
          sx={{ minWidth: 280 }}
        >
          Showing cached data — live results will load when HubSpot recovers
        </Alert>
      </Snackbar>
    </Box>
  );
}
