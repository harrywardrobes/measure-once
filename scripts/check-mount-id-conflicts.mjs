#!/usr/bin/env node
/**
 * check-mount-id-conflicts.mjs
 *
 * Four-pass static check for React mount-point wiring in public/*.html.
 *
 * Pass 1 — Duplicate-mount detection:
 *   Every id in the MOUNTS table in src/react/main.tsx must appear in at most
 *   ONE HTML page under public/.  When the same mount id shows up in two
 *   different pages (e.g. sales.html accidentally reusing id="tab-customers"
 *   that belongs to customers.html), mountKnown() will render the wrong React
 *   island into the structural element on the wrong page, making the intended
 *   island invisible.
 *
 * Pass 2 — Missing-mount detection:
 *   Every HTML page that loads /react/main.js must also declare at least one
 *   element id that is present in the MOUNTS table.  A page that loads the
 *   bundle but has no matching mount element loads dead JS and likely indicates
 *   a mis-wired new page or a forgotten container element.
 *
 * Pass 3 — Error-page container check (aggregate):
 *   Every id in BOOTSTRAP_ONLY_IDS (src/react/lib/publicIslands.ts) must
 *   appear in at least one HTML file under public/.  Because error/restricted
 *   pages may carry other valid MOUNTS ids (chrome mounts, etc.), Pass 2
 *   would not catch a typo or accidental removal of the page's own container
 *   id — the React component would silently never mount.  This pass makes
 *   the check targeted: each BOOTSTRAP_ONLY_IDS entry is verified individually
 *   against the full set of HTML files, regardless of what other ids the page
 *   declares.
 *
 * Pass 4 — Error-page canonical-file check (annotation required + per-file):
 *   Every BOOTSTRAP_ONLY_IDS entry in publicIslands.ts MUST carry an inline
 *   comment declaring its canonical HTML file, e.g.:
 *     'not-found-root',  // public/404.html — 404 page, rendered after auth
 *   Pass 4 first fails for any entry that is missing this annotation, then
 *   verifies that every annotated id is present in THAT SPECIFIC file — not
 *   just somewhere in public/.  This catches the case where a typo (e.g.
 *   "not-found-roots") is introduced in the correct file while the original id
 *   happens to survive in another HTML file, allowing Pass 3 to pass silently.
 *
 *   Convention: when adding a new error/restricted page to BOOTSTRAP_ONLY_IDS,
 *   you MUST add a `// public/<filename>.html — <description>` annotation on
 *   the same line as the id string.  Omitting it is a CI failure.
 *
 * Exit codes:
 *   0 — no issues found
 *   1 — one or more mount ids appear in multiple HTML files (Pass 1), or
 *       one or more pages load main.js without any mount element (Pass 2), or
 *       one or more BOOTSTRAP_ONLY_IDS entries are absent from all HTML files
 *       (Pass 3), or
 *       one or more BOOTSTRAP_ONLY_IDS entries lack a canonical-file annotation
 *       or are absent from their declared canonical HTML file (Pass 4)
 *
 * Usage:
 *   node scripts/check-mount-id-conflicts.mjs
 *
 * Wired into CI via: npm run test:mount-ids
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, join, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// 1. Extract mount ids from src/react/main.tsx
// ---------------------------------------------------------------------------

const mainTsxPath = join(ROOT, 'src', 'react', 'main.tsx');
const mainTsxSrc = readFileSync(mainTsxPath, 'utf8');

// Match every  { id: 'some-id', …  entry in the MOUNTS array.
// Lines annotated with  // chrome-global  are intentionally present in every
// HTML shell (they replaced the synchronous chrome.js injection); they are
// excluded from the duplicate-detection check (Pass 1) but still counted
// toward Pass 2 so pages that load main.js are confirmed to have at least
// one mount element.
const mountIdPattern = /\{\s*id:\s*['"]([^'"]+)['"]/g;
const mountIds = new Set();
const chromeGlobalIds = new Set();
let m;
while ((m = mountIdPattern.exec(mainTsxSrc)) !== null) {
  const id = m[1];
  mountIds.add(id);
  // Check if this line ends with a // chrome-global comment (allowing
  // trailing whitespace between the end of the object literal and the comment).
  const lineStart = mainTsxSrc.lastIndexOf('\n', m.index) + 1;
  const lineEnd   = mainTsxSrc.indexOf('\n', m.index);
  const fullLine  = mainTsxSrc.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  if (/\/\/\s*chrome-global\b/.test(fullLine)) {
    chromeGlobalIds.add(id);
  }
}

if (mountIds.size === 0) {
  process.stderr.write(
    '[check-mount-id-conflicts] ERROR: No mount ids extracted from ' +
    'src/react/main.tsx — the MOUNTS pattern may have changed. Update ' +
    'this script to match.\n',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Scan views/*.ejs and record which files contain each mount id
// ---------------------------------------------------------------------------

const viewsDir = join(ROOT, 'views');
const htmlFiles = readdirSync(viewsDir)
  .filter(f => f.endsWith('.ejs'))
  .map(f => join(viewsDir, f));

// For each mount id → array of html files that contain it
/** @type {Map<string, string[]>} */
const idToFiles = new Map([...mountIds].map(id => [id, []]));

