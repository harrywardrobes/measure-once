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

  // NOTE: cardActionHandlerAttrs() and enquiryRowHtml() were previously defined
  // here (originated in card-action-modals.js, moved here).  They have been
  // removed in task #1428 and are now provided exclusively by the React
  // useCardActionHandlers hook (src/react/hooks/useCardActionHandlers.ts), which
  // registers them on window as shims for the test suite (probes E.2 and E.3).

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
    dispatchCardActionHandler(handler, ctx, el);
  }, true);

  function _findHandlerById(id) {
    for (const h of Object.values(HANDLERS_BY_LABEL)) if (h.id === id) return h;
    for (const h of Object.values(HANDLERS_BY_SUBSTATUS)) if (h.id === id) return h;
    return null;
  }

  function dispatchCardActionHandler(handler, ctx, triggerEl) {
    if (handler.type === 'add_design_visit_to_calendar' ||
        handler.type === 'schedule_visit' ||
        handler.type === 'start_design_visit') {
      if (typeof window.openCardActionModal === 'function') return window.openCardActionModal(handler, ctx);
      console.error('[card-action-handlers] window.openCardActionModal not available — React bundle not loaded?');
      return;
    }
    if (handler.type === 'summarise_phone_call') return openPhoneSummaryModal(handler, ctx);
    if (handler.type === 'show_message')         return openMessagePopup(handler, ctx);
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
    @keyframes cah-spin { to { transform:rotate(360deg); } }
    [data-cah-loading] { pointer-events:none; opacity:0.7; position:relative; }
    [data-cah-loading]::after {
      content:''; display:inline-block; width:12px; height:12px;
      border:2px solid currentColor; border-top-color:transparent;
      border-radius:50%; animation:cah-spin .65s linear infinite;
      margin-left:6px; vertical-align:middle; opacity:0.8;
    }
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

  // openDesignVisitWizard and _makeRoom removed in task #1455.
  // start_design_visit is now handled entirely by CardActionModalsHost → DesignVisitWizard (React).

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
