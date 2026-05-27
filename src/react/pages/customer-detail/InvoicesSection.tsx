import React, { useState, useEffect } from 'react';
import { Contact } from './types';
import { usePrivilege } from '../../hooks/usePrivilege';
import { InvoiceDetailDrawer, type InvoiceSummary } from '../../components/InvoiceDetailDrawer';
import { fmtQBDate, fmtGBP } from '../../utils/formatters';
import type { QBInvoicesResult } from '../../hooks/useQBInvoices';

interface Props {
  contact: Contact;
  qb: QBInvoicesResult;
}

function statusPill(inv: InvoiceSummary): React.ReactNode {
  const balance = Number(inv.balance ?? 0);
  const total   = Number(inv.totalAmt ?? 0);
  if (balance <= 0) return <span className="inv-pill inv-pill-paid">Paid</span>;
  if (balance < total) return <span className="inv-pill inv-pill-partial">Part paid</span>;
  const due = inv.dueDate ? new Date(inv.dueDate) : null;
  if (due && due < new Date()) return <span className="inv-pill inv-pill-overdue">Overdue</span>;
  return <span className="inv-pill inv-pill-open">Outstanding</span>;
}

function matchInvoices(contact: Contact, invoices: InvoiceSummary[]): InvoiceSummary[] {
  const email   = (contact.properties.email || '').toLowerCase();
  const company = (contact.properties.company || '').toLowerCase();
  return invoices.filter(inv => {
    const invEmail   = (inv.email        || '').toLowerCase();
    const invCompany = (inv.customerName || '').toLowerCase();
    return (email && invEmail && invEmail === email)
      || (company && invCompany && invCompany.includes(company));
  });
}

function InvoiceSkeletonRows() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {[48, 38, 52].map((w, i) => (
        <div key={i} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, padding: '4px 4px 6px',
          borderBottom: '1px solid var(--stone)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
            <div className="inv-skeleton-pulse" style={{ width: `${w}%`, height: 13, borderRadius: 4 }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            <div className="inv-skeleton-pulse" style={{ width: 50, height: 13, borderRadius: 4 }} />
            <div className="inv-skeleton-pulse" style={{ width: 46, height: 20, borderRadius: 999 }} />
            <div className="inv-skeleton-pulse" style={{ width: 48, height: 13, borderRadius: 4 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function InvoicesSection({ contact, qb }: Props) {
  const { isAdmin } = usePrivilege();
  const [drawerOpen, setDrawerOpen]   = useState(false);
  const [drawerInvId, setDrawerInvId] = useState<string | null>(null);

  const isLoadingState = qb.loading || (!qb.statusKnown && !qb.loaded && !qb.loadError);

  const matched = qb.loaded ? matchInvoices(contact, qb.invoices) : [];
  const allIds  = matched.map(inv => inv.id);

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

  if (!isLoadingState && qb.statusKnown && !qb.connected) return null;

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

        {isLoadingState && <InvoiceSkeletonRows />}
        {qb.loadError && (
          <p style={{ fontSize: '0.875rem', padding: '0 4px', color: 'var(--status-danger)' }}>{qb.error || 'Failed to load invoices.'}</p>
        )}
        {qb.loaded && matched.length === 0 && (
          <p style={{ fontSize: '0.875rem', fontStyle: 'italic', padding: '0 4px', color: 'var(--stone-deep)' }}>No invoices found for this customer.</p>
        )}
        {qb.loaded && matched.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {matched.map(inv => (
              <div
                key={inv.id}
                className="inv-row"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '4px 4px 6px', cursor: 'pointer', borderRadius: 4, borderBottom: '1px solid var(--stone)' }}
                onClick={() => openDrawer(inv.id)}
                role="button"
                tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') openDrawer(inv.id); }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span style={{ fontSize: '0.75rem', color: 'var(--ink-4)' }}>#{inv.docNumber}</span>
                  {statusPill(inv)}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0, fontSize: '0.75rem', color: 'var(--ink-4)' }}>
                  <span>{fmtQBDate(inv.txnDate)}</span>
                  <span style={{ fontWeight: 600, color: 'var(--ink-2)' }}>{fmtGBP(inv.totalAmt)}</span>
                  {inv.balance != null && Number(inv.balance) > 0 && (
                    <span style={{ color: 'var(--stone-deep)' }}>due {fmtGBP(inv.balance)}</span>
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
        onSaved={() => qb.refresh()}
      />
    </>
  );
}
