/**
 * Helpers for confirming a lead-status change after a terminal card action.
 *
 * The card-action execute routes echo back `{ outcome, setsLeadStatus, terminal }`
 * (see shared/handler-outcomes.cjs getOutcomeMeta). `setsLeadStatus` is the raw
 * HubSpot key (e.g. 'DESIGN_SCHEDULED'); these helpers map it to its
 * human-readable label so the action modals can confirm exactly which lead
 * status was applied — "Lead status set to Design visit scheduled" — instead of
 * a vague "status updated" message.
 *
 * Labels come from `window.LEAD_STATUS_OPTIONS` (value → label), the same
 * source the lead-status picker uses. If the key is missing from that list the
 * raw key is shown rather than nothing, so the confirmation is never blank for a
 * real status change.
 */

interface LeadStatusOption {
  value: string;
  label: string;
  excluded_from_sales?: boolean;
}

interface WindowWithLeadStatuses {
  LEAD_STATUS_OPTIONS?: LeadStatusOption[];
}

/**
 * Maps a raw hs_lead_status key to its configured human label, falling back to
 * the raw key when no matching option is registered. Returns '' for an
 * empty/null/`__NULL__` status.
 */
export function leadStatusLabelFor(status: string | null | undefined): string {
  if (!status || status.toUpperCase() === '__NULL__') return '';
  const opts = (window as unknown as WindowWithLeadStatuses).LEAD_STATUS_OPTIONS || [];
  const found = opts.find((o) => o.value === status);
  return found?.label || status;
}

/**
 * Builds the confirmation message for a terminal outcome's lead-status change,
 * e.g. "Lead status set to Design visit scheduled". Returns '' when there is no
 * status to confirm (partial outcome or missing value), so callers can fall
 * back to their existing message.
 */
export function leadStatusConfirmationMessage(status: string | null | undefined): string {
  const label = leadStatusLabelFor(status);
  return label ? `Lead status set to ${label}` : '';
}
