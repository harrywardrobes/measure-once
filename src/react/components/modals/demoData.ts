/**
 * Single source of truth for placeholder data shown in admin demo mode.
 *
 * Demo mode lets admins preview a card-action modal from the Workflow tab
 * without touching any real contact, API, or storage. Every demo-mode code
 * path reads from these constants instead of fetching from the server.
 */

export interface DemoContact {
  name: string;
  phone: string;
  mobile: string;
  whatsapp: string;
  email: string;
  address: string;
  visitType: 'design' | 'survey';
}

export const DEMO_CONTACT: DemoContact = {
  name: 'Jane Smith',
  phone: '020 7946 0123',
  mobile: '07700 900456',
  whatsapp: '07700 900456',
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
  location: '12 Willow Lane, London, SW1A 1AA',
  designerName: 'Alex Taylor',
  handleId: 'demo-h1',
  furnitureRangeId: 'demo-fr1',
  termsAccepted: true,
} as const;

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
  },
];

// ── Photo-review drawer demo fixtures ─────────────────────────────────────────

/**
 * Structural type for the demo photo-review submission.
 * Kept in sync with the private `Submission` interface in
 * ReviewCustomerPhotosDrawer so the cast there is safe.
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
  correctedEmail: string | null;
  correctedMobile: string | null;
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
  correctedEmail: null,
  correctedMobile: null,
  submittedAt: null,
  emailSkippedCount: 0,
  photoUrls: [DEMO_PHOTO_1, DEMO_PHOTO_2],
  version: null,
  updatedAt: null,
};
