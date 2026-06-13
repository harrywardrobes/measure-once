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
 *   12b. CJS ↔ TS parity: same sendsEmailTemplates arrays per outcome
 *   12c. CJS ↔ TS parity: same ACTION_LEVEL_EMAIL_TEMPLATES handler keys and
 *        template arrays
 *   12d. CJS ↔ TS parity: same SYSTEM_EMAIL_TEMPLATES key set
 *   12d-ii. CJS ↔ TS parity: same SYSTEM_EMAIL_TEMPLATES sentFrom, system, and
 *        description field values per entry
 *   13. Email coverage: every registry-referenced template key exists in
 *       email-templates.js TEMPLATE_KEYS
 *   14. Email coverage: every TEMPLATE_KEY is referenced by a handler outcome,
 *       action-level slot, or the system email list (no unassigned keys), and
 *       no key is claimed by both a handler slot and the system list
 *   15. server.js CARD_ACTION_HANDLER_CONFIG_VALIDATORS keys exactly equal
 *       Object.keys(HANDLER_OUTCOMES) — prevents a new registry type from
 *       being accepted by the UI but rejected by the server validator
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

// ── 3b. arrange_visit: per-visitType variant labels (chip rendering) ──────────
// The Workflow page OutcomeChipsRow reads variant `label` overrides when a
// handler is configured for a specific visit type. Assert each variant carries
// the expected per-type label so the chip text stays in sync with the data.
{
  const arrangeVisit = HANDLER_OUTCOMES.arrange_visit || [];
  const booked    = arrangeVisit.find(o => o.key === 'booked');
  const emailSent = arrangeVisit.find(o => o.key === 'email_sent');
  const np        = arrangeVisit.find(o => o.key === 'not_proceeding');

  assert(booked?.variants?.design?.label === 'Design visit scheduled', 'arrange_visit: booked+design variant label = "Design visit scheduled"');
  assert(booked?.variants?.survey?.label === 'Survey scheduled',       'arrange_visit: booked+survey variant label = "Survey scheduled"');
  assert(emailSent?.variants?.design?.label === 'Design invite sent',  'arrange_visit: email_sent+design variant label = "Design invite sent"');
  assert(emailSent?.variants?.survey?.label === 'Survey scheduled',    'arrange_visit: email_sent+survey variant label = "Survey scheduled"');
  // Outcomes without variants carry no per-type label (chip falls back to base).
  assert(np && !np.variants, 'arrange_visit: not_proceeding has no variants (chip uses base label)');
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

    // Shared helper for 12b and 12c: extract sorted template keys from an array
    // literal in the TS source.  Handles both bare string refs ('TEMPLATE_KEY')
    // and object refs ({ key: 'TEMPLATE_KEY', ... }).
    const parseTsTemplateKeys = (arrayContent) => {
      // Object refs: { key: 'TEMPLATE_KEY', ... }
      const objRe = /\bkey:\s*'([^']+)'/g;
      const objKeys = [];
      let m;
      while ((m = objRe.exec(arrayContent)) !== null) objKeys.push(m[1]);
      if (objKeys.length) return objKeys.sort();
      // Bare string refs: 'TEMPLATE_KEY'
      const bareRe = /'([^']+)'/g;
      const bareKeys = [];
      while ((m = bareRe.exec(arrayContent)) !== null) bareKeys.push(m[1]);
      return bareKeys.sort();
    };

    // ── 12b. CJS↔TS parity: sendsEmailTemplates arrays match per outcome ──────
    //
    // Parses sendsEmailTemplates from the TS source text — both bare key strings
    // ('template_key') and object refs ({ key: 'template_key', system, sentFrom })
    // — and compares the sorted key list against the runtime CJS registry values
    // for every outcome in every handler type.  Detects renames or additions
    // applied to only one registry that would slip past checks 12 and 13.
    //
    // Outcome key lines use exactly 6 leading spaces in the TS file:
    //   ^      key: 'OUTCOME_KEY'
    // Template-ref key lines inside a sendsEmailTemplates object are inline,
    // never at the start of a line with 6 spaces, so they are not confused with
    // outcome keys.
    {
      let allEmailsMatch = true;
      for (let i = 0; i < posMatches.length; i++) {
        const type = posMatches[i][1];
        if (!HANDLER_OUTCOMES[type]) continue;
        const typeStart = posMatches[i].index;
        const typeEnd   = i + 1 < posMatches.length ? posMatches[i + 1].index : houBlock.length;
        const typeBlock = houBlock.slice(typeStart, typeEnd);

        // Outcome key lines in the TS file have exactly 6 leading spaces:
        //   "      key: 'OUTCOME_KEY',"
        // Template-ref objects (inside sendsEmailTemplates arrays) place their
        // key: field inline — never at 6-space line-start — so this regex only
        // matches outcome boundaries, not nested template refs.
        const outcomeKeyRe = /^      key:\s*'([^']+)'/gm;
        const outcomePositions = [];
        let okm;
        while ((okm = outcomeKeyRe.exec(typeBlock)) !== null) {
          outcomePositions.push({ key: okm[1], index: okm.index });
        }

        for (let j = 0; j < outcomePositions.length; j++) {
          const outcomeKey = outcomePositions[j].key;
          const oStart = outcomePositions[j].index;
          const oEnd   = j + 1 < outcomePositions.length
            ? outcomePositions[j + 1].index
            : typeBlock.length;
          const outcomeBlock = typeBlock.slice(oStart, oEnd);

          // CJS: runtime template keys for this outcome
          const cjsOutcome = (HANDLER_OUTCOMES[type] || []).find(o => o.key === outcomeKey);
          const cjsKeys = cjsOutcome
            ? (cjsOutcome.sendsEmailTemplates || []).map(templateRefKey).sort()
            : [];

          // TS: parse sendsEmailTemplates from source text
          const tsKeys = [];
          const setIdx = outcomeBlock.indexOf('sendsEmailTemplates:');
          if (setIdx !== -1) {
            const arrayStart = outcomeBlock.indexOf('[', setIdx);
            const arrayEnd   = arrayStart !== -1 ? outcomeBlock.indexOf(']', arrayStart) : -1;
            if (arrayStart !== -1 && arrayEnd !== -1) {
              const arrayContent = outcomeBlock.slice(arrayStart + 1, arrayEnd);
              tsKeys.push(...parseTsTemplateKeys(arrayContent));
            }
          }

          if (cjsKeys.join(',') !== tsKeys.join(',')) {
            fail(
              `CJS↔TS parity: '${type}.${outcomeKey}' sendsEmailTemplates mismatch` +
              ` (CJS: [${cjsKeys.join(', ')}], TS: [${tsKeys.join(', ')}])`,
            );
            allEmailsMatch = false;
          }
        }
      }
      if (allEmailsMatch) {
        pass('CJS↔TS parity: all outcome sendsEmailTemplates arrays match');
      }
    }

    // ── 12c. CJS↔TS parity: ACTION_LEVEL_EMAIL_TEMPLATES handler keys and arrays ──
    //
    // Locates the ACTION_LEVEL_EMAIL_TEMPLATES block in the TS source, extracts
    // each handler-type key and its sorted template-key array, and compares them
    // against the runtime CJS values.  Catches renames or additions applied to
    // only one registry that would not be detected by checks 12 or 12b (which
    // only cover per-outcome sendsEmailTemplates inside HANDLER_OUTCOMES).
    {
      const aletStart = tsContent.indexOf('export const ACTION_LEVEL_EMAIL_TEMPLATES');
      const aletEnd   = aletStart >= 0 ? tsContent.indexOf('\n};', aletStart) : -1;
      if (aletStart === -1 || aletEnd === -1) {
        fail('CJS↔TS parity (12c): could not locate ACTION_LEVEL_EMAIL_TEMPLATES block in TS source');
      } else {
        const aletBlock = tsContent.slice(aletStart, aletEnd);

        // Extract handler type keys: lines matching "  identifier: ["
        const aletTypeKeyRe = /^  (\w+): \[/gm;
        const tsAletKeys = [];
        let am;
        while ((am = aletTypeKeyRe.exec(aletBlock)) !== null) tsAletKeys.push(am[1]);
        const cjsAletKeys = Object.keys(ACTION_LEVEL_EMAIL_TEMPLATES).sort();

        assert(
          [...tsAletKeys].sort().join(',') === cjsAletKeys.join(','),
          `CJS↔TS parity (12c): ACTION_LEVEL_EMAIL_TEMPLATES same handler type keys` +
            ` (TS: [${[...tsAletKeys].sort().join(', ')}], CJS: [${cjsAletKeys.join(', ')}])`,
        );

        // For each handler type, compare the sorted template key arrays.
        const aletTypePositions = [...aletBlock.matchAll(/^  (\w+): \[/gm)];
        let allAletMatch = true;
        for (let i = 0; i < aletTypePositions.length; i++) {
          const type     = aletTypePositions[i][1];
          const tStart   = aletTypePositions[i].index;
          const tEnd     = i + 1 < aletTypePositions.length
            ? aletTypePositions[i + 1].index
            : aletBlock.length;
          const tBlock   = aletBlock.slice(tStart, tEnd);
          const arrStart = tBlock.indexOf('[');
          const arrEnd   = tBlock.lastIndexOf(']');
          const tsKeys   = arrStart !== -1 && arrEnd !== -1
            ? parseTsTemplateKeys(tBlock.slice(arrStart + 1, arrEnd))
            : [];
          const cjsKeys  = (ACTION_LEVEL_EMAIL_TEMPLATES[type] || []).map(templateRefKey).sort();
          if (tsKeys.join(',') !== cjsKeys.join(',')) {
            fail(
              `CJS↔TS parity (12c): ACTION_LEVEL_EMAIL_TEMPLATES['${type}'] template key mismatch` +
              ` (TS: [${tsKeys.join(', ')}], CJS: [${cjsKeys.join(', ')}])`,
            );
            allAletMatch = false;
          }
        }
        if (allAletMatch) {
          pass('CJS↔TS parity (12c): ACTION_LEVEL_EMAIL_TEMPLATES handler keys and template arrays match');
        }
      }
    }

    // ── 12d. CJS↔TS parity: SYSTEM_EMAIL_TEMPLATES key set ───────────────────
    //
    // Locates the SYSTEM_EMAIL_TEMPLATES array in the TS source, extracts each
    // entry's `key` field, and compares the sorted set against the runtime CJS
    // values.  Catches a key that is added, removed, or renamed in only one of
    // the two registries — drift that checks 12, 12b, and 12c cannot detect
    // because SYSTEM_EMAIL_TEMPLATES sits outside HANDLER_OUTCOMES and
    // ACTION_LEVEL_EMAIL_TEMPLATES.
    {
      const setStart = tsContent.indexOf('export const SYSTEM_EMAIL_TEMPLATES');
      const setEnd   = setStart >= 0 ? tsContent.indexOf('];', setStart) : -1;
      if (setStart === -1 || setEnd === -1) {
        fail('CJS↔TS parity (12d): could not locate SYSTEM_EMAIL_TEMPLATES block in TS source');
      } else {
        const setBlock = tsContent.slice(setStart, setEnd);
        const keyRe = /\bkey:\s*'([^']+)'/g;
        const tsSystemKeys = [];
        let sm;
        while ((sm = keyRe.exec(setBlock)) !== null) tsSystemKeys.push(sm[1]);
        tsSystemKeys.sort();

        const cjsSystemKeys = SYSTEM_EMAIL_TEMPLATES.map((s) => s.key).sort();

        const keySetsMatch = tsSystemKeys.join(',') === cjsSystemKeys.join(',');
        assert(
          keySetsMatch,
          `CJS↔TS parity (12d): SYSTEM_EMAIL_TEMPLATES key sets match` +
            ` (TS: [${tsSystemKeys.join(', ')}], CJS: [${cjsSystemKeys.join(', ')}])`,
        );

        // ── 12d-ii. CJS↔TS parity: per-entry sentFrom, system, and description ─
        //
        // Comparing the key set alone misses a copy-paste error or incomplete
        // update that leaves an entry's `sentFrom`, `system`, or `description`
        // field out of sync between the two registries.  For each entry (keyed
        // by its `key`), parse the TS source block and compare all three fields
        // against the runtime CJS values.  Only runs when the key sets match —
        // otherwise the 12d failure above already identifies the structural drift.
        if (keySetsMatch) {
          // Split the TS array into one block per entry, boundaried by each
          // entry's `key:` line.
          const keyPosRe = /\bkey:\s*'([^']+)'/g;
          const entryPositions = [];
          let km;
          while ((km = keyPosRe.exec(setBlock)) !== null) {
            entryPositions.push({ key: km[1], index: km.index });
          }

          let allFieldsMatch = true;
          for (let i = 0; i < entryPositions.length; i++) {
            const entryKey = entryPositions[i].key;
            const eStart   = entryPositions[i].index;
            const eEnd     = i + 1 < entryPositions.length
              ? entryPositions[i + 1].index
              : setBlock.length;
            const entryBlock = setBlock.slice(eStart, eEnd);

            // TS: parse sentFrom (string) and system (boolean) from source text.
            const tsSentFromMatch = entryBlock.match(/\bsentFrom:\s*'([^']*)'/);
            const tsSentFrom = tsSentFromMatch ? tsSentFromMatch[1] : undefined;
            const tsSystemMatch = entryBlock.match(/\bsystem:\s*(true|false)/);
            const tsSystem = tsSystemMatch ? tsSystemMatch[1] === 'true' : undefined;
            // TS: parse description using a quoted-string regex that handles
            // escaped characters (e.g. \', \") so apostrophes in prose don't
            // break the match.  Unescape the captured raw source text so we
            // compare semantic string values, not source encoding (otherwise
            // a description with \' would compare unequal to the runtime "'"
            // even when both registries are in sync).
            const tsDescMatch = entryBlock.match(/\bdescription:\s*'((?:[^'\\]|\\.)*)'/);
            const tsDescRaw = tsDescMatch ? tsDescMatch[1] : undefined;
            const tsDesc = tsDescRaw === undefined ? undefined : tsDescRaw
              .replace(/\\'/g, "'")
              .replace(/\\"/g, '"')
              .replace(/\\n/g, '\n')
              .replace(/\\r/g, '\r')
              .replace(/\\t/g, '\t')
              .replace(/\\\\/g, '\\');

            // CJS: runtime values for this entry.
            const cjsEntry = SYSTEM_EMAIL_TEMPLATES.find((s) => s.key === entryKey);
            const cjsSentFrom = cjsEntry ? cjsEntry.sentFrom : undefined;
            const cjsSystem   = cjsEntry ? cjsEntry.system : undefined;
            const cjsDesc     = cjsEntry ? cjsEntry.description : undefined;

            if (tsSentFrom !== cjsSentFrom) {
              fail(
                `CJS↔TS parity (12d-ii): SYSTEM_EMAIL_TEMPLATES['${entryKey}'] sentFrom mismatch` +
                ` (TS: ${JSON.stringify(tsSentFrom)}, CJS: ${JSON.stringify(cjsSentFrom)})`,
              );
              allFieldsMatch = false;
            }
            if (tsSystem !== cjsSystem) {
              fail(
                `CJS↔TS parity (12d-ii): SYSTEM_EMAIL_TEMPLATES['${entryKey}'] system mismatch` +
                ` (TS: ${JSON.stringify(tsSystem)}, CJS: ${JSON.stringify(cjsSystem)})`,
              );
              allFieldsMatch = false;
            }
            if (tsDesc !== cjsDesc) {
              fail(
                `CJS↔TS parity (12d-ii): SYSTEM_EMAIL_TEMPLATES['${entryKey}'] description mismatch` +
                ` (TS: ${JSON.stringify(tsDesc)}, CJS: ${JSON.stringify(cjsDesc)})`,
              );
              allFieldsMatch = false;
            }
          }
          if (allFieldsMatch) {
            pass('CJS↔TS parity (12d-ii): SYSTEM_EMAIL_TEMPLATES sentFrom, system, and description fields match');
          }
        }
      }
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

