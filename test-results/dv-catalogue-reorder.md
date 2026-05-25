# Design Visit Catalogue — Up/Down Reorder — E2E Test

- Run ID: `bqln12`
- Date: 2026-05-25T08:26:07.958Z
- Command: `npm run test:dv-catalogue-reorder`

## Summary

- Passed: 32 / 32
- Failed: 0 / 32

## Results

| Result | Probe | Expected | Observed |
|---|---|---|---|
| PASS | admin page exposes switchTab + loadDvCatalogue + moveDvItem | all three globals available | ready=true |
| PASS | design-visit catalogue lists load (no "Loading…") | all three wraps replaced their Loading placeholders | ready=true |
| PASS | [handle] wrap initially renders seeded rows in order A then B | A(id=3) at index 0, B(id=4) at index 1 | aIdx=0 bIdx=1 ids=[3,4] |
| PASS | [handle] pre-swap: top row's ▲ disabled, top row's ▼ enabled | upDisabled === true && downDisabled === false on top row | top={"id":3,"text":"⋮⋮ — privtest-dvca-ro handle A Bar ▲ ▼ Edit Delete","upDisabled":true,"downDisabled":false} |
| PASS | [handle] pre-swap: bottom row's ▼ disabled, bottom row's ▲ enabled | downDisabled === true && upDisabled === false on bottom row | bottom={"id":4,"text":"⋮⋮ — privtest-dvca-ro handle B Bar ▲ ▼ Edit Delete","upDisabled":false,"downDisabled":true} |
| PASS | [handle] click ▼ on top row dispatches moveDvItem(..., 'down') | rendered ▼ button is present, enabled, and clickable | clicked=true |
| PASS | [handle] after click, A and B swap DOM order in #dv-handles-wrap | B(id=4) appears before A(id=3) in tbody | state={"ids":[4,3],"aIdx":1,"bIdx":0} |
| PASS | [handle] no full page reload during reorder (window.__pageLoadToken preserved) | __pageLoadToken === "fzc2mt6hmww" | preserved=true |
| PASS | [handle] post-swap: B is now the top row, A is now the bottom row | B at index 0, A at index 1 | ids=[4,3] topIsB=true bottomIsA=true |
| PASS | [handle] post-swap: new top row's ▲ disabled, ▼ enabled | upDisabled === true && downDisabled === false on new top row (B) | newTop={"id":4,"text":"⋮⋮ — privtest-dvca-ro handle B Bar ▲ ▼ Edit Delete","upDisabled":true,"downDisabled":false} |
| PASS | [handle] post-swap: new bottom row's ▼ disabled, ▲ enabled | downDisabled === true && upDisabled === false on new bottom row (A) | newBottom={"id":3,"text":"⋮⋮ — privtest-dvca-ro handle A Bar ▲ ▼ Edit Delete","upDisabled":false,"downDisabled":true} |
| PASS | [handle] DB sort_order values swapped (A was 0/B was 1 → A=1, B=0) | A.sort_order === 1 && B.sort_order === 0 | A=1 B=0 |
| PASS | [furniture] wrap initially renders seeded rows in order A then B | A(id=3) at index 0, B(id=4) at index 1 | aIdx=0 bIdx=1 ids=[3,4] |
| PASS | [furniture] pre-swap: top row's ▲ disabled, top row's ▼ enabled | upDisabled === true && downDisabled === false on top row | top={"id":3,"text":"⋮⋮ privtest-dvca-ro furniture Aprivtest-dvca-ro furniture A desc ▲ ▼ Edit Delete","upDisabled":true,"downDisabled":false} |
| PASS | [furniture] pre-swap: bottom row's ▼ disabled, bottom row's ▲ enabled | downDisabled === true && upDisabled === false on bottom row | bottom={"id":4,"text":"⋮⋮ privtest-dvca-ro furniture Bprivtest-dvca-ro furniture B desc ▲ ▼ Edit Delete","upDisabled":false,"downDisabled":true} |
| PASS | [furniture] click ▼ on top row dispatches moveDvItem(..., 'down') | rendered ▼ button is present, enabled, and clickable | clicked=true |
| PASS | [furniture] after click, A and B swap DOM order in #dv-furniture-wrap | B(id=4) appears before A(id=3) in tbody | state={"ids":[4,3],"aIdx":1,"bIdx":0} |
| PASS | [furniture] no full page reload during reorder (window.__pageLoadToken preserved) | __pageLoadToken === "fzc2mt6hmww" | preserved=true |
| PASS | [furniture] post-swap: B is now the top row, A is now the bottom row | B at index 0, A at index 1 | ids=[4,3] topIsB=true bottomIsA=true |
| PASS | [furniture] post-swap: new top row's ▲ disabled, ▼ enabled | upDisabled === true && downDisabled === false on new top row (B) | newTop={"id":4,"text":"⋮⋮ privtest-dvca-ro furniture Bprivtest-dvca-ro furniture B desc ▲ ▼ Edit Delete","upDisabled":true,"downDisabled":false} |
| PASS | [furniture] post-swap: new bottom row's ▼ disabled, ▲ enabled | downDisabled === true && upDisabled === false on new bottom row (A) | newBottom={"id":3,"text":"⋮⋮ privtest-dvca-ro furniture Aprivtest-dvca-ro furniture A desc ▲ ▼ Edit Delete","upDisabled":false,"downDisabled":true} |
| PASS | [furniture] DB sort_order values swapped (A was 0/B was 1 → A=1, B=0) | A.sort_order === 1 && B.sort_order === 0 | A=1 B=0 |
| PASS | [door-style] wrap initially renders seeded rows in order A then B | A(id=3) at index 0, B(id=4) at index 1 | aIdx=0 bIdx=1 ids=[3,4] |
| PASS | [door-style] pre-swap: top row's ▲ disabled, top row's ▼ enabled | upDisabled === true && downDisabled === false on top row | top={"id":3,"text":"⋮⋮ privtest-dvca-ro door-style Ahttps://example.invalid/privtest-dvca-ro%20door-style%20A.png ▲ ▼ Edit Delete","upDisabled":true,"downDisabled":false} |
| PASS | [door-style] pre-swap: bottom row's ▼ disabled, bottom row's ▲ enabled | downDisabled === true && upDisabled === false on bottom row | bottom={"id":4,"text":"⋮⋮ privtest-dvca-ro door-style Bhttps://example.invalid/privtest-dvca-ro%20door-style%20B.png ▲ ▼ Edit Delete","upDisabled":false,"downDisabled":true} |
| PASS | [door-style] click ▼ on top row dispatches moveDvItem(..., 'down') | rendered ▼ button is present, enabled, and clickable | clicked=true |
| PASS | [door-style] after click, A and B swap DOM order in #dv-door-styles-wrap | B(id=4) appears before A(id=3) in tbody | state={"ids":[4,3],"aIdx":1,"bIdx":0} |
| PASS | [door-style] no full page reload during reorder (window.__pageLoadToken preserved) | __pageLoadToken === "fzc2mt6hmww" | preserved=true |
| PASS | [door-style] post-swap: B is now the top row, A is now the bottom row | B at index 0, A at index 1 | ids=[4,3] topIsB=true bottomIsA=true |
| PASS | [door-style] post-swap: new top row's ▲ disabled, ▼ enabled | upDisabled === true && downDisabled === false on new top row (B) | newTop={"id":4,"text":"⋮⋮ privtest-dvca-ro door-style Bhttps://example.invalid/privtest-dvca-ro%20door-style%20B.png ▲ ▼ Edit Delete","upDisabled":true,"downDisabled":false} |
| PASS | [door-style] post-swap: new bottom row's ▼ disabled, ▲ enabled | downDisabled === true && upDisabled === false on new bottom row (A) | newBottom={"id":3,"text":"⋮⋮ privtest-dvca-ro door-style Ahttps://example.invalid/privtest-dvca-ro%20door-style%20A.png ▲ ▼ Edit Delete","upDisabled":false,"downDisabled":true} |
| PASS | [door-style] DB sort_order values swapped (A was 0/B was 1 → A=1, B=0) | A.sort_order === 1 && B.sort_order === 0 | A=1 B=0 |

## Coverage

- For each catalogue type (handle / furniture / door-style):
  - Two rows are seeded directly in the DB with sort_order 0 (A) and
    1 (B), under the `privtest-dvca-ro` fixture prefix.
  - The admin Design Visit tab is opened and `loadDvCatalogue()` is
    awaited; the wrap renders A then B in seeded order.
  - Pre-swap, the top row's ▲ button is disabled and its ▼ is
    enabled; the bottom row's ▼ is disabled and its ▲ is enabled.
  - The actual rendered ▼ button on the top row is clicked (so the
    `onclick="moveDvItem(...)"` binding is exercised end-to-end).
  - After the two PATCHes resolve, the wrap re-renders in place with
    A and B swapped, `window.__pageLoadToken` is preserved (no full
    page reload), and the new top/bottom disable states are flipped.
  - The DB rows for A/B now hold sort_order 1 and 0 respectively.

## Notes

- Fixtures use the `privtest-dvca-ro` name prefix and are purged in
  `cleanupAndExit()` (including on signal / crash). The harness strips
  `HUBSPOT_TOKEN` / `SMTP_*` / OAuth credentials; the catalogue
  endpoints are PostgreSQL-only, so no third-party access is needed.