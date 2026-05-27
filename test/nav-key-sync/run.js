'use strict';
// test/nav-key-sync/run.js
//
// Static lint: assert that the two server-side nav-key allow-lists and the
// BottomNav.tsx NAV array are not drifting apart.
//
// Three invariants are checked:
//
//   (1) VALID_NAV_KEYS_SERVER in auth.js  ===  VALID_NAV_KEYS in server.js
//       Both sets validate key submissions on the server.  They must always
//       be identical; if one is updated without the other the admin route
//       and the user-prefs route will accept different keys.
//
//   (2) Every key in BottomNav.tsx's NAV array is present in
//       VALID_NAV_KEYS_SERVER (auth.js).
//       If a key that users can actually navigate to is absent from the
//       server allow-list the PATCH /api/admin/nav-role-config route will
//       silently reject it with a 400, breaking nav-role config saves.
//
//   (3) Every key in BottomNav.tsx's NAV array is present in
//       VALID_NAV_KEYS (server.js).
//       Same rationale — guards the user-prefs PATCH route.
//
// Note: the server sets intentionally include keys beyond those in the NAV
// array (e.g. "sales", "survey", "trades", "ideas") because those pages are
// also reachable destinations.  The check is therefore NAV ⊆ server sets,
// not strict equality.  The equality check (invariant 1) ensures the two
// server sets stay in sync with each other.
//
// No server, no database, no Puppeteer — reads source files directly.
//
// Usage:
//   npm run test:nav-key-sync

const fs   = require('fs');
const path = require('path');

const ROOT         = path.resolve(__dirname, '../..');
const AUTH_JS      = path.join(ROOT, 'auth.js');
const SERVER_JS    = path.join(ROOT, 'server.js');
const BOTTOM_NAV   = path.join(ROOT, 'src', 'react', 'components', 'BottomNav.tsx');
const OUT          = path.join(ROOT, 'test-results', 'nav-key-sync.md');

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract the keys from a `new Set([…])` literal whose variable name matches
 * `varName`.  Returns a Set<string>.
 */
function extractSetLiteral(src, varName) {
  // Match:  const/let VARNAME = new Set(['a', 'b', …]);
  // The set literal may span multiple lines.
  const re = new RegExp(
    `(?:const|let|var)\\s+${varName}\\s*=\\s*new\\s+Set\\s*\\(\\s*\\[([^\\]]+)\\]\\s*\\)`,
    's',
  );
  const m = src.match(re);
  if (!m) return null;
  const body = m[1];
  const keys = new Set();
  const itemRe = /['"]([^'"]+)['"]/g;
  let item;
  while ((item = itemRe.exec(body)) !== null) {
    keys.add(item[1]);
  }
  return keys;
}

/**
 * Extract the `key` values from the `export const NAV: NavItem[] = […]`
 * array in BottomNav.tsx.  Returns a Set<string>.
 */
function extractNavKeys(src) {
  const match = src.match(/export\s+const\s+NAV\s*:[^=]+=\s*\[([\s\S]*?)\];/);
  if (!match) return null;
  const body = match[1];
  const keys = new Set();
  const keyRe = /\bkey\s*:\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = keyRe.exec(body)) !== null) {
    keys.add(m[1]);
  }
  return keys;
}

/** Pretty-print a Set<string> for the markdown report. */
function fmt(set) {
  return [...set].sort().map((k) => `\`${k}\``).join(', ');
}

// ── load sources ──────────────────────────────────────────────────────────────

let authSrc, serverSrc, navSrc;
try {
  authSrc   = fs.readFileSync(AUTH_JS,    'utf8');
  serverSrc = fs.readFileSync(SERVER_JS,  'utf8');
  navSrc    = fs.readFileSync(BOTTOM_NAV, 'utf8');
} catch (err) {
  console.error(`[nav-key-sync] Cannot read source file: ${err.message}`);
  process.exit(1);
}

// ── extract sets ──────────────────────────────────────────────────────────────

const authKeys   = extractSetLiteral(authSrc,   'VALID_NAV_KEYS_SERVER');
const serverKeys = extractSetLiteral(serverSrc, 'VALID_NAV_KEYS');
const navKeys    = extractNavKeys(navSrc);

const failures = [];

if (!authKeys) {
  failures.push('Could not locate `VALID_NAV_KEYS_SERVER` in `auth.js` — pattern did not match.');
}
if (!serverKeys) {
  failures.push('Could not locate `VALID_NAV_KEYS` in `server.js` — pattern did not match.');
}
if (!navKeys || navKeys.size === 0) {
  failures.push('Could not locate the `NAV` array (or it is empty) in `BottomNav.tsx`.');
}

