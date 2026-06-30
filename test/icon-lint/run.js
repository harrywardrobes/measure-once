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
 * Uses a full character-by-character parser (rather than a regex) so that
 * template literals nested inside ${} interpolations are handled correctly:
 *
 *   `outer ${`inner ${FooIcon}`} more`
 *
 * The outer regex approach fails here because it cannot match a backtick-
 * delimited literal that itself contains backticks.  The recursive parser
 * tracks string/template nesting depth and correctly blanks only the static
 * parts of each template, preserving all ${...} expression content so that
 * icon identifiers inside them are visible to the usage scan.
 *
 * Single-quoted and double-quoted strings inside interpolations also stop
 * at newlines to avoid spanning multiple lines on a lone unmatched quote.
 */
function stripCommentsAndStrings(src) {
  let result = '';
  let i = 0;

  function blankNonNewline(ch) {
    result += ch === '\n' ? '\n' : ' ';
  }

  // Parse a single-quoted string body (opening ' already consumed).
  // Blanks content; stops at closing ' or newline.
  function parseSingleQuoted() {
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\\') {
        blankNonNewline(' ');
        blankNonNewline(' ');
        i += 2;
      } else if (ch === "'" || ch === '\n') {
        blankNonNewline(ch);
        i++;
        return;
      } else {
        blankNonNewline(ch);
        i++;
      }
    }
  }

  // Parse a double-quoted string body (opening " already consumed).
  function parseDoubleQuoted() {
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\\') {
        blankNonNewline(' ');
        blankNonNewline(' ');
        i += 2;
      } else if (ch === '"' || ch === '\n') {
        blankNonNewline(ch);
        i++;
        return;
      } else {
        blankNonNewline(ch);
        i++;
      }
    }
  }

  // Forward declaration — parseTemplateLiteralBody and parseInterpolationBody
  // are mutually recursive.
  let parseTemplateLiteralBody;

  // Parse inside a ${...} interpolation (the ${ has already been emitted).
  // Emits content verbatim so icon identifiers remain visible.
  // Stops (without emitting the closing }) when the matching } is found.
  // Handles: nested braces, nested template literals, nested strings.
  function parseInterpolationBody() {
    let depth = 1;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '{') {
        depth++;
        result += ch;
        i++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          i++; // consume the closing }
          return;
        }
        result += ch;
        i++;
      } else if (ch === '`') {
        // Nested template literal inside the interpolation.
        // Blank its static parts but preserve its own ${...} expressions.
        i++; // consume opening backtick (blanked — it's not an identifier)
        parseTemplateLiteralBody();
        // parseTemplateLiteralBody consumes the closing backtick
      } else if (ch === "'") {
        // Apply the same word-character guard used in the main parse loop:
        // an apostrophe preceded by a word character is prose (e.g. "You're"),
        // not a JS string delimiter.
        const prevCh = i > 0 ? src[i - 1] : '';
        if (/\w/.test(prevCh)) {
          result += ch;
          i++;
        } else {
          i++; // consume opening quote
          parseSingleQuoted();
        }
      } else if (ch === '"') {
        i++; // consume opening quote
        parseDoubleQuoted();
      } else if (ch === '/' && i + 1 < src.length && src[i + 1] === '/') {
        // Line comment inside interpolation (edge case)
        while (i < src.length && src[i] !== '\n') {
          result += ' ';
          i++;
        }
      } else if (ch === '/' && i + 1 < src.length && src[i + 1] === '*') {
        // Block comment inside interpolation (edge case)
        i += 2;
        while (i < src.length) {
          if (src[i] === '*' && i + 1 < src.length && src[i + 1] === '/') {
            result += '  ';
            i += 2;
            break;
          }
          blankNonNewline(src[i]);
          i++;
        }
      } else {
        result += ch;
        i++;
      }
    }
  }

  // Parse a template literal body (opening backtick already consumed).
  // Blanks static parts; preserves ${...} interpolation content.
  // Consumes the closing backtick before returning.
  parseTemplateLiteralBody = function () {
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\\') {
        result += src[i + 1] === '\n' ? ' \n' : '  ';
        i += 2;
      } else if (ch === '`') {
        // Closing backtick of this template literal
        i++;
        return;
      } else if (ch === '$' && i + 1 < src.length && src[i + 1] === '{') {
        // Interpolation — emit ${ so the content remains in result, then
        // parse the body, then emit } to close.
        result += '${';
        i += 2;
        parseInterpolationBody();
        result += '}';
      } else {
        // Static template content — blank, preserve newlines.
        blankNonNewline(ch);
        i++;
      }
    }
  };

  // Main parse loop
  while (i < src.length) {
    const ch = src[i];
    if (ch === '/' && i + 1 < src.length && src[i + 1] === '/') {
      // Line comment — blank to end of line
      while (i < src.length && src[i] !== '\n') {
        result += ' ';
        i++;
      }
    } else if (ch === '/' && i + 1 < src.length && src[i + 1] === '*') {
      // Block comment — blank everything, preserve newlines
      i += 2;
      while (i < src.length) {
        if (src[i] === '*' && i + 1 < src.length && src[i + 1] === '/') {
          result += '  ';
          i += 2;
          break;
        }
        blankNonNewline(src[i]);
        i++;
      }
    } else if (ch === '"') {
      result += ' '; // blank the opening quote
      i++;
      parseDoubleQuoted();
    } else if (ch === "'") {
      // Only treat as a JS string delimiter when the preceding character is NOT
      // a word character.  An apostrophe inside JSX text content (e.g. "You're",
      // "MUI's") is always preceded by a letter/digit, whereas a real JS string
      // literal opening quote is always preceded by whitespace or a punctuation
      // character such as =, :, (, [, {, or , .
      const prevCh = i > 0 ? src[i - 1] : '';
      if (/\w/.test(prevCh)) {
        // Apostrophe in prose — emit as-is, do not strip.
        result += ch;
        i++;
      } else {
        result += ' '; // blank the opening quote
        i++;
        parseSingleQuoted();
      }
    } else if (ch === '`') {
      result += ' '; // blank the opening backtick
      i++;
      parseTemplateLiteralBody();
    } else {
      result += ch;
      i++;
    }
  }

  return result;
}

