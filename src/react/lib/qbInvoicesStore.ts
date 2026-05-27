/**
 * Module-level singleton store for QuickBooks invoice data.
 *
 * All React island roots share the same JS bundle, so module-level variables
 * are shared across every `createRoot` instance on the page. This lets
 * CommandPalette, StandaloneInvoicesPage, HomePage, etc. all consume the same
 * cached data without each issuing independent network requests.
 *
 * Fetch lifecycle:
 *  - `triggerLoad()` is idempotent — if a fetch is already in progress or
 *    has succeeded, subsequent calls are no-ops.
 *  - `refresh()` forces a new fetch regardless of current state.
 *  - No fetch fires automatically on import; consumers must call
 *    `triggerLoad()` (or `refresh()`) to initiate the first load.
 */

import type { InvoiceSummary } from '../components/InvoiceDetailDrawer';

export interface QBInvoicesState {
  connected: boolean;
  statusKnown: boolean;
  loading: boolean;
  loaded: boolean;
  loadError: boolean;
  error: string | null;
  errorCode: string | null;
  company: string | null;
  invoices: InvoiceSummary[];
}

const INITIAL_STATE: QBInvoicesState = {
  connected: false,
  statusKnown: false,
  loading: false,
  loaded: false,
  loadError: false,
  error: null,
  errorCode: null,
  company: null,
  invoices: [],
};

let _state: QBInvoicesState = { ...INITIAL_STATE };
const _listeners = new Set<() => void>();

function _setState(update: Partial<QBInvoicesState> | ((prev: QBInvoicesState) => Partial<QBInvoicesState>)) {
  const patch = typeof update === 'function' ? update(_state) : update;
  _state = { ..._state, ...patch };
  for (const l of _listeners) l();
}

export function getState(): QBInvoicesState {
  return _state;
}

export function subscribe(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

async function _doFetch(): Promise<void> {
  _setState({ loading: true, loadError: false, error: null, errorCode: null });

  try {
    const statusRes = await fetch('/api/quickbooks/status').catch(() => null);
    const status: { connected?: boolean; company?: string } = statusRes
      ? await statusRes.json().catch(() => ({ connected: false }))
      : { connected: false };

    if (!status.connected) {
      _setState({ connected: false, statusKnown: true, loading: false });
      return;
    }

    _setState({ connected: true, company: status.company || null, statusKnown: true });

    const invRes = await fetch('/api/quickbooks/invoices');

    if (invRes.status === 403) {
      _setState({ loading: false, loaded: true, invoices: [] });
      return;
    }

    const data = await invRes.json().catch(() => ({})) as {
      invoices?: InvoiceSummary[];
      error?: string;
      code?: string;
    };

    if (!invRes.ok || data.error) {
      _setState({
        loading: false,
        loadError: true,
        error: data.error || `Server error ${invRes.status}`,
        errorCode: data.code || null,
      });
      return;
    }

    _setState({ loading: false, loaded: true, invoices: data.invoices || [] });
  } catch (e: unknown) {
    _setState({
      loading: false,
      loadError: true,
      error: (e instanceof Error ? e.message : null) || 'Failed to load invoices',
      errorCode: null,
    });
  }
}

/**
 * Initiate a fetch if one has not already been started or succeeded.
 * Safe to call from multiple components — only one fetch will fire.
 *
 * Note: if a previous fetch failed (`loadError: true`), this will retry.
 * Only an in-progress fetch (`loading: true`) or a successful one
 * (`loaded: true`) prevents a new request.
 */
export function triggerLoad(): void {
  if (_state.loading || _state.loaded) return;
  void _doFetch();
}

/**
 * Force a fresh fetch regardless of current cache state.
 */
export function refresh(): void {
  void _doFetch();
}

/**
 * Reset the store to its initial state without triggering a new fetch.
 * Call this after QuickBooks is disconnected so cached invoice data is
 * cleared immediately — before any subsequent `triggerLoad()` or `refresh()`.
 */
export function reset(): void {
  _setState({ ...INITIAL_STATE });
}
