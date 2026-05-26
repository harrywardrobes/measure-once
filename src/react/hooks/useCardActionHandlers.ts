import { useCallback, useEffect, useRef, useState } from 'react';
import { dispatchCardActionHandler } from '../utils/dispatchCardActionHandler';

export interface CardActionHandlerBinding {
  substatus_id?: number;
  stage_key?: string;
  status_key?: string;
}

export interface CardActionHandlerData {
  id: number;
  type: string;
  config?: {
    action_name?: string;
    [key: string]: unknown;
  };
  bindings?: CardActionHandlerBinding[];
}

interface LeadSubstatus {
  id: number;
  status_key: string;
  substatus_key: string;
  label?: string;
}

type HandlerIndex = Record<string, CardActionHandlerData>;

function buildIndexes(rows: CardActionHandlerData[]): {
  byLabel: HandlerIndex;
  bySubstatus: Record<number, CardActionHandlerData>;
} {
  const byLabel: HandlerIndex = {};
  const bySubstatus: Record<number, CardActionHandlerData> = {};
  for (const h of rows || []) {
    for (const b of h.bindings || []) {
      if (b.substatus_id) {
        bySubstatus[b.substatus_id] = h;
      } else if (b.stage_key) {
        const sk = String(b.stage_key || '').toLowerCase();
        const lk = String(b.status_key || '').toLowerCase();
        byLabel[`${sk}|${lk}`] = h;
      }
    }
  }
  return { byLabel, bySubstatus };
}

export interface UseCardActionHandlersResult {
  cardActionHandlerFor: (
    stageKey: string,
    leadStatusKey: string | undefined,
    hwSubstatusValue: string | undefined,
  ) => CardActionHandlerData | null;
  loading: boolean;
  error: string | null;
}

export function useCardActionHandlers(): UseCardActionHandlersResult {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const byLabelRef = useRef<HandlerIndex>({});
  const bySubstatusRef = useRef<Record<number, CardActionHandlerData>>({});
  const substatusesRef = useRef<LeadSubstatus[]>([]);

  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const fetchAll = useCallback(async () => {
    try {
      // Fetch handlers and substatuses in parallel; treat each independently so
      // a substatus failure does not prevent label-based handlers from working.
      const [handlersRes, substatusesRes] = await Promise.all([
        fetch('/api/card-action-handlers'),
        fetch('/api/lead-substatuses'),
      ]);

      if (!handlersRes.ok) throw new Error(`handlers ${handlersRes.status}`);

      const handlers: CardActionHandlerData[] = await handlersRes.json();
      const { byLabel, bySubstatus } = buildIndexes(handlers);
      byLabelRef.current = byLabel;
      bySubstatusRef.current = bySubstatus;

      if (substatusesRes.ok) {
        const substatuses: LeadSubstatus[] = await substatusesRes.json();
        substatusesRef.current = Array.isArray(substatuses) ? substatuses : [];
      } else {
        console.warn('[useCardActionHandlers] substatuses fetch failed:', substatusesRes.status);
      }

      setError(null);
      setLoading(false);
      bump();
    } catch (e) {
      console.warn('[useCardActionHandlers] fetch failed:', (e as Error).message);
      setError((e as Error).message);
      setLoading(false);
    }
  }, [bump]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel('card_action_handlers_changed');
    const onMsg = () => fetchAll();
    ch.addEventListener('message', onMsg);
    return () => {
      ch.removeEventListener('message', onMsg);
      ch.close();
    };
  }, [fetchAll]);

  const cardActionHandlerFor = useCallback(
    (
      stageKey: string,
      leadStatusKey: string | undefined,
      hwSubstatusValue: string | undefined,
    ): CardActionHandlerData | null => {
      if (hwSubstatusValue) {
        const v = String(hwSubstatusValue).toUpperCase();
        const sk = String(leadStatusKey || '').toUpperCase();
        const prefix = `${sk}__`;
        if (v.startsWith(prefix)) {
          const subKey = v.slice(prefix.length);
          const row = substatusesRef.current.find(
            (r) =>
              String(r.status_key).toUpperCase() === sk &&
              String(r.substatus_key).toUpperCase() === subKey,
          );
          if (row && bySubstatusRef.current[row.id]) {
            return bySubstatusRef.current[row.id];
          }
        }
      }
      const sKey = String(stageKey || '').toLowerCase();
      const lsKey = String(leadStatusKey || '').toLowerCase();
      return byLabelRef.current[`${sKey}|${lsKey}`] || null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byLabelRef, bySubstatusRef, substatusesRef],
  );

  // Backwards-compat shims for pages that no longer load card-action-handlers.js
  // (currently sales.html which now loads card-action-modals.js instead).
  //
  // window.cardActionHandlerFor — lookup function used by test probes and
  // vanilla-JS call-sites.  Only set when card-action-handlers.js hasn't already
  // set it (that file is still present on survey/customer-detail and its re-fetch
  // logic is tested directly by the test suite).
  //
  // window.loadCardActionHandlers — async re-fetch trigger.  The test suite calls
  // this to force the in-page index to update after creating new handlers mid-test.
  // Only set when card-action-handlers.js hasn't already claimed the name.
  //
  // window.dispatchCardActionHandler — modal dispatch.  The TypeScript
  // implementation lives in src/react/utils/dispatchCardActionHandler.ts; we
  // expose it on window so test probes (start-design-visit, design-visit) can
  // call it directly on the sales page without going through a React onClick.
  // card-action-modals.js registers a fallback copy only when this hook hasn't
  // already claimed the name.
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    const cleanups: (() => void)[] = [];

    if (typeof w.cardActionHandlerFor !== 'function') {
      w.cardActionHandlerFor = cardActionHandlerFor;
      cleanups.push(() => {
        if (w.cardActionHandlerFor === cardActionHandlerFor) delete w.cardActionHandlerFor;
      });
    }

    if (typeof w.loadCardActionHandlers !== 'function') {
      w.loadCardActionHandlers = fetchAll;
      cleanups.push(() => {
        if (w.loadCardActionHandlers === fetchAll) delete w.loadCardActionHandlers;
      });
    }

    if (typeof w.dispatchCardActionHandler !== 'function') {
      w.dispatchCardActionHandler = dispatchCardActionHandler;
      cleanups.push(() => {
        if (w.dispatchCardActionHandler === dispatchCardActionHandler)
          delete w.dispatchCardActionHandler;
      });
    }

    return () => cleanups.forEach((fn) => fn());
  }, [cardActionHandlerFor, fetchAll]);

  return { cardActionHandlerFor, loading, error };
}
