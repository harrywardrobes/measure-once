'use strict';
const { makeSkip3 } = require('../helpers/report');

const PROBE_LABELS = [
  '(A) in-memory path: GET is called to fetch existing notes',
  '(A) in-memory path: POST is called to persist to server',
  '(A) in-memory path: POST body contains rooms array',
  '(A) in-memory path: POST body preserves existing notes',
  '(A) in-memory path: updater mutation reflected in POST body',
  '(B) network path: GET is called to fetch localdata',
  '(B) network path: POST is called to persist to server',
];

// test/quick-load-and-update/run.js
//
// Unit-style Puppeteer smoke test for quickLoadAndUpdate() in public/workflow.js.
//
// Verifies that the function persists to the server in BOTH branches:
//
//   (A) In-memory path — contact is already selected
//       (state.selectedContactId === contactId): the function must call POST
//       /api/contacts/:id/localdata even though the data is already in memory.
//       Before this fix the in-memory branch returned early without posting.
//
//   (B) Network path — contact is not currently open
//       (state.selectedContactId !== contactId): POST must be called after
//       fetching localdata via GET (existing behaviour, regression guard).
//
// No server or database required.  All dependencies (state, GET, POST,
// updateRoomCache, renderWorkflowHeader, renderWorkflowStages, showToast) are
// stubbed in a data-URL page.  The real quickLoadAndUpdate source is extracted
// directly from public/workflow.js so the test exercises production code.
//
// Usage:
//   npm run test:quick-load-and-update

const fs   = require('fs');
const path = require('path');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

// ── extract quickLoadAndUpdate source ─────────────────────────────────────────

const workflowSrc = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'public', 'workflow.js'),
  'utf8',
);

// Extract the async quickLoadAndUpdate function (up to the closing brace of the
// outer if-else chain that ends the function body).
const fnMatch = workflowSrc.match(
  /(async function quickLoadAndUpdate[\s\S]*?\n\})\s*\n/,
);
if (!fnMatch) {
  console.error('Could not locate quickLoadAndUpdate in public/workflow.js');
  process.exit(2);
}
const FN_SRC = fnMatch[1];

// ── helpers ───────────────────────────────────────────────────────────────────

function findChromium() {
  const { findChromium: shared } = require('../shared/find-chromium');
  return shared() || undefined;
}

