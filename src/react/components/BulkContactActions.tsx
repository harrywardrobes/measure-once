import React, { useCallback, useState } from 'react';
import { Alert, Box, Button, Stack } from '@mui/material';
import { useToast } from '../contexts/ToastContext';
import type { ContactSyncState } from '../hooks/useOfflineContactEntries';

/**
 * Bulk **Retry all** / **Discard all** controls for the customers list.
 * Renders only when 2+ distinct contacts have `failed` contact-sync writes,
 * so a field user recovering from a long offline stint can clear the whole
 * backlog at once instead of card-by-card.
 *
 * - **Retry all** re-queues every failed entry (`retryEntry`) with no extra
 *   confirmation — the periodic flush picks them up.
 * - **Discard all** first offers the same PDF safety-net download used by the
 *   design-visit bulk discard, then gates the permanent removal behind
 *   `window.showBottomConfirm`.
 *
 * Mirrors `BulkVisitActions` in `DesignVisitsList.tsx`. The queue modules
 * (and `idb`) are **dynamically imported** so they never enter the
 * always-loaded bundle.
 */
export function BulkContactActions({
  contactSyncMap,
}: {
  contactSyncMap: Map<string, ContactSyncState>;
}) {
  const [busy, setBusy] = useState(false);
  const showToast = useToast();

  const failedContacts = Array.from(contactSyncMap.values()).filter(
    (s) => s.status === 'failed',
  );
  const allFailedIds = failedContacts.flatMap((s) => s.failedIds);

  const handleRetryAll = useCallback(async () => {
    if (busy || allFailedIds.length === 0) return;
    setBusy(true);
    try {
      const engine = await import('../lib/syncEngine');
      await Promise.all(allFailedIds.map((id) => engine.retryEntry(id)));
    } catch {
      /* best-effort — the periodic flush will pick them up */
    } finally {
      setBusy(false);
    }
  }, [busy, allFailedIds]);

  const handleDiscardAll = useCallback(async () => {
    if (busy || allFailedIds.length === 0) return;

    try {
      const queueMod = await import('../lib/offlineQueue');
      const idSet = new Set(allFailedIds);
      const toExport = (await queueMod.getEntries()).filter((e) => idSet.has(e.id));
      if (toExport.length) {
        const generatedAt = Date.now();
        const pdfMod = await import('../lib/failuresPdf');
        pdfMod.downloadFailuresPdf(toExport, generatedAt);
        showToast(
          `Saved ${pdfMod.failuresPdfFilename(generatedAt)} — your changes are safe to discard.`,
        );
      }
    } catch {
      /* best-effort — still let the user discard even if the PDF export failed */
    }

    const contactCount = failedContacts.length;
    const doDiscard = async () => {
      setBusy(true);
      try {
        const mod = await import('../lib/offlineQueue');
        await Promise.all(allFailedIds.map((id) => mod.removeEntry(id)));
      } catch {
        /* best-effort */
      } finally {
        setBusy(false);
      }
    };
    window.showBottomConfirm(
      `Discard all unsynced changes for ${contactCount} contact${contactCount === 1 ? '' : 's'}? The status and archive changes saved on this device will be lost — each customer\u2019s last synced details on the server stay as they are.`,
      doDiscard,
    );
  }, [busy, allFailedIds, failedContacts.length, showToast]);

  if (failedContacts.length < 2) return null;

  return (
    <Alert
      data-testid="bulk-contact-actions"
      severity="error"
      sx={{ py: '6px' }}
      action={
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
          <Button
            data-testid="bulk-contact-retry-all"
            size="small"
            variant="outlined"
            color="inherit"
            disabled={busy}
            onClick={handleRetryAll}
            sx={{ fontSize: '0.72rem', py: '2px', minWidth: 0, whiteSpace: 'nowrap' }}
          >
            Retry all
          </Button>
          <Button
            data-testid="bulk-contact-discard-all"
            size="small"
            variant="outlined"
            color="error"
            disabled={busy}
            onClick={handleDiscardAll}
            sx={{ fontSize: '0.72rem', py: '2px', minWidth: 0, whiteSpace: 'nowrap' }}
          >
            Discard all
          </Button>
        </Stack>
      }
    >
      <Box component="span" sx={{ fontSize: '0.8rem' }}>
        {failedContacts.length} contacts have changes that couldn&apos;t sync
      </Box>
    </Alert>
  );
}
