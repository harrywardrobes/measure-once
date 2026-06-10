import React, { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import DoNotDisturbAltIcon from '@mui/icons-material/DoNotDisturbAlt';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { BRAND_COLORS } from '../theme';
import type { GalleryEmbedded } from '../types/gallery';

type TW = { render: (el: Element, opts: object) => string; getResponse: (id: string) => string; reset: (id: string) => void };

const WIDGET_EL_ID = 'ts-access-gate';

function useSingleTurnstile(forceNoTurnstile?: boolean) {
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [hasError, setHasError] = useState(false);
  const siteKeyRef = useRef<string | null>(null);
  const widgetId = useRef<string | null>(null);
  const attempted = useRef(false);

  const renderWidget = useCallback(() => {
    if (forceNoTurnstile) return;
    const tw = (window as unknown as { turnstile?: TW }).turnstile;
    const key = siteKeyRef.current;
    if (!key || !tw || attempted.current) return;
    const el = document.getElementById(WIDGET_EL_ID);
    if (!el) return;
    attempted.current = true;
    const id = tw.render(el, {
      sitekey: key,
      theme: 'light',
      appearance: 'always',
      size: 'flexible',
      callback: () => {
        setToken(tw.getResponse(id) || '');
        setHasError(false);
      },
      'error-callback': () => setHasError(true),
      'unsupported-callback': () => setHasError(true),
    });
    widgetId.current = id;
  }, [forceNoTurnstile]);

  useEffect(() => {
    if (forceNoTurnstile) {
      setSiteKey('preview');
      setToken('preview-token');
      return;
    }
    fetch('/api/turnstile-config').then(r => r.json()).then(cfg => {
      if (cfg?.enabled && cfg?.siteKey) {
        siteKeyRef.current = cfg.siteKey;
        setSiteKey(cfg.siteKey);
        const w = window as unknown as { _turnstileApiReady?: boolean; onTurnstileReady?: () => void };
        (window as unknown as { onTurnstileReady: () => void }).onTurnstileReady = () => {
          renderWidget();
        };
        if (w._turnstileApiReady) {
          renderWidget();
        } else {
          const script = document.createElement('script');
          script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileReady';
          script.async = true; script.defer = true;
          document.head.appendChild(script);
        }
      }
    }).catch(() => {});
  }, [forceNoTurnstile, renderWidget]);

  const resetWidget = useCallback(() => {
    if (forceNoTurnstile) return;
    const tw = (window as unknown as { turnstile?: TW }).turnstile;
    const id = widgetId.current;
    setToken('');
    setHasError(false);
    if (id != null && tw) tw.reset(id);
  }, [forceNoTurnstile]);

  return { siteKey, token, hasError, resetWidget, renderWidget };
}

type ViewState = 'form' | 'confirmed' | 'email_conflict' | 'pending' | 'already_approved';

interface ShowParams {
  view?: ViewState;
  urlParams?: URLSearchParams;
}

function resolveInitialView(params?: URLSearchParams): ViewState {
  if (!params) return 'form';
  if (params.get('email_conflict') === '1') return 'email_conflict';
  if (
    params.get('access_requested') === '1' ||
    params.get('denied') === '1' ||
    params.has('error')
  ) return 'confirmed';
  return 'form';
}

const SUBMIT_BTN_SX = {
  bgcolor: BRAND_COLORS.plum,
  '&:hover': { bgcolor: BRAND_COLORS.plumLight },
  fontWeight: 700,
} as const;

const LINK_SX = { color: BRAND_COLORS.plum, fontWeight: 600 } as const;

const BRAND_MARK = (
  <Box sx={{ textAlign: 'center', mb: 3 }}>
    <Typography
      sx={{
        fontFamily: "'Anton', sans-serif",
        fontSize: '1.35rem',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: BRAND_COLORS.ink1,
      }}
    >
      Measure Once
    </Typography>
  </Box>
);

function GateStatusBadge({ state }: { state: ViewState }) {
  const colorMap: Record<ViewState, { bg: string; fg: string } | null> = {
    form: null,
    confirmed:       { bg: '#dcfce7', fg: '#16a34a' },
    already_approved:{ bg: '#dcfce7', fg: '#16a34a' },
    email_conflict:  { bg: '#fee2e2', fg: '#dc2626' },
    pending:         { bg: '#fef3c7', fg: '#d97706' },
  };
  const colors = colorMap[state];
  if (!colors) return null;

  return (
    <Box
      data-testid="gate-status-badge"
      sx={{
        width: 56, height: 56, borderRadius: '50%',
        bgcolor: colors.bg, color: colors.fg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        mx: 'auto', mb: 2,
      }}
    >
      {(state === 'confirmed' || state === 'already_approved') && (
        <CheckCircleOutlinedIcon fontSize="large" />
      )}
      {state === 'email_conflict' && <DoNotDisturbAltIcon fontSize="large" />}
      {state === 'pending' && <HourglassEmptyIcon fontSize="large" />}
    </Box>
  );
}

function TurnstilePlaceholder() {
  return (
    <Box
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        bgcolor: 'grey.50',
        px: 2,
        py: 1.25,
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        minHeight: 65,
      }}
    >
      <Box
        sx={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          border: '2px dashed',
          borderColor: 'grey.400',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          color: 'grey.400',
        }}
      >
        <LockOutlinedIcon sx={{ fontSize: 16 }} />
      </Box>
      <Box>
        <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.secondary', lineHeight: 1.3 }}>
          CAPTCHA widget
        </Typography>
        <Typography variant="caption" color="text.disabled" sx={{ lineHeight: 1.3 }}>
          Preview only — Turnstile loads in production
        </Typography>
      </Box>
    </Box>
  );
}

