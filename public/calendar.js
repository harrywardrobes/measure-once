// ── Calendar state & helpers ──────────────────────────────────────────────────
const VISIT_TYPE_META = {
  design:       { label: 'Design visit',  color: '#3b82f6' },
  survey:       { label: 'Survey',        color: '#f59e0b' },
  installation: { label: 'Installation',  color: '#10b981' },
  remedial:     { label: 'Remedial',      color: '#ef4444' },
  workshop:     { label: 'Workshop time', color: '#8b5cf6' },
  other:        { label: 'Other',         color: '#6b7280' }
};
const DAY_START_HOUR = 7;
const DAY_END_HOUR   = 20;
const HOUR_PX        = 56;

function calStartOfDay(d)   { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function calAddDays(d, n)   { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function calStartOfWeek(d)  { const x = calStartOfDay(d); x.setDate(x.getDate() - ((x.getDay()+6)%7)); return x; }
function calStartOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }

function initCalendarState() {
  if (state.calendar) return;
  state.calendar = {
    cursor: calStartOfDay(new Date()),
    showWorkshop: true,
    visits: []
  };
}

function calRange() {
  const f = calStartOfWeek(state.calendar.cursor);
  return { from: f, to: calAddDays(f, 7) };
}

async function loadTasksView() {
  initCalendarState();
  const view = document.getElementById('tasks-view');
  view.innerHTML = `<div class="cal-shell"><div class="flex items-center gap-2 text-sm" style="color:var(--stone-deep);padding:16px"><div class="spinner"></div> Loading…</div></div>`;
  const { from, to } = calRange();
  try {
    const [visits, tasks, platformUsers] = await Promise.all([
      GET(`/api/visits?from=${from.toISOString()}&to=${to.toISOString()}`),
      GET('/api/personal-tasks'),
      state.platformUsers?.length ? Promise.resolve(state.platformUsers) : GET('/api/platform-users').catch(() => [])
    ]);
    state.calendar.visits = visits || [];
    state.personalTasks   = tasks || [];
    state.platformUsers   = platformUsers || [];
    renderTasksView();
  } catch (e) {
    const isDbError = e.code === 'DB_ERROR';
    const msg = isDbError
      ? 'The calendar couldn\'t be loaded — there was a problem reaching the database.'
      : `Failed to load calendar: ${escHtml(e.message)}`;
    view.innerHTML = `
      <div class="cal-shell">
        <div style="padding:2rem;text-align:center;color:#b91c1c;font-size:0.875rem">
          <p>${msg}</p>
          <button onclick="loadTasksView()" style="margin-top:0.75rem;padding:0.4rem 1rem;border:1px solid #6b7280;border-radius:0.375rem;background:#f9fafb;cursor:pointer;font-size:0.875rem;">Retry</button>
          ${isDbError ? '<p style="margin-top:0.5rem;font-size:0.8rem;color:#6b7280;">If this keeps happening, try refreshing the page.</p>' : ''}
        </div>
      </div>`;
  }
}

function renderTasksView() {
  initCalendarState();
  const view = document.getElementById('tasks-view');
  if (!view) return;
  const c = state.calendar;
  const body = renderAgendaView();
  view.innerHTML = `
    <div class="cal-shell">
      ${renderCalendarHeader()}
      ${renderCalTopPanel()}
      <div class="cal-body">${body}</div>
      ${renderPersonalTasksSection()}
    </div>
  `;
}

function weekDays() {
  const start = calStartOfWeek(state.calendar.cursor);
  return [0,1,2,3,4,5,6].map(i => calAddDays(start, i));
}

function calHeaderTitle() {
  const c = state.calendar;
  const s = calStartOfWeek(c.cursor), e = calAddDays(s, 6);
  if (s.getMonth() === e.getMonth())
    return `${s.getDate()}–${e.getDate()} ${s.toLocaleDateString('en-GB',{month:'long',year:'numeric'})}`;
  return `${s.toLocaleDateString('en-GB',{day:'numeric',month:'short'})} – ${e.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}`;
}

function renderCalendarHeader() {
  const c = state.calendar;
  return `
    <div class="cal-header">
      <div class="cal-nav">
        <button class="cal-nav-btn" onclick="calNav(-1)" aria-label="Previous">‹</button>
        <button class="cal-today-btn" onclick="calGoToday()">Today</button>
        <button class="cal-nav-btn" onclick="calNav(1)" aria-label="Next">›</button>
        <span class="cal-title">${calHeaderTitle()}</span>
      </div>
      <div class="cal-actions">

        <label class="cal-workshop-toggle">
          <input type="checkbox" ${c.showWorkshop?'checked':''} onchange="calToggleWorkshop(this.checked)">
          <span>Workshop time</span>
        </label>
        <button class="cal-new-btn" onclick="openVisitModal()" data-viewer-hide>+ New visit</button>
      </div>
    </div>
  `;
}

function visibleVisits(dayStart, dayEnd) {
  const c = state.calendar;
  return c.visits.filter(v => {
    if (!c.showWorkshop && v.isWorkshop) return false;
    const s = new Date(v.startAt), e = new Date(v.endAt);
    return s < dayEnd && e > dayStart;
  });
}

function renderPersonalTasksSection() {
  const pending = state.personalTasks.filter(t => !t.done);
  return `
    <details class="cal-ptasks">
      <summary class="cal-ptasks-summary">Personal tasks${pending.length?` (${pending.length})`:''}</summary>
      <div class="cal-ptasks-body">
        ${state.showAddPersonalTask ? `
          <div class="ptask-add-form">
            <input id="ptask-title" type="text" placeholder="Task title" class="ptask-input"
              onkeydown="if(event.key==='Enter')submitPersonalTask()">
            <div class="flex gap-2 mt-2 items-center">
              <input id="ptask-due" type="date" class="ptask-date-input">
              <div style="flex:1"></div>
              <button onclick="state.showAddPersonalTask=false;renderTasksView()" class="ptask-cancel-btn">Cancel</button>
              <button onclick="submitPersonalTask()" class="ptask-confirm-btn">Add task</button>
            </div>
          </div>` : `
          <button onclick="state.showAddPersonalTask=true;renderTasksView();setTimeout(()=>document.getElementById('ptask-title')?.focus(),30)"
            class="ptask-add-btn">+ Add task</button>`}
        ${state.personalTasks.length === 0
          ? `<p style="font-size:0.85rem;color:var(--stone-deep);padding:8px 0;">No personal tasks.</p>`
          : state.personalTasks.map(t => personalTaskHtml(t)).join('')}
      </div>
    </details>`;
}

// ── Agenda view (week layout B) ──────────────────────────────────────────────
function renderAgendaView() {
  const days = weekDays();
  const todayMs = calStartOfDay(new Date()).getTime();
  const SPAN = DAY_END_HOUR - DAY_START_HOUR;
  return days.map(day => {
    const dayStart  = calStartOfDay(day);
    const dayEnd    = calAddDays(dayStart, 1);
    const isToday   = dayStart.getTime() === todayMs;
    const dayVisits = visibleVisits(dayStart, dayEnd);
    const headCls   = isToday ? ' agenda-day-today' : '';
    const isoDay = dayStart.toISOString();
    if (dayVisits.length === 0) {
      return `<div class="agenda-day-card${headCls} agenda-day-card--clickable" onclick="openVisitModal(null,'${isoDay}')" title="Click to add a visit">
        <div class="agenda-day-head">
          <div class="agenda-day-meta">
            <span class="agenda-day-num${isToday?' agenda-day-num-today':''}">${day.getDate()}</span>
            <div class="agenda-day-info">
              <span class="agenda-day-name">${day.toLocaleDateString('en-GB',{weekday:'long'})}</span>
              ${isToday?'<span class="agenda-day-rel">Today</span>':''}
            </div>
          </div>
        </div>
        <div class="agenda-empty">No visits scheduled</div>
        <div class="agenda-add-hint">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="flex-shrink:0"><line x1="6" y1="1" x2="6" y2="11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          Add visit
        </div>
      </div>`;
    }
    const miniBlks = dayVisits.map(v => {
      const s = new Date(v.startAt), e = new Date(v.endAt);
      const sh = Math.max(s.getHours() + s.getMinutes()/60, DAY_START_HOUR);
      const eh = Math.min(e.getHours() + e.getMinutes()/60, DAY_END_HOUR);
      const left  = ((sh - DAY_START_HOUR) / SPAN) * 100;
      const width = Math.max(1, ((eh - sh) / SPAN) * 100);
      const m = VISIT_TYPE_META[v.type] || VISIT_TYPE_META.other;
      return `<div class="agenda-mini-blk" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%;background:${m.color}"></div>`;
    }).join('');
    const rows = dayVisits.map(v => renderAgendaRow(v)).join('');
    return `<div class="agenda-day-card${headCls} agenda-day-card--clickable" onclick="openVisitModal(null,'${isoDay}')" title="Click empty area to add a visit">
      <div class="agenda-day-head">
        <div class="agenda-day-meta">
          <span class="agenda-day-num${isToday?' agenda-day-num-today':''}">${day.getDate()}</span>
          <div class="agenda-day-info">
            <span class="agenda-day-name">${day.toLocaleDateString('en-GB',{weekday:'long'})}</span>
            ${isToday?'<span class="agenda-day-rel">Today</span>':''}
          </div>
        </div>
        <span class="agenda-day-count">${dayVisits.length} visit${dayVisits.length>1?'s':''}</span>
      </div>
      <div class="agenda-mini-timeline">${miniBlks}</div>
      <div class="agenda-mini-axis">
        <span>${DAY_START_HOUR}:00</span><span>${Math.floor((DAY_START_HOUR+DAY_END_HOUR)/2)}:00</span><span>${DAY_END_HOUR}:00</span>
      </div>
      <div class="agenda-rows">${rows}</div>
      <div class="agenda-add-hint agenda-add-hint--visits">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="flex-shrink:0"><line x1="6" y1="1" x2="6" y2="11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        Add visit
      </div>
    </div>`;
  }).join('');
}

function renderAgendaRow(v) {
  const meta = VISIT_TYPE_META[v.type] || VISIT_TYPE_META.other;
  const s = new Date(v.startAt), e = new Date(v.endAt);
  const fmt = d => d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
  const customer = v.customerName || v.title || '—';
  const assignee = (state.platformUsers || []).find(u => u.id === v.assigneeId);
  const assigneeName = assignee ? `${assignee.firstName} ${assignee.lastName}`.trim() || assignee.email : null;
  const assigneeHtml = v.assigneeRole
    ? `<span class="agenda-assignee-chip">${v.assigneeRole.charAt(0).toUpperCase()+v.assigneeRole.slice(1)}${assigneeName ? ' · '+escHtml(assigneeName) : ''}</span>`
    : (assigneeName ? `<span class="agenda-assignee-chip">${escHtml(assigneeName)}</span>` : '');
  return `<div class="agenda-row" onclick="event.stopPropagation();openVisitModal(${v.id})">
    <div class="agenda-row-pill" style="background:${meta.color}"></div>
    <div class="agenda-row-time">${fmt(s)}<span class="agenda-row-end"> – ${fmt(e)}</span></div>
    <div class="agenda-row-body">
      <div class="agenda-row-title">
        <span class="agenda-type-tag" style="background:${meta.color}">${escHtml(meta.label)}</span>${escHtml(customer)}
      </div>
      <div class="agenda-row-meta">
        ${v.location ? `<span>📍 ${escHtml(v.location)}</span>` : ''}
        ${assigneeHtml}
      </div>
    </div>
  </div>`;
}

// ── Top panel: mini calendars + visit stats ──────────────────────────────────
function renderCalTopPanel() {
  const c = state.calendar;
  const today = new Date();
  const todayMs = calStartOfDay(today).getTime();
  const month1 = new Date(c.cursor.getFullYear(), c.cursor.getMonth(), 1);
  const month2 = new Date(month1.getFullYear(), month1.getMonth() + 1, 1);

  const typeCounts = {};
  let totalHours = 0;
  for (const v of c.visits) {
    if (!c.showWorkshop && v.isWorkshop) continue;
    typeCounts[v.type] = (typeCounts[v.type] || 0) + 1;
    totalHours += (new Date(v.endAt) - new Date(v.startAt)) / 3600000;
  }

  const statsHtml = `
    <div class="cal-stats">
      <div class="cal-stats-title">This period</div>
      ${Object.entries(VISIT_TYPE_META).map(([k, m]) =>
        typeCounts[k] ? `<div class="cal-stat-row">
          <span class="cal-stat-dot" style="background:${m.color}"></span>
          <span class="cal-stat-label">${m.label}</span>
          <span class="cal-stat-count">${typeCounts[k]}</span>
        </div>` : ''
      ).filter(Boolean).join('')}
      ${Object.keys(typeCounts).length === 0
        ? '<div class="cal-stat-empty">No visits this period</div>'
        : `<div class="cal-stat-total">${totalHours.toFixed(1)} hrs total</div>`}
    </div>`;

  const miniCalHtml = (month) => {
    const first = calStartOfMonth(month);
    const gridStart = calAddDays(first, -((first.getDay()+6)%7));
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = calAddDays(gridStart, i);
      const inMonth  = d.getMonth() === first.getMonth();
      const dMs      = calStartOfDay(d).getTime();
      const isToday  = dMs === todayMs;
      const isCursor = dMs === calStartOfDay(c.cursor).getTime();
      const dayStart = calStartOfDay(d), dayEnd = calAddDays(dayStart, 1);
      const dots = c.visits.filter(v => {
        const s = new Date(v.startAt), e = new Date(v.endAt);
        return s < dayEnd && e > dayStart && (c.showWorkshop || !v.isWorkshop);
      }).slice(0, 3).map(v => {
        const m = VISIT_TYPE_META[v.type] || VISIT_TYPE_META.other;
        return `<span class="cal-mini-dot" style="background:${m.color}"></span>`;
      }).join('');
      cells.push(`<div class="cal-mini-cell${!inMonth?' cal-mini-out':''}${isToday?' cal-mini-today':''}${isCursor?' cal-mini-selected':''}"
        onclick="calMiniDayClick('${dayStart.toISOString()}')">
        <span class="cal-mini-num">${d.getDate()}</span>
        <span class="cal-mini-dots">${dots}</span>
      </div>`);
    }
    const headers = ['M','T','W','T','F','S','S'].map(d => `<span class="cal-mini-dow">${d}</span>`).join('');
    return `<div class="cal-mini-month">
      <div class="cal-mini-month-title">${month.toLocaleDateString('en-GB',{month:'long',year:'numeric'})}</div>
      <div class="cal-mini-grid">${headers}${cells.join('')}</div>
    </div>`;
  };

  return `
    <div class="cal-top-panel">
      <details class="cal-top-mobile">
        <summary class="cal-top-mobile-summary">
          Schedule overview · ${Object.values(typeCounts).reduce((a,b)=>a+b,0)} visits
        </summary>
        <div class="cal-top-mobile-body">${statsHtml}</div>
      </details>
      <div class="cal-top-desktop">
        ${miniCalHtml(month1)}
        ${miniCalHtml(month2)}
        ${statsHtml}
      </div>
    </div>`;
}

