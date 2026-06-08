import React, { useCallback, useState } from 'react';
import { Box, Button, Stack, Typography } from '@mui/material';

/**
 * Inline Retry / Discard strip for a contact card whose queued status/archive
 * edit has exhausted its sync retries (Offline Phase 2 — customers list).
 *
 * Task #2297 added a "Sync failed" badge but no way to act on a stuck contact
 * change from the customers list. This strip surfaces below the card (outside
 * the navigation `CardActionArea`, so no interactive element is nested inside
 * the anchor) and lets a field user clear the change without leaving the list:
 *
 * - **Retry** re-queues every `failed` entry (`syncEngine.retryEntry`) and lets
 *   the periodic flush pick them up. Acts only on the `failed` ids, so any
 *   still-pending writes for the same contact are left untouched.
 * - **Discard** drops those entries from the outbox (`offlineQueue.removeEntry`)
 *   after a `window.showBottomConfirm` safety check — the discarded device-local
 *   change is lost; the server's last synced copy stays as-is.
 *
 * The badge clears on its own once the action completes: both modules notify the
 * queue's pub/sub, which `useOfflineContactEntries` is subscribed to. The queue
 * (and its `idb` dependency) is **dynamically imported** so it never enters the
 * always-loaded main bundle. Mirrors `PendingEditActions` in DesignVisitsList.
 */
export function ContactSyncRecovery({ failedIds }: { failedIds: number[] }) {
  const [busy, setBusy] = useState(false);

  const handleRetry = useCallback(async () => {
    if (busy || failedIds.length === 0) return;
    setBusy(true);
    try {
      const engine = await import('../lib/syncEngine');
      await Promise.all(failedIds.map((id) => engine.retryEntry(id)));
    } catch {
      /* best-effort — the periodic flush will pick it up */
    } finally {
      setBusy(false);
    }
  }, [busy, failedIds]);

  const handleDiscard = useCallback(() => {
    if (busy || failedIds.length === 0) return;
    const doDiscard = async () => {
      setBusy(true);
      try {
        const mod = await import('../lib/offlineQueue');
        await Promise.all(failedIds.map((id) => mod.removeEntry(id)));
      } catch {
        /* best-effort */
      } finally {
        setBusy(false);
      }
    };
    window.showBottomConfirm(
      'Discard this unsynced change? The status/archive change saved on this device will be lost — the customer\u2019s last synced details on the server stay as they are.',
      doDiscard,
    );
  }, [busy, failedIds]);

  if (failedIds.length === 0) return null;

  return (
    <Box
      data-testid="contact-sync-recovery"
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 1,
        px: 2,
        py: '9px',
        bgcolor: 'var(--status-error-bg)',
        borderTop: '1px solid',
        borderColor: 'divider',
      }}
    >
      <Typography sx={{ color: 'var(--status-error-text)', fontWeight: 600, fontSize: '0.75rem', minWidth: 0 }}>
        Couldn’t sync this change
      </Typography>
      <Stack direction="row" spacing={0.75} sx={{ flexShrink: 0 }}>
        <Button
          data-testid="contact-sync-retry"
          size="small"
          variant="outlined"
          color="inherit"
          disabled={busy}
          onClick={handleRetry}
          sx={{ fontSize: '0.72rem', py: '2px', minWidth: 0 }}
        >
          Retry
        </Button>
        <Button
          data-testid="contact-sync-discard"
          size="small"
          variant="outlined"
          color="error"
          disabled={busy}
          onClick={handleDiscard}
          sx={{ fontSize: '0.72rem', py: '2px', minWidth: 0 }}
        >
          Discard
        </Button>
      </Stack>
    </Box>
  );
}
