import { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Slide from '@mui/material/Slide';
import Typography from '@mui/material/Typography';
import GlobalStyles from '@mui/material/GlobalStyles';

// ── Types ─────────────────────────────────────────────────────────────────────

type BarMode = 'undo' | 'confirm' | 'unsaved';

interface BarState {
  mode: BarMode | null;
  message: string;
  action: (() => void | Promise<void>) | null;
  onSave?: (() => void | Promise<void>) | null;
  onDiscard?: (() => void | Promise<void>) | null;
}

const CLOSED: BarState = { mode: null, message: '', action: null };

// ── Window API declarations ───────────────────────────────────────────────────

declare global {
  interface Window {
    showBottomUndo: (message: string, onUndo: () => void | Promise<void>) => void;
    showBottomConfirm: (message: string, onConfirm: () => void | Promise<void>) => void;
    showUnsavedChangesBar: (
      onSave: () => void | Promise<void>,
      onDiscard: () => void | Promise<void>,
    ) => void;
    closeBottomBar: () => void;
    runBottomAction: () => Promise<void>;
  }
}

// ── Shared button styles ──────────────────────────────────────────────────────

const outlinedSx = {
  color: 'rgba(255,255,255,0.75)',
  borderColor: 'rgba(255,255,255,0.2)',
  '&:hover': { bgcolor: 'rgba(255,255,255,0.1)', borderColor: 'rgba(255,255,255,0.2)' },
} as const;

const filledSx = {
  bgcolor: 'var(--orchid)',
  color: 'common.white',
  '&:hover': { bgcolor: 'var(--orchid-deep)' },
} as const;

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * BottomActionBar — a persistent mount that replaces the manual `#bottom-bar`
 * DOM manipulation in `workflow-core.js`.
 *
 * Exposes five window globals consumed by vanilla-JS callers:
 *   • window.showBottomUndo(message, onUndo)
 *   • window.showBottomConfirm(message, onConfirm)
 *   • window.showUnsavedChangesBar(onSave, onDiscard)
 *   • window.closeBottomBar()
 *   • window.runBottomAction()
 *
 * Mounted at #app-bottom-bar-mount (injected by chrome.js alongside the other
 * shell islands).
 */
