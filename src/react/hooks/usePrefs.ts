import { useCallback, useEffect, useRef, useState } from 'react';
import { GET, PATCH } from '../utils/api';
import { useAuth } from '../contexts/AuthContext';

type Prefs = Record<string, unknown>;

interface UsePrefsResult {
  prefs: Prefs;
  loading: boolean;
  patchPref: (key: string, value: unknown) => Promise<void>;
}

let _cache: Prefs | null = null;
let _promise: Promise<Prefs> | null = null;

function fetchPrefs(): Promise<Prefs> {
  if (_promise) return _promise;
  _promise = GET<Prefs>('/api/users/me/prefs').catch(() => ({}));
  _promise.then(p => { _cache = p; });
  return _promise;
}

/**
 * React hook that fetches and caches the current user's preferences.
 *
 * - `prefs` is always an object (empty while loading or for viewers).
 * - `patchPref(key, value)` updates the local cache immediately (optimistic)
 *   then fire-and-forgets a PATCH to the server. It does NOT throw — callers
 *   that need error feedback should handle the returned Promise.
 * - Viewer-role users skip the network fetch (they have no writable prefs).
 *
 * This is the React equivalent of the `ensurePrefs` / `patchPref` helpers in
 * `public/core.js`. Prefer this hook inside React components; the core.js
 * helpers remain available for vanilla-JS bridges until core.js is retired.
 */
export function usePrefs(): UsePrefsResult {
  const { privilegeLevel } = useAuth();
  const isViewer = privilegeLevel === 'viewer';

  const [prefs, setPrefs] = useState<Prefs>(() => _cache ?? {});
  const [loading, setLoading] = useState(() => !_cache && !isViewer);

  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  useEffect(() => {
    if (isViewer) return;
    if (_cache) { setPrefs(_cache); setLoading(false); return; }
    let cancelled = false;
    fetchPrefs().then(p => {
      if (!cancelled) { setPrefs(p); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [isViewer]);

  const patchPref = useCallback(async (key: string, value: unknown) => {
    const next = { ...prefsRef.current, [key]: value };
    setPrefs(next);
    _cache = next;
    try {
      await PATCH('/api/users/me/prefs', { [key]: value });
    } catch (e) {
      console.warn('Failed to save preference:', key, e);
    }
  }, []);

  return { prefs, loading, patchPref };
}
