import { LEGACY_SWEEP_DONE_KEY } from '../constants/localStorageKeys';

/**
 * One-time global sweep that removes every legacy (unscoped) localStorage key
 * left over from before per-user key scoping was introduced.
 *
 * Run once at app boot (see main.tsx).  A version flag (`LEGACY_SWEEP_DONE_KEY`)
 * is written after the sweep so it never runs again on subsequent page loads.
 *
 * This guarantees a clean slate even for users who have not visited the pages
 * that previously hosted the individual per-component migration shims.
 */
const _LEGACY_KEYS_TO_SWEEP: readonly string[] = [
  'adminActiveGroup',
  'adminActiveTab',
  'adminVisitsSubtab',
  'cp_recent_customers',
  'projectsStalenessActive',
  'projectsHiddenSubstages',
  'mo_invoice_page',
  'mo_invoice_draft',
  'tradesTypeFilter',
  'questionnaireVisitTypeFilter',
  'cah_orphaned_dismissed_count',
  'cah_conflict_dismissed_key',
  'mo:home:task-assignee-filter',
  'mo:home:task-contact-search',
];

export function runLegacyKeysSweep(): void {
  try {
    if (localStorage.getItem(LEGACY_SWEEP_DONE_KEY)) return;
    for (const key of _LEGACY_KEYS_TO_SWEEP) {
      try { localStorage.removeItem(key); } catch { /* ignore */ }
    }
    localStorage.setItem(LEGACY_SWEEP_DONE_KEY, '1');
  } catch {
    // localStorage unavailable (e.g. private-browsing storage quota) — skip silently.
  }
}
