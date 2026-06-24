---
name: runtime dependency vs devDependency masking
description: Why a package can work in dev/Replit but crash a prod container — transitive devDep presence masks a missing direct runtime dependency.
---

# Runtime `require()`s must be declared in `dependencies`, not just present transitively

A package that is `require()`d by runtime code (e.g. `google-maps.js`, `shared/*.cjs`,
`server.js`) must appear in `package.json` **`dependencies`**. If it is absent from
`dependencies` but happens to be installed transitively via a *devDependency*, every
dev/Replit path still works (those install devDeps), so the gap is invisible — until a
production install runs `npm ci --omit=dev`, which omits the dev tree and the package
disappears. The server then crashes at boot with `Cannot find module '<pkg>'`.

**Concrete instance:** `zod` was required at runtime but was not a declared dependency
(only pulled in transitively by a devDependency). The Docker runtime stage
(`npm ci --omit=dev`) crash-looped on `Cannot find module 'zod'`. Fixed by promoting
`zod` to `dependencies`.

**Why:** Replit deploy / local dev run `npm install` (all deps), so transitive presence
masks the missing direct dependency. Only an `--omit=dev` (production container) install
exposes it.

**How to apply:**
- When adding/auditing the production container path, cross-check every external
  `require()` in runtime modules against `dependencies` (not `devDependencies`).
- A quick scan: collect non-relative, non-builtin `require()` specifiers from `server.js`,
  root `*.js`/`*.cjs`, and `shared/*.cjs`; flag any whose package isn't in `dependencies`.
- Verify against the image, not just the lockfile: BuildKit can serve a **stale cached
  `COPY package-lock.json` / `npm ci` layer**, so a lockfile fix may not appear in the
  image until cache is busted. Inspect `node_modules` inside the built image (or rebuild
  `--no-cache`) to confirm.
