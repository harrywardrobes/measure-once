// QuickBooks invoice list loader, currency/date formatters, and the
// shared invoice detail panel. Loaded by any page that surfaces invoices
// (home, invoices, sales, projects).

// ── QuickBooks ────────────────────────────────────────────────────────────────
async function loadQBInvoices() {
  state.qb.loadError  = false;
  state.qb.error      = null;
  state.qb.errorCode  = null;

  function _refreshInvoiceViews() {
    renderCustomerList();
    const homeEl  = document.getElementById('home-view');
    if (homeEl) renderHomeTab();
    const invEl   = document.getElementById('invoices-view');
    if (invEl) renderInvoicesTab();
    const wfInvEl = document.getElementById('invoices-section');
    if (wfInvEl) renderWorkflowInvoices();
    const projEl  = document.getElementById('projects-view');
    if (projEl) renderProjectsView();
  }

  try {
    const statusRes = await fetch('/api/quickbooks/status').catch(() => null);
    const status    = statusRes ? await statusRes.json().catch(() => ({ connected: false })) : { connected: false };
    state.qb.connected   = status.connected;
    state.qb.company     = status.company || null;
    state.qb.statusKnown = true;

    if (!status.connected) {
      const invEl  = document.getElementById('invoices-view');
      if (invEl) renderInvoicesTab();
      const projEl = document.getElementById('projects-view');
      if (projEl) renderProjectsView();
      return;
    }

    state.qb.loading = true;

    const res  = await fetch('/api/quickbooks/invoices');
    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.error) {
      const err  = new Error(data.error || `Server error ${res.status}`);
      err.code   = data.code || null;
      throw err;
    }

    state.qb.invoices = data.invoices || [];
    state.qb.loaded   = true;
    state.qb.loading  = false;
    _refreshInvoiceViews();
  } catch (e) {
    state.qb.loading   = false;
    state.qb.loadError = true;
    state.qb.error     = e.message || 'Failed to load invoices';
    state.qb.errorCode = e.code   || null;
    const invEl  = document.getElementById('invoices-view');
    if (invEl) renderInvoicesTab();
    const wfInvEl = document.getElementById('invoices-section');
    if (wfInvEl) renderWorkflowInvoices();
    const projEl = document.getElementById('projects-view');
    if (projEl) renderProjectsView();
  }
}

function matchInvoicesForContact(contact) {
  if (!state.qb.loaded || !state.qb.invoices.length) return [];
  const email = (contact.properties?.email || '').toLowerCase().trim();
  const name  = contactName(contact).toLowerCase().trim();
  return state.qb.invoices.filter(inv => {
    const custName  = (inv.customerName || '').toLowerCase().trim();
    const custEmail = (inv.email        || '').toLowerCase().trim();
    if (email && custEmail && email === custEmail) return true;
    if (name  && custName  && custName === name)   return true;
    return false;
  });
}

