import React from 'react';
import { Skeleton } from './Skeleton';
import { EmptyState } from './EmptyState';
import { Button } from './Button';

/**
 * <WorkshopSettingsList/> — list of editable lead-time rows used by the
 * admin Workshop settings tab. Reuses the existing `.field` / `.btn` CSS
 * in `public/style.css` and the shared CSS custom-properties for colour /
 * spacing so no literal tokens live here.
 */
export interface WorkshopSetting {
  key: string;
  label: string;
  value: string | number;
  updated_at?: string | null;
  updated_by?: string | null;
}

export interface WorkshopSettingsListProps {
  rows: WorkshopSetting[];
  values: Record<string, string>;
  savingKey: string | null;
  onChange: (key: string, value: string) => void;
  onSave: (key: string) => void;
  loading?: boolean;
}

function formatUpdatedAt(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return ` on ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

export function WorkshopSettingsList({
  rows,
  values,
  savingKey,
  onChange,
  onSave,
  loading,
}: WorkshopSettingsListProps) {
  if (loading) {
    return (
      <div>
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="ws-row"
            style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--stone-soft)' }}
          >
            <div style={{ flex: 1 }}>
              <Skeleton width={160} height={14} />
              <div style={{ height: 6 }} />
              <Skeleton width={220} height={10} />
            </div>
            <Skeleton width={90} height={28} />
            <Skeleton width={60} height={28} />
          </div>
        ))}
      </div>
    );
  }

  if (!rows.length) {
    return <EmptyState message="No settings found." compact />;
  }

  return (
    <div>
      {rows.map(row => {
        const updatedBy = row.updated_by ? ` · last updated by ${row.updated_by}` : '';
        const updatedAt = formatUpdatedAt(row.updated_at);
        const value = values[row.key] ?? String(row.value ?? '');
        const isSaving = savingKey === row.key;
        return (
          <div
            key={row.key}
            className="ws-row"
            data-ws-key={row.key}
            style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--stone-soft)' }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: '.875rem', color: 'var(--ink-1)' }}>{row.label}</div>
              <div style={{ fontSize: '.72rem', color: 'var(--ink-4)', marginTop: 2 }}>
                key: <code>{row.key}</code>{updatedAt}{updatedBy}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <input
                type="number"
                min={0}
                step={1}
                className="field"
                value={value}
                onChange={e => onChange(row.key, e.target.value)}
                style={{ width: 90, textAlign: 'right' }}
                aria-label={`${row.label} (days)`}
                disabled={isSaving}
              />
              <span style={{ fontSize: '.82rem', color: 'var(--ink-3)', whiteSpace: 'nowrap' }}>days</span>
              <Button
                variant="primary"
                onClick={() => onSave(row.key)}
                disabled={isSaving}
                style={{ padding: '5px 14px', fontSize: '.82rem' }}
              >
                {isSaving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        );
      })}
      <div style={{ height: 4 }} />
    </div>
  );
}

export default WorkshopSettingsList;
