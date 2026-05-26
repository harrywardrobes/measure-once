import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  List,
  ListItemButton,
  MenuItem,
  Select,
  Skeleton,
  Snackbar,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import CheckIcon from '@mui/icons-material/Check';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { STAGE_COLORS } from '../theme';
import { usePrivilege } from '../hooks/usePrivilege';
import { InvoiceDetailDrawer, fmtGBP as fmtGBPShared } from '../components/InvoiceDetailDrawer';

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

// ── Types ──────────────────────────────────────────────────────────────────────

interface Contact {
  id: string;
  properties?: {
    firstname?: string;
    lastname?: string;
    email?: string;
    closedate?: string;
  };
}

interface Room {
  room?: string;
  stageKey?: string;
  roomStatus?: string;
  assignedFitterId?: string | null;
  installStart?: string | null;
  roomIdx: number;
}

interface PlatformUser {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  profileImageUrl?: string;
}

interface WorkflowStage {
  label?: string;
}

interface WorkflowDef {
  stages?: Record<string, WorkflowStage>;
}

interface QBState {
  statusKnown?: boolean;
  loading?: boolean;
  connected?: boolean;
  loaded?: boolean;
  invoices?: Array<{ id: string; balance: number }>;
}

interface WindowGlobals {
  state?: {
    contacts?: Contact[];
    contactStageCache?: Record<string, Array<Omit<Room, 'roomIdx'>>>;
    workflow?: WorkflowDef;
    platformUsers?: PlatformUser[];
    qb?: QBState;
    roomAssignmentsStale?: boolean;
    user?: { id?: string };
  };
  registerProjectsViewRenderer?: (fn: () => void) => void;
  matchInvoicesForContact?: (contact: Contact) => Array<{ id: string; balance: number }>;
  GET?: (path: string) => Promise<unknown>;
  PATCH_REQ?: (path: string, body: unknown) => Promise<unknown>;
  showToast?: (msg: string, isError?: boolean) => void;
}

type SortKey = 'stage' | 'name' | 'date' | 'install';

// ── Pure helpers ───────────────────────────────────────────────────────────────

function getContactName(c: Contact): string {
  const first = c.properties?.firstname || '';
  const last = c.properties?.lastname || '';
  const both = `${first} ${last}`.trim();
  if (both) return both;
  return c.properties?.email || `Contact ${c.id}`;
}

function getStageLabel(stageKey: string, workflow: WorkflowDef | undefined): string {
  return workflow?.stages?.[stageKey]?.label || STAGE_LABEL_FALLBACK[stageKey] || stageKey;
}

function getStageColor(stageKey: string) {
  return STAGE_COLORS[stageKey] || { bg: '#6B6860', light: '#F6F1E7', text: '#3C3A34' };
}

