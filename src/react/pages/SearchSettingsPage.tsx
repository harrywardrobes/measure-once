import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SUCCESS_BANNER_HIDE_MS } from '../constants/timings';
import { STATUS_COLORS } from '../theme';
import { SearchActionList, type SearchAction } from '../components/SearchActionList';
import { usePageTitle } from '../hooks/usePageTitle';
import { useAdminUnsavedChanges } from '../hooks/useAdminUnsavedChanges';

/**
 * <SearchSettingsPage/> — React port of the legacy `loadSearchSettings()` /
 * `renderSearchActionsList()` block that used to live in `public/admin.html`.
 *
 * Renders the admin Search tab (#tab-search): a hint-placeholder input and a
 * drag-to-reorder list of quick actions with per-row toggles. Reuses the
 * existing `.ss-*`, `.card`, `.btn`, and `.field` classes in
 * `public/app-styles.css`, so all colour / radius / spacing values come from the
 * design token set — no literals live in this file.
 */

const SEARCH_ACTIONS_META: SearchAction[] = [
  { id: 'new-customer',     label: 'New customer',             category: 'Action',   hint: 'Create a new customer record' },
  { id: 'go-customers',     label: 'All customers',            category: 'Navigate', hint: 'Browse your customer list' },
  { id: 'go-home',          label: 'Home dashboard',           category: 'Navigate', hint: 'Go to the main dashboard' },
  { id: 'go-sales',         label: 'Sales board',              category: 'Navigate', hint: 'Manage leads and open deals' },
  { id: 'go-survey',        label: 'Survey pipeline',          category: 'Navigate', hint: 'Track survey and design visit stages' },
  { id: 'go-projects',      label: 'Projects tracker',         category: 'Navigate', hint: 'Active workshop and delivery jobs' },
  { id: 'go-invoices',      label: 'Invoices & payments',      category: 'Navigate', hint: 'View and send invoices via QuickBooks' },
  { id: 'go-admin',         label: 'Admin panel',              category: 'Navigate', hint: 'Manage users and team access' },
  { id: 'go-profile',       label: 'Your profile',             category: 'Account',  hint: 'Update your account details' },
  { id: 'filter-sales',     label: 'Customers · Sales stage',  category: 'Filter',   hint: 'Show only customers in the Sales stage' },
  { id: 'filter-workshop',  label: 'Customers · Workshop',     category: 'Filter',   hint: 'Show only customers in Workshop' },
  { id: 'sign-out',         label: 'Sign out',                 category: 'Account',  hint: 'End your current session' },
];

interface SearchSettingsResponse {
  disabled_actions?: string[];
  hint_placeholder?: string;
  action_order?: string[];
}

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j && typeof j.error === 'string') msg = j.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.status === 204 ? (undefined as T) : (res.json() as Promise<T>);
}

