import React, {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useRef,
} from 'react';
import { CONNECT_MODAL_SHOWN_KEY } from '../constants/localStorageKeys';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ConnectionService = 'hubspot' | 'google' | 'quickbooks' | 'database';
export type ServiceStatus = 'ok' | 'error' | 'warning' | 'checking';
type ToastKind = 'disconnected' | 'reconnected';

// ── Module-level singleton state ──────────────────────────────────────────────
// All island instances in the same bundle share these module-scoped variables.
// This lets ConnectionToastProvider and GlobalHeader stay in sync without
// needing a shared React tree.

const _lastKnown = new Map<ConnectionService, ServiceStatus>([
  ['hubspot',    'checking'],
  ['google',     'checking'],
  ['quickbooks', 'checking'],
  ['database',   'checking'],
]);
const _updateCallbacks = new Set<() => void>();
let _rendererClaimed = false;

function _notifyAll(): void {
  for (const cb of _updateCallbacks) cb();
}

// ── Browser online/offline state ──────────────────────────────────────────────
// Tracked separately from per-service connection status: this reflects the
// device's own connectivity (navigator.onLine) rather than whether a specific
// upstream integration is reachable. Subscribers re-render when it flips.

let _online: boolean =
  typeof navigator === 'undefined' || typeof navigator.onLine === 'undefined'
    ? true
    : navigator.onLine;
const _onlineCallbacks = new Set<() => void>();
let _onlineListenersBound = false;

function _setOnline(next: boolean): void {
  if (_online === next) return;
  _online = next;
  for (const cb of _onlineCallbacks) cb();
}

function _ensureOnlineListeners(): void {
  if (_onlineListenersBound || typeof window === 'undefined') return;
  _onlineListenersBound = true;
  window.addEventListener('online', () => _setOnline(true));
  window.addEventListener('offline', () => _setOnline(false));
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
    if (r.status === 401 || r.status === 403) {
      // Not authenticated — resolve checking to ok so the icon doesn't stay grey
      const prev = _lastKnown.get(service);
      if (prev === 'checking') { _lastKnown.set(service, 'ok'); _notifyAll(); }
      return;
    }
    const data: unknown = await r.json().catch(() => ({}));
    const connected =
      (data as { connected?: boolean }).connected === true ||
      (data as { status?: string }).status === 'connected';
    const code = (data as { code?: string }).code;
    const prev = _lastKnown.get(service);
    if (!connected && prev !== 'error') {
      _fire(service, 'disconnected');
      // If the token exists but can't be decrypted (key rotation), open the
      // modal immediately with a targeted message so users know to reconnect.
      if (code === 'TOKEN_UNREADABLE' || code === 'KEY_MISSING') {
        const unreadableMessage = service === 'quickbooks'
          ? code === 'KEY_MISSING'
            ? 'QuickBooks cannot connect — the encryption key (QB_TOKEN_ENCRYPTION_KEY) is not configured. Set the secret in Replit Secrets, then reconnect.'
            : 'Your QuickBooks connection needs to be refreshed — please reconnect to restore invoice access.'
          : 'Your Google connection needs to be refreshed — please reconnect to restore Calendar and Gmail access.';
        openConnectModal(service, unreadableMessage);
      }
    } else if (connected && prev === 'error') {
      _fire(service, 'reconnected');
    }
    if (connected) {
      _lastKnown.set(service, 'ok');
      _notifyAll();
    }
  } catch {
    // Network-level failure
    const prev = _lastKnown.get(service);
    if (prev !== 'error') _fire(service, 'disconnected');
  }
}

function _notifyApiError(service: ConnectionService, error: unknown, connectMessage?: string): void {
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
    code === 'QB_ERROR'            ||
    code === 'QB_AUTH'             ||
    (typeof status === 'number' && status >= 500);
  if (isRateLimit) {
    _fireWarning(service);
  } else if (isConnectionIssue) {
    _fire(service, 'disconnected');
    if (connectMessage) {
      openConnectModal(service, connectMessage);
    }
  }
}

