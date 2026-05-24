const { findChromium } = require('./test/shared/find-chromium');

const executablePath = findChromium();

/** @type {import("puppeteer").Configuration} */
module.exports = {
  ...(executablePath ? { executablePath } : {}),
};
