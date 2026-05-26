// Shared chrome: skip link, toast-live, access gate, header, bottom nav, invoice panel.
// Runs synchronously so chrome is in the DOM before bootstrap() looks for it.
//
// Shared UI helpers (window.UI from /components.js) are loaded via an explicit
// <script src="/components.js"> tag in every dashboard HTML page (placed right
// after chrome.js). Keeping it explicit per page — rather than document.write —
// avoids browser deferred-load suppression and keeps script ordering obvious.

/**
 * Returns a platform-aware keyboard shortcut string.
 * getShortcut('K') → '⌘K' on Mac / iOS, 'Ctrl K' everywhere else.
 */
window.getShortcut = function (key) {
  const platform = navigator.userAgentData?.platform ?? navigator.platform;
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? '\u2318' + key : 'Ctrl ' + key;
};

(function () {
  const path = location.pathname;

  // PAGE_TITLES is exposed on window so the React GlobalHeader (mounted into
  // #app-header-mount by /react/main.js) can resolve the current page name
  // without duplicating the map.
  window.PAGE_TITLES = {
    '/': 'Home', '/customers': 'Customers', '/sales': 'Sales',
    '/survey': 'Survey', '/projects': 'Projects', '/calendar': 'Calendar',
    '/invoices': 'Invoices',
    '/admin': 'Admin', '/profile': 'Profile',
  };


  const skipLink = `<a href="#main-content" class="skip-link">Skip to content</a>`;
  const toastLive = `<div id="toast-live" aria-live="polite" aria-atomic="true" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;"></div>`;

  const accessGate = `
    <div id="access-gate" class="access-gate" style="display:none;">
      <div class="access-card">
        <div class="access-brand" style="justify-content:center;">
          <span style="font-family:'Anton',sans-serif;font-size:1.35rem;letter-spacing:0.06em;text-transform:uppercase;color:#0f172a;">Measure Once</span>
        </div>
        <div id="access-sign-in-state">
          <h1 class="access-title">Request access</h1>
          <p class="access-sub">Enter your details below and we'll review your request.</p>
          <form id="access-request-form" onsubmit="handleAccessRequestSubmit(event)" novalidate>
            <input id="access-req-name" type="text" class="access-input" placeholder="Full name" autocomplete="name" required>
            <input id="access-req-email" type="email" class="access-input" placeholder="Email address" autocomplete="email" required>
            <div id="access-email-approved-msg" style="display:none;" class="access-email-approved-msg">
              Your account is already approved — <a href="/login">sign in to get started</a>.
            </div>
            <div id="access-req-submit-wrap">
              <button type="submit" id="access-req-btn" class="access-submit" style="width:100%;border:none;cursor:pointer;margin-top:0;">Request access</button>
            </div>
            <div id="access-req-error" style="display:none;" class="access-req-error"></div>
          </form>
          <div class="access-footer" style="margin-top:20px;text-align:center;">
            Already have access? <a href="/login">Sign in</a>
          </div>
        </div>
        <div id="access-confirmed-state" style="display:none;">
          <div class="access-confirmed-icon">✓</div>
          <h1 class="access-title">Request received</h1>
          <p class="access-sub">Your access request has been submitted. We'll review it and be in touch — you don't need to do anything else.</p>
          <div class="access-footer" style="margin-top:20px;">
            Already approved? <a href="/login">Sign in</a>
          </div>
        </div>
        <div id="access-email-conflict-state" style="display:none;">
          <div class="access-confirmed-icon" style="background:#fee2e2;color:#dc2626;">✕</div>
          <h1 class="access-title">Email already in use</h1>
          <p class="access-sub">This email address is already registered to a different account here. Please contact an admin if you think this is an error.</p>
          <div class="access-footer" style="margin-top:20px;">
            <a href="/login">Try a different account</a>
          </div>
        </div>
        <div id="access-pending-state" style="display:none;">
          <div class="access-confirmed-icon" style="background:#fef3c7;color:#d97706;">⏳</div>
          <h1 class="access-title">Request already under review</h1>
          <p class="access-sub">Your request is already under review — you'll hear back soon. You don't need to submit again.</p>
          <div class="access-footer" style="margin-top:20px;">
            Already approved? <a href="/login">Sign in</a>
          </div>
        </div>
        <div id="access-already-approved-state" style="display:none;">
          <div class="access-confirmed-icon" style="background:#dcfce7;color:#16a34a;">✓</div>
          <h1 class="access-title">Your account is already approved</h1>
          <p class="access-sub">Your account is already approved — sign in to get started.</p>
          <div class="access-footer" style="margin-top:20px;">
            <a href="/login" class="access-submit" style="display:block;text-align:center;text-decoration:none;">Sign in</a>
          </div>
        </div>
      </div>
    </div>`;

  // The top app bar is a React island (src/react/components/GlobalHeader.tsx)
  // mounted into #app-header-mount by /react/main.js. We still insert the
  // placeholder synchronously so the layout reserves space immediately.
  const header = `<div id="app-header-mount"></div>`;

  // Per-page heading panel is a React island
  // (src/react/components/PageHeadingPanel.tsx) mounted into
  // #page-heading-mount by /react/main.js. It resolves the title from
  // window.PAGE_TITLES, applies the same suppression rules (admin pages
  // and /customers/:id render their own heading), and exposes a stable
  // #page-heading-action slot for pages that need a header button
  // (e.g. Customers' "+ New customer"). The placeholder is inserted
  // synchronously so layout reserves space immediately.
  const pageHeading = `<div id="page-heading-mount"></div>`;

  // The bottom navigation is a React island
  // (src/react/components/BottomNav.tsx) mounted into
  // #app-bottom-nav-mount by /react/main.js. We insert the placeholder
  // synchronously on non-admin pages so the layout reserves space
  // immediately and the React island fills it when the bundle loads.
  const bottomNav = `<div id="app-bottom-nav-mount"></div>`;

  // The bottom action bar is a React island
  // (src/react/components/BottomActionBar.tsx) mounted into
  // #app-bottom-bar-mount by /react/main.js. It exposes
  // window.showBottomUndo / showBottomConfirm / showUnsavedChangesBar
  // as replacements for the former manual DOM manipulation in
  // workflow-core.js. The placeholder is inserted on every page so
  // the island is available wherever workflow-core.js runs.
  const bottomBar = `<div id="app-bottom-bar-mount"></div>`;

  const invoicePanel = `
    <div id="inv-overlay" class="inv-overlay hidden" onclick="closeInvoicePanel()"></div>
    <div id="inv-panel" class="inv-panel" aria-hidden="true">
      <div class="inv-panel-inner">
        <div class="inv-panel-header">
          <div>
            <h2 class="inv-panel-title" id="inv-panel-title">Invoice</h2>
            <p class="inv-panel-sub" id="inv-panel-sub"></p>
          </div>
          <button class="inv-panel-close" onclick="closeInvoicePanel()" title="Close">
            <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>
        <div id="inv-panel-body" class="inv-panel-body">
          <div class="inv-panel-loading"><div class="spinner"></div> Loading…</div>
        </div>
      </div>
    </div>`;

  const viewerBanner = `
    <div id="viewer-banner" class="viewer-banner" style="display:none;" role="status">
      <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true" style="flex-shrink:0;">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
      </svg>
      <span>Read-only access — you can view but not make changes. Contact an admin to request a higher access level.</span>
      <button onclick="dismissViewerBanner()" class="viewer-banner-close" aria-label="Dismiss read-only notice">
        <svg width="12" height="12" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
          <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/>
        </svg>
      </button>
    </div>`;

  const isAdminPage = path === '/admin' || path.startsWith('/admin/');
  document.body.insertAdjacentHTML('afterbegin', skipLink + toastLive + accessGate + header + viewerBanner + pageHeading);
  document.body.insertAdjacentHTML('beforeend', invoicePanel + (isAdminPage ? '' : bottomNav) + bottomBar);

  // Styles for the invoice panel.
  // These are injected here (rather than living in app-styles.css) so they
  // are co-located with the panel HTML above.  Pages that use the panel
  // (customers, customer-detail) all load chrome.js, so this
  // single injection covers every consumer.
  const invStyle = document.createElement('style');
  invStyle.textContent = `
.inv-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.35);
  z-index: var(--z-overlay); backdrop-filter: blur(2px);
}
.inv-overlay.hidden { display: none; }
.inv-panel {
  position: fixed; top: 0; right: 0; bottom: 0;
  width: 520px; max-width: 100vw;
  background: #fff; z-index: calc(var(--z-overlay) + 1);
  transform: translateX(100%);
  visibility: hidden;
  transition: transform 0.25s cubic-bezier(0.4,0,0.2,1),
              visibility 0s linear 0.25s;
  display: flex; flex-direction: column;
  box-shadow: -4px 0 32px rgba(0,0,0,0.12);
}
.inv-panel-open {
  transform: translateX(0) !important;
  visibility: visible !important;
  transition-delay: 0s !important;
}
.inv-panel-inner { display: flex; flex-direction: column; height: 100%; }
.inv-panel-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  padding: 20px 24px 16px; border-bottom: 1px solid var(--stone); flex-shrink: 0;
}
.inv-panel-title { font-size: 1.1rem; font-weight: 700; color: var(--ink-1); }
.inv-panel-sub   { font-size: 0.82rem; color: var(--ink-3); margin-top: 2px; }
.inv-nav-row     { display: flex; align-items: center; gap: 6px; }
.inv-nav-label   { font-size: 1.1rem; font-weight: 700; color: var(--ink-1); }
.inv-nav-docnum  { display: block; font-size: 0.82rem; color: var(--ink-3); margin-top: 2px; font-weight: 400; }
.inv-nav-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border-radius: 5px; border: 1px solid var(--stone);
  background: var(--surface); color: var(--ink-2); cursor: pointer;
  font-size: 0.9rem; line-height: 1; padding: 0; transition: background 0.15s;
}
.inv-nav-btn:hover:not(:disabled) { background: var(--stone); color: var(--ink-1); }
.inv-nav-btn:disabled { opacity: 0.35; cursor: default; }
.inv-jump-dropdown {
  position: relative; display: inline-block; margin-top: 6px; max-width: 100%;
}
.inv-jump-trigger {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 0.78rem; color: var(--ink-2); background: var(--surface);
  border: 1px solid var(--stone); border-radius: 5px;
  padding: 3px 7px; cursor: pointer; max-width: 100%;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  font-family: inherit; transition: border-color 0.15s;
}
.inv-jump-trigger:hover { border-color: var(--accent); }
.inv-jump-trigger:focus { outline: none; border-color: var(--accent); }
.inv-jump-caret { font-size: 0.65rem; color: var(--ink-3); flex-shrink: 0; }
.inv-jump-list {
  display: none; position: absolute; top: calc(100% + 4px); left: 0;
  min-width: 100%; max-height: 220px; overflow-y: auto;
  background: var(--surface); border: 1px solid var(--stone);
  border-radius: 6px; box-shadow: 0 4px 16px rgba(0,0,0,0.12);
  list-style: none; margin: 0; padding: 4px 0; z-index: var(--z-panel);
}
.inv-jump-dropdown--open .inv-jump-list { display: block; }
.inv-jump-item {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 10px; font-size: 0.78rem; color: var(--ink-2);
  cursor: pointer; white-space: nowrap;
}
.inv-jump-item:hover { background: var(--paper-deep); color: var(--ink-1); }
.inv-jump-item--active { background: var(--paper-deep); color: var(--ink-1); font-weight: 600; }
.inv-jump-item-label { overflow: hidden; text-overflow: ellipsis; }
.inv-panel-close {
  padding: 4px; border: none; background: none; cursor: pointer;
  color: var(--ink-3); border-radius: 6px; transition: background 0.15s;
  flex-shrink: 0; margin-top: 2px;
}
.inv-panel-close:hover { background: var(--paper-deep); color: var(--ink-1); }
.inv-panel-body { flex: 1; overflow-y: auto; padding: 0 0 40px; }
.inv-panel-loading { display: flex; align-items: center; gap: 10px; padding: 40px 24px; color: var(--ink-3); font-size: 0.875rem; }
.inv-panel-error { padding: 24px; color: #dc2626; font-size: 0.875rem; }
.inv-section {
  padding: 18px 24px;
  border-bottom: 1px solid var(--stone);
}
.inv-section:last-child { border-bottom: none; }
.inv-section-title {
  font-size: 0.78rem; font-weight: 700; color: var(--ink-3);
  text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px;
}
.inv-meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.inv-meta-item { display: flex; flex-direction: column; gap: 3px; }
.inv-meta-label { font-size: 0.72rem; font-weight: 600; color: var(--ink-3); text-transform: uppercase; letter-spacing: 0.04em; }
.inv-meta-val   { font-size: 0.9rem; font-weight: 600; color: var(--ink-1); }
.inv-balance    { font-size: 1.1rem; font-weight: 800; color: var(--ink-1); }
.inv-lines-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
.inv-lines-table thead th {
  text-align: left; font-weight: 600; color: var(--ink-3);
  border-bottom: 1px solid var(--stone); padding: 0 6px 8px;
  font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em;
}
.inv-lines-table tbody tr:not(:last-child) td { border-bottom: 1px solid var(--stone); }
.inv-lines-table td { padding: 8px 6px; color: var(--ink-2); vertical-align: top; }
.inv-lines-table tfoot .inv-total-row td { border-top: 2px solid var(--stone); padding-top: 10px; }
.inv-line-desc { width: 55%; }
.inv-line-num  { width: 15%; text-align: right; }
.inv-line-amount { font-weight: 700; color: var(--ink-1); }
.inv-edit-grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px;
}
.inv-edit-label { display: flex; flex-direction: column; gap: 5px; font-size: 0.78rem; font-weight: 600; color: var(--ink-2); }
.inv-edit-input {
  border: 1px solid var(--stone); border-radius: var(--radius-md);
  padding: 8px 10px; font-size: 0.85rem; font-family: inherit;
  background: #fff; color: var(--ink-1); transition: border-color 0.15s;
  width: 100%;
}
.inv-edit-input:focus { outline: none; border-color: var(--plum); }
.inv-edit-input--dirty { border-color: var(--plum); background: #fdf7ff; box-shadow: inset 2px 0 0 var(--plum); }
.inv-edit-input--dirty:focus { border-color: var(--plum); }
.inv-edit-textarea { resize: vertical; min-height: 60px; }
.inv-actions-btns { display: flex; gap: 8px; flex-wrap: wrap; }
.inv-btn {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: .88rem; font-weight: 600; font-family: inherit;
  padding: 8px 16px; border-radius: var(--radius-md);
  cursor: pointer; transition: background 0.15s, opacity 0.15s; border: none; white-space: nowrap;
  text-decoration: none;
}
.inv-btn-primary { background: var(--plum); color: #fff; }
.inv-btn-primary:hover { background: #3a0a6e; }
.inv-btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }
.inv-btn-secondary {
  background: var(--paper); color: var(--ink-1);
  border: 1px solid var(--stone);
}
.inv-btn-secondary:hover { background: var(--paper-deep); }
.inv-btn-secondary:disabled { opacity: 0.6; cursor: not-allowed; }
.inv-action-msg { font-size: 0.78rem; margin-left: 4px; }
.inv-msg-ok  { color: #16a34a; }
.inv-msg-err { color: #dc2626; }
`;
  document.head.appendChild(invStyle);

  // Active-state sync + auto-scroll-into-view are handled by the React
  // BottomNav island; see src/react/components/BottomNav.tsx.
})();

