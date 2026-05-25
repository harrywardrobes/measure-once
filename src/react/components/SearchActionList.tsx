import React, { useState } from 'react';
import { Toggle } from './Toggle';
import { Skeleton } from './Skeleton';
import { EmptyState } from './EmptyState';

/**
 * <SearchActionList/> — drag-to-reorder + per-row toggle list used by the
 * admin Search settings tab. Reuses the existing `.ss-action-row` /
 * `.ss-toggle` CSS in `public/app-styles.css`, so all colours and radii come
 * from the token set.
 */
export interface SearchAction {
  id: string;
  label: string;
  category: string;
  hint: string;
}

export interface SearchActionListProps {
  actions: SearchAction[];
  disabled: Set<string>;
  onToggle: (id: string, enabled: boolean) => void;
  onReorder: (orderedIds: string[]) => void;
  loading?: boolean;
}

export function SearchActionList({
  actions,
  disabled,
  onToggle,
  onReorder,
  loading,
}: SearchActionListProps) {
  const [dragSrc, setDragSrc] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  if (loading) {
    return (
      <div>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="ss-action-row" style={{ background: 'transparent' }}>
            <Skeleton width={16} height={14} />
            <Skeleton width={32} height={18} />
            <Skeleton height={14} />
            <Skeleton width={70} height={14} />
            <Skeleton width={140} height={14} />
          </div>
        ))}
      </div>
    );
  }

  if (!actions.length) {
    return <EmptyState message="No quick actions to configure." compact />;
  }

  function handleDragStart(e: React.DragEvent<HTMLDivElement>, id: string) {
    setDragSrc(id);
    e.dataTransfer.effectAllowed = 'move';
  }
  function handleDragOver(e: React.DragEvent<HTMLDivElement>, id: string) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragSrc && id !== dragSrc) setOverId(id);
  }
  function handleDragLeave(id: string) {
    if (overId === id) setOverId(null);
  }
  function handleDrop(e: React.DragEvent<HTMLDivElement>, id: string) {
    e.preventDefault();
    setOverId(null);
    if (!dragSrc || dragSrc === id) return;
    const ids = actions.map(a => a.id);
    const fi = ids.indexOf(dragSrc);
    const ti = ids.indexOf(id);
    if (fi === -1 || ti === -1) return;
    ids.splice(fi, 1);
    ids.splice(ti, 0, dragSrc);
    onReorder(ids);
  }
  function handleDragEnd() {
    setDragSrc(null);
    setOverId(null);
  }

  return (
    <div>
      {actions.map(a => {
        const on = !disabled.has(a.id);
        const cls = [
          'ss-action-row',
          on ? '' : 'ss-action-disabled',
          dragSrc === a.id ? 'ss-dragging' : '',
          overId === a.id ? 'ss-drag-over' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <div
            key={a.id}
            className={cls}
            draggable
            data-id={a.id}
            onDragStart={e => handleDragStart(e, a.id)}
            onDragOver={e => handleDragOver(e, a.id)}
            onDragLeave={() => handleDragLeave(a.id)}
            onDrop={e => handleDrop(e, a.id)}
            onDragEnd={handleDragEnd}
          >
            <span className="ss-drag-handle" title="Drag to reorder">⠿</span>
            <Toggle
              checked={on}
              onChange={next => onToggle(a.id, next)}
              title={on ? 'Disable' : 'Enable'}
            />
            <span className="ss-action-label">{a.label}</span>
            <span className="ss-action-category">{a.category}</span>
            <span className="ss-action-hint">{a.hint}</span>
          </div>
        );
      })}
    </div>
  );
}

export default SearchActionList;
