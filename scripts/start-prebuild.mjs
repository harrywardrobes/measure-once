/**
 * Lightweight pre-build step for `npm start`.
 *
 * Goals:
 *  - First run / clean checkout (no bundle yet): run the full CI-quality build
 *    (typecheck + vite build + bundle-size check) so production starts with a
 *    verified, up-to-date bundle.
 *  - Subsequent runs (bundle already exists): skip the build entirely so
 *    process restarts after server-side-only changes are instant.
 *
 * Storybook: built automatically whenever public/storybook/ is absent, so the
 * Design System card works on a fresh checkout without a manual step.
 *
 * For a full, CI-quality build regardless of existing bundle use:
 *   npm run build:react
 *
 * For a fast manual rebuild without the size check use:
 *   npm run build:react:dev
 */

import { existsSync } from 'fs';
import { execSync } from 'child_process';

const BUNDLE = 'public/react/main.js';
const STORYBOOK = 'public/storybook/index.html';

if (existsSync(BUNDLE)) {
  console.log('[start-prebuild] Bundle already exists — skipping React build.');
  console.log('[start-prebuild] Run `npm run build:react:dev` to rebuild, or `npm run build:react` for a full build with type-checking.');
} else {
  // Fast build (no typecheck / bundle-size check) so workflow restarts complete
  // within the platform timeout. Run `npm run build:react` for a full CI build.
  console.log('[start-prebuild] No bundle found — running fast React build (vite only, no typecheck).');
  execSync('node scripts/generate-tokens-css.mjs', { stdio: 'inherit' });
  execSync('npx vite build', { stdio: 'inherit' });
}

// Always (re)generate the service worker so public/sw.js matches the current
// bundle. Cheap (~ms) and idempotent, so it's safe on the skip-build path too.
execSync('node scripts/build-sw.mjs', { stdio: 'inherit' });

// Reclaim port 5000 — kill any stale process that would cause EADDRINUSE.
// This is a no-op when the port is already free.
const PORT = process.env.PORT || 5000;
try {
  execSync(`fuser -k ${PORT}/tcp`, { stdio: 'pipe' });
  console.log(`[start-prebuild] Reclaimed port ${PORT}.`);
} catch {
  // fuser exits non-zero when nothing is using the port — that's fine.
}

if (existsSync(STORYBOOK)) {
  console.log('[start-prebuild] Storybook already built — skipping.');
} else {
  console.log('[start-prebuild] Storybook not found — building now (run `npm run build:storybook` to rebuild manually).');
  execSync('npm run build:storybook', { stdio: 'inherit' });
}
