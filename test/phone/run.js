'use strict';
/**
 * test/phone/run.js
 *
 * Unit tests for shared/phone.cjs — normalizePhone and formatPhone.
 *
 * Usage:
 *   node test/phone/run.js
 *
 * No database or server required.
 */

const path = require('path');
const { normalizePhone, formatPhone } = require(path.join(__dirname, '..', '..', 'shared', 'phone.cjs'));

const findings = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${id} — ${detail}`);
}

function assert(id, actual, expected) {
  const ok = actual === expected;
  record(id, ok, ok ? `"${actual}"` : `expected "${expected}", got "${actual}"`);
}

// ── normalizePhone ────────────────────────────────────────────────────────────

// UK mobile — national format with spaces → E.164
assert(
  'normalizePhone.uk-mobile-spaced',
  normalizePhone('07902 819990', 'GB'),
  '+447902819990',
);

// UK mobile — compact national format → E.164
assert(
  'normalizePhone.uk-mobile-compact',
  normalizePhone('07902819990', 'GB'),
  '+447902819990',
);

// UK landline — national format → E.164
assert(
  'normalizePhone.uk-landline',
  normalizePhone('020 7946 0000', 'GB'),
  '+442079460000',
);

// Already E.164 → returned as-is (unchanged E.164 string)
assert(
  'normalizePhone.already-e164',
  normalizePhone('+447902819990', 'GB'),
  '+447902819990',
);

// International number (Irish mobile) — no defaultCountry override needed
assert(
  'normalizePhone.international-ie',
  normalizePhone('+353 87 123 4567', 'GB'),
  '+353871234567',
);

// Invalid — too short → null
assert(
  'normalizePhone.invalid-too-short',
  normalizePhone('1234', 'GB'),
  null,
);

// Invalid — gibberish → null
assert(
  'normalizePhone.invalid-gibberish',
  normalizePhone('not a number', 'GB'),
  null,
);

// Empty string → null
assert(
  'normalizePhone.empty-string',
  normalizePhone('', 'GB'),
  null,
);

// Null input → null
assert(
  'normalizePhone.null-input',
  normalizePhone(null, 'GB'),
  null,
);

// Undefined input → null
assert(
  'normalizePhone.undefined-input',
  normalizePhone(undefined, 'GB'),
  null,
);

// Whitespace only → null
assert(
  'normalizePhone.whitespace-only',
  normalizePhone('   ', 'GB'),
  null,
);

// ── formatPhone ───────────────────────────────────────────────────────────────

// E.164 UK mobile → international display form
assert(
  'formatPhone.uk-mobile-e164',
  formatPhone('+447902819990'),
  '+44 7902 819990',
);

// E.164 UK landline → international display form
assert(
  'formatPhone.uk-landline-e164',
  formatPhone('+442079460000'),
  '+44 20 7946 0000',
);

// E.164 Irish mobile → international display form
assert(
  'formatPhone.irish-mobile-e164',
  formatPhone('+353871234567'),
  '+353 87 123 4567',
);

// Non-E.164 but parseable national format → international form
assert(
  'formatPhone.national-format',
  formatPhone('+447902819990'),
  '+44 7902 819990',
);

// Null → empty string
assert(
  'formatPhone.null',
  formatPhone(null),
  '',
);

// Empty string → empty string
assert(
  'formatPhone.empty',
  formatPhone(''),
  '',
);

// Unparseable string → returned as-is
assert(
  'formatPhone.unparseable',
  formatPhone('not-a-phone'),
  'not-a-phone',
);

// ── Summary ───────────────────────────────────────────────────────────────────

const passed = findings.filter(f => f.ok).length;
const failed = findings.filter(f => !f.ok).length;
console.log(`\n  ${passed} passed, ${failed} failed`);

if (failed > 0) process.exit(1);
