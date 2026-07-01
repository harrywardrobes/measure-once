#!/usr/bin/env node
// scripts/apply-skip-pattern.mjs
//
// Transforms test/*/run.js files to use the shared skip() helper from
// test/helpers/report.js instead of record(..., false) for guard-based
// probe failures (puppeteer not installed, browser launch failed).
//
// Usage: node scripts/apply-skip-pattern.mjs

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── Suite registry ────────────────────────────────────────────────────────────
// Each entry: { file, form: '4arg'|'3arg', extraReplacements? }
// form '4arg': record(name, expected, observed, ok, detail?)
// form '3arg': record(id, ok, detail)

const SUITES_4ARG = [
  'active-projects-hubspot-outage',
  'admin-tab-skeletons',
  'bottom-nav-default',
  'calendar-empty-state',
  'calendar-page',
  'card-action-handlers',
  'change-password',
  'conflict-digest-settings',
  'customer-card-action-strip',
  'customer-info-conflict-warning',
  'customer-info-stale-rail',
  'design-system-skeletons',
  'design-visit-list',
  'design-visit',
  'duplicate-phone-warnings',
  'dv-catalogue-admin',
  'ideas',
  'invoice-bc-sync',
  'invoice-hash-restore',
  'invoice-panel-hidden',
  'keyboard-shortcuts',
  'lead-status-sync',
  'login',
  'nav-role-config',
  'new-customer-counts-retry',
  'new-customer-flow',
  'onboarding-conflicts',
  'permissions-ui',
  'profile-google-calendar',
  'projects-top-spacing',
  'react-admin-tabs',
  'room-stale-banner',
  'scheduling-past-time-guard',
  'set-password',
  'settings-tab-load',
  'start-design-visit',
  'trades',
  'turnstile-signout',
  'upload-photos-modal-emitter',
  'upload-photos-resend-mode',
  'visit-edit-cancel',
  'window-ui-smoke',
  'workflow-map',
];