function fmtGBP(amount) {
  return '£' + Number(amount).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtQBDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

// ── Invoice Detail Panel ───────────────────────────────────────────────────────
async function openInvoicePanel(invId, allInvIds) {
  const panel   = document.getElementById('inv-panel');
  const overlay = document.getElementById('inv-overlay');
  const body    = document.getElementById('inv-panel-body');
  const title   = document.getElementById('inv-panel-title');
  const sub     = document.getElementById('inv-panel-sub');

  const ids = (allInvIds && allInvIds.length > 1) ? allInvIds : [invId];
  const idx = ids.indexOf(invId);
  state.qb.panelContext = { ids, index: idx >= 0 ? idx : 0 };

  panel.classList.add('inv-panel-open');
  overlay.classList.remove('hidden');
  body.innerHTML = `<div class="inv-panel-loading"><div class="spinner"></div> Loading…</div>`;
  title.textContent = 'Invoice';
  sub.textContent   = '';

  try {
    const inv = await fetch(`/api/quickbooks/invoice/${invId}`).then(r => r.json());
    if (inv.error) throw new Error(inv.error);
    state.qb.panel = inv;
    renderInvoicePanelBody();
    const draft = state.qb.draft && state.qb.draft[invId];
    if (draft) {
      _restoreInvFields(draft);
      window._invMemoDirty = true;
      if (draft.email !== null && draft.email !== (inv.email || '')) window._invSendDirty = true;
      if (typeof _updateBeforeUnloadGuard === 'function') _updateBeforeUnloadGuard();
      const msg = document.getElementById('inv-save-msg');
      if (msg) { msg.textContent = 'Unsaved changes restored'; msg.className = 'inv-action-msg inv-msg-ok'; }
      const discardBtn = document.getElementById('inv-discard-btn');
      if (discardBtn) discardBtn.classList.remove('hidden');
    }
  } catch (e) {
    body.innerHTML = `<div class="inv-panel-error">Failed to load invoice: ${escHtml(e.message)}</div>`;
  }
}

function _snapshotInvFields() {
  return {
    due:   document.getElementById('inv-edit-due')?.value ?? null,
    email: document.getElementById('inv-edit-email')?.value ?? null,
    memo:  document.getElementById('inv-edit-memo')?.value ?? null,
  };
}

function _invMarkDirty(sendDirty) {
  window._invMemoDirty = true;
  if (sendDirty) window._invSendDirty = true;
  const discardBtn = document.getElementById('inv-discard-btn');
  if (discardBtn) discardBtn.classList.remove('hidden');
  if (typeof _updateBeforeUnloadGuard === 'function') _updateBeforeUnloadGuard();
}

function _restoreInvFields(snapshot) {
  if (!snapshot) return;
  const due   = document.getElementById('inv-edit-due');
  const email = document.getElementById('inv-edit-email');
  const memo  = document.getElementById('inv-edit-memo');
  if (due   && snapshot.due   !== null) due.value   = snapshot.due;
  if (email && snapshot.email !== null) email.value = snapshot.email;
  if (memo  && snapshot.memo  !== null) memo.value  = snapshot.memo;
}

function discardInvoiceDraft() {
  const inv = state.qb.panel;
  if (!inv) return;
  if (state.qb.draft) delete state.qb.draft[inv.id];
  const due   = document.getElementById('inv-edit-due');
  const email = document.getElementById('inv-edit-email');
  const memo  = document.getElementById('inv-edit-memo');
  if (due)   due.value   = inv.dueDate || '';
  if (email) email.value = inv.email   || '';
  if (memo)  memo.value  = inv.memo    || '';
  window._invMemoDirty = false;
  window._invSendDirty = false;
  if (typeof _updateBeforeUnloadGuard === 'function') _updateBeforeUnloadGuard();
  const discardBtn = document.getElementById('inv-discard-btn');
  if (discardBtn) discardBtn.classList.add('hidden');
  const msg = document.getElementById('inv-save-msg');
  if (msg) { msg.textContent = 'Changes discarded'; msg.className = 'inv-action-msg inv-msg-ok'; }
}

async function navigateInvoicePanel(delta) {
  const ctx = state.qb.panelContext;
  if (!ctx) return;
  const newIdx = ctx.index + delta;
  if (newIdx < 0 || newIdx >= ctx.ids.length) return;
  if (window._invMemoDirty || window._invSendDirty) {
    const snapshot = _snapshotInvFields();
    const msg = window._invSendDirty && window._invMemoDirty
      ? 'You have unsaved changes and an unsent email update. Discard and continue?'
      : window._invSendDirty
        ? 'The customer email has been changed but not sent. Discard and continue?'
        : 'You have unsaved invoice changes. Discard and continue?';
    if (!confirm(msg)) { _restoreInvFields(snapshot); return; }
    window._invMemoDirty = false;
    window._invSendDirty = false;
  }
  ctx.index = newIdx;
  const ids = ctx.ids;
  await openInvoicePanel(ids[newIdx], ids);
}

async function jumpToInvoice(idx) {
  const ctx = state.qb.panelContext;
  if (!ctx) return;
  const i = parseInt(idx, 10);
  if (isNaN(i) || i < 0 || i >= ctx.ids.length || i === ctx.index) return;
  if (window._invMemoDirty || window._invSendDirty) {
    const snapshot = _snapshotInvFields();
    const msg = window._invSendDirty && window._invMemoDirty
      ? 'You have unsaved changes and an unsent email update. Discard and continue?'
      : window._invSendDirty
        ? 'The customer email has been changed but not sent. Discard and continue?'
        : 'You have unsaved invoice changes. Discard and continue?';
    if (!confirm(msg)) { _restoreInvFields(snapshot); return; }
    window._invMemoDirty = false;
    window._invSendDirty = false;
  }
  ctx.index = i;
  await openInvoicePanel(ctx.ids[i], ctx.ids);
}

function toggleInvoiceJumpDropdown(e) {
  e.stopPropagation();
  const dd = document.getElementById('inv-jump-dd');
  if (!dd) return;
  const isOpen = dd.classList.toggle('inv-jump-dropdown--open');
  const btn = dd.querySelector('.inv-jump-trigger');
  if (btn) btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
}

function closeInvoiceJumpDropdown() {
  const dd = document.getElementById('inv-jump-dd');
  if (!dd) return;
  dd.classList.remove('inv-jump-dropdown--open');
  const btn = dd.querySelector('.inv-jump-trigger');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', function(e) {
  const dd = document.getElementById('inv-jump-dd');
  if (dd && !dd.contains(e.target)) closeInvoiceJumpDropdown();
});

