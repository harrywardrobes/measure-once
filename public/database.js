// Admin database editor — frontend.
// Renders the table picker, the row grid, the add/edit/delete drawer,
// and the audit log tab. All edits go through /api/admin/db/*.

(function () {
  let TABLES = [];           // [{name, group, pk, columns, fkLabels, readOnlyTable}]
  let currentTable = null;   // table descriptor
  let currentRows = [];
  let currentMeta = { page: 1, pageSize: 50, total: 0, sort: null, dir: 'asc', search: '' };
  let currentFkResolved = {};

  // ── Boot ───────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', async () => {
    if (typeof bootstrap === 'function') {
      const ok = await bootstrap();
      if (!ok) return;
    }
    wireTabs();
    wireDrawer();
    try {
      const r = await fetch('/api/admin/db/tables', { credentials: 'include' });
      if (r.status === 401) { location.href = '/login'; return; }
      if (r.status === 403) { showAccessDenied(); return; }
      if (!r.ok) throw new Error('Could not load tables');
      const j = await r.json();
      TABLES = j.tables || [];
      renderSidebar();
      populateAuditTableFilter();
    } catch (e) {
      $('#db-main').innerHTML = `<div class="db-state err">${escapeHtml(e.message)}</div>`;
    }
    document.getElementById('audit-refresh').addEventListener('click', loadAudit);
    document.getElementById('audit-table-filter').addEventListener('change', loadAudit);
    document.getElementById('audit-admin-filter').addEventListener('input', debounce(loadAudit, 350));
    document.getElementById('db-table-search').addEventListener('input', renderSidebar);
  });

  function showAccessDenied() {
    document.body.innerHTML = `
      <div style="max-width:440px;margin:80px auto;padding:32px;background:#fff;border:1px solid #fecaca;border-radius:12px;text-align:center;font-family:inherit;">
        <h2 style="color:#991b1b;margin:0 0 8px;">Admin access required</h2>
        <p style="color:#44403c;font-size:.9rem;margin:0 0 20px;">This page is only available to admins.</p>
        <a href="/" style="display:inline-block;background:#3d0f7a;color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px;font-weight:600;">Back to home</a>
      </div>`;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function $(s) { return document.querySelector(s); }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function debounce(fn, ms) {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }
  function toast(msg, err) {
    const el = $('#db-toast');
    el.textContent = msg;
    el.classList.toggle('err', !!err);
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2400);
  }
  function fmtDate(v) {
    if (!v) return '';
    try {
      const d = new Date(v);
      if (isNaN(d.getTime())) return String(v);
      return d.toLocaleString();
    } catch { return String(v); }
  }
  function typeHint(c) {
    const t = (c.data_type || '').toLowerCase();
    if (t === 'jsonb' || t === 'json') return 'json';
    if (t === 'boolean') return 'bool';
    if (t.includes('timestamp') || t === 'date') return 'date';
    if (['integer','bigint','smallint','numeric','real','double precision'].includes(t)) return 'number';
    return 'text';
  }
  function pkOf(row) {
    return currentTable.pk.map(c => row[c]).join('|');
  }

  // ── Tabs ───────────────────────────────────────────────────────────────────
  function wireTabs() {
    document.querySelectorAll('.db-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.dbTab;
        document.querySelectorAll('.db-tab-btn').forEach(b => b.classList.toggle('active', b === btn));
        document.querySelectorAll('.db-tab-panel').forEach(p => p.classList.toggle('active', p.id === 'db-tab-' + tab));
        if (tab === 'audit') loadAudit();
      });
    });
  }

  // ── Sidebar ────────────────────────────────────────────────────────────────
  function renderSidebar() {
    const q = ($('#db-table-search').value || '').trim().toLowerCase();
    const grouped = {};
    for (const t of TABLES) {
      if (q && !t.name.toLowerCase().includes(q) && !t.group.toLowerCase().includes(q)) continue;
      (grouped[t.group] = grouped[t.group] || []).push(t);
    }
    const groups = Object.keys(grouped).sort();
    if (!groups.length) {
      $('#db-table-list').innerHTML = '<div class="db-state">No tables match.</div>';
      return;
    }
    $('#db-table-list').innerHTML = groups.map(g => `
      <div class="db-group-title">${escapeHtml(g)}</div>
      <ul class="db-tlist">
        ${grouped[g].map(t => `
          <li><button data-table="${escapeHtml(t.name)}" class="${currentTable?.name === t.name ? 'active' : ''}">${escapeHtml(t.name)}</button></li>
        `).join('')}
      </ul>
    `).join('');
    $('#db-table-list').querySelectorAll('button[data-table]').forEach(b => {
      b.addEventListener('click', () => {
        selectTable(b.dataset.table);
      });
    });
  }

  function selectTable(name) {
    const t = TABLES.find(x => x.name === name);
    if (!t) return;
    currentTable = t;
    currentMeta = { page: 1, pageSize: 50, total: 0, sort: t.pk[0], dir: 'asc', search: '' };
    renderSidebar();
    loadRows();
  }

  // ── Row grid ───────────────────────────────────────────────────────────────
  async function loadRows() {
    if (!currentTable) return;
    $('#db-main').innerHTML = `<div class="db-state">Loading ${escapeHtml(currentTable.name)}…</div>`;
    const params = new URLSearchParams({
      search: currentMeta.search,
      sort: currentMeta.sort,
      dir: currentMeta.dir,
      page: String(currentMeta.page),
      pageSize: String(currentMeta.pageSize),
    });
    try {
      const r = await fetch(`/api/admin/db/${encodeURIComponent(currentTable.name)}/rows?${params}`, { credentials: 'include' });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || ('HTTP ' + r.status));
      }
      const j = await r.json();
      currentRows = j.rows || [];
      currentMeta.total = j.total || 0;
      // Refresh column metadata (may pick up alters).
      currentTable.columns = j.columns || currentTable.columns;
      currentFkResolved = j.fkResolved || {};
      renderGrid();
    } catch (e) {
      $('#db-main').innerHTML = `<div class="db-state err">${escapeHtml(e.message)}</div>`;
    }
  }

  function renderGrid() {
    const t = currentTable;
    const isReadOnlyTable = !!t.readOnlyTable;
    const headerCells = t.columns.map(c => {
      const arrow = currentMeta.sort === c.name ? (currentMeta.dir === 'asc' ? ' ↑' : ' ↓') : '';
      const pk = c.is_pk ? '<span class="col-pk">PK</span>' : '';
      return `<th data-sort="${escapeHtml(c.name)}">${escapeHtml(c.name)}<span class="col-type">${typeHint(c)}</span>${pk}${arrow}</th>`;
    }).join('');
    const bodyRows = currentRows.length ? currentRows.map(row => {
      const cells = t.columns.map(c => `<td>${renderCell(c, row[c.name])}</td>`).join('');
      const actions = isReadOnlyTable ? '' : `
        <td class="col-actions">
          <button class="db-btn db-btn-ghost" data-act="edit" data-pk="${escapeHtml(pkOf(row))}">Edit</button>
          <button class="db-btn db-btn-danger" data-act="del" data-pk="${escapeHtml(pkOf(row))}">Delete</button>
        </td>`;
      return `<tr data-pk="${escapeHtml(pkOf(row))}">${cells}${actions}</tr>`;
    }).join('') : `<tr><td colspan="${t.columns.length + (isReadOnlyTable ? 0 : 1)}" class="db-state">No rows.</td></tr>`;

    const pageCount = Math.max(1, Math.ceil(currentMeta.total / currentMeta.pageSize));
    $('#db-main').innerHTML = `
      <div class="db-main-header">
        <div>
          <h2 class="db-main-title">${escapeHtml(t.name)}${isReadOnlyTable ? ' <span class="col-type" style="font-size:.7rem;color:var(--ink-4);">(read-only)</span>' : ''}</h2>
          <div class="db-main-meta">${currentMeta.total} row${currentMeta.total === 1 ? '' : 's'} · PK: ${t.pk.join(', ')}</div>
        </div>
        <div class="db-toolbar">
          <input type="text" class="field" id="db-row-search" placeholder="Search text columns…" value="${escapeHtml(currentMeta.search)}" style="border:1px solid var(--stone);border-radius:var(--radius-sm);padding:6px 10px;font-family:inherit;">
          ${isReadOnlyTable ? '' : '<button class="db-btn db-btn-primary" id="db-add-row">+ Add row</button>'}
        </div>
      </div>
      <div class="db-table-wrap">
        <table class="db-grid">
          <thead><tr>${headerCells}${isReadOnlyTable ? '' : '<th></th>'}</tr></thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
      <div class="db-pager">
        <button class="db-btn db-btn-ghost" id="pg-prev" ${currentMeta.page <= 1 ? 'disabled' : ''}>Prev</button>
        <span>Page ${currentMeta.page} / ${pageCount}</span>
        <button class="db-btn db-btn-ghost" id="pg-next" ${currentMeta.page >= pageCount ? 'disabled' : ''}>Next</button>
      </div>
    `;

    $('#db-main').querySelectorAll('th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.sort;
        if (currentMeta.sort === col) currentMeta.dir = currentMeta.dir === 'asc' ? 'desc' : 'asc';
        else { currentMeta.sort = col; currentMeta.dir = 'asc'; }
        currentMeta.page = 1;
        loadRows();
      });
    });
    const search = $('#db-row-search');
    if (search) search.addEventListener('input', debounce(() => {
      currentMeta.search = search.value;
      currentMeta.page = 1;
      loadRows();
    }, 300));
    const add = $('#db-add-row');
    if (add) add.addEventListener('click', () => openInsertDrawer());
    $('#pg-prev')?.addEventListener('click', () => { if (currentMeta.page > 1) { currentMeta.page--; loadRows(); } });
    $('#pg-next')?.addEventListener('click', () => { currentMeta.page++; loadRows(); });
    $('#db-main').querySelectorAll('button[data-act]').forEach(b => {
      b.addEventListener('click', () => {
        const pk = b.dataset.pk;
        const row = currentRows.find(r => pkOf(r) === pk);
        if (!row) return;
        if (b.dataset.act === 'edit') openEditDrawer(row);
        else openDeleteDrawer(row);
      });
    });
  }

  function renderCell(col, v) {
    if (v === null || v === undefined) return '<span class="v-null">null</span>';
    const t = (col.data_type || '').toLowerCase();
    if (t === 'boolean') {
      return `<span class="v-bool ${v ? 'true' : 'false'}">${v ? 'true' : 'false'}</span>`;
    }
    if (t === 'jsonb' || t === 'json') {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return `<span class="v-json" title="${escapeHtml(s)}">${escapeHtml(s)}</span>`;
    }
    if (t.includes('timestamp') || t === 'date') {
      return `<span title="${escapeHtml(v)}">${escapeHtml(fmtDate(v))}</span>`;
    }
    const fkMap = currentFkResolved[col.name];
    if (fkMap && Object.prototype.hasOwnProperty.call(fkMap, v)) {
      return `<span class="v-text" title="${escapeHtml(v)}">${escapeHtml(fkMap[v])} <span style="color:var(--ink-4);font-size:.72rem;">(${escapeHtml(v)})</span></span>`;
    }
    const s = String(v);
    return `<span class="v-text" title="${escapeHtml(s)}">${escapeHtml(s)}</span>`;
  }

  // ── Drawer ─────────────────────────────────────────────────────────────────
  function wireDrawer() {
    $('#db-drawer-bg').addEventListener('click', e => {
      if (e.target.id === 'db-drawer-bg') closeDrawer();
    });
  }
  function openDrawer(html) {
    $('#db-drawer').innerHTML = html;
    $('#db-drawer-bg').classList.add('show');
  }
  function closeDrawer() {
    $('#db-drawer-bg').classList.remove('show');
    $('#db-drawer').innerHTML = '';
  }

  function renderFieldInput(col, value, idPrefix) {
    const id = idPrefix + col.name;
    const t = (col.data_type || '').toLowerCase();
    const optLabel = `${col.is_nullable ? '<span class="opt">optional</span>' : ''}${col.read_only ? '<span class="opt">read-only</span>' : ''}`;
    const labelHtml = `<label for="${id}">${escapeHtml(col.name)} <span class="col-type" style="font-weight:400;color:var(--ink-4);">${typeHint(col)}</span> ${optLabel}</label>`;
    if (col.read_only) {
      const display = value === null || value === undefined ? '' : (typeof value === 'object' ? JSON.stringify(value) : String(value));
      return `<div class="db-form-field">${labelHtml}<input class="field" id="${id}" value="${escapeHtml(display)}" disabled></div>`;
    }
    if (t === 'boolean') {
      const v = value === true ? 'true' : value === false ? 'false' : '';
      return `<div class="db-form-field">${labelHtml}
        <select class="field" id="${id}">
          ${col.is_nullable ? '<option value="">(null)</option>' : ''}
          <option value="true" ${v==='true'?'selected':''}>true</option>
          <option value="false" ${v==='false'?'selected':''}>false</option>
        </select>
        <div class="err" id="${id}-err"></div></div>`;
    }
    if (t === 'jsonb' || t === 'json') {
      const display = value === null || value === undefined
        ? ''
        : (typeof value === 'string' ? value : JSON.stringify(value, null, 2));
      return `<div class="db-form-field">${labelHtml}
        <textarea class="field" id="${id}" placeholder="JSON value">${escapeHtml(display)}</textarea>
        <div class="err" id="${id}-err"></div></div>`;
    }
    if (t.includes('timestamp') || t === 'date') {
      let v = '';
      if (value) {
        try {
          const d = new Date(value);
          if (!isNaN(d.getTime())) {
            const pad = n => String(n).padStart(2, '0');
            v = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
          }
        } catch {}
      }
      return `<div class="db-form-field">${labelHtml}
        <input type="datetime-local" class="field" id="${id}" value="${escapeHtml(v)}">
        <div class="err" id="${id}-err"></div></div>`;
    }
    if (['integer','bigint','smallint','numeric','real','double precision'].includes(t)) {
      return `<div class="db-form-field">${labelHtml}
        <input type="number" step="any" class="field" id="${id}" value="${value == null ? '' : escapeHtml(String(value))}">
        <div class="err" id="${id}-err"></div></div>`;
    }
    // Default: textarea for long text, input otherwise.
    const display = value == null ? '' : String(value);
    if (display.length > 80 || display.includes('\n')) {
      return `<div class="db-form-field">${labelHtml}
        <textarea class="field" id="${id}" style="font-family:inherit;font-size:.85rem;">${escapeHtml(display)}</textarea>
        <div class="err" id="${id}-err"></div></div>`;
    }
    return `<div class="db-form-field">${labelHtml}
      <input type="text" class="field" id="${id}" value="${escapeHtml(display)}">
      <div class="err" id="${id}-err"></div></div>`;
  }

  // On insert (mode='insert'), columns the user left blank are OMITTED from the
  // payload so the DB default / sequence fires. On edit, blank on a nullable
  // column means null; blank on a non-nullable column is still sent through
  // (server will reject), but client-side required validation catches that
  // first via validateRequired().
  function readFormValues(idPrefix, mode) {
    const t = currentTable;
    const out = {};
    for (const c of t.columns) {
      if (c.read_only) continue;
      const el = document.getElementById(idPrefix + c.name);
      if (!el) continue;
      const raw = el.value;
      const dt = (c.data_type || '').toLowerCase();
      if (raw === '' && mode === 'insert') {
        // Omit so DB default / sequence is honored.
        continue;
      }
      if (raw === '' && c.is_nullable) { out[c.name] = null; continue; }
      if (raw === '' && (dt === 'jsonb' || dt === 'json' || dt === 'boolean')) {
        out[c.name] = null; continue;
      }
      if (dt === 'boolean') {
        out[c.name] = raw === 'true' ? true : raw === 'false' ? false : null;
      } else if (dt === 'jsonb' || dt === 'json') {
        // Validate JSON before sending.
        try {
          if (raw.trim() === '') { out[c.name] = null; }
          else { out[c.name] = JSON.parse(raw); }
          const errEl = document.getElementById(idPrefix + c.name + '-err');
          if (errEl) errEl.classList.remove('show');
        } catch (e) {
          const errEl = document.getElementById(idPrefix + c.name + '-err');
          if (errEl) { errEl.textContent = 'Invalid JSON: ' + e.message; errEl.classList.add('show'); }
          throw new Error('Invalid JSON in field ' + c.name);
        }
      } else if (dt.includes('timestamp') || dt === 'date') {
        out[c.name] = raw ? new Date(raw).toISOString() : null;
      } else {
        out[c.name] = raw;
      }
    }
    return out;
  }

  // Clear any field-level error pills inside the drawer.
  function clearFieldErrors(idPrefix) {
    const t = currentTable; if (!t) return;
    for (const c of t.columns) {
      const errEl = document.getElementById(idPrefix + c.name + '-err');
      if (errEl) { errEl.textContent = ''; errEl.classList.remove('show'); }
    }
  }

  // Show an inline error under one field. Falls back to a top-of-drawer
  // banner when the column is unknown (or the field isn't in the drawer).
  function showFieldError(idPrefix, column, message) {
    let banner = document.getElementById(idPrefix + 'banner');
    if (column) {
      const errEl = document.getElementById(idPrefix + column + '-err');
      if (errEl) {
        errEl.textContent = message;
        errEl.classList.add('show');
        const input = document.getElementById(idPrefix + column);
        if (input && typeof input.focus === 'function') input.focus();
        return;
      }
    }
    if (!banner) {
      banner = document.createElement('div');
      banner.id = idPrefix + 'banner';
      banner.className = 'err show';
      banner.style.marginBottom = '12px';
      const drawer = document.getElementById('db-drawer');
      const h2 = drawer && drawer.querySelector('h2');
      if (h2 && h2.nextSibling) drawer.insertBefore(banner, h2.nextSibling);
      else if (drawer) drawer.prepend(banner);
    }
    banner.textContent = message;
  }

  // Client-side required-field check: any non-nullable, non-default, editable
  // column must be present in the payload. Returns the offending column name
  // or null.
  function validateRequired(idPrefix, body, mode) {
    const t = currentTable;
    for (const c of t.columns) {
      if (c.read_only) continue;
      if (c.is_nullable) continue;
      if (c.column_default !== null && c.column_default !== undefined) continue;
      if (mode === 'edit' && c.is_pk) continue;
      const present = Object.prototype.hasOwnProperty.call(body, c.name) &&
        body[c.name] !== null && body[c.name] !== '';
      if (!present) {
        showFieldError(idPrefix, c.name, `“${c.name}” is required.`);
        return c.name;
      }
    }
    return null;
  }

  // Apply a server-returned formatPgError payload to the drawer.
  function applyServerError(idPrefix, payload, fallbackMsg) {
    clearFieldErrors(idPrefix);
    const msg = (payload && (payload.message || payload.error)) || fallbackMsg;
    showFieldError(idPrefix, payload && payload.column, msg);
  }

  function openInsertDrawer() {
    const t = currentTable;
    const fields = t.columns.map(c => renderFieldInput(c, c.column_default, 'ins-')).join('');
    openDrawer(`
      <h2>Add row · ${escapeHtml(t.name)}</h2>
      <p class="db-drawer-sub">Fill in any required fields. Leave optional fields blank to use the default.</p>
      ${fields}
      <div class="db-drawer-actions">
        <button class="db-btn db-btn-primary" id="ins-save">Insert</button>
        <button class="db-btn db-btn-ghost" id="ins-cancel">Cancel</button>
      </div>
    `);
    $('#ins-cancel').addEventListener('click', closeDrawer);
    $('#ins-save').addEventListener('click', async () => {
      clearFieldErrors('ins-');
      let body;
      try { body = readFormValues('ins-', 'insert'); }
      catch (e) { return; /* readFormValues already rendered the inline JSON error */ }
      if (validateRequired('ins-', body, 'insert')) return;
      try {
        const r = await fetch(`/api/admin/db/${encodeURIComponent(t.name)}/rows`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(body),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { applyServerError('ins-', j, 'HTTP ' + r.status); return; }
        toast('Row inserted.');
        closeDrawer();
        loadRows();
      } catch (e) { showFieldError('ins-', null, e.message); }
    });
  }

  function openEditDrawer(row) {
    const t = currentTable;
    const fields = t.columns.map(c => renderFieldInput(c, row[c.name], 'edit-')).join('');
    openDrawer(`
      <h2>Edit row · ${escapeHtml(t.name)}</h2>
      <p class="db-drawer-sub">PK: ${escapeHtml(pkOf(row))}</p>
      ${fields}
      <div class="db-drawer-actions">
        <button class="db-btn db-btn-primary" id="edit-save">Review changes</button>
        <button class="db-btn db-btn-ghost" id="edit-cancel">Cancel</button>
      </div>
    `);
    $('#edit-cancel').addEventListener('click', closeDrawer);
    $('#edit-save').addEventListener('click', () => {
      clearFieldErrors('edit-');
      confirmEdit(row);
    });
  }

  function diffHtml(before, after) {
    const keys = Array.from(new Set([...Object.keys(before || {}), ...Object.keys(after || {})])).sort();
    const lines = [];
    for (const k of keys) {
      const b = before ? before[k] : undefined;
      const a = after ? after[k] : undefined;
      const bs = b === undefined ? '(unset)' : (b === null ? 'null' : (typeof b === 'object' ? JSON.stringify(b) : String(b)));
      const as = a === undefined ? '(unset)' : (a === null ? 'null' : (typeof a === 'object' ? JSON.stringify(a) : String(a)));
      if (bs === as) continue;
      if (before) lines.push(`<div class="diff-del">- ${escapeHtml(k)}: ${escapeHtml(bs)}</div>`);
      if (after)  lines.push(`<div class="diff-add">+ ${escapeHtml(k)}: ${escapeHtml(as)}</div>`);
    }
    return lines.length ? lines.join('') : '<div style="color:var(--ink-4);">No changes.</div>';
  }

  function confirmEdit(row) {
    const t = currentTable;
    let next;
    try { next = readFormValues('edit-', 'edit'); }
    catch (e) { return; /* inline JSON error already shown */ }
    if (validateRequired('edit-', { ...row, ...next }, 'edit')) return;
    // Only send columns that actually changed.
    const changes = {};
    for (const c of t.columns) {
      if (c.read_only || c.is_pk) continue;
      if (!Object.prototype.hasOwnProperty.call(next, c.name)) continue;
      let oldV = row[c.name];
      let newV = next[c.name];
      // Normalise JSON comparison.
      const dt = (c.data_type || '').toLowerCase();
      if (dt === 'jsonb' || dt === 'json') {
        try { if (typeof oldV === 'string') oldV = JSON.parse(oldV); } catch {}
        if (JSON.stringify(oldV) === JSON.stringify(newV)) continue;
      } else if (oldV instanceof Date) {
        if (oldV.toISOString() === newV) continue;
      } else if (String(oldV ?? '') === String(newV ?? '')) {
        continue;
      }
      changes[c.name] = newV;
    }
    if (!Object.keys(changes).length) {
      toast('No changes to save.', true);
      return;
    }
    const before = {}; const after = {};
    for (const k of Object.keys(changes)) {
      before[k] = row[k]; after[k] = changes[k];
    }
    openDrawer(`
      <h2>Confirm changes · ${escapeHtml(t.name)}</h2>
      <p class="db-drawer-sub">PK: ${escapeHtml(pkOf(row))}</p>
      <div class="db-diff">${diffHtml(before, after)}</div>
      <div class="db-drawer-actions">
        <button class="db-btn db-btn-primary" id="edit-go">Save</button>
        <button class="db-btn db-btn-ghost" id="edit-back">Back</button>
      </div>
    `);
    $('#edit-back').addEventListener('click', () => openEditDrawer(row));
    $('#edit-go').addEventListener('click', async () => {
      try {
        const r = await fetch(`/api/admin/db/${encodeURIComponent(t.name)}/rows/${encodeURIComponent(pkOf(row))}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(changes),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          // Re-open the edit form so the inline field error has a place to land,
          // then surface the server's structured message.
          openEditDrawer(row);
          applyServerError('edit-', j, 'HTTP ' + r.status);
          return;
        }
        toast('Row updated.');
        closeDrawer();
        loadRows();
      } catch (e) {
        openEditDrawer(row);
        showFieldError('edit-', null, e.message);
      }
    });
  }

  function openDeleteDrawer(row) {
    const t = currentTable;
    const pkVal = pkOf(row);
    openDrawer(`
      <h2>Delete row · ${escapeHtml(t.name)}</h2>
      <p class="db-drawer-sub">This will permanently remove the row from <strong>${escapeHtml(t.name)}</strong>.</p>
      <div class="db-form-field">
        <label>Type the primary key <strong>${escapeHtml(pkVal)}</strong> to confirm</label>
        <input type="text" class="field" id="del-confirm" autocomplete="off">
      </div>
      <div class="db-drawer-actions">
        <button class="db-btn db-btn-danger" id="del-go" disabled>Delete row</button>
        <button class="db-btn db-btn-ghost" id="del-cancel">Cancel</button>
      </div>
    `);
    const input = $('#del-confirm');
    const btn = $('#del-go');
    input.addEventListener('input', () => { btn.disabled = input.value !== pkVal; });
    $('#del-cancel').addEventListener('click', closeDrawer);
    btn.addEventListener('click', async () => {
      try {
        const r = await fetch(`/api/admin/db/${encodeURIComponent(t.name)}/rows/${encodeURIComponent(pkVal)}`, {
          method: 'DELETE',
          headers: { 'X-Confirm-Pk': pkVal },
          credentials: 'include',
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        toast('Row deleted.');
        closeDrawer();
        loadRows();
      } catch (e) { toast(e.message, true); }
    });
  }

  // ── Audit log ──────────────────────────────────────────────────────────────
  function populateAuditTableFilter() {
    const sel = $('#audit-table-filter');
    for (const t of TABLES) {
      const opt = document.createElement('option');
      opt.value = t.name;
      opt.textContent = t.name;
      sel.appendChild(opt);
    }
  }

  let auditPage = 1;
  async function loadAudit() {
    auditPage = 1;
    await fetchAudit();
  }

  async function fetchAudit() {
    const params = new URLSearchParams({
      page: String(auditPage),
      pageSize: '50',
    });
    const tableF = $('#audit-table-filter').value;
    const adminF = $('#audit-admin-filter').value.trim();
    if (tableF) params.set('table', tableF);
    if (adminF) params.set('admin', adminF);
    $('#audit-list').innerHTML = '<div class="db-state">Loading…</div>';
    try {
      const r = await fetch('/api/admin/db/audit?' + params, { credentials: 'include' });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || ('HTTP ' + r.status));
      }
      const j = await r.json();
      renderAudit(j);
    } catch (e) {
      $('#audit-list').innerHTML = `<div class="db-state err">${escapeHtml(e.message)}</div>`;
    }
  }

  function renderAudit(j) {
    if (!j.rows.length) {
      $('#audit-list').innerHTML = '<div class="db-state">No audit entries.</div>';
      $('#audit-pager').innerHTML = '';
      return;
    }
    $('#audit-list').innerHTML = j.rows.map((row, i) => {
      const diff = diffHtml(row.before_data, row.after_data);
      return `
        <div class="db-audit-row" data-i="${i}">
          <div>
            <div class="a-time">${escapeHtml(fmtDate(row.acted_at))}</div>
            <div style="font-size:.75rem;color:var(--ink-3);">${escapeHtml(row.admin_email)}</div>
          </div>
          <div><span class="a-op ${escapeHtml(row.op)}">${escapeHtml(row.op)}</span></div>
          <div>
            <div><strong>${escapeHtml(row.table_name)}</strong> <span style="color:var(--ink-4);font-size:.75rem;">pk=${escapeHtml(row.pk || '')}</span></div>
            <button class="a-expand" data-i="${i}">Show diff</button>
            <div class="a-diff" id="audit-diff-${i}">${diff}</div>
          </div>
        </div>`;
    }).join('');
    $('#audit-list').querySelectorAll('button.a-expand').forEach(b => {
      b.addEventListener('click', () => {
        const row = b.closest('.db-audit-row');
        row.classList.toggle('expanded');
        b.textContent = row.classList.contains('expanded') ? 'Hide diff' : 'Show diff';
      });
    });
    const pageCount = Math.max(1, Math.ceil(j.total / j.pageSize));
    $('#audit-pager').innerHTML = `
      <button class="db-btn db-btn-ghost" id="ap-prev" ${auditPage <= 1 ? 'disabled' : ''}>Prev</button>
      <span>Page ${auditPage} / ${pageCount}</span>
      <button class="db-btn db-btn-ghost" id="ap-next" ${auditPage >= pageCount ? 'disabled' : ''}>Next</button>
    `;
    $('#ap-prev')?.addEventListener('click', () => { if (auditPage > 1) { auditPage--; fetchAudit(); } });
    $('#ap-next')?.addEventListener('click', () => { auditPage++; fetchAudit(); });
  }
})();
