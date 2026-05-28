import React from 'react';
import { usePrivilege } from '../hooks/usePrivilege';
import { useDevMode } from '../hooks/useDevMode';
import { usePrefs } from '../hooks/usePrefs';
import { useConnectionCheck, useConnectionToast } from '../context/ConnectionToastContext';
import {
  Alert,
  Box,
  Button,
  Card,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Snackbar,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DateTimePicker } from '@mui/x-date-pickers/DateTimePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import AddIcon from '@mui/icons-material/Add';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CloseIcon from '@mui/icons-material/Close';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import AppleIcon from '@mui/icons-material/Apple';
import MailOutlineIcon from '@mui/icons-material/MailOutlined';
import CheckIcon from '@mui/icons-material/Check';

// ── Types ────────────────────────────────────────────────────────────────────

type Visit = {
  id: number;
  type: string;
  customerId?: string | null;
  customerName?: string | null;
  title?: string | null;
  startAt: string;
  endAt: string;
  location?: string | null;
  notes?: string | null;
  assigneeId?: string | null;
  assigneeRole?: string | null;
  isWorkshop?: boolean;
};

type PlatformUser = {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
};

type Contact = {
  id: string;
  properties?: { firstname?: string; lastname?: string; email?: string };
};

type PersonalTask = { id: string; title: string; done?: boolean; dueDate?: string | null };

// ── Constants ────────────────────────────────────────────────────────────────

const VISIT_TYPE_META: Record<string, { label: string; color: string }> = {
  design: { label: 'Design visit', color: '#3b82f6' },
  survey: { label: 'Survey', color: '#f59e0b' },
  installation: { label: 'Installation', color: '#10b981' },
  remedial: { label: 'Remedial', color: '#ef4444' },
  workshop: { label: 'Workshop time', color: '#8b5cf6' },
  other: { label: 'Other', color: '#6b7280' },
};
const DAY_START_HOUR = 7;
const DAY_END_HOUR = 20;

const ASSIGNEE_ROLES = ['designer', 'surveyor', 'fitter', 'manager'];

// ── Date helpers ─────────────────────────────────────────────────────────────

