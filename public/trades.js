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
let _tradeDeleteId = null;
let _tradeTypeFilter = '';
let _tradeAreaFilter = '';
const MAX_CONTACTS = 3;

function fmtTradeDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function tradeSkeletonHtml(namePct, badgeW, areasW, contactRow) {
  return `
    <div class="trades-card skeleton-trade-card">
      <div class="trades-card-top">
        <div class="trades-card-info">
          <div class="skeleton-line" style="height:14px;width:${namePct}%;margin-bottom:8px"></div>
          <div class="trades-card-trade-row">
            <div class="skeleton-line skeleton-pill" style="width:${badgeW}px;height:20px"></div>
            <div class="skeleton-line" style="height:11px;width:${areasW}px"></div>
          </div>
        </div>
        <div style="display:flex;gap:4px">
          <div class="skeleton-action-btn"></div>
          <div class="skeleton-action-btn"></div>
        </div>
      </div>
      ${contactRow ? `<div class="skeleton-contact-row">
        <div class="skeleton-line" style="height:11px;width:100px"></div>
        <div class="skeleton-line" style="height:11px;width:130px"></div>
      </div>` : ''}
    </div>`;
}

async function loadTradeContacts() {
  const list = document.getElementById('trades-list');
  if (!list) return;
  list.innerHTML = [
    tradeSkeletonHtml(58, 76, 100, true),
    tradeSkeletonHtml(45, 88, 80,  true),
    tradeSkeletonHtml(65, 68, 110, false),
    tradeSkeletonHtml(52, 80, 90,  true),
    tradeSkeletonHtml(70, 72, 95,  false),
  ].join('');
  try {
    _tradeContacts = await GET('/api/trades');
    populateTradeFilters();
    applyTradeFilters();
  } catch (e) {
    list.innerHTML = `<div class="trades-empty">Failed to load contacts: ${escHtml(e.message)}</div>`;
  }
}

function populateTradeFilters() {
  const typeSelect = document.getElementById('trades-filter-type');
  const areaSelect = document.getElementById('trades-filter-area');

  if (typeSelect) {
    const cur = typeSelect.value;
    typeSelect.innerHTML = `<option value="">All categories</option>` +
      TRADE_CATEGORIES.map(t => `<option value="${escHtml(t)}"${t === cur ? ' selected' : ''}>${escHtml(t)}</option>`).join('');
  }

  if (areaSelect) {
    const cur = areaSelect.value;
    areaSelect.innerHTML = `<option value="">All areas</option>` +
      TRADE_AREAS.map(a => `<option value="${escHtml(a)}"${a === cur ? ' selected' : ''}>${escHtml(a)}</option>`).join('');
  }
}

function applyTradeFilters() {
  const typeSelect = document.getElementById('trades-filter-type');
  const areaSelect = document.getElementById('trades-filter-area');
  const searchInput = document.getElementById('trades-search');
  _tradeTypeFilter = typeSelect ? typeSelect.value : '';
  _tradeAreaFilter = areaSelect ? areaSelect.value : '';
  const searchQuery = searchInput ? searchInput.value.trim().toLowerCase() : '';

  let filtered = _tradeContacts;
  if (searchQuery) {
    filtered = filtered.filter(co => (co.company_name || '').toLowerCase().includes(searchQuery));
  }
  if (_tradeTypeFilter) {
    filtered = filtered.filter(co => (co.trade_type || '').trim() === _tradeTypeFilter);
  }
  if (_tradeAreaFilter) {
    filtered = filtered.filter(co => {
      const areas = Array.isArray(co.areas_served) ? co.areas_served : [];
      return areas.includes(_tradeAreaFilter);
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
  list.querySelectorAll('.trades-copy-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      const value = btn.dataset.copy;
      if (!value) return;
      navigator.clipboard.writeText(value).then(() => {
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 1500);
      }).catch(() => {});
    });
  });
}

