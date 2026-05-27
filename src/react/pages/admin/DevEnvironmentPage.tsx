import React from 'react';
import { Alert, Box, Card, CardContent, Chip, Stack, Typography } from '@mui/material';

/**
 * Admin → Dev environment tab (#tab-devenv, hidden in production).
 *
 * This panel is the single source of truth shown to admins for "what is
 * dev-only in here". Whenever you add a new dev-only feature to the admin
 * panel, you MUST add a matching entry to DEV_ONLY_FEATURES below. See the
 * "Dev-only admin features" convention in replit.md.
 */

const DEV_ONLY_FEATURES: Array<{
  name: string;
  location: string;
  description: React.ReactNode;
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
  },
  {
    name: 'Storybook dev server',
    location: 'Port 6006 — npm run watch:storybook',
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
  },
];

export function DevEnvironmentPage() {
  return (
    <Stack spacing={2}>
      <Alert severity="warning" variant="outlined">
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          You are in development mode
        </Typography>
        <Typography variant="body2">
          The items listed below are <strong>not visible in the published app</strong>. They are
          suppressed when <code className="adm-devenv-banner-code">NODE_ENV=production</code>.
        </Typography>
      </Alert>

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
              </Box>
            ))}
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}

export default DevEnvironmentPage;
