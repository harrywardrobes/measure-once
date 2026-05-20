const RANK = { unauth: -1, viewer: 0, member: 1, manager: 2, admin: 3 };

// Full route inventory covering auth.js, server.js, quickbooks.js, visits.js.
// `level` is the *minimum* privilege the gate enforces:
//   'auth'    — global isAuthenticated gate only
//   'member'  — requirePrivilege('member')
//   'manager' — requirePrivilege('manager') or requireManagerOrAdmin
//   'admin'   — requireAdmin
// `body` populates a JSON request body for write methods (handlers usually 400
//   on an empty body which is fine — we only assert the gate decision).
// `needsHubspot` / `needsGoogle` / `needsQB` mark routes whose handler returns
//   401/503 when the third-party token is absent; the classifier downgrades
//   those statuses to "unverified" rather than treating them as findings.
// `selfId` injects the actor's own user id into a :id slot (set to a foreign
//   user id by default — picked at runtime — to also exercise the IDOR gate).
const ROUTES = [
  // ── Public auth surface (no gate) ─────────────────────────────────────────
  { method: 'GET',    path: '/api/turnstile-config',          level: 'public' },
  { method: 'GET',    path: '/api/check-email?email=foo%40bar.com', level: 'public' },
  { method: 'GET',    path: '/api/set-password/validate?token=zzz', level: 'public' },
  { method: 'GET',    path: '/auth/status',                   level: 'public' },

  // ── auth-level (`isAuthenticated` only) ───────────────────────────────────
  { method: 'GET',    path: '/api/auth/user',                 level: 'auth' },
  // POST /api/logout intentionally excluded — it destroys the session and
  // would 401 every subsequent matrix row. It is covered by the sign-in
  // probe (logout invalidates session) instead.
  { method: 'GET',    path: '/api/onboarding/me',             level: 'auth' },
  { method: 'POST',   path: '/api/onboarding/complete',       level: 'auth',    body: {} },
  { method: 'GET',    path: '/api/job-roles',                 level: 'auth' },
  { method: 'GET',    path: '/api/platform-users',            level: 'auth' },
  { method: 'GET',    path: '/api/users/me/prefs',            level: 'auth' },
  { method: 'PATCH',  path: '/api/users/me/prefs',            level: 'auth',    body: {} },
  { method: 'POST',   path: '/api/users/me/photo',            level: 'auth',    body: {} },
  { method: 'GET',    path: '/api/google/status',             level: 'auth' },
  { method: 'GET',    path: '/auth/google',                   level: 'auth' },
  { method: 'GET',    path: '/auth/google/callback?code=x&state=y', level: 'auth' },
  { method: 'POST',   path: '/auth/logout-google',            level: 'auth',    body: {} },
  { method: 'GET',    path: '/api/quickbooks/status',         level: 'auth' },
  { method: 'GET',    path: '/api/hubspot/status',            level: 'auth' },
  { method: 'GET',    path: '/api/account',                   level: 'auth',    needsHubspot: true },
  { method: 'GET',    path: '/api/pipeline',                  level: 'auth',    needsHubspot: true },
  { method: 'GET',    path: '/api/deals',                     level: 'auth',    needsHubspot: true },
  { method: 'GET',    path: '/api/deals/0',                   level: 'auth',    needsHubspot: true },
  { method: 'GET',    path: '/api/deals/0/notes',             level: 'auth',    needsHubspot: true },
  { method: 'GET',    path: '/api/contacts-all',              level: 'auth',    needsHubspot: true },
  { method: 'GET',    path: '/api/open-leads',                level: 'auth',    needsHubspot: true },
  { method: 'GET',    path: '/api/contacts/0',                level: 'auth',    needsHubspot: true },
  { method: 'GET',    path: '/api/contacts/0/localdata',      level: 'auth',    needsHubspot: true },
  { method: 'GET',    path: '/api/contacts/0/notes',          level: 'auth',    needsHubspot: true },
  { method: 'GET',    path: '/api/contacts/0/tasks',          level: 'auth',    needsHubspot: true },
  { method: 'GET',    path: '/api/emails',                    level: 'auth',    needsGoogle: true },
  { method: 'GET',    path: '/api/events',                    level: 'auth',    needsGoogle: true },
  { method: 'GET',    path: '/api/calendar/upcoming',         level: 'auth',    needsGoogle: true },
  { method: 'GET',    path: '/api/localdata/all',             level: 'auth',    needsHubspot: true },
  { method: 'GET',    path: '/api/workflow',                  level: 'auth' },
  { method: 'GET',    path: '/api/workflow-stages',           level: 'auth' },
  { method: 'GET',    path: '/api/personal-tasks',            level: 'auth' },
  { method: 'GET',    path: '/api/visits',                    level: 'auth' },

  // ── self-or-admin (foreign id picked at runtime) ──────────────────────────
  { method: 'GET',    path: '/api/users/__FOREIGN__/profile', level: 'self-or-admin' },
  { method: 'GET',    path: '/api/users/__FOREIGN__/photo',   level: 'self-or-admin' },
  { method: 'PATCH',  path: '/api/users/__FOREIGN__/profile', level: 'self-or-admin', body: {} },

  // ── member-level mutation surface ─────────────────────────────────────────
  { method: 'POST',   path: '/api/contacts',                  level: 'member',  body: {}, needsHubspot: true },
  { method: 'POST',   path: '/api/contacts/0/localdata',      level: 'member',  body: {}, needsHubspot: true },
  { method: 'PATCH',  path: '/api/contacts/0',                level: 'member',  body: {}, needsHubspot: true },
  { method: 'PATCH',  path: '/api/deals/0',                   level: 'member',  body: {}, needsHubspot: true },
  { method: 'POST',   path: '/api/deals/0/checklist',         level: 'member',  body: {}, needsHubspot: true },
  { method: 'POST',   path: '/api/contacts/0/workflow',       level: 'member',  body: {}, needsHubspot: true },
  { method: 'POST',   path: '/api/deals/0/workflow',          level: 'member',  body: {}, needsHubspot: true },
  { method: 'POST',   path: '/api/contacts/0/tasks',          level: 'member',  body: {}, needsHubspot: true },
  { method: 'PATCH',  path: '/api/tasks/0',                   level: 'member',  body: {}, needsHubspot: true },
  { method: 'DELETE', path: '/api/tasks/0',                   level: 'member',  needsHubspot: true },
  { method: 'POST',   path: '/api/emails/send',               level: 'member',  body: {}, needsGoogle: true },
  { method: 'POST',   path: '/api/events',                    level: 'member',  body: {}, needsGoogle: true },
  { method: 'POST',   path: '/api/personal-tasks',            level: 'member',  body: {} },
  { method: 'PATCH',  path: '/api/personal-tasks/0',          level: 'member',  body: {} },
  { method: 'DELETE', path: '/api/personal-tasks/0',          level: 'member' },
  { method: 'POST',   path: '/api/visits',                    level: 'member',  body: {} },
  { method: 'PATCH',  path: '/api/visits/0',                  level: 'member',  body: {} },
  { method: 'DELETE', path: '/api/visits/0',                  level: 'member' },

  // ── manager-level surface ─────────────────────────────────────────────────
  { method: 'POST',   path: '/api/workflow',                  level: 'manager', body: {} },
  { method: 'PATCH',  path: '/api/contacts/0/rooms/0/fitter', level: 'manager', body: {}, needsHubspot: true },
  { method: 'GET',    path: '/trades',                        level: 'manager' },
  { method: 'GET',    path: '/api/trades',                    level: 'manager' },
  { method: 'POST',   path: '/api/trades',                    level: 'manager', body: {} },
  { method: 'PUT',    path: '/api/trades/0',                  level: 'manager', body: {} },
  { method: 'GET',    path: '/api/trades/0/audit',            level: 'manager' },
  { method: 'DELETE', path: '/api/trades/0',                  level: 'manager' },
  { method: 'POST',   path: '/api/trades/submissions',        level: 'manager', body: {} },
  { method: 'GET',    path: '/api/quickbooks/invoices',       level: 'manager', needsQB: true },
  { method: 'GET',    path: '/api/quickbooks/invoice/0',      level: 'manager', needsQB: true },
  { method: 'GET',    path: '/api/quickbooks/invoice/0/pdf',  level: 'manager', needsQB: true },

  // ── admin-level surface ───────────────────────────────────────────────────
  { method: 'GET',    path: '/admin',                                          level: 'admin' },
  { method: 'GET',    path: '/api/admin/requests',                             level: 'admin' },
  { method: 'POST',   path: '/api/admin/requests/0/approve',                   level: 'admin', body: {} },
  { method: 'POST',   path: '/api/admin/requests/0/reject',                    level: 'admin', body: {} },
  { method: 'GET',    path: '/api/admin/allowed',                              level: 'admin' },
  { method: 'POST',   path: '/api/admin/allowed',                              level: 'admin', body: {} },
  { method: 'DELETE', path: '/api/admin/allowed/test-noop@privtest.local',     level: 'admin' },
  { method: 'GET',    path: '/api/admin/users',                                level: 'admin' },
  { method: 'GET',    path: '/api/admin/audit-log',                            level: 'admin' },
  { method: 'GET',    path: '/api/admin/capabilities',                         level: 'admin' },
  { method: 'PATCH',  path: '/api/admin/capabilities',                         level: 'admin', body: {} },
  { method: 'GET',    path: '/api/admin/job-roles',                            level: 'admin' },
  { method: 'POST',   path: '/api/admin/job-roles',                            level: 'admin', body: {} },
  { method: 'DELETE', path: '/api/admin/job-roles/__nope__',                   level: 'admin' },
  { method: 'GET',    path: '/api/admin/photo-requests',                       level: 'admin' },
  { method: 'POST',   path: '/api/admin/photo-requests/0/approve',             level: 'admin', body: {} },
  { method: 'POST',   path: '/api/admin/photo-requests/0/reject',              level: 'admin', body: {} },
  { method: 'GET',    path: '/api/admin/trades/submissions',                   level: 'admin' },
  { method: 'POST',   path: '/api/admin/trades/submissions/0/approve',         level: 'admin', body: {} },
  { method: 'POST',   path: '/api/admin/trades/submissions/0/reject',          level: 'admin', body: {} },
  { method: 'GET',    path: '/api/admin/trades-audit',                         level: 'admin' },
  { method: 'POST',   path: '/api/admin/trades/migrate',                       level: 'admin', body: {} },
  { method: 'PATCH',  path: '/api/trades/0/category',                          level: 'admin', body: {} },
  { method: 'POST',   path: '/api/admin/users/foo@bar.com/resend-set-password',   level: 'admin', body: {} },
  { method: 'POST',   path: '/api/admin/users/foo@bar.com/force-password-reset', level: 'admin', body: {} },
  { method: 'GET',    path: '/auth/quickbooks',                                level: 'admin' },
  { method: 'GET',    path: '/auth/quickbooks/callback?code=x&state=y&realmId=1', level: 'admin' },
  { method: 'POST',   path: '/auth/quickbooks/disconnect',                     level: 'admin', body: {} },
  { method: 'POST',   path: '/api/quickbooks/invoice/0',                       level: 'admin', body: {}, needsQB: true },
  { method: 'POST',   path: '/api/quickbooks/invoice/0/send',                  level: 'admin', body: {}, needsQB: true },
];

