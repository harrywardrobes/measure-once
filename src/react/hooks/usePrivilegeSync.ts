import { useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';

const RESTRICTED_PATHS = new Set([
  '/projects', '/projects.html',
]);

/**
 * Enforces the client-side route guard for manager-restricted pages.
 *
 * Call this hook once inside a component that renders on every page
 * (GlobalHeader). The redirect only fires when the path is actually
 * restricted and the user lacks manager/admin privilege.
 *
 * The server already enforces restricted-page access via
 * requireManagerOrAdminPage; this is belt-and-suspenders so the client JS
 * layer stays consistent after any SPA-style navigation.
 */
export function usePrivilegeSync(): void {
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading) return;

    const priv = user?.privilege_level ?? 'member';

    if (user && RESTRICTED_PATHS.has(location.pathname) &&
        priv !== 'manager' && priv !== 'admin') {
      window.location.href = '/';
    }
  }, [user, loading]);
}
