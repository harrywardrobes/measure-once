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
 * Returns the two plain-text summary strings used by the customer-card
 * activity row.  Accepts a pre-formatted relative-time string so the helper
 * stays pure and testable.
 *
 * - line1: attempt count + method breakdown  (e.g. "3 attempts · 2 calls, 1 email")
 * - line2: last-contact verb + time ago       (e.g. "Last called 2 hours ago")
 */
export function formatActivityRow(
  lastAttempt: NonNullable<LastAttempt>,
  timeAgo: string,
): { line1: string; line2: string } {
  const mc = lastAttempt.methodCounts || {};
  const breakdown = breakdownString(mc);

  const line1 = [
    `${lastAttempt.count} ${lastAttempt.count === 1 ? 'attempt' : 'attempts'}`,
    ...(breakdown ? [breakdown] : []),
  ].join(' · ');

  const lastVerb =
    lastAttempt.method === 'call'      ? 'Last called'
    : lastAttempt.method === 'email'   ? 'Last emailed'
    : lastAttempt.method === 'whatsapp' ? "Last WhatsApp'd"
    : 'Last contacted';

  const line2 = `${lastVerb} ${timeAgo}`;

  return { line1, line2 };
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
