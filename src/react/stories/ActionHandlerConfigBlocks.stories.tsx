import React, { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

const meta: Meta = {
  title: 'Admin/Action Handler Config Blocks',
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Config blocks shown inside the "Add / Change action" editor modal ' +
          'when the handler type is set to "Schedule delivery window" or ' +
          '"Schedule installation slot". These blocks are rendered inside a ' +
          'DOM-appended modal in ActionHandlersPage — these stories present ' +
          'each block in isolation so it can be reviewed and iterated on in ' +
          'the design gallery.',
      },
    },
  },
};
export default meta;

type Story = StoryObj;

// ── Shared modal chrome ────────────────────────────────────────────────────────

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
  schedule_delivery_window:
    'Clicking the action on a card opens a modal for scheduling a delivery ' +
    'window with a start and end date/time.\n' +
    '• The operator picks a window start and window end (e.g. "8 AM – 1 PM on 12 June").\n' +
    '• On submit, a visit of type "delivery" is created in this CRM and appears in the ' +
    '"Upcoming visits" section of the customer page.\n' +
    '• If the operator ticks "Also add to my Google Calendar", a matching event is also created.\n' +
    '• No HubSpot record is changed by this action.\n' +
    'Config keys: defaultTitle (≤120 chars), addToGoogleCalendar (bool).',
  schedule_installation_slot:
    'Clicking the action on a card opens a modal for scheduling a single ' +
    'installation slot with a start time and duration.\n' +
    '• The operator picks a start date/time and a duration in minutes (default 240 min / 4 hours).\n' +
    '• On submit, a visit of type "installation" is created in this CRM and appears in the ' +
    '"Upcoming visits" section of the customer page.\n' +
    '• If the operator ticks "Also add to my Google Calendar", a matching event is also created.\n' +
    '• No HubSpot record is changed by this action.\n' +
    'Config keys: defaultDurationMin (5–1440), defaultTitle (≤120 chars), addToGoogleCalendar (bool).',
};

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
          Action name <span style={{ fontWeight: 400 }}>(optional)</span>
        </Typography>
        <TextField
          size="small"
          fullWidth
          placeholder="e.g. send_quote"
          slotProps={{ htmlInput: { maxLength: 80 } }}
          helperText="Used for backend automation — snake_case only."
        />
      </Box>

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

// ── Delivery window config block ───────────────────────────────────────────────

interface DeliveryWindowConfigProps {
  defaultTitle?: string;
  addToGoogleCalendar?: boolean;
}

function DeliveryWindowConfigBlock({
  defaultTitle: initialTitle = '',
  addToGoogleCalendar: initialGcal = true,
}: DeliveryWindowConfigProps) {
  const [title, setTitle] = useState(initialTitle);
  const [gcal, setGcal]   = useState(initialGcal);

  return (
    <Stack spacing={1.5}>
      <Box>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mb: 0.5, fontWeight: 500 }}
        >
          Default title <span style={{ fontWeight: 400 }}>(optional, ≤120 chars)</span>
        </Typography>
        <TextField
          size="small"
          fullWidth
          placeholder="e.g. Delivery window"
          value={title}
          slotProps={{ htmlInput: { maxLength: 120 } }}
          onChange={e => setTitle(e.target.value)}
        />
      </Box>
      <FormControlLabel
        control={
          <Checkbox
            size="small"
            checked={gcal}
            onChange={e => setGcal(e.target.checked)}
          />
        }
        label={<Typography variant="body2">Also add to Google Calendar</Typography>}
      />
    </Stack>
  );
}

// ── Installation slot config block ─────────────────────────────────────────────

interface InstallationSlotConfigProps {
  defaultDurationMin?: number | '';
  defaultTitle?: string;
  addToGoogleCalendar?: boolean;
}

function InstallationSlotConfigBlock({
  defaultDurationMin: initialDur = 240,
  defaultTitle: initialTitle = '',
  addToGoogleCalendar: initialGcal = true,
}: InstallationSlotConfigProps) {
  const [dur,   setDur]   = useState<number | ''>(initialDur);
  const [title, setTitle] = useState(initialTitle);
  const [gcal,  setGcal]  = useState(initialGcal);

  const durNum  = dur === '' ? NaN : Number(dur);
  const durError =
    dur !== '' && (isNaN(durNum) || durNum < 5 || durNum > 1440)
      ? 'Must be between 5 and 1440 minutes.'
      : '';

  return (
    <Stack spacing={1.5}>
      <Box>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mb: 0.5, fontWeight: 500 }}
        >
          Default duration (min) <span style={{ fontWeight: 400 }}>(optional, 5–1440)</span>
        </Typography>
        <TextField
          size="small"
          type="number"
          value={dur}
          error={!!durError}
          helperText={durError || undefined}
          slotProps={{ htmlInput: { min: 5, max: 1440, step: 5 } }}
          onChange={e => setDur(e.target.value === '' ? '' : Number(e.target.value))}
        />
      </Box>
      <Box>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mb: 0.5, fontWeight: 500 }}
        >
          Default title <span style={{ fontWeight: 400 }}>(optional, ≤120 chars)</span>
        </Typography>
        <TextField
          size="small"
          fullWidth
          placeholder="e.g. Installation"
          value={title}
          slotProps={{ htmlInput: { maxLength: 120 } }}
          onChange={e => setTitle(e.target.value)}
        />
      </Box>
      <FormControlLabel
        control={
          <Checkbox
            size="small"
            checked={gcal}
            onChange={e => setGcal(e.target.checked)}
          />
        }
        label={<Typography variant="body2">Also add to Google Calendar</Typography>}
      />
    </Stack>
  );
}

// ── Stories ────────────────────────────────────────────────────────────────────

function DeliveryWindowStory({ prefilledTitle = '' }: { prefilledTitle?: string }) {
  const [type, setType] = useState('schedule_delivery_window');
  return (
    <ModalChrome selectedType={type} onTypeChange={setType} slotLabel="Delivery ready · Default action">
      <DeliveryWindowConfigBlock defaultTitle={prefilledTitle} />
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
      <InstallationSlotConfigBlock defaultDurationMin={prefilledDuration} defaultTitle={prefilledTitle} />
    </ModalChrome>
  );
}

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
        <InstallationSlotConfigBlock defaultDurationMin={9999} />
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

export const BothSideBySide: Story = {
  name: 'Both config blocks — side by side',
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
          'Both config blocks rendered side by side for quick visual comparison.',
      },
    },
  },
};