/**
 * Extract the set of local identifier names imported from @mui/material
 * (including @mui/material/* sub-paths).  These are MUI layout/input
 * components — some happen to end in "Icon" (e.g. ListItemIcon) but are
 * NOT icon components from @mui/icons-material.  The Pass-1 check uses
 * this set to avoid false-positive "used but not imported from icons-material"
 * errors for those components.
 */
function extractMaterialImports(src) {
  const imported = new Set();

  // Default imports: import ListItemIcon from '@mui/material/ListItemIcon'
  const defaultRe = /import\s+(\w+)\s+from\s+['"]@mui\/material[^'"]*['"]/g;
  let m;
  while ((m = defaultRe.exec(src)) !== null) {
    imported.add(m[1]);
  }

  // Named imports: import { ListItemIcon, ... } from '@mui/material'
  const namedRe = /import\s+\{([^}]+)\}\s+from\s+['"]@mui\/material[^'"]*['"]/g;
  while ((m = namedRe.exec(src)) !== null) {
    for (const raw of m[1].split(',')) {
      const parts = raw.trim().split(/\s+as\s+/);
      const localName = (parts[1] || parts[0]).trim();
      if (localName) imported.add(localName);
    }
  }

  return imported;
}

/**
 * Extract every local identifier imported from ANY module (not just MUI), so
 * Pass 1 can tell a genuinely-missing @mui icon import apart from a local
 * component that merely happens to end in "Icon" (e.g. a styled component or a
 * project file like CheckBadgeIcon imported from './CheckBadgeIcon').
 */
function extractAllImportedNames(src) {
  const names = new Set();
  // Default imports: import Foo from '...'
  let re = /import\s+(\w+)\s+from\s+['"][^'"]+['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) names.add(m[1]);
  // Named imports: import { Foo, Bar as Baz } from '...'
  re = /import\s+(?:\w+\s*,\s*)?\{([^}]+)\}\s+from\s+['"][^'"]+['"]/g;
  while ((m = re.exec(src)) !== null) {
    for (const raw of m[1].split(',')) {
      const parts = raw.trim().split(/\s+as\s+/);
      const localName = (parts[1] || parts[0]).trim();
      if (localName) names.add(localName);
    }
  }
  return names;
}

