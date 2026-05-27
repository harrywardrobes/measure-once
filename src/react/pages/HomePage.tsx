import React from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActionArea,
  Chip,
  Skeleton,
  Snackbar,
  Stack,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { EmptyState } from '../components/EmptyState';
import { useQBInvoices } from '../hooks/useQBInvoices';
import { broadcastConnect } from '../lib/qbInvoicesStore';
import type { InvoiceSummary } from '../components/InvoiceDetailDrawer';

// Ensure icon-lint scanner can detect these imports before apostrophe text below.
type _Icons = typeof RefreshIcon | typeof WarningAmberIcon;

type PersonalTask = {
  id: string;
  title: string;
  done?: boolean;
  dueDate?: string;
};

type CalendarEvent = {
  id?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
};

type CalendarResp = {
  events?: CalendarEvent[];
  connected?: boolean;
  error?: string;
  code?: string;
};

type Contact = {
  id: string;
  properties?: { firstname?: string; lastname?: string };
};
type Room = { room?: string; stageKey?: string; roomStatus?: string };
type WorkflowDef = { stages?: Record<string, { label?: string }> };

const DEFAULT_STAGE_LABELS: Record<string, string> = {
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

function fmtGBP(n: number): string {
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
        <CardActionArea onClick={onClick}>{content}</CardActionArea>
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

function TaskSection({
  tasks,
  loading,
  todayMs,
}: {
  tasks: PersonalTask[];
  loading: boolean;
  todayMs: number;
}) {
  if (loading) {
    return (
      <Box sx={{ mb: 3 }}>
        <SectionHeader title="My Tasks" />
        <SkeletonCard titleW="48%" />
        <SkeletonCard titleW="54%" />
      </Box>
    );
  }
  const overdue = tasks.filter(
    (t) => !t.done && t.dueDate && new Date(t.dueDate).getTime() < todayMs,
  );
  const today = tasks.filter(
    (t) =>
      !t.done &&
      t.dueDate &&
      new Date(t.dueDate).getTime() >= todayMs &&
      new Date(t.dueDate).getTime() < todayMs + 86400000,
  );
  const due = [...overdue, ...today];
  const visible = due.slice(0, 4);
  return (
    <Box sx={{ mb: 3 }}>
      <SectionHeader
        title="My Tasks"
        badge={
          overdue.length ? (
            <Chip
              label={`${overdue.length} overdue`}
              size="small"
              color="error"
              variant="filled"
              sx={{ height: 20 }}
            />
          ) : null
        }
        linkLabel="See all"
        linkHref="/calendar"
      />
      {due.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
          No tasks due today — you're all clear.
        </Typography>
      ) : (
        <>
          {visible.map((t) => {
            const isOvr = !!t.dueDate && new Date(t.dueDate).getTime() < todayMs;
            return (
              <HomeCard key={t.id} onClick={() => (location.href = '/calendar')}>
                <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
                  {t.title}
                </Typography>
                {t.dueDate ? (
                  <Typography
                    variant="caption"
                    sx={{ color: isOvr ? 'error.main' : 'text.secondary' }}
                  >
                    {isOvr ? '⚠ Overdue · ' : ''}
                    {fmtDate(t.dueDate)}
                  </Typography>
                ) : null}
              </HomeCard>
            );
          })}
          {due.length > 4 ? (
            <Button fullWidth size="small" onClick={() => (location.href = '/calendar')}>
              +{due.length - 4} more tasks
            </Button>
          ) : null}
        </>
      )}
    </Box>
  );
}

function CalendarSection({
  loading,
  error,
  errorCode,
  connected,
  events,
  onRetry,
}: {
  loading: boolean;
  error: boolean;
  errorCode: string | null;
  connected: boolean;
  events: CalendarEvent[];
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <Box sx={{ mb: 3 }}>
        <SectionHeader title="Upcoming" />
        <HomeCard disabled>
          <Skeleton variant="text" width="40%" height={12} />
          <Skeleton variant="text" width="60%" height={18} sx={{ mt: 0.5 }} />
        </HomeCard>
        <HomeCard disabled>
          <Skeleton variant="text" width="36%" height={12} />
          <Skeleton variant="text" width="50%" height={18} sx={{ mt: 0.5 }} />
        </HomeCard>
      </Box>
    );
  }
  if (error) {
    const authError = errorCode === 'GOOGLE_AUTH';
    return (
      <Box sx={{ mb: 3 }}>
        <SectionHeader title="Upcoming" />
        <Alert
          severity="error"
          icon={<WarningAmberIcon fontSize="inherit" />}
          action={
            authError ? (
              <Button size="small" color="inherit" href="/profile">
                Reconnect
              </Button>
            ) : (
              <Button size="small" color="inherit" startIcon={<RefreshIcon />} onClick={onRetry}>
                Retry
              </Button>
            )
          }
        >
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {authError ? 'Your Google account was disconnected' : "Calendar couldn't be loaded"}
          </Typography>
          <Typography variant="caption" sx={{ display: 'block' }}>
            {authError
              ? 'Reconnect Google to see your upcoming events.'
              : 'Google Calendar returned an unexpected error. Check your connection and try again.'}
          </Typography>
        </Alert>
      </Box>
    );
  }
  if (!connected) {
    return (
      <Box sx={{ mb: 3 }}>
        <SectionHeader title="Upcoming" />
        <Alert
          severity="info"
          action={
            <Button size="small" color="inherit" href="/profile">
              Connect
            </Button>
          }
        >
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            Connect Google Calendar to see upcoming events
          </Typography>
        </Alert>
      </Box>
    );
  }
  if (events.length === 0) {
    return (
      <Box sx={{ mb: 3 }}>
        <SectionHeader title="Upcoming" linkLabel="Calendar" linkHref="/calendar" />
        <EmptyState message="No upcoming events" />
      </Box>
    );
  }
  return (
    <Box sx={{ mb: 3 }}>
      <SectionHeader title="Upcoming" linkLabel="Calendar" linkHref="/calendar" />
      {events.slice(0, 3).map((ev, i) => {
        const start = ev.start?.dateTime || ev.start?.date;
        const d = start ? new Date(start) : null;
        const when = d
          ? d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) +
            (ev.start?.dateTime
              ? ' · ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
              : '')
          : '';
        return (
          <HomeCard key={ev.id || i}>
            {when ? (
              <Typography variant="caption" color="text.secondary">
                {when}
              </Typography>
            ) : null}
            <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
              {ev.summary || 'Event'}
            </Typography>
          </HomeCard>
        );
      })}
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
}: {
  loading: boolean;
  error: boolean;
  errorMsg: string | null;
  invoices: InvoiceSummary[];
  todayMs: number;
  onRetry: () => void;
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
            <Chip label={fmtGBP(inv.balance)} size="small" color="error" sx={{ height: 20 }} />
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
}: {
  loading: boolean;
  contacts: Contact[];
  roomsByContact: Record<string, Room[]>;
  workflow: WorkflowDef | null;
}) {
  if (loading) {
    return (
      <Box sx={{ mb: 3 }}>
        <SectionHeader title="Active Projects" />
        <SkeletonCard titleW="44%" badgeW={52} />
        <SkeletonCard titleW="50%" badgeW={52} />
        <SkeletonCard titleW="38%" badgeW={52} />
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
    <Box sx={{ mb: 3 }}>
      <SectionHeader title="Active Projects" linkLabel="All customers" linkHref="/projects" />
      {active.map((c) => {
        const rooms = (roomsByContact[c.id] || []).filter(
          (r) => (r.roomStatus || 'active') === 'active',
        );
        const stage = rooms[0]?.stageKey;
        const stageLbl = stage
          ? workflow?.stages?.[stage]?.label || DEFAULT_STAGE_LABELS[stage] || stage
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
  const now = new Date();
  const todayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  const [tasks, setTasks] = React.useState<PersonalTask[]>([]);
  const [tasksLoading, setTasksLoading] = React.useState(true);

  const [calLoading, setCalLoading] = React.useState(true);
  const [calError, setCalError] = React.useState(false);
  const [calErrorCode, setCalErrorCode] = React.useState<string | null>(null);
  const [calConnected, setCalConnected] = React.useState(false);
  const [calEvents, setCalEvents] = React.useState<CalendarEvent[]>([]);

  const { loading: qbLoading, loadError: qbError, error: qbErrorMsg, invoices: qbInvoices, company: qbCompany, refresh: loadInvoices, triggerLoad: triggerQBLoad } = useQBInvoices();
  React.useEffect(() => { triggerQBLoad(); }, [triggerQBLoad]);

  const [qbConnectedToast, setQbConnectedToast] = React.useState(false);
  const [googleConnectedToast, setGoogleConnectedToast] = React.useState(false);
  const [googleAuthErrorToast, setGoogleAuthErrorToast] = React.useState(false);

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    let changed = false;
    if (params.get('qb') === 'connected') {
      broadcastConnect();
      setQbConnectedToast(true);
      params.delete('qb');
      changed = true;
    }
    if (params.get('connected') === 'true') {
      setGoogleConnectedToast(true);
      params.delete('connected');
      changed = true;
    }
    if (params.get('error') === 'google_auth_failed') {
      setGoogleAuthErrorToast(true);
      params.delete('error');
      changed = true;
    }
    if (changed) {
      const newSearch = params.toString();
      history.replaceState(null, '', newSearch ? `?${newSearch}` : window.location.pathname);
    }
  }, []);

  const [projectsLoading, setProjectsLoading] = React.useState(true);
  const [contacts, setContacts] = React.useState<Contact[]>([]);
  const [roomsByContact, setRoomsByContact] = React.useState<Record<string, Room[]>>({});
  const [workflow, setWorkflow] = React.useState<WorkflowDef | null>(null);

  const loadTasks = React.useCallback(() => {
    setTasksLoading(true);
    jget<PersonalTask[]>('/api/personal-tasks')
      .then((rows) => setTasks(Array.isArray(rows) ? rows : []))
      .catch(() => setTasks([]))
      .finally(() => setTasksLoading(false));
  }, []);

  const loadCalendar = React.useCallback(() => {
    setCalLoading(true);
    setCalError(false);
    setCalErrorCode(null);
    jget<CalendarResp>('/api/calendar/upcoming')
      .then((cal) => {
        if (cal && cal.error) {
          setCalError(true);
          setCalErrorCode(cal.code || 'GOOGLE_ERROR');
          setCalConnected(!!cal.connected);
          setCalEvents([]);
        } else {
          setCalConnected(!!cal?.connected);
          setCalEvents((cal?.events as CalendarEvent[]) || []);
        }
      })
      .catch(() => {
        setCalError(true);
        setCalErrorCode('GOOGLE_ERROR');
        setCalConnected(false);
        setCalEvents([]);
      })
      .finally(() => setCalLoading(false));
  }, []);

  const loadProjects = React.useCallback(() => {
    setProjectsLoading(true);
    Promise.all([
      jget<WorkflowDef>('/api/workflow').catch(() => ({} as WorkflowDef)),
      jget<{ results?: Contact[] }>('/api/contacts-all?page=1&limit=100').catch(
        () => ({ results: [] } as { results?: Contact[] }),
      ),
      jget<Record<string, Room[]>>('/api/localdata/all').catch(
        () => ({} as Record<string, Room[]>),
      ),
    ])
      .then(([wf, contactsResp, localdata]) => {
        setWorkflow(wf || null);
        setContacts(contactsResp?.results || []);
        setRoomsByContact(localdata || {});
      })
      .finally(() => setProjectsLoading(false));
  }, []);

  React.useEffect(() => {
    loadTasks();
    loadCalendar();
    loadProjects();
  }, [loadTasks, loadCalendar, loadProjects]);

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
      <TaskSection tasks={tasks} loading={tasksLoading} todayMs={todayMs} />
      <CalendarSection
        loading={calLoading}
        error={calError}
        errorCode={calErrorCode}
        connected={calConnected}
        events={calEvents}
        onRetry={loadCalendar}
      />
      <InvoicesSection
        loading={qbLoading}
        error={qbError}
        errorMsg={qbErrorMsg}
        invoices={qbInvoices}
        todayMs={todayMs}
        onRetry={loadInvoices}
      />
      <ProjectsSection
        loading={projectsLoading}
        contacts={contacts}
        roomsByContact={roomsByContact}
        workflow={workflow}
      />

      {/* QuickBooks reconnect success toast */}
      <Snackbar
        open={qbConnectedToast}
        autoHideDuration={6000}
        onClose={() => setQbConnectedToast(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity="success"
          onClose={() => setQbConnectedToast(false)}
          variant="filled"
          sx={{ minWidth: 280 }}
        >
          {qbCompany
            ? `QuickBooks connected — ${qbCompany}`
            : 'QuickBooks connected successfully'}
        </Alert>
      </Snackbar>

      {/* Google Calendar reconnect success toast */}
      <Snackbar
        open={googleConnectedToast}
        autoHideDuration={6000}
        onClose={() => setGoogleConnectedToast(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity="success"
          onClose={() => setGoogleConnectedToast(false)}
          variant="filled"
          sx={{ minWidth: 280 }}
        >
          Google Calendar connected successfully
        </Alert>
      </Snackbar>

      {/* Google Calendar auth error toast */}
      <Snackbar
        open={googleAuthErrorToast}
        autoHideDuration={8000}
        onClose={() => setGoogleAuthErrorToast(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity="error"
          onClose={() => setGoogleAuthErrorToast(false)}
          variant="filled"
          sx={{ minWidth: 280 }}
        >
          Google Calendar could not be connected. Please try again.
        </Alert>
      </Snackbar>
    </Box>
  );
}

export default HomePage;
