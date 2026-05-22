// ── New Customer slide-over panel ────────────────────────────────────────────
function _ensureNewCustomerPanel() {
  let panel = document.getElementById('new-customer-panel');
  if (panel) return panel;

  const overlay = document.createElement('div');
  overlay.id = 'new-customer-overlay';
  overlay.className = 'nc-panel-overlay';
  overlay.style.display = 'none';
  overlay.addEventListener('click', closeNewCustomerModal);

  panel = document.createElement('aside');
  panel.id = 'new-customer-panel';
  panel.className = 'nc-panel';
  panel.innerHTML = `
    <div class="nc-panel-header">
      <h2 class="nc-panel-title">New Customer</h2>
      <button type="button" class="nc-panel-close" id="nc-panel-close-btn" title="Close" aria-label="Close">
        <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>
    </div>
    <div class="nc-panel-body">
      <form id="new-customer-form" novalidate>
        <div class="nc-form-grid">
          <label class="nc-form-row">
            <span class="nc-label-text">First name <span class="nc-required">*</span></span>
            <input id="nc-firstname" type="text" required autocomplete="given-name" class="nc-input">
          </label>
          <label class="nc-form-row">
            <span class="nc-label-text">Last name</span>
            <input id="nc-lastname" type="text" autocomplete="family-name" class="nc-input">
          </label>
        </div>
        <label class="nc-form-row">
          <span class="nc-label-text">Email <span class="nc-required">*</span></span>
          <input id="nc-email" type="email" required autocomplete="email" class="nc-input">
        </label>
        <label class="nc-form-row">
          <span class="nc-label-text">Phone</span>
          <input id="nc-phone" type="tel" autocomplete="tel" class="nc-input">
        </label>
        <label class="nc-form-row nc-form-row-last">
          <span class="nc-label-text">Postcode <span class="nc-required">*</span></span>
          <input id="nc-postcode" type="text" required autocomplete="postal-code" class="nc-input nc-postcode">
        </label>
        <div id="nc-error" class="nc-error"></div>
        <div class="nc-actions">
          <button type="button" id="nc-cancel-btn" class="nc-btn-cancel">Cancel</button>
          <button type="submit" id="nc-submit" class="nc-btn-submit">Create Customer</button>
        </div>
      </form>
    </div>
  `;

  document.body.appendChild(overlay);
  document.body.appendChild(panel);

  panel.querySelector('#nc-panel-close-btn').addEventListener('click', closeNewCustomerModal);
  panel.querySelector('#nc-cancel-btn').addEventListener('click', closeNewCustomerModal);
  panel.querySelector('#new-customer-form').addEventListener('submit', submitNewCustomer);
  return panel;
}

function openNewCustomerModal() {
  if (isViewerOnly()) return;
  const panel   = _ensureNewCustomerPanel();
  const overlay = document.getElementById('new-customer-overlay');
  const form    = document.getElementById('new-customer-form');
  const err     = document.getElementById('nc-error');
  if (form) form.reset();
  if (err)  { err.style.display = 'none'; err.textContent = ''; }
  if (overlay) overlay.style.display = 'block';
  // Force reflow so the transform transition runs
  void panel.offsetWidth;
  panel.classList.add('nc-panel-open');
  setTimeout(() => document.getElementById('nc-firstname')?.focus(), 60);
}

function closeNewCustomerModal() {
  const overlay = document.getElementById('new-customer-overlay');
  const panel   = document.getElementById('new-customer-panel');
  if (panel) panel.classList.remove('nc-panel-open');
  if (overlay) overlay.style.display = 'none';
}

async function submitNewCustomer(ev) {
  ev.preventDefault();
  const firstname = document.getElementById('nc-firstname')?.value.trim();
  const lastname  = document.getElementById('nc-lastname')?.value.trim();
  const email     = document.getElementById('nc-email')?.value.trim();
  const phone     = document.getElementById('nc-phone')?.value.trim();
  const postcode  = document.getElementById('nc-postcode')?.value.trim();
  const errEl     = document.getElementById('nc-error');
  const submitBtn = document.getElementById('nc-submit');

  const showError = msg => {
    if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
  };

  if (!firstname) { showError('First name is required.'); return; }
  if (!email)     { showError('Email is required.'); return; }
  if (!postcode)  { showError('Postcode is required.'); return; }

  if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Creating…'; }

  try {
    const contact = await POST('/api/contacts', { firstname, lastname, email, phone, postcode });

    // Insert into local state so it appears immediately, then refresh from server for correct sort order
    state.contacts.unshift(contact);
    state.filteredContacts = [...state.contacts];
    closeNewCustomerModal();
    renderCustomerList();
    const customerNum = contact.properties?.customer_number;
    showToast(`Customer created${customerNum ? ` — ${customerNum}` : ''}`);
    // Background refresh to pick up server sort order (respect current view mode)
    if (state.contactsViewMode === 'all' && typeof loadContactsPage === 'function') {
      _customersLoadAndRender({ page: 1, fetchCounts: true });
    } else {
      const refreshLoader = (state.contactsViewMode === 'all') ? loadAllContacts() : loadOpenLeads();
      refreshLoader.then(() => { state.filteredContacts = [...state.contacts]; if (state.contactsViewMode === 'all') populateLeadStatusFilter(); renderCustomerList(); }).catch(() => {});
    }
  } catch (e) {
    if (e.code === 'HUBSPOT_AUTH') {
      showError('HubSpot token is invalid or expired — ask an admin to update the token.');
    } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
      showError('HubSpot rate limit reached — please wait a moment and try again.');
    } else {
      showError(e.message || 'Failed to create customer.');
    }
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Create Customer'; }
  }
}

