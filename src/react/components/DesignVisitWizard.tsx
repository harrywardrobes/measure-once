import React, { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import { DesignVisitStep1, type Step1Data, type CatalogueItem } from './DesignVisitStep1';
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
}

export interface ExistingVisit {
  id: string | number;
  visit_date?: string;
  duration_min?: number;
  location?: string;
  handle_id?: string | number | null;
  furniture_range_id?: string | number | null;
  notes?: string;
  terms_accepted?: boolean;
  rooms?: Array<{
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
}

function makeDefaultStep1(defaultDuration: number, existingVisit?: ExistingVisit | null): Step1Data {
  const s: Step1Data = {
    visitDate: '',
    duration: String(defaultDuration),
    location: '',
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
  if (ev.location) s.location = String(ev.location);
  if (ev.handle_id != null) s.handleId = String(ev.handle_id);
  if (ev.furniture_range_id != null) s.furnitureRangeId = String(ev.furniture_range_id);
  if (ev.notes) {
    const m = String(ev.notes).match(/^Designer:\s*(.+)$/);
    if (m) s.designerName = m[1].trim();
  }
  s.termsAccepted = !!ev.terms_accepted;
  return s;
}

function normaliseRooms(existingVisit?: ExistingVisit | null): RoomData[] {
  if (!existingVisit?.rooms?.length) {
    return [{ roomName: '', doorStyleId: '', widthMm: null, heightMm: null, depthMm: null, unitCount: 1, unitPricePence: 0, notes: '', images: [] }];
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
  }));
}

function draftKey(contactId: string, editId?: string | number | null): string {
  if (editId) return `dv-wizard-draft-edit-${editId}`;
  return `dv-wizard-draft-${contactId || 'new'}`;
}

function saveDraft(key: string, step1: Step1Data, rooms: RoomData[]) {
  try { sessionStorage.setItem(key, JSON.stringify({ step1, rooms })); } catch {}
}

function loadDraft(key: string): { step1: Step1Data; rooms: RoomData[] } | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function clearDraft(key: string) {
  try { sessionStorage.removeItem(key); } catch {}
}

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <Box sx={{ display: 'flex', gap: '6px', mb: '20px' }}>
      {Array.from({ length: total }, (_, i) => (
        <Box
          key={i}
          sx={{
            flex: 1,
            height: '4px',
            borderRadius: '2px',
            background: i + 1 <= current ? '#8B2BFF' : '#e5e7eb',
            transition: 'background .2s',
          }}
        />
      ))}
    </Box>
  );
}

