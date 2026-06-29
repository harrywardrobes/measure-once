import { useCallback, useEffect, useRef, useState } from 'react';
import { usePrivilege } from '../hooks/usePrivilege';
import { usePrefs } from '../hooks/usePrefs';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import List from '@mui/material/List';
import { useTheme } from '@mui/material/styles';
import TuneIcon from '@mui/icons-material/Tune';
import HomeIcon from '@mui/icons-material/Home';
import { NavCustomiseDialog } from './NavCustomiseDialog';
import HomeOutlinedIcon from '@mui/icons-material/HomeOutlined';
import SquareFootIcon from '@mui/icons-material/SquareFoot';
import SquareFootOutlinedIcon from '@mui/icons-material/SquareFootOutlined';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined';
import PeopleAltIcon from '@mui/icons-material/PeopleAlt';
import PeopleAltOutlinedIcon from '@mui/icons-material/PeopleAltOutlined';
import AssignmentIcon from '@mui/icons-material/Assignment';
import AssignmentOutlinedIcon from '@mui/icons-material/AssignmentOutlined';
import DesignServicesIcon from '@mui/icons-material/DesignServices';
import DesignServicesOutlinedIcon from '@mui/icons-material/DesignServicesOutlined';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import {
  NAV_HEIGHT,
  ITEM_WIDTH,
  NavBar,
  NavBottomNavigation,
  NavAction,
  NavDrawer,
  DrawerHandle,
  DrawerHandleContainer,
  NavListItemButton,
  OverflowListItem,
  NavListItemText,
  NavListItemIcon,
  SkeletonContainer,
  SkeletonItem,
  SkeletonIcon,
  SkeletonLabel,
} from './BottomNav.styles';
import type { Theme } from '@mui/material/styles';

/**
 * Bottom navigation bar rendered as a React/MUI island into
 * `#app-bottom-nav-mount` on every non-admin page.
 *
 * Integration points preserved from the previous implementation:
 * - Outer element is `<nav class="bottom-nav" id="main-content">` so
 *   the window-ui-smoke test selector (`nav.bottom-nav#main-content`) matches.
 * - Each rendered action's root element keeps `id="bnav-<key>"` for
 *   imperative capability gating in `public/core.js`.
 * - Privilege-gated tabs are conditionally rendered based on `usePrivilege`.
 *
 * Layout:
 * - When visible items fit directly (<= FIT_THRESHOLD) every item is a primary
 *   tab and there is no "More" button or drawer.
 * - When there are more visible items than the threshold the primary/overflow
 *   split applies: primary tabs stay in the bar, the rest go under "More".
 * - A fixed-height skeleton is shown until auth/config resolve so the bar
 *   paints once in its final shape (no post-load jank).
 */
export type NavItem = {
  key: string;
  href: string;
  label: string;
  Icon: typeof HomeIcon;
  IconOutlined: typeof HomeIcon;
  managerOnly?: boolean;
  adminOnly?: boolean;
};

export const NAV: NavItem[] = [
  { key: 'home',      href: '/',          label: 'Home',      Icon: HomeIcon,             IconOutlined: HomeOutlinedIcon },
  { key: 'customers', href: '/customers', label: 'Customers', Icon: PeopleAltIcon,        IconOutlined: PeopleAltOutlinedIcon },
  { key: 'projects',  href: '/projects',  label: 'Projects',  Icon: SquareFootIcon,       IconOutlined: SquareFootOutlinedIcon },
  { key: 'survey',    href: '/survey',    label: 'Survey',    Icon: AssignmentIcon,       IconOutlined: AssignmentOutlinedIcon },
  { key: 'designvisit', href: '/design-visit', label: 'Design visit', Icon: DesignServicesIcon, IconOutlined: DesignServicesOutlinedIcon },
  { key: 'invoices',  href: '/invoices',  label: 'Invoices',  Icon: ReceiptLongIcon,      IconOutlined: ReceiptLongOutlinedIcon, managerOnly: true },
];

const DEFAULT_PRIMARY_KEYS = ['home', 'customers', 'projects'];
const BAR_SIZE = 3;
const FIT_THRESHOLD = 4;
const VALID_NAV_KEYS = new Set(NAV.map((n) => n.key));

