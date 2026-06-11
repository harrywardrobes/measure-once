#!/usr/bin/env node
/**
 * scripts/check-email-template-vars.mjs
 *
 * Static lint: every entry in TEMPLATE_DEFS in `email-templates.js` must:
 *   1. Have a `variableDescriptions` key.
 *   2. Have a description for every variable listed in `variables`.
 *   3. Every {{placeholder}} used in subject / body_text / body_html must be
 *      declared in `variables` or `variableDescriptions` — catching the reverse
 *      case where a placeholder is added to the body text but the variables
 *      list is never updated.
 *
 * This prevents a new template from being added without tooltip guidance for
 * admins who edit it via the email templates admin panel, and ensures no
 * placeholder goes undeclared (which would leave it unfilled at send time).
 *
 * How it works
 * ─────────────
 * The file is parsed statically (not require()'d) to avoid the side-effecting
 * `pg` pool and logger instantiation at the module top level.  The parser:
 *   1. Locates the TEMPLATE_DEFS = { … }; block.
 *   2. Splits it into per-template sections at top-level `  key: {` boundaries.
 *   3. From each section extracts the `variables` array items and the keys
 *      present in `variableDescriptions`.
 *   4. Scans the full section text for {{word}} placeholders and cross-checks
 *      them against the declared variables / variableDescriptions.
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
 * Extract every {{word}} placeholder that appears anywhere in the section text.
 * Returns a Set of identifier strings.  Used to detect placeholders that are
 * used in subject / body_text / body_html but never declared in `variables`.
 *
 * The search is applied to the raw source text of the template section, so it
 * naturally covers subject, body_text, and body_html string literals.  The
 * variableDescriptions prose values do not contain {{…}} patterns (they
 * describe variables in plain English), so this produces no false positives.
 */
function extractBodyPlaceholders(text) {
  const placeholders = new Set();
  const re = /\{\{(\w+)\}\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    placeholders.add(m[1]);
  }
  return placeholders;
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

  const varSet  = new Set(variables);
  const descSet = new Set(descKeys);

  // Check 1 (existing): every declared variable has a description.
  for (const v of variables) {
    if (!descSet.has(v)) {
      violations.push({
        template: key,
        type: 'missing_description',
        message: `Template "${key}": variable \`${v}\` has no entry in \`variableDescriptions\`.`,
      });
    }
  }

  // Check 2 (new): every {{placeholder}} used in the template body / subject
  // must be declared in `variables` or `variableDescriptions`.  Catches the
  // reverse case — a placeholder added to body_text/body_html/subject but
  // never registered in the variables list, which would leave it unfilled.
  const bodyPlaceholders = extractBodyPlaceholders(text);
  for (const p of bodyPlaceholders) {
    if (!varSet.has(p) && !descSet.has(p)) {
      violations.push({
        template: key,
        type: 'undeclared_placeholder',
        message: `Template "${key}": \`{{${p}}}\` is used in the template body/subject but is not declared in \`variables\` or \`variableDescriptions\`.`,
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

const hasUndeclared = violations.some(v => v.type === 'undeclared_placeholder');
const hasMissing    = violations.some(v => v.type !== 'undeclared_placeholder');

if (hasMissing) {
  console.error(
    '\nFix (missing description): add (or update) `variableDescriptions` in the\n' +
    '  affected template(s) in email-templates.js so every entry in `variables`\n' +
    '  has a matching key with a human-readable description.  Example:\n\n' +
    '    variableDescriptions: {\n' +
    "      myVar: 'What this variable contains and when it is present.',\n" +
    '    },'
  );
}
if (hasUndeclared) {
  console.error(
    '\nFix (undeclared placeholder): add the variable to the `variables` array\n' +
    '  AND to `variableDescriptions` in the affected template(s) in\n' +
    '  email-templates.js.  Example:\n\n' +
    "    variables: ['existingVar', 'myNewVar'],\n" +
    '    variableDescriptions: {\n' +
    "      existingVar: 'Description of the existing variable.',\n" +
    "      myNewVar:    'What this new variable contains and when it is present.',\n" +
    '    },'
  );
}
process.exit(1);
