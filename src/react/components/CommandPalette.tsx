import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ADMIN_ACTIVE_GROUP_PREFIX, ADMIN_ACTIVE_GROUP_LEGACY_KEY, ADMIN_ACTIVE_TAB_PREFIX, ADMIN_ACTIVE_TAB_LEGACY_KEY, CP_RECENT_CUSTOMERS_PREFIX, CP_RECENT_CUSTOMERS_LEGACY_KEY } from '../constants/localStorageKeys';
import { useAuth } from '../contexts/AuthContext';
import { loadSearchSettings } from '../lib/searchSettings';
import type { SearchSettings } from '../lib/searchSettings';
import { useQBInvoices } from '../hooks/useQBInvoices';
import { useContactSearch } from '../hooks/useContactSearch';
import { triggerLoad as triggerQBLoad } from '../lib/qbInvoicesStore';
import { clearOfflineData } from '../lib/registerServiceWorker';
import type { InvoiceSummary } from './InvoiceDetailDrawer';
import { usePrivilege } from '../hooks/usePrivilege';
import { useDevMode } from '../hooks/useDevMode';
import { FullScreenModal } from './modals/FullScreenModal';
import Box from '@mui/material/Box';
import InputBase from '@mui/material/InputBase';
import Typography from '@mui/material/Typography';
import ButtonBase from '@mui/material/ButtonBase';
import Avatar from '@mui/material/Avatar';
import Skeleton from '@mui/material/Skeleton';
import Alert from '@mui/material/Alert';

import SearchIcon from '@mui/icons-material/Search';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import GroupIcon from '@mui/icons-material/Group';
import HomeIcon from '@mui/icons-material/Home';
import ViewKanbanIcon from '@mui/icons-material/ViewKanban';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import PersonIcon from '@mui/icons-material/Person';
import SettingsIcon from '@mui/icons-material/Settings';
import LogoutIcon from '@mui/icons-material/Logout';
import TuneIcon from '@mui/icons-material/Tune';
import CodeIcon from '@mui/icons-material/Code';
import HubIcon from '@mui/icons-material/Hub';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import LockIcon from '@mui/icons-material/Lock';
import HistoryIcon from '@mui/icons-material/History';
import BuildIcon from '@mui/icons-material/Build';
import AssignmentIcon from '@mui/icons-material/Assignment';
import DesignServicesIcon from '@mui/icons-material/DesignServices';
import EmailIcon from '@mui/icons-material/Email';
import BugReportIcon from '@mui/icons-material/BugReport';
import WifiOffIcon from '@mui/icons-material/WifiOff';
import MapIcon from '@mui/icons-material/Map';

declare global {
  interface Window {
    openCommandPalette?: () => void;
    closeCommandPalette?: () => void;
    _cpRun?: Record<string, () => void>;
    adminSwitchGroup?: (groupId: string) => void;
    adminSwitchToTab?: (tabId: string) => void;
  }
}

interface Action {
  id: string;
  label: string;
  hint: string;
  category: string;
  icon: React.ReactElement;
  href?: string;
}

const ALL_ACTIONS: Action[] = [
  { id: 'new-customer',    label: 'New customer',           hint: 'Create a new customer record',           category: 'Action',   icon: <PersonAddIcon fontSize="small" /> },
  { id: 'go-customers',    label: 'All customers',          hint: 'Browse your customer list',              category: 'Navigate', icon: <GroupIcon fontSize="small" />,           href: '/customers' },
  { id: 'go-home',         label: 'Home dashboard',         hint: 'Go to the main dashboard',               category: 'Navigate', icon: <HomeIcon fontSize="small" />,            href: '/' },
  { id: 'go-projects',     label: 'Projects tracker',       hint: 'Active workshop and delivery jobs',      category: 'Navigate', icon: <ViewKanbanIcon fontSize="small" />,      href: '/projects' },
  { id: 'go-survey',       label: 'Survey visits',          hint: 'View and manage survey visits',          category: 'Navigate', icon: <AssignmentIcon fontSize="small" />,      href: '/survey' },
  { id: 'go-invoices',     label: 'Invoices & payments',    hint: 'View and send invoices via QuickBooks',  category: 'Navigate', icon: <ReceiptLongIcon fontSize="small" />,     href: '/invoices' },
  { id: 'go-admin',        label: 'Admin panel',            hint: 'Manage users and team access',           category: 'Navigate', icon: <AdminPanelSettingsIcon fontSize="small" />, href: '/admin' },
  { id: 'go-profile',      label: 'Your profile',           hint: 'Update your account details',            category: 'Account',  icon: <PersonIcon fontSize="small" />,          href: '/profile' },
  { id: 'filter-workshop', label: 'Customers · Workshop',   hint: 'Show only customers in Workshop',        category: 'Filter',   icon: <SettingsIcon fontSize="small" />,        href: '/customers?stage=workshop' },
  { id: 'sign-out',        label: 'Sign out',               hint: 'End your current session',               category: 'Account',  icon: <LogoutIcon fontSize="small" /> },
];

