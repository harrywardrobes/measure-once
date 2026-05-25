import React from 'react';

/**
 * <Toggle/> — React component for the small switch used throughout the admin
 * panel (the `.ss-toggle` markup). Reuses the existing CSS in
 * `public/style.css` so the visuals stay in sync with the design tokens.
 */
export interface ToggleProps {
  checked: boolean;
  onChange?: (next: boolean) => void;
  title?: string;
  disabled?: boolean;
  className?: string;
}

export function Toggle({ checked, onChange, title, disabled, className }: ToggleProps) {
  const cls = ['ss-toggle', className].filter(Boolean).join(' ');
  return (
    <label className={cls} title={title}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={e => onChange?.(e.target.checked)}
      />
      <span className="ss-toggle-track" />
    </label>
  );
}

export default Toggle;
