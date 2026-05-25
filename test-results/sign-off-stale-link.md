# Sign-off stale-link E2E report

Run timestamp: 2026-05-25T08:29:57.134Z

Covers the "superseded" sign-off path: after a designer
re-opens a submitted design visit (PUT /api/design-visits/:id)
or re-runs the submit pipeline (POST /:id/revision +
POST /:id/submit), the old customer-facing sign-off link must
still load (200, status="superseded") and any sign-off attempts
via that stale link must be rejected with 409 status="superseded".
Genuinely unknown tokens continue to return 404.

**Summary:** 14/14 probes passed

| ✓ | Probe | Expected | Observed |
|---|-------|----------|----------|
| ✓ | [PUT] PUT /api/design-visits/:id returns ok=true | status=200, ok=true, designVisitId matches | status=200 ok=true id=5 |
| ✓ | [PUT] old token hash moves into superseded_signoff_token_hashes | old hash present in superseded array AND signoff_token_hash differs | superseded=["174b29fb985e3c22d8f4cfbb0f1d2ae8ec4d9d61180813f03836b39db032906c"] new=8b0d4b3f7ae96481d12b6429faa3ab76520e41fd6c76100ff2cab13758c1856f |
| ✓ | [PUT-B] GET /sign-off/:oldToken returns 200 status="superseded" + visit summary | status=200, body.status="superseded", body.id matches, rooms is an array | status=200 bodyStatus=superseded id=5 rooms=1 |
| ✓ | [PUT-C] POST /sign-off/:oldToken {action:"approve"} returns 409 status="superseded" | status=409, body.status="superseded" | status=409 bodyStatus=superseded |
| ✓ | [PUT-D] POST /sign-off/:oldToken {action:"revision"} returns 409 status="superseded" | status=409, body.status="superseded" | status=409 bodyStatus=superseded |
| ✓ | [PUT] visit status is back to "submitted" after PUT side-effects | status=submitted | status=submitted |
| ✓ | [RES] POST /:id/revision flips visit to revision_requested | status=200, success=true | status=200 success=true |
| ✓ | [RES] POST /:id/submit re-runs the side-effect chain | status=200, ok=true | status=200 ok=true |
| ✓ | [RES] old token hash present in superseded_signoff_token_hashes after revision+submit | old hash in superseded array AND signoff_token_hash differs | superseded=["2bdf7097dcd313e87dce364aa025c8ba2306c2d2e38898c3d3b339544b54305a"] new=bfc84c2336b62ae6d306c04d143f5cf0a8ced910f6baca95f21f56eb63367cfb |
| ✓ | [RES-B] GET /sign-off/:oldToken returns 200 status="superseded" + visit summary | status=200, body.status="superseded", body.id matches | status=200 bodyStatus=superseded id=6 |
| ✓ | [RES-C] POST /sign-off/:oldToken {action:"approve"} returns 409 status="superseded" | status=409, body.status="superseded" | status=409 bodyStatus=superseded |
| ✓ | [RES-D] POST /sign-off/:oldToken {action:"revision"} returns 409 status="superseded" | status=409, body.status="superseded" | status=409 bodyStatus=superseded |
| ✓ | [UNK-A] GET /sign-off/:unknownToken returns 404 | status=404 | status=404 bodyStatus= |
| ✓ | [UNK-B] POST /sign-off/:unknownToken returns 404 | status=404 | status=404 bodyStatus= |
