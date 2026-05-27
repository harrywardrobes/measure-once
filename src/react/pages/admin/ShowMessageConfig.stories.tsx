import React, { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';

import { ShowMessageConfig } from './HandlerConfigBlocks';
import { ModalChrome } from './_HandlerConfigBlockStoryHelpers';

const meta: Meta<typeof ShowMessageConfig> = {
  title: 'Features/ActionHandlerConfigBlocks/ShowMessage',
  component: ShowMessageConfig,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Config block for the **Show message** handler type. ' +
          'Exposes an optional popup title (≤120 chars) and a required message body ' +
          '(≤2000 chars, plain text). ' +
          'No API call is made when the action is clicked — the message is shown verbatim ' +
          'in a popup and nothing else happens.',
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof ShowMessageConfig>;

function Wrapper({
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

export const Blank: Story = {
  name: 'Blank',
  render: () => <Wrapper />,
  parameters: {
    docs: {
      description: {
        story:
          'Handler editor with "Show informational message" pre-selected and an empty config. ' +
          'The title is optional; the message body is required and shows a validation error ' +
          'on blur if left empty.',
      },
    },
  },
};

export const Prefilled: Story = {
  name: 'Pre-filled',
  render: () => (
    <Wrapper
      prefilledTitle="Next step"
      prefilledMessage="Send the quote PDF from the shared drive and tick the next step manually."
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          'Same block with a saved title and message pre-populated — mirrors the ' +
          '"Change action" flow where an existing config is loaded into the editor.',
      },
    },
  },
};

export const MessageValidationError: Story = {
  name: 'Message validation error',
  render: () => {
    const [type, setType] = useState('show_message');
    return (
      <ModalChrome selectedType={type} onTypeChange={setType} slotLabel="Quote sent · Default action">
        <ShowMessageConfig defaultTitle="Next step" defaultMessage="" />
      </ModalChrome>
    );
  },
  parameters: {
    docs: {
      description: {
        story:
          'Illustrates the required-field error on the message body. Click into the ' +
          'message textarea and tab away without typing to trigger "Message is required."',
      },
    },
  },
};
