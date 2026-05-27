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

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastMessage {
  id: number;
  msg: string;
  isError: boolean;
  action?: ToastAction;
  duration?: number;
}

interface ToastContextValue {
  showToast: (msg: string, isError?: boolean) => void;
  showToastWithAction: (msg: string, action: ToastAction, options?: { duration?: number }) => void;
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

  const showToast = useCallback((msg: string, isError = false) => {
    const id = ++_globalIdCounter;
    setToasts(prev => [...prev, { id, msg, isError }]);
  }, []);

  const showToastWithAction = useCallback(
    (msg: string, action: ToastAction, options?: { duration?: number }) => {
      const id = ++_globalIdCounter;
      setToasts(prev => [
        ...prev,
        { id, msg, isError: false, action, duration: options?.duration },
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

  useEffect(() => {
    const w = window as unknown as {
      toast?: (m: string, e?: boolean) => void;
      showToast?: (m: string, e?: boolean) => void;
      __toastProvider?: boolean;
    };
    if (!w.__toastProvider) {
      w.__toastProvider = true;
      w.toast = (m: string, e?: boolean) => showToastRef.current(m, !!e);
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
        color: '#fff',
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
          autoHideDuration={current.duration ?? 3500}
          onClose={handleClose}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
          sx={{ zIndex: 'var(--z-toast, 9500)' }}
        >
          <Alert
            onClose={dismissCurrent}
            severity={current.isError ? 'error' : 'success'}
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
