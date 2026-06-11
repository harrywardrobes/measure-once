import type { Meta, StoryObj } from '@storybook/react';
import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { ToastProvider, useToastContext } from '../contexts/ToastContext';

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