// Admin-only actions that jump directly to a tab group in the admin panel.
// Shown only to admins; merged into the active action list inside the component.
const ADMIN_GROUP_ACTIONS: Action[] = [
  { id: 'go-admin-group-people',        label: 'Admin · People',        hint: 'Jump to the People group (Alt+1)',        category: 'Admin', icon: <GroupIcon fontSize="small" /> },
  { id: 'go-admin-group-configuration', label: 'Admin · Configuration', hint: 'Jump to the Configuration group (Alt+2)', category: 'Admin', icon: <TuneIcon fontSize="small" /> },
  { id: 'go-admin-group-developer',     label: 'Admin · Developer',     hint: 'Jump to the Developer group (Alt+3)',     category: 'Admin', icon: <CodeIcon fontSize="small" /> },
  // People tabs
  { id: 'go-admin-tab-team',            label: 'Admin · Team',               hint: 'Manage team members and invitations',          category: 'Admin', icon: <GroupIcon fontSize="small" /> },
  { id: 'go-admin-tab-permissions',     label: 'Admin · Permissions & roles', hint: 'Configure user permissions and roles',         category: 'Admin', icon: <LockIcon fontSize="small" /> },
  { id: 'go-admin-tab-requests',        label: 'Admin · Pending Requests',    hint: 'Review and approve access requests',           category: 'Admin', icon: <PersonAddIcon fontSize="small" /> },
  { id: 'go-admin-tab-auditlog',        label: 'Admin · Audit Log',           hint: 'View a log of admin actions',                  category: 'Admin', icon: <HistoryIcon fontSize="small" /> },
  // Configuration tabs
  { id: 'go-admin-tab-hubspot',         label: 'Admin · HubSpot',             hint: 'Jump to Configuration → HubSpot',              category: 'Admin', icon: <HubIcon fontSize="small" /> },
  { id: 'go-admin-tab-stages',          label: 'Admin · Stages',              hint: 'Manage lead and project stages',               category: 'Admin', icon: <AccountTreeIcon fontSize="small" /> },
  { id: 'go-admin-tab-cardactions',     label: 'Admin · Card Actions',        hint: 'Configure customer card action buttons',       category: 'Admin', icon: <ViewKanbanIcon fontSize="small" /> },
  { id: 'go-admin-tab-actionhandlers',  label: 'Admin · Action Handlers',     hint: 'Manage action handler types and settings',     category: 'Admin', icon: <BuildIcon fontSize="small" /> },
  { id: 'go-admin-visits',              label: 'Admin · Visits',              hint: 'Configure visit settings (catalogues, questionnaire, terms)', category: 'Admin', icon: <DesignServicesIcon fontSize="small" /> },
  { id: 'go-admin-tab-emailtemplates',  label: 'Admin · Email Templates',     hint: 'Edit email templates sent to customers',       category: 'Admin', icon: <EmailIcon fontSize="small" /> },
  { id: 'go-admin-tab-workflow',        label: 'Admin · Workflow',             hint: 'View workflow — stages, handlers, and email chains', category: 'Admin', icon: <AccountTreeIcon fontSize="small" /> },
  // Developer tabs (filtered out when devMode is off)
  { id: 'go-admin-tab-settings',        label: 'Admin · Settings',            hint: 'Application settings and configuration',       category: 'Admin', icon: <SettingsIcon fontSize="small" /> },
  { id: 'go-admin-tab-devenv',          label: 'Admin · Dev Environment',     hint: 'View dev-only features and environment info',  category: 'Admin', icon: <BugReportIcon fontSize="small" /> },
  { id: 'go-admin-tab-search',          label: 'Admin · Search',              hint: 'Configure search and command palette settings', category: 'Admin', icon: <SearchIcon fontSize="small" /> },
  { id: 'go-admin-tab-maps',            label: 'Admin · Google Maps',         hint: 'Configure Google Places autocomplete and map previews', category: 'Admin', icon: <MapIcon fontSize="small" /> },
  { id: 'go-admin-tab-offline',         label: 'Admin · Offline Support',     hint: 'Manage offline mode and cached data',          category: 'Admin', icon: <WifiOffIcon fontSize="small" /> },
];