const SUITES_3ARG = [
  'active-link-warning-ordering',
  'contacts-stale-visibility',
  'copyable-link',
  'customer-info',
  'customer-info-live-badge',
  'customers-pagination',
  'info-card-review-resend',
  'open-leads-stale-visibility',
  'photos-received-badge',
  'project-contacts-dev-mode',
  'project-contacts-unknown-status',
  'quick-load-and-update',
  'room-stale-banner-visibility',
  'skipped-photo-warning',
  'stage-scoped-pills',
  'upload-photos-copyable-link',
  'upload-photos-modal-labels',
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function log(msg) { process.stdout.write(msg + '\n'); }

/**
 * Insert `insertLine` after the first occurrence of `anchorPattern` (regex)
 * in `lines`.  Returns false if the anchor was not found.
 */
function insertAfter(lines, anchorPattern, insertLine) {
  const idx = lines.findIndex(l => anchorPattern.test(l));
  if (idx < 0) return false;
  lines.splice(idx + 1, 0, insertLine);
  return true;
}

/**
 * Insert `insertLine` before the first occurrence of `anchorPattern` (regex)
 * in `lines`.  Returns false if the anchor was not found.
 */
function insertBefore(lines, anchorPattern, insertLine) {
  const idx = lines.findIndex(l => anchorPattern.test(l));
  if (idx < 0) return false;
  lines.splice(idx, 0, insertLine);
  return true;
}

// ── 4-arg replacement patterns ────────────────────────────────────────────────
// These are applied as line-level string replacements (not regex) to avoid
// mangling template-literal content.

const PATTERNS_4ARG = [
  // puppeteer not installed variants
  [
    "record(l, 'puppeteer installed', 'puppeteer not installed', false)",
    "skip(l, 'puppeteer installed', 'puppeteer not installed')",
  ],
  [
    "record(l, 'puppeteer installed', 'puppeteer not installed (skipped)', false)",
    "skip(l, 'puppeteer installed', 'puppeteer not installed (skipped)')",
  ],
  [
    "record(label, 'puppeteer installed', 'puppeteer not installed', false)",
    "skip(label, 'puppeteer installed', 'puppeteer not installed')",
  ],
  // browser launch failures — ${msg} variant
  [
    'record(l, \'browser launched\', `browser launch failed: ${msg}`, false)',
    'skip(l, \'browser launched\', `browser launch failed: ${msg}`)',
  ],
  [
    'record(l, \'browser launched\', `browser launch failed: ${e.message}`, false)',
    'skip(l, \'browser launched\', `browser launch failed: ${e.message}`)',
  ],
  [
    'record(label, \'browser launched\', `browser launch failed: ${msg}`, false)',
    'skip(label, \'browser launched\', `browser launch failed: ${msg}`)',
  ],
  [
    'record(label, \'browser launched\', `browser launch failed: ${e.message}`, false)',
    'skip(label, \'browser launched\', `browser launch failed: ${e.message}`)',
  ],
  // start-design-visit special expected strings
  [
    "record(label, 'browser launched and admin.html UI tested', `browser launch failed: ${msg}`, false)",
    "skip(label, 'browser launched and admin.html UI tested', `browser launch failed: ${msg}`)",
  ],
  [
    "record(label, 'browser launched and wizard tested', `browser launch failed: ${msg}`, false)",
    "skip(label, 'browser launched and wizard tested', `browser launch failed: ${msg}`)",
  ],
  // invoice-hash-restore uses 'browser launches' and browserLaunchErr
  [
    'record(l, \'browser launches\', `error: ${browserLaunchErr?.message}`, false)',
    'skip(l, \'browser launches\', `error: ${browserLaunchErr?.message}`)',
  ],
  // nav-role-config uses slightly different string
  [
    "record(l, 'puppeteer installed', 'puppeteer not installed (skipped)', false)",
    "skip(l, 'puppeteer installed', 'puppeteer not installed (skipped)')",
  ],
  // bottom-nav-default uses its own variant
  [
    "record(l, 'puppeteer installed', 'puppeteer not installed (skipped)', false)",
    "skip(l, 'puppeteer installed', 'puppeteer not installed (skipped)')",
  ],
];

// ── 3-arg replacement patterns ─────────────────────────────────────────────────

const PATTERNS_3ARG = [
  // puppeteer variants
  [
    "record(l, false, 'puppeteer not installed — all probes skipped')",
    "skip(l, 'puppeteer not installed — all probes skipped')",
  ],
  [
    "record(l, false, 'puppeteer not installed — browser probes skipped')",
    "skip(l, 'puppeteer not installed — browser probes skipped')",
  ],
  [
    "record(l, false, 'puppeteer not installed — skipped')",
    "skip(l, 'puppeteer not installed — skipped')",
  ],
  [
    "record(l, false, 'puppeteer not installed')",
    "skip(l, 'puppeteer not installed')",
  ],
  [
    "record(l, false, 'puppeteer not installed — UI probes skipped')",
    "skip(l, 'puppeteer not installed — UI probes skipped')",
  ],
  // active-link-warning-ordering
  [
    "record(l, false, 'puppeteer not installed — skipped')",
    "skip(l, 'puppeteer not installed — skipped')",
  ],
  // customer-info uses these strings
  [
    "record(l, false, 'skipped — puppeteer not installed')",
    "skip(l, 'skipped — puppeteer not installed')",
  ],
  [
    'record(l, false, `skipped — browser launch failed: ${e.message}`)',
    'skip(l, `skipped — browser launch failed: ${e.message}`)',
  ],
  // browser launch failures
  [
    'record(l, false, `browser launch failed: ${msg}`)',
    'skip(l, `browser launch failed: ${msg}`)',
  ],
  [
    'record(l, false, `browser launch failed: ${e.message}`)',
    'skip(l, `browser launch failed: ${e.message}`)',
  ],
  [
    "record(l, false, 'browser launch failed')",
    "skip(l, 'browser launch failed')",
  ],
  // stage-scoped-pills / copyable-link use different variable names
  [
    "record(l, false, 'puppeteer not installed')",
    "skip(l, 'puppeteer not installed')",
  ],
];

// ── Transform a 4-arg suite ────────────────────────────────────────────────────

function transform4arg(suiteName, src) {
  const lines = src.split('\n');
  let changed = false;

  // 1. Add import after 'use strict'; line
  const hasImport = lines.some(l => l.includes("require('../helpers/report')"));
  if (!hasImport) {
    const strictIdx = lines.findIndex(l => l.trim() === "'use strict';");
    if (strictIdx >= 0) {
      lines.splice(strictIdx + 1, 0, "const { makeSkip } = require('../helpers/report');");
      changed = true;
    }
  }

  // 2. Add skip binding after the record function definition
  // Look for the end of the record function (closing brace after record push)
  // Strategy: find `findings.push({` inside a record function and then find
  // the closing `}` of that function.
  const hasSkipBinding = lines.some(l => l.includes('makeSkip(findings)'));
  if (!hasSkipBinding) {
    // Find the record function definition line
    const recIdx = lines.findIndex(l => /^\s+function record\(|^function record\(/.test(l));
    if (recIdx >= 0) {
      // Find the closing brace of the record function
      const indent = lines[recIdx].match(/^(\s*)/)[1];
      let depth = 0;
      let closeIdx = -1;
      for (let i = recIdx; i < Math.min(recIdx + 20, lines.length); i++) {
        for (const ch of lines[i]) {
          if (ch === '{') depth++;
          else if (ch === '}') { depth--; if (depth === 0) { closeIdx = i; break; } }
        }
        if (closeIdx >= 0) break;
      }
      if (closeIdx >= 0) {
        lines.splice(closeIdx + 1, 0, `${indent}const skip = makeSkip(findings);`);
        changed = true;
      }
    }
  }

  // 3. Apply line-level replacements for guard calls
  for (let i = 0; i < lines.length; i++) {
    for (const [from, to] of PATTERNS_4ARG) {
      if (lines[i].includes(from)) {
        lines[i] = lines[i].replace(from, to);
        changed = true;
      }
    }
  }

  // 4. Update writeReport: PASS/FAIL → PASS/SKIP/FAIL
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("f.ok ? 'PASS' : 'FAIL'") && !lines[i].includes('f.skipped')) {
      lines[i] = lines[i].replace("f.ok ? 'PASS' : 'FAIL'", "f.ok ? 'PASS' : f.skipped ? 'SKIP' : 'FAIL'");
      changed = true;
    }
  }

  // 5. Update summary: add Skipped count
  // Look for patterns like `- Passed: N / total` and `- Failed: N / total`
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Pattern: `- Passed:  ${passed}  / ${findings.length}` or similar
    // After the Passed line, insert Skipped line (if not already present)
    if (
      /Passed.*findings/.test(line) &&
      !lines.some(l => l.includes('Skipped') && l.includes('findings'))
    ) {
      // Determine if it's a template literal line
      const passMatch = line.match(/^(\s+)`- Passed:\s+\$\{(\w+)\}\s+\/\s+\$\{findings\.length\}`,?/);
      if (passMatch) {
        const ws = passMatch[1];
        const passVar = passMatch[2];
        // We need to find the skipped var — insert a derived line
        // Also update the Failed line to exclude skipped
        // Insert after current line
        lines.splice(i + 1, 0, `${ws}\`- Skipped: \${skipped} / \${findings.length}\`,`);
        changed = true;
        // Now patch the Failed line to use !f.ok && !f.skipped
        // It may be a few lines up or down
        for (let j = Math.max(0, i - 5); j < Math.min(lines.length, i + 10); j++) {
          if (lines[j].includes('Failed') && lines[j].includes('findings') && !lines[j].includes('!f.skipped')) {
            lines[j] = lines[j].replace(
              /findings\.filter\(f => !f\.ok\)/,
              'findings.filter(f => !f.ok && !f.skipped)',
            );
            changed = true;
          }
        }
        break;
      }
    }

    // Also handle: `- Passed: ${findings.filter(f => f.ok).length} / ${findings.length}`
    if (
      line.includes('findings.filter(f => f.ok).length') &&
      line.includes('Passed') &&
      !lines.some(l => l.includes('Skipped') && l.includes('skipped'))
    ) {
      const ws = line.match(/^(\s+)/)?.[1] || '';
      lines.splice(i + 1, 0, `${ws}\`- Skipped: \${findings.filter(f => f.skipped).length} / \${findings.length}\`,`);
      changed = true;
      // Patch the Failed filter
      for (let j = Math.max(0, i - 5); j < Math.min(lines.length, i + 10); j++) {
        if (lines[j].includes('Failed') && lines[j].includes('!f.ok') && !lines[j].includes('!f.skipped')) {
          lines[j] = lines[j].replace('!f.ok', '!f.ok && !f.skipped');
          changed = true;
        }
      }
      break;
    }
  }

  // 6. Update local const declarations for skipped count where the suite
  //    computes pass/fail counts using local variables
  //    e.g. `const pass = findings.filter(f => f.ok).length;`
  //         `const fail = findings.filter(f => !f.ok).length;`
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // If we see a fail count computed without skipped exclusion, fix it
    if (
      /const (fail|failed)\s*=\s*findings\.filter\(f\s*=>\s*!f\.ok\)/.test(line) &&
      !line.includes('!f.skipped')
    ) {
      lines[i] = line.replace(
        /findings\.filter\(f\s*=>\s*!f\.ok\)/,
        'findings.filter(f => !f.ok && !f.skipped)',
      );
      // Insert a skipped count after
      const ws = line.match(/^(\s*)/)[1];
      const failVar = line.match(/const (\w+)\s*=/)[1];
      const skippedLine = `${ws}const skipped = findings.filter(f => f.skipped).length;`;
      if (!lines.some(l => l.includes('const skipped'))) {
        lines.splice(i + 1, 0, skippedLine);
        i++; // skip the inserted line
      }
      changed = true;
    }
  }

  return { src: lines.join('\n'), changed };
}

