import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Drawer,
  IconButton,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableRow,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import CloseIcon from '@mui/icons-material/Close';
import DownloadIcon from '@mui/icons-material/Download';
import EmailIcon from '@mui/icons-material/Email';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { usePrivilege } from '../hooks/usePrivilege';

type _Icons = typeof ArrowBackIcon | typeof ArrowForwardIcon | typeof CloseIcon |
  typeof DownloadIcon | typeof EmailIcon | typeof RefreshIcon |
  typeof SearchIcon | typeof WarningAmberIcon;

// ── API types (camelCase from server) ─────────────────────────────────────────

interface InvoiceSummary {
  id: string;
  docNumber: string;
  customerName: string;
  email: string | null;
  balance: number;
  totalAmt: number;
  dueDate: string | null;
  txnDate: string | null;
}

interface InvoiceLine {
  description?: string;
  qty?: number | null;
  unitPrice?: number | null;
  amount?: number;
  detailType?: string;
}

interface InvoiceDetail extends InvoiceSummary {
  email: string | null;
  syncToken: string;
  memo: string | null;
  lines: InvoiceLine[];
}

interface QBStatus {
  connected: boolean;
  company?: string;
}

// ── Draft persistence (localStorage) ──────────────────────────────────────────

const DRAFT_KEY = 'mo_invoice_draft';

interface InvoiceDraft {
  due: string;
  email: string;
  memo: string;
}

function loadDraft(invId: string): InvoiceDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, InvoiceDraft>;
    return map[invId] ?? null;
  } catch {
    return null;
  }
}