function getFitterInitials(user: PlatformUser | null | undefined): string {
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

function fmtGBP(amount: number): string {
  return fmtGBPShared(amount);
}

// ── Row computation ────────────────────────────────────────────────────────────

interface ProjectRow {
  contact: Contact;
  rooms: Room[];
}

function computeRows(
  contacts: Contact[],
  stageCache: Record<string, Array<Omit<Room, 'roomIdx'>>>,
  filter: string,
  sortBy: SortKey,
  currentUserId: string | undefined,
): ProjectRow[] {
  const myRooms = filter === '__mine__';
  const stageKey = myRooms ? '' : filter;

  const rows: ProjectRow[] = [];

  for (const contact of contacts) {
    const cached = stageCache[contact.id];
    if (!cached || cached.length === 0) continue;

    const activeRooms: Room[] = cached
      .map((r, idx) => ({ ...r, roomIdx: idx }))
      .filter((r) => (r.roomStatus || 'active') === 'active')
      .filter((r) => !stageKey || r.stageKey === stageKey)
      .filter((r) => !myRooms || r.assignedFitterId === currentUserId);

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
  room: Room;
  platformUsers: PlatformUser[];
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
        bgcolor: '#200842',
      }}
    >
      {initials}
    </Avatar>
  );

  const chipSx = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    background: '#F6F1E7',
    border: '1px solid #D9D2C2',
    borderRadius: '999px',
    px: '8px',
    pl: '3px',
    py: '2px',
    fontSize: '0.72rem',
    fontWeight: 500,
    color: '#6B6860',
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
            color: !fitter ? '#97927F' : undefined,
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
        '&:hover': { background: '#D9D2C2', borderColor: '#B8AE99' },
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
          color: !fitter ? '#97927F' : undefined,
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
  contact: Contact;
  qb: QBState | undefined;
  onOpen: (firstId: string, allIds: string[]) => void;
}) {
  if (!qb?.statusKnown || qb.loading || (qb.connected && !qb.loaded)) {
    return (
      <Box
        sx={{
          px: '14px',
          py: '10px',
          borderTop: '1px solid #D9D2C2',
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

  const w = window as unknown as WindowGlobals;
  const invs =
    typeof w.matchInvoicesForContact === 'function' ? w.matchInvoicesForContact(contact) : [];
  if (!invs.length) return null;

  const total = invs.reduce((s, inv) => s + inv.balance, 0);
  const count = invs.length;
  const invIds = invs.map((i) => i.id);

  return (
    <Box sx={{ px: '14px', py: '10px', borderTop: '1px solid #D9D2C2', display: 'flex', alignItems: 'center', gap: 1, minHeight: 36 }}>
      <button
        onClick={() => onOpen(invIds[0], invIds)}
        title={`${count} outstanding invoice${count !== 1 ? 's' : ''}`}
        style={{
          display: 'inline-flex', alignItems: 'center',
          fontSize: '0.68rem', fontWeight: 700,
          fontFamily: 'inherit',
          padding: '2px 7px', borderRadius: '999px',
          background: '#fef3c7', color: '#92400e',
          border: '1px solid #fde68a',
          whiteSpace: 'nowrap',
          cursor: 'pointer',
          lineHeight: 1.4,
        }}
      >
        {fmtGBP(total)}
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
  workflow,
  qb,
  onOpenFitterPicker,
  onNavigate,
  onOpenInvoice,
}: {
  contact: Contact;
  rooms: Room[];
  platformUsers: PlatformUser[];
  canAssign: boolean;
  workflow: WorkflowDef | undefined;
  qb: QBState | undefined;
  onOpenFitterPicker: (contactId: string, roomIdx: number) => void;
  onNavigate: (contactId: string, roomIdx: number) => void;
  onOpenInvoice: (firstId: string, allIds: string[]) => void;
}) {
  const name = getContactName(contact);
  const earliestInstall =
    rooms.map((r) => r.installStart).filter(Boolean).sort()[0] ?? null;
  const installLabel = fmtInstallDate(earliestInstall);

  return (
    <Box
      sx={{
        background: '#F6F1E7',
        border: '1px solid #D9D2C2',
        borderRadius: '8px',
        boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
        overflow: 'hidden',
      }}
    >
      {/* Card header */}
      <Box sx={{ p: '12px 14px 10px', borderBottom: '1px solid #D9D2C2' }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, minWidth: 0 }}>
          <Typography
            sx={{
              fontSize: '0.975rem',
              fontWeight: 700,
              color: '#141413',
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
          {installLabel && (
            <Typography
              sx={{
                fontSize: '0.68rem',
                fontWeight: 600,
                color: '#6B6860',
                whiteSpace: 'nowrap',
                letterSpacing: '0.01em',
                flexShrink: 0,
              }}
            >
              Install: {installLabel}
            </Typography>
          )}
        </Box>
        <Typography sx={{ fontSize: '0.72rem', fontWeight: 500, color: '#97927F', letterSpacing: '0.02em', mt: '2px' }}>
          #{contact.id}
        </Typography>
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
                borderBottom: isLast ? 'none' : '1px solid #D9D2C2',
                '&:hover': { background: 'rgba(0,0,0,0.03)' },
                '&:active': { background: '#D9D2C2' },
              }}
            >
              <Typography
                sx={{
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  color: '#3C3A34',
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
  platformUsers: PlatformUser[];
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
            <Box sx={{ p: 3, textAlign: 'center', color: '#97927F', fontSize: '0.875rem' }}>
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
                  <Avatar sx={{ width: 36, height: 36, bgcolor: '#200842', fontSize: '0.85rem', fontWeight: 700 }}>
                    {initials}
                  </Avatar>
                )}
                <Typography sx={{ flex: 1, fontWeight: isSelected ? 700 : 400 }}>{fullName}</Typography>
                {isSelected && <CheckIcon fontSize="small" sx={{ color: '#200842' }} />}
              </ListItemButton>
            );
          })}
          {currentFitterId && (
            <>
              <Divider />
              <ListItemButton
                onClick={() => onAssign(contactId, roomIdx, null)}
                sx={{ px: 2, py: 1.25, color: '#6B6860', fontSize: '0.875rem' }}
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
        color: '#97927F',
      }}
    >
      <PersonAddIcon sx={{ fontSize: 48, mb: 2, opacity: 0.35 }} />
      <Typography sx={{ fontSize: '0.9rem', color: '#97927F' }}>{message}</Typography>
    </Box>
  );
}

