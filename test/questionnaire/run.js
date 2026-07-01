'use strict';
// test/questionnaire/run.js

const PROBE_LABELS = [
  '(ADMIN-AUTH) member POST to admin question endpoint returns 403',
  '(CREATE) admin creates visit-scope and room-scope questions',
  '(LIST) admin GET lists all created questions',
  '(MEMBER-FILTER) member applies_to=design filter returns only design questions',
  '(REORDER) bulk reorder updates sort_order',
  '(UPDATE) PATCH updates question label',
  '(ANSWER-SAVE) member saves answers to a design visit',
  '(ANSWER-LOAD) saved answers round-trip via GET',
  '(ANSWER-REPLACE) re-saving answers replaces the prior set',
  '(DELETE) admin deletes a question',
];


//
// API test for the shared questionnaire engine (visit_questions / visit_answers)
// introduced by the "Visits foundation" task. Boots a disposable server via the
// privileges harness and exercises:
//   (ADMIN-AUTH)  POST /api/admin/visit-questions is admin-only (member → 403).
//   (CREATE)      admin creates visit-scope + room-scope questions.
//   (LIST)        admin GET /api/admin/visit-questions returns the created rows.
//   (MEMBER-FILTER) member GET /api/visit-questions?applies_to=design returns
//                   only active questions applying to design, both scopes.
//   (REORDER)     PATCH /api/admin/visit-questions/reorder re-sorts the rows.
//   (UPDATE)      PATCH /api/admin/visit-questions/:id edits a label.
//   (ANSWER-SAVE) member POST /api/design-visits/:id/answers persists answers.
//   (ANSWER-LOAD) member GET  /api/design-visits/:id/answers round-trips them.
//   (ANSWER-REPLACE) re-saving answers replaces the prior set (delete-then-insert).
//   (DELETE)      admin DELETE /api/admin/visit-questions/:id removes a question.
//
// Usage:
//   npm run test:questionnaire:ci                 (isolated temp DB — preferred)
//   DATABASE_URL_TEST=<disposable> npm run test:questionnaire
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:questionnaire

const PROBE_LABELS = [
  '(ADMIN-AUTH) member POST /api/admin/visit-questions returns 403',
  '(CREATE) admin creates visit-scope and room-scope questions',
  '(LIST) admin GET returns all created question rows',
  '(MEMBER-FILTER) member GET filters by applies_to and excludes other-scope questions',
  '(REORDER) bulk PATCH reorder updates sort_order values',
  '(UPDATE) PATCH edits a question label',
  '(ANSWER-SAVE) member POST answers persists rows',
  '(ANSWER-LOAD) GET answers round-trips saved values',
  '(ANSWER-REPLACE) re-save replaces the prior answer set (delete-then-insert)',
  '(DELETE) admin DELETE removes a question from the list',
];

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { pollFn } = require('../helpers/poll');

require('dotenv').config();

const REPORT_PATH = path.join(__dirname, '..', '..', 'test-results', 'questionnaire.md');
const CONTACT_ID  = 'privtest-quiz-contact';
const findings    = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}

async function cleanupQuestions(pool) {
  try { await pool.query(`DELETE FROM design_visits WHERE contact_id = $1`, [CONTACT_ID]); } catch {}
  try { await pool.query(`DELETE FROM visit_questions WHERE label LIKE 'privtest-quiz%'`); } catch {}
}

