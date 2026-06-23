'use strict';
// test/survey-visit-email-notes/run.js
//
// Integration test covering visit_notes surfaces in the survey-visit
// email/HubSpot pipeline. Mirrors test/design-visit-submitter-name/run.js
// for the survey-visit module (survey-visits.js).
//
// Uses HUBSPOT_API_BASE_OVERRIDE and MAIL_TRANSPORT_FILE_OVERRIDE so the
// HubSpot note POST and sendMail calls are captured locally without real
// credentials or an SMTP server.
//
// Probes:
//   (NOTE)               HubSpot note body includes "Visit notes:\n<value>"
//                        when visit_notes is present on submit.
//   (CUST-NOTES-ABSENT)  Customer sign-off email text + HTML contain no Visit
//                        Notes section when visit_notes is null.
//   (CUST-NOTES-PRESENT) Customer sign-off email text + HTML contain the Visit
//                        Notes section and the note value when visit_notes is
//                        set.
//   (TEAM-NOTES-ABSENT)  Team notification email text + HTML have no Visit
//                        Notes section when visit_notes is null.
//   (TEAM-NOTES-PRESENT) Team notification email text + HTML contain the Visit
//                        Notes section and the note value when visit_notes is
//                        set.
//   (RESEND-NOTES-ABSENT)  Resend sign-off email text + HTML contain no Visit
//                           Notes section when visit_notes is null.
//   (RESEND-NOTES-PRESENT) Resend sign-off email text + HTML contain the Visit
//                           Notes section and the note value when visit_notes
//                           is set.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:survey-visit-email-notes
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:survey-visit-email-notes

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');
const { pollFn } = require('../helpers/poll');

require('dotenv').config();

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'survey-visit-email-notes.md'
);
const CONTACT_ID  = 'privtest-sven-contact';
const TEAM_EMAIL  = 'sven-admin@privtest.local';
const findings    = [];

const PROBE_LABELS = [
  '(NOTE) HubSpot note body includes visit_notes line when visit_notes is present',
  '(CUST-NOTES-ABSENT) customer email text and HTML have no Visit Notes section when visit_notes is null',
  '(CUST-NOTES-PRESENT) customer email text and HTML contain Visit Notes section when visit_notes is set',
  '(TEAM-NOTES-ABSENT) team notification email text and HTML have no Visit Notes section when visit_notes is null',
  '(TEAM-NOTES-PRESENT) team notification email text and HTML contain Visit Notes section when visit_notes is set',
  '(RESEND-NOTES-ABSENT) resend sign-off email text and HTML have no Visit Notes section when visit_notes is null',
  '(RESEND-NOTES-PRESENT) resend sign-off email text and HTML contain Visit Notes section when visit_notes is set',
];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}

function startMockHubspot() {
  const state = { notes: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/crm/v3/objects/notes') {
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch {}
        state.notes.push({ body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: 'mock-note-id', properties: body.properties || {} }));
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found', path: req.url }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, state });
    });
  });
}

function readMailJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

async function cleanup(pool) {
  try {
    await pool.query(
      `DELETE FROM survey_visits
        WHERE contact_id = $1 AND created_by LIKE 'privtest-%'`,
      [CONTACT_ID]
    );
  } catch {}
}

