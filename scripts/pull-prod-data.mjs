#!/usr/bin/env node
// scripts/pull-prod-data.mjs
//
// Pulls configuration and reference data from the production database into
// local dev or staging. Uses upsert (INSERT ON CONFLICT DO UPDATE) so it is
// safe to run repeatedly — existing rows are updated in place, not replaced.
//
// Prerequisites:
//   1. Cloud SQL Auth Proxy running on port 15432:
//        cloud-sql-proxy.exe --port 15432 harry-wardrobes:europe-west2:harry-wardrobes-db
//   2. PROD_DATABASE_URL set in .env  (see .env.example)
//   3. DATABASE_URL set in .env       (local dev postgres)
//   4. STAGING_DATABASE_URL set in .env (staging via proxy)
//
// Usage:
//   npm run db:pull                        — interactive (prompts for target + optional tables)
//   npm run db:pull -- --local             — local dev only, no prompts
//   npm run db:pull -- --staging           — staging only, no prompts
//   npm run db:pull -- --local --staging   — both, no prompts
//   npm run db:pull -- --dry-run           — show row counts only, no writes

import process from 'process';
import { createInterface } from 'readline';

// ── Config/reference tables — pulled on every run (no customer PII) ──────────
// Ordered parent-before-child to satisfy FK constraints on first pull.
const CONFIG_TABLES = [
  // Team (no deps)
  'users',
  'allowed_emails',
  'job_roles',
  'terms_conditions_versions',
  // Depend on job_roles
  'role_permissions',
  'nav_role_configs',
  // Lead workflow
  'lead_status_config',
  'lead_substatuses',             // → lead_status_config
  'stage_action_labels',          // → lead_status_config
  // Card actions
  'card_action_handlers',
  'card_action_handler_bindings', // → card_action_handlers
  // Standalone settings
  'email_templates',
  'admin_settings',
  'app_settings',
  'search_settings',
  'page_filter_config',
  'workshop_settings',
  'qb_settings',
  // Design visit reference (standalone)
  'design_visit_handles',
  'design_visit_furniture_ranges',
  'design_visit_door_styles',
  // Product catalog (base before dependents)
  'catalog_ranges',
  'catalog_door_suppliers',
  'catalog_handle_suppliers',
  'catalog_finishes',
  'catalog_doors',                // → catalog_ranges, catalog_door_suppliers, catalog_finishes
  'catalog_handles',              // → catalog_handle_suppliers
  'catalog_pairings',             // → catalog_doors, catalog_handles, catalog_finishes
  // Questionnaire
  'visit_questions',
];

// ── Optional table groups — user selects interactively each run ───────────────
const OPTIONAL_GROUPS = [
  {
    key: 'T',
    label: 'Trades',
    description: 'trade_companies, trade_company_contacts, trade_contacts',
    tables: ['trade_companies', 'trade_company_contacts', 'trade_contacts'],
  },
  {
    key: 'I',
    label: 'Ideas',
    description: 'ideas, idea_comments, idea_votes',
    tables: ['ideas', 'idea_comments', 'idea_votes'],
  },
  {
    key: 'C',
    label: 'Customer data',
    description: 'design_visits, design_visit_rooms, survey_visits, survey_visit_rooms, visits,\n' +
                 '                       customer_info_submissions, whatsapp_messages, visit_answers',
    tables: [
      'design_visits',
      'design_visit_rooms',
      'survey_visits',
      'survey_visit_rooms',
      'visits',
      'customer_info_submissions',
      'whatsapp_messages',
      'visit_answers',             // → visit_questions (config, pulled first)
    ],
  },
  {
    key: 'F',
    label: 'Finance',
    description: 'open_deal_invoices, open_deal_declines',
    tables: ['open_deal_invoices', 'open_deal_declines'],
  },
];

// Intentionally never pulled:
//   sessions, password_set_tokens          — ephemeral, environment-specific
//   qb_tokens, google_oauth_tokens         — OAuth tokens that rotate; staging re-connects its own
//   admin_audit_log, db_editor_audit       — operational logs
//   design_visit_room_images, survey_visit_room_images — GCS object paths; useless without the bucket
//   design_visit_pending_uploads, survey_visit_pending_uploads
//   contact_attempt_tracking, contact_attempt_log, contact_attempt_history_log
//   customer_info_resend_log, photo_review_outcomes
//   google_maps_usage, substatus_clear_failures
//   bootstrap_admin_emails, trade_company_submissions, trade_audit_log

// ── Helpers ───────────────────────────────────────────────────────────────────

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function maskUrl(url) {
  return url.replace(/:[^:@]+@/, ':***@');
}

