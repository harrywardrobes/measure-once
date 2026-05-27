import React from 'react';

/**
 * <EmptyState/> — replaces the retired `UI.renderEmptyState` helper.
 *
 * Renders a `.ui-empty` div (with optional `--compact` modifier) that reuses
 * the existing CSS in `public/app-styles.css`.
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
