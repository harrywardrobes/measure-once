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

/**
 * A reference to an email template sent during a handler's flow. Usually just
 * the template key string. Use the object form to mark a "system-in-flow"
 * email — one sent automatically by a system / integration module (QuickBooks,
 * customer-info, photo-reviews) rather than composed by staff. The admin Email
 * Templates page renders a "System" chip (captioned with `sentFrom`) for these
 * while still grouping them under the handler that triggers them.
 */
export interface EmailTemplateRef {
  /** Email template key (must exist in email-templates.js TEMPLATE_KEYS). */
  key: string;
  /** True when sent automatically by a system / integration module in-flow. */
  system?: boolean;
  /** Source module the email is sent from (for the System chip caption). */
  sentFrom?: string;
  /**
   * Plain-language description of the exact condition that fires this email.
   * Used for action-level emails (sent when the customer themselves acts,
   * with no staff-selected outcome to derive the trigger from). For
   * outcome-level refs the trigger is derived from the outcome instead.
   */
  trigger?: string;
}

/** Either a bare template key or an annotated {@link EmailTemplateRef}. */
export type EmailTemplateRefInput = string | EmailTemplateRef;

/** Normalises a template ref input to its template key. */
export function templateRefKey(ref: EmailTemplateRefInput): string {
  return typeof ref === 'string' ? ref : ref.key;
}

/** True when a template ref is flagged as a system / integration in-flow email. */
export function templateRefIsSystem(ref: EmailTemplateRefInput): boolean {
  return typeof ref === 'string' ? false : !!ref.system;
}

/** The source module of a template ref (system-in-flow refs only), or undefined. */
export function templateRefSentFrom(ref: EmailTemplateRefInput): string | undefined {
  return typeof ref === 'string' ? undefined : ref.sentFrom;
}

/** Plain-language trigger note on a template ref (action-level refs), or undefined. */
export function templateRefTrigger(ref: EmailTemplateRefInput): string | undefined {
  return typeof ref === 'string' ? undefined : ref.trigger;
}

export interface ActionOutcome {
  /** Canonical API key — never rename; it is part of the API contract. */
  key: string;
  /** Human-readable label shown in the Workflow page outcome chips. */
  label: string;
  kind: 'terminal' | 'partial';
  /** HubSpot hs_lead_status written on completion (omitted when no status change). */
  setsLeadStatus?: string;
  /**
   * Per-visitType overrides for arrange_visit (design / survey keys).
   * `label` is an optional human-friendly per-type label used by the Workflow
   * page outcome chips when a handler is configured for a specific visit type.
   */
  variants?: Record<string, { setsLeadStatus: string; label?: string }>;
  /** Optional extra context for tooltips / documentation. */
  description?: string;
  /**
   * Email template(s) sent when this specific outcome is selected. Each entry is
   * either a bare template key or an annotated {@link EmailTemplateRef} (use the
   * object form for system-in-flow emails). Drives the per-outcome grouping on
   * the admin Email Templates page and the derived HANDLER_EMAIL_TEMPLATES map.
   * A template may be referenced by more than one outcome (a "shared" template).
   */
  sendsEmailTemplates?: EmailTemplateRefInput[];
}

/** A system / lifecycle email not tied to any card-action handler. */
export interface SystemEmailTemplate {
  /** Email template key (must exist in email-templates.js TEMPLATE_KEYS). */
  key: string;
  /** Where in the codebase this email is sent from (for documentation). */
  sentFrom: string;
  /** Human-readable description of when it fires. */
  description: string;
  /** Always true — marks the template as a system email. */
  system?: boolean;
}

