// Shared chrome: skip link, toast-live, access gate, header, bottom nav, invoice panel.
// Runs synchronously so chrome is in the DOM before bootstrap() looks for it.
(function () {
  const path = location.pathname;

  const NAV = [
    { key: 'home',     href: '/',         label: 'Home',
      svg: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
    { key: 'sales',    href: '/sales',    label: 'Sales',
      svg: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z' },
    { key: 'projects', href: '/projects', label: 'Projects',
      svg: 'M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2' },
    { key: 'calendar', href: '/calendar', label: 'Calendar',
      svg: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4' },
    { key: 'invoices', href: '/invoices', label: 'Invoices',
      svg: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
    { key: 'trades',   href: '/trades',   label: 'Trades',   managerOnly: true,
      svg: 'M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z' },
  ];

  const skipLink = `<a href="#main-content" class="skip-link">Skip to content</a>`;
  const toastLive = `<div id="toast-live" aria-live="polite" aria-atomic="true" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;"></div>`;

  const accessGate = `
    <div id="access-gate" class="access-gate" style="display:none;">
      <div class="access-card">
        <div class="access-brand">
          <img src="/assets/logo-mark-paper.png" alt="" width="32" height="32" style="height:32px;width:auto;">
          <span style="font-family:'Anton',sans-serif;font-size:1.05rem;letter-spacing:0.04em;text-transform:uppercase;color:#0f172a;">Measure Once</span>
        </div>
        <div id="access-sign-in-state">
          <h1 class="access-title">Sign in to continue</h1>
          <p class="access-sub">This dashboard is invite-only. Sign in with your Replit account to request access.</p>
          <a href="/api/login" class="access-submit" style="display:block;text-align:center;text-decoration:none;margin-top:8px;">Sign in with Replit</a>
        </div>
        <div id="access-confirmed-state" style="display:none;">
          <div class="access-confirmed-icon">✓</div>
          <h1 class="access-title">Request received</h1>
          <p class="access-sub">Your access request has been submitted. We'll review it and be in touch — you don't need to do anything else.</p>
          <div class="access-footer" style="margin-top:20px;">
            Already approved? <a href="/api/login">Sign in</a>
          </div>
        </div>
        <div id="access-email-conflict-state" style="display:none;">
          <div class="access-confirmed-icon" style="background:#fee2e2;color:#dc2626;">✕</div>
          <h1 class="access-title">Email already in use</h1>
          <p class="access-sub">The email address on your Replit account is already registered to a different account here. Please contact an admin if you think this is an error.</p>
          <div class="access-footer" style="margin-top:20px;">
            <a href="/api/login">Try a different account</a>
          </div>
        </div>
        <div id="access-pending-state" style="display:none;">
          <div class="access-confirmed-icon" style="background:#fef3c7;color:#d97706;">⏳</div>
          <h1 class="access-title">Request already under review</h1>
          <p class="access-sub">Your request is already under review — you'll hear back soon. You don't need to submit again.</p>
          <div class="access-footer" style="margin-top:20px;">
            Already approved? <a href="/api/login">Sign in</a>
          </div>
        </div>
        <div id="access-already-approved-state" style="display:none;">
          <div class="access-confirmed-icon" style="background:#dcfce7;color:#16a34a;">✓</div>
          <h1 class="access-title">Your account is already approved</h1>
          <p class="access-sub">Your account is already approved — sign in to get started.</p>
          <div class="access-footer" style="margin-top:20px;">
            <a href="/api/login" class="access-submit" style="display:block;text-align:center;text-decoration:none;">Sign in with Replit</a>
          </div>
        </div>
      </div>
    </div>`;

  const backBtn = path !== '/' ? `
    <button onclick="history.length > 1 ? history.back() : location.href = '/'" class="header-back-btn" aria-label="Go back" title="Back">
      <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M15 19l-7-7 7-7"/>
      </svg>
    </button>` : '';

  const header = `
    <header class="app-header">
      ${backBtn}
      <a href="/" class="flex-shrink-0" style="background:none;border:none;padding:0;cursor:pointer;display:flex;align-items:center;" title="Home" aria-label="Go to home">
        <img src="/assets/logo-mark-paper.png" alt="Harry Wardrobes" width="26" height="26" style="height:26px;width:auto;">
      </a>
      <div class="header-search-wrap">
        <svg class="header-search-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M21 21l-4.35-4.35M17 11A6 6 0 105 11a6 6 0 0012 0z"/>
        </svg>
        <input id="search" type="text" placeholder="Search customers…"
          oninput="onHeaderSearch(this.value)"
          onkeydown="if(event.key==='Enter')onHeaderSearchSubmit(this.value)"
          class="header-search-input" autocomplete="off" autocorrect="off" spellcheck="false">
        <button id="search-clear" class="header-search-clear hidden" onclick="clearHeaderSearch()">
          <svg width="12" height="12" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
        </button>
      </div>
      <div class="flex items-center gap-2 flex-shrink-0">
        <a href="/customers" class="header-icon-btn" title="Customers" aria-label="Customers">
          <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/>
          </svg>
        </a>
        <button onclick="onHeaderPlusBtn()" title="New Customer" aria-label="New Customer" class="header-icon-btn">
          <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 4v16m8-8H4"/>
          </svg>
        </button>
        <div id="auth-status" class="flex items-center gap-1.5"></div>
      </div>
    </header>`;

  const bottomNav = `
    <nav class="bottom-nav" id="main-content">
      ${NAV.map(n => {
        const active = n.href === path ? ' bottom-nav-active' : '';
        const hidden = (n.managerOnly || n.adminOnly) ? ' style="display:none"' : '';
        return `<a class="bottom-nav-btn${active}" id="bnav-${n.key}" href="${n.href}" aria-label="${n.label}"${hidden}>
          <svg width="22" height="22" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${n.svg}"/>
          </svg>
          <span aria-hidden="true">${n.label}</span>
        </a>`;
      }).join('')}
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

  document.body.insertAdjacentHTML('afterbegin', skipLink + toastLive + accessGate + header + viewerBanner);
  document.body.insertAdjacentHTML('beforeend', invoicePanel + bottomNav);
})();
