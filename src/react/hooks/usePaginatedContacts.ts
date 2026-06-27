import React from 'react';
import { cacheRecord, cacheRecords, readRecord, readRecords, getMeta, setMeta } from '../lib/offlineDb';
import { CONTACTS_LAST_SYNC_META_KEY, PRIORITY_ACTIVE_DAYS_META_KEY } from '../constants/localStorageKeys';

export { CONTACTS_LAST_SYNC_META_KEY };

export type PaginatedContact = {
  id: string;
  properties?: {
    firstname?: string;
    lastname?: string;
    email?: string;
    phone?: string;
    hs_lead_status?: string;
    customer_number?: string;
    createdate?: string;
    /** HubSpot ISO timestamp of the last time this record was modified; used by the priority-active filter. */
    lastmodifieddate?: string;
    /** JSON-encoded workflow rooms; used for offline stage filtering. */
    measure_once_rooms?: string;
    /** HubSpot timestamp (ISO string) of the last time this contact was contacted. */
    notes_last_contacted?: string;
    /** Set to 'true' on HubSpot test contacts; excluded from customer-facing views. */
    hw_test_user?: string;
  };
};

type ContactsResponse = {
  results?: PaginatedContact[];
  page?: number;
  totalPages?: number;
  total?: number;
  /** Admin-configured priority-sort active window in days (default 60). */
  priorityActiveDays?: number;
};

export type UsePaginatedContactsParams = {
  initialPage: number;
  leadStatus: string;
  stage: string;
  sortBy: string;
  search: string;
  showArchived: boolean;
  showExcluded?: boolean;
  /** Keys of statuses that are excluded_from_sales; used by the offline filter. */
  excludedStatusKeys?: Set<string>;
  /** Maps each hs_lead_status key to its normalised stage string (lowercase, no underscores); used by the offline stage filter. */
  statusStageMap?: Map<string, string>;
  refreshNonce?: number;
  staleAfterDays?: number;
  pageSize?: number;
  /**
   * When true (the default), contacts with no lead status are pinned to the
   * top of the list ahead of the active sort order, unless a specific lead
   * status filter is already applied (in which case pinning has no effect).
   */
  priorityFirst?: boolean;
  /**
   * Controls the sort order used by "Priority first".
   * - 'last_contacted' (default): sort by notes_last_contacted ascending —
   *   never-contacted contacts first, most-recently-contacted last.
   *   Note: the offline path only has notes_last_contacted (the per-page
   *   lastAttempt data is not available at sort time); server-side sorts use
   *   the full contact_attempt_log coalesced with notes_last_contacted.
   * - 'newest': legacy behaviour — pin no-status contacts, then newest-created-first.
   */
  prioritySortMode?: 'last_contacted' | 'newest';
};

export type UsePaginatedContactsResult = {
  contacts: PaginatedContact[];
  total: number;
  totalPages: number;
  loading: boolean;
  error: string | null;
  contactsStale: boolean;
  /** True when the list is rendered from the offline IndexedDB cache because the
   *  network fetch failed (e.g. the device is offline). */
  fromCache: boolean;
  /** Epoch-ms time of the last successful contacts fetch, or null if unknown.
   *  Used to render a "Last synced at …" indicator when offline. */
  lastSyncAt: number | null;
  /** Admin-configured active-window size in days used by the priority filter.
   *  Hydrated from IndexedDB on mount so offline renders use the same value. */
  priorityActiveDays: number;
  page: number;
  setPage: (p: number) => void;
  /**
   * Optimistically patch a single contact's properties in the local list and
   * persist the change to the offline IndexedDB cache.  The in-memory update
   * is immediate; the cache write is fire-and-forget so offline renders also
   * reflect the latest value without waiting for the next full fetch.
   */
  patchContact: (contactId: string, props: Record<string, string | undefined>) => void;
};

export type UsePaginatedContactsOptions = {
  onFetchSuccess?: () => void;
};

export const PAGINATED_CONTACTS_PAGE_LIMIT = 25;

type OfflineFilterParams = {
  leadStatus: string;
  stage: string;
  sortBy: string;
  search: string;
  showArchived: boolean;
  showExcluded?: boolean;
  excludedStatusKeys?: Set<string>;
  /** Maps each hs_lead_status key to its normalised stage string (lowercase, no underscores). */
  statusStageMap?: Map<string, string>;
  page: number;
  limit: number;
  priorityFirst?: boolean;
  prioritySortMode?: 'last_contacted' | 'newest';
  /** Admin-configured priority-sort active window in days (default 60). */
  priorityActiveDays?: number;
};