export const HANDLER_OUTCOMES: Record<string, ActionOutcome[]> = {

  arrange_visit: [
    {
      key: 'booked',
      label: 'Booked',
      kind: 'terminal',
      variants: {
        design: { setsLeadStatus: 'DESIGN_SCHEDULED', label: 'Design visit scheduled' },
        survey: { setsLeadStatus: 'SURVEY_SCHEDULED', label: 'Survey scheduled' },
      },
      description: 'Visit booked — lead status depends on visit type (design or survey)',
    },
    {
      key: 'email_sent',
      label: 'No answer — email sent',
      kind: 'terminal',
      variants: {
        design: { setsLeadStatus: 'DESIGN_INVITED', label: 'Design invite sent' },
        survey: { setsLeadStatus: 'SURVEY_SCHEDULED', label: 'Survey scheduled' },
      },
      description: 'No-answer email sent — status depends on visit type',
      sendsEmailTemplates: ['arrange_visit_no_answer'],
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
      sendsEmailTemplates: ['visit_confirmation'],
    },
    {
      key: 'invite_resent',
      label: 'Invite resent',
      kind: 'terminal',
      setsLeadStatus: 'DESIGN_INVITED',
      sendsEmailTemplates: ['visit_invite'],
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
      sendsEmailTemplates: [{ key: 'open_deal_deposit_invoice_sent', system: true, sentFrom: 'quickbooks.js' }],
    },
    {
      key: 'decline',
      label: 'Decline deal',
      kind: 'terminal',
      setsLeadStatus: 'DECLINED_DEAL',
      description: 'Rejects QB estimate, sends thank-you email, sets status to DECLINED_DEAL',
      sendsEmailTemplates: [{ key: 'open_deal_declined_thank_you', system: true, sentFrom: 'quickbooks.js' }],
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
      sendsEmailTemplates: [{ key: 'open_deal_declined_thank_you', system: true, sentFrom: 'quickbooks.js' }],
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
      sendsEmailTemplates: [{ key: 'deposit_invoice_payment_reminder', system: true, sentFrom: 'quickbooks.js' }],
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
      sendsEmailTemplates: [{ key: 'photo_review_not_suitable', system: true, sentFrom: 'photo-reviews.js' }],
    },
    {
      key: 'rough_estimate_sent',
      label: 'Send Rough Estimate',
      kind: 'terminal',
      setsLeadStatus: 'ROUGH_ESTIMATE',
      sendsEmailTemplates: [{ key: 'photo_review_rough_estimate', system: true, sentFrom: 'photo-reviews.js' }],
    },
  ],

  upload_photos_and_info: [
    {
      key: 'link_sent',
      label: 'Link sent',
      kind: 'terminal',
      setsLeadStatus: 'AWAITING_PHOTOS',
      description: 'Customer photo form link generated and emailed; status set to AWAITING_PHOTOS',
      sendsEmailTemplates: [{ key: 'photo_review_invite', system: true, sentFrom: 'customer-info.js' }],
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

  start_survey_visit: [
    {
      key: 'submitted',
      label: 'Survey visit submitted',
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
      sendsEmailTemplates: ['visit_confirmation'],
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

/**
 * Action-level email templates: sent during a handler's flow but not tied to a
 * single staff-selected outcome (e.g. emails triggered when the customer
 * themselves submits the form). Keyed by handler type. Handlers with no
 * action-level emails are omitted.
 */
export const ACTION_LEVEL_EMAIL_TEMPLATES: Record<string, EmailTemplateRefInput[]> = {
  // Sent automatically by customer-info.js when the customer submits their
  // uploaded photos/info: an internal team notification and a customer
  // thank-you confirmation. Both are system-in-flow emails.
  upload_photos_and_info: [
    { key: 'admin_notification', system: true, sentFrom: 'customer-info.js', trigger: 'Sent automatically when the customer submits their uploaded photos & info.' },
    { key: 'customer_thank_you', system: true, sentFrom: 'customer-info.js', trigger: 'Sent automatically when the customer submits their uploaded photos & info.' },
  ],
};

/**
 * System / lifecycle emails not tied to any card-action handler. These are sent
 * by the auth flow (account onboarding and password reset) rather than the
 * workflow handlers, and are grouped separately on the admin Email Templates
 * page.
 */
export const SYSTEM_EMAIL_TEMPLATES: SystemEmailTemplate[] = [
  {
    key: 'set_password_welcome',
    sentFrom: 'auth.js',
    description: 'Welcome email with a one-time set-password link, sent when an admin approves access or adds a team member.',
    system: true,
  },
  {
    key: 'set_password_resend',
    sentFrom: 'auth.js',
    description: 'Re-sends the set-password link when an admin clicks "Resend set-password" on the Team tab.',
    system: true,
  },
  {
    key: 'set_password_reset',
    sentFrom: 'auth.js',
    description: 'Password-reset link sent when a user requests a forgotten-password reset.',
    system: true,
  },
  {
    key: 'survey_refund_request',
    sentFrom: 'survey-visits.js',
    description: 'Admin notification sent when a survey deposit refund is requested ("customer changed their mind"), so the refund can be processed manually in QuickBooks.',
    system: true,
  },
];
