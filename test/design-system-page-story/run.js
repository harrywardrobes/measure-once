'use strict';

// test/design-system-page-story/run.js
//
// Puppeteer e2e probe for the DesignSystemPage Storybook story.
// Opens the single `AllSkeletons` story from the pre-built Storybook output
// via a local static HTTP server and asserts:
//   (A) No uncaught JS exception fires in the page (pageerror event).
//   (B) No Storybook error-boundary overlay is visible in the DOM.
//   (C) #storybook-root is non-empty after the render timeout.
//   (D) No React error-boundary console rethrow.
//   (E) Exactly 14 [data-component-showcase] cards are present, each containing
//       at least one .MuiSkeleton-root element.
//
// STORY_TITLE and EXPECTED_COUNT are consumed by scripts/check-story-count-sync.mjs
// to keep the story count in this runner, the docs annotation, and the actual
// .stories.tsx export count in sync.
//
// EXPECTED_SKELETON_COUNT is the number of ComponentShowcase cards (and
// therefore skeleton variants) asserted in probe (E).
//
// Requires STORYBOOK_OUT_DIR to point at a pre-built Storybook directory.
// In CI this is set automatically when the step runs after `build:storybook`.
//
// Usage:
//   STORYBOOK_OUT_DIR=public/storybook npm run test:design-system-page-story

const { createServer }  = require('http');
const { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } = require('fs');
const { join, extname, resolve, normalize } = require('path');

const ROOT        = resolve(__dirname, '..', '..');
const RESULTS_DIR = join(ROOT, 'test-results');

const PREBUILT_DIR = process.env.STORYBOOK_OUT_DIR
  ? resolve(ROOT, process.env.STORYBOOK_OUT_DIR)
  : null;

const RENDER_TIMEOUT_MS    = 10_000;
const STORY_TITLE          = 'Admin/DesignSystemPage';
const EXPECTED_COUNT       = 1;   // number of exported Story objects in the .stories.tsx file
const EXPECTED_SKELETON_COUNT = 14; // number of ComponentShowcase cards checked by probe (E)

const PROBE_LABELS = [
  '(A) no uncaught JS exception fires in the page (pageerror event)',
  '(B) no Storybook error-boundary overlay visible in the DOM',
  '(C) #storybook-root is non-empty after render timeout',
  '(D) no React error-boundary console rethrow',
  `(E) exactly ${EXPECTED_SKELETON_COUNT} [data-component-showcase] cards each contain at least one .MuiSkeleton-root`,
];
// eslint-disable-next-line no-unused-vars
void PROBE_LABELS;

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
function startStaticServer(dir) {
  const rootDir = resolve(dir);
  const server = createServer((req, res) => {
    let pathname = req.url.split('?')[0];
    if (pathname === '/' || pathname === '') pathname = '/index.html';

    const filePath = resolve(join(rootDir, normalize(pathname)));
    if (!filePath.startsWith(rootDir + '/') && filePath !== rootDir) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    let target = filePath;
    if (!existsSync(target)) {
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
    try { stat = statSync(target); } catch { res.writeHead(500); res.end(); return; }
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
    try { body = readFileSync(target); } catch { res.writeHead(500); res.end(); return; }
    res.writeHead(200, {
      'Content-Type':   mime,
      'Cache-Control':  'no-cache',
      'Content-Length': body.length,
    });
    res.end(body);
  });

  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      resolveP({ server, port: server.address().port });
    });
  });
}

// ── Chromium path helper ──────────────────────────────────────────────────────
async function getChromiumPath() {
  try {
    const { findChromium } = require(join(ROOT, 'test', 'shared', 'find-chromium.js'));
    return findChromium() || undefined;
  } catch {
    return undefined;
  }
}

