import React, { useCallback, useEffect, useState, useMemo } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Skeleton,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { usePrivilege } from '../hooks/usePrivilege';
import { useConnectionCheck } from '../context/ConnectionToastContext';
import { ContactsPagination } from '../components/ContactsPagination';
import {
  InvoiceDetailDrawer,
  InvoiceSummary,
  fmtGBP,
  fmtDate,
  invoiceStatus,
} from '../components/InvoiceDetailDrawer';
import { useQBInvoices } from '../hooks/useQBInvoices';
import { reset as resetQBStore, broadcastDisconnect } from '../lib/qbInvoicesStore';

type _Icons = typeof RefreshIcon | typeof SearchIcon | typeof WarningAmberIcon;

// ── Pagination ────────────────────────────────────────────────────────────────

const PAGE_LIMIT = 25;
const PAGE_KEY   = 'mo_invoice_page';

function loadPage(): number {
  try {
    const raw = localStorage.getItem(PAGE_KEY);
    const n = raw ? parseInt(raw, 10) : 1;
    return Number.isFinite(n) && n >= 1 ? n : 1;
  } catch { return 1; }
}

function savePage(page: number) {
  try { localStorage.setItem(PAGE_KEY, String(page)); } catch { /* ignore */ }
}

// ── Status chip ───────────────────────────────────────────────────────────────

function StatusChip({ inv }: { inv: InvoiceSummary }) {
  const status = invoiceStatus(inv);
  const map: Record<string, { label: string; color: 'success' | 'error' | 'warning' | 'default' }> = {
    paid:    { label: 'Paid',        color: 'success' },
    overdue: { label: 'Overdue',     color: 'error' },
    partial: { label: 'Part paid',   color: 'warning' },
    open:    { label: 'Outstanding', color: 'default' },
  };
  const { label, color } = map[status];
  return <Chip label={label} color={color} size="small" sx={{ fontWeight: 600, fontSize: '0.72rem' }} />;
}

// ── Skeleton rows ─────────────────────────────────────────────────────────────

