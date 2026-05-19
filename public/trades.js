// ── Trades Directory ──────────────────────────────────────────────────────────
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

  const types = [...new Set(_tradeContacts.map(co => (co.trade_type || '').trim()).filter(Boolean))].sort();
  if (typeSelect) {
    const cur = typeSelect.value;
    typeSelect.innerHTML = `<option value="">All services</option>` +
      types.map(t => `<option value="${escHtml(t)}"${t === cur ? ' selected' : ''}>${escHtml(t)}</option>`).join('');
  }

  const areas = [...new Set(
    _tradeContacts.flatMap(co =>
      (co.areas_served || '').split(',').map(a => a.trim()).filter(Boolean)
    )
  )].sort();
  if (areaSelect) {
    const cur = areaSelect.value;
    areaSelect.innerHTML = `<option value="">All areas</option>` +
      areas.map(a => `<option value="${escHtml(a)}"${a === cur ? ' selected' : ''}>${escHtml(a)}</option>`).join('');
  }
}

function applyTradeFilters() {
  const typeSelect = document.getElementById('trades-filter-type');
  const areaSelect = document.getElementById('trades-filter-area');
  _tradeTypeFilter = typeSelect ? typeSelect.value : '';
  _tradeAreaFilter = areaSelect ? areaSelect.value : '';

  let filtered = _tradeContacts;
  if (_tradeTypeFilter) {
    filtered = filtered.filter(co => (co.trade_type || '').trim() === _tradeTypeFilter);
  }
  if (_tradeAreaFilter) {
    filtered = filtered.filter(co => {
      const areas = (co.areas_served || '').split(',').map(a => a.trim());
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
}

function tradeCardHtml(co) {
  const company = escHtml(co.company_name || '');
  const trade   = escHtml(co.trade_type   || '');
  const areas   = escHtml(co.areas_served || '');
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
    const phoneLink = cPhone ? `<a href="tel:${cPhone}" class="trades-card-link">${cPhone}</a>` : '';
    const emailLink = cEmail ? `<a href="mailto:${cEmail}" class="trades-card-link">${cEmail}</a>` : '';
    return `<div class="trades-card-person">
      <div class="trades-card-person-top">
        <span class="trades-card-person-name">${cName}</span>${cRole ? `<span class="trades-card-person-role">${cRole}</span>` : ''}
      </div>
      ${(phoneLink || emailLink) ? `<div class="trades-card-contact-row">${phoneLink}${emailLink}</div>` : ''}
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
            ${areas ? `<span class="trades-card-areas">${areas}</span>` : ''}
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
    document.getElementById('tf-trade').value          = co.trade_type      || '';
    document.getElementById('tf-areas').value          = co.areas_served    || '';
    document.getElementById('tf-timescale').value      = co.timescale       || '';
    document.getElementById('tf-invoice-method').value = co.invoice_method  || '';
    document.getElementById('tf-payment-terms').value  = co.payment_terms   || '';
    document.getElementById('tf-notes').value          = co.notes           || '';
    const existingContacts = (co.contacts || []).length ? co.contacts : [{}];
    rebuildContactSlots(existingContacts);
    document.getElementById('trades-submit-btn').textContent = 'Save Changes';
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

  const body = {
    company_name:   document.getElementById('tf-company').value.trim(),
    trade_type:     document.getElementById('tf-trade').value.trim(),
    areas_served:   document.getElementById('tf-areas').value.trim(),
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
    showToast(err.message || 'Failed to save company', true);
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
    showToast(err.message || 'Failed to delete company', true);
    btn.disabled = false;
    btn.textContent = 'Delete';
  }
}
