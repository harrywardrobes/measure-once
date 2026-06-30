import React, { useEffect, useState } from 'react';
import { Alert, Accordion, AccordionDetails, AccordionSummary, Box, Button, Card, CardContent, Chip, CircularProgress, Divider, FormControlLabel, Stack, Switch, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import LinkIcon from '@mui/icons-material/Link';
import { usePageTitle } from '../../hooks/usePageTitle';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

/**
 * Admin → Dev environment tab (#tab-devenv).
 *
 * This panel is the single source of truth shown to admins for "what is
 * dev-only in here". Whenever you add a new dev-only feature to the admin
 * panel, you MUST add a matching entry to DEV_ONLY_FEATURES below. See the
 * "Dev-only admin features" convention in CLAUDE.md.
 */

type DevFeatureAction =
  | { kind: 'link'; href: string; label: string; availableKey?: string }
  | { kind: 'copy'; value: string; label: string }
  | { kind: 'navigate'; tab: string; scrollTo: string; label: string };

const DEV_ONLY_FEATURES: Array<{
  name: string;
  location: string;
  description: React.ReactNode;
  action?: DevFeatureAction;
}> = [
  {
    name: 'Seed contacts cache',
    location: 'Internal API only',
    description: (
      <>
        Internal API endpoint (
        <code className="adm-inline-code">POST /api/admin/test/seed-contacts-cache</code>) used by
        automated tests to inject synthetic contacts into the server-side cache without a real
        HubSpot token. Excluded from production because injecting fake contacts into a live cache
        would corrupt real customer data.
      </>
    ),
    action: {
      kind: 'copy',
      value: 'curl -X POST "${APP_URL}/api/admin/test/seed-contacts-cache"',
      label: 'Copy curl snippet',
    },
  },
  {
    name: 'Bust contacts cache',
    location: 'Internal API only',
    description: (
      <>
        Internal API endpoint (
        <code className="adm-inline-code">POST /api/admin/test/bust-contacts-cache</code>) used by
        automated tests to clear the server-side contacts cache so the next request triggers a
        fresh HubSpot scan. Excluded from production because forcibly invalidating the shared cache
        in a live environment would cause unnecessary load on HubSpot and degrade response times
        for all users.
      </>
    ),
    action: {
      kind: 'copy',
      value: 'curl -X POST "${APP_URL}/api/admin/test/bust-contacts-cache"',
      label: 'Copy curl snippet',
    },
  },
  {
    name: 'Bust project-contacts cache',
    location: 'Internal API only',
    description: (
      <>
        Internal API endpoint (
        <code className="adm-inline-code">POST /api/admin/test/bust-project-contacts-cache</code>)
        used by automated tests to expire the server-side project-contacts cache (used by the
        Projects page to load cards for all pipeline stages). Sets{' '}
        <code className="adm-inline-code">fetchedAt = 0</code> so the next request triggers a
        fresh HubSpot fetch while keeping stale data available as a fallback. Excluded from
        production to avoid causing unnecessary HubSpot load.
      </>
    ),
    action: {
      kind: 'copy',
      value: 'curl -X POST "${APP_URL}/api/admin/test/bust-project-contacts-cache"',
      label: 'Copy curl snippet',
    },
  },
  {
    name: 'Storybook dev server',
    location: 'Port 6006 — npm run watch:storybook',
    action: {
      kind: 'link',
      href: '/storybook/',
      label: 'Open design-system gallery',
      availableKey: 'storybook',
    },
    description: (
      <>
        A local Storybook dev server with Hot Module Replacement for iterating on the design-system
        gallery (<code className="adm-inline-code">src/react/stories/</code>). Start it with{' '}
        <code className="adm-inline-code">npm run watch:storybook</code> and open the gallery on{' '}
        <strong>port 6006</strong>. This is a build-time development tool — it has no equivalent in
        the published app. The static Storybook build served by Express at{' '}
        <code className="adm-inline-code">/storybook/</code> is updated separately via{' '}
        <code className="adm-inline-code">npm run build:storybook</code>.
      </>
    ),
  },
  {
    name: 'Boot-time database migrations',
    location: 'server.js — startup IIFE / runMigrations()',
    description: (
      <>
        <code className="adm-inline-code">runMigrations()</code> (node-pg-migrate) only runs when{' '}
        <code className="adm-inline-code">NODE_ENV !== &apos;production&apos;</code>. In production,
        migrations are applied by a pre-deploy <code className="adm-inline-code">npm run db:migrate</code>
        step before new instances roll out (see docs/deploy.md). Running them again at boot would be
        a no-op, but skipping is the safe default for multi-instance Cloud Run deployments. Set{' '}
        <code className="adm-inline-code">RUN_MIGRATIONS_ON_BOOT=true</code> to opt into boot-time
        migration runs. Data-seeding statements inside migrations do not run in production; seed data
        is expected to already be present from the original setup or handled with ON CONFLICT DO
        NOTHING guards.
      </>
    ),
  },
  {
    name: 'HubSpot dev mode — forced ON at every startup',
    location: 'server.js — startup IIFE',
    description: (
      <>
        When <code className="adm-inline-code">NODE_ENV !== &apos;production&apos;</code>, the server
        forces{' '}
        <code className="adm-inline-code">dev_mode_enabled = &apos;true&apos;</code> in{' '}
        <code className="adm-inline-code">app_settings</code> on <strong>every</strong> startup (
        <code className="adm-inline-code">INSERT … ON CONFLICT DO UPDATE SET value = &apos;true&apos;</code>
        ). This guarantees the dev-mode banner is always visible on localhost and real HubSpot
        contacts are never accidentally exposed — even if dev mode was toggled OFF during the
        previous session. Turning dev mode OFF via the Dev tab above takes effect immediately but is
        reset on the next server restart.
      </>
    ),
  },
  {
    name: 'HubSpot webhook — signature verification bypass',
    location: 'Settings tab → HubSpot Webhooks panel / POST /api/hubspot/webhook',
    description: (
      <>
        The webhook receiver endpoint (
        <code className="adm-inline-code">POST /api/hubspot/webhook</code>) is active in all
        environments, but when <code className="adm-inline-code">HUBSPOT_CLIENT_SECRET</code> is{' '}
        absent the HMAC-SHA256 signature check is <strong>skipped with a console warning</strong>{' '}
        rather than rejecting the request. This lets developers trigger the webhook manually (e.g.{' '}
        via curl) without setting up a real HubSpot app. In production the secret must be set — if
        it is absent, the endpoint returns 400 and discards every incoming request.
      </>
    ),
    action: {
      kind: 'navigate',
      tab: 'settings',
      scrollTo: 'hubspot-webhooks-card',
      label: 'Go to HubSpot Webhooks panel',
    },
  },
];

export function DevEnvironmentPage() {
  usePageTitle('Developer · Harry Wardrobes');
  const [storybookAvailable, setStorybookAvailable] = useState<boolean>(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [isDevelopment, setIsDevelopment] = useState<boolean>(false);

  const [devMode, setDevMode] = useState<boolean | null>(null);
  const [devModeLoading, setDevModeLoading] = useState<boolean>(true);
  const [devModeToggling, setDevModeToggling] = useState<boolean>(false);
  const [devModeError, setDevModeError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/storybook/', { method: 'HEAD' })
      .then((res) => setStorybookAvailable(res.ok))
      .catch(() => setStorybookAvailable(false));
    fetch('/api/admin/server-env')
      .then((res) => res.ok ? res.json() : { isDevelopment: false })
      .then((data) => setIsDevelopment(Boolean(data.isDevelopment)))
      .catch(() => setIsDevelopment(false));
  }, []);

  useEffect(() => {
    setDevModeLoading(true);
    fetch('/api/admin/hubspot/dev-mode')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        setDevMode(data.devMode);
        setDevModeError(null);
      })
      .catch((e) => setDevModeError(e.message))
      .finally(() => setDevModeLoading(false));
  }, []);

  async function handleDevModeToggle() {
    if (devMode === null) return;
    const next = !devMode;
    setDevModeToggling(true);
    setDevModeError(null);
    try {
      const res = await fetch('/api/admin/hubspot/dev-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ devMode: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setDevMode(next);
      try {
        const bc = new BroadcastChannel('dev_mode_changed');
        bc.postMessage({ devMode: next });
        bc.close();
      } catch { /* BroadcastChannel not available */ }
    } catch (e: unknown) {
      setDevModeError(e instanceof Error ? e.message : 'Could not save dev-mode setting.');
    } finally {
      setDevModeToggling(false);
    }
  }

  function isLinkVisible(action: DevFeatureAction): boolean {
    if (action.kind === 'link' && action.availableKey === 'storybook') return storybookAvailable;
    return true;
  }

  function handleCopy(value: string, key: string) {
    navigator.clipboard.writeText(value).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    });
  }

  async function handleNavigate(tab: string, scrollTo: string) {
    const win = window as unknown as Record<string, unknown>;
    const switchTab = win.switchTab;
    if (typeof switchTab === 'function') {
      (switchTab as (id: string) => void)(tab);
    }
    const waitForElement = win.waitForElement;
    if (typeof waitForElement === 'function') {
      const el = await (waitForElement as (id: string) => Promise<HTMLElement | null>)(scrollTo);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      setTimeout(() => {
        document.getElementById(scrollTo)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 500);
    }
  }

  function renderAction(f: (typeof DEV_ONLY_FEATURES)[number]) {
    const { action } = f;
    if (!action) return null;

    if (action.kind === 'link') {
      if (!isLinkVisible(action)) return null;
      return (
        <Box sx={{ mt: 1.5 }}>
          <Button
            variant="outlined"
            size="small"
            href={action.href}
            target="_blank"
            rel="noopener noreferrer"
            endIcon={<OpenInNewIcon />}
          >
            {action.label}
          </Button>
        </Box>
      );
    }

    if (action.kind === 'copy') {
      const copied = copiedKey === f.name;
      return (
        <Box sx={{ mt: 1.5 }}>
          <Button
            variant="outlined"
            size="small"
            onClick={() => handleCopy(action.value, f.name)}
            startIcon={<ContentCopyIcon />}
            color={copied ? 'success' : 'primary'}
          >
            {copied ? 'Copied!' : action.label}
          </Button>
        </Box>
      );
    }

    if (action.kind === 'navigate') {
      return (
        <Box sx={{ mt: 1.5 }}>
          <Button
            variant="outlined"
            size="small"
            onClick={() => handleNavigate(action.tab, action.scrollTo)}
            startIcon={<LinkIcon />}
          >
            {action.label}
          </Button>
        </Box>
      );
    }

    return null;
  }

  return (
    <Stack spacing={2}>
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" sx={{ mb: 0.5 }}>
            Test-user filter (dev mode)
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            When dev mode is <strong>on</strong>, the customer list only shows contacts whose
            HubSpot property <code className="adm-inline-code">hw_test_user</code> is set to{' '}
            <code className="adm-inline-code">true</code>. This lets you run focused testing
            sessions against a curated set of dummy contacts without affecting other environments.
          </Typography>

          {devModeLoading ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <CircularProgress size={18} />
              <Typography variant="body2" color="text.secondary">Loading…</Typography>
            </Box>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <FormControlLabel
                control={
                  <Switch
                    checked={devMode === true}
                    onChange={handleDevModeToggle}
                    disabled={devModeToggling || devMode === null}
                    color="warning"
                  />
                }
                label={
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {devMode
                      ? 'Dev mode is ON — only test users are shown'
                      : 'Dev mode is OFF — all contacts are shown'}
                  </Typography>
                }
              />
              {devModeToggling && (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <CircularProgress size={14} />
                  <Typography variant="body2" color="text.secondary">Saving…</Typography>
                </Box>
              )}
              {devModeError && (
                <Alert severity="error" sx={{ mt: 1 }}>
                  {devModeError}
                </Alert>
              )}
            </Box>
          )}
        </CardContent>
      </Card>

      {isDevelopment && (
        <Accordion variant="outlined" disableGutters>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
              Developer cheatsheet
            </Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Quick reference for key server modules and recently renamed helpers.
              Only visible in non-production environments.
            </Typography>

            <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
              Domain abbreviation conventions
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              These prefixes were historically used as shorthand. All new code should use the full names below.
            </Typography>
            <Table size="small" sx={{ mb: 3 }}>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 700, width: '12%' }}>Abbrev</TableCell>
                  <TableCell sx={{ fontWeight: 700, width: '20%' }}>Full name</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>Examples of renamed symbols</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {([
                  { abbrev: 'hs', full: 'hubspot / HubSpot', examples: 'getHubSpotHeaders(), getHubSpotCredential(), getHubSpotBaseUrl()' },
                  { abbrev: 'qb', full: 'quickbooks / QuickBooks', examples: 'quickbooksRoutes, getQuickBooksBaseUrl(), fetchFromQuickBooks()' },
                  { abbrev: 'dv', full: 'designVisit / DESIGN_VISIT', examples: 'checkDesignVisitRateLimit(), _designVisitRateMap, DESIGN_VISIT_RATE_LIMIT' },
                  { abbrev: 'bc', full: 'descriptive channel name', examples: 'devModeChannel, draftChannel (BroadcastChannel locals in useProjectsData.ts)' },
                ] as Array<{ abbrev: string; full: string; examples: string }>).map((row) => (
                  <TableRow key={row.abbrev}>
                    <TableCell><code className="adm-inline-code">{row.abbrev}</code></TableCell>
                    <TableCell><Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>{row.full}</Typography></TableCell>
                    <TableCell><Typography variant="caption" color="text.secondary">{row.examples}</Typography></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <Divider sx={{ mb: 2 }} />

            <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
              Key server-side modules
            </Typography>
            <Table size="small" sx={{ mb: 3 }}>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 700, width: '22%' }}>File</TableCell>
                  <TableCell sx={{ fontWeight: 700, width: '40%' }}>Purpose</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>Key exports</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {([
                  { file: 'server.js', purpose: 'Main Express entry point — all routes, SSE, caches', exports: 'app, clearContactCache' },
                  { file: 'auth.js', purpose: 'Authentication, sessions, privilege middleware', exports: 'isAuthenticated, requireAdmin, requirePrivilege, getRequestPrivilegeLevel, verifyCaptchaToken' },
                  { file: 'design-visits.js', purpose: 'Design visit CRUD, QB/HubSpot sync, sign-off', exports: 'router, submitDesignVisitAndSync' },
                  { file: 'visits.js', purpose: 'Visit DB helpers and route handlers', exports: 'router, mapDatabaseRowToVisit' },
                  { file: 'quickbooks.js', purpose: 'QuickBooks OAuth and invoice API wrapper', exports: 'router, getQuickBooksBaseUrl, fetchFromQuickBooks' },
                  { file: 'customer-info.js', purpose: 'Customer info form, photo upload, SSE push', exports: 'router, getHubSpotBaseUrl, getHubSpotHeaders' },
                  { file: 'photo-reviews.js', purpose: 'Photo review outcomes and HubSpot status updates', exports: 'router, getHubSpotBaseUrl, getHubSpotHeaders' },
                  { file: 'design-visit-uploads.js', purpose: 'Signed URL generation for visit file storage', exports: 'router, uploadFromDataUrl, signImageUrl, verifySignedUrl' },
                  { file: 'rate-limiters.js', purpose: 'Express rate-limit middleware factory', exports: 'hubspotMutationLimiter, gmailSendLimiter, getUserRateLimitKey' },
                  { file: 'hubspot-creds.js', purpose: 'HubSpot credential lookup from DB', exports: 'getCredential, CRED_MAP' },
                ] as Array<{ file: string; purpose: string; exports: string }>).map((row) => (
                  <TableRow key={row.file}>
                    <TableCell><code className="adm-inline-code">{row.file}</code></TableCell>
                    <TableCell><Typography variant="caption" color="text.secondary">{row.purpose}</Typography></TableCell>
                    <TableCell><Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>{row.exports}</Typography></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <Divider sx={{ mb: 2 }} />

            <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
              Recently renamed helpers — use new names in all new code
            </Typography>
            {[
              {
                heading: 'Server-side',
                rows: [
                  { old: 'bustSharedCache()', next: 'clearContactCache()', file: 'server.js', note: 'Clears the shared contacts cache' },
                  { old: 'rowToVisit()', next: 'mapDatabaseRowToVisit()', file: 'visits.js', note: 'Maps a DB row to a visit object' },
                  { old: 'runSubmitSideEffects()', next: 'submitDesignVisitAndSync()', file: 'design-visits.js', note: 'Submits a visit and syncs QB / HubSpot' },
                  { old: 'verifyTurnstile()', next: 'verifyCaptchaToken()', file: 'auth.js', note: 'Verifies a Cloudflare Turnstile token' },
                  { old: 'getReqPrivilege(req)', next: 'getRequestPrivilegeLevel(req)', file: 'auth.js', note: 'Returns privilege level for a request' },
                  { old: 'qbBase()', next: 'getQuickBooksBaseUrl()', file: 'quickbooks.js', note: 'Returns QuickBooks API base URL' },
                  { old: 'qbRedirectUri()', next: 'getQuickBooksRedirectUri()', file: 'quickbooks.js', note: 'Returns OAuth redirect URI' },
                  { old: 'qbGet(path, params)', next: 'fetchFromQuickBooks(path, params)', file: 'quickbooks.js', note: 'Authenticated GET to QuickBooks API' },
                  { old: 'hsBase()', next: 'getHubSpotBaseUrl()', file: 'customer-info.js / photo-reviews.js', note: 'Returns HubSpot API base URL' },
                  { old: 'hsHeaders()', next: 'getHubSpotHeaders()', file: 'server.js / customer-info.js / photo-reviews.js', note: 'Returns HubSpot auth headers' },
                  { old: 'userKey(req)', next: 'getUserRateLimitKey(req)', file: 'rate-limiters.js', note: 'Returns per-user rate-limit key' },
                  { old: '_sign(key, exp)', next: '_createUrlSignature(key, exp)', file: 'design-visit-uploads.js', note: 'Creates HMAC signature for signed URL' },
                  { old: 'dvHsHeaders()', next: 'getHubSpotHeaders()', file: 'design-visits.js', note: 'Returns HubSpot auth headers for design-visit sync (dv + hs both expanded)' },
                  { old: 'dvHubspotRequestWithRetry()', next: 'hubspotRequestWithRetry()', file: 'design-visits.js', note: 'Retrying HubSpot API request helper (dv prefix dropped; already in design-visits module)' },
                  { old: 'checkDvRateLimit()', next: 'checkDesignVisitRateLimit()', file: 'design-visits.js', note: 'Per-user rate limiter for visit creation / submission' },
                  { old: 'DV_RATE_LIMIT / DV_RATE_WINDOW_MS', next: 'DESIGN_VISIT_RATE_LIMIT / DESIGN_VISIT_RATE_WINDOW_MS', file: 'design-visits.js', note: 'Rate-limit tuning constants' },
                  { old: 'hsGetCredential(key)', next: 'getHubSpotCredential(key)', file: 'design-visits.js', note: 'Looks up a HubSpot credential from DB (import alias renamed)' },
                  { old: 'qbRoutes', next: 'quickbooksRoutes', file: 'server.js', note: 'Express router for QuickBooks API routes' },
                ],
              },
              {
                heading: 'React — formatters',
                rows: [
                  { old: 'fmtGBP()', next: 'formatCurrency()', file: 'src/react/utils/formatters.ts', note: 'Formats a number as GBP currency' },
                  { old: 'fmtQBDate()', next: 'formatQuickBooksDate()', file: 'src/react/utils/formatters.ts', note: 'Formats a QuickBooks ISO date string' },
                  { old: 'escHtml()', next: 'escapeHtml()', file: 'src/react/utils/formatters.ts', note: 'Escapes HTML special characters' },
                ],
              },
              {
                heading: 'React — hooks',
                rows: [
                  { old: 'fetchNonce / setFetchNonce', next: 'refetchTrigger / setRefetchTrigger', file: 'src/react/hooks/useProjectsData.ts', note: 'Counter incremented to trigger a data refetch' },
                  { old: 'bc (dev mode BroadcastChannel)', next: 'devModeChannel', file: 'src/react/hooks/useProjectsData.ts', note: 'BroadcastChannel that listens for dev_mode_changed events' },
                  { old: 'bc (draft BroadcastChannel)', next: 'draftChannel', file: 'src/react/hooks/useProjectsData.ts', note: 'BroadcastChannel that listens for design_visit_draft_changed events' },
                ],
              },
            ].map((section) => (
              <Box key={section.heading} sx={{ mb: 2 }}>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {section.heading}
                </Typography>
                <Table size="small" sx={{ mt: 0.5 }}>
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700, width: '28%' }}>Old name</TableCell>
                      <TableCell sx={{ fontWeight: 700, width: '28%' }}>New name</TableCell>
                      <TableCell sx={{ fontWeight: 700, width: '18%' }}>File</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Notes</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {section.rows.map((row) => (
                      <TableRow key={row.old}>
                        <TableCell>
                          <code className="adm-inline-code" style={{ textDecoration: 'line-through', opacity: 0.55 }}>{row.old}</code>
                        </TableCell>
                        <TableCell>
                          <code className="adm-inline-code">{row.next}</code>
                        </TableCell>
                        <TableCell>
                          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', fontSize: '0.7rem' }}>{row.file}</Typography>
                        </TableCell>
                        <TableCell>
                          <Typography variant="caption" color="text.secondary">{row.note}</Typography>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
            ))}
          </AccordionDetails>
        </Accordion>
      )}

      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" sx={{ mb: 0.5 }}>
            Dev-only features in this panel
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Each entry below names the feature, the tab it lives in, and why it is excluded from
            production.
          </Typography>

          <Stack spacing={2}>
            {DEV_ONLY_FEATURES.map((f) => (
              <Box
                key={f.name}
                sx={{
                  p: 2,
                  borderRadius: 1,
                  border: 1,
                  borderColor: 'divider',
                }}
              >
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    mb: 1,
                    flexWrap: 'wrap',
                  }}
                >
                  <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{f.name}</Typography>
                  <Chip label={f.location} size="small" />
                </Box>
                <Typography variant="body2" color="text.secondary">
                  {f.description}
                </Typography>
                {renderAction(f)}
              </Box>
            ))}
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}

export default DevEnvironmentPage;
