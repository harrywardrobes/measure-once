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
 */

export interface HandlerModalSummary {
  steps: string;
  hubspot: string;
}

export const HANDLER_MODAL_SUMMARY: Record<string, HandlerModalSummary> = {
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
    hubspot: 'Sets lead status to AWAITING_PHOTOS / AWPH_RECEIVED on submission',
  },
  review_customer_photos: {
    steps: '2 steps — review drawer → Not Suitable or Send Rough Estimate',
    hubspot: 'Sets lead status to NOT_SUITABLE or ROUGH_ESTIMATE_SENT on confirm',
  },
  arrange_visit: {
    steps: '2+ steps — call outcome → Booked / No answer / Call back / Not proceeding',
    hubspot: 'Sets lead status based on outcome (e.g. DSSC_AGREED, DSSC_SUGGESTED, not_suitable)',
  },
};

export const HANDLER_TYPE_LABELS: Record<string, string> = {
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
};

export const HANDLER_EMAIL_TEMPLATES: Record<string, string[]> = {
  upload_photos_and_info:       ['customer_invite', 'admin_notification', 'customer_thank_you'],
  review_customer_photos:       ['photo_review_not_suitable', 'photo_review_rough_estimate'],
  arrange_visit:                ['arrange_visit_no_answer'],
  start_design_visit:           [],
  add_design_visit_to_calendar: [],
  schedule_visit:               [],
  summarise_phone_call:         [],
  show_message:                 [],
  schedule_delivery_window:     [],
  schedule_installation_slot:   [],
};
