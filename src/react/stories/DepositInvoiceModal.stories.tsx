import type { Meta, StoryObj } from '@storybook/react';
import { DepositInvoiceModal } from '../components/modals/DepositInvoiceModal';

const handler = { id: 9, type: 'deposit_invoice_followup' as const, config: {}, bindings: [] };

const ctx = {
  contactId: '55001',
  contactName: 'Alice Johnson',
  contactEmail: 'alice@example.com',
  stageKey: 'depositinvoice',
  statusKey: 'DEPOSIT_INVOICE_SENT',
};

const contactPayload = {
  contactName:      'Alice Johnson',
  contactEmail:     'alice@example.com',
  contactPhone:     '020 7946 0001',
  contactMobile:    '07700 900456',
  contactAddress:   '22 Maple Avenue, London, SE1 7PB',
  qbConnected:      true,
  invoiceId:        'inv-501',
  invoiceDocNum:    '2041',
  invoiceTotalAmt:  1250,
  invoiceBalance:   1250,
  invoiceTxnDate:   '2026-05-01',
  invoiceLink:      'https://app.qbo.intuit.com/app/invoice?txnId=inv-501',
  qbEstimateId:     'est-901',
};

const paymentsUnpaid = {
  qbConnected: true,
  payments: [],
  invoices: [
    {
      invoiceId:        'inv-501',
      invoiceDocNumber: '2041',
      invoiceLabel:     'Invoice #2041',
      invoiceTotalAmt:  1250,
      invoiceBalance:   1250,
      invoicePaidAmt:   0,
      status:           'unpaid' as const,
    },
  ],
  summary: { totalInvoiced: 1250, totalPaid: 0, totalOutstanding: 1250 },
};

const paymentsPaid = {
  qbConnected: true,
  payments: [
    {
      id:               'pmt-001',
      reference:        'BACS transfer',
      txnDate:          '2026-05-20',
      totalAmt:         1250,
      unappliedAmt:     0,
      paymentMethodName:'BACS',
      linkedInvoiceIds: ['inv-501'],
    },
  ],
  invoices: [
    {
      invoiceId:        'inv-501',
      invoiceDocNumber: '2041',
      invoiceLabel:     'Invoice #2041',
      invoiceTotalAmt:  1250,
      invoiceBalance:   0,
      invoicePaidAmt:   1250,
      status:           'paid' as const,
    },
  ],
  summary: { totalInvoiced: 1250, totalPaid: 1250, totalOutstanding: 0 },
};

const reminderTemplateResponse = {
  subject:   'Payment reminder — deposit invoice #2041',
  body_text: 'Hi Alice,\n\nJust a gentle reminder that your deposit invoice #2041 for £1,250.00 is still outstanding.\n\nYou can pay via: https://app.qbo.intuit.com/app/invoice?txnId=inv-501\n\nPlease let us know if you have any questions.\n\nThanks,\nMeasure Once',
};

const declineTemplateResponse = {
  subject:   'Thank you',
  body_text: 'Hi Alice,\n\nThank you for your time. Please feel free to get in touch if you need anything in the future.\n\nWarm regards,\nMeasure Once',
};

const DRAFT_KEY = `mo-deposit-invoice-draft-${ctx.contactId}`;

function clearDraft() {
  try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
}

function setDraftStep(step: string) {
  try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ step })); } catch { /* ignore */ }
}

