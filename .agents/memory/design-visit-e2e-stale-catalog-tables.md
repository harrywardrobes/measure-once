---
name: design-visit E2E test references dropped catalog tables
description: Why test/design-visit/run.js fails at setup against a fresh isolated DB
---

The `test/design-visit/run.js` E2E suite fails at boot setup with
"Timed out waiting for table design_visit_handles" (or _door_styles /
_furniture_ranges) when run against a fresh isolated test DB (`:ci`).

**Cause:** the catalog-tables migration migrates the old
`design_visit_handles` / `design_visit_door_styles` /
`design_visit_furniture_ranges` tables into shared `catalog_handles` /
`catalog_doors` / `catalog_ranges` tables and then DROPS the old ones. The
test still `waitForTable()`s the dropped names and cleans/seeds them.

**How to apply:** this is pre-existing test staleness, not caused by feature
work in design-visits.js. To run the suite, remap the test's waitForTable
list, cleanup DELETEs, and any seeding to the `catalog_*` tables. Until then,
rely on the questionnaire suite (`test:questionnaire:ci`) for design-visit
answer coverage — it seeds visits directly and passes.
