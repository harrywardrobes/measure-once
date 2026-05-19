let _pendingPhotoData = null;

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

  const photoSrc = profile.has_custom_photo
    ? `/api/users/${encodeURIComponent(profile.id)}/photo`
    : (profile.profile_image_url || null);

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
        <div class="profile-avatar-wrap">
          ${photoSrc
            ? `<img src="${escHtml(photoSrc)}" alt="" class="profile-avatar-img">`
            : `<div class="profile-avatar-placeholder">${escHtml(initials)}</div>`}
          ${!profile.has_pending_photo
            ? `<button class="profile-avatar-change-btn" onclick="openPhotoUpload()" title="${profile.has_custom_photo ? 'Change photo' : 'Upload photo'}">
                 <svg width="11" height="11" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                   <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/>
                   <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"/>
                 </svg>
               </button>`
            : ''}
        </div>
        <div class="profile-identity-info">
          <div class="profile-name">${escHtml(fullName)}</div>
          <div class="profile-email">${escHtml(profile.email || '')}</div>
          ${profile.has_pending_photo
            ? `<span class="photo-pending-badge">Photo awaiting approval</span>`
            : !photoSrc
              ? `<span class="photo-upload-prompt">Upload a professional photo with a plain background</span>`
              : ''}
        </div>
      </div>

      <input type="file" id="photo-file-input" accept="image/jpeg,image/png,image/webp" style="display:none;" onchange="handlePhotoFile(this)">

      <div id="photo-preview-wrap" class="photo-preview-section" style="display:none;">
        <img id="photo-preview-img" class="photo-preview-img" alt="Preview">
        <div class="profile-edit-actions">
          <button class="profile-save-btn" onclick="submitProfilePhoto()">Submit for approval</button>
          <button class="profile-cancel-btn" onclick="cancelPhotoUpload()">Cancel</button>
        </div>
      </div>
      <div id="photo-upload-msg" class="profile-error" style="display:none;"></div>
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


function openPhotoUpload() {
  document.getElementById('photo-file-input')?.click();
}

function handlePhotoFile(input) {
  const file = input.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    const msg = document.getElementById('photo-upload-msg');
    if (msg) { msg.textContent = 'Please select an image file (JPEG, PNG, or WebP).'; msg.style.display = ''; }
    return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      const MAX = 600;
      let w = img.width, h = img.height;
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
        else       { w = Math.round(w * MAX / h); h = MAX; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      _pendingPhotoData = canvas.toDataURL('image/jpeg', 0.85);
      const previewImg  = document.getElementById('photo-preview-img');
      const previewWrap = document.getElementById('photo-preview-wrap');
      if (previewImg)  previewImg.src           = _pendingPhotoData;
      if (previewWrap) previewWrap.style.display = '';
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function cancelPhotoUpload() {
  _pendingPhotoData = null;
  const previewWrap = document.getElementById('photo-preview-wrap');
  const fileInput   = document.getElementById('photo-file-input');
  if (previewWrap) previewWrap.style.display = 'none';
  if (fileInput)   fileInput.value = '';
}

async function submitProfilePhoto() {
  if (!_pendingPhotoData) return;
  const msgEl   = document.getElementById('photo-upload-msg');
  const saveBtn = document.querySelector('#photo-preview-wrap .profile-save-btn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Uploading…'; }
  if (msgEl)   { msgEl.style.display = 'none'; msgEl.textContent = ''; }
  try {
    const r    = await fetch('/api/users/me/photo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: _pendingPhotoData }),
    });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || 'Upload failed');
    _pendingPhotoData = null;
    showToast('Photo submitted for approval');
    renderProfileTab();
  } catch (e) {
    if (msgEl)   { msgEl.textContent = e.message; msgEl.style.display = ''; }
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Submit for approval'; }
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
