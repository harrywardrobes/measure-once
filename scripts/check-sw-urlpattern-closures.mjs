#!/usr/bin/env node
/**
 * scripts/check-sw-urlpattern-closures.mjs
 *
 * Static lint: every `urlPattern` function in scripts/build-sw.mjs must be
 * self-contained — it must not reference any variable that is not locally
 * bound within the function itself (own parameters or declarations inside the
 * function body).
 *
 * Workbox serialises urlPattern values via .toString(), stripping the closure
 * scope entirely.  Any outer variable referenced inside such a function causes
 * a ReferenceError at service-worker runtime — regardless of whether the
 * variable is declared at module scope or inside an enclosing callback scope
 * (e.g., the `const pat = …` inside an `.map()` callback).
 *
 * ── Approach ─────────────────────────────────────────────────────────────────
 *
 * For each urlPattern function expression (arrow or regular):
 *   1. Collect locally-bound identifiers: parameter names + every const/let/var
 *      declaration directly inside the function body.
 *   2. Scan the function body for every identifier reference.
 *   3. Any identifier that is referenced but NOT locally bound and NOT a known
 *      JS keyword or built-in global is flagged as a potential free variable.
 *
 * This catches closures over ANY outer-scope binding — module-level constants,
 * enclosing-callback locals, destructured loop variables, etc. — without
 * requiring a full lexical-scope analysis of the surrounding file.
 *
 * ── Safe forms (skipped by this check) ───────────────────────────────────────
 *
 *   urlPattern: /regex/              — regex literal; Workbox handles natively
 *   urlPattern: new Function(...)()  — self-contained; no closure possible
 *
 * ── Flagged forms ─────────────────────────────────────────────────────────────
 *
 *   const pat = /foo/;
 *   urlPattern: ({ url }) => pat.test(url.pathname)          // module-scope
 *
 *   OFFLINE_READ_CACHES.map(({ routes }) => {
 *     const localPat = new RegExp(routes.join('|'));
 *     return { urlPattern: ({ url }) => localPat.test(url.pathname) }; // callback-scope
 *   });
 *
 * ── Suppression ───────────────────────────────────────────────────────────────
 *
 *   For the rare case where a free-variable reference is genuinely safe,
 *   annotate the urlPattern line with a trailing comment:
 *     // sw-closure-ok: <reason>
 *
 * Usage:
 *   node scripts/check-sw-urlpattern-closures.mjs    # exits 1 on any violation
 *
 * Wired into CI via: npm run test:sw-closures
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Allow overriding the target path for testing purposes.
const TARGET = process.env._SW_CHECK_TARGET || resolve(ROOT, 'scripts', 'build-sw.mjs');
const TARGET_REL = process.env._SW_CHECK_TARGET
  ? process.env._SW_CHECK_TARGET
  : 'scripts/build-sw.mjs';

const src = readFileSync(TARGET, 'utf8');
const lines = src.split('\n');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Return the 1-based line number for a character offset in src. */
function lineOf(charIdx) {
  return src.slice(0, charIdx).split('\n').length;
}

/**
 * Starting at `start` (pointing at the first character of a function
 * expression or arrow function in `text`), extract:
 *   - params:  Set of all word-tokens in the parameter list (over-captures
 *              destructuring keywords, which is harmless)
 *   - body:    raw source text of the function body
 *
 * Returns { params, body } or null when parsing fails.
 *
 * Handles all three arrow/function forms:
 *   function [name](params) { body }   — function expression
 *   (params) => body                   — parenthesised arrow
 *   param => body                      — single unparenthesised arrow
 */
function extractFunction(text, start) {
  let i = start;
  let paramsText;

  // Skip optional 'function' keyword + optional function name.
  if (text.slice(i).startsWith('function')) {
    i += 'function'.length;
    const nameM = text.slice(i).match(/^\s*\w*/);
    if (nameM) i += nameM[0].length;
    // Now expect '(' for the param list.
  } else {
    // Check for single unparenthesised arrow param: `ident =>`
    // (must appear before looking for '(' to avoid mis-parsing)
    const singleArrow = text.slice(i).match(/^([a-zA-Z_$][\w$]*)\s*=>/);
    if (singleArrow) {
      paramsText = singleArrow[1];
      i += singleArrow[0].length;
      // Skip whitespace after '=>'
      while (i < text.length && /[\t ]/.test(text[i])) i++;
      // Proceed directly to body extraction below.
      const params = new Set([paramsText]);
      return extractBody(text, i, params);
    }
    // Otherwise expect '(' for the param list (parenthesised arrow).
  }

  // Advance to the opening parenthesis of the parameter list.
  while (i < text.length && text[i] !== '(') i++;
  if (i >= text.length) return null;

  // Depth-track the parameter block.
  let depth = 0;
  const paramsStart = i;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) { i++; break; }
    }
    i++;
  }
  paramsText = text.slice(paramsStart, i);

  // Skip whitespace, then optional '=>'.
  while (i < text.length && /[\t ]/.test(text[i])) i++;
  if (text.slice(i, i + 2) === '=>') i += 2;
  while (i < text.length && /[\t ]/.test(text[i])) i++;

  // Collect all word tokens from paramsText as bound identifiers.
  const params = new Set();
  for (const m of paramsText.matchAll(/\b([a-zA-Z_$][\w$]*)\b/g)) {
    params.add(m[1]);
  }
  return extractBody(text, i, params);
}

