'use strict';
// test/invoice-bc-sync/run.js
//
// Puppeteer probe for task #1760: when an admin saves an invoice in
// InvoiceDetailDrawer (via the "Save changes" button), the drawer posts a
// { type: 'invoice-saved' } message on the 'mo_invoices' BroadcastChannel.
// Both InvoicesSection (customer-detail) and StandaloneInvoicesPage subscribe
// to that channel and call qb.refresh() in response.  This test exercises the
// full path from the UI save action through to the cross-tab refresh.
//
// Two probes — each opens a listener page and a separate sender page in the
// same browser so BroadcastChannel messages route correctly:
//
//   (BC-A) Customer-detail InvoicesSection listener: the admin opens
//          InvoiceDetailDrawer on a second tab by clicking an invoice row,
//          then clicks "Save changes" (POST stubbed to return success),
//          which fires the BC event from production code in
//          InvoiceDetailDrawer.tsx.  Asserts the listener tab makes a second
//          GET /api/quickbooks/invoices without a full page reload.
//
//   (BC-B) StandaloneInvoicesPage listener: same save action on the sender
//          tab; asserts the /invoices listener tab re-fetches without reload.
//
// Both probes use fetch interception (evaluateOnNewDocument) to stub all API
// calls and track invoice-list fetches via window.__invoiceFetchCount.  A
// window.__pageLoadToken (set once per page load) confirms no full reload.
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:invoice-bc-sync
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:invoice-bc-sync

const fs   = require('fs');
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
  BASE,
} = require('../privileges/harness');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

require('dotenv').config();

const { pollUntil } = require('../helpers/poll');

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'invoice-bc-sync.md',
);

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

// ── Fixture data ──────────────────────────────────────────────────────────────

const FAKE_CONTACT_ID = '77777';
const FAKE_INV_ID     = 'bcsync-inv-001';
const FAKE_EMAIL      = 'bcsync@example.com';

const FAKE_CONTACT = {
  id: FAKE_CONTACT_ID,
  properties: {
    firstname: 'BC', lastname: 'Sync', email: FAKE_EMAIL,
    company: 'BC Corp', phone: '', hs_lead_status: null,
  },
};

// InvoiceSummary shape (camelCase from server — see InvoiceDetailDrawer.tsx).
// matchInvoices() compares inv.email to contact.properties.email and
// inv.customerName to contact.properties.company, so both must match.
const FAKE_INVOICE_SUMMARY = {
  id:           FAKE_INV_ID,
  docNumber:    'INV-BC-001',
  customerName: 'BC Corp',
  email:        FAKE_EMAIL,
  balance:      1000,
  totalAmt:     1000,
  dueDate:      '2026-02-01',
  txnDate:      '2025-01-01',
};

// InvoiceDetail shape — returned by GET /api/quickbooks/invoice/:id.
const FAKE_INVOICE_DETAIL = {
  id:           FAKE_INV_ID,
  docNumber:    'INV-BC-001',
  customerName: 'BC Corp',
  email:        FAKE_EMAIL,
  balance:      1000,
  totalAmt:     1000,
  dueDate:      '2026-02-01',
  txnDate:      '2025-01-01',
  syncToken:    '0',
  memo:         null,
  lines:        [],
};

// POST /api/quickbooks/invoice/:id — successful save response.
const FAKE_SAVE_RESPONSE = { syncToken: '1' };

const FAKE_CONTACT_JSON       = JSON.stringify(FAKE_CONTACT);
const FAKE_INVOICES_JSON      = JSON.stringify({ invoices: [FAKE_INVOICE_SUMMARY] });
const FAKE_INVOICE_DETAIL_JSON = JSON.stringify(FAKE_INVOICE_DETAIL);
const FAKE_SAVE_RESPONSE_JSON  = JSON.stringify(FAKE_SAVE_RESPONSE);

