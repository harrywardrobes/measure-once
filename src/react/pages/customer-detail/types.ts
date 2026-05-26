export interface ContactProperties {
  firstname?: string;
  lastname?: string;
  email?: string;
  phone?: string;
  mobilephone?: string;
  company?: string;
  address?: string;
  city?: string;
  zip?: string;
  customer_number?: string;
  hs_lead_status?: string;
  hw_lead_substatus?: string;
  hs_object_id?: string;
}

export interface Contact {
  id: string;
  properties: ContactProperties;
}

export interface Room {
  room: string;
  stageKey: string;
  completedStatuses: Record<string, string[]>;
  comments: RoomComment[];
  stageDates: Record<string, string>;
  substateDates?: Record<string, string>;
  installStart?: string | null;
  installFinish?: string | null;
  assignedFitterId?: string | null;
  roomStatus?: string;
}

export interface RoomComment {
  text: string;
  date: string;
  author?: string;
  isDraft?: boolean;
}

export interface HubSpotTask {
  id: string;
  properties: {
    hs_task_subject?: string;
    hs_task_body?: string;
    hs_task_status?: string;
    hs_timestamp?: string;
  };
}

export interface LeadStatus {
  value: string;
  label: string;
  stage?: string | null;
  excluded_from_sales?: boolean;
  sort_order?: number;
}

export interface LeadSubstatus {
  substatus_key: string;
  status_key: string;
  label: string;
  sort_order?: number;
  action_label?: string;
}

export interface DesignVisit {
  id: number;
  contact_id: string;
  status: string;
  visit_date?: string | null;
  created_at?: string;
  estimate_total_pence?: number;
  qb_estimate_doc_num?: string | null;
  rooms?: DesignVisitRoom[];
  notes?: string | null;
  revision_note?: string | null;
  handle_name?: string | null;
  furniture_range_name?: string | null;
  location?: string | null;
  contact_name?: string;
  contact_email?: string;
}

export interface DesignVisitRoom {
  room_name?: string;
  door_style_name?: string;
  width_mm?: number | null;
  height_mm?: number | null;
  depth_mm?: number | null;
  unit_count?: number;
  unit_price_pence?: number;
}

export interface Visit {
  id: number;
  type?: string;
  title?: string;
  startAt: string;
  endAt: string;
  customerId?: string;
  customerName?: string;
  location?: string;
  notes?: string;
  assigneeId?: string;
  assigneeRole?: string;
}

export interface QBInvoice {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  DueDate?: string;
  Balance?: number;
  TotalAmt?: number;
  CustomerRef?: { name?: string; value?: string };
  BillEmail?: { Address?: string };
  EmailStatus?: string;
  TxnStatus?: string;
}

export interface GoogleEmail {
  id: string;
  from?: string;
  subject?: string;
  snippet?: string;
  date?: string;
  threadId?: string;
}

export interface WhatsAppMessage {
  id?: string;
  direction: 'in' | 'out';
  body?: string;
  timestamp?: string;
  status?: string;
}

export interface StageColour {
  key: string;
  bg: string;
  light: string;
  text: string;
}

export const STAGE_COLOURS: StageColour[] = [
  { key: 'sales',        bg: '#8B2BFF', light: '#F3EAFF', text: '#6A12D9' },
  { key: 'designvisit',  bg: '#0d9488', light: '#ccfbf1', text: '#0f766e' },
  { key: 'survey',       bg: '#d97706', light: '#fef3c7', text: '#b45309' },
  { key: 'order',        bg: '#2563eb', light: '#dbeafe', text: '#1d4ed8' },
  { key: 'workshop',     bg: '#dc2626', light: '#fee2e2', text: '#b91c1c' },
  { key: 'packing',      bg: '#059669', light: '#d1fae5', text: '#047857' },
  { key: 'delivery',     bg: '#0891b2', light: '#cffafe', text: '#0e7490' },
  { key: 'installation', bg: '#8A5A3B', light: '#fdf6ee', text: '#5c3820' },
  { key: 'aftercare',    bg: '#200842', light: '#ede0ff', text: '#3d0f7a' },
];

export const STAGE_KEYS = ['sales','designvisit','survey','order','workshop','packing','delivery','installation','aftercare'];

export function stageColour(stageKey: string): StageColour {
  const idx = STAGE_KEYS.indexOf(stageKey);
  return STAGE_COLOURS[Math.max(0, idx)] || STAGE_COLOURS[0];
}

export const DESIGN_VISIT_STATUS_LABELS: Record<string, { label: string; bg: string; fg: string }> = {
  draft:              { label: 'Draft',               bg: '#f3f4f6', fg: '#374151' },
  submitted:          { label: 'Submitted',           bg: '#dbeafe', fg: '#1d4ed8' },
  signed_off:         { label: 'Signed off',          bg: '#d1fae5', fg: '#047857' },
  revision_requested: { label: 'Revision requested',  bg: '#fee2e2', fg: '#b91c1c' },
};

export function contactName(contact: Contact | null | undefined): string {
  if (!contact) return 'Unknown';
  const p = contact.properties;
  const parts = [p.firstname, p.lastname].filter(Boolean);
  if (parts.length) return parts.join(' ');
  return p.email || p.company || 'Unknown';
}

export function fmtDesignVisitWhen(iso?: string | null): string {
  if (!iso) return 'Unknown date';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtGbp(pence: number): string {
  return (pence / 100).toFixed(2);
}
