import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Divider,
  InputAdornment,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import HubIcon from '@mui/icons-material/Hub';
import SyncIcon from '@mui/icons-material/Sync';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import ErrorOutlinedIcon from '@mui/icons-material/ErrorOutlined';
import { GET, POST, DELETE } from '../../utils/api';
import { STATUS_COLORS } from '../../theme';
import { usePageTitle } from '../../hooks/usePageTitle';
import { useAdminUnsavedChanges } from '../../hooks/useAdminUnsavedChanges';
import { DEFAULT_WORKFLOW } from '../../lib/workflowConfig';
import { useWorkflow } from '../../hooks/useWorkflow';

interface HubStatus {
  connected: boolean;
  code?: string;
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

// HubSpot's Webhooks v3 management API (used by the Register / Unregister buttons)
// only authenticates public-app / developer requests. This integration uses a
// private-app token (`pat-…`), which HubSpot rejects with "Authentication
// credentials not found" — so private-app webhook subscriptions must be set up
// directly in HubSpot (Settings → Integrations → Private Apps → Webhooks) instead.
// Flip this to true only if the integration migrates to a public app, which the
// Webhooks v3 API does support.
const WEBHOOK_API_REGISTRATION_SUPPORTED = false;

// ── Pipeline Stages card ────────────────────────────────────────────────────

const WORKFLOW_KEY_TO_LS_STAGE: Record<string, string> = {
  sales:        'SALES',
  designvisit:  'DESIGN_VISIT',
  survey:       'SURVEY',
  order:        'ORDER',
  workshop:     'WORKSHOP',
  packing:      'PACKING',
  delivery:     'DELIVERY',
  installation: 'INSTALLATION',
  aftercare:    'AFTERCARE',
};

const TH: React.CSSProperties = {
  padding: '6px 8px',
  textAlign: 'left',
  borderBottom: '1px solid var(--neutral-200)',
  background: 'var(--neutral-50)',
  fontSize: '0.75rem',
  fontWeight: 600,
  color: 'var(--neutral-500)',
  whiteSpace: 'nowrap',
};
const TD: React.CSSProperties = {
  padding: '4px 8px',
  borderBottom: '1px solid #f3f4f6',
  verticalAlign: 'middle',
};

function PipelineStagesCard() {
  const { workflow } = useWorkflow();
  const [statusCountByStage, setStatusCountByStage] = React.useState<Map<string, number>>(new Map());
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const statuses = await GET<Array<{ stage: string | null; is_null_row: boolean }>>('/api/admin/lead-statuses');
        if (cancelled) return;
        const counts = new Map<string, number>();
        for (const s of (Array.isArray(statuses) ? statuses : [])) {
          if (!s.is_null_row && s.stage) counts.set(s.stage, (counts.get(s.stage) ?? 0) + 1);
        }
        setStatusCountByStage(counts);
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  const stageKeys = Object.keys(workflow?.stages ?? DEFAULT_WORKFLOW.stages!);

  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5 }}>Pipeline stages</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          The pipeline stages defined in workflow.json. Read-only — editing is not yet supported here.
        </Typography>
        <Box sx={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
            <thead>
              <tr>
                <th style={TH}>Stage key</th>
                <th style={TH}>Display label</th>
                <th style={{ ...TH, textAlign: 'right' }}>Lead statuses</th>
              </tr>
            </thead>
            <tbody>
              {stageKeys.map((key, i) => {
                const stageData = workflow?.stages?.[key];
                const label = stageData?.label ?? key;
                const lsStageValue = WORKFLOW_KEY_TO_LS_STAGE[key];
                const count = lsStageValue ? (statusCountByStage.get(lsStageValue) ?? 0) : 0;
                return (
                  <tr key={key} style={{ background: i % 2 ? 'var(--neutral-50)' : 'white' }}>
                    <td style={{ ...TD, fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>{key}</td>
                    <td style={TD}>{label}</td>
                    <td style={{ ...TD, textAlign: 'right', color: count === 0 ? 'var(--neutral-400)' : 'inherit' }}>
                      {loading ? '…' : count}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Box>
      </CardContent>
    </Card>
  );
}

// ── Priority sort: active window card ────────────────────────────────────────

const DEFAULT_PRIORITY_ACTIVE_DAYS = 60;

function PriorityActiveDaysCard() {
  const [current, setCurrent] = React.useState<number | null>(null);
  const [draft, setDraft] = React.useState<string>('');
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await GET<{ value: number }>('/api/admin/hubspot/priority-active-days');
        if (cancelled) return;
        setCurrent(data.value);
        setDraft(String(data.value));
      } catch {
        if (!cancelled) setError('Could not load setting.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  const parsed = parseInt(draft, 10);
  const isValid = !isNaN(parsed) && parsed >= 1 && parsed <= 3650 && String(parsed) === draft.trim();
  const isDirty = isValid && parsed !== current;

  async function handleSave() {
    if (!isValid) return;
    setSaving(true);
    setError(null);
    try {
      const data = await POST<{ value: number }>('/api/admin/hubspot/priority-active-days', { value: parsed });
      setCurrent(data.value);
      setDraft(String(data.value));
      showToast(`Active window updated to ${data.value} days.`);
    } catch (e) {
      setError((e as Error).message || 'Could not save setting.');
      throw e; // let the unsaved-changes guard keep the user on this tab
    } finally {
      setSaving(false);
    }
  }

  useAdminUnsavedChanges({
    id: 'hubspot-priority-active-days',
    isDirty,
    onSave: handleSave,
    onDiscard: () => { if (current !== null) setDraft(String(current)); },
  });

  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5 }}>Priority sort: active window</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          When "Priority first" is active and there is no search query, contacts not modified within
          this many days are hidden from the list. Default is {DEFAULT_PRIORITY_ACTIVE_DAYS} days.
        </Typography>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {loading ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <CircularProgress size={16} />
            <Typography variant="body2" color="text.secondary">Loading…</Typography>
          </Box>
        ) : (
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2, flexWrap: 'wrap' }}>
            <TextField
              label="Active window"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              type="number"
              size="small"
              slotProps={{
                input: {
                  endAdornment: <InputAdornment position="end">days</InputAdornment>,
                  inputProps: { min: 1, max: 3650, step: 1 },
                },
              }}
              error={draft !== '' && !isValid}
              helperText={draft !== '' && !isValid ? 'Enter a whole number between 1 and 3650.' : ' '}
              sx={{ width: 180 }}
            />
            <Button
              variant="contained"
              onClick={() => { void handleSave().catch(() => {}); }}
              disabled={!isDirty || saving}
              startIcon={saving ? <CircularProgress size={14} color="inherit" /> : undefined}
              sx={{ mt: 0.25 }}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </Box>
        )}
      </CardContent>
    </Card>
  );
}

