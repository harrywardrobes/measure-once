const RANK = { unauth: -1, viewer: 0, member: 1, manager: 2, admin: 3 };

const ROUTES = [
  { method: 'GET',    path: '/api/auth/user',                level: 'auth' },
  { method: 'GET',    path: '/api/onboarding/me',            level: 'auth' },
  { method: 'GET',    path: '/api/job-roles',                level: 'auth' },
  { method: 'GET',    path: '/api/platform-users',           level: 'auth' },
  { method: 'GET',    path: '/api/users/me/prefs',           level: 'auth' },
  { method: 'GET',    path: '/api/google/status',            level: 'auth' },
  { method: 'GET',    path: '/api/quickbooks/status',        level: 'auth' },
  { method: 'GET',    path: '/api/visits',                   level: 'auth' },
  { method: 'GET',    path: '/api/localdata/all',            level: 'auth' },
  { method: 'GET',    path: '/api/workflow-stages',          level: 'auth' },
  { method: 'GET',    path: '/api/contacts-all',             level: 'auth' },

  { method: 'PATCH',  path: '/api/users/me/prefs',           level: 'auth',    body: {} },
  { method: 'POST',   path: '/api/users/me/photo',           level: 'auth',    body: {} },

  { method: 'POST',   path: '/api/contacts',                 level: 'member',  body: {}, needsHubspot: true },
  { method: 'PATCH',  path: '/api/contacts/0/localdata',     level: 'member',  body: {}, needsHubspot: true },
  { method: 'PATCH',  path: '/api/contacts/0',               level: 'member',  body: {}, needsHubspot: true },
  { method: 'PATCH',  path: '/api/deals/0',                  level: 'member',  body: {}, needsHubspot: true },
  { method: 'POST',   path: '/api/deals/0/checklist',        level: 'member',  body: {}, needsHubspot: true },
  { method: 'POST',   path: '/api/contacts/0/workflow',      level: 'member',  body: {}, needsHubspot: true },
  { method: 'POST',   path: '/api/deals/0/workflow',         level: 'member',  body: {}, needsHubspot: true },
  { method: 'POST',   path: '/api/contacts/0/tasks',         level: 'member',  body: {}, needsHubspot: true },
  { method: 'PATCH',  path: '/api/tasks/0',                  level: 'member',  body: {}, needsHubspot: true },
  { method: 'DELETE', path: '/api/tasks/0',                  level: 'member', needsHubspot: true },
  { method: 'POST',   path: '/api/emails/send',              level: 'member',  body: {}, needsGoogle: true },
  { method: 'POST',   path: '/api/events',                   level: 'member',  body: {}, needsGoogle: true },
  { method: 'POST',   path: '/api/personal-tasks',           level: 'member',  body: {} },
  { method: 'PATCH',  path: '/api/personal-tasks/0',         level: 'member',  body: {} },
  { method: 'DELETE', path: '/api/personal-tasks/0',         level: 'member' },
  { method: 'POST',   path: '/api/visits',                   level: 'member',  body: {} },
  { method: 'PATCH',  path: '/api/visits/0',                 level: 'member',  body: {} },
  { method: 'DELETE', path: '/api/visits/0',                 level: 'member' },

  { method: 'POST',   path: '/api/workflow',                 level: 'manager', body: {} },
  { method: 'PATCH',  path: '/api/contacts/0/rooms/0/fitter',level: 'manager', body: {}, needsHubspot: true },
  { method: 'GET',    path: '/api/trades',                   level: 'manager' },
  { method: 'POST',   path: '/api/trades',                   level: 'manager', body: {} },
  { method: 'PUT',    path: '/api/trades/0',                 level: 'manager', body: {} },
  { method: 'GET',    path: '/api/trades/0/audit',           level: 'manager' },
  { method: 'DELETE', path: '/api/trades/0',                 level: 'manager' },
  { method: 'POST',   path: '/api/trades/submissions',       level: 'manager', body: {} },
  { method: 'GET',    path: '/api/quickbooks/invoices',      level: 'manager' },
  { method: 'GET',    path: '/api/quickbooks/invoice/0',     level: 'manager' },
  { method: 'GET',    path: '/api/quickbooks/invoice/0/pdf', level: 'manager' },

  { method: 'GET',    path: '/api/admin/requests',                           level: 'admin' },
  { method: 'POST',   path: '/api/admin/requests/0/approve',                 level: 'admin', body: {} },
  { method: 'POST',   path: '/api/admin/requests/0/reject',                  level: 'admin', body: {} },
  { method: 'POST',   path: '/api/admin/allowed',                            level: 'admin', body: {} },
  { method: 'DELETE', path: '/api/admin/allowed/test-noop@privtest.local',   level: 'admin' },
  { method: 'GET',    path: '/api/admin/users',                              level: 'admin' },
  { method: 'GET',    path: '/api/admin/audit-log',                          level: 'admin' },
  { method: 'GET',    path: '/api/admin/job-roles',                          level: 'admin' },
  { method: 'POST',   path: '/api/admin/job-roles',                          level: 'admin', body: {} },
  { method: 'DELETE', path: '/api/admin/job-roles/__nope__',                 level: 'admin' },
  { method: 'GET',    path: '/api/admin/photo-requests',                     level: 'admin' },
  { method: 'POST',   path: '/api/admin/photo-requests/0/approve',           level: 'admin', body: {} },
  { method: 'POST',   path: '/api/admin/photo-requests/0/reject',            level: 'admin', body: {} },
  { method: 'GET',    path: '/api/admin/trades/submissions',                 level: 'admin' },
  { method: 'POST',   path: '/api/admin/trades/submissions/0/approve',       level: 'admin', body: {} },
  { method: 'POST',   path: '/api/admin/trades/submissions/0/reject',        level: 'admin', body: {} },
  { method: 'GET',    path: '/api/admin/trades-audit',                       level: 'admin' },
  { method: 'PATCH',  path: '/api/trades/0/category',                        level: 'admin', body: {} },
  { method: 'POST',   path: '/api/admin/users/foo@bar.com/resend-set-password', level: 'admin', body: {} },
  { method: 'POST',   path: '/api/admin/users/foo@bar.com/force-password-reset', level: 'admin', body: {} },
  { method: 'POST',   path: '/api/quickbooks/invoice/0',                     level: 'admin', body: {} },
  { method: 'POST',   path: '/api/quickbooks/invoice/0/send',                level: 'admin', body: {} },
  { method: 'POST',   path: '/auth/quickbooks/disconnect',                   level: 'admin', body: {} },
];