// ── Transform a 3-arg suite ────────────────────────────────────────────────────

function transform3arg(suiteName, src) {
  const lines = src.split('\n');
  let changed = false;

  // 1. Add import after 'use strict';
  const hasImport = lines.some(l => l.includes("require('../helpers/report')"));
  if (!hasImport) {
    const strictIdx = lines.findIndex(l => l.trim() === "'use strict';");
    if (strictIdx >= 0) {
      lines.splice(strictIdx + 1, 0, "const { makeSkip3 } = require('../helpers/report');");
      changed = true;
    }
  }

  // 2. Add skip binding after the record function definition
  const hasSkipBinding = lines.some(l => l.includes('makeSkip3(findings)'));
  if (!hasSkipBinding) {
    const recIdx = lines.findIndex(l => /^\s+function record\(|^function record\(/.test(l));
    if (recIdx >= 0) {
      const indent = lines[recIdx].match(/^(\s*)/)[1];
      let depth = 0;
      let closeIdx = -1;
      for (let i = recIdx; i < Math.min(recIdx + 15, lines.length); i++) {
        for (const ch of lines[i]) {
          if (ch === '{') depth++;
          else if (ch === '}') { depth--; if (depth === 0) { closeIdx = i; break; } }
        }
        if (closeIdx >= 0) break;
      }
      if (closeIdx >= 0) {
        lines.splice(closeIdx + 1, 0, `${indent}const skip = makeSkip3(findings);`);
        changed = true;
      }
    }
  }

  // 3. Apply line-level replacements for guard calls
  for (let i = 0; i < lines.length; i++) {
    for (const [from, to] of PATTERNS_3ARG) {
      if (lines[i].includes(from)) {
        lines[i] = lines[i].replace(from, to);
        changed = true;
      }
    }
  }

  // 4. Update writeReport: PASS/FAIL → PASS/SKIP/FAIL
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("f.ok ? 'PASS' : 'FAIL'") && !lines[i].includes('f.skipped')) {
      lines[i] = lines[i].replace("f.ok ? 'PASS' : 'FAIL'", "f.ok ? 'PASS' : f.skipped ? 'SKIP' : 'FAIL'");
      changed = true;
    }
  }

  // 5. Update summary counts
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (
      line.includes('findings.filter(f => f.ok).length') &&
      line.includes('Passed') &&
      !lines.some(l => l.includes('Skipped') && (l.includes('skipped') || l.includes('f.skipped')))
    ) {
      const ws = line.match(/^(\s+)/)?.[1] || '';
      lines.splice(i + 1, 0, `${ws}\`- Skipped: \${findings.filter(f => f.skipped).length} / \${findings.length}\`,`);
      changed = true;
      for (let j = Math.max(0, i - 5); j < Math.min(lines.length, i + 10); j++) {
        if (lines[j].includes('Failed') && lines[j].includes('!f.ok') && !lines[j].includes('!f.skipped')) {
          lines[j] = lines[j].replace('!f.ok', '!f.ok && !f.skipped');
          changed = true;
        }
      }
      break;
    }

    // Handle: `findings.length - failed` style summaries in console.log
    if (
      /findings\.length - failed/.test(line) &&
      !lines.some(l => l.includes('skipped'))
    ) {
      // This pattern usually appears as: `${findings.length - failed} passed, ${failed} failed`
      // We want: `${findings.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`
      // But this is in console.log, not in writeReport. Handle conservatively.
    }

    // Handle const pass/fail variable pattern
    if (
      /const (fail|failed)\s*=\s*findings\.filter\(f\s*=>\s*!f\.ok\)/.test(line) &&
      !line.includes('!f.skipped')
    ) {
      lines[i] = line.replace(
        /findings\.filter\(f\s*=>\s*!f\.ok\)/,
        'findings.filter(f => !f.ok && !f.skipped)',
      );
      const ws = line.match(/^(\s*)/)[1];
      if (!lines.some(l => l.includes('const skipped'))) {
        lines.splice(i + 1, 0, `${ws}const skipped = findings.filter(f => f.skipped).length;`);
        i++;
      }
      changed = true;
    }
  }

  return { src: lines.join('\n'), changed };
}

