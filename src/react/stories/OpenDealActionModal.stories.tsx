import type { Meta, StoryObj } from '@storybook/react';
import { OpenDealActionModal } from '../components/modals/OpenDealActionModal';

const handler = { id: 7, type: 'open_deal' as const, config: {}, bindings: [] };

const ctx = {
  contactId: '99001',
  contactName: 'Jane Smith',
  contactEmail: 'jane@example.com',
  stageKey: 'sales',
  statusKey: 'OPEN_DEAL',
};

const contactPayload = {
  contactName:    'Jane Smith',
  contactEmail:   'jane@example.com',
  contactPhone:   '020 7946 0000',
  contactMobile:  '07700 900123',
  contactAddress: '14 Oak Street, London, SW1A 1AA',
  depositPercent: 10,
  qbConnected:    true,
  estimates: [
    {
      id: 'est-001',
      docNumber: '1042',
      txnDate:   '2026-05-15',
      totalAmt:  12500,
      txnStatus: 'Pending',
      billEmail: 'jane@example.com',
      customerRef: 'Jane Smith',
    },
    {
      id: 'est-002',
      docNumber: '1039',
      txnDate:   '2026-04-01',
      totalAmt:  9800,
      txnStatus: 'Rejected',
      billEmail: 'jane@example.com',
      customerRef: 'Jane Smith',
    },
  ],
};

const contactNoQb = { ...contactPayload, qbConnected: false };

const declineEmailRenderResponse = {
  subject: 'Thank you',
  body_text: 'Hi Jane,\n\nThank you for your time — please feel free to get in touch if you have any questions regarding wardrobes.\n\nWarm regards,\nThe team',
  html: '<p>Hi Jane,</p>\n<p>Thank you for your time — please feel free to get in touch if you have any questions regarding wardrobes.</p>\n<p style="color:#555">Warm regards,<br>The team</p>',
};

const depositEmailPreviewResponse = {
  subject: 'Your deposit invoice',
  html: '<p>Hi Jane,</p>\n<p>I\'ve sent over the <strong>10% deposit invoice</strong> — please let me know if you haven\'t received it.</p>\n<p>Once received, we can then book in a survey visit to confirm the final measurements and design choices.</p>\n<p style="color:#555">Warm regards,<br>The team</p>',
  text: "Hi Jane,\n\nI've sent over the 10% deposit invoice — please let me know if you haven't received it.",
};

function mockFetch(overrides: { contact?: object } = {}) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('open-deal/deposit-invoice-email-preview')) {
      return new Response(JSON.stringify(depositEmailPreviewResponse), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('open-deal')) {
      return new Response(JSON.stringify(overrides.contact ?? contactPayload), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('email-templates/render')) {
      return new Response(JSON.stringify(declineEmailRenderResponse), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
}

const DRAFT_KEY = `mo-open-deal-draft-${ctx.contactId}`;

function clearDraft() {
  try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
}

function setDraftStep(step: string) {
  try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ step })); } catch { /* ignore */ }
}

const meta: Meta<typeof OpenDealActionModal> = {
  title: 'Modals/OpenDealActionModal',
  component: OpenDealActionModal,
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

type Story = StoryObj<typeof OpenDealActionModal>;

export const Hub: Story = {
  name: 'Hub — QB connected',
  decorators: [
    (Story) => {
      if (typeof window !== 'undefined') {
        clearDraft();
        const origFetch = window.fetch;
        window.fetch = mockFetch();
        return <Story cleanup={() => { window.fetch = origFetch; }} />;
      }
      return <Story />;
    },
  ],
};

export const HubNoQuickBooks: Story = {
  name: 'Hub — QB not connected',
  decorators: [
    (Story) => {
      if (typeof window !== 'undefined') {
        clearDraft();
        const origFetch = window.fetch;
        window.fetch = mockFetch({ contact: contactNoQb });
        return <Story cleanup={() => { window.fetch = origFetch; }} />;
      }
      return <Story />;
    },
  ],
};

export const AcceptPickEstimate: Story = {
  name: 'Accept deal — Step 1 (pick estimate)',
  decorators: [
    (Story) => {
      if (typeof window !== 'undefined') {
        setDraftStep('accept_pick');
        const origFetch = window.fetch;
        window.fetch = mockFetch();
        return <Story cleanup={() => {
          window.fetch = origFetch;
          clearDraft();
        }} />;
      }
      return <Story />;
    },
  ],
};

export const AcceptConfirm: Story = {
  name: 'Accept deal — Step 2 (confirm → sends open_deal_deposit_invoice_sent email)',
  decorators: [
    (Story) => {
      if (typeof window !== 'undefined') {
        sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
          step: 'accept_confirm',
          selectedEstimateId: 'est-001',
          otherEstimateIdsToDecline: [],
        }));
        const origFetch = window.fetch;
        window.fetch = mockFetch();
        return <Story cleanup={() => {
          window.fetch = origFetch;
          clearDraft();
        }} />;
      }
      return <Story />;
    },
  ],
};

export const DeclineConfirm: Story = {
  name: 'Decline deal — Step 1 (confirm)',
  decorators: [
    (Story) => {
      if (typeof window !== 'undefined') {
        setDraftStep('decline_confirm');
        const origFetch = window.fetch;
        window.fetch = mockFetch();
        return <Story cleanup={() => {
          window.fetch = origFetch;
          clearDraft();
        }} />;
      }
      return <Story />;
    },
  ],
};

export const DeclineEmail: Story = {
  name: 'Decline deal — Step 2 (send open_deal_declined_thank_you email?)',
  decorators: [
    (Story) => {
      if (typeof window !== 'undefined') {
        setDraftStep('decline_email');
        const origFetch = window.fetch;
        window.fetch = mockFetch();
        return <Story cleanup={() => {
          window.fetch = origFetch;
          clearDraft();
        }} />;
      }
      return <Story />;
    },
  ],
};

export const DealAcceptedDone: Story = {
  name: 'Done — deposit invoice sent',
  decorators: [
    (Story) => {
      if (typeof window !== 'undefined') {
        sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
          step: 'done',
          selectedEstimateId: 'est-001',
        }));
        const origFetch = window.fetch;
        window.fetch = mockFetch();
        return <Story cleanup={() => {
          window.fetch = origFetch;
          clearDraft();
        }} />;
      }
      return <Story />;
    },
  ],
};
