/**
 * scripts/offline-read-caches.mjs
 *
 * Single source of truth for the service worker's offline **read** caches — the
 * GET route patterns whose responses are cached (StaleWhileRevalidate) so an
 * area stays *viewable* offline once it has been loaded online.
 *
 * Consumed by BOTH:
 *   1. scripts/build-sw.mjs — builds the Workbox `runtimeCaching` entries from
 *      this list, so the real SW behaviour is derived from it (no hand-written
 *      `/api/*` read caches live in build-sw.mjs).
 *   2. scripts/check-offline-capability-sync.mjs — validates the admin capability
 *      matrix and docs/OFFLINE.md against this list at **route granularity**, so
 *      adding or removing a cached read route forces the matrix and docs to be
 *      updated in lockstep, or CI fails.
 *
 * `routes` are RegExp *source* strings matched against `url.pathname`
 * (`new RegExp(route).test(url.pathname)`). Forward slashes need no escaping in
 * the RegExp constructor, so they are written plainly for readability.
 *
 * Each entry maps to one `cachedBy` cache name on the capability matrix
 * (`src/react/lib/offlineCapabilities.ts`) and one `<!-- offline-view-cache: … -->`
 * row annotation in docs/OFFLINE.md.
 */

export const OFFLINE_READ_CACHES = [
  {
    // Customer cards (lists, counts, status lookups, workflow) + customer
    // detail / localdata / tasks.
    cacheName: 'mo-customers',
    maxEntries: 200,
    routes: [
      '^/api/(contacts-all|contacts-lead-status-counts|contacts-stage-counts|contacts-substatus-counts|lead-statuses|lead-substatuses|workflow)$',
      '^/api/contacts/[^/]+(/(localdata|tasks))?$',
    ],
  },
  {
    // Visits & schedule (visits, design visits, calendar events).
    cacheName: 'mo-visits',
    maxEntries: 100,
    routes: ['^/api/(visits|design-visits|events)(/[^/]+)?$'],
  },
  {
    // Photo capture / review + customer-info reads.
    cacheName: 'mo-photos',
    maxEntries: 100,
    routes: [
      '^/api/card-actions/review-customer-photos/[^/]+$',
      '^/api/customer-info/',
    ],
  },
  {
    // Customer-info submission photo *images* (HMAC-signed object-storage
    // reads). Kept in their own cache — separate from the JSON list reads in
    // mo-photos — so a contact with a large photo set evicts only older images
    // (oldest-first) and never the cached submissions lists. Each online list
    // load mints fresh signed URLs (1h exp), so entries churn but stay bounded
    // by maxEntries; offline reads use the URLs from the last cached list,
    // which match the most-recently-cached image entries.
    cacheName: 'mo-customer-photos',
    maxEntries: 200,
    routes: ['^/api/customer-info-photos/'],
  },
  {
    // Design-visit reference data for the standalone offline page (/design-visit):
    // catalogues, the questionnaire, terms, and the card-action handler config.
    // Warmed on the page's mount while online so the wizard's existing GETs all
    // resolve from cache once the device drops offline.
    cacheName: 'mo-reference',
    maxEntries: 30,
    routes: [
      '^/api/catalog/(handles|ranges|doors)$',
      '^/api/visit-questions$',
      '^/api/design-visit-terms$',
      '^/api/card-action-handlers$',
    ],
  },
];
