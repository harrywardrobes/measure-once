const { execSync } = require('child_process');
const fs = require('fs');

const NIX_CHROMIUM = '/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium';

let executablePath;

if (fs.existsSync(NIX_CHROMIUM)) {
  executablePath = NIX_CHROMIUM;
} else {
  try {
    const found = execSync('which chromium chromium-browser google-chrome 2>/dev/null', { encoding: 'utf8' })
      .split('\n')[0].trim();
    if (found) executablePath = found;
  } catch {}
}

/** @type {import("puppeteer").Configuration} */
module.exports = {
  ...(executablePath ? { executablePath } : {}),
};