// ── Report writer ─────────────────────────────────────────────────────────────
function writeReport(findings, fatalMessage) {
  const now    = new Date().toISOString();
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok).length;
  const total  = findings.length;

  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

  const lines = [
    `# DesignSystemPage Story — ${now}`,
    '',
    `- Command: \`npm run test:design-system-page-story\``,
    `- Date: ${now}`,
    `- Component: \`${STORY_TITLE}\``,
    '',
    '## Summary',
    '',
  ];

  if (fatalMessage) {
    lines.push(`- ❌ FAIL: ${fatalMessage}`);
  } else if (failed === 0) {
    lines.push(
      `- ✅ PASS: All ${total} DesignSystemPage story check(s) passed ` +
      `(all ${EXPECTED_SKELETON_COUNT} ComponentShowcase cards contain skeleton elements).`,
    );
  } else {
    lines.push(`- ❌ FAIL: ${failed} of ${total} checks failed.`);
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
    lines.push('', '## Failed checks', '');
    for (const f of findings.filter(f => !f.ok)) {
      lines.push(`- \`${f.storyId}\`: ${f.detail}`);
    }
  }

  lines.push('', '## Coverage', '');
  lines.push(
    `The \`${STORY_TITLE}/AllSkeletons\` story is loaded in a headless Chromium page via`,
    'the static Storybook `iframe.html?id=<storyId>&viewMode=story` URL.',
    'The check catches:',
    '- **(A)** Uncaught JavaScript exceptions (React render errors, missing imports).',
    '- **(B)** Storybook error-boundary overlays rendered in the DOM.',
    '- **(C)** Stories that leave `#storybook-root` empty (stuck in loading).',
    '- **(D)** React error-boundary console messages ("The above error …").',
    `- **(E)** Exactly ${EXPECTED_SKELETON_COUNT} \`[data-component-showcase]\` cards must be present,`,
    '  each containing at least one `.MuiSkeleton-root` element. Catches regressions where',
    '  a skeleton is removed from the gallery or fails to render its MUI Skeleton nodes.',
  );

  lines.push('', `---`, `_Generated by \`test/design-system-page-story/run.js\`_`);

  const out = join(RESULTS_DIR, 'design-system-page-story.md');
  writeFileSync(out, lines.join('\n'), 'utf8');
  process.stdout.write('  Report: test-results/design-system-page-story.md\n');
}

