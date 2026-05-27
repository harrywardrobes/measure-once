/**
 * resolveActionLabel — pure resolver for Projects card action-strip labels.
 *
 * Shared between the React hook (useCardActionHandlers.ts) and the unit-test
 * suite (scripts/test-resolve-action-label.mjs) so both exercise exactly the
 * same production code path.
 *
 * Map value semantics for `stageActionLabelMap`:
 *   non-empty string  → per-LS (or per-stage) label set by an admin
 *   null              → row EXISTS in DB with empty label — admin explicitly
 *                       cleared it; suppress the action strip
 *   key absent        → no DB row for this LS → fall back to per-stage default
 *
 * Key format:  `${stage_key.toLowerCase()}|${status_key.toLowerCase()}`
 *
 * @param {Record<string, string|null>} stageActionLabelMap
 * @param {Record<string, string>}      substatusActionLabelMap
 *   Keys: `${STATUS_KEY.toUpperCase()}|${SUBSTATUS_KEY.toUpperCase()}`
 * @param {string}           stageKey
 * @param {string|undefined} leadStatusKey
 * @param {string|undefined} substageId
 * @param {string|undefined} hwSubstatusValue
 * @returns {string}
 */
export function resolveActionLabel(
  stageActionLabelMap,
  substatusActionLabelMap,
  stageKey,
  leadStatusKey,
  substageId,
  hwSubstatusValue,
) {
  // 1. Substatus action label (highest priority)
  if (leadStatusKey && hwSubstatusValue) {
    const sk = String(leadStatusKey).toUpperCase();
    const v  = String(hwSubstatusValue).toUpperCase();
    const prefix = `${sk}__`;
    if (v.startsWith(prefix)) {
      const subKey  = v.slice(prefix.length);
      const fromSub = substatusActionLabelMap[`${sk}|${subKey}`];
      if (fromSub) return fromSub;
    }
  }

  const sKey  = String(stageKey    || '').toLowerCase();
  const lsKey = String(leadStatusKey || '').toLowerCase();
  const map   = stageActionLabelMap;

  // 2. Per-LS stage action label
  if (lsKey) {
    const perLsKey = `${sKey}|${lsKey}`;
    if (perLsKey in map) {
      // Row exists: return label (non-empty) or '' (admin explicitly cleared it).
      return map[perLsKey] ?? '';
    }
    // No row for this LS → fall back to per-stage default (stage_key, '').
    return map[`${sKey}|`] ?? '';
  }

  // 3. Per-substageId legacy fallback (lowercase to match map key format)
  if (substageId) {
    const fromSub = map[`${sKey}|${String(substageId).toLowerCase()}`];
    if (fromSub) return fromSub;
  }

  // 4. Per-stage "no lead status" row
  return map[`${sKey}|`] ?? '';
}
