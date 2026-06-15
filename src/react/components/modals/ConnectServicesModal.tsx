import React, { useCallback, useEffect, useReducer } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';
import {
  useServiceStatuses,
  useConnectionToast,
  type ConnectionService,
} from '../../context/ConnectionToastContext';
import { usePrivilege } from '../../hooks/usePrivilege';
import { SERVICE_DESCRIPTORS } from '../../lib/connectionServices';
import { CONNECT_MODAL_SHOWN_KEY } from '../../constants/localStorageKeys';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
  highlightService?: ConnectionService;
  /** When provided, renders an explanatory Alert above the service rows. Use
   *  this to give the user context about why the modal was opened — e.g.
   *  "Google Calendar is disconnected — reconnect it to schedule visits." */
  message?: string;
}

// ── Status chip ────────────────────────────────────────────────────────────────

function statusChipProps(status: string | undefined): {
  label: string;
  color: 'default' | 'success' | 'error' | 'warning';
} {
  if (status === 'ok')      return { label: 'Connected',    color: 'success' };
  if (status === 'error')   return { label: 'Disconnected', color: 'error'   };
  if (status === 'warning') return { label: 'Degraded',     color: 'warning' };
  return { label: 'Checking…', color: 'default' };
}

// ── Action cell ────────────────────────────────────────────────────────────────

interface ActionCellProps {
  serviceKey: ConnectionService;
  connect: 'oauth' | 'admin-only' | 'managed' | 'status-only';
  connectUrl?: string;
  disconnectUrl?: string;
  settingsHref?: string;
  isAdmin: boolean;
  status: string | undefined;
  isDisconnecting: boolean;
  onDisconnect: (service: ConnectionService, url: string) => void;
  /** Called when the user clicks Connect on an admin-only service (opens in new tab). */
  onConnectNewTab?: (url: string) => void;
}

function ActionCell({
  serviceKey,
  connect,
  connectUrl,
  disconnectUrl,
  settingsHref,
  isAdmin,
  status,
  isDisconnecting,
  onDisconnect,
  onConnectNewTab,
}: ActionCellProps) {
  if (connect === 'oauth') {
    if (status === 'ok') {
      return disconnectUrl ? (
        <Button
          variant="outlined"
          size="small"
          color="error"
          disabled={isDisconnecting}
          startIcon={isDisconnecting ? <CircularProgress size={12} /> : undefined}
          onClick={() => onDisconnect(serviceKey, disconnectUrl)}
          data-testid={`connect-action-${serviceKey}`}
        >
          {isDisconnecting ? 'Disconnecting…' : 'Disconnect'}
        </Button>
      ) : (
        <Typography variant="body2" color="text.secondary">
          Connected
        </Typography>
      );
    }
    return (
      <Button
        variant="contained"
        size="small"
        href={connectUrl}
        data-testid={`connect-action-${serviceKey}`}
      >
        Connect
      </Button>
    );
  }

  if (connect === 'admin-only') {
    if (!isAdmin) {
      return (
        <Typography
          variant="body2"
          color="text.secondary"
          data-testid={`connect-action-${serviceKey}`}
        >
          Ask an admin to connect QuickBooks
        </Typography>
      );
    }
    if (status === 'ok') {
      return disconnectUrl ? (
        <Button
          variant="outlined"
          size="small"
          color="error"
          disabled={isDisconnecting}
          startIcon={isDisconnecting ? <CircularProgress size={12} /> : undefined}
          onClick={() => onDisconnect(serviceKey, disconnectUrl)}
          data-testid={`connect-action-${serviceKey}`}
        >
          {isDisconnecting ? 'Disconnecting…' : 'Disconnect'}
        </Button>
      ) : (
        <Typography variant="body2" color="text.secondary">
          Connected
        </Typography>
      );
    }
    return (
      <Button
        variant="contained"
        size="small"
        onClick={() => connectUrl && onConnectNewTab && onConnectNewTab(connectUrl)}
        data-testid={`connect-action-${serviceKey}`}
      >
        Connect
      </Button>
    );
  }

  if (connect === 'managed') {
    if ((status === 'error' || status === 'warning') && settingsHref) {
      return (
        <Button
          variant="text"
          size="small"
          href={settingsHref}
          data-testid={`connect-action-${serviceKey}`}
        >
          Manage in settings
        </Button>
      );
    }
    return (
      <Typography variant="body2" color="text.secondary">
        Managed via server configuration
      </Typography>
    );
  }

  return null;
}

// ── ConnectServicesModal ───────────────────────────────────────────────────────

/** Per-service disconnect in-progress tracker (keyed by ConnectionService) */
type DisconnectingState = Partial<Record<ConnectionService, boolean>>;

