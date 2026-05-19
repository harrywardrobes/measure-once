async function renderProfileTab() {
  const el = document.getElementById('profile-view');
  if (!el) return;
  el.innerHTML = `<div class="profile-loading"><div class="spinner"></div> Loading…</div>`;

  const user = state.user;
  if (!user) { el.innerHTML = ''; return; }

  let profile;
  try {
    profile = await GET(`/api/users/${encodeURIComponent(user.id)}/profile`);
  } catch (e) {
    el.innerHTML = `<div class="profile-loading" style="color:#b91c1c;">Failed to load profile. <button onclick="renderProfileTab()" style="color:var(--orchid);background:none;border:none;cursor:pointer;font-size:0.875rem;font-weight:600;padding:0;font-family:inherit;">Retry</button></div>`;
    return;
  }

  const { google, hubspot } = state.authStatus;
  const fullName = [profile.first_name, profile.last_name].filter(Boolean).join(' ') || profile.email || 'User';
  const initials = [profile.first_name, profile.last_name]
    .filter(Boolean).map(s => s[0]).join('').toUpperCase() || '?';
  const levelLabels = { viewer: 'Viewer', member: 'Member', manager: 'Manager', admin: 'Admin' };
  const levelLabel  = levelLabels[profile.privilege_level] || 'Member';
  const isAdmin = user.isAdmin;

  el.innerHTML = `
    <!-- Back button -->
    <button class="profile-back-btn" onclick="history.length > 1 ? history.back() : (location.href = '/')">
      <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" class="flex-shrink-0">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M15 19l-7-7 7-7"/>
      </svg>
      Back
    </button>

    <!-- Identity card -->
    <div class="profile-card">
      <div class="profile-identity">
        ${profile.profile_image_url
          ? `<img src="${escHtml(profile.profile_image_url)}" alt="" class="profile-avatar-img">`
          : `<div class="profile-avatar-placeholder">${escHtml(initials)}</div>`}
        <div class="profile-identity-info">
          <div class="profile-name">${escHtml(fullName)}</div>
          <div class="profile-email">${escHtml(profile.email || '')}</div>
        </div>
      </div>
    </div>

    <!-- Role & Permissions card — read-only, managed via admin panel -->
    <div class="profile-card">
      <div class="profile-card-header">
        <span class="profile-section-title">Role &amp; Permissions</span>
      </div>
      <div class="profile-field">
        <span class="profile-field-label">Job role</span>
        <span class="profile-field-value">${escHtml(profile.job_role || '—')}</span>
      </div>
      <div class="profile-field">
        <span class="profile-field-label">Privilege level</span>
        <span class="profile-level-badge profile-level-${escHtml(profile.privilege_level || 'member')}">${escHtml(levelLabel)}</span>
      </div>
    </div>

    <!-- Integrations card -->
    <div class="profile-card">
      <div class="profile-card-header">
        <span class="profile-section-title">Integrations</span>
      </div>
      <div class="profile-integration-row">
        <span class="profile-int-label">
          <span class="auth-dot ${hubspot ? 'auth-dot-ok' : 'auth-dot-off'}"></span>
          HubSpot
        </span>
        <span class="profile-int-status">${hubspot ? 'Connected' : 'Not configured'}</span>
      </div>
      <div class="profile-integration-row">
        <span class="profile-int-label">
          <span class="auth-dot ${google ? 'auth-dot-ok' : 'auth-dot-off'}"></span>
          Google
        </span>
        ${google
          ? `<button class="profile-int-action" onclick="profileLogoutGoogle()">Disconnect</button>`
          : `<a href="/auth/google" class="profile-int-action profile-int-connect">Connect</a>`}
      </div>
    </div>

    <!-- Account actions card -->
    <div class="profile-card">
      ${isAdmin ? `<a href="/admin.html" class="profile-action-row profile-action-admin">
        <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" class="flex-shrink-0">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
        </svg>
        Admin panel
      </a>` : ''}
      <a href="/api/logout" class="profile-action-row profile-action-signout">
        <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" class="flex-shrink-0">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
        </svg>
        Sign out
      </a>
    </div>
  `;
}


async function profileLogoutGoogle() {
  await GET('/auth/logout-google');
  state.authStatus.google = false;
  renderProfileTab();
}

async function logoutGoogle() {
  await GET('/auth/logout-google');
  state.authStatus.google = false;
  renderAuthStatus();
}

