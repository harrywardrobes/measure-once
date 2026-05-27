import React, { useEffect, useState, useCallback, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useConnectionCheck, useConnectionToast } from '../context/ConnectionToastContext';
import { CustomerDetailHeader } from './customer-detail/CustomerDetailHeader';
import { LeadStatusRail } from './customer-detail/LeadStatusRail';
import { RoomsTabs } from './customer-detail/RoomsTabs';
import { TasksSection } from './customer-detail/TasksSection';
import { InvoicesSection } from './customer-detail/InvoicesSection';
import { UpcomingVisitsSection, PastVisitsSection } from './customer-detail/VisitsSections';
import { DesignVisitsList } from './customer-detail/DesignVisitsList';
import { GoogleEmailSection } from './customer-detail/GoogleEmailSection';
import { WhatsAppHistory, WhatsAppModal } from './customer-detail/WhatsAppSection';
import {
  Contact, Room, HubSpotTask, LeadStatus, LeadSubstatus,
  DesignVisit, Visit, GoogleEmail, WhatsAppMessage, QBInvoice,
  contactName,
} from './customer-detail/types';

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
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

// ── QBState ────────────────────────────────────────────────────────────────────

interface QBState {
  connected: boolean; statusKnown: boolean; loading: boolean;
  loaded: boolean; loadError: boolean; error: string | null;
  company: string | null; invoices: QBInvoice[];
}
const initialQB: QBState = {
  connected: false, statusKnown: false, loading: false,
  loaded: false, loadError: false, error: null, company: null, invoices: [],
};

// ── Page ───────────────────────────────────────────────────────────────────────

