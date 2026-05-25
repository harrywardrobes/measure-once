'use strict';
// test/icon-lint/run.js
//
// Static lint check: every identifier ending with `Icon` that is used as a
// JSX element (<FooIcon …/>) or as a bare value (e.g. in an object literal or
// passed as a prop value) in any React component under `src/react/` must be
// actually imported from `@mui/icons-material` in that same file.
//
// A misspelled or missing import only surfaces during the TypeScript build;
// this check makes the rule explicit and machine-enforced in CI so the
// developer gets an immediate non-zero exit rather than a silent runtime
// fallback or a build-time error that only surfaces late.
//
// No server, no database, no Puppeteer — reads source files directly.
//
// Usage:
//   npm run test:icon-lint

const fs   = require('fs');
const path = require('path');

const SRC_ROOT = path.resolve(__dirname, '../../src/react');
const OUT      = path.resolve(__dirname, '../../test-results/icon-lint.md');

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Walk a directory recursively and return all file paths matching a predicate.
 */
function walkSync(dir, pred, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSync(full, pred, results);
    } else if (entry.isFile() && pred(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Extract the set of local identifier names imported from @mui/icons-material
 * in the given source text.
 */
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

/**
 * Find all identifiers that look like icon component references in the source:
 *  - JSX opening/self-closing tags:  <FooIcon  <FooIcon/  <FooIcon>
 *  - Bare value in JSX expression:   {<FooIcon … />}
 *
 * Returns an array of { identifier, context } objects (context is the
 * surrounding snippet for diagnostics).
 */
function extractIconUsages(src) {
  const usages = [];
  const seen   = new Set();

  // Match <IdentifierIcon (JSX element open or self-close)
  // The identifier must start with an uppercase letter and end with Icon.
  const jsxRe = /<([A-Z]\w*Icon)\b/g;
  let m;
  while ((m = jsxRe.exec(src)) !== null) {
    const ident = m[1];
    if (!seen.has(ident)) {
      seen.add(ident);
      const snippet = src.slice(Math.max(0, m.index - 20), m.index + ident.length + 20)
        .replace(/\n/g, ' ').trim();
      usages.push({ identifier: ident, context: snippet });
    }
  }

  // Match icon identifiers used as bare values in object literals or JSX props:
  //   Icon: FooIcon   iconOutlined: FooIcon   icon={FooIcon}
  // We only capture identifiers that end with `Icon` (uppercase-starting).
  const valueRe = /(?:^|[=:,{([\s])([A-Z]\w*Icon)\b(?!\s*from)/gm;
  while ((m = valueRe.exec(src)) !== null) {
    const ident = m[1];
    if (!seen.has(ident)) {
      seen.add(ident);
      const snippet = src.slice(Math.max(0, m.index - 20), m.index + ident.length + 20)
        .replace(/\n/g, ' ').trim();
      usages.push({ identifier: ident, context: snippet });
    }
  }

  return usages;
}

// ── scan ─────────────────────────────────────────────────────────────────────

const files = walkSync(
  SRC_ROOT,
  (name) => name.endsWith('.tsx') && !name.endsWith('.stories.tsx'),
);

if (files.length === 0) {
  console.error('[icon-lint] No .tsx files found under src/react/');
  process.exit(1);
}

const fileResults = [];

for (const file of files.sort()) {
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`[icon-lint] Cannot read ${file}: ${err.message}`);
    process.exit(1);
  }

  const imports = extractIconImports(src);
  const usages  = extractIconUsages(src);

  // Only report files that either import icons or use icons — skip purely
  // non-icon files to keep the report tidy.
  if (imports.size === 0 && usages.length === 0) continue;

  const failures = usages.filter((u) => !imports.has(u.identifier));
  const rel      = path.relative(path.resolve(__dirname, '../..'), file);

  fileResults.push({ file: rel, imports, usages, failures });
}

// ── report ────────────────────────────────────────────────────────────────────

const totalFiles    = fileResults.length;
const failedFiles   = fileResults.filter((r) => r.failures.length > 0);
const totalUsages   = fileResults.reduce((n, r) => n + r.usages.length, 0);
const totalFailures = failedFiles.reduce((n, r) => n + r.failures.length, 0);

const lines = [
  '# icon-lint',
  '',
  `Scanned ${totalFiles} React component file${totalFiles === 1 ? '' : 's'}.`,
  `Found ${totalUsages} icon usage${totalUsages === 1 ? '' : 's'} across all files.`,
  '',
];

if (failedFiles.length === 0) {
  lines.push(`**All ${totalUsages} icon usages are properly imported. ✓**`);
} else {
  lines.push(`**${totalFailures} unimported icon usage${totalFailures === 1 ? '' : 's'} in ${failedFiles.length} file${failedFiles.length === 1 ? '' : 's'}:**`);
  lines.push('');
  for (const r of failedFiles) {
    lines.push(`### \`${r.file}\``);
    for (const f of r.failures) {
      lines.push(`- **\`${f.identifier}\`** is used but not imported from \`@mui/icons-material\``);
      lines.push(`  Context: \`${f.context}\``);
    }
    lines.push('');
  }
}

lines.push('');
lines.push('## Per-file summary');
lines.push('');
lines.push('| file | icon imports | icon usages | unimported |');
lines.push('| ---- | ----------- | ----------- | ---------- |');
for (const r of fileResults) {
  const flag = r.failures.length > 0 ? ` ⚠ **${r.failures.length}**` : '0';
  lines.push(`| \`${r.file}\` | ${r.imports.size} | ${r.usages.length} | ${flag} |`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n') + '\n');

// ── console summary ───────────────────────────────────────────────────────────

if (failedFiles.length === 0) {
  console.log(
    `[icon-lint] All ${totalUsages} icon usage${totalUsages === 1 ? '' : 's'} across ${totalFiles} file${totalFiles === 1 ? '' : 's'} are properly imported. ✓`,
  );
} else {
  for (const r of failedFiles) {
    for (const f of r.failures) {
      console.error(
        `[icon-lint] ${r.file}: "${f.identifier}" is used but not imported from @mui/icons-material`,
      );
    }
  }
  console.error(
    `[icon-lint] ${totalFailures} unimported icon usage${totalFailures === 1 ? '' : 's'} found across ${failedFiles.length} file${failedFiles.length === 1 ? '' : 's'}.`,
  );
  process.exit(1);
}
