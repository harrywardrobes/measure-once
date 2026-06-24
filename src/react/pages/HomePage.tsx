import React from 'react';
import { STAGE_LABELS } from '../utils/stageKeys';
import type { StageKey } from '../utils/stageKeys';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActionArea,
  Chip,
  IconButton,
  InputAdornment,
  Skeleton,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import SearchIcon from '@mui/icons-material/Search';
import ClearIcon from '@mui/icons-material/Clear';
import { useQBInvoices } from '../hooks/useQBInvoices';
import { broadcastConnect } from '../lib/qbInvoicesStore';
import { useToastContext } from '../contexts/ToastContext';
import type { InvoiceSummary } from '../components/InvoiceDetailDrawer';
import { usePrivilege } from '../hooks/usePrivilege';
import { useAuth } from '../contexts/AuthContext';
import { useDevMode } from '../hooks/useDevMode';
import { usePageTitle } from '../hooks/usePageTitle';
import { readRecords } from '../lib/offlineDb';
import { WorkflowDef } from '../lib/workflowConfig';
import { useWorkflowData } from '../context/WorkflowDataContext';
import {
  HOME_TASK_ASSIGNEE_FILTER_PREFIX,
  HOME_TASK_CONTACT_SEARCH_PREFIX,
  HOME_TASK_ASSIGNEE_FILTER_LEGACY_KEY,
  HOME_TASK_CONTACT_SEARCH_LEGACY_KEY,
} from '../constants/localStorageKeys';

// Ensure icon-lint scanner can detect these imports before apostrophe text below.
type _Icons = typeof RefreshIcon | typeof WarningAmberIcon | typeof ChevronLeftIcon | typeof ChevronRightIcon | typeof SearchIcon | typeof ClearIcon;

type ContactTask = {
  id: string;
  task_name: string;
  task_description: string;
  task_customer: { contactId: string; contactName: string };
  task_assigned_user: { userId: string; name: string };
  task_deadline: string;
  task_status: 'open' | 'completed';
};

type Contact = {
  id: string;
  properties?: {
    firstname?: string;
    lastname?: string;
    /** JSON-encoded workflow rooms; used to derive stage pills offline. */
    measure_once_rooms?: string;
  };
};
type Room = { room?: string; stageKey?: string; roomStatus?: string };

/**
 * Parse a contact's own cached `measure_once_rooms` property into Room pills.
 * Mirrors `parseContactRooms` in CustomersPage so the home "Active Projects"
 * section can show correct stage labels offline (when `/api/localdata/all`
 * fails and the `roomsByContact` map is empty). Returns [] if the property is
 * missing or unparseable.
 */
function parseContactRooms(contact: Contact): Room[] {
  const roomsJson = contact.properties?.measure_once_rooms;
  if (!roomsJson) return [];
  try {
    const rooms = JSON.parse(roomsJson) as Array<{
      room?: string;
      stageKey?: string;
      roomStatus?: string;
    }>;
    if (!Array.isArray(rooms)) return [];
    return rooms.map((r) => ({
      room: r.room || 'Main',
      stageKey: r.stageKey || 'sales',
      roomStatus: r.roomStatus || 'active',
    }));
  } catch {
    return [];
  }
}


async function jget<T>(path: string): Promise<T> {
  const r = await fetch(path, { headers: { Accept: 'application/json' } });
  if (r.status === 401) {
    location.href = '/login';
    throw new Error('Unauthorized');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error((data as { error?: string }).error || `HTTP ${r.status}`);
    (e as { code?: string }).code = (data as { code?: string }).code;
    throw e;
  }
  return data as T;
}

