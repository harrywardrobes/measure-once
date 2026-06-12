'use strict';
/**
 * test/card-action-handlers/drift-guard.js
 *
 * Drift-guard: asserts that:
 *   a) The server route contracts (shared/handler-route-contracts.cjs) are
 *      exactly equal to the registry terminal keys for each handler type
 *      that has a server route.
 *   b) The CJS registry (shared/handler-outcomes.cjs) and the TypeScript
 *      canonical source (shared/handler-outcomes.ts) have the same handler
 *      type keys and terminal-key counts.
 *
 * Run standalone:  node test/card-action-handlers/drift-guard.js
 * Included in CI:  npm run test:handler-outcomes-drift
 *
 * Checks:
 *   1.  All required handler types are present in the CJS registry
 *   2.  arrange_visit server contract = registry terminal keys (exact)
 *   3.  arrange_visit status writes via getArrangeVisitStatus
 *   4.  design_visit_followup server contract = registry terminal status map (exact)
 *   5.  contact_customer server contract = registry terminal map MINUS send_upload_link
 *   6.  contact_customer: send_upload_link excluded from server contract
 *   7.  review_customer_photos server contract = registry terminal status map (exact)
 *   8.  open_deal: accept + decline terminal entries have setsLeadStatus
 *   9.  deposit_invoice_followup: not_proceeding is terminal with setsLeadStatus
 *   10. upload_photos_and_info: link_sent is terminal with AWAITING_PHOTOS
 *   11. CJS ↔ TS parity: same handler type keys
 *   12. CJS ↔ TS parity: same terminal-key counts per handler type
 *   13. Email coverage: every registry-referenced template key exists in
 *       email-templates.js TEMPLATE_KEYS
 *   14. Email coverage: every TEMPLATE_KEY is referenced by a handler outcome,
 *       action-level slot, or the system email list (no unassigned keys), and
 *       no key is claimed by both a handler slot and the system list
 */

const fs   = require('fs');
const path = require('path');

const {
  HANDLER_OUTCOMES,
  ACTION_LEVEL_EMAIL_TEMPLATES,
  SYSTEM_EMAIL_TEMPLATES,
  templateRefKey,
  templateRefIsSystem,
  getTerminalKeys,
  getTerminalStatusMap,
  getArrangeVisitStatus,
} = require('../../shared/handler-outcomes.cjs');

const { TEMPLATE_KEYS } = require('../../email-templates.js');

const {
  ARRANGE_VISIT_KEYS,
  DVF_STATUS_MAP,
  CONTACT_CUSTOMER_MAP,
  REVIEW_OUTCOME_STATUS,
  getArrangeVisitStatus: contractGetArrangeVisitStatus,
} = require('../../shared/handler-route-contracts.cjs');

let failures = 0;

function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function pass(msg) { console.log(`  pass  ${msg}`); }
function assert(condition, msg) { if (condition) pass(msg); else fail(msg); }

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const k of a) { if (!b.has(k)) return false; }
  return true;
}

function mapsEqual(a, b) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.join(',') !== kb.join(',')) return false;
  for (const k of ka) { if (a[k] !== b[k]) return false; }
  return true;
}

console.log('\n── handler-outcomes drift guard ───────────────────────────────────\n');

// ── 1. All required handler types present in CJS registry ─────────────────────
const REQUIRED_TYPES = [
  'arrange_visit', 'contact_customer', 'deposit_invoice_followup',
  'design_visit_followup', 'open_deal', 'review_customer_photos',
  'schedule_visit', 'show_message', 'start_design_visit',
  'summarise_phone_call', 'upload_photos_and_info',
];
for (const type of REQUIRED_TYPES) {
  assert(Array.isArray(HANDLER_OUTCOMES[type]), `Registry has '${type}' entry`);
}

// ── 2. arrange_visit: server contract == registry terminal keys (exact) ─────────
{
  const registryKeys = getTerminalKeys('arrange_visit');
  assert(
    setsEqual(ARRANGE_VISIT_KEYS, registryKeys),
    `arrange_visit: server contract keys [${[...ARRANGE_VISIT_KEYS].sort().join(', ')}] == registry terminal keys [${[...registryKeys].sort().join(', ')}]`,
  );
}

