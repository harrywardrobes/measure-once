import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Box, Button, Card, Snackbar, Typography } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { STAGE_COLORS } from '../theme';
import { usePrivilege } from '../hooks/usePrivilege';

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
  excluded_from_sales?: boolean;
  stage?: string;
}

interface LeadSubstatus {
  id: number;
  status_key: string;
  substatus_key: string;
  label?: string;
}

interface CardActionHandler {
  id: number;
  type: string;
  config?: {
    action_name?: string;
    [key: string]: unknown;
  };
  bindings?: unknown[];
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
  user?: { privilege_level?: string }; // privilege-read-ok: global state shape declaration
}

interface WindowGlobals {
  state?: StateGlobal;
  LEAD_STATUS_OPTIONS?: LeadStatusOption[];
  LEAD_SUBSTATUSES?: LeadSubstatus[];
  loadWorkflow?: () => Promise<void>;
  loadLeadStatuses?: () => Promise<void>;
  openCardSubstagePicker?: (evt: object, contactId: string, roomIdx: number) => void;
  openLeadStatusPicker?: (evt: object, contactId: string) => void;
  cardActionHandlerFor?: (
    stageKey: string,
    leadStatusKey: string | undefined,
    hwSubstatusValue: string | undefined,
  ) => CardActionHandler | null;
  stageOrLeadStatusActionLabel?: (
    stageKey: string,
    leadStatusKey: string | undefined,
    substageId: string | undefined,
  ) => string;
  substatusActionLabelLookup?: (
    leadStatusKey: string | undefined,
    hwSubstatusValue: string | undefined,
  ) => string;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const SALES_TAB_STAGES = ['sales', 'designvisit'] as const;
type ColumnKey = (typeof SALES_TAB_STAGES)[number];

const PIPELINE_ALL_STAGES = ['sales', 'designvisit', 'survey'] as const;

const TERMINAL_SUBSTAGES = new Set([
  'unqualified',
  'not_suitable',
  'bad_timing',
  'no_response_x3',
]);

const SOURCE_LABELS: Record<string, string> = {
  website: 'Web',
  whatsapp: 'WhatsApp',
  call: 'Call',
  instagram: 'IG',
  facebook: 'FB',
  email: 'Email',
};

const STAGE_ACCENT: Record<string, string> = {
  sales: '#8B2BFF',
  designvisit: '#0d9488',
  survey: '#d97706',
};

const STAGE_TINT: Record<string, string> = {
  sales: '#F3EAFF',
  designvisit: '#CCFBF1',
  survey: '#FEF3C7',
};

const STAGE_ACTION_TEXT: Record<string, string> = {
  sales: '#6A12D9',
  designvisit: '#0f766e',
  survey: '#b45309',
};

const STAGE_LABEL_FALLBACK: Record<string, string> = {
  sales: 'Sales',
  designvisit: 'Design Visit',
  survey: 'Survey',
};

const HS_STATUS_COLUMN: Record<string, string> = {
  OPEN_DEAL: 'designvisit',
  VISIT_SCHEDULED: 'designvisit',
  NEW: 'sales',
  OPEN: 'sales',
  IN_PROGRESS: 'sales',
  CONNECTED: 'sales',
  ATTEMPTED_TO_CONTACT: 'sales',
  BAD_TIMING: 'sales',
};

const STAGE_COLUMN_INFO: Record<string, { column: string; terminal: boolean }> = {
  SALES: { column: 'sales', terminal: false },
  DESIGN_VISIT: { column: 'designvisit', terminal: false },
  SURVEY: { column: 'designvisit', terminal: true },
  ORDER: { column: 'designvisit', terminal: true },
  WORKSHOP: { column: 'designvisit', terminal: true },
  PACKING: { column: 'designvisit', terminal: true },
  DELIVERY: { column: 'designvisit', terminal: true },
  INSTALLATION: { column: 'designvisit', terminal: true },
  AFTERCARE: { column: 'designvisit', terminal: true },
  CUSTOMER_SERVICE: { column: 'designvisit', terminal: true },
};

const FOUR_WEEKS_MS = 4 * 7 * 24 * 60 * 60 * 1000;
const MOBILE_COL_KEY = 'salesBoardActiveColumn';

// Dispatched by sales.js after it loads/reloads contact data so this
// component re-renders with the latest state.
const DATA_READY_EVENT = 'sales-board-data-ready';

// ── Pure helpers ───────────────────────────────────────────────────────────────

function priorityScore(stageKey: string, substageId: string): number {
  if (stageKey === 'designvisit' && substageId === 'open_deal') return 0;
  if (TERMINAL_SUBSTAGES.has(substageId)) return 3;
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
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function getStageLabel(stageKey: string, workflow: WorkflowDef | undefined): string {
  return workflow?.stages?.[stageKey]?.label || STAGE_LABEL_FALLBACK[stageKey] || stageKey;
}

function getSubstageLabel(
  stageKey: string,
  substageId: string,
  workflow: WorkflowDef | undefined,
): string {
  if (!substageId) return '';
  const stage = workflow?.stages?.[stageKey];
  if (!stage) return substageId;
  const status = (stage.statuses || []).find((s) => s.id === substageId);
  return status ? status.label : substageId;
}

function substagePillColour(stageKey: string, substageId: string): { bg: string; text: string } {
  if (TERMINAL_SUBSTAGES.has(substageId)) {
    return { bg: '#F1EDE3', text: '#97927F' };
  }
  if (stageKey === 'designvisit' && substageId === 'open_deal') {
    return { bg: '#dbeafe', text: '#1d4ed8' };
  }
  if (substageId === 'OPEN_DEAL' || substageId === 'VISIT_SCHEDULED') {
    return { bg: '#dbeafe', text: '#1d4ed8' };
  }
  if (substageId === 'form_submission' || substageId === 'attempted_contact') {
    return { bg: '#fef3c7', text: '#b45309' };
  }
  return { bg: '#ccfbf1', text: '#0f766e' };
}

function columnForLeadStatus(ls: string): { column: string | null; terminal: boolean } {
  if (!ls) return { column: null, terminal: false };
  const opts = (window as unknown as WindowGlobals).LEAD_STATUS_OPTIONS;
  const opt = opts ? opts.find((o) => o.value === ls) : null;
  const stage = opt?.stage;
  if (stage && STAGE_COLUMN_INFO[stage]) return STAGE_COLUMN_INFO[stage];
  return { column: HS_STATUS_COLUMN[ls] || null, terminal: false };
}

function bestRoom(cached: Room[] | undefined | null): RoomWithIdx | null {
  if (!cached || cached.length === 0) return null;
  let best: RoomWithIdx | null = null;
  let bestScore = Infinity;
  for (let idx = 0; idx < cached.length; idx++) {
    const r = cached[idx];
    if ((r.roomStatus || 'active') !== 'active') continue;
    if (!(SALES_TAB_STAGES as readonly string[]).includes(r.stageKey || '')) continue;
    const score = priorityScore(r.stageKey || '', r.statusId || '');
    if (score < bestScore) {
      bestScore = score;
      best = { ...r, roomIdx: idx };
    }
  }
  return best;
}

function getNextActionLabel(
  stageKey: string,
  substageId: string,
  leadStatusKey: string | undefined,
  hwSubstatusValue: string | undefined,
): string {
  const w = window as unknown as WindowGlobals;
  if (typeof w.substatusActionLabelLookup === 'function') {
    const fromSub = w.substatusActionLabelLookup(leadStatusKey, hwSubstatusValue);
    if (fromSub) return fromSub;
  }
  if (typeof w.stageOrLeadStatusActionLabel === 'function') {
    return w.stageOrLeadStatusActionLabel(stageKey, leadStatusKey, substageId) || '';
  }
  return '';
}

function getContactName(c: Contact): string {
  const first = c.properties?.firstname || '';
  const last = c.properties?.lastname || '';
  const both = `${first} ${last}`.trim();
  if (both) return both;
  return c.properties?.email || `Contact ${c.id}`;
}

function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r},${g},${b}`;
}

// ── BoardEntry type ────────────────────────────────────────────────────────────

interface BoardEntry {
  contact: Contact;
  stageKey: string;
  substageId: string;
  badgeLabel: string;
  sourceId: string;
  createdate: number;
  stageTime: number;
  priority: number;
  roomIdx?: number;
}

// ── Data processing ────────────────────────────────────────────────────────────

function computeBoardData(): Record<string, BoardEntry[]> {
  const w = window as unknown as WindowGlobals;
  const state = w.state;
  const contacts = state?.filteredContacts || [];
  const contactStageCache = state?.contactStageCache || {};
  const workflow = state?.workflow;
  const lsOptions = w.LEAD_STATUS_OPTIONS || [];
  const excludedLsSet = new Set(lsOptions.filter((o) => o.excluded_from_sales).map((o) => o.value));

  const allEntries: BoardEntry[] = [];

  for (const contact of contacts) {
    const ls = (contact.properties?.hs_lead_status || '').toUpperCase();
    if (excludedLsSet.has(ls)) continue;

    const cached = contactStageCache[contact.id];
    const createdate = parseInt(contact.properties?.createdate || '0', 10);
    const room = !cached || cached.length === 0 ? null : bestRoom(cached);

    if (!room) {
      const lsInfo = columnForLeadStatus(ls);
      const lsColumn = lsInfo.column || 'sales';
      const lsOpt = ls ? lsOptions.find((o) => o.value === ls) : null;
      allEntries.push({
        contact,
        stageKey: lsColumn,
        substageId: ls || '',
        badgeLabel: lsOpt ? lsOpt.label : '',
        sourceId: '',
        createdate,
        stageTime: createdate,
        priority: lsInfo.terminal ? 3 : 2,
      });
      continue;
    }

    const statusId = room.statusId || '';
    const substageDate =
      statusId && room.substateDates?.[statusId]
        ? new Date(room.substateDates[statusId] + 'T00:00:00').getTime()
        : null;
    const stageEntryDate = room.stageDates?.[room.stageKey || '']
      ? new Date((room.stageDates as Record<string, string>)[room.stageKey || ''] + 'T00:00:00').getTime()
      : null;

    const lsInfo = columnForLeadStatus(ls);
    const lsColumn = lsInfo.column;
    const finalStage = lsColumn || room.stageKey || 'sales';

    const lsOpt2 = !statusId && lsColumn ? lsOptions.find((o) => o.value === ls) : null;
    const roomBadge = lsOpt2 ? lsOpt2.label : '';

    const basePriority = priorityScore(finalStage, statusId);
    allEntries.push({
      contact,
      stageKey: finalStage,
      substageId: statusId,
      badgeLabel: roomBadge,
      sourceId: room.sourceId || '',
      createdate,
      stageTime: substageDate || stageEntryDate || createdate,
      priority: lsInfo.terminal ? 3 : basePriority,
      roomIdx: room.roomIdx,
    });
  }

  // Drop stale Sales-column entries (last modified > 4 weeks ago)
  const staleCutoff = Date.now() - FOUR_WEEKS_MS;
  const visible = allEntries.filter((e) => {
    if (e.stageKey !== 'sales') return true;
    const raw = e.contact.properties?.lastmodifieddate;
    if (!raw) return true;
    const lmd = new Date(raw).getTime();
    return !isNaN(lmd) && lmd >= staleCutoff;
  });

  // Sort: priority band asc, then newest first
  visible.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.createdate - a.createdate;
  });

  // Group by stage
  const byStage: Record<string, BoardEntry[]> = Object.fromEntries(
    SALES_TAB_STAGES.map((k) => [k, []]),
  );
  for (const e of visible) {
    if (byStage[e.stageKey]) byStage[e.stageKey].push(e);
  }
  return byStage;
}

// ── StageTrail ─────────────────────────────────────────────────────────────────

function StageTrail({
  activeKey,
  isTerminal,
  workflow,
}: {
  activeKey: string;
  isTerminal: boolean;
  workflow: WorkflowDef | undefined;
}) {
  const activeIdx = PIPELINE_ALL_STAGES.indexOf(
    activeKey as (typeof PIPELINE_ALL_STAGES)[number],
  );
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

// ── SalesCard ──────────────────────────────────────────────────────────────────

function SalesCard({
  entry,
  isManager,
  workflow,
}: {
  entry: BoardEntry;
  isManager: boolean;
  workflow: WorkflowDef | undefined;
}) {
  const { contact, stageKey, substageId, badgeLabel, sourceId, stageTime, priority, roomIdx } =
    entry;
  const isTerminal = priority === 3;
  const accent = isTerminal ? '#B8AE99' : (STAGE_ACCENT[stageKey] || '#8B2BFF');
  const hasRoom = Number.isInteger(roomIdx);

  const name = getContactName(contact);
  const customerNum = contact.properties?.customer_number || '';
  const postcode = (contact.properties?.zip || '').trim().toUpperCase().split(/\s+/)[0];
  const subLabel = badgeLabel || getSubstageLabel(stageKey, substageId, workflow);

  const lmdRaw = contact.properties?.lastmodifieddate;
  const lmdMs = lmdRaw ? new Date(lmdRaw).getTime() : NaN;
  const displayTime = !isNaN(lmdMs) ? lmdMs : stageTime;
  const timeStr = relativeTime(displayTime);

  const leadStatusKey = contact.properties?.hs_lead_status;
  const hwSubstatusValue = contact.properties?.hw_lead_substatus;

  // Resolve action handler and label
  const w = window as unknown as WindowGlobals;
  const handler =
    typeof w.cardActionHandlerFor === 'function'
      ? w.cardActionHandlerFor(stageKey, leadStatusKey, hwSubstatusValue)
      : null;
  const cahName = handler?.config?.action_name
    ? handler.config.action_name
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c: string) => c.toUpperCase())
    : '';
  const actionLabel = isTerminal
    ? ''
    : cahName || getNextActionLabel(stageKey, substageId, leadStatusKey, hwSubstatusValue);

  const actionTint = STAGE_TINT[stageKey] || '#f3f4f6';
  const actionTextColor = STAGE_ACTION_TEXT[stageKey] || '#374151';

  // Substage pill colours
  const pc = substagePillColour(stageKey, substageId);

  const handleSubstagePillClick = (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    if (isManager && hasRoom && typeof w.openCardSubstagePicker === 'function') {
      w.openCardSubstagePicker(
        { stopPropagation: () => {}, currentTarget: e.currentTarget },
        contact.id,
        roomIdx as number,
      );
    }
  };

  const handleLeadStatusClick = (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    if (isManager && typeof w.openLeadStatusPicker === 'function') {
      w.openLeadStatusPicker(
        { stopPropagation: () => {}, currentTarget: e.currentTarget },
        contact.id,
      );
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
      {/* Card body — navigates to customer */}
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
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.75,
              minWidth: 0,
              flexShrink: 1,
            }}
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
                sx={{
                  color: 'text.secondary',
                  fontSize: '0.72rem',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                {customerNum}
              </Typography>
            )}
          </Box>
          {postcode && (
            <Typography
              component="span"
              variant="caption"
              sx={{
                color: 'text.secondary',
                fontSize: '0.72rem',
                fontWeight: 500,
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
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
              {getStageLabel(stageKey, workflow)}
            </Box>
          )}

          {/* Substage / badge pill */}
          {(substageId || badgeLabel) && (
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
                bgcolor: isTerminal ? '#F1EDE3' : pc.bg,
                color: isTerminal ? '#97927F' : pc.text,
                border: isTerminal ? '1px solid #E8E3D8' : `1px solid ${pc.bg}`,
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
        <StageTrail activeKey={stageKey} isTerminal={isTerminal} workflow={workflow} />

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
    </Card>
  );
}

// ── SalesBoardPage ─────────────────────────────────────────────────────────────

export function SalesBoardPage() {
  const [tick, setTick] = useState(0);
  const [activeColumn, setActiveColumn] = useState<ColumnKey>(() => {
    try {
      const saved = localStorage.getItem(MOBILE_COL_KEY);
      return saved === 'sales' || saved === 'designvisit' ? saved : 'sales';
    } catch {
      return 'sales';
    }
  });
  const { isManager } = usePrivilege();
  const forceUpdate = useCallback(() => setTick((t) => t + 1), []);

  // Retry-failure Snackbar with Page Visibility pause — mirrors the pattern
  // in CustomersPage.tsx.  autoHideDuration is set to null while the document
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
    document.addEventListener('sales-board-bg-refresh-failed', onFail);
    return () => document.removeEventListener('sales-board-bg-refresh-failed', onFail);
  }, []);

  // Bootstrap-failure error state — fires when core.js bootstrap() throws and
  // dispatches 'sales-board-bootstrap-failed' instead of writing to #sales-view
  // innerHTML (which would orphan this React tree).
  const [bootstrapFailed, setBootstrapFailed] = useState(false);
  useEffect(() => {
    const onBootstrapFail = () => setBootstrapFailed(true);
    document.addEventListener('sales-board-bootstrap-failed', onBootstrapFail);
    return () => document.removeEventListener('sales-board-bootstrap-failed', onBootstrapFail);
  }, []);

  // Stale-data Snackbar — shown when loadAllContacts detects X-Cache-Status: stale.
  // Clears automatically when the next load returns fresh data (detail.stale === false).
  // Auto-dismisses after 10 s and can also be closed manually.
  const [staleData, setStaleData] = useState(false);
  useEffect(() => {
    const onCacheStatus = (e: Event) => {
      const detail = (e as CustomEvent<{ stale: boolean }>).detail;
      setStaleData(detail?.stale === true);
    };
    document.addEventListener('sales-board-cache-status', onCacheStatus);
    return () => document.removeEventListener('sales-board-cache-status', onCacheStatus);
  }, []);

  useEffect(() => {
    const onReady = () => {
      setBootstrapFailed(false);
      forceUpdate();
    };
    document.addEventListener(DATA_READY_EVENT, onReady);
    return () => document.removeEventListener(DATA_READY_EVENT, onReady);
  }, [forceUpdate]);

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

  const byStage = useMemo(() => computeBoardData(), [tick]);
  const workflow = (window as unknown as WindowGlobals).state?.workflow;

  const switchColumn = (col: ColumnKey) => {
    setActiveColumn(col);
    try {
      localStorage.setItem(MOBILE_COL_KEY, col);
    } catch {
      /* ignore */
    }
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
            The sales board couldn&apos;t load because HubSpot couldn&apos;t be reached.
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
    <>
    <Box
      sx={{
        display: 'flex',
        flexDirection: { xs: 'column', md: 'row' },
        flex: 1,
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
        bgcolor: 'background.default',
      }}
    >
      {SALES_TAB_STAGES.map((sk, colIdx) => {
        const entries = byStage[sk] || [];
        const count = entries.length;
        const accent = STAGE_ACCENT[sk];
        const stageColor = STAGE_COLORS[sk] || STAGE_COLORS.sales;
        const label = getStageLabel(sk, workflow);
        const isLastCol = colIdx === SALES_TAB_STAGES.length - 1;

        const otherColumn = SALES_TAB_STAGES[1 - colIdx];
        const otherLabel = getStageLabel(otherColumn, workflow);
        const isActiveOnMobile = activeColumn === sk;

        return (
          <Box
            key={sk}
            sx={{
              display: { xs: isActiveOnMobile ? 'flex' : 'none', md: 'flex' },
              flexDirection: 'column',
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              borderRight: { md: isLastCol ? 'none' : '1px solid' },
              borderRightColor: { md: 'divider' },
              overflow: 'hidden',
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
                <Typography
                  variant="subtitle1"
                  sx={{ fontWeight: 700, fontSize: '0.9rem', lineHeight: 1.4 }}
                >
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
                      bgcolor: `${stageColor.light}`,
                      color: stageColor.text,
                    }}
                  >
                    {count}
                  </Box>
                )}
              </Box>

              {/* Mobile: switch to other column */}
              <Box
                component="button"
                onClick={() => switchColumn(otherColumn)}
                sx={{
                  display: { xs: 'flex', md: 'none' },
                  alignItems: 'center',
                  gap: 0.25,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'text.secondary',
                  fontSize: '0.75rem',
                  fontWeight: 500,
                  p: 0,
                  lineHeight: 1,
                  '&:hover': { color: 'text.primary' },
                }}
              >
                {otherLabel}
                <ChevronRightIcon sx={{ fontSize: 14 }} />
              </Box>
            </Box>

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
              {entries.length === 0 ? (
                <Typography
                  variant="body2"
                  sx={{
                    color: 'text.secondary',
                    textAlign: 'center',
                    py: 6,
                    opacity: 0.55,
                  }}
                >
                  Nothing here yet.
                </Typography>
              ) : (
                entries.map((e) => (
                  <SalesCard
                    key={e.contact.id}
                    entry={e}
                    isManager={isManager}
                    workflow={workflow}
                  />
                ))
              )}
            </Box>
          </Box>
        );
      })}
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
      autoHideDuration={10000}
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
    </>
  );
}
