import React from 'react';
import { DESIGN_VISIT_STATUS_LABELS } from './types';

interface Props {
  status: string;
}

export function DesignVisitStatusPill({ status }: Props) {
  const st = DESIGN_VISIT_STATUS_LABELS[status] ?? {
    label: status || 'Unknown',
    bg: 'var(--stone-light)',
    fg: 'var(--ink-2)',
  };
  return (
    <span
      style={{
        fontSize: '0.7rem',
        background: st.bg,
        color: st.fg,
        borderRadius: 4,
        padding: '1px 6px',
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {st.label}
    </span>
  );
}
