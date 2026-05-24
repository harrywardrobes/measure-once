'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function tryAccess(p) {
  if (!p) return false;
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

function fromWhich() {
  try {
    const out = execSync('which chromium chromium-browser google-chrome 2>/dev/null', { encoding: 'utf8' });
    const first = out.split('\n').map((s) => s.trim()).find(Boolean);
    return first || null;
  } catch { return null; }
}

function fromNixStoreScan() {
  try {
    const entries = fs.readdirSync('/nix/store');
    const matches = entries
      .filter((name) => /^[a-z0-9]+-chromium-[\d.]+$/.test(name))
      .map((name) => path.join('/nix/store', name, 'bin', 'chromium'))
      .filter(tryAccess)
      .sort();
    return matches.length ? matches[matches.length - 1] : null;
  } catch { return null; }
}

function findChromium() {
  const envCandidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROMIUM_PATH,
  ].filter(Boolean);
  for (const p of envCandidates) {
    if (tryAccess(p)) return p;
  }
  const w = fromWhich();
  if (tryAccess(w)) return w;
  const nix = fromNixStoreScan();
  if (tryAccess(nix)) return nix;
  return null;
}

module.exports = { findChromium };
