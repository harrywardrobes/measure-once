import React, { useState, useEffect, useRef, useCallback } from 'react';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';
import type { CardActionHandlerData } from '../../hooks/useCardActionHandlers';
import type { CardActionContext } from '../../utils/dispatchCardActionHandler';

interface Props {
  handler: CardActionHandlerData;
  ctx: CardActionContext;
  open: boolean;
  onClose: () => void;
}

interface GeneratedLink {
  formLink: string;
  token: string;
  expiresAt: string;
}

interface SubmissionRow {
  submitted_at: string | null;
  expires_at: string;
}

function CopyLinkField({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleCopy() {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 1500);
    }).catch(() => {
      // Clipboard write failed (permissions denied or insecure context) — no-op
    });
  }

  useEffect(() => () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); }, []);

  return (
    <TextField
      value={url}
      size="small"
      fullWidth
      slotProps={{
        input: {
          readOnly: true,
          sx: { fontSize: '0.8rem', fontFamily: 'monospace' },
          endAdornment: (
            <InputAdornment position="end">
              <Tooltip
                title={copied ? 'Copied!' : 'Copy link'}
                open={copied || undefined}
                placement="top"
              >
                <IconButton
                  size="small"
                  onClick={handleCopy}
                  aria-label="Copy customer link"
                  edge="end"
                >
                  {copied ? <CheckIcon fontSize="small" color="success" /> : <ContentCopyIcon fontSize="small" />}
                </IconButton>
              </Tooltip>
            </InputAdornment>
          ),
        },
      }}
      onClick={handleCopy}
      sx={{ cursor: 'pointer' }}
    />
  );
}