function closeInvoicePanel() {
  if (window._invMemoDirty || window._invSendDirty) {
    const msg = window._invSendDirty && window._invMemoDirty
      ? 'You have unsaved changes and an unsent email update. Discard and close?'
      : window._invSendDirty
        ? 'The customer email has been changed but not sent. Discard and close?'
        : 'You have unsaved invoice changes. Discard and close?';
    if (!confirm(msg)) return;
    const invId = state.qb.panel && state.qb.panel.id;
    if (invId) {
      if (!state.qb.draft) state.qb.draft = {};
      state.qb.draft[invId] = _snapshotInvFields();
    }
  }
  document.getElementById('inv-panel').classList.remove('inv-panel-open');
  document.getElementById('inv-overlay').classList.add('hidden');
  window._invMemoDirty = false;
  window._invSendDirty = false;
  if (typeof _updateBeforeUnloadGuard === 'function') _updateBeforeUnloadGuard();
  state.qb.panel = null;
  state.qb.panelContext = null;
}

function openInvoicePanelFromBadge(btn) {
  const ids = JSON.parse(btn.dataset.invIds || '[]');
  if (ids.length) openInvoicePanel(ids[0], ids);
}

function renderInvoicePanelBody() {
  const inv   = state.qb.panel;
  if (!inv) return;
  const title = document.getElementById('inv-panel-title');
  const sub   = document.getElementById('inv-panel-sub');
  const body  = document.getElementById('inv-panel-body');
  const ctx   = state.qb.panelContext;

  if (ctx && ctx.ids.length > 1) {
    const pos    = ctx.index + 1;
    const total  = ctx.ids.length;
    const isFirst = ctx.index === 0;
    const isLast  = ctx.index === total - 1;
    const dropdownItems = ctx.ids.map((id, i) => {
      const match = state.qb.invoices.find(x => x.id === id);
      if (match) {
        const isPaid    = match.balance != null && Number(match.balance) === 0;
        const isOverdue = !isPaid && match.dueDate && new Date(match.dueDate) < new Date();
        const statusKey = isPaid ? 'paid' : isOverdue ? 'overdue' : 'open';
        const statusLabel = isPaid ? 'Paid' : isOverdue ? 'Overdue' : 'Open';
        const label = `#${match.docNumber || id} — ${fmtGBP(match.totalAmt)}`;
        return { i, label, statusKey, statusLabel, selected: i === ctx.index };
      }
      return { i, label: `Invoice ${i + 1}`, statusKey: 'open', statusLabel: '', selected: i === ctx.index };
    });

    const currentItem = dropdownItems.find(d => d.selected) || dropdownItems[0];
    const listHtml = dropdownItems.map(d => `
      <li class="inv-jump-item${d.selected ? ' inv-jump-item--active' : ''}"
          role="option" aria-selected="${d.selected}"
          onclick="jumpToInvoice(${d.i}); closeInvoiceJumpDropdown()">
        ${d.statusLabel ? `<span class="inv-status-badge inv-status-${d.statusKey}">${escHtml(d.statusLabel)}</span>` : ''}
        <span class="inv-jump-item-label">${escHtml(d.label)}</span>
      </li>`).join('');

    title.innerHTML = `
      <span class="inv-nav-row">
        <button class="inv-nav-btn" onclick="navigateInvoicePanel(-1)" aria-label="Previous invoice" ${isFirst ? 'disabled' : ''}>&#8592;</button>
        <span class="inv-nav-label">Invoice ${pos} of ${total}</span>
        <button class="inv-nav-btn" onclick="navigateInvoicePanel(1)" aria-label="Next invoice" ${isLast ? 'disabled' : ''}>&#8594;</button>
      </span>
      <span class="inv-nav-docnum">#${escHtml(inv.docNumber || inv.id)}</span>
      <div class="inv-jump-dropdown" id="inv-jump-dd">
        <button class="inv-jump-trigger" onclick="toggleInvoiceJumpDropdown(event)" aria-haspopup="listbox" aria-expanded="false" aria-label="Jump to invoice">
          ${currentItem.statusLabel ? `<span class="inv-status-badge inv-status-${currentItem.statusKey}">${escHtml(currentItem.statusLabel)}</span>` : ''}
          <span class="inv-jump-item-label">${escHtml(currentItem.label)}</span>
          <span class="inv-jump-caret" aria-hidden="true">&#9662;</span>
        </button>
        <ul class="inv-jump-list" role="listbox" aria-label="Invoice list">${listHtml}</ul>
      </div>`;
  } else {
    title.textContent = `Invoice #${inv.docNumber || inv.id}`;
  }
  sub.textContent   = inv.customerName;

  const overdue = inv.dueDate && new Date(inv.dueDate) < new Date();

  const lineRows = inv.lines
    .filter(l => l.detailType !== 'SubTotalLineDetail')
    .map(l => `
      <tr>
        <td class="inv-line-desc">${escHtml(l.description || '—')}</td>
        <td class="inv-line-num">${l.qty != null ? l.qty : ''}</td>
        <td class="inv-line-num">${l.unitPrice != null ? fmtGBP(l.unitPrice) : ''}</td>
        <td class="inv-line-num inv-line-amount">${fmtGBP(l.amount)}</td>
      </tr>
    `).join('');

  body.innerHTML = `
    <div class="inv-section">
      <div class="inv-meta-grid">
        <div class="inv-meta-item">
          <span class="inv-meta-label">Invoice date</span>
          <span class="inv-meta-val">${inv.txnDate ? fmtQBDate(inv.txnDate) : '—'}</span>
        </div>
        <div class="inv-meta-item">
          <span class="inv-meta-label">Balance due</span>
          <span class="inv-meta-val inv-balance">${fmtGBP(inv.balance)}</span>
        </div>
      </div>
    </div>

    <div class="inv-section">
      <h3 class="inv-section-title">Line items</h3>
      <table class="inv-lines-table">
        <thead><tr>
          <th class="inv-line-desc">Description</th>
          <th class="inv-line-num">Qty</th>
          <th class="inv-line-num">Unit price</th>
          <th class="inv-line-num">Amount</th>
        </tr></thead>
        <tbody>${lineRows}</tbody>
        <tfoot>
          <tr class="inv-total-row">
            <td colspan="3" class="inv-line-desc" style="font-weight:600">Total</td>
            <td class="inv-line-num inv-line-amount" style="font-weight:700">${fmtGBP(inv.totalAmt)}</td>
          </tr>
        </tfoot>
      </table>
    </div>

    <div class="inv-section">
      <h3 class="inv-section-title">Edit invoice</h3>
      <div class="inv-edit-grid">
        <label class="inv-edit-label">
          Due date
          <input type="date" id="inv-edit-due" class="inv-edit-input" value="${escHtml(inv.dueDate || '')}" oninput="_invMarkDirty(false)" onchange="_invMarkDirty(false)">
        </label>
        <label class="inv-edit-label">
          Customer email
          <input type="email" id="inv-edit-email" class="inv-edit-input" value="${escHtml(inv.email || '')}" placeholder="customer@example.com" oninput="_invMarkDirty(true)">
        </label>
        <label class="inv-edit-label" style="grid-column:1/-1">
          Message on invoice
          <textarea id="inv-edit-memo" class="inv-edit-input inv-edit-textarea" rows="2" placeholder="Thank you for your business" oninput="_invMarkDirty(false)">${escHtml(inv.memo || '')}</textarea>
        </label>
      </div>
      <button id="inv-save-btn" class="inv-btn inv-btn-primary" onclick="saveInvoiceChanges()" data-viewer-hide>Save changes</button>
      <button id="inv-discard-btn" class="inv-btn inv-btn-secondary hidden" onclick="discardInvoiceDraft()" data-viewer-hide>Discard changes</button>
      <span id="inv-save-msg" class="inv-action-msg"></span>
    </div>

    <div class="inv-section inv-actions-row">
      <div>
        <h3 class="inv-section-title">Actions</h3>
        <div class="inv-actions-btns">
          <a href="/api/quickbooks/invoice/${inv.id}/pdf" target="_blank" download="invoice-${escHtml(inv.docNumber || inv.id)}.pdf"
            class="inv-btn inv-btn-secondary" id="inv-pdf-btn">
            <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h6l2 2h4a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
            </svg>
            Download PDF
          </a>
          <button class="inv-btn inv-btn-secondary" id="inv-send-btn" onclick="sendInvoice()" data-viewer-hide>
            <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
            </svg>
            Send to customer
          </button>
        </div>
        <span id="inv-send-msg" class="inv-action-msg"></span>
      </div>
    </div>
  `;
}

