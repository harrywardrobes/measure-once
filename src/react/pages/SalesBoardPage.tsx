import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Box, Button, Card, Chip, CircularProgress, Snackbar, Typography } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { STAGE_COLORS } from '../theme';
import { usePrivilege } from '../hooks/usePrivilege';
import { useConnectionCheck, useConnectionToast } from '../context/ConnectionToastContext';
import { usePaginatedContacts, PaginatedContact, PAGINATED_CONTACTS_PAGE_LIMIT } from '../hooks/usePaginatedContacts';
import { ContactsPagination } from '../components/ContactsPagination';
import { useCardActionHandlers, CardActionHandlerData } from '../hooks/useCardActionHandlers';
import { dispatchCardActionHandler } from '../utils/dispatchCardActionHandler';
import { openCardActionModal } from '../utils/cardActionModalRegistry';
import type { ExistingVisit } from '../components/DesignVisitWizard';
import { LeadStatusPicker } from '../components/pickers/LeadStatusPicker';
import { SubstagePicker } from '../components/pickers/SubstagePicker';

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

interface WorkflowStage {
  label?: string;
  statuses?: Array<{ id: string; label: string }>;
}

interface WorkflowDef {
  stages?: Record<string, WorkflowStage>;
}

interface StateGlobal {
  filteredContacts?: Contact[];
  workflow?: WorkflowDef;
  user?: { privilege_level?: string }; // privilege-read-ok: global state shape declaration
}

interface WindowGlobals {
  state?: StateGlobal;
  loadWorkflow?: () => Promise<void>;
  loadLeadStatuses?: () => Promise<void>;
  __salesBoardBootstrapFailed?: { code: string | undefined; message: string } | undefined;
}

