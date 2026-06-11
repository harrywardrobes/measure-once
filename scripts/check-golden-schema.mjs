#!/usr/bin/env node
/**
 * scripts/check-golden-schema.mjs
 *
 * Schema diff check: applies all migrations to a fresh temporary PostgreSQL
 * database (the "golden" schema) and diffs tables, columns, indexes, and
 * constraints against the live DATABASE_URL.
 *
 * Fails CI if:
 *   - The dev DB contains objects not produced by any migration (orphaned).
 *   - The dev DB is missing objects that migrations produce (unapplied migration).
 *
 * Motivation: the `lead_status_config_shorthand_uniq` index survived in the
 * dev DB because its drop-column migration was still pending.  A check like
 * this would have caught it before it reached production.
 *
 * Run via:   npm run test:golden-schema
 *
 * Exclusions
 * ──────────
 * Internal tables skipped in both DBs:
 *   pgmigrations          — node-pg-migrate bookkeeping table
 *   migrations            — @acpr/rate-limit-postgresql bookkeeping table
 *
 * Known legacy-orphan objects that exist in long-lived dev DBs but are NOT
 * created by any migration (expected "extra in dev" items — not a failure):
 *   table  db_editor_audit               — removed feature
 *   column app_settings.updated_at       — leftover from removed code
 *
 * To suppress additional local-dev orphans without editing this file set:
 *   GOLDEN_SCHEMA_SKIP_TABLES=table1,table2
 *   GOLDEN_SCHEMA_SKIP_COLUMNS=table.col1,table.col2
 *   GOLDEN_SCHEMA_SKIP_INDEXES=idxname1,idxname2
 *   GOLDEN_SCHEMA_SKIP_CONSTRAINTS=table1.cname1,table2.cname2  (table-qualified)
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { join }          from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import crypto            from 'crypto';

const require = createRequire(import.meta.url);
const { Client }         = require('pg');
const { runMigrations }  = require('../db-migrate');

const ROOT         = fileURLToPath(new URL('..', import.meta.url));
const RESULTS_DIR  = join(ROOT, 'test-results');
mkdirSync(RESULTS_DIR, { recursive: true });

// ─── Exclusion lists ──────────────────────────────────────────────────────────

const INTERNAL_TABLES = new Set(['pgmigrations', 'migrations']);

const SKIP_TABLES = new Set([
  'db_editor_audit',  // legacy orphan — removed feature, no migration
  ...parseEnvList('GOLDEN_SCHEMA_SKIP_TABLES'),
]);

const SKIP_COLUMNS = new Set([
  'app_settings.updated_at',  // legacy orphan column — removed code
  ...parseEnvList('GOLDEN_SCHEMA_SKIP_COLUMNS'),
]);

const SKIP_INDEXES = new Set([
  ...parseEnvList('GOLDEN_SCHEMA_SKIP_INDEXES'),
]);

const SKIP_CONSTRAINTS = new Set([
  ...parseEnvList('GOLDEN_SCHEMA_SKIP_CONSTRAINTS'),
]);

function parseEnvList(name) {
  const raw = process.env[name] || '';
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

// ─── Schema introspection ─────────────────────────────────────────────────────

async function introspect(client) {
  const [tablesRes, columnsRes, indexesRes, constraintsRes] = await Promise.all([
    client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `),
    client.query(`
      SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, column_name
    `),
    client.query(`
      SELECT indexname, tablename, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
      ORDER BY tablename, indexname
    `),
    client.query(`
      SELECT constraint_name, table_name, constraint_type
      FROM information_schema.table_constraints
      WHERE table_schema = 'public'
      ORDER BY table_name, constraint_name
    `),
  ]);

  return {
    tables:      tablesRes.rows,
    columns:     columnsRes.rows,
    indexes:     indexesRes.rows,
    constraints: constraintsRes.rows,
  };
}

// ─── Normalise indexdef for comparison ───────────────────────────────────────
// indexdef contains the database name or quoted identifiers that may differ
// between two dbs on the same server — strip the ON <table> clause variation
// and compare only the structural part after ON.
// We key indexes by name alone; definition comparison is advisory.
function normaliseIndexDef(def) {
  // "CREATE [UNIQUE] INDEX name ON [ONLY] public.table USING ..."
  // Strip the leading "CREATE [UNIQUE] INDEX <name> ON [ONLY] public.<table> "
  // so we compare just the USING / expression part.
  return def.replace(/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+\S+\s+ON\s+(?:ONLY\s+)?(?:\S+\.)?(\S+)\s+/i, 'ON $1 ');
}

// OID-based NOT NULL constraint names that PostgreSQL auto-generates.
// These names are non-deterministic (they encode the table OID which differs
// per database) and cannot be compared by name across two separate databases.
// Real named constraints (PRIMARY KEY, UNIQUE, FK, explicit CHECK) always
// have stable, human-given names and are NOT filtered out.
const OID_NOT_NULL_RE = /^\d+_\d+_\d+_not_null$/;

// ─── Build keyed maps for diffing ─────────────────────────────────────────────

function buildMaps(schema) {
  const tables      = new Map();
  const columns     = new Map();
  const indexes     = new Map();
  const constraints = new Map();

  for (const row of schema.tables) {
    if (INTERNAL_TABLES.has(row.table_name)) continue;
    tables.set(row.table_name, row);
  }

  for (const row of schema.columns) {
    if (INTERNAL_TABLES.has(row.table_name)) continue;
    const key = `${row.table_name}.${row.column_name}`;
    columns.set(key, row);
  }

  for (const row of schema.indexes) {
    if (INTERNAL_TABLES.has(row.tablename)) continue;
    indexes.set(row.indexname, { ...row, normDef: normaliseIndexDef(row.indexdef) });
  }

  for (const row of schema.constraints) {
    if (INTERNAL_TABLES.has(row.table_name)) continue;
    // Skip PostgreSQL's OID-based implicit NOT NULL constraint names — these
    // encode the table OID and will never match across two separate databases.
    if (OID_NOT_NULL_RE.test(row.constraint_name)) continue;
    // Key is table-qualified so same-named constraints on different tables
    // don't collide (PostgreSQL allows duplicate constraint names across tables).
    const key = `${row.table_name}.${row.constraint_name}`;
    constraints.set(key, row);
  }

  return { tables, columns, indexes, constraints };
}

// ─── Diff two keyed maps ──────────────────────────────────────────────────────

function diffMaps(golden, dev, skipSet) {
  const extraInDev   = [];  // in dev, not in golden — potential orphan
  const missingInDev = [];  // in golden, not in dev — migration not applied

  for (const [key, row] of dev) {
    if (skipSet.has(key)) continue;
    if (!golden.has(key)) extraInDev.push({ key, row });
  }

  for (const [key, row] of golden) {
    if (!dev.has(key)) missingInDev.push({ key, row });
  }

  return { extraInDev, missingInDev };
}

// Additionally compare index definitions when names match
function diffIndexDefs(goldenMap, devMap) {
  const defMismatches = [];
  for (const [name, devRow] of devMap) {
    const goldenRow = goldenMap.get(name);
    if (!goldenRow) continue; // handled by name diff
    if (goldenRow.normDef !== devRow.normDef) {
      defMismatches.push({ name, golden: goldenRow.indexdef, dev: devRow.indexdef });
    }
  }
  return defMismatches;
}

// ─── Markdown report ──────────────────────────────────────────────────────────

function buildReport({ issues, warnings, goldenDbName, devDbName, elapsed }) {
  const passed = issues.length === 0;
  const statusLine = passed ? '✅  No schema drift detected.' : `❌  ${issues.length} schema drift issue(s) found.`;

  let md = `# Golden-schema diff\n\n`;
  md += `## Summary\n\n`;
  md += `${statusLine}\n`;
  if (warnings.length > 0) md += `- ${warnings.length} advisory warning(s) (see below)\n`;
  md += `- Golden DB: \`${goldenDbName}\` (fresh migrations)\n`;
  md += `- Dev DB: \`${devDbName}\`\n`;
  md += `- Elapsed: ${elapsed}ms\n\n`;

  if (issues.length > 0) {
    md += `## Issues (CI failures)\n\n`;
    for (const issue of issues) {
      md += `### ${issue.category}: ${issue.kind}\n\n`;
      md += `${issue.description}\n\n`;
      if (issue.items.length > 0) {
        md += '```\n';
        for (const item of issue.items) md += `  ${item}\n`;
        md += '```\n\n';
      }
    }
  }

  if (warnings.length > 0) {
    md += `## Warnings (advisory)\n\n`;
    for (const w of warnings) {
      md += `### ${w.category}\n\n${w.description}\n\n`;
      if (w.items.length > 0) {
        md += '```\n';
        for (const item of w.items) md += `  ${item}\n`;
        md += '```\n\n';
      }
    }
  }

  md += `---\n_Generated by \`scripts/check-golden-schema.mjs\`_\n`;
  return md;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) {
    console.error('[golden-schema] DATABASE_URL is required');
    process.exit(1);
  }

  const start     = Date.now();
  const suffix    = crypto.randomBytes(4).toString('hex');
  const tempName  = `mo_testdb_${Date.now()}_${suffix}`;
  const parsedUrl = new URL(baseUrl);
  parsedUrl.pathname = `/${tempName}`;
  const goldenUrl = parsedUrl.toString();

  const devDbName = new URL(baseUrl).pathname.replace(/^\//, '');

  // ── Create temp DB ───────────────────────────────────────────────────────────
  const admin = new Client({ connectionString: baseUrl });
  await admin.connect();

  // Prune any old mo_testdb_* orphans while we're connected.
  try {
    const { rows } = await admin.query(
      `SELECT datname FROM pg_database WHERE datname LIKE 'mo_testdb_%'`
    );
    const TTL = 2 * 60 * 60 * 1000;
    for (const { datname } of rows) {
      const m = datname.match(/^mo_testdb_(\d+)_[0-9a-f]+$/);
      const age = m ? Date.now() - parseInt(m[1], 10) : Infinity;
      if (age > TTL) {
        try {
          await admin.query(`DROP DATABASE IF EXISTS "${datname}"`);
          console.log(`[golden-schema] pruned orphan: ${datname}`);
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore prune errors */ }

  await admin.query(`CREATE DATABASE "${tempName}"`);
  await admin.end();

  let goldenClient;
  let devClient;

  const cleanup = async () => {
    try { await goldenClient?.end(); } catch { /* ignore */ }
    try { await devClient?.end(); } catch { /* ignore */ }
    const c = new Client({ connectionString: baseUrl });
    try {
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS "${tempName}"`);
      await c.end();
    } catch (e) {
      console.warn(`[golden-schema] could not drop temp DB: ${e.message}`);
    }
  };

  process.on('SIGINT',  () => cleanup().then(() => process.exit(130)));
  process.on('SIGTERM', () => cleanup().then(() => process.exit(143)));

  try {
    // ── Apply migrations to golden DB ──────────────────────────────────────────
    console.log(`[golden-schema] applying migrations to ${tempName}…`);
    await runMigrations({ databaseUrl: goldenUrl });
    console.log('[golden-schema] migrations complete');

    // ── Introspect both DBs ────────────────────────────────────────────────────
    goldenClient = new Client({ connectionString: goldenUrl });
    devClient    = new Client({ connectionString: baseUrl });
    await goldenClient.connect();
    await devClient.connect();

    const [goldenSchema, devSchema] = await Promise.all([
      introspect(goldenClient),
      introspect(devClient),
    ]);

    const golden = buildMaps(goldenSchema);
    const dev    = buildMaps(devSchema);

    // ── Diff ───────────────────────────────────────────────────────────────────
    const tableDiff  = diffMaps(golden.tables,      dev.tables,      SKIP_TABLES);
    const colDiff    = diffMaps(golden.columns,     dev.columns,     SKIP_COLUMNS);
    const idxDiff    = diffMaps(golden.indexes,     dev.indexes,     SKIP_INDEXES);
    const constrDiff = diffMaps(golden.constraints, dev.constraints, SKIP_CONSTRAINTS);
    const idxDefMismatches = diffIndexDefs(golden.indexes, dev.indexes);

    const issues   = [];
    const warnings = [];

    // Extra objects in dev (not in golden) → failure
    if (tableDiff.extraInDev.length > 0) {
      issues.push({
        category: 'Tables',
        kind: 'extra in dev DB',
        description: 'These tables exist in the dev DB but are not created by any migration.\nAdd a migration to drop them or add them to SKIP_TABLES if they are known orphans.',
        items: tableDiff.extraInDev.map(i => i.key),
      });
    }
    if (colDiff.extraInDev.length > 0) {
      issues.push({
        category: 'Columns',
        kind: 'extra in dev DB',
        description: 'These columns exist in the dev DB but are not created by any migration.\nAdd a migration to drop them or add them to SKIP_COLUMNS if they are known orphans.',
        items: colDiff.extraInDev.map(i => i.key),
      });
    }
    if (idxDiff.extraInDev.length > 0) {
      issues.push({
        category: 'Indexes',
        kind: 'extra in dev DB',
        description: 'These indexes exist in the dev DB but are not created by any migration.\nThis is the class of bug this check was designed to catch.\nAdd a migration to drop them or add them to SKIP_INDEXES if they are known orphans.',
        items: idxDiff.extraInDev.map(i => `${i.key}  (on ${i.row.tablename})`),
      });
    }
    if (constrDiff.extraInDev.length > 0) {
      issues.push({
        category: 'Constraints',
        kind: 'extra in dev DB',
        description: 'These constraints exist in the dev DB but are not created by any migration.\nAdd a migration to drop them or add them to SKIP_CONSTRAINTS if they are known orphans.',
        items: constrDiff.extraInDev.map(i => `${i.key}  (${i.row.constraint_type} on ${i.row.table_name})`),
      });
    }

    // Missing from dev (in golden but not dev) → failure
    if (tableDiff.missingInDev.length > 0) {
      issues.push({
        category: 'Tables',
        kind: 'missing from dev DB',
        description: 'These tables are created by migrations but do not exist in the dev DB.\nRun: npm run db:migrate',
        items: tableDiff.missingInDev.map(i => i.key),
      });
    }
    if (colDiff.missingInDev.length > 0) {
      issues.push({
        category: 'Columns',
        kind: 'missing from dev DB',
        description: 'These columns are created by migrations but do not exist in the dev DB.\nRun: npm run db:migrate',
        items: colDiff.missingInDev.map(i => i.key),
      });
    }
    if (idxDiff.missingInDev.length > 0) {
      issues.push({
        category: 'Indexes',
        kind: 'missing from dev DB',
        description: 'These indexes are created by migrations but do not exist in the dev DB.\nRun: npm run db:migrate',
        items: idxDiff.missingInDev.map(i => `${i.key}  (on ${i.row.tablename})`),
      });
    }
    if (constrDiff.missingInDev.length > 0) {
      issues.push({
        category: 'Constraints',
        kind: 'missing from dev DB',
        description: 'These constraints are created by migrations but do not exist in the dev DB.\nRun: npm run db:migrate',
        items: constrDiff.missingInDev.map(i => `${i.key}  (${i.row.constraint_type} on ${i.row.table_name})`),
      });
    }

    // Index definition mismatches → advisory warning
    if (idxDefMismatches.length > 0) {
      warnings.push({
        category: 'Index definition mismatches (advisory)',
        description: 'These indexes have the same name in both DBs but different definitions.\nThis may indicate a migration altered the index definition but the dev DB has an older version.\nConsider running npm run db:migrate:redo or reviewing the migration.',
        items: idxDefMismatches.map(m => [
          `index: ${m.name}`,
          `  golden: ${m.golden}`,
          `  dev:    ${m.dev}`,
        ].join('\n')),
      });
    }

    const elapsed = Date.now() - start;
    const report  = buildReport({ issues, warnings, goldenDbName: tempName, devDbName, elapsed });
    const outPath = join(RESULTS_DIR, 'golden-schema.md');
    writeFileSync(outPath, report, 'utf8');

    // ── Console output ─────────────────────────────────────────────────────────
    const totalObjects =
      golden.tables.size + golden.columns.size +
      golden.indexes.size + golden.constraints.size;

    if (issues.length === 0) {
      console.log(`✅  golden-schema: ${totalObjects} schema objects match between golden and dev  (${elapsed}ms)`);
      if (warnings.length > 0) {
        console.warn(`⚠️   ${warnings.length} advisory warning(s) — see test-results/golden-schema.md`);
      }
      await cleanup();
      process.exit(0);
    } else {
      console.error(`\n❌  golden-schema: ${issues.length} issue(s) found  (${elapsed}ms)\n`);
      for (const issue of issues) {
        console.error(`${issue.category} — ${issue.kind}:`);
        for (const item of issue.items) console.error(`   ${item}`);
      }
      console.error('\nFull report: test-results/golden-schema.md\n');
      await cleanup();
      process.exit(1);
    }
  } catch (err) {
    console.error('[golden-schema] fatal:', err.message);
    await cleanup();
    process.exit(1);
  }
}

main();
