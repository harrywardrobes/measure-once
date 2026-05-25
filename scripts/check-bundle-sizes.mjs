#!/usr/bin/env node
/**
 * Post-build bundle-size check for the React island.
 *
 * Reads every .js file under public/react/, computes its gzip size, prints a
 * summary table, and exits non-zero if any always-loaded chunk exceeds its
 * threshold.
 *
 * Run automatically via `npm run build:react` (wired as a postbuild step).
 * Run in isolation:  node scripts/check-bundle-sizes.mjs
 *
 * Thresholds (kB gzip)
 * ────────────────────
 * Always-loaded chunks are downloaded on every page. Thresholds are set with
 * ~30 % headroom above the measured sizes at the time of introduction so that
 * legitimate growth has room while regressions are still caught.
 *
 *   Chunk pattern          Threshold   Measured at introduction
 *   ─────────────────────  ─────────   ────────────────────────
 *   main.js                  20 kB     7.6 kB
 *   vendor-react-*           58 kB     44.5 kB  (react + react-dom + scheduler)
 *   vendor-emotion-*         14 kB     10.5 kB  (@emotion/*)
 *   vendor-mui-*            136 kB    104.4 kB  (@mui/material + @mui/system + …)
 *   vendor-mui-icons-*       15 kB     4.4 kB   (icons used by GlobalHeader/BottomNav)
 *
 * Lazy chunks (vendor-zxcvbn) are printed in the table but never fail the
 * build — only a warning is emitted if they grow beyond their soft limit.
 */

import { gzipSync } from 'zlib';
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REACT_DIR = resolve(__dirname, '..', 'public', 'react');
const CHUNKS_DIR = join(REACT_DIR, 'chunks');

// ── Threshold definitions ────────────────────────────────────────────────────
// Each entry matches chunks whose basename starts with `prefix`.
// `threshold` is the maximum allowed gzip size in bytes (fail if exceeded).
// `lazy: true` means the chunk is not always-loaded — no hard failure, but a
// soft `warnAt` limit prints a warning without failing the build.

