'use strict';
// test/design-visit-submitter-name/run.js
//
// Regression test for task #740 ("Designer: unknown" / "Submitted by unknown"
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
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:design-visit-submitter-name
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:design-visit-submitter-name

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

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

async function seedVisit(pool, runId, submitterEmail) {
  const r = await pool.query(
    `INSERT INTO design_visits
       (contact_id, contact_name, contact_email, created_by, visit_date,
        duration_min, location, notes, terms_accepted, status)
     VALUES ($1, 'PrivTest DV Name Contact', 'privtest-dvname-cust@privtest.local',
             $2, NOW(), 90, 'Test location', 'submitter-name test', TRUE,
             'revision_requested')
     RETURNING id`,
    [CONTACT_ID, submitterEmail]
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
    resetRateLimitStore, login, setPool,
  } = require('../privileges/harness');
  setPool(pool);

  await cleanupTestData(pool);
  await resetRateLimitStore(pool);

  const { child, logBuf } = spawnServer();
  let exitCode = 1;
  try {
    await waitForServer();
    console.log('  test server up');

    // Wait for design_visits table + async ALTER columns (added async on boot).
    {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const r = await pool.query(`
          SELECT 1 FROM information_schema.columns
            WHERE table_name = 'design_visits'
              AND column_name = 'superseded_signoff_token_hashes'
          LIMIT 1`);
        if (r.rowCount) break;
        await new Promise(res => setTimeout(res, 200));
      }
    }
    await cleanup(pool);

    const users  = await seedUsers(pool, runId);
    const member = users.member;
    const client = await login(member.email, member.password);

    const visitId = await seedVisit(pool, runId, `privtest-dvname-${runId}@privtest.local`);

    const r = await client.post(`/api/design-visits/${visitId}/submit`, {});
    if (r.status !== 200) {
      record('submit', false, `submit status ${r.status} body=${r.text.slice(0, 200)}`);
    } else {
      record('submit', true, `submit returned 200`);
    }

    // The submit handler invokes runSubmitSideEffects synchronously inside the
    // POST handler (await), so by the time the 200 returns the note POST and
    // mail writes should have completed. Be defensive with a brief poll.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline
      && (mockHs.state.posts.length === 0 || readMailJsonl(mailFile).length < 1)) {
      await new Promise(res => setTimeout(res, 100));
    }

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
      ...findings.map(f => `| ${f.id} | ${f.ok ? 'PASS' : 'FAIL'} | ${String(f.detail).replace(/\|/g, '\\|')} |`),
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
