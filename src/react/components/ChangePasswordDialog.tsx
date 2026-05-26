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
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  loadZxcvbn,
  checkPasswordPolicy,
  StrengthMeter,
  StrengthMeterErrorBoundary,
} from '../utils/passwordStrength';

type Profile = {
  email?: string;
  first_name?: string;
  last_name?: string;
};

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

export function ChangePasswordCard({ profile }: { profile: Profile }) {
  const [open, setOpen] = React.useState(false);
  const [openNonce, setOpenNonce] = React.useState(0);
  const [current, setCurrent] = React.useState('');
  const [next, setNext] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [errors, setErrors] = React.useState<{ current?: string; next?: string; confirm?: string; form?: string }>({});
  const [success, setSuccess] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const userInputs = React.useMemo(() => {
    const email = String(profile.email ?? '').toLowerCase();
    const local = email.split('@')[0] || '';
    return [email, local, String(profile.first_name ?? ''), String(profile.last_name ?? ''),
            'measure once', 'measureonce'].filter((s): s is string => typeof s === 'string' && s.length > 0);
  }, [profile.email, profile.first_name, profile.last_name]);

  React.useEffect(() => {
    if (open) loadZxcvbn();
  }, [open]);

  const resetFields = () => {
    setCurrent(''); setNext(''); setConfirm(''); setErrors({});
  };

  const handleOpen = () => { setSuccess(null); resetFields(); setOpenNonce((n) => n + 1); setOpen(true); };
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
                <StrengthMeterErrorBoundary key={openNonce}>
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