interface SalesBoardWindowData {
  state?: { contactStageCache?: Record<string, Room[]> };
  LEAD_STATUS_OPTIONS?: LeadStatusOption[];
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

const DEFAULT_STALENESS_DAYS = 28;
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

function columnForLeadStatus(
  ls: string,
  lsOptions: LeadStatusOption[],
): { column: string | null; terminal: boolean } {
  if (!ls) return { column: null, terminal: false };
  const opt = lsOptions.find((o) => o.value === ls) ?? null;
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

function buildEntriesForStage(
  contacts: PaginatedContact[],
  stageKey: string,
  contactStageCache: Record<string, Room[]>,
  lsOptions: LeadStatusOption[],
): BoardEntry[] {

  const entries: BoardEntry[] = [];
  for (const contact of contacts) {
    const ls = (contact.properties?.hs_lead_status || '').toUpperCase();

    const cached = contactStageCache[contact.id];
    const createdate = parseInt(contact.properties?.createdate || '0', 10);
    const lsOpt = ls ? lsOptions.find((o) => o.value === ls) : null;

    if (!cached || cached.length === 0) {
      entries.push({
        contact: contact as Contact, stageKey,
        substageId: ls || '',
        badgeLabel: lsOpt ? lsOpt.label : '',
        sourceId: '', createdate, stageTime: createdate, priority: 2,
      });
      continue;
    }

    let best: RoomWithIdx | null = null;
    let bestScore = Infinity;
    for (let idx = 0; idx < cached.length; idx++) {
      const r = cached[idx];
      if ((r.roomStatus || 'active') !== 'active') continue;
      if ((r.stageKey || 'sales') !== stageKey) continue;
      const score = priorityScore(stageKey, r.statusId || '');
      if (score < bestScore) { bestScore = score; best = { ...r, roomIdx: idx }; }
    }

    if (!best) {
      entries.push({
        contact: contact as Contact, stageKey,
        substageId: ls || '',
        badgeLabel: lsOpt ? lsOpt.label : '',
        sourceId: '', createdate, stageTime: createdate, priority: 2,
      });
      continue;
    }

    const statusId = best.statusId || '';
    const substageDate =
      statusId && best.substateDates?.[statusId]
        ? new Date(best.substateDates[statusId] + 'T00:00:00').getTime()
        : null;
    const stageEntryDate = best.stageDates?.[stageKey]
      ? new Date((best.stageDates as Record<string, string>)[stageKey] + 'T00:00:00').getTime()
      : null;

    entries.push({
      contact: contact as Contact, stageKey,
      substageId: statusId,
      badgeLabel: !statusId && lsOpt ? lsOpt.label : '',
      sourceId: best.sourceId || '',
      createdate,
      stageTime: substageDate || stageEntryDate || createdate,
      priority: priorityScore(stageKey, statusId),
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
  cardActionHandlerFor,
  resolveActionLabel,
  draftVisitId,
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
  draftVisitId?: number | string | null;
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

  const [lsAnchor, setLsAnchor] = useState<HTMLElement | null>(null);
  const [subAnchor, setSubAnchor] = useState<HTMLElement | null>(null);
  const [continuingDesign, setContinuingDesign] = useState(false);

  const stageStatuses: Array<{ id: string; label?: string }> =
    (workflow?.stages?.[stageKey]?.statuses as Array<{ id: string; label?: string }>) || [];

  // Resolve action handler and label
  const handler = cardActionHandlerFor(stageKey, leadStatusKey, hwSubstatusValue);

  const openContinueDesigning = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!draftVisitId || continuingDesign) return;
      setContinuingDesign(true);
      try {
        const resp = await fetch(`/api/design-visits/${encodeURIComponent(String(draftVisitId))}`);
        if (!resp.ok) throw new Error('Could not load visit');
        const visit: ExistingVisit = await resp.json();
        const dvHandler: CardActionHandlerData = handler && handler.type === 'start_design_visit'
          ? handler
          : { id: 0, type: 'start_design_visit', config: {} };
        openCardActionModal(dvHandler, {
          contactId:    contact.id,
          contactName:  name,
          contactEmail: contact.properties?.email || '',
        }, visit);
      } catch {
        // Silent failure — user can navigate to customer detail instead
      } finally {
        setContinuingDesign(false);
      }
    },
    [draftVisitId, continuingDesign, handler, contact, name],
  );
  const cahName = handler?.config?.action_name
    ? handler.config.action_name
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c: string) => c.toUpperCase())
    : '';
  const actionLabel = isTerminal
    ? ''
    : cahName || resolveActionLabel(stageKey, leadStatusKey, substageId, hwSubstatusValue);

  const actionTint = STAGE_TINT[stageKey] || '#f3f4f6';
  const actionTextColor = STAGE_ACTION_TEXT[stageKey] || '#374151';