// ── 15. server.js validator keys == registry keys ─────────────────────────────
{
  const serverSrc = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
  // Extract keys from CARD_ACTION_HANDLER_CONFIG_VALIDATORS by finding the
  // block and collecting top-level method/property identifiers.
  const blockStart = serverSrc.indexOf('const CARD_ACTION_HANDLER_CONFIG_VALIDATORS = {');
  if (blockStart === -1) {
    assert(false, 'Check 15: CARD_ACTION_HANDLER_CONFIG_VALIDATORS not found in server.js');
  } else {
    const after  = serverSrc.slice(blockStart);
    let depth    = 0;
    let inBlock  = false;
    const validatorKeys = new Set();
    for (const line of after.split('\n')) {
      if (!inBlock) {
        if (line.includes('{')) { inBlock = true; depth = 1; }
        continue;
      }
      // Check for a top-level key BEFORE updating depth for this line.
      // A top-level entry is a line at depth 1 (still inside the outer object)
      // that starts a new method/property.
      if (depth === 1) {
        const m = line.match(/^\s{2}([a-z_][a-z0-9_]*)\s*[\(({]/);
        if (m) validatorKeys.add(m[1]);
      }
      depth += (line.match(/\{/g) || []).length;
      depth -= (line.match(/\}/g) || []).length;
      if (depth <= 0) break;
    }
    const registryKeys = new Set(Object.keys(HANDLER_OUTCOMES));
    const missingFromValidator = [...registryKeys].filter(k => !validatorKeys.has(k)).sort();
    const extraInValidator     = [...validatorKeys].filter(k => !registryKeys.has(k)).sort();
    assert(
      missingFromValidator.length === 0,
      `Check 15: CARD_ACTION_HANDLER_CONFIG_VALIDATORS is missing types that exist in the registry` +
        (missingFromValidator.length ? `: ${missingFromValidator.join(', ')}` : ''),
    );
    assert(
      extraInValidator.length === 0,
      `Check 15: CARD_ACTION_HANDLER_CONFIG_VALIDATORS has types not in the registry` +
        (extraInValidator.length ? `: ${extraInValidator.join(', ')}` : ''),
    );
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n──────────────────────────────────────────────────────────────────`);
if (failures > 0) {
  console.error(`\n${failures} drift-guard assertion(s) FAILED\n`);
  process.exit(1);
} else {
  console.log(`\nAll drift-guard assertions passed\n`);
}
