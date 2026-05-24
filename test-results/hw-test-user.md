# hw-test-user test results

**27 probes — 27 passed — 0 failed**

| Result | Probe | Expected | Observed |
|--------|-------|----------|----------|
| ✓ | PRE-01: POST /api/admin/test/seed-contacts-cache reachable for admin (dev mode) | status=200 ok=true | status=200 ok=true |
| ✓ | PRE-02: GET /api/admin/hubspot/dev-mode returns devMode=true in dev | status=200 devMode=true | status=200 devMode=true |
| ✓ | DEV-MODE-01: non-admin GET /api/admin/hubspot/dev-mode is blocked | status=403 (or 401/302) | status=403 |
| ✓ | FILTER-A-01: /api/contacts-all responds 200 in dev (mock HubSpot active) | status=200 | status=200 |
| ✓ | FILTER-A-02: flagged contact mock-1 is present in /api/contacts-all | id=mock-1 in results | ids=[mock-1,mock-4] |
| ✓ | FILTER-A-02: flagged contact mock-4 is present in /api/contacts-all | id=mock-4 in results | ids=[mock-1,mock-4] |
| ✓ | FILTER-A-03: unflagged contact mock-2 is absent from /api/contacts-all | id=mock-2 NOT in results | ids=[mock-1,mock-4] |
| ✓ | FILTER-A-03: unflagged contact mock-3 is absent from /api/contacts-all | id=mock-3 NOT in results | ids=[mock-1,mock-4] |
| ✓ | FILTER-A-04: admin ?all=1 bypass responds 200 | status=200 | status=200 |
| ✓ | FILTER-A-05: admin ?all=1 includes unflagged contact mock-2 | id=mock-2 in bypass results | ids=[mock-1,mock-2,mock-3,mock-4] |
| ✓ | FILTER-A-05: admin ?all=1 includes unflagged contact mock-3 | id=mock-3 in bypass results | ids=[mock-1,mock-2,mock-3,mock-4] |
| ✓ | FILTER-A-06: member ?all=1 bypass is ignored — unflagged mock-2 still absent | id=mock-2 NOT in member results | ids=[mock-1,mock-4] |
| ✓ | FILTER-A-06: member ?all=1 bypass is ignored — unflagged mock-3 still absent | id=mock-3 NOT in member results | ids=[mock-1,mock-4] |
| ✓ | FILTER-B-01: /api/open-leads responds 200 in dev (mock HubSpot active) | status=200 | status=200 |
| ✓ | FILTER-B-02: flagged OPEN_DEAL contact mock-1 present in /api/open-leads | id=mock-1 in results | ids=[mock-1] |
| ✓ | FILTER-B-03: unflagged OPEN_DEAL contact mock-2 absent from /api/open-leads | id=mock-2 NOT in results | ids=[mock-1] |
| ✓ | FILTER-C-01: /api/contacts-lead-status-counts responds 200 in dev | status=200 | status=200 |
| ✓ | FILTER-C-02: OPEN_DEAL count=1 in dev mode (only flagged mock-1 counted, not unflagged mock-2) | counts[OPEN_DEAL] === 1 | counts[OPEN_DEAL]=1 |
| ✓ | FILTER-C-03: count for unique key privtest_hwtu_lsc_ub478b is 0 | counts[privtest_hwtu_lsc_ub478b] === 0 | counts[privtest_hwtu_lsc_ub478b]=0 |
| ✓ | PRIV-01: member PATCH /api/admin/hubspot/test-users/:id blocked | status=403 (or 401/302) | status=403 |
| ✓ | PRIV-02: unauthenticated PATCH /api/admin/hubspot/test-users/:id blocked | status=401/403/302 | status=401 |
| ✓ | NEG-01: PATCH with non-numeric contactId returns 400 | status=400 | status=400 error="Invalid contact id." |
| ✓ | NEG-02: PATCH with missing `enabled` returns 400 | status=400 | status=400 error="`enabled` must be a boolean." |
| ✓ | NEG-03: PATCH with string `enabled` returns 400 | status=400 | status=400 error="`enabled` must be a boolean." |
| ✓ | PROD-01: PATCH /api/admin/hubspot/test-users/:id returns 404 in production | status=404 | status=404 |
| ✓ | PROD-02: POST /api/admin/test/seed-contacts-cache returns 404 in production | status=404 | status=404 |
| ✓ | PROD-03: GET /api/admin/hubspot/dev-mode returns devMode=false in production | status=200 devMode=false | status=200 devMode=false |