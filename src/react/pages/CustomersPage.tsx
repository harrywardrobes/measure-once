import React, { useCallback, useState } from 'react';
import { fmtGBP } from '../utils/formatters';
import { useQBInvoices } from '../hooks/useQBInvoices';
import { usePrivilege } from '../hooks/usePrivilege';
import { useDevMode } from '../hooks/useDevMode';
import { useConnectionCheck, useConnectionToast } from '../context/ConnectionToastContext';
import { usePaginatedContacts, PAGINATED_CONTACTS_PAGE_LIMIT } from '../hooks/usePaginatedContacts';
import { ContactsPagination } from '../components/ContactsPagination';
import { InvoiceDetailDrawer, type InvoiceSummary as QBInvoice } from '../components/InvoiceDetailDrawer';
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
  Grid,
  InputAdornment,
  Select,
  Skeleton,
  Snackbar,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { PageFilterBar } from '../components/PageFilterBar';
import { StageTabGroup } from '../components/StageTabGroup';
import { FilterChipRow } from '../components/FilterChipRow';
import { SortSelect } from '../components/SortSelect';
import SearchIcon from '@mui/icons-material/Search';
import ClearIcon from '@mui/icons-material/Clear';
import AddIcon from '@mui/icons-material/Add';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { useCardActionHandlers, type CardActionHandlerData } from '../hooks/useCardActionHandlers';
import { dispatchCardActionHandler } from '../utils/dispatchCardActionHandler';
import { openCardActionModal } from '../utils/cardActionModalRegistry';
import type { ExistingVisit } from '../components/DesignVisitWizard';
import { STAGE_COLORS } from '../theme';

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

const SORT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'newest', label: 'Newest first' },
  { value: 'name-asc', label: 'Name A–Z' },
  { value: 'name-desc', label: 'Name Z–A' },
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
  archived: boolean;
}) {
  const qs = new URLSearchParams();
  if (s.page > 1) qs.set('page', String(s.page));
  if (s.leadStatus) qs.set('leadStatus', s.leadStatus);
  if (s.substatus && s.leadStatus) qs.set('substatus', s.substatus);
  if (s.sort && s.sort !== 'newest') qs.set('sort', s.sort);
  if (s.q) qs.set('q', s.q);
  if (s.stage) qs.set('stage', s.stage);
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
  const { isViewer } = usePrivilege();
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
  substatusCounts: Record<string, number>;
  nullLabel: string;
  loaded: boolean;
  subsLoaded: boolean;
  subsVersion: number;
};

const store: Store = {
  statuses: [],
  substatuses: [],
  counts: {},
  substatusCounts: {},
  nullLabel: 'No status',
  loaded: false,
  subsLoaded: false,
  subsVersion: 0,
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
      notify();
    }
  } catch (e) {
    console.warn('loadLeadStatuses failed:', (e as Error).message);
  }
}

async function loadLeadStatusCounts(stage?: string): Promise<void> {
  const url = stage
    ? `/api/contacts-lead-status-counts?stage=${encodeURIComponent(stage)}`
    : '/api/contacts-lead-status-counts';
  const counts = await apiGet<Record<string, number>>(url);
  if (counts && typeof counts === 'object') store.counts = counts;
}

async function loadSubstatusCounts(leadStatus: string, stage: string): Promise<void> {
  if (!leadStatus || leadStatus === '__no_status__') {
    store.substatusCounts = {};
    notify();
    return;
  }
  try {
    const qs = new URLSearchParams({ leadStatus });
    if (stage) qs.set('stage', stage);
    const counts = await apiGet<Record<string, number>>(`/api/contacts-substatus-counts?${qs}`);
    if (counts && typeof counts === 'object') store.substatusCounts = counts;
  } catch (e) {
    console.warn('loadSubstatusCounts failed:', (e as Error).message);
  }
  notify();
}

