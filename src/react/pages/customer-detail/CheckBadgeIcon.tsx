import React from 'react';

/** White stroke used on the check SVG inside completed-stage badges. */
export const SVG_ICON_STROKE = '#fff';

/**
 * Small check-mark icon rendered inside completed lead-status badges.
 * Mirrors the visual convention of MUI icons (aria-hidden, fixed size).
 */
export function CheckBadgeIcon() {
  return (
    <svg
      width="11"
      height="9"
      fill="none"
      stroke={SVG_ICON_STROKE}
      viewBox="0 0 12 10"
      aria-hidden="true"
    >
      <polyline
        points="1,5 4.5,8.5 11,1"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
