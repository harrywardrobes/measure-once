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
 *    has succeeded (and the cache is still fresh), subsequent calls are no-ops.
 *  - `refresh()` forces a new fetch regardless of current state.
 *  - No fetch fires automatically on import; consumers must call
 *    `triggerLoad()` (or `refresh()`) to initiate the first load.
 *
 * Cross-tab sync:
 *  - After a successful fetch, a `BroadcastChannel` message is posted so that
 *    other open tabs can re-fetch and stay current.
 *  - BroadcastChannel messages are never received by the tab that sent them,
 *    so there is no risk of an infinite refresh loop.
 *  - A 5-minute TTL also acts as a safety net: `triggerLoad()` treats data
 *    older than CACHE_TTL_MS as expired and issues a background re-fetch even
 *    without an explicit cross-tab signal.
 *
 * Tab-visibility refresh:
 *  - A `visibilitychange` listener is registered on first `triggerLoad()` call.
 *  - When the tab regains visibility and the cache is stale (> CACHE_TTL_MS),
 *    a silent background re-fetch fires: no loading spinner is shown and the
 *    existing data stays visible while the update runs in the background.
 *    Errors during silent re-fetches are swallowed so cached data is preserved.
 */

import type { InvoiceSummary } from '../components/InvoiceDetailDrawer';

const CACHE_TTL_MS = 5 * 60 * 1000;
const BC_CHANNEL_NAME = 'qb-invoices-sync';
const BC_MSG_REFRESHED = 'refreshed';

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
let _lastFetchedAt: number | null = null;
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

let _bc: BroadcastChannel | null = null;

function _getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!_bc) {
    _bc = new BroadcastChannel(BC_CHANNEL_NAME);
    _bc.onmessage = (ev: MessageEvent<{ type: string }>) => {
      if (ev.data?.type === BC_MSG_REFRESHED && !_state.loading) {
        void _doFetch();
      }
    };
  }
  return _bc;
}

let _visibilityListenerAttached = false;

function _initVisibilityListener(): void {
  if (_visibilityListenerAttached || typeof document === 'undefined') return;
  _visibilityListenerAttached = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (_state.loading) return;
    if (_state.loaded && !_isCacheExpired()) return;
    void _doFetch(true);
  });
}

/**
 * Execute a fetch.
 *
 * @param silent - When `true` and data is already loaded, the fetch runs
 *   without setting `loading: true`, so the UI retains its current view.
 *   Errors during a silent fetch are swallowed to preserve cached data.
 *   Use this for background tab-restore refreshes.
 *   When `false` (default), the normal loading-state transitions apply.
 *
 * Returns `true` when the fetch completed successfully (invoices loaded or
 * 403 no-access).
 */
async function _doFetch(silent = false): Promise<boolean> {
  const alreadyLoaded = _state.loaded;
  if (!silent || !alreadyLoaded) {
    _setState({ loading: true, loadError: false, error: null, errorCode: null });
  }

  try {
    const statusRes = await fetch('/api/quickbooks/status').catch(() => null);
    const status: { connected?: boolean; company?: string } = statusRes
      ? await statusRes.json().catch(() => ({ connected: false }))
      : { connected: false };

    if (!status.connected) {
      _setState({ connected: false, statusKnown: true, loading: false });
      return true;
    }

    _setState({ connected: true, company: status.company || null, statusKnown: true });

    const invRes = await fetch('/api/quickbooks/invoices');

    if (invRes.status === 403) {
      _setState({ loading: false, loaded: true, invoices: [] });
      _lastFetchedAt = Date.now();
      return true;
    }

    const data = await invRes.json().catch(() => ({})) as {
      invoices?: InvoiceSummary[];
      error?: string;
      code?: string;
    };

    if (!invRes.ok || data.error) {
      if (silent && alreadyLoaded) {
        return false;
      }
      _setState({
        loading: false,
        loadError: true,
        error: data.error || `Server error ${invRes.status}`,
        errorCode: data.code || null,
      });
      return false;
    }

    _setState({ loading: false, loaded: true, invoices: data.invoices || [] });
    _lastFetchedAt = Date.now();
    return true;
  } catch (e: unknown) {
    if (silent && alreadyLoaded) {
      return false;
    }
    _setState({
      loading: false,
      loadError: true,
      error: (e instanceof Error ? e.message : null) || 'Failed to load invoices',
      errorCode: null,
    });
    return false;
  }
}

function _isCacheExpired(): boolean {
  if (_lastFetchedAt === null) return true;
  return Date.now() - _lastFetchedAt > CACHE_TTL_MS;
}

/**
 * Initiate a fetch if one has not already been started or succeeded.
 * Safe to call from multiple components — only one fetch will fire.
 *
 * Note: if a previous fetch failed (`loadError: true`), this will retry.
 * Only an in-progress fetch (`loading: true`) or a fresh successful one
 * (`loaded: true` and cache not expired) prevents a new request.
 *
 * Initialises the BroadcastChannel listener and `visibilitychange` listener
 * on first call so that cross-tab invalidation and tab-restore freshness
 * checks are active whenever any component uses the store.
 */
export function triggerLoad(): void {
  _getChannel();
  _initVisibilityListener();
  if (_state.loading) return;
  if (_state.loaded && !_isCacheExpired()) return;
  void _doFetch();
}

/**
 * Force a fresh fetch regardless of current cache state.
 * Notifies other open tabs via BroadcastChannel only when the fetch succeeds,
 * so transient network errors don't trigger unnecessary re-fetches elsewhere.
 */
export function refresh(): void {
  _getChannel();
  void _doFetch().then((succeeded) => {
    if (succeeded) _getChannel()?.postMessage({ type: BC_MSG_REFRESHED });
  });
}

/**
 * Reset the store to its initial state without triggering a new fetch.
 * Call this after QuickBooks is disconnected so cached invoice data is
 * cleared immediately — before any subsequent `triggerLoad()` or `refresh()`.
 */
export function reset(): void {
  _setState({ ...INITIAL_STATE });
}

// ── Cross-tab connect / disconnect listeners ───────────────────────────────────
// When any tab broadcasts { type: 'qb-disconnected' }, all other tabs reset
// their invoice cache immediately.
// When any tab broadcasts { type: 'qb-connected' }, all other tabs refresh so
// they show data from the newly connected account instead of stale data.

const QB_CHANNEL = 'qb-invoices';

export function broadcastDisconnect(): void {
  try {
    const ch = new BroadcastChannel(QB_CHANNEL);
    ch.postMessage({ type: 'qb-disconnected' });
    ch.close();
  } catch { /* BroadcastChannel not supported — no-op */ }
}

export function broadcastConnect(): void {
  try {
    const ch = new BroadcastChannel(QB_CHANNEL);
    ch.postMessage({ type: 'qb-connected' });
    ch.close();
  } catch { /* BroadcastChannel not supported — no-op */ }
}

(function _initCrossTabListener() {
  try {
    const ch = new BroadcastChannel(QB_CHANNEL);
    ch.addEventListener('message', (ev: MessageEvent) => {
      if (ev.data?.type === 'qb-disconnected') {
        reset();
      } else if (ev.data?.type === 'qb-connected') {
        refresh();
      }
    });
    // Intentionally never closed — lives for the lifetime of the page.
  } catch { /* BroadcastChannel not supported — no-op */ }
})();
