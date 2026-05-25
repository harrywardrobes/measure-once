import React, { useEffect, useState } from 'react';
import { WorkshopSettingsList, type WorkshopSetting } from '../components/WorkshopSettingsList';

/**
 * <WorkshopSettingsPage/> — React port of the legacy `loadWorkshopSettings()`
 * / `renderWorkshopSettings()` block that used to live in `public/admin.html`.
 *
 * Renders the admin Workshop tab (#tab-workshop): a single "Lead Times" card
 * with one editable row per setting from `/api/admin/workshop-settings`.
 * Reuses the existing `.card`, `.field`, `.btn`, and `.admin-msg` classes in
 * `public/app-styles.css`, so all colour / radius / spacing values come from the
 * design token set — no literals live in this file.
 */

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

function showToast(msg: string, isError = false): void {
  const w = window as unknown as { showToast?: (m: string, e?: boolean) => void };
  if (typeof w.showToast === 'function') {
    w.showToast(msg, isError);
  } else if (isError) {
    console.error(msg);
  }
}

export function WorkshopSettingsPage() {
  const [loading, setLoading]     = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows]           = useState<WorkshopSetting[]>([]);
  const [values, setValues]       = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api<WorkshopSetting[]>('GET', '/api/admin/workshop-settings');
      const list = Array.isArray(data) ? data : [];
      setRows(list);
      setValues(Object.fromEntries(list.map(r => [r.key, String(r.value ?? '')])));
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  function handleChange(key: string, value: string) {
    setValues(prev => ({ ...prev, [key]: value }));
  }

  async function handleSave(key: string) {
    const value = (values[key] ?? '').trim();
    if (value === '' || isNaN(Number(value)) || Number(value) < 0) {
      showToast('Please enter a valid number of days.', true);
      return;
    }
    setSavingKey(key);
    try {
      await api('PATCH', '/api/admin/workshop-settings', { key, value });
      showToast('Lead time saved.');
      await load();
    } catch (e: unknown) {
      showToast('Save failed: ' + (e instanceof Error ? e.message : String(e)), true);
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <div className="card">
      <div className="card-title">Lead Times</div>
      <p className="card-desc" style={{ marginBottom: 16 }}>
        Manufacturing lead times used for scheduling. Edit a value and click Save to update it.
      </p>
      {loadError ? (
        <p className="admin-msg admin-msg--error">Could not load: {loadError}</p>
      ) : (
        <WorkshopSettingsList
          rows={rows}
          values={values}
          savingKey={savingKey}
          onChange={handleChange}
          onSave={handleSave}
          loading={loading}
        />
      )}
    </div>
  );
}

export default WorkshopSettingsPage;
