import React from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

type Profile = {
  email?: string;
  first_name?: string;
  last_name?: string;
};

const MIN_SCORE = 2;
const MAX_LENGTH = 200;
const STRENGTH_LABELS = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'];
const STRENGTH_COLORS: Array<'error' | 'warning' | 'info' | 'success'> = [
  'error', 'warning', 'warning', 'success', 'success',
];

interface ZxcvbnResult {
  score: 0 | 1 | 2 | 3 | 4;
  feedback?: { warning?: string; suggestions?: string[] };
  crack_times_display?: { offline_slow_hashing_1e4_per_second?: string };
}
type ZxcvbnFn = (password: string, userInputs?: string[]) => ZxcvbnResult;

let _zxcvbnCache: ZxcvbnFn | null = null;
let _zxcvbnPromise: Promise<ZxcvbnFn> | null = null;

function loadZxcvbn(): Promise<ZxcvbnFn> {
  if (_zxcvbnCache) return Promise.resolve(_zxcvbnCache);
  if (!_zxcvbnPromise) {
    _zxcvbnPromise = import('zxcvbn').then((m) => {
      _zxcvbnCache = m.default as unknown as ZxcvbnFn;
      return _zxcvbnCache;
    });
  }
  return _zxcvbnPromise;
}

async function checkPasswordPolicy(pw: string, userInputs: string[]): Promise<string | null> {
  if (!pw) return 'Password is required.';
  if (pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > MAX_LENGTH) return 'Password is too long.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) {
    return 'Password must contain both letters and numbers.';
  }
  const zxcvbnFn = await loadZxcvbn();
  const r = zxcvbnFn(pw.slice(0, MAX_LENGTH), userInputs);
  if (r.score < MIN_SCORE) {
    const warning = r.feedback?.warning;
    return warning
      ? 'Password is too easy to guess: ' + warning
      : 'Password is too easy to guess — please choose something less common.';
  }
  return null;
}

async function jpost<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return data as T;
}

function showToast(msg: string, isError = false) {
  const w = window as unknown as { showToast?: (m: string, e?: boolean) => void };
  if (typeof w.showToast === 'function') w.showToast(msg, isError);
}

class StrengthMeterErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { caught: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { caught: false };
  }
  static getDerivedStateFromError() { return { caught: true }; }
  render() { return this.state.caught ? null : this.props.children; }
}

function StrengthMeter({ value, userInputs }: { value: string; userInputs: string[] }) {
  const [zxcvbnFn, setZxcvbnFn] = React.useState<ZxcvbnFn | null>(() => _zxcvbnCache);

  React.useEffect(() => {
    if (!value || zxcvbnFn) return;
    loadZxcvbn().then(setZxcvbnFn);
  }, [value, zxcvbnFn]);

  if (!value) return null;

  if (!zxcvbnFn) {
    return (
      <Box sx={{ mt: 1 }}>
        <LinearProgress variant="indeterminate" sx={{ height: 6, borderRadius: 999 }} />
      </Box>
    );
  }

  let r: ZxcvbnResult;
  try {
    r = zxcvbnFn(value.slice(0, MAX_LENGTH), userInputs);
  } catch (err) {
    console.error('[StrengthMeter] zxcvbn threw during scoring:', err);
    return null;
  }

  // zxcvbn guarantees score is 0–4, but clamp defensively here because
  // an out-of-range value (e.g. undefined from an unexpected zxcvbn build)
  // makes ((score + 1) / 5) * 100 evaluate to NaN, and MUI v9 LinearProgress
  // throws a prop-validation error on NaN `value` during React render — after
  // the try/catch has already exited, so the try/catch cannot catch it.
  // Clamping to a valid integer ensures LinearProgress always receives a
  // well-formed number, so the error boundary is only a last-resort backstop
  // rather than the primary defence.
  const rawScore = r?.score;
  const score: 0 | 1 | 2 | 3 | 4 =
    typeof rawScore === 'number' && rawScore >= 0 && rawScore <= 4
      ? (rawScore as 0 | 1 | 2 | 3 | 4)
      : 0;
  const crack = r.crack_times_display?.offline_slow_hashing_1e4_per_second || '';
  const suggestion = score < MIN_SCORE
    ? (r.feedback?.warning || 'Too easy to guess — try a longer or less common password.')
    : (r.feedback?.suggestions?.[0] || '');
  return (
    <Box sx={{ mt: 1 }}>
      <LinearProgress
        variant="determinate"
        value={((score + 1) / 5) * 100}
        color={STRENGTH_COLORS[score]}
        sx={{ height: 6, borderRadius: 999 }}
      />
      <Stack direction="row" sx={{ mt: 0.5, justifyContent: 'space-between' }}>
        <Typography variant="caption" color="text.secondary">
          Strength: <Box component="strong" sx={{ color: 'text.primary' }}>{STRENGTH_LABELS[score]}</Box>
        </Typography>
        {crack && (
          <Typography variant="caption" color="text.secondary">Crack time: {crack}</Typography>
        )}
      </Stack>
      {suggestion && (
        <Typography variant="caption" sx={{ display: 'block', mt: 0.25, color: 'warning.dark' }}>
          {suggestion}
        </Typography>
      )}
    </Box>
  );
}