// ── Skeleton card assertion (probe E) ─────────────────────────────────────────
//
// Asserts that:
//   1. Exactly EXPECTED_SKELETON_COUNT [data-component-showcase] cards exist.
//   2. Every card contains at least one .MuiSkeleton-root element.
//
// Returns null on pass, or a descriptive error string on failure.
async function checkSkeletonCards(page) {
  return page.evaluate((expectedCount) => {
    const cards = Array.from(
      document.querySelectorAll('[data-component-showcase]'),
    );

    if (cards.length !== expectedCount) {
      return (
        `Expected ${expectedCount} [data-component-showcase] cards but found ${cards.length}. ` +
        'A skeleton entry may have been added or removed from the story without updating ' +
        `EXPECTED_SKELETON_COUNT in the test runner.`
      );
    }

    const missing = cards
      .filter(card => card.querySelector('.MuiSkeleton-root') === null)
      .map(card => card.getAttribute('data-component-showcase') || '(unnamed)');

    if (missing.length > 0) {
      return (
        `${missing.length} ComponentShowcase card(s) contain no .MuiSkeleton-root element: ` +
        missing.join(', ') + '. ' +
        'The skeleton component may have failed to render or was replaced with non-MUI markup.'
      );
    }

    return null;
  }, EXPECTED_SKELETON_COUNT).catch((err) => `evaluate error: ${err.message}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const findings = [];

  function record(storyId, ok, detail) {
    findings.push({ storyId, ok, detail: detail || '' });
    const mark = ok ? '  ✓' : '  ✗';
    process.stdout.write(`${mark}  ${storyId}${detail ? `  — ${detail}` : ''}\n`);
  }

  // ── 1. Verify STORYBOOK_OUT_DIR ─────────────────────────────────────────────
  if (!PREBUILT_DIR) {
    const msg = 'STORYBOOK_OUT_DIR is not set. Run `npm run build:storybook` first and set the env var.';
    process.stderr.write(`  ❌ ${msg}\n`);
    writeReport(findings, msg);
    process.exit(1);
  }

  if (!existsSync(PREBUILT_DIR)) {
    const msg = `STORYBOOK_OUT_DIR="${process.env.STORYBOOK_OUT_DIR}" does not exist. Run \`npm run build:storybook\` first.`;
    process.stderr.write(`  ❌ ${msg}\n`);
    writeReport(findings, msg);
    process.exit(1);
  }

  process.stdout.write(`\n  design-system-page-story — using pre-built output at ${PREBUILT_DIR}\n\n`);

  // ── 2. Load story index ─────────────────────────────────────────────────────
  const indexPath = join(PREBUILT_DIR, 'index.json');
  if (!existsSync(indexPath)) {
    const msg = 'index.json not found in Storybook build output.';
    process.stderr.write(`  ❌ ${msg}\n`);
    writeReport(findings, msg);
    process.exit(1);
  }

  const index   = JSON.parse(readFileSync(indexPath, 'utf8'));
  const entries = Object.values(index.entries || {});
  const stories = entries.filter(e => e.type === 'story' && e.title === STORY_TITLE);

  if (stories.length === 0) {
    const msg = `No stories found with title "${STORY_TITLE}" in index.json.`;
    process.stderr.write(`  ❌ ${msg}\n`);
    writeReport(findings, msg);
    process.exit(1);
  }

  process.stdout.write(
    `  Found ${stories.length} stories (expected ${EXPECTED_COUNT}) for "${STORY_TITLE}"\n\n`,
  );

  if (stories.length !== EXPECTED_COUNT) {
    const msg =
      `Expected ${EXPECTED_COUNT} stories for "${STORY_TITLE}" but found ${stories.length}. ` +
      `Update EXPECTED_COUNT in this file if stories were intentionally added or removed.`;
    process.stderr.write(`  ❌ ${msg}\n`);
    writeReport(findings, msg);
    process.exit(1);
  }

  // ── 3. Start static server ──────────────────────────────────────────────────
  const { server, port } = await startStaticServer(PREBUILT_DIR);
  const baseUrl = `http://127.0.0.1:${port}`;
  process.stdout.write(`  Serving Storybook at ${baseUrl}\n\n`);

  // ── 4. Launch browser ───────────────────────────────────────────────────────
  let puppeteer;
  try { puppeteer = require('puppeteer'); } catch {
    server.close();
    const msg = 'puppeteer is not installed.';
    process.stderr.write(`  ❌ ${msg}\n`);
    writeReport(findings, msg);
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
    server.close();
    const msg = `Could not launch browser: ${e.message}`;
    process.stderr.write(`  ❌ ${msg}\n`);
    for (const l of PROBE_LABELS) record(l, false, msg);
    writeReport(findings, msg);
    process.exit(1);
  }

  // ── 5. Test each story ──────────────────────────────────────────────────────
  const smokeStart = Date.now();
  try {
    for (const story of stories) {
      const url    = `${baseUrl}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`;
      const errors = [];
      let page;

      try {
        page = await browser.newPage();

        // (A) Uncaught JS exceptions
        page.on('pageerror', (err) => {
          errors.push(`pageerror: ${err.message}`);
        });

        // (D) React error-boundary rethrows
        page.on('console', (msg) => {
          if (msg.type() === 'error') {
            const text = msg.text();
            if (text.startsWith('The above error')) {
              errors.push(`console.error: ${text.slice(0, 200)}`);
            }
          }
        });

        await page.goto(url, { waitUntil: 'networkidle0', timeout: RENDER_TIMEOUT_MS });

        // Allow skeleton animations to settle
        await new Promise(r => setTimeout(r, 400));

        // (B) Storybook error-boundary overlay
        const hasErrorOverlay = await page.evaluate(() => {
          const selectors = ['#error-message', '.sb-errordisplay', '[data-error-boundary]'];
          return selectors.some(sel => {
            const el = document.querySelector(sel);
            return el && el.offsetParent !== null;
          });
        }).catch(() => false);

        if (hasErrorOverlay) errors.push('Storybook error overlay is visible');

        // (C) #storybook-root non-empty
        const rootEmpty = await page.evaluate(() => {
          const root = document.getElementById('storybook-root');
          return !root || root.children.length === 0;
        }).catch(() => true);

        if (rootEmpty) errors.push('#storybook-root is empty (story did not render)');

        // (E) 14 ComponentShowcase cards each have a .MuiSkeleton-root
        if (errors.length === 0) {
          const skeletonError = await checkSkeletonCards(page);
          if (skeletonError) errors.push(`(E) skeleton cards: ${skeletonError}`);
        }

        record(story.id, errors.length === 0, errors[0]);
      } catch (e) {
        const msg = e.message || String(e);
        const detail = msg.includes('Timeout') || msg.includes('timeout')
          ? `Timed out after ${RENDER_TIMEOUT_MS}ms — story may be stuck in loading state`
          : `Unexpected error: ${msg.slice(0, 200)}`;
        record(story.id, false, detail);
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }
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

  writeReport(findings);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`[design-system-page-story] fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
