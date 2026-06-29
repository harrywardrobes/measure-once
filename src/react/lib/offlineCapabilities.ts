/**
 * Offline capability matrix — single source of truth (Offline Phase 3).
 *
 * This module is the **one** place the "What works offline" capability matrix
 * lives. The admin Offline-support tab (`OfflineSupportPage.tsx`) renders it
 * directly (no second hand-maintained copy), and a CI lint
 * (`scripts/check-offline-capability-sync.mjs`) validates it against the actual
 * covered write surfaces in the codebase and the docs, so the table can never
 * silently drift from real offline behaviour.
 *
 * ── How drift is prevented ──────────────────────────────────────────────────
 * Every area whose capability is `full` (works offline) declares `backedBy`:
 * the set of offline-queue {@link OfflineArea} codes that make it work offline.
 * Those codes come straight from the `area:` field of the real `sendOrQueue()`
 * call sites. The lint asserts a three-way equality between:
 *   1. the union of `backedBy` codes across every `full` row here,
 *   2. the `area:` codes actually used by `sendOrQueue()` callers (real
 *      behaviour), and
 *   3. the `<!-- offline-areas: … -->` annotations on the "Covered write
 *      surfaces" rows in `docs/OFFLINE.md`.
 * Adding or removing an offline-capable surface therefore forces this matrix
 * (and the docs) to be updated in lockstep, or CI fails.
 *
 * ── How view-only drift is prevented ────────────────────────────────────────
 * Being *viewable* offline depends on the service worker actually caching the
 * area's GET reads. Every row that is viewable offline (`full` **and** `view`)
 * that introduces a runtime cache declares `cachedBy`: the service-worker
 * runtime cache name(s) that hold its offline-viewable responses. The cached
 * read routes are defined once in `scripts/offline-read-caches.mjs`
 * (`OFFLINE_READ_CACHES`), which `scripts/build-sw.mjs` consumes to build the
 * Workbox runtimeCaching rules. The lint asserts a three-way equality between:
 *   1. that manifest (cache names + route patterns),
 *   2. the union of `cachedBy` names across `full`/`view` rows here, and
 *   3. the `<!-- offline-view-cache: <cache> routes: … -->` annotations on the
 *      cache table in `docs/OFFLINE.md` (matched at route granularity).
 * So a `view` row can never claim offline caching the SW doesn't provide, and
 * adding/removing a cached read route forces the matrix (and docs) to update.
 * `online` rows must NOT declare `cachedBy`; `view` rows MUST declare it.
 *
 * NOTE: `OfflineArea` is imported **type-only** so this module pulls no runtime
 * dependency on `offlineQueue`/`idb` — it stays cheap to import anywhere.
 *
 * Authoring convention (the lint relies on it): on a `full` row, place
 * `backedBy: [...]` **immediately after** `capability: 'full'`. Non-`full`
 * rows must not declare `backedBy`.
 */

import type { OfflineArea } from './offlineQueue';

/** How well an area works without a connection. */
export type CapabilityLevel = 'full' | 'view' | 'online';

export interface FeatureArea {
  /** User-facing area name shown in the matrix. */
  name: string;
  capability: CapabilityLevel;
  /**
   * For `full` areas only: the offline-queue area codes whose `sendOrQueue()`
   * writes make this area work offline. Must be omitted for `view`/`online`.
   */
  backedBy?: OfflineArea[];
  /**
   * For offline-viewable areas (`full` and `view`): the service-worker runtime
   * cache name(s) (declared in `scripts/offline-read-caches.mjs`) that hold this
   * area's cached GET reads. REQUIRED on every `view` row; on
   * `full` rows declare it on whichever row introduces the cache. MUST be
   * omitted on `online` rows (they are not cached for offline viewing).
   */
  cachedBy?: string[];
  /** One-line explanation shown in the matrix. */
  detail: string;
}

export const FEATURE_AREAS: FeatureArea[] = [
  {
    name: 'Customer cards & details',
    capability: 'full',
    backedBy: ['customer'],
    cachedBy: ['mo-customers'],
    detail:
      'Browse cached customer cards and detail pages. Lead-status changes, sub-status quick-sets, and rooms/notes edits are queued and synced on reconnect.',
  },
  {
    name: 'Visits & schedule',
    capability: 'full',
    backedBy: ['visit'],
    cachedBy: ['mo-visits'],
    detail:
      'View cached visits and design visits. Design-visit wizard submissions (new and edits) are queued offline and replayed in order; edits are checked for conflicts on sync.',
  },
  {
    name: 'Photo capture',
    capability: 'full',
    backedBy: ['visit'],
    cachedBy: ['mo-photos'],
    detail:
      'Room photos captured in the design-visit wizard are saved on the device and uploaded with the queued submission when you reconnect.',
  },
  {
    name: 'Design visit (standalone page)',
    capability: 'full',
    backedBy: ['visit'],
    cachedBy: ['mo-reference'],
    detail:
      'The standalone /design-visit field page works offline: catalogues, the questionnaire, terms and the card-action config are cached so a full visit can be completed and queued. Existing or brand-new customers are supported; the visit (and any new customer) syncs to the CRM on reconnect.',
  },
  {
    name: 'Arrange-visit outcomes',
    capability: 'full',
    backedBy: ['visit'],
    detail:
      "The 'not proceeding' and 'booked' outcomes are queued offline (the calendar event is created once you're back online). The 'email a time slot' outcome needs a live email session.",
  },
  {
    name: 'Customer photo review',
    capability: 'full',
    backedBy: ['photo'],
    cachedBy: ['mo-customer-photos'],
    detail:
      "Reviewing a customer's submitted photos and sending the 'not suitable' or 'rough estimate' outcome is queued offline and replayed on reconnect (the email and lead-status update happen when the write syncs). The submitted photo images are cached on load, so the thumbnails stay viewable offline.",
  },
  {
    name: 'Customer-info forms',
    capability: 'online',
    detail:
      'The public customer-info form and its photo uploads need a connection to submit, though in-progress entries are draft-saved in your browser.',
  },
  {
    name: 'Projects (pipeline board)',
    capability: 'online',
    detail:
      'The pipeline board loads live, all-stage pipeline data that is not cached for offline use.',
  },
  {
    name: 'Trades',
    capability: 'online',
    detail: 'The trade-company directory and submissions require a live connection.',
  },
  {
    name: 'Calendar & scheduling',
    capability: 'view',
    cachedBy: ['mo-visits'],
    detail:
      'Previously loaded calendar events are viewable offline, but creating or booking new events writes to Google Calendar and needs internet.',
  },
  {
    name: 'QuickBooks invoices & estimates',
    capability: 'online',
    detail:
      'Invoice and estimate data is read from QuickBooks live; creating or sending estimates needs internet.',
  },
  {
    name: 'Admin settings, team & permissions',
    capability: 'online',
    detail: 'All admin configuration screens read and write live data and require a connection.',
  },
];
