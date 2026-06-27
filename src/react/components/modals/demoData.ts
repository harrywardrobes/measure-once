/**
 * Single source of truth for placeholder data shown in admin demo mode.
 *
 * Demo mode lets admins preview a card-action modal from the Workflow tab
 * without touching any real contact, API, or storage. Every demo-mode code
 * path reads from these constants instead of fetching from the server.
 */

import type { VisitQuestion, AnswerMap } from '../QuestionnaireRenderer';

export interface DemoContact {
  name: string;
  phone: string;
  mobile: string;
  email: string;
  address: string;
  visitType: 'design' | 'survey';
}

export const DEMO_CONTACT: DemoContact = {
  name: 'Jane Smith',
  phone: '020 7946 0123',
  mobile: '07700 900456',
  email: 'jane.smith@example.com',
  address: '12 Willow Lane, London, SW1A 1AA',
  visitType: 'design',
};

/** Tooltip shown on every disabled primary button while in demo mode. */
export const DEMO_TOOLTIP = 'Demo mode — no changes will be saved';

// ── Design-visit wizard demo fixtures ─────────────────────────────────────────

/** Placeholder catalogue items (handles, furniture ranges, door styles). */
export interface DemoCatalogueItem { id: string; name: string; }

export const DEMO_HANDLES: DemoCatalogueItem[] = [
  { id: 'demo-h1', name: 'Slim Bar Handle' },
  { id: 'demo-h2', name: 'D-Shape Handle' },
];

export const DEMO_FURNITURE_RANGES: DemoCatalogueItem[] = [
  { id: 'demo-fr1', name: 'Classic Shaker' },
  { id: 'demo-fr2', name: 'Modern Slab' },
];

export const DEMO_DOOR_STYLES: DemoCatalogueItem[] = [
  { id: 'demo-ds1', name: 'White Matt' },
  { id: 'demo-ds2', name: 'Sage Green' },
];

export const DEMO_TERMS_TEXT =
  'By proceeding you confirm the customer has reviewed and accepted the design visit terms and conditions.';

/** Pre-filled step-1 values shown in the wizard demo. */
export const DEMO_STEP1 = {
  visitDate: '2026-06-25T10:00',
  duration: '90',
  structuredAddress: {
    addressLines: ['12 Willow Lane'],
    locality: 'London',
    administrativeArea: '',
    postalCode: 'SW1A 1AA',
    countryCode: 'GB',
  },
  designerName: 'Alex Taylor',
  handleId: 'demo-h1',
  furnitureRangeId: 'demo-fr1',
  termsAccepted: true,
};

/**
 * Sample whole-visit questionnaire questions (scope='visit') shown in the
 * wizard demo so the step-3 review can render a representative "Questionnaire"
 * section. Mirrors the shape returned by GET /api/visit-questions.
 */
export const DEMO_VISIT_QUESTIONS: VisitQuestion[] = [
  {
    id: 9001,
    scope: 'visit',
    applies_to: ['design'],
    label: 'Is the customer the property owner?',
    type: 'yesno',
    options: [],
    required: false,
    sort_order: 1,
  },
  {
    id: 9002,
    scope: 'visit',
    applies_to: ['design'],
    label: 'How did the customer hear about us?',
    type: 'choice',
    options: ['Referral', 'Online search', 'Social media', 'Returning customer'],
    required: false,
    sort_order: 2,
  },
  {
    id: 9003,
    scope: 'visit',
    applies_to: ['design'],
    label: 'Preferred installation timeframe',
    type: 'text',
    options: [],
    required: false,
    sort_order: 3,
  },
];

/** Demo answers to the whole-visit questions, keyed by question id. */
export const DEMO_VISIT_ANSWERS: AnswerMap = {
  9001: true,
  9002: 'Referral',
  9003: 'Within the next 3 months',
};

/**
 * Sample per-room questionnaire questions (scope='room') shown in the wizard
 * demo. Each demo room carries its own answers in DEMO_ROOMS[i].answers.
 */
