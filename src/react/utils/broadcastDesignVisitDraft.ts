/**
 * Shared channel name for design-visit draft-changed broadcasts across tabs
 * and windows.  Import this constant instead of inlining the string so that
 * sender and all listeners stay in sync automatically.
 */
export const DESIGN_VISIT_DRAFT_CHANNEL = 'design_visit_draft_changed';

/** Shape of every message posted on DESIGN_VISIT_DRAFT_CHANNEL. */
export interface DesignVisitDraftMessage {
  ts: number;
}

/**
 * Broadcasts a design-visit draft change to other tabs/windows via
 * BroadcastChannel.  Non-fatal — silently ignored if BroadcastChannel is
 * unavailable.
 */
export function broadcastDesignVisitDraftChanged(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const ch = new BroadcastChannel(DESIGN_VISIT_DRAFT_CHANNEL);
    ch.postMessage({ ts: Date.now() } satisfies DesignVisitDraftMessage);
    ch.close();
  } catch { /* ignore — non-fatal */ }
}

/**
 * Subscribes to design-visit draft changes broadcast from other tabs/windows.
 * Returns a cleanup function that closes the channel.  Non-fatal — silently
 * ignored if BroadcastChannel is unavailable (returns a no-op cleanup).
 */
export function subscribeDesignVisitDraftChanged(handler: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => { /* noop */ };
  let ch: BroadcastChannel | null = null;
  try {
    ch = new BroadcastChannel(DESIGN_VISIT_DRAFT_CHANNEL);
    ch.onmessage = () => handler();
  } catch { /* BroadcastChannel unavailable */ }
  return () => { try { ch?.close(); } catch { /* noop */ } };
}
