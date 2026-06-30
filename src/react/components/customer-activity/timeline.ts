import React from 'react';
import EmailOutlined from '@mui/icons-material/EmailOutlined';
import CallOutlined from '@mui/icons-material/CallOutlined';
import EventOutlined from '@mui/icons-material/EventOutlined';
import NotesOutlined from '@mui/icons-material/NotesOutlined';
import DescriptionOutlined from '@mui/icons-material/DescriptionOutlined';
import TaskAltOutlined from '@mui/icons-material/TaskAltOutlined';
import CampaignOutlined from '@mui/icons-material/CampaignOutlined';
import LanguageOutlined from '@mui/icons-material/LanguageOutlined';
import WhatsAppIcon from '@mui/icons-material/WhatsApp';

// ── Shared contact-activity timeline model ───────────────────────────────────
// One normalized shape backs both the Contact Customer modal timeline and the
// customer detail page activity feed, so a row renders identically in either
// surface. `marketing_email` and `page_view` only appear on the detail page.

/** HubSpot-sourced activity types returned by the backend activity builder. */
export type ActivityType =
  | 'email'
  | 'call'
  | 'meeting'
  | 'note'
  | 'task'
  | 'form_submission'
  | 'marketing_email'
  | 'page_view';

/** Internal Harry Wardrobes contact-attempt methods. */
export type AttemptMethod = 'call' | 'email' | 'whatsapp';

export interface HubspotActivity {
  id: string;
  source: 'hubspot';
  type: ActivityType;
  timestamp: string | null;
  title: string;
  direction?: 'incoming' | 'outgoing' | null;
  actor: string | null;
  body: string | null;
  meta?: Record<string, unknown>;
}

export interface ActivityResponse {
  activities: HubspotActivity[];
  unavailable?: string[];
  truncated?: boolean;
}

/** A single row in the unified timeline — HubSpot activity OR an internal attempt. */
export type TimelineType = ActivityType | AttemptMethod;

export interface TimelineItem {
  id: string;
  source: 'hubspot' | 'measureonce';
  type: TimelineType;
  timestamp: string | null;
  title: string;
  direction?: 'incoming' | 'outgoing' | null;
  actor: string | null;
  body: string | null;
  meta?: Record<string, unknown>;
}

type MuiIcon = React.ComponentType<{ fontSize?: 'inherit' | 'small' | 'medium' | 'large'; sx?: object }>;

export const TYPE_ICON: Record<TimelineType, MuiIcon> = {
  email:           EmailOutlined,
  call:            CallOutlined,
  meeting:         EventOutlined,
  note:            NotesOutlined,
  task:            TaskAltOutlined,
  form_submission: DescriptionOutlined,
  marketing_email: CampaignOutlined,
  page_view:       LanguageOutlined,
  whatsapp:        WhatsAppIcon,
};

export const TIMELINE_TYPE_LABEL: Record<TimelineType, string> = {
  email:           'Email',
  call:            'Call',
  meeting:         'Meeting',
  note:            'Note',
  task:            'Task',
  form_submission: 'Form',
  marketing_email: 'Marketing',
  page_view:       'Page view',
  whatsapp:        'WhatsApp',
};