// ── Build List Items ──────────────────────────────────────────────────────────
function buildListItems() {
  const items = [];
  for (const contact of state.filteredContacts) {
    const cached = state.contactStageCache[contact.id];
    let rooms;
    if (cached && cached.length > 0) {
      const filtered = [];
      for (let idx = 0; idx < cached.length; idx++) {
        const r = cached[idx];
        const roomStatus = r.roomStatus || 'active';
        if (roomStatus !== 'active' && !state.showArchived) continue;
        if (state.stageFilter && r.stageKey !== state.stageFilter) continue;
        filtered.push({ room: r.room || 'Main', stageKey: r.stageKey || 'sales', roomStatus, roomIdx: idx });
      }
      if (filtered.length === 0) continue;
      rooms = filtered;
    } else {
      // No local data yet — default to Sales
      if (!state.stageFilter || state.stageFilter === 'sales') {
        rooms = [{ room: null, stageKey: 'sales', roomStatus: 'active', roomIdx: 0 }];
      } else {
        continue;
      }
    }

    // Representative stage for sorting: most advanced (lowest STAGE_KEYS index)
    const sortStageKey = rooms.reduce((best, r) => {
      const bi = STAGE_KEYS.indexOf(best);
      const ri = STAGE_KEYS.indexOf(r.stageKey);
      return (bi === -1 || (ri !== -1 && ri < bi)) ? r.stageKey : best;
    }, rooms[0].stageKey);

    items.push({ contact, rooms, sortStageKey });
  }

  const sortBy = state.sortBy || 'newest';
  items.sort((a, b) => {
    if (sortBy === 'name-asc') {
      return contactName(a.contact).localeCompare(contactName(b.contact));
    }
    if (sortBy === 'name-desc') {
      return contactName(b.contact).localeCompare(contactName(a.contact));
    }
    if (sortBy === 'stage') {
      const ai = STAGE_KEYS.indexOf(a.sortStageKey);
      const bi = STAGE_KEYS.indexOf(b.sortStageKey);
      return ai - bi;
    }
    // 'newest' — sort by createdate descending (most recent first)
    const ad = parseInt(a.contact.properties?.createdate || '0');
    const bd = parseInt(b.contact.properties?.createdate || '0');
    return bd - ad;
  });

  return items;
}

// ── Customer List Navigation ──────────────────────────────────────────────────
function goToCustomer(contactId) {
  const view = document.getElementById('customers-view');
  if (view) {
    try { sessionStorage.setItem('customers_scroll', String(view.scrollTop)); } catch {}
  }
  try {
    sessionStorage.setItem('customers_filters', JSON.stringify({
      contactsViewMode: state.contactsViewMode || 'all',
      stageFilter:      state.stageFilter      || '',
      showArchived:     !!state.showArchived,
      searchQuery:      state.searchQuery      || '',
    }));
  } catch {}
  location.href = '/customers/' + contactId;
}

function restoreCustomerListScroll() {
  const saved = sessionStorage.getItem('customers_scroll');
  if (!saved) return;
  sessionStorage.removeItem('customers_scroll');
  const view = document.getElementById('customers-view');
  if (view) view.scrollTop = parseInt(saved, 10) || 0;
}

// Restore filter/sort state saved by goToCustomer before navigating away.
// Returns true if any saved state was found and applied.
// Page, leadStatus, and sort are restored from URL params, not session storage.
function restoreCustomerListFilters() {
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem('customers_filters')); } catch {}
  sessionStorage.removeItem('customers_filters');

  // Always read page/leadStatus/sort from URL
  const urlParams  = new URLSearchParams(location.search);
  const urlPage    = Math.max(1, parseInt(urlParams.get('page') || '1', 10));
  const urlStatus  = urlParams.get('leadStatus') || '';
  const urlSort    = urlParams.get('sort') || 'newest';

  state.currentPage      = urlPage;
  state.leadStatusFilter = urlStatus;
  state.sortBy           = urlSort;

  if (!saved) return false;

  // Apply non-URL state values
  state.contactsViewMode = saved.contactsViewMode || 'all';
  state.stageFilter      = saved.stageFilter      || '';
  state.showArchived     = !!saved.showArchived;
  state.searchQuery      = saved.searchQuery      || '';

  return true;
}

const PAGE_SIZE = 25;

