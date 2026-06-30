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
  duration?: number;
  /** Undoable toast: the action is "Undo"; `onCommit` runs if it is NOT undone. */
  undoable?: boolean;
  /** Deferred work, run once when an undoable toast dismisses without an undo. */
  onCommit?: () => void;
}

interface ShowToastOptions {
  severity?: ToastSeverity;
  duration?: number;
}

/** Options for showUndoableAction — a deferred-commit ("Undo Send") toast. */
interface UndoableActionOptions {
  /** Run when the user clicks Undo within the window. The committed work never fires. */
  onUndo?: () => void;
  /**
   * The deferred work. Runs exactly once when the toast dismisses WITHOUT an undo
   * (auto-hide timeout, or the user closing it early). Never runs if Undo is clicked.
   */
  onCommit: () => void;
  /** How long the undo window stays open. Defaults to 6000ms. */
  duration?: number;
  severity?: ToastSeverity;
  /** Action button label. Defaults to "Undo". */
  undoLabel?: string;
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
    options?: { duration?: number; severity?: ToastSeverity },
  ) => void;
  /**
   * Show a deferred-commit "Undo" toast (Gmail-style "Undo Send"). The work in
   * `onCommit` does NOT run immediately — it fires only once the toast dismisses
   * without the user pressing Undo. Pressing Undo runs `onUndo` and cancels the
   * commit entirely. Use this for actions the user should be able to take back
   * before they actually happen (e.g. sending an email).
   */
  showUndoableAction: (msg: string, options: UndoableActionOptions) => void;
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
      options?: { duration?: number; severity?: ToastSeverity },
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

  const showUndoableAction = useCallback((msg: string, options: UndoableActionOptions) => {
    const id = ++_globalIdCounter;
    setToasts(prev => [
      ...prev,
      {
        id,
        msg,
        severity: options.severity ?? 'info',
        duration: options.duration ?? 6000,
        undoable: true,
        onCommit: options.onCommit,
        action: { label: options.undoLabel ?? 'Undo', onClick: () => { options.onUndo?.(); } },
      },
    ]);
  }, []);

  // Ref-mirror of the visible toast so the commit logic can read it without
  // recreating the close handlers on every queue change.
  const currentRef = useRef<ToastMessage | null>(null);
  currentRef.current = current;
  // Tracks toast ids whose fate is already decided (committed or undone) so the
  // deferred commit fires at most once per undoable toast.
  const settledRef = useRef<Set<number>>(new Set());

  // Fire a pending undoable toast's deferred work, unless it was already settled
  // (e.g. the user pressed Undo). No-op for ordinary (non-undoable) toasts.
  const commitCurrent = useCallback(() => {
    const t = currentRef.current;
    if (t && t.undoable && !settledRef.current.has(t.id)) {
      settledRef.current.add(t.id);
      try { t.onCommit?.(); } catch { /* commit failures surface via their own toasts */ }
    }
  }, []);

  const dismissCurrent = useCallback(() => {
    setToasts(prev => prev.slice(1));
  }, []);

  const handleClose = useCallback((_: unknown, reason?: string) => {
    if (reason === 'clickaway') return;
    // Auto-hide timeout / escape: an undoable toast was NOT undone, so commit it.
    commitCurrent();
    dismissCurrent();
  }, [commitCurrent, dismissCurrent]);

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
        options?: { duration?: number; severity?: ToastSeverity },
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
        options?: { duration?: number; severity?: ToastSeverity },
      ) => {
        showToastWithActionRef.current(msg, action, options);
      };
    }
  }, []);

  const actionNode = current?.action ? (
    <Button
      size="small"
      onClick={() => {
        // Pressing the action on an undoable toast IS the undo — settle it first
        // so the auto-hide/close path can never also fire the deferred commit.
        if (current.undoable) settledRef.current.add(current.id);
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
    <ToastContext.Provider value={{ showToast, showToastWithAction, showUndoableAction }}>
      {children}
      {current && (
        <Snackbar
          key={current.id}
          open
          autoHideDuration={current.duration ?? 3500}
          onClose={handleClose}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
          sx={{
            zIndex: 'var(--z-toast, 9500)',
            bottom: 'calc(var(--bottom-nav-height, 0px) + var(--bottom-action-bar-height, 0px) + env(safe-area-inset-bottom)) !important',
          }}
        >
          <Alert
            onClose={() => { commitCurrent(); dismissCurrent(); }}
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
    // No provider mounted: there is no undo window, so commit immediately.
    showUndoableAction: (msg: string, options: UndoableActionOptions) => {
      fallbackShowToast(msg);
      try { options.onCommit(); } catch { /* surfaced via its own toast */ }
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