export function DesignVisitWizard({ handler, ctx, existingVisit, onClose }: DesignVisitWizardProps) {
  const cfg = handler.config || {};
  const defaultDuration = cfg.defaultDurationMin || 90;
  const contactId    = ctx.contactId    || ctx.contact_id    || '';
  const contactName  = ctx.contactName  || ctx.contact_name  || '';
  const contactEmail = ctx.contactEmail || ctx.contact_email || '';
  const editMode     = !!(existingVisit && existingVisit.id);
  const editVisitId  = editMode ? existingVisit!.id : null;
  const storageKey   = draftKey(contactId, editVisitId);

  const [open, setOpen] = useState(true);
  const [step, setStep] = useState(1);

  const [step1, setStep1] = useState<Step1Data>(() => {
    if (!editMode) {
      const draft = loadDraft(storageKey);
      if (draft) return draft.step1;
    }
    return makeDefaultStep1(defaultDuration, existingVisit);
  });

  const [rooms, setRooms] = useState<RoomData[]>(() => {
    if (!editMode) {
      const draft = loadDraft(storageKey);
      if (draft) return draft.rooms;
    }
    return normaliseRooms(existingVisit);
  });

  const [handles, setHandles]               = useState<CatalogueItem[]>([]);
  const [furnitureRanges, setFurnitureRanges] = useState<CatalogueItem[]>([]);
  const [doorStyles, setDoorStyles]           = useState<DoorStyleOption[]>([]);
  const [termsText, setTermsText]             = useState('');
  const [termsVersionNumber, setTermsVersionNumber] = useState<number | null>(null);
  const [catalogueLoading, setCatalogueLoading] = useState(true);

  const [s1Error, setS1Error]       = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [uploading, setUploading]   = useState(false);

  const intermediateStatusFiredRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [h, fr, ds] = await Promise.all([
          fetch('/api/design-visit-handles').then(r => r.ok ? r.json() : []),
          fetch('/api/design-visit-furniture-ranges').then(r => r.ok ? r.json() : []),
          fetch('/api/design-visit-door-styles').then(r => r.ok ? r.json() : []),
        ]);
        if (!cancelled) { setHandles(h); setFurnitureRanges(fr); setDoorStyles(ds); }
      } catch {}
      try {
        const tr = await fetch('/api/design-visit-terms');
        if (!cancelled && tr.ok) {
          const td = await tr.json();
          setTermsText(td.terms || '');
          setTermsVersionNumber(td.versionNumber ?? null);
        }
      } catch {}
      if (!cancelled) setCatalogueLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!editMode && cfg.intermediateLeadStatus && contactId && !intermediateStatusFiredRef.current) {
      intermediateStatusFiredRef.current = true;
      fetch(`/api/contacts/${encodeURIComponent(contactId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hs_lead_status: cfg.intermediateLeadStatus }),
      }).catch(e => console.warn('[design-visit] intermediate lead status update failed:', e.message));
    }
  }, [editMode, cfg.intermediateLeadStatus, contactId]);

  useEffect(() => {
    const channels: BroadcastChannel[] = [];
    for (const name of ['design_visit_handles_changed', 'design_visit_furniture_ranges_changed', 'design_visit_door_styles_changed']) {
      try {
        const ch = new BroadcastChannel(name);
        ch.addEventListener('message', async () => {
          try {
            const [h, fr, ds] = await Promise.all([
              fetch('/api/design-visit-handles').then(r => r.ok ? r.json() : handles),
              fetch('/api/design-visit-furniture-ranges').then(r => r.ok ? r.json() : furnitureRanges),
              fetch('/api/design-visit-door-styles').then(r => r.ok ? r.json() : doorStyles),
            ]);
            setHandles(h); setFurnitureRanges(fr); setDoorStyles(ds);
          } catch {}
        });
        channels.push(ch);
      } catch {}
    }
    return () => { channels.forEach(ch => { try { ch.close(); } catch {} }); };
  }, []);

  useEffect(() => {
    if (!editMode) saveDraft(storageKey, step1, rooms);
  }, [step1, rooms, editMode, storageKey]);

  const handleClose = useCallback(() => {
    setOpen(false);
    setTimeout(onClose, 300);
  }, [onClose]);

  function advanceToStep2() {
    if (!step1.termsAccepted) {
      setS1Error('Please confirm the customer has accepted the terms and conditions.');
      return;
    }
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
        handleId:         step1.handleId         || undefined,
        furnitureRangeId: step1.furnitureRangeId  || undefined,
        visitDate:        step1.visitDate         || undefined,
        durationMin:      parseInt(step1.duration, 10) || defaultDuration,
        location:         step1.location          || undefined,
        notes:            step1.designerName ? `Designer: ${step1.designerName}` : undefined,
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
        })),
        handlerConfig: cfg,
      };
      const url    = editMode ? `/api/design-visits/${encodeURIComponent(String(editVisitId))}` : '/api/design-visits';
      const method = editMode ? 'PUT' : 'POST';
      const resp = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || (editMode ? 'Save failed' : 'Submission failed'));
      clearDraft(storageKey);
      setOpen(false);
      setTimeout(() => {
        onClose();
        const msg = editMode
          ? 'Design visit updated. A fresh sign-off email has been sent.'
          : 'Design visit submitted. Customer sign-off email sent.';
        const w = window as unknown as Record<string, unknown>;
        if (typeof w['toast'] === 'function') {
          (w['toast'] as (m: string) => void)(msg);
        } else if (typeof w['showToast'] === 'function') {
          (w['showToast'] as (m: string) => void)(msg);
        } else {
          alert(msg);
        }
        if (typeof w['renderDesignVisits'] === 'function') {
          try { (w['renderDesignVisits'] as () => void)(); } catch {}
        }
      }, 300);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : (editMode ? 'Save failed. Please try again.' : 'Submission failed. Please try again.');
      setSubmitError(msg);
      setSubmitting(false);
    }
  }

  const title = editMode
    ? 'Edit Design Visit'
    : (contactName ? `Design Visit — ${contactName}` : 'Design Visit');

  const stepLabel = step === 1 ? 'Step 1 of 3 — Visit details'
                  : step === 2 ? 'Step 2 of 3 — Rooms'
                  : 'Step 3 of 3 — Review & submit';

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={handleClose}
      slotProps={{ paper: { sx: { width: 'min(680px, 100vw)', display: 'flex', flexDirection: 'column' }, className: 'dv-wizard' } }}
    >
      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: '24px',
          pt: '18px',
          pb: '14px',
          borderBottom: '1px solid #e5e7eb',
          flexShrink: 0,
        }}
      >
        <Typography sx={{ fontWeight: 700, fontSize: '1.1rem', color: '#1f2937' }}>
          {title}
        </Typography>
        <IconButton onClick={handleClose} size="small" aria-label="Close" sx={{ color: '#9ca3af' }}>
          <CloseIcon />
        </IconButton>
      </Box>

      {/* Body */}
      <Box sx={{ flex: 1, overflowY: 'auto', p: '20px 24px' }}>
        {catalogueLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', pt: 4 }}>
            <CircularProgress size={28} />
          </Box>
        ) : (
          <>
            <StepIndicator current={step} total={3} />
            <Typography sx={{ fontSize: '.82rem', color: '#6b7280', mb: '16px' }}>
              {stepLabel}
            </Typography>

            {step === 1 && (
              <DesignVisitStep1
                initialData={step1}
                handles={handles}
                furnitureRanges={furnitureRanges}
                termsText={termsText}
                termsVersionNumber={termsVersionNumber}
                onDataChange={setStep1}
              />
            )}

            {step === 2 && (
              <DesignVisitRoomsStep
                initialRooms={rooms}
                doorStyles={doorStyles}
                onRoomsChange={setRooms}
                onUploadingChange={setUploading}
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
          </>
        )}
      </Box>

      {/* Footer */}
      {!catalogueLoading && (
        <Box
          sx={{
            display: 'flex',
            gap: '10px',
            justifyContent: 'flex-end',
            px: '24px',
            py: '14px',
            borderTop: '1px solid #e5e7eb',
            flexShrink: 0,
            background: '#fff',
            flexDirection: 'column',
            alignItems: 'stretch',
          }}
        >
          {(s1Error && step === 1) && (
            <Typography sx={{ color: '#b91c1c', fontSize: '.82rem' }}>{s1Error}</Typography>
          )}
          {(submitError && step === 3) && (
            <Typography sx={{ color: '#b91c1c', fontSize: '.82rem' }}>{submitError}</Typography>
          )}

          <Box sx={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            {step > 1 && (
              <Button
                variant="outlined"
                onClick={() => { setSubmitError(''); setStep(s => s - 1); }}
                disabled={submitting}
                sx={{
                  borderColor: '#d1d5db',
                  color: '#374151',
                  fontWeight: 600,
                  textTransform: 'none',
                  '&:hover': { borderColor: '#9ca3af', background: '#f9fafb' },
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
                  background: '#8B2BFF',
                  fontWeight: 600,
                  textTransform: 'none',
                  '&:hover': { background: '#7a1fe0' },
                }}
              >
                Next: Rooms →
              </Button>
            )}

            {step === 2 && (
              <Button
                variant="contained"
                onClick={() => {
                  const emptyRooms = rooms.filter(r => !r.roomName.trim());
                  if (emptyRooms.length || !rooms.length) return;
                  setStep(3);
                }}
                disabled={uploading || rooms.some(r => !r.roomName.trim()) || rooms.length === 0}
                sx={{
                  background: '#8B2BFF',
                  fontWeight: 600,
                  textTransform: 'none',
                  '&:hover': { background: '#7a1fe0' },
                  '&:disabled': { opacity: 0.55 },
                }}
              >
                Review →
              </Button>
            )}

            {step === 3 && (
              <Button
                variant="contained"
                onClick={handleSubmit}
                disabled={submitting}
                startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : undefined}
                sx={{
                  background: '#8B2BFF',
                  fontWeight: 600,
                  textTransform: 'none',
                  '&:hover': { background: '#7a1fe0' },
                  '&:disabled': { opacity: 0.55 },
                }}
              >
                {submitting
                  ? (editMode ? 'Saving…' : 'Submitting…')
                  : (editMode ? 'Save changes' : 'Submit visit')}
              </Button>
            )}
          </Box>
        </Box>
      )}
    </Drawer>
  );
}

export default DesignVisitWizard;
