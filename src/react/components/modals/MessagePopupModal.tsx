import React from 'react';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import type { CardActionHandlerData } from '../../hooks/useCardActionHandlers';
import { FullScreenModal } from './FullScreenModal';

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
    <FullScreenModal
      open={open}
      onClose={onClose}
      title={title}
      headerActions={
        demo ? <Chip label="Demo preview" size="small" color="info" variant="outlined" /> : undefined
      }
      footer={
        <Button variant="contained" onClick={onClose}>
          OK
        </Button>
      }
    >
      <Typography
        variant="body2"
        sx={{ color: 'text.secondary', lineHeight: 1.6, whiteSpace: 'pre-line' }}
      >
        {message}
      </Typography>
    </FullScreenModal>
  );
}
