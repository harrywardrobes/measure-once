#!/usr/bin/env node
'use strict';
// scripts/test-hw-test-user-live.js
//
// Convenience wrapper around `node test/hw-test-user/run.js` that opts the
// [REAL-HS] phase into running against a live HubSpot account. Performs a
// fast pre-flight ping of HubSpot's /account-info/v3/details so an invalid
// token fails immediately with a clear message instead of midway through the
// real-HubSpot probes.
//
// Usage:
//   HUBSPOT_TOKEN=… DATABASE_URL_TEST=<disposable> \
//     npm run test:hw-test-user:live
//
//   # or against the shared DB (synthetic rows still namespaced + cleaned up):
//   HUBSPOT_TOKEN=… PRIVTEST_ALLOW_SHARED_DB=1 \
//     npm run test:hw-test-user:live
//
// What it does:
//   • Asserts HUBSPOT_TOKEN is set (otherwise refuses to spawn the runner).
//   • Sends GET https://api.hubapi.com/account-info/v3/details with the
//     token; bails out non-zero on 401/403 or network failure.
//   • Forwards PRIVTEST_USE_HUBSPOT_TOKEN=1 and the existing HUBSPOT_TOKEN
//     to `node test/hw-test-user/run.js`.
//
// Note: the [REAL-HS] phase briefly toggles `app_settings.dev_filter_enabled`
// off and back on to compare filtered vs. unfiltered lead-status counts. It
// restores the flag to ON on exit, but a crash mid-run can leave it OFF —
// re-running the test (or flipping the toggle in the admin panel) restores
// the expected state.

require('dotenv').config();

const { spawn } = require('child_process');
const path = require('path');

async function preflight(token) {
  const url = 'https://api.hubapi.com/account-info/v3/details';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `HubSpot rejected the token (status=${res.status}). ` +
        `Check that HUBSPOT_TOKEN is a valid private-app token with CRM read scopes. ` +
        `Response: ${body.slice(0, 200)}`,
      );
    }
    if (!res.ok) {
      throw new Error(`HubSpot /account-info/v3/details returned status=${res.status}`);
    }
    const json = await res.json().catch(() => ({}));
    console.log(
      `[pre-flight] HubSpot token OK ` +
      `(portalId=${json.portalId ?? '?'} accountType=${json.accountType ?? '?'})`,
    );
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error('HubSpot pre-flight timed out after 10s');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) {
    console.error(
      'FATAL: HUBSPOT_TOKEN is not set. The live HubSpot smoke run cannot ' +
      'proceed without a real private-app token. Set HUBSPOT_TOKEN and re-run, ' +
      'or use `npm run test:hw-test-user` for the mock-only suite.',
    );
    process.exit(2);
  }

  try {
    await preflight(token);
  } catch (e) {
    console.error(`FATAL: HubSpot pre-flight failed — ${e.message}`);
    process.exit(2);
  }

  const runner = path.join(__dirname, '..', 'test', 'hw-test-user', 'run.js');
  const child = spawn(process.execPath, [runner], {
    stdio: 'inherit',
    env: {
      ...process.env,
      PRIVTEST_USE_HUBSPOT_TOKEN: '1',
      HUBSPOT_TOKEN: token,
    },
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      console.error(`Runner exited via signal ${signal}`);
      process.exit(1);
    }
    process.exit(code ?? 0);
  });
})();
