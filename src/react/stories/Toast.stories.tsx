import type { Meta, StoryObj } from '@storybook/react';
import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { ToastProvider, useToastContext } from '../contexts/ToastContext';
import { leadStatusConfirmationMessage } from '../utils/leadStatusConfirmation';

const meta: Meta = {
  title: 'Feedback/Toast',
  tags: ['autodocs'],
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'Central toast notification system. All four MUI Alert severity ' +
          'variants are supported. Toasts always render above the bottom nav bar ' +
          '(z-index 9500, bottom offset 64 px + safe-area-inset).',
      },
    },
  },
};
export default meta;

type Story = StoryObj;

function ToastTriggers() {
  const { showToast, showToastWithAction } = useToastContext();
  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h6" gutterBottom>
        Toast severity variants
      </Typography>
      <Stack spacing={2} direction="column" sx={{ maxWidth: 320 }}>
        <Button
          variant="contained"
          color="success"
          onClick={() => showToast('Changes saved successfully')}
        >
          Success toast
        </Button>
        <Button
          variant="contained"
          color="error"
          onClick={() => showToast('Something went wrong — please try again', true)}
        >
          Error toast (isError=true)
        </Button>
        <Button
          variant="contained"
          color="warning"
          onClick={() =>
            showToast("Couldn't refresh live data — results may be stale", false, {
              severity: 'warning',
              duration: 6000,
            })
          }
        >
          Warning toast (6 s)
        </Button>
        <Button
          variant="contained"
          color="info"
          onClick={() =>
            showToast('QuickBooks connected successfully', false, { severity: 'info' })
          }
        >
          Info toast
        </Button>
        <Button
          variant="outlined"
          onClick={() =>
            showToastWithAction(
              'Contact updated — view changes?',
              { label: 'View', onClick: () => alert('Navigating…') },
              { severity: 'success', duration: 8000 },
            )
          }
        >
          Toast with action (8 s)
        </Button>
        <Button
          variant="outlined"
          color="error"
          onClick={() =>
            showToastWithAction(
              'Could not sync — HubSpot token expired',
              { label: 'Settings', onClick: () => alert('Opening settings…') },
              { severity: 'error', duration: 10000 },
            )
          }
        >
          Error toast with action (10 s)
        </Button>
      </Stack>
    </Box>
  );
}

export const AllVariants: Story = {
  name: 'All severity variants',
  render: () => (
    <ToastProvider>
      <ToastTriggers />
    </ToastProvider>
  ),
};

/**
 * Lead-status confirmation toast — shown by the card-action modals after a
 * terminal outcome. The raw hs_lead_status key returned by the execute route
 * (e.g. DESIGN_SCHEDULED) is mapped to its configured human label via
 * `window.LEAD_STATUS_OPTIONS`, producing "Lead status set to Design visit
 * scheduled" rather than a vague "status updated" message.
 */
function LeadStatusConfirmTriggers() {
  const { showToast } = useToastContext();
  React.useEffect(() => {
    (window as unknown as Record<string, unknown>).LEAD_STATUS_OPTIONS = [
      { value: 'DESIGN_SCHEDULED', label: 'Design visit scheduled' },
      { value: 'DEPOSIT_INVOICE', label: 'Deposit invoice sent' },
      { value: 'DECLINED_DEAL', label: 'Declined deal' },
      { value: 'NOT_SUITABLE', label: 'Not suitable' },
    ];
  }, []);
  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h6" gutterBottom>
        Lead-status confirmation
      </Typography>
      <Stack spacing={2} direction="column" sx={{ maxWidth: 360 }}>
        <Button
          variant="contained"
          color="success"
          onClick={() => showToast(leadStatusConfirmationMessage('DESIGN_SCHEDULED'))}
        >
          Booked (design)
        </Button>
        <Button
          variant="contained"
          color="success"
          onClick={() => showToast(leadStatusConfirmationMessage('DEPOSIT_INVOICE'))}
        >
          Deal accepted
        </Button>
        <Button
          variant="contained"
          color="success"
          onClick={() => showToast(leadStatusConfirmationMessage('NOT_SUITABLE'))}
        >
          Not suitable
        </Button>
        <Button
          variant="outlined"
          onClick={() => showToast(leadStatusConfirmationMessage('UNREGISTERED_KEY'))}
        >
          Unregistered key (falls back to raw key)
        </Button>
      </Stack>
    </Box>
  );
}

export const LeadStatusConfirmation: Story = {
  name: 'Lead-status confirmation',
  render: () => (
    <ToastProvider>
      <LeadStatusConfirmTriggers />
    </ToastProvider>
  ),
};