async function seedVisit(pool) {
  const r = await pool.query(
    `INSERT INTO design_visits (contact_id, created_by, terms_accepted, status)
     VALUES ($1, 'privtest', TRUE, 'draft') RETURNING id`,
    [CONTACT_ID],
  );
  return r.rows[0].id;
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
  console.log(`\n  questionnaire  run=${runId}  (${hasTestDb ? 'isolated' : 'shared'} DB)`);

  const pool = new Pool({ connectionString: connStr });
  const {
    spawnServer, waitForServer, seedUsers, cleanupTestData,
    resetRateLimitStore, login, setPool,
  } = require('../privileges/harness');
  setPool(pool);

  await cleanupTestData(pool);
  await resetRateLimitStore(pool);

  const { child } = spawnServer();
  let exitCode = 1;
  try {
    await waitForServer();
    console.log('  test server up');

    await pollFn(async () => {
      const r = await pool.query(`SELECT to_regclass('public.visit_questions') AS reg`);
      return r.rows[0]?.reg ? true : null;
    }, 15000, 200);

    await cleanupQuestions(pool);

    const users  = await seedUsers(pool, runId);
    const admin  = await login(users.admin.email, users.admin.password);
    const member = await login(users.member.email, users.member.password);

    // ── (ADMIN-AUTH) member cannot create questions ──────────────────────────
    const forbid = await member.post('/api/admin/visit-questions', {
      label: 'privtest-quiz forbidden', scope: 'visit', type: 'text', applies_to: ['design'],
    });
    record('ADMIN-AUTH.member-403', forbid.status === 403,
      `member POST /api/admin/visit-questions → ${forbid.status} (expected 403)`);

    // ── (CREATE) admin creates a visit-scope + room-scope question ───────────
    const cVisit = await admin.post('/api/admin/visit-questions', {
      label: 'privtest-quiz owner?', scope: 'visit', type: 'yesno',
      applies_to: ['design'], required: true, sort_order: 1,
    });
    const cRoom = await admin.post('/api/admin/visit-questions', {
      label: 'privtest-quiz wall finish', scope: 'room', type: 'choice',
      applies_to: ['design'], options: ['Tile', 'Paint'], required: false, sort_order: 2,
    });
    const cOther = await admin.post('/api/admin/visit-questions', {
      label: 'privtest-quiz survey only', scope: 'visit', type: 'text',
      applies_to: ['survey'], required: false, sort_order: 3,
    });
    const visitQId = cVisit.json?.id;
    const roomQId  = cRoom.json?.id;
    record('CREATE.visit-scope', cVisit.status === 201 && Number.isFinite(visitQId),
      `create visit question → ${cVisit.status} id=${visitQId}`);
    record('CREATE.room-scope', cRoom.status === 201 && Number.isFinite(roomQId),
      `create room question → ${cRoom.status} id=${roomQId}`);
    record('CREATE.other-applies-to', cOther.status === 201,
      `create survey-only question → ${cOther.status}`);

    // ── (LIST) admin sees all created rows ───────────────────────────────────
    const list = await admin.get('/api/admin/visit-questions');
    const listIds = Array.isArray(list.json) ? list.json.map(q => q.id) : [];
    const hasAll = [visitQId, roomQId, cOther.json?.id].every(id => listIds.includes(id));
    record('LIST.admin-sees-all', list.status === 200 && hasAll,
      `admin list → ${list.status}, contains created ids: ${hasAll}`);

    // ── (MEMBER-FILTER) design questions only, active only ───────────────────
    const mList = await member.get('/api/visit-questions?applies_to=design');
    const mIds  = Array.isArray(mList.json) ? mList.json.map(q => q.id) : [];
    const designOk = mIds.includes(visitQId) && mIds.includes(roomQId) && !mIds.includes(cOther.json?.id);
    record('MEMBER-FILTER.applies_to', mList.status === 200 && designOk,
      `member design filter → ${mList.status}; includes design qs and excludes survey-only: ${designOk}`);

    // ── (REORDER) bulk reorder swaps sort_order ──────────────────────────────
    const reorder = await admin.patch('/api/admin/visit-questions/reorder', {
      order: [{ id: visitQId, sort_order: 9 }, { id: roomQId, sort_order: 1 }],
    });
    const reVisit = Array.isArray(reorder.json) ? reorder.json.find(q => q.id === visitQId) : null;
    record('REORDER.sort_order', reorder.status === 200 && reVisit?.sort_order === 9,
      `reorder → ${reorder.status}; visit question sort_order now ${reVisit?.sort_order} (expected 9)`);

    // ── (UPDATE) edit a question label ───────────────────────────────────────
    const upd = await admin.patch(`/api/admin/visit-questions/${visitQId}`, {
      label: 'privtest-quiz owner (edited)',
    });
    record('UPDATE.label', upd.status === 200 && upd.json?.label === 'privtest-quiz owner (edited)',
      `update label → ${upd.status}; label="${upd.json?.label}"`);

    // ── (ANSWER-SAVE / LOAD) member round-trip ───────────────────────────────
    const visitId = await seedVisit(pool);
    const save = await member.post(`/api/design-visits/${visitId}/answers`, {
      answers: [
        { question_id: visitQId, answer: true },
        { question_id: roomQId, answer: 'Tile' },
      ],
    });
    record('ANSWER-SAVE.persist', save.status === 200 && Array.isArray(save.json) && save.json.length === 2,
      `save answers → ${save.status}; rows=${Array.isArray(save.json) ? save.json.length : 'n/a'}`);

    const loaded = await member.get(`/api/design-visits/${visitId}/answers`);
    const byQ = {};
    if (Array.isArray(loaded.json)) for (const row of loaded.json) byQ[row.question_id] = row.answer;
    const loadOk = loaded.status === 200 && byQ[visitQId] === true && byQ[roomQId] === 'Tile';
    record('ANSWER-LOAD.roundtrip', loadOk,
      `load answers → ${loaded.status}; visit=${JSON.stringify(byQ[visitQId])} room=${JSON.stringify(byQ[roomQId])}`);

    // ── (ANSWER-REPLACE) re-save replaces the prior set ──────────────────────
    const resave = await member.post(`/api/design-visits/${visitId}/answers`, {
      answers: [{ question_id: visitQId, answer: false }],
    });
    const replaceOk = resave.status === 200 && Array.isArray(resave.json)
      && resave.json.length === 1 && resave.json[0].answer === false;
    record('ANSWER-REPLACE.delete-then-insert', replaceOk,
      `re-save → ${resave.status}; rows=${Array.isArray(resave.json) ? resave.json.length : 'n/a'} (expected 1)`);

    // ── (DELETE) admin removes a question ────────────────────────────────────
    const del = await admin.delete(`/api/admin/visit-questions/${roomQId}`);
    const after = await admin.get('/api/admin/visit-questions');
    const stillThere = Array.isArray(after.json) && after.json.some(q => q.id === roomQId);
    record('DELETE.removes-question', del.status === 200 && !stillThere,
      `delete → ${del.status}; question still listed: ${stillThere}`);

    await cleanupQuestions(pool);

    const passed = findings.filter(f => f.ok).length;
    const failed = findings.filter(f => !f.ok).length;
    exitCode = failed === 0 ? 0 : 1;

    try {
      fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
      const lines = [
        '# questionnaire',
        '',
        `Result: **${failed === 0 ? 'PASS' : 'FAIL'}** — ${passed} passed, ${failed} failed.`,
        '',
        '| Probe | Result | Detail |',
        '| --- | --- | --- |',
        ...findings.map(f => `| ${f.id} | ${f.ok ? 'PASS' : 'FAIL'} | ${String(f.detail).replace(/\\/g, '\\\\').replace(/\|/g, '\\|')} |`),
        '',
      ];
      fs.writeFileSync(REPORT_PATH, lines.join('\n'));
      console.log(`\n  report: ${REPORT_PATH}`);
    } catch {}

    console.log(`\n  ${failed === 0 ? '✔ PASS' : '✘ FAIL'} — ${passed} passed, ${failed} failed\n`);
  } catch (e) {
    console.error('  questionnaire crashed:', e.message);
    exitCode = 1;
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    await pool.end().catch(() => {});
    process.exit(exitCode);
  }
}

main();
