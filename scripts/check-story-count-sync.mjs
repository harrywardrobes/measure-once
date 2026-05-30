#!/usr/bin/env node
/**
 * scripts/check-story-count-sync.mjs
 *
 * Static lint that cross-checks story-count claims in docs/TEST_SUITES.md
 * against the actual number of exported Story objects in the referenced
 * .stories.tsx file and the EXPECTED_COUNT constant in the test runner.
 *
 * For each suite row in TEST_SUITES.md that carries a
 *   <!-- story-count: N -->
 * annotation, the script:
 *
 *   1. Reads the suite's test runner (located via package.json scripts).
 *   2. Extracts EXPECTED_COUNT and STORY_TITLE from the runner source.
 *   3. Finds the .stories.tsx file whose `title:` field matches STORY_TITLE.
 *   4. Counts the exported Story-typed constants in that file.
 *   5. Asserts all three values agree: doc claim == EXPECTED_COUNT == actual.
 *
 * Fails with a clear error message for every mismatch found.
 *
 * Run via:  npm run test:story-count-sync
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, resolve } from 'path';
import { readdirSync, statSync } from 'fs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a map of suite name → absolute file path from package.json scripts.
 * Considers non-:ci test:* entries whose command ends with a .js file.
 */
function buildFileMap(scripts) {
  const map = new Map();
  for (const [key, cmd] of Object.entries(scripts)) {
    if (!key.startsWith('test:') || key.endsWith(':ci')) continue;
    const m = cmd.match(/\s((?:test|scripts)\/[^\s]+\.js)\s*$/);
    if (m) map.set(key, join(ROOT, m[1]));
  }
  return map;
}

/**
 * Parse the <!-- story-count: N --> annotation from a table row string.
 * Returns the integer N, or null if no annotation is present.
 */