/**
 * Extract identifiers declared locally in the file (const/let/var/function/
 * class/type/interface, with or without `export`). Used by Pass 1 to exclude
 * locally-defined `…Icon` identifiers (styled components, type aliases, local
 * icon components) from the "used but not imported" check.
 */
function extractLocalDeclarations(src) {
  const names = new Set();
  const re = /(?:^|[\n;])\s*(?:export\s+)?(?:default\s+)?(?:const|let|var|function|class|type|interface)\s+(\w+)/g;
  let m;
  while ((m = re.exec(src)) !== null) names.add(m[1]);
  return names;
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

  // 6. Identifier appearing ONLY inside a block comment must not be detected.
  {
    const src = [
      "import InfoIcon from '@mui/icons-material/Info';",
      '/* Use InfoIcon here to display a tooltip */',
      'export const Hint = () => <div />;',
    ].join('\n');
    const bodySrc = stripCommentsAndStrings(stripIconImportLines(src));
    const usages  = extractIconUsages(bodySrc);
    assert(
      usages.every((u) => u.identifier !== 'InfoIcon'),
      'InfoIcon in a /* block comment */ must not be counted as a real usage',
    );
  }

  // 7. Identifier appearing ONLY inside a multi-line JSDoc comment must not be detected.
  {
    const src = [
      "import WarningIcon from '@mui/icons-material/Warning';",
      '/**',
      ' * @param icon - pass WarningIcon for alerts',
      ' */',
      'export function render() { return null; }',
    ].join('\n');
    const bodySrc = stripCommentsAndStrings(stripIconImportLines(src));
    const usages  = extractIconUsages(bodySrc);
    assert(
      usages.every((u) => u.identifier !== 'WarningIcon'),
      'WarningIcon in a /** JSDoc block comment */ must not be counted as a real usage',
    );
  }

  // 8. Identifier used inside a template-literal interpolation ${...} must be detected.
  {
    const src = [
      "import FolderIcon from '@mui/icons-material/Folder';",
      'const key = `prefix-${FolderIcon}-suffix`;',
    ].join('\n');
    const bodySrc = stripCommentsAndStrings(stripIconImportLines(src));
    const usages  = extractIconUsages(bodySrc);
    assert(
      usages.some((u) => u.identifier === 'FolderIcon'),
      'FolderIcon inside a template literal ${...} interpolation must be detected as a usage',
    );
  }

  // 9. Identifier in the static (non-interpolation) part of a template literal must NOT be detected.
  {
    const src = [
      "import StarIcon from '@mui/icons-material/Star';",
      'const label = `StarIcon`;',
    ].join('\n');
    const bodySrc = stripCommentsAndStrings(stripIconImportLines(src));
    const usages  = extractIconUsages(bodySrc);
    assert(
      usages.every((u) => u.identifier !== 'StarIcon'),
      'StarIcon in a template literal static string part must not be counted as a real usage',
    );
  }

  // 10. Identifier in a TypeScript `typeof` type annotation must be detected.
  //     e.g. `type MyIcon = typeof HomeIcon;`
  //     The space before the identifier is matched by the \s branch of valueRe.
  {
    const src = [
      "import HomeIcon from '@mui/icons-material/Home';",
      'type MyIcon = typeof HomeIcon;',
    ].join('\n');
    const bodySrc = stripCommentsAndStrings(stripIconImportLines(src));
    const usages  = extractIconUsages(bodySrc);
    assert(
      usages.some((u) => u.identifier === 'HomeIcon'),
      'HomeIcon in a `typeof HomeIcon` type annotation must be detected as a usage',
    );
  }

  // 11. Identifier as a generic type argument must be detected.
  //     e.g. `React.ComponentType<CheckIcon>` — caught by the jsxRe (<CheckIcon).
  {
    const src = [
      "import CheckIcon from '@mui/icons-material/Check';",
      'function render(icon: React.ComponentType<CheckIcon>) { return null; }',
    ].join('\n');
    const bodySrc = stripCommentsAndStrings(stripIconImportLines(src));
    const usages  = extractIconUsages(bodySrc);
    assert(
      usages.some((u) => u.identifier === 'CheckIcon'),
      'CheckIcon as a generic type argument (<CheckIcon>) must be detected as a usage',
    );
  }

  // 12. Identifier inside a template-literal interpolation that itself contains
  //     nested braces (e.g. `${fn({ icon: FooIcon })}`) must still be detected.
  //     This guards against the prior `[^}]*` regex that mis-parsed the first
  //     inner `}` as closing the interpolation.
  {
    const src = [
      "import BrushIcon from '@mui/icons-material/Brush';",
      'const x = `result: ${fn({ icon: BrushIcon, label: "hi" })}`;',
    ].join('\n');
    const bodySrc = stripCommentsAndStrings(stripIconImportLines(src));
    const usages  = extractIconUsages(bodySrc);
    assert(
      usages.some((u) => u.identifier === 'BrushIcon'),
      'BrushIcon inside a nested-brace template interpolation ${fn({ icon: BrushIcon })} must be detected',
    );
  }

  // 13. A lone single-quote in JSX text (e.g. sx={{ color: 'text.secondary' }})
  //     must NOT cause the icon identifier on a SUBSEQUENT line to be swallowed.
  //     This guards against the multi-line false-match bug where '...' was allowed
  //     to span newlines, causing { Icon: FooIcon } object entries to disappear.
  {
    const src = [
      "import ArrowBackIcon from '@mui/icons-material/ArrowBack';",
      "const x = <Box sx={{ color: 'text.secondary' }}></Box>;",
      "const entries = [{ Icon: ArrowBackIcon, name: 'Back' }];",
    ].join('\n');
    const bodySrc = stripCommentsAndStrings(stripIconImportLines(src));
    const usages  = extractIconUsages(bodySrc);
    assert(
      usages.some((u) => u.identifier === 'ArrowBackIcon'),
      'ArrowBackIcon used as a value on the line after a JSX sx prop with single quotes must still be detected',
    );
  }

  // 14. An identifier ending in "Icon" that is imported from @mui/material (not
  //     @mui/icons-material) must NOT be flagged as "used but not imported" in
  //     Pass 1. ListItemIcon is the canonical example.
  {
    const src = [
      "import ListItemIcon from '@mui/material/ListItemIcon';",
      'export const Nav = () => <ListItemIcon><span /></ListItemIcon>;',
    ].join('\n');
    const imports = extractIconImports(src);
    const materialImports = extractMaterialImports(src);
    const bodySrc = stripCommentsAndStrings(stripIconImportLines(src));
    const usages  = extractIconUsages(bodySrc);
    const failures = usages.filter((u) => !imports.has(u.identifier) && !materialImports.has(u.identifier));
    assert(
      failures.every((f) => f.identifier !== 'ListItemIcon'),
      'ListItemIcon imported from @mui/material must not be flagged as unimported from @mui/icons-material',
    );
  }

  // 15. An identifier appearing ONLY in the static (non-interpolated) portion of
  //     a template literal nested inside a ${} interpolation must NOT be detected.
  //     e.g. `outer ${ `static ZoomIcon` } more`
  //     The inner template `static ZoomIcon` has no ${} of its own, so ZoomIcon
  //     lives entirely in blanked-out static content and must be invisible to the
  //     usage scanner.
  {
    const src = [
      "import ZoomIcon from '@mui/icons-material/Zoom';",
      'const x = `outer ${ `static ZoomIcon` } more`;',
    ].join('\n');
    const bodySrc = stripCommentsAndStrings(stripIconImportLines(src));
    const usages  = extractIconUsages(bodySrc);
    assert(
      usages.every((u) => u.identifier !== 'ZoomIcon'),
      'ZoomIcon in the static part of a nested template literal inside ${} must not be counted as a real usage',
    );
  }

  // 16. An apostrophe in JSX text content (e.g. "You're", "MUI's") must NOT
  //     cause an icon identifier on the SAME LINE to be swallowed into the
  //     "string body" and thus missed.  This guards against the bug where the
  //     scanner treated any lone `'` as a JS string-literal opener, creating a
  //     dead zone from the apostrophe to the next `'` or end-of-line.
  {
    const src = [
      "import CheckCircleIcon from '@mui/icons-material/CheckCircle';",
      "<Typography>You're all clear. <CheckCircleIcon /></Typography>",
    ].join('\n');
    const bodySrc = stripCommentsAndStrings(stripIconImportLines(src));
    const usages  = extractIconUsages(bodySrc);
    assert(
      usages.some((u) => u.identifier === 'CheckCircleIcon'),
      "CheckCircleIcon on the same line as an apostrophe (You're) must not be swallowed",
    );
  }

  // 17. An apostrophe following a word character must not suppress stripping of
  //     a REAL single-quoted JS string that appears later on the same line.
  //     e.g.  `it's safe` followed by `const x = 'AddIcon'`
  {
    const src = [
      "import AddIcon from '@mui/icons-material/Add';",
      "const label = \"it's safe\"; const x = 'AddIcon';",
    ].join('\n');
    const bodySrc = stripCommentsAndStrings(stripIconImportLines(src));
    const usages  = extractIconUsages(bodySrc);
    assert(
      usages.every((u) => u.identifier !== 'AddIcon'),
      "AddIcon inside a single-quoted string after an apostrophe-word must still be stripped",
    );
  }

  // 18. Identifier inside a template literal that is itself nested inside a
  //     ${} interpolation of an outer template literal must be detected.
  //     e.g. `outer ${`inner ${FooIcon}`} more`
  //     The outer regex approach fails here because the outer backtick regex
  //     terminates at the first inner backtick; the character-by-character
  //     parser handles this correctly via mutual recursion.
  {
    const src = [
      "import LayersIcon from '@mui/icons-material/Layers';",
      'const x = `outer ${ `inner ${LayersIcon}` } more`;',
    ].join('\n');
    const bodySrc = stripCommentsAndStrings(stripIconImportLines(src));
    const usages  = extractIconUsages(bodySrc);
    assert(
      usages.some((u) => u.identifier === 'LayersIcon'),
      'LayersIcon inside a template literal nested within a ${} interpolation must be detected as a usage',
    );
  }

  // 19. An apostrophe inside a ${} interpolation body must NOT cause an icon
  //     identifier that follows it to be swallowed.
  //     e.g. `You're all clear. ${<FooIcon />}`
  //     Before the fix, parseInterpolationBody treated the apostrophe in
  //     "You're" as a JS string-literal opener and consumed everything up to
  //     the next `'` or end-of-line, hiding the icon identifier.
  {
    const src = [
      "import CheckCircleIcon from '@mui/icons-material/CheckCircle';",
      'const msg = `You\'re all clear. ${<CheckCircleIcon />}`;',
    ].join('\n');
    const bodySrc = stripCommentsAndStrings(stripIconImportLines(src));
    const usages  = extractIconUsages(bodySrc);
    assert(
      usages.some((u) => u.identifier === 'CheckCircleIcon'),
      "CheckCircleIcon inside a template-literal interpolation after an apostrophe (You're) must not be swallowed",
    );
  }

  // 20. A REAL single-quoted JS string appearing after an apostrophe-word
  //     inside a ${} interpolation must have its contents stripped.
  //     e.g. `it's nice ${const y = 'AddIcon'}`
  //     The apostrophe in "it's" is prose (must NOT open a string literal);
  //     the 'AddIcon' that follows inside the interpolation IS a JS string
  //     and must be stripped so the identifier does not appear in usages.
  {
    const src = [
      "import AddIcon from '@mui/icons-material/Add';",
      "const x = `it's nice ${const y = 'AddIcon'}`;",
    ].join('\n');
    const bodySrc = stripCommentsAndStrings(stripIconImportLines(src));
    const usages  = extractIconUsages(bodySrc);
    assert(
      usages.every((u) => u.identifier !== 'AddIcon'),
      "AddIcon inside a single-quoted string within a template interpolation after an apostrophe-word must be stripped",
    );
  }

  // --- extractAllImportedNames / extractLocalDeclarations (Pass 1 exclusions) ---

  // 21. A `…Icon` identifier imported from a LOCAL module (not @mui) must be
  //     recognised by extractAllImportedNames so Pass 1 doesn't flag it.
  {
    const src = "import CheckBadgeIcon from './CheckBadgeIcon';";
    assert(
      extractAllImportedNames(src).has('CheckBadgeIcon'),
      'extractAllImportedNames must include a default import from a local module',
    );
  }

  // 22. A locally-declared `…Icon` (styled component / type alias) must be
  //     recognised by extractLocalDeclarations so Pass 1 doesn't flag it.
  {
    const src = [
      'export const SkeletonIcon = styled(Box)({});',
      'type MuiIcon = React.ComponentType<unknown>;',
    ].join('\n');
    const decls = extractLocalDeclarations(src);
    assert(decls.has('SkeletonIcon'), 'extractLocalDeclarations must find an exported const declaration');
    assert(decls.has('MuiIcon'), 'extractLocalDeclarations must find a type alias declaration');
  }

  // 23. A value-usage of an icon whose name does NOT end in "Icon" (e.g.
  //     EmailOutlined used as a map value) must be seen as "used" by the
  //     import-stripped bare-word fallback that Pass 2 relies on.
  {
    const src = [
      "import { EmailOutlined } from '@mui/icons-material';",
      'const TYPE_ICON = { email: EmailOutlined };',
    ].join('\n');
    const importStripped = stripIconImportLines(src);
    assert(
      /\bEmailOutlined\b/.test(importStripped),
      'EmailOutlined used as a map value must remain visible in the import-stripped source for Pass 2',
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

  const imports         = extractIconImports(src);
  const materialImports = extractMaterialImports(src);
  const allImported     = extractAllImportedNames(src);
  const localDecls      = extractLocalDeclarations(src);

  // Strip icon import lines before scanning usages so that the imported
  // identifiers themselves don't appear as "used" just from the import line.
  // Also strip comments and string literals so that an identifier appearing
  // only inside `// a comment` or `'a string'` is not counted as a real usage.
  const importStripped = stripIconImportLines(src);
  const bodySrc = stripCommentsAndStrings(importStripped);
  const usages  = extractIconUsages(bodySrc);
  const usedSet = new Set(usages.map((u) => u.identifier));

  // Only report files that either import icons or use icons — skip purely
  // non-icon files to keep the report tidy.
  if (imports.size === 0 && usages.length === 0) continue;

  // Pass 1: used but neither imported nor defined anywhere.
  // Excludes identifiers imported from @mui/material (e.g. ListItemIcon),
  // imported from any other module (e.g. a local CheckBadgeIcon component), or
  // declared locally (styled components, `type MuiIcon`, etc.) — those are
  // valid identifiers that merely end in "Icon" and are not missing @mui icon
  // imports. A genuinely missing icon import is still caught (not defined or
  // imported anywhere).
  const failures = usages.filter(
    (u) =>
      !imports.has(u.identifier) &&
      !materialImports.has(u.identifier) &&
      !allImported.has(u.identifier) &&
      !localDecls.has(u.identifier),
  );

  // Pass 2: imported but never used.
  // A name counts as used when extractIconUsages found it (a JSX element, or a
  // value whose identifier ends in "Icon") OR it appears as a bare-word
  // reference anywhere in the import-stripped source. The bare-word fallback
  // covers two cases the *Icon-suffix JSX/value scan misses:
  //   1. icons whose imported name does NOT end in "Icon" (e.g. EmailOutlined)
  //      used as map/registry values like `TYPE_ICON.email = EmailOutlined`;
  //   2. usages the string/comment stripper would over-eagerly blank in some
  //      files (a real `<AttachFileIcon />` near tricky JSX/quoting).
  // It checks the import-stripped (but otherwise raw) source so a genuine code
  // reference is never missed; the only cost is that an icon mentioned solely in
  // a comment counts as used, which is a safe, rare trade-off vs. false dead-code
  // failures that block CI.
  const unusedImports = [...imports].filter(
    (name) => !usedSet.has(name) && !new RegExp(`\\b${name}\\b`).test(importStripped),
  );

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
