import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { TaskModal } from './TaskModal';

const meta: Meta<typeof TaskModal> = {
  title: 'Modals/TaskModal',
  component: TaskModal,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  args: {
    open: true,
    onClose: () => {},
    contactId: '12345',
    contactName: 'Jane Smith',
    contactEmail: 'jane@example.com',
    demo: true,
  },
};
export default meta;

type Story = StoryObj<typeof TaskModal>;

export const Default: Story = {
  name: 'Default (demo mode)',
};

export const WithMockedUsers: Story = {
  name: 'With mocked users list',
  args: { demo: false },
  decorators: [
    (Story) => {
      if (typeof window !== 'undefined') {
        const origFetch = window.fetch;
        window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : (input as Request).url;
          if (url.includes('/api/users')) {
            return new Response(
              JSON.stringify([
                { id: '1', name: 'Harry James', email: 'harry@example.com' },
                { id: '2', name: 'Alice Brown', email: 'alice@example.com' },
                { id: '3', name: 'Bob Smith',   email: 'bob@example.com' },
              ]),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          return origFetch(input, init);
        };
      }
      return <Story />;
    },
  ],
};

export const GoogleDisconnected: Story = {
  name: 'Google Calendar disconnected warning',
  args: { demo: false },
  decorators: [
    (Story) => {
      if (typeof window !== 'undefined') {
        const origFetch = window.fetch;
        window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : (input as Request).url;
          if (url.includes('/api/users')) {
            return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          return origFetch(input, init);
        };
      }
      return <Story />;
    },
  ],
};