// ── Customer List ─────────────────────────────────────────────────────────────
// Registered below as the renderer for pages that carry #customers-view.
// sales.js registers renderSalesView on the sales page (see registerCustomerListRenderer
// call at the top of sales.js), which overrides this registration on that page.
function _renderCustomerListImpl() {
  const view = document.getElementById('customers-view');
  if (!view) return;

  const items      = buildListItems();
  const totalItems = state.total != null ? state.total : items.length;
  const totalPages = state.totalPages || Math.max(1, Math.ceil(totalItems / PAGE_SIZE));

  if (!state.currentPage || state.currentPage < 1) state.currentPage = 1;

  const pageStart = (state.currentPage - 1) * PAGE_SIZE;

  const viewMode = state.contactsViewMode || 'all';
  const filter   = state.stageFilter || '';

  // ── Stage tabs ──────────────────────────────────────────────────────────────
  const stageTabs = [
    { key: '__active__', label: 'Active' },
    { key: '__all__',    label: 'All' },
    ...Object.entries(state.workflow?.stages || {}).map(([k, s]) => ({ key: k, label: s.label })),
  ].map(({ key, label }) => {
    let isActive = false;
    if (key === '__active__') isActive = viewMode === 'active' && !filter;
    else if (key === '__all__') isActive = viewMode === 'all' && !filter;
    else isActive = filter === key;
    const colour = (key !== '__active__' && key !== '__all__') ? stageColour(key) : null;
    const style  = isActive && colour
      ? `background:${colour.bg};color:#fff;border-color:${colour.bg}`
      : isActive
        ? 'background:var(--plum);color:#fff;border-color:var(--plum)'
        : '';
    return `<button class="project-stage-tab${isActive ? ' project-stage-tab-active' : ''}"
      style="${style}" data-tab-key="${escHtml(key)}">${escHtml(label)}</button>`;
  }).join('');

  // ── Sort bar ────────────────────────────────────────────────────────────────
  const sortOptions = [
    { value: 'newest',    label: 'Newest first' },
    { value: 'name-asc',  label: 'Name A–Z' },
    { value: 'name-desc', label: 'Name Z–A' },
    { value: 'stage',     label: 'Stage order' },
  ].map(({ value, label }) =>
    `<option value="${value}"${(state.sortBy || 'newest') === value ? ' selected' : ''}>${escHtml(label)}</option>`
  ).join('');

  const nullLbl   = (typeof NULL_LEAD_STATUS_LABEL !== 'undefined' ? NULL_LEAD_STATUS_LABEL : null) || 'No status';
  const lsOptions = `<option value="__no_status__"${state.leadStatusFilter === '__no_status__' ? ' selected' : ''}>${escHtml(nullLbl)}</option>` +
    LEAD_STATUS_OPTIONS.map(({ value, label }) =>
      `<option value="${escHtml(value)}"${state.leadStatusFilter === value ? ' selected' : ''}>${escHtml(label)}</option>`
    ).join('');

  const showAllActive = state.showArchived ? ' project-stage-tab-active' : '';
  const showAllStyle  = state.showArchived ? 'background:var(--ink-2);color:#fff;border-color:var(--ink-2)' : '';

  const searchChip = state.searchQuery
    ? `<button class="search-active-chip" onclick="filterDeals('')" title="Clear search" aria-label="Clear search filter">
        <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z"/>
        </svg>
        <span>${escHtml(state.searchQuery)}</span>
        <svg class="search-active-chip-x" width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M18 6L6 18M6 6l12 12"/>
        </svg>
      </button>`
    : '';

  const sortBar = `
    <div class="project-sort-bar">
      <label class="project-sort-label" for="customers-sort-select">Sort by</label>
      <select id="customers-sort-select" class="project-sort-select">${sortOptions}</select>
      <select id="lead-status-filter" class="project-sort-select" aria-label="Lead status filter">
        <option value="">All statuses</option>
        ${lsOptions}
      </select>
      ${searchChip}
      <button id="archived-toggle" class="project-stage-tab${showAllActive}" style="${showAllStyle};margin-left:auto"
        aria-pressed="${state.showArchived}" aria-label="Show all HubSpot contacts">Show all</button>
    </div>`;

  // ── Cards ───────────────────────────────────────────────────────────────────
  let bodyHtml;
  if (!items.length) {
    bodyHtml = `<p class="projects-empty-msg">No customers match</p>`;
  } else {
    bodyHtml = items.map(({ contact, rooms }) => {
      const name        = contactName(contact);
      const email       = contact.properties?.email || '';
      const phone       = contact.properties?.phone || '';
      const hsId        = contact.id || '';
      const customerNum = contact.properties?.customer_number || '';
      const isSelected  = contact.id === state.selectedContactId;
      const urgency     = state.contactUrgencyCache[contact.id];
      const allArchived = rooms.every(r => r.roomStatus !== 'active');
      const multiRoom   = rooms.length > 1;

      const urgencyDot = urgency === 'red'
        ? `<span class="urgency-dot urgency-red" title="Urgent: task due within 1 working day" aria-label="Urgent"></span>`
        : urgency === 'orange'
          ? `<span class="urgency-dot urgency-orange" title="Task due within 2 working days" aria-label="Task due soon"></span>`
          : '';

      // One stage pill per room, all inline; include room name if multi-room
      const stagePills = rooms.map(r => {
        const colour     = stageColour(r.stageKey || 'sales');
        const stageLabel = r.stageKey ? (state.workflow?.stages?.[r.stageKey]?.label || r.stageKey) : 'Sales';
        const pillText   = multiRoom && r.room && r.room !== 'Main'
          ? `${stageLabel} — ${r.room}` : stageLabel;
        const archivedStyle = r.roomStatus !== 'active' ? 'opacity:0.55;' : '';
        return `<span class="stage-pill" style="background:${colour.light};color:${colour.text};${archivedStyle}">${escHtml(pillText)}</span>`;
      }).join('');

      const leadStatusBadge = (() => {
        const raw = contact.properties?.hs_lead_status || '';
        const CSS_CLASS_MAP = {
          'OPEN_DEAL': 'lsb-open-deal', 'NEW': 'lsb-new', 'IN_PROGRESS': 'lsb-in-progress',
          'OPEN': 'lsb-new', 'CONNECTED': 'lsb-connected',
          'ATTEMPTED_TO_CONTACT': '', 'UNQUALIFIED': 'lsb-unqualified', 'BAD_TIMING': 'lsb-bad-timing',
        };
        if (!raw) {
          const nullLabel = (typeof NULL_LEAD_STATUS_LABEL !== 'undefined' ? NULL_LEAD_STATUS_LABEL : null) || 'No status';
          return `<span class="lead-status-badge lsb-empty" title="Set lead status" onclick="openLeadStatusPicker(event,'${contact.id}')" role="button" tabindex="-1">${escHtml(nullLabel)}</span>`;
        }
        const opt   = LEAD_STATUS_OPTIONS.find(o => o.value === raw);
        const label = opt ? opt.label : raw.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
        const cls   = CSS_CLASS_MAP[raw] || '';
        return `<span class="lead-status-badge ${cls} lsb-clickable" title="Change lead status" onclick="openLeadStatusPicker(event,'${contact.id}')" role="button" tabindex="-1">${escHtml(label)}</span>`;
      })();

      const qbInvs       = matchInvoicesForContact(contact);
      const qbTotal      = qbInvs.reduce((s, inv) => s + inv.balance, 0);
      const qbInvIdsAttr = escHtml(JSON.stringify(qbInvs.map(inv => inv.id)));
      const qbBadge      = qbInvs.length > 0
        ? `<button class="qb-badge" title="${qbInvs.length} outstanding invoice${qbInvs.length !== 1 ? 's' : ''}" data-inv-ids="${qbInvIdsAttr}" onclick="event.stopPropagation();openInvoicePanelFromBadge(this)">£${qbTotal.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</button>`
        : '';

      const customerNumBadge = customerNum
        ? `<span class="customer-num-badge" title="Customer number">${escHtml(customerNum)}</span>`
        : '';

      const footerBadges = [
        email       ? `<span class="cl-badge cl-badge-email" title="Email">${escHtml(email)}</span>` : '',
        phone       ? `<span class="cl-badge cl-badge-phone" title="Phone">${escHtml(phone)}</span>` : '',
        hsId        ? `<span class="cl-badge cl-badge-hsid" title="HubSpot contact ID">${escHtml(hsId)}</span>` : '',
        qbBadge,
        customerNumBadge,
      ].filter(Boolean).join('');

      return `
        <div class="customer-project-card${isSelected ? ' customer-project-card-selected' : ''}${allArchived ? ' card-archived' : ''}"
             data-contact-id="${contact.id}"
             role="button" tabindex="0"
             aria-current="${isSelected ? 'true' : 'false'}"
             aria-label="Open customer ${escHtml(name)}"
             onclick="goToCustomer(this.dataset.contactId)"
             onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();goToCustomer(this.dataset.contactId);}">
          <div class="cl-card-main">
            <div class="cl-card-name-row">
              ${urgencyDot}<span class="cl-card-name">${escHtml(name)}</span>
            </div>
            <div class="cl-card-pills">
              ${stagePills}
              ${leadStatusBadge}
            </div>
          </div>
          ${footerBadges ? `<div class="cl-card-footer">${footerBadges}</div>` : ''}
        </div>`;
    }).join('');
  }

  // ── Pagination bar ──────────────────────────────────────────────────────────
  let paginationHtml = '';
  if (totalPages > 1) {
    const rangeStart = totalItems === 0 ? 0 : pageStart + 1;
    const rangeEnd   = Math.min(pageStart + PAGE_SIZE, totalItems);
    const prevDisabled = state.currentPage <= 1          ? ' disabled' : '';
    const nextDisabled = state.currentPage >= totalPages ? ' disabled' : '';

    // Build the set of page numbers to show (windowed with ellipsis)
    const pageNums = new Set([1, totalPages]);
    for (let p = state.currentPage - 1; p <= state.currentPage + 1; p++) {
      if (p >= 1 && p <= totalPages) pageNums.add(p);
    }
    const sortedPages = Array.from(pageNums).sort((a, b) => a - b);
    let pageButtonsHtml = '';
    let prev = 0;
    for (const p of sortedPages) {
      if (p - prev > 1) {
        pageButtonsHtml += `<span class="cl-pagination-ellipsis">…</span>`;
      }
      const active = p === state.currentPage ? ' cl-pagination-btn--active' : '';
      pageButtonsHtml += `<button class="cl-pagination-btn cl-pagination-page${active}" data-page="${p}" aria-label="Page ${p}" aria-current="${p === state.currentPage ? 'page' : 'false'}">${p}</button>`;
      prev = p;
    }

    paginationHtml = `
      <div class="cl-pagination">
        <span class="cl-pagination-info">Showing ${rangeStart}–${rangeEnd} of ${totalItems}</span>
        <div class="cl-pagination-btns">
          <button class="cl-pagination-btn" id="cl-prev-btn"${prevDisabled} aria-label="Previous page">← Prev</button>
          ${pageButtonsHtml}
          <button class="cl-pagination-btn" id="cl-next-btn"${nextDisabled} aria-label="Next page">Next →</button>
        </div>
        <form class="cl-pagination-jump" id="cl-jump-form" aria-label="Jump to page">
          <label class="cl-pagination-jump-label" for="cl-jump-input">Go to</label>
          <input id="cl-jump-input" class="cl-pagination-jump-input" type="number" min="1" max="${totalPages}" placeholder="${state.currentPage}" aria-label="Page number">
          <button type="submit" class="cl-pagination-btn cl-pagination-jump-btn">Go</button>
        </form>
      </div>`;
  }

  const stageFilterNote = state.stageFilter
    ? `<p class="cl-stage-filter-note" role="note">Stage filter applies to this page only. Switch pages to find more matches.</p>`
    : '';

  view.innerHTML = `
    <div class="project-stage-tabs-bar">${stageTabs}</div>
    ${sortBar}
    ${stageFilterNote}
    <div class="projects-inner">${bodyHtml}</div>
    ${paginationHtml}
  `;

  // ── Event listeners ─────────────────────────────────────────────────────────
  view.querySelector('.project-stage-tabs-bar').addEventListener('click', function(e) {
    const btn = e.target.closest('[data-tab-key]');
    if (!btn) return;
    const key = btn.dataset.tabKey;
    if (key === '__active__') {
      state.contactsViewMode = 'active';
      state.stageFilter      = '';
      state.leadStatusFilter = '';
      state.currentPage      = 1;
      _updateCustomersUrl({ page: 1, leadStatus: '', sort: state.sortBy });
      loadOpenLeads().then(() => { state.filteredContacts = [...state.contacts]; renderCustomerList(); }).catch(() => {});
    } else if (key === '__all__') {
      state.contactsViewMode = 'all';
      state.stageFilter      = '';
      state.currentPage      = 1;
      _customersLoadAndRender({ page: 1, fetchCounts: true });
    } else {
      state.contactsViewMode = 'all';
      state.stageFilter      = key;
      state.currentPage      = 1;
      renderCustomerList();
    }
  });

  const sortSel = view.querySelector('#customers-sort-select');
  if (sortSel) sortSel.addEventListener('change', () => {
    state.sortBy = sortSel.value;
    state.currentPage = 1;
    _customersLoadAndRender({ page: 1 });
  });

  const lsSel = view.querySelector('#lead-status-filter');
  if (lsSel) lsSel.addEventListener('change', () => {
    state.leadStatusFilter = lsSel.value;
    state.currentPage = 1;
    _customersLoadAndRender({ page: 1 });
  });

  const archivedBtn = view.querySelector('#archived-toggle');
  if (archivedBtn) archivedBtn.addEventListener('click', () => {
    state.showArchived = !state.showArchived;
    state.currentPage  = 1;
    if (state.showArchived) {
      state.contactsViewMode = 'all';
      _customersLoadAndRender({ page: 1, fetchCounts: true });
    } else {
      state.contactsViewMode = 'active';
      state.stageFilter      = '';
      state.leadStatusFilter = '';
      _updateCustomersUrl({ page: 1, leadStatus: '', sort: state.sortBy });
      loadOpenLeads().then(() => { state.filteredContacts = [...state.contacts]; renderCustomerList(); }).catch(() => {});
    }
  });

  const prevBtn = view.querySelector('#cl-prev-btn');
  if (prevBtn) prevBtn.addEventListener('click', () => {
    if (state.currentPage > 1) { _customersLoadAndRender({ page: state.currentPage - 1 }); }
  });

  const nextBtn = view.querySelector('#cl-next-btn');
  if (nextBtn) nextBtn.addEventListener('click', () => {
    if (state.currentPage < totalPages) { _customersLoadAndRender({ page: state.currentPage + 1 }); }
  });

  view.querySelectorAll('.cl-pagination-page').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = parseInt(btn.dataset.page, 10);
      if (p !== state.currentPage && p >= 1 && p <= totalPages) {
        _customersLoadAndRender({ page: p });
      }
    });
  });

  const jumpForm = view.querySelector('#cl-jump-form');
  if (jumpForm) jumpForm.addEventListener('submit', e => {
    e.preventDefault();
    const input = jumpForm.querySelector('#cl-jump-input');
    const p = Math.round(Number(input.value));
    if (!Number.isFinite(p) || p < 1 || p > totalPages) { input.select(); return; }
    if (p !== state.currentPage) { _customersLoadAndRender({ page: p }); }
  });

  const inner = view.querySelector('.projects-inner');
  if (inner) inner.addEventListener('keydown', function(e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const cards = Array.from(inner.querySelectorAll('.customer-project-card'));
    if (!cards.length) return;
    const idx = cards.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = idx === -1 ? cards[0] : cards[Math.min(idx + 1, cards.length - 1)];
      next.focus();
    } else {
      e.preventDefault();
      const prev = idx <= 0 ? cards[0] : cards[idx - 1];
      prev.focus();
    }
  });

  // Apply lead-status counts to the just-rendered <select> (must run after
  // view.innerHTML is set, since that recreates the DOM element).
  if (state.contactsViewMode === 'all') populateLeadStatusFilter();
}

