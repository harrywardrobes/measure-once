import React, {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useRef,
} from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ConnectionService = 'hubspot' | 'google' | 'quickbooks' | 'database';
export type ServiceStatus = 'ok' | 'error' | 'warning';
type ToastKind = 'disconnected' | 'reconnected';

// ── Module-level singleton state ──────────────────────────────────────────────
// All island instances in the same bundle share these module-scoped variables.
// This lets ConnectionToastProvider and GlobalHeader stay in sync without
// needing a shared React tree.

const _lastKnown = new Map<ConnectionService, ServiceStatus>();
const _updateCallbacks = new Set<() => void>();
let _rendererClaimed = false;

function _notifyAll(): void {
  for (const cb of _updateCallbacks) cb();
}

function _fire(service: ConnectionService, kind: ToastKind): void {
  const newStatus: ServiceStatus = kind === 'disconnected' ? 'error' : 'ok';
  const prev = _lastKnown.get(service);
  if (prev === newStatus) return; // no change — skip
  _lastKnown.set(service, newStatus);
  _notifyAll();
}

function _fireWarning(service: ConnectionService): void {
  const prev = _lastKnown.get(service);
  if (prev === 'warning') return;
  _lastKnown.set(service, 'warning');
  _notifyAll();
}

function _dismiss(service: ConnectionService): void {
  const prev = _lastKnown.get(service);
  if (prev && prev !== 'ok') {
    _lastKnown.set(service, 'ok');
    _notifyAll();
  }
}

// ── Dedup / cooldown helpers (exported for unit tests) ────────────────────────

/** Duration (ms) of the mount-check cooldown. Re-exported for tests. */
export const MOUNT_CHECK_COOLDOWN_MS = 30_000;

/**
 * Factory that wraps a raw check function with:
 *  - promise deduplication: concurrent callers share the in-flight promise
 *  - cooldown: skips re-polling within MOUNT_CHECK_COOLDOWN_MS of the last check
 *
 * Accepting `checkFn` and `getNow` as parameters keeps the logic pure and
 * trivially testable without mocking module state.
 */
