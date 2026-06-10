import React, { useCallback, useEffect, useRef, useState } from 'react';

import { useToast } from '../../contexts/ToastContext';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { GET, POST, PATCH, DELETE } from '../../utils/api';
import { HANDLER_MODAL_SUMMARY } from '../../utils/handlerMeta';

import {
  DeliveryWindowConfig,
  InstallationSlotConfig,
  ScheduleVisitConfig,
  ShowMessageConfig,
  StartDesignVisitConfig,
  isLeadStatusKeyValid,
  isStatusKeyValid,
  KNOWN_STATUS_KEY_FIELDS,
} from './HandlerConfigBlocks';
import type {
  DeliveryWindowConfigValue,
  InstallationSlotConfigValue,
  ScheduleVisitConfigValue,
  ShowMessageConfigValue,
  StartDesignVisitConfigValue,
  VisitType,
} from './HandlerConfigBlocks';
import { usePageTitle } from '../../hooks/usePageTitle';

// ── Constants ─────────────────────────────────────────────────────────────────

const HANDLER_TYPE_LABELS: Record<string, string> = {
  add_design_visit_to_calendar: 'Add design visit to calendar',
  start_design_visit:           'Start design visit wizard',
  upload_photos_and_info:       'Upload photos & info',
  review_customer_photos:       'Review customer photos',
  arrange_visit:                'Arrange visit (call → book or email)',
};

export const NO_CONFIG_HANDLER_TYPES: ReadonlySet<string> = new Set([
  'add_design_visit_to_calendar',
  'summarise_phone_call',
  'upload_photos_and_info',
  'review_customer_photos',
  'arrange_visit',
]);