  // Substage pill colours
  const pc = substagePillColour(stageKey, substageId);

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
                role: 'button' as const,
                tabIndex: -1,
                title: 'Run action',
                onClick: (e: React.MouseEvent) => {
                  e.preventDefault();
                  e.stopPropagation();
                  dispatchCardActionHandler(handler, {
                    contactId:    contact.id,
                    contactName:  name,
                    contactEmail: contact.properties?.email || '',
                  });
                },
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
      {/* Continue designing strip — shown when the card has a saved draft visit */}
      {!!draftVisitId && !isTerminal && (
        <Box
          role="button"
          tabIndex={-1}
          title="Continue designing"
          onClick={openContinueDesigning}
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            px: 1.5,
            py: 0.75,
            bgcolor: '#F0FDF4',
            borderTop: '1px solid',
            borderTopColor: 'divider',
            cursor: continuingDesign ? 'wait' : 'pointer',
            opacity: continuingDesign ? 0.7 : 1,
            transition: 'opacity 0.15s',
          }}
        >
          <Typography
            variant="caption"
            sx={{ color: '#15803d', fontWeight: 600, fontSize: '0.78rem' }}
          >
            {continuingDesign ? 'Opening…' : 'Continue designing'}
          </Typography>
          {continuingDesign ? (
            <CircularProgress size={12} sx={{ color: '#15803d' }} />
          ) : (
            <ChevronRightIcon sx={{ fontSize: 15, color: '#15803d', flexShrink: 0 }} />
          )}
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
        stageKey={stageKey}
        statuses={stageStatuses}
        currentSubId={substageId}
      />
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
  const { cardActionHandlerFor, resolveActionLabel } = useCardActionHandlers();
  const forceUpdate = useCallback(() => setTick((t) => t + 1), []);
  const { notifyApiError } = useConnectionToast();
  useConnectionCheck();

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
    const onFail = () => {
      setBgRefreshFailed(true);
      notifyApiError('hubspot', { code: 'HUBSPOT_UNAVAILABLE' });
    };
    document.addEventListener('sales-board-bg-refresh-failed', onFail);
    return () => document.removeEventListener('sales-board-bg-refresh-failed', onFail);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Bootstrap-failure error state — fires when core.js bootstrap() throws and
  // dispatches 'sales-board-bootstrap-failed' instead of writing to #sales-view
  // innerHTML (which would orphan this React tree).
  // Read the window flag synchronously as the initial value so the component
  // shows the error immediately even when the event fired before this chunk
  // finished loading (race condition: bootstrap can fail before React mounts).
  const [bootstrapFailed, setBootstrapFailed] = useState(
    () => !!(window as unknown as WindowGlobals).__salesBoardBootstrapFailed,
  );
  useEffect(() => {
    const onBootstrapFail = () => setBootstrapFailed(true);
    document.addEventListener('sales-board-bootstrap-failed', onBootstrapFail);
    return () => document.removeEventListener('sales-board-bootstrap-failed', onBootstrapFail);
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
    document.addEventListener('sales-board-cache-status', onCacheStatus);
    return () => document.removeEventListener('sales-board-cache-status', onCacheStatus);
  }, []);

