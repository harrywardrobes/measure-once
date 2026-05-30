# Icons in the React island

## Source

All icons rendered inside React components come from
[`@mui/icons-material`](https://mui.com/material-ui/material-icons/). One
named export per icon, imported directly:

```tsx
import DeleteIcon from '@mui/icons-material/Delete';

<IconButton aria-label="delete"><DeleteIcon /></IconButton>
```

The package is already a dependency (see `package.json`). It ships every
Material icon as an individual ES module — tree-shaking keeps the bundle
small even though the icon set is large.

## Picking an icon

1. Browse the searchable catalogue at
   <https://mui.com/material-ui/material-icons/>.
2. Click an icon to see its import name and the available variants
   (Filled, Outlined, Rounded, Sharp, Two-tone). Default `Delete` is the
   filled variant; the others have suffixes like `DeleteOutlined`,
   `DeleteRounded`, etc.
3. Prefer the **filled** variant unless a specific page calls for a
   different look — consistency beats variety.

## Conventions

- **No new inline `<svg>` blocks in React code.** If you're tempted to
  paste an SVG into a `.tsx` file, find the closest MUI icon first. If
  nothing fits, raise it for discussion rather than introducing a
  one-off.
- **No other icon libraries in React.** Don't add `lucide-react`,
  `react-icons`, Heroicons, Feather, etc. One source keeps the bundle
  lean and discovery trivial.
- **Pair icon-only triggers with `IconButton` + `Tooltip`** for an
  accessible label:

  ```tsx
  <Tooltip title="Delete">
    <IconButton color="error"><DeleteIcon /></IconButton>
  </Tooltip>
  ```

- **Sizing:** use the `fontSize` prop (`small`, `medium`, `large`) or
  the `sx={{ fontSize: 20 }}` shorthand. Avoid hand-rolled width/height
  styles — they break alignment inside MUI buttons.
- **Colour:** prefer `color="primary" | "error" | "success" | …` (theme
  tokens) over hard-coded hex values, so a theme refresh propagates
  automatically.

## Out of scope

The vanilla pages in `public/` (e.g. `sales.html`, `survey.html`,
`calendar.html`, `trades.html`, `invoices.html`, `ideas.html`,
`profile.html`, `home.html`) still use hand-written inline SVGs. **Leave
those alone** — they'll switch to MUI icons when each page migrates to
React under its own task. Don't rip the SVGs out early; the migration
tasks will replace them in context.
