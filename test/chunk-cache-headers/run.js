'use strict';
// test/chunk-cache-headers/run.js
//
// Verifies that the Express static-file middleware applies the correct
// Cache-Control headers for content-addressed chunks vs the stable entry point.
//
// Probes
// ──────
// [CHUNK]       GET /react/chunks/<hashed-chunk>.js
//               → Cache-Control must contain "immutable"
// [ASSETS]      GET /react/assets/<hashed-asset>.<ext>
//               → Cache-Control must contain "immutable"
//               A synthetic file (test-asset-probe-<hex>.css) is written when
//               no real build output exists in public/react/assets/ so the probe
//               always runs and is never silently skipped.
// [ASSETS-CSS]  GET /react/assets/<hashed-asset>.css (if any exist in the build)
//               → Cache-Control must contain "immutable"
// [ASSETS-FONT] GET /react/assets/<hashed-font>.<ext> (if any exist in the build)
//               → Cache-Control must contain "immutable"
// [MAIN]        GET /react/main.js
//               → Cache-Control must NOT contain "immutable"
//
// No Puppeteer, no seed users, no database writes needed.
// The static-file routes are mounted before authentication, so GET requests
// reach Express.static without a session cookie.
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:chunk-cache-headers
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:chunk-cache-headers

const fs   = require('fs');
const path = require('path');

require('dotenv').config();

const {
  spawnServer,
  waitForServer,
  BASE,
} = require('../privileges/harness');

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'chunk-cache-headers.md'
);

const CHUNKS_DIR = path.join(__dirname, '..', '..', 'public', 'react', 'chunks');
const ASSETS_DIR = path.join(__dirname, '..', '..', 'public', 'react', 'assets');

const FONT_EXTENSIONS = ['.woff2', '.woff', '.ttf', '.otf', '.eot'];

// ── helpers ───────────────────────────────────────────────────────────────────

function firstFileByExt(dir, ext) {
  try {
    const entries = fs.readdirSync(dir).filter(
      f => f.endsWith(ext) && !f.endsWith('.map')
    );
    return entries.length > 0 ? entries[0] : null;
  } catch {
    return null;
  }
}

function firstFontFile(dir) {
  try {
    const entries = fs.readdirSync(dir).filter(
      f => FONT_EXTENSIONS.some(ext => f.endsWith(ext)) && !f.endsWith('.map')
    );
    return entries.length > 0 ? entries[0] : null;
  } catch {
    return null;
  }
}

/**
 * Return the first file (any extension) in dir whose name looks like a
 * content-addressed Vite output (contains a hyphen followed by 8+ hex chars
 * before the extension).  Falls back to any file if none match the pattern.
 * Returns null when the directory is empty or unreadable.
 */
function firstHashedFile(dir) {
  try {
    const entries = fs.readdirSync(dir).filter(f => !f.endsWith('.map'));
    if (entries.length === 0) return null;
    const hashed = entries.find(f => /[_-][0-9a-f]{8,}\.[a-z0-9]+$/i.test(f));
    return hashed || entries[0];
  } catch {
    return null;
  }
}

async function headRequest(url) {
  const res = await fetch(url, { method: 'HEAD' });
  return {
    status: res.status,
    cacheControl: res.headers.get('cache-control') || '',
  };
}

// ── run ───────────────────────────────────────────────────────────────────────