function startOfDay(d: Date) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays(d: Date, n: number) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function startOfWeek(d: Date) {
  const x = startOfDay(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
function startOfMonth(d: Date) { return new Date(d.getFullYear(), d.getMonth(), 1); }

function fmtTime(d: Date) {
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// ── API helper ───────────────────────────────────────────────────────────────

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  if (r.status === 401) {
    const data = await r.json().catch(() => ({}));
    if (data?.code === 'GOOGLE_AUTH' || data?.code === 'GOOGLE_ERROR') {
      const err = new Error(data.error || 'Google authentication required');
      (err as { code?: string }).code = data.code;
      throw err;
    }
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error((data as { error?: string }).error || `HTTP ${r.status}`);
    (err as { code?: string }).code = (data as { code?: string }).code;
    throw err;
  }
  return data as T;
}

function showToast(msg: string, isError = false) {
  const w = window as unknown as { showToast?: (m: string, e?: boolean) => void };
  if (typeof w.showToast === 'function') w.showToast(msg, isError);
  else console.log('[toast]', msg);
}

function contactDisplayName(c: Contact): string {
  const p = c.properties || {};
  const n = `${p.firstname || ''} ${p.lastname || ''}`.trim();
  return n || p.email || `Contact ${c.id}`;
}

// ── Sync providers (placeholder UI) ──────────────────────────────────────────

const SYNC_PROVIDERS = [
  { id: 'google', name: 'Google Calendar', desc: 'Sync events from your Google account.', Icon: CalendarMonthIcon, color: '#4285F4' },
  { id: 'outlook', name: 'Microsoft Outlook', desc: 'Sync events from your Outlook account.', Icon: MailOutlineIcon, color: '#0078D4' },
  { id: 'apple', name: 'Apple Calendar', desc: 'Sync events from your iCloud account.', Icon: AppleIcon, color: '#1C1C1E' },
];

// ── Calendar Page ────────────────────────────────────────────────────────────

export function CalendarPage(): React.ReactElement {
  useConnectionCheck();
  const { notifyApiError } = useConnectionToast();
  const { isViewer, isAdmin } = usePrivilege();
  const { devMode } = useDevMode({ enabled: isAdmin });
  const { prefs, loading: prefsLoading, patchPref } = usePrefs();
  const [cursor, setCursor] = React.useState<Date>(() => startOfDay(new Date()));
  const [showWorkshop, setShowWorkshop] = React.useState<boolean>(true);
  const [visits, setVisits] = React.useState<Visit[]>([]);
  const [tasks, setTasks] = React.useState<PersonalTask[]>([]);
  const [platformUsers, setPlatformUsers] = React.useState<PlatformUser[]>([]);
  const [contacts, setContacts] = React.useState<Contact[]>([]);
  const [googleConnected, setGoogleConnected] = React.useState<boolean>(false);
  const [googleConnectedToast, setGoogleConnectedToast] = React.useState<boolean>(false);
  const [loading, setLoading] = React.useState<boolean>(true);
  const [error, setError] = React.useState<{ msg: string; db: boolean } | null>(null);

  const [modal, setModal] = React.useState<{ open: boolean; visit: Visit | null; prefillDate?: string | null }>({
    open: false, visit: null, prefillDate: null,
  });

  const [showAddTask, setShowAddTask] = React.useState<boolean>(false);
  const [reloadNonce, setReloadNonce] = React.useState<number>(0);

  const weekStart = React.useMemo(() => startOfWeek(cursor), [cursor]);
  const weekEnd = React.useMemo(() => addDays(weekStart, 7), [weekStart]);

  // Apply workshop pref once prefs have loaded.
  const workshopPrefAppliedRef = React.useRef(false);
  React.useEffect(() => {
    if (prefsLoading || workshopPrefAppliedRef.current) return;
    workshopPrefAppliedRef.current = true;
    if ('calShowWorkshop' in prefs) setShowWorkshop(!!prefs.calShowWorkshop);
  }, [prefsLoading, prefs]);

  // Detect ?connected=true from Google OAuth redirect and show a success toast.
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('connected') === 'true') {
      setGoogleConnectedToast(true);
      params.delete('connected');
      const newSearch = params.toString();
      history.replaceState(null, '', newSearch ? `?${newSearch}` : window.location.pathname);
    }
  }, []);

  // Check Google auth status once on mount.
  React.useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/status', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => { if (!cancelled && s) setGoogleConnected(!!s.google); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Load visits + tasks + users when the week changes or after a refresh.
  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      api<Visit[]>('GET', `/api/visits?from=${weekStart.toISOString()}&to=${weekEnd.toISOString()}`),
      api<PersonalTask[]>('GET', '/api/personal-tasks').catch(() => []),
      api<PlatformUser[]>('GET', '/api/platform-users').catch(() => []),
    ])
      .then(([v, t, u]) => {
        if (cancelled) return;
        setVisits(v || []);
        setTasks(t || []);
        setPlatformUsers(u || []);
        setLoading(false);
      })
      .catch((e: Error & { code?: string }) => {
        if (cancelled) return;
        notifyApiError('google', e);
        setError({ msg: e.message, db: e.code === 'DB_ERROR' });
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [weekStart, weekEnd, reloadNonce]);

  // Lazy-load contacts (used by the visit modal customer picker) — once.
  const contactsLoadedRef = React.useRef(false);
  const ensureContacts = React.useCallback(() => {
    if (contactsLoadedRef.current) return;
    contactsLoadedRef.current = true;
    api<{ results?: Contact[] }>('GET', '/api/contacts-all?limit=2000')
      .then((d) => setContacts((d?.results || []) as Contact[]))
      .catch(() => {});
  }, []);

  const reload = React.useCallback(() => setReloadNonce((n) => n + 1), []);

  const onToggleWorkshop = (checked: boolean) => {
    setShowWorkshop(checked);
    void patchPref('calShowWorkshop', checked);
  };

  const openVisitModal = (visit: Visit | null, prefillDate?: string | null) => {
    if (isViewer) return;
    ensureContacts();
    setModal({ open: true, visit, prefillDate: prefillDate || null });
  };
  const closeVisitModal = () => setModal({ open: false, visit: null, prefillDate: null });

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Box sx={{ maxWidth: 960, mx: 'auto', px: { xs: 1, sm: 2 }, pt: 1, pb: 4 }}>
      {isAdmin && devMode && (
        <Alert
          id="dev-mode-banner"
          severity="warning"
          sx={{ borderRadius: 2, mb: 1.5 }}
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
      <SyncSection />
      <CalendarHeader
        cursor={cursor}
        showWorkshop={showWorkshop}
        onPrev={() => setCursor((c) => addDays(c, -7))}
        onNext={() => setCursor((c) => addDays(c, 7))}
        onToday={() => setCursor(startOfDay(new Date()))}
        onWorkshopChange={onToggleWorkshop}
        isViewer={isViewer}
        onNewVisit={() => openVisitModal(null)}
      />
      <TopPanel
        cursor={cursor}
        visits={visits}
        showWorkshop={showWorkshop}
        onPickDay={(iso) => {
          setCursor(new Date(iso));
          openVisitModal(null, iso);
        }}
      />
      <Box sx={{ px: { xs: 0, sm: 1.5 } }}>
        {loading ? (
          <Stack direction="row" spacing={1} sx={{  p: 2, color: 'text.secondary', alignItems: 'center' }}>
            <CircularProgress size={16} />
            <Typography variant="body2">Loading…</Typography>
          </Stack>
        ) : error ? (
          <Box sx={{ textAlign: 'center', p: 4 }}>
            <Alert severity="error" sx={{ mb: 1.5, textAlign: 'left' }}>
              {error.db
                ? "The calendar couldn't be loaded — there was a problem reaching the database."
                : `Failed to load calendar: ${error.msg}`}
            </Alert>
            <Button variant="outlined" size="small" onClick={reload}>Retry</Button>
            {error.db && (
              <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'text.secondary' }}>
                If this keeps happening, try refreshing the page.
              </Typography>
            )}
          </Box>
        ) : (
          <AgendaView
            weekStart={weekStart}
            visits={visits}
            showWorkshop={showWorkshop}
            platformUsers={platformUsers}
            onDayClick={(iso) => openVisitModal(null, iso)}
            onVisitClick={(v) => openVisitModal(v)}
          />
        )}
      </Box>

      <PersonalTasksSection
        tasks={tasks}
        showAdd={showAddTask}
        onShowAdd={setShowAddTask}
        onChange={setTasks}
      />

      {modal.open && (
        <VisitModal
          visit={modal.visit}
          prefillDate={modal.prefillDate || null}
          contacts={contacts}
          platformUsers={platformUsers}
          googleConnected={googleConnected}
          onClose={closeVisitModal}
          onSaved={() => { closeVisitModal(); reload(); }}
        />
      )}

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
    </Box>
  );
}

