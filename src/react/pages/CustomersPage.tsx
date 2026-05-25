import React from 'react';
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
  };
}

function writeUrlState(s: {
  page: number;
  leadStatus: string;
  substatus: string;
  sort: string;
  q: string;
}) {
  const qs = new URLSearchParams();
  if (s.page > 1) qs.set('page', String(s.page));
  if (s.leadStatus) qs.set('leadStatus', s.leadStatus);
  if (s.substatus && s.leadStatus) qs.set('substatus', s.substatus);
  if (s.sort && s.sort !== 'newest') qs.set('sort', s.sort);
  if (s.q) qs.set('q', s.q);
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
  const [isViewer, setIsViewer] = React.useState<boolean>(() =>
    typeof document !== 'undefined' && document.body.classList.contains('viewer-mode'),
  );
  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    const sync = () => setIsViewer(document.body.classList.contains('viewer-mode'));
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    // chrome.js fetches /api/auth/user asynchronously; fall back to a direct
    // check so the New customer button can show even before that completes.
    fetch('/api/auth/user', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((u: { privilege_level?: string } | null) => {
        if (u && u.privilege_level === 'viewer') setIsViewer(true);
      })
      .catch(() => {});
    return () => obs.disconnect();
  }, []);
  return isViewer;
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

function CustomerCard({ contact, statusMap }: { contact: Contact; statusMap: Map<string, LeadStatus> }) {
  const name = contactName(contact);
  const email = contact.properties?.email || '';
  const phone = contact.properties?.phone || '';
  const customerNum = contact.properties?.customer_number || '';
  const rawLs = contact.properties?.hs_lead_status || '';
  const lsLabel = rawLs ? statusMap.get(rawLs)?.label || rawLs : '';

  return (
    <Card variant="outlined" sx={{ width: '100%' }}>
      <CardActionArea
        component="a"
        href={`/customers/${encodeURIComponent(contact.id)}`}
        sx={{ p: 2, display: 'block' }}
      >
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
          <Typography variant="subtitle1" fontWeight={600} noWrap>
            {name}
          </Typography>
          {lsLabel ? <Chip label={lsLabel} size="small" color="primary" variant="outlined" /> : null}
        </Stack>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
          {email ? <Chip label={email} size="small" variant="outlined" /> : null}
          {phone ? <Chip label={phone} size="small" variant="outlined" /> : null}
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
  const [viewMode, setViewMode] = React.useState<'all' | 'active'>('all');

  const [contacts, setContacts] = React.useState<Contact[]>([]);
  const [total, setTotal] = React.useState<number>(0);
  const [totalPages, setTotalPages] = React.useState<number>(1);
  const [loading, setLoading] = React.useState<boolean>(true);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = React.useState<number>(0);

  const isViewer = useIsViewer();
  const [newOpen, setNewOpen] = React.useState<boolean>(() => {
    const p = new URLSearchParams(location.search);
    return p.get('new') === '1';
  });

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
    writeUrlState({ page, leadStatus, substatus, sort: sortBy, q: search });
  }, [page, leadStatus, substatus, sortBy, search]);

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

  // Fetch the current page of contacts whenever the relevant filters change.
  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ page: String(page), limit: String(PAGE_LIMIT) });
    if (viewMode === 'all') {
      if (leadStatus) qs.set('leadStatus', leadStatus);
      if (sortBy && sortBy !== 'newest') qs.set('sort', sortBy);
      if (search) qs.set('q', search);
    }
    const endpoint =
      viewMode === 'all' ? `/api/contacts-all?${qs}` : `/api/open-leads`;
    apiGet<ContactsResponse>(endpoint)
      .then((data) => {
        if (cancelled) return;
        const list = data.results || [];
        setContacts(list);
        setTotal(data.total != null ? data.total : list.length);
        setTotalPages(data.totalPages || 1);
        setLoading(false);
        // Refresh counts after a status change so the dropdown stays accurate.
        if (viewMode === 'all') {
          loadLeadStatusCounts().then(populateLeadStatusFilter).catch(() => {});
        }
      })
      .catch((e: Error & { code?: string }) => {
        if (cancelled) return;
        setError(humaniseError(e));
        setContacts([]);
        setTotal(0);
        setTotalPages(1);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [page, leadStatus, sortBy, search, viewMode, refreshNonce]);

  // Local client-side sub-status filter on top of the fetched page.
  const visibleContacts = React.useMemo(() => {
    if (!substatus) return contacts;
    return contacts.filter(
      (c) =>
        String(c.properties?.hw_lead_substatus || '').toUpperCase() === substatus.toUpperCase(),
    );
  }, [contacts, substatus]);

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

  return (
    <Container maxWidth="md" sx={{ py: 3 }}>
      <Stack spacing={2}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          alignItems={{ xs: 'stretch', sm: 'center' }}
          justifyContent="space-between"
        >
          <Typography variant="h5" component="h1" fontWeight={700}>
            Customers
          </Typography>
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            justifyContent={{ xs: 'flex-start', sm: 'flex-end' }}
            flexWrap="wrap"
            useFlexGap
          >
            {isViewer ? null : (
              <Button
                id="new-customer-btn"
                variant="contained"
                size="small"
                startIcon={<AddIcon />}
                onClick={() => setNewOpen(true)}
              >
                New customer
              </Button>
            )}
            <ToggleButtonGroup
              size="small"
              exclusive
              value={viewMode}
              onChange={(_, v: 'all' | 'active' | null) => {
                if (!v) return;
                setViewMode(v);
                setPage(1);
                setLeadStatus('');
                setSubstatus('');
              }}
              aria-label="Contacts view mode"
            >
              <ToggleButton value="all">All contacts</ToggleButton>
              <ToggleButton value="active">Active leads</ToggleButton>
            </ToggleButtonGroup>
          </Stack>
        </Stack>

        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
          <TextField
            id="search"
            placeholder="Search customers"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            size="small"
            sx={{ flexGrow: 1 }}
            InputProps={{
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
            }}
            inputProps={{ 'aria-label': 'Search customers' }}
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
              inputProps={{ id: 'lead-status-filter', name: 'lead-status-filter' }}
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
        </Stack>

        {availableSubstatuses.length > 0 ? (
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
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

        {error ? <Alert severity="error">{error}</Alert> : null}

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
            {visibleContacts.map((c) => (
              <CustomerCard key={c.id} contact={c} statusMap={statusMap} />
            ))}
          </Stack>
        )}

        {totalPages > 1 ? (
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ pt: 1 }}>
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

  React.useEffect(() => {
    if (!open) {
      setFirstname('');
      setLastname('');
      setEmail('');
      setPhone('');
      setPostcode('');
      setErr(null);
      setSubmitting(false);
    }
  }, [open]);

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
            />
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
            disabled={submitting}
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