registerCustomerListRenderer(_renderCustomerListImpl);

// ── Customers page helpers ────────────────────────────────────────────────────

function _updateCustomersUrl({ page, leadStatus, sort } = {}) {
  const qs = new URLSearchParams();
  const p  = page || state.currentPage || 1;
  const ls = leadStatus !== undefined ? leadStatus : (state.leadStatusFilter || '');
  const s  = sort !== undefined ? sort : (state.sortBy || 'newest');
  if (p > 1)  qs.set('page', p);
  if (ls)     qs.set('leadStatus', ls);
  if (s && s !== 'newest') qs.set('sort', s);
  history.replaceState(null, '', qs.toString() ? '?' + qs.toString() : location.pathname);
}

function _customersLoadAndRender({ page, fetchCounts = false } = {}) {
  const targetPage = page || state.currentPage || 1;
  const leadStatus = state.leadStatusFilter || '';
  const sort       = state.sortBy || 'newest';
  _updateCustomersUrl({ page: targetPage, leadStatus, sort });
  const pageLoader = loadContactsPage({ page: targetPage, leadStatus, sort });
  // Only fetch counts when explicitly requested (initial "All" load or after
  // a status change) — page turns reuse the cached state.leadStatusCounts.
  const needCounts = fetchCounts && typeof loadLeadStatusCounts === 'function';
  const countsLoader = needCounts ? loadLeadStatusCounts() : Promise.resolve();
  Promise.all([pageLoader, countsLoader])
    .then(() => renderCustomerList())
    .catch(() => {});
}
registerCustomersReloader(() => _customersLoadAndRender({ page: 1 }));