// Matches  id="value"  or  id='value'  anywhere in HTML.
const htmlIdPattern = /\bid=['"]([^'"]+)['"]/g;

for (const htmlFile of htmlFiles) {
  const src = readFileSync(htmlFile, 'utf8');
  const relPath = relative(ROOT, htmlFile);
  const seen = new Set();
  let hm;
  while ((hm = htmlIdPattern.exec(src)) !== null) {
    const id = hm[1];
    if (mountIds.has(id) && !seen.has(id)) {
      seen.add(id);
      idToFiles.get(id).push(relPath);
    }
  }
  htmlIdPattern.lastIndex = 0;
}

// ---------------------------------------------------------------------------
// 3. Report conflicts (mount ids that appear in more than one HTML file)
// ---------------------------------------------------------------------------

console.log(
  `[check-mount-id-conflicts] Scanned ${htmlFiles.length} HTML file(s) ` +
  `against ${mountIds.size} React mount id(s).`,
);

/** @type {Array<{id: string, files: string[]}>} */
const conflicts = [];
for (const [id, files] of idToFiles) {
  if (files.length > 1 && !chromeGlobalIds.has(id)) {
    conflicts.push({ id, files });
  }
}

if (conflicts.length === 0) {
  console.log('[check-mount-id-conflicts] Pass 1 OK — no duplicate mount ids found.');
} else {
  process.stderr.write('\n[check-mount-id-conflicts] Pass 1 CONFLICTS DETECTED:\n\n');
  for (const { id, files } of conflicts) {
    process.stderr.write(`  id="${id}" appears in:\n`);
    for (const f of files) {
      process.stderr.write(`    ${f}\n`);
    }
  }
  process.stderr.write(
    '\nEach React mount id must appear in exactly one HTML page.\n' +
    'When the same id appears in multiple pages, mountKnown() will render\n' +
    'the React island into whichever element it finds first, making the\n' +
    'correct page\'s island invisible.\n\n' +
    'Fix: rename the element id in the HTML file that should NOT be the\n' +
    'mount target, so it no longer collides with the MOUNTS table in\n' +
    'src/react/main.tsx.\n',
  );
}

// ---------------------------------------------------------------------------
// Pass 2: Every HTML page that loads main.js must have at least one mount id
// ---------------------------------------------------------------------------
//
// Suppression: pages where mount elements are injected dynamically (e.g. by
// chrome.js) can opt out of this check by adding a comment anywhere in the
// HTML file:
//
//   <!-- main-js-no-mount-ok: <reason> -->
//
// This follows the same suppression pattern used by the inline-style and
// privilege-read checks elsewhere in the codebase.

