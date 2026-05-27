import React, { useState } from 'react';
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

export function UploadPhotosModal({ handler: _handler, ctx, open, onClose }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

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

  function handleClose() {
    setSent(false);
    setError('');
    onClose();
  }

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="xs" fullWidth>
      <DialogTitle>
        Send photo upload link
      </DialogTitle>
      <DialogContent>
        {sent ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            The email has been sent to <strong>{ctx.contactEmail || ctx.contactName || 'the customer'}</strong>. They'll receive a link to fill in their details and upload photos of their space.
          </Typography>
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
            <Button onClick={handleClose} disabled={submitting}>Cancel</Button>
            <Button
              variant="contained"
              onClick={handleSend}
              disabled={submitting}
              startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : undefined}
              data-testid="cah-primary"
            >
              {submitting ? 'Sending…' : 'Send email'}
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}
