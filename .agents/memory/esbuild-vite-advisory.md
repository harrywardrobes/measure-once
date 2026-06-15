---
name: esbuild advisory vs vite 6 build
description: Why esbuild cannot be force-upgraded to satisfy GHSA-gv7w-rqvm-qjhr without a vite major bump
---

GHSA-gv7w-rqvm-qjhr (esbuild dev-server / NPM_CONFIG_REGISTRY) had its affected
range widened to `>=0.17.0 <0.28.1`, so npm audit flags the esbuild that vite 6
ships. Forcing `esbuild@^0.28.1` via `overrides` clears the audit but **breaks the
vite 6 production build** with `Transforming destructuring to the configured target
environment ... is not supported yet` (e.g. FileUploadField). esbuild 0.28.x is not
compatible with vite 6.4.2's transpile pipeline.

**Rule:** do not pin/override esbuild above what the installed vite expects. Let each
vite pick its own esbuild (root vite 6 → 0.25.x, mockup-sandbox vite 7 → 0.27.x).

**Why:** the two goals (0 audit findings + working build) cannot both be met while on
vite 6 — npm's own `fixAvailable` is `vite@8` (semver-major). The real fix is a
deliberate vite major upgrade, not an esbuild override.

**How to apply:** if a security task adds an `esbuild` override to `package.json`
and/or `artifacts/mockup-sandbox/package.json`, expect the post-merge `build:react`
to fail. Remove the esbuild override and reinstall both workspaces. Treat the
remaining build-time-only, Deno-specific advisory as accepted until vite is upgraded.

Note: reinstalls here can hit `ENOTEMPTY` rename errors on `node_modules/esbuild`
or `node_modules/@esbuild/.linux-x64-*` temp dirs (concurrent installs). Clean
`node_modules/.esbuild-*` and `node_modules/@esbuild/.linux-x64-*` then retry.
