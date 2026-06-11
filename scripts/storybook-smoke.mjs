#!/usr/bin/env node
/**
 * storybook-smoke.mjs
 *
 * Builds Storybook to a temporary directory, spins up a lightweight static
 * HTTP server, then uses Puppeteer to load every story in the built
 * `index.json` through the Storybook iframe and asserts that none of them
 * throw a render error or stay blank within a timeout.
 *
 * Error detection — a story is considered broken when any of the following
 * occur within RENDER_TIMEOUT_MS:
 *   (A) An uncaught exception fires in the page (page 'pageerror' event).
 *   (B) The Storybook error-boundary overlay is visible in the DOM
 *       (`#error-message`, `.sb-errordisplay`, or `[data-error-boundary]`).
 *   (C) `#storybook-root` is still completely empty after the timeout.
 *   (D) A `console.error` that starts with "The above error" (React's
 *       error-boundary rethrow message) is recorded.
 *
 * The script runs up to CONCURRENCY story pages simultaneously to keep the
 * total runtime reasonable (≈ 41 stories × ~1–2 s each ≈ under 2 minutes).
 *
 * Exit codes:
 *   0 — all stories rendered without detected errors
 *   1 — one or more stories failed, or Storybook build / launch failed
 *   2 — configuration error (puppeteer missing, no stories found, etc.)
 *
 * Usage:
 *   npm run test:storybook-smoke
 *
 * Wired into CI via `scripts/run-ci.mjs` (step: test:storybook-smoke).
 */

import { createServer }                               from 'http';
import { readFileSync, writeFileSync, mkdirSync,
         mkdtempSync, existsSync, rmSync, statSync }  from 'fs';
import { join, extname, resolve, normalize }          from 'path';
import { fileURLToPath }                              from 'url';
import { spawnSync }                                  from 'child_process';
import { tmpdir }                                     from 'os';

const __dirname    = fileURLToPath(new URL('.', import.meta.url));
const ROOT         = resolve(__dirname, '..');
const RESULTS_DIR  = join(ROOT, 'test-results');
// When STORYBOOK_OUT_DIR is set (e.g. by run-ci.mjs after a shared
// build:storybook step), reuse that pre-built directory instead of
// rebuilding. Otherwise create a unique temp dir so parallel CI runs don't
// collide.
const PREBUILT_DIR = process.env.STORYBOOK_OUT_DIR
  ? resolve(ROOT, process.env.STORYBOOK_OUT_DIR)
  : null;
const OUT_DIR      = PREBUILT_DIR ?? mkdtempSync(join(tmpdir(), 'storybook-smoke-'));

const RENDER_TIMEOUT_MS = 10_000;
const CONCURRENCY       = 4;

mkdirSync(RESULTS_DIR, { recursive: true });

// ── MIME map ──────────────────────────────────────────────────────────────────
const MIME = {
  '.html':  'text/html; charset=utf-8',
  '.js':    'application/javascript; charset=utf-8',
  '.mjs':   'application/javascript; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.json':  'application/json; charset=utf-8',
  '.svg':   'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff':  'font/woff',
  '.ttf':   'font/ttf',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.ico':   'image/x-icon',
};

// ── Static file server ────────────────────────────────────────────────────────
/**
 * Start a simple static file server rooted at `dir`.
 * Returns { server, port }.
 */