  useEffect(() => {
    const onReady = () => {
      // Clear the window flag so a successful reload after a failure doesn't
      // immediately re-show the error on the next mount.
      (window as unknown as WindowGlobals).__salesBoardBootstrapFailed = undefined;
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

  // ── Page filter config — load sales staleness default and page size ────────
  const [configuredStalenessDays, setConfiguredStalenessDays] = useState<number>(DEFAULT_STALENESS_DAYS);
  const [salesPageSize, setSalesPageSize] = useState<number | undefined>(undefined);
  // staleAfterDays: undefined = use server default (chip on), 0 = disabled (chip dismissed)
  const [staleAfterDays, setStaleAfterDays] = useState<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/page-filter-config', { headers: { Accept: 'application/json' } })
      .then(r => r.ok ? r.json() : null)
      .then((cfg: { sales_staleness_days?: number; sales_page_size?: number } | null) => {
        if (cancelled || !cfg) return;
        const days = cfg.sales_staleness_days;
        if (typeof days === 'number' && days > 0) setConfiguredStalenessDays(days);
        const ps = cfg.sales_page_size;
        if (typeof ps === 'number' && ps > 0) setSalesPageSize(ps);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Active cutoff: when the chip is on, use the configured days; when dismissed, use 0 (no filter)
  const activeStaleDays = staleAfterDays !== undefined ? staleAfterDays : configuredStalenessDays;

  // ── usePaginatedContacts: one call per column ─────────────────────────────
  // The server filters contacts by stage so each column fetches only what it
  // needs. Room/substage data is still read from window.state.contactStageCache
  // (populated by the legacy JS bootstrap); tick is a useMemo dependency so
  // entry derivation re-runs when room data refreshes without forcing a refetch.
  const salesHook = usePaginatedContacts({
    initialPage: 1, leadStatus: '', substatus: '',
    stage: 'sales', sortBy: 'newest', search: '', showArchived: false,
    staleAfterDays: activeStaleDays,
    pageSize: salesPageSize,
  });
  const dvHook = usePaginatedContacts({
    initialPage: 1, leadStatus: '', substatus: '',
    stage: 'designvisit', sortBy: 'newest', search: '', showArchived: false,
  });

  const sbWindowData = window as unknown as SalesBoardWindowData;
  const contactStageCache = sbWindowData.state?.contactStageCache ?? {};
  const lsOptions = sbWindowData.LEAD_STATUS_OPTIONS ?? [];

  const salesEntries = useMemo(
    () => buildEntriesForStage(salesHook.contacts, 'sales', contactStageCache, lsOptions),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [salesHook.contacts, tick],
  );
  const dvEntries = useMemo(
    () => buildEntriesForStage(dvHook.contacts, 'designvisit', contactStageCache, lsOptions),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dvHook.contacts, tick],
  );

  // ── Draft visit detection ─────────────────────────────────────────────────
  // Batch-fetch in-progress (draft) design visit IDs for all currently visible
  // contacts so the "Continue designing" action can be shown on relevant cards.
  const [draftVisitIds, setDraftVisitIds] = useState<Record<string, number | string>>({});
  const [draftRefreshTick, setDraftRefreshTick] = useState(0);

  const allContacts = useMemo(
    () => [...salesHook.contacts, ...dvHook.contacts],
    [salesHook.contacts, dvHook.contacts],
  );

  useEffect(() => {
    if (allContacts.length === 0) return;
    let cancelled = false;
    const ids = allContacts.map((c) => c.id).join(',');
    fetch(`/api/design-visits/in-progress?contactIds=${encodeURIComponent(ids)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Array<{ id: number | string; contactId: string }>) => {
        if (cancelled) return;
        const map: Record<string, number | string> = {};
        for (const row of rows) map[row.contactId] = row.id;
        setDraftVisitIds(map);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [allContacts, draftRefreshTick]);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const bc = new BroadcastChannel('design_visit_draft_changed');
    bc.addEventListener('message', () => setDraftRefreshTick((t) => t + 1));
    return () => bc.close();
  }, []);

  const hookByStage = { sales: salesHook, designvisit: dvHook } as const;
  const entriesByStage = { sales: salesEntries, designvisit: dvEntries } as const;
  const pageLimitByStage = {
    sales: salesPageSize ?? PAGINATED_CONTACTS_PAGE_LIMIT,
    designvisit: PAGINATED_CONTACTS_PAGE_LIMIT,
  } as const;

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
        const hook = hookByStage[sk];
        const entries = entriesByStage[sk];
        const count = hook.total;
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

            {/* Staleness chip — only visible in the Sales column */}
            {sk === 'sales' && activeStaleDays > 0 && (
              <Box sx={{ px: 1.5, py: 0.75, borderBottom: '1px solid', borderBottomColor: 'divider', bgcolor: 'background.paper' }}>
                <Chip
                  label={`Modified ≤ ${activeStaleDays} days`}
                  size="small"
                  variant="outlined"
                  onDelete={() => setStaleAfterDays(0)}
                  sx={{ fontSize: '0.72rem', height: 22 }}
                />
              </Box>
            )}

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
              {hook.loading ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', pt: 4 }}>
                  <CircularProgress size={24} />
                </Box>
              ) : hook.error ? (
                <Alert severity="error" sx={{ m: 1 }}>{hook.error}</Alert>
              ) : entries.length === 0 ? (
                <Typography
                  variant="body2"
                  sx={{ color: 'text.secondary', textAlign: 'center', py: 6, opacity: 0.55 }}
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
                    cardActionHandlerFor={cardActionHandlerFor}
                    resolveActionLabel={resolveActionLabel}
                    draftVisitId={draftVisitIds[e.contact.id] ?? null}
                  />
                ))
              )}
              {!hook.loading && !hook.error && hook.total > 0 && (
                <Box sx={{ px: 0.5, pb: 1 }}>
                  <ContactsPagination
                    page={hook.page}
                    totalPages={hook.totalPages}
                    total={hook.total}
                    visibleCount={entries.length}
                    pageLimit={pageLimitByStage[sk]}
                    onPageChange={hook.setPage}
                  />
                </Box>
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
    </>
  );
}
