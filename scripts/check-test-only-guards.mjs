#!/usr/bin/env node
/**
 * check-test-only-guards.mjs
 *
 * Enforces the test-only hook guard convention on server-side JS modules:
 *
 *   Any exported function whose name starts with `_` AND whose nearest JSDoc
 *   block contains the phrase "test-only" or "Never call in production" MUST
 *   contain an explicit
 *
 *     if (process.env.NODE_ENV === 'production') { throw … }
 *
 *   guard so that the hook throws immediately if called in production.
 *
 * ── Reference pattern (lead-status-guard.js) ─────────────────────────────────
 *
 *   /**
 *    * Test-only hook — replaces the internal pg pool with an arbitrary object.
 *    * Never call this in production code.
 *    *\/
 *   function _setPool(p) {
 *     if (process.env.NODE_ENV === 'production') {
 *       throw new Error('_setPool is a test-only hook …');
 *     }
 *     pool = p;
 *   }
 *   module.exports = { …, _setPool };
 *
 * ── Scanned surface ───────────────────────────────────────────────────────────
 *
 *   All `.js` files directly in the project root (server-side modules such as
 *   auth.js, design-visits.js, lead-status-guard.js, etc.).  Excluded:
 *     • node_modules/   — third-party code
 *     • test/           — test runner files (intentionally call these hooks)
 *     • public/         — client-side / build artifacts
 *     • scripts/        — dev / CI tooling, not production server code
 *     • migrations/     — schema migration files
 *
 * ── Detection logic ───────────────────────────────────────────────────────────
 *
 *   A function is flagged when ALL of the following are true:
 *     1. Its name starts with `_`.
 *     2. The JSDoc block immediately preceding it (up to 3 blank lines away)
 *        contains "test-only" or "Never call in production" (case-insensitive).
 *     3. The function name is exported from the module via `module.exports`,
 *        `module.exports.<name>`, or `exports.<name>`.
 *     4. Its body (up to the matching closing brace, capped at 60 lines) does
 *        NOT contain an `if (process.env.NODE_ENV === 'production') … throw`
 *        conditional guard.
 *     5. The function declaration line does NOT carry a suppression comment.
 *
 *   The guard is detected by matching:
 *     if ( process.env.NODE_ENV === 'production' ) … throw
 *   where the `…` may span up to 200 characters to allow multi-line blocks.
 *   Both `===` and `==` equality operators are accepted.
 *
 * ── Suppression ───────────────────────────────────────────────────────────────
 *
 *   // test-only-guard-ok: <reason>
 *
 *   Append to the function declaration line to suppress a specific violation.
 *   Reserved for hooks that use an alternative guard mechanism; document the
 *   mechanism in the reason string.
 *
 * Usage:
 *   node scripts/check-test-only-guards.mjs    # exits 1 on any violation
 *
 * Wired into CI via: npm run test:test-only-guards
 */

import { readFileSync, readdirSync } from 'fs';
import { resolve, relative, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── Trigger phrases (case-insensitive) ────────────────────────────────────────

const TRIGGER_RE = /test[-\s]only|never call (?:this )?in production/i;

// ── Guard detection ───────────────────────────────────────────────────────────
//
// Matches an if-statement that:
//   • tests process.env.NODE_ENV === (or ==) 'production'
//   • has a throw DIRECTLY inside the conditional body (not after it)
//
// Two accepted forms:
//   Block form:  if (…) { … throw … }   — \{[^}]*\bthrow\b
//                The [^}]* stops at the first }, so the throw must be inside
//                the block and not in a subsequent statement after the if.
//   Direct form: if (…) throw …         — \bthrow\b immediately after )
//
// Both === and == equality operators are accepted (={2,3} rules out bare =).

const PRODUCTION_GUARD_RE =
  /if\s*\(\s*process\.env\.NODE_ENV\s*={2,3}\s*['"]production['"]\s*\)\s*(?:\{[^}]*\bthrow\b|\bthrow\b)/;

// ── Suppression marker ────────────────────────────────────────────────────────

const SUPPRESSION = 'test-only-guard-ok';

// ── Files to scan: root-level .js only ───────────────────────────────────────

const rootEntries = readdirSync(ROOT, { withFileTypes: true });
const JS_FILES = rootEntries
  .filter(e => e.isFile() && e.name.endsWith('.js'))
  .map(e => resolve(ROOT, e.name));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true if the function-declaration line carries the suppression marker.
 */
function hasSuppression(line) {
  return line.includes(SUPPRESSION);
}

/**
 * Returns true if `funcName` is exported from the module whose full source
 * text is `src`.  Detects three CJS export patterns:
 *
 *   module.exports = { …, funcName, … }         — object shorthand
 *   module.exports = { …, funcName: …, … }       — explicit key
 *   module.exports.funcName = …                  — property assignment
 *   exports.funcName = …                         — exports property assignment
 *
 * The check is intentionally simple: it looks for the name as a word boundary
 * match inside a module.exports assignment block or as a direct property.
 */
function isExported(src, funcName) {
  // module.exports = { ..., funcName ... } — name appears anywhere in the
  // module.exports = { … } value block.
  // We match the opening brace and then look for the identifier as a word boundary.
  const objExportRe = new RegExp(
    `module\\.exports\\s*=\\s*\\{[^}]*\\b${funcName}\\b`,
  );

  // module.exports.funcName = …
  const dotExportRe = new RegExp(
    `module\\.exports\\.${funcName}\\s*=`,
  );

  // exports.funcName = …
  const exportsRe = new RegExp(
    `(?<!\\.module)\\bexports\\.${funcName}\\s*=`,
  );

  return objExportRe.test(src) || dotExportRe.test(src) || exportsRe.test(src);
}

/**
 * Given the array of all lines and the line index of a function declaration
 * (the line containing `function _foo` or `const _foo =`), extracts the body
 * text up to the matching closing `}` (or up to MAX_BODY_LINES lines,
 * whichever comes first) and returns it as a single string.
 *
 * Brace counting starts on the declaration line itself so it handles both
 * single-line and multi-line function forms.
 *
 * NOTE: this is a simple character-level scan and does not handle strings or
 * comments containing braces, but that is sufficient for the guard pattern
 * which appears near the top of small utility functions.
 */
const MAX_BODY_LINES = 60;

function extractFunctionBody(lines, declLine) {
  let depth = 0;
  const end = Math.min(lines.length, declLine + MAX_BODY_LINES);
  const collected = [];

  for (let i = declLine; i < end; i++) {
    const line = lines[i];
    collected.push(line);
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0 && i > declLine) {
          return collected.join('\n');
        }
      }
    }
  }
  return collected.join('\n');
}