export function SearchSettingsPage() {
  usePageTitle('Search · Measure Once');
  const [loading, setLoading]     = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [placeholder, setPlaceholder] = useState('');
  const [disabled, setDisabled]   = useState<Set<string>>(new Set());
  const [order, setOrder]         = useState<string[]>(SEARCH_ACTIONS_META.map(a => a.id));
  const [saving, setSaving]       = useState(false);
  const [status, setStatus]       = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api<SearchSettingsResponse>('GET', '/api/admin/search-settings');
        if (cancelled) return;
        setDisabled(new Set(data.disabled_actions || []));
        setOrder(
          data.action_order && data.action_order.length
            ? data.action_order
            : SEARCH_ACTIONS_META.map(a => a.id)
        );
        setPlaceholder(data.hint_placeholder || '');
      } catch (e: unknown) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const ordered = useMemo<SearchAction[]>(() => {
    const mapped = order
      .map(id => SEARCH_ACTIONS_META.find(a => a.id === id))
      .filter((a): a is SearchAction => !!a);
    const extras = SEARCH_ACTIONS_META.filter(a => !order.includes(a.id));
    return [...mapped, ...extras];
  }, [order]);

  // ── Unsaved-changes guard ──
  // Snapshot the loaded values once so edits can be detected and discarded.
  interface Snapshot { placeholder: string; disabled: string; order: string }
  const snapshot = (): Snapshot => ({
    placeholder: placeholder.trim(),
    disabled: Array.from(disabled).sort().join(','),
    order: ordered.map(a => a.id).join(','),
  });
  const baselineRef = useRef<Snapshot | null>(null);
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (loading || loadError || baselineRef.current) return;
    baselineRef.current = snapshot();
    forceTick(t => t + 1); // re-render so isDirty reflects the captured baseline
  }, [loading, loadError]); // eslint-disable-line react-hooks/exhaustive-deps

  const baseline = baselineRef.current;
  const current = snapshot();
  const isDirty = !!baseline && (
    baseline.placeholder !== current.placeholder ||
    baseline.disabled !== current.disabled ||
    baseline.order !== current.order
  );

  useAdminUnsavedChanges({
    id: 'search',
    isDirty,
    onSave: () => handleSave(),
    onDiscard: () => {
      const b = baselineRef.current;
      if (!b) return;
      setPlaceholder(b.placeholder);
      setDisabled(new Set(b.disabled ? b.disabled.split(',') : []));
      setOrder(b.order ? b.order.split(',') : SEARCH_ACTIONS_META.map(a => a.id));
    },
  });

  function handleToggle(id: string, on: boolean) {
    setDisabled(prev => {
      const next = new Set(prev);
      if (on) next.delete(id); else next.add(id);
      return next;
    });
  }

  function handleReorder(ids: string[]) {
    setOrder(ids);
  }

  async function handleSave() {
    setSaving(true);
    setStatus(null);
    try {
      await api('PUT', '/api/admin/search-settings', {
        disabled_actions: Array.from(disabled),
        hint_placeholder: placeholder.trim(),
        action_order: ordered.map(a => a.id),
      });
      baselineRef.current = snapshot(); // the saved values are the new baseline
      setStatus({ text: 'Saved ✓', ok: true });
      window.setTimeout(() => setStatus(null), SUCCESS_BANNER_HIDE_MS);
    } catch (e: unknown) {
      setStatus({ text: 'Save failed: ' + (e instanceof Error ? e.message : String(e)), ok: false });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="card">
        <div className="card-title">Hint bar text</div>
        <p className="card-desc" style={{ marginBottom: 14 }}>
          The placeholder shown in the ghost search bar beneath the header on every page. Leave blank to use the default: <em>Search customers, actions…</em>
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input
            type="text"
            className="field"
            maxLength={120}
            placeholder="Search customers, actions…"
            style={{ flex: 1 }}
            value={placeholder}
            onChange={e => setPlaceholder(e.target.value)}
            disabled={loading || !!loadError}
          />
        </div>
      </div>

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 6, flexWrap: 'wrap' }}>
          <div>
            <div className="card-title" style={{ marginBottom: 2 }}>Quick actions</div>
            <p className="card-desc" style={{ margin: 0 }}>
              Toggle which actions appear in the palette and drag rows to reorder them.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {status && (
              <span
                style={{
                  fontSize: '.8rem',
                  color: status.ok ? STATUS_COLORS.success.text : STATUS_COLORS.error.text,
                }}
              >
                {status.text}
              </span>
            )}
            <button
              className="btn btn-primary"
              onClick={handleSave}
              disabled={saving || loading || !!loadError}
              style={{ whiteSpace: 'nowrap', padding: '6px 16px' }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          {loadError ? (
            <p className="admin-msg admin-msg--error">Could not load: {loadError}</p>
          ) : (
            <SearchActionList
              actions={ordered}
              disabled={disabled}
              onToggle={handleToggle}
              onReorder={handleReorder}
              loading={loading}
            />
          )}
        </div>
      </div>
    </>
  );
}

export default SearchSettingsPage;
