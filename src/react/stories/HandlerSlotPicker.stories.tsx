import type { Meta, StoryObj } from '@storybook/react';
import React from 'react';
import Box from '@mui/material/Box';
import { HandlerSlotPicker } from '../pages/admin/HandlerSlotPicker';
import type { SlotHandler } from '../pages/admin/HandlerSlotPicker';

// ── Mock helpers ───────────────────────────────────────────────────────────────

function mockFetch(overrides?: Record<string, unknown>) {
  const origFetch = window.fetch;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.includes('/api/admin/card-action-handlers') || url.includes('/api/admin/stage-action-labels')) {
      return new Response(JSON.stringify({ ok: true, id: 42, ...overrides }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return origFetch(input, init);
  };
  return () => { window.fetch = origFetch; };
}

// ── Sample handlers ────────────────────────────────────────────────────────────

const NO_HANDLER: SlotHandler[] = [];

const SINGLE_HANDLER: SlotHandler[] = [
  {
    id: 1, name: '', type: 'arrange_visit',
    config: { action_name: 'Book design visit' },
    bindings: [{ stage_key: 'sales', status_key: 'new_lead' }],
  },
];

const CONFLICT_HANDLERS: SlotHandler[] = [
  {
    id: 1, name: '', type: 'arrange_visit',
    config: { action_name: 'Book design visit' },
    bindings: [{ stage_key: 'sales', status_key: 'new_lead' }],
  },
  {
    id: 2, name: '', type: 'summarise_phone_call',
    config: {},
    bindings: [{ stage_key: 'sales', status_key: 'new_lead' }],
  },
];

// ── Meta ───────────────────────────────────────────────────────────────────────

const meta: Meta<typeof HandlerSlotPicker> = {
  title: 'Admin/HandlerSlotPicker',
  component: HandlerSlotPicker,
  tags: ['autodocs'],
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <Box sx={{ maxWidth: 640, p: 2 }}>
        <Story />
      </Box>
    ),
  ],
  args: {
    stageKey: 'sales',
    statusKey: 'new_lead',
    handlers: NO_HANDLER,
    onMutated: () => {},
  },
};
export default meta;

type Story = StoryObj<typeof HandlerSlotPicker>;

// ── Stories ───────────────────────────────────────────────────────────────────

export const Empty: Story = {
  name: 'Empty — no handler bound',
  args: { handlers: NO_HANDLER },
  decorators: [(Story) => { mockFetch(); return <Story />; }],
};

export const WithHandler: Story = {
  name: 'Pre-populated — single handler',
  args: { handlers: SINGLE_HANDLER },
  decorators: [(Story) => { mockFetch(); return <Story />; }],
};

export const Conflict: Story = {
  name: 'Conflict — multiple handlers bound',
  args: { handlers: CONFLICT_HANDLERS },
  decorators: [(Story) => {
    // expose mock openConflictResolver so the "Fix conflict" button is clickable
    (window as unknown as Record<string, unknown>).openConflictResolver =
      (sk: string | null, stk: string | null) => alert(`openConflictResolver(${sk}, ${stk})`);
    return <Story />;
  }],
};

export const GlobalSlot: Story = {
  name: 'Global "no lead status" slot',
  args: {
    stageKey: '__global__',
    statusKey: '',
    handlers: [
      {
        id: 10, name: '', type: 'show_message',
        config: { message: 'Contact has no lead status — check HubSpot.', action_name: 'Check status' },
        bindings: [{ stage_key: '__global__', status_key: '' }],
      },
    ],
  },
  decorators: [(Story) => { mockFetch(); return <Story />; }],
};
