import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SV_WIZARD_DRAFT_PREFIX, SV_WIZARD_DRAFT_EDIT_PREFIX } from '../constants/localStorageKeys';
import { nowDateTime } from '../utils/dateDefaults';
import { BRAND_COLORS } from '../theme';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { FullScreenModal } from './modals/FullScreenModal';
import { VisitWizardShell } from './VisitWizardShell';
import { useToastContext } from '../contexts/ToastContext';
import { LEAD_STATUS_REMOVED_MESSAGE, POST } from '../utils/api';
import { openConnectModal } from '../context/ConnectionToastContext';
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
  DEMO_SURVEY_VISIT_QUESTIONS,
  DEMO_SURVEY_ROOM_QUESTIONS,
  DEMO_SURVEY_VISIT_ANSWERS,
  DEMO_SURVEY_ROOM_ANSWERS,
} from './modals/demoData';
import { DesignVisitStep1, type Step1Data, type CatalogueItem } from './DesignVisitStep1';
import type { CatalogueSuggestion } from './CatalogueDropdowns';
import { QuestionnaireRenderer, missingRequired, type VisitQuestion, type AnswerMap } from './QuestionnaireRenderer';
import { emptyAddress, isAddressEmpty, type StructuredAddress } from '../../../shared/address';
import { DesignVisitRoomsStep, type RoomData, type DoorStyleOption } from './DesignVisitRoomsStep';
import { DesignVisitStep3 } from './DesignVisitStep3';

const SURVEY_ENDPOINTS = {
  uploadUrl: '/api/survey-visits/uploads',
  signUrl: '/api/survey-visits/sign-image-urls',
  deleteUrl: (key: string) => `/api/survey-visits/uploads/${encodeURIComponent(key)}`,
};

export interface SurveyVisitWizardHandler {
  id?: number | string;
  type?: string;
  config?: {
    defaultDurationMin?: number;
    intermediateLeadStatus?: string;
    submittedLeadStatus?: string;
    [key: string]: unknown;
  };
}

export interface SurveyVisitWizardCtx {
  contactId?: string;
  contact_id?: string;
  contactName?: string;
  contact_name?: string;
  contactEmail?: string;
  contact_email?: string;
  contactPhone?: string;
  contactMobile?: string;
}

