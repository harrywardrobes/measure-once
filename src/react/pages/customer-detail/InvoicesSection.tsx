import React, { useState, useEffect } from 'react';
import { Contact, QBInvoice } from './types';
import { usePrivilege } from '../../hooks/usePrivilege';
import { InvoiceDetailDrawer } from '../../components/InvoiceDetailDrawer';

interface QBState {
  connected: boolean;
  statusKnown: boolean;
  loading: boolean;
  loaded: boolean;
  loadError: boolean;
  error: string | null;
  company: string | null;
  invoices: QBInvoice[];
}

interface Props {
  contact: Contact;
  qb: QBState;
}

function fmtQBDate(iso?: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return new Date(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10))
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtGBP(amount?: number): string {
  if (amount == null) return '—';
  return `£${Number(amount).toFixed(2)}`;
}

function statusPill(inv: QBInvoice): React.ReactNode {
  const balance = Number(inv.Balance ?? 0);
  const total   = Number(inv.TotalAmt ?? 0);
  if (balance <= 0) return <span className="inv-pill inv-pill-paid">Paid</span>;
  if (balance < total) return <span className="inv-pill inv-pill-partial">Part paid</span>;
  const due = inv.DueDate ? new Date(inv.DueDate) : null;
  if (due && due < new Date()) return <span className="inv-pill inv-pill-overdue">Overdue</span>;
  return <span className="inv-pill inv-pill-open">Outstanding</span>;
}

function matchInvoices(contact: Contact, invoices: QBInvoice[]): QBInvoice[] {
  const email   = (contact.properties.email || '').toLowerCase();
  const company = (contact.properties.company || '').toLowerCase();
  return invoices.filter(inv => {
    const invEmail   = (inv.BillEmail?.Address || '').toLowerCase();
    const invCompany = (inv.CustomerRef?.name  || '').toLowerCase();
    return (email && invEmail && invEmail === email)
      || (company && invCompany && invCompany.includes(company));
  });
}

export function InvoicesSection({ contact, qb }: Props) {
  const { isAdmin } = usePrivilege();
  const [drawerOpen, setDrawerOpen]   = useState(false);
  const [drawerInvId, setDrawerInvId] = useState<string | null>(null);

  const matched = qb.loaded ? matchInvoices(contact, qb.invoices) : [];
  const allIds  = matched.map(inv => inv.Id);

  useEffect(() => {
    if (!qb.loaded) return;
    const hash = window.location.hash;
    if (hash.startsWith('#inv-')) {
      const id = hash.slice(5);
      if (id && allIds.includes(id)) {
        setDrawerInvId(id);
        setDrawerOpen(true);
      }
    }
  }, [qb.loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function handlePopState() {
      const hash = window.location.hash;
      if (hash.startsWith('#inv-')) {
        const id = hash.slice(5);
        if (id) {
          setDrawerInvId(id);
          setDrawerOpen(true);
        }
      } else {
        setDrawerOpen(false);
      }
    }
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  if (!qb.statusKnown) return null;
  if (!qb.connected) return null;

  function openDrawer(invId: string) {
    setDrawerInvId(invId);
    setDrawerOpen(true);
    window.location.hash = `inv-${invId}`;
  }

  function closeDrawer() {
    setDrawerOpen(false);
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  return (
    <>
      <div id="invoices-section" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--ink-2)' }}>Invoices</span>
          {qb.company && (
            <span style={{ fontSize: '0.75rem', marginLeft: 8, color: 'var(--stone-deep)' }}>· {qb.company}</span>
          )}
        </div>

        {qb.loading && (
          <p style={{ fontSize: '0.875rem', fontStyle: 'italic', padding: '0 4px', color: 'var(--stone-deep)' }}>Loading invoices…</p>
        )}
        {qb.loadError && (
          <p style={{ fontSize: '0.875rem', padding: '0 4px', color: '#ef4444' }}>{qb.error || 'Failed to load invoices.'}</p>
        )}
        {qb.loaded && matched.length === 0 && (
          <p style={{ fontSize: '0.875rem', fontStyle: 'italic', padding: '0 4px', color: 'var(--stone-deep)' }}>No invoices found for this customer.</p>
        )}
        {qb.loaded && matched.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {matched.map(inv => (
              <div
                key={inv.Id}
                className="inv-row"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '4px 4px 6px', cursor: 'pointer', borderRadius: 4, borderBottom: '1px solid var(--stone)' }}
                onClick={() => openDrawer(inv.Id)}
                role="button"
                tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') openDrawer(inv.Id); }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span style={{ fontSize: '0.75rem', color: 'var(--ink-4)' }}>#{inv.DocNumber}</span>
                  {statusPill(inv)}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0, fontSize: '0.75rem', color: 'var(--ink-4)' }}>
                  <span>{fmtQBDate(inv.TxnDate)}</span>
                  <span style={{ fontWeight: 600, color: 'var(--ink-2)' }}>{fmtGBP(inv.TotalAmt)}</span>
                  {inv.Balance != null && Number(inv.Balance) > 0 && (
                    <span style={{ color: 'var(--stone-deep)' }}>due {fmtGBP(inv.Balance)}</span>
                  )}
                  <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7"/>
                  </svg>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <InvoiceDetailDrawer
        open={drawerOpen}
        invId={drawerInvId}
        allIds={allIds}
        onClose={closeDrawer}
        onNavigate={id => { setDrawerInvId(id); window.location.hash = `inv-${id}`; }}
        isAdmin={isAdmin}
      />
    </>
  );
}
