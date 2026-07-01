'use strict';
// test/tabbar-stories/run.js
//
// Puppeteer story-render probe for the TabBar Storybook stories.
// Loads all five stories from the pre-built Storybook output via a local
// static HTTP server and Puppeteer, then asserts that none of them throw
// render errors or remain blank.
//
// For the `ActiveIndicatorVisible` story an extra visual assertion **(E)** is
// run: it verifies that the plum bottom-border indicator on the active tab is
// actually visible — specifically that:
//   - `.ui-tabbar` uses `overflow-y: clip` (not `hidden`), which allows the
//     active button's `margin-bottom: -2px` to escape the container boundary.
//   - The active button's computed `border-bottom` width is > 0 px.
//   - The active button's computed `border-bottom-color` is not transparent.
//
// Without `overflow-y: clip` + `overflow-clip-margin`, the negative margin
// trick is silently clipped and the plum underline disappears even though
// all CSS classes are applied correctly.
//
// Requires STORYBOOK_OUT_DIR to point at a pre-built Storybook directory.
// In CI this is set automatically when the step is enrolled after
// `build:storybook` in scripts/run-ci.mjs.
//
// Error detection — a story is considered broken when any of the following
// occur within RENDER_TIMEOUT_MS:
//   (A) An uncaught exception fires in the page (Puppeteer `pageerror` event).
//   (B) The Storybook error-boundary overlay is visible in the DOM
//       (`#error-message`, `.sb-errordisplay`, or `[data-error-boundary]`).
//   (C) `#storybook-root` is still completely empty after the timeout.
//   (D) A `console.error` that starts with "The above error" (React's
//       error-boundary rethrow message) is recorded.
//   (E) [ActiveIndicatorVisible only] The plum active-tab indicator is not
//       visually present: `overflow-y` is not `clip`, or the active button's
//       border-bottom is zero-width or transparent.
//
// Usage:
//   STORYBOOK_OUT_DIR=public/storybook npm run test:tabbar-stories

const { createServer }  = require('http');
const { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } = require('fs');
const { join, extname, resolve, normalize } = require('path');

const ROOT        = resolve(__dirname, '..', '..');
const RESULTS_DIR = join(ROOT, 'test-results');

const PREBUILT_DIR = process.env.STORYBOOK_OUT_DIR
  ? resolve(ROOT, process.env.STORYBOOK_OUT_DIR)
  : null;

const RENDER_TIMEOUT_MS          = 10_000;
const STORY_TITLE                = 'Components/TabBar';
const EXPECTED_COUNT             = 5;
const ACTIVE_INDICATOR_STORY_ID  = 'components-tabbar--active-indicator-visible';

