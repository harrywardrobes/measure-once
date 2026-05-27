import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../../contexts/ToastContext';
import { Box, Card, CardContent, Stack, Typography } from '@mui/material';
import { GET, POST, PATCH, DELETE } from '../../utils/api';

// ── Constants ─────────────────────────────────────────────────────────────────

const HANDLER_TYPE_LABELS: Record<string, string> = {
  add_design_visit_to_calendar: 'Add design visit to calendar',
  schedule_visit:               'Schedule visit (any type)',
  summarise_phone_call:         'Summarise phone call',
  show_message:                 'Show informational message',
  start_design_visit:           'Start design visit wizard',
};

const HANDLER_TYPE_DESCRIPTIONS: Record<string, string> = {
  add_design_visit_to_calendar:
    'Clicking the action on a Sales/Survey card opens a modal asking for ' +
    'visit date, time, duration, title and notes.\n' +
    '• On submit, a visit is created in this CRM (POST /api/visits) and ' +
    'appears in the "Upcoming visits" section of the customer page.\n' +
    '• If the operator ticks "Also add to my Google Calendar", a matching ' +
    'event is also created in their personal Google Calendar (POST ' +
    '/api/events) using their stored Google OAuth credentials. No email is ' +
    'sent by this app — Google Calendar may email invitees if attendees ' +
    'are added.\n' +
    '• No HubSpot record is changed by this action.',
  schedule_visit:
    'Generic version of "Add design visit to calendar" — works for any visit ' +
    'type (survey, installation, remedial, workshop, etc.).\n' +
    '• Clicking the action on a card opens a MUI DateTimePicker modal asking ' +
    'for date, time, duration, title, location, and notes.\n' +
    '• On submit, a visit row is created in this CRM (POST /api/visits) with ' +
    'the visit type you select below.\n' +
    '• Optionally adds a Google Calendar event (POST /api/events).\n' +
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
}
interface ActionGroup { ls: { key: string; label: string; isNullRow: boolean }; slots: ActionSlot[]; }
interface ActionStage { stage: { key: string; label: string }; groups: ActionGroup[]; }

// ── Module-level state refs (for use by DOM-appending modal functions) ────────

const W = window as unknown as Record<string, unknown>;
const _nonce = Math.random().toString(36).slice(2);
const _reloadRef:       { fn: (() => Promise<void>) | null }          = { fn: null };
const _handlersRef:     { current: Handler[]    }                      = { current: [] };
const _labelsRef:       { current: CALabel[]    }                      = { current: [] };
const _substatusesRef:  { current: Substatus[]  }                      = { current: [] };
const _statusesRef:     { current: LeadStatus[] }                      = { current: [] };
const _toastRef:        { fn: ((m: string, err?: boolean) => void) | null } = { fn: null };

// ── Helpers ───────────────────────────────────────────────────────────────────



function showToast(msg: string, err?: boolean) {
  if (_toastRef.fn) _toastRef.fn(msg, err);
  else if (typeof W.toast === 'function') (W.toast as (m: string, e?: boolean) => void)(msg, err);
}

