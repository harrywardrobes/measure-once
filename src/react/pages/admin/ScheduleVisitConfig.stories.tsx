import React, { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';

import { ScheduleVisitConfig } from './HandlerConfigBlocks';
import { ModalChrome } from './_HandlerConfigBlockStoryHelpers';

const meta: Meta<typeof ScheduleVisitConfig> = {
  title: 'Features/ActionHandlerConfigBlocks/ScheduleVisit',
  component: ScheduleVisitConfig,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Config block for the **Schedule visit** handler type. ' +
          'Exposes a visit-type selector, an optional default duration field (5–1440 min), ' +
          'and a Google Calendar toggle. ' +
          'Rendered inside the "Add / Change action" editor modal in ActionHandlersPage.',
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof ScheduleVisitConfig>;

function Wrapper({ prefilledDuration = 60 }: { prefilledDuration?: number }) {
  const [type, setType] = useState('schedule_visit');
  return (
    <ModalChrome selectedType={type} onTypeChange={setType} slotLabel="Survey booked · Default action">
      <ScheduleVisitConfig defaultDurationMin={prefilledDuration} />
    </ModalChrome>
  );
}

export const Blank: Story = {
  name: 'Blank',
  render: () => <Wrapper />,
  parameters: {
    docs: {
      description: {
        story:
          'Handler editor with "Schedule visit" pre-selected and default config ' +
          '(visit type = Survey, duration = 60 min, Google Calendar on). ' +
          'The visit type selector, duration field, and calendar toggle are all editable.',
      },
    },
  },
};

export const Prefilled: Story = {
  name: 'Pre-filled (120 min)',
  render: () => <Wrapper prefilledDuration={120} />,
  parameters: {
    docs: {
      description: {
        story:
          'Same block with a 120-minute default duration already loaded — mirrors ' +
          'the "Change action" flow where the editor opens with the previously saved config.',
      },
    },
  },
};

export const DurationValidationError: Story = {
  name: 'Duration validation error',
  render: () => {
    const [type, setType] = useState('schedule_visit');
    return (
      <ModalChrome selectedType={type} onTypeChange={setType} slotLabel="Survey booked · Default action">
        <ScheduleVisitConfig defaultDurationMin={9999} />
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
