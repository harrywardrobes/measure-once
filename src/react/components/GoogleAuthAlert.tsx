import React from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import type { SxProps, Theme } from '@mui/material/styles';

interface Props {
  sx?: SxProps<Theme>;
}

export function GoogleAuthAlert({ sx }: Props) {
  return (
    <Alert severity="error" sx={sx}>
      Your Google account isn&apos;t connected.{' '}
      <Button
        component="a"
        href="/profile"
        size="small"
        color="inherit"
        sx={{ p: 0, minWidth: 0, fontWeight: 600, verticalAlign: 'baseline', textDecoration: 'underline' }}
      >
        Go to your profile
      </Button>{' '}
      to connect it, then try again.
    </Alert>
  );
}
