'use strict';
// test/bottom-nav-lint/run.js
//
// Static lint check: every entry in the NAV array exported from
// src/react/components/BottomNav.tsx must have both an `Icon` and an
// `IconOutlined` field, AND each field value must be a name that is actually
// imported from `@mui/icons-material` at the top of the file.
//
// The NavItem type enforces field presence at compile time, but this test
// makes both rules explicit and machine-enforced in CI so a developer who
// copies an entry and forgets to add the import (or misspells the import
// identifier) gets an immediate non-zero exit rather than a silent runtime
// fallback or a TypeScript error that only surfaces during the build.
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

function extractIconImports(src) {
  const imported = new Set();

  // Default imports: import FooIcon from '@mui/icons-material/...'
  const defaultRe = /import\s+(\w+)\s+from\s+['"]@mui\/icons-material[^'"]*['"]/g;
  let m;
  while ((m = defaultRe.exec(src)) !== null) {
    imported.add(m[1]);
  }

  // Named imports: import { FooIcon, BarIcon } from '@mui/icons-material'
  const namedRe = /import\s+\{([^}]+)\}\s+from\s+['"]@mui\/icons-material[^'"]*['"]/g;
  while ((m = namedRe.exec(src)) !== null) {
    for (const raw of m[1].split(',')) {
      // Handle aliasing: `OriginalName as LocalName`
      const parts = raw.trim().split(/\s+as\s+/);
      const localName = (parts[1] || parts[0]).trim();
      if (localName) imported.add(localName);
    }
  }

  return imported;
}

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

function extractFieldValue(entry, fieldName) {
  // Extract the identifier assigned to a field: `fieldName: SomeIdentifier`
  const re = new RegExp(`(?<![\\w])${fieldName}\\s*:\\s*(\\w+)`);
  const m = entry.match(re);
  return m ? m[1] : null;
}

// ── run ───────────────────────────────────────────────────────────────────────

let src;
try {
  src = fs.readFileSync(SRC, 'utf8');
} catch (err) {
  console.error(`[bottom-nav-lint] Cannot read ${SRC}: ${err.message}`);
  process.exit(1);
}

const iconImports = extractIconImports(src);

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

  const iconValue         = extractFieldValue(entry, 'Icon');
  const iconOutlinedValue = extractFieldValue(entry, 'IconOutlined');

  const iconImported         = iconValue         ? iconImports.has(iconValue)         : false;
  const iconOutlinedImported = iconOutlinedValue ? iconImports.has(iconOutlinedValue) : false;

  const pass = hasIcon && hasIconOutlined && iconImported && iconOutlinedImported;

  return {
    key,
    hasIcon,
    hasIconOutlined,
    iconValue,
    iconOutlinedValue,
    iconImported,
    iconOutlinedImported,
    pass,
  };
});

const failures = results.filter((r) => !r.pass);
const passed   = results.length - failures.length;

// ── report ────────────────────────────────────────────────────────────────────

const lines = [
  '# bottom-nav-lint',
  '',
  `Checked ${results.length} NAV entr${results.length === 1 ? 'y' : 'ies'} in \`BottomNav.tsx\`.`,
  `Found ${iconImports.size} \`@mui/icons-material\` import${iconImports.size === 1 ? '' : 's'}.`,
  '',
  '| key | Icon | Icon imported | IconOutlined | IconOutlined imported | result |',
  '| --- | ---- | ------------- | ------------ | --------------------- | ------ |',
];

for (const r of results) {
  lines.push(
    `| \`${r.key}\` | ${r.hasIcon ? '✓' : '✗'} | ${r.iconImported ? '✓' : '✗'} | ${r.hasIconOutlined ? '✓' : '✗'} | ${r.iconOutlinedImported ? '✓' : '✗'} | ${r.pass ? 'PASS' : '**FAIL**'} |`,
  );
}

lines.push('');
if (failures.length === 0) {
  lines.push(`**All ${passed} entries passed.**`);
} else {
  lines.push(`**${failures.length} entr${failures.length === 1 ? 'y' : 'ies'} failed:**`);
  for (const f of failures) {
    const missing = [];
    if (!f.hasIcon)                missing.push('`Icon` field missing');
    if (f.hasIcon && !f.iconImported)
      missing.push(`\`Icon\` value \`${f.iconValue}\` not imported from \`@mui/icons-material\``);
    if (!f.hasIconOutlined)        missing.push('`IconOutlined` field missing');
    if (f.hasIconOutlined && !f.iconOutlinedImported)
      missing.push(`\`IconOutlined\` value \`${f.iconOutlinedValue}\` not imported from \`@mui/icons-material\``);
    lines.push(`- \`${f.key}\`: ${missing.join('; ')}`);
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n') + '\n');

// ── console summary ───────────────────────────────────────────────────────────

if (failures.length === 0) {
  console.log(`[bottom-nav-lint] All ${passed} NAV entries have Icon + IconOutlined, both imported. ✓`);
} else {
  console.error(`[bottom-nav-lint] ${failures.length} NAV entr${failures.length === 1 ? 'y' : 'ies'} failed icon checks:`);
  for (const f of failures) {
    const missing = [];
    if (!f.hasIcon)                missing.push('Icon field missing');
    if (f.hasIcon && !f.iconImported)
      missing.push(`Icon value "${f.iconValue}" not imported from @mui/icons-material`);
    if (!f.hasIconOutlined)        missing.push('IconOutlined field missing');
    if (f.hasIconOutlined && !f.iconOutlinedImported)
      missing.push(`IconOutlined value "${f.iconOutlinedValue}" not imported from @mui/icons-material`);
    console.error(`  • ${f.key}: ${missing.join('; ')}`);
  }
  process.exit(1);
}