/**
 * Extract the function body starting at position `i` in `text`, with the
 * already-collected `params` set.  Returns { params, body } or null.
 */
function extractBody(text, i, params) {
  let depth;
  let bodyText;

  if (text[i] === '{') {
    // Block body: depth-track braces, skip string literals.
    depth = 0;
    const bodyStart = i;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '{' || ch === '(' || ch === '[') {
        depth++;
      } else if (ch === '}' || ch === ')' || ch === ']') {
        depth--;
        if (depth === 0) { i++; break; }
      } else if (ch === '`' || ch === '"' || ch === "'") {
        const q = ch;
        i++;
        while (i < text.length && text[i] !== q) {
          if (text[i] === '\\') i++;
          i++;
        }
      }
      i++;
    }
    bodyText = text.slice(bodyStart, i);
  } else {
    // Concise arrow body: read until a depth-0 comma or closing bracket.
    depth = 0;
    const bodyStart = i;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '(' || ch === '{' || ch === '[') {
        depth++;
      } else if (ch === ')' || ch === '}' || ch === ']') {
        if (depth === 0) break;
        depth--;
      } else if (ch === ',') {
        if (depth === 0) break;
      } else if (ch === '`' || ch === '"' || ch === "'") {
        const q = ch;
        i++;
        while (i < text.length && text[i] !== q) {
          if (text[i] === '\\') i++;
          i++;
        }
      }
      i++;
    }
    bodyText = text.slice(bodyStart, i);
  }

  return { params, body: bodyText };
}

/**
 * Collect every identifier that is *locally declared* inside a function body:
 * const/let/var declarations and function declarations (including in nested
 * blocks).  Does NOT descend into nested function expressions (their own
 * locals are a separate scope and are correctly treated as non-local here).
 *
 * This is intentionally simple text-scanning — precise for the patterns
 * present in build-sw.mjs without requiring a full AST.
 */
function collectLocalDeclarations(body) {
  const locals = new Set();
  // Match:  const foo, const { a, b }, let x, var y
  // (multi-line destructuring not covered, but build-sw.mjs doesn't use that)
  for (const m of body.matchAll(/\b(?:const|let|var)\s+(?:\{([^}]+)\}|(\w+))/g)) {
    if (m[1]) {
      // Destructuring: extract just the local binding names.
      for (const part of m[1].split(',')) {
        const local = part.trim().split(/\s*:\s*/).pop().trim().replace(/\W.*/, '');
        if (local) locals.add(local);
      }
    } else if (m[2]) {
      locals.add(m[2]);
    }
  }
  // Named function declarations inside the body.
  for (const m of body.matchAll(/\bfunction\s+(\w+)\s*\(/g)) {
    locals.add(m[1]);
  }
  return locals;
}

// Well-known JS keywords and globals — always in scope inside a serialised SW
// function; never "closures" and never flagged.
const JS_KEYWORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for',
  'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null',
  'return', 'static', 'super', 'switch', 'this', 'throw', 'try', 'typeof',
  'undefined', 'var', 'void', 'while', 'with', 'yield', 'true', 'false',
  'async', 'await', 'of', 'from', 'as', 'get', 'set',
]);

const JS_GLOBALS = new Set([
  'Array', 'Boolean', 'Date', 'Error', 'Function', 'Infinity', 'JSON',
  'Map', 'Math', 'NaN', 'Number', 'Object', 'Promise', 'Proxy', 'Reflect',
  'RegExp', 'Set', 'String', 'Symbol', 'WeakMap', 'WeakSet', 'console',
  'globalThis', 'self', 'window', 'document', 'navigator', 'URL',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',
]);

