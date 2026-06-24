/**
 * Shared channel name for task-changed broadcasts across tabs and windows.
 * Import this constant instead of inlining the string so that sender and all
 * listeners stay in sync automatically.
 */
export const TASK_CHANGED_CHANNEL = 'mo:task_changed';

/**
 * Debounce window (ms) used by task-changed subscribers to collapse rapid-fire
 * broadcasts into a single re-fetch.  Centralised here so all listeners stay
 * in sync and the value is easy to tune in one place.
 */
export const TASK_CHANGED_DEBOUNCE_MS = 300;

/** Shape of every message posted on TASK_CHANGED_CHANNEL. */
export interface TaskChangedMessage {
  contactId: string;
  ts: number;
}

/** Name of the window CustomEvent fired in the same tab on every broadcast. */
export const TASK_CHANGED_WINDOW_EVENT = 'mo:task-changed';

/**
 * Broadcasts a task-changed event to other tabs/windows via BroadcastChannel,
 * and to the current tab via a window CustomEvent.
 * Non-fatal — silently ignored if BroadcastChannel is unavailable.
 */
export function broadcastTaskChanged(contactId: string): void {
  const msg: TaskChangedMessage = { contactId, ts: Date.now() };
  // Same-tab delivery via window event (BroadcastChannel does not fire in the
  // originating tab).
  try {
    window.dispatchEvent(new CustomEvent(TASK_CHANGED_WINDOW_EVENT, { detail: msg }));
  } catch { /* ignore — non-fatal */ }
  // Cross-tab delivery via BroadcastChannel.
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const ch = new BroadcastChannel(TASK_CHANGED_CHANNEL);
    ch.postMessage(msg);
    ch.close();
  } catch { /* ignore — non-fatal */ }
}

/**
 * Subscribes to task-changed broadcasts from other tabs/windows (via
 * BroadcastChannel) and from the current tab (via window CustomEvent).
 * Returns a cleanup function.  Non-fatal — silently ignored if
 * BroadcastChannel is unavailable (returns a no-op cleanup).
 */
export function subscribeTaskChanged(
  handler: (msg: TaskChangedMessage) => void,
): () => void {
  const windowHandler = (evt: Event) => {
    const msg = (evt as CustomEvent<TaskChangedMessage>).detail;
    if (!msg || typeof msg.contactId !== 'string' || msg.contactId === '') return;
    handler(msg);
  };
  window.addEventListener(TASK_CHANGED_WINDOW_EVENT, windowHandler);

  let ch: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      ch = new BroadcastChannel(TASK_CHANGED_CHANNEL);
      ch.onmessage = (evt: MessageEvent<TaskChangedMessage>) => {
        const msg = evt.data;
        if (!msg || typeof msg.contactId !== 'string' || msg.contactId === '') return;
        handler(msg);
      };
    } catch { /* BroadcastChannel unavailable */ }
  }

  return () => {
    window.removeEventListener(TASK_CHANGED_WINDOW_EVENT, windowHandler);
    try { ch?.close(); } catch { /* noop */ }
  };
}
