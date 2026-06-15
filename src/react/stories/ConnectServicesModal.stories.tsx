import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Button from '@mui/material/Button';
import { ConnectServicesModal } from '../components/modals/ConnectServicesModal';

// ── Storybook note ─────────────────────────────────────────────────────────────
//
// ConnectServicesModal reads live module-level state from ConnectionToastContext
// (via useServiceStatuses()) and user privilege (via usePrivilege()). In
// Storybook neither is pre-seeded with real data, so:
//
//   • Status chips all start as "Checking…" and transition to the real status
//     once the /api/*/status endpoints reply — which they will if you run the
//     Express API server alongside Storybook (npm run dev in a second terminal).
//   • Privilege level defaults to 'member', so QuickBooks shows the "Ask an
//     admin" note; connect as an admin user and reload to see the Connect button.
//
// The stories are intentionally thin wrappers that exercise layout and prop
// combinations; use the Puppeteer suite (test:connect-services-modal) for
// status/privilege behaviour driven against a real server.

const meta: Meta<typeof ConnectServicesModal> = {
  title: 'Modals/ConnectServicesModal',
  component: ConnectServicesModal,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
  args: {
    open: true,
    onClose: () => {},
  },
};
export default meta;

type Story = StoryObj<typeof ConnectServicesModal>;

// ── Controlled wrapper ─────────────────────────────────────────────────────────

function Controlled(args: React.ComponentProps<typeof ConnectServicesModal>) {
  const [open, setOpen] = useState(args.open ?? true);
  return (
    <>
      <Button variant="outlined" onClick={() => setOpen(true)} sx={{ m: 2 }}>
        Open modal
      </Button>
      <ConnectServicesModal
        {...args}
        open={open}
        onClose={() => { setOpen(false); args.onClose?.(); }}
      />
    </>
  );
}

// ── Stories ────────────────────────────────────────────────────────────────────

/** All services connected — no action needed. */
export const AllConnected: Story = {
  name: 'All services connected',
  render: (args) => <Controlled {...args} />,
};

/** Google Calendar disconnected — highlighted with primary border. */
export const GoogleDisconnected: Story = {
  name: 'Google disconnected (highlighted)',
  render: (args) => <Controlled {...args} highlightService="google" />,
};

/** QuickBooks disconnected — highlighted. Admin sees Connect button (non-admin
 *  sees "Ask an admin" note — that variant is not easily toggled in Storybook
 *  without a privilege fixture, so the modal renders using the logged-in user's
 *  actual privilege in development). */
export const QuickBooksDisconnected: Story = {
  name: 'QuickBooks disconnected (highlighted)',
  render: (args) => <Controlled {...args} highlightService="quickbooks" />,
};

/** HubSpot disconnected — highlighted. HubSpot is "managed" so no connect
 *  button is shown; the user is directed to contact support. */
export const HubSpotDisconnected: Story = {
  name: 'HubSpot disconnected (highlighted)',
  render: (args) => <Controlled {...args} highlightService="hubspot" />,
};

/** Modal initially closed — click "Open modal" to trigger it. */
export const InitiallyClosed: Story = {
  name: 'Initially closed',
  args: { open: false },
  render: (args) => <Controlled {...args} />,
};
