import React from 'react';
import { createPortal } from 'react-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActionArea,
  Chip,
  CircularProgress,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputAdornment,
  InputLabel,
  MenuItem,
  Pagination,
  Select,
  Skeleton,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import ClearIcon from '@mui/icons-material/Clear';
import AddIcon from '@mui/icons-material/Add';
import { useCurrentUser } from '../hooks/useCurrentUser';

type LeadStatus = {
  key: string;
  label: string;
  excluded_from_sales?: boolean;
  is_null_row?: boolean;
  sort_order?: number;
};

type LeadSubstatus = {
  status_key: string;
  substatus_key: string;
  label: string;
  sort_order?: number;
};

type Contact = {
  id: string;
  properties?: {
    firstname?: string;
    lastname?: string;
    email?: string;
    phone?: string;
    hs_lead_status?: string;
    hw_lead_substatus?: string;
    customer_number?: string;
    createdate?: string;
  };
};

type ContactsResponse = {
  results?: Contact[];
  page?: number;
  totalPages?: number;
  total?: number;
};

type Room = {
  room?: string;
  stageKey?: string;
  roomStatus?: string;
};

type WorkflowDef = {
  stages?: Record<string, { label?: string }>;
};

type QBInvoice = {
  id: string;
  customerName?: string;
  email?: string;
  balance: number;
};

type Urgency = 'red' | 'orange' | null;

// Fallback stage palette (matches STAGE_COLOURS in workflow-core.js — kept
// in sync intentionally; if workflow-core.js is loaded on the page we
// prefer the live globals).
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
const DEFAULT_STAGE_COLOURS: Record<string, { bg: string; light: string; text: string }> = {
  sales:        { bg: '#8B2BFF', light: '#F3EAFF', text: '#6A12D9' },
  designvisit:  { bg: '#0d9488', light: '#ccfbf1', text: '#0f766e' },
  survey:       { bg: '#d97706', light: '#fef3c7', text: '#b45309' },
  order:        { bg: '#2563eb', light: '#dbeafe', text: '#1d4ed8' },
  workshop:     { bg: '#dc2626', light: '#fee2e2', text: '#b91c1c' },
  packing:      { bg: '#059669', light: '#d1fae5', text: '#047857' },
  delivery:     { bg: '#0891b2', light: '#cffafe', text: '#0e7490' },
  installation: { bg: '#8A5A3B', light: '#fdf6ee', text: '#5c3820' },
  aftercare:    { bg: '#200842', light: '#ede0ff', text: '#3d0f7a' },
};

function stageColour(stageKey: string): { bg: string; light: string; text: string } {
  const w = (window as unknown as { stageColour?: (k: string) => { bg: string; light: string; text: string } }).stageColour;
  if (typeof w === 'function') {
    try {
      return w(stageKey);
    } catch {
      /* fall through */
    }
  }
  return DEFAULT_STAGE_COLOURS[stageKey] || DEFAULT_STAGE_COLOURS.sales;
}

const PAGE_LIMIT = 25;
const SORT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'newest', label: 'Newest first' },
  { value: 'name-asc', label: 'Name A–Z' },
  { value: 'name-desc', label: 'Name Z–A' },
  { value: 'stage', label: 'Stage order' },
];

function readUrlState() {
  const p = new URLSearchParams(location.search);
  return {
    page: Math.max(1, parseInt(p.get('page') || '1', 10) || 1),
    leadStatus: p.get('leadStatus') || '',
    substatus: p.get('substatus') || '',
    sort: p.get('sort') || 'newest',
    q: p.get('q') || '',
    stage: p.get('stage') || '',
    view: (p.get('view') === 'active' ? 'active' : 'all') as 'all' | 'active',
    archived: p.get('archived') === '1',
  };
}

function writeUrlState(s: {
  page: number;
  leadStatus: string;
  substatus: string;
  sort: string;
  q: string;
  stage: string;
  view: 'all' | 'active';
  archived: boolean;
}) {
  const qs = new URLSearchParams();
  if (s.page > 1) qs.set('page', String(s.page));
  if (s.leadStatus) qs.set('leadStatus', s.leadStatus);
  if (s.substatus && s.leadStatus) qs.set('substatus', s.substatus);
  if (s.sort && s.sort !== 'newest') qs.set('sort', s.sort);
  if (s.q) qs.set('q', s.q);
  if (s.stage) qs.set('stage', s.stage);
  if (s.view === 'active') qs.set('view', 'active');
  if (s.archived) qs.set('archived', '1');
  const str = qs.toString();
  history.replaceState(null, '', str ? '?' + str : location.pathname);
}

function contactName(c: Contact): string {
  const first = c.properties?.firstname || '';
  const last = c.properties?.lastname || '';
  const both = `${first} ${last}`.trim();
  if (both) return both;
  return c.properties?.email || `Contact ${c.id}`;
}

