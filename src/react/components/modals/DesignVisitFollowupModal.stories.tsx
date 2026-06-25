import React, { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { DesignVisitFollowupModal } from '../components/modals/DesignVisitFollowupModal';

const handler = { id: 5, type: 'design_visit_followup', config: {}, bindings: [] };

const ctx = {
  contactId: '12345',
  contactName: 'Jane Smith',
  contactEmail: 'jane@example.com',
  stageKey: 'designvisit',
  statusKey: 'DESIGN_INVITED',
};

const contactPayload = {
  contactName:    'Jane Smith',
  contactEmail:   'jane@example.com',
  phone:          '07700 900123',
  mobile:         '',
  leadStatus:     'DESIGN_INVITED',
  contactAddress: '14 Oak Street, London, SW1A 1AA',
};

function mockFetch(overrides: Record<string, object> = {}) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('design-visit-followup') && !url.includes('outcome')) {
      return new Response(JSON.stringify(overrides.contact ?? contactPayload), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('email-templates/render')) {
      return new Response(JSON.stringify(overrides.email ?? {
        subject: 'Your design visit invitation — Jane Smith',
        body:    'Hi Jane,\n\nWe\'d love to invite you to a design visit at your home.\n\nPlease let us know a convenient time.\n\nThanks,\nMeasure Once',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('design-visit-followup/outcome')) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

const meta: Meta<typeof DesignVisitFollowupModal> = {
  title: 'Modals/DesignVisitFollowupModal',
  component: DesignVisitFollowupModal,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  args: {
    handler,
    ctx,
    open: true,
    onClose: () => {},
  },
};
export default meta;

type Story = StoryObj<typeof DesignVisitFollowupModal>;

export const HubStep: Story = {
  name: 'Hub step — contact loaded',
  decorators: [
    (Story) => {
      if (typeof window !== 'undefined') {
        sessionStorage.removeItem(`mo-dvf-draft-12345`);
        const origFetch = window.fetch;
        window.fetch = mockFetch();
        return <Story cleanup={() => { window.fetch = origFetch; }} />;
      }
      return <Story />;
    },
  ],
};

export const ResendStep: Story = {
  name: 'Resend invite step',
  decorators: [
    (Story) => {
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('mo-dvf-draft-12345', 'resend');
        const origFetch = window.fetch;
        window.fetch = mockFetch();
        return <Story cleanup={() => {
          window.fetch = origFetch;
          sessionStorage.removeItem('mo-dvf-draft-12345');
        }} />;
      }
      return <Story />;
    },
  ],
};

export const ScheduleStep: Story = {
  name: 'Schedule step (customer confirmed)',
  decorators: [
    (Story) => {
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('mo-dvf-draft-12345', 'schedule');
        const origFetch = window.fetch;
        window.fetch = mockFetch();
        return <Story cleanup={() => {
          window.fetch = origFetch;
          sessionStorage.removeItem('mo-dvf-draft-12345');
        }} />;
      }
      return <Story />;
    },
  ],
};

export const DemoPreview: Story = {
  name: 'Demo preview (hub)',
  args: { demo: true },
};

function DemoResendWrapper(props: React.ComponentProps<typeof DesignVisitFollowupModal>) {
  useEffect(() => {
    const t = setTimeout(() => {
      const btn = document.querySelector<HTMLButtonElement>('[data-testid="dvf-resend"]');
      btn?.click();
    }, 50);
    return () => clearTimeout(t);
  }, []);
  return <DesignVisitFollowupModal {...props} />;
}

export const DemoResendStep: Story = {
  name: 'Demo preview (resend step)',
  args: { demo: true },
  render: (args) => <DemoResendWrapper {...args} />,
};

function DemoScheduleWrapper(props: React.ComponentProps<typeof DesignVisitFollowupModal>) {
  useEffect(() => {
    const t = setTimeout(() => {
      const btn = document.querySelector<HTMLButtonElement>('[data-testid="dvf-confirmed"]');
      btn?.click();
    }, 50);
    return () => clearTimeout(t);
  }, []);
  return <DesignVisitFollowupModal {...props} />;
}

export const DemoScheduleStep: Story = {
  name: 'Demo preview (schedule step)',
  args: { demo: true },
  render: (args) => <DemoScheduleWrapper {...args} />,
};
