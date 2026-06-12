/**
 * Static lookup tables that describe each card-action handler type.
 *
 * HANDLER_OUTCOMES — maps handler type → ActionOutcome[] describing every
 *   possible result (terminal = moves the card, partial = logs progress).
 *   This is the TypeScript mirror of shared/handler-outcomes.js (the CJS
 *   module used by server-side routes).  The drift-guard test in
 *   test/card-action-handlers/drift-guard.js asserts both agree on terminal
 *   outcome keys.  The WorkflowPage ModalDetailCard renders these as chips.
 *
 * HANDLER_MODAL_SUMMARY  — maps handler type → { steps, hubspot } strings
 *   shown as inline one-liners in CardActionsPage and as detail rows in
 *   WorkflowPage.
 *
 * HANDLER_EMAIL_TEMPLATES — maps handler type → email template key array,
 *   used in WorkflowPage to show which templates fire and in
 *   EmailTemplatesPage to show "Used by" chips.
 *
 * HANDLER_COMPONENT_META — maps handler type → { component, filePath }
 *   used in WorkflowPage to show the modal component name and source path
 *   in the call-chain column and Modal Detail Card.
 *
 * ── CI exhaustiveness check ────────────────────────────────────────────────
 *
 * `scripts/check-handler-meta.mjs` (run via `npm run test:handler-meta`)
 * automatically discovers every `export const` in this file whose type
 * annotation is `Record<HandlerType, …>` and verifies that every handler
 * type declared in the ModalState union in CardActionModalsHost.tsx has a
 * matching key in each such table.
 *
 * This means: if you add a new lookup table here with the type
 *
 *   export const MY_NEW_TABLE: Record<HandlerType, …> = { … }
 *
 * the CI check will automatically require it to be exhaustive — no changes
 * to the script are needed. Conversely, if you add a new handler type to
 * CardActionModalsHost.tsx, the check will fail until every
 * `Record<HandlerType, …>` table in this file is updated to include it.
 */

import type { HandlerType } from '../components/CardActionModalsHost';
import {
  HANDLER_OUTCOMES as _sharedHandlerOutcomes,
  type ActionOutcome,
} from '../../../shared/handler-outcomes';

export type { ActionOutcome };

export interface HandlerModalSummary {
  steps: string;
  hubspot: string;
}

export interface HandlerComponentMeta {
  component: string;
  filePath: string;
}

/**
 * Outcome registry — maps every handler type to its possible outcomes.
 *
 * Data source: shared/handler-outcomes.js (CJS — single source of truth).
 * Each entry below pulls its value from the shared module so there is exactly
 * one place where the data lives.  The object-literal form is kept so that
 * check-handler-meta.mjs can statically verify exhaustiveness across all
 * Record<HandlerType, …> tables; the HandlerType constraint catches any
 * handler type added to CardActionModalsHost.tsx that is not listed here.
 * Drift guard: test/card-action-handlers/drift-guard.js.
 */
const _s = _sharedHandlerOutcomes;
export const HANDLER_OUTCOMES: Record<HandlerType, ActionOutcome[]> = {
  arrange_visit:            _s['arrange_visit'],
  contact_customer:         _s['contact_customer'],
  deposit_invoice_followup: _s['deposit_invoice_followup'],
  design_visit_followup:    _s['design_visit_followup'],
  open_deal:                _s['open_deal'],
  review_customer_photos:   _s['review_customer_photos'],
  schedule_visit:           _s['schedule_visit'],
  show_message:             _s['show_message'],
  start_design_visit:       _s['start_design_visit'],
  summarise_phone_call:     _s['summarise_phone_call'],
  upload_photos_and_info:   _s['upload_photos_and_info'],
};

/**
 * Typed outcome key helpers — derived from the registry at module load time.
 * Any key that no longer exists in the registry will throw a build-time error.
 * Import these in modal components instead of hardcoding raw string literals.
 */
function _k(type: string, key: string): string {
  const found = (HANDLER_OUTCOMES as Record<string, ActionOutcome[]>)[type]?.find(
    o => o.key === key,
  );
  if (!found) {
    throw new Error(`[handlerMeta] Registry missing outcome key '${key}' for handler '${type}'`);
  }
  return found.key;
}

/** Outcome keys for arrange_visit — import these instead of hardcoding strings. */
export const ARRANGE_VISIT_KEY = {
  booked:          _k('arrange_visit', 'booked'),
  email_sent:      _k('arrange_visit', 'email_sent'),
  not_proceeding:  _k('arrange_visit', 'not_proceeding'),
} as const;

/** Outcome keys for design_visit_followup — import these instead of hardcoding strings. */
export const DVF_OUTCOME_KEY = {
  confirmed:       _k('design_visit_followup', 'confirmed'),
  invite_resent:   _k('design_visit_followup', 'invite_resent'),
  not_proceeding:  _k('design_visit_followup', 'not_proceeding'),
} as const;

/** Outcome keys for review_customer_photos — import these instead of hardcoding strings. */
export const REVIEW_PHOTOS_OUTCOME_KEY = {
  not_suitable:        _k('review_customer_photos', 'not_suitable'),
  rough_estimate_sent: _k('review_customer_photos', 'rough_estimate_sent'),
} as const;

/** Outcome keys for contact_customer — import these instead of hardcoding strings. */
export const CONTACT_CUSTOMER_KEY = {
  // Terminal outcomes (move the card / write hs_lead_status)
  attempted_to_contact: _k('contact_customer', 'attempted_to_contact'),
  no_response:          _k('contact_customer', 'no_response'),
  send_upload_link:     _k('contact_customer', 'send_upload_link'),
  // Partial outcomes (attempt tracking — no card move)
  call_attempted:       _k('contact_customer', 'call_attempted'),
  email_sent:           _k('contact_customer', 'email_sent'),
  whatsapp_sent:        _k('contact_customer', 'whatsapp_sent'),
} as const;

