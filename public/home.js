function renderHomeTab() {
  const el = document.getElementById('home-view');
  if (!el) return;

  const now     = new Date();
  const todayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  const overdue = state.personalTasks.filter(t =>
    !t.done && t.dueDate && new Date(t.dueDate).getTime() < todayMs);
  const today = state.personalTasks.filter(t =>
    !t.done && t.dueDate && new Date(t.dueDate).getTime() >= todayMs &&
    new Date(t.dueDate).getTime() < todayMs + 86400000);
  const dueTasks = [...overdue, ...today];

  const calEvents = (state.calendarEvents || []).slice(0, 3);

  const overdueInvs = state.qb.connected
    ? state.qb.invoices.filter(inv => inv.dueDate && new Date(inv.dueDate).getTime() < todayMs).slice(0, 4)
    : [];

  const activeCustomers = state.contacts.filter(c =>
    (state.contactStageCache[c.id] || []).some(r => (r.roomStatus || 'active') === 'active')
  ).slice(0, 6);

  const dayName  = now.toLocaleDateString('en-GB', { weekday: 'long' });
  const dateStr  = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  function taskCard(t) {
    const isOvr = t.dueDate && new Date(t.dueDate).getTime() < todayMs;
    const dueLbl = t.dueDate ? fmtQBDate(t.dueDate) : '';
    return `<div class="home-card" onclick="location.href='/calendar'">
      <div class="home-card-title">${escHtml(t.title)}</div>
      ${dueLbl ? `<div class="home-card-sub ${isOvr ? 'home-card-sub-red' : ''}">${isOvr ? '⚠ Overdue · ' : ''}${dueLbl}</div>` : ''}
    </div>`;
  }

  function eventCard(ev) {
    const start = ev.start?.dateTime || ev.start?.date;
    const d     = start ? new Date(start) : null;
    const when  = d
      ? d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) +
        (ev.start?.dateTime ? ' · ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '')
      : '';
    return `<div class="home-card">
      ${when ? `<div class="home-card-sub">${escHtml(when)}</div>` : ''}
      <div class="home-card-title">${escHtml(ev.summary || 'Event')}</div>
    </div>`;
  }

  function invCard(inv) {
    return `<div class="home-card" onclick="openInvoicePanel('${escHtml(inv.id)}')">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <div class="home-card-title" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(inv.customerName || '—')}</div>
        <span class="home-badge home-badge-red" style="flex-shrink:0">${fmtGBP(inv.balance)}</span>
      </div>
      <div class="home-card-sub home-card-sub-red">Due ${fmtQBDate(inv.dueDate)}</div>
    </div>`;
  }

  function customerCard(c) {
    const rooms   = state.contactStageCache[c.id] || [];
    const active  = rooms.filter(r => (r.roomStatus || 'active') === 'active');
    const stage   = active[0]?.stageKey;
    const stageLbl = stage ? (state.workflow?.stages?.[stage]?.label || stage) : null;
    const name    = [c.properties?.firstname, c.properties?.lastname].filter(Boolean).join(' ') || '—';
    return `<div class="home-card" onclick="openProject('${c.id}', 0)">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <div class="home-card-title">${escHtml(name)}</div>
        ${stageLbl ? `<span class="home-badge home-badge-stage">${escHtml(stageLbl)}</span>` : ''}
      </div>
      ${active.length > 1 ? `<div class="home-card-sub">${active.length} active rooms</div>` : ''}
    </div>`;
  }

  el.innerHTML = `
    <div class="home-date-header">
      <div class="home-date-day">${dayName}</div>
      <div class="home-date-full">${dateStr}</div>
    </div>

    <div class="home-section">
      <div class="home-section-header">
        <span class="home-section-title">My Tasks${overdue.length ? ` <span class="home-badge home-badge-red" style="margin-left:6px">${overdue.length} overdue</span>` : ''}</span>
        <button class="home-section-link" onclick="location.href='/calendar'">See all</button>
      </div>
      ${dueTasks.length === 0
        ? `<div class="home-empty">No tasks due today — you're all clear.</div>`
        : dueTasks.slice(0, 4).map(taskCard).join('') +
          (dueTasks.length > 4 ? `<button class="home-more" onclick="location.href='/calendar'">+${dueTasks.length - 4} more tasks</button>` : '')
      }
    </div>

    ${state.calendarConnected && calEvents.length > 0 ? `
    <div class="home-section">
      <div class="home-section-header">
        <span class="home-section-title">Upcoming</span>
        <button class="home-section-link" onclick="location.href='/calendar'">Calendar</button>
      </div>
      ${calEvents.map(eventCard).join('')}
    </div>` : ''}

    ${overdueInvs.length > 0 ? `
    <div class="home-section">
      <div class="home-section-header">
        <span class="home-section-title">Overdue Invoices</span>
        <button class="home-section-link" onclick="location.href='/invoices'">See all</button>
      </div>
      ${overdueInvs.map(invCard).join('')}
    </div>` : ''}

    ${activeCustomers.length > 0 ? `
    <div class="home-section">
      <div class="home-section-header">
        <span class="home-section-title">Active Projects</span>
        <button class="home-section-link" onclick="location.href='/sales'">All customers</button>
      </div>
      ${activeCustomers.map(customerCard).join('')}
    </div>` : ''}
  `;
}

