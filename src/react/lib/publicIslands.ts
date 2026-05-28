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
