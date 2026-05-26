#!/usr/bin/env node
/**
 * check-auth-css-vars.mjs
 *
 * Verifies that every CSS custom property referenced via var(--…) in
 * public/auth.css is defined in public/tokens.css.
 *
 * This keeps the auth pages in sync with the design-token source of truth:
 * if a token is renamed or removed from tokens.css the build will fail here
 * instead of silently rendering a broken page.
 *
 * Usage:
 *   node scripts/check-auth-css-vars.mjs    # exits 1 on any missing token
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const AUTH_CSS_PATH   = resolve(ROOT, 'public/auth.css');
const TOKENS_CSS_PATH = resolve(ROOT, 'public/tokens.css');

function parseCssVarDefinitions(css) {
  const defined = new Set();
  const re = /--([\w-]+)\s*:/g;
  let m;
  while ((m = re.exec(css)) !== null) defined.add(m[1]);
  return defined;
}

function parseCssVarReferences(css) {
  const refs = new Set();
  const re = /var\(--([\w-]+)(?:\s*,\s*[^)]+)?\)/g;
  let m;
  while ((m = re.exec(css)) !== null) refs.add(m[1]);
  return refs;
}

const authCss   = readFileSync(AUTH_CSS_PATH,   'utf8');
const tokensCss = readFileSync(TOKENS_CSS_PATH, 'utf8');

const defined = parseCssVarDefinitions(tokensCss);
const refs    = parseCssVarReferences(authCss);

console.log('check-auth-css-vars: public/auth.css → public/tokens.css\n');

const missing = [...refs].filter(name => !defined.has(name)).sort();

if (missing.length === 0) {
  console.log(`✓ All ${refs.size} var(--…) references in auth.css are defined in tokens.css.`);
  process.exit(0);
} else {
  console.error(`✗ ${missing.length} var(--…) reference(s) in auth.css not found in tokens.css:\n`);
  for (const name of missing) {
    console.error(`  --${name}`);
  }
  console.error('\nFix: add the missing token(s) to public/tokens.css (and src/react/theme.ts as the canonical source).');
  process.exit(1);
}
