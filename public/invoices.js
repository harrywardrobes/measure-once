function renderInvoicesTab() {
  const el = document.getElementById('invoices-view');
  if (!el) return;

  if (!state.qb.statusKnown || state.qb.loading || (state.qb.connected && !state.qb.loaded)) {
    const skRow = (w1 = '42%', w2 = '58px', w3 = '44px') => `
      <div class="qb-row skeleton-qb-row">
        <div class="qb-row-customer">
          <div class="skeleton-line" style="height:13px;width:${w1}"></div>
        </div>
        <div class="qb-row-meta">
          <div class="skeleton-line" style="height:10px;width:${w2}"></div>
          <div class="skeleton-line" style="height:9px;width:${w3};margin-top:3px"></div>
        </div>
        <div class="skeleton-line" style="height:15px;width:54px;flex-shrink:0"></div>
      </div>`;
    el.innerHTML = `
      <div class="qb-tab-header">
        <div>
          <div class="skeleton-line" style="height:18px;width:165px;margin-bottom:8px"></div>
          <div class="skeleton-line" style="height:11px;width:110px"></div>
        </div>
      </div>
      <div class="qb-list">
        ${skRow('48%', '62px', '48px')}
        ${skRow('38%', '54px', '40px')}
        ${skRow('52%', '60px', '44px')}
        ${skRow('33%', '56px', '42px')}
        ${skRow('44%', '58px', '46px')}
      </div>
    `;
    return;
  }

  if (!state.qb.connected) {
    el.innerHTML = `
      <div class="qb-tab-empty">
        <div class="qb-tab-empty-icon">
          <svg width="40" height="40" fill="none" stroke="currentColor" viewBox="0 0 24 24" style="opacity:0.35">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
              d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z"/>
          </svg>
        </div>
        <p class="qb-tab-empty-title">Connect QuickBooks</p>
        <p class="qb-tab-empty-sub">See outstanding invoices matched to your customers.</p>
        <a href="/auth/quickbooks" class="qb-connect-btn">Connect QuickBooks</a>
      </div>
    `;
    return;
  }

  const allInvoices = [...state.qb.invoices].sort((a, b) => b.balance - a.balance);

  // Tag each invoice with its matched HubSpot contact (if any)
  const tagged = allInvoices.map(inv => {
    const matched = state.contacts.find(c => {
      const email = (c.properties?.email || '').toLowerCase();
      const name  = contactName(c).toLowerCase();
      if (email && inv.email && email === inv.email.toLowerCase()) return true;
      if (name  && inv.customerName && name === inv.customerName.toLowerCase()) return true;
      return false;
    });
    return { inv, matched };
  });

  const matchedOnly = state.qb.showMatchedOnly;
  const visible     = matchedOnly ? tagged.filter(t => t.matched) : tagged;
  const total       = visible.reduce((s, t) => s + t.inv.balance, 0);
  const matchCount  = tagged.filter(t => t.matched).length;

  const filterBar = `
    <div class="qb-filter-bar">
      <button class="qb-filter-btn ${!matchedOnly ? 'qb-filter-active' : ''}"
        onclick="state.qb.showMatchedOnly=false;renderInvoicesTab()">
        All (${allInvoices.length})
      </button>
      <button class="qb-filter-btn ${matchedOnly ? 'qb-filter-active' : ''}"
        onclick="state.qb.showMatchedOnly=true;renderInvoicesTab()">
        Matched to customers (${matchCount})
      </button>
    </div>
  `;

  if (!visible.length) {
    el.innerHTML = `
      <div class="qb-tab-header">
        <div>
          <h2 class="qb-tab-title">Outstanding Invoices</h2>
          <p class="qb-tab-sub">${escHtml(state.qb.company || 'QuickBooks')}</p>
        </div>
        <div class="flex items-center gap-2">
          <button onclick="loadQBInvoices()" class="qb-refresh-btn">
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
            </svg>
            Refresh
          </button>
          <button onclick="disconnectQB()" class="qb-disconnect-btn">Disconnect</button>
        </div>
      </div>
      ${filterBar}
      <div class="qb-tab-empty" style="margin-top:32px">
        <p class="qb-tab-empty-title">${matchedOnly ? 'No matched invoices' : 'All clear!'}</p>
        <p class="qb-tab-empty-sub">${matchedOnly ? 'No outstanding invoices matched to your HubSpot customers.' : 'No outstanding invoices found.'}</p>
      </div>
    `;
    return;
  }

  const rows = visible.map(({ inv, matched }) => {
    const isPaid      = inv.balance != null && Number(inv.balance) === 0;
    const overdue     = !isPaid && inv.dueDate && new Date(inv.dueDate) < new Date();
    const statusKey   = isPaid ? 'paid' : overdue ? 'overdue' : 'open';
    const statusLabel = isPaid ? 'Paid' : overdue ? 'Overdue' : 'Open';
    return `
      <div class="qb-row" onclick="openInvoicePanel('${escHtml(inv.id)}')" title="Open invoice">
        <div class="qb-row-customer">
          <span class="qb-row-name">${escHtml(inv.customerName || '—')}</span>
          ${matched
            ? `<span class="qb-row-linked" title="Matched to HubSpot contact">
                <svg width="12" height="12" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>
                Linked
              </span>`
            : ''}
        </div>
        <div class="qb-row-meta">
          <span class="qb-row-num">Inv #${escHtml(inv.docNumber || inv.id)}</span>
          ${inv.dueDate ? `<span class="qb-row-date">Due ${fmtQBDate(inv.dueDate)}</span>` : ''}
        </div>
        <div class="flex items-center gap-2">
          <span class="inv-status-badge inv-status-${statusKey}">${statusLabel}</span>
          <span class="qb-row-amount">${fmtGBP(inv.balance)}</span>
          <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" style="color:var(--stone-deep);flex-shrink:0">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
          </svg>
        </div>
      </div>
    `;
  }).join('');

  el.innerHTML = `
    <div class="qb-tab-header">
      <div>
        <h2 class="qb-tab-title">Outstanding Invoices</h2>
        <p class="qb-tab-sub">${escHtml(state.qb.company || 'QuickBooks')} · ${visible.length} invoice${visible.length !== 1 ? 's' : ''} · ${fmtGBP(total)} total</p>
      </div>
      <div class="flex items-center gap-2">
        <button onclick="loadQBInvoices()" class="qb-refresh-btn" title="Refresh invoices">
          <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
          </svg>
          Refresh
        </button>
        <button onclick="disconnectQB()" class="qb-disconnect-btn">Disconnect</button>
      </div>
    </div>
    ${filterBar}
    <div class="qb-list">${rows}</div>
  `;
}

async function disconnectQB() {
  await fetch('/auth/quickbooks/disconnect').catch(() => {});
  state.qb = { statusKnown: true, connected: false, company: null, invoices: [], loaded: false, loading: false, showMatchedOnly: true, panel: null, panelSaving: false, panelSending: false };
  renderCustomerList();
  renderInvoicesTab();
}

