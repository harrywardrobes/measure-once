import React from 'react';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';

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
    <Dialog open={open} onClose={onKeepEditing} maxWidth="xs" fullWidth>
      <DialogTitle>Discard changes?</DialogTitle>
      <DialogContent>
        <Typography variant="body2">
          You have unsaved changes — are you sure you want to discard them?
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onKeepEditing}>Keep editing</Button>
        <Button color="error" onClick={onDiscard}>Discard changes</Button>
      </DialogActions>
    </Dialog>
  );
}
