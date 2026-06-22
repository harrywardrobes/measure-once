import React, { useState } from 'react';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { CardActionHandlerData } from '../../hooks/useCardActionHandlers';
import type { CardActionContext } from '../../utils/dispatchCardActionHandler';
import { POST } from '../../utils/api';
import { useToast } from '../../contexts/ToastContext';
import { useDiscardGuard } from '../../hooks/useDiscardGuard';
import { DiscardConfirmDialog } from './DiscardConfirmDialog';
import { ModalContactHeader } from './ModalContactHeader';
import { DemoActionTooltip } from './demoMode';
import { FullScreenModal } from './FullScreenModal';

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
    <FullScreenModal
      open={open}
      onClose={onClose}
      title="Draft a follow-up email?"
      centerContent
      footer={
        <>
          <Button onClick={onClose}>Not now</Button>
          <Button variant="contained" onClick={handleDraft}>Draft email</Button>
        </>
      }
    >
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        We can open your email composer pre-filled with this call summary.
      </Typography>
    </FullScreenModal>
  );
}

interface Props {
  handler: CardActionHandlerData;
  ctx: CardActionContext;
  open: boolean;
  onClose: () => void;
  demo?: boolean;
}

export function PhoneSummaryModal({ handler, ctx, open, onClose, demo }: Props) {
  const cfg = handler.config || {};
  const showToast = useToast();
  const [summary, setSummary] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showFollowUp, setShowFollowUp] = useState(false);
  const [savedSummary, setSavedSummary] = useState('');

  const hasUnsavedChanges = summary.trim().length > 0;

  function handleClose() {
    setSummary('');
    setError('');
    onClose();
  }

  const { confirmOpen: confirmDiscardOpen, handleRequestClose, handleKeepEditing } = useDiscardGuard(
    demo ? false : hasUnsavedChanges,
    handleClose,
    submitting,
  );

  async function handleSubmit() {
    if (demo) return;
    setError('');
    if (!summary.trim()) { setError('Please type a summary first.'); return; }

    setSubmitting(true);
    try {
      await POST('/api/card-actions/phone-call-summary', {
        contactId: ctx.contactId,
        summary: summary.trim(),
        notePrefix: (cfg.notePrefix as string) || '',
      });
      showToast('Note saved to HubSpot', false);
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
      <FullScreenModal
        open={open}
        onClose={handleRequestClose}
        disableClose={submitting}
        title={ctx.contactName ? `Phone call summary — ${ctx.contactName}` : 'Phone call summary'}
        headerActions={
          demo ? <Chip label="Demo preview" size="small" color="info" variant="outlined" /> : undefined
        }
        footer={
          <>
            <Button onClick={handleRequestClose} disabled={submitting}>Cancel</Button>
            <DemoActionTooltip demo={demo}>
              <Button
                variant="contained"
                onClick={handleSubmit}
                disabled={submitting || demo}
                data-testid="cah-primary"
              >
                {submitting ? 'Saving…' : 'Save note'}
              </Button>
            </DemoActionTooltip>
          </>
        }
      >
        <Stack spacing={1.5} sx={{ mt: 0.5 }}>
          <ModalContactHeader name={ctx.contactName} email={ctx.contactEmail} phone={ctx.contactPhone} mobile={ctx.contactMobile} />
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
      </FullScreenModal>
      <FollowUpEmailModal
        handler={handler}
        ctx={ctx}
        summary={savedSummary}
        open={showFollowUp}
        onClose={() => setShowFollowUp(false)}
      />
      <DiscardConfirmDialog
        open={confirmDiscardOpen}
        onKeepEditing={handleKeepEditing}
        onDiscard={handleClose}
      />
    </>
  );
}