function _notifyApiWarning(service: ConnectionService): void {
  _fireWarning(service);
}

function _notifyReconnected(service: ConnectionService): void {
  _fire(service, 'reconnected');
}

function _notifyDisconnected(service: ConnectionService): void {
  _fire(service, 'disconnected');
}

const _checkServicesOnMount: () => Promise<void> = _createDedupedCheck(
  () => Promise.allSettled([
    _checkService('hubspot',    '/api/hubspot/status'),
    _checkService('google',     '/api/google/status'),
    _checkService('quickbooks', '/api/quickbooks/status'),
    _checkService('database',   '/api/database/status'),
  ]).then(() => undefined),
);

// ── Modal state ───────────────────────────────────────────────────────────────
// Module-level so the modal and the navbar share state across React roots.

let _modalOpen = false;
let _modalHighlight: ConnectionService | undefined;
let _modalMessage: string | undefined;
const _modalCallbacks = new Set<() => void>();

function _notifyModalAll(): void {
  for (const cb of _modalCallbacks) cb();
}

/**
 * Open the "Connect your services" modal, optionally pre-highlighting a service
 * and displaying an explanatory message above the service rows.
 * This is the manual (always-allowed) path — no session-flag check.
 */
export function openConnectModal(service?: ConnectionService, message?: string): void {
  _modalOpen = true;
  _modalHighlight = service;
  _modalMessage = message;
  _notifyModalAll();
}

/**
 * Close the "Connect your services" modal.
 */
export function closeConnectModal(): void {
  _modalOpen = false;
  _modalHighlight = undefined;
  _modalMessage = undefined;
  _notifyModalAll();
}

// ── Context value ─────────────────────────────────────────────────────────────

interface ConnectionToastContextValue {
  /** Call once when a page island mounts (useEffect with []). Hits the three
   *  status endpoints in parallel and updates header icons only on status changes. */
  checkServicesOnMount: () => Promise<void>;
  /** Update service status to 'error' (red) when an API call fails with a
   *  5xx / network error. Pass the raw caught error — the function decides
   *  whether it is connection-related. Rate-limit errors (429) map to 'warning'.
   *  Pass an optional `connectMessage` to open the "Connect your services" modal
   *  with an explanatory message when the error is a connection-level failure. */
  notifyApiError: (service: ConnectionService, error: unknown, connectMessage?: string) => void;
  /** Update service status to 'warning' (amber) — for partial failures such as
   *  rate-limiting where the service is reachable but degraded. */
  notifyApiWarning: (service: ConnectionService) => void;
  /** Clear the service's error/warning status (e.g. after a successful retry). */
  notifyReconnected: (service: ConnectionService) => void;
  /** Explicitly mark a service as disconnected — e.g. after a manual disconnect
   *  action succeeds and the user initiated the disconnect intentionally. */
  notifyDisconnected: (service: ConnectionService) => void;
}

const ConnectionToastContext = createContext<ConnectionToastContextValue | null>(null);

