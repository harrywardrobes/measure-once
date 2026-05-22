// ── Trades Directory ──────────────────────────────────────────────────────────
const TRADE_CATEGORIES = [
  'Carpentry / Roofing',
  'Carpet Fitting',
  'Electrical',
  'Handyman Services',
  'Internal Joinery',
  'Landscaping / Outdoors',
  'Painting + Decorating',
  'Plasterer',
  'Plumbing',
];

const TRADE_AREAS = [
  'Anglesey',
  'Chester Only',
  'Cheshire',
  'Greater Manchester',
  'Liverpool',
  'North Wales',
  'Wirral',
  'Wrexham',
];

let _tradeContacts = [];
window._cpGetTradeContacts = function () { return _tradeContacts; };
let _tradeDeleteId = null;
let _tradeTypeFilter = (() => { try { return localStorage.getItem('tradesTypeFilter') || ''; } catch (_) { return ''; } })();
let _tradeAreaFilter = '';
let _tradeSearch = '';
const MAX_CONTACTS = 3;

const TRADE_TYPE_COLORS = {
  'Electrical':              '#f59e0b',
  'Plumbing':                '#3b82f6',
  'Carpentry / Roofing':     '#f97316',
  'Carpet Fitting':          '#ec4899',
  'Handyman Services':       '#14b8a6',
  'Internal Joinery':        '#92400e',
  'Landscaping / Outdoors':  '#22c55e',
  'Painting + Decorating':   '#8b5cf6',
  'Plasterer':               '#94a3b8',
  'Structural Steel':        '#64748b',
  'Concrete':                '#a8a29e',
};
function tradeTypeColor(type) {
  return TRADE_TYPE_COLORS[type] || '#9ca3af';
}

function fmtTradeDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function tradeSkeletonHtml(namePct, badgeW, chipCount) {
  const chips = Array.from({length: chipCount}, () =>
    `<div class="skeleton-line skeleton-pill" style="width:${80 + Math.random()*40|0}px;height:32px;border-radius:16px"></div>`
  ).join('');
  return `
    <div class="trades-row-skeleton">
      <div class="skel-bar skeleton-line" style="width:5px;height:56px;border-radius:3px;flex-shrink:0"></div>
      <div class="skel-left" style="flex:0 0 28%;display:flex;flex-direction:column;gap:6px">
        <div class="skeleton-line" style="height:14px;width:${namePct}%"></div>
        <div class="skeleton-line skeleton-pill" style="width:${badgeW}px;height:18px"></div>
        <div class="skeleton-line" style="height:11px;width:70%"></div>
      </div>
      <div class="skel-mid" style="flex:1;display:flex;gap:8px;flex-wrap:wrap">${chips}</div>
      <div class="skel-right" style="flex:0 0 18%;display:flex;flex-direction:column;align-items:flex-end;gap:8px">
        <div class="skeleton-line skeleton-pill" style="width:80px;height:22px"></div>
      </div>
    </div>`;
}

async function loadTradeContacts() {
  const list = document.getElementById('trades-list');
  if (!list) return;
  list.innerHTML = [
    tradeSkeletonHtml(58, 76, 1),
    tradeSkeletonHtml(45, 88, 2),
    tradeSkeletonHtml(65, 68, 1),
    tradeSkeletonHtml(52, 80, 2),
    tradeSkeletonHtml(70, 72, 1),
  ].join('');
  try {
    _tradeContacts = await GET('/api/trades');
    populateTradeFilters();
    applyTradeFilters();
  } catch (e) {
    const isDbError = e.code === 'DB_ERROR';
    const msg = isDbError
      ? 'The contacts list couldn\'t be loaded — there was a problem reaching the database.'
      : `Failed to load contacts: ${escHtml(e.message)}`;
    list.innerHTML = `
      <div class="trades-empty">
        <p>${msg}</p>
        <button onclick="loadTradeContacts()" style="margin-top:0.75rem;padding:0.4rem 1rem;border:1px solid #6b7280;border-radius:0.375rem;background:#f9fafb;cursor:pointer;font-size:0.875rem;">Retry</button>
        ${isDbError ? '<p style="margin-top:0.5rem;font-size:0.8rem;color:#6b7280;">If this keeps happening, try refreshing the page.</p>' : ''}
      </div>`;
  }
}

