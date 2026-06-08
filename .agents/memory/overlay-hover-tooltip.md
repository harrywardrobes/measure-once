---
name: Hover tooltip over transparent-input + backdrop-mirror overlay
description: How to show a per-segment hover hint on highlighted text inside TokenHighlightField without breaking editing.
---

# Hover hint over a transparent-input + backdrop overlay

TokenHighlightField layers a transparent native `<input>/<textarea>` on top of a
styled "backdrop" mirror (`pointer-events: none`, `aria-hidden`) that renders the
coloured token spans. To show a hover tooltip on a specific span (e.g. the reason
a placeholder is malformed):

**Do NOT make the backdrop span interactive** (`pointer-events: auto` + raised
`zIndex`). It lifts the span above the input and steals mousedown, so clicking the
token no longer places the caret and drag/double-click selection over it breaks.

**Instead** keep the backdrop fully non-interactive and drive the tooltip from the
input's pointer: tag the spans with a `data-*` attribute, add `onMouseMove` to the
input, hit-test `clientX/clientY` against each tagged span's `getClientRects()`
(use `getClientRects`, not `getBoundingClientRect`, so wrapped multi-line tokens
hit-test correctly), and open a **controlled** MUI `Tooltip` anchored via
`slotProps.popper.anchorEl` (a virtual element whose `getBoundingClientRect`
returns the live span rect). `onMouseLeave` closes it.

**Why:** the input must stay the top, sole pointer target so caret/focus/selection
keep working; coordinates are viewport-relative so the hit-test stays correct
through scroll and padding.

**How to apply:** reuse this pattern for any future per-token affordance over the
same overlay. Hover/mouse only — keyboard & screen-reader users get the reason
from the save-guard banner, since the backdrop is `aria-hidden`.
