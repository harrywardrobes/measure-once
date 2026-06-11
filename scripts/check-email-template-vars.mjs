#!/usr/bin/env node
/**
 * scripts/check-email-template-vars.mjs
 *
 * Static lint: every entry in TEMPLATE_DEFS in `email-templates.js` must:
 *   1. Have a `variableDescriptions` key.
 *   2. Have a description for every variable listed in `variables`.
 *
 * This prevents a new template from being added without tooltip guidance for
 * admins who edit it via the email templates admin panel.
 *
 * How it works
 * ─────────────
 * The file is parsed statically (not require()'d) to avoid the side-effecting
 * `pg` pool and logger instantiation at the module top level.  The parser:
 *   1. Locates the TEMPLATE_DEFS = { … }; block.
 *   2. Splits it into per-template sections at top-level `  key: {` boundaries.
 *   3. From each section extracts the `variables` array items and the keys
 *      present in `variableDescriptions`.
 *
 * Exit codes:
 *   0 — all templates have complete variableDescriptions
 *   1 — one or more templates are missing descriptions
 *
 * Usage:
 *   node scripts/check-email-template-vars.mjs
 *
 * Wired into CI via: npm run test:template-vars
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EMAIL_TEMPLATES = resolve(ROOT, 'email-templates.js');

// ── Read source ───────────────────────────────────────────────────────────────

const src = readFileSync(EMAIL_TEMPLATES, 'utf8');

// ── Extract the TEMPLATE_DEFS block ──────────────────────────────────────────
//
// The block starts after `const TEMPLATE_DEFS = {` and ends at the first `};`
// that appears at column 0 (the closing brace of the top-level object).

const defsStart = src.indexOf('const TEMPLATE_DEFS = {');
if (defsStart === -1) {
  console.error('check-email-template-vars: could not locate TEMPLATE_DEFS in email-templates.js');
  process.exit(1);
}

// Find the closing `};` — it appears on its own line at column 0.
const afterOpen = src.indexOf('\n', defsStart) + 1;
const closingRe = /^};/m;
const closingMatch = closingRe.exec(src.slice(afterOpen));
if (!closingMatch) {
  console.error('check-email-template-vars: could not find closing `};` of TEMPLATE_DEFS');
  process.exit(1);
}

const defsBlock = src.slice(afterOpen, afterOpen + closingMatch.index);

// ── Split into per-template sections ─────────────────────────────────────────
//
// Each template starts at a line of the form `  <identifier>: {` (exactly two
// leading spaces, a JS identifier, a colon, a space, and an opening brace).

const TOP_KEY_RE = /^  ([a-zA-Z_][a-zA-Z0-9_]*): \{/gm;

const sections = [];
let m;
const matches = [];

while ((m = TOP_KEY_RE.exec(defsBlock)) !== null) {
  matches.push({ key: m[1], index: m.index });
}

for (let i = 0; i < matches.length; i++) {
  const start  = matches[i].index;
  const end    = i + 1 < matches.length ? matches[i + 1].index : defsBlock.length;
  sections.push({ key: matches[i].key, text: defsBlock.slice(start, end) });
}

if (sections.length === 0) {
  console.error('check-email-template-vars: no templates found in TEMPLATE_DEFS');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract items from a `variables: ['a', 'b', …]` or multi-line array in the
 * given block of text.  Returns an empty array if the key is absent or the
 * array is empty.
 */
function extractVariables(text) {
  // Match from `variables: [` to the closing `]`
  const arrayRe = /variables:\s*\[([\s\S]*?)\]/;
  const arrMatch = arrayRe.exec(text);
  if (!arrMatch) return [];
  const inner = arrMatch[1];
  const items = [];
  const itemRe = /['"]([^'"]+)['"]/g;
  let im;
  while ((im = itemRe.exec(inner)) !== null) {
    items.push(im[1]);
  }
  return items;
}

/**
 * Extract the keys present in `variableDescriptions: { … }` in the given
 * block of text.  Returns null if the key does not exist at all, or an empty
 * array if the block is present but empty.
 */
function extractVariableDescriptionKeys(text) {
  // Check that the key exists at all
  if (!text.includes('variableDescriptions:')) return null;

  // Find the `variableDescriptions: {` opening and collect identifier keys
  const blockRe = /variableDescriptions:\s*\{([\s\S]*?)\n\s*\},?/;
  const blockMatch = blockRe.exec(text);
  if (!blockMatch) {
    // Present but we couldn't parse the block — return an empty set to trigger
    // the "missing description" error for all variables rather than silently
    // passing.
    return [];
  }

  const inner = blockMatch[1];
  const keys  = [];
  // Keys look like: `  identifier:` or `  identifier :`
  const keyRe = /^\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:/gm;
  let km;
  while ((km = keyRe.exec(inner)) !== null) {
    keys.push(km[1]);
  }
  return keys;
}

// ── Validate ──────────────────────────────────────────────────────────────────

const violations = [];

for (const { key, text } of sections) {
  const variables    = extractVariables(text);
  const descKeys     = extractVariableDescriptionKeys(text);

  if (descKeys === null) {
    violations.push({
      template: key,
      type: 'missing_variableDescriptions',
      message: `Template "${key}" has no \`variableDescriptions\` key.`,
    });
    continue;
  }

  const descSet = new Set(descKeys);
  for (const v of variables) {
    if (!descSet.has(v)) {
      violations.push({
        template: key,
        type: 'missing_description',
        message: `Template "${key}": variable \`${v}\` has no entry in \`variableDescriptions\`.`,
      });
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

console.log(
  `check-email-template-vars: checked ${sections.length} template(s) in email-templates.js\n`
);

if (violations.length === 0) {
  console.log(
    `✓ All ${sections.length} template(s) have complete variableDescriptions.\n` +
    '  Every variable listed in `variables` has a matching description entry.'
  );
  process.exit(0);
}

console.error(`✗ ${violations.length} violation(s) found:\n`);
for (const v of violations) {
  console.error(`  ${v.message}`);
}
console.error(
  '\nFix: add (or update) `variableDescriptions` in the affected template(s) in\n' +
  '     email-templates.js so every entry in `variables` has a matching key with\n' +
  '     a human-readable description.  Example:\n\n' +
  '       variableDescriptions: {\n' +
  "         myVar: 'What this variable contains and when it is present.',\n" +
  '       },'
);
process.exit(1);