function populateTradeFilters() {
  const tabsEl = document.getElementById('trades-type-tabs');
  if (!tabsEl) return;
  const types = [...new Set(_tradeContacts.map(c => c.trade_type).filter(Boolean))].sort();
  const all = ['All', ...types];
  tabsEl.innerHTML = all.map(t => {
    const val = t === 'All' ? '' : t;
    const active = _tradeTypeFilter === val;
    return `<button type="button" class="trades-type-tab${active ? ' active' : ''}" data-type="${escHtml(val)}" role="tab" aria-selected="${active}">${escHtml(t)}</button>`;
  }).join('');
  tabsEl.querySelectorAll('.trades-type-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      _tradeTypeFilter = btn.dataset.type;
      try { localStorage.setItem('tradesTypeFilter', _tradeTypeFilter); } catch (_) {}
      tabsEl.querySelectorAll('.trades-type-tab').forEach(b => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
      });
      applyTradeFilters();
    });
  });
}

function applyTradeFilters() {
  const searchEl = document.getElementById('trades-search');
  _tradeSearch = searchEl ? searchEl.value.toLowerCase().trim() : '';

  let filtered = _tradeContacts;
  if (_tradeTypeFilter) {
    filtered = filtered.filter(co => (co.trade_type || '').trim() === _tradeTypeFilter);
  }
  if (_tradeSearch) {
    filtered = filtered.filter(co => {
      const name = (co.company_name || '').toLowerCase();
      const contactNames = (co.contacts || []).map(c => (c.name || '').toLowerCase()).join(' ');
      return name.includes(_tradeSearch) || contactNames.includes(_tradeSearch);
    });
  }
  renderTradeContacts(filtered);
}

function renderTradeContacts(contacts) {
  const list = document.getElementById('trades-list');
  if (!list) return;
  if (!contacts.length) {
    list.innerHTML = '<div class="trades-empty">No trade companies found.</div>';
    return;
  }
  list.innerHTML = contacts.map(tradeCardHtml).join('');

  list.querySelectorAll('.trades-chip').forEach(chip => {
    chip.addEventListener('click', e => {
      e.stopPropagation();
      const wrap = chip.closest('.trades-chip-wrap');
      const popover = wrap?.querySelector('.trades-chip-popover');
      if (!popover) return;
      const isOpen = popover.classList.contains('open');
      document.querySelectorAll('.trades-chip-popover.open').forEach(p => p.classList.remove('open'));
      if (!isOpen) popover.classList.add('open');
    });
  });

  list.querySelectorAll('.trades-chip-popover').forEach(pop => {
    pop.addEventListener('click', e => e.stopPropagation());
  });
}

