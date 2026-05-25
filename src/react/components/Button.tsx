import React from 'react';

/**
 * <Button/> — React wrapper around the existing `.btn` CSS in
 * `public/style.css`. Variants map directly onto the existing modifier
 * classes (`.btn-primary`, `.btn-ghost`, `.btn-approve`) so the rendered
 * markup is interchangeable with hand-rolled `<button class="btn …">`
 * elements during the React port.
 */
export type ButtonVariant = 'primary' | 'ghost' | 'approve';

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant;
  children: React.ReactNode;
}

const VARIANTS = new Set<ButtonVariant>(['primary', 'ghost', 'approve']);

export function Button({
  variant,
  className,
  type,
  children,
  ...rest
}: ButtonProps) {
  const v: ButtonVariant = variant && VARIANTS.has(variant) ? variant : 'primary';
  const cls = ['btn', `btn-${v}`, className].filter(Boolean).join(' ');
  return (
    <button {...rest} type={type ?? 'button'} className={cls}>
      {children}
    </button>
  );
}

export default Button;