const THRESHOLDS = [
  {
    prefix: 'main.js',
    label: 'main (entry)',
    alwaysLoaded: true,
    threshold: 20 * 1024,       // 20 kB — mount runtime + shell UI
  },
  // More-specific vendor-* prefixes must come before any shorter prefix.
  {
    prefix: 'vendor-mui-icons',
    label: 'vendor-mui-icons',
    alwaysLoaded: true,
    threshold: 15 * 1024,       // 15 kB — only icons used by GlobalHeader/BottomNav
  },
  {
    prefix: 'vendor-zxcvbn',
    label: 'vendor-zxcvbn (lazy)',
    alwaysLoaded: false,
    warnAt: 450 * 1024,         // 450 kB — warn if zxcvbn swells unexpectedly
  },
  {
    prefix: 'vendor-react',
    label: 'vendor-react',
    alwaysLoaded: true,
    threshold: 58 * 1024,       // 58 kB — react + react-dom + scheduler
  },
  {
    prefix: 'vendor-emotion',
    label: 'vendor-emotion',
    alwaysLoaded: true,
    threshold: 14 * 1024,       // 14 kB — @emotion/*
  },
  {
    prefix: 'vendor-mui',
    label: 'vendor-mui',
    alwaysLoaded: true,
    threshold: 136 * 1024,      // 136 kB — @mui/material + @mui/system + …
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function gzipSize(filePath) {
  const buf = readFileSync(filePath);
  return gzipSync(buf, { level: 9 }).length;
}

function kbStr(bytes) {
  return (bytes / 1024).toFixed(1) + ' kB';
}

function collectFiles() {
  const files = [];

  // Entry: public/react/main.js (and any other .js at the root)
  for (const name of readdirSync(REACT_DIR)) {
    if (!name.endsWith('.js') || name.endsWith('.map.js')) continue;
    if (statSync(join(REACT_DIR, name)).isDirectory()) continue;
    files.push({ path: join(REACT_DIR, name), name });
  }

  // Chunks: public/react/chunks/*.js
  for (const name of readdirSync(CHUNKS_DIR).sort()) {
    if (!name.endsWith('.js') || name.endsWith('.map.js')) continue;
    files.push({ path: join(CHUNKS_DIR, name), name });
  }

  return files;
}

function matchThreshold(name) {
  // More-specific prefixes must be listed before catch-alls in THRESHOLDS.
  for (const t of THRESHOLDS) {
    if (name.startsWith(t.prefix)) return t;
  }
  return null; // lazy/page chunk — no threshold
}

// ── Main ─────────────────────────────────────────────────────────────────────

const files = collectFiles();

const rows = files.map(({ path, name }) => {
  const gz = gzipSize(path);
  const raw = statSync(path).size;
  const t = matchThreshold(name);
  return { name, gz, raw, threshold: t };
});

// Sort: always-loaded first (by gz desc), then lazy, then page chunks
rows.sort((a, b) => {
  const aLoaded = a.threshold?.alwaysLoaded ?? false;
  const bLoaded = b.threshold?.alwaysLoaded ?? false;
  if (aLoaded !== bLoaded) return bLoaded ? 1 : -1;
  return b.gz - a.gz;
});

// ── Print table ──────────────────────────────────────────────────────────────

const COL = {
  name: 42,
  gz: 12,
  raw: 12,
  status: 20,
};

function pad(str, len) {
  return str.toString().padEnd(len);
}

function padL(str, len) {
  return str.toString().padStart(len);
}

console.log('');
console.log('Bundle size report (gzip)');
console.log('─'.repeat(COL.name + COL.gz + COL.raw + COL.status));
console.log(
  pad('Chunk', COL.name) +
  padL('gz size', COL.gz) +
  padL('raw size', COL.raw) +
  '  Status'
);
console.log('─'.repeat(COL.name + COL.gz + COL.raw + COL.status));

let failures = 0;
const warnings = [];

for (const row of rows) {
  const { name, gz, raw, threshold: t } = row;
  let status = '';

  if (t?.alwaysLoaded && t.threshold) {
    const pct = Math.round((gz / t.threshold) * 100);
    if (gz > t.threshold) {
      status = `FAIL  ${pct}% of ${kbStr(t.threshold)} limit`;
      failures++;
    } else {
      status = `ok    ${pct}% of ${kbStr(t.threshold)} limit`;
    }
  } else if (t?.warnAt && gz > t.warnAt) {
    status = `WARN  ${kbStr(gz)} > soft ${kbStr(t.warnAt)}`;
    warnings.push(name);
  } else if (t?.alwaysLoaded === false) {
    status = 'lazy  (no hard limit)';
  } else {
    status = 'lazy  page chunk';
  }

  console.log(
    pad(name, COL.name) +
    padL(kbStr(gz), COL.gz) +
    padL(kbStr(raw), COL.raw) +
    '  ' + status
  );
}

console.log('─'.repeat(COL.name + COL.gz + COL.raw + COL.status));

// ── Summary ──────────────────────────────────────────────────────────────────

const alwaysRows = rows.filter(r => r.threshold?.alwaysLoaded);
const totalAlwaysGz = alwaysRows.reduce((s, r) => s + r.gz, 0);
console.log(`\nTotal always-loaded:  ${kbStr(totalAlwaysGz)} gzip`);

if (warnings.length > 0) {
  console.log(`\n⚠  Soft-limit warnings:`);
  for (const w of warnings) console.log(`   ${w}`);
}

// ── Markdown report ──────────────────────────────────────────────────────────

const reportDir = resolve(__dirname, '..', 'test-results');
mkdirSync(reportDir, { recursive: true });

const now = new Date().toISOString();
const passed = rows.filter(r => r.threshold?.alwaysLoaded && r.gz <= r.threshold.threshold).length;
const checked = rows.filter(r => r.threshold?.alwaysLoaded).length;

const mdRows = rows.map(({ name, gz, raw, threshold: t }) => {
  let status = 'lazy';
  if (t?.alwaysLoaded && t.threshold) {
    const pct = Math.round((gz / t.threshold) * 100);
    status = gz > t.threshold
      ? `FAIL — ${kbStr(gz)} > ${kbStr(t.threshold)} limit (${pct}%)`
      : `ok — ${kbStr(gz)} / ${kbStr(t.threshold)} (${pct}%)`;
  } else if (t?.warnAt && gz > t.warnAt) {
    status = `WARN — ${kbStr(gz)} > soft ${kbStr(t.warnAt)}`;
  }
  return `| ${name} | ${kbStr(gz)} | ${kbStr(raw)} | ${status} |`;
}).join('\n');

const mdContent = `# Bundle Sizes

- Date: ${now}
- Command: \`npm run test:bundle-sizes\`

## Summary

- Checked: ${checked} always-loaded chunk(s)
- Passed: ${passed} / ${checked}
- Failed: ${failures} / ${checked}
- Total always-loaded: ${kbStr(totalAlwaysGz)} gzip
- Result: ${failures > 0 ? `FAIL — ${failures} chunk(s) exceed threshold` : 'PASS — all chunks within threshold'}

## Results

| Chunk | gz size | raw size | Status |
|---|---|---|---|
${mdRows}
`;

writeFileSync(resolve(reportDir, 'bundle-sizes.md'), mdContent);

// ── Exit ─────────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(
    `\n✖  ${failures} always-loaded chunk(s) exceed their gzip threshold.\n` +
    `   Reduce bundle size or raise the threshold in scripts/check-bundle-sizes.mjs.\n`
  );
  process.exit(1);
}

console.log(`\n✔  All always-loaded chunks within threshold.\n`);
