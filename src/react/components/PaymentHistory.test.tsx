import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';

// ── Module mocks ──────────────────────────────────────────────────────────────

// Mock usePrivilege so we can control isAdmin
vi.mock('../hooks/usePrivilege', () => ({
  usePrivilege: vi.fn(() => ({ privilegeLevel: 'admin', isAdmin: true, isManager: false, isViewer: false })),
}));

// Mock usePaymentHistory so we don't need a real server
vi.mock('../hooks/usePaymentHistory', () => ({
  usePaymentHistory: vi.fn(),
}));

import { PaymentHistory } from './PaymentHistory';
import { usePaymentHistory } from '../hooks/usePaymentHistory';
import { usePrivilege } from '../hooks/usePrivilege';

const mockUsePaymentHistory = usePaymentHistory as ReturnType<typeof vi.fn>;
const mockUsePrivilege       = usePrivilege       as ReturnType<typeof vi.fn>;

const PAID_DATA = {
  qbConnected: true as const,
  payments: [
    {
      id: '1',
      reference: 'PMT-001',
      txnDate: '2026-03-15',
      totalAmt: 900,
      unappliedAmt: 0,
      paymentMethodName: 'Bank Transfer',
      linkedInvoiceIds: ['101'],
    },
  ],
  invoices: [
    {
      invoiceId: '101',
      invoiceDocNumber: '3001',
      invoiceLabel: 'Deposit',
      invoiceTotalAmt: 900,
      invoiceBalance: 0,
      invoicePaidAmt: 900,
      status: 'paid' as const,
    },
  ],
  summary: { totalInvoiced: 900, totalPaid: 900, totalOutstanding: 0 },
};

const PARTIAL_DATA = {
  qbConnected: true as const,
  payments: [
    {
      id: '2',
      reference: null,
      txnDate: '2026-02-01',
      totalAmt: 450,
      unappliedAmt: 0,
      paymentMethodName: null,
      linkedInvoiceIds: ['102'],
    },
  ],
  invoices: [
    {
      invoiceId: '102',
      invoiceDocNumber: '3002',
      invoiceLabel: 'INV-3002',
      invoiceTotalAmt: 900,
      invoiceBalance: 450,
      invoicePaidAmt: 450,
      status: 'partial' as const,
    },
  ],
  summary: { totalInvoiced: 900, totalPaid: 450, totalOutstanding: 450 },
};

const UNPAID_DATA = {
  qbConnected: true as const,
  payments: [],
  invoices: [
    {
      invoiceId: '103',
      invoiceDocNumber: '3003',
      invoiceLabel: 'INV-3003',
      invoiceTotalAmt: 500,
      invoiceBalance: 500,
      invoicePaidAmt: 0,
      status: 'unpaid' as const,
    },
  ],
  summary: { totalInvoiced: 500, totalPaid: 0, totalOutstanding: 500 },
};

const EMPTY_DATA = {
  qbConnected: true as const,
  payments: [],
  invoices: [],
  summary: { totalInvoiced: 0, totalPaid: 0, totalOutstanding: 0 },
};

function stubHook(overrides: Partial<ReturnType<typeof usePaymentHistory>>) {
  mockUsePaymentHistory.mockReturnValue({
    loading: false,
    error: null,
    data: null,
    qbConnected: null,
    refetch: vi.fn(),
    ...overrides,
  });
}

beforeEach(() => {
  mockUsePrivilege.mockReturnValue({ privilegeLevel: 'admin', isAdmin: true, isManager: false, isViewer: false });
});

// ── Banner variant tests ──────────────────────────────────────────────────────

describe('PaymentHistory banner variant', () => {
  it('shows loading skeleton while loading', () => {
    stubHook({ loading: true });
    const { container } = render(
      <PaymentHistory variant="banner" contactId="1" invoiceId="101" />
    );
    // MUI Skeleton renders with role="progressbar" or as a div
    expect(container.querySelector('[class*="MuiSkeleton"]')).toBeTruthy();
  });

  it('shows paid alert with date and method when invoiceId matches paid invoice', async () => {
    stubHook({ loading: false, qbConnected: true, data: PAID_DATA });
    render(<PaymentHistory variant="banner" contactId="1" invoiceId="101" />);
    await waitFor(() => {
      // Banner now shows "Paid — £X on {date} ({method})"
      expect(screen.getByText('Paid')).toBeTruthy();
      expect(screen.getByText(/Bank Transfer/i)).toBeTruthy();
    });
  });

  it('shows partial alert when invoiceId matches partially paid invoice', async () => {
    stubHook({ loading: false, qbConnected: true, data: PARTIAL_DATA });
    render(<PaymentHistory variant="banner" contactId="1" invoiceId="102" />);
    await waitFor(() => {
      expect(screen.getByText(/Partially paid/i)).toBeTruthy();
    });
  });

  it('shows unpaid alert when invoiceId matches unpaid invoice', async () => {
    stubHook({ loading: false, qbConnected: true, data: UNPAID_DATA });
    render(<PaymentHistory variant="banner" contactId="1" invoiceId="103" />);
    await waitFor(() => {
      expect(screen.getByText(/Awaiting payment/i)).toBeTruthy();
    });
  });

  it('shows warning when invoiceId not found in data', async () => {
    stubHook({ loading: false, qbConnected: true, data: EMPTY_DATA });
    render(<PaymentHistory variant="banner" contactId="1" invoiceId="999" />);
    await waitFor(() => {
      expect(screen.getByText(/No deposit invoice found/i)).toBeTruthy();
    });
  });

  it('shows QB-not-connected hint for admin when QB not connected', async () => {
    stubHook({ loading: false, qbConnected: false, data: null });
    render(<PaymentHistory variant="banner" contactId="1" invoiceId="101" />);
    await waitFor(() => {
      expect(screen.getByText(/QuickBooks is not connected/i)).toBeTruthy();
    });
  });

  it('does NOT show QB-not-connected hint for non-admin when QB not connected', async () => {
    mockUsePrivilege.mockReturnValue({ privilegeLevel: 'member', isAdmin: false, isManager: false, isViewer: false });
    stubHook({ loading: false, qbConnected: false, data: null });
    render(<PaymentHistory variant="banner" contactId="1" invoiceId="101" />);
    await waitFor(() => {
      expect(screen.queryByText(/QuickBooks is not connected/i)).toBeNull();
    });
  });

  it('shows error alert when fetch fails', async () => {
    stubHook({ loading: false, error: 'Network error', data: null, qbConnected: null });
    render(<PaymentHistory variant="banner" contactId="1" invoiceId="101" />);
    await waitFor(() => {
      expect(screen.getByText(/Could not load payment history/i)).toBeTruthy();
    });
  });

  it('shows overall summary (all paid) when no invoiceId provided', async () => {
    stubHook({ loading: false, qbConnected: true, data: PAID_DATA });
    render(<PaymentHistory variant="banner" contactId="1" />);
    await waitFor(() => {
      expect(screen.getByText(/All paid/i)).toBeTruthy();
    });
  });
});