// ── 3. arrange_visit: status writes via getArrangeVisitStatus ─────────────────
{
  assert(getArrangeVisitStatus('booked', 'design')         === 'DESIGN_SCHEDULED',  'arrange_visit: booked+design → DESIGN_SCHEDULED');
  assert(getArrangeVisitStatus('booked', 'survey')         === 'SURVEY_SCHEDULED',  'arrange_visit: booked+survey → SURVEY_SCHEDULED');
  assert(getArrangeVisitStatus('email_sent', 'design')     === 'DESIGN_INVITED',    'arrange_visit: email_sent+design → DESIGN_INVITED');
  assert(getArrangeVisitStatus('email_sent', 'survey')     === 'SURVEY_SCHEDULED',  'arrange_visit: email_sent+survey → SURVEY_SCHEDULED');
  assert(getArrangeVisitStatus('not_proceeding', 'design') === 'NOT_SUITABLE',      'arrange_visit: not_proceeding → NOT_SUITABLE');
  assert(getArrangeVisitStatus('not_proceeding', 'survey') === 'NOT_SUITABLE',      'arrange_visit: not_proceeding(survey) → NOT_SUITABLE');
  assert(getArrangeVisitStatus('unknown_key', 'design')    === null,                'arrange_visit: unknown key returns null');
  // contract helper should be identical
  assert(contractGetArrangeVisitStatus('booked', 'design') === 'DESIGN_SCHEDULED', 'arrange_visit: contract helper matches registry helper');
}

// ── 4. design_visit_followup: server contract == registry terminal status map ──
{
  const registryMap = getTerminalStatusMap('design_visit_followup');
  assert(
    mapsEqual(DVF_STATUS_MAP, registryMap),
    `design_visit_followup: server contract [${Object.keys(DVF_STATUS_MAP).sort().join(', ')}] == registry terminal map [${Object.keys(registryMap).sort().join(', ')}]`,
  );
}

// ── 5. contact_customer: server contract = registry terminal map MINUS send_upload_link
{
  const registryMap = getTerminalStatusMap('contact_customer');
  const { send_upload_link: _excluded, ...expectedMap } = registryMap;
  assert(
    mapsEqual(CONTACT_CUSTOMER_MAP, expectedMap),
    `contact_customer: server contract == registry terminal map minus send_upload_link`,
  );
  // Verify the registry actually has the 3 terminal outcomes we expect
  assert(registryMap['attempted_to_contact'] === 'ATTEMPTED_TO_CONTACT', 'contact_customer registry: attempted_to_contact → ATTEMPTED_TO_CONTACT');
  assert(registryMap['no_response']          === 'NO_RESPONSE',           'contact_customer registry: no_response → NO_RESPONSE');
  assert(registryMap['send_upload_link']     === 'AWAITING_PHOTOS',       'contact_customer registry: send_upload_link → AWAITING_PHOTOS');
  assert(Object.keys(registryMap).length === 3,                          `contact_customer registry: exactly 3 terminal keys (got ${Object.keys(registryMap).join(', ')})`);
}

// ── 6. contact_customer: send_upload_link excluded from server contract ─────────
{
  assert(
    !Object.prototype.hasOwnProperty.call(CONTACT_CUSTOMER_MAP, 'send_upload_link'),
    'contact_customer: server contract excludes send_upload_link (dispatched via upload_photos_and_info)',
  );
  assert(Object.keys(CONTACT_CUSTOMER_MAP).length === 2, `contact_customer: server contract has exactly 2 keys (got ${Object.keys(CONTACT_CUSTOMER_MAP).join(', ')})`);
}

// ── 7. review_customer_photos: server contract == registry terminal status map ──
{
  const registryMap = getTerminalStatusMap('review_customer_photos');
  assert(
    mapsEqual(REVIEW_OUTCOME_STATUS, registryMap),
    `review_customer_photos: server contract [${Object.keys(REVIEW_OUTCOME_STATUS).sort().join(', ')}] == registry terminal map [${Object.keys(registryMap).sort().join(', ')}]`,
  );
}