export function UploadPhotosModal({ handler: _handler, ctx, open, onClose }: Props) {
  const [generatingLink, setGeneratingLink] = useState(false);
  const [generatedLink, setGeneratedLink] = useState<GeneratedLink | null>(null);
  const [linkError, setLinkError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [copyAndClosing, setCopyAndClosing] = useState(false);

  // Resend-mode detection: true when an active (non-submitted, non-expired)
  // submission already exists for this contact.
  const [isResendMode, setIsResendMode] = useState(false);

  // Fetch the list of submissions on open to decide send vs resend mode.
  // Falls back to normal send mode on any error so customers are never left
  // with a broken modal.
  useEffect(() => {
    if (!open) {
      setIsResendMode(false);
      return;
    }

    const controller = new AbortController();

    fetch(
      `/api/customer-info/by-contact/${encodeURIComponent(ctx.contactId)}`,
      { signal: controller.signal },
    )
      .then(r => r.json())
      .then((rows: SubmissionRow[]) => {
        if (controller.signal.aborted) return;
        const now = new Date();
        const hasPending = Array.isArray(rows) && rows.some(
          row => row.submitted_at === null && new Date(row.expires_at) > now,
        );
        setIsResendMode(hasPending);
      })
      .catch((e: Error) => {
        if (e.name === 'AbortError') return;
        // Network or parse error — default to normal send mode.
        setIsResendMode(false);
      });

    return () => {
      controller.abort();
    };
  }, [open, ctx.contactId]);

  useEffect(() => {
    if (!open) return;

    const controller = new AbortController();

    setGeneratingLink(true);
    setGeneratedLink(null);
    setLinkError('');
    setError('');
    setSent(false);

    fetch(
      `/api/customer-info/by-contact/${encodeURIComponent(ctx.contactId)}/generate-link`,
      { method: 'POST', signal: controller.signal }
    )
      .then(r => {
        if (!r.ok) return r.json().then(d => { throw new Error(d.error || `HTTP ${r.status}`); });
        return r.json() as Promise<GeneratedLink>;
      })
      .then(data => {
        if (!controller.signal.aborted) setGeneratedLink(data);
      })
      .catch(e => {
        if ((e as Error).name === 'AbortError') return;
        setLinkError((e as Error).message || 'Could not generate link.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setGeneratingLink(false);
      });

    return () => {
      controller.abort();
    };
  }, [open, ctx.contactId]);

  async function handleSend() {
    setError('');
    setSubmitting(true);
    try {
      let r: Response;
      if (isResendMode) {
        r = await fetch(
          `/api/customer-info/by-contact/${encodeURIComponent(ctx.contactId)}/resend`,
          { method: 'POST' },
        );
      } else {
        r = await fetch('/api/card-actions/upload-photos-and-info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contactId: ctx.contactId,
            ...(generatedLink ? { token: generatedLink.token } : {}),
          }),
        });
      }
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

  const handleCopyAndClose = useCallback(() => {
    if (!generatedLink) return;
    navigator.clipboard.writeText(generatedLink.formLink).catch(() => {
      // Clipboard write failed — close anyway
    }).finally(() => {
      setCopyAndClosing(false);
      setSent(false);
      setError('');
      setGeneratedLink(null);
      setLinkError('');
      onClose();
    });
    setCopyAndClosing(true);
  }, [generatedLink, onClose]);

  function handleClose() {
    setSent(false);
    setError('');
    setGeneratedLink(null);
    setLinkError('');
    setCopyAndClosing(false);
    onClose();
  }

  const title = isResendMode ? 'Resend photo upload link' : 'Send photo upload link';
  const sendLabel = isResendMode ? 'Resend link' : 'Send email';

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="xs" fullWidth>
      <DialogTitle>
        {title}
        <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.25, fontWeight: 'normal' }}>
          {isResendMode
            ? 'A link was already sent — resend it or copy it to share directly'
            : 'Send via email or copy the link to share directly'}
        </Typography>
      </DialogTitle>
      <DialogContent>
        {sent ? (
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              The email has been sent to{' '}
              <strong>{ctx.contactEmail || ctx.contactName || 'the customer'}</strong>.
              They'll receive a link to fill in their details and upload photos of their space.
            </Typography>
            {generatedLink && (
              <Stack spacing={0.5}>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  Link (still copyable):
                </Typography>
                <CopyLinkField url={generatedLink.formLink} />
              </Stack>
            )}
          </Stack>
        ) : (
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              This will send an email to{' '}
              <strong>{ctx.contactName || 'the customer'}</strong>
              {ctx.contactEmail ? <> ({ctx.contactEmail})</> : null}
              {' '}with a secure link to a form where they can:
            </Typography>
            <Stack component="ul" spacing={0.5} sx={{ m: 0, pl: 2.5 }}>
              {[
                'Confirm or correct their contact details and address',
                'Tell us how many rooms they need done',
                'Upload photos of the spaces',
                'Share measurements, style preferences, and notes',
              ].map(item => (
                <Typography key={item} component="li" variant="body2" sx={{ color: 'text.secondary' }}>
                  {item}
                </Typography>
              ))}
            </Stack>

            <Stack spacing={0.5}>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                Customer link — copy to share manually:
              </Typography>
              {generatingLink ? (
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', py: 0.5 }}>
                  <CircularProgress size={16} />
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    Generating link…
                  </Typography>
                </Stack>
              ) : linkError ? (
                <Typography variant="caption" color="error">
                  Could not generate link: {linkError}
                </Typography>
              ) : generatedLink ? (
                <CopyLinkField url={generatedLink.formLink} />
              ) : null}
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
            <Button onClick={handleClose} disabled={submitting || copyAndClosing}>Cancel</Button>
            {generatedLink && !linkError && (
              <Button
                onClick={handleCopyAndClose}
                disabled={submitting || copyAndClosing}
                startIcon={copyAndClosing ? <CircularProgress size={16} color="inherit" /> : <ContentCopyIcon fontSize="small" />}
                data-testid="cah-copy-close"
              >
                {copyAndClosing ? 'Copying…' : 'Copy & close'}
              </Button>
            )}
            <Button
              variant="contained"
              onClick={handleSend}
              disabled={submitting || generatingLink || !!linkError || copyAndClosing}
              startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : undefined}
              data-testid="cah-primary"
            >
              {submitting ? 'Sending…' : sendLabel}
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}
