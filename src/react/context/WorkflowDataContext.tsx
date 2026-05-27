import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { DEFAULT_WORKFLOW, WorkflowDef } from '../lib/workflowConfig';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Room {
  room?: string;
  roomStatus?: string;
  stageKey?: string;
  statusId?: string;
  sourceId?: string | null;
  assignedFitterId?: string | null;
  installStart?: string | null;
  stageDates?: Record<string, string> | null;
  substateDates?: Record<string, string> | null;
}

export interface LeadStatusOption {
  value: string;
  label: string;
  excluded_from_sales?: boolean;
  stage?: string | null;
}

export interface LeadSubstatus {
  id: number;
  status_key: string;
  substatus_key: string;
  label: string;
  action_label?: string;
}

// ── Context shape ──────────────────────────────────────────────────────────────

export interface WorkflowDataContextValue {
  contactStageCache: Record<string, Room[]>;
  leadStatuses: LeadStatusOption[];
  nullLsLabel: string;
  leadSubstatuses: LeadSubstatus[];
  workflow: WorkflowDef | null;
  roomAssignmentsStale: boolean;
  openLeadsStale: boolean;
  loading: boolean;
  error: string | null;
  refreshContactStageCache: () => Promise<void>;
  refreshLeadStatuses: () => Promise<void>;
}

const WorkflowDataContext = createContext<WorkflowDataContextValue>({
  contactStageCache: {},
  leadStatuses: [],
  nullLsLabel: 'No status',
  leadSubstatuses: [],
  workflow: null,
  roomAssignmentsStale: false,
  openLeadsStale: false,
  loading: true,
  error: null,
  refreshContactStageCache: async () => {},
  refreshLeadStatuses: async () => {},
});

export function useWorkflowData(): WorkflowDataContextValue {
  return useContext(WorkflowDataContext);
}

// ── Provider ───────────────────────────────────────────────────────────────────

