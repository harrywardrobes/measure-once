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

    <!-- Personal info card -->
    <div class="profile-card">
      <div class="profile-card-header">
        <span class="profile-section-title">Role &amp; Permissions</span>
        ${isAdmin
          ? `<button class="profile-edit-btn" id="prof-edit-btn" onclick="toggleProfileEdit()">Edit</button>`
          : ''}
      </div>

      <!-- Read view -->
      <div id="prof-read-view">
        <div class="profile-field">
          <span class="profile-field-label">Job role</span>
          <span class="profile-field-value">${escHtml(profile.job_role || '—')}</span>
        </div>
      </div>

      <!-- Edit view (admins only, hidden by default) -->
      <div id="prof-edit-view" style="display:none;">
        <div class="profile-field profile-field-col">
          <label class="profile-field-label" for="prof-job-role">Job role</label>
          <input id="prof-job-role" type="text" class="profile-input" value="${escHtml(profile.job_role || '')}" placeholder="e.g. Site Manager">
        </div>
        <div id="prof-edit-error" style="display:none;" class="profile-error"></div>
        <div class="profile-edit-actions">
          <button class="profile-save-btn" onclick="saveProfileEdit('${escHtml(user.id)}')">Save</button>
          <button class="profile-cancel-btn" onclick="toggleProfileEdit(false)">Cancel</button>
        </div>
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

function toggleProfileEdit(forceOpen) {
  const readEl  = document.getElementById('prof-read-view');
  const editEl  = document.getElementById('prof-edit-view');
  const editBtn = document.getElementById('prof-edit-btn');
  const errEl   = document.getElementById('prof-edit-error');
  if (!readEl || !editEl) return;
  const opening = forceOpen !== undefined ? forceOpen : (editEl.style.display === 'none');
  readEl.style.display  = opening ? 'none' : '';
  editEl.style.display  = opening ? ''     : 'none';
  if (editBtn) editBtn.textContent = opening ? 'Cancel' : 'Edit';
  if (errEl)   { errEl.style.display = 'none'; errEl.textContent = ''; }
}

async function saveProfileEdit(userId) {
  const jobRoleEl = document.getElementById('prof-job-role');
  const errEl     = document.getElementById('prof-edit-error');
  if (!jobRoleEl) return;
  const jobRole = jobRoleEl.value.trim();
  const saveBtn = document.querySelector('.profile-save-btn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
  if (errEl)   { errEl.style.display = 'none'; errEl.textContent = ''; }
  try {
    await PATCH_REQ(`/api/users/${encodeURIComponent(userId)}/profile`, { job_role: jobRole });
    showToast('Profile updated');
    renderProfileTab();
  } catch (e) {
    if (errEl) { errEl.textContent = e.message || 'Failed to save'; errEl.style.display = 'block'; }
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
  }
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

