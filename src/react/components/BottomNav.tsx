import { useEffect, useRef } from 'react';
import Box from '@mui/material/Box';

/**
 * Bottom navigation bar rendered as a React/MUI island into
 * `#app-bottom-nav-mount` on every non-admin page. Replaces the
 * hand-written HTML template that used to live in `public/chrome.js`.
 *
 * Implementation notes:
 *
 * - The outer wrapper is `<nav class="bottom-nav" id="main-content">`
 *   and each item is `<a class="bottom-nav-btn" id="bnav-<key>">`, so
 *   the existing CSS in `public/style.css` (including per-tab stage
 *   accent overrides and safe-area inset handling) keeps working
 *   unchanged, the window-ui-smoke test still finds the nav, and
 *   capability-driven show/hide code in `public/core.js` /
 *   `public/admin.html` can still toggle `style.display` on the items.
 *
 * - The component intentionally never re-renders the item list after
 *   mount (no React state). Active-state changes are applied
 *   imperatively via `classList.toggle` on a ref, so React never
 *   touches the inline `style` attribute on subsequent renders and the
 *   imperative `display` mutations from core.js / admin.html persist.
 */
type NavItem = {
  key: string;
  href: string;
  label: string;
  managerOnly?: boolean;
  adminOnly?: boolean;
};

export const NAV: NavItem[] = [
  { key: 'home',     href: '/',         label: 'Home' },
  { key: 'sales',    href: '/sales',    label: 'Sales',    managerOnly: true },
  { key: 'survey',   href: '/survey',   label: 'Survey',   managerOnly: true },
  { key: 'projects', href: '/projects', label: 'Projects', managerOnly: true },
  { key: 'calendar', href: '/calendar', label: 'Calendar' },
  { key: 'invoices', href: '/invoices', label: 'Invoices', managerOnly: true },
  { key: 'trades',   href: '/trades',   label: 'Trades' },
  { key: 'ideas',    href: '/ideas',    label: 'Ideas' },
];

export function BottomNav() {
  const navRef = useRef<HTMLElement | null>(null);
  const initialPath = typeof window !== 'undefined' ? window.location.pathname : '/';

  useEffect(() => {
    const scrollActive = (behavior: ScrollBehavior) => {
      const btn = navRef.current?.querySelector<HTMLElement>('.bottom-nav-active');
      if (btn) btn.scrollIntoView({ inline: 'center', block: 'nearest', behavior });
    };

    const sync = (behavior: ScrollBehavior) => {
      const root = navRef.current;
      if (!root) return;
      const currentPath = window.location.pathname;
      const buttons = root.querySelectorAll<HTMLAnchorElement>('.bottom-nav-btn');
      if (!buttons.length) return;
      let changed = false;
      buttons.forEach((btn) => {
        const isActive = btn.getAttribute('href') === currentPath;
        const wasActive = btn.classList.contains('bottom-nav-active');
        if (isActive !== wasActive) {
          btn.classList.toggle('bottom-nav-active', isActive);
          changed = true;
        }
      });
      if (changed) scrollActive(behavior);
    };

    scrollActive('instant');

    const onPop = () => sync('smooth');
    const onHash = () => sync('smooth');
    const onNav = () => sync('smooth');
    window.addEventListener('popstate', onPop);
    window.addEventListener('hashchange', onHash);
    window.addEventListener('mo:navigation', onNav as EventListener);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('mo:navigation', onNav as EventListener);
    };
  }, []);

  return (
    <Box
      component="nav"
      id="main-content"
      className="bottom-nav"
      ref={(el: HTMLElement | null) => { navRef.current = el; }}
    >
      <Box className="bottom-nav-inner">
        {NAV.map((n) => {
          const isActive = n.href === initialPath;
          const hidden = n.managerOnly || n.adminOnly;
          return (
            <Box
              key={n.key}
              component="a"
              id={`bnav-${n.key}`}
              href={n.href}
              aria-label={n.label}
              className={`bottom-nav-btn${isActive ? ' bottom-nav-active' : ''}`}
              style={hidden ? { display: 'none' } : undefined}
            >
              {n.label}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

export default BottomNav;
