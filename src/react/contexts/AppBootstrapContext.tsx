import React, { useEffect } from 'react';
import { useAuth } from './AuthContext';
import { PUBLIC_ISLAND_IDS } from '../lib/publicIslands';

/**
 * Ids that must skip the bootstrap redirect guard but are NOT public-facing
 * pages — they are error/restricted pages rendered after auth failures.
 * These are excluded from PUBLIC_ISLAND_IDS (which drives CONN_TOAST_EXCLUDED)
 * but still need to bypass AppBootstrapProvider's auth-redirect logic.
 */
const BOOTSTRAP_ONLY_IDS = new Set([
  'not-found-root',         // 404 page, rendered after auth; never public
  'access-restricted-root', // access-denied page, rendered after auth; never public
]);

/**
 * Derived from PUBLIC_ISLAND_IDS (src/react/lib/publicIslands.ts) plus the
 * BOOTSTRAP_ONLY_IDS above.  No manual sync required — add new public islands
 * to PUBLIC_ISLAND_IDS; add new error/restricted pages to BOOTSTRAP_ONLY_IDS.
 */
const BOOTSTRAP_EXCLUDED = new Set([...PUBLIC_ISLAND_IDS, ...BOOTSTRAP_ONLY_IDS]);

function AppBootstrapInner({ children }: { children: React.ReactNode }) {
  const { user, loading, privilegeLevel } = useAuth();

  useEffect(() => {
    if (loading) return;

    if (!user) {
      window.location.href = '/login' + window.location.search;
      return;
    }

    if (
      user.onboarding_status === 'more_info_required' &&
      window.location.pathname !== '/onboarding'
    ) {
      window.location.href = '/onboarding';
      return;
    }

    if (
      privilegeLevel === 'viewer' &&
      sessionStorage.getItem('viewerBannerDismissed') !== '1'
    ) {
      const banner = document.getElementById('viewer-banner');
      if (banner) banner.style.display = '';
      document.body.classList.add('has-viewer-banner');
    }
  }, [user, loading, privilegeLevel]);

  return <>{children}</>;
}

/**
 * Wraps authenticated page islands to enforce:
 * - Redirect to /login when the session has expired or was never started.
 * - Redirect to /onboarding when the user hasn't completed first-time setup.
 * - Viewer-role banner visibility (reads the #viewer-banner element injected
 *   by chrome.js and toggles the `has-viewer-banner` body class).
 *
 * This is the React replacement for the `bootstrap()` / `checkAuthStatus()`
 * functions that previously lived in `public/core.js`.
 *
 * Islands listed in PUBLIC_ISLAND_IDS (public auth/customer pages) are rendered
 * unwrapped so they never trigger an auth-based redirect loop, as are the
 * error/restricted pages in BOOTSTRAP_ONLY_IDS (not-found-root, access-restricted-root).
 */
export function AppBootstrapProvider({
  children,
  islandId,
}: {
  children: React.ReactNode;
  islandId: string;
}) {
  if (BOOTSTRAP_EXCLUDED.has(islandId)) return <>{children}</>;
  return <AppBootstrapInner>{children}</AppBootstrapInner>;
}

export { BOOTSTRAP_EXCLUDED };
