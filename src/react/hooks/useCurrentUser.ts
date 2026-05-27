import { useEffect, useState } from 'react';

export type CurrentUser = {
  id?: string;
  first_name?: string;
  last_name?: string;
  has_custom_photo?: boolean;
  profile_image_url?: string | null;
  photo_v?: string | number;
  privilege_level?: string;
  onboarding_status?: string;
};

declare global {
  interface Window {
    __moHeaderUser?: CurrentUser | null;
  }
}

let _promise: Promise<CurrentUser | null> | null = null;

function fetchCurrentUser(): Promise<CurrentUser | null> {
  if (!_promise) {
    _promise = fetch('/api/auth/user', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? (r.json() as Promise<CurrentUser>) : null))
      .catch(() => null);
  }
  return _promise;
}

/**
 * @deprecated Use `useAuth()` from `../contexts/AuthContext` instead.
 * This hook bypasses the shared AuthContext and does its own fetch deduplication.
 * It is retained so vanilla-JS bridges that dispatch `mo:user` events continue to work.
 */
export function useCurrentUser(): { user: CurrentUser | null; loading: boolean } {
  const [user, setUser] = useState<CurrentUser | null>(() => window.__moHeaderUser || null);
  const [loading, setLoading] = useState<boolean>(() => !window.__moHeaderUser);

  useEffect(() => {
    let cancelled = false;
    fetchCurrentUser().then((u) => {
      if (!cancelled) {
        setUser(u);
        setLoading(false);
        // Publish to window so usePrivilege (and legacy core.js consumers)
        // can read the user on pure-React pages where bootstrap() is never
        // called (e.g. /trades, /ideas). The event is idempotent: pages that
        // also call bootstrap() will simply receive it a second time with the
        // same value.
        window.__moHeaderUser = u;
        try {
          window.dispatchEvent(new CustomEvent('mo:user', { detail: u }));
        } catch {}
      }
    });

    const handler = (e: Event) => {
      const detail = (e as CustomEvent<CurrentUser | null>).detail ?? null;
      if (!cancelled) setUser(detail);
    };
    window.addEventListener('mo:user', handler as EventListener);
    return () => {
      cancelled = true;
      window.removeEventListener('mo:user', handler as EventListener);
    };
  }, []);

  return { user, loading };
}
