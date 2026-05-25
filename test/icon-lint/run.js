'use strict';
// test/icon-lint/run.js
//
// Static lint check with two complementary passes:
//
//  Pass 1 — used-but-not-imported:
//    Every identifier ending with `Icon` that is used as a JSX element
//    (<FooIcon …/>) or as a bare value (e.g. in an object literal or passed
//    as a prop value) in any React component or TypeScript registry file under
//    `src/react/` must be actually imported from `@mui/icons-material` in that
//    same file.
//
//  Pass 2 — imported-but-never-used:
//    Every identifier imported from `@mui/icons-material` must appear at
//    least once as a JSX element or bare value reference in the file body
//    (outside the import declaration itself). Dead imports are flagged as
//    dead code / copy-paste leftovers.
//
// Both `.tsx` and `.ts` files are scanned (`.d.ts` declaration files and
// Storybook files are excluded). In plain `.ts` files JSX tags will never
// appear, but bare-value usages (icon constructors passed in config/registry
// objects) are still detected and validated.
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
 * Strip single-line comments (`//…`) and quoted string literals (single,
 * double, and template) from source text before scanning for icon usages.
 *
 * This prevents false positives such as:
 *   // import DeleteIcon here
 *   const label = 'DeleteIcon';
 * from being counted as real usages of the DeleteIcon identifier.
 *
 * The replacement preserves newlines so that multi-line template literals
 * don't collapse the surrounding code onto one line and confuse the regexes
 * that follow. Everything else inside a matched token is replaced with a
 * space so overall character positions stay roughly stable.
 *
 * The single combined regex processes left-to-right, ensuring that `//`
 * inside a string literal is consumed as part of the string and never
 * treated as a line-comment start.
 */
function stripCommentsAndStrings(src) {
  return src.replace(
    /`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\/\/[^\n]*/g,
    (match) => match.replace(/[^\n]/g, ' '),
  );
}

/**
 * Remove all import declarations that reference @mui/icons-material so that
 * the usage scan does not accidentally count imported names as "used" just
 * because they appear in the import statement itself.
 *
 * Handles both default imports and named imports (including multi-line braces).
 */
function stripIconImportLines(src) {
  // Default imports: import FooIcon from '@mui/icons-material/Foo'
  let stripped = src.replace(
    /import\s+\w+\s+from\s+['"]@mui\/icons-material[^'"]*['"]\s*;?/g,
    '',
  );
  // Named imports (possibly multi-line): import { FooIcon, BarIcon } from '@mui/icons-material'
  stripped = stripped.replace(
    /import\s+\{[^}]+\}\s+from\s+['"]@mui\/icons-material[^'"]*['"]\s*;?/g,
    '',
  );
  return stripped;
}

/**
 * Find all identifiers that look like icon component references in the source
 * body (import declarations must already be stripped via stripIconImportLines):
 *  - JSX opening/self-closing tags:  <FooIcon  <FooIcon/  <FooIcon>
 *  - Bare value in JSX expression:   {<FooIcon … />}
 *  - Value position:  Icon: FooIcon   icon={FooIcon}
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

// ── smoke tests ───────────────────────────────────────────────────────────────
// Lightweight inline assertions that run once on startup to guard the helpers
// against regressions.  A failure here exits immediately with a clear message.

(function runSmokeTests() {
  function assert(cond, msg) {
    if (!cond) {
      console.error(`[icon-lint] Smoke test FAILED: ${msg}`);
      process.exit(1);
    }
  }

  // --- stripCommentsAndStrings ---

  // 1. Identifier appearing ONLY in a // comment must not be detected as used.
  {
    const src = [
      "import DeleteIcon from '@mui/icons-material/Delete';",
      '// DeleteIcon is mentioned here but not actually used',
      'export const Foo = () => <div />;',
    ].join('\n');
    const bodySrc = stripCommentsAndStrings(stripIconImportLines(src));
    const usages  = extractIconUsages(bodySrc);
    assert(
      usages.every((u) => u.identifier !== 'DeleteIcon'),
      'DeleteIcon in a // comment must not be counted as a real usage',
    );
  }

  // 2. Identifier appearing ONLY in a single-quoted string must not be detected.
  {
    const src = [
      "import AddIcon from '@mui/icons-material/Add';",
      "const label = 'AddIcon';",
      'export const Bar = () => <div />;',
    ].join('\n');
    const bodySrc = stripCommentsAndStrings(stripIconImportLines(src));
    const usages  = extractIconUsages(bodySrc);
    assert(
      usages.every((u) => u.identifier !== 'AddIcon'),
      'AddIcon in a single-quoted string must not be counted as a real usage',
    );
  }

  // 3. Identifier appearing ONLY in a double-quoted string must not be detected.
  {
    const src = [
      "import EditIcon from '@mui/icons-material/Edit';",
      'const key = "EditIcon";',
      'export const Baz = () => <div />;',
    ].join('\n');
    const bodySrc = stripCommentsAndStrings(stripIconImportLines(src));
    const usages  = extractIconUsages(bodySrc);
    assert(
      usages.every((u) => u.identifier !== 'EditIcon'),
      'EditIcon in a double-quoted string must not be counted as a real usage',
    );
  }

  // 4. A real JSX usage must still be detected after stripping.
  {
    const src = [
      "import SaveIcon from '@mui/icons-material/Save';",
      '// SaveIcon is used below',
      'export const Widget = () => <SaveIcon />;',
    ].join('\n');
    const bodySrc = stripCommentsAndStrings(stripIconImportLines(src));
    const usages  = extractIconUsages(bodySrc);
    assert(
      usages.some((u) => u.identifier === 'SaveIcon'),
      'SaveIcon used as a JSX element must still be detected after stripping',
    );
  }

  // 5. `//` inside a string literal must not be treated as a line-comment start.
  {
    const src = [
      "import CloseIcon from '@mui/icons-material/Close';",
      "const url = 'https://example.com'; // fine",
      'export const Link = () => <CloseIcon />;',
    ].join('\n');
    const bodySrc = stripCommentsAndStrings(stripIconImportLines(src));
    const usages  = extractIconUsages(bodySrc);
    assert(
      usages.some((u) => u.identifier === 'CloseIcon'),
      'CloseIcon after a string containing // must still be detected',
    );
  }
})();

