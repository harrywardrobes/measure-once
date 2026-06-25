import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ContactCustomerModal } from './ContactCustomerModal';

const meta: Meta<typeof ContactCustomerModal> = {
  title: 'Modals/ContactCustomerModal',
  component: ContactCustomerModal,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  args: {
    contactId: '12345',
    contactName: 'Jane Smith',
    contactEmail: 'jane.smith@example.com',
    onClose: () => {},
  },
};
export default meta;

type Story = StoryObj<typeof ContactCustomerModal>;

export const Demo: Story = {
  name: 'Demo mode — Log Call, Send Email, Log WhatsApp buttons',
  parameters: {
    docs: {
      description: {
        story:
          'Default state in demo mode. Buttons now read "Log Call", "Send Email", and "Log WhatsApp". The modal title is "Contact [Name]". Clicking "Send Email" opens the email preview panel; clicking "Log Call" or "Log WhatsApp" opens the note panel.',
      },
    },
  },
  args: {
    demo: true,
  },
};

export const DemoNotePanelOpen: Story = {
  name: 'Demo mode — Log Call note panel open',
  parameters: {
    docs: {
      description: {
        story:
          'Clicking "Log Call" opens the inline note panel. The Confirm button stays disabled until a note is entered.',
      },
    },
  },
  args: {
    demo: true,
  },
  play: async ({ canvasElement }) => {
    const { within, userEvent, expect } = await import('@storybook/test');
    const canvas = within(canvasElement);
    const btn = await canvas.findByTestId('contact-method-call-btn');
    await userEvent.click(btn);
    await canvas.findByTestId('contact-attempt-note-field');
    const confirm = await canvas.findByTestId('contact-attempt-confirm-btn');
    await expect(confirm).toBeDisabled();
  },
};

export const DemoNotePanelWithText: Story = {
  name: 'Demo mode — Log Call note panel with text (Confirm enabled)',
  parameters: {
    docs: {
      description: {
        story:
          'After typing a note, the Confirm button becomes enabled. In demo mode confirming simply closes the panel without saving.',
      },
    },
  },
  args: {
    demo: true,
  },
  play: async ({ canvasElement }) => {
    const { within, userEvent, expect } = await import('@storybook/test');
    const canvas = within(canvasElement);
    const btn = await canvas.findByTestId('contact-method-call-btn');
    await userEvent.click(btn);
    await canvas.findByTestId('contact-attempt-note-field');
    const noteField = await canvas.findByRole('textbox');
    await userEvent.type(noteField, 'Left a voicemail asking to schedule the design visit.');
    const confirm = await canvas.findByTestId('contact-attempt-confirm-btn');
    await expect(confirm).toBeEnabled();
  },
};

export const DemoEmailPreviewOpen: Story = {
  name: 'Demo mode — Send Email preview panel open',
  parameters: {
    docs: {
      description: {
        story:
          'Clicking "Send Email" opens the email preview panel with an editable Subject and Body field pre-filled from the template. In demo mode the send is a no-op and the actual API call is skipped.',
      },
    },
  },
  args: {
    demo: true,
  },
  play: async ({ canvasElement }) => {
    const { within, userEvent, expect } = await import('@storybook/test');
    const canvas = within(canvasElement);
    const btn = await canvas.findByTestId('contact-method-email-btn');
    await userEvent.click(btn);
    const panel = await canvas.findByTestId('email-preview-panel');
    await expect(panel).toBeInTheDocument();
    const subjectField = await canvas.findByTestId('email-preview-subject');
    await expect(subjectField).toBeInTheDocument();
    const bodyField = await canvas.findByTestId('email-preview-body');
    await expect(bodyField).toBeInTheDocument();
    const sendBtn = await canvas.findByTestId('email-preview-send-btn');
    await expect(sendBtn).toBeEnabled();
  },
};

const DEMO_EMAIL_PREVIEW = {
  subject: 'Fitted Wardrobes',
  text: "Hi Jane,\n\nI hope you're doing well. I wanted to reach out and follow up on your enquiry with us.\n\nPlease don't hesitate to get in touch if you have any questions — we're happy to help.\n\nKind regards,\nThe team",
  html: '<p>Hi Jane,</p><p>I hope you\'re doing well. I wanted to reach out and follow up on your enquiry with us.</p><p>Please don\'t hesitate to get in touch if you have any questions — we\'re happy to help.</p><p>Kind regards,<br>The team</p>',
};

