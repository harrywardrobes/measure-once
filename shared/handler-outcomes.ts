/**
 * shared/handler-outcomes.ts — Handler outcome registry (TypeScript / ESM).
 *
 * This is the single canonical source of truth for card-action outcome data.
 * It is imported by src/react/utils/handlerMeta.ts (via Vite/TypeScript bundling)
 * and used directly in the React layer for Workflow-page chip rendering and
 * modal components.
 *
 * The server-side CJS mirror lives in shared/handler-outcomes.cjs.
 * A drift-guard test in test/card-action-handlers/drift-guard.js asserts the
 * two agree on terminal outcome keys and HubSpot status writes.
 *
 * Shape of each entry:
 *   key           — canonical API key (never rename — it is part of the API contract)
 *   label         — human-readable label for display in the Workflow page
 *   kind          — 'terminal': moves the card (writes hs_lead_status)
 *                   'partial':  logs progress, no card move and no status write
 *   setsLeadStatus — HubSpot hs_lead_status value set on completion (omitted when no change)
 *   variants      — per-visitType overrides for arrange_visit (design / survey)
 *   description   — optional extra context shown in tooltips / documentation
 */

export interface ActionOutcome {
  /** Canonical API key — never rename; it is part of the API contract. */
  key: string;
  /** Human-readable label shown in the Workflow page outcome chips. */
  label: string;
  kind: 'terminal' | 'partial';
  /** HubSpot hs_lead_status written on completion (omitted when no status change). */
  setsLeadStatus?: string;
  /** Per-visitType overrides for arrange_visit (design / survey keys). */
  variants?: Record<string, { setsLeadStatus: string }>;
  /** Optional extra context for tooltips / documentation. */
  description?: string;
}

export const HANDLER_OUTCOMES: Record<string, ActionOutcome[]> = {

  arrange_visit: [
    {
      key: 'booked',
      label: 'Booked',
      kind: 'terminal',
      variants: {
        design: { setsLeadStatus: 'DESIGN_SCHEDULED' },
        survey: { setsLeadStatus: 'SURVEY_SCHEDULED' },
      },
      description: 'Visit booked — lead status depends on visit type (design or survey)',
    },
    {
      key: 'email_sent',
      label: 'No answer — email sent',
      kind: 'terminal',
      variants: {
        design: { setsLeadStatus: 'DESIGN_INVITED' },
        survey: { setsLeadStatus: 'SURVEY_SCHEDULED' },
      },
      description: 'No-answer email sent — status depends on visit type',
    },
    {
      key: 'not_proceeding',
      label: 'Not proceeding',
      kind: 'terminal',
      setsLeadStatus: 'NOT_SUITABLE',
    },
  ],

  design_visit_followup: [
    {
      key: 'confirmed',
      label: 'Customer confirmed',
      kind: 'terminal',
      setsLeadStatus: 'DESIGN_SCHEDULED',
    },
    {
      key: 'invite_resent',
      label: 'Invite resent',
      kind: 'terminal',
      setsLeadStatus: 'DESIGN_INVITED',
    },
    {
      key: 'not_proceeding',
      label: 'Not proceeding',
      kind: 'terminal',
      setsLeadStatus: 'NOT_SUITABLE',
    },
  ],

  contact_customer: [
    {
      key: 'attempted_to_contact',
      label: 'Attempted to contact',
      kind: 'terminal',
      setsLeadStatus: 'ATTEMPTED_TO_CONTACT',
      description: 'Applied when lead status is null and at least one attempt is logged',
    },
    {
      key: 'no_response',
      label: 'No response',
      kind: 'terminal',
      setsLeadStatus: 'NO_RESPONSE',
    },
    {
      key: 'send_upload_link',
      label: 'Send upload link',
      kind: 'terminal',
      setsLeadStatus: 'AWAITING_PHOTOS',
      description: 'Dispatches upload-photos-and-info handler — card moves to AWAITING_PHOTOS',
    },
    {
      key: 'call_attempted',
      label: 'Call logged',
      kind: 'partial',
      description: 'Records a call attempt — no status change',
    },
    {
      key: 'email_sent',
      label: 'Email logged',
      kind: 'partial',
      description: 'Records an email attempt — no status change',
    },
    {
      key: 'whatsapp_sent',
      label: 'WhatsApp logged',
      kind: 'partial',
      description: 'Records a WhatsApp attempt — no status change',
    },
  ],

  open_deal: [
    {
      key: 'accept',
      label: 'Accept deal',
      kind: 'terminal',
      setsLeadStatus: 'DEPOSIT_INVOICE',
      description: 'Creates QB deposit invoice and sends it; sets status to DEPOSIT_INVOICE',
    },
    {
      key: 'decline',
      label: 'Decline deal',
      kind: 'terminal',
      setsLeadStatus: 'DECLINED_DEAL',
      description: 'Rejects QB estimate, sends thank-you email, sets status to DECLINED_DEAL',
    },
    {
      key: 'amend_deal',
      label: 'Amend the deal',
      kind: 'partial',
      description: 'Opens related handlers (upload photos / amend design visit) — no status change',
    },
  ],

  deposit_invoice_followup: [
    {
      key: 'not_proceeding',
      label: 'Not proceeding',
      kind: 'terminal',
      setsLeadStatus: 'DECLINED_DEAL',
      description: 'Rejects estimate, optionally voids invoice, sets status to DECLINED_DEAL',
    },
    {
      key: 'resend_invoice',
      label: 'Re-send deposit invoice',
      kind: 'partial',
      description: 'Resends invoice via QuickBooks email — no status change',
    },
    {
      key: 'send_reminder',
      label: 'Send payment reminder',
      kind: 'partial',
      description: 'Sends a payment chaser email — no status change',
    },
    {
      key: 'arrange_survey',
      label: 'Arrange survey',
      kind: 'partial',
      description: 'Dispatches the arrange_visit handler — no direct status change',
    },
    {
      key: 'log_call',
      label: 'Log a call',
      kind: 'partial',
      description: 'Dispatches the contact_customer handler — no direct status change',
    },
    {
      key: 'amend_deal',
      label: 'Amend the deal',
      kind: 'partial',
      description: 'Dispatches upload-photos or amend-design-visit handler — no direct status change',
    },
  ],

  review_customer_photos: [
    {
      key: 'not_suitable',
      label: 'Not Suitable',
      kind: 'terminal',
      setsLeadStatus: 'NOT_SUITABLE',
    },
    {
      key: 'rough_estimate_sent',
      label: 'Send Rough Estimate',
      kind: 'terminal',
      setsLeadStatus: 'ROUGH_ESTIMATE',
    },
  ],

  upload_photos_and_info: [
    {
      key: 'link_sent',
      label: 'Link sent',
      kind: 'terminal',
      setsLeadStatus: 'AWAITING_PHOTOS',
      description: 'Customer photo form link generated and emailed; status set to AWAITING_PHOTOS',
    },
  ],

  start_design_visit: [
    {
      key: 'submitted',
      label: 'Design visit submitted',
      kind: 'terminal',
      description: 'Sets lead status to the handler-configured submittedLeadStatus on submit',
    },
  ],

  schedule_visit: [
    {
      key: 'scheduled',
      label: 'Visit scheduled',
      kind: 'partial',
      description: 'Creates a Google Calendar event — no lead status change',
    },
  ],

  summarise_phone_call: [
    {
      key: 'note_created',
      label: 'Call note created',
      kind: 'partial',
      description: 'Saves a timestamped note to HubSpot contact — no lead status change',
    },
  ],

  show_message: [],
};
