(function () {
  const ACTIONS = [
    {
      id: 'new-customer', label: 'New customer', hint: 'Create a new customer record', category: 'Action',
      icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"/>',
    },
    {
      id: 'go-customers', label: 'All customers', hint: 'Browse your customer list', category: 'Navigate',
      icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/>',
      href: '/customers',
    },
    {
      id: 'go-home', label: 'Home dashboard', hint: 'Go to the main dashboard', category: 'Navigate',
      icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/>',
      href: '/',
    },
    {
      id: 'go-sales', label: 'Sales board', hint: 'Manage leads and open deals', category: 'Navigate',
      icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>',
      href: '/sales',
    },
    {
      id: 'go-survey', label: 'Survey pipeline', hint: 'Track survey and design visit stages', category: 'Navigate',
      icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"/>',
      href: '/survey',
    },
    {
      id: 'go-projects', label: 'Projects tracker', hint: 'Active workshop and delivery jobs', category: 'Navigate',
      icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"/>',
      href: '/projects',
    },
    {
      id: 'go-calendar', label: 'Calendar', hint: 'Appointments and scheduled visits', category: 'Navigate',
      icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>',
      href: '/calendar',
    },
    {
      id: 'go-invoices', label: 'Invoices & payments', hint: 'View and send invoices via QuickBooks', category: 'Navigate',
      icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>',
      href: '/invoices',
    },
    {
      id: 'go-trades', label: 'Trade contacts', hint: 'Suppliers and contractor directory', category: 'Navigate',
      icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z"/>',
      href: '/trades',
    },
    {
      id: 'go-ideas', label: 'Ideas board', hint: 'Capture and review design ideas', category: 'Navigate',
      icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>',
      href: '/ideas',
    },
    {
      id: 'go-admin', label: 'Admin panel', hint: 'Manage users and team access', category: 'Navigate',
      icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>',
      href: '/admin',
    },
    {
      id: 'go-profile', label: 'Your profile', hint: 'Update your account details', category: 'Account',
      icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>',
      href: '/profile',
    },
    {
      id: 'filter-sales', label: 'Customers · Sales stage', hint: 'Show only customers in the Sales stage', category: 'Filter',
      icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"/>',
      href: '/customers?stage=sales',
    },
    {
      id: 'filter-workshop', label: 'Customers · Workshop', hint: 'Show only customers in Workshop', category: 'Filter',
      icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>',
      href: '/customers?stage=workshop',
    },
    {
      id: 'sign-out', label: 'Sign out', hint: 'End your current session', category: 'Account',
      icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>',
    },
  ];

  window._cpRun = {
    'new-customer': function () {
      closeCommandPalette();
      if (typeof openNewCustomerModal === 'function') openNewCustomerModal();
      else location.href = '/customers?new=1';
    },
    'sign-out': function () {
      fetch('/api/logout', { method: 'POST' })
        .then(() => { location.href = '/login'; })
        .catch(() => { location.href = '/login'; });
    },
  };

  let _searchSettings = null;

  async function _fetchSearchSettings() {
    if (_searchSettings !== null) return;
    try {
      const r = await fetch('/api/search-settings');
      _searchSettings = r.ok ? await r.json() : { disabled_actions: [], hint_placeholder: '', action_order: [] };
    } catch {
      _searchSettings = { disabled_actions: [], hint_placeholder: '', action_order: [] };
    }
    _applyHintText();
  }

  function _applyHintText() {
    const s = _searchSettings;
    if (!s || !s.hint_placeholder) return;
    document.querySelectorAll('.cp-hint-text').forEach(el => { el.textContent = s.hint_placeholder; });
    const inp = document.getElementById('cp-input');
    if (inp) inp.placeholder = s.hint_placeholder;
  }

  function _getActiveActions() {
    const s = _searchSettings || { disabled_actions: [], action_order: [] };
    const disabled = new Set(s.disabled_actions || []);
    let active = ACTIONS.filter(a => !disabled.has(a.id));
    const order = s.action_order || [];
    if (order.length) {
      active = [...active].sort((a, b) => {
        const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
        if (ai === -1 && bi === -1) return 0;
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      });
    }
    return active;
  }

  function getContacts() {
    if (window.state && Array.isArray(window.state.contacts)) return window.state.contacts;
    if (window.allContacts && Array.isArray(window.allContacts)) return window.allContacts;
    return [];
  }

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderResults(query) {
    const container = document.getElementById('cp-results');
    if (!container) return;
    const q = (query || '').toLowerCase().trim();
    let html = '';

    if (q) {
      const encoded = encodeURIComponent((query || '').trim());
      html += `<div class="cp-section-label">Search</div>`;
      html += `<button class="cp-result-item" onclick="closeCommandPalette();location.href='/customers?q=${encoded}'" tabindex="0">
        <span class="cp-result-icon">
          <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-4.35-4.35M17 11A6 6 0 105 11a6 6 0 0012 0z"/>
          </svg>
        </span>
        <span class="cp-result-text">
          <span class="cp-result-label">Search customers for &ldquo;${escHtml((query || '').trim())}&rdquo;</span>
          <span class="cp-result-sub">Browse all matching customers</span>
        </span>
      </button>`;
    }

    const contacts = getContacts();
    if (q && contacts.length) {
      const matched = contacts.filter(c => {
        const first = (c.properties && c.properties.firstname) || '';
        const last  = (c.properties && c.properties.lastname)  || '';
        const name  = (first + ' ' + last).trim().toLowerCase() || (c.name || '').toLowerCase();
        const company = ((c.properties && c.properties.company) || c.company || '').toLowerCase();
        return name.includes(q) || company.includes(q);
      }).slice(0, 5);

      if (matched.length) {
        html += `<div class="cp-section-label">Customers</div>`;
        matched.forEach(c => {
          const first = (c.properties && c.properties.firstname) || '';
          const last  = (c.properties && c.properties.lastname)  || '';
          const name  = (first + ' ' + last).trim() || c.name || 'Unknown';
          const sub   = (c.properties && c.properties.company) || c.company || '';
          const initials = name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
          const id = c.id || (c.properties && c.properties.hs_object_id) || '';
          html += `<button class="cp-result-item" onclick="closeCommandPalette();location.href='/customers/${escHtml(id)}'" tabindex="0">
            <span class="cp-result-avatar">${escHtml(initials)}</span>
            <span class="cp-result-text">
              <span class="cp-result-label">${escHtml(name)}</span>
              ${sub ? `<span class="cp-result-sub">${escHtml(sub)}</span>` : ''}
            </span>
          </button>`;
        });
      }
    }

    if (!q) {
      try {
        const recents = JSON.parse(localStorage.getItem('cp_recent_customers') || '[]');
        if (recents.length) {
          html += `<div class="cp-section-label">Recent</div>`;
          recents.forEach(r => {
            const initials = r.name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
            html += `<button class="cp-result-item" onclick="closeCommandPalette();location.href='/customers/${escHtml(r.id)}'" tabindex="0">
              <span class="cp-result-avatar">${escHtml(initials)}</span>
              <span class="cp-result-text">
                <span class="cp-result-label">${escHtml(r.name)}</span>
                ${r.company ? `<span class="cp-result-sub">${escHtml(r.company)}</span>` : ''}
              </span>
            </button>`;
          });
        }
      } catch (_) {}
    }

    const activeActions = _getActiveActions();
    const filtered = q
      ? activeActions.filter(a => a.label.toLowerCase().includes(q) || a.hint.toLowerCase().includes(q))
      : activeActions;

    if (filtered.length) {
      const sectionLabel = q ? 'Actions' : 'Quick Actions';
      html += `<div class="cp-section-label">${sectionLabel}</div>`;
      filtered.forEach(a => {
        const onclick = a.href
          ? `onclick="closeCommandPalette();location.href='${escHtml(a.href)}'"`
          : `onclick="if(window._cpRun&&window._cpRun['${a.id}'])window._cpRun['${a.id}']();closeCommandPalette();"`;
        html += `<button class="cp-result-item" ${onclick} tabindex="0">
          <span class="cp-result-icon">
            <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">${a.icon}</svg>
          </span>
          <span class="cp-result-text">
            <span class="cp-result-label">${escHtml(a.label)}</span>
            <span class="cp-result-sub">${escHtml(a.hint)}</span>
          </span>
          <span class="cp-result-category">${escHtml(a.category)}</span>
        </button>`;
      });
    }

    if (!html) {
      html = `<div class="cp-empty">No results for "<strong>${escHtml(query)}</strong>"</div>`;
    }

    container.innerHTML = html;
  }

  function injectModal() {
    const existing = document.getElementById('cp-overlay');
    if (existing) return;
    document.body.insertAdjacentHTML('beforeend', `
      <div id="cp-overlay" class="cp-overlay" style="display:none;" role="dialog" aria-modal="true" aria-label="Search">
        <div class="cp-modal" onclick="event.stopPropagation()">
          <div class="cp-search-row">
            <svg class="cp-search-icon" width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M21 21l-4.35-4.35M17 11A6 6 0 105 11a6 6 0 0012 0z"/>
            </svg>
            <input id="cp-input" type="text" class="cp-input" placeholder="Search customers, actions…"
              autocomplete="off" autocorrect="off" spellcheck="false">
            <button class="cp-esc-btn" onclick="closeCommandPalette()" title="Close (Esc)">
              <kbd class="cp-esc-badge">Esc</kbd>
            </button>
          </div>
          <div id="cp-results" class="cp-results"></div>
        </div>
      </div>`);

    document.getElementById('cp-overlay').addEventListener('click', closeCommandPalette);
    document.getElementById('cp-input').addEventListener('input', function () {
      renderResults(this.value);
    });
    document.getElementById('cp-input').addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); closeCommandPalette(); return; }
      const items = Array.from(document.querySelectorAll('.cp-result-item'));
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const idx = items.indexOf(document.activeElement);
        const next = items[idx + 1] || items[0];
        if (next) next.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const idx = items.indexOf(document.activeElement);
        const prev = items[idx - 1] || items[items.length - 1];
        if (prev) prev.focus();
      } else if (e.key === 'Enter') {
        const first = items[0];
        if (first) first.click();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => { injectModal(); _fetchSearchSettings(); });
  if (document.readyState !== 'loading') { injectModal(); _fetchSearchSettings(); }

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      const overlay = document.getElementById('cp-overlay');
      if (overlay && overlay.style.display !== 'none') closeCommandPalette();
      else openCommandPalette();
    }
  });

  window.openCommandPalette = function () {
    injectModal();
    if (!_searchSettings) _fetchSearchSettings();
    const overlay = document.getElementById('cp-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    requestAnimationFrame(() => {
      const input = document.getElementById('cp-input');
      if (input) { input.value = ''; input.focus(); }
      renderResults('');
    });
    document.body.style.overflow = 'hidden';
  };

  window.closeCommandPalette = function () {
    const overlay = document.getElementById('cp-overlay');
    if (overlay) overlay.style.display = 'none';
    document.body.style.overflow = '';
  };
})();
