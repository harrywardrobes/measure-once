import React, { useEffect, useState, lazy, Suspense } from 'react';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import Avatar from '@mui/material/Avatar';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CheckIcon from '@mui/icons-material/Check';
import SearchIcon from '@mui/icons-material/Search';
import PeopleAltIcon from '@mui/icons-material/PeopleAlt';
import ShieldIcon from '@mui/icons-material/Shield';
import AutoStoriesIcon from '@mui/icons-material/AutoStories';
import CloudOffIcon from '@mui/icons-material/CloudOff';
import type { CurrentUser } from '../hooks/useCurrentUser';
import { useAuth } from '../contexts/AuthContext';
import { usePrivilege } from '../hooks/usePrivilege';
import { usePrivilegeSync } from '../hooks/usePrivilegeSync';
import {
  useServiceStatuses,
  useConnectionToast,
  useOnlineStatus,
  openConnectModal,
  type ConnectionService,
  type ServiceStatus,
} from '../contexts/ConnectionToastContext';
import { SERVICE_DESCRIPTORS, SERVICE_KEYS, statusLabel, statusBadgeColor } from '../lib/connectionServices';
import { BRAND_COLORS } from '../theme';
import { getShortcut } from '../lib/getShortcut';
import {
  GlobalAppBar,
  GlobalToolbar,
  HeaderIconButton,
  SearchButton,
  SearchButtonLabel,
  ProfileButton,
  StatusBadgeRoot,
  StatusIconBox,
  StatusDotBadge,
  OfflinePillRoot,
  OfflinePillLabel,
  ProfileBadge,
} from './GlobalHeader.styles';

export type { CurrentUser as HeaderUser } from '../hooks/useCurrentUser';

const SyncPill = lazy(() => import('./SyncPill'));
const ConflictsReview = lazy(() => import('./ConflictsReview'));

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

// ── Service status badge ───────────────────────────────────────────────────────

interface ServiceStatusBadgeProps {
  service: ConnectionService;
  status: ServiceStatus;
  onClick?: () => void;
}

export function ServiceStatusBadge({ service, status, onClick }: ServiceStatusBadgeProps) {
  const { label, Icon } = SERVICE_DESCRIPTORS.find((d) => d.key === service)!;
  const badgeColor = statusBadgeColor(status);
  const tip = statusLabel(service, status);
  const isChecking = status === 'checking';
  const statusWord = status === 'error' ? 'disconnected' : status === 'warning' ? 'degraded' : status === 'checking' ? 'checking' : 'connected';
  const ariaLabel = `${label} status: ${statusWord}`;

  const iconColor =
    status === 'error'    ? '#fca5a5' : // hex-color-ok: status icon tint, no theme token
    status === 'warning'  ? '#fcd34d' : // hex-color-ok: status icon tint, no theme token
    status === 'ok'       ? '#86efac' : // hex-color-ok: status icon tint, no theme token
    'rgba(255,255,255,0.5)';

  const borderColor =
    status === 'error'   ? 'rgba(252,165,165,0.4)' :
    status === 'warning' ? 'rgba(252,211,77,0.4)'  :
    status === 'ok'      ? 'rgba(134,239,172,0.35)' :
    'rgba(255,255,255,0.12)';

  return (
    <Tooltip title={onClick ? `${tip} — click to manage connections` : tip}>
      <StatusBadgeRoot
        component={onClick ? 'button' : 'span'}
        onClick={onClick}
        aria-label={onClick ? `${ariaLabel} — manage service connections` : ariaLabel}
        clickable={!!onClick}
      >
        <StatusDotBadge
          variant="dot"
          overlap="circular"
          anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
          $isChecking={isChecking}
          $dotColor={badgeColor}
          $dotBorderColor={BRAND_COLORS.plum}
        >
          <StatusIconBox
            data-testid="service-status-icon"
            $iconColor={iconColor}
            $borderColor={borderColor}
          >
            <Icon fontSize="small" />
          </StatusIconBox>
        </StatusDotBadge>
      </StatusBadgeRoot>
    </Tooltip>
  );
}

// ── All-ok indicator ──────────────────────────────────────────────────────────

function AllOkIndicator() {
  return (
    <Tooltip title="All services connected — click to manage connections">
      <StatusIconBox
        component="button"
        onClick={() => openConnectModal()}
        aria-label="All services connected — manage service connections"
        $iconColor="#86efac" // hex-color-ok: matches 'ok' service icon tint
        $borderColor="rgba(134,239,172,0.35)"
        sx={{ cursor: 'pointer', border: 'none', background: 'transparent', p: 0 }}
      >
        <CheckIcon fontSize="small" />
      </StatusIconBox>
    </Tooltip>
  );
}

