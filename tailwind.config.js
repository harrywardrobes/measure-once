/** @type {import('tailwindcss').Config} */
/*
 * Tailwind JIT config — single token bridge for the legacy vanilla pages in
 * `public/` AND the React component library under `src/react/`.
 *
 * Every colour / radius / shadow / z-index here resolves to a CSS custom
 * property already defined on `:root` in `public/style.css`, so the two
 * worlds stay in lock-step: rename a token in `style.css` and Tailwind
 * utilities pick it up automatically.
 */
module.exports = {
  content: [
    './public/**/*.html',
    './public/**/*.js',
    './src/**/*.{ts,tsx,js,jsx,mdx}',
    './.storybook/**/*.{ts,tsx,js,jsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        paper:        'var(--paper)',
        'paper-deep': 'var(--paper-deep)',
        stone:        'var(--stone)',
        'stone-light':'var(--stone-light)',
        'stone-deep': 'var(--stone-deep)',
        orchid:       'var(--orchid)',
        'orchid-deep':'var(--orchid-deep)',
        'orchid-soft':'var(--orchid-soft)',
        'orchid-tint':'var(--orchid-tint)',
        plum:         'var(--plum)',
        walnut:       'var(--walnut)',
        'ink-1':      'var(--ink-1)',
        'ink-2':      'var(--ink-2)',
        'ink-3':      'var(--ink-3)',
        'ink-4':      'var(--ink-4)',
        'surface-card':  'var(--surface-card)',
        'surface-muted': 'var(--surface-muted)',
        'surface-soft':  'var(--surface-soft)',
        'border-soft':   'var(--border-soft)',
        'border-strong': 'var(--border-strong)',
        'status-danger':         'var(--status-danger)',
        'status-danger-text':    'var(--status-danger-text)',
        'status-danger-bg':      'var(--status-danger-bg)',
        'status-danger-border':  'var(--status-danger-border)',
        'status-success':        'var(--status-success)',
        'status-success-text':   'var(--status-success-text)',
        'status-success-bg':     'var(--status-success-bg)',
        'status-success-border': 'var(--status-success-border)',
        'status-warn-bg':        'var(--status-warn-bg)',
        'status-warn-border':    'var(--status-warn-border)',
        'status-warn-text':      'var(--status-warn-text)',
      },
      borderRadius: {
        xs:   'var(--radius-xs)',
        sm:   'var(--radius-sm)',
        md:   'var(--radius-md)',
        lg:   'var(--radius-lg)',
        xl:   'var(--radius-xl)',
        '2xl':'var(--radius-2xl)',
        '3xl':'var(--radius-3xl)',
        pill: 'var(--radius-pill)',
      },
      boxShadow: {
        sm:        'var(--shadow-sm)',
        md:        'var(--shadow-md)',
        lg:        'var(--shadow-lg)',
        'card-xs': 'var(--shadow-card-xs)',
        'card-sm': 'var(--shadow-card-sm)',
        modal:     'var(--shadow-modal)',
      },
      zIndex: {
        base:     'var(--z-base)',
        raised:   'var(--z-raised)',
        sticky:   'var(--z-sticky)',
        nav:      'var(--z-nav)',
        header:   'var(--z-header)',
        dropdown: 'var(--z-dropdown)',
        panel:    'var(--z-panel)',
        overlay:  'var(--z-overlay)',
        modal:    'var(--z-modal)',
        toast:    'var(--z-toast)',
        tooltip:  'var(--z-tooltip)',
      },
    },
  },
  plugins: [],
};
