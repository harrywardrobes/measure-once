import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { GlobalHeader, ServiceStatusBadge } from './GlobalHeader';
import type { ConnectionService, ServiceStatus } from '../contexts/ConnectionToastContext';
import { BRAND_COLORS } from '../theme';

const meta: Meta<typeof GlobalHeader> = {
  title: 'Components/Navigation/GlobalHeader',
  tags: ['autodocs'],
  component: GlobalHeader,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Fixed top app bar rendered on every page. Shows back navigation, search, service-status indicators, and role-gated shortcuts. Admin users see additional Admin panel and Design system icon buttons.',
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof GlobalHeader>;

// ── Nav role stories ──────────────────────────────────────────────────────────

export const MemberView: Story = {
  name: 'Member — standard nav (no admin buttons)',
  render: () => {
    history.replaceState(null, '', '/');
    (window as { __moHeaderUser?: { privilege_level: string } }).__moHeaderUser = { privilege_level: 'member' };
    return (
      <Box sx={{ minHeight: 80 }}>
        <GlobalHeader />
      </Box>
    );
  },
  parameters: {
    docs: {
      description: {
        story: 'Member view: Admin panel and Design system buttons are hidden.',
      },
    },
  },
};

export const AdminView: Story = {
  name: 'Admin — shows Admin panel + Design system buttons',
  render: () => {
    history.replaceState(null, '', '/');
    (window as { __moHeaderUser?: { privilege_level: string } }).__moHeaderUser = { privilege_level: 'admin' };
    return (
      <Box sx={{ minHeight: 80 }}>
        <GlobalHeader />
      </Box>
    );
  },
  parameters: {
    docs: {
      description: {
        story:
          'Admin view: both the Shield (Admin panel) button and the AutoStories (Design system) button are rendered immediately after the Customers icon.',
      },
    },
  },
};

export const AdminStorybookActive: Story = {
  name: 'Admin — Design system button active (on /storybook)',
  render: () => {
    history.replaceState(null, '', '/storybook/');
    (window as { __moHeaderUser?: { privilege_level: string } }).__moHeaderUser = { privilege_level: 'admin' };
    return (
      <Box sx={{ minHeight: 80 }}>
        <GlobalHeader />
      </Box>
    );
  },
  parameters: {
    docs: {
      description: {
        story:
          'When the current path starts with /storybook the Design system button renders in the active highlight style.',
      },
    },
  },
};

export const AdminAdminActive: Story = {
  name: 'Admin — Admin panel button active (on /admin)',
  render: () => {
    history.replaceState(null, '', '/admin');
    (window as { __moHeaderUser?: { privilege_level: string } }).__moHeaderUser = { privilege_level: 'admin' };
    return (
      <Box sx={{ minHeight: 80 }}>
        <GlobalHeader />
      </Box>
    );
  },
  parameters: {
    docs: {
      description: {
        story:
          'When the current path starts with /admin the Admin panel button shows the active highlight; Design system button does not.',
      },
    },
  },
};

// ── Service status badge stories ──────────────────────────────────────────────

const SERVICES: ConnectionService[] = ['hubspot', 'google', 'quickbooks'];
const SERVICE_LABELS: Record<ConnectionService, string> = {
  hubspot: 'HubSpot',
  google: 'Google',
  quickbooks: 'QuickBooks',
  database: 'Database',
};
const ALL_STATUSES: ServiceStatus[] = ['checking', 'ok', 'error', 'warning'];
const STATUS_LABELS: Record<ServiceStatus, string> = {
  checking: 'checking',
  ok: 'ok / connected',
  error: 'error / disconnected',
  warning: 'warning / degraded',
};

function PlumStrip({ children }: { children: React.ReactNode }) {
  return (
    <Box
      sx={{
        bgcolor: BRAND_COLORS.plum,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.5,
        px: 1.5,
        py: 1,
        borderRadius: 2,
      }}
    >
      {children}
    </Box>
  );
}

function StatusSection({ label, statuses }: {
  label: string;
  statuses: Partial<Record<ConnectionService, ServiceStatus>>;
}) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: (theme) => theme.typography.monoFontFamily }}>
        {label}
      </Typography>
      <PlumStrip>
        {SERVICES.map((svc) => (
          <ServiceStatusBadge
            key={svc}
            service={svc}
            status={statuses[svc] ?? 'ok'}
          />
        ))}
      </PlumStrip>
    </Box>
  );
}

