import HubIcon from '@mui/icons-material/Hub';
import EventIcon from '@mui/icons-material/Event';
import ReceiptIcon from '@mui/icons-material/Receipt';
import StorageIcon from '@mui/icons-material/Storage';
import type { ComponentType } from 'react';
import type { ConnectionService, ServiceStatus } from '../context/ConnectionToastContext';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ServiceDescriptor {
  key: ConnectionService;
  label: string;
  Icon: ComponentType<{ fontSize?: 'small' | 'medium' }>;
  /**
   * How the service is managed from the "Connect your services" modal:
   *   'oauth'        — user can OAuth-connect/disconnect via buttons
   *   'admin-only'   — only admins can connect/disconnect; non-admins see an info note
   *   'managed'      — connected via server-side config; no in-app connect flow;
   *                    optionally expose a settings link via `settingsHref`
   *   'status-only'  — shown in the navbar but excluded from the modal
   */
  connect: 'oauth' | 'admin-only' | 'managed' | 'status-only';
  /** URL that initiates the OAuth connection flow (oauth/admin-only only) */
  connectUrl?: string;
  /**
   * POST URL to disconnect the service (oauth/admin-only only).
   * On success the caller must call notifyDisconnected() to update the status icons.
   */
  disconnectUrl?: string;
  /**
   * Link to the admin settings page for managed services (managed only).
   * Shown as "Manage in settings →" when the service is in error/warning state.
   */
  settingsHref?: string;
  /** One-line contextual description shown in the modal row */
  helpText: string;
}

// ── Registry ──────────────────────────────────────────────────────────────────
//
// Adding a new integration only requires one new ServiceDescriptor entry here.
// Both the GlobalHeader status icon row and ConnectServicesModal derive from it.

export const SERVICE_DESCRIPTORS: ServiceDescriptor[] = [
  {
    key: 'google',
    label: 'Google Calendar',
    Icon: EventIcon,
    connect: 'oauth',
    connectUrl: '/auth/google',
    disconnectUrl: '/auth/logout-google',
    helpText: 'Used to book design and survey visits directly in your calendar.',
  },
  {
    key: 'quickbooks',
    label: 'QuickBooks',
    Icon: ReceiptIcon,
    connect: 'admin-only',
    connectUrl: '/auth/quickbooks',
    disconnectUrl: '/auth/quickbooks/disconnect',
    helpText: 'Used to create estimates and invoices for customers.',
  },
  {
    key: 'hubspot',
    label: 'HubSpot',
    Icon: HubIcon,
    connect: 'managed',
    settingsHref: '/admin#tab-settings',
    helpText: 'Stores customer contacts and tracks project pipeline stages.',
  },
  {
    key: 'database',
    label: 'Database',
    Icon: StorageIcon,
    connect: 'status-only',
    helpText: 'Internal database. Contact support if this shows an error.',
  },
];

/** O(1) lookup by service key */
export const SERVICE_DESCRIPTOR_MAP = Object.fromEntries(
  SERVICE_DESCRIPTORS.map((d) => [d.key, d]),
) as Record<ConnectionService, ServiceDescriptor>;

/** All services shown in the navbar (all four) */
export const SERVICE_KEYS: ConnectionService[] = SERVICE_DESCRIPTORS.map((d) => d.key);

// ── Shared status utilities ────────────────────────────────────────────────────
// Co-located here so GlobalHeader and ConnectServicesModal share the same
// label/color logic without copy-pasting.

export function statusLabel(service: ConnectionService, status: ServiceStatus): string {
  const name = SERVICE_DESCRIPTOR_MAP[service].label;
  if (status === 'checking') return `Checking ${name} connection…`;
  if (status === 'error') return `${name} — disconnected`;
  if (status === 'warning') return `${name} — degraded`;
  return `${name} — connected`;
}

export function statusBadgeColor(status: ServiceStatus): string {
  if (status === 'error') return '#ef4444';    // hex-color-ok: badge dot, no theme token
  if (status === 'warning') return '#f59e0b';  // hex-color-ok: badge dot, no theme token
  if (status === 'ok') return '#22c55e';       // hex-color-ok: badge dot, no theme token
  return 'rgba(255,255,255,0.35)';             // checking — neutral grey
}