// ── Quick Card Actions ────────────────────────────────────────────────────────

// Load, apply an updater fn, save, and refresh the list — without opening the workflow
async function quickLoadAndUpdate(contactId, roomIdx, updater) {
  if (contactId === state.selectedContactId) {
    // Modify in-memory state directly
    updater(state.allRooms, roomIdx);
    updateRoomCache();
    try { await saveWorkflowData(); } catch (e) {
      if (e.code === 'HUBSPOT_AUTH') {
        showToast('Could not save — HubSpot token is invalid or expired. Ask an admin to update the token.', true);
      } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
        showToast('Could not save — HubSpot rate limit reached. Please try again in a moment.', true);
      } else {
        showToast('Failed to save', true);
      }
      return;
    }
    renderCustomerList();
    if (state.selectedRoomIdx === roomIdx) {
      renderWorkflowHeader();
      renderRoomTabs();
      renderWorkflowStages();
    }
    return;
  }
  let rawData;
  try { rawData = await GET(`/api/contacts/${contactId}/localdata`); } catch { rawData = null; }
  let rooms;
  let notes = '';
  if (Array.isArray(rawData) && rawData.length > 0) {
    rooms = rawData;
  } else if (rawData && Array.isArray(rawData.rooms) && rawData.rooms.length > 0) {
    rooms = rawData.rooms;
    notes = rawData.notes || '';
  } else {
    rooms = [{ room: 'Main', stageKey: 'sales', statusId: null, comments: [], roomStatus: 'active' }];
  }
  rooms = rooms.map(r => ({
    ...r,
    room: r.room || 'Main', stageKey: r.stageKey || 'sales',
    statusId: r.statusId || null, comments: r.comments || [],
    roomStatus: r.roomStatus || 'active'
  }));
  if (roomIdx >= rooms.length) roomIdx = rooms.length - 1;
  updater(rooms, roomIdx);
  try { await POST(`/api/contacts/${contactId}/localdata`, { rooms, notes }); } catch (e) {
    if (e.code === 'HUBSPOT_AUTH') {
      showToast('Could not save — HubSpot token is invalid or expired. Ask an admin to update the token.', true);
    } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
      showToast('Could not save — HubSpot rate limit reached. Please try again in a moment.', true);
    } else {
      showToast('Failed to save', true);
    }
    return;
  }
  state.contactStageCache[contactId] = rooms.map(r => ({
    room: r.room, stageKey: r.stageKey, roomStatus: r.roomStatus || 'active',
    statusId: r.statusId || null,
    sourceId: r.sourceId || null,
    stageDates: r.stageDates || null,
  }));
  renderCustomerList();
}

