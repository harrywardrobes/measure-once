import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { formatDate } from './formatters';

export type LastAttempt = {
  at: string;
  by: string | null;
  count: number;
  method: string | null;
  methodCounts?: Record<string, number> | null;
} | null;

const METHOD_ORDER = ['call', 'email', 'whatsapp'];
const METHOD_LABELS: Record<string, (n: number) => string> = {
  call:     (n) => `${n} ${n === 1 ? 'call' : 'calls'}`,
  email:    (n) => `${n} ${n === 1 ? 'email' : 'emails'}`,
  whatsapp: (n) => `${n} WhatsApp`,
};

function breakdownString(mc: Record<string, number>): string {
  return [
    ...METHOD_ORDER.filter((m) => (mc[m] ?? 0) > 0).map((m) => METHOD_LABELS[m](mc[m])),
    ...Object.keys(mc).filter((m) => !METHOD_ORDER.includes(m) && mc[m] > 0).map((m) => `${mc[m]} ${m}`),
  ].join(', ');
}

/**
 * Builds the rich tooltip content for an activity counter badge.
 *
 * Matches the display in CustomerDetailHeader — shows formatted date/time,
 * attributed author, attempt count, and method breakdown when a `lastAttempt`
 * record is available. Falls back to a formatted date string when only a
 * legacy `notes_last_contacted` field is present, or to a static placeholder.
 */
export function buildActivityTooltipContent(
  lastAttempt: LastAttempt,
  fallbackDate?: string | null,
): React.ReactNode {
  if (lastAttempt?.at) {
    const mc = lastAttempt.methodCounts || {};
    const breakdown = breakdownString(mc);

    const methodLabel =
      lastAttempt.method === 'call'       ? 'Call'
      : lastAttempt.method === 'email'    ? 'Email'
      : lastAttempt.method === 'whatsapp' ? 'WhatsApp'
      : lastAttempt.method               ? lastAttempt.method
      : null;

    return (
      <Box sx={{ py: 0.25 }}>
        <Typography variant="caption" sx={{ display: 'block', fontWeight: 600, lineHeight: 1.5 }}>
          {formatDate(lastAttempt.at)}
        </Typography>
        {lastAttempt.by && (
          <Typography variant="caption" sx={{ display: 'block', lineHeight: 1.5, opacity: 0.85 }}>
            {`by ${lastAttempt.by}`}
          </Typography>
        )}
        <Typography variant="caption" sx={{ display: 'block', lineHeight: 1.5, opacity: 0.85 }}>
          {[
            lastAttempt.count > 0
              ? `${lastAttempt.count} ${lastAttempt.count === 1 ? 'attempt' : 'attempts'}`
              : null,
            breakdown || methodLabel,
          ].filter(Boolean).join(' · ')}
        </Typography>
      </Box>
    );
  }
  if (fallbackDate) {
    return formatDate(fallbackDate);
  }
  return 'Time since last contact attempt';
}