async function apiGet<T = unknown>(path: string): Promise<T> {
  const r = await fetch(path, { headers: { Accept: 'application/json' } });
  if (r.status === 401) {
    location.href = '/login';
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

async function apiPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (r.status === 401) {
    location.href = '/login';
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

function useIsViewer(): boolean {
  const { user } = useCurrentUser();
  const [bodyClass, setBodyClass] = React.useState<boolean>(() =>
    typeof document !== 'undefined' && document.body.classList.contains('viewer-mode'),
  );
  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    const sync = () => setBodyClass(document.body.classList.contains('viewer-mode'));
    const obs = new MutationObserver(sync);
    obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  if (user) return user.privilege_level === 'viewer';
  return bodyClass;
}

/**
 * Module-level store for lead statuses + counts so the test-required
 * `window.loadLeadStatuses()` and `window.populateLeadStatusFilter()`
 * functions can mutate state and trigger React re-renders even when
 * called outside the React tree.
 */
type Store = {
  statuses: LeadStatus[];
  substatuses: LeadSubstatus[];
  counts: Record<string, number>;
  nullLabel: string;
  loaded: boolean;
};

const store: Store = {
  statuses: [],
  substatuses: [],
  counts: {},
  nullLabel: 'No status',
  loaded: false,
};

const subscribers = new Set<() => void>();
function notify() {
  for (const fn of Array.from(subscribers)) fn();
}

async function loadLeadStatuses(): Promise<void> {
  try {
    const rows = await apiGet<LeadStatus[]>('/api/lead-statuses');
    if (Array.isArray(rows)) {
      const nullRow = rows.find((r) => r.is_null_row);
      if (nullRow) store.nullLabel = nullRow.label || 'No status';
      store.statuses = rows.filter((r) => !r.is_null_row);
      store.loaded = true;
    }
  } catch (e) {
    console.warn('loadLeadStatuses failed:', (e as Error).message);
  }
}

async function loadLeadStatusCounts(): Promise<void> {
  try {
    const counts = await apiGet<Record<string, number>>('/api/contacts-lead-status-counts');
    if (counts && typeof counts === 'object') store.counts = counts;
  } catch (e) {
    console.warn('loadLeadStatusCounts failed:', (e as Error).message);
  }
}

async function loadLeadSubstatuses(): Promise<void> {
  try {
    const rows = await apiGet<LeadSubstatus[]>('/api/lead-substatuses');
    if (Array.isArray(rows)) store.substatuses = rows;
  } catch (e) {
    console.warn('loadLeadSubstatuses failed:', (e as Error).message);
  }
}

/**
 * Re-render the native `<select id="lead-status-filter">` element with
 * the current store contents in `Label (N)` format. The lead-status-sync
 * test asserts directly on this element's options.
 */
function populateLeadStatusFilter(): void {
  const sel = document.getElementById('lead-status-filter') as HTMLSelectElement | null;
  if (!sel) {
    notify();
    return;
  }
  const counts = store.counts || {};
  const nullCount = counts['__no_status__'] || 0;
  const prev = sel.value;
  const opts: string[] = [];
  opts.push('<option value="">All statuses</option>');
  const nullAttrs = nullCount === 0 ? ' disabled' : '';
  opts.push(
    `<option value="__no_status__"${nullAttrs}>${escapeHtml(store.nullLabel)} (${nullCount})</option>`,
  );
  for (const s of store.statuses.filter((o) => !o.excluded_from_sales)) {
    const n = counts[s.key] || 0;
    const attrs = n === 0 ? ' disabled' : '';
    opts.push(
      `<option value="${escapeHtml(s.key)}"${attrs}>${escapeHtml(s.label)} (${n})</option>`,
    );
  }
  sel.innerHTML = opts.join('');
  if (prev) sel.value = prev;
  notify();
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

// Expose to window so the privileges/lead-status-sync test harness can
// `page.evaluate(() => loadLeadStatuses())` etc.
declare global {
  interface Window {
    loadLeadStatuses?: () => Promise<void>;
    populateLeadStatusFilter?: () => void;
    loadLeadStatusCounts?: () => Promise<void>;
  }
}
window.loadLeadStatuses = loadLeadStatuses;
window.populateLeadStatusFilter = populateLeadStatusFilter;
window.loadLeadStatusCounts = loadLeadStatusCounts;

/**
 * Effect that wires the existing BroadcastChannel + visibilitychange
 * sync paths preserved from the old `workflow-core.js` (lines 340–362,
 * 432–440). Each handler refetches statuses + counts and re-runs the
 * native-select populator so the lead-status-sync test continues to
 * pass.
 */
function useLeadStatusSync(onChange: () => void) {
  React.useEffect(() => {
    const refresh = () => {
      Promise.all([loadLeadStatuses(), loadLeadStatusCounts(), loadLeadSubstatuses()])
        .then(() => {
          populateLeadStatusFilter();
          onChange();
        })
        .catch(() => {});
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
  }, [onChange]);
}

function StagePill({ stageKey, label, archived }: { stageKey: string; label: string; archived: boolean }) {
  const c = stageColour(stageKey);
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-block',
        px: 1,
        py: 0.25,
        borderRadius: 1,
        fontSize: 12,
        fontWeight: 600,
        bgcolor: c.light,
        color: c.text,
        opacity: archived ? 0.55 : 1,
        lineHeight: 1.4,
      }}
    >
      {label}
    </Box>
  );
}

function UrgencyDot({ urgency }: { urgency: Urgency }) {
  if (!urgency) return null;
  const bg = urgency === 'red' ? '#dc2626' : '#f59e0b';
  const title =
    urgency === 'red' ? 'Urgent: task due within 1 working day' : 'Task due within 2 working days';
  return (
    <Box
      component="span"
      title={title}
      aria-label={urgency === 'red' ? 'Urgent' : 'Task due soon'}
      sx={{
        display: 'inline-block',
        width: 9,
        height: 9,
        borderRadius: '50%',
        bgcolor: bg,
        mr: 0.75,
        verticalAlign: 'middle',
        flexShrink: 0,
      }}
    />
  );
}

function matchInvoicesForContact(contact: Contact, invoices: QBInvoice[]): QBInvoice[] {
  if (!invoices.length) return [];
  const email = (contact.properties?.email || '').toLowerCase().trim();
  const name = contactName(contact).toLowerCase().trim();
  return invoices.filter((inv) => {
    const custName = (inv.customerName || '').toLowerCase().trim();
    const custEmail = (inv.email || '').toLowerCase().trim();
    if (email && custEmail && email === custEmail) return true;
    if (name && custName && custName === name) return true;
    return false;
  });
}

function fmtGBP(n: number): string {
  return (
    '£' +
    Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

function QBBadge({ invoices }: { invoices: QBInvoice[] }) {
  if (!invoices.length) return null;
  const total = invoices.reduce((s, i) => s + (i.balance || 0), 0);
  const ids = JSON.stringify(invoices.map((i) => i.id));
  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.preventDefault();
    const opener = (
      window as unknown as { openInvoicePanelFromBadge?: (btn: HTMLElement) => void }
    ).openInvoicePanelFromBadge;
    if (typeof opener === 'function') opener(e.currentTarget);
  };
  return (
    <Box
      component="button"
      type="button"
      onClick={handleClick}
      data-inv-ids={ids}
      title={`${invoices.length} outstanding invoice${invoices.length !== 1 ? 's' : ''}`}
      sx={{
        appearance: 'none',
        border: '1px solid #fecaca',
        bgcolor: '#fef2f2',
        color: '#b91c1c',
        px: 1,
        py: 0.25,
        borderRadius: 1,
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        lineHeight: 1.4,
        '&:hover': { bgcolor: '#fee2e2' },
      }}
    >
      {fmtGBP(total)}
    </Box>
  );
}

const CUSTOMERS_SCROLL_KEY = 'customers_scroll';

function saveCustomersScroll() {
  try {
    const y =
      window.scrollY ||
      window.pageYOffset ||
      document.documentElement.scrollTop ||
      document.body.scrollTop ||
      0;
    sessionStorage.setItem(CUSTOMERS_SCROLL_KEY, String(y));
  } catch {
    /* ignore */
  }
}

function CustomerCard({
  contact,
  statusMap,
  rooms,
  workflow,
  invoices,
  urgency,
}: {
  contact: Contact;
  statusMap: Map<string, LeadStatus>;
  rooms: Room[];
  workflow: WorkflowDef | null;
  invoices: QBInvoice[];
  urgency: Urgency;
}) {
  const name = contactName(contact);
  const email = contact.properties?.email || '';
  const phone = contact.properties?.phone || '';
  const customerNum = contact.properties?.customer_number || '';
  const rawLs = contact.properties?.hs_lead_status || '';
  const lsLabel = rawLs ? statusMap.get(rawLs)?.label || rawLs : '';

  const effectiveRooms: Room[] = rooms.length
    ? rooms
    : [{ room: 'Main', stageKey: 'sales', roomStatus: 'active' }];
  const multiRoom = effectiveRooms.length > 1;
  const allArchived = effectiveRooms.every((r) => (r.roomStatus || 'active') !== 'active');

  return (
    <Card variant="outlined" sx={{ width: '100%', opacity: allArchived ? 0.7 : 1 }}>
      <CardActionArea
        component="a"
        href={`/customers/${encodeURIComponent(contact.id)}`}
        onClick={saveCustomersScroll}
        sx={{ p: 2, display: 'block' }}
      >
        <Stack direction="row" spacing={1} sx={{  alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <Typography
            variant="subtitle1"

            noWrap
            sx={{ display: 'flex', alignItems: 'center', minWidth: 0 }}
          >
            <UrgencyDot urgency={urgency} />
            <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {name}
            </Box>
          </Typography>
          {lsLabel ? <Chip label={lsLabel} size="small" color="primary" variant="outlined" /> : null}
        </Stack>
        <Stack direction="row" spacing={0.75} sx={{  mt: 1, flexWrap: 'wrap' }}>
          {effectiveRooms.map((r, idx) => {
            const sk = r.stageKey || 'sales';
            const lbl =
              workflow?.stages?.[sk]?.label || DEFAULT_STAGE_LABELS[sk] || sk;
            const pillText =
              multiRoom && r.room && r.room !== 'Main' ? `${lbl} — ${r.room}` : lbl;
            return (
              <StagePill
                key={`${sk}-${r.room || 'Main'}-${idx}`}
                stageKey={sk}
                label={pillText}
                archived={(r.roomStatus || 'active') !== 'active'}
              />
            );
          })}
        </Stack>
        <Stack direction="row" spacing={1} sx={{  mt: 1, flexWrap: 'wrap' }}>
          {email ? <Chip label={email} size="small" variant="outlined" /> : null}
          {phone ? <Chip label={phone} size="small" variant="outlined" /> : null}
          <QBBadge invoices={invoices} />
          {customerNum ? (
            <Chip label={customerNum} size="small" color="secondary" variant="outlined" />
          ) : null}
        </Stack>
      </CardActionArea>
    </Card>
  );
}

export function CustomersPage(): React.ReactElement {
  const initial = React.useMemo(() => readUrlState(), []);
  const [page, setPage] = React.useState<number>(initial.page);
  const [leadStatus, setLeadStatus] = React.useState<string>(initial.leadStatus);
  const [substatus, setSubstatus] = React.useState<string>(initial.substatus);
  const [sortBy, setSortBy] = React.useState<string>(initial.sort);
  const [searchInput, setSearchInput] = React.useState<string>(initial.q);
  const [search, setSearch] = React.useState<string>(initial.q);
  const [viewMode, setViewMode] = React.useState<'all' | 'active'>(initial.view);
  const [stageFilter, setStageFilter] = React.useState<string>(initial.stage);
  const [showArchived, setShowArchived] = React.useState<boolean>(initial.archived);

  const [workflow, setWorkflow] = React.useState<WorkflowDef | null>(null);
  const [roomsByContact, setRoomsByContact] = React.useState<Record<string, Room[]>>({});
  const [qbInvoices, setQbInvoices] = React.useState<QBInvoice[]>([]);
  const [urgencyMap, setUrgencyMap] = React.useState<Record<string, Urgency>>({});

  const [contacts, setContacts] = React.useState<Contact[]>([]);
  const [total, setTotal] = React.useState<number>(0);
  const [totalPages, setTotalPages] = React.useState<number>(1);
  const [loading, setLoading] = React.useState<boolean>(true);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = React.useState<number>(0);
  const [openLeadsCacheAge, setOpenLeadsCacheAge] = React.useState<number | null>(null);

  const isViewer = useIsViewer();
  const [newOpen, setNewOpen] = React.useState<boolean>(() => {
    const p = new URLSearchParams(location.search);
    return p.get('new') === '1';
  });

  // After the first successful contacts render, restore the scroll
  // position saved when the user navigated into a customer (see
  // saveCustomersScroll on CardActionArea click). One-shot per visit.
  const scrollRestoredRef = React.useRef(false);
  React.useEffect(() => {
    if (scrollRestoredRef.current) return;
    if (loading) return;
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem(CUSTOMERS_SCROLL_KEY);
    } catch {
      /* ignore */
    }
    if (saved == null) return;
    try {
      sessionStorage.removeItem(CUSTOMERS_SCROLL_KEY);
    } catch {
      /* ignore */
    }
    const y = parseInt(saved, 10) || 0;
    scrollRestoredRef.current = true;
    // Defer to the next frame so the list DOM has its final height before
    // we scroll.
    requestAnimationFrame(() => {
      window.scrollTo(0, y);
    });
  }, [loading, contacts]);

  // If the page is opened with `?new=1`, strip the flag from the URL so a
  // refresh doesn't keep re-opening the dialog. (Matches the legacy
  // workflow.js deep-link behaviour, which only triggered once.)
  React.useEffect(() => {
    const p = new URLSearchParams(location.search);
    if (p.get('new') === '1') {
      p.delete('new');
      const qs = p.toString();
      history.replaceState(null, '', qs ? '?' + qs : location.pathname);
    }
  }, []);

  // Viewers cannot create contacts; close any auto-opened dialog if the
  // role resolves to viewer after mount.
  React.useEffect(() => {
    if (isViewer && newOpen) setNewOpen(false);
  }, [isViewer, newOpen]);

  // Force re-render whenever the module store mutates.
  const [, forceRender] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => {
    subscribers.add(forceRender);
    return () => {
      subscribers.delete(forceRender);
    };
  }, []);

  const refreshDropdown = React.useCallback(() => {
    populateLeadStatusFilter();
  }, []);

  useLeadStatusSync(refreshDropdown);

  // Debounce the search input.
  React.useEffect(() => {
    const h = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(h);
  }, [searchInput]);

  // Reflect filter changes in the URL.
  React.useEffect(() => {
    writeUrlState({
      page,
      leadStatus,
      substatus,
      sort: sortBy,
      q: search,
      stage: stageFilter,
      view: viewMode,
      archived: showArchived,
    });
  }, [page, leadStatus, substatus, sortBy, search, stageFilter, viewMode, showArchived]);

  // Load lead statuses + counts + substatuses on mount, then re-populate
  // the native select once the DOM element has been mounted.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      await Promise.all([loadLeadStatuses(), loadLeadStatusCounts(), loadLeadSubstatuses()]);
      if (cancelled) return;
      populateLeadStatusFilter();
      forceRender();
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load workflow definition (for the stage tab bar + per-card stage labels)
  // and the per-contact rooms cache (for the client-side stage + archived
  // filters). Also load QuickBooks invoices (for the per-card QB badge) when
  // connected. All are best-effort; failures just leave the corresponding UI
  // inert.
  React.useEffect(() => {
    let cancelled = false;
    apiGet<WorkflowDef>('/api/workflow')
      .then((wf) => {
        if (!cancelled) setWorkflow(wf || null);
      })
      .catch(() => {});
    apiGet<Record<string, Room[]>>('/api/localdata/all')
      .then((data) => {
        if (cancelled) return;
        setRoomsByContact(data || {});
        // Mirror into the legacy global cache so any shared helper that
        // reads `state.contactStageCache` (e.g. urgency calculation in
        // workflow-core.js) sees the same data.
        const legacy = (window as unknown as { state?: { contactStageCache?: Record<string, Room[]> } })
          .state;
        if (legacy && legacy.contactStageCache) {
          for (const [id, rooms] of Object.entries(data || {})) {
            legacy.contactStageCache[id] = rooms;
          }
        }
      })
      .catch(() => {});

    // QB invoices: only attempt when QuickBooks is connected. Mirror into
    // `state.qb` so the legacy `openInvoicePanelFromBadge` panel works.
    (async () => {
      try {
        const status = await apiGet<{ connected?: boolean }>('/api/quickbooks/status');
        if (!status.connected || cancelled) return;
        const data = await apiGet<{ invoices?: QBInvoice[] }>('/api/quickbooks/invoices');
        if (cancelled) return;
        const invs = data.invoices || [];
        setQbInvoices(invs);
        const legacy = (
          window as unknown as { state?: { qb?: { invoices?: QBInvoice[]; loaded?: boolean; connected?: boolean } } }
        ).state;
        if (legacy && legacy.qb) {
          legacy.qb.invoices = invs;
          legacy.qb.loaded = true;
          legacy.qb.connected = true;
        }
      } catch {
        /* QB not configured / not connected — leave badges hidden */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Best-effort urgency calculation for the visible page. Mirrors the
  // legacy `state.contactUrgencyCache` semantics (only populated for
  // contacts we've actually inspected — here, all contacts on the
  // current page).
  React.useEffect(() => {
    if (!contacts.length) return;
    let cancelled = false;
    const ids = contacts.map((c) => c.id).filter((id) => !(id in urgencyMap));
    if (!ids.length) return;
    (async () => {
      let urgencyById: Record<string, Urgency> = {};
      try {
        const res = await fetch('/api/contacts/urgency', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        });
        if (res.ok) {
          const data = (await res.json()) as { urgency?: Record<string, Urgency> };
          urgencyById = data.urgency || {};
        }
      } catch {
        /* fall through with empty map; ids will be marked null below */
      }
      if (cancelled) return;
      const legacyCache = (
        window as unknown as { state?: { contactUrgencyCache?: Record<string, Urgency> } }
      ).state?.contactUrgencyCache;
      setUrgencyMap((prev) => {
        const next = { ...prev };
        for (const id of ids) {
          const u = id in urgencyById ? urgencyById[id] : null;
          next[id] = u;
          if (legacyCache) legacyCache[id] = u;
        }
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [contacts]);


  // Fetch the current page of contacts whenever the relevant filters change.
  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    if (viewMode === 'active') {
      // Use raw fetch for open-leads so we can read response headers (X-Cache-Age).
      (async () => {
        try {
          const r = await fetch('/api/open-leads', { headers: { Accept: 'application/json' } });
          if (r.status === 401) { location.href = '/login'; return; }
          const data = await r.json().catch(() => ({})) as ContactsResponse;
          if (!r.ok) {
            const err = new Error((data as { error?: string }).error || `HTTP ${r.status}`);
            (err as { code?: string }).code = (data as { code?: string }).code;
            throw err;
          }
          const cacheStatus = r.headers.get('X-Cache-Status');
          const ageHeader = r.headers.get('X-Cache-Age');
          const cacheAge = ageHeader !== null ? Number(ageHeader) : NaN;
          if (cancelled) return;
          // Show hint only when the response was served from cache (X-Cache-Status
          // is 'fresh' AND X-Cache-Age is present) and the age is close to the
          // server TTL (≥ 45 s out of a 60 s window).
          const NEAR_TTL_THRESHOLD_S = 45;
          const isCached =
            cacheStatus === 'fresh' &&
            Number.isFinite(cacheAge) &&
            cacheAge >= NEAR_TTL_THRESHOLD_S;
          setOpenLeadsCacheAge(isCached ? cacheAge : null);
          const list = data.results || [];
          setContacts(list);
          setTotal(data.total != null ? data.total : list.length);
          setTotalPages(data.totalPages || 1);
          setLoading(false);
        } catch (e) {
          if (cancelled) return;
          setOpenLeadsCacheAge(null);
          setError(humaniseError(e as Error & { code?: string }));
          setContacts([]);
          setTotal(0);
          setTotalPages(1);
          setLoading(false);
        }
      })();
    } else {
      setOpenLeadsCacheAge(null);
      const qs = new URLSearchParams({ page: String(page), limit: String(PAGE_LIMIT) });
      if (leadStatus) qs.set('leadStatus', leadStatus);
      if (sortBy && sortBy !== 'newest') qs.set('sort', sortBy);
      if (search) qs.set('q', search);
      apiGet<ContactsResponse>(`/api/contacts-all?${qs}`)
        .then((data) => {
          if (cancelled) return;
          const list = data.results || [];
          setContacts(list);
          setTotal(data.total != null ? data.total : list.length);
          setTotalPages(data.totalPages || 1);
          setLoading(false);
          loadLeadStatusCounts().then(populateLeadStatusFilter).catch(() => {});
        })
        .catch((e: Error & { code?: string }) => {
          if (cancelled) return;
          setError(humaniseError(e));
          setContacts([]);
          setTotal(0);
          setTotalPages(1);
          setLoading(false);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [page, leadStatus, sortBy, search, viewMode, refreshNonce]);

  // Background re-fetch: when open-leads was served from stale cache, wait
  // until the server's 60 s TTL has elapsed then silently swap in fresh data.
  // No loading spinner is shown; the "Data may be up to 1 min old" hint
  // disappears once fresh results arrive.
  React.useEffect(() => {
    if (openLeadsCacheAge === null || viewMode !== 'active') return;

    // Delay = time left until server TTL expires + 5 s for the HubSpot fetch.
    const OPEN_LEADS_TTL_S = 60;
    const delay = Math.max(5_000, (OPEN_LEADS_TTL_S - openLeadsCacheAge) * 1_000 + 5_000);

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const r = await fetch('/api/open-leads', { headers: { Accept: 'application/json' } });
        if (cancelled) return;
        if (r.status === 401) { location.href = '/login'; return; }
        if (!r.ok) return;
        const data = await r.json().catch(() => null) as ContactsResponse | null;
        if (cancelled || !data) return;
        const cacheStatus = r.headers.get('X-Cache-Status');
        const ageHeader = r.headers.get('X-Cache-Age');
        const newAge = ageHeader !== null ? Number(ageHeader) : NaN;
        const NEAR_TTL_THRESHOLD_S = 45;
        const isStillCached =
          cacheStatus === 'fresh' &&
          Number.isFinite(newAge) &&
          newAge >= NEAR_TTL_THRESHOLD_S;
        const list = data.results || [];
        setContacts(list);
        setTotal(data.total != null ? data.total : list.length);
        setOpenLeadsCacheAge(isStillCached ? newAge : null);
      } catch {
        // Best-effort: silently ignore background-fetch errors.
      }
    }, delay);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [openLeadsCacheAge, viewMode]);

  // Resolve rooms for a contact, applying the stage + archived filters from
  // the legacy `buildListItems` (public/workflow.js lines 140-202).
  const resolveRooms = React.useCallback(
    (contactId: string): Room[] | null => {
      const cached = roomsByContact[contactId];
      if (cached && cached.length > 0) {
        const filtered: Room[] = [];
        for (const r of cached) {
          const roomStatus = r.roomStatus || 'active';
          if (stageFilter) {
            if (roomStatus !== 'active' && !showArchived) continue;
            if (r.stageKey !== stageFilter) continue;
          }
          filtered.push({
            room: r.room || 'Main',
            stageKey: r.stageKey || 'sales',
            roomStatus,
          });
        }
        if (stageFilter && filtered.length === 0) return null;
        return filtered;
      }
      // No cached rooms — always show contact with a sensible fallback.
      return [{ room: 'Main', stageKey: 'sales', roomStatus: 'active' }];
    },
    [roomsByContact, stageFilter, showArchived],
  );

  // Local client-side sub-status + stage + archived filtering on top of the
  // fetched page.
  const visibleContacts = React.useMemo(() => {
    const out: Array<{ contact: Contact; rooms: Room[] }> = [];
    for (const c of contacts) {
      if (substatus) {
        const v = String(c.properties?.hw_lead_substatus || '').toUpperCase();
        if (v !== substatus.toUpperCase()) continue;
      }
      const rooms = resolveRooms(c.id);
      if (!rooms || rooms.length === 0) continue;
      out.push({ contact: c, rooms });
    }
    return out;
  }, [contacts, substatus, resolveRooms]);

  const statusMap = React.useMemo(() => {
    const m = new Map<string, LeadStatus>();
    for (const s of store.statuses) m.set(s.key, s);
    return m;
  }, []);

  const availableSubstatuses = React.useMemo<LeadSubstatus[]>(() => {
    if (!leadStatus || leadStatus === '__no_status__') return [];
    return store.substatuses
      .filter((r) => String(r.status_key).toUpperCase() === leadStatus.toUpperCase())
      .slice()
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  }, [leadStatus]);

  // Build the stage tab list: Active, All, then one button per workflow stage.
  const stageTabs = React.useMemo(() => {
    const tabs: Array<{ key: string; label: string }> = [
      { key: '__active__', label: 'Active' },
      { key: '__all__', label: 'All' },
    ];
    const stages = workflow?.stages || {};
    for (const [k, s] of Object.entries(stages)) {
      tabs.push({ key: k, label: s?.label || k });
    }
    return tabs;
  }, [workflow]);

  const currentTab: string = stageFilter
    ? stageFilter
    : viewMode === 'active'
      ? '__active__'
      : '__all__';

  const onTabChange = (key: string) => {
    setPage(1);
    setSubstatus('');
    if (key === '__active__') {
      setViewMode('active');
      setStageFilter('');
      setLeadStatus('');
      setShowArchived(false);
    } else if (key === '__all__') {
      setViewMode('all');
      setStageFilter('');
    } else {
      setViewMode('all');
      setStageFilter(key);
    }
  };

  return (
    <Container maxWidth="md" sx={{ py: 2 }}>
      <Stack spacing={2}>
        {!isViewer && typeof document !== 'undefined' &&
          document.getElementById('page-heading-action') &&
          createPortal(
            <Button
              id="new-customer-btn"
              variant="contained"
              size="small"
              startIcon={<AddIcon />}
              onClick={() => setNewOpen(true)}
            >
              New customer
            </Button>,
            document.getElementById('page-heading-action') as HTMLElement,
          )}

        <Box sx={{ overflowX: 'auto' }}>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={currentTab}
            onChange={(_, v: string | null) => {
              if (!v) return;
              onTabChange(v);
            }}
            aria-label="Stage filter"
            sx={{ flexWrap: 'wrap' }}
          >
            {stageTabs.map((t) => {
              const isStage = t.key !== '__active__' && t.key !== '__all__';
              const colour = isStage ? stageColour(t.key) : null;
              const selected = currentTab === t.key;
              return (
                <ToggleButton
                  key={t.key}
                  value={t.key}
                  sx={
                    selected && colour
                      ? {
                          bgcolor: colour.bg,
                          color: '#fff',
                          borderColor: colour.bg,
                          '&:hover': { bgcolor: colour.bg, opacity: 0.9 },
                          '&.Mui-selected': {
                            bgcolor: colour.bg,
                            color: '#fff',
                            '&:hover': { bgcolor: colour.bg, opacity: 0.9 },
                          },
                        }
                      : undefined
                  }
                >
                  {t.label}
                </ToggleButton>
              );
            })}
          </ToggleButtonGroup>
        </Box>

        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
          <TextField
            id="search"
            placeholder="Search customers"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            size="small"
            sx={{ flexGrow: 1 }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
                endAdornment: searchInput ? (
                  <InputAdornment position="end">
                    <Button
                      size="small"
                      onClick={() => setSearchInput('')}
                      aria-label="Clear search"
                      sx={{ minWidth: 0 }}
                    >
                      <ClearIcon fontSize="small" />
                    </Button>
                  </InputAdornment>
                ) : null,
              },
              htmlInput: { 'aria-label': 'Search customers' },
            }}
          />

          <FormControl size="small" sx={{ minWidth: 200 }} disabled={viewMode !== 'all'}>
            <InputLabel htmlFor="lead-status-filter" shrink>
              Lead status
            </InputLabel>
            <Select
              native
              label="Lead status"
              value={leadStatus}
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                setLeadStatus(v);
                setSubstatus('');
                setPage(1);
              }}
              slotProps={{ input: { id: 'lead-status-filter', name: 'lead-status-filter' } }}
            >
              {/* Native options are managed by populateLeadStatusFilter() so
                  the existing lead-status-sync test can mutate them
                  directly. React seeds an initial empty option here so the
                  control renders before the first fetch completes. */}
              <option value="">All statuses</option>
            </Select>
          </FormControl>

          <FormControl size="small" sx={{ minWidth: 180 }}>
            <InputLabel id="customers-sort-label">Sort by</InputLabel>
            <Select
              labelId="customers-sort-label"
              id="customers-sort-select"
              label="Sort by"
              value={sortBy}
              onChange={(e) => {
                setSortBy(String(e.target.value));
                setPage(1);
              }}
            >
              {SORT_OPTIONS.map((o) => (
                <MenuItem key={o.value} value={o.value}>
                  {o.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Button
            id="archived-toggle"
            size="small"
            variant={showArchived ? 'contained' : 'outlined'}
            color={showArchived ? 'secondary' : 'inherit'}
            aria-pressed={showArchived}
            onClick={() => {
              const next = !showArchived;
              setShowArchived(next);
              setPage(1);
              // Match legacy: switching archived ON forces "All" mode so the
              // full HubSpot list is loaded; switching it OFF returns to the
              // open-leads "Active" view.
              if (next) {
                setViewMode('all');
                setStageFilter('');
              } else {
                setViewMode('active');
                setStageFilter('');
                setLeadStatus('');
                setSubstatus('');
              }
            }}
            sx={{ whiteSpace: 'nowrap' }}
          >
            {showArchived ? 'Hide archived' : 'Show archived'}
          </Button>
        </Stack>

        {availableSubstatuses.length > 0 ? (
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
            <Chip
              label="All sub-statuses"
              variant={substatus === '' ? 'filled' : 'outlined'}
              color={substatus === '' ? 'primary' : 'default'}
              onClick={() => setSubstatus('')}
              size="small"
            />
            {availableSubstatuses.map((s) => {
              const full = `${String(leadStatus).toUpperCase()}__${String(s.substatus_key).toUpperCase()}`;
              const active = substatus === full;
              return (
                <Chip
                  key={full}
                  label={s.label || s.substatus_key}
                  variant={active ? 'filled' : 'outlined'}
                  color={active ? 'primary' : 'default'}
                  onClick={() => setSubstatus(active ? '' : full)}
                  size="small"
                />
              );
            })}
          </Stack>
        ) : null}

        {stageFilter ? (
          <Typography variant="caption" color="text.secondary">
            Stage filter applies to this page only. Switch pages to find more matches.
          </Typography>
        ) : null}

        {error ? <Alert severity="error">{error}</Alert> : null}

        {!loading && viewMode === 'active' && openLeadsCacheAge !== null ? (
          <Alert severity="info" sx={{ py: 0 }}>
            Data may be up to 1 min old.
          </Alert>
        ) : null}

        {loading ? (
          <Stack spacing={1}>
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} variant="rounded" height={84} />
            ))}
          </Stack>
        ) : visibleContacts.length === 0 ? (
          <Box sx={{ py: 6, textAlign: 'center', color: 'text.secondary' }}>
            <Typography variant="body1">No customers match</Typography>
          </Box>
        ) : (
          <Stack spacing={1.5} id="customers-results">
            {visibleContacts.map(({ contact, rooms }) => (
              <CustomerCard
                key={contact.id}
                contact={contact}
                statusMap={statusMap}
                rooms={rooms}
                workflow={workflow}
                invoices={matchInvoicesForContact(contact, qbInvoices)}
                urgency={urgencyMap[contact.id] || null}
              />
            ))}
          </Stack>
        )}

        {totalPages > 1 ? (
          <Stack direction="row" sx={{   pt: 1, alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="body2" color="text.secondary">
              Showing {Math.min(total, (page - 1) * PAGE_LIMIT + 1)}–
              {Math.min(total, (page - 1) * PAGE_LIMIT + visibleContacts.length)} of {total}
            </Typography>
            <Pagination
              count={totalPages}
              page={page}
              onChange={(_, p) => setPage(p)}
              size="small"
              color="primary"
            />
          </Stack>
        ) : null}

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <CircularProgress size={18} />
          </Box>
        ) : null}
      </Stack>

      <NewCustomerDialog
        open={newOpen && !isViewer}
        onClose={() => setNewOpen(false)}
        onCreated={(c) => {
          setNewOpen(false);
          // Prepend the freshly-created contact so it shows immediately,
          // then trigger a refetch in the background so the list returns
          // to the canonical server-side order.
          setContacts((prev) => [c, ...prev]);
          setTotal((t) => t + 1);
          setRefreshNonce((n) => n + 1);
          loadLeadStatusCounts().then(populateLeadStatusFilter).catch(() => {});
        }}
      />
    </Container>
  );
}

type NewContactBody = {
  firstname: string;
  lastname: string;
  email: string;
  phone: string;
  postcode: string;
};

function NewCustomerDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (c: Contact) => void;
}): React.ReactElement {
  const [firstname, setFirstname] = React.useState('');
  const [lastname, setLastname] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [postcode, setPostcode] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [duplicate, setDuplicate] = React.useState<Contact | null>(null);
  const [checkingDup, setCheckingDup] = React.useState(false);

  React.useEffect(() => {
    if (!open) {
      setFirstname('');
      setLastname('');
      setEmail('');
      setPhone('');
      setPostcode('');
      setErr(null);
      setSubmitting(false);
      setDuplicate(null);
      setCheckingDup(false);
    }
  }, [open]);

  // Debounced duplicate-email check against /api/contacts-all so users get a
  // warning while typing instead of after submission. We only consider exact
  // case-insensitive email matches — the endpoint's `q` does a broader
  // substring search across name/phone/email, so we filter the results
  // client-side.
  React.useEffect(() => {
    const em = email.trim().toLowerCase();
    if (!open) return;
    if (!em || !em.includes('@')) {
      setDuplicate(null);
      setCheckingDup(false);
      return;
    }
    let cancelled = false;
    setCheckingDup(true);
    const h = setTimeout(() => {
      apiGet<ContactsResponse>(`/api/contacts-all?q=${encodeURIComponent(em)}&limit=10`)
        .then((data) => {
          if (cancelled) return;
          const match = (data?.results || []).find(
            (c) => (c.properties?.email || '').trim().toLowerCase() === em,
          );
          setDuplicate(match || null);
        })
        .catch(() => {
          if (!cancelled) setDuplicate(null);
        })
        .finally(() => {
          if (!cancelled) setCheckingDup(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(h);
      setCheckingDup(false);
    };
  }, [email, open]);

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const fn = firstname.trim();
    const ln = lastname.trim();
    const em = email.trim();
    const ph = phone.trim();
    const pc = postcode.trim();
    if (!fn) {
      setErr('First name is required.');
      return;
    }
    if (!em) {
      setErr('Email is required.');
      return;
    }
    if (!pc) {
      setErr('Postcode is required.');
      return;
    }
    setErr(null);
    setSubmitting(true);
    try {
      const contact = await apiPost<Contact>('/api/contacts', {
        firstname: fn,
        lastname: ln,
        email: em,
        phone: ph,
        postcode: pc,
      });
      onCreated(contact);
    } catch (e) {
      const er = e as Error & { code?: string };
      if (er.code === 'HUBSPOT_AUTH') {
        setErr('HubSpot token is invalid or expired — ask an admin to update the token.');
      } else if (er.code === 'HUBSPOT_RATE_LIMIT') {
        setErr('HubSpot rate limit reached — please wait a moment and try again.');
      } else {
        setErr(er.message || 'Failed to create customer.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (submitting) return;
        onClose();
      }}
      fullWidth
      maxWidth="sm"
      aria-labelledby="new-customer-dialog-title"
    >
      <DialogTitle id="new-customer-dialog-title">New customer</DialogTitle>
      <Box
        component="form"
        id="new-customer-form"
        onSubmit={handleSubmit}
        noValidate
      >
        <DialogContent dividers>
          <Stack spacing={2}>
            {err ? <Alert severity="error">{err}</Alert> : null}
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                id="nc-firstname"
                label="First name"
                value={firstname}
                onChange={(e) => setFirstname(e.target.value)}
                required
                autoFocus
                fullWidth
                size="small"
                disabled={submitting}
              />
              <TextField
                id="nc-lastname"
                label="Last name"
                value={lastname}
                onChange={(e) => setLastname(e.target.value)}
                fullWidth
                size="small"
                disabled={submitting}
              />
            </Stack>
            <TextField
              id="nc-email"
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              fullWidth
              size="small"
              disabled={submitting}
              error={!!duplicate}
              helperText={
                checkingDup
                  ? 'Checking for existing customer…'
                  : duplicate
                    ? 'A customer with this email already exists.'
                    : undefined
              }
            />
            {duplicate ? (
              <Alert
                id="nc-duplicate-notice"
                severity="warning"
                action={
                  <Button
                    component="a"
                    href={`/customers/${encodeURIComponent(duplicate.id)}`}
                    id="nc-duplicate-link"
                    size="small"
                    color="inherit"
                  >
                    Open
                  </Button>
                }
              >
                This email is already a customer
                {contactName(duplicate) ? `: ${contactName(duplicate)}` : ''}.
              </Alert>
            ) : null}
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                id="nc-phone"
                label="Phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                fullWidth
                size="small"
                disabled={submitting}
              />
              <TextField
                id="nc-postcode"
                label="Postcode"
                value={postcode}
                onChange={(e) => setPostcode(e.target.value)}
                required
                fullWidth
                size="small"
                disabled={submitting}
              />
            </Stack>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={submitting} id="nc-cancel-btn">
            Cancel
          </Button>
          <Button
            type="submit"
            variant="contained"
            id="nc-submit"
            disabled={submitting || !!duplicate}
          >
            {submitting ? 'Creating…' : 'Create customer'}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

// (NewContactBody type kept for future request-shape reference.)
export type { NewContactBody };

function humaniseError(e: Error & { code?: string }): string {
  if (e.code === 'HUBSPOT_AUTH') {
    return 'Could not connect to HubSpot — the API token is invalid or expired.';
  }
  if (e.code === 'HUBSPOT_RATE_LIMIT') return 'HubSpot rate limit reached. Please retry shortly.';
  if (e.code === 'HUBSPOT_ERROR') return 'Could not load contacts from HubSpot.';
  return `Failed to load contacts: ${e.message}`;
}

export default CustomersPage;
