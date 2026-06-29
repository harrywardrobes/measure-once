import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Divider,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';
import { GET, POST, PATCH } from '../../utils/api';
import { usePageTitle } from '../../hooks/usePageTitle';
import { useAdminUnsavedChanges } from '../../hooks/useAdminUnsavedChanges';

interface DigestSettings {
  lastSentAt: string | null;
  smtpConfigured: boolean;
  staleDays: number;
  minGapDays: number;
}

interface PageFilterConfigEntry {
  label: string;
  type: 'number' | 'json' | 'string';
  min?: number;
  max?: number;
  allowedValues?: string[];
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

  const [pageFilterConfig, setPageFilterConfig] = useState<PageFilterConfig | null>(null);
  const [pageFilterDraft, setPageFilterDraft] = useState<Record<string, string>>({});

  const [companyName, setCompanyName]       = useState('');
  const [companyDraft, setCompanyDraft]     = useState('');
  const [companyLoading, setCompanyLoading] = useState(true);

  // Single in-flight flag for the consolidated save (all sections at once).
  const [saving, setSaving] = useState(false);

  const [formLinkCopied, setFormLinkCopied] = useState(false);
  const genericFormUrl = `${window.location.origin}/customer-info`;

  const copyFormLink = useCallback(() => {
    navigator.clipboard.writeText(genericFormUrl).then(() => {
      setFormLinkCopied(true);
      setTimeout(() => setFormLinkCopied(false), 2000);
    }).catch(() => {
      showToast('Could not copy to clipboard.', true);
    });
  }, [genericFormUrl]);

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

  // ── Dirty detection (per section + combined) ────────────────────────────────

  const digestDirty = digestSettings !== null && (
    String(digestSettings.staleDays ?? 7) !== digestStaleDays ||
    String(digestSettings.minGapDays ?? 7) !== digestMinGapDays
  );

  const pageFilterDirty = pageFilterConfig !== null && Object.entries(pageFilterConfig).some(
    ([key, entry]) => (pageFilterDraft[key] ?? String(entry.currentValue)) !== String(entry.currentValue),
  );

  const companyDirty = !companyLoading && companyDraft.trim() !== companyName;

  const isDirty = digestDirty || pageFilterDirty || companyDirty;

  // ── Consolidated save / discard (drives the bottom bar + tab-switch guard) ──

  const persist = useCallback(async () => {
    // Validate before any network call so one bad value blocks the whole save.
    let staleVal: number | undefined;
    let gapVal: number | undefined;
    if (digestDirty) {
      staleVal = parseInt(digestStaleDays, 10);
      gapVal   = parseInt(digestMinGapDays, 10);
      if (!Number.isFinite(staleVal) || staleVal < 1 || staleVal > 365) {
        showToast('Stale after must be between 1 and 365 days.', true);
        throw new Error('validation');
      }
      if (!Number.isFinite(gapVal) || gapVal < 1 || gapVal > 365) {
        showToast('Send at most every must be between 1 and 365 days.', true);
        throw new Error('validation');
      }
    }

    setSaving(true);
    try {
      if (digestDirty) {
        await PATCH('/api/admin/conflict-digest-settings', { staleDays: staleVal, minGapDays: gapVal });
        setDigestSettings(d => (d ? { ...d, staleDays: staleVal!, minGapDays: gapVal! } : d));
        // Normalise the drafts so e.g. "07" doesn't read as still-dirty.
        setDigestStaleDays(String(staleVal));
        setDigestMinGapDays(String(gapVal));
      }

      if (pageFilterDirty && pageFilterConfig) {
        const payload: Record<string, number | string> = {};
        for (const [key, entry] of Object.entries(pageFilterConfig)) {
          const raw = pageFilterDraft[key] ?? String(entry.currentValue);
          payload[key] = entry.type === 'number' ? parseInt(raw, 10) : raw;
        }
        await PATCH('/api/admin/page-filter-config', payload);
        // Refresh baselines (currentValue) so the section reads as saved.
        await fetchPageFilterConfig();
      }

      if (companyDirty) {
        const result = await PATCH<{ company_name: string }>(
          '/api/admin/settings/company-name',
          { company_name: companyDraft.trim() },
        );
        setCompanyName(result.company_name);
        setCompanyDraft(result.company_name);
      }

      showToast('Settings saved.');
    } catch (e) {
      showToast((e as Error).message || 'Failed to save settings.', true);
      throw e; // keep the tab-switch guard from leaving and the bar in place
    } finally {
      setSaving(false);
    }
  }, [
    digestDirty, pageFilterDirty, companyDirty,
    digestStaleDays, digestMinGapDays,
    pageFilterConfig, pageFilterDraft, companyDraft,
    fetchPageFilterConfig,
  ]);

