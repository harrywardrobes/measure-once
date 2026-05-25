import React, { useEffect, useState } from 'react';
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Avatar from '@mui/material/Avatar';
import Badge from '@mui/material/Badge';
import Typography from '@mui/material/Typography';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import SearchIcon from '@mui/icons-material/Search';
import PeopleAltIcon from '@mui/icons-material/PeopleAlt';
import ShieldIcon from '@mui/icons-material/Shield';

type HeaderUser = {
  id?: string;
  first_name?: string;
  last_name?: string;
  has_custom_photo?: boolean;
  profile_image_url?: string | null;
  photo_v?: string | number;
  privilege_level?: string;
};

declare global {
  interface Window {
    openCommandPalette?: () => void;
    getShortcut?: (key: string) => string;
    PAGE_TITLES?: Record<string, string>;
    __moHeaderUser?: HeaderUser | null;
  }
}

function resolvePageTitle(path: string): string {
  const map = window.PAGE_TITLES || {};
  if (map[path]) return map[path];
  if (path.startsWith('/customers/')) return 'Customer';
  return 'Measure Once';
}

function resolvePhotoSrc(user: HeaderUser): string | null {
  if (!user) return null;
  let src = user.has_custom_photo && user.id
    ? `/api/users/${encodeURIComponent(user.id)}/photo`
    : (user.profile_image_url || null);
  if (src && user.photo_v) {
    src += (src.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(String(user.photo_v));
  }
  return src;
}

function resolveInitials(user: HeaderUser): string {
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

export function GlobalHeader() {
  const [path, setPath] = useState<string>(() => window.location.pathname);
  const [user, setUser] = useState<HeaderUser | null>(() => window.__moHeaderUser || null);
  const [pendingCount, setPendingCount] = useState<number>(0);

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

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<HeaderUser | null>).detail || null;
      setUser(detail);
    };
    window.addEventListener('mo:user', handler as EventListener);
    if (window.__moHeaderUser) setUser(window.__moHeaderUser);
    return () => window.removeEventListener('mo:user', handler as EventListener);
  }, []);

  const isAdmin = user?.privilege_level === 'admin';

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
  const pageTitle = resolvePageTitle(path);
  const kbdHint = window.getShortcut ? window.getShortcut('K') : 'Ctrl K';
  const customersActive = path === '/customers' || path.startsWith('/customers/');
  const adminActive = path === '/admin' || path.startsWith('/admin/');
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
    <AppBar
      position="fixed"
      elevation={0}
      sx={{
        bgcolor: '#200842',
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
          <Typography
            component="span"
            sx={{
              fontSize: '0.95rem',
              fontWeight: 700,
              color: '#fff',
              letterSpacing: '0.01em',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              minWidth: 0,
            }}
          >
            {pageTitle}
          </Typography>
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
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
                      border: '1.5px solid #200842',
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
