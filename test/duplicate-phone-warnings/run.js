'use strict';
const { makeSkip } = require('../helpers/report');

const PROBE_LABELS = [
  'TEAM: seeded allowed-list row renders in #tab-team',
  'TEAM: duplicate-phone Alert appears with the existing record name',
  'TEAM: "Add team member" button is disabled while phone duplicate stands',
  'TEAM: alert exposes a "View approved entry" action button',
  'TEAM: clicking the action highlights the existing approved-list row',
  'TEAM: clearing the phone field removes the duplicate-phone Alert',
  'TEAM: "Add team member" button is re-enabled after clearing the duplicate phone',
  'TEAM: duplicate-email Alert appears when seeded email is typed',
  'TEAM: "Add team member" button is disabled while email duplicate stands',
  'TEAM: clearing the email field removes the duplicate-email Alert',
  'TEAM: "Add team member" button is re-enabled after clearing the duplicate email',
  'TRADES: /trades page loads at least the seeded companies',
  'TRADES: openTradesModal() opens the modal with a contact slot',
  'TRADES: #tf-cphone-notice-0 shows the duplicate warning naming the existing contact at company A',
  'TRADES: #trades-submit-btn is disabled while the contact-phone duplicate stands',
  'TRADES: #tf-cphone-notice-0 hides after duplicate contact-phone number is cleared',
  'TRADES: #trades-submit-btn re-enables after duplicate contact-phone number is cleared',
  'TRADES: clicking the notice link opens the existing record in Edit mode',
  'TRADES ADD CO-PHONE: /trades page loads at least the seeded companies',
  'TRADES ADD CO-PHONE: openTradesModal() opens the modal with #tf-company-phone',
  'TRADES ADD CO-PHONE: #tf-company-phone-notice shows the duplicate warning naming Company A',
  'TRADES ADD CO-PHONE: #trades-submit-btn is disabled while company-phone duplicate stands',
  'TRADES ADD CO-PHONE: #tf-company-phone-notice hides after duplicate number is cleared',
  'TRADES ADD CO-PHONE: #trades-submit-btn re-enables after duplicate company-phone is cleared',
];

// test/duplicate-phone-warnings/run.js
//
// End-to-end live test for the duplicate-phone inline warnings.
//
//   (TEAM) src/react/pages/admin/AdminTeamPage.tsx — typing a phone number
//          into the "Add team member" Mobile or Emergency-contact field
//          shows an MUI Alert that names the existing record, exposes a
//          "View approved entry" / "Open team member" action, and disables
//          the Add team member button.
//
//   (TRADES) public/trades.js — typing a phone number into the Trades modal
//          Company-phone (or a contact phone) input shows the inline notice
//          (#tf-company-phone-notice / #tf-cphone-notice-N), exposes a link
//          to the existing company, and disables #trades-submit-btn.
//          This includes both Add mode and Edit mode for contact-phone slots.
//
// Mirrors the shape of test/lead-status-sync/run.js — boot a disposable
// server via the privileges harness, drive the UI with Puppeteer, write a
// markdown report to test-results/duplicate-phone-warnings.md, exit
// non-zero on failure.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:duplicate-phone-warnings
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:duplicate-phone-warnings

const fs   = require('fs');
const http = require('http');
const path = require('path');
const { Pool } = require('pg');

const {
  spawnServer,
  waitForServer,
  seedUsers,
  cleanupTestData,
  resetRateLimitStore,
  login,
  setPool,
  PASSWORD,
  BASE,
} = require('../privileges/harness');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

require('dotenv').config();

const { pollUntil } = require('../helpers/poll');

// ── fixtures ──────────────────────────────────────────────────────────────────
// The phone duplicate check matches the last 9 digits, so we derive
// per-run-unique numbers from the runId to avoid colliding with real
// phone numbers when running against the shared DB.
function uniqueDigits(runId, prefix) {
  const h = require('crypto').createHash('sha256').update(`${prefix}:${runId}`).digest('hex');
  // 9 decimal digits, padded.
  const n = parseInt(h.slice(0, 12), 16) % 1_000_000_000;
  return String(n).padStart(9, '0');
}
const TEAM_DUP_EMAIL     = 'privtest-dupphone-team@privtest.local';
const TEAM_DUP_FIRST     = 'PrivTest';
const TEAM_DUP_LAST      = 'DupPhoneTeam';

const TRADES_COMPANY_A   = 'PrivTest Dup-Phone Co A';
const TRADES_COMPANY_B   = 'PrivTest Dup-Phone Co B';

const CUSTOMER_LABEL     = 'PrivTest Customer Phone';
const CUSTOMER_CONTACT_ID = 'privtest-dupphone-cust-001';

