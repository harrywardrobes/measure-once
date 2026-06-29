'use strict';

// test/contact-detail-activity/run.js
//
// Integration tests for the customer-detail-page activity feed route
// (GET /api/contacts/:contactId/activity).
//
// This is the richer sibling of the Contact Customer modal timeline. On top of
// the engagement + form-submission sources it adds three detail-page-only
// sources, each of which must degrade independently:
//   - marketing emails (legacy /email/public/v1/events) collapsed per campaign
//     with open/click counts and the campaign subject as the title,
//   - page-view analytics (/events/v3/events?eventType=e_visited_page),
//   - form-submission field values (/form-integrations/v1/submissions/forms/...)
//     matched onto the legacy profile submissions by timestamp.
//
// Probes:
//   (A) Authenticated happy path → 200, includes marketing_email (opens/clicks),
//       page_view, and a form_submission enriched with field values; whole feed
//       sorted reverse-chronological; `unavailable` empty.
//   (B) Marketing + page-view scopes missing (403) → still 200, those two keys
//       listed in `unavailable`, the engagement + form sources still present.
//   (C) Invalid (non-numeric) contactId → 400.
//   (D) Unauthenticated request → 401 (never reaches HubSpot).
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:contact-detail-activity
//   PRIVTEST_ALLOW_SHARED_DB=1      npm run test:contact-detail-activity

const http = require('http');
const path = require('path');
const fs   = require('fs');
const { Pool } = require('pg');

require('dotenv').config();

const {
  BASE,
  spawnServer,
  waitForServer,
  seedUsers,
  cleanupTestData,
  resetRateLimitStore,
  login,
  setPool,
  PASSWORD,
} = require('../privileges/harness');

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'contact-detail-activity.md'
);

const CONTACT_A = '7002001'; // happy path (all sources present)
const CONTACT_B = '7002002'; // marketing + page-view scopes missing (403)

const EMAIL_A = 'jane@example.com';
const EMAIL_B = 'bob@example.com';