function calNav(dir) {
  state.calendar.cursor = calAddDays(state.calendar.cursor, 7 * dir);
  loadTasksView();
}
function calGoToday()              { state.calendar.cursor = calStartOfDay(new Date()); loadTasksView(); }
function calToggleWorkshop(checked){ state.calendar.showWorkshop = checked; renderTasksView(); }
function calMiniDayClick(iso)      { state.calendar.cursor = new Date(iso); loadTasksView().then(() => openVisitModal(null, iso)); }


function contactDisplayName(c) {
  const p = (c && c.properties) || {};
  const n = `${p.firstname || ''} ${p.lastname || ''}`.trim();
  return n || p.email || `Contact ${c?.id || ''}`;
}

function openVisitModal(visitId, prefillDate) {
  if (isViewerOnly()) return;
  const existing = visitId ? state.calendar.visits.find(v => v.id === visitId) : null;
  const start = existing ? new Date(existing.startAt) : (prefillDate ? new Date(prefillDate) : new Date());
  const end   = existing ? new Date(existing.endAt)   : new Date(start.getTime() + 60*60*1000);
  const fmtDate = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const fmtTime = d => `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  const contacts = (state.contacts || []).slice().sort((a,b) =>
    contactDisplayName(a).toLowerCase().localeCompare(contactDisplayName(b).toLowerCase()));

  const modal = document.createElement('div');
  modal.className = 'visit-modal-overlay';
  modal.onclick = e => { if (e.target === modal) closeVisitModal(); };
  modal.innerHTML = `
    <div class="visit-modal">
      <div class="visit-modal-header">
        <h3>${existing ? 'Edit visit' : 'New visit'}</h3>
        <button class="visit-modal-close" onclick="closeVisitModal()" aria-label="Close">✕</button>
      </div>
      <div class="visit-modal-body">
        <label class="visit-field">
          <span class="visit-label">Type</span>
          <select id="vm-type" class="visit-input">
            ${Object.entries(VISIT_TYPE_META).map(([k,m]) => {
              const sel = existing ? existing.type===k : k==='design';
              return `<option value="${k}" ${sel?'selected':''}>${m.label}</option>`;
            }).join('')}
          </select>
        </label>
        <label class="visit-field">
          <span class="visit-label">Customer</span>
          <select id="vm-customer" class="visit-input">
            <option value="">— None —</option>
            ${contacts.map(c => `<option value="${c.id}" ${existing?.customerId===c.id?'selected':''}>${escHtml(contactDisplayName(c))}</option>`).join('')}
          </select>
        </label>
        <label class="visit-field">
          <span class="visit-label">Title (optional)</span>
          <input id="vm-title" type="text" class="visit-input" value="${escHtml(existing?.title||'')}" placeholder="e.g. Kitchen install — day 1">
        </label>
        <div class="visit-row">
          <label class="visit-field"><span class="visit-label">Date</span>
            <input id="vm-date" type="date" class="visit-input" value="${fmtDate(start)}"></label>
          <label class="visit-field"><span class="visit-label">Start</span>
            <input id="vm-start" type="time" class="visit-input" value="${fmtTime(start)}"></label>
          <label class="visit-field"><span class="visit-label">End</span>
            <input id="vm-end" type="time" class="visit-input" value="${fmtTime(end)}"></label>
        </div>
        <label class="visit-field">
          <span class="visit-label">Location (optional)</span>
          <input id="vm-location" type="text" class="visit-input" value="${escHtml(existing?.location||'')}">
        </label>
        <label class="visit-field">
          <span class="visit-label">Notes</span>
          <textarea id="vm-notes" class="visit-input visit-textarea" rows="3">${escHtml(existing?.notes||'')}</textarea>
        </label>
        <div class="visit-row">
          <label class="visit-field">
            <span class="visit-label">Assigned role</span>
            <select id="vm-assignee-role" class="visit-input">
              <option value="">— None —</option>
              ${['designer','surveyor','fitter','manager'].map(r => {
                const sel = existing?.assigneeRole === r;
                return `<option value="${r}" ${sel?'selected':''}>${r.charAt(0).toUpperCase()+r.slice(1)}</option>`;
              }).join('')}
            </select>
          </label>
          <label class="visit-field">
            <span class="visit-label">Assigned to</span>
            <select id="vm-assignee-id" class="visit-input">
              <option value="">— None —</option>
              ${(state.platformUsers || []).map(u => {
                const name = `${u.firstName} ${u.lastName}`.trim() || u.email;
                const sel = existing?.assigneeId === u.id;
                return `<option value="${u.id}" ${sel?'selected':''}>${escHtml(name)}</option>`;
              }).join('')}
            </select>
          </label>
        </div>
        ${!existing && state.authStatus?.google ? `
        <label class="visit-field" style="flex-direction:row;align-items:center;gap:8px;cursor:pointer">
          <input id="vm-gcal" type="checkbox" style="width:16px;height:16px;flex-shrink:0;cursor:pointer">
          <span class="visit-label" style="margin:0;cursor:pointer">Also add to Google Calendar</span>
        </label>` : ''}
      </div>
      <div class="visit-modal-footer">
        ${existing ? `<button class="visit-delete-btn" onclick="deleteVisit(${existing.id})">Delete</button>` : '<span></span>'}
        <div style="display:flex;gap:8px">
          <button class="visit-cancel-btn" onclick="closeVisitModal()">Cancel</button>
          <button class="visit-save-btn" onclick="saveVisit(${existing?existing.id:'null'})">Save</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const gcalBox = document.getElementById('vm-gcal');
  if (gcalBox) {
    gcalBox.checked = localStorage.getItem('gcal_sync_pref') === 'true';
    gcalBox.addEventListener('change', () => {
      localStorage.setItem('gcal_sync_pref', gcalBox.checked);
    });
  }
}

