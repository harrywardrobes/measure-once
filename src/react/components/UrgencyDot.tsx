import React from 'react';
import Box from '@mui/material/Box';

export type Urgency = 'red' | 'orange' | null;

export interface UrgencyDotProps {
  urgency: Urgency;
}

/**
 * UrgencyDot — a small coloured circle indicating task urgency.
 *
 * - `red`    → urgent, task due within 1 working day
 * - `orange` → task due within 2 working days
 * - `null`   → renders nothing
 */
export function UrgencyDot({ urgency }: UrgencyDotProps) {
  if (!urgency) return null;
  const bg = urgency === 'red' ? '#dc2626' : '#f59e0b';
  const title =
    urgency === 'red' ? 'Urgent: task due within 1 working day' : 'Task due within 2 working days';
  return (
    <Box
      component="span"
      title={title}
      aria-label={urgency === 'red' ? 'Urgent' : 'Task due soon'}
      sx={{
        display: 'inline-block',
        width: 9,
        height: 9,
        borderRadius: '50%',
        bgcolor: bg,
        mr: 0.75,
        verticalAlign: 'middle',
        flexShrink: 0,
      }}
    />
  );
}
