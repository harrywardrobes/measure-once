// hubspot-creds.js — Shared HubSpot credential resolution.
// Credentials are read exclusively from environment variables.
// Both server.js and design-visits.js import this module.

const CRED_MAP = {
  access_token:  { envKey: 'HUBSPOT_ACCESS_TOKEN' },
  app_id:        { envKey: 'HUBSPOT_APP_ID' },
  client_secret: { envKey: 'HUBSPOT_CLIENT_SECRET' },
};

// Returns the active credential value from the environment, or null if unset.
function getCredential(name) {
  const entry = CRED_MAP[name];
  if (!entry) return null;
  return process.env[entry.envKey] ?? null;
}

module.exports = {
  getCredential,
  CRED_MAP,
};
