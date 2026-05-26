import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';

interface ToastMessage {
  id: number;
  msg: string;
  isError: boolean;
}

interface ToastContextValue {
  showToast: (msg: string, isError?: boolean) => void;
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

  const handleClose = useCallback((_: unknown, reason?: string) => {
    if (reason === 'clickaway') return;
    setToasts(prev => prev.slice(1));
  }, []);

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

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {current && (
        <Snackbar
          key={current.id}
          open
          autoHideDuration={3500}
          onClose={handleClose}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
          sx={{ zIndex: 'var(--z-toast, 9500)' }}
        >
          <Alert
            onClose={() => setToasts(prev => prev.slice(1))}
            severity={current.isError ? 'error' : 'success'}
            variant="filled"
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
