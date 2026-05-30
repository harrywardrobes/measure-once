#!/usr/bin/env node
/**
 * scripts/check-tokens-css.mjs
 *
 * Static lint: reads public/tokens.css and fails if any --status-* custom
 * property name contains an uppercase letter.
 *
 * CSS custom-property names are case-sensitive.  The token generator converts
 * STATUS_COLORS keys from camelCase to kebab-case via camelToKebab(), but a
 * future key added without considering casing (e.g. `warningLight`) would
 * silently produce `--status-warningLight-bg` and break any var() reference
 * that expects the all-lowercase form.  This check catches that class of
 * regression before it ships.
 *
 * Only --status-* properties are checked because those are the ones derived
 * from a developer-authored camelCase key space (STATUS_COLORS in theme.ts).
 * Other token families (stage, brand, neutral, radius, typo) either use
 * numeric keys, fixed string keys, or already go through camelToKebab().
 *
 * Run via:  npm run test:tokens-css
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT        = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKENS_PATH = resolve(ROOT, 'public/tokens.css');

let css;
try {
  css = readFileSync(TOKENS_PATH, 'utf8');
} catch (err) {
  console.error(`❌  check-tokens-css: cannot read ${TOKENS_PATH}`);
  console.error(`   ${err.message}`);
  console.error('\n   Run `npm run build:react` to generate the file first.\n');
  process.exit(1);
}

const violations = [];

for (const line of css.split('\n')) {
  const m = line.match(/--status-([^\s:;]+)/);
  if (!m) continue;
  const propName = `--status-${m[1]}`;
  if (/[A-Z]/.test(propName)) {
    violations.push(propName.trim());
  }
}

if (violations.length === 0) {
  console.log('✅  check-tokens-css: no camelCase characters found in --status-* tokens');
  process.exit(0);
}

console.error(
  `❌  check-tokens-css: ${violations.length} --status-* ` +
  `${violations.length === 1 ? 'token contains' : 'tokens contain'} uppercase letters:\n`,
);
for (const v of violations) {
  console.error(`   ${v}`);
}
console.error(
  '\nCSS custom-property names are case-sensitive.  Make sure all STATUS_COLORS\n' +
  'keys in src/react/theme.ts use camelCase that converts cleanly to lowercase\n' +
  'kebab-case (e.g. "warningLight" → "warning-light"), then re-run\n' +
  '`npm run build:react` and commit the updated public/tokens.css.\n',
);
process.exit(1);
