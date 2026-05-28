import React, { useState, useEffect, useRef } from 'react';
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
      const r = await fetch('/api/card-actions/upload-photos-and-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contactId: ctx.contactId,
          ...(generatedLink ? { token: generatedLink.token } : {}),
        }),
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
    setGeneratedLink(null);
    setLinkError('');
    onClose();
  }

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="xs" fullWidth>
      <DialogTitle>Send photo upload link</DialogTitle>
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
            <Button onClick={handleClose} disabled={submitting}>Cancel</Button>
            <Button
              variant="contained"
              onClick={handleSend}
              disabled={submitting || generatingLink || !!linkError}
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