function closeVisitModal() { document.querySelector('.visit-modal-overlay')?.remove(); }

async function saveVisit(id) {
  const type        = document.getElementById('vm-type').value;
  const customerId  = document.getElementById('vm-customer').value || null;
  const customerName = customerId
    ? contactDisplayName(state.contacts.find(c => c.id === customerId) || { properties: {} })
    : null;
  const title    = document.getElementById('vm-title').value.trim() || null;
  const dateStr  = document.getElementById('vm-date').value;
  const startStr = document.getElementById('vm-start').value;
  const endStr   = document.getElementById('vm-end').value;
  const location    = document.getElementById('vm-location').value.trim() || null;
  const notes       = document.getElementById('vm-notes').value.trim() || null;
  const assigneeRole = document.getElementById('vm-assignee-role').value || null;
  const assigneeId   = document.getElementById('vm-assignee-id').value || null;
  const addToGcal    = document.getElementById('vm-gcal')?.checked || false;
  if (!dateStr || !startStr || !endStr) { showToast('Date and times are required', true); return; }
  const startAt = new Date(`${dateStr}T${startStr}`);
  const endAt   = new Date(`${dateStr}T${endStr}`);
  if (endAt <= startAt) { showToast('End must be after start', true); return; }
  const payload = { type, customerId, customerName, title, startAt: startAt.toISOString(), endAt: endAt.toISOString(), location, notes, assigneeRole, assigneeId };
  try {
    if (id) await PATCH_REQ(`/api/visits/${id}`, payload);
    else    await POST('/api/visits', payload);
    closeVisitModal();
    showToast(id ? 'Visit updated' : 'Visit created');
    loadTasksView();
    if (!id && addToGcal) {
      await createGoogleCalendarEvent({ title, customerName, startAt, endAt, location, notes, type });
    }
  } catch { showToast('Failed to save visit', true); }
}