async function main() {
  const results = [];
  let allPassed = true;
  let serverHandle = null;
  let syntheticAssetPath = null;

  function record(probe, url, pass, detail) {
    results.push({ probe, url, pass, detail });
    const icon = pass ? 'PASS' : 'FAIL';
    console.log(`[${icon}] [${probe}] ${detail}`);
    if (!pass) allPassed = false;
  }

  try {
    // ── preflight: verify build output exists ─────────────────────────────────
    const chunkFile  = firstFileByExt(CHUNKS_DIR, '.js');
    const cssFile    = firstFileByExt(ASSETS_DIR, '.css');
    const fontFile   = firstFontFile(ASSETS_DIR);

    if (!chunkFile) {
      console.error('[chunk-cache-headers] No .js files found in public/react/chunks/.');
      console.error('  Run `npm run build:react` before running this test.');
      process.exit(1);
    }

    // ── preflight: ensure assets dir has at least one file to probe ───────────
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    let assetsFile = firstHashedFile(ASSETS_DIR);

    if (!assetsFile) {
      // Write a synthetic content-addressed file so the ASSETS probe always
      // exercises the /react/assets static mount rather than silently skipping.
      const hex = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
      assetsFile = `test-asset-probe-${hex}.css`;
      syntheticAssetPath = path.join(ASSETS_DIR, assetsFile);
      fs.writeFileSync(syntheticAssetPath, '/* chunk-cache-headers test probe */\n');
      console.log(`[chunk-cache-headers] Wrote synthetic asset: ${assetsFile}`);
    }

    // ── start server ──────────────────────────────────────────────────────────
    serverHandle = spawnServer();
    await waitForServer(20000);

    // ── [CHUNK] hashed chunk → must have immutable ────────────────────────────
    {
      const url = `${BASE}/react/chunks/${chunkFile}`;
      const { status, cacheControl } = await headRequest(url);
      const hasImmutable = cacheControl.includes('immutable');
      record(
        'CHUNK', url,
        status === 200 && hasImmutable,
        `status=${status} Cache-Control="${cacheControl}" → immutable=${hasImmutable}`,
      );
    }

    // ── [ASSETS] hashed asset → must have immutable ───────────────────────────
    {
      const url = `${BASE}/react/assets/${assetsFile}`;
      const { status, cacheControl } = await headRequest(url);
      const hasImmutable = cacheControl.includes('immutable');
      record(
        'ASSETS', url,
        status === 200 && hasImmutable,
        `status=${status} Cache-Control="${cacheControl}" → immutable=${hasImmutable}`,
      );
    }

    // ── [ASSETS-CSS] hashed CSS → must have immutable (if present) ───────────
    if (cssFile) {
      const url = `${BASE}/react/assets/${cssFile}`;
      const { status, cacheControl } = await headRequest(url);
      const hasImmutable = cacheControl.includes('immutable');
      record(
        'ASSETS-CSS', url,
        status === 200 && hasImmutable,
        `status=${status} Cache-Control="${cacheControl}" → immutable=${hasImmutable}`,
      );
    } else {
      console.log('[SKIP] [ASSETS-CSS] No .css files found in public/react/assets/ — skipped');
    }

    // ── [ASSETS-FONT] hashed font → must have immutable (if present) ─────────
    if (fontFile) {
      const url = `${BASE}/react/assets/${fontFile}`;
      const { status, cacheControl } = await headRequest(url);
      const hasImmutable = cacheControl.includes('immutable');
      record(
        'ASSETS-FONT', url,
        status === 200 && hasImmutable,
        `status=${status} Cache-Control="${cacheControl}" → immutable=${hasImmutable}`,
      );
    } else {
      console.log('[SKIP] [ASSETS-FONT] No font files found in public/react/assets/ — skipped');
    }

    // ── [MAIN] stable entry point → must NOT have immutable ──────────────────
    {
      const url = `${BASE}/react/main.js`;
      const { status, cacheControl } = await headRequest(url);
      const hasImmutable = cacheControl.includes('immutable');
      record(
        'MAIN', url,
        status === 200 && !hasImmutable,
        `status=${status} Cache-Control="${cacheControl}" → immutable=${hasImmutable} (want false)`,
      );
    }
  } finally {
    if (serverHandle) serverHandle.child.kill();
    if (syntheticAssetPath) {
      try { fs.unlinkSync(syntheticAssetPath); } catch { /* ignore */ }
    }
  }

  // ── report ────────────────────────────────────────────────────────────────
  const lines = [
    '# chunk-cache-headers',
    '',
    'Verifies that hashed React chunks, assets, CSS files, and font files are',
    'served with `immutable` Cache-Control, and that the stable `main.js` entry',
    'point is NOT served as immutable. The ASSETS probe uses a synthetic file',
    'when no real build output exists in `public/react/assets/` so it always',
    'runs and is never silently skipped.',
    '',
    '| probe | url | result | detail |',
    '| ----- | --- | ------ | ------ |',
  ];
  for (const r of results) {
    lines.push(
      `| \`${r.probe}\` | \`${r.url}\` | ${r.pass ? 'PASS' : '**FAIL**'} | ${r.detail} |`,
    );
  }
  lines.push('');
  const failCount = results.filter(r => !r.pass).length;
  if (failCount === 0) {
    lines.push(`**All ${results.length} probes passed.**`);
  } else {
    lines.push(`**${failCount} probe(s) failed.**`);
  }

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, lines.join('\n') + '\n');
  console.log(`[chunk-cache-headers] Report → ${REPORT_PATH}`);

  if (!allPassed) process.exit(1);
}

main().catch(err => {
  console.error('[chunk-cache-headers] Unexpected error:', err);
  process.exit(1);
});
