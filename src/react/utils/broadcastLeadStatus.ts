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
    const ch = new BroadcastChannel('contact_properties_changed');
    ch.postMessage({ contactId, props });
    ch.close();
  } catch { /* ignore — non-fatal */ }
}
