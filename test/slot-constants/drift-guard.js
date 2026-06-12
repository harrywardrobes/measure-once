'use strict';
/**
 * test/slot-constants/drift-guard.js
 *
 * Drift-guard: asserts that the CJS twin (shared/slotConstants.cjs) and the
 * canonical TypeScript/ESM source (src/react/pages/admin/adminConstants.ts)
 * declare the same "No lead status" global-slot sentinel constants with
 * identical values.
 *
 * The two files are kept in sync by convention only — a typo or future edit
 * to either could silently re-introduce a mismatch between the React layer and
 * the API.  This guard imports the CJS module at runtime and parses the TS
 * source text, then compares every exported constant name and value.
 *
 * Run standalone:  node test/slot-constants/drift-guard.js
 * Included in CI:  npm run test:slot-constants-drift
 *
 * Checks:
 *   1.  Same set of exported constant names in both files
 *   2.  Each constant has an identical resolved value
 */

const fs   = require('fs');
const path = require('path');

const cjs = require('../../shared/slotConstants.cjs');

let failures = 0;

function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function pass(msg) { console.log(`  pass  ${msg}`); }
function assert(condition, msg) { if (condition) pass(msg); else fail(msg); }

console.log('\n── slot-constants drift guard ─────────────────────────────────────\n');

const tsPath = path.resolve(__dirname, '../../src/react/pages/admin/adminConstants.ts');
let tsContent;
try {
  tsContent = fs.readFileSync(tsPath, 'utf8');
} catch (e) {
  fail(`could not read ${tsPath}: ${e.message}`);
  tsContent = null;
}

if (tsContent) {
  /**
   * Parse `export const NAME = '<value>'` declarations from the TS source.
   * Supports plain string literals and the template-literal form used for the
   * combined slot key (`${GLOBAL_NULL_STAGE_KEY}|${GLOBAL_NULL_STATUS_KEY}`),
   * which is resolved against the already-parsed string constants so we compare
   * fully-resolved values, not raw source text.
   */
  const stringValues = {};   // name → resolved string value
  const templateRefs = {};   // name → raw template body

  // export const NAME = 'value'   (optionally with `as const`)
  const stringRe = /export const (\w+)\s*=\s*'([^']*)'/g;
  let m;
  while ((m = stringRe.exec(tsContent)) !== null) {
    stringValues[m[1]] = m[2];
  }

  // export const NAME = `...`     (template literal, captured raw)
  const templateRe = /export const (\w+)\s*=\s*`([^`]*)`/g;
  while ((m = templateRe.exec(tsContent)) !== null) {
    templateRefs[m[1]] = m[2];
  }

  // Resolve template literals against the parsed string constants.
  const resolveTemplate = (body) =>
    body.replace(/\$\{(\w+)\}/g, (_full, ref) =>
      Object.prototype.hasOwnProperty.call(stringValues, ref) ? stringValues[ref] : `\${${ref}}`,
    );

  const tsValues = { ...stringValues };
  for (const [name, body] of Object.entries(templateRefs)) {
    tsValues[name] = resolveTemplate(body);
  }

  // ── 1. Same set of exported constant names ───────────────────────────────────
  const cjsNames = Object.keys(cjs).sort();
  const tsNames  = Object.keys(tsValues).sort();
  assert(
    cjsNames.join(',') === tsNames.join(','),
    `same exported constant names (CJS: [${cjsNames.join(', ')}], TS: [${tsNames.join(', ')}])`,
  );

  // ── 2. Each constant has an identical resolved value ─────────────────────────
  const allNames = [...new Set([...cjsNames, ...tsNames])].sort();
  for (const name of allNames) {
    const cjsVal = cjs[name];
    const tsVal  = tsValues[name];
    assert(
      cjsVal === tsVal,
      `${name}: CJS (${JSON.stringify(cjsVal)}) === TS (${JSON.stringify(tsVal)})`,
    );
  }
}

console.log('');
if (failures > 0) {
  console.error(`❌  slot-constants drift guard: ${failures} failure(s)`);
  process.exit(1);
}
console.log('✅  slot-constants drift guard: CJS twin and TS source are in sync');
process.exit(0);
