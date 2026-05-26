/**
 * Lightweight pre-build step for `npm run dev`.
 *
 * Goals:
 *  - First run (no bundle yet): build with Vite only — skips typecheck and
 *    bundle-size check so the dev server starts as fast as possible.
 *  - Subsequent runs (bundle already exists): skip the build entirely so
 *    nodemon/workflow restarts are instant.
 *
 * For a full, CI-quality build (typecheck + bundle-size check) use:
 *   npm run build:react
 *
 * For a fast manual rebuild without the size check use:
 *   npm run build:react:dev
 */

import { existsSync } from 'fs';
import { execSync } from 'child_process';

const BUNDLE = 'public/react/main.js';

if (existsSync(BUNDLE)) {
  console.log('[dev-prebuild] Bundle already exists — skipping React build.');
  console.log('[dev-prebuild] Run `npm run build:react:dev` to rebuild, or `npm run build:react` for a full build with type-checking.');
} else {
  console.log('[dev-prebuild] No bundle found — running fast Vite build (skipping typecheck and bundle-size check).');
  execSync('node scripts/generate-tokens-css.mjs', { stdio: 'inherit' });
  execSync('npx vite build', { stdio: 'inherit' });
}
