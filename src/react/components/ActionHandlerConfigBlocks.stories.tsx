import React, { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import {
  DeliveryWindowConfig,
  InstallationSlotConfig,
  ScheduleVisitConfig,
  ShowMessageConfig,
  StartDesignVisitConfig,
} from '../pages/admin/HandlerConfigBlocks';
import type {
  LeadStatusOption,
  SubstatusOption,
} from '../pages/admin/HandlerConfigBlocks';

const meta: Meta = {
  title: 'Features/ActionHandlerConfigBlocks',
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Config blocks shown inside the "Add / Change action" editor modal. ' +
          'Each block is a self-contained React component exported from ' +
          'HandlerConfigBlocks.tsx. The DOM-appended modal in ActionHandlersPage ' +
          'mounts these components directly via createRoot, so stories and ' +
          'production share the same implementation with no drift risk.',
      },
    },
  },
};
export default meta;

type Story = StoryObj;

// ── Shared constants ────────────────────────────────────────────────────────────

const HANDLER_TYPES = [
  { value: 'add_design_visit_to_calendar', label: 'Add design visit to calendar' },
  { value: 'schedule_visit',               label: 'Schedule visit (any type)' },
  { value: 'summarise_phone_call',         label: 'Summarise phone call' },
  { value: 'show_message',                 label: 'Show informational message' },
  { value: 'start_design_visit',           label: 'Start design visit wizard' },
  { value: 'schedule_delivery_window',     label: 'Schedule delivery window' },
  { value: 'schedule_installation_slot',   label: 'Schedule installation slot' },
];

const HANDLER_TYPE_DESCRIPTIONS: Record<string, string> = {
  schedule_visit:
    'Generic visit scheduler — works for any visit type (survey, installation, ' +
    'remedial, workshop, etc.).\n' +
    '• Clicking the action on a card opens a DateTimePicker modal.\n' +
    '• On submit, a visit row is created in this CRM (POST /api/visits).\n' +
    '• Optionally adds a Google Calendar event (POST /api/events).\n' +
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
    '• On submit, a visit of type "delivery" is created in this CRM and appears ' +
    'in the "Upcoming visits" section of the customer page.\n' +
    '• If the operator ticks "Also add to my Google Calendar", a matching event ' +
    'is also created.\n' +
    'Config keys: defaultTitle (≤120 chars), addToGoogleCalendar (bool).',
  schedule_installation_slot:
    'Clicking the action on a card opens a modal for scheduling a single ' +
    'installation slot with a start time and duration.\n' +
    '• On submit, a visit of type "installation" is created in this CRM and ' +
    'appears in the "Upcoming visits" section of the customer page.\n' +
    '• If the operator ticks "Also add to my Google Calendar", a matching event ' +
    'is also created.\n' +
    'Config keys: defaultDurationMin (5–1440), defaultTitle (≤120 chars), ' +
    'addToGoogleCalendar (bool).',
};

// ── Fixture data for start_design_visit ────────────────────────────────────────

const FIXTURE_LEAD_STATUSES: LeadStatusOption[] = [
  { key: 'new_lead',        label: 'New lead' },
  { key: 'qualify',         label: 'Qualify' },
  { key: 'design_in_prog',  label: 'Design in progress' },
  { key: 'design_complete', label: 'Design complete' },
  { key: 'won',             label: 'Won' },
];

const FIXTURE_SUBSTATUSES: SubstatusOption[] = [
  { key: 'design_in_prog__booked',    label: 'Booked',     statusKey: 'design_in_prog' },
  { key: 'design_in_prog__submitted', label: 'Submitted',  statusKey: 'design_in_prog' },
  { key: 'design_complete__approved', label: 'Approved',   statusKey: 'design_complete' },
];

// ── Shared modal chrome ─────────────────────────────────────────────────────────

interface ModalChromeProps {
  selectedType: string;
  onTypeChange: (type: string) => void;
  children: React.ReactNode;
  slotLabel?: string;
}

