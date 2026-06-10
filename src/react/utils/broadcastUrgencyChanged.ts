/**
 * Shared channel name for urgency broadcasts across tabs and windows.
 * Import this constant instead of inlining the string so that senders and
 * all listeners stay in sync automatically.
 */
export const URGENCY_CHANGED_CHANNEL = 'urgency_changed';

/**
 * Broadcasts an urgency change to other tabs/windows via BroadcastChannel.
 * Non-fatal — silently ignored if BroadcastChannel is unavailable.
 */
export function broadcastUrgencyChanged(contactId: string): void {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const ch = new BroadcastChannel(URGENCY_CHANGED_CHANNEL);
    ch.postMessage({ contactId });
    ch.close();
  } catch { /* ignore — non-fatal */ }
}
