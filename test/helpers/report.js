'use strict';
// test/helpers/report.js
//
// Shared skip() helpers for puppeteer-based test suites.
//
// When a guard check fails (e.g. puppeteer not installed, browser launch
// failed, seed failed) the suite cannot run the probe at all.  Recording
// those as FAIL inflates the failure count and makes reports harder to read.
// Using skip() instead emits a SKIP row so readers can immediately distinguish
// "the probe ran and the assertion failed" from "the probe was never attempted
// because a prerequisite was missing".
//
// Usage (4/5-arg record suites — record(name, expected, observed, ok, detail)):
//
//   const { makeSkip } = require('../helpers/report');
//   // after findings and record are defined:
//   const skip = makeSkip(findings);
//   // then instead of:
//   //   record(l, 'puppeteer installed', 'puppeteer not installed', false)
//   // write:
//   //   skip(l, 'puppeteer installed', 'puppeteer not installed')
//
// Usage (3-arg record suites — record(id, ok, detail)):
//
//   const { makeSkip3 } = require('../helpers/report');
//   // after findings and record are defined:
//   const skip3 = makeSkip3(findings);
//   // then instead of:
//   //   record(l, false, 'puppeteer not installed — all probes skipped')
//   // write:
//   //   skip3(l, 'puppeteer not installed — all probes skipped')
//
// The findings entry produced by both helpers has skipped: true.
// writeReport must render it as SKIP rather than FAIL:
//
//   f.ok ? 'PASS' : f.skipped ? 'SKIP' : 'FAIL'
//
// The summary should count and report skipped entries separately from failures:
//
//   const passed  = findings.filter(f => f.ok).length;
//   const skipped = findings.filter(f => f.skipped).length;
//   const failed  = findings.filter(f => !f.ok && !f.skipped).length;

/**
 * Returns a skip() function bound to the caller's findings array.
 * Intended for suites that use the 4/5-arg record() convention:
 *   record(name, expected, observed, ok, detail = '')
 *
 * skip(name, expected, reason) pushes a skipped finding and logs a – line.
 */
function makeSkip(findings) {
  return function skip(name, expected, reason) {
    findings.push({ name, expected, observed: reason, ok: false, skipped: true, detail: '' });
    console.log(`  –  ${name}`);
    console.log(`     skipped  : ${reason}`);
  };
}

/**
 * Returns a skip() function bound to the caller's findings array.
 * Intended for suites that use the 3-arg record() convention:
 *   record(id, ok, detail)
 *
 * skip(id, reason) pushes a skipped finding and logs a – line.
 */
function makeSkip3(findings) {
  return function skip(id, reason) {
    findings.push({ id, ok: false, skipped: true, detail: reason });
    console.log(`  –  ${id}`);
    console.log(`     skipped  : ${reason}`);
  };
}

module.exports = { makeSkip, makeSkip3 };