// ── probe labels ──────────────────────────────────────────────────────────────
// Consumed by scripts/check-suite-probe-counts.mjs to guard against docs drift.
const PROBE_LABELS = [
  '[A] uncaught JS exceptions (pageerror)',
  '[B] Storybook error-boundary overlay visible',
  '[C] #storybook-root empty after render',
  '[D] React error-boundary console rethrow',
  '[E] active-tab plum indicator visible (ActiveIndicatorVisible story only)',
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
    // Plain-prefix check first — the exact form static analysis recognises as
    // a path-traversal barrier (CodeQL js/path-injection) — then the
    // separator-precise check that also rejects sibling paths like
    // `${rootDir}-other`.
    if (!filePath.startsWith(rootDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    if (filePath !== rootDir && !filePath.startsWith(rootDir + '/')) {
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

  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');

  const lines = [
    `# TabBar Stories — ${now}`,
    '',
    `- Command: \`npm run test:tabbar-stories\``,
    `- Date: ${now}`,
    `- Component: \`${STORY_TITLE}\``,
    '',
    '## Summary',
    '',
  ];

  if (fatalMessage) {
    lines.push(`- ❌ FAIL: ${fatalMessage}`);
  } else if (failed === 0) {
    lines.push(`- ✅ PASS: All ${total} TabBar stories rendered without errors.`);
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
    `Stories from \`${STORY_TITLE}\` are loaded in a headless Chromium page via`,
    'the static Storybook `iframe.html?id=<storyId>&viewMode=story` URL.',
    'The check catches:',
    '- **(A)** Uncaught JavaScript exceptions (React render errors, missing imports).',
    '- **(B)** Storybook error-boundary overlays rendered in the DOM.',
    '- **(C)** Stories that leave `#storybook-root` empty (stuck in loading).',
    '- **(D)** React error-boundary console messages ("The above error …").',
    '- **(E)** [ActiveIndicatorVisible only] The plum active-tab indicator is not',
    '  visually present: `overflow-y` is not `clip` on `.ui-tabbar`, or the active',
    "  button's `border-bottom` is zero-width or transparent.",
  );

  lines.push('', `---`, `_Generated by \`test/tabbar-stories/run.js\`_`);

  const out = join(RESULTS_DIR, 'tabbar-stories.md');
  writeFileSync(out, lines.join('\n'), 'utf8');
  process.stdout.write('  Report: test-results/tabbar-stories.md\n');
}

// ── Active-indicator visual assertion (probe E) ───────────────────────────────
//
// Checks three computed-style properties that must all hold for the plum
// bottom-border to be visible on the active tab:
//
//   1. `.ui-tabbar` overflowY === 'clip'
//      If it were 'hidden' the negative margin on the active button would be
//      clipped and the plum line would be invisible.
//
//   2. `.ui-tabbar-btn.is-active` borderBottomWidth > 0
//      A zero-width border means the indicator line has been removed.
//
//   3. `.ui-tabbar-btn.is-active` borderBottomColor is not 'transparent' /
//      rgba(0,0,0,0) — i.e. the plum colour is actually applied.
//
// Returns null on pass, or an error string on failure.
async function checkActiveIndicatorVisible(page) {
  return page.evaluate(() => {
    const tabbar = document.querySelector('.ui-tabbar');
    if (!tabbar) return 'Could not find .ui-tabbar element in the rendered story';

    const activeBtn = tabbar.querySelector('.ui-tabbar-btn.is-active');
    if (!activeBtn) return 'Could not find .ui-tabbar-btn.is-active in the rendered story';

    const tabbarStyle  = window.getComputedStyle(tabbar);
    const btnStyle     = window.getComputedStyle(activeBtn);

    const overflowY    = tabbarStyle.overflowY;
    const borderWidth  = parseFloat(btnStyle.borderBottomWidth  || '0');
    const borderColor  = btnStyle.borderBottomColor || '';

    if (overflowY !== 'clip') {
      return (
        `overflow-y regression: .ui-tabbar has overflow-y="${overflowY}" ` +
        '(expected "clip"). Without overflow-y:clip the active-tab ' +
        'margin-bottom:-2px is clipped and the plum indicator disappears.'
      );
    }

    if (borderWidth <= 0) {
      return (
        `border-bottom-width regression: .ui-tabbar-btn.is-active has ` +
        `border-bottom-width=${borderWidth}px (expected > 0). ` +
        'The plum indicator border has been removed.'
      );
    }

    const isTransparent =
      borderColor === 'transparent' ||
      borderColor === 'rgba(0, 0, 0, 0)' ||
      borderColor === '';

    if (isTransparent) {
      return (
        `border-bottom-color regression: .ui-tabbar-btn.is-active has ` +
        `border-bottom-color="${borderColor}" (expected the plum accent colour, ` +
        'not transparent). The active-tab indicator is invisible.'
      );
    }

    return null;
  }).catch((err) => `evaluate error: ${err.message}`);
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

  process.stdout.write(`\n  tabbar-stories — using pre-built output at ${PREBUILT_DIR}\n\n`);

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
    const msg = `Expected ${EXPECTED_COUNT} stories for "${STORY_TITLE}" but found ${stories.length}. ` +
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

        page.on('pageerror', (err) => {
          errors.push(`pageerror: ${err.message}`);
        });

        page.on('console', (msg) => {
          if (msg.type() === 'error') {
            const text = msg.text();
            if (text.startsWith('The above error')) {
              errors.push(`console.error: ${text.slice(0, 200)}`);
            }
          }
        });

        await page.goto(url, { waitUntil: 'networkidle0', timeout: RENDER_TIMEOUT_MS });

        await new Promise(r => setTimeout(r, 400));

        // (B) Check for Storybook error-boundary overlay
        const hasErrorOverlay = await page.evaluate(() => {
          const selectors = ['#error-message', '.sb-errordisplay', '[data-error-boundary]'];
          return selectors.some(sel => {
            const el = document.querySelector(sel);
            return el && el.offsetParent !== null;
          });
        }).catch(() => false);

        if (hasErrorOverlay) errors.push('Storybook error overlay is visible');

        // (C) Check that #storybook-root is not empty
        const rootEmpty = await page.evaluate(() => {
          const root = document.getElementById('storybook-root');
          return !root || root.children.length === 0;
        }).catch(() => true);

        if (rootEmpty) errors.push('#storybook-root is empty (story did not render)');

        // (E) Extra visual check for the ActiveIndicatorVisible story
        if (story.id === ACTIVE_INDICATOR_STORY_ID && errors.length === 0) {
          const indicatorError = await checkActiveIndicatorVisible(page);
          if (indicatorError) errors.push(`(E) active-indicator: ${indicatorError}`);
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
  process.stderr.write(`[tabbar-stories] fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
