import React from 'react';

/**
 * <EmptyState/> — React equivalent of `UI.renderEmptyState` in
 * `public/components.js`.
 *
 * Renders the same `.ui-empty` markup (with optional `--compact` modifier) so
 * it reuses the existing CSS in `public/style.css`. When the legacy helper is
 * finally retired, this component is the drop-in replacement.
 */
export interface EmptyStateProps {
  message: React.ReactNode;
  compact?: boolean;
  className?: string;
}

export function EmptyState({ message, compact, className }: EmptyStateProps) {
  const cls = ['ui-empty', compact ? 'ui-empty--compact' : '', className]
    .filter(Boolean)
    .join(' ');
  return <div className={cls}>{message}</div>;
}

export default EmptyState;
