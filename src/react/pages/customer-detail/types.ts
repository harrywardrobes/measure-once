import type { StructuredAddress } from '../../../../shared/address';

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
  structuredAddress?: StructuredAddress;
  customer_number?: string;
  hs_lead_status?: string;
  hs_object_id?: string;
  notes_last_contacted?: string;
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

export interface SurveyVisit {
  id: number;
  contact_id: string;
  status: string;
  visit_date?: string | null;
  created_at?: string;
  estimate_total_pence?: number;
  handle_name?: string | null;
  furniture_range_name?: string | null;
  revision_note?: string | null;
  contact_name?: string;
  contact_email?: string;
}

export interface DesignVisit {
  id: number;
  contact_id: string;
  status: string;
  visit_date?: string | null;
  created_at?: string;
  estimate_total_pence?: number;
  qb_estimate_doc_num?: string | null;
  deposit_invoice_id?: string | null;
  deposit_invoice_doc_num?: string | null;
  rooms?: DesignVisitRoom[];
  notes?: string | null;
  revision_note?: string | null;
  handle_name?: string | null;
  furniture_range_name?: string | null;
  location?: string | null;
  structuredAddress?: StructuredAddress | null;
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
  structuredAddress?: StructuredAddress | null;
  notes?: string;
  assigneeId?: string;
  assigneeRole?: string;
  googleEventId?: string | null;
  updatedAt?: string;
  version?: number;
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

export { STAGE_KEYS } from '../../utils/stageKeys';

export { stageColour } from '../../utils/stageColour';

export const DESIGN_VISIT_STATUS_LABELS: Record<string, { label: string; bg: string; fg: string }> = {
  draft:              { label: 'Draft',               bg: 'var(--status-neutral-bg)',   fg: 'var(--status-neutral-text)' },
  submitted:          { label: 'Submitted',           bg: 'var(--stage-order-light)',   fg: 'var(--stage-order-text)'   },
  signed_off:         { label: 'Signed off',          bg: 'var(--stage-packing-light)', fg: 'var(--stage-packing-text)' },
  revision_requested: { label: 'Revision requested',  bg: 'var(--stage-workshop-light)',fg: 'var(--stage-workshop-text)'},
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