export function HubSpotPage() {
  usePageTitle('HubSpot · Measure Once');

  const [hubStatus, setHubStatus] = useState<HubStatus | null>(null);

  const [webhookStatus, setWebhookStatus] = useState<WebhookStatus | null>(null);
  const [webhookLoading, setWebhookLoading] = useState(true);
  const [webhookActing, setWebhookActing] = useState(false);

  const fetchHubStatus = useCallback(async () => {
    try {
      const data = await GET<HubStatus>('/api/hubspot/status');
      setHubStatus(data);
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
  }, [fetchHubStatus, fetchWebhookStatus]);

  useEffect(() => {
    W.loadHubspotStatus = fetchHubStatus;
    return () => { delete W.loadHubspotStatus; };
  }, [fetchHubStatus]);

  const badge = (() => {
    if (!hubStatus) return { text: 'Checking…', bg: 'var(--neutral-100)', color: 'var(--neutral-500)' };
    if (hubStatus.connected) return { text: 'Connected', bg: STATUS_COLORS.success.bg, color: STATUS_COLORS.success.text };
    if (hubStatus.code === 'HUBSPOT_RATE_LIMIT') {
      return { text: 'Rate limited — rechecking…', bg: STATUS_COLORS.warning.bg, color: STATUS_COLORS.warning.text };
    }
    if (hubStatus.code === 'NO_TOKEN')  return { text: 'No token set', bg: STATUS_COLORS.error.bg, color: STATUS_COLORS.error.text };
    if (hubStatus.code === 'ERROR')     return { text: 'Could not check', bg: STATUS_COLORS.warning.bg, color: STATUS_COLORS.warning.text };
    return { text: 'Not connected — check your token', bg: STATUS_COLORS.error.bg, color: STATUS_COLORS.error.text };
  })();

  return (
    <Stack spacing={2}>
      <PriorityActiveDaysCard />

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

      <PipelineStagesCard />

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
              {!WEBHOOK_API_REGISTRATION_SUPPORTED && (
                <Alert severity="info">
                  This integration uses a HubSpot <strong>private app</strong>, so webhook
                  subscriptions are configured directly in HubSpot
                  (<em>Settings → Integrations → Private Apps → Webhooks</em>) rather than from
                  here. API-based registration is only available for public apps, so the buttons
                  below are disabled.
                </Alert>
              )}
              <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
                <Button
                  variant="contained"
                  onClick={registerWebhook}
                  disabled={!WEBHOOK_API_REGISTRATION_SUPPORTED || webhookActing || !webhookStatus.appIdConfigured || !webhookStatus.hasSecret}
                  startIcon={webhookActing ? <CircularProgress size={14} color="inherit" /> : undefined}
                  title={!WEBHOOK_API_REGISTRATION_SUPPORTED ? 'Private-app webhooks are configured directly in HubSpot — see the note above.' : !webhookStatus.appIdConfigured ? 'HUBSPOT_APP_ID must be configured' : !webhookStatus.hasSecret ? 'HUBSPOT_CLIENT_SECRET must be configured' : undefined}
                >
                  {webhookActing ? 'Working…' : 'Register / refresh'}
                </Button>
                <Button
                  variant="outlined"
                  color="error"
                  onClick={unregisterWebhook}
                  disabled={!WEBHOOK_API_REGISTRATION_SUPPORTED || webhookActing || !webhookStatus.appIdConfigured || !webhookStatus.hasSecret || webhookStatus.subscriptions.length === 0}
                  startIcon={webhookActing ? <CircularProgress size={14} color="inherit" /> : undefined}
                  title={!WEBHOOK_API_REGISTRATION_SUPPORTED ? 'Private-app webhooks are configured directly in HubSpot — see the note above.' : undefined}
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