function esc(s: unknown): string {
  return (s == null ? '' : String(s))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

function _buildLeadStatusOnlyOptions(selectedKey: string): string {
  const real = _statusesRef.current.filter(s => !s.is_null_row);
  let html = `<option value="">— none —</option>`;
  for (const ls of real) {
    const sel = ls.key === selectedKey ? ' selected' : '';
    html += `<option value="${esc(ls.key)}"${sel}>${esc(ls.label || ls.key)}</option>`;
  }
  return html;
}

function _buildLeadStatusWithSubsOptions(selectedKey: string): string {
  const real = _statusesRef.current.filter(s => !s.is_null_row);
  const subs = _substatusesRef.current;
  let html = `<option value="">— none —</option>`;
  if (real.length) {
    html += `<optgroup label="Lead statuses">`;
    for (const ls of real) {
      const sel = ls.key === selectedKey ? ' selected' : '';
      html += `<option value="${esc(ls.key)}"${sel}>${esc(ls.label || ls.key)}</option>`;
    }
    html += `</optgroup>`;
  }
  if (subs.length) {
    html += `<optgroup label="Lead sub-statuses">`;
    for (const s of subs) {
      const val = s.substatus_key;
      const sel = val === selectedKey ? ' selected' : '';
      const lbl = s.label ? `${esc(s.label)} (${esc(s.status_key)})` : `${esc(val)} (${esc(s.status_key)})`;
      html += `<option value="${esc(val)}"${sel}>${lbl}</option>`;
    }
    html += `</optgroup>`;
  }
  return html;
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
    if (dflt || hasHandler) {
      slots.push({ kind: 'ls', stage_key: stageKey, status_key: lsKeyLower, label: dflt || ls.label, rowLabel: 'Default action' });
    }

    const lsSubs = subs.filter(s => String(s.status_key).toUpperCase() === String(ls.key).toUpperCase())
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
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

  // Null-status row (sales stage)
  if (nullRow) {
    const dflt = labelsByKey.get('sales|') || '';
    if (dflt) {
      const salesStage = stageMap.get('sales')!;
      salesStage.groups.push({
        ls: { key: '__NULL__', label: nullRow.label, isNullRow: true },
        slots: [{ kind: 'ls', stage_key: 'sales', status_key: '', label: dflt, rowLabel: 'Default action' }],
      });
    }
  }

  for (const ls of statuses) {
    const stageKey = STAGE_FOR_LS[ls.stage || ''];
    if (!stageKey) continue;
    const stage = stageMap.get(stageKey)!;
    const groups = processLs(ls, stageKey);
    stage.groups.push(...groups);
  }

  return Array.from(stageMap.values()).filter(s => s.groups.length > 0);
}

// ── DOM-appending modal functions ─────────────────────────────────────────────

async function _reloadAndBroadcast() {
  if (_reloadRef.fn) await _reloadRef.fn();
  try {
    new BroadcastChannel('card_action_handlers_changed').postMessage({ ts: Date.now(), src: _nonce });
  } catch { /* ignore */ }
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

function openHandlerEditor(slot: ActionSlot, existing?: Handler | null): void {
  const type   = existing?.type   || 'add_design_visit_to_calendar';
  const config = existing?.config || {} as Record<string, unknown>;
  const binding: Binding = slot.kind === 'sub'
    ? { substatus_id: slot.substatus_id }
    : { stage_key: slot.stage_key, status_key: slot.status_key };

  const wrap = document.createElement('div');
  wrap.className = 'js-modal-scrim';
  wrap.innerHTML = `
    <div class="adm-modal-card adm-modal-card--wide">
      <h3 class="adm-modal-title">${existing ? 'Change action' : 'Add action'}</h3>
      <p class="adm-modal-sub">for <strong>${esc(slot.label)}</strong> <span class="adm-optional">(${esc(slot.rowLabel || '')})</span></p>
      <label class="adm-modal-label">Action name <span class="adm-optional">(optional)</span></label>
      <input id="cah-action-name" type="text" class="field adm-field-sm" maxlength="80" placeholder="e.g. send_quote" value="${esc(String(config.action_name || ''))}">
      <div id="cah-action-name-err" class="adm-err-line--sm hidden">Only lowercase letters, digits, and underscores are allowed (e.g. <code>send_quote</code>).</div>
      <div class="adm-info-amber">⚙️ Backend automation coming soon — this name will be used to trigger workflows automatically once wired up.</div>
      <label class="adm-modal-label">Action type</label>
      <select id="cah-type" class="field">
        ${Object.entries(HANDLER_TYPE_LABELS).map(([k, v]) =>
          `<option value="${k}" ${k === type ? 'selected' : ''}>${esc(v)}</option>`).join('')}
      </select>
      <div id="cah-type-desc" class="adm-type-desc"></div>
      <div id="cah-sv-block" class="hidden adm-block-mt12">
        <label class="adm-modal-label adm-modal-label--first">Visit type</label>
        <select id="cah-sv-type" class="field adm-field-sm">
          <option value="survey"       ${String(config.visitType || 'survey') === 'survey'       ? 'selected' : ''}>Survey</option>
          <option value="installation" ${String(config.visitType || '') === 'installation' ? 'selected' : ''}>Installation</option>
          <option value="remedial"     ${String(config.visitType || '') === 'remedial'     ? 'selected' : ''}>Remedial</option>
          <option value="workshop"     ${String(config.visitType || '') === 'workshop'     ? 'selected' : ''}>Workshop</option>
          <option value="design"       ${String(config.visitType || '') === 'design'       ? 'selected' : ''}>Design visit</option>
          <option value="other"        ${String(config.visitType || '') === 'other'        ? 'selected' : ''}>Other</option>
        </select>
        <div class="adm-mt-10">
          <label class="adm-modal-label adm-modal-label--first">Default duration (min) <span class="adm-optional">(optional)</span></label>
          <input id="cah-sv-duration" type="number" class="field adm-field-sm" min="5" max="1440" step="5" value="${esc(String(config.defaultDurationMin || 60))}">
        </div>
        <div class="adm-mt-8">
          <label class="adm-checkbox-row">
            <input type="checkbox" id="cah-sv-google" ${config.addToGoogleCalendar !== false ? 'checked' : ''}>
            Also add to Google Calendar
          </label>
        </div>
      </div>
      <div id="cah-msg-block" class="hidden adm-block-mt12">
        <label class="adm-modal-label adm-modal-label--first">Popup title (optional)</label>
        <input id="cah-msg-title" type="text" class="field adm-field-sm" maxlength="120">
        <label class="adm-modal-label adm-modal-label--sm">Message to display <span class="adm-req">*</span></label>
        <textarea id="cah-msg-body" class="field adm-field-sm" rows="4" maxlength="2000" placeholder="What should the operator do when they click this label?"></textarea>
        <div class="adm-hint">Shown verbatim in a popup. Plain text only; line breaks are preserved.</div>
      </div>
      <div id="cah-sdv-block" class="hidden adm-block-mt12">
        <div>
          <label class="adm-modal-label adm-modal-label--first">Default duration (min)</label>
          <input id="cah-sdv-duration" type="number" class="field adm-field-sm" min="5" max="1440" step="5" value="${esc(String(config.defaultDurationMin || 90))}">
        </div>
        <div class="adm-mt-10">
          <label class="adm-modal-label adm-modal-label--first">In-progress lead status <span class="adm-optional">(optional — set when wizard opens)</span></label>
          <select id="cah-sdv-lead-status-intermediate" class="field adm-field-sm">${_buildLeadStatusOnlyOptions(String(config.intermediateLeadStatus || ''))}</select>
        </div>
        <div class="adm-info-blue"><strong>Two-phase status flow:</strong> Opening the wizard sets the in-progress status. Submitting the form sets the submitted status.</div>
        <div class="adm-mt-8">
          <label class="adm-modal-label adm-modal-label--first">Submitted lead status <span class="adm-optional">(optional — set on submit)</span></label>
          <select id="cah-sdv-lead-status-submitted" class="field adm-field-sm">${_buildLeadStatusWithSubsOptions(String(config.submittedLeadStatus || ''))}</select>
        </div>
        <div class="adm-mt-10">
          <label class="adm-modal-label adm-modal-label--first">Terms &amp; Conditions <span class="adm-optional">(optional, ≤4000 chars)</span></label>
          <textarea id="cah-sdv-terms" class="field adm-field-xs" rows="4" maxlength="4000" placeholder="Your terms and conditions text…">${esc(String(config.termsAndConditions || ''))}</textarea>
        </div>
        <div class="adm-mt-8">
          <label class="adm-checkbox-row">
            <input type="checkbox" id="cah-sdv-google" ${config.addToGoogleCalendar !== false ? 'checked' : ''}>
            Also add to Google Calendar
          </label>
        </div>
      </div>
      <div id="cah-cfg-block" class="adm-block-mt12">
        <label class="adm-modal-label adm-modal-label--first">Advanced configuration (JSON, optional)</label>
        <textarea id="cah-config" class="field adm-field-mono-xs" rows="4">${esc(JSON.stringify(config, null, 2))}</textarea>
      </div>
      <div id="cah-conflict" class="hidden adm-conflict-box">
        <div class="adm-conflict-box-head">⚠️ Slot already has a handler</div>
        <div id="cah-conflict-list" class="adm-conflict-box-list"></div>
        <div class="adm-conflict-box-actions">
          <button class="btn btn-ghost adm-btn-conflict" id="cah-conflict-cancel">Keep editing</button>
          <button class="btn adm-btn-conflict adm-btn-conflict--primary" id="cah-conflict-confirm">Bind anyway</button>
        </div>
      </div>
      <div id="cah-edit-err" class="adm-err-line"></div>
      <div class="adm-modal-actions">
        <button class="btn btn-ghost" id="cah-cancel">Cancel</button>
        <button class="btn btn-primary" id="cah-save">${existing ? 'Save' : 'Add'}</button>
      </div>
    </div>`;

  document.body.appendChild(wrap);

  const descEl       = wrap.querySelector('#cah-type-desc')       as HTMLElement;
  const typeSel      = wrap.querySelector('#cah-type')            as HTMLSelectElement;
  const svBlock      = wrap.querySelector('#cah-sv-block')        as HTMLElement;
  const msgBlock     = wrap.querySelector('#cah-msg-block')       as HTMLElement;
  const sdvBlock     = wrap.querySelector('#cah-sdv-block')       as HTMLElement;
  const cfgBlock     = wrap.querySelector('#cah-cfg-block')       as HTMLElement;
  const msgTitle     = wrap.querySelector('#cah-msg-title')       as HTMLInputElement;
  const msgBody      = wrap.querySelector('#cah-msg-body')        as HTMLTextAreaElement;
  const conflictBox  = wrap.querySelector('#cah-conflict')        as HTMLElement;
  const conflictList = wrap.querySelector('#cah-conflict-list')   as HTMLElement;
  const actionNameIn = wrap.querySelector('#cah-action-name')     as HTMLInputElement;
  const actionNameEr = wrap.querySelector('#cah-action-name-err') as HTMLElement;

  if (type === 'show_message') {
    msgTitle.value = String(config.title   || '');
    msgBody.value  = String(config.message || '');
  }

  const renderForType = () => {
    const t = typeSel.value;
    descEl.textContent = HANDLER_TYPE_DESCRIPTIONS[t] || '';
    const isMsg = t === 'show_message', isSdv = t === 'start_design_visit';
    const isSv  = t === 'schedule_visit';
    svBlock.style.display  = isSv            ? '' : 'none';
    msgBlock.style.display = isMsg           ? '' : 'none';
    sdvBlock.style.display = isSdv           ? '' : 'none';
    cfgBlock.style.display = (isMsg || isSdv || isSv) ? 'none' : '';
  };
  renderForType();
  typeSel.addEventListener('change', () => { conflictBox.style.display = 'none'; renderForType(); });
  wrap.addEventListener('click', e => { if (e.target === wrap) wrap.remove(); });
  wrap.querySelector('#cah-cancel')!.addEventListener('click', () => wrap.remove());
  wrap.querySelector('#cah-conflict-cancel')!.addEventListener('click', () => { conflictBox.style.display = 'none'; });

  const SNAKE_RE = /^[a-z0-9_]*$/;
  const validateActionName = () => {
    const v = actionNameIn.value.trim();
    const invalid = v.length > 0 && !SNAKE_RE.test(v);
    actionNameEr.classList.toggle('hidden', !invalid);
    return !invalid;
  };
  actionNameIn.addEventListener('blur', validateActionName);

  const buildPayload = () => {
    const tp    = typeSel.value;
    const errEl = wrap.querySelector('#cah-edit-err') as HTMLElement;
    errEl.textContent = '';
    if (!validateActionName()) {
      errEl.textContent = 'Action name may only contain lowercase letters, digits, and underscores.';
      return null;
    }
    let cfg: Record<string, unknown>;
    if (tp === 'schedule_visit') {
      const visitType = (wrap.querySelector('#cah-sv-type') as HTMLSelectElement).value;
      const durVal    = parseInt((wrap.querySelector('#cah-sv-duration') as HTMLInputElement).value, 10);
      const gcal      = (wrap.querySelector('#cah-sv-google') as HTMLInputElement).checked;
      if (durVal && (isNaN(durVal) || durVal < 5 || durVal > 1440)) {
        errEl.textContent = 'Default duration must be between 5 and 1440 minutes.'; return null;
      }
      cfg = { visitType };
      if (durVal) cfg.defaultDurationMin = durVal;
      cfg.addToGoogleCalendar = gcal;
    } else if (tp === 'show_message') {
      const message = msgBody.value.trim();
      if (!message) { errEl.textContent = 'Message is required for "Show informational message".'; return null; }
      cfg = { message };
      const titleV = msgTitle.value.trim();
      if (titleV) cfg.title = titleV;
    } else if (tp === 'start_design_visit') {
      const durVal  = parseInt((wrap.querySelector('#cah-sdv-duration') as HTMLInputElement).value, 10);
      const lsInter = (wrap.querySelector('#cah-sdv-lead-status-intermediate') as HTMLSelectElement).value;
      const lsSub   = (wrap.querySelector('#cah-sdv-lead-status-submitted')    as HTMLSelectElement).value;
      const terms   = (wrap.querySelector('#cah-sdv-terms') as HTMLTextAreaElement).value;
      const gcal    = (wrap.querySelector('#cah-sdv-google') as HTMLInputElement).checked;
      if (durVal && (isNaN(durVal) || durVal < 5 || durVal > 1440)) {
        errEl.textContent = 'Default duration must be between 5 and 1440 minutes.'; return null;
      }
      cfg = {};
      if (durVal) cfg.defaultDurationMin = durVal;
      if (lsInter) cfg.intermediateLeadStatus = lsInter;
      if (lsSub)   cfg.submittedLeadStatus    = lsSub;
      if (terms)   cfg.termsAndConditions     = terms;
      cfg.addToGoogleCalendar = gcal;
    } else {
      const cfgTxt = (wrap.querySelector('#cah-config') as HTMLTextAreaElement).value.trim() || '{}';
      try { cfg = JSON.parse(cfgTxt); }
      catch { errEl.textContent = 'Configuration is not valid JSON.'; return null; }
    }
    const av = actionNameIn.value.trim();
    if (av) cfg.action_name = av; else delete cfg.action_name;
    return { name: '', type: tp, config: cfg, bindings: [binding] };
  };

  const doSave = async (payload: Record<string, unknown>) => {
    const errEl = wrap.querySelector('#cah-edit-err') as HTMLElement;
    try {
      if (existing) await PATCH(`/api/admin/card-action-handlers/${existing.id}`, payload);
      else          await POST('/api/admin/card-action-handlers', payload);
      wrap.remove();
      await _reloadAndBroadcast();
      showToast(existing ? 'Action updated.' : 'Action added.');
    } catch (e) {
      errEl.textContent = (e as Error).message || 'Save failed.';
    }
  };

  wrap.querySelector('#cah-conflict-confirm')!.addEventListener('click', async () => {
    conflictBox.style.display = 'none';
    const payload = buildPayload();
    if (payload) await doSave(payload);
  });

  wrap.querySelector('#cah-save')!.addEventListener('click', async () => {
    const payload = buildPayload();
    if (!payload) return;
    const conflicts = _handlersForSlot(slot).filter(h => !existing || h.id !== existing.id);
    if (conflicts.length > 0) {
      const slotLabel = slot.label || (slot.substatus_id != null
        ? `sub-status #${slot.substatus_id}` : `${slot.stage_key} / ${slot.status_key}`);
      conflictList.innerHTML = conflicts.map(h =>
        `<div>• <strong>${esc(slotLabel)}</strong> is already wired to <strong>${esc(h.name || HANDLER_TYPE_LABELS[h.type] || h.type)}</strong> — bind anyway?</div>`
      ).join('');
      conflictBox.style.display = '';
      conflictBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    await doSave(payload);
  });
}

function openConflictResolver(
  stageKey: string | null,
  statusKey: string | null,
  substatusId: number | null,
): void {
  const slot: Partial<ActionSlot> = substatusId != null
    ? { substatus_id: Number(substatusId) }
    : { stage_key: stageKey || '', status_key: statusKey || '' };

  const handlers = _handlersForSlot(slot);
  if (!handlers.length) return;

  let slotDesc: string;
  if (substatusId != null) {
    const sub = _substatusesRef.current.find(s => Number(s.id) === Number(substatusId));
    slotDesc = sub ? `sub-status "${esc(sub.label || sub.substatus_key)}"` : `sub-status #${substatusId}`;
  } else {
    const ls = _statusesRef.current.find(s => s.key === statusKey);
    slotDesc = ls ? `"${esc(ls.label)}"` : `${esc(stageKey)} / ${esc(statusKey)}`;
  }

  const rowsHtml = handlers.map(h => {
    const typeLbl = HANDLER_TYPE_LABELS[h.type] || h.type;
    const desc    = HANDLER_TYPE_DESCRIPTIONS[h.type] || '';
    return `
      <div class="ca-conflict-row adm-conflict-row" data-handler-id="${h.id}">
        <div class="adm-conflict-row-body">
          <div class="adm-conflict-row-title">
            <span aria-hidden="true" class="adm-conflict-row-icon">⚡</span>${esc(typeLbl)}
          </div>
          ${desc ? `<div class="adm-conflict-row-desc">${esc(desc)}</div>` : ''}
        </div>
        <button type="button" class="btn btn-ghost ca-conflict-remove-btn adm-conflict-remove" data-handler-id="${h.id}">Remove</button>
      </div>`;
  }).join('');

  const wrap = document.createElement('div');
  wrap.className = 'js-modal-scrim';
  wrap.innerHTML = `
    <div class="adm-modal-card">
      <h3 class="adm-modal-title adm-modal-title--big">Fix conflicting handlers</h3>
      <p class="adm-modal-sub">
        The slot ${slotDesc} has <strong>${handlers.length} handlers</strong> bound to it.
        Remove all but one to resolve the conflict.
      </p>
      <div class="adm-modal-list" id="ca-conflict-list">${rowsHtml}</div>
      <div id="ca-conflict-err" class="adm-err-line"></div>
      <div class="adm-modal-actions">
        <button class="btn btn-ghost" id="ca-conflict-close">Close</button>
      </div>
    </div>`;

  document.body.appendChild(wrap);
  wrap.addEventListener('click', e => { if (e.target === wrap) wrap.remove(); });
  wrap.querySelector('#ca-conflict-close')!.addEventListener('click', () => wrap.remove());

  wrap.querySelector('#ca-conflict-list')!.addEventListener('click', async e => {
    const btn = (e.target as Element).closest<HTMLButtonElement>('.ca-conflict-remove-btn');
    if (!btn) return;
    const id = Number(btn.dataset.handlerId);
    const errEl = wrap.querySelector('#ca-conflict-err') as HTMLElement;
    errEl.textContent = '';
    btn.disabled = true; btn.textContent = 'Removing…';
    try {
      await DELETE(`/api/admin/card-action-handlers/${id}`);
      await _reloadAndBroadcast();
      showToast('Handler removed.');
      const remaining = _handlersForSlot(slot);
      if (remaining.length <= 1) {
        wrap.remove();
        _flashResolvedBadge(slot);
      } else {
        const row = wrap.querySelector(`.ca-conflict-row[data-handler-id="${id}"]`);
        if (row) row.remove();
        btn.disabled = false; btn.textContent = 'Remove';
      }
    } catch (err) {
      errEl.textContent = 'Remove failed: ' + ((err as Error).message || 'unknown error');
      btn.disabled = false; btn.textContent = 'Remove';
    }
  });
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

function HandlerSummary({ h }: { h: Handler }) {
  const typeLbl = HANDLER_TYPE_LABELS[h.type] || h.type;
  const actionName = h.config?.action_name ? (
    <span className="adm-handler-actionname">{String(h.config.action_name)}</span>
  ) : null;
  const extraRows: React.ReactNode[] = [];
  if (h.type === 'start_design_visit') {
    if (h.config?.intermediateLeadStatus) {
      extraRows.push(
        <div key="inter"><span className="adm-muted-inline">In-progress status:</span>{' '}
          <strong>{_resolveLeadStatusLabel(String(h.config.intermediateLeadStatus))}</strong></div>
      );
    }
    if (h.config?.submittedLeadStatus) {
      extraRows.push(
        <div key="subm"><span className="adm-muted-inline">Submitted status:</span>{' '}
          <strong>{_resolveLeadStatusLabel(String(h.config.submittedLeadStatus))}</strong></div>
      );
    }
  }
  return (
    <div className="adm-handler-summary">
      <div className="adm-handler-summary-head">
        <span aria-hidden="true">⚡</span>
        <span>{typeLbl}</span>
        {actionName}
      </div>
      <div className="adm-handler-summary-desc">
        {HANDLER_TYPE_DESCRIPTIONS[h.type] || 'No description available for this handler type.'}
      </div>
      {extraRows.length > 0 && <div className="adm-handler-extra">{extraRows}</div>}
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ActionHandlersPage() {
  const toast = useToast();
  const [handlers,    setHandlers]    = useState<Handler[]>([]);
  const [labels,      setLabels]      = useState<CALabel[]>([]);
  const [substatuses, setSubstatuses] = useState<Substatus[]>([]);
  const [statuses,    setStatuses]    = useState<LeadStatus[]>([]);
  const [conflicts,   setConflicts]   = useState<ConflictData>({ total: 0, conflicts: [] });
  const [dismissed,   setDismissed]   = useState('');
  const [loading,     setLoading]     = useState(true);
  const everLoaded = useRef(false);

  useEffect(() => { _toastRef.fn = toast; return () => { _toastRef.fn = null; }; }, [toast]);

  // ── Fetch ──────────────────────────────────────────────────────────────────

  const fetchAll = useCallback(async () => {
    try {
      const [hdl, lbl, sub, sta, cfl] = await Promise.all([
        GET('/api/admin/card-action-handlers'),
        GET('/api/admin/stage-action-labels'),
        GET('/api/admin/lead-substatuses'),
        GET('/api/admin/lead-statuses'),
        GET('/api/admin/card-action-handlers/conflicts'),
      ]) as [Handler[], CALabel[], Substatus[], LeadStatus[], ConflictData];

      const safeArr = <T,>(x: unknown): T[] => Array.isArray(x) ? x as T[] : [];
      const h  = safeArr<Handler>(hdl);
      const lb = safeArr<CALabel>(lbl);
      const sb = safeArr<Substatus>(sub);
      const st = safeArr<LeadStatus>(sta);
      const cf: ConflictData = cfl && typeof cfl === 'object'
        ? { total: Number((cfl as ConflictData).total) || 0, conflicts: safeArr<ConflictItem>((cfl as ConflictData).conflicts) }
        : { total: 0, conflicts: [] };

      setHandlers(h);
      setLabels(lb);
      setSubstatuses(sb);
      setStatuses(st);
      setConflicts(cf);

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
    W.loadCardActionHandlersAdmin     = fetchAll;
    W.openHandlerEditor               = openHandlerEditor;
    W.openConflictResolver            = openConflictResolver;
    W.refreshHandlerConflictsBanner   = fetchAll;
    return () => {
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
                          onClick={() => openConflictResolver(args[0], args[1], args[2])}>
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
                      <div className="adm-handlers-group-head">{lsLabel}</div>
                      <table className="adm-handlers-table">
                        <tbody>
                          {g.slots.map(slot => {
                            const handler = _handlersForSlot(slot)[0] || null;
                            return (
                              <tr key={`${slot.kind}-${slot.substatus_id ?? slot.status_key}`} className="adm-handlers-row">
                                <td className="adm-handlers-cell adm-handlers-cell--slot">
                                  <div className="adm-handlers-slot-label">{slot.label}</div>
                                  <div className="adm-handlers-slot-sub">{slot.rowLabel}</div>
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
                                        onClick={() => openHandlerEditor(slot, handler)}>
                                        Change
                                      </button>
                                      <button className="btn btn-ghost adm-btn-remove"
                                        onClick={() => _deleteHandler(handler.id)}>
                                        Remove
                                      </button>
                                    </>
                                  ) : (
                                    <button className="btn btn-primary adm-btn-add-action"
                                      onClick={() => openHandlerEditor(slot, null)}>
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
    </Stack>
  );
}

export default ActionHandlersPage;
