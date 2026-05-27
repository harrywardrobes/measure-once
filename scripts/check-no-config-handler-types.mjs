#!/usr/bin/env node
/**
 * check-no-config-handler-types.mjs
 *
 * `NO_CONFIG_HANDLER_TYPES` in ActionHandlersPage.tsx is the single source of
 * truth for which handler types show the "no additional configuration" placeholder.
 * If a type in that set also appears as an explicit `case` label in the stories
 * file's `configBlockForType` switch, or as an explicit `handlerType === '…'`
 * comparison in ActionHandlersPage.tsx, that is a contradiction — the type would
 * both claim to have no config and be given a dedicated config block.
 *
 * This script catches those contradictions statically so CI fails before a human
 * notices the inconsistency at runtime.
 *
 * Checks performed
 * ─────────────────
 * 1. Parse the `NO_CONFIG_HANDLER_TYPES` entries from ActionHandlersPage.tsx.
 * 2. Assert none of those types appear as `case 'type':` labels in the
 *    `configBlockForType` switch in ActionHandlerConfigBlocks.stories.tsx.
 * 3. Assert none of those types appear as `handlerType === 'type'` comparisons
 *    anywhere in ActionHandlersPage.tsx (the render-block boolean flags and the
 *    buildPayload if/else chain use this pattern for each explicitly-handled type).
 *
 * Exit codes:
 *   0 — no violations found
 *   1 — one or more contradictions detected
 *
 * Usage:
 *   node scripts/check-no-config-handler-types.mjs
 *
 * Wired into CI via: npm run test:no-config-handler-types
 */

import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');

const ACTION_HANDLERS_PAGE = join(
  ROOT,
  'src/react/pages/admin/ActionHandlersPage.tsx',
);
const STORIES_FILE = join(
  ROOT,
  'src/react/components/ActionHandlerConfigBlocks.stories.tsx',
);

// ── Step 1: extract the NO_CONFIG_HANDLER_TYPES entries ───────────────────────

const pageSource = readFileSync(ACTION_HANDLERS_PAGE, 'utf8');

/**
 * Locate the `NO_CONFIG_HANDLER_TYPES` Set literal and pull out the quoted
 * string entries inside it.
 *
 * Matches patterns like:
 *   new Set([
 *     'add_design_visit_to_calendar',
 *     'summarise_phone_call',
 *   ])
 */
const SET_BLOCK_RE =
  /NO_CONFIG_HANDLER_TYPES[^=]*=\s*new\s+Set\s*\(\s*\[([^\]]*)\]\s*\)/s;

const blockMatch = pageSource.match(SET_BLOCK_RE);
if (!blockMatch) {
  process.stderr.write(
    '[check-no-config-handler-types] ERROR: Could not locate ' +
    'NO_CONFIG_HANDLER_TYPES in ActionHandlersPage.tsx.\n' +
    'Has the constant been renamed or moved?\n',
  );
  process.exit(1);
}

const QUOTED_RE = /['"]([^'"]+)['"]/g;
/** @type {string[]} */
const noConfigTypes = [];
let m;
while ((m = QUOTED_RE.exec(blockMatch[1])) !== null) {
  noConfigTypes.push(m[1]);
}

if (noConfigTypes.length === 0) {
  process.stderr.write(
    '[check-no-config-handler-types] ERROR: NO_CONFIG_HANDLER_TYPES appears ' +
    'to be empty or could not be parsed.\n',
  );
  process.exit(1);
}

console.log(
  `[check-no-config-handler-types] Found ${noConfigTypes.length} NO_CONFIG ` +
  `type(s): ${noConfigTypes.map(t => `'${t}'`).join(', ')}.`,
);

// ── Step 2: check stories file for explicit case labels ───────────────────────

const storiesSource = readFileSync(STORIES_FILE, 'utf8');

/** @type {Array<{type: string, line: number, text: string}>} */
const storiesViolations = [];

const storiesLines = storiesSource.split('\n');
for (let i = 0; i < storiesLines.length; i++) {
  const raw = storiesLines[i];
  for (const type of noConfigTypes) {
    // Match `case 'type':` or `case "type":` (with optional whitespace)
    if (new RegExp(`\\bcase\\s+['"]${type}['"]\\s*:`).test(raw)) {
      storiesViolations.push({ type, line: i + 1, text: raw.trimStart() });
    }
  }
}

// ── Step 3: check ActionHandlersPage.tsx for explicit handlerType comparisons ──

/** @type {Array<{type: string, line: number, text: string}>} */
const pageViolations = [];

const pageLines = pageSource.split('\n');
for (let i = 0; i < pageLines.length; i++) {
  const raw = pageLines[i];
  for (const type of noConfigTypes) {
    // Match `handlerType === 'type'` or `handlerType === "type"` (and !== variants)
    // but skip the NO_CONFIG_HANDLER_TYPES Set definition itself and .has() calls.
    if (/NO_CONFIG_HANDLER_TYPES/.test(raw)) continue;

    if (new RegExp(`handlerType\\s*[!=]==\\s*['"]${type}['"]`).test(raw)) {
      pageViolations.push({ type, line: i + 1, text: raw.trimStart() });
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

const total = storiesViolations.length + pageViolations.length;

if (total === 0) {
  console.log(
    '[check-no-config-handler-types] OK — no NO_CONFIG types appear as ' +
    'explicit case labels or handlerType comparisons.',
  );
  process.exit(0);
}

process.stderr.write(
  `\n[check-no-config-handler-types] VIOLATIONS (${total}):\n\n`,
);

if (storiesViolations.length > 0) {
  process.stderr.write(
    `  In ${STORIES_FILE.replace(ROOT + '/', '')} ` +
    `(configBlockForType switch):\n`,
  );
  for (const { type, line, text } of storiesViolations) {
    process.stderr.write(
      `    Line ${line}: '${type}' is in NO_CONFIG_HANDLER_TYPES but has an ` +
      `explicit case label:\n      ${text}\n`,
    );
  }
  process.stderr.write('\n');
}

if (pageViolations.length > 0) {
  process.stderr.write(
    `  In ${ACTION_HANDLERS_PAGE.replace(ROOT + '/', '')} ` +
    `(HandlerEditorModal render-block / buildPayload):\n`,
  );
  for (const { type, line, text } of pageViolations) {
    process.stderr.write(
      `    Line ${line}: '${type}' is in NO_CONFIG_HANDLER_TYPES but appears ` +
      `as an explicit handlerType comparison:\n      ${text}\n`,
    );
  }
  process.stderr.write('\n');
}

process.stderr.write(
  'A type in NO_CONFIG_HANDLER_TYPES must NOT have a dedicated config block.\n' +
  'Either remove it from NO_CONFIG_HANDLER_TYPES (if it now needs config)\n' +
  'or remove its explicit case label / handlerType comparison (if it truly\n' +
  'has no config and should fall through to the placeholder).\n\n',
);
process.exit(1);
