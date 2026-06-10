/**
 * Shared channel name for lead-status / contact-property broadcasts across
 * tabs and windows.  Import this constant instead of inlining the string so
 * that sender and all listeners stay in sync automatically.
 */
export const LEAD_STATUS_CHANNEL = 'contact_properties_changed';

/** Shape of every message posted on LEAD_STATUS_CHANNEL. */
export interface LeadStatusMessage {
  contactId: string;
  props: Record<string, string | undefined>;
}

/**
 * Broadcasts a contact-property change to other tabs/windows via
 * BroadcastChannel.  Non-fatal — silently ignored if BroadcastChannel is
 * unavailable.
 */
export function broadcastLeadStatusChange(
  contactId: string,
  props: Record<string, string | undefined>,
): void {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const ch = new BroadcastChannel(LEAD_STATUS_CHANNEL);
    ch.postMessage({ contactId, props } satisfies LeadStatusMessage);
    ch.close();
  } catch { /* ignore — non-fatal */ }
}

/**
 * Subscribes to contact-property changes broadcast from other tabs/windows.
 * Returns a cleanup function that closes the channel.  Non-fatal — silently
 * ignored if BroadcastChannel is unavailable (returns a no-op cleanup).
 */
export function subscribeLeadStatusChange(
  handler: (contactId: string, props: Record<string, string | undefined>) => void,
): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => { /* noop */ };
  let ch: BroadcastChannel | null = null;
  try {
    ch = new BroadcastChannel(LEAD_STATUS_CHANNEL);
    ch.onmessage = (e: MessageEvent<Partial<LeadStatusMessage>>) => {
      const { contactId, props } = e.data ?? {};
      if (!contactId || !props) return;
      handler(contactId, props);
    };
  } catch { /* BroadcastChannel unavailable */ }
  return () => { try { ch?.close(); } catch { /* noop */ } };
}