/**
 * Returns true when the function body text contains an
 * `if (process.env.NODE_ENV === 'production') … throw` conditional guard.
 */
function hasProductionGuard(bodyText) {
  return PRODUCTION_GUARD_RE.test(bodyText);
}

// ── Function declaration patterns ─────────────────────────────────────────────
//
// Matches lines that declare a function whose name starts with `_`:
//   function _foo(…) {
//   async function _foo(…) {
//   const _foo = function(…) {
//   const _foo = async function(…) {
//   const _foo = (…) =>        — arrow function (multi-param / zero-param)
//   const _foo = async (…) =>
//
// The const/let/var variant requires the initializer to begin with `function`
// or `(` (the start of an arrow-function parameter list) to avoid matching
// non-function assignments like `const _key = 'value'`.
//
const FUNC_DECL_RE =
  /(?:async\s+)?function\s+(_\w+)\s*\(|(?:const|let|var)\s+(_\w+)\s*=\s*(?:async\s+)?(?:function\b|\()/;

// ── Scanner ───────────────────────────────────────────────────────────────────

function scanFile(filePath) {
  const src = readFileSync(filePath, 'utf8');
  const lines = src.split('\n');
  const violations = [];

  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trimStart();

    // Detect start of a JSDoc block: `/**`
    if (trimmed.startsWith('/**')) {
      const jsdocStart = i;
      let jsdocEnd = i;

      // Collect until closing `*/`
      while (jsdocEnd < lines.length && !lines[jsdocEnd].includes('*/')) {
        jsdocEnd++;
      }

      const jsdocText = lines.slice(jsdocStart, jsdocEnd + 1).join('\n');

      if (TRIGGER_RE.test(jsdocText)) {
        // Scan for the function declaration: allow up to 3 blank lines
        // between the JSDoc and the declaration.
        let funcLine = jsdocEnd + 1;
        let blankCount = 0;
        while (
          funcLine < lines.length &&
          blankCount <= 3 &&
          lines[funcLine].trim() === ''
        ) {
          funcLine++;
          blankCount++;
        }

        if (funcLine < lines.length) {
          const declLineText = lines[funcLine];
          const match = declLineText.match(FUNC_DECL_RE);

          if (match) {
            const funcName = match[1] || match[2];

            if (funcName && funcName.startsWith('_')) {
              if (hasSuppression(declLineText)) {
                // Explicitly suppressed — skip.
              } else if (!isExported(src, funcName)) {
                // Not exported — not part of the public test-only API; skip.
              } else {
                const bodyText = extractFunctionBody(lines, funcLine);
                if (!hasProductionGuard(bodyText)) {
                  violations.push({
                    file: relative(ROOT, filePath),
                    line: funcLine + 1,
                    funcName,
                    text: declLineText.trimEnd(),
                  });
                }
              }
            }
          }
        }
      }

      i = jsdocEnd + 1;
      continue;
    }

    i++;
  }

  return violations;
}

// ── Run ───────────────────────────────────────────────────────────────────────

const allViolations = [];
for (const file of JS_FILES) {
  allViolations.push(...scanFile(file));
}

// ── Report ────────────────────────────────────────────────────────────────────

console.log(
  `check-test-only-guards: scanned ${JS_FILES.length} root-level server-side JS module(s)\n` +
  `  (test/, public/, scripts/, migrations/, node_modules/ excluded)\n`,
);

if (allViolations.length === 0) {
  console.log(
    '✓ All exported test-only hooks carry an\n' +
    "  `if (process.env.NODE_ENV === 'production') throw` guard.\n" +
    '  Reference pattern: lead-status-guard.js (_setPool, _forceStaleForTest).',
  );
  process.exit(0);
}

console.error(
  `✗ ${allViolations.length} exported test-only hook(s) are missing the production guard:\n`,
);

for (const v of allViolations) {
  console.error(`  ${v.file}:${v.line}  ${v.funcName}`);
  console.error(`    ${v.text}\n`);
}

console.error(
  'Fix: add the following guard inside the function body:\n' +
  '\n' +
  "  if (process.env.NODE_ENV === 'production') {\n" +
  "    throw new Error('<funcName> is a test-only hook and must not be called in production.');\n" +
  '  }\n' +
  '\n' +
  'Suppression: for hooks that use an alternative guard mechanism, append\n' +
  '  // test-only-guard-ok: <reason>\n' +
  'to the function declaration line.\n',
);

process.exit(1);