interface FormViewProps {
  onConfirmed: () => void;
  siteKey: string | null;
  captchaToken: string;
  captchaError: boolean;
  onRenderWidget: () => void;
  onResetWidget: () => void;
  forceNoTurnstile?: boolean;
}

function FormView({ onConfirmed, siteKey, captchaToken, captchaError, onRenderWidget, onResetWidget, forceNoTurnstile }: FormViewProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    onRenderWidget();
  }, [onRenderWidget]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedName || !trimmedEmail) {
      setError('Please enter your name and email address.');
      return;
    }
    if (siteKey && !captchaToken && !captchaError) {
      setError('Please complete the captcha challenge.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const r = await fetch('/api/request-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ name: trimmedName, email: trimmedEmail, captchaToken: captchaToken || undefined }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.ok) {
        onConfirmed();
      } else if (r.status === 429) {
        setError('Too many requests — please try again later.');
        onResetWidget();
      } else if (data.code === 'CAPTCHA_FAILED') {
        setError('CAPTCHA verification failed — please complete the challenge again.');
        onResetWidget();
      } else {
        setError(data.error || 'Could not submit request. Please try again.');
        onResetWidget();
      }
    } catch {
      setError('Network error — please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} noValidate>
      <Typography variant="h6" sx={{ fontWeight: 700, textAlign: 'center', mb: 0.5 }}>
        Request access
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', mb: 3 }}>
        Enter your details below and we'll review your request.
      </Typography>
      <Stack spacing={2}>
        <TextField
          label="Full name"
          value={name}
          onChange={e => setName(e.target.value)}
          autoComplete="name"
          required
          fullWidth
          size="small"
          disabled={loading}
          slotProps={{ htmlInput: { 'aria-label': 'Full name' } }}
        />
        <TextField
          label="Email address"
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          autoComplete="email"
          required
          fullWidth
          size="small"
          disabled={loading}
          slotProps={{ htmlInput: { 'aria-label': 'Email address' } }}
        />
        {forceNoTurnstile ? (
          <TurnstilePlaceholder />
        ) : (
          siteKey && (
            <div id={WIDGET_EL_ID} style={{ margin: '4px 0 2px', minHeight: 65 }} />
          )
        )}
        {error && (
          <Typography variant="body2" color="error" role="alert">
            {error}
          </Typography>
        )}
        <Button type="submit" variant="contained" fullWidth disabled={loading} sx={SUBMIT_BTN_SX}>
          {loading ? 'Sending…' : 'Request access'}
        </Button>
      </Stack>
      <Typography variant="body2" sx={{ textAlign: 'center', mt: 2.5 }} color="text.secondary">
        Already have access?{' '}
        <Box component="a" href="/login" sx={LINK_SX}>
          Sign in
        </Box>
      </Typography>
    </form>
  );
}

function ConfirmedView() {
  return (
    <Box sx={{ textAlign: 'center' }}>
      <GateStatusBadge state="confirmed" />
      <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>
        Request received
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Your access request has been submitted. We'll review it and be in touch — you don't need to do
        anything else.
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Already approved?{' '}
        <Box component="a" href="/login" sx={LINK_SX}>
          Sign in
        </Box>
      </Typography>
    </Box>
  );
}

function EmailConflictView() {
  return (
    <Box sx={{ textAlign: 'center' }}>
      <GateStatusBadge state="email_conflict" />
      <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>
        Email already in use
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        This email address is already registered to a different account here. Please contact an admin if
        you think this is an error.
      </Typography>
      <Typography variant="body2" color="text.secondary">
        <Box component="a" href="/login" sx={LINK_SX}>
          Try a different account
        </Box>
      </Typography>
    </Box>
  );
}

