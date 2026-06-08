import type { Meta, StoryObj } from '@storybook/react';
import { ArrangeVisitModal } from '../components/modals/ArrangeVisitModal';

const meta: Meta<typeof ArrangeVisitModal> = {
  title: 'Modals/ArrangeVisitModal',
  component: ArrangeVisitModal,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  args: {
    handler: { id: 1, type: 'arrange_visit', config: {}, bindings: [] },
    ctx: {
      contactId: '12345',
      contactName: 'Jane Smith',
      contactEmail: 'jane@example.com',
    },
    open: true,
    onClose: () => {},
  },
};
export default meta;

type Story = StoryObj<typeof ArrangeVisitModal>;

export const CallStepDesign: Story = {
  name: 'Call step — draft restored, landline only',
  decorators: [
    (Story) => {
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('mo-arrange-visit-draft-12345', JSON.stringify({
          step: 'call',
          address: '14 Oak Street, London, SW1A 1AA',
          slotIso: [null, null, null],
          bookedSlotIso: null,
        }));
        const origFetch = window.fetch;
        window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
          if (url.includes('arrange-visit') && !url.includes('outcome')) {
            return new Response(JSON.stringify({
              visitType: 'design',
              contactName: 'Jane Smith',
              contactPhone: '07700 900123',
              contactMobilePhone: '',
              contactEmail: 'jane@example.com',
              contactAddress: '14 Oak Street, London, SW1A 1AA',
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          return origFetch(input, init);
        };
      }
      return <Story />;
    },
  ],
};

export const MobileOnly: Story = {
  name: 'Call step — draft restored, mobile only',
  decorators: [
    (Story) => {
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('mo-arrange-visit-draft-12345', JSON.stringify({
          step: 'call',
          address: '14 Oak Street, London, SW1A 1AA',
          slotIso: [null, null, null],
          bookedSlotIso: null,
        }));
        const origFetch = window.fetch;
        window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
          if (url.includes('arrange-visit') && !url.includes('outcome')) {
            return new Response(JSON.stringify({
              visitType: 'design',
              contactName: 'Jane Smith',
              contactPhone: '',
              contactMobilePhone: '07911 123456',
              contactEmail: 'jane@example.com',
              contactAddress: '14 Oak Street, London, SW1A 1AA',
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          return origFetch(input, init);
        };
      }
      return <Story />;
    },
  ],
};

export const BothNumbers: Story = {
  name: 'Call step — draft restored, landline and mobile',
  decorators: [
    (Story) => {
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('mo-arrange-visit-draft-12345', JSON.stringify({
          step: 'call',
          address: '14 Oak Street, London, SW1A 1AA',
          slotIso: [null, null, null],
          bookedSlotIso: null,
        }));
        const origFetch = window.fetch;
        window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
          if (url.includes('arrange-visit') && !url.includes('outcome')) {
            return new Response(JSON.stringify({
              visitType: 'design',
              contactName: 'Jane Smith',
              contactPhone: '020 7946 0958',
              contactMobilePhone: '07911 123456',
              contactEmail: 'jane@example.com',
              contactAddress: '14 Oak Street, London, SW1A 1AA',
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          return origFetch(input, init);
        };
      }
      return <Story />;
    },
  ],
};

export const CallStepSurvey: Story = {
  name: 'Call step — survey visit',
  decorators: [
    (Story) => {
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('mo-arrange-visit-draft-12345', JSON.stringify({
          step: 'call',
          address: '14 Oak Street, London, SW1A 1AA',
          slotIso: [null, null, null],
          bookedSlotIso: null,
        }));
      }
      return <Story />;
    },
  ],
  args: {
    ctx: {
      contactId: '12345',
      contactName: 'James Brown',
      contactEmail: 'james@example.com',
    },
  },
  render: (args) => {
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('mo-arrange-visit-draft-12345', JSON.stringify({
        step: 'call',
        address: '8 Maple Avenue, Manchester, M1 4LN',
        slotIso: [null, null, null],
        bookedSlotIso: null,
      }));
    }
    return <ArrangeVisitModal {...args} />;
  },
};

export const BookedSubstep: Story = {
  name: 'Booked sub-step',
  render: (args) => {
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('mo-arrange-visit-draft-12345', JSON.stringify({
        step: 'booked',
        address: '14 Oak Street, London, SW1A 1AA',
        slotIso: [null, null, null],
        bookedSlotIso: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      }));
    }
    return <ArrangeVisitModal {...args} />;
  },
};

export const EmailSlotsStep: Story = {
  name: 'Email slots step',
  render: (args) => {
    const futureBase = Date.now() + 3 * 24 * 60 * 60 * 1000;
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('mo-arrange-visit-draft-12345', JSON.stringify({
        step: 'email',
        address: '14 Oak Street, London, SW1A 1AA',
        slotIso: [
          new Date(futureBase).toISOString(),
          new Date(futureBase + 2 * 24 * 60 * 60 * 1000).toISOString(),
          null,
        ],
        bookedSlotIso: null,
      }));
    }
    return <ArrangeVisitModal {...args} />;
  },
};

export const SendingState: Story = {
  name: 'Email step — sending',
  render: (args) => {
    const futureBase = Date.now() + 3 * 24 * 60 * 60 * 1000;
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('mo-arrange-visit-draft-12345', JSON.stringify({
        step: 'email',
        address: '14 Oak Street, London, SW1A 1AA',
        slotIso: [
          new Date(futureBase).toISOString(),
          null,
          null,
        ],
        bookedSlotIso: null,
      }));
    }
    return <ArrangeVisitModal {...args} />;
  },
};
