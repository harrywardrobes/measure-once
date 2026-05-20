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

  const hubspotLabel = 'Checking…';
  const hubspotBadgeStyle = 'background:#f3f4f6;color:#6b7280;';
  const fullName = [profile.first_name, profile.last_name].filter(Boolean).join(' ') || profile.email || 'User';
  const initials = [profile.first_name, profile.last_name]
    .filter(Boolean).map(s => s[0]).join('').toUpperCase() || '?';
  // Gate the Admin panel link on the actual privilege_level, not on
  // `user.isAdmin` alone — bootstrap ADMIN_EMAILS membership must not show
  // admin affordances to a downgraded account.
  const isAdmin = (user.privilege_level === 'admin');

  let photoSrc = profile.has_custom_photo
    ? `/api/users/${encodeURIComponent(profile.id)}/photo`
    : (profile.profile_image_url || null);
  if (photoSrc && user.photo_v && profile.id === user.id) {
    photoSrc += (photoSrc.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(user.photo_v);
  }

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
    </div>

    <!-- Integrations card -->
    <div class="profile-card">
      <div class="profile-card-header">
        <span class="profile-section-title">Integrations</span>
      </div>
      <div class="profile-integration-row">
        <span class="profile-int-label">
          <span id="hubspot-status-dot" class="auth-dot auth-dot-pending"></span>
          HubSpot
        </span>
        <span id="hubspot-status-badge" style="font-size:.72rem;font-weight:600;padding:3px 10px;border-radius:999px;${hubspotBadgeStyle}">${hubspotLabel}</span>
      </div>
      <div class="profile-integration-row">
        <span class="profile-int-label">
          <span id="google-status-dot" class="auth-dot auth-dot-pending"></span>
          Google
        </span>
        <span id="google-status-badge" style="font-size:.72rem;font-weight:600;padding:3px 10px;border-radius:999px;background:#f3f4f6;color:#6b7280;">Checking…</span>
      </div>
    </div>

    <!-- Change password card -->
    <div class="profile-card">
      <div class="profile-card-header">
        <span class="profile-section-title">Change password</span>
      </div>
      <form id="change-pw-form" autocomplete="off" style="display:flex;flex-direction:column;gap:12px;">
        <div>
          <label for="cp-current" style="display:block;font-size:.82rem;color:#374151;margin-bottom:6px;font-weight:500;">Current password</label>
          <input id="cp-current" type="password" required autocomplete="current-password"
                 style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d6d3d1;border-radius:8px;font-size:.95rem;background:#fff;">
        </div>
        <div>
          <label for="cp-new" style="display:block;font-size:.82rem;color:#374151;margin-bottom:6px;font-weight:500;">New password</label>
          <input id="cp-new" type="password" minlength="8" required autocomplete="new-password"
                 style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d6d3d1;border-radius:8px;font-size:.95rem;background:#fff;">
          <div style="font-size:.78rem;color:#78716c;margin-top:4px;">At least 8 characters, with letters and numbers.</div>
          <div id="cp-meter-mount"></div>
        </div>
        <div>
          <label for="cp-confirm" style="display:block;font-size:.82rem;color:#374151;margin-bottom:6px;font-weight:500;">Confirm new password</label>
          <input id="cp-confirm" type="password" minlength="8" required autocomplete="new-password"
                 style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d6d3d1;border-radius:8px;font-size:.95rem;background:#fff;">
        </div>
        <div id="cp-msg" class="profile-error" style="display:none;"></div>
        <div>
          <button id="cp-submit" type="submit" class="profile-save-btn">Update password</button>
        </div>
        <p style="font-size:.78rem;color:#78716c;margin:0;">You'll be signed out of any other devices.</p>
      </form>
    </div>

    <!-- Account actions card -->
    <div class="profile-card">
      ${isAdmin ? `<a href="/admin" class="profile-action-row profile-action-admin">
        <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" class="flex-shrink-0">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
        </svg>
        Admin panel
      </a>` : ''}
      <button onclick="signOut()" class="profile-action-row profile-action-signout" style="background:none;border:none;width:100%;text-align:left;cursor:pointer;font-family:inherit;font-size:inherit;padding:0;">
        <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" class="flex-shrink-0">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
        </svg>
        Sign out
      </button>
    </div>
  `;

  mountChangePasswordForm(profile);

  GET('/api/hubspot/status').catch(() => ({ connected: false, code: 'HUBSPOT_ERROR' })).then(hubspotStatus => {
    const dot = document.getElementById('hubspot-status-dot');
    const badge = document.getElementById('hubspot-status-badge');
    if (!dot || !badge) return;
    const connected = hubspotStatus?.connected ?? false;
    const label = connected ? 'Connected' : (hubspotStatus?.code === 'NO_TOKEN' ? 'No token set' : 'Not connected');
    const style = connected ? 'background:#dcfce7;color:#166534;' : 'background:#fee2e2;color:#991b1b;';
    dot.className = `auth-dot ${connected ? 'auth-dot-ok' : 'auth-dot-off'}`;
    badge.style.cssText = `font-size:.72rem;font-weight:600;padding:3px 10px;border-radius:999px;${style}`;
    badge.textContent = label;
  });

  GET('/api/google/status').then(data => {
    const dot = document.getElementById('google-status-dot');
    const badge = document.getElementById('google-status-badge');
    if (!dot || !badge) return;
    const googleConnected = data?.connected === true;
    dot.className = `auth-dot ${googleConnected ? 'auth-dot-ok' : 'auth-dot-off'}`;
    if (googleConnected) {
      badge.outerHTML = `<button class="profile-int-action" onclick="profileLogoutGoogle()">Disconnect</button>`;
    } else {
      badge.outerHTML = `<a href="/auth/google" class="profile-int-action profile-int-connect">Connect</a>`;
    }
  }).catch(() => {
    const dot = document.getElementById('google-status-dot');
    const badge = document.getElementById('google-status-badge');
    if (!dot || !badge) return;
    dot.className = 'auth-dot auth-dot-off';
    badge.outerHTML = `<a href="/auth/google" class="profile-int-action profile-int-connect">Connect</a>`;
  });
}


function mountChangePasswordForm(profile) {
  const form    = document.getElementById('change-pw-form');
  const curEl   = document.getElementById('cp-current');
  const newEl   = document.getElementById('cp-new');
  const confEl  = document.getElementById('cp-confirm');
  const msgEl   = document.getElementById('cp-msg');
  const btn     = document.getElementById('cp-submit');
  const mount   = document.getElementById('cp-meter-mount');
  if (!form || !curEl || !newEl || !confEl || !btn) return;

  const userInputs = () => {
    const email = (profile.email || '').toLowerCase();
    const local = email.split('@')[0] || '';
    return [email, local, profile.first_name || '', profile.last_name || '',
            'measure once', 'measureonce'].filter(Boolean);
  };

  if (window.PasswordStrength && mount) {
    PasswordStrength.mountStrengthMeter(newEl, mount, userInputs);
  }

  const showMsg = (text, isError = true) => {
    if (!msgEl) return;
    msgEl.textContent = text;
    msgEl.style.display = '';
    msgEl.style.color = isError ? '#b91c1c' : '#166534';
  };
  const clearMsg = () => { if (msgEl) { msgEl.textContent = ''; msgEl.style.display = 'none'; } };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearMsg();
    const current = curEl.value;
    const next    = newEl.value;
    const confirm = confEl.value;
    if (!current || !next) return showMsg('Enter your current and new password.');
    if (next !== confirm) return showMsg('New passwords do not match.');
    if (current === next) return showMsg('New password must be different from your current password.');
    if (window.PasswordStrength) {
      const policyErr = PasswordStrength.checkPasswordPolicy(next, userInputs());
      if (policyErr) return showMsg(policyErr);
    }
    btn.disabled = true;
    const origLabel = btn.textContent;
    btn.textContent = 'Updating…';
    try {
      const data = await POST('/api/change-password', {
        currentPassword: current,
        newPassword: next,
      });
      curEl.value = ''; newEl.value = ''; confEl.value = '';
      if (typeof PasswordStrength !== 'undefined') {
        newEl.dispatchEvent(new Event('input'));
      }
      const cleared = data?.otherSessionsCleared || 0;
      const note = cleared > 0
        ? `Password updated. Signed out of ${cleared} other session${cleared === 1 ? '' : 's'}.`
        : 'Password updated.';
      if (typeof showToast === 'function') showToast(note);
      showMsg(note, false);
    } catch (err) {
      showMsg(err?.message || 'Could not change password.');
    } finally {
      btn.disabled = false;
      btn.textContent = origLabel;
    }
  });
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

function signOut() {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/api/logout';
  document.body.appendChild(form);
  form.submit();
}

async function profileLogoutGoogle() {
  await POST('/auth/logout-google');
  state.authStatus.google = false;
  renderProfileTab();
}

async function logoutGoogle() {
  await POST('/auth/logout-google');
  state.authStatus.google = false;
  renderAuthStatus();
}
