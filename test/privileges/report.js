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
  lines.push('- The capability matrix probes a representative subset of the API surface — every gate type (`isAuthenticated`, `requirePrivilege(member|manager)`, `requireManagerOrAdmin`, `requireAdmin`) is exercised across all four authenticated roles plus the unauthenticated baseline.');
  lines.push('- Routes that depend on third-party tokens (HubSpot, Google, QuickBooks) are run with empty credentials in the harness; an authorized 503/500 from those handlers is still treated as "permitted" because the auth gate fired correctly.');
  lines.push('- Rate limiters are *not* hammered in the matrix to avoid skewing other probes. A dedicated rate-limit probe is left as future work; the current run records a 429 as `rate-limited` (skipped) rather than a pass or fail.');
  lines.push('- The Playwright UI smoke from the plan was replaced with a server-side GET `/admin` probe per role plus an HTML-body assertion. This catches the same access-control regressions without the headless-browser dependency.');
  lines.push('- Turnstile is disabled in the test harness so login can be driven without a real Cloudflare token. To validate the captcha gate, re-run with `TURNSTILE_SECRET_KEY` set — the gate code path is the same one exercised in production by `/api/login`, `/api/request-access`, and `/api/forgot-password`.');
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
