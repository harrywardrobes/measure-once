# Admin Database Editor — E2E Test

- Run ID: `s7hf99`
- Date: 2026-05-25T08:11:48.788Z
- Command: `npm run test:db-editor`

## Summary

- Passed: 28 / 28
- Failed: 0 / 28

## Results

| Result | Probe | Expected | Observed |
|---|---|---|---|
| PASS | member GET /api/admin/db/tables → 403 | status=403 | status=403 |
| PASS | member GET /api/admin/db/lead_substatuses/rows → 403 | status=403 | status=403 |
| PASS | member POST /api/admin/db/lead_substatuses/rows → 403 | status=403 | status=403 |
| PASS | member PATCH /api/admin/db/lead_substatuses/rows/:pk → 403 | status=403 | status=403 |
| PASS | member DELETE /api/admin/db/lead_substatuses/rows/:pk → 403 | status=403 | status=403 |
| PASS | member GET /api/admin/db/audit → 403 | status=403 | status=403 |
| PASS | admin GET /api/admin/db/users/rows → 403 (not in allow-list) | status=403 with "allow-list" message | status=403 body={"error":"Table not in allow-list."} |
| PASS | admin GET /api/admin/db/sessions/rows → 403 (not in allow-list) | status=403 with "allow-list" message | status=403 body={"error":"Table not in allow-list."} |
| PASS | admin GET /api/admin/db/password_set_tokens/rows → 403 (not in allow-list) | status=403 with "allow-list" message | status=403 body={"error":"Table not in allow-list."} |
| PASS | admin GET /api/admin/db/db_editor_audit/rows → 403 (not in allow-list) | status=403 with "allow-list" message | status=403 body={"error":"Table not in allow-list."} |
| PASS | admin POST /api/admin/db/users/rows → 403 (not in allow-list) | status=403 | status=403 |
| PASS | admin PATCH /api/admin/db/sessions/rows/:pk → 403 (not in allow-list) | status=403 | status=403 |
| PASS | admin DELETE /api/admin/db/password_set_tokens/rows/:pk → 403 (not in allow-list) | status=403 | status=403 |
| PASS | admin POST /api/admin/db/db_editor_audit/rows → 403 (audit table is not editable) | status=403 | status=403 |
| PASS | admin GET /api/admin/db/tables lists lead_substatuses and excludes auth tables | lead_substatuses ∈ tables, users/sessions/password_set_tokens/db_editor_audit ∉ tables | count=25 lead_substatuses=true excludesAuth=true |
| PASS | admin POST inserts a row on lead_substatuses | status=201 with row.id set | status=201 id=28 label="privtest db editor original" |
| PASS | db_editor_audit has exactly one matching insert row | count=1 op=insert admin_email=admin before=null after.label=original | count=1 admin=privtest-admin-s7hf99@privtest.local before=null after.label="privtest db editor original" |
| PASS | admin PATCH updates the row | status=200 with row.label updated | status=200 label="privtest db editor renamed" |
| PASS | db_editor_audit has exactly one matching update row | count=1 op=update before.label=original after.label=renamed | count=1 before.label="privtest db editor original" after.label="privtest db editor renamed" |
| PASS | admin DELETE without X-Confirm-Pk → 400 | status=400 with confirmation error | status=400 body={"error":"PK confirmation header missing or does not match."} |
| PASS | admin DELETE with mismatched X-Confirm-Pk → 400 | status=400 with confirmation error | status=400 body={"error":"PK confirmation header missing or does not match."} |
| PASS | rejected DELETEs do not remove the row | row still present | present=true |
| PASS | rejected DELETEs write no audit row | count=0 delete audit rows | count=0 |
| PASS | admin DELETE with matching X-Confirm-Pk succeeds | status=200 body.ok=true | status=200 body={"ok":true} |
| PASS | db_editor_audit has exactly one matching delete row | count=1 op=delete before.label=renamed after=null | count=1 before.label="privtest db editor renamed" after=null |
| PASS | successful DELETE removed the row | count=0 | count=0 |
| PASS | db_editor_audit has exactly insert,update,delete for the fixture pk | ops=insert,update,delete (count=3) | ops=insert,update,delete count=3 |
| PASS | admin GET /api/admin/db/audit returns the fixture audit rows | status=200 and ops contain delete,insert,update | status=200 matching=3 ops=delete,insert,update |

## Coverage

- **(a) Non-admin lockout**: a `member`-privilege session receives 403 on
  GET /api/admin/db/tables, GET/POST/PATCH/DELETE
  /api/admin/db/lead_substatuses/rows[/:pk], and GET /api/admin/db/audit.
- **(b) Insert / edit / delete with audit**: an admin session inserts a
  `lead_substatuses` row, edits its label, deletes it, and the test
  asserts the `db_editor_audit` table contains exactly one matching row
  per operation with the expected admin_email and before/after JSON.
  A final cross-check confirms exactly three audit rows in
  `insert,update,delete` order, and that `GET /api/admin/db/audit?table=…`
  surfaces them.
- **(c) Allow-list guard**: requests for `users`, `sessions`,
  `password_set_tokens`, and `db_editor_audit` are rejected with 403
  ("Table not in allow-list") on GET / POST / PATCH / DELETE — proving the
  guard runs before any SQL is built, even for table names that exist as
  real PostgreSQL identifiers. GET /tables also excludes them.
- **(d) Delete confirmation header**: DELETE without `X-Confirm-Pk` is
  rejected with 400, DELETE with a mismatched header is rejected with 400,
  the row stays in the database, no delete audit row is written, and the
  matching-header DELETE then succeeds.

## Notes

- The test server is booted via the shared privileges harness with the
  same env-stripping defaults (no HUBSPOT_TOKEN, SMTP, Google or QB
  credentials). The db-editor surface depends only on PostgreSQL so this
  has no effect on the probes.
- All synthetic rows are namespaced behind the `privtest-` / `PRIVTEST_`
  prefix and the fixture row is cleaned up on exit (along with any audit
  rows that reference it).