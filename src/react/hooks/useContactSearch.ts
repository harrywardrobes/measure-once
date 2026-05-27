import { useState, useEffect, useRef } from 'react';

export interface ContactSearchResult {
  id: string;
  properties?: {
    firstname?: string;
    lastname?: string;
    company?: string;
    hs_object_id?: string;
  };
}

export interface UseContactSearchResult {
  contacts: ContactSearchResult[];
  loading: boolean;
}

const DEBOUNCE_MS = 200;

export function useContactSearch(query: string, enabled: boolean): UseContactSearchResult {
  const [contacts, setContacts] = useState<ContactSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const q = query.trim();

    if (!enabled || !q) {
      setContacts([]);
      setLoading(false);
      if (timerRef.current) clearTimeout(timerRef.current);
      if (abortRef.current) abortRef.current.abort();
      return;
    }

    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(async () => {
      if (abortRef.current) abortRef.current.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      setLoading(true);
      try {
        const qs = new URLSearchParams({ q, limit: '5', sort: 'newest' });
        const res = await fetch(`/api/contacts-all?${qs}`, {
          signal: ctrl.signal,
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { results?: ContactSearchResult[] };
        if (ctrl.signal.aborted) return;
        setContacts(data.results || []);
      } catch (e) {
        if ((e as { name?: string }).name === 'AbortError') return;
        setContacts([]);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, enabled]);

  return { contacts, loading };
}
