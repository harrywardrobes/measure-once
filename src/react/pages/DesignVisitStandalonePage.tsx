import React, { Suspense, useCallback, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import { CustomerSelectStep, type SelectedCustomer } from '../components/CustomerSelectStep';
import { cacheRecords } from '../lib/offlineDb';
import { DV_STANDALONE_SELECTION_KEY } from '../constants/localStorageKeys';
import type {
  DesignVisitWizardHandler,
  DesignVisitWizardCtx,
} from '../components/DesignVisitWizard';

const DesignVisitWizard = React.lazy(() =>
  import('../components/DesignVisitWizard').then((m) => ({ default: m.DesignVisitWizard })),
);

/**
 * Standalone, offline-capable design-visit page (`/design-visit`).
 *
 * A field tool: the designer picks an existing customer or enters a brand-new
 * one, then completes the full design-visit wizard on-device. The visit is
 * queued and synced to the server when back online — the server then performs
 * the HubSpot / QuickBooks / sign-off-email side effects, exactly as the in-app
 * card flow does (including creating/matching a brand-new customer's contact).
 *
 * To match the in-app flow's CRM effects (lead-status progression, etc.) we load
 * the configured `start_design_visit` card-action handler and hand its config to
 * the wizard. When none is configured we fall back to a minimal config.
 */
const FALLBACK_HANDLER: DesignVisitWizardHandler = {
  type: 'start_design_visit',
  config: { defaultDurationMin: 90 },
};

interface CardActionHandlerRow {
  id: number;
  type: string;
  config?: Record<string, unknown>;
}

/** Restore an in-progress customer selection (survives a mid-visit refresh). */
function loadPersistedSelection(): SelectedCustomer | null {
  try {
    const raw = localStorage.getItem(DV_STANDALONE_SELECTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SelectedCustomer;
    if (parsed?.mode === 'existing' && parsed.contactId) return parsed;
    if (parsed?.mode === 'new' && parsed.newContact?.name && parsed.clientSubmissionId) return parsed;
  } catch { /* ignore malformed */ }
  return null;
}

/**
 * Prime the offline read-caches while online so the wizard's reference-data
 * fetches (catalogues, questionnaire, terms, handler config) and the customer
 * picker all resolve from cache once the device drops offline. Best-effort —
 * any failure simply means a colder cache, never a broken page.
 */
async function warmOfflineCaches(): Promise<void> {
  const refUrls = [
    '/api/catalog/handles',
    '/api/catalog/ranges',
    '/api/catalog/doors',
    '/api/visit-questions?applies_to=design',
    '/api/design-visit-terms',
    '/api/card-action-handlers',
  ];
  await Promise.allSettled(
    refUrls.map((u) => fetch(u, { headers: { Accept: 'application/json' } })),
  );

  // Warm the customer list into both the SW cache and the IndexedDB `customers`
  // store the offline picker reads.
  try {
    const r = await fetch('/api/contacts-all?limit=200&sort=newest', {
      headers: { Accept: 'application/json' },
    });
    if (r.ok) {
      const d = (await r.json()) as { results?: Array<{ id: string }> };
      if (Array.isArray(d.results) && d.results.length) {
        await cacheRecords('customers', d.results);
      }
    }
  } catch {
    /* best-effort */
  }
}

function toCtx(sel: SelectedCustomer): DesignVisitWizardCtx {
  if (sel.mode === 'new') {
    return {
      newContact: sel.newContact,
      clientSubmissionId: sel.clientSubmissionId,
      contactName: sel.newContact.name,
      contactEmail: sel.newContact.email,
      contactPhone: sel.newContact.phone,
    };
  }
  return {
    contactId: sel.contactId,
    contactName: sel.contactName,
    contactEmail: sel.contactEmail,
    contactPhone: sel.contactPhone,
  };
}

export function DesignVisitStandalonePage() {
  const [selected, setSelected] = useState<SelectedCustomer | null>(loadPersistedSelection);
  const [handler, setHandler] = useState<DesignVisitWizardHandler | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/card-action-handlers', { headers: { Accept: 'application/json' } });
        if (r.ok) {
          const rows = (await r.json()) as CardActionHandlerRow[];
          const dv = Array.isArray(rows) ? rows.find((h) => h.type === 'start_design_visit') : null;
          if (!cancelled && dv) setHandler({ id: dv.id, type: dv.type, config: dv.config });
        }
      } catch {
        /* fall back to FALLBACK_HANDLER */
      }
      void warmOfflineCaches();
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const choose = useCallback((sel: SelectedCustomer) => {
    // Persist so a mid-visit refresh / app restart re-opens the wizard against
    // the same draft key (the wizard restores its own step/room/photo draft).
    try { localStorage.setItem(DV_STANDALONE_SELECTION_KEY, JSON.stringify(sel)); } catch { /* ignore */ }
    setSelected(sel);
  }, []);

  const reset = useCallback(() => {
    try { localStorage.removeItem(DV_STANDALONE_SELECTION_KEY); } catch { /* ignore */ }
    setSelected(null);
  }, []);

  return (
    <Box sx={{ maxWidth: 640, width: '100%', mx: 'auto', px: 2, pb: 6, boxSizing: 'border-box' }}>
      {!selected ? (
        <CustomerSelectStep onSelect={choose} />
      ) : (
        <Suspense
          fallback={
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
              <CircularProgress />
            </Box>
          }
        >
          <DesignVisitWizard
            handler={handler ?? FALLBACK_HANDLER}
            ctx={toCtx(selected)}
            onClose={reset}
          />
        </Suspense>
      )}
    </Box>
  );
}

export default DesignVisitStandalonePage;
