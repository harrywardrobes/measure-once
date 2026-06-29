import React, { useCallback, useEffect, useRef, useState } from 'react';
import { DV_WIZARD_DRAFT_PREFIX, DV_WIZARD_DRAFT_EDIT_PREFIX } from '../constants/localStorageKeys';
import { nowDateTime } from '../utils/dateDefaults';
import { BRAND_COLORS } from '../theme';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { FullScreenModal } from './modals/FullScreenModal';
import { VisitWizardShell } from './VisitWizardShell';
import { useToastContext } from '../contexts/ToastContext';
import { useAuth } from '../contexts/AuthContext';
import { LEAD_STATUS_REMOVED_MESSAGE, POST } from '../utils/api';
import { openConnectModal } from '../contexts/ConnectionToastContext';
import { formatAddress } from '../../../shared/address';
import { broadcastLeadStatusChange } from '../utils/broadcastLeadStatus';
import {
  DEMO_TOOLTIP,
  DEMO_HANDLES,
  DEMO_FURNITURE_RANGES,
  DEMO_DOOR_STYLES,
  DEMO_TERMS_TEXT,
  DEMO_STEP1,
  DEMO_ROOMS,
  DEMO_VISIT_QUESTIONS,
  DEMO_VISIT_ANSWERS,
  DEMO_ROOM_QUESTIONS,
} from './modals/demoData';
import { DesignVisitStep1, type Step1Data, type CatalogueItem } from './DesignVisitStep1';
import { CatalogueDropdowns } from './CatalogueDropdowns';
import { QuestionnaireRenderer, missingRequired, type VisitQuestion, type AnswerMap } from './QuestionnaireRenderer';
import { emptyAddress, isAddressEmpty, type StructuredAddress } from '../../../shared/address';
import { DesignVisitRoomsStep, type RoomData, type DoorStyleOption } from './DesignVisitRoomsStep';
import { DesignVisitStep3 } from './DesignVisitStep3';

export interface DesignVisitWizardHandler {
  id?: number | string;
  type?: string;
  config?: {
    defaultDurationMin?: number;
    intermediateLeadStatus?: string;
    [key: string]: unknown;
  };
}

export interface DesignVisitWizardCtx {
  contactId?: string;
  contact_id?: string;
  contactName?: string;
  contact_name?: string;
  contactEmail?: string;
  contact_email?: string;
  contactPhone?: string;
  contactMobile?: string;
  /** Brand-new customer with no CRM contact yet (standalone offline page). The
   *  server matches/creates the HubSpot contact at submit time. Mutually
   *  exclusive with contactId. */
  newContact?: { name: string; email?: string; phone?: string; address?: StructuredAddress };
  /** Idempotency key minted once per visit; dedupes offline replays server-side. */
  clientSubmissionId?: string;
}

export interface ExistingVisit {
  id: string | number;
  // Sync-readiness columns (returned by GET /api/design-visits/:id via dv.*).
  // Captured at edit time so the sync engine can detect a stale-write conflict
  // when a queued edit is replayed after the server row changed underneath it.
  version?: number | null;
  updated_at?: string | null;
  visit_date?: string;
  duration_min?: number;
  location?: string;
  structuredAddress?: StructuredAddress;
  handle_id?: string | number | null;
  furniture_range_id?: string | number | null;
  notes?: string;
  visit_notes?: string | null;
  terms_accepted?: boolean;
  rooms?: Array<{
    id?: number | string;
    room_name?: string; roomName?: string;
    door_style_id?: string | number; doorStyleId?: string | number;
    width_mm?: number | null;  widthMm?: number | null;
    height_mm?: number | null; heightMm?: number | null;
    depth_mm?: number | null;  depthMm?: number | null;
    unit_count?: number; unitCount?: number;
    unit_price_pence?: number; unitPricePence?: number;
    notes?: string;
    images?: Array<{ storageKey?: string; storage_key?: string; mimeType?: string; mime_type?: string; viewUrl?: string; view_url?: string }>;
  }>;
}

export interface DesignVisitWizardProps {
  handler: DesignVisitWizardHandler;
  ctx: DesignVisitWizardCtx;
  existingVisit?: ExistingVisit | null;
  onClose: () => void;
  onCatalogueReady?: () => void;
  /** When true the wizard runs in read-only demo mode: no API calls, no
   *  draft storage, no writes.  Navigation between steps still works but
   *  the primary "Submit visit" button is disabled. */
  demo?: boolean;
}

