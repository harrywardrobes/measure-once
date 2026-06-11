import React from 'react';
import Box from '@mui/material/Box';
import Skeleton from '@mui/material/Skeleton';
import { STATUS_COLORS } from '../theme';

export type DepositPaymentState = 'paid' | 'partial' | 'unpaid' | null;

export function DepositInvoiceBadge({
  depositInvoiceId,
  depositInvoiceDocNum,
  paymentState,
  loading,
}: {
  depositInvoiceId: string;
  depositInvoiceDocNum: string | null;
  paymentState?: DepositPaymentState;
  loading?: boolean;
}) {
  if (loading) {
    return <Skeleton variant="rounded" width={110} height={20} />;
  }
  const label = depositInvoiceDocNum ? `Deposit inv. #${depositInvoiceDocNum}` : 'Deposit invoice';
  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.preventDefault();
    window.location.href = `/invoices#inv-${encodeURIComponent(depositInvoiceId)}`;
  };
  const title =
    paymentState === 'paid'    ? 'Deposit paid — view invoice' :
    paymentState === 'partial' ? 'Deposit partially paid — view invoice' :
    paymentState === 'unpaid'  ? 'Deposit unpaid — view invoice' :
                                 'View deposit invoice';
  const colors =
    paymentState === 'paid'    ? { borderColor: STATUS_COLORS.success.border,  bgcolor: STATUS_COLORS.success.bg,  color: STATUS_COLORS.success.text,  hoverBg: STATUS_COLORS.successLight.bg  } :
    paymentState === 'partial' ? { borderColor: STATUS_COLORS.warning.border,  bgcolor: STATUS_COLORS.warning.bg,  color: STATUS_COLORS.warning.text,  hoverBg: STATUS_COLORS.warningLight.bg  } :
                                 { borderColor: STATUS_COLORS.neutral.bg,      bgcolor: STATUS_COLORS.neutral.bg,  color: STATUS_COLORS.neutral.text,  hoverBg: STATUS_COLORS.neutral.bg       };
  return (
    <Box
      component="button"
      type="button"
      onClick={handleClick}
      title={title}
      sx={{
        appearance: 'none',
        border: '1px solid',
        borderColor: colors.borderColor,
        bgcolor: colors.bgcolor,
        color: colors.color,
        px: 1,
        py: 0.25,
        borderRadius: 1,
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        lineHeight: 1.4,
        '&:hover': { bgcolor: colors.hoverBg },
      }}
    >
      {label}
    </Box>
  );
}