function mockFetch(overrides: { contact?: object; payments?: object } = {}) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url    = typeof input === 'string' ? input : (input as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();

    if (method === 'GET' && url.includes('/api/quickbooks/contacts/') && url.includes('/payments')) {
      return new Response(JSON.stringify(overrides.payments ?? paymentsUnpaid), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (method === 'POST' && url.includes('card-actions/deposit-invoice/resend')) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (method === 'POST' && url.includes('card-actions/deposit-invoice/not-proceeding')) {
      return new Response(JSON.stringify({ ok: true, hs_lead_status: 'DECLINED_DEAL' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (method === 'POST' && url.includes('card-actions/deposit-invoice')) {
      return new Response(JSON.stringify(overrides.contact ?? contactPayload), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (method === 'POST' && url.includes('email-templates/render')) {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(init?.body as string ?? '{}') as Record<string, unknown>; } catch { /* ignore */ }
      if ((body.key as string)?.includes('payment_reminder')) {
        return new Response(JSON.stringify(reminderTemplateResponse), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(declineTemplateResponse), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (method === 'POST' && url.includes('emails/send')) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
}

const meta: Meta<typeof DepositInvoiceModal> = {
  title: 'Modals/DepositInvoiceModal',
  component: DepositInvoiceModal,
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

type Story = StoryObj<typeof DepositInvoiceModal>;

export const Hub: Story = {
  name: 'Hub — QB connected, invoice unpaid',
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

export const HubAlreadyPaid: Story = {
  name: 'Hub — invoice already paid (send buttons suppressed)',
  decorators: [
    (Story) => {
      if (typeof window !== 'undefined') {
        clearDraft();
        const origFetch = window.fetch;
        window.fetch = mockFetch({ payments: paymentsPaid });
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
        window.fetch = mockFetch({
          contact: { ...contactPayload, qbConnected: false, invoiceId: null },
          payments: { qbConnected: false },
        });
        return <Story cleanup={() => { window.fetch = origFetch; }} />;
      }
      return <Story />;
    },
  ],
};

export const ResendStep: Story = {
  name: 'Re-send invoice step',
  decorators: [
    (Story) => {
      if (typeof window !== 'undefined') {
        setDraftStep('resend');
        const origFetch = window.fetch;
        window.fetch = mockFetch();
        return <Story cleanup={() => { window.fetch = origFetch; clearDraft(); }} />;
      }
      return <Story />;
    },
  ],
};

export const ReminderStep: Story = {
  name: 'Send payment reminder step',
  decorators: [
    (Story) => {
      if (typeof window !== 'undefined') {
        setDraftStep('reminder');
        const origFetch = window.fetch;
        window.fetch = mockFetch();
        return <Story cleanup={() => { window.fetch = origFetch; clearDraft(); }} />;
      }
      return <Story />;
    },
  ],
};

export const ResendStepPaid: Story = {
  name: 'Re-send invoice step — invoice already paid',
  decorators: [
    (Story) => {
      if (typeof window !== 'undefined') {
        setDraftStep('resend');
        const origFetch = window.fetch;
        window.fetch = mockFetch({ payments: paymentsPaid });
        return <Story cleanup={() => { window.fetch = origFetch; clearDraft(); }} />;
      }
      return <Story />;
    },
  ],
};

export const ResendStepPaidOverride: Story = {
  name: 'Re-send invoice step — paid, "Send anyway" override acknowledged',
  parameters: {
    docs: {
      description: {
        story:
          'Staff clicked "Send anyway" after seeing the paid-invoice warning. The alert message updates to confirm the acknowledgement and the Re-send Invoice button becomes enabled.',
      },
    },
  },
  decorators: [
    (Story) => {
      if (typeof window !== 'undefined') {
        setDraftStep('resend');
        const origFetch = window.fetch;
        window.fetch = mockFetch({ payments: paymentsPaid });
        return <Story cleanup={() => { window.fetch = origFetch; clearDraft(); }} />;
      }
      return <Story />;
    },
  ],
  play: async ({ canvasElement }) => {
    const { within, userEvent } = await import('@storybook/test');
    const canvas = within(canvasElement);
    const sendAnywayBtn = await canvas.findByRole('button', { name: /send anyway/i });
    await userEvent.click(sendAnywayBtn);
  },
};

export const ReminderStepPaid: Story = {
  name: 'Send payment reminder step — invoice already paid',
  decorators: [
    (Story) => {
      if (typeof window !== 'undefined') {
        setDraftStep('reminder');
        const origFetch = window.fetch;
        window.fetch = mockFetch({ payments: paymentsPaid });
        return <Story cleanup={() => { window.fetch = origFetch; clearDraft(); }} />;
      }
      return <Story />;
    },
  ],
};

export const ReminderStepPaidOverride: Story = {
  name: 'Send payment reminder step — paid, "Send anyway" override acknowledged',
  parameters: {
    docs: {
      description: {
        story:
          'Staff clicked "Send anyway" after seeing the paid-invoice warning. The alert message updates to confirm the acknowledgement and the Send Reminder button becomes enabled.',
      },
    },
  },
  decorators: [
    (Story) => {
      if (typeof window !== 'undefined') {
        setDraftStep('reminder');
        const origFetch = window.fetch;
        window.fetch = mockFetch({ payments: paymentsPaid });
        return <Story cleanup={() => { window.fetch = origFetch; clearDraft(); }} />;
      }
      return <Story />;
    },
  ],
  play: async ({ canvasElement }) => {
    const { within, userEvent } = await import('@storybook/test');
    const canvas = within(canvasElement);
    const sendAnywayBtn = await canvas.findByRole('button', { name: /send anyway/i });
    await userEvent.click(sendAnywayBtn);
  },
};

export const NotProceedingConfirm: Story = {
  name: 'Not proceeding — Step 1 (confirm)',
  decorators: [
    (Story) => {
      if (typeof window !== 'undefined') {
        setDraftStep('not_proceeding_confirm');
        const origFetch = window.fetch;
        window.fetch = mockFetch();
        return <Story cleanup={() => { window.fetch = origFetch; clearDraft(); }} />;
      }
      return <Story />;
    },
  ],
};

export const NotProceedingEmail: Story = {
  name: 'Not proceeding — Step 2 (send thank-you email?)',
  decorators: [
    (Story) => {
      if (typeof window !== 'undefined') {
        setDraftStep('not_proceeding_email');
        const origFetch = window.fetch;
        window.fetch = mockFetch();
        return <Story cleanup={() => { window.fetch = origFetch; clearDraft(); }} />;
      }
      return <Story />;
    },
  ],
};

export const DemoHub: Story = {
  name: 'Hub — demo mode',
  args: {
    demo: true,
  },
};

export const DemoResend: Story = {
  name: 'Re-send — demo mode',
  args: {
    demo: true,
  },
  play: async ({ canvasElement }) => {
    const { within, userEvent } = await import('@storybook/test');
    const canvas = within(canvasElement);
    const btn = await canvas.findByRole('button', { name: /re-send deposit invoice/i });
    await userEvent.click(btn);
  },
};

export const DemoReminder: Story = {
  name: 'Send payment reminder — demo mode',
  args: {
    demo: true,
  },
  play: async ({ canvasElement }) => {
    const { within, userEvent } = await import('@storybook/test');
    const canvas = within(canvasElement);
    const btn = await canvas.findByRole('button', { name: /send payment reminder/i });
    await userEvent.click(btn);
  },
};

export const DemoNotProceedingConfirm: Story = {
  name: 'Not proceeding step 1 — demo mode',
  args: {
    demo: true,
  },
  play: async ({ canvasElement }) => {
    const { within, userEvent } = await import('@storybook/test');
    const canvas = within(canvasElement);
    const btn = await canvas.findByRole('button', { name: /not proceeding/i });
    await userEvent.click(btn);
  },
};

export const DemoNotProceedingEmail: Story = {
  name: 'Not proceeding step 2 — demo mode',
  args: {
    demo: true,
  },
  play: async ({ canvasElement }) => {
    const { within, userEvent } = await import('@storybook/test');
    const canvas = within(canvasElement);
    const btn = await canvas.findByRole('button', { name: /not proceeding/i });
    await userEvent.click(btn);
    const continueBtn = await canvas.findByRole('button', { name: /continue/i });
    await userEvent.click(continueBtn);
  },
};
