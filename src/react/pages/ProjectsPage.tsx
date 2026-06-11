import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PROJECTS_STALENESS_KEY, PROJECTS_SUBSTAGE_KEY } from '../constants/localStorageKeys';
import { subscribeContactAttemptLogged } from '../utils/broadcastContactAttempt';
import { subscribeUrgencyChanged } from '../utils/broadcastUrgencyChanged';
import {
  Alert,
  Avatar,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  List,
  ListItemButton,
  Popover,
  Skeleton,
  Snackbar,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import CheckIcon from '@mui/icons-material/Check';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import EditIcon from '@mui/icons-material/Edit';
import FilterListIcon from '@mui/icons-material/FilterList';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import { ContactEditModal } from './customer-detail/ContactEditModal';
import type { Contact } from './customer-detail/types';
import { useCardActionHandlers, CardActionHandlerData } from '../hooks/useCardActionHandlers';
import { PhotosReceivedBadge } from '../components/PhotosReceivedBadge';
import { dispatchCardActionHandler } from '../utils/dispatchCardActionHandler';
import { openCardActionModal } from '../utils/cardActionModalRegistry';
import type { ExistingVisit } from '../components/DesignVisitWizard';
import { BRAND_COLORS, RADIUS, STAGE_COLORS, STATUS_COLORS } from '../theme';
import { compactRelativeTime, latestTimestamp } from '../utils/formatters';
import { buildActivityTooltipContent } from '../utils/activityTooltip';
import { useNowTick } from '../hooks/useNowTick';
import { usePrivilege } from '../hooks/usePrivilege';
import { useDevMode } from '../hooks/useDevMode';
import { usePrefs } from '../hooks/usePrefs';
import { useQBInvoices } from '../hooks/useQBInvoices';
import { InvoiceDetailDrawer, formatCurrency as formatCurrencyShared } from '../components/InvoiceDetailDrawer';
import { PageFilterBar } from '../components/PageFilterBar';
import { StageTabGroup } from '../components/StageTabGroup';
import { SortSelect } from '../components/SortSelect';
import { useConnectionCheck, useConnectionToast } from '../context/ConnectionToastContext';
import { useProjectsData } from '../hooks/useProjectsData';
import { ProjectsPageSkeleton } from '../components/PageLoadingSkeleton';
import type {
  ProjectContact,
  ProjectRoom,
  ProjectPlatformUser,
  ProjectWorkflowDef,
} from '../hooks/useProjectsData';
import { usePageTitle } from '../hooks/usePageTitle';
import { UrgencyDot } from '../components/UrgencyDot';
import type { Urgency } from '../components/UrgencyDot';

// ── Constants ──────────────────────────────────────────────────────────────────

const STAGE_KEYS = [
  'sales', 'designvisit', 'survey', 'order', 'workshop',
  'packing', 'delivery', 'installation', 'aftercare',
] as const;

type StageKey = (typeof STAGE_KEYS)[number];

const STAGE_LABEL_FALLBACK: Record<string, string> = {
  sales: 'Sales',
  designvisit: 'Design Visit',
  survey: 'Survey',
  order: 'Order',
  workshop: 'Workshop',
  packing: 'Packing',
  delivery: 'Delivery',
  installation: 'Installation',
  aftercare: 'Aftercare',
};

// ── Filter-persistence helpers ─────────────────────────────────────────────────

const PROJECTS_STALENESS_DAYS = 30;

const STALENESS_STAGES = new Set(['sales', 'designvisit']);

function loadStalenessActive(): boolean {
  try {
    return localStorage.getItem(PROJECTS_STALENESS_KEY) === 'true';
  } catch {
    return false;
  }
}

function saveStalenessActive(active: boolean): void {
  try {
    localStorage.setItem(PROJECTS_STALENESS_KEY, String(active));
  } catch { /* ignore */ }
}

function loadHiddenSubstagesForStage(stageKey: string): Set<string> {
  try {
    const raw = localStorage.getItem(PROJECTS_SUBSTAGE_KEY);
    const parsed: Record<string, string[]> = raw ? JSON.parse(raw) : {};
    return new Set<string>(parsed[stageKey] || []);
  } catch {
    return new Set<string>();
  }
}

function saveHiddenSubstagesForStage(stageKey: string, hidden: Set<string>): void {
  try {
    const raw = localStorage.getItem(PROJECTS_SUBSTAGE_KEY);
    const parsed: Record<string, string[]> = raw ? JSON.parse(raw) : {};
    parsed[stageKey] = [...hidden];
    localStorage.setItem(PROJECTS_SUBSTAGE_KEY, JSON.stringify(parsed));
  } catch { /* ignore */ }
}

// ── Types ──────────────────────────────────────────────────────────────────────

type QBState = import('../hooks/useQBInvoices').QBInvoicesResult;

type SortKey = 'stage' | 'name' | 'date' | 'install';

// ── Pure helpers ───────────────────────────────────────────────────────────────

function getContactName(c: ProjectContact): string {
  const first = c.properties?.firstname || '';
  const last = c.properties?.lastname || '';
  const both = `${first} ${last}`.trim();
  if (both) return both;
  return c.properties?.email || `Contact ${c.id}`;
}

function getStageLabel(stageKey: string, workflow: ProjectWorkflowDef | undefined): string {
  return workflow?.stages?.[stageKey]?.label || STAGE_LABEL_FALLBACK[stageKey] || stageKey;
}

function getStageColor(stageKey: string) {
  return STAGE_COLORS[stageKey] || { bg: BRAND_COLORS.ink3, light: BRAND_COLORS.paper, text: BRAND_COLORS.ink2 };
}

function getFitterInitials(user: ProjectPlatformUser | null | undefined): string {
  if (!user) return '+';
  const parts = [user.firstName, user.lastName].filter(Boolean);
  if (parts.length) return parts.map((s) => s![0]).join('').toUpperCase();
  return (user.email || '?')[0].toUpperCase();
}

function fmtInstallDate(isoStr: string | null | undefined): string | null {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function formatCurrency(amount: number): string {
  return formatCurrencyShared(amount);
}

// ── Row computation ────────────────────────────────────────────────────────────

interface RoomWithIdx extends ProjectRoom {
  roomIdx: number;
}

interface ProjectRow {
  contact: ProjectContact;
  rooms: RoomWithIdx[];
}

function computeRows(
  contacts: ProjectContact[],
  stageCache: Record<string, ProjectRoom[]>,
  filter: string,
  sortBy: SortKey,
  currentUserId: string | undefined,
  stalenessActive?: boolean,
  stalenessDays?: number,
  hiddenSubstages?: Set<string>,
): ProjectRow[] {
  const myRooms = filter === '__mine__';
  const stageKey = myRooms ? '' : filter;

  // Pre-compute staleness cutoff
  const staleCutoffMs =
    stalenessActive && STALENESS_STAGES.has(stageKey)
      ? Date.now() - (stalenessDays ?? PROJECTS_STALENESS_DAYS) * 86400000
      : null;

  const rows: ProjectRow[] = [];

  for (const contact of contacts) {
    // Staleness filter: skip contacts recently modified when the filter is active
    if (staleCutoffMs !== null) {
      const lmd = contact.properties?.lastmodifieddate;
      const lmdMs = lmd ? new Date(lmd).getTime() : 0;
      if (lmdMs > staleCutoffMs) continue;
    }

    const cached = stageCache[contact.id];
    if (!cached || cached.length === 0) continue;

    const activeRooms: RoomWithIdx[] = cached
      .map((r, idx) => ({ ...r, roomIdx: idx }))
      .filter((r) => (r.roomStatus || 'active') === 'active')
      .filter((r) => !stageKey || r.stageKey === stageKey)
      .filter((r) => !myRooms || r.assignedFitterId === currentUserId)
      .filter((r) => {
        if (!stageKey || !hiddenSubstages?.size) return true;
        if (r.stageKey !== stageKey) return true;
        return !r.statusId || !hiddenSubstages.has(r.statusId);
      });

    if (!activeRooms.length) continue;
    rows.push({ contact, rooms: activeRooms });
  }

  const maxStageIdx = (row: ProjectRow) =>
    Math.max(...row.rooms.map((r) => STAGE_KEYS.indexOf((r.stageKey || '') as StageKey)));

  if (sortBy === 'name') {
    rows.sort((a, b) => getContactName(a.contact).localeCompare(getContactName(b.contact)));
  } else if (sortBy === 'date') {
    rows.sort((a, b) => {
      const da = parseInt(a.contact.properties?.closedate || '0', 10);
      const db = parseInt(b.contact.properties?.closedate || '0', 10);
      if (!da && !db) return getContactName(a.contact).localeCompare(getContactName(b.contact));
      if (!da) return 1;
      if (!db) return -1;
      return da - db;
    });
  } else if (sortBy === 'install') {
    const earliestInstall = (row: ProjectRow) => {
      const dates = row.rooms.map((r) => r.installStart).filter(Boolean).sort() as string[];
      return dates[0] || null;
    };
    rows.sort((a, b) => {
      const da = earliestInstall(a);
      const db = earliestInstall(b);
      if (!da && !db) return getContactName(a.contact).localeCompare(getContactName(b.contact));
      if (!da) return 1;
      if (!db) return -1;
      return da.localeCompare(db);
    });
  } else {
    rows.sort((a, b) => maxStageIdx(b) - maxStageIdx(a));
  }

  rows.forEach((row) =>
    row.rooms.sort(
      (a, b) =>
        STAGE_KEYS.indexOf((b.stageKey || '') as StageKey) -
        STAGE_KEYS.indexOf((a.stageKey || '') as StageKey),
    ),
  );

  return rows;
}

// ── FitterChip ─────────────────────────────────────────────────────────────────

function FitterChip({
  room,
  platformUsers,
  canAssign,
  onOpenPicker,
}: {
  room: RoomWithIdx;
  platformUsers: ProjectPlatformUser[];
  canAssign: boolean;
  onOpenPicker: (contactId: string, roomIdx: number, contactName: string) => void;
}) {
  const fitter = room.assignedFitterId
    ? platformUsers.find((u) => u.id === room.assignedFitterId) ?? null
    : null;
  const unknownAssigned = !!room.assignedFitterId && !fitter;
  const name = fitter
    ? `${fitter.firstName || ''} ${fitter.lastName || ''}`.trim() || fitter.email || 'Fitter'
    : unknownAssigned
    ? 'Assigned (unknown)'
    : 'Unassigned';
  const initials = getFitterInitials(fitter);

  const avatarEl = fitter?.profileImageUrl ? (
    <Avatar src={fitter.profileImageUrl} sx={{ width: 18, height: 18, fontSize: '0.6rem' }} />
  ) : (
    <Avatar
      sx={{
        width: 18,
        height: 18,
        fontSize: '0.6rem',
        fontWeight: 700,
        bgcolor: BRAND_COLORS.plum,
      }}
    >
      {initials}
    </Avatar>
  );

  const chipSx = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    background: BRAND_COLORS.paper,
    border: `1px solid ${BRAND_COLORS.stone}`,
    borderRadius: `${RADIUS.pill}px`,
    px: '8px',
    pl: '3px',
    py: '2px',
    fontSize: '0.72rem',
    fontWeight: 500,
    color: BRAND_COLORS.ink3,
    whiteSpace: 'nowrap',
    maxWidth: '120px',
    overflow: 'hidden',
    flexShrink: 0,
  };

  if (!canAssign) {
    return (
      <Box sx={chipSx}>
        {fitter && avatarEl}
        <Box
          component="span"
          sx={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontStyle: !fitter ? 'italic' : undefined,
            color: !fitter ? BRAND_COLORS.ink4 : undefined,
          }}
        >
          {name}
        </Box>
      </Box>
    );
  }

  return (
    <Box
      component="button"
      sx={{
        ...chipSx,
        cursor: 'pointer',
        transition: 'background 0.1s, border-color 0.1s',
        WebkitTapHighlightColor: 'transparent',
        fontFamily: 'inherit',
        '&:hover': { background: BRAND_COLORS.stone, borderColor: BRAND_COLORS.stoneDeep },
      }}
      title={fitter ? 'Reassign fitter' : 'Assign a fitter'}
      onClick={(e) => {
        e.stopPropagation();
        onOpenPicker(room.roomIdx.toString(), room.roomIdx, name);
      }}
    >
      {fitter && avatarEl}
      <Box
        component="span"
        sx={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontStyle: !fitter ? 'italic' : undefined,
          color: !fitter ? BRAND_COLORS.ink4 : undefined,
        }}
      >
        {name}
      </Box>
    </Box>
  );
}

