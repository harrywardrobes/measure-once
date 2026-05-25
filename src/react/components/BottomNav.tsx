import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import BottomNavigation from '@mui/material/BottomNavigation';
import BottomNavigationAction from '@mui/material/BottomNavigationAction';
import { useTheme, type Theme } from '@mui/material/styles';
import HomeIcon from '@mui/icons-material/Home';
import SellIcon from '@mui/icons-material/Sell';
import AssignmentIcon from '@mui/icons-material/Assignment';
import ConstructionIcon from '@mui/icons-material/Construction';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import HandymanIcon from '@mui/icons-material/Handyman';
import LightbulbIcon from '@mui/icons-material/Lightbulb';

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
 * - Each action's root element keeps `id="bnav-<key>"` so the
 *   imperative capability gating in `public/core.js` and
 *   `public/admin.html` (which toggles `style.display` by element id)
 *   still works. We never pass a `style` prop on those elements after
 *   mount — initial hide for manager/admin-only tabs is applied once
 *   via a side-effect, after which React leaves the inline `style`
 *   attribute alone.
 */
type NavItem = {
  key: string;
  href: string;
  label: string;
  Icon: typeof HomeIcon;
  managerOnly?: boolean;
  adminOnly?: boolean;
};

export const NAV: NavItem[] = [
  { key: 'home',     href: '/',         label: 'Home',     Icon: HomeIcon },
  { key: 'sales',    href: '/sales',    label: 'Sales',    Icon: SellIcon,           managerOnly: true },
  { key: 'survey',   href: '/survey',   label: 'Survey',   Icon: AssignmentIcon,     managerOnly: true },
  { key: 'projects', href: '/projects', label: 'Projects', Icon: ConstructionIcon,   managerOnly: true },
  { key: 'calendar', href: '/calendar', label: 'Calendar', Icon: CalendarMonthIcon },
  { key: 'invoices', href: '/invoices', label: 'Invoices', Icon: ReceiptLongIcon,    managerOnly: true },
  { key: 'trades',   href: '/trades',   label: 'Trades',   Icon: HandymanIcon },
  { key: 'ideas',    href: '/ideas',    label: 'Ideas',    Icon: LightbulbIcon },
];

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
  const navRef = useRef<HTMLElement | null>(null);
  const firstScroll = useRef(true);
  const [value, setValue] = useState<string | false>(() =>
    typeof window === 'undefined' ? false : matchPath(window.location.pathname),
  );

  // Apply the initial hidden state for capability-gated tabs once, via
  // direct DOM mutation, so subsequent React renders never re-touch the
  // `style` attribute and `public/core.js` / `public/admin.html` can
  // freely toggle `style.display` later.
  useEffect(() => {
    NAV.forEach((n) => {
      if (!n.managerOnly && !n.adminOnly) return;
      const el = document.getElementById(`bnav-${n.key}`) as HTMLElement | null;
      if (el && el.dataset.bnavInit !== '1') {
        el.dataset.bnavInit = '1';
        el.style.display = 'none';
      }
    });
  }, []);

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
    if (value === false) return;
    const root = navRef.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>(`#bnav-${value}`);
    if (!el) return;
    const behavior: ScrollBehavior = firstScroll.current ? ('instant' as ScrollBehavior) : 'smooth';
    firstScroll.current = false;
    try {
      el.scrollIntoView({ inline: 'center', block: 'nearest', behavior });
    } catch {
      el.scrollIntoView();
    }
  }, [value]);

  return (
    <Box
      component="nav"
      id="main-content"
      className="bottom-nav"
      ref={(el: HTMLElement | null) => { navRef.current = el; }}
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
        overflowX: { xs: 'auto', sm: 'hidden' },
        overflowY: 'hidden',
        scrollbarWidth: 'none',
        msOverflowStyle: 'none',
        '&::-webkit-scrollbar': { display: 'none' },
      }}
    >
      <BottomNavigation
        value={value}
        showLabels
        onChange={() => { /* anchor navigation handles routing */ }}
        sx={{
          width: '100%',
          maxWidth: { xs: 'none', sm: 640 },
          minWidth: { xs: 'max-content', sm: 0 },
          height: 64,
          bgcolor: 'transparent',
        }}
      >
        {NAV.map((n) => {
          const accent = accentFor(n.key, theme);
          return (
            <BottomNavigationAction
              key={n.key}
              id={`bnav-${n.key}`}
              value={n.key}
              component="a"
              href={n.href}
              label={n.label}
              icon={<n.Icon />}
              sx={{
                color: 'text.secondary',
                minWidth: { xs: 72, sm: 0 },
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
      </BottomNavigation>
    </Box>
  );
}

export default BottomNav;
