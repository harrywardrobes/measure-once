import React from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import GlobalStyles from '@mui/material/GlobalStyles';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { StrengthMeter, StrengthMeterErrorBoundary, checkPasswordPolicy } from '../../utils/passwordStrength';
import { usePageTitle } from '../../hooks/usePageTitle';
import { BRAND_COLORS } from '../../theme';

const LOGO_URL = '/harry-wardrobes-logo.png';
const bodyStyles = { 'html, body': { margin: 0, padding: 0, minHeight: '100vh', background: BRAND_COLORS.pageBackground } };

type PageState = 'loading' | 'invalid' | 'form';

interface InvalidInfo {
  msg: string;
  actionHref: string;
  actionLabel: string;
}

export function SetPasswordPage() {
  usePageTitle('Set Password · Harry Wardrobes');

  const [state, setState] = React.useState<PageState>('loading');
  const [invalid, setInvalid] = React.useState<InvalidInfo>({ msg: '', actionHref: '/login', actionLabel: 'Back to sign in' });
  const [email, setEmail] = React.useState('');
  const [pw1, setPw1] = React.useState('');
  const [pw2, setPw2] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  // Accept either ?oobCode= (Identity Platform links) or legacy ?token= URLs.
  const token = React.useMemo(() => {
    const p = new URLSearchParams(location.search);
    return p.get('oobCode') || p.get('token') || '';
  }, []);

  const userInputs = React.useMemo(() => {
    const local = (email || '').split('@')[0] || '';
    return [email, local, 'measure once', 'measureonce'].filter(Boolean);
  }, [email]);

  React.useEffect(() => {
    if (!token) {
      setInvalid({ msg: 'This link is missing its token. Ask an admin to send you a new set-password email.', actionHref: '/login', actionLabel: 'Back to sign in' });
      setState('invalid');
      return;
    }
    fetch('/api/set-password/validate?token=' + encodeURIComponent(token))
      .then(r => r.json().then(d => ({ ok: r.ok, data: d })))
      .catch(() => ({ ok: false, data: {} }))
      .then(({ ok, data }) => {
        if (!ok || !data.valid) {
          let msg: string;
          let actionHref = '/login';
          let actionLabel = 'Back to sign in';
          if (data.reason === 'expired') {
            msg = 'This link has expired. Request a new one.';
            actionHref = '/login#forgot'; actionLabel = 'Request a new reset link';
          } else if (data.reason === 'invalid') {
            msg = 'This link is not valid. Ask an admin to send a new set-password email.';
          } else {
            msg = 'This link is no longer valid. Ask an admin for a new one.';
          }
          setInvalid({ msg, actionHref, actionLabel });
          setState('invalid');
        } else {
          setEmail(data.email || '');
          setState('form');
        }
      });
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pw1 !== pw2) { setError('Passwords do not match.'); return; }
    const policyErr = await checkPasswordPolicy(pw1, userInputs);
    if (policyErr) { setError(policyErr); return; }
    setError(null);
    setBusy(true);
    try {
      const r = await fetch('/api/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: pw1 }),
      });
      const data = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) {
        setError(data.error || 'Could not set password.');
        return;
      }
      window.location.href = '/login?password_set=1';
    } catch {
      setError('Network error — please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 3 }}>
      <GlobalStyles styles={bodyStyles} />
      <Paper
        elevation={0}
        sx={{ width: '100%', maxWidth: 420, p: 4, border: '1px solid', borderColor: 'divider', borderRadius: 3, boxShadow: '0 1px 3px rgba(0,0,0,.04)' }}
      >
        <Box sx={{ textAlign: 'center', mb: 3.5 }}>
          <Box component="img" src={LOGO_URL} alt="Harry Wardrobes" sx={{ maxWidth: 180, width: '100%', height: 'auto' }} />
        </Box>
        <Typography variant="h5" sx={{ fontWeight: 700, mb: 2.5, letterSpacing: '-0.01em' }}>
          Set your password
        </Typography>

        {state === 'loading' && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <CircularProgress size={18} />
            <Typography variant="body2" color="text.secondary">Checking link…</Typography>
          </Box>
        )}

        {state === 'invalid' && (
          <Alert severity="error">
            <Typography variant="body2">{invalid.msg}</Typography>
            <Box sx={{ mt: 1 }}>
              <Link href={invalid.actionHref} underline="always" sx={{ fontWeight: 600, fontSize: '0.875rem' }}>
                {invalid.actionLabel}
              </Link>
            </Box>
          </Alert>
        )}

        {state === 'form' && (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>Choose a password for</Typography>
            <Typography variant="body1" sx={{ fontWeight: 600, mb: 2.5 }}>{email}</Typography>
            {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
            <Box component="form" id="pw-form" onSubmit={handleSubmit} autoComplete="off">
              <Stack spacing={2.5}>
                <Box>
                  <TextField
                    id="pw1" label="New password" type="password" fullWidth required
                    slotProps={{ htmlInput: { minLength: 8 } }} autoComplete="new-password"
                    helperText="At least 8 characters, with letters and numbers."
                    value={pw1} onChange={e => { setPw1(e.target.value); setError(null); }}
                  />
                  <StrengthMeterErrorBoundary>
                    <StrengthMeter value={pw1} userInputs={userInputs} />
                  </StrengthMeterErrorBoundary>
                </Box>
                <TextField
                  id="pw2" label="Confirm password" type="password" fullWidth required
                  slotProps={{ htmlInput: { minLength: 8 } }} autoComplete="new-password"
                  value={pw2} onChange={e => { setPw2(e.target.value); setError(null); }}
                />
                <Box>
                  <Button
                    id="submit-btn" type="submit" variant="contained" disabled={busy}
                    sx={{ minHeight: 44 }}
                  >
                    {busy ? 'Saving…' : 'Set password'}
                  </Button>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                    You&apos;ll be signed out of any other devices.
                  </Typography>
                </Box>
              </Stack>
            </Box>
          </>
        )}
      </Paper>
    </Box>
  );
}

export default SetPasswordPage;
