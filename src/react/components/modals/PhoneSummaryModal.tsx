import React, { useState } from 'react';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { CardActionHandlerData } from '../../hooks/useCardActionHandlers';
import type { CardActionContext } from '../../utils/dispatchCardActionHandler';
import { POST } from '../../utils/api';

interface FollowUpProps {
  handler: CardActionHandlerData;
  ctx: CardActionContext;
  summary: string;
  open: boolean;
  onClose: () => void;
}

function FollowUpEmailModal({ handler, ctx, summary, open, onClose }: FollowUpProps) {
  const cfg = handler.config || {};
  const subject = (cfg.draftEmailSubject as string) || 'Following up on our call';

  function handleDraft() {
    onClose();
    const firstName = ctx.contactName ? ctx.contactName.split(' ')[0] : '';
    const body = `Hi${firstName ? ' ' + firstName : ''},\n\nThanks for the call. To recap:\n\n${summary}\n\nBest,\n`;
    const w = window as unknown as { openEmailCompose?: () => void };
    if (typeof w.openEmailCompose === 'function') {
      try { w.openEmailCompose(); } catch { /* ignore */ }
      setTimeout(() => {
        const subjEl = document.getElementById('gmail-subject') as HTMLInputElement | null;
        const bodyEl = document.getElementById('gmail-body') as HTMLTextAreaElement | null;
        const toEl   = document.getElementById('gmail-to')   as HTMLInputElement | null;
        if (subjEl && !subjEl.value) subjEl.value = subject;
        if (bodyEl && !bodyEl.value) bodyEl.value = body;
        if (toEl   && !toEl.value && ctx.contactEmail) toEl.value = ctx.contactEmail;
      }, 50);
    } else {
      const mailto = `mailto:${encodeURIComponent(ctx.contactEmail || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      window.location.href = mailto;
    }
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Draft a follow-up email?</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          We can open your email composer pre-filled with this call summary.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Not now</Button>
        <Button variant="contained" onClick={handleDraft}>Draft email</Button>
      </DialogActions>
    </Dialog>
  );
}

interface Props {
  handler: CardActionHandlerData;
  ctx: CardActionContext;
  open: boolean;
  onClose: () => void;
}

export function PhoneSummaryModal({ handler, ctx, open, onClose }: Props) {
  const cfg = handler.config || {};
  const [summary, setSummary] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showFollowUp, setShowFollowUp] = useState(false);
  const [savedSummary, setSavedSummary] = useState('');

  function handleClose() {
    setSummary('');
    setError('');
    onClose();
  }

  async function handleSubmit() {
    setError('');
    if (!summary.trim()) { setError('Please type a summary first.'); return; }

    setSubmitting(true);
    try {
      await POST('/api/card-actions/phone-call-summary', {
        contactId: ctx.contactId,
        summary: summary.trim(),
        notePrefix: (cfg.notePrefix as string) || '',
      });
      const w = window as unknown as { showToast?: (m: string, e: boolean) => void };
      w.showToast?.('Note saved to HubSpot', false);
      setSavedSummary(summary.trim());
      setSummary('');
      handleClose();
      setShowFollowUp(true);
    } catch (e) {
      const err = e instanceof Error ? e : new Error('error');
      if ((err as { code?: string }).code === 'HUBSPOT_AUTH') {
        setError('HubSpot rejected the request — check the token.');
      } else {
        setError('Could not save: ' + err.message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Dialog open={open} onClose={handleClose} maxWidth="xs" fullWidth>
        <DialogTitle>
          {ctx.contactName ? `Phone call summary — ${ctx.contactName}` : 'Phone call summary'}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            <TextField
              id="cah-pc-summary"
              label="What did you discuss?"
              value={summary}
              onChange={e => setSummary(e.target.value)}
              slotProps={{ htmlInput: { maxLength: 8000 } }}
              placeholder="Outcome, next steps, agreed timeline…"
              multiline
              minRows={4}
              fullWidth
              size="small"
              autoFocus
            />
            {error && (
              <Typography variant="caption" color="error">{error}</Typography>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose} disabled={submitting}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleSubmit}
            disabled={submitting}
            data-testid="cah-primary"
          >
            {submitting ? 'Saving…' : 'Save note'}
          </Button>
        </DialogActions>
      </Dialog>
      <FollowUpEmailModal
        handler={handler}
        ctx={ctx}
        summary={savedSummary}
        open={showFollowUp}
        onClose={() => setShowFollowUp(false)}
      />
    </>
  );
}
