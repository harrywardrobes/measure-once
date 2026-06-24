import { useEffect } from 'react';

/**
 * Registers a `beforeunload` handler while `hasUnsavedChanges` is true,
 * showing the browser's native "Changes may not be saved?" prompt when the
 * user tries to close or refresh the tab.  The handler is removed automatically
 * when the flag turns false or the component unmounts.
 *
 * Pair with `useDiscardGuard` + `DiscardConfirmDialog` for full coverage of
 * both in-app closes (modal X / Cancel / Escape) and browser-level tab closes.
 */
export function useBeforeUnloadGuard(hasUnsavedChanges: boolean): void {
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsavedChanges]);
}
