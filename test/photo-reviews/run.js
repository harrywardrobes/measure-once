'use strict';
// test/photo-reviews/run.js
//
// Integration tests for the review-customer-photos card-action-handler routes
// in photo-reviews.js.
//
// Probes:
//   (GET.null)               GET returns { submission: null } when no submitted
//                            and unreviewed submission exists for the contact.
//   (GET.unsubmitted-null)   GET ignores a submission that has not been submitted yet.
//   (GET.detail)             GET returns full submission fields + signed photoUrls
//                            when a submitted-unreviewed submission exists.
//   (POST.not_suitable.*)    POST outcome=not_suitable: email sent via file override,
//                            HubSpot PATCH carries hs_lead_status=NOT_SUITABLE,
//                            photo_review_outcomes row written to DB.
//   (POST.409)               POST returns 409 when the submission has already been reviewed.
//   (POST.rough_estimate.priceRange_required)
//                            POST returns 400 when outcome=rough_estimate_sent
//                            and priceRange is absent.
//   (POST.rough_estimate.*)  POST outcome=rough_estimate_sent happy path: HubSpot
//                            status=ROUGH_ESTIMATE, photo_review_outcomes row has
//                            price_range.
//   (POST.404)               POST returns 404 for a submissionId that belongs to a
//                            different contactId (numeric mismatch only).
//   (POST.404.cross-contact) POST returns 404 when submissionId belongs to a real
//                            second contact seeded separately — confirms ownership
//                            check is truly row-level, not just a numeric mismatch.
//   (AUTH.GET)               Unauthenticated GET → 401 or redirect.
//   (AUTH.POST)              Unauthenticated POST → 401 or redirect.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:photo-reviews
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:photo-reviews

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

require('dotenv').config();

const REPORT_PATH = path.join(__dirname, '..', '..', 'test-results', 'photo-reviews.md');
const CONTACT_ID   = '99887766'; // numeric-string, won't collide with real HubSpot data
const CONTACT_ID_2 = '99887755'; // second contact for cross-contact ownership probes
const findings    = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}

function readMailJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n').filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