if (failures.length > 0) {
  for (const f of failures) console.error(`[nav-key-sync] ${f}`);
  process.exit(1);
}

// ── invariant 1: auth.js set === server.js set ────────────────────────────────

const onlyInAuth   = [...authKeys].filter((k) => !serverKeys.has(k));
const onlyInServer = [...serverKeys].filter((k) => !authKeys.has(k));

if (onlyInAuth.length > 0) {
  failures.push(
    `Keys in \`VALID_NAV_KEYS_SERVER\` (auth.js) but NOT in \`VALID_NAV_KEYS\` (server.js): ${onlyInAuth.map((k) => `\`${k}\``).join(', ')}`,
  );
}
if (onlyInServer.length > 0) {
  failures.push(
    `Keys in \`VALID_NAV_KEYS\` (server.js) but NOT in \`VALID_NAV_KEYS_SERVER\` (auth.js): ${onlyInServer.map((k) => `\`${k}\``).join(', ')}`,
  );
}

// ── invariant 2: NAV keys ⊆ VALID_NAV_KEYS_SERVER (auth.js) ──────────────────

const missingFromAuth = [...navKeys].filter((k) => !authKeys.has(k));
if (missingFromAuth.length > 0) {
  failures.push(
    `NAV keys absent from \`VALID_NAV_KEYS_SERVER\` (auth.js) — PATCH /api/admin/nav-role-config will reject them: ${missingFromAuth.map((k) => `\`${k}\``).join(', ')}`,
  );
}

// ── invariant 3: NAV keys ⊆ VALID_NAV_KEYS (server.js) ───────────────────────

const missingFromServer = [...navKeys].filter((k) => !serverKeys.has(k));
if (missingFromServer.length > 0) {
  failures.push(
    `NAV keys absent from \`VALID_NAV_KEYS\` (server.js) — PATCH /api/users/me/prefs will reject them: ${missingFromServer.map((k) => `\`${k}\``).join(', ')}`,
  );
}

// ── report ────────────────────────────────────────────────────────────────────

const lines = [
  '# nav-key-sync',
  '',
  'Checks that the two server-side nav-key allow-lists stay in sync with each',
  'other and that every key in the `BottomNav.tsx` NAV array is accepted by both.',
  '',
  '## Sources',
  '',
  `| Source | Variable | Keys |`,
  `| ------ | -------- | ---- |`,
  `| \`auth.js\` | \`VALID_NAV_KEYS_SERVER\` | ${fmt(authKeys)} |`,
  `| \`server.js\` | \`VALID_NAV_KEYS\` | ${fmt(serverKeys)} |`,
  `| \`BottomNav.tsx\` | \`NAV[].key\` | ${fmt(navKeys)} |`,
  '',
  '## Invariants',
  '',
  `| # | Description | Result |`,
  `| - | ----------- | ------ |`,
  `| 1 | \`VALID_NAV_KEYS_SERVER\` (auth.js) === \`VALID_NAV_KEYS\` (server.js) | ${onlyInAuth.length === 0 && onlyInServer.length === 0 ? 'PASS' : '**FAIL**'} |`,
  `| 2 | Every NAV key ⊆ \`VALID_NAV_KEYS_SERVER\` (auth.js) | ${missingFromAuth.length === 0 ? 'PASS' : '**FAIL**'} |`,
  `| 3 | Every NAV key ⊆ \`VALID_NAV_KEYS\` (server.js) | ${missingFromServer.length === 0 ? 'PASS' : '**FAIL**'} |`,
  '',
];

if (failures.length === 0) {
  lines.push('**All invariants passed.**');
} else {
  lines.push(`**${failures.length} invariant${failures.length === 1 ? '' : 's'} failed:**`);
  lines.push('');
  for (const f of failures) {
    lines.push(`- ${f}`);
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n') + '\n');

// ── console summary ───────────────────────────────────────────────────────────

if (failures.length === 0) {
  console.log(
    `[nav-key-sync] auth.js VALID_NAV_KEYS_SERVER (${authKeys.size}) === server.js VALID_NAV_KEYS (${serverKeys.size}); all ${navKeys.size} NAV keys accepted by both. ✓`,
  );
} else {
  console.error(`[nav-key-sync] ${failures.length} invariant${failures.length === 1 ? '' : 's'} failed:`);
  for (const f of failures) {
    console.error(`  • ${f}`);
  }
  process.exit(1);
}
