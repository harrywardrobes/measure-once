'use strict';
// test/hw-test-user/mock-hubspot.js
//
// Lightweight mock HubSpot API server for the hw-test-user test suite.
// Handles the subset of HubSpot CRM endpoints actually called by the
// server routes under test:
//
//   POST /crm/v3/objects/contacts/search
//     Used by getSharedContactsCache() (→ /api/contacts-all),
//     /api/open-leads, and /api/contacts-lead-status-counts.
//
// The mock evaluates the filterGroups from the request body against its
// in-memory contacts list so the dev-filter behaviour is tested end-to-end.

const http = require('http');

// ── mock contacts ─────────────────────────────────────────────────────────────
// Two contacts that match the OPEN_DEAL status (for /api/open-leads) and
// one that does not.  Two have hw_test_user=true; two do not.
const MOCK_CONTACTS = [
  {
    id: 'mock-1',
    properties: {
      firstname: 'Alice', lastname: 'Flagged',
      email: 'alice@mock.local', phone: '',
      hs_lead_status: 'OPEN_DEAL',
      hw_test_user: 'true',
      createdate: '2024-01-03T00:00:00.000Z',
      lastmodifieddate: '2024-01-03T00:00:00.000Z',
      city: '', zip: '', customer_number: '', closedate: '',
    },
  },
  {
    id: 'mock-2',
    properties: {
      firstname: 'Bob', lastname: 'Unflagged',
      email: 'bob@mock.local', phone: '',
      hs_lead_status: 'OPEN_DEAL',
      hw_test_user: 'false',
      createdate: '2024-01-02T00:00:00.000Z',
      lastmodifieddate: '2024-01-02T00:00:00.000Z',
      city: '', zip: '', customer_number: '', closedate: '',
    },
  },
  {
    id: 'mock-3',
    properties: {
      firstname: 'Carol', lastname: 'NoFlag',
      email: 'carol@mock.local', phone: '',
      hs_lead_status: 'CUSTOMER',
      // hw_test_user property absent
      createdate: '2024-01-01T00:00:00.000Z',
      lastmodifieddate: '2024-01-01T00:00:00.000Z',
      city: '', zip: '', customer_number: '', closedate: '',
    },
  },
  {
    id: 'mock-4',
    properties: {
      firstname: 'Dan', lastname: 'FlaggedCustomer',
      email: 'dan@mock.local', phone: '',
      hs_lead_status: 'CUSTOMER',
      hw_test_user: 'true',
      createdate: '2024-01-01T00:00:00.000Z',
      lastmodifieddate: '2024-01-01T00:00:00.000Z',
      city: '', zip: '', customer_number: '', closedate: '',
    },
  },
];

// ── filter evaluator ──────────────────────────────────────────────────────────
// Evaluates a single HubSpot filter object against a contact's properties.
function matchesFilter(contact, filter) {
  const val = contact.properties[filter.propertyName];
  switch (filter.operator) {
    case 'EQ':            return val === filter.value;
    case 'NEQ':           return val !== filter.value;
    case 'HAS_PROPERTY':  return val !== undefined && val !== null && val !== '';
    case 'NOT_HAS_PROPERTY': return val === undefined || val === null || val === '';
    default:              return true; // unknown operators — pass through
  }
}

// A contact matches if it satisfies ALL filters in at least one filterGroup.
function matchesFilterGroups(contact, filterGroups) {
  if (!filterGroups || filterGroups.length === 0) return true;
  return filterGroups.some(group =>
    (group.filters || []).every(f => matchesFilter(contact, f))
  );
}

// ── request handler ───────────────────────────────────────────────────────────
function handleRequest(req, res) {
  const chunks = [];
  req.on('data', d => chunks.push(d));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch {}

    // All contact search requests.
    if (req.method === 'POST' && req.url.includes('/contacts/search')) {
      const filtered = MOCK_CONTACTS.filter(c =>
        matchesFilterGroups(c, body.filterGroups)
      );
      const total   = filtered.length;
      const limit   = body.limit || 100;
      const results = filtered.slice(0, limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results, total, paging: null }));
      return;
    }

    // Property creation (fired on server boot to ensure hw_test_user exists).
    if (req.method === 'POST' && req.url.includes('/properties')) {
      // 409 = "already exists" — server tolerates this.
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'already exists' }));
      return;
    }

    // Fallback: 404.
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `mock: unhandled ${req.method} ${req.url}` }));
  });
}

// ── start / stop ──────────────────────────────────────────────────────────────
function startMockHubspot(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handleRequest);
    server.listen(port, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

function stopMockHubspot(server) {
  return new Promise(resolve => server.close(resolve));
}

module.exports = { startMockHubspot, stopMockHubspot, MOCK_CONTACTS };