async function createGoogleCalendarEvent({ title, customerName, startAt, endAt, location, notes, type }) {
  const meta = VISIT_TYPE_META[type] || VISIT_TYPE_META.other;
  const summary = title
    ? title
    : (customerName ? `${meta.label} — ${customerName}` : meta.label);
  const description = [
    customerName ? `Customer: ${customerName}` : '',
    notes || '',
  ].filter(Boolean).join('\n');
  const eventBody = {
    summary,
    location: location || undefined,
    description: description || undefined,
    start: { dateTime: startAt.toISOString() },
    end:   { dateTime: endAt.toISOString() },
  };
  try {
    await POST('/api/events', eventBody);
    showToast('Added to Google Calendar');
  } catch (e) {
    if (e.code === 'GOOGLE_AUTH') {
      showToast('Google account disconnected — reconnect in Settings', true);
    } else {
      showToast('Could not add to Google Calendar. Please try again.', true);
    }
  }
}

async function deleteVisit(id) {
  if (!confirm('Delete this visit?')) return;
  try {
    await DELETE_REQ(`/api/visits/${id}`);
    closeVisitModal();
    showToast('Visit deleted');
    loadTasksView();
  } catch { showToast('Failed to delete visit', true); }
}

function personalTaskHtml(task) {
  const isDone = task.done;
  const overdue = !isDone && task.dueDate && task.dueDate < new Date().toISOString().slice(0,10);
  const dueFmt = task.dueDate
    ? new Date(task.dueDate + 'T12:00:00').toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })
    : '';
  return `
    <div class="ptask-item ${isDone ? 'ptask-done' : ''}">
      <button class="task-check ${isDone ? 'task-check-done' : ''}"
        onclick="togglePersonalTask('${task.id}')"
        aria-label="${isDone ? 'Mark incomplete' : 'Mark complete'}">
        ${isDone ? `<svg width="11" height="9" fill="none" stroke="currentColor" viewBox="0 0 12 10"><polyline points="1,5 4.5,8.5 11,1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>` : ''}
      </button>
      <div class="task-content">
        <div class="task-subject ${isDone ? 'task-subject-done' : ''}">${escHtml(task.title)}</div>
        ${dueFmt ? `<div class="task-due ${overdue ? 'task-due-overdue' : ''}">${overdue ? 'Overdue — ' : ''}${dueFmt}</div>` : ''}
      </div>
      <button class="task-delete" onclick="deletePersonalTask('${task.id}')" aria-label="Delete">
        <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>
    </div>
  `;
}

function calEventHtml(ev) {
  const start = ev.start?.dateTime || ev.start?.date;
  const isAllDay = !!ev.start?.date;
  const startDate = start ? new Date(isAllDay ? start + 'T00:00:00' : start) : null;
  const dateFmt = startDate
    ? startDate.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' })
    : '';
  const timeFmt = (!isAllDay && startDate)
    ? startDate.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' })
    : 'All day';
  return `
    <div class="cal-event-item">
      <div class="cal-event-date">${dateFmt}</div>
      <div class="cal-event-body">
        <div class="cal-event-title">${escHtml(ev.summary || 'Untitled event')}</div>
        <div class="cal-event-time">${timeFmt}${ev.location ? ` · ${escHtml(ev.location)}` : ''}</div>
      </div>
    </div>
  `;
}

async function submitPersonalTask() {
  const title = document.getElementById('ptask-title')?.value.trim();
  const due   = document.getElementById('ptask-due')?.value || null;
  if (!title) return;
  try {
    const task = await POST('/api/personal-tasks', { title, dueDate: due });
    state.personalTasks.push(task);
    state.showAddPersonalTask = false;
    renderTasksView();
  } catch { showToast('Failed to save task', true); }
}

async function togglePersonalTask(id) {
  const task = state.personalTasks.find(t => t.id === id);
  if (!task) return;
  try {
    const updated = await PATCH_REQ(`/api/personal-tasks/${id}`, { done: !task.done });
    Object.assign(task, updated);
    renderTasksView();
  } catch { showToast('Failed to update task', true); }
}

async function deletePersonalTask(id) {
  try {
    await DELETE_REQ(`/api/personal-tasks/${id}`);
    state.personalTasks = state.personalTasks.filter(t => t.id !== id);
    renderTasksView();
  } catch { showToast('Failed to delete task', true); }
}