function PendingView() {
  return (
    <Box sx={{ textAlign: 'center' }}>
      <GateStatusBadge state="pending" />
      <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>
        Request already under review
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Your request is already under review — you'll hear back soon. You don't need to submit again.
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Already approved?{' '}
        <Box component="a" href="/login" sx={LINK_SX}>
          Sign in
        </Box>
      </Typography>
    </Box>
  );
}

function AlreadyApprovedView() {
  return (
    <Box sx={{ textAlign: 'center' }}>
      <GateStatusBadge state="already_approved" />
      <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>
        Your account is already approved
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Your account is already approved — sign in to get started.
      </Typography>
      <Button
        component="a"
        href="/login"
        variant="contained"
        fullWidth
        sx={SUBMIT_BTN_SX}
      >
        Sign in
      </Button>
    </Box>
  );
}

/**
 * Pass to `embedded` in gallery/preview contexts. Renders the gate content
 * inline inside a card frame instead of a Dialog, and skips the Turnstile
 * fetch (showing a placeholder widget instead).
 */
export interface AccessRequestGateEmbeddedPreview extends GalleryEmbedded {
  /** Which view state to display. Defaults to 'form'. */
  view?: ViewState;
}

export interface AccessRequestGateProps {
  /**
   * When true, skips the real Turnstile fetch and renders a styled placeholder
   * widget instead. Use this in gallery/preview contexts where the actual
   * Cloudflare CAPTCHA widget should not be loaded.
   */
  forceNoTurnstile?: boolean;
  /**
   * Controlled open state. When provided the component does not listen for the
   * `mo:show-access-gate` CustomEvent — the parent is responsible for open/close.
   */
  open?: boolean;
  /** Called when the dialog should close (controlled mode only). */
  onClose?: () => void;
  /** Initial view when using controlled mode. Defaults to 'form'. */
  initialView?: ViewState;
  /**
   * Gallery embedding. When provided the gate renders its content inline inside
   * a card frame (no Dialog, no CustomEvent listener, no real Turnstile fetch).
   * Use this in the Design System gallery instead of a CustomEvent dispatch or a
   * hand-rolled duplicate of the component's markup.
   */
  embedded?: AccessRequestGateEmbeddedPreview;
}

export function AccessRequestGate({ forceNoTurnstile, open: openProp, onClose, initialView = 'form', embedded }: AccessRequestGateProps = {}) {
  const controlled = openProp !== undefined;
  const isEmbedded = embedded !== undefined;
  const effectiveForceNoTurnstile = forceNoTurnstile || isEmbedded;
  const [openState, setOpenState] = useState(false);
  const [view, setView] = useState<ViewState>(embedded?.view ?? initialView);
  const { siteKey, token: captchaToken, hasError: captchaError, resetWidget, renderWidget } = useSingleTurnstile(effectiveForceNoTurnstile);

  useEffect(() => {
    if (controlled || isEmbedded) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ShowParams>).detail;
      const nextView = detail?.view ?? resolveInitialView(detail?.urlParams);
      setView(nextView);
      setOpenState(true);
    };
    window.addEventListener('mo:show-access-gate', handler);
    return () => window.removeEventListener('mo:show-access-gate', handler);
  }, [controlled, isEmbedded]);

  useEffect(() => {
    if (controlled) setView(initialView);
  }, [controlled, initialView]);

  const open = controlled ? (openProp ?? false) : openState;
  const handleClose = controlled ? onClose : undefined;

  const content = (
    <>
      {BRAND_MARK}
      {view === 'form' && (
        <FormView
          onConfirmed={() => setView('confirmed')}
          siteKey={siteKey}
          captchaToken={captchaToken}
          captchaError={captchaError}
          onRenderWidget={renderWidget}
          onResetWidget={resetWidget}
          forceNoTurnstile={effectiveForceNoTurnstile}
        />
      )}
      {view === 'confirmed' && <ConfirmedView />}
      {view === 'email_conflict' && <EmailConflictView />}
      {view === 'pending' && <PendingView />}
      {view === 'already_approved' && <AlreadyApprovedView />}
    </>
  );

  if (isEmbedded) {
    return (
      <Box
        sx={{
          width: '100%',
          maxWidth: 420,
          mx: 'auto',
          bgcolor: 'background.paper',
          borderRadius: 3,
          p: 1,
          pointerEvents: 'none',
          userSelect: 'none',
        }}
      >
        <Box sx={{ pt: 3, px: 2, pb: 2 }}>
          {content}
        </Box>
      </Box>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      slotProps={{ paper: { sx: { width: '100%', maxWidth: 420, borderRadius: 3, p: 1 } } }}
    >
      <DialogContent sx={{ pt: 3 }}>
        {content}
      </DialogContent>
    </Dialog>
  );
}

export default AccessRequestGate;
