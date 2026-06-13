import React, { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { UploadPhotosModal } from './UploadPhotosModal';
import type { CardActionHandlerData } from '../../hooks/useCardActionHandlers';
import type { CardActionContext } from '../../utils/dispatchCardActionHandler';

const meta: Meta = {
  title: 'Components/Modals/UploadPhotos',
  tags: ['autodocs'],
  parameters: { layout: 'padded' },
};
export default meta;

type Story = StoryObj;

const mockHandler: CardActionHandlerData = {
  id: 1,
  type: 'upload_photos_and_info',
  config: {},
  bindings: [],
};

const mockCtx: CardActionContext = {
  contactId: '12345',
  contactName: 'Jane Smith',
  contactEmail: 'jane@example.com',
};

const noEmailCtx: CardActionContext = {
  contactId: '12345',
  contactName: 'Jane Smith',
  contactEmail: '',
};

const MOCK_LINK = 'https://measureonce.replit.app/customer-info/abc123def456abc123def456abc123def456abc123def456abc123def456abc123';
const MOCK_TOKEN = 'abc123def456abc123def456abc123def456abc123def456abc123def456abc123';

function Demo({
  ctx,
  generateDelay = 800,
  generateError = '',
  sendError = '',
}: {
  ctx: CardActionContext;
  generateDelay?: number;
  generateError?: string;
  sendError?: string;
}) {
  const [open, setOpen] = useState(false);

  React.useEffect(() => {
    if (!open) return;

    const origFetch = window.fetch;
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      if (url.includes('/link-status')) {
        return new Response(JSON.stringify({ hasActiveLink: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.includes('/generate-link')) {
        await new Promise(r => setTimeout(r, generateDelay));
        if (generateError) {
          return new Response(JSON.stringify({ error: generateError }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({ formLink: MOCK_LINK, token: MOCK_TOKEN, expiresAt: new Date(Date.now() + 28 * 86400000).toISOString() }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('/upload-photos-and-info')) {
        await new Promise(r => setTimeout(r, 600));
        if (sendError) {
          return new Response(JSON.stringify({ error: sendError }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return origFetch(input, init);
    };

    return () => { window.fetch = origFetch; };
  }, [open, generateDelay, generateError, sendError]);

  return (
    <Box>
      <Button variant="contained" onClick={() => setOpen(true)}>
        Open upload photos modal
      </Button>
      <UploadPhotosModal
        handler={mockHandler}
        ctx={ctx}
        open={open}
        onClose={() => setOpen(false)}
      />
    </Box>
  );
}

function ActiveLinkManagerDemo({ ctx }: { ctx: CardActionContext }) {
  const [open, setOpen] = useState(false);
  const expiresAt = new Date(Date.now() + 14 * 86400000).toISOString();

  React.useEffect(() => {
    if (!open) return;

    const origFetch = window.fetch;
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method || 'GET').toUpperCase();

      if (url.includes('/link-status')) {
        return new Response(JSON.stringify({
          hasActiveLink: true,
          expiresAt,
          formLink: MOCK_LINK,
          token: MOCK_TOKEN,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.includes('/resend') && method === 'POST') {
        await new Promise(r => setTimeout(r, 400));
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.includes('/generate-link') && method === 'POST') {
        await new Promise(r => setTimeout(r, 600));
        return new Response(
          JSON.stringify({ formLink: MOCK_LINK, token: MOCK_TOKEN, expiresAt }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return origFetch(input, init);
    };

    return () => { window.fetch = origFetch; };
  }, [open, expiresAt]);

  return (
    <Box>
      <Button variant="contained" onClick={() => setOpen(true)}>
        Open (active link — manager/admin)
      </Button>
      <UploadPhotosModal
        handler={mockHandler}
        ctx={ctx}
        open={open}
        onClose={() => setOpen(false)}
      />
    </Box>
  );
}

function ActiveLinkMemberDemo({ ctx }: { ctx: CardActionContext }) {
  const [open, setOpen] = useState(false);
  const expiresAt = new Date(Date.now() + 14 * 86400000).toISOString();

  React.useEffect(() => {
    if (!open) return;

    const origFetch = window.fetch;
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method || 'GET').toUpperCase();

      if (url.includes('/link-status')) {
        return new Response(JSON.stringify({
          hasActiveLink: true,
          expiresAt,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.includes('/generate-link') && method === 'POST') {
        await new Promise(r => setTimeout(r, 600));
        return new Response(
          JSON.stringify({ expiresAt }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return origFetch(input, init);
    };

    return () => { window.fetch = origFetch; };
  }, [open, expiresAt]);

  return (
    <Box>
      <Button variant="contained" onClick={() => setOpen(true)}>
        Open (active link — member view)
      </Button>
      <UploadPhotosModal
        handler={mockHandler}
        ctx={ctx}
        open={open}
        onClose={() => setOpen(false)}
      />
    </Box>
  );
}

export const Default: Story = {
  name: 'Normal — link generates, then send email or copy & close',
  render: () => <Demo ctx={mockCtx} generateDelay={800} />,
};

export const CopyAndClose: Story = {
  name: 'Copy & close — link ready, no email sent',
  render: () => <Demo ctx={mockCtx} generateDelay={300} />,
};

export const ManuallyUpload: Story = {
  name: 'Manually Upload — button visible in ready phase',
  render: () => <Demo ctx={mockCtx} generateDelay={300} />,
};

export const ActiveLinkManager: Story = {
  name: 'Active link — manager/admin view (Copy, Re-send, Manually Upload)',
  render: () => <ActiveLinkManagerDemo ctx={mockCtx} />,
};

export const ActiveLinkMember: Story = {
  name: 'Active link — member view (warning only, generate or cancel)',
  render: () => <ActiveLinkMemberDemo ctx={mockCtx} />,
};

export const LinkGenerating: Story = {
  name: 'Loading state — link generating',
  render: () => <Demo ctx={mockCtx} generateDelay={30000} />,
};

export const LinkGenerationError: Story = {
  name: 'Error state — link generation failed',
  render: () => <Demo ctx={mockCtx} generateDelay={400} generateError="Could not fetch contact from HubSpot." />,
};

export const SendEmailError: Story = {
  name: 'Error state — send email failed',
  render: () => <Demo ctx={mockCtx} generateDelay={400} sendError="SMTP connection refused." />,
};

export const NoEmail: Story = {
  name: 'No customer email',
  render: () => <Demo ctx={noEmailCtx} generateDelay={800} generateError="Contact has no email address in HubSpot." />,
};

export const AllStates: Story = {
  name: 'All states side by side',
  render: () => (
    <Stack direction="row" spacing={4} useFlexGap sx={{ flexWrap: 'wrap' }}>
      <Box>
        <Typography variant="subtitle2" gutterBottom>Normal (link loads then send)</Typography>
        <Demo ctx={mockCtx} generateDelay={800} />
      </Box>
      <Box>
        <Typography variant="subtitle2" gutterBottom>Active link — manager/admin</Typography>
        <ActiveLinkManagerDemo ctx={mockCtx} />
      </Box>
      <Box>
        <Typography variant="subtitle2" gutterBottom>Active link — member</Typography>
        <ActiveLinkMemberDemo ctx={mockCtx} />
      </Box>
      <Box>
        <Typography variant="subtitle2" gutterBottom>Link generating (slow)</Typography>
        <Demo ctx={mockCtx} generateDelay={30000} />
      </Box>
      <Box>
        <Typography variant="subtitle2" gutterBottom>Link generation error</Typography>
        <Demo ctx={mockCtx} generateDelay={300} generateError="Could not reach HubSpot." />
      </Box>
      <Box>
        <Typography variant="subtitle2" gutterBottom>Send fails (link still copyable)</Typography>
        <Demo ctx={mockCtx} generateDelay={300} sendError="SMTP connection refused." />
      </Box>
    </Stack>
  ),
};
