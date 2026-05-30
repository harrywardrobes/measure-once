import React, { useState, useEffect, useRef, useCallback } from 'react';
import Alert from '@mui/material/Alert';
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
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import type { CardActionHandlerData } from '../../hooks/useCardActionHandlers';
import type { CardActionContext } from '../../utils/dispatchCardActionHandler';

interface Props {
  handler: CardActionHandlerData;
  ctx: CardActionContext;
  open: boolean;
  onClose: () => void;
}

interface LinkStatus {
  hasActiveLink: boolean;
  expiresAt?: string;
}

interface GeneratedLink {
  formLink: string;
  token: string;
  expiresAt: string;
  isResend?: boolean;
}

type Phase =
  | 'checking'
  | 'check-error'
  | 'confirming'
  | 'generating'
  | 'ready'
  | 'sent';

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

function formatExpiry(expiresAt: string): string {
  const now = new Date();
  const exp = new Date(expiresAt);
  if (isNaN(exp.getTime())) return 'expiry date unavailable';
  const msPerDay = 1000 * 60 * 60 * 24;
  const diffDays = Math.ceil((exp.getTime() - now.getTime()) / msPerDay);
  if (diffDays <= 0) return 'expires today';
  if (diffDays === 1) return 'expires tomorrow';
  return `expires in ${diffDays} days`;
}

