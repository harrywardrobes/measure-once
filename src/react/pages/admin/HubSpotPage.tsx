import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Divider,
  Stack,
  Typography,
} from '@mui/material';
import HubIcon from '@mui/icons-material/Hub';
import SyncIcon from '@mui/icons-material/Sync';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import ErrorOutlinedIcon from '@mui/icons-material/ErrorOutlined';
import { GET, POST, DELETE } from '../../utils/api';
import { STATUS_COLORS } from '../../theme';
import { usePageTitle } from '../../hooks/usePageTitle';

interface HubStatus {
  connected: boolean;
  code?: string;
  cooldownSecondsRemaining?: number;
}

interface WebhookSubscription {
  id: string | number;
  eventType: string;
  propertyName: string;
  active: boolean;
}

interface WebhookStatus {
  hasSecret: boolean;
  appIdConfigured: boolean;
  webhookUrl: string;
  configuredWebhookUrl: string | null;
  subscriptions: WebhookSubscription[];
}

const W = window as unknown as Record<string, unknown>;

function showToast(msg: string, err?: boolean) {
  if (typeof W.toast === 'function') (W.toast as (m: string, e?: boolean) => void)(msg, err);
}

export function HubSpotPage() {
  usePageTitle('HubSpot · Measure Once');

  const [hubStatus, setHubStatus] = useState<HubStatus | null>(null);

  const [webhookStatus, setWebhookStatus] = useState<WebhookStatus | null>(null);
  const [webhookLoading, setWebhookLoading] = useState(true);
  const [webhookActing, setWebhookActing] = useState(false);

  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchHubStatus = useCallback(async () => {
    if (cooldownRef.current) { clearInterval(cooldownRef.current); cooldownRef.current = null; }
    try {
      const data = await GET<HubStatus>('/api/hubspot/status');
      setHubStatus(data);
      if (data.code === 'HUBSPOT_RATE_LIMIT' && (data.cooldownSecondsRemaining ?? 0) > 0) {
        const rem = { v: data.cooldownSecondsRemaining! };
        cooldownRef.current = setInterval(() => {
          rem.v -= 1;
          if (rem.v <= 0) {
            clearInterval(cooldownRef.current!); cooldownRef.current = null;
            fetchHubStatus();
          } else {
            setHubStatus(d => d ? { ...d, cooldownSecondsRemaining: rem.v } : d);
          }
        }, 1000);
      }
    } catch {
      setHubStatus({ connected: false, code: 'ERROR' });
    }
  }, []);

  const fetchWebhookStatus = useCallback(async () => {
    setWebhookLoading(true);
    try {
      const data = await GET<WebhookStatus>('/api/admin/hubspot-webhook');
      setWebhookStatus(data);
    } catch {
      setWebhookStatus(null);
    } finally {
      setWebhookLoading(false);
    }
  }, []);

  const registerWebhook = useCallback(async () => {
    setWebhookActing(true);
    try {
      await POST('/api/admin/hubspot-webhook');
      showToast('Webhook subscriptions registered.');
      await fetchWebhookStatus();
    } catch (e) {
      showToast((e as Error).message || 'Failed to register webhook.', true);
    } finally {
      setWebhookActing(false);
    }
  }, [fetchWebhookStatus]);

  const unregisterWebhook = useCallback(async () => {
    setWebhookActing(true);
    try {
      await DELETE('/api/admin/hubspot-webhook');
      showToast('Webhook subscriptions removed.');
      await fetchWebhookStatus();
    } catch (e) {
      showToast((e as Error).message || 'Failed to remove webhook.', true);
    } finally {
      setWebhookActing(false);
    }
  }, [fetchWebhookStatus]);

  useEffect(() => {
    fetchHubStatus();
    fetchWebhookStatus();
    return () => { if (cooldownRef.current) clearInterval(cooldownRef.current); };
  }, [fetchHubStatus, fetchWebhookStatus]);

  useEffect(() => {
    W.loadHubspotStatus = fetchHubStatus;
    return () => { delete W.loadHubspotStatus; };
  }, [fetchHubStatus]);

  const badge = (() => {
    if (!hubStatus) return { text: 'Checking…', bg: 'var(--neutral-100)', color: 'var(--neutral-500)' };
    if (hubStatus.connected) return { text: 'Connected', bg: STATUS_COLORS.success.bg, color: STATUS_COLORS.success.text };
    if (hubStatus.code === 'HUBSPOT_RATE_LIMIT') {
      const secs = hubStatus.cooldownSecondsRemaining;
      return { text: secs && secs > 0 ? `Rate limited — retrying in ${secs} s` : 'Rate limited — rechecking…', bg: STATUS_COLORS.warning.bg, color: STATUS_COLORS.warning.text };
    }
    if (hubStatus.code === 'NO_TOKEN')  return { text: 'No token set', bg: STATUS_COLORS.error.bg, color: STATUS_COLORS.error.text };
    if (hubStatus.code === 'ERROR')     return { text: 'Could not check', bg: STATUS_COLORS.warning.bg, color: STATUS_COLORS.warning.text };
    return { text: 'Not connected — check your token', bg: STATUS_COLORS.error.bg, color: STATUS_COLORS.error.text };
  })();

  return (
    <Stack spacing={2}>
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" sx={{ mb: 1 }}>HubSpot CRM</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Connection status and sync controls for the HubSpot CRM integration.
          </Typography>

          <Box id="hubspot-status-row" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, p: 1.25, borderRadius: 1, border: 1, borderColor: 'divider' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <HubIcon fontSize="small" sx={{ flexShrink: 0, color: 'text.secondary' }} />
              <Typography variant="body2" sx={{ fontWeight: 600 }}>HubSpot CRM</Typography>
            </Box>
            <span id="hubspot-status-badge" style={{ padding: '2px 10px', borderRadius: 999, fontSize: '.75rem', fontWeight: 600, background: badge.bg, color: badge.color, transition: 'background .2s,color .2s' }}>
              {badge.text}
            </span>
          </Box>

          {hubStatus?.connected && !webhookLoading && webhookStatus !== null &&
            webhookStatus.subscriptions.filter(s => s.active).length === 0 && (
            <Alert
              severity="info"
              sx={{ mt: 1.5 }}
              action={
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => {
                    document.getElementById('hubspot-webhooks-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                >
                  Set up
                </Button>
              }
            >
              No webhook subscription is active — lead status changes in HubSpot won't appear instantly.
              Register a webhook for real-time sync.
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card variant="outlined" id="hubspot-webhooks-card">
        <CardContent>
          <Typography variant="h6" sx={{ mb: 0.5 }}>HubSpot Webhooks</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Register a real-time webhook so lead status changes made directly in HubSpot appear in
            the Sales, Design Visit, and Survey boards within seconds — without waiting for the
            5-minute cache to expire. Requires{' '}
            <Box component="code" sx={{ fontSize: '0.8em' }}>HUBSPOT_CLIENT_SECRET</Box> and{' '}
            <Box component="code" sx={{ fontSize: '0.8em' }}>HUBSPOT_APP_ID</Box> to be set in
            your environment secrets.
          </Typography>

          {webhookLoading ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1 }}>
              <CircularProgress size={16} />
              <Typography variant="body2" color="text.secondary">Checking webhook status…</Typography>
            </Box>
          ) : webhookStatus === null ? (
            <Alert severity="error" sx={{ mb: 2 }}>Could not load webhook status.</Alert>
          ) : (
            <Stack spacing={2}>
              {/* Secret / App ID configuration status */}
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, px: 1.5, py: 0.75, borderRadius: 1, border: 1, borderColor: 'divider', flex: 1 }}>
                  {webhookStatus.hasSecret
                    ? <CheckCircleOutlinedIcon sx={{ fontSize: 16, color: 'success.main', flexShrink: 0 }} />
                    : <ErrorOutlinedIcon sx={{ fontSize: 16, color: 'warning.main', flexShrink: 0 }} />}
                  <Box>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>HUBSPOT_CLIENT_SECRET</Typography>
                    <Typography variant="body2" sx={{ fontWeight: 600, fontSize: '0.8rem' }}>
                      {webhookStatus.hasSecret ? 'Configured' : 'Not set'}
                    </Typography>
                  </Box>
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, px: 1.5, py: 0.75, borderRadius: 1, border: 1, borderColor: 'divider', flex: 1 }}>
                  {webhookStatus.appIdConfigured
                    ? <CheckCircleOutlinedIcon sx={{ fontSize: 16, color: 'success.main', flexShrink: 0 }} />
                    : <ErrorOutlinedIcon sx={{ fontSize: 16, color: 'warning.main', flexShrink: 0 }} />}
                  <Box>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>HUBSPOT_APP_ID</Typography>
                    <Typography variant="body2" sx={{ fontWeight: 600, fontSize: '0.8rem' }}>
                      {webhookStatus.appIdConfigured ? 'Configured' : 'Not set'}
                    </Typography>
                  </Box>
                </Box>
              </Stack>

              {(!webhookStatus.hasSecret || !webhookStatus.appIdConfigured) && (
                <Alert severity="warning">
                  Set{!webhookStatus.hasSecret && !webhookStatus.appIdConfigured
                    ? ' HUBSPOT_CLIENT_SECRET and HUBSPOT_APP_ID'
                    : !webhookStatus.hasSecret
                      ? ' HUBSPOT_CLIENT_SECRET'
                      : ' HUBSPOT_APP_ID'}{' '}
                  in your environment secrets to enable webhook registration.
                </Alert>
              )}

              {/* Subscription status */}
              <Divider />
              <Box>
                <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>Subscription status</Typography>
                {webhookStatus.subscriptions.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">No active subscriptions — boards use pull-based refresh only.</Typography>
                ) : (
                  <Stack spacing={0.5}>
                    {webhookStatus.subscriptions.map(s => (
                      <Box key={s.id} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <CheckCircleOutlinedIcon sx={{ fontSize: 14, color: s.active ? 'success.main' : 'warning.main', flexShrink: 0 }} />
                        <Typography variant="body2" sx={{ fontFamily: (theme) => theme.typography.monoFontFamily, fontSize: '0.8rem' }}>
                          {s.propertyName}
                          {!s.active && <Box component="span" sx={{ ml: 1, color: 'warning.main' }}>(paused)</Box>}
                        </Typography>
                      </Box>
                    ))}
                  </Stack>
                )}
              </Box>

              {/* Webhook receiver URL */}
              {webhookStatus.webhookUrl && (
                <Box>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>Webhook receiver URL</Typography>
                  <Box component="code" sx={{ fontSize: '0.78rem', wordBreak: 'break-all', color: 'text.primary' }}>
                    {webhookStatus.webhookUrl}
                  </Box>
                </Box>
              )}

              {/* Action buttons */}
              <Divider />
              <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
                <Button
                  variant="contained"
                  onClick={registerWebhook}
                  disabled={webhookActing || !webhookStatus.appIdConfigured || !webhookStatus.hasSecret}
                  startIcon={webhookActing ? <CircularProgress size={14} color="inherit" /> : undefined}
                  title={!webhookStatus.appIdConfigured ? 'HUBSPOT_APP_ID must be configured' : !webhookStatus.hasSecret ? 'HUBSPOT_CLIENT_SECRET must be configured' : undefined}
                >
                  {webhookActing ? 'Working…' : 'Register / refresh'}
                </Button>
                <Button
                  variant="outlined"
                  color="error"
                  onClick={unregisterWebhook}
                  disabled={webhookActing || !webhookStatus.appIdConfigured || !webhookStatus.hasSecret || webhookStatus.subscriptions.length === 0}
                  startIcon={webhookActing ? <CircularProgress size={14} color="inherit" /> : undefined}
                >
                  Unregister
                </Button>
                <Button variant="text" onClick={fetchWebhookStatus} disabled={webhookLoading || webhookActing}>
                  Refresh status
                </Button>
              </Box>
            </Stack>
          )}
        </CardContent>
      </Card>
    </Stack>
  );
}

export default HubSpotPage;
