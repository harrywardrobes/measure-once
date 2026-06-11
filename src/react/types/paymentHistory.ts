/**
 * Shared types for the QuickBooks payment-history endpoint and components.
 * Exported from here and imported by usePaymentHistory, PaymentHistory, and
 * all three host components (DepositInvoiceModal, CustomerDetailPage,
 * OpenDealActionModal) so there is a single source of truth.
 */

export interface PaymentRow {
  id: string;
  reference: string | null;
  txnDate: string | null;
  totalAmt: number;
  unappliedAmt: number;
  paymentMethodName: string | null;
  linkedInvoiceIds: string[];
}

export interface InvoiceSummaryRow {
  invoiceId: string;
  invoiceDocNumber: string | null;
  invoiceLabel: string;
  invoiceTotalAmt: number;
  invoiceBalance: number;
  invoicePaidAmt: number;
  status: 'paid' | 'partial' | 'unpaid';
}

export interface PaymentHistorySummary {
  totalInvoiced: number;
  totalPaid: number;
  totalOutstanding: number;
}

export interface PaymentHistoryData {
  qbConnected: true;
  payments: PaymentRow[];
  invoices: InvoiceSummaryRow[];
  summary: PaymentHistorySummary;
}

export type PaymentHistoryResponse =
  | { qbConnected: false }
  | PaymentHistoryData;