const findings = [];
function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${id} — ${detail}`);
}

// ── Mock HubSpot HTTP server ───────────────────────────────────────────────
function startMockHubSpot() {
  const server = http.createServer((req, res) => {
    const url = req.url || '';
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    // Owners
    if (url.startsWith('/crm/v3/owners')) {
      return send(200, {
        results: [{ id: '77', firstName: 'Alex', lastName: 'Owner', email: 'alex@example.com' }],
      });
    }

    // Engagement associations: /crm/v3/objects/contacts/{id}/associations/{type}
    let m = url.match(/\/crm\/v3\/objects\/contacts\/(\d+)\/associations\/(\w+)/);
    if (m) {
      const [, , type] = m;
      const idsByType = {
        emails:   [{ id: 'e1' }],
        calls:    [{ id: 'c1' }],
        meetings: [],
        notes:    [{ id: 'n1' }],
        tasks:    [],
      };
      return send(200, { results: idsByType[type] || [] });
    }

    // Single contact GET (resolves the recipient email for the marketing source)
    m = url.match(/\/crm\/v3\/objects\/contacts\/(\d+)(?:\?|$)/);
    if (m && req.method === 'GET') {
      const cid = m[1];
      return send(200, { id: cid, properties: { email: cid === CONTACT_B ? EMAIL_B : EMAIL_A } });
    }

    // Batch read: POST /crm/v3/objects/{type}/batch/read
    m = url.match(/\/crm\/v3\/objects\/(\w+)\/batch\/read/);
    if (m && req.method === 'POST') {
      const type = m[1];
      const byType = {
        emails: [{
          id: 'e1',
          properties: {
            hs_timestamp: '2026-06-20T10:00:00.000Z',
            hs_email_subject: 'Quote follow-up',
            hs_email_text: 'Hi, here is your quote.',
            hs_email_direction: 'EMAIL',
            hubspot_owner_id: '77',
          },
        }],
        calls: [{
          id: 'c1',
          properties: {
            hs_timestamp: '2026-06-21T09:00:00.000Z',
            hs_call_title: 'Intro call',
            hs_call_body: 'Spoke about options.',
            hs_call_direction: 'OUTBOUND',
            hubspot_owner_id: '77',
          },
        }],
        notes: [{
          id: 'n1',
          properties: {
            hs_timestamp: '2026-06-19T08:00:00.000Z',
            hs_note_body: '<p>Customer prefers oak.</p>',
            hubspot_owner_id: '77',
          },
        }],
      };
      return send(200, { results: byType[type] || [] });
    }

    // Legacy contact profile (form submissions — name/page/timestamp only)
    m = url.match(/\/contacts\/v1\/contact\/vid\/(\d+)\/profile/);
    if (m) {
      return send(200, {
        'form-submissions': [{
          'conversion-id': 'cv1',
          timestamp: Date.parse('2026-06-22T12:00:00.000Z'),
          'form-id': 'f1',
          title: 'Website enquiry',
          'page-url': 'https://example.com/contact',
        }],
      });
    }

    // Form submission field values (/form-integrations/v1/submissions/forms/{guid})
    m = url.match(/\/form-integrations\/v1\/submissions\/forms\/(\w+)/);
    if (m) {
      return send(200, {
        results: [{
          submittedAt: Date.parse('2026-06-22T12:00:00.000Z'),
          pageUrl: 'https://example.com/contact',
          values: [
            { name: 'email', value: EMAIL_A },
            { name: 'message', value: 'Please call me back' },
          ],
        }],
      });
    }

    // Marketing email events (/email/public/v1/events?recipient=...)
    if (url.startsWith('/email/public/v1/events')) {
      if (url.includes(encodeURIComponent(EMAIL_B)) || url.includes(EMAIL_B)) {
        return send(403, { message: 'This app hasn\'t been granted the content scope.' });
      }
      return send(200, {
        hasMore: false,
        events: [
          { type: 'SENT',  emailCampaignId: 555, created: Date.parse('2026-06-25T10:00:00.000Z') },
          { type: 'OPEN',  emailCampaignId: 555, created: Date.parse('2026-06-25T11:00:00.000Z') },
          { type: 'OPEN',  emailCampaignId: 555, created: Date.parse('2026-06-25T12:00:00.000Z') },
          { type: 'CLICK', emailCampaignId: 555, created: Date.parse('2026-06-25T13:00:00.000Z') },
        ],
      });
    }

    // Marketing campaign metadata
    m = url.match(/\/email\/public\/v1\/campaigns\/(\d+)/);
    if (m) {
      return send(200, { id: m[1], name: 'June Newsletter', subject: 'Summer offers inside' });
    }

    // Page-view analytics events
    if (url.startsWith('/events/v3/events')) {
      const objMatch = url.match(/objectId=(\d+)/);
      const cid = objMatch ? objMatch[1] : '';
      if (cid === CONTACT_B) {
        return send(403, { message: 'This app hasn\'t been granted an analytics scope.' });
      }
      return send(200, {
        results: [{
          id: 'pv1',
          occurredAt: '2026-06-26T09:00:00.000Z',
          properties: { hs_url: 'https://example.com/pricing', hs_page_title: 'Pricing' },
        }],
      });
    }

    return send(404, { message: 'Not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function typesOf(payload) {
  return (payload.activities || []).map(a => a.type);
}

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
  console.log(`\n  contact-detail-activity  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);

  const hsServer = await startMockHubSpot();
  const hsPort   = hsServer.address().port;
  const hsUrl    = `http://127.0.0.1:${hsPort}`;

  const users = await seedUsers(pool, runId);

  const { child } = spawnServer({
    extraEnv: {
      HUBSPOT_ACCESS_TOKEN: 'privtest-fake-hs-token',
      HUBSPOT_API_URL:      hsUrl,
    },
  });
  let exited = false;
  child.on('exit', () => { exited = true; });

  try {
    await waitForServer();
    await resetRateLimitStore(pool);

    const member = await login(users.member.email, PASSWORD);

    // ── Probe (A): authenticated happy path ──────────────────────────────
    try {
      const res = await member.get(`/api/contacts/${encodeURIComponent(CONTACT_A)}/activity`);
      const payload = res.json || {};
      const acts = payload.activities || [];
      const types = typesOf(payload);
      const marketing = acts.find(a => a.type === 'marketing_email');
      const pageView  = acts.find(a => a.type === 'page_view');
      const form      = acts.find(a => a.type === 'form_submission');
      const formFields = form && form.meta && Array.isArray(form.meta.fields) ? form.meta.fields : [];
      const hasMsgField = formFields.some(f => f.name === 'message' && /call me back/i.test(f.value));
      const tsList = acts.map(a => Date.parse(a.timestamp));
      const sortedDesc = tsList.every((t, i) => i === 0 || tsList[i - 1] >= t);
      const ok =
        res.status === 200 &&
        types.includes('email') && types.includes('call') && types.includes('note') &&
        types.includes('form_submission') &&
        marketing && marketing.title === 'Summer offers inside' &&
        marketing.meta && marketing.meta.opens === 2 && marketing.meta.clicks === 1 &&
        pageView && pageView.meta && pageView.meta.pageUrl === 'https://example.com/pricing' &&
        hasMsgField &&
        sortedDesc &&
        Array.isArray(payload.unavailable) && payload.unavailable.length === 0;
      record(
        '(A) detail activity: marketing (opens/clicks), page views + form field values, sorted',
        ok,
        `status=${res.status} types=[${types.join(',')}] opens=${marketing && marketing.meta && marketing.meta.opens} clicks=${marketing && marketing.meta && marketing.meta.clicks} msgField=${hasMsgField} sortedDesc=${sortedDesc}`,
      );
    } catch (e) {
      record('(A) detail activity: marketing (opens/clicks), page views + form field values, sorted', false, e.message);
    }

    // ── Probe (B): marketing + page-view scopes missing → graceful ───────
    try {
      const res = await member.get(`/api/contacts/${encodeURIComponent(CONTACT_B)}/activity`);
      const payload = res.json || {};
      const types = typesOf(payload);
      const un = payload.unavailable || [];
      const ok =
        res.status === 200 &&
        Array.isArray(un) &&
        un.includes('marketing_email') && un.includes('page_view') &&
        !types.includes('marketing_email') && !types.includes('page_view') &&
        types.includes('call') && types.includes('note') &&
        types.includes('form_submission');
      record(
        '(B) detail activity: missing marketing/analytics scopes degrade gracefully',
        ok,
        `status=${res.status} unavailable=[${un.join(',')}] types=[${types.join(',')}]`,
      );
    } catch (e) {
      record('(B) detail activity: missing marketing/analytics scopes degrade gracefully', false, e.message);
    }

    // ── Probe (C): invalid contactId → 400 ──────────────────────────────
    try {
      const res = await member.get(`/api/contacts/not-a-number/activity`);
      record('(C) detail activity: non-numeric contactId returns 400', res.status === 400, `status=${res.status}`);
    } catch (e) {
      record('(C) detail activity: non-numeric contactId returns 400', false, e.message);
    }

    // ── Probe (D): unauthenticated → 401 ────────────────────────────────
    try {
      const res = await fetch(
        `${BASE}/api/contacts/${CONTACT_A}/activity`,
        { headers: { 'Accept': 'application/json', 'X-Forwarded-Proto': 'https' }, redirect: 'manual' },
      );
      record('(D) detail activity: unauthenticated request is rejected (401)', res.status === 401, `status=${res.status}`);
    } catch (e) {
      record('(D) detail activity: unauthenticated request is rejected (401)', false, e.message);
    }

  } catch (e) {
    record('(A) detail activity: marketing (opens/clicks), page views + form field values, sorted', false, e.message);
    record('(B) detail activity: missing marketing/analytics scopes degrade gracefully', false, e.message);
    record('(C) detail activity: non-numeric contactId returns 400', false, e.message);
    record('(D) detail activity: unauthenticated request is rejected (401)', false, e.message);
  }

  try { if (!exited) child.kill('SIGTERM'); } catch {}
  await new Promise(r => setTimeout(r, 400));

  // ── Teardown ─────────────────────────────────────────────────────────────
  hsServer.close();
  await cleanupTestData(pool);
  await pool.end().catch(() => {});

  // ── Write report ──────────────────────────────────────────────────────────
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok).length;
  const lines  = [
    '# contact-detail-activity test',
    '',
    `Run: ${new Date().toISOString()}`,
    '',
    '| # | Probe | Result |',
    '|---|-------|--------|',
    ...findings.map((f, i) => `| ${i + 1} | ${f.id} | ${f.ok ? '✅ PASS' : '❌ FAIL'} |`),
    '',
    `**${passed} passed, ${failed} failed**`,
  ];
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, lines.join('\n'), 'utf8');
  console.log(`\n  ${passed}/${findings.length} passed  →  ${REPORT_PATH}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(2); });
