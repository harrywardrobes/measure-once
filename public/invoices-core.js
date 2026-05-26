// QuickBooks invoice list loader, currency/date formatters.
// Loaded by any page that surfaces invoices (home, invoices, sales, projects).
// The invoice detail panel has been migrated to the React InvoiceDetailDrawer
// component (src/react/components/InvoiceDetailDrawer.tsx).

// ── QuickBooks ────────────────────────────────────────────────────────────────
// Implementation registered with core.js via registerQBInvoicesLoader at the
// bottom of this file.
async function _loadQBInvoicesImpl() {
  state.qb.loadError  = false;
  state.qb.error      = null;
  state.qb.errorCode  = null;

  function _refreshInvoiceViews() {
    document.dispatchEvent(new CustomEvent('mo:contacts-changed'));
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
    _refreshInvoiceViews();
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

// ── Register implementations with core.js dispatchers ─────────────────────────
registerQBInvoicesLoader(_loadQBInvoicesImpl);
