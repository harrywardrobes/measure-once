import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import type { LeadStatusOption } from './HandlerConfigBlocks';
import { NO_CONFIG_HANDLER_TYPES } from './ActionHandlersPage';

export { NO_CONFIG_HANDLER_TYPES };

export const HANDLER_TYPES = [
  { value: 'add_design_visit_to_calendar',  label: 'Add design visit to calendar' },
  { value: 'contact_customer',              label: 'Contact customer (call / email / WhatsApp)' },
  { value: 'start_design_visit',            label: 'Start design visit wizard' },
  { value: 'upload_photos_and_info',        label: 'Upload photos & info' },
  { value: 'review_customer_photos',        label: 'Review customer photos' },
  { value: 'schedule_visit',               label: 'Schedule visit (hidden from UI)' },
  { value: 'schedule_delivery_window',     label: 'Schedule delivery window (hidden from UI)' },
  { value: 'schedule_installation_slot',   label: 'Schedule installation slot (hidden from UI)' },
  { value: 'summarise_phone_call',         label: 'Summarise phone call (hidden from UI)' },
  { value: 'show_message',                 label: 'Show message (hidden from UI)' },
];

export const FIXTURE_LEAD_STATUSES: LeadStatusOption[] = [
  { key: 'new_lead',        label: 'New lead' },
  { key: 'qualify',         label: 'Qualify' },
  { key: 'design_in_prog',  label: 'Design in progress' },
  { key: 'design_complete', label: 'Design complete' },
  { key: 'won',             label: 'Won' },
];


const HANDLER_TYPE_DESCRIPTIONS: Record<string, string> = {
  schedule_visit:
    'Generic visit scheduler — works for any visit type (survey, installation, ' +
    'remedial, workshop, etc.).\n' +
    '• Clicking the action on a card opens a DateTimePicker modal.\n' +
    '• On submit, an event is created on the shared "Measure Once" Google ' +
    'Calendar (POST /api/events) — the single source of truth for scheduling. ' +
    'No separate CRM visit row is created.\n' +
    '• No HubSpot record is changed by this action.',
  show_message:
    'Clicking the action on a Sales/Survey card opens a simple popup showing ' +
    'the message you write below. Nothing else happens — no API call, no email, ' +
    'no calendar event, no HubSpot or CRM record change.\n' +
    'Use this when you just need to remind the operator what to do for this ' +
    'stage/lead-status.',
  start_design_visit:
    'Clicking the action on a Sales/Survey card opens a full multi-step design ' +
    'visit wizard.\n' +
    '• Two-phase HubSpot status update: wizard open → in-progress status; ' +
    'wizard submit → submitted status.\n' +
    '• Step 1 — Visit details. Step 2 — Rooms. Step 3 — Review.\n' +
    '• On submit: creates a design_visits DB record, updates HubSpot lead ' +
    'status, creates a HubSpot note, attempts a QuickBooks Estimate, emails ' +
    'the customer a sign-off link.',
  schedule_delivery_window:
    'Clicking the action on a card opens a modal for scheduling a delivery ' +
    'window with a start and end date/time.\n' +
    '• On submit, an event is created on the shared "Measure Once" Google ' +
    'Calendar (POST /api/events) — the single source of truth for scheduling. ' +
    'No separate CRM visit row is created.\n' +
    'Config keys: defaultTitle (≤120 chars).',
  schedule_installation_slot:
    'Clicking the action on a card opens a modal for scheduling a single ' +
    'installation slot with a start time and duration.\n' +
    '• On submit, an event is created on the shared "Measure Once" Google ' +
    'Calendar (POST /api/events) — the single source of truth for scheduling. ' +
    'No separate CRM visit row is created.\n' +
    'Config keys: defaultDurationMin (5–1440), defaultTitle (≤120 chars).',
};

interface ModalChromeProps {
  selectedType: string;
  onTypeChange: (type: string) => void;
  children: React.ReactNode;
  slotLabel?: string;
}

export function ModalChrome({
  selectedType,
  onTypeChange,
  children,
  slotLabel = 'Qualify lead · Default action',
}: ModalChromeProps) {
  return (
    <Paper
      elevation={3}
      sx={{
        maxWidth: 520,
        mx: 'auto',
        p: '24px 28px',
        borderRadius: 2,
        display: 'flex',
        flexDirection: 'column',
        gap: 1.5,
      }}
    >
      <Typography variant="h6" sx={{ fontWeight: 600, mb: 0 }}>
        Add action
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: -0.5 }}>
        for <strong>{slotLabel}</strong>
      </Typography>

      <Box>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mb: 0.5, fontWeight: 500 }}
        >
          Action type
        </Typography>
        <Select
          size="small"
          fullWidth
          value={selectedType}
          onChange={e => onTypeChange(e.target.value)}
        >
          {HANDLER_TYPES.map(t => (
            <MenuItem key={t.value} value={t.value}>{t.label}</MenuItem>
          ))}
        </Select>
      </Box>

      {HANDLER_TYPE_DESCRIPTIONS[selectedType] && (
        <Box
          sx={{
            bgcolor: 'grey.50',
            border: '1px solid',
            borderColor: 'grey.200',
            borderRadius: 1,
            p: 1.5,
          }}
        >
          <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'pre-line' }}>
            {HANDLER_TYPE_DESCRIPTIONS[selectedType]}
          </Typography>
        </Box>
      )}

      <Divider />

      {children}

      <Stack direction="row" sx={{ justifyContent: 'flex-end', mt: 1 }} spacing={1}>
        <Box
          component="button"
          sx={{
            px: 2, py: 0.75, borderRadius: 1, border: '1px solid', borderColor: 'divider',
            bgcolor: 'transparent', cursor: 'pointer', fontSize: '0.875rem',
          }}
        >
          Cancel
        </Box>
        <Box
          component="button"
          sx={{
            px: 2, py: 0.75, borderRadius: 1, border: 'none',
            bgcolor: 'primary.main', color: 'white', cursor: 'pointer', fontSize: '0.875rem',
          }}
        >
          Add
        </Box>
      </Stack>
    </Paper>
  );
}

export function useHandlerType(initial: string) {
  return useState(initial);
}
