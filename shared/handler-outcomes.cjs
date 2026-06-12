'use strict';
/**
 * shared/handler-outcomes.js — Handler outcome registry.
 *
 * Server-side CJS copy of the handler outcome registry.
 * The canonical TypeScript/ESM source lives in shared/handler-outcomes.ts
 * (imported by src/react/utils/handlerMeta.ts via Vite).  This CJS file is
 * required by server.js, photo-reviews.js, and quickbooks.js so that
 * accepted outcome keys and HubSpot status writes are derived at runtime
 * rather than hardcoded in each route.
 *
 * Keep this file in sync with shared/handler-outcomes.ts.
 * A drift-guard test in test/card-action-handlers/drift-guard.js asserts both
 * agree on the terminal outcome keys for each handler that has server routes.
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

/** @type {Record<string, import('./handler-outcomes').ActionOutcome[]>} */
const HANDLER_OUTCOMES = {

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
 *
 * @type {Record<string, import('./handler-outcomes').EmailTemplateRefInput[]>}
 */
const ACTION_LEVEL_EMAIL_TEMPLATES = {
  // Sent automatically by customer-info.js when the customer submits their
  // uploaded photos/info: an internal team notification and a customer
  // thank-you confirmation. Both are system-in-flow emails.
  upload_photos_and_info: [
    { key: 'admin_notification', system: true, sentFrom: 'customer-info.js' },
    { key: 'customer_thank_you', system: true, sentFrom: 'customer-info.js' },
  ],
};

/**
 * System / lifecycle emails not tied to any card-action handler. These are sent
 * by the auth flow (account onboarding and password reset) rather than the
 * workflow handlers, and are grouped separately on the admin Email Templates
 * page.
 *
 * @type {import('./handler-outcomes').SystemEmailTemplate[]}
 */
const SYSTEM_EMAIL_TEMPLATES = [
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
];

/**
 * Normalises an email template ref (bare key string or {key, system, sentFrom})
 * to its template key.
 * @param {string | {key: string}} ref
 * @returns {string}
 */
function templateRefKey(ref) {
  return typeof ref === 'string' ? ref : ref.key;
}

/**
 * True when a template ref is flagged as a system / integration in-flow email.
 * @param {string | {system?: boolean}} ref
 * @returns {boolean}
 */
function templateRefIsSystem(ref) {
  return typeof ref === 'string' ? false : !!ref.system;
}

/**
 * The source module of a system-in-flow template ref, or undefined.
 * @param {string | {sentFrom?: string}} ref
 * @returns {string|undefined}
 */
function templateRefSentFrom(ref) {
  return typeof ref === 'string' ? undefined : ref.sentFrom;
}

/**
 * Returns the terminal outcomes for a given handler type as an object
 * mapping outcome key → setsLeadStatus (or null when no status change).
 * Used by server routes to derive accepted key sets and status writes.
 *
 * @param {string} handlerType
 * @returns {Record<string, string|null>}
 */
function getTerminalStatusMap(handlerType) {
  const outcomes = HANDLER_OUTCOMES[handlerType] || [];
  const map = {};
  for (const o of outcomes) {
    if (o.kind === 'terminal') {
      map[o.key] = o.setsLeadStatus || null;
    }
  }
  return map;
}

/**
 * Returns the set of accepted terminal outcome keys for a handler type.
 * @param {string} handlerType
 * @returns {Set<string>}
 */
function getTerminalKeys(handlerType) {
  return new Set(
    (HANDLER_OUTCOMES[handlerType] || [])
      .filter(o => o.kind === 'terminal')
      .map(o => o.key)
  );
}

/**
 * For arrange_visit: returns the hs_lead_status to set for a given outcome + visitType.
 * Falls back to the 'design' variant when visitType is unknown.
 * Returns null when the outcome is not found or has no status.
 *
 * @param {string} outcomeKey
 * @param {string} visitType  'design' | 'survey'
 * @returns {string|null}
 */
function getArrangeVisitStatus(outcomeKey, visitType) {
  const outcome = (HANDLER_OUTCOMES.arrange_visit || []).find(o => o.key === outcomeKey);
  if (!outcome || outcome.kind !== 'terminal') return null;
  if (outcome.variants) {
    const v = outcome.variants[visitType] || outcome.variants['design'];
    return v?.setsLeadStatus || null;
  }
  return outcome.setsLeadStatus || null;
}

// Named-export form (exports.X = X) rather than module.exports = {...} so that
// Rollup's CommonJS plugin can statically detect the named exports when this
// module is imported from src/react/utils/handlerMeta.ts via Vite.
exports.HANDLER_OUTCOMES            = HANDLER_OUTCOMES;
exports.ACTION_LEVEL_EMAIL_TEMPLATES = ACTION_LEVEL_EMAIL_TEMPLATES;
exports.SYSTEM_EMAIL_TEMPLATES      = SYSTEM_EMAIL_TEMPLATES;
exports.templateRefKey              = templateRefKey;
exports.templateRefIsSystem         = templateRefIsSystem;
exports.templateRefSentFrom         = templateRefSentFrom;
exports.getTerminalStatusMap        = getTerminalStatusMap;
exports.getTerminalKeys             = getTerminalKeys;
exports.getArrangeVisitStatus       = getArrangeVisitStatus;
