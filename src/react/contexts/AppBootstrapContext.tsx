import React, { useEffect } from 'react';
import { useAuth } from './AuthContext';
import { PUBLIC_ISLAND_IDS, BOOTSTRAP_ONLY_IDS } from '../lib/publicIslands';
import { VIEWER_BANNER_DISMISSED_KEY } from '../constants/localStorageKeys';

/**
 * Derived from PUBLIC_ISLAND_IDS ∪ BOOTSTRAP_ONLY_IDS, both defined in
 * src/react/lib/publicIslands.ts — the single authoritative source.
 * No manual sync required:
 *   - add new public islands to PUBLIC_ISLAND_IDS
 *   - add new error/restricted pages to BOOTSTRAP_ONLY_IDS
 * scripts/check-public-island-bootstrap.mjs enforces both sets against MOUNTS.
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
      sessionStorage.getItem(VIEWER_BANNER_DISMISSED_KEY) !== '1'
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
