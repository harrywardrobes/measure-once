import React, { useState, useEffect, useRef, useCallback } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import type { CardActionHandlerData } from '../../hooks/useCardActionHandlers';
import type { CardActionContext } from '../../utils/dispatchCardActionHandler';
import {
  broadcastCustomerInfoLinkChanged,
  subscribeCustomerInfoLinkChanged,
} from '../../utils/broadcastCustomerInfoLink';
import { useToast } from '../../contexts/ToastContext';
import { ModalContactHeader } from './ModalContactHeader';
import { DemoActionTooltip } from './demoMode';
import { FullScreenModal } from './FullScreenModal';
import { EmailComposer } from './EmailComposer';

const resendCooldownExpiry = new Map<string, number>();

interface Props {
  handler: CardActionHandlerData;
  ctx: CardActionContext;
  open: boolean;
  onClose: () => void;
  demo?: boolean;
}

interface LinkStatus {
  hasActiveLink: boolean;
  expiresAt?: string;
  formLink?: string;
  token?: string;
}

interface GeneratedLink {
  formLink?: string;
  token?: string;
  expiresAt: string;
  isResend?: boolean;
}

type Phase =
  | 'checking'
  | 'check-error'
  | 'confirming'
  | 'revoked-elsewhere'
  | 'revoking-confirm'
  | 'generating'
  | 'ready'
  | 'email-preview'
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
          sx: { fontSize: '0.8rem', fontFamily: (theme) => theme.typography.monoFontFamily },
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