// ── 8. open_deal: accept + decline terminal entries have setsLeadStatus ─────────
{
  const outcomes = HANDLER_OUTCOMES.open_deal;
  const accept  = outcomes.find(o => o.key === 'accept');
  const decline = outcomes.find(o => o.key === 'decline');
  assert(accept?.kind === 'terminal',                  'open_deal: accept is terminal');
  assert(accept?.setsLeadStatus === 'DEPOSIT_INVOICE', 'open_deal: accept → DEPOSIT_INVOICE');
  assert(decline?.kind === 'terminal',                 'open_deal: decline is terminal');
  assert(decline?.setsLeadStatus === 'DECLINED_DEAL',  'open_deal: decline → DECLINED_DEAL');
}

// ── 9. deposit_invoice_followup: not_proceeding terminal with setsLeadStatus ────
{
  const outcomes = HANDLER_OUTCOMES.deposit_invoice_followup;
  const np = outcomes.find(o => o.key === 'not_proceeding');
  assert(np?.kind === 'terminal',                 'deposit_invoice_followup: not_proceeding is terminal');
  assert(np?.setsLeadStatus === 'DECLINED_DEAL',  'deposit_invoice_followup: not_proceeding → DECLINED_DEAL');
}

// ── 10. upload_photos_and_info: link_sent terminal ────────────────────────────
{
  const outcomes = HANDLER_OUTCOMES.upload_photos_and_info;
  const ls = outcomes.find(o => o.key === 'link_sent');
  assert(ls?.kind === 'terminal',                  'upload_photos_and_info: link_sent is terminal');
  assert(ls?.setsLeadStatus === 'AWAITING_PHOTOS', 'upload_photos_and_info: link_sent → AWAITING_PHOTOS');
}

