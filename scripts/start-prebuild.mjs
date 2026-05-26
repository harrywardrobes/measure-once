/**
 * Lightweight pre-build step for `npm start`.
 *
 * Goals:
 *  - First run / clean checkout (no bundle yet): run the full CI-quality build
 *    (typecheck + vite build + bundle-size check) so production starts with a
 *    verified, up-to-date bundle.
 *  - Subsequent runs (bundle already exists): skip the build entirely so
 *    Replit workflow restarts after server-side-only changes are instant.
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

if (existsSync(BUNDLE)) {
  console.log('[start-prebuild] Bundle already exists — skipping React build.');
  console.log('[start-prebuild] Run `npm run build:react:dev` to rebuild, or `npm run build:react` for a full build with type-checking.');
} else {
  console.log('[start-prebuild] No bundle found — running full React build (typecheck + vite + bundle-size check).');
  execSync('node scripts/generate-tokens-css.mjs', { stdio: 'inherit' });
  execSync('npm run typecheck', { stdio: 'inherit' });
  execSync('npx vite build', { stdio: 'inherit' });
  execSync('node scripts/check-bundle-sizes.mjs', { stdio: 'inherit' });
}