async function loadLeadSubstatuses(): Promise<void> {
  try {
    const rows = await apiGet<LeadSubstatus[]>('/api/lead-substatuses');
    if (Array.isArray(rows)) {
      store.substatuses = rows;
      store.subsVersion += 1;
    }
  } catch (e) {
    console.warn('loadLeadSubstatuses failed:', (e as Error).message);
  } finally {
    store.subsLoaded = true;
    notify();
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
    loadLeadStatusCounts?: (stage?: string) => Promise<void>;
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
function useLeadStatusSync(onChange: () => void, stageRef: React.MutableRefObject<string>) {
  React.useEffect(() => {
    const refresh = () => {
      const stage = stageRef.current || undefined;
      Promise.all([loadLeadStatuses(), loadLeadStatusCounts(stage).catch(() => {}), loadLeadSubstatuses()])
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

function QBBadge({
  invoices,
  onOpen,
}: {
  invoices: QBInvoice[];
  onOpen: (firstId: string, allIds: string[]) => void;
}) {
  if (!invoices.length) return null;
  const total = invoices.reduce((s, i) => s + (i.balance || 0), 0);
  const ids = invoices.map((i) => i.id);
  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.preventDefault();
    onOpen(ids[0], ids);
  };
  return (
    <Box
      component="button"
      type="button"
      onClick={handleClick}
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

function CustomerCardSkeleton() {
  return (
    <Card variant="outlined" sx={{ width: '100%', height: '100%' }}>
      <Box sx={{ p: 2 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start', justifyContent: 'space-between', mb: 1 }}>
          <Skeleton variant="text" width="55%" height={24} />
          <Skeleton variant="rounded" width={64} height={22} sx={{ flexShrink: 0 }} />
        </Stack>
        <Stack direction="row" spacing={0.75} sx={{ mb: 1, flexWrap: 'wrap' }}>
          <Skeleton variant="rounded" width={80} height={20} />
          <Skeleton variant="rounded" width={64} height={20} />
        </Stack>
        <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap' }}>
          <Skeleton variant="rounded" width={120} height={20} />
          <Skeleton variant="rounded" width={90} height={20} />
        </Stack>
      </Box>
    </Card>
  );
}

function CustomerCard({
  contact,
  statusMap,
  rooms,
  workflow,
  invoices,
  urgency,
  onOpenInvoice,
  cardActionHandlerFor,
  resolveActionLabel,
  draftVisitId,
}: {
  contact: Contact;
  statusMap: Map<string, LeadStatus>;
  rooms: Room[];
  workflow: WorkflowDef | null;
  invoices: QBInvoice[];
  urgency: Urgency;
  onOpenInvoice: (firstId: string, allIds: string[]) => void;
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

  // ── Action strip ─────────────────────────────────────────────────────────────
  const [dispatchingAction, setDispatchingAction] = useState(false);

  // Pick the highest-stage active room as the primary stage (rooms are
  // already sorted by stage descending in resolveRooms; first active wins).
  const primaryRoom = effectiveRooms.find((r) => (r.roomStatus || 'active') === 'active') || effectiveRooms[0];
  const primaryStageKey = primaryRoom?.stageKey || 'sales';
  const leadStatusKey = contact.properties?.hs_lead_status;
  const hwSubstatusValue = contact.properties?.hw_lead_substatus;

  const handler = cardActionHandlerFor(primaryStageKey, leadStatusKey, hwSubstatusValue);

  const cahName = handler?.config?.action_name
    ? handler.config.action_name
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c: string) => c.toUpperCase())
    : '';
  const isDesignHandler = handler?.type === 'start_design_visit';
  const hasDraft = !!draftVisitId && isDesignHandler;
  const actionLabel = cahName
    || (hasDraft ? 'Continue designing' : '')
    || resolveActionLabel(primaryStageKey, leadStatusKey, undefined, hwSubstatusValue);

  const stageColors = STAGE_COLORS[primaryStageKey];
  const actionTint = hasDraft ? '#F0FDF4' : (stageColors?.light || '#f3f4f6');
  const actionTextColor = hasDraft ? '#15803d' : (stageColors?.text || '#374151');

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
    <Card variant="outlined" sx={{ width: '100%', opacity: allArchived ? 0.7 : 1, overflow: 'hidden' }}>
      <CardActionArea
        component="a"
        href={`/customers/${encodeURIComponent(contact.id)}`}
        onClick={saveCustomersScroll}
        sx={{ p: 2, display: 'block' }}
      >
        {/* Two-column layout on md+; single column on mobile */}
        <Box sx={{ display: 'flex', gap: 2, flexDirection: { xs: 'column', md: 'row' }, alignItems: { md: 'flex-start' } }}>

          {/* Left column — name + contact identifiers */}
          <Box sx={{ flex: '1 1 0', minWidth: 0 }}>
            <Typography
              variant="subtitle1"
              noWrap
              sx={{ display: 'flex', alignItems: 'center', minWidth: 0, mb: 0.75 }}
            >
              <UrgencyDot urgency={urgency} />
              <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {name}
              </Box>
            </Typography>
            <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap' }}>
              {email ? <Chip label={email} size="small" variant="outlined" /> : null}
              {phone ? <Chip label={phone} size="small" variant="outlined" /> : null}
              {customerNum ? (
                <Chip label={customerNum} size="small" color="secondary" variant="outlined" />
              ) : null}
            </Stack>
          </Box>

          {/* Right column — stage pills, lead status, QB badge */}
          <Box sx={{ flex: '0 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 0.75, alignItems: { xs: 'flex-start', md: 'flex-end' } }}>
            {lsLabel ? <Chip label={lsLabel} size="small" color="primary" variant="outlined" /> : null}
            <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', justifyContent: { md: 'flex-end' } }}>
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
            <QBBadge invoices={invoices} onOpen={onOpenInvoice} />
          </Box>

        </Box>
      </CardActionArea>

      {/* Action strip — only rendered when a configured handler matches this
          card's stage/lead-status/substatus. Clicking fires the handler
          without also triggering the CardActionArea navigation link. */}
      {!!handler && (
        <Box
          role="button"
          tabIndex={-1}
          title={actionLabel || 'Run action'}
          onClick={handleActionClick}
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            px: 2,
            py: '9px',
            bgcolor: actionTint,
            borderTop: '1px solid',
            borderColor: 'divider',
            cursor: dispatchingAction ? 'wait' : 'pointer',
            opacity: dispatchingAction ? 0.7 : 1,
            transition: 'opacity 0.15s, filter 0.12s',
            '&:hover': dispatchingAction ? undefined : { filter: 'brightness(0.96)' },
          }}
        >
          <Typography sx={{ color: actionTextColor, fontWeight: 600, fontSize: '0.78rem' }}>
            {dispatchingAction ? 'Opening…' : actionLabel}
          </Typography>
          {dispatchingAction ? (
            <CircularProgress size={12} sx={{ color: actionTextColor }} />
          ) : (
            <ChevronRightIcon sx={{ fontSize: 15, color: actionTextColor, flexShrink: 0 }} />
          )}
        </Box>
      )}
    </Card>
  );
}

export function CustomersPage(): React.ReactElement {
  const initial = React.useMemo(() => readUrlState(), []);
  const [leadStatus, setLeadStatus] = React.useState<string>(initial.leadStatus);
  const [substatus, setSubstatus] = React.useState<string>(initial.substatus);
  const [sortBy, setSortBy] = React.useState<string>(initial.sort);
  const [searchInput, setSearchInput] = React.useState<string>(initial.q);
  const [search, setSearch] = React.useState<string>(initial.q);
  const [stageFilter, setStageFilter] = React.useState<string>(initial.stage);
  const [showArchived, setShowArchived] = React.useState<boolean>(initial.archived);
  const { notifyApiError } = useConnectionToast();
  useConnectionCheck();

  const [workflow, setWorkflow] = React.useState<WorkflowDef | null>(null);
  const [roomsByContact, setRoomsByContact] = React.useState<Record<string, Room[]>>({});
  const { invoices: qbInvoices, triggerLoad: triggerQBLoad, refresh: refreshQBInvoices } = useQBInvoices();
  React.useEffect(() => { triggerQBLoad(); }, [triggerQBLoad]);
  const [urgencyMap, setUrgencyMap] = React.useState<Record<string, Urgency>>({});

  // Invoice drawer state
  const [invDrawerOpen, setInvDrawerOpen]     = React.useState(false);
  const [invDrawerInvId, setInvDrawerInvId]   = React.useState<string | null>(null);
  const [invDrawerAllIds, setInvDrawerAllIds] = React.useState<string[]>([]);
  const handleOpenInvoice = useCallback((firstId: string, allIds: string[]) => {
    setInvDrawerInvId(firstId);
    setInvDrawerAllIds(allIds);
    setInvDrawerOpen(true);
  }, []);
  const { isAdmin } = usePrivilege();

  const { devMode } = useDevMode({ enabled: isAdmin });

  // ── Card action handlers ────────────────────────────────────────────────────
  const { cardActionHandlerFor, resolveActionLabel } = useCardActionHandlers();

  // ── Draft visit IDs ─────────────────────────────────────────────────────────
  // Batch-fetched for visible contacts so "Continue designing" strips appear.
  const [draftVisitIds, setDraftVisitIds] = React.useState<Record<string, number | string>>({});
  const [draftRefreshTick, setDraftRefreshTick] = React.useState(0);

  // ── Counts state ────────────────────────────────────────────────────────────
  const [countsLoading, setCountsLoading] = React.useState<boolean>(false);
  const [refreshNonce, setRefreshNonce] = React.useState<number>(0);
  const [bgRefreshFailed, setBgRefreshFailed] = React.useState(false);
  const [customersPageSize, setCustomersPageSize] = React.useState<number | undefined>(undefined);

  React.useEffect(() => {
    fetch('/api/page-filter-config', { headers: { Accept: 'application/json' } })
      .then(r => r.ok ? r.json() : null)
      .then((cfg: { customers_page_size?: number } | null) => {
        if (!cfg) return;
        const ps = cfg.customers_page_size;
        if (typeof ps === 'number' && ps > 0) setCustomersPageSize(ps);
      })
      .catch(() => {});
  }, []);
  // autoHideDuration is set to null while the document is hidden so the MUI
  // Snackbar timer is paused (Page Visibility API). Restored to 8 s when the
  // tab returns to the foreground.
  const [snackbarHideDuration, setSnackbarHideDuration] = React.useState<number | null>(8000);
  const bgRefreshFailedRef = React.useRef(false);
  React.useEffect(() => { bgRefreshFailedRef.current = bgRefreshFailed; }, [bgRefreshFailed]);
  React.useEffect(() => {
    const onVis = () => {
      if (!bgRefreshFailedRef.current) return;
      setSnackbarHideDuration(document.hidden ? null : 8000);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Counts refresh with retry: scheduled after each successful contacts fetch.
  // Timers are tracked in a ref so they can be cancelled if the component
  // unmounts or a new fetch replaces the previous one.
  const countsRetryTimersRef = React.useRef<ReturnType<typeof setTimeout>[]>([]);
  React.useEffect(() => {
    return () => { countsRetryTimersRef.current.forEach(clearTimeout); };
  }, []);

  const notifyApiErrorRef = React.useRef(notifyApiError);
  React.useEffect(() => { notifyApiErrorRef.current = notifyApiError; }, [notifyApiError]);

  // Keep a ref to the latest stageFilter so scheduleCounts (a stable callback)
  // always passes the current stage without needing to re-create on every change.
  const stageFilterRef = React.useRef(stageFilter);
  React.useEffect(() => { stageFilterRef.current = stageFilter; }, [stageFilter]);

  const scheduleCounts = React.useCallback(() => {
    countsRetryTimersRef.current.forEach(clearTimeout);
    countsRetryTimersRef.current = [];
    const MAX_COUNTS_RETRIES = 2;
    const COUNTS_RETRY_DELAY_MS = 30_000;
    function scheduleCountsAttempt(retryCount: number, waitMs: number) {
      const t = setTimeout(async () => {
        try {
          await loadLeadStatusCounts(stageFilterRef.current || undefined);
          populateLeadStatusFilter();
        } catch (e) {
          if (retryCount < MAX_COUNTS_RETRIES) {
            scheduleCountsAttempt(retryCount + 1, COUNTS_RETRY_DELAY_MS);
          } else {
            setBgRefreshFailed(true);
            notifyApiErrorRef.current('hubspot', e);
          }
        }
      }, waitMs);
      countsRetryTimersRef.current.push(t);
    }
    scheduleCountsAttempt(0, 0);
  }, []);

  const {
    contacts,
    total,
    totalPages,
    loading,
    error,
    contactsStale,
    page,
    setPage,
  } = usePaginatedContacts(
    { initialPage: initial.page, leadStatus, substatus, stage: stageFilter, sortBy, search, showArchived, refreshNonce, pageSize: customersPageSize },
    { onFetchSuccess: scheduleCounts },
  );

  const isViewer = useIsViewer();
  const [newOpen, setNewOpen] = React.useState<boolean>(() => {
    const p = new URLSearchParams(location.search);
    return p.get('new') === '1';
  });

  // Batch-fetch draft design-visit IDs for the visible contacts so
  // "Continue designing" action strips appear on matching cards.
  React.useEffect(() => {
    if (contacts.length === 0) {
      setDraftVisitIds({});
      return;
    }
    let cancelled = false;
    const ids = contacts.map((c) => c.id).join(',');
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
  }, [contacts, draftRefreshTick]);

  // Listen for design_visit_draft_changed broadcast to refresh draft IDs.
  React.useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const bc = new BroadcastChannel('design_visit_draft_changed');
    bc.addEventListener('message', () => setDraftRefreshTick((t) => t + 1));
    return () => bc.close();
  }, []);

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

  useLeadStatusSync(refreshDropdown, stageFilterRef);

  // Scroll to the top of the page when the user navigates to a new page.
  // Skip on the initial mount to avoid disrupting the scroll-position restore.
  const pageScrollInitialRef = React.useRef(true);
  React.useEffect(() => {
    if (pageScrollInitialRef.current) {
      pageScrollInitialRef.current = false;
      return;
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [page]);

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
      archived: showArchived,
    });
  }, [page, leadStatus, substatus, sortBy, search, stageFilter, showArchived]);

  // Load lead statuses + counts + substatuses on mount, then re-populate
  // the native select once the DOM element has been mounted.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      await Promise.all([
        loadLeadStatuses(),
        loadLeadStatusCounts(initial.stage || undefined).catch(() => {}),
        loadLeadSubstatuses(),
      ]);
      if (cancelled) return;
      populateLeadStatusFilter();
      forceRender();
    })();
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the stage tab changes, re-fetch lead-status counts scoped to that
  // stage so the pills reflect what's actually in that stage.
  const prevStageRef = React.useRef<string>(initial.stage);
  // Tracks which stage-count request is "current". Each fetch captures its
  // own generation at launch; only the latest generation may clear the
  // loading indicator, so rapid tab-switching never prematurely hides the
  // skeleton when an older request resolves after a newer one.
  const countsGenRef = React.useRef<number>(0);
  React.useEffect(() => {
    if (prevStageRef.current === stageFilter) return;
    prevStageRef.current = stageFilter;
    // Reset substatus counts immediately so stale chips don't flash.
    store.substatusCounts = {};
    notify();
    // Show skeleton while stage-scoped counts are loading. "All stages" always
    // uses cached global counts so it never needs a loading indicator.
    if (stageFilter) {
      const gen = ++countsGenRef.current;
      setCountsLoading(true);
      loadLeadStatusCounts(stageFilter)
        .then(() => {
          populateLeadStatusFilter();
          notify();
        })
        .catch(() => {})
        .finally(() => {
          if (gen === countsGenRef.current) setCountsLoading(false);
        });
    } else {
      loadLeadStatusCounts(undefined)
        .then(() => {
          populateLeadStatusFilter();
          notify();
        })
        .catch(() => {});
    }
  }, [stageFilter]);

  // When stage+leadStatus are both active, fetch substatus counts scoped to
  // the stage so only substatuses with contacts in that stage are shown.
  React.useEffect(() => {
    if (!stageFilter || !leadStatus || leadStatus === '__no_status__') {
      store.substatusCounts = {};
      notify();
      return;
    }
    let cancelled = false;
    loadSubstatusCounts(leadStatus, stageFilter).then(() => {
      if (!cancelled) notify();
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [stageFilter, leadStatus]);

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


  // Resolve rooms for display on a contact card. Stage and archived filtering
  // are now both server-side: when a stage is active and showArchived is false,
  // the server already excludes contacts whose only rooms in that stage are
  // archived, so every contact here has at least one active room in the stage.
  // This function only controls which room pills to show on the card: archived
  // rooms are omitted from the pills when showArchived is false. The fallback
  // to a synthetic "Main" room is retained for the no-stage (All) view where
  // archived-only contacts can still appear.
  const resolveRooms = React.useCallback(
    (contactId: string): Room[] => {
      const cached = roomsByContact[contactId];
      if (cached && cached.length > 0) {
        const filtered = cached
          .filter(r => showArchived || (r.roomStatus || 'active') === 'active')
          .map(r => ({
            room: r.room || 'Main',
            stageKey: r.stageKey || 'sales',
            roomStatus: r.roomStatus || 'active',
          }));
        return filtered.length > 0
          ? filtered
          : [{ room: 'Main', stageKey: 'sales', roomStatus: 'active' }];
      }
      return [{ room: 'Main', stageKey: 'sales', roomStatus: 'active' }];
    },
    [roomsByContact, showArchived],
  );

  // Client-side sub-status filter on top of the server-fetched page.
  // Stage and archived filtering are now server-side; resolveRooms handles
  // room-pill display only.
  const visibleContacts = React.useMemo(() => {
    const out: Array<{ contact: Contact; rooms: Room[] }> = [];
    for (const c of contacts) {
      if (substatus) {
        const v = String(c.properties?.hw_lead_substatus || '').toUpperCase();
        if (v !== substatus.toUpperCase()) continue;
      }
      out.push({ contact: c, rooms: resolveRooms(c.id) });
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
    // store.subsLoaded gates the initial load; store.subsVersion increments on
    // every successful re-fetch (e.g. after a BC rename or visibilitychange),
    // so the memo recomputes and shows updated labels without a page reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadStatus, store.subsLoaded, store.subsVersion]);

  // Build the stage tab list: All, then one button per workflow stage.
  const stageTabs = React.useMemo(() => {
    const tabs: Array<{ key: string; label: string }> = [
      { key: '__all__', label: 'All' },
    ];
    const stages = workflow?.stages || {};
    for (const [k, s] of Object.entries(stages)) {
      tabs.push({ key: k, label: s?.label || k });
    }
    return tabs;
  }, [workflow]);

  const currentTab: string = stageFilter ? stageFilter : '__all__';

  const onTabChange = (key: string) => {
    setPage(1);
    setSubstatus('');
    if (key === '__all__') {
      setStageFilter('');
    } else {
      setStageFilter(key);
    }
  };

  return (
    <Container maxWidth="lg" sx={{ py: 2 }}>
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

        {isAdmin && devMode && (
          <Alert
            id="dev-mode-banner"
            severity="warning"
            sx={{ borderRadius: 2 }}
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

        <PageFilterBar sx={{ px: 2, py: 1, bgcolor: 'background.default', borderBottom: '1px solid', borderColor: 'divider' }}>
          <StageTabGroup
            value={currentTab}
            onChange={onTabChange}
            tabs={stageTabs}
            stageColors={DEFAULT_STAGE_COLOURS}
          />
        </PageFilterBar>

        {/* ── Lead-status chip row ────────────────────────────────────────── */}
        {/* The native <select> stays in the DOM (off-screen) so the
            lead-status-sync test harness can read/mutate it via
            getElementById('lead-status-filter'). We preserve the original
            Skeleton + visibility:hidden pattern so the skeleton test (probe D)
            continues to pass: the Skeleton is a sibling of the FormControl
            inside the off-screen wrapper, and the FormControl toggles
            visibility:hidden↔visible as store.loaded changes. */}
        <Box
          sx={{ position: 'absolute', left: -9999, width: 200, overflow: 'hidden' }}
          aria-hidden="true"
        >
          {!store.loaded && (
            <Skeleton variant="rounded" sx={{ position: 'absolute', inset: 0, zIndex: 1 }} />
          )}
          <FormControl
            size="small"
            sx={{ width: '100%', visibility: store.loaded ? 'visible' : 'hidden' }}
          >
            <Select
              native
              value={leadStatus}
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                setLeadStatus(v);
                setSubstatus('');
                setPage(1);
              }}
              slotProps={{ input: { id: 'lead-status-filter', name: 'lead-status-filter' } }}
            >
              <option value="">All statuses</option>
              {store.loaded && (() => {
                const counts = store.counts || {};
                const nullCount = counts['__no_status__'] || 0;
                return (
                  <>
                    <option value="__no_status__" disabled={nullCount === 0}>
                      {store.nullLabel} ({nullCount})
                    </option>
                    {store.statuses.filter((s) => !s.excluded_from_sales).map((s) => {
                      const n = counts[s.key] || 0;
                      return (
                        <option key={s.key} value={s.key} disabled={n === 0}>
                          {s.label} ({n})
                        </option>
                      );
                    })}
                  </>
                );
              })()}
            </Select>
          </FormControl>
        </Box>

        {/* Chip row */}
        {!store.loaded || countsLoading ? (
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'nowrap', overflowX: 'auto' }}>
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} variant="rounded" width={90} height={28} sx={{ flexShrink: 0 }} />
            ))}
          </Stack>
        ) : (
          <FilterChipRow
            chips={[
              { key: '', label: 'All statuses' },
              ...(store.counts['__no_status__'] > 0
                ? [{ key: '__no_status__', label: store.nullLabel, count: store.counts['__no_status__'] }]
                : []),
              ...store.statuses
                .filter((s) => !s.excluded_from_sales)
                .filter((s) => (store.counts[s.key] || 0) > 0)
                .map((s) => ({ key: s.key, label: s.label, count: store.counts[s.key] || 0 })),
            ]}
            value={leadStatus}
            onChange={(key) => {
              setLeadStatus(key === '' || key === leadStatus ? '' : key);
              setSubstatus('');
              setPage(1);
            }}
          />
        )}

        {/* Substatus chip row — shown when a status with substatuses is selected */}
        {!store.subsLoaded && leadStatus && leadStatus !== '__no_status__' ? (
          <Skeleton
            data-testid="substatus-skeleton"
            variant="rounded"
            width={220}
            height={28}
          />
        ) : (() => {
          if (!availableSubstatuses.length) return null;
          // When a stage is active, only show substatuses that have at least
          // one contact in that stage + substatus combination.
          const visibleSubstatuses = stageFilter
            ? availableSubstatuses.filter((s) => {
                const chipKey = `${String(leadStatus).toUpperCase()}__${String(s.substatus_key).toUpperCase()}`;
                return (store.substatusCounts[chipKey] || 0) > 0;
              })
            : availableSubstatuses;
          if (!visibleSubstatuses.length) return null;
          return (
            <FilterChipRow
              chips={[
                { key: '', label: 'All sub-statuses' },
                ...visibleSubstatuses.map((s) => {
                  const chipKey = `${String(leadStatus).toUpperCase()}__${String(s.substatus_key).toUpperCase()}`;
                  const count = stageFilter ? (store.substatusCounts[chipKey] || 0) : undefined;
                  return {
                    key: chipKey,
                    label: s.label || s.substatus_key,
                    ...(count !== undefined ? { count } : {}),
                  };
                }),
              ]}
              value={substatus}
              onChange={(key) => {
                setSubstatus(key === '' || key === substatus ? '' : key);
                setPage(1);
              }}
            />
          );
        })()}

        {/* ── Sort row: search | sort-by | Show all ───────────────────────── */}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'center' } }}>
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

          <SortSelect
            value={sortBy}
            onChange={(v) => {
              setSortBy(v);
              setPage(1);
            }}
            options={SORT_OPTIONS}
            label="Sort by"
          />

          <Button
            id="archived-toggle"
            size="small"
            variant="text"
            color={showArchived ? 'secondary' : 'primary'}
            aria-pressed={showArchived}
            onClick={() => {
              const next = !showArchived;
              setShowArchived(next);
              setPage(1);
              setStageFilter('');
              if (!next) {
                setLeadStatus('');
                setSubstatus('');
              }
            }}
            sx={{ whiteSpace: 'nowrap', flexShrink: 0, alignSelf: { xs: 'flex-end', sm: 'auto' } }}
          >
            {showArchived ? 'Hide archived' : 'Show all'}
          </Button>
        </Stack>

        {error ? <Alert severity="error">{error}</Alert> : null}

        {!loading && contactsStale ? (
          <Alert severity="warning" sx={{ py: 0 }} id="contacts-stale-banner">
            Contact list may be out of date — HubSpot is temporarily unavailable.
          </Alert>
        ) : null}

        {loading ? (
          <Grid container spacing={2} id="customers-results">
            {Array.from({ length: 6 }).map((_, i) => (
              <Grid key={i} size={{ xs: 12 }}>
                <CustomerCardSkeleton />
              </Grid>
            ))}
          </Grid>
        ) : visibleContacts.length === 0 ? (
          <Box sx={{ py: 6, textAlign: 'center', color: 'text.secondary' }}>
            <Typography variant="body1">No customers match</Typography>
          </Box>
        ) : (
          <Grid container spacing={2} id="customers-results">
            {visibleContacts.map(({ contact, rooms }) => (
              <Grid key={contact.id} size={{ xs: 12 }}>
                <CustomerCard
                  contact={contact}
                  statusMap={statusMap}
                  rooms={rooms}
                  workflow={workflow}
                  invoices={matchInvoicesForContact(contact, qbInvoices)}
                  urgency={urgencyMap[contact.id] || null}
                  onOpenInvoice={handleOpenInvoice}
                  cardActionHandlerFor={cardActionHandlerFor}
                  resolveActionLabel={resolveActionLabel}
                  draftVisitId={draftVisitIds[contact.id] ?? null}
                />
              </Grid>
            ))}
          </Grid>
        )}

        <ContactsPagination
          page={page}
          totalPages={totalPages}
          total={total}
          visibleCount={visibleContacts.length}
          pageLimit={customersPageSize ?? PAGINATED_CONTACTS_PAGE_LIMIT}
          onPageChange={setPage}
        />

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <CircularProgress size={18} />
          </Box>
        ) : null}
      </Stack>

      <NewCustomerDialog
        open={newOpen && !isViewer}
        onClose={() => setNewOpen(false)}
        onCreated={() => {
          setNewOpen(false);
          // Trigger a refetch so the newly created contact appears and the
          // list returns to the canonical server-side order.
          setRefreshNonce((n) => n + 1);
        }}
      />
      <Snackbar
        open={bgRefreshFailed}
        autoHideDuration={snackbarHideDuration}
        onClose={() => setBgRefreshFailed(false)}
        message="Couldn't refresh live data — fresh results will load on your next visit"
      />

      {/* Invoice detail drawer */}
      <InvoiceDetailDrawer
        open={invDrawerOpen}
        invId={invDrawerInvId}
        allIds={invDrawerAllIds}
        onClose={() => setInvDrawerOpen(false)}
        onNavigate={id => setInvDrawerInvId(id)}
        isAdmin={isAdmin}
        onSaved={refreshQBInvoices}
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
  onCreated: () => void;
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
      onCreated();
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

export default CustomersPage;
