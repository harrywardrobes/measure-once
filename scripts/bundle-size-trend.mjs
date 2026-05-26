/**
 * Trend-regression and spike-detection logic for bundle-size checks.
 * Exported so the test suite can exercise it directly.
 */

export const TREND_WINDOW    = 10;
export const TREND_DRIFT_PCT = 10;   // percent — warn when growth strictly exceeds this
export const SPIKE_PCT       = 5;    // percent — warn when a single build grows by more than this

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

/**
 * Inspect a window of history entries and return per-chunk warning strings for
 * any individual chunk whose size has grown by more than driftPct % relative
 * to its size in the oldest entry.
 *
 * A chunk is skipped when:
 *   - it is absent from the oldest entry (newly added — no baseline to compare)
 *   - its oldest size is zero (avoids division by zero)
 *
 * @param {Array<{chunks: Object.<string,number>}>} recentEntries
 *   Entries in chronological order (oldest first), already sliced to the window.
 *   Each entry's `chunks` map is { chunkName: gzBytes }.
 * @param {number} [driftPct]   Override the drift threshold (defaults to TREND_DRIFT_PCT).
 * @param {function} [kbStr]    Optional formatter used in warning messages.
 * @returns {string[]}  Array of warning strings, one per offending chunk (empty when none).
 */
export function detectChunkTrendWarnings(recentEntries, driftPct = TREND_DRIFT_PCT, kbStr = defaultKbStr) {
  if (recentEntries.length < 2) return [];

  const oldest = recentEntries[0];
  const newest = recentEntries[recentEntries.length - 1];

  const newestChunks = newest.chunks ?? {};
  const oldestChunks = oldest.chunks ?? {};

  const warnings = [];

  for (const [name, newestBytes] of Object.entries(newestChunks)) {
    const oldestBytes = oldestChunks[name];
    if (oldestBytes == null || oldestBytes <= 0) continue;

    const growthPct = ((newestBytes - oldestBytes) / oldestBytes) * 100;
    if (growthPct > driftPct) {
      warnings.push(
        `Chunk "${name}" grew ${growthPct.toFixed(1)}% ` +
        `over the last ${recentEntries.length} run${recentEntries.length === 1 ? '' : 's'} ` +
        `(${kbStr(oldestBytes)} → ${kbStr(newestBytes)}, ` +
        `threshold: >${driftPct}%).`
      );
    }
  }

  return warnings;
}

/**
 * Compare the two most-recent history entries and return a warning string when
 * the always-loaded total jumped by more than spikePct % in a single build,
 * or null when everything is fine.
 *
 * @param {Array<{totalAlwaysGzBytes: number}>} recentEntries
 *   Entries in chronological order (oldest first).  Only the last two matter.
 * @param {number} [spikePct]   Override the spike threshold (defaults to SPIKE_PCT).
 * @param {function} [kbStr]    Optional formatter used in the warning message.
 * @returns {string|null}
 */
export function detectSpikeWarning(recentEntries, spikePct = SPIKE_PCT, kbStr = defaultKbStr) {
  if (recentEntries.length < 2) return null;

  const prev = recentEntries[recentEntries.length - 2];
  const curr = recentEntries[recentEntries.length - 1];

  if (prev.totalAlwaysGzBytes <= 0) return null;

  const deltaPct = ((curr.totalAlwaysGzBytes - prev.totalAlwaysGzBytes) / prev.totalAlwaysGzBytes) * 100;

  if (deltaPct > spikePct) {
    return (
      `Always-loaded total jumped ${deltaPct.toFixed(1)}% in this build ` +
      `(${kbStr(prev.totalAlwaysGzBytes)} → ${kbStr(curr.totalAlwaysGzBytes)}, ` +
      `threshold: >${spikePct}%). A large dependency may have been added.`
    );
  }

  return null;
}

function defaultKbStr(bytes) {
  return (bytes / 1024).toFixed(1) + ' kB';
}