// ── Stable context value (never changes — all functions are module-level) ─────
const STABLE_CONTEXT_VALUE: ConnectionToastContextValue = {
  checkServicesOnMount: _checkServicesOnMount,
  notifyApiError:       _notifyApiError,
  notifyApiWarning:     _notifyApiWarning,
  notifyReconnected:    _notifyReconnected,
  notifyDisconnected:   _notifyDisconnected,
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
          notifyApiError:    typeof _notifyApiError;
          notifyApiWarning:  typeof _notifyApiWarning;
          notifyReconnected: typeof _notifyReconnected;
          openConnectModal:  typeof openConnectModal;
        };
      };
      if (!w.__connectionToast) {
        w.__connectionToast = {
          notifyApiError:    _notifyApiError,
          notifyApiWarning:  _notifyApiWarning,
          notifyReconnected: _notifyReconnected,
          openConnectModal,
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

  // Auto-open: watch for service error transitions and open the modal once per
  // session when the device is online and the session flag hasn't been set yet.
  useEffect(() => {
    // Snapshot of statuses at the time we subscribe, so we can detect transitions.
    let prevSnapshot = new Map(_lastKnown);

    const cb = () => {
      // Skip auto-open while offline — every status would fail and the modal
      // is not actionable anyway.
      if (!_online) {
        prevSnapshot = new Map(_lastKnown);
        return;
      }

      // Find any connectable service that just transitioned into 'error'.
      // We intentionally exclude 'status-only' services (e.g. Database) because
      // they have no row in the modal — highlighting them would open the modal
      // with no visible highlighted service, which is confusing. The modal still
      // opens without a highlight so the user sees the overview.
      const CONNECTABLE: ReadonlySet<ConnectionService> = new Set(['google', 'quickbooks', 'hubspot']);
      let firstNewError: ConnectionService | undefined;
      for (const [svc, status] of _lastKnown) {
        if (status === 'error' && prevSnapshot.get(svc) !== 'error') {
          if (!firstNewError && CONNECTABLE.has(svc)) firstNewError = svc;
        }
      }
      prevSnapshot = new Map(_lastKnown);

      if (!firstNewError) return;

      // Only auto-open once per browser session.
      let alreadyShown = false;
      try {
        alreadyShown = !!sessionStorage.getItem(CONNECT_MODAL_SHOWN_KEY);
      } catch {
        // Private browsing / quota — treat as not shown.
      }
      if (alreadyShown) return;

      try {
        sessionStorage.setItem(CONNECT_MODAL_SHOWN_KEY, '1');
      } catch {
        // Quota / private browsing — still open the modal, just won't persist.
      }
      openConnectModal(firstNewError);
    };

    _updateCallbacks.add(cb);
    return () => { _updateCallbacks.delete(cb); };
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

/**
 * Returns whether the device currently has network connectivity
 * (`navigator.onLine`), re-rendering when the browser fires `online` /
 * `offline` events. Used by GlobalHeader to show an offline indicator.
 *
 * `navigator.onLine === false` is authoritative (definitely offline); `true`
 * only means a network interface is up, not that the server is reachable — so
 * pair this with the per-service status for full connection awareness.
 */
export function useOnlineStatus(): boolean {
  const [, forceRender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    _ensureOnlineListeners();
    // Re-sync in case connectivity changed between module init and mount.
    if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
      _setOnline(navigator.onLine);
    }
    const cb = () => forceRender();
    _onlineCallbacks.add(cb);
    return () => { _onlineCallbacks.delete(cb); };
  }, []);

  return _online;
}

/**
 * Returns the current state of the "Connect your services" modal, and helpers
 * to open/close it. Re-renders when the modal state changes.
 *
 * `openConnectModal(service?, message?)` — opens the modal, optionally
 * pre-highlighting the named service and showing an explanatory message above
 * the service rows. This is the manual path and always works regardless of
 * the per-session auto-open flag.
 *
 * `closeConnectModal()` — closes the modal.
 *
 * @example
 * const { open, highlightService, message, openConnectModal, closeConnectModal } = useConnectModal();
 */
export function useConnectModal(): {
  open: boolean;
  highlightService: ConnectionService | undefined;
  message: string | undefined;
  openConnectModal: typeof openConnectModal;
  closeConnectModal: typeof closeConnectModal;
} {
  const [, forceRender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const cb = () => forceRender();
    _modalCallbacks.add(cb);
    return () => { _modalCallbacks.delete(cb); };
  }, []);

  return {
    open: _modalOpen,
    highlightService: _modalHighlight,
    message: _modalMessage,
    openConnectModal,
    closeConnectModal,
  };
}
