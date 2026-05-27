import React, { useEffect, useState } from 'react';
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Avatar from '@mui/material/Avatar';
import Badge from '@mui/material/Badge';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import SearchIcon from '@mui/icons-material/Search';
import PeopleAltIcon from '@mui/icons-material/PeopleAlt';
import ShieldIcon from '@mui/icons-material/Shield';
import AutoStoriesIcon from '@mui/icons-material/AutoStories';
import SyncIcon from '@mui/icons-material/Sync';
import EventIcon from '@mui/icons-material/Event';
import ReceiptIcon from '@mui/icons-material/Receipt';
import StorageIcon from '@mui/icons-material/Storage';
import type { CurrentUser } from '../hooks/useCurrentUser';
import { useAuth } from '../contexts/AuthContext';
import { usePrivilege } from '../hooks/usePrivilege';
import { usePrivilegeSync } from '../hooks/usePrivilegeSync';
import { useServiceStatuses, useConnectionToast, type ConnectionService, type ServiceStatus } from '../context/ConnectionToastContext';
import { BRAND_COLORS } from '../theme';
import { getShortcut } from '../lib/getShortcut';

export type { CurrentUser as HeaderUser } from '../hooks/useCurrentUser';

declare global {
  interface Window {
    openCommandPalette?: () => void;
  }
}

function resolvePhotoSrc(user: CurrentUser): string | null {
  if (!user) return null;
  let src = user.has_custom_photo && user.id
    ? `/api/users/${encodeURIComponent(user.id)}/photo`
    : (user.profile_image_url || null);
  if (src && user.photo_v) {
    src += (src.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(String(user.photo_v));
  }
  return src;
}

function resolveInitials(user: CurrentUser): string {
  return [user?.first_name, user?.last_name]
    .filter(Boolean)
    .map((s) => (s as string)[0])
    .join('')
    .toUpperCase() || '?';
}

const ICON_BTN_SX = {
  width: 32,
  height: 32,
  borderRadius: '8px',
  color: 'rgba(255,255,255,0.7)',
  bgcolor: 'rgba(255,255,255,0.08)',
  border: '1px solid rgba(255,255,255,0.12)',
  '&:hover': { bgcolor: 'rgba(255,255,255,0.14)', color: '#fff' },
  '&:active': { bgcolor: 'rgba(255,255,255,0.2)' },
} as const;

const ICON_BTN_ACTIVE_SX = {
  bgcolor: 'rgba(255,255,255,0.18)',
  borderColor: 'rgba(255,255,255,0.35)',
  color: '#fff',
} as const;

// ── Service status icon config ─────────────────────────────────────────────────

const SERVICE_CONFIG: Record<ConnectionService, {
  label: string;
  Icon: React.ComponentType<{ fontSize?: 'small' | 'medium' }>;
}> = {
  hubspot:    { label: 'HubSpot',    Icon: SyncIcon },
  google:     { label: 'Google',     Icon: EventIcon },
  quickbooks: { label: 'QuickBooks', Icon: ReceiptIcon },
  database:   { label: 'Database',   Icon: StorageIcon },
};

const SERVICE_KEYS: ConnectionService[] = ['hubspot', 'google', 'quickbooks', 'database'];

function statusLabel(service: ConnectionService, status: ServiceStatus): string {
  const name = SERVICE_CONFIG[service].label;
  if (status === 'checking') return `Checking ${name} connection…`;
  if (status === 'error') return `${name} — disconnected`;
  if (status === 'warning') return `${name} — degraded`;
  return `${name} — connected`;
}

function statusBadgeColor(status: ServiceStatus): string {
  if (status === 'error') return '#ef4444';              // red-500
  if (status === 'warning') return '#f59e0b';            // amber-500
  if (status === 'ok') return '#22c55e';                 // green-500
  return 'rgba(255,255,255,0.35)';                       // checking — neutral grey
}

interface ServiceStatusBadgeProps {
  service: ConnectionService;
  status: ServiceStatus;
}

const CHECKING_PULSE_KEYFRAMES = {
  '@keyframes mo-status-pulse': {
    '0%, 100%': { opacity: 1 },
    '50%':      { opacity: 0.3 },
  },
};

function ServiceStatusBadge({ service, status }: ServiceStatusBadgeProps) {
  const { label, Icon } = SERVICE_CONFIG[service];
  const badgeColor = statusBadgeColor(status);
  const tip = statusLabel(service, status);
  const isChecking = status === 'checking';
  const statusWord = status === 'error' ? 'disconnected' : status === 'warning' ? 'degraded' : status === 'checking' ? 'checking' : 'connected';
  const ariaLabel = `${label} status: ${statusWord}`;

  const iconColor =
    status === 'error'    ? '#fca5a5' :
    status === 'warning'  ? '#fcd34d' :
    status === 'ok'       ? '#86efac' :
    'rgba(255,255,255,0.5)';

  const borderColor =
    status === 'error'   ? 'rgba(252,165,165,0.4)' :
    status === 'warning' ? 'rgba(252,211,77,0.4)'  :
    status === 'ok'      ? 'rgba(134,239,172,0.35)' :
    'rgba(255,255,255,0.12)';

  return (
    <Tooltip title={tip}>
      <Box
        component="span"
        aria-label={ariaLabel}
        sx={{ display: 'inline-flex', position: 'relative' }}
      >
        <Badge
          variant="dot"
          overlap="circular"
          anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
          sx={{
            ...CHECKING_PULSE_KEYFRAMES,
            '& .MuiBadge-dot': {
              backgroundColor: badgeColor,
              border: `1.5px solid ${BRAND_COLORS.plum}`,
              width: 8,
              height: 8,
              minWidth: 8,
              borderRadius: '50%',
              ...(isChecking && {
                animation: 'mo-status-pulse 1.4s ease-in-out infinite',
              }),
            },
          }}
        >
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              borderRadius: '8px',
              color: iconColor,
              bgcolor: 'rgba(255,255,255,0.08)',
              border: `1px solid ${borderColor}`,
            }}
          >
            <Icon fontSize="small" />
          </Box>
        </Badge>
      </Box>
    </Tooltip>
  );
}

