import React, { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import {
  DeliveryWindowConfig,
  InstallationSlotConfig,
  ScheduleVisitConfig,
  ShowMessageConfig,
  StartDesignVisitConfig,
} from '../pages/admin/HandlerConfigBlocks';
import {
  ModalChrome,
  FIXTURE_LEAD_STATUSES,
  FIXTURE_SUBSTATUSES,
  HANDLER_TYPES,
  NO_CONFIG_HANDLER_TYPES,
} from '../pages/admin/_HandlerConfigBlockStoryHelpers';

function configBlockForType(type: string): React.ReactNode {
  switch (type) {
    case 'schedule_visit':
      return <ScheduleVisitConfig defaultDurationMin={60} />;
    case 'show_message':
      return <ShowMessageConfig />;
    case 'start_design_visit':
      return (
        <StartDesignVisitConfig
          intermediateLeadStatus="design_in_prog"
          submittedLeadStatus="design_in_prog__submitted"
          leadStatuses={FIXTURE_LEAD_STATUSES}
          substatuses={FIXTURE_SUBSTATUSES}
        />
      );
    case 'schedule_delivery_window':
      return <DeliveryWindowConfig defaultTitle="Delivery window" />;
    case 'schedule_installation_slot':
      return <InstallationSlotConfig defaultTitle="Installation" defaultDurationMin={240} />;
    default:
      if (NO_CONFIG_HANDLER_TYPES.has(type)) {
        return (
          <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
            No additional configuration required for this action type.
          </Typography>
        );
      }
      return null;
  }
}

function LiveAddActionFlowDemo({ initialType, slotLabel }: { initialType: string; slotLabel: string }) {
  const [type, setType] = useState(initialType);
  React.useEffect(() => { setType(initialType); }, [initialType]);
  return (
    <ModalChrome
      selectedType={type}
      onTypeChange={setType}
      slotLabel={slotLabel}
    >
      {configBlockForType(type)}
    </ModalChrome>
  );
}

const meta: Meta = {
  title: 'Features/ActionHandlerConfigBlocks',
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Overview stories for all five handler config blocks side by side. ' +
          'Individual per-handler stories with blank / pre-filled / validation states ' +
          'live in `Features/ActionHandlerConfigBlocks/<HandlerName>` — co-located ' +
          'next to `HandlerConfigBlocks.tsx` in `src/react/pages/admin/`.',
      },
    },
  },
};
export default meta;

type Story = StoryObj;

export const LiveAddActionFlow: Story = {
  name: 'Live — full Add action modal flow',
  args: {
    initialType: 'add_design_visit_to_calendar',
    slotLabel: 'Survey booked · Default action',
  },
  argTypes: {
    initialType: {
      name: 'Initial handler type',
      description: 'Which handler type the modal opens on. Changing this control resets the dropdown to that type.',
      options: HANDLER_TYPES.map(t => t.value),
      control: {
        type: 'select',
        labels: Object.fromEntries(HANDLER_TYPES.map(t => [t.value, t.label])),
      },
    },
    slotLabel: {
      name: 'Slot label',
      description: 'The card stage / slot label shown in the modal subtitle.',
      control: { type: 'text' },
    },
  },
  render: (args: { initialType?: string; slotLabel?: string }) => (
    <LiveAddActionFlowDemo
      initialType={args.initialType ?? 'add_design_visit_to_calendar'}
      slotLabel={args.slotLabel ?? 'Survey booked · Default action'}
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          'The full "Add action" modal with a live type selector. ' +
          'Use the **Initial handler type** control in the Controls panel to open the ' +
          'story on any of the seven handler types without touching the in-canvas dropdown. ' +
          'Changing the **Action type** dropdown inside the modal still works as normal. ' +
          'Types with no configurable fields (e.g. Add design visit to calendar, ' +
          'Summarise phone call) show a "no additional configuration" placeholder.',
      },
    },
  },
};

function ScheduleVisitWrapper() {
  const [type, setType] = useState('add_design_visit_to_calendar');
  return (
    <ModalChrome selectedType={type} onTypeChange={setType} slotLabel="Survey booked · Default action">
      <ScheduleVisitConfig defaultDurationMin={60} />
    </ModalChrome>
  );
}

function ShowMessageWrapper() {
  const [type, setType] = useState('start_design_visit');
  return (
    <ModalChrome selectedType={type} onTypeChange={setType} slotLabel="Quote sent · Default action">
      <ShowMessageConfig defaultMessage="Send the quote PDF." />
    </ModalChrome>
  );
}

function StartDesignVisitWrapper() {
  const [type, setType] = useState('start_design_visit');
  return (
    <ModalChrome selectedType={type} onTypeChange={setType} slotLabel="Design visit · Default action">
      <StartDesignVisitConfig
        intermediateLeadStatus="design_in_prog"
        submittedLeadStatus="design_in_prog__submitted"
        leadStatuses={FIXTURE_LEAD_STATUSES}
        substatuses={FIXTURE_SUBSTATUSES}
      />
    </ModalChrome>
  );
}

function DeliveryWindowWrapper() {
  const [type, setType] = useState('add_design_visit_to_calendar');
  return (
    <ModalChrome selectedType={type} onTypeChange={setType} slotLabel="Delivery ready · Default action">
      <DeliveryWindowConfig defaultTitle="Delivery window" />
    </ModalChrome>
  );
}

function InstallationSlotWrapper() {
  const [type, setType] = useState('add_design_visit_to_calendar');
  return (
    <ModalChrome selectedType={type} onTypeChange={setType} slotLabel="Installation booked · Default action">
      <InstallationSlotConfig defaultTitle="Installation" defaultDurationMin={240} />
    </ModalChrome>
  );
}

export const AllBlocksSideBySide: Story = {
  name: 'All config blocks — side by side',
  render: () => (
    <Stack
      direction={{ xs: 'column', md: 'row' }}
      spacing={3}
      sx={{ alignItems: 'flex-start', flexWrap: 'wrap' }}
    >
      {([
        { label: 'Schedule visit',             node: <ScheduleVisitWrapper /> },
        { label: 'Show message',               node: <ShowMessageWrapper /> },
        { label: 'Start design visit',         node: <StartDesignVisitWrapper /> },
        { label: 'Schedule delivery window',   node: <DeliveryWindowWrapper /> },
        { label: 'Schedule installation slot', node: <InstallationSlotWrapper /> },
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
    docs: {
      description: {
        story: 'All five config blocks rendered side by side for quick visual comparison.',
      },
    },
  },
};

export const DeliveryAndInstallationSideBySide: Story = {
  name: 'Delivery + Installation — side by side',
  render: () => (
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} sx={{ alignItems: 'flex-start' }}>
      <Box sx={{ flex: 1, minWidth: 300 }}>
        <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          Schedule delivery window
        </Typography>
        <DeliveryWindowWrapper />
      </Box>
      <Box sx={{ flex: 1, minWidth: 300 }}>
        <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          Schedule installation slot
        </Typography>
        <InstallationSlotWrapper />
      </Box>
    </Stack>
  ),
  parameters: {
    docs: {
      description: {
        story:
          'Delivery window and installation slot blocks side by side — useful for ' +
          'comparing the two scheduling handlers at a glance.',
      },
    },
  },
};
