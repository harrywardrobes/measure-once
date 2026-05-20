const { makeClient, login, PASSWORD, makeEmail } = require('./harness');

async function runProbes({ clients, users, pool, runId }) {
  const findings = [];

  async function record(category, name, expected, observed, severity, ok, detail) {
    findings.push({ category, name, expected, observed, severity, ok, detail: detail || '' });
  }

  // ── Sign-in flow ───────────────────────────────────────────────────────────
  {
    const c = makeClient(null);
    const r = await c.post('/api/login', { email: users.member.email, password: 'wrong-password!' });
    await record('sign-in', 'wrong password rejected',
      '401 unauthorized', `status=${r.status}`,
      'high', r.status === 401);
  }
  {
    const c = makeClient(null);
    const r = await c.post('/api/login', { email: `nobody-${runId}@privtest.local`, password: PASSWORD });
    await record('sign-in', 'unknown email rejected',
      '401 unauthorized', `status=${r.status}`,
      'high', r.status === 401);
  }
  {
    const c = makeClient(null);
    const r = await c.post('/api/login', { email: 'not-an-email', password: PASSWORD });
    await record('sign-in', 'malformed email rejected',
      '400 bad request', `status=${r.status}`,
      'low', r.status === 400);
  }

  // Cookie attributes after a fresh login
  {
    const c = makeClient(null);
    const r = await c.post('/api/login', { email: users.viewer.email, password: PASSWORD });
    const raw = r.setCookieRaw || '';
    const httpOnly = /HttpOnly/i.test(raw);
    const secure   = /Secure/i.test(raw);
    const sameSite = /SameSite=Lax/i.test(raw);
    await record('sign-in', 'session cookie hardened',
      'HttpOnly + Secure + SameSite=Lax', `HttpOnly=${httpOnly} Secure=${secure} SameSite=Lax=${sameSite}`,
      'high', httpOnly && secure && sameSite);

    // Logout invalidates session
    const before = await c.get('/api/auth/user');
    await c.post('/api/logout', {});
    const after = await c.get('/api/auth/user');
    await record('sign-in', 'logout invalidates session',
      '/api/auth/user 200 before, 401 after',
      `before=${before.status} after=${after.status}`,
      'high', before.status === 200 && after.status === 401);
  }

  // ── Forgot-password / set-password lifecycle ───────────────────────────────
  {
    const c = makeClient(null);
    const r = await c.post('/api/forgot-password', { email: users.viewer.email });
    await record('password-flow', 'forgot-password always returns 200 (no enumeration)',
      'status=200', `status=${r.status}`,
      'medium', r.status === 200);

    // Pull the most recent token from the DB for this email
    const tokRow = await pool.query(
      `SELECT token_hash, expires_at, purpose, used_at
         FROM password_set_tokens
        WHERE email = $1
        ORDER BY expires_at DESC
        LIMIT 1`,
      [users.viewer.email]
    );
    const issued = tokRow.rowCount > 0;
    await record('password-flow', 'forgot-password issued a reset token',
      'one unused token row', `rowCount=${tokRow.rowCount} purpose=${tokRow.rows[0]?.purpose || 'n/a'}`,
      'high', issued && tokRow.rows[0]?.purpose === 'reset' && !tokRow.rows[0]?.used_at);
  }

  // set-password with empty/garbage token
  {
    const c = makeClient(null);
    const r = await c.post('/api/set-password', { token: '', password: 'NewPass123!Xyz' });
    await record('password-flow', 'empty token rejected',
      '410 gone', `status=${r.status}`,
      'high', r.status === 410);

    const r2 = await c.post('/api/set-password', { token: 'a'.repeat(64), password: 'NewPass123!Xyz' });
    await record('password-flow', 'random token rejected',
      '410 gone', `status=${r2.status}`,
      'high', r2.status === 410);
  }

  // Single-use enforcement: issue a fresh token, consume it, then replay
  {
    const crypto = require('crypto');
    const raw = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const email = users.viewer.email;
    await pool.query(
      `INSERT INTO password_set_tokens (token_hash, email, expires_at, purpose)
       VALUES ($1, $2, NOW() + INTERVAL '1 hour', 'reset')`,
      [hash, email]
    );
    const c = makeClient(null);
    const ok = await c.post('/api/set-password', { token: raw, password: 'AnotherStrong!Pw9xyz' });
    const replay = await c.post('/api/set-password', { token: raw, password: 'AnotherStrong!Pw9xyz' });
    await record('password-flow', 'set-password token is single-use',
      'first=200 replay=410', `first=${ok.status} replay=${replay.status}`,
      'critical', ok.status === 200 && replay.status === 410);

    // Restore the viewer password so later probes still work, and refresh
    // the long-lived viewer client because set-password just deleted its
    // session (auth.js:919-927 clears every *other* session for the email).
    const bcrypt = require('bcryptjs');
    const restored = await bcrypt.hash(PASSWORD, 10);
    await pool.query(`UPDATE users SET password_hash = $1 WHERE email = $2`,
      [restored, email]);
    clients.viewer = await login(users.viewer.email, PASSWORD);
  }

  // Expired token
  {
    const crypto = require('crypto');
    const raw = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    await pool.query(
      `INSERT INTO password_set_tokens (token_hash, email, expires_at, purpose)
       VALUES ($1, $2, NOW() - INTERVAL '1 hour', 'set')`,
      [hash, users.member.email]
    );
    const c = makeClient(null);
    const r = await c.post('/api/set-password', { token: raw, password: 'GoodEnough!Pw9xyz' });
    await record('password-flow', 'expired token rejected',
      '410 gone', `status=${r.status}`,
      'critical', r.status === 410);
  }

  // ── Privilege escalation via PATCH /api/users/:id/profile ─────────────────
  {
    const member = clients.member;
    const r = await member.patch(`/api/users/${users.member.id}/profile`,
      { privilege_level: 'admin' });
    await record('escalation', 'member cannot self-promote via PATCH profile',
      '403 forbidden', `status=${r.status}`,
      'critical', r.status === 403);

    const r2 = await member.patch(`/api/users/${users.member.id}/profile`,
      { onboarding_status: 'active', email: `hijacked-${runId}@privtest.local`, password_hash: 'xxx' });
    await record('escalation', 'member cannot mass-assign other fields via PATCH profile',
      '403 forbidden', `status=${r2.status}`,
      'critical', r2.status === 403);

    // confirm DB unchanged
    const row = await pool.query(`SELECT privilege_level, email FROM users WHERE id = $1`,
      [users.member.id]);
    const intact = row.rows[0]?.privilege_level === 'member' && row.rows[0]?.email === users.member.email;
    await record('escalation', 'member privilege_level + email unchanged after escalation attempts',
      `privilege_level=member email=${users.member.email}`,
      `privilege_level=${row.rows[0]?.privilege_level} email=${row.rows[0]?.email}`,
      'critical', intact);
  }

  // ── IDOR on /api/users/:id/profile and /photo ─────────────────────────────
  {
    const viewer = clients.viewer;
    const r = await viewer.get(`/api/users/${users.admin.id}/profile`);
    await record('idor', "viewer cannot read admin's profile",
      '403 forbidden', `status=${r.status}`,
      'high', r.status === 403);

    const r2 = await viewer.get(`/api/users/${users.manager.id}/profile`);
    await record('idor', "viewer cannot read manager's profile",
      '403 forbidden', `status=${r2.status}`,
      'high', r2.status === 403);

    // Note: photo upload endpoint writes to *self* by design — no per-id mutation
    // path exists, so the relevant IDOR surface is the PATCH /profile gate.
  }

  // ── Change-password edge cases ─────────────────────────────────────────────
  {
    const viewer = await login(users.viewer.email, PASSWORD);
    const probes = [
      ['wrong current password', { currentPassword: 'NotMyPassword!1', newPassword: 'OtherStrong!Pw9xyz' }, 401],
      ['empty body',              {}, 400],
      ['oversized password',      { currentPassword: PASSWORD, newPassword: 'A1' + 'b'.repeat(250) }, 400],
      ['whitespace password',     { currentPassword: PASSWORD, newPassword: '          ' }, 400],
      ['identical to current',    { currentPassword: PASSWORD, newPassword: PASSWORD }, 400],
    ];
    for (const [label, body, expected] of probes) {
      const r = await viewer.post('/api/change-password', body);
      await record('change-password', label,
        `status=${expected}`, `status=${r.status}`,
        'high', r.status === expected);
    }
  }

  // ── Allow-list revocation invalidates active session ──────────────────────
  {
    const victim = await login(users.viewer.email, PASSWORD);
    const before = await victim.get('/api/auth/user');
    // Admin revokes via the API (also kills sessions for the email)
    const admin = clients.admin;
    const del = await admin.delete(`/api/admin/allowed/${encodeURIComponent(users.viewer.email)}`);
    await record('session', 'admin revoke endpoint returns 200',
      'status=200', `status=${del.status}`,
      'high', del.status === 200);
    const after = await victim.get('/api/auth/user');
    await record('session', 'revoked user is logged out within one request',
      'before=200 after=401', `before=${before.status} after=${after.status}`,
      'critical', before.status === 200 && after.status === 401);

    // Restore the viewer for later probes (allow-list row + fresh session,
    // since the revocation deleted the previous one).
    await pool.query(
      `INSERT INTO allowed_emails (email, note) VALUES ($1, 'privilege test restore')
       ON CONFLICT (email) DO NOTHING`,
      [users.viewer.email]
    );
    clients.viewer = await login(users.viewer.email, PASSWORD);
  }

  // ── Force-password-reset invalidates other sessions (#297) ────────────────
  {
    const victim = await login(users.member.email, PASSWORD);
    const before = await victim.get('/api/auth/user');
    const admin = clients.admin;
    const reset = await admin.post(`/api/admin/users/${encodeURIComponent(users.member.email)}/force-password-reset`, {});
    await record('session', 'admin force-password-reset returns 200',
      'status=200', `status=${reset.status}`,
      'high', reset.status === 200);
    const after = await victim.get('/api/auth/user');
    await record('session', 'force-password-reset invalidates other sessions',
      'before=200 after=401', `before=${before.status} after=${after.status}`,
      'critical', before.status === 200 && after.status === 401);
    // Restore member's password
    const bcrypt = require('bcryptjs');
    const restored = await bcrypt.hash(PASSWORD, 10);
    await pool.query(`UPDATE users SET password_hash = $1 WHERE email = $2`,
      [restored, users.member.email]);
    // member client cookie is now dead — refresh it
    clients.member = await login(users.member.email, PASSWORD);
  }

  // ── Self-service change-password invalidates other sessions (#296) ────────
  {
    const sessA = await login(users.manager.email, PASSWORD);
    const sessB = await login(users.manager.email, PASSWORD);
    const newPw = 'RotatedStrong!Pw9xyz';
    const ch = await sessB.post('/api/change-password',
      { currentPassword: PASSWORD, newPassword: newPw });
    const after = await sessA.get('/api/auth/user');
    await record('session', 'change-password invalidates *other* sessions for the same user',
      'change=200 other-session-after=401',
      `change=${ch.status} other-session-after=${after.status}`,
      'critical', ch.status === 200 && after.status === 401);
    // Restore password
    const restore = await sessB.post('/api/change-password',
      { currentPassword: newPw, newPassword: PASSWORD });
    await record('session', 'restoring manager password for later probes succeeds',
      'status=200', `status=${restore.status}`,
      'info', restore.status === 200);
    clients.manager = await login(users.manager.email, PASSWORD);
  }

  // ── Admin-only mutations as non-admin ─────────────────────────────────────
  for (const actor of ['viewer', 'member', 'manager']) {
    const c = clients[actor];
    const r1 = await c.post('/api/admin/allowed',
      { email: `xss-probe-${runId}@privtest.local` });
    await record('admin-only', `${actor} cannot add allowed_email`,
      '403 forbidden', `status=${r1.status}`,
      'critical', r1.status === 403);
    const r2 = await c.delete(`/api/admin/allowed/${encodeURIComponent(users.viewer.email)}`);
    await record('admin-only', `${actor} cannot revoke allowed_email`,
      '403 forbidden', `status=${r2.status}`,
      'critical', r2.status === 403);
    const r3 = await c.post(
      `/api/admin/users/${encodeURIComponent(users.viewer.email)}/force-password-reset`, {});
    await record('admin-only', `${actor} cannot force a password reset`,
      '403 forbidden', `status=${r3.status}`,
      'critical', r3.status === 403);
    const r4 = await c.post(
      `/api/admin/users/${encodeURIComponent(users.viewer.email)}/resend-set-password`, {});
    await record('admin-only', `${actor} cannot resend set-password link`,
      '403 forbidden', `status=${r4.status}`,
      'high', r4.status === 403);
  }

  // ── Admin lifecycle smoke ─────────────────────────────────────────────────
  {
    const admin = clients.admin;
    const lifecycleEmail = `privtest-lifecycle-${runId}@privtest.local`;
    const add = await admin.post('/api/admin/allowed', { email: lifecycleEmail });
    await record('admin-lifecycle', 'admin add allowed_email',
      'status=200', `status=${add.status}`,
      'high', add.status === 200);
    const resend = await admin.post(
      `/api/admin/users/${encodeURIComponent(lifecycleEmail)}/resend-set-password`, {});
    await record('admin-lifecycle', 'admin resend set-password',
      'status in {200,500}', `status=${resend.status}`,
      'medium', resend.status === 200 || resend.status === 500);
    const force = await admin.post(
      `/api/admin/users/${encodeURIComponent(lifecycleEmail)}/force-password-reset`, {});
    await record('admin-lifecycle', 'admin force-password-reset',
      'status in {200,500}', `status=${force.status}`,
      'medium', force.status === 200 || force.status === 500);
    const revoke = await admin.delete(`/api/admin/allowed/${encodeURIComponent(lifecycleEmail)}`);
    await record('admin-lifecycle', 'admin revoke allowed_email',
      'status=200', `status=${revoke.status}`,
      'high', revoke.status === 200);
    // Cleanup
    await pool.query(`DELETE FROM users WHERE email = $1`, [lifecycleEmail]);
    await pool.query(`DELETE FROM password_set_tokens WHERE email = $1`, [lifecycleEmail]);
  }

  // Force-password-reset against self (admin)
  {
    const admin = clients.admin;
    const r = await admin.post(
      `/api/admin/users/${encodeURIComponent(users.admin.email)}/force-password-reset`, {});
    await record('admin-lifecycle', 'admin cannot force-reset their own password',
      '400 bad request', `status=${r.status}`,
      'high', r.status === 400);
  }

  // ── Admin page (HTML) ─────────────────────────────────────────────────────
  {
    const unauth = makeClient(null);
    const r = await unauth.get('/admin');
    await record('admin-page', 'unauthenticated /admin redirects to /login',
      '302 to /login', `status=${r.status} location=${r.headers.get('location') || ''}`,
      'high', r.status === 302 && (r.headers.get('location') || '').startsWith('/login'));
    for (const actor of ['viewer', 'member', 'manager']) {
      const cr = await clients[actor].get('/admin');
      const denied = cr.status === 403 && /Admin access required/i.test(cr.text);
      await record('admin-page', `${actor} sees the admin access-denied page`,
        '403 + "Admin access required"', `status=${cr.status}`,
        'critical', denied);
    }
    const ar = await clients.admin.get('/admin');
    await record('admin-page', 'admin can load /admin',
      'status=200', `status=${ar.status}`,
      'high', ar.status === 200);
  }

  // ── Turnstile / captcha behaviour ─────────────────────────────────────────
  // In the test harness TURNSTILE_SECRET_KEY is unset (so the check is a no-op).
  // We capture this in the report rather than probing live Cloudflare.
  {
    const tc = await makeClient(null).get('/api/turnstile-config');
    const enabled = tc.json?.enabled === true;
    await record('captcha', 'Turnstile is disabled in the test harness',
      'enabled=false', `enabled=${tc.json?.enabled}`,
      'info', !enabled,
      'Set TURNSTILE_SECRET_KEY in the env to re-run with captcha enforcement.');
    const c = makeClient(null);
    const r = await c.post('/api/login', { email: users.viewer.email, password: PASSWORD });
    await record('captcha', 'login succeeds when captcha disabled (no-op path)',
      'status=200', `status=${r.status}`,
      'info', r.status === 200);
  }

  // ── XSS payload survives admin pipeline as data ───────────────────────────
  {
    const payload = `x');fetch('https://x')//@xss-${runId}.bc`;
    const accessReqEmail = `privtest-xss-${runId}@privtest.local`;
    const reqRes = await makeClient(null).post('/api/request-access',
      { name: payload, email: accessReqEmail });
    const ok = reqRes.status === 200 || reqRes.status === 409;
    await record('xss', 'request-access accepts arbitrary name string',
      'status in {200,409}', `status=${reqRes.status}`,
      'info', ok);
    const list = await clients.admin.get('/api/admin/requests');
    const found = (list.json || []).find(r => r.email === accessReqEmail);
    const stored = found && found.name === payload;
    await record('xss', 'admin requests API returns the payload verbatim (must be HTML-escaped client-side)',
      `name === ${JSON.stringify(payload)}`,
      `found=${!!found} name=${JSON.stringify(found?.name || null)}`,
      'medium', stored,
      'Check public/admin.html escaping — this is data confirmation, not a render test.');
    await pool.query(`DELETE FROM account_requests WHERE email = $1`, [accessReqEmail]);
  }

  // ── Onboarding gate (`more_info_required`) ────────────────────────────────
  {
    const bcrypt = require('bcryptjs');
    const onbEmail = `privtest-onboarding-${runId}@privtest.local`;
    const hash = await bcrypt.hash(PASSWORD, 10);
    await pool.query(
      `INSERT INTO allowed_emails (email, note) VALUES ($1, 'privtest onboarding')
       ON CONFLICT (email) DO NOTHING`, [onbEmail]);
    await pool.query(
      `INSERT INTO users (email, first_name, last_name, password_hash,
                          privilege_level, onboarding_status)
       VALUES ($1, 'Onb', 'Test', $2, 'viewer', 'more_info_required')`,
      [onbEmail, hash]);
    const c = await login(onbEmail, PASSWORD);
    const r = await c.get('/api/deals');
    const ok = r.status === 403 && r.json?.code === 'ONBOARDING_REQUIRED';
    await record('onboarding', 'more_info_required user is blocked by onboarding gate',
      "403 + code 'ONBOARDING_REQUIRED'",
      `status=${r.status} code=${r.json?.code || 'n/a'}`,
      'high', ok);
    const me = await c.get('/api/auth/user');
    await record('onboarding', '/api/auth/user is still reachable during onboarding',
      'status=200', `status=${me.status}`,
      'medium', me.status === 200);
    await pool.query(`DELETE FROM users WHERE email = $1`, [onbEmail]);
    await pool.query(`DELETE FROM allowed_emails WHERE email = $1`, [onbEmail]);
  }

  // ── OAuth callback fixation (Google + QuickBooks) ─────────────────────────
  {
    const unauth = makeClient(null);
    const g = await unauth.get('/auth/google/callback?code=abc&state=xyz');
    await record('oauth', 'unauthenticated google callback rejected',
      '401 unauthorized', `status=${g.status}`,
      'high', g.status === 401);
    const q = await unauth.get('/auth/quickbooks/callback?code=abc&state=xyz&realmId=1');
    await record('oauth', 'unauthenticated quickbooks callback rejected',
      '401 unauthorized', `status=${q.status}`,
      'high', q.status === 401);
    const qNoAdmin = await clients.viewer.get('/auth/quickbooks/callback?code=abc&state=xyz&realmId=1');
    await record('oauth', 'non-admin quickbooks callback rejected',
      '403 forbidden', `status=${qNoAdmin.status}`,
      'critical', qNoAdmin.status === 403);
  }

  return findings;
}

module.exports = { runProbes };