export const HANDLER_MODAL_SUMMARY: Record<HandlerType, HandlerModalSummary> = {
  deposit_invoice_followup: {
    steps: '6 options — arrange survey / re-send invoice / send reminder / not proceeding / log call / amend deal',
    hubspot: 'No status change unless not-proceeding is selected',
  },
  schedule_visit: {
    steps: '1 step — date, time, duration, title, location, notes',
    hubspot: 'No HubSpot record changed',
  },
  summarise_phone_call: {
    steps: '1 step — raw call notes → LLM summary',
    hubspot: 'Saves timestamped note to HubSpot contact',
  },
  show_message: {
    steps: '1 step — informational popup only',
    hubspot: 'No HubSpot record changed',
  },
  start_design_visit: {
    steps: '3 steps — visit details → rooms → review',
    hubspot: 'Sets lead status to in-progress on open; to configured submitted status on submit',
  },
  upload_photos_and_info: {
    steps: '1 step — confirmation → emails customer a unique form link',
    hubspot: 'See outcomes below',
  },
  review_customer_photos: {
    steps: '2 steps — review drawer → Not Suitable or Send Rough Estimate',
    hubspot: 'See outcomes below',
  },
  arrange_visit: {
    steps: '2+ steps — call outcome → Booked / No answer / Call back / Not proceeding',
    hubspot: 'Status written depends on outcome and visit type — see outcomes below',
  },
  contact_customer: {
    steps: '1–2 steps — log contact attempts → optionally advance lead status',
    hubspot: 'See outcomes below',
  },
  design_visit_followup: {
    steps: '2+ steps — hub (Confirmed / Resend invite / Not proceeding) → schedule or email step',
    hubspot: 'See outcomes below',
  },
  open_deal: {
    steps: '3 paths — amendments hub / accept deal wizard (3 steps) / decline flow (2 steps)',
    hubspot: 'No status change on amendments — see outcomes below for accept / decline',
  },
};

export const HANDLER_TYPE_LABELS: Record<HandlerType, string> = {
  deposit_invoice_followup:     'Deposit invoice follow-up',
  schedule_visit:               'Schedule visit',
  summarise_phone_call:         'Summarise phone call',
  show_message:                 'Show informational message',
  start_design_visit:           'Start design visit wizard',
  upload_photos_and_info:       'Upload photos & info',
  review_customer_photos:       'Review customer photos',
  arrange_visit:                'Arrange visit',
  contact_customer:             'Contact customer (call / email / WhatsApp)',
  design_visit_followup:        'Design visit follow-up',
  open_deal:                    'Open deal (amend / accept / decline)',
};

/** Runtime narrowing guard — use instead of `as HandlerType` in onChange handlers. */
export function isHandlerType(v: string): v is HandlerType {
  return Object.prototype.hasOwnProperty.call(HANDLER_TYPE_LABELS, v);
}

export const HANDLER_EMAIL_TEMPLATES: Record<HandlerType, string[]> = {
  deposit_invoice_followup:     ['deposit_invoice_payment_reminder', 'open_deal_declined_thank_you'],
  upload_photos_and_info:       ['photo_review_invite', 'admin_notification', 'customer_thank_you'],
  review_customer_photos:       ['photo_review_not_suitable', 'photo_review_rough_estimate'],
  arrange_visit:                ['arrange_visit_no_answer'],
  contact_customer:             [],
  start_design_visit:           [],
  schedule_visit:               ['visit_confirmation'],
  summarise_phone_call:         [],
  show_message:                 [],
  design_visit_followup:        ['visit_invite', 'visit_confirmation'],
  open_deal:                    ['open_deal_deposit_invoice_sent', 'open_deal_declined_thank_you'],
};

export const HANDLER_COMPONENT_META: Record<HandlerType, HandlerComponentMeta> = {
  deposit_invoice_followup: {
    component: 'DepositInvoiceModal',
    filePath:  'src/react/components/modals/DepositInvoiceModal.tsx',
  },
  show_message: {
    component: 'MessagePopupModal',
    filePath:  'src/react/components/modals/MessagePopupModal.tsx',
  },
  schedule_visit: {
    component: 'ScheduleVisitModal',
    filePath:  'src/react/components/modals/ScheduleVisitModal.tsx',
  },
  summarise_phone_call: {
    component: 'PhoneSummaryModal',
    filePath:  'src/react/components/modals/PhoneSummaryModal.tsx',
  },
  start_design_visit: {
    component: 'DesignVisitWizard',
    filePath:  'src/react/components/DesignVisitWizard.tsx',
  },
  upload_photos_and_info: {
    component: 'UploadPhotosModal',
    filePath:  'src/react/components/modals/UploadPhotosModal.tsx',
  },
  review_customer_photos: {
    component: 'ReviewCustomerPhotosDrawer',
    filePath:  'src/react/components/modals/ReviewCustomerPhotosDrawer.tsx',
  },
  arrange_visit: {
    component: 'ArrangeVisitModal',
    filePath:  'src/react/components/modals/ArrangeVisitModal.tsx',
  },
  contact_customer: {
    component: 'ContactCustomerModal',
    filePath:  'src/react/components/modals/ContactCustomerModal.tsx',
  },
  design_visit_followup: {
    component: 'DesignVisitFollowupModal',
    filePath:  'src/react/components/modals/DesignVisitFollowupModal.tsx',
  },
  open_deal: {
    component: 'OpenDealActionModal',
    filePath:  'src/react/components/modals/OpenDealActionModal.tsx',
  },
};