function contactName(c: { properties?: { firstname?: string; lastname?: string } }): string {
  const first = c.properties?.firstname || '';
  const last  = c.properties?.lastname  || '';
  return (first + ' ' + last).trim();
}

function contactInitials(name: string): string {
  return name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
}

const RESULT_ITEM_SX = {
  display: 'flex',
  alignItems: 'center',
  gap: 1.25,
  px: 2,
  py: 1,
  width: '100%',
  textAlign: 'left',
  borderRadius: 0,
  '&:hover, &.Mui-focusVisible': {
    bgcolor: 'rgba(32, 8, 66, 0.06)',
  },
  '&:focus-visible': {
    outline: 'none',
    bgcolor: 'rgba(32, 8, 66, 0.08)',
  },
} as const;

const SECTION_LABEL_SX = {
  px: 2,
  pt: 1.25,
  pb: 0.5,
  fontSize: '0.68rem',
  fontWeight: 700,
  letterSpacing: '0.07em',
  textTransform: 'uppercase',
  color: 'text.disabled',
} as const;

interface ResultItemProps {
  icon?: React.ReactElement;
  avatar?: string;
  label: string;
  sub?: string;
  category?: string;
  onClick: () => void;
  itemRef?: React.Ref<HTMLButtonElement>;
}

function ResultItem({ icon, avatar, label, sub, category, onClick, itemRef }: ResultItemProps) {
  return (
    <ButtonBase sx={RESULT_ITEM_SX} onClick={onClick} ref={itemRef} tabIndex={0} data-cp-item="1">
      {avatar !== undefined ? (
        <Avatar sx={{ width: 26, height: 26, fontSize: '0.65rem', fontWeight: 700, bgcolor: 'rgba(32,8,66,0.12)', color: 'secondary.main' }}>
          {avatar}
        </Avatar>
      ) : icon ? (
        <Box sx={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'text.secondary', flexShrink: 0 }}>
          {icon}
        </Box>
      ) : null}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography noWrap sx={{ fontSize: '0.875rem', fontWeight: 500, lineHeight: 1.3, color: 'text.primary' }}>
          {label}
        </Typography>
        {sub && (
          <Typography noWrap sx={{ fontSize: '0.75rem', color: 'text.secondary', lineHeight: 1.3 }}>
            {sub}
          </Typography>
        )}
      </Box>
      {category && (
        <Typography sx={{ fontSize: '0.68rem', color: 'text.disabled', flexShrink: 0, fontWeight: 500 }}>
          {category}
        </Typography>
      )}
    </ButtonBase>
  );
}

