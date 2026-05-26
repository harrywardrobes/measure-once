'use strict';
// test/survey-board/run.js
//
// End-to-end Puppeteer test for the SurveyBoardPage React component.
//
// Covers:
//   (A) Single-column layout — Survey column header present with correct label
//   (B) Card content — contact name, stage pill, substage pill, source pill,
//       stage trail labels, and "Updated" timestamp all appear in the card body
//   (C) Terminal card is de-emphasised — opacity ≈ 0.55 for a contact whose
//       room statusId is in SURVEY_TERMINAL_SUBSTAGES (e.g. 'unqualified')
//   (D) Card body click navigates to /customers/:id
//   (E) Filter button opens the substage popover; unchecking a substage hides
//       matching cards; re-checking the substage shows them again
//   (F) Action strip renders when cardActionHandlerFor returns a handler
//   (G) Snackbar visibility pause — refresh-failure Snackbar stays visible when
//       the tab is hidden (timer paused), then dismisses after tab returns
//
// React mount timing note: SurveyBoardPage is a React.lazy chunk.  The browser
// loads the chunk asynchronously after the module entry point executes.
// Puppeteer's `waitUntil:'domcontentloaded'` resolves before the lazy chunk
// has mounted.  Each probe therefore calls waitForReactMount() before
// seedSurveyBoard() so the DATA_READY_EVENT listener is registered before we
// dispatch.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:survey-board
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:survey-board

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
  PASSWORD,
  BASE,
} = require('../privileges/harness');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

require('dotenv').config();

// ── Test fixtures ──────────────────────────────────────────────────────────────

const NOW = Date.now();

// Three contacts — all with survey-stage rooms so they appear on the board:
//   sv-test-001  Jane Survey   — normal, substage 'design_accepted', source 'website'
//   sv-test-002  Bob Terminal  — terminal, substage 'unqualified', no source
//   sv-test-003  Alice Filter  — terminal, substage 'bad_timing' (used for filter probe)
const CONTACTS = [
  {
    id: 'sv-test-001',
    properties: {
      firstname: 'Jane',
      lastname: 'Survey',
      email: 'jane@svtest.local',
      zip: 'SW1A 1AA',
      hs_lead_status: '',
      lastmodifieddate: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
      createdate: String(NOW - 24 * 60 * 60 * 1000),
    },
  },
  {
    id: 'sv-test-002',
    properties: {
      firstname: 'Bob',
      lastname: 'Terminal',
      email: 'bob@svtest.local',
      zip: 'EC1A 1BB',
      hs_lead_status: '',
      lastmodifieddate: new Date(NOW - 48 * 60 * 60 * 1000).toISOString(),
      createdate: String(NOW - 2 * 24 * 60 * 60 * 1000),
    },
  },
  {
    id: 'sv-test-003',
    properties: {
      firstname: 'Alice',
      lastname: 'Filter',
      email: 'alice@svtest.local',
      zip: 'W1A 1CC',
      hs_lead_status: '',
      lastmodifieddate: new Date(NOW - 3 * 60 * 60 * 1000).toISOString(),
      createdate: String(NOW - 3 * 24 * 60 * 60 * 1000),
    },
  },
];

const CONTACT_STAGE_CACHE = {
  'sv-test-001': [{
    stageKey: 'survey',
    statusId: 'design_accepted',
    roomStatus: 'active',
    sourceId: 'website',
    stageDates: { survey: '2024-03-01' },
    substateDates: { design_accepted: '2024-03-01' },
  }],
  'sv-test-002': [{
    stageKey: 'survey',
    statusId: 'unqualified',    // SURVEY_TERMINAL_SUBSTAGES → opacity 0.55
    roomStatus: 'active',
    sourceId: '',
    stageDates: { survey: '2024-02-15' },
    substateDates: {},
  }],
  'sv-test-003': [{
    stageKey: 'survey',
    statusId: 'bad_timing',     // terminal, visible by default (not in default hidden set)
    roomStatus: 'active',
    sourceId: '',
    stageDates: { survey: '2024-02-10' },
    substateDates: {},
  }],
};

const WORKFLOW = {
  stages: {
    sales:       { label: 'Sales',        statuses: [] },
    designvisit: { label: 'Design Visit', statuses: [] },
    survey: {
      label: 'Survey',
      statuses: [
        { id: 'design_accepted', label: 'Design Accepted' },
        { id: 'booked',          label: 'Booked' },
        { id: 'unqualified',     label: 'Unqualified' },
        { id: 'not_suitable',    label: 'Not Suitable' },
        { id: 'bad_timing',      label: 'Bad Timing' },
        { id: 'no_response_x3',  label: 'No Response ×3' },
      ],
    },
  },
};