export function UploadPhotosModal({ handler: _handler, ctx, open, onClose, demo }: Props) {
  const showToast = useToast();
  const [phase, setPhase] = useState<Phase>('checking');
  const [linkStatus, setLinkStatus] = useState<LinkStatus | null>(null);
  const [generatedLink, setGeneratedLink] = useState<GeneratedLink | null>(null);
  const [checkError, setCheckError] = useState('');
  const [linkError, setLinkError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(false);
  const resendCooldownRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sendCooldown, setSendCooldown] = useState(false);
  const sendCooldownRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [error, setError] = useState('');
  const [copyAndClosing, setCopyAndClosing] = useState(false);

  // Email preview state
  const [emailSubject, setEmailSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');
  const [emailError, setEmailError] = useState('');
  // Whether the preview is for a resend (true) or a new send (false)
  const emailIsResendRef = useRef(false);

  // AbortController ref so we can cancel in-flight generate-link requests
  // (e.g. if the user clicks Cancel while generation is running).
  const generateAbortRef = useRef<AbortController | null>(null);

  // Mirror of `phase` in a ref so the broadcast subscription (set up once per
  // open) can read the current phase without re-subscribing on every change.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // AbortController for a re-check triggered by a cross-tab broadcast.
  const recheckAbortRef = useRef<AbortController | null>(null);

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
        broadcastCustomerInfoLinkChanged(contactId);
      })
      .catch(e => {
        if ((e as Error).name === 'AbortError') return;
        setLinkError((e as Error).message || 'Could not generate link.');
        setPhase('ready');
      });
  }

  // Fetch link-status (read-only) then decide whether to warn or generate immediately.
  // `fromBroadcast` flags a re-check triggered by a cross-tab generate/revoke
  // event. In that case, if no active link remains, we do NOT silently
  // auto-generate a new one — instead we surface the 'revoked-elsewhere' phase
  // so staff explicitly see the previous link is gone and choose to regenerate.
  const checkStatus = useCallback((contactId: string, signal: AbortSignal, fromBroadcast = false) => {
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
        } else if (fromBroadcast) {
          setPhase('revoked-elsewhere');
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

    // Restore resend cooldown if it's still active for this contact
    if (resendCooldownRef.current) clearTimeout(resendCooldownRef.current);
    const storedExpiry = resendCooldownExpiry.get(ctx.contactId);
    const remaining = storedExpiry ? storedExpiry - Date.now() : 0;
    if (remaining > 0) {
      setResendCooldown(true);
      resendCooldownRef.current = setTimeout(() => {
        setResendCooldown(false);
        resendCooldownExpiry.delete(ctx.contactId);
      }, remaining);
    } else {
      setResendCooldown(false);
      if (storedExpiry !== undefined) resendCooldownExpiry.delete(ctx.contactId);
    }

    if (demo) {
      setGeneratedLink({
        formLink: `${window.location.origin}/customer-info/demo-token`,
        token: 'demo-token',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      });
      setLinkError('');
      setCheckError('');
      setError('');
      setPhase('ready');
      return;
    }
    const controller = new AbortController();
    checkStatus(ctx.contactId, controller.signal);
    return () => {
      controller.abort();
      generateAbortRef.current?.abort();
    };
  }, [open, ctx.contactId, checkStatus, demo]);

  // While the modal is open, listen for link generate/revoke broadcasts from
  // other tabs/windows. If one arrives for this contact while we're showing the
  // existing-link warning ('confirming' phase), the link the user is looking at
  // may have just been invalidated elsewhere — re-check status so the modal
  // reflects the current server state (auto-generating or showing no active
  // link) instead of acting on a stale link.
  useEffect(() => {
    if (!open || demo) return;
    const unsubscribe = subscribeCustomerInfoLinkChanged((contactId) => {
      if (contactId !== ctx.contactId) return;
      if (phaseRef.current !== 'confirming') return;
      recheckAbortRef.current?.abort();
      const controller = new AbortController();
      recheckAbortRef.current = controller;
      checkStatus(ctx.contactId, controller.signal, true);
    });
    return () => {
      unsubscribe();
      recheckAbortRef.current?.abort();
    };
  }, [open, demo, ctx.contactId, checkStatus]);

  async function fetchEmailPreviewHtml(subject: string, body: string): Promise<string> {
    const token = generatedLink?.token || linkStatus?.token ||
      (linkStatus?.formLink ? linkStatus.formLink.split('/').pop() : undefined);
    const r = await fetch(
      `/api/customer-info/by-contact/${encodeURIComponent(ctx.contactId)}/upload-link-email-preview`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, subject, body }),
      }
    );
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Could not load preview');
    return (d.html as string) || '';
  }

  function openEmailPreview(isResend: boolean) {
    if (demo) return;
    emailIsResendRef.current = isResend;
    setEmailSubject('');
    setEmailBody('');
    setEmailError('');
    // Fetch the default template to populate the composer
    const token = generatedLink?.token || linkStatus?.token ||
      (linkStatus?.formLink ? linkStatus.formLink.split('/').pop() : undefined);
    fetch(
      `/api/customer-info/by-contact/${encodeURIComponent(ctx.contactId)}/upload-link-email-preview`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      }
    )
      .then(r => r.json())
      .then((d: { subject?: string; text?: string; error?: string }) => {
        setEmailSubject(d.subject || '');
        setEmailBody(d.text || '');
      })
      .catch(() => { /* Non-fatal — composer starts empty */ });
    setPhase('email-preview');
  }

  async function handleSendConfirmed() {
    if (demo) return;
    setError('');
    setEmailError('');
    setSubmitting(true);
    try {
      const r = await fetch('/api/card-actions/upload-photos-and-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contactId: ctx.contactId,
          ...(generatedLink ? { token: generatedLink.token } : {}),
          emailSubject: emailSubject.trim() || undefined,
          emailBody:    emailBody.trim()    || undefined,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || d.message || 'Failed to send');
      setPhase('sent');
      showToast('Email sent to customer', false);
      setSendCooldown(true);
      if (sendCooldownRef.current) clearTimeout(sendCooldownRef.current);
      sendCooldownRef.current = setTimeout(() => setSendCooldown(false), 3000);
    } catch (e) {
      setEmailError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResendConfirmed() {
    if (demo) return;
    const token =
      linkStatus?.token ||
      (linkStatus?.formLink ? linkStatus.formLink.split('/').pop() : '');
    if (!token) {
      showToast('Cannot re-send: link token is unavailable. Try generating a new link.', true);
      return;
    }
    setResending(true);
    setEmailError('');
    try {
      const r = await fetch(
        `/api/customer-info/by-contact/${encodeURIComponent(ctx.contactId)}/resend`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token,
            emailSubject: emailSubject.trim() || undefined,
            emailBody:    emailBody.trim()    || undefined,
          }),
        }
      );
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || d.message || 'Failed to re-send');
      showToast('Email re-sent to customer', false);
      const expiry = Date.now() + 3000;
      resendCooldownExpiry.set(ctx.contactId, expiry);
      setResendCooldown(true);
      if (resendCooldownRef.current) clearTimeout(resendCooldownRef.current);
      resendCooldownRef.current = setTimeout(() => {
        setResendCooldown(false);
        resendCooldownExpiry.delete(ctx.contactId);
      }, 3000);
      setPhase('confirming');
    } catch (e) {
      setEmailError((e as Error).message);
    } finally {
      setResending(false);
    }
  }

  async function handleRevoke() {
    if (demo) return;
    setRevoking(true);
    try {
      const r = await fetch(
        `/api/customer-info/by-contact/${encodeURIComponent(ctx.contactId)}/revoke-link`,
        { method: 'POST' }
      );
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || d.message || 'Failed to revoke link');
      broadcastCustomerInfoLinkChanged(ctx.contactId);
      showToast('Link revoked — the customer can no longer use it', false);
      handleClose();
    } catch (e) {
      showToast((e as Error).message || 'Could not revoke link', true);
    } finally {
      setRevoking(false);
    }
  }

  function handleManualUpload(url: string) {
    if (demo) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  const handleCopyAndClose = useCallback(() => {
    if (!generatedLink?.formLink) return;
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

  useEffect(() => () => {
    if (resendCooldownRef.current) clearTimeout(resendCooldownRef.current);
    if (sendCooldownRef.current) clearTimeout(sendCooldownRef.current);
  }, []);

  function handleClose() {
    generateAbortRef.current?.abort();
    if (resendCooldownRef.current) clearTimeout(resendCooldownRef.current);
    if (sendCooldownRef.current) clearTimeout(sendCooldownRef.current);
    setPhase('checking');
    setError('');
    setEmailSubject('');
    setEmailBody('');
    setEmailError('');
    setGeneratedLink(null);
    setLinkError('');
    setCheckError('');
    setLinkStatus(null);
    setCopyAndClosing(false);
    setRevoking(false);
    setResending(false);
    setResendCooldown(false);
    setSendCooldown(false);
    onClose();
  }

  // ── Title ────────────────────────────────────────────────────────────────────

  const title =
    phase === 'confirming'
      ? 'Active link exists'
      : phase === 'revoked-elsewhere'
        ? 'Link no longer valid'
        : phase === 'revoking-confirm'
        ? 'Revoke this link?'
        : phase === 'email-preview'
        ? (emailIsResendRef.current ? 'Preview resend email' : 'Preview email before sending')
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

      // Manager/admin view: formLink is available — show link actions panel
      if (linkStatus?.formLink) {
        return (
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            <Stack spacing={0.5}>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                Existing customer link:
              </Typography>
              <CopyLinkField url={linkStatus.formLink} />
            </Stack>
            <Alert severity="warning" icon={<WarningAmberIcon fontSize="inherit" />} sx={{ py: 0.5 }}>
              <strong>{ctx.contactName || 'This contact'}</strong> already has an active
              link.{expiryNote} Generating a new link will immediately expire this one.
            </Alert>
          </Stack>
        );
      }

      // Member view (no formLink): warning-only layout
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

    if (phase === 'revoked-elsewhere') {
      return (
        <Stack spacing={1.5} sx={{ mt: 0.5 }} data-testid="cah-revoked-elsewhere">
          <Alert severity="warning" icon={<WarningAmberIcon fontSize="inherit" />}>
            The link for <strong>{ctx.contactName || 'this contact'}</strong> was
            just revoked from another tab or by another team member. The previous
            link is no longer valid — the customer can no longer use it.
          </Alert>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            No new link has been created yet. If the customer still needs to
            upload photos and details, generate a fresh link to send them.
          </Typography>
        </Stack>
      );
    }

    if (phase === 'revoking-confirm') {
      const expiryNote = linkStatus?.expiresAt
        ? ` It currently ${formatExpiry(linkStatus.expiresAt)}.`
        : '';
      return (
        <Stack spacing={1.5} sx={{ mt: 0.5 }} data-testid="cah-revoke-confirm">
          <Alert severity="error" icon={<WarningAmberIcon fontSize="inherit" />}>
            This will immediately invalidate{' '}
            <strong>{ctx.contactName || 'this contact'}</strong>'s active link.
            {expiryNote} The customer won't be able to use it any more, and this
            can't be undone.
          </Alert>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            You can always generate a new link afterwards if needed.
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

    if (phase === 'email-preview') {
      return (
        <Stack spacing={1.5} sx={{ mt: 0.5 }}>
          <EmailComposer
            subject={emailSubject}
            onSubjectChange={setEmailSubject}
            body={emailBody}
            onBodyChange={setEmailBody}
            fetchPreviewHtml={fetchEmailPreviewHtml}
            disabled={submitting || resending}
            recipientName={ctx.contactName || undefined}
            recipientEmail={ctx.contactEmail || undefined}
            bodyMinRows={6}
            sendError={emailError || undefined}
          />
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
          {generatedLink?.formLink && (
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

        {generatedLink?.formLink && (
          <Stack spacing={0.5}>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              Customer link — copy to share manually:
            </Typography>
            {linkError ? (
              <Typography variant="caption" color="error">
                Could not generate link: {linkError}
              </Typography>
            ) : (
              <CopyLinkField url={generatedLink.formLink} />
            )}
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              Or open the form yourself and submit it on the customer's behalf using "Manually Upload".
            </Typography>
          </Stack>
        )}

        {error && (
          <Typography variant="caption" color="error">{error}</Typography>
        )}
      </Stack>
    );
  }

  // ── Actions ──────────────────────────────────────────────────────────────────

  function renderActions() {
    if (phase === 'checking') {
      return <Button onClick={handleClose} data-testid="cah-cancel">Cancel</Button>;
    }

    if (phase === 'check-error') {
      return (
        <>
          <Button onClick={handleClose} data-testid="cah-cancel">Cancel</Button>
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
            Generate anyway
          </Button>
        </>
      );
    }

    if (phase === 'confirming') {
      // Manager/admin view: full action set when formLink is available
      if (linkStatus?.formLink) {
        return (
          <>
            <Button onClick={handleClose} data-testid="cah-cancel">Cancel</Button>
            <DemoActionTooltip demo={demo}>
              <Button
                color="error"
                onClick={() => setPhase('revoking-confirm')}
                disabled={revoking || demo}
                data-testid="cah-revoke-link"
              >
                Revoke link
              </Button>
            </DemoActionTooltip>
            <Button
              color="warning"
              onClick={() => generateLink(ctx.contactId)}
              data-testid="cah-confirm-generate"
            >
              Generate new link
            </Button>
            <DemoActionTooltip demo={demo}>
              <Button
                data-testid="cah-resend-link"
                onClick={() => openEmailPreview(true)}
                disabled={resendCooldown || demo}
              >
                {resendCooldown ? 'Sent' : 'Re-send link'}
              </Button>
            </DemoActionTooltip>
            <DemoActionTooltip demo={demo}>
              <Button
                variant="contained"
                onClick={() => handleManualUpload(linkStatus.formLink!)}
                disabled={demo}
                startIcon={<OpenInNewIcon fontSize="small" />}
                data-testid="cah-manual-upload"
              >
                Manually Upload
              </Button>
            </DemoActionTooltip>
          </>
        );
      }

      // Member view (no formLink): warning-only with generate/cancel
      return (
        <>
          <Button onClick={handleClose} data-testid="cah-cancel">Cancel</Button>
          <Button
            variant="contained"
            color="warning"
            onClick={() => generateLink(ctx.contactId)}
            data-testid="cah-confirm-generate"
          >
            Generate new link
          </Button>
        </>
      );
    }

    if (phase === 'revoked-elsewhere') {
      return (
        <>
          <Button onClick={handleClose} data-testid="cah-cancel">Cancel</Button>
          <Button
            variant="contained"
            color="warning"
            onClick={() => generateLink(ctx.contactId)}
            data-testid="cah-confirm-generate"
          >
            Generate new link
          </Button>
        </>
      );
    }

    if (phase === 'revoking-confirm') {
      return (
        <>
          <Button
            onClick={() => setPhase('confirming')}
            disabled={revoking}
            data-testid="cah-cancel-revoke-confirm"
          >
            Cancel
          </Button>
          <DemoActionTooltip demo={demo}>
            <Button
              color="error"
              variant="contained"
              onClick={handleRevoke}
              disabled={revoking || demo}
              startIcon={revoking ? <CircularProgress size={16} color="inherit" /> : undefined}
              data-testid="cah-revoke-confirm-action"
            >
              {revoking ? 'Revoking…' : 'Revoke link'}
            </Button>
          </DemoActionTooltip>
        </>
      );
    }

    if (phase === 'generating') {
      return <Button onClick={handleClose} data-testid="cah-cancel">Cancel</Button>;
    }

    if (phase === 'email-preview') {
      const isResend = emailIsResendRef.current;
      const busy = submitting || resending;
      return (
        <>
          <Button onClick={() => setPhase(isResend ? 'confirming' : 'ready')} disabled={busy} data-testid="cah-cancel">
            Back
          </Button>
          <DemoActionTooltip demo={demo}>
            <Button
              variant="contained"
              onClick={isResend ? handleResendConfirmed : handleSendConfirmed}
              disabled={busy || demo || !emailSubject.trim()}
              startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
              data-testid="cah-primary"
            >
              {busy ? 'Sending…' : isResend ? 'Re-send email' : 'Send email'}
            </Button>
          </DemoActionTooltip>
        </>
      );
    }

    if (phase === 'sent') {
      return <Button variant="contained" onClick={handleClose}>Done</Button>;
    }

    // ready
    const sendLabel = generatedLink?.isResend ? 'Preview & resend' : 'Preview & send';
    return (
      <>
        <Button onClick={handleClose} disabled={submitting || copyAndClosing} data-testid="cah-cancel">Cancel</Button>
        {generatedLink?.formLink && !linkError && (
          <>
            <Button
              onClick={handleCopyAndClose}
              disabled={submitting || copyAndClosing}
              startIcon={copyAndClosing ? <CircularProgress size={16} color="inherit" /> : <ContentCopyIcon fontSize="small" />}
              data-testid="cah-copy-close"
            >
              {copyAndClosing ? 'Copying…' : 'Copy & close'}
            </Button>
            <DemoActionTooltip demo={demo}>
              <Button
                onClick={() => handleManualUpload(generatedLink.formLink!)}
                disabled={demo}
                startIcon={<OpenInNewIcon fontSize="small" />}
                data-testid="cah-manual-upload"
              >
                Manually Upload
              </Button>
            </DemoActionTooltip>
          </>
        )}
        <DemoActionTooltip demo={demo}>
          <Button
            variant="contained"
            onClick={() => openEmailPreview(false)}
            disabled={sendCooldown || !!linkError || copyAndClosing || demo}
            data-testid="cah-primary"
          >
            {sendCooldown ? 'Sent' : sendLabel}
          </Button>
        </DemoActionTooltip>
      </>
    );
  }

  return (
    <FullScreenModal
      open={open}
      onClose={handleClose}
      data-testid="upload-photos-dialog"
      title={
        <Typography variant="h4" component="h2" data-testid="upload-photos-dialog-title" sx={{ wordBreak: 'break-word' }}>
          {title}
        </Typography>
      }
      headerActions={
        demo ? <Chip label="Demo preview" size="small" color="info" variant="outlined" /> : undefined
      }
      footer={renderActions()}
    >
      {phase !== 'sent' && (
        <ModalContactHeader name={ctx.contactName} email={ctx.contactEmail} phone={ctx.contactPhone} mobile={ctx.contactMobile} />
      )}
      {renderContent()}
    </FullScreenModal>
  );
}
