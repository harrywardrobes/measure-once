/**
 * DuplicateCancelErrorAlert — canonical duplicate-visit cancel-existing error UI.
 *
 * Use this component whenever a visit modal detects a duplicate calendar event
 * and needs to surface a "cancel existing visit" failure with a retry affordance.
 *
 * Pattern:
 *   - error Alert (severity="error", mt: 1)
 *   - inline "Try again" Button action (color="inherit", size="small")
 *   - data-testid on the retry button scoped to the calling modal
 *     (e.g. "av-duplicate-cancel-existing-retry", "dvf-duplicate-cancel-existing-retry")
 *
 * When adding a new visit type that has the same duplicate-check guard, import
 * this component instead of copying the Alert+Button block.  Pick a unique
 * data-testid prefix so automated tests can target the specific modal.
 */
import React from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';

interface DuplicateCancelErrorAlertProps {
  message: string;
  onRetry: () => void;
  retryButtonTestId: string;
}

export function DuplicateCancelErrorAlert({
  message,
  onRetry,
  retryButtonTestId,
}: DuplicateCancelErrorAlertProps) {
  return (
    <Alert
      severity="error"
      sx={{ mt: 1 }}
      action={
        <Button
          color="inherit"
          size="small"
          onClick={onRetry}
          data-testid={retryButtonTestId}
        >
          Try again
        </Button>
      }
    >
      {message}
    </Alert>
  );
}
