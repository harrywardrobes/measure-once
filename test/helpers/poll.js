'use strict';
// test/helpers/poll.js
//
// Shared polling utilities for Puppeteer-based test suites.
//
// Extracted from the inline while-loops that appear across many test/*/run.js
// files so that timeout values and loop patterns can be tuned in one place and
// future test authors can use proven patterns without copy-pasting.

/**
 * Poll a browser page until fn() returns a truthy value, or until timeoutMs
 * elapses.  fn is evaluated inside the page context via page.evaluate.
 *
 * evalArgs (optional array) is serialized by Puppeteer and spread as
 * additional arguments to fn, e.g. page.evaluate(fn, ...evalArgs).
 *
 * Returns the first truthy value returned by fn, or null on timeout.
 */
async function pollUntil(page, fn, timeoutMs = 8000, intervalMs = 150, evalArgs = []) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let got = null;
    try { got = await page.evaluate(fn, ...evalArgs); } catch {}
    if (got) return got;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

/**
 * Poll until window.switchTab is available as a function in the page context.
 * Used after navigating to admin.html to confirm the bundle has evaluated.
 */
async function waitForSwitchTab(page, timeoutMs = 10000) {
  return pollUntil(
    page,
    () => (typeof window.switchTab === 'function' ? 'ok' : null),
    timeoutMs,
    150,
  );
}

/**
 * Poll until the innerHTML length of the element matching selector stops
 * changing (stability check), indicating React has finished its render cycle.
 * Resolves once the length is non-zero and equals the previous sample.
 */
async function stabilityPoll(page, selector, timeoutMs = 5000, intervalMs = 100) {
  let prevLen = -1;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const len = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? el.innerHTML.length : 0;
    }, selector).catch(() => 0);
    if (len > 0 && len === prevLen) break;
    prevLen = len;
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

/**
 * Poll until window[name] is available as a function in the page context.
 * Useful for waiting on lazily-registered bootstrap functions.
 */
async function waitForWindowFn(page, name, timeoutMs = 10000) {
  return pollUntil(
    page,
    (n) => (typeof window[n] === 'function' ? 'ok' : null),
    timeoutMs,
    150,
    [name],
  );
}

module.exports = { pollUntil, waitForSwitchTab, stabilityPoll, waitForWindowFn };
