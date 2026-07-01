import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import Button from '@mui/material/Button';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';

type ToastSeverity = 'success' | 'error' | 'warning' | 'info';

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastMessage {
  id: number;
  msg: string;
  severity: ToastSeverity;
  action?: ToastAction;
  // A number is an auto-hide delay (ms); `null` keeps the toast open until the
  // user acts on or dismisses it (used by the update prompt).
  duration?: number | null;
}

interface ShowToastOptions {
  severity?: ToastSeverity;
  duration?: number;
}

interface ToastContextValue {
  /**
   * Show a toast notification.
   *
   * @param msg     The message to display.
   * @param isError Deprecated — pass `{ severity: 'error' }` instead.
   *                Kept for backwards compatibility; maps to severity='error'.
   * @param options Optional severity and duration overrides.
   */
  showToast: (msg: string, isError?: boolean, options?: ShowToastOptions) => void;
  showToastWithAction: (
    msg: string,
    action: ToastAction,
    options?: { duration?: number | null; severity?: ToastSeverity },
  ) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let _globalIdCounter = 0;

/**
 * Provides a shared MUI Snackbar for the React island it wraps.
 *
 * Vanilla-JS callers (core.js, inline scripts) can trigger it via:
 *   window.toast(msg, isError?)
 *
 * The shim is registered once by the first ToastProvider that mounts (usually
 * the GlobalHeader island which loads on every page). If window.toast is
 * already set it is left untouched so only one island owns the shim.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const current = toasts[0] ?? null;

  const showToast = useCallback((msg: string, isError = false, options?: ShowToastOptions) => {
    const id = ++_globalIdCounter;
    const severity: ToastSeverity =
      options?.severity ?? (isError ? 'error' : 'success');
    setToasts(prev => [...prev, { id, msg, severity, duration: options?.duration }]);
  }, []);

  const showToastWithAction = useCallback(
    (
      msg: string,
      action: ToastAction,
      options?: { duration?: number | null; severity?: ToastSeverity },
    ) => {
      const id = ++_globalIdCounter;
      setToasts(prev => [
        ...prev,
        {
          id,
          msg,
          severity: options?.severity ?? 'success',
          action,
          duration: options?.duration,
        },
      ]);
    },
    [],
  );

  const dismissCurrent = useCallback(() => {
    setToasts(prev => prev.slice(1));
  }, []);

  const handleClose = useCallback((_: unknown, reason?: string) => {
    if (reason === 'clickaway') return;
    dismissCurrent();
  }, [dismissCurrent]);

  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  const showToastWithActionRef = useRef(showToastWithAction);
  showToastWithActionRef.current = showToastWithAction;

  useEffect(() => {
    const w = window as unknown as {
      toast?: (m: string, e?: boolean | ToastSeverity) => void;
      showToast?: (m: string, e?: boolean | ToastSeverity) => void;
      showToastWithAction?: (
        msg: string,
        action: ToastAction,
        options?: { duration?: number | null; severity?: ToastSeverity },
      ) => void;
      __toastProvider?: boolean;
    };
    if (!w.__toastProvider) {
      w.__toastProvider = true;
      w.toast = (m: string, e?: boolean | ToastSeverity) => {
        if (typeof e === 'string') {
          showToastRef.current(m, false, { severity: e });
        } else {
          showToastRef.current(m, !!e);
        }
      };
      w.showToastWithAction = (
        msg: string,
        action: ToastAction,
        options?: { duration?: number | null; severity?: ToastSeverity },
      ) => {
        showToastWithActionRef.current(msg, action, options);
      };
    }
  }, []);

  const actionNode = current?.action ? (
    <Button
      size="small"
      onClick={() => {
        current.action!.onClick();
        dismissCurrent();
      }}
      sx={{
        color: 'common.white',
        fontWeight: 700,
        textTransform: 'none',
        fontSize: '.82rem',
        ml: 1,
        '&:hover': { background: 'rgba(255,255,255,.15)' },
      }}
    >
      {current.action.label}
    </Button>
  ) : undefined;

  return (
    <ToastContext.Provider value={{ showToast, showToastWithAction }}>
      {children}
      {current && (
        <Snackbar
          key={current.id}
          open
          autoHideDuration={current.duration === null ? null : (current.duration ?? 3500)}
          onClose={handleClose}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
          sx={{
            zIndex: 'var(--z-toast, 9500)',
            bottom: 'calc(var(--bottom-nav-height, 0px) + var(--bottom-action-bar-height, 0px) + env(safe-area-inset-bottom)) !important',
          }}
        >
          <Alert
            onClose={dismissCurrent}
            severity={current.severity}
            variant="filled"
            action={actionNode}
            sx={{ width: '100%', minWidth: 240 }}
          >
            {current.msg}
          </Alert>
        </Snackbar>
      )}
    </ToastContext.Provider>
  );
}

/**
 * Returns the full toast context value from the nearest ToastProvider.
 * Falls back to window.toast / console.log if no provider is mounted.
 */
export function useToastContext(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (ctx) return ctx;
  const fallbackShowToast = (msg: string, isError?: boolean) => {
    const w = window as unknown as { toast?: (m: string, e?: boolean) => void };
    if (typeof w.toast === 'function') w.toast(msg, isError);
  };
  return {
    showToast: fallbackShowToast,
    showToastWithAction: (msg: string, action: ToastAction) => {
      fallbackShowToast(msg);
      console.log('[toast action available]', action.label);
    },
  };
}

/**
 * Returns a stable `showToast(msg, isError?)` function from the nearest
 * ToastProvider. Falls back to `window.toast()` or `console.log` if no
 * provider is mounted (e.g. in unit tests).
 */
export function useToast(): (msg: string, isError?: boolean) => void {
  const ctx = useContext(ToastContext);
  if (ctx) return ctx.showToast;
  return (msg: string, isError?: boolean) => {
    const w = window as unknown as { toast?: (m: string, e?: boolean) => void };
    if (typeof w.toast === 'function') w.toast(msg, isError);
  };
}
