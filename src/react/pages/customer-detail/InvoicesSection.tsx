import React from 'react';
import { Contact, QBInvoice } from './types';
import { usePrivilege } from '../../hooks/usePrivilege';

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

  if (!qb.statusKnown) return null;
  if (!qb.connected) return null;

  const matched = qb.loaded ? matchInvoices(contact, qb.invoices) : [];

  return (
    <div id="invoices-section" className="mb-5">
      <div className="notes-header">
        <span className="notes-header-label">Invoices</span>
        {qb.company && <span className="text-xs text-slate-400 ml-2">· {qb.company}</span>}
      </div>

      {qb.loading && (
        <p className="text-sm text-slate-400 italic px-1">Loading invoices…</p>
      )}
      {qb.loadError && (
        <p className="text-sm text-red-500 px-1">{qb.error || 'Failed to load invoices.'}</p>
      )}
      {qb.loaded && matched.length === 0 && (
        <p className="text-sm text-slate-400 italic px-1">No invoices found for this customer.</p>
      )}
      {qb.loaded && matched.length > 0 && (
        <div className="space-y-2">
          {matched.map(inv => (
            <div key={inv.Id} className="inv-row flex items-center justify-between gap-3 px-1 py-1.5 border-b border-slate-100">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs text-slate-500">#{inv.DocNumber}</span>
                {statusPill(inv)}
              </div>
              <div className="flex items-center gap-3 shrink-0 text-xs text-slate-500">
                <span>{fmtQBDate(inv.TxnDate)}</span>
                <span className="font-semibold text-slate-700">{fmtGBP(inv.TotalAmt)}</span>
                {inv.Balance != null && Number(inv.Balance) > 0 && (
                  <span className="text-slate-400">due {fmtGBP(inv.Balance)}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