export const ServiceStatusBadgePalette: Story = {
  name: 'Service Status — all states palette',
  render: () => (
    <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 480 }}>
        Every combination of service × status. Each badge uses a coloured dot
        (badge) overlay on the icon. The <strong>checking</strong> dot pulses
        with a CSS opacity animation. Hover each badge to read the tooltip.
      </Typography>

      {/* Grid: one row per status */}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {ALL_STATUSES.map((st) => (
          <Box key={st} sx={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <Typography
              variant="caption"
              sx={{
                width: 140,
                flexShrink: 0,
                fontFamily: (theme) => theme.typography.monoFontFamily,
                color: 'text.secondary',
              }}
            >
              {STATUS_LABELS[st]}
            </Typography>
            <PlumStrip>
              {SERVICES.map((svc) => (
                <ServiceStatusBadge key={svc} service={svc} status={st} />
              ))}
            </PlumStrip>
            <Typography variant="caption" sx={{ color: 'text.disabled' }}>
              {SERVICES.map((s) => SERVICE_LABELS[s]).join(' · ')}
            </Typography>
          </Box>
        ))}
      </Box>

      {/* Individual badges labelled */}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Typography variant="subtitle2">All services × all states</Typography>
        <Box sx={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {SERVICES.map((svc) => (
            <Box key={svc} sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <Typography variant="caption" sx={{ fontFamily: (theme) => theme.typography.monoFontFamily, color: 'text.secondary' }}>
                {SERVICE_LABELS[svc]}
              </Typography>
              <PlumStrip>
                {ALL_STATUSES.map((st) => (
                  <ServiceStatusBadge key={st} service={svc} status={st} />
                ))}
              </PlumStrip>
              <Box sx={{ display: 'flex', gap: 0.5 }}>
                {ALL_STATUSES.map((st) => (
                  <Typography
                    key={st}
                    variant="caption"
                    sx={{ fontSize: 9, color: 'text.disabled', width: 28, textAlign: 'center', fontFamily: (theme) => theme.typography.monoFontFamily }}
                  >
                    {st.slice(0, 4)}
                  </Typography>
                ))}
              </Box>
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  ),
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        story:
          'All four `ServiceStatus` values rendered for each of the three visible services. ' +
          'Badge dot colours: grey pulse = checking, green = ok, red = error, amber = warning. ' +
          'Icon tint matches: neutral = checking, green-tinted = ok, red-tinted = error, yellow-tinted = warning.',
      },
    },
  },
};

export const ServiceStatusAllChecking: Story = {
  name: 'Service Status — all checking (initial load)',
  render: () => (
    <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography variant="body2" color="text.secondary">
        All three service icons in the <strong>checking</strong> state — the
        default immediately after page load before status endpoints respond. The
        badge dot is neutral grey and pulses.
      </Typography>
      <StatusSection label="all: checking" statuses={{ hubspot: 'checking', google: 'checking', quickbooks: 'checking' }} />
    </Box>
  ),
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        story:
          'Initial state shown on every page load. All three dots are neutral grey and animate with a slow opacity pulse while the three `/api/*/status` endpoints are in-flight.',
      },
    },
  },
};

export const ServiceStatusAllOk: Story = {
  name: 'Service Status — all connected (ok)',
  render: () => (
    <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography variant="body2" color="text.secondary">
        All three services report <strong>connected</strong>. Badge dots are
        green; icon tint is green. Tooltip reads "… — connected".
      </Typography>
      <StatusSection label="all: ok" statuses={{ hubspot: 'ok', google: 'ok', quickbooks: 'ok' }} />
    </Box>
  ),
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        story:
          'Happy path: all status endpoints returned `connected: true`. Green dot + green icon tint. No animation.',
      },
    },
  },
};

export const ServiceStatusOneError: Story = {
  name: 'Service Status — one disconnected (HubSpot error)',
  render: () => (
    <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography variant="body2" color="text.secondary">
        HubSpot is in the <strong>error / disconnected</strong> state (5xx or
        network failure). Its dot is red; icon tint is red. Google and
        QuickBooks are connected.
      </Typography>
      <StatusSection
        label="hubspot: error | google: ok | quickbooks: ok"
        statuses={{ hubspot: 'error', google: 'ok', quickbooks: 'ok' }}
      />
    </Box>
  ),
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        story:
          'One service has errored. The HubSpot icon shows a red dot and a red-tinted icon. ' +
          'Tooltip reads "HubSpot — disconnected". Triggered by a 5xx response or network-level failure on `/api/hubspot/status`.',
      },
    },
  },
};

export const ServiceStatusOneWarning: Story = {
  name: 'Service Status — one degraded (Google warning)',
  render: () => (
    <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography variant="body2" color="text.secondary">
        Google is in the <strong>warning / degraded</strong> state (e.g. 429
        rate-limit). Its dot is amber; icon tint is yellow. HubSpot and
        QuickBooks are connected.
      </Typography>
      <StatusSection
        label="hubspot: ok | google: warning | quickbooks: ok"
        statuses={{ hubspot: 'ok', google: 'warning', quickbooks: 'ok' }}
      />
    </Box>
  ),
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        story:
          'One service is degraded (rate-limited or partial failure). The Google icon shows an amber dot and a yellow-tinted icon. ' +
          'Tooltip reads "Google — degraded". Triggered by a 429 response or an explicit `notifyApiWarning` call.',
      },
    },
  },
};

export const ServiceStatusMixedStates: Story = {
  name: 'Service Status — mixed states',
  render: () => (
    <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography variant="body2" color="text.secondary">
        A mixed real-world scenario: HubSpot connected, Google degraded
        (rate-limited), QuickBooks disconnected.
      </Typography>
      <StatusSection
        label="hubspot: ok | google: warning | quickbooks: error"
        statuses={{ hubspot: 'ok', google: 'warning', quickbooks: 'error' }}
      />
    </Box>
  ),
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        story:
          'Shows how the three icons look independently — each badge reflects only its own service. ' +
          'A user can instantly see which services are healthy, degraded, or disconnected without leaving the page.',
      },
    },
  },
};