function startStaticServer(dir) {
  const rootDir = resolve(dir);
  const server = createServer((req, res) => {
    let pathname = req.url.split('?')[0];
    if (pathname === '/' || pathname === '') pathname = '/index.html';

    // Resolve and guard against path traversal outside the root.
    const filePath = resolve(join(rootDir, normalize(pathname)));
    if (!filePath.startsWith(rootDir + '/') && filePath !== rootDir) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    let target = filePath;
    if (!existsSync(target)) {
      // Fallback: if a path without extension was requested, try .html
      if (!extname(pathname)) {
        const withHtml = filePath + '.html';
        if (existsSync(withHtml)) target = withHtml;
      }
      if (!existsSync(target)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
    }

    let stat;
    try { stat = statSync(target); } catch {
      res.writeHead(500); res.end(); return;
    }
    if (stat.isDirectory()) {
      const idx = join(target, 'index.html');
      if (existsSync(idx)) {
        target = idx;
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
    }

    const ext  = extname(target).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    let body;
    try { body = readFileSync(target); } catch {
      res.writeHead(500); res.end(); return;
    }
    res.writeHead(200, {
      'Content-Type':  mime,
      'Cache-Control': 'no-cache',
      'Content-Length': body.length,
    });
    res.end(body);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

// ── Puppeteer helper ──────────────────────────────────────────────────────────
async function getChromiumPath() {
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  try {
    const { findChromium } = require(
      join(ROOT, 'test', 'shared', 'find-chromium.js'),
    );
    return findChromium() || undefined;
  } catch {
    return undefined;
  }
}

// ── Pool: run async tasks with bounded concurrency ────────────────────────────
async function pool(items, concurrency, fn) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const findings = [];

  function record(storyId, title, ok, detail) {
    findings.push({ storyId, title, ok, detail: detail || '' });
    const mark = ok ? '  ✓' : '  ✗';
    const label = storyId || title;
    process.stdout.write(`${mark}  ${label}${detail ? `  — ${detail}` : ''}\n`);
  }

  // ── 1. Build (or reuse) Storybook ───────────────────────────────────────────
  if (PREBUILT_DIR) {
    if (!existsSync(PREBUILT_DIR)) {
      process.stderr.write(
        `  ❌ STORYBOOK_OUT_DIR="${process.env.STORYBOOK_OUT_DIR}" does not exist.\n` +
        `     Run \`npm run build:storybook\` first.\n`,
      );
      await writeReport(findings, `STORYBOOK_OUT_DIR not found: ${PREBUILT_DIR}`);
      process.exit(1);
    }
    process.stdout.write(`\n  storybook-smoke — reusing pre-built output at ${PREBUILT_DIR}\n\n`);
  } else {
    process.stdout.write('\n  storybook-smoke — build\n\n');
    if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
    mkdirSync(OUT_DIR, { recursive: true });

    process.stdout.write(`  Building Storybook → ${OUT_DIR} …\n`);
    const buildStart = Date.now();
    const buildResult = spawnSync(
      'npx',
      ['storybook', 'build', '-o', OUT_DIR, '--quiet'],
      { stdio: 'inherit', shell: false, cwd: ROOT },
    );

    if (buildResult.status !== 0) {
      process.stderr.write(
        `\n  ❌ Storybook build failed (exit ${buildResult.status ?? 'unknown'}).\n`,
      );
      await writeReport(findings, 'Storybook build failed.');
      process.exit(1);
    }
    process.stdout.write(
      `  Build complete in ${((Date.now() - buildStart) / 1000).toFixed(1)}s\n\n`,
    );
  }

  // ── 2. Load story index ─────────────────────────────────────────────────────
  const indexPath = join(OUT_DIR, 'index.json');
  if (!existsSync(indexPath)) {
    process.stderr.write('  ❌ index.json not found in Storybook build output.\n');
    await writeReport(findings, 'index.json missing from build.');
    process.exit(1);
  }

  const index   = JSON.parse(readFileSync(indexPath, 'utf8'));
  const entries = Object.values(index.entries || {});
  const stories = entries.filter(e => e.type === 'story');

  if (stories.length === 0) {
    process.stderr.write('  ❌ No stories found in index.json.\n');
    await writeReport(findings, 'No stories found.');
    process.exit(2);
  }

  process.stdout.write(
    `  storybook-smoke — running ${stories.length} stories (concurrency ${CONCURRENCY})\n\n`,
  );

  // ── 3. Start static server ──────────────────────────────────────────────────
  const { server, port } = await startStaticServer(OUT_DIR);
  const baseUrl = `http://127.0.0.1:${port}`;
  process.stdout.write(`  Serving Storybook at ${baseUrl}\n\n`);

  // ── 4. Launch browser ───────────────────────────────────────────────────────
  let puppeteer;
  try { puppeteer = (await import('puppeteer')).default; } catch {
    process.stderr.write('  ❌ puppeteer is not installed.\n');
    server.close();
    await writeReport(findings, 'puppeteer not installed.');
    process.exit(2);
  }

  const executablePath = await getChromiumPath();
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      defaultViewport: { width: 1280, height: 900 },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  } catch (e) {
    process.stderr.write(`  ❌ Could not launch browser: ${e.message}\n`);
    server.close();
    await writeReport(findings, `Browser launch failed: ${e.message}`);
    process.exit(1);
  }

  // ── 5. Test each story ──────────────────────────────────────────────────────
  const smokeStart = Date.now();
  try {
    await pool(stories, CONCURRENCY, async (story) => {
      const url = `${baseUrl}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`;
      const errors = [];
      let page;

      try {
        page = await browser.newPage();

        // Suppress expected Storybook "passive event listener" and font warnings
        page.on('pageerror', (err) => {
          errors.push(`pageerror: ${err.message}`);
        });

        page.on('console', (msg) => {
          if (msg.type() === 'error') {
            const text = msg.text();
            // React's error-boundary rethrow starts with "The above error"
            if (text.startsWith('The above error')) {
              errors.push(`console.error: ${text.slice(0, 200)}`);
            }
          }
        });

        await page.goto(url, {
          waitUntil: 'networkidle0',
          timeout:   RENDER_TIMEOUT_MS,
        });

        // Brief settle time for any async renders (e.g. useEffect → useState)
        await new Promise(r => setTimeout(r, 400));

        // (B) Check for Storybook error-boundary overlay
        const hasErrorOverlay = await page.evaluate(() => {
          const selectors = [
            '#error-message',
            '.sb-errordisplay',
            '[data-error-boundary]',
          ];
          return selectors.some(sel => {
            const el = document.querySelector(sel);
            return el && el.offsetParent !== null;
          });
        }).catch(() => false);

        if (hasErrorOverlay) {
          errors.push('Storybook error overlay is visible');
        }

        // (C) Check that #storybook-root is not empty
        const rootEmpty = await page.evaluate(() => {
          const root = document.getElementById('storybook-root');
          return !root || root.children.length === 0;
        }).catch(() => true);

        if (rootEmpty) {
          errors.push('#storybook-root is empty (story did not render)');
        }

        const ok = errors.length === 0;
        record(story.id, story.name, ok, errors[0] || undefined);
      } catch (e) {
        const msg = e.message || String(e);
        // Timeout waiting for networkidle is a hard failure
        const detail = msg.includes('Timeout') || msg.includes('timeout')
          ? `Timed out after ${RENDER_TIMEOUT_MS}ms — story may be stuck in loading state`
          : `Unexpected error: ${msg.slice(0, 200)}`;
        record(story.id, story.name, false, detail);
      } finally {
        if (page) await page.close().catch(() => {});
      }
    });
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }

  const elapsed = ((Date.now() - smokeStart) / 1000).toFixed(1);
  const passed  = findings.filter(f => f.ok).length;
  const failed  = findings.filter(f => !f.ok).length;

  process.stdout.write(
    `\n  Results: ${passed} passed, ${failed} failed (${elapsed}s)\n`,
  );

  await writeReport(findings);
  process.exit(failed > 0 ? 1 : 0);
}

// ── Report writer ─────────────────────────────────────────────────────────────
async function writeReport(findings, fatalMessage) {
  const now     = new Date().toISOString();
  const passed  = findings.filter(f => f.ok).length;
  const failed  = findings.filter(f => !f.ok).length;
  const total   = findings.length;

  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

  const lines = [
    `# Storybook Smoke — ${now}`,
    '',
    `- Command: \`npm run test:storybook-smoke\``,
    `- Date: ${now}`,
    '',
    '## Summary',
    '',
  ];

  if (fatalMessage) {
    lines.push(`- ❌ FAIL: ${fatalMessage}`);
  } else if (failed === 0) {
    lines.push(`- ✅ PASS: All ${total} stories rendered without errors.`);
  } else {
    lines.push(`- ❌ FAIL: ${failed} of ${total} stories failed.`);
    lines.push(`- Passed: ${passed} / ${total}`);
    lines.push(`- Failed: ${failed} / ${total}`);
  }

  if (findings.length > 0) {
    lines.push('', '## Results', '');
    lines.push('| Result | Story ID | Detail |');
    lines.push('|--------|----------|--------|');
    for (const f of findings) {
      lines.push(
        `| ${f.ok ? '✅ PASS' : '❌ FAIL'} | \`${esc(f.storyId)}\` | ${esc(f.detail || '—')} |`,
      );
    }
  }

  if (findings.some(f => !f.ok)) {
    lines.push('', '## Failed stories', '');
    for (const f of findings.filter(f => !f.ok)) {
      lines.push(`- \`${f.storyId}\`: ${f.detail}`);
    }
  }

  lines.push('', '## Coverage', '');
  lines.push(
    'Each story is loaded in a headless Chromium page via the static Storybook',
    '`iframe.html?id=<storyId>&viewMode=story` URL. The check catches:',
    '- **(A)** Uncaught JavaScript exceptions (React render errors, missing imports).',
    '- **(B)** Storybook error-boundary overlays rendered in the DOM.',
    '- **(C)** Stories that leave `#storybook-root` empty (stuck in loading).',
    '- **(D)** React error-boundary console messages ("The above error …").',
    '',
    'The auth-fetch hang class of bug is caught by check **(C)**:',
    'any story that hangs waiting for an unauthenticated API call times out and',
    'its `#storybook-root` remains empty.',
  );

  lines.push('', `---`, `_Generated by \`scripts/storybook-smoke.mjs\`_`);

  const out = join(ROOT, 'test-results', 'storybook-smoke.md');
  writeFileSync(out, lines.join('\n'), 'utf8');
  process.stdout.write(`  Report: test-results/storybook-smoke.md\n`);
}

main();
