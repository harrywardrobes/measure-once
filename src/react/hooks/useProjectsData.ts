import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { subscribeLeadStatusChange } from '../utils/broadcastLeadStatus';
import { subscribeDesignVisitDraftChanged } from '../utils/broadcastDesignVisitDraft';
import { cacheRecord, cacheRecords, getMeta, readRecord, readRecords, setMeta } from '../lib/offlineDb';
import { SSE_INITIAL_CONNECT_DELAY_MS, SSE_INITIAL_RECONNECT_DELAY_MS } from '../constants/timings';

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
    phone?: string;
    mobilephone?: string;
    closedate?: string;
    lastmodifieddate?: string;
    hs_lead_status?: string;
    customer_number?: string;
    zip?: string;
    /** HubSpot timestamp (ISO string) of the last time this contact was contacted. */
    notes_last_contacted?: string;
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
  fromCache: boolean;
  contacts: ProjectContact[];
  stageCache: Record<string, ProjectRoom[]>;
  workflow: ProjectWorkflowDef | undefined;
  platformUsers: ProjectPlatformUser[];
  currentUserId: string | undefined;
  roomAssignmentsStale: boolean;
  draftVisitIds: Record<string, number | string>;
  refresh: () => void;
  updateRoomAssignment: (contactId: string, roomIdx: number, fitterId: string | null) => () => void;
  updateContactProperties: (contactId: string, props: Partial<ProjectContact['properties']>) => void;
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
  const [fromCache, setFromCache] = useState(false);
  const [contacts, setContacts] = useState<ProjectContact[]>([]);
  const [stageCache, setStageCache] = useState<Record<string, ProjectRoom[]>>({});
  const stageCacheRef = useRef(stageCache);
  stageCacheRef.current = stageCache;
  const [workflow, setWorkflow] = useState<ProjectWorkflowDef | undefined>(undefined);
  const [platformUsers, setPlatformUsers] = useState<ProjectPlatformUser[]>([]);
  const [roomAssignmentsStale, setRoomAssignmentsStale] = useState(false);
  const [refetchTrigger, setRefetchTrigger] = useState(0);
  const [draftVisitIds, setDraftVisitIds] = useState<Record<string, number | string>>({});
  const [draftRefreshTick, setDraftRefreshTick] = useState(0);

  // Pending stale value while the tab is hidden — applied on visibilitychange.
  const pendingRoomStaleRef = useRef<boolean | null>(null);

  // Keep a ref to latest contacts for draft-visit refetch.
  const contactsRef = useRef<ProjectContact[]>([]);

  const refresh = useCallback(() => setRefetchTrigger((n) => n + 1), []);

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
        // Write the freshly fetched contacts to the offline cache so the IDB
        // copy reflects the most recent SSE-triggered re-fetch.  Fire-and-forget
        // — a failure here must never affect the UI.
        void cacheRecords('customers', rawContacts);
        setStageCache(mergedCache);
        // Write the merged room-assignment cache to the offline store so the
        // Projects board reflects the most recently fetched stageCache after a
        // network drop.  Fire-and-forget — a failure here must never affect the UI.
        void setMeta('stageCache', mergedCache);
        setWorkflow(workflowData);
        setPlatformUsers(Array.isArray(usersData) ? usersData : []);
        setFromCache(false);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        const err = e as Error;
        if (err.message === 'Unauthorized') return;
        // Offline fallback: instead of showing an error, render the saved
        // stageCache and contacts from IndexedDB when network fetches fail.
        // stageCache is stored as a meta entry; contacts are in the customers
        // store (written on every successful Projects board fetch).
        const [cachedStage, cachedContacts] = await Promise.all([
          getMeta<Record<string, ProjectRoom[]>>('stageCache'),
          readRecords<ProjectContact>('customers'),
        ]);
        if (cancelled) return;
        if (cachedStage != null || cachedContacts.length > 0) {
          if (cachedContacts.length > 0) {
            contactsRef.current = cachedContacts;
            setContacts(cachedContacts);
          }
          if (cachedStage != null) {
            setStageCache(cachedStage);
          }
          setRoomAssignmentsStale(false);
          setFromCache(true);
          setError(null);
          setLoading(false);
          return;
        }
        setError(err.message || 'Failed to load projects');
        setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [refetchTrigger]);

  // ── Re-fetch when localdata changes in another tab ─────────────────────────
  useEffect(() => {
    const onLocalData = () => setRefetchTrigger((n) => n + 1);
    document.addEventListener('localdata-updated', onLocalData);
    return () => document.removeEventListener('localdata-updated', onLocalData);
  }, []);

  // ── Re-fetch when dev mode is toggled in another tab ──────────────────────
  // The server filters /api/project-contacts at response time based on
  // dev_mode_enabled, so a toggle requires a fresh fetch to update the list.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    let devModeChannel: BroadcastChannel | null = null;
    try {
      devModeChannel = new BroadcastChannel('dev_mode_changed');
      devModeChannel.onmessage = () => setRefetchTrigger((n) => n + 1);
    } catch { /* BroadcastChannel not available */ }
    return () => { devModeChannel?.close(); };
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
    return subscribeDesignVisitDraftChanged(() => setDraftRefreshTick((t) => t + 1));
  }, []);

  // ── Patch contact properties when lead-status changes in same/other tab ────
  useEffect(() => {
    return subscribeLeadStatusChange((contactId, props) => {
      setContacts((prev) =>
        prev.map((c) => {
          if (c.id !== contactId) return c;
          const patched: ProjectContact = {
            ...c,
            properties: { ...c.properties, ...props },
          };
          // If a valid hs_lead_status was broadcast, the contact is no longer
          // in an unknown-status state — clear the flag so the amber badge and
          // banner count update immediately without waiting for a full refetch.
          if (props.hs_lead_status) {
            patched._statusUnknown = false;
          }
          return patched;
        }),
      );
      // Persist the patch to the offline cache so the IndexedDB copy is also
      // up to date if the device goes offline.  Fire-and-forget — a failure
      // here must never affect the UI.
      void (async () => {
        const existing = await readRecord<ProjectContact>('customers', contactId);
        const merged: ProjectContact = existing
          ? { ...existing, properties: { ...existing.properties, ...props } }
          : { id: contactId, properties: props };
        await cacheRecord('customers', contactId, merged);
      })();
    });
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
    let reconnectDelay = SSE_INITIAL_RECONNECT_DELAY_MS;
    let destroyed = false;

    function connect() {
      if (destroyed) return;
      try {
        source = new EventSource('/api/hubspot/webhook-events');
        source.addEventListener('message', (e) => {
          try {
            const payload = JSON.parse(e.data as string) as { type?: string };
            // Primary trigger: customer just submitted, cache already invalidated.
            // Fallback: HubSpot webhook fires after the lead status is applied,
            // catching any race where the SSE fired before HubSpot propagated.
            if (
              payload.type === 'customer_info_submitted' ||
              payload.type === 'hs_lead_status_changed'
            ) {
              setRefetchTrigger((n) => n + 1);
            }
          } catch { /* malformed frame — ignore */ }
        });
        source.addEventListener('open', () => { reconnectDelay = SSE_INITIAL_RECONNECT_DELAY_MS; });
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

    const initialTimer = setTimeout(connect, SSE_INITIAL_CONNECT_DELAY_MS);
    return () => {
      destroyed = true;
      clearTimeout(initialTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      source?.close();
    };
  }, []);

  // ── Optimistic room-assignment update ──────────────────────────────────────
  // Returns a rollback function that restores the pre-update state in both
  // React state and the IDB offline snapshot.  The caller must invoke the
  // rollback if the corresponding API call fails.
  const updateRoomAssignment = useCallback(
    (contactId: string, roomIdx: number, fitterId: string | null): (() => void) => {
      const prev = stageCacheRef.current;
      const cached = prev[contactId];
      if (!cached || cached[roomIdx] === undefined) {
        return () => {};
      }

      const updated = [...cached];
      updated[roomIdx] = { ...updated[roomIdx], assignedFitterId: fitterId };
      const next = { ...prev, [contactId]: updated };

      setStageCache(next);
      // Write the optimistically updated stageCache back to the offline
      // snapshot so the Projects board reflects the latest assignment after
      // a network drop.  Fire-and-forget — a failure here must never affect
      // the UI.
      void setMeta('stageCache', next);

      // Rollback: restore the pre-update entry in both state and IDB.
      return () => {
        setStageCache((current) => ({ ...current, [contactId]: cached }));
        void setMeta('stageCache', { ...stageCacheRef.current, [contactId]: cached });
      };
    },
    [],
  );

  // ── Optimistic contact-properties patch ────────────────────────────────────
  const updateContactProperties = useCallback(
    (contactId: string, props: Partial<ProjectContact['properties']>) => {
      setContacts((prev) =>
        prev.map((c) =>
          c.id === contactId
            ? { ...c, properties: { ...c.properties, ...props } }
            : c,
        ),
      );
      // Persist to the offline cache so a subsequent network drop reflects the
      // latest values.  Fire-and-forget — failures must never affect the UI.
      void (async () => {
        const existing = await readRecord<ProjectContact>('customers', contactId);
        const merged: ProjectContact = existing
          ? { ...existing, properties: { ...existing.properties, ...props } }
          : { id: contactId, properties: props };
        await cacheRecord('customers', contactId, merged);
      })();
    },
    [],
  );

  return {
    loading,
    error,
    fromCache,
    contacts,
    stageCache,
    workflow,
    platformUsers,
    currentUserId: user?.id,
    roomAssignmentsStale,
    draftVisitIds,
    refresh,
    updateRoomAssignment,
    updateContactProperties,
  };
}