function mockContactFetch(payload: object, emailPreview: object = DEMO_EMAIL_PREVIEW) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST' && url.includes('/api/card-actions/contact-customer')) {
      const responsePayload = url.includes('/email-preview') ? emailPreview : payload;
      return new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function mockContactFetchDelayed(
  payload: object,
  emailPreview: object = DEMO_EMAIL_PREVIEW,
  sendDelayMs = 600,
) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST' && url.includes('/api/card-actions/contact-customer')) {
      if (url.includes('/email-preview')) {
        return new Response(JSON.stringify(emailPreview), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      await new Promise<void>((r) => setTimeout(r, sendDelayMs));
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function mockContactFetchSendError(emailPreview: object = DEMO_EMAIL_PREVIEW) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST' && url.includes('/api/card-actions/contact-customer')) {
      if (url.includes('/email-preview')) {
        return new Response(JSON.stringify(emailPreview), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ message: 'Server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

/**
 * Installs a mocked `window.fetch` synchronously (before children mount, so the
 * modal's load effect sees it) and restores the original on unmount. This keeps
 * the mock scoped to the story and prevents it from leaking into other stories
 * in the same session.
 */
function FetchMockProvider({
  fetchImpl,
  children,
}: {
  fetchImpl: typeof window.fetch;
  children: React.ReactNode;
}) {
  const originalRef = React.useRef<typeof window.fetch | null>(null);
  if (typeof window !== 'undefined' && originalRef.current === null) {
    originalRef.current = window.fetch;
    window.fetch = fetchImpl;
  }
  React.useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && originalRef.current) {
        window.fetch = originalRef.current;
        originalRef.current = null;
      }
    };
  }, []);
  return <>{children}</>;
}

const BASE_CONTACT_PAYLOAD = {
  contactName: 'Jane Smith',
  contactEmail: 'jane.smith@example.com',
  phone: '020 7946 0123',
  mobile: '07700 900456',
  leadStatus: null,
  callAttempted: false,
  emailSent: false,
  whatsappSent: false,
  lastAttemptAt: null,
  lastAttemptBy: null,
  attemptLog: [],
  historySessionCount: 0,
  historyTotalAttempts: 0,
  historyEverCalled: false,
  historyEverEmailed: false,
  historyEverWhatsapped: false,
  historyAttemptLog: [],
};

export const LiveTemplateEmailPreview: Story = {
  name: 'Send Email panel — live admin-edited template pre-filled',
  parameters: {
    docs: {
      description: {
        story:
          'Clicking "Send Email" fetches subject and body from the email-preview API endpoint (DB-backed via the admin-editable contact_customer_followup template). The mock returns a custom subject to demonstrate that admin edits flow through to the compose step. The Send button is enabled as soon as loading finishes.',
      },
    },
  },
  args: {
    demo: false,
  },
  decorators: [
    (Story) => (
      <FetchMockProvider
        fetchImpl={mockContactFetch(BASE_CONTACT_PAYLOAD, {
          subject: 'Custom admin subject line',
          text: "Hi Jane,\n\nThis wording was set by an admin in Email Templates.\n\nKind regards,\nThe team",
          html: '<p>Hi Jane,</p><p>This wording was set by an admin in Email Templates.</p><p>Kind regards,<br>The team</p>',
        })}
      >
        <Story />
      </FetchMockProvider>
    ),
  ],
  play: async ({ canvasElement }) => {
    const { within, userEvent, expect } = await import('@storybook/test');
    const canvas = within(canvasElement);
    const emailBtn = await canvas.findByTestId('contact-method-email-btn');
    await userEvent.click(emailBtn);
    const panel = await canvas.findByTestId('email-preview-panel');
    await expect(panel).toBeInTheDocument();
    const subjectField = (await canvas.findByTestId('email-preview-subject')) as HTMLInputElement;
    await expect(subjectField.value).toBe('Custom admin subject line');
    const bodyField = (await canvas.findByTestId('email-preview-body')) as HTMLTextAreaElement;
    await expect(bodyField.value).toContain('This wording was set by an admin');
    const sendBtn = await canvas.findByTestId('email-preview-send-btn');
    await expect(sendBtn).toBeEnabled();
  },
};

