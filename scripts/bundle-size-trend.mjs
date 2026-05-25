/**
 * Trend-regression logic for bundle-size checks.
 * Exported so the test suite can exercise it directly.
 */

export const TREND_WINDOW    = 10;
export const TREND_DRIFT_PCT = 10;   // percent — warn when growth strictly exceeds this

/**
 * Inspect a window of history entries and return a warning string when the
 * always-loaded total has grown by more than TREND_DRIFT_PCT % relative to
 * the oldest entry in the window, or null when everything is fine.
 *
 * @param {Array<{totalAlwaysGzBytes: number}>} recentEntries
 *   Entries in chronological order (oldest first), already sliced to the window.
 * @param {number} [driftPct]   Override the drift threshold (defaults to TREND_DRIFT_PCT).
 * @param {function} [kbStr]    Optional formatter used in the warning message.
 * @returns {string|null}
 */
export function detectTrendWarning(recentEntries, driftPct = TREND_DRIFT_PCT, kbStr = defaultKbStr) {
  if (recentEntries.length < 2) return null;

  const oldest = recentEntries[0];
  const newest = recentEntries[recentEntries.length - 1];

  if (oldest.totalAlwaysGzBytes <= 0) return null;

  const growthPct =
    ((newest.totalAlwaysGzBytes - oldest.totalAlwaysGzBytes) / oldest.totalAlwaysGzBytes) * 100;

  if (growthPct > driftPct) {
    return (
      `Always-loaded total grew ${growthPct.toFixed(1)}% ` +
      `over the last ${recentEntries.length} run${recentEntries.length === 1 ? '' : 's'} ` +
      `(${kbStr(oldest.totalAlwaysGzBytes)} → ${kbStr(newest.totalAlwaysGzBytes)}, ` +
      `threshold: >${driftPct}%).`
    );
  }

  return null;
}

function defaultKbStr(bytes) {
  return (bytes / 1024).toFixed(1) + ' kB';
}