// ── Fetch interceptor injected into every page ─────────────────────────────────
//
// Stubs all API calls so the test works without real QB / HubSpot tokens.
//
// Tracked state (all pages):
//   window.__invoiceFetchCount  — increments on every GET /api/quickbooks/invoices
//   window.__pageLoadToken      — set once per page load (reload detection)
//   window.__invoiceSaveCalled  — set true when POST /api/quickbooks/invoice/:id
//                                 is intercepted (confirms production code path)
//   window.__unstubbed          — logs any api path not matched by a stub rule
//
// Listener-only state (isListener = true):
//   window.__moInvoicesMsgCount — increments on every 'mo_invoices' BC message
//                                 received.  The BroadcastChannel constructor is
//                                 overridden to:
//                                   - Silence 'qb-invoices-sync' messages (swallow
//                                     the onmessage setter via Proxy) so the
//                                     qbInvoicesStore cross-tab broadcast cannot
//                                     trigger a re-fetch — leaving 'mo_invoices'
//                                     as the only possible re-fetch trigger.
//                                   - Wrap the 'mo_invoices' onmessage handler to
//                                     count each received message before calling
//                                     the real handler.
//
// NOTE: Puppeteer serialises this via evaluateOnNewDocument(fn, arg1, …).
// Must be a plain named function — no closures over outer Node.js variables.