function extractDocStoryCount(rowText) {
  const m = rowText.match(/<!--\s*story-count:\s*(\d+)\s*-->/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Extract the EXPECTED_COUNT constant from a test runner source string.
 * Returns the integer, or null if not found.
 */
function extractExpectedCount(src) {
  const m = src.match(/\bEXPECTED_COUNT\s*=\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Extract the STORY_TITLE constant from a test runner source string.
 * Returns the string value, or null if not found.
 */
function extractStoryTitle(src) {
  const m = src.match(/\bSTORY_TITLE\s*=\s*['"]([^'"]+)['"]/);
  return m ? m[1] : null;
}

/**
 * Recursively find all .stories.tsx files under the given directory.
 */
function findStoriesFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...findStoriesFiles(full));
    } else if (entry.endsWith('.stories.tsx') || entry.endsWith('.stories.ts')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Find the .stories.tsx file whose `title:` field matches the given storyTitle.
 * Returns the absolute file path, or null if not found.
 *
 * Searches both the dedicated stories directory and the components directory
 * to support stories co-located with their component (e.g. TabBar.stories.tsx
 * lives alongside TabBar.tsx in src/react/components/).
 */
function findStoriesFileByTitle(storyTitle) {
  const searchDirs = [
    join(ROOT, 'src', 'react', 'stories'),
    join(ROOT, 'src', 'react', 'components'),
  ];

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    const files = findStoriesFiles(dir);
    for (const filePath of files) {
      const src = readFileSync(filePath, 'utf8');
      // Match:  title: 'Admin/AdminGroupedTabsBar'  or  title: "Admin/AdminGroupedTabsBar"
      if (src.includes(`title: '${storyTitle}'`) || src.includes(`title: "${storyTitle}"`)) {
        return filePath;
      }
    }
  }
  return null;
}

/**
 * Count the number of exported Story-typed constants in a .stories.tsx source.
 * Matches:
 *   export const Foo: Story = …
 *   export const Foo: StoryObj<…> = …
 * Excludes the default export and type-only exports.
 */
function countExportedStories(src) {
  let count = 0;
  for (const line of src.split('\n')) {
    // Matches:  export const Identifier: Story...  or  export const Identifier: StoryObj...
    if (/^export const \w+:\s*Story(?:Obj)?[\s<{=]/.test(line.trimStart())) {
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const docsFile = join(ROOT, 'docs', 'TEST_SUITES.md');
const pkgFile  = join(ROOT, 'package.json');

const docsSrc = readFileSync(docsFile, 'utf8');
const pkg     = JSON.parse(readFileSync(pkgFile, 'utf8'));
const fileMap = buildFileMap(pkg.scripts ?? {});

// Parse table rows: first column is the suite name, second is the description.
const suiteRows = new Map();
for (const line of docsSrc.split('\n')) {
  const m = line.match(/^\|\s*`(test:[^`]+)`\s*\|\s*(.*?)\s*\|?\s*$/);
  if (m) suiteRows.set(m[1], m[2]);
}

const failures = [];
let   checked  = 0;
let   skipped  = 0;

for (const [suiteName, rowText] of suiteRows) {
  const docCount = extractDocStoryCount(rowText);
  if (docCount === null) {
    skipped++;
    continue;
  }

  const filePath = fileMap.get(suiteName);
  if (!filePath || !existsSync(filePath)) {
    failures.push({
      suite: suiteName,
      problem: `test runner not found via package.json scripts (no file mapping for "${suiteName}")`,
    });
    continue;
  }

  const runnerSrc = readFileSync(filePath, 'utf8');

  const expectedCount = extractExpectedCount(runnerSrc);
  if (expectedCount === null) {
    failures.push({
      suite: suiteName,
      file:  filePath.replace(ROOT + '/', ''),
      problem: 'EXPECTED_COUNT constant not found in test runner',
    });
    continue;
  }

  const storyTitle = extractStoryTitle(runnerSrc);
  if (!storyTitle) {
    failures.push({
      suite: suiteName,
      file:  filePath.replace(ROOT + '/', ''),
      problem: 'STORY_TITLE constant not found in test runner',
    });
    continue;
  }

  const storiesFile = findStoriesFileByTitle(storyTitle);
  if (!storiesFile) {
    failures.push({
      suite: suiteName,
      file:  filePath.replace(ROOT + '/', ''),
      problem: `no .stories.tsx file found with title: '${storyTitle}'`,
    });
    continue;
  }

  const storiesSrc   = readFileSync(storiesFile, 'utf8');
  const actualCount  = countExportedStories(storiesSrc);
  const storiesShort = storiesFile.replace(ROOT + '/', '');

  const mismatches = [];
  if (docCount !== actualCount) {
    mismatches.push(
      `docs/TEST_SUITES.md claims ${docCount} but ${storiesShort} exports ${actualCount}`,
    );
  }
  if (expectedCount !== actualCount) {
    mismatches.push(
      `EXPECTED_COUNT=${expectedCount} in runner but ${storiesShort} exports ${actualCount}`,
    );
  }
  if (docCount !== expectedCount) {
    mismatches.push(
      `docs/TEST_SUITES.md claims ${docCount} but EXPECTED_COUNT=${expectedCount} in runner`,
    );
  }

  if (mismatches.length > 0) {
    failures.push({
      suite:       suiteName,
      file:        filePath.replace(ROOT + '/', ''),
      storiesFile: storiesShort,
      docCount,
      expectedCount,
      actualCount,
      mismatches,
    });
  }

  checked++;
}

if (failures.length === 0) {
  console.log(
    `✅  story-count-sync: all ${checked} annotated story-count claims are` +
    ` accurate (${skipped} suite${skipped === 1 ? '' : 's'} skipped — no` +
    ` <!-- story-count: N --> annotation)`,
  );
  process.exit(0);
}

console.error(
  `❌  story-count-sync: ${failures.length} story-count` +
  ` ${failures.length === 1 ? 'mismatch' : 'mismatches'} detected:\n`,
);

for (const f of failures) {
  console.error(`  ${f.suite}`);
  if (f.file) console.error(`    Runner      : ${f.file}`);
  if (f.storiesFile) console.error(`    Stories file: ${f.storiesFile}`);
  if (f.mismatches) {
    for (const msg of f.mismatches) {
      console.error(`    ✗ ${msg}`);
    }
  } else {
    console.error(`    ✗ ${f.problem}`);
  }
  console.error('');
}

console.error(
  'To fix:\n' +
  '  • If a story was added or removed from the .stories.tsx file,\n' +
  '    update EXPECTED_COUNT in the test runner and the <!-- story-count: N -->\n' +
  '    annotation in the docs/TEST_SUITES.md row to match the new count.\n' +
  '  • Run `npm run test:story-count-sync` to verify.\n',
);

process.exit(1);