function tradeCardHtml(co) {
  const company    = escHtml(co.company_name || '');
  const tradeType  = escHtml(co.trade_type   || '');
  const areasArr   = Array.isArray(co.areas_served) ? co.areas_served : [];
  const areasDisplay = escHtml(areasArr.join(', '));
  const timescale  = escHtml(co.timescale    || '');
  const notes      = escHtml(co.notes        || '');
  const id         = co.id;
  const barColor   = tradeTypeColor(co.trade_type || '');
  const badgeBg    = barColor + '18';
  const isPriv     = ['manager','admin'].includes(state?.user?.privilege_level);

  const coWebsite      = co.website      || '';
  const coCompanyPhone = co.company_phone || '';

  // ── Contact chips (middle column) ─────────────────────────────────────────
  const chipsHtml = (co.contacts || []).map((c, idx) => {
    const cName   = escHtml(c.name  || '');
    const cRole   = escHtml(c.role  || '');
    const cPhone  = c.phone || '';
    const cEmail  = c.email || '';
    const pref    = (c.preferred_contact || '').toLowerCase();
    const prefPhone = pref.includes('phone') || pref.includes('call') || pref.includes('whatsapp');
    const prefEmail = pref.includes('email');
    const initials  = (c.name || '').trim().split(/\s+/).map(n => n[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

    const popActions = [
      cPhone ? `<a href="tel:${escHtml(cPhone)}" class="trades-popover-action trades-popover-call${prefPhone ? ' preferred' : ''}" aria-label="Call ${cName}">
        <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/></svg>
        <span class="trades-popover-action-text">${escHtml(cPhone)}${prefPhone ? '<span class="trades-popover-pref">Preferred</span>' : ''}</span>
      </a>` : '',
      cEmail ? `<a href="mailto:${escHtml(cEmail)}" class="trades-popover-action trades-popover-email${prefEmail ? ' preferred' : ''}" aria-label="Email ${cName}">
        <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
        <span class="trades-popover-action-text">${escHtml(cEmail)}${prefEmail ? '<span class="trades-popover-pref">Preferred</span>' : ''}</span>
      </a>` : '',
    ].filter(Boolean).join('');

    return `<div class="trades-chip-wrap">
      <button type="button" class="trades-chip" aria-haspopup="true" aria-label="Contact ${cName}">
        <span class="trades-chip-avatar">${initials}</span>
        <span class="trades-chip-info">
          <span class="trades-chip-name">${cName}</span>
          ${cRole ? `<span class="trades-chip-role">${cRole}</span>` : ''}
        </span>
      </button>
      <div class="trades-chip-popover" role="dialog" aria-label="${cName} contact options">
        <div class="trades-popover-header">
          <span class="trades-popover-avatar">${initials}</span>
          <div>
            <div class="trades-popover-name">${cName}</div>
            ${cRole ? `<div class="trades-popover-role">${cRole}</div>` : ''}
          </div>
        </div>
        <div class="trades-popover-actions">${popActions || '<p class="trades-popover-empty">No contact details</p>'}</div>
      </div>
    </div>`;
  }).join('');

  // ── Middle meta: notes + website + company phone ──────────────────────────
  const websiteDisplay = coWebsite ? escHtml(coWebsite.replace(/^https?:\/\//, '')) : '';
  const midMetaHtml = [
    notes       ? `<div class="trades-row-notes">"${notes}"</div>` : '',
    coWebsite && safeUrl(coWebsite)   ? `<div class="trades-row-meta-link"><svg width="11" height="11" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" stroke-width="2"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2 12h20M12 2a15.3 15.3 0 010 20M12 2a15.3 15.3 0 000 20"/></svg><a href="${escHtml(safeUrl(coWebsite))}" target="_blank" rel="noopener noreferrer" class="trades-card-link">${websiteDisplay}</a></div>` : '',
    coCompanyPhone ? `<div class="trades-row-meta-link"><svg width="11" height="11" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/></svg><a href="tel:${escHtml(coCompanyPhone)}" class="trades-card-link">${escHtml(coCompanyPhone)}</a></div>` : '',
  ].filter(Boolean).join('');

  // ── Right column: lead time + admin actions ────────────────────────────────
  const leadHtml = timescale ? `<span class="trades-row-lead">
    <svg width="11" height="11" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" stroke-width="2"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 6v6l4 2"/></svg>
    Lead: ${timescale}
  </span>` : '';

  const actionsHtml = isPriv ? `<div class="trades-row-actions">
    <button class="trades-card-btn" onclick="openTradesModal(${id})" title="Edit" aria-label="Edit company">
      <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
    </button>
    <button class="trades-card-btn trades-card-btn-danger" onclick="openDeleteConfirm(${id})" title="Delete" aria-label="Delete company">
      <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
    </button>
  </div>` : '';

  // ── Audit line ─────────────────────────────────────────────────────────────
  const auditParts = [];
  if (co.created_by_name) auditParts.push(`Added by <strong>${escHtml(co.created_by_name)}</strong>${co.created_at ? ` · ${fmtTradeDate(co.created_at)}` : ''}`);
  else if (co.created_at)  auditParts.push(`Added ${fmtTradeDate(co.created_at)}`);
  if (co.updated_by_name)  auditParts.push(`Edited by <strong>${escHtml(co.updated_by_name)}</strong>${co.updated_at ? ` · ${fmtTradeDate(co.updated_at)}` : ''}`);

  return `
    <div class="trades-row" data-id="${id}">
      <div class="trades-row-bar" style="background:${barColor}" aria-hidden="true"></div>
      <div class="trades-row-body">
        <div class="trades-row-cols">
          <div class="trades-row-left">
            <h3 class="trades-row-company">${company}</h3>
            <span class="trades-row-badge" style="background:${badgeBg};color:${barColor};border-color:${barColor}33">${tradeType}</span>
            ${areasDisplay ? `<div class="trades-row-areas">
              <svg width="11" height="11" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
              ${areasDisplay}
            </div>` : ''}
          </div>
          <div class="trades-row-mid">
            ${chipsHtml ? `<div class="trades-row-chips">${chipsHtml}</div>` : ''}
            ${midMetaHtml}
          </div>
          <div class="trades-row-right">
            ${leadHtml}
            ${actionsHtml}
          </div>
        </div>
        ${auditParts.length ? `<div class="trades-row-audit">${auditParts.join('<span class="trades-card-audit-sep"> · </span>')}</div>` : ''}
      </div>
    </div>`;
}

// ── Contact slot management ────────────────────────────────────────────────────

function contactSlotHtml(index, data) {
  const isFirst = index === 0;
  const name  = escHtml(data?.name  || '');
  const role  = escHtml(data?.role  || '');
  const phone = escHtml(data?.phone || '');
  const email = escHtml(data?.email || '');
  const prefVal = (data?.preferred_contact || '').trim();
  return `
    <div class="trades-contact-slot" data-slot="${index}">
      <div class="trades-contact-slot-header">
        <span class="trades-contact-slot-label">Contact ${index + 1}</span>
        ${!isFirst ? `<button type="button" class="trades-contact-remove-btn" onclick="removeContactSlot(${index})" aria-label="Remove contact ${index + 1}">
          <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>` : ''}
      </div>
      <div class="trades-form-row trades-form-row-2">
        <div class="trades-field">
          <label class="trades-label" for="tf-cname-${index}">Full name${isFirst ? ' <span class="trades-required">*</span>' : ''}</label>
          <input class="trades-input" id="tf-cname-${index}" type="text" placeholder="e.g. John Smith" value="${name}"${isFirst ? ' required' : ''}>
        </div>
        <div class="trades-field">
          <label class="trades-label" for="tf-crole-${index}">Role / job title</label>
          <input class="trades-input" id="tf-crole-${index}" type="text" placeholder="e.g. Director, Site Manager" value="${role}">
        </div>
      </div>
      <div class="trades-form-row trades-form-row-2">
        <div class="trades-field">
          <label class="trades-label" for="tf-cphone-${index}">Phone number</label>
          <input class="trades-input" id="tf-cphone-${index}" type="tel" placeholder="e.g. 07700 900123" value="${phone}">
        </div>
        <div class="trades-field">
          <label class="trades-label" for="tf-cemail-${index}">Email address</label>
          <input class="trades-input" id="tf-cemail-${index}" type="email" placeholder="e.g. john@example.com" value="${email}">
        </div>
      </div>
      <div class="trades-form-row">
        <div class="trades-field">
          <label class="trades-label">Preferred contact method</label>
          <div class="trades-areas-group">
            <label class="trades-area-chip"><input type="radio" name="tf-cpref-${index}" value="Phone call"${prefVal === 'Phone call' ? ' checked' : ''}> Phone call</label>
            <label class="trades-area-chip"><input type="radio" name="tf-cpref-${index}" value="WhatsApp"${prefVal === 'WhatsApp' ? ' checked' : ''}> WhatsApp</label>
            <label class="trades-area-chip"><input type="radio" name="tf-cpref-${index}" value="Email"${prefVal === 'Email' ? ' checked' : ''}> Email</label>
          </div>
        </div>
      </div>
    </div>`;
}

function getSlotCount() {
  return document.querySelectorAll('#trades-contacts-list .trades-contact-slot').length;
}

function addContactSlot(data) {
  const list = document.getElementById('trades-contacts-list');
  const btn  = document.getElementById('trades-add-contact-btn');
  if (!list) return;
  const index = getSlotCount();
  if (index >= MAX_CONTACTS) return;
  list.insertAdjacentHTML('beforeend', contactSlotHtml(index, data || {}));
  if (getSlotCount() >= MAX_CONTACTS) btn.style.display = 'none';
}

function removeContactSlot(index) {
  const slot = document.querySelector(`#trades-contacts-list .trades-contact-slot[data-slot="${index}"]`);
  if (!slot) return;
  const existingData = collectContactSlots();
  existingData.splice(index, 1);
  rebuildContactSlots(existingData);
}

function rebuildContactSlots(dataArr) {
  const list = document.getElementById('trades-contacts-list');
  const btn  = document.getElementById('trades-add-contact-btn');
  if (!list) return;
  list.innerHTML = '';
  dataArr.slice(0, MAX_CONTACTS).forEach((d, i) => list.insertAdjacentHTML('beforeend', contactSlotHtml(i, d)));
  btn.style.display = getSlotCount() >= MAX_CONTACTS ? 'none' : '';
}

function collectContactSlots() {
  const slots = document.querySelectorAll('#trades-contacts-list .trades-contact-slot');
  return Array.from(slots).map((_, i) => {
    const prefEl = document.querySelector(`#trades-contacts-list .trades-contact-slot[data-slot="${i}"] input[type="radio"]:checked`);
    return {
      name:             (document.getElementById(`tf-cname-${i}`)  || {}).value || '',
      role:             (document.getElementById(`tf-crole-${i}`)  || {}).value || '',
      phone:            (document.getElementById(`tf-cphone-${i}`) || {}).value || '',
      email:            (document.getElementById(`tf-cemail-${i}`) || {}).value || '',
      preferred_contact: prefEl ? prefEl.value : '',
    };
  });
}

function collectAreasServed() {
  const checkboxes = document.querySelectorAll('#tf-areas-group input[type="checkbox"]:checked');
  return Array.from(checkboxes).map(cb => cb.value);
}

// ── Modal open / close ─────────────────────────────────────────────────────────

function openTradesModal(id) {
  const modal   = document.getElementById('trades-modal');
  const overlay = document.getElementById('trades-modal-overlay');
  const title   = document.getElementById('trades-modal-title');
  const editId  = document.getElementById('trades-edit-id');

  resetTradesForm();

  if (id) {
    const co = _tradeContacts.find(c => c.id === id);
    if (!co) return;
    title.textContent = 'Edit Company';
    editId.value = id;
    document.getElementById('tf-company').value        = co.company_name    || '';
    const catSelect = document.getElementById('tf-category');
    if (catSelect) catSelect.value = co.trade_type || '';
    const currentAreas = Array.isArray(co.areas_served) ? co.areas_served : [];
    document.querySelectorAll('#tf-areas-group input[type="checkbox"]').forEach(cb => {
      cb.checked = currentAreas.includes(cb.value);
    });
    document.getElementById('tf-timescale').value      = co.timescale       || '';
    document.getElementById('tf-notes').value          = co.notes           || '';
    document.getElementById('tf-website').value        = co.website         || '';
    document.getElementById('tf-company-phone').value  = co.company_phone   || '';
    const existingContacts = (co.contacts || []).length ? co.contacts : [{}];
    rebuildContactSlots(existingContacts);
    document.getElementById('trades-submit-btn').textContent = 'Save Changes';

    const auditEl = document.getElementById('trades-modal-audit');
    const parts = [];
    if (co.created_by_name) {
      parts.push(`Added by <strong>${escHtml(co.created_by_name)}</strong>${co.created_at ? ` · ${fmtTradeDate(co.created_at)}` : ''}`);
    } else if (co.created_at) {
      parts.push(`Added ${fmtTradeDate(co.created_at)}`);
    }
    if (co.updated_by_name) {
      parts.push(`Edited by <strong>${escHtml(co.updated_by_name)}</strong>${co.updated_at ? ` · ${fmtTradeDate(co.updated_at)}` : ''}`);
    } else if (co.updated_at) {
      parts.push(`Edited ${fmtTradeDate(co.updated_at)}`);
    }
    if (parts.length) {
      auditEl.innerHTML = parts.join('<span class="trades-modal-audit-sep"> · </span>');
      auditEl.classList.remove('hidden');
    }

    const historySection = document.getElementById('trades-history-section');
    const historyList    = document.getElementById('trades-history-list');
    if (historySection && historyList) {
      historySection.classList.remove('hidden');
      historySection.removeAttribute('open');
      historyList.innerHTML = '<div class="trades-history-loading"><div class="spinner spinner-sm"></div> Loading…</div>';
      loadTradeAuditLog(id, historyList);
    }
  } else {
    const isAdmin = (window.state?.user?.privilege_level === 'admin');
    title.textContent = 'Add Trade Company';
    document.getElementById('trades-submit-btn').textContent = isAdmin ? 'Add Company' : 'Submit for Approval';
    rebuildContactSlots([{}]);
  }

  overlay.classList.remove('hidden');
  modal.classList.add('trades-modal-open');
  modal.setAttribute('aria-hidden', 'false');
  document.getElementById('tf-company').focus();
}

function closeTradesModal() {
  const modal   = document.getElementById('trades-modal');
  const overlay = document.getElementById('trades-modal-overlay');
  modal.classList.remove('trades-modal-open');
  modal.setAttribute('aria-hidden', 'true');
  overlay.classList.add('hidden');
  resetTradesForm();
}

function resetTradesForm() {
  document.getElementById('trades-form').reset();
  document.getElementById('trades-edit-id').value = '';
  const submitBtn = document.getElementById('trades-submit-btn');
  if (submitBtn) {
    const isAdmin = (window.state?.user?.privilege_level === 'admin');
    submitBtn.disabled = false;
    submitBtn.textContent = isAdmin ? 'Add Company' : 'Submit for Approval';
  }
  const list = document.getElementById('trades-contacts-list');
  if (list) list.innerHTML = '';
  const btn = document.getElementById('trades-add-contact-btn');
  if (btn) btn.style.display = '';
  const auditEl = document.getElementById('trades-modal-audit');
  if (auditEl) { auditEl.innerHTML = ''; auditEl.classList.add('hidden'); }
  const historySection = document.getElementById('trades-history-section');
  if (historySection) {
    historySection.classList.add('hidden');
    historySection.removeAttribute('open');
  }
  const historyList = document.getElementById('trades-history-list');
  if (historyList) {
    historyList.dataset.auditFor = '';
    historyList.innerHTML = '<div class="trades-history-loading"><div class="spinner spinner-sm"></div> Loading…</div>';
  }
}

async function loadTradeAuditLog(companyId, containerEl) {
  containerEl.dataset.auditFor = companyId;
  try {
    const entries = await fetch(`/api/trades/${companyId}/audit`).then(r => r.json());
    if (containerEl.dataset.auditFor !== String(companyId)) return;
    if (!entries || entries.error) {
      containerEl.innerHTML = '<div class="trades-history-empty">Could not load history.</div>';
      return;
    }
    if (!entries.length) {
      containerEl.innerHTML = '<div class="trades-history-empty">No history recorded yet.</div>';
      return;
    }
    containerEl.innerHTML = entries.map(e => `
      <div class="trades-history-entry">
        <span class="trades-history-action">${escHtml(e.action)}</span>
        <span class="trades-history-meta">${e.actor_name ? `<strong>${escHtml(e.actor_name)}</strong> · ` : ''}${fmtTradeDate(e.changed_at)}</span>
      </div>
    `).join('');
  } catch {
    if (containerEl.dataset.auditFor !== String(companyId)) return;
    containerEl.innerHTML = '<div class="trades-history-empty">Could not load history.</div>';
  }
}

async function saveTradeContact(e) {
  e.preventDefault();
  const submitBtn = document.getElementById('trades-submit-btn');
  const editId    = document.getElementById('trades-edit-id').value;

  const contacts = collectContactSlots().filter(c => c.name.trim());
  if (!contacts.length) {
    showToast('At least one contact with a name is required', true);
    return;
  }

  const categoryEl = document.getElementById('tf-category');
  const trade_type = categoryEl ? categoryEl.value.trim() : '';
  if (!trade_type) {
    showToast('Please select a category', true);
    return;
  }

  const body = {
    company_name:   document.getElementById('tf-company').value.trim(),
    trade_type,
    areas_served:   collectAreasServed(),
    timescale:      document.getElementById('tf-timescale').value.trim(),
    notes:          document.getElementById('tf-notes').value.trim(),
    website:        (document.getElementById('tf-website')       || {}).value || '',
    company_phone:  (document.getElementById('tf-company-phone') || {}).value || '',
    contacts,
  };

  const isAdmin = (window.state?.user?.privilege_level === 'admin');
  submitBtn.disabled = true;
  submitBtn.textContent = editId ? 'Saving…' : (isAdmin ? 'Adding…' : 'Submitting…');

  try {
    if (editId) {
      const updated = await api('PUT', `/api/trades/${editId}`, body);
      const idx = _tradeContacts.findIndex(c => c.id === updated.id);
      if (idx !== -1) _tradeContacts[idx] = updated;
      closeTradesModal();
      populateTradeFilters();
      applyTradeFilters();
      showToast('Company updated');
    } else if (isAdmin) {
      const created = await POST('/api/trades', body);
      _tradeContacts.push(created);
      closeTradesModal();
      populateTradeFilters();
      applyTradeFilters();
      showToast('Company added');
    } else {
      await POST('/api/trades/submissions', body);
      closeTradesModal();
      showToast('Submitted — an admin will review it before it appears in the list');
    }
  } catch (err) {
    const msg = err.code === 'DB_ERROR'
      ? 'Couldn\'t save — a database error occurred. Please try again.'
      : (err.message || 'Failed to save company');
    showToast(msg, true);
    submitBtn.disabled = false;
    submitBtn.textContent = editId ? 'Save Changes' : (isAdmin ? 'Add Company' : 'Submit for Approval');
  }
}

function openDeleteConfirm(id) {
  _tradeDeleteId = id;
  document.getElementById('trades-delete-overlay').classList.remove('hidden');
  document.getElementById('trades-delete-modal').classList.add('trades-modal-open');
  document.getElementById('trades-delete-modal').setAttribute('aria-hidden', 'false');
}

function closeDeleteConfirm() {
  _tradeDeleteId = null;
  document.getElementById('trades-delete-overlay').classList.add('hidden');
  document.getElementById('trades-delete-modal').classList.remove('trades-modal-open');
  document.getElementById('trades-delete-modal').setAttribute('aria-hidden', 'true');
  const btn = document.getElementById('trades-delete-confirm-btn');
  if (btn) { btn.disabled = false; btn.textContent = 'Delete'; }
}

async function confirmDeleteTrade() {
  if (!_tradeDeleteId) return;
  const id = _tradeDeleteId;
  const btn = document.getElementById('trades-delete-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  try {
    await DELETE_REQ(`/api/trades/${id}`);
    _tradeContacts = _tradeContacts.filter(c => c.id !== id);
    closeDeleteConfirm();
    populateTradeFilters();
    applyTradeFilters();
    showToast('Company deleted');
  } catch (err) {
    const msg = err.code === 'DB_ERROR'
      ? 'Couldn\'t delete — a database error occurred. Please try again.'
      : (err.message || 'Failed to delete company');
    showToast(msg, true);
    btn.disabled = false;
    btn.textContent = 'Delete';
  }
}