function SkeletonRows() {
  return (
    <Stack spacing={1}>
      {[48, 38, 52, 33, 44].map((w, i) => (
        <Box key={i} sx={{
          display: 'flex', alignItems: 'center', gap: 1.5,
          p: '12px 14px', borderRadius: 2,
          border: '1px solid', borderColor: 'divider',
        }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Skeleton width={`${w}%`} height={15} />
          </Box>
          <Skeleton width={62} height={13} />
          <Skeleton width={54} height={22} sx={{ borderRadius: 999 }} />
          <Skeleton width={58} height={15} />
        </Box>
      ))}
    </Stack>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function StandaloneInvoicesPage() {
  useConnectionCheck();
  const { isAdmin } = usePrivilege();

  const qb = useQBInvoices();
  const { connected, company, invoices, loading, loadError, error, errorCode, refresh: loadInvoices, triggerLoad } = qb;

  useEffect(() => { triggerLoad(); }, [triggerLoad]);

  useEffect(() => {
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel('mo_invoices');
      bc.onmessage = (e: MessageEvent) => {
        if (e.data?.type === 'invoice-saved') loadInvoices();
      };
    } catch { /* BroadcastChannel not available */ }
    return () => { bc?.close(); };
  }, [loadInvoices]);

  // True while the store hasn't resolved yet: covers both an in-progress fetch
  // and the brief initial render before the useEffect above fires triggerLoad().
  const isLoading = loading || (!qb.statusKnown && !qb.loaded && !loadError);

  const [filter, setFilter] = useState<'all' | 'overdue' | 'outstanding'>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState<number>(() => loadPage());

  const [panelOpen, setPanelOpen]   = useState(false);
  const [panelInvId, setPanelInvId] = useState<string | null>(null);

  // Restore panel from URL hash on initial load
  useEffect(() => {
    const hash = window.location.hash;
    if (hash.startsWith('#inv-')) {
      const id = hash.slice(5);
      if (id) { setPanelInvId(id); setPanelOpen(true); }
    }
  }, []);

  const handleDisconnect = useCallback(() => {
    window.showBottomConfirm('Disconnect QuickBooks? Invoice data will no longer be visible.', async () => {
      const res = await fetch('/auth/quickbooks/disconnect', { method: 'POST' }).catch(() => null);
      if (res?.ok) {
        broadcastDisconnect();
        resetQBStore();
      }
      loadInvoices();
    });
  }, [loadInvoices]);

  const openPanel = useCallback((id: string) => {
    setPanelInvId(id);
    setPanelOpen(true);
    window.location.hash = `inv-${id}`;
  }, []);

  const closePanel = useCallback(() => {
    setPanelOpen(false);
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);

  // Sort by status priority, then build filtered list
  const sorted = useMemo(() => [...invoices].sort((a, b) => {
    const order: Record<string, number> = { overdue: 0, open: 1, partial: 2, paid: 3 };
    return (order[invoiceStatus(a)] ?? 4) - (order[invoiceStatus(b)] ?? 4);
  }), [invoices]);

  const q = search.toLowerCase().trim();
  const visible = useMemo(() => {
    let list = sorted;
    if (filter === 'overdue')     list = list.filter(inv => invoiceStatus(inv) === 'overdue');
    if (filter === 'outstanding') list = list.filter(inv => ['overdue', 'open', 'partial'].includes(invoiceStatus(inv)));
    if (q) list = list.filter(inv =>
      (inv.customerName || '').toLowerCase().includes(q) ||
      (inv.docNumber    || '').toLowerCase().includes(q) ||
      (inv.email        || '').toLowerCase().includes(q),
    );
    return list;
  }, [sorted, filter, q]);

  // Reset to page 1 when filter/search changes
  useEffect(() => {
    setPage(1);
    savePage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, q]);

  const totalPages   = Math.max(1, Math.ceil(visible.length / PAGE_LIMIT));
  const safePage     = Math.min(page, totalPages);
  const pageStart    = (safePage - 1) * PAGE_LIMIT;
  const pageSlice    = visible.slice(pageStart, pageStart + PAGE_LIMIT);

  const handlePageChange = useCallback((p: number) => {
    setPage(p);
    savePage(p);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const totalBalance = visible.reduce((s, inv) => s + (inv.balance ?? 0), 0);
  const overdueCount = sorted.filter(inv => invoiceStatus(inv) === 'overdue').length;
  const openCount    = sorted.filter(inv => ['overdue', 'open', 'partial'].includes(invoiceStatus(inv))).length;
  const allVisibleIds = visible.map(inv => inv.id);

  // ── Not connected ─────────────────────────────────────────────────────────
  if (!isLoading && qb.statusKnown && !connected) {
    return (
      <Box sx={{ maxWidth: 480, mx: 'auto', py: 10, textAlign: 'center', px: 2 }}>
        <Box sx={{ mb: 2, opacity: 0.35 }}>
          <svg width="48" height="48" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5"
              d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z"/>
          </svg>
        </Box>
        <Typography variant="h6" sx={{ fontWeight: 700 }}>Connect QuickBooks</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 3 }}>
          See outstanding invoices matched to your customers.
        </Typography>
        {isAdmin && (
          <Button variant="contained" href="/auth/quickbooks"
            sx={{ bgcolor: '#2ca01c', '&:hover': { bgcolor: '#208015' } }/* hex-color-ok: pre-existing raw hex */}>
            Connect QuickBooks
          </Button>
        )}
      </Box>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  if (!isLoading && loadError) {
    const isDbError = errorCode === 'DB_ERROR';
    const msg = isDbError
      ? 'The database could not be reached. Check your connection and try again.'
      : error;
    return (
      <Box sx={{ maxWidth: 480, mx: 'auto', py: 10, textAlign: 'center', px: 2 }}>
        <Box sx={{ mb: 2, opacity: 0.35, color: 'error.main' }}>
          <WarningAmberIcon sx={{ fontSize: 48 }} />
        </Box>
        <Typography variant="h6" sx={{ fontWeight: 700, color: 'error.main' }}>
          Invoices couldn't be loaded
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 3 }}>{msg}</Typography>
        <Button variant="outlined" startIcon={<RefreshIcon />} onClick={loadInvoices}>
          Retry
        </Button>
      </Box>
    );
  }

  // ── Main list ─────────────────────────────────────────────────────────────
  return (
    <Box sx={{ maxWidth: 860, mx: 'auto', width: '100%', px: { xs: 2, sm: 3 }, py: 3 }}>
      {/* Page header */}
      <Box sx={{
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        mb: 2.5, gap: 1.5, flexWrap: 'wrap',
      }}>
        <Box>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>Outstanding Invoices</Typography>
          {isLoading ? (
            <Skeleton width={180} height={14} sx={{ mt: 0.5 }} />
          ) : (
            <Typography variant="caption" color="text.secondary">
              {company || 'QuickBooks'}
              {visible.length > 0 && (
                ` · ${visible.length} invoice${visible.length !== 1 ? 's' : ''} · ${fmtGBP(totalBalance)} total`
              )}
            </Typography>
          )}
        </Box>
        <Stack direction="row" spacing={1}>
          <Button size="small" variant="outlined" startIcon={<RefreshIcon />} onClick={loadInvoices} disabled={isLoading} color="inherit">
            Refresh
          </Button>
          {isAdmin && !isLoading && connected && (
            <Button
              size="small"
              variant="outlined"
              onClick={handleDisconnect}
              color="inherit"
              sx={{ '&:hover': { borderColor: 'error.main', color: 'error.main', bgcolor: '#fee2e2' } }} // hex-color-ok: pre-existing raw hex
            >
              Disconnect
            </Button>
          )}
        </Stack>
      </Box>

      {/* Overdue alert */}
      {!isLoading && overdueCount > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {overdueCount} overdue invoice{overdueCount !== 1 ? 's' : ''} — total outstanding: {fmtGBP(sorted.filter(inv => ['overdue','open','partial'].includes(invoiceStatus(inv))).reduce((s, inv) => s + (inv.balance ?? 0), 0))}
        </Alert>
      )}

      {/* Filter bar + search */}
      {(!isLoading || invoices.length > 0) && (
        <Box sx={{ display: 'flex', gap: 1.5, mb: 2, flexWrap: 'wrap', alignItems: 'center' }}>
          <Box sx={{ display: 'flex', p: 0.5, bgcolor: 'action.hover', borderRadius: 2, width: 'fit-content' }}>
            <ToggleButtonGroup
              value={filter}
              exclusive
              onChange={(_, v) => { if (v) setFilter(v as typeof filter); }}
              size="small"
            >
              <ToggleButton value="all" sx={{ px: 2, fontSize: '0.85rem', fontWeight: 600, border: 'none', borderRadius: '6px !important' }}>
                All ({sorted.length})
              </ToggleButton>
              <ToggleButton value="outstanding" sx={{ px: 2, fontSize: '0.85rem', fontWeight: 600, border: 'none', borderRadius: '6px !important' }}>
                Outstanding ({openCount})
              </ToggleButton>
              {overdueCount > 0 && (
                <ToggleButton value="overdue" sx={{ px: 2, fontSize: '0.85rem', fontWeight: 600, border: 'none', borderRadius: '6px !important' }}>
                  Overdue ({overdueCount})
                </ToggleButton>
              )}
            </ToggleButtonGroup>
          </Box>
          <TextField
            size="small"
            placeholder="Search invoices…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            slotProps={{
              input: {
                startAdornment: (
                  <Box component="span" sx={{ display: 'flex', alignItems: 'center', mr: 0.5, color: 'text.disabled' }}>
                    <SearchIcon sx={{ fontSize: 16 }} />
                  </Box>
                ),
              },
            }}
            sx={{ width: 220 }}
          />
        </Box>
      )}

      {/* Invoice list */}
      {isLoading ? (
        <SkeletonRows />
      ) : visible.length === 0 ? (
        <Box sx={{ py: 10, textAlign: 'center' }}>
          <Typography variant="body1" sx={{ fontWeight: 600 }} color="text.secondary">
            {q || filter !== 'all' ? 'No matching invoices' : 'All clear!'}
          </Typography>
          <Typography variant="body2" color="text.disabled" sx={{ mt: 0.5 }}>
            {q ? 'Try a different search term.' : filter !== 'all' ? 'No invoices match this filter.' : 'No outstanding invoices found.'}
          </Typography>
        </Box>
      ) : (
        <>
          <Stack spacing={0.75}>
            {pageSlice.map(inv => {
              const stat = invoiceStatus(inv);
              return (
                <Box
                  key={inv.id}
                  onClick={() => openPanel(inv.id)}
                  sx={{
                    display: 'flex', alignItems: 'center', gap: 1.5,
                    px: 1.75, py: 1.5,
                    borderRadius: 2, border: '1px solid', borderColor: 'divider',
                    bgcolor: 'background.paper',
                    cursor: 'pointer',
                    transition: 'background-color 0.15s',
                    '&:hover': { bgcolor: 'action.hover' },
                  }}
                >
                  {/* Customer name */}
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>{inv.customerName || '—'}</Typography>
                  </Box>
                  {/* Invoice number + due date */}
                  <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', flexShrink: 0 }}>
                    <Typography variant="caption" color="text.secondary">Inv #{inv.docNumber || inv.id}</Typography>
                    {inv.dueDate && (
                      <Typography variant="caption" sx={{ color: stat === 'overdue' ? 'error.main' : 'text.secondary' }}>
                        Due {fmtDate(inv.dueDate)}
                      </Typography>
                    )}
                  </Box>
                  {/* Status chip */}
                  <StatusChip inv={inv} />
                  {/* Balance */}
                  <Typography variant="body2" sx={{ fontWeight: 700, minWidth: 80, textAlign: 'right', flexShrink: 0 }}>
                    {fmtGBP(inv.balance)}
                  </Typography>
                  {/* Chevron */}
                  <Box component="span" sx={{ color: 'text.disabled', flexShrink: 0, display: 'flex', alignItems: 'center' }}>
                    <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7"/>
                    </svg>
                  </Box>
                </Box>
              );
            })}
          </Stack>
          <Box sx={{ mt: 2 }}>
            <ContactsPagination
              page={safePage}
              totalPages={totalPages}
              total={visible.length}
              visibleCount={pageSlice.length}
              pageLimit={PAGE_LIMIT}
              onPageChange={handlePageChange}
            />
          </Box>
        </>
      )}

      {/* Invoice detail drawer */}
      <InvoiceDetailDrawer
        open={panelOpen}
        invId={panelInvId}
        allIds={allVisibleIds}
        onClose={closePanel}
        onNavigate={id => { setPanelInvId(id); window.location.hash = `inv-${id}`; }}
        isAdmin={isAdmin}
        onSaved={loadInvoices}
      />
    </Box>
  );
}
