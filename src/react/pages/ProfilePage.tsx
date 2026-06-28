import React from 'react';
import { SUCCESS_BANNER_HIDE_MS, REJECTION_BANNER_HIDE_MS } from '../constants/timings';
import {
  Alert,
  Avatar,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  LinearProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import HighlightOffIcon from '@mui/icons-material/HighlightOff';
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import LogoutIcon from '@mui/icons-material/Logout';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import { ChangePasswordCard } from '../components/ChangePasswordDialog';
import { Pill } from '../components/Pill';
import { usePrivilege } from '../hooks/usePrivilege';
import { usePageTitle } from '../hooks/usePageTitle';
import { clearOfflineData } from '../lib/registerServiceWorker';
import { USER_PHONE_DRAFT_PREFIX } from '../constants/localStorageKeys';

type Profile = {
  id: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  job_role?: string;
  phone?: string | null;
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
  if (r.status === 401) { throw new Error('Unauthorized'); }
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
  usePageTitle('Profile · Measure Once');
  // The React island mounts before core.js bootstrap() finishes. Seed from
  // getAppUser() (reads the global header user object), listen for the
  // `mo:user` event that bootstrap fires, AND as a last-resort fall back to
  // fetching /api/auth/user directly so this page never depends on event timing.
  const { isAdmin } = usePrivilege();
  const [appUser, setAppUser] = React.useState<AppUser | null>(() => getAppUser());
  const [profile, setProfile] = React.useState<Profile | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = React.useState(0);
  const [approvalSuccess, setApprovalSuccess] = React.useState(false);
  const [rejectionFeedback, setRejectionFeedback] = React.useState(false);
  const approvalTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const rejectionTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (approvalTimerRef.current) clearTimeout(approvalTimerRef.current);
      if (rejectionTimerRef.current) clearTimeout(rejectionTimerRef.current);
    };
  }, []);

  // Listen for admin photo-approval/rejection events so the profile page can
  // show brief feedback when an admin acts on the pending photo.
  React.useEffect(() => {
    if (!appUser) return;
    const handleApproval = () => {
      // Only trigger if the profile is currently showing a pending-photo state;
      // otherwise the event is for another user's photo and we can ignore it.
      setProfile((prev) => {
        if (prev?.has_pending_photo) {
          setApprovalSuccess(true);
          if (approvalTimerRef.current) clearTimeout(approvalTimerRef.current);
          approvalTimerRef.current = setTimeout(() => setApprovalSuccess(false), SUCCESS_BANNER_HIDE_MS);
          setReloadNonce((n) => n + 1);
        }
        return prev;
      });
    };
    const handleRejection = () => {
      setProfile((prev) => {
        if (prev?.has_pending_photo) {
          setRejectionFeedback(true);
          if (rejectionTimerRef.current) clearTimeout(rejectionTimerRef.current);
          rejectionTimerRef.current = setTimeout(() => setRejectionFeedback(false), REJECTION_BANNER_HIDE_MS);
          setReloadNonce((n) => n + 1);
        }
        return prev;
      });
    };

    const winHandler = (ev: Event) => {
      const kind = (ev as CustomEvent<{ kind: string }>).detail?.kind;
      if (kind === 'photos') handleApproval();
      if (kind === 'photos_rejected') handleRejection();
    };
    window.addEventListener('admin:change', winHandler);

    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel('admin_data_changed');
      bc.onmessage = (ev: MessageEvent) => {
        if (ev?.data?.kind === 'photos') handleApproval();
        if (ev?.data?.kind === 'photos_rejected') handleRejection();
      };
    } catch { /* BroadcastChannel not available */ }

    return () => {
      window.removeEventListener('admin:change', winHandler);
      bc?.close();
    };
  }, [appUser]);

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

      <IdentityCard profile={profile} appUser={appUser} onReload={reload} approvalSuccess={approvalSuccess} rejectionFeedback={rejectionFeedback} />
      <RoleCard profile={profile} />
      <EmailSignatureCard profile={profile} onPhoneSaved={reload} />
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
  approvalSuccess = false,
  rejectionFeedback = false,
}: {
  profile: Profile;
  appUser: AppUser;
  onReload: () => void;
  approvalSuccess?: boolean;
  rejectionFeedback?: boolean;
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
  const [uploadProgress, setUploadProgress] = React.useState<number | undefined>(undefined);
  const [photoSuccess, setPhotoSuccess] = React.useState(false);
  const successTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => { if (successTimerRef.current) clearTimeout(successTimerRef.current); };
  }, []);

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

  const onSubmitPhoto = () => {
    if (!pendingData) return;
    setSubmitting(true);
    setErrorMsg(null);
    setUploadProgress(0);
    const body = JSON.stringify({ data: pendingData });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/users/me/photo');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable) {
        setUploadProgress(Math.round((evt.loaded / evt.total) * 100));
      }
    };
    xhr.onload = () => {
      setUploadProgress(100);
      setSubmitting(false);
      setUploadProgress(undefined);
      if (xhr.status >= 400) {
        let msg = `HTTP ${xhr.status}`;
        try { msg = (JSON.parse(xhr.responseText) as { error?: string }).error || msg; } catch { /* ignore */ }
        setErrorMsg(msg);
      } else {
        setPendingData(null);
        if (fileRef.current) fileRef.current.value = '';
        setPhotoSuccess(true);
        if (successTimerRef.current) clearTimeout(successTimerRef.current);
        successTimerRef.current = setTimeout(() => setPhotoSuccess(false), SUCCESS_BANNER_HIDE_MS);
        showToast('Photo submitted for approval');
        onReload();
      }
    };
    xhr.onerror = () => {
      setSubmitting(false);
      setUploadProgress(undefined);
      setErrorMsg('Network error — please try again');
    };
    xhr.onabort = () => {
      setSubmitting(false);
      setUploadProgress(undefined);
      setErrorMsg('Upload cancelled');
    };
    xhr.send(body);
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
              sx={{
                width: 64, height: 64, bgcolor: 'primary.light', fontWeight: 700,
                outline: '3px solid',
                outlineColor: approvalSuccess ? 'success.main' : rejectionFeedback ? 'warning.main' : 'transparent',
                transition: 'outline-color 0.4s ease',
              }}
            >
              {initials}
            </Avatar>
            {!profile.has_pending_photo && (
              <>
                <IconButton
                  size="small"
                  onClick={() => { if (!photoSuccess) fileRef.current?.click(); }}
                  aria-label={profile.has_custom_photo ? 'Change photo' : 'Upload photo'}
                  sx={{
                    position: 'absolute', right: -4, bottom: -4,
                    bgcolor: photoSuccess ? 'success.main' : 'background.paper',
                    boxShadow: 1,
                    width: 26, height: 26,
                    transition: 'background-color 0.2s',
                    '&:hover': { bgcolor: photoSuccess ? 'success.dark' : 'background.paper' },
                  }}
                >
                  {photoSuccess
                    ? <CheckCircleIcon sx={{ fontSize: 14, color: 'common.white' }} />
                    : <PhotoCameraIcon sx={{ fontSize: 14 }} />}
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
              <Box sx={{ mt: 0.5 }}>
                <Pill variant="warn" label="Photo awaiting approval" />
              </Box>
            ) : rejectionFeedback ? (
              <Stack direction="row" spacing={0.5} sx={{ mt: 0.5, alignItems: 'center' }}>
                <HighlightOffIcon sx={{ fontSize: 15, color: 'warning.main', flexShrink: 0 }} />
                <Typography variant="caption" sx={{ color: 'warning.dark', fontWeight: 600 }}>
                  Photo not approved — please submit a new one
                </Typography>
              </Stack>
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
            {submitting && uploadProgress !== undefined && (
              <LinearProgress
                variant="determinate"
                value={uploadProgress}
                sx={{ mt: 1, borderRadius: 1 }}
              />
            )}
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

// ── Email signature ────────────────────────────────────────────────────

function EmailSignatureCard({
  profile,
  onPhoneSaved,
}: {
  profile: Profile;
  onPhoneSaved: () => void;
}) {
  const draftKey = `${USER_PHONE_DRAFT_PREFIX}${profile.id}`;
  const [phone, setPhone] = React.useState<string>(() => {
    try { return localStorage.getItem(draftKey) ?? (profile.phone || ''); } catch { return profile.phone || ''; }
  });
  const [saving, setSaving] = React.useState(false);
  const [success, setSuccess] = React.useState(false);
  const [error, setError]     = React.useState<string | null>(null);
  const [sig, setSig]         = React.useState<{ text: string; html: string } | null>(null);

  // Persist phone draft to localStorage while the user types.
  React.useEffect(() => {
    try { localStorage.setItem(draftKey, phone); } catch { /* ignore */ }
  }, [phone, draftKey]);

  // Fetch the current rendered signature for preview.
  React.useEffect(() => {
    fetch('/api/users/me/email-signature', { headers: { Accept: 'application/json' } })
      .then(r => r.ok ? r.json() : null)
      .then((data: { text: string; html: string } | null) => { if (data) setSig(data); })
      .catch(() => { /* non-critical */ });
  }, []);

  const isDirty = phone.trim() !== (profile.phone || '').trim();

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      const r = await fetch('/api/users/me/phone', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ phone: phone.trim() }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
      try { localStorage.removeItem(draftKey); } catch { /* ignore */ }
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
      onPhoneSaved();
      // Refresh the signature preview.
      fetch('/api/users/me/email-signature', { headers: { Accept: 'application/json' } })
        .then(r2 => r2.ok ? r2.json() : null)
        .then((d: { text: string; html: string } | null) => { if (d) setSig(d); })
        .catch(() => { /* ignore */ });
    } catch (e) {
      setError((e as Error).message || 'Could not save phone number.');
    } finally {
      setSaving(false);
    }
  }

  const sigLines = sig?.text.split('\n').filter(Boolean) ?? [];

  return (
    <Card variant="outlined" sx={{ mb: 1.5 }}>
      <CardContent>
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
          Email Signature
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
          Appended to customer emails you send. Your name, role, and email come from your profile.
        </Typography>

        <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start', mb: 1.5 }}>
          <TextField
            label="Phone"
            size="small"
            value={phone}
            onChange={e => setPhone(e.target.value)}
            disabled={saving}
            placeholder="e.g. 07900 123456"
            slotProps={{ htmlInput: { maxLength: 30 } }}
            sx={{ flex: 1 }}
          />
          <Button
            variant="contained"
            size="small"
            onClick={() => void handleSave()}
            disabled={saving || !isDirty}
            sx={{ mt: 0.25 }}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </Stack>

        {error   && <Alert severity="error"   sx={{ mb: 1, py: 0 }}>{error}</Alert>}
        {success && <Alert severity="success" sx={{ mb: 1, py: 0 }}>Phone number saved.</Alert>}

        {sigLines.length > 0 && (
          <>
            <Divider sx={{ mb: 1.5 }} />
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
              Preview:
            </Typography>
            <Box sx={{
              px: 1.5,
              py: 1,
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 1,
              bgcolor: 'grey.50',
            }}>
              {sigLines.map((line, i) => (
                <Typography key={i} variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.7 }}>
                  {line}
                </Typography>
              ))}
            </Box>
          </>
        )}
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
    <Card variant="outlined" sx={{ mb: 1.5 }} data-testid="gc-card">
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
                data-testid="gc-status-chip"
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
    const submit = () => {
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = '/api/logout';
      document.body.appendChild(form);
      form.submit();
    };
    // Clear cached offline data first so it doesn't persist for the next user
    // on a shared browser; submit regardless of success.
    clearOfflineData().finally(submit);
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