// ── InvoiceBadge ───────────────────────────────────────────────────────────────

function InvoiceBadge({
  contact,
  qb,
  onOpen,
}: {
  contact: ProjectContact;
  qb: QBState | undefined;
  onOpen: (firstId: string, allIds: string[]) => void;
}) {
  if (!qb) return null;

  if (!qb.statusKnown || qb.loading || (qb.connected && !qb.loaded)) {
    return (
      <Box
        sx={{
          px: '14px',
          py: '10px',
          borderTop: `1px solid ${BRAND_COLORS.stone}`,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          minHeight: 36,
          pointerEvents: 'none',
        }}
      >
        <Skeleton variant="rounded" width={72} height={20} />
        <Skeleton variant="rounded" width={48} height={20} />
      </Box>
    );
  }

  if (!qb.connected) return null;

  const contactEmail = (contact.properties?.email || '').toLowerCase().trim();
  const contactNameStr = getContactName(contact).toLowerCase().trim();
  const invs = (qb.invoices || []).filter(inv => {
    const invEmail    = (inv.email        || '').toLowerCase().trim();
    const invCustomer = (inv.customerName || '').toLowerCase().trim();
    if (contactEmail && invEmail    && contactEmail    === invEmail)    return true;
    if (contactNameStr && invCustomer && invCustomer === contactNameStr) return true;
    return false;
  });
  if (!invs.length) return null;

  const total = invs.reduce((s, inv) => s + inv.balance, 0);
  const count = invs.length;
  const invIds = invs.map((i) => i.id);

  return (
    <Box sx={{ px: '14px', py: '10px', borderTop: `1px solid ${BRAND_COLORS.stone}`, display: 'flex', alignItems: 'center', gap: 1, minHeight: 36 }}>
      <button
        onClick={() => onOpen(invIds[0], invIds)}
        title={`${count} outstanding invoice${count !== 1 ? 's' : ''}`}
        style={{
          display: 'inline-flex', alignItems: 'center',
          fontSize: '0.68rem', fontWeight: 700,
          fontFamily: 'inherit',
          padding: '2px 7px', borderRadius: '999px',
          background: STATUS_COLORS.warning.bg, color: STATUS_COLORS.warning.text,
          border: `1px solid ${STATUS_COLORS.warningActive.bg}`,
          whiteSpace: 'nowrap',
          cursor: 'pointer',
          lineHeight: 1.4,
        }}
      >
        {formatCurrency(total)}
      </button>
    </Box>
  );
}

