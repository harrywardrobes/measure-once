// Card action modals — dispatch + modal implementations, plus the lookup index.
//
// Loaded on sales.html.  The React SalesBoardPage now uses the
// useCardActionHandlers hook for its own lookup, so the board renders
// independently of this file.  However, this file still provides:
//
//   window.cardActionHandlerFor      — lookup for test probes + vanilla helpers
//   window.loadCardActionHandlers    — explicit re-fetch (called by test suite)
//   window.cardActionHandlerAttrs    — attr-string helper (test probe E.2)
//   window.enquiryRowHtml            — card-strip html helper (test probe E.3)
//   window.dispatchCardActionHandler — modal dispatch (used by React onClick)
//   window.openDesignVisitWizard     — multi-step wizard
//
// survey.html and customer-detail.html continue to load card-action-handlers.js
// which provides BOTH the lookup AND dispatch in a single IIFE.

(function () {
  // ── Lookup index ──────────────────────────────────────────────────────────

  let HANDLERS_BY_LABEL    = {}; // `${stage}|${status}` → handler
  let HANDLERS_BY_SUBSTATUS = {}; // substatus_id → handler
  let HANDLERS_BY_ID       = {}; // handler.id → handler

  function _indexHandlers(rows) {
    const byLabel = {};
    const bySub   = {};
    const byId    = {};
    for (const h of rows || []) {
      byId[h.id] = h;
      for (const b of h.bindings || []) {
        if (b.substatus_id) {
          bySub[b.substatus_id] = h;
        } else if (b.stage_key) {
          const sk = String(b.stage_key  || '').toLowerCase();
          const lk = String(b.status_key || '').toLowerCase();
          byLabel[`${sk}|${lk}`] = h;
        }
      }
    }
    HANDLERS_BY_LABEL    = byLabel;
    HANDLERS_BY_SUBSTATUS = bySub;
    HANDLERS_BY_ID       = byId;
  }

  async function loadCardActionHandlers() {
    try {
      const rows = await GET('/api/card-action-handlers');
      _indexHandlers(rows);
    } catch (e) {
      console.warn('Could not load card action handlers:', e.message);
    }
  }
  window.loadCardActionHandlers = loadCardActionHandlers;

  // Resolve handler for a card. Substatus binding wins (more specific).
  // Reads window.LEAD_SUBSTATUSES which is populated by workflow-core.js's
  // loadLeadSubstatuses().
  function cardActionHandlerFor(stageKey, leadStatusKey, hwSubstatusValue) {
    if (hwSubstatusValue && Array.isArray(window.LEAD_SUBSTATUSES)) {
      const v  = String(hwSubstatusValue).toUpperCase();
      const sk = String(leadStatusKey || '').toUpperCase();
      const prefix = `${sk}__`;
      if (v.startsWith(prefix)) {
        const subKey = v.slice(prefix.length);
        const row = window.LEAD_SUBSTATUSES.find(
          r => String(r.status_key).toUpperCase() === sk &&
               String(r.substatus_key).toUpperCase() === subKey
        );
        if (row && HANDLERS_BY_SUBSTATUS[row.id]) return HANDLERS_BY_SUBSTATUS[row.id];
      }
    }
    const sKey  = String(stageKey || '').toLowerCase();
    const lsKey = String(leadStatusKey || '').toLowerCase();
    return HANDLERS_BY_LABEL[`${sKey}|${lsKey}`] || null;
  }
  window.cardActionHandlerFor = cardActionHandlerFor;

  function cardActionHandlerAttrs(stageKey, leadStatusKey, hwSubstatusValue, ctx) {
    const h = cardActionHandlerFor(stageKey, leadStatusKey, hwSubstatusValue);
    if (!h) return '';
    const safe = s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    return ` data-card-action-handler-id="${h.id}"` +
           ` data-card-action-handler-type="${safe(h.type)}"` +
           (h.config?.action_name ? ` data-card-action-name="${safe(h.config.action_name)}"` : '') +
           (ctx?.contactId    ? ` data-card-action-contact-id="${safe(ctx.contactId)}"`       : '') +
           (ctx?.contactName  ? ` data-card-action-contact-name="${safe(ctx.contactName)}"`   : '') +
           (ctx?.contactEmail ? ` data-card-action-contact-email="${safe(ctx.contactEmail)}"` : '');
  }
  window.cardActionHandlerAttrs = cardActionHandlerAttrs;

  function enquiryRowHtml(entry) {
    const contact = (entry && entry.contact) || {};
    const stageKey = (entry && entry.stageKey) || 'sales';
    const props = contact.properties || {};
    const leadStatusKey     = props.hs_lead_status    || '';
    const hwSubstatusValue  = props.hw_lead_substatus || '';
    const firstName  = props.firstname || '';
    const lastName   = props.lastname  || '';
    const name = [firstName, lastName].filter(Boolean).join(' ') || props.email || '';
    const ctx = {
      contactId:    contact.id       || '',
      contactName:  name,
      contactEmail: props.email      || '',
    };

    const attrsStr = cardActionHandlerAttrs(stageKey, leadStatusKey, hwSubstatusValue, ctx);
    const cahMatch = attrsStr.match(/data-card-action-name="([^"]+)"/);
    const cahName  = cahMatch
      ? cahMatch[1].replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); })
      : '';
    const actionLabel = cahName;

    const safe = s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const actionStrip = actionLabel
      ? '<div class="eq-card-action"' + attrsStr + '>' +
          '<span class="eq-card-action-label">' + safe(actionLabel) + '</span>' +
        '</div>'
      : '';

    return '<div class="eq-card">' + actionStrip + '</div>';
  }
  window.enquiryRowHtml = enquiryRowHtml;

  // ── Shared helpers ────────────────────────────────────────────────────────

  const MODAL_CSS = `
    .cah-backdrop { position:fixed; inset:0; background:var(--overlay-scrim); display:flex;
      align-items:center; justify-content:center; z-index:var(--z-tooltip); padding:16px; }
    .cah-modal { background:#fff; border-radius:12px; padding:20px 22px; width:100%;
      max-width:460px; box-shadow:0 20px 60px rgba(0,0,0,0.25); font-family:inherit; }
    .cah-modal h3 { margin:0 0 14px; font-size:1.05rem; font-weight:700; color:#1f2937; }
    .cah-modal label { display:block; font-size:0.78rem; color:#4b5563; margin:8px 0 4px; font-weight:600; }
    .cah-modal input, .cah-modal textarea, .cah-modal select {
      width:100%; padding:8px 10px; border:1px solid #d1d5db; border-radius:8px;
      font-size:0.92rem; font-family:inherit; background:#fff; box-sizing:border-box;
    }
    .cah-modal textarea { resize:vertical; min-height:120px; }
    .cah-modal .cah-row { display:flex; gap:10px; }
    .cah-modal .cah-row > * { flex:1; }
    .cah-modal .cah-actions { margin-top:18px; display:flex; gap:8px; justify-content:flex-end; }
    .cah-modal .cah-actions button { padding:8px 16px; border-radius:8px; border:none;
      font-size:0.88rem; font-weight:600; cursor:pointer; }
    .cah-modal .cah-cancel { background:#f3f4f6; color:#374151; }
    .cah-modal .cah-primary { background:#8B2BFF; color:#fff; }
    .cah-modal .cah-primary:disabled { opacity:0.6; cursor:not-allowed; }
    .cah-modal .cah-error { color:#b91c1c; font-size:0.82rem; margin-top:8px; min-height:18px; }
    .cah-modal .cah-checkbox-row { display:flex; align-items:center; gap:8px; margin-top:10px; }
    .cah-modal .cah-checkbox-row input { width:auto; }
    .cah-modal .cah-checkbox-row label { margin:0; }
  `;

  let _styleInjected = false;
  function _injectStyle() {
    if (_styleInjected) return;
    const s = document.createElement('style');
    s.textContent = MODAL_CSS;
    document.head.appendChild(s);
    _styleInjected = true;
  }

  function _openModal(html) {
    _injectStyle();
    const wrap = document.createElement('div');
    wrap.className = 'cah-backdrop';
    wrap.innerHTML = `<div class="cah-modal">${html}</div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
    return wrap;
  }

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _toast(msg, isErr) {
    return showToast(msg, !!isErr);
  }

  // ── dispatchCardActionHandler ─────────────────────────────────────────────

  function dispatchCardActionHandler(handler, ctx) {
    if (handler.type === 'add_design_visit_to_calendar') return openDesignVisitModal(handler, ctx);
    if (handler.type === 'summarise_phone_call')        return openPhoneSummaryModal(handler, ctx);
    if (handler.type === 'show_message')                return openMessagePopup(handler, ctx);
    if (handler.type === 'start_design_visit')          return openDesignVisitWizard(handler, ctx);
    console.warn('Unknown card action handler type:', handler.type);
  }

  // ── Handler: show_message ─────────────────────────────────────────────────

  function openMessagePopup(handler /*, ctx */) {
    const cfg = handler.config || {};
    const title   = cfg.title   || 'Action required';
    const message = cfg.message || '';
    const wrap = _openModal(`
      <h3>${_esc(title)}</h3>
      <div style="font-size:0.9rem;color:#374151;line-height:1.5;white-space:pre-line;">${_esc(message)}</div>
      <div class="cah-actions">
        <button class="cah-primary" type="button">OK</button>
      </div>
    `);
    const close = () => wrap.remove();
    wrap.querySelector('.cah-primary').addEventListener('click', close);
  }

  // ── Handler: add_design_visit_to_calendar ──────────────────────────────────

  function openDesignVisitModal(handler, ctx) {
    const cfg = handler.config || {};
    const duration = cfg.defaultDurationMin || 60;
    const title    = cfg.defaultTitle       || (ctx.contactName ? `Design visit — ${ctx.contactName}` : 'Design visit');
    const addToGoogle = cfg.addToGoogleCalendar !== false;

    const now = new Date();
    now.setMinutes(0, 0, 0);
    now.setHours(now.getHours() + 24);
    const startDefault = _toLocalInputValue(now);

    const wrap = _openModal(`
      <h3>Schedule design visit${ctx.contactName ? ` for ${_esc(ctx.contactName)}` : ''}</h3>
      <label>Title</label>
      <input type="text" id="cah-dv-title" value="${_esc(title)}" maxlength="120">
      <div class="cah-row">
        <div>
          <label>Start</label>
          <input type="datetime-local" id="cah-dv-start" value="${_esc(startDefault)}">
        </div>
        <div>
          <label>Duration (min)</label>
          <input type="number" id="cah-dv-duration" value="${duration}" min="5" max="1440" step="5">
        </div>
      </div>
      <label>Location (optional)</label>
      <input type="text" id="cah-dv-location" maxlength="300" placeholder="Customer address">
      <label>Notes (optional)</label>
      <textarea id="cah-dv-notes" maxlength="4000" placeholder="Anything the designer should know"></textarea>
      <div class="cah-checkbox-row">
        <input type="checkbox" id="cah-dv-google" ${addToGoogle ? 'checked' : ''}>
        <label for="cah-dv-google">Also add to my Google Calendar</label>
      </div>
      <div class="cah-error" id="cah-dv-error"></div>
      <div class="cah-actions">
        <button class="cah-cancel"  type="button">Cancel</button>
        <button class="cah-primary" type="button">Schedule</button>
      </div>
    `);

    wrap.querySelector('.cah-cancel').addEventListener('click', () => wrap.remove());
    const submitBtn = wrap.querySelector('.cah-primary');
    submitBtn.addEventListener('click', async () => {
      const errEl = wrap.querySelector('#cah-dv-error');
      errEl.textContent = '';
      const titleV    = wrap.querySelector('#cah-dv-title').value.trim();
      const startV    = wrap.querySelector('#cah-dv-start').value;
      const durationV = parseInt(wrap.querySelector('#cah-dv-duration').value, 10);
      const locationV = wrap.querySelector('#cah-dv-location').value.trim();
      const notesV    = wrap.querySelector('#cah-dv-notes').value.trim();
      const addGcal   = wrap.querySelector('#cah-dv-google').checked;

      if (!titleV) { errEl.textContent = 'Title is required.'; return; }
      if (!startV) { errEl.textContent = 'Start time is required.'; return; }
      if (!Number.isInteger(durationV) || durationV < 5) { errEl.textContent = 'Duration must be ≥ 5 minutes.'; return; }

      const start = new Date(startV);
      const end   = new Date(start.getTime() + durationV * 60000);

      submitBtn.disabled = true; submitBtn.textContent = 'Scheduling…';
      try {
        await POST('/api/visits', {
          type:         'design',
          title:        titleV,
          customerId:   ctx.contactId || null,
          customerName: ctx.contactName || null,
          startAt:      start.toISOString(),
          endAt:        end.toISOString(),
          location:     locationV || null,
          notes:        notesV    || null,
        });
        if (addGcal) {
          try {
            await POST('/api/events', {
              summary:     titleV,
              description: notesV || '',
              location:    locationV || '',
              start:       { dateTime: start.toISOString() },
              end:         { dateTime: end.toISOString() },
            });
          } catch (e) {
            _toast('Visit saved; Google Calendar add failed: ' + (e.message || 'error'), true);
            wrap.remove();
            if (typeof window.renderUpcomingVisits === 'function') {
              try { window.renderUpcomingVisits(); } catch (_) {}
            }
            return;
          }
        }
        _toast('Visit scheduled');
        wrap.remove();
        if (typeof window.renderUpcomingVisits === 'function') {
          try { window.renderUpcomingVisits(); } catch (_) {}
        }
      } catch (e) {
        submitBtn.disabled = false; submitBtn.textContent = 'Schedule';
        errEl.textContent = 'Could not save: ' + (e.message || 'error');
      }
    });
  }

  function _toLocalInputValue(d) {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // ── Handler: summarise_phone_call ──────────────────────────────────────────

  function openPhoneSummaryModal(handler, ctx) {
    const cfg = handler.config || {};
    if (!ctx.contactId) {
      _toast('No contact selected — open the customer first.', true);
      return;
    }
    const wrap = _openModal(`
      <h3>Phone call summary${ctx.contactName ? ` — ${_esc(ctx.contactName)}` : ''}</h3>
      <label>What did you discuss?</label>
      <textarea id="cah-pc-summary" maxlength="8000" placeholder="Outcome, next steps, agreed timeline…" autofocus></textarea>
      <div class="cah-error" id="cah-pc-error"></div>
      <div class="cah-actions">
        <button class="cah-cancel"  type="button">Cancel</button>
        <button class="cah-primary" type="button">Save note</button>
      </div>
    `);

    wrap.querySelector('.cah-cancel').addEventListener('click', () => wrap.remove());
    const submitBtn = wrap.querySelector('.cah-primary');
    submitBtn.addEventListener('click', async () => {
      const errEl = wrap.querySelector('#cah-pc-error');
      errEl.textContent = '';
      const summary = wrap.querySelector('#cah-pc-summary').value.trim();
      if (!summary) { errEl.textContent = 'Please type a summary first.'; return; }

      submitBtn.disabled = true; submitBtn.textContent = 'Saving…';
      try {
        await POST('/api/card-actions/phone-call-summary', {
          contactId:  ctx.contactId,
          summary,
          notePrefix: cfg.notePrefix || '',
        });
        wrap.remove();
        _toast('Note saved to HubSpot');
        _offerFollowUpEmail(handler, ctx, summary);
      } catch (e) {
        submitBtn.disabled = false; submitBtn.textContent = 'Save note';
        if (e.code === 'HUBSPOT_AUTH') {
          errEl.textContent = 'HubSpot rejected the request — check the token.';
        } else {
          errEl.textContent = 'Could not save: ' + (e.message || 'error');
        }
      }
    });
  }

  function _offerFollowUpEmail(handler, ctx, summary) {
    const cfg = handler.config || {};
    const wrap = _openModal(`
      <h3>Draft a follow-up email?</h3>
      <p style="font-size:0.88rem;color:#4b5563;margin:0 0 8px;">We can open your email composer pre-filled with this call summary.</p>
      <div class="cah-actions">
        <button class="cah-cancel"  type="button">Not now</button>
        <button class="cah-primary" type="button">Draft email</button>
      </div>
    `);
    wrap.querySelector('.cah-cancel').addEventListener('click', () => wrap.remove());
    wrap.querySelector('.cah-primary').addEventListener('click', () => {
      wrap.remove();
      const subject = cfg.draftEmailSubject || 'Following up on our call';
      if (typeof window.openEmailCompose === 'function') {
        try { window.openEmailCompose(); } catch {}
        setTimeout(() => {
          const subjEl = document.getElementById('gmail-subject');
          const bodyEl = document.getElementById('gmail-body');
          const toEl   = document.getElementById('gmail-to');
          if (subjEl && !subjEl.value) subjEl.value = subject;
          if (bodyEl && !bodyEl.value) bodyEl.value = `Hi${ctx.contactName ? ' ' + ctx.contactName.split(' ')[0] : ''},\n\nThanks for the call. To recap:\n\n${summary}\n\nBest,\n`;
          if (toEl   && !toEl.value && ctx.contactEmail) toEl.value = ctx.contactEmail;
        }, 50);
      } else {
        const body = `Hi${ctx.contactName ? ' ' + ctx.contactName.split(' ')[0] : ''},\n\nThanks for the call. To recap:\n\n${summary}\n\nBest,\n`;
        const mailto = `mailto:${encodeURIComponent(ctx.contactEmail || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        window.location.href = mailto;
      }
    });
  }

  // ── Handler: start_design_visit ────────────────────────────────────────────

  async function openDesignVisitWizard(handler, ctx, existingVisit) {
    _injectStyle();
    const cfg = handler.config || {};
    const defaultDuration = cfg.defaultDurationMin || 90;
    const contactId       = ctx?.contactId    || ctx?.contact_id    || '';
    const contactName     = ctx?.contactName  || ctx?.contact_name  || '';
    const contactEmail    = ctx?.contactEmail || ctx?.contact_email || '';
    const editMode        = !!(existingVisit && existingVisit.id);
    const editVisitId     = editMode ? existingVisit.id : null;

    if (!editMode && cfg.intermediateLeadStatus && contactId) {
      fetch(`/api/contacts/${encodeURIComponent(contactId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hs_lead_status: cfg.intermediateLeadStatus }),
      }).then(res => {
        if (!res.ok) console.warn('[design-visit] intermediate lead status update failed: HTTP', res.status);
      }).catch(e => console.warn('[design-visit] intermediate lead status update failed:', e.message));
    }

    let handles = [], furnitureRanges = [], doorStyles = [], termsText = '', termsVersionNumber = null;
    try {
      [handles, furnitureRanges, doorStyles] = await Promise.all([
        fetch('/api/design-visit-handles').then(r => r.ok ? r.json() : []),
        fetch('/api/design-visit-furniture-ranges').then(r => r.ok ? r.json() : []),
        fetch('/api/design-visit-door-styles').then(r => r.ok ? r.json() : []),
      ]);
    } catch {}
    try {
      const tr = await fetch('/api/design-visit-terms');
      if (tr.ok) { const td = await tr.json(); termsText = td.terms || ''; termsVersionNumber = td.versionNumber || null; }
    } catch {}

    let step = 1;
    let rooms;
    if (editMode && Array.isArray(existingVisit.rooms) && existingVisit.rooms.length) {
      rooms = existingVisit.rooms.map(r => ({
        roomName:       r.room_name || r.roomName || '',
        doorStyleId:    r.door_style_id || r.doorStyleId || '',
        widthMm:        r.width_mm  ?? r.widthMm  ?? null,
        heightMm:       r.height_mm ?? r.heightMm ?? null,
        depthMm:        r.depth_mm  ?? r.depthMm  ?? null,
        unitCount:      Math.max(1, parseInt(r.unit_count ?? r.unitCount ?? 1, 10) || 1),
        unitPricePence: Math.max(0, parseInt(r.unit_price_pence ?? r.unitPricePence ?? 0, 10) || 0),
        notes:          r.notes || '',
        images:         Array.isArray(r.images) ? r.images.map(i => ({
          storageKey: i.storageKey || i.storage_key || '',
          mimeType:   i.mimeType   || i.mime_type   || null,
          viewUrl:    i.viewUrl    || i.view_url    || '',
        })) : [],
      }));
    } else {
      rooms = [_makeRoom()];
    }
    const wizardStyle = `
      .dv-wizard-backdrop {
        position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;
        align-items:stretch;justify-content:flex-end;z-index:calc(var(--z-tooltip) + 1); }
      .dv-wizard {
        background:#fff;width:min(680px,100%);height:100%;display:flex;flex-direction:column;
        box-shadow:-6px 0 40px rgba(0,0,0,.2);font-family:inherit; }
      .dv-wizard-header {
        display:flex;align-items:center;justify-content:space-between;
        padding:18px 24px 14px;border-bottom:1px solid #e5e7eb;flex-shrink:0; }
      .dv-wizard-header h2 { margin:0;font-size:1.1rem;font-weight:700;color:#1f2937; }
      .dv-wizard-close { background:none;border:none;font-size:1.5rem;cursor:pointer;
        color:#9ca3af;padding:0 4px;line-height:1; }
      .dv-wizard-close:hover { color:#1f2937; }
      .dv-wizard-body { flex:1;overflow-y:auto;padding:20px 24px; }
      .dv-wizard .dv-step-indicator { display:flex;gap:6px;margin-bottom:20px; }
      .dv-wizard .dv-step-dot { flex:1;height:4px;border-radius:2px;background:#e5e7eb;transition:background .2s; }
      .dv-wizard .dv-step-dot.active { background:#8B2BFF; }
      .dv-wizard .dv-step-dot.done   { background:#c4b5fd; }
      .dv-wizard label.dv-label { display:block;font-size:.78rem;font-weight:600;color:#4b5563;margin:12px 0 4px; }
      .dv-wizard input[type=text],.dv-wizard input[type=number],.dv-wizard input[type=datetime-local],
      .dv-wizard input[type=url],.dv-wizard select,.dv-wizard textarea {
        width:100%;padding:9px 11px;border:1.5px solid #d1d5db;border-radius:8px;
        font-size:.9rem;font-family:inherit;box-sizing:border-box;background:#fff; }
      .dv-wizard input:focus,.dv-wizard select:focus,.dv-wizard textarea:focus {
        outline:none;border-color:#8B2BFF; }
      .dv-wizard .dv-grid2 { display:grid;grid-template-columns:1fr 1fr;gap:12px; }
      .dv-wizard .dv-grid3 { display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px; }
      .dv-wizard .dv-room-card { border:1.5px solid #e5e7eb;border-radius:10px;padding:14px;margin-bottom:12px; }
      .dv-wizard .dv-room-header { display:flex;align-items:center;gap:8px;margin-bottom:10px; }
      .dv-wizard .dv-room-title { font-weight:700;font-size:.9rem;color:#374151;flex:1; }
      .dv-wizard .dv-rm-btn { padding:4px 10px;border-radius:7px;border:1.5px solid #d1d5db;
        background:#fff;font-size:.8rem;cursor:pointer;color:#374151; }
      .dv-wizard .dv-rm-btn:hover { background:#fef2f2;border-color:#fca5a5;color:#dc2626; }
      .dv-wizard .dv-ord-btn { padding:4px 8px;border-radius:7px;border:1.5px solid #d1d5db;
        background:#fff;font-size:.75rem;cursor:pointer;color:#6b7280;line-height:1; }
      .dv-wizard .dv-ord-btn:hover:not(:disabled) { background:#f3f4f6; }
      .dv-wizard .dv-ord-btn:disabled { opacity:.35;cursor:not-allowed; }
      .dv-wizard .dv-add-room { width:100%;padding:10px;border:2px dashed #d1d5db;border-radius:10px;
        background:transparent;font-size:.88rem;color:#6b7280;cursor:pointer;margin-top:4px; }
      .dv-wizard .dv-add-room:hover { border-color:#8B2BFF;color:#8B2BFF; }
      .dv-wizard .dv-photo-list { display:flex;flex-wrap:wrap;gap:8px;margin-top:6px; }
      .dv-wizard .dv-photo-thumb { width:64px;height:64px;object-fit:cover;
        border-radius:6px;border:1px solid #e5e7eb; }
      .dv-wizard .dv-terms-box { background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;
        padding:10px 12px;font-size:.78rem;color:#4b5563;max-height:120px;overflow-y:auto;
        white-space:pre-wrap;margin-bottom:6px;line-height:1.5; }
      .dv-wizard .dv-review-section { margin-bottom:18px; }
      .dv-wizard .dv-review-label { font-size:.7rem;font-weight:700;text-transform:uppercase;
        letter-spacing:.06em;color:#9ca3af;margin-bottom:8px; }
      .dv-wizard .dv-review-row { display:flex;justify-content:space-between;font-size:.88rem;
        padding:5px 0;border-bottom:1px solid #f3f4f6; }
      .dv-wizard .dv-review-row:last-child { border-bottom:none; }
      .dv-wizard .dv-review-row strong { color:#6b7280; }
      .dv-wizard .dv-review-total { font-size:1rem;font-weight:700;text-align:right;
        padding-top:10px;color:#1f2937; }
      .dv-wizard .dv-footer { display:flex;gap:10px;justify-content:flex-end;
        padding:14px 24px;border-top:1px solid #e5e7eb;flex-shrink:0;background:#fff; }
      .dv-wizard .dv-btn-back { padding:9px 18px;border-radius:8px;border:1.5px solid #d1d5db;
        background:#fff;font-size:.9rem;font-weight:600;cursor:pointer;color:#374151; }
      .dv-wizard .dv-btn-next { padding:9px 20px;border-radius:8px;border:none;
        background:#8B2BFF;color:#fff;font-size:.9rem;font-weight:600;cursor:pointer; }
      .dv-wizard .dv-btn-next:disabled { opacity:.55;cursor:not-allowed; }
      .dv-wizard .dv-err { color:#b91c1c;font-size:.82rem;margin-top:8px;min-height:18px; }
      .dv-wizard .dv-checkbox-row { display:flex;align-items:flex-start;gap:8px;margin-top:10px; }
      .dv-wizard .dv-checkbox-row input[type=checkbox] { width:auto;margin-top:2px;flex-shrink:0; }
      .dv-wizard .dv-checkbox-row label { font-size:.82rem;color:#374151;margin:0; }
    `;
    if (!document.getElementById('dv-wizard-style')) {
      const s = document.createElement('style');
      s.id = 'dv-wizard-style'; s.textContent = wizardStyle;
      document.head.appendChild(s);
    }

    const backdrop = document.createElement('div');
    backdrop.className = 'dv-wizard-backdrop';
    backdrop.innerHTML = `
      <div class="dv-wizard" role="dialog" aria-modal="true" aria-label="Design Visit Wizard">
        <div class="dv-wizard-header">
          <h2>${editMode ? 'Edit Design Visit' : 'Design Visit'}</h2>
          <button class="dv-wizard-close" id="dv-close-x" aria-label="Close">×</button>
        </div>
        <div class="dv-wizard-body"><div id="dv-wiz-inner"></div></div>
        <div class="dv-footer" id="dv-wiz-footer"></div>
      </div>`;
    document.body.appendChild(backdrop);
    const inner  = backdrop.querySelector('#dv-wiz-inner');
    const footer = backdrop.querySelector('#dv-wiz-footer');
    backdrop.querySelector('#dv-close-x').addEventListener('click', () => backdrop.remove());

    const _dvChans = [];
    for (const name of ['design_visit_handles_changed','design_visit_furniture_ranges_changed','design_visit_door_styles_changed']) {
      try {
        const ch = new BroadcastChannel(name);
        ch.addEventListener('message', async () => {
          try {
            [handles, furnitureRanges, doorStyles] = await Promise.all([
              fetch('/api/design-visit-handles').then(r => r.ok ? r.json() : handles),
              fetch('/api/design-visit-furniture-ranges').then(r => r.ok ? r.json() : furnitureRanges),
              fetch('/api/design-visit-door-styles').then(r => r.ok ? r.json() : doorStyles),
            ]);
          } catch {}
          if (step === 1) renderStep1();
          else if (step === 2) { _saveRoomsFromDom(); renderStep2(); }
        });
        _dvChans.push(ch);
      } catch {}
    }
    const _cleanupChans = () => { _dvChans.forEach(ch => { try { ch.close(); } catch {} }); };
    backdrop.querySelector('#dv-close-x').addEventListener('click', _cleanupChans);

    const s1 = {
      visitDate: '', duration: String(defaultDuration), location: '',
      designerName: '', handleId: '', furnitureRangeId: '', termsAccepted: false,
    };
    if (editMode) {
      const ev = existingVisit;
      if (ev.visit_date) {
        try {
          const d = new Date(ev.visit_date);
          const pad = n => String(n).padStart(2, '0');
          s1.visitDate = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        } catch {}
      }
      if (ev.duration_min) s1.duration = String(ev.duration_min);
      if (ev.location)     s1.location = String(ev.location);
      if (ev.handle_id          != null) s1.handleId         = String(ev.handle_id);
      if (ev.furniture_range_id != null) s1.furnitureRangeId = String(ev.furniture_range_id);
      if (ev.notes) {
        const m = String(ev.notes).match(/^Designer:\s*(.+)$/);
        if (m) s1.designerName = m[1].trim();
      }
      s1.termsAccepted = !!ev.terms_accepted;
    }

    function renderStepIndicator() {
      return `<div class="dv-step-indicator">
        <div class="dv-step-dot ${step >= 1 ? 'active' : ''}"></div>
        <div class="dv-step-dot ${step >= 2 ? 'active' : (step > 2 ? 'done' : '')}"></div>
        <div class="dv-step-dot ${step >= 3 ? 'active' : ''}"></div>
      </div>`;
    }

    function _selOptions(items, selectedId, placeholder) {
      return `<option value="">${_esc(placeholder)}</option>` +
        items.map(i => `<option value="${i.id}" ${String(selectedId) === String(i.id) ? 'selected' : ''}>${_esc(i.name)}</option>`).join('');
    }

    function _dsOptions(selectedId) {
      return `<option value="">— none —</option>` +
        doorStyles.map(ds => `<option value="${ds.id}" ${String(selectedId) === String(ds.id) ? 'selected' : ''}>${_esc(ds.name)}</option>`).join('');
    }

    function _renderFooter(leftBtn, rightBtns) {
      footer.innerHTML = '';
      if (leftBtn) { const b = document.createElement('button'); b.className = leftBtn.cls; b.textContent = leftBtn.label; b.addEventListener('click', leftBtn.fn); footer.appendChild(b); }
      const spacer = document.createElement('div'); spacer.style.flex = '1'; footer.appendChild(spacer);
      for (const rb of rightBtns) {
        const b = document.createElement('button'); b.className = rb.cls; b.textContent = rb.label;
        if (rb.id) b.id = rb.id;
        b.addEventListener('click', rb.fn); footer.appendChild(b);
      }
    }

    function renderStep1() {
      inner.innerHTML = `
        ${renderStepIndicator()}
        <p style="font-size:.82rem;color:#6b7280;margin:0 0 16px;">Step 1 of 3 — Visit details</p>
        <div class="dv-grid2">
          <div>
            <label class="dv-label">Visit date &amp; time</label>
            <input type="datetime-local" id="dv-visit-date" value="${_esc(s1.visitDate)}">
          </div>
          <div>
            <label class="dv-label">Duration (minutes)</label>
            <input type="number" id="dv-duration" min="15" max="1440" step="15" value="${_esc(s1.duration)}">
          </div>
        </div>
        <label class="dv-label">Location</label>
        <input type="text" id="dv-location" placeholder="e.g. 12 Baker Street, London" value="${_esc(s1.location)}">
        <label class="dv-label">Designer name</label>
        <input type="text" id="dv-designer" placeholder="e.g. Sarah Jones" maxlength="200" value="${_esc(s1.designerName)}">
        ${handles.length ? `
          <label class="dv-label">Handle selection</label>
          <select id="dv-handle">${_selOptions(handles, s1.handleId, '— select handle —')}</select>
        ` : ''}
        ${furnitureRanges.length ? `
          <label class="dv-label">Furniture range</label>
          <select id="dv-furniture">${_selOptions(furnitureRanges, s1.furnitureRangeId, '— select range —')}</select>
        ` : ''}
        ${termsText ? `
          <label class="dv-label">Terms &amp; Conditions</label>
          <div class="dv-terms-box">${_esc(termsText)}</div>
        ` : ''}
        <div class="dv-checkbox-row">
          <input type="checkbox" id="dv-terms" ${s1.termsAccepted ? 'checked' : ''}>
          <label for="dv-terms">Customer has read and accepted the terms &amp; conditions</label>
        </div>
        <div class="dv-err" id="dv-s1-err"></div>`;
      _renderFooter(null, [
        { cls: 'dv-btn-next', label: 'Next: Rooms →', fn: () => {
          const errEl = inner.querySelector('#dv-s1-err');
          s1.visitDate        = inner.querySelector('#dv-visit-date')?.value || '';
          s1.duration         = inner.querySelector('#dv-duration')?.value || String(defaultDuration);
          s1.location         = inner.querySelector('#dv-location')?.value.trim() || '';
          s1.designerName     = inner.querySelector('#dv-designer')?.value.trim() || '';
          s1.handleId         = inner.querySelector('#dv-handle')?.value || '';
          s1.furnitureRangeId = inner.querySelector('#dv-furniture')?.value || '';
          s1.termsAccepted    = inner.querySelector('#dv-terms')?.checked || false;
          if (!s1.termsAccepted) { errEl.textContent = 'Please confirm the customer has accepted the terms and conditions.'; return; }
          errEl.textContent = '';
          step = 2; renderStep2();
        }},
      ]);
    }

    function renderStep2() {
      function renderRoomCard(room, idx) {
        const prevPhotos = (room.images || []).map(img => {
          const src = img.viewUrl || img.storageKey || '';
          return `<img class="dv-photo-thumb" src="${_esc(src)}" alt="Room photo">`;
        }).join('');
        return `
          <div class="dv-room-card" data-ridx="${idx}">
            <div class="dv-room-header">
              <button class="dv-ord-btn dv-mv-up" data-ridx="${idx}" title="Move up" ${idx === 0 ? 'disabled' : ''}>↑</button>
              <button class="dv-ord-btn dv-mv-dn" data-ridx="${idx}" title="Move down" ${idx === rooms.length - 1 ? 'disabled' : ''}>↓</button>
              <span class="dv-room-title">Room ${idx + 1}</span>
              ${rooms.length > 1 ? `<button class="dv-rm-btn dv-rm-room" data-ridx="${idx}">Remove</button>` : ''}
            </div>
            <label class="dv-label">Room name <span style="color:#991b1b;">*</span></label>
            <input type="text" class="dv-rn" data-ridx="${idx}" maxlength="200" placeholder="e.g. Kitchen" value="${_esc(room.roomName)}">
            ${doorStyles.length ? `
              <label class="dv-label">Door style</label>
              <select class="dv-ds" data-ridx="${idx}">${_dsOptions(room.doorStyleId)}</select>
            ` : ''}
            <div class="dv-grid3" style="margin-top:10px;">
              <div>
                <label class="dv-label">Width (mm)</label>
                <input type="number" class="dv-wm" data-ridx="${idx}" min="0" placeholder="e.g. 3500" value="${room.widthMm || ''}">
              </div>
              <div>
                <label class="dv-label">Height (mm)</label>
                <input type="number" class="dv-hm" data-ridx="${idx}" min="0" placeholder="e.g. 2400" value="${room.heightMm || ''}">
              </div>
              <div>
                <label class="dv-label">Depth (mm)</label>
                <input type="number" class="dv-dm" data-ridx="${idx}" min="0" placeholder="e.g. 600" value="${room.depthMm || ''}">
              </div>
            </div>
            <div class="dv-grid2" style="margin-top:10px;">
              <div>
                <label class="dv-label">Unit count <span style="color:#991b1b;">*</span></label>
                <input type="number" class="dv-uc" data-ridx="${idx}" min="1" value="${room.unitCount || 1}">
              </div>
              <div>
                <label class="dv-label">Unit price (£)</label>
                <input type="number" class="dv-up" data-ridx="${idx}" min="0" step="0.01" placeholder="0.00" value="${room.unitPricePence ? (room.unitPricePence / 100).toFixed(2) : ''}">
              </div>
            </div>
            <label class="dv-label">Room notes</label>
            <textarea class="dv-rnotes" data-ridx="${idx}" rows="2" maxlength="2000" placeholder="Any additional notes for this room…">${_esc(room.notes || '')}</textarea>
            <label class="dv-label">Photos (optional)</label>
            <input type="file" class="dv-photo-input" data-ridx="${idx}" accept="image/*" multiple style="font-size:.82rem;">
            ${prevPhotos ? `<div class="dv-photo-list">${prevPhotos}</div>` : ''}
          </div>`;
      }

      inner.innerHTML = `
        ${renderStepIndicator()}
        <p style="font-size:.82rem;color:#6b7280;margin:0 0 16px;">Step 2 of 3 — Rooms</p>
        <div id="dv-rooms-list">${rooms.map((r, i) => renderRoomCard(r, i)).join('')}</div>
        <button class="dv-add-room" id="dv-add-room">+ Add room</button>
        <div class="dv-err" id="dv-s2-err"></div>`;

      _renderFooter(null, [
        { cls: 'dv-btn-back', label: '← Back', fn: () => { step = 1; renderStep1(); }},
        { cls: 'dv-btn-next', label: 'Review →', fn: async () => {
          await _saveRoomsFromDom();
          const errEl = inner.querySelector('#dv-s2-err');
          const emptyRooms = rooms.filter(r => !r.roomName.trim());
          if (emptyRooms.length) { errEl.textContent = 'Every room needs a name.'; return; }
          if (!rooms.length) { errEl.textContent = 'Add at least one room.'; return; }
          errEl.textContent = '';
          step = 3; renderStep3();
        }},
      ]);

      inner.querySelector('#dv-add-room').addEventListener('click', async () => {
        await _saveRoomsFromDom(); rooms.push(_makeRoom()); renderStep2();
      });
      if (!inner.__step2ClickBound) {
        inner.__step2ClickBound = true;
        inner.addEventListener('click', async e => {
          if (step !== 2) return;
          const rmBtn = e.target.closest('.dv-rm-room');
          if (rmBtn) {
            const idx = parseInt(rmBtn.dataset.ridx, 10);
            await _saveRoomsFromDom(); rooms.splice(idx, 1); renderStep2(); return;
          }
          const upBtn = e.target.closest('.dv-mv-up');
          if (upBtn) {
            const idx = parseInt(upBtn.dataset.ridx, 10);
            if (idx === 0) return;
            await _saveRoomsFromDom();
            [rooms[idx-1], rooms[idx]] = [rooms[idx], rooms[idx-1]]; renderStep2(); return;
          }
          const dnBtn = e.target.closest('.dv-mv-dn');
          if (dnBtn) {
            const idx = parseInt(dnBtn.dataset.ridx, 10);
            if (idx >= rooms.length - 1) return;
            await _saveRoomsFromDom();
            [rooms[idx], rooms[idx+1]] = [rooms[idx+1], rooms[idx]]; renderStep2(); return;
          }
        });
      }
    }

    async function _saveRoomsFromDom() {
      const cards = inner.querySelectorAll('.dv-room-card');
      const reads = [];
      cards.forEach(card => {
        const idx = parseInt(card.dataset.ridx, 10);
        if (!rooms[idx]) return;
        rooms[idx].roomName      = card.querySelector('.dv-rn')?.value || '';
        rooms[idx].doorStyleId   = card.querySelector('.dv-ds')?.value || '';
        rooms[idx].widthMm       = parseInt(card.querySelector('.dv-wm')?.value, 10) || null;
        rooms[idx].heightMm      = parseInt(card.querySelector('.dv-hm')?.value, 10) || null;
        rooms[idx].depthMm       = parseInt(card.querySelector('.dv-dm')?.value, 10) || null;
        rooms[idx].unitCount     = Math.max(1, parseInt(card.querySelector('.dv-uc')?.value, 10) || 1);
        const priceStr           = card.querySelector('.dv-up')?.value.trim() || '0';
        rooms[idx].unitPricePence = Math.round(parseFloat(priceStr) * 100) || 0;
        rooms[idx].notes          = card.querySelector('.dv-rnotes')?.value || '';
        const fileInput = card.querySelector('.dv-photo-input');
        if (fileInput && fileInput.files && fileInput.files.length > 0) {
          for (const file of fileInput.files) {
            reads.push(new Promise(resolve => {
              const fr = new FileReader();
              fr.onload = async () => {
                try {
                  const resp = await fetch('/api/design-visits/uploads', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ dataUrl: fr.result }),
                  });
                  const data = await resp.json();
                  if (!resp.ok || !data.storageKey) throw new Error(data.error || 'Upload failed');
                  if (!rooms[idx].images) rooms[idx].images = [];
                  rooms[idx].images.push({
                    storageKey: data.storageKey,
                    mimeType:   data.mimeType || file.type,
                    viewUrl:    data.viewUrl || '',
                  });
                } catch (err) {
                  console.warn('[design-visit] photo upload failed:', err.message);
                  if (typeof window.toast === 'function') {
                    window.toast('Photo upload failed: ' + (err.message || 'unknown'));
                  }
                }
                resolve();
              };
              fr.onerror = resolve;
              fr.readAsDataURL(file);
            }));
          }
          try { fileInput.value = ''; } catch {}
        }
      });
      if (reads.length) await Promise.all(reads);
    }

    function renderStep3() {
      const handleName   = handles.find(h => String(h.id) === String(s1.handleId))?.name || '—';
      const furnitureName = furnitureRanges.find(f => String(f.id) === String(s1.furnitureRangeId))?.name || '—';
      let grandTotal = 0;
      const roomRows = rooms.map(r => {
        const ds   = doorStyles.find(d => String(d.id) === String(r.doorStyleId))?.name || '—';
        const tot  = r.unitCount * r.unitPricePence;
        grandTotal += tot;
        return `<div class="dv-review-row">
          <strong>${_esc(r.roomName)} <span style="font-weight:400;color:#9ca3af;">(${_esc(ds)}, ${r.unitCount} unit${r.unitCount !== 1 ? 's' : ''})</span></strong>
          <span>£${(tot / 100).toFixed(2)}</span>
        </div>`;
      }).join('');

      inner.innerHTML = `
        ${renderStepIndicator()}
        <p style="font-size:.82rem;color:#6b7280;margin:0 0 16px;">Step 3 of 3 — Review &amp; submit</p>
        <div class="dv-review-section">
          <div class="dv-review-label">Visit details</div>
          ${s1.visitDate   ? `<div class="dv-review-row"><strong>Date</strong><span>${_esc(new Date(s1.visitDate).toLocaleString())}</span></div>` : ''}
          <div class="dv-review-row"><strong>Duration</strong><span>${_esc(s1.duration)} min</span></div>
          ${s1.location    ? `<div class="dv-review-row"><strong>Location</strong><span>${_esc(s1.location)}</span></div>` : ''}
          ${s1.designerName ? `<div class="dv-review-row"><strong>Designer</strong><span>${_esc(s1.designerName)}</span></div>` : ''}
          ${handles.length ? `<div class="dv-review-row"><strong>Handle</strong><span>${_esc(handleName)}</span></div>` : ''}
          ${furnitureRanges.length ? `<div class="dv-review-row"><strong>Furniture range</strong><span>${_esc(furnitureName)}</span></div>` : ''}
        </div>
        <div class="dv-review-section">
          <div class="dv-review-label">Room breakdown</div>
          ${roomRows}
          <div class="dv-review-total">Estimate total: £${(grandTotal / 100).toFixed(2)}</div>
        </div>
        ${termsText ? `<div class="dv-review-section">
          <div class="dv-review-label">Terms &amp; Conditions</div>
          <div class="dv-review-row"><strong>Accepted</strong><span style="color:#059669;">✓${termsVersionNumber != null ? ` &nbsp;<span style="display:inline-block;padding:1px 7px;border-radius:999px;background:#e5e7eb;color:#374151;font-size:.7rem;font-weight:700;">v${termsVersionNumber}</span>` : ''}</span></div>
        </div>` : ''}
        <div class="dv-err" id="dv-s3-err"></div>`;

      _renderFooter(null, [
        { cls: 'dv-btn-back', label: '← Back', fn: () => { step = 2; renderStep2(); }},
        { cls: 'dv-btn-next', id: 'dv-submit', label: editMode ? 'Save changes' : 'Submit visit', fn: async () => {
          const errEl = inner.querySelector('#dv-s3-err');
          const btn   = footer.querySelector('#dv-submit');
          btn.disabled = true; btn.textContent = editMode ? 'Saving…' : 'Submitting…';
          errEl.textContent = '';
          try {
            const payload = {
              contactId,
              contactName,
              contactEmail,
              handleId:         s1.handleId        || undefined,
              furnitureRangeId: s1.furnitureRangeId || undefined,
              visitDate:        s1.visitDate        || undefined,
              durationMin:      parseInt(s1.duration, 10) || defaultDuration,
              location:         s1.location         || undefined,
              notes:            s1.designerName ? `Designer: ${s1.designerName}` : undefined,
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
                  storageKey: img.storageKey, mimeType: img.mimeType,
                })),
              })),
              handlerConfig: cfg,
            };
            const url    = editMode ? `/api/design-visits/${encodeURIComponent(editVisitId)}` : '/api/design-visits';
            const method = editMode ? 'PUT' : 'POST';
            const resp = await fetch(url, {
              method,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error || (editMode ? 'Save failed' : 'Submission failed'));
            _cleanupChans();
            backdrop.remove();
            const successMsg = editMode
              ? 'Design visit updated. A fresh sign-off email has been sent.'
              : 'Design visit submitted. Customer sign-off email sent.';
            if (typeof window.toast === 'function') {
              window.toast(successMsg);
            } else if (typeof window.showToast === 'function') {
              window.showToast(successMsg);
            } else {
              alert(successMsg);
            }
            if (typeof window.renderDesignVisits === 'function') {
              try { window.renderDesignVisits(); } catch {}
            }
          } catch (e) {
            btn.disabled = false; btn.textContent = editMode ? 'Save changes' : 'Submit visit';
            errEl.textContent = e.message || (editMode ? 'Save failed. Please try again.' : 'Submission failed. Please try again.');
          }
        }},
      ]);
    }

    renderStep1();
  }
  window.openDesignVisitWizard = openDesignVisitWizard;

  function _makeRoom() {
    return { roomName: '', doorStyleId: '', widthMm: null, heightMm: null, depthMm: null, unitCount: 1, unitPricePence: 0, notes: '' };
  }

  // ── Click delegation ───────────────────────────────────────────────────────
  // Handles clicks on elements that carry data-card-action-handler-* attributes
  // (e.g. fake elements injected by the test suite or vanilla-JS rendered strips).
  // React-rendered SalesCard action strips use their own React onClick and do
  // NOT carry these attributes, so they are not matched here.
  document.addEventListener('click', function (e) {
    const el = e.target.closest('[data-card-action-handler-id]');
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const id   = parseInt(el.dataset.cardActionHandlerId, 10);
    const type = el.dataset.cardActionHandlerType;
    const ctx = {
      contactId:    el.dataset.cardActionContactId    || '',
      contactName:  el.dataset.cardActionContactName  || '',
      contactEmail: el.dataset.cardActionContactEmail || '',
    };
    // Use the full handler from our index (populated by loadCardActionHandlers)
    // so that config fields like intermediateLeadStatus are available.
    // Fall back to a minimal stub if the id isn't in our index yet.
    const handler = HANDLERS_BY_ID[id] || { id, type, config: {} };
    dispatchCardActionHandler(handler, ctx);
  }, true);

  window.dispatchCardActionHandler = dispatchCardActionHandler;

  // ── Bootstrap + cross-tab refresh ─────────────────────────────────────────
  // Pre-populate the local index at page load so window.cardActionHandlerFor,
  // window.cardActionHandlerAttrs, and window.enquiryRowHtml return correct
  // results immediately (same behaviour as the old card-action-handlers.js).
  loadCardActionHandlers();

  // When an admin changes handlers in another tab keep the index in sync.
  // The React hook handles its own refresh independently via the same channel.
  if (typeof BroadcastChannel !== 'undefined') {
    const ch = new BroadcastChannel('card_action_handlers_changed');
    ch.addEventListener('message', () => loadCardActionHandlers());
  }
})();
