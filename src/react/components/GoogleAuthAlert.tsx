import React from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import type { SxProps, Theme } from '@mui/material/styles';
import { openConnectModal } from '../context/ConnectionToastContext';

interface Props {
  sx?: SxProps<Theme>;
}

export function GoogleAuthAlert({ sx }: Props) {
  return (
    <Alert severity="error" sx={sx}>
      Your Google account isn&apos;t connected.{' '}
      <Button
        onClick={() => openConnectModal('google', 'Google is disconnected — reconnect it to send emails from your Gmail account.')}
        size="small"
        color="inherit"
        sx={{ p: 0, minWidth: 0, fontWeight: 600, verticalAlign: 'baseline', textDecoration: 'underline' }}
      >
        Reconnect Google
      </Button>{' '}
      to continue.
    </Alert>
  );
}