export function CustomerDetailPage() {
  useConnectionCheck();
  const { notifyApiError } = useConnectionToast();
  const contactId = getContactId();

  const [contact,      setContact]      = useState<Contact | null>(null);
  const [rooms,        setRooms]        = useState<Room[]>([]);
  const [notes,        setNotes]        = useState('');
  const [tasks,        setTasks]        = useState<HubSpotTask[]>([]);
  const [leadStatuses, setLeadStatuses] = useState<LeadStatus[]>([]);
  const [nullLsLabel,  setNullLsLabel]  = useState('No status');
  const [leadSubs,     setLeadSubs]     = useState<LeadSubstatus[]>([]);
  const [lsLoaded,     setLsLoaded]     = useState(false);
  const [focusedLs,    setFocusedLs]    = useState<string | null>(null);
  const [selectedRoom, setSelectedRoom] = useState(0);
  const [workflow,     setWorkflow]     = useState<{ stages?: Record<string, { label: string }> } | null>(null);
  const [qb,           setQB]           = useState<QBState>(initialQB);

  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState<string | null>(null);

  const [designVisits, setDesignVisits] = useState<DesignVisit[]>([]);
  const [dvLoading,    setDvLoading]    = useState(false);
  const [dvError,      setDvError]      = useState<string | null>(null);

  const [upcomingVisits,  setUpcomingVisits]  = useState<Visit[]>([]);
  const [pastVisits,      setPastVisits]      = useState<Visit[]>([]);
  const [visitsLoading,   setVisitsLoading]   = useState(false);

  const [emails,          setEmails]          = useState<GoogleEmail[]>([]);
  const [emailsLoading,   setEmailsLoading]   = useState(false);
  const [emailsError,     setEmailsError]     = useState<string | null>(null);
  const [googleConnected, setGoogleConnected] = useState(false);

  const [waMessages,  setWaMessages]  = useState<WhatsAppMessage[]>([]);
  const [waLoading,   setWaLoading]   = useState(false);
  const [waError,     setWaError]     = useState<string | null>(null);
  const [waEnabled,   setWaEnabled]   = useState(false);
  const [waModalOpen, setWaModalOpen] = useState(false);

  // ── Data fetchers ─────────────────────────────────────────────────────────

  const fetchLeadStatuses = useCallback(async () => {
    try {
      const rows = await apiFetch<Array<{
        key: string; label: string; is_null_row?: boolean;
        excluded_from_sales?: boolean; stage?: string; sort_order?: number;
      }>>('/api/lead-statuses');
      if (!Array.isArray(rows)) return;
      const nullRow = rows.find(r => r.is_null_row);
      const nullLabel = nullRow?.label || 'No status';
      const opts: LeadStatus[] = rows
        .filter(r => !r.is_null_row)
        .map(r => ({
          value: r.key, label: r.label,
          excluded_from_sales: !!r.excluded_from_sales,
          stage: r.stage || null,
        }));
      flushSync(() => {
        setLeadStatuses(opts);
        setNullLsLabel(nullLabel);
        setLsLoaded(true);
      });
      // Keep globals in sync
      const g = window as unknown as Record<string, unknown>;
      g.LEAD_STATUS_OPTIONS    = opts;
      g.LEAD_STATUSES_LOADED   = true;
      g.NULL_LEAD_STATUS_LABEL = nullLabel;
    } catch { setLsLoaded(true); }
  }, []);

  const fetchLeadSubstatuses = useCallback(async () => {
    try {
      const rows = await apiFetch<LeadSubstatus[]>('/api/lead-substatuses');
      if (!Array.isArray(rows)) return;
      flushSync(() => setLeadSubs(rows));
      (window as unknown as Record<string, unknown>).LEAD_SUBSTATUSES = rows;
    } catch { /* noop */ }
  }, []);

  const fetchContact = useCallback(async (): Promise<Contact | null> => {
    const c = await apiFetch<Contact>(`/api/contacts/${contactId}`);
    if (!c?.id) return null;
    // Sync globals
    const g = window as unknown as Record<string, unknown>;
    const st = ((g.state as Record<string, unknown>) || {});
    st.selectedContact   = c;
    st.selectedContactId = contactId;
    g.state = st;
    // Update title
    document.title = `${contactName(c)} · Measure Once`;
    // Recent customers
    try {
      const KEY  = 'cp_recent_customers';
      const name = contactName(c);
      const entry = { id: contactId, name, company: c.properties.company || '', ts: Date.now() };
      const list  = JSON.parse(localStorage.getItem(KEY) || '[]') as typeof entry[];
      const filtered = list.filter(r => r.id !== contactId);
      filtered.unshift(entry);
      localStorage.setItem(KEY, JSON.stringify(filtered.slice(0, 5)));
    } catch { /* noop */ }
    return c;
  }, [contactId]);

  const fetchDesignVisits = useCallback(async () => {
    setDvLoading(true);
    setDvError(null);
    try {
      const v = await apiFetch<DesignVisit[]>(`/api/design-visits?contactId=${encodeURIComponent(contactId)}`);
      setDesignVisits(Array.isArray(v) ? v : []);
    } catch {
      setDvError('load-error');
    } finally {
      setDvLoading(false);
    }
  }, [contactId]);

  const fetchVisits = useCallback(async () => {
    setVisitsLoading(true);
    try {
      const from = new Date(Date.now() - 366 * 86400000).toISOString();
      const to   = new Date(Date.now() + 366 * 86400000).toISOString();
      const all  = await apiFetch<Visit[]>(`/api/visits?from=${from}&to=${to}`);
      const now  = Date.now();
      const filtered = Array.isArray(all)
        ? all.filter(v => !v.customerId || v.customerId === contactId)
        : [];
      setUpcomingVisits(filtered.filter(v => new Date(v.endAt).getTime() >= now));
      setPastVisits(filtered.filter(v => new Date(v.endAt).getTime() < now).reverse());
    } catch { /* noop */ } finally { setVisitsLoading(false); }
  }, [contactId]);

  const fetchGoogleEmails = useCallback(async (email: string) => {
    if (!email) return;
    setEmailsLoading(true);
    try {
      const d = await apiFetch<{ connected?: boolean; emails?: GoogleEmail[] }>(
        `/api/emails?email=${encodeURIComponent(email)}`,
      );
      if (d.connected === false) { setGoogleConnected(false); return; }
      setGoogleConnected(true);
      setEmails(d.emails || []);
    } catch { setEmailsError('load-error'); }
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

  const fetchQBStatus = useCallback(async () => {
    try {
      const st = await apiFetch<{ connected?: boolean; company?: string }>('/api/quickbooks/status');
      setQB(prev => ({ ...prev, connected: !!st.connected, company: st.company || null, statusKnown: true }));
      if (st.connected) {
        setQB(prev => ({ ...prev, loading: true }));
        const inv = await apiFetch<{ invoices?: QBInvoice[] }>('/api/quickbooks/invoices');
        setQB(prev => ({ ...prev, loading: false, loaded: true, invoices: inv.invoices || [] }));
      }
    } catch { setQB(prev => ({ ...prev, statusKnown: true, connected: false })); }
  }, []);

  // ── Main bootstrap ─────────────────────────────────────────────────────────

  const bootstrap = useCallback(async () => {
    if (!contactId || !/^\d+$/.test(contactId)) {
      setError('Invalid customer ID.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [, c] = await Promise.all([
        Promise.all([fetchLeadStatuses(), fetchLeadSubstatuses()]),
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
        initRooms = [{ room: 'Main', stageKey: 'sales', completedStatuses: {}, comments: [], stageDates: { sales: todayISO() } }];
      }
      setRooms(initRooms);
      setNotes(initNotes);

      try {
        const saved = localStorage.getItem(`customerRoomIdx_${contactId}`);
        if (saved !== null) {
          const n = parseInt(saved, 10);
          if (!isNaN(n) && n >= 0 && n < initRooms.length) setSelectedRoom(n);
        }
      } catch { /* noop */ }

      apiFetch<{ stages?: Record<string, { label: string }> }>('/api/workflow').then(setWorkflow).catch(() => {});
      fetchDesignVisits();
      fetchVisits();
      if (c.properties.email) fetchGoogleEmails(c.properties.email);
      fetchWhatsApp();
      fetchQBStatus();
    } catch (e: unknown) {
      notifyApiError('hubspot', e);
      const msg = e instanceof Error ? e.message : 'unknown error';
      setError(`Failed to load customer: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, [contactId, fetchContact, fetchDesignVisits, fetchGoogleEmails, fetchLeadStatuses,
      fetchLeadSubstatuses, fetchQBStatus, fetchVisits, fetchWhatsApp, notifyApiError]);

  // ── Global bridges (for test compat + workflow-core.js interop) ────────────

  useEffect(() => {
    const g = window as unknown as Record<string, unknown>;

    // These are called by the test harness after setting state.selectedContact.
    // `state` is declared `const` in workflow-core.js so it is NOT a window
    // property; use Function() to reach the script-level lexical global.
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
      const fl  = gs?.focusedLeadStatus as string | undefined;
      const u   = (g.__moHeaderUser as { privilege_level?: string } | undefined) // privilege-read-ok: type annotation only — value forwarded to mo:user dispatch, never used for auth
                  || (gs?.user as { privilege_level?: string } | undefined); // privilege-read-ok: type annotation only — value forwarded to mo:user dispatch, never used for auth
      if (u) window.dispatchEvent(new CustomEvent('mo:user', { detail: u }));
      flushSync(() => {
        if (c) { setContact(c); setLoading(false); setError(null); }
        if (fl !== undefined) setFocusedLs(fl || null);
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

    // Capture the originals from workflow-core.js before overwriting them.
    // Those functions populate module-level LEAD_STATUS_OPTIONS and
    // LEAD_SUBSTATUSES that the unified picker popup reads. We must call them
    // in addition to the React fetch so the picker has data too.
    const origLoadStatuses    = typeof g.loadLeadStatuses    === 'function' ? g.loadLeadStatuses    as () => Promise<void> : null;
    const origLoadSubstatuses = typeof g.loadLeadSubstatuses === 'function' ? g.loadLeadSubstatuses as () => Promise<void> : null;

    g.loadLeadStatuses    = () => Promise.all([fetchLeadStatuses(),    origLoadStatuses    ? origLoadStatuses()    : Promise.resolve()]);
    g.loadLeadSubstatuses = () => Promise.all([fetchLeadSubstatuses(), origLoadSubstatuses ? origLoadSubstatuses() : Promise.resolve()]);
    g.__setFocusedLeadStatus = (k: string) => flushSync(() => setFocusedLs(k));

    // Register with workflow-core.js dispatcher if available
    if (typeof (g.registerWorkflowHeaderRenderer) === 'function') {
      (g.registerWorkflowHeaderRenderer as (fn: () => void) => void)(() => {
        void fetchContact().then(c => { if (c) setContact(c); }).catch(() => {});
      });
    }
    if (typeof (g.registerWorkflowStagesRenderer) === 'function') {
      (g.registerWorkflowStagesRenderer as (fn: () => void) => void)(() => {
        void fetchLeadStatuses();
        void fetchLeadSubstatuses();
      });
    }

    return () => {
      delete g.renderWorkflowHeader;
      delete g.renderWorkflowStages;
      delete g.renderDesignVisits;
      delete g.loadLeadStatuses;
      delete g.loadLeadSubstatuses;
      delete g.__setFocusedLeadStatus;
    };
  }, [contactId, fetchContact, fetchDesignVisits, fetchLeadStatuses, fetchLeadSubstatuses]);

  // ── BroadcastChannel + visibilitychange subscriptions ─────────────────────

  useEffect(() => {
    let lsCh: BroadcastChannel | null  = null;
    let subCh: BroadcastChannel | null = null;

    if (typeof BroadcastChannel !== 'undefined') {
      lsCh = new BroadcastChannel('lead_statuses_changed');
      lsCh.addEventListener('message', () => {
        void fetchLeadStatuses();
      });
      subCh = new BroadcastChannel('lead_substatuses_changed');
      subCh.addEventListener('message', () => {
        void fetchLeadSubstatuses();
      });
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void fetchLeadStatuses();
        void fetchLeadSubstatuses();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      lsCh?.close();
      subCh?.close();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [fetchLeadStatuses, fetchLeadSubstatuses]);

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

  // ── Boot ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    void bootstrap();
  }, [contactId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Save rooms/notes ───────────────────────────────────────────────────────

  const saveRoomsAndNotes = useCallback(async (nextRooms: Room[], nextNotes: string): Promise<void> => {
    try {
      await fetch(`/api/contacts/${contactId}/localdata`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rooms: nextRooms, notes: nextNotes }),
      });
    } catch (e: unknown) {
      notifyApiError('database', e);
      throw e;
    }
  }, [contactId, notifyApiError]);

  // ── Substatus change ───────────────────────────────────────────────────────

  const handleSubstatusChange = useCallback(async (statusValue: string, substatusKey: string, checked: boolean) => {
    if (!contact) return;
    const newValue  = checked ? `${String(statusValue).toUpperCase()}__${substatusKey}` : '';
    const newProps  = { ...contact.properties, hw_lead_substatus: newValue };
    const updated   = { ...contact, properties: newProps };
    setContact(updated);
    const g  = window as unknown as Record<string, unknown>;
    const st = g.state as Record<string, unknown> | undefined;
    if (st) st.selectedContact = updated;
    try {
      await fetch(`/api/contacts/${contactId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hw_lead_substatus: newValue,
          ...(checked ? { hs_lead_status: statusValue } : {}),
        }),
      });
    } catch (e) { notifyApiError('hubspot', e); setContact(contact); }
  }, [contact, contactId, notifyApiError]);

  // ── Room select ────────────────────────────────────────────────────────────

  const handleRoomSelect = useCallback((idx: number) => {
    setSelectedRoom(idx);
    try { localStorage.setItem(`customerRoomIdx_${contactId}`, String(idx)); } catch { /* noop */ }
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
            style={{ marginTop: '0.5rem', padding: '0.35rem 0.9rem', border: '1px solid #6b7280', borderRadius: '0.375rem', background: '#f9fafb', cursor: 'pointer', fontSize: '0.875rem', color: '#374151' }}
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && contact && (
        <CustomerDetailHeader
          contact={contact}
          leadStatuses={leadStatuses}
          leadSubstatuses={leadSubs}
          nullLeadStatusLabel={nullLsLabel}
          onOpenWhatsApp={() => setWaModalOpen(true)}
          whatsappEnabled={waEnabled}
        />
      )}

      {/* ── Body ────────────────────────────────────────────────────────────── */}
      <div className="workflow-inner">

        {/* Design visits: always rendered (test harness compat) */}
        <DesignVisitsList
          contactId={contactId}
          visits={designVisits}
          loading={dvLoading}
          error={dvError}
          onRefresh={fetchDesignVisits}
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
            />

            {qb.statusKnown && qb.connected && (
              <InvoicesSection contact={contact} qb={qb} />
            )}

            <UpcomingVisitsSection
              contactId={contactId}
              contact={contact}
              upcomingVisits={upcomingVisits}
              loadingVisits={visitsLoading}
            />

            <PastVisitsSection
              pastVisits={pastVisits}
              loadingVisits={visitsLoading}
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
              phone={contact.properties.phone || contact.properties.mobilephone || ''}
              messages={waMessages}
              loading={waLoading}
              error={waError}
              enabled={waEnabled}
            />
          </>
        )}

        {/* Lead status rail: always rendered, shows skeleton when not loaded */}
        <LeadStatusRail
          contact={contact}
          leadStatuses={leadStatuses}
          leadSubstatuses={leadSubs}
          loaded={lsLoaded}
          focusedLeadStatus={focusedLs}
          onFocusChange={setFocusedLs}
          onSubstatusChange={handleSubstatusChange}
        />
      </div>

      {/* WhatsApp modal */}
      {waModalOpen && contact && (
        <WhatsAppModal
          contactId={contactId}
          phone={contact.properties.phone || contact.properties.mobilephone || ''}
          open={waModalOpen}
          onClose={() => setWaModalOpen(false)}
        />
      )}
    </div>
  );
}

export default CustomerDetailPage;
