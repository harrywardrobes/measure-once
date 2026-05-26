// Card action modals — dispatch + modal implementations.
//
// Loaded on sales.html.  The lookup index (HANDLERS_BY_LABEL, HANDLERS_BY_ID,
// etc.) is now owned entirely by the React useCardActionHandlers hook, which
// registers window.cardActionHandlerFor, window.cardActionHandlerById,
// window.loadCardActionHandlers, and window.dispatchCardActionHandler as shims.
// This file reads those shims; it no longer maintains its own copy.
//
// This file still provides:
//
//   window.cardActionHandlerAttrs    — attr-string helper (test probe E.2)
//   window.enquiryRowHtml            — card-strip html helper (test probe E.3)
//   window.openDesignVisitWizard     — multi-step wizard
//
// survey.html and customer-detail.html continue to load card-action-handlers.js
// which provides BOTH the lookup AND dispatch in a single IIFE.

(function () {
  // ── Lookup helpers — delegated to window shims from useCardActionHandlers ──
  // window.cardActionHandlerFor, window.cardActionHandlerById, and
  // window.loadCardActionHandlers are registered by the React hook.  This file
  // reads them; it no longer maintains its own index.

  function cardActionHandlerAttrs(stageKey, leadStatusKey, hwSubstatusValue, ctx) {
    const h = typeof window.cardActionHandlerFor === 'function'
      ? window.cardActionHandlerFor(stageKey, leadStatusKey, hwSubstatusValue)
      : null;
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
    if (handler.type === 'start_design_visit')          return (typeof window.openDesignVisitWizard === 'function' ? window.openDesignVisitWizard(handler, ctx) : console.warn('[card-action-modals] openDesignVisitWizard not ready'));
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
  // The wizard is now a full React component (DesignVisitWizard.tsx).
  // window.openDesignVisitWizard is set by main.tsx after the React bundle
  // loads.  dispatchCardActionHandler delegates to it directly (see above).

  /* istanbul ignore next — kept for potential external callers */
  async function openDesignVisitWizard(handler, ctx, existingVisit) {
    if (typeof window.openDesignVisitWizard === "function") {
      return window.openDesignVisitWizard(handler, ctx, existingVisit);
    }
    console.warn("[card-action-modals] openDesignVisitWizard (React) not ready");
  }
  window.openDesignVisitModal    = openDesignVisitModal;
  window.openPhoneSummaryModal   = openPhoneSummaryModal;
  window.openMessagePopup        = openMessagePopup;


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
    // Use the full handler from the React hook's by-id index (window shim) so
    // config fields like intermediateLeadStatus are available.  Fall back to a
    // minimal stub if the index hasn't been populated yet.
    const handler = (typeof window.cardActionHandlerById === 'function'
      ? window.cardActionHandlerById(id)
      : null) || { id, type, config: {} };
    dispatchCardActionHandler(handler, ctx);
  }, true);

  // window.dispatchCardActionHandler is registered by the React
  // useCardActionHandlers hook (which imports dispatchCardActionHandler from
  // src/react/utils/dispatchCardActionHandler.ts).  We expose it here only as
  // a fallback for pages that don't mount the React hook (survey.html,
  // customer-detail.html still load card-action-handlers.js which registers its
  // own copy).
  if (typeof window.dispatchCardActionHandler !== 'function') {
    window.dispatchCardActionHandler = dispatchCardActionHandler;
  }

})();
