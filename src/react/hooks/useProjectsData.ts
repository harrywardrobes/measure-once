import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

export interface ProjectContact {
  id: string;
  properties?: {
    firstname?: string;
    lastname?: string;
    email?: string;
    closedate?: string;
  };
}

export interface ProjectRoom {
  room?: string;
  stageKey?: string;
  roomStatus?: string;
  assignedFitterId?: string | null;
  installStart?: string | null;
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

  // Pending stale value while the tab is hidden — applied on visibilitychange.
  const pendingRoomStaleRef = useRef<boolean | null>(null);

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
          fetch('/api/open-leads', { headers: { Accept: 'application/json' } }),
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

        const rawContacts: ProjectContact[] = leadsData.contacts || [];
        const rawCache: Record<string, ProjectRoom[]> = leadsData.contactStageCache || {};

        const mergedCache: Record<string, ProjectRoom[]> = { ...rawCache };
        if (localdataData && typeof localdataData === 'object') {
          for (const [cid, rooms] of Object.entries(localdataData)) {
            if (Array.isArray(rooms)) {
              mergedCache[cid] = rooms as ProjectRoom[];
            }
          }
        }

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
    refresh,
    updateRoomAssignment,
  };
}
