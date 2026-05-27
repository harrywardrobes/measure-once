import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useConnectionToast } from '../context/ConnectionToastContext';
import { fmtGBP as _fmtGBP, fmtQBDate as _fmtQBDate } from '../utils/formatters';
import {
  Box,
  Button,
  CircularProgress,
  Drawer,
  IconButton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import CloseIcon from '@mui/icons-material/Close';
import DownloadIcon from '@mui/icons-material/Download';
import EmailIcon from '@mui/icons-material/Email';

type _Icons = typeof ArrowBackIcon | typeof ArrowForwardIcon | typeof CloseIcon |
  typeof DownloadIcon | typeof EmailIcon;

// ── API types (camelCase from server) ─────────────────────────────────────────

export interface InvoiceSummary {
  id: string;
  docNumber: string;
  customerName: string;
  email: string | null;
  balance: number;
  totalAmt: number;
  dueDate: string | null;
  txnDate: string | null;
}

export interface InvoiceLine {
  description?: string;
  qty?: number | null;
  unitPrice?: number | null;
  amount?: number;
  detailType?: string;
}

export interface InvoiceDetail extends InvoiceSummary {
  email: string | null;
  syncToken: string;
  memo: string | null;
  lines: InvoiceLine[];
}

// ── Draft persistence (localStorage) ──────────────────────────────────────────

const DRAFT_KEY = 'mo_invoice_draft';

interface InvoiceDraft {
  due: string;
  email: string;
  memo: string;
}

export function loadDraft(invId: string): InvoiceDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, InvoiceDraft>;
    return map[invId] ?? null;
  } catch {
    return null;
  }
}

export function saveDraft(invId: string, draft: InvoiceDraft) {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    const map: Record<string, InvoiceDraft> = raw ? JSON.parse(raw) : {};
    map[invId] = draft;
    localStorage.setItem(DRAFT_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

export function clearDraft(invId: string) {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return;
    const map: Record<string, InvoiceDraft> = JSON.parse(raw);
    delete map[invId];
    localStorage.setItem(DRAFT_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

// ── Formatting helpers (re-exported from shared utils) ─────────────────────────

export function fmtGBP(amount?: number | string | null): string {
  return _fmtGBP(amount);
}

export function fmtDate(iso?: string | null): string {
  return _fmtQBDate(iso) || '—';
}

export function invoiceStatus(inv: Pick<InvoiceSummary, 'balance' | 'totalAmt' | 'dueDate'>): 'paid' | 'overdue' | 'partial' | 'open' {
  const balance = Number(inv.balance ?? 0);
  const total   = Number(inv.totalAmt ?? 0);
  if (balance <= 0) return 'paid';
  if (balance < total) return 'partial';
  if (inv.dueDate && new Date(inv.dueDate) < new Date()) return 'overdue';
  return 'open';
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface InvoiceDetailDrawerProps {
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

export function InvoiceDetailDrawer({
  open, invId, allIds, onClose, onNavigate, isAdmin,
}: InvoiceDetailDrawerProps) {
  const { notifyApiError } = useConnectionToast();
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

  useEffect(() => {
    if (!invId || !edit.dirty) return;
    saveDraft(invId, { due: edit.due, email: edit.email, memo: edit.memo });
  }, [invId, edit]);

  const handleClose = useCallback(() => {
    const doClose = () => {
      onClose();
      setEdit({ due: '', email: '', memo: '', dirty: false });
      setInv(null);
      setSaveMsg(null);
    };
    if (edit.dirty) {
      window.showBottomConfirm('You have unsaved changes. Discard and close?', doClose);
      return;
    }
    doClose();
  }, [edit.dirty, onClose]);

  const handleNavigate = useCallback((delta: number) => {
    const newIdx = currentIdx + delta;
    if (newIdx < 0 || newIdx >= allIds.length) return;
    const doNavigate = () => {
      setEdit({ due: '', email: '', memo: '', dirty: false });
      onNavigate(allIds[newIdx]);
    };
    if (edit.dirty) {
      window.showBottomConfirm('You have unsaved changes. Discard and continue?', doNavigate);
      return;
    }
    doNavigate();
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
      notifyApiError('quickbooks', e);
      setSaveMsg({ text: (e as Error).message || 'Save failed', ok: false });
    } finally {
      setSaving(false);
    }
  }, [inv, saving, edit, notifyApiError]);

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
      notifyApiError('quickbooks', e);
      setSaveMsg({ text: (e as Error).message || 'Send failed', ok: false });
    } finally {
      setSending(false);
    }
  }, [inv, sending, edit.email, notifyApiError]);

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
  } : {};

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={handleClose}
      data-testid="invoice-detail-drawer"
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
        <IconButton onClick={handleClose} size="small" sx={{ ml: 1, mt: 0.5 }} aria-label="Close">
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
