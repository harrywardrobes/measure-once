'use strict';

// test/contact-customer-activity/run.js
//
// Integration tests for the enriched contact_customer activity timeline route
// (GET /api/card-actions/contact-customer/:contactId/activity).
//
// The route fans out to several HubSpot APIs (engagement associations +
// batch/read for emails/calls/meetings/notes/tasks, the owners API, and the
// legacy contact-profile form-submissions endpoint), normalises everything into
// a single reverse-chronological, source-tagged list, and is expected to:
//   - require authentication,
//   - reject a non-numeric contactId with 400,
//   - degrade gracefully when one source returns 403 (missing scope) — the rest
//     still return and `unavailable` names the failed source,
//   - resolve owner ids to display names,
//   - serve a short-lived per-contact cache so reopening the modal doesn't
//     re-hit HubSpot.
//
// Probes:
//   (A) Authenticated happy path → 200, activities normalised + sorted desc,
//       owner name resolved, form submission present.
//   (B) Second call for the same contact is served from cache (no new HubSpot
//       association requests) and returns an identical payload.
//   (C) One engagement source returns 403 → still 200, `unavailable` lists it,
//       other sources still present.
//   (D) Invalid (non-numeric) contactId → 400.
//   (E) Unauthenticated request → 401 (never reaches HubSpot).
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:contact-customer-activity
//   PRIVTEST_ALLOW_SHARED_DB=1      npm run test:contact-customer-activity

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
  __dirname, '..', '..', 'test-results', 'contact-customer-activity.md'
);

const CONTACT_A = '7001001'; // happy path + cache
const CONTACT_B = '7001002'; // graceful-degradation (email association 403)

const findings = [];
function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${id} — ${detail}`);
}

// ── Mock HubSpot HTTP server ───────────────────────────────────────────────
// Tracks how many association calls each contact receives so the cache probe
// can assert the second request never reaches HubSpot.
const assocCalls = {}; // `${contactId}:${type}` -> count

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
      const [, cid, type] = m;
      assocCalls[`${cid}:${type}`] = (assocCalls[`${cid}:${type}`] || 0) + 1;

      // Contact B: emails scope missing → 403 (drives graceful degradation).
      if (cid === CONTACT_B && type === 'emails') {
        return send(403, { message: 'This app hasn\'t been granted the sales-email-read scope.' });
      }

      const idsByType = {
        emails:   [{ id: 'e1' }],
        calls:    [{ id: 'c1' }],
        meetings: [],
        notes:    [{ id: 'n1' }],
        tasks:    [],
      };
      return send(200, { results: idsByType[type] || [] });
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
            hs_email_text: 'Hi Jane, here is your quote.',
            hs_email_direction: 'EMAIL',
            hs_email_from_email: 'team@example.com',
            hs_email_to_email: 'jane@example.com',
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
            hs_call_duration: '120000',
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

    // Legacy contact profile (form submissions)
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
  console.log(`\n  contact-customer-activity  run=${runId}`);
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
    let payloadA = null;
    try {
      const res = await member.get(
        `/api/card-actions/contact-customer/${encodeURIComponent(CONTACT_A)}/activity`,
      );
      payloadA = res.json || {};
      const acts = payloadA.activities || [];
      const types = typesOf(payloadA);
      const email = acts.find(a => a.type === 'email');
      const form  = acts.find(a => a.type === 'form_submission');
      // Sorted reverse-chronological: form (06-22) > call (06-21) > email (06-20) > note (06-19)
      const tsList = acts.map(a => Date.parse(a.timestamp));
      const sortedDesc = tsList.every((t, i) => i === 0 || tsList[i - 1] >= t);
      const ok =
        res.status === 200 &&
        types.includes('email') && types.includes('call') &&
        types.includes('note') && types.includes('form_submission') &&
        email && email.direction === 'outgoing' &&
        email.body && email.body.includes('here is your quote') &&
        email.actor === 'Alex Owner' &&
        form && form.meta && form.meta.pageUrl === 'https://example.com/contact' &&
        sortedDesc &&
        Array.isArray(payloadA.unavailable) && payloadA.unavailable.length === 0;
      record(
        '(A) activity: happy path returns normalised, sorted, owner-resolved feed',
        ok,
        `status=${res.status} types=[${types.join(',')}] emailActor=${email && email.actor} sortedDesc=${sortedDesc}`,
      );
    } catch (e) {
      record('(A) activity: happy path returns normalised, sorted, owner-resolved feed', false, e.message);
    }

    // ── Probe (B): second call served from cache (no new HubSpot calls) ──
    try {
      const before = assocCalls[`${CONTACT_A}:emails`] || 0;
      const res = await member.get(
        `/api/card-actions/contact-customer/${encodeURIComponent(CONTACT_A)}/activity`,
      );
      const after = assocCalls[`${CONTACT_A}:emails`] || 0;
      const sameCount = (after === before);
      const sameLen = res.json && payloadA &&
        (res.json.activities || []).length === (payloadA.activities || []).length;
      record(
        '(B) activity: repeat call is cached (no extra HubSpot association request)',
        res.status === 200 && sameCount && sameLen,
        `status=${res.status} assocBefore=${before} assocAfter=${after} sameLen=${sameLen}`,
      );
    } catch (e) {
      record('(B) activity: repeat call is cached (no extra HubSpot association request)', false, e.message);
    }

    // ── Probe (C): one source 403 → graceful degradation ────────────────
    try {
      const res = await member.get(
        `/api/card-actions/contact-customer/${encodeURIComponent(CONTACT_B)}/activity`,
      );
      const payload = res.json || {};
      const types = typesOf(payload);
      const ok =
        res.status === 200 &&
        Array.isArray(payload.unavailable) &&
        payload.unavailable.includes('email') &&
        !types.includes('email') &&
        types.includes('call') && types.includes('note');
      record(
        '(C) activity: a 403 source degrades gracefully (200 + unavailable lists it)',
        ok,
        `status=${res.status} unavailable=[${(payload.unavailable || []).join(',')}] types=[${types.join(',')}]`,
      );
    } catch (e) {
      record('(C) activity: a 403 source degrades gracefully (200 + unavailable lists it)', false, e.message);
    }

    // ── Probe (D): invalid contactId → 400 ──────────────────────────────
    try {
      const res = await member.get(
        `/api/card-actions/contact-customer/not-a-number/activity`,
      );
      record(
        '(D) activity: non-numeric contactId returns 400',
        res.status === 400,
        `status=${res.status}`,
      );
    } catch (e) {
      record('(D) activity: non-numeric contactId returns 400', false, e.message);
    }

    // ── Probe (E): unauthenticated → 401 ────────────────────────────────
    try {
      const res = await fetch(
        `${BASE}/api/card-actions/contact-customer/${CONTACT_A}/activity`,
        { headers: { 'Accept': 'application/json', 'X-Forwarded-Proto': 'https' }, redirect: 'manual' },
      );
      record(
        '(E) activity: unauthenticated request is rejected (401)',
        res.status === 401,
        `status=${res.status}`,
      );
    } catch (e) {
      record('(E) activity: unauthenticated request is rejected (401)', false, e.message);
    }

  } catch (e) {
    record('(A) activity: happy path returns normalised, sorted, owner-resolved feed', false, e.message);
    record('(B) activity: repeat call is cached (no extra HubSpot association request)', false, e.message);
    record('(C) activity: a 403 source degrades gracefully (200 + unavailable lists it)', false, e.message);
    record('(D) activity: non-numeric contactId returns 400', false, e.message);
    record('(E) activity: unauthenticated request is rejected (401)', false, e.message);
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
    '# contact-customer-activity test',
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
