---
name: MUI v6 Autocomplete renderInput InputProps typing
description: AutocompleteRenderInputParams does not expose InputProps in this repo's MUI types; cast through unknown to merge adornments.
---

When customizing a MUI `<Autocomplete>` `renderInput` and you need to merge
extra adornments (start/end) onto the input, `params.InputProps` is **not**
present on the `AutocompleteRenderInputParams` type in this repo's MUI v6
setup. `tsc` fails with TS2339 (property does not exist) and a direct
`as { InputProps: ... }` cast fails with TS2352 (insufficient overlap).

**Fix:** cast through `unknown` first, with a fallback:

```ts
const inputProps =
  (params as unknown as { InputProps: Record<string, unknown> }).InputProps || {};
```

Then spread `...inputProps` into `slotProps.input` and re-add
`inputProps.endAdornment as React.ReactNode` so the clear/dropdown/loading
adornments survive.

**Why:** the runtime object does carry `InputProps`; only the published type
omits it, so the value is real but the compiler needs the double cast.

**How to apply:** any `<Autocomplete renderInput>` that injects custom
adornments while preserving the built-in ones.
