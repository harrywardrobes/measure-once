import { useState, useEffect } from 'react';

function readPrivilegeLevel(): string {
  const w = window as unknown as {
    __moHeaderUser?: { privilege_level?: string } | null;
    state?: { user?: { privilege_level?: string } | null };
  };
  const user = w.__moHeaderUser || w.state?.user || null;
  return user?.privilege_level || '';
}

type UsePrivilegeResult = {
  privilegeLevel: string;
  isAdmin: boolean;
  isManager: boolean;
  isViewer: boolean;
};

/**
 * Returns the current user's privilege level and convenience booleans.
 * Reads from the user object published by core.js via `window.__moHeaderUser`
 * and the `mo:user` window event.
 *
 * Use this in all React components that need to gate on privilege.
 */
export function usePrivilege(): UsePrivilegeResult {
  const [privilegeLevel, setPrivilegeLevel] = useState<string>(() => readPrivilegeLevel());

  useEffect(() => {
    const handler = (e: Event) => {
      const user = (e as CustomEvent<{ privilege_level?: string } | null>).detail;
      setPrivilegeLevel(user?.privilege_level || '');
    };
    window.addEventListener('mo:user', handler as EventListener);
    const current = readPrivilegeLevel();
    if (current) setPrivilegeLevel(current);
    return () => window.removeEventListener('mo:user', handler as EventListener);
  }, []);

  return {
    privilegeLevel,
    isAdmin: privilegeLevel === 'admin',
    isManager: privilegeLevel === 'manager' || privilegeLevel === 'admin',
    isViewer: privilegeLevel === 'viewer',
  };
}
