// QuickBooks invoice list loader, currency/date formatters, and the
// shared invoice detail panel. Loaded by any page that surfaces invoices
// (home, invoices, sales, projects).

// ── QuickBooks ────────────────────────────────────────────────────────────────
async function loadQBInvoices() {
  try {
    const status = await fetch('/api/quickbooks/status').then(r => r.json()).catch(() => ({ connected: false }));
    state.qb.connected  = status.connected;
    state.qb.company    = status.company || null;
    state.qb.statusKnown = true;

    if (!status.connected) {
      const invEl = document.getElementById('invoices-view');
      if (invEl) renderInvoicesTab();
      const projEl = document.getElementById('projects-view');
      if (projEl) renderProjectsView();
      return;
    }

    state.qb.loading = true;
    const data = await fetch('/api/quickbooks/invoices').then(r => r.json()).catch(() => ({ invoices: [] }));
    state.qb.invoices = data.invoices || [];
    state.qb.loaded   = true;
    state.qb.loading  = false;
    renderCustomerList();
    const homeEl = document.getElementById('home-view');
    if (homeEl) renderHomeTab();
    const invEl = document.getElementById('invoices-view');
    if (invEl) renderInvoicesTab();
    const wfInvEl = document.getElementById('invoices-section');
    if (wfInvEl) renderWorkflowInvoices();
    const projEl = document.getElementById('projects-view');
    if (projEl) renderProjectsView();
  } catch {
    state.qb.loading = false;
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
  } catch (e) {
    body.innerHTML = `<div class="inv-panel-error">Failed to load invoice: ${escHtml(e.message)}</div>`;
  }
}

async function navigateInvoicePanel(delta) {
  const ctx = state.qb.panelContext;
  if (!ctx) return;
  const newIdx = ctx.index + delta;
  if (newIdx < 0 || newIdx >= ctx.ids.length) return;
  ctx.index = newIdx;
  const ids = ctx.ids;
  await openInvoicePanel(ids[newIdx], ids);
}

function closeInvoicePanel() {
  document.getElementById('inv-panel').classList.remove('inv-panel-open');
  document.getElementById('inv-overlay').classList.add('hidden');
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
    title.innerHTML = `
      <span class="inv-nav-row">
        <button class="inv-nav-btn" onclick="navigateInvoicePanel(-1)" aria-label="Previous invoice" ${isFirst ? 'disabled' : ''}>&#8592;</button>
        <span class="inv-nav-label">Invoice ${pos} of ${total}</span>
        <button class="inv-nav-btn" onclick="navigateInvoicePanel(1)" aria-label="Next invoice" ${isLast ? 'disabled' : ''}>&#8594;</button>
      </span>
      <span class="inv-nav-docnum">#${escHtml(inv.docNumber || inv.id)}</span>`;
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
          <input type="date" id="inv-edit-due" class="inv-edit-input" value="${escHtml(inv.dueDate || '')}">
        </label>
        <label class="inv-edit-label">
          Customer email
          <input type="email" id="inv-edit-email" class="inv-edit-input" value="${escHtml(inv.email || '')}" placeholder="customer@example.com">
        </label>
        <label class="inv-edit-label" style="grid-column:1/-1">
          Message on invoice
          <textarea id="inv-edit-memo" class="inv-edit-input inv-edit-textarea" rows="2" placeholder="Thank you for your business">${escHtml(inv.memo || '')}</textarea>
        </label>
      </div>
      <button id="inv-save-btn" class="inv-btn inv-btn-primary" onclick="saveInvoiceChanges()" data-viewer-hide>Save changes</button>
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
  } catch (e) {
    msg.textContent = e.message;
    msg.className = 'inv-action-msg inv-msg-err';
  } finally {
    state.qb.panelSending = false;
    btn.disabled = false;
    btn.innerHTML = `<svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg> Send to customer`;
  }
}