export function ChangePasswordCard({ profile }: { profile: Profile }) {
  const [open, setOpen] = React.useState(false);
  const [current, setCurrent] = React.useState('');
  const [next, setNext] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [errors, setErrors] = React.useState<{ current?: string; next?: string; confirm?: string; form?: string }>({});
  const [success, setSuccess] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const userInputs = React.useMemo(() => {
    const email = (profile.email || '').toLowerCase();
    const local = email.split('@')[0] || '';
    return [email, local, profile.first_name || '', profile.last_name || '',
            'measure once', 'measureonce'].filter(Boolean);
  }, [profile.email, profile.first_name, profile.last_name]);

  React.useEffect(() => {
    if (open) loadZxcvbn();
  }, [open]);

  const resetFields = () => {
    setCurrent(''); setNext(''); setConfirm(''); setErrors({});
  };

  const handleOpen = () => { setSuccess(null); resetFields(); setOpen(true); };
  const handleClose = () => { if (submitting) return; resetFields(); setOpen(false); };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const next_errors: typeof errors = {};
    if (!current) next_errors.current = 'Enter your current password.';
    if (!next) next_errors.next = 'Enter a new password.';
    else if (current && next === current) next_errors.next = 'New password must be different from your current password.';
    else {
      const policyErr = await checkPasswordPolicy(next, userInputs);
      if (policyErr) next_errors.next = policyErr;
    }
    if (!confirm) next_errors.confirm = 'Confirm your new password.';
    else if (next && confirm !== next) next_errors.confirm = 'New passwords do not match.';
    if (Object.keys(next_errors).length) { setErrors(next_errors); return; }
    setErrors({});
    setSubmitting(true);
    try {
      const data = await jpost<{ otherSessionsCleared?: number }>('/api/change-password', {
        currentPassword: current, newPassword: next,
      });
      const cleared = data?.otherSessionsCleared || 0;
      const note = cleared > 0
        ? `Password updated. Signed out of ${cleared} other session${cleared === 1 ? '' : 's'}.`
        : 'Password updated.';
      showToast(note);
      resetFields();
      setOpen(false);
      setSuccess(note);
    } catch (err) {
      setErrors({ form: (err as Error).message || 'Could not change password.' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Card variant="outlined" sx={{ mb: 1.5 }}>
        <CardContent>
          <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            Password
          </Typography>
          {success && <Alert severity="success" sx={{ mb: 1.5 }}>{success}</Alert>}
          <Button variant="outlined" size="small" onClick={handleOpen} data-testid="change-password-btn">
            Change password
          </Button>
        </CardContent>
      </Card>

      <Dialog open={open} onClose={handleClose} maxWidth="xs" fullWidth>
        <DialogTitle>Change password</DialogTitle>
        <Box component="form" onSubmit={onSubmit} autoComplete="off">
          <DialogContent sx={{ pt: 1 }}>
            <Stack spacing={1.5}>
              <TextField
                label="Current password"
                type="password"
                size="small"
                fullWidth
                autoComplete="current-password"
                value={current}
                onChange={(e) => { setCurrent(e.target.value); if (errors.current) setErrors({ ...errors, current: undefined }); }}
                error={!!errors.current}
                helperText={errors.current || ' '}
              />
              <Box>
                <TextField
                  label="New password"
                  type="password"
                  size="small"
                  fullWidth
                  autoComplete="new-password"
                  value={next}
                  onChange={(e) => { setNext(e.target.value); if (errors.next) setErrors({ ...errors, next: undefined }); }}
                  error={!!errors.next}
                  helperText={errors.next || 'At least 8 characters, with letters and numbers.'}
                />
                <StrengthMeterErrorBoundary>
                  <StrengthMeter value={next} userInputs={userInputs} />
                </StrengthMeterErrorBoundary>
              </Box>
              <TextField
                label="Confirm new password"
                type="password"
                size="small"
                fullWidth
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => { setConfirm(e.target.value); if (errors.confirm) setErrors({ ...errors, confirm: undefined }); }}
                error={!!errors.confirm}
                helperText={errors.confirm || ' '}
              />
              {errors.form && <Alert severity="error">{errors.form}</Alert>}
              <Typography variant="caption" color="text.secondary">
                You'll be signed out of any other devices.
              </Typography>
            </Stack>
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button onClick={handleClose} disabled={submitting}>Cancel</Button>
            <Button type="submit" variant="contained" disabled={submitting}>
              {submitting ? 'Updating…' : 'Update password'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>
    </>
  );
}

export default ChangePasswordCard;