export function UploadPhotosModal({ handler: _handler, ctx, open, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [linkStatus, setLinkStatus] = useState<LinkStatus | null>(null);
  const [generatedLink, setGeneratedLink] = useState<GeneratedLink | null>(null);
  const [checkError, setCheckError] = useState('');
  const [linkError, setLinkError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [copyAndClosing, setCopyAndClosing] = useState(false);

  // AbortController ref so we can cancel in-flight generate-link requests
  // (e.g. if the user clicks Cancel while generation is running).
  const generateAbortRef = useRef<AbortController | null>(null);

  function generateLink(contactId: string) {
    const controller = new AbortController();
    generateAbortRef.current = controller;

    setPhase('generating');
    setLinkError('');

    fetch(
      `/api/customer-info/by-contact/${encodeURIComponent(contactId)}/generate-link`,
      { method: 'POST', signal: controller.signal }
    )
      .then(r => {
        if (!r.ok) return r.json().then(d => { throw new Error(d.error || `HTTP ${r.status}`); });
        return r.json() as Promise<GeneratedLink>;
      })
      .then(data => {
        if (controller.signal.aborted) return;
        setGeneratedLink(data);
        setPhase('ready');
      })
      .catch(e => {
        if ((e as Error).name === 'AbortError') return;
        setLinkError((e as Error).message || 'Could not generate link.');
        setPhase('ready');
      });
  }

  // Fetch link-status (read-only) then decide whether to warn or generate immediately.
  const checkStatus = useCallback((contactId: string, signal: AbortSignal) => {
    setPhase('checking');
    setCheckError('');
    setLinkError('');
    setError('');
    setLinkStatus(null);
    setGeneratedLink(null);

    fetch(
      `/api/customer-info/by-contact/${encodeURIComponent(contactId)}/link-status`,
      { signal }
    )
      .then(r => {
        if (!r.ok) return r.json().then(d => { throw new Error(d.error || `HTTP ${r.status}`); });
        return r.json() as Promise<LinkStatus>;
      })
      .then(status => {
        if (signal.aborted) return;
        setLinkStatus(status);
        if (status.hasActiveLink) {
          setPhase('confirming');
        } else {
          generateLink(contactId);
        }
      })
      .catch(e => {
        if ((e as Error).name === 'AbortError') return;
        setCheckError((e as Error).message || 'Could not check link status.');
        setPhase('check-error');
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    checkStatus(ctx.contactId, controller.signal);
    return () => {
      controller.abort();
      generateAbortRef.current?.abort();
    };
  }, [open, ctx.contactId, checkStatus]);

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
      setPhase('sent');
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
      setPhase('checking');
      setError('');
      setGeneratedLink(null);
      setLinkError('');
      setLinkStatus(null);
      onClose();
    });
    setCopyAndClosing(true);
  }, [generatedLink, onClose]);

  function handleClose() {
    generateAbortRef.current?.abort();
    setPhase('checking');
    setError('');
    setGeneratedLink(null);
    setLinkError('');
    setCheckError('');
    setLinkStatus(null);
    setCopyAndClosing(false);
    onClose();
  }

  // ── Title ────────────────────────────────────────────────────────────────────

  const title =
    phase === 'confirming'
      ? 'Active link exists'
      : generatedLink?.isResend
        ? 'Resend photo upload link'
        : 'Send photo upload link';

  // ── Content ──────────────────────────────────────────────────────────────────

  function renderContent() {
    if (phase === 'checking') {
      return (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', py: 1 }}>
          <CircularProgress size={18} />
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>Checking…</Typography>
        </Stack>
      );
    }

    if (phase === 'check-error') {
      return (
        <Stack spacing={1.5} sx={{ mt: 0.5 }}>
          <Typography variant="body2" color="error">
            Could not check link status: {checkError}
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            You can retry, or proceed directly — the system will handle any existing
            link automatically when the new one is generated.
          </Typography>
        </Stack>
      );
    }

    if (phase === 'confirming') {
      const expiryNote = linkStatus?.expiresAt
        ? ` It ${formatExpiry(linkStatus.expiresAt)}.`
        : '';
      return (
        <Stack spacing={1.5} sx={{ mt: 0.5 }}>
          <Alert severity="warning" icon={<WarningAmberIcon fontSize="inherit" />}>
            <strong>{ctx.contactName || 'This contact'}</strong> already has an
            active link.{expiryNote} Generating a new link will immediately
            expire the existing one — the customer won't be able to use it any
            more, whether you email the new link or copy it manually.
          </Alert>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            You can still proceed — this is just a heads-up. If the customer
            hasn't submitted yet, they'll need to use the new link instead.
          </Typography>
        </Stack>
      );
    }

    if (phase === 'generating') {
      return (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', py: 1 }}>
          <CircularProgress size={18} />
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>Generating link…</Typography>
        </Stack>
      );
    }

    if (phase === 'sent') {
      return (
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
      );
    }

    // ready
    return (
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
          {linkError ? (
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
    );
  }

  // ── Actions ──────────────────────────────────────────────────────────────────

  function renderActions() {
    if (phase === 'checking') {
      return <Button onClick={handleClose}>Cancel</Button>;
    }

    if (phase === 'check-error') {
      return (
        <>
          <Button onClick={handleClose}>Cancel</Button>
          <Button onClick={() => {
            const controller = new AbortController();
            checkStatus(ctx.contactId, controller.signal);
          }}>
            Retry
          </Button>
          <Button
            variant="contained"
            onClick={() => generateLink(ctx.contactId)}
            data-testid="cah-proceed-anyway"
          >
            Send anyway
          </Button>
        </>
      );
    }

    if (phase === 'confirming') {
      return (
        <>
          <Button onClick={handleClose}>Cancel</Button>
          <Button
            variant="contained"
            color="warning"
            onClick={() => generateLink(ctx.contactId)}
            data-testid="cah-confirm-resend"
          >
            Generate new link
          </Button>
        </>
      );
    }

    if (phase === 'generating') {
      return <Button onClick={handleClose}>Cancel</Button>;
    }

    if (phase === 'sent') {
      return <Button variant="contained" onClick={handleClose}>Done</Button>;
    }

    // ready
    const sendLabel = generatedLink?.isResend ? 'Resend email' : 'Send email';
    return (
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
          disabled={submitting || !!linkError || copyAndClosing}
          startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : undefined}
          data-testid="cah-primary"
        >
          {submitting ? 'Sending…' : sendLabel}
        </Button>
      </>
    );
  }

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="xs" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>{renderContent()}</DialogContent>
      <DialogActions>{renderActions()}</DialogActions>
    </Dialog>
  );
}