// ── ProjectCard ────────────────────────────────────────────────────────────────

function ProjectCard({
  contact,
  rooms,
  platformUsers,
  canAssign,
  canEdit,
  workflow,
  qb,
  urgency,
  lastAttempt,
  cardActionHandlerFor,
  resolveActionLabel,
  draftVisitId,
  onOpenFitterPicker,
  onNavigate,
  onOpenInvoice,
  onOpenEdit,
}: {
  contact: ProjectContact;
  rooms: RoomWithIdx[];
  platformUsers: ProjectPlatformUser[];
  canAssign: boolean;
  canEdit: boolean;
  workflow: ProjectWorkflowDef | undefined;
  qb?: QBState;
  urgency: Urgency;
  lastAttempt?: { at: string; by: string | null; count: number; method: string | null; methodCounts?: Record<string, number> | null } | null;
  cardActionHandlerFor: (
    stageKey: string,
    leadStatusKey: string | undefined,
  ) => CardActionHandlerData | null;
  resolveActionLabel: (
    stageKey: string,
    leadStatusKey: string | undefined,
    substageId: string | undefined,
  ) => string;
  draftVisitId?: number | string | null;
  onOpenFitterPicker: (contactId: string, roomIdx: number) => void;
  onNavigate: (contactId: string, roomIdx: number) => void;
  onOpenInvoice: (firstId: string, allIds: string[]) => void;
  onOpenEdit: (contactId: string) => void;
}) {
  const name = getContactName(contact);
  const earliestInstall =
    rooms.map((r) => r.installStart).filter(Boolean).sort()[0] ?? null;
  const installLabel = fmtInstallDate(earliestInstall);

  // ── Action strip state ─────────────────────────────────────────────────────
  const now = useNowTick();
  const [dispatchingAction, setDispatchingAction] = useState(false);

  // Pick the primary stage from the first room (rooms sorted by stage desc).
  const primaryStageKey = rooms[0]?.stageKey || '';
  const leadStatusKey = contact.properties?.hs_lead_status;

  // Only show a strip when a matching handler is actually configured.
  const handler = cardActionHandlerFor(primaryStageKey, leadStatusKey);

  const cahName = handler?.config?.action_name
    ? handler.config.action_name
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c: string) => c.toUpperCase())
    : '';
  // When there's a draft visit and the handler is start_design_visit, prefer
  // "Continue designing" as the label (unless the admin configured a custom name).
  const isDesignHandler = handler?.type === 'start_design_visit';
  const hasDraft = !!draftVisitId && isDesignHandler;
  const actionLabel = cahName
    || (hasDraft ? 'Continue designing' : '')
    || resolveActionLabel(primaryStageKey, leadStatusKey, undefined);

  const stageColors = STAGE_COLORS[primaryStageKey];
  const actionTint = hasDraft ? '#F0FDF4' : (stageColors?.light || '#f3f4f6');
  const actionTextColor = hasDraft ? '#15803d' : (stageColors?.text || '#374151');

  const activityTs = latestTimestamp(lastAttempt?.at, contact.properties?.notes_last_contacted);
  const activityCounter = (!dispatchingAction && actionLabel && activityTs)
    ? compactRelativeTime(activityTs, now)
    : null;

  // Unified dispatch: preloads the draft visit when handler is start_design_visit
  // and a draft exists; otherwise dispatches normally.
  const handleActionClick = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!handler || dispatchingAction) return;
      if (hasDraft && draftVisitId) {
        setDispatchingAction(true);
        try {
          const resp = await fetch(`/api/design-visits/${encodeURIComponent(String(draftVisitId))}`);
          if (!resp.ok) throw new Error('Could not load visit');
          const visit: ExistingVisit = await resp.json();
          openCardActionModal(handler, {
            contactId:    contact.id,
            contactName:  name,
            contactEmail: contact.properties?.email || '',
          }, visit);
        } catch {
          // Silent failure — user can navigate to customer detail instead
        } finally {
          setDispatchingAction(false);
        }
      } else {
        dispatchCardActionHandler(handler, {
          contactId:    contact.id,
          contactName:  name,
          contactEmail: contact.properties?.email || '',
        });
      }
    },
    [handler, hasDraft, draftVisitId, dispatchingAction, contact, name],
  );

  return (
    <Box
      sx={{
        background: BRAND_COLORS.paper,
        border: `1px solid ${BRAND_COLORS.stone}`,
        borderRadius: `${RADIUS.lg}px`,
        boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
        overflow: 'hidden',
      }}
    >
      {/* Card header */}
      <Box sx={{ p: '12px 14px 10px', borderBottom: `1px solid ${BRAND_COLORS.stone}` }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
          <UrgencyDot urgency={urgency} />
          <Typography
            sx={{
              fontSize: '0.975rem',
              fontWeight: 700,
              color: BRAND_COLORS.ink1,
              lineHeight: 1.25,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              flex: 1,
              minWidth: 0,
            }}
          >
            {name}
          </Typography>
          {canEdit && (
            <IconButton
              size="small"
              aria-label="Edit contact name"
              title="Edit contact"
              onClick={(e) => { e.stopPropagation(); onOpenEdit(contact.id); }}
              sx={{
                flexShrink: 0,
                p: '3px',
                color: BRAND_COLORS.ink4,
                '&:hover': { color: BRAND_COLORS.ink2, background: BRAND_COLORS.stone },
              }}
            >
              <EditIcon sx={{ fontSize: 14 }} />
            </IconButton>
          )}
          {installLabel && (
            <Typography
              sx={{
                fontSize: '0.68rem',
                fontWeight: 600,
                color: BRAND_COLORS.ink3,
                whiteSpace: 'nowrap',
                letterSpacing: '0.01em',
                flexShrink: 0,
              }}
            >
              Install: {installLabel}
            </Typography>
          )}
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: '2px', flexWrap: 'wrap' }}>
          <Typography sx={{ fontSize: '0.72rem', fontWeight: 500, color: BRAND_COLORS.ink4, letterSpacing: '0.02em' }}>
            #{contact.id}
          </Typography>
          {contact._statusUnknown && (
            <Box
              component="span"
              title="This contact's HubSpot lead status is missing or not configured in the pipeline. Check HubSpot or the Lead Status admin settings."
              sx={{
                fontSize: '0.62rem',
                fontWeight: 700,
                px: '6px',
                py: '1px',
                borderRadius: '999px',
                background: STATUS_COLORS.warning.bg,
                color: STATUS_COLORS.warning.text,
                border: `1px solid ${STATUS_COLORS.warningActive.bg}`,
                letterSpacing: '0.02em',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              Unknown status
            </Box>
          )}
          <PhotosReceivedBadge leadStatus={leadStatusKey} />
        </Box>
      </Box>

      {/* Room rows */}
      <Box sx={{ display: 'flex', flexDirection: 'column' }}>
        {rooms.map((room, i) => {
          const colour = getStageColor(room.stageKey || '');
          const stageLabel = getStageLabel(room.stageKey || '', workflow);
          const roomLabel = room.room || 'Main';
          const isLast = i === rooms.length - 1;

          return (
            <Box
              key={room.roomIdx}
              onClick={() => onNavigate(contact.id, room.roomIdx)}
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '10px',
                p: '9px 14px',
                cursor: 'pointer',
                transition: 'background 0.1s',
                WebkitTapHighlightColor: 'transparent',
                borderBottom: isLast ? 'none' : `1px solid ${BRAND_COLORS.stone}`,
                '&:hover': { background: 'rgba(0,0,0,0.03)' },
                '&:active': { background: BRAND_COLORS.stone },
              }}
            >
              <Typography
                sx={{
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  color: BRAND_COLORS.ink2,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {roomLabel}
              </Typography>
              <FitterChip
                room={room}
                platformUsers={platformUsers}
                canAssign={canAssign}
                onOpenPicker={(_cid, _rIdx) => onOpenFitterPicker(contact.id, room.roomIdx)}
              />
              <Box
                component="span"
                sx={{
                  fontSize: '0.72rem',
                  fontWeight: 700,
                  px: '8px',
                  py: '2px',
                  borderRadius: '999px',
                  background: colour.light,
                  color: colour.text,
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                {stageLabel}
              </Box>
            </Box>
          );
        })}
      </Box>

      {/* Action strip — rendered when either a handler is configured for this card's
          stage/lead-status/substatus, OR a label-only row is set for the stage in
          Card Actions. When a handler is present, clicking fires it; when handler is
          start_design_visit and a draft visit exists, the strip doubles as "Continue
          designing". A label-only strip (no handler) is non-interactive and shows no
          chevron. */}
      {(!!handler || !!actionLabel) && (
        <Box
          role={handler ? 'button' : undefined}
          tabIndex={handler ? -1 : undefined}
          title={handler ? (actionLabel || 'Run action') : undefined}
          onClick={handler ? handleActionClick : undefined}
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            px: '14px',
            py: '9px',
            bgcolor: actionTint,
            borderTop: `1px solid ${BRAND_COLORS.stone}`,
            cursor: handler ? (dispatchingAction ? 'wait' : 'pointer') : 'default',
            opacity: dispatchingAction ? 0.7 : 1,
            transition: 'opacity 0.15s, filter 0.12s',
            '&:hover': (handler && !dispatchingAction) ? { filter: 'brightness(0.96)' } : undefined,
          }}
        >
          <Typography sx={{ color: actionTextColor, fontWeight: 600, fontSize: '0.78rem' }}>
            {dispatchingAction ? 'Opening…' : (
              <>
                {activityCounter && (
                  <Tooltip
                    title={buildActivityTooltipContent(lastAttempt ?? null, contact.properties?.notes_last_contacted)}
                    arrow
                    placement="bottom"
                    enterDelay={200}
                  >
                    <Box
                      component="span"
                      sx={{ fontWeight: 500, opacity: 0.6, mr: '4px' }}
                    >
                      {activityCounter} ·
                    </Box>
                  </Tooltip>
                )}
                {actionLabel}
              </>
            )}
          </Typography>
          {handler && (dispatchingAction ? (
            <CircularProgress size={12} sx={{ color: actionTextColor }} />
          ) : (
            <ChevronRightIcon sx={{ fontSize: 15, color: actionTextColor, flexShrink: 0 }} />
          ))}
        </Box>
      )}

      {/* Invoice badge */}
      <InvoiceBadge contact={contact} qb={qb} onOpen={onOpenInvoice} />
    </Box>
  );
}

