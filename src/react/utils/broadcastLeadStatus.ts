/**
 * Shared channel name for lead-status / contact-property broadcasts across
 * tabs and windows.  Import this constant instead of inlining the string so
 * that sender and all listeners stay in sync automatically.
 */
export const LEAD_STATUS_CHANNEL = 'contact_properties_changed';

/**
 * Broadcasts a lead-status change to other tabs/windows via BroadcastChannel.
 * Non-fatal — silently ignored if BroadcastChannel is unavailable.
 */
export function broadcastLeadStatusChange(
  contactId: string,
  props: { hs_lead_status: string; hw_lead_substatus: string },
): void {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const ch = new BroadcastChannel(LEAD_STATUS_CHANNEL);
    ch.postMessage({ contactId, props });
    ch.close();
  } catch { /* ignore — non-fatal */ }
}