const HANDLER_TYPE_DESCRIPTIONS: Record<string, string> = {
  add_design_visit_to_calendar:
    'Clicking the action on a Sales/Survey card opens a modal asking for ' +
    'visit date, time, duration, title and notes.\n' +
    '• On submit, an event is created on the shared "Measure Once" Google ' +
    'Calendar (POST /api/events) — the single source of truth for scheduling. ' +
    'No separate CRM visit row is created. No email is sent by this app — ' +
    'Google Calendar may email invitees if attendees are added.\n' +
    '• No HubSpot record is changed by this action.',
  schedule_visit:
    'Generic version of "Add design visit to calendar" — works for any visit ' +
    'type (survey, installation, remedial, workshop, etc.).\n' +
    '• Clicking the action on a card opens a MUI DateTimePicker modal asking ' +
    'for date, time, duration, title, location, and notes.\n' +
    '• On submit, an event is created on the shared "Measure Once" Google ' +
    'Calendar (POST /api/events) — the single source of truth for scheduling. ' +
    'No separate CRM visit row is created.\n' +
    '• No HubSpot record is changed by this action.',
  summarise_phone_call:
    'Clicking the action on a Sales/Survey card opens a modal with a ' +
    'textarea for raw call notes.\n' +
    '• On submit the notes are sent to POST ' +
    '/api/card-actions/phone-call-summary, which asks the LLM to produce ' +
    'a structured summary.\n' +
    '• The summary is saved as a timestamped note against the HubSpot ' +
    'contact (HubSpot Engagements API). No email or calendar event is ' +
    'created.',
  show_message:
    'Clicking the action on a Sales/Survey card opens a simple popup ' +
    'showing the message you write below. Nothing else happens — no API ' +
    'call, no email, no calendar event, no HubSpot or CRM record change. ' +
    'Use this when you just need to remind the operator what to do for ' +
    'this stage/lead-status (e.g. "Send the quote PDF from the shared ' +
    'drive and tick the next step manually.").',
  start_design_visit:
    'Clicking the action on a Sales/Survey card opens a full multi-step design visit wizard.\n' +
    '• Two-phase HubSpot status update: when the wizard opens the contact\'s lead status is set to the "In-progress" status (if configured); when the wizard is submitted it is set to the "Submitted" status (if configured).\n' +
    '• Step 1 — Visit details: date/time, designer name, handle selection, furniture range, T&C acceptance.\n' +
    '• Step 2 — Rooms: add/remove rooms with name, door style, dimensions (mm), unit count, unit price, notes, and optional photo upload.\n' +
    '• Step 3 — Review: read-only summary before submission.\n' +
    '• On submit: creates a design_visits DB record, updates HubSpot lead status to the configured submitted status, creates a HubSpot note, attempts a QuickBooks Estimate (non-fatal), generates a single-use sign-off token, emails the customer a "See Your Design & Sign Off" link, and notifies the admin team.',
  schedule_delivery_window:
    'Clicking the action on a card opens a modal for scheduling a delivery window with a start and end date/time.\n' +
    '• The operator picks a window start and window end (e.g. "8 AM – 1 PM on 12 June").\n' +
    '• On submit, an event is created on the shared "Measure Once" Google Calendar (POST /api/events) — the single source of truth for scheduling. No separate CRM visit row is created.\n' +
    '• No HubSpot record is changed by this action.\n' +
    'Config keys: defaultTitle (≤120 chars).',
  schedule_installation_slot:
    'Clicking the action on a card opens a modal for scheduling a single installation slot with a start time and duration.\n' +
    '• The operator picks a start date/time and a duration in minutes (default 240 min / 4 hours).\n' +
    '• On submit, an event is created on the shared "Measure Once" Google Calendar (POST /api/events) — the single source of truth for scheduling. No separate CRM visit row is created.\n' +
    '• No HubSpot record is changed by this action.\n' +
    'Config keys: defaultDurationMin (5–1440), defaultTitle (≤120 chars).',
  upload_photos_and_info:
    'Clicking the action on a card opens a confirmation modal showing the customer\'s name and email.\n' +
    '• On confirmation, an email is sent to the customer with a unique, time-limited link to a public form.\n' +
    '• The form collects: contact details (with optional corrections), address, number of rooms, photo uploads, and free-text notes.\n' +
    '• On submission: the customer sees a thank-you screen; an admin notification email is sent with all submitted info; a thank-you email is sent to the customer; HubSpot lead status is updated to AWAITING_PHOTOS with sub-status AWPH_RECEIVED.\n' +
    '• Submissions are visible on the customer\'s detail page in the "Customer Info" rail.\n' +
    '• No config keys required.',
  review_customer_photos:
    'Clicking the action on a card opens a review drawer showing the customer\'s most recent submitted info (address, room count, notes, and photo thumbnails).\n' +
    '• The reviewer picks one of two outcomes: Not Suitable or Send Rough Estimate.\n' +
    '• Not Suitable: opens an editable confirmation step with a pre-filled email. On confirm, the email is sent and HubSpot lead status is set to NOT_SUITABLE (sub-status cleared).\n' +
    '• Send Rough Estimate: opens a confirmation step with a price-range field and an editable pre-filled email. On confirm, the email is sent and HubSpot lead status is set to ROUGH_ESTIMATE (sub-status cleared).\n' +
    '• The review outcome is recorded in the dashboard.\n' +
    '• No config keys required.',
  arrange_visit:
    'Clicking the action on a card guides the team member through a call-first visit booking flow.\n' +
    '• Step 1 — Call: shows the customer\'s name and phone number with a contextual prompt (design vs. survey). Four outcome buttons: Booked, No answer, Call back later, Not proceeding.\n' +
    '• Booked: opens a date/time picker pre-filled with the customer\'s address. On save, updates HubSpot lead status to DSSC_AGREED (design) or SRSC_AGREED (survey) and opens the calendar scheduling modal.\n' +
    '• No answer — Email: shows an editable email preview asking the customer to share their day/evening availability for the next week. Staff can edit the subject and body before sending via Gmail (POST /api/emails/send). On send, updates HubSpot lead status to DSSC_SUGGESTED (design) or SRSC_SUGGESTED (survey).\n' +
    '• Call back later: closes the modal immediately — no HubSpot change.\n' +
    '• Not proceeding: updates HubSpot lead status to not_suitable and closes the modal.\n' +
    '• Visit type (design vs. survey) is resolved automatically from the contact\'s current hs_lead_status — awaiting_deposit → survey, everything else → design.\n' +
    '• In-progress form state is saved to sessionStorage and restored on re-open.\n' +
    '• No config keys required.',
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface Binding    { stage_key?: string; status_key?: string; substatus_id?: number | null; }
interface Handler    { id: number; name: string; type: string; config: Record<string, unknown>; bindings: Binding[]; }
interface LeadStatus { key: string; label: string; stage: string | null; shorthand: string; sort_order: number; excluded_from_sales: boolean; is_null_row: boolean; }
interface Substatus  { id: number; status_key: string; substatus_key: string; label: string; action_label: string; sort_order: number; }
interface CALabel    { stage_key: string; status_key: string; label: string; }

interface ConflictItem {
  type: 'label' | 'substatus';
  stage_key?: string; status_key?: string; substatus_id?: number;
  count: number; handler_ids: number[]; handler_names: string[];
}
interface ConflictData { total: number; conflicts: ConflictItem[]; }

interface ActionSlot {
  kind: 'ls' | 'sub';
  stage_key?: string; status_key?: string;
  substatus_id?: number;
  label: string; rowLabel: string;
  hasLabel?: boolean;
}
interface ActionGroup { ls: { key: string; label: string; isNullRow: boolean }; slots: ActionSlot[]; }
interface ActionStage { stage: { key: string; label: string }; groups: ActionGroup[]; }

// ── Module-level state refs (shared between component and window exposures) ────

const W = window as unknown as Record<string, unknown>;
const _nonce = Math.random().toString(36).slice(2);
const _reloadRef:       { fn: (() => Promise<void>) | null }          = { fn: null };
const _handlersRef:     { current: Handler[]    }                      = { current: [] };
const _labelsRef:       { current: CALabel[]    }                      = { current: [] };
const _substatusesRef:  { current: Substatus[]  }                      = { current: [] };
const _statusesRef:     { current: LeadStatus[] }                      = { current: [] };
const _toastRef:        { fn: ((m: string, err?: boolean) => void) | null } = { fn: null };

// Refs to open modals from outside the React tree (e.g. window exposure)
const _openEditorRef: { fn: ((slot: ActionSlot, existing?: Handler | null) => void) | null } = { fn: null };
const _openConflictResolverRef: { fn: ((stageKey: string | null, statusKey: string | null, substatusId: number | null) => void) | null } = { fn: null };

// ── Helpers ───────────────────────────────────────────────────────────────────

function showToast(msg: string, err?: boolean) {
  if (_toastRef.fn) _toastRef.fn(msg, err);
  else if (typeof W.toast === 'function') (W.toast as (m: string, e?: boolean) => void)(msg, err);
}

function _handlersForSlot(slot: Partial<ActionSlot>): Handler[] {
  return _handlersRef.current.filter(h => h.bindings?.some(b => {
    if (slot.substatus_id != null) return Number(b.substatus_id) === slot.substatus_id;
    if (b.substatus_id != null) return false;
    return (b.stage_key  || '').toLowerCase() === (slot.stage_key  || '').toLowerCase()
        && (b.status_key || '').toLowerCase() === (slot.status_key || '').toLowerCase();
  }));
}

function _resolveLeadStatusLabel(key: string): string {
  if (!key) return '';
  const ls = _statusesRef.current.find(s => s.key === key);
  if (ls) return ls.label || ls.key;
  const sub = _substatusesRef.current.find(s => s.substatus_key === key);
  if (sub) {
    const parent = _statusesRef.current.find(s => s.key === sub.status_key);
    return `${sub.label || sub.substatus_key} (${parent ? (parent.label || parent.key) : sub.status_key})`;
  }
  return key;
}

function _buildActionSlotGroups(): ActionStage[] {
  const CARD_ACTION_STAGES = [
    { key: 'sales', label: 'Sales', lsStage: 'SALES' },
    { key: 'designvisit', label: 'Design Visit', lsStage: 'DESIGN_VISIT' },
    { key: 'survey', label: 'Survey', lsStage: 'SURVEY' },
  ];
  const labelsByKey = new Map<string, string>();

  for (const lbl of _labelsRef.current) {
    const val = (lbl.label || '').trim();
    if (val) labelsByKey.set(`${lbl.stage_key}|${lbl.status_key}`, val);
  }

  const stageMap = new Map<string, ActionStage>();
  for (const cs of CARD_ACTION_STAGES) {
    stageMap.set(cs.key, { stage: { key: cs.key, label: cs.label }, groups: [] });
  }

  const statuses = _statusesRef.current.filter(s => !s.is_null_row);
  const nullRow  = _statusesRef.current.find(s => s.is_null_row);
  const subs     = _substatusesRef.current;

  const STAGE_FOR_LS: Record<string, string> = Object.fromEntries(
    CARD_ACTION_STAGES.map(s => [s.lsStage, s.key]),
  );

  const processLs = (ls: LeadStatus, stageKey: string) => {
    const lsKeyLower = String(ls.key || '').toLowerCase();
    const groups: ActionGroup[] = [];
    const slots: ActionSlot[]   = [];

    const dflt = labelsByKey.get(`${stageKey}|${lsKeyLower}`) || '';
    const hasHandler = _handlersRef.current.some(h =>
      (h.bindings || []).some(b =>
        b.substatus_id == null &&
        (b.stage_key  || '').toLowerCase() === stageKey &&
        (b.status_key || '').toLowerCase() === lsKeyLower,
      ),
    );

    const lsSubs = subs.filter(s => String(s.status_key).toUpperCase() === String(ls.key).toUpperCase())
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

    if (dflt || hasHandler) {
      slots.push({ kind: 'ls', stage_key: stageKey, status_key: lsKeyLower, label: dflt || ls.label, rowLabel: 'Default action', hasLabel: !!dflt });
    }
    for (const sub of lsSubs) {
      const action = (sub.action_label || '').trim();
      if (!action) continue;
      slots.push({
        kind: 'sub', substatus_id: sub.id,
        status_key: sub.status_key,
        label: action, rowLabel: `Sub-status${sub.label ? ' · ' + sub.label : ''}`,
      });
    }

    if (slots.length) {
      groups.push({ ls: { key: ls.key, label: ls.label, isNullRow: !!ls.is_null_row }, slots });
    }
    return groups;
  };

  // Global null slot (stage_key='__global__', status_key='').
  // Mirrors CardActionsPage: prefer '__global__' label, fall back to legacy 'sales' label for display.
  // Shown when the '__global__' label is set OR a handler is already bound to this slot.
  const globalLabel = labelsByKey.get('__global__|') || '';
  const globalLabelDisplay = globalLabel || labelsByKey.get('sales|') || (nullRow?.label ?? 'No lead status');
  const hasGlobalHandler = _handlersRef.current.some(h =>
    (h.bindings || []).some(b =>
      b.substatus_id == null &&
      (b.stage_key || '').toLowerCase() === '__global__' &&
      (b.status_key || '') === '',
    ),
  );
  const globalStage: ActionStage | null = (globalLabel || hasGlobalHandler) ? {
    stage: { key: '__global__', label: 'No lead status' },
    groups: [{
      ls: { key: '__GLOBAL_NULL__', label: '', isNullRow: false },
      slots: [{
        kind: 'ls', stage_key: '__global__', status_key: '',
        label: globalLabelDisplay, rowLabel: 'Default action',
        hasLabel: !!globalLabel,
      }],
    }],
  } : null;

  // Legacy Sales null-row omitted — superseded by the global null slot above.

  for (const ls of statuses) {
    const stageKey = STAGE_FOR_LS[ls.stage || ''];
    if (!stageKey) continue;
    const stage = stageMap.get(stageKey)!;
    const groups = processLs(ls, stageKey);
    stage.groups.push(...groups);
  }

  const pipelineStages = Array.from(stageMap.values()).filter(s => s.groups.length > 0);
  return globalStage ? [globalStage, ...pipelineStages] : pipelineStages;
}

// ── DOM-appending modal functions ─────────────────────────────────────────────

async function _reloadAndBroadcast() {
  if (_reloadRef.fn) await _reloadRef.fn();
  try {
    new BroadcastChannel('card_action_handlers_changed').postMessage({ ts: Date.now(), src: _nonce });
  } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent('card_action_handlers_changed'));
}

