import React from 'react';
import Box from '@mui/material/Box';
import { STATUS_COLORS } from '../theme';

/**
 * Returns true when the contact has submitted their upload form —
 * i.e. lead status is AWAITING_PHOTOS.
 * Clears automatically once the lead status advances past AWAITING_PHOTOS.
 */
export function isPhotosReceived(
  leadStatus: string | undefined | null,
): boolean {
  return leadStatus === 'AWAITING_PHOTOS';
}

export interface PhotosReceivedBadgeProps {
  leadStatus: string | undefined | null;
}

/**
 * <PhotosReceivedBadge /> — renders a small green pill when the customer has
 * submitted their photos and info (AWAITING_PHOTOS lead status).
 * Renders nothing when the condition is not met.
 */
export function PhotosReceivedBadge({ leadStatus }: PhotosReceivedBadgeProps) {
  if (!isPhotosReceived(leadStatus)) return null;

  return (
    <Box
      component="span"
      title="Customer has submitted their photos and info — ready to review."
      sx={{
        fontSize: '0.62rem',
        fontWeight: 700,
        px: '6px',
        py: '1px',
        borderRadius: '999px',
        background: STATUS_COLORS.success.bg,
        color: STATUS_COLORS.success.text,
        border: '1px solid var(--status-success-border)',
        letterSpacing: '0.02em',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      Photos received
    </Box>
  );
}

export default PhotosReceivedBadge;
