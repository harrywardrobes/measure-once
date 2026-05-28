import React from 'react';
import Box from '@mui/material/Box';

/**
 * Returns true when the contact has submitted their upload form —
 * i.e. lead status is AWAITING_PHOTOS and hw_lead_substatus contains AWPH_RECEIVED.
 * Clears automatically once the lead status advances past AWAITING_PHOTOS.
 */
export function isPhotosReceived(
  leadStatus: string | undefined | null,
  hwSubstatus: string | undefined | null,
): boolean {
  return (
    leadStatus === 'AWAITING_PHOTOS' &&
    typeof hwSubstatus === 'string' &&
    hwSubstatus.includes('AWPH_RECEIVED')
  );
}

export interface PhotosReceivedBadgeProps {
  leadStatus: string | undefined | null;
  hwSubstatus: string | undefined | null;
}

/**
 * <PhotosReceivedBadge /> — renders a small green pill when the customer has
 * submitted their photos and info (AWAITING_PHOTOS + AWPH_RECEIVED substatus).
 * Renders nothing when the condition is not met.
 */
export function PhotosReceivedBadge({ leadStatus, hwSubstatus }: PhotosReceivedBadgeProps) {
  if (!isPhotosReceived(leadStatus, hwSubstatus)) return null;

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
        background: '#dcfce7', // hex-color-ok: pre-existing raw hex
        color: '#166534', // hex-color-ok: pre-existing raw hex
        border: '1px solid #bbf7d0',
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
