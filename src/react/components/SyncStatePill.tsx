import React from 'react';
import type { QueueStatus } from '../lib/offlineQueue';

/**
 * Per-item offline sync badge — shows whether a queued write is waiting to
 * replay (Pending sync), currently uploading (Syncing…), failed after its
 * retries (Sync failed) or has landed (Synced).
 *
 * Shared by the design-visit list and the customer-info submissions rail so a
 * queued change carries the same visual treatment wherever it appears. The
 * spinner uses the global `dv-sync-spin` keyframe (defined in
 * `public/app-styles.css`).
 */

const SYNC_PILL: Record<QueueStatus, { label: string; bg: string; fg: string }> = {
  pending: { label: 'Pending sync',  bg: 'var(--stage-workshop-light)', fg: 'var(--stage-workshop-text)' },
  syncing: { label: 'Syncing…',      bg: 'var(--stage-order-light)',    fg: 'var(--stage-order-text)'    },
  failed:  { label: 'Sync failed',   bg: 'var(--status-error-bg)',      fg: 'var(--status-error-text)'   },
  synced:  { label: 'Synced',        bg: 'var(--stage-packing-light)',  fg: 'var(--stage-packing-text)'  },
};

export function SyncStatePill({
  status,
  testId = 'dv-sync-pill',
}: {
  status: QueueStatus;
  testId?: string;
}) {
  const s = SYNC_PILL[status] ?? SYNC_PILL.pending;
  return (
    <span
      data-testid={testId}
      style={{
        fontSize: '0.7rem', background: s.bg, color: s.fg, borderRadius: 4,
        padding: '1px 6px', fontWeight: 600, whiteSpace: 'nowrap',
        display: 'inline-flex', alignItems: 'center', gap: 4,
      }}
    >
      {status === 'syncing' && (
        <span
          aria-hidden
          style={{
            width: 8, height: 8, borderRadius: '50%',
            border: '1.5px solid currentColor', borderTopColor: 'transparent',
            display: 'inline-block', animation: 'dv-sync-spin 0.8s linear infinite',
          }}
        />
      )}
      {s.label}
    </span>
  );
}
