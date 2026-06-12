---
name: CJS/ESM shared module boundary
description: How to share data/logic between Node.js CJS server code and Vite/TypeScript React bundles without hitting Rollup's named-export detection failure.
---

## The Rule

When a module must be consumed by both the Node.js CJS server (`require()`) and the Vite/React TypeScript bundle (`import`), use **two files**:

- `shared/<name>.ts` — canonical TypeScript/ESM source (imported by `.tsx`/`.ts` files via Vite)
- `shared/<name>.cjs` — CJS mirror (`require()`d by server.js and other Node.js modules)

Server-side callers must use the **explicit `.cjs` extension** in `require('./shared/<name>.cjs')`.

**Why:** Vite resolves `.js` before `.ts` in its default extension order (`['.mjs', '.js', '.ts', ...]`). If a `.js` file exists alongside a `.ts` file, Vite picks the `.js` first and then Rollup's CommonJS plugin fails to detect named exports from `module.exports = {}` or even `exports.X = X` style CJS. Naming the CJS file `.cjs` removes it from Vite's resolution path entirely, so the `.ts` file is always used for bundling.

**How to apply:** Any new `shared/` module that needs cross-boundary access:
1. Write the canonical data/types/helpers in `shared/<name>.ts` (ESM, proper TypeScript types).
2. Write the CJS copy in `shared/<name>.cjs` (same data, CJS syntax).
3. All `require()` calls use `require('./shared/<name>.cjs')` — never the bare name.
4. All TypeScript `import` statements use `'../../../shared/<name>'` (no extension) — TypeScript Bundler resolution finds `.ts` first.
5. Add a drift-guard test if the two files must agree on critical API contracts.

## Example (this project)

- `shared/handler-outcomes.ts` — TypeScript canonical; imported by `src/react/utils/handlerMeta.ts`
- `shared/handler-outcomes.cjs` — CJS mirror; required by `server.js`, `photo-reviews.js`, `quickbooks.js`
- `test/card-action-handlers/drift-guard.js` — asserts terminal keys and status maps match
