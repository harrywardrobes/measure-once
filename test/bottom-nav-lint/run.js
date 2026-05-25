'use strict';
// test/bottom-nav-lint/run.js
//
// Static lint check: every entry in the NAV array exported from
// src/react/components/BottomNav.tsx must have both an `Icon` and an
// `IconOutlined` field.  The NavItem type enforces this at compile time, but
// this test makes the rule explicit and machine-enforced in CI so a developer
// who copies an entry and forgets the outlined variant gets an immediate
// non-zero exit rather than a silent runtime fallback.
//
// No server, no database, no Puppeteer — reads the source file directly.
//
// Usage:
//   npm run test:bottom-nav-lint

const fs   = require('fs');
const path = require('path');

const SRC  = path.resolve(__dirname, '../../src/react/components/BottomNav.tsx');
const OUT  = path.resolve(__dirname, '../../test-results/bottom-nav-lint.md');

// ── helpers ───────────────────────────────────────────────────────────────────

function extractNavEntries(src) {
  // Grab the content of the NAV array literal.
  const match = src.match(/export\s+const\s+NAV\s*:[^=]+=\s*\[([\s\S]*?)\];/);
  if (!match) throw new Error('Could not locate "export const NAV" array in BottomNav.tsx');
  const body = match[1];

  // Split on object boundaries: each entry is `{ … }`.
  const entries = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (body[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        entries.push(body.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return entries;
}

function extractKey(entry) {
  const m = entry.match(/key\s*:\s*['"]([^'"]+)['"]/);
  return m ? m[1] : '(unknown)';
}

function hasField(entry, fieldName) {
  // Match `fieldName:` as a property key (not as part of a longer identifier).
  const re = new RegExp(`(?<![\\w])${fieldName}\\s*:`);
  return re.test(entry);
}

// ── run ───────────────────────────────────────────────────────────────────────

let src;
try {
  src = fs.readFileSync(SRC, 'utf8');
} catch (err) {
  console.error(`[bottom-nav-lint] Cannot read ${SRC}: ${err.message}`);
  process.exit(1);
}

let entries;
try {
  entries = extractNavEntries(src);
} catch (err) {
  console.error(`[bottom-nav-lint] ${err.message}`);
  process.exit(1);
}

if (entries.length === 0) {
  console.error('[bottom-nav-lint] NAV array is empty — nothing to check');
  process.exit(1);
}

const results = entries.map((entry) => {
  const key           = extractKey(entry);
  const hasIcon         = hasField(entry, 'Icon');
  const hasIconOutlined = hasField(entry, 'IconOutlined');
  const pass          = hasIcon && hasIconOutlined;
  return { key, hasIcon, hasIconOutlined, pass };
});

const failures = results.filter((r) => !r.pass);
const passed   = results.length - failures.length;

// ── report ────────────────────────────────────────────────────────────────────

const lines = [
  '# bottom-nav-lint',
  '',
  `Checked ${results.length} NAV entr${results.length === 1 ? 'y' : 'ies'} in \`BottomNav.tsx\`.`,
  '',
  '| key | Icon | IconOutlined | result |',
  '| --- | ---- | ------------ | ------ |',
];

for (const r of results) {
  lines.push(
    `| \`${r.key}\` | ${r.hasIcon ? '✓' : '✗'} | ${r.hasIconOutlined ? '✓' : '✗'} | ${r.pass ? 'PASS' : '**FAIL**'} |`,
  );
}

lines.push('');
if (failures.length === 0) {
  lines.push(`**All ${passed} entries passed.**`);
} else {
  lines.push(`**${failures.length} entr${failures.length === 1 ? 'y' : 'ies'} failed:**`);
  for (const f of failures) {
    const missing = [
      !f.hasIcon         && '`Icon`',
      !f.hasIconOutlined && '`IconOutlined`',
    ].filter(Boolean).join(', ');
    lines.push(`- \`${f.key}\`: missing ${missing}`);
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n') + '\n');

// ── console summary ───────────────────────────────────────────────────────────

if (failures.length === 0) {
  console.log(`[bottom-nav-lint] All ${passed} NAV entries have Icon + IconOutlined. ✓`);
} else {
  console.error(`[bottom-nav-lint] ${failures.length} NAV entr${failures.length === 1 ? 'y' : 'ies'} missing icon field(s):`);
  for (const f of failures) {
    const missing = [
      !f.hasIcon         && 'Icon',
      !f.hasIconOutlined && 'IconOutlined',
    ].filter(Boolean).join(', ');
    console.error(`  • ${f.key}: missing ${missing}`);
  }
  process.exit(1);
}
