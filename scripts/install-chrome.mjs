#!/usr/bin/env node
// Installs the Puppeteer Chrome browser for local development and CI.
// Skipped in production because Puppeteer is only used by the test suites,
// never at runtime in the deployed app.
//
// Detection: NODE_ENV=production (set in Replit production env vars) or
// REPL_DEPLOYMENT=1 (set by Replit's build system during deployment).
const isProduction =
  process.env.NODE_ENV === 'production' ||
  process.env.REPL_DEPLOYMENT === '1';

if (isProduction) {
  console.log('Skipping Puppeteer Chrome install in production.');
  process.exit(0);
}

import { execSync } from 'child_process';
execSync('npx puppeteer browsers install chrome', { stdio: 'inherit' });
