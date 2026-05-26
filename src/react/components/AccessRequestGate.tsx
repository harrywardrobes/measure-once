import React, { useEffect, useState } from 'react';
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
  bgcolor: '#200842',
  '&:hover': { bgcolor: '#3d0f7a' },
  fontWeight: 700,
} as const;

const LINK_SX = { color: '#200842', fontWeight: 600 } as const;

const BRAND_MARK = (
  <Box sx={{ textAlign: 'center', mb: 3 }}>
    <Typography
      sx={{
        fontFamily: "'Anton', sans-serif",
        fontSize: '1.35rem',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: '#0f172a',
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

function FormView({ onConfirmed }: { onConfirmed: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedName || !trimmedEmail) {
      setError('Please enter your name and email address.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const r = await fetch('/api/request-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ name: trimmedName, email: trimmedEmail }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.ok) {
        onConfirmed();
      } else if (r.status === 429) {
        setError('Too many requests — please try again later.');
      } else {
        setError(data.error || 'Could not submit request. Please try again.');
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

export function AccessRequestGate() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ViewState>('form');

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ShowParams>).detail;
      const nextView = detail?.view ?? resolveInitialView(detail?.urlParams);
      setView(nextView);
      setOpen(true);
    };
    window.addEventListener('mo:show-access-gate', handler);
    return () => window.removeEventListener('mo:show-access-gate', handler);
  }, []);

  return (
    <Dialog
      open={open}
      slotProps={{ paper: { sx: { width: '100%', maxWidth: 420, borderRadius: 3, p: 1 } } }}
    >
      <DialogContent sx={{ pt: 3 }}>
        {BRAND_MARK}
        {view === 'form' && <FormView onConfirmed={() => setView('confirmed')} />}
        {view === 'confirmed' && <ConfirmedView />}
        {view === 'email_conflict' && <EmailConflictView />}
        {view === 'pending' && <PendingView />}
        {view === 'already_approved' && <AlreadyApprovedView />}
      </DialogContent>
    </Dialog>
  );
}

export default AccessRequestGate;