// ── 11 & 12. CJS ↔ TS parity ─────────────────────────────────────────────────
{
  const tsPath = path.resolve(__dirname, '../../shared/handler-outcomes.ts');
  let tsContent;
  try {
    tsContent = fs.readFileSync(tsPath, 'utf8');
  } catch (e) {
    fail(`CJS↔TS parity: could not read ${tsPath}: ${e.message}`);
    tsContent = null;
  }

  if (tsContent) {
    // Scope the parse to the HANDLER_OUTCOMES object literal only, so the
    // regex does not pick up other top-level `  identifier: [` lines (e.g.
    // ACTION_LEVEL_EMAIL_TEMPLATES keys) that share the same shape.
    const houStart = tsContent.indexOf('export const HANDLER_OUTCOMES');
    const houEnd   = houStart >= 0 ? tsContent.indexOf('\n};', houStart) : -1;
    const houBlock = houStart >= 0 && houEnd >= 0
      ? tsContent.slice(houStart, houEnd)
      : tsContent;

    // Extract top-level handler type keys: lines matching "  identifier: ["
    const tsTypeKeys = [];
    const typeKeyRe = /^  (\w+): \[/gm;
    let m;
    while ((m = typeKeyRe.exec(houBlock)) !== null) {
      tsTypeKeys.push(m[1]);
    }
    const cjsTypeKeys = Object.keys(HANDLER_OUTCOMES);

    assert(
      [...tsTypeKeys].sort().join(',') === [...cjsTypeKeys].sort().join(','),
      `CJS↔TS parity: same handler type keys`,
    );

    // Compare terminal-key counts per handler type
    const posMatches = [...houBlock.matchAll(/^  (\w+): \[/gm)];
    let allCountsMatch = true;
    for (let i = 0; i < posMatches.length; i++) {
      const type = posMatches[i][1];
      if (!HANDLER_OUTCOMES[type]) continue;
      const start = posMatches[i].index;
      const end   = i + 1 < posMatches.length ? posMatches[i + 1].index : houBlock.length;
      const block = houBlock.slice(start, end);
      const tsCount  = (block.match(/kind:\s*'terminal'/g) || []).length;
      const cjsCount = getTerminalKeys(type).size;
      if (tsCount !== cjsCount) {
        fail(`CJS↔TS parity: '${type}' terminal count mismatch (TS: ${tsCount}, CJS: ${cjsCount})`);
        allCountsMatch = false;
      }
    }
    if (allCountsMatch) {
      pass('CJS↔TS parity: all handler types have matching terminal key counts');
    }
  }
}

// ── 13 & 14. Email-template coverage ─────────────────────────────────────────
//
// Every template key the registry references (per-outcome sendsEmailTemplates,
// ACTION_LEVEL_EMAIL_TEMPLATES, SYSTEM_EMAIL_TEMPLATES) must exist in
// email-templates.js TEMPLATE_KEYS, and conversely every real template key must
// be reachable from the registry or the system list. The admin Email Templates
// page derives its accordion grouping from these, so any drift would leave a
// template either dangling or grouped under a non-existent key.
{
  const knownKeys = new Set(TEMPLATE_KEYS);

  // 13a. Collect every template key referenced by the registry. Template refs
  // may be bare key strings or {key, system, sentFrom} objects — normalise both.
  const referenced = new Set();
  for (const type of Object.keys(HANDLER_OUTCOMES)) {
    for (const o of HANDLER_OUTCOMES[type]) {
      for (const ref of (o.sendsEmailTemplates || [])) referenced.add(templateRefKey(ref));
    }
  }
  for (const type of Object.keys(ACTION_LEVEL_EMAIL_TEMPLATES)) {
    for (const ref of ACTION_LEVEL_EMAIL_TEMPLATES[type]) referenced.add(templateRefKey(ref));
  }
  const systemKeys = new Set(SYSTEM_EMAIL_TEMPLATES.map((s) => s.key));
  for (const k of systemKeys) referenced.add(k);

  // 13. Every referenced key must be a real template key.
  const unknownRefs = [...referenced].filter((k) => !knownKeys.has(k)).sort();
  assert(
    unknownRefs.length === 0,
    `Email coverage: all registry-referenced template keys exist in TEMPLATE_KEYS` +
      (unknownRefs.length ? ` (unknown: ${unknownRefs.join(', ')})` : ''),
  );

  // 14. Every real template key must be reachable from the registry/system list.
  const uncovered = [...knownKeys].filter((k) => !referenced.has(k)).sort();
  assert(
    uncovered.length === 0,
    `Email coverage: every TEMPLATE_KEY is referenced by a handler outcome, ` +
      `action-level slot, or the system list` +
      (uncovered.length ? ` (unassigned: ${uncovered.join(', ')})` : ''),
  );

  // 14b. A template key claimed by both a handler/action slot and the system
  // list (SYSTEM_EMAIL_TEMPLATES) would make its grouping ambiguous — UNLESS
  // every handler reference of that key is flagged system-in-flow ({system:true}).
  // System-in-flow refs are an intentional overlap: the email is sent by a
  // system/integration module during the handler's flow, so it can legitimately
  // appear in the handler grouping (with a System chip) even if it is also a
  // lifecycle email. A plain (non-system) handler ref overlapping the system
  // list remains an error.
  //
  // Track, per key, whether ANY handler ref is non-system (ambiguous overlap).
  const handlerRefHasPlain = new Map(); // key -> true if referenced without system flag
  const noteRef = (ref) => {
    const k = templateRefKey(ref);
    const plain = !templateRefIsSystem(ref);
    handlerRefHasPlain.set(k, (handlerRefHasPlain.get(k) || false) || plain);
  };
  for (const type of Object.keys(HANDLER_OUTCOMES)) {
    for (const o of HANDLER_OUTCOMES[type]) {
      for (const ref of (o.sendsEmailTemplates || [])) noteRef(ref);
    }
  }
  for (const type of Object.keys(ACTION_LEVEL_EMAIL_TEMPLATES)) {
    for (const ref of ACTION_LEVEL_EMAIL_TEMPLATES[type]) noteRef(ref);
  }
  const overlap = [...systemKeys]
    .filter((k) => handlerRefHasPlain.get(k) === true)
    .sort();
  assert(
    overlap.length === 0,
    `Email coverage: no template key is both a (non-system-in-flow) handler ` +
      `reference and a system email` +
      (overlap.length ? ` (overlap: ${overlap.join(', ')})` : ''),
  );
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n──────────────────────────────────────────────────────────────────`);
if (failures > 0) {
  console.error(`\n${failures} drift-guard assertion(s) FAILED\n`);
  process.exit(1);
} else {
  console.log(`\nAll drift-guard assertions passed\n`);
}
