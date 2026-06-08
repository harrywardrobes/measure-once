#!/usr/bin/env node
/**
 * Build the Workbox service worker for Measure Once.
 *
 * Runs AFTER the Vite React build (it globs the freshly-built, content-hashed
 * bundle under public/react/). Produces a single self-contained public/sw.js
 * with the Workbox runtime inlined.
 *
 * Wired into:  build:react, build:react:dev, start-prebuild, dev-prebuild.
 * Run standalone:  node scripts/build-sw.mjs
 *
 * The generated public/sw.js is gitignored (regenerated on every build) and is
 * served at the site root (scope "/") by Express so it controls all pages.
 *
 * Cache strategy summary (see docs/OFFLINE.md for the full policy):
 *  - Precache: React bundle/chunks/assets, fonts, CSS, icons, manifest, and the
 *    stable server-rendered HTML entry points (/, /customers, /profile).
 *  - Runtime stale-while-revalidate: read-only GET APIs for customer cards &
 *    details, visits & schedule, and photo capture/review.
 *  - Runtime NetworkFirst: app-shell navigations (dynamic EJS pages).
 */

import { generateSW } from 'workbox-build';
import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PUBLIC = resolve(ROOT, 'public');
const MAIN = resolve(PUBLIC, 'react', 'main.js');
const SW_DEST = resolve(PUBLIC, 'sw.js');

if (!existsSync(MAIN)) {
  console.error('[build-sw] public/react/main.js not found — run the React build first (npm run build:react).');
  process.exit(1);
}

// Revision for non-content-hashed precache entries (the HTML routes). Tying it
// to the current bundle hash means a new deploy invalidates the cached shells.
const buildRev = createHash('sha256').update(readFileSync(MAIN)).digest('hex').slice(0, 16);

const TWELVE_HOURS = 12 * 60 * 60;
const ONE_DAY = 24 * 60 * 60;
const ONE_YEAR = 365 * 24 * 60 * 60;

const { count, size, warnings } = await generateSW({
  globDirectory: PUBLIC,
  globPatterns: [
    'react/main.js',
    'react/chunks/**/*.js',
    'react/assets/**/*.{js,css,woff,woff2,ttf,otf,png,jpg,jpeg,svg}',
    'fonts/**/*.{ttf,woff,woff2}',
    'assets/**/*.png',
    'icons/**/*.png',
    'tokens.css',
    'app-styles.css',
    'manifest.json',
  ],
  globIgnores: ['**/*.map', 'storybook/**'],
  swDest: SW_DEST,
  inlineWorkboxRuntime: true,
  sourcemap: false,
  mode: 'production',
  cacheId: 'measure-once',
  cleanupOutdatedCaches: true,
  skipWaiting: true,
  clientsClaim: true,
  maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
  // App-shell HTML entry points are server-rendered (EJS) and therefore not part
  // of the Vite output. Precache the stable ones; dynamic routes (e.g.
  // /customers/:id) are served by the navigation runtime cache below.
  additionalManifestEntries: [
    { url: '/', revision: buildRev },
    { url: '/customers', revision: buildRev },
    { url: '/profile', revision: buildRev },
  ],
  navigateFallback: null,
  runtimeCaching: [
    // Google Fonts stylesheet (re-validate) + font files (long-lived).
    {
      urlPattern: /^https:\/\/fonts\.googleapis\.com\//,
      handler: 'StaleWhileRevalidate',
      options: {
        cacheName: 'mo-google-fonts-css',
        cacheableResponse: { statuses: [0, 200] },
      },
    },
    {
      urlPattern: /^https:\/\/fonts\.gstatic\.com\//,
      handler: 'CacheFirst',
      options: {
        cacheName: 'mo-google-fonts-files',
        expiration: { maxEntries: 20, maxAgeSeconds: ONE_YEAR },
        cacheableResponse: { statuses: [0, 200] },
      },
    },
    // Customer cards (lists, counts, status lookups, workflow) + customer
    // detail / localdata / tasks.
    {
      urlPattern: ({ url, sameOrigin }) => sameOrigin && (
        /^\/api\/(contacts-all|contacts-lead-status-counts|contacts-substatus-counts|lead-statuses|lead-substatuses|workflow)$/.test(url.pathname) ||
        /^\/api\/contacts\/[^/]+(\/(localdata|tasks))?$/.test(url.pathname)
      ),
      handler: 'StaleWhileRevalidate',
      options: {
        cacheName: 'mo-customers',
        expiration: { maxEntries: 200, maxAgeSeconds: TWELVE_HOURS },
        cacheableResponse: { statuses: [200] },
      },
    },
    // Visits & schedule.
    {
      urlPattern: ({ url, sameOrigin }) =>
        sameOrigin && /^\/api\/(visits|design-visits|events)(\/[^/]+)?$/.test(url.pathname),
      handler: 'StaleWhileRevalidate',
      options: {
        cacheName: 'mo-visits',
        expiration: { maxEntries: 100, maxAgeSeconds: TWELVE_HOURS },
        cacheableResponse: { statuses: [200] },
      },
    },
    // Photo capture / review + customer-info reads.
    {
      urlPattern: ({ url, sameOrigin }) => sameOrigin && (
        /^\/api\/card-actions\/review-customer-photos\/[^/]+$/.test(url.pathname) ||
        /^\/api\/customer-info\//.test(url.pathname)
      ),
      handler: 'StaleWhileRevalidate',
      options: {
        cacheName: 'mo-photos',
        expiration: { maxEntries: 100, maxAgeSeconds: TWELVE_HOURS },
        cacheableResponse: { statuses: [200] },
      },
    },
    // App-shell navigations (server-rendered EJS). NetworkFirst so online users
    // always get fresh HTML, offline users get the last cached shell.
    {
      urlPattern: ({ request, sameOrigin }) => sameOrigin && request.mode === 'navigate',
      handler: 'NetworkFirst',
      options: {
        cacheName: 'mo-pages',
        networkTimeoutSeconds: 3,
        expiration: { maxEntries: 50, maxAgeSeconds: ONE_DAY },
        cacheableResponse: { statuses: [200] },
      },
    },
  ],
});

if (warnings && warnings.length) {
  for (const w of warnings) console.warn('[build-sw] warning:', w);
}
console.log(`[build-sw] Generated public/sw.js — precached ${count} files, ${(size / 1024).toFixed(1)} kB.`);
