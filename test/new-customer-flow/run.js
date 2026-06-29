'use strict';
const { makeSkip } = require('../helpers/report');
// test/new-customer-flow/run.js
//
// End-to-end live test for the "New customer" entry point on /customers
// Mirrors the test/design-visit-list/run.js pattern:
// boot a disposable server with the privileges harness, drive the UI with
// Puppeteer, write a markdown report, and exit non-zero on failure.
//
// The privileges harness strips HUBSPOT_ACCESS_TOKEN by default, so this
// suite stands up a local mock HubSpot server (handling the search +
// contact-create + contact-patch + property-create endpoints) and points the
// spawned Express server at it via HUBSPOT_API_URL + a dummy
// HUBSPOT_ACCESS_TOKEN passed through extraEnv.
//
// Probes:
//   [API] member POST /api/contacts with valid payload returns 201 and the
//         mock HubSpot contact-create endpoint observed the expected
//         properties (firstname/lastname/email/phone/zip/hs_lead_status).
//   [UI ] member loads /customers, clicks #new-customer-btn, fills the
//         dialog and submits — the row appears in #customers-results.
//   [UI ] member loads /customers?new=1 — the dialog auto-opens.
//   [UI ] viewer loads /customers — #new-customer-btn is absent.
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:new-customer-flow
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:new-customer-flow

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

const {
  spawnServer,
  waitForServer,
  seedUsers,
  cleanupTestData,
  resetRateLimitStore,
  login,
  setPool,
  BASE,
} = require('../privileges/harness');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

require('dotenv').config();

const { pollUntil, pollFn } = require('../helpers/poll');

// ── Mock HubSpot server ──────────────────────────────────────────────────────
function startMockHubspot() {
  const state = {
    createPosts: [],   // bodies POSTed to /crm/v3/objects/contacts
    patchPosts: [],    // bodies PATCHed to /crm/v3/objects/contacts/:id
    contacts:   [],    // ledger of created contacts (returned by search)
    nextContactId: 989800000754,
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch {}

      // POST /crm/v3/properties/contacts (ensureHubSpotProperties)
      if (req.method === 'POST' && u.pathname === '/crm/v3/properties/contacts') {
        return send(409, { message: 'already exists' });
      }
      // POST /crm/v3/objects/contacts/search (getSharedContactsCache)
      if (req.method === 'POST' && u.pathname === '/crm/v3/objects/contacts/search') {
        // Reply with every contact we've created so the page's post-create
        // refetch (/api/contacts-all → getSharedContactsCache) sees the new
        // row and keeps it visible in #customers-results.
        return send(200, { results: state.contacts.slice(), paging: {} });
      }
      // POST /crm/v3/objects/contacts (create)
      if (req.method === 'POST' && u.pathname === '/crm/v3/objects/contacts') {
        state.createPosts.push(body);
        const id = String(state.nextContactId++);
        const contact = {
          id,
          properties: {
            ...(body.properties || {}),
            createdate: new Date().toISOString(),
            hw_test_user: 'true',
          },
        };
        state.contacts.push(contact);
        return send(201, { id, properties: { ...contact.properties } });
      }
      // PATCH /crm/v3/objects/contacts/:id
      const m = u.pathname.match(/^\/crm\/v3\/objects\/contacts\/([^/]+)$/);
      if (m && req.method === 'PATCH') {
        state.patchPosts.push({ id: decodeURIComponent(m[1]), body });
        return send(200, { id: decodeURIComponent(m[1]), properties: { ...(body.properties || {}) } });
      }
      // GET /crm/v3/objects/contacts/:id (not used in these probes; tolerate)
      if (m && req.method === 'GET') {
        return send(200, { id: decodeURIComponent(m[1]), properties: {} });
      }
      send(404, { error: 'mock: not_found', method: req.method, path: u.pathname });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, state });
    });
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────
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

async function pollPage(page, fn, arg, timeoutMs = 8000, intervalMs = 150) {
  return pollUntil(page, fn, timeoutMs, intervalMs, arg !== undefined && arg !== null ? [arg] : []);
}

async function newPageWithSession(browser, jar) {
  const ctx = await (browser.createBrowserContext
    ? browser.createBrowserContext()
    : browser.createIncognitoBrowserContext());
  const page = await ctx.newPage();
  page.__ctx = ctx;
  await page.setCacheEnabled(false);
  const logs = [];
  page.on('console',       m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror',     e => logs.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', r => logs.push(`[reqfailed] ${r.url()} ${r.failure()?.errorText || ''}`));
  page.on('response',      r => {
    const s = r.status();
    if (s >= 400) logs.push(`[resp ${s}] ${r.request().method()} ${r.url()}`);
  });
  await injectSession(page, jar);
  page.__logs = logs;
  return page;
}

