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
  // Authentication entry points: anyone may POST; the handler decides on
  // payload validity. The matrix only asserts the *gate* doesn't 401/403
  // them (junk body ⇒ 400/422 from validator, which is fine for `public`).
  { method: 'POST',   path: '/api/login',                     level: 'public', body: { email: 'matrix-noop@privtest.local', password: 'x' } },
  { method: 'POST',   path: '/api/request-access',            level: 'public', body: { name: 'matrix', email: 'matrix-noop@privtest.local' } },
  { method: 'POST',   path: '/api/forgot-password',           level: 'public', body: { email: 'matrix-noop@privtest.local' } },
  { method: 'POST',   path: '/api/set-password',              level: 'public', body: { token: 'invalid', password: 'WhateverStrong!9z' } },

  // ── auth-level (`isAuthenticated` only) ───────────────────────────────────
  { method: 'GET',    path: '/api/auth/user',                 level: 'auth' },
  // /api/change-password also lives behind isAuthenticated + loginLimiter.
  // Junk body → 400; the gate is what we're asserting here. (Per-role
  // re-login happens at the bottom of the loop, so the rate-limit cap of
  // 20/15min is well clear.)
  // `acceptsHandler401: true` lets the classifier accept 401 from the
  // handler (wrong currentPassword) for authenticated actors instead of
  // treating it as an unexpected denial from the gate.
  { method: 'POST',   path: '/api/change-password',           level: 'auth',    body: { currentPassword: 'x', newPassword: 'WhateverStrong!9z' }, acceptsHandler401: true },
  { method: 'GET',    path: '/api/onboarding/me',             level: 'auth' },
  { method: 'POST',   path: '/api/onboarding/complete',       level: 'auth',    body: {} },
  { method: 'GET',    path: '/api/job-roles',                 level: 'auth' },
  { method: 'GET',    path: '/api/page-filter-config',        level: 'auth' },
  { method: 'GET',    path: '/api/nav-role-config',           level: 'auth' },
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
  { method: 'GET',    path: '/api/database/status',           level: 'auth' },
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
  { method: 'GET',    path: '/api/card-action-handlers',      level: 'auth' },
  { method: 'GET',    path: '/api/workflow-stages',           level: 'auth' },
  { method: 'GET',    path: '/api/personal-tasks',            level: 'auth' },
  { method: 'GET',    path: '/api/visits',                    level: 'auth' },
  { method: 'GET',    path: '/api/contacts-lead-status-counts', level: 'auth',  needsHubspot: true },
  { method: 'GET',    path: '/api/lead-statuses',              level: 'auth' },
  { method: 'GET',    path: '/api/stage-action-labels',        level: 'auth' },
  { method: 'GET',    path: '/api/lead-substatuses',           level: 'auth' },
  { method: 'GET',    path: '/api/search-settings',            level: 'auth' },
  { method: 'GET',    path: '/api/whatsapp/config',            level: 'auth' },
  // Ideas board (no per-route gate; relies on the global isAuthenticated mount).
  { method: 'GET',    path: '/api/ideas',                      level: 'auth' },
  { method: 'POST',   path: '/api/ideas',                      level: 'auth',  body: { body: '__privtest_noop__' } },
  { method: 'GET',    path: '/api/ideas/0/comments',           level: 'auth' },
  { method: 'POST',   path: '/api/ideas/0/comments',           level: 'auth',  body: { body: '__privtest_noop__' } },
  { method: 'POST',   path: '/api/ideas/0/vote',               level: 'auth' },
  { method: 'DELETE', path: '/api/ideas/0',                    level: 'admin' },
  { method: 'PATCH',  path: '/api/ideas/0',                    level: 'admin',  body: { body: '__privtest_noop__' } },
  { method: 'DELETE', path: '/api/ideas/0/comments/0',         level: 'admin' },
  { method: 'PATCH',  path: '/api/ideas/0/comments/0',         level: 'admin',  body: { body: '__privtest_noop__' } },
  // Design-visit catalogue reads (any authenticated user can browse the
  // shared catalogue; admin writes live in the admin block below).
  { method: 'GET',    path: '/api/design-visit-terms',         level: 'auth' },
  { method: 'GET',    path: '/api/design-visit-handles',       level: 'auth' },
  { method: 'GET',    path: '/api/design-visit-furniture-ranges', level: 'auth' },
  { method: 'GET',    path: '/api/design-visit-door-styles',   level: 'auth' },

  // ── self-or-admin (foreign id picked at runtime) ──────────────────────────
  { method: 'GET',    path: '/api/users/__FOREIGN__/profile', level: 'self-or-admin' },
  // Photos are team-roster profile pictures intentionally visible to all
  // authenticated users (admin.html loads them for every team member).
  // The route only enforces isAuthenticated; `auth` is the correct gate level.
  { method: 'GET',    path: '/api/users/__FOREIGN__/photo',   level: 'auth' },
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
  { method: 'POST',   path: '/api/contacts/urgency',          level: 'auth',    body: {}, needsHubspot: true },
  { method: 'PATCH',  path: '/api/tasks/0',                   level: 'member',  body: {}, needsHubspot: true },
  { method: 'DELETE', path: '/api/tasks/0',                   level: 'member',  needsHubspot: true },
  { method: 'POST',   path: '/api/emails/send',               level: 'member',  body: {}, needsGoogle: true },
  { method: 'POST',   path: '/api/events',                    level: 'member',  body: {}, needsGoogle: true },
  { method: 'PATCH',  path: '/api/events/0',                  level: 'member',  body: {}, needsGoogle: true },
  { method: 'DELETE', path: '/api/events/0',                  level: 'member',  needsGoogle: true },
  { method: 'POST',   path: '/api/personal-tasks',            level: 'member',  body: {} },
  { method: 'PATCH',  path: '/api/personal-tasks/0',          level: 'member',  body: {} },
  { method: 'DELETE', path: '/api/personal-tasks/0',          level: 'member' },
  { method: 'POST',   path: '/api/visits',                    level: 'member',  body: {} },
  { method: 'POST',   path: '/api/card-actions/phone-call-summary', level: 'member', body: { contactId: '0', summary: 'noop' }, needsHubspot: true },
  { method: 'PATCH',  path: '/api/visits/0',                  level: 'member',  body: {} },
  { method: 'DELETE', path: '/api/visits/0',                  level: 'member' },
  // Design-visit member-level surface (design-visits.js).
  { method: 'GET',    path: '/api/design-visits',              level: 'member' },
  { method: 'GET',    path: '/api/design-visits/in-progress',  level: 'member' },
  { method: 'GET',    path: '/api/design-visits/0',            level: 'member' },
  { method: 'POST',   path: '/api/design-visits',             level: 'member',  body: {} },
  { method: 'PATCH',  path: '/api/design-visits/0',           level: 'member',  body: {} },
  { method: 'PUT',    path: '/api/design-visits/0',           level: 'member',  body: {} },
  { method: 'POST',   path: '/api/design-visits/0/submit',    level: 'member',  body: {} },
  { method: 'POST',   path: '/api/design-visits/0/revision',  level: 'admin',   body: {} },
  { method: 'POST',   path: '/api/design-visits/uploads',     level: 'member',  body: {} },
  { method: 'DELETE', path: '/api/design-visits/uploads/obj%3Afake.jpg', level: 'member' },
  // /api/design-visit-images/:key is registered on the design-visits router
  // BEFORE the global /api isAuthenticated gate (server.js mounts the router
  // at line 121, the gate at line 136), so it's intentionally public and
  // gated by HMAC. It lives in PUBLIC_PATH_ALLOWLIST in routeAudit.js; no
  // matrix row is needed because there's no privilege gate to measure.

  // ── manager-level surface ─────────────────────────────────────────────────
  { method: 'POST',   path: '/api/workflow',                  level: 'manager', body: {} },
  { method: 'PATCH',  path: '/api/contacts/0/rooms/0/fitter', level: 'manager', body: {}, needsHubspot: true },
  // /trades is just an HTML shell gated by isAuthenticated; the actual
  // trade data is fetched via /api/trades (requireManagerOrAdmin below).
  // The page therefore lives at the 'auth' level — non-managers landing on
  // it see an empty UI but can't read any trade data. Matrix row stays
  // here in the manager block for documentation; level is 'auth'.
  { method: 'GET',    path: '/trades',                        level: 'auth' },
  { method: 'GET',    path: '/api/trades',                    level: 'manager' },
  { method: 'POST',   path: '/api/trades',                    level: 'manager', body: {} },
  { method: 'PUT',    path: '/api/trades/0',                  level: 'manager', body: {} },
  { method: 'GET',    path: '/api/trades/0/audit',            level: 'manager' },
  { method: 'DELETE', path: '/api/trades/0',                  level: 'manager' },
  { method: 'POST',   path: '/api/trades/submissions',        level: 'manager', body: {} },
  { method: 'GET',    path: '/api/admin/phone-directory',     level: 'manager' },
  // QuickBooks invoice read/write/PDF endpoints all live behind requireAdmin
  // in quickbooks.js (the shared-tenant token is admin-scoped); the matrix
  // mirrors that. routeAudit.auditMatrixLevels keeps this row honest.
  { method: 'GET',    path: '/api/quickbooks/invoices',       level: 'admin', needsQB: true },
  { method: 'GET',    path: '/api/quickbooks/invoice/0',      level: 'admin', needsQB: true },
  { method: 'GET',    path: '/api/quickbooks/invoice/0/pdf',  level: 'admin', needsQB: true },

  // ── admin-level surface ───────────────────────────────────────────────────
  { method: 'GET',    path: '/admin',                                          level: 'admin' },
  { method: 'GET',    path: '/api/admin/requests',                             level: 'admin' },
  { method: 'POST',   path: '/api/admin/requests/0/approve',                   level: 'admin', body: {} },
  { method: 'POST',   path: '/api/admin/requests/0/reject',                    level: 'admin', body: {} },
  { method: 'GET',    path: '/api/admin/allowed',                              level: 'admin' },
  { method: 'POST',   path: '/api/admin/allowed',                              level: 'admin', body: {} },
  { method: 'DELETE', path: '/api/admin/allowed/test-noop@privtest.local',     level: 'admin' },
  { method: 'GET',    path: '/api/admin/users',                                level: 'admin' },
  { method: 'GET',    path: '/api/admin/conflict-summary',                     level: 'admin' },
  { method: 'GET',    path: '/api/admin/conflict-digest-settings',             level: 'admin' },
  { method: 'PATCH',  path: '/api/admin/conflict-digest-settings',             level: 'admin', body: {} },
  { method: 'POST',   path: '/api/admin/conflict-digest/send-now',             level: 'admin', body: {} },
  { method: 'GET',    path: '/api/admin/page-filter-config',                   level: 'admin' },
  { method: 'PATCH',  path: '/api/admin/page-filter-config',                   level: 'admin', body: {} },
  { method: 'GET',    path: '/api/admin/audit-log',                            level: 'admin' },
  { method: 'GET',    path: '/api/admin/capabilities',                         level: 'admin' },
  { method: 'PATCH',  path: '/api/admin/capabilities',                         level: 'admin', body: {} },
  { method: 'GET',    path: '/api/admin/job-roles',                            level: 'admin' },
  { method: 'POST',   path: '/api/admin/job-roles',                            level: 'admin', body: {} },
  { method: 'DELETE', path: '/api/admin/job-roles/__nope__',                   level: 'admin' },
  { method: 'GET',    path: '/api/admin/nav-role-configs',                     level: 'admin' },
  { method: 'PATCH',  path: '/api/admin/nav-role-config/__default__',          level: 'admin', body: { primary_keys: ['home', 'calendar', 'trades'] } },
  { method: 'GET',    path: '/api/admin/photo-requests',                       level: 'admin' },
  { method: 'POST',   path: '/api/admin/photo-requests/0/approve',             level: 'admin', body: {} },
  { method: 'POST',   path: '/api/admin/photo-requests/0/reject',              level: 'admin', body: {} },
  { method: 'GET',    path: '/api/admin/trades/submissions',                   level: 'admin' },
  { method: 'POST',   path: '/api/admin/trades/submissions/0/approve',         level: 'admin', body: {} },
  { method: 'POST',   path: '/api/admin/trades/submissions/0/reject',          level: 'admin', body: {} },
  { method: 'GET',    path: '/api/admin/trades-audit',                         level: 'admin' },
  { method: 'GET',    path: '/api/admin/audit-log-unified',                    level: 'admin' },
  { method: 'POST',   path: '/api/admin/trades/migrate',                       level: 'admin', body: {} },
  { method: 'PATCH',  path: '/api/trades/0/category',                          level: 'admin', body: {} },
  { method: 'POST',   path: '/api/admin/users/foo@bar.com/resend-set-password',   level: 'admin', body: {} },
  { method: 'POST',   path: '/api/admin/users/foo@bar.com/force-password-reset', level: 'admin', body: {} },
  { method: 'POST',   path: '/api/admin/users/0/resolve-profile-conflicts',      level: 'admin', body: {} },
  { method: 'POST',   path: '/api/admin/test/bust-open-leads-cache',             level: 'admin', body: {} },
  { method: 'POST',   path: '/api/admin/test/reset-lead-status-counts-cooldown', level: 'admin', body: {} },
  { method: 'GET',    path: '/auth/quickbooks',                                level: 'admin' },
  { method: 'GET',    path: '/auth/quickbooks/callback?code=x&state=y&realmId=1', level: 'admin' },
  { method: 'POST',   path: '/auth/quickbooks/disconnect',                     level: 'admin', body: {} },
  { method: 'POST',   path: '/api/quickbooks/invoice/0',                       level: 'admin', body: {}, needsQB: true },
  { method: 'POST',   path: '/api/quickbooks/invoice/0/send',                  level: 'admin', body: {}, needsQB: true },
  // Multipart upload endpoint — no file in the body, so admin should receive
  // 400 ("No image file provided"); non-admins must be 403 from requireAdmin
  // (which runs before multer ever sees the empty body).
  { method: 'POST',   path: '/api/admin/dv-handles/0/image',                    level: 'admin', body: {} },
  { method: 'GET',    path: '/api/admin/card-action-handlers',                 level: 'admin' },
  { method: 'GET',    path: '/api/admin/card-action-handlers/conflicts',       level: 'admin' },
  // Dev-only admin endpoints (return 404 when NODE_ENV=production). The
  // requireAdmin gate runs first, so non-admin actors still get 403; admins
  // hit the handler. seed-contacts-cache with an empty body 400s.
  { method: 'POST',   path: '/api/admin/test/seed-contacts-cache',             level: 'admin', body: {} },
  { method: 'POST',   path: '/api/admin/test/bust-contacts-cache',             level: 'admin', body: {} },
  { method: 'POST',   path: '/api/admin/card-action-handlers',                 level: 'admin', body: { name: '__noop__', type: 'summarise_phone_call' } },
  { method: 'PATCH',  path: '/api/admin/card-action-handlers/0',               level: 'admin', body: {} },
  { method: 'DELETE', path: '/api/admin/card-action-handlers/0',               level: 'admin' },
  // Admin-only read endpoints elsewhere in server.js. These rows exist so the
  // matrix records a member→403 (and viewer→403) cell for each — closing the
  // PRIV-00-style gap that surfaced on /api/admin/card-action-handlers.
  { method: 'GET',    path: '/api/admin/lead-statuses',                        level: 'admin' },
  { method: 'GET',    path: '/api/admin/stage-action-labels',                  level: 'admin' },
  { method: 'GET',    path: '/api/admin/hubspot/dev-mode',                     level: 'admin' },
  { method: 'GET',    path: '/api/admin/lead-substatuses',                     level: 'admin' },
  { method: 'GET',    path: '/api/admin/workshop-settings',                    level: 'admin' },
  { method: 'PATCH',  path: '/api/admin/workshop-settings',                    level: 'admin', body: {} },
  { method: 'GET',    path: '/api/admin/search-settings',                      level: 'admin' },
  { method: 'PUT',    path: '/api/admin/search-settings',                      level: 'admin', body: {} },

  // Admin-only writes for lead-statuses, stage labels, lead-substatuses,
  // dev filters, etc. The audit in test/privileges/routeAudit.js will fail
  // the run if any new /api/admin/* route ships without a row here.
  { method: 'POST',   path: '/api/admin/lead-statuses',                        level: 'admin', body: {} },
  { method: 'PATCH',  path: '/api/admin/lead-statuses/__noop__',               level: 'admin', body: {} },
  { method: 'DELETE', path: '/api/admin/lead-statuses/__noop__',               level: 'admin' },
  { method: 'PUT',    path: '/api/admin/stage-action-labels',                  level: 'admin', body: {} },
  { method: 'DELETE', path: '/api/admin/stage-action-labels/__noop__/__noop__', level: 'admin' },
  { method: 'POST',   path: '/api/admin/lead-substatuses',                     level: 'admin', body: {} },
  { method: 'PATCH',  path: '/api/admin/lead-substatuses/0',                   level: 'admin', body: {} },
  { method: 'DELETE', path: '/api/admin/lead-substatuses/0',                   level: 'admin' },
  { method: 'POST',   path: '/api/admin/lead-substatuses/sync-hubspot',        level: 'admin' },
  { method: 'GET',    path: '/api/admin/pending-count',                        level: 'admin' },

  // WhatsApp routes — admin-only but live outside the /api/admin/* prefix,
  // so the audit needs explicit rows. WhatsApp config is usually absent in
  // the test environment, which causes requireWhatsAppConfig to return 503
  // after the requireAdmin gate passes; the classifier treats that as
  // "authorized-as-expected" (only 401/403 from the gate would fail here).
  { method: 'GET',    path: '/api/whatsapp/templates',                         level: 'admin' },
  { method: 'POST',   path: '/api/whatsapp/send',                              level: 'admin', body: {} },
  { method: 'GET',    path: '/api/whatsapp/history/0',                         level: 'admin' },

  // Admin-only design-visit deletion (design-visits.js).
  { method: 'DELETE', path: '/api/design-visits/0',                            level: 'admin' },


  // Design-visit catalogue admin endpoints (design-visits.js).
  { method: 'GET',    path: '/api/admin/design-visit-handles',                 level: 'admin' },
  { method: 'POST',   path: '/api/admin/design-visit-handles',                 level: 'admin', body: {} },
  { method: 'PATCH',  path: '/api/admin/design-visit-handles/0',               level: 'admin', body: {} },
  { method: 'DELETE', path: '/api/admin/design-visit-handles/0',               level: 'admin' },
  { method: 'POST',   path: '/api/admin/design-visit-handles/upload-image',    level: 'admin', body: {} },
  { method: 'GET',    path: '/api/admin/design-visit-furniture-ranges',        level: 'admin' },
  { method: 'POST',   path: '/api/admin/design-visit-furniture-ranges',        level: 'admin', body: {} },
  { method: 'PATCH',  path: '/api/admin/design-visit-furniture-ranges/0',      level: 'admin', body: {} },
  { method: 'DELETE', path: '/api/admin/design-visit-furniture-ranges/0',      level: 'admin' },
  { method: 'GET',    path: '/api/admin/design-visit-door-styles',             level: 'admin' },
  { method: 'POST',   path: '/api/admin/design-visit-door-styles',             level: 'admin', body: {} },
  { method: 'PATCH',  path: '/api/admin/design-visit-door-styles/0',           level: 'admin', body: {} },
  { method: 'DELETE', path: '/api/admin/design-visit-door-styles/0',           level: 'admin' },
  { method: 'POST',   path: '/api/admin/design-visit-door-styles/upload-image', level: 'admin', body: {} },
  { method: 'GET',    path: '/api/admin/settings/design-visit-terms',          level: 'admin' },
  { method: 'PUT',    path: '/api/admin/settings/design-visit-terms',          level: 'admin', body: {} },
  { method: 'GET',    path: '/api/admin/terms-conditions/versions',            level: 'admin' },
  { method: 'POST',   path: '/api/admin/terms-conditions/versions',            level: 'admin', body: {} },

  // ── HubSpot webhook (task #1449) ──────────────────────────────────────────
  // The receiver is public (HubSpot POSTs without a session; gated by HMAC).
  { method: 'POST',   path: '/api/hubspot/webhook',                            level: 'public', body: [] },
  // SSE push endpoint — authenticated so only logged-in tabs receive events.
  // The matrix GET will receive 200 + text/event-stream; the test harness
  // treats a non-401/403 for authenticated actors as "authorized-as-expected".
  { method: 'GET',    path: '/api/hubspot/webhook-events',                     level: 'auth' },
  // Admin subscription management.
  { method: 'GET',    path: '/api/admin/hubspot-webhook',                      level: 'admin' },
  { method: 'POST',   path: '/api/admin/hubspot-webhook',                      level: 'admin', body: {} },
  { method: 'DELETE', path: '/api/admin/hubspot-webhook',                      level: 'admin' },

  // ── Logout MUST be last per actor (it destroys the session). The run.js
  // matrix loop is route-outer/actor-inner, so this row fires once per actor
  // after every other route has already been measured. Subsequent matrix
  // rows would 401, but there are no subsequent rows. Re-login for the
  // adversarial probe block happens explicitly in probes.js.
  { method: 'POST',   path: '/api/logout',                                     level: 'auth',  body: {}, isTerminal: true },
];

function classifyOutcome({ requiredLevel, actorLevel, status, route, actorIsTargetUser }) {
  // Public routes: anyone may hit them; a gate-style 403 would be a finding.
  // 401 is allowed here because auth-handler routes (/api/login,
  // /api/change-password as it lives behind isAuthenticated wasn't going to
  // hit this branch, but for /api/login the handler returns 401 on bad
  // creds). Rate-limit 429 is also acceptable (loginLimiter / accessLimiter).
  if (requiredLevel === 'public') {
    if (status === 403) return { ok: false, kind: 'public-route-blocked' };
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
      return route?.needsGoogle || route?.needsHubspot || route?.needsQB || route?.acceptsHandler401
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
