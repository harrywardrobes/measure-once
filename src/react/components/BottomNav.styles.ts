import type { ElementType } from 'react';
import { styled } from '@mui/material/styles';
import Box from '@mui/material/Box';
import BottomNavigation from '@mui/material/BottomNavigation';
import BottomNavigationAction from '@mui/material/BottomNavigationAction';
import Drawer from '@mui/material/Drawer';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import ListItemIcon from '@mui/material/ListItemIcon';

export const NAV_HEIGHT = 56;
export const ITEM_WIDTH = 80;

// ── Bottom bar ─────────────────────────────────────────────────────────────────

export const NavBar = styled(Box)<{ component?: ElementType }>(({ theme }) => ({
  position: 'fixed',
  bottom: 0,
  left: 0,
  right: 0,
  backgroundColor: theme.palette.background.paper,
  borderTop: `1px solid ${theme.palette.divider}`,
  zIndex: theme.zIndex.appBar,
  paddingBottom: 'env(safe-area-inset-bottom)',
  display: 'flex',
  justifyContent: 'center',
  overflowY: 'hidden',
}));

// Inner navigation element, centered and capped at 640 px on wide screens.
export const NavBottomNavigation = styled(BottomNavigation)(({ theme }) => ({
  width: '100%',
  height: NAV_HEIGHT,
  backgroundColor: 'transparent',
  [theme.breakpoints.up('sm')]: {
    maxWidth: 640,
  },
}));

// Individual tab action. `$accent` drives the selected-state colour per item.
export const NavAction = styled(BottomNavigationAction, {
  shouldForwardProp: (prop) => prop !== '$accent',
})<{ $accent: string; component?: ElementType; href?: string }>(({ $accent, theme }) => ({
  color: theme.palette.text.secondary,
  padding: '0 4px',
  flex: '0 0 auto',
  minWidth: ITEM_WIDTH,
  maxWidth: ITEM_WIDTH,
  '& .MuiBottomNavigationAction-label': {
    fontWeight: 600,
    letterSpacing: '0.02em',
    textTransform: 'uppercase',
    fontSize: '0.65rem',
    [theme.breakpoints.up('sm')]: {
      fontSize: '0.7rem',
    },
  },
  '& .MuiBottomNavigationAction-label.Mui-selected': {
    fontSize: '0.65rem',
    [theme.breakpoints.up('sm')]: {
      fontSize: '0.7rem',
    },
  },
  '&.Mui-selected': {
    color: $accent,
    borderTop: '2px solid',
    borderTopColor: $accent,
    paddingTop: 'calc(6px - 2px)',
  },
}));

// ── Overflow drawer ────────────────────────────────────────────────────────────

export const NavDrawer = styled(Drawer)(({ theme }) => ({
  zIndex: theme.zIndex.appBar + 1,
  '& .MuiDrawer-paper': {
    borderTopLeftRadius: 3,
    borderTopRightRadius: 3,
    paddingBottom: 'env(safe-area-inset-bottom)',
  },
}));

// Pill at the top of the drawer that signals it can be dismissed.
export const DrawerHandle = styled(Box)(({ theme }) => ({
  width: 40,
  height: 4,
  borderRadius: 999,
  backgroundColor: theme.palette.divider,
}));

export const DrawerHandleContainer = styled(Box)({
  width: '100%',
  display: 'flex',
  justifyContent: 'center',
  paddingTop: 8,
  paddingBottom: 4,
});

// Shared padding for all rows in the overflow drawer.
export const NavListItemButton = styled(ListItemButton)({
  paddingTop: 12,
  paddingBottom: 12,
  paddingLeft: 20,
  paddingRight: 20,
});

// Extends NavListItemButton with per-item selected-state colour (`$accent`).
export const OverflowListItem = styled(NavListItemButton, {
  shouldForwardProp: (prop) => prop !== '$accent',
})<{ $accent: string; component?: ElementType; href?: string }>(({ $accent }) => ({
  '&.Mui-selected': {
    backgroundColor: 'transparent',
    color: $accent,
  },
  '&.Mui-selected .MuiListItemIcon-root': {
    color: $accent,
  },
  '&.Mui-selected .MuiListItemText-primary': {
    color: $accent,
    fontWeight: 700,
  },
}));

// Shared text style for overflow rows and the customise button.
export const NavListItemText = styled(ListItemText)(({ theme }) => ({
  '& .MuiListItemText-primary': {
    fontWeight: 600,
    fontSize: '0.95rem',
    letterSpacing: '0.02em',
    textTransform: 'uppercase',
    color: theme.palette.text.secondary,
  },
}));

export const NavListItemIcon = styled(ListItemIcon)(({ theme }) => ({
  minWidth: 40,
  color: theme.palette.text.secondary,
}));

// ── Loading skeleton ───────────────────────────────────────────────────────────

// Fixed-height container shown while auth/config loads.
export const SkeletonContainer = styled(Box)(({ theme }) => ({
  width: '100%',
  height: NAV_HEIGHT,
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  [theme.breakpoints.up('sm')]: {
    maxWidth: 640,
  },
}));

export const SkeletonItem = styled(Box)({
  flex: '0 0 auto',
  width: ITEM_WIDTH,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 6,
});

export const SkeletonIcon = styled(Box)(({ theme }) => ({
  width: 24,
  height: 24,
  borderRadius: '50%',
  backgroundColor: theme.palette.divider,
  opacity: 0.6,
}));

export const SkeletonLabel = styled(Box)(({ theme }) => ({
  width: 40,
  height: 8,
  borderRadius: 1,
  backgroundColor: theme.palette.divider,
  opacity: 0.6,
}));