export const DEMO_ROOM_QUESTIONS: VisitQuestion[] = [
  {
    id: 9101,
    scope: 'room',
    applies_to: ['design'],
    label: "What is the room's primary use?",
    type: 'choice',
    options: ['Cooking', 'Dining', 'Storage', 'Laundry'],
    required: false,
    sort_order: 1,
  },
  {
    id: 9102,
    scope: 'room',
    applies_to: ['design'],
    label: 'Are there existing appliances to integrate?',
    type: 'yesno',
    options: [],
    required: false,
    sort_order: 2,
  },
  {
    id: 9103,
    scope: 'room',
    applies_to: ['design'],
    label: 'Additional notes from the customer',
    type: 'text',
    options: [],
    required: false,
    sort_order: 3,
  },
];

/** Pre-filled rooms shown in the wizard demo. */
export const DEMO_ROOMS = [
  {
    roomName: 'Kitchen',
    doorStyleId: 'demo-ds1',
    widthMm: 4200 as number | null,
    heightMm: 2400 as number | null,
    depthMm: 600 as number | null,
    unitCount: 12,
    unitPricePence: 45000,
    notes: 'L-shaped layout, island on the right',
    images: [] as Array<{ storageKey: string; mimeType: string | null; viewUrl: string }>,
    answers: {
      9101: 'Cooking',
      9102: true,
      9103: 'Wants to keep the existing range cooker',
    } as AnswerMap,
  },
  {
    roomName: 'Utility Room',
    doorStyleId: 'demo-ds2',
    widthMm: 2100 as number | null,
    heightMm: 2400 as number | null,
    depthMm: 600 as number | null,
    unitCount: 4,
    unitPricePence: 35000,
    notes: '',
    images: [] as Array<{ storageKey: string; mimeType: string | null; viewUrl: string }>,
    answers: {
      9101: 'Laundry',
      9102: false,
    } as AnswerMap,
  },
];

// ── Survey-visit wizard demo fixtures ─────────────────────────────────────────

/**
 * Sample whole-visit questionnaire questions (scope='visit') shown in the
 * survey visit wizard demo so the review step renders a representative
 * "Questionnaire" section. Mirrors the shape returned by
 * GET /api/visit-questions?applies_to=survey.
 */
export const DEMO_SURVEY_VISIT_QUESTIONS: VisitQuestion[] = [
  {
    id: 9201,
    scope: 'visit',
    applies_to: ['survey'],
    label: 'Is the customer the property owner?',
    type: 'yesno',
    options: [],
    required: false,
    sort_order: 1,
  },
  {
    id: 9202,
    scope: 'visit',
    applies_to: ['survey'],
    label: 'How did the customer hear about us?',
    type: 'choice',
    options: ['Referral', 'Online search', 'Social media', 'Returning customer'],
    required: false,
    sort_order: 2,
  },
  {
    id: 9203,
    scope: 'visit',
    applies_to: ['survey'],
    label: 'Any access restrictions on the day?',
    type: 'text',
    options: [],
    required: false,
    sort_order: 3,
  },
];

/** Demo answers to the whole-visit survey questions, keyed by question id. */
export const DEMO_SURVEY_VISIT_ANSWERS: AnswerMap = {
  9201: true,
  9202: 'Referral',
  9203: 'Parking available on the driveway',
};

/**
 * Sample per-room questionnaire questions (scope='room') shown in the survey
 * visit wizard demo. Each demo room carries its own answers via DEMO_ROOMS.
 */