function writeReport(runId) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}

  const pass = findings.filter(f => f.ok).length;
  const fail = findings.filter(f => !f.ok).length;
  const esc  = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

  const lines = [
    '# Survey Visit Email Notes — integration test report',
    '',
    `Run: \`${runId}\``,
    '',
    `**${pass} passed, ${fail} failed**`,
    '',
    '| Result | Probe | Detail |',
    '| ------ | ----- | ------ |',
    ...findings.map(f => `| ${f.ok ? 'PASS' : 'FAIL'} | ${esc(f.id)} | ${esc(f.detail)} |`),
    '',
    '## Coverage',
    '',
    '- **(NOTE)**: HubSpot note POST body includes `Visit notes:\\n<value>` when',
    '  `visit_notes` is set on the submitted visit.',
    '- **(CUST-NOTES-ABSENT)**: Customer sign-off email (text + HTML) contains no',
    '  Visit Notes section when `visit_notes` is null.',
    '- **(CUST-NOTES-PRESENT)**: Customer sign-off email (text + HTML) contains the',
    '  Visit Notes section and the note value when `visit_notes` is set.',
    '- **(TEAM-NOTES-ABSENT)**: Team notification email (text + HTML) contains no',
    '  Visit Notes section when `visit_notes` is null.',
    '- **(TEAM-NOTES-PRESENT)**: Team notification email (text + HTML) contains the',
    '  Visit Notes section and the note value when `visit_notes` is set.',
    '- **(RESEND-NOTES-ABSENT)**: Resend sign-off email (text + HTML) contains no',
    '  Visit Notes section when `visit_notes` is null.',
    '- **(RESEND-NOTES-PRESENT)**: Resend sign-off email (text + HTML) contains the',
    '  Visit Notes section and the note value when `visit_notes` is set.',
  ];

  fs.writeFileSync(REPORT_PATH, lines.join('\n') + '\n');
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
  console.log(`\n  survey-visit-email-notes  run=${runId}`);
  console.log(
    `  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`
  );

  const pool = new Pool({ connectionString: connStr });

  // ── Mock HubSpot + mail file capture ──────────────────────────────────────
  const mockHs = await startMockHubspot();
  console.log(`  mock HubSpot listening on http://127.0.0.1:${mockHs.port}`);

  const mailFile = path.join(os.tmpdir(), `survey-visit-email-notes-${runId}.jsonl`);
  try { fs.unlinkSync(mailFile); } catch {}

  // Set env vars BEFORE requiring the harness so spawnServer inherits them.
  process.env.HUBSPOT_API_BASE_OVERRIDE         = `http://127.0.0.1:${mockHs.port}`;
  process.env.MAIL_TRANSPORT_FILE_OVERRIDE      = mailFile;
  process.env.PRIVTEST_USE_HUBSPOT_ACCESS_TOKEN = '1';
  process.env.HUBSPOT_ACCESS_TOKEN              =
    process.env.HUBSPOT_ACCESS_TOKEN || 'privtest-fake-hs-token';
  process.env.PRIVTEST_USE_ADMIN_EMAILS         = '1';
  process.env.ADMIN_EMAILS                      = TEAM_EMAIL;

  const {
    spawnServer, waitForServer, seedUsers, cleanupTestData,
    resetRateLimitStore, login, setPool, PASSWORD,
  } = require('../privileges/harness');
  setPool(pool);

  await cleanupTestData(pool);
  await resetRateLimitStore(pool);

  const { child, logBuf } = spawnServer();
  let exitCode = 1;

  try {
    await waitForServer();
    console.log('  test server up');

    // Wait for the survey_visits table (migrations run on boot).
    await pollFn(async () => {
      const r = await pool.query(`SELECT to_regclass('survey_visits') AS t`);
      return r.rows[0]?.t || null;
    }, 15000, 200);

    await cleanup(pool);

    const users  = await seedUsers(pool, runId);
    const member = users.member;
    const admin  = users.admin;
    const client = await login(member.email, PASSWORD);
    const adminClient = await login(admin.email, PASSWORD);

    const CUSTOMER_EMAIL = 'sven-customer@privtest.local';

    // ── (CUST-NOTES-ABSENT) + (TEAM-NOTES-ABSENT) ───────────────────────────
    // Submit with null visit_notes; poll for both customer and team emails.
    console.log('\n  [CUST-NOTES-ABSENT + TEAM-NOTES-ABSENT] submit with no visit_notes');

    const absentBefore = readMailJsonl(mailFile).length;
    const absentRes = await client.post('/api/survey-visits', {
      contactId:     CONTACT_ID,
      contactName:   'SVEN Test Customer',
      contactEmail:  CUSTOMER_EMAIL,
      termsAccepted: true,
      rooms: [{ roomName: 'Kitchen', unitCount: 1, unitPricePence: 0 }],
      handlerConfig: {},
    });

    if (absentRes.status !== 201) {
      record('CUST-NOTES-ABSENT', false,
        `submit returned status=${absentRes.status} body=${JSON.stringify(absentRes.json).slice(0, 200)}`);
      record('TEAM-NOTES-ABSENT', false, 'submit failed');
    } else {
      let absentCustMail = null;
      let absentTeamMail = null;
      await pollFn(async () => {
        const mails = readMailJsonl(mailFile).slice(absentBefore);
        absentCustMail = absentCustMail || mails.find(
          m => typeof m.to === 'string' && m.to.includes(CUSTOMER_EMAIL)
        );
        absentTeamMail = absentTeamMail || mails.find(
          m => typeof m.to === 'string' && m.to.includes(TEAM_EMAIL)
        );
        return (absentCustMail && absentTeamMail) ? true : null;
      }, 6000, 100);

      // CUST-NOTES-ABSENT
      if (!absentCustMail) {
        const snap = readMailJsonl(mailFile).slice(absentBefore);
        record('CUST-NOTES-ABSENT', false,
          `no customer email captured (${snap.length} mail(s): ${snap.map(m => `to=${m.to}`).join(' | ')})`);
      } else {
        const textOk = typeof absentCustMail.text === 'string'
          && !absentCustMail.text.includes('--- Visit Notes ---');
        const htmlOk = typeof absentCustMail.html === 'string'
          && !absentCustMail.html.includes('Visit Notes');
        record('CUST-NOTES-ABSENT', textOk && htmlOk,
          textOk && htmlOk
            ? 'customer email text + HTML have no Visit Notes section when visit_notes is null'
            : `unexpected Visit Notes in customer email; text-ok=${textOk} html-ok=${htmlOk}; `
              + `text=${JSON.stringify((absentCustMail.text || '').slice(0, 200))} `
              + `html=${JSON.stringify((absentCustMail.html || '').slice(0, 200))}`);
      }

      // TEAM-NOTES-ABSENT
      if (!absentTeamMail) {
        const snap = readMailJsonl(mailFile).slice(absentBefore);
        record('TEAM-NOTES-ABSENT', false,
          `no team email captured (${snap.length} mail(s): ${snap.map(m => `to=${m.to}`).join(' | ')})`);
      } else {
        const textOk = typeof absentTeamMail.text === 'string'
          && !absentTeamMail.text.includes('Visit notes:');
        const htmlOk = typeof absentTeamMail.html === 'string'
          && !absentTeamMail.html.includes('Visit notes');
        record('TEAM-NOTES-ABSENT', textOk && htmlOk,
          textOk && htmlOk
            ? 'team notification email text + HTML have no Visit Notes section when visit_notes is null'
            : `unexpected Visit Notes in team email; text-ok=${textOk} html-ok=${htmlOk}; `
              + `text=${JSON.stringify((absentTeamMail.text || '').slice(0, 200))} `
              + `html=${JSON.stringify((absentTeamMail.html || '').slice(0, 200))}`);
      }
    }

    // ── (NOTE) + (CUST-NOTES-PRESENT) + (TEAM-NOTES-PRESENT) ───────────────
    // Submit with non-null visit_notes; poll for HubSpot note, customer email,
    // and team email.
    console.log('\n  [NOTE + CUST-NOTES-PRESENT + TEAM-NOTES-PRESENT] submit with visit_notes set');

    const notesContent = `Unique survey visit note ${runId}`;
    const notesBefore  = mockHs.state.notes.length;
    const mailsBefore  = readMailJsonl(mailFile).length;

    const notesRes = await client.post('/api/survey-visits', {
      contactId:     CONTACT_ID,
      contactName:   'SVEN Test Customer',
      contactEmail:  CUSTOMER_EMAIL,
      visitNotes:    notesContent,
      termsAccepted: true,
      rooms: [{ roomName: 'Kitchen', unitCount: 1, unitPricePence: 0 }],
      handlerConfig: {},
    });

    if (notesRes.status !== 201) {
      record('NOTE', false,
        `submit returned status=${notesRes.status} body=${JSON.stringify(notesRes.json).slice(0, 200)}`);
      record('CUST-NOTES-PRESENT', false, 'submit failed');
      record('TEAM-NOTES-PRESENT', false, 'submit failed');
    } else {
      let notePost      = null;
      let notesCustMail = null;
      let notesTeamMail = null;
      await pollFn(async () => {
        const newNotes = mockHs.state.notes.slice(notesBefore);
        if (newNotes.length > 0) notePost = notePost || newNotes[0];
        const mails = readMailJsonl(mailFile).slice(mailsBefore);
        notesCustMail = notesCustMail || mails.find(
          m => typeof m.to === 'string' && m.to.includes(CUSTOMER_EMAIL)
        );
        notesTeamMail = notesTeamMail || mails.find(
          m => typeof m.to === 'string' && m.to.includes(TEAM_EMAIL)
        );
        return (notePost && notesCustMail && notesTeamMail) ? true : null;
      }, 7000, 100);

      // (NOTE) HubSpot note body
      if (!notePost) {
        record('NOTE', false,
          `no HubSpot note POST captured after submit with visit_notes; `
          + `total notes so far: ${mockHs.state.notes.length}`);
      } else {
        const noteBody     = notePost.body?.properties?.hs_note_body || '';
        const expectedLine = `Visit notes:\n${notesContent}`;
        const noteOk       = noteBody.includes(expectedLine);
        record('NOTE', noteOk,
          noteOk
            ? 'HubSpot note body contained the visit_notes line'
            : `note body missing expected line; got: ${JSON.stringify(noteBody).slice(0, 300)}`);
      }

      // (CUST-NOTES-PRESENT) Customer email
      if (!notesCustMail) {
        const snap = readMailJsonl(mailFile).slice(mailsBefore);
        record('CUST-NOTES-PRESENT', false,
          `no customer email captured after notes submit (${snap.length} mail(s): `
          + `${snap.map(m => `to=${m.to}`).join(' | ')})`);
      } else {
        const textOk = typeof notesCustMail.text === 'string'
          && notesCustMail.text.includes('--- Visit Notes ---')
          && notesCustMail.text.includes(notesContent);
        const htmlOk = typeof notesCustMail.html === 'string'
          && notesCustMail.html.includes('Visit Notes')
          && notesCustMail.html.includes(notesContent);
        record('CUST-NOTES-PRESENT', textOk && htmlOk,
          textOk && htmlOk
            ? 'customer email text + HTML contain Visit Notes section with the note value'
            : `Visit Notes section missing or content absent; text-ok=${textOk} html-ok=${htmlOk}; `
              + `text=${JSON.stringify((notesCustMail.text || '').slice(0, 200))} `
              + `html=${JSON.stringify((notesCustMail.html || '').slice(0, 200))}`);
      }

      // (TEAM-NOTES-PRESENT) Team notification email contains visit_notes when set
      if (!notesTeamMail) {
        const snap = readMailJsonl(mailFile).slice(mailsBefore);
        record('TEAM-NOTES-PRESENT', false,
          `no team email captured after notes submit (${snap.length} mail(s): `
          + `${snap.map(m => `to=${m.to}`).join(' | ')})`);
      } else {
        const textOk = typeof notesTeamMail.text === 'string'
          && notesTeamMail.text.includes('Visit notes:')
          && notesTeamMail.text.includes(notesContent);
        const htmlOk = typeof notesTeamMail.html === 'string'
          && notesTeamMail.html.includes('Visit notes')
          && notesTeamMail.html.includes(notesContent);
        record('TEAM-NOTES-PRESENT', textOk && htmlOk,
          textOk && htmlOk
            ? 'team notification email text + HTML contain Visit Notes section with the note value'
            : `Visit Notes missing from team email; text-ok=${textOk} html-ok=${htmlOk}; `
              + `text=${JSON.stringify((notesTeamMail.text || '').slice(0, 200))} `
              + `html=${JSON.stringify((notesTeamMail.html || '').slice(0, 200))}`);
      }
    }

    // ── (RESEND-NOTES-ABSENT) ────────────────────────────────────────────────
    // Resend the sign-off link for the no-notes visit; customer email must not
    // contain a Visit Notes section.
    console.log('\n  [RESEND-NOTES-ABSENT] resend sign-off for visit with no visit_notes');

    const absentVisitId = absentRes.status === 201 ? absentRes.json?.surveyVisitId : null;
    if (!absentVisitId) {
      record('RESEND-NOTES-ABSENT', false,
        'skipped — initial absent-notes submit did not return a surveyVisitId');
    } else {
      const resendAbsentBefore = readMailJsonl(mailFile).length;
      const resendAbsentRes = await adminClient.post(
        `/api/survey-visits/${absentVisitId}/resend-signoff`, {}
      );
      if (resendAbsentRes.status !== 200) {
        record('RESEND-NOTES-ABSENT', false,
          `resend returned status=${resendAbsentRes.status} body=${JSON.stringify(resendAbsentRes.json).slice(0, 200)}`);
      } else {
        let resendAbsentMail = null;
        await pollFn(async () => {
          const mails = readMailJsonl(mailFile).slice(resendAbsentBefore);
          resendAbsentMail = resendAbsentMail || mails.find(
            m => typeof m.to === 'string' && m.to.includes(CUSTOMER_EMAIL)
          );
          return resendAbsentMail ? true : null;
        }, 6000, 100);

        if (!resendAbsentMail) {
          const snap = readMailJsonl(mailFile).slice(resendAbsentBefore);
          record('RESEND-NOTES-ABSENT', false,
            `no customer email captured after resend (${snap.length} mail(s): `
            + `${snap.map(m => `to=${m.to}`).join(' | ')})`);
        } else {
          const textOk = typeof resendAbsentMail.text === 'string'
            && !resendAbsentMail.text.includes('--- Visit Notes ---');
          const htmlOk = typeof resendAbsentMail.html === 'string'
            && !resendAbsentMail.html.includes('Visit Notes');
          record('RESEND-NOTES-ABSENT', textOk && htmlOk,
            textOk && htmlOk
              ? 'resend email text + HTML have no Visit Notes section when visit_notes is null'
              : `unexpected Visit Notes in resend email; text-ok=${textOk} html-ok=${htmlOk}; `
                + `text=${JSON.stringify((resendAbsentMail.text || '').slice(0, 200))} `
                + `html=${JSON.stringify((resendAbsentMail.html || '').slice(0, 200))}`);
        }
      }
    }

    // ── (RESEND-NOTES-PRESENT) ───────────────────────────────────────────────
    // Resend the sign-off link for the visit with notes set; customer email
    // must include the Visit Notes section with the note value.
    console.log('\n  [RESEND-NOTES-PRESENT] resend sign-off for visit with visit_notes set');

    const notesVisitId = notesRes.status === 201 ? notesRes.json?.surveyVisitId : null;
    if (!notesVisitId) {
      record('RESEND-NOTES-PRESENT', false,
        'skipped — initial notes-present submit did not return a surveyVisitId');
    } else {
      const resendNotesBefore = readMailJsonl(mailFile).length;
      const resendNotesRes = await adminClient.post(
        `/api/survey-visits/${notesVisitId}/resend-signoff`, {}
      );
      if (resendNotesRes.status !== 200) {
        record('RESEND-NOTES-PRESENT', false,
          `resend returned status=${resendNotesRes.status} body=${JSON.stringify(resendNotesRes.json).slice(0, 200)}`);
      } else {
        let resendNotesMail = null;
        await pollFn(async () => {
          const mails = readMailJsonl(mailFile).slice(resendNotesBefore);
          resendNotesMail = resendNotesMail || mails.find(
            m => typeof m.to === 'string' && m.to.includes(CUSTOMER_EMAIL)
          );
          return resendNotesMail ? true : null;
        }, 6000, 100);

        if (!resendNotesMail) {
          const snap = readMailJsonl(mailFile).slice(resendNotesBefore);
          record('RESEND-NOTES-PRESENT', false,
            `no customer email captured after resend (${snap.length} mail(s): `
            + `${snap.map(m => `to=${m.to}`).join(' | ')})`);
        } else {
          const textOk = typeof resendNotesMail.text === 'string'
            && resendNotesMail.text.includes('--- Visit Notes ---')
            && resendNotesMail.text.includes(notesContent);
          const htmlOk = typeof resendNotesMail.html === 'string'
            && resendNotesMail.html.includes('Visit Notes')
            && resendNotesMail.html.includes(notesContent);
          record('RESEND-NOTES-PRESENT', textOk && htmlOk,
            textOk && htmlOk
              ? 'resend email text + HTML contain Visit Notes section with the note value'
              : `Visit Notes section missing or content absent in resend email; text-ok=${textOk} html-ok=${htmlOk}; `
                + `text=${JSON.stringify((resendNotesMail.text || '').slice(0, 200))} `
                + `html=${JSON.stringify((resendNotesMail.html || '').slice(0, 200))}`);
        }
      }
    }

    exitCode = findings.filter(f => !f.ok).length > 0 ? 1 : 0;
  } catch (e) {
    console.error('Uncaught error in test body:', e);
    exitCode = 2;
  } finally {
    try { if (!child.killed) child.kill('SIGTERM'); } catch {}
    try { mockHs.server.close(); } catch {}
    try { fs.unlinkSync(mailFile); } catch {}
    try {
      await cleanup(pool);
      await cleanupTestData(pool);
    } catch {}
    await pool.end().catch(() => {});

    const pass = findings.filter(f => f.ok).length;
    const fail = findings.filter(f => !f.ok).length;
    writeReport(runId);
    console.log(`\n  Results: ${pass} passed, ${fail} failed`);

    try {
      const logSnippet = (logBuf || []).join('').slice(-1000);
      if (fail > 0 && logSnippet) console.log('  Server log tail:\n' + logSnippet);
    } catch {}

    process.exit(exitCode);
  }
}

main().catch(e => { console.error(e); process.exit(2); });
