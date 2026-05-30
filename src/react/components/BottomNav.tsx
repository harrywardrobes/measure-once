import { useCallback, useEffect, useRef, useState } from 'react';
import { usePrivilege } from '../hooks/usePrivilege';
import { usePrefs } from '../hooks/usePrefs';
import Box from '@mui/material/Box';
import BottomNavigation from '@mui/material/BottomNavigation';
import BottomNavigationAction from '@mui/material/BottomNavigationAction';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIconWrapper from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import { useTheme, type Theme } from '@mui/material/styles';
import TuneIcon from '@mui/icons-material/Tune';
import HomeIcon from '@mui/icons-material/Home';
import { NavCustomiseDialog } from './NavCustomiseDialog';
import HomeOutlinedIcon from '@mui/icons-material/HomeOutlined';
import SquareFootIcon from '@mui/icons-material/SquareFoot';
import SquareFootOutlinedIcon from '@mui/icons-material/SquareFootOutlined';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import CalendarMonthOutlinedIcon from '@mui/icons-material/CalendarMonthOutlined';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined';
import PeopleAltIcon from '@mui/icons-material/PeopleAlt';
import PeopleAltOutlinedIcon from '@mui/icons-material/PeopleAltOutlined';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';

/**
 * Bottom navigation bar rendered as a React/MUI island into
 * `#app-bottom-nav-mount` on every non-admin page. Built on MUI's
 * `BottomNavigation` + `BottomNavigationAction` so each tab shows a
 * Material icon above its label and uses MUI's built-in selected state.
 *
 * Integration points preserved from the previous implementation:
 *
 * - Outer element is `<nav class="bottom-nav" id="main-content">` so
 *   the window-ui-smoke test selector (`nav.bottom-nav#main-content`)
 *   still matches. No CSS in app-styles.css backs this class; MUI sx
 *   owns all layout and colour.
 * - Each rendered action's root element keeps `id="bnav-<key>"` so the
 *   imperative capability gating in `public/core.js` and
 *   `public/admin.html` (which toggles `style.display` by element id)
 *   still works without errors. Drawer items also get their id.
 * - Privilege-gated tabs are conditionally rendered based on the user's
 *   privilege level from `usePrivilege` — no DOM mutation needed.
 *
 * Layout:
 * - Always shows exactly 4 items in the bar: 3 role-relevant primary tabs
 *   + a "More" button.
 * - Primary tabs are determined by the user's job role via
 *   GET /api/nav-role-config (falls back to __default__ if no match).
 * - The managerOnly visibility filter still applies: tabs a user cannot
 *   access are never shown regardless of the role config.
 * - Tapping "More" opens a bottom Drawer listing overflow tabs.
 * - "More" shows as selected when the active page is in the overflow set.
 * - Nav layout is admin-configured per job role; users have no per-user
 *   customise option.
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
  { key: 'projects', href: '/projects', label: 'Projects', Icon: SquareFootIcon,    IconOutlined: SquareFootOutlinedIcon },
  { key: 'calendar', href: '/calendar', label: 'Calendar', Icon: CalendarMonthIcon, IconOutlined: CalendarMonthOutlinedIcon },
  { key: 'invoices', href: '/invoices', label: 'Invoices', Icon: ReceiptLongIcon,   IconOutlined: ReceiptLongOutlinedIcon,   managerOnly: true },
];

const DEFAULT_PRIMARY_KEYS = ['home', 'customers', 'calendar'];
const BAR_SIZE = 3;

function accentFor(key: string, theme: Theme): string {
  if (key === 'projects') return theme.palette.stage.order.bg;
  return theme.palette.primary.main;
}

function matchPath(pathname: string): string | false {
  const exact = NAV.find((n) => n.href === pathname);
  if (exact) return exact.key;
  const prefix = NAV.find((n) => n.href !== '/' && pathname.startsWith(n.href + '/'));
  return prefix ? prefix.key : false;
}

const VALID_NAV_KEYS = new Set(NAV.map((n) => n.key));

async function loadRoleNavConfig(): Promise<string[] | null> {
  try {
    const r = await fetch('/api/nav-role-config', { headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    const data = await r.json() as {
      primary_keys?: unknown;
      role?: string | null;
      default_is_customized?: boolean;
    };
    // When the user has no job_role the API falls back to the __default__ config.
    // If the admin has customised __default__ (default_is_customized=true) we
    // honour it; otherwise fall back to privilege-level-aware defaults so that
    // uncustomised deployments behave exactly as before.
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

export function BottomNav() {
  const theme = useTheme();
  const { isManager } = usePrivilege();
  const { prefs, loading: prefsLoading, patchPref } = usePrefs();
  const [value, setValue] = useState<string | false>(() =>
    typeof window === 'undefined' ? false : matchPath(window.location.pathname),
  );
  const [drawerOpen, setDrawerOpen] = useState(false);

  const [primaryKeys, setPrimaryKeys] = useState<string[]>(DEFAULT_PRIMARY_KEYS);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [customiseOpen, setCustomiseOpen] = useState(false);

  // visibleNav and defaultPrimaryKeys are computed here (before the ref) so
  // that defaultPrimaryKeysRef always holds a role-aware value that the async
  // loadRoleNavConfig callback can read even if isManager resolved late.
  const visibleNav = NAV.filter((n) => {
    if (n.adminOnly) return false;
    if (n.managerOnly) return isManager;
    return true;
  });
  // Role-aware fallback used when the API returns no saved config (or when
  // the user has no job_role and the admin has NOT customised the __default__
  // layout — customised defaults are honoured directly).
  // Both managers and non-managers default to DEFAULT_PRIMARY_KEYS.
  // Filtered to actually-visible items.
  const defaultPrimaryKeys = DEFAULT_PRIMARY_KEYS
    .filter((k) => visibleNav.some((n) => n.key === k));

  // Always reflects the latest defaultPrimaryKeys so the prefs-load callback
  // can use it even if isManager resolved after the effect ran.
  const defaultPrimaryKeysRef = useRef(defaultPrimaryKeys);
  defaultPrimaryKeysRef.current = defaultPrimaryKeys;

  // Tracks whether a real saved config came from the API (vs role-aware
  // defaults). Used by the isManager-change effect below to decide whether
  // to re-apply defaults when the privilege level resolves late.
  const apiConfigFoundRef = useRef(false);
  // Mirrors the configLoaded state in a ref so the isManager-change effect
  // can read the latest value without being listed as a dependency.
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
    if (prefsLoading) return; // Wait for prefs to be available before reading nav_primary_keys
    let cancelled = false;
    loadRoleNavConfig().then((roleKeys) => {
      if (cancelled) return;
      // User personal prefs take priority over role config.
      const userPrefs = parseNavKeys(prefs.nav_primary_keys);
      const keys = userPrefs ?? roleKeys;
      if (keys) {
        setPrimaryKeys(keys);
        apiConfigFoundRef.current = true;
      } else {
        // No saved pref — use role-aware defaults. Reading from the ref
        // captures the current value of isManager even when it resolved
        // asynchronously after this effect started (e.g. bootstrap() races
        // the React mount and isManager was false at mount time).
        setPrimaryKeys(defaultPrimaryKeysRef.current);
        apiConfigFoundRef.current = false;
      }
      configLoadedRef.current = true;
      setConfigLoaded(true);
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefsLoading]);

  // Re-apply role-aware defaults when the privilege level resolves after the
  // initial config load.  This handles the common race: the config fetch
  // completes while isManager is still false (bootstrap() hasn't fired yet),
  // so the member defaults get written; when mo:user later fires and isManager
  // becomes true we need to correct the primary keys — but only when no
  // explicit saved config was returned by the API.
  useEffect(() => {
    if (configLoadedRef.current && !apiConfigFoundRef.current) {
      setPrimaryKeys(defaultPrimaryKeysRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isManager]);

  const resolvedPrimaryKeys = configLoaded
    ? primaryKeys.filter((k) => visibleNav.some((n) => n.key === k))
    : DEFAULT_PRIMARY_KEYS.filter((k) => visibleNav.some((n) => n.key === k));

  const barItems = visibleNav.filter((n) => resolvedPrimaryKeys.includes(n.key));
  const overflowItems = visibleNav.filter((n) => !resolvedPrimaryKeys.includes(n.key));

  const activeInOverflow = value !== false && overflowItems.some((n) => n.key === value);
  const moreSelected = activeInOverflow || drawerOpen;

  const barValue = activeInOverflow ? '__more__' : (value || false);

  const handleCustomiseSave = useCallback((keys: string[]) => {
    setPrimaryKeys(keys);
    apiConfigFoundRef.current = true;
    void patchPref('nav_primary_keys', keys);
  }, [patchPref]);

  const actionSx = {
    color: 'text.secondary',
    px: { xs: 1.25, sm: 0.5 },
    '& .MuiBottomNavigationAction-label': {
      fontWeight: 600,
      letterSpacing: '0.02em',
      textTransform: 'uppercase',
      fontSize: { xs: '0.65rem', sm: '0.7rem' },
    },
    '& .MuiBottomNavigationAction-label.Mui-selected': {
      fontSize: { xs: '0.65rem', sm: '0.7rem' },
    },
  } as const;

  return (
    <>
      <Box
        component="nav"
        id="main-content"
        className="bottom-nav"
        sx={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          bgcolor: 'background.paper',
          borderTop: '1px solid',
          borderColor: 'divider',
          zIndex: (t) => t.zIndex.appBar,
          pb: 'env(safe-area-inset-bottom)',
          display: 'flex',
          justifyContent: 'center',
          overflowY: 'hidden',
        }}
      >
        <BottomNavigation
          value={barValue}
          showLabels
          onChange={() => { /* anchor navigation handles routing */ }}
          sx={{
            width: '100%',
            maxWidth: { xs: 'none', sm: 640 },
            height: 64,
            bgcolor: 'transparent',
          }}
        >
          {barItems.map((n) => {
            const accent = accentFor(n.key, theme);
            const isSelected = value === n.key;
            const IconComponent = isSelected ? n.Icon : n.IconOutlined;
            return (
              <BottomNavigationAction
                key={n.key}
                id={`bnav-${n.key}`}
                value={n.key}
                component="a"
                href={n.href}
                label={n.label}
                icon={<IconComponent />}
                sx={{
                  ...actionSx,
                  '&.Mui-selected': {
                    color: accent,
                    borderTop: '2px solid',
                    borderTopColor: accent,
                    paddingTop: 'calc(6px - 2px)',
                  },
                }}
              />
            );
          })}

          <BottomNavigationAction
            key="more"
            id="bnav-more"
            value="__more__"
            label="More"
            icon={<MoreHorizIcon />}
            onClick={(e) => {
              e.preventDefault();
              setDrawerOpen((prev) => !prev);
            }}
            sx={{
              ...actionSx,
              '&.Mui-selected': {
                color: theme.palette.primary.main,
                borderTop: '2px solid',
                borderTopColor: theme.palette.primary.main,
                paddingTop: 'calc(6px - 2px)',
              },
            }}
          />
        </BottomNavigation>
      </Box>

      <Drawer
        anchor="bottom"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        sx={{
          zIndex: (t) => t.zIndex.appBar + 1,
          '& .MuiDrawer-paper': {
            borderTopLeftRadius: 12,
            borderTopRightRadius: 12,
            pb: 'env(safe-area-inset-bottom)',
          },
        }}
        slotProps={{ paper: { ref: (el: HTMLElement | null) => { if (el) el.setAttribute('data-testid', 'bottom-nav-drawer-paper'); } } }}
      >
        <Box
          sx={{
            width: '100%',
            display: 'flex',
            justifyContent: 'center',
            pt: 1,
            pb: 0.5,
          }}
        >
          <Box
            sx={{
              width: 40,
              height: 4,
              borderRadius: 999,
              bgcolor: 'divider',
            }}
          />
        </Box>
        <List disablePadding sx={{ pb: 1 }}>
          {overflowItems.map((n) => {
            const accent = accentFor(n.key, theme);
            const isSelected = value === n.key;
            const IconComponent = isSelected ? n.Icon : n.IconOutlined;
            return (
              <ListItemButton
                key={n.key}
                id={`bnav-${n.key}`}
                component="a"
                href={n.href}
                selected={isSelected}
                onClick={() => setDrawerOpen(false)}
                sx={{
                  py: 1.5,
                  px: 2.5,
                  '&.Mui-selected': {
                    bgcolor: 'transparent',
                    color: accent,
                  },
                  '&.Mui-selected .MuiListItemIcon-root': {
                    color: accent,
                  },
                  '&.Mui-selected .MuiListItemText-primary': {
                    color: accent,
                    fontWeight: 700,
                  },
                }}
              >
                <ListItemIconWrapper
                  sx={{
                    minWidth: 40,
                    color: isSelected ? accent : 'text.secondary',
                  }}
                >
                  <IconComponent />
                </ListItemIconWrapper>
                <ListItemText
                  primary={n.label}
                  slotProps={{
                    primary: {
                      style: {
                        fontWeight: isSelected ? 700 : 600,
                        fontSize: '0.95rem',
                        letterSpacing: '0.02em',
                        textTransform: 'uppercase',
                        color: isSelected ? accent : theme.palette.text.secondary,
                      },
                    },
                  }}
                />
              </ListItemButton>
            );
          })}
          {isManager && (
            <>
              <Divider sx={{ mx: 2, my: 0.5 }} />
              <ListItemButton
                data-testid="nav-customise-button"
                onClick={() => { setDrawerOpen(false); setCustomiseOpen(true); }}
                sx={{ py: 1.5, px: 2.5 }}
              >
                <ListItemIconWrapper sx={{ minWidth: 40, color: 'text.secondary' }}>
                  <TuneIcon />
                </ListItemIconWrapper>
                <ListItemText
                  primary="Customise navigation"
                  slotProps={{
                    primary: {
                      style: {
                        fontWeight: 600,
                        fontSize: '0.95rem',
                        letterSpacing: '0.02em',
                        textTransform: 'uppercase',
                        color: theme.palette.text.secondary,
                      },
                    },
                  }}
                />
              </ListItemButton>
            </>
          )}
        </List>
      </Drawer>

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