// ── GlobalHeader ───────────────────────────────────────────────────────────────

export function GlobalHeader() {
  const [path, setPath] = useState<string>(() => window.location.pathname);
  const { user } = useAuth();
  const [pendingCount, setPendingCount] = useState<number>(0);
  const serviceStatuses = useServiceStatuses();
  const { checkServicesOnMount } = useConnectionToast();

  usePrivilegeSync();

  // Fire connection checks on every page, even when no page component calls useConnectionCheck.
  // The dedup/cooldown logic in ConnectionToastContext prevents double-firing.
  useEffect(() => {
    checkServicesOnMount().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onNav = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onNav);
    window.addEventListener('hashchange', onNav);
    window.addEventListener('mo:navigation', onNav as EventListener);
    return () => {
      window.removeEventListener('popstate', onNav);
      window.removeEventListener('hashchange', onNav);
      window.removeEventListener('mo:navigation', onNav as EventListener);
    };
  }, []);

  const { isAdmin } = usePrivilege();

  useEffect(() => {
    if (!isAdmin) { setPendingCount(0); return; }
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    const tick = () => {
      fetch('/api/admin/pending-count')
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => { if (!cancelled) setPendingCount(data?.count || 0); })
        .catch(() => {});
    };
    const start = () => {
      if (interval !== null) return;
      tick();
      interval = setInterval(tick, 60_000);
    };
    const stop = () => { if (interval !== null) { clearInterval(interval); interval = null; } };
    const onVis = () => { if (document.visibilityState === 'hidden') stop(); else start(); };
    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVis);
    return () => { cancelled = true; stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [isAdmin]);

  const showBack = path !== '/';
  const kbdHint = getShortcut('K');
  const customersActive = path === '/customers' || path.startsWith('/customers/');
  const adminActive = path === '/admin' || path.startsWith('/admin/');
  const storybookActive = path.startsWith('/storybook');
  const profileActive = path === '/profile' || path.startsWith('/profile/');
  const photoSrc = user ? resolvePhotoSrc(user) : null;
  const initials = user ? resolveInitials(user) : '';

  // All services are always shown; filter out 'database' which has no dedicated check endpoint
  const visibleServices = SERVICE_KEYS.filter((svc) => svc !== 'database');

  const onBack = () => {
    if (window.history.length > 1) window.history.back();
    else window.location.href = '/';
  };

  const onSearch = () => {
    if (typeof window.openCommandPalette === 'function') window.openCommandPalette();
  };

  return (
    <AppBar
      position="fixed"
      elevation={0}
      sx={{
        bgcolor: BRAND_COLORS.plum,
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        pt: 'env(safe-area-inset-top)',
        zIndex: (t) => t.zIndex.appBar,
      }}
    >
      <Toolbar
        disableGutters
        sx={{
          minHeight: 52,
          height: 52,
          px: 1.5,
          gap: 1,
          maxWidth: 640,
          width: '100%',
          mx: 'auto',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1, minWidth: 0 }}>
          {showBack && (
            <Tooltip title="Back">
              <IconButton aria-label="Go back" onClick={onBack} sx={ICON_BTN_SX} size="small">
                <ArrowBackIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          <Box
            component="a"
            href="/"
            title="Home"
            aria-label="Go to home"
            sx={{ display: 'flex', alignItems: 'center', textDecoration: 'none', flexShrink: 0 }}
          >
            <Box
              component="img"
              src="/assets/logo-mark-paper.png"
              alt="Harry Wardrobes"
              sx={{ height: 26, width: 'auto', display: 'block' }}
            />
          </Box>
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
          {/* Service status icons — always visible with checking/ok/error/warning states */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              mr: 0.25,
            }}
            role="group"
            aria-label="Service status"
          >
            {visibleServices.map((svc) => (
              <ServiceStatusBadge
                key={svc}
                service={svc}
                status={serviceStatuses.get(svc) ?? 'checking'}
              />
            ))}
          </Box>

          <Tooltip title={`Search (${kbdHint})`}>
            <IconButton
              aria-label={`Search (${kbdHint})`}
              onClick={onSearch}
              size="small"
              sx={{
                ...ICON_BTN_SX,
                width: 'auto',
                px: { xs: 0.75, sm: 1.125 },
                gap: 0.625,
              }}
            >
              <SearchIcon fontSize="small" />
              <Box
                component="span"
                aria-hidden="true"
                sx={{
                  display: { xs: 'none', sm: 'inline' },
                  fontSize: 11,
                  fontWeight: 500,
                  opacity: 0.65,
                  letterSpacing: '0.03em',
                  lineHeight: 1,
                }}
              >
                {kbdHint}
              </Box>
            </IconButton>
          </Tooltip>

          <Tooltip title="Customers">
            <IconButton
              component="a"
              href="/customers"
              aria-label="Customers"
              size="small"
              sx={{ ...ICON_BTN_SX, ...(customersActive ? ICON_BTN_ACTIVE_SX : {}) }}
            >
              <PeopleAltIcon fontSize="small" />
            </IconButton>
          </Tooltip>

          {isAdmin && (
            <Tooltip title="Admin panel">
              <IconButton
                component="a"
                href="/admin"
                aria-label="Admin panel"
                size="small"
                sx={{ ...ICON_BTN_SX, ...(adminActive ? ICON_BTN_ACTIVE_SX : {}) }}
              >
                <ShieldIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}

          {isAdmin && (
            <Tooltip title="Design system">
              <IconButton
                component="a"
                href="/storybook/"
                aria-label="Design system"
                size="small"
                sx={{ ...ICON_BTN_SX, ...(storybookActive ? ICON_BTN_ACTIVE_SX : {}) }}
              >
                <AutoStoriesIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}

          {user && (
            <Tooltip title="Profile">
              <IconButton
                component="a"
                href="/profile"
                aria-label="Open profile"
                size="small"
                sx={{
                  p: 0,
                  width: 30,
                  height: 30,
                  bgcolor: 'rgba(255,255,255,0.15)',
                  '&:hover': { bgcolor: 'rgba(255,255,255,0.25)' },
                  ...(profileActive ? { outline: '2px solid rgba(255,255,255,0.35)' } : {}),
                }}
              >
                <Badge
                  color="error"
                  variant="dot"
                  invisible={!isAdmin || pendingCount <= 0}
                  overlap="circular"
                  anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
                  sx={{
                    '& .MuiBadge-dot': {
                      border: `1.5px solid ${BRAND_COLORS.plum}`,
                      width: 8,
                      height: 8,
                      minWidth: 8,
                      borderRadius: '50%',
                    },
                  }}
                >
                  {photoSrc ? (
                    <Avatar
                      src={photoSrc}
                      alt=""
                      sx={{ width: 30, height: 30 }}
                    />
                  ) : (
                    <Avatar
                      sx={{
                        width: 30,
                        height: 30,
                        bgcolor: 'transparent',
                        color: '#fff',
                        fontSize: '0.7rem',
                        fontWeight: 700,
                        letterSpacing: '0.03em',
                      }}
                    >
                      {initials}
                    </Avatar>
                  )}
                </Badge>
              </IconButton>
            </Tooltip>
          )}
        </Box>
      </Toolbar>
    </AppBar>
  );
}

export default GlobalHeader;
