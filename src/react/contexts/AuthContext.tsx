import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { CurrentUser } from '../hooks/useCurrentUser';

interface AuthState {
  user: CurrentUser | null;
  loading: boolean;
  privilegeLevel: string;
  googleConnected: boolean;
  qbConnected: boolean;
}

interface AuthContextValue extends AuthState {
  refetch: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

let _promise: Promise<CurrentUser | null> | null = null;

async function attemptFetchUser(): Promise<CurrentUser | null> {
  const r = await fetch('/api/auth/user', { headers: { Accept: 'application/json' } });
  if (r.ok) return r.json() as Promise<CurrentUser>;
  if (r.status === 401) return null; // genuinely unauthenticated — do not retry
  // Any other status (5xx, etc.) — throw so the caller can retry
  throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
}

function fetchUser(): Promise<CurrentUser | null> {
  if (!_promise) {
    _promise = attemptFetchUser().catch(async () => {
      // Transient server/network error — wait briefly and retry once before
      // treating the session as expired. This prevents a momentary 5xx from
      // the /api/auth/user endpoint kicking a genuinely logged-in user to /login.
      await new Promise(resolve => setTimeout(resolve, 1500));
      return attemptFetchUser().catch(() => null);
    });
  }
  return _promise;
}

interface AuthStatusResponse { google: boolean; hubspot: boolean; }
interface QbStatusResponse   { connected: boolean; }

async function fetchAuthStatus(): Promise<{ googleConnected: boolean; qbConnected: boolean }> {
  const [authRes, qbRes] = await Promise.allSettled([
    fetch('/auth/status',              { headers: { Accept: 'application/json' } })
      .then(r => r.ok ? (r.json() as Promise<AuthStatusResponse>) : null).catch(() => null),
    fetch('/api/quickbooks/status',    { headers: { Accept: 'application/json' } })
      .then(r => r.ok ? (r.json() as Promise<QbStatusResponse>)   : null).catch(() => null),
  ]);
  const auth = authRes.status === 'fulfilled' ? authRes.value : null;
  const qb   = qbRes.status  === 'fulfilled' ? qbRes.value   : null;
  return {
    googleConnected: !!(auth?.google),
    qbConnected:     !!(qb?.connected),
  };
}

function readPrivilege(user: CurrentUser | null): string {
  return user?.privilege_level ?? ''; // privilege-read-ok: canonical AuthContext derivation — maps raw user field to typed privilegeLevel
}

/**
 * Provides auth state (user, privilege, google/QB connection status) to the
 * React island tree. Fed by a single deduplicated fetch of `/api/auth/user`
 * on mount and kept in sync via the `mo:user`, `mo:google-auth-connected`,
 * and `mo:google-auth-disconnected` window events that `core.js` dispatches.
 *
 * Keeps `window.__moHeaderUser` in sync for vanilla-JS bridges.
 *
 * Mount this once at the `AppThemeProvider` level so every island in the same
 * React root shares the same auth state without additional fetches.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(
    () => (window as unknown as { __moHeaderUser?: CurrentUser | null }).__moHeaderUser ?? null,
  );
  const [loading, setLoading] = useState(() => !((window as unknown as { __moHeaderUser?: CurrentUser | null }).__moHeaderUser));
  const [googleConnected, setGoogleConnected] = useState(false);
  const [qbConnected, setQbConnected] = useState(false);

  const applyUser = useCallback((u: CurrentUser | null) => {
    setUser(u);
    setLoading(false);
    (window as unknown as { __moHeaderUser?: CurrentUser | null }).__moHeaderUser = u;
  }, []);

  const fetchAndApply = useCallback(async () => {
    _promise = null;
    const u = await fetchUser();
    applyUser(u);
  }, [applyUser]);

  useEffect(() => {
    let cancelled = false;

    fetchUser().then(u => {
      if (!cancelled) applyUser(u);
    });

    fetchAuthStatus().then(({ googleConnected: g, qbConnected: q }) => {
      if (!cancelled) {
        setGoogleConnected(g);
        setQbConnected(q);
      }
    });

    const onUser = (e: Event) => {
      const u = (e as CustomEvent<CurrentUser | null>).detail ?? null;
      if (!cancelled) applyUser(u);
    };
    const onGoogleConnected = () => {
      if (!cancelled) setGoogleConnected(true);
    };
    const onGoogleDisconnected = () => {
      if (!cancelled) setGoogleConnected(false);
    };
    const onQbConnected = () => {
      if (!cancelled) setQbConnected(true);
    };
    const onQbDisconnected = () => {
      if (!cancelled) setQbConnected(false);
    };

    window.addEventListener('mo:user', onUser as EventListener);
    window.addEventListener('mo:google-auth-connected', onGoogleConnected);
    window.addEventListener('mo:google-auth-disconnected', onGoogleDisconnected);
    window.addEventListener('mo:qb-auth-connected', onQbConnected);
    window.addEventListener('mo:qb-auth-disconnected', onQbDisconnected);

    return () => {
      cancelled = true;
      window.removeEventListener('mo:user', onUser as EventListener);
      window.removeEventListener('mo:google-auth-connected', onGoogleConnected);
      window.removeEventListener('mo:google-auth-disconnected', onGoogleDisconnected);
      window.removeEventListener('mo:qb-auth-connected', onQbConnected);
      window.removeEventListener('mo:qb-auth-disconnected', onQbDisconnected);
    };
  }, [applyUser]);

  const value: AuthContextValue = {
    user,
    loading,
    privilegeLevel: readPrivilege(user),
    googleConnected,
    qbConnected,
    refetch: fetchAndApply,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Returns the current auth state from the nearest `AuthProvider`.
 *
 * If no `AuthProvider` is present (e.g. Storybook), falls back to reading
 * `window.__moHeaderUser` directly so stories don't crash.
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx) return ctx;

  const w = window as unknown as {
    __moHeaderUser?: CurrentUser | null;
    state?: { authStatus?: { google?: boolean } };
  };
  const user = w.__moHeaderUser ?? null;
  return {
    user,
    loading: false,
    privilegeLevel: readPrivilege(user),
    googleConnected: !!(w.state?.authStatus?.google),
    qbConnected: false,
    refetch: async () => {},
  };
}
