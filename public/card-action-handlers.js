// Card action handlers (client-side dispatch + modals).
//
// Loaded on every page that renders Sales/Survey cards (sales.html,
// survey.html, customer-detail.html). Mirrors the labels-and-substatuses
// resolver in workflow-core.js: looks up a handler bound to either
// (stage_key, status_key) OR a lead_substatus_id and, when the user clicks
// a `[data-card-action-handler-id]` element, opens the appropriate modal.

(function () {
  let HANDLERS_BY_LABEL    = {}; // `${stage}|${status}` → handler
  let HANDLERS_BY_SUBSTATUS = {}; // substatus_id → handler

  function _indexHandlers(rows) {
    const byLabel = {};
    const bySub   = {};
    for (const h of rows || []) {
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

  // Render attributes to drop into the `[data-card-action-handler-id]` element so the
  // delegated click listener below knows to dispatch.
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

  // Produce a minimal card-strip HTML string for a given board entry.
  // Used by the test suite (E.3) and any vanilla-JS callers that need to
  // render a sales card action strip outside of the React board.
  //
  // Entry shape: { contact, stageKey, substageId, sourceId, stageTime,
  //               priority, badgeLabel, roomIdx }
  // The returned HTML always contains a .eq-card-action-label when a handler
  // with config.action_name is bound to (stageKey, leadStatusKey).
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

    // Extract action_name from the emitted attribute and title-case it.
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

  // ── Click delegation (capture phase so we run before the existing
  //    leadstatus-edit listeners on the same element) ────────────────────────
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
    const handler = _findHandlerById(id) || { id, type, config: {} };
    dispatchCardActionHandler(handler, ctx);
  }, true);

  function _findHandlerById(id) {
    for (const h of Object.values(HANDLERS_BY_LABEL)) if (h.id === id) return h;
    for (const h of Object.values(HANDLERS_BY_SUBSTATUS)) if (h.id === id) return h;
    return null;
  }

  function dispatchCardActionHandler(handler, ctx) {
    if (handler.type === 'add_design_visit_to_calendar') return openDesignVisitModal(handler, ctx);
    if (handler.type === 'summarise_phone_call')        return openPhoneSummaryModal(handler, ctx);
    if (handler.type === 'show_message')                return openMessagePopup(handler, ctx);
    if (handler.type === 'start_design_visit')          return openDesignVisitWizard(handler, ctx);
    console.warn('Unknown card action handler type:', handler.type);
  }

  // ── Handler: show_message ─────────────────────────────────────────────────
  // Informational-only action. Admin types a message in admin → that message
  // shows in a simple modal when the operator clicks the action label.
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
  window.dispatchCardActionHandler = dispatchCardActionHandler;

  // ── Shared modal scaffolding ───────────────────────────────────────────────
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
  // Full multi-step wizard. Three steps:
  //   Step 1 — Visit details (date/time, location, handle, furniture range, T&C)
  //   Step 2 — Rooms (add/remove rooms with door style, dimensions, units, price)
  //   Step 3 — Review + submit
  async function openDesignVisitWizard(handler, ctx, existingVisit) {
    _injectStyle();
    const cfg = handler.config || {};
    const defaultDuration = cfg.defaultDurationMin || 90;
    const contactId       = ctx?.contactId    || ctx?.contact_id    || '';
    const contactName     = ctx?.contactName  || ctx?.contact_name  || '';
    const contactEmail    = ctx?.contactEmail || ctx?.contact_email || '';
    const editMode        = !!(existingVisit && existingVisit.id);
    const editVisitId     = editMode ? existingVisit.id : null;

    // Apply in-progress lead status as soon as the wizard opens (non-fatal).
    // Skipped in edit mode — the visit was already past that stage.
    if (!editMode && cfg.intermediateLeadStatus && contactId) {
      fetch(`/api/contacts/${encodeURIComponent(contactId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hs_lead_status: cfg.intermediateLeadStatus }),
      }).then(res => {
        if (!res.ok) console.warn('[design-visit] intermediate lead status update failed: HTTP', res.status);
      }).catch(e => console.warn('[design-visit] intermediate lead status update failed:', e.message));
    }

    // Pre-load catalogue + T&C in parallel
    let handles = [], furnitureRanges = [], doorStyles = [], termsText = '', termsVersionNumber = null;
    try {
      [handles, furnitureRanges, doorStyles] = await Promise.all([
        fetch('/api/design-visit-handles').then(r => r.ok ? r.json() : []),
        fetch('/api/design-visit-furniture-ranges').then(r => r.ok ? r.json() : []),
        fetch('/api/design-visit-door-styles').then(r => r.ok ? r.json() : []),
      ]);
    } catch {}
    // Load T&C text from the member-accessible route (no admin required)
    try {
      const tr = await fetch('/api/design-visit-terms');
      if (tr.ok) { const td = await tr.json(); termsText = td.terms || ''; termsVersionNumber = td.versionNumber || null; }
    } catch {}

    // Wizard state — pre-populated from existingVisit when in edit mode
    let step = 1;
    // Handles for the React roots mounted at each step
    let _step1Handle = null;
    let _step2Handle = null;
    let _step3Handle = null;
    // Whether any room photo is currently uploading (reported by the React step)
    let _step2Uploading = false;
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
          // Server hands us a short-lived signed URL (or the legacy URL /
          // data URI for old rows) so the thumbnail can render without
          // ever inlining base64 bytes here.
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
      .dv-wizard .dv-footer { display:flex;gap:10px;justify-content:flex-end;
        padding:14px 24px;border-top:1px solid #e5e7eb;flex-shrink:0;background:#fff; }
      .dv-wizard .dv-btn-back { padding:9px 18px;border-radius:8px;border:1.5px solid #d1d5db;
        background:#fff;font-size:.9rem;font-weight:600;cursor:pointer;color:#374151; }
      .dv-wizard .dv-btn-next { padding:9px 20px;border-radius:8px;border:none;
        background:#8B2BFF;color:#fff;font-size:.9rem;font-weight:600;cursor:pointer; }
      .dv-wizard .dv-btn-next:disabled { opacity:.55;cursor:not-allowed; }
      .dv-wizard .dv-err { color:#b91c1c;font-size:.82rem;margin-top:8px;min-height:18px; }
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
    backdrop.querySelector('#dv-close-x').addEventListener('click', () => {
      if (_step1Handle) { _step1Handle.unmount(); _step1Handle = null; }
      if (_step2Handle) { _step2Handle.unmount(); _step2Handle = null; }
      if (_step3Handle) { _step3Handle.unmount(); _step3Handle = null; }
      backdrop.remove();
    });

    // Live catalogue refresh while wizard is open
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
          // Re-render current step with fresh data
          if (step === 1) {
            if (_step1Handle) {
              // Update catalogue in the live React component — preserves typed fields.
              _step1Handle.update({ handles, furnitureRanges });
            } else {
              renderStep1();
            }
          } else if (step === 2) {
            if (_step2Handle) {
              // Update doorStyles in the live React component — no full re-mount
              // needed, so room form state (including partially-typed fields) is
              // preserved.
              _step2Handle.update({ doorStyles: doorStyles });
            } else {
              renderStep2();
            }
          } else if (step === 3) {
            if (_step3Handle) {
              _step3Handle.update({ handles, furnitureRanges, doorStyles });
            }
          }
        });
        _dvChans.push(ch);
      } catch {}
    }
    const _cleanupChans = () => { _dvChans.forEach(ch => { try { ch.close(); } catch {} }); };
    backdrop.querySelector('#dv-close-x').addEventListener('click', _cleanupChans);

    // State for step 1 — pre-populated from existingVisit when in edit mode
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
      // Designer name was stored in notes as "Designer: <name>" by the original
      // submit path; pull it back out so the field round-trips.
      if (ev.notes) {
        const m = String(ev.notes).match(/^Designer:\s*(.+)$/);
        if (m) s1.designerName = m[1].trim();
      }
      // Visit was already accepted once — pre-tick so designer doesn't have to
      // re-ask the customer just to fix a typo.
      s1.termsAccepted = !!ev.terms_accepted;
    }

    function renderStepIndicator() {
      return `<div class="dv-step-indicator">
        <div class="dv-step-dot ${step >= 1 ? 'active' : ''}"></div>
        <div class="dv-step-dot ${step >= 2 ? 'active' : (step > 2 ? 'done' : '')}"></div>
        <div class="dv-step-dot ${step >= 3 ? 'active' : ''}"></div>
      </div>`;
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

    async function renderStep1() {
      // Unmount any existing React root from a prior renderStep1() call
      // (e.g. navigating Back from Step 2 → Step 1 again).
      if (_step1Handle) { _step1Handle.unmount(); _step1Handle = null; }

      inner.innerHTML = '';

      // Step indicator and subtitle
      const headerEl = document.createElement('div');
      headerEl.innerHTML = renderStepIndicator() +
        '<p style="font-size:.82rem;color:#6b7280;margin:0 0 16px;">Step 1 of 3 \u2014 Visit details</p>';
      inner.appendChild(headerEl);

      // Container for the React island
      const reactContainer = document.createElement('div');
      reactContainer.id = 'dv-step1-react';
      inner.appendChild(reactContainer);

      // Validation error (set by footer button handler below)
      const errDiv = document.createElement('div');
      errDiv.className = 'dv-err';
      errDiv.id = 'dv-s1-err';
      inner.appendChild(errDiv);

      if (typeof window.mountDesignVisitStep1 === 'function') {
        _step1Handle = await window.mountDesignVisitStep1(reactContainer, {
          initialData: { ...s1 },
          handles: handles,
          furnitureRanges: furnitureRanges,
          termsText: termsText,
          termsVersionNumber: termsVersionNumber,
          onDataChange: function(data) { Object.assign(s1, data); },
        });
      } else {
        console.error('[design-visit] mountDesignVisitStep1 not available — React bundle not loaded?');
      }

      _renderFooter(null, [
        { cls: 'dv-btn-next', label: 'Next: Rooms \u2192', fn: () => {
          const errEl = inner.querySelector('#dv-s1-err');
          if (!s1.termsAccepted) {
            errEl.textContent = 'Please confirm the customer has accepted the terms and conditions.';
            return;
          }
          errEl.textContent = '';
          if (_step1Handle) { _step1Handle.unmount(); _step1Handle = null; }
          step = 2; renderStep2();
        }},
      ]);
    }

    async function renderStep2() {
      // Unmount any existing React root from a prior renderStep2() call before
      // re-building the container (e.g. navigating Back → Next again).
      if (_step2Handle) { _step2Handle.unmount(); _step2Handle = null; }
      _step2Uploading = false;

      inner.innerHTML = '';

      // Step indicator and subtitle (vanilla, matches Steps 1 & 3 visually)
      const headerEl = document.createElement('div');
      headerEl.innerHTML = renderStepIndicator() +
        '<p style="font-size:.82rem;color:#6b7280;margin:0 0 16px;">Step 2 of 3 — Rooms</p>';
      inner.appendChild(headerEl);

      // Container for the React island
      const reactContainer = document.createElement('div');
      reactContainer.id = 'dv-rooms-react';
      inner.appendChild(reactContainer);

      // Validation error (set by footer button handlers below)
      const errDiv = document.createElement('div');
      errDiv.className = 'dv-err';
      errDiv.id = 'dv-s2-err';
      inner.appendChild(errDiv);

      if (typeof window.mountDesignVisitRoomsStep === 'function') {
        _step2Handle = await window.mountDesignVisitRoomsStep(reactContainer, {
          initialRooms: rooms,
          doorStyles: doorStyles,
          onRoomsChange: function(updatedRooms) { rooms = updatedRooms; },
          onUploadingChange: function(uploading) { _step2Uploading = uploading; },
        });
      } else {
        console.error('[design-visit] mountDesignVisitRoomsStep not available — React bundle not loaded?');
      }

      _renderFooter(null, [
        { cls: 'dv-btn-back', label: '← Back', fn: function() {
          if (_step2Handle) { _step2Handle.unmount(); _step2Handle = null; }
          step = 1; renderStep1();
        }},
        { cls: 'dv-btn-next', label: 'Review →', fn: function() {
          const errEl = inner.querySelector('#dv-s2-err');
          if (_step2Uploading) {
            errEl.textContent = 'Please wait for photos to finish uploading.';
            return;
          }
          const emptyRooms = rooms.filter(function(r) { return !r.roomName.trim(); });
          if (emptyRooms.length) { errEl.textContent = 'Every room needs a name.'; return; }
          if (!rooms.length) { errEl.textContent = 'Add at least one room.'; return; }
          errEl.textContent = '';
          if (_step2Handle) { _step2Handle.unmount(); _step2Handle = null; }
          step = 3; renderStep3();
        }},
      ]);
    }

    async function renderStep3() {
      // Unmount any existing React root from a prior renderStep3() call
      // (e.g. navigating Back from Step 3 → Step 2 → Step 3 again).
      if (_step3Handle) { _step3Handle.unmount(); _step3Handle = null; }

      inner.innerHTML = '';

      // Step indicator and subtitle
      const headerEl = document.createElement('div');
      headerEl.innerHTML = renderStepIndicator() +
        '<p style="font-size:.82rem;color:#6b7280;margin:0 0 16px;">Step 3 of 3 \u2014 Review &amp; submit</p>';
      inner.appendChild(headerEl);

      // Container for the React island
      const reactContainer = document.createElement('div');
      reactContainer.id = 'dv-step3-react';
      inner.appendChild(reactContainer);

      // Validation / submission error (set by footer button handler below)
      const errDiv = document.createElement('div');
      errDiv.className = 'dv-err';
      errDiv.id = 'dv-s3-err';
      inner.appendChild(errDiv);

      if (typeof window.mountDesignVisitStep3 === 'function') {
        _step3Handle = await window.mountDesignVisitStep3(reactContainer, {
          step1Data: { ...s1 },
          rooms: rooms,
          handles: handles,
          furnitureRanges: furnitureRanges,
          doorStyles: doorStyles,
          termsText: termsText,
          termsVersionNumber: termsVersionNumber,
        });
      } else {
        console.error('[design-visit] mountDesignVisitStep3 not available — React bundle not loaded?');
      }

      _renderFooter(null, [
        { cls: 'dv-btn-back', label: '\u2190 Back', fn: () => {
          if (_step3Handle) { _step3Handle.unmount(); _step3Handle = null; }
          step = 2; renderStep2();
        }},
        { cls: 'dv-btn-next', id: 'dv-submit', label: editMode ? 'Save changes' : 'Submit visit', fn: async () => {
          const errEl = inner.querySelector('#dv-s3-err');
          const btn   = footer.querySelector('#dv-submit');
          btn.disabled = true; btn.textContent = editMode ? 'Saving\u2026' : 'Submitting\u2026';
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
            // Refresh the customer-detail design visit list if present
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

  // ── Bootstrap + cross-tab refresh ──────────────────────────────────────────
  loadCardActionHandlers();

  if (typeof BroadcastChannel !== 'undefined') {
    const ch = new BroadcastChannel('card_action_handlers_changed');
    ch.addEventListener('message', () => {
      loadCardActionHandlers().then(() => {
        document.dispatchEvent(new CustomEvent('mo:contacts-changed'));
        if (typeof renderEnquiryList === 'function') renderEnquiryList();
        if (typeof renderSurveyList  === 'function') renderSurveyList();
      });
    });
  }
})();