function closeCardPicker() {
  document.getElementById('card-picker-popup')?.remove();
  document.removeEventListener('click', closeCardPicker);
}

// ── Lead Status Picker ────────────────────────────────────────────────────────

async function openLeadStatusPicker(event, contactId) {
  event.stopPropagation();
  if (isViewerOnly()) return;
  closeCardPicker();
  const rect = event.currentTarget.getBoundingClientRect();
  const popup = document.createElement('div');
  popup.id = 'card-picker-popup';
  popup.className = 'card-picker-popup';
  const top = Math.min(rect.bottom + 4, window.innerHeight - 300);
  popup.style.cssText = `top:${top}px;left:${Math.max(4, rect.left)}px;`;

  const stalePrevStatus = state.contacts.find(c => c.id === contactId)?.properties?.hs_lead_status || '';

  // Loading state while we refresh from HubSpot so the user can't pick a stale option.
  const loadingEl = document.createElement('div');
  loadingEl.style.cssText = 'padding:12px 16px;color:#64748b;font-size:13px;';
  loadingEl.textContent = 'Loading current status…';
  popup.appendChild(loadingEl);
  document.body.appendChild(popup);
  // Defer dismiss handler until after the picker is fully built, so loading-state
  // clicks don't consume the once-listener before the real picker appears.

  let currentLeadStatus = stalePrevStatus;
  let driftedTo = null;
  try {
    const fresh = await GET(`/api/contacts/${contactId}`);
    const freshStatus = fresh?.properties?.hs_lead_status || '';
    // Don't override the UI value if an optimistic change is mid-flight for this contact.
    const pending = state.pendingLeadStatus && Object.prototype.hasOwnProperty.call(state.pendingLeadStatus, contactId);
    if (!pending) {
      if (freshStatus !== stalePrevStatus) driftedTo = freshStatus;
      currentLeadStatus = freshStatus;
      if (typeof _mergeContactIntoState === 'function') {
        _mergeContactIntoState(fresh);
      }
      populateLeadStatusFilter();
      renderCustomerList();
      if (typeof renderWorkflowHeader === 'function') renderWorkflowHeader();
    }
  } catch (e) {
    showToast('Could not refresh lead status from HubSpot — showing last known value.', true);
  }

  // User may have closed the popup (clicked elsewhere) while loading.
  if (!document.body.contains(popup)) {
    if (driftedTo !== null) {
      const _nullLbl = (typeof NULL_LEAD_STATUS_LABEL !== 'undefined' ? NULL_LEAD_STATUS_LABEL : null) || 'No status';
      const newLabel = driftedTo ? (LEAD_STATUS_OPTIONS.find(o => o.value === driftedTo)?.label || driftedTo) : _nullLbl;
      showToast(`Lead status was updated in HubSpot to ${newLabel}`);
    }
    return;
  }

  popup.innerHTML = '';
  const clearBtn = document.createElement('button');
  clearBtn.className = 'card-picker-opt card-picker-opt--clear' + (currentLeadStatus ? '' : ' card-picker-opt--disabled');
  clearBtn.textContent = '✕ Clear status';
  if (currentLeadStatus) {
    clearBtn.addEventListener('click', () => quickSetLeadStatus(contactId, ''));
  } else {
    clearBtn.disabled = true;
  }
  popup.appendChild(clearBtn);

  LEAD_STATUS_OPTIONS.forEach(({ value, label }) => {
    const btn = document.createElement('button');
    const isActive = value === currentLeadStatus;
    btn.className = 'card-picker-opt' + (isActive ? ' card-picker-opt--active' : '');
    btn.dataset.leadStatus = value;
    btn.textContent = label;
    btn.addEventListener('click', () => quickSetLeadStatus(contactId, value));
    popup.appendChild(btn);
  });
  setTimeout(() => document.addEventListener('click', closeCardPicker, { once: true }), 0);

  if (driftedTo !== null) {
    const _nullLbl2 = (typeof NULL_LEAD_STATUS_LABEL !== 'undefined' ? NULL_LEAD_STATUS_LABEL : null) || 'No status';
    const newLabel = driftedTo ? (LEAD_STATUS_OPTIONS.find(o => o.value === driftedTo)?.label || driftedTo) : _nullLbl2;
    showToast(`Lead status was updated in HubSpot to ${newLabel}`);
  }
}

// ── Contact Detail Edit ───────────────────────────────────────────────────────
const _CONTACT_FIELD_LABELS = {
  firstname: 'first name',
  lastname:  'last name',
  email:     'email',
  phone:     'phone',
  address:   'address',
  city:      'city',
  zip:       'postcode',
};

function _fillContactEditForm(props) {
  const f = props || {};
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
  set('ec-firstname', f.firstname);
  set('ec-lastname',  f.lastname);
  set('ec-email',     f.email);
  set('ec-phone',     f.phone);
  set('ec-address',   f.address);
  set('ec-city',      f.city);
  set('ec-zip',       f.zip);
}

// Snapshot of the form values at the moment the modal was last (re)populated,
// used to detect unsaved edits when the user tries to navigate away.
let _editContactOriginal = null;

const _EC_FIELD_IDS = ['ec-firstname','ec-lastname','ec-email','ec-phone','ec-address','ec-city','ec-zip'];

function _readContactEditForm() {
  const out = {};
  for (const id of _EC_FIELD_IDS) {
    const el = document.getElementById(id);
    out[id] = el ? el.value.trim() : '';
  }
  return out;
}

function _captureContactEditOriginal() {
  _editContactOriginal = _readContactEditForm();
}