function classifyOutcome({ requiredLevel, actorLevel, status, route }) {
  if (actorLevel === 'unauth') {
    if (status === 401 || status === 403) return { ok: true, kind: 'denied-as-expected' };
    if (status === 429) return { ok: true, kind: 'rate-limited' };
    return { ok: false, kind: 'unauth-leak' };
  }
  const actorRank = RANK[actorLevel];
  const reqRank   = RANK[requiredLevel === 'auth' ? 'viewer' : requiredLevel];
  const shouldPass = actorRank >= reqRank;
  if (shouldPass) {
    if (status === 403) return { ok: false, kind: 'unexpected-denial' };
    if (status === 401) {
      return route?.needsGoogle || route?.needsHubspot
        ? { ok: true, kind: 'handler-401-unverified' }
        : { ok: false, kind: 'unexpected-denial' };
    }
    if (status === 429) return { ok: true, kind: 'rate-limited' };
    return { ok: true, kind: 'authorized-as-expected' };
  } else {
    if (status === 401 || status === 403) return { ok: true, kind: 'denied-as-expected' };
    if (status === 429) return { ok: true, kind: 'rate-limited' };
    if (status === 503 && route?.needsHubspot) {
      // Inconclusive: app.use('/api/contacts', requireHubspotToken) fires
      // before requirePrivilege, so we cannot tell from the wire whether the
      // gate would have denied. Surface as a separate `inconclusive` bucket so
      // the harness can report skipped coverage without false passes.
      return { ok: true, inconclusive: true, kind: 'hubspot-guard-503-inconclusive' };
    }
    return { ok: false, kind: 'privilege-escalation' };
  }
}

module.exports = { RANK, ROUTES, classifyOutcome };
