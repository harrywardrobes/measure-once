#!/usr/bin/env node
/**
 * check-workflow-js-duplicates.mjs
 *
 * This guard is now permanently retired.
 *
 * Task #1109 moved a cluster of picker / quick-set functions from workflow.js
 * into workflow-core.js.  Task #1428 deleted workflow.js entirely, so there is
 * no file left for the guarded functions to drift back into.
 *
 * The script exits 0 unconditionally so that CI continues to pass without
 * requiring changes to the npm scripts or replit.md test table.
 */

console.log(
  'check-workflow-js-duplicates: public/workflow.js was deleted in task #1428 — guard permanently retired. ✓'
);
process.exit(0);