export interface ExistingSurveyVisit {
  id: string | number;
  version?: number | null;
  updated_at?: string | null;
  design_visit_id?: number | string | null;
  visit_date?: string;
  duration_min?: number;
  location?: string;
  structuredAddress?: StructuredAddress;
  handle_id?: string | number | null;
  furniture_range_id?: string | number | null;
  notes?: string;
  terms_accepted?: boolean;
  rooms?: Array<{
    id?: number | string;
    source_design_visit_room_id?: number | string | null;
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

export interface SurveyVisitWizardProps {
  handler: SurveyVisitWizardHandler;
  ctx: SurveyVisitWizardCtx;
  existingVisit?: ExistingSurveyVisit | null;
  onClose: () => void;
  onCatalogueReady?: () => void;
  /** Read-only demo mode: no API calls, no draft storage, no writes. */
  demo?: boolean;
}

interface PairingRow { door_id: number | null; handle_id: number | null }

interface PrefillResponse {
  designVisitId?: number | string | null;
  handleId?: number | string | null;
  furnitureRangeId?: number | string | null;
  durationMin?: number | null;
  structuredAddress?: StructuredAddress | null;
  location?: string | null;
  notes?: string | null;
  rooms?: Array<{
    sourceDesignVisitRoomId?: number | string | null;
    roomName?: string;
    doorStyleId?: number | string | null;
    widthMm?: number | null;
    heightMm?: number | null;
    depthMm?: number | null;
    unitCount?: number | null;
    unitPricePence?: number | null;
    notes?: string | null;
    images?: Array<{ storageKey?: string; mimeType?: string | null; viewUrl?: string }>;
  }>;
}

function makeDefaultStep1(defaultDuration: number, existingVisit?: ExistingSurveyVisit | null): Step1Data {
  const s: Step1Data = {
    visitDate: existingVisit ? '' : nowDateTime(),
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
    const m = String(ev.notes).match(/^Surveyor:\s*(.+)$/);
    if (m) s.designerName = m[1].trim();
  }
  s.termsAccepted = !!ev.terms_accepted;
  return s;
}

function emptyRoom(): RoomData {
  return { roomName: '', doorStyleId: '', widthMm: null, heightMm: null, depthMm: null, unitCount: 1, unitPricePence: 0, notes: '', images: [], answers: {} };
}

function normaliseRooms(existingVisit?: ExistingSurveyVisit | null): RoomData[] {
  if (!existingVisit?.rooms?.length) return [emptyRoom()];
  return existingVisit.rooms.map(r => ({
    roomName:       r.room_name || r.roomName || '',
    doorStyleId:    String(r.door_style_id ?? r.doorStyleId ?? ''),
    widthMm:        r.width_mm  ?? r.widthMm  ?? null,
    heightMm:       r.height_mm ?? r.heightMm ?? null,
    depthMm:        r.depth_mm  ?? r.depthMm  ?? null,
    unitCount:      Math.max(1, parseInt(String(r.unit_count ?? r.unitCount ?? 1), 10) || 1),
    unitPricePence: Math.max(0, parseInt(String(r.unit_price_pence ?? r.unitPricePence ?? 0), 10) || 0),
    notes:          r.notes || '',
    sourceDesignVisitRoomId: r.source_design_visit_room_id ?? null,
    images:         Array.isArray(r.images) ? r.images.map(i => ({
      storageKey: i.storageKey || i.storage_key || '',
      mimeType:   i.mimeType   || i.mime_type   || null,
      viewUrl:    i.viewUrl    || i.view_url    || '',
    })) : [],
    answers:        {},
  }));
}

function roomsFromPrefill(pf: PrefillResponse): RoomData[] {
  if (!pf.rooms?.length) return [emptyRoom()];
  return pf.rooms.map(r => ({
    roomName:       r.roomName || '',
    doorStyleId:    r.doorStyleId != null ? String(r.doorStyleId) : '',
    widthMm:        r.widthMm  ?? null,
    heightMm:       r.heightMm ?? null,
    depthMm:        r.depthMm  ?? null,
    unitCount:      Math.max(1, parseInt(String(r.unitCount ?? 1), 10) || 1),
    unitPricePence: Math.max(0, parseInt(String(r.unitPricePence ?? 0), 10) || 0),
    notes:          r.notes || '',
    sourceDesignVisitRoomId: r.sourceDesignVisitRoomId ?? null,
    images:         Array.isArray(r.images) ? r.images.map(i => ({
      storageKey: i.storageKey || '',
      mimeType:   i.mimeType   || null,
      viewUrl:    i.viewUrl    || '',
    })) : [],
    answers:        {},
  }));
}

function draftKey(contactId: string, editId?: string | number | null): string {
  if (editId) return SV_WIZARD_DRAFT_EDIT_PREFIX + editId;
  return SV_WIZARD_DRAFT_PREFIX + (contactId || 'new');
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

/** See DesignVisitWizard.extractOrphanedDraftKeys for the rationale. */
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

type Phase = 'deciding' | 'hub' | 'refund' | 'wizard';

export function SurveyVisitWizard({ handler, ctx, existingVisit, onClose, onCatalogueReady, demo }: SurveyVisitWizardProps) {
  const cfg = handler.config || {};
  const defaultDuration = cfg.defaultDurationMin || 90;
  const contactId     = ctx.contactId    || ctx.contact_id    || '';
  const contactName   = ctx.contactName  || ctx.contact_name  || '';
  const contactEmail  = ctx.contactEmail || ctx.contact_email || '';
  const contactPhone  = ctx.contactPhone  || '';
  const contactMobile = ctx.contactMobile || '';
  const editMode     = !!(existingVisit && existingVisit.id);
  const editVisitId  = editMode ? existingVisit!.id : null;
  const storageKey   = draftKey(contactId, editVisitId);

  const [open, setOpen] = useState(true);
  const [phase, setPhase] = useState<Phase>(() => (editMode || demo ? 'wizard' : 'deciding'));
  const [step, setStep] = useState(1);
  const [showDiscardDialog, setShowDiscardDialog] = useState(false);

  const [orphanedDraftKeys] = useState<string[]>(() =>
    editMode || demo ? [] : extractOrphanedDraftKeys(storageKey)
  );

  // Whether a usable draft existed at mount. When true we restore it and skip
  // continuation pre-fill; when false (new visit) we pre-fill from the
  // signed-off design visit.
  const hadDraftAtMount = useRef<boolean>(
    !editMode && !demo && orphanedDraftKeys.length === 0 && loadDraft(storageKey) !== null
  );

  const [showDraftNotice, setShowDraftNotice] = useState<boolean>(() => hadDraftAtMount.current);

  const [step1, setStep1] = useState<Step1Data>(() => {
    if (demo) return { ...DEMO_STEP1 };
    if (!editMode && orphanedDraftKeys.length === 0) {
      const draft = loadDraft(storageKey);
      if (draft) return draft.step1;
    }
    return makeDefaultStep1(defaultDuration, existingVisit);
  });

  const [rooms, setRooms] = useState<RoomData[]>(() => {
    if (demo) return DEMO_ROOMS.map((r, i) => ({ ...r, answers: DEMO_SURVEY_ROOM_ANSWERS[i] ?? {} }));
    if (!editMode && orphanedDraftKeys.length === 0) {
      const draft = loadDraft(storageKey);
      if (draft) return draft.rooms;
    }
    return normaliseRooms(existingVisit);
  });

  const [designVisitId, setDesignVisitId] = useState<number | string | null>(
    existingVisit?.design_visit_id ?? null
  );

  const [visitQuestions, setVisitQuestions] = useState<VisitQuestion[]>(demo ? DEMO_SURVEY_VISIT_QUESTIONS : []);
  const [roomQuestions, setRoomQuestions] = useState<VisitQuestion[]>(demo ? DEMO_SURVEY_ROOM_QUESTIONS : []);
  const [showRoomAnswerValidation, setShowRoomAnswerValidation] = useState(false);
  const [s2Error, setS2Error] = useState('');
  const [answers, setAnswers] = useState<AnswerMap>(() => {
    if (demo) return { ...DEMO_SURVEY_VISIT_ANSWERS };
    if (!editMode && orphanedDraftKeys.length === 0) {
      const draft = loadDraft(storageKey);
      if (draft?.answers) return draft.answers;
    }
    return {};
  });

  const [handles, setHandles]                 = useState<CatalogueItem[]>(demo ? DEMO_HANDLES : []);
  const [furnitureRanges, setFurnitureRanges] = useState<CatalogueItem[]>(demo ? DEMO_FURNITURE_RANGES : []);
  const [doorStyles, setDoorStyles]           = useState<DoorStyleOption[]>(demo ? DEMO_DOOR_STYLES : []);
  const [pairings, setPairings]               = useState<PairingRow[]>([]);
  const [termsText, setTermsText]             = useState(demo ? DEMO_TERMS_TEXT : '');
  const [termsVersionNumber, setTermsVersionNumber] = useState<number | null>(null);
  const [catalogueLoading, setCatalogueLoading] = useState(!demo);

  const [visitNotesTimestamp, setVisitNotesTimestamp] = useState('');

  const [s1Error, setS1Error]       = useState('');
  const [showAnswerValidation, setShowAnswerValidation] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [uploading, setUploading]   = useState(false);

  // Refund flow state.
  const [refundReason, setRefundReason] = useState('');
  const [refundAmount, setRefundAmount] = useState('');
  const [refundInvoiceRef, setRefundInvoiceRef] = useState('');
  const [refundSubmitting, setRefundSubmitting] = useState(false);
  const [refundError, setRefundError] = useState('');

  const { showToast, showToastWithAction } = useToastContext();

  const intermediateStatusFiredRef = useRef(false);

  const initialStep1Ref = useRef<Step1Data>(makeDefaultStep1(defaultDuration, existingVisit));
  const initialRoomsRef = useRef<RoomData[]>(normaliseRooms(existingVisit));

  const pendingUploadKeysRef = useRef<Set<string>>(new Set());
  const committedRef = useRef(false);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (undoTimerRef.current !== null) {
        clearTimeout(undoTimerRef.current);
        undoTimerRef.current = null;
      }
    };
  }, []);

