'use strict';
// test/design-visit-submitter-name/run.js
//
// Regression test for the "Designer: unknown" / "Submitted by unknown"
// fix). Exercises the HubSpot note branch (section 3 of runSubmitSideEffects)
// and the team-notification email branch (section 6) of design-visits.js and
// asserts the submitter's email actually lands in the rendered strings.
//
// The standard `npm run test:design-visit` harness strips HUBSPOT_ACCESS_TOKEN
// and SMTP_*, so both branches are silently skipped there — a regression to
// the prior "unknown" shape would not be caught. This suite captures both
// branches via local override env vars (mirroring QB_API_BASE_OVERRIDE in
// test:design-visit-qb-resubmit):
//
//   • HUBSPOT_API_BASE_OVERRIDE  — points the notes POST at a local mock
//   • MAIL_TRANSPORT_FILE_OVERRIDE — captures sendMail payloads as JSONL
//
// Probes:
//   (NOTE)  HubSpot note POST body contains
//           `Designer: <submitter email>`.
//   (TEAM-TEXT) Team-notification email `text` contains
//           `Design visit submitted by <submitter email>`.
//   (TEAM-HTML) Team-notification email `html` contains
//           `Submitted by <strong><submitter email></strong>`.
//   (TEAM-NOTES-ABSENT) Team-notification email text/HTML for a visit with
//           null visit_notes does NOT contain a "Visit notes" entry.
//   (TEAM-NOTES-PRESENT) Team-notification email text/HTML for a visit with
//           non-empty visit_notes contains "Visit notes: <value>" in text
//           and the Visit notes table row in HTML.
//   (CUST-GREET)  Customer email greets the contact's first name.
//   (CUST-ROOM)   Customer email lists the seeded room name in text + html.
//   (CUST-LINK)   Customer email contains the sign-off URL (text + html).
//   (SIGNOFF-APPROVE) Team email after approve contains the "signed off"
//                     copy referencing the contact name and visit id.
//   (SIGNOFF-REVISION) Team email after revision contains the "requested
//                      changes" copy and the customer's revision note.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:design-visit-submitter-name
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:design-visit-submitter-name

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');
const { pollFn } = require('../helpers/poll');

require('dotenv').config();

