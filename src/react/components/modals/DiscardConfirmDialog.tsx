import React from 'react';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { FullScreenModal } from './FullScreenModal';

interface Props {
  open: boolean;
  onKeepEditing: () => void;
  onDiscard: () => void;
  /**
   * When provided, an extra primary "Save changes" button is shown so the user
   * can keep their work instead of discarding it (used by the admin
   * tab-switch guard). Omit for the plain discard-or-keep modal flow.
   */
  onSave?: () => void;
  /** Disables the buttons while a save triggered from this dialog is in flight. */
  saving?: boolean;
}

/**
 * Standard "Discard changes?" confirmation dialog.
 * Pair with `useDiscardGuard` for the full guard pattern, or pass `onSave` to
 * offer Save / Discard / Keep editing (admin unsaved-changes guard).
 */
export function DiscardConfirmDialog({ open, onKeepEditing, onDiscard, onSave, saving }: Props) {
  return (
    <FullScreenModal
      open={open}
      onClose={onKeepEditing}
      title="Discard changes?"
      centerContent
      footer={
        <>
          <Button onClick={onKeepEditing} disabled={saving}>Keep editing</Button>
          <Button color="error" onClick={onDiscard} disabled={saving}>
            Discard changes
          </Button>
          {onSave && (
            <Button variant="contained" onClick={onSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          )}
        </>
      }
    >
      <Typography variant="body2">
        You have unsaved changes — are you sure you want to discard them?
      </Typography>
    </FullScreenModal>
  );
}
