import { useEffect } from 'react';
import { useCurrentUser } from './useCurrentUser';

const RESTRICTED_PATHS = new Set([
  '/sales', '/sales.html',
  '/survey', '/survey.html',
  '/projects', '/projects.html',
  '/invoices', '/invoices.html',
]);

/**
 * Syncs privilege-derived body classes (viewer-mode, manager-mode, admin-mode)
 * from the React user object, and enforces the client-side route guard for
 * manager-restricted pages.
 *
 * Call this hook once inside a component that renders on every page
 * (GlobalHeader). Effects are idempotent — classList mutations are safe to
 * repeat and the redirect only fires when the path is actually restricted.
 *
 * The server already enforces restricted-page access via
 * requireManagerOrAdminPage; this is belt-and-suspenders so the client JS
 * layer stays consistent after any SPA-style navigation.
 */
export function usePrivilegeSync(): void {
  const { user, loading } = useCurrentUser();

  useEffect(() => {
    if (loading) return;

    const priv = user?.privilege_level ?? 'member';
    const body = document.body;

    body.classList.toggle('viewer-mode',  priv === 'viewer');
    body.classList.toggle('manager-mode', priv === 'manager' || priv === 'admin');
    body.classList.toggle('admin-mode',   priv === 'admin');

    if (user && RESTRICTED_PATHS.has(location.pathname) &&
        priv !== 'manager' && priv !== 'admin') {
      window.location.href = '/';
    }
  }, [user, loading]);
}