function fmtDate(d: string | Date): string {
  const dt = typeof d === 'string' ? new Date(d) : d;
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatCurrency(n: number): string {
  return (
    '£' +
    Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

function contactDisplayName(c: Contact): string {
  const n = [c.properties?.firstname, c.properties?.lastname].filter(Boolean).join(' ');
  return n || '—';
}

function SectionHeader({
  title,
  badge,
  linkLabel,
  linkHref,
}: {
  title: string;
  badge?: React.ReactNode;
  linkLabel?: string;
  linkHref?: string;
}) {
  return (
    <Stack direction="row" sx={{   mb: 1, alignItems: 'center', justifyContent: 'space-between' }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Typography variant="overline" sx={{ letterSpacing: 0.6, color: 'text.secondary' }}>
          {title}
        </Typography>
        {badge}
      </Stack>
      {linkLabel && linkHref ? (
        <Button size="small" onClick={() => (location.href = linkHref)}>
          {linkLabel}
        </Button>
      ) : null}
    </Stack>
  );
}

function HomeCard({
  onClick,
  children,
  disabled,
  sx,
}: {
  onClick?: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  sx?: object;
}) {
  const content = <Box sx={{ p: 1.5, ...sx }}>{children}</Box>;
  return (
    <Card variant="outlined" sx={{ mb: 1 }}>
      {onClick && !disabled ? (
        <CardActionArea data-testid="home-card-action" onClick={onClick}>{content}</CardActionArea>
      ) : (
        content
      )}
    </Card>
  );
}

function SkeletonCard({ titleW = '50%', badgeW = 44 }: { titleW?: string; badgeW?: number }) {
  return (
    <HomeCard disabled>
      <Stack direction="row" spacing={1} sx={{  alignItems: 'center', justifyContent: 'space-between' }}>
        <Skeleton variant="text" width={titleW} height={18} />
        <Skeleton variant="rounded" width={badgeW} height={18} sx={{ borderRadius: 999 }} />
      </Stack>
      <Skeleton variant="text" width="30%" height={12} sx={{ mt: 0.5 }} />
    </HomeCard>
  );
}

function DateHeader() {
  const now = new Date();
  const day = now.toLocaleDateString('en-GB', { weekday: 'long' });
  const full = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return (
    <Box sx={{ mb: 3 }}>
      <Typography
        sx={{
          fontFamily: "'Anton', system-ui, sans-serif",
          fontSize: 28,
          lineHeight: 1.1,
          letterSpacing: 0.5,
        }}
      >
        {day}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        {full}
      </Typography>
    </Box>
  );
}

const TASKS_PER_PAGE = 5;

type AssigneeFilter = 'all' | 'mine';

function TaskSection({
  tasks,
  loading,
  todayMs,
  currentUserId,
}: {
  tasks: ContactTask[];
  loading: boolean;
  todayMs: number;
  currentUserId?: string;
}) {
  const [page, setPage] = React.useState(1);

  const filterKey    = currentUserId ? `${HOME_TASK_ASSIGNEE_FILTER_PREFIX}${currentUserId}` : null;
  const searchKey    = currentUserId ? `${HOME_TASK_CONTACT_SEARCH_PREFIX}${currentUserId}`  : null;

  const [assigneeFilter, setAssigneeFilter] = React.useState<AssigneeFilter>(() => {
    try {
      const saved = filterKey ? localStorage.getItem(filterKey) : null;
      return saved === 'mine' ? 'mine' : 'all';
    } catch {
      return 'all';
    }
  });

  const [contactSearch, setContactSearch] = React.useState<string>(() => {
    try {
      return (searchKey ? localStorage.getItem(searchKey) : null) ?? '';
    } catch {
      return '';
    }
  });

  React.useEffect(() => {
    try {
      localStorage.removeItem(HOME_TASK_ASSIGNEE_FILTER_LEGACY_KEY);
      localStorage.removeItem(HOME_TASK_CONTACT_SEARCH_LEGACY_KEY);
    } catch { /* ignore */ }
  }, []);

  React.useEffect(() => {
    if (!filterKey || !searchKey) return;
    try {
      const savedFilter = localStorage.getItem(filterKey);
      setAssigneeFilter(savedFilter === 'mine' ? 'mine' : 'all');
      setContactSearch(localStorage.getItem(searchKey) ?? '');
      setPage(1);
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserId]);

  const handleAssigneeFilter = (_: React.MouseEvent<HTMLElement>, val: AssigneeFilter | null) => {
    if (!val) return;
    setAssigneeFilter(val);
    setPage(1);
    try { if (filterKey) localStorage.setItem(filterKey, val); } catch { /* ignore */ }
  };

  const handleContactSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setContactSearch(v);
    setPage(1);
    try { if (searchKey) localStorage.setItem(searchKey, v); } catch { /* ignore */ }
  };

  const clearContactSearch = () => {
    setContactSearch('');
    setPage(1);
    try { if (searchKey) localStorage.removeItem(searchKey); } catch { /* ignore */ }
  };

  const clearFilters = () => {
    setAssigneeFilter('all');
    setContactSearch('');
    setPage(1);
    try {
      if (filterKey) localStorage.removeItem(filterKey);
      if (searchKey) localStorage.removeItem(searchKey);
    } catch { /* ignore */ }
  };

  const open = tasks.filter((t) => t.task_status !== 'completed');

  const filtered = open.filter((t) => {
    if (assigneeFilter === 'mine' && currentUserId) {
      if (t.task_assigned_user?.userId !== currentUserId) return false;
    }
    if (contactSearch.trim()) {
      const q = contactSearch.trim().toLowerCase();
      const name = (t.task_customer?.contactName ?? '').toLowerCase();
      if (!name.includes(q)) return false;
    }
    return true;
  });

  const overdue = open.filter(
    (t) => t.task_deadline && new Date(t.task_deadline).getTime() < todayMs,
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / TASKS_PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * TASKS_PER_PAGE;
  const visible = filtered.slice(pageStart, pageStart + TASKS_PER_PAGE);

  const filtersActive = assigneeFilter !== 'all' || contactSearch.trim() !== '';

  if (loading) {
    return (
      <Box sx={{ mb: 3 }}>
        <SectionHeader title="Tasks" />
        <SkeletonCard titleW="48%" />
        <SkeletonCard titleW="54%" />
      </Box>
    );
  }

  return (
    <Box sx={{ mb: 3 }}>
      <SectionHeader
        title="Tasks"
        badge={
          open.length ? (
            <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
              <Chip
                label={`${open.length} open`}
                size="small"
                color="default"
                variant="outlined"
                sx={{ height: 20 }}
              />
              {overdue.length ? (
                <Chip
                  label={`${overdue.length} overdue`}
                  size="small"
                  color="error"
                  variant="filled"
                  sx={{ height: 20 }}
                />
              ) : null}
            </Stack>
          ) : null
        }
      />

      <Stack direction="row" spacing={1} sx={{ mb: 1.5, alignItems: 'center' }}>
        <ToggleButtonGroup
          value={assigneeFilter}
          exclusive
          onChange={handleAssigneeFilter}
          size="small"
          aria-label="Assignee filter"
        >
          <ToggleButton value="all" sx={{ px: 1.5, py: 0.5, fontSize: '0.75rem', textTransform: 'none' }}>
            All
          </ToggleButton>
          <ToggleButton value="mine" sx={{ px: 1.5, py: 0.5, fontSize: '0.75rem', textTransform: 'none' }}>
            My tasks
          </ToggleButton>
        </ToggleButtonGroup>

        <TextField
          size="small"
          placeholder="Filter by contact…"
          value={contactSearch}
          onChange={handleContactSearch}
          sx={{ flex: 1, '& .MuiInputBase-input': { fontSize: '0.8125rem', py: '4px' } }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
                </InputAdornment>
              ),
              endAdornment: contactSearch ? (
                <InputAdornment position="end">
                  <IconButton size="small" onClick={clearContactSearch} edge="end" aria-label="Clear contact filter" sx={{ p: 0.25 }}>
                    <ClearIcon sx={{ fontSize: 14 }} />
                  </IconButton>
                </InputAdornment>
              ) : undefined,
            },
          }}
        />

        {filtersActive ? (
          <Button
            size="small"
            variant="text"
            onClick={clearFilters}
            sx={{ whiteSpace: 'nowrap', fontSize: '0.75rem', px: 1, py: 0.5, minWidth: 0, color: 'text.secondary' }}
          >
            Clear filters
          </Button>
        ) : null}
      </Stack>

      {filtered.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
          {filtersActive
            ? 'No tasks match the current filter.'
            : 'No open tasks — you\'re all clear.'}
        </Typography>
      ) : (
        <>
          {visible.map((t) => {
            const isOvr =
              !!t.task_deadline && new Date(t.task_deadline).getTime() < todayMs;
            const contactId = t.task_customer?.contactId;
            const contactName = t.task_customer?.contactName;
            return (
              <HomeCard
                key={t.id}
                onClick={
                  contactId
                    ? () => {
                        const openProject = (
                          window as unknown as { openProject?: (id: string, idx: number) => void }
                        ).openProject;
                        if (typeof openProject === 'function') openProject(contactId, 0);
                        else location.href = `/customers/${encodeURIComponent(contactId)}`;
                      }
                    : undefined
                }
              >
                <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
                  {t.task_name}
                </Typography>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 0.25 }}>
                  {t.task_deadline ? (
                    <Typography
                      variant="caption"
                      sx={{ color: isOvr ? 'error.main' : 'text.secondary' }}
                    >
                      {isOvr ? '⚠ Overdue · ' : ''}
                      {fmtDate(t.task_deadline)}
                    </Typography>
                  ) : null}
                  {contactName ? (
                    <Typography variant="caption" color="text.secondary" noWrap sx={{ minWidth: 0 }}>
                      · {contactName}
                    </Typography>
                  ) : null}
                </Stack>
                {t.task_assigned_user?.name && assigneeFilter !== 'mine' ? (
                  <Typography variant="caption" color="text.secondary">
                    Assigned to {t.task_assigned_user.name}
                  </Typography>
                ) : null}
              </HomeCard>
            );
          })}
          {totalPages > 1 ? (
            <Stack
              direction="row"
              sx={{ alignItems: 'center', justifyContent: 'center', mt: 0.5 }}
              spacing={1}
            >
              <IconButton
                size="small"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={safePage === 1}
                aria-label="Previous page"
              >
                <ChevronLeftIcon fontSize="small" />
              </IconButton>
              <Typography variant="caption" color="text.secondary">
                {safePage} / {totalPages}
              </Typography>
              <IconButton
                size="small"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={safePage === totalPages}
                aria-label="Next page"
              >
                <ChevronRightIcon fontSize="small" />
              </IconButton>
            </Stack>
          ) : null}
        </>
      )}
    </Box>
  );
}

