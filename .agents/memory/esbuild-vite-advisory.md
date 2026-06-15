---
name: esbuild advisory vs vite 6 build
description: esbuild 0.28.1 is the required fix for GHSA-gv7w-rqvm-qjhr; compatible with both vite 6.4.3 and vite 7.3.5
---

GHSA-gv7w-rqvm-qjhr (esbuild dev-server arbitrary file/origin access) affects
esbuild 0.17.0 – 0.28.0. The fix requires esbuild >= 0.28.1.

**Previous finding (now resolved):** An earlier note said esbuild 0.28.1 breaks vite 6.4.2
builds with "Transforming destructuring to the configured target environment ... is not
supported yet". This was specific to vite 6.4.2.

**Current state:** esbuild 0.28.1 is compatible with both:
- vite 6.4.3 (root workspace) — `npm run build:react:dev` succeeds
- vite 7.3.5 (artifacts/mockup-sandbox) — `npm audit` shows 0 vulnerabilities

**Rule:** Override esbuild to exactly `"0.28.1"` in both `package.json` (root) and
`artifacts/mockup-sandbox/package.json` overrides.

**Why:** The advisory range 0.17.0–0.28.0 is inclusive of 0.28.0, so pinning to
0.28.0 does NOT clear the advisory. The fix is 0.28.1 specifically. Both vite 6.4.3+
and vite 7.3.5+ are compatible with esbuild 0.28.1.

**How to apply:** If a new esbuild advisory appears requiring >0.28.1, test the build
first in both workspaces — the destructuring regression was specific to the vite 6.4.2
esbuild integration and may or may not recur in later versions.

Note: npm install can hit `ENOTEMPTY` rename errors on temp dirs during concurrent
installs. Clean `node_modules/esbuild` and retry.
