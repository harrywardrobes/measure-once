#!/usr/bin/env node
// Installs the Puppeteer-managed Chrome browser before running test suites
// that use headless Puppeteer. Called explicitly by the test:privileges and
// test:lead-status-sync-customer-detail* npm scripts — NOT from postinstall,
// so the production build is never affected.
import { execSync } from 'child_process';
execSync('npx puppeteer browsers install chrome', { stdio: 'inherit' });
