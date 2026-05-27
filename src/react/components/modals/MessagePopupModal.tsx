import React from 'react';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';
import type { CardActionHandlerData } from '../../hooks/useCardActionHandlers';

interface Props {
  handler: CardActionHandlerData;
  open: boolean;
  onClose: () => void;
}

export function MessagePopupModal({ handler, open, onClose }: Props) {
  const cfg = handler.config || {};
  const title = (cfg.title as string) || 'Action required';
  const message = (cfg.message as string) || '';

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Typography
          variant="body2"
          sx={{ color: 'text.secondary', lineHeight: 1.6, whiteSpace: 'pre-line' }}
        >
          {message}
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button variant="contained" onClick={onClose}>OK</Button>
      </DialogActions>
    </Dialog>
  );
}