// ── scan ─────────────────────────────────────────────────────────────────────

// Include both .tsx and .ts files; exclude .d.ts declaration files and
// Storybook story files (.stories.tsx / .stories.ts).
const files = walkSync(
  SRC_ROOT,
  (name) =>
    (name.endsWith('.tsx') || (name.endsWith('.ts') && !name.endsWith('.d.ts'))) &&
    !name.endsWith('.stories.tsx') &&
    !name.endsWith('.stories.ts'),
);

if (files.length === 0) {
  console.error('[icon-lint] No .tsx/.ts files found under src/react/');
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

  // Strip icon import lines before scanning usages so that the imported
  // identifiers themselves don't appear as "used" just from the import line.
  // Also strip comments and string literals so that an identifier appearing
  // only inside `// a comment` or `'a string'` is not counted as a real usage.
  const bodySrc = stripCommentsAndStrings(stripIconImportLines(src));
  const usages  = extractIconUsages(bodySrc);
  const usedSet = new Set(usages.map((u) => u.identifier));

  // Only report files that either import icons or use icons — skip purely
  // non-icon files to keep the report tidy.
  if (imports.size === 0 && usages.length === 0) continue;

  // Pass 1: used but not imported.
  const failures = usages.filter((u) => !imports.has(u.identifier));

  // Pass 2: imported but never used.
  const unusedImports = [...imports].filter((name) => !usedSet.has(name));

  const rel = path.relative(path.resolve(__dirname, '../..'), file);

  fileResults.push({ file: rel, imports, usages, failures, unusedImports });
}

// ── report ────────────────────────────────────────────────────────────────────

