import { useEffect, useRef } from 'react';
import { useBeforeUnloadGuard } from './useBeforeUnloadGuard';
import {
  registerDirtySource,
  unregisterDirtySource,
  notifyDirtyChanged,
} from '../lib/adminUnsavedGuard';

export interface UseAdminUnsavedChangesOptions {
  /** Unique id for this dirty source — use the admin tab id (e.g. 'settings'). */
  id: string;
  /** True when the tab has edits that would be lost on leave. */
  isDirty: boolean;
  /** Persist the edits. Reject/throw if the save fails so the leave is aborted. */
  onSave: () => Promise<void> | void;
  /** Throw away the edits and restore the last-saved values. */
  onDiscard: () => void;
  /**
   * Whether this source drives the persistent bottom "unsaved changes" bar.
   * Set false for sources that already surface their own Save / Discard UI
   * (e.g. a modal editor) — navigation is still blocked. Defaults to true.
   */
  showBar?: boolean;
}

/**
 * Opt an admin tab into the shared unsaved-changes guard.
 *
 * While `isDirty` is true the user is stopped from losing their work three ways:
 *   1. Switching admin tab / group   — `AdminGroupedTabsBar` calls `guardLeave()`,
 *      which shows a "Save / Discard / Keep editing" block dialog.
 *   2. Closing the tab or refreshing  — the native `beforeunload` prompt fires.
 *   3. Navigating to another page      — same `beforeunload` prompt (admin pages
 *      are separate documents, so any link is a full navigation).
 *
 * A single persistent "You have unsaved changes" bar (driven by the shared
 * registry, rendered once by `AdminGroupedTabsBar`) is also shown while dirty.
 *
 * Pages just supply the three callbacks; everything else is centralised.
 */
export function useAdminUnsavedChanges({
  id,
  isDirty,
  onSave,
  onDiscard,
  showBar = true,
}: UseAdminUnsavedChangesOptions): void {
  // Keep the latest closures + dirtiness in a ref so the registry (which is
  // plain module state, not React) always calls through to current values.
  const latest = useRef({ isDirty, onSave, onDiscard });
  latest.current = { isDirty, onSave, onDiscard };

  useEffect(() => {
    registerDirtySource(id, {
      isDirty: () => latest.current.isDirty,
      save: () => latest.current.onSave(),
      discard: () => latest.current.onDiscard(),
      silent: !showBar,
    });
    return () => unregisterDirtySource(id);
  }, [id, showBar]);

  // The registry can't observe React state, so nudge subscribers (the
  // persistent bar controller) whenever dirtiness flips.
  useEffect(() => {
    notifyDirtyChanged();
  }, [isDirty]);

  // Native browser prompt for tab-close / refresh / cross-page navigation.
  useBeforeUnloadGuard(isDirty);
}
