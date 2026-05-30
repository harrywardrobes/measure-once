---
name: MUI v6 slotProps data-testid
description: How to attach data-testid to MUI v6 Drawer/Dialog paper slots without TS2353 errors
---

## Rule
Never pass `'data-testid'` as a direct key inside `slotProps={{ paper: { ... } }}` on MUI Drawer or Dialog. MUI v6's `SlotProps` types do not include HTML data attributes and TypeScript will reject it with TS2353.

## Fix
Use a `ref` callback to set the attribute imperatively after mount:

```tsx
slotProps={{
  paper: {
    ref: (el: HTMLElement | null) => {
      if (el) el.setAttribute('data-testid', 'my-id');
    },
  },
}}
```

For Dialog paper that also needs `sx`:
```tsx
slotProps={{
  paper: {
    sx: { borderRadius: 3 },
    ref: (el: HTMLElement | null) => {
      if (el) el.setAttribute('data-testid', 'my-id');
    },
  },
}}
```

**Why:** MUI v6 tightened the `SlotProps` generic constraints. The paper slot type resolves to `SlotProps<ElementType<PaperProps>, DrawerPaperSlotPropsOverrides, DrawerOwnerState>` (or Dialog equivalent), which does not extend `HTMLAttributes` and therefore has no index signature for arbitrary data attributes.

**How to apply:** Any time a Puppeteer/Playwright test needs to query a MUI Drawer paper or Dialog paper by `data-testid`, use this ref-callback pattern instead of putting the attribute in slotProps directly. The attribute ends up on the same DOM node either way.
