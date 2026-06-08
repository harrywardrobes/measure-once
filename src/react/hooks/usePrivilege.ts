import { useAuth } from '../contexts/AuthContext';

type UsePrivilegeResult = {
  privilegeLevel: string;
  isAdmin: boolean;
  isManager: boolean;
  isViewer: boolean;
  /**
   * True while the auth state is still resolving (no synchronous
   * `window.__moHeaderUser` was available at mount and the `/api/auth/user`
   * fetch has not yet returned). Components that change layout based on
   * privilege should hold a stable placeholder until this is false to avoid
   * post-load reflow.
   */
  loading: boolean;
};

/**
 * Returns the current user's privilege level and convenience booleans.
 *
 * Reads from `AuthContext` (populated by `AuthProvider` inside
 * `AppThemeProvider`). Falls back to the `mo:user` window event /
 * `window.__moHeaderUser` when no provider is present (Storybook, tests).
 *
 * Use this in all React components that need to gate on privilege.
 */
export function usePrivilege(): UsePrivilegeResult {
  const { privilegeLevel, loading } = useAuth();

  return {
    privilegeLevel,
    isAdmin: privilegeLevel === 'admin',
    isManager: privilegeLevel === 'manager' || privilegeLevel === 'admin',
    isViewer: privilegeLevel === 'viewer',
    loading,
  };
}
