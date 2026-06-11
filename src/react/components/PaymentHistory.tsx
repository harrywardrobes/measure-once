import React, { useEffect } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import { usePrivilege } from '../hooks/usePrivilege';
import { usePaymentHistory } from '../hooks/usePaymentHistory';
import type { InvoiceSummaryRow, PaymentRow } from '../types/paymentHistory';

function formatCurrency(n: number): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(n);
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Returns the most recent payment that links to `invoiceId`, or null. */
function findLinkedPayment(payments: PaymentRow[], invoiceId: string): PaymentRow | null {
  const linked = payments.filter((p) => p.linkedInvoiceIds.includes(invoiceId));
  if (linked.length === 0) return null;
  linked.sort((a, b) => {
    if (!a.txnDate) return 1;
    if (!b.txnDate) return -1;
    return b.txnDate.localeCompare(a.txnDate);
  });
  return linked[0];
}

interface Props {
  contactId: string;
  variant: 'banner' | 'list';
  invoiceId?: string | null;
  /**
   * Optional callback invoked whenever the paid state for the focused invoice
   * changes. Allows parent components (e.g. DepositInvoiceModal) to adjust
   * button highlighting without making a second network request.
   *
   *   null  → not yet known (loading or QB not connected)
   *   true  → invoice is fully paid
   *   false → invoice is unpaid or partially paid
   */
  onPaidStateChange?: (isPaid: boolean | null) => void;
}

function QbNotConnectedHint({ isAdmin }: { isAdmin: boolean }) {
  if (!isAdmin) return null;
  return (
    <Alert severity="info" sx={{ py: 0.5 }}>
      QuickBooks is not connected. Connect QB in{' '}
      <Link href="/admin#tab-qb" sx={{ fontWeight: 600 }}>
        admin settings
      </Link>{' '}
      to see payment history.
    </Alert>
  );
}

function BannerSkeleton() {
  return <Skeleton variant="rounded" height={38} sx={{ borderRadius: 1 }} />;
}

function ListSkeleton() {
  return (
    <Stack spacing={0.75}>
      <Skeleton variant="text" width="40%" height={20} />
      <Skeleton variant="rounded" height={90} sx={{ borderRadius: 1 }} />
    </Stack>
  );
}

function StatusChip({ status }: { status: InvoiceSummaryRow['status'] }) {
  if (status === 'paid') {
    return (
      <Chip
        label="Paid"
        size="small"
        color="success"
        icon={<CheckCircleIcon />}
        sx={{ fontWeight: 600 }}
      />
    );
  }
  if (status === 'partial') {
    return (
      <Chip
        label="Part paid"
        size="small"
        color="warning"
        icon={<HourglassEmptyIcon />}
        sx={{ fontWeight: 600 }}
      />
    );
  }
  return (
    <Chip
      label="Unpaid"
      size="small"
      color="default"
      icon={<HourglassEmptyIcon />}
      sx={{ fontWeight: 600 }}
    />
  );
}

/**
 * Reusable QuickBooks payment history component.
 *
 * Variants:
 *   banner — compact one-line status chip. When `invoiceId` is provided shows
 *            status for that specific invoice (including payment date and method
 *            when paid); without it shows an overall summary line.
 *   list   — full section with a "Payments" heading, per-invoice summary, an
 *            overall totals bar, and a payments table with a Reference column.
 *            Renders nothing when QB is connected but the contact has no invoices.
 *
 * Both variants show loading skeletons, an error state, and a "QB not
 * connected" hint (admin-only) when QuickBooks is not connected.
 */
