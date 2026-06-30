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
        // Design no-answer means the customer ghosted us — the card moves to the
        // excluded-from-sales GHOSTED status (survey keeps SURVEY_SCHEDULED).
        design: { setsLeadStatus: 'GHOSTED', label: 'Ghosted' },
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
      kind: 'terminal',
      variants: {
        design: { setsLeadStatus: 'DESIGN_SCHEDULED', label: 'Design visit scheduled' },
        survey: { setsLeadStatus: 'SURVEY_SCHEDULED', label: 'Survey scheduled' },
      },
      description: 'Creates a Google Calendar event; a fresh design/survey booking also advances the lead status to the matching *_SCHEDULED stage (generic visits and reschedules leave it unchanged)',
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
    { key: 'admin_notification', system: true, sentFrom: 'customer-info.js', trigger: 'Sent automatically when the customer submits their uploaded photos & info.' },
    { key: 'customer_thank_you', system: true, sentFrom: 'customer-info.js', trigger: 'Sent automatically when the customer submits their uploaded photos & info.' },
  ],
  // Staff-composed follow-up email sent from the Contact Customer modal when
  // the staff member chooses "Send Email" and confirms the pre-filled draft.
  contact_customer: [
    { key: 'contact_customer_followup', system: false, sentFrom: 'server.js', trigger: 'Pre-fills the Send Email panel in the Contact Customer modal. Staff can edit the subject and body before sending.' },
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
  {
    key: 'survey_refund_request',
    sentFrom: 'survey-visits.js',
    description: 'Admin notification sent when a survey deposit refund is requested ("customer changed their mind"), so the refund can be processed manually in QuickBooks.',
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
 * Plain-language trigger note on a template ref (action-level refs), or undefined.
 * @param {string | {trigger?: string}} ref
 * @returns {string|undefined}
 */
function templateRefTrigger(ref) {
  return typeof ref === 'string' ? undefined : ref.trigger;
}

/**
 * Returns the ordered list of email-template keys an outcome sends, resolved
 * from the registry's `sendsEmailTemplates`. This is the single source of
 * truth for which template a server send path uses for a given outcome —
 * routes must resolve their template key from here rather than hardcoding it.
 *
 * Returns an empty array when the handler/outcome is unknown or sends no email.
 *
 * @param {string} handlerType
 * @param {string} outcomeKey
 * @returns {string[]}
 */
function getOutcomeEmailTemplates(handlerType, outcomeKey) {
  const outcomes = HANDLER_OUTCOMES[handlerType] || [];
  const outcome = outcomes.find(o => o.key === outcomeKey);
  const refs = (outcome && outcome.sendsEmailTemplates) || [];
  return refs.map(templateRefKey);
}

/**
 * Like getOutcomeEmailTemplates but returns the single template key an outcome
 * sends, throwing a clear error when the outcome has none registered. Use this
 * at send sites that send exactly one email per outcome so a misconfigured
 * registry fails loudly rather than silently calling getEmailTemplate(undefined).
 *
 * @param {string} handlerType
 * @param {string} outcomeKey
 * @returns {string}
 */
function getRequiredOutcomeEmailTemplate(handlerType, outcomeKey) {
  const keys = getOutcomeEmailTemplates(handlerType, outcomeKey);
  if (!keys.length) {
    throw new Error(
      `No email template registered for outcome "${outcomeKey}" of handler ` +
      `"${handlerType}" in shared/handler-outcomes.cjs`
    );
  }
  return keys[0];
}

/**
 * Returns the ordered list of action-level email-template keys for a handler
 * type (emails sent during a handler's flow but not tied to a single
 * staff-selected outcome, e.g. customer-submitted-form notifications),
 * resolved from `ACTION_LEVEL_EMAIL_TEMPLATES`.
 *
 * Order matches the registry declaration order.
 *
 * @param {string} handlerType
 * @returns {string[]}
 */
function getActionLevelEmailTemplates(handlerType) {
  return (ACTION_LEVEL_EMAIL_TEMPLATES[handlerType] || []).map(templateRefKey);
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
      // Variant outcomes (arrange_visit, schedule_visit) carry their status
      // under design/survey rather than a top-level setsLeadStatus. Collapse to
      // the 'design' variant — matching getOutcomeMeta's visitType fallback — so
      // the map reflects a real status rather than null.
      map[o.key] = o.variants
        ? ((o.variants.design && o.variants.design.setsLeadStatus) || o.setsLeadStatus || null)
        : (o.setsLeadStatus || null);
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
 * Returns the response metadata triple for a single executed outcome:
 *   { outcome, setsLeadStatus, terminal }
 *
 * Used by execute routes to echo the resolved outcome back to the client so the
 * modal UI can show "Lead status set to X" and debugging is easier. All values
 * are derived from the registry — no hardcoding in the routes.
 *
 * For variant outcomes (arrange_visit booked/email_sent, schedule_visit
 * scheduled) the resolved status depends on visitType (design / survey), so
 * pass `{ visitType }` in opts; an unknown/absent visitType falls back to the
 * `design` variant. Unknown outcome keys return
 * `{ outcome, setsLeadStatus: null, terminal: false }`.
 *
 * @param {string} handlerType
 * @param {string} outcomeKey
 * @param {{ visitType?: string }} [opts]
 * @returns {{ outcome: string, setsLeadStatus: string|null, terminal: boolean }}
 */
function getOutcomeMeta(handlerType, outcomeKey, opts = {}) {
  const outcomes = HANDLER_OUTCOMES[handlerType] || [];
  const outcome = outcomes.find(o => o.key === outcomeKey);
  if (!outcome) {
    return { outcome: outcomeKey, setsLeadStatus: null, terminal: false };
  }
  const terminal = outcome.kind === 'terminal';
  let setsLeadStatus = null;
  if (terminal) {
    if (outcome.variants) {
      // visitType-dependent status (arrange_visit, schedule_visit). Fall back
      // to the 'design' variant when visitType is unknown/absent.
      const v = outcome.variants[opts.visitType] || outcome.variants.design;
      setsLeadStatus = (v && v.setsLeadStatus) || null;
    } else {
      setsLeadStatus = outcome.setsLeadStatus || null;
    }
  }
  return { outcome: outcomeKey, setsLeadStatus, terminal };
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
exports.HANDLER_OUTCOMES             = HANDLER_OUTCOMES;
exports.ACTION_LEVEL_EMAIL_TEMPLATES = ACTION_LEVEL_EMAIL_TEMPLATES;
exports.SYSTEM_EMAIL_TEMPLATES       = SYSTEM_EMAIL_TEMPLATES;
exports.templateRefKey               = templateRefKey;
exports.templateRefIsSystem          = templateRefIsSystem;
exports.templateRefSentFrom          = templateRefSentFrom;
exports.templateRefTrigger           = templateRefTrigger;
exports.getOutcomeEmailTemplates         = getOutcomeEmailTemplates;
exports.getRequiredOutcomeEmailTemplate  = getRequiredOutcomeEmailTemplate;
exports.getActionLevelEmailTemplates     = getActionLevelEmailTemplates;
exports.getTerminalStatusMap         = getTerminalStatusMap;
exports.getTerminalKeys              = getTerminalKeys;
exports.getOutcomeMeta               = getOutcomeMeta;
exports.getArrangeVisitStatus        = getArrangeVisitStatus;