function makeDefaultStep1(defaultDuration: number, existingVisit?: ExistingVisit | null, defaultDate?: string): Step1Data {
  const s: Step1Data = {
    visitDate: defaultDate ?? nowDateTime(),
    duration: String(defaultDuration),
    structuredAddress: emptyAddress(),
    designerName: '',
    handleId: '',
    furnitureRangeId: '',
    termsAccepted: false,
  };
  if (!existingVisit) return s;
  const ev = existingVisit;
  if (ev.visit_date) {
    try {
      const d = new Date(ev.visit_date);
      const pad = (n: number) => String(n).padStart(2, '0');
      s.visitDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch {}
  }
  if (ev.duration_min) s.duration = String(ev.duration_min);
  if (ev.structuredAddress && !isAddressEmpty(ev.structuredAddress)) {
    s.structuredAddress = ev.structuredAddress;
  } else if (ev.location) {
    s.structuredAddress = { ...emptyAddress(), addressLines: [String(ev.location)] };
  }
  if (ev.handle_id != null) s.handleId = String(ev.handle_id);
  if (ev.furniture_range_id != null) s.furnitureRangeId = String(ev.furniture_range_id);
  if (ev.notes) {
    const m = String(ev.notes).match(/^Designer:\s*(.+)$/);
    if (m) s.designerName = m[1].trim();
  }
  if (ev.visit_notes != null) s.visitNotes = String(ev.visit_notes);
  s.termsAccepted = !!ev.terms_accepted;
  return s;
}

function normaliseRooms(existingVisit?: ExistingVisit | null): RoomData[] {
  if (!existingVisit?.rooms?.length) {
    return [{ roomName: '', doorStyleId: '', widthMm: null, heightMm: null, depthMm: null, unitCount: 1, unitPricePence: 0, notes: '', images: [], answers: {} }];
  }
  return existingVisit.rooms.map(r => ({
    roomName:       r.room_name || r.roomName || '',
    doorStyleId:    String(r.door_style_id ?? r.doorStyleId ?? ''),
    widthMm:        r.width_mm  ?? r.widthMm  ?? null,
    heightMm:       r.height_mm ?? r.heightMm ?? null,
    depthMm:        r.depth_mm  ?? r.depthMm  ?? null,
    unitCount:      Math.max(1, parseInt(String(r.unit_count ?? r.unitCount ?? 1), 10) || 1),
    unitPricePence: Math.max(0, parseInt(String(r.unit_price_pence ?? r.unitPricePence ?? 0), 10) || 0),
    notes:          r.notes || '',
    images:         Array.isArray(r.images) ? r.images.map(i => ({
      storageKey: i.storageKey || i.storage_key || '',
      mimeType:   i.mimeType   || i.mime_type   || null,
      viewUrl:    i.viewUrl    || i.view_url    || '',
    })) : [],
    answers:        {},
  }));
}

function draftKey(contactId: string, editId?: string | number | null, newKey?: string): string {
  if (editId) return DV_WIZARD_DRAFT_EDIT_PREFIX + editId;
  if (contactId) return DV_WIZARD_DRAFT_PREFIX + contactId;
  // Brand-new customer (no contactId yet): key the draft on the per-visit
  // clientSubmissionId so concurrent new-customer drafts don't collide on 'new'.
  return DV_WIZARD_DRAFT_PREFIX + 'new:' + (newKey || 'anon');
}

function saveDraft(key: string, step1: Step1Data, rooms: RoomData[], answers: AnswerMap) {
  try { localStorage.setItem(key, JSON.stringify({ step1, rooms, answers })); } catch {}
}

function loadDraft(key: string): { step1: Step1Data; rooms: RoomData[]; answers?: AnswerMap } | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function clearDraft(key: string) {
  try { localStorage.removeItem(key); } catch {}
}

/**
 * Reads the current localStorage draft and extracts every *opaque* image
 * storageKey found in the rooms list.  Used on wizard open to find uploads from
 * a previous session that ended abruptly (crash, hard-close, forced reload) so
 * they can be deleted before the wizard starts fresh.
 *
 * Inline `data:` URIs (photos captured offline / on a failed upload) are skipped
 * deliberately: they live only in the draft, were never registered for upload
 * cleanup (`onNewUpload` fires for opaque keys only), and are not valid object
 * keys — sending one to the DELETE endpoint would push a multi-MB string into
 * the URL path.  Excluding them also lets an interrupted offline draft restore
 * cleanly instead of being wiped.
 */
function extractOrphanedDraftKeys(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const draft = JSON.parse(raw) as { rooms?: RoomData[] };
    return (draft.rooms || [])
      .flatMap(r => (r.images || []).map(img => img.storageKey))
      .filter((k): k is string => typeof k === 'string' && k.length > 0 && !k.startsWith('data:'));
  } catch {
    return [];
  }
}