export function PaymentHistory({ contactId, variant, invoiceId, onPaidStateChange }: Props) {
  const { isAdmin } = usePrivilege();
  const { loading, error, data, qbConnected } = usePaymentHistory(contactId);

  const focusedInvoice = invoiceId && data
    ? data.invoices.find((inv) => inv.invoiceId === invoiceId) ?? null
    : null;

  useEffect(() => {
    if (onPaidStateChange == null) return;
    if (loading) {
      onPaidStateChange(null);
      return;
    }
    if (!qbConnected || !invoiceId) {
      onPaidStateChange(null);
      return;
    }
    if (!data) {
      onPaidStateChange(null);
      return;
    }
    if (!focusedInvoice) {
      onPaidStateChange(null);
      return;
    }
    onPaidStateChange(focusedInvoice.status === 'paid');
  }, [loading, qbConnected, data, focusedInvoice, invoiceId, onPaidStateChange]);

  if (loading) {
    return variant === 'banner' ? <BannerSkeleton /> : <ListSkeleton />;
  }

  if (error) {
    return (
      <Alert severity="warning" sx={{ py: 0.5 }}>
        Could not load payment history — {error}
      </Alert>
    );
  }

  if (!qbConnected) {
    return <QbNotConnectedHint isAdmin={isAdmin} />;
  }

  if (!data) return null;

  if (variant === 'banner') {
    return <BannerContent data={data} invoiceId={invoiceId ?? null} />;
  }

  return <ListContent data={data} />;
}

function BannerContent({
  data,
  invoiceId,
}: {
  data: NonNullable<ReturnType<typeof usePaymentHistory>['data']>;
  invoiceId: string | null;
}) {
  if (invoiceId) {
    const inv = data.invoices.find((i) => i.invoiceId === invoiceId);

    if (!inv) {
      return (
        <Alert severity="warning" sx={{ py: 0.5 }}>
          No deposit invoice found in QuickBooks for this contact.
        </Alert>
      );
    }

    if (inv.status === 'paid') {
      const pmt = findLinkedPayment(data.payments, invoiceId);
      const detail = pmt
        ? ` on ${formatDate(pmt.txnDate)}${pmt.paymentMethodName ? ` (${pmt.paymentMethodName})` : ''}`
        : '';
      return (
        <Alert severity="success" icon={<CheckCircleIcon fontSize="small" />} sx={{ py: 0.5 }}>
          <strong>Paid</strong> — {formatCurrency(inv.invoiceTotalAmt)}{detail}
        </Alert>
      );
    }

    if (inv.status === 'partial') {
      return (
        <Alert severity="warning" icon={<HourglassEmptyIcon fontSize="small" />} sx={{ py: 0.5 }}>
          <strong>Partially paid</strong> — {formatCurrency(inv.invoicePaidAmt)} paid,{' '}
          {formatCurrency(inv.invoiceBalance)} outstanding.
        </Alert>
      );
    }

    return (
      <Alert severity="warning" icon={<HourglassEmptyIcon fontSize="small" />} sx={{ py: 0.5 }}>
        <strong>Awaiting payment</strong> — {formatCurrency(inv.invoiceTotalAmt)} due.
      </Alert>
    );
  }

  const { summary } = data;
  if (summary.totalInvoiced === 0) return null;

  if (summary.totalOutstanding <= 0) {
    return (
      <Alert severity="success" icon={<CheckCircleIcon fontSize="small" />} sx={{ py: 0.5 }}>
        <strong>All paid</strong> — {formatCurrency(summary.totalPaid)} received.
      </Alert>
    );
  }

  if (summary.totalPaid > 0) {
    return (
      <Alert severity="warning" icon={<HourglassEmptyIcon fontSize="small" />} sx={{ py: 0.5 }}>
        <strong>Partially paid</strong> — {formatCurrency(summary.totalPaid)} received,{' '}
        {formatCurrency(summary.totalOutstanding)} outstanding.
      </Alert>
    );
  }

  return (
    <Alert severity="warning" icon={<HourglassEmptyIcon fontSize="small" />} sx={{ py: 0.5 }}>
      <strong>Awaiting payment</strong> — {formatCurrency(summary.totalOutstanding)} outstanding.
    </Alert>
  );
}

