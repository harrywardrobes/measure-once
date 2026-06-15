import React, { useEffect, useState, useCallback, useRef } from 'react';
import { CP_RECENT_CUSTOMERS_KEY, CUSTOMER_ROOM_IDX_PREFIX } from '../constants/localStorageKeys';
import { flushSync } from 'react-dom';
import { useConnectionCheck, useConnectionToast } from '../context/ConnectionToastContext';
import { useWorkflowData } from '../context/WorkflowDataContext';
import { CustomerDetailHeader } from './customer-detail/CustomerDetailHeader';
import { RoomsTabs } from './customer-detail/RoomsTabs';
import { TasksSection } from './customer-detail/TasksSection';
import { InvoicesSection } from './customer-detail/InvoicesSection';
import { PaymentHistory } from '../components/PaymentHistory';
import { UpcomingVisitsSection, PastVisitsSection } from './customer-detail/VisitsSections';
import { DesignVisitsList } from './customer-detail/DesignVisitsList';
import { SurveyVisitsList, type SurveyVisitServer } from './customer-detail/SurveyVisitsList';
import { CustomerInfoSubmissionsRail } from './customer-detail/CustomerInfoSubmissionsRail';
import { GoogleEmailSection } from './customer-detail/GoogleEmailSection';
import { WhatsAppHistory, WhatsAppModal } from './customer-detail/WhatsAppSection';
import { ContactEditModal } from './customer-detail/ContactEditModal';
import {
  Contact, Room, HubSpotTask,
  DesignVisit, GoogleEmail, WhatsAppMessage,
  contactName,
} from './customer-detail/types';
import { updateRecentCustomer, compactRelativeTime, latestTimestamp } from '../utils/formatters';
import { useQBInvoices } from '../hooks/useQBInvoices';
import { usePageTitle } from '../hooks/usePageTitle';
import { useNowTick } from '../hooks/useNowTick';
import { cacheRecord, cacheRecords, readRecord, readRecords } from '../lib/offlineDb';
import Alert from '@mui/material/Alert';
import { useToast } from '../contexts/ToastContext';
import { sendOrQueue, CONFLICT_RESOLVED_EVENT, type ConflictResolvedDetail } from '../lib/offlineQueue';
import { LEAD_STATUS_REMOVED_MESSAGE, GET, isGoogleAuthError } from '../utils/api';
import { subscribeLeadStatusChange } from '../utils/broadcastLeadStatus';
import { subscribeContactAttemptLogged } from '../utils/broadcastContactAttempt';

// ── Helpers ────────────────────────────────────────────────────────────────────

