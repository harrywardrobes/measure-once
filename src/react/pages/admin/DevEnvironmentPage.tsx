import React, { useEffect, useState } from 'react';
import { Alert, Box, Button, Card, CardContent, Chip, CircularProgress, FormControlLabel, Stack, Switch, Typography } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import LinkIcon from '@mui/icons-material/Link';
import { usePageTitle } from '../../hooks/usePageTitle';

/**
 * Admin → Dev environment tab (#tab-devenv).
 *
 * This panel is the single source of truth shown to admins for "what is
 * dev-only in here". Whenever you add a new dev-only feature to the admin
 * panel, you MUST add a matching entry to DEV_ONLY_FEATURES below. See the
 * "Dev-only admin features" convention in replit.md.
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
      value: 'curl -X POST "$REPLIT_DEV_DOMAIN/api/admin/test/seed-contacts-cache"',
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
      value: 'curl -X POST "$REPLIT_DEV_DOMAIN/api/admin/test/bust-contacts-cache"',
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
      value: 'curl -X POST "$REPLIT_DEV_DOMAIN/api/admin/test/bust-project-contacts-cache"',
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
  usePageTitle('Developer · Measure Once');
  const [storybookAvailable, setStorybookAvailable] = useState<boolean>(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const [devMode, setDevMode] = useState<boolean | null>(null);
  const [devModeLoading, setDevModeLoading] = useState<boolean>(true);
  const [devModeToggling, setDevModeToggling] = useState<boolean>(false);
  const [devModeError, setDevModeError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/storybook/', { method: 'HEAD' })
      .then((res) => setStorybookAvailable(res.ok))
      .catch(() => setStorybookAvailable(false));
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
