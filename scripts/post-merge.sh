#!/bin/bash
set -e

npm install --legacy-peer-deps
npx puppeteer browsers install chrome || true
npm run build:react