// ── ProjectsPage ───────────────────────────────────────────────────────────────

export function ProjectsPage() {
  const { isAdmin, isManager } = usePrivilege();
  const canAssign = isManager || isAdmin;

  const [refreshKey, setRefreshKey] = useState(0);
  const [filter, setFilter] = useState<string>('');
  const [sortBy, setSortBy] = useState<SortKey>('stage');
  const [groupBy, setGroupBy] = useState(false);
  const [platformUsers, setPlatformUsers] = useState<PlatformUser[]>([]);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [staleDismissed, setStaleDismissed] = useState(false);
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(null);

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

  // ── Register as the projects view renderer ─────────────────────────────────
  useEffect(() => {
    const w = window as unknown as WindowGlobals;
    if (typeof w.registerProjectsViewRenderer === 'function') {
      w.registerProjectsViewRenderer(() => setRefreshKey((k) => k + 1));
    }
    // Trigger an immediate refresh so that data already loaded by bootstrap()
    // (before this effect ran) is displayed without waiting for the next
    // renderProjectsView() call. This covers the edge case where bootstrap
    // completes before the React component mounts.
    setRefreshKey((k) => k + 1);

    // Listen for localdata updates (fitter assignments from other sessions)
    const onLocalData = () => setRefreshKey((k) => k + 1);
    document.addEventListener('localdata-updated', onLocalData);
    return () => {
      document.removeEventListener('localdata-updated', onLocalData);
    };
  }, []);

  // ── Load prefs ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const w = window as unknown as WindowGlobals;
    const s = w.state;
    // If the vanilla bootstrap has already set prefs on state, read them now
    if (s) {
      const sort = (s as unknown as Record<string, unknown>)['projectSort'] as SortKey | undefined;
      const group = (s as unknown as Record<string, unknown>)['projectGroupByStage'] as boolean | undefined;
      if (sort) setSortBy(sort);
      if (group != null) setGroupBy(!!group);
    }
    // Fetch from API in case state hasn't been populated yet
    const fetchPrefs = async () => {
      try {
        if (typeof w.GET === 'function') {
          const prefs = (await w.GET('/api/users/me/prefs')) as Record<string, unknown>;
          if (prefs?.projectSort) setSortBy(prefs.projectSort as SortKey);
          if (prefs?.projectGroupByStage != null) setGroupBy(!!prefs.projectGroupByStage);
        }
      } catch {
        // ignore — default prefs are fine
      } finally {
        setPrefsLoaded(true);
      }
    };
    fetchPrefs();
  }, []);

  // ── Load platform users ────────────────────────────────────────────────────
  useEffect(() => {
    const w = window as unknown as WindowGlobals;
    const existing = w.state?.platformUsers;
    if (existing && existing.length > 0) {
      setPlatformUsers(existing);
      return;
    }
    const load = async () => {
      try {
        if (typeof w.GET === 'function') {
          const users = (await w.GET('/api/platform-users')) as PlatformUser[];
          setPlatformUsers(users || []);
          if (w.state) (w.state as unknown as Record<string, unknown>)['platformUsers'] = users;
        }
      } catch {
        // ignore — fitter chips just won't show names
      }
    };
    load();
  }, []);

  // ── Derive data from window.state ──────────────────────────────────────────
  const w = window as unknown as WindowGlobals;
  const state = w.state;
  const contacts = state?.contacts || [];
  const stageCache = state?.contactStageCache || {};
  const workflow = state?.workflow;
  const qb = state?.qb;
  const isStale = !!state?.roomAssignmentsStale && !staleDismissed;
  const currentUserId = state?.user?.id;

  const myRooms = filter === '__mine__';
  const stageKeyFilter = myRooms ? '' : filter;
  const groupingEnabled = groupBy && !stageKeyFilter && !myRooms;

  const rows = useMemo(
    () => computeRows(contacts, stageCache, filter, sortBy, currentUserId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refreshKey, contacts.length, filter, sortBy, currentUserId],
  );

  // ── Stage tabs ─────────────────────────────────────────────────────────────
  const stageTabs = useMemo(() => {
    const tabs: Array<{ key: string; label: string }> = [
      { key: '', label: 'All' },
      { key: '__mine__', label: 'My rooms' },
      ...STAGE_KEYS.map((k) => ({ key: k, label: getStageLabel(k, workflow) })),
    ];
    return tabs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, workflow]);

  // ── Pref persistence helpers ───────────────────────────────────────────────
  const persistPref = useCallback(
    async (key: string, value: unknown) => {
      try {
        if (typeof w.PATCH_REQ === 'function') {
          await w.PATCH_REQ('/api/users/me/prefs', { [key]: value });
        }
      } catch {
        // ignore
      }
    },
    [w],
  );

  const handleSortChange = useCallback(
    (val: SortKey) => {
      setSortBy(val);
      if (w.state) (w.state as unknown as Record<string, unknown>)['projectSort'] = val;
      persistPref('projectSort', val);
    },
    [w, persistPref],
  );

  const handleGroupToggle = useCallback(() => {
    const next = !groupBy;
    setGroupBy(next);
    if (w.state) (w.state as unknown as Record<string, unknown>)['projectGroupByStage'] = next;
    persistPref('projectGroupByStage', next);
  }, [groupBy, w, persistPref]);

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
        const result = (await w.PATCH_REQ?.(
          `/api/contacts/${contactId}/rooms/${roomIdx}/fitter`,
          { fitterId: fitterId || null },
        )) as { syncFailed?: boolean } | undefined;

        // Update local cache
        const cached = w.state?.contactStageCache?.[contactId];
        if (cached && cached[roomIdx] !== undefined) {
          cached[roomIdx] = { ...cached[roomIdx], assignedFitterId: fitterId || null };
        }

        setRefreshKey((k) => k + 1);

        const baseMsg = fitterId ? 'Fitter assigned' : 'Assignment removed';
        if (result?.syncFailed) {
          setToast({ msg: `${baseMsg} — HubSpot sync failed, CRM may be out of date`, error: true });
        } else {
          setToast({ msg: baseMsg });
        }
      } catch (e: unknown) {
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
    [w],
  );

  // Current fitter for the open picker
  const pickerCurrentFitter =
    (pickerContactId && w.state?.contactStageCache?.[pickerContactId]?.[pickerRoomIdx]?.assignedFitterId) ?? null;

  // ── Navigate to project ────────────────────────────────────────────────────
  const handleNavigate = useCallback((contactId: string, roomIdx: number) => {
    const idx = roomIdx || 0;
    window.location.href = idx ? `/customers/${contactId}?room=${idx}` : `/customers/${contactId}`;
  }, []);

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
                  <Box component="span" sx={{ fontSize: '0.72rem', fontWeight: 600, color: '#97927F' }}>
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
                    workflow={workflow}
                    qb={qb}
                    onOpenFitterPicker={handleOpenPicker}
                    onNavigate={handleNavigate}
                    onOpenInvoice={handleOpenInvoice}
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
            workflow={workflow}
            qb={qb}
            onOpenFitterPicker={handleOpenPicker}
            onNavigate={handleNavigate}
            onOpenInvoice={handleOpenInvoice}
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
        background: '#F6F1E7',
      }}
    >
      {/* Stale data banner */}
      {isStale && (
        <Alert
          severity="warning"
          icon={<WarningAmberIcon fontSize="small" />}
          onClose={() => setStaleDismissed(true)}
          id="room-stale-banner"
          role="alert"
          sx={{
            borderRadius: 0,
            flexShrink: 0,
            py: 0.5,
            fontSize: '0.82rem',
          }}
        >
          Room data may be out of date — showing last cached assignments
        </Alert>
      )}

      {/* Stage filter tabs */}
      <Box
        sx={{
          display: 'flex',
          gap: '6px',
          overflowX: 'auto',
          p: '12px 16px',
          borderBottom: '1px solid #D9D2C2',
          background: '#F6F1E7',
          flexShrink: 0,
          WebkitOverflowScrolling: 'touch',
          scrollbarWidth: 'none',
          '&::-webkit-scrollbar': { display: 'none' },
        }}
      >
        {stageTabs.map(({ key, label }) => {
          const active = filter === key;
          const colour = key && key !== '__mine__' ? getStageColor(key) : null;
          return (
            <Box
              key={key}
              component="button"
              onClick={() => setFilter(key)}
              sx={{
                flexShrink: 0,
                fontSize: '0.78rem',
                fontWeight: 600,
                px: '13px',
                py: '5px',
                borderRadius: '999px',
                border: `1.5px solid ${active && colour ? colour.bg : active ? '#200842' : '#D9D2C2'}`,
                background: active && colour ? colour.bg : active ? '#200842' : 'transparent',
                color: active ? '#fff' : '#6B6860',
                cursor: 'pointer',
                fontFamily: 'inherit',
                transition: 'background 0.12s, color 0.12s, border-color 0.12s',
                whiteSpace: 'nowrap',
                '&:hover': active
                  ? {}
                  : { background: '#D9D2C2', color: '#3C3A34' },
              }}
            >
              {label}
            </Box>
          );
        })}
      </Box>

      {/* Sort / group bar */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          p: '8px 16px',
          background: '#F6F1E7',
          borderBottom: '1px solid #D9D2C2',
          flexShrink: 0,
        }}
      >
        <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: '#97927F', whiteSpace: 'nowrap' }}>
          Sort by
        </Typography>
        <Select
          size="small"
          value={sortBy}
          onChange={(e) => handleSortChange(e.target.value as SortKey)}
          sx={{
            fontSize: '0.78rem',
            fontWeight: 600,
            borderRadius: '999px',
            '& .MuiOutlinedInput-notchedOutline': { borderColor: '#D9D2C2', borderWidth: '1.5px' },
            '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: '#B8AE99' },
            '& .MuiSelect-select': { py: '4px', px: '10px', pr: '28px !important' },
          }}
        >
          <MenuItem value="stage">Stage</MenuItem>
          <MenuItem value="name">Name</MenuItem>
          <MenuItem value="date">Close date</MenuItem>
          <MenuItem value="install">Install date</MenuItem>
        </Select>
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
            color: groupBy ? '#fff' : '#6B6860',
            background: groupBy ? '#200842' : 'transparent',
            border: `1.5px solid ${groupBy ? '#200842' : '#D9D2C2'}`,
            borderRadius: '999px',
            px: '12px',
            py: '4px',
            cursor: stageKeyFilter || myRooms ? 'not-allowed' : 'pointer',
            whiteSpace: 'nowrap',
            transition: 'background 0.12s, color 0.12s, border-color 0.12s',
            ml: 'auto',
            opacity: stageKeyFilter || myRooms ? 0.4 : 1,
            '&:hover:not(:disabled)': {
              background: groupBy ? '#200842' : '#D9D2C2',
              color: groupBy ? '#fff' : '#3C3A34',
            },
            '@media (pointer: coarse)': { minHeight: '44px', py: '10px' },
          }}
        >
          Group by stage
        </Box>
      </Box>

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
          <CircularProgress size={40} sx={{ color: '#200842' }} />
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
            ? { content: { sx: { background: '#b91c1c' } } }
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
      />
    </Box>
  );
}
