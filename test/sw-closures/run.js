'use strict';
// test/sw-closures/run.js
//
// Fixture-based meta-test for scripts/check-sw-urlpattern-closures.mjs.
//
// For each scenario, writes a minimal synthetic file to a temp path and runs
// the checker (with _SW_CHECK_TARGET overriding the default path) as a child
// process, then asserts the exit code and output match expectations.
//
// Scenarios:
//   (A) Parenthesised arrow closing over an outer var  → exit 1, flags var
//   (B) Single-param unparenthesised arrow closure     → exit 1, flags var
//   (C) Function expression closing over an outer var  → exit 1, flags var
//   (D) Regex literal urlPattern                       → exit 0, safe
//   (E) new Function(…)() urlPattern                  → exit 0, safe
//   (F) Suppression comment on a violating line        → exit 0, suppressed
//   (G) Parenthesised arrow with only local bindings   → exit 0, clean
//   (H) Single-param arrow with only local bindings    → exit 0, clean
//
// No server, no DB, no Puppeteer — entirely self-contained.
//
// Usage:
//   npm run test:sw-closures-fixtures

const fs            = require('fs');
const os            = require('os');
const path          = require('path');
const { spawnSync } = require('child_process');

const CHECKER = path.resolve(__dirname, '../../scripts/check-sw-urlpattern-closures.mjs');
const OUT     = path.resolve(__dirname, '../../test-results/sw-closures-fixtures.md');

// ── helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const details = [];

/**
 * Run the checker on the given source text (written to a temp file).
 * Returns { exitCode, output } where output is stdout + stderr combined.
 */
function runChecker(src) {
  const tmp = path.join(os.tmpdir(), `sw-check-fixture-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(tmp, src, 'utf8');
  try {
    const result = spawnSync(
      process.execPath,
      [CHECKER],
      {
        env: { ...process.env, _SW_CHECK_TARGET: tmp },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    const output = (result.stdout || '') + (result.stderr || '');
    return { exitCode: result.status ?? 1, output };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function check(label, src, expectedExit, mustContain = [], mustNotContain = []) {
  const { exitCode, output } = runChecker(src);
  let ok = true;
  const msgs = [];

  if (exitCode !== expectedExit) {
    ok = false;
    msgs.push(`  exit code: got ${exitCode}, want ${expectedExit}`);
  }
  for (const s of mustContain) {
    if (!output.includes(s)) {
      ok = false;
      msgs.push(`  missing in output: ${JSON.stringify(s)}`);
    }
  }
  for (const s of mustNotContain) {
    if (output.includes(s)) {
      ok = false;
      msgs.push(`  unexpected in output: ${JSON.stringify(s)}`);
    }
  }

  const icon = ok ? '✅' : '❌';
  const line = `${icon} ${label}`;
  console.log(line);
  if (!ok) {
    for (const m of msgs) console.error(m);
    console.error(`  full output:\n${output.split('\n').map(l => '    ' + l).join('\n')}`);
  }
  if (ok) passed++; else failed++;
  details.push({ label, ok, msgs });
}

// ── fixtures ──────────────────────────────────────────────────────────────────

const A_SRC = `\
const outerPat = /api/;
const runtimeCaching = [
  {
    urlPattern: ({ url, sameOrigin }) => sameOrigin && outerPat.test(url.pathname),
    handler: 'StaleWhileRevalidate',
  },
];
`;

const B_SRC = `\
const outerPat = /api/;
const runtimeCaching = [
  { urlPattern: u => outerPat.test(u.url.pathname), handler: 'CacheFirst' },
];
`;

const C_SRC = `\
const outerPat = /api/;
const runtimeCaching = [
  {
    urlPattern: function({ url, sameOrigin }) { return sameOrigin && outerPat.test(url.pathname); },
    handler: 'NetworkFirst',
  },
];
`;

const D_SRC = `\
const runtimeCaching = [
  { urlPattern: /^\\/api\\//, handler: 'StaleWhileRevalidate' },
];
`;

const E_SRC = `\
const pat = /api/;
const runtimeCaching = [
  {
    urlPattern: new Function('return ({ url, sameOrigin }) => sameOrigin && /\\/api\\//.test(url.pathname)')(),
    handler: 'StaleWhileRevalidate',
  },
];
`;

const F_SRC = `\
const outerPat = /api/;
const runtimeCaching = [
  {
    urlPattern: ({ url, sameOrigin }) => sameOrigin && outerPat.test(url.pathname), // sw-closure-ok: test suppression
    handler: 'StaleWhileRevalidate',
  },
];
`;

const G_SRC = `\
const runtimeCaching = [
  {
    urlPattern: ({ request, sameOrigin }) => sameOrigin && request.mode === 'navigate',
    handler: 'NetworkFirst',
  },
];
`;

const H_SRC = `\
const runtimeCaching = [
  { urlPattern: req => req.url.pathname.startsWith('/api/'), handler: 'CacheFirst' },
];
`;

// ── run scenarios ─────────────────────────────────────────────────────────────

check(
  '(A) Parenthesised arrow closure over outer var → exit 1, var flagged',
  A_SRC,
  1,
  ['outerPat', 'Free variables'],
);

check(
  '(B) Single-param unparenthesised arrow closure → exit 1, var flagged',
  B_SRC,
  1,
  ['outerPat', 'Free variables'],
);

check(
  '(C) Function expression closure over outer var → exit 1, var flagged',
  C_SRC,
  1,
  ['outerPat', 'Free variables'],
);

check(
  '(D) Regex literal urlPattern → exit 0, safe',
  D_SRC,
  0,
  ['No urlPattern closure violations'],
);

check(
  '(E) new Function(…)() urlPattern → exit 0, safe',
  E_SRC,
  0,
  ['No urlPattern closure violations'],
);

check(
  '(F) Suppression comment on violating line → exit 0, suppressed',
  F_SRC,
  0,
  ['No urlPattern closure violations'],
  ['outerPat'],
);

check(
  '(G) Parenthesised arrow with only own params → exit 0, clean',
  G_SRC,
  0,
  ['No urlPattern closure violations'],
);

check(
  '(H) Single-param arrow with only local bindings → exit 0, clean',
  H_SRC,
  0,
  ['No urlPattern closure violations'],
);

// ── report ────────────────────────────────────────────────────────────────────

const total = passed + failed;
const summary = `${passed}/${total} fixture scenarios passed`;
console.log(`\n${failed === 0 ? '✅' : '❌'} ${summary}`);

const now = new Date().toISOString();
let md = `# sw-closures-fixtures — ${now}\n\n## Summary\n\n- ${summary}\n\n## Results\n\n`;
for (const d of details) {
  md += `- ${d.ok ? '✅' : '❌'} ${d.label}\n`;
  for (const m of d.msgs) md += `  - ${m}\n`;
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, md, 'utf8');
console.log(`Report written to test-results/sw-closures-fixtures.md`);

process.exit(failed > 0 ? 1 : 0);