/**
 * Return all non-keyword, non-global *standalone* identifier references in
 * the given source text.
 *
 * Two classes of false positives are excluded:
 *
 *   1. Property names — identifiers immediately preceded by a `.` in the
 *      source (e.g. `request.mode` → `mode` is a property, not a variable).
 *
 *   2. String contents — characters inside single-quoted, double-quoted, or
 *      backtick string literals are stripped before scanning so that e.g.
 *      `=== 'navigate'` does not flag `navigate` as a free variable.
 */
function getReferencedIdents(text) {
  // Strip string literals so their content is not scanned for identifiers.
  // Replace each string with whitespace of equal length to preserve offsets
  // for the subsequent property-access check.
  const stripped = text.replace(
    /('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/g,
    (m) => ' '.repeat(m.length),
  );

  const idents = new Set();
  for (const m of stripped.matchAll(/\b([a-zA-Z_$][\w$]*)\b/g)) {
    const id = m[1];
    if (JS_KEYWORDS.has(id) || JS_GLOBALS.has(id)) continue;
    // Skip property names: the character immediately before the match is '.'
    const charBefore = stripped[m.index - 1];
    if (charBefore === '.') continue;
    idents.add(id);
  }
  return idents;
}

// ── Step: scan every urlPattern entry ────────────────────────────────────────

const violations = [];

const urlPatternRe = /urlPattern\s*:/g;
let match;
while ((match = urlPatternRe.exec(src)) !== null) {
  const matchIdx = match.index;
  const lineNum = lineOf(matchIdx);
  const lineText = lines[lineNum - 1];

  // Suppression annotation on the same source line.
  if (lineText.includes('sw-closure-ok')) continue;

  // Locate the value after 'urlPattern:' (skip leading whitespace).
  const afterColonRaw = src.slice(matchIdx + match[0].length);
  const leadingWs = afterColonRaw.match(/^[\t ]*/)[0].length;
  const trimmed = afterColonRaw.slice(leadingWs);

  // ── Safe: regex literal ────────────────────────────────────────────────────
  if (trimmed.startsWith('/')) continue;

  // ── Safe: new Function(…)() — self-contained, no closure ──────────────────
  if (/^new\s+Function\s*\(/.test(trimmed)) continue;

  // ── Check: arrow function or function expression ───────────────────────────
  const isFunctionExpr = /^function\b/.test(trimmed);
  const isArrowFunc =
    trimmed.startsWith('(') ||        // ({ … }) => …
    /^\w+\s*=>/.test(trimmed);        // x => …

  if (!isFunctionExpr && !isArrowFunc) continue;

  const fnStart = matchIdx + match[0].length + leadingWs;
  const result = extractFunction(src, fnStart);
  if (!result) continue;

  const { params, body } = result;

  // Locally-bound identifiers = function params + declarations inside the body.
  const localDecls = collectLocalDeclarations(body);
  const locallyBound = new Set([...params, ...localDecls]);

  // Flag any identifier in the body that is not locally bound.
  const referencedIdents = getReferencedIdents(body);
  const freeVars = [];
  for (const ident of referencedIdents) {
    if (!locallyBound.has(ident)) freeVars.push(ident);
  }

  if (freeVars.length > 0) {
    violations.push({ line: lineNum, text: lineText.trimEnd(), freeVars });
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

console.log(`check-sw-urlpattern-closures: scanned ${TARGET_REL}\n`);

if (violations.length === 0) {
  console.log(
    '✓ No urlPattern closure violations found.\n' +
    '  All urlPattern functions are self-contained or use safe forms\n' +
    '  (regex literal / new Function).'
  );
  process.exit(0);
}

console.error(
  `✗ ${violations.length} urlPattern function(s) reference identifier(s) not locally bound:\n`
);
for (const v of violations) {
  console.error(`  ${TARGET_REL}:${v.line}`);
  console.error(`    ${v.text}`);
  console.error(`    Free variables: ${v.freeVars.join(', ')}\n`);
}
console.error(
  'Workbox serialises urlPattern via .toString(), stripping all closure\n' +
  'scope — any outer variable referenced inside the function will be a\n' +
  'ReferenceError at SW runtime.\n' +
  '\n' +
  'Fix: make the urlPattern function self-contained.\n' +
  '     Embed needed values as literals, or use:\n' +
  '       new Function(`return ({ url }) => /pattern/.test(url.pathname)`)()\n' +
  '     so no outer scope is required.\n' +
  '\n' +
  'Suppression: if a free-variable reference is genuinely safe, annotate\n' +
  '     the urlPattern line with `// sw-closure-ok: <reason>`.'
);
process.exit(1);