export const OneMethodLogged: Story = {
  name: 'One method already logged (greyed ✓ Send Email + "+ log another")',
  parameters: {
    docs: {
      description: {
        story:
          'An email has already been sent this session. The "Send Email" button renders greyed with a ✓ and a "+ log another" link appears next to it so staff can send a further email. This variant runs in non-demo mode (with a mocked fetch) because the already-logged state is derived from the server response, which demo mode cannot represent.',
      },
    },
  },
  args: {
    demo: false,
  },
  decorators: [
    (Story) => (
      <FetchMockProvider
        fetchImpl={mockContactFetch({
          ...BASE_CONTACT_PAYLOAD,
          emailSent: true,
          lastAttemptAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          lastAttemptBy: 'Alex Carter',
          attemptLog: [
            {
              method: 'email',
              attemptedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
              attemptedBy: 'Alex Carter',
              note: 'Follow-up email sent: "Fitted Wardrobes"',
            },
          ],
        })}
      >
        <Story />
      </FetchMockProvider>
    ),
  ],
};

export const InlineSendButtonHiddenWhileSending: Story = {
  name: 'Send Email — inline buttons hidden and Sending… indicator visible during send',
  parameters: {
    docs: {
      description: {
        story:
          'When staff click the inline "Send Email" button, the button row is immediately replaced by a "Sending…" progress indicator while the API call is in flight. The send-email fetch is deliberately delayed (600 ms) so the test can assert the mid-flight state before it resolves. After the send completes the preview panel collapses.',
      },
    },
  },
  args: {
    demo: false,
  },
  decorators: [
    (Story) => (
      <FetchMockProvider
        fetchImpl={mockContactFetchDelayed(
          {
            ...BASE_CONTACT_PAYLOAD,
            emailSent: true,
            attempted_at: new Date().toISOString(),
            attemptLog: [],
          },
          DEMO_EMAIL_PREVIEW,
          600,
        )}
      >
        <Story />
      </FetchMockProvider>
    ),
  ],
  play: async ({ canvasElement }) => {
    const { within, userEvent, expect, waitFor } = await import('@storybook/test');
    const canvas = within(canvasElement);

    const emailBtn = await canvas.findByTestId('contact-method-email-btn');
    await userEvent.click(emailBtn);

    const inlineSendBtn = await canvas.findByTestId('email-preview-send-btn-inline');
    await expect(inlineSendBtn).toBeInTheDocument();

    await userEvent.click(inlineSendBtn);

    await waitFor(() => {
      expect(canvas.queryByTestId('email-preview-send-btn-inline')).not.toBeInTheDocument();
    });

    await waitFor(() => {
      expect(canvas.getByText('Sending…')).toBeInTheDocument();
    });

    await waitFor(
      () => {
        expect(canvas.queryByTestId('email-preview-panel')).not.toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  },
};

export const InlineSendButtonRestoredOnError: Story = {
  name: 'Send Email — inline buttons reappear after a send error',
  parameters: {
    docs: {
      description: {
        story:
          'When the send-email request returns a 500 error, emailFlow reverts to "preview" and the inline Send / Cancel button row reappears so staff can retry. An error message is shown beneath the buttons.',
      },
    },
  },
  args: {
    demo: false,
  },
  decorators: [
    (Story) => (
      <FetchMockProvider fetchImpl={mockContactFetchSendError()}>
        <Story />
      </FetchMockProvider>
    ),
  ],
  play: async ({ canvasElement }) => {
    const { within, userEvent, expect, waitFor } = await import('@storybook/test');
    const canvas = within(canvasElement);

    const emailBtn = await canvas.findByTestId('contact-method-email-btn');
    await userEvent.click(emailBtn);

    const inlineSendBtn = await canvas.findByTestId('email-preview-send-btn-inline');
    await userEvent.click(inlineSendBtn);

    await waitFor(() => {
      expect(canvas.queryByTestId('email-preview-send-btn-inline')).not.toBeInTheDocument();
    });

    const restoredBtn = await canvas.findByTestId('email-preview-send-btn-inline', {}, { timeout: 3000 });
    await expect(restoredBtn).toBeInTheDocument();

    const panel = canvas.queryByTestId('email-preview-panel');
    await expect(panel).toBeInTheDocument();
  },
};