async function tableExists(client, table) {
  const { rows } = await client.query(
    `SELECT to_regclass('public.' || $1) AS reg`,
    [table]
  );
  return rows[0].reg !== null;
}

async function getPrimaryKeyCols(client, table) {
  const { rows } = await client.query(
    `SELECT kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema    = kcu.table_schema
     WHERE tc.constraint_type = 'PRIMARY KEY'
       AND tc.table_name      = $1
       AND tc.table_schema    = 'public'
     ORDER BY kcu.ordinal_position`,
    [table]
  );
  return rows.map((r) => r.column_name);
}

async function pullTable(srcClient, dstClient, table, dryRun) {
  if (!await tableExists(srcClient, table)) {
    return { table, skipped: 'not in source' };
  }
  if (!await tableExists(dstClient, table)) {
    return { table, skipped: 'not in target (run migrations first?)' };
  }

  const { rows, fields } = await srcClient.query(`SELECT * FROM "${table}"`);
  const cols = fields.map((f) => f.name);

  if (dryRun) return { table, rows: rows.length, dryRun: true };
  if (rows.length === 0) return { table, rows: 0 };

  const pkCols = await getPrimaryKeyCols(dstClient, table);
  const colList = cols.map((c) => `"${c}"`).join(', ');
  const nonPkCols = cols.filter((c) => !pkCols.includes(c));

  if (pkCols.length > 0) {
    const pkConflict = pkCols.map((c) => `"${c}"`).join(', ');
    const updateClause = nonPkCols.length > 0
      ? `DO UPDATE SET ${nonPkCols.map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ')}`
      : 'DO NOTHING';

    for (const row of rows) {
      const values = cols.map((c) => row[c]);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      await dstClient.query(
        `INSERT INTO "${table}" (${colList}) VALUES (${placeholders}) ON CONFLICT (${pkConflict}) ${updateClause}`,
        values
      );
    }

    // Advance any serial sequence so new inserts don't collide with pulled ids.
    if (pkCols.length === 1) {
      try {
        await dstClient.query(
          `SELECT setval(
             pg_get_serial_sequence('"${table}"', '${pkCols[0]}'),
             COALESCE((SELECT MAX("${pkCols[0]}") FROM "${table}"), 1)
           )`
        );
      } catch { /* UUID or non-serial PK — no sequence to advance */ }
    }
  } else {
    // No primary key — truncate and re-insert (only small lookup tables hit this).
    await dstClient.query(`TRUNCATE "${table}"`);
    for (const row of rows) {
      const values = cols.map((c) => row[c]);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      await dstClient.query(
        `INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`,
        values
      );
    }
  }

  return { table, rows: rows.length };
}

