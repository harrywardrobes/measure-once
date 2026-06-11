import { useState, useEffect } from 'react';

/**
 * Returns a Date that refreshes on a fixed interval, but only while the
 * browser tab is visible. The interval is paused on `visibilitychange →
 * hidden` and restarted on `→ visible`, so sleeping tabs are not woken up.
 *
 * @param intervalMs  Tick interval in milliseconds. Defaults to 60 000 (1 min).
 */
export function useNowTick(intervalMs = 60_000): Date {
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    let timerId: ReturnType<typeof setInterval> | null = null;

    function startTick() {
      if (timerId !== null) return;
      timerId = setInterval(() => setNow(new Date()), intervalMs);
    }

    function stopTick() {
      if (timerId !== null) {
        clearInterval(timerId);
        timerId = null;
      }
    }

    function handleVisibilityChange() {
      if (document.hidden) {
        stopTick();
      } else {
        setNow(new Date());
        startTick();
      }
    }

    if (!document.hidden) {
      startTick();
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      stopTick();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [intervalMs]);

  return now;
}