function tradeCardHtml(co) {
  const company = escHtml(co.company_name || '');
  const trade   = escHtml(co.trade_type   || '');
  const areasArr = Array.isArray(co.areas_served) ? co.areas_served : [];
  const areasDisplay = escHtml(areasArr.join(', '));
  const timescale  = escHtml(co.timescale      || '');
  const payTerms   = escHtml(co.payment_terms  || '');
  const invMethod  = escHtml(co.invoice_method || '');
  const notes      = escHtml(co.notes          || '');
  const id = co.id;

  const contactsHtml = (co.contacts || []).map(c => {
    const cName  = escHtml(c.name  || '');
    const cRole  = escHtml(c.role  || '');
    const cPhone = escHtml(c.phone || '');
    const cEmail = escHtml(c.email || '');
    const callBtn  = cPhone ? `<div class="trades-contact-action-group">
      <a href="tel:${cPhone}" class="trades-contact-action-btn trades-contact-call-btn" aria-label="Call ${cName} at ${cPhone}">
        <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/></svg>
        <span class="trades-contact-btn-inner"><span class="trades-contact-btn-label">Call</span><span class="trades-contact-btn-sub">${cPhone}</span></span></a>
      <button class="trades-copy-btn trades-copy-btn-call" data-copy="${cPhone}" aria-label="Copy phone number" title="Copy number" type="button">
        <svg width="11" height="11" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" stroke-width="2"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
      </button>
    </div>` : '';
    const emailBtn = cEmail ? `<div class="trades-contact-action-group">
      <a href="mailto:${cEmail}" class="trades-contact-action-btn trades-contact-email-btn" aria-label="Email ${cName} at ${cEmail}">
        <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
        <span class="trades-contact-btn-inner"><span class="trades-contact-btn-label">Email</span><span class="trades-contact-btn-sub">${cEmail}</span></span></a>
      <button class="trades-copy-btn trades-copy-btn-email" data-copy="${cEmail}" aria-label="Copy email address" title="Copy email" type="button">
        <svg width="11" height="11" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" stroke-width="2"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
      </button>
    </div>` : '';
    return `<div class="trades-card-person">
      <div class="trades-card-person-top">
        <span class="trades-card-person-name">${cName}</span>${cRole ? `<span class="trades-card-person-role">${cRole}</span>` : ''}
      </div>
      ${(callBtn || emailBtn) ? `<div class="trades-card-contact-row">${callBtn}${emailBtn}</div>` : ''}
    </div>`;
  }).join('');

  const detailParts = [];
  if (timescale)  detailParts.push(`<span class="trades-card-detail"><span class="trades-card-detail-label">Lead time:</span> ${timescale}</span>`);
  if (payTerms)   detailParts.push(`<span class="trades-card-detail"><span class="trades-card-detail-label">Payment:</span> ${payTerms}</span>`);
  if (invMethod)  detailParts.push(`<span class="trades-card-detail"><span class="trades-card-detail-label">Invoice via:</span> ${invMethod}</span>`);

  return `
    <div class="trades-card" data-id="${id}">
      <div class="trades-card-top">
        <div class="trades-card-info">
          <div class="trades-card-name">${company}</div>
          <div class="trades-card-trade-row">
            <span class="trades-card-trade-badge">${trade}</span>
            ${areasDisplay ? `<span class="trades-card-areas">${areasDisplay}</span>` : ''}
          </div>
        </div>
        <div class="trades-card-actions">
          <button class="trades-card-btn" onclick="openTradesModal(${id})" title="Edit" aria-label="Edit company">
            <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
            </svg>
          </button>
          <button class="trades-card-btn trades-card-btn-danger" onclick="openDeleteConfirm(${id})" title="Delete" aria-label="Delete company">
            <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
            </svg>
          </button>
        </div>
      </div>
      ${contactsHtml ? `<div class="trades-card-persons">${contactsHtml}</div>` : ''}
      ${detailParts.length ? `<div class="trades-card-details">${detailParts.join('')}</div>` : ''}
      ${notes ? `<div class="trades-card-notes">${notes}</div>` : ''}
      <div class="trades-card-audit">
        ${co.created_by_name
          ? `<span>Added by <strong>${escHtml(co.created_by_name)}</strong>${co.created_at ? ` · ${fmtTradeDate(co.created_at)}` : ''}</span>`
          : co.created_at ? `<span>Added ${fmtTradeDate(co.created_at)}</span>` : ''}
        ${co.updated_by_name
          ? `<span class="trades-card-audit-sep">·</span><span>Edited by <strong>${escHtml(co.updated_by_name)}</strong>${co.updated_at ? ` · ${fmtTradeDate(co.updated_at)}` : ''}</span>`
          : ''}
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
  return Array.from(slots).map((_, i) => ({
    name:  (document.getElementById(`tf-cname-${i}`)  || {}).value || '',
    role:  (document.getElementById(`tf-crole-${i}`)  || {}).value || '',
    phone: (document.getElementById(`tf-cphone-${i}`) || {}).value || '',
    email: (document.getElementById(`tf-cemail-${i}`) || {}).value || '',
  }));
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
    document.getElementById('tf-invoice-method').value = co.invoice_method  || '';
    document.getElementById('tf-payment-terms').value  = co.payment_terms   || '';
    document.getElementById('tf-notes').value          = co.notes           || '';
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
    title.textContent = 'Add Company';
    document.getElementById('trades-submit-btn').textContent = 'Save Company';
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
  if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Save Company'; }
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
    invoice_method: document.getElementById('tf-invoice-method').value.trim(),
    payment_terms:  document.getElementById('tf-payment-terms').value.trim(),
    notes:          document.getElementById('tf-notes').value.trim(),
    contacts,
  };

  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving…';

  try {
    if (editId) {
      const updated = await api('PUT', `/api/trades/${editId}`, body);
      const idx = _tradeContacts.findIndex(c => c.id === updated.id);
      if (idx !== -1) _tradeContacts[idx] = updated;
      showToast('Company updated');
    } else {
      const created = await POST('/api/trades', body);
      _tradeContacts.unshift(created);
      showToast('Company added');
    }
    closeTradesModal();
    populateTradeFilters();
    applyTradeFilters();
  } catch (err) {
    const msg = err.code === 'DB_ERROR'
      ? 'Couldn\'t save — a database error occurred. Please try again.'
      : (err.message || 'Failed to save company');
    showToast(msg, true);
    submitBtn.disabled = false;
    submitBtn.textContent = editId ? 'Save Changes' : 'Save Company';
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
