'use strict';
// test/places-autocomplete-ui/run.js
//
// Browser smoke-test: verifies the postcode-first Google Places autocomplete
// UI loads and functions correctly on the customer-info form page.
//
// Probes:
//   (PAC-1) Postcode-first search box renders within 15 s (Maps JS loaded)
//   (PAC-2) Typing a UK postcode produces autocomplete suggestions
//   (PAC-3) Selecting a suggestion fills the Postcode and Town/City fields
//
// Prerequisites (test skips gracefully when absent):
//   - puppeteer installed
//   - GOOGLE_PLACES_API_KEY env var present
//
// Overrides used:
//   PRIVTEST_USE_GOOGLE_PLACES_API_KEY=1  — passes the key through spawnServer
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:places-autocomplete-ui
//   PRIVTEST_ALLOW_SHARED_DB=1            npm run test:places-autocomplete-ui

const crypto = require('crypto');
const { Pool } = require('pg');
const { pollUntil } = require('../helpers/poll');
const { makeSkip3 } = require('../helpers/report');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

// Probe registry — kept in sync with the docs/TEST_SUITES.md row for this
// suite.  check-suite-probe-counts.mjs validates both directions.
const PROBE_LABELS = [
  '(PAC-1) postcode-first search box renders within 15 s — Maps JS loaded',
  '(PAC-2) typing a UK postcode produces autocomplete suggestions',
  '(PAC-3) selecting a suggestion fills the Postcode and Town/City fields',
];

require('dotenv').config();

const findings = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${id} — ${detail}`);
}
const skip = makeSkip3(findings);

// ── DB helpers ─────────────────────────────────────────────────────────────────

/**
 * Upsert google_maps_settings in app_settings so autocomplete is enabled
 * for the customerInfo surface. The test server reads this on every request,
 * so no restart is needed.
 */
async function enableGoogleMaps(pool) {
  const settings = {
    enabled: true,
    autocomplete: {
      countries: ['GB'],
      language: 'en-GB',
      types: 'address',
      debounceMs: 300,
      minChars: 2,
      sessionTokens: true,
    },
    surfaces: {
      customerInfo: { autocomplete: true, mapPreview: false },
      designVisit:  { autocomplete: true, mapPreview: false },
      arrangeVisit: { autocomplete: true, mapPreview: false },
      contactEdit:  { autocomplete: true, mapPreview: false },
      genericVisit: { autocomplete: true, mapPreview: false },
    },
    mapPreview: { enabled: false, zoom: 15, mapType: 'roadmap' },
    fallback:   { mode: 'silent', allowManualEntry: true },
  };
  await pool.query(
    `INSERT INTO app_settings (key, value)
     VALUES ('google_maps_settings', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(settings)],
  );
}

/**
 * Insert a live (non-expired, non-submitted) customer_info_submissions row
 * directly into the DB so we can browse to the public form without needing a
 * running mock HubSpot or a real card-action POST.
 *
 * Returns the raw (unhashed) token to use as the URL path segment.
 */
async function insertLiveToken(pool, runId) {
  const rawToken  = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const contactId = String(990000000 + Math.floor(Math.random() * 9999999));

  await pool.query(
    `INSERT INTO customer_info_submissions
       (contact_id, contact_name, contact_email, token_hash, expires_at,
        masked_email, masked_phone, form_link)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      contactId,
      `PlacesTest ${runId}`,
      `places-test-${runId}@privtest.local`,
      tokenHash,
      expiresAt,
      `p***@***.local`,
      '07***0001',
      `http://ignored/customer-info/${rawToken}`,
    ],
  );

  return { rawToken, contactId };
}

async function cleanupToken(pool, contactId) {
  try {
    await pool.query(
      `DELETE FROM customer_info_submissions WHERE contact_id = $1`,
      [contactId],
    );
  } catch {}
}

// ── Puppeteer helper ──────────────────────────────────────────────────────────

/**
 * Find the <input> element whose associated <label> contains the given text.
 * Returns the input element, or null if not found.
 * Runs inside page.evaluate — no closures over Node variables.
 */
