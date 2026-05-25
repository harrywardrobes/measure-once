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
    '/invoices': 'Invoices', '/trades': 'Trades', '/ideas': 'Ideas',
    '/admin': 'Admin', '/profile': 'Profile',
  };

  const NAV = [
    { key: 'home',     href: '/',         label: 'Home',
      svg: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
    { key: 'sales',    href: '/sales',    label: 'Sales',    managerOnly: true,
      svg: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z' },
    { key: 'survey',   href: '/survey',   label: 'Survey',   managerOnly: true,
      svg: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01' },
    { key: 'projects', href: '/projects', label: 'Projects', managerOnly: true,
      svg: 'M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2' },
    { key: 'calendar', href: '/calendar', label: 'Calendar',
      svg: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4' },
    { key: 'invoices', href: '/invoices', label: 'Invoices', managerOnly: true,
      svg: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
    { key: 'trades',   href: '/trades',   label: 'Trades',
      svg: 'M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z' },
    { key: 'ideas',    href: '/ideas',    label: 'Ideas',
      svg: 'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z' },
  ];

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

  const bottomNav = `
    <nav class="bottom-nav" id="main-content">
      <div class="bottom-nav-inner">
        ${NAV.map(n => {
          const active = n.href === path ? ' bottom-nav-active' : '';
          const hidden = (n.managerOnly || n.adminOnly) ? ' style="display:none"' : '';
          return `<a class="bottom-nav-btn${active}" id="bnav-${n.key}" href="${n.href}" aria-label="${n.label}"${hidden}>${n.label}</a>`;
        }).join('')}
      </div>
    </nav>`;

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
  document.body.insertAdjacentHTML('beforeend', invoicePanel + (isAdminPage ? '' : bottomNav));

  function scrollActiveNavIntoView(behavior) {
    const btn = document.querySelector('.bottom-nav-active');
    if (btn) btn.scrollIntoView({ inline: 'center', block: 'nearest', behavior: behavior || 'instant' });
  }

  function syncActiveNav(behavior) {
    const currentPath = location.pathname;
    const buttons = document.querySelectorAll('.bottom-nav-btn');
    if (!buttons.length) return;
    let changed = false;
    buttons.forEach(btn => {
      const href = btn.getAttribute('href');
      const wasActive = btn.classList.contains('bottom-nav-active');
      const isActive = href === currentPath;
      if (isActive !== wasActive) {
        btn.classList.toggle('bottom-nav-active', isActive);
        changed = true;
      }
    });
    if (changed) scrollActiveNavIntoView(behavior);
  }

  scrollActiveNavIntoView('instant');

  window.addEventListener('popstate', () => syncActiveNav('smooth'));
  window.addEventListener('hashchange', () => syncActiveNav('smooth'));
  window.addEventListener('mo:navigation', () => syncActiveNav('smooth'));
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
