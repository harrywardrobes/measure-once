function renderHomeTab() {
  const el = document.getElementById('home-view');
  if (!el) return;

  // ── Full-page loading skeleton ─────────────────────────────────────────────
  if (state.homeLoading) {
    const skLine = (w, h = 13, extra = '') =>
      UI.skeletonLine(w, h, extra ? { style: extra } : undefined);
    const skCard = (w1 = '50%', w2 = '44px') => `
      <div class="home-card" style="pointer-events:none;cursor:default">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          ${skLine(w1, 13)}
          ${skLine(w2, 18, 'border-radius:999px;flex-shrink:0')}
        </div>
        ${skLine('30%', 10, 'margin-top:5px')}
      </div>`;
    const skSection = (labelW, cards) => `
      <div class="home-section">
        <div class="home-section-header">${skLine(labelW, 10)}</div>
        ${cards.map(([w1, w2]) => skCard(w1, w2)).join('')}
      </div>`;
    el.innerHTML = `
      <div class="home-date-header">
        ${skLine('130px', 22)}
        <div style="margin-top:5px">${skLine('170px', 12)}</div>
      </div>
      ${skSection('80px', [['48%', '44px'], ['54%', '44px']])}
      ${skSection('102px', [['44%', '52px'], ['50%', '52px'], ['38%', '52px']])}
    `;
    return;
  }

  const now     = new Date();
  const todayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  const overdue = state.personalTasks.filter(t =>
    !t.done && t.dueDate && new Date(t.dueDate).getTime() < todayMs);
  const today = state.personalTasks.filter(t =>
    !t.done && t.dueDate && new Date(t.dueDate).getTime() >= todayMs &&
    new Date(t.dueDate).getTime() < todayMs + 86400000);
  const dueTasks = [...overdue, ...today];

  const calEvents    = (state.calendarEvents || []).slice(0, 3);
  const calError     = !!state.calendarError;
  const calLoading   = !!state.calendarLoading;
  const calAuthError = calError && state.calendarErrorCode === 'GOOGLE_AUTH';

  const qbLoading  = !state.qb.loadError && (!state.qb.statusKnown || (state.qb.connected && (state.qb.loading || !state.qb.loaded)));
  const qbError    = state.qb.loadError;
  const overdueInvs = state.qb.connected && state.qb.loaded
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

    ${calLoading ? `
    <div class="home-section">
      <div class="home-section-header">
        <span class="home-section-title">Upcoming</span>
      </div>
      ${[['60%', '40%'], ['50%', '36%']].map(([w1, w2]) => `
        <div class="home-card" style="pointer-events:none;cursor:default">
          ${UI.skeletonLine(w2, 10)}
          ${UI.skeletonLine(w1, 13, { style: 'margin-top:6px' })}
        </div>`).join('')}
    </div>` : calError ? `
    <div class="home-section">
      <div class="home-section-header">
        <span class="home-section-title">Upcoming</span>
      </div>
      <div class="home-card" style="pointer-events:none;cursor:default;border-color:#fecaca;background:#fef2f2">
        <div style="display:flex;align-items:flex-start;gap:10px">
          <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" style="color:#ef4444;flex-shrink:0;margin-top:1px">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"
              d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
          </svg>
          <div style="min-width:0;flex:1">
            <div class="home-card-title" style="color:#ef4444">${calAuthError ? 'Your Google account was disconnected' : `Calendar couldn't be loaded`}</div>
            <div class="home-card-sub" style="white-space:normal">${calAuthError
              ? `Reconnect Google to see your upcoming events.`
              : `Google Calendar returned an unexpected error. Check your connection and try again.`}</div>
            ${calAuthError
              ? `<a href="/profile" class="qb-refresh-btn" style="margin-top:8px;padding:6px 12px;font-size:12px;pointer-events:auto;display:inline-flex;align-items:center;text-decoration:none">Reconnect in Settings</a>`
              : `<button onclick="loadCalendarForHome()" class="qb-refresh-btn" style="margin-top:8px;padding:6px 12px;font-size:12px;pointer-events:auto">
              <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
              </svg>
              Retry
            </button>`}
          </div>
        </div>
      </div>
    </div>` : state.calendarConnected && calEvents.length > 0 ? `
    <div class="home-section">
      <div class="home-section-header">
        <span class="home-section-title">Upcoming</span>
        <button class="home-section-link" onclick="location.href='/calendar'">Calendar</button>
      </div>
      ${calEvents.map(eventCard).join('')}
    </div>` : ''}

    ${qbLoading ? `
    <div class="home-section">
      <div class="home-section-header">
        <span class="home-section-title">Overdue Invoices</span>
      </div>
      ${[['52%', '56px'], ['40%', '48px']].map(([w1, w2]) => `
        <div class="home-card" style="pointer-events:none;cursor:default">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
            ${UI.skeletonLine(w1, 13)}
            ${UI.skeletonLine(w2, 18, { style: 'border-radius:999px;flex-shrink:0' })}
          </div>
          ${UI.skeletonLine('88px', 10, { style: 'margin-top:5px' })}
        </div>`).join('')}
    </div>` : qbError ? (() => {
      const isDbError = state.qb.errorCode === 'DB_ERROR';
      const msg = isDbError
        ? 'The database could not be reached. Check your connection and try again.'
        : (state.qb.error || 'QuickBooks returned an unexpected error.');
      return `
    <div class="home-section">
      <div class="home-section-header">
        <span class="home-section-title">Overdue Invoices</span>
      </div>
      <div class="home-card" style="pointer-events:none;cursor:default;border-color:#fecaca;background:#fef2f2">
        <div style="display:flex;align-items:flex-start;gap:10px">
          <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" style="color:#ef4444;flex-shrink:0;margin-top:1px">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"
              d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
          </svg>
          <div style="min-width:0;flex:1">
            <div class="home-card-title" style="color:#ef4444">Invoices couldn't be loaded</div>
            <div class="home-card-sub" style="white-space:normal">${escHtml(msg)}</div>
            <button onclick="loadQBInvoices()" class="qb-refresh-btn" style="margin-top:8px;padding:6px 12px;font-size:12px;pointer-events:auto">
              <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
              </svg>
              Retry
            </button>
          </div>
        </div>
      </div>
    </div>`;
    })() : overdueInvs.length > 0 ? `
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

