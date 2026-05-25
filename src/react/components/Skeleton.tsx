import React from 'react';

/**
 * <Skeleton/> — React equivalent of `UI.skeletonLine` in `public/components.js`.
 *
 * Renders the same `.skeleton-line` markup so it reuses the existing CSS in
 * `public/app-styles.css`. When the legacy helper is finally retired, this
 * component is the drop-in replacement.
 */
export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: React.CSSProperties;
}

function size(v: number | string | undefined, fallback: string): string {
  if (v == null || v === '') return fallback;
  return typeof v === 'number' ? `${v}px` : String(v);
}

export function Skeleton({ width, height, className, style }: SkeletonProps) {
  const cls = ['skeleton-line', className].filter(Boolean).join(' ');
  return (
    <div
      className={cls}
      style={{ width: size(width, '100%'), height: size(height, '10px'), ...style }}
    />
  );
}

export default Skeleton;