const REPORT_PATH = path.join(__dirname, '..', '..', 'test-results', 'design-visit-submitter-name.md');
const CONTACT_ID  = 'privtest-dvname-contact';
const findings    = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${id} — ${detail}`);
}

function startMockHubspot() {
  const state = { posts: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/crm/v3/objects/notes') {
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch {}
        state.posts.push({ body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: 'mock-note-id', properties: body.properties || {} }));
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found', path: req.url }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, state });
    });
  });
}

async function seedVisit(pool, runId, createdById, opts = {}) {
  const { visitNotes = null } = opts;
  const r = await pool.query(
    `INSERT INTO design_visits
       (contact_id, contact_name, contact_email, created_by, visit_date,
        duration_min, location, notes, visit_notes, terms_accepted, status)
     VALUES ($1, 'PrivTest DV Name Contact', 'privtest-dvname-cust@privtest.local',
             $2, NOW(), 90, 'Test location', 'submitter-name test', $3, TRUE,
             'revision_requested')
     RETURNING id`,
    [CONTACT_ID, String(createdById), visitNotes]
  );
  const visitId = r.rows[0].id;
  await pool.query(
    `INSERT INTO design_visit_rooms
       (design_visit_id, room_name, unit_count, unit_price_pence, sort_order)
     VALUES ($1, 'Kitchen', 2, 50000, 0)`,
    [visitId]
  );
  return visitId;
}

async function cleanup(pool) {
  try {
    await pool.query(`DELETE FROM design_visits WHERE contact_id = $1`, [CONTACT_ID]);
  } catch {}
}

function readMailJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
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
  console.log(`\n  design-visit submitter-name  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });

  // ── Mock HubSpot + mail file capture ──────────────────────────────────────
  const mockHs = await startMockHubspot();
  console.log(`  mock HubSpot listening on http://127.0.0.1:${mockHs.port}`);
  const mailFile = path.join(os.tmpdir(), `dv-submitter-name-${runId}.jsonl`);
  try { fs.unlinkSync(mailFile); } catch {}

  // Configure spawned server BEFORE requiring the harness so spawnServer
  // inherits these via { ...process.env }. ADMIN_EMAILS is opt-in
  // (optionalPassthrough in the harness) — set both gates.
  process.env.HUBSPOT_API_BASE_OVERRIDE  = `http://127.0.0.1:${mockHs.port}`;
  process.env.MAIL_TRANSPORT_FILE_OVERRIDE = mailFile;
  process.env.PRIVTEST_USE_HUBSPOT_ACCESS_TOKEN = '1';
  process.env.HUBSPOT_ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN || 'privtest-fake-hs-token';
  process.env.PRIVTEST_USE_ADMIN_EMAILS = '1';
  process.env.ADMIN_EMAILS = 'admin-recipient@privtest.local';

  const {
    spawnServer, waitForServer, seedUsers, cleanupTestData,
    resetRateLimitStore, login, setPool, TEST_PORT,
  } = require('../privileges/harness');
  const BASE = `http://127.0.0.1:${TEST_PORT}`;
  setPool(pool);

  await cleanupTestData(pool);
  await resetRateLimitStore(pool);

  const { child, logBuf } = spawnServer();
  let exitCode = 1;
  try {
    await waitForServer();
    console.log('  test server up');

    // Wait for design_visits table + async ALTER columns (added async on boot).
    await pollFn(async () => {
      const r = await pool.query(`
        SELECT 1 FROM information_schema.columns
          WHERE table_name = 'design_visits'
            AND column_name = 'superseded_signoff_token_hashes'
        LIMIT 1`);
      return r.rowCount || null;
    }, 15000, 200);
    await cleanup(pool);

    const users  = await seedUsers(pool, runId);
    const member = users.member;
    const client = await login(member.email, member.password);

    const visitId = await seedVisit(pool, runId, member.id);

    const r = await client.post(`/api/design-visits/${visitId}/submit`, {});
    if (r.status !== 200) {
      record('submit', false, `submit status ${r.status} body=${r.text.slice(0, 200)}`);
    } else {
      record('submit', true, `submit returned 200`);
    }

    // The submit handler invokes runSubmitSideEffects synchronously inside the
    // POST handler (await), so by the time the 200 returns the note POST and
    // mail writes should have completed. Be defensive with a brief poll.
    await pollFn(
      () => (mockHs.state.posts.length > 0 && readMailJsonl(mailFile).length >= 1) ? true : null,
      4000, 100,
    );

    // ── (NOTE) HubSpot note body contains "Designer: <email>" ───────────────
    const expectedDesigner = `Designer: ${member.email}`;
    const notePost = mockHs.state.posts[0];
    const noteBody = notePost?.body?.properties?.hs_note_body || '';
    record('NOTE.designer-line', noteBody.includes(expectedDesigner),
      noteBody.includes(expectedDesigner)
        ? `note body contained "${expectedDesigner}"`
        : `note body did not contain "${expectedDesigner}"; got: ${JSON.stringify(noteBody).slice(0, 300)}`);

    // ── Team email captures ────────────────────────────────────────────────
    const mails = readMailJsonl(mailFile);
    const teamMail = mails.find(m =>
      typeof m.to === 'string' && m.to.includes('admin-recipient@privtest.local')
    );

    if (!teamMail) {
      const mailSummary = mails.map(m => `to=${m.to} subj=${m.subject}`).join(' | ');
      record('TEAM-TEXT.submitter-line', false,
        `no team email captured (mails=${mails.length}: ${mailSummary || 'none'})`);
      record('TEAM-HTML.submitter-line', false,
        `no team email captured`);
      record('TEAM-NOTES-ABSENT.text', false, 'no team email captured');
      record('TEAM-NOTES-ABSENT.html', false, 'no team email captured');
    } else {
      const expectedText = `Design visit submitted by ${member.email}`;
      const expectedHtml = `Submitted by <strong>${member.email}</strong>`;
      const textOk = typeof teamMail.text === 'string' && teamMail.text.includes(expectedText);
      const htmlOk = typeof teamMail.html === 'string' && teamMail.html.includes(expectedHtml);
      record('TEAM-TEXT.submitter-line', textOk,
        textOk
          ? `text contained "${expectedText}"`
          : `text did not contain "${expectedText}"; got: ${JSON.stringify(teamMail.text || '').slice(0, 300)}`);
      record('TEAM-HTML.submitter-line', htmlOk,
        htmlOk
          ? `html contained "${expectedHtml}"`
          : `html did not contain "${expectedHtml}"; got: ${JSON.stringify(teamMail.html || '').slice(0, 300)}`);

      // ── (TEAM-NOTES-ABSENT) visit_notes is null → no "Visit notes" row ──
      const notesAbsentText = typeof teamMail.text === 'string' && !teamMail.text.includes('Visit notes:');
      record('TEAM-NOTES-ABSENT.text', notesAbsentText,
        notesAbsentText
          ? 'team email text has no "Visit notes:" row when visit_notes is null'
          : `team email text unexpectedly contained "Visit notes:"; snippet: ${JSON.stringify(teamMail.text || '').slice(0, 300)}`);

      const notesAbsentHtml = typeof teamMail.html === 'string' && !teamMail.html.includes('>Visit notes<');
      record('TEAM-NOTES-ABSENT.html', notesAbsentHtml,
        notesAbsentHtml
          ? 'team email HTML has no Visit notes row when visit_notes is null'
          : `team email HTML unexpectedly contained Visit notes row; snippet: ${JSON.stringify(teamMail.html || '').slice(0, 400)}`);
    }

    // ── (TEAM-NOTES-PRESENT) visit_notes non-empty → appears in team email ─
    const notesContent = `Unique visit note ${runId}`;
    const notesVisitId = await seedVisit(pool, runId, member.id, { visitNotes: notesContent });
    const beforeNotesMails = readMailJsonl(mailFile).length;
    const notesSubmit = await client.post(`/api/design-visits/${notesVisitId}/submit`, {});
    if (notesSubmit.status !== 200) {
      record('TEAM-NOTES-PRESENT.text', false,
        `submit failed status=${notesSubmit.status} body=${notesSubmit.text.slice(0, 200)}`);
      record('TEAM-NOTES-PRESENT.html', false, 'submit failed');
    } else {
      let notesTeamMail = null;
      await pollFn(async () => {
        const mailsNow = readMailJsonl(mailFile);
        notesTeamMail = mailsNow.slice(beforeNotesMails).find(m =>
          typeof m.to === 'string' && m.to.includes('admin-recipient@privtest.local')
        );
        return notesTeamMail ? true : null;
      }, 4000, 100);

      if (!notesTeamMail) {
        const mailSummaryNotes = readMailJsonl(mailFile).slice(beforeNotesMails)
          .map(m => `to=${m.to} subj=${m.subject}`).join(' | ');
        record('TEAM-NOTES-PRESENT.text', false,
          `no team email captured after notes visit submit (new mails: ${mailSummaryNotes || 'none'})`);
        record('TEAM-NOTES-PRESENT.html', false, 'no team email captured');
      } else {
        const expectedNotesText = `Visit notes: ${notesContent}`;
        const notesPresentText = typeof notesTeamMail.text === 'string'
          && notesTeamMail.text.includes(expectedNotesText);
        record('TEAM-NOTES-PRESENT.text', notesPresentText,
          notesPresentText
            ? `team email text contained "${expectedNotesText}"`
            : `team email text missing "${expectedNotesText}"; got: ${JSON.stringify(notesTeamMail.text || '').slice(0, 300)}`);

        const notesPresentHtml = typeof notesTeamMail.html === 'string'
          && notesTeamMail.html.includes('>Visit notes<')
          && notesTeamMail.html.includes(notesContent);
        record('TEAM-NOTES-PRESENT.html', notesPresentHtml,
          notesPresentHtml
            ? `team email HTML contained Visit notes row with "${notesContent}"`
            : `team email HTML missing Visit notes row or content; got: ${JSON.stringify(notesTeamMail.html || '').slice(0, 400)}`);
      }
    }

    // ── Customer email captures (section 5 of runSubmitSideEffects) ────────
    // visit.contact_email is seeded as 'privtest-dvname-cust@privtest.local'.
    const customerMail = mails.find(m =>
      typeof m.to === 'string' && m.to.includes('privtest-dvname-cust@privtest.local')
    );

    if (!customerMail) {
      const mailSummary = mails.map(m => `to=${m.to} subj=${m.subject}`).join(' | ');
      record('CUST-GREET.first-name', false,
        `no customer email captured (mails=${mails.length}: ${mailSummary || 'none'})`);
      record('CUST-ROOM.room-name', false, 'no customer email captured');
      record('CUST-LINK.sign-off-url', false, 'no customer email captured');
    } else {
      // Contact name "PrivTest DV Name Contact" → firstName = "PrivTest".
      const expectedGreetText = 'Hi PrivTest,';
      const expectedGreetHtml = 'Hi PrivTest,'; // _esc('PrivTest') == 'PrivTest'
      const greetOk = typeof customerMail.text === 'string'
        && customerMail.text.includes(expectedGreetText)
        && typeof customerMail.html === 'string'
        && customerMail.html.includes(expectedGreetHtml);
      record('CUST-GREET.first-name', greetOk,
        greetOk
          ? `customer email greeted "${expectedGreetText}"`
          : `text/html did not greet "${expectedGreetText}"; text=${JSON.stringify(customerMail.text || '').slice(0, 200)} html=${JSON.stringify(customerMail.html || '').slice(0, 200)}`);

      const roomOk = typeof customerMail.text === 'string'
        && customerMail.text.includes('Kitchen')
        && typeof customerMail.html === 'string'
        && customerMail.html.includes('Kitchen');
      record('CUST-ROOM.room-name', roomOk,
        roomOk
          ? 'customer email listed the seeded "Kitchen" room in text + html'
          : `seeded room name "Kitchen" missing from text/html; text=${JSON.stringify(customerMail.text || '').slice(0, 200)} html=${JSON.stringify(customerMail.html || '').slice(0, 200)}`);

      const linkOk = typeof customerMail.text === 'string'
        && /\/design-visit\/sign-off\?token=[a-f0-9]{64}/.test(customerMail.text)
        && typeof customerMail.html === 'string'
        && /\/design-visit\/sign-off\?token=[a-f0-9]{64}/.test(customerMail.html);
      record('CUST-LINK.sign-off-url', linkOk,
        linkOk
          ? 'customer email contained the sign-off URL in text + html'
          : `sign-off URL missing from text/html; text=${JSON.stringify(customerMail.text || '').slice(0, 200)} html=${JSON.stringify(customerMail.html || '').slice(0, 200)}`);
    }

    // ── Sign-off route emails (approve + revision) ─────────────────────────
    // Extract the raw sign-off token from the captured customer email (the
    // server never returns it in the submit response). Then drive the public
    // sign-off route for the first visit (approve) and a second seeded visit
    // (revision) to capture the team-notification emails sent from
    // POST /api/design-visits/sign-off/:token.
    async function tokenForVisit(id) {
      const r = await pool.query(
        `SELECT signoff_token_hash FROM design_visits WHERE id = $1`, [id]
      );
      return r.rows[0]?.signoff_token_hash || null;
    }
    function extractToken(mail) {
      const src = (mail?.text || '') + '\n' + (mail?.html || '');
      const m = src.match(/\/design-visit\/sign-off\?token=([a-f0-9]{64})/);
      return m ? m[1] : null;
    }

    // Verifies the sign-off link actually resolves: a real customer clicking
    // the URL would hit GET /api/design-visits/sign-off/:token and expect
    // the visit payload (200) — not a 404 from an appBaseUrl/route drift.
    async function assertSignoffLinkResolves(idTag, token, expectedVisitId) {
      if (!token) {
        record(`${idTag}.signoff-link-resolves`, false,
          'no token available to verify GET sign-off route');
        return;
      }
      let res, body;
      try {
        res = await fetch(`${BASE}/api/design-visits/sign-off/${token}`);
        body = await res.json().catch(() => null);
      } catch (e) {
        record(`${idTag}.signoff-link-resolves`, false,
          `GET sign-off threw: ${e.message}`);
        return;
      }
      const expectedContact = 'PrivTest DV Name Contact';
      const kitchen = body && Array.isArray(body.rooms)
        ? body.rooms.find(r => r.roomName === 'Kitchen') : null;
      const grandTotal = body && Array.isArray(body.rooms)
        ? body.rooms.reduce((s, r) => s + (Number(r.totalPence) || 0), 0)
        : null;
      const ok = res.status === 200
        && body
        && body.id === expectedVisitId
        && body.contactName === expectedContact
        && !!kitchen
        && kitchen.unitCount === 2
        && kitchen.unitPricePence === 50000
        && grandTotal === 2 * 50000;
      record(`${idTag}.signoff-link-resolves`, ok,
        ok
          ? `GET sign-off 200, contactName="${expectedContact}", Kitchen room present, grand total = ${grandTotal}p`
          : `GET sign-off status=${res?.status} body=${JSON.stringify(body).slice(0, 300)}`);
    }

    const approveToken = customerMail ? extractToken(customerMail) : null;
    await assertSignoffLinkResolves('SIGNOFF-APPROVE', approveToken, visitId);
    if (!approveToken) {
      record('SIGNOFF-APPROVE.team-email', false,
        'could not extract sign-off token from customer email');
    } else {
      const approveBefore = mails.length;
      // Public route — no session needed.
      const approveRes = await fetch(`${BASE}/api/design-visits/sign-off/${approveToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve' }),
      });
      let approveMails = readMailJsonl(mailFile);
      await pollFn(async () => {
        approveMails = readMailJsonl(mailFile);
        return approveMails.length > approveBefore ? true : null;
      }, 3000, 100);
      const approveTeamMail = approveMails.slice(approveBefore).find(m =>
        typeof m.subject === 'string' && m.subject.startsWith('Design visit signed off')
      );
      const expectedApprove = `${'PrivTest DV Name Contact'} has approved and signed off their design visit (#${visitId}).`;
      const approveOk = approveRes.ok
        && approveTeamMail
        && typeof approveTeamMail.text === 'string'
        && approveTeamMail.text.includes(expectedApprove);
      record('SIGNOFF-APPROVE.team-email', approveOk,
        approveOk
          ? `approve team email contained "${expectedApprove}"`
          : `approve status=${approveRes.status} mail=${JSON.stringify(approveTeamMail || null).slice(0, 300)}`);
    }

    // Revision: needs a fresh visit (the approve path nulls the token hash).
    const revisionVisitId = await seedVisit(pool, runId, member.id);
    const submit2 = await client.post(`/api/design-visits/${revisionVisitId}/submit`, {});
    if (submit2.status !== 200) {
      record('SIGNOFF-REVISION.team-email', false,
        `second submit failed status=${submit2.status} body=${submit2.text.slice(0, 200)}`);
    } else {
      // Wait briefly for the second customer email to land.
      let mails2 = readMailJsonl(mailFile);
      let customerMail2 = mails2.slice().reverse().find(m =>
        typeof m.to === 'string' && m.to.includes('privtest-dvname-cust@privtest.local')
      );
      await pollFn(async () => {
        mails2 = readMailJsonl(mailFile);
        customerMail2 = mails2.slice().reverse().find(m =>
          typeof m.to === 'string' && m.to.includes('privtest-dvname-cust@privtest.local')
        );
        return extractToken(customerMail2 || {}) !== null ? true : null;
      }, 3000, 100);
      // Filter to the customer mail whose token actually matches the new visit.
      const newTokenHash = await tokenForVisit(revisionVisitId);
      const candidates = readMailJsonl(mailFile).filter(m =>
        typeof m.to === 'string' && m.to.includes('privtest-dvname-cust@privtest.local')
      );
      const crypto = require('crypto');
      const customerMailRevision = candidates.find(m => {
        const t = extractToken(m);
        if (!t) return false;
        const h = crypto.createHash('sha256').update(t).digest('hex');
        return h === newTokenHash;
      });
      const revisionToken = customerMailRevision ? extractToken(customerMailRevision) : null;
      await assertSignoffLinkResolves('SIGNOFF-REVISION', revisionToken, revisionVisitId);

      if (!revisionToken) {
        record('SIGNOFF-REVISION.team-email', false,
          'could not extract sign-off token for revision visit');
      } else {
        const beforeRev = readMailJsonl(mailFile).length;
        const note = `please change door colour ${runId}`;
        const revRes = await fetch(`${BASE}/api/design-visits/sign-off/${revisionToken}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'revision', note }),
        });
        let revMails = readMailJsonl(mailFile);
        await pollFn(async () => {
          revMails = readMailJsonl(mailFile);
          return revMails.length > beforeRev ? true : null;
        }, 3000, 100);
        const revTeamMail = revMails.slice(beforeRev).find(m =>
          typeof m.subject === 'string' && m.subject.startsWith('Design visit revision requested')
        );
        const expectedRev = `${'PrivTest DV Name Contact'} has requested changes to design visit #${revisionVisitId}.`;
        const expectedNoteLine = `Note: ${note}`;
        const revOk = revRes.ok
          && revTeamMail
          && typeof revTeamMail.text === 'string'
          && revTeamMail.text.includes(expectedRev)
          && revTeamMail.text.includes(expectedNoteLine);
        record('SIGNOFF-REVISION.team-email', revOk,
          revOk
            ? `revision team email contained "${expectedRev}" + "${expectedNoteLine}"`
            : `revision status=${revRes.status} mail=${JSON.stringify(revTeamMail || null).slice(0, 400)}`);
      }
    }

    exitCode = findings.every(f => f.ok) ? 0 : 1;
  } catch (e) {
    console.error('  fatal:', e.stack || e.message);
    record('harness', false, `fatal: ${e.message}`);
    exitCode = 1;
  } finally {
    try { await cleanup(pool); } catch {}
    try { await cleanupTestData(pool); } catch {}
    try { child.kill('SIGTERM'); } catch {}
    try { mockHs.server.close(); } catch {}
    try { fs.unlinkSync(mailFile); } catch {}
    await pool.end().catch(() => {});

    const lines = [
      '# design-visit submitter-name findings',
      '',
      `Run: ${new Date().toISOString()}`,
      `Result: ${findings.every(f => f.ok) ? 'PASS' : 'FAIL'} (${findings.filter(f => f.ok).length}/${findings.length})`,
      '',
      '| ID | Result | Detail |',
      '|----|--------|--------|',
      ...findings.map(f => `| ${f.id} | ${f.ok ? 'PASS' : 'FAIL'} | ${String(f.detail).replace(/\\/g, '\\\\').replace(/\|/g, '\\|')} |`),
    ];
    try {
      fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
      fs.writeFileSync(REPORT_PATH, lines.join('\n') + '\n');
      console.log(`  report -> ${REPORT_PATH}`);
    } catch (e) {
      console.warn('  report write failed:', e.message);
    }
  }

  process.exit(exitCode);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