function isContactEditOpen() {
  return !!document.getElementById('edit-contact-form');
}

function isContactEditDirty() {
  if (!_editContactOriginal) return false;
  if (!isContactEditOpen()) return false;
  const current = _readContactEditForm();
  for (const id of _EC_FIELD_IDS) {
    if ((current[id] || '') !== (_editContactOriginal[id] || '')) return true;
  }
  return false;
}

function _contactEditInlineHtml() {
  return `
    <form id="edit-contact-form" novalidate>
      <div class="contact-edit-inline-header">
        <span class="contact-edit-inline-title">Edit Contact</span>
        <span class="contact-edit-inline-status" id="ec-status"></span>
      </div>
      <div class="nc-form-grid">
        <label class="nc-form-row">
          <span class="nc-label-text">First name <span class="nc-required">*</span></span>
          <input id="ec-firstname" type="text" required autocomplete="given-name" class="nc-input">
        </label>
        <label class="nc-form-row">
          <span class="nc-label-text">Last name</span>
          <input id="ec-lastname" type="text" autocomplete="family-name" class="nc-input">
        </label>
      </div>
      <label class="nc-form-row">
        <span class="nc-label-text">Email</span>
        <input id="ec-email" type="email" autocomplete="email" class="nc-input">
      </label>
      <label class="nc-form-row">
        <span class="nc-label-text">Phone</span>
        <input id="ec-phone" type="tel" autocomplete="tel" class="nc-input">
      </label>
      <label class="nc-form-row">
        <span class="nc-label-text">Address</span>
        <input id="ec-address" type="text" autocomplete="street-address" class="nc-input">
      </label>
      <div class="nc-form-grid">
        <label class="nc-form-row">
          <span class="nc-label-text">City</span>
          <input id="ec-city" type="text" autocomplete="address-level2" class="nc-input">
        </label>
        <label class="nc-form-row">
          <span class="nc-label-text">Postcode</span>
          <input id="ec-zip" type="text" autocomplete="postal-code" class="nc-input nc-postcode">
        </label>
      </div>
      <div id="ec-error" class="nc-error"></div>
      <div class="nc-actions">
        <button type="button" id="ec-cancel-btn" class="nc-btn-cancel">Cancel</button>
        <button type="submit" id="ec-submit" class="nc-btn-submit">Save</button>
      </div>
    </form>
  `;
}

async function openContactEdit() {
  if (isViewerOnly()) return;
  const contactId = state.selectedContactId;
  if (!contactId) return;

  const host = document.getElementById('contact-edit-inline');
  if (!host) return;

  host.innerHTML = _contactEditInlineHtml();
  host.classList.remove('hidden');

  document.getElementById('ec-cancel-btn')?.addEventListener('click', requestCloseContactEdit);
  document.getElementById('edit-contact-form')?.addEventListener('submit', submitContactEdit);

  // Pre-fill with known values immediately
  const contact = state.contacts.find(c => c.id === contactId);
  _fillContactEditForm(contact?.properties || {});
  _captureContactEditOriginal();

  const submitBtn = document.getElementById('ec-submit');
  const statusEl  = document.getElementById('ec-status');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Loading…'; }
  if (statusEl)  { statusEl.textContent = 'Refreshing from HubSpot…'; }

  setTimeout(() => {
    const el = document.getElementById('ec-firstname');
    if (el && document.activeElement?.tagName !== 'INPUT') el.focus();
  }, 40);

  // Scroll the form into view so the user sees it appear in place.
  try { host.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch {}

  // Refresh from HubSpot and detect drift in editable fields
  try {
    const fresh    = await GET(`/api/contacts/${contactId}`);
    // Bail out if the form was closed while loading.
    if (!isContactEditOpen()) return;
    const oldProps = contact?.properties || {};
    const newProps = fresh?.properties   || {};

    const driftedLabels = Object.keys(_CONTACT_FIELD_LABELS).filter(f =>
      (newProps[f] || '') !== (oldProps[f] || '')
    ).map(f => _CONTACT_FIELD_LABELS[f]);

    // Only re-baseline the dirty snapshot if the user hasn't started editing
    // yet — otherwise their in-progress edits would suddenly look "clean".
    const wasDirty = isContactEditDirty();
    _fillContactEditForm(newProps);
    if (!wasDirty) _captureContactEditOriginal();

    if (typeof _mergeContactIntoState === 'function') _mergeContactIntoState(fresh);

    if (driftedLabels.length > 0) {
      const summary = driftedLabels.length === 1
        ? driftedLabels[0]
        : `${driftedLabels.slice(0, -1).join(', ')} and ${driftedLabels.slice(-1)}`;
      showToast(`HubSpot has a newer value for ${summary} — form updated.`);
    }
  } catch {
    showToast('Could not refresh contact from HubSpot — showing last known values.', true);
  } finally {
    const sBtn = document.getElementById('ec-submit');
    const sEl  = document.getElementById('ec-status');
    if (sBtn) { sBtn.disabled = false; sBtn.textContent = 'Save'; }
    if (sEl)  { sEl.textContent = ''; }
  }
}

function closeContactEdit() {
  const host = document.getElementById('contact-edit-inline');
  if (host) { host.innerHTML = ''; host.classList.add('hidden'); }
  _editContactOriginal = null;
  if (typeof _updateBeforeUnloadGuard === 'function') _updateBeforeUnloadGuard();
}

// Guarded close used by the overlay click and the X / Cancel buttons. If the
// user has unsaved edits, show the same bottom-bar prompt used elsewhere
// instead of silently discarding their changes.
function requestCloseContactEdit() {
  if (isContactEditDirty()) {
    showUnsavedChangesBar(
      async () => { await submitContactEdit({ preventDefault(){} }); },
      ()       => { closeContactEdit(); }
    );
    return;
  }
  closeContactEdit();
}

async function submitContactEdit(ev) {
  ev.preventDefault();
  const contactId = state.selectedContactId;
  if (!contactId) return false;

  const trim = id => document.getElementById(id)?.value.trim() || '';
  const fields = {
    firstname: trim('ec-firstname'),
    lastname:  trim('ec-lastname'),
    email:     trim('ec-email'),
    phone:     trim('ec-phone'),
    address:   trim('ec-address'),
    city:      trim('ec-city'),
    zip:       trim('ec-zip'),
  };

  const errEl     = document.getElementById('ec-error');
  const submitBtn = document.getElementById('ec-submit');
  const showError = msg => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };

  if (!fields.firstname) { showError('First name is required.'); return false; }

  if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Saving…'; }

  const contact   = state.contacts.find(c => c.id === contactId);
  const prevProps = { ...(contact?.properties || {}) };

  function _applyContactFields(props) {
    if (contact) {
      contact.properties = { ...(contact.properties || {}), ...props };
      if (state.selectedContactId === contactId) state.selectedContact = contact;
    }
    renderCustomerList();
    if (typeof renderWorkflowHeader === 'function') renderWorkflowHeader();
  }

  const prevTitle = document.title;

  try {
    await PATCH_REQ(`/api/contacts/${contactId}`, fields);
    // Success — apply locally, update title, then close the inline form.
    _applyContactFields(fields);
    if (contact) document.title = contactName(contact);
    closeContactEdit();
    showToast('Contact updated');
    return true;
  } catch (e) {
    // Failure — keep the inline form open and show the error inline so the
    // user can fix and retry without losing their edits.
    document.title = prevTitle;
    let msg;
    if (e.code === 'HUBSPOT_VERIFY_FAILED') {
      msg = "Contact details didn't save in HubSpot — please try again.";
    } else if (e.code === 'HUBSPOT_AUTH') {
      msg = 'Could not update contact — HubSpot token is invalid or expired. Ask an admin to update the token.';
    } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
      msg = 'Could not update contact — HubSpot rate limit reached. Please try again in a moment.';
    } else {
      msg = 'Failed to update contact. Please try again.';
    }
    showError(msg);
    return false;
  } finally {
    const sBtn = document.getElementById('ec-submit');
    if (sBtn) { sBtn.disabled = false; sBtn.textContent = 'Save'; }
  }
}

