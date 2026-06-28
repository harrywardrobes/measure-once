import type { ElementType } from 'react';
import { styled } from '@mui/material/styles';
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import IconButton from '@mui/material/IconButton';
import Badge from '@mui/material/Badge';
import Box from '@mui/material/Box';
import { BRAND_COLORS, SYNC_COLORS } from '../theme';

// ── App bar & toolbar ──────────────────────────────────────────────────────────

export const GlobalAppBar = styled(AppBar)({
  backgroundColor: BRAND_COLORS.plum,
  borderBottom: '1px solid rgba(255,255,255,0.08)',
  paddingTop: 'env(safe-area-inset-top)',
});

export const GlobalToolbar = styled(Toolbar)(({ theme }) => ({
  minHeight: 52,
  height: 52,
  paddingLeft: theme.spacing(1.5),
  paddingRight: theme.spacing(1.5),
  gap: theme.spacing(1),
  maxWidth: 640,
  width: '100%',
  marginLeft: 'auto',
  marginRight: 'auto',
}));

// ── Icon buttons ───────────────────────────────────────────────────────────────

// Base for all icon buttons in the header. `navActive` drives the
// current-page highlight state without touching the DOM.
export const HeaderIconButton = styled(IconButton, {
  shouldForwardProp: (prop) => prop !== 'navActive',
})<{ navActive?: boolean; component?: ElementType; href?: string }>(({ navActive }) => ({
  width: 32,
  height: 32,
  borderRadius: 2,
  color: navActive ? '#ffffff' : 'rgba(255,255,255,0.7)',
  backgroundColor: navActive ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.08)',
  border: `1px solid ${navActive ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.12)'}`,
  '&:hover': { backgroundColor: 'rgba(255,255,255,0.14)', color: '#ffffff' },
  '&:active': { backgroundColor: 'rgba(255,255,255,0.2)' },
}));

// Wider variant that shows a keyboard-shortcut label on larger screens.
export const SearchButton = styled(HeaderIconButton)(({ theme }) => ({
  width: 'auto',
  paddingLeft: theme.spacing(0.75),
  paddingRight: theme.spacing(0.75),
  gap: theme.spacing(0.625),
  [theme.breakpoints.up('sm')]: {
    paddingLeft: theme.spacing(1.125),
    paddingRight: theme.spacing(1.125),
  },
}));

export const SearchButtonLabel = styled('span')(({ theme }) => ({
  display: 'none',
  fontSize: 11,
  fontWeight: 500,
  opacity: 0.65,
  letterSpacing: '0.03em',
  lineHeight: 1,
  [theme.breakpoints.up('sm')]: {
    display: 'inline',
  },
}));

// Profile avatar button — circular, no border, active state uses an outline.
export const ProfileButton = styled(IconButton, {
  shouldForwardProp: (prop) => prop !== 'navActive',
})<{ navActive?: boolean; component?: ElementType; href?: string }>(({ navActive }) => ({
  padding: 0,
  width: 30,
  height: 30,
  backgroundColor: 'rgba(255,255,255,0.15)',
  '&:hover': { backgroundColor: 'rgba(255,255,255,0.25)' },
  ...(navActive ? { outline: '2px solid rgba(255,255,255,0.35)' } : {}),
}));

// ── Service status badges ──────────────────────────────────────────────────────

// Outer wrapper — rendered as a <button> when clickable, <span> otherwise.
// `clickable` controls cursor and focus ring; not forwarded to the DOM.
export const StatusBadgeRoot = styled(Box, {
  shouldForwardProp: (prop) => prop !== 'clickable',
})<{ clickable?: boolean; component?: ElementType }>(({ clickable }) => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  position: 'relative',
  background: 'none',
  border: 'none',
  padding: 0,
  borderRadius: 2,
  cursor: clickable ? 'pointer' : 'default',
  ...(clickable
    ? {
        '&:focus-visible': {
          outline: '2px solid rgba(255,255,255,0.5)',
          outlineOffset: 2,
        },
      }
    : {}),
}));

// Icon tile inside the badge. Colors are status-dependent (transient props).
export const StatusIconBox = styled(Box, {
  shouldForwardProp: (prop) => prop !== '$iconColor' && prop !== '$borderColor',
})<{ $iconColor: string; $borderColor: string; component?: ElementType }>(({ $iconColor, $borderColor }) => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  borderRadius: 2,
  color: $iconColor,
  backgroundColor: 'rgba(255,255,255,0.08)',
  border: `1px solid ${$borderColor}`,
}));

// Badge with an animated dot. $isChecking triggers the pulse; $dotColor
// and $dotBorderColor set the dot appearance. All are transient props.
export const StatusDotBadge = styled(Badge, {
  shouldForwardProp: (prop) =>
    prop !== '$isChecking' && prop !== '$dotColor' && prop !== '$dotBorderColor',
})<{ $isChecking?: boolean; $dotColor: string; $dotBorderColor: string }>(
  ({ $isChecking, $dotColor, $dotBorderColor }) => ({
    '@keyframes mo-status-pulse': {
      '0%, 100%': { opacity: 1 },
      '50%': { opacity: 0.3 },
    },
    '& .MuiBadge-dot': {
      backgroundColor: $dotColor,
      border: `1.5px solid ${$dotBorderColor}`,
      width: 8,
      height: 8,
      minWidth: 8,
      borderRadius: '50%',
      ...($isChecking ? { animation: 'mo-status-pulse 1.4s ease-in-out infinite' } : {}),
    },
  }),
);

// ── Offline pill ───────────────────────────────────────────────────────────────

export const OfflinePillRoot = styled(Box)<{ component?: ElementType }>({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  height: 28,
  paddingLeft: 8,
  paddingRight: 8,
  borderRadius: 2,
  color: SYNC_COLORS.pending.color,
  backgroundColor: SYNC_COLORS.pending.bg,
  border: `1px solid ${SYNC_COLORS.pending.border}`,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.03em',
  lineHeight: 1,
  whiteSpace: 'nowrap',
});

export const OfflinePillLabel = styled('span')(({ theme }) => ({
  display: 'none',
  [theme.breakpoints.up('sm')]: {
    display: 'inline',
  },
}));

// ── Profile badge ──────────────────────────────────────────────────────────────

// Badge on the profile avatar that shows the pending-access-request dot.
export const ProfileBadge = styled(Badge)({
  '& .MuiBadge-dot': {
    border: `1.5px solid ${BRAND_COLORS.plum}`,
    width: 8,
    height: 8,
    minWidth: 8,
    borderRadius: '50%',
  },
});
