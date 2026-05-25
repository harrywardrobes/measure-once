# Admin Database Editor — E2E Test

- Run ID: `ybxmj2`
- Date: 2026-05-25T08:33:16.317Z
- Command: `npm run test:db-editor`

## Summary

- Passed: 149 / 149
- Failed: 0 / 149

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
| PASS | admin POST inserts a row on lead_substatuses | status=201 with row.id set | status=201 id=25 label="privtest db editor original" |
| PASS | db_editor_audit has exactly one matching insert row | count=1 op=insert admin_email=admin before=null after.label=original | count=1 admin=privtest-admin-ybxmj2@privtest.local before=null after.label="privtest db editor original" |
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
| PASS | [matrix] app_settings: GET /api/admin/db/app_settings/rows → 200 | status=200 with rows[] array | status=200 rows=1 |
| PASS | [matrix] app_settings: POST insert minimal row → 201 with pk | status=201 and row has pk columns (key) | status=201 body={"row":{"key":"PRIVTEST_APP_ybxmj2","value":"x","updated_at":"2026-05-25T08:33:14.479Z"}} |
| PASS | [matrix] app_settings: PATCH update value → 200 with matching audit row | status=200, row.value updated, db_editor_audit update row before="x" after="y" | status=200 body.row.value="y" audit before.value="x" after.value="y" admin=privtest-admin-ybxmj2@privtest.local |
| PASS | [matrix] app_settings: DELETE /api/admin/db/app_settings/rows/PRIVTEST_APP_ybxmj2 → 200 | status=200 and body.ok=true | status=200 body={"ok":true} |
| PASS | [matrix] app_settings: row is gone after DELETE (filtered GET) | rows[].length=0 for the deleted pk | status=200 matched=0 |
| PASS | [matrix] card_action_handler_bindings: GET /api/admin/db/card_action_handler_bindings/rows → 200 | status=200 with rows[] array | status=200 rows=0 |
| PASS | [matrix] card_action_handler_bindings: POST insert minimal row → 201 with pk | status=201 and row has pk columns (id) | status=201 body={"row":{"id":1,"handler_id":1,"stage_key":"PRIVTEST_STG_ybxmj2","status_key":"PRIVTEST_STA_ybxmj2","substatus_id":null}} |
| PASS | [matrix] card_action_handler_bindings: PATCH update status_key → 200 with matching audit row | status=200, row.status_key updated, db_editor_audit update row before="PRIVTEST_STA_ybxmj2" after="PRIVTEST_STA_ybxmj2_UPD" | status=200 body.row.status_key="PRIVTEST_STA_ybxmj2_UPD" audit before.status_key="PRIVTEST_STA_ybxmj2" after.status_key="PRIVTEST_STA_ybxmj2_UPD" admin=privtest-admin-ybxmj2@privtest.local |
| PASS | [matrix] card_action_handler_bindings: DELETE /api/admin/db/card_action_handler_bindings/rows/1 → 200 | status=200 and body.ok=true | status=200 body={"ok":true} |
| PASS | [matrix] card_action_handler_bindings: row is gone after DELETE (filtered GET) | rows[].length=0 for the deleted pk | status=200 matched=0 |
| PASS | [matrix] card_action_handlers: GET /api/admin/db/card_action_handlers/rows → 200 | status=200 with rows[] array | status=200 rows=0 |
| PASS | [matrix] card_action_handlers: POST insert minimal row → 201 with pk | status=201 and row has pk columns (id) | status=201 body={"row":{"id":2,"name":"privtest handler","type":"noop","config":{},"created_at":"2026-05-25T08:33:14.642Z","updated_at":"2026-05-25T08:33:14.642Z"}} |
| PASS | [matrix] card_action_handlers: PATCH update name → 200 with matching audit row | status=200, row.name updated, db_editor_audit update row before="privtest handler" after="privtest handler updated" | status=200 body.row.name="privtest handler updated" audit before.name="privtest handler" after.name="privtest handler updated" admin=privtest-admin-ybxmj2@privtest.local |
| PASS | [matrix] card_action_handlers: DELETE /api/admin/db/card_action_handlers/rows/2 → 200 | status=200 and body.ok=true | status=200 body={"ok":true} |
| PASS | [matrix] card_action_handlers: row is gone after DELETE (filtered GET) | rows[].length=0 for the deleted pk | status=200 matched=0 |
| PASS | [matrix] design_visit_door_styles: GET /api/admin/db/design_visit_door_styles/rows → 200 | status=200 with rows[] array | status=200 rows=0 |
| PASS | [matrix] design_visit_door_styles: POST insert minimal row → 201 with pk | status=201 and row has pk columns (id) | status=201 body={"row":{"id":1,"name":"privtest door","image_url":null,"sort_order":0,"created_at":"2026-05-25T08:33:14.706Z","updated_at":"2026-05-25T08:33:14.706Z"}} |
| PASS | [matrix] design_visit_door_styles: PATCH update sort_order → 200 with matching audit row | status=200, row.sort_order updated, db_editor_audit update row before=0 after=12345 | status=200 body.row.sort_order=12345 audit before.sort_order=0 after.sort_order=12345 admin=privtest-admin-ybxmj2@privtest.local |
| PASS | [matrix] design_visit_door_styles: DELETE /api/admin/db/design_visit_door_styles/rows/1 → 200 | status=200 and body.ok=true | status=200 body={"ok":true} |
| PASS | [matrix] design_visit_door_styles: row is gone after DELETE (filtered GET) | rows[].length=0 for the deleted pk | status=200 matched=0 |
| PASS | [matrix] design_visit_furniture_ranges: GET /api/admin/db/design_visit_furniture_ranges/rows → 200 | status=200 with rows[] array | status=200 rows=0 |
| PASS | [matrix] design_visit_furniture_ranges: POST insert minimal row → 201 with pk | status=201 and row has pk columns (id) | status=201 body={"row":{"id":1,"name":"privtest range","description":null,"sort_order":0,"created_at":"2026-05-25T08:33:14.770Z","updated_at":"2026-05-25T08:33:14.770Z"}} |
| PASS | [matrix] design_visit_furniture_ranges: PATCH update description → 200 with matching audit row | status=200, row.description updated, db_editor_audit update row before=null after="privtest range description updated" | status=200 body.row.description="privtest range description updated" audit before.description=null after.description="privtest range description updated" admin=privtest-admin-ybxmj2@privtest.local |
| PASS | [matrix] design_visit_furniture_ranges: DELETE /api/admin/db/design_visit_furniture_ranges/rows/1 → 200 | status=200 and body.ok=true | status=200 body={"ok":true} |
| PASS | [matrix] design_visit_furniture_ranges: row is gone after DELETE (filtered GET) | rows[].length=0 for the deleted pk | status=200 matched=0 |
| PASS | [matrix] design_visit_handles: GET /api/admin/db/design_visit_handles/rows → 200 | status=200 with rows[] array | status=200 rows=0 |
| PASS | [matrix] design_visit_handles: POST insert minimal row → 201 with pk | status=201 and row has pk columns (id) | status=201 body={"row":{"id":1,"name":"privtest handle","description":null,"image_url":null,"sort_order":0,"created_at":"2026-05-25T08:33:14.835Z","updated_at":"2026-05-25T08:33:14.835Z","style":null}} |
| PASS | [matrix] design_visit_handles: PATCH update description → 200 with matching audit row | status=200, row.description updated, db_editor_audit update row before=null after="privtest handle description updated" | status=200 body.row.description="privtest handle description updated" audit before.description=null after.description="privtest handle description updated" admin=privtest-admin-ybxmj2@privtest.local |
| PASS | [matrix] design_visit_handles: DELETE /api/admin/db/design_visit_handles/rows/1 → 200 | status=200 and body.ok=true | status=200 body={"ok":true} |
| PASS | [matrix] design_visit_handles: row is gone after DELETE (filtered GET) | rows[].length=0 for the deleted pk | status=200 matched=0 |
| PASS | [matrix] design_visit_room_images: GET /api/admin/db/design_visit_room_images/rows → 200 | status=200 with rows[] array | status=200 rows=0 |
| PASS | [matrix] design_visit_room_images: POST insert minimal row → 201 with pk | status=201 and row has pk columns (id) | status=201 body={"row":{"id":1,"room_id":1,"storage_key":"privtest/storage/key","mime_type":null,"uploaded_at":"2026-05-25T08:33:14.926Z"}} |
| PASS | [matrix] design_visit_room_images: PATCH update mime_type → 200 with matching audit row | status=200, row.mime_type updated, db_editor_audit update row before=null after="image/png" | status=200 body.row.mime_type="image/png" audit before.mime_type=null after.mime_type="image/png" admin=privtest-admin-ybxmj2@privtest.local |
| PASS | [matrix] design_visit_room_images: DELETE /api/admin/db/design_visit_room_images/rows/1 → 200 | status=200 and body.ok=true | status=200 body={"ok":true} |
| PASS | [matrix] design_visit_room_images: row is gone after DELETE (filtered GET) | rows[].length=0 for the deleted pk | status=200 matched=0 |
| PASS | [matrix] design_visit_rooms: GET /api/admin/db/design_visit_rooms/rows → 200 | status=200 with rows[] array | status=200 rows=0 |
| PASS | [matrix] design_visit_rooms: POST insert minimal row → 201 with pk | status=201 and row has pk columns (id) | status=201 body={"row":{"id":2,"design_visit_id":2,"room_name":"privtest room","door_style_id":null,"width_mm":null,"height_mm":null,"depth_mm":null,"unit_count":1,"unit_price_pence":0,"notes":null,"sort_order":0,"created_at":"2026-05-25T08:33:15.032Z"}} |
| PASS | [matrix] design_visit_rooms: PATCH update room_name → 200 with matching audit row | status=200, row.room_name updated, db_editor_audit update row before="privtest room" after="privtest room updated" | status=200 body.row.room_name="privtest room updated" audit before.room_name="privtest room" after.room_name="privtest room updated" admin=privtest-admin-ybxmj2@privtest.local |
| PASS | [matrix] design_visit_rooms: DELETE /api/admin/db/design_visit_rooms/rows/2 → 200 | status=200 and body.ok=true | status=200 body={"ok":true} |
| PASS | [matrix] design_visit_rooms: row is gone after DELETE (filtered GET) | rows[].length=0 for the deleted pk | status=200 matched=0 |
| PASS | [matrix] design_visits: GET /api/admin/db/design_visits/rows → 200 | status=200 with rows[] array | status=200 rows=0 |
| PASS | [matrix] design_visits: POST insert minimal row → 201 with pk | status=201 and row has pk columns (id) | status=201 body={"row":{"id":3,"contact_id":"PRIVTEST","contact_name":null,"contact_email":null,"created_by":"privtest","handle_id":null,"furniture_range_id":null,"visit_date":null,"duration_min":90,"location":null,"notes":null,"terms_accepted":false,"stat |
| PASS | [matrix] design_visits: PATCH update notes → 200 with matching audit row | status=200, row.notes updated, db_editor_audit update row before=null after="privtest visit notes updated" | status=200 body.row.notes="privtest visit notes updated" audit before.notes=null after.notes="privtest visit notes updated" admin=privtest-admin-ybxmj2@privtest.local |
| PASS | [matrix] design_visits: DELETE /api/admin/db/design_visits/rows/3 → 200 | status=200 and body.ok=true | status=200 body={"ok":true} |
| PASS | [matrix] design_visits: row is gone after DELETE (filtered GET) | rows[].length=0 for the deleted pk | status=200 matched=0 |
| PASS | [matrix] idea_comments: GET /api/admin/db/idea_comments/rows → 200 | status=200 with rows[] array | status=200 rows=0 |
| PASS | [matrix] idea_comments: POST insert minimal row → 201 with pk | status=201 and row has pk columns (id) | status=201 body={"row":{"id":1,"idea_id":8,"author_user_id":"privtest","body":"privtest comment","created_at":"2026-05-25T08:33:15.294Z"}} |
| PASS | [matrix] idea_comments: PATCH update body → 200 with matching audit row | status=200, row.body updated, db_editor_audit update row before="privtest comment" after="privtest comment updated" | status=200 body.row.body="privtest comment updated" audit before.body="privtest comment" after.body="privtest comment updated" admin=privtest-admin-ybxmj2@privtest.local |
| PASS | [matrix] idea_comments: DELETE /api/admin/db/idea_comments/rows/1 → 200 | status=200 and body.ok=true | status=200 body={"ok":true} |
| PASS | [matrix] idea_comments: row is gone after DELETE (filtered GET) | rows[].length=0 for the deleted pk | status=200 matched=0 |
| PASS | [matrix] ideas: GET /api/admin/db/ideas/rows → 200 | status=200 with rows[] array | status=200 rows=0 |
| PASS | [matrix] ideas: POST insert minimal row → 201 with pk | status=201 and row has pk columns (id) | status=201 body={"row":{"id":9,"author_user_id":"privtest","body":"privtest idea","created_at":"2026-05-25T08:33:15.365Z"}} |
| PASS | [matrix] ideas: PATCH update body → 200 with matching audit row | status=200, row.body updated, db_editor_audit update row before="privtest idea" after="privtest idea updated" | status=200 body.row.body="privtest idea updated" audit before.body="privtest idea" after.body="privtest idea updated" admin=privtest-admin-ybxmj2@privtest.local |
| PASS | [matrix] ideas: DELETE /api/admin/db/ideas/rows/9 → 200 | status=200 and body.ok=true | status=200 body={"ok":true} |
| PASS | [matrix] ideas: row is gone after DELETE (filtered GET) | rows[].length=0 for the deleted pk | status=200 matched=0 |
| PASS | [matrix] job_roles: GET /api/admin/db/job_roles/rows → 200 | status=200 with rows[] array | status=200 rows=6 |
| PASS | [matrix] job_roles: POST insert minimal row → 201 with pk | status=201 and row has pk columns (job_id) | status=201 body={"row":{"name":"privtest_role_ybxmj2","created_at":"2026-05-25T08:33:15.430Z","job_id":683,"privilege_level":"member"}} |
| PASS | [matrix] job_roles: PATCH update name → 200 with matching audit row | status=200, row.name updated, db_editor_audit update row before="privtest_role_ybxmj2" after="privtest_role_ybxmj2_upd" | status=200 body.row.name="privtest_role_ybxmj2_upd" audit before.name="privtest_role_ybxmj2" after.name="privtest_role_ybxmj2_upd" admin=privtest-admin-ybxmj2@privtest.local |
| PASS | [matrix] job_roles: DELETE /api/admin/db/job_roles/rows/683 → 200 | status=200 and body.ok=true | status=200 body={"ok":true} |
| PASS | [matrix] job_roles: row is gone after DELETE (filtered GET) | rows[].length=0 for the deleted pk | status=200 matched=0 |
| PASS | [matrix] lead_status_config: GET /api/admin/db/lead_status_config/rows → 200 | status=200 with rows[] array | status=200 rows=18 |
| PASS | [matrix] lead_status_config: POST insert minimal row → 201 with pk | status=201 and row has pk columns (key) | status=201 body={"row":{"key":"PRIVTEST_LSC_ybxmj2","label":"privtest lsc","sort_order":9999,"excluded_from_sales":false,"stage":null,"is_null_row":false,"shorthand":null}} |
| PASS | [matrix] lead_status_config: PATCH update label → 200 with matching audit row | status=200, row.label updated, db_editor_audit update row before="privtest lsc" after="privtest lsc updated" | status=200 body.row.label="privtest lsc updated" audit before.label="privtest lsc" after.label="privtest lsc updated" admin=privtest-admin-ybxmj2@privtest.local |
| PASS | [matrix] lead_status_config: DELETE /api/admin/db/lead_status_config/rows/PRIVTEST_LSC_ybxmj2 → 200 | status=200 and body.ok=true | status=200 body={"ok":true} |
| PASS | [matrix] lead_status_config: row is gone after DELETE (filtered GET) | rows[].length=0 for the deleted pk | status=200 matched=0 |
| PASS | [matrix] lead_substatuses: GET /api/admin/db/lead_substatuses/rows → 200 | status=200 with rows[] array | status=200 rows=23 |
| PASS | [matrix] lead_substatuses: POST insert minimal row → 201 with pk | status=201 and row has pk columns (id) | status=201 body={"row":{"id":26,"status_key":"PRIVTEST_LSC_ybxmj2_E","substatus_key":"PRIVTEST_SUB_ybxmj2","label":"privtest sub","action_label":"","sort_order":9999,"updated_at":"2026-05-25T08:33:15.555Z"}} |
| PASS | [matrix] lead_substatuses: PATCH update label → 200 with matching audit row | status=200, row.label updated, db_editor_audit update row before="privtest sub" after="privtest sub updated" | status=200 body.row.label="privtest sub updated" audit before.label="privtest sub" after.label="privtest sub updated" admin=privtest-admin-ybxmj2@privtest.local |
| PASS | [matrix] lead_substatuses: DELETE /api/admin/db/lead_substatuses/rows/26 → 200 | status=200 and body.ok=true | status=200 body={"ok":true} |
| PASS | [matrix] lead_substatuses: row is gone after DELETE (filtered GET) | rows[].length=0 for the deleted pk | status=200 matched=0 |
| PASS | [matrix] search_settings: GET /api/admin/db/search_settings/rows → 200 | status=200 with rows[] array | status=200 rows=1 |
| PASS | [matrix] search_settings: POST insert minimal row → 201 with pk | status=201 and row has pk columns (id) | status=201 body={"row":{"id":999999,"disabled_actions":[],"hint_placeholder":"","action_order":[]}} |
| PASS | [matrix] search_settings: PATCH update hint_placeholder → 200 with matching audit row | status=200, row.hint_placeholder updated, db_editor_audit update row before="" after="privtest hint updated" | status=200 body.row.hint_placeholder="privtest hint updated" audit before.hint_placeholder="" after.hint_placeholder="privtest hint updated" admin=privtest-admin-ybxmj2@privtest.local |
| PASS | [matrix] search_settings: DELETE /api/admin/db/search_settings/rows/999999 → 200 | status=200 and body.ok=true | status=200 body={"ok":true} |
| PASS | [matrix] search_settings: row is gone after DELETE (filtered GET) | rows[].length=0 for the deleted pk | status=200 matched=0 |
| PASS | [matrix] stage_action_labels: GET /api/admin/db/stage_action_labels/rows → 200 | status=200 with rows[] array | status=200 rows=19 |
| PASS | [matrix] stage_action_labels: POST insert minimal row → 201 with pk | status=201 and row has pk columns (stage_key, status_key) | status=201 body={"row":{"stage_key":"PRIVTEST_STG_ybxmj2","status_key":"PRIVTEST_STA_ybxmj2","label":"privtest stage action","updated_at":"2026-05-25T08:33:15.673Z"}} |
| PASS | [matrix] stage_action_labels: PATCH update label → 200 with matching audit row | status=200, row.label updated, db_editor_audit update row before="privtest stage action" after="privtest stage action updated" | status=200 body.row.label="privtest stage action updated" audit before.label="privtest stage action" after.label="privtest stage action updated" admin=privtest-admin-ybxmj2@privtest.local |
| PASS | [matrix] stage_action_labels: DELETE /api/admin/db/stage_action_labels/rows/PRIVTEST_STG_ybxmj2\|PRIVTEST_STA_ybxmj2 → 200 | status=200 and body.ok=true | status=200 body={"ok":true} |
| PASS | [matrix] stage_action_labels: row is gone after DELETE (filtered GET) | rows[].length=0 for the deleted pk | status=200 matched=0 |
| PASS | [matrix] terms_conditions_versions: GET /api/admin/db/terms_conditions_versions/rows → 200 | status=200 with rows[] array | status=200 rows=0 |
| PASS | [matrix] terms_conditions_versions: POST insert minimal row → 201 with pk | status=201 and row has pk columns (id) | status=201 body={"row":{"id":1,"version_number":999999,"terms_text":"privtest terms","created_by":null,"created_at":"2026-05-25T08:33:15.733Z"}} |
| PASS | [matrix] terms_conditions_versions: PATCH update terms_text → 200 with matching audit row | status=200, row.terms_text updated, db_editor_audit update row before="privtest terms" after="privtest terms updated" | status=200 body.row.terms_text="privtest terms updated" audit before.terms_text="privtest terms" after.terms_text="privtest terms updated" admin=privtest-admin-ybxmj2@privtest.local |
| PASS | [matrix] terms_conditions_versions: DELETE /api/admin/db/terms_conditions_versions/rows/1 → 200 | status=200 and body.ok=true | status=200 body={"ok":true} |
| PASS | [matrix] terms_conditions_versions: row is gone after DELETE (filtered GET) | rows[].length=0 for the deleted pk | status=200 matched=0 |
| PASS | [matrix] trade_audit_log: GET /api/admin/db/trade_audit_log/rows → 200 | status=200 with rows[] array | status=200 rows=4 |
| PASS | [matrix] trade_companies: GET /api/admin/db/trade_companies/rows → 200 | status=200 with rows[] array | status=200 rows=1 |
| PASS | [matrix] trade_companies: POST insert minimal row → 201 with pk | status=201 and row has pk columns (id) | status=201 body={"row":{"id":2,"company_name":"privtest co","trade_type":"PRIVTEST","areas_served":null,"timescale":null,"invoice_method":null,"payment_terms":null,"notes":null,"created_by":null,"created_at":"2026-05-25T08:33:15.868Z","legacy_id":null,"upd |
| PASS | [matrix] trade_companies: PATCH update notes → 200 with matching audit row | status=200, row.notes updated, db_editor_audit update row before=null after="privtest co notes updated" | status=200 body.row.notes="privtest co notes updated" audit before.notes=null after.notes="privtest co notes updated" admin=privtest-admin-ybxmj2@privtest.local |
| PASS | [matrix] trade_companies: DELETE /api/admin/db/trade_companies/rows/2 → 200 | status=200 and body.ok=true | status=200 body={"ok":true} |
| PASS | [matrix] trade_companies: row is gone after DELETE (filtered GET) | rows[].length=0 for the deleted pk | status=200 matched=0 |
| PASS | [matrix] trade_company_contacts: GET /api/admin/db/trade_company_contacts/rows → 200 | status=200 with rows[] array | status=200 rows=1 |
| PASS | [matrix] trade_company_contacts: POST insert minimal row → 201 with pk | status=201 and row has pk columns (id) | status=201 body={"row":{"id":5,"company_id":3,"sort_order":0,"name":"privtest contact","role":null,"phone":null,"email":null,"preferred_contact":null}} |
| PASS | [matrix] trade_company_contacts: PATCH update name → 200 with matching audit row | status=200, row.name updated, db_editor_audit update row before="privtest contact" after="privtest contact updated" | status=200 body.row.name="privtest contact updated" audit before.name="privtest contact" after.name="privtest contact updated" admin=privtest-admin-ybxmj2@privtest.local |
| PASS | [matrix] trade_company_contacts: DELETE /api/admin/db/trade_company_contacts/rows/5 → 200 | status=200 and body.ok=true | status=200 body={"ok":true} |
| PASS | [matrix] trade_company_contacts: row is gone after DELETE (filtered GET) | rows[].length=0 for the deleted pk | status=200 matched=0 |
| PASS | [matrix] trade_company_submissions: GET /api/admin/db/trade_company_submissions/rows → 200 | status=200 with rows[] array | status=200 rows=1 |
| PASS | [matrix] trade_company_submissions: POST insert minimal row → 201 with pk | status=201 and row has pk columns (id) | status=201 body={"row":{"id":2,"company_name":"privtest sub","trade_type":"PRIVTEST","areas_served":null,"timescale":null,"invoice_method":null,"payment_terms":null,"notes":null,"contacts":[],"submitter_id":null,"submitter_email":null,"submitter_name":null |
| PASS | [matrix] trade_company_submissions: PATCH update notes → 200 with matching audit row | status=200, row.notes updated, db_editor_audit update row before=null after="privtest sub notes updated" | status=200 body.row.notes="privtest sub notes updated" audit before.notes=null after.notes="privtest sub notes updated" admin=privtest-admin-ybxmj2@privtest.local |
| PASS | [matrix] trade_company_submissions: DELETE /api/admin/db/trade_company_submissions/rows/2 → 200 | status=200 and body.ok=true | status=200 body={"ok":true} |
| PASS | [matrix] trade_company_submissions: row is gone after DELETE (filtered GET) | rows[].length=0 for the deleted pk | status=200 matched=0 |
| PASS | [matrix] trade_contacts: GET /api/admin/db/trade_contacts/rows → 200 | status=200 with rows[] array | status=200 rows=0 |
| PASS | [matrix] trade_contacts: POST insert minimal row → 201 with pk | status=201 and row has pk columns (id) | status=201 body={"row":{"id":1,"name":"privtest trade","trade_type":"PRIVTEST","phone":null,"email":null,"areas_served":null,"company_name":null,"timescale":null,"invoice_method":null,"payment_terms":null,"notes":null,"created_by":null,"created_at":"2026-0 |
| PASS | [matrix] trade_contacts: PATCH update notes → 200 with matching audit row | status=200, row.notes updated, db_editor_audit update row before=null after="privtest trade notes updated" | status=200 body.row.notes="privtest trade notes updated" audit before.notes=null after.notes="privtest trade notes updated" admin=privtest-admin-ybxmj2@privtest.local |
| PASS | [matrix] trade_contacts: DELETE /api/admin/db/trade_contacts/rows/1 → 200 | status=200 and body.ok=true | status=200 body={"ok":true} |
| PASS | [matrix] trade_contacts: row is gone after DELETE (filtered GET) | rows[].length=0 for the deleted pk | status=200 matched=0 |
| PASS | [matrix] visits: GET /api/admin/db/visits/rows → 200 | status=200 with rows[] array | status=200 rows=0 |
| PASS | [matrix] visits: POST insert minimal row → 201 with pk | status=201 and row has pk columns (id) | status=201 body={"row":{"id":1,"created_by":"privtest","customer_id":null,"customer_name":null,"type":"other","title":null,"start_at":"2099-01-01T00:00:00.000Z","end_at":"2099-01-01T01:00:00.000Z","is_workshop":false,"notes":null,"location":null,"google_ev |
| PASS | [matrix] visits: PATCH update notes → 200 with matching audit row | status=200, row.notes updated, db_editor_audit update row before=null after="privtest visit notes updated" | status=200 body.row.notes="privtest visit notes updated" audit before.notes=null after.notes="privtest visit notes updated" admin=privtest-admin-ybxmj2@privtest.local |
| PASS | [matrix] visits: DELETE /api/admin/db/visits/rows/1 → 200 | status=200 and body.ok=true | status=200 body={"ok":true} |
| PASS | [matrix] visits: row is gone after DELETE (filtered GET) | rows[].length=0 for the deleted pk | status=200 matched=0 |
| PASS | [matrix] whatsapp_messages: GET /api/admin/db/whatsapp_messages/rows → 200 | status=200 with rows[] array | status=200 rows=0 |
| PASS | [matrix] whatsapp_messages: POST insert minimal row → 201 with pk | status=201 and row has pk columns (id) | status=201 body={"row":{"id":1,"contact_id":"PRIVTEST","sender_user_id":"229be567-9bbf-4f6e-9766-3832b261c1b0","mode":"freeform","template_name":null,"message_text":"privtest msg","sent_at":"2026-05-25T08:33:16.199Z","template_params":null}} |
| PASS | [matrix] whatsapp_messages: PATCH update message_text → 200 with matching audit row | status=200, row.message_text updated, db_editor_audit update row before="privtest msg" after="privtest msg updated" | status=200 body.row.message_text="privtest msg updated" audit before.message_text="privtest msg" after.message_text="privtest msg updated" admin=privtest-admin-ybxmj2@privtest.local |
| PASS | [matrix] whatsapp_messages: DELETE /api/admin/db/whatsapp_messages/rows/1 → 200 | status=200 and body.ok=true | status=200 body={"ok":true} |
| PASS | [matrix] whatsapp_messages: row is gone after DELETE (filtered GET) | rows[].length=0 for the deleted pk | status=200 matched=0 |
| PASS | [matrix] workshop_settings: GET /api/admin/db/workshop_settings/rows → 200 | status=200 with rows[] array | status=200 rows=2 |
| PASS | [matrix] workshop_settings: POST insert minimal row → 201 with pk | status=201 and row has pk columns (key) | status=201 body={"row":{"key":"PRIVTEST_WS_ybxmj2","label":"privtest ws","value":"x","updated_at":"2026-05-25T08:33:16.255Z","updated_by":null}} |
| PASS | [matrix] workshop_settings: PATCH update label → 200 with matching audit row | status=200, row.label updated, db_editor_audit update row before="privtest ws" after="privtest ws updated" | status=200 body.row.label="privtest ws updated" audit before.label="privtest ws" after.label="privtest ws updated" admin=privtest-admin-ybxmj2@privtest.local |
| PASS | [matrix] workshop_settings: DELETE /api/admin/db/workshop_settings/rows/PRIVTEST_WS_ybxmj2 → 200 | status=200 and body.ok=true | status=200 body={"ok":true} |
| PASS | [matrix] workshop_settings: row is gone after DELETE (filtered GET) | rows[].length=0 for the deleted pk | status=200 matched=0 |

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
- **(e) Per-table smoke matrix**: walks every entry in `db-editor.js`
  `TABLES`. For each allow-listed table the suite issues
  `GET /api/admin/db/<table>/rows` and asserts 200. For non-read-only
  tables it also performs a minimal insert, a minimal PATCH update on a
  safe column declared by the fixture, and the corresponding delete
  (including parent-row chains for FK-bearing children and the
  `pk1|pk2` segment for composite primary keys), then verifies the row
  is gone via a filtered GET. Every update probe also asserts that a
  matching `db_editor_audit` row of op=`update` was written with the
  acting admin email and before/after JSON for the changed column, so
  NOT NULL / type / FK regressions on the PATCH path are caught per
  table. New tables added to the allow-list without a fixture surface
  as an explicit failure so schema drift is caught.

## Per-table matrix

| Table | GET rows | Insert | Update | Delete | Notes |
|---|---|---|---|---|---|
| `app_settings` | PASS | PASS | PASS | PASS |  |
| `card_action_handler_bindings` | PASS | PASS | PASS | PASS |  |
| `card_action_handlers` | PASS | PASS | PASS | PASS |  |
| `design_visit_door_styles` | PASS | PASS | PASS | PASS |  |
| `design_visit_furniture_ranges` | PASS | PASS | PASS | PASS |  |
| `design_visit_handles` | PASS | PASS | PASS | PASS |  |
| `design_visit_room_images` | PASS | PASS | PASS | PASS |  |
| `design_visit_rooms` | PASS | PASS | PASS | PASS |  |
| `design_visits` | PASS | PASS | PASS | PASS |  |
| `idea_comments` | PASS | PASS | PASS | PASS |  |
| `ideas` | PASS | PASS | PASS | PASS |  |
| `job_roles` | PASS | PASS | PASS | PASS |  |
| `lead_status_config` | PASS | PASS | PASS | PASS |  |
| `lead_substatuses` | PASS | PASS | PASS | PASS |  |
| `search_settings` | PASS | PASS | PASS | PASS |  |
| `stage_action_labels` | PASS | PASS | PASS | PASS |  |
| `terms_conditions_versions` | PASS | PASS | PASS | PASS |  |
| `trade_audit_log` | PASS | skip (read-only) | skip (read-only) | skip (read-only) |  |
| `trade_companies` | PASS | PASS | PASS | PASS |  |
| `trade_company_contacts` | PASS | PASS | PASS | PASS |  |
| `trade_company_submissions` | PASS | PASS | PASS | PASS |  |
| `trade_contacts` | PASS | PASS | PASS | PASS |  |
| `visits` | PASS | PASS | PASS | PASS |  |
| `whatsapp_messages` | PASS | PASS | PASS | PASS |  |
| `workshop_settings` | PASS | PASS | PASS | PASS |  |

## Notes

- The test server is booted via the shared privileges harness with the
  same env-stripping defaults (no HUBSPOT_TOKEN, SMTP, Google or QB
  credentials). The db-editor surface depends only on PostgreSQL so this
  has no effect on the probes.
- All synthetic rows are namespaced behind the `privtest-` / `PRIVTEST_`
  prefix and the fixture row is cleaned up on exit (along with any audit
  rows that reference it).