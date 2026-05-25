'use strict';
// test/chunk-cache-headers/run.js
//
// Verifies that the Express static-file middleware applies the correct
// Cache-Control headers for content-addressed chunks vs the stable entry point.
//
// Probes
// ──────
// [CHUNK]   GET /react/chunks/<hashed-chunk>.js
//           → Cache-Control must contain "immutable"
// [ASSETS]  GET /react/assets/<hashed-asset>.js  (if any exist in the build)
//           → Cache-Control must contain "immutable"
// [MAIN]    GET /react/main.js
//           → Cache-Control must NOT contain "immutable"
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

// ── helpers ───────────────────────────────────────────────────────────────────

function firstJsFile(dir) {
  try {
    const entries = fs.readdirSync(dir).filter(f => f.endsWith('.js') && !f.endsWith('.map'));
    return entries.length > 0 ? entries[0] : null;
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

  function record(probe, url, pass, detail) {
    results.push({ probe, url, pass, detail });
    const icon = pass ? 'PASS' : 'FAIL';
    console.log(`[${icon}] [${probe}] ${detail}`);
    if (!pass) allPassed = false;
  }

  try {
    // ── preflight: verify build output exists ─────────────────────────────────
    const chunkFile  = firstJsFile(CHUNKS_DIR);
    const assetsFile = firstJsFile(ASSETS_DIR);

    if (!chunkFile) {
      console.error('[chunk-cache-headers] No .js files found in public/react/chunks/.');
      console.error('  Run `npm run build:react` before running this test.');
      process.exit(1);
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

    // ── [ASSETS] hashed asset → must have immutable (if present) ─────────────
    if (assetsFile) {
      const url = `${BASE}/react/assets/${assetsFile}`;
      const { status, cacheControl } = await headRequest(url);
      const hasImmutable = cacheControl.includes('immutable');
      record(
        'ASSETS', url,
        status === 200 && hasImmutable,
        `status=${status} Cache-Control="${cacheControl}" → immutable=${hasImmutable}`,
      );
    } else {
      console.log('[SKIP] [ASSETS] No .js files found in public/react/assets/ — skipped');
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
  }

  // ── report ────────────────────────────────────────────────────────────────
  const lines = [
    '# chunk-cache-headers',
    '',
    'Verifies that hashed React chunks are served with `immutable` Cache-Control',
    'and that the stable `main.js` entry point is NOT served as immutable.',
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
