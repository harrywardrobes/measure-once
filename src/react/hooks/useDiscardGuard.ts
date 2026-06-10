import { useState } from 'react';

/**
 * Centralises the "Discard changes?" guard that appears in modals.
 *
 * @param hasUnsavedChanges - True when the form has changes that would be lost on close.
 * @param onDiscard         - Called when the user confirms they want to discard changes
 *                            (or immediately when there are no unsaved changes).
 * @param isLocked          - When true, close requests are silently ignored (e.g. while submitting).
 *
 * @returns
 *   - `confirmOpen`        – Whether the "Discard changes?" dialog is currently showing.
 *   - `handleRequestClose` – Attach to the modal's onClose / Cancel button.
 *                            Calls `onDiscard` directly when there are no unsaved changes,
 *                            or opens the confirmation dialog otherwise.
 *   - `handleKeepEditing`  – Pass directly to `DiscardConfirmDialog` as `onKeepEditing`.
 *                            Closes the confirmation dialog and returns the user to the form.
 *   - `setConfirmOpen`     – Escape hatch for programmatic control.
 */
export function useDiscardGuard(
  hasUnsavedChanges: boolean,
  onDiscard: () => void,
  isLocked = false,
): {
  confirmOpen: boolean;
  handleRequestClose: () => void;
  handleKeepEditing: () => void;
  setConfirmOpen: (open: boolean) => void;
} {
  const [confirmOpen, setConfirmOpen] = useState(false);

  function handleRequestClose() {
    if (isLocked) return;
    if (hasUnsavedChanges) {
      setConfirmOpen(true);
    } else {
      onDiscard();
    }
  }

  function handleKeepEditing() {
    setConfirmOpen(false);
  }

  return { confirmOpen, handleRequestClose, handleKeepEditing, setConfirmOpen };
}
