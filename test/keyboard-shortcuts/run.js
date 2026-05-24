'use strict';
// test/keyboard-shortcuts/run.js
//
// Automated smoke test for window.getShortcut() in public/chrome.js.
//
// Exercises four scenarios in a headless Chromium context:
//   (1) userAgentData path  — platform = "macOS"   → ⌘K
//   (2) userAgentData path  — platform = "Windows"  → Ctrl K
//   (3) legacy fallback     — platform = "MacIntel" → ⌘K  (userAgentData absent)
//   (4) legacy fallback     — platform = "Win32"    → Ctrl K (userAgentData absent)
//
// No server or database required — the function source is read directly from
// public/chrome.js and evaluated inside a data-URL page so the test exercises
// the real production code rather than a copy.
//
// Usage:
//   npm run test:keyboard-shortcuts

const fs   = require('fs');
const path = require('path');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

// ── load the real function source ──────────────────────────────────────────
// Extract only the window.getShortcut definition from chrome.js so we can
// inject it into a sandboxed page without running the rest of the file (which
// would fail in a data-URL context without the full app DOM).
const chromeSrc = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'public', 'chrome.js'),
  'utf8',
);

// Pull out lines 1–11 (the JSDoc + function definition).  We match greedily
// up to the closing `};` so that even if the implementation grows, we get
// the whole block.
const fnMatch = chromeSrc.match(
  /(\/\*\*[\s\S]*?window\.getShortcut\s*=\s*function[\s\S]*?\};)/,
);
if (!fnMatch) {
  console.error('Could not locate window.getShortcut in public/chrome.js');
  process.exit(2);
}
const GET_SHORTCUT_SRC = fnMatch[1];

// ── test cases ─────────────────────────────────────────────────────────────
const CASES = [
  {
    name:     'userAgentData path — macOS platform returns ⌘K',
    key:      'K',
    expected: '\u2318K',
    setup: () => {
      Object.defineProperty(navigator, 'userAgentData', {
        value:        { platform: 'macOS' },
        configurable: true,
        writable:     true,
      });
    },
  },
  {
    name:     'userAgentData path — Windows platform returns Ctrl K',
    key:      'K',
    expected: 'Ctrl K',
    setup: () => {
      Object.defineProperty(navigator, 'userAgentData', {
        value:        { platform: 'Windows' },
        configurable: true,
        writable:     true,
      });
    },
  },
  {
    name:     'legacy fallback — MacIntel navigator.platform returns ⌘K',
    key:      'K',
    expected: '\u2318K',
    setup: () => {
      // Remove userAgentData so the ?? branch uses navigator.platform
      Object.defineProperty(navigator, 'userAgentData', {
        value:        undefined,
        configurable: true,
        writable:     true,
      });
      Object.defineProperty(navigator, 'platform', {
        value:        'MacIntel',
        configurable: true,
        writable:     true,
      });
    },
  },
  {
    name:     'legacy fallback — Win32 navigator.platform returns Ctrl K',
    key:      'K',
    expected: 'Ctrl K',
    setup: () => {
      Object.defineProperty(navigator, 'userAgentData', {
        value:        undefined,
        configurable: true,
        writable:     true,
      });
      Object.defineProperty(navigator, 'platform', {
        value:        'Win32',
        configurable: true,
        writable:     true,
      });
    },
  },
];

