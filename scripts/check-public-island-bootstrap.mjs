#!/usr/bin/env node
/**
 * check-public-island-bootstrap.mjs
 *
 * Guards the contract that every React mount id declared as public in
 * src/react/main.tsx is also excluded from the AppBootstrap auth-redirect
 * guard in src/react/contexts/AppBootstrapContext.tsx.
 *
 * Background
 * ----------
 * Two parallel Set literals control which islands receive which wrappers:
 *
 *   CONN_TOAST_EXCLUDED (main.tsx)
 *     Islands that must NOT receive the ConnectionToastProvider because they
 *     are public-facing and the session APIs return 401 for them.  Adding an
 *     island here effectively declares it as public.
 *
 *   BOOTSTRAP_EXCLUDED (AppBootstrapContext.tsx)
 *     Islands that must NOT receive the AppBootstrapProvider auth-redirect
 *     guard.  If a public island is missing from this set the bootstrap guard
 *     will fire immediately on load, redirect the unauthenticated visitor to
 *     /login, and silently break the page.
 *
 * The invariant: CONN_TOAST_EXCLUDED ⊆ BOOTSTRAP_EXCLUDED
 *
 * (BOOTSTRAP_EXCLUDED is intentionally a superset — it also includes islands
 * like `not-found-root` and `access-restricted-root` that are rendered after
 * auth failures and therefore must never themselves redirect.)
 *
 * What this catches
 * -----------------
 * A developer adds a new public island to the MOUNTS table, correctly adds its
 * id to CONN_TOAST_EXCLUDED, but forgets to add it to BOOTSTRAP_EXCLUDED.
 * Without this check the omission is invisible during development (dev servers
 * often have an active session) and only breaks in production for unauthenticated
 * visitors.
 *
 * Exit codes:
 *   0 — all ids in CONN_TOAST_EXCLUDED are present in BOOTSTRAP_EXCLUDED
 *   1 — one or more ids are missing from BOOTSTRAP_EXCLUDED, or the
 *       extraction pattern failed for either file
 *
 * Usage:
 *   node scripts/check-public-island-bootstrap.mjs
 *
 * Wired into CI via: npm run test:public-island-bootstrap
 */

import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Helper: extract string literals from a `new Set([…])` declaration
// ---------------------------------------------------------------------------

/**
 * Extracts the string values from a `const NAME = new Set([ 'a', 'b', … ]);`
 * declaration in the given source text.
 *
 * Returns the Set of string values, or null if the declaration cannot be found.
 *
 * @param {string} src
 * @param {string} varName
 * @returns {Set<string> | null}
 */
function extractSetLiteral(src, varName) {
  // Match the Set literal block: `const NAME = new Set([` … `]);`
  // We capture everything between the opening `[` and the matching `]`.
  const startPattern = new RegExp(
    `(?:const|let|var)\\s+${varName}\\s*=\\s*new\\s+Set\\s*\\(\\s*\\[`,
  );
  const startMatch = startPattern.exec(src);
  if (!startMatch) return null;

  // Walk forward from the opening `[` to find the matching `]`, respecting
  // nested brackets (arrays inside the set should not confuse us).
  let depth = 1;
  let i = startMatch.index + startMatch[0].length;
  const bodyStart = i;
  while (i < src.length && depth > 0) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') depth--;
    i++;
  }
  if (depth !== 0) return null; // unterminated — parse error

  const body = src.slice(bodyStart, i - 1); // contents between the outer [ ]

  // Extract every single- or double-quoted string literal from the body.
  const ids = new Set();
  const strPattern = /['"]([^'"]+)['"]/g;
  let m;
  while ((m = strPattern.exec(body)) !== null) {
    ids.add(m[1]);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// 1. Read source files
// ---------------------------------------------------------------------------

const mainTsxPath         = join(ROOT, 'src', 'react', 'main.tsx');
const bootstrapCtxPath    = join(ROOT, 'src', 'react', 'contexts', 'AppBootstrapContext.tsx');

const mainSrc      = readFileSync(mainTsxPath, 'utf8');
const bootstrapSrc = readFileSync(bootstrapCtxPath, 'utf8');

// ---------------------------------------------------------------------------
// 2. Extract the two sets
// ---------------------------------------------------------------------------

const connToastExcluded = extractSetLiteral(mainSrc, 'CONN_TOAST_EXCLUDED');
const bootstrapExcluded = extractSetLiteral(bootstrapSrc, 'BOOTSTRAP_EXCLUDED');

let failed = false;

if (!connToastExcluded) {
  process.stderr.write(
    '[check-public-island-bootstrap] ERROR: Could not extract CONN_TOAST_EXCLUDED ' +
    'from src/react/main.tsx — the declaration may have been renamed or reformatted. ' +
    'Update this script to match.\n',
  );
  failed = true;
}

if (!bootstrapExcluded) {
  process.stderr.write(
    '[check-public-island-bootstrap] ERROR: Could not extract BOOTSTRAP_EXCLUDED ' +
    'from src/react/contexts/AppBootstrapContext.tsx — the declaration may have been ' +
    'renamed or reformatted. Update this script to match.\n',
  );
  failed = true;
}

if (failed) process.exit(1);

console.log(
  `[check-public-island-bootstrap] CONN_TOAST_EXCLUDED has ${connToastExcluded.size} id(s); ` +
  `BOOTSTRAP_EXCLUDED has ${bootstrapExcluded.size} id(s).`,
);

// ---------------------------------------------------------------------------
// 3. Check the invariant: CONN_TOAST_EXCLUDED ⊆ BOOTSTRAP_EXCLUDED
// ---------------------------------------------------------------------------

/** @type {string[]} */
const missing = [];
for (const id of connToastExcluded) {
  if (!bootstrapExcluded.has(id)) {
    missing.push(id);
  }
}

if (missing.length === 0) {
  console.log(
    '[check-public-island-bootstrap] OK — every public island in CONN_TOAST_EXCLUDED ' +
    'is also excluded from the bootstrap auth-redirect guard.',
  );
  process.exit(0);
}

process.stderr.write('\n[check-public-island-bootstrap] MISSING BOOTSTRAP EXCLUSIONS:\n\n');
for (const id of missing) {
  process.stderr.write(`  "${id}" is in CONN_TOAST_EXCLUDED (main.tsx) but NOT in BOOTSTRAP_EXCLUDED (AppBootstrapContext.tsx)\n`);
}
process.stderr.write(
  '\nEvery public island id added to CONN_TOAST_EXCLUDED in src/react/main.tsx\n' +
  'must also be added to BOOTSTRAP_EXCLUDED in\n' +
  'src/react/contexts/AppBootstrapContext.tsx.\n\n' +
  'Without this, AppBootstrapProvider will fire its auth-redirect guard for\n' +
  'unauthenticated visitors, immediately redirecting them to /login and\n' +
  'silently breaking the public-facing page.\n\n' +
  'Fix: add the missing id(s) above to the BOOTSTRAP_EXCLUDED Set in\n' +
  'src/react/contexts/AppBootstrapContext.tsx.\n',
);
process.exit(1);
