import React, { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { within, userEvent, expect, waitFor } from '@storybook/test';
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';

import { ConflictResolverModal } from './ActionHandlersPage';

const meta: Meta = {
  title: 'Features/ActionHandlers/ConflictResolverModal',
  tags: ['autodocs'],
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Dialog shown when a lead-status slot or sub-status has more than one handler ' +
          'bound to it. Lists the conflicting handlers and lets an admin remove all but one ' +
          'to resolve the conflict. The dialog auto-closes when only one handler remains. ' +
          'Stories use a mock `onRemove` prop so no real API calls are made.',
      },
    },
  },
};
export default meta;

type Story = StoryObj;

const STATUSES = [
  {
    key: 'quote_sent',
    label: 'Quote sent',
    stage: 'sales',
    shorthand: 'QS',
    sort_order: 2,
    excluded_from_sales: false,
    is_null_row: false,
  },
  {
    key: 'survey_booked',
    label: 'Survey booked',
    stage: 'survey',
    shorthand: 'SB',
    sort_order: 3,
    excluded_from_sales: false,
    is_null_row: false,
  },
];

const SUBSTATUSES = [
  {
    id: 10,
    status_key: 'quote_sent',
    substatus_key: 'awaiting_approval',
    label: 'Awaiting approval',
    action_label: 'Mark awaiting approval',
    sort_order: 1,
  },
];

const INITIAL_TWO_HANDLERS = [
  {
    id: 1,
    name: 'Send quote message',
    type: 'show_message',
    config: { title: 'Quote sent', message: 'Remember to attach the PDF.' },
    bindings: [{ stage_key: 'sales', status_key: 'quote_sent' }],
  },
  {
    id: 2,
    name: 'Schedule survey visit',
    type: 'schedule_visit',
    config: { visitType: 'survey' },
    bindings: [{ stage_key: 'sales', status_key: 'quote_sent' }],
  },
];

const INITIAL_THREE_HANDLERS_SUB = [
  {
    id: 3,
    name: 'Start design visit (A)',
    type: 'start_design_visit',
    config: { inProgressLeadStatus: 'in_progress', submittedLeadStatus: 'dv_submitted' },
    bindings: [{ substatus_id: 10 }],
  },
  {
    id: 4,
    name: 'Show next-step message',
    type: 'show_message',
    config: { title: '', message: 'Upload the design brief before continuing.' },
    bindings: [{ substatus_id: 10 }],
  },
  {
    id: 5,
    name: 'Schedule follow-up visit',
    type: 'schedule_visit',
    config: { visitType: 'remedial' },
    bindings: [{ substatus_id: 10 }],
  },
];

function TwoConflictsDemo() {
  const [handlers, setHandlers] = useState(INITIAL_TWO_HANDLERS);
  const [open, setOpen] = useState(true);

  const handleRemove = async (id: number) => {
    const next = handlers.filter(h => h.id !== id);
    setHandlers(next);
    if (next.length <= 1) setOpen(false);
  };

  return (
    <Box>
      {!open && (
        <Button
          variant="outlined"
          onClick={() => {
            setHandlers(INITIAL_TWO_HANDLERS);
            setOpen(true);
          }}
        >
          Reopen dialog (resets handlers)
        </Button>
      )}
      {open && (
        <ConflictResolverModal
          stageKey="sales"
          statusKey="quote_sent"
          substatusId={null}
          handlers={handlers}
          statuses={STATUSES}
          substatuses={SUBSTATUSES}
          onClose={() => setOpen(false)}
          onRemove={handleRemove}
        />
      )}
    </Box>
  );
}

function ThreeConflictsSubstatusDemo() {
  const [handlers, setHandlers] = useState(INITIAL_THREE_HANDLERS_SUB);
  const [open, setOpen] = useState(true);

  const handleRemove = async (id: number) => {
    const next = handlers.filter(h => h.id !== id);
    setHandlers(next);
    if (next.length <= 1) setOpen(false);
  };

  return (
    <Box>
      {!open && (
        <Button
          variant="outlined"
          onClick={() => {
            setHandlers(INITIAL_THREE_HANDLERS_SUB);
            setOpen(true);
          }}
        >
          Reopen dialog (resets handlers)
        </Button>
      )}
      {open && (
        <ConflictResolverModal
          stageKey={null}
          statusKey={null}
          substatusId={10}
          handlers={handlers}
          statuses={STATUSES}
          substatuses={SUBSTATUSES}
          onClose={() => setOpen(false)}
          onRemove={handleRemove}
        />
      )}
    </Box>
  );
}

function RemoveErrorDemo() {
  const [open, setOpen] = useState(true);

  const handleRemove = async (_id: number) => {
    throw new Error('Server returned 500 — please try again.');
  };

  return (
    <Box>
      {!open && (
        <Button variant="outlined" onClick={() => setOpen(true)}>
          Reopen dialog
        </Button>
      )}
      {open && (
        <ConflictResolverModal
          stageKey="sales"
          statusKey="quote_sent"
          substatusId={null}
          handlers={INITIAL_TWO_HANDLERS}
          statuses={STATUSES}
          substatuses={SUBSTATUSES}
          onClose={() => setOpen(false)}
          onRemove={handleRemove}
        />
      )}
    </Box>
  );
}

