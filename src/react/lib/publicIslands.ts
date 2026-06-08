/**
 * Single authoritative list of React island ids that are served on pages
 * accessible without an authenticated session.
 *
 * When adding a new public island:
 *  1. Add its id to this Set.
 *  2. Annotate its MOUNTS entry in src/react/main.tsx with `// public-island`.
 *
 * Both CONN_TOAST_EXCLUDED (main.tsx) and BOOTSTRAP_EXCLUDED
 * (AppBootstrapContext.tsx) are derived from this set — no manual sync needed.
 *
 * scripts/check-public-island-bootstrap.mjs enforces that this set and the
 * `// public-island` annotations in the MOUNTS table stay in sync.
 */
export const PUBLIC_ISLAND_IDS = new Set([
  'login-root',
  'set-password-root',
  'onboarding-root',
  'dv-signoff-mount',
  'customer-info-mount',
]);

/**
 * Ids that must skip the AppBootstrapProvider auth-redirect guard but are NOT
 * public-facing pages — they are error/restricted pages rendered after auth
 * failures.  They must never appear in PUBLIC_ISLAND_IDS (which drives
 * CONN_TOAST_EXCLUDED) and are checked by scripts/check-public-island-bootstrap.mjs.
 *
 * When adding a new error/restricted page:
 *  1. Add its id here WITH a `// views/<file>.ejs — <description>` annotation
 *     on the same line (required — omitting it is a CI failure in test:mount-ids).
 *  2. Ensure a matching MOUNTS entry exists in src/react/main.tsx.
 *
 * BOOTSTRAP_EXCLUDED in AppBootstrapContext.tsx is derived from
 * PUBLIC_ISLAND_IDS ∪ BOOTSTRAP_ONLY_IDS — no manual sync needed there either.
 */
export const BOOTSTRAP_ONLY_IDS = new Set([
  'not-found-root',         // views/404.ejs — 404 page, rendered after auth; never public
  'access-restricted-root', // views/access-restricted.ejs — access-denied page, rendered after auth; never public
]);
