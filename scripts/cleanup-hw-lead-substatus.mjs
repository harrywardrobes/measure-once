#!/usr/bin/env node
/**
 * One-shot cleanup script: remove the stale hw_lead_substatus HubSpot property.
 *
 * The property was part of the old sub-status system (now removed from the app
 * and database). HubSpot will not allow deletion while the property is still
 * referenced in a workflow, active list, or saved view.  This script:
 *
 *   1. Checks whether the property still exists (exits cleanly if already gone).
 *   2. Scans all automation workflows for any that reference hw_lead_substatus.
 *   3. Scans all active lists for any that reference hw_lead_substatus.
 *   4. In dry-run mode (default) reports the blockers; in --fix mode archives
 *      the blocking workflows / deletes the blocking lists, then deletes the
 *      property.
 *
 * Usage:
 *   node scripts/cleanup-hw-lead-substatus.mjs                  # dry-run
 *   node scripts/cleanup-hw-lead-substatus.mjs --fix --yes      # archive blockers + delete property
 *
 * --fix requires --yes to confirm destructive operations (archive workflow /
 * delete list / delete property).  Omitting --yes prints what would happen and
 * exits without making any changes.
 *
 * Requires HUBSPOT_ACCESS_TOKEN to be set in the environment (or .env file).
 */

import 'dotenv/config';

const TOKEN   = process.env.HUBSPOT_ACCESS_TOKEN;
const HS_BASE = process.env.HUBSPOT_API_BASE_OVERRIDE || 'https://api.hubapi.com';
const PROP    = 'hw_lead_substatus';
const FIX     = process.argv.includes('--fix');
const YES     = process.argv.includes('--yes');