export function _createDedupedCheck(
  checkFn: () => Promise<void>,
  getNow: () => number = Date.now,
): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let lastCheckAt = -Infinity;

  return function dedupedCheck(): Promise<void> {
    // Share an existing in-flight promise so concurrent mount calls don't
    // all fire their own parallel sets of HTTP requests.
    if (inFlight) return inFlight;

    // Skip if we polled recently enough.
    if (getNow() - lastCheckAt < MOUNT_CHECK_COOLDOWN_MS) return Promise.resolve();

    lastCheckAt = getNow();
    inFlight = checkFn().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

// ── Core logic ────────────────────────────────────────────────────────────────

async function _checkService(service: ConnectionService, url: string): Promise<void> {
  try {
    const r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (r.status === 401 || r.status === 403) return; // not authenticated — skip
    const data: unknown = await r.json().catch(() => ({}));
    const connected =
      (data as { connected?: boolean }).connected === true ||
      (data as { status?: string }).status === 'connected';
    const prev = _lastKnown.get(service);
    if (!connected && prev !== 'error') {
      _fire(service, 'disconnected');
    } else if (connected && prev === 'error') {
      _fire(service, 'reconnected');
    }
    if (connected) _lastKnown.set(service, 'ok');
  } catch {
    // Network-level failure
    const prev = _lastKnown.get(service);
    if (prev !== 'error') _fire(service, 'disconnected');
  }
}

function _notifyApiError(service: ConnectionService, error: unknown): void {
  const code = (error as { code?: string }).code;
  const status = (error as { status?: number }).status;
  const isRateLimit =
    code === 'HUBSPOT_RATE_LIMITED' ||
    (typeof status === 'number' && status === 429);
  const isConnectionIssue =
    error instanceof TypeError ||
    code === 'HUBSPOT_AUTH'        ||
    code === 'HUBSPOT_UNAVAILABLE' ||
    code === 'DB_ERROR'            ||
    (typeof status === 'number' && status >= 500);
  if (isRateLimit) {
    _fireWarning(service);
  } else if (isConnectionIssue) {
    _fire(service, 'disconnected');
  }
}

function _notifyApiWarning(service: ConnectionService): void {
  _fireWarning(service);
}

function _notifyReconnected(service: ConnectionService): void {
  _fire(service, 'reconnected');
}

const _checkServicesOnMount: () => Promise<void> = _createDedupedCheck(
  () => Promise.allSettled([
    _checkService('hubspot',    '/api/hubspot/status'),
    _checkService('google',     '/api/google/status'),
    _checkService('quickbooks', '/api/quickbooks/status'),
  ]).then(() => undefined),
);

// ── Context value ─────────────────────────────────────────────────────────────

interface ConnectionToastContextValue {
  /** Call once when a page island mounts (useEffect with []). Hits the three
   *  status endpoints in parallel and updates header icons only on status changes. */
  checkServicesOnMount: () => Promise<void>;
  /** Update service status to 'error' (red) when an API call fails with a
   *  5xx / network error. Pass the raw caught error — the function decides
   *  whether it is connection-related. Rate-limit errors (429) map to 'warning'. */
  notifyApiError: (service: ConnectionService, error: unknown) => void;
  /** Update service status to 'warning' (amber) — for partial failures such as
   *  rate-limiting where the service is reachable but degraded. */
  notifyApiWarning: (service: ConnectionService) => void;
  /** Clear the service's error/warning status (e.g. after a successful retry). */
  notifyReconnected: (service: ConnectionService) => void;
}

const ConnectionToastContext = createContext<ConnectionToastContextValue | null>(null);

// ── Stable context value (never changes — all functions are module-level) ─────
const STABLE_CONTEXT_VALUE: ConnectionToastContextValue = {
  checkServicesOnMount: _checkServicesOnMount,
  notifyApiError:       _notifyApiError,
  notifyApiWarning:     _notifyApiWarning,
  notifyReconnected:    _notifyReconnected,
};

// ── Provider ──────────────────────────────────────────────────────────────────

/**
 * Global connection-status provider.
 *
 * Wrap every authenticated island in `main.tsx` (excluding login,
 * set-password, onboarding, and design-visit sign-off). At most one
 * instance per page claims the "renderer" role. All instances expose
 * the same API via React context.
 *
 * Connection errors/warnings are shown as persistent icons in the
 * GlobalHeader (via useServiceStatuses) rather than bottom-right toasts.
 *
 * Suppressed pages: /login, /set-password, /onboarding, /design-visit/*
 */
export function ConnectionToastProvider({ children }: { children: React.ReactNode }) {
  const isRendererRef = useRef(false);
  const [, forceRender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (!_rendererClaimed) {
      _rendererClaimed = true;
      isRendererRef.current = true;
      const cb = () => forceRender();
      _updateCallbacks.add(cb);

      // Register a window shim so vanilla-JS callers can trigger status updates
      const w = window as unknown as {
        __connectionToast?: {
          notifyApiError:   typeof _notifyApiError;
          notifyApiWarning: typeof _notifyApiWarning;
          notifyReconnected: typeof _notifyReconnected;
        };
      };
      if (!w.__connectionToast) {
        w.__connectionToast = {
          notifyApiError:    _notifyApiError,
          notifyApiWarning:  _notifyApiWarning,
          notifyReconnected: _notifyReconnected,
        };
      }

      return () => {
        _rendererClaimed = false;
        isRendererRef.current = false;
        _updateCallbacks.delete(cb);
      };
    }
    return undefined;
  }, []);

  // Bridge: listen for legacy Google auth window events emitted by core.js
  useEffect(() => {
    const onConnected    = () => _fire('google', 'reconnected');
    const onDisconnected = () => _fire('google', 'disconnected');
    window.addEventListener('mo:google-auth-connected',    onConnected);
    window.addEventListener('mo:google-auth-disconnected', onDisconnected);
    return () => {
      window.removeEventListener('mo:google-auth-connected',    onConnected);
      window.removeEventListener('mo:google-auth-disconnected', onDisconnected);
    };
  }, []);

  return (
    <ConnectionToastContext.Provider value={STABLE_CONTEXT_VALUE}>
      {children}
    </ConnectionToastContext.Provider>
  );
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

/**
 * Returns connection status helpers from the nearest ConnectionToastProvider.
 * Falls back to module-level functions if called outside a provider (e.g.
 * in unit tests or vanilla-JS-driven islands that lack the provider).
 */
export function useConnectionToast(): ConnectionToastContextValue {
  const ctx = useContext(ConnectionToastContext);
  return ctx ?? STABLE_CONTEXT_VALUE;
}

/**
 * Drop-in hook for page components: calls `checkServicesOnMount()` once when
 * the island mounts (empty dep array). Import and call at the top of any
 * authenticated page component — no arguments needed.
 *
 * @example
 * export function CustomersPage() {
 *   useConnectionCheck();
 *   // ...
 * }
 */
export function useConnectionCheck(): void {
  useEffect(() => {
    _checkServicesOnMount().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * Returns the current service status map and re-renders when any status changes.
 * Used by GlobalHeader to render the service status icon row.
 *
 * Hidden when all services are 'ok'; red Badge for 'error'; amber Badge for 'warning'.
 *
 * @example
 * const statuses = useServiceStatuses();
 * const hubspotStatus = statuses.get('hubspot'); // 'ok' | 'error' | 'warning' | undefined
 */
export function useServiceStatuses(): Map<ConnectionService, ServiceStatus> {
  const [, forceRender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const cb = () => forceRender();
    _updateCallbacks.add(cb);
    return () => { _updateCallbacks.delete(cb); };
  }, []);

  return _lastKnown;
}
