import React from 'react';
import {
  Alert,
  Avatar,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  IconButton,
  LinearProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera';
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import LogoutIcon from '@mui/icons-material/Logout';
import zxcvbn from 'zxcvbn';

type Profile = {
  id: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  job_role?: string;
  has_custom_photo?: boolean;
  has_pending_photo?: boolean;
  profile_image_url?: string | null;
};

type AppUser = {
  id: string;
  privilege_level?: string;
  photo_v?: string | number;
};

const MIN_SCORE = 2;
const MAX_LENGTH = 200;
const STRENGTH_LABELS = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'];
const STRENGTH_COLORS: Array<'error' | 'warning' | 'info' | 'success'> = [
  'error', 'warning', 'warning', 'success', 'success',
];

function getAppUser(): AppUser | null {
  const w = window as unknown as { state?: { user?: AppUser } };
  return w.state?.user || null;
}

function showToast(msg: string, isError = false) {
  const w = window as unknown as { showToast?: (m: string, e?: boolean) => void };
  if (typeof w.showToast === 'function') w.showToast(msg, isError);
}

async function jget<T>(path: string): Promise<T> {
  const r = await fetch(path, { headers: { Accept: 'application/json' } });
  if (r.status === 401) { location.href = '/login'; throw new Error('Unauthorized'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return data as T;
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

function checkPasswordPolicy(pw: string, userInputs: string[]): string | null {
  if (!pw) return 'Password is required.';
  if (pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > MAX_LENGTH) return 'Password is too long.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) {
    return 'Password must contain both letters and numbers.';
  }
  const r = zxcvbn(pw.slice(0, MAX_LENGTH), userInputs);
  if (r.score < MIN_SCORE) {
    const warning = r.feedback?.warning;
    return warning
      ? 'Password is too easy to guess: ' + warning
      : 'Password is too easy to guess — please choose something less common.';
  }
  return null;
}

export function ProfilePage(): React.ReactElement {
  // bootstrap() in core.js populates window.state.user asynchronously and fires
  // `mo:user` on every change. The React island mounts before bootstrap finishes,
  // so seed from window.state.user and re-read on each mo:user event.
  const [appUser, setAppUser] = React.useState<AppUser | null>(() => getAppUser());
  const [profile, setProfile] = React.useState<Profile | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = React.useState(0);

  React.useEffect(() => {
    const refresh = () => setAppUser(getAppUser());
    window.addEventListener('mo:user', refresh);
    if (!appUser) refresh();
    return () => window.removeEventListener('mo:user', refresh);
  }, [appUser]);

  React.useEffect(() => {
    if (!appUser) return;
    let cancelled = false;
    setLoading(true); setError(null);
    jget<Profile>(`/api/users/${encodeURIComponent(appUser.id)}/profile`)
      .then((p) => { if (!cancelled) { setProfile(p); setLoading(false); } })
      .catch((e: Error) => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [appUser, reloadNonce]);

  const onBack = () => {
    if (history.length > 1) history.back();
    else location.href = '/';
  };

  if (!appUser) return <Box />;

  if (loading) {
    return (
      <Box sx={{ maxWidth: 720, mx: 'auto', px: 2, py: 3 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ color: 'text.secondary' }}>
          <CircularProgress size={16} />
          <Typography variant="body2">Loading…</Typography>
        </Stack>
      </Box>
    );
  }

  if (error || !profile) {
    return (
      <Box sx={{ maxWidth: 720, mx: 'auto', px: 2, py: 3 }}>
        <Alert
          severity="error"
          action={<Button size="small" onClick={() => setReloadNonce((n) => n + 1)}>Retry</Button>}
        >
          Failed to load profile.
        </Alert>
      </Box>
    );
  }

  const reload = () => setReloadNonce((n) => n + 1);

  return (
    <Box sx={{ maxWidth: 720, mx: 'auto', px: { xs: 1.5, sm: 2 }, py: 2 }}>
      <Button
        onClick={onBack}
        startIcon={<ArrowBackIcon />}
        size="small"
        sx={{ mb: 1.5, color: 'text.secondary' }}
      >
        Back
      </Button>

      <IdentityCard profile={profile} appUser={appUser} onReload={reload} />
      <RoleCard profile={profile} />
      <ChangePasswordCard profile={profile} />
      <AccountActionsCard isAdmin={appUser.privilege_level === 'admin'} />
    </Box>
  );
}

// ── Identity / photo upload ────────────────────────────────────────────

function buildPhotoSrc(profile: Profile, appUser: AppUser): string | null {
  let src = profile.has_custom_photo
    ? `/api/users/${encodeURIComponent(profile.id)}/photo`
    : (profile.profile_image_url || null);
  if (src && appUser.photo_v && profile.id === appUser.id) {
    src += (src.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(String(appUser.photo_v));
  }
  return src;
}

function IdentityCard({
  profile,
  appUser,
  onReload,
}: {
  profile: Profile;
  appUser: AppUser;
  onReload: () => void;
}) {
  const fullName = [profile.first_name, profile.last_name].filter(Boolean).join(' ')
    || profile.email || 'User';
  const initials = [profile.first_name, profile.last_name]
    .filter(Boolean).map((s) => s![0]).join('').toUpperCase() || '?';

  const photoSrc = buildPhotoSrc(profile, appUser);

  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const [pendingData, setPendingData] = React.useState<string | null>(null);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const onFile = (file: File) => {
    setErrorMsg(null);
    if (!file.type.startsWith('image/')) {
      setErrorMsg('Please select an image file (JPEG, PNG, or WebP).');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const MAX = 600;
        let w = img.width, h = img.height;
        if (w > MAX || h > MAX) {
          if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
          else       { w = Math.round(w * MAX / h); h = MAX; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
        setPendingData(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = String(e.target?.result || '');
    };
    reader.readAsDataURL(file);
  };

  const onSubmitPhoto = async () => {
    if (!pendingData) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      await jpost('/api/users/me/photo', { data: pendingData });
      setPendingData(null);
      showToast('Photo submitted for approval');
      onReload();
    } catch (e) {
      setErrorMsg((e as Error).message || 'Upload failed');
    } finally {
      setSubmitting(false);
    }
  };

  const onCancel = () => {
    setPendingData(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <Card variant="outlined" sx={{ mb: 1.5 }}>
      <CardContent>
        <Stack direction="row" spacing={2} alignItems="center">
          <Box sx={{ position: 'relative' }}>
            <Avatar
              src={photoSrc || undefined}
              sx={{ width: 64, height: 64, bgcolor: 'primary.light', fontWeight: 700 }}
            >
              {initials}
            </Avatar>
            {!profile.has_pending_photo && (
              <>
                <IconButton
                  size="small"
                  onClick={() => fileRef.current?.click()}
                  aria-label={profile.has_custom_photo ? 'Change photo' : 'Upload photo'}
                  sx={{
                    position: 'absolute', right: -4, bottom: -4,
                    bgcolor: 'background.paper', boxShadow: 1,
                    width: 26, height: 26,
                    '&:hover': { bgcolor: 'background.paper' },
                  }}
                >
                  <PhotoCameraIcon sx={{ fontSize: 14 }} />
                </IconButton>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  hidden
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
                />
              </>
            )}
          </Box>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="h6" sx={{ fontWeight: 700 }} noWrap>{fullName}</Typography>
            <Typography variant="body2" color="text.secondary" noWrap>{profile.email || ''}</Typography>
            {profile.has_pending_photo ? (
              <Typography
                variant="caption"
                sx={{
                  display: 'inline-block', mt: 0.5, px: 1, py: 0.25,
                  bgcolor: 'warning.light', color: 'warning.dark',
                  borderRadius: 999, fontWeight: 600,
                }}
              >
                Photo awaiting approval
              </Typography>
            ) : !photoSrc ? (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                Upload a professional photo with a plain background
              </Typography>
            ) : null}
          </Box>
        </Stack>

        {pendingData && (
          <Box sx={{ mt: 2, p: 1.5, bgcolor: 'action.hover', borderRadius: 1 }}>
            <Box
              component="img"
              src={pendingData}
              alt="Preview"
              sx={{ width: 96, height: 96, borderRadius: '50%', objectFit: 'cover', display: 'block', mb: 1.5 }}
            />
            <Stack direction="row" spacing={1}>
              <Button
                variant="contained"
                size="small"
                onClick={onSubmitPhoto}
                disabled={submitting}
              >
                {submitting ? 'Uploading…' : 'Submit for approval'}
              </Button>
              <Button variant="outlined" size="small" onClick={onCancel} disabled={submitting}>
                Cancel
              </Button>
            </Stack>
          </Box>
        )}

        {errorMsg && (
          <Alert severity="error" sx={{ mt: 1.5 }}>{errorMsg}</Alert>
        )}
      </CardContent>
    </Card>
  );
}

// ── Role & Permissions ─────────────────────────────────────────────────

function RoleCard({ profile }: { profile: Profile }) {
  return (
    <Card variant="outlined" sx={{ mb: 1.5 }}>
      <CardContent>
        <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          Role &amp; Permissions
        </Typography>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="body2" color="text.secondary">Job role</Typography>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {profile.job_role || '—'}
          </Typography>
        </Stack>
      </CardContent>
    </Card>
  );
}

// ── Change password ────────────────────────────────────────────────────

function StrengthMeter({ value, userInputs }: { value: string; userInputs: string[] }) {
  if (!value) return null;
  const r = zxcvbn(value.slice(0, MAX_LENGTH), userInputs);
  const score = r.score as 0 | 1 | 2 | 3 | 4;
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
      <Stack direction="row" justifyContent="space-between" sx={{ mt: 0.5 }}>
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

function ChangePasswordCard({ profile }: { profile: Profile }) {
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

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSuccess(null);
    const next_errors: typeof errors = {};
    if (!current) next_errors.current = 'Enter your current password.';
    if (!next) next_errors.next = 'Enter a new password.';
    else if (current && next === current) next_errors.next = 'New password must be different from your current password.';
    else {
      const policyErr = checkPasswordPolicy(next, userInputs);
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
      setCurrent(''); setNext(''); setConfirm('');
      const cleared = data?.otherSessionsCleared || 0;
      const note = cleared > 0
        ? `Password updated. Signed out of ${cleared} other session${cleared === 1 ? '' : 's'}.`
        : 'Password updated.';
      showToast(note);
      setSuccess(note);
    } catch (err) {
      setErrors({ form: (err as Error).message || 'Could not change password.' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card variant="outlined" sx={{ mb: 1.5 }}>
      <CardContent>
        <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
          Change password
        </Typography>
        <Box component="form" onSubmit={onSubmit} autoComplete="off">
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
              <StrengthMeter value={next} userInputs={userInputs} />
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
            {success && <Alert severity="success">{success}</Alert>}
            <Box>
              <Button type="submit" variant="contained" disabled={submitting}>
                {submitting ? 'Updating…' : 'Update password'}
              </Button>
            </Box>
            <Typography variant="caption" color="text.secondary">
              You'll be signed out of any other devices.
            </Typography>
          </Stack>
        </Box>
      </CardContent>
    </Card>
  );
}

// ── Account actions ────────────────────────────────────────────────────

function AccountActionsCard({ isAdmin }: { isAdmin: boolean }) {
  const onSignOut = () => {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/api/logout';
    document.body.appendChild(form);
    form.submit();
  };

  const rowSx = {
    width: '100%',
    justifyContent: 'flex-start',
    px: 2, py: 1.5,
    color: 'text.primary',
    borderRadius: 0,
    '&:not(:last-of-type)': { borderBottom: '1px solid', borderColor: 'divider' },
  };

  return (
    <Card variant="outlined" sx={{ mb: 1.5 }}>
      <Stack>
        {isAdmin && (
          <Button
            href="/admin"
            startIcon={<AdminPanelSettingsIcon />}
            sx={rowSx}
          >
            Admin panel
          </Button>
        )}
        <Button
          onClick={onSignOut}
          startIcon={<LogoutIcon />}
          sx={{ ...rowSx, color: 'error.main' }}
        >
          Sign out
        </Button>
      </Stack>
    </Card>
  );
}

export default ProfilePage;
