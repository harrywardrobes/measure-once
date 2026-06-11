/**
 * Static lookup tables that describe each card-action handler type.
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

export interface HandlerModalSummary {
  steps: string;
  hubspot: string;
}

export interface HandlerComponentMeta {
  component: string;
  filePath: string;
}

export const HANDLER_MODAL_SUMMARY: Record<HandlerType, HandlerModalSummary> = {
  add_design_visit_to_calendar: {
    steps: '1 step — date, time, duration, title, notes',
    hubspot: 'No HubSpot record changed',
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
  schedule_delivery_window: {
    steps: '1 step — window start and end date/time',
    hubspot: 'No HubSpot record changed',
  },
  schedule_installation_slot: {
    steps: '1 step — start time and duration',
    hubspot: 'No HubSpot record changed',
  },
  upload_photos_and_info: {
    steps: '1 step — confirmation → emails customer a unique form link',
    hubspot: 'Sets lead status to AWAITING_PHOTOS on submission',
  },
  review_customer_photos: {
    steps: '2 steps — review drawer → Not Suitable or Send Rough Estimate',
    hubspot: 'Sets lead status to NOT_SUITABLE or ROUGH_ESTIMATE on confirm',
  },
  arrange_visit: {
    steps: '2+ steps — call outcome → Booked / No answer / Call back / Not proceeding',
    hubspot: 'Sets lead status based on outcome (e.g. DSSC_AGREED, DSSC_SUGGESTED, not_suitable)',
  },
  contact_customer: {
    steps: '1–2 steps — log contact attempts → optionally advance lead status',
    hubspot: 'Advances lead status to ATTEMPTED_TO_CONTACT or NO_RESPONSE',
  },
  design_visit_followup: {
    steps: '2+ steps — hub (Confirmed / Resend invite / Not proceeding) → schedule or email step',
    hubspot: 'Sets lead status to DESIGN_SCHEDULED (confirmed), DESIGN_INVITED (resend), or NOT_SUITABLE (not proceeding)',
  },
  open_deal: {
    steps: '3 paths — amendments hub / accept deal wizard (3 steps) / decline flow (2 steps)',
    hubspot: 'Stays OPEN_DEAL on amendments; → DEPOSIT_INVOICE on accept; → DECLINED_DEAL on decline',
  },
};

export const HANDLER_TYPE_LABELS: Record<HandlerType, string> = {
  add_design_visit_to_calendar: 'Add design visit to calendar',
  schedule_visit:               'Schedule visit',
  summarise_phone_call:         'Summarise phone call',
  show_message:                 'Show informational message',
  start_design_visit:           'Start design visit wizard',
  schedule_delivery_window:     'Schedule delivery window',
  schedule_installation_slot:   'Schedule installation slot',
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
  upload_photos_and_info:       ['photo_review_invite', 'admin_notification', 'customer_thank_you'],
  review_customer_photos:       ['photo_review_not_suitable', 'photo_review_rough_estimate'],
  arrange_visit:                ['arrange_visit_no_answer'],
  contact_customer:             [],
  start_design_visit:           [],
  add_design_visit_to_calendar: ['visit_confirmation'],
  schedule_visit:               ['visit_confirmation'],
  summarise_phone_call:         [],
  show_message:                 [],
  schedule_delivery_window:     [],
  schedule_installation_slot:   [],
  design_visit_followup:        ['visit_invite', 'visit_confirmation'],
  open_deal:                    ['open_deal_deposit_invoice_sent', 'open_deal_declined_thank_you'],
};

export const HANDLER_COMPONENT_META: Record<HandlerType, HandlerComponentMeta> = {
  show_message: {
    component: 'MessagePopupModal',
    filePath:  'src/react/components/modals/MessagePopupModal.tsx',
  },
  add_design_visit_to_calendar: {
    component: 'ScheduleVisitModal',
    filePath:  'src/react/components/modals/ScheduleVisitModal.tsx',
  },
  schedule_visit: {
    component: 'ScheduleVisitModal',
    filePath:  'src/react/components/modals/ScheduleVisitModal.tsx',
  },
  schedule_delivery_window: {
    component: 'DeliveryWindowModal',
    filePath:  'src/react/components/modals/DeliveryWindowModal.tsx',
  },
  schedule_installation_slot: {
    component: 'InstallationSlotModal',
    filePath:  'src/react/components/modals/InstallationSlotModal.tsx',
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
