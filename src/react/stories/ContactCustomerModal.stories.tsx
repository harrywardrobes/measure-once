import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ContactCustomerModal } from '../components/modals/ContactCustomerModal';

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
  name: 'Demo mode — all three method buttons available',
  parameters: {
    docs: {
      description: {
        story:
          'Default state in demo mode. Each contact method (Called, Emailed, WhatsApp) is an outlined button that opens an inline note panel when clicked — replacing the old checkbox UI.',
      },
    },
  },
  args: {
    demo: true,
  },
};

export const DemoNotePanelOpen: Story = {
  name: 'Demo mode — note panel open',
  parameters: {
    docs: {
      description: {
        story:
          'Clicking a method button (here "Called") opens the inline note panel. The Confirm button stays disabled until a note is entered, enforcing the confirm-before-save flow.',
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
  name: 'Demo mode — note panel with text (Confirm enabled)',
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
    const btn = await canvas.findByTestId('contact-method-email-btn');
    await userEvent.click(btn);
    await canvas.findByTestId('contact-attempt-note-field');
    const noteField = await canvas.findByRole('textbox');
    await userEvent.type(noteField, 'Left a voicemail asking to schedule the design visit.');
    const confirm = await canvas.findByTestId('contact-attempt-confirm-btn');
    await expect(confirm).toBeEnabled();
  },
};

function mockContactFetch(payload: object) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST' && url.includes('/api/card-actions/contact-customer')) {
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

export const OneMethodLogged: Story = {
  name: 'One method already logged (greyed ✓ + "+ log another")',
  parameters: {
    docs: {
      description: {
        story:
          'A call has already been logged this session. The "Called" button renders greyed with a ✓ and a "+ log another" link appears next to it so staff can record a further attempt. This variant runs in non-demo mode (with a mocked fetch) because the already-logged state is derived from the server response, which demo mode cannot represent.',
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
          contactName: 'Jane Smith',
          contactEmail: 'jane.smith@example.com',
          phone: '020 7946 0123',
          mobile: '07700 900456',
          whatsapp: '07700 900456',
          leadStatus: null,
          callAttempted: true,
          emailSent: false,
          whatsappSent: false,
          lastAttemptAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          lastAttemptBy: 'Alex Carter',
          attemptLog: [
            {
              method: 'call',
              attemptedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
              attemptedBy: 'Alex Carter',
              note: 'No answer — left a voicemail.',
            },
          ],
          historySessionCount: 0,
          historyTotalAttempts: 0,
          historyEverCalled: false,
          historyEverEmailed: false,
          historyEverWhatsapped: false,
          historyAttemptLog: [],
        })}
      >
        <Story />
      </FetchMockProvider>
    ),
  ],
};