// ── Access request form ───────────────────────────────────────────────────────
// The on-blur email preflight against /api/check-email has been removed.
// That endpoint no longer discloses approval status (it always returns false)
// to prevent unauthenticated email-address enumeration. The POST /api/request-access
// 409 response is the authoritative already-approved signal and is handled below.

async function handleAccessRequestSubmit(e) {
  e.preventDefault();

  const name    = (document.getElementById('access-req-name')?.value  || '').trim();
  const email   = (document.getElementById('access-req-email')?.value || '').trim().toLowerCase();
  const errEl   = document.getElementById('access-req-error');
  const btn     = document.getElementById('access-req-btn');
  const signInEl    = document.getElementById('access-sign-in-state');
  const confirmedEl = document.getElementById('access-confirmed-state');

  if (!name || !email) {
    if (errEl) { errEl.textContent = 'Please enter your name and email address.'; errEl.style.display = ''; }
    return;
  }
  if (errEl) errEl.style.display = 'none';
  if (btn)   { btn.disabled = true; btn.textContent = 'Sending…'; }

  try {
    const r = await fetch('/api/request-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ name, email }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.ok) {
      if (signInEl)    signInEl.style.display    = 'none';
      if (confirmedEl) confirmedEl.style.display = '';
    } else if (r.status === 429) {
      if (errEl) { errEl.textContent = 'Too many requests — please try again later.'; errEl.style.display = ''; }
      if (btn)   { btn.disabled = false; btn.textContent = 'Request access'; }
    } else {
      if (errEl) { errEl.textContent = data.error || 'Could not submit request. Please try again.'; errEl.style.display = ''; }
      if (btn)   { btn.disabled = false; btn.textContent = 'Request access'; }
    }
  } catch {
    if (errEl) { errEl.textContent = 'Network error — please check your connection and try again.'; errEl.style.display = ''; }
    if (btn)   { btn.disabled = false; btn.textContent = 'Request access'; }
  }
}