function ModalChrome({
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

// ── Story wrappers ──────────────────────────────────────────────────────────────

function ScheduleVisitStory({ prefilledDuration = 60 }: { prefilledDuration?: number }) {
  const [type, setType] = useState('schedule_visit');
  return (
    <ModalChrome selectedType={type} onTypeChange={setType} slotLabel="Survey booked · Default action">
      <ScheduleVisitConfig defaultDurationMin={prefilledDuration} />
    </ModalChrome>
  );
}

function ShowMessageStory({
  prefilledTitle = '',
  prefilledMessage = '',
}: {
  prefilledTitle?: string;
  prefilledMessage?: string;
}) {
  const [type, setType] = useState('show_message');
  return (
    <ModalChrome selectedType={type} onTypeChange={setType} slotLabel="Quote sent · Default action">
      <ShowMessageConfig defaultTitle={prefilledTitle} defaultMessage={prefilledMessage} />
    </ModalChrome>
  );
}

function StartDesignVisitStory({
  prefilledIntermediate = '',
  prefilledSubmitted = '',
}: {
  prefilledIntermediate?: string;
  prefilledSubmitted?: string;
}) {
  const [type, setType] = useState('start_design_visit');
  return (
    <ModalChrome selectedType={type} onTypeChange={setType} slotLabel="Design visit · Default action">
      <StartDesignVisitConfig
        intermediateLeadStatus={prefilledIntermediate}
        submittedLeadStatus={prefilledSubmitted}
        leadStatuses={FIXTURE_LEAD_STATUSES}
        substatuses={FIXTURE_SUBSTATUSES}
      />
    </ModalChrome>
  );
}

function DeliveryWindowStory({ prefilledTitle = '' }: { prefilledTitle?: string }) {
  const [type, setType] = useState('schedule_delivery_window');
  return (
    <ModalChrome selectedType={type} onTypeChange={setType} slotLabel="Delivery ready · Default action">
      <DeliveryWindowConfig defaultTitle={prefilledTitle} />
    </ModalChrome>
  );
}

function InstallationSlotStory({
  prefilledTitle = '',
  prefilledDuration = 240,
}: {
  prefilledTitle?: string;
  prefilledDuration?: number;
}) {
  const [type, setType] = useState('schedule_installation_slot');
  return (
    <ModalChrome selectedType={type} onTypeChange={setType} slotLabel="Installation booked · Default action">
      <InstallationSlotConfig defaultDurationMin={prefilledDuration} defaultTitle={prefilledTitle} />
    </ModalChrome>
  );
}

// ── Stories: schedule_visit ────────────────────────────────────────────────────

export const ScheduleVisitBlank: Story = {
  name: 'Schedule visit — blank',
  render: () => <ScheduleVisitStory />,
  parameters: {
    docs: {
      description: {
        story:
          'Handler editor with "Schedule visit" pre-selected and default config. ' +
          'The config block exposes a visit type selector, an optional default ' +
          'duration field, and a Google Calendar toggle.',
      },
    },
  },
};

export const ScheduleVisitPrefilled: Story = {
  name: 'Schedule visit — pre-filled',
  render: () => <ScheduleVisitStory prefilledDuration={120} />,
  parameters: {
    docs: {
      description: {
        story:
          'Same block with a 120-minute default duration loaded — mirrors the ' +
          '"Change action" flow where the editor opens with the saved config.',
      },
    },
  },
};

// ── Stories: show_message ──────────────────────────────────────────────────────

export const ShowMessageBlank: Story = {
  name: 'Show message — blank',
  render: () => <ShowMessageStory />,
  parameters: {
    docs: {
      description: {
        story:
          'Handler editor with "Show informational message" pre-selected and an ' +
          'empty config. The config block exposes an optional title and a required ' +
          'message body.',
      },
    },
  },
};

export const ShowMessagePrefilled: Story = {
  name: 'Show message — pre-filled',
  render: () => (
    <ShowMessageStory
      prefilledTitle="Next step"
      prefilledMessage="Send the quote PDF from the shared drive and tick the next step manually."
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          'Same block with a saved title and message pre-populated — mirrors the ' +
          '"Change action" flow.',
      },
    },
  },
};

// ── Stories: start_design_visit ────────────────────────────────────────────────

export const StartDesignVisitBlank: Story = {
  name: 'Start design visit — blank',
  render: () => <StartDesignVisitStory />,
  parameters: {
    docs: {
      description: {
        story:
          'Handler editor with "Start design visit wizard" pre-selected and an ' +
          'empty config. The block exposes default duration, two lead-status ' +
          'selectors (in-progress and submitted), optional T&C text, and a ' +
          'Google Calendar toggle. Lead status options are populated from ' +
          'fixture data in this story.',
      },
    },
  },
};

export const StartDesignVisitPrefilled: Story = {
  name: 'Start design visit — pre-filled',
  render: () => (
    <StartDesignVisitStory
      prefilledIntermediate="design_in_prog"
      prefilledSubmitted="design_in_prog__submitted"
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          'Same block with saved lead status selections pre-populated — mirrors ' +
          'the "Change action" flow where an existing config is loaded into the editor.',
      },
    },
  },
};