function accentFor(key: string, theme: Theme): string {
  if (key === 'projects') return theme.palette.stage.order.bg;
  if (key === 'survey') return theme.palette.stage.survey.bg;
  return theme.palette.primary.main;
}

function matchPath(pathname: string): string | false {
  const exact = NAV.find((n) => n.href === pathname);
  if (exact) return exact.key;
  const prefix = NAV.find((n) => n.href !== '/' && pathname.startsWith(n.href + '/'));
  return prefix ? prefix.key : false;
}

async function loadRoleNavConfig(): Promise<string[] | null> {
  try {
    const r = await fetch('/api/nav-role-config', { headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    const data = await r.json() as {
      primary_keys?: unknown;
      role?: string | null;
      default_is_customized?: boolean;
    };
    if (!data.role && !data.default_is_customized) return null;
    const keys = data.primary_keys;
    if (
      Array.isArray(keys) &&
      keys.length === BAR_SIZE &&
      keys.every((k) => typeof k === 'string' && VALID_NAV_KEYS.has(k)) &&
      new Set(keys).size === BAR_SIZE
    ) {
      return keys as string[];
    }
    return null;
  } catch {
    return null;
  }
}

function parseNavKeys(raw: unknown): string[] | null {
  if (
    Array.isArray(raw) &&
    raw.length === BAR_SIZE &&
    raw.every((k) => typeof k === 'string' && VALID_NAV_KEYS.has(k)) &&
    new Set(raw).size === BAR_SIZE
  ) {
    return raw as string[];
  }
  return null;
}

// ── Skeleton ───────────────────────────────────────────────────────────────────

function NavSkeleton({ count }: { count: number }) {
  return (
    <SkeletonContainer aria-hidden="true" data-testid="bottom-nav-skeleton">
      {Array.from({ length: Math.max(count, 1) }).map((_, i) => (
        <SkeletonItem key={i}>
          <SkeletonIcon />
          <SkeletonLabel />
        </SkeletonItem>
      ))}
    </SkeletonContainer>
  );
}

// ── BottomNav ──────────────────────────────────────────────────────────────────

export function BottomNav() {
  const theme = useTheme();

  useEffect(() => {
    document.documentElement.style.setProperty('--bottom-nav-height', `${NAV_HEIGHT}px`);
    return () => {
      document.documentElement.style.removeProperty('--bottom-nav-height');
    };
  }, []);

  const { isManager, loading: privLoading } = usePrivilege();
  const { prefs, loading: prefsLoading, patchPref } = usePrefs();
  const [value, setValue] = useState<string | false>(() =>
    typeof window === 'undefined' ? false : matchPath(window.location.pathname),
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [primaryKeys, setPrimaryKeys] = useState<string[]>(DEFAULT_PRIMARY_KEYS);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [customiseOpen, setCustomiseOpen] = useState(false);

  const visibleNav = NAV.filter((n) => {
    if (n.adminOnly) return false;
    if (n.managerOnly) return isManager;
    return true;
  });

  const defaultPrimaryKeys = DEFAULT_PRIMARY_KEYS
    .filter((k) => visibleNav.some((n) => n.key === k));

  const defaultPrimaryKeysRef = useRef(defaultPrimaryKeys);
  defaultPrimaryKeysRef.current = defaultPrimaryKeys;

  const apiConfigFoundRef = useRef(false);
  const configLoadedRef = useRef(false);

  useEffect(() => {
    const sync = () => setValue(matchPath(window.location.pathname));
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    window.addEventListener('mo:navigation', sync as EventListener);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('mo:navigation', sync as EventListener);
    };
  }, []);

  useEffect(() => {
    if (prefsLoading) return;
    let cancelled = false;
    loadRoleNavConfig().then((roleKeys) => {
      if (cancelled) return;
      const userPrefs = parseNavKeys(prefs.nav_primary_keys);
      const keys = userPrefs ?? roleKeys;
      if (keys) {
        setPrimaryKeys(keys);
        apiConfigFoundRef.current = true;
      } else {
        setPrimaryKeys(defaultPrimaryKeysRef.current);
        apiConfigFoundRef.current = false;
      }
      configLoadedRef.current = true;
      setConfigLoaded(true);
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefsLoading]);

  useEffect(() => {
    if (configLoadedRef.current && !apiConfigFoundRef.current) {
      setPrimaryKeys(defaultPrimaryKeysRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isManager]);

  const resolvedPrimaryKeys = configLoaded
    ? primaryKeys.filter((k) => visibleNav.some((n) => n.key === k))
    : DEFAULT_PRIMARY_KEYS.filter((k) => visibleNav.some((n) => n.key === k));

  const allFit = visibleNav.length <= FIT_THRESHOLD;

  const barItems = allFit
    ? visibleNav
    : visibleNav.filter((n) => resolvedPrimaryKeys.includes(n.key));
  const overflowItems = allFit
    ? []
    : visibleNav.filter((n) => !resolvedPrimaryKeys.includes(n.key));

  const hasOverflow = overflowItems.length > 0;
  const navReady = !privLoading && (allFit || configLoaded);
  const activeInOverflow = value !== false && overflowItems.some((n) => n.key === value);
  const moreSelected = activeInOverflow || drawerOpen;
  const barValue = activeInOverflow ? '__more__' : (value || false);

  const handleCustomiseSave = useCallback((keys: string[]) => {
    setPrimaryKeys(keys);
    apiConfigFoundRef.current = true;
    void patchPref('nav_primary_keys', keys);
  }, [patchPref]);

  return (
    <>
      <NavBar
        component="nav"
        id="main-content"
        className="bottom-nav"
      >
        {navReady ? (
          <NavBottomNavigation
            value={barValue}
            showLabels
            onChange={() => { /* anchor navigation handles routing */ }}
          >
            {barItems.map((n) => {
              const accent = accentFor(n.key, theme);
              const isSelected = value === n.key;
              const IconComponent = isSelected ? n.Icon : n.IconOutlined;
              return (
                <NavAction
                  key={n.key}
                  id={`bnav-${n.key}`}
                  value={n.key}
                  component="a"
                  href={n.href}
                  label={n.label}
                  icon={<IconComponent />}
                  data-selected={isSelected ? 'true' : undefined}
                  $accent={accent}
                />
              );
            })}

            {hasOverflow && (
              <NavAction
                key="more"
                id="bnav-more"
                value="__more__"
                label="More"
                icon={<MoreHorizIcon />}
                data-selected={barValue === '__more__' ? 'true' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  setDrawerOpen((prev) => !prev);
                }}
                $accent={theme.palette.primary.main}
              />
            )}
          </NavBottomNavigation>
        ) : (
          <NavSkeleton count={visibleNav.length} />
        )}
      </NavBar>

      <NavDrawer
        anchor="bottom"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        slotProps={{ paper: { ref: (el: HTMLElement | null) => { if (el) el.setAttribute('data-testid', 'bottom-nav-drawer-paper'); } } }}
      >
        <DrawerHandleContainer>
          <DrawerHandle />
        </DrawerHandleContainer>
        <List disablePadding sx={{ pb: 1 }}>
          {overflowItems.map((n) => {
            const accent = accentFor(n.key, theme);
            const isSelected = value === n.key;
            const IconComponent = isSelected ? n.Icon : n.IconOutlined;
            return (
              <OverflowListItem
                key={n.key}
                id={`bnav-${n.key}`}
                component="a"
                href={n.href}
                selected={isSelected}
                data-selected={isSelected ? 'true' : undefined}
                onClick={() => setDrawerOpen(false)}
                $accent={accent}
              >
                <NavListItemIcon>
                  <IconComponent />
                </NavListItemIcon>
                <NavListItemText primary={n.label} />
              </OverflowListItem>
            );
          })}
          {isManager && (
            <>
              <Divider sx={{ mx: 2, my: 0.5 }} />
              <NavListItemButton
                data-testid="nav-customise-button"
                onClick={() => { setDrawerOpen(false); setCustomiseOpen(true); }}
              >
                <NavListItemIcon>
                  <TuneIcon />
                </NavListItemIcon>
                <NavListItemText primary="Customise navigation" />
              </NavListItemButton>
            </>
          )}
        </List>
      </NavDrawer>

      <NavCustomiseDialog
        open={customiseOpen}
        onClose={() => setCustomiseOpen(false)}
        availableItems={visibleNav}
        currentKeys={resolvedPrimaryKeys}
        defaultKeys={defaultPrimaryKeys}
        onSave={handleCustomiseSave}
      />

      {moreSelected && (
        <Box sx={{ display: 'none' }} aria-hidden="true" data-more-selected />
      )}
    </>
  );
}

export default BottomNav;