// ── Minimal mock HubSpot server ───────────────────────────────────────────────
// Accepts PATCH /crm/v3/objects/contacts/:id and records the calls.
function startMockHubspot() {
  const patches = []; // { contactId, properties }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const url    = req.url.split('?')[0];
      const method = req.method.toUpperCase();

      const m = url.match(/^\/crm\/v3\/objects\/contacts\/([^/]+)$/);
      if (m && method === 'PATCH') {
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch {}
        patches.push({ contactId: m[1], properties: body.properties || {} });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: m[1], properties: body.properties || {} }));
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found', path: url }));
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, patches });
    });
  });
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function waitForTable(pool, table, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = $1 LIMIT 1`,
      [table]
    );
    if (r.rowCount) return;
    await new Promise(res => setTimeout(res, 200));
  }
  throw new Error(`Table ${table} did not appear within ${timeoutMs}ms`);
}

async function seedSubmission(pool, { contactId, contactEmail, submitted, photoKeys = [] }) {
  const tokenHash = `privtest-pr-${contactId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const r = await pool.query(
    `INSERT INTO customer_info_submissions
       (contact_id, contact_name, contact_email, token_hash, expires_at,
        submitted_at, photo_keys)
     VALUES ($1, 'Test Customer', $2, $3,
             NOW() + INTERVAL '7 days',
             $4, $5::jsonb)
     RETURNING id`,
    [
      contactId,
      contactEmail,
      tokenHash,
      submitted ? new Date().toISOString() : null,
      JSON.stringify(photoKeys),
    ]
  );
  return r.rows[0].id;
}

async function cleanup(pool) {
  // Delete in FK order: outcomes → submissions → lead_status_config sentinel
  for (const cid of [CONTACT_ID, CONTACT_ID_2]) {
    await pool.query(
      `DELETE FROM photo_review_outcomes WHERE contact_id = $1`,
      [cid]
    );
    await pool.query(
      `DELETE FROM customer_info_submissions WHERE contact_id = $1`,
      [cid]
    );
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

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
  console.log(`\n  photo-reviews  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool     = new Pool({ connectionString: connStr });
  const hs       = await startMockHubspot();
  const mailFile = path.join(os.tmpdir(), `photo-reviews-${runId}.jsonl`);
  try { fs.unlinkSync(mailFile); } catch {}

  console.log(`  mock HubSpot on http://127.0.0.1:${hs.port}`);
  console.log(`  mail file: ${mailFile}`);

  const harness = require('../privileges/harness');
  harness.setPool(pool);

  const {
    spawnServer, waitForServer,
    seedUsers, cleanupTestData, resetRateLimitStore,
    login, BASE,
  } = harness;

  await cleanupTestData(pool);
  await resetRateLimitStore(pool);

  const { child } = spawnServer({
    extraEnv: {
      HUBSPOT_API_BASE_OVERRIDE:    `http://127.0.0.1:${hs.port}`,
      MAIL_TRANSPORT_FILE_OVERRIDE: mailFile,
      HUBSPOT_ACCESS_TOKEN:         'privtest-fake-hs-token',
    },
  });

  let exitCode = 1;
  try {
    await waitForServer();
    console.log('  test server up');

    // Wait for server-side async table creation
    await waitForTable(pool, 'customer_info_submissions');
    await waitForTable(pool, 'photo_review_outcomes');

    await cleanup(pool);

    const users         = await seedUsers(pool, runId);
    const member        = users.member;
    const client        = await login(member.email, member.password);
    const contactEmail  = `privtest-pr-customer-${runId}@example.com`;

    // ── GET: no submissions at all → { submission: null } ───────────────────
    {
      const r = await client.get(`/api/card-actions/review-customer-photos/${CONTACT_ID}`);
      const ok = r.status === 200 && r.json?.submission === null;
      record('GET.null', ok,
        ok
          ? 'returns { submission: null } when contact has no submissions'
          : `status=${r.status} body=${r.text.slice(0, 200)}`);
    }

    // ── GET: only unsubmitted submission → still null ────────────────────────
    {
      const unsub = await seedSubmission(pool, {
        contactId: CONTACT_ID, contactEmail,
        submitted: false, photoKeys: ['key-unsub'],
      });
      const r = await client.get(`/api/card-actions/review-customer-photos/${CONTACT_ID}`);
      const ok = r.status === 200 && r.json?.submission === null;
      record('GET.unsubmitted-null', ok,
        ok
          ? 'unsubmitted submission is correctly excluded'
          : `status=${r.status} body=${r.text.slice(0, 200)}`);
      await pool.query(`DELETE FROM customer_info_submissions WHERE id = $1`, [unsub]);
    }

    // ── Seed the primary submitted submission ────────────────────────────────
    const PHOTO_KEYS = ['photo-key-alpha', 'photo-key-beta'];
    const subId = await seedSubmission(pool, {
      contactId: CONTACT_ID, contactEmail,
      submitted: true, photoKeys: PHOTO_KEYS,
    });

    // ── GET: submitted + unreviewed → full detail + signed URLs ─────────────
    {
      const r = await client.get(`/api/card-actions/review-customer-photos/${CONTACT_ID}`);
      const s = r.json?.submission;
      const ok = r.status === 200
        && s !== null && s !== undefined
        && s.id === subId
        && s.contactId === CONTACT_ID
        && s.contactEmail === contactEmail
        && Array.isArray(s.photoUrls)
        && s.photoUrls.length === PHOTO_KEYS.length
        && s.photoUrls.every(u => typeof u === 'string' && u.length > 0);
      record('GET.detail', ok,
        ok
          ? `returns submission id=${subId}, ${s.photoUrls.length} signed URLs`
          : `status=${r.status} s=${JSON.stringify(s).slice(0, 300)}`);
    }

    // ── POST not_suitable ────────────────────────────────────────────────────
    hs.patches.length = 0;
    try { fs.writeFileSync(mailFile, ''); } catch {}

    const notSuitablePayload = {
      contactId:    CONTACT_ID,
      submissionId: subId,
      outcome:      'not_suitable',
      emailSubject: 'Regarding your enquiry',
      emailBody:    'Hi, unfortunately we cannot proceed with your project at this time.',
    };

    {
      const r = await client.post('/api/card-actions/review-customer-photos', notSuitablePayload);
      const ok = r.status === 200 && r.json?.ok === true;
      record('POST.not_suitable.status', ok,
        ok ? 'POST not_suitable → 200 { ok: true }'
           : `status=${r.status} body=${r.text.slice(0, 200)}`);

      // Email delivered to customer address
      const mails = readMailJsonl(mailFile);
      const mailOk = mails.some(m =>
        typeof m.to === 'string' && m.to.includes(contactEmail)
      );
      record('POST.not_suitable.email', mailOk,
        mailOk
          ? `email dispatched to ${contactEmail}`
          : `no email to ${contactEmail}; ${mails.length} mail(s): ${mails.map(m => m.to).join(', ')}`);

      // HubSpot PATCH with NOT_SUITABLE
      const lsPatch = hs.patches.find(p => p.properties.hs_lead_status === 'NOT_SUITABLE');
      record('POST.not_suitable.hubspot', !!lsPatch,
        lsPatch
          ? 'HubSpot PATCH sent hs_lead_status=NOT_SUITABLE'
          : `no NOT_SUITABLE patch; all patches: ${JSON.stringify(hs.patches).slice(0, 300)}`);

      // photo_review_outcomes DB row
      const dbRes = await pool.query(
        `SELECT outcome, contact_id, price_range
           FROM photo_review_outcomes WHERE submission_id = $1`,
        [subId]
      );
      const dbOk = dbRes.rows.length === 1
        && dbRes.rows[0].outcome === 'not_suitable'
        && dbRes.rows[0].contact_id === CONTACT_ID
        && dbRes.rows[0].price_range === null;
      record('POST.not_suitable.db', dbOk,
        dbOk
          ? 'photo_review_outcomes row recorded correctly (outcome=not_suitable, price_range=null)'
          : `rows=${JSON.stringify(dbRes.rows).slice(0, 200)}`);
    }

    // ── POST 409 — already reviewed ──────────────────────────────────────────
    {
      const r = await client.post('/api/card-actions/review-customer-photos', notSuitablePayload);
      const ok = r.status === 409;
      record('POST.409', ok,
        ok
          ? '409 returned when submission was already reviewed'
          : `status=${r.status} body=${r.text.slice(0, 200)}`);
    }

    // ── Seed a fresh submission for rough_estimate_sent probes ───────────────
    const subId2 = await seedSubmission(pool, {
      contactId: CONTACT_ID, contactEmail,
      submitted: true, photoKeys: [],
    });

    // ── POST rough_estimate_sent — priceRange required ───────────────────────
    {
      const r = await client.post('/api/card-actions/review-customer-photos', {
        contactId:    CONTACT_ID,
        submissionId: subId2,
        outcome:      'rough_estimate_sent',
        // priceRange intentionally omitted
        emailSubject: 'Your rough estimate',
        emailBody:    'Hi, here is your estimate.',
      });
      const ok = r.status === 400;
      record('POST.rough_estimate.priceRange_required', ok,
        ok
          ? '400 when priceRange absent for rough_estimate_sent'
          : `status=${r.status} body=${r.text.slice(0, 200)}`);
    }

    // ── POST rough_estimate_sent — happy path ────────────────────────────────
    hs.patches.length = 0;
    {
      const r = await client.post('/api/card-actions/review-customer-photos', {
        contactId:    CONTACT_ID,
        submissionId: subId2,
        outcome:      'rough_estimate_sent',
        priceRange:   '£5,000 – £8,000',
        emailSubject: 'Your rough estimate from Harry Wardrobes',
        emailBody:    'Hi, your rough estimate is £5,000–£8,000.',
      });
      const ok = r.status === 200 && r.json?.ok === true;
      record('POST.rough_estimate.status', ok,
        ok ? 'POST rough_estimate_sent → 200 { ok: true }'
           : `status=${r.status} body=${r.text.slice(0, 200)}`);

      // HubSpot PATCH with ROUGH_ESTIMATE
      const lsPatch = hs.patches.find(p => p.properties.hs_lead_status === 'ROUGH_ESTIMATE');
      record('POST.rough_estimate.hubspot', !!lsPatch,
        lsPatch
          ? 'HubSpot PATCH sent hs_lead_status=ROUGH_ESTIMATE'
          : `no ROUGH_ESTIMATE patch; all patches: ${JSON.stringify(hs.patches).slice(0, 300)}`);

      // DB row records price_range
      const dbRes = await pool.query(
        `SELECT outcome, price_range FROM photo_review_outcomes WHERE submission_id = $1`,
        [subId2]
      );
      const dbOk = dbRes.rows.length === 1
        && dbRes.rows[0].outcome === 'rough_estimate_sent'
        && dbRes.rows[0].price_range === '£5,000 – £8,000';
      record('POST.rough_estimate.db', dbOk,
        dbOk
          ? 'photo_review_outcomes row recorded (outcome=rough_estimate_sent, price_range correct)'
          : `rows=${JSON.stringify(dbRes.rows).slice(0, 200)}`);
    }

    // ── POST 404 — submissionId belongs to a different contactId ─────────────
    {
      // subId belongs to CONTACT_ID; pass a different contactId to force 404
      const r = await client.post('/api/card-actions/review-customer-photos', {
        contactId:    '11111111',
        submissionId: subId,
        outcome:      'not_suitable',
        emailSubject: 'Regarding your enquiry',
        emailBody:    'Sorry, this is not right for us.',
      });
      const ok = r.status === 404;
      record('POST.404', ok,
        ok
          ? '404 for submissionId belonging to a different contactId'
          : `status=${r.status} body=${r.text.slice(0, 200)}`);
    }

    // ── POST 404 — cross-contact: real second contact owns the submission ─────
    // Seeds a submitted submission for CONTACT_ID_2, then tries to review it
    // under CONTACT_ID — confirms the ownership check is truly row-level and
    // not merely a guard against an obviously non-existent numeric ID.
    {
      const contactEmail2 = `privtest-pr-customer2-${runId}@example.com`;
      const subIdOtherContact = await seedSubmission(pool, {
        contactId: CONTACT_ID_2, contactEmail: contactEmail2,
        submitted: true, photoKeys: ['photo-key-other'],
      });
      const r = await client.post('/api/card-actions/review-customer-photos', {
        contactId:    CONTACT_ID,       // belongs to first contact
        submissionId: subIdOtherContact, // but submission belongs to second contact
        outcome:      'not_suitable',
        emailSubject: 'Regarding your enquiry',
        emailBody:    'Sorry, this is not right for us.',
      });
      const ok = r.status === 404;
      record('POST.404.cross-contact', ok,
        ok
          ? `404 when submissionId=${subIdOtherContact} (contact=${CONTACT_ID_2}) reviewed under contactId=${CONTACT_ID}`
          : `status=${r.status} body=${r.text.slice(0, 200)}`);
    }

    // ── Auth gating — unauthenticated requests ───────────────────────────────
    {
      const rGet = await fetch(
        `${BASE}/api/card-actions/review-customer-photos/${CONTACT_ID}`,
        { headers: { Accept: 'application/json' }, redirect: 'manual' }
      );
      const getOk = rGet.status === 401 || rGet.status === 302;
      record('AUTH.GET', getOk,
        getOk
          ? `unauthenticated GET → ${rGet.status} (auth gated)`
          : `expected 401 or 302, got ${rGet.status}`);

      const rPost = await fetch(
        `${BASE}/api/card-actions/review-customer-photos`,
        {
          method:  'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          redirect: 'manual',
          body: JSON.stringify({
            contactId: CONTACT_ID, submissionId: subId,
            outcome: 'not_suitable', emailSubject: 's', emailBody: 'b',
          }),
        }
      );
      const postOk = rPost.status === 401 || rPost.status === 302;
      record('AUTH.POST', postOk,
        postOk
          ? `unauthenticated POST → ${rPost.status} (auth gated)`
          : `expected 401 or 302, got ${rPost.status}`);
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
    try { hs.server.close(); } catch {}
    try { fs.unlinkSync(mailFile); } catch {}
    await pool.end().catch(() => {});

    const lines = [
      '# photo-reviews findings',
      '',
      `Run: ${new Date().toISOString()}`,
      `Result: ${findings.every(f => f.ok) ? 'PASS' : 'FAIL'} (${findings.filter(f => f.ok).length}/${findings.length})`,
      '',
      '| ID | Result | Detail |',
      '|----|--------|--------|',
      ...findings.map(f =>
        `| ${f.id} | ${f.ok ? 'PASS' : 'FAIL'} | ${String(f.detail).replace(/\\/g, '\\\\').replace(/\|/g, '\\|')} |`
      ),
    ];
    try {
      fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
      fs.writeFileSync(REPORT_PATH, lines.join('\n') + '\n');
      console.log(`  report -> ${REPORT_PATH}`);
    } catch (e2) {
      console.warn('  report write failed:', e2.message);
    }
  }

  process.exit(exitCode);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