function getContactId(): string {
  const parts = location.pathname.split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

function todayISO(): string {
  return new Date().toISOString().split('T')[0];
}

function normaliseRooms(raw: unknown[]): Room[] {
  return raw.map((r: unknown) => {
    const room = r as Partial<Room>;
    const cs: Record<string, string[]> = room.completedStatuses ? { ...room.completedStatuses } : {};
    const sd: Record<string, string>  = room.stageDates         ? { ...room.stageDates }         : {};
    if (!sd.sales) sd.sales = todayISO();
    return {
      room:              room.room              || 'Main',
      stageKey:          room.stageKey          || 'sales',
      completedStatuses: cs,
      comments:          room.comments          || [],
      stageDates:        sd,
      substateDates:     room.substateDates ? { ...room.substateDates } : {},
      installStart:      room.installStart  ?? null,
      installFinish:     room.installFinish ?? null,
      assignedFitterId:  room.assignedFitterId ?? null,
    };
  });
}

async function apiFetch<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

// ── Page ───────────────────────────────────────────────────────────────────────

export function CustomerDetailPage() {
  useConnectionCheck();
  const { notifyApiError } = useConnectionToast();
  const {
    leadStatuses,
    nullLsLabel,
    lsLoaded,
    refreshLeadStatuses,
    workflow,
  } = useWorkflowData();
  const contactId = getContactId();
  const now = useNowTick();

  const [contact,      setContact]      = useState<Contact | null>(null);
  const [cachedName] = useState<string | null>(() => {
    try {
      const list = JSON.parse(localStorage.getItem(CP_RECENT_CUSTOMERS_KEY) || '[]') as Array<{ id: string; name: string }>;
      return list.find(r => r.id === contactId)?.name ?? null;
    } catch { return null; }
  });
  usePageTitle(
    contact    ? `${contactName(contact)} · Measure Once`
    : cachedName ? `${cachedName} · Measure Once`
    : 'Customer · Measure Once'
  );
  const [rooms,        setRooms]        = useState<Room[]>([]);
  const [notes,        setNotes]        = useState('');
  const [tasks,        setTasks]        = useState<HubSpotTask[]>([]);

  const [selectedRoom, setSelectedRoom] = useState(0);
  const qb = useQBInvoices();
  useEffect(() => { qb.triggerLoad(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState<string | null>(null);
  // True when the contact section is rendered from the offline IndexedDB cache.
  const [contactFromCache, setContactFromCache] = useState(false);

  const [designVisits, setDesignVisits] = useState<DesignVisit[]>([]);
  const [dvLoading,    setDvLoading]    = useState(false);
  const [dvError,      setDvError]      = useState<string | null>(null);
  // True when design visits are rendered from the offline IndexedDB cache.
  const [dvFromCache,  setDvFromCache]  = useState(false);

  const [surveyVisits, setSurveyVisits] = useState<SurveyVisitServer[]>([]);
  const [svLoading,    setSvLoading]    = useState(false);
  const [svError,      setSvError]      = useState<string | null>(null);
  const [svFromCache,  setSvFromCache]  = useState(false);

  const [emails,          setEmails]          = useState<GoogleEmail[]>([]);
  const [emailsLoading,   setEmailsLoading]   = useState(false);
  const [emailsError,     setEmailsError]     = useState<string | null>(null);
  const [googleConnected, setGoogleConnected] = useState(false);

  const [waMessages,  setWaMessages]  = useState<WhatsAppMessage[]>([]);
  const [waLoading,   setWaLoading]   = useState(false);
  const [waError,     setWaError]     = useState<string | null>(null);
  const [waEnabled,   setWaEnabled]   = useState(false);
  const [waModalOpen, setWaModalOpen] = useState(false);

  const [contactEditOpen, setContactEditOpen] = useState(false);
  const showToast = useToast();

  type LastAttemptEntry = { at: string; by: string | null; count: number; method: string | null; methodCounts?: Record<string, number> | null } | null;
  const [lastAttempt, setLastAttempt] = useState<LastAttemptEntry>(null);

  // ── Data fetchers ─────────────────────────────────────────────────────────

  const fetchContact = useCallback(async (): Promise<Contact | null> => {
    let c: Contact | null = null;
    let fromNetwork = false;
    try {
      c = await apiFetch<Contact>(`/api/contacts/${contactId}`);
      fromNetwork = true;
    } catch (e) {
      // Offline fallback: render the saved customer from IndexedDB instead of
      // an error state. Re-throw only when there's nothing cached to show.
      const cached = await readRecord<Contact>('customers', contactId);
      if (!cached) throw e;
      c = cached;
      setContactFromCache(true);
    }
    if (!c?.id) return null;
    // The contacts endpoint returns the structured address alongside the raw
    // HubSpot props; fold it into properties so all consumers read it from the
    // canonical ContactProperties.structuredAddress field.
    const topLevelAddr = (c as unknown as { structuredAddress?: Contact['properties']['structuredAddress'] }).structuredAddress;
    if (topLevelAddr && !c.properties.structuredAddress) {
      c.properties.structuredAddress = topLevelAddr;
    }
    // Write-through to the offline store (best-effort, never blocks the UI).
    // Only re-stamp when fetched from the network — caching cached data is a no-op
    // beyond refreshing the timestamp, which we don't want for stale offline reads.
    if (fromNetwork) void cacheRecord('customers', contactId, c);
    // Sync globals
    const g = window as unknown as Record<string, unknown>;
    const st = ((g.state as Record<string, unknown>) || {});
    st.selectedContact   = c;
    st.selectedContactId = contactId;
    g.state = st;
    // Recent customers
    updateRecentCustomer(c);
    return c;
  }, [contactId]);

  const fetchSurveyVisits = useCallback(async () => {
    setSvLoading(true);
    setSvError(null);
    setSvFromCache(false);
    try {
      const v = await apiFetch<SurveyVisitServer[]>(`/api/survey-visits?contactId=${encodeURIComponent(contactId)}`);
      setSurveyVisits(Array.isArray(v) ? v : []);
      // Write-through to offline cache. The `visits` store is shared with
      // design visits; the `_sv` sentinel lets offline reads distinguish them.
      if (Array.isArray(v)) void cacheRecords('visits', v.map(sv => ({ ...sv, _sv: true })), (sv) => `sv:${sv.id}`);
    } catch {
      // Offline fallback: read saved survey visits for this contact from the
      // cache (identified by the `_sv` sentinel written on the success path).
      const cached = await readRecords<SurveyVisitServer & { _sv?: boolean }>('visits');
      const mine = cached.filter(
        (d) => d && typeof d === 'object' && '_sv' in d && d._sv === true && String(d.contact_id) === contactId,
      );
      if (mine.length > 0) {
        setSurveyVisits(mine);
        setSvFromCache(true);
      } else {
        setSvError('load-error');
      }
    } finally {
      setSvLoading(false);
    }
  }, [contactId]);

  const fetchDesignVisits = useCallback(async () => {
    setDvLoading(true);
    setDvError(null);
    setDvFromCache(false);
    try {
      const v = await apiFetch<DesignVisit[]>(`/api/design-visits?contactId=${encodeURIComponent(contactId)}`);
      setDesignVisits(Array.isArray(v) ? v : []);
      if (Array.isArray(v)) void cacheRecords('visits', v, (dv) => `dv:${dv.id}`);
    } catch {
      // Offline fallback: read saved design visits for this contact from the
      // cache (the `visits` store mixes design + survey visits; design visits
      // carry a `contact_id` but no `_sv` sentinel, which survey visits use).
      const cached = await readRecords<DesignVisit>('visits');
      const mine = cached.filter(
        (d) => d && typeof d === 'object' && !('_sv' in d && (d as Record<string, unknown>)._sv) && 'contact_id' in d && String(d.contact_id) === contactId,
      );
      if (mine.length > 0) {
        setDesignVisits(mine);
        setDvFromCache(true);
      } else {
        setDvError('load-error');
      }
    } finally {
      setDvLoading(false);
    }
  }, [contactId]);

  const fetchGoogleEmails = useCallback(async (email: string) => {
    if (!email) return;
    setEmailsLoading(true);
    try {
      const d = await GET<{ connected?: boolean; emails?: GoogleEmail[] }>(
        `/api/emails?email=${encodeURIComponent(email)}`,
      );
      if (d.connected === false) { setGoogleConnected(false); return; }
      setGoogleConnected(true);
      setEmails(d.emails || []);
    } catch (e) {
      if (isGoogleAuthError(e)) { setGoogleConnected(false); }
      else { setEmailsError('load-error'); }
    }
    finally { setEmailsLoading(false); }
  }, []);

  const fetchWhatsApp = useCallback(async () => {
    setWaLoading(true);
    try {
      const d = await apiFetch<{ enabled?: boolean; messages?: WhatsAppMessage[] }>(
        `/api/whatsapp/history/${contactId}`,
      );
      setWaEnabled(!!d.enabled);
      setWaMessages(d.messages || []);
    } catch { setWaError('load-error'); }
    finally { setWaLoading(false); }
  }, [contactId]);

  const fetchLastAttempt = useCallback(async () => {
    try {
      const res = await fetch('/api/contacts/urgency', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [contactId] }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        lastAttempt?: Record<string, LastAttemptEntry>;
      };
      const entry = data.lastAttempt?.[contactId];
      setLastAttempt(entry !== undefined ? entry : null);
    } catch { /* best-effort — missing lastAttempt is non-fatal */ }
  }, [contactId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Main bootstrap ─────────────────────────────────────────────────────────

  const bootstrap = useCallback(async () => {
    if (!contactId || !/^\d+$/.test(contactId)) {
      setError('Invalid customer ID.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setContactFromCache(false);
    setDvFromCache(false);
    setSvFromCache(false);
    try {
      const [, c] = await Promise.all([
        refreshLeadStatuses(),
        fetchContact().catch(e => { throw e; }),
      ]);
      if (!c) { setError('Customer not found.'); setLoading(false); return; }
      setContact(c);

      const [localData, tasksData] = await Promise.all([
        apiFetch<unknown>(`/api/contacts/${contactId}/localdata`).catch(() => null),
        apiFetch<{ results?: HubSpotTask[] }>(`/api/contacts/${contactId}/tasks`).catch(() => ({ results: [] })),
      ]);
      setTasks(tasksData.results || []);

      let initRooms: Room[];
      let initNotes = '';
      const ld = localData;
      if (Array.isArray(ld) && (ld as Room[]).length > 0) {
        initRooms = normaliseRooms(ld as unknown[]);
      } else if (
        ld && typeof ld === 'object' &&
        Array.isArray((ld as { rooms?: unknown[] }).rooms) &&
        ((ld as { rooms: unknown[] }).rooms).length > 0
      ) {
        const ldo = ld as { rooms: unknown[]; notes?: string };
        initRooms = normaliseRooms(ldo.rooms);
        initNotes = ldo.notes || '';
      } else {
        initRooms = [];
      }
      setRooms(initRooms);
      setNotes(initNotes);

      try {
        const saved = localStorage.getItem(CUSTOMER_ROOM_IDX_PREFIX + contactId);
        if (saved !== null) {
          const n = parseInt(saved, 10);
          if (!isNaN(n) && n >= 0 && n < initRooms.length) setSelectedRoom(n);
        }
      } catch { /* noop */ }

      fetchDesignVisits();
      fetchSurveyVisits();
      if (c.properties.email) fetchGoogleEmails(c.properties.email);
      fetchWhatsApp();
      fetchLastAttempt();
    } catch (e: unknown) {
      notifyApiError('hubspot', e);
      const msg = e instanceof Error ? e.message : 'unknown error';
      setError(`Failed to load customer: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, [contactId, fetchContact, fetchDesignVisits, fetchSurveyVisits, fetchGoogleEmails,
      fetchLastAttempt, refreshLeadStatuses, fetchWhatsApp, notifyApiError]);

  // ── Global bridges (for test compat) ──────────────────────────────────────

  useEffect(() => {
    const g = window as unknown as Record<string, unknown>;

    // These are called by the test harness after setting state.selectedContact.
    // `state` is a script-level `const` (not a window property); use Function()
    // to reach it as a lexical global.
    function getScriptState(): Record<string, unknown> | undefined {
      try {
        return Function('return typeof state !== "undefined" ? state : undefined')() as Record<string, unknown>;
      } catch { return undefined; }
    }

    g.renderWorkflowHeader = () => {
      const gs = getScriptState();
      const c  = gs?.selectedContact as Contact | undefined;
      const u  = (g.__moHeaderUser as { privilege_level?: string } | undefined) // privilege-read-ok: type annotation only — value forwarded to mo:user dispatch, never used for auth
                 || (gs?.user as { privilege_level?: string } | undefined); // privilege-read-ok: type annotation only — value forwarded to mo:user dispatch, never used for auth
      // Dispatch mo:user FIRST so usePrivilege's setPrivilegeLevel is queued
      // before the flushSync below — React 18 will batch all of them together.
      if (u) window.dispatchEvent(new CustomEvent('mo:user', { detail: u }));
      flushSync(() => {
        if (c) { setContact(c); setLoading(false); setError(null); }
      });
    };

    g.renderWorkflowStages = () => {
      const gs  = getScriptState();
      const c   = gs?.selectedContact as Contact | undefined;
      const u   = (g.__moHeaderUser as { privilege_level?: string } | undefined) // privilege-read-ok: type annotation only — value forwarded to mo:user dispatch, never used for auth
                  || (gs?.user as { privilege_level?: string } | undefined); // privilege-read-ok: type annotation only — value forwarded to mo:user dispatch, never used for auth
      if (u) window.dispatchEvent(new CustomEvent('mo:user', { detail: u }));
      flushSync(() => {
        if (c) { setContact(c); setLoading(false); setError(null); }
      });
    };

    // renderDesignVisits: flushSync shows "Loading…" immediately so the test poll
    // always starts from a loading state rather than the initial empty-state.
    g.renderDesignVisits = () => {
      const cid = ((g.state as Record<string, unknown> | undefined)?.selectedContactId as string | undefined)
                  || contactId;
      flushSync(() => {
        setDvLoading(true);
        setDvError(null);
        setDesignVisits([]);
      });
      fetch(`/api/design-visits?contactId=${encodeURIComponent(cid)}`)
        .then(r => r.ok ? (r.json() as Promise<DesignVisit[]>) : Promise.reject(r))
        .then(v  => setDesignVisits(Array.isArray(v) ? v : []))
        .catch(() => setDvError('load-error'))
        .finally(() => setDvLoading(false));
    };

    // WorkflowDataContext now owns LEAD_STATUS_OPTIONS and LEAD_SUBSTATUSES
    // globally; these window shims are kept for the vanilla-JS picker popup
    // that still reads them directly.
    g.loadLeadStatuses    = () => refreshLeadStatuses();

    return () => {
      delete g.renderWorkflowHeader;
      delete g.renderWorkflowStages;
      delete g.renderDesignVisits;
      delete g.loadLeadStatuses;
    };
  }, [contactId, fetchContact, fetchDesignVisits, refreshLeadStatuses]);


  // ── Patch contact properties when renamed in another tab ───────────────────

  useEffect(() => {
    return subscribeLeadStatusChange((changedId, props) => {
      if (changedId !== contactId) return;
      setContact((prev) =>
        prev ? { ...prev, properties: { ...prev.properties, ...props } } : prev,
      );
    });
  }, [contactId]);

  // ── Refresh lastAttempt when a contact attempt is logged (any tab) ─────────

  useEffect(() => {
    return subscribeContactAttemptLogged(({ contactId: changedId }) => {
      if (changedId !== contactId) return;
      void fetchLastAttempt();
    });
  }, [contactId, fetchLastAttempt]);

  // ── Re-fetch emails when Google connects mid-session ───────────────────────

  const contactEmailRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    contactEmailRef.current = contact?.properties.email;
  }, [contact]);

  useEffect(() => {
    const handler = () => {
      const email = contactEmailRef.current;
      if (email) void fetchGoogleEmails(email);
    };
    window.addEventListener('mo:google-auth-connected', handler);
    return () => window.removeEventListener('mo:google-auth-connected', handler);
  }, [fetchGoogleEmails]);

  // ── Clear emails when Google disconnects mid-session ───────────────────────

  useEffect(() => {
    const handler = () => {
      setGoogleConnected(false);
      setEmails([]);
      setEmailsError(null);
      setEmailsLoading(false);
    };
    window.addEventListener('mo:google-auth-disconnected', handler);
    return () => window.removeEventListener('mo:google-auth-disconnected', handler);
  }, []);

  // ── Refresh after an offline conflict is resolved (Restore server copy) ─────
  // Resolving a conflict by restoring the server values replays a write but the
  // on-screen record still shows the queued edit. When that resolution targets
  // the contact in view, re-fetch the affected section so the screen reflects
  // the restored values without a manual reload. Online, resolveConflict evicts
  // the read cache so the re-fetch repopulates from the server; offline, it
  // writes the restored values into the read cache so the re-fetch's offline
  // fallback (readRecord/readRecords) shows the restored state immediately.

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ConflictResolvedDetail>).detail;
      if (!detail) return;
      const m = detail.route?.match(/\/customers\/(\d+)/);
      const routeContact = m ? m[1] : null;
      // Skip conflicts that clearly belong to a different customer.
      if (routeContact && routeContact !== contactId) return;
      if (detail.area === 'customer' || detail.area === 'photo') {
        void fetchContact().then((c) => { if (c) setContact(c); }).catch(() => { /* best-effort */ });
      } else if (detail.area === 'visit') {
        void fetchDesignVisits();
        window.dispatchEvent(new CustomEvent('mo:refresh-visits'));
      }
    };
    window.addEventListener(CONFLICT_RESOLVED_EVENT, handler);
    return () => window.removeEventListener(CONFLICT_RESOLVED_EVENT, handler);
  }, [contactId, fetchContact, fetchDesignVisits]);

  // ── Lead-status quick-set window bridge ─────────────────────────────────────
  // window.quickSetLeadStatus / window._quickSetLeadStatusWithSub are called by
  // LeadStatusPicker (src/react/components/pickers/LeadStatusPicker.tsx) via
  // window globals to update contact state and fire the PATCH. A ref is used so
  // the closures always read the latest contact without recreating on each render.

  const contactRef = useRef<Contact | null>(null);
  useEffect(() => { contactRef.current = contact; }, [contact]);

  useEffect(() => {
    const g = window as unknown as Record<string, unknown>;

    g.quickSetLeadStatus = async (cId: unknown, newStatus: unknown) => {
      const id = String(cId);
      if (id !== contactId) return;
      const c = contactRef.current;
      const prevStatus = c?.properties?.hs_lead_status || '';
      if (prevStatus === String(newStatus)) return;

      const updated: Contact = {
        ...(c as Contact),
        properties: {
          ...(c?.properties || {}),
          hs_lead_status: String(newStatus),
        },
      };
      setContact(updated);
      contactRef.current = updated;
      const st = (window as unknown as Record<string, unknown>).state as Record<string, unknown> | undefined;
      if (st) st.selectedContact = updated;

      void sendOrQueue({
        area: 'customer',
        label: `Lead status → ${String(newStatus)}`,
        method: 'PATCH',
        url: `/api/contacts/${encodeURIComponent(id)}`,
        body: { hs_lead_status: String(newStatus) },
        dedupeKey: `contact:${id}:lead-status`,
      }).then(res => {
        if (!res.queued && !res.ok) {
          const d = res.data as { code?: string } | undefined;
          if (d?.code === 'LEAD_STATUS_REMOVED') {
            setContact(c as Contact);
            contactRef.current = c as Contact;
            const st2 = (window as unknown as Record<string, unknown>).state as Record<string, unknown> | undefined;
            if (st2) st2.selectedContact = c;
            const w = window as unknown as Record<string, unknown>;
            if (typeof w['toast'] === 'function') (w['toast'] as (m: string, e: boolean) => void)(LEAD_STATUS_REMOVED_MESSAGE, true);
          }
        }
      }).catch(() => { /* noop — optimistic UI already applied */ });
    };

    return () => {
      delete g.quickSetLeadStatus;
    };
  }, [contactId, setContact]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Boot ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    void bootstrap();
  }, [contactId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Save rooms/notes ───────────────────────────────────────────────────────

  const saveRoomsAndNotes = useCallback(async (nextRooms: Room[], nextNotes: string): Promise<void> => {
    // Offline-aware: queued and replayed on reconnect when offline / on a
    // network error. A later edit of the same contact collapses onto this entry
    // (dedupeKey) so only the newest rooms/notes payload is replayed.
    const res = await sendOrQueue({
      area: 'customer',
      label: 'Rooms & notes',
      method: 'POST',
      url: `/api/contacts/${contactId}/localdata`,
      body: { rooms: nextRooms, notes: nextNotes },
      dedupeKey: `contact:${contactId}:localdata`,
    });
    // Surface only genuine server rejections (4xx) — queued writes are success
    // from the user's perspective.
    if (!res.queued && !res.ok) {
      const err = new Error((res.data as { error?: string })?.error || 'Failed to save');
      notifyApiError('database', err);
      throw err;
    }
  }, [contactId, notifyApiError]);

  // ── Room select ────────────────────────────────────────────────────────────

  const handleRoomSelect = useCallback((idx: number) => {
    setSelectedRoom(idx);
    try { localStorage.setItem(CUSTOMER_ROOM_IDX_PREFIX + contactId, String(idx)); } catch { /* noop */ }
  }, [contactId]);

  // ── Invalid ID guard ───────────────────────────────────────────────────────

  if (!contactId || !/^\d+$/.test(contactId)) {
    return (
      <div id="workflow-view" className="flex-1 overflow-y-auto">
        <div className="p-6 text-red-500 text-sm">Invalid customer ID.</div>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  // NOTE: #design-visits-section is rendered regardless of loading/error state
  // so test harnesses can seed state.selectedContactId and call renderDesignVisits()
  // even when the contact API is unavailable (HUBSPOT_TOKEN stripped in tests).

  return (
    <div id="workflow-view" className="flex-1 overflow-y-auto">
      <button className="back-btn" onClick={() => { location.href = '/customers'; }}>
        <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M15 19l-7-7 7-7" />
        </svg>
        Customers
      </button>

      {/* ── Header: skeleton / error / real ────────────────────────────────── */}
      {loading && (
        <div className="px-4 sm:px-6 py-4 shadow-sm" style={{ background: 'var(--paper)', borderBottom: '1px solid var(--stone)' }}>
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="skeleton-line skeleton-wf-name" />
              <div className="flex items-center gap-2 mt-3">
                <div className="skeleton-line skeleton-wf-badge" />
                <div className="skeleton-line skeleton-wf-email" />
                <div className="skeleton-line skeleton-wf-phone" />
              </div>
            </div>
            <div className="skeleton-line skeleton-wf-select" />
          </div>
        </div>
      )}

      {!loading && error && !contact && (
        <div className="px-4 sm:px-6 py-4 shadow-sm" style={{ background: 'var(--paper)', borderBottom: '1px solid var(--stone)' }}>
          <p className="text-sm text-red-500">{error}</p>
          <button
            onClick={() => void bootstrap()}
            style={{ marginTop: '0.5rem', padding: '0.35rem 0.9rem', border: '1px solid var(--neutral-500)', borderRadius: '0.375rem', background: 'var(--neutral-50)', cursor: 'pointer', fontSize: '0.875rem', color: 'var(--neutral-700)' }}
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && contact && (
        <CustomerDetailHeader
          contact={contact}
          leadStatuses={leadStatuses}
          nullLeadStatusLabel={nullLsLabel}
          onEditContact={() => setContactEditOpen(true)}
          onOpenWhatsApp={() => setWaModalOpen(true)}
          whatsappEnabled={waEnabled}
          activityCounter={
            compactRelativeTime(
              latestTimestamp(lastAttempt?.at, contact.properties.notes_last_contacted),
              now,
            ) ?? undefined
          }
          lastAttempt={lastAttempt}
          depositInvoiceId={designVisits.find(v => v.deposit_invoice_id)?.deposit_invoice_id ?? null}
          depositInvoiceDocNum={designVisits.find(v => v.deposit_invoice_id)?.deposit_invoice_doc_num ?? null}
          depositInvoiceLoading={Boolean(designVisits.find(v => v.deposit_invoice_id)) && !qb.loaded}
          depositPaymentState={(() => {
            const dvWithInv = designVisits.find(v => v.deposit_invoice_id);
            if (!dvWithInv || !qb.loaded) return null;
            const inv = qb.invoices.find(i => i.id === dvWithInv.deposit_invoice_id);
            if (!inv) return null;
            const balance = Number(inv.balance ?? 0);
            const total   = Number(inv.totalAmt ?? 0);
            if (balance <= 0) return 'paid';
            if (total > 0 && balance < total) return 'partial';
            return 'unpaid';
          })()}
          fromCache={contactFromCache}
        />
      )}

      {/* ── Body ────────────────────────────────────────────────────────────── */}
      <div className="workflow-inner">

        {(contactFromCache || dvFromCache || svFromCache) && (
          <Alert severity="info" sx={{ mb: 2 }} data-testid="customer-detail-offline-banner">
            You&apos;re offline — showing saved data from your last visit. Some details may be out of date.
          </Alert>
        )}

        {/* Customer info submissions (upload_photos_and_info handler) */}
        <CustomerInfoSubmissionsRail contactId={contactId} />

        {/* Design visits: always rendered (test harness compat) */}
        <DesignVisitsList
          contactId={contactId}
          visits={designVisits}
          loading={dvLoading}
          error={dvError}
          fromCache={dvFromCache}
          onRefresh={fetchDesignVisits}
        />

        {/* Survey visits: server-sourced list with queued-edit state overlaid */}
        <SurveyVisitsList
          contactId={contactId}
          serverVisits={surveyVisits}
          serverLoading={svLoading}
          serverError={svError}
          fromCache={svFromCache}
          onRefresh={fetchSurveyVisits}
        />

        {/* These sections only render once contact is loaded */}
        {contact && (
          <>
            <RoomsTabs
              contactId={contactId}
              rooms={rooms}
              notes={notes}
              workflow={workflow}
              selectedRoomIdx={selectedRoom}
              onRoomsChange={setRooms}
              onNotesChange={setNotes}
              onRoomSelect={handleRoomSelect}
              onSave={saveRoomsAndNotes}
              onNotesSaved={() => showToast('Notes saved')}
              onRoomSaved={() => showToast('Saved')}
              onInstallDateSaved={() => showToast('Install date updated')}
              onCommentSaved={() => showToast('Comment saved')}
              onRoomSaveError={() => showToast('Failed to save — please try again', true)}
              onCommentSaveError={() => showToast('Failed to save comment — please try again', true)}
              onNotesSaveError={() => showToast('Failed to save notes — please try again', true)}
            />

            {qb.statusKnown && qb.connected && (
              <InvoicesSection contact={contact} qb={qb} />
            )}

            {qb.statusKnown && (
              <PaymentHistory variant="list" contactId={contactId} />
            )}

            <UpcomingVisitsSection
              contactId={contactId}
              contact={contact}
            />

            <PastVisitsSection
              contactId={contactId}
            />

            <TasksSection
              contactId={contactId}
              tasks={tasks}
              workflow={workflow}
              onTasksChange={setTasks}
            />

            <GoogleEmailSection
              contactEmail={contact.properties.email || ''}
              emails={emails}
              loading={emailsLoading}
              error={emailsError}
              connected={googleConnected}
            />

            <WhatsAppHistory
              contactId={contactId}
              phone={contact.properties.phone || contact.properties.mobilephone || contact.properties.hs_whatsapp_phone_number || ''}
              messages={waMessages}
              loading={waLoading}
              error={waError}
              enabled={waEnabled}
            />
          </>
        )}

      </div>

      {/* Contact edit modal */}
      {contact && (
        <ContactEditModal
          contact={contact}
          open={contactEditOpen}
          onClose={() => setContactEditOpen(false)}
          onSaved={(updated) => {
            setContact(updated);
            const g  = window as unknown as Record<string, unknown>;
            const st = g.state as Record<string, unknown> | undefined;
            if (st) st.selectedContact = updated;
            showToast('Contact updated');
            // Silent background re-fetch so the header reflects HubSpot's
            // normalised values (e.g. phone formatting) without a page reload.
            // fetchContact also rewrites cp_recent_customers, so the global
            // search / recent-contacts dropdown shows the updated name as soon
            // as the re-fetch resolves — no extra API call needed.
            void fetchContact().then((c) => { if (c) setContact(c); }).catch(() => { /* best-effort */ });
          }}
        />
      )}

      {/* WhatsApp modal */}
      {waModalOpen && contact && (
        <WhatsAppModal
          contactId={contactId}
          phone={contact.properties.phone || contact.properties.mobilephone || contact.properties.hs_whatsapp_phone_number || ''}
          open={waModalOpen}
          onClose={() => setWaModalOpen(false)}
        />
      )}
    </div>
  );
}

export default CustomerDetailPage;
