import React from 'react';

export type PaginatedContact = {
  id: string;
  properties?: {
    firstname?: string;
    lastname?: string;
    email?: string;
    phone?: string;
    hs_lead_status?: string;
    hw_lead_substatus?: string;
    customer_number?: string;
    createdate?: string;
  };
};

type ContactsResponse = {
  results?: PaginatedContact[];
  page?: number;
  totalPages?: number;
  total?: number;
};

export type UsePaginatedContactsParams = {
  initialPage: number;
  leadStatus: string;
  substatus: string;
  stage: string;
  sortBy: string;
  search: string;
  showArchived: boolean;
  refreshNonce?: number;
  staleAfterDays?: number;
  pageSize?: number;
};

export type UsePaginatedContactsResult = {
  contacts: PaginatedContact[];
  total: number;
  totalPages: number;
  loading: boolean;
  error: string | null;
  contactsStale: boolean;
  page: number;
  setPage: (p: number) => void;
};

export type UsePaginatedContactsOptions = {
  onFetchSuccess?: () => void;
};

export const PAGINATED_CONTACTS_PAGE_LIMIT = 25;

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
  const { initialPage, leadStatus, substatus, stage, sortBy, search, showArchived, refreshNonce, staleAfterDays, pageSize } = params;

  const onFetchSuccessRef = React.useRef(options?.onFetchSuccess);
  onFetchSuccessRef.current = options?.onFetchSuccess;

  // page is managed internally so the hook can reset it to 1 when non-page
  // filters change — fulfilling the "always resets to page 1 when any filter
  // other than page changes" contract in the task spec.
  const [page, setPage] = React.useState<number>(initialPage);

  // Track the previous filter fingerprint (everything except page) so we know
  // when to reset page to 1.
  const prevFiltersRef = React.useRef({ leadStatus, substatus, stage, sortBy, search, showArchived, refreshNonce, staleAfterDays, pageSize });
  const filtersChanged =
    prevFiltersRef.current.leadStatus !== leadStatus ||
    prevFiltersRef.current.substatus !== substatus ||
    prevFiltersRef.current.stage !== stage ||
    prevFiltersRef.current.sortBy !== sortBy ||
    prevFiltersRef.current.search !== search ||
    prevFiltersRef.current.showArchived !== showArchived ||
    prevFiltersRef.current.refreshNonce !== refreshNonce ||
    prevFiltersRef.current.staleAfterDays !== staleAfterDays ||
    prevFiltersRef.current.pageSize !== pageSize;

  if (filtersChanged) {
    prevFiltersRef.current = { leadStatus, substatus, stage, sortBy, search, showArchived, refreshNonce, staleAfterDays, pageSize };
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
  const [totalPages, setTotalPages] = React.useState<number>(1);
  const [loading, setLoading] = React.useState<boolean>(true);
  const [error, setError] = React.useState<string | null>(null);
  const [contactsStale, setContactsStale] = React.useState<boolean>(false);

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
    let cancelled = false;

    setLoading(true);
    setError(null);
    if (document.hidden) {
      pendingContactsStaleRef.current = false;
    } else {
      setContactsStale(false);
    }

    const limit = pageSize && pageSize > 0 ? pageSize : PAGINATED_CONTACTS_PAGE_LIMIT;
    const qs = new URLSearchParams({ page: String(effectivePage), limit: String(limit) });
    if (leadStatus) qs.set('leadStatus', leadStatus);
    if (stage) qs.set('stage', stage);
    if (sortBy && sortBy !== 'newest') qs.set('sort', sortBy);
    if (search) qs.set('q', search);
    if (showArchived) qs.set('archived', '1');
    if (staleAfterDays !== undefined) qs.set('staleAfterDays', String(staleAfterDays));

    (async () => {
      try {
        const r = await fetch(`/api/contacts-all?${qs}`, { headers: { Accept: 'application/json' } });
        if (r.status === 401) { location.href = '/login'; return; }
        const data = await r.json().catch(() => ({})) as ContactsResponse;
        if (!r.ok) {
          const err = new Error((data as { error?: string }).error || `HTTP ${r.status}`);
          (err as { code?: string }).code = (data as { code?: string }).code;
          throw err;
        }
        if (cancelled) return;
        const isStale = r.headers.get('X-Cache-Status') === 'stale';
        if (document.hidden) {
          pendingContactsStaleRef.current = isStale;
        } else {
          pendingContactsStaleRef.current = null;
          setContactsStale(isStale);
        }
        const list = data.results || [];
        setContacts(list);
        setTotal(data.total != null ? data.total : list.length);
        setTotalPages(data.totalPages || 1);
        setLoading(false);
        onFetchSuccessRef.current?.();
      } catch (e) {
        if (cancelled) return;
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
      cancelled = true;
    };
  }, [effectivePage, leadStatus, stage, sortBy, search, showArchived, refreshNonce, staleAfterDays, pageSize]);

  return { contacts, total, totalPages, loading, error, contactsStale, page: effectivePage, setPage };
}
