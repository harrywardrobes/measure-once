---
name: HANDLER_OUTCOMES ships in main.js
description: Why enriching the card-action outcome registry data can trip the main.js gzip cap.
---

The `HANDLER_OUTCOMES` / `ACTION_LEVEL_EMAIL_TEMPLATES` registry in
`shared/handler-outcomes.ts` is imported (via `src/react/utils/handlerMeta.ts`)
by main-bundle components, so the **registry object literal itself lives in
`public/react/main.js`** — not just in lazy admin page chunks.

**Why it matters:** enriching registry entries with extra data (e.g. changing
`sendsEmailTemplates: ['key']` to `[{ key, system, sentFrom }]`) increases the
main bundle's gzip size directly, and `main.js` runs chronically right at its
gzip cap in `scripts/check-bundle-sizes.mjs`. Even ~100 bytes can flip the gate
from pass to FAIL.

**How to apply:**
- Keep helper functions that only the admin/lazy pages need OUT of the main
  bundle: import them directly from `shared/handler-outcomes` in the lazy page,
  and do NOT re-export them from `handlerMeta.ts` (re-exporting forces them into
  main). Inline tiny normalisations (e.g. `typeof ref === 'string' ? ref : ref.key`)
  in main-bundle code instead of importing a named helper.
- The data enrichment in the registry literal is unavoidable cost when the
  feature genuinely needs it in main; raising the documented `main.js` threshold
  in `check-bundle-sizes.mjs` (with a one-line reason, matching the file's
  existing convention) is the accepted resolution.