export const DEMO_SURVEY_ROOM_QUESTIONS: VisitQuestion[] = [
  {
    id: 9301,
    scope: 'room',
    applies_to: ['survey'],
    label: "What is the room's primary use?",
    type: 'choice',
    options: ['Cooking', 'Dining', 'Storage', 'Laundry'],
    required: false,
    sort_order: 1,
  },
  {
    id: 9302,
    scope: 'room',
    applies_to: ['survey'],
    label: 'Are there existing appliances to integrate?',
    type: 'yesno',
    options: [],
    required: false,
    sort_order: 2,
  },
  {
    id: 9303,
    scope: 'room',
    applies_to: ['survey'],
    label: 'Additional surveyor notes',
    type: 'text',
    options: [],
    required: false,
    sort_order: 3,
  },
];

/**
 * Per-room answers for the survey visit demo, keyed by room index then
 * question id. Used to populate DEMO_ROOMS' answers for survey demo mode.
 */
export const DEMO_SURVEY_ROOM_ANSWERS: AnswerMap[] = [
  { 9301: 'Cooking', 9302: true,  9303: 'Wants to keep the existing range cooker' },
  { 9301: 'Laundry', 9302: false, 9303: '' },
];

// ── Photo-review drawer demo fixtures ─────────────────────────────────────────

/**
 * Structural type for the demo photo-review submission.
 * Kept in sync with the private `Submission` interface in
 * ReviewCustomerPhotosModal so the cast there is safe.
 */
export interface DemoSubmissionData {
  id: number;
  contactId: string;
  contactName: string | null;
  contactEmail: string | null;
  maskedEmail: string | null;
  addressLine1: string | null;
  city: string | null;
  postcode: string | null;
  roomCount: string | null;
  roomNotes: string | null;
  submittedAt: string | null;
  emailSkippedCount: number;
  photoUrls: string[];
  version?: number | null;
  updatedAt?: string | null;
}

/** Inline SVG data-URI placeholder photos — no network request needed. */
const DEMO_PHOTO_1 =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Crect width='200' height='200' fill='%23e8e0d4'/%3E%3Ctext x='100' y='108' font-size='15' font-family='sans-serif' text-anchor='middle' fill='%23a08070'%3EKitchen%3C/text%3E%3C/svg%3E";
const DEMO_PHOTO_2 =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Crect width='200' height='200' fill='%23d4dce8'/%3E%3Ctext x='100' y='108' font-size='15' font-family='sans-serif' text-anchor='middle' fill='%2370809a'%3ELiving room%3C/text%3E%3C/svg%3E";

// ── Deposit Invoice follow-up demo fixture ────────────────────────────────────

/**
 * Placeholder LoaderData shown inside DepositInvoiceModal when demo=true.
 * Matches the private LoaderData interface in DepositInvoiceModal.tsx.
 */
export const DEMO_DEPOSIT_INVOICE = {
  contactName:      DEMO_CONTACT.name,
  contactEmail:     DEMO_CONTACT.email,
  contactPhone:     DEMO_CONTACT.phone,
  contactMobile:    DEMO_CONTACT.mobile,
  contactAddress:   DEMO_CONTACT.address,
  qbConnected:      true,
  invoiceId:        'demo-inv-001',
  invoiceDocNum:    '2099',
  invoiceTotalAmt:  1500,
  invoiceBalance:   1500,
  invoiceTxnDate:   '2026-06-01',
  invoiceLink:      'https://app.qbo.intuit.com/app/invoice?txnId=demo-inv-001',
  qbEstimateId:     'demo-est-001',
} as const;

export const DEMO_SUBMISSION: DemoSubmissionData = {
  id: 0,
  contactId: 'demo-preview',
  contactName: 'Jane Smith',
  contactEmail: 'jane.smith@example.com',
  maskedEmail: 'j***@example.com',
  addressLine1: '12 Willow Lane',
  city: 'London',
  postcode: 'SW1A 1AA',
  roomCount: '2',
  roomNotes: 'Kitchen and living/dining room. Looking for a modern shaker style.',
  submittedAt: null,
  emailSkippedCount: 0,
  photoUrls: [DEMO_PHOTO_1, DEMO_PHOTO_2],
  version: null,
  updatedAt: null,
};