async function applyStagingSafetyReset(stagingUrl) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: stagingUrl });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO app_settings (key, value) VALUES ('dev_mode_enabled', 'true')
       ON CONFLICT (key) DO UPDATE SET value = 'true'`
    );
  } finally {
    await client.end();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const forceLocal = argv.includes('--local');
  const forceStaging = argv.includes('--staging');

  const prodUrl = process.env.PROD_DATABASE_URL;
  if (!prodUrl) {
    console.error('✗ PROD_DATABASE_URL is not set.');
    console.error('  Add it to .env — see .env.example for the format.');
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // ── Determine target(s) ───────────────────────────────────────────────────
  const targets = [];

  if (forceLocal || forceStaging) {
    if (forceLocal)   targets.push({ label: 'local dev', url: process.env.DATABASE_URL,         isStaging: false });
    if (forceStaging) targets.push({ label: 'staging',   url: process.env.STAGING_DATABASE_URL, isStaging: true  });
  } else {
    console.log('\nTarget database(s):');
    console.log('  L — Local dev   (DATABASE_URL)');
    console.log('  S — Staging     (STAGING_DATABASE_URL)');
    console.log('  B — Both');
    const ans = (await ask(rl, '\nSelect [L/S/B]: ')).trim().toUpperCase();
    if (ans === 'L' || ans === 'B') targets.push({ label: 'local dev', url: process.env.DATABASE_URL,         isStaging: false });
    if (ans === 'S' || ans === 'B') targets.push({ label: 'staging',   url: process.env.STAGING_DATABASE_URL, isStaging: true  });
    if (!targets.length) { console.log('Cancelled.'); rl.close(); return; }
  }

  for (const t of targets) {
    const envKey = t.isStaging ? 'STAGING_DATABASE_URL' : 'DATABASE_URL';
    if (!t.url) {
      console.error(`✗ ${envKey} is not set.`);
      rl.close();
      process.exit(1);
    }
    if (t.isStaging && !/staging/i.test(t.url)) {
      console.error('✗ STAGING_DATABASE_URL does not contain "staging" — refusing to run as a safety guard.');
      rl.close();
      process.exit(1);
    }
  }

  // ── Optional table groups ─────────────────────────────────────────────────
  console.log('\nOptional table groups (press Enter to skip all):');
  for (const g of OPTIONAL_GROUPS) {
    console.log(`  [${g.key}] ${g.label.padEnd(16)} ${g.description}`);
  }
  const groupInput = (
    await ask(rl, `\nGroups [${OPTIONAL_GROUPS.map((g) => g.key).join(',')}] or Enter to skip: `)
  ).trim().toUpperCase();
  rl.close();

  const selectedGroups = OPTIONAL_GROUPS.filter((g) => groupInput.includes(g.key));
  const optionalTables = selectedGroups.flatMap((g) => g.tables);
  const allTables = [...CONFIG_TABLES, ...optionalTables];

  // ── Pre-flight summary ────────────────────────────────────────────────────
  console.log('\n──────────────────────────────────────────────────────────');
  if (dryRun) console.log('  DRY RUN — no data will be written\n');
  console.log(`  Source:  production  (${maskUrl(prodUrl)})`);
  for (const t of targets) console.log(`  Target:  ${t.label.padEnd(10)} (${maskUrl(t.url)})`);
  console.log(
    `  Tables:  ${CONFIG_TABLES.length} config` +
    (optionalTables.length
      ? ` + ${optionalTables.length} optional (${selectedGroups.map((g) => g.label).join(', ')})`
      : '') +
    ` = ${allTables.length} total`
  );
  console.log('──────────────────────────────────────────────────────────\n');

  // ── Connect to production ─────────────────────────────────────────────────
  const { default: pg } = await import('pg');
  const srcClient = new pg.Client({ connectionString: prodUrl });
  try {
    await srcClient.connect();
    console.log('✓ Connected to production\n');
  } catch (err) {
    console.error('✗ Cannot connect to production:', err.message);
    console.error('  Is cloud-sql-proxy.exe running on port 15432?');
    process.exit(1);
  }

  // ── Pull to each target ───────────────────────────────────────────────────
  for (const target of targets) {
    console.log(`── Pulling to ${target.label} ────────────────────────────────`);

    const dstClient = new pg.Client({ connectionString: target.url });
    try {
      await dstClient.connect();
    } catch (err) {
      console.error(`✗ Cannot connect to ${target.label}:`, err.message);
      continue;
    }

    await dstClient.query('BEGIN');

    // Defer FK constraint checks to end of transaction where possible.
    // Non-deferrable constraints still fire immediately — table order above handles those.
    try {
      await dstClient.query('SET CONSTRAINTS ALL DEFERRED');
    } catch { /* not all constraints are deferrable — that's fine */ }

    try {
      for (const table of allTables) {
        const r = await pullTable(srcClient, dstClient, table, dryRun);
        const icon   = r.skipped ? '·' : r.dryRun ? '~' : '✓';
        const detail = r.skipped
          ? `skipped (${r.skipped})`
          : r.dryRun
          ? `${r.rows} rows (dry run)`
          : `${r.rows} rows`;
        console.log(`  ${icon} ${table.padEnd(40)} ${detail}`);
      }

      await dstClient.query('COMMIT');
      console.log(`\n✓ ${target.label} — pull complete`);
    } catch (err) {
      await dstClient.query('ROLLBACK');
      console.error(`\n✗ ${target.label} — failed:`, err.message);
    } finally {
      await dstClient.end();
    }

    // After pulling to staging, force dev_mode_enabled = true.
    // qb_tokens and google_oauth_tokens are never pulled, so re-connection
    // of QuickBooks and Google in the staging admin panel will be needed.
    if (target.isStaging && !dryRun) {
      try {
        await applyStagingSafetyReset(target.url);
        console.log('\n✓ Staging safety applied (dev_mode_enabled = true)');
      } catch (err) {
        console.warn('\n⚠ Staging safety reset failed:', err.message);
        console.warn('  Run `npm run staging:safety-reset` manually before booting staging.');
      }
      console.log('  Note: qb_tokens and google_oauth_tokens were not pulled.');
      console.log('  Re-connect QuickBooks and Google in the staging admin panel if needed.\n');
    }
  }

  await srcClient.end();
  console.log('\n✓ Done.');
}

main().catch((err) => {
  console.error('\n✗ Fatal error:', err.message);
  process.exit(1);
});
