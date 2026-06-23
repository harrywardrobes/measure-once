'use strict';

// test/contact-customer-email-preview/run.js
//
// Integration tests for the contact_customer email-preview route.
// Spins up a mock HubSpot server, seeds the email_templates table with a
// contact_customer_followup template that has a non-empty footer_text, then
// asserts that the rendered html always contains the footer — including after
// the regression where providing a custom body override stripped it.
//
// Probes:
//   (A) POST with no body override returns html containing the template footer
//       (baseline — confirms the default rendering path is healthy).
//   (B) POST with { body, subject } override returns html containing the
//       template footer (regression: prior to fix, customBodyHtml being set
//       caused the renderEmail html path to build correctly but the
//       !body_html fallback would overwrite html without the footer).
//   (C) POST with subject-only override (no body) returns html containing
//       the template footer.
//   (D) POST with an invalid contactId returns 400.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:contact-customer-email-preview
//   PRIVTEST_ALLOW_SHARED_DB=1      npm run test:contact-customer-email-preview

const http = require('http');
const path = require('path');
const fs   = require('fs');
const { Pool } = require('pg');

require('dotenv').config();

const {
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
  __dirname, '..', '..', 'test-results', 'contact-customer-email-preview.md'
);

const CONTACT_ID    = '9988201';
const CONTACT_FIRST = 'PreviewTest';

// Footer text we seed into the DB — distinct enough to assert on.
const TEST_FOOTER = 'Warm regards,\nThe Preview Test Team';
// The footer rendered as HTML by footerTextToHtml:
//   <p>Warm regards,<br>The Preview Test Team</p>
const FOOTER_SNIPPET = 'The Preview Test Team';

const findings = [];
function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${id} — ${detail}`);
}

// ── Mock HubSpot HTTP server ───────────────────────────────────────────────
function startMockHubSpot() {
  const server = http.createServer((req, res) => {
    if (req.url.includes(`/crm/v3/objects/contacts/${CONTACT_ID}`)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: CONTACT_ID,
        properties: { firstname: CONTACT_FIRST },
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Not found' }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Upsert the template with a non-empty footer so we can assert on it.
async function seedTemplate(pool) {
  await pool.query(
    `INSERT INTO email_templates (key, subject, body_text, body_html, footer_text)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (key) DO UPDATE
       SET subject    = EXCLUDED.subject,
           body_text  = EXCLUDED.body_text,
           body_html  = EXCLUDED.body_html,
           footer_text = EXCLUDED.footer_text`,
    [
      'contact_customer_followup',
      'Fitted Wardrobes',
      'Hi {{firstName}},\n\nJust following up on your enquiry.',
      '',
      TEST_FOOTER,
    ]
  );
}

async function restoreTemplate(pool) {
  await pool.query(
    `UPDATE email_templates SET footer_text = '' WHERE key = 'contact_customer_followup'`
  );
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
  console.log(`\n  contact-customer-email-preview  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);
  await seedTemplate(pool);

  const hsServer = await startMockHubSpot();
  const hsPort   = hsServer.address().port;
  const hsUrl    = `http://127.0.0.1:${hsPort}`;

  const users = await seedUsers(pool, runId);

  // ── Probes (A)+(B)+(C)+(D): single server instance ────────────────────────
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

    // ── Probe (A): no override → footer in html ──────────────────────────
    try {
      const res = await member.post(
        `/api/card-actions/contact-customer/${encodeURIComponent(CONTACT_ID)}/email-preview`,
        {},
      );
      const html = res.json?.html || '';
      const hasFooter = html.includes(FOOTER_SNIPPET);
      record(
        '(A) email-preview: no override — html contains template footer',
        res.status === 200 && hasFooter,
        `status=${res.status} footer_found=${hasFooter}`,
      );
    } catch (e) {
      record('(A) email-preview: no override — html contains template footer', false, e.message);
    }

    // ── Probe (B): body + subject override → footer still in html ────────
    try {
      const res = await member.post(
        `/api/card-actions/contact-customer/${encodeURIComponent(CONTACT_ID)}/email-preview`,
        {
          body:    'Hi there,\n\nCustom body text written by staff.',
          subject: 'Custom subject line',
        },
      );
      const html = res.json?.html || '';
      const hasFooter = html.includes(FOOTER_SNIPPET);
      record(
        '(B) email-preview: body+subject override — html still contains template footer',
        res.status === 200 && hasFooter,
        `status=${res.status} footer_found=${hasFooter}`,
      );
    } catch (e) {
      record('(B) email-preview: body+subject override — html still contains template footer', false, e.message);
    }

    // ── Probe (C): subject-only override → footer still in html ──────────
    try {
      const res = await member.post(
        `/api/card-actions/contact-customer/${encodeURIComponent(CONTACT_ID)}/email-preview`,
        { subject: 'Just a subject change' },
      );
      const html = res.json?.html || '';
      const hasFooter = html.includes(FOOTER_SNIPPET);
      record(
        '(C) email-preview: subject-only override — html still contains template footer',
        res.status === 200 && hasFooter,
        `status=${res.status} footer_found=${hasFooter}`,
      );
    } catch (e) {
      record('(C) email-preview: subject-only override — html still contains template footer', false, e.message);
    }

    // ── Probe (D): invalid contactId → 400 ───────────────────────────────
    try {
      const res = await member.post(
        `/api/card-actions/contact-customer/not-a-number/email-preview`,
        {},
      );
      record(
        '(D) email-preview: invalid contactId returns 400',
        res.status === 400,
        `status=${res.status}`,
      );
    } catch (e) {
      record('(D) email-preview: invalid contactId returns 400', false, e.message);
    }

  } catch (e) {
    record('(A) email-preview: no override — html contains template footer', false, e.message);
    record('(B) email-preview: body+subject override — html still contains template footer', false, e.message);
    record('(C) email-preview: subject-only override — html still contains template footer', false, e.message);
    record('(D) email-preview: invalid contactId returns 400', false, e.message);
  }

  try { if (!exited) child.kill('SIGTERM'); } catch {}
  await new Promise(r => setTimeout(r, 400));

  // ── Teardown ─────────────────────────────────────────────────────────────
  hsServer.close();
  if (!hasTestDb) await restoreTemplate(pool);
  await cleanupTestData(pool);
  await pool.end().catch(() => {});

  // ── Write report ──────────────────────────────────────────────────────────
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok).length;
  const lines  = [
    '# contact-customer-email-preview test',
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