export const TwoConflictingHandlers: Story = {
  name: '2 conflicting handlers — lead status slot',
  render: () => <TwoConflictsDemo />,
  parameters: {
    docs: {
      description: {
        story:
          'Two handlers are both bound to the **Quote sent** lead-status slot. ' +
          'Clicking "Remove" on one handler removes it from the list via the mock `onRemove`. ' +
          'When only one handler remains the dialog closes automatically. ' +
          'Use "Reopen dialog" to reset the demo back to two handlers.',
      },
    },
  },
  play: async () => {
    const body = within(document.body);

    const dialog = await body.findByRole('dialog');
    const removeButtons = await within(dialog).findAllByRole('button', { name: 'Remove' });
    await userEvent.click(removeButtons[0]);

    await waitFor(
      () => expect(body.queryAllByRole('button', { name: 'Remove' }).length).toBeLessThanOrEqual(1),
      { timeout: 3000 },
    );

    await waitFor(
      () => expect(body.queryByRole('dialog')).not.toBeInTheDocument(),
      { timeout: 3000 },
    );
  },
};

export const ThreeConflictingHandlersSubstatus: Story = {
  name: '3 conflicting handlers — sub-status slot',
  render: () => <ThreeConflictsSubstatusDemo />,
  parameters: {
    docs: {
      description: {
        story:
          'Three handlers are all bound to the **Awaiting approval** sub-status. ' +
          'The slot description is resolved from the `substatuses` prop by matching `id`. ' +
          'Remove two handlers one-at-a-time; the dialog closes when only one remains.',
      },
    },
  },
  play: async () => {
    const body = within(document.body);

    const dialog = await body.findByRole('dialog');

    const firstRemove = await within(dialog).findAllByRole('button', { name: 'Remove' });
    await userEvent.click(firstRemove[0]);

    await waitFor(
      async () => {
        const btns = within(dialog).queryAllByRole('button', { name: 'Remove' });
        expect(btns).toHaveLength(2);
      },
      { timeout: 3000 },
    );

    const secondRemove = within(dialog).getAllByRole('button', { name: 'Remove' });
    await userEvent.click(secondRemove[0]);

    await waitFor(
      () => expect(body.queryByRole('dialog')).not.toBeInTheDocument(),
      { timeout: 3000 },
    );
  },
};

export const RemoveError: Story = {
  name: 'Remove fails — error state',
  render: () => <RemoveErrorDemo />,
  parameters: {
    docs: {
      description: {
        story:
          'Simulates a server error during removal: the mock `onRemove` always throws. ' +
          'Clicking "Remove" shows the inline error message and re-enables both buttons, ' +
          'allowing the admin to retry.',
      },
    },
  },
  play: async () => {
    const body = within(document.body);

    const dialog = await body.findByRole('dialog');
    const removeButtons = await within(dialog).findAllByRole('button', { name: 'Remove' });
    await userEvent.click(removeButtons[0]);

    await within(dialog).findByText(/Remove failed/);

    await waitFor(() => {
      const btns = within(dialog).getAllByRole('button', { name: 'Remove' });
      btns.forEach(btn => expect(btn).not.toBeDisabled());
    }, { timeout: 3000 });
  },
};

function RemoveInteractionDemo() {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    const orig = window.fetch;
    window.fetch = function storybookRemoveMock(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
          ? input.href
          : (input as Request).url;
      const method = (
        init?.method ||
        (typeof input === 'object' && 'method' in input ? (input as Request).method : '') ||
        'GET'
      ).toUpperCase();
      if (method === 'DELETE' && /\/api\/admin\/card-action-handlers\/\d+\/binding/.test(url)) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return orig(input, init);
    };
    return () => {
      window.fetch = orig;
    };
  }, []);

  return (
    <Box>
      {!open && (
        <Button variant="outlined" onClick={() => setOpen(true)}>
          Reopen dialog
        </Button>
      )}
      {open && (
        <ConflictResolverModal
          stageKey="sales"
          statusKey="quote_sent"
          substatusId={null}
          handlers={INITIAL_TWO_HANDLERS}
          statuses={STATUSES}
          substatuses={SUBSTATUSES}
          onClose={() => setOpen(false)}
        />
      )}
    </Box>
  );
}

export const RemoveInteraction: Story = {
  name: 'Remove interaction — network mock',
  render: () => <RemoveInteractionDemo />,
  parameters: {
    docs: {
      description: {
        story:
          'Exercises the **real** remove code path: no `onRemove` prop is passed, so ' +
          'clicking "Remove" issues `DELETE /api/admin/card-action-handlers/:id/binding` via the ' +
          'normal `fetch`-based helper. A story-level `window.fetch` override intercepts ' +
          'that request and returns a 200 OK with no real server involved. ' +
          'After the mock DELETE resolves the dialog auto-closes — the same behaviour ' +
          'the admin sees in production when only one handler remains.',
      },
    },
  },
  play: async () => {
    const body = within(document.body);

    const dialog = await body.findByRole('dialog');
    const removeButtons = await within(dialog).findAllByRole('button', { name: 'Remove' });
    await userEvent.click(removeButtons[0]);

    await within(dialog).findByRole('button', { name: 'Removing…' });

    await waitFor(
      () => expect(body.queryByRole('dialog')).not.toBeInTheDocument(),
      { timeout: 3000 },
    );
  },
};