// Matches a <script … src="…main.js"… > tag (handles any attribute order).
const mainJsScriptPattern = /src=['"][^'"]*\/react\/main\.js['"]/;

// Matches the suppression comment.
const noMountOkPattern = /<!--\s*main-js-no-mount-ok:/;

/** @type {string[]} pages that load main.js but declare no mount element */
const missingMounts = [];

for (const htmlFile of htmlFiles) {
  const src = readFileSync(htmlFile, 'utf8');
  if (!mainJsScriptPattern.test(src)) continue; // doesn't load main.js
  if (noMountOkPattern.test(src)) continue;      // suppressed intentionally

  const relPath = relative(ROOT, htmlFile);
  const hasMountId = [...mountIds].some(id => src.includes(`id="${id}"`) || src.includes(`id='${id}'`));
  if (!hasMountId) {
    missingMounts.push(relPath);
  }
}

if (missingMounts.length === 0) {
  console.log('[check-mount-id-conflicts] Pass 2 OK — every page that loads main.js has a mount element.');
} else {
  process.stderr.write('\n[check-mount-id-conflicts] Pass 2 MISSING MOUNT ELEMENTS:\n\n');
  for (const f of missingMounts) {
    process.stderr.write(`  ${f} loads /react/main.js but declares no element with a MOUNTS id\n`);
  }
  process.stderr.write(
    '\nEvery HTML page that loads /react/main.js must contain at least one\n' +
    'element whose id matches an entry in the MOUNTS table in\n' +
    'src/react/main.tsx.  A page with no mount element loads dead JS and\n' +
    'likely has a missing or mis-named container element.\n\n' +
    'Fix: add the correct mount container element (e.g.\n' +
    '  <div id="react-my-page"></div>\n' +
    ') to the HTML page, and ensure its id is registered in the MOUNTS\n' +
    'table in src/react/main.tsx.\n',
  );
}

// ---------------------------------------------------------------------------
// Pass 3: Every BOOTSTRAP_ONLY_IDS entry must appear in at least one HTML file
// ---------------------------------------------------------------------------
//
// Pass 2 only checks that a page loading main.js has *some* valid MOUNTS id.
// Error/restricted pages (like access-restricted.html) carry chrome mounts
// alongside their own container id, so Pass 2 would not catch a typo or
// accidental removal of the specific container id for the error component.
// Pass 3 checks each BOOTSTRAP_ONLY_IDS entry individually against all HTML
// files, ensuring the container element is actually present.

/**
 * Extracts the string values from a `new Set([ 'a', 'b', … ])` declaration
 * in the given source text, identified by the variable name.
 *
 * Returns a Set of strings, or null if the declaration cannot be found.
 *
 * @param {string} src
 * @param {string} varName
 * @returns {Set<string> | null}
 */
function extractSetLiteral(src, varName) {
  const startPattern = new RegExp(
    `(?:const|let|var)\\s+${varName}\\s*=\\s*new\\s+Set\\s*\\(\\s*\\[`,
  );
  const startMatch = startPattern.exec(src);
  if (!startMatch) return null;

  let depth = 1;
  let i = startMatch.index + startMatch[0].length;
  const bodyStart = i;
  while (i < src.length && depth > 0) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') depth--;
    i++;
  }
  if (depth !== 0) return null;

  const body = src.slice(bodyStart, i - 1);
  const ids = new Set();
  const strPattern = /['"]([^'"]+)['"]/g;
  let sm;
  while ((sm = strPattern.exec(body)) !== null) {
    ids.add(sm[1]);
  }
  return ids;
}

const publicIslandsPath = join(ROOT, 'src', 'react', 'lib', 'publicIslands.ts');
let bootstrapOnlyIds = null;
let pass3ParseError = false;

