# React island

This directory is the React-and-MUI surface that co-exists with the
legacy vanilla pages in `public/`. Vite builds it into
`public/react/main.js` (stable filename, no manifest) and the Express
server serves it as static assets.

## How everything fits together

- `main.tsx` — the single entry point. It finds known mount points
  (`#tab-search`, …) and renders each that exists,
  wrapping every mount in `AppThemeProvider` so the shared MUI theme +
  `ScopedCssBaseline` apply automatically.
- `theme.ts` — the MUI theme. Close to MUI defaults today; intentionally
  minimal so we can refine it later without rewriting every page.
- `AppThemeProvider.tsx` — combines `ThemeProvider` and
  `ScopedCssBaseline`. The baseline is scoped (not global) because the
  legacy vanilla pages around the React island depend on their own
  `public/app-styles.css` baseline.
- `pages/` — one file per mounted page.
- `stories/` — Storybook stories for components, design tokens, and pages.
  Run `npm run build:storybook` (or `npm run storybook`) and open
  `/storybook/` to browse the design system gallery.
- `components/mui/` — thin wrappers around MUI primitives that we re-use
  across pages. Add a wrapper only when we genuinely need shared
  defaults — don't pre-build the world.
- `components/` (root) — legacy non-MUI React components used by the
  Search tab. They keep working through the new theme provider; new
  components should be MUI-first.

## Adding a new MUI-based component

1. If it's a one-off used by a single page, just import the MUI primitive
   directly inside that page (`import Button from '@mui/material/Button'`).
   Don't introduce a wrapper for a single caller.
2. If two or more pages need the same defaults, add a wrapper under
   `components/mui/<Name>.tsx`. Keep it thin — extend the MUI props type
   and forward unknown props through.
3. Add a Storybook story (`<Name>.stories.tsx` or in `src/react/stories/`)
   when the component has interesting variants or is part of the design
   system reference. Run `npm run storybook` to view live, or link to
   `/storybook/` via the **Design System** card in the admin Settings tab.

   **Convention:** new significant components must have a Storybook story.
   This is the canonical design system gallery, replacing the former
   admin Design System tab.

## Shared shell mounts

Two island components render into placeholders that `public/chrome.js`
inserts on every page:

- `#app-header-mount` → `components/GlobalHeader.tsx` (the fixed AppBar).
- `#page-heading-mount` → `components/PageHeadingPanel.tsx` (the per-page
  title strip immediately below the AppBar).

`PageHeadingPanel` resolves the title from `window.PAGE_TITLES`, applies
the same suppression rules as before (`/admin*`, `/customers/:id`,
missing title → renders nothing), and exposes a stable
**`#page-heading-action`** slot on the right. Pages that need a header
button (e.g. Customers' "+ New customer") portal a node into that slot
using `createPortal(...)`; if no node is portalled in, the slot
collapses (`&:empty { display: none }`). When changing this contract,
audit consumers — currently only `pages/CustomersPage.tsx` portals into
`#page-heading-action`.

## Storybook embedding convention

Full-page components shown in Storybook stories use a single canonical
prop name — **`embedded`** — to signal that they are running inside a
story rather than at their real URL.

The authoritative type definitions and detailed instructions live in
**`src/react/types/gallery.ts`** — read that file before adding a new
embeddable component.

Two patterns exist:

- **Simple boolean** — `NotFoundPage`, `AccessRestrictedPage`:
  `embedded?: boolean`. The bare `true` suppresses full-viewport layout.
- **Rich preview object** — `DesignVisitSignOffPage` (`EmbeddedPreview`),
  `AccessRequestGate` (`AccessRequestGateEmbeddedPreview`): the interface
  extends `GalleryEmbedded` (from `src/react/types/gallery.ts`) so the
  gallery can control which UI state is displayed without a real token or
  API call.

**Always use `embedded` (not `preview`, `inGallery`, etc.) for this
purpose.** Rich preview types must extend `GalleryEmbedded` and be
exported from the component file so pages can import them
without a circular dependency. Stories in `src/react/stories/Pages.stories.tsx`
pass it consistently for all page components.

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

## No hardcoded hex colours in components

A CI check (`npm run test:component-hex-colors`) scans every non-story,
non-test `.ts`/`.tsx` file under `src/react/` and fails if it finds a
raw hex colour literal (e.g. `#f59e0b`) on the same line as a
style-related property name (`color`, `bgcolor`, `background`,
`backgroundColor`, `borderColor`, `fill`, `stroke`, …).

**Do this instead:**

| Need | Use |
|------|-----|
| Brand palette colour | `PALETTE` / `STAGE_COLORS` / `STATUS_COLORS` from `theme.ts`, e.g. `color: PALETTE.orchid` |
| MUI semantic colour | MUI token string, e.g. `color: 'text.secondary'`, `bgcolor: 'background.paper'` |
| CSS custom property | `var(--plum)`, `var(--brand-accent)`, etc. |
| Tailwind-origin value | Import the constant from `theme.ts` rather than repeating the literal |

**When a hardcoded hex is genuinely necessary** (third-party brand colour,
inline SVG `fill` attribute, CSS variable fallback, status colour validated
by a `getComputedStyle` test), add a trailing suppression comment on the
hex-value line:

```tsx
// same-line form (most common):
color: '#fdba74', // hex-color-ok: conflict-warning orange; no STATUS_COLORS token covers this shade

// block-comment form (required when // is not valid JSX attribute syntax):
<span style={{ color: 'var(--neutral-500, #737373)' }}> {/* hex-color-ok: fallback for CSS custom property */}
```

The suppression comment must include a brief reason after the colon.
It silences the check for that line only — keep reasons specific so they
serve as a reviewer checklist.

**Reviewer checklist for new hex values:**
1. Can the colour come from a `theme.ts` export (`PALETTE`, `STAGE_COLORS`,
   `STATUS_COLORS`, `VISIT_TYPE_COLORS`, `BRAND_COLORS`)?
2. Can an MUI token string (`'primary.main'`, `'error.light'`, etc.) or
   a CSS custom property (`var(--plum)`) serve instead?
3. If neither applies, is the value tested by a `getComputedStyle` assertion
   in a paired `*.test.tsx` file, so drift will be caught immediately?
4. If all three answers are "no", add a `// hex-color-ok: <reason>` comment
   **and** consider adding the colour to `theme.ts` for future reuse.

## Privilege gating

React components gate on `privilege_level` from the user object via the
`usePrivilege()` hook in `src/react/hooks/usePrivilege.ts`:

```tsx
import { usePrivilege } from '../hooks/usePrivilege';

function MyComponent() {
  const { isAdmin, isManager, isViewer } = usePrivilege();
  return (
    <>
      {!isViewer && <Button>Edit</Button>}
      {isAdmin && <Button>Admin action</Button>}
    </>
  );
}
```

The hook reads `privilege_level` from the user object published by
`core.js` via `window.__moHeaderUser` and the `mo:user` window event.
It returns `{ privilegeLevel, isAdmin, isManager, isViewer }` where
`isManager` is true for both `manager` and `admin` privilege levels.

**Convention:** React components always use `usePrivilege()` and
conditional rendering. Vanilla-JS pages in `public/` read
`state.user?.privilege_level` directly (e.g. `=== 'admin'`,
`=== 'viewer'`, `=== 'manager' || … === 'admin'`). The
`data-admin-only`, `data-viewer-hide`, and `data-manager-only`
CSS-attribute approach has been fully retired; all remaining privilege
gating is done via inline JS conditionals at render time.

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
