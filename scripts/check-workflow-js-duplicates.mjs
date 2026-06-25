#!/usr/bin/env node
/**
 * check-workflow-js-duplicates.mjs
 *
 * This guard is now permanently retired.
 *
 * A refactor moved a cluster of picker / quick-set functions from workflow.js
 * into workflow-core.js, and a subsequent cleanup deleted workflow.js entirely,
 * so there is no file left for the guarded functions to drift back into.
 *
 * The script exits 0 unconditionally so that CI continues to pass without
 * requiring changes to the npm scripts or CLAUDE.md test table.
 */

console.log(
  'check-workflow-js-duplicates: public/workflow.js was deleted — guard permanently retired. ✓'
);
process.exit(0);