try {
  const publicIslandsSrc = readFileSync(publicIslandsPath, 'utf8');
  bootstrapOnlyIds = extractSetLiteral(publicIslandsSrc, 'BOOTSTRAP_ONLY_IDS');
} catch (err) {
  process.stderr.write(
    `[check-mount-id-conflicts] Pass 3 ERROR: Could not read ` +
    `src/react/lib/publicIslands.ts — ${err.message}\n`,
  );
  pass3ParseError = true;
}

if (!pass3ParseError && !bootstrapOnlyIds) {
  process.stderr.write(
    '[check-mount-id-conflicts] Pass 3 ERROR: Could not extract BOOTSTRAP_ONLY_IDS ' +
    'from src/react/lib/publicIslands.ts — the declaration may have been renamed ' +
    'or reformatted. Update this script to match.\n',
  );
  pass3ParseError = true;
}

// Build a combined HTML source string for a quick membership test.
// We already read all files above; re-read here for clarity (files are small).
/** @type {string[]} ids whose container element is missing from every HTML file */
const bootstrapIdsMissingFromHtml = [];

if (!pass3ParseError) {
  // Collect every id="…" value found across all HTML files.
  const allHtmlIds = new Set();
  for (const htmlFile of htmlFiles) {
    const src = readFileSync(htmlFile, 'utf8');
    let hm;
    htmlIdPattern.lastIndex = 0;
    while ((hm = htmlIdPattern.exec(src)) !== null) {
      allHtmlIds.add(hm[1]);
    }
    htmlIdPattern.lastIndex = 0;
  }

  for (const id of bootstrapOnlyIds) {
    if (!allHtmlIds.has(id)) {
      bootstrapIdsMissingFromHtml.push(id);
    }
  }
}

if (!pass3ParseError && bootstrapIdsMissingFromHtml.length === 0) {
  console.log(
    '[check-mount-id-conflicts] Pass 3 OK — every BOOTSTRAP_ONLY_IDS entry ' +
    'has a matching container element in views/*.ejs.',
  );
} else if (!pass3ParseError) {
  process.stderr.write('\n[check-mount-id-conflicts] Pass 3 MISSING ERROR-PAGE CONTAINERS:\n\n');
  for (const id of bootstrapIdsMissingFromHtml) {
    process.stderr.write(
      `  id="${id}" is in BOOTSTRAP_ONLY_IDS (src/react/lib/publicIslands.ts) ` +
      `but no element with that id was found in any views/*.ejs file\n`,
    );
  }
  process.stderr.write(
    '\nEvery id in BOOTSTRAP_ONLY_IDS must have a matching <… id="…"> element\n' +
    'in its corresponding EJS view under views/.  Without this, the React\n' +
    'component silently never mounts.\n\n' +
    'Fix: ensure the EJS view for the error/restricted page declares the\n' +
    'correct container element, e.g.:\n' +
    '  <div id="not-found-root"></div>\n' +
    'and verify that the id exactly matches the BOOTSTRAP_ONLY_IDS entry in\n' +
    'src/react/lib/publicIslands.ts.\n',
  );
}

// ---------------------------------------------------------------------------
// Pass 4: Every BOOTSTRAP_ONLY_IDS entry must have a canonical-file annotation
//         AND the id must be present in THAT SPECIFIC HTML file.
// ---------------------------------------------------------------------------
//
// Pass 4a — Annotation required:
//   Every entry in BOOTSTRAP_ONLY_IDS must carry a `// views/<file>.ejs`
//   comment annotation.  Entries without an annotation are a CI failure —
//   the per-file guarantee of Pass 4b would be silently skipped for them.
//
// Pass 4b — Per-file presence check:
//   Pass 3 only checks that a BOOTSTRAP_ONLY_IDS id exists in *some* EJS file.
//   That can silently pass when, e.g., an error-page container is renamed to a
//   typo ("not-found-roots") in the correct file while the original id still
//   survives in a different EJS file.  Pass 4b closes that gap by verifying
//   each annotated id against its specific declared file.
//
// The canonical file is declared as the first `views/….ejs` token in the
// inline comment on the same line as the id string in BOOTSTRAP_ONLY_IDS:
//
//   'not-found-root',  // views/404.ejs — 404 page, rendered after auth
//
// Convention: every BOOTSTRAP_ONLY_IDS entry MUST have this annotation.
// Omitting it is now a CI failure (Pass 4a).  Pass 3 still applies regardless.

