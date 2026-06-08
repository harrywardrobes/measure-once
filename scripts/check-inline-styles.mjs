#!/usr/bin/env node
/**
 * check-inline-styles.mjs
 *
 * Scans every views/*.ejs file for inline `style="…"` attributes and fails
 * if any are found.  Inline styles belong in a stylesheet, not in view markup.
 * This check enforces that convention across every EJS view and catches
 * regressions automatically in CI.
 *
 * Lines inside <script>…</script> blocks are skipped because those contain JS
 * source code where `style=` appears in string literals, not as HTML attributes.
 *
 * Algorithm
 * ---------
 * 1. Read each views/*.ejs file line by line.
 * 2. Track whether the current line is inside a <script>…</script> block:
 *    a. A line containing </script> ends script mode before the line is checked,
 *       so any HTML content after the closing tag is still scanned.
 *    b. A line containing <script…> (without a closing </script> on the same
 *       line) enters script mode and is skipped for the rest of its content.
 * 3. Flag any non-script line that contains `style="` or `style='`.
 * 4. Report all violations and exit 1 if any were found.
 *
 * Exit codes:
 *   0 — no violations found
 *   1 — one or more inline style attributes detected
 *
 * Usage:
 *   node scripts/check-inline-styles.mjs
 *
 * Wired into CI via: npm run test:inline-styles
 */

import { readFileSync, readdirSync } from 'fs';
import { resolve, join, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');

const viewsDir = join(ROOT, 'views');
const htmlFiles = readdirSync(viewsDir)
  .filter(f => f.endsWith('.ejs'))
  .sort()
  .map(f => join(viewsDir, f));

/** @type {Array<{file: string, line: number, text: string}>} */
const violations = [];
let filesScanned = 0;

for (const htmlFile of htmlFiles) {
  const relPath = relative(ROOT, htmlFile);
  const src = readFileSync(htmlFile, 'utf8');
  const lines = src.split('\n');

  let inScript = false;
  filesScanned++;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const raw = lines[i];

    // A </script> tag ends script mode.  We update inScript BEFORE the skip
    // check so that HTML content on the same line after </script> is still
    // scanned (e.g. `</script><div style="…">`).
    const closesScript = /<\/script>/i.test(raw);
    if (closesScript) inScript = false;

    if (inScript) continue;

    // A <script…> tag (without a paired </script> on the same line) starts
    // script mode.  Skip the rest of this line to avoid flagging string
    // literals in multi-line script blocks.
    if (/<script[\s>]/i.test(raw) && !closesScript) {
      inScript = true;
      continue;
    }

    if (!/style\s*=\s*["']/i.test(raw)) continue;

    // A trailing <!-- inline-style-ok: reason --> comment on the same line
    // suppresses this violation — used for sr-only patterns, banner defaults,
    // and other cases where the style must live on the element rather than in
    // a stylesheet.
    if (/<!--\s*inline-style-ok\s*:/i.test(raw)) continue;

    violations.push({ file: relPath, line: lineNum, text: raw.trimStart() });
  }
}

console.log(
  `[check-inline-styles] Scanned ${filesScanned} EJS view(s) under views/.`,
);

if (violations.length === 0) {
  console.log('[check-inline-styles] OK — no inline style attributes found.');
  process.exit(0);
}

process.stderr.write(
  `\n[check-inline-styles] VIOLATIONS (${violations.length}):\n\n`,
);
for (const { file, line, text } of violations) {
  process.stderr.write(`  ${file}:${line}\n    ${text}\n\n`);
}
process.stderr.write(
  'Inline style attributes must live in a stylesheet, not in EJS view markup.\n' +
  'Move the styles to public/app-styles.css (or a page-specific <style> block)\n' +
  'and replace the attribute with a class name or scoped ID rule.\n\n',
);
process.exit(1);
