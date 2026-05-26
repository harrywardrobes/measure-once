import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ConnectionService = 'hubspot' | 'google' | 'quickbooks' | 'database';
type ServiceStatus = 'ok' | 'error';
type ToastKind = 'disconnected' | 'reconnected';

interface ToastEntry {
  id: number;
  service: ConnectionService;
  kind: ToastKind;
  message: string;
}

// ── Service copy ──────────────────────────────────────────────────────────────

const SERVICE_COPY: Record<ConnectionService, Record<ToastKind, string>> = {
  hubspot: {
    disconnected: 'HubSpot disconnected — changes may not sync',
    reconnected:  'HubSpot reconnected',
  },
  google: {
    disconnected: 'Google Calendar disconnected',
    reconnected:  'Google Calendar reconnected',
  },
  quickbooks: {
    disconnected: 'QuickBooks disconnected',
    reconnected:  'QuickBooks reconnected',
  },
  database: {
    disconnected: "Database connection lost — your changes couldn't be saved",
    reconnected:  'Database connection restored',
  },
};

// ── Module-level singleton state ──────────────────────────────────────────────
// All island instances in the same bundle share these module-scoped variables.
// This lets multiple ConnectionToastProvider instances stay in sync without
// needing React context to cross island boundaries.
//
// At most one provider instance claims the "renderer" role per page load.
// That instance renders the fixed-position Snackbar stack; all other instances
// are context-only (they supply checkServicesOnMount / notifyApiError /
// notifyReconnected to their subtree but delegate rendering to the renderer).

const _lastKnown = new Map<ConnectionService, ServiceStatus>();
const _currentToasts = new Map<ConnectionService, ToastEntry>();
let _toastIdSeq = 0;
let _onUpdate: (() => void) | null = null;
let _rendererClaimed = false;

function _fire(service: ConnectionService, kind: ToastKind): void {
  const prev = _currentToasts.get(service);
  if (prev && prev.kind === kind) return; // already showing — no-op
  _currentToasts.set(service, {
    id: ++_toastIdSeq,
    service,
    kind,
    message: SERVICE_COPY[service][kind],
  });
  _lastKnown.set(service, kind === 'disconnected' ? 'error' : 'ok');
  _onUpdate?.();
}

function _dismiss(service: ConnectionService): void {
  if (_currentToasts.has(service)) {
    _currentToasts.delete(service);
    _onUpdate?.();
  }
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
  const isConnectionIssue =
    error instanceof TypeError ||
    code === 'HUBSPOT_AUTH'        ||
    code === 'HUBSPOT_UNAVAILABLE' ||
    code === 'DB_ERROR'            ||
    (typeof status === 'number' && status >= 500);
  if (isConnectionIssue) {
    _fire(service, 'disconnected');
  }
}

function _notifyReconnected(service: ConnectionService): void {
  _fire(service, 'reconnected');
}

async function _checkServicesOnMount(): Promise<void> {
  await Promise.allSettled([
    _checkService('hubspot',    '/api/hubspot/status'),
    _checkService('google',     '/api/google/status'),
    _checkService('quickbooks', '/api/quickbooks/status'),
  ]);
}

// ── Context value ─────────────────────────────────────────────────────────────

interface ConnectionToastContextValue {
  /** Call once when a page island mounts (useEffect with []). Hits the three
   *  status endpoints in parallel and fires toasts only on status changes. */
  checkServicesOnMount: () => Promise<void>;
  /** Fire the "disconnected" toast for a service when an API call fails with
   *  a 5xx / network error. Pass the raw caught error — the function decides
   *  whether it is connection-related. */
  notifyApiError: (service: ConnectionService, error: unknown) => void;
  /** Fire the "reconnected" toast for a service (e.g. after a successful save
   *  that follows a disconnected toast). */
  notifyReconnected: (service: ConnectionService) => void;
}

const ConnectionToastContext = createContext<ConnectionToastContextValue | null>(null);

// ── Stable context value (never changes — all functions are module-level) ─────
const STABLE_CONTEXT_VALUE: ConnectionToastContextValue = {
  checkServicesOnMount: _checkServicesOnMount,
  notifyApiError:       _notifyApiError,
  notifyReconnected:    _notifyReconnected,
};

// ── Provider ──────────────────────────────────────────────────────────────────

/**
 * Global connection-status toast provider.
 *
 * Wrap every authenticated island in `main.tsx` (excluding login,
 * set-password, onboarding, and design-visit sign-off). At most one
 * instance per page claims the renderer role and renders the fixed
 * Snackbar stack. All instances expose the same API via React context.
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
      _onUpdate = () => forceRender();

      // Register a window shim so vanilla-JS callers can trigger toasts
      const w = window as unknown as {
        __connectionToast?: {
          notifyApiError:   typeof _notifyApiError;
          notifyReconnected: typeof _notifyReconnected;
        };
      };
      if (!w.__connectionToast) {
        w.__connectionToast = { notifyApiError: _notifyApiError, notifyReconnected: _notifyReconnected };
      }

      return () => {
        _rendererClaimed = false;
        isRendererRef.current = false;
        _onUpdate = null;
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

  const toastList = Array.from(_currentToasts.values());

  return (
    <ConnectionToastContext.Provider value={STABLE_CONTEXT_VALUE}>
      {children}
      {isRendererRef.current && toastList.map((t, i) => (
        <Snackbar
          key={t.id}
          open
          autoHideDuration={t.kind === 'reconnected' ? 5000 : null}
          onClose={(_e, reason) => {
            if (reason === 'clickaway') return;
            _dismiss(t.service);
          }}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
          sx={{
            bottom: {
              xs: `calc(var(--nav-h, 0px) + ${16 + i * 64}px)`,
              sm: `calc(var(--nav-h, 0px) + ${24 + i * 64}px)`,
            },
            zIndex: 'var(--z-toast, 9500)',
          }}
        >
          <Alert
            severity={t.kind === 'disconnected' ? 'warning' : 'success'}
            variant="filled"
            sx={{ width: '100%', minWidth: 280 }}
            action={
              <IconButton
                size="small"
                aria-label="close"
                color="inherit"
                onClick={() => _dismiss(t.service)}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            }
          >
            {t.message}
          </Alert>
        </Snackbar>
      ))}
    </ConnectionToastContext.Provider>
  );
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

/**
 * Returns connection toast helpers from the nearest ConnectionToastProvider.
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