// ── Main ──────────────────────────────────────────────────────────────────────

let totalChanged = 0;
let totalSkipped = 0;

for (const name of SUITES_4ARG) {
  const file = resolve(ROOT, 'test', name, 'run.js');
  let src;
  try { src = readFileSync(file, 'utf8'); } catch { log(`  SKIP (not found): ${name}`); totalSkipped++; continue; }
  const { src: out, changed } = transform4arg(name, src);
  if (changed) {
    writeFileSync(file, out, 'utf8');
    log(`  ✓ updated (4arg): ${name}`);
    totalChanged++;
  } else {
    log(`  – no changes:     ${name}`);
    totalSkipped++;
  }
}

for (const name of SUITES_3ARG) {
  const file = resolve(ROOT, 'test', name, 'run.js');
  let src;
  try { src = readFileSync(file, 'utf8'); } catch { log(`  SKIP (not found): ${name}`); totalSkipped++; continue; }
  const { src: out, changed } = transform3arg(name, src);
  if (changed) {
    writeFileSync(file, out, 'utf8');
    log(`  ✓ updated (3arg): ${name}`);
    totalChanged++;
  } else {
    log(`  – no changes:     ${name}`);
    totalSkipped++;
  }
}

log(`\n  Done — ${totalChanged} suites updated, ${totalSkipped} unchanged.`);
