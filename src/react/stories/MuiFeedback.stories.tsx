import React, { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import InfoIcon from '@mui/icons-material/Info';

const meta: Meta = {
  title: 'Feedback/MUI Feedback',
  parameters: { layout: 'padded' },
};
export default meta;

type Story = StoryObj;

export const Alerts: Story = {
  render: () => (
    <Stack spacing={1.5}>
      <Typography variant="h6" sx={{ fontWeight: 700 }}>Alert — severity variants</Typography>
      <Alert severity="success">HubSpot connected successfully.</Alert>
      <Alert severity="info">Storybook reflects the live theme tokens.</Alert>
      <Alert severity="warning">SMTP is not configured — email sending is disabled.</Alert>
      <Alert severity="error">Could not save — HubSpot token is invalid or expired.</Alert>

      <Typography variant="h6" sx={{ fontWeight: 700, mt: 1 }}>Alert — with title</Typography>
      <Alert severity="success">
        <AlertTitle>Connected</AlertTitle>
        HubSpot CRM is connected and syncing lead statuses.
      </Alert>
      <Alert severity="warning">
        <AlertTitle>Onboarding discrepancies</AlertTitle>
        The team member provided different values during onboarding than the admin pre-fills.
        Review and resolve below.
      </Alert>

      <Typography variant="h6" sx={{ fontWeight: 700, mt: 1 }}>Alert — with action</Typography>
      <Alert
        severity="info"
        action={
          <Button color="inherit" size="small">Dismiss</Button>
        }
      >
        A new version of the app is available.
      </Alert>
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small">Retry</Button>
        }
      >
        Failed to load customers — check your connection.
      </Alert>

      <Typography variant="h6" sx={{ fontWeight: 700, mt: 1 }}>Alert — outlined</Typography>
      <Alert severity="info" variant="outlined">Outlined info alert.</Alert>
      <Alert severity="warning" variant="outlined">Outlined warning alert.</Alert>

      <Typography variant="h6" sx={{ fontWeight: 700, mt: 1 }}>Alert — filled</Typography>
      <Alert severity="success" variant="filled">Filled success alert.</Alert>
      <Alert severity="error" variant="filled">Filled error alert.</Alert>
    </Stack>
  ),
};

function DialogDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outlined" onClick={() => setOpen(true)}>Open Dialog</Button>
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Confirm deletion</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This will permanently delete the selected customer record from HubSpot.
            This action cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="contained" color="error" onClick={() => setOpen(false)}>Delete</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

export const Dialogs: Story = {
  render: () => (
    <Stack spacing={2}>
      <Typography variant="h6" sx={{ fontWeight: 700 }}>Dialog</Typography>
      <DialogDemo />
    </Stack>
  ),
};

function SnackbarDemo() {
  const [open, setOpen] = useState(false);
  const [severity, setSeverity] = useState<'success' | 'error' | 'info' | 'warning'>('success');

  const show = (s: typeof severity) => {
    setSeverity(s);
    setOpen(true);
  };

  return (
    <>
      <Stack direction="row" spacing={1} flexWrap="wrap">
        <Button variant="outlined" color="success" onClick={() => show('success')}>Success toast</Button>
        <Button variant="outlined" color="error" onClick={() => show('error')}>Error toast</Button>
        <Button variant="outlined" color="info" onClick={() => show('info')}>Info toast</Button>
        <Button variant="outlined" color="warning" onClick={() => show('warning')}>Warning toast</Button>
      </Stack>
      <Snackbar
        open={open}
        autoHideDuration={3000}
        onClose={() => setOpen(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity={severity} onClose={() => setOpen(false)} sx={{ width: '100%' }}>
          {severity === 'success' && 'Changes saved successfully.'}
          {severity === 'error' && 'Could not save — please try again.'}
          {severity === 'info' && 'Your session will expire in 5 minutes.'}
          {severity === 'warning' && 'HubSpot rate limit reached — retrying in 30 s.'}
        </Alert>
      </Snackbar>
    </>
  );
}

export const Snackbars: Story = {
  render: () => (
    <Stack spacing={2}>
      <Typography variant="h6" sx={{ fontWeight: 700 }}>Snackbar</Typography>
      <SnackbarDemo />
    </Stack>
  ),
};

export const Tooltips: Story = {
  render: () => (
    <Stack spacing={2}>
      <Typography variant="h6" sx={{ fontWeight: 700 }}>Tooltip — placements</Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, pt: 2 }}>
        <Tooltip title="Top tooltip" placement="top"><Button variant="outlined">Top</Button></Tooltip>
        <Tooltip title="Bottom tooltip" placement="bottom"><Button variant="outlined">Bottom</Button></Tooltip>
        <Tooltip title="Left tooltip" placement="left"><Button variant="outlined">Left</Button></Tooltip>
        <Tooltip title="Right tooltip" placement="right"><Button variant="outlined">Right</Button></Tooltip>
      </Box>

      <Typography variant="h6" sx={{ fontWeight: 700, mt: 1 }}>Tooltip — on icon</Typography>
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        <Tooltip title="This icon provides additional context about the field.">
          <InfoIcon color="action" sx={{ cursor: 'help' }} />
        </Tooltip>
        <Tooltip title="Copy to clipboard">
          <Button variant="outlined" size="small">Copy token</Button>
        </Tooltip>
      </Box>

      <Typography variant="h6" sx={{ fontWeight: 700, mt: 1 }}>Tooltip — rich content</Typography>
      <Tooltip
        title={
          <Box>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>HubSpot CRM</Typography>
            <Typography variant="caption">Connected · Last synced 2 minutes ago</Typography>
          </Box>
        }
        arrow
      >
        <Button variant="outlined">Hover for details</Button>
      </Tooltip>
    </Stack>
  ),
};