const LEAD_STATUS_OPTIONS = [];

// ── Helpers ────────────────────────────────────────────────────────────────────

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
  await page.setCookie({ name: kv.name, value: kv.value, domain: hostname, path: '/', httpOnly: true });
}

function findChromium() {
  const { findChromium: shared } = require('../shared/find-chromium');
  return shared() || undefined;
}

// Poll a predicate (run in page context) until it returns truthy or timeout.
async function pollPage(page, fn, arg, timeoutMs = 12000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch {}
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

// Wait for React to mount SurveyBoardPage by detecting the outer flex-column
// Box it always renders (even with empty data).  The React.lazy chunk is
// fetched asynchronously, so DOMContentLoaded may fire before the component
// mounts.
//
// DOM structure (AppThemeProvider wraps every island in MuiScopedCssBaseline):
//   #survey-board-mount          ← React root
//     div.MuiScopedCssBaseline   ← AppThemeProvider shell
//       div (flex column)        ← SurveyBoardPage outer Box
//         div (column header)
//         div (card list)
async function waitForReactMount(page) {
  return pollPage(page, () => {
    const mount = document.getElementById('survey-board-mount');
    if (!mount) return false;
    const themed = mount.firstElementChild;          // MuiScopedCssBaseline wrapper
    if (!themed) return false;
    const board = themed.firstElementChild;          // SurveyBoardPage outer Box
    if (!board) return false;
    // Header + card-list are always present once SurveyBoardPage has rendered.
    return board.children.length >= 2;
  }, null, 20000);
}

// Inject window.state globals then fire the DATA_READY_EVENT so the component
// re-renders with the fixture contacts.  Always call waitForReactMount() first.
//
// We clear surveyHiddenSubstages from localStorage so default state is
// predictable: 'unqualified' and 'not_suitable' start hidden; 'bad_timing'
// starts visible.
async function seedSurveyBoard(page, { withHandler = false } = {}) {
  await page.evaluate(
    ({ contacts, cache, workflow, lsOptions, withHandler }) => {
      // Clear stored filter state so each probe starts from known defaults.
      try { localStorage.removeItem('surveyHiddenSubstages'); } catch {}

      window.state                   = window.state || {};
      window.state.filteredContacts  = contacts;
      window.state.contactStageCache = cache;
      window.state.workflow          = workflow;
      window.state.user              = { privilege_level: 'admin' };
      window.LEAD_STATUS_OPTIONS     = lsOptions;
      window.LEAD_SUBSTATUSES        = [];

      if (withHandler) {
        // Return a handler for every card so the action strip always shows.
        window.cardActionHandlerFor = () => ({
          id: 999,
          type: 'book_survey',
          config: { action_name: 'book_survey' },
          bindings: [],
        });
      } else {
        window.cardActionHandlerFor = () => null;
      }
      window.stageOrLeadStatusActionLabel = () => '';
      window.substatusActionLabelLookup   = () => '';

      document.dispatchEvent(new CustomEvent('survey-board-data-ready'));
    },
    { contacts: CONTACTS, cache: CONTACT_STAGE_CACHE, workflow: WORKFLOW, lsOptions: LEAD_STATUS_OPTIONS, withHandler },
  );
}

// Wait for a specific contact's card body to appear in the DOM.
async function waitForCard(page, contactId) {
  return pollPage(page, (id) => !!document.querySelector(`[data-contact-id="${id}"]`), contactId, 10000);
}

// Open /survey, wait for React to mount, seed state, and wait for a card.
// Returns { page, mounted, cardReady } — caller must close the page.
//
// Bootstrap on the survey page calls loadAllContacts() → /api/contacts-all
// and loadWorkflow() → /api/localdata/all, both of which 503 when the server
// runs without HUBSPOT_TOKEN (as the test harness does).  We intercept those
// requests and return empty-but-valid responses so bootstrap() completes
// normally and the mount point survives.
async function openBoardPage(browser, cookie, contactId = 'sv-test-001', { withHandler = false } = {}) {
  const page = await browser.newPage();
  page.on('pageerror', () => {});
  page.on('console',   () => {});

  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    if (u.includes('/api/contacts-all')) {
      req.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ results: [], totalPages: 1, page: 1, total: 0 }),
      });
    } else if (u.includes('/api/localdata/all')) {
      req.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({}),
      });
    } else {
      req.continue();
    }
  });

  await injectSession(page, cookie);
  await page.goto(`${BASE}/survey`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  const mounted = await waitForReactMount(page);
  await seedSurveyBoard(page, { withHandler });
  const cardReady = contactId ? await waitForCard(page, contactId) : true;
  return { page, mounted, cardReady };
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

  const runId = `sv-${Date.now().toString(36)}`;
  console.log(`\n  survey-board E2E  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);
  await cleanupTestData(pool);

  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  admin=${users.admin.email}`);

  const { child, logBuf } = spawnServer();
  let exited = false;
  child.on('exit', () => { exited = true; });

  const findings = [];
  function record(name, expected, observed, ok, detail = '') {
    findings.push({ name, expected, observed, ok, detail });
    const mark = ok ? '  \u2713' : '  \u2717';
    console.log(`${mark}  ${name}`);
    if (!ok) {
      console.log(`     expected : ${expected}`);
      console.log(`     observed : ${observed}`);
      if (detail) console.log(`     detail   : ${detail}`);
    }
  }

  let teardownInFlight = false;
  async function cleanupAndExit(code) {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    process.exit(code);
  }

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

  if (!puppeteer) {
    record('puppeteer available', 'module installed', 'not installed', false,
      'Install puppeteer: npm i -D puppeteer');
    await writeReport(findings);
    await cleanupAndExit(1);
    return;
  }

  const adminClient = await login(users.admin.email, PASSWORD);
  const executablePath = findChromium();

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      defaultViewport: { width: 1280, height: 900 },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  } catch (e) {
    record('browser launch', 'launched successfully', `error: ${e.message}`, false, e.stack || '');
    await writeReport(findings);
    await cleanupAndExit(1);
    return;
  }

  try {

    // ── (A) Single-column layout with correct stage header ─────────────────────
    console.log('\n  [A] Single-column layout');
    {
      let page;
      try {
        const opened = await openBoardPage(browser, adminClient.cookie, 'sv-test-001');
        page = opened.page;

        if (!opened.mounted) {
          record('(A) SurveyBoardPage mounts', 'board renders within 20 s', 'timed out (20 s)', false,
            'React.lazy chunk did not render — rebuild with npm run build:react');
          record('(A.1) Survey column header present', 'header element present', 'skipped', false);
          record('(A.2) Column header text is "Survey"', '"Survey" text', 'skipped', false);
          record('(A.3) Filter button present', 'button with text "Filter"', 'skipped', false);
        } else {
          const header = await page.evaluate(() => {
            const mount = document.getElementById('survey-board-mount');
            if (!mount) return { error: 'no #survey-board-mount' };
            const themed = mount.firstElementChild;
            if (!themed) return { error: 'no themed wrapper' };
            const board = themed.firstElementChild;
            if (!board) return { error: 'no board container' };
            // First child is the header box
            const headerBox = board.firstElementChild;
            if (!headerBox) return { error: 'no header box' };
            const text = headerBox.innerText || headerBox.textContent || '';
            // Find the Filter button
            const btns = Array.from(mount.querySelectorAll('button'));
            const filterBtn = btns.find(b => (b.textContent || '').includes('Filter'));
            return {
              childCount: board.children.length,
              headerText: text,
              hasFilterBtn: !!filterBtn,
            };
          });

          record(
            '(A.1) Survey column header present',
            'header element present (childCount ≥ 2)',
            header.error || `childCount=${header.childCount}`,
            !header.error && header.childCount >= 2,
          );
          record(
            '(A.2) Column header text contains "Survey"',
            '"Survey" in header text',
            header.error || `text="${(header.headerText || '').slice(0, 80)}"`,
            !header.error && (header.headerText || '').includes('Survey'),
          );
          record(
            '(A.3) Filter button present in column header',
            'button with "Filter" text',
            header.error || `found=${header.hasFilterBtn}`,
            !header.error && !!header.hasFilterBtn,
          );
        }
      } catch (e) {
        record('(A) Single-column layout', 'no error', `error: ${e.message}`, false, e.stack || '');
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }

    // ── (B) Card content ───────────────────────────────────────────────────────
    console.log('\n  [B] Card content');
    {
      let page;
      try {
        const opened = await openBoardPage(browser, adminClient.cookie, 'sv-test-001');
        page = opened.page;

        if (!opened.cardReady) {
          for (const label of ['B.1','B.2','B.3','B.4','B.5','B.6','B.7']) {
            record(`(${label}) Card content`, 'card visible', 'timed out waiting for card', false);
          }
        } else {
          // sv-test-001: Jane Survey — stage pill "Survey", substage "Design Accepted",
          //              source pill "Web", stage trail labels, "Updated" timestamp
          const card = await page.evaluate(() => {
            const body = document.querySelector('[data-contact-id="sv-test-001"]');
            if (!body) return { error: 'sv-test-001 card body not found' };
            const text  = body.innerText || body.textContent || '';
            const spans = Array.from(body.querySelectorAll('span'));
            // Stage trail — look for Sales, Design Visit, Survey text anywhere in the card
            const card   = body.closest('[class*="MuiCard"]') || body.parentElement;
            const allText = card ? (card.innerText || card.textContent || '') : text;
            return {
              hasName:        text.includes('Jane Survey'),
              hasPostcode:    text.includes('SW1A'),
              hasUpdated:     text.toLowerCase().includes('updated'),
              hasStagePill:   spans.some(s => s.textContent.trim() === 'Survey'),
              hasSubstage:    text.includes('Design Accepted'),
              hasSourcePill:  spans.some(s => s.textContent.trim() === 'Web'),
              hasStageTrail:  allText.includes('Sales') && allText.includes('Design Visit'),
            };
          });

          record('(B.1) Card renders contact name ("Jane Survey")',
            '"Jane Survey" visible',
            card.error || `found=${card.hasName}`,
            !!card.hasName);
          record('(B.2) Card renders postcode ("SW1A")',
            '"SW1A" visible',
            card.error || `found=${card.hasPostcode}`,
            !!card.hasPostcode);
          record('(B.3) Card renders "Updated …" timestamp',
            '"Updated …" text present',
            card.error || `found=${card.hasUpdated}`,
            !!card.hasUpdated);
          record('(B.4) Card renders stage pill ("Survey")',
            'span with text "Survey"',
            card.error || `found=${card.hasStagePill}`,
            !!card.hasStagePill);
          record('(B.5) Card renders substage pill ("Design Accepted")',
            '"Design Accepted" text',
            card.error || `found=${card.hasSubstage}`,
            !!card.hasSubstage);
          record('(B.6) Card renders source pill ("Web")',
            'span with text "Web"',
            card.error || `found=${card.hasSourcePill}`,
            !!card.hasSourcePill);
          record('(B.7) Card renders stage trail (Sales + Design Visit labels)',
            '"Sales" and "Design Visit" in stage trail',
            card.error || `found=${card.hasStageTrail}`,
            !!card.hasStageTrail);
        }
      } catch (e) {
        record('(B) Card content', 'no error', `error: ${e.message}`, false, e.stack || '');
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }

    // ── (C) Terminal card opacity ──────────────────────────────────────────────
    console.log('\n  [C] Terminal card opacity');
    {
      let page;
      try {
        // sv-test-002 has statusId='unqualified' which is in SURVEY_TERMINAL_SUBSTAGES.
        // The component's loadHiddenSubstages() defaults to hiding 'unqualified'
        // and 'not_suitable' when localStorage has no entry.  We use
        // evaluateOnNewDocument so localStorage is set to [] (show all) BEFORE
        // the React component initialises its hiddenSubstages state.
        page = await browser.newPage();
        page.on('pageerror', () => {});
        page.on('console',   () => {});

        await page.evaluateOnNewDocument(() => {
          try {
            localStorage.setItem('surveyHiddenSubstages', JSON.stringify([]));
          } catch {}
        });

        await page.setRequestInterception(true);
        page.on('request', req => {
          const u = req.url();
          if (u.includes('/api/contacts-all')) {
            req.respond({ status: 200, contentType: 'application/json',
              body: JSON.stringify({ results: [], totalPages: 1, page: 1, total: 0 }) });
          } else if (u.includes('/api/localdata/all')) {
            req.respond({ status: 200, contentType: 'application/json',
              body: JSON.stringify({}) });
          } else {
            req.continue();
          }
        });

        await injectSession(page, adminClient.cookie);
        await page.goto(`${BASE}/survey`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const mounted = await waitForReactMount(page);

        if (!mounted) {
          record('(C) Terminal card has opacity ≈ 0.55', 'opacity ≈ 0.55', 'timed out (board not mounted)', false);
        } else {
          await seedSurveyBoard(page);
          const cardReady = await waitForCard(page, 'sv-test-002');

          if (!cardReady) {
            record('(C) Terminal card has opacity ≈ 0.55', 'opacity ≈ 0.55', 'timed out waiting for card', false);
          } else {
            const termInfo = await page.evaluate(() => {
              const body = document.querySelector('[data-contact-id="sv-test-002"]');
              if (!body) return { error: 'sv-test-002 card body not found' };
              // Walk up from the card body to find the first ancestor with reduced opacity.
              let el = body.parentElement;
              while (el && el.id !== 'survey-board-mount') {
                const op = parseFloat(window.getComputedStyle(el).opacity);
                if (op < 1) return { opacity: op };
                el = el.parentElement;
              }
              return { opacity: 1, note: 'no reduced-opacity ancestor found' };
            });
            const opacityOk = !termInfo.error
              && typeof termInfo.opacity === 'number'
              && Math.abs(termInfo.opacity - 0.55) < 0.05;
            record(
              '(C) Terminal card (statusId=unqualified) has opacity ≈ 0.55',
              'opacity ≈ 0.55',
              termInfo.error || `opacity=${termInfo.opacity}${termInfo.note ? ' (' + termInfo.note + ')' : ''}`,
              opacityOk,
            );
          }
        }
      } catch (e) {
        record('(C) Terminal card opacity', 'no error', `error: ${e.message}`, false, e.stack || '');
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }

    // ── (D) Card click navigates to /customers/:id ─────────────────────────────
    console.log('\n  [D] Card click navigation');
    {
      let page;
      try {
        const opened = await openBoardPage(browser, adminClient.cookie, 'sv-test-001');
        page = opened.page;

        if (!opened.cardReady) {
          record('(D) Card click navigates to /customers/:id', 'navigation to /customers/sv-test-001', 'timed out', false);
        } else {
          const expectedPath = '/customers/sv-test-001';
          let navigatedTo = null;
          page.on('request', req => {
            if (req.isNavigationRequest() && req.resourceType() === 'document') {
              navigatedTo = req.url();
            }
          });
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => null),
            page.click('[data-contact-id="sv-test-001"]'),
          ]);
          const navOk = !!navigatedTo && navigatedTo.includes(expectedPath);
          record(
            '(D) Card click navigates to /customers/:id',
            `URL contains ${expectedPath}`,
            navigatedTo || 'no navigation request captured',
            navOk,
          );
        }
      } catch (e) {
        record('(D) Card click navigation', 'no error', `error: ${e.message}`, false, e.stack || '');
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }

    // ── (E) Filter button opens popover; toggling substage hides / shows cards ─
    console.log('\n  [E] Substage filter');
    {
      let page;
      try {
        // sv-test-003 has substage 'bad_timing' which is terminal but visible by
        // default (not in the default hidden set of 'unqualified'/'not_suitable').
        const opened = await openBoardPage(browser, adminClient.cookie, 'sv-test-003');
        page = opened.page;

        if (!opened.mounted || !opened.cardReady) {
          const why = !opened.mounted ? 'board not mounted' : 'bad_timing card timed out';
          for (const label of ['E.1','E.2','E.3','E.4','E.5']) {
            record(`(${label}) Substage filter`, 'filter functional', why, false);
          }
        } else {
          // --- E.1: card is visible before filtering ---
          const beforeFilter = await page.evaluate(() => {
            const body = document.querySelector('[data-contact-id="sv-test-003"]');
            if (!body) return { visible: false, error: 'card not found' };
            let el = body;
            while (el) {
              const style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden') {
                return { visible: false };
              }
              if (el.id === 'survey-board-mount') break;
              el = el.parentElement;
            }
            return { visible: true };
          });
          record(
            '(E.1) bad_timing card is visible before filtering',
            'card visible (display ≠ none)',
            beforeFilter.error || `visible=${beforeFilter.visible}`,
            !!beforeFilter.visible,
          );

          // --- E.2: clicking Filter button opens the popover ---
          const filterBtnClicked = await page.evaluate(() => {
            const mount = document.getElementById('survey-board-mount');
            if (!mount) return false;
            const btns = Array.from(mount.querySelectorAll('button'));
            const filterBtn = btns.find(b => (b.textContent || '').includes('Filter'));
            if (!filterBtn) return false;
            filterBtn.click();
            return true;
          });

          // Give MUI Popover time to open
          await new Promise(r => setTimeout(r, 500));

          const popoverInfo = await page.evaluate(() => {
            // MUI Popover renders in a portal (body-level).
            // Note: innerText applies CSS text-transform, so 'Show substages'
            // with textTransform:'uppercase' becomes 'SHOW SUBSTAGES' — use
            // a case-insensitive check.
            const allText = (document.body.innerText || document.body.textContent || '').toLowerCase();
            const hasTitle = allText.includes('show substages');
            // Check for the filter option labels
            const hasBadTiming   = allText.includes('bad timing');
            const hasUnqualified = allText.includes('unqualified');
            return { hasTitle, hasBadTiming, hasUnqualified };
          });

          record(
            '(E.2) Clicking Filter opens substage popover',
            'popover with "Show substages" title visible',
            filterBtnClicked
              ? `hasTitle=${popoverInfo.hasTitle} hasBadTiming=${popoverInfo.hasBadTiming}`
              : 'Filter button not found in DOM',
            filterBtnClicked && popoverInfo.hasTitle && popoverInfo.hasBadTiming,
          );

          // --- E.3: uncheck "Bad Timing" to hide the sv-test-003 card ---
          const unchecked = await page.evaluate(() => {
            // Find the FormControlLabel for "Bad Timing" — its label is a span
            // containing "Bad Timing"; the associated Checkbox input is nearby.
            const labels = Array.from(document.querySelectorAll('[class*="MuiFormControlLabel"]'));
            const badTimingLabel = labels.find(l => (l.textContent || '').includes('Bad Timing'));
            if (!badTimingLabel) return { found: false };
            const checkbox = badTimingLabel.querySelector('input[type="checkbox"]');
            if (!checkbox) return { found: true, checked: null, error: 'no checkbox input' };
            const wasChecked = checkbox.checked;
            if (wasChecked) checkbox.click();   // uncheck it
            return { found: true, wasChecked, nowChecked: checkbox.checked };
          });

          record(
            '(E.3) "Bad Timing" checkbox found and was checked (visible by default)',
            'checkbox found and checked',
            unchecked.found
              ? `found=true wasChecked=${unchecked.wasChecked}`
              : 'Bad Timing FormControlLabel not found in popover',
            unchecked.found && unchecked.wasChecked === true,
          );

          // Give React state update + re-render
          await new Promise(r => setTimeout(r, 600));

          // --- E.4: after unchecking, sv-test-003 card must be absent ---
          const afterHide = await page.evaluate(() => {
            return !!document.querySelector('[data-contact-id="sv-test-003"]');
          });
          record(
            '(E.4) Hiding "Bad Timing" removes sv-test-003 card from DOM',
            'card absent from DOM',
            `cardPresent=${afterHide}`,
            !afterHide,
          );

          // --- E.5: re-check to restore the card ---
          const rechecked = await page.evaluate(() => {
            const labels = Array.from(document.querySelectorAll('[class*="MuiFormControlLabel"]'));
            const badTimingLabel = labels.find(l => (l.textContent || '').includes('Bad Timing'));
            if (!badTimingLabel) return { found: false };
            const checkbox = badTimingLabel.querySelector('input[type="checkbox"]');
            if (!checkbox) return { found: true, error: 'no checkbox' };
            if (!checkbox.checked) checkbox.click();  // re-check
            return { found: true, nowChecked: checkbox.checked };
          });

          await new Promise(r => setTimeout(r, 600));

          const afterShow = await page.evaluate(() => {
            return !!document.querySelector('[data-contact-id="sv-test-003"]');
          });
          record(
            '(E.5) Re-checking "Bad Timing" restores sv-test-003 card in DOM',
            'card present in DOM',
            rechecked.found ? `cardPresent=${afterShow}` : 'checkbox not found to re-check',
            rechecked.found && afterShow,
          );
        }
      } catch (e) {
        record('(E) Substage filter', 'no error', `error: ${e.message}`, false, e.stack || '');
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }

    // ── (F) Action strip renders with handler ──────────────────────────────────
    console.log('\n  [F] Action strip');
    {
      let page;
      try {
        // Open with handler enabled — all cards get an action strip.
        const opened = await openBoardPage(browser, adminClient.cookie, 'sv-test-001', { withHandler: true });
        page = opened.page;

        if (!opened.cardReady) {
          record('(F) Action strip renders when handler configured', 'strip visible', 'timed out', false);
        } else {
          // Dispatch a second event so React re-renders with the updated
          // cardActionHandlerFor function that was injected by seedSurveyBoard.
          await page.evaluate(() => {
            document.dispatchEvent(new CustomEvent('survey-board-data-ready'));
          });
          await new Promise(r => setTimeout(r, 800));

          // The action strip carries data-card-action-handler-id and shows the
          // title-cased action_name: 'book_survey' → 'Book Survey'.
          const stripInfo = await page.evaluate(() => {
            const strip = document.querySelector('[data-card-action-handler-id="999"]');
            if (!strip) return { found: false };
            return { found: true, text: (strip.textContent || '').trim() };
          });

          record(
            '(F) Action strip renders when cardActionHandlerFor returns a handler',
            '"Book Survey" in action strip with data-card-action-handler-id="999"',
            stripInfo.found ? `text="${stripInfo.text}"` : 'strip not found in DOM',
            stripInfo.found && (stripInfo.text || '').includes('Book Survey'),
          );
        }
      } catch (e) {
        record('(F) Action strip', 'no error', `error: ${e.message}`, false, e.stack || '');
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }

    // ── (G) Snackbar visibility pause (tab-hide) ──────────────────────────────
    // Probe G: dispatch the survey-board-bg-refresh-failed event to trigger the
    // warning Snackbar, then simulate the document going hidden.  The MUI
    // Snackbar must still be visible after the 8 s autoHideDuration has elapsed
    // (proving the timer was paused), then auto-dismiss once the tab returns to
    // the foreground.
    console.log('\n  [G] Snackbar visibility pause');
    {
      let page;
      try {
        const opened = await openBoardPage(browser, adminClient.cookie, 'sv-test-001');
        page = opened.page;

        if (!opened.mounted) {
          record('(G.1) Snackbar probe — board mounted', 'mounted', 'timed out', false);
          record('(G.2) Snackbar paused while tab hidden (>8 s)', 'skipped', 'board not mounted', false);
          record('(G.3) Snackbar dismisses after tab returns visible', 'skipped', 'board not mounted', false);
        } else {
          // Dispatch the refresh-failure event directly — mirrors what survey.html
          // does when loadAllContacts() or loadWorkflowStages() throws inside the
          // localdata-updated handler.
          await page.evaluate(() => {
            document.dispatchEvent(new CustomEvent('survey-board-bg-refresh-failed'));
          });

          // Step 1: Snackbar must appear.
          const snackbarAppeared = await pollPage(page, () => {
            const alerts = Array.from(document.querySelectorAll('[role="alert"]'));
            return alerts.some(el =>
              (el.textContent || '').includes("Couldn't refresh live data")
            ) ? 'visible' : null;
          }, null, 8000);

          if (snackbarAppeared !== 'visible') {
            record('(G.1) "Couldn\'t refresh live data" Snackbar appears', 'visible', `snackbar=${snackbarAppeared}`, false);
            record('(G.2) Snackbar paused while tab hidden (>8 s)', 'skipped', 'snackbar never appeared', false);
            record('(G.3) Snackbar dismisses after tab returns visible', 'skipped', 'snackbar never appeared', false);
          } else {
            record('(G.1) "Couldn\'t refresh live data" Snackbar appears', 'visible', 'visible', true);

            // Step 2: Simulate the tab going hidden.
            await page.evaluate(() => {
              Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
              Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
              document.dispatchEvent(new Event('visibilitychange'));
            });

            // Step 3: Wait 9.5 s (> 8 s autoHideDuration). If the pause were
            // broken the Snackbar would have dismissed by now.
            await new Promise(r => setTimeout(r, 9500));

            const stillVisible = await page.evaluate(() => {
              const alerts = Array.from(document.querySelectorAll('[role="alert"]'));
              return alerts.some(el =>
                (el.textContent || '').includes("Couldn't refresh live data")
              );
            }).catch(() => false);

            record(
              '(G.2) Snackbar paused while tab hidden (>8 s)',
              'still visible (timer paused)',
              stillVisible ? 'still visible — timer paused (good)' : 'already dismissed — timer NOT paused (bad)',
              stillVisible,
            );

            // Step 4: Restore the tab to visible.
            await page.evaluate(() => {
              Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
              Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
              document.dispatchEvent(new Event('visibilitychange'));
            });

            // Step 5: Snackbar must now auto-dismiss (8 s timer restarts).
            // Allow up to 12 s (8 s autoHide + animation buffer).
            const dismissDeadline = Date.now() + 12000;
            let gone = false;
            while (Date.now() < dismissDeadline) {
              const still = await page.evaluate(() => {
                const alerts = Array.from(document.querySelectorAll('[role="alert"]'));
                return alerts.some(el =>
                  (el.textContent || '').includes("Couldn't refresh live data")
                );
              }).catch(() => true);
              if (!still) { gone = true; break; }
              await new Promise(r => setTimeout(r, 100));
            }

            record(
              '(G.3) Snackbar dismisses after tab returns visible',
              'dismissed within 12 s of tab-show',
              gone ? 'dismissed (good)' : 'still visible after 12 s (bad)',
              gone,
            );
          }
        }
      } catch (e) {
        record('(G) Snackbar visibility pause', 'no error', `error: ${e.message}`, false, e.stack || '');
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }

  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  // ── Results ───────────────────────────────────────────────────────────────────
  const pass = findings.filter(f => f.ok).length;
  const fail = findings.filter(f => !f.ok).length;
  console.log(`\n  Results: ${pass} passed, ${fail} failed`);
  await writeReport(findings);
  await cleanupAndExit(fail > 0 ? 1 : 0);
}

async function writeReport(findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Survey Board — E2E Test Report',
    '',
    `- Date: ${new Date().toISOString()}`,
    '- Command: `npm run test:survey-board`',
    '',
    '## Summary',
    '',
    `- Passed: ${findings.filter(f => f.ok).length} / ${findings.length}`,
    `- Failed: ${findings.filter(f => !f.ok).length} / ${findings.length}`,
    '',
    '## Results',
    '',
    '| Result | Probe | Expected | Observed |',
    '|---|---|---|---|',
    ...findings.map(f =>
      `| ${f.ok ? 'PASS' : 'FAIL'} | ${esc(f.name)} | ${esc(f.expected)} | ${esc(f.observed)} |`,
    ),
    '',
    '## Coverage',
    '',
    '- **(A)** Single-column layout: `#survey-board-mount` renders with a "Survey"',
    '  column header and a "Filter" button present',
    '- **(B)** Card content: contact name, postcode, stage pill ("Survey"),',
    '  substage pill ("Design Accepted"), source pill ("Web"), stage trail labels',
    '  ("Sales", "Design Visit"), and "Updated …" timestamp all appear',
    '- **(C)** Terminal card de-emphasis: ancestor element has `opacity ≈ 0.55`',
    "  when the contact's room `statusId` is in `SURVEY_TERMINAL_SUBSTAGES`",
    '  (e.g. `unqualified`)',
    '- **(D)** Card body click navigates to `/customers/:id`',
    '- **(E)** Substage filter: Filter button opens the MUI Popover; unchecking',
    '  "Bad Timing" hides matching cards; re-checking restores them',
    '- **(F)** Action strip: when `cardActionHandlerFor` returns a handler with',
    '  `action_name: \'book_survey\'`, the `[data-card-action-handler-id]` element',
    '  is present and shows "Book Survey" text',
    '- **(G)** Snackbar visibility pause: dispatching `survey-board-bg-refresh-failed`',
    '  shows the warning Snackbar; simulating tab-hide proves the MUI',
    '  autoHideDuration timer is paused (Snackbar still visible after 9.5 s > 8 s),',
    '  then auto-dismisses once the tab returns to the foreground.',
    '',
    '## React mount timing',
    '',
    '`SurveyBoardPage` is a `React.lazy` chunk.  Each probe calls',
    '`waitForReactMount()` (polls for the outer column flex-Box up to 20 s)',
    'before seeding `window.state` and dispatching `survey-board-data-ready`,',
    'so the component event listener is guaranteed to be registered before',
    'the event fires.',
    '',
    '## Relevant files',
    '',
    '- `src/react/pages/SurveyBoardPage.tsx` — React component under test',
    '- `public/survey.html` — page that mounts the component and dispatches',
    '  `survey-board-data-ready` after data load, and `survey-board-bg-refresh-failed`',
    '  when the background refresh throws',
  ];
  const outPath = path.join(dir, 'survey-board.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Report: test-results/survey-board.md`);
}

main();
