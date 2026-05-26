import { useAuth } from '../contexts/AuthContext';

type UsePrivilegeResult = {
  privilegeLevel: string;
  isAdmin: boolean;
  isManager: boolean;
  isViewer: boolean;
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
  const { privilegeLevel } = useAuth();

  return {
    privilegeLevel,
    isAdmin: privilegeLevel === 'admin',
    isManager: privilegeLevel === 'manager' || privilegeLevel === 'admin',
    isViewer: privilegeLevel === 'viewer',
  };
}