function offlineComparator(sort: string): (a: PaginatedContact, b: PaginatedContact) => number {
  switch (sort) {
    case 'oldest':
      return (a, b) => (a.properties?.createdate || '').localeCompare(b.properties?.createdate || '');
    case 'name-asc':
      return (a, b) => (a.properties?.lastname || '').localeCompare(b.properties?.lastname || '');
    case 'name-desc':
      return (a, b) => (b.properties?.lastname || '').localeCompare(a.properties?.lastname || '');
    case 'priority':
      // Offline: falls back to newest comparator; priority-mode-aware sorting
      // is handled by effectiveComparator in filterSortPaginateCachedContacts.
      return (a, b) => (b.properties?.createdate || '').localeCompare(a.properties?.createdate || '');
    case 'newest':
    default:
      return (a, b) => (b.properties?.createdate || '').localeCompare(a.properties?.createdate || '');
  }
}

function matchesOfflineStage(c: PaginatedContact, stage: string, statusStageMap: Map<string, string>): boolean {
  const ls = c.properties?.hs_lead_status || '';
  const contactStage = statusStageMap.get(ls) || '';
  const normalizedStage = stage.toLowerCase().replace(/_/g, '');
  return !!contactStage && contactStage === normalizedStage;
}

/**
 * When sorting "Priority first" with no search query, only contacts modified
 * within this many days are shown.  Must be kept in sync with the server-side
 * constant of the same name in the `/api/contacts-all` handler in server.js.
 */
export const PRIORITY_ACTIVE_DAYS = 60;

/**
 * Apply the active search box, lead-status / stage filters, sort order, and
 * pagination to a set of cached customer records client-side. Mirrors the
 * server-side logic in `/api/contacts-all` so the offline experience matches
 * the online one. (Staleness filter is a server-only concern and omitted here;
 * hw_test_user exclusion is applied below to match server behaviour.)
 */
export function filterSortPaginateCachedContacts(
  cached: PaginatedContact[],
  params: OfflineFilterParams,
): { results: PaginatedContact[]; total: number; totalPages: number; page: number } {
  const { leadStatus, stage, sortBy, search, showArchived, showExcluded, excludedStatusKeys, statusStageMap, limit, priorityFirst, prioritySortMode } = params;
  let list = cached;

  // Always exclude HubSpot test users from the customer-facing view.
  list = list.filter((c) => c.properties?.hw_test_user !== 'true');

  // Mirror the server-side excluded_from_sales filter: hide excluded contacts
  // by default unless showExcluded is true or the caller is explicitly
  // filtering by a specific excluded status (same logic as the server).
  if (!showExcluded && excludedStatusKeys && excludedStatusKeys.size > 0) {
    const callerFilteringByExcluded = leadStatus && excludedStatusKeys.has(leadStatus.toUpperCase());
    if (!callerFilteringByExcluded) {
      list = list.filter((c) => {
        const ls = (c.properties?.hs_lead_status || '').toUpperCase();
        return !excludedStatusKeys.has(ls);
      });
    }
  }

  if (leadStatus) {
    if (leadStatus === '__no_status__') {
      list = list.filter((c) => !c.properties?.hs_lead_status);
    } else {
      list = list.filter((c) => c.properties?.hs_lead_status === leadStatus);
    }
  }

  if (stage) {
    list = list.filter((c) => matchesOfflineStage(c, stage, statusStageMap ?? new Map()));
  }

  const q = (search || '').trim().toLowerCase();
  if (q) {
    list = list.filter((c) => {
      const first = (c.properties?.firstname || '').toLowerCase();
      const last = (c.properties?.lastname || '').toLowerCase();
      const email = (c.properties?.email || '').toLowerCase();
      const phone = (c.properties?.phone || '').toLowerCase();
      return (
        `${first} ${last}`.includes(q) ||
        first.includes(q) ||
        last.includes(q) ||
        email.includes(q) ||
        phone.includes(q)
      );
    });
  }

  // Priority-active filter — mirrors the server-side block in /api/contacts-all.
  // When "Priority first" is active and there is no search query, drop contacts
  // whose lastmodifieddate is older than priorityActiveDays days (default 60).
  // Missing or unparseable dates pass through (same "keep" behaviour as the
  // server).  Search bypasses this filter (applied above) so older contacts
  // remain reachable when the user knows who to look for.
  if (priorityFirst && !q) {
    const activeDays = params.priorityActiveDays != null ? params.priorityActiveDays : PRIORITY_ACTIVE_DAYS;
    const cutoff = Date.now() - activeDays * 24 * 60 * 60 * 1000;
    list = list.filter((c) => {
      const raw = c.properties?.lastmodifieddate;
      if (!raw) return true;
      const ms = new Date(raw).getTime();
      return !isNaN(ms) && ms >= cutoff;
    });
  }

  const effectiveMode = prioritySortMode ?? 'last_contacted';
  let effectiveComparator: (a: PaginatedContact, b: PaginatedContact) => number;
  if (priorityFirst && !leadStatus) {
    if (effectiveMode === 'last_contacted') {
      // Sort by notes_last_contacted ascending: never-contacted (null) first.
      // Note: offline path only has notes_last_contacted; server-side also
      // coalesces with contact_attempt_log which is not available here.
      effectiveComparator = (a, b) => {
        const aLast = a.properties?.notes_last_contacted || null;
        const bLast = b.properties?.notes_last_contacted || null;
        if (!aLast && bLast) return -1;
        if (aLast && !bLast) return  1;
        if (!aLast && !bLast) {
          return (b.properties?.createdate || '').localeCompare(a.properties?.createdate || '');
        }
        const cmp = aLast!.localeCompare(bLast!);
        if (cmp !== 0) return cmp;
        return (b.properties?.createdate || '').localeCompare(a.properties?.createdate || '');
      };
    } else {
      // Legacy "newest" mode: pin no-status contacts, then newest-created-first.
      effectiveComparator = (a, b) => {
        const aNull = !a.properties?.hs_lead_status;
        const bNull = !b.properties?.hs_lead_status;
        if (aNull && !bNull) return -1;
        if (!aNull && bNull) return  1;
        return (b.properties?.createdate || '').localeCompare(a.properties?.createdate || '');
      };
    }
  } else {
    effectiveComparator = offlineComparator(sortBy);
  }
  list = [...list].sort(effectiveComparator);

  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  // Clamp the requested page to the available range so navigating offline never
  // strands the user on an empty page beyond the filtered set.
  const page = Math.min(Math.max(1, params.page), totalPages);
  const offset = (page - 1) * limit;
  const results = list.slice(offset, offset + limit);
  return { results, total, totalPages, page };
}

