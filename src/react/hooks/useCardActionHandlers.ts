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
  action_label?: string;
}

interface StageActionLabel {
  stage_key: string;
  status_key: string;
  label: string;
}

type HandlerIndex = Record<string, CardActionHandlerData>;

function buildIndexes(rows: CardActionHandlerData[]): {
  byLabel: HandlerIndex;
  bySubstatus: Record<number, CardActionHandlerData>;
  byId: Record<number, CardActionHandlerData>;
} {
  const byLabel: HandlerIndex = {};
  const bySubstatus: Record<number, CardActionHandlerData> = {};
  const byId: Record<number, CardActionHandlerData> = {};
  for (const h of rows || []) {
    byId[h.id] = h;
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
  return { byLabel, bySubstatus, byId };
}

export interface UseCardActionHandlersResult {
  cardActionHandlerFor: (
    stageKey: string,
    leadStatusKey: string | undefined,
    hwSubstatusValue: string | undefined,
  ) => CardActionHandlerData | null;
  resolveActionLabel: (
    stageKey: string,
    leadStatusKey: string | undefined,
    substageId: string | undefined,
    hwSubstatusValue: string | undefined,
  ) => string;
  loading: boolean;
  error: string | null;
}

export function useCardActionHandlers(): UseCardActionHandlersResult {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const byLabelRef = useRef<HandlerIndex>({});
  const bySubstatusRef = useRef<Record<number, CardActionHandlerData>>({});
  const byIdRef = useRef<Record<number, CardActionHandlerData>>({});
  const substatusesRef = useRef<LeadSubstatus[]>([]);
  // `${STATUS_KEY}|${SUBSTATUS_KEY}` → action_label (uppercase keys)
  const substatusActionLabelMapRef = useRef<Record<string, string>>({});
  // `${stage_key}|${status_key}` → label (lowercase keys)
  const stageActionLabelMapRef = useRef<Record<string, string>>({});

  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const fetchSubstatuses = useCallback(async () => {
    try {
      const res = await fetch('/api/lead-substatuses');
      if (!res.ok) {
        console.warn('[useCardActionHandlers] substatuses fetch failed:', res.status);
        return;
      }
      const substatuses: LeadSubstatus[] = await res.json();
      substatusesRef.current = Array.isArray(substatuses) ? substatuses : [];
      const actionMap: Record<string, string> = {};
      for (const r of substatusesRef.current) {
        if (!r.action_label) continue;
        const k = `${String(r.status_key).toUpperCase()}|${String(r.substatus_key).toUpperCase()}`;
        actionMap[k] = r.action_label;
      }
      substatusActionLabelMapRef.current = actionMap;
    } catch (e) {
      console.warn('[useCardActionHandlers] substatuses fetch error:', (e as Error).message);
    }
  }, []);

  const fetchStageActionLabels = useCallback(async () => {
    try {
      const res = await fetch('/api/stage-action-labels');
      if (!res.ok) {
        console.warn('[useCardActionHandlers] stage-action-labels fetch failed:', res.status);
        return;
      }
      const rows: StageActionLabel[] = await res.json();
      const m: Record<string, string> = {};
      for (const r of rows || []) {
        const s = String(r.stage_key || '').toLowerCase();
        const k = String(r.status_key || '').toLowerCase();
        const label = String(r.label || '').trim();
        if (s && label) m[`${s}|${k}`] = label;
      }
      stageActionLabelMapRef.current = m;
    } catch (e) {
      console.warn('[useCardActionHandlers] stage-action-labels fetch error:', (e as Error).message);
    }
  }, []);

  const fetchAll = useCallback(async () => {
    try {
      const [handlersRes] = await Promise.all([
        fetch('/api/card-action-handlers'),
        fetchSubstatuses(),
        fetchStageActionLabels(),
      ]);

      if (!handlersRes.ok) throw new Error(`handlers ${handlersRes.status}`);

      const handlers: CardActionHandlerData[] = await handlersRes.json();
      const { byLabel, bySubstatus, byId } = buildIndexes(handlers);
      byLabelRef.current = byLabel;
      bySubstatusRef.current = bySubstatus;
      byIdRef.current = byId;

      setError(null);
      setLoading(false);
      bump();
    } catch (e) {
      console.warn('[useCardActionHandlers] fetch failed:', (e as Error).message);
      setError((e as Error).message);
      setLoading(false);
    }
  }, [bump, fetchSubstatuses, fetchStageActionLabels]);

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

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel('stage_action_labels_changed');
    const onMsg = () => fetchStageActionLabels().then(bump);
    ch.addEventListener('message', onMsg);
    return () => {
      ch.removeEventListener('message', onMsg);
      ch.close();
    };
  }, [fetchStageActionLabels, bump]);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel('lead_substatuses_changed');
    const onMsg = () => fetchSubstatuses().then(bump);
    ch.addEventListener('message', onMsg);
    return () => {
      ch.removeEventListener('message', onMsg);
      ch.close();
    };
  }, [fetchSubstatuses, bump]);

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

  // Resolve the action-strip label for a card without calling any window globals.
  // Priority mirrors workflow-core.js:
  //   1. Sub-status action label (if contact has hw_lead_substatus matching the LS)
  //   2. Per-LS stage action label (if contact has a lead status)
  //   3. Per-substageId stage action label (legacy fallback, no LS)
  //   4. Per-stage "no lead status" row (stage|'')
  const resolveActionLabel = useCallback(
    (
      stageKey: string,
      leadStatusKey: string | undefined,
      substageId: string | undefined,
      hwSubstatusValue: string | undefined,
    ): string => {
      // 1. Substatus action label
      if (leadStatusKey && hwSubstatusValue) {
        const sk = String(leadStatusKey).toUpperCase();
        const v = String(hwSubstatusValue).toUpperCase();
        const prefix = `${sk}__`;
        if (v.startsWith(prefix)) {
          const subKey = v.slice(prefix.length);
          const fromSub = substatusActionLabelMapRef.current[`${sk}|${subKey}`];
          if (fromSub) return fromSub;
        }
      }
      const sKey = String(stageKey || '').toLowerCase();
      const lsKey = String(leadStatusKey || '').toLowerCase();
      // 2. Per-LS stage action label
      if (lsKey) {
        return stageActionLabelMapRef.current[`${sKey}|${lsKey}`] || '';
      }
      // 3. Per-substageId legacy fallback (lowercase to match map key format)
      if (substageId) {
        const fromSub = stageActionLabelMapRef.current[`${sKey}|${String(substageId).toLowerCase()}`];
        if (fromSub) return fromSub;
      }
      // 4. Per-stage "no lead status" row
      return stageActionLabelMapRef.current[`${sKey}|`] || '';
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [substatusActionLabelMapRef, stageActionLabelMapRef],
  );

  // Backwards-compat shims for pages that no longer load card-action-handlers.js
  // (currently sales.html which now loads card-action-modals.js instead).
  //
  // window.cardActionHandlerFor — label/substatus lookup used by test probes and
  // vanilla-JS call-sites.  Only set when card-action-handlers.js hasn't already
  // set it (that file is still present on survey/customer-detail and its re-fetch
  // logic is tested directly by the test suite).
  //
  // window.cardActionHandlerById — id-keyed lookup used by the click-delegation
  // handler in card-action-modals.js so it can retrieve the full config (e.g.
  // intermediateLeadStatus) without maintaining its own duplicate index.
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

    if (typeof w.cardActionHandlerById !== 'function') {
      const handlerById = (id: number) => byIdRef.current[id] ?? null;
      w.cardActionHandlerById = handlerById;
      cleanups.push(() => {
        if (w.cardActionHandlerById === handlerById) delete w.cardActionHandlerById;
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
  }, [cardActionHandlerFor, fetchAll, byIdRef]);

  return { cardActionHandlerFor, resolveActionLabel, loading, error };
}
