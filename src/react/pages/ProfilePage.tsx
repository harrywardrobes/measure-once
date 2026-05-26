import React from 'react';
import {
  Alert,
  Avatar,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  IconButton,
  Stack,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera';
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import LogoutIcon from '@mui/icons-material/Logout';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import { ChangePasswordCard } from '../components/ChangePasswordDialog';
import { usePrivilege } from '../hooks/usePrivilege';

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

export function ProfilePage(): React.ReactElement {
  // The React island mounts before core.js bootstrap() finishes populating
  // window.state.user. Seed from the global, listen for the `mo:user` event
  // bootstrap fires, AND as a last-resort fall back to fetching /api/auth/user
  // directly so this page never depends on event timing.
  const { isAdmin } = usePrivilege();
  const [appUser, setAppUser] = React.useState<AppUser | null>(() => getAppUser());
  const [profile, setProfile] = React.useState<Profile | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = React.useState(0);

  React.useEffect(() => {
    if (appUser) return;
    let cancelled = false;
    const onEvent = (e: Event) => {
      const detail = (e as CustomEvent<AppUser | null>).detail;
      if (cancelled) return;
      if (detail) setAppUser(detail);
      else {
        const u = getAppUser();
        if (u) setAppUser(u);
      }
    };
    window.addEventListener('mo:user', onEvent);
    // Fallback: if bootstrap already finished (or never runs on this page),
    // fetch /api/auth/user directly so we don't sit forever waiting.
    fetch('/api/auth/user', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((u: AppUser | null) => { if (!cancelled && u) setAppUser((prev) => prev || u); })
      .catch(() => { /* surfaced when profile fetch retries */ });
    return () => { cancelled = true; window.removeEventListener('mo:user', onEvent); };
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
        <Stack direction="row" spacing={1} sx={{  color: 'text.secondary', alignItems: 'center' }}>
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
          action={<Button size="small" color="inherit" onClick={() => setReloadNonce((n) => n + 1)}>Retry</Button>}
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
      <GoogleCalendarCard />
      <ChangePasswordCard profile={profile} />
      <AccountActionsCard isAdmin={isAdmin} />
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
        <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
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
        <Stack direction="row" sx={{  alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="body2" color="text.secondary">Job role</Typography>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {profile.job_role || '—'}
          </Typography>
        </Stack>
      </CardContent>
    </Card>
  );
}

// ── Google Calendar connection ─────────────────────────────────────────

type GoogleStatus = { connected: boolean; code?: string };

function GoogleCalendarCard() {
  const [status, setStatus] = React.useState<GoogleStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [disconnecting, setDisconnecting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch('/api/google/status', { headers: { Accept: 'application/json' } })
      .then((r) => r.json())
      .then((data: GoogleStatus) => { if (!cancelled) { setStatus(data); setLoading(false); } })
      .catch(() => { if (!cancelled) { setStatus(null); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  const onDisconnect = async () => {
    setDisconnecting(true);
    setError(null);
    try {
      const r = await fetch('/auth/logout-google', { method: 'POST', headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setStatus({ connected: false });
      showToast('Google Calendar disconnected');
    } catch (e) {
      setError((e as Error).message || 'Failed to disconnect');
    } finally {
      setDisconnecting(false);
    }
  };

  const connected = status?.connected === true;

  return (
    <Card variant="outlined" sx={{ mb: 1.5 }}>
      <CardContent>
        <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          Google Calendar
        </Typography>
        <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <CalendarMonthIcon sx={{ fontSize: 20, color: connected ? 'success.main' : 'text.disabled' }} />
            {loading ? (
              <Typography variant="body2" color="text.secondary">Checking status…</Typography>
            ) : (
              <Chip
                label={connected ? 'Connected' : 'Not connected'}
                size="small"
                color={connected ? 'success' : 'default'}
                variant={connected ? 'filled' : 'outlined'}
                sx={{ fontWeight: 600 }}
              />
            )}
          </Stack>
          {!loading && (
            connected ? (
              <Button
                size="small"
                variant="outlined"
                color="error"
                startIcon={<LinkOffIcon />}
                onClick={onDisconnect}
                disabled={disconnecting}
              >
                {disconnecting ? 'Disconnecting…' : 'Disconnect'}
              </Button>
            ) : (
              <Button
                size="small"
                variant="contained"
                startIcon={<CalendarMonthIcon />}
                href="/auth/google"
              >
                Connect Google Calendar
              </Button>
            )
          )}
        </Stack>
        {error && (
          <Alert severity="error" sx={{ mt: 1.5 }}>{error}</Alert>
        )}
        {!loading && !connected && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            Connect your Google account to sync upcoming events on the Home page.
          </Typography>
        )}
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
