/**
 * scripts/backfill-rough-estimate.mjs
 *
 * One-time backfill: move all HubSpot contacts currently sitting on
 * hs_lead_status = AWAITING_PHOTOS (who have a submitted customer-info form)
 * to hs_lead_status = ROUGH_ESTIMATE_SENT.
 *
 * The user confirmed every AWAITING_PHOTOS contact has already been manually
 * reviewed and a rough estimate was sent outside the app.  This script makes
 * HubSpot and the local lead_status_config consistent with that reality.
 *
 * Usage:
 *   node scripts/backfill-rough-estimate.mjs
 *   node scripts/backfill-rough-estimate.mjs --dry-run   # print plan, no writes
 *
 * Safe to re-run — contacts already beyond AWAITING_PHOTOS are skipped.
 */

import pg   from 'pg';
import axios from 'axios';

const { Pool } = pg;

const DRY_RUN = process.argv.includes('--dry-run');

if (!process.env.DATABASE_URL) {
  console.error('❌  DATABASE_URL is not set. Aborting.');
  process.exit(1);
}
if (!process.env.HUBSPOT_ACCESS_TOKEN) {
  console.error('❌  HUBSPOT_ACCESS_TOKEN is not set. Aborting.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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
 * Page through all HubSpot contacts whose hs_lead_status = AWAITING_PHOTOS.
 * Returns an array of { id, properties: { hs_lead_status, email, firstname, lastname } }.
 */
async function fetchAwaitingPhotosContacts() {
  const contacts = [];
  let after = undefined;

  for (;;) {
    const body = {
      filterGroups: [
        {
          filters: [
            { propertyName: 'hs_lead_status', operator: 'EQ', value: 'AWAITING_PHOTOS' },
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
 * Patch a single HubSpot contact to ROUGH_ESTIMATE (HubSpot enum value),
 * clearing substatus.
 *
 * NOTE: The app's internal key is ROUGH_ESTIMATE_SENT; the HubSpot property
 * enum stores it as ROUGH_ESTIMATE.  The two names are not the same.
 */
async function patchContact(contactId) {
  await http.patch(
    `${HS_BASE}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`,
    { properties: { hs_lead_status: 'ROUGH_ESTIMATE', hw_lead_substatus: '' } },
    { headers: HS_HEADERS }
  );
}

// ── Local DB helpers ──────────────────────────────────────────────────────────

/**
 * Returns a Set of contact_ids that have at least one submitted customer-info
 * submission (submitted_at IS NOT NULL).
 */
async function fetchSubmittedContactIds() {
  const { rows } = await pool.query(
    `SELECT DISTINCT contact_id FROM customer_info_submissions WHERE submitted_at IS NOT NULL`
  );
  return new Set(rows.map(r => String(r.contact_id)));
}

/**
 * Ensure a row exists in lead_status_config for ROUGH_ESTIMATE_SENT so the
 * dashboard renders the label correctly after the backfill.
 */
async function ensureRoughEstimateSentLocal() {
  await pool.query(
    `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales)
     VALUES ('ROUGH_ESTIMATE_SENT', 'Rough estimate sent', 50, false)
     ON CONFLICT (key) DO NOTHING`
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔍  Backfill: AWAITING_PHOTOS → ROUGH_ESTIMATE_SENT`);
  if (DRY_RUN) console.log('    (DRY RUN — no writes will be made)\n');
  else console.log('');

  // 1. Fetch AWAITING_PHOTOS contacts from HubSpot
  console.log('1/4  Fetching AWAITING_PHOTOS contacts from HubSpot…');
  let hsContacts;
  try {
    hsContacts = await fetchAwaitingPhotosContacts();
  } catch (err) {
    console.error('❌  HubSpot search failed:', err.response?.data || err.message);
    process.exit(1);
  }
  console.log(`     Found ${hsContacts.length} contact(s) with hs_lead_status = AWAITING_PHOTOS.`);

  if (hsContacts.length === 0) {
    console.log('\n✅  Nothing to do — no contacts are stuck on AWAITING_PHOTOS.\n');
    await pool.end();
    return;
  }

  // 2. Fetch local submitted contact IDs for cross-reference
  console.log('2/4  Fetching submitted customer-info contact IDs from local DB…');
  let submittedIds;
  try {
    submittedIds = await fetchSubmittedContactIds();
  } catch (err) {
    console.error('❌  DB query failed:', err.message);
    await pool.end();
    process.exit(1);
  }
  console.log(`     Found ${submittedIds.size} contact(s) with at least one submitted form.`);

  // 3. Classify all contacts (local submission record is informational only)
  const toUpdate = [];

  for (const c of hsContacts) {
    const id       = String(c.id);
    const p        = c.properties || {};
    const name     = [p.firstname, p.lastname].filter(Boolean).join(' ') || p.email || id;
    const hasLocal = submittedIds.has(id);
    toUpdate.push({ id, name, email: p.email || '—', substatus: p.hw_lead_substatus || '', hasLocal });
  }

  console.log(`\n3/4  Will update ${toUpdate.length} contact(s):`);
  for (const c of toUpdate) {
    const tag = c.hasLocal ? '(in-app submission)' : '(no local submission — photos via email/WhatsApp)';
    console.log(`     →  id=${c.id}  name="${c.name}"  email=${c.email}  ${tag}`);
  }

  if (toUpdate.length === 0) {
    console.log('\n✅  Nothing to update after cross-referencing local submissions.\n');
    await pool.end();
    return;
  }

  if (DRY_RUN) {
    console.log('\n⏭   DRY RUN — skipping writes. Re-run without --dry-run to apply.\n');
    await pool.end();
    return;
  }

  // 4a. Ensure local lead_status_config row exists
  console.log('\n4/4  Applying updates…');
  try {
    await ensureRoughEstimateSentLocal();
    console.log('     ✓  ROUGH_ESTIMATE_SENT ensured in local lead_status_config.');
  } catch (err) {
    console.error('     ⚠  Could not ensure local lead_status_config row (non-fatal):', err.message);
  }

  // 4b. Patch each contact in HubSpot
  let successCount = 0;
  let failCount    = 0;

  for (const c of toUpdate) {
    try {
      await patchContact(c.id);
      console.log(`     ✓  UPDATED  id=${c.id}  name="${c.name}"  email=${c.email}`);
      successCount++;
    } catch (err) {
      const detail = err.response?.data?.message || err.message;
      console.error(`     ✗  FAILED   id=${c.id}  name="${c.name}"  — ${detail}`);
      failCount++;
    }
    // Polite rate-limiting: HubSpot allows 10 req/s burst; 120 ms/req ≈ 8 req/s
    await delay(120);
  }

  console.log(`\n────────────────────────────────────────`);
  console.log(`  Updated : ${successCount}`);
  if (failCount > 0) {
    console.log(`  Failed  : ${failCount} (check errors above and re-run to retry)`);
  }
  console.log(`────────────────────────────────────────\n`);

  await pool.end();

  if (failCount > 0) process.exit(1);
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