function humaniseError(e: Error & { code?: string }): string {
  if (e.code === 'HUBSPOT_AUTH') return 'Could not connect to HubSpot — the API token is invalid or expired.';
  if (e.code === 'HUBSPOT_RATE_LIMIT') return 'HubSpot rate limit reached. Please retry shortly.';
  if (e.code === 'HUBSPOT_ERROR') return 'Could not load contacts from HubSpot.';
  return `Failed to load contacts: ${e.message}`;
}

export function usePaginatedContacts(
  params: UsePaginatedContactsParams,
  options?: UsePaginatedContactsOptions,
): UsePaginatedContactsResult {
  const { initialPage, leadStatus, stage, sortBy, search, showArchived, showExcluded, excludedStatusKeys, statusStageMap, refreshNonce, staleAfterDays, pageSize, priorityFirst, prioritySortMode } = params;

  const onFetchSuccessRef = React.useRef(options?.onFetchSuccess);
  onFetchSuccessRef.current = options?.onFetchSuccess;

  // page is managed internally so the hook can reset it to 1 when non-page
  // filters change — fulfilling the "always resets to page 1 when any filter
  // other than page changes" contract in the task spec.
  const [page, setPage] = React.useState<number>(initialPage);

  // Track the previous filter fingerprint (everything except page) so we know
  // when to reset page to 1.
  const prevFiltersRef = React.useRef({ leadStatus, stage, sortBy, search, showArchived, showExcluded, refreshNonce, staleAfterDays, pageSize, priorityFirst, prioritySortMode });
  const filtersChanged =
    prevFiltersRef.current.leadStatus !== leadStatus ||
    prevFiltersRef.current.stage !== stage ||
    prevFiltersRef.current.sortBy !== sortBy ||
    prevFiltersRef.current.search !== search ||
    prevFiltersRef.current.showArchived !== showArchived ||
    prevFiltersRef.current.showExcluded !== showExcluded ||
    prevFiltersRef.current.refreshNonce !== refreshNonce ||
    prevFiltersRef.current.staleAfterDays !== staleAfterDays ||
    prevFiltersRef.current.pageSize !== pageSize ||
    prevFiltersRef.current.priorityFirst !== priorityFirst ||
    prevFiltersRef.current.prioritySortMode !== prioritySortMode;

  if (filtersChanged) {
    prevFiltersRef.current = { leadStatus, stage, sortBy, search, showArchived, showExcluded, refreshNonce, staleAfterDays, pageSize, priorityFirst, prioritySortMode };
    if (page !== 1) {
      // Schedule synchronous state update before render commits. This avoids a
      // stale-page fetch: by updating page in the same render pass (via the
      // render-time setState pattern), the subsequent useEffect will see page=1.
      setPage(1);
    }
  }

  // Derive the effective page for this render. If we just reset it above, use 1
  // immediately so the fetch effect fires with the correct page without waiting
  // for the next render cycle.
  const effectivePage = filtersChanged ? 1 : page;

  const [contacts, setContacts] = React.useState<PaginatedContact[]>([]);
  const [total, setTotal] = React.useState<number>(0);
  const [priorityActiveDays, setPriorityActiveDays] = React.useState<number>(PRIORITY_ACTIVE_DAYS);
  const [totalPages, setTotalPages] = React.useState<number>(1);

  // Hydrate priorityActiveDays from IndexedDB on mount so the offline filter
  // uses the admin-configured value even before a successful network fetch.
  React.useEffect(() => {
    getMeta<number>(PRIORITY_ACTIVE_DAYS_META_KEY).then((stored) => {
      if (typeof stored === 'number' && stored > 0) {
        setPriorityActiveDays(stored);
      }
    }).catch(() => { /* IndexedDB unavailable — keep default */ });
  }, []);
  const [loading, setLoading] = React.useState<boolean>(true);
  const [error, setError] = React.useState<string | null>(null);
  const [contactsStale, setContactsStale] = React.useState<boolean>(false);
  const [fromCache, setFromCache] = React.useState<boolean>(false);
  const [lastSyncAt, setLastSyncAt] = React.useState<number | null>(null);

  const pendingContactsStaleRef = React.useRef<boolean | null>(null);

  React.useEffect(() => {
    (window as typeof window & { __setTestPendingContactsStale?: (v: boolean) => void })
      .__setTestPendingContactsStale = (v: boolean) => {
        pendingContactsStaleRef.current = v;
      };
    return () => {
      delete (window as typeof window & { __setTestPendingContactsStale?: (v: boolean) => void })
        .__setTestPendingContactsStale;
    };
  }, []);

  React.useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) return;
      if (pendingContactsStaleRef.current !== null) {
        setContactsStale(pendingContactsStaleRef.current);
        pendingContactsStaleRef.current = null;
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  React.useEffect(() => {
    const ctrl = new AbortController();

    setLoading(true);
    setError(null);
    setFromCache(false);
    if (document.hidden) {
      pendingContactsStaleRef.current = false;
    } else {
      setContactsStale(false);
    }

    const limit = pageSize && pageSize > 0 ? pageSize : PAGINATED_CONTACTS_PAGE_LIMIT;
    const qs = new URLSearchParams({ page: String(effectivePage), limit: String(limit) });
    if (leadStatus) qs.set('leadStatus', leadStatus);
    if (stage) qs.set('stage', stage);
    const serverSort = sortBy === 'priority' ? 'newest' : sortBy;
    if (serverSort && serverSort !== 'newest') qs.set('sort', serverSort);
    if (search) qs.set('q', search);
    if (showArchived) qs.set('archived', '1');
    if (showExcluded) qs.set('includeExcluded', '1');
    if (staleAfterDays !== undefined) qs.set('staleAfterDays', String(staleAfterDays));
    if (priorityFirst || sortBy === 'priority') qs.set('priorityFirst', '1');

    (async () => {
      try {
        const r = await fetch(`/api/contacts-all?${qs}`, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
        if (r.status === 401) return;
        const data = await r.json().catch(() => ({})) as ContactsResponse;
        if (!r.ok) {
          const err = new Error((data as { error?: string }).error || `HTTP ${r.status}`);
          (err as { code?: string }).code = (data as { code?: string }).code;
          throw err;
        }
        if (ctrl.signal.aborted) return;
        const isStale = r.headers.get('X-Cache-Status') === 'stale';
        if (document.hidden) {
          pendingContactsStaleRef.current = isStale;
        } else {
          pendingContactsStaleRef.current = null;
          setContactsStale(isStale);
        }
        const list = data.results || [];
        setContacts(list);
        // Capture the admin-configured active window so the offline mirror uses
        // the same value as the server on the next offline render.
        if (data.priorityActiveDays != null && data.priorityActiveDays > 0) {
          setPriorityActiveDays(data.priorityActiveDays);
          // Persist so the offline filter uses the admin-configured value even
          // if no network fetch succeeds in a future session.
          void setMeta(PRIORITY_ACTIVE_DAYS_META_KEY, data.priorityActiveDays);
        }
        // Write-through to the offline store (best-effort, never blocks the UI)
        // and stamp the freshness time so the offline view can show "Last
        // synced at …".
        const syncedAt = Date.now();
        void cacheRecords('customers', list);
        void setMeta(CONTACTS_LAST_SYNC_META_KEY, syncedAt);
        setLastSyncAt(syncedAt);
        setTotal(data.total != null ? data.total : list.length);
        setTotalPages(data.totalPages || 1);
        setLoading(false);
        onFetchSuccessRef.current?.();
      } catch (e) {
        // Abort means a newer request superseded this one — discard silently.
        if ((e as { name?: string }).name === 'AbortError' || ctrl.signal.aborted) return;
        // Offline fallback: instead of showing an error, render saved customers
        // from the IndexedDB cache when the network fetch fails. The cache holds
        // every customer viewed/listed recently regardless of the current filter
        // or page, so we surface it as a single best-effort "saved data" view.
        const cached = await readRecords<PaginatedContact>('customers');
        if (ctrl.signal.aborted) return;
        const persistedSyncAt = await getMeta<number>(CONTACTS_LAST_SYNC_META_KEY);
        if (ctrl.signal.aborted) return;
        if (typeof persistedSyncAt === 'number') setLastSyncAt(persistedSyncAt);
        // Read the persisted active-window directly here (not from React state)
        // so the offline filter always uses the admin-configured value regardless
        // of whether the mount-hydration effect has resolved yet.
        const persistedActiveDays = await getMeta<number>(PRIORITY_ACTIVE_DAYS_META_KEY);
        if (ctrl.signal.aborted) return;
        const resolvedPriorityActiveDays =
          typeof persistedActiveDays === 'number' && persistedActiveDays > 0
            ? persistedActiveDays
            : priorityActiveDays;
        if (resolvedPriorityActiveDays !== priorityActiveDays) {
          setPriorityActiveDays(resolvedPriorityActiveDays);
        }
        if (cached.length > 0) {
          // Apply the active search box, lead-status / stage filters, sort
          // order, and pagination client-side so the offline experience feels
          // consistent with the online one.
          const { results, total: filteredTotal, totalPages: filteredPages, page: clampedPage } =
            filterSortPaginateCachedContacts(cached, {
              leadStatus,
              stage,
              sortBy,
              search,
              showArchived,
              showExcluded,
              excludedStatusKeys,
              statusStageMap,
              page: effectivePage,
              limit,
              priorityFirst,
              prioritySortMode,
              priorityActiveDays: resolvedPriorityActiveDays,
            });
          setContacts(results);
          setTotal(filteredTotal);
          setTotalPages(filteredPages);
          if (clampedPage !== effectivePage) setPage(clampedPage);
          setFromCache(true);
          setError(null);
          if (document.hidden) {
            pendingContactsStaleRef.current = false;
          } else {
            pendingContactsStaleRef.current = null;
            setContactsStale(false);
          }
          setLoading(false);
          return;
        }
        if (document.hidden) {
          pendingContactsStaleRef.current = false;
        } else {
          pendingContactsStaleRef.current = null;
          setContactsStale(false);
        }
        setError(humaniseError(e as Error & { code?: string }));
        setContacts([]);
        setTotal(0);
        setTotalPages(1);
        setLoading(false);
      }
    })();

    return () => {
      ctrl.abort();
    };
  }, [effectivePage, leadStatus, stage, sortBy, search, showArchived, showExcluded, excludedStatusKeys, refreshNonce, staleAfterDays, pageSize, priorityFirst, prioritySortMode]);

  const patchContact = React.useCallback(
    (contactId: string, props: Record<string, string | undefined>) => {
      setContacts((prev) =>
        prev.map((c) =>
          c.id === contactId
            ? { ...c, properties: { ...c.properties, ...props } }
            : c,
        ),
      );
      // Persist the patch to the offline cache so that if the device goes
      // offline immediately after the status change the IndexedDB copy is
      // also up to date.  We read the existing cached record first so we
      // can merge only the changed properties rather than overwriting the
      // whole contact (the record may be in the cache even when it is not
      // on the current visible page).  Both operations are fire-and-forget
      // and best-effort — a failure here must never affect the UI.
      void (async () => {
        const existing = await readRecord<PaginatedContact>('customers', contactId);
        const merged: PaginatedContact = existing
          ? { ...existing, properties: { ...existing.properties, ...props } }
          : { id: contactId, properties: props };
        await cacheRecord('customers', contactId, merged);
      })();
    },
    [],
  );

  return { contacts, total, totalPages, loading, error, contactsStale, fromCache, lastSyncAt, priorityActiveDays, page: effectivePage, setPage, patchContact };
}
