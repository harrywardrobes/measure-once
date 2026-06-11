import React from 'react';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import Typography from '@mui/material/Typography';
import type { CardActionHandlerData } from '../../hooks/useCardActionHandlers';
import { DemoDialogTitle } from './demoMode';

interface Props {
  handler: CardActionHandlerData;
  open: boolean;
  onClose: () => void;
  demo?: boolean;
}

export function MessagePopupModal({ handler, open, onClose, demo }: Props) {
  const cfg = handler.config || {};
  const title = (cfg.title as string) || 'Action required';
  const message = (cfg.message as string) || '';

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DemoDialogTitle demo={demo}>{title}</DemoDialogTitle>
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