// ── onPaidStateChange callback tests ─────────────────────────────────────────

describe('PaymentHistory onPaidStateChange', () => {
  it('calls onPaidStateChange(true) when invoiceId matches paid invoice', async () => {
    stubHook({ loading: false, qbConnected: true, data: PAID_DATA });
    const cb = vi.fn();
    render(
      <PaymentHistory variant="banner" contactId="1" invoiceId="101" onPaidStateChange={cb} />
    );
    await waitFor(() => {
      const calls = cb.mock.calls.map(c => c[0]);
      expect(calls).toContain(true);
    });
  });

  it('calls onPaidStateChange(false) when invoiceId matches partial invoice', async () => {
    stubHook({ loading: false, qbConnected: true, data: PARTIAL_DATA });
    const cb = vi.fn();
    render(
      <PaymentHistory variant="banner" contactId="1" invoiceId="102" onPaidStateChange={cb} />
    );
    await waitFor(() => {
      const calls = cb.mock.calls.map(c => c[0]);
      expect(calls).toContain(false);
    });
  });

  it('calls onPaidStateChange(null) while loading', () => {
    stubHook({ loading: true });
    const cb = vi.fn();
    render(
      <PaymentHistory variant="banner" contactId="1" invoiceId="101" onPaidStateChange={cb} />
    );
    expect(cb).toHaveBeenCalledWith(null);
  });

  it('calls onPaidStateChange(null) when QB not connected', async () => {
    stubHook({ loading: false, qbConnected: false, data: null });
    const cb = vi.fn();
    render(
      <PaymentHistory variant="banner" contactId="1" invoiceId="101" onPaidStateChange={cb} />
    );
    await waitFor(() => {
      const calls = cb.mock.calls.map(c => c[0]);
      expect(calls).toContain(null);
    });
  });
});

// ── List variant tests ────────────────────────────────────────────────────────

describe('PaymentHistory list variant', () => {
  it('shows payments table with payment method and amount', async () => {
    stubHook({ loading: false, qbConnected: true, data: PAID_DATA });
    render(<PaymentHistory variant="list" contactId="1" />);
    await waitFor(() => {
      expect(screen.getByText('Bank Transfer')).toBeTruthy();
      // £900.00 appears in both the invoice summary and payments table — confirm at least one exists
      expect(screen.getAllByText('£900.00').length).toBeGreaterThan(0);
    });
  });

  it('shows "No payments recorded" when no payments exist but invoices do', async () => {
    stubHook({ loading: false, qbConnected: true, data: UNPAID_DATA });
    render(<PaymentHistory variant="list" contactId="1" />);
    await waitFor(() => {
      expect(screen.getByText(/No payments recorded/i)).toBeTruthy();
    });
  });

  it('shows loading skeleton while loading', () => {
    stubHook({ loading: true });
    const { container } = render(
      <PaymentHistory variant="list" contactId="1" />
    );
    expect(container.querySelector('[class*="MuiSkeleton"]')).toBeTruthy();
  });

  it('shows invoice summary section with labels and status chips', async () => {
    stubHook({ loading: false, qbConnected: true, data: PAID_DATA });
    render(<PaymentHistory variant="list" contactId="1" />);
    await waitFor(() => {
      // "Deposit" appears in invoice summary + payments "Applied to" column — confirm at least one
      expect(screen.getAllByText('Deposit').length).toBeGreaterThan(0);
      expect(screen.getByText('Paid')).toBeTruthy();
    });
  });

  it('shows overall summary totals', async () => {
    stubHook({ loading: false, qbConnected: true, data: PARTIAL_DATA });
    render(<PaymentHistory variant="list" contactId="1" />);
    await waitFor(() => {
      expect(screen.getByText(/Total invoiced/i)).toBeTruthy();
    });
  });
});
