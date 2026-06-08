#!/usr/bin/env node
/**
 * check-storybook-output-clean.mjs
 *
 * Asserts that no application files from public/ — for example the React
 * bundle, page stylesheets, fonts, or images — were copied into the
 * Storybook output root.
 *
 * This guards the `viteFinal: config.publicDir = false` hook in
 * .storybook/main.ts against accidental regression (e.g. removing viteFinal,
 * changing the output dir, or a Storybook upgrade that changes default
 * behaviour).
 *
 * The set of application files to check for is derived at runtime from every
 * top-level entry directly under public/ (files AND directories, of any
 * extension) so the list stays accurate as the public/ surface changes. A
 * publicDir leak copies the whole public/ tree — CSS, JSON, images, the React
 * bundle, the service worker, icon and upload folders — not just .html/.js, so
 * the checklist must cover all of them.
 *
 * By default the script builds Storybook into a temporary directory and
 * inspects that.  When the flag --out-dir <path> is supplied (or the env var
 * STORYBOOK_OUT_DIR is set) and that directory already exists, the build step
 * is skipped and the existing output is inspected directly.  This is useful
 * in CI pipelines that already ran `build:storybook` earlier in the pipeline.
 *
 * Exit codes:
 *   0 — output is clean (no app files leaked)
 *   1 — build failed, or one or more app files found in the output root
 *
 * Usage:
 *   node scripts/check-storybook-output-clean.mjs
 *   node scripts/check-storybook-output-clean.mjs --out-dir public/storybook
 *   STORYBOOK_OUT_DIR=public/storybook node scripts/check-storybook-output-clean.mjs
 *
 * Wired into CI via: npm run test:storybook-output-clean
 */

import { readdirSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
const RESULTS_DIR = join(ROOT, 'test-results');

mkdirSync(RESULTS_DIR, { recursive: true });

// ── Resolve output directory from flag / env var / default ───────────────────
// Priority: --out-dir CLI flag > STORYBOOK_OUT_DIR env var > temp dir (build)
function parseOutDirFlag(argv) {
  const idx = argv.indexOf('--out-dir');
  if (idx !== -1 && argv[idx + 1]) return resolve(ROOT, argv[idx + 1]);
  return null;
}

const flagOutDir = parseOutDirFlag(process.argv.slice(2));
const envOutDir = process.env.STORYBOOK_OUT_DIR
  ? resolve(ROOT, process.env.STORYBOOK_OUT_DIR)
  : null;

const suppliedOutDir = flagOutDir ?? envOutDir;

const TEMP_OUT_DIR = join(tmpdir(), 'storybook-clean-check');

let OUT_DIR;
let skipBuild = false;

if (suppliedOutDir && existsSync(suppliedOutDir)) {
  OUT_DIR = suppliedOutDir;
  skipBuild = true;
  console.log(
    `[storybook-output-clean] Reusing existing Storybook output at ${OUT_DIR} (skipping build)\n`,
  );
} else {
  OUT_DIR = TEMP_OUT_DIR;
  if (suppliedOutDir) {
    console.log(
      `[storybook-output-clean] Supplied path ${suppliedOutDir} does not exist — falling back to a fresh build\n`,
    );
  }
}

// ── Derive app file names from public/ at runtime ────────────────────────────
// This way the check automatically picks up new pages, assets and folders
// without needing a manual update to this script. We treat EVERY top-level
// entry under public/ — files and directories, any extension — as a potential
// leak indicator, because removing the publicDir=false hook copies the whole
// public/ tree into the output root.
const publicDir = join(ROOT, 'public');
const publicEntries = readdirSync(publicDir);

// A handful of names legitimately appear in a clean Storybook build for reasons
// unrelated to a publicDir leak. Exclude them from the checklist so they never
// raise a false positive:
//   - `fonts`     — mirrored into the output via staticDirs in .storybook/main.ts
//   - `assets`    — Storybook emits its own bundled assets directory by this name
//   - `storybook` — the Storybook build output directory itself (public/storybook)
const STORYBOOK_LEGIT_COLLISIONS = new Set(['fonts', 'assets', 'storybook']);

const appEntries = new Set(
  publicEntries.filter(f => !STORYBOOK_LEGIT_COLLISIONS.has(f)),
);

// Guard against the derivation silently yielding nothing (the exact failure
// mode that made this check pass unconditionally after the EJS migration). If
// public/ has no checkable entries the check is no longer meaningful, so fail
// loudly rather than rubber-stamp the build.
if (appEntries.size === 0) {
  process.stderr.write(
    '\n[storybook-output-clean] ❌ No checkable entries found under public/ ' +
    '(after excluding legitimate Storybook collisions).\n' +
    'The leak-detection checklist is empty, so this guard cannot catch a ' +
    'publicDir regression. Update this script for the current public/ layout.\n',
  );
  const now = new Date().toISOString();
  const md =
    `# Storybook Output Clean — ${now}\n\n` +
    `## Summary\n\n` +
    `- ❌ FAIL: leak-detection checklist derived from public/ is empty.\n` +
    `\n---\n_Generated by \`scripts/check-storybook-output-clean.mjs\`_\n`;
  writeFileSync(join(RESULTS_DIR, 'storybook-output-clean.md'), md, 'utf8');
  process.exit(1);
}

// ── Build Storybook (unless skipping) ────────────────────────────────────────
if (!skipBuild) {
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  console.log(`[storybook-output-clean] Building Storybook → ${OUT_DIR} …\n`);

  const buildResult = spawnSync(
    'npx',
    ['storybook', 'build', '-o', OUT_DIR, '--quiet'],
    { stdio: 'inherit', shell: false, cwd: ROOT },
  );

  if (buildResult.status !== 0) {
    process.stderr.write('\n[storybook-output-clean] ❌ Storybook build failed.\n');

    const now = new Date().toISOString();
    const md =
      `# Storybook Output Clean — ${now}\n\n` +
      `## Summary\n\n` +
      `- ❌ FAIL: Storybook build exited with status ${buildResult.status ?? 'unknown'}.\n` +
      `\n---\n_Generated by \`scripts/check-storybook-output-clean.mjs\`_\n`;
    writeFileSync(join(RESULTS_DIR, 'storybook-output-clean.md'), md, 'utf8');

    process.exit(1);
  }
}

// ── Inspect output root for leaked app files ──────────────────────────────────
const outputRoot = readdirSync(OUT_DIR);

const leaked = outputRoot.filter(f => appEntries.has(f)).sort();

const passed = leaked.length === 0;
const icon   = passed ? '✅' : '❌';
const status = passed ? 'PASS' : 'FAIL';

const summary = passed
  ? 'No application files leaked into the Storybook output root.'
  : `${leaked.length} application file(s) leaked into the Storybook output root: ${leaked.join(', ')}`;

console.log(`\n[storybook-output-clean] ${icon} ${summary}`);

if (!passed) {
  process.stderr.write(
    '\nThese application files should not appear in the Storybook build output.\n' +
    'The viteFinal hook in .storybook/main.ts sets `config.publicDir = false`\n' +
    'to suppress Vite\'s default behaviour of copying the entire public/ directory\n' +
    'into the output folder. Verify that hook is still present and returning the\n' +
    'modified config.\n\n',
  );
}

// ── Write test-results report ─────────────────────────────────────────────────
const now = new Date().toISOString();
let md = `# Storybook Output Clean — ${now}\n\n`;
md += `## Summary\n\n`;
md += `- ${icon} ${status}: ${summary}\n`;

if (skipBuild) {
  md += `\n> Build skipped — inspected existing output at \`${OUT_DIR}\`\n`;
}

if (!passed) {
  md += `\n## Leaked files\n\n`;
  for (const f of leaked) md += `- \`${f}\`\n`;
  md += `\n## What to fix\n\n`;
  md += `The \`viteFinal\` hook in \`.storybook/main.ts\` must set \`config.publicDir = false\`.\n`;
  md += `Without it, Vite copies every file from \`public/\` into the Storybook output root.\n`;
}

md += `\n---\n_Generated by \`scripts/check-storybook-output-clean.mjs\`_\n`;

writeFileSync(join(RESULTS_DIR, 'storybook-output-clean.md'), md, 'utf8');

process.exit(passed ? 0 : 1);
