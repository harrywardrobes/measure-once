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
          bookedSlotIso: null,
          emailSubject: '',
          emailBody: '',
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
          bookedSlotIso: null,
          emailSubject: '',
          emailBody: '',
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
          bookedSlotIso: null,
          emailSubject: '',
          emailBody: '',
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
          bookedSlotIso: null,
          emailSubject: '',
          emailBody: '',
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
        bookedSlotIso: null,
        emailSubject: '',
        emailBody: '',
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
        bookedSlotIso: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        emailSubject: '',
        emailBody: '',
      }));
    }
    return <ArrangeVisitModal {...args} />;
  },
};

export const EmailStep: Story = {
  name: 'Email — ask for availability',
  render: (args) => {
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('mo-arrange-visit-draft-12345', JSON.stringify({
        step: 'email',
        address: '14 Oak Street, London, SW1A 1AA',
        bookedSlotIso: null,
        emailSubject: 'Booking your design visit — getting in touch',
        emailBody:
          'Hi Jane,\n\n' +
          'Thanks for your interest in booking a design visit with us. I tried to give you a call but wasn\'t able to reach you.\n\n' +
          'Could you let us know your availability over the next week? If you can share which days and evenings work best for you, we can either call you back at a convenient time or lock in a date for your design visit.\n\n' +
          'Just reply to this email and we\'ll get it arranged.\n\n' +
          'Best regards',
      }));
    }
    return <ArrangeVisitModal {...args} />;
  },
};

export const SendingState: Story = {
  name: 'Email step — sending',
  render: (args) => {
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('mo-arrange-visit-draft-12345', JSON.stringify({
        step: 'email',
        address: '14 Oak Street, London, SW1A 1AA',
        bookedSlotIso: null,
        emailSubject: 'Booking your design visit — getting in touch',
        emailBody:
          'Hi Jane,\n\n' +
          'Thanks for your interest in booking a design visit with us. I tried to give you a call but wasn\'t able to reach you.\n\n' +
          'Could you let us know your availability over the next week? If you can share which days and evenings work best for you, we can either call you back at a convenient time or lock in a date for your design visit.\n\n' +
          'Just reply to this email and we\'ll get it arranged.\n\n' +
          'Best regards',
      }));
    }
    return <ArrangeVisitModal {...args} />;
  },
};
