#!/usr/bin/env node
'use strict';

// scripts/hw-test-user/seed-live-contact.js
//
// One-shot helper for the live HubSpot phase of test/hw-test-user/run.js
// (probes REAL-HS-03 and REAL-HS-06). Those probes only assert anything
// meaningful when the connected HubSpot account has at least one contact
// tagged with hw_test_user=true. Without such a contact the test still
// passes but emits a "WARNING: assertion is vacuous" message.
//
// This script creates (or deletes) a flagged contact directly via the
// HubSpot CRM API using HUBSPOT_TOKEN. It writes the hw_test_user property
// using the same semantics the admin PATCH endpoint
// (PATCH /api/admin/hubspot/test-users/:contactId) writes when toggling
// existing contacts from the UI.
//
// Usage:
//   HUBSPOT_TOKEN=… node scripts/hw-test-user/seed-live-contact.js
//     Creates a flagged contact (hs_lead_status=OPEN_DEAL, hw_test_user=true)
//     and prints its HubSpot contact id on stdout.
//
//   HUBSPOT_TOKEN=… node scripts/hw-test-user/seed-live-contact.js --delete <id>
//     Deletes the given contact from HubSpot.

const axios = require('axios');

const HS    = process.env.HUBSPOT_API_URL || 'https://api.hubapi.com';
const TOKEN = process.env.HUBSPOT_TOKEN;

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

if (!TOKEN) {
  die('HUBSPOT_TOKEN is required. Re-run with HUBSPOT_TOKEN=… node scripts/hw-test-user/seed-live-contact.js');
}

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

async function createContact() {
  const stamp = Date.now();
  const email = `hw-test-user+${stamp}@privtest.local`;
  const body = {
    properties: {
      email,
      firstname: 'HW',
      lastname:  `Test User ${stamp}`,
      hs_lead_status: 'OPEN_DEAL',
      hw_test_user:   true,
    },
  };
  try {
    const r = await axios.post(`${HS}/crm/v3/objects/contacts`, body, { headers });
    const id = r.data?.id;
    if (!id) die(`HubSpot created a contact but did not return an id: ${JSON.stringify(r.data)}`);
    console.log(`Created flagged contact ${id} (${email}).`);
    console.log(`To remove it: HUBSPOT_TOKEN=… node scripts/hw-test-user/seed-live-contact.js --delete ${id}`);
    console.log(id);
    return id;
  } catch (e) {
    const status = e.response?.status;
    const detail = e.response?.data?.message || e.message;
    if (status === 409) die(`HubSpot rejected the create (409 conflict — duplicate email?): ${detail}`);
    if (status === 401 || status === 403) die(`HubSpot rejected the token (status ${status}): ${detail}`);
    die(`HubSpot create failed (status ${status || '?'}): ${detail}`);
  }
}

async function deleteContact(id) {
  if (!/^\d+$/.test(String(id))) {
    die(`Invalid contact id: ${id}. Expected the numeric HubSpot id printed by the create step.`);
  }
  try {
    await axios.delete(
      `${HS}/crm/v3/objects/contacts/${encodeURIComponent(id)}`,
      { headers },
    );
    console.log(`Deleted contact ${id}.`);
  } catch (e) {
    const status = e.response?.status;
    const detail = e.response?.data?.message || e.message;
    if (status === 404) die(`Contact ${id} not found in HubSpot (already deleted?).`);
    if (status === 401 || status === 403) die(`HubSpot rejected the token (status ${status}): ${detail}`);
    die(`HubSpot delete failed (status ${status || '?'}): ${detail}`);
  }
}

(async () => {
  const args = process.argv.slice(2);
  const delIdx = args.indexOf('--delete');
  if (delIdx !== -1) {
    const id = args[delIdx + 1];
    if (!id) die('--delete requires a contact id. Example: --delete 123456789');
    await deleteContact(id);
    return;
  }
  if (args.length && args[0] !== '--create') {
    die(`Unknown argument: ${args[0]}. Usage:\n  node scripts/hw-test-user/seed-live-contact.js [--create]\n  node scripts/hw-test-user/seed-live-contact.js --delete <id>`);
  }
  await createContact();
})();
