import React from 'react';

/**
 * <Pill/> — React equivalent of `UI.renderPill` in `public/components.js`.
 *
 * Renders the same `.ui-pill` markup with the same variant modifiers, so it
 * reuses the existing CSS in `public/style.css` (which already consumes the
 * design tokens). When the legacy helper is finally retired, this component
 * is the drop-in replacement.
 */
export type PillVariant = 'neutral' | 'success' | 'danger' | 'warn' | 'info';

export interface PillProps {
  label: React.ReactNode;
  variant?: PillVariant;
  className?: string;
}

const VARIANTS = new Set<PillVariant>(['neutral', 'success', 'danger', 'warn', 'info']);

export function Pill({ label, variant, className }: PillProps) {
  const v: PillVariant = variant && VARIANTS.has(variant) ? variant : 'neutral';
  const cls = ['ui-pill', `ui-pill--${v}`, className].filter(Boolean).join(' ');
  return <span className={cls}>{label}</span>;
}

export default Pill;
