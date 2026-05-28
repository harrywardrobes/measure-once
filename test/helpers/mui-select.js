'use strict';
// test/helpers/mui-select.js
//
// Shared helper for interacting with MUI Select dropdowns in Puppeteer tests.
//
// MUI Select dropdowns must be opened with Puppeteer's native
// ElementHandle.click() — which dispatches real pointer/mouse events through
// the browser's event pipeline — rather than element.click() called inside
// page.evaluate().  The evaluate() variant fires a synthetic DOM click event
// that MUI's internal React handler ignores when deciding whether to open the
// dropdown portal.  Using the native ElementHandle path avoids a hard-to-debug
// failure mode where the listbox never appears and subsequent option-picking
// code times out.

/**
 * Click a MUI Select trigger element identified by `selector` using
 * Puppeteer's native ElementHandle.click() so that the dropdown portal opens.
 *
 * @param {import('puppeteer').Page} page - Puppeteer page (or browser context)
 * @param {string} selector - CSS selector for the `.MuiSelect-select` element
 * @returns {Promise<import('puppeteer').ElementHandle|null>}
 *   The ElementHandle if the element was found and clicked, null otherwise.
 */
async function clickMuiSelect(page, selector) {
  const handle = await page.$(selector);
  if (handle) {
    await handle.click();
    return handle;
  }
  return null;
}

module.exports = { clickMuiSelect };
