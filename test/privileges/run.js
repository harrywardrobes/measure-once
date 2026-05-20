const { Pool } = require('pg');
const {
  cleanupTestData, resetRateLimitStore, seedUsers, spawnServer, waitForServer,
  makeClient, login, ROLES,
} = require('./harness');
const { ROUTES, classifyOutcome } = require('./matrix');
const { runProbes } = require('./probes');
const { runUiSmoke } = require('./uiSmoke');
const { buildReport, writeReport } = require('./report');

require('dotenv').config();

async function main() {
  const hasTestDb = !!process.env.DATABASE_URL_TEST;
  const allowShared = process.env.PRIVTEST_ALLOW_SHARED_DB === '1';
  const connStr = process.env.DATABASE_URL_TEST || process.env.DATABASE_URL;
  if (!connStr) {
    console.error('DATABASE_URL_TEST (preferred) or DATABASE_URL is required to run the privilege test suite.');
    process.exit(2);
  }
  if (!hasTestDb && !allowShared) {
    console.error(`\n  ✘ Privilege suite refuses to run against the shared DATABASE_URL by default.\n`
      + `    Set DATABASE_URL_TEST=<disposable connection string> to point at an isolated DB,\n`
      + `    or set PRIVTEST_ALLOW_SHARED_DB=1 to opt in to shared-DB mode (synthetic rows are\n`
      + `    prefixed with 'privtest-' and cleaned up on exit, but a crash mid-run can leave\n`
      + `    stale fixtures in the shared DB).`);
    process.exit(2);
  }
  const runId = Math.random().toString(36).slice(2, 8);
  const startedAt = new Date().toISOString();
  const pool = new Pool({ connectionString: connStr });
  if (hasTestDb) {
    console.log(`  Using DATABASE_URL_TEST (isolated test DB).`);
  } else {
    console.log(`  Using shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1 opt-in) with prefix cleanup (privtest-*).`);
  }

  console.log(`\n  Privilege test run ${runId}`);
  console.log(`  Booting test server on a separate port…\n`);

  await cleanupTestData(pool);
  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users:`);
  for (const r of ROLES) console.log(`    ${r.padEnd(8)} ${users[r].email}`);

  const { child, logBuf } = spawnServer();
  let exited = false;
  child.on('exit', () => { exited = true; });

  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    process.exit(code);
  };

  // Robust interrupt handling: any abnormal exit still purges the synthetic
  // privtest-* rows from the shared DB and kills the spawned server.
  const onSignal = (sig) => () => {
    console.error(`\n  Caught ${sig} — cleaning up.`);
    cleanupAndExit(130);
  };
  process.on('SIGINT', onSignal('SIGINT'));
  process.on('SIGTERM', onSignal('SIGTERM'));
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    cleanupAndExit(2);
  });
  process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
    cleanupAndExit(2);
  });

  try {
    await waitForServer();
    await resetRateLimitStore(pool);
    console.log(`  Test server up.`);
  } catch (e) {
    console.error('Server boot failed:', e.message);
    console.error(logBuf.join('').slice(-2000));
    await cleanupAndExit(2);
  }

  let matrixResults = [];
  let probeResults = [];
  try {
    // ── Capability matrix ────────────────────────────────────────────────
    const clients = {};
    clients.unauth = makeClient(null);
    for (const r of ROLES) clients[r] = await login(users[r].email, users[r].password);
    console.log(`  Logged in as all four roles.`);

    console.log(`  Running capability matrix (${ROUTES.length} routes × 5 actors)…`);
    // For `self-or-admin` routes, target the *admin* user id so non-admins
    // are exercising the cross-user (IDOR) path. A separate probe block
    // covers the self-access happy path.
    const foreignId = users.admin.id;
    for (const route of ROUTES) {
      const path = route.path.replace('__FOREIGN__', String(foreignId));
      for (const actorLevel of ['unauth', ...ROLES]) {
        const c = clients[actorLevel];
        let res;
        try {
          res = await c.req(route.method, path, { body: route.body });
        } catch (e) {
          res = { status: 0, text: String(e.message) };
        }
        const actorIsTargetUser =
          actorLevel !== 'unauth' && users[actorLevel]?.id === foreignId;
        const outcome = classifyOutcome({
          requiredLevel: route.level,
          actorLevel,
          status: res.status,
          route,
          actorIsTargetUser,
        });
        matrixResults.push({
          method: route.method, path,
          requiredLevel: route.level, actorLevel,
          status: res.status,
          ok: outcome.ok, kind: outcome.kind,
          inconclusive: !!outcome.inconclusive,
        });
      }
    }
    const matrixFails = matrixResults.filter(m => !m.ok);
    const matrixInconclusive = matrixResults.filter(m => m.inconclusive).length;
    console.log(`    matrix: ${matrixResults.length - matrixFails.length}/${matrixResults.length} ok (${matrixInconclusive} inconclusive — see report)`);

    // The matrix included POST /api/logout as the final row per actor, which
    // destroyed every authenticated session. Re-login each role before the
    // adversarial probe block so probes start from a fresh authenticated
    // baseline.
    for (const r of ROLES) clients[r] = await login(users[r].email, users[r].password);

    // ── Adversarial probes ───────────────────────────────────────────────
    console.log(`  Running adversarial probes…`);
    probeResults = await runProbes({ clients, users, pool, runId });

    // ── UI smoke (Puppeteer) ─────────────────────────────────────────────
    // Loads /login → / → /admin per role in headless chromium, asserts the
    // access-denied page for non-admins, no console errors for admin, and
    // captures screenshots into test-results/screenshots/.
    console.log(`  Running headless UI smoke (puppeteer)…`);
    let uiResults = [];
    try {
      uiResults = await runUiSmoke({ users, runId, clients });
    } catch (e) {
      uiResults = [{
        category: 'ui-smoke', name: 'puppeteer smoke',
        expected: 'runs to completion',
        observed: `error: ${e.message}`,
        severity: 'high', ok: false, detail: '',
      }];
    }
    probeResults.push(...uiResults);
    const probeFails = probeResults.filter(p => !p.ok);
    console.log(`    probes: ${probeResults.length - probeFails.length}/${probeResults.length} ok`);

    const finishedAt = new Date().toISOString();
    const report = buildReport({
      runId, startedAt, finishedAt,
      matrix: matrixResults,
      probes: probeResults,
      harnessLog: logBuf,
    });
    const out = writeReport(report);
    console.log(`\n  Report written: ${out}`);

    const totalFails = matrixFails.length + probeFails.length;
    if (totalFails > 0) {
      console.log(`  ${totalFails} finding(s) — exiting non-zero.`);
      await cleanupAndExit(1);
    } else {
      console.log(`  No findings.`);
      await cleanupAndExit(0);
    }
  } catch (e) {
    console.error('Test run aborted:', e);
    try {
      const report = buildReport({
        runId, startedAt, finishedAt: new Date().toISOString(),
        matrix: matrixResults, probes: probeResults, harnessLog: logBuf,
      });
      writeReport(report + `\n\n## Aborted\n\n\`\`\`\n${e.stack || e.message}\n\`\`\`\n`);
    } catch {}
    await cleanupAndExit(2);
  }
}

main();