// ── helpers ────────────────────────────────────────────────────────────────
function findChromium() {
  const { findChromium: shared } = require('../shared/find-chromium');
  return shared() || undefined;
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n  keyboard-shortcuts smoke test\n');

  const findings = [];
  function record(name, expected, observed, ok, detail) {
    findings.push({ name, expected, observed, ok, detail: detail || '' });
    const mark = ok ? '  \u2713' : '  \u2717';
    console.log(`${mark}  ${name}`);
    if (!ok) {
      console.log(`     expected : ${JSON.stringify(expected)}`);
      console.log(`     observed : ${JSON.stringify(observed)}`);
      if (detail) console.log(`     detail   : ${detail}`);
    }
  }

  if (!puppeteer) {
    record(
      'puppeteer available',
      'require("puppeteer") resolves',
      'module not installed',
      false,
      'Install puppeteer (npm i -D puppeteer) and rerun.',
    );
    await writeReport(findings);
    process.exit(1);
  }

  const executablePath = findChromium();
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      defaultViewport: { width: 800, height: 600 },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  } catch (e) {
    record(
      'headless chromium launches',
      'browser.launch() succeeds',
      `error: ${e.message}`,
      false,
    );
    await writeReport(findings);
    process.exit(1);
  }

  try {
    // A minimal data-URL page that has no special environment requirements.
    const DATA_PAGE = 'data:text/html,<!DOCTYPE html><html><body></body></html>';

    for (const tc of CASES) {
      const page = await browser.newPage();
      try {
        await page.goto(DATA_PAGE, { waitUntil: 'domcontentloaded' });

        // Inject the real getShortcut source, then apply the per-case mock,
        // call the function, and return the result — all in one evaluate so
        // the mock and the call share the same execution context.
        const result = await page.evaluate(
          ({ src, setup, key }) => {
            // eslint-disable-next-line no-eval
            eval(src);
            // Apply the navigator mock for this scenario
            // (Function constructor keeps it in the page's global scope)
            // eslint-disable-next-line no-new-func
            new Function(setup)();
            return window.getShortcut(key);
          },
          {
            src:   GET_SHORTCUT_SRC,
            setup: `(${tc.setup.toString()})()`,
            key:   tc.key,
          },
        );

        record(tc.name, tc.expected, result, result === tc.expected);
      } catch (e) {
        record(tc.name, tc.expected, `error: ${e.message}`, false);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const pass = findings.filter(f => f.ok).length;
  const fail = findings.filter(f => !f.ok).length;
  console.log(`\n  Results: ${pass} passed, ${fail} failed`);

  await writeReport(findings);
  process.exit(fail > 0 ? 1 : 0);
}

// ── report writer ──────────────────────────────────────────────────────────
async function writeReport(findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Keyboard Shortcuts — Smoke Test',
    '',
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:keyboard-shortcuts\``,
    '',
    '## Summary',
    '',
    `- Passed: ${findings.filter(f => f.ok).length} / ${findings.length}`,
    `- Failed: ${findings.filter(f => !f.ok).length} / ${findings.length}`,
    '',
    '## Results',
    '',
    '| Result | Probe | Expected | Observed |',
    '|---|---|---|---|',
    ...findings.map(f =>
      `| ${f.ok ? 'PASS' : 'FAIL'} | ${esc(f.name)} | ${esc(f.expected)} | ${esc(f.observed)} |`,
    ),
    '',
    '## Coverage',
    '',
    '- **(1) userAgentData — macOS**: `navigator.userAgentData.platform = "macOS"` →',
    '  `getShortcut("K")` must return `"⌘K"`. Exercises the modern API path.',
    '- **(2) userAgentData — Windows**: `navigator.userAgentData.platform = "Windows"` →',
    '  `getShortcut("K")` must return `"Ctrl K"`. Exercises the modern API path.',
    '- **(3) legacy fallback — MacIntel**: `navigator.userAgentData` is absent;',
    '  `navigator.platform = "MacIntel"` → `getShortcut("K")` must return `"⌘K"`.',
    '  Exercises the `?? navigator.platform` fallback branch.',
    '- **(4) legacy fallback — Win32**: `navigator.userAgentData` is absent;',
    '  `navigator.platform = "Win32"` → `getShortcut("K")` must return `"Ctrl K"`.',
    '  Exercises the `?? navigator.platform` fallback branch.',
    '',
    '## Relevant file',
    '',
    '- `public/chrome.js` — `window.getShortcut` (lines 8–11)',
  ];
  const outPath = path.join(dir, 'keyboard-shortcuts.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Report: test-results/keyboard-shortcuts.md`);
}

main();
