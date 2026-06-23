#!/usr/bin/env node
// Installs the Puppeteer Chrome browser for local development and CI.
// Skipped in production (NODE_ENV=production) because Puppeteer is only used
// by the test suites, never at runtime in the deployed app.
if (process.env.NODE_ENV === 'production') {
  console.log('Skipping Puppeteer Chrome install in production.');
  process.exit(0);
}

import { execSync } from 'child_process';
execSync('npx puppeteer browsers install chrome', { stdio: 'inherit' });