// Closes the modal silently if it is open without any unsaved edits, so a
// pristine open modal doesn't get stranded across room/contact navigation.
function closeContactEditIfPristine() {
  if (isContactEditOpen() && !isContactEditDirty()) {
    closeContactEdit();
  }
}

async function quickSetLeadStatus(contactId, newStatus) {
  closeCardPicker();
  const contact = state.contacts.find(c => c.id === contactId);
  const prevStatus = contact?.properties?.hs_lead_status || null;
  if (prevStatus === newStatus) return;

  function _applyLeadStatus(status) {
    if (contact) {
      contact.properties = { ...(contact.properties || {}), hs_lead_status: status };
    }
    // Defensive refresh: re-read selectedContact from the contacts array so the
    // detail panel always sees the freshly-mutated object, regardless of which
    // direction the change came from (list → detail or detail → list).
    if (state.selectedContactId) {
      const fresh = state.contacts.find(c => c.id === state.selectedContactId);
      if (fresh) state.selectedContact = fresh;
    }
    // Record pending optimistic status (including '' for a clear) so any
    // contact refresh that replaces state.contacts can re-apply it before
    // the PATCH response arrives. The entry is only removed once the PATCH
    // resolves, not when the status value is empty.
    state.pendingLeadStatus = state.pendingLeadStatus || {};
    state.pendingLeadStatus[contactId] = status;
    populateLeadStatusFilter();
    renderCustomerList();
    if (typeof renderWorkflowHeader === 'function') renderWorkflowHeader();
    if (typeof renderWorkflowStages === 'function') renderWorkflowStages();
  }

  // Optimistic update
  _applyLeadStatus(newStatus);

  try {
    await PATCH_REQ(`/api/contacts/${contactId}`, { hs_lead_status: newStatus });
    // PATCH succeeded — server now has the new value, so no longer pending.
    if (state.pendingLeadStatus) delete state.pendingLeadStatus[contactId];
    // Refresh counts in the background so dropdown totals stay accurate.
    if (typeof loadLeadStatusCounts === 'function') {
      loadLeadStatusCounts().then(() => populateLeadStatusFilter()).catch(() => {});
    }
    const _nullLbl3 = (typeof NULL_LEAD_STATUS_LABEL !== 'undefined' ? NULL_LEAD_STATUS_LABEL : null) || 'No status';
    const newLabel = newStatus ? (LEAD_STATUS_OPTIONS.find(o => o.value === newStatus)?.label || newStatus) : null;
    showBottomUndo(newLabel ? `Lead status set to ${newLabel}` : `Lead status set to ${_nullLbl3}`, async () => {
      _applyLeadStatus(prevStatus || '');
      await PATCH_REQ(`/api/contacts/${contactId}`, { hs_lead_status: prevStatus || '' })
        .catch(() => {})
        .finally(() => {
          if (state.pendingLeadStatus) delete state.pendingLeadStatus[contactId];
          if (typeof loadLeadStatusCounts === 'function') {
            loadLeadStatusCounts().then(() => populateLeadStatusFilter()).catch(() => {});
          }
        });
    });
  } catch (e) {
    // Revert on failure: update pending to the reverted value, then clear once
    // we know the PATCH round-trip is done (no second request needed since we
    // never sent a successful change).
    _applyLeadStatus(prevStatus || '');
    if (state.pendingLeadStatus) delete state.pendingLeadStatus[contactId];
    if (e.code === 'HUBSPOT_AUTH') {
      showToast('Could not update lead status — HubSpot token is invalid or expired. Ask an admin to update the token.', true);
    } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
      showToast('Could not update lead status — HubSpot rate limit reached. Please try again in a moment.', true);
    } else if (e.code === 'HUBSPOT_VERIFY_FAILED') {
      showToast("Lead status didn't save in HubSpot — please try again.", true);
    } else {
      showToast('Failed to update lead status', true);
    }
  }
}
