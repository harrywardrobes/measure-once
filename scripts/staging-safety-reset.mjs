#!/usr/bin/env node
// scripts/staging-safety-reset.mjs
//
// Run this against the STAGING database immediately after every clone/refresh
// from production data. Staging runs LIVE integrations (HubSpot / QuickBooks /
// SMTP) against the same portal, QB company, and mailbox as production, so a
// raw clone of prod is NOT safe to boot as-is. This script makes it safe:
//
//   1. Forces `dev_mode_enabled = 'true'` in app_settings. Dev mode confines the
//      contacts the app shows to those flagged `hw_test_user='true'` in HubSpot,
//      so staging testing only touches test contacts. A prod clone has dev mode
//      OFF — this turns it back on. (Dev mode is a DISPLAY filter, not a hard
//      write guard: stay safe by only acting on the test contacts it shows.)
//
//   2. Clears `qb_tokens`. QuickBooks refresh tokens ROTATE on every refresh and
//      there is a single token row. If staging reused prod's cloned QB token and
//      refreshed it, Intuit would invalidate prod's copy and BREAK PRODUCTION's
//      QuickBooks connection. Clearing forces staging to connect QB on its own
//      (with the staging redirect URI) — a separate authorization.
//
//   3. Clears `google_oauth_tokens` for the same reason (separate Google
//      authorization for the staging redirect URI; avoids sharing prod's tokens).
//
//   4. Truncates `sessions` so cloned production login sessions do not carry over.
//
// Usage:
//   STAGING_DATABASE_URL=postgres://... npm run staging:safety-reset
//
// Safety guard: refuses to run unless the target database name contains
// "staging" (so it can never be pointed at the production DB by mistake).
// Override only if you really know what you are doing: STAGING_RESET_FORCE=1.

import process from 'process';

const url = process.env.STAGING_DATABASE_URL;
if (!url) {
  console.error('✗ STAGING_DATABASE_URL is required.');
  process.exit(1);
}

// Guard: the target must look like a staging DB unless explicitly forced.
let dbName = '';
try {
  dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, '')) || '';
} catch {
  // Socket-form URLs (postgres://user@/db?host=/cloudsql/...) don't parse as a
  // standard URL; fall back to a regex on the path segment.
  const m = url.match(/@[^/]*\/([^?]+)/);
  dbName = m ? m[1] : '';
}
if (!/staging/i.test(dbName) && process.env.STAGING_RESET_FORCE !== '1') {
  console.error(
    `✗ Refusing to run: target database "${dbName || '(unknown)'}" does not ` +
    `contain "staging".\n  This script clears QB/Google tokens and sessions and ` +
    `forces dev mode ON —\n  running it against production would be destructive.\n` +
    `  If you are certain, set STAGING_RESET_FORCE=1.`
  );
  process.exit(1);
}

const { default: pg } = await import('pg');
const { Client } = pg;
const client = new Client({ connectionString: url });

const SQL_DEV_MODE = `
  INSERT INTO app_settings (key, value) VALUES ('dev_mode_enabled', 'true')
  ON CONFLICT (key) DO UPDATE SET value = 'true'
`;

async function tableExists(name) {
  const { rows } = await client.query('SELECT to_regclass($1) AS reg', [name]);
  return rows[0].reg !== null;
}

async function main() {
  await client.connect();
  console.log(`Connected to staging DB "${dbName}". Applying safety reset…\n`);

  await client.query('BEGIN');
  try {
    await client.query(SQL_DEV_MODE);
    console.log('  ✓ dev_mode_enabled = true');

    for (const t of ['qb_tokens', 'google_oauth_tokens']) {
      if (await tableExists(t)) {
        const r = await client.query(`DELETE FROM ${t}`);
        console.log(`  ✓ cleared ${t} (${r.rowCount} row(s))`);
      } else {
        console.log(`  • ${t} not present — skipped`);
      }
    }

    if (await tableExists('sessions')) {
      await client.query('TRUNCATE sessions');
      console.log('  ✓ truncated sessions');
    } else {
      console.log('  • sessions not present — skipped');
    }

    await client.query('COMMIT');
    console.log('\n✓ Safety reset complete. Staging is safe to boot.');
    console.log('  Next: in the staging admin panel, confirm dev mode is ON, then');
    console.log('  re-connect QuickBooks and Google (their tokens were cleared).');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('\n✗ Safety reset failed:', err.message);
  process.exit(1);
});
