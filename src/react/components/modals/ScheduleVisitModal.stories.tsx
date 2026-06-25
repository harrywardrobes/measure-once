import React, { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ScheduleVisitModal } from './ScheduleVisitModal';
import { useConnectionToast } from '../../contexts/ConnectionToastContext';

const ctx = {
  contactId: '12345',
  contactName: 'Jane Smith',
  contactEmail: 'jane@example.com',
};

const meta: Meta<typeof ScheduleVisitModal> = {
  title: 'Modals/ScheduleVisitModal',
  component: ScheduleVisitModal,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  args: {
    ctx,
    open: true,
    onClose: () => {},
    demo: true,
  },
};
export default meta;

type Story = StoryObj<typeof ScheduleVisitModal>;

export const LockedTypeDesign: Story = {
  name: 'Locked visit type — design',
  args: {
    visitType:      'design',
    contactAddress: '14 Oak Street, London, SW1A 1AA',
    handler:        { id: 1, type: 'schedule_visit', config: { visitType: 'design', defaultDurationMin: 90 }, bindings: [] },
  },
};

export const LockedTypeSurvey: Story = {
  name: 'Locked visit type — survey',
  args: {
    visitType:      'survey',
    contactAddress: '22 Elm Avenue, Manchester, M1 2AB',
    handler:        { id: 2, type: 'schedule_visit', config: { visitType: 'survey' }, bindings: [] },
  },
};

export const LockedTypeOther: Story = {
  name: 'Locked visit type — other',
  args: {
    visitType: 'other',
    handler:   { id: 3, type: 'schedule_visit', config: { visitType: 'other' }, bindings: [] },
  },
};

export const FreeTypeSelector: Story = {
  name: 'Free visit-type selector (direct booking, no handler)',
  args: {
    contactAddress: '7 Birch Road, Bristol, BS1 3CD',
  },
};

export const WithEmailToggleExpanded: Story = {
  name: 'Email confirmation toggle (fetch mocked)',
  args: {
    visitType:      'design',
    contactAddress: '14 Oak Street, London, SW1A 1AA',
    handler:        { id: 1, type: 'schedule_visit', config: { visitType: 'design' }, bindings: [] },
  },
  decorators: [
    (Story) => {
      if (typeof window !== 'undefined') {
        const origFetch = window.fetch;
        window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : (input as Request).url;
          if (url.includes('email-templates/render')) {
            return new Response(JSON.stringify({
              subject: 'Your design visit is confirmed — Jane Smith',
              body_text: 'Hi Jane,\n\nWe\'ve booked your design visit.\n\nSee you then!',
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          return origFetch(input, init);
        };
      }
      return <Story />;
    },
  ],
};

function GoogleDisconnectedDecorator({ children }: { children: React.ReactNode }) {
  const { notifyDisconnected } = useConnectionToast();
  useEffect(() => {
    notifyDisconnected('google');
  }, [notifyDisconnected]);
  return <>{children}</>;
}

export const GoogleDisconnected: Story = {
  name: 'Google Calendar disconnected — inline warning',
  args: {
    demo: false,
    visitType:      'design',
    contactAddress: '14 Oak Street, London, SW1A 1AA',
    handler:        { id: 1, type: 'schedule_visit', config: { visitType: 'design', defaultDurationMin: 90 }, bindings: [] },
  },
  decorators: [
    (Story) => (
      <GoogleDisconnectedDecorator>
        <Story />
      </GoogleDisconnectedDecorator>
    ),
  ],
};