async function closePage(p) {
  try { await p.close(); } catch {}
  try { await p.__ctx?.close(); } catch {}
}

// Wait for the CustomersPage React island to mount.
async function waitForCustomersMounted(page) {
  await pollPage(page, () => {
    // After mount, either #customers-results, the empty-state, or skeletons
    // exist alongside the Customers <h1>.
    const hs = Array.from(document.querySelectorAll('h1'))
      .some(h => /Customers/i.test(h.textContent || ''));
    return hs ? 'ok' : null;
  }, null, 15000);
}

// ── main ─────────────────────────────────────────────────────────────────────
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

  const runId = Math.random().toString(36).slice(2, 8);
  console.log(`\n  new-customer-flow E2E  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);
  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  viewer=${users.viewer.email}  member=${users.member.email}`);

  // Mock HubSpot server.
  const mock = await startMockHubspot();
  console.log(`  Mock HubSpot listening on 127.0.0.1:${mock.port}`);

  const { child, logBuf } = spawnServer({
    extraEnv: {
      HUBSPOT_API_URL:      `http://127.0.0.1:${mock.port}`,
      HUBSPOT_ACCESS_TOKEN: 'mock-token-new-customer-flow',
      HUBSPOT_TOKEN:        'mock-token-new-customer-flow',
    },
  });
  let exited = false;
  child.on('exit', () => { exited = true; });

  const findings = [];
  function record(name, expected, observed, ok) {
    findings.push({ name, expected, observed, ok });
    const mark = ok ? '  ✓' : '  ✗';
    console.log(`${mark}  ${name}`);
    if (!ok) {
      console.log(`     expected : ${expected}`);
      console.log(`     observed : ${observed}`);
    }
  }
  const skip = makeSkip(findings);

  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try { mock.server.close(); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    process.exit(code);
  };
  process.on('SIGINT',  () => cleanupAndExit(130));
  process.on('SIGTERM', () => cleanupAndExit(130));
  process.on('uncaughtException',  (e) => { console.error('Uncaught:',  e); cleanupAndExit(2); });
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

  const memberClient = await login(users.member.email, users.member.password);
  const viewerClient = await login(users.viewer.email, users.viewer.password);

  // ════════════════════════════════════════════════════════════════════════════
  // [API] member POST /api/contacts
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n  [API] POST /api/contacts');
  {
    const beforeCount = mock.state.createPosts.length;
    const postcode = 'SW1A 1AA';
    // Regression guard (task #2827 → fix): the New customer modal posts the
    // postcode inside the canonical `structuredAddress` shape, NOT a flat
    // `postcode` field. The endpoint only reads `structuredAddress.postalCode`,
    // so if either side drifts back to a flat field this probe fails — the zip
    // would not round-trip and the area prefix would fall back to 'XX'.
    const payload = {
      firstname: 'Alex',
      lastname:  'Tester',
      email:     `nc-${runId}@privtest.local`,
      phone:     '07123456789',
      structuredAddress: { addressLines: [], postalCode: postcode, countryCode: 'GB' },
    };
    const r = await memberClient.post('/api/contacts', payload);
    const created = r.json || {};
    record(
      '[API] POST /api/contacts returns 201 with HubSpot id + customer_number',
      'status=201, id present, customer_number starts with "SW"',
      `status=${r.status}, id=${created.id}, customer_number=${created.properties?.customer_number}`,
      r.status === 201
        && !!created.id
        && typeof created.properties?.customer_number === 'string'
        && /^SW/.test(created.properties.customer_number || ''),
    );

    const seen = mock.state.createPosts[beforeCount];
    const props = seen?.properties || {};
    record(
      '[API] mock HubSpot saw the expected contact-create payload (structuredAddress → zip)',
      'firstname/lastname/email/phone/zip + hs_lead_status=OPEN_DEAL',
      `properties=${JSON.stringify(props)}`,
      props.firstname === 'Alex'
        && props.lastname  === 'Tester'
        && props.email     === payload.email
        && props.phone     === payload.phone
        && props.zip       === postcode
        && props.hs_lead_status === 'OPEN_DEAL',
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // [API] postcode is optional — omit the address entirely
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n  [API] POST /api/contacts with no postcode');
  {
    const r = await memberClient.post('/api/contacts', {
      firstname: 'Nopostcode',
      lastname:  'Tester',
      email:     `nc-nopc-${runId}@privtest.local`,
      phone:     '',
    });
    const created = r.json || {};
    record(
      '[API] POST /api/contacts with no postcode returns 201 with an XX-prefixed number',
      'status=201, customer_number starts with "XX"',
      `status=${r.status}, customer_number=${created.properties?.customer_number}`,
      r.status === 201
        && typeof created.properties?.customer_number === 'string'
        && /^XX/.test(created.properties.customer_number || ''),
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Puppeteer probes
  // ════════════════════════════════════════════════════════════════════════════
  const UI_LABELS = [
    '[UI] member /customers — New customer button is present',
    '[UI] member /customers — clicking opens the dialog',
    '[UI] member /customers — submitting creates the contact (mock POST observed)',
    '[UI] member /customers — newly-created contact appears in the list',
    '[UI] member /customers — typing an existing email shows duplicate notice and disables Create',
    '[UI] member /customers?new=1 — dialog auto-opens on load',
    '[UI] viewer /customers — New customer button is absent',
  ];

  if (!puppeteer) {
    for (const l of UI_LABELS) skip(l, 'puppeteer installed', 'puppeteer not installed');
  } else {
    const { findChromium } = require('../shared/find-chromium');
    let browser = null;
    let launchErr = null;
    const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox'];
    const attempts = [{ args: launchArgs }];
    const sysChrome = findChromium();
    if (sysChrome) attempts.push({ executablePath: sysChrome, args: launchArgs });
    for (const opts of attempts) {
      try {
        browser = await puppeteer.launch({ headless: true, ...opts });
        launchErr = null;
        break;
      } catch (e) { launchErr = e; browser = null; }
    }

    if (!browser) {
      const msg = (launchErr?.message || String(launchErr)).slice(0, 200);
      for (const l of UI_LABELS) skip(l, 'browser launched', `browser launch failed: ${msg}`);
    } else {
      try {
        // ── Member /customers ─────────────────────────────────────────────────
        const memberPage = await newPageWithSession(browser, memberClient.cookie);
        await memberPage.goto(`${BASE}/customers`, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await waitForCustomersMounted(memberPage);

        const buttonPresent = await pollPage(memberPage,
          () => document.getElementById('new-customer-btn') ? 'ok' : null,
          null, 8000);
        record(UI_LABELS[0],
          '#new-customer-btn present in the page',
          `present=${buttonPresent === 'ok'}`,
          buttonPresent === 'ok');

        await memberPage.evaluate(() => {
          const b = document.getElementById('new-customer-btn');
          if (b) b.click();
        });
        const dialogOpen = await pollPage(memberPage,
          () => document.getElementById('new-customer-form') ? 'ok' : null,
          null, 6000);
        record(UI_LABELS[1],
          '#new-customer-form mounted after click',
          `open=${dialogOpen === 'ok'}`,
          dialogOpen === 'ok');

        // Fill + submit.
        const uiEmail = `nc-ui-${runId}@privtest.local`;
        const beforeCreates = mock.state.createPosts.length;
        await memberPage.evaluate((args) => {
          const setVal = (id, v) => {
            const el = document.getElementById(id);
            if (!el) return;
            const proto = Object.getPrototypeOf(el);
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            setter ? setter.call(el, v) : (el.value = v);
            el.dispatchEvent(new Event('input',  { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          };
          setVal('nc-firstname', args.firstname);
          setVal('nc-lastname',  args.lastname);
          setVal('nc-email',     args.email);
          setVal('nc-phone',     args.phone);
          setVal('nc-postcode',  args.postcode);
        }, {
          firstname: 'UI',
          lastname:  'Probe',
          email:     uiEmail,
          phone:     '07900900900',
          postcode:  'EC1A 1BB',
        });

        await memberPage.evaluate(() => {
          const form = document.getElementById('new-customer-form');
          if (form) form.requestSubmit
            ? form.requestSubmit()
            : form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });

        const apiObserved = await pollFn(async () => {
          if (mock.state.createPosts.length > beforeCreates) {
            const last = mock.state.createPosts[mock.state.createPosts.length - 1];
            if (last?.properties?.email === uiEmail) return last;
          }
          return null;
        }, 8000, 100);
        record(UI_LABELS[2],
          'mock HubSpot received contact-create with the dialog email',
          `email seen=${apiObserved?.properties?.email}`,
          !!apiObserved && apiObserved.properties.email === uiEmail
            && apiObserved.properties.zip === 'EC1A 1BB',
        );

        // After onCreated, the dialog closes and the new contact is
        // prepended to #customers-results.
        const inList = await pollPage(memberPage, (email) => {
          const root = document.getElementById('customers-results');
          if (!root) return null;
          return root.textContent && root.textContent.includes(email) ? 'ok' : null;
        }, uiEmail, 8000);
        record(UI_LABELS[3],
          'new contact email appears in #customers-results',
          `inList=${inList === 'ok'}`,
          inList === 'ok');

        // ── Duplicate-email warning ───────────────────────────────────────────
        // Re-open the dialog and type the email of the contact created in the
        // [API] phase. The NewCustomerDialog debounced-lookup against
        // /api/contacts-all should surface #nc-duplicate-notice and disable
        // #nc-submit.
        await memberPage.evaluate(() => {
          const b = document.getElementById('new-customer-btn');
          if (b) b.click();
        });
        await pollPage(memberPage,
          () => document.getElementById('new-customer-form') ? 'ok' : null,
          null, 6000);
        const existingEmail = `nc-${runId}@privtest.local`;
        await memberPage.evaluate((em) => {
          const el = document.getElementById('nc-email');
          if (!el) return;
          const proto = Object.getPrototypeOf(el);
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          setter ? setter.call(el, em) : (el.value = em);
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, existingEmail);
        const dupSnap = await pollPage(memberPage, () => {
          const notice = document.getElementById('nc-duplicate-notice');
          if (!notice) return null;
          const link = document.getElementById('nc-duplicate-link');
          const submit = document.getElementById('nc-submit');
          return {
            visible: true,
            href: link?.getAttribute('href') || '',
            disabled: !!(submit && submit.hasAttribute('disabled')),
          };
        }, null, 8000);
        record(UI_LABELS[4],
          '#nc-duplicate-notice visible, link → /customers/<id>, #nc-submit disabled',
          `snap=${JSON.stringify(dupSnap)}`,
          !!dupSnap
            && dupSnap.visible === true
            && /^\/customers\/[^/]+/.test(dupSnap.href || '')
            && dupSnap.disabled === true);

        await closePage(memberPage);

        // ── Member /customers?new=1 ───────────────────────────────────────────
        const deepLinkPage = await newPageWithSession(browser, memberClient.cookie);
        await deepLinkPage.goto(`${BASE}/customers?new=1`, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await waitForCustomersMounted(deepLinkPage);
        const autoOpen = await pollPage(deepLinkPage,
          () => document.getElementById('new-customer-form') ? 'ok' : null,
          null, 8000);
        record(UI_LABELS[5],
          '#new-customer-form auto-opens on ?new=1',
          `open=${autoOpen === 'ok'}`,
          autoOpen === 'ok');
        await closePage(deepLinkPage);

        // ── Viewer /customers ─────────────────────────────────────────────────
        const viewerPage = await newPageWithSession(browser, viewerClient.cookie);
        await viewerPage.goto(`${BASE}/customers`, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await waitForCustomersMounted(viewerPage);
        // Wait for the auth state to be set before sampling — core.js bootstrap
        // sets __moHeaderUser which useIsViewer depends on for its privilege check.
        await pollPage(viewerPage, () => window.__moHeaderUser ? 'ok' : null, null, 5000);
        const viewerSnap = await viewerPage.evaluate(() => ({
          hasButton: !!document.getElementById('new-customer-btn'),
        }));
        record(UI_LABELS[6],
          'no #new-customer-btn in the rendered page for viewer',
          `hasButton=${viewerSnap.hasButton}`,
          viewerSnap.hasButton === false);
        await closePage(viewerPage);
      } finally {
        await browser.close().catch(() => {});
      }
    }
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
    '# New Customer Flow — E2E Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:new-customer-flow\``,
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
    '- **[API] `POST /api/contacts`** — sends the dialog payload as a member',
    '  user and asserts a 201 with a generated `customer_number`. The mock',
    '  HubSpot server records the request so the test can assert the exact',
    '  properties forwarded (firstname/lastname/email/phone/zip plus the',
    '  hard-coded `hs_lead_status=OPEN_DEAL`).',
    '- **[UI] member /customers** — verifies the `#new-customer-btn` is',
    '  rendered, opens the dialog, fills the form, submits it, and asserts the',
    '  mock HubSpot create endpoint received the typed values and the new',
    '  contact email appears in `#customers-results` (refresh path).',
    '- **[UI] member /customers?new=1** — asserts the dialog auto-opens.',
    '- **[UI] viewer /customers** — asserts the `#new-customer-btn` is not in',
    '  the rendered page (matches `useIsViewer` gating in `CustomersPage.tsx`).',
    '',
    '## Notes',
    '',
    '- The privileges harness strips `HUBSPOT_ACCESS_TOKEN`, so the suite',
    '  boots its own mock HubSpot HTTP server and passes',
    '  `HUBSPOT_API_URL=http://127.0.0.1:<port>` plus a dummy',
    '  `HUBSPOT_ACCESS_TOKEN` to the spawned Express server via `extraEnv`.',
    '  The mock handles `/crm/v3/properties/contacts` (409 to skip the',
    '  ensure-properties bootstrap), `/crm/v3/objects/contacts/search` (empty',
    '  page), `POST /crm/v3/objects/contacts` (create) and the follow-up',
    '  `PATCH …/:id` for the generated `customer_number`.',
  ];
  const outPath = path.join(dir, 'new-customer-flow.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Report: test-results/new-customer-flow.md`);
}

main();
