import { useSyncExternalStore } from 'react';
import {
  getState,
  subscribe,
  triggerLoad,
  refresh,
} from '../lib/qbInvoicesStore';
import type { QBInvoicesState } from '../lib/qbInvoicesStore';

export type { QBInvoicesState };

export interface QBInvoicesResult extends QBInvoicesState {
  refresh: () => void;
  triggerLoad: () => void;
}

/**
 * Subscribe to the shared QB invoices store.
 *
 * This hook does NOT trigger a fetch on its own — call `triggerLoad()` from
 * the returned object (or import it directly from qbInvoicesStore) to initiate
 * a load. This keeps CommandPalette from firing network requests on every page
 * load before the palette has ever been opened.
 *
 * Pages that always need invoice data (invoices page, home, customers, etc.)
 * should call `triggerLoad()` inside a `useEffect` on mount.
 */
export function useQBInvoices(): QBInvoicesResult {
  const state = useSyncExternalStore(subscribe, getState, getState);
  return { ...state, refresh, triggerLoad };
}