function disconnectingReducer(
  state: DisconnectingState,
  action: { service: ConnectionService; inFlight: boolean },
): DisconnectingState {
  return { ...state, [action.service]: action.inFlight };
}

export function ConnectServicesModal({ open, onClose, highlightService, message }: Props) {
  const serviceStatuses = useServiceStatuses();
  const { isAdmin } = usePrivilege();
  const { notifyDisconnected, notifyReconnected } = useConnectionToast();

  const [disconnecting, dispatchDisconnecting] = useReducer(disconnectingReducer, {});

  const handleDisconnect = useCallback(
    async (service: ConnectionService, disconnectUrl: string) => {
      dispatchDisconnecting({ service, inFlight: true });
      try {
        const r = await fetch(disconnectUrl, {
          method: 'POST',
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        if (r.ok) {
          notifyDisconnected(service);
        }
      } catch {
        // Network error — ignore; user can try again
      } finally {
        dispatchDisconnecting({ service, inFlight: false });
      }
    },
    [notifyDisconnected],
  );

  // Open an admin-only service's connect URL in a new tab with ?popup=1 so
  // the OAuth callback can post a message back instead of doing a full redirect.
  const handleConnectNewTab = useCallback((connectUrl: string) => {
    window.open(`${connectUrl}?popup=1`, '_blank');
  }, []);

  // Listen for the postMessage sent by the QuickBooks OAuth callback page when
  // it runs in popup/new-tab mode.  On success, mark QB as connected and clear
  // the per-session auto-open flag so the modal can re-open if needed.
  useEffect(() => {
    function onMessage(evt: MessageEvent) {
      if (evt.origin !== window.location.origin) return;
      const data = evt.data as { type?: string };
      if (data?.type === 'qb-connected') {
        notifyReconnected('quickbooks');
        // Clear the per-session flag so the modal can auto-open again next time
        // the connection drops (e.g. if a future reconnect fails).
        try { sessionStorage.removeItem(CONNECT_MODAL_SHOWN_KEY); } catch { /* quota */ }
      }
    }
    window.addEventListener('message', onMessage);
    return () => { window.removeEventListener('message', onMessage); };
  }, [notifyReconnected]);

  const visibleDescriptors = SERVICE_DESCRIPTORS.filter((d) => d.connect !== 'status-only');

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      aria-labelledby="connect-services-title"
      data-testid="connect-services-modal"
    >
      <DialogTitle id="connect-services-title" sx={{ pb: 1 }}>
        Connect your services
      </DialogTitle>

      <DialogContent sx={{ pt: 0.5 }}>
        {message && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {message}
          </Alert>
        )}
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          These integrations power the app&apos;s core features. Connect any that show as
          disconnected to restore full functionality.
        </Typography>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {visibleDescriptors.map((descriptor) => {
            const { key, label, Icon, connect, connectUrl, disconnectUrl, settingsHref, helpText } = descriptor;
            const status = serviceStatuses.get(key);
            const isHighlighted = key === highlightService;
            const chip = statusChipProps(status);
            const isDisconnecting = !!disconnecting[key];

            return (
              <Box
                key={key}
                data-testid={`connect-row-${key}`}
                sx={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 1.5,
                  p: 1.5,
                  borderRadius: 1.5,
                  border: '1px solid',
                  borderColor: isHighlighted ? 'primary.main' : 'divider',
                  bgcolor: isHighlighted ? 'primary.50' : 'transparent',
                  transition: 'border-color 0.15s, background-color 0.15s',
                }}
              >
                {/* Icon */}
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 36,
                    height: 36,
                    borderRadius: 1,
                    bgcolor: 'action.hover',
                    flexShrink: 0,
                    mt: 0.25,
                    color: isHighlighted ? 'primary.main' : 'text.secondary',
                  }}
                >
                  <Icon fontSize="small" />
                </Box>

                {/* Label + status chip + help text */}
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {label}
                    </Typography>
                    <Chip
                      label={chip.label}
                      color={chip.color}
                      size="small"
                      variant="outlined"
                      data-testid={`connect-status-chip-${key}`}
                    />
                  </Box>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                    {helpText}
                  </Typography>
                </Box>

                {/* Action */}
                <Box sx={{ flexShrink: 0, mt: 0.25 }}>
                  <ActionCell
                    serviceKey={key}
                    connect={connect}
                    connectUrl={connectUrl}
                    disconnectUrl={disconnectUrl}
                    settingsHref={settingsHref}
                    isAdmin={isAdmin}
                    status={status}
                    isDisconnecting={isDisconnecting}
                    onDisconnect={handleDisconnect}
                    onConnectNewTab={handleConnectNewTab}
                  />
                </Box>
              </Box>
            );
          })}
        </Box>
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose} variant="contained" data-testid="connect-services-done">
          Done
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default ConnectServicesModal;
