// ── Trades Directory ──────────────────────────────────────────────────────────
let _tradeContacts = [];
let _tradeDeleteId = null;

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
    renderTradeContacts(_tradeContacts);
  } catch (e) {
    list.innerHTML = `<div class="trades-empty">Failed to load contacts: ${escHtml(e.message)}</div>`;
  }
}

function filterTradeContacts(query) {
  const q = (query || '').toLowerCase().trim();
  if (!q) return renderTradeContacts(_tradeContacts);
  const filtered = _tradeContacts.filter(c =>
    (c.name        || '').toLowerCase().includes(q) ||
    (c.trade_type  || '').toLowerCase().includes(q) ||
    (c.areas_served|| '').toLowerCase().includes(q) ||
    (c.company_name|| '').toLowerCase().includes(q)
  );
  renderTradeContacts(filtered);
}

function renderTradeContacts(contacts) {
  const list = document.getElementById('trades-list');
  if (!list) return;
  if (!contacts.length) {
    list.innerHTML = '<div class="trades-empty">No trade contacts found.</div>';
    return;
  }
  list.innerHTML = contacts.map(tradeCardHtml).join('');
}

function tradeCardHtml(c) {
  const name    = escHtml(c.name || '');
  const trade   = escHtml(c.trade_type || '');
  const areas   = escHtml(c.areas_served || '');
  const company = escHtml(c.company_name || '');
  const phone   = escHtml(c.phone || '');
  const email   = escHtml(c.email || '');
  const timescale   = escHtml(c.timescale || '');
  const payTerms    = escHtml(c.payment_terms || '');
  const invMethod   = escHtml(c.invoice_method || '');
  const notes   = escHtml(c.notes || '');
  const id      = c.id;

  const phoneLine  = phone  ? `<a href="tel:${phone}" class="trades-card-link">${phone}</a>` : '';
  const emailLine  = email  ? `<a href="mailto:${email}" class="trades-card-link">${email}</a>` : '';
  const companyLine = company ? `<span class="trades-card-company">${company}</span>` : '';

  const detailParts = [];
  if (timescale)  detailParts.push(`<span class="trades-card-detail"><span class="trades-card-detail-label">Lead time:</span> ${timescale}</span>`);
  if (payTerms)   detailParts.push(`<span class="trades-card-detail"><span class="trades-card-detail-label">Payment:</span> ${payTerms}</span>`);
  if (invMethod)  detailParts.push(`<span class="trades-card-detail"><span class="trades-card-detail-label">Invoice via:</span> ${invMethod}</span>`);

  return `
    <div class="trades-card" data-id="${id}">
      <div class="trades-card-top">
        <div class="trades-card-info">
          <div class="trades-card-name">${name}</div>
          <div class="trades-card-trade-row">
            <span class="trades-card-trade-badge">${trade}</span>
            ${areas ? `<span class="trades-card-areas">${areas}</span>` : ''}
          </div>
          ${companyLine}
        </div>
        <div class="trades-card-actions">
          <button class="trades-card-btn" onclick="openTradesModal(${id})" title="Edit" aria-label="Edit contact">
            <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
            </svg>
          </button>
          <button class="trades-card-btn trades-card-btn-danger" onclick="openDeleteConfirm(${id})" title="Delete" aria-label="Delete contact">
            <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
            </svg>
          </button>
        </div>
      </div>
      ${(phoneLine || emailLine) ? `
      <div class="trades-card-contact-row">
        ${phoneLine}
        ${emailLine}
      </div>` : ''}
      ${detailParts.length ? `<div class="trades-card-details">${detailParts.join('')}</div>` : ''}
      ${notes ? `<div class="trades-card-notes">${notes}</div>` : ''}
    </div>`;
}

function openTradesModal(id) {
  const modal   = document.getElementById('trades-modal');
  const overlay = document.getElementById('trades-modal-overlay');
  const title   = document.getElementById('trades-modal-title');
  const editId  = document.getElementById('trades-edit-id');

  resetTradesForm();

  if (id) {
    const contact = _tradeContacts.find(c => c.id === id);
    if (!contact) return;
    title.textContent = 'Edit Contact';
    editId.value = id;
    document.getElementById('tf-name').value           = contact.name || '';
    document.getElementById('tf-trade').value          = contact.trade_type || '';
    document.getElementById('tf-phone').value          = contact.phone || '';
    document.getElementById('tf-email').value          = contact.email || '';
    document.getElementById('tf-areas').value          = contact.areas_served || '';
    document.getElementById('tf-company').value        = contact.company_name || '';
    document.getElementById('tf-timescale').value      = contact.timescale || '';
    document.getElementById('tf-invoice-method').value = contact.invoice_method || '';
    document.getElementById('tf-payment-terms').value  = contact.payment_terms || '';
    document.getElementById('tf-notes').value          = contact.notes || '';
    document.getElementById('trades-submit-btn').textContent = 'Save Changes';
  } else {
    title.textContent = 'Add Contact';
    document.getElementById('trades-submit-btn').textContent = 'Save Contact';
  }

  overlay.classList.remove('hidden');
  modal.classList.add('trades-modal-open');
  modal.setAttribute('aria-hidden', 'false');
  document.getElementById('tf-name').focus();
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
  if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Save Contact'; }
}

async function saveTradeContact(e) {
  e.preventDefault();
  const submitBtn = document.getElementById('trades-submit-btn');
  const editId    = document.getElementById('trades-edit-id').value;
  const body = {
    name:           document.getElementById('tf-name').value.trim(),
    trade_type:     document.getElementById('tf-trade').value.trim(),
    phone:          document.getElementById('tf-phone').value.trim(),
    email:          document.getElementById('tf-email').value.trim(),
    areas_served:   document.getElementById('tf-areas').value.trim(),
    company_name:   document.getElementById('tf-company').value.trim(),
    timescale:      document.getElementById('tf-timescale').value.trim(),
    invoice_method: document.getElementById('tf-invoice-method').value.trim(),
    payment_terms:  document.getElementById('tf-payment-terms').value.trim(),
    notes:          document.getElementById('tf-notes').value.trim(),
  };

  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving…';

  try {
    if (editId) {
      const updated = await api('PUT', `/api/trades/${editId}`, body);
      const idx = _tradeContacts.findIndex(c => c.id === updated.id);
      if (idx !== -1) _tradeContacts[idx] = updated;
      showToast('Contact updated');
    } else {
      const created = await POST('/api/trades', body);
      _tradeContacts.unshift(created);
      showToast('Contact added');
    }
    closeTradesModal();
    const searchInput = document.getElementById('trades-search');
    filterTradeContacts(searchInput ? searchInput.value : '');
  } catch (err) {
    showToast(err.message || 'Failed to save contact', true);
    submitBtn.disabled = false;
    submitBtn.textContent = editId ? 'Save Changes' : 'Save Contact';
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
    const searchInput = document.getElementById('trades-search');
    filterTradeContacts(searchInput ? searchInput.value : '');
    showToast('Contact deleted');
  } catch (err) {
    showToast(err.message || 'Failed to delete contact', true);
    btn.disabled = false;
    btn.textContent = 'Delete';
  }
}
