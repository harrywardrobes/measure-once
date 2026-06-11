import { useCallback, useEffect, useState } from 'react';
import { GET } from '../utils/api';
import type { PaymentHistoryResponse, PaymentHistoryData } from '../types/paymentHistory';

export interface UsePaymentHistoryResult {
  loading: boolean;
  error: string | null;
  data: PaymentHistoryData | null;
  qbConnected: boolean | null;
  refetch: () => void;
}

/**
 * Fetches payment history for a contact from the QuickBooks payment-history
 * endpoint (`GET /api/quickbooks/contacts/:contactId/payments`).
 *
 * Returns `qbConnected=false` (and `data=null`) when QuickBooks is not
 * connected. The backend caches responses for ~60 s so rapid re-mounts
 * (e.g. both DepositInvoiceModal and CustomerDetailPage mounting simultaneously)
 * do not generate duplicate QB API calls.
 */
export function usePaymentHistory(contactId: string): UsePaymentHistoryResult {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PaymentHistoryData | null>(null);
  const [qbConnected, setQbConnected] = useState<boolean | null>(null);

  const fetchData = useCallback(async () => {
    if (!contactId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await GET<PaymentHistoryResponse>(
        `/api/quickbooks/contacts/${encodeURIComponent(contactId)}/payments`,
      );
      if (!result.qbConnected) {
        setQbConnected(false);
        setData(null);
      } else {
        setQbConnected(true);
        setData(result);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return { loading, error, data, qbConnected, refetch: fetchData };
}