/**
 * Extracts a Map<id, canonicalRelPath> by scanning the BOOTSTRAP_ONLY_IDS
 * block in publicIslands.ts for inline `// views/xxx.ejs` comments.
 *
 * Returns an empty Map if the block cannot be located or no annotations are
 * found — the pass is then a no-op (Pass 3 still applies).
 *
 * @param {string} src   Full text of publicIslands.ts
 * @returns {Map<string, string>}
 */
function extractBootstrapCanonicalFiles(src) {
  const result = new Map();

  // Find the BOOTSTRAP_ONLY_IDS = new Set([ … ]); block.
  const blockStart = src.indexOf('BOOTSTRAP_ONLY_IDS');
  if (blockStart === -1) return result;

  const bracketOpen = src.indexOf('[', blockStart);
  if (bracketOpen === -1) return result;

  // Walk to the matching ']'.
  let depth = 1;
  let i = bracketOpen + 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') depth--;
    i++;
  }
  if (depth !== 0) return result;

  const block = src.slice(bracketOpen + 1, i - 1);

  // Each line may look like:
  //   'some-id',         // views/foo.ejs — description
  // We capture: the id string and the first views/….ejs token in the comment.
  const linePattern = /['"]([^'"]+)['"]\s*,?\s*\/\/\s*(views\/\S+\.ejs)/g;
  let lm;
  while ((lm = linePattern.exec(block)) !== null) {
    result.set(lm[1], lm[2]);
  }
  return result;
}

/** @type {string[]} BOOTSTRAP_ONLY_IDS entries that are missing the annotation */
const pass4MissingAnnotations = [];
/** @type {Array<{id: string, canonicalFile: string}>} */
const pass4FilesNotFound = [];
/** @type {Array<{id: string, canonicalFile: string}>} */
const pass4Failures = [];
let pass4ParseError = false;

if (!pass3ParseError && bootstrapOnlyIds) {
  let canonicalMap;
  try {
    const publicIslandsSrc = readFileSync(publicIslandsPath, 'utf8');
    canonicalMap = extractBootstrapCanonicalFiles(publicIslandsSrc);
  } catch (err) {
    process.stderr.write(
      `[check-mount-id-conflicts] Pass 4 ERROR: Could not re-read ` +
      `src/react/lib/publicIslands.ts — ${err.message}\n`,
    );
    pass4ParseError = true;
  }

  if (!pass4ParseError && canonicalMap) {
    // Pass 4a: every BOOTSTRAP_ONLY_IDS entry must have a canonical annotation.
    for (const id of bootstrapOnlyIds) {
      if (!canonicalMap.has(id)) {
        pass4MissingAnnotations.push(id);
      }
    }

    // Pass 4b: every annotated entry must be present in its declared file.
    for (const [id, relCanonical] of canonicalMap) {
      const canonicalAbs = join(ROOT, relCanonical);
      if (!existsSync(canonicalAbs)) {
        // Annotation filename is a typo — file does not exist on disk.
        pass4FilesNotFound.push({ id, canonicalFile: relCanonical });
        continue;
      }
      const fileSrc = readFileSync(canonicalAbs, 'utf8');
      const idPresent =
        fileSrc.includes(`id="${id}"`) || fileSrc.includes(`id='${id}'`);
      if (!idPresent) {
        pass4Failures.push({ id, canonicalFile: relCanonical });
      }
    }
  }
}

