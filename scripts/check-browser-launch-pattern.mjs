#!/usr/bin/env node
/**
 * scripts/check-browser-launch-pattern.mjs
 *
 * Static lint for the browser-launch PROBE_LABELS pattern.
 *
 * Every test file that calls `puppeteer.launch()` and declares a PROBE_LABELS
 * variable must also contain a `for (const l of <PROBE_LABELS_VAR>)` loop
 * AFTER each launch call so that a browser-launch failure is reported against
 * every named probe (not silently dropped).
 *
 * The companion rule — using PROBE_LABELS in the `!puppeteer` guard — is
 * already enforced by the broader PROBE_LABELS convention; this script focuses
 * exclusively on the launch-failure path.
 *
 * Two failure modes are detected:
 *
 *   missing-launch-loop
 *       A PROBE_LABELS variable is declared before a `puppeteer.launch()` call
 *       but there is no `for (const l of <PROBE_LABELS_VAR>)` loop anywhere
 *       after that call to report the failure.
 *
 *   bare-launch
 *       `puppeteer.launch()` is assigned directly to a `const` at the statement
 *       level (i.e. not inside a `try` block), which means any launch error
 *       will be an unhandled rejection rather than a reported probe failure.
 *       Pattern detected: `const <name> = await puppeteer.launch(`
 *
 * Existing suites that predate this convention are listed in ALLOWLIST below
 * with a short reason.  Any newly added file that triggers either failure mode
 * and is NOT in the allowlist will fail CI immediately.
 *
 * Run via:  npm run test:browser-launch-pattern
 *
 * ---------------------------------------------------------------------------
 * Authoring contract — summary for new puppeteer suites
 * ---------------------------------------------------------------------------
 * When adding a new puppeteer suite that uses a PROBE_LABELS array, you must:
 *
 *   1. Wrap every `puppeteer.launch(` call in a try/catch block:
 *
 *        let browser = null;
 *        try {
 *          browser = await puppeteer.launch({ headless: true, ...opts });
 *        } catch (launchErr) {
 *          const msg = (launchErr?.message || String(launchErr)).slice(0, 200);
 *          for (const l of PROBE_LABELS) record(l, false, `browser launch failed: ${msg}`);
 *          return;  // or equivalent early exit
 *        }
 *
 *   2. Alternatively, accumulate the launch error and report after the loop:
 *
 *        let launchErr = null;
 *        for (let i = 0; i < 3; i++) {
 *          try { browser = await puppeteer.launch(...); launchErr = null; break; }
 *          catch (e) { launchErr = e; }
 *        }
 *        if (launchErr) {
 *          const msg = (launchErr?.message || String(launchErr)).slice(0, 200);
 *          for (const l of PROBE_LABELS) record(l, false, `browser launch failed: ${msg}`);
 *          return;
 *        }
 *
 *   In both patterns the key requirement is that a `for (const l of PROBE_LABELS)`
 *   loop appears somewhere AFTER the `puppeteer.launch(` call in the file.
 * ---------------------------------------------------------------------------
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, relative } from 'path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------------------
// Allowlist — files that predate this convention and have not yet been
// migrated.  Each entry must carry a short reason.  Any file that triggers
// a failure and is NOT listed here will fail CI immediately, so new suites
// without the pattern are caught on first push.
// ---------------------------------------------------------------------------

const ALLOWLIST = new Map([
  ['test/admin-grouped-tabs-bar-stories/run.js',  'pre-convention: no launch-failure PROBE_LABELS loop'],
  ['test/bottom-nav/run.js',                      'pre-convention: bare puppeteer.launch (no try/catch)'],
  ['test/bottom-nav-default/run.js',              'pre-convention: bare launch + no launch-failure loop'],
  ['test/conflict-digest-settings/run.js',        'pre-convention: no launch-failure PROBE_LABELS loop'],
  ['test/customers-pagination/run.js',            'pre-convention: empty catch, no launch-failure loop'],
  ['test/info-card-review-resend/run.js',         'pre-convention: no launch-failure PROBE_LABELS loop'],
  ['test/invoice-bc-sync/run.js',                 'pre-convention: no launch-failure PROBE_LABELS loop'],
  ['test/lead-status-counts-rate-limit/run.js',   'pre-convention: no launch-failure PROBE_LABELS loop'],
  ['test/lead-status-sync/customer-detail.js',    'pre-convention: no launch-failure PROBE_LABELS loop'],
  ['test/login/run.js',                           'pre-convention: no launch-failure PROBE_LABELS loop'],
  ['test/nav-active-tab/run.js',                  'pre-convention: bare puppeteer.launch (no try/catch)'],
  ['test/nav-customise/run.js',                   'pre-convention: bare launch + no launch-failure loop'],
  ['test/nav-role-config/run.js',                 'pre-convention: bare launch + no launch-failure loop'],
  ['test/profile-google-calendar/run.js',         'pre-convention: no launch-failure PROBE_LABELS loop'],
  ['test/project-contacts-dev-mode/run.js',       'pre-convention: no launch-failure PROBE_LABELS loop'],
  ['test/project-contacts-unknown-status/run.js', 'pre-convention: no launch-failure PROBE_LABELS loop'],
  ['test/projects-top-spacing/run.js',            'pre-convention: no launch-failure PROBE_LABELS loop'],
  ['test/room-stale-banner/run.js',               'pre-convention: no launch-failure PROBE_LABELS loop'],
  ['test/scheduling-past-time-guard/run.js',      'pre-convention: bare launch + no launch-failure loop'],
  ['test/skipped-photo-warning/run.js',           'pre-convention: no launch-failure PROBE_LABELS loop'],
  ['test/tabbar-stories/run.js',                  'pre-convention: no launch-failure PROBE_LABELS loop'],
  ['test/workflow-map/run.js',                    'pre-convention: no launch-failure PROBE_LABELS loop'],
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect all .js files under a directory.
 */
function collectJsFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...collectJsFiles(full));
    } else if (entry.endsWith('.js')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Check whether a source file follows the browser-launch PROBE_LABELS pattern.
 *
 * Returns an array of issue strings (empty = compliant).
 *
 * Rules:
 *   bare-launch        — `const <x> = await puppeteer.launch(` at statement level
 *   missing-launch-loop — PROBE_LABELS declared before a launch but no
 *                         for...of...PROBE_LABELS loop exists after the launch
 */
function checkFile(src) {
  const issues = [];

  // Detect bare launch: const <var> = await puppeteer.launch( at statement level.
  // This is a direct top-level await without a try block.
  if (/^\s*const\s+\w+\s*=\s*await\s+puppeteer\.launch\s*\(/m.test(src)) {
    issues.push('bare-launch');
  }

  // Collect positions of every puppeteer.launch( call.
  const launchRe = /puppeteer\.launch\s*\(/g;
  const launchMatches = [...src.matchAll(launchRe)];
  if (launchMatches.length === 0) return issues;

  // Collect every PROBE_LABELS variable declaration.
  // Matches: const PROBE_LABELS = [  or  const D_PROBE_LABELS = [  etc.
  const declRe = /\b(\w*PROBE_LABELS\w*)\s*=\s*\[/g;
  const declMatches = [...src.matchAll(declRe)];
  if (declMatches.length === 0) return issues;

  // For each launch call, verify a for...of...PROBE_LABELS loop appears after it.
  for (const launch of launchMatches) {
    const launchPos = launch.index;

    // Find PROBE_LABELS variables declared BEFORE this launch.
    const priorVars = declMatches
      .filter((d) => d.index < launchPos)
      .map((d) => d[1]);

    if (priorVars.length === 0) continue; // No PROBE_LABELS before this launch.

    // Build a pattern matching any of the prior PROBE_LABELS variable names.
    const varPattern = priorVars.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const loopRe = new RegExp(
      `for\\s*\\(\\s*const\\s+\\w+\\s+of\\s+(?:${varPattern})\\s*\\)`,
    );

    // Check the slice of the file AFTER this launch call.
    const afterLaunch = src.slice(launchPos);
    if (!loopRe.test(afterLaunch)) {
      if (!issues.includes('missing-launch-loop')) {
        issues.push('missing-launch-loop');
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const testDir = join(ROOT, 'test');
const allFiles = collectJsFiles(testDir);

const failures      = [];
const allowlisted   = [];
const cleanCount    = { ref: 0 };

for (const absPath of allFiles) {
  const src = readFileSync(absPath, 'utf8');
  if (!src.includes('puppeteer.launch(')) continue;

  const relPath = relative(ROOT, absPath).replace(/\\/g, '/');
  const issues  = checkFile(src);

  if (issues.length === 0) {
    cleanCount.ref++;
    continue;
  }

  if (ALLOWLIST.has(relPath)) {
    allowlisted.push({ relPath, issues, reason: ALLOWLIST.get(relPath) });
  } else {
    failures.push({ relPath, issues });
  }
}

// ---------------------------------------------------------------------------
// Stale allowlist entries (files that are now compliant but still listed)
// ---------------------------------------------------------------------------

const staleAllowlist = [];
for (const [relPath] of ALLOWLIST) {
  const absPath = join(ROOT, relPath);
  let src;
  try { src = readFileSync(absPath, 'utf8'); }
  catch { continue; } // File deleted — stale, but we only warn about compliant ones.
  if (!src.includes('puppeteer.launch(')) {
    staleAllowlist.push(relPath + ' (file no longer has puppeteer.launch)');
    continue;
  }
  const issues = checkFile(src);
  if (issues.length === 0) {
    staleAllowlist.push(relPath + ' (file is now compliant — remove from ALLOWLIST)');
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (allowlisted.length > 0) {
  console.log(
    `ℹ️   browser-launch-pattern: ${allowlisted.length} allowlisted` +
    ` file${allowlisted.length === 1 ? '' : 's'} with known issues` +
    ` (pre-convention — not yet migrated):\n`,
  );
  for (const { relPath, issues } of allowlisted) {
    console.log(`  ${relPath}  [${issues.join(', ')}]`);
  }
  console.log('');
}

if (staleAllowlist.length > 0) {
  console.warn(
    `⚠️   browser-launch-pattern: ${staleAllowlist.length} allowlist` +
    ` ${staleAllowlist.length === 1 ? 'entry is' : 'entries are'} stale:\n`,
  );
  for (const msg of staleAllowlist) {
    console.warn(`  ${msg}`);
  }
  console.warn(
    '\n  Remove stale entries from ALLOWLIST in' +
    ' scripts/check-browser-launch-pattern.mjs.\n',
  );
}

if (failures.length > 0) {
  console.error(
    `❌  browser-launch-pattern: ${failures.length} file` +
    `${failures.length === 1 ? '' : 's'} ` +
    `violate${failures.length === 1 ? 's' : ''} the browser-launch PROBE_LABELS pattern:\n`,
  );

  for (const { relPath, issues } of failures) {
    console.error(`  ${relPath}  [${issues.join(', ')}]`);
    for (const issue of issues) {
      if (issue === 'bare-launch') {
        console.error(
          '    bare-launch: `const <x> = await puppeteer.launch(` is not inside' +
          ' a try/catch block.\n' +
          '    Wrap the launch in try { ... } catch (launchErr) { ... } and\n' +
          '    loop PROBE_LABELS in the catch to report the failure.',
        );
      }
      if (issue === 'missing-launch-loop') {
        console.error(
          '    missing-launch-loop: a PROBE_LABELS variable is declared before' +
          ' a puppeteer.launch() call\n' +
          '    but no `for (const l of <PROBE_LABELS_VAR>)` loop follows the' +
          ' launch call.\n' +
          '    Add a loop after the launch (or in its catch block) to report\n' +
          '    every named probe as failed when the browser cannot start.',
        );
      }
    }
    console.error('');
  }

  console.error(
    'See the authoring contract at the top of\n' +
    'scripts/check-browser-launch-pattern.mjs for the required patterns.\n' +
    'If this suite genuinely cannot follow the pattern, add it to ALLOWLIST\n' +
    'in that script with a clear reason comment.\n',
  );

  process.exit(1);
}

const parts = [`${cleanCount.ref} file${cleanCount.ref === 1 ? '' : 's'} checked — all compliant`];
if (allowlisted.length > 0) parts.push(`${allowlisted.length} allowlisted (pre-convention)`);
if (staleAllowlist.length > 0) parts.push(`${staleAllowlist.length} stale allowlist entries (see warnings above)`);
console.log(`✅  browser-launch-pattern: ${parts.join('; ')}`);
process.exit(0);