export function BottomActionBar() {
  const [bar, setBarState] = useState<BarState>(CLOSED);
  const barRef = useRef<BarState>(CLOSED);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const setBar = useCallback((next: BarState) => {
    barRef.current = next;
    setBarState(next);
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Keep --bottom-action-bar-height in sync so ToastContext can stack above it.
  // Uses a ResizeObserver on the bar's Box so the value tracks the actual
  // rendered height rather than a hard-coded constant.
  useEffect(() => {
    const root = document.documentElement;

    if (bar.mode === null) {
      root.style.removeProperty('--bottom-action-bar-height');
      return;
    }

    const el = boxRef.current;
    if (!el) return;

    const ro = new ResizeObserver(entries => {
      const block = entries[0]?.borderBoxSize?.[0]?.blockSize;
      if (block !== undefined) {
        root.style.setProperty('--bottom-action-bar-height', `${block}px`);
      }
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      root.style.removeProperty('--bottom-action-bar-height');
    };
  }, [bar.mode]);

  // Expose stable window globals once on mount. barRef ensures callbacks
  // always access the latest state without re-registering on every render.
  useEffect(() => {
    window.closeBottomBar = () => {
      clearTimer();
      setBar(CLOSED);
    };

    window.runBottomAction = async () => {
      const fn = barRef.current.action;
      window.closeBottomBar();
      if (fn) await fn();
    };

    window.showBottomUndo = (message, onUndo) => {
      clearTimer();
      setBar({ mode: 'undo', message, action: onUndo });
      timerRef.current = setTimeout(() => {
        setBar(CLOSED);
        timerRef.current = null;
      }, 5000);
    };

    window.showBottomConfirm = (message, onConfirm) => {
      clearTimer();
      setBar({ mode: 'confirm', message, action: onConfirm });
    };

    window.showUnsavedChangesBar = (onSave, onDiscard) => {
      clearTimer();
      setBar({
        mode: 'unsaved',
        message: 'You have unsaved changes',
        action: null,
        onSave,
        onDiscard,
      });
    };

    return () => {
      clearTimer();
      // Cast through unknown to satisfy strict delete typing on window.
      const w = window as unknown as Record<string, unknown>;
      delete w.showBottomUndo;
      delete w.showBottomConfirm;
      delete w.showUnsavedChangesBar;
      delete w.closeBottomBar;
      delete w.runBottomAction;
    };
  }, [setBar, clearTimer]);

  return (
    <>
      <GlobalStyles
        styles={`
          @keyframes mo-bb-progress {
            from { width: 100%; }
            to   { width: 0%;   }
          }
        `}
      />
      <Slide in={bar.mode !== null} direction="up" mountOnEnter unmountOnExit>
        <Box
          ref={boxRef}
          role="status"
          aria-live="polite"
          sx={{
            position: 'fixed',
            bottom: 0,
            left: 0,
            right: 0,
            bgcolor: 'var(--plum)',
            color: 'common.white',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 1.5,
            px: 2,
            py: '14px',
            pb: 'calc(14px + env(safe-area-inset-bottom))',
            zIndex: 'var(--z-toast)',
            boxShadow: '0 -4px 20px rgba(30,24,14,0.2)',
            overflow: 'hidden',
          }}
        >
          <Typography
            variant="body2"
            sx={{ fontWeight: 500, flex: 1, minWidth: 0, color: 'inherit' }}
          >
            {bar.message}
          </Typography>

          {bar.mode === 'undo' && (
            <Button
              variant="outlined"
              size="small"
              onClick={() => window.runBottomAction()}
              sx={{
                color: 'common.white',
                borderColor: 'rgba(255,255,255,0.3)',
                '&:hover': {
                  bgcolor: 'rgba(255,255,255,0.12)',
                  borderColor: 'rgba(255,255,255,0.3)',
                },
                flexShrink: 0,
              }}
            >
              Undo
            </Button>
          )}

          {bar.mode === 'confirm' && (
            <Box sx={{ display: 'flex', gap: 1, flexShrink: 0 }}>
              <Button
                variant="outlined"
                size="small"
                onClick={() => window.closeBottomBar()}
                sx={outlinedSx}
              >
                Cancel
              </Button>
              <Button
                variant="contained"
                size="small"
                onClick={() => window.runBottomAction()}
                sx={filledSx}
              >
                Confirm
              </Button>
            </Box>
          )}

          {bar.mode === 'unsaved' && (
            <Box sx={{ display: 'flex', gap: 1, flexShrink: 0 }}>
              <Button
                variant="outlined"
                size="small"
                onClick={async () => {
                  // The bar is not closed here: closing is driven by the change
                  // actually being resolved (the admin guard's controller hides
                  // the bar once nothing is dirty). A failed save therefore
                  // leaves the bar in place.
                  const fn = barRef.current.onDiscard;
                  if (fn) { try { await fn(); } catch { /* handled by caller */ } }
                }}
                sx={outlinedSx}
              >
                Discard changes
              </Button>
              <Button
                variant="contained"
                size="small"
                onClick={async () => {
                  const fn = barRef.current.onSave;
                  if (fn) { try { await fn(); } catch { /* handled by caller */ } }
                }}
                sx={filledSx}
              >
                Save changes
              </Button>
            </Box>
          )}

          {bar.mode === 'undo' && (
            <Box
              sx={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                width: '100%',
                height: '3px',
                bgcolor: 'rgba(255,255,255,0.35)',
                animation: 'mo-bb-progress 5s linear forwards',
                pointerEvents: 'none',
              }}
            />
          )}
        </Box>
      </Slide>
    </>
  );
}