function InvoicesSection({
  loading,
  error,
  errorMsg,
  invoices,
  todayMs,
  onRetry,
  connected,
  statusKnown,
}: {
  loading: boolean;
  error: boolean;
  errorMsg: string | null;
  invoices: InvoiceSummary[];
  todayMs: number;
  onRetry: () => void;
  connected: boolean;
  statusKnown: boolean;
}) {
  if (loading) {
    return (
      <Box sx={{ mb: 3 }}>
        <SectionHeader title="Overdue Invoices" />
        <SkeletonCard titleW="52%" badgeW={56} />
        <SkeletonCard titleW="40%" badgeW={48} />
      </Box>
    );
  }
  if (statusKnown && !connected) {
    return (
      <Box sx={{ mb: 3 }}>
        <SectionHeader title="Overdue Invoices" />
        <Alert
          severity="info"
          action={
            <Button size="small" color="inherit" href="/admin#tab-settings">
              Connect
            </Button>
          }
        >
          Connect QuickBooks to see overdue invoices
        </Alert>
      </Box>
    );
  }
  if (error) {
    return (
      <Box sx={{ mb: 3 }}>
        <SectionHeader title="Overdue Invoices" />
        <Alert
          severity="error"
          icon={<WarningAmberIcon fontSize="inherit" />}
          action={
            <Button size="small" color="inherit" startIcon={<RefreshIcon />} onClick={onRetry}>
              Retry
            </Button>
          }
        >
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            Invoices couldn't be loaded
          </Typography>
          <Typography variant="caption" sx={{ display: 'block' }}>
            {errorMsg || 'QuickBooks returned an unexpected error.'}
          </Typography>
        </Alert>
      </Box>
    );
  }
  const overdue = invoices
    .filter((inv) => inv.dueDate && new Date(inv.dueDate).getTime() < todayMs)
    .slice(0, 4);
  if (overdue.length === 0) return null;
  return (
    <Box sx={{ mb: 3 }}>
      <SectionHeader title="Overdue Invoices" linkLabel="See all" linkHref="/invoices" />
      {overdue.map((inv) => (
        <HomeCard
          key={inv.id}
          onClick={() => {
            const opener = (window as unknown as { openInvoicePanel?: (id: string) => void })
              .openInvoicePanel;
            if (typeof opener === 'function') opener(inv.id);
            else location.href = '/invoices';
          }}
        >
          <Stack direction="row" spacing={1} sx={{  alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="body2" noWrap sx={{  minWidth: 0, fontWeight: 600 }}>
              {inv.customerName || '—'}
            </Typography>
            <Chip label={formatCurrency(inv.balance)} size="small" color="error" sx={{ height: 20 }} />
          </Stack>
          {inv.dueDate ? (
            <Typography variant="caption" color="error.main">
              Due {fmtDate(inv.dueDate)}
            </Typography>
          ) : null}
        </HomeCard>
      ))}
    </Box>
  );
}

function ProjectsSection({
  loading,
  contacts,
  roomsByContact,
  workflow,
  contactsError,
  onRetry,
}: {
  loading: boolean;
  contacts: Contact[];
  roomsByContact: Record<string, Room[]>;
  workflow: WorkflowDef | null;
  contactsError: boolean;
  onRetry?: () => void;
}) {
  if (loading) {
    return (
      <Box data-testid="active-projects-section" sx={{ mb: 3 }}>
        <SectionHeader title="Active Projects" />
        <SkeletonCard titleW="44%" badgeW={52} />
        <SkeletonCard titleW="50%" badgeW={52} />
        <SkeletonCard titleW="38%" badgeW={52} />
      </Box>
    );
  }
  if (contactsError) {
    return (
      <Box data-testid="active-projects-section" sx={{ mb: 3 }}>
        <SectionHeader title="Active Projects" />
        <Alert
          severity="warning"
          action={
            onRetry ? (
              <Button color="inherit" size="small" onClick={onRetry}>
                Retry
              </Button>
            ) : undefined
          }
        >
          Unable to retrieve customer info
        </Alert>
      </Box>
    );
  }
  const active = contacts
    .filter((c) =>
      (roomsByContact[c.id] || []).some((r) => (r.roomStatus || 'active') === 'active'),
    )
    .slice(0, 6);
  if (active.length === 0) return null;
  return (
    <Box data-testid="active-projects-section" sx={{ mb: 3 }}>
      <SectionHeader title="Active Projects" linkLabel="All customers" linkHref="/projects" />
      {active.map((c) => {
        const rooms = (roomsByContact[c.id] || []).filter(
          (r) => (r.roomStatus || 'active') === 'active',
        );
        const stage = rooms[0]?.stageKey;
        const stageLbl = stage
          ? workflow?.stages?.[stage]?.label || STAGE_LABELS[stage as StageKey] || stage
          : null;
        return (
          <HomeCard
            key={c.id}
            onClick={() => {
              const open = (window as unknown as { openProject?: (id: string, idx: number) => void })
                .openProject;
              if (typeof open === 'function') open(c.id, 0);
              else location.href = `/customers/${encodeURIComponent(c.id)}`;
            }}
          >
            <Stack direction="row" spacing={1} sx={{  alignItems: 'center', justifyContent: 'space-between' }}>
              <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
                {contactDisplayName(c)}
              </Typography>
              {stageLbl ? (
                <Chip label={stageLbl} size="small" variant="outlined" sx={{ height: 20 }} />
              ) : null}
            </Stack>
            {rooms.length > 1 ? (
              <Typography variant="caption" color="text.secondary">
                {rooms.length} active rooms
              </Typography>
            ) : null}
          </HomeCard>
        );
      })}
    </Box>
  );
}

export function HomePage(): React.ReactElement {
  usePageTitle('Home · Measure Once');
  const now = new Date();
  const todayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const { isAdmin } = usePrivilege();
  const { user } = useAuth();
  const { devMode } = useDevMode({ enabled: isAdmin });

  const [tasks, setTasks] = React.useState<ContactTask[]>([]);
  const [tasksLoading, setTasksLoading] = React.useState(true);

  const { loading: qbLoading, loadError: qbError, error: qbErrorMsg, invoices: qbInvoices, company: qbCompany, connected: qbConnected, statusKnown: qbStatusKnown, refresh: loadInvoices, triggerLoad: triggerQBLoad } = useQBInvoices();
  React.useEffect(() => { triggerQBLoad(); }, [triggerQBLoad]);

  const { showToast } = useToastContext();

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    let changed = false;
    if (params.get('qb') === 'connected') {
      broadcastConnect();
      showToast(
        qbCompany
          ? `QuickBooks connected — ${qbCompany}`
          : 'QuickBooks connected successfully',
        false,
        { duration: 6000 },
      );
      params.delete('qb');
      changed = true;
    }
    if (params.get('connected') === 'true') {
      showToast('Google Calendar connected successfully', false, { duration: 6000 });
      params.delete('connected');
      changed = true;
    }
    if (params.get('error') === 'google_auth_failed') {
      showToast(
        'Google Calendar could not be connected. Please try again.',
        true,
        { duration: 8000 },
      );
      params.delete('error');
      changed = true;
    }
    if (changed) {
      const newSearch = params.toString();
      history.replaceState(null, '', newSearch ? `?${newSearch}` : window.location.pathname);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const { workflow } = useWorkflowData();

  const [projectsLoading, setProjectsLoading] = React.useState(true);
  const [projectsError, setProjectsError] = React.useState(false);
  const [contacts, setContacts] = React.useState<Contact[]>([]);
  const [roomsByContact, setRoomsByContact] = React.useState<Record<string, Room[]>>({});

  const loadTasks = React.useCallback(() => {
    setTasksLoading(true);
    jget<{ results: ContactTask[] }>('/api/tasks')
      .then((data) => setTasks(Array.isArray(data?.results) ? data.results : []))
      .catch(() => setTasks([]))
      .finally(() => setTasksLoading(false));
  }, []);

  const loadProjects = React.useCallback(() => {
    setProjectsLoading(true);
    setProjectsError(false);
    let contactsFailed = false;
    Promise.all([
      jget<{ results?: Contact[] }>('/api/contacts-all?page=1&limit=100').catch(
        () => {
          contactsFailed = true;
          return { results: [] } as { results?: Contact[] };
        },
      ),
      jget<Record<string, Room[]>>('/api/localdata/all').catch(
        () => ({} as Record<string, Room[]>),
      ),
    ])
      .then(async ([contactsResp, localdata]) => {
        let list = contactsResp?.results || [];
        // Offline fallback: if the live contacts fetch failed, fall back to the
        // customers list cached by the Customers page (IndexedDB). When we can
        // surface cached projects we no longer treat this as an error state.
        if (contactsFailed) {
          try {
            const cached = await readRecords<Contact>('customers');
            if (cached.length > 0) {
              list = cached;
              contactsFailed = false;
            }
          } catch {
            /* ignore cache-read errors */
          }
        }
        // Offline fallback for rooms: when /api/localdata/all has no entry for a
        // contact (e.g. its fetch failed offline), derive the room pills from
        // that contact's own cached `measure_once_rooms` property — mirrors
        // CustomersPage.resolveRooms so stage labels match the Customers page.
        const merged: Record<string, Room[]> = { ...(localdata || {}) };
        for (const c of list) {
          if (!merged[c.id] || merged[c.id].length === 0) {
            const parsed = parseContactRooms(c);
            if (parsed.length > 0) merged[c.id] = parsed;
          }
        }
        setContacts(list);
        setRoomsByContact(merged);
        setProjectsError(contactsFailed);
      })
      .finally(() => setProjectsLoading(false));
  }, []);

  React.useEffect(() => {
    loadTasks();
    loadProjects();
  }, [loadTasks, loadProjects]);

  return (
    <Box
      sx={{
        maxWidth: 640,
        mx: 'auto',
        width: '100%',
        px: 2,
        py: 2,
        boxSizing: 'border-box',
      }}
    >
      <DateHeader />
      {isAdmin && devMode && (
        <Alert
          id="dev-mode-banner"
          severity="warning"
          sx={{ borderRadius: 2, mb: 2 }}
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
      <TaskSection tasks={tasks} loading={tasksLoading} todayMs={todayMs} currentUserId={user?.id} />
      <InvoicesSection
        loading={qbLoading}
        error={qbError}
        errorMsg={qbErrorMsg}
        invoices={qbInvoices}
        todayMs={todayMs}
        onRetry={loadInvoices}
        connected={qbConnected}
        statusKnown={qbStatusKnown}
      />
      <ProjectsSection
        loading={projectsLoading}
        contacts={contacts}
        roomsByContact={roomsByContact}
        workflow={workflow}
        contactsError={projectsError}
        onRetry={loadProjects}
      />

    </Box>
  );
}

export default HomePage;