// ── Stories: schedule_delivery_window ──────────────────────────────────────────

export const DeliveryWindowBlank: Story = {
  name: 'Schedule delivery window — blank',
  render: () => <DeliveryWindowStory />,
  parameters: {
    docs: {
      description: {
        story:
          'Handler editor with "Schedule delivery window" pre-selected and an empty config. ' +
          'The config block exposes a default title field (optional) and a Google Calendar toggle.',
      },
    },
  },
};

export const DeliveryWindowPrefilled: Story = {
  name: 'Schedule delivery window — pre-filled',
  render: () => <DeliveryWindowStory prefilledTitle="Delivery window" />,
  parameters: {
    docs: {
      description: {
        story:
          'Same block with an existing defaultTitle value loaded — mirrors the "Change action" ' +
          'flow where the editor opens with the saved config pre-populated.',
      },
    },
  },
};

// ── Stories: schedule_installation_slot ────────────────────────────────────────

export const InstallationSlotBlank: Story = {
  name: 'Schedule installation slot — blank',
  render: () => <InstallationSlotStory />,
  parameters: {
    docs: {
      description: {
        story:
          'Handler editor with "Schedule installation slot" pre-selected and default config ' +
          '(240-minute duration, no title). The config block exposes a duration field, a default ' +
          'title field, and a Google Calendar toggle.',
      },
    },
  },
};

export const InstallationSlotPrefilled: Story = {
  name: 'Schedule installation slot — pre-filled',
  render: () => <InstallationSlotStory prefilledTitle="Installation" prefilledDuration={480} />,
  parameters: {
    docs: {
      description: {
        story:
          'Same block loaded with saved config: 480-minute default duration and title "Installation".',
      },
    },
  },
};

export const InstallationSlotValidation: Story = {
  name: 'Schedule installation slot — duration validation error',
  render: () => {
    const [type, setType] = useState('schedule_installation_slot');
    return (
      <ModalChrome selectedType={type} onTypeChange={setType} slotLabel="Installation booked · Default action">
        <InstallationSlotConfig defaultDurationMin={9999} />
      </ModalChrome>
    );
  },
  parameters: {
    docs: {
      description: {
        story:
          'Shows the inline error state when the duration field contains a value outside the ' +
          '5–1440-minute range.',
      },
    },
  },
};

// ── All blocks side by side ─────────────────────────────────────────────────────

export const AllBlocksSideBySide: Story = {
  name: 'All config blocks — side by side',
  render: () => (
    <Stack
      direction={{ xs: 'column', md: 'row' }}
      spacing={3}
      sx={{ alignItems: 'flex-start', flexWrap: 'wrap' }}
    >
      {([
        { label: 'Schedule visit',            node: <ScheduleVisitStory /> },
        { label: 'Show message',              node: <ShowMessageStory prefilledMessage="Send the quote PDF." /> },
        { label: 'Start design visit',        node: <StartDesignVisitStory prefilledIntermediate="design_in_prog" prefilledSubmitted="design_in_prog__submitted" /> },
        { label: 'Schedule delivery window',  node: <DeliveryWindowStory prefilledTitle="Delivery window" /> },
        { label: 'Schedule installation slot',node: <InstallationSlotStory prefilledTitle="Installation" prefilledDuration={240} /> },
      ] as { label: string; node: React.ReactNode }[]).map(({ label, node }) => (
        <Box key={label} sx={{ flex: '1 1 300px', minWidth: 300 }}>
          <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            {label}
          </Typography>
          {node}
        </Box>
      ))}
    </Stack>
  ),
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        story:
          'All five config blocks rendered side by side for quick visual comparison.',
      },
    },
  },
};

export const BothSideBySide: Story = {
  name: 'Delivery + Installation — side by side',
  render: () => (
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} sx={{ alignItems: 'flex-start' }}>
      <Box sx={{ flex: 1, minWidth: 300 }}>
        <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          Schedule delivery window
        </Typography>
        <DeliveryWindowStory prefilledTitle="Delivery window" />
      </Box>
      <Box sx={{ flex: 1, minWidth: 300 }}>
        <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          Schedule installation slot
        </Typography>
        <InstallationSlotStory prefilledTitle="Installation" prefilledDuration={240} />
      </Box>
    </Stack>
  ),
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        story:
          'Delivery window and installation slot blocks rendered side by side for quick visual comparison.',
      },
    },
  },
};