// ── Header ───────────────────────────────────────────────────────────────────

function headerTitle(cursor: Date) {
  const s = startOfWeek(cursor); const e = addDays(s, 6);
  if (s.getMonth() === e.getMonth()) {
    return `${s.getDate()}–${e.getDate()} ${s.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}`;
  }
  return `${s.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${e.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

function CalendarHeader(props: {
  cursor: Date;
  showWorkshop: boolean;
  isViewer: boolean;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onWorkshopChange: (b: boolean) => void;
  onNewVisit: () => void;
}) {
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={1.5}
      sx={{ px: { xs: 1, sm: 1.5 }, py: 1.5, alignItems: { xs: 'stretch', sm: 'center' } }}
    >
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
        <IconButton aria-label="Previous week" size="small" onClick={props.onPrev}><ChevronLeftIcon /></IconButton>
        <Button size="small" variant="outlined" onClick={props.onToday}>Today</Button>
        <IconButton aria-label="Next week" size="small" onClick={props.onNext}><ChevronRightIcon /></IconButton>
        <Typography data-testid="cal-header-title" variant="subtitle1" sx={{ ml: 1, fontWeight: 600 }}>{headerTitle(props.cursor)}</Typography>
      </Stack>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
        <FormControlLabel
          control={<Box component="span" data-testid="cal-workshop-wrap"><Switch checked={props.showWorkshop} onChange={(e) => props.onWorkshopChange(e.target.checked)} size="small" /></Box>}
          label={<Typography variant="body2">Workshop time</Typography>}
          sx={{ m: 0 }}
        />
        {!props.isViewer && (
          <Button
            variant="contained"
            color="primary"
            size="small"
            startIcon={<AddIcon />}
            onClick={props.onNewVisit}
          >
            New visit
          </Button>
        )}
      </Stack>
    </Stack>
  );
}

// ── Sync section ─────────────────────────────────────────────────────────────

function SyncSection() {
  return (
    <Box component="section" aria-labelledby="cal-sync-title" sx={{ px: { xs: 1, sm: 1.5 }, py: 2 }}>
      <Typography id="cal-sync-title" variant="h6" sx={{ fontSize: '1rem', fontWeight: 700 }}>
        Sync your calendar
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Connect a calendar so your visits stay in sync with the rest of your day.
      </Typography>
      <Box sx={{ display: 'grid', gap: 1.25, gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' } }}>
        {SYNC_PROVIDERS.map((p) => (
          <Card key={p.id} variant="outlined" sx={{ p: 1.5, display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <Box sx={{
              width: 36, height: 36, borderRadius: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              bgcolor: 'action.hover', color: p.color, flexShrink: 0,
            }}>
              <p.Icon />
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>{p.name}</Typography>
              <Typography variant="caption" color="text.secondary" noWrap>{p.desc}</Typography>
            </Box>
            <Button
              size="small"
              variant="outlined"
              onClick={() => showToast(`${p.name} sync is coming soon`)}
            >
              Connect
            </Button>
          </Card>
        ))}
      </Box>
    </Box>
  );
}

// ── Top panel: mini months + stats ──────────────────────────────────────────

function TopPanel(props: {
  cursor: Date;
  visits: Visit[];
  showWorkshop: boolean;
  onPickDay: (iso: string) => void;
}) {
  const { cursor, visits, showWorkshop, onPickDay } = props;
  const today = new Date();
  const todayMs = startOfDay(today).getTime();
  const month1 = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const month2 = new Date(month1.getFullYear(), month1.getMonth() + 1, 1);

  const typeCounts: Record<string, number> = {};
  let totalHours = 0;
  for (const v of visits) {
    if (!showWorkshop && v.isWorkshop) continue;
    typeCounts[v.type] = (typeCounts[v.type] || 0) + 1;
    totalHours += (new Date(v.endAt).getTime() - new Date(v.startAt).getTime()) / 3600000;
  }
  const totalVisits = Object.values(typeCounts).reduce((a, b) => a + b, 0);

  const stats = (
    <Box sx={{ minWidth: 160 }}>
      <Typography variant="overline" sx={{ color: 'text.secondary', display: 'block', mb: 0.5 }}>
        This period
      </Typography>
      {Object.entries(VISIT_TYPE_META).map(([k, m]) =>
        typeCounts[k] ? (
          <Stack key={k} direction="row" spacing={1} sx={{  py: 0.25, alignItems: 'center' }}>
            <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: m.color }} />
            <Typography variant="body2" sx={{ flex: 1 }}>{m.label}</Typography>
            <Typography variant="body2" sx={{ fontWeight: 700 }}>{typeCounts[k]}</Typography>
          </Stack>
        ) : null,
      )}
      {totalVisits === 0 ? (
        <Typography variant="body2" sx={{ color: 'text.secondary', fontStyle: 'italic' }}>
          No visits this period
        </Typography>
      ) : (
        <Typography variant="body2" sx={{ mt: 1, pt: 1, borderTop: '1px solid', borderColor: 'divider', fontWeight: 600, color: 'text.secondary' }}>
          {totalHours.toFixed(1)} hrs total
        </Typography>
      )}
    </Box>
  );

  const renderMini = (month: Date) => {
    const first = startOfMonth(month);
    const gridStart = addDays(first, -((first.getDay() + 6) % 7));
    const cells: React.ReactElement[] = [];
    for (let i = 0; i < 42; i++) {
      const d = addDays(gridStart, i);
      const inMonth = d.getMonth() === first.getMonth();
      const dMs = startOfDay(d).getTime();
      const isToday = dMs === todayMs;
      const isCursor = dMs === startOfDay(cursor).getTime();
      const dayStart = startOfDay(d);
      const dayEnd = addDays(dayStart, 1);
      const dots = visits.filter((v) => {
        const s = new Date(v.startAt), e = new Date(v.endAt);
        return s < dayEnd && e > dayStart && (showWorkshop || !v.isWorkshop);
      }).slice(0, 3);
      cells.push(
        <Box
          key={i}
          onClick={() => onPickDay(dayStart.toISOString())}
          sx={{
            cursor: 'pointer',
            p: 0.5,
            borderRadius: 0.75,
            minHeight: 32,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 0.25,
            opacity: inMonth ? 1 : 0.3,
            bgcolor: isCursor ? 'action.selected' : 'transparent',
            '&:hover': { bgcolor: 'action.hover' },
          }}
        >
          <Box
            component="span"
            sx={{
              fontSize: 12,
              fontWeight: isCursor ? 700 : 600,
              ...(isToday && {
                bgcolor: 'text.primary', color: 'background.paper',
                borderRadius: '50%', width: 18, height: 18,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              }),
            }}
          >
            {d.getDate()}
          </Box>
          <Box sx={{ display: 'flex', gap: '1px' }}>
            {dots.map((v, idx) => (
              <Box key={idx} sx={{ width: 4, height: 4, borderRadius: '50%', bgcolor: (VISIT_TYPE_META[v.type] || VISIT_TYPE_META.other).color }} />
            ))}
          </Box>
        </Box>,
      );
    }
    const headers = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
    return (
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 700, textAlign: 'center', mb: 0.5 }}>
          {month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}
        </Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 0.25 }}>
          {headers.map((h, i) => (
            <Box key={`h${i}`} sx={{ textAlign: 'center', fontSize: 10, fontWeight: 700, color: 'text.secondary' }}>
              {h}
            </Box>
          ))}
          {cells}
        </Box>
      </Box>
    );
  };

  return (
    <Box sx={{ px: { xs: 1, sm: 1.5 }, pb: 1.5 }}>
      {/* Mobile: collapsed dropdown for stats only */}
      <Box sx={{ display: { xs: 'block', md: 'none' } }}>
        <Card variant="outlined" sx={{ p: 1.5 }}>
          <details>
            <Box component="summary" sx={{ cursor: 'pointer', fontWeight: 600, fontSize: 14 }}>
              Schedule overview · {totalVisits} visits
            </Box>
            <Box sx={{ pt: 1 }}>{stats}</Box>
          </details>
        </Card>
      </Box>
      {/* Desktop: two months + stats */}
      <Card
        variant="outlined"
        sx={{ p: 1.5, display: { xs: 'none', md: 'flex' }, gap: 3, alignItems: 'flex-start' }}
      >
        {renderMini(month1)}
        {renderMini(month2)}
        {stats}
      </Card>
    </Box>
  );
}

// ── Agenda ───────────────────────────────────────────────────────────────────

function AgendaView(props: {
  weekStart: Date;
  visits: Visit[];
  showWorkshop: boolean;
  platformUsers: PlatformUser[];
  onDayClick: (iso: string) => void;
  onVisitClick: (v: Visit) => void;
}) {
  const { weekStart, visits, showWorkshop, platformUsers, onDayClick, onVisitClick } = props;
  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(weekStart, i));
  const todayMs = startOfDay(new Date()).getTime();
  const SPAN = DAY_END_HOUR - DAY_START_HOUR;

  return (
    <Stack spacing={1.25}>
      {days.map((day) => {
        const dayStart = startOfDay(day);
        const dayEnd = addDays(dayStart, 1);
        const isToday = dayStart.getTime() === todayMs;
        const dayVisits = visits.filter((v) => {
          if (!showWorkshop && v.isWorkshop) return false;
          const s = new Date(v.startAt), e = new Date(v.endAt);
          return s < dayEnd && e > dayStart;
        });
        const isoDay = dayStart.toISOString();

        return (
          <Card
            key={isoDay}
            variant="outlined"
            data-testid="cal-day-card"
            data-iso={isoDay}
            data-visit-count={dayVisits.length}
            onClick={() => onDayClick(isoDay)}
            sx={{
              cursor: 'pointer',
              overflow: 'hidden',
              transition: 'background 0.1s',
              ...(isToday && { borderColor: 'primary.main', boxShadow: (t) => `0 0 0 1px ${t.palette.primary.main}` }),
              '&:hover': { bgcolor: 'action.hover' },
            }}
          >
            <Stack
              direction="row"


              sx={{ px: 1.5, py: 1.25, borderBottom: '1px solid', borderColor: 'divider', ...(isToday && { bgcolor: 'primary.main', color: 'primary.contrastText', opacity: 0.95 }) }}
            >
              <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center' }}>
                <Box
                  component="span"
                  sx={{
                    fontSize: '1.3rem', fontWeight: 700, lineHeight: 1, minWidth: 32,
                    ...(isToday && {
                      bgcolor: 'background.paper', color: 'primary.main',
                      borderRadius: '50%', width: 34, height: 34,
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '1rem',
                    }),
                  }}
                >
                  {day.getDate()}
                </Box>
                <Stack direction="row" spacing={0.75} sx={{ alignItems: 'baseline' }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {day.toLocaleDateString('en-GB', { weekday: 'long' })}
                  </Typography>
                  {isToday && (
                    <Typography variant="caption" sx={{ fontWeight: 700, opacity: 0.9 }}>
                      Today
                    </Typography>
                  )}
                </Stack>
              </Stack>
              {dayVisits.length > 0 && (
                <Chip
                  label={`${dayVisits.length} visit${dayVisits.length > 1 ? 's' : ''}`}
                  size="small"
                  sx={{ ...(isToday && { bgcolor: 'background.paper', color: 'primary.main' }) }}
                />
              )}
            </Stack>

            {dayVisits.length === 0 ? (
              <Typography variant="body2" sx={{ p: 1.5, color: 'text.secondary', fontStyle: 'italic' }}>
                No visits scheduled
              </Typography>
            ) : (
              <>
                {/* Mini timeline */}
                <Box sx={{ position: 'relative', height: 18, mx: 1.5, mt: 1, borderRadius: 0.5, bgcolor: 'action.hover', overflow: 'hidden' }}>
                  {dayVisits.map((v, i) => {
                    const s = new Date(v.startAt), e = new Date(v.endAt);
                    const sh = Math.max(s.getHours() + s.getMinutes() / 60, DAY_START_HOUR);
                    const eh = Math.min(e.getHours() + e.getMinutes() / 60, DAY_END_HOUR);
                    const left = ((sh - DAY_START_HOUR) / SPAN) * 100;
                    const width = Math.max(1, ((eh - sh) / SPAN) * 100);
                    const m = VISIT_TYPE_META[v.type] || VISIT_TYPE_META.other;
                    return (
                      <Box
                        key={i}
                        sx={{
                          position: 'absolute', top: 3, bottom: 3,
                          left: `${left.toFixed(2)}%`, width: `${width.toFixed(2)}%`,
                          bgcolor: m.color, opacity: 0.85, borderRadius: 0.5, minWidth: 3,
                        }}
                      />
                    );
                  })}
                </Box>
                <Stack direction="row" sx={{  px: 1.5, pt: 0.25, color: 'text.secondary', justifyContent: 'space-between' }}>
                  <Typography variant="caption">{DAY_START_HOUR}:00</Typography>
                  <Typography variant="caption">{Math.floor((DAY_START_HOUR + DAY_END_HOUR) / 2)}:00</Typography>
                  <Typography variant="caption">{DAY_END_HOUR}:00</Typography>
                </Stack>
                <Stack sx={{ px: 1, py: 1 }} spacing={0.5}>
                  {dayVisits.map((v) => (
                    <AgendaRow key={v.id} visit={v} platformUsers={platformUsers} onClick={() => onVisitClick(v)} testId={`cal-visit-row-${v.id}`} />
                  ))}
                </Stack>
              </>
            )}
          </Card>
        );
      })}
    </Stack>
  );
}

function AgendaRow({ visit, platformUsers, onClick, testId }: { visit: Visit; platformUsers: PlatformUser[]; onClick: () => void; testId?: string }) {
  const meta = VISIT_TYPE_META[visit.type] || VISIT_TYPE_META.other;
  const s = new Date(visit.startAt), e = new Date(visit.endAt);
  const customer = visit.customerName || visit.title || '—';
  const assignee = platformUsers.find((u) => u.id === visit.assigneeId);
  const assigneeName = assignee ? `${assignee.firstName || ''} ${assignee.lastName || ''}`.trim() || assignee.email : null;
  const roleLabel = visit.assigneeRole
    ? visit.assigneeRole.charAt(0).toUpperCase() + visit.assigneeRole.slice(1)
    : null;
  const assigneeLabel = roleLabel
    ? `${roleLabel}${assigneeName ? ' · ' + assigneeName : ''}`
    : assigneeName;

  return (
    <Stack
      direction="row"

      spacing={1.25}
      data-testid={testId}
      data-visit-id={visit.id}
      onClick={(ev) => { ev.stopPropagation(); onClick(); }}
      sx={{
        p: 1, borderRadius: 1, cursor: 'pointer',
        '&:hover': { bgcolor: 'action.selected' },
      }}
    >
      <Box sx={{ width: 4, alignSelf: 'stretch', minHeight: 28, borderRadius: 0.5, bgcolor: meta.color, flexShrink: 0 }} />
      <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, minWidth: 90, whiteSpace: 'nowrap' }}>
        {fmtTime(s)} – {fmtTime(e)}
      </Typography>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={0.75} sx={{  flexWrap: 'wrap', alignItems: 'center' }}>
          <Chip label={meta.label} size="small" sx={{ bgcolor: meta.color, color: '#fff', height: 18, fontSize: 11 }} />
          <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>{customer}</Typography>
        </Stack>
        {(visit.location || assigneeLabel) && (
          <Stack direction="row" spacing={1} sx={{  mt: 0.25, color: 'text.secondary', alignItems: 'center' }}>
            {visit.location && <Typography variant="caption">📍 {visit.location}</Typography>}
            {assigneeLabel && <Chip label={assigneeLabel} size="small" variant="outlined" sx={{ height: 18, fontSize: 11 }} />}
          </Stack>
        )}
      </Box>
    </Stack>
  );
}

// ── Personal tasks ───────────────────────────────────────────────────────────

function PersonalTasksSection(props: {
  tasks: PersonalTask[];
  showAdd: boolean;
  onShowAdd: (b: boolean) => void;
  onChange: (next: PersonalTask[]) => void;
}) {
  const { tasks, showAdd, onShowAdd, onChange } = props;
  const pending = tasks.filter((t) => !t.done);
  const [title, setTitle] = React.useState('');
  const [due, setDue] = React.useState('');

  const submit = async () => {
    const t = title.trim();
    if (!t) return;
    try {
      const task = await api<PersonalTask>('POST', '/api/personal-tasks', { title: t, dueDate: due || null });
      onChange([...tasks, task]);
      setTitle(''); setDue(''); onShowAdd(false);
    } catch { showToast('Failed to save task', true); }
  };

  const toggle = async (id: string) => {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    try {
      const updated = await api<PersonalTask>('PATCH', `/api/personal-tasks/${id}`, { done: !t.done });
      onChange(tasks.map((x) => (x.id === id ? { ...x, ...updated } : x)));
    } catch { showToast('Failed to update task', true); }
  };

  const del = async (id: string) => {
    try {
      await api('DELETE', `/api/personal-tasks/${id}`);
      onChange(tasks.filter((x) => x.id !== id));
    } catch { showToast('Failed to delete task', true); }
  };

  return (
    <Box sx={{ mt: 3, px: { xs: 1, sm: 1.5 } }}>
      <Box component="details" data-testid="cal-tasks">
        <Box
          component="summary"
          data-testid="cal-tasks-summary"
          sx={{ cursor: 'pointer', fontWeight: 600, fontSize: 14, py: 0.5, color: 'text.primary' }}
        >
          Personal tasks{pending.length ? ` (${pending.length})` : ''}
        </Box>
        <Box sx={{ pt: 1 }}>
          {showAdd ? (
            <Card variant="outlined" sx={{ p: 1.5, mb: 1.5 }}>
              <TextField
                fullWidth
                size="small"
                placeholder="Task title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                autoFocus
              />
              <Stack direction="row" spacing={1} sx={{  mt: 1, alignItems: 'center' }}>
                <TextField
                  type="date"
                  size="small"
                  value={due}
                  onChange={(e) => setDue(e.target.value)}
                />
                <Box sx={{ flex: 1 }} />
                <Button size="small" onClick={() => { setTitle(''); setDue(''); onShowAdd(false); }}>Cancel</Button>
                <Button size="small" variant="contained" onClick={submit}>Add task</Button>
              </Stack>
            </Card>
          ) : (
            <Button
              fullWidth
              variant="outlined"
              startIcon={<AddIcon />}
              onClick={() => onShowAdd(true)}
              data-testid="cal-task-add-btn"
              sx={{ borderStyle: 'dashed', justifyContent: 'flex-start', mb: 1.5 }}
            >
              Add task
            </Button>
          )}
          {tasks.length === 0 ? (
            <Typography variant="body2" data-testid="cal-tasks-empty" sx={{ color: 'text.secondary', py: 1 }}>
              No personal tasks.
            </Typography>
          ) : (
            <Stack spacing={0.75} data-testid="cal-tasks-list">
              {tasks.map((t) => (
                <PersonalTaskRow key={t.id} task={t} onToggle={() => toggle(t.id)} onDelete={() => del(t.id)} />
              ))}
            </Stack>
          )}
        </Box>
      </Box>
    </Box>
  );
}

function PersonalTaskRow({ task, onToggle, onDelete }: { task: PersonalTask; onToggle: () => void; onDelete: () => void }) {
  const testId = `cal-task-row-${task.id}`;
  const overdue = !task.done && task.dueDate && task.dueDate < new Date().toISOString().slice(0, 10);
  const dueFmt = task.dueDate
    ? new Date(task.dueDate + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : '';
  return (
    <Card
      variant="outlined"
      data-testid={testId}
      data-task-id={task.id}
      data-task-done={task.done ? '1' : '0'}
      sx={{
        p: 1, display: 'flex', alignItems: 'flex-start', gap: 1.25,
        opacity: task.done ? 0.55 : 1,
      }}
    >
      <Checkbox
        size="small"
        checked={!!task.done}
        onChange={onToggle}
        className={`cal-task-checkbox-${task.id}`}
        icon={<Box sx={{ width: 18, height: 18, borderRadius: '50%', border: '1.5px solid', borderColor: 'text.secondary' }} />}
        checkedIcon={<Box sx={{ width: 18, height: 18, borderRadius: '50%', bgcolor: 'success.main', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><CheckIcon sx={{ fontSize: 14 }} /></Box>}
        sx={{ p: 0.25 }}
      />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 600, textDecoration: task.done ? 'line-through' : 'none' }}>
          {task.title}
        </Typography>
        {dueFmt && (
          <Typography variant="caption" sx={{ color: overdue ? 'error.main' : 'text.secondary' }}>
            {overdue ? 'Overdue — ' : ''}{dueFmt}
          </Typography>
        )}
      </Box>
      <IconButton size="small" aria-label="Delete task" data-testid={`${testId}-delete`} onClick={onDelete}>
        <DeleteOutlineIcon fontSize="small" />
      </IconButton>
    </Card>
  );
}

// ── Visit modal ──────────────────────────────────────────────────────────────

function VisitModal(props: {
  visit: Visit | null;
  prefillDate: string | null;
  contacts: Contact[];
  platformUsers: PlatformUser[];
  googleConnected: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { visit, prefillDate, contacts, platformUsers, googleConnected, onClose, onSaved } = props;
  const existing = visit;
  const initialStart = existing ? new Date(existing.startAt) : (prefillDate ? new Date(prefillDate) : new Date());
  const initialEnd = existing ? new Date(existing.endAt) : new Date(initialStart.getTime() + 60 * 60 * 1000);

  const [type, setType] = React.useState<string>(existing?.type || 'design');
  const [customerId, setCustomerId] = React.useState<string>(existing?.customerId || '');
  const [title, setTitle] = React.useState<string>(existing?.title || '');
  const [startDt, setStartDt] = React.useState<Dayjs | null>(dayjs(initialStart));
  const [endDt, setEndDt] = React.useState<Dayjs | null>(dayjs(initialEnd));
  const [location, setLocation] = React.useState<string>(existing?.location || '');
  const [notes, setNotes] = React.useState<string>(existing?.notes || '');
  const [assigneeRole, setAssigneeRole] = React.useState<string>(existing?.assigneeRole || '');
  const [assigneeId, setAssigneeId] = React.useState<string>(existing?.assigneeId || '');
  const [addToGcal, setAddToGcal] = React.useState<boolean>(false);
  const [saving, setSaving] = React.useState(false);

  const sortedContacts = React.useMemo(
    () => [...contacts].sort((a, b) =>
      contactDisplayName(a).toLowerCase().localeCompare(contactDisplayName(b).toLowerCase())),
    [contacts],
  );

  const { prefs: visitPrefs, loading: visitPrefsLoading, patchPref: patchVisitPref } = usePrefs();

  // Apply gcal-sync pref once prefs have loaded (only for new visits when Google is connected).
  const gcalPrefAppliedRef = React.useRef(false);
  React.useEffect(() => {
    if (existing || !googleConnected) return;
    if (visitPrefsLoading || gcalPrefAppliedRef.current) return;
    gcalPrefAppliedRef.current = true;
    if (visitPrefs.gcal_sync_pref === true) setAddToGcal(true);
  }, [existing, googleConnected, visitPrefsLoading, visitPrefs]);

  const onGcalToggle = (checked: boolean) => {
    setAddToGcal(checked);
    void patchVisitPref('gcal_sync_pref', checked);
  };

  const save = async () => {
    if (!startDt || !startDt.isValid()) { showToast('Start date & time is required', true); return; }
    if (!endDt || !endDt.isValid()) { showToast('End date & time is required', true); return; }
    const startAt = startDt.toDate();
    const endAt = endDt.toDate();
    if (endAt <= startAt) { showToast('End must be after start', true); return; }
    const customerName = customerId
      ? contactDisplayName(sortedContacts.find((c) => c.id === customerId) || { id: customerId, properties: {} })
      : null;
    const payload = {
      type,
      customerId: customerId || null,
      customerName,
      title: title.trim() || null,
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString(),
      location: location.trim() || null,
      notes: notes.trim() || null,
      assigneeRole: assigneeRole || null,
      assigneeId: assigneeId || null,
    };
    setSaving(true);
    try {
      if (existing) await api('PATCH', `/api/visits/${existing.id}`, payload);
      else await api('POST', '/api/visits', payload);
      showToast(existing ? 'Visit updated' : 'Visit created');
      if (!existing && addToGcal) {
        await createGoogleCalendarEvent({
          title: payload.title, customerName, startAt, endAt,
          location: payload.location, notes: payload.notes, type,
        });
      }
      onSaved();
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'START_IN_PAST') {
        showToast('That time has already passed — please choose a future time.', true);
      } else {
        showToast('Failed to save visit', true);
      }
    } finally {
      setSaving(false);
    }
  };

  const del = async () => {
    if (!existing) return;
    if (!confirm('Delete this visit?')) return;
    setSaving(true);
    try {
      await api('DELETE', `/api/visits/${existing.id}`);
      showToast('Visit deleted');
      onSaved();
    } catch { showToast('Failed to delete visit', true); }
    finally { setSaving(false); }
  };

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle data-testid="cal-visit-modal" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        {existing ? 'Edit visit' : 'New visit'}
        <IconButton aria-label="Close" onClick={onClose} size="small"><CloseIcon /></IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <FormControl size="small" fullWidth>
            <InputLabel id="vm-type-label">Type</InputLabel>
            <Select labelId="vm-type-label" label="Type" value={type} onChange={(e) => setType(String(e.target.value))}>
              {Object.entries(VISIT_TYPE_META).map(([k, m]) => (
                <MenuItem key={k} value={k}>{m.label}</MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControl size="small" fullWidth>
            <InputLabel id="vm-cust-label">Customer</InputLabel>
            <Select
              labelId="vm-cust-label"
              label="Customer"
              value={customerId}
              onChange={(e) => setCustomerId(String(e.target.value))}
            >
              <MenuItem value=""><em>— None —</em></MenuItem>
              {sortedContacts.map((c) => (
                <MenuItem key={c.id} value={c.id}>{contactDisplayName(c)}</MenuItem>
              ))}
            </Select>
          </FormControl>

          <TextField
            size="small"
            label="Title (optional)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Kitchen install — day 1"
            fullWidth
          />

          <LocalizationProvider dateAdapter={AdapterDayjs}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <DateTimePicker
                label="Start"
                value={startDt}
                onChange={(v: Dayjs | null) => setStartDt(v)}
                slotProps={{ textField: { size: 'small', fullWidth: true } }}
              />
              <DateTimePicker
                label="End"
                value={endDt}
                onChange={(v: Dayjs | null) => setEndDt(v)}
                slotProps={{ textField: { size: 'small', fullWidth: true } }}
              />
            </Stack>
          </LocalizationProvider>

          <TextField
            size="small" label="Location (optional)" value={location}
            onChange={(e) => setLocation(e.target.value)} fullWidth
          />
          <TextField
            size="small" label="Notes" value={notes}
            onChange={(e) => setNotes(e.target.value)}
            multiline minRows={3} fullWidth
          />

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <FormControl size="small" sx={{ flex: 1 }}>
              <InputLabel id="vm-role-label">Assigned role</InputLabel>
              <Select labelId="vm-role-label" label="Assigned role" value={assigneeRole}
                onChange={(e) => setAssigneeRole(String(e.target.value))}>
                <MenuItem value=""><em>— None —</em></MenuItem>
                {ASSIGNEE_ROLES.map((r) => (
                  <MenuItem key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ flex: 1 }}>
              <InputLabel id="vm-aid-label">Assigned to</InputLabel>
              <Select labelId="vm-aid-label" label="Assigned to" value={assigneeId}
                onChange={(e) => setAssigneeId(String(e.target.value))}>
                <MenuItem value=""><em>— None —</em></MenuItem>
                {platformUsers.map((u) => {
                  const name = `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email;
                  return <MenuItem key={u.id} value={u.id}>{name}</MenuItem>;
                })}
              </Select>
            </FormControl>
          </Stack>

          {!existing && googleConnected && (
            <FormControlLabel
              data-testid="cal-visit-gcal-row"
              control={<Box component="span" data-testid="cal-visit-gcal-wrap"><Checkbox checked={addToGcal} onChange={(e) => onGcalToggle(e.target.checked)} /></Box>}
              label="Also add to Google Calendar"
            />
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ justifyContent: 'space-between', px: 3, py: 1.5 }}>
        <Box>
          {existing && (
            <Button color="error" onClick={del} disabled={saving}>Delete</Button>
          )}
        </Box>
        <Stack direction="row" spacing={1}>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="contained" onClick={save} disabled={saving} data-testid="cal-visit-save">Save</Button>
        </Stack>
      </DialogActions>
    </Dialog>
  );
}