// Tab action IDs that belong to the Developer group in the admin panel.
const DEVELOPER_TAB_ACTION_IDS = new Set([
  'go-admin-tab-settings',
  'go-admin-tab-devenv',
  'go-admin-tab-search',
  'go-admin-tab-maps',
  'go-admin-tab-offline',
]);

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [settings, setSettings] = useState<SearchSettings | null>(null);

  // ── Migration shim — clear the old unscoped recent-customers key once per browser session ──
  useEffect(() => {
    try { localStorage.removeItem(CP_RECENT_CUSTOMERS_LEGACY_KEY); } catch { /* ignore */ }
  }, []);
  // null = not yet fetched; true = dev environment; false = production
  const [isDevelopment, setIsDevelopment] = useState<boolean | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { invoices: qbInvoices, loading: invoicesLoading } = useQBInvoices();
  const { contacts: searchedContacts, loading: contactsLoading } = useContactSearch(query, open);
  const { isAdmin } = usePrivilege();
  const { devMode } = useDevMode({ enabled: isAdmin });

  useEffect(() => {
    if (settings !== null) return;
    loadSearchSettings().then(data => {
      setSettings(data);
    });
  }, [settings]);

  useEffect(() => {
    if (!isAdmin || isDevelopment !== null) return;
    fetch('/api/admin/server-env', { headers: { Accept: 'application/json' } })
      .then(r => (r.ok ? r.json() : null))
      .then((data: { isDevelopment?: boolean } | null) => {
        if (data && typeof data.isDevelopment === 'boolean') {
          setIsDevelopment(data.isDevelopment);
        }
      })
      .catch(() => {});
  }, [isAdmin, isDevelopment]);

  const doOpen = useCallback(() => {
    triggerQBLoad();
    const seed = location.pathname === '/customers'
      ? new URLSearchParams(location.search).get('q') || '' : '';
    setQuery(seed);
    setOpen(true);
    setTimeout(() => inputRef.current?.focus(), 30);
  }, []);

  const doClose = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  useEffect(() => {
    window.openCommandPalette = doOpen;
    window.closeCommandPalette = doClose;

    const adminGroupNav = (groupId: string) => {
      doClose();
      if (typeof window.adminSwitchGroup === 'function') {
        window.adminSwitchGroup(groupId);
      } else {
        try {
          const uid = (window as unknown as { __moHeaderUser?: { id?: string } }).__moHeaderUser?.id;
          const gk = uid ? `${ADMIN_ACTIVE_GROUP_PREFIX}${uid}` : ADMIN_ACTIVE_GROUP_LEGACY_KEY;
          localStorage.setItem(gk, groupId);
        } catch (_) {}
        location.href = '/admin';
      }
    };

    const adminTabNav = (tabId: string, groupId: string) => {
      doClose();
      if (typeof window.adminSwitchToTab === 'function') {
        window.adminSwitchToTab(tabId);
      } else {
        try {
          const uid = (window as unknown as { __moHeaderUser?: { id?: string } }).__moHeaderUser?.id;
          const gk = uid ? `${ADMIN_ACTIVE_GROUP_PREFIX}${uid}` : ADMIN_ACTIVE_GROUP_LEGACY_KEY;
          const tk = uid ? `${ADMIN_ACTIVE_TAB_PREFIX}${uid}`   : ADMIN_ACTIVE_TAB_LEGACY_KEY;
          localStorage.setItem(gk, groupId);
          localStorage.setItem(tk, tabId);
        } catch (_) {}
        location.href = '/admin';
      }
    };

    window._cpRun = {
      'new-customer': () => {
        doClose();
        location.href = '/customers?new=1';
      },
      'sign-out': () => {
        const done = () => { location.href = '/login?signed_out=1'; };
        clearOfflineData().finally(() => {
          fetch('/api/logout', { method: 'POST' }).then(done).catch(done);
        });
      },
      'go-admin-group-people':        () => adminGroupNav('people'),
      'go-admin-group-configuration': () => adminGroupNav('configuration'),
      'go-admin-group-developer':     () => adminGroupNav('developer'),
      // People tabs
      'go-admin-tab-team':            () => adminTabNav('team',           'people'),
      'go-admin-tab-permissions':     () => adminTabNav('permissions',    'people'),
      'go-admin-tab-requests':        () => adminTabNav('requests',       'people'),
      'go-admin-tab-auditlog':        () => adminTabNav('auditlog',       'people'),
      // Configuration tabs
      'go-admin-tab-hubspot':         () => adminTabNav('hubspot',        'configuration'),
      'go-admin-tab-stages':          () => adminTabNav('stages',         'configuration'),
      'go-admin-tab-cardactions':     () => adminTabNav('cardactions',    'configuration'),
      'go-admin-tab-actionhandlers':  () => adminTabNav('actionhandlers', 'configuration'),
      'go-admin-visits':              () => adminTabNav('designvisit', 'visits'),
      'go-admin-tab-emailtemplates':  () => adminTabNav('emailtemplates', 'configuration'),
      'go-admin-tab-workflow':        () => adminTabNav('workflow',        'configuration'),
      // Developer tabs
      'go-admin-tab-settings':        () => adminTabNav('settings',       'developer'),
      'go-admin-tab-devenv':          () => adminTabNav('devenv',         'developer'),
      'go-admin-tab-search':          () => adminTabNav('search',         'developer'),
      'go-admin-tab-maps':            () => adminTabNav('maps',           'developer'),
      'go-admin-tab-offline':         () => adminTabNav('offline',        'developer'),
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (open) doClose();
        else doOpen();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [doOpen, doClose, open]);

  const activeActions: Action[] = React.useMemo(() => {
    const base = isAdmin ? [...ALL_ACTIONS, ...ADMIN_GROUP_ACTIONS] : ALL_ACTIONS;
    if (!settings) return base;
    const disabled = new Set(settings.disabled_actions || []);
    let active = base.filter(a => !disabled.has(a.id));
    const order = settings.action_order || [];
    if (order.length) {
      active = [...active].sort((a, b) => {
        const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
        if (ai === -1 && bi === -1) return 0;
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      });
    }
    return active;
  }, [settings, isAdmin]);

  const hintPlaceholder = settings?.hint_placeholder || 'Search customers, actions…';

  const handleAction = useCallback((action: Action) => {
    if (action.href) {
      doClose();
      location.href = action.href;
    } else if (window._cpRun?.[action.id]) {
      window._cpRun[action.id]();
    } else {
      doClose();
    }
  }, [doClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); doClose(); return; }
    const items = listRef.current ? Array.from(listRef.current.querySelectorAll<HTMLElement>('button[data-cp-item]')) : [];
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const idx = items.indexOf(document.activeElement as HTMLElement);
      const next = items[idx + 1] ?? items[0];
      next?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const idx = items.indexOf(document.activeElement as HTMLElement);
      const prev = items[idx - 1] ?? items[items.length - 1];
      prev?.focus();
    } else if (e.key === 'Enter') {
      items[0]?.click();
    }
  }, [doClose]);

  const q = query.toLowerCase().trim();
  const encoded = encodeURIComponent(query.trim());

  const invoices: InvoiceSummary[] = qbInvoices;

  const matchedContacts = q ? searchedContacts : [];

  const matchedInvoices: InvoiceSummary[] = q
    ? invoices.filter(inv => {
        const custName  = (inv.customerName || '').toLowerCase();
        const docNumber = (inv.docNumber    || '').toLowerCase();
        return custName.includes(q) || docNumber.includes(q);
      }).slice(0, 5)
    : [];

  // Determine whether an admin-tab action should appear in the palette.
  //
  // Two-stage check:
  //   1. If the legacy .tabs DOM is present (we're on /admin), use the actual
  //      hidden state of the tab button — the same source AdminGroupedTabsBar
  //      reads, so command palette and tab bar are always in sync.
  //   2. When the admin DOM is absent (other pages), apply the environment
  //      policy: developer-group tabs are only shown in non-production
  //      environments (isDevelopment=true). Non-developer admin tabs are
  //      always allowed — navigating to /admin will apply real visibility.
  const isAdminTabVisible = (actionId: string): boolean => {
    if (!actionId.startsWith('go-admin-tab-')) return true;
    const tabId = actionId.replace('go-admin-tab-', '');
    const btn = document.querySelector<HTMLElement>(`.tabs .tab-btn[data-tab="${tabId}"]`);
    if (btn) return !btn.hidden; // On admin page — use real DOM state
    // Off admin page: apply environment policy for developer-group tabs.
    if (DEVELOPER_TAB_ACTION_IDS.has(actionId)) {
      return isDevelopment !== false; // hide when explicitly production (false)
    }
    return true;
  };

  const filteredActions = q
    ? activeActions.filter(a =>
        isAdminTabVisible(a.id) &&
        (a.label.toLowerCase().includes(q) || a.hint.toLowerCase().includes(q)))
    : activeActions.filter(a => isAdminTabVisible(a.id));

  const { user: _cpUser } = useAuth();
  const _cpUserId = _cpUser?.id;

  let recentCustomers: Array<{ id: string; name: string; company?: string }> = [];
  if (!q) {
    try {
      const uid = _cpUserId ?? (window as unknown as { __moHeaderUser?: { id?: string } }).__moHeaderUser?.id;
      const cpKey = uid ? `${CP_RECENT_CUSTOMERS_PREFIX}${uid}` : CP_RECENT_CUSTOMERS_LEGACY_KEY;
      recentCustomers = JSON.parse(localStorage.getItem(cpKey) || '[]');
    } catch (_) {}
  }

  const urlParams = location.pathname === '/customers' ? new URLSearchParams(location.search) : null;
  const _ls   = urlParams?.get('leadStatus') || '';
  const _sort = urlParams?.get('sort')        || '';
  const _page = parseInt(urlParams?.get('page') || '1', 10) || 1;
  let customersSearchUrl = '/customers?q=' + encoded;
  if (_ls)                        customersSearchUrl += '&leadStatus=' + encodeURIComponent(_ls);
  if (_sort && _sort !== 'newest') customersSearchUrl += '&sort='       + encodeURIComponent(_sort);
  if (_page > 1)                  customersSearchUrl += '&page='        + _page;

  const hasResults = q
    ? (matchedContacts.length > 0 || matchedInvoices.length > 0 || filteredActions.length > 0 || true)
    : (recentCustomers.length > 0 || filteredActions.length > 0);

  return (
    <FullScreenModal
      open={open}
      onClose={doClose}
      ariaLabel="Command palette"
      title={
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <SearchIcon sx={{ color: 'text.secondary', flexShrink: 0 }} />
          <InputBase
            inputRef={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={hintPlaceholder}
            fullWidth
            inputProps={{ 'aria-label': 'Command palette search', autoComplete: 'off', autoCorrect: 'off', spellCheck: false }}
            sx={{ fontSize: '0.9375rem', '& input': { py: 0.25 } }}
          />
        </Box>
      }
      headerActions={
        <Box
          component="kbd"
          sx={{
            display: { xs: 'none', sm: 'inline-flex' },
            alignItems: 'center',
            px: 0.75,
            py: 0.25,
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: '5px',
            fontSize: '0.7rem',
            fontFamily: 'inherit',
            color: 'text.disabled',
            whiteSpace: 'nowrap',
            flexShrink: 0,
            cursor: 'pointer',
            userSelect: 'none',
          }}
          onClick={doClose}
        >
          Esc
        </Box>
      }
    >
      <Box
        ref={listRef}
        sx={{ mx: -3, my: -2.5, py: 0.5 }}
      >
        {q && (
          <>
            <Typography sx={SECTION_LABEL_SX}>Search</Typography>
            <ResultItem
              icon={<SearchIcon fontSize="small" />}
              label={`Search customers for "${query.trim()}"`}
              sub="Browse all matching customers"
              onClick={() => { doClose(); location.href = customersSearchUrl; }}
            />
            <ResultItem
              icon={<ReceiptLongIcon fontSize="small" />}
              label={`Search invoices for "${query.trim()}"`}
              sub="Filter invoices by customer or invoice number"
              onClick={() => { doClose(); location.href = `/invoices?q=${encoded}`; }}
            />
          </>
        )}

        {q && contactsLoading && (
          <>
            <Typography sx={SECTION_LABEL_SX}>Customers</Typography>
            {isAdmin && devMode && (
              <Alert severity="warning" icon={false} sx={{ mx: 2, mb: 0.5, py: 0.25, fontSize: '0.75rem' }}>
                Dev mode ON — test contacts only
              </Alert>
            )}
            {[0, 1, 2].map(i => (
              <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 1.25, px: 2, py: 1 }}>
                <Skeleton variant="circular" width={26} height={26} />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Skeleton variant="text" width="55%" height={18} />
                  <Skeleton variant="text" width="35%" height={14} />
                </Box>
              </Box>
            ))}
          </>
        )}

        {q && !contactsLoading && matchedContacts.length === 0 && isAdmin && devMode && (
          <>
            <Typography sx={SECTION_LABEL_SX}>Customers</Typography>
            <Alert severity="warning" icon={false} sx={{ mx: 2, mb: 0.5, py: 0.25, fontSize: '0.75rem' }}>
              Dev mode ON — no test contacts matched
            </Alert>
          </>
        )}

        {!contactsLoading && matchedContacts.length > 0 && (
          <>
            <Typography sx={SECTION_LABEL_SX}>Customers</Typography>
            {isAdmin && devMode && (
              <Alert severity="warning" icon={false} sx={{ mx: 2, mb: 0.5, py: 0.25, fontSize: '0.75rem' }}>
                Dev mode ON — test contacts only
              </Alert>
            )}
            {matchedContacts.map(c => {
              const name = contactName(c) || 'Unknown';
              const initials = contactInitials(name);
              const company = c.properties?.company || undefined;
              const id = c.id || '';
              return (
                <ResultItem
                  key={id || name}
                  avatar={initials}
                  label={name}
                  sub={company}
                  onClick={() => { doClose(); location.href = `/customers/${id}`; }}
                />
              );
            })}
          </>
        )}

        {invoicesLoading && (
          <>
            <Typography sx={SECTION_LABEL_SX}>Invoices</Typography>
            {[0, 1, 2].map(i => (
              <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 1.25, px: 2, py: 1 }}>
                <Skeleton variant="rounded" width={20} height={20} />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Skeleton variant="text" width="50%" height={18} />
                  <Skeleton variant="text" width="30%" height={14} />
                </Box>
              </Box>
            ))}
          </>
        )}

        {!invoicesLoading && matchedInvoices.length > 0 && (
          <>
            <Typography sx={SECTION_LABEL_SX}>Invoices</Typography>
            {matchedInvoices.map(inv => {
              const label = inv.customerName || inv.docNumber || 'Invoice';
              const doc   = inv.docNumber ? `#${inv.docNumber}` : '';
              const bal   = inv.balance != null ? ` · £${Number(inv.balance).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
              const sub   = [doc, bal].filter(Boolean).join('') || undefined;
              return (
                <ResultItem
                  key={inv.id ?? label}
                  icon={<ReceiptLongIcon fontSize="small" />}
                  label={label}
                  sub={sub}
                  onClick={() => {
                    doClose();
                    if (typeof (window as Window & { openInvoicePanel?: (id: string) => void }).openInvoicePanel === 'function') {
                      (window as Window & { openInvoicePanel?: (id: string) => void }).openInvoicePanel!(String(inv.id));
                    } else {
                      location.href = '/invoices';
                    }
                  }}
                />
              );
            })}
          </>
        )}

        {!q && recentCustomers.length > 0 && (
          <>
            <Typography sx={SECTION_LABEL_SX}>Recent</Typography>
            {recentCustomers.map(r => (
              <ResultItem
                key={r.id}
                avatar={contactInitials(r.name)}
                label={r.name}
                sub={r.company}
                onClick={() => { doClose(); location.href = `/customers/${r.id}`; }}
              />
            ))}
          </>
        )}

        {filteredActions.length > 0 && (
          <>
            <Typography sx={SECTION_LABEL_SX}>{q ? 'Actions' : 'Quick Actions'}</Typography>
            {filteredActions.map(action => (
              <ResultItem
                key={action.id}
                icon={action.icon}
                label={action.label}
                sub={action.hint}
                category={action.category}
                onClick={() => handleAction(action)}
              />
            ))}
          </>
        )}

        {!hasResults && q && (
          <Box sx={{ px: 2, py: 3, textAlign: 'center' }}>
            <Typography sx={{ fontSize: '0.875rem', color: 'text.secondary' }}>
              No results for &ldquo;{query}&rdquo;
            </Typography>
          </Box>
        )}
      </Box>
    </FullScreenModal>
  );
}

export default CommandPalette;