function saveDraft(invId: string, draft: InvoiceDraft) {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    const map: Record<string, InvoiceDraft> = raw ? JSON.parse(raw) : {};
    map[invId] = draft;
    localStorage.setItem(DRAFT_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

function clearDraft(invId: string) {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return;
    const map: Record<string, InvoiceDraft> = JSON.parse(raw);
    delete map[invId];
    localStorage.setItem(DRAFT_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

// ── Formatting helpers ─────────────────────────────────────────────────────────

function fmtGBP(amount?: number | null): string {
  if (amount == null) return '—';
  return '£' + Number(amount).toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  const date = new Date(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10));
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function invoiceStatus(inv: InvoiceSummary): 'paid' | 'overdue' | 'partial' | 'open' {
  const balance = Number(inv.balance ?? 0);
  const total   = Number(inv.totalAmt ?? 0);
  if (balance <= 0) return 'paid';
  if (balance < total) return 'partial';
  if (inv.dueDate && new Date(inv.dueDate) < new Date()) return 'overdue';
  return 'open';
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

// ── Invoice Detail Drawer ─────────────────────────────────────────────────────

interface DrawerProps {
  open: boolean;
  invId: string | null;
  allIds: string[];
  onClose: () => void;
  onNavigate: (id: string) => void;
  isAdmin: boolean;
}

interface EditState {
  due: string;
  email: string;
  memo: string;
  dirty: boolean;
}

function InvoiceDrawer({ open, invId, allIds, onClose, onNavigate, isAdmin }: DrawerProps) {
  const [inv, setInv]         = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [edit, setEdit]       = useState<EditState>({ due: '', email: '', memo: '', dirty: false });
  const [saveMsg, setSaveMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [sending, setSending] = useState(false);
  const [saving, setSaving]   = useState(false);
  const beforeUnloadRef = useRef<((e: BeforeUnloadEvent) => void) | null>(null);

  const currentIdx = allIds.indexOf(invId ?? '');
  const hasPrev    = currentIdx > 0;
  const hasNext    = currentIdx < allIds.length - 1;

  // Guard against accidental navigation when dirty
  useEffect(() => {
    if (edit.dirty) {
      const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
      window.addEventListener('beforeunload', handler);
      beforeUnloadRef.current = handler;
      return () => window.removeEventListener('beforeunload', handler);
    } else {
      if (beforeUnloadRef.current) {
        window.removeEventListener('beforeunload', beforeUnloadRef.current);
        beforeUnloadRef.current = null;
      }
    }
  }, [edit.dirty]);

  useEffect(() => {
    if (!open || !invId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setInv(null);
    setSaveMsg(null);

    fetch(`/api/quickbooks/invoice/${invId}`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        if (data.error) throw new Error(data.error);
        setInv(data);
        const draft = loadDraft(invId);
        setEdit({
          due:   draft?.due   ?? data.dueDate ?? '',
          email: draft?.email ?? data.email   ?? '',
          memo:  draft?.memo  ?? data.memo    ?? '',
          dirty: !!draft,
        });
        if (draft) setSaveMsg({ text: 'Unsaved changes restored', ok: true });
      })
      .catch(e => { if (!cancelled) setError((e as Error).message || 'Failed to load invoice'); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [open, invId]);

  // Auto-save draft whenever edit changes (and dirty)
  useEffect(() => {
    if (!invId || !edit.dirty) return;
    saveDraft(invId, { due: edit.due, email: edit.email, memo: edit.memo });
  }, [invId, edit]);

  const handleClose = useCallback(() => {
    if (edit.dirty) {
      if (!window.confirm('You have unsaved changes. Discard and close?')) return;
    }
    onClose();
    setEdit({ due: '', email: '', memo: '', dirty: false });
    setInv(null);
    setSaveMsg(null);
  }, [edit.dirty, onClose]);

  const handleNavigate = useCallback((delta: number) => {
    if (edit.dirty) {
      if (!window.confirm('You have unsaved changes. Discard and continue?')) return;
    }
    const newIdx = currentIdx + delta;
    if (newIdx < 0 || newIdx >= allIds.length) return;
    setEdit({ due: '', email: '', memo: '', dirty: false });
    onNavigate(allIds[newIdx]);
  }, [edit.dirty, currentIdx, allIds, onNavigate]);

  const handleSave = useCallback(async () => {
    if (!inv || saving) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const r = await fetch(`/api/quickbooks/invoice/${inv.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          syncToken: inv.syncToken,
          dueDate:   edit.due   || null,
          memo:      edit.memo  || null,
          email:     edit.email || null,
        }),
      }).then(res => res.json());
      if (r.error) throw new Error(r.error);
      setInv(prev => prev ? {
        ...prev,
        syncToken: r.syncToken,
        dueDate:   edit.due   || null,
        memo:      edit.memo  || null,
        email:     edit.email || null,
      } : prev);
      setEdit(prev => ({ ...prev, dirty: false }));
      clearDraft(inv.id);
      setSaveMsg({ text: 'Saved', ok: true });
    } catch (e: unknown) {
      setSaveMsg({ text: (e as Error).message || 'Save failed', ok: false });
    } finally {
      setSaving(false);
    }
  }, [inv, saving, edit]);

  const handleSend = useCallback(async () => {
    if (!inv || sending) return;
    setSending(true);
    setSaveMsg(null);
    try {
      const r = await fetch(`/api/quickbooks/invoice/${inv.id}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: edit.email || null }),
      }).then(res => res.json());
      if (r.error) throw new Error(r.error);
      setSaveMsg({ text: `Sent to ${edit.email || inv.email}`, ok: true });
    } catch (e: unknown) {
      setSaveMsg({ text: (e as Error).message || 'Send failed', ok: false });
    } finally {
      setSending(false);
    }
  }, [inv, sending, edit.email]);

  const handleDiscard = useCallback(() => {
    if (!inv) return;
    clearDraft(inv.id);
    setEdit({ due: inv.dueDate ?? '', email: inv.email ?? '', memo: inv.memo ?? '', dirty: false });
    setSaveMsg({ text: 'Changes discarded', ok: true });
  }, [inv]);

  const baseline = inv ? { due: inv.dueDate ?? '', email: inv.email ?? '', memo: inv.memo ?? '' } : null;
  const isDueChanged   = !!baseline && edit.due   !== baseline.due;
  const isEmailChanged = !!baseline && edit.email !== baseline.email;
  const isMemoChanged  = !!baseline && edit.memo  !== baseline.memo;

  const fieldDirtyStyle = (isDirty: boolean): Record<string, unknown> => isDirty ? {
    '& .MuiOutlinedInput-root': { borderColor: 'primary.main', boxShadow: 'inset 2px 0 0 currentColor' },
  } : {
    '& .MuiOutlinedInput-root': {},
  };

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={handleClose}
      slotProps={{ paper: { sx: { width: { xs: '100vw', sm: 520 }, display: 'flex', flexDirection: 'column' } } }}
    >
      {/* Header */}
      <Box sx={{
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        px: 3, pt: 2.5, pb: 2, borderBottom: '1px solid', borderColor: 'divider', flexShrink: 0,
      }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          {allIds.length > 1 ? (
            <>
              <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                <Tooltip title="Previous invoice">
                  <span>
                    <IconButton size="small" onClick={() => handleNavigate(-1)} disabled={!hasPrev}>
                      <ArrowBackIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
                <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                  Invoice {currentIdx + 1} of {allIds.length}
                </Typography>
                <Tooltip title="Next invoice">
                  <span>
                    <IconButton size="small" onClick={() => handleNavigate(1)} disabled={!hasNext}>
                      <ArrowForwardIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              </Stack>
              {inv && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  #{inv.docNumber || inv.id}
                </Typography>
              )}
            </>
          ) : (
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
              {inv ? `Invoice #${inv.docNumber || inv.id}` : 'Invoice'}
            </Typography>
          )}
          {inv && (
            <Typography variant="caption" color="text.secondary">{inv.customerName}</Typography>
          )}
        </Box>
        <IconButton onClick={handleClose} size="small" sx={{ ml: 1, mt: 0.5 }}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      {/* Body */}
      <Box sx={{ flex: 1, overflowY: 'auto', pb: 5 }}>
        {loading && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, p: 3, color: 'text.secondary' }}>
            <CircularProgress size={18} />
            <Typography variant="body2">Loading…</Typography>
          </Box>
        )}
        {error && (
          <Typography sx={{ p: 3, color: 'error.main', fontSize: '0.875rem' }}>
            Failed to load invoice: {error}
          </Typography>
        )}
        {inv && !loading && (
          <>
            {/* Meta grid */}
            <Box sx={{ px: 3, py: 2.5, borderBottom: '1px solid', borderColor: 'divider' }}>
              <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5 }}>
                {([
                  { label: 'Invoice date', value: fmtDate(inv.txnDate) },
                  { label: 'Balance due',  value: fmtGBP(inv.balance), big: true },
                  { label: 'Due date',     value: fmtDate(inv.dueDate), err: invoiceStatus(inv) === 'overdue' },
                  { label: 'Total',        value: fmtGBP(inv.totalAmt) },
                ] as Array<{ label: string; value: string; big?: boolean; err?: boolean }>).map(item => (
                  <Box key={item.label}>
                    <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 }}>
                      {item.label}
                    </Typography>
                    <Typography
                      variant={item.big ? 'body1' : 'body2'}
                      sx={{ fontWeight: item.big ? 800 : 600, color: item.err ? 'error.main' : 'text.primary' }}
                    >
                      {item.value}
                    </Typography>
                  </Box>
                ))}
              </Box>
            </Box>

            {/* Line items */}
            <Box sx={{ px: 3, py: 2.5, borderBottom: '1px solid', borderColor: 'divider' }}>
              <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700, mb: 1.5, display: 'block' }}>
                Line items
              </Typography>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    {['Description', 'Qty', 'Unit price', 'Amount'].map((h, i) => (
                      <TableCell key={h} align={i > 0 ? 'right' : 'left'} sx={{ fontWeight: 700, fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'text.secondary', ...(i === 0 ? { pl: 0, width: '55%' } : {}), ...(i === 3 ? { pr: 0 } : {}) }}>
                        {h}
                      </TableCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {inv.lines
                    .filter(l => l.detailType !== 'SubTotalLineDetail')
                    .map((l, i) => (
                      <TableRow key={i}>
                        <TableCell sx={{ fontSize: '0.8rem', color: 'text.secondary', pl: 0 }}>{l.description || '—'}</TableCell>
                        <TableCell align="right" sx={{ fontSize: '0.8rem', color: 'text.secondary' }}>{l.qty ?? ''}</TableCell>
                        <TableCell align="right" sx={{ fontSize: '0.8rem', color: 'text.secondary' }}>{l.unitPrice != null ? fmtGBP(l.unitPrice) : ''}</TableCell>
                        <TableCell align="right" sx={{ fontSize: '0.8rem', fontWeight: 700, color: 'text.primary', pr: 0 }}>{fmtGBP(l.amount)}</TableCell>
                      </TableRow>
                    ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={3} sx={{ fontWeight: 600, fontSize: '0.8rem', pl: 0, borderTop: '2px solid', borderColor: 'divider' }}>Total</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.8rem', pr: 0, borderTop: '2px solid', borderColor: 'divider' }}>{fmtGBP(inv.totalAmt)}</TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </Box>

            {/* Edit section (admin only) */}
            {isAdmin && (
              <Box sx={{ px: 3, py: 2.5, borderBottom: '1px solid', borderColor: 'divider' }}>
                <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700, mb: 1.5, display: 'block' }}>
                  Edit invoice
                </Typography>
                <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5, mb: 1.5 }}>
                  <TextField
                    label="Due date"
                    type="date"
                    size="small"
                    value={edit.due}
                    onChange={e => setEdit(prev => ({ ...prev, due: e.target.value, dirty: true }))}
                    slotProps={{ inputLabel: { shrink: true } }}
                    sx={fieldDirtyStyle(isDueChanged)}
                  />
                  <TextField
                    label="Customer email"
                    type="email"
                    size="small"
                    value={edit.email}
                    onChange={e => setEdit(prev => ({ ...prev, email: e.target.value, dirty: true }))}
                    placeholder="customer@example.com"
                    sx={fieldDirtyStyle(isEmailChanged)}
                  />
                  <TextField
                    label="Message on invoice"
                    multiline
                    rows={2}
                    size="small"
                    value={edit.memo}
                    onChange={e => setEdit(prev => ({ ...prev, memo: e.target.value, dirty: true }))}
                    placeholder="Thank you for your business"
                    sx={{ gridColumn: '1 / -1', ...fieldDirtyStyle(isMemoChanged) }}
                  />
                </Box>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <Button variant="contained" size="small" onClick={handleSave} disabled={saving}>
                    {saving ? 'Saving…' : 'Save changes'}
                  </Button>
                  {edit.dirty && (
                    <Button variant="outlined" size="small" onClick={handleDiscard} color="inherit">
                      Discard
                    </Button>
                  )}
                  {saveMsg && (
                    <Typography variant="caption" sx={{ color: saveMsg.ok ? 'success.main' : 'error.main' }}>
                      {saveMsg.text}
                    </Typography>
                  )}
                </Stack>
              </Box>
            )}

            {/* Actions */}
            <Box sx={{ px: 3, py: 2.5 }}>
              <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700, mb: 1.5, display: 'block' }}>
                Actions
              </Typography>
              <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<DownloadIcon />}
                  component="a"
                  href={`/api/quickbooks/invoice/${inv.id}/pdf`}
                  target="_blank"
                  download={`invoice-${inv.docNumber || inv.id}.pdf`}
                  color="inherit"
                >
                  Download PDF
                </Button>
                {isAdmin && (
                  <Button
                    variant="outlined"
                    size="small"
                    startIcon={<EmailIcon />}
                    onClick={handleSend}
                    disabled={sending}
                    color="inherit"
                  >
                    {sending ? 'Sending…' : 'Send to customer'}
                  </Button>
                )}
              </Stack>
              {saveMsg && !isAdmin && (
                <Typography variant="caption" sx={{ color: saveMsg.ok ? 'success.main' : 'error.main', mt: 1, display: 'block' }}>
                  {saveMsg.text}
                </Typography>
              )}
            </Box>
          </>
        )}
      </Box>
    </Drawer>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function StandaloneInvoicesPage() {
  const { isAdmin } = usePrivilege();

  const [status, setStatus]       = useState<QBStatus | null>(null);
  const [invoices, setInvoices]   = useState<InvoiceSummary[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const [filter, setFilter] = useState<'all' | 'overdue' | 'outstanding'>('all');
  const [search, setSearch] = useState('');

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

  const loadStatus = useCallback(async (): Promise<QBStatus> => {
    try {
      const res  = await fetch('/api/quickbooks/status');
      const data = await res.json().catch(() => ({ connected: false })) as QBStatus;
      setStatus(data);
      return data;
    } catch {
      const fallback: QBStatus = { connected: false };
      setStatus(fallback);
      return fallback;
    }
  }, []);

  const loadInvoices = useCallback(async () => {
    setLoading(true);
    setError(null);
    setErrorCode(null);
    try {
      const st = await loadStatus();
      if (!st.connected) { setLoading(false); return; }
      const res  = await fetch('/api/quickbooks/invoices');
      const data = await res.json().catch(() => ({})) as { invoices?: InvoiceSummary[]; error?: string; code?: string };
      if (!res.ok || data.error) {
        setError(data.error || `Server error ${res.status}`);
        setErrorCode(data.code || null);
        return;
      }
      setInvoices(data.invoices || []);
    } catch (e: unknown) {
      setError((e as Error).message || 'Failed to load invoices');
    } finally {
      setLoading(false);
    }
  }, [loadStatus]);

  useEffect(() => { loadInvoices(); }, [loadInvoices]);

  const handleDisconnect = useCallback(async () => {
    if (!window.confirm('Disconnect QuickBooks? Invoice data will no longer be visible.')) return;
    await fetch('/auth/quickbooks/disconnect', { method: 'POST' }).catch(() => {});
    setStatus({ connected: false });
    setInvoices([]);
  }, []);

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
  const sorted = [...invoices].sort((a, b) => {
    const order: Record<string, number> = { overdue: 0, open: 1, partial: 2, paid: 3 };
    return (order[invoiceStatus(a)] ?? 4) - (order[invoiceStatus(b)] ?? 4);
  });

  const q = search.toLowerCase().trim();
  let visible = sorted;
  if (filter === 'overdue')     visible = visible.filter(inv => invoiceStatus(inv) === 'overdue');
  if (filter === 'outstanding') visible = visible.filter(inv => ['overdue', 'open', 'partial'].includes(invoiceStatus(inv)));
  if (q) visible = visible.filter(inv =>
    (inv.customerName || '').toLowerCase().includes(q) ||
    (inv.docNumber    || '').toLowerCase().includes(q) ||
    (inv.email        || '').toLowerCase().includes(q),
  );

  const totalBalance = visible.reduce((s, inv) => s + (inv.balance ?? 0), 0);
  const overdueCount = sorted.filter(inv => invoiceStatus(inv) === 'overdue').length;
  const openCount    = sorted.filter(inv => ['overdue', 'open', 'partial'].includes(invoiceStatus(inv))).length;
  const allVisibleIds = visible.map(inv => inv.id);

  // ── Not connected ─────────────────────────────────────────────────────────
  if (!loading && status && !status.connected) {
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
            sx={{ bgcolor: '#2ca01c', '&:hover': { bgcolor: '#208015' } }}>
            Connect QuickBooks
          </Button>
        )}
      </Box>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  if (!loading && error) {
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
          {loading ? (
            <Skeleton width={180} height={14} sx={{ mt: 0.5 }} />
          ) : (
            <Typography variant="caption" color="text.secondary">
              {status?.company || 'QuickBooks'}
              {visible.length > 0 && (
                ` · ${visible.length} invoice${visible.length !== 1 ? 's' : ''} · ${fmtGBP(totalBalance)} total`
              )}
            </Typography>
          )}
        </Box>
        <Stack direction="row" spacing={1}>
          <Button size="small" variant="outlined" startIcon={<RefreshIcon />} onClick={loadInvoices} disabled={loading} color="inherit">
            Refresh
          </Button>
          {isAdmin && !loading && status?.connected && (
            <Button
              size="small"
              variant="outlined"
              onClick={handleDisconnect}
              color="inherit"
              sx={{ '&:hover': { borderColor: 'error.main', color: 'error.main', bgcolor: '#fee2e2' } }}
            >
              Disconnect
            </Button>
          )}
        </Stack>
      </Box>

      {/* Overdue alert */}
      {!loading && overdueCount > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {overdueCount} overdue invoice{overdueCount !== 1 ? 's' : ''} — total outstanding: {fmtGBP(sorted.filter(inv => ['overdue','open','partial'].includes(invoiceStatus(inv))).reduce((s, inv) => s + (inv.balance ?? 0), 0))}
        </Alert>
      )}

      {/* Filter bar + search */}
      {(!loading || invoices.length > 0) && (
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
      {loading ? (
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
        <Stack spacing={0.75}>
          {visible.map(inv => {
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
      )}

      {/* Invoice detail drawer */}
      <InvoiceDrawer
        open={panelOpen}
        invId={panelInvId}
        allIds={allVisibleIds}
        onClose={closePanel}
        onNavigate={id => { setPanelInvId(id); window.location.hash = `inv-${id}`; }}
        isAdmin={isAdmin}
      />
    </Box>
  );
}
