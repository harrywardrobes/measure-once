/**
 * scripts/patch-rough-estimate-sent-contacts.mjs
 *
 * One-time remediation: find all HubSpot contacts whose hs_lead_status is
 * 'ROUGH_ESTIMATE_SENT' (the stale internal alias) and patch them to
 * 'ROUGH_ESTIMATE' (the correct HubSpot enum value), clearing hw_lead_substatus.
 *
 * Background: the app previously stamped contacts with 'ROUGH_ESTIMATE_SENT'
 * instead of 'ROUGH_ESTIMATE'.  After deploying the consolidation migration,
 * run this script once to fix any contacts that were incorrectly stamped.
 *
 * Usage:
 *   node scripts/patch-rough-estimate-sent-contacts.mjs
 *   node scripts/patch-rough-estimate-sent-contacts.mjs --dry-run
 *
 * Requires:
 *   HUBSPOT_ACCESS_TOKEN  — HubSpot private-app token with contacts write scope
 *
 * Safe to re-run — contacts already on ROUGH_ESTIMATE are not touched (they
 * won't appear in the search results).
 */

import axios from 'axios';

const DRY_RUN = process.argv.includes('--dry-run');

if (!process.env.HUBSPOT_ACCESS_TOKEN) {
  console.error('❌  HUBSPOT_ACCESS_TOKEN is not set. Aborting.');
  process.exit(1);
}

const HS_BASE    = process.env.HUBSPOT_API_BASE_OVERRIDE || 'https://api.hubapi.com';
const HS_HEADERS = {
  Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
  'Content-Type': 'application/json',
};

const http = axios.create({ timeout: 15000 });

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── HubSpot helpers ───────────────────────────────────────────────────────────

/**
 * Page through all HubSpot contacts whose hs_lead_status = ROUGH_ESTIMATE_SENT.
 * Returns an array of { id, properties: { hs_lead_status, email, firstname, lastname } }.
 */
async function fetchRoughEstimateSentContacts() {
  const contacts = [];
  let after = undefined;

  for (;;) {
    const body = {
      filterGroups: [
        {
          filters: [
            { propertyName: 'hs_lead_status', operator: 'EQ', value: 'ROUGH_ESTIMATE_SENT' },
          ],
        },
      ],
      properties: ['hs_lead_status', 'hw_lead_substatus', 'email', 'firstname', 'lastname'],
      limit: 100,
      ...(after ? { after } : {}),
    };

    const resp = await http.post(
      `${HS_BASE}/crm/v3/objects/contacts/search`,
      body,
      { headers: HS_HEADERS }
    );

    const { results, paging } = resp.data;
    contacts.push(...(results || []));

    if (paging?.next?.after) {
      after = paging.next.after;
      await delay(150); // stay well under the 10 req/s burst limit
    } else {
      break;
    }
  }

  return contacts;
}

/**
 * Patch a single HubSpot contact from ROUGH_ESTIMATE_SENT to ROUGH_ESTIMATE,
 * clearing substatus.
 */
async function patchContact(contactId) {
  await http.patch(
    `${HS_BASE}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`,
    { properties: { hs_lead_status: 'ROUGH_ESTIMATE', hw_lead_substatus: '' } },
    { headers: HS_HEADERS }
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔍  Patch: ROUGH_ESTIMATE_SENT → ROUGH_ESTIMATE`);
  if (DRY_RUN) console.log('    (DRY RUN — no writes will be made)\n');
  else console.log('');

  // 1. Search for affected contacts
  console.log('1/2  Fetching contacts with hs_lead_status = ROUGH_ESTIMATE_SENT…');
  let contacts;
  try {
    contacts = await fetchRoughEstimateSentContacts();
  } catch (err) {
    console.error('❌  HubSpot search failed:', err.response?.data || err.message);
    process.exit(1);
  }
  console.log(`     Found ${contacts.length} contact(s) with hs_lead_status = ROUGH_ESTIMATE_SENT.`);

  if (contacts.length === 0) {
    console.log('\n✅  Nothing to do — no contacts have hs_lead_status = ROUGH_ESTIMATE_SENT.\n');
    return;
  }

  console.log(`\n     Contacts to update:`);
  for (const c of contacts) {
    const p    = c.properties || {};
    const name = [p.firstname, p.lastname].filter(Boolean).join(' ') || p.email || c.id;
    console.log(`     →  id=${c.id}  name="${name}"  email=${p.email || '—'}`);
  }

  if (DRY_RUN) {
    console.log('\n⏭   DRY RUN — skipping writes. Re-run without --dry-run to apply.\n');
    return;
  }

  // 2. Patch each contact
  console.log('\n2/2  Applying updates…');
  let successCount = 0;
  let failCount    = 0;

  for (const c of contacts) {
    const p    = c.properties || {};
    const name = [p.firstname, p.lastname].filter(Boolean).join(' ') || p.email || c.id;
    try {
      await patchContact(c.id);
      console.log(`     ✓  UPDATED  id=${c.id}  name="${name}"  email=${p.email || '—'}`);
      successCount++;
    } catch (err) {
      const detail = err.response?.data?.message || err.message;
      console.error(`     ✗  FAILED   id=${c.id}  name="${name}"  — ${detail}`);
      failCount++;
    }
    // Polite rate-limiting: HubSpot allows 10 req/s burst; 120 ms/req ≈ 8 req/s
    await delay(120);
  }

  // Post-run verification: count remaining ROUGH_ESTIMATE_SENT contacts
  let remaining = '(skipped — failures present)';
  if (failCount === 0) {
    try {
      const verifyResp = await http.post(
        `${HS_BASE}/crm/v3/objects/contacts/search`,
        {
          filterGroups: [{ filters: [{ propertyName: 'hs_lead_status', operator: 'EQ', value: 'ROUGH_ESTIMATE_SENT' }] }],
          limit: 1,
        },
        { headers: HS_HEADERS }
      );
      remaining = String(verifyResp.data.total ?? verifyResp.data.results?.length ?? '?');
    } catch {
      remaining = '(verification request failed)';
    }
  }

  console.log(`\n────────────────────────────────────────`);
  console.log(`  Updated                         : ${successCount}`);
  if (failCount > 0) {
    console.log(`  Failed                          : ${failCount} (check errors above and re-run to retry)`);
  }
  console.log(`  Remaining ROUGH_ESTIMATE_SENT   : ${remaining}`);
  console.log(`────────────────────────────────────────\n`);

  if (failCount > 0) process.exit(1);
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
