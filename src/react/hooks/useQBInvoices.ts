import { useState, useCallback, useEffect } from 'react';
import type { InvoiceSummary } from '../components/InvoiceDetailDrawer';

export interface QBInvoicesState {
  connected: boolean;
  statusKnown: boolean;
  loading: boolean;
  loaded: boolean;
  loadError: boolean;
  error: string | null;
  errorCode: string | null;
  company: string | null;
  invoices: InvoiceSummary[];
}

const INITIAL_STATE: QBInvoicesState = {
  connected: false,
  statusKnown: false,
  loading: false,
  loaded: false,
  loadError: false,
  error: null,
  errorCode: null,
  company: null,
  invoices: [],
};

export interface QBInvoicesResult extends QBInvoicesState {
  refresh: () => void;
}

export function useQBInvoices(): QBInvoicesResult {
  const [state, setState] = useState<QBInvoicesState>(INITIAL_STATE);

  const load = useCallback(async () => {
    setState(prev => ({ ...prev, loading: true, loadError: false, error: null }));
    try {
      const statusRes = await fetch('/api/quickbooks/status').catch(() => null);
      const status: { connected?: boolean; company?: string } = statusRes
        ? await statusRes.json().catch(() => ({ connected: false }))
        : { connected: false };

      if (!status.connected) {
        setState(prev => ({
          ...prev,
          connected: false,
          statusKnown: true,
          loading: false,
        }));
        return;
      }

      setState(prev => ({
        ...prev,
        connected: true,
        company: status.company || null,
        statusKnown: true,
      }));

      const invRes = await fetch('/api/quickbooks/invoices');

      // 403 = user lacks admin privilege; treat as loaded with no invoices
      // so consumers don't render an indefinite loading state.
      if (invRes.status === 403) {
        setState(prev => ({
          ...prev,
          loading: false,
          loaded: true,
          invoices: [],
        }));
        return;
      }

      const data = await invRes.json().catch(() => ({})) as {
        invoices?: InvoiceSummary[];
        error?: string;
        code?: string;
      };

      if (!invRes.ok || data.error) {
        setState(prev => ({
          ...prev,
          loading: false,
          loadError: true,
          error: data.error || `Server error ${invRes.status}`,
          errorCode: data.code || null,
        }));
        return;
      }

      setState(prev => ({
        ...prev,
        loading: false,
        loaded: true,
        invoices: data.invoices || [],
      }));
    } catch (e: unknown) {
      setState(prev => ({
        ...prev,
        loading: false,
        loadError: true,
        error: (e instanceof Error ? e.message : null) || 'Failed to load invoices',
        errorCode: null,
      }));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { ...state, refresh: load };
}
