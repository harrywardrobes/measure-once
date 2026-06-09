import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Divider,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { GET, POST, PATCH } from '../../utils/api';
import { usePageTitle } from '../../hooks/usePageTitle';

interface DigestSettings {
  lastSentAt: string | null;
  smtpConfigured: boolean;
  staleDays: number;
  minGapDays: number;
}

interface PageFilterConfigEntry {
  label: string;
  type: 'number' | 'json';
  min?: number;
  max?: number;
  currentValue: number | string;
}

type PageFilterConfig = Record<string, PageFilterConfigEntry>;

const W = window as unknown as Record<string, unknown>;

function showToast(msg: string, err?: boolean) {
  if (typeof W.toast === 'function') (W.toast as (m: string, e?: boolean) => void)(msg, err);
}

export function SettingsPage() {
  usePageTitle('Settings · Measure Once');
  const [storybookBuilt, setStorybookBuilt] = useState<boolean | null>(null);
  const [digestSettings, setDigestSettings] = useState<DigestSettings | null>(null);
  const [digestSending, setDigestSending] = useState(false);
  const [digestStaleDays, setDigestStaleDays] = useState<string>('7');
  const [digestMinGapDays, setDigestMinGapDays] = useState<string>('7');
  const [digestThresholdSaving, setDigestThresholdSaving] = useState(false);

  const [pageFilterConfig, setPageFilterConfig] = useState<PageFilterConfig | null>(null);
  const [pageFilterDraft, setPageFilterDraft] = useState<Record<string, string>>({});
  const [pageFilterSaving, setPageFilterSaving] = useState(false);

  const fetchDigestSettings = useCallback(async () => {
    try {
      const data = await GET<DigestSettings>('/api/admin/conflict-digest-settings');
      setDigestSettings(data);
      setDigestStaleDays(String(data.staleDays ?? 7));
      setDigestMinGapDays(String(data.minGapDays ?? 7));
    } catch {}
  }, []);

  const fetchPageFilterConfig = useCallback(async () => {
    try {
      const data = await GET<PageFilterConfig>('/api/admin/page-filter-config');
      setPageFilterConfig(data);
      const draft: Record<string, string> = {};
      for (const [key, entry] of Object.entries(data)) {
        draft[key] = String(entry.currentValue);
      }
      setPageFilterDraft(draft);
    } catch {}
  }, []);

  const savePageFilterConfig = useCallback(async () => {
    if (!pageFilterConfig) return;
    setPageFilterSaving(true);
    try {
      const payload: Record<string, number | string> = {};
      for (const [key, entry] of Object.entries(pageFilterConfig)) {
        const raw = pageFilterDraft[key] ?? String(entry.currentValue);
        payload[key] = entry.type === 'number' ? parseInt(raw, 10) : raw;
      }
      await PATCH('/api/admin/page-filter-config', payload);
      showToast('Page defaults saved.');
      await fetchPageFilterConfig();
    } catch (e) {
      showToast((e as Error).message || 'Failed to save page defaults.', true);
    } finally {
      setPageFilterSaving(false);
    }
  }, [pageFilterConfig, pageFilterDraft, fetchPageFilterConfig]);

  const saveDigestThresholds = useCallback(async () => {
    const staleDaysVal   = parseInt(digestStaleDays, 10);
    const minGapDaysVal  = parseInt(digestMinGapDays, 10);
    if (!Number.isFinite(staleDaysVal)  || staleDaysVal  < 1 || staleDaysVal  > 365) {
      showToast('Stale after must be between 1 and 365 days.', true); return;
    }
    if (!Number.isFinite(minGapDaysVal) || minGapDaysVal < 1 || minGapDaysVal > 365) {
      showToast('Send at most every must be between 1 and 365 days.', true); return;
    }
    setDigestThresholdSaving(true);
    try {
      await PATCH('/api/admin/conflict-digest-settings', {
        staleDays: staleDaysVal,
        minGapDays: minGapDaysVal,
      });
      setDigestSettings(d => d ? { ...d, staleDays: staleDaysVal, minGapDays: minGapDaysVal } : d);
      showToast('Digest thresholds saved.');
    } catch (e) {
      showToast((e as Error).message || 'Failed to save.', true);
    } finally {
      setDigestThresholdSaving(false);
    }
  }, [digestStaleDays, digestMinGapDays]);

  const sendDigestNow = useCallback(async () => {
    setDigestSending(true);
    try {
      const data = await POST<{ sent: boolean; lastSentAt: string | null }>('/api/admin/conflict-digest/send-now');
      if (data.sent) {
        setDigestSettings(d => d ? { ...d, lastSentAt: data.lastSentAt } : d);
        showToast('Digest sent — admins have been emailed.');
      } else {
        showToast('No stale conflicts to report — no email was sent.');
      }
    } catch (e) {
      showToast((e as Error).message || 'Failed to send digest.', true);
    } finally {
      setDigestSending(false);
    }
  }, []);

  useEffect(() => {
    fetchDigestSettings();
    fetchPageFilterConfig();
    fetch('/storybook/index.html', { method: 'HEAD' })
      .then((r) => setStorybookBuilt(r.ok))
      .catch(() => setStorybookBuilt(false));
  }, [fetchDigestSettings, fetchPageFilterConfig]);

  return (
    <Stack spacing={2}>
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" sx={{ mb: 0.5 }}>Conflict digest</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            An email is automatically sent to admins listing team members whose onboarding
            conflicts have been unresolved for the configured number of days.
          </Typography>

          {digestSettings && !digestSettings.smtpConfigured && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              SMTP is not configured — email sending is disabled. Set{' '}
              <Box component="code" sx={{ fontSize: '0.8em' }}>SMTP_HOST</Box>,{' '}
              <Box component="code" sx={{ fontSize: '0.8em' }}>SMTP_USER</Box>, and{' '}
              <Box component="code" sx={{ fontSize: '0.8em' }}>SMTP_PASS</Box>{' '}
              in your environment secrets to enable digest emails.
            </Alert>
          )}

          <Stack direction="row" spacing={2} sx={{ mb: 2, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <TextField
              size="small"
              label="Stale after (days)"
              type="number"
              value={digestStaleDays}
              onChange={e => setDigestStaleDays(e.target.value)}
              slotProps={{ htmlInput: { min: 1, max: 365, step: 1 } }}
              sx={{ width: 170 }}
              disabled={digestSettings === null}
            />
            <TextField
              size="small"
              label="Send at most every (days)"
              type="number"
              value={digestMinGapDays}
              onChange={e => setDigestMinGapDays(e.target.value)}
              slotProps={{ htmlInput: { min: 1, max: 365, step: 1 } }}
              sx={{ width: 210 }}
              disabled={digestSettings === null}
            />
            <Button
              variant="outlined"
              onClick={saveDigestThresholds}
              disabled={digestThresholdSaving || digestSettings === null}
              startIcon={digestThresholdSaving ? <CircularProgress size={14} color="inherit" /> : undefined}
            >
              {digestThresholdSaving ? 'Saving…' : 'Save'}
            </Button>
          </Stack>

          <Divider sx={{ mb: 2 }} />

          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
            <Box>
              <Typography variant="body2" color="text.secondary" component="span">Last sent: </Typography>
              <Typography variant="body2" component="span" sx={{ fontWeight: 500 }}>
                {digestSettings === null
                  ? 'Loading…'
                  : digestSettings.lastSentAt
                    ? new Date(digestSettings.lastSentAt).toLocaleString()
                    : 'Never'}
              </Typography>
            </Box>
            <Button
              variant="outlined"
              startIcon={digestSending ? <CircularProgress size={14} color="inherit" /> : <SendIcon />}
              disabled={digestSending || digestSettings === null || !digestSettings.smtpConfigured}
              onClick={sendDigestNow}
              title={digestSettings && !digestSettings.smtpConfigured ? 'SMTP is not configured' : undefined}
            >
              {digestSending ? 'Sending…' : 'Send now'}
            </Button>
          </Box>
          {digestSettings?.smtpConfigured && (
            <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
              "Send now" bypasses the send-gate and sends immediately if there are stale conflicts.
            </Typography>
          )}
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, mb: 2 }}>
            <Box>
              <Typography variant="h6" sx={{ mb: 0.5 }}>Page defaults</Typography>
              <Typography variant="body2" color="text.secondary">
                Default settings for each page. Changes take effect on the next page load — no restart needed.
              </Typography>
            </Box>
            <Button
              variant="contained"
              onClick={savePageFilterConfig}
              disabled={pageFilterSaving || pageFilterConfig === null}
              startIcon={pageFilterSaving ? <CircularProgress size={14} color="inherit" /> : undefined}
              sx={{ flexShrink: 0 }}
            >
              {pageFilterSaving ? 'Saving…' : 'Save'}
            </Button>
          </Box>

          {pageFilterConfig === null ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1 }}>
              <CircularProgress size={16} />
              <Typography variant="body2" color="text.secondary">Loading…</Typography>
            </Box>
          ) : (
            <Stack spacing={3}>
              {/* Sales board */}
              <Box>
                <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1.5 }}>Sales board</Typography>
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
                  <TextField
                    size="small"
                    label="Staleness cutoff (days)"
                    type="number"
                    value={pageFilterDraft['sales_staleness_days'] ?? '28'}
                    onChange={e => setPageFilterDraft(d => ({ ...d, sales_staleness_days: e.target.value }))}
                    slotProps={{ htmlInput: { min: 1, max: 365, step: 1 } }}
                    helperText="Contacts not modified within this window are hidden. Set to a high number to show all."
                    sx={{ width: 220 }}
                  />
                  <TextField
                    size="small"
                    label="Default page size"
                    type="number"
                    value={pageFilterDraft['sales_page_size'] ?? '25'}
                    onChange={e => setPageFilterDraft(d => ({ ...d, sales_page_size: e.target.value }))}
                    slotProps={{ htmlInput: { min: 5, max: 100, step: 1 } }}
                    helperText="Contacts shown per page in each column."
                    sx={{ width: 200 }}
                  />
                </Stack>
              </Box>

              <Divider />

              {/* Surveys board */}
              <Box>
                <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1.5 }}>Surveys board</Typography>
                <Stack spacing={2}>
                  <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
                    <TextField
                      size="small"
                      label="Default page size"
                      type="number"
                      value={pageFilterDraft['surveys_page_size'] ?? '25'}
                      onChange={e => setPageFilterDraft(d => ({ ...d, surveys_page_size: e.target.value }))}
                      slotProps={{ htmlInput: { min: 5, max: 100, step: 1 } }}
                      helperText="Contacts shown per page."
                      sx={{ width: 200 }}
                    />
                  </Stack>
                  <TextField
                    size="small"
                    label="Hidden substages (JSON array)"
                    multiline
                    minRows={2}
                    value={pageFilterDraft['surveys_hidden_substages_default'] ?? (pageFilterConfig?.['surveys_hidden_substages_default']?.currentValue ?? '[]')}
                    onChange={e => setPageFilterDraft(d => ({ ...d, surveys_hidden_substages_default: e.target.value }))}
                    helperText='Substage IDs to hide by default, e.g. ["substage-id-1","substage-id-2"]. Must be valid JSON.'
                    sx={{ maxWidth: 480 }}
                  />
                </Stack>
              </Box>

              <Divider />

              {/* Customers list */}
              <Box>
                <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1.5 }}>Customers list</Typography>
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
                  <TextField
                    size="small"
                    label="Default page size"
                    type="number"
                    value={pageFilterDraft['customers_page_size'] ?? '25'}
                    onChange={e => setPageFilterDraft(d => ({ ...d, customers_page_size: e.target.value }))}
                    slotProps={{ htmlInput: { min: 5, max: 100, step: 1 } }}
                    helperText="Contacts shown per page."
                    sx={{ width: 200 }}
                  />
                </Stack>
              </Box>

              <Divider />

              {/* Customer profile / Design visits — placeholder */}
              <Box>
                <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.5 }}>Customer profile / Design visits</Typography>
                <Typography variant="body2" color="text.secondary">
                  No configurable defaults yet — settings for the design visit list will appear here in a future update.
                </Typography>
              </Box>
            </Stack>
          )}
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" sx={{ mb: 0.5 }}>Design System</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Browse component documentation, design tokens, and UI patterns in Storybook.
          </Typography>
          {storybookBuilt === false ? (
            <Typography variant="body2" color="text.disabled">
              Storybook not built — run{' '}
              <Box component="code" sx={{ fontSize: '0.8em' }}>npm run build:storybook</Box>{' '}
              to enable.
            </Typography>
          ) : (
            <Button
              variant="outlined"
              href="/storybook/"
              target="_blank"
              rel="noopener noreferrer"
              endIcon={<OpenInNewIcon />}
              disabled={storybookBuilt === null}
            >
              Open Design System
            </Button>
          )}
        </CardContent>
      </Card>


    </Stack>
  );
}