export function WorkflowDataProvider({ children }: { children: React.ReactNode }) {
  const [contactStageCache, setContactStageCache] = useState<Record<string, Room[]>>({});
  const [leadStatuses, setLeadStatuses] = useState<LeadStatusOption[]>([]);
  const [nullLsLabel, setNullLsLabel] = useState('No status');
  const [leadSubstatuses, setLeadSubstatuses] = useState<LeadSubstatus[]>([]);
  const [workflow, setWorkflow] = useState<WorkflowDef | null>(null);
  const [roomAssignmentsStale, setRoomAssignmentsStale] = useState(false);
  const [openLeadsStale, setOpenLeadsStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Pending stale state refs — deferred while the tab is hidden, applied on focus.
  const pendingOpenLeadsStaleRef = useRef<boolean | null>(null);
  const pendingRoomStaleRef = useRef<boolean | null>(null);
  // Tracks whether the user dismissed the room-stale banner this session.
  const roomStaleDismissedRef = useRef(false);
  // Stable ref so SSE / vis effects can call fetchLeadSubstatuses without
  // adding it to their deps arrays (it is always the same useCallback identity).
  const fetchLeadSubstatusesRef = useRef<() => Promise<void>>(() => Promise.resolve());

  // ── Data fetchers ────────────────────────────────────────────────────────

  const fetchContactStageCache = useCallback(async (): Promise<void> => {
    try {
      const r = await fetch('/api/localdata/all', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
      if (r.status === 401) { window.location.href = '/login'; return; }
      const data = await r.json().catch(() => ({})) as Record<string, Room[]>;
      if (!r.ok) return;

      const cacheStatus = r.headers.get('X-Cache-Status');
      if (cacheStatus === 'fresh' || cacheStatus === 'stale') {
        const nextStale = cacheStatus === 'stale';
        if (document.hidden) {
          pendingRoomStaleRef.current = nextStale;
        } else {
          if (!nextStale) roomStaleDismissedRef.current = false;
          setRoomAssignmentsStale(nextStale);
        }
      }

      const cache: Record<string, Room[]> = {};
      for (const [contactId, rooms] of Object.entries(data || {})) {
        cache[contactId] = rooms;
      }
      setContactStageCache(cache);

      // Keep window.state.contactStageCache in sync for card-action-handlers.js
      try {
        const st = (window as unknown as Record<string, Record<string, unknown>>).state;
        if (st) st.contactStageCache = cache;
      } catch { /* ignore */ }
    } catch (e) {
      console.warn('[WorkflowDataContext] contactStageCache fetch error:', (e as Error).message);
    }
  }, []);

  const fetchLeadStatuses = useCallback(async (): Promise<void> => {
    try {
      const r = await fetch('/api/lead-statuses');
      if (!r.ok) return;
      const rows = await r.json() as Array<{
        is_null_row?: boolean;
        key: string;
        label: string;
        excluded_from_sales?: boolean;
        stage?: string;
      }>;
      if (!Array.isArray(rows)) return;

      const nullRow = rows.find(row => row.is_null_row);
      const label = nullRow?.label || 'No status';
      const opts: LeadStatusOption[] = rows
        .filter(row => !row.is_null_row)
        .map(row => ({
          value: row.key,
          label: row.label,
          excluded_from_sales: !!row.excluded_from_sales,
          stage: row.stage || null,
        }));

      setLeadStatuses(opts);
      setNullLsLabel(label);

      // Keep window globals in sync for card-action-handlers.js
      const g = window as unknown as Record<string, unknown>;
      g.LEAD_STATUS_OPTIONS    = opts;
      g.NULL_LEAD_STATUS_LABEL = label;
      g.LEAD_STATUSES_LOADED   = true;
    } catch (e) {
      console.warn('[WorkflowDataContext] leadStatuses fetch error:', (e as Error).message);
    }
  }, []);

  const fetchLeadSubstatuses = useCallback(async (): Promise<void> => {
    try {
      const r = await fetch(`/api/lead-substatuses?_t=${Date.now()}`);
      if (!r.ok) return;
      const rows = await r.json() as LeadSubstatus[];
      if (!Array.isArray(rows)) return;
      setLeadSubstatuses(rows);
      // Keep window.LEAD_SUBSTATUSES in sync for card-action-handlers.js
      (window as unknown as Record<string, unknown>).LEAD_SUBSTATUSES = rows;
      // Notify CustomerDetailPage (and any other local listener) synchronously
      // so it can update its own leadSubs state without relying on React context
      // propagation timing across a Suspense boundary.
      window.dispatchEvent(new CustomEvent('mo:lead-substatuses-updated', { detail: rows }));
    } catch (e) {
      console.warn('[WorkflowDataContext] leadSubstatuses fetch error:', (e as Error).message);
    }
  }, []);

  // Keep the ref current so SSE / vis effects can call it without adding it
  // to their deps arrays (it is stable — same function identity every render).
  fetchLeadSubstatusesRef.current = fetchLeadSubstatuses;

  const fetchWorkflow = useCallback(async (): Promise<void> => {
    try {
      const r = await fetch('/api/workflow');
      if (!r.ok) return;
      const saved = await r.json().catch(() => null) as WorkflowDef | null;
      const wf: WorkflowDef = saved || DEFAULT_WORKFLOW;
      // Normalise legacy tasks → statuses
      if (wf.stages) {
        for (const stage of Object.values(wf.stages)) {
          if (stage.tasks && !stage.statuses) {
            stage.statuses = stage.tasks.map((t, i) => ({ id: `task_${i}`, label: t, hint: '' }));
          }
        }
      }
      setWorkflow(wf);
      // Keep window.state.workflow in sync for card-action-handlers.js
      try {
        const st = (window as unknown as Record<string, Record<string, unknown>>).state;
        if (st) st.workflow = wf;
      } catch { /* ignore */ }
    } catch (e) {
      console.warn('[WorkflowDataContext] workflow fetch error:', (e as Error).message);
    }
  }, []);

  // ── Initial load ─────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await Promise.all([
          fetchWorkflow(),
          fetchContactStageCache(),
          fetchLeadStatuses(),
          fetchLeadSubstatuses(),
        ]);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── localdata-updated → refresh room assignments ──────────────────────────
  // Fired by customer-detail page after saving room/stage data, and by the SSE
  // handler when a HubSpot webhook arrives. Refreshes contactStageCache and
  // forwards result events so the board pages can respond.

  useEffect(() => {
    const onLocaldataUpdated = () => {
      fetchContactStageCache()
        .then(() => {
          document.dispatchEvent(new CustomEvent('sales-board-data-ready'));
          document.dispatchEvent(new CustomEvent('survey-board-data-ready'));
        })
        .catch(() => {
          document.dispatchEvent(new CustomEvent('sales-board-bg-refresh-failed'));
          document.dispatchEvent(new CustomEvent('survey-board-bg-refresh-failed'));
        });
    };
    document.addEventListener('localdata-updated', onLocaldataUpdated);
    return () => document.removeEventListener('localdata-updated', onLocaldataUpdated);
  }, [fetchContactStageCache]);

  // ── BroadcastChannel listeners ────────────────────────────────────────────

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const bc = new BroadcastChannel('lead_statuses_changed');
    const onMsg = () => { void fetchLeadStatuses(); };
    bc.addEventListener('message', onMsg);
    return () => { bc.removeEventListener('message', onMsg); bc.close(); };
  }, [fetchLeadStatuses]);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const bc = new BroadcastChannel('lead_substatuses_changed');
    const onMsg = () => { void fetchLeadSubstatuses(); };
    bc.addEventListener('message', onMsg);
    return () => { bc.removeEventListener('message', onMsg); bc.close(); };
  }, [fetchLeadSubstatuses]);

  // ── Visibility change — apply deferred stale updates ─────────────────────
  //
  // `window.postMessage` is spec-guaranteed to deliver asynchronously (new
  // task), even when called from within a Puppeteer `evaluate()` call.  The
  // companion listener calls fetchLeadSubstatuses() from that new task —
  // i.e. when Puppeteer's CDP session is idle — so Fetch.requestPaused is
  // delivered and continued without any ordering issues.

  const WDC_VIS_MSG = '__wdc_vis_refresh_subs__';

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.data === WDC_VIS_MSG) void fetchLeadSubstatusesRef.current();
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (pendingRoomStaleRef.current !== null) {
        const v = pendingRoomStaleRef.current;
        pendingRoomStaleRef.current = null;
        if (!v) roomStaleDismissedRef.current = false;
        setRoomAssignmentsStale(v);
      }
      if (pendingOpenLeadsStaleRef.current !== null) {
        const v = pendingOpenLeadsStaleRef.current;
        pendingOpenLeadsStaleRef.current = null;
        setOpenLeadsStale(v);
      }
      // Use window.postMessage as an async trampoline.  The spec mandates
      // that postMessage delivery always fires in a new task, so the
      // companion 'message' listener above calls fetchLeadSubstatuses()
      // from outside the current synchronous event-handler frame.
      window.postMessage(WDC_VIS_MSG, '*');
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  // ── HubSpot webhook SSE listener ──────────────────────────────────────────

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let sseSource: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = 2000;

    function connect() {
      if (sseSource) { sseSource.close(); sseSource = null; }
      try {
        sseSource = new EventSource('/api/hubspot/webhook-events');
        sseSource.addEventListener('message', (e) => {
          let payload: { type?: string };
          try { payload = JSON.parse(e.data as string); } catch { return; }
          if (payload.type === 'hs_lead_status_changed') {
            try {
              const bc = new BroadcastChannel('lead_statuses_changed');
              bc.postMessage({ ts: Date.now(), src: 'hs_webhook' });
              bc.close();
            } catch { /* ignore */ }
          }
          if (payload.type === 'lead_substatuses_changed') {
            void fetchLeadSubstatusesRef.current();
          }
        });
        sseSource.addEventListener('open', () => { reconnectDelay = 2000; });
        sseSource.addEventListener('error', () => {
          sseSource?.close();
          sseSource = null;
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            reconnectDelay = Math.min(reconnectDelay * 2, 60000);
            connect();
          }, reconnectDelay);
        });
      } catch { /* SSE not supported */ }
    }

    const initialTimer = setTimeout(connect, 500);
    return () => {
      clearTimeout(initialTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (sseSource) sseSource.close();
    };
  }, []);

  // ── Expose fetch functions as window globals ──────────────────────────────
  // window.loadLeadStatuses / loadLeadSubstatuses are used by the vanilla-JS
  // pickers (card-action-handlers.js) and by test harness bootstrapFilter().
  // Must run BEFORE the lazy page chunk loads so the functions are available
  // immediately after the React island mounts (preSuspenseWrap pattern).
  useEffect(() => {
    const g = window as unknown as Record<string, unknown>;
    g.loadLeadStatuses    = fetchLeadStatuses;
    g.loadLeadSubstatuses = fetchLeadSubstatuses;
    return () => {
      if (g.loadLeadStatuses    === fetchLeadStatuses)    delete g.loadLeadStatuses;
      if (g.loadLeadSubstatuses === fetchLeadSubstatuses) delete g.loadLeadSubstatuses;
    };
  }, [fetchLeadStatuses, fetchLeadSubstatuses]);

  // ── Test hooks (window.__setTestPendingOpenLeadsStale / RoomStale) ─────────
  // Integration tests drive the pending refs directly without a network round-
  // trip — same pattern as the original workflow-core.js implementation.

  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__setTestPendingOpenLeadsStale = (v: boolean) => {
      pendingOpenLeadsStaleRef.current = v;
    };
    w.__setTestPendingRoomStale = (v: boolean) => {
      pendingRoomStaleRef.current = v;
    };
    return () => {
      delete w.__setTestPendingOpenLeadsStale;
      delete w.__setTestPendingRoomStale;
    };
  }, []);

  // ── Open-leads stale badge (DOM) ──────────────────────────────────────────
  // Rendered as a fixed bottom banner with id="open-leads-stale-hint".
  // Tests check for the .ls-stale-hint class and the element's presence.

  useEffect(() => {
    const BADGE_ID = 'open-leads-stale-hint';
    const existing = document.getElementById(BADGE_ID);
    if (openLeadsStale) {
      if (!existing) {
        const el = document.createElement('div');
        el.id = BADGE_ID;
        el.className = 'ls-stale-hint';
        el.innerHTML = '<span>\u26a0\ufe0f Lead data may be slightly out of date \u2014 refresh to update.</span>';
        document.body.appendChild(el);
      }
    } else {
      if (existing) existing.remove();
    }
  }, [openLeadsStale]);

  // ── Room-assignments stale banner (DOM) ───────────────────────────────────
  // Rendered as a fixed bottom banner with id="room-stale-banner".
  // Tests check for the element's presence and the dismiss button.

  useEffect(() => {
    const BANNER_ID = 'room-stale-banner';
    const existing = document.getElementById(BANNER_ID);
    if (roomAssignmentsStale && !roomStaleDismissedRef.current) {
      if (!existing) {
        const el = document.createElement('div');
        el.id = BANNER_ID;
        el.className = 'room-stale-banner';
        el.setAttribute('role', 'alert');
        const span = document.createElement('span');
        span.textContent = 'Room data may be out of date \u2014 showing last cached assignments';
        const btn = document.createElement('button');
        btn.className = 'room-stale-banner-dismiss';
        btn.setAttribute('aria-label', 'dismiss stale banner');
        btn.textContent = '\u00d7';
        btn.addEventListener('click', () => {
          roomStaleDismissedRef.current = true;
          el.remove();
        });
        el.appendChild(span);
        el.appendChild(btn);
        document.body.appendChild(el);
      }
    } else {
      // Reset the dismissed flag when data is fresh so the banner can reappear.
      if (!roomAssignmentsStale) roomStaleDismissedRef.current = false;
      if (existing) existing.remove();
    }
  }, [roomAssignmentsStale]);

  // ── Context value ─────────────────────────────────────────────────────────

  const value: WorkflowDataContextValue = {
    contactStageCache,
    leadStatuses,
    nullLsLabel,
    leadSubstatuses,
    workflow,
    roomAssignmentsStale,
    openLeadsStale,
    loading,
    error,
    refreshContactStageCache: fetchContactStageCache,
    refreshLeadStatuses: fetchLeadStatuses,
  };

  return (
    <WorkflowDataContext.Provider value={value}>
      {children}
    </WorkflowDataContext.Provider>
  );
}
