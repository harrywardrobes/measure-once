# design-visit submitter-name findings

Run: 2026-05-25T08:54:17.392Z
Result: PASS (9/9)

| ID | Result | Detail |
|----|--------|--------|
| submit | PASS | submit returned 200 |
| NOTE.designer-line | PASS | note body contained "Designer: privtest-member-uf4ft0@privtest.local" |
| TEAM-TEXT.submitter-line | PASS | text contained "Design visit submitted by privtest-member-uf4ft0@privtest.local" |
| TEAM-HTML.submitter-line | PASS | html contained "Submitted by <strong>privtest-member-uf4ft0@privtest.local</strong>" |
| CUST-GREET.first-name | PASS | customer email greeted "Hi PrivTest," |
| CUST-ROOM.room-name | PASS | customer email listed the seeded "Kitchen" room in text + html |
| CUST-LINK.sign-off-url | PASS | customer email contained the sign-off URL in text + html |
| SIGNOFF-APPROVE.team-email | PASS | approve team email contained "PrivTest DV Name Contact has approved and signed off their design visit (#1)." |
| SIGNOFF-REVISION.team-email | PASS | revision team email contained "PrivTest DV Name Contact has requested changes to design visit #2." + "Note: please change door colour uf4ft0" |
