---
name: MUI v6 Stack layout props
description: Stack shorthand layout props must go inside sx in MUI v6
---

## Rule
On MUI `<Stack>`, props like `alignItems`, `flexWrap`, `direction`, `justifyContent` etc. must be passed inside `sx={{}}`, not as direct component props.

**Why:** MUI v6 removed the responsive shorthand prop system that was present in v5. Direct layout props on Stack no longer compile.

**How to apply:** Whenever writing or reviewing Stack usage, put all layout-related values inside `sx`.
