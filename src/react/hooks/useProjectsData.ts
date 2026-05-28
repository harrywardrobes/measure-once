import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

export interface ProjectContact {
  id: string;
  /** Set to true when the contact has room data but its hs_lead_status is
   *  absent or not present in lead_status_config.  The card is still shown
   *  on the Projects board but carries an amber "Unknown status" badge. */
  _statusUnknown?: boolean;
  properties?: {
    firstname?: string;
    lastname?: string;
    email?: string;
    closedate?: string;
    lastmodifieddate?: string;
    hs_lead_status?: string;
    hw_lead_substatus?: string;
    customer_number?: string;
    zip?: string;
  };
}

export interface ProjectRoom {
  room?: string;
  stageKey?: string;
  roomStatus?: string;
  assignedFitterId?: string | null;
  installStart?: string | null;
  statusId?: string;
}

export interface ProjectPlatformUser {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  profileImageUrl?: string;
}

export interface ProjectWorkflowStage {
  label?: string;
  statuses?: Array<{ id: string; label: string }>;
}

export interface ProjectWorkflowDef {
  stages?: Record<string, ProjectWorkflowStage>;
}

export interface ProjectsData {
  loading: boolean;
  error: string | null;
  contacts: ProjectContact[];
  stageCache: Record<string, ProjectRoom[]>;
  workflow: ProjectWorkflowDef | undefined;
  platformUsers: ProjectPlatformUser[];
  currentUserId: string | undefined;
  roomAssignmentsStale: boolean;
  draftVisitIds: Record<string, number | string>;
  refresh: () => void;
  updateRoomAssignment: (contactId: string, roomIdx: number, fitterId: string | null) => void;
}

declare global {
  interface Window {
    __setTestPendingRoomStale?: (v: boolean) => void;
  }
}

