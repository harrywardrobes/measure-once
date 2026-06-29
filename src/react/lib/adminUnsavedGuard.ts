/**
 * Shared unsaved-changes guard for the admin panel.
 *
 * The admin tabs are each mounted as their own non-unmounting `createRoot`
 * (see `src/react/main.tsx`), so they cannot share a React context. This
 * module is the single shared instance every tab imports, which lets the
 * grouped tab bar (itself a separate root) ask "does the currently-open tab
 * have unsaved edits?" before it switches tabs — and lets a single persistent
 * "you have unsaved changes" bar reflect whichever tab is dirty.
 *
 * A page opts in via the `useAdminUnsavedChanges` hook, which registers a
 * {@link DirtySource}. The tab bar registers a {@link LeavePrompter} that
 * renders the block dialog and hosts the persistent bar.
 */

export interface DirtySource {
  /** True while the source has edits that would be lost on leave. Read live. */
  isDirty: () => boolean;
  /** Persist the edits. Reject/throw if the save fails (the leave is aborted). */
  save: () => Promise<void> | void;
  /** Throw away the edits and restore the last-saved values. */
  discard: () => void;
  /**
   * When true the source still blocks navigation but does NOT drive the
   * persistent bottom bar — for sources that already show their own Save /
   * Discard affordance (e.g. a modal editor). Defaults to false.
   */
  silent?: boolean;
}

export type LeaveChoice = 'save' | 'discard' | 'cancel';
export type LeavePrompter = () => Promise<LeaveChoice>;

const sources = new Map<string, DirtySource>();
const listeners = new Set<() => void>();
let prompter: LeavePrompter | null = null;

function emit(): void {
  for (const l of listeners) l();
}

/** Register (or replace) a tab's dirty source. Call from a page's guard hook. */
export function registerDirtySource(id: string, source: DirtySource): void {
  sources.set(id, source);
  emit();
}

/** Remove a tab's dirty source (on unmount). */
export function unregisterDirtySource(id: string): void {
  if (sources.delete(id)) emit();
}

/**
 * Subscribe to dirty-state changes (used by the persistent bar controller).
 * Returns an unsubscribe function.
 */
export function subscribeDirty(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Force a notification to subscribers. A page calls this when a registered
 * source's dirtiness flips (the registry can't observe React state directly).
 */
export function notifyDirtyChanged(): void {
  emit();
}

/** True when any registered source currently has unsaved edits. */
export function isAnyDirty(): boolean {
  for (const s of sources.values()) if (s.isDirty()) return true;
  return false;
}

/**
 * The first currently-dirty source. By design the guard resolves a tab's
 * dirtiness before leaving it, so at most one tab is dirty at a time.
 */
export function getActiveDirtySource(): DirtySource | null {
  for (const s of sources.values()) if (s.isDirty()) return s;
  return null;
}

/**
 * The first dirty source that wants the persistent bar (not `silent`). This is
 * what the bottom bar's Save / Discard buttons act on; returns null when the
 * only dirty sources show their own affordance (e.g. a modal editor).
 */
export function getBarDirtySource(): DirtySource | null {
  for (const s of sources.values()) if (s.isDirty() && !s.silent) return s;
  return null;
}

/** Register the dialog-backed prompter (the tab bar owns this). */
export function setLeavePrompter(p: LeavePrompter | null): void {
  prompter = p;
}

/**
 * Call before any in-app navigation that would abandon the active tab
 * (tab switch, group switch). Resolves `true` when it is safe to proceed:
 * either nothing is dirty, or the user chose to save / discard.
 *
 * On `save`, every dirty source is saved; if any save throws the leave is
 * aborted (resolves `false`) so the user stays on the unsaved tab. Falls back
 * to a native `confirm()` if no prompter is registered.
 */
export async function guardLeave(): Promise<boolean> {
  if (!isAnyDirty()) return true;

  const choice: LeaveChoice = prompter
    ? await prompter()
    : window.confirm('You have unsaved changes — discard them?')
      ? 'discard'
      : 'cancel';

  if (choice === 'cancel') return false;

  const dirty = [...sources.values()].filter((s) => s.isDirty());
  if (choice === 'save') {
    try {
      for (const s of dirty) await s.save();
    } catch {
      return false; // save failed (e.g. validation) — stay put
    }
    return true;
  }

  // discard
  for (const s of dirty) s.discard();
  return true;
}