const REPORT_PATH = path.resolve(__dirname, '..', '..', 'test-results', 'quick-load-and-update.md');
const findings = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id}${detail ? ' — ' + detail : ''}`);
}
const skip = makeSkip3(findings);

function writeReport() {
  const dir = path.dirname(REPORT_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const pass = findings.filter(f => f.ok).length;
  const fail = findings.filter(f => !f.ok && !f.skipped).length;
  const skipped = findings.filter(f => f.skipped).length;
  const lines = [
    '# quickLoadAndUpdate — Persistence Test',
    '',
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:quick-load-and-update\``,
    '',
    '## Summary',
    '',
    `- Passed: ${pass} / ${findings.length}`,
    `- Failed: ${fail} / ${findings.length}`,
    '',
    '## Results',
    '',
    '| Result | Probe | Detail |',
    '|---|---|---|',
    ...findings.map(f => `| ${f.ok ? 'PASS' : f.skipped ? 'SKIP' : 'FAIL'} | ${esc(f.id)} | ${esc(f.detail)} |`),
    '',
    '## Coverage',
    '',
    '- **(A) In-memory path**: when `state.selectedContactId === contactId` the function',
    '  must still call `POST /api/contacts/:id/localdata` so the change persists.',
    '  Regression guard for the missing-return-path bug fix in localdata persistence.',
    '',
    '- **(B) Network path**: when `state.selectedContactId !== contactId` the function',
    '  must call `GET` then `POST`. Existing behaviour, included as a regression guard.',
    '',
    '## Relevant file',
    '',
    '- `public/workflow.js` — `quickLoadAndUpdate` (lines ~4–53)',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: test-results/quick-load-and-update.md`);
}

// ── page stub ─────────────────────────────────────────────────────────────────
//
// Serialised as a string so it can be sent to page.evaluate().  All globals
// that quickLoadAndUpdate references are defined here.

function buildPageStub({ selectedContactId, localdataResponse }) {
  return /* js */`
    // ── minimal state ──────────────────────────────────────────────────────
    window.state = {
      selectedContactId: ${JSON.stringify(selectedContactId)},
      selectedRoomIdx: 0,
      allRooms: [
        { room: 'Main', stageKey: 'sales', statusId: null, comments: [], roomStatus: 'active' },
      ],
      contactStageCache: {},
    };

    // ── call log ────────────────────────────────────────────────────────────
    window.__calls = [];

    // ── GET stub ────────────────────────────────────────────────────────────
    window.GET = async (url) => {
      window.__calls.push({ method: 'GET', url });
      return ${JSON.stringify(localdataResponse)};
    };

    // ── POST stub ───────────────────────────────────────────────────────────
    window.POST = async (url, body) => {
      window.__calls.push({ method: 'POST', url, body });
      return { success: true };
    };

    // ── no-op helpers ───────────────────────────────────────────────────────
    window.updateRoomCache      = () => {};
    window.renderWorkflowHeader = () => {};
    window.renderWorkflowStages = () => {};
    window.showToast            = () => {};
  `;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  quickLoadAndUpdate persistence test\n');

  if (!puppeteer) {
    for (const l of PROBE_LABELS) {
      skip(l, 'puppeteer not installed');
    }
    writeReport();
    process.exit(1);
  }

  const executablePath = findChromium();
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      defaultViewport: { width: 800, height: 600 },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  } catch (e) {
    for (const l of PROBE_LABELS) {
      skip(l, `browser launch failed: ${e.message}`);
    }
    writeReport();
    process.exit(1);
  }

  const DATA_PAGE = 'data:text/html,<!DOCTYPE html><html><body></body></html>';
  const CONTACT_ID = 'test-contact-42';

  try {

    // ── (A) In-memory path ──────────────────────────────────────────────────
    // contactId === state.selectedContactId → POST must still be called.
    {
      const page = await browser.newPage();
      try {
        await page.goto(DATA_PAGE, { waitUntil: 'domcontentloaded' });

        const localdataResponse = { rooms: [], notes: 'existing notes' };
        const stub = buildPageStub({
          selectedContactId: CONTACT_ID,
          localdataResponse,
        });

        const calls = await page.evaluate(
          async ({ stubSrc, fnSrc, contactId }) => {
            // eslint-disable-next-line no-eval
            eval(stubSrc);
            // eslint-disable-next-line no-eval
            eval(fnSrc);

            const updater = (rooms, idx) => {
              if (rooms[idx]) rooms[idx].statusId = 'changed';
            };
            await quickLoadAndUpdate(contactId, 0, updater);
            return window.__calls;
          },
          { stubSrc: stub, fnSrc: FN_SRC, contactId: CONTACT_ID },
        );

        const getCall  = calls.find(c => c.method === 'GET'  && c.url.includes(CONTACT_ID));
        const postCall = calls.find(c => c.method === 'POST' && c.url.includes(CONTACT_ID));

        record(
          '(A) in-memory path: GET is called to fetch existing notes',
          !!getCall,
          getCall ? `GET ${getCall.url}` : 'GET call not found',
        );
        record(
          '(A) in-memory path: POST is called to persist to server',
          !!postCall,
          postCall ? `POST ${postCall.url}` : 'POST call not found — bug not fixed',
        );
        if (postCall) {
          const hasRooms = Array.isArray(postCall.body?.rooms);
          record(
            '(A) in-memory path: POST body contains rooms array',
            hasRooms,
            hasRooms ? `rooms.length=${postCall.body.rooms.length}` : 'body.rooms missing',
          );
          const notesPreserved = postCall.body?.notes === 'existing notes';
          record(
            '(A) in-memory path: POST body preserves existing notes',
            notesPreserved,
            `notes=${JSON.stringify(postCall.body?.notes)}`,
          );
          const updaterApplied = postCall.body?.rooms?.[0]?.statusId === 'changed';
          record(
            '(A) in-memory path: updater mutation reflected in POST body',
            updaterApplied,
            `rooms[0].statusId=${JSON.stringify(postCall.body?.rooms?.[0]?.statusId)}`,
          );
        }
      } catch (e) {
        record('(A) in-memory path: no runtime error', false, e.message);
      } finally {
        await page.close();
      }
    }

    // ── (B) Network path ───────────────────────────────────────────────────
    // contactId !== state.selectedContactId → GET then POST (existing behaviour).
    {
      const page = await browser.newPage();
      try {
        await page.goto(DATA_PAGE, { waitUntil: 'domcontentloaded' });

        const localdataResponse = {
          rooms: [{ room: 'Main', stageKey: 'sales', statusId: null, comments: [], roomStatus: 'active' }],
          notes: 'network notes',
        };
        const stub = buildPageStub({
          selectedContactId: 'other-contact',
          localdataResponse,
        });

        const calls = await page.evaluate(
          async ({ stubSrc, fnSrc, contactId }) => {
            // eslint-disable-next-line no-eval
            eval(stubSrc);
            // eslint-disable-next-line no-eval
            eval(fnSrc);

            const updater = (rooms, idx) => {
              if (rooms[idx]) rooms[idx].statusId = 'changed';
            };
            await quickLoadAndUpdate(contactId, 0, updater);
            return window.__calls;
          },
          { stubSrc: stub, fnSrc: FN_SRC, contactId: CONTACT_ID },
        );

        const getCall  = calls.find(c => c.method === 'GET'  && c.url.includes(CONTACT_ID));
        const postCall = calls.find(c => c.method === 'POST' && c.url.includes(CONTACT_ID));

        record(
          '(B) network path: GET is called to fetch localdata',
          !!getCall,
          getCall ? `GET ${getCall.url}` : 'GET call not found',
        );
        record(
          '(B) network path: POST is called to persist to server',
          !!postCall,
          postCall ? `POST ${postCall.url}` : 'POST call not found',
        );
      } catch (e) {
        record('(B) network path: no runtime error', false, e.message);
      } finally {
        await page.close();
      }
    }

  } finally {
    await browser.close().catch(() => {});
  }

  const pass = findings.filter(f => f.ok).length;
  const fail = findings.filter(f => !f.ok && !f.skipped).length;
  console.log(`\n  Results: ${pass} passed, ${fail} failed`);
  writeReport();
  process.exit(fail > 0 ? 1 : 0);
}

main();