// ── mock HubSpot server ───────────────────────────────────────────────────────
// Minimal mock that serves POST /crm/v3/objects/contacts/search so
// getSharedContactsCache() (used by GET /api/admin/phone-directory) returns
// a seeded customer with CUSTOMER_DUP_PHONE.  All other endpoints return {}.
function startMockHubspot(customerPhone, contactId, label) {
  const [firstname, ...rest] = (label || 'PrivTest Customer').split(' ');
  const lastname = rest.join(' ') || '';
  const fixture = {
    id: contactId,
    properties: {
      firstname,
      lastname,
      email: `${contactId}@privtest.invalid`,
      phone: customerPhone,
      mobilephone: '',
    },
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const url = req.url.split('?')[0];
      if (req.method === 'POST' && url === '/crm/v3/objects/contacts/search') {
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch {}
        const requestedProps = Array.isArray(body.properties) ? body.properties : [];
        const props = fixture.properties || {};
        const filteredProps = requestedProps.length > 0
          ? Object.fromEntries(requestedProps.map(p => [p, props[p] ?? '']))
          : props;
        const result = { id: fixture.id, properties: filteredProps };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ results: [result], paging: null }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({}));
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

// ── helpers ───────────────────────────────────────────────────────────────────
function parseCookieKV(jar) {
  if (!jar) return null;
  const idx = jar.indexOf('=');
  if (idx < 0) return null;
  return { name: jar.slice(0, idx), value: jar.slice(idx + 1) };
}

async function injectSession(page, jar) {
  const kv = parseCookieKV(jar);
  if (!kv) return;
  const { hostname } = new URL(BASE);
  await page.setCookie({
    name: kv.name, value: kv.value,
    domain: hostname, path: '/', httpOnly: true,
  });
}

async function purgeFixtures(pool) {
  // Trade companies (cascades to trade_company_contacts + trade_audit_log).
  try {
    await pool.query(
      `DELETE FROM trade_companies WHERE company_name IN ($1, $2)`,
      [TRADES_COMPANY_A, TRADES_COMPANY_B],
    );
  } catch (_) {}
  // Duplicate-team allowed-list seed (also covered by privtest- prefix cleanup).
  try {
    await pool.query(`DELETE FROM allowed_emails WHERE email = $1`, [TEAM_DUP_EMAIL]);
  } catch (_) {}
}

async function pollPage(page, fn, arg, timeoutMs = 6000, intervalMs = 100) {
  const evalArgs = arg !== undefined && arg !== null ? [arg] : [];
  const result = await pollUntil(page, fn, timeoutMs, intervalMs, evalArgs);
  if (result !== null) return result;
  return page.evaluate(fn, ...evalArgs);
}

// MUI <TextField> wraps a native <input>, but typing into it via
// `page.type()` requires focusing the inner input. The Mobile-number field
// has no stable id, so we locate it by its visible label.
async function typeInMuiField(page, labelText, value) {
  await page.evaluate((label) => {
    const labels = Array.from(document.querySelectorAll('label'));
    const lab = labels.find(l => (l.textContent || '').trim() === label);
    if (!lab) throw new Error('label not found: ' + label);
    // The label's `for` points at the wrapped input id.
    const inputId = lab.getAttribute('for');
    const input = inputId ? document.getElementById(inputId) : null;
    if (!input) throw new Error('input not found for label: ' + label);
    // Use the native value setter so React's onChange fires.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, labelText);

  await page.evaluate((label, val) => {
    const labels = Array.from(document.querySelectorAll('label'));
    const lab = labels.find(l => (l.textContent || '').trim() === label);
    const input = document.getElementById(lab.getAttribute('for'));
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, val);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, labelText, value);
}

async function setNativeInputValue(page, selector, value) {
  await page.evaluate((sel, val) => {
    const input = document.querySelector(sel);
    if (!input) throw new Error('input not found: ' + sel);
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(input, val);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, selector, value);
}

// setDialogInput — sets a value in a React MUI Dialog (portal) input using
// real Puppeteer keyboard events.  Native DOM events dispatched via
// page.evaluate don't propagate through React 18's root-level delegation when
// the input lives in a Portal (i.e. rendered outside the React root container).
// Keyboard events generated by Puppeteer fire through the browser's own event
// pipeline and correctly trigger React's onChange handler.
async function setDialogInput(page, selector, value) {
  // Triple-click selects any existing text; then type replaces it (or clears
  // if value is empty via Backspace).
  await page.click(selector, { clickCount: 3 });
  if (value === '') {
    await page.keyboard.press('Backspace');
  } else {
    await page.type(selector, value);
  }
}

// ── main ──────────────────────────────────────────────────────────────────────
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

  // The React bundle drives the admin Team page.
  const bundlePath = path.resolve(__dirname, '..', '..', 'public', 'react', 'main.js');
  if (!fs.existsSync(bundlePath)) {
    console.error('\n  ✘ public/react/main.js is missing — run `npm run build:react` first.\n');
    process.exit(2);
  }

  const runId = Math.random().toString(36).slice(2, 8);
  const TEAM_DUP_PHONE    = '0' + uniqueDigits(runId, 'team');      // 10 digits
  const TRADES_DUP_PHONE  = '0' + uniqueDigits(runId, 'trades');    // 10 digits
  const TRADES_CO_PHONE   = '0' + uniqueDigits(runId, 'trades-co'); // 10 digits — for company-phone conflict
  const CUSTOMER_DUP_PHONE = '0' + uniqueDigits(runId, 'customer'); // 10 digits — for customer cross-section conflict
  console.log(`\n  duplicate-phone-warnings E2E  run=${runId}`);
  console.log(`  Phones  team=${TEAM_DUP_PHONE}  trades=${TRADES_DUP_PHONE}  trades-co=${TRADES_CO_PHONE}  customer=${CUSTOMER_DUP_PHONE}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);
  await purgeFixtures(pool);

  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  admin=${users.admin.email}`);

  // Start a mock HubSpot server so the phone-directory customers section is
  // populated with the seeded customer.  This lets the Trades modal show a
  // cross-section conflict when the user types CUSTOMER_DUP_PHONE.
  const mockHubspot = await startMockHubspot(CUSTOMER_DUP_PHONE, CUSTOMER_CONTACT_ID, CUSTOMER_LABEL);
  console.log(`  Mock HubSpot on http://127.0.0.1:${mockHubspot.port}`);

  const { child, logBuf } = spawnServer({
    extraEnv: {
      HUBSPOT_TOKEN:  'privtest-mock-hs-token',
      HUBSPOT_API_URL: `http://127.0.0.1:${mockHubspot.port}`,
    },
  });
  let exited = false;
  child.on('exit', () => { exited = true; });

  const findings = [];
  function record(name, expected, observed, ok, detail = '') {
    findings.push({ name, expected, observed, ok, detail });
    const mark = ok ? '  ✓' : '  ✗';
    console.log(`${mark}  ${name}`);
    if (!ok) {
      console.log(`     expected : ${expected}`);
      console.log(`     observed : ${observed}`);
      if (detail) console.log(`     detail   : ${detail}`);
    }
  }
  const skip = makeSkip(findings);

  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try { mockHubspot.server.close(); } catch {}
    try {
      await purgeFixtures(pool);
      await cleanupTestData(pool);
    } catch {}
    await pool.end().catch(() => {});
    process.exit(code);
  };

  process.on('SIGINT',  () => cleanupAndExit(130));
  process.on('SIGTERM', () => cleanupAndExit(130));
  process.on('uncaughtException',  (e) => { console.error('Uncaught:', e);  cleanupAndExit(2); });
  process.on('unhandledRejection', (e) => { console.error('Unhandled:', e); cleanupAndExit(2); });

  try {
    await waitForServer();
    await resetRateLimitStore(pool);
    console.log(`  Server up at ${BASE}`);
  } catch (e) {
    console.error('Server boot failed:', e.message);
    console.error(logBuf.join('').slice(-2000));
    await cleanupAndExit(2);
    return;
  }

  // ── seed fixtures via API + DB ────────────────────────────────────────────
  const adminClient = await login(users.admin.email, PASSWORD);

  // (TEAM seed) An allowed_emails row with metadata.mobile_number = TEAM_DUP_PHONE.
  // The Add-team-member duplicate check scans both `users` and `allowed`.
  await pool.query(
    `INSERT INTO allowed_emails (email, note, metadata)
     VALUES ($1, 'priv-test dup-phone seed', $2::jsonb)
     ON CONFLICT (email) DO UPDATE SET metadata = EXCLUDED.metadata`,
    [TEAM_DUP_EMAIL, JSON.stringify({
      first_name: TEAM_DUP_FIRST,
      last_name:  TEAM_DUP_LAST,
      mobile_number: TEAM_DUP_PHONE,
    })],
  );

  // (TRADES seed) Two companies, each with a contact. Company A's contact
  // carries the duplicated phone — the test then types the same phone into
  // a contact-row input on the Add-Company modal and asserts the per-slot
  // notice fires (i.e. the warning fires across contact rows of different
  // companies, matching the stated scope of the duplicate-phone warning feature).
  const TRADE_A_CONTACT = 'PrivTest Contact A';
  const TRADE_B_CONTACT = 'PrivTest Contact B';
  const seedTrade = async (name, contactName, contactPhone) => {
    const r = await adminClient.post('/api/trades', {
      company_name: name,
      trade_type: 'Electrical',
      areas_served: [],
      timescale: '',
      notes: '',
      website: '',
      company_phone: '',
      contacts: [{ name: contactName, role: '', phone: contactPhone, email: '', preferred_contact: 'Phone' }],
    });
    if (r.status !== 201) throw new Error(`seed trade ${name} failed: ${r.status} ${r.text}`);
    return r.json;
  };
  const tradeA = await seedTrade(TRADES_COMPANY_A, TRADE_A_CONTACT, TRADES_DUP_PHONE);
  // Patch Company A's company_phone so the Edit-mode company-phone test has a conflict source.
  await adminClient.put(`/api/trades/${tradeA.id}`, {
    company_name: TRADES_COMPANY_A,
    trade_type: 'Electrical',
    areas_served: [],
    timescale: '',
    notes: '',
    website: '',
    company_phone: TRADES_CO_PHONE,
    contacts: [{ name: TRADE_A_CONTACT, role: '', phone: TRADES_DUP_PHONE, email: '', preferred_contact: 'Phone' }],
  });
  const tradeB = await seedTrade(TRADES_COMPANY_B, TRADE_B_CONTACT, '');
  console.log(`  Seeded trades  A=${tradeA.id} B=${tradeB.id}`);

  // ── API pre-checks ────────────────────────────────────────────────────────
  {
    const r = await adminClient.get('/api/admin/allowed');
    const hit = Array.isArray(r.json)
      && r.json.some(a => (a.email || '').toLowerCase() === TEAM_DUP_EMAIL
        && a.metadata && a.metadata.mobile_number === TEAM_DUP_PHONE);
    record(
      'API: GET /api/admin/allowed includes the seeded duplicate-phone row',
      `entry for ${TEAM_DUP_EMAIL} with metadata.mobile_number=${TEAM_DUP_PHONE}`,
      `status=${r.status} found=${hit}`,
      hit,
    );
  }
  {
    const r = await adminClient.get('/api/trades');
    const aHasContactPhone = Array.isArray(r.json)
      && r.json.some(c => c.id === tradeA.id
        && Array.isArray(c.contacts)
        && c.contacts.some(ct => ct.phone === TRADES_DUP_PHONE));
    const bothPresent = Array.isArray(r.json)
      && r.json.some(c => c.id === tradeA.id)
      && r.json.some(c => c.id === tradeB.id);
    record(
      'API: GET /api/trades returns both seeded companies (A with duplicated contact phone)',
      `A=${TRADES_COMPANY_A} contact.phone=${TRADES_DUP_PHONE}, B=${TRADES_COMPANY_B} present`,
      `status=${r.status} bothPresent=${bothPresent} aHasContactPhone=${aHasContactPhone}`,
      bothPresent && aHasContactPhone,
    );
  }
  {
    const r = await adminClient.get('/api/admin/phone-directory');
    const custHit = r.status === 200
      && r.json
      && Array.isArray(r.json.customers)
      && r.json.customers.some(c =>
          String(c.contactId) === CUSTOMER_CONTACT_ID
          && c.phone === CUSTOMER_DUP_PHONE
          && c.label === CUSTOMER_LABEL,
        );
    record(
      'API: GET /api/admin/phone-directory includes the seeded customer entry',
      `customers entry contactId=${CUSTOMER_CONTACT_ID} phone=${CUSTOMER_DUP_PHONE} label="${CUSTOMER_LABEL}"`,
      `status=${r.status} found=${custHit}`,
      custHit,
    );
  }

  // ── Puppeteer ─────────────────────────────────────────────────────────────
  if (!puppeteer) {
    for (const l of PROBE_LABELS) {
      skip(l, 'puppeteer installed', 'puppeteer not installed');
    }
    await writeReport(runId, findings);
    await cleanupAndExit(1);
    return;
  }

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
    for (const l of PROBE_LABELS) {
      skip(l, 'browser launched', `browser launch failed: ${e.message}`);
    }
    await writeReport(runId, findings);
    await cleanupAndExit(1);
    return;
  }

  try {
    // ── (TEAM) admin /admin → Team tab → Add team member ───────────────────
    {
      const page = await browser.newPage();
      await page.setCacheEnabled(false);
      page.on('pageerror', (e) => console.log('    [team pageerror]', String(e).slice(0, 200)));
      await injectSession(page, adminClient.cookie);
      await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded', timeout: 20000 });

      // Allow the React island to mount + the Team page to fetch data.
      await page.evaluate(() => {
        if (typeof window.switchTab === 'function') window.switchTab('team');
      });

      // Wait until the seeded allowed-row has been rendered (proves the
      // page's `allowed` state list contains the duplicate row).
      const seedRowRendered = await pollPage(page, (email) => {
        return !!document.querySelector(`[data-allowed-email="${email}"]`);
      }, TEAM_DUP_EMAIL, 10000);
      record(
        'TEAM: seeded allowed-list row renders in #tab-team',
        `[data-allowed-email="${TEAM_DUP_EMAIL}"] present`,
        `rendered=${!!seedRowRendered}`,
        !!seedRowRendered,
      );

      // Type the duplicate phone into the *Personal details* Mobile number
      // field. There are two "Mobile number" labels in the form (Personal +
      // Emergency contact); we use the first one (Personal details).
      await page.evaluate((val) => {
        const labels = Array.from(document.querySelectorAll('label'))
          .filter(l => (l.textContent || '').trim().startsWith('Mobile number'));
        if (!labels.length) throw new Error('no Mobile number label found');
        const inputId = labels[0].getAttribute('for');
        const input = inputId ? document.getElementById(inputId) : null;
        if (!input) throw new Error('Mobile number input not found');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, val);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, TEAM_DUP_PHONE);

      // 300ms debounce + a useMemo render tick.
      const alertText = await pollPage(page, () => {
        const alerts = Array.from(document.querySelectorAll('[role="alert"]'));
        const hit = alerts.find(a => /phone number is already in use/i.test(a.textContent || ''));
        return hit ? hit.textContent : null;
      }, null, 4000);
      const alertOk = !!alertText && /phone number is already in use/i.test(alertText)
        && new RegExp(TEAM_DUP_FIRST, 'i').test(alertText);
      record(
        'TEAM: duplicate-phone Alert appears with the existing record name',
        `MUI Alert containing "phone number is already in use" + "${TEAM_DUP_FIRST}"`,
        `text=${alertText ? JSON.stringify(alertText.slice(0, 160)) : 'null'}`,
        alertOk,
      );

      // Add-team-member button must be disabled while the duplicate stands.
      // We need an email in the form to be sure the email check isn't the
      // disabler. Type a fresh email first.
      await page.evaluate(() => {
        const labels = Array.from(document.querySelectorAll('label'));
        const lab = labels.find(l => (l.textContent || '').trim().startsWith('Work email address'));
        const input = lab ? document.getElementById(lab.getAttribute('for')) : null;
        if (input) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, 'privtest-newperson-' + Date.now() + '@privtest.local');
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });

      // Allow the email debounce to settle.
      await new Promise(r => setTimeout(r, 500));

      const submitDisabled = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => (b.textContent || '').trim() === 'Add team member'
                                  || (b.textContent || '').trim() === 'Adding…');
        return btn ? btn.disabled : null;
      });
      record(
        'TEAM: "Add team member" button is disabled while phone duplicate stands',
        'button.disabled === true',
        `disabled=${submitDisabled}`,
        submitDisabled === true,
      );

      // Click "View approved entry" inside the duplicate alert and verify
      // the allowed-list row gains the admin-row-flash highlight class.
      const clicked = await page.evaluate(() => {
        const alerts = Array.from(document.querySelectorAll('[role="alert"]'));
        const hit = alerts.find(a => /phone number is already in use/i.test(a.textContent || ''));
        if (!hit) return false;
        const btn = Array.from(hit.querySelectorAll('button'))
          .find(b => /View approved entry/i.test(b.textContent || ''));
        if (!btn) return false;
        btn.click();
        return true;
      });
      record(
        'TEAM: alert exposes a "View approved entry" action button',
        'button labelled "View approved entry" inside the duplicate alert',
        `clicked=${clicked}`,
        clicked,
      );

      const flashed = await pollPage(page, (email) => {
        const el = document.querySelector(`[data-allowed-email="${email}"]`);
        return !!(el && el.classList.contains('admin-row-flash'));
      }, TEAM_DUP_EMAIL, 2000);
      record(
        'TEAM: clicking the action highlights the existing approved-list row',
        `${TEAM_DUP_EMAIL} row has class "admin-row-flash"`,
        `flashed=${!!flashed}`,
        !!flashed,
      );

      // Clear the duplicate phone and verify the warning disappears and the
      // submit button becomes enabled again.
      await page.evaluate(() => {
        const labels = Array.from(document.querySelectorAll('label'))
          .filter(l => (l.textContent || '').trim().startsWith('Mobile number'));
        if (!labels.length) throw new Error('no Mobile number label found');
        const inputId = labels[0].getAttribute('for');
        const input = inputId ? document.getElementById(inputId) : null;
        if (!input) throw new Error('Mobile number input not found');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });

      const alertGone = await pollPage(page, () => {
        const alerts = Array.from(document.querySelectorAll('[role="alert"]'));
        const hit = alerts.find(a => /phone number is already in use/i.test(a.textContent || ''));
        return !hit;
      }, null, 4000);
      record(
        'TEAM: clearing the phone field removes the duplicate-phone Alert',
        'no MuiAlert-root containing "phone number is already in use"',
        `alertGone=${!!alertGone}`,
        !!alertGone,
      );

      const submitReEnabled = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => (b.textContent || '').trim() === 'Add team member'
                                  || (b.textContent || '').trim() === 'Adding…');
        return btn ? btn.disabled : null;
      });
      record(
        'TEAM: "Add team member" button is re-enabled after clearing the duplicate phone',
        'button.disabled === false',
        `disabled=${submitReEnabled}`,
        submitReEnabled === false,
      );

      // ── email duplicate: clear-and-recover ─────────────────────────────────
      // Type the seeded duplicate email into "Work email address" to trigger
      // the "This email is already on the allow-list" MUI Alert.
      await page.evaluate((dupEmail) => {
        const labels = Array.from(document.querySelectorAll('label'));
        const lab = labels.find(l => (l.textContent || '').trim().startsWith('Work email address'));
        const input = lab ? document.getElementById(lab.getAttribute('for')) : null;
        if (!input) throw new Error('Work email address input not found');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, dupEmail);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, TEAM_DUP_EMAIL);

      // Poll for the duplicate-email Alert (debounce + render tick).
      const emailAlertText = await pollPage(page, () => {
        const alerts = Array.from(document.querySelectorAll('[role="alert"]'));
        const hit = alerts.find(a => /This email is already on the allow-list/i.test(a.textContent || ''));
        return hit ? hit.textContent : null;
      }, null, 4000);
      record(
        'TEAM: duplicate-email Alert appears when seeded email is typed',
        'MUI Alert containing "This email is already on the allow-list"',
        `text=${emailAlertText ? JSON.stringify(emailAlertText.slice(0, 160)) : 'null'}`,
        !!emailAlertText && /This email is already on the allow-list/i.test(emailAlertText),
      );

      // Submit button must be disabled while the email duplicate stands.
      const emailSubmitDisabled = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => (b.textContent || '').trim() === 'Add team member'
                                  || (b.textContent || '').trim() === 'Adding…');
        return btn ? btn.disabled : null;
      });
      record(
        'TEAM: "Add team member" button is disabled while email duplicate stands',
        'button.disabled === true',
        `disabled=${emailSubmitDisabled}`,
        emailSubmitDisabled === true,
      );

      // Clear the email field and verify the Alert disappears.
      await page.evaluate(() => {
        const labels = Array.from(document.querySelectorAll('label'));
        const lab = labels.find(l => (l.textContent || '').trim().startsWith('Work email address'));
        const input = lab ? document.getElementById(lab.getAttribute('for')) : null;
        if (!input) throw new Error('Work email address input not found');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });

      const emailAlertGone = await pollPage(page, () => {
        const alerts = Array.from(document.querySelectorAll('[role="alert"]'));
        const hit = alerts.find(a => /This email is already on the allow-list/i.test(a.textContent || ''));
        return !hit;
      }, null, 4000);
      record(
        'TEAM: clearing the email field removes the duplicate-email Alert',
        'no MuiAlert-root containing "This email is already on the allow-list"',
        `alertGone=${!!emailAlertGone}`,
        !!emailAlertGone,
      );

      const emailSubmitReEnabled = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => (b.textContent || '').trim() === 'Add team member'
                                  || (b.textContent || '').trim() === 'Adding…');
        return btn ? btn.disabled : null;
      });
      record(
        'TEAM: "Add team member" button is re-enabled after clearing the duplicate email',
        'button.disabled === false',
        `disabled=${emailSubmitReEnabled}`,
        emailSubmitReEnabled === false,
      );

      await page.close();
    }

    // ── (TRADES) admin /trades → open modal → company-phone duplicate ──────
    {
      const page = await browser.newPage();
      await page.setCacheEnabled(false);
      page.on('pageerror', (e) => console.log('    [trades pageerror]', String(e).slice(0, 200)));
      await injectSession(page, adminClient.cookie);
      await page.goto(`${BASE}/trades`, { waitUntil: 'domcontentloaded', timeout: 20000 });

      // Wait for trades to load (_tradeContacts populated by loadTradesContacts).
      const loaded = await pollPage(page, () => {
        const list = window._cpGetTradeContacts && window._cpGetTradeContacts();
        return Array.isArray(list) && list.length >= 2;
      }, null, 8000);
      record(
        'TRADES: /trades page loads at least the seeded companies',
        '_cpGetTradeContacts() returns >=2 entries',
        `loaded=${!!loaded}`,
        !!loaded,
      );

      // Open the modal in "Add Company" mode (no id).  The Add mode seeds
      // one empty contact slot (index 0), which is the row we'll exercise.
      await pollPage(page, () => typeof window.openTradesModal === 'function', null, 8000);
      await page.evaluate(() => { window.openTradesModal(); });
      const modalOpen = await pollPage(page, () => {
        const m = document.getElementById('trades-modal');
        const slot = document.getElementById('tf-cphone-0');
        return !!(m && m.classList.contains('trades-modal-open') && slot);
      }, null, 2000);
      record(
        'TRADES: openTradesModal() opens the modal with a contact slot',
        '#trades-modal.trades-modal-open and #tf-cphone-0 present',
        `ready=${modalOpen}`,
        modalOpen,
      );

      // Type the duplicate phone into the *contact row* phone input (slot 0).
      // This exercises the per-slot conflict path
      // (findTradePhoneConflict → renderTradePhoneNotice via onTradePhoneInput).
      await setDialogInput(page, '#tf-cphone-0', TRADES_DUP_PHONE);

      // 300ms debounce.
      const noticeShown = await pollPage(page, () => {
        const n = document.getElementById('tf-cphone-notice-0');
        if (!n || n.classList.contains('hidden')) return null;
        const link = n.querySelector('.trades-phone-notice-link');
        return {
          text: (n.textContent || '').trim(),
          linkId: link ? link.getAttribute('data-trade-id') : null,
        };
      }, null, 3000);
      const noticeOk = !!noticeShown
        && /phone number is already in use/i.test(noticeShown.text)
        && new RegExp(TRADE_A_CONTACT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(noticeShown.text)
        && String(noticeShown.linkId) === String(tradeA.id);
      record(
        'TRADES: #tf-cphone-notice-0 shows the duplicate warning naming the existing contact at company A',
        `text mentions "${TRADE_A_CONTACT}" and "phone number is already in use", link data-trade-id=${tradeA.id}`,
        noticeShown ? `text=${JSON.stringify(noticeShown.text.slice(0, 180))} linkId=${noticeShown.linkId}` : 'no notice',
        noticeOk,
      );

      // Submit button must be disabled while the contact-phone duplicate
      // stands. updateTradesSubmitDisabled() sets a phone-conflict title.
      const submitState = await page.evaluate(() => {
        const btn = document.getElementById('trades-submit-btn');
        return btn ? { disabled: btn.disabled, title: btn.title || '' } : null;
      });
      record(
        'TRADES: #trades-submit-btn is disabled while the contact-phone duplicate stands',
        'submit-btn disabled with a phone-conflict title',
        submitState ? `disabled=${submitState.disabled} title=${JSON.stringify(submitState.title)}` : 'no button',
        !!(submitState && submitState.disabled === true && /phone/i.test(submitState.title)),
      );

      // Clear the duplicate number — use a unique value so there is no conflict.
      await setDialogInput(page, '#tf-cphone-0', '555-000-7777');

      // Notice must hide and submit button must re-enable.
      const noticeClearedAdd = await pollPage(page, () => {
        const n = document.getElementById('tf-cphone-notice-0');
        return n ? n.classList.contains('hidden') : true;
      }, false, 3000);
      record(
        'TRADES: #tf-cphone-notice-0 hides after duplicate contact-phone number is cleared',
        '#tf-cphone-notice-0 has class "hidden"',
        noticeClearedAdd ? 'notice hidden' : 'notice still visible',
        noticeClearedAdd === true,
      );

      const submitReenabledAdd = await page.evaluate(() => {
        const btn = document.getElementById('trades-submit-btn');
        return btn ? !btn.disabled : null;
      });
      record(
        'TRADES: #trades-submit-btn re-enables after duplicate contact-phone number is cleared',
        'submit-btn not disabled',
        submitReenabledAdd === null ? 'no button' : `disabled=${!submitReenabledAdd}`,
        submitReenabledAdd === true,
      );

      // Restore the duplicate so the click-link test below still works.
      await setDialogInput(page, '#tf-cphone-0', TRADES_DUP_PHONE);
      await pollPage(page, () => {
        const n = document.getElementById('tf-cphone-notice-0');
        return n && !n.classList.contains('hidden');
      }, false, 3000);

      // Click the link → modal should re-open in Edit mode for company A.
      await page.evaluate(() => {
        const link = document.querySelector('#tf-cphone-notice-0 .trades-phone-notice-link');
        if (link) link.click();
      });

      const editingA = await pollPage(page, (id) => {
        const editId = document.getElementById('trades-edit-id');
        const title  = document.getElementById('trades-modal-title');
        const co     = document.getElementById('tf-company');
        // Wait for trades-edit-id to match AND tf-company to be populated
        // (useEffect([open, editingTrade]) fires after the render that sets
        // trades-edit-id, so we must poll until both are ready).
        return editId && String(editId.value) === String(id) && co && co.value
          ? {
              title: (title && title.textContent) || '',
              company: co.value,
            }
          : null;
      }, tradeA.id, 5000);
      const editOk = !!editingA
        && editingA.title === 'Edit Company'
        && editingA.company === TRADES_COMPANY_A;
      record(
        'TRADES: clicking the notice link opens the existing record in Edit mode',
        `#trades-edit-id=${tradeA.id}, title="Edit Company", company input="${TRADES_COMPANY_A}"`,
        editingA ? `title=${JSON.stringify(editingA.title)} company=${JSON.stringify(editingA.company)}` : 'not editing A',
        editOk,
      );

      await page.close();
    }

    // ── (TRADES ADD – company-phone) add new company → company-phone duplicate ─
    {
      const page = await browser.newPage();
      await page.setCacheEnabled(false);
      page.on('pageerror', (e) => console.log('    [trades-add-cophone pageerror]', String(e).slice(0, 200)));
      await injectSession(page, adminClient.cookie);
      await page.goto(`${BASE}/trades`, { waitUntil: 'domcontentloaded', timeout: 20000 });

      // Wait for trades to load (_tradeContacts populated by loadTradesContacts).
      const loaded = await pollPage(page, () => {
        const list = window._cpGetTradeContacts && window._cpGetTradeContacts();
        return Array.isArray(list) && list.length >= 2;
      }, null, 8000);
      record(
        'TRADES ADD CO-PHONE: /trades page loads at least the seeded companies',
        '_cpGetTradeContacts() returns >=2 entries',
        `loaded=${!!loaded}`,
        !!loaded,
      );

      // Open the modal in "Add Company" mode (no id).
      await pollPage(page, () => typeof window.openTradesModal === 'function', null, 8000);
      await page.evaluate(() => { window.openTradesModal(); });
      const modalOpen = await pollPage(page, () => {
        const m     = document.getElementById('trades-modal');
        const input = document.getElementById('tf-company-phone');
        return !!(m && m.classList.contains('trades-modal-open') && input);
      }, null, 2000);
      record(
        'TRADES ADD CO-PHONE: openTradesModal() opens the modal with #tf-company-phone',
        '#trades-modal.trades-modal-open and #tf-company-phone present',
        `ready=${modalOpen}`,
        modalOpen,
      );

      // Type Company A's company_phone into the company-phone field.
      // onTradeCompanyPhoneInput fires via the 'input' event dispatched below.
      await setDialogInput(page, '#tf-company-phone', TRADES_CO_PHONE);

      // Allow the 300ms debounce to resolve.
      const noticeShownAdd = await pollPage(page, () => {
        const n = document.getElementById('tf-company-phone-notice');
        if (!n || n.classList.contains('hidden')) return null;
        const link = n.querySelector('.trades-phone-notice-link');
        return {
          text:   (n.textContent || '').trim(),
          linkId: link ? link.getAttribute('data-trade-id') : null,
        };
      }, null, 3000);
      const noticeAddOk = !!noticeShownAdd
        && /phone number is already in use/i.test(noticeShownAdd.text)
        && new RegExp(TRADES_COMPANY_A.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(noticeShownAdd.text)
        && String(noticeShownAdd.linkId) === String(tradeA.id);
      record(
        'TRADES ADD CO-PHONE: #tf-company-phone-notice shows the duplicate warning naming Company A',
        `text mentions "${TRADES_COMPANY_A}" and "phone number is already in use", link data-trade-id=${tradeA.id}`,
        noticeShownAdd
          ? `text=${JSON.stringify(noticeShownAdd.text.slice(0, 180))} linkId=${noticeShownAdd.linkId}`
          : 'no notice',
        noticeAddOk,
      );

      // Submit button must be disabled while the company-phone duplicate stands.
      const submitStateAdd = await page.evaluate(() => {
        const btn = document.getElementById('trades-submit-btn');
        return btn ? { disabled: btn.disabled, title: btn.title || '' } : null;
      });
      record(
        'TRADES ADD CO-PHONE: #trades-submit-btn is disabled while company-phone duplicate stands',
        'submit-btn disabled with a phone-conflict title',
        submitStateAdd
          ? `disabled=${submitStateAdd.disabled} title=${JSON.stringify(submitStateAdd.title)}`
          : 'no button',
        !!(submitStateAdd && submitStateAdd.disabled === true && /phone/i.test(submitStateAdd.title)),
      );

      // Clear the duplicate number — use a unique value so there is no conflict.
      await setDialogInput(page, '#tf-company-phone', '555-000-6666');

      // Notice must hide and submit button must re-enable.
      const noticeClearedCo = await pollPage(page, () => {
        const n = document.getElementById('tf-company-phone-notice');
        return n ? n.classList.contains('hidden') : true;
      }, false, 3000);
      record(
        'TRADES ADD CO-PHONE: #tf-company-phone-notice hides after duplicate number is cleared',
        '#tf-company-phone-notice has class "hidden"',
        noticeClearedCo ? 'notice hidden' : 'notice still visible',
        noticeClearedCo === true,
      );

      const submitReenabledCo = await page.evaluate(() => {
        const btn = document.getElementById('trades-submit-btn');
        return btn ? !btn.disabled : null;
      });
      record(
        'TRADES ADD CO-PHONE: #trades-submit-btn re-enables after duplicate company-phone is cleared',
        'submit-btn not disabled',
        submitReenabledCo === null ? 'no button' : `disabled=${!submitReenabledCo}`,
        submitReenabledCo === true,
      );

      // Restore the duplicate before closing so subsequent tests still work.
      await setDialogInput(page, '#tf-company-phone', TRADES_CO_PHONE);
      await pollPage(page, () => {
        const n = document.getElementById('tf-company-phone-notice');
        return n && !n.classList.contains('hidden');
      }, false, 3000);

      await page.close();
    }

    // ── (TRADES EDIT) edit existing company → contact-phone duplicate ────────
    {
      const page = await browser.newPage();
      await page.setCacheEnabled(false);
      page.on('pageerror', (e) => console.log('    [trades-edit pageerror]', String(e).slice(0, 200)));
      await injectSession(page, adminClient.cookie);
      await page.goto(`${BASE}/trades`, { waitUntil: 'domcontentloaded', timeout: 20000 });

      // Wait for the trades list to populate.
      const loaded = await pollPage(page, () => {
        const list = window._cpGetTradeContacts && window._cpGetTradeContacts();
        return Array.isArray(list) && list.length >= 2;
      }, null, 8000);
      record(
        'TRADES EDIT: /trades page loads at least the seeded companies',
        '_cpGetTradeContacts() returns >=2 entries',
        `loaded=${!!loaded}`,
        !!loaded,
      );

      // Open Company B in Edit mode. Company B has one contact with an empty
      // phone, so slot 0 is present and available to type into.
      await pollPage(page, () => typeof window.openTradesModal === 'function', null, 8000);
      await page.evaluate((id) => { window.openTradesModal(id); }, tradeB.id);

      const editModeReady = await pollPage(page, (id) => {
        const editId = document.getElementById('trades-edit-id');
        const slot   = document.getElementById('tf-cphone-0');
        const title  = document.getElementById('trades-modal-title');
        return editId && String(editId.value) === String(id) && slot
          ? { title: (title && title.textContent) || '' }
          : null;
      }, tradeB.id, 4000);
      record(
        'TRADES EDIT: openTradesModal(tradeB.id) opens Edit mode with a contact-phone slot',
        `#trades-edit-id=${tradeB.id}, #tf-cphone-0 present, title="Edit Company"`,
        editModeReady
          ? `title=${JSON.stringify(editModeReady.title)}`
          : 'modal not ready',
        !!(editModeReady && editModeReady.title === 'Edit Company'),
      );

      // Type the duplicate phone into Company B's contact slot 0.
      // setDialogInput uses real Puppeteer keyboard events so React's onChange
      // fires correctly through the MUI Dialog portal.
      await setDialogInput(page, '#tf-cphone-0', TRADES_DUP_PHONE);

      // Allow the 300ms debounce to resolve.
      const noticeShownEdit = await pollPage(page, () => {
        const n = document.getElementById('tf-cphone-notice-0');
        if (!n || n.classList.contains('hidden')) return null;
        const link = n.querySelector('.trades-phone-notice-link');
        return {
          text:   (n.textContent || '').trim(),
          linkId: link ? link.getAttribute('data-trade-id') : null,
        };
      }, null, 3000);
      const noticeEditOk = !!noticeShownEdit
        && /phone number is already in use/i.test(noticeShownEdit.text)
        && new RegExp(TRADE_A_CONTACT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(noticeShownEdit.text)
        && String(noticeShownEdit.linkId) === String(tradeA.id);
      record(
        'TRADES EDIT: #tf-cphone-notice-0 shows the duplicate warning naming the existing contact at company A',
        `text mentions "${TRADE_A_CONTACT}" and "phone number is already in use", link data-trade-id=${tradeA.id}`,
        noticeShownEdit
          ? `text=${JSON.stringify(noticeShownEdit.text.slice(0, 180))} linkId=${noticeShownEdit.linkId}`
          : 'no notice',
        noticeEditOk,
      );

      // Submit button must be disabled while the contact-phone duplicate stands.
      const submitStateEdit = await page.evaluate(() => {
        const btn = document.getElementById('trades-submit-btn');
        return btn ? { disabled: btn.disabled, title: btn.title || '' } : null;
      });
      record(
        'TRADES EDIT: #trades-submit-btn is disabled while the contact-phone duplicate stands (edit mode)',
        'submit-btn disabled with a phone-conflict title',
        submitStateEdit
          ? `disabled=${submitStateEdit.disabled} title=${JSON.stringify(submitStateEdit.title)}`
          : 'no button',
        !!(submitStateEdit && submitStateEdit.disabled === true && /phone/i.test(submitStateEdit.title)),
      );

      // Closure check: clearing the duplicate must hide the warning and
      // re-enable submit. Restore the duplicate afterwards so the click-link
      // test below still works.
      await setDialogInput(page, '#tf-cphone-0', '555-000-8888');

      const noticeClearedBeforeLink = await pollPage(page, () => {
        const n = document.getElementById('tf-cphone-notice-0');
        return n && n.classList.contains('hidden') ? true : null;
      }, null, 3000);
      record(
        'TRADES EDIT: clearing contact-phone duplicate hides #tf-cphone-notice-0 (before link test)',
        '#tf-cphone-notice-0 gains the "hidden" class after setting a unique value',
        noticeClearedBeforeLink ? 'hidden' : 'still visible',
        !!noticeClearedBeforeLink,
      );

      const submitReenabledBeforeLink = await page.evaluate(() => {
        const btn = document.getElementById('trades-submit-btn');
        return btn ? { disabled: btn.disabled } : null;
      });
      record(
        'TRADES EDIT: #trades-submit-btn re-enables after contact-phone duplicate is cleared (before link test)',
        'submit-btn not disabled',
        submitReenabledBeforeLink
          ? `disabled=${submitReenabledBeforeLink.disabled}`
          : 'no button',
        !!(submitReenabledBeforeLink && submitReenabledBeforeLink.disabled === false),
      );

      // Restore the duplicate so the click-link test below still works.
      await setDialogInput(page, '#tf-cphone-0', TRADES_DUP_PHONE);
      await pollPage(page, () => {
        const n = document.getElementById('tf-cphone-notice-0');
        return n && !n.classList.contains('hidden') ? true : null;
      }, null, 3000);

      // Click the link → modal should re-open in Edit mode for company A.
      await page.evaluate(() => {
        const link = document.querySelector('#tf-cphone-notice-0 .trades-phone-notice-link');
        if (link) link.click();
      });

      const editingAFromEdit = await pollPage(page, (id) => {
        const editId = document.getElementById('trades-edit-id');
        const title  = document.getElementById('trades-modal-title');
        const co     = document.getElementById('tf-company');
        return editId && String(editId.value) === String(id)
          ? {
              title: (title && title.textContent) || '',
              company: (co && co.value) || '',
            }
          : null;
      }, tradeA.id, 3000);
      const editAFromEditOk = !!editingAFromEdit
        && editingAFromEdit.title === 'Edit Company'
        && editingAFromEdit.company === TRADES_COMPANY_A;
      record(
        'TRADES EDIT: clicking the contact-phone notice link re-opens company A in Edit mode',
        `#trades-edit-id=${tradeA.id}, title="Edit Company", company input="${TRADES_COMPANY_A}"`,
        editingAFromEdit
          ? `title=${JSON.stringify(editingAFromEdit.title)} company=${JSON.stringify(editingAFromEdit.company)}`
          : 'not editing A',
        editAFromEditOk,
      );

      // Clear the duplicate number — use a unique value so there is no conflict.
      await setDialogInput(page, '#tf-cphone-0', '555-000-8888');

      // Notice must hide and submit button must re-enable.
      const noticeClearedEdit = await pollPage(page, () => {
        const n = document.getElementById('tf-cphone-notice-0');
        return n ? n.classList.contains('hidden') : true;
      }, false, 3000);
      record(
        'TRADES EDIT: #tf-cphone-notice-0 hides after duplicate contact-phone number is cleared',
        '#tf-cphone-notice-0 has class "hidden"',
        noticeClearedEdit ? 'notice hidden' : 'notice still visible',
        noticeClearedEdit === true,
      );

      const submitReenabledEdit = await page.evaluate(() => {
        const btn = document.getElementById('trades-submit-btn');
        return btn ? !btn.disabled : null;
      });
      record(
        'TRADES EDIT: #trades-submit-btn re-enables after duplicate contact-phone number is cleared',
        'submit-btn not disabled',
        submitReenabledEdit === null ? 'no button' : `disabled=${!submitReenabledEdit}`,
        submitReenabledEdit === true,
      );

      await page.close();
    }

    // ── (TRADES EDIT – company-phone) edit existing company → company-phone dup
    {
      const page = await browser.newPage();
      await page.setCacheEnabled(false);
      page.on('pageerror', (e) => console.log('    [trades-edit-cophone pageerror]', String(e).slice(0, 200)));
      await injectSession(page, adminClient.cookie);
      await page.goto(`${BASE}/trades`, { waitUntil: 'domcontentloaded', timeout: 20000 });

      // Wait for the trades list to populate.
      const loaded = await pollPage(page, () => {
        const list = window._cpGetTradeContacts && window._cpGetTradeContacts();
        return Array.isArray(list) && list.length >= 2;
      }, null, 8000);
      record(
        'TRADES EDIT CO-PHONE: /trades page loads at least the seeded companies',
        '_cpGetTradeContacts() returns >=2 entries',
        `loaded=${!!loaded}`,
        !!loaded,
      );

      // Open Company B in Edit mode.
      await pollPage(page, () => typeof window.openTradesModal === 'function', null, 8000);
      await page.evaluate((id) => { window.openTradesModal(id); }, tradeB.id);

      const editModeReady = await pollPage(page, (id) => {
        const editId = document.getElementById('trades-edit-id');
        const input  = document.getElementById('tf-company-phone');
        const title  = document.getElementById('trades-modal-title');
        return editId && String(editId.value) === String(id) && input
          ? { title: (title && title.textContent) || '' }
          : null;
      }, tradeB.id, 4000);
      record(
        'TRADES EDIT CO-PHONE: openTradesModal(tradeB.id) opens Edit mode with #tf-company-phone',
        `#trades-edit-id=${tradeB.id}, #tf-company-phone present, title="Edit Company"`,
        editModeReady
          ? `title=${JSON.stringify(editModeReady.title)}`
          : 'modal not ready',
        !!(editModeReady && editModeReady.title === 'Edit Company'),
      );

      // Type Company A's company_phone into Company B's company-phone field.
      // onTradeCompanyPhoneInput fires via the 'input' event dispatched below.
      await setDialogInput(page, '#tf-company-phone', TRADES_CO_PHONE);

      // Allow the 300ms debounce to resolve.
      const noticeShown = await pollPage(page, () => {
        const n = document.getElementById('tf-company-phone-notice');
        if (!n || n.classList.contains('hidden')) return null;
        const link = n.querySelector('.trades-phone-notice-link');
        return {
          text:   (n.textContent || '').trim(),
          linkId: link ? link.getAttribute('data-trade-id') : null,
        };
      }, null, 3000);
      const noticeOk = !!noticeShown
        && /phone number is already in use/i.test(noticeShown.text)
        && new RegExp(TRADES_COMPANY_A.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(noticeShown.text)
        && String(noticeShown.linkId) === String(tradeA.id);
      record(
        'TRADES EDIT CO-PHONE: #tf-company-phone-notice shows the duplicate warning naming Company A',
        `text mentions "${TRADES_COMPANY_A}" and "phone number is already in use", link data-trade-id=${tradeA.id}`,
        noticeShown
          ? `text=${JSON.stringify(noticeShown.text.slice(0, 180))} linkId=${noticeShown.linkId}`
          : 'no notice',
        noticeOk,
      );

      // Submit button must be disabled while the company-phone duplicate stands.
      const submitState = await page.evaluate(() => {
        const btn = document.getElementById('trades-submit-btn');
        return btn ? { disabled: btn.disabled, title: btn.title || '' } : null;
      });
      record(
        'TRADES EDIT CO-PHONE: #trades-submit-btn is disabled while company-phone duplicate stands',
        'submit-btn disabled with a phone-conflict title',
        submitState
          ? `disabled=${submitState.disabled} title=${JSON.stringify(submitState.title)}`
          : 'no button',
        !!(submitState && submitState.disabled === true && /phone/i.test(submitState.title)),
      );

      // Clear the duplicate → notice must hide → submit must re-enable.
      await setDialogInput(page, '#tf-company-phone', '');

      const coPhoneNoticeClearedEdit = await pollPage(page, () => {
        const n = document.getElementById('tf-company-phone-notice');
        return n ? n.classList.contains('hidden') : true;
      }, null, 3000);
      record(
        'TRADES EDIT CO-PHONE: #tf-company-phone-notice hides after clearing the duplicate',
        '#tf-company-phone-notice has class "hidden"',
        coPhoneNoticeClearedEdit ? 'notice hidden' : 'notice still visible',
        coPhoneNoticeClearedEdit === true,
      );

      const coPhoneSubmitReenabledEdit = await page.evaluate(() => {
        const btn = document.getElementById('trades-submit-btn');
        return btn ? !btn.disabled : null;
      });
      record(
        'TRADES EDIT CO-PHONE: #trades-submit-btn re-enables after clearing the company-phone duplicate',
        'submit-btn not disabled',
        coPhoneSubmitReenabledEdit === null ? 'no button' : `disabled=${!coPhoneSubmitReenabledEdit}`,
        coPhoneSubmitReenabledEdit === true,
      );

      // Restore the duplicate so the notice link is present for the click-link test below.
      await setDialogInput(page, '#tf-company-phone', TRADES_CO_PHONE);
      await pollPage(page, () => {
        const n = document.getElementById('tf-company-phone-notice');
        return !!(n && !n.classList.contains('hidden'));
      }, null, 3000);

      // Click the notice link → modal should re-open in Edit mode for company A.
      await page.evaluate(() => {
        const link = document.querySelector('#tf-company-phone-notice .trades-phone-notice-link');
        if (link) link.click();
      });

      const editingA = await pollPage(page, (id) => {
        const editId = document.getElementById('trades-edit-id');
        const title  = document.getElementById('trades-modal-title');
        const co     = document.getElementById('tf-company');
        return editId && String(editId.value) === String(id)
          ? {
              title:   (title && title.textContent) || '',
              company: (co && co.value) || '',
            }
          : null;
      }, tradeA.id, 3000);
      const editOk = !!editingA
        && editingA.title === 'Edit Company'
        && editingA.company === TRADES_COMPANY_A;
      record(
        'TRADES EDIT CO-PHONE: clicking the notice link opens Company A in Edit mode',
        `#trades-edit-id=${tradeA.id}, title="Edit Company", company input="${TRADES_COMPANY_A}"`,
        editingA
          ? `title=${JSON.stringify(editingA.title)} company=${JSON.stringify(editingA.company)}`
          : 'not editing A',
        editOk,
      );

      // Clear the duplicate number — use a unique value so there is no conflict.
      await setDialogInput(page, '#tf-company-phone', '555-000-9999');

      // Notice must hide and submit button must re-enable.
      const noticeCleared = await pollPage(page, () => {
        const n = document.getElementById('tf-company-phone-notice');
        return n ? n.classList.contains('hidden') : true;
      }, false, 3000);
      record(
        'TRADES EDIT CO-PHONE: #tf-company-phone-notice hides after duplicate number is cleared',
        '#tf-company-phone-notice has class "hidden"',
        noticeCleared ? 'notice hidden' : 'notice still visible',
        noticeCleared === true,
      );

      const submitReenabled = await page.evaluate(() => {
        const btn = document.getElementById('trades-submit-btn');
        return btn ? !btn.disabled : null;
      });
      record(
        'TRADES EDIT CO-PHONE: #trades-submit-btn re-enables after duplicate number is cleared',
        'submit-btn not disabled',
        submitReenabled === null ? 'no button' : `disabled=${!submitReenabled}`,
        submitReenabled === true,
      );

      await page.close();
    }

    // ── (TRADES CUSTOMER – company-phone) type customer phone into #tf-company-phone ──
    // Verifies the cross-section customer conflict path: a phone number that
    // belongs to a HubSpot customer shows the customer conflict notice (naming
    // the customer and linking to /customers/:id) inside #tf-company-phone-notice.
    {
      const page = await browser.newPage();
      await page.setCacheEnabled(false);
      page.on('pageerror', (e) => console.log('    [trades-cust-cophone pageerror]', String(e).slice(0, 200)));
      await injectSession(page, adminClient.cookie);
      await page.goto(`${BASE}/trades`, { waitUntil: 'domcontentloaded', timeout: 20000 });

      // Wait for trades list and phone directory to load (React TradesPage fetches
      // /api/admin/phone-directory in a useEffect).
      const loaded = await pollPage(page, () => {
        const list = window._cpGetTradeContacts && window._cpGetTradeContacts();
        return Array.isArray(list) && list.length >= 2;
      }, null, 8000);
      record(
        'TRADES CUSTOMER CO-PHONE: /trades page loads with at least the seeded companies',
        '_cpGetTradeContacts() returns >=2 entries',
        `loaded=${!!loaded}`,
        !!loaded,
      );

      // Allow the phone-directory fetch to complete (it runs concurrently with
      // the trades list fetch, so an extra tick may be needed).
      await new Promise(r => setTimeout(r, 800));

      // Open the modal in Add Company mode.
      await pollPage(page, () => typeof window.openTradesModal === 'function', null, 8000);
      await page.evaluate(() => { window.openTradesModal(); });
      const modalOpen = await pollPage(page, () => {
        const m     = document.getElementById('trades-modal');
        const input = document.getElementById('tf-company-phone');
        return !!(m && m.classList.contains('trades-modal-open') && input);
      }, null, 2000);
      record(
        'TRADES CUSTOMER CO-PHONE: openTradesModal() opens the modal with #tf-company-phone',
        '#trades-modal.trades-modal-open and #tf-company-phone present',
        `ready=${modalOpen}`,
        modalOpen,
      );

      // Type the customer's phone into the company-phone field.
      await setDialogInput(page, '#tf-company-phone', CUSTOMER_DUP_PHONE);

      // Allow the debounce to resolve and the React state to update.
      const noticeShown = await pollPage(page, () => {
        const n = document.getElementById('tf-company-phone-notice');
        if (!n || n.classList.contains('hidden')) return null;
        const alert = n.querySelector('[role="alert"]');
        return alert ? { text: (alert.textContent || '').trim() } : null;
      }, null, 4000);
      const custLabel = CUSTOMER_LABEL;
      const noticeOk = !!noticeShown
        && /phone number is already in use/i.test(noticeShown.text)
        && new RegExp(custLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(noticeShown.text);
      record(
        'TRADES CUSTOMER CO-PHONE: #tf-company-phone-notice shows customer conflict alert naming the customer',
        `MuiAlert inside #tf-company-phone-notice mentioning "phone number is already in use" + "${custLabel}"`,
        noticeShown
          ? `text=${JSON.stringify(noticeShown.text.slice(0, 200))}`
          : 'no alert visible',
        noticeOk,
      );

      // The notice should contain a link to /customers/:id.
      const linkHref = await page.evaluate(() => {
        const n = document.getElementById('tf-company-phone-notice');
        if (!n || n.classList.contains('hidden')) return null;
        const a = n.querySelector('a[href]');
        return a ? a.getAttribute('href') : null;
      });
      const expectedHref = `/customers/${encodeURIComponent(CUSTOMER_CONTACT_ID)}`;
      record(
        'TRADES CUSTOMER CO-PHONE: customer conflict notice links to /customers/:id',
        `<a href="${expectedHref}"> inside #tf-company-phone-notice`,
        `href=${linkHref}`,
        linkHref === expectedHref,
      );

      // Submit button must be disabled while the customer conflict stands.
      const submitDisabledCust = await page.evaluate(() => {
        const btn = document.getElementById('trades-submit-btn');
        return btn ? btn.disabled : null;
      });
      record(
        'TRADES CUSTOMER CO-PHONE: #trades-submit-btn is disabled while customer phone conflict stands',
        'button.disabled === true',
        `disabled=${submitDisabledCust}`,
        submitDisabledCust === true,
      );

      // Clear the customer phone — notice must hide and submit must re-enable.
      await setDialogInput(page, '#tf-company-phone', '');
      const noticeClearedCust = await pollPage(page, () => {
        const n = document.getElementById('tf-company-phone-notice');
        return n ? n.classList.contains('hidden') : true;
      }, null, 3000);
      record(
        'TRADES CUSTOMER CO-PHONE: #tf-company-phone-notice hides after clearing the customer phone',
        '#tf-company-phone-notice has class "hidden"',
        noticeClearedCust ? 'notice hidden' : 'notice still visible',
        noticeClearedCust === true,
      );

      const submitReenabledCust = await page.evaluate(() => {
        const btn = document.getElementById('trades-submit-btn');
        return btn ? !btn.disabled : null;
      });
      record(
        'TRADES CUSTOMER CO-PHONE: #trades-submit-btn re-enables after clearing the customer phone',
        'button.disabled === false',
        submitReenabledCust === null ? 'no button' : `disabled=${!submitReenabledCust}`,
        submitReenabledCust === true,
      );

      await page.close();
    }

    // ── (TRADES CUSTOMER – contact-phone) type customer phone into #tf-cphone-0 ─
    // Verifies the same cross-section path via the per-contact-slot phone field.
    {
      const page = await browser.newPage();
      await page.setCacheEnabled(false);
      page.on('pageerror', (e) => console.log('    [trades-cust-cphone pageerror]', String(e).slice(0, 200)));
      await injectSession(page, adminClient.cookie);
      await page.goto(`${BASE}/trades`, { waitUntil: 'domcontentloaded', timeout: 20000 });

      const loaded = await pollPage(page, () => {
        const list = window._cpGetTradeContacts && window._cpGetTradeContacts();
        return Array.isArray(list) && list.length >= 2;
      }, null, 8000);
      record(
        'TRADES CUSTOMER CONTACT-PHONE: /trades page loads with at least the seeded companies',
        '_cpGetTradeContacts() returns >=2 entries',
        `loaded=${!!loaded}`,
        !!loaded,
      );

      // Allow phone-directory fetch to settle.
      await new Promise(r => setTimeout(r, 800));

      // Open the modal in Add Company mode.
      await pollPage(page, () => typeof window.openTradesModal === 'function', null, 8000);
      await page.evaluate(() => { window.openTradesModal(); });
      const modalOpen = await pollPage(page, () => {
        const m = document.getElementById('trades-modal');
        const input = document.getElementById('tf-cphone-0');
        return !!(m && m.classList.contains('trades-modal-open') && input);
      }, null, 2000);
      record(
        'TRADES CUSTOMER CONTACT-PHONE: openTradesModal() opens the modal with #tf-cphone-0',
        '#trades-modal.trades-modal-open and #tf-cphone-0 present',
        `ready=${modalOpen}`,
        modalOpen,
      );

      // Type the customer's phone into the first contact-slot phone field.
      await setDialogInput(page, '#tf-cphone-0', CUSTOMER_DUP_PHONE);

      const noticeShown = await pollPage(page, () => {
        const n = document.getElementById('tf-cphone-notice-0');
        if (!n || n.classList.contains('hidden')) return null;
        const alert = n.querySelector('[role="alert"]');
        return alert ? { text: (alert.textContent || '').trim() } : null;
      }, null, 4000);
      const noticeOk = !!noticeShown
        && /phone number is already in use/i.test(noticeShown.text)
        && new RegExp(CUSTOMER_LABEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(noticeShown.text);
      record(
        'TRADES CUSTOMER CONTACT-PHONE: #tf-cphone-notice-0 shows customer conflict alert naming the customer',
        `MuiAlert inside #tf-cphone-notice-0 mentioning "phone number is already in use" + "${CUSTOMER_LABEL}"`,
        noticeShown
          ? `text=${JSON.stringify(noticeShown.text.slice(0, 200))}`
          : 'no alert visible',
        noticeOk,
      );

      // Submit button must be disabled while the customer contact-phone conflict stands.
      const submitDisabled = await page.evaluate(() => {
        const btn = document.getElementById('trades-submit-btn');
        return btn ? btn.disabled : null;
      });
      record(
        'TRADES CUSTOMER CONTACT-PHONE: #trades-submit-btn is disabled while customer conflict stands',
        'button.disabled === true',
        `disabled=${submitDisabled}`,
        submitDisabled === true,
      );

      await page.close();
    }
  } catch (e) {
    record('uncaught harness error', 'no exception', String(e), false);
  } finally {
    await browser.close().catch(() => {});
  }

  const pass = findings.filter(f => f.ok).length;
  const fail = findings.filter(f => !f.ok && !f.skipped).length;
  const skipped = findings.filter(f => f.skipped).length;
  console.log(`\n  Results: ${pass} passed, ${fail} failed`);

  await writeReport(runId, findings);
  await cleanupAndExit(fail > 0 ? 1 : 0);
}

async function writeReport(runId, findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Duplicate-Phone Warnings — E2E Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:duplicate-phone-warnings\``,
    '',
    '## Summary',
    '',
    `- Passed: ${findings.filter(f => f.ok).length} / ${findings.length}`,
    `- Skipped: ${findings.filter(f => f.skipped).length} / ${findings.length}`,
    `- Failed: ${findings.filter(f => !f.ok && !f.skipped).length} / ${findings.length}`,
    '',
    '## Results',
    '',
    '| Result | Probe | Expected | Observed |',
    '|---|---|---|---|',
    ...findings.map(f =>
      `| ${f.ok ? 'PASS' : f.skipped ? 'SKIP' : 'FAIL'} | ${esc(f.name)} | ${esc(f.expected)} | ${esc(f.observed)} |`,
    ),
    '',
    '## Coverage',
    '',
    '- **(TEAM)** Seeds an `allowed_emails` row with',
    '  `metadata.mobile_number`, opens `#tab-team` in `/admin`, types the same',
    '  number into the Personal-details Mobile number field, and asserts the',
    '  MUI Alert appears, the Add-team-member button disables, and the alert',
    '  action highlights the existing approved-list row (`.admin-row-flash`).',
    '  Also covers the phone clear-and-recover path (alert disappears, button',
    '  re-enables) and the email duplicate clear-and-recover path: types the',
    '  seeded duplicate email into Work email address, asserts the',
    '  "This email is already on the allow-list" MUI Alert appears and the',
    '  button disables, then clears the field and asserts the Alert disappears',
    '  and the button is re-enabled.',
    '- **(TRADES – Add mode, contact-phone)** Seeds two trade companies via `POST /api/trades`, opens',
    '  the Trades modal in Add mode, types the duplicated contact phone into',
    '  `#tf-cphone-0`, and asserts `#tf-cphone-notice-0` shows the warning',
    '  with a link to the existing company, `#trades-submit-btn` disables,',
    '  clearing the field hides the notice and re-enables submit, and clicking',
    '  the restored link re-opens the modal in Edit mode for the original company.',
    '- **(TRADES – Add mode, company-phone)** Opens the Trades modal in Add mode, types',
    "  Company A's `company_phone` into `#tf-company-phone`, asserts",
    '  `#tf-company-phone-notice` shows the warning naming Company A,',
    '  `#trades-submit-btn` is disabled, clearing the field hides the notice',
    '  and re-enables submit.',
    '- **(TRADES – Edit mode, contact-row)** Opens Company B in Edit mode, types the same',
    '  duplicated phone into its contact-row slot (`#tf-cphone-0`), and',
    '  asserts `#tf-cphone-notice-0` appears naming the existing contact,',
    '  links to Company A, and `#trades-submit-btn` is disabled.',
    '- **(TRADES – Edit mode, company-phone)** Opens Company B in Edit mode, types',
    "  Company A's `company_phone` into `#tf-company-phone`, and asserts",
    '  `#tf-company-phone-notice` appears naming Company A, links to Company A',
    '  via `data-trade-id`, and `#trades-submit-btn` is disabled. Then clears',
    '  the field, asserts the notice hides and the button re-enables, restores',
    '  the duplicate, and asserts clicking the link re-opens Company A in Edit mode.',
    '- **(API: phone-directory customers)** Verifies that `GET /api/admin/phone-directory`',
    '  returns a `customers` entry for the mock HubSpot customer (`contactId`,',
    '  `phone`, `label`) when `HUBSPOT_TOKEN` is set and the mock server returns',
    '  the fixture contact.',
    '- **(TRADES CUSTOMER – company-phone)** Starts a local mock HubSpot server seeded',
    '  with a customer whose phone = `CUSTOMER_DUP_PHONE`, opens the Trades Add',
    '  modal, types `CUSTOMER_DUP_PHONE` into `#tf-company-phone`, and asserts',
    '  `#tf-company-phone-notice` shows an MUI Alert naming the customer,',
    '  `#trades-submit-btn` disables, and clearing the field hides the notice and',
    '  re-enables submit. Also verifies the notice `<a>` links to',
    '  `/customers/:contactId`.',
    '- **(TRADES CUSTOMER – contact-phone)** Same cross-section path exercised via the',
    '  per-contact-slot input (`#tf-cphone-0`): asserts `#tf-cphone-notice-0`',
    '  shows an MUI Alert naming the customer and `#trades-submit-btn` disables.',
    '',
  ];
  const outPath = path.join(dir, 'duplicate-phone-warnings.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Report: test-results/duplicate-phone-warnings.md`);
}

main();