function classifyOutcome({ requiredLevel, actorLevel, status, route, actorIsTargetUser }) {
  // Public routes: anyone may hit them; only an explicit 401/403 from a gate
  // would be a finding here. Everything else is a pass.
  if (requiredLevel === 'public') {
    if (status === 401 || status === 403) return { ok: false, kind: 'public-route-blocked' };
    return { ok: true, kind: 'public-as-expected' };
  }

  // Self-or-admin (e.g. /api/users/:id/profile). The runner targets a foreign
  // user id by default, so only the admin actor should pass.
  if (requiredLevel === 'self-or-admin') {
    if (actorLevel === 'unauth') {
      if (status === 401 || status === 403) return { ok: true, kind: 'denied-as-expected' };
      return { ok: false, kind: 'unauth-leak' };
    }
    const isAdmin = actorLevel === 'admin';
    const isSelf  = !!actorIsTargetUser;
    const shouldPass = isAdmin || isSelf;
    if (shouldPass) {
      if (status === 401 || status === 403) return { ok: false, kind: 'unexpected-denial' };
      return { ok: true, kind: 'authorized-as-expected' };
    }
    if (status === 401 || status === 403) return { ok: true, kind: 'denied-as-expected' };
    return { ok: false, kind: 'idor-leak' };
  }

  // Unauth on any gated route should be denied by the global gate.
  if (actorLevel === 'unauth') {
    if (status === 401 || status === 403) return { ok: true, kind: 'denied-as-expected' };
    if (status === 302) return { ok: true, kind: 'redirect-as-expected' }; // /admin, /trades
    if (status === 429) return { ok: true, kind: 'rate-limited' };
    return { ok: false, kind: 'unauth-leak' };
  }

  const actorRank = RANK[actorLevel];
  const reqRank   = RANK[requiredLevel === 'auth' ? 'viewer' : requiredLevel];
  const shouldPass = actorRank >= reqRank;

  if (shouldPass) {
    if (status === 403) return { ok: false, kind: 'unexpected-denial' };
    if (status === 401) {
      return route?.needsGoogle || route?.needsHubspot || route?.needsQB
        ? { ok: true, kind: 'handler-401-unverified' }
        : { ok: false, kind: 'unexpected-denial' };
    }
    if (status === 429) return { ok: true, kind: 'rate-limited' };
    return { ok: true, kind: 'authorized-as-expected' };
  } else {
    if (status === 401 || status === 403) return { ok: true, kind: 'denied-as-expected' };
    if (status === 429) return { ok: true, kind: 'rate-limited' };
    if (status === 503 && route?.needsHubspot) {
      return { ok: true, inconclusive: true, kind: 'hubspot-guard-503-inconclusive' };
    }
    return { ok: false, kind: 'privilege-escalation' };
  }
}

module.exports = { RANK, ROUTES, classifyOutcome };
