# React island

This directory is the React-and-MUI surface that co-exists with the
legacy vanilla pages in `public/`. Vite builds it into
`public/react/main.js` (stable filename, no manifest) and the Express
server serves it as static assets.

## How everything fits together

- `main.tsx` — the single entry point. It finds known mount points
  (`#tab-designsystem`, `#tab-search`, `#tab-workshop`, …) and renders
  each that exists, wrapping every mount in `AppThemeProvider` so the
  shared MUI theme + `ScopedCssBaseline` apply automatically.
- `theme.ts` — the MUI theme. Close to MUI defaults today; intentionally
  minimal so we can refine it later without rewriting every page.
- `AppThemeProvider.tsx` — combines `ThemeProvider` and
  `ScopedCssBaseline`. The baseline is scoped (not global) because the
  legacy vanilla pages around the React island depend on their own
  `public/style.css` baseline.
- `pages/` — one file per mounted page (e.g. `DesignSystemPage.tsx`).
- `components/mui/` — thin wrappers around MUI primitives that we re-use
  across pages. Add a wrapper only when we genuinely need shared
  defaults — don't pre-build the world.
- `components/` (root) — legacy non-MUI React components used by the
  Search and Workshop tabs. They keep working through the new theme
  provider; new components should be MUI-first.

## Adding a new MUI-based component

1. If it's a one-off used by a single page, just import the MUI primitive
   directly inside that page (`import Button from '@mui/material/Button'`).
   Don't introduce a wrapper for a single caller.
2. If two or more pages need the same defaults, add a wrapper under
   `components/mui/<Name>.tsx`. Keep it thin — extend the MUI props type
   and forward unknown props through.
3. Add a Storybook story next to it (`<Name>.stories.tsx`) when the
   component has interesting variants.

## Adding a new page mount

1. Create `pages/<Name>Page.tsx`. Wrap the page's top-level layout in
   MUI primitives (`Container`, `Box`, `Stack`) and use `sx` for styling.
   Do **not** wrap in `AppThemeProvider` yourself — `main.tsx` does that
   for every mount.
2. Add a mount entry in `main.tsx`:

   ```ts
   const MOUNTS = [
     // …
     { id: 'tab-yourtab', render: () => <YourPage /> },
   ];
   ```

3. In the vanilla host page (typically `public/admin.html`), render the
   mount element (`<div id="tab-yourtab"></div>`) into `#page` and call
   `window.__reactIslandMount()` in the same tick so the React panel
   renders immediately.
4. Run `npm run build:react`. The Express server picks up the new bundle
   automatically.

## Referencing the theme inside a component

Use the `sx` prop for one-off styles — token names (`primary.main`,
`text.secondary`, `divider`, etc.) resolve against the theme:

```tsx
<Box sx={{ p: 2, bgcolor: 'background.paper', color: 'text.primary' }}>
  …
</Box>
```

For repeated styles, reach for `styled()` from `@mui/material/styles`.
Avoid hand-rolled `#hex` values inside React components — let the theme
provide them so a later theme refresh propagates automatically.

## Icons

All icons in React come from `@mui/icons-material` — one named export
per icon. See [`ICONS.md`](./ICONS.md) for the full convention (no new
inline `<svg>` in React, no other icon libraries, etc.) and the
Design System page's **Icons** tab for a browsable sample.

## Dev workflow

- `npm run dev:react` — Vite on :5173 with `/api` proxied to Express.
- `npm run build:react` — production bundle into `public/react/`.
- `npm run storybook` — Storybook on :6006, with the same
  `AppThemeProvider` wrapping every story.
