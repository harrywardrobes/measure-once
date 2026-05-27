// Shared chrome: skip link, toast-live, access gate, header, bottom nav, invoice panel.
// Runs synchronously so chrome is in the DOM before bootstrap() looks for it.

// dismissViewerBanner is defined here because the viewer banner HTML is built
// in this file and onclick="dismissViewerBanner()" must resolve on every page
// that loads chrome.js.
window.dismissViewerBanner = function dismissViewerBanner() {
  const banner = document.getElementById('viewer-banner');
  if (banner) banner.style.display = 'none';
  document.body.classList.remove('has-viewer-banner');
  sessionStorage.setItem('viewerBannerDismissed', '1');
};

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

  // The access-request gate is a React island (AccessRequestGate.tsx)
  // mounted into #access-gate-mount by /react/main.js. It is triggered via
  // window.showAccessGate() (defined in AccessRequestGate.tsx) which dispatches
  // a CustomEvent the component listens for.
  const accessGate = `<div id="access-gate-mount"></div>`;

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
  // Not inserted on pages where PageHeadingPanel suppresses itself
  // (/sales, /survey, /admin*, /customers/:id) — those pages render their
  // own heading or are full-bleed; skipping avoids a phantom in-flow div.
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

  const commandPaletteMount = `<div id="command-palette-mount"></div>`;

  const isAdminPage = path === '/admin' || path.startsWith('/admin/');
  // Mirrors the suppression list in PageHeadingPanel.tsx — all paths where
  // PageHeadingPanel returns null must skip the placeholder div to avoid a
  // phantom in-flow element occupying space before React mounts.
  const isAppBodyPage = path === '/sales' || path === '/survey' ||
    isAdminPage || /^\/customers\/[^/]+/.test(path);
  document.body.insertAdjacentHTML('afterbegin', skipLink + toastLive + header + viewerBanner + (isAppBodyPage ? '' : pageHeading) + accessGate);
  document.body.insertAdjacentHTML('beforeend', (isAdminPage ? '' : bottomNav) + bottomBar + commandPaletteMount);


  // Active-state sync + auto-scroll-into-view are handled by the React
  // BottomNav island; see src/react/components/BottomNav.tsx.
})();