function ListContent({
  data,
}: {
  data: NonNullable<ReturnType<typeof usePaymentHistory>['data']>;
}) {
  const { payments, invoices, summary } = data;

  // Hide the entire section when QB is connected but there are no invoices
  // (and no payments), so the heading never floats above empty content.
  if (invoices.length === 0 && payments.length === 0) return null;

  return (
    <div style={{ marginBottom: '1.5rem' }}>
      <div
        style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--ink-2)', marginBottom: '0.5rem' }}
      >
        Payments
      </div>

      <Stack spacing={1.5}>
        {invoices.length > 0 && (
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
              Invoice summary
            </Typography>
            <Stack spacing={0.5}>
              {invoices.map((inv) => (
                <Box
                  key={inv.invoiceId}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    flexWrap: 'wrap',
                    fontSize: '0.8125rem',
                  }}
                >
                  <Typography variant="body2" sx={{ fontWeight: 500, minWidth: 80 }}>
                    {inv.invoiceLabel}
                  </Typography>
                  <StatusChip status={inv.status} />
                  <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
                    {inv.status === 'paid'
                      ? formatCurrency(inv.invoiceTotalAmt)
                      : `${formatCurrency(inv.invoicePaidAmt)} / ${formatCurrency(inv.invoiceTotalAmt)}`}
                  </Typography>
                </Box>
              ))}
            </Stack>
          </Box>
        )}

        {summary.totalInvoiced > 0 && (
          <Box
            sx={{
              display: 'flex',
              gap: 2,
              flexWrap: 'wrap',
              py: 0.75,
              px: 1,
              bgcolor: 'action.hover',
              borderRadius: 1,
              fontSize: '0.8125rem',
            }}
          >
            <Typography variant="caption">
              Total invoiced:{' '}
              <strong>{formatCurrency(summary.totalInvoiced)}</strong>
            </Typography>
            <Typography variant="caption">
              Paid:{' '}
              <strong>{formatCurrency(summary.totalPaid)}</strong>
            </Typography>
            {summary.totalOutstanding > 0 && (
              <Typography variant="caption" color="warning.dark">
                Outstanding:{' '}
                <strong>{formatCurrency(summary.totalOutstanding)}</strong>
              </Typography>
            )}
          </Box>
        )}

        {payments.length > 0 ? (
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 600, fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                    Date
                  </TableCell>
                  <TableCell sx={{ fontWeight: 600, fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                    Ref.
                  </TableCell>
                  <TableCell sx={{ fontWeight: 600, fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                    Amount
                  </TableCell>
                  <TableCell sx={{ fontWeight: 600, fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                    Method
                  </TableCell>
                  <TableCell sx={{ fontWeight: 600, fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                    Applied to
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {payments.map((payment) => (
                  <TableRow key={payment.id} hover>
                    <TableCell sx={{ fontSize: '0.8125rem', whiteSpace: 'nowrap' }}>
                      {formatDate(payment.txnDate)}
                    </TableCell>
                    <TableCell sx={{ fontSize: '0.8125rem', whiteSpace: 'nowrap' }}>
                      {payment.reference ?? '—'}
                    </TableCell>
                    <TableCell sx={{ fontSize: '0.8125rem', whiteSpace: 'nowrap' }}>
                      {formatCurrency(payment.totalAmt)}
                    </TableCell>
                    <TableCell sx={{ fontSize: '0.8125rem' }}>
                      {payment.paymentMethodName ?? '—'}
                    </TableCell>
                    <TableCell sx={{ fontSize: '0.8125rem' }}>
                      {payment.linkedInvoiceIds.length > 0
                        ? payment.linkedInvoiceIds
                            .map((id) => {
                              const inv = invoices.find((i) => i.invoiceId === id);
                              return inv ? inv.invoiceLabel : `INV-${id}`;
                            })
                            .join(', ')
                        : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic', py: 0.5 }}>
            No payments recorded in QuickBooks yet.
          </Typography>
        )}
      </Stack>
    </div>
  );
}