if (
  !pass4ParseError &&
  pass4MissingAnnotations.length === 0 &&
  pass4FilesNotFound.length === 0 &&
  pass4Failures.length === 0
) {
  console.log(
    '[check-mount-id-conflicts] Pass 4 OK — every BOOTSTRAP_ONLY_IDS entry ' +
    'has a canonical-file annotation and is present in that file.',
  );
} else if (!pass4ParseError) {
  if (pass4MissingAnnotations.length > 0) {
    process.stderr.write('\n[check-mount-id-conflicts] Pass 4a MISSING CANONICAL-FILE ANNOTATIONS:\n\n');
    for (const id of pass4MissingAnnotations) {
      process.stderr.write(
        `  id="${id}" in BOOTSTRAP_ONLY_IDS (src/react/lib/publicIslands.ts) ` +
        `lacks a required \`// views/<file>.ejs\` annotation\n`,
      );
    }
    process.stderr.write(
      '\nEvery BOOTSTRAP_ONLY_IDS entry must declare its canonical EJS view via\n' +
      'an inline comment.  Without this annotation, the per-file presence check\n' +
      '(Pass 4b) is silently skipped for that entry.\n\n' +
      'Fix: add a `// views/<filename>.ejs — <description>` comment to the\n' +
      'right of the id string in src/react/lib/publicIslands.ts, e.g.:\n' +
      '  \'not-found-root\',  // views/404.ejs — 404 page, rendered after auth\n',
    );
  }

  if (pass4FilesNotFound.length > 0) {
    process.stderr.write('\n[check-mount-id-conflicts] Pass 4b ANNOTATION FILE NOT FOUND:\n\n');
    for (const { id, canonicalFile } of pass4FilesNotFound) {
      process.stderr.write(
        `  id="${id}" — annotated file not found: ${canonicalFile}\n`,
      );
    }
    process.stderr.write(
      '\nThe `// views/….ejs` annotation on each BOOTSTRAP_ONLY_IDS entry must\n' +
      'name a file that actually exists under views/.  The filename above does\n' +
      'not exist on disk — it is likely a typo in the annotation comment.\n\n' +
      'Fix: correct the `// views/<filename>.ejs` comment on the relevant\n' +
      'BOOTSTRAP_ONLY_IDS line in src/react/lib/publicIslands.ts to match the\n' +
      'real filename, e.g.:\n' +
      '  \'not-found-root\',  // views/404.ejs — 404 page, rendered after auth\n',
    );
  }

  if (pass4Failures.length > 0) {
    process.stderr.write('\n[check-mount-id-conflicts] Pass 4b MISSING CANONICAL-FILE CONTAINERS:\n\n');
    for (const { id, canonicalFile } of pass4Failures) {
      process.stderr.write(
        `  id="${id}" is declared for ${canonicalFile} ` +
        `(src/react/lib/publicIslands.ts) but that file does not contain ` +
        `an element with that id\n`,
      );
    }
    process.stderr.write(
      '\nEach BOOTSTRAP_ONLY_IDS entry with a `// views/….ejs` annotation must\n' +
      'have a matching <… id="…"> element in the declared EJS view.  Without\n' +
      'this, the React component silently never mounts on that page.\n\n' +
      'Fix: ensure the correct id appears in the EJS view, e.g.:\n' +
      '  <div id="not-found-root"></div>   in views/404.ejs\n' +
      'and verify the id exactly matches the BOOTSTRAP_ONLY_IDS entry in\n' +
      'src/react/lib/publicIslands.ts.\n\n' +
      'If the canonical file annotation is wrong, update the `// views/….ejs`\n' +
      'comment on the relevant BOOTSTRAP_ONLY_IDS line.\n',
    );
  }
}

if (
  conflicts.length > 0 ||
  missingMounts.length > 0 ||
  pass3ParseError ||
  bootstrapIdsMissingFromHtml.length > 0 ||
  pass4ParseError ||
  pass4MissingAnnotations.length > 0 ||
  pass4FilesNotFound.length > 0 ||
  pass4Failures.length > 0
) {
  process.exit(1);
}
process.exit(0);
