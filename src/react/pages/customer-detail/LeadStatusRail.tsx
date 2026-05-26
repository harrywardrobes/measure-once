import React from 'react';
import { LeadStatus, LeadSubstatus, Contact, STAGE_COLOURS } from './types';
import { usePrivilege } from '../../hooks/usePrivilege';

interface Props {
  contact: Contact | null;
  leadStatuses: LeadStatus[];
  leadSubstatuses: LeadSubstatus[];
  loaded: boolean;
  focusedLeadStatus: string | null;
  onFocusChange: (value: string) => void;
  onSubstatusChange: (statusValue: string, substatusKey: string, checked: boolean) => void;
}

export function LeadStatusRail({
  contact,
  leadStatuses,
  leadSubstatuses,
  loaded,
  focusedLeadStatus,
  onFocusChange,
  onSubstatusChange,
}: Props) {
  const { isManager } = usePrivilege();
  const canEdit = isManager;

  const rail = loaded
    ? leadStatuses.filter(o => !o.excluded_from_sales)
    : [];

  if (!loaded) {
    return (
      <div id="workflow-stages" className="space-y-2">
        {[0, 1, 2].map(i => (
          <div key={i} className="skeleton-stage-row">
            <div className="flex items-center gap-3 flex-1">
              <div className="skeleton-line skeleton-stage-dot" />
              <div className={`skeleton-line skeleton-stage-label${i === 1 ? ' skeleton-stage-label-md' : i === 2 ? ' skeleton-stage-label-sm' : ''}`} />
            </div>
            <div className="skeleton-line skeleton-stage-count" />
          </div>
        ))}
      </div>
    );
  }

  if (rail.length === 0) {
    return (
      <div id="workflow-stages" className="space-y-2">
        <div className="ls-empty-tasks" style={{ padding: '1rem', textAlign: 'center', color: 'var(--ink-3)' }}>
          No lead statuses configured. An admin can add them in Settings → Lead statuses.
        </div>
      </div>
    );
  }

  const props      = contact?.properties || {};
  const currentLs  = String(props.hs_lead_status || '').toUpperCase();
  const currentSub = String(props.hw_lead_substatus || '');
  const currentIdx = rail.findIndex(e => String(e.value).toUpperCase() === currentLs);

  let resolvedFocused = focusedLeadStatus;
  if (!resolvedFocused || !rail.find(e => e.value === resolvedFocused)) {
    resolvedFocused = currentIdx !== -1 ? rail[currentIdx].value : rail[0].value;
  }
  const focusedIdx   = rail.findIndex(e => e.value === resolvedFocused);
  const focusedEntry = rail[focusedIdx];
  const focusedColour = STAGE_COLOURS[focusedIdx % STAGE_COLOURS.length] || STAGE_COLOURS[0];

  const isFocusedCurrent = focusedIdx === currentIdx;
  const isFocusedPast    = currentIdx !== -1 && focusedIdx < currentIdx;
  const isFocusedFuture  = currentIdx === -1 || focusedIdx > currentIdx;

  const focusedSubs = leadSubstatuses
    .filter(s => String(s.status_key).toUpperCase() === String(resolvedFocused).toUpperCase())
    .slice()
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

  const focusPrefix  = `${String(resolvedFocused).toUpperCase()}__`;
  const tickedSubKey = isFocusedCurrent && currentSub.toUpperCase().startsWith(focusPrefix)
    ? currentSub.slice(focusPrefix.length).toUpperCase()
    : '';

  const hasPrev = focusedIdx > 0;
  const hasNext = focusedIdx < rail.length - 1;

  return (
    <div id="workflow-stages" className="space-y-2">
      <div className="ls-tracker">
        <div className="ls-rail" role="list">
          {rail.map((entry, i) => {
            const colour   = STAGE_COLOURS[i % STAGE_COLOURS.length] || STAGE_COLOURS[0];
            const isCurrent = i === currentIdx;
            const isPast    = currentIdx !== -1 && i < currentIdx;
            const isFocused = entry.value === resolvedFocused;

            let badge: React.ReactNode;
            if (isPast) {
              badge = (
                <div className="ls-rail-badge ls-rail-badge-done" style={{ background: colour.bg, borderColor: colour.bg }}>
                  <svg width="11" height="9" fill="none" stroke="#fff" viewBox="0 0 12 10" aria-hidden="true">
                    <polyline points="1,5 4.5,8.5 11,1" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
              );
            } else if (isCurrent) {
              badge = (
                <div className="ls-rail-badge ls-rail-badge-current" style={{ background: colour.bg, borderColor: colour.bg, color: '#fff' }}>
                  {i + 1}
                </div>
              );
            } else {
              badge = <div className="ls-rail-badge ls-rail-badge-future">{i + 1}</div>;
            }

            const labelStyle: React.CSSProperties = isCurrent
              ? { color: colour.text, fontWeight: 700 }
              : isPast
                ? { color: 'var(--ink-2)', fontWeight: 600 }
                : { color: 'var(--ink-3)', fontWeight: 500 };

            const classes = [
              'ls-rail-item',
              isFocused ? 'ls-rail-item-focused' : '',
              isPast ? 'ls-rail-item-past' : '',
              isCurrent ? 'ls-rail-item-current' : '',
            ].filter(Boolean).join(' ');

            return (
              <div
                key={entry.value}
                className={classes}
                role="listitem"
                data-ls-key={entry.value}
                data-action="setFocusedLeadStatus"
                data-value={entry.value}
                title={entry.label}
                style={isFocused ? ({ '--ls-focus-bg': colour.bg, '--ls-focus-tint': colour.light } as React.CSSProperties) : undefined}
                onClick={() => onFocusChange(entry.value)}
              >
                {badge}
                <span className="ls-rail-label" style={labelStyle}>{entry.label}</span>
              </div>
            );
          })}
        </div>

        {focusedEntry && (
          <div className="ls-panel" style={{ borderTop: `3px solid ${focusedColour.bg}` }}>
            <div className="stage-panel-header">
              <div className="stage-panel-header-row">
                <div className="stage-panel-title-block">
                  <div
                    className="stage-panel-name"
                    style={{ color: isFocusedFuture ? 'var(--ink-3)' : focusedColour.text }}
                  >
                    {focusedEntry.label}
                  </div>
                  <div className="stage-panel-meta">
                    {isFocusedCurrent && <span className="stage-sublabel">Current stage</span>}
                    {isFocusedPast    && <span className="stage-sublabel">Completed</span>}
                    {isFocusedFuture  && <span className="stage-sublabel">Upcoming</span>}
                  </div>
                </div>
                <div className="stage-panel-nav">
                  <button
                    className="stage-nav-btn"
                    disabled={!hasPrev}
                    data-action="focusPrevLeadStatus"
                    title="Previous stage"
                    onClick={() => {
                      if (hasPrev) onFocusChange(rail[focusedIdx - 1].value);
                    }}
                  >
                    <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                  <button
                    className="stage-nav-btn"
                    disabled={!hasNext}
                    data-action="focusNextLeadStatus"
                    title="Next stage"
                    onClick={() => {
                      if (hasNext) onFocusChange(rail[focusedIdx + 1].value);
                    }}
                  >
                    <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>

            <div className="stage-statuses">
              {focusedSubs.length === 0 ? (
                <div className="ls-empty-tasks">No sub-statuses configured for this stage.</div>
              ) : (
                focusedSubs.map(s => {
                  const subKey = String(s.substatus_key).toUpperCase();
                  const done   = subKey === tickedSubKey;
                  const checkBg: React.CSSProperties = done
                    ? { background: focusedColour.bg, borderColor: focusedColour.bg }
                    : {};

                  return (
                    <div
                      key={s.substatus_key}
                      className={`status-task-row${done ? ' status-task-done completed' : ''}`}
                      data-substatus-key={subKey}
                      data-action={canEdit ? 'setLeadSubstatusChecked' : undefined}
                      data-status-value={resolvedFocused ?? ''}
                      data-checked={canEdit ? String(!done) : undefined}
                      style={{ cursor: canEdit ? 'pointer' : 'default', pointerEvents: canEdit ? 'auto' : 'none' }}
                      onClick={canEdit ? () => onSubstatusChange(resolvedFocused!, subKey, !done) : undefined}
                    >
                      <div
                        className={`status-task-check${done ? ' status-task-check-done' : ''}`}
                        style={checkBg}
                      >
                        {done && (
                          <svg width="10" height="8" fill="none" stroke="#fff" viewBox="0 0 12 10" aria-hidden="true">
                            <polyline points="1,5 4.5,8.5 11,1" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </div>
                      <div className="status-text">
                        <span className={`status-label${done ? ' status-label-done' : ''}`}>{s.label}</span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
