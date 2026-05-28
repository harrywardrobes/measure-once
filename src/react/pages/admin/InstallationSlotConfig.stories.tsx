import React, { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';

import { InstallationSlotConfig } from './HandlerConfigBlocks';
import { ModalChrome } from './_HandlerConfigBlockStoryHelpers';

const meta: Meta<typeof InstallationSlotConfig> = {
  title: 'Features/ActionHandlerConfigBlocks/InstallationSlot',
  component: InstallationSlotConfig,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Config block for the **Schedule installation slot** handler type. ' +
          'Exposes an optional default duration (5–1440 min), an optional default title ' +
          '(≤120 chars), and a Google Calendar toggle. ' +
          'When the action is clicked on a card, a modal opens for the operator to pick ' +
          'a start time; the saved duration is pre-filled.',
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof InstallationSlotConfig>;

function Wrapper({
  prefilledTitle = '',
  prefilledDuration = 240,
}: {
  prefilledTitle?: string;
  prefilledDuration?: number;
}) {
  const [type, setType] = useState('add_design_visit_to_calendar');
  return (
    <ModalChrome selectedType={type} onTypeChange={setType} slotLabel="Installation booked · Default action">
      <InstallationSlotConfig defaultDurationMin={prefilledDuration} defaultTitle={prefilledTitle} />
    </ModalChrome>
  );
}

export const Blank: Story = {
  name: 'Blank (default 240 min)',
  render: () => <Wrapper />,
  parameters: {
    docs: {
      description: {
        story:
          'Handler editor with "Schedule installation slot" pre-selected and default ' +
          'config (240-minute duration, no title). All three fields — duration, title, ' +
          'and Google Calendar toggle — are editable.',
      },
    },
  },
};

export const Prefilled: Story = {
  name: 'Pre-filled (480 min, titled)',
  render: () => <Wrapper prefilledTitle="Installation" prefilledDuration={480} />,
  parameters: {
    docs: {
      description: {
        story:
          'Same block loaded with saved config: 480-minute default duration and ' +
          'title "Installation". Mirrors the "Change action" flow.',
      },
    },
  },
};

export const DurationValidationError: Story = {
  name: 'Duration validation error',
  render: () => {
    const [type, setType] = useState('add_design_visit_to_calendar');
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
          'Shows the inline error state when the duration field contains a value ' +
          'outside the 5–1440-minute range (here 9999). The field turns red and ' +
          'displays "Must be between 5 and 1440 minutes."',
      },
    },
  },
};

export const CalendarOff: Story = {
  name: 'Google Calendar off',
  render: () => {
    const [type, setType] = useState('add_design_visit_to_calendar');
    return (
      <ModalChrome selectedType={type} onTypeChange={setType} slotLabel="Installation booked · Default action">
        <InstallationSlotConfig
          defaultDurationMin={240}
          defaultTitle="Installation"
          addToGoogleCalendar={false}
        />
      </ModalChrome>
    );
  },
  parameters: {
    docs: {
      description: {
        story:
          'Same block with the Google Calendar toggle pre-set to off — for teams ' +
          'that do not use Google Calendar integration.',
      },
    },
  },
};
