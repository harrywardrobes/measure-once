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
  googleEventId?: string | null;
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
  { key: 'sales',        bg: 'var(--stage-sales-bg)',          light: 'var(--stage-sales-light)',          text: 'var(--stage-sales-text)'          },
  { key: 'designvisit',  bg: 'var(--stage-designvisit-bg)',    light: 'var(--stage-designvisit-light)',    text: 'var(--stage-designvisit-text)'    },
  { key: 'survey',       bg: 'var(--stage-survey-bg)',         light: 'var(--stage-survey-light)',         text: 'var(--stage-survey-text)'         },
  { key: 'order',        bg: 'var(--stage-order-bg)',          light: 'var(--stage-order-light)',          text: 'var(--stage-order-text)'          },
  { key: 'workshop',     bg: 'var(--stage-workshop-bg)',       light: 'var(--stage-workshop-light)',       text: 'var(--stage-workshop-text)'       },
  { key: 'packing',      bg: 'var(--stage-packing-bg)',        light: 'var(--stage-packing-light)',        text: 'var(--stage-packing-text)'        },
  { key: 'delivery',     bg: 'var(--stage-delivery-bg)',       light: 'var(--stage-delivery-light)',       text: 'var(--stage-delivery-text)'       },
  { key: 'installation', bg: 'var(--stage-installation-bg)',   light: 'var(--stage-installation-light)',   text: 'var(--stage-installation-text)'   },
  { key: 'aftercare',    bg: 'var(--stage-aftercare-bg)',      light: 'var(--stage-aftercare-light)',      text: 'var(--stage-aftercare-text)'      },
];

export const STAGE_KEYS = ['sales','designvisit','survey','order','workshop','packing','delivery','installation','aftercare'];

export function stageColour(stageKey: string): StageColour {
  const idx = STAGE_KEYS.indexOf(stageKey);
  return STAGE_COLOURS[Math.max(0, idx)] || STAGE_COLOURS[0];
}

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
