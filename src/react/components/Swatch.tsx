import React from 'react';
import { Skeleton } from './Skeleton';

/**
 * <Swatch/> — colour token preview tile used by the Design System page.
 *
 * Reads the computed value of a CSS custom property from `:root` and shows
 * it alongside a coloured chip. The component is content-driven via the
 * `value` prop so it can render in three states:
 *
 *   - default: a resolved token value (e.g. `#F6F1E7`)
 *   - loading: a pulsing placeholder (when `loading` is true)
 *   - empty:   a muted "—" when the token resolves to an empty string
 *
 * Sizing, radii, borders, and the chip background all come from existing
 * `.ds-swatch*` tokens in `public/app-styles.css`, so this component carries no
 * literal colours of its own.
 */
export interface SwatchProps {
  name: string;
  value?: string;
  loading?: boolean;
  chipStyle?: React.CSSProperties;
  chipLabel?: React.ReactNode;
  extra?: React.ReactNode;
}

export function Swatch({ name, value, loading, chipStyle, chipLabel, extra }: SwatchProps) {
  const resolved = (value || '').trim();
  const isEmpty = !loading && resolved === '';
  return (
    <div className="ds-swatch">
      <div
        className="ds-swatch-chip"
        style={chipStyle || { background: `var(${name})` }}
      >
        {chipLabel}
      </div>
      <div className="ds-swatch-meta">
        <div className="ds-swatch-name">{name}</div>
        <div className="ds-swatch-value">
          {loading ? <Skeleton width="60%" height={8} /> : isEmpty ? '—' : resolved}
        </div>
        {extra}
      </div>
    </div>
  );
}

export default Swatch;
