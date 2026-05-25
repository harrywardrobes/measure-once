import { useEffect, useState } from 'react';
import { usePrivilege } from '../hooks/usePrivilege';
import Box from '@mui/material/Box';
import BottomNavigation from '@mui/material/BottomNavigation';
import BottomNavigationAction from '@mui/material/BottomNavigationAction';
import Drawer from '@mui/material/Drawer';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import { useTheme, type Theme } from '@mui/material/styles';
import HomeIcon from '@mui/icons-material/Home';
import HomeOutlinedIcon from '@mui/icons-material/HomeOutlined';
import SellIcon from '@mui/icons-material/Sell';
import SellOutlinedIcon from '@mui/icons-material/SellOutlined';
import AssignmentIcon from '@mui/icons-material/Assignment';
import AssignmentOutlinedIcon from '@mui/icons-material/AssignmentOutlined';
import SquareFootIcon from '@mui/icons-material/SquareFoot';
import SquareFootOutlinedIcon from '@mui/icons-material/SquareFootOutlined';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import CalendarMonthOutlinedIcon from '@mui/icons-material/CalendarMonthOutlined';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined';
import HandymanIcon from '@mui/icons-material/Handyman';
import HandymanOutlinedIcon from '@mui/icons-material/HandymanOutlined';
import LightbulbIcon from '@mui/icons-material/Lightbulb';
import LightbulbOutlinedIcon from '@mui/icons-material/LightbulbOutlined';
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
 *   `public/style.css` keeps finding it and the window-ui-smoke test
 *   selector (`nav.bottom-nav#main-content`) still matches.
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
 * - Members primary: Home, Calendar, Trades → overflow: Ideas
 * - Managers primary: Home, Sales, Projects → overflow: Survey, Calendar,
 *   Invoices, Trades, Ideas
 * - Tapping "More" opens a bottom Drawer listing overflow tabs.
 * - "More" shows as selected when the active page is in the overflow set.
 */
type NavItem = {
  key: string;
  href: string;
  label: string;
  Icon: typeof HomeIcon;
  IconOutlined: typeof HomeIcon;
  managerOnly?: boolean;
  adminOnly?: boolean;
};

export const NAV: NavItem[] = [
  { key: 'home',     href: '/',         label: 'Home',     Icon: HomeIcon,          IconOutlined: HomeOutlinedIcon },
  { key: 'sales',    href: '/sales',    label: 'Sales',    Icon: SellIcon,          IconOutlined: SellOutlinedIcon,          managerOnly: true },
  { key: 'survey',   href: '/survey',   label: 'Survey',   Icon: AssignmentIcon,    IconOutlined: AssignmentOutlinedIcon,    managerOnly: true },
  { key: 'projects', href: '/projects', label: 'Projects', Icon: SquareFootIcon,    IconOutlined: SquareFootOutlinedIcon,    managerOnly: true },
  { key: 'calendar', href: '/calendar', label: 'Calendar', Icon: CalendarMonthIcon, IconOutlined: CalendarMonthOutlinedIcon },
  { key: 'invoices', href: '/invoices', label: 'Invoices', Icon: ReceiptLongIcon,   IconOutlined: ReceiptLongOutlinedIcon,   managerOnly: true },
  { key: 'trades',   href: '/trades',   label: 'Trades',   Icon: HandymanIcon,      IconOutlined: HandymanOutlinedIcon },
  { key: 'ideas',    href: '/ideas',    label: 'Ideas',    Icon: LightbulbIcon,     IconOutlined: LightbulbOutlinedIcon },
];

const MEMBER_PRIMARY_KEYS = ['home', 'calendar', 'trades'];
const MANAGER_PRIMARY_KEYS = ['home', 'sales', 'projects'];

function accentFor(key: string, theme: Theme): string {
  if (key === 'sales')    return theme.palette.stage.sales.bg;
  if (key === 'survey')   return theme.palette.stage.survey.bg;
  if (key === 'projects') return theme.palette.stage.order.bg;
  return theme.palette.primary.main;
}

function matchPath(pathname: string): string | false {
  const m = NAV.find((n) => n.href === pathname);
  return m ? m.key : false;
}

export function BottomNav() {
  const theme = useTheme();
  const { isManager } = usePrivilege();
  const [value, setValue] = useState<string | false>(() =>
    typeof window === 'undefined' ? false : matchPath(window.location.pathname),
  );
  const [drawerOpen, setDrawerOpen] = useState(false);

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

  const primaryKeys = isManager ? MANAGER_PRIMARY_KEYS : MEMBER_PRIMARY_KEYS;

  const visibleNav = NAV.filter((n) => {
    if (n.adminOnly) return false;
    if (n.managerOnly) return isManager;
    return true;
  });

  const barItems = visibleNav.filter((n) => primaryKeys.includes(n.key));
  const overflowItems = visibleNav.filter((n) => !primaryKeys.includes(n.key));

  const activeInOverflow = value !== false && overflowItems.some((n) => n.key === value);
  const moreSelected = activeInOverflow || drawerOpen;

  const barValue = activeInOverflow ? '__more__' : (value || false);

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
          bgcolor: '#fff',
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
                  color: 'text.secondary',
                  px: { xs: 1.25, sm: 0.5 },
                  '&.Mui-selected': {
                    color: accent,
                    borderTop: '2px solid',
                    borderTopColor: accent,
                    paddingTop: 'calc(6px - 2px)',
                  },
                  '& .MuiBottomNavigationAction-label': {
                    fontWeight: 600,
                    letterSpacing: '0.02em',
                    textTransform: 'uppercase',
                    fontSize: { xs: '0.65rem', sm: '0.7rem' },
                  },
                  '& .MuiBottomNavigationAction-label.Mui-selected': {
                    fontSize: { xs: '0.65rem', sm: '0.7rem' },
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
              color: 'text.secondary',
              px: { xs: 1.25, sm: 0.5 },
              '&.Mui-selected': {
                color: theme.palette.primary.main,
                borderTop: '2px solid',
                borderTopColor: theme.palette.primary.main,
                paddingTop: 'calc(6px - 2px)',
              },
              '& .MuiBottomNavigationAction-label': {
                fontWeight: 600,
                letterSpacing: '0.02em',
                textTransform: 'uppercase',
                fontSize: { xs: '0.65rem', sm: '0.7rem' },
              },
              '& .MuiBottomNavigationAction-label.Mui-selected': {
                fontSize: { xs: '0.65rem', sm: '0.7rem' },
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
                <ListItemIcon
                  sx={{
                    minWidth: 40,
                    color: isSelected ? accent : 'text.secondary',
                  }}
                >
                  <IconComponent />
                </ListItemIcon>
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
        </List>
      </Drawer>

      {moreSelected && (
        <Box sx={{ display: 'none' }} aria-hidden="true" data-more-selected />
      )}
    </>
  );
}

export default BottomNav;
