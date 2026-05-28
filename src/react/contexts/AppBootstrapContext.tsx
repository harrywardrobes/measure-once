import React, { useEffect } from 'react';
import { useAuth } from './AuthContext';

/**
 * Island ids that must NOT receive the bootstrap guard:
 * - Public auth pages (no session; auth APIs return 401)
 * - Design-visit sign-off (public, customer-facing)
 * - Error/restricted pages (rendered before or instead of auth)
 */
const BOOTSTRAP_EXCLUDED = new Set([
  'login-root',
  'set-password-root',
  'onboarding-root',
  'dv-signoff-mount',
  'customer-info-mount',
  'not-found-root',
  'access-restricted-root',
]);

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
 * Islands listed in BOOTSTRAP_EXCLUDED (public/auth pages) are rendered
 * unwrapped so they never trigger an auth-based redirect loop.
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
