#!/usr/bin/env node
/**
 * scripts/check-lead-status-keys.mjs
 *
 * Static lint: verifies that `HARDCODED_LEAD_STATUS_KEYS` in server.js stays
 * in sync with every literal `assertLeadStatusKey('KEY')` call-site AND every
 * inline `hs_lead_status: 'KEY'` object-literal value in production source
 * files.
 *
 * Two checks are performed:
 *
 *   FORWARD — Every literal string passed to `assertLeadStatusKey()` OR used
 *   as an inline `hs_lead_status: 'KEY'` value in production code must have a
 *   matching entry in HARDCODED_LEAD_STATUS_KEYS.  Catches the case where a
 *   developer adds a new assertLeadStatusKey call or a new hs_lead_status
 *   object literal without updating the list.
 *
 *   REVERSE — Every key in HARDCODED_LEAD_STATUS_KEYS must appear as a string
 *   literal somewhere in production source code outside of the list definition
 *   itself.  Catches stale entries left behind after code that used a key is
 *   deleted.
 *
 *   NOTE ON REVERSE CHECK SCOPE: HARDCODED_LEAD_STATUS_KEYS tracks ALL
 *   hardcoded hs_lead_status values, not only those passed to
 *   assertLeadStatusKey().  Some keys (e.g. SURVEY_SCHEDULED, DESIGN_SCHEDULED)
 *   appear only as inline `hs_lead_status: 'KEY'` values in HubSpot mutation
 *   objects; others (e.g. NOT_SUITABLE, ROUGH_ESTIMATE) are passed
 *   dynamically via a variable rather than as a literal string argument.  A
 *   strict assertLeadStatusKey-only reverse check would therefore produce
 *   false positives on the current codebase.  The broader "appears as any
 *   string literal" check is intentional: it confirms each list entry still
 *   has at least one production-code reference, while remaining correct for
 *   the full scope HARDCODED_LEAD_STATUS_KEYS is designed to cover.
 *
 * Key name format: uppercase letters, digits, and underscores ([A-Z0-9_]+).
 * This matches every hs_lead_status value format used in the codebase.
 *
 * Production files: *.js and *.ts/*.tsx under project root, excluding:
 *   - test/          (test-only code)
 *   - scripts/       (tooling)
 *   - node_modules/
 *   - public/        (build artefacts)
 *   - artifacts/     (sandbox)
 *   - migrations/    (SQL-only files, no JS assertLeadStatusKey calls)
 *
 * Run via:  npm run test:lead-status-keys
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, extname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// ─── File collection ─────────────────────────────────────────────────────────

const EXCLUDED_DIRS = new Set([
  'test',
  'scripts',
  'node_modules',
  'public',
  'artifacts',
  'migrations',
  '.git',
  '.local',
  '.agents',
  'coverage',
  'test-results',
  'docs',
]);

const SOURCE_EXTS = new Set(['.js', '.ts', '.tsx', '.mjs', '.cjs']);

function collectSourceFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      results.push(...collectSourceFiles(full));
    } else if (SOURCE_EXTS.has(extname(entry))) {
      results.push(full);
    }
  }
  return results;
}

// ─── Extract HARDCODED_LEAD_STATUS_KEYS from server.js ───────────────────────

function extractListKeys(serverJsPath) {
  const src = readFileSync(serverJsPath, 'utf8');

  // Locate the array body between HARDCODED_LEAD_STATUS_KEYS = [ ... ]
  const startIdx = src.indexOf('const HARDCODED_LEAD_STATUS_KEYS = [');
  if (startIdx === -1) {
    throw new Error(
      'Could not find HARDCODED_LEAD_STATUS_KEYS in server.js. ' +
      'Has the array been renamed or moved?',
    );
  }
  const openBracket = src.indexOf('[', startIdx);
  // Walk forward to find the matching close bracket
  let depth = 0;
  let endIdx = -1;
  for (let i = openBracket; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') {
      depth--;
      if (depth === 0) { endIdx = i; break; }
    }
  }
  if (endIdx === -1) {
    throw new Error('Could not find the closing ] of HARDCODED_LEAD_STATUS_KEYS.');
  }

  const arrayBody = src.slice(openBracket, endIdx + 1);
  const keys = new Set();
  // Match `key: 'FOO_BAR'` entries (both single and double quotes).
  // Accept uppercase letters, digits, and underscores — the full set of
  // characters valid in an hs_lead_status key value.
  for (const m of arrayBody.matchAll(/key:\s*['"]([A-Z0-9_]+)['"]/g)) {
    keys.add(m[1]);
  }
  return { keys, arrayBody };
}

// ─── Find literal assertLeadStatusKey('KEY') calls ───────────────────────────

function findLiteralCallKeys(files) {
  const found = new Map(); // key → [file, ...]
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    // Only capture calls where the argument is a string literal — not a
    // variable.  Dynamic calls like assertLeadStatusKey(varName) are not
    // captured because the key cannot be determined statically.
    for (const m of src.matchAll(/assertLeadStatusKey\(\s*['"]([A-Z0-9_]+)['"]\s*\)/g)) {
      const key = m[1];
      if (!found.has(key)) found.set(key, []);
      found.get(key).push(relative(ROOT, file));
    }
  }
  return found;
}

// ─── Find inline hs_lead_status: 'KEY' object-literal values ─────────────────
// Catches hardcoded keys set directly in HubSpot mutation objects, e.g.:
//   { hs_lead_status: 'SURVEY_SCHEDULED' }
//   { hs_lead_status: "SURVEY_SCHEDULED" }
//   { hs_lead_status: `SURVEY_SCHEDULED` }        ← template literal, no interpolation
//   { hs_lead_status: 'KEY' as const }             ← TypeScript `as const` assertion
//   { hs_lead_status: 'KEY' satisfies LeadStatus } ← TypeScript `satisfies` operator
// These are valid hardcoded uses that HARDCODED_LEAD_STATUS_KEYS must track,
// but they are invisible to the assertLeadStatusKey-only forward check.
//
// Dynamic values — String(variable), a plain identifier, or a template literal
// with interpolation (e.g. `${someVar}`) — contain characters outside
// [A-Z0-9_]+ and therefore do not match, which is the correct behaviour.
//
// TypeScript-specific patterns already covered without extra regex work:
//   • `hs_lead_status?: string` type annotations — the `?` before `:` means the
//     value side is a type keyword, not a string literal; no [A-Z0-9_]+ match.
//   • `const body: Record<string,string> = { hs_lead_status: String(x) }` —
//     `String(x)` contains `(` which is outside [A-Z0-9_]+; no match.
//   • Spread: `...(flag ? { hs_lead_status: variable } : {})` — the value is
//     an identifier, not a quoted string; no match.
// The only additional pattern that required explicit support was the unquoted
// template literal (backtick string without interpolation), handled by
// including `` ` `` in the opening/closing delimiter character class below.

function findInlineObjectKeys(files) {
  const found = new Map(); // key → [file, ...]
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    // Match `hs_lead_status: 'KEY'`, `hs_lead_status: "KEY"`, or
    // `hs_lead_status: \`KEY\`` where KEY is an uppercase hs_lead_status value.
    // Lowercase or mixed-case values (property names, filter strings) won't
    // match [A-Z0-9_]+.  Template literals with interpolation (${...}) also
    // won't match because `$` and `{` are outside [A-Z0-9_]+.
    for (const m of src.matchAll(/hs_lead_status:\s*[`'"]([A-Z0-9_]+)[`'"]/g)) {
      const key = m[1];
      if (!found.has(key)) found.set(key, []);
      found.get(key).push(relative(ROOT, file));
    }
  }
  return found;
}

// ─── Build an index of TypeScript enum / const-object string values ──────────
// Scans all source files for:
//   enum LeadStatus { SURVEY_SCHEDULED = 'SURVEY_SCHEDULED', … }
//   const LEAD_STATUS = { SURVEY_SCHEDULED: 'SURVEY_SCHEDULED', … }
// Returns a Map from "EnumOrConstName.MEMBER" → 'STRING_VALUE'.

function buildEnumConstIndex(files) {
  const index = new Map();

  for (const file of files) {
    const src = readFileSync(file, 'utf8');

    // TypeScript string enum: enum Name { MEMBER = 'VALUE', … }
    // The [\s\S]*? is non-greedy; this relies on the closing } being the first
    // unescaped } after the opening {.  That works for all enum bodies seen in
    // this codebase; deeply nested generic types in const bodies may need the
    // extended const-object pattern below instead.
    for (const em of src.matchAll(/\benum\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\{([\s\S]*?)\}/g)) {
      const name = em[1];
      const body = em[2];
      for (const mm of body.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*[`'"]([A-Z0-9_]+)[`'"]/g)) {
        index.set(`${name}.${mm[1]}`, mm[2]);
      }
    }

    // const object (possibly typed): const Name[: Type] = { MEMBER: 'VALUE', … }
    for (const cm of src.matchAll(/\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*:[^=]+)?\s*=\s*\{([\s\S]*?)\}/g)) {
      const name = cm[1];
      const body = cm[2];
      for (const mm of body.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*[`'"]([A-Z0-9_]+)[`'"]/g)) {
        index.set(`${name}.${mm[1]}`, mm[2]);
      }
    }
  }

  return index;
}

// ─── Find dotted enum/const hs_lead_status references ────────────────────────
// Catches patterns like:
//   { hs_lead_status: LeadStatus.SURVEY_SCHEDULED }
//   { hs_lead_status: LEAD_STATUS.SURVEY_SCHEDULED }
// String literals (already handled by findInlineObjectKeys) start with a quote
// character and therefore cannot match the Identifier.Identifier pattern below.
// Plain type-annotation forms (e.g. `hs_lead_status?: LeadStatus`) also do not
// match because they use `?:` rather than `:`.

function findDottedEnumUsages(files) {
  // Matches: hs_lead_status: SomeName.MEMBER_NAME
  // Requires a dot so bare identifiers (dynamic variables) are left alone.
  const re = /hs_lead_status:\s*([A-Za-z_$][A-Za-z0-9_$]*\.[A-Za-z_$][A-Za-z0-9_$]*)/g;
  const usages = []; // { ref, file }
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(re)) {
      usages.push({ ref: m[1], file: relative(ROOT, file) });
    }
  }
  return usages;
}

// ─── Find any string-literal occurrence of a key in production files ─────────
// Used for the REVERSE check: does the key appear in code outside the list?

function findKeyOccurrences(key, files, excludePattern) {
  const re = new RegExp(`['"]${key}['"]`);
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const line of src.split('\n')) {
      if (excludePattern && excludePattern.test(line)) continue;
      if (re.test(line)) return true;
    }
  }
  return false;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const serverJsPath = join(ROOT, 'server.js');
const { keys: listKeys } = extractListKeys(serverJsPath);

const allFiles = collectSourceFiles(ROOT);

const callSiteKeys = findLiteralCallKeys(allFiles);
const inlineObjectKeys = findInlineObjectKeys(allFiles);

// ── Enum / const resolution ───────────────────────────────────────────────────
// Build a lookup table of all TypeScript enum-member and const-object string
// values found across the source tree, then resolve every dotted
// `hs_lead_status: EnumName.MEMBER` reference to its underlying string value.

const enumConstIndex = buildEnumConstIndex(allFiles);
const dottedUsages = findDottedEnumUsages(allFiles);

const resolvedEnumKeys = new Map(); // resolved string value → [file, …]
const unresolvedEnumRefs = [];      // { ref, file } — could not resolve statically

for (const { ref, file } of dottedUsages) {
  const value = enumConstIndex.get(ref);
  if (value !== undefined) {
    if (!resolvedEnumKeys.has(value)) resolvedEnumKeys.set(value, []);
    if (!resolvedEnumKeys.get(value).includes(file)) {
      resolvedEnumKeys.get(value).push(file);
    }
  } else {
    unresolvedEnumRefs.push({ ref, file });
  }
}

// Merge all forward sources into a single map.
// Values are deduplicated file lists per key.
function mergeInto(target, source) {
  for (const [key, files] of source) {
    if (!target.has(key)) {
      target.set(key, [...files]);
    } else {
      target.set(key, [...new Set([...target.get(key), ...files])]);
    }
  }
}

const allForwardKeys = new Map(callSiteKeys);
mergeInto(allForwardKeys, inlineObjectKeys);
mergeInto(allForwardKeys, resolvedEnumKeys);

let failed = false;

// ── UNRESOLVED ENUM/CONST WARNINGS ───────────────────────────────────────────
// Emit a warning (not a hard failure) for every dotted hs_lead_status reference
// whose value could not be determined from the source index.  A human must
// verify that the referenced constant is either already in
// HARDCODED_LEAD_STATUS_KEYS or does not represent a hardcoded key.

if (unresolvedEnumRefs.length > 0) {
  console.warn(
    `⚠️   lead-status-keys: ${unresolvedEnumRefs.length} ` +
    `hs_lead_status reference${unresolvedEnumRefs.length === 1 ? '' : 's'} ` +
    `used a non-literal value that could not be resolved statically — ` +
    `verify manually that the underlying string is in HARDCODED_LEAD_STATUS_KEYS:\n`,
  );
  for (const { ref, file } of unresolvedEnumRefs) {
    console.warn(`   - ${ref}  (in ${file})`);
  }
  console.warn(
    '\nIf the value is already covered, no action is needed.  ' +
    'If it is a new key, add a matching { key, source } entry to ' +
    'HARDCODED_LEAD_STATUS_KEYS in server.js.\n',
  );
}

// ── FORWARD CHECK ─────────────────────────────────────────────────────────────
// Every literal assertLeadStatusKey('KEY') call, every inline
// `hs_lead_status: 'KEY'` object value, AND every resolved enum/const
// reference → must be in HARDCODED_LEAD_STATUS_KEYS.

const forwardMissing = [...allForwardKeys.keys()].filter((k) => !listKeys.has(k)).sort();

if (forwardMissing.length > 0) {
  failed = true;
  console.error(
    `❌  lead-status-keys: ${forwardMissing.length} ` +
    `${forwardMissing.length === 1 ? 'key' : 'keys'} used as a hardcoded hs_lead_status ` +
    `value but missing from HARDCODED_LEAD_STATUS_KEYS in server.js:\n`,
  );
  for (const key of forwardMissing) {
    const files = allForwardKeys.get(key).join(', ');
    console.error(`   - '${key}'  (in ${files})`);
  }
  console.error(
    '\nAdd a matching { key, source } entry to HARDCODED_LEAD_STATUS_KEYS ' +
    'in server.js for each missing key.\n',
  );
}

// ── REVERSE CHECK ─────────────────────────────────────────────────────────────
// Every key in HARDCODED_LEAD_STATUS_KEYS → must appear as a string literal
// somewhere in production code outside of the list definition itself.
//
// Intentionally uses a broad "any string literal" search rather than limiting
// to assertLeadStatusKey() arguments, because HARDCODED_LEAD_STATUS_KEYS
// covers all hardcoded hs_lead_status values (inline mutation objects,
// dynamic assertLeadStatusKey calls via variables, etc.) — not only literal
// assertLeadStatusKey() arguments.  See the module-level comment for details.
//
// Lines that are part of the list definition itself (`key: 'FOO'`) are
// excluded so the list does not self-satisfy the check.
const listEntryLinePattern = /key:\s*['"][A-Z0-9_]+['"]/;

const reverseMissing = [];
for (const key of [...listKeys].sort()) {
  const found = findKeyOccurrences(key, allFiles, listEntryLinePattern);
  if (!found) reverseMissing.push(key);
}

if (reverseMissing.length > 0) {
  failed = true;
  console.error(
    `❌  lead-status-keys: ${reverseMissing.length} ` +
    `${reverseMissing.length === 1 ? 'key' : 'keys'} listed in ` +
    `HARDCODED_LEAD_STATUS_KEYS but not referenced as a string literal ` +
    `anywhere in production source code:\n`,
  );
  for (const key of reverseMissing) {
    console.error(`   - '${key}'`);
  }
  console.error(
    '\nRemove stale entries from HARDCODED_LEAD_STATUS_KEYS in server.js, ' +
    'or add back the missing code that references each key.\n',
  );
}

if (!failed) {
  const listCount = listKeys.size;
  const callCount = callSiteKeys.size;
  const inlineCount = inlineObjectKeys.size;
  const enumCount = resolvedEnumKeys.size;
  const unresolvedCount = unresolvedEnumRefs.length;
  const enumSuffix = enumCount > 0
    ? ` + ${enumCount} resolved enum/const ${enumCount === 1 ? 'key' : 'keys'}`
    : '';
  const unresolvedSuffix = unresolvedCount > 0
    ? `; ${unresolvedCount} unresolved reference${unresolvedCount === 1 ? '' : 's'} warned above`
    : '';
  console.log(
    `✅  lead-status-keys: ${listCount} ${listCount === 1 ? 'key' : 'keys'} in ` +
    `HARDCODED_LEAD_STATUS_KEYS; ` +
    `${callCount} literal assertLeadStatusKey() ` +
    `${callCount === 1 ? 'call-site key' : 'call-site keys'} + ` +
    `${inlineCount} inline hs_lead_status object ` +
    `${inlineCount === 1 ? 'key' : 'keys'}` +
    `${enumSuffix} all present in list; ` +
    `all list keys referenced in production code${unresolvedSuffix}`,
  );
  process.exit(0);
}

process.exit(1);