if (!TOKEN) {
  console.error('❌  HUBSPOT_ACCESS_TOKEN is not set — cannot proceed.');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

function log(msg) { process.stdout.write(msg + '\n'); }

async function hs(method, path, body) {
  const opts = { method, headers, signal: AbortSignal.timeout(15_000) };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${HS_BASE}${path}`, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, ok: res.ok, json, text };
}

// ── 1. Check whether the property still exists ────────────────────────────────

log(`\n── Checking property ${PROP} ──────────────────────────────────────────`);
const propRes = await hs('GET', `/crm/v3/properties/contacts/${PROP}`);
if (propRes.status === 404) {
  log(`✅  Property ${PROP} not found in HubSpot — already removed. Nothing to do.`);
  process.exit(0);
}
if (!propRes.ok) {
  log(`❌  GET property returned HTTP ${propRes.status}: ${propRes.text.slice(0, 300)}`);
  process.exit(1);
}
log(`ℹ️   Property exists (label: "${propRes.json?.label || '—'}"). Scanning for usages…`);

// ── 2. Scan automation workflows ──────────────────────────────────────────────

log(`\n── Scanning automation workflows ─────────────────────────────────────────`);

const blockingWorkflows = [];
let wfOffset = 0;
const WF_LIMIT = 100;

while (true) {
  const r = await hs('GET', `/automation/v3/workflows?limit=${WF_LIMIT}&offset=${wfOffset}`);
  if (!r.ok) {
    log(`⚠️   GET /automation/v3/workflows HTTP ${r.status} — skipping workflow scan`);
    break;
  }
  const flows = r.json?.workflows ?? [];
  for (const wf of flows) {
    if (JSON.stringify(wf).includes(PROP)) {
      blockingWorkflows.push({ id: wf.id, name: wf.name ?? `(id ${wf.id})` });
    }
  }
  const total   = r.json?.total ?? flows.length;
  wfOffset += flows.length;
  if (flows.length < WF_LIMIT || wfOffset >= total) break;
}

if (blockingWorkflows.length === 0) {
  log('✅  No workflows reference this property.');
} else {
  log(`⚠️   Found ${blockingWorkflows.length} workflow(s) referencing ${PROP}:`);
  for (const wf of blockingWorkflows) log(`     • [${wf.id}] ${wf.name}`);
}

// ── 3. Scan active lists ───────────────────────────────────────────────────────

log(`\n── Scanning active lists ──────────────────────────────────────────────────`);

const blockingLists = [];

// Fetch lists in batches; each list body contains filterGroups which reference properties.
// GET /crm/v3/lists returns lightweight metadata; fetch full filter body individually only
// when we detect a name-level hit is infeasible, so we use the search endpoint instead.
// HubSpot lists v3 beta: GET /crm/v3/lists?count=500&processingTypes=DYNAMIC
// The filterGroups are included in the response body when processingType=DYNAMIC.

let listsAfter = undefined;
const LIST_LIMIT = 250;

while (true) {
  const qs  = `count=${LIST_LIMIT}&processingTypes=DYNAMIC${listsAfter ? `&after=${listsAfter}` : ''}`;
  const r   = await hs('GET', `/crm/v3/lists?${qs}`);
  if (!r.ok) {
    log(`⚠️   GET /crm/v3/lists HTTP ${r.status} — skipping list scan`);
    break;
  }
  const lists = r.json?.lists ?? [];
  for (const lst of lists) {
    if (JSON.stringify(lst).includes(PROP)) {
      blockingLists.push({ listId: lst.listId, name: lst.name ?? `(listId ${lst.listId})` });
    }
  }
  listsAfter = r.json?.paging?.next?.after;
  if (!listsAfter || lists.length < LIST_LIMIT) break;
}

if (blockingLists.length === 0) {
  log('✅  No dynamic lists reference this property.');
} else {
  log(`⚠️   Found ${blockingLists.length} list(s) referencing ${PROP}:`);
  for (const l of blockingLists) log(`     • [${l.listId}] ${l.name}`);
}

// ── 4. Attempt deletion (or report) ───────────────────────────────────────────

const hasBlockers = blockingWorkflows.length > 0 || blockingLists.length > 0;

if (!FIX) {
  log(`\n── Dry run complete ──────────────────────────────────────────────────────`);
  if (hasBlockers) {
    log(`ℹ️   Run with --fix --yes to archive the blocking items above and delete the property.`);
  } else {
    log(`ℹ️   No workflow/list blockers found. The single usage may be a saved view or`);
    log(`     form field not accessible via API. Try manual deletion in HubSpot Settings`);
    log(`     → Properties → Contacts → hw_lead_substatus → Delete.`);
    log(`     Or run with --fix --yes to attempt direct deletion now.`);
  }
  process.exit(0);
}

// --fix without --yes: show confirmation prompt and exit safely
if (!YES) {
  log(`\n── Fix mode: confirmation required ───────────────────────────────────────`);
  if (blockingWorkflows.length > 0) {
    log(`  The following workflows will be ARCHIVED (permanently disabled):`);
    for (const wf of blockingWorkflows) log(`    • [${wf.id}] ${wf.name}`);
  }
  if (blockingLists.length > 0) {
    log(`  The following lists will be DELETED:`);
    for (const l of blockingLists) log(`    • [${l.listId}] ${l.name}`);
  }
  log(`  The HubSpot property "${PROP}" will be DELETED.`);
  log(`\nℹ️   Re-run with --fix --yes to confirm and execute these changes.`);
  process.exit(0);
}

// ── --fix --yes mode: archive blockers then delete property ───────────────────

log(`\n── Fix mode: removing blockers ───────────────────────────────────────────`);

for (const wf of blockingWorkflows) {
  log(`   Archiving workflow [${wf.id}] "${wf.name}" …`);
  const r = await hs('DELETE', `/automation/v3/workflows/${wf.id}`);
  if (r.ok || r.status === 204 || r.status === 404) {
    log(`   ✅  Archived workflow ${wf.id}`);
  } else {
    log(`   ❌  Failed to archive workflow ${wf.id}: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  }
}

for (const lst of blockingLists) {
  log(`   Deleting list [${lst.listId}] "${lst.name}" …`);
  const r = await hs('DELETE', `/crm/v3/lists/${lst.listId}`);
  if (r.ok || r.status === 204 || r.status === 404) {
    log(`   ✅  Deleted list ${lst.listId}`);
  } else {
    log(`   ❌  Failed to delete list ${lst.listId}: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  }
}

log(`\n── Deleting property ${PROP} ─────────────────────────────────────────────`);
const delRes = await hs('DELETE', `/crm/v3/properties/contacts/${PROP}`);

if (delRes.ok || delRes.status === 204) {
  log(`✅  Property ${PROP} deleted from HubSpot.`);
  log(`\nCleanup complete. You can now remove this script and the comment block`);
  log(`in server.js near checkDuplicateHandlerBindings.`);
  process.exit(0);
} else if (delRes.status === 404) {
  log(`✅  Property ${PROP} was already gone — nothing to delete.`);
  process.exit(0);
} else {
  const msg = delRes.json?.message || delRes.text.slice(0, 300);
  log(`❌  Property deletion failed: HTTP ${delRes.status}: ${msg}`);
  log(`\nThere may be additional usages not reachable via the workflow/list APIs`);
  log(`(e.g. a saved view or a form). Remove those manually in HubSpot, then re-run.`);
  process.exit(1);
}
