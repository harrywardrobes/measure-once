/**
 * watch-react.mjs
 *
 * Used by `npm run watch:react`.
 *
 * - Runs generate-tokens-css.mjs once at startup.
 * - Spawns `vite build --watch` for incremental React rebuilds.
 * - Re-runs generate-tokens-css.mjs whenever src/react/theme.ts changes so
 *   public/tokens.css stays fresh without a manual full rebuild.
 *
 * Uses only Node built-ins (no chokidar dependency).
 */

import { watch } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const THEME_PATH = resolve(ROOT, 'src/react/theme.ts');
const GENERATOR = resolve(ROOT, 'scripts/generate-tokens-css.mjs');

function runGenerator() {
  try {
    execFileSync(process.execPath, [GENERATOR], { stdio: 'inherit', cwd: ROOT });
  } catch {
    console.error('[watch-react] generate-tokens-css.mjs failed — see output above.');
  }
}

// ── Initial token generation ─────────────────────────────────────────────────
console.log('[watch-react] Generating tokens.css…');
runGenerator();

// ── Start Vite in watch mode ─────────────────────────────────────────────────
console.log('[watch-react] Starting vite build --watch…');
const vite = spawn(
  process.execPath,
  ['node_modules/.bin/vite', 'build', '--watch'],
  { stdio: 'inherit', cwd: ROOT }
);

vite.on('exit', (code) => process.exit(code ?? 0));

// ── Watch theme.ts and re-generate tokens on change ─────────────────────────
let debounceTimer = null;

watch(THEME_PATH, () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    console.log('[watch-react] theme.ts changed — regenerating tokens.css…');
    runGenerator();
  }, 150);
});

console.log(`[watch-react] Watching ${THEME_PATH} for token changes.`);

// ── Forward termination signals to Vite ─────────────────────────────────────
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    vite.kill(sig);
    process.exit(0);
  });
}
