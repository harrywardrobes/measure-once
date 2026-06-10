import React, { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';

import { StartDesignVisitConfig } from './HandlerConfigBlocks';
import {
  ModalChrome,
  FIXTURE_LEAD_STATUSES
} from './_HandlerConfigBlockStoryHelpers';

const meta: Meta<typeof StartDesignVisitConfig> = {
  title: 'Features/ActionHandlerConfigBlocks/StartDesignVisit',
  component: StartDesignVisitConfig,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Config block for the **Start design visit wizard** handler type. ' +
          'Exposes a default duration field, two lead-status selectors ' +
          '(in-progress status set when the wizard opens; submitted status set on submit), ' +
          'and optional Terms & Conditions text (≤4000 chars). ' +
          'The two-phase status callout in the block explains the open → submit flow.'
      }
    }
  }
};
export default meta;

type Story = StoryObj<typeof StartDesignVisitConfig>;

function Wrapper({
  prefilledIntermediate = '',
  prefilledSubmitted = ''
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
      />
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
          'Handler editor with "Start design visit wizard" pre-selected and an ' +
          'empty config (no lead statuses chosen). Lead status options are populated ' +
          'from fixture data. The two-phase status callout is always visible.'
      }
    }
  }
};

export const Prefilled: Story = {
  name: 'Pre-filled (statuses selected)',
  render: () => (
    <Wrapper
      prefilledIntermediate="design_in_prog"
      prefilledSubmitted="design_in_prog__submitted"
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          'Same block with saved lead status selections pre-populated: ' +
          '"Design in progress" as the in-progress status and the "Submitted" sub-status ' +
          'as the submitted status. Mirrors the "Change action" flow.'
      }
    }
  }
};

export const DurationValidationError: Story = {
  name: 'Duration validation error',
  render: () => {
    const [type, setType] = useState('start_design_visit');
    return (
      <ModalChrome selectedType={type} onTypeChange={setType} slotLabel="Design visit · Default action">
        <StartDesignVisitConfig
          defaultDurationMin={9999}
          leadStatuses={FIXTURE_LEAD_STATUSES}
        />
      </ModalChrome>
    );
  },
  parameters: {
    docs: {
      description: {
        story:
          'Shows the inline error state when the duration field is outside 5–1440 min. ' +
          'The field turns red and displays "Must be between 5 and 1440 minutes."'
      }
    }
  }
};

export const WithTermsAndConditions: Story = {
  name: 'With Terms & Conditions',
  render: () => {
    const [type, setType] = useState('start_design_visit');
    return (
      <ModalChrome selectedType={type} onTypeChange={setType} slotLabel="Design visit · Default action">
        <StartDesignVisitConfig
          intermediateLeadStatus="design_in_prog"
          submittedLeadStatus="design_in_prog__submitted"
          termsAndConditions={
            'By signing below you agree to the following terms:\n\n' +
            '1. The design visit is a no-obligation consultation.\n' +
            '2. A quotation will be provided within 5 working days.\n' +
            '3. All measurements are approximate until a site survey is completed.'
          }
          leadStatuses={FIXTURE_LEAD_STATUSES}
        />
      </ModalChrome>
    );
  },
  parameters: {
    docs: {
      description: {
        story:
          'Block with optional Terms & Conditions text pre-populated. The T&C text is ' +
          'shown to the customer on the sign-off page after the design visit is submitted.'
      }
    }
  }
};
