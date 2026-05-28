import React, { useState, useEffect } from 'react';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import type { CardActionHandlerData } from '../../hooks/useCardActionHandlers';
import type { CardActionContext } from '../../utils/dispatchCardActionHandler';

interface Props {
  handler: CardActionHandlerData;
  ctx: CardActionContext;
  open: boolean;
  onClose: () => void;
}

interface Submission {
  submitted_at: string | null;
  expires_at: string | null;
}

function hasPendingSubmission(rows: Submission[]): boolean {
  const now = Date.now();
  return rows.some(
    r => r.submitted_at === null && r.expires_at !== null && new Date(r.expires_at).getTime() > now
  );
}

export function UploadPhotosModal({ handler: _handler, ctx, open, onClose }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [checkingPending, setCheckingPending] = useState(false);
  const [hasPending, setHasPending] = useState(false);

  useEffect(() => {
    if (!open) return;

    const controller = new AbortController();

    setCheckingPending(true);
    setHasPending(false);

    fetch(`/api/customer-info/by-contact/${encodeURIComponent(ctx.contactId)}`, {
      signal: controller.signal,
    })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Submission[]>;
      })
      .then(rows => {
        setHasPending(hasPendingSubmission(rows));
      })
      .catch(e => {
        if ((e as Error).name === 'AbortError') return;
        setHasPending(false);
      })
      .finally(() => {
        if (!controller.signal.aborted) setCheckingPending(false);
      });

    return () => {
      controller.abort();
      setCheckingPending(false);
    };
  }, [open, ctx.contactId]);

  async function handleSend() {
    setError('');
    setSubmitting(true);
    try {
      const r = await fetch('/api/card-actions/upload-photos-and-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId: ctx.contactId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || d.message || 'Failed to send');
      setSent(true);
      const w = window as unknown as { showToast?: (m: string, e: boolean) => void };
      w.showToast?.('Email sent to customer', false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResend() {
    setError('');
    setSubmitting(true);
    try {
      const r = await fetch(
        `/api/customer-info/by-contact/${encodeURIComponent(ctx.contactId)}/resend`,
        { method: 'POST' }
      );
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((d as { error?: string }).error || `HTTP ${r.status}`);
      setSent(true);
      const w = window as unknown as { showToast?: (m: string, e: boolean) => void };
      w.showToast?.('Link resent to customer', false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function handleClose() {
    setSent(false);
    setError('');
    setHasPending(false);
    onClose();
  }

  const customerLabel = ctx.contactEmail
    ? `${ctx.contactName || 'the customer'} (${ctx.contactEmail})`
    : (ctx.contactName || 'the customer');

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="xs" fullWidth>
      <DialogTitle>
        {hasPending ? 'Resend photo upload link' : 'Send photo upload link'}
      </DialogTitle>
      <DialogContent>
        {checkingPending ? (
          <Stack sx={{ alignItems: 'center', py: 2 }}>
            <CircularProgress size={28} />
          </Stack>
        ) : sent ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {hasPending
              ? <>A fresh link has been sent to <strong>{customerLabel}</strong>. The previous link is now invalid.</>
              : <>The email has been sent to <strong>{ctx.contactEmail || ctx.contactName || 'the customer'}</strong>. They'll receive a link to fill in their details and upload photos of their space.</>
            }
          </Typography>
        ) : hasPending ? (
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              A photo upload link has already been sent to{' '}
              <strong>{customerLabel}</strong>{' '}
              and hasn't been filled in yet. This will send them a fresh link.
            </Typography>
            {error && (
              <Typography variant="caption" color="error">{error}</Typography>
            )}
          </Stack>
        ) : (
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              This will send an email to{' '}
              <strong>{ctx.contactName || 'the customer'}</strong>
              {ctx.contactEmail ? (
                <> ({ctx.contactEmail})</>
              ) : null}
              {' '}with a secure link to a form where they can:
            </Typography>
            <Stack component="ul" spacing={0.5} sx={{ m: 0, pl: 2.5 }}>
              {['Confirm or correct their contact details and address', 'Tell us how many rooms they need done', 'Upload photos of the spaces', 'Share measurements, style preferences, and notes'].map(item => (
                <Typography key={item} component="li" variant="body2" sx={{ color: 'text.secondary' }}>
                  {item}
                </Typography>
              ))}
            </Stack>
            {error && (
              <Typography variant="caption" color="error">{error}</Typography>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        {sent ? (
          <Button variant="contained" onClick={handleClose}>Done</Button>
        ) : (
          <>
            <Button onClick={handleClose} disabled={submitting || checkingPending}>Cancel</Button>
            <Button
              variant="contained"
              onClick={hasPending ? handleResend : handleSend}
              disabled={submitting || checkingPending}
              startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : undefined}
              data-testid="cah-primary"
            >
              {submitting
                ? (hasPending ? 'Resending…' : 'Sending…')
                : (hasPending ? 'Resend link' : 'Send email')
              }
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}
