import React, { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';

import { DeliveryWindowConfig } from './HandlerConfigBlocks';
import { ModalChrome } from './_HandlerConfigBlockStoryHelpers';

const meta: Meta<typeof DeliveryWindowConfig> = {
  title: 'Features/ActionHandlerConfigBlocks/DeliveryWindow',
  component: DeliveryWindowConfig,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Config block for the **Schedule delivery window** handler type. ' +
          'Exposes an optional default title (≤120 chars). ' +
          'When the action is clicked on a card, a modal opens for the operator to pick ' +
          'a start and end date/time for the delivery window.',
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof DeliveryWindowConfig>;

function Wrapper({ prefilledTitle = '' }: { prefilledTitle?: string }) {
  const [type, setType] = useState('schedule_delivery_window');
  return (
    <ModalChrome selectedType={type} onTypeChange={setType} slotLabel="Delivery ready · Default action">
      <DeliveryWindowConfig defaultTitle={prefilledTitle} />
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
          'Handler editor with "Schedule delivery window" pre-selected and an empty config. ' +
          'The title field is optional.',
      },
    },
  },
};

export const Prefilled: Story = {
  name: 'Pre-filled (default title)',
  render: () => <Wrapper prefilledTitle="Delivery window" />,
  parameters: {
    docs: {
      description: {
        story:
          'Same block with an existing defaultTitle value loaded — mirrors the ' +
          '"Change action" flow where the editor opens with the saved config pre-populated.',
      },
    },
  },
};