// ── Offline indicator ──────────────────────────────────────────────────────────

export function OfflinePill() {
  return (
    <Tooltip title="You're offline — showing saved data. Changes can't be sent until you reconnect.">
      <OfflinePillRoot
        component="span"
        role="status"
        aria-live="polite"
        aria-label="Offline — showing saved data"
        data-testid="offline-pill"
      >
        <CloudOffIcon fontSize="small" />
        <OfflinePillLabel>Offline</OfflinePillLabel>
      </OfflinePillRoot>
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
  const online = useOnlineStatus();

  usePrivilegeSync();

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

  const onBack = () => {
    if (window.history.length > 1) window.history.back();
    else window.location.href = '/';
  };

  const onSearch = () => {
    if (typeof window.openCommandPalette === 'function') window.openCommandPalette();
  };

  return (
    <GlobalAppBar data-testid="global-header" position="fixed" elevation={0}>
      <GlobalToolbar disableGutters>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1, minWidth: 0 }}>
          {showBack && (
            <Tooltip title="Back">
              <HeaderIconButton aria-label="Go back" onClick={onBack} size="small">
                <ArrowBackIcon fontSize="small" />
              </HeaderIconButton>
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
              src="/assets/logo-mark-header.png"
              alt="Harry Wardrobes"
              width={26}
              height={26}
              sx={{ height: 26, width: 26, display: 'block' }}
            />
          </Box>
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
          <Suspense fallback={null}>
            <SyncPill />
          </Suspense>
          <Suspense fallback={null}>
            <ConflictsReview />
          </Suspense>

          {!online ? (
            <Box sx={{ display: 'flex', alignItems: 'center', mr: 0.25 }}>
              <OfflinePill />
            </Box>
          ) : (() => {
            const failingServices = SERVICE_KEYS.filter((svc) => {
              const s = serviceStatuses.get(svc) ?? 'checking';
              return s === 'error' || s === 'warning';
            });
            return (
              <Box
                sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mr: 0.25 }}
                role="group"
                aria-label="Service status"
              >
                {failingServices.length === 0 ? (
                  <AllOkIndicator />
                ) : (
                  failingServices.map((svc) => (
                    <ServiceStatusBadge
                      key={svc}
                      service={svc}
                      status={serviceStatuses.get(svc) ?? 'checking'}
                      onClick={() => openConnectModal(svc)}
                    />
                  ))
                )}
              </Box>
            );
          })()}

          <Tooltip title={`Search (${kbdHint})`}>
            <SearchButton
              aria-label={`Search (${kbdHint})`}
              onClick={onSearch}
              size="small"
            >
              <SearchIcon fontSize="small" />
              <SearchButtonLabel aria-hidden="true">{kbdHint}</SearchButtonLabel>
            </SearchButton>
          </Tooltip>

          <Tooltip title="Customers">
            <HeaderIconButton
              component="a"
              href="/customers"
              aria-label="Customers"
              size="small"
              navActive={customersActive}
            >
              <PeopleAltIcon fontSize="small" />
            </HeaderIconButton>
          </Tooltip>

          {isAdmin && (
            <Tooltip title="Admin panel">
              <HeaderIconButton
                component="a"
                href="/admin"
                aria-label="Admin panel"
                size="small"
                navActive={adminActive}
              >
                <ShieldIcon fontSize="small" />
              </HeaderIconButton>
            </Tooltip>
          )}

          {isAdmin && (
            <Tooltip title="Design system">
              <HeaderIconButton
                component="a"
                href="/storybook/"
                aria-label="Design system"
                size="small"
                navActive={storybookActive}
              >
                <AutoStoriesIcon fontSize="small" />
              </HeaderIconButton>
            </Tooltip>
          )}

          {user && (
            <Tooltip title="Profile">
              <ProfileButton
                component="a"
                href="/profile"
                aria-label="Open profile"
                size="small"
                navActive={profileActive}
              >
                <ProfileBadge
                  color="error"
                  variant="dot"
                  invisible={!isAdmin || pendingCount <= 0}
                  overlap="circular"
                  anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
                >
                  {photoSrc ? (
                    <Avatar src={photoSrc} alt="" sx={{ width: 30, height: 30 }} />
                  ) : (
                    <Avatar
                      sx={{
                        width: 30,
                        height: 30,
                        bgcolor: 'transparent',
                        color: 'common.white',
                        fontSize: '0.7rem',
                        fontWeight: 700,
                        letterSpacing: '0.03em',
                      }}
                    >
                      {initials}
                    </Avatar>
                  )}
                </ProfileBadge>
              </ProfileButton>
            </Tooltip>
          )}
        </Box>
      </GlobalToolbar>
    </GlobalAppBar>
  );
}

export default GlobalHeader;
