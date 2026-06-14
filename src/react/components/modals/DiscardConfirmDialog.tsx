import React from 'react';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { FullScreenModal } from './FullScreenModal';

interface Props {
  open: boolean;
  onKeepEditing: () => void;
  onDiscard: () => void;
}

/**
 * Standard "Discard changes?" confirmation dialog.
 * Pair with `useDiscardGuard` for the full guard pattern.
 */
export function DiscardConfirmDialog({ open, onKeepEditing, onDiscard }: Props) {
  return (
    <FullScreenModal
      open={open}
      onClose={onKeepEditing}
      title="Discard changes?"
      centerContent
      footer={
        <>
          <Button onClick={onKeepEditing}>Keep editing</Button>
          <Button color="error" onClick={onDiscard}>
            Discard changes
          </Button>
        </>
      }
    >
      <Typography variant="body2">
        You have unsaved changes — are you sure you want to discard them?
      </Typography>
    </FullScreenModal>
  );
}