export function DesignVisitWizard({ handler, ctx, existingVisit, onClose, onCatalogueReady, demo }: DesignVisitWizardProps) {
  const cfg = handler.config || {};
  const defaultDuration = cfg.defaultDurationMin || 90;
  const newContact    = ctx.newContact;
  const clientSubmissionId = ctx.clientSubmissionId;
  const contactId     = ctx.contactId    || ctx.contact_id    || '';
  const contactName   = ctx.contactName  || ctx.contact_name  || newContact?.name  || '';
  const contactEmail  = ctx.contactEmail || ctx.contact_email || newContact?.email || '';
  const contactPhone  = ctx.contactPhone || newContact?.phone || '';
  const contactMobile = ctx.contactMobile || '';
  const editMode     = !!(existingVisit && existingVisit.id);
  const editVisitId  = editMode ? existingVisit!.id : null;
  const storageKey   = draftKey(contactId, editVisitId, clientSubmissionId);

  const [open, setOpen] = useState(true);
  const [step, setStep] = useState(1);
  const [showDiscardDialog, setShowDiscardDialog] = useState(false);

  /**
   * Captured once at mount so that the step1 state initializer and the
   * initialStep1Ref baseline always use the same timestamp string.
   * Prevents a false-positive "unsaved changes" prompt if a minute-boundary
   * rolls over between the two `makeDefaultStep1` calls.
   */
  const [mountDefaultDate] = useState(nowDateTime);

  /**
   * Image storageKeys found in the localStorage draft when this wizard
   * instance first mounted.  They belong to a previous session that was
   * interrupted (crash / hard-close / forced reload) before the cleanup
   * useEffect could fire, so they are orphaned.  Captured once at mount time
   * so the recovery useEffect below can delete them.
   *
   * In demo mode there is no draft, so always empty.
   */
  const [orphanedDraftKeys] = useState<string[]>(() =>
    editMode || demo ? [] : extractOrphanedDraftKeys(storageKey)
  );

  /**
   * True when a localStorage draft was restored at mount (no orphaned images).
   * Used to show a one-time "Restoring your draft from last time" notice.
   * Declared after orphanedDraftKeys so the initializer can safely read it.
   */
  const [showDraftNotice, setShowDraftNotice] = useState<boolean>(() => {
    if (editMode || demo) return false;
    if (orphanedDraftKeys.length > 0) return false;
    return loadDraft(storageKey) !== null;
  });

  const [step1, setStep1] = useState<Step1Data>(() => {
    // Demo mode — pre-fill with representative placeholder values.
    if (demo) return { ...DEMO_STEP1 };
    // When the prior session was interrupted (orphaned uploads detected) we
    // intentionally skip draft restoration so the wizard starts completely
    // fresh.  Only restore the draft when there are no orphaned image uploads.
    if (!editMode && orphanedDraftKeys.length === 0) {
      const draft = loadDraft(storageKey);
      if (draft) return draft.step1;
    }
    return makeDefaultStep1(defaultDuration, existingVisit, mountDefaultDate);
  });

  const [rooms, setRooms] = useState<RoomData[]>(() => {
    // Demo mode — pre-fill with representative placeholder rooms.
    if (demo) return DEMO_ROOMS.map(r => ({ ...r }));
    // Same guard as step1: skip draft restoration when orphaned uploads exist.
    if (!editMode && orphanedDraftKeys.length === 0) {
      const draft = loadDraft(storageKey);
      if (draft) return draft.rooms;
    }
    return normaliseRooms(existingVisit);
  });

  // Whole-visit questionnaire (scope='visit'). Questions are fetched from the
  // shared questionnaire engine; answers travel inline with the submit payload
  // so they survive the offline queue.
  const [visitQuestions, setVisitQuestions] = useState<VisitQuestion[]>(
    demo ? DEMO_VISIT_QUESTIONS : []
  );
  // Per-room questionnaire (scope='room'). Each room captures its own answers
  // (stored on RoomData.answers); they travel inline within the rooms payload
  // so they survive the offline queue. The backend tags them with the
  // freshly-inserted room id on save (room DB ids are not stable across edits).
  const [roomQuestions, setRoomQuestions] = useState<VisitQuestion[]>(
    demo ? DEMO_ROOM_QUESTIONS : []
  );
  const [showRoomAnswerValidation, setShowRoomAnswerValidation] = useState(false);
  const [s2Error, setS2Error] = useState('');
  const [answers, setAnswers] = useState<AnswerMap>(() => {
    if (demo) return { ...DEMO_VISIT_ANSWERS };
    if (!editMode && orphanedDraftKeys.length === 0) {
      const draft = loadDraft(storageKey);
      if (draft?.answers) return draft.answers;
    }
    return {};
  });

  const [handles, setHandles]               = useState<CatalogueItem[]>(demo ? DEMO_HANDLES : []);
  const [furnitureRanges, setFurnitureRanges] = useState<CatalogueItem[]>(demo ? DEMO_FURNITURE_RANGES : []);
  const [doorStyles, setDoorStyles]           = useState<DoorStyleOption[]>(demo ? DEMO_DOOR_STYLES : []);
  const [termsText, setTermsText]             = useState(demo ? DEMO_TERMS_TEXT : '');
  const [termsVersionNumber, setTermsVersionNumber] = useState<number | null>(null);
  const [catalogueLoading, setCatalogueLoading] = useState(!demo);

  const [s1Error, setS1Error]       = useState('');
  const [showAnswerValidation, setShowAnswerValidation] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [uploading, setUploading]   = useState(false);

  /**
   * ISO timestamp of the HubSpot note used to pre-fill the visit notes field.
   * Non-empty only on a fresh open (no draft restored, not edit mode) when the
   * server found at least one note for the contact.  Never persisted to the
   * draft — so if the user closes and reopens with a draft in place, the
   * attribution line won't re-appear (correct behaviour: notes are their own
   * now).
   */
  const [visitNotesTimestamp, setVisitNotesTimestamp] = useState('');

  const { showToast, showToastWithAction } = useToastContext();
  const { user: currentUser } = useAuth();

  const intermediateStatusFiredRef = useRef(false);

  /**
   * Snapshot of step1 / rooms at the moment the wizard opened in edit mode.
   * Used to detect whether the user has actually changed anything before
   * showing the "Discard changes?" prompt.  Irrelevant in new-visit mode.
   */
  const initialStep1Ref = useRef<Step1Data>(makeDefaultStep1(defaultDuration, existingVisit, mountDefaultDate));
  const initialRoomsRef = useRef<RoomData[]>(normaliseRooms(existingVisit));

  /**
   * Keys uploaded during this wizard session that haven't yet been committed
   * to a DB row via a successful submit.  Populated by DesignVisitRoomsStep
   * via onNewUpload; pruned when the user manually removes a photo (the step
   * already fires the DELETE in that case) and cleared wholesale after a
   * successful submission.  On wizard unmount the cleanup effect deletes any
   * remaining keys so orphaned uploads don't linger in storage.
   */
  const pendingUploadKeysRef = useRef<Set<string>>(new Set());
  /** Flipped to true after a successful submit so the cleanup effect is a no-op. */
  const committedRef = useRef(false);

  /**
   * Timer handle for the post-discard undo window.  Cleared on component
   * unmount so a dangling timeout never fires after the wizard is gone.
   */
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (undoTimerRef.current !== null) {
        clearTimeout(undoTimerRef.current);
        undoTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (demo) { onCatalogueReady?.(); return; }
    let cancelled = false;
    // Pre-fill visit notes from HubSpot on a fresh new-visit open only.
    // Skip when editing an existing visit or when a draft was already restored
    // (the draft preserves whatever the user typed previously).
    const hasDraft = !editMode && orphanedDraftKeys.length === 0 && loadDraft(storageKey) !== null;
    if (!editMode && !hasDraft && contactId) {
      fetch('/api/card-actions/start-design-visit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId }),
      })
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          if (!d || cancelled) return;
          setStep1(prev => {
            const next = { ...prev };
            if (d.visitNotes) next.visitNotes = d.visitNotes;
            // Inherit the duration from the booked visit (set at scheduling
            // time). The field isn't shown in this wizard — this just carries
            // the right value through to submit / the calendar event. Falls
            // back to the handler default when no booking is found.
            if (typeof d.scheduledDurationMin === 'number' && d.scheduledDurationMin > 0) {
              next.duration = String(d.scheduledDurationMin);
              initialStep1Ref.current = { ...initialStep1Ref.current, duration: String(d.scheduledDurationMin) };
            }
            // Seed the address from the customer's record so the wizard shows it
            // read-only. Only fill when the current address is empty so a
            // restored draft is never overwritten.
            if (d.contactStructuredAddress && isAddressEmpty(prev.structuredAddress)) {
              next.structuredAddress = d.contactStructuredAddress;
              // Fold the seeded address into the unsaved-changes baseline so a
              // pre-filled (but untouched) address doesn't trigger the
              // "Discard your draft?" prompt on close.
              initialStep1Ref.current = { ...initialStep1Ref.current, structuredAddress: d.contactStructuredAddress };
            }
            return next;
          });
          if (d.visitNotes) setVisitNotesTimestamp(d.visitNotesTimestamp || '');
        })
        .catch(() => { /* best-effort — notes stay empty on any error */ });
    }
    async function load() {
      try {
        const [h, fr, ds] = await Promise.all([
          fetch('/api/catalog/handles').then(r => r.ok ? r.json() : []),
          fetch('/api/catalog/ranges').then(r => r.ok ? r.json() : []),
          fetch('/api/catalog/doors').then(r => r.ok ? r.json() : []),
        ]);
        if (!cancelled) { setHandles(h); setFurnitureRanges(fr); setDoorStyles(ds); }
      } catch {}
      try {
        const qr = await fetch('/api/visit-questions?applies_to=design');
        if (!cancelled && qr.ok) {
          const all: VisitQuestion[] = await qr.json();
          const list = Array.isArray(all) ? all : [];
          setVisitQuestions(list.filter(q => q.scope === 'visit'));
          setRoomQuestions(list.filter(q => q.scope === 'room'));
        }
      } catch {}
      if (editMode && editVisitId != null) {
        try {
          const ar = await fetch(`/api/design-visits/${encodeURIComponent(String(editVisitId))}/answers`);
          if (!cancelled && ar.ok) {
            const rows: Array<{ question_id: number; room_id: number | null; answer: AnswerMap[number] }> = await ar.json();
            // Split into whole-visit answers (room_id null) and per-room answers
            // (keyed by the room's DB id). Room DB ids are returned by
            // loadVisitWithRooms (dvr.*), so we can map each room answer back to
            // its room by matching existingVisit.rooms[i].id.
            const visitMap: AnswerMap = {};
            const perRoomById: Record<number, AnswerMap> = {};
            for (const row of (Array.isArray(rows) ? rows : [])) {
              if (row.room_id == null) {
                visitMap[row.question_id] = row.answer;
              } else {
                (perRoomById[row.room_id] ||= {})[row.question_id] = row.answer;
              }
            }
            if (!cancelled) {
              setAnswers(visitMap);
              if (Object.keys(perRoomById).length) {
                const evRooms = existingVisit?.rooms || [];
                // Inject room answers by matching position (rooms state is
                // initialised from existingVisit.rooms in the same order).
                const injected = initialRoomsRef.current.map((r, i) => {
                  const rid = (evRooms[i] as { id?: number | string } | undefined)?.id;
                  const a = rid != null ? perRoomById[Number(rid)] : undefined;
                  return a ? { ...r, answers: { ...(r.answers || {}), ...a } } : r;
                });
                setRooms(injected);
                // Keep the edit-mode baseline in sync so loading answers does not
                // count as an unsaved change (which would prompt "Discard?").
                initialRoomsRef.current = injected;
              }
            }
          }
        } catch {}
      }
      try {
        const tr = await fetch('/api/design-visit-terms');
        if (!cancelled && tr.ok) {
          const td = await tr.json();
          setTermsText(td.terms || '');
          setTermsVersionNumber(td.versionNumber ?? null);
        }
      } catch {}
      if (!cancelled) {
        setCatalogueLoading(false);
        onCatalogueReady?.();
      }
    }
    load();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (demo) return;
    const intermediateStatus = cfg.intermediateLeadStatus;
    if (!editMode && intermediateStatus && contactId && !intermediateStatusFiredRef.current) {
      intermediateStatusFiredRef.current = true;
      // Broadcast optimistically and route the write through the offline queue so
      // the "design visit in progress" lead status still applies on reconnect
      // when the wizard was opened offline (a raw fetch would silently no-op
      // offline). dedupeKey matches the canonical lead-status writes so it
      // collapses with any other queued status change for this contact.
      broadcastLeadStatusChange(contactId, { hs_lead_status: intermediateStatus });
      void import('../lib/offlineQueue')
        .then(({ sendOrQueue }) => sendOrQueue({
          area: 'customer',
          label: `Lead status → ${intermediateStatus}`,
          method: 'PATCH',
          url: `/api/contacts/${encodeURIComponent(contactId)}`,
          body: { hs_lead_status: intermediateStatus },
          dedupeKey: `contact:${contactId}:lead-status`,
        }))
        .catch(e => console.warn('[design-visit] intermediate lead status update failed:', e?.message));
    }
  }, [editMode, cfg.intermediateLeadStatus, contactId, demo]);

  // Pre-fill the designer name with the logged-in user — the person running the
  // wizard is usually the designer. Only seeds a fresh new visit when the field
  // is still empty, so a restored draft, a manual edit, or an existing visit's
  // designer is never overwritten. The name stays editable.
  useEffect(() => {
    if (demo || editMode) return;
    const name = [currentUser?.first_name, currentUser?.last_name].filter(Boolean).join(' ').trim();
    if (!name) return;
    setStep1(prev => {
      if (prev.designerName.trim()) return prev;
      // Fold the seeded name into the unsaved-changes baseline so a pre-filled
      // (but untouched) designer name doesn't trigger the "Discard?" prompt.
      initialStep1Ref.current = { ...initialStep1Ref.current, designerName: name };
      return { ...prev, designerName: name };
    });
  }, [currentUser, demo, editMode]);

  useEffect(() => {
    const channels: BroadcastChannel[] = [];
    for (const name of ['catalog_handles_changed', 'catalog_ranges_changed', 'catalog_doors_changed']) {
      try {
        const ch = new BroadcastChannel(name);
        ch.addEventListener('message', async () => {
          try {
            const [h, fr, ds] = await Promise.all([
              fetch('/api/catalog/handles').then(r => r.ok ? r.json() : handles),
              fetch('/api/catalog/ranges').then(r => r.ok ? r.json() : furnitureRanges),
              fetch('/api/catalog/doors').then(r => r.ok ? r.json() : doorStyles),
            ]);
            setHandles(h); setFurnitureRanges(fr); setDoorStyles(ds);
          } catch {}
        });
        channels.push(ch);
      } catch {}
    }
    return () => { channels.forEach(ch => { try { ch.close(); } catch {} }); };
  }, []);

  /**
   * Orphan-recovery effect — runs once on mount.
   *
   * If the previous wizard session ended abruptly (browser crash, forced
   * reload, tab hard-close before the SPA navigation unmount could fire) the
   * abandon-cleanup useEffect below never ran for that session and the images
   * it had uploaded are stranded in object storage.  `orphanedDraftKeys` was
   * computed from the localStorage draft before this session's state was
   * saved, so it contains exactly those unreachable keys.  We delete them now
   * and clear the draft so the wizard opens cleanly.
   */
  useEffect(() => {
    if (!orphanedDraftKeys.length) return;
    for (const key of orphanedDraftKeys) {
      fetch(`/api/design-visits/uploads/${encodeURIComponent(key)}`, { method: 'DELETE' })
        .catch(err => console.warn('[design-visit] orphan-recovery delete failed:', err));
    }
    clearDraft(storageKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!editMode && !demo) saveDraft(storageKey, step1, rooms, answers);
  }, [step1, rooms, answers, editMode, demo, storageKey]);

  useEffect(() => {
    return () => {
      if (committedRef.current) return;
      const keysToDelete = Array.from(pendingUploadKeysRef.current);
      if (!keysToDelete.length) return;
      for (const key of keysToDelete) {
        fetch(`/api/design-visits/uploads/${encodeURIComponent(key)}`, { method: 'DELETE' })
          .catch(err => console.warn('[design-visit] abandon-cleanup delete failed:', err));
      }
    };
  }, []);

  function hasUnsavedDraftData(): boolean {
    const step1Touched =
      step1.visitDate !== initialStep1Ref.current.visitDate ||
      step1.designerName.trim() !== (initialStep1Ref.current.designerName ?? '').trim() ||
      JSON.stringify(step1.structuredAddress) !== JSON.stringify(initialStep1Ref.current.structuredAddress) ||
      step1.handleId !== '' ||
      step1.furnitureRangeId !== '';
    const roomsTouched = rooms.some(
      r =>
        r.roomName.trim() !== '' ||
        r.doorStyleId !== '' ||
        r.widthMm !== null ||
        r.heightMm !== null ||
        r.depthMm !== null ||
        r.unitPricePence > 0 ||
        r.notes.trim() !== ''
    );
    return step1Touched || roomsTouched;
  }

  /** Returns true when the user has changed anything vs the pre-loaded values. */
  function hasEditModeChanges(): boolean {
    return (
      JSON.stringify(step1) !== JSON.stringify(initialStep1Ref.current) ||
      JSON.stringify(rooms) !== JSON.stringify(initialRoomsRef.current)
    );
  }

  const doClose = useCallback(() => {
    setOpen(false);
    setTimeout(onClose, 300);
  }, [onClose]);

  const handleClose = useCallback(() => {
    if (!demo && !committedRef.current) {
      if (!editMode && hasUnsavedDraftData()) {
        setShowDiscardDialog(true);
        return;
      }
      if (editMode && hasEditModeChanges()) {
        setShowDiscardDialog(true);
        return;
      }
    }
    doClose();
  }, [demo, editMode, step1, rooms, doClose]); // eslint-disable-line react-hooks/exhaustive-deps

  // Step 1 is purely about confirming the start of the visit (when / where /
  // who). Product selection, the visit questionnaire and the terms reference
  // all live on later steps, so the only gate here is a valid visit date.
  function advanceToStep2() {
    if (!demo && !step1.visitDate) {
      setS1Error('Please set the visit date and time.');
      return;
    }
    setS1Error('');
    setStep(2);
  }

  // Step 2 carries product selection, the whole-visit questionnaire and the
  // rooms. Rooms must be named (also enforced by the button's disabled state)
  // and any required visit / per-room questions must be answered before review.
  function advanceToStep3() {
    if (rooms.some(r => !r.roomName.trim()) || rooms.length === 0) return;
    if (!demo && missingRequired(visitQuestions, answers).length > 0) {
      setShowAnswerValidation(true);
      setS2Error('Please answer all required questions before continuing.');
      return;
    }
    if (!demo && roomQuestions.length > 0) {
      const anyMissing = rooms.some(r => missingRequired(roomQuestions, r.answers || {}).length > 0);
      if (anyMissing) {
        setShowRoomAnswerValidation(true);
        setS2Error('Please answer all required questions for each room before continuing.');
        return;
      }
    }
    setShowAnswerValidation(false);
    setShowRoomAnswerValidation(false);
    setS2Error('');
    setStep(3);
  }

  async function handleSubmit() {
    setSubmitting(true);
    setSubmitError('');
    try {
      const payload = {
        ...(contactId ? { contactId } : {}),
        ...(newContact ? { newContact } : {}),
        ...(clientSubmissionId ? { clientSubmissionId } : {}),
        contactName,
        contactEmail,
        handleId:         step1.handleId         || undefined,
        furnitureRangeId: step1.furnitureRangeId  || undefined,
        visitDate:        step1.visitDate         || undefined,
        durationMin:      parseInt(step1.duration, 10) || defaultDuration,
        structuredAddress: step1.structuredAddress,
        notes:            step1.designerName ? `Designer: ${step1.designerName}` : undefined,
        visitNotes:       step1.visitNotes   || undefined,
        termsAccepted:    true,
        rooms: rooms.map(r => ({
          roomName:       r.roomName,
          doorStyleId:    r.doorStyleId || undefined,
          widthMm:        r.widthMm     || undefined,
          heightMm:       r.heightMm    || undefined,
          depthMm:        r.depthMm     || undefined,
          unitCount:      r.unitCount,
          unitPricePence: r.unitPricePence,
          notes:          r.notes       || undefined,
          images:         (r.images || []).map(img => ({
            storageKey: img.storageKey,
            mimeType:   img.mimeType,
          })),
          // Per-room questionnaire answers (scope='room'). Carried inline within
          // the room so the backend can tag them with the freshly-inserted room
          // id, and so they survive the offline queue alongside the room data.
          answers: roomQuestions
            .filter(q => r.answers?.[q.id] !== undefined)
            .map(q => ({ question_id: q.id, answer: r.answers![q.id] })),
        })),
        handlerConfig: cfg,
        // Whole-visit questionnaire answers (scope='visit', no room_id). Sent
        // inline so they replay correctly through the offline queue.
        answers: visitQuestions
          .filter(q => answers[q.id] !== undefined)
          .map(q => ({ question_id: q.id, answer: answers[q.id] })),
      };
      const url    = editMode ? `/api/design-visits/${encodeURIComponent(String(editVisitId))}` : '/api/design-visits';
      const method = editMode ? 'PUT' : 'POST';
      // Offline-aware submit. When offline / on a network error the design visit
      // is queued and replayed (with its side effects — sign-off email, QB
      // estimate) once connectivity returns. Edit-mode updates carry a
      // conflict-check URL so a stale overwrite is logged for Phase 3 review.
      const { sendOrQueue } = await import('../lib/offlineQueue');
      const res = await sendOrQueue({
        area: 'visit',
        label: editMode ? `Edit design visit — ${contactName || contactId}` : `Design visit — ${contactName || contactId}`,
        method,
        url,
        body: payload,
        ...(editMode
          ? {
              conflictCheckUrl: `/api/design-visits/${encodeURIComponent(String(editVisitId))}`,
              recordKey: `dv:${editVisitId}`,
              // Same key as recordKey so a second edit of this visit (e.g.
              // resuming queued changes and re-saving) replaces the existing
              // outbox entry in place instead of appending a conflicting one.
              dedupeKey: `dv:${editVisitId}`,
              baseVersion: existingVisit?.version ?? null,
              baseUpdatedAt: existingVisit?.updated_at ?? null,
            }
          : {}),
        // Brand-new design visit from the standalone page: collapse repeat
        // submits of the same visit into one queue entry (the server also
        // dedupes by clientSubmissionId on replay).
        ...(!editMode && clientSubmissionId ? { dedupeKey: `dv-new:${clientSubmissionId}` } : {}),
        // When queued offline, carry calendar metadata so the sync engine can
        // create the event after replay — mirroring the online-submission path.
        ...(!editMode && step1.visitDate
          ? {
              calendarMeta: {
                summary: `Design visit — ${contactName || contactId}`,
                description: step1.designerName ? `Designer: ${step1.designerName}` : '',
                location: formatAddress(step1.structuredAddress),
                visitDate: step1.visitDate,
                durationMins: parseInt(step1.duration, 10) || defaultDuration,
                moContactId: contactId ? String(contactId) : undefined,
                moVisitType: 'design' as const,
              },
            }
          : {}),
      });
      if (!res.queued && !res.ok) {
        const d = res.data as { error?: string; code?: string } | undefined;
        if (d?.code === 'LEAD_STATUS_REMOVED') {
          throw new Error(LEAD_STATUS_REMOVED_MESSAGE);
        }
        throw new Error(d?.error || (editMode ? 'Save failed' : 'Submission failed'));
      }
      committedRef.current = true;
      pendingUploadKeysRef.current.clear();
      clearDraft(storageKey);
      setOpen(false);

      // Best-effort calendar event (new visits only, when online and visitDate is set).
      let calendarCreated = false;
      if (!res.queued && !editMode && step1.visitDate) {
        try {
          const start = new Date(step1.visitDate);
          const durationMins = parseInt(step1.duration, 10) || defaultDuration;
          const end = new Date(start.getTime() + durationMins * 60000);
          await POST('/api/events', {
            summary: `Design visit — ${contactName || contactId}`,
            description: step1.designerName ? `Designer: ${step1.designerName}` : '',
            location: formatAddress(step1.structuredAddress),
            start: { dateTime: start.toISOString() },
            end: { dateTime: end.toISOString() },
            moContactId: contactId ? String(contactId) : undefined,
            moVisitType: 'design',
          });
          calendarCreated = true;
        } catch { /* calendar is best-effort */ }
      }

      setTimeout(() => {
        onClose();
        const baseMsg = res.queued
          ? (editMode
              ? "Design visit saved offline — it'll sync and send the sign-off email when you're back online."
              : "Design visit saved offline — it'll submit and send the sign-off email when you're back online.")
          : (editMode
              ? 'Design visit updated. A fresh sign-off email has been sent.'
              : 'Design visit submitted. Customer sign-off email sent.');
        const successMsg = (!res.queued && !editMode && step1.visitDate && calendarCreated)
          ? `${baseMsg} Calendar event created.`
          : baseMsg;
        showToast(successMsg, false);
        if (typeof (window as unknown as Record<string, unknown>)['renderDesignVisits'] === 'function') {
          try { ((window as unknown as Record<string, unknown>)['renderDesignVisits'] as () => void)(); } catch {}
        }
        if (!res.queued && !editMode && step1.visitDate && !calendarCreated) {
          showToastWithAction(
            'Visit submitted — calendar event could not be created (Google disconnected)',
            {
              label: 'Reconnect',
              onClick: () => openConnectModal('google', 'Reconnect Google to create calendar events when booking visits.'),
            },
            { severity: 'warning', duration: 8000 },
          );
        }
      }, 300);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : (editMode ? 'Save failed. Please try again.' : 'Submission failed. Please try again.');
      setSubmitError(msg);
      setSubmitting(false);
    }
  }

  const title = demo
    ? 'Design Visit'
    : editMode
    ? 'Edit Design Visit'
    : (contactName ? `Design Visit — ${contactName}` : 'Design Visit');

  const stepLabel = step === 1 ? 'Step 1 of 3 — Confirm visit'
                  : step === 2 ? 'Step 2 of 3 — Products & rooms'
                  : 'Step 3 of 3 — Review & submit';

  const footer = (
    <Box sx={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '10px' }}>
      {(s1Error && step === 1) && (
        <Typography sx={{ color: 'error.dark', fontSize: '.82rem' }}>{s1Error}</Typography>
      )}
      {(s2Error && step === 2) && (
        <Typography sx={{ color: 'error.dark', fontSize: '.82rem' }}>{s2Error}</Typography>
      )}
      {(submitError && step === 3) && (
        <Typography sx={{ color: 'error.dark', fontSize: '.82rem' }}>{submitError}</Typography>
      )}

      <Box sx={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
        {step > 1 && (
          <Button
            variant="outlined"
            onClick={() => { setSubmitError(''); setStep(s => s - 1); }}
            disabled={submitting}
            sx={{
              borderColor: 'var(--neutral-300)',
              color: 'var(--neutral-700)',
              fontWeight: 600,
              textTransform: 'none',
              '&:hover': { borderColor: 'var(--neutral-400)', background: 'var(--neutral-50)' },
            }}
          >
            ← Back
          </Button>
        )}

        {step === 1 && (
          <Button
            variant="contained"
            onClick={advanceToStep2}
            sx={{
              background: BRAND_COLORS.orchid,
              fontWeight: 600,
              textTransform: 'none',
              '&:hover': { background: BRAND_COLORS.orchidPress },
            }}
          >
            Next →
          </Button>
        )}

        {step === 2 && (
          <Button
            variant="contained"
            onClick={advanceToStep3}
            disabled={uploading || rooms.some(r => !r.roomName.trim()) || rooms.length === 0}
            sx={{
              background: BRAND_COLORS.orchid,
              fontWeight: 600,
              textTransform: 'none',
              '&:hover': { background: BRAND_COLORS.orchidPress },
              '&:disabled': { opacity: 0.55 },
            }}
          >
            Review →
          </Button>
        )}

        {step === 3 && (
          <Tooltip title={demo ? DEMO_TOOLTIP : ''} disableHoverListener={!demo} arrow>
            <span>
              <Button
                variant="contained"
                onClick={handleSubmit}
                disabled={demo || submitting}
                startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : undefined}
                sx={{
                  background: BRAND_COLORS.orchid,
                  fontWeight: 600,
                  textTransform: 'none',
                  '&:hover': { background: BRAND_COLORS.orchidPress },
                  '&:disabled': { opacity: 0.55 },
                }}
              >
                {submitting
                  ? (editMode ? 'Saving…' : 'Submitting…')
                  : (editMode ? 'Save changes' : 'Submit visit')}
              </Button>
            </span>
          </Tooltip>
        )}
      </Box>
    </Box>
  );

  return (
    <>
    <VisitWizardShell
      open={open}
      onClose={handleClose}
      title={title}
      headerActions={demo ? <Chip label="Demo preview" size="small" color="info" variant="outlined" sx={{ flexShrink: 0 }} /> : undefined}
      footer={footer}
      contactName={contactName}
      contactEmail={contactEmail}
      contactPhone={contactPhone}
      contactMobile={contactMobile}
      contactId={demo ? undefined : contactId}
      loading={catalogueLoading}
      draftNotice={showDraftNotice}
      onDismissDraftNotice={() => setShowDraftNotice(false)}
      step={step}
      totalSteps={3}
      stepLabel={stepLabel}
    >
      {step === 1 && (
        <>
          <Typography sx={{ fontSize: '.84rem', color: 'var(--neutral-600)', mb: '16px', lineHeight: 1.5 }}>
            Confirm where and when the visit is taking place to get started. You&rsquo;ll
            choose the products and add room measurements on the next step.
          </Typography>
          <DesignVisitStep1
            initialData={step1}
            handles={handles}
            furnitureRanges={furnitureRanges}
            termsText={termsText}
            termsVersionNumber={termsVersionNumber}
            onDataChange={setStep1}
            // Existing customers: the address is captured on their record at
            // scheduling time, so show it read-only here. Brand-new customers
            // (standalone page, no contactId yet) still get the editable input.
            addressReadOnly={!!contactId}
            // Step 1 is purely about confirming the visit start. Duration is
            // inherited from the scheduled visit; product selection, the visit
            // questionnaire and the terms reference all live on later steps.
            showDuration={false}
            showProductSelection={false}
            showTerms={false}
            visitNotesTimestamp={visitNotesTimestamp || undefined}
            onVisitNotesEdited={() => setVisitNotesTimestamp('')}
          />
        </>
      )}

      {step === 2 && (
        <>
          {(handles.length > 0 || furnitureRanges.length > 0) && (
            <Box sx={{ mb: '20px' }}>
              <Typography
                sx={{
                  fontSize: '.7rem',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '.06em',
                  color: 'var(--neutral-400)',
                  mb: '10px',
                }}
              >
                Product selection
              </Typography>
              <CatalogueDropdowns
                dropdowns={[
                  {
                    label: 'Handle selection',
                    value: step1.handleId,
                    options: handles,
                    onChange: (v) => setStep1(prev => ({ ...prev, handleId: v })),
                    noneLabel: '— select handle —',
                  },
                  {
                    label: 'Furniture range',
                    value: step1.furnitureRangeId,
                    options: furnitureRanges,
                    onChange: (v) => setStep1(prev => ({ ...prev, furnitureRangeId: v })),
                    noneLabel: '— select range —',
                  },
                ]}
              />
            </Box>
          )}

          {visitQuestions.length > 0 && (
            <Box sx={{ mb: '20px' }}>
              <QuestionnaireRenderer
                questions={visitQuestions}
                answers={answers}
                onChange={(id, value) => setAnswers(prev => ({ ...prev, [id]: value }))}
                showValidation={showAnswerValidation}
              />
            </Box>
          )}

          <DesignVisitRoomsStep
            initialRooms={rooms}
            doorStyles={doorStyles}
            onRoomsChange={setRooms}
            onUploadingChange={setUploading}
            onNewUpload={key => pendingUploadKeysRef.current.add(key)}
            onImageRemoved={key => pendingUploadKeysRef.current.delete(key)}
            roomQuestions={roomQuestions}
            showAnswerValidation={showRoomAnswerValidation}
            demo={demo}
          />
        </>
      )}

      {step === 3 && (
        <DesignVisitStep3
          step1Data={step1}
          rooms={rooms}
          handles={handles}
          furnitureRanges={furnitureRanges}
          doorStyles={doorStyles}
          termsText={termsText}
          termsVersionNumber={termsVersionNumber}
          visitQuestions={visitQuestions}
          answers={answers}
          roomQuestions={roomQuestions}
          // Duration isn't captured in this wizard, and the customer doesn't
          // accept terms here — show the terms as a read-only reference so the
          // designer can see which T&Cs accompany the quotation.
          showDuration={false}
          termsMode="reference"
        />
      )}
    </VisitWizardShell>

    {/* Discard draft confirmation */}
    <FullScreenModal
      open={showDiscardDialog}
      onClose={() => setShowDiscardDialog(false)}
      title={editMode ? 'Discard your changes?' : 'Discard your draft?'}
      centerContent
      footer={
        <>
          <Button
            onClick={() => setShowDiscardDialog(false)}
            variant="outlined"
            sx={{
              borderColor: 'var(--neutral-300)',
              color: 'var(--neutral-700)',
              fontWeight: 600,
              textTransform: 'none',
              '&:hover': { borderColor: 'var(--neutral-400)', background: 'var(--neutral-50)' },
            }}
          >
            Keep editing
          </Button>
          <Button
            onClick={() => {
              // Capture current state before closing so the undo closure
              // can restore it if the user changes their mind.
              const savedStep1 = step1;
              const savedRooms = rooms;
              const savedAnswers = answers;

              // In new-visit mode the draft lives in localStorage; clear it
              // now so a page reload doesn't resurrect it.  In edit mode there
              // is no localStorage draft — state lives only in React.
              if (!editMode) clearDraft(storageKey);

              setShowDiscardDialog(false);

              // Close the drawer visually but keep the component mounted
              // during the undo window so we can re-open it without
              // re-initialising all state from scratch.
              setOpen(false);

              // Cancel any previously running undo timer (defensive).
              if (undoTimerRef.current !== null) {
                clearTimeout(undoTimerRef.current);
              }

              // After the undo window expires, fully unmount the wizard.
              undoTimerRef.current = setTimeout(() => {
                undoTimerRef.current = null;
                onClose();
              }, 6200);

              showToastWithAction(
                editMode ? 'Changes discarded' : 'Draft discarded',
                {
                  label: 'Undo',
                  onClick: () => {
                    // Cancel the pending full-close.
                    if (undoTimerRef.current !== null) {
                      clearTimeout(undoTimerRef.current);
                      undoTimerRef.current = null;
                    }
                    if (!editMode) {
                      // Restore the draft to localStorage so it survives
                      // any future page reload, then re-open the drawer.
                      saveDraft(storageKey, savedStep1, savedRooms, savedAnswers);
                    } else {
                      // In edit mode state is already in React — just restore
                      // step1/rooms to what they were when the dialog opened
                      // (in case an earlier setStep1/setRooms ran) and
                      // re-open.  The refs are still live.
                      setStep1(savedStep1);
                      setRooms(savedRooms);
                      setAnswers(savedAnswers);
                    }
                    setOpen(true);
                  },
                },
                { duration: 6000 },
              );
            }}
            variant="contained"
            sx={{
              background: 'error.main',
              fontWeight: 600,
              textTransform: 'none',
              '&:hover': { background: 'error.dark' },
            }}
          >
            Discard
          </Button>
        </>
      }
    >
      <Typography sx={{ fontSize: '.9rem', color: 'var(--neutral-700)' }}>
        {editMode
          ? 'You have unsaved changes. If you close now your edits will be lost.'
          : 'You have unsaved room data. If you close now your draft will be lost.'}
      </Typography>
    </FullScreenModal>
    </>
  );
}

export default DesignVisitWizard;