function pageInterceptFetch(contactId, contactJson, invoicesJson, invDetailJson, saveResponseJson, isListener) {
  window.__invoiceFetchCount  = 0;
  window.__pageLoadToken      = Math.random().toString(36).slice(2);
  window.__invoiceSaveCalled  = false;
  window.__unstubbed          = [];
  window.__moInvoicesMsgCount = 0;

  // ── BroadcastChannel isolation (listener pages only) ─────────────────────
  // On listener pages we override BroadcastChannel so that:
  //   1. 'qb-invoices-sync' messages are silenced — the qbInvoicesStore
  //      cross-tab refresh broadcast from the sender cannot trigger a re-fetch
  //      on the listener, isolating 'mo_invoices' as the only trigger.
  //   2. 'mo_invoices' messages are counted so we can assert the exact path.
  // The sender page is left un-patched so its store still posts 'qb-invoices-sync'
  // (confirming the full production flow runs), we just don't let the listener
  // react to that channel.
  if (isListener) {
    var _OrigBC = window.BroadcastChannel;
    window.BroadcastChannel = function PatchedBroadcastChannel(name) {
      var ch = new _OrigBC(name);

      if (name === 'qb-invoices-sync') {
        // Return a proxy whose onmessage setter is a no-op.
        // qbInvoicesStore does `_bc.onmessage = handler` — swallowing this
        // means incoming 'qb-invoices-sync' messages never fire the store's
        // refresh callback on this (listener) tab.
        return new Proxy(ch, {
          set: function(target, prop, value) {
            if (prop === 'onmessage') return true; // swallow
            target[prop] = value;
            return true;
          },
        });
      }

      if (name === 'mo_invoices') {
        // Return a proxy that wraps the onmessage handler to count messages.
        // InvoicesSection / StandaloneInvoicesPage do `bc.onmessage = handler`.
        // Our wrapper increments __moInvoicesMsgCount before calling through.
        return new Proxy(ch, {
          set: function(target, prop, value) {
            if (prop === 'onmessage') {
              target[prop] = function(e) {
                window.__moInvoicesMsgCount += 1;
                if (value) value.call(target, e);
              };
              return true;
            }
            target[prop] = value;
            return true;
          },
        });
      }

      return ch;
    };
  }
  // ─────────────────────────────────────────────────────────────────────────

  const origFetch = window.fetch;
  window.fetch = function(input, init) {
    const url      = typeof input === 'string' ? input : (input && input.url) || '';
    const method   = (init && init.method) ? init.method.toUpperCase() : 'GET';
    const pathname = url.startsWith('http') ? new URL(url).pathname : url.split('?')[0];

    // Auth / user info — fall through to the real session-authenticated server.
    if (pathname === '/api/auth/user' || pathname === '/api/auth/me') {
      return origFetch.call(this, input, init);
    }

    // Contact detail and all sub-paths (notes, tasks, emails, timeline, etc.)
    if (pathname === '/api/contacts/' + contactId) {
      return Promise.resolve(new Response(contactJson, {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }
    if (pathname.startsWith('/api/contacts/' + contactId + '/')) {
      return Promise.resolve(new Response('[]', {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }

    // QB status
    if (pathname === '/api/quickbooks/status') {
      return Promise.resolve(new Response(
        JSON.stringify({ connected: true, company: 'Test QB Co' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }
      ));
    }

    // Invoice list — tracked for cross-tab re-fetch assertion
    if (pathname === '/api/quickbooks/invoices') {
      window.__invoiceFetchCount += 1;
      return Promise.resolve(new Response(invoicesJson, {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }

    // Invoice SAVE — POST /api/quickbooks/invoice/:id
    if (/^\/api\/quickbooks\/invoice\/[^/]+$/.test(pathname) && method === 'POST') {
      window.__invoiceSaveCalled = true;
      return Promise.resolve(new Response(saveResponseJson, {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }

    // Invoice DETAIL — GET /api/quickbooks/invoice/:id
    if (/^\/api\/quickbooks\/invoice\/[^/]+$/.test(pathname) && method === 'GET') {
      return Promise.resolve(new Response(invDetailJson, {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }

    // Lead statuses / substatuses
    if (pathname === '/api/lead-statuses' || pathname === '/api/lead-substatuses') {
      return Promise.resolve(new Response('[]', {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }

    // Workflow JSON
    if (pathname === '/api/workflow') {
      return Promise.resolve(new Response(JSON.stringify({ stages: {} }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }

    // Design-visits, visits, emails, whatsapp, calendar, open-leads, counts
    if (pathname.startsWith('/api/design-visits') ||
        pathname.startsWith('/api/visits') ||
        pathname.startsWith('/api/whatsapp') ||
        pathname.startsWith('/api/calendar') ||
        pathname.startsWith('/api/open-leads') ||
        pathname.startsWith('/api/contacts-lead-status-counts')) {
      return Promise.resolve(new Response('[]', {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }
    if (pathname.startsWith('/api/emails')) {
      return Promise.resolve(new Response(
        JSON.stringify({ connected: false, emails: [] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }
      ));
    }

    // Customer-info submissions — array of Submission objects
    if (pathname.startsWith('/api/customer-info/by-contact/')) {
      return Promise.resolve(new Response('[]', {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }

    // localdata — expects an array
    if (pathname === '/api/localdata/all' || pathname.startsWith('/api/localdata/')) {
      return Promise.resolve(new Response('[]', {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }

    // Integration / service status endpoints — return disconnected/safe defaults
    if (pathname === '/api/hubspot/status') {
      return Promise.resolve(new Response(
        JSON.stringify({ connected: false }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }
      ));
    }
    if (pathname === '/api/google/status') {
      return Promise.resolve(new Response(
        JSON.stringify({ connected: false }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }
      ));
    }
    if (pathname === '/api/database/status') {
      return Promise.resolve(new Response(
        JSON.stringify({ ok: true }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }
      ));
    }

    // User prefs, nav config, search settings, turnstile — safe empty objects
    if (pathname === '/api/users/me/prefs' ||
        pathname === '/api/nav-role-config' ||
        pathname === '/api/search-settings' ||
        pathname === '/api/turnstile-config') {
      return Promise.resolve(new Response('{}', {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }

    // Admin counts — return zero
    if (pathname === '/api/admin/pending-count') {
      return Promise.resolve(new Response(
        JSON.stringify({ count: 0 }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }
      ));
    }

    // Catch-all for any remaining /api/ path — log the unstubbed path and
    // return an empty object so nothing leaks to the real server.
    if (pathname.startsWith('/api/')) {
      window.__unstubbed.push(method + ' ' + pathname);
      return Promise.resolve(new Response('{}', {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }

    // Static assets (JS chunks, CSS, HTML) — fall through to real server.
    return origFetch.call(this, input, init);
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function setupListenerPage(browser, cookie) {
  const page = await browser.newPage();
  await page.setCacheEnabled(false);
  await page.evaluateOnNewDocument(
    pageInterceptFetch,
    FAKE_CONTACT_ID,
    FAKE_CONTACT_JSON,
    FAKE_INVOICES_JSON,
    FAKE_INVOICE_DETAIL_JSON,
    FAKE_SAVE_RESPONSE_JSON,
    true, // isListener=true → silence qb-invoices-sync, track mo_invoices messages
  );
  await injectSession(page, cookie);
  return page;
}

// Open a sender page, click the first invoice row to open the drawer, then
// click "Save changes".  Exercises the full production code path:
//   click inv row → InvoiceDetailDrawer opens → invoice loaded → user clicks
//   "Save changes" → POST /api/quickbooks/invoice/:id (stubbed to succeed) →
//   InvoiceDetailDrawer fires new BroadcastChannel('mo_invoices').postMessage(…)
//
// Returns { page, ok, saveCalled, detail } where ok=true means the Saved
// confirmation appeared in the drawer UI.
async function runSenderSave(browser, cookie) {
  const page = await browser.newPage();
  await page.setCacheEnabled(false);

  const senderLogs = [];
  page.on('console',   m => senderLogs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => senderLogs.push(`[pageerror] ${e.message}`));

  await page.evaluateOnNewDocument(
    pageInterceptFetch,
    FAKE_CONTACT_ID,
    FAKE_CONTACT_JSON,
    FAKE_INVOICES_JSON,
    FAKE_INVOICE_DETAIL_JSON,
    FAKE_SAVE_RESPONSE_JSON,
    false, // isListener=false → sender; do not patch BroadcastChannel
  );
  await injectSession(page, cookie);

  const url = `${BASE}/customers/${FAKE_CONTACT_ID}`;
  console.log(`  Sender: loading ${url}`);
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (!resp || !resp.ok()) {
    await page.close().catch(() => {});
    return { page: null, ok: false, detail: `sender page load failed: ${resp ? resp.status() : 0}` };
  }

  // Wait for the invoice row to appear in the rendered list.
  // InvoicesSection renders .inv-row elements once qb.loaded=true and
  // matchInvoices() returns at least one result.
  console.log('  Sender: waiting for invoice row (.inv-row)…');
  const rowFound = await pollUntil(page, () => {
    const row = document.querySelector('.inv-row');
    return row ? 'found' : null;
  }, 15000, 300);

  if (rowFound !== 'found') {
    const unstubbed = await page.evaluate(() => window.__unstubbed || []).catch(() => []);
    const cnt = await page.evaluate(() => window.__invoiceFetchCount || 0).catch(() => 0);
    await page.close().catch(() => {});
    return {
      page: null, ok: false,
      detail: `invoice row not found (fetchCount=${cnt}, unstubbed=${JSON.stringify(unstubbed)}); logs: ${senderLogs.slice(-10).join(' | ')}`,
    };
  }
  console.log('  Sender: invoice row found — clicking…');

  // Click the first invoice row to open InvoiceDetailDrawer.
  await page.click('.inv-row');

  // Wait for the "Save changes" button to appear in the drawer.
  // It renders when isAdmin=true and the invoice detail has been fetched.
  console.log('  Sender: waiting for "Save changes" button…');
  const saveButtonFound = await pollUntil(page, () => {
    const btns = Array.from(document.querySelectorAll('[data-testid="invoice-detail-drawer"] button'));
    return btns.some(b => b.textContent.trim() === 'Save changes') ? 'found' : null;
  }, 10000, 200);

  if (saveButtonFound !== 'found') {
    const unstubbed = await page.evaluate(() => window.__unstubbed || []).catch(() => []);
    await page.close().catch(() => {});
    return {
      page: null, ok: false,
      detail: `"Save changes" button not found — user may not be admin or invoice detail failed to load; unstubbed=${JSON.stringify(unstubbed)}; logs: ${senderLogs.slice(-8).join(' | ')}`,
    };
  }
  console.log('  Sender: "Save changes" button found — clicking…');

  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('[data-testid="invoice-detail-drawer"] button'));
    const saveBtn = btns.find(b => b.textContent.trim() === 'Save changes');
    if (saveBtn) saveBtn.click();
  });

  // Wait for the "Saved" confirmation to appear, confirming handleSave()
  // completed successfully and fired the BC event.
  const savedMsg = await pollUntil(page, () => {
    const drawer = document.querySelector('[data-testid="invoice-detail-drawer"]');
    if (!drawer) return null;
    return (drawer.textContent || '').includes('Saved') ? 'saved' : null;
  }, 8000, 200);

  if (savedMsg !== 'saved') {
    const isSaveCalled = await page.evaluate(() => window.__invoiceSaveCalled).catch(() => false);
    const unstubbed    = await page.evaluate(() => window.__unstubbed || []).catch(() => []);
    await page.close().catch(() => {});
    return {
      page: null, ok: false,
      detail: `"Saved" msg never appeared (POST intercepted=${isSaveCalled}); unstubbed=${JSON.stringify(unstubbed)}; logs: ${senderLogs.slice(-8).join(' | ')}`,
    };
  }
  console.log('  Sender: "Saved" confirmation seen — BC event fired from production code');

  const saveCalled = await page.evaluate(() => window.__invoiceSaveCalled).catch(() => false);
  const unstubbed  = await page.evaluate(() => window.__unstubbed || []).catch(() => []);
  if (unstubbed.length > 0) {
    console.log(`  Sender: unstubbed api calls (catch-all used): ${unstubbed.join(', ')}`);
  }

  return { page, ok: true, saveCalled, detail: '' };
}

// ── Report ─────────────────────────────────────────────────────────────────────

async function writeReport(runId) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok).length;
  const lines = [
    '# Invoice BroadcastChannel sync — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:invoice-bc-sync\``,
    '',
    '## Summary',
    '',
    `- Passed: ${passed} / ${findings.length}`,
    `- Failed: ${failed} / ${findings.length}`,
    '',
    '## Results',
    '',
    '| Result | Probe | Expected | Observed |',
    '|---|---|---|---|',
    ...findings.map(f =>
      `| ${f.ok ? 'PASS' : 'FAIL'} | ${esc(f.name)} | ${esc(f.expected)} | ${esc(f.observed)} |`
    ),
    '',
    '## Coverage',
    '',
    '- **(BC-A)** Customer-detail `InvoicesSection` listener: the admin opens',
    '  `InvoiceDetailDrawer` in a second tab by clicking an invoice row, then',
    '  clicks "Save changes" (POST stubbed).  On success, `handleSave()` in',
    '  `InvoiceDetailDrawer.tsx` fires',
    '  `new BroadcastChannel(\'mo_invoices\').postMessage({ type: \'invoice-saved\' })`.',
    '  Asserts the listener tab makes a second `GET /api/quickbooks/invoices`',
    '  without a full page reload.',
    '- **(BC-B)** `StandaloneInvoicesPage` listener: same save action on the',
    '  sender tab; asserts the `/invoices` listener tab re-fetches without',
    '  reload.',
    '',
    '## Relevant files',
    '',
    '- `src/react/components/InvoiceDetailDrawer.tsx` — fires BC event after save',
    '- `src/react/pages/customer-detail/InvoicesSection.tsx` — BC listener',
    '- `src/react/pages/StandaloneInvoicesPage.tsx` — BC listener',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
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

  const runId = Math.random().toString(36).slice(2, 8);
  console.log(`\n  invoice-bc-sync  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);
  await cleanupTestData(pool);

  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  admin=${users.admin.email}`);

  const { child, logBuf } = spawnServer();
  let exited = false;
  child.on('exit', () => { exited = true; });

  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    await writeReport(runId);
    process.exit(code);
  };
  process.on('SIGINT',  () => cleanupAndExit(130));
  process.on('SIGTERM', () => cleanupAndExit(130));
  process.on('uncaughtException',  e => { console.error('Uncaught:',  e); cleanupAndExit(2); });
  process.on('unhandledRejection', e => { console.error('Unhandled:', e); cleanupAndExit(2); });

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

  const adminClient = await login(users.admin.email, users.admin.password);

  const UI_LABELS = [
    '[BC-A] POST /api/quickbooks/invoice/:id intercepted (production code reached)',
    '[BC-A] listener tab received a mo_invoices message (BC event delivered)',
    '[BC-A] InvoicesSection re-fetches invoices after mo_invoices message',
    '[BC-A] re-fetch occurs without a full page reload',
    '[BC-B] POST /api/quickbooks/invoice/:id intercepted (production code reached)',
    '[BC-B] listener tab received a mo_invoices message (BC event delivered)',
    '[BC-B] StandaloneInvoicesPage re-fetches invoices after mo_invoices message',
    '[BC-B] re-fetch occurs without a full page reload',
  ];

  if (!puppeteer) {
    for (const l of UI_LABELS) record(l, 'puppeteer installed', 'puppeteer not installed', false);
    await cleanupAndExit(1);
    return;
  }

  const { findChromium } = require('../shared/find-chromium');
  let browser = null;
  let browserLaunchErr = null;
  const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
  const launchAttempts = [{ args: launchArgs }];
  const sysChrome = findChromium();
  if (sysChrome) launchAttempts.push({ executablePath: sysChrome, args: launchArgs });
  for (const opts of launchAttempts) {
    try {
      browser = await puppeteer.launch({
        headless: true,
        defaultViewport: { width: 1280, height: 900 },
        ...opts,
      });
      browserLaunchErr = null;
      break;
    } catch (e) { browserLaunchErr = e; browser = null; }
  }

  if (!browser) {
    for (const l of UI_LABELS) {
      record(l, 'browser launches', `error: ${browserLaunchErr?.message}`, false);
    }
    await cleanupAndExit(1);
    return;
  }

  let listenerPageA = null;
  let listenerPageB = null;

  try {

    // ── Probe BC-A: InvoicesSection (customer-detail) listener ───────────────
    console.log('\n  ─── Probe BC-A: InvoicesSection (customer-detail) listener ───');

    listenerPageA = await setupListenerPage(browser, adminClient.cookie);
    const logsA = [];
    listenerPageA.on('console',   m => logsA.push(`[${m.type()}] ${m.text()}`));
    listenerPageA.on('pageerror', e => logsA.push(`[pageerror] ${e.message}`));

    const urlA = `${BASE}/customers/${FAKE_CONTACT_ID}`;
    console.log(`  Listener A: loading ${urlA}`);
    const respA = await listenerPageA.goto(urlA, { waitUntil: 'domcontentloaded', timeout: 30000 });

    if (!respA || !respA.ok()) {
      for (const l of UI_LABELS.slice(0, 3)) {
        record(l, 'listener page loads (200)', `${respA ? respA.status() : 0}`, false);
      }
    } else {
      console.log('  Listener A: waiting for initial invoice fetch…');
      const initialFetchA = await pollUntil(
        listenerPageA,
        () => (window.__invoiceFetchCount >= 1 ? window.__invoiceFetchCount : null),
        15000, 200,
      );

      if (!initialFetchA) {
        const unstubbed = await listenerPageA.evaluate(() => window.__unstubbed || []).catch(() => []);
        for (const l of UI_LABELS.slice(0, 3)) {
          record(l, 'fetch count >= 1 after initial load', 'never reached 1',
            false, `unstubbed=${JSON.stringify(unstubbed)}; logs: ${logsA.slice(-10).join(' | ')}`);
        }
      } else {
        console.log(`  Listener A: initial fetch count = ${initialFetchA}`);

        // Snapshot page token and fetch count before the save action.
        const tokenBeforeA = await listenerPageA.evaluate(() => window.__pageLoadToken).catch(() => null);
        const countBeforeA = await listenerPageA.evaluate(() => window.__invoiceFetchCount).catch(() => 0);

        // Run the full UI save flow in a second tab:
        //   click invoice row → drawer opens → invoice detail loads →
        //   click "Save changes" → POST intercepted (success) →
        //   InvoiceDetailDrawer fires BC event from production code.
        const sender = await runSenderSave(browser, adminClient.cookie);

        if (!sender.ok) {
          for (const l of UI_LABELS.slice(0, 4)) {
            record(l, 'sender save succeeded', `sender failed: ${sender.detail}`, false);
          }
        } else {
          // Assert 1: the POST save endpoint was intercepted, confirming
          // handleSave() in InvoiceDetailDrawer ran (production code path).
          record(
            '[BC-A] POST /api/quickbooks/invoice/:id intercepted (production code reached)',
            '__invoiceSaveCalled = true',
            `__invoiceSaveCalled = ${sender.saveCalled}`,
            !!sender.saveCalled,
          );

          // Assert 2: the listener tab received a 'mo_invoices' message.
          // Because qb-invoices-sync messages are silenced on this tab, only
          // the mo_invoices BroadcastChannel event can deliver this message.
          console.log('  Listener A: waiting for mo_invoices message…');
          const moCountA = await pollUntil(
            listenerPageA,
            () => (window.__moInvoicesMsgCount >= 1 ? window.__moInvoicesMsgCount : null),
            10000, 150,
          );

          record(
            '[BC-A] listener tab received a mo_invoices message (BC event delivered)',
            '__moInvoicesMsgCount >= 1',
            moCountA ? `__moInvoicesMsgCount = ${moCountA}` : '__moInvoicesMsgCount = 0 (no message received)',
            !!moCountA,
            moCountA ? '' : logsA.slice(-10).join(' | '),
          );

          // Assert 3: the mo_invoices message caused qb.refresh() → re-fetch.
          const expectedCountA = countBeforeA + 1;
          console.log(`  Listener A: waiting for fetch count to reach ${expectedCountA}…`);
          const countAfterA = await pollUntil(
            listenerPageA,
            (expected) => (window.__invoiceFetchCount >= expected ? window.__invoiceFetchCount : null),
            12000, 200,
            [expectedCountA],
          );

          record(
            '[BC-A] InvoicesSection re-fetches invoices after mo_invoices message',
            `fetch count >= ${expectedCountA}`,
            countAfterA
              ? `fetch count = ${countAfterA}`
              : `timed out; count still at ${countBeforeA}`,
            !!countAfterA,
            countAfterA ? '' : logsA.slice(-15).join(' | '),
          );

          // Assert 4: no full page reload occurred.
          const tokenAfterA  = await listenerPageA.evaluate(() => window.__pageLoadToken).catch(() => null);
          const noReloadA    = tokenAfterA !== null && tokenAfterA === tokenBeforeA;
          record(
            '[BC-A] re-fetch occurs without a full page reload',
            'page-load token unchanged after BC re-fetch',
            noReloadA
              ? `token preserved (${tokenAfterA})`
              : `token changed: before=${tokenBeforeA} after=${tokenAfterA}`,
            noReloadA,
          );

          await sender.page.close().catch(() => {});
        }
      }
    }

    // ── Probe BC-B: StandaloneInvoicesPage (/invoices) listener ─────────────
    console.log('\n  ─── Probe BC-B: StandaloneInvoicesPage (/invoices) listener ───');

    listenerPageB = await setupListenerPage(browser, adminClient.cookie);
    const logsB = [];
    listenerPageB.on('console',   m => logsB.push(`[${m.type()}] ${m.text()}`));
    listenerPageB.on('pageerror', e => logsB.push(`[pageerror] ${e.message}`));

    const urlB = `${BASE}/invoices`;
    console.log(`  Listener B: loading ${urlB}`);
    const respB = await listenerPageB.goto(urlB, { waitUntil: 'domcontentloaded', timeout: 30000 });

    if (!respB || !respB.ok()) {
      for (const l of UI_LABELS.slice(4)) {
        record(l, 'listener page loads (200)', `${respB ? respB.status() : 0}`, false);
      }
    } else {
      console.log('  Listener B: waiting for initial invoice fetch…');
      const initialFetchB = await pollUntil(
        listenerPageB,
        () => (window.__invoiceFetchCount >= 1 ? window.__invoiceFetchCount : null),
        15000, 200,
      );

      if (!initialFetchB) {
        const unstubbed = await listenerPageB.evaluate(() => window.__unstubbed || []).catch(() => []);
        for (const l of UI_LABELS.slice(4)) {
          record(l, 'fetch count >= 1 after initial load', 'never reached 1',
            false, `unstubbed=${JSON.stringify(unstubbed)}; logs: ${logsB.slice(-10).join(' | ')}`);
        }
      } else {
        console.log(`  Listener B: initial fetch count = ${initialFetchB}`);

        const tokenBeforeB = await listenerPageB.evaluate(() => window.__pageLoadToken).catch(() => null);
        const countBeforeB = await listenerPageB.evaluate(() => window.__invoiceFetchCount).catch(() => 0);

        const senderB = await runSenderSave(browser, adminClient.cookie);

        if (!senderB.ok) {
          for (const l of UI_LABELS.slice(4)) {
            record(l, 'sender save succeeded', `sender failed: ${senderB.detail}`, false);
          }
        } else {
          // Assert 1: production save endpoint intercepted.
          record(
            '[BC-B] POST /api/quickbooks/invoice/:id intercepted (production code reached)',
            '__invoiceSaveCalled = true',
            `__invoiceSaveCalled = ${senderB.saveCalled}`,
            !!senderB.saveCalled,
          );

          // Assert 2: listener tab received a 'mo_invoices' message specifically.
          // qb-invoices-sync is silenced on this tab — only mo_invoices can fire.
          console.log('  Listener B: waiting for mo_invoices message…');
          const moCountB = await pollUntil(
            listenerPageB,
            () => (window.__moInvoicesMsgCount >= 1 ? window.__moInvoicesMsgCount : null),
            10000, 150,
          );

          record(
            '[BC-B] listener tab received a mo_invoices message (BC event delivered)',
            '__moInvoicesMsgCount >= 1',
            moCountB ? `__moInvoicesMsgCount = ${moCountB}` : '__moInvoicesMsgCount = 0 (no message received)',
            !!moCountB,
            moCountB ? '' : logsB.slice(-10).join(' | '),
          );

          // Assert 3: StandaloneInvoicesPage re-fetches after the mo_invoices message.
          const expectedCountB = countBeforeB + 1;
          console.log(`  Listener B: waiting for fetch count to reach ${expectedCountB}…`);
          const countAfterB = await pollUntil(
            listenerPageB,
            (expected) => (window.__invoiceFetchCount >= expected ? window.__invoiceFetchCount : null),
            12000, 200,
            [expectedCountB],
          );

          record(
            '[BC-B] StandaloneInvoicesPage re-fetches invoices after mo_invoices message',
            `fetch count >= ${expectedCountB}`,
            countAfterB
              ? `fetch count = ${countAfterB}`
              : `timed out; count still at ${countBeforeB}`,
            !!countAfterB,
            countAfterB ? '' : logsB.slice(-15).join(' | '),
          );

          // Assert 4: no full page reload occurred.
          const tokenAfterB = await listenerPageB.evaluate(() => window.__pageLoadToken).catch(() => null);
          const noReloadB   = tokenAfterB !== null && tokenAfterB === tokenBeforeB;
          record(
            '[BC-B] re-fetch occurs without a full page reload',
            'page-load token unchanged after BC re-fetch',
            noReloadB
              ? `token preserved (${tokenAfterB})`
              : `token changed: before=${tokenBeforeB} after=${tokenAfterB}`,
            noReloadB,
          );

          await senderB.page.close().catch(() => {});
        }
      }
    }

  } catch (e) {
    record('test harness', 'no error', `error: ${e.message}`, false,
      (logBuf || []).slice(-20).join(''));
  } finally {
    if (listenerPageA) await listenerPageA.close().catch(() => {});
    if (listenerPageB) await listenerPageB.close().catch(() => {});
    if (browser)       await browser.close().catch(() => {});
  }

  const pass = findings.filter(f => f.ok).length;
  const fail = findings.filter(f => !f.ok).length;
  console.log(`\n  Results: ${pass} passed, ${fail} failed`);
  await cleanupAndExit(fail > 0 ? 1 : 0);
}

main();