const totalFiles         = fileResults.length;
const failedFiles        = fileResults.filter((r) => r.failures.length > 0);
const unusedImportFiles  = fileResults.filter((r) => r.unusedImports.length > 0);
const totalUsages        = fileResults.reduce((n, r) => n + r.usages.length, 0);
const totalFailures      = failedFiles.reduce((n, r) => n + r.failures.length, 0);
const totalUnused        = unusedImportFiles.reduce((n, r) => n + r.unusedImports.length, 0);

const lines = [
  '# icon-lint',
  '',
  `Scanned ${totalFiles} source file${totalFiles === 1 ? '' : 's'} (.tsx and .ts).`,
  `Found ${totalUsages} icon usage${totalUsages === 1 ? '' : 's'} across all files.`,
  '',
];

// ── Pass 1: used-but-not-imported ────────────────────────────────────────────

if (failedFiles.length === 0) {
  lines.push(`**Pass 1 (used but not imported): All ${totalUsages} icon usages are properly imported. ✓**`);
} else {
  lines.push(`**Pass 1 (used but not imported): ${totalFailures} unimported icon usage${totalFailures === 1 ? '' : 's'} in ${failedFiles.length} file${failedFiles.length === 1 ? '' : 's'}:**`);
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

// ── Pass 2: imported-but-never-used ──────────────────────────────────────────

if (unusedImportFiles.length === 0) {
  lines.push(`**Pass 2 (imported but never used): No unused icon imports found. ✓**`);
} else {
  lines.push(`**Pass 2 (imported but never used): ${totalUnused} unused icon import${totalUnused === 1 ? '' : 's'} in ${unusedImportFiles.length} file${unusedImportFiles.length === 1 ? '' : 's'}:**`);
  lines.push('');
  for (const r of unusedImportFiles) {
    lines.push(`### \`${r.file}\``);
    for (const name of r.unusedImports) {
      lines.push(`- **\`${name}\`** is imported from \`@mui/icons-material\` but never used`);
    }
    lines.push('');
  }
}

lines.push('');
lines.push('## Per-file summary');
lines.push('');
lines.push('| file | icon imports | icon usages | unimported | unused imports |');
lines.push('| ---- | ----------- | ----------- | ---------- | -------------- |');
for (const r of fileResults) {
  const failFlag   = r.failures.length > 0      ? ` ⚠ **${r.failures.length}**`     : '0';
  const unusedFlag = r.unusedImports.length > 0 ? ` ⚠ **${r.unusedImports.length}**` : '0';
  lines.push(`| \`${r.file}\` | ${r.imports.size} | ${r.usages.length} | ${failFlag} | ${unusedFlag} |`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n') + '\n');

// ── console summary ───────────────────────────────────────────────────────────

let hasErrors = false;

if (failedFiles.length > 0) {
  hasErrors = true;
  for (const r of failedFiles) {
    for (const f of r.failures) {
      console.error(
        `[icon-lint] ${r.file}: "${f.identifier}" is used but not imported from @mui/icons-material`,
      );
    }
  }
  console.error(
    `[icon-lint] Pass 1: ${totalFailures} unimported icon usage${totalFailures === 1 ? '' : 's'} found across ${failedFiles.length} file${failedFiles.length === 1 ? '' : 's'}.`,
  );
}

if (unusedImportFiles.length > 0) {
  hasErrors = true;
  for (const r of unusedImportFiles) {
    for (const name of r.unusedImports) {
      console.error(
        `[icon-lint] ${r.file}: "${name}" is imported from @mui/icons-material but never used`,
      );
    }
  }
  console.error(
    `[icon-lint] Pass 2: ${totalUnused} unused icon import${totalUnused === 1 ? '' : 's'} found across ${unusedImportFiles.length} file${unusedImportFiles.length === 1 ? '' : 's'}.`,
  );
}

if (!hasErrors) {
  console.log(
    `[icon-lint] All ${totalUsages} icon usage${totalUsages === 1 ? '' : 's'} across ${totalFiles} file${totalFiles === 1 ? '' : 's'} are properly imported, and all imports are used. ✓`,
  );
} else {
  process.exit(1);
}