export function useProjectsData(): ProjectsData {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [contacts, setContacts] = useState<ProjectContact[]>([]);
  const [stageCache, setStageCache] = useState<Record<string, ProjectRoom[]>>({});
  const [workflow, setWorkflow] = useState<ProjectWorkflowDef | undefined>(undefined);
  const [platformUsers, setPlatformUsers] = useState<ProjectPlatformUser[]>([]);
  const [roomAssignmentsStale, setRoomAssignmentsStale] = useState(false);
  const [fetchNonce, setFetchNonce] = useState(0);
  const [draftVisitIds, setDraftVisitIds] = useState<Record<string, number | string>>({});
  const [draftRefreshTick, setDraftRefreshTick] = useState(0);

  // Pending stale value while the tab is hidden — applied on visibilitychange.
  const pendingRoomStaleRef = useRef<boolean | null>(null);

  // Keep a ref to latest contacts for draft-visit refetch.
  const contactsRef = useRef<ProjectContact[]>([]);

  const refresh = useCallback(() => setFetchNonce((n) => n + 1), []);

  // ── Expose test hook for visibility integration tests ──────────────────────
  // Lets the room-stale-banner-visibility test drive pendingRoomStaleRef
  // directly without a network round-trip. workflow-core.js exposes its own
  // hook for non-React pages; this one covers the projects page (React-only).
  useEffect(() => {
    window.__setTestPendingRoomStale = (v: boolean) => {
      pendingRoomStaleRef.current = v;
    };
    return () => {
      delete window.__setTestPendingRoomStale;
    };
  }, []);

  // ── Apply pending stale on visibilitychange → visible ─────────────────────
  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden && pendingRoomStaleRef.current !== null) {
        setRoomAssignmentsStale(pendingRoomStaleRef.current);
        pendingRoomStaleRef.current = null;
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // ── Fetch data ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const [leadsRes, workflowRes, localdataRes, usersRes] = await Promise.all([
          fetch('/api/project-contacts', { headers: { Accept: 'application/json' } }),
          fetch('/api/workflow', { headers: { Accept: 'application/json' } }),
          fetch('/api/localdata/all', { headers: { Accept: 'application/json' } }),
          fetch('/api/platform-users', { headers: { Accept: 'application/json' } }),
        ]);

        if (leadsRes.status === 401 || workflowRes.status === 401 ||
            localdataRes.status === 401 || usersRes.status === 401) {
          window.location.href = '/login';
          return;
        }

        const [leadsData, workflowData, localdataData, usersData] = await Promise.all([
          leadsRes.json().catch(() => ({})),
          workflowRes.json().catch(() => ({})),
          localdataRes.json().catch(() => ({})),
          usersRes.json().catch(() => []),
        ]);

        if (cancelled) return;

        // Room assignments stale flag comes from /api/localdata/all.
        // If the tab is hidden, defer the update until visibilitychange → visible.
        const nextStale = (localdataRes.headers.get('X-Cache-Status') || '').toLowerCase() === 'stale';
        if (document.hidden) {
          pendingRoomStaleRef.current = nextStale;
        } else {
          setRoomAssignmentsStale(nextStale);
          pendingRoomStaleRef.current = null;
        }

        // /api/project-contacts returns { results, total } where results is the
        // HubSpot contacts array (all pipeline stages, not just OPEN_DEAL).
        const rawContacts: ProjectContact[] = leadsData.results || [];
        const rawCache: Record<string, ProjectRoom[]> = {};

        const mergedCache: Record<string, ProjectRoom[]> = { ...rawCache };
        if (localdataData && typeof localdataData === 'object') {
          for (const [cid, rooms] of Object.entries(localdataData)) {
            if (Array.isArray(rooms)) {
              mergedCache[cid] = rooms as ProjectRoom[];
            }
          }
        }

        contactsRef.current = rawContacts;
        setContacts(rawContacts);
        setStageCache(mergedCache);
        setWorkflow(workflowData);
        setPlatformUsers(Array.isArray(usersData) ? usersData : []);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        const err = e as Error;
        if (err.message === 'Unauthorized') return;
        setError(err.message || 'Failed to load projects');
        setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [fetchNonce]);

  // ── Re-fetch when localdata changes in another tab ─────────────────────────
  useEffect(() => {
    const onLocalData = () => setFetchNonce((n) => n + 1);
    document.addEventListener('localdata-updated', onLocalData);
    return () => document.removeEventListener('localdata-updated', onLocalData);
  }, []);

  // ── Draft visit detection ──────────────────────────────────────────────────
  // Batch-fetch in-progress (draft) design visit IDs for all visible contacts
  // so the "Continue designing" action can be shown on relevant cards.
  useEffect(() => {
    if (contactsRef.current.length === 0) return;
    let cancelled = false;
    const ids = contactsRef.current.map((c) => c.id).join(',');
    fetch(`/api/design-visits/in-progress?contactIds=${encodeURIComponent(ids)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Array<{ id: number | string; contactId: string }>) => {
        if (cancelled) return;
        const map: Record<string, number | string> = {};
        for (const row of rows) map[row.contactId] = row.id;
        setDraftVisitIds(map);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [contacts, draftRefreshTick]); // re-run when contacts load or draft changes

  // Listen for design_visit_draft_changed broadcast to refresh draft IDs.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const bc = new BroadcastChannel('design_visit_draft_changed');
    bc.addEventListener('message', () => setDraftRefreshTick((t) => t + 1));
    return () => bc.close();
  }, []);

  // ── Re-fetch when a customer submits their info (photos received badge) ─────
  // Opens a direct EventSource to /api/hubspot/webhook-events and listens for
  // `customer_info_submitted` events pushed by the server after a successful
  // POST /api/customer-info/:token.  Using a direct connection here means the
  // projects board reacts immediately without requiring WorkflowDataProvider
  // (which is only mounted on the customer-detail page) to be open in another
  // tab.  A BroadcastChannel relay from WorkflowDataContext would only work if
  // the staff member happened to have a customer-detail tab open simultaneously.
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = 2000;
    let destroyed = false;

    function connect() {
      if (destroyed) return;
      try {
        source = new EventSource('/api/hubspot/webhook-events');
        source.addEventListener('message', (e) => {
          try {
            const payload = JSON.parse(e.data as string) as { type?: string };
            // Primary trigger: customer just submitted, cache already invalidated.
            // Fallback: HubSpot webhook fires after the substatus is applied,
            // catching any race where the SSE fired before HubSpot propagated.
            if (
              payload.type === 'customer_info_submitted' ||
              payload.type === 'hs_lead_status_changed'
            ) {
              setFetchNonce((n) => n + 1);
            }
          } catch { /* malformed frame — ignore */ }
        });
        source.addEventListener('open', () => { reconnectDelay = 2000; });
        source.addEventListener('error', () => {
          source?.close();
          source = null;
          if (destroyed) return;
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            reconnectDelay = Math.min(reconnectDelay * 2, 60000);
            connect();
          }, reconnectDelay);
        });
      } catch { /* SSE not supported in this environment */ }
    }

    const initialTimer = setTimeout(connect, 500);
    return () => {
      destroyed = true;
      clearTimeout(initialTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      source?.close();
    };
  }, []);

  // ── Optimistic room-assignment update ──────────────────────────────────────
  const updateRoomAssignment = useCallback(
    (contactId: string, roomIdx: number, fitterId: string | null) => {
      setStageCache((prev) => {
        const cached = prev[contactId];
        if (!cached || cached[roomIdx] === undefined) return prev;
        const updated = [...cached];
        updated[roomIdx] = { ...updated[roomIdx], assignedFitterId: fitterId };
        return { ...prev, [contactId]: updated };
      });
    },
    [],
  );

  return {
    loading,
    error,
    contacts,
    stageCache,
    workflow,
    platformUsers,
    currentUserId: user?.id,
    roomAssignmentsStale,
    draftVisitIds,
    refresh,
    updateRoomAssignment,
  };
}
