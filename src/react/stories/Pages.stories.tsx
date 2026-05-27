import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { AccessRestrictedPage } from '../pages/AccessRestrictedPage';
import { AccessRequestGate } from '../components/AccessRequestGate';
import { NotFoundPage } from '../pages/NotFoundPage';

const meta: Meta = {
  title: 'Pages/Error & Access Pages',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Standalone pages for error, restriction, and access-request flows. Use `embedded` to suppress the full-viewport layout inside a container.',
      },
    },
  },
};
export default meta;

type Story = StoryObj;

export const NotFound: Story = {
  name: 'NotFoundPage (404)',
  render: () => <NotFoundPage />,
};

export const NotFoundEmbedded: Story = {
  name: 'NotFoundPage — embedded',
  render: () => <NotFoundPage embedded />,
  parameters: { layout: 'padded' },
};

export const AccessRestricted: Story = {
  name: 'AccessRestrictedPage',
  render: () => <AccessRestrictedPage />,
};

export const AccessRestrictedEmbedded: Story = {
  name: 'AccessRestrictedPage — embedded',
  render: () => <AccessRestrictedPage embedded />,
  parameters: { layout: 'padded' },
};

export const AccessRequestForm: Story = {
  name: 'AccessRequestGate — form view (inline)',
  render: () => (
    <AccessRequestGate
      forceNoTurnstile
      open
      onClose={() => {}}
      initialView="form"
    />
  ),
  parameters: { layout: 'centered' },
};
