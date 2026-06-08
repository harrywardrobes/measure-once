import React, { useCallback, useEffect, useRef, useState } from 'react';
import { loadSearchSettings } from '../lib/searchSettings';
import type { SearchSettings } from '../lib/searchSettings';
import { useQBInvoices } from '../hooks/useQBInvoices';
import { useContactSearch } from '../hooks/useContactSearch';
import { triggerLoad as triggerQBLoad } from '../lib/qbInvoicesStore';
import { clearOfflineData } from '../lib/registerServiceWorker';
import type { InvoiceSummary } from './InvoiceDetailDrawer';
import { usePrivilege } from '../hooks/usePrivilege';
import { useDevMode } from '../hooks/useDevMode';
import Dialog from '@mui/material/Dialog';
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
import ExtensionIcon from '@mui/icons-material/Extension';
import CodeIcon from '@mui/icons-material/Code';

declare global {
  interface Window {
    openCommandPalette?: () => void;
    closeCommandPalette?: () => void;
    _cpRun?: Record<string, () => void>;
    adminSwitchGroup?: (groupId: string) => void;
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
  { id: 'go-admin-group-integrations',  label: 'Admin · Integrations',  hint: 'Jump to the Integrations group (Alt+3)',  category: 'Admin', icon: <ExtensionIcon fontSize="small" /> },
  { id: 'go-admin-group-developer',     label: 'Admin · Developer',     hint: 'Jump to the Developer group (Alt+4)',     category: 'Admin', icon: <CodeIcon fontSize="small" /> },
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

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [settings, setSettings] = useState<SearchSettings | null>(null);
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
        try { localStorage.setItem('adminActiveGroup', groupId); } catch (_) {}
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
      'go-admin-group-integrations':  () => adminGroupNav('integrations'),
      'go-admin-group-developer':     () => adminGroupNav('developer'),
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

  const filteredActions = q
    ? activeActions.filter(a => a.label.toLowerCase().includes(q) || a.hint.toLowerCase().includes(q))
    : activeActions;

  let recentCustomers: Array<{ id: string; name: string; company?: string }> = [];
  if (!q) {
    try {
      recentCustomers = JSON.parse(localStorage.getItem('cp_recent_customers') || '[]');
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
    <Dialog
      open={open}
      onClose={doClose}
      maxWidth={false}
      slotProps={{
        paper: {
          sx: {
            width: '100%',
            maxWidth: 560,
            m: { xs: 1, sm: 2 },
            borderRadius: '12px',
            overflow: 'hidden',
            boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
          },
        },
      }}
      sx={{
        '& .MuiBackdrop-root': { backdropFilter: 'blur(2px)', backgroundColor: 'rgba(0,0,0,0.4)' },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', px: 2, py: 1.5, borderBottom: '1px solid', borderColor: 'divider', gap: 1 }}>
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
      </Box>

      <Box
        ref={listRef}
        sx={{ maxHeight: 420, overflowY: 'auto', py: 0.5 }}
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
    </Dialog>
  );
}

export default CommandPalette;