// ── FitterPickerDialog ─────────────────────────────────────────────────────────

function FitterPickerDialog({
  open,
  onClose,
  contactId,
  roomIdx,
  platformUsers,
  currentFitterId,
  onAssign,
}: {
  open: boolean;
  onClose: () => void;
  contactId: string;
  roomIdx: number;
  platformUsers: ProjectPlatformUser[];
  currentFitterId: string | null | undefined;
  onAssign: (contactId: string, roomIdx: number, fitterId: string | null) => void;
}) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="xs"
      slotProps={{
        paper: {
          sx: isMobile
            ? {
                position: 'fixed',
                bottom: 0,
                left: 0,
                right: 0,
                m: 0,
                borderRadius: '18px 18px 0 0',
                maxHeight: '70vh',
              }
            : { borderRadius: 2 },
        },
      }}
    >
      <DialogTitle
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          pb: 1,
          fontWeight: 700,
        }}
      >
        Assign fitter
        <IconButton size="small" onClick={onClose} aria-label="Close">
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <Divider />
      <DialogContent sx={{ p: 0, overflowY: 'auto' }}>
        <List disablePadding>
          {platformUsers.length === 0 && (
            <Box sx={{ p: 3, textAlign: 'center', color: BRAND_COLORS.ink4, fontSize: '0.875rem' }}>
              No team members found.
            </Box>
          )}
          {platformUsers.map((u) => {
            const fullName = `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email || 'Unknown';
            const initials = getFitterInitials(u);
            const isSelected = u.id === currentFitterId;
            return (
              <ListItemButton
                key={u.id}
                selected={isSelected}
                onClick={() => onAssign(contactId, roomIdx, u.id)}
                sx={{ gap: 1.5, px: 2, py: 1.25 }}
              >
                {u.profileImageUrl ? (
                  <Avatar src={u.profileImageUrl} sx={{ width: 36, height: 36 }} />
                ) : (
                  <Avatar sx={{ width: 36, height: 36, bgcolor: BRAND_COLORS.plum, fontSize: '0.85rem', fontWeight: 700 }}>
                    {initials}
                  </Avatar>
                )}
                <Typography sx={{ flex: 1, fontWeight: isSelected ? 700 : 400 }}>{fullName}</Typography>
                {isSelected && <CheckIcon fontSize="small" sx={{ color: BRAND_COLORS.plum }} />}
              </ListItemButton>
            );
          })}
          {currentFitterId && (
            <>
              <Divider />
              <ListItemButton
                onClick={() => onAssign(contactId, roomIdx, null)}
                sx={{ px: 2, py: 1.25, color: BRAND_COLORS.ink3, fontSize: '0.875rem' }}
              >
                Remove assignment
              </ListItemButton>
            </>
          )}
        </List>
      </DialogContent>
    </Dialog>
  );
}

// ── Empty state ────────────────────────────────────────────────────────────────

function EmptyState({ message }: { message: string }) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        py: 8,
        px: 3,
        textAlign: 'center',
        color: BRAND_COLORS.ink4,
      }}
    >
      <PersonAddIcon sx={{ fontSize: 48, mb: 2, opacity: 0.35 }} />
      <Typography sx={{ fontSize: '0.9rem', color: BRAND_COLORS.ink4 }}>{message}</Typography>
    </Box>
  );
}

// ── ProjectsPage ───────────────────────────────────────────────────────────────

export function ProjectsPage() {
  usePageTitle('Projects · Measure Once');
  const { isAdmin, isManager } = usePrivilege();
  const { devMode } = useDevMode({ enabled: isAdmin });
  const canAssign = isManager || isAdmin;
  const { notifyApiError } = useConnectionToast();
  useConnectionCheck();

  const {
    loading,
    error,
    contacts,
    stageCache,
    workflow,
    platformUsers,
    currentUserId,
    roomAssignmentsStale,
    draftVisitIds,
    updateRoomAssignment,
    updateContactProperties,
  } = useProjectsData();

  const { cardActionHandlerFor, resolveActionLabel } = useCardActionHandlers();

  const [filter, setFilter] = useState<string>('');
  const [sortBy, setSortBy] = useState<SortKey>('stage');
  const [groupBy, setGroupBy] = useState(false);
  const [staleDismissed, setStaleDismissed] = useState(false);
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(null);

  // ── Staleness filter ──────────────────────────────────────────────────────
  const [stalenessActive, setStalenessActive] = useState<boolean>(loadStalenessActive);

  // ── Substage filter ───────────────────────────────────────────────────────
  const [hiddenSubstages, setHiddenSubstages] = useState<Set<string>>(new Set());
  const [substageFilterAnchor, setSubstageFilterAnchor] = useState<HTMLElement | null>(null);

  // ── Room-assignments stale banner (DOM-managed, mirrors open-leads approach) ─
  // Creates / removes #room-stale-banner imperatively so no per-page HTML markup
  // is required and any page that runs this effect gets the banner automatically.
  useEffect(() => {
    const BANNER_ID = 'room-stale-banner';
    if (roomAssignmentsStale && !staleDismissed) {
      if (!document.getElementById(BANNER_ID)) {
        const el = document.createElement('div');
        el.id = BANNER_ID;
        el.className = 'room-stale-banner';
        el.setAttribute('role', 'alert');
        const span = document.createElement('span');
        span.textContent = 'Room data may be out of date \u2014 showing last cached assignments';
        const btn = document.createElement('button');
        btn.className = 'room-stale-banner-dismiss';
        btn.setAttribute('aria-label', 'dismiss stale banner');
        btn.textContent = '\u00d7';
        btn.addEventListener('click', () => setStaleDismissed(true));
        el.appendChild(span);
        el.appendChild(btn);
        document.body.appendChild(el);
      }
    } else {
      document.getElementById(BANNER_ID)?.remove();
    }
    return () => {
      document.getElementById(BANNER_ID)?.remove();
    };
  }, [roomAssignmentsStale, staleDismissed]);

  // Fitter picker state
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerContactId, setPickerContactId] = useState('');
  const [pickerRoomIdx, setPickerRoomIdx] = useState(0);
  const [pickerAssigning, setPickerAssigning] = useState(false);

  // Invoice drawer state
  const [invDrawerOpen, setInvDrawerOpen]   = useState(false);
  const [invDrawerInvId, setInvDrawerInvId] = useState<string | null>(null);
  const [invDrawerAllIds, setInvDrawerAllIds] = useState<string[]>([]);

  const handleOpenInvoice = useCallback((firstId: string, allIds: string[]) => {
    setInvDrawerInvId(firstId);
    setInvDrawerAllIds(allIds);
    setInvDrawerOpen(true);
  }, []);

  // Contact edit modal state — holds the full contact fetched from the API.
  // We fetch on demand so the modal always shows up-to-date values and the
  // PATCH sends all fields (not just the subset stored in ProjectContact).
  const [editContactData, setEditContactData] = useState<Contact | null>(null);

  const handleOpenEdit = useCallback(async (contactId: string) => {
    try {
      const res = await fetch(`/api/contacts/${encodeURIComponent(contactId)}`, {
        headers: { Accept: 'application/json' },
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as Contact;
      setEditContactData(data);
    } catch {
      setToast({ msg: 'Could not load contact details', error: true });
    }
  }, []);

  const handleContactSaved = useCallback((updated: Contact) => {
    updateContactProperties(updated.id, {
      firstname: updated.properties.firstname,
      lastname:  updated.properties.lastname,
      email:     updated.properties.email,
      zip:       updated.properties.zip,
    });
    setEditContactData(null);
  }, [updateContactProperties]);

  const qb = useQBInvoices();
  useEffect(() => { qb.triggerLoad(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Urgency map + last-attempt map ────────────────────────────────────────
  const [urgencyMap, setUrgencyMap] = useState<Record<string, Urgency>>({});
  type LastAttemptEntry = { at: string; by: string | null; count: number; method: string | null; methodCounts?: Record<string, number> | null } | null;
  const [lastAttemptMap, setLastAttemptMap] = useState<Record<string, LastAttemptEntry>>({});

  useEffect(() => {
    if (!contacts.length) return;
    let cancelled = false;
    const ids = contacts.map((c) => c.id).filter((id) => !(id in urgencyMap));
    if (!ids.length) return;
    (async () => {
      let urgencyById: Record<string, Urgency> = {};
      let lastAttemptById: Record<string, LastAttemptEntry> = {};
      try {
        const res = await fetch('/api/contacts/urgency', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        });
        if (res.ok) {
          const data = (await res.json()) as { urgency?: Record<string, Urgency>; lastAttempt?: Record<string, LastAttemptEntry> };
          urgencyById = data.urgency || {};
          lastAttemptById = data.lastAttempt || {};
        }
      } catch {
        /* fall through; ids marked null below */
      }
      if (cancelled) return;
      setUrgencyMap((prev) => {
        const next = { ...prev };
        for (const id of ids) {
          next[id] = id in urgencyById ? urgencyById[id] : null;
        }
        return next;
      });
      setLastAttemptMap((prev) => {
        const next = { ...prev };
        for (const id of ids) {
          next[id] = id in lastAttemptById ? lastAttemptById[id] : null;
        }
        return next;
      });
    })();
    return () => { cancelled = true; };
  }, [contacts]); // eslint-disable-line react-hooks/exhaustive-deps

  // Shared helper: re-fetch urgency + lastAttempt for a given list of contact
  // IDs and merge into the maps.  Pass null to re-fetch all currently tracked.
  const refetchUrgencyForIds = useCallback(async (ids: string[] | null) => {
    const targetIds = ids ?? Object.keys(urgencyMap);
    if (!targetIds.length) return;
    try {
      const res = await fetch('/api/contacts/urgency', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: targetIds }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { urgency?: Record<string, Urgency>; lastAttempt?: Record<string, LastAttemptEntry> };
      const urgencyById = data.urgency || {};
      const lastAttemptById = data.lastAttempt || {};
      setUrgencyMap((prev) => {
        const next = { ...prev };
        for (const id of targetIds) {
          next[id] = id in urgencyById ? urgencyById[id] : null;
        }
        return next;
      });
      setLastAttemptMap((prev) => {
        const next = { ...prev };
        for (const id of targetIds) {
          next[id] = id in lastAttemptById ? lastAttemptById[id] : null;
        }
        return next;
      });
    } catch {
      /* best-effort — stale data is fine on failure */
    }
  }, [urgencyMap]); // eslint-disable-line react-hooks/exhaustive-deps

  // After the Contact Customer modal closes, re-fetch urgency for just that
  // contact so the board card's dot updates without a full reload.
  useEffect(() => {
    return subscribeContactAttemptLogged(({ contactId }) => {
      refetchUrgencyForIds([contactId]);
    });
  }, [refetchUrgencyForIds]);

  // Re-fetch urgency for all visible contacts when:
  //   (a) the tab regains focus (covers task completions done in another tab), or
  //   (b) a cross-tab `urgency_changed` message fires (explicit broadcast from
  //       any flow that modifies HubSpot tasks without going through the Contact
  //       Customer modal — e.g. CustomerDetailPage task actions).
  //       Payload may include { contactId } to target a single contact.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refetchUrgencyForIds(null);
    };
    document.addEventListener('visibilitychange', onVisibility);

    const unsubscribeUrgency = subscribeUrgencyChanged(({ contactId }) => {
      if (contactId) {
        refetchUrgencyForIds([contactId]);
      } else {
        refetchUrgencyForIds(null);
      }
    });

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      unsubscribeUrgency();
    };
  }, [refetchUrgencyForIds]);

  const { prefs, loading: prefsLoading, patchPref } = usePrefs();

  // ── Apply prefs once they have loaded ──────────────────────────────────────
  const prefAppliedRef = useRef(false);
  useEffect(() => {
    if (prefsLoading || prefAppliedRef.current) return;
    prefAppliedRef.current = true;
    if (prefs.projectSort) setSortBy(prefs.projectSort as SortKey);
    if (prefs.projectGroupByStage != null) setGroupBy(!!prefs.projectGroupByStage);
  }, [prefsLoading, prefs]);


  // ── Load hidden substages from localStorage when stage filter changes ──────
  useEffect(() => {
    if (filter && filter !== '__mine__') {
      setHiddenSubstages(loadHiddenSubstagesForStage(filter));
    } else {
      setHiddenSubstages(new Set());
    }
    setSubstageFilterAnchor(null);
  }, [filter]);

  const myRooms = filter === '__mine__';
  const stageKeyFilter = myRooms ? '' : filter;
  const groupingEnabled = groupBy && !stageKeyFilter && !myRooms;

  // ── Available substages for the active stage ──────────────────────────────
  const availableSubstages = useMemo(() => {
    if (!filter || filter === '__mine__') return [];
    const stage = workflow?.stages?.[filter];
    return (stage?.statuses || []) as Array<{ id: string; label: string }>;
  }, [filter, workflow]);

  const rows = useMemo(
    () => computeRows(contacts, stageCache, filter, sortBy, currentUserId, stalenessActive, PROJECTS_STALENESS_DAYS, hiddenSubstages),
    [contacts, stageCache, filter, sortBy, currentUserId, stalenessActive, hiddenSubstages],
  );

  // ── Unknown-status banner ──────────────────────────────────────────────────
  // Count contacts with room data whose hs_lead_status is absent or not in
  // config.  A dismissible amber banner lets the team know without hiding cards.
  const [unknownStatusDismissed, setUnknownStatusDismissed] = useState(false);
  const unknownStatusCount = useMemo(
    () => contacts.filter((c) => c._statusUnknown && stageCache[c.id]?.length).length,
    [contacts, stageCache],
  );

  // ── Stage tabs ─────────────────────────────────────────────────────────────
  const stageTabs = useMemo(() => {
    const tabs: Array<{ key: string; label: string }> = [
      { key: '', label: 'All' },
      { key: '__mine__', label: 'My rooms' },
      ...STAGE_KEYS.map((k) => ({ key: k, label: getStageLabel(k, workflow) })),
    ];
    return tabs;
  }, [workflow]);

  const handleSortChange = useCallback(
    (val: SortKey) => {
      setSortBy(val);
      void patchPref('projectSort', val);
    },
    [patchPref],
  );

  const handleGroupToggle = useCallback(() => {
    const next = !groupBy;
    setGroupBy(next);
    void patchPref('projectGroupByStage', next);
  }, [groupBy, patchPref]);

  const handleStalenessToggle = useCallback(() => {
    const next = !stalenessActive;
    setStalenessActive(next);
    saveStalenessActive(next);
  }, [stalenessActive]);

  const toggleSubstage = useCallback((id: string) => {
    setHiddenSubstages((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      if (filter && filter !== '__mine__') {
        saveHiddenSubstagesForStage(filter, next);
      }
      return next;
    });
  }, [filter]);

  // ── Fitter picker ──────────────────────────────────────────────────────────
  const handleOpenPicker = useCallback((contactId: string, roomIdx: number) => {
    setPickerContactId(contactId);
    setPickerRoomIdx(roomIdx);
    setPickerOpen(true);
  }, []);

  const handleClosePicker = useCallback(() => {
    setPickerOpen(false);
  }, []);

  const handleAssignFitter = useCallback(
    async (contactId: string, roomIdx: number, fitterId: string | null) => {
      setPickerOpen(false);
      setPickerAssigning(true);
      try {
        const r = await fetch(`/api/contacts/${contactId}/rooms/${roomIdx}/fitter`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ fitterId: fitterId || null }),
        });
        if (r.status === 401) { window.location.href = '/login'; return; }
        const result = (await r.json().catch(() => ({}))) as { syncFailed?: boolean; error?: string; code?: string };
        if (!r.ok) {
          const err = Object.assign(new Error(result.error || `HTTP ${r.status}`), { code: result.code });
          throw err;
        }

        updateRoomAssignment(contactId, roomIdx, fitterId);

        const baseMsg = fitterId ? 'Fitter assigned' : 'Assignment removed';
        if (result?.syncFailed) {
          setToast({ msg: `${baseMsg} — HubSpot sync failed, CRM may be out of date`, error: true });
        } else {
          setToast({ msg: baseMsg });
        }
      } catch (e: unknown) {
        notifyApiError('hubspot', e);
        const code = (e as { code?: string }).code;
        if (code === 'HUBSPOT_AUTH') {
          setToast({ msg: 'Could not save assignment — HubSpot token is invalid or expired. Ask an admin to update the token.', error: true });
        } else if (code === 'HUBSPOT_RATE_LIMIT') {
          setToast({ msg: 'Could not save assignment — HubSpot rate limit reached. Please try again in a moment.', error: true });
        } else {
          setToast({ msg: 'Failed to save assignment', error: true });
        }
      } finally {
        setPickerAssigning(false);
      }
    },
    [updateRoomAssignment, notifyApiError],
  );

  // Current fitter for the open picker
  const pickerCurrentFitter =
    (pickerContactId && stageCache[pickerContactId]?.[pickerRoomIdx]?.assignedFitterId) ?? null;

  // ── Navigate to project ────────────────────────────────────────────────────
  const handleNavigate = useCallback((contactId: string, roomIdx: number) => {
    const idx = roomIdx || 0;
    window.location.href = idx ? `/customers/${contactId}?room=${idx}` : `/customers/${contactId}`;
  }, []);

  // ── Loading / error states ─────────────────────────────────────────────────
  if (loading) {
    return <ProjectsPageSkeleton />;
  }

  if (error) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => window.location.reload()}>
              Retry
            </Button>
          }
        >
          {error}
        </Alert>
      </Box>
    );
  }

  // ── Render groups ──────────────────────────────────────────────────────────
  const renderCards = () => {
    if (!rows.length) {
      return (
        <EmptyState
          message={myRooms ? 'No rooms are currently assigned to you.' : 'No projects at this stage.'}
        />
      );
    }

    if (groupingEnabled) {
      const groups = new Map<string, ProjectRow[]>();
      for (const row of rows) {
        const idx = Math.max(...row.rooms.map((r) => STAGE_KEYS.indexOf((r.stageKey || '') as StageKey)));
        const key = idx >= 0 ? STAGE_KEYS[idx] : (row.rooms[0]?.stageKey || '');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(row);
      }
      const orderedKeys =
        sortBy === 'stage'
          ? [...groups.keys()].sort(
              (a, b) =>
                STAGE_KEYS.indexOf(b as StageKey) - STAGE_KEYS.indexOf(a as StageKey),
            )
          : [...groups.keys()];

      return (
        <>
          {orderedKeys.map((key) => {
            const colour = getStageColor(key);
            const label = getStageLabel(key, workflow);
            const groupRows = groups.get(key)!;
            return (
              <React.Fragment key={key}>
                {/* Group heading — spans full width */}
                <Box
                  sx={{
                    gridColumn: '1 / -1',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    p: '4px 0 2px 10px',
                    borderLeft: `3px solid ${colour.bg}`,
                    mt: 1,
                    '&:first-of-type': { mt: 0 },
                  }}
                >
                  <Box
                    component="span"
                    sx={{
                      fontSize: '0.72rem',
                      fontWeight: 700,
                      letterSpacing: '0.04em',
                      textTransform: 'uppercase',
                      px: '8px',
                      py: '2px',
                      borderRadius: '999px',
                      background: colour.light,
                      color: colour.text,
                    }}
                  >
                    {label}
                  </Box>
                  <Box component="span" sx={{ fontSize: '0.72rem', fontWeight: 600, color: BRAND_COLORS.ink4 }}>
                    {groupRows.length}
                  </Box>
                </Box>
                {groupRows.map(({ contact, rooms }) => (
                  <ProjectCard
                    key={contact.id}
                    contact={contact}
                    rooms={rooms}
                    platformUsers={platformUsers}
                    canAssign={canAssign}
                    canEdit={canAssign}
                    workflow={workflow}
                    qb={qb}
                    urgency={urgencyMap[contact.id] ?? null}
                    lastAttempt={lastAttemptMap[contact.id] ?? null}
                    cardActionHandlerFor={cardActionHandlerFor}
                    resolveActionLabel={resolveActionLabel}
                    draftVisitId={draftVisitIds[contact.id] ?? null}
                    onOpenFitterPicker={handleOpenPicker}
                    onNavigate={handleNavigate}
                    onOpenInvoice={handleOpenInvoice}
                    onOpenEdit={handleOpenEdit}
                  />
                ))}
              </React.Fragment>
            );
          })}
        </>
      );
    }

    return (
      <>
        {rows.map(({ contact, rooms }) => (
          <ProjectCard
            key={contact.id}
            contact={contact}
            rooms={rooms}
            platformUsers={platformUsers}
            canAssign={canAssign}
            canEdit={canAssign}
            workflow={workflow}
            qb={qb}
            urgency={urgencyMap[contact.id] ?? null}
            lastAttempt={lastAttemptMap[contact.id] ?? null}
            cardActionHandlerFor={cardActionHandlerFor}
            resolveActionLabel={resolveActionLabel}
            draftVisitId={draftVisitIds[contact.id] ?? null}
            onOpenFitterPicker={handleOpenPicker}
            onNavigate={handleNavigate}
            onOpenInvoice={handleOpenInvoice}
            onOpenEdit={handleOpenEdit}
          />
        ))}
      </>
    );
  };

  // ── Root layout ────────────────────────────────────────────────────────────
  return (
    <Box
      sx={{
        position: 'fixed',
        top: 'var(--header-h)',
        bottom: 'var(--nav-h)',
        left: 0,
        right: 0,
        display: 'flex',
        flexDirection: 'column',
        background: BRAND_COLORS.paper,
      }}
    >
      {/* Page heading — replaces the normal-flow PageHeadingPanel which is
          suppressed on /projects because the fixed overlay covers it */}
      <Box
        role="region"
        aria-label="Projects"
        sx={{
          maxWidth: 640,
          width: '100%',
          mx: 'auto',
          px: 2,
          pt: 2,
          pb: 1,
          boxSizing: 'border-box',
          flexShrink: 0,
        }}
      >
        <Typography
          component="h1"
          sx={{
            m: 0,
            fontFamily: "'Anton', system-ui, sans-serif",
            fontSize: '1.6rem',
            lineHeight: 1.15,
            letterSpacing: '0.01em',
            color: 'var(--ink-1)',
          }}
        >
          Projects
        </Typography>
      </Box>

      {/* Dev-mode banner */}
      {isAdmin && devMode && (
        <Alert
          id="dev-mode-banner"
          severity="warning"
          sx={{ borderRadius: 0, flexShrink: 0 }}
          action={
            <Button
              color="inherit"
              size="small"
              component="a"
              href="/admin#tab-devenv"
            >
              Turn off
            </Button>
          }
        >
          Dev mode is ON — only test contacts are shown
        </Alert>
      )}

      {/* Stage filter tabs */}
      <PageFilterBar
        sx={{
          px: 2,
          py: 1,
          bgcolor: 'background.default',
          borderBottom: '1px solid',
          borderColor: 'divider',
          flexShrink: 0,
        }}
      >
        <StageTabGroup
          value={filter}
          onChange={setFilter}
          tabs={stageTabs}
          stageColors={STAGE_COLORS}
        />
      </PageFilterBar>

      {/* Sort / group / extra-filters bar */}
      <PageFilterBar
        sx={{
          px: 2,
          py: 1,
          bgcolor: 'background.default',
          borderBottom: '1px solid',
          borderColor: 'divider',
          flexShrink: 0,
        }}
      >
        <SortSelect
          value={sortBy}
          onChange={(v) => handleSortChange(v as SortKey)}
          options={[
            { value: 'stage', label: 'Stage' },
            { value: 'name', label: 'Name' },
            { value: 'date', label: 'Close date' },
            { value: 'install', label: 'Install date' },
          ]}
          label="Sort by"
          minWidth={130}
        />

        {/* Staleness toggle chip — visible only for Sales / Design Visit */}
        {STALENESS_STAGES.has(stageKeyFilter) && (
          <Chip
            label={`Stale >${PROJECTS_STALENESS_DAYS}d`}
            size="small"
            variant={stalenessActive ? 'filled' : 'outlined'}
            onClick={handleStalenessToggle}
            title={stalenessActive ? 'Showing contacts not updated in the last 30 days — click to clear' : 'Filter to contacts not updated in the last 30 days'}
            sx={{
              fontSize: '0.72rem',
              height: 24,
              fontWeight: 600,
              cursor: 'pointer',
              bgcolor: stalenessActive ? STATUS_COLORS.warning.bg : undefined,
              color: stalenessActive ? STATUS_COLORS.warning.text : undefined,
              borderColor: stalenessActive ? STATUS_COLORS.warningActive.bg : BRAND_COLORS.stone,
              '& .MuiChip-label': { px: '8px' },
              '&:hover': {
                bgcolor: stalenessActive ? STATUS_COLORS.warningActive.bg : BRAND_COLORS.stone,
              },
            }}
          />
        )}

        {/* Substage filter button + popover — visible only when stage has substages */}
        {availableSubstages.length > 0 && (
          <>
            <Box
              component="button"
              onClick={(e: React.MouseEvent<HTMLButtonElement>) =>
                setSubstageFilterAnchor(substageFilterAnchor ? null : e.currentTarget)
              }
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '0.75rem',
                fontWeight: 600,
                fontFamily: 'inherit',
                color: substageFilterAnchor || hiddenSubstages.size > 0 ? 'common.white' : BRAND_COLORS.ink3,
                background: substageFilterAnchor || hiddenSubstages.size > 0 ? BRAND_COLORS.plum : 'transparent',
                border: `1.5px solid ${substageFilterAnchor || hiddenSubstages.size > 0 ? BRAND_COLORS.plum : BRAND_COLORS.stone}`,
                borderRadius: `${RADIUS.pill}px`,
                px: '10px',
                py: '3px',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                transition: 'background 0.12s, color 0.12s, border-color 0.12s',
                WebkitTapHighlightColor: 'transparent',
                '&:hover': {
                  background: substageFilterAnchor || hiddenSubstages.size > 0 ? BRAND_COLORS.plum : BRAND_COLORS.stone,
                  color: substageFilterAnchor || hiddenSubstages.size > 0 ? 'common.white' : BRAND_COLORS.ink2,
                },
              }}
            >
              <FilterListIcon sx={{ fontSize: 13 }} />
              <span>Substages</span>
              {hiddenSubstages.size > 0 && (
                <Box
                  component="span"
                  sx={{
                    fontSize: '0.65rem',
                    fontWeight: 700,
                    bgcolor: 'rgba(255,255,255,0.25)',
                    borderRadius: '999px',
                    px: '5px',
                    py: '1px',
                    ml: '2px',
                  }}
                >
                  {hiddenSubstages.size} hidden
                </Box>
              )}
            </Box>
            <Popover
              open={Boolean(substageFilterAnchor)}
              anchorEl={substageFilterAnchor}
              onClose={() => setSubstageFilterAnchor(null)}
              anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
              transformOrigin={{ vertical: 'top', horizontal: 'left' }}
              slotProps={{
                paper: {
                  sx: {
                    mt: '6px',
                    minWidth: 168,
                    p: 1.5,
                    border: `1.5px solid ${BRAND_COLORS.stone}`,
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
                  color: BRAND_COLORS.ink4,
                  letterSpacing: '0.05em',
                  textTransform: 'uppercase',
                  fontSize: '0.68rem',
                  mb: 1,
                }}
              >
                Show substages
              </Typography>
              {availableSubstages.map((opt) => (
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
          </>
        )}

        <Box
          component="button"
          disabled={!!(stageKeyFilter || myRooms)}
          onClick={handleGroupToggle}
          title={
            stageKeyFilter || myRooms
              ? 'Clear the stage filter to enable grouping'
              : groupBy
              ? 'Ungroup stages'
              : 'Group by stage'
          }
          sx={{
            fontSize: '0.78rem',
            fontWeight: 600,
            fontFamily: 'inherit',
            color: groupBy ? 'common.white' : BRAND_COLORS.ink3,
            background: groupBy ? BRAND_COLORS.plum : 'transparent',
            border: `1.5px solid ${groupBy ? BRAND_COLORS.plum : BRAND_COLORS.stone}`,
            borderRadius: `${RADIUS.pill}px`,
            px: '12px',
            py: '4px',
            cursor: stageKeyFilter || myRooms ? 'not-allowed' : 'pointer',
            whiteSpace: 'nowrap',
            transition: 'background 0.12s, color 0.12s, border-color 0.12s',
            ml: 'auto',
            opacity: stageKeyFilter || myRooms ? 0.4 : 1,
            '&:hover:not(:disabled)': {
              background: groupBy ? BRAND_COLORS.plum : BRAND_COLORS.stone,
              color: groupBy ? 'common.white' : BRAND_COLORS.ink2,
            },
            '@media (pointer: coarse)': { minHeight: '44px', py: '10px' },
          }}
        >
          Group by stage
        </Box>
      </PageFilterBar>

      {/* Unknown-status warning banner */}
      {unknownStatusCount > 0 && !unknownStatusDismissed && (
        <Box
          role="alert"
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            px: '16px',
            py: '8px',
            background: STATUS_COLORS.warningLight.bg,
            borderBottom: `1px solid ${STATUS_COLORS.warningActive.bg}`,
            flexShrink: 0,
          }}
        >
          <Typography sx={{ fontSize: '0.78rem', fontWeight: 600, color: STATUS_COLORS.warning.text, flex: 1 }}>
            {unknownStatusCount === 1
              ? '1 project card has a missing or unconfigured HubSpot lead status — it is still visible but may need attention.'
              : `${unknownStatusCount} project cards have a missing or unconfigured HubSpot lead status — they are still visible but may need attention.`}
          </Typography>
          <IconButton
            size="small"
            aria-label="dismiss"
            onClick={() => setUnknownStatusDismissed(true)}
            sx={{ color: STATUS_COLORS.warning.text, p: '2px', flexShrink: 0 }}
          >
            <CloseIcon sx={{ fontSize: 15 }} />
          </IconButton>
        </Box>
      )}

      {/* Scrollable content area */}
      <Box
        sx={{
          flex: 1,
          overflowY: 'auto',
          WebkitOverflowScrolling: 'touch',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Box
          sx={{
            maxWidth: 1100,
            mx: 'auto',
            width: '100%',
            p: '20px 16px calc(40px + env(safe-area-inset-bottom))',
            display: 'grid',
            gridTemplateColumns: '1fr',
            gap: '10px',
            '@media (min-width: 640px)': {
              p: '28px 24px 48px',
              gap: '12px',
              gridTemplateColumns: 'repeat(2, 1fr)',
            },
            '@media (min-width: 900px)': {
              gridTemplateColumns: 'repeat(3, 1fr)',
            },
          }}
        >
          {renderCards()}
        </Box>
      </Box>

      {/* Fitter picker dialog */}
      {pickerOpen && (
        <FitterPickerDialog
          open={pickerOpen}
          onClose={handleClosePicker}
          contactId={pickerContactId}
          roomIdx={pickerRoomIdx}
          platformUsers={platformUsers}
          currentFitterId={pickerCurrentFitter}
          onAssign={handleAssignFitter}
        />
      )}

      {/* Assigning overlay */}
      {pickerAssigning && (
        <Box
          sx={{
            position: 'fixed',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.2)',
            zIndex: 1400,
          }}
        >
          <CircularProgress size={40} sx={{ color: BRAND_COLORS.plum }} />
        </Box>
      )}

      {/* Toast notifications */}
      <Snackbar
        open={!!toast}
        autoHideDuration={3500}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        message={toast?.msg}
        slotProps={
          toast?.error
            ? { content: { sx: { bgcolor: 'error.dark' } } }
            : undefined
        }
      />

      {/* Invoice detail drawer */}
      <InvoiceDetailDrawer
        open={invDrawerOpen}
        invId={invDrawerInvId}
        allIds={invDrawerAllIds}
        onClose={() => setInvDrawerOpen(false)}
        onNavigate={id => setInvDrawerInvId(id)}
        isAdmin={isAdmin}
        onSaved={qb.refresh}
      />

      {/* Contact edit modal — only opens after the full contact is fetched */}
      {editContactData && (
        <ContactEditModal
          contact={editContactData}
          open={true}
          onClose={() => setEditContactData(null)}
          onSaved={handleContactSaved}
        />
      )}
    </Box>
  );
}