  const resetDrafts = useCallback(() => {
    if (digestSettings) {
      setDigestStaleDays(String(digestSettings.staleDays ?? 7));
      setDigestMinGapDays(String(digestSettings.minGapDays ?? 7));
    }
    if (pageFilterConfig) {
      const draft: Record<string, string> = {};
      for (const [key, entry] of Object.entries(pageFilterConfig)) {
        draft[key] = String(entry.currentValue);
      }
      setPageFilterDraft(draft);
    }
    setCompanyDraft(companyName);
  }, [digestSettings, pageFilterConfig, companyName]);

  useAdminUnsavedChanges({ id: 'settings', isDirty, onSave: persist, onDiscard: resetDrafts });

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
    GET<{ company_name: string }>('/api/admin/settings/company-name')
      .then(({ company_name }) => { setCompanyName(company_name); setCompanyDraft(company_name); })
      .catch(() => {})
      .finally(() => setCompanyLoading(false));
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
              disabled={digestSettings === null || saving}
            />
            <TextField
              size="small"
              label="Send at most every (days)"
              type="number"
              value={digestMinGapDays}
              onChange={e => setDigestMinGapDays(e.target.value)}
              slotProps={{ htmlInput: { min: 1, max: 365, step: 1 } }}
              sx={{ width: 210 }}
              disabled={digestSettings === null || saving}
            />
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
          <Typography variant="h6" sx={{ mb: 0.5 }}>Notifications</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Control which automated email notifications are sent to team members.
          </Typography>

          {pageFilterConfig === null ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1 }}>
              <CircularProgress size={16} />
              <Typography variant="body2" color="text.secondary">Loading…</Typography>
            </Box>
          ) : (
            <Stack spacing={1.5}>
              <Box>
                <FormControlLabel
                  control={
                    <Switch
                      checked={pageFilterDraft['task_assignment_emails_enabled'] !== 'false'}
                      onChange={e => {
                        const val = e.target.checked ? 'true' : 'false';
                        setPageFilterDraft(d => ({ ...d, task_assignment_emails_enabled: val }));
                      }}
                    />
                  }
                  label="Send email when a task is assigned to a team member"
                />
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', ml: 6 }}>
                  When enabled, an email is sent to the assignee whenever a task is created and
                  assigned to someone other than the creator. Requires SMTP to be configured.
                </Typography>
              </Box>
              <Box>
                <FormControlLabel
                  control={
                    <Switch
                      checked={pageFilterDraft['task_reassignment_emails_enabled'] !== 'false'}
                      onChange={e => {
                        const val = e.target.checked ? 'true' : 'false';
                        setPageFilterDraft(d => ({ ...d, task_reassignment_emails_enabled: val }));
                      }}
                    />
                  }
                  label="Send email when a task is reassigned to a different team member"
                />
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', ml: 6 }}>
                  When enabled, an email is sent to the new assignee whenever a task is moved from
                  one person to another. Disable this to reduce noise during planning sessions.
                  Requires SMTP to be configured.
                </Typography>
              </Box>
            </Stack>
          )}
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent>
          <Box sx={{ mb: 2 }}>
            <Typography variant="h6" sx={{ mb: 0.5 }}>Page defaults</Typography>
            <Typography variant="body2" color="text.secondary">
              Default settings for each page. Changes take effect on the next page load — no restart needed.
            </Typography>
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
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ alignItems: 'flex-start' }}>
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
          <Typography variant="h6" sx={{ mb: 0.5 }}>Generic enquiry form</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Share this link in emails, social posts, or as a QR code. Anyone who opens it can
            submit their contact details without needing a personalised link.
          </Typography>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <TextField
              size="small"
              value={genericFormUrl}
              slotProps={{ input: { readOnly: true } }}
              sx={{ flex: '1 1 320px', minWidth: 0 }}
            />
            <Tooltip title={formLinkCopied ? 'Copied!' : 'Copy link'}>
              <Button
                variant="outlined"
                onClick={copyFormLink}
                startIcon={formLinkCopied ? <CheckIcon /> : <ContentCopyIcon />}
                color={formLinkCopied ? 'success' : 'primary'}
              >
                {formLinkCopied ? 'Copied' : 'Copy'}
              </Button>
            </Tooltip>
            <Button
              variant="outlined"
              href={genericFormUrl}
              target="_blank"
              rel="noopener noreferrer"
              endIcon={<OpenInNewIcon />}
            >
              Open
            </Button>
          </Stack>
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" sx={{ mb: 0.5 }}>Email signature</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Each team member's personal signature is automatically appended to customer-facing emails
            they send. It is built from their profile (name, job role, email, phone) and the company
            name below.
          </Typography>
          {companyLoading ? (
            <CircularProgress size={20} />
          ) : (
            <TextField
              label="Company name"
              size="small"
              value={companyDraft}
              onChange={e => setCompanyDraft(e.target.value)}
              disabled={saving}
              placeholder="e.g. Gautier Design Ltd"
              slotProps={{ htmlInput: { maxLength: 200 } }}
              sx={{ flex: 1, maxWidth: 420 }}
            />
          )}
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
            Each user's phone number and job role are managed on their own profile page.
          </Typography>
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
