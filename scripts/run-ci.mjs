#!/usr/bin/env node
/**
 * CI runner — replaces the long `&&`-chained test:ci npm script.
 *
 * Runs every step sequentially, regardless of earlier failures, then writes
 * test-results/summary.md and prints it to stdout.  Exits non-zero when any
 * step failed so CI still fails correctly.
 */

import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RESULTS_DIR = join(ROOT, 'test-results');

mkdirSync(RESULTS_DIR, { recursive: true });

const STEPS = [
  'build:react',
  'test:stale-bundle',
  'test:bundle-size-trend',
  'test:bundle-spike-warning',
  'test:typo-vars',
  'test:color-radius-vars',
  'test:privilege-reads',
  'test:mount-ids',
  'test:inline-styles',
  'test:privileges:ci',
  'test:lead-status-sync:ci',
  'test:lead-status-counts-rate-limit:ci',
  'test:lead-status-sync-customer-detail:ci',
  'test:lead-status-sync-customer-detail-viewer:ci',
  'test:lead-status-sync-customer-detail-editable:ci',
  'test:card-action-handlers:ci',
  'test:design-visit-qb-resubmit:ci',
  'test:design-visit-submitter-name:ci',
  'test:hw-test-user:ci',
  'test:start-design-visit:ci',
  'test:design-visit:ci',
  'test:design-visit-list:ci',
  'test:dv-catalogue-admin:ci',
  'test:dv-catalogue-image-upload:ci',
  'test:dv-catalogue-reorder:ci',
  'test:db-editor:ci',
  'test:db-editor-blocking-rows:ci',
  'test:window-ui-smoke:ci',
  'test:sign-off-stale-link:ci',
  'test:react-admin-tabs:ci',
  'test:new-customer-flow:ci',
  'test:new-customer-counts-retry:ci',
  'test:duplicate-phone-warnings:ci',
  'test:calendar-page:ci',
  'test:bottom-nav-lint',
  'test:hubspot-429-retry:ci',
  'test:hubspot-429-retry-contacts:ci',
  'test:icon-lint',
  'test:design-visit-hubspot-retry:ci',
  'test:phone-directory:ci',
  'test:phone-directory-customers:ci',
  'test:contacts-all-stale-fallback:ci',
  'test:contacts-stale-visibility:ci',
  'test:room-assignments-outage:ci',
  'test:change-password:ci',
  'test:invoice-admin-controls:ci',
  'test:bottom-nav:ci',
  'test:nav-active-tab:ci',
  'test:nav-customise:ci',
  'test:admin-tab-skeletons:ci',
  'test:admin-tab-skeletons-new:ci',
  'test:sales-board:ci',
  'test:sales-board-bootstrap:ci',
  'test:survey-board:ci',
  'test:room-stale-banner:ci',
  'test:room-stale-banner-visibility:ci',
  'test:trades:ci',
  'test:sales-board-stage-labels:ci',
  'test:sales-board-error-state:ci',
  'test:design-system-skeletons:ci',
  'test:chunk-cache-headers:ci',
  'test:customers-pagination:ci',
  'test:calendar-empty-state:ci',
  'test:turnstile-signout:ci',
  'test:nav-customise-reset:ci',
  'test:nav-role-config:ci',
  'test:invoice-panel-hidden:ci',
  'test:permissions-ui:ci',
  'test:ideas:ci',
  'test:onboarding-conflicts:ci',
  'test:open-leads-stale-visibility:ci',
  'test:keyboard-shortcuts',
  'test:settings-tab-load:ci',
  'test:profile-google-calendar:ci',
];

/**
 * Derive the expected test-results markdown filename for a given npm script
 * name.  Returns null for build/non-test steps that don't produce reports.
 *
 * Examples:
 *   test:card-action-handlers:ci → card-action-handlers.md
 *   test:privileges:ci            → privileges.md
 *   test:keyboard-shortcuts       → keyboard-shortcuts.md
 *   build:react                   → null
 */
function reportFile(step) {
  if (!step.startsWith('test:')) return null;
  let name = step.replace(/^test:/, '').replace(/:ci$/, '');
  return join(RESULTS_DIR, `${name}.md`);
}

/** Try to extract a one-line summary from a report markdown file. */
function extractReportSummary(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const summaryBlock = text.match(/^## Summary\s*\n([\s\S]*?)(?=\n##|\n---|\Z)/m);
  if (!summaryBlock) return null;
  const lines = summaryBlock[1]
    .split('\n')
    .map(l => l.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);
  return lines.slice(0, 2).join(' · ') || null;
}

const results = [];
let anyFailed = false;

const ciStart = Date.now();

for (const step of STEPS) {
  const stepStart = Date.now();
  process.stdout.write(`\n\x1b[90m▸ npm run ${step}\x1b[0m\n`);

  const result = spawnSync('npm', ['run', step], {
    stdio: 'inherit',
    shell: false,
    cwd: ROOT,
  });

  const elapsed = ((Date.now() - stepStart) / 1000).toFixed(1);
  const code = result.status ?? (result.error ? 1 : 0);
  const passed = code === 0;

  if (!passed) anyFailed = true;

  const status = passed ? 'PASS' : 'FAIL';
  const icon = passed ? '✅' : '❌';
  process.stdout.write(`${icon} ${step} — ${elapsed}s\n`);

  results.push({ step, passed, elapsed: Number(elapsed), reportFile: reportFile(step) });
}

const totalElapsed = ((Date.now() - ciStart) / 1000).toFixed(1);
const passCount = results.filter(r => r.passed).length;
const failCount = results.filter(r => !r.passed).length;

const now = new Date().toISOString();

let md = `# CI Summary — ${now}\n\n`;
md += `> Run finished in **${totalElapsed}s** · **${passCount} passed** · **${failCount} failed** out of ${results.length} steps\n\n`;
md += `## Results\n\n`;
md += `| Step | Status | Time | Detail |\n`;
md += `|------|--------|------|--------|\n`;

for (const r of results) {
  const icon = r.passed ? '✅' : '❌';
  const status = r.passed ? 'PASS' : 'FAIL';
  let detail = '—';
  if (r.reportFile) {
    let exists = false;
    try { readFileSync(r.reportFile); exists = true; } catch { /* not written */ }
    if (exists) {
      const rel = basename(r.reportFile);
      const inline = extractReportSummary(r.reportFile);
      detail = `[${rel}](${rel})${inline ? ` — ${inline}` : ''}`;
    }
  }
  md += `| \`${r.step}\` | ${icon} ${status} | ${r.elapsed}s | ${detail} |\n`;
}

if (failCount > 0) {
  md += `\n## Failed steps\n\n`;
  for (const r of results.filter(r => !r.passed)) {
    md += `- \`${r.step}\``;
    if (r.reportFile) {
      let exists = false;
      try { readFileSync(r.reportFile); exists = true; } catch { /* not written */ }
      if (exists) {
        md += ` → [${basename(r.reportFile)}](${basename(r.reportFile)})`;
      }
    }
    md += '\n';
  }
}

md += `\n---\n_Generated by \`scripts/run-ci.mjs\` at ${now}_\n`;

const summaryPath = join(RESULTS_DIR, 'summary.md');
writeFileSync(summaryPath, md, 'utf8');

process.stdout.write('\n' + '─'.repeat(60) + '\n');
process.stdout.write(md);
process.stdout.write('─'.repeat(60) + '\n');
process.stdout.write(`\nSummary written to test-results/summary.md\n`);

process.exit(anyFailed ? 1 : 0);