  // Suggested handle derived from the chosen door styles via catalog_pairings.
  const handleSuggestion = useMemo<CatalogueSuggestion | null>(() => {
    if (!pairings.length || !handles.length) return null;
    for (const r of rooms) {
      const did = r.doorStyleId ? parseInt(r.doorStyleId, 10) : NaN;
      if (!Number.isFinite(did)) continue;
      const p = pairings.find(pr => pr.door_id === did && pr.handle_id != null);
      if (p) {
        const h = handles.find(hi => String(hi.id) === String(p.handle_id));
        if (h) return { id: String(h.id), name: h.name };
      }
    }
    return null;
  }, [pairings, handles, rooms]);

  useEffect(() => {
    if (demo) { onCatalogueReady?.(); return; }
    let cancelled = false;
    // Pre-fill visit notes from HubSpot on a fresh new-visit open only.
    // Skip when editing an existing visit or when a draft was already restored
    // (the draft preserves whatever the user typed previously).
    if (!editMode && !hadDraftAtMount.current && contactId) {
      fetch('/api/card-actions/start-design-visit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId }),
      })
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          if (!d || cancelled) return;
          if (d.visitNotes) {
            setStep1(prev => ({ ...prev, visitNotes: d.visitNotes }));
            setVisitNotesTimestamp(d.visitNotesTimestamp || '');
          }
        })
        .catch(() => { /* best-effort — notes stay empty on any error */ });
    }
    async function load() {
      try {
        const [h, fr, ds, pr] = await Promise.all([
          fetch('/api/catalog/handles').then(r => r.ok ? r.json() : []),
          fetch('/api/catalog/ranges').then(r => r.ok ? r.json() : []),
          fetch('/api/catalog/doors').then(r => r.ok ? r.json() : []),
          fetch('/api/catalog/pairings').then(r => r.ok ? r.json() : []),
        ]);
        if (!cancelled) { setHandles(h); setFurnitureRanges(fr); setDoorStyles(ds); setPairings(Array.isArray(pr) ? pr : []); }
      } catch {}
      try {
        const qr = await fetch('/api/visit-questions?applies_to=survey');
        if (!cancelled && qr.ok) {
          const all: VisitQuestion[] = await qr.json();
          const list = Array.isArray(all) ? all : [];
          setVisitQuestions(list.filter(q => q.scope === 'visit'));
          setRoomQuestions(list.filter(q => q.scope === 'room'));
        }
      } catch {}

      // Continuation pre-fill — only for a brand-new visit with no restored draft.
      if (!editMode && !hadDraftAtMount.current) {
        try {
          const pf = await fetch(`/api/survey-visits/prefill?contactId=${encodeURIComponent(contactId)}`);
          if (!cancelled && pf.ok) {
            const data: PrefillResponse = await pf.json();
            setDesignVisitId(data.designVisitId ?? null);
            setStep1(prev => {
              const next = { ...prev };
              if (data.handleId != null) next.handleId = String(data.handleId);
              if (data.furnitureRangeId != null) next.furnitureRangeId = String(data.furnitureRangeId);
              if (data.durationMin) next.duration = String(data.durationMin);
              if (data.structuredAddress && !isAddressEmpty(data.structuredAddress)) {
                next.structuredAddress = data.structuredAddress;
              } else if (data.location) {
                next.structuredAddress = { ...emptyAddress(), addressLines: [String(data.location)] };
              }
              return next;
            });
            const pfRooms = roomsFromPrefill(data);
            setRooms(pfRooms);
          }
        } catch {}
      }

      // Edit-mode answers hydration.
      if (editMode && editVisitId != null) {
        try {
          const ar = await fetch(`/api/survey-visits/${encodeURIComponent(String(editVisitId))}/answers`);
          if (!cancelled && ar.ok) {
            const rows: Array<{ question_id: number; room_id: number | null; answer: AnswerMap[number] }> = await ar.json();
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
                const injected = initialRoomsRef.current.map((r, i) => {
                  const rid = (evRooms[i] as { id?: number | string } | undefined)?.id;
                  const a = rid != null ? perRoomById[Number(rid)] : undefined;
                  return a ? { ...r, answers: { ...(r.answers || {}), ...a } } : r;
                });
                setRooms(injected);
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

      // Decide whether to show the refund hub. The refund option is available
      // only while the lead is still scheduled — once it is in progress
      // (intermediate status) we go straight into the wizard.
      if (!cancelled && !editMode) {
        let leadStatus = '';
        try {
          const cr = await fetch(`/api/contacts/${encodeURIComponent(contactId)}`);
          if (cr.ok) {
            const cd = await cr.json();
            leadStatus = String(cd?.hs_lead_status || cd?.properties?.hs_lead_status || '');
          }
        } catch {}
        if (!cancelled) {
          const inProgress = !!cfg.intermediateLeadStatus && leadStatus === cfg.intermediateLeadStatus;
          setPhase(inProgress ? 'wizard' : 'hub');
        }
      }

      if (!cancelled) {
        setCatalogueLoading(false);
        onCatalogueReady?.();
      }
    }
    load();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fire the intermediate lead-status transition once the user actually starts
  // the wizard (not while on the hub, and never if they pick refund).
  useEffect(() => {
    if (demo || editMode) return;
    if (phase !== 'wizard') return;
    if (cfg.intermediateLeadStatus && contactId && !intermediateStatusFiredRef.current) {
      intermediateStatusFiredRef.current = true;
      fetch(`/api/contacts/${encodeURIComponent(contactId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hs_lead_status: cfg.intermediateLeadStatus }),
      }).then(() => {
        broadcastLeadStatusChange(contactId, { hs_lead_status: cfg.intermediateLeadStatus });
      }).catch(e => console.warn('[survey-visit] intermediate lead status update failed:', e.message));
    }
  }, [phase, editMode, cfg.intermediateLeadStatus, contactId, demo]);

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

  // Orphan-recovery — delete stranded uploads from an interrupted prior session.
  useEffect(() => {
    if (!orphanedDraftKeys.length) return;
    for (const key of orphanedDraftKeys) {
      fetch(SURVEY_ENDPOINTS.deleteUrl(key), { method: 'DELETE' })
        .catch(err => console.warn('[survey-visit] orphan-recovery delete failed:', err));
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
        fetch(SURVEY_ENDPOINTS.deleteUrl(key), { method: 'DELETE' })
          .catch(err => console.warn('[survey-visit] abandon-cleanup delete failed:', err));
      }
    };
  }, []);

  function hasUnsavedDraftData(): boolean {
    const step1Touched =
      step1.termsAccepted ||
      step1.visitDate.trim() !== '' ||
      step1.designerName.trim() !== '' ||
      !isAddressEmpty(step1.structuredAddress) ||
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
    if (!demo && !committedRef.current && phase === 'wizard') {
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
  }, [demo, editMode, phase, step1, rooms, doClose]); // eslint-disable-line react-hooks/exhaustive-deps

  function advanceToStep2() {
    if (!demo && !step1.termsAccepted) {
      setS1Error('Please confirm the customer has accepted the terms and conditions.');
      return;
    }
    if (!demo && missingRequired(visitQuestions, answers).length > 0) {
      setShowAnswerValidation(true);
      setS1Error('Please answer all required questions before continuing.');
      return;
    }
    setShowAnswerValidation(false);
    setS1Error('');
    setStep(2);
  }

  async function handleSubmit() {
    setSubmitting(true);
    setSubmitError('');
    try {
      const payload = {
        contactId,
        contactName,
        contactEmail,
        designVisitId:    designVisitId || undefined,
        handleId:         step1.handleId         || undefined,
        furnitureRangeId: step1.furnitureRangeId  || undefined,
        visitDate:        step1.visitDate         || undefined,
        durationMin:      parseInt(step1.duration, 10) || defaultDuration,
        structuredAddress: step1.structuredAddress,
        notes:            step1.designerName ? `Surveyor: ${step1.designerName}` : undefined,
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
          sourceDesignVisitRoomId: r.sourceDesignVisitRoomId || undefined,
          images:         (r.images || []).map(img => ({
            storageKey: img.storageKey,
            mimeType:   img.mimeType,
          })),
          answers: roomQuestions
            .filter(q => r.answers?.[q.id] !== undefined)
            .map(q => ({ question_id: q.id, answer: r.answers![q.id] })),
        })),
        handlerConfig: cfg,
        answers: visitQuestions
          .filter(q => answers[q.id] !== undefined)
          .map(q => ({ question_id: q.id, answer: answers[q.id] })),
      };
      const url    = editMode ? `/api/survey-visits/${encodeURIComponent(String(editVisitId))}` : '/api/survey-visits';
      const method = editMode ? 'PUT' : 'POST';
      // Offline-aware submit. When offline / on a network error the survey visit
      // is queued and replayed (with its side effects — sign-off email, QB
      // estimate) once connectivity returns. Edit-mode updates carry a
      // conflict-check URL so a stale overwrite is logged for Phase 3 review.
      const { sendOrQueue } = await import('../lib/offlineQueue');
      const res = await sendOrQueue({
        area: 'visit',
        label: editMode ? `Edit survey visit — ${contactName || contactId}` : `Survey visit — ${contactName || contactId}`,
        method,
        url,
        body: payload,
        ...(editMode
          ? {
              conflictCheckUrl: `/api/survey-visits/${encodeURIComponent(String(editVisitId))}`,
              recordKey: `sv:${editVisitId}`,
              dedupeKey: `sv:${editVisitId}`,
              baseVersion: existingVisit?.version ?? null,
              baseUpdatedAt: existingVisit?.updated_at ?? null,
            }
          : {}),
        // When queued offline, carry calendar metadata so the sync engine can
        // create the event after replay — mirroring the online-submission path.
        ...(!editMode && step1.visitDate
          ? {
              calendarMeta: {
                summary: `Survey visit — ${contactName || contactId}`,
                description: step1.designerName ? `Surveyor: ${step1.designerName}` : '',
                location: formatAddress(step1.structuredAddress),
                visitDate: step1.visitDate,
                durationMins: parseInt(step1.duration, 10) || defaultDuration,
                moContactId: contactId ? String(contactId) : undefined,
                moVisitType: 'survey' as const,
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
      if (!res.queued && !editMode && cfg.submittedLeadStatus && contactId) {
        broadcastLeadStatusChange(contactId, { hs_lead_status: cfg.submittedLeadStatus });
      }
      setOpen(false);

      // Best-effort calendar event (new visits only, when online and visitDate is set).
      let calendarCreated = false;
      if (!res.queued && !editMode && step1.visitDate) {
        try {
          const start = new Date(step1.visitDate);
          const durationMins = parseInt(step1.duration, 10) || defaultDuration;
          const end = new Date(start.getTime() + durationMins * 60000);
          await POST('/api/events', {
            summary: `Survey visit — ${contactName || contactId}`,
            description: step1.designerName ? `Surveyor: ${step1.designerName}` : '',
            location: formatAddress(step1.structuredAddress),
            start: { dateTime: start.toISOString() },
            end: { dateTime: end.toISOString() },
            moContactId: contactId ? String(contactId) : undefined,
            moVisitType: 'survey',
          });
          calendarCreated = true;
        } catch { /* calendar is best-effort */ }
      }

      setTimeout(() => {
        onClose();
        const baseMsg = res.queued
          ? (editMode
              ? "Survey visit saved offline — it'll sync and send the sign-off email when you're back online."
              : "Survey visit saved offline — it'll submit and send the sign-off email when you're back online.")
          : (editMode
              ? 'Survey visit updated. A fresh sign-off email has been sent.'
              : 'Survey visit submitted. Customer sign-off email sent.');
        const successMsg = (!res.queued && !editMode && step1.visitDate && calendarCreated)
          ? `${baseMsg} Calendar event created.`
          : baseMsg;
        showToast(successMsg, false);
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

  async function handleRefundSubmit() {
    const reasonTrimmed = refundReason.trim();
    if (!reasonTrimmed) {
      setRefundError('Please enter a reason for the refund request.');
      return;
    }
    const amountRaw = refundAmount.trim();
    if (!amountRaw) {
      setRefundError('Please enter a refund amount.');
      return;
    }
    const parsedAmount = parseFloat(amountRaw);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setRefundError('Please enter a valid refund amount greater than zero.');
      return;
    }
    if (!contactId) {
      setRefundError('Contact ID is missing — cannot submit refund request.');
      return;
    }
    setRefundSubmitting(true);
    setRefundError('');
    try {
      const amountPence = Math.round(parsedAmount * 100);
      const body = {
        contactId,
        contactName,
        contactEmail,
        designVisitId: designVisitId || undefined,
        surveyVisitId: editVisitId != null ? Number(editVisitId) : undefined,
        reason: reasonTrimmed,
        amountPence,
        depositInvoiceRef: refundInvoiceRef.trim() || undefined,
        handlerConfig: cfg,
      };
      const { sendOrQueue } = await import('../lib/offlineQueue');
      const res = await sendOrQueue({
        area: 'visit',
        label: `Refund request — ${contactName || contactId}`,
        method: 'POST',
        url: '/api/survey-visits/refund',
        body,
      });
      if (!res.queued && !res.ok) {
        const d = res.data as { error?: string } | undefined;
        throw new Error(d?.error || 'Could not record refund request.');
      }
      committedRef.current = true;
      clearDraft(storageKey);
      setOpen(false);
      setTimeout(() => {
        onClose();
        const msg = res.queued
          ? "Refund request saved offline — it'll be sent when you're back online."
          : 'Refund request recorded. An admin has been notified.';
        const w = window as unknown as Record<string, unknown>;
        if (typeof w['toast'] === 'function') (w['toast'] as (m: string) => void)(msg);
        else if (typeof w['showToast'] === 'function') (w['showToast'] as (m: string) => void)(msg);
        else alert(msg);
      }, 300);
    } catch (e: unknown) {
      setRefundError(e instanceof Error ? e.message : 'Could not record refund request. Please try again.');
      setRefundSubmitting(false);
    }
  }

  const title = demo
    ? 'Survey Visit'
    : editMode
    ? 'Edit Survey Visit'
    : (contactName ? `Survey Visit — ${contactName}` : 'Survey Visit');

  const stepLabel = step === 1 ? 'Step 1 of 3 — Visit details'
                  : step === 2 ? 'Step 2 of 3 — Rooms'
                  : 'Step 3 of 3 — Review & submit';

  // ── Decision / hub / refund screens ─────────────────────────────────────────
  if (phase === 'deciding') {
    return (
      <FullScreenModal open={open} onClose={doClose} title="Survey Visit" centerContent>
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      </FullScreenModal>
    );
  }

  if (phase === 'hub') {
    return (
      <FullScreenModal
        open={open}
        onClose={doClose}
        title={contactName ? `Survey Visit — ${contactName}` : 'Survey Visit'}
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 520, mx: 'auto', py: 1 }}>
          <Typography sx={{ fontSize: '.95rem', color: 'var(--neutral-700)' }}>
            How would you like to proceed with this customer?
          </Typography>
          <Button
            variant="contained"
            onClick={() => { setPhase('wizard'); setStep(1); }}
            sx={{
              background: BRAND_COLORS.orchid, fontWeight: 600, textTransform: 'none', py: 1.25,
              '&:hover': { background: BRAND_COLORS.orchidPress },
            }}
          >
            Start survey visit
          </Button>
          <Button
            variant="outlined"
            onClick={() => { setRefundError(''); setPhase('refund'); }}
            sx={{
              borderColor: 'var(--neutral-300)', color: 'var(--neutral-700)', fontWeight: 600,
              textTransform: 'none', py: 1.25,
              '&:hover': { borderColor: 'var(--neutral-400)', background: 'var(--neutral-50)' },
            }}
          >
            Customer changed their mind — refund
          </Button>
        </Box>
      </FullScreenModal>
    );
  }

  if (phase === 'refund') {
    return (
      <FullScreenModal
        open={open}
        onClose={doClose}
        title="Refund request"
        footer={
          <>
            <Button
              onClick={() => setPhase('hub')}
              variant="outlined"
              disabled={refundSubmitting}
              sx={{
                borderColor: 'var(--neutral-300)', color: 'var(--neutral-700)', fontWeight: 600,
                textTransform: 'none',
                '&:hover': { borderColor: 'var(--neutral-400)', background: 'var(--neutral-50)' },
              }}
            >
              ← Back
            </Button>
            <Button
              onClick={handleRefundSubmit}
              variant="contained"
              disabled={refundSubmitting}
              startIcon={refundSubmitting ? <CircularProgress size={16} color="inherit" /> : undefined}
              sx={{
                background: 'error.main', fontWeight: 600, textTransform: 'none',
                '&:hover': { background: 'error.dark' },
              }}
            >
              {refundSubmitting ? 'Submitting…' : 'Submit refund request'}
            </Button>
          </>
        }
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 520, mx: 'auto', py: 1 }}>
          <Typography sx={{ fontSize: '.9rem', color: 'var(--neutral-700)' }}>
            Record that {contactName || 'this customer'} has changed their mind. This notifies an
            admin to process the refund and updates the lead status.
          </Typography>
          <TextField
            label="Reason"
            multiline
            minRows={3}
            fullWidth
            size="small"
            value={refundReason}
            onChange={e => setRefundReason(e.target.value)}
            slotProps={{ htmlInput: { maxLength: 2000 } }}
          />
          <TextField
            label="Refund amount (£)"
            fullWidth
            size="small"
            type="number"
            value={refundAmount}
            onChange={e => setRefundAmount(e.target.value)}
            slotProps={{ htmlInput: { min: 0, step: '0.01' } }}
          />
          <TextField
            label="Deposit invoice reference (optional)"
            fullWidth
            size="small"
            value={refundInvoiceRef}
            onChange={e => setRefundInvoiceRef(e.target.value)}
            slotProps={{ htmlInput: { maxLength: 200 } }}
          />
          {refundError && (
            <Typography sx={{ color: 'error.dark', fontSize: '.82rem' }}>{refundError}</Typography>
          )}
        </Box>
      </FullScreenModal>
    );
  }

  // ── Wizard ──────────────────────────────────────────────────────────────────
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
            Next: Rooms →
          </Button>
        )}

        {step === 2 && (
          <Button
            variant="contained"
            onClick={() => {
              if (rooms.some(r => !r.roomName.trim()) || !rooms.length) return;
              if (!demo && roomQuestions.length > 0) {
                const anyMissing = rooms.some(r => missingRequired(roomQuestions, r.answers || {}).length > 0);
                if (anyMissing) {
                  setShowRoomAnswerValidation(true);
                  setS2Error('Please answer all required questions for each room before continuing.');
                  return;
                }
              }
              setShowRoomAnswerValidation(false);
              setS2Error('');
              setStep(3);
            }}
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
      loading={catalogueLoading}
      draftNotice={showDraftNotice}
      onDismissDraftNotice={() => setShowDraftNotice(false)}
      step={step}
      totalSteps={3}
      stepLabel={stepLabel}
    >
      {step === 1 && (
        <>
          <DesignVisitStep1
            initialData={step1}
            handles={handles}
            furnitureRanges={furnitureRanges}
            termsText={termsText}
            termsVersionNumber={termsVersionNumber}
            onDataChange={setStep1}
            nameLabel="Surveyor name"
            namePlaceholder="e.g. Sarah Jones"
            addressIdPrefix="sv-step1-address"
            addressSurface="genericVisit"
            handleSuggestion={handleSuggestion}
            visitNotesTimestamp={visitNotesTimestamp || undefined}
            onVisitNotesEdited={() => setVisitNotesTimestamp('')}
          />
          {visitQuestions.length > 0 && (
            <Box sx={{ mt: '24px' }}>
              <QuestionnaireRenderer
                questions={visitQuestions}
                answers={answers}
                onChange={(id, value) => setAnswers(prev => ({ ...prev, [id]: value }))}
                showValidation={showAnswerValidation}
              />
            </Box>
          )}
        </>
      )}

      {step === 2 && (
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
          endpoints={SURVEY_ENDPOINTS}
        />
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
              const savedStep1 = step1;
              const savedRooms = rooms;
              const savedAnswers = answers;

              if (!editMode) clearDraft(storageKey);

              setShowDiscardDialog(false);
              setOpen(false);

              if (undoTimerRef.current !== null) {
                clearTimeout(undoTimerRef.current);
              }

              undoTimerRef.current = setTimeout(() => {
                undoTimerRef.current = null;
                onClose();
              }, 6200);

              showToastWithAction(
                editMode ? 'Changes discarded' : 'Draft discarded',
                {
                  label: 'Undo',
                  onClick: () => {
                    if (undoTimerRef.current !== null) {
                      clearTimeout(undoTimerRef.current);
                      undoTimerRef.current = null;
                    }
                    if (!editMode) {
                      saveDraft(storageKey, savedStep1, savedRooms, savedAnswers);
                    } else {
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

export default SurveyVisitWizard;