function _flashResolvedBadge(slot: Partial<ActionSlot>): void {
  if (typeof W.flashResolvedSlot === 'function') {
    (W.flashResolvedSlot as (a: string, b: string, c: number | null) => void)(
      slot.stage_key || '',
      slot.status_key || '',
      slot.substatus_id != null ? Number(slot.substatus_id) : null,
    );
    return;
  }
}

// ── HandlerEditorModal ────────────────────────────────────────────────────────

const SNAKE_RE = /^[a-z0-9_]*$/;

interface HandlerEditorModalProps {
  slot:        ActionSlot;
  existing:    Handler | null;
  handlers:    Handler[];
  statuses:    LeadStatus[];
  substatuses: Substatus[];
  onClose:     () => void;
  onSaved:     (isEdit: boolean) => void;
}

function HandlerEditorModal({
  slot,
  existing,
  handlers,
  statuses,
  substatuses,
  onClose,
  onSaved,
}: HandlerEditorModalProps) {
  const initConfig = existing?.config ?? {};
  const initType   = existing?.type   ?? 'add_design_visit_to_calendar';

  const [handlerType,   setHandlerType]   = useState(initType);
  const [actionName,    setActionName]    = useState(String(initConfig.action_name ?? ''));
  const [actionNameErr, setActionNameErr] = useState('');

  const [svVal,  setSvVal]  = useState<ScheduleVisitConfigValue>({
    visitType:           (initConfig.visitType as VisitType) ?? 'survey',
    defaultDurationMin:  initConfig.defaultDurationMin != null ? Number(initConfig.defaultDurationMin) : 60,
  });
  const [msgVal,  setMsgVal]  = useState<ShowMessageConfigValue>({
    title:   String(initConfig.title   ?? ''),
    message: String(initConfig.message ?? ''),
  });
  const [sdvVal,  setSdvVal]  = useState<StartDesignVisitConfigValue>({
    defaultDurationMin:     initConfig.defaultDurationMin != null ? Number(initConfig.defaultDurationMin) : 90,
    intermediateLeadStatus: String(initConfig.intermediateLeadStatus ?? ''),
    submittedLeadStatus:    String(initConfig.submittedLeadStatus    ?? ''),
    termsAndConditions:     String(initConfig.termsAndConditions     ?? ''),
  });
  const [dwVal,   setDwVal]   = useState<DeliveryWindowConfigValue>({
    defaultTitle:        String(initConfig.defaultTitle ?? ''),
  });
  const [isVal,   setIsVal]   = useState<InstallationSlotConfigValue>({
    defaultDurationMin:  initConfig.defaultDurationMin != null ? Number(initConfig.defaultDurationMin) : 240,
    defaultTitle:        String(initConfig.defaultTitle ?? ''),
  });
  const [jsonCfg,      setJsonCfg]      = useState(JSON.stringify(initConfig, null, 2));
  const [editError,    setEditError]    = useState('');
  const [conflictList, setConflictList] = useState<Handler[]>([]);
  const [saving,       setSaving]       = useState(false);

  const binding: Binding = slot.kind === 'sub'
    ? { substatus_id: slot.substatus_id }
    : { stage_key: slot.stage_key, status_key: slot.status_key };

  const sdvLeadStatuses = statuses
    .filter(s => !s.is_null_row)
    .map(s => ({ key: s.key, label: s.label || s.key }));
  const sdvSubstatuses = substatuses.map(s => ({
    key: s.substatus_key, label: s.label, statusKey: s.status_key,
  }));

  const validateName = (v: string): boolean => {
    if (v.length > 0 && !SNAKE_RE.test(v)) {
      setActionNameErr('Only lowercase letters, digits, and underscores are allowed (e.g. send_quote).');
      return false;
    }
    setActionNameErr('');
    return true;
  };

  const showSv  = handlerType === 'schedule_visit';
  const showMsg = handlerType === 'show_message';
  const showSdv = handlerType === 'start_design_visit';
  const showDw  = handlerType === 'schedule_delivery_window';
  const showIs  = handlerType === 'schedule_installation_slot';
  const showNoConfig = NO_CONFIG_HANDLER_TYPES.has(handlerType);
  const showJson = !(showSv || showMsg || showSdv || showDw || showIs || showNoConfig);

  const sdvInvalidIntermediate = showSdv
    && !isLeadStatusKeyValid(sdvVal.intermediateLeadStatus, sdvLeadStatuses);
  const sdvInvalidSubmitted = showSdv
    && !isStatusKeyValid(sdvVal.submittedLeadStatus, sdvLeadStatuses, sdvSubstatuses);

  // Detect stale status-key references inside the JSON fallback editor.
  // We parse the JSON on every render (cheap for small configs) and check every
  // field listed in KNOWN_STATUS_KEY_FIELDS against the live status lists.
  const jsonStaleLsRefs: Array<{ field: string; label: string; key: string }> = [];
  if (showJson) {
    try {
      const parsed: Record<string, unknown> = JSON.parse(jsonCfg.trim() || '{}');
      for (const knownField of KNOWN_STATUS_KEY_FIELDS) {
        const val = parsed[knownField.field];
        if (typeof val === 'string' && val !== '') {
          const valid = knownField.type === 'lead_status'
            ? isLeadStatusKeyValid(val, sdvLeadStatuses)
            : isStatusKeyValid(val, sdvLeadStatuses, sdvSubstatuses);
          if (!valid) {
            jsonStaleLsRefs.push({ field: knownField.field, label: knownField.label, key: val });
          }
        }
      }
    } catch { /* invalid JSON — skip stale checks; buildPayload will report the parse error */ }
  }

  const hasStaleLsRefs = sdvInvalidIntermediate || sdvInvalidSubmitted || jsonStaleLsRefs.length > 0;

  const buildPayload = (): Record<string, unknown> | null => {
    setEditError('');
    if (!validateName(actionName.trim())) {
      setEditError('Action name may only contain lowercase letters, digits, and underscores.');
      return null;
    }

    let cfg: Record<string, unknown>;

    if (handlerType === 'schedule_visit') {
      const dur = svVal.defaultDurationMin;
      const n   = dur === '' ? NaN : Number(dur);
      if (dur !== '' && (isNaN(n) || n < 5 || n > 1440)) {
        setEditError('Default duration must be between 5 and 1440 minutes.'); return null;
      }
      cfg = { visitType: svVal.visitType };
      if (dur !== '' && !isNaN(n) && n > 0) cfg.defaultDurationMin = n;

    } else if (handlerType === 'show_message') {
      const msg = msgVal.message.trim();
      if (!msg) { setEditError('Message is required for "Show informational message".'); return null; }
      cfg = { message: msg };
      if (msgVal.title.trim()) cfg.title = msgVal.title.trim();

    } else if (handlerType === 'start_design_visit') {
      const dur = sdvVal.defaultDurationMin;
      const n   = dur === '' ? NaN : Number(dur);
      if (dur !== '' && (isNaN(n) || n < 5 || n > 1440)) {
        setEditError('Default duration must be between 5 and 1440 minutes.'); return null;
      }
      cfg = {};
      if (dur !== '' && !isNaN(n) && n > 0) cfg.defaultDurationMin = n;
      if (sdvVal.intermediateLeadStatus) cfg.intermediateLeadStatus = sdvVal.intermediateLeadStatus;
      if (sdvVal.submittedLeadStatus)    cfg.submittedLeadStatus    = sdvVal.submittedLeadStatus;
      if (sdvVal.termsAndConditions)     cfg.termsAndConditions     = sdvVal.termsAndConditions;

    } else if (handlerType === 'schedule_delivery_window') {
      cfg = {};
      if (dwVal.defaultTitle.trim()) cfg.defaultTitle = dwVal.defaultTitle.trim();

    } else if (handlerType === 'schedule_installation_slot') {
      const dur = isVal.defaultDurationMin;
      const n   = dur === '' ? NaN : Number(dur);
      if (dur !== '' && (isNaN(n) || n < 5 || n > 1440)) {
        setEditError('Default duration must be between 5 and 1440 minutes.'); return null;
      }
      cfg = {};
      if (dur !== '' && !isNaN(n)) cfg.defaultDurationMin = n;
      if (isVal.defaultTitle.trim()) cfg.defaultTitle = isVal.defaultTitle.trim();

    } else {
      const txt = jsonCfg.trim() || '{}';
      try { cfg = JSON.parse(txt); }
      catch { setEditError('Configuration is not valid JSON.'); return null; }
    }

    const av = actionName.trim();
    if (av) cfg.action_name = av; else delete cfg.action_name;
    return { name: '', type: handlerType, config: cfg, bindings: [binding] };
  };

  const doSave = async (payload: Record<string, unknown>) => {
    setSaving(true);
    try {
      if (existing) await PATCH(`/api/admin/card-action-handlers/${existing.id}`, payload);
      else          await POST('/api/admin/card-action-handlers', payload);
      onSaved(!!existing);
    } catch (e) {
      setEditError((e as Error).message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    const payload = buildPayload();
    if (!payload) return;

    const conflicts = handlers.filter(h =>
      (h.bindings ?? []).some((b: Binding) => {
        if (slot.substatus_id != null) return Number(b.substatus_id) === slot.substatus_id;
        if (b.substatus_id != null) return false;
        return (b.stage_key  || '').toLowerCase() === (slot.stage_key  || '').toLowerCase()
            && (b.status_key || '').toLowerCase() === (slot.status_key || '').toLowerCase();
      }) && (!existing || h.id !== existing.id),
    );

    if (conflicts.length > 0) {
      setConflictList(conflicts);
      return;
    }
    await doSave(payload);
  };

  const handleConfirmBind = async () => {
    const payload = buildPayload();
    if (!payload) return;
    setConflictList([]);
    await doSave(payload);
  };

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth sx={{ '& .MuiDialog-paper': { maxHeight: '90vh' } }} data-testid="handler-editor-modal">
        <DialogTitle sx={{ pb: 0.5 }}>
          {existing ? 'Change action' : 'Add action'}
          <Typography
            component="span"
            variant="body2"
            color="text.secondary"
            sx={{ display: 'block', fontWeight: 400 }}
          >
            for <strong>{slot.label}</strong>{' '}
            {slot.rowLabel && (
              <span style={{ opacity: 0.65 }}>({slot.rowLabel})</span>
            )}
          </Typography>
        </DialogTitle>

        <DialogContent dividers>
          <Stack spacing={2} sx={{ pt: 0.5 }}>

            {/* Action name */}
            <Box>
              <TextField
                label="Action name (optional)"
                size="small"
                fullWidth
                value={actionName}
                slotProps={{ htmlInput: { id: 'cah-action-name', maxLength: 80 } }}
                placeholder="e.g. send_quote"
                error={!!actionNameErr}
                onChange={e => { setActionName(e.target.value); validateName(e.target.value); }}
                onBlur={e => validateName(e.target.value)}
              />
              <Typography
                component="span"
                id="cah-action-name-err"
                variant="caption"
                color="error"
                sx={{ display: actionNameErr ? 'block' : 'none', mt: 0.25 }}
              >
                {actionNameErr}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                ⚙️ Backend automation coming soon — this name will be used to trigger workflows automatically once wired up.
              </Typography>
            </Box>

            {/* Handler type */}
            <FormControl size="small" fullWidth>
              <InputLabel htmlFor="cah-type">Action type</InputLabel>
              <Select
                native
                label="Action type"
                inputProps={{ id: 'cah-type' }}
                value={handlerType}
                onChange={e => { setHandlerType(String(e.target.value)); setConflictList([]); }}
              >
                {Object.entries(HANDLER_TYPE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
            </FormControl>

            {/* Type description */}
            {HANDLER_TYPE_DESCRIPTIONS[handlerType] && (
              <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-wrap' }}>
                {HANDLER_TYPE_DESCRIPTIONS[handlerType]}
              </Typography>
            )}

            {/* Config blocks — only one is shown at a time */}
            {showSv && (
              <ScheduleVisitConfig
                defaultVisitType={svVal.visitType}
                defaultDurationMin={svVal.defaultDurationMin}
                onChange={setSvVal}
              />
            )}
            {showMsg && (
              <ShowMessageConfig
                defaultTitle={msgVal.title}
                defaultMessage={msgVal.message}
                onChange={setMsgVal}
              />
            )}
            {showSdv && (
              <StartDesignVisitConfig
                defaultDurationMin={sdvVal.defaultDurationMin}
                intermediateLeadStatus={sdvVal.intermediateLeadStatus}
                submittedLeadStatus={sdvVal.submittedLeadStatus}
                termsAndConditions={sdvVal.termsAndConditions}
                leadStatuses={sdvLeadStatuses}
                substatuses={sdvSubstatuses}
                intermediateLeadStatusInvalid={sdvInvalidIntermediate}
                submittedLeadStatusInvalid={sdvInvalidSubmitted}
                onChange={setSdvVal}
              />
            )}
            {showDw && (
              <DeliveryWindowConfig
                defaultTitle={dwVal.defaultTitle}
                onChange={setDwVal}
              />
            )}
            {showIs && (
              <InstallationSlotConfig
                defaultDurationMin={isVal.defaultDurationMin}
                defaultTitle={isVal.defaultTitle}
                onChange={setIsVal}
              />
            )}

            {/* Placeholder for handler types that have no configurable settings */}
            {showNoConfig && (
              <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
                No additional configuration required for this action type.
              </Typography>
            )}

            {/* JSON fallback for types without a dedicated config block */}
            {showJson && (
              <Box>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: 'block', mb: 0.5, fontWeight: 500 }}
                >
                  Advanced configuration (JSON, optional)
                </Typography>
                <TextField
                  size="small"
                  fullWidth
                  multiline
                  rows={4}
                  value={jsonCfg}
                  onChange={e => setJsonCfg(e.target.value)}
                  slotProps={{ htmlInput: { style: { fontFamily: 'var(--font-mono)', fontSize: '0.75rem' } } }}
                />
                {jsonStaleLsRefs.map(ref => (
                  <Alert key={ref.field} severity="warning" sx={{ mt: 0.75 }}>
                    <strong>{ref.label}</strong> (<code>{ref.key}</code>) no longer exists.
                    Update or remove this field before saving.
                  </Alert>
                ))}
              </Box>
            )}

            {/* Conflict warning */}
            {conflictList.length > 0 && (
              <Alert
                severity="warning"
                action={
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <Button size="small" onClick={() => setConflictList([])}>
                      Keep editing
                    </Button>
                    <Button size="small" variant="contained" color="warning" onClick={handleConfirmBind} disabled={saving}>
                      Bind anyway
                    </Button>
                  </Stack>
                }
              >
                <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
                  Slot already has a handler
                </Typography>
                {conflictList.map(h => {
                  const slotLabel = slot.label || (
                    slot.substatus_id != null
                      ? `sub-status #${slot.substatus_id}`
                      : `${slot.stage_key} / ${slot.status_key}`
                  );
                  return (
                    <Typography key={h.id} variant="body2">
                      • <strong>{slotLabel}</strong> is already wired to{' '}
                      <strong>{h.name || HANDLER_TYPE_LABELS[h.type] || h.type}</strong> — bind anyway?
                    </Typography>
                  );
                })}
              </Alert>
            )}

            {/* Error */}
            <Typography id="cah-edit-err" variant="body2" color="error" sx={{ display: editError ? 'block' : 'none' }}>
              {editError}
            </Typography>

          </Stack>
        </DialogContent>

        <DialogActions>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button id="cah-save" variant="contained" onClick={handleSave} disabled={saving || hasStaleLsRefs}>
            {existing ? 'Save' : 'Add'}
          </Button>
        </DialogActions>
      </Dialog>
  );
}

// ── ConflictResolverModal ─────────────────────────────────────────────────────

interface ConflictResolverModalProps {
  stageKey:    string | null;
  statusKey:   string | null;
  substatusId: number | null;
  handlers:    Handler[];
  statuses:    LeadStatus[];
  substatuses: Substatus[];
  onClose:     () => void;
  /** Optional override for the remove action (used by Storybook to avoid real API calls). */
  onRemove?:   (id: number) => Promise<void>;
}

export function ConflictResolverModal({
  stageKey,
  statusKey,
  substatusId,
  handlers,
  statuses,
  substatuses,
  onClose,
  onRemove,
}: ConflictResolverModalProps) {
  const slot: Partial<ActionSlot> = substatusId != null
    ? { substatus_id: Number(substatusId) }
    : { stage_key: stageKey || '', status_key: statusKey || '' };

  const conflicting = handlers.filter(h => h.bindings?.some(b => {
    if (slot.substatus_id != null) return Number(b.substatus_id) === slot.substatus_id;
    if (b.substatus_id != null) return false;
    return (b.stage_key  || '').toLowerCase() === (slot.stage_key  || '').toLowerCase()
        && (b.status_key || '').toLowerCase() === (slot.status_key || '').toLowerCase();
  }));

  let slotDesc: string;
  if (substatusId != null) {
    const sub = substatuses.find(s => Number(s.id) === Number(substatusId));
    slotDesc = sub ? `sub-status "${sub.label || sub.substatus_key}"` : `sub-status #${substatusId}`;
  } else {
    const ls = statuses.find(s => s.key === statusKey);
    slotDesc = ls ? `"${ls.label}"` : `${stageKey} / ${statusKey}`;
  }

  const [removingId, setRemovingId] = useState<number | null>(null);
  const [errorMsg,   setErrorMsg]   = useState('');

  useEffect(() => {
    if (conflicting.length === 0) onClose();
  }, [conflicting.length, onClose]);

  const handleRemove = async (id: number) => {
    setRemovingId(id);
    setErrorMsg('');
    try {
      if (onRemove) {
        await onRemove(id);
      } else {
        await DELETE(`/api/admin/card-action-handlers/${id}`);
        await _reloadAndBroadcast();
        showToast('Handler removed.');
        const remaining = _handlersForSlot(slot);
        if (remaining.length <= 1) {
          onClose();
          _flashResolvedBadge(slot);
        }
      }
    } catch (err) {
      setErrorMsg('Remove failed: ' + ((err as Error).message || 'unknown error'));
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth data-testid="conflict-resolver-dialog">
      <DialogTitle data-testid="conflict-resolver-title">Fix conflicting handlers</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" sx={{ mb: 2 }}>
          The slot {slotDesc} has <strong>{conflicting.length} handlers</strong> bound to it.
          Remove all but one to resolve the conflict.
        </Typography>
        <Stack spacing={1}>
          {conflicting.map(h => {
            const typeLbl = HANDLER_TYPE_LABELS[h.type] || h.type;
            const desc    = HANDLER_TYPE_DESCRIPTIONS[h.type] || '';
            const isRemoving = removingId === h.id;
            return (
              <Box
                key={h.id}
                className="ca-conflict-row"
                sx={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 1,
                  p: 1.5,
                  borderRadius: 1,
                  border: '1px solid',
                  borderColor: 'divider',
                }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    <span aria-hidden="true">⚡</span>{' '}{typeLbl}
                  </Typography>
                  {desc && (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: 'block', mt: 0.25, whiteSpace: 'pre-wrap' }}
                    >
                      {desc}
                    </Typography>
                  )}
                </Box>
                <Button
                  className="ca-conflict-remove-btn"
                  size="small"
                  variant="outlined"
                  color="error"
                  disabled={isRemoving || removingId != null}
                  onClick={() => handleRemove(h.id)}
                  sx={{ flexShrink: 0 }}
                >
                  {isRemoving ? 'Removing…' : 'Remove'}
                </Button>
              </Box>
            );
          })}
        </Stack>
        {errorMsg && (
          <Typography variant="body2" color="error" sx={{ mt: 1 }}>
            {errorMsg}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button id="ca-conflict-close" onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

async function _deleteHandler(id: number): Promise<void> {
  if (!confirm('Remove this action from the label?')) return;
  try {
    await DELETE(`/api/admin/card-action-handlers/${id}`);
    await _reloadAndBroadcast();
    showToast('Action removed.');
  } catch (e) {
    showToast('Remove failed: ' + (e as Error).message, true);
  }
}

// ── Sub-component: handler summary ────────────────────────────────────────────

function HandlerBoundTo({ h }: { h: Handler }) {
  const summary = HANDLER_MODAL_SUMMARY[h.type];
  if (!h.bindings || h.bindings.length === 0) {
    return (
      <div className="adm-handler-bound-to">
        <div className="adm-handler-bound-to-head">Bound to:</div>
        <div className="adm-muted-inline" style={{ fontStyle: 'italic', marginTop: 2 }}>Not bound to any action</div>
        {summary && (
          <div className="adm-handler-summary-steps" style={{ marginTop: 4 }}>
            <span className="adm-muted-inline">Steps:</span> {summary.steps}
          </div>
        )}
        {summary && (
          <div className="adm-handler-summary-hubspot" style={{ marginTop: 2 }}>
            <span className="adm-muted-inline">HubSpot:</span> {summary.hubspot}
          </div>
        )}
      </div>
    );
  }
  const chipSx = {
    height: 20, fontSize: '0.7rem', fontWeight: 600,
    bgcolor: 'rgba(124,58,237,0.08)', color: 'rgb(109,40,217)',
    '.MuiChip-label': { px: 0.75 },
  } as const;

  return (
    <div className="adm-handler-bound-to">
      <div className="adm-handler-bound-to-head">Bound to:</div>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
        {h.bindings.map((b, i) => {
          let chipLabel: string;
          if (b.substatus_id != null) {
            const sub = _substatusesRef.current.find(s => Number(s.id) === Number(b.substatus_id));
            const parentLs = sub ? _statusesRef.current.find(s => String(s.key || '').toLowerCase() === String(sub.status_key || '').toLowerCase()) : null;
            const stage = String(b.stage_key || '');
            const lsLabel = parentLs ? (parentLs.label || parentLs.key) : (b.status_key || '?');
            const subLabel = sub ? (sub.label || sub.substatus_key) : `#${b.substatus_id}`;
            chipLabel = stage ? `${stage} / ${lsLabel} / ${subLabel}` : `${lsLabel} / ${subLabel}`;
          } else {
            const stage = String(b.stage_key || '');
            if (stage.toLowerCase() === '__global__' && (b.status_key || '') === '') {
              chipLabel = 'No lead status';
            } else {
              const ck = String(b.status_key || '').toLowerCase();
              const ls = _statusesRef.current.find(s => String(s.key || '').toLowerCase() === ck);
              const lsLabel = ls ? (ls.label || ls.key) : (b.status_key || '—');
              chipLabel = stage ? `${stage} / ${lsLabel}` : lsLabel;
            }
          }
          return <Chip key={i} label={chipLabel} size="small" sx={chipSx} />;
        })}
      </Box>
      {summary && (
        <div className="adm-handler-summary-steps">
          <span className="adm-muted-inline">Steps:</span> {summary.steps}
        </div>
      )}
      {summary && (
        <div className="adm-handler-summary-hubspot">
          <span className="adm-muted-inline">HubSpot:</span>{' '}
          {h.type === 'start_design_visit' && h.config?.submittedLeadStatus
            ? `Sets lead status to in-progress on open; to ${h.config.submittedLeadStatus} on submit`
            : summary.hubspot}
        </div>
      )}
    </div>
  );
}

function HandlerSummary({ h }: { h: Handler }) {
  const typeLbl = HANDLER_TYPE_LABELS[h.type] || h.type;
  const actionName = h.config?.action_name ? (
    <span className="adm-handler-actionname">{String(h.config.action_name)}</span>
  ) : null;
  const extraRows: React.ReactNode[] = [];
  let hasStaleStatusRef = false;
  if (h.type === 'start_design_visit') {
    const liveStatusKeys = new Set(
      _statusesRef.current.filter(s => !s.is_null_row).map(s => s.key),
    );
    const liveSubstatusKeys = new Set(
      _substatusesRef.current.map(s => s.substatus_key),
    );
    const interKey = h.config?.intermediateLeadStatus ? String(h.config.intermediateLeadStatus) : '';
    const submKey  = h.config?.submittedLeadStatus    ? String(h.config.submittedLeadStatus)    : '';
    const interStale = !!interKey && !liveStatusKeys.has(interKey);
    const submStale  = !!submKey  && !liveStatusKeys.has(submKey) && !liveSubstatusKeys.has(submKey);
    hasStaleStatusRef = interStale || submStale;

    if (interKey) {
      extraRows.push(
        <div key="inter">
          <span className="adm-muted-inline">In-progress status:</span>{' '}
          <strong>{_resolveLeadStatusLabel(interKey)}</strong>
          {interStale && (
            <Chip
              data-testid="stale-status-warning"
              color="warning"
              size="small"
              label="Status deleted"
              sx={{ ml: 1, verticalAlign: 'middle' }}
            />
          )}
        </div>,
      );
    }
    if (submKey) {
      extraRows.push(
        <div key="subm">
          <span className="adm-muted-inline">Submitted status:</span>{' '}
          <strong>{_resolveLeadStatusLabel(submKey)}</strong>
          {submStale && (
            <Chip
              data-testid="stale-status-warning"
              color="warning"
              size="small"
              label="Status deleted"
              sx={{ ml: 1, verticalAlign: 'middle' }}
            />
          )}
        </div>,
      );
    }
  }
  return (
    <div className="adm-handler-summary">
      <div className="adm-handler-summary-head">
        <span aria-hidden="true">⚡</span>
        <span>{typeLbl}</span>
        {actionName}
        {hasStaleStatusRef && (
          <Chip
            color="warning"
            size="small"
            label="Contains deleted status"
            sx={{ ml: 1, verticalAlign: 'middle' }}
          />
        )}
      </div>
      <div className="adm-handler-summary-desc">
        {HANDLER_TYPE_DESCRIPTIONS[h.type] || 'No description available for this handler type.'}
      </div>
      {extraRows.length > 0 && <div className="adm-handler-extra">{extraRows}</div>}
      <HandlerBoundTo h={h} />
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

interface EditorOpenState { slot: ActionSlot; existing: Handler | null; }
interface ConflictResolverOpenState { stageKey: string | null; statusKey: string | null; substatusId: number | null; }

export function ActionHandlersPage() {
  usePageTitle('Action Handlers · Measure Once');
  const toast = useToast();
  const [handlers,              setHandlers]              = useState<Handler[]>([]);
  const [labels,                setLabels]                = useState<CALabel[]>([]);
  const [substatuses,           setSubstatuses]           = useState<Substatus[]>([]);
  const [statuses,              setStatuses]              = useState<LeadStatus[]>([]);
  const [conflicts,             setConflicts]             = useState<ConflictData>({ total: 0, conflicts: [] });
  const [orphanedCount,         setOrphanedCount]         = useState(0);
  const [orphanedDismissed,     setOrphanedDismissed]     = useState(false);
  const [dismissed,             setDismissed]             = useState('');
  const [loading,               setLoading]               = useState(true);
  const [editorOpen,            setEditorOpen]            = useState<EditorOpenState | null>(null);
  const [conflictResolverOpen,  setConflictResolverOpen]  = useState<ConflictResolverOpenState | null>(null);
  const everLoaded = useRef(false);

  useEffect(() => { _toastRef.fn = toast; return () => { _toastRef.fn = null; }; }, [toast]);

  // ── Fetch ──────────────────────────────────────────────────────────────────

  const fetchAll = useCallback(async () => {
    try {
      const [hdl, lbl, sub, sta, cfl, orp] = await Promise.all([
        GET('/api/admin/card-action-handlers'),
        GET('/api/admin/stage-action-labels'),
        GET('/api/admin/lead-substatuses'),
        GET('/api/admin/lead-statuses'),
        GET('/api/admin/card-action-handlers/conflicts'),
        GET('/api/admin/card-action-handlers/orphaned'),
      ]) as [Handler[], CALabel[], Substatus[], LeadStatus[], ConflictData, { count: number }];

      const safeArr = <T,>(x: unknown): T[] => Array.isArray(x) ? x as T[] : [];
      const h  = safeArr<Handler>(hdl);
      const lb = safeArr<CALabel>(lbl);
      const sb = safeArr<Substatus>(sub);
      const st = safeArr<LeadStatus>(sta);
      const cf: ConflictData = cfl && typeof cfl === 'object'
        ? { total: Number((cfl as ConflictData).total) || 0, conflicts: safeArr<ConflictItem>((cfl as ConflictData).conflicts) }
        : { total: 0, conflicts: [] };
      const orphCount = (orp && typeof orp === 'object') ? (Number((orp as { count: number }).count) || 0) : 0;

      setHandlers(h);
      setLabels(lb);
      setSubstatuses(sb);
      setStatuses(st);
      setConflicts(cf);
      setOrphanedCount(orphCount);

      _handlersRef.current    = h;
      _labelsRef.current      = lb;
      _substatusesRef.current = sb;
      _statusesRef.current    = st;
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!everLoaded.current) { everLoaded.current = true; _reloadRef.fn = fetchAll; }
    _reloadRef.fn = fetchAll;
    fetchAll();
    return () => { _reloadRef.fn = null; };
  }, [fetchAll]);

  // ── BroadcastChannel sync ──────────────────────────────────────────────────

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    let bc1: BroadcastChannel | undefined;
    let bc2: BroadcastChannel | undefined;
    try {
      bc1 = new BroadcastChannel('lead_statuses_changed');
      bc1.onmessage = () => fetchAll();
      bc2 = new BroadcastChannel('card_action_handlers_changed');
      bc2.onmessage = (ev) => { if (ev?.data?.src === _nonce) return; fetchAll(); };
    } catch { /* ignore */ }
    return () => { try { bc1?.close(); bc2?.close(); } catch { /* ignore */ } };
  }, [fetchAll]);

  // ── Window exposures ───────────────────────────────────────────────────────

  useEffect(() => {
    _openEditorRef.fn = (slot, existing) => setEditorOpen({ slot, existing: existing ?? null });
    _openConflictResolverRef.fn = (stageKey, statusKey, substatusId) =>
      setConflictResolverOpen({ stageKey, statusKey, substatusId });
    W.loadCardActionHandlersAdmin   = fetchAll;
    W.openHandlerEditor             = (slot: ActionSlot, existing?: Handler | null) =>
      _openEditorRef.fn?.(slot, existing);
    W.openConflictResolver          = (stageKey: string | null, statusKey: string | null, substatusId: number | null) =>
      _openConflictResolverRef.fn?.(stageKey, statusKey, substatusId);
    W.refreshHandlerConflictsBanner = fetchAll;
    return () => {
      _openEditorRef.fn = null;
      _openConflictResolverRef.fn = null;
      delete W.loadCardActionHandlersAdmin;
      delete W.openHandlerEditor;
      delete W.openConflictResolver;
      delete W.refreshHandlerConflictsBanner;
    };
  }, [fetchAll]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const stages = _buildActionSlotGroups();

  const conflictKey = conflicts.conflicts.map(c =>
    c.substatus_id != null ? `s:${c.substatus_id}` : `l:${c.stage_key}/${c.status_key}`
  ).sort().join('|');

  const bannerVisible = conflicts.total > 0 && dismissed !== conflictKey;

  const handleEditorSaved = async (isEdit: boolean) => {
    setEditorOpen(null);
    await _reloadAndBroadcast();
    showToast(isEdit ? 'Action updated.' : 'Action added.');
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <Stack spacing={2}>
      <Card variant="outlined">
        <CardContent>
          <Box sx={{ mb: 2 }}>
            <Typography variant="h6">Action handlers</Typography>
            <Typography variant="body2" color="text.secondary">
              Every action label from the Card actions table is listed here. Use{' '}
              <em>+ Add action</em> on a row to make that label clickable on Sales / Survey
              cards.
            </Typography>
          </Box>

          {/* Orphaned bindings banner */}
          {orphanedCount > 0 && !orphanedDismissed && (
            <Alert
              data-testid="orphaned-bindings-banner"
              severity="warning"
              onClose={() => setOrphanedDismissed(true)}
              sx={{ mb: 2 }}
            >
              <strong>{orphanedCount} legacy orphaned handler {orphanedCount === 1 ? 'binding' : 'bindings'} detected.</strong>{' '}
              The database contains {orphanedCount === 1 ? 'a row' : 'rows'} in{' '}
              <code>card_action_handler_bindings</code> with{' '}
              <code>stage_key = &apos;sales&apos;</code> and a blank <code>status_key</code>.
              These are legacy rows that should no longer exist. Run{' '}
              <code>npm run db:migrate</code> to apply the latest migrations — see the{' '}
              <a
                href="https://salsita.github.io/node-pg-migrate/"
                target="_blank"
                rel="noopener noreferrer"
              >
                migration docs
              </a>
              {' '}for guidance, or remove the rows manually from the database.
            </Alert>
          )}

          {/* Conflict banner */}
          <div
            id="card-action-handlers-conflict-banner"
            className="adm-mb-12"
            style={{ display: bannerVisible ? '' : 'none' }}
          >
            {bannerVisible && (
              <div className="adm-cab-wrap">
                <div className="adm-cab-head">
                  <div className="adm-cab-icon" aria-hidden="true">⚠️</div>
                  <div className="adm-cab-body">
                    <div className="adm-cab-title">
                      {conflicts.total === 1 ? '1 slot has' : `${conflicts.total} slots have`} duplicate handler bindings
                    </div>
                    <div className="adm-cab-desc">
                      Only one of the bound handlers will run when the action is clicked. Resolve each conflict by removing the extras.
                    </div>
                  </div>
                  <button type="button"
                    aria-label="Dismiss"
                    className="adm-cab-dismiss"
                    id="cah-conflict-banner-dismiss"
                    onClick={() => setDismissed(conflictKey)}>
                    ✕
                  </button>
                </div>
                <ul className="adm-cab-list">
                  {conflicts.conflicts.map((c, idx) => {
                    let slotDesc: string;
                    let args: [string | null, string | null, number | null];
                    if (c.substatus_id != null) {
                      const sub = substatuses.find(s => Number(s.id) === Number(c.substatus_id));
                      slotDesc = sub
                        ? `Sub-status "${sub.label || sub.substatus_key}"`
                        : `Sub-status #${c.substatus_id}`;
                      args = [null, null, c.substatus_id];
                    } else {
                      const ck = String(c.status_key || '').toLowerCase();
                      const ls = statuses.find(s => String(s.key || '').toLowerCase() === ck);
                      const lsLbl = ls ? (ls.label || ls.key) : c.status_key;
                      slotDesc = `${c.stage_key} / ${lsLbl}`;
                      args = [String(c.stage_key || ''), String(c.status_key || ''), null];
                    }
                    const names = Array.isArray(c.handler_names) ? c.handler_names.filter(Boolean) : [];
                    return (
                      <li key={idx} className="adm-cab-item">
                        <div className="adm-cab-item-body">
                          <strong>{slotDesc}</strong> has <strong>{Number(c.count) || names.length || 2} handlers</strong>
                          {names.length > 0 && (
                            <> — bound to {names.map((n, i) => (
                              <React.Fragment key={i}>{i > 0 ? ', ' : ''}<strong>{n}</strong></React.Fragment>
                            ))}</>
                          )}.
                        </div>
                        <button type="button" className="btn adm-cab-fix-btn" data-cah-fix
                          onClick={() => setConflictResolverOpen({ stageKey: args[0], statusKey: args[1], substatusId: args[2] })}>
                          Fix
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>

          {/* Handlers table */}
          <div id="card-action-handlers-wrap">
            {loading ? (
              <p className="admin-msg admin-msg--muted">Loading…</p>
            ) : !stages.length ? (
              <p className="admin-msg admin-msg--muted">No action labels defined yet — add labels in the Card actions card first.</p>
            ) : stages.map(stage => (
              <section key={stage.stage.key} className="adm-handlers-stage">
                <div className="adm-handlers-stage-head">{stage.stage.label}</div>
                {stage.groups.map(g => {
                  const lsLabel = g.ls.isNullRow
                    ? `${g.ls.label} (no lead status)` : g.ls.label;
                  return (
                    <div key={g.ls.key} className="adm-handlers-group">
                      {lsLabel && <div className="adm-handlers-group-head">{lsLabel}</div>}
                      <table className="adm-handlers-table">
                        <tbody>
                          {g.slots.map(slot => {
                            const handler = _handlersForSlot(slot)[0] || null;
                            return (
                              <tr key={`${slot.kind}-${slot.substatus_id ?? slot.status_key}`} className="adm-handlers-row">
                                <td className="adm-handlers-cell adm-handlers-cell--slot">
                                  <div className="adm-handlers-slot-label">{slot.label}</div>
                                  <div className="adm-handlers-slot-sub">{slot.rowLabel}</div>
                                  {slot.kind === 'ls' && slot.hasLabel === false && handler && (
                                    <Chip
                                      data-testid="no-label-warning"
                                      color="warning"
                                      size="small"
                                      label="No action label — add one in Card Actions"
                                      sx={{ mt: 0.5 }}
                                    />
                                  )}
                                </td>
                                <td className="adm-handlers-cell">
                                  {handler
                                    ? <HandlerSummary h={handler} />
                                    : <em className="adm-handlers-none">No action attached.</em>
                                  }
                                </td>
                                <td className="adm-handlers-cell adm-handlers-cell--actions">
                                  {handler ? (
                                    <>
                                      <button className="btn btn-ghost"
                                        onClick={() => setEditorOpen({ slot, existing: handler })}>
                                        Change
                                      </button>
                                      <button className="btn btn-ghost adm-btn-remove"
                                        onClick={() => _deleteHandler(handler.id)}>
                                        Remove
                                      </button>
                                    </>
                                  ) : (
                                    <button className="btn btn-primary adm-btn-add-action"
                                      onClick={() => setEditorOpen({ slot, existing: null })}>
                                      + Add action
                                    </button>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  );
                })}
              </section>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Handler editor modal — rendered in React, outside the card */}
      {editorOpen && (
        <HandlerEditorModal
          key={`${editorOpen.existing?.id ?? 'new'}-${editorOpen.slot.kind}-${editorOpen.slot.substatus_id ?? editorOpen.slot.status_key}`}
          slot={editorOpen.slot}
          existing={editorOpen.existing}
          handlers={handlers}
          statuses={statuses}
          substatuses={substatuses}
          onClose={() => setEditorOpen(null)}
          onSaved={handleEditorSaved}
        />
      )}

      {/* Conflict resolver modal — rendered in React, outside the card */}
      {conflictResolverOpen && (
        <ConflictResolverModal
          key={`cr-${conflictResolverOpen.substatusId ?? ''}-${conflictResolverOpen.stageKey ?? ''}-${conflictResolverOpen.statusKey ?? ''}`}
          stageKey={conflictResolverOpen.stageKey}
          statusKey={conflictResolverOpen.statusKey}
          substatusId={conflictResolverOpen.substatusId}
          handlers={handlers}
          statuses={statuses}
          substatuses={substatuses}
          onClose={() => setConflictResolverOpen(null)}
        />
      )}
    </Stack>
  );
}

export default ActionHandlersPage;