// ── Google Calendar event creation ──────────────────────────────────────────

async function createGoogleCalendarEvent(args: {
  title: string | null;
  customerName: string | null;
  startAt: Date;
  endAt: Date;
  location: string | null;
  notes: string | null;
  type: string;
}) {
  const meta = VISIT_TYPE_META[args.type] || VISIT_TYPE_META.other;
  const summary = args.title
    ? args.title
    : (args.customerName ? `${meta.label} — ${args.customerName}` : meta.label);
  const description = [
    args.customerName ? `Customer: ${args.customerName}` : '',
    args.notes || '',
  ].filter(Boolean).join('\n');
  const eventBody = {
    summary,
    location: args.location || undefined,
    description: description || undefined,
    start: { dateTime: args.startAt.toISOString() },
    end: { dateTime: args.endAt.toISOString() },
  };
  try {
    await api('POST', '/api/events', eventBody);
    showToast('Added to Google Calendar');
  } catch (e) {
    if ((e as { code?: string }).code === 'GOOGLE_AUTH') {
      showToast('Google account disconnected — reconnect in Settings', true);
    } else {
      showToast('Could not add to Google Calendar. Please try again.', true);
    }
  }
}

export default CalendarPage;

// Suppress unused import warnings for icons reserved for sync UI variants.
