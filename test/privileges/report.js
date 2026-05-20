const fs = require('fs');
const path = require('path');

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];
const RANK_FOR_REPORT = { unauth: -1, viewer: 0, member: 1, manager: 2, admin: 3 };

function badge(ok) { return ok ? 'PASS' : 'FAIL'; }

function escapePipe(s) { return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' '); }

function buildReport({ runId, startedAt, finishedAt, matrix, probes, harnessLog }) {
  const lines = [];
  lines.push(`# Privilege Adversarial Test Suite — Report`);
  lines.push('');
  lines.push(`- Run ID: \`${runId}\``);
  lines.push(`- Started: ${startedAt}`);
  lines.push(`- Finished: ${finishedAt}`);
  lines.push(`- Harness: \`npm run test:privileges\` (boots a dedicated server on a separate port, seeds four users, runs probes, exits non-zero on findings).`);
  lines.push('');

  const totalProbes = probes.length;
  const failedProbes = probes.filter(p => !p.ok);
  const matrixFails = matrix.filter(m => !m.ok);
  const matrixInconclusive = matrix.filter(m => m.inconclusive);
  const allFails = [...matrixFails.map(m => ({ ...m, source: 'matrix' })),
                    ...failedProbes.map(p => ({ ...p, source: 'probe' }))];

  lines.push(`## Summary`);
  lines.push('');
  lines.push(`- Capability matrix: ${matrix.length - matrixFails.length}/${matrix.length} passed (${matrixInconclusive.length} inconclusive — guard fired before authz, see below)`);
  lines.push(`- Adversarial probes: ${totalProbes - failedProbes.length}/${totalProbes} passed`);
  lines.push(`- **Findings**: ${allFails.length}`);
  for (const sev of SEVERITY_ORDER) {
    const n = allFails.filter(f => (f.severity || 'info') === sev).length;
    if (n > 0) lines.push(`  - ${sev}: ${n}`);
  }
  lines.push('');

  if (allFails.length) {
    lines.push(`## Findings`);
    lines.push('');
    lines.push('| Severity | Source | Name | Expected | Observed | Detail |');
    lines.push('|---|---|---|---|---|---|');
    const sortedFails = allFails.slice().sort((a, b) =>
      SEVERITY_ORDER.indexOf(a.severity || 'info') - SEVERITY_ORDER.indexOf(b.severity || 'info'));
    for (const f of sortedFails) {
      const name = f.source === 'matrix'
        ? `${f.method} ${f.path} (as ${f.actorLevel}, requires ${f.requiredLevel})`
        : `${f.category} · ${f.name}`;
      const expected = f.source === 'matrix'
        ? (f.actorLevel === 'unauth' ? '401/403 from auth gate'
            : (RANK_FOR_REPORT[f.actorLevel] >= RANK_FOR_REPORT[f.requiredLevel === 'auth' ? 'viewer' : f.requiredLevel]
                ? 'any non-403 (auth gate passes)'
                : '401/403 from privilege gate'))
        : (f.expected || '');
      const observed = f.source === 'matrix'
        ? `status=${f.status} (${f.kind})`
        : (f.observed || '');
      lines.push(`| ${f.severity || 'info'} | ${f.source} | ${escapePipe(name)} | ${escapePipe(expected)} | ${escapePipe(observed)} | ${escapePipe(f.detail || '')} |`);
    }
    lines.push('');
  }

  if (matrixInconclusive.length) {
    lines.push(`## Inconclusive matrix cells`);
    lines.push('');
    lines.push('These cells got a `503` from a pre-authz guard (e.g. `requireHubspotToken` mounted via `app.use` runs before `requirePrivilege`). The harness cannot tell from the wire whether the privilege gate would have denied the request — re-run with the relevant third-party credentials populated to verify.');
    lines.push('');
    lines.push('| Route | Requires | Actor | Status | Kind |');
    lines.push('|---|---|---|---|---|');
    for (const m of matrixInconclusive) {
      lines.push(`| ${m.method} ${escapePipe(m.path)} | ${m.requiredLevel} | ${m.actorLevel} | ${m.status} | ${m.kind} |`);
    }
    lines.push('');
  }

  lines.push(`## Capability matrix`);
  lines.push('');
  lines.push(`Each cell shows the HTTP status observed for the given (role × route).`);
  lines.push(`A FAIL means a role gained access it should not have (privilege escalation) or was denied access it should have (legitimate-access regression).`);
  lines.push('');
  const roles = ['unauth', 'viewer', 'member', 'manager', 'admin'];
  lines.push(`| Route | Requires | ${roles.join(' | ')} |`);
  lines.push(`|---|---|${roles.map(() => '---').join('|')}|`);
  const byRoute = new Map();
  for (const r of matrix) {
    const k = `${r.method} ${r.path}`;
    if (!byRoute.has(k)) byRoute.set(k, { requiredLevel: r.requiredLevel, cells: {} });
    byRoute.get(k).cells[r.actorLevel] = r;
  }
  for (const [route, info] of byRoute) {
    const cells = roles.map(role => {
      const c = info.cells[role];
      if (!c) return '—';
      return `${c.status}${c.ok ? '' : ' ⚠'}`;
    });
    lines.push(`| ${escapePipe(route)} | ${info.requiredLevel} | ${cells.join(' | ')} |`);
  }
  lines.push('');

  lines.push(`## Adversarial probes (full log)`);
  lines.push('');
  const byCat = new Map();
  for (const p of probes) {
    if (!byCat.has(p.category)) byCat.set(p.category, []);
    byCat.get(p.category).push(p);
  }
  for (const [cat, list] of byCat) {
    lines.push(`### ${cat}`);
    lines.push('');
    lines.push('| Result | Severity | Probe | Expected | Observed | Notes |');
    lines.push('|---|---|---|---|---|---|');
    for (const p of list) {
      lines.push(`| ${badge(p.ok)} | ${p.severity} | ${escapePipe(p.name)} | ${escapePipe(p.expected)} | ${escapePipe(p.observed)} | ${escapePipe(p.detail)} |`);
    }
    lines.push('');
  }

  lines.push(`## Coverage notes`);
  lines.push('');
  lines.push('- The capability matrix walks the full route inventory of `auth.js`, `server.js`, `quickbooks.js`, and `visits.js` (every gate type — `isAuthenticated`, `requirePrivilege(member|manager)`, `requireManagerOrAdmin`, `requireAdmin`, `self-or-admin` — × five actors). `self-or-admin` cells target a *foreign* user id so the IDOR path is what gets exercised; happy-path self-access is covered separately in the probe log.');
  lines.push('- Routes that depend on third-party tokens (HubSpot, Google, QuickBooks) are run with empty credentials by default; an authorized 401/503 from those handlers is bucketed as `handler-401-unverified` / `hubspot-guard-503-inconclusive` instead of a finding. Re-run with `PRIVTEST_USE_HUBSPOT_TOKEN=1 HUBSPOT_TOKEN=… npm run test:privileges` (and the analogous Google/QB pairs) to resolve those cells deterministically.');
  lines.push('- Dedicated probe categories cover the adversarial checklist: `rate-limit` hammers `loginLimiter` (20/15min) and `accessRequestLimiter` (5/hr, shared with `/api/forgot-password`); `csrf` confirms the OAuth callbacks reject missing/forged state and that mutation routes are not reachable as GETs; `oauth` exercises stale-state and cross-user state-replay against both Google and QuickBooks callbacks; `downgrade` demotes a manager mid-session and verifies the next request reflects the new privilege level (the #290 regression class).');
  lines.push('- A headless Puppeteer UI smoke runs `/login` → `/` → `/admin` per role: unauth bounces to `/login`, viewer/member/manager see the access-denied banner, admin loads the admin UI, and per-role browser console errors are captured. Screenshots are written to `test-results/screenshots/<runId>-<role>-{login,home,admin}.png` (plus an `unauth-admin` capture).');
  lines.push('- Captcha enforcement: the harness strips `TURNSTILE_SECRET_KEY` by default. Set `PRIVTEST_USE_TURNSTILE_SECRET_KEY=1 TURNSTILE_SECRET_KEY=… npm run test:privileges` to pass the real key through to the spawned server — the `captcha` probe then exercises the tampering path (no-token / forged-token / empty-token logins).');
  lines.push('- Test DB isolation: `DATABASE_URL_TEST=…` is the default contract — the harness refuses to run against the shared DATABASE_URL unless `PRIVTEST_ALLOW_SHARED_DB=1` is also set (opt-in). In shared-DB mode every synthetic row is namespaced with the `privtest-` email prefix (`users`, `allowed_emails`, `password_set_tokens`, `account_requests`, `sessions` rows whose payload references `@privtest.local`); `cleanupTestData` runs on boot, on signal exit, and on uncaught exception.');
  lines.push('');

  if (harnessLog && harnessLog.length) {
    lines.push(`## Harness server log (tail)`);
    lines.push('');
    lines.push('```');
    lines.push(harnessLog.slice(-80).join(''));
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

function writeReport(content) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'privileges.md');
  fs.writeFileSync(out, content);
  return out;
}

module.exports = { buildReport, writeReport };
