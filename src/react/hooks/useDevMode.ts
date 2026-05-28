import { useEffect, useState } from 'react';

/**
 * Fetches the current HubSpot dev-mode state and subscribes to live
 * `dev_mode_changed` BroadcastChannel updates.
 *
 * Pass `enabled: false` (e.g. when the user is not an admin) to skip
 * the fetch entirely and always return `{ devMode: false }`.
 */
export function useDevMode({ enabled }: { enabled: boolean }): { devMode: boolean } {
  const [devMode, setDevMode] = useState<boolean>(false);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    fetch('/api/admin/hubspot/dev-mode', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { devMode?: boolean } | null) => {
        if (!cancelled && data && typeof data.devMode === 'boolean') {
          setDevMode(data.devMode);
        }
      })
      .catch(() => {});

    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel('dev_mode_changed');
      bc.onmessage = (e: MessageEvent<{ devMode?: boolean }>) => {
        if (typeof e.data?.devMode === 'boolean') setDevMode(e.data.devMode);
      };
    } catch {
      /* BroadcastChannel not available */
    }

    return () => {
      cancelled = true;
      bc?.close();
    };
  }, [enabled]);

  return { devMode };
}