function findInputByLabel(labelText) {
  const labels = Array.from(document.querySelectorAll('label'));
  const label = labels.find(l => l.textContent.trim().includes(labelText));
  if (!label) return null;
  if (label.htmlFor) return document.getElementById(label.htmlFor);
  return label.querySelector('input') || label.closest('.MuiFormControl-root')?.querySelector('input');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const hasTestDb   = !!process.env.DATABASE_URL_TEST;
  const allowShared = process.env.PRIVTEST_ALLOW_SHARED_DB === '1';
  const connStr     = process.env.DATABASE_URL_TEST || process.env.DATABASE_URL;

  if (!connStr) {
    console.error('DATABASE_URL_TEST (preferred) or DATABASE_URL is required.');
    process.exit(2);
  }
  if (!hasTestDb && !allowShared) {
    console.error(
      '\n  ✘ Refuses to run against the shared DATABASE_URL by default.\n'
      + '    Set DATABASE_URL_TEST=<disposable> or PRIVTEST_ALLOW_SHARED_DB=1.\n',
    );
    process.exit(2);
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY || '';
  const runId  = Math.random().toString(36).slice(2, 8);

  console.log(`\n  places-autocomplete-ui  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const ALL_PROBE_IDS = ['PAC-1.search-box-renders', 'PAC-2.suggestions-appear', 'PAC-3.fields-filled'];

  // Skip all probes gracefully when puppeteer is absent or key is missing.
  if (!puppeteer) {
    for (const l of ALL_PROBE_IDS) skip(l, 'skipped — puppeteer not installed');
    return summarise();
  }
  if (!apiKey) {
    for (const l of ALL_PROBE_IDS) skip(l, 'skipped — GOOGLE_PLACES_API_KEY not set');
    return summarise();
  }

  const pool = new Pool({ connectionString: connStr });
  let contactId = null;

  const harness = require('../privileges/harness');
  const { spawnServer, waitForServer, cleanupTestData, resetRateLimitStore, TEST_PORT } = harness;
  const BASE = `http://127.0.0.1:${TEST_PORT}`;
  harness.setPool(pool);

  // Insert google_maps_settings and a live token before spawning the server so
  // any table-wait is unnecessary (the server creates the schema on boot).
  await cleanupTestData(pool);
  await resetRateLimitStore(pool);

  // Enable google maps in the DB settings.
  try {
    await enableGoogleMaps(pool);
    console.log('  google_maps_settings: enabled=true');
  } catch (e) {
    // The app_settings table may not exist yet (fresh isolated DB — migrations
    // run on server boot). We'll retry after the server is up.
    console.log(`  google_maps_settings: will enable after server boot (${e.message})`);
  }

  const { child } = spawnServer({
    extraEnv: {
      GOOGLE_PLACES_API_KEY: apiKey,
      // Disable SMTP so missing mail config doesn't crash the server.
      SMTP_HOST: '', SMTP_PORT: '', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '',
      // Suppress HubSpot calls — customer-info public form doesn't need them.
      HUBSPOT_API_BASE_OVERRIDE: '',
    },
  });

  try {
    await waitForServer();
    console.log('  test server up');

    // Retry enabling google_maps after the server has run migrations.
    try {
      await enableGoogleMaps(pool);
    } catch {}

    // Insert a live submission token.
    const tokenResult = await insertLiveToken(pool, runId);
    contactId = tokenResult.contactId;
    const rawToken = tokenResult.rawToken;
    const formUrl  = `${BASE}/customer-info/${rawToken}`;

    console.log(`  form URL: ${formUrl}`);

    // ── Launch Puppeteer ──────────────────────────────────────────────────────
    const { findChromium } = require('../shared/find-chromium');
    const executablePath = findChromium() || undefined;
    let browser;

    try {
      browser = await puppeteer.launch({
        headless: true,
        executablePath,
        defaultViewport: { width: 1280, height: 900 },
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
    } catch (e) {
      for (const l of ALL_PROBE_IDS) skip(l, `skipped — browser launch failed: ${e.message}`);
      return summarise();
    }

    let page;
    try {
      page = await browser.newPage();
      await page.setCacheEnabled(false);

      // Capture console errors for diagnostics.
      const consoleErrors = [];
      page.on('console', msg => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });

      await page.goto(formUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // ── PAC-1: postcode-first search box renders ─────────────────────────
      // The "Enter your postcode or address" label only appears when:
      //   1. The React bundle is evaluated
      //   2. /api/google-maps/config returns enabled=true with an apiKey
      //   3. Google Maps JS loads from the CDN (importLibrary succeeds)
      //   4. autocomplete is enabled for the customerInfo surface
      //
      // We give it 15 seconds because the Maps JS CDN can be slow.
      const SEARCH_LABEL = 'Enter your postcode or address';

      const pac1Found = await pollUntil(
        page,
        (labelText) => {
          const labels = Array.from(document.querySelectorAll('label'));
          return labels.some(l => l.textContent.trim().includes(labelText)) ? 'found' : null;
        },
        15000,
        250,
        [SEARCH_LABEL],
      );

      record('PAC-1.search-box-renders',
        !!pac1Found,
        pac1Found
          ? `"${SEARCH_LABEL}" label appeared — Maps JS loaded successfully`
          : `"${SEARCH_LABEL}" label did NOT appear within 15 s — Maps JS failed to load`
          + (consoleErrors.length ? `; console errors: ${consoleErrors.slice(0, 3).join(' | ')}` : ''),
      );

      if (!pac1Found) {
        // If PAC-1 failed, the remaining probes cannot run.
        skip('PAC-2.suggestions-appear', 'skipped — PAC-1 failed (search box never appeared)');
        skip('PAC-3.fields-filled',      'skipped — PAC-1 failed (search box never appeared)');
        return summarise();
      }

      // ── PAC-2: typing a postcode produces suggestions ────────────────────
      // Find the input by its label, type a UK postcode fragment, wait for
      // the MUI Autocomplete listbox (role="listbox") to appear with options.
      await page.evaluate((labelText) => {
        const labels = Array.from(document.querySelectorAll('label'));
        const label  = labels.find(l => l.textContent.trim().includes(labelText));
        if (!label) return;
        const input = label.htmlFor
          ? document.getElementById(label.htmlFor)
          : (label.querySelector('input') || label.closest('.MuiFormControl-root')?.querySelector('input'));
        if (input) input.focus();
      }, SEARCH_LABEL);

      await page.keyboard.type('SW1A 1', { delay: 80 });

      // Wait for suggestions (MUI Autocomplete renders a listbox when open).
      const pac2Found = await pollUntil(
        page,
        () => {
          const lb = document.querySelector('[role="listbox"]');
          if (!lb) return null;
          const opts = lb.querySelectorAll('[role="option"]');
          return opts.length > 0 ? opts.length : null;
        },
        15000,
        250,
      );

      record('PAC-2.suggestions-appear',
        !!pac2Found,
        pac2Found
          ? `${pac2Found} autocomplete suggestion(s) appeared`
          : 'No autocomplete suggestions appeared within 15 s after typing "SW1A 1"',
      );

      if (!pac2Found) {
        skip('PAC-3.fields-filled', 'skipped — PAC-2 failed (no suggestions appeared)');
        return summarise();
      }

      // ── PAC-3: selecting a suggestion fills Postcode and Town/City ───────
      // Click the first option in the listbox.
      await page.evaluate(() => {
        const lb  = document.querySelector('[role="listbox"]');
        const opt = lb && lb.querySelector('[role="option"]');
        if (opt) opt.click();
      });

      // Wait for the individual Postcode and Town / City inputs to be filled.
      // These are rendered by the AddressInput component after selection resolves
      // place details. Give it 10 s for the Details API round-trip.
      const pac3Result = await pollUntil(
        page,
        () => {
          const labels = Array.from(document.querySelectorAll('label'));

          // Use includes() not === because MUI required TextFields append
          // an asterisk to the visible label text (e.g. "Postcode *").
          function inputValueFor(labelText) {
            const label = labels.find(l => l.textContent.trim().includes(labelText));
            if (!label) return '';
            const input = label.htmlFor
              ? document.getElementById(label.htmlFor)
              : (label.querySelector('input') || label.closest('.MuiFormControl-root')?.querySelector('input'));
            return input ? input.value.trim() : '';
          }

          const postcode = inputValueFor('Postcode');
          const town     = inputValueFor('Town / City');
          if (postcode && town) return { postcode, town };
          return null;
        },
        10000,
        250,
      );

      record('PAC-3.fields-filled',
        !!pac3Result,
        pac3Result
          ? `Postcode="${pac3Result.postcode}" Town="${pac3Result.town}" filled after selection`
          : 'Postcode and/or Town/City were not filled within 10 s after selecting a suggestion',
      );

    } finally {
      if (page)    await page.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    }

  } finally {
    if (contactId) await cleanupToken(pool, contactId);
    child.kill();
    await pool.end().catch(() => {});
    // Derive exit code from findings so any failed probe (including PAC-3
    // which does not return early) causes a non-zero exit.
    summarise();
    process.exit(findings.some(f => !f.ok && !f.skipped) ? 1 : 0);
  }
}

function summarise() {
  const passed  = findings.filter(f => f.ok).length;
  const skipped = findings.filter(f => f.skipped).length;
  const failed  = findings.filter(f => !f.ok && !f.skipped).length;
  console.log(`\n  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