async function saveInvoiceChanges() {
  const inv = state.qb.panel;
  if (!inv || state.qb.panelSaving) return;

  const dueDate = document.getElementById('inv-edit-due')?.value || null;
  const email   = document.getElementById('inv-edit-email')?.value?.trim() || null;
  const memo    = document.getElementById('inv-edit-memo')?.value || null;
  const btn     = document.getElementById('inv-save-btn');
  const msg     = document.getElementById('inv-save-msg');

  state.qb.panelSaving = true;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  msg.textContent = '';
  msg.className = 'inv-action-msg';

  try {
    const r = await fetch(`/api/quickbooks/invoice/${inv.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ syncToken: inv.syncToken, dueDate, memo, email })
    }).then(res => res.json());

    if (r.error) throw new Error(r.error);

    state.qb.panel.syncToken = r.syncToken;
    state.qb.panel.dueDate   = dueDate;
    state.qb.panel.memo      = memo;
    state.qb.panel.email     = email;

    // Refresh the list so badges/dates update
    const idx = state.qb.invoices.findIndex(i => i.id === inv.id);
    if (idx !== -1) { state.qb.invoices[idx].dueDate = dueDate; state.qb.invoices[idx].email = email || state.qb.invoices[idx].email; }

    msg.textContent = 'Saved';
    msg.className = 'inv-action-msg inv-msg-ok';
    window._invMemoDirty = false;
    window._invSendDirty = false;
    if (state.qb.draft && inv.id) delete state.qb.draft[inv.id];
    if (typeof _updateBeforeUnloadGuard === 'function') _updateBeforeUnloadGuard();
    const discardBtn = document.getElementById('inv-discard-btn');
    if (discardBtn) discardBtn.classList.add('hidden');
  } catch (e) {
    msg.textContent = e.message;
    msg.className = 'inv-action-msg inv-msg-err';
  } finally {
    state.qb.panelSaving = false;
    btn.disabled = false;
    btn.textContent = 'Save changes';
  }
}

async function sendInvoice() {
  const inv = state.qb.panel;
  if (!inv || state.qb.panelSending) return;

  const email   = document.getElementById('inv-edit-email')?.value?.trim();
  const btn     = document.getElementById('inv-send-btn');
  const msg     = document.getElementById('inv-send-msg');

  state.qb.panelSending = true;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  msg.textContent = '';
  msg.className = 'inv-action-msg';

  try {
    const r = await fetch(`/api/quickbooks/invoice/${inv.id}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    }).then(res => res.json());

    if (r.error) throw new Error(r.error);
    msg.textContent = `Sent to ${email || inv.email}`;
    msg.className = 'inv-action-msg inv-msg-ok';
    window._invSendDirty = false;
    if (typeof _updateBeforeUnloadGuard === 'function') _updateBeforeUnloadGuard();
  } catch (e) {
    msg.textContent = e.message;
    msg.className = 'inv-action-msg inv-msg-err';
  } finally {
    state.qb.panelSending = false;
    btn.disabled = false;
    btn.innerHTML = `<svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg> Send to customer`;
  }
}
