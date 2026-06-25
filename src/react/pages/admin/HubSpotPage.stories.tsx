import type { Meta, StoryObj } from '@storybook/react';
import { HubSpotPage } from './HubSpotPage';

const meta: Meta<typeof HubSpotPage> = {
  title: 'Admin/HubSpotPage',
  tags: ['autodocs'],
  component: HubSpotPage,
  parameters: { layout: 'padded' },
};
export default meta;

type Story = StoryObj<typeof HubSpotPage>;

export const Default: Story = {
  name: 'Default (loading)',
};

export const Connected: Story = {
  name: 'Connected (mocked)',
  parameters: {
    mockData: [
      {
        url: '/api/admin/hubspot-status',
        method: 'GET',
        status: 200,
        response: {
          connected: true,
          portalId: '12345678',
          contactsCount: 142,
          lastSyncedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        },
      },
      {
        url: '/api/admin/webhooks/status',
        method: 'GET',
        status: 200,
        response: {
          subscriptions: [
            { eventType: 'contact.creation', active: true },
            { eventType: 'contact.propertyChange', active: true },
          ],
        },
      },
    ],
  },
};

export const Disconnected: Story = {
  name: 'Disconnected (mocked)',
  parameters: {
    mockData: [
      {
        url: '/api/admin/hubspot-status',
        method: 'GET',
        status: 200,
        response: { connected: false },
      },
      {
        url: '/api/admin/webhooks/status',
        method: 'GET',
        status: 200,
        response: { subscriptions: [] },
      },
    ],
  },
};
