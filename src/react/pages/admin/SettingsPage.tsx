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
  TextField,
  Typography,
} from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import SyncIcon from '@mui/icons-material/Sync';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import ErrorOutlinedIcon from '@mui/icons-material/ErrorOutlined';
import { GET, POST, PATCH, DELETE } from '../../utils/api';

const STAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '—' },
  { value: 'SALES', label: 'Sales' },
  { value: 'DESIGN_VISIT', label: 'Design Visit' },
  { value: 'SURVEY', label: 'Survey' },
  { value: 'ORDER', label: 'Order' },
  { value: 'WORKSHOP', label: 'Workshop' },
  { value: 'PACKING', label: 'Packing' },
  { value: 'DELIVERY', label: 'Delivery' },
  { value: 'INSTALLATION', label: 'Installation' },
  { value: 'AFTERCARE', label: 'Aftercare' },
  { value: 'CUSTOMER_SERVICE', label: 'Customer Service' },
];

interface LeadStatus {
  key: string;
  label: string;
  stage: string | null;
  shorthand: string;
  sort_order: number;
  excluded_from_sales: boolean;
  is_null_row: boolean;
}

interface HubStatus {
  connected: boolean;
  code?: string;
  cooldownSecondsRemaining?: number;
}

const W = window as unknown as Record<string, unknown>;

function showToast(msg: string, err?: boolean) {
  if (typeof W.toast === 'function') (W.toast as (m: string, e?: boolean) => void)(msg, err);
}

function notifyLsChanged() {
  try { new BroadcastChannel('lead_statuses_changed').postMessage('changed'); } catch {}
  if (typeof W.loadCardActionsAdmin === 'function') (W.loadCardActionsAdmin as () => void)();
}

const TH: React.CSSProperties = {
  padding: '6px 8px',
  textAlign: 'left',
  borderBottom: '1px solid #e5e7eb',
  background: '#f9fafb',
  fontSize: '0.75rem',
  fontWeight: 600,
  color: '#6b7280',
  whiteSpace: 'nowrap',
};
const TD: React.CSSProperties = {
  padding: '4px 8px',
  borderBottom: '1px solid #f3f4f6',
  verticalAlign: 'middle',
};

function NullStatusRow({ status }: { status: LeadStatus }) {
  return (
    <tr style={{ background: '#f9fafb' }} data-ls-key={status.key} data-ls-no-delete="1">
      <td style={{ ...TD, textAlign: 'center' }}>
        <button className="btn btn-ghost" disabled style={{ fontSize: '.75rem', padding: '0 4px', opacity: 0.35 }}>↑</button>
        <button className="btn btn-ghost" disabled style={{ fontSize: '.75rem', padding: '0 4px', opacity: 0.35 }}>↓</button>
      </td>
      <td style={{ ...TD, color: '#9ca3af' }}>—</td>
      <td style={{ ...TD, fontFamily: 'monospace', color: '#9ca3af', fontSize: '0.75rem' }}>— none —</td>
      <td style={TD}>
        <input type="text" className="field ls-shorthand-input" maxLength={4}
          defaultValue={status.shorthand || ''} data-key={status.key}
          title="4-character shorthand"
          onInput={(e) => { const t = e.currentTarget; t.value = t.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          style={{ width: 56, textAlign: 'center', fontFamily: 'monospace' }}
        />
      </td>
      <td style={TD}>
        <input type="text" className="field ls-label-input" defaultValue={status.label} data-key={status.key}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          style={{ width: '100%', minWidth: 140 }}
        />
      </td>
      <td style={{ ...TD, textAlign: 'center', color: '#9ca3af' }}>—</td>
    </tr>
  );
}

function StatusRow({ status, index, total, onMove }: {
  status: LeadStatus;
  index: number;
  total: number;
  onMove: (key: string, dir: 'up' | 'down') => void;
}) {
  return (
    <tr style={{ background: index % 2 ? '#f9fafb' : '#fff' }} data-ls-key={status.key}>
      <td style={{ ...TD, textAlign: 'center', whiteSpace: 'nowrap' }}>
        <button className="btn btn-ghost" title="Move up" disabled={index === 0}
          onClick={() => onMove(status.key, 'up')} style={{ fontSize: '.75rem', padding: '0 4px' }}>↑</button>
        <button className="btn btn-ghost" title="Move down" disabled={index === total - 1}
          onClick={() => onMove(status.key, 'down')} style={{ fontSize: '.75rem', padding: '0 4px' }}>↓</button>
      </td>
      <td style={TD}>
        <select className="field ls-stage-select" data-key={status.key} defaultValue={status.stage || ''}
          style={{ width: '100%', minWidth: 120 }}>
          {STAGE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </td>
      <td style={{ ...TD, fontFamily: 'monospace', fontSize: '0.75rem' }}>{status.key}</td>
      <td style={TD}>
        <input type="text" className="field ls-shorthand-input" maxLength={4}
          defaultValue={status.shorthand || ''} data-key={status.key}
          title="4-character shorthand"
          onInput={(e) => { const t = e.currentTarget; t.value = t.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          style={{ width: 56, textAlign: 'center', fontFamily: 'monospace' }}
        />
      </td>
      <td style={TD}>
        <input type="text" className="field ls-label-input" defaultValue={status.label} data-key={status.key}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          style={{ width: '100%', minWidth: 140 }}
        />
      </td>
      <td style={{ ...TD, textAlign: 'center' }}>
        <input type="checkbox" defaultChecked={!!status.excluded_from_sales} data-key={status.key} />
      </td>
    </tr>
  );
}

interface DigestSettings {
  lastSentAt: string | null;
  smtpConfigured: boolean;
  staleDays: number;
  minGapDays: number;
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

interface PageFilterConfigEntry {
  label: string;
  type: 'number' | 'json';
  min?: number;
  max?: number;
  currentValue: number | string;
}

type PageFilterConfig = Record<string, PageFilterConfigEntry>;

export function SettingsPage() {
  const [statuses, setStatuses] = useState<LeadStatus[]>([]);
  const [storybookBuilt, setStorybookBuilt] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [hubStatus, setHubStatus] = useState<HubStatus | null>(null);
  const [newKey, setNewKey] = useState('');
  const [newStage, setNewStage] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [addErr, setAddErr] = useState('');
  const [digestSettings, setDigestSettings] = useState<DigestSettings | null>(null);
  const [digestSending, setDigestSending] = useState(false);
  const [digestStaleDays, setDigestStaleDays] = useState<string>('7');
  const [digestMinGapDays, setDigestMinGapDays] = useState<string>('7');
  const [digestThresholdSaving, setDigestThresholdSaving] = useState(false);

  const [webhookStatus, setWebhookStatus] = useState<WebhookStatus | null>(null);
  const [webhookLoading, setWebhookLoading] = useState(true);
  const [webhookActing, setWebhookActing] = useState(false);

  const [pageFilterConfig, setPageFilterConfig] = useState<PageFilterConfig | null>(null);
  const [pageFilterDraft, setPageFilterDraft] = useState<Record<string, string>>({});
  const [pageFilterSaving, setPageFilterSaving] = useState(false);

  const [syncingHubspot, setSyncingHubspot] = useState(false);

  const statusesRef = useRef<LeadStatus[]>([]);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatuses = useCallback(async () => {
    try {
      const data = await GET<LeadStatus[]>('/api/admin/lead-statuses');
      const list = Array.isArray(data) ? data : [];
      setStatuses(list);
      statusesRef.current = list;
      setLoading(false);
      setReloadKey(k => k + 1);
    } catch {
      setLoading(false);
    }
  }, []);

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

  const fetchDigestSettings = useCallback(async () => {
    try {
      const data = await GET<DigestSettings>('/api/admin/conflict-digest-settings');
      setDigestSettings(data);
      setDigestStaleDays(String(data.staleDays ?? 7));
      setDigestMinGapDays(String(data.minGapDays ?? 7));
    } catch {}
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

  const syncSubstatusesToHubSpot = useCallback(async () => {
    setSyncingHubspot(true);
    try {
      await POST('/api/admin/lead-substatuses/sync-hubspot');
      showToast('Sub-statuses synced to HubSpot successfully.');
    } catch (e) {
      showToast((e as Error).message || 'HubSpot sync failed.', true);
    } finally {
      setSyncingHubspot(false);
    }
  }, []);

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
    fetchHubStatus();
    fetchStatuses();
    fetchDigestSettings();
    fetchWebhookStatus();
    fetchPageFilterConfig();
    fetch('/storybook/index.html', { method: 'HEAD' })
      .then((r) => setStorybookBuilt(r.ok))
      .catch(() => setStorybookBuilt(false));
    return () => { if (cooldownRef.current) clearInterval(cooldownRef.current); };
  }, [fetchHubStatus, fetchStatuses, fetchDigestSettings, fetchWebhookStatus, fetchPageFilterConfig]);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    let bc: BroadcastChannel;
    try { bc = new BroadcastChannel('lead_statuses_changed'); bc.onmessage = () => fetchStatuses(); } catch { return; }
    return () => bc.close();
  }, [fetchStatuses]);

  const saveAll = useCallback(async () => {
    const wrap = document.getElementById('lead-statuses-table-wrap');
    if (!wrap) return;
    type RowChange = {
      key: string;
      diff: Record<string, unknown>;
      els: { lbl?: HTMLInputElement; stg?: HTMLSelectElement; excl?: HTMLInputElement; sh?: HTMLInputElement };
      orig: LeadStatus;
    };
    const changes: RowChange[] = [];
    wrap.querySelectorAll<HTMLTableRowElement>('tr[data-ls-key]').forEach(row => {
      const key = row.dataset.lsKey!;
      const orig = statusesRef.current.find(s => s.key === key);
      if (!orig) return;
      const lbl  = row.querySelector<HTMLInputElement>('.ls-label-input') ?? undefined;
      const stg  = row.querySelector<HTMLSelectElement>('.ls-stage-select') ?? undefined;
      const excl = row.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? undefined;
      const sh   = row.querySelector<HTMLInputElement>('.ls-shorthand-input') ?? undefined;
      const newLbl  = lbl?.value.trim() ?? orig.label;
      const newStg2 = stg?.value || null;
      const newExcl = excl?.checked ?? orig.excluded_from_sales;
      const rawSh   = (sh?.value.trim().toUpperCase() ?? (orig.shorthand || '')).slice(0, 4);
      if (!newLbl) return;
      const diff: Record<string, unknown> = {};
      if (newLbl !== orig.label) diff.label = newLbl;
      if (newStg2 !== (orig.stage || null)) diff.stage = newStg2;
      if (newExcl !== orig.excluded_from_sales) diff.excluded_from_sales = newExcl;
      if (rawSh && rawSh !== (orig.shorthand || '').toUpperCase()) {
        if (!/^[A-Z0-9]{4}$/.test(rawSh)) {
          showToast(`Shorthand for ${key} must be 4 characters (A–Z, 0–9).`, true);
          if (sh) sh.value = orig.shorthand || '';
          return;
        }
        diff.shorthand = rawSh;
      }
      if (Object.keys(diff).length) changes.push({ key, diff, els: { lbl, stg, excl, sh }, orig });
    });
    if (!changes.length) { showToast('No changes to save.'); return; }
    let saved = 0, failed = 0;
    const msgs: string[] = [];
    for (const { key, diff, els, orig } of changes) {
      try {
        const updated = await PATCH<LeadStatus>(`/api/admin/lead-statuses/${encodeURIComponent(key)}`, diff);
        const next = [...statusesRef.current];
        const i = next.findIndex(s => s.key === key);
        if (i !== -1) next[i] = updated;
        setStatuses(next); statusesRef.current = next;
        saved++;
      } catch (e) {
        if (els.lbl)  els.lbl.value    = orig.label;
        if (els.stg)  els.stg.value    = orig.stage || '';
        if (els.excl) els.excl.checked = orig.excluded_from_sales;
        if (els.sh)   els.sh.value     = orig.shorthand || '';
        msgs.push(`${key}: ${(e as Error).message}`); failed++;
      }
    }
    if (failed) showToast(`Saved ${saved}, failed ${failed}. ${msgs[0] || ''}`.trim(), true);
    else showToast(`${saved} change${saved !== 1 ? 's' : ''} saved.`);
    notifyLsChanged();
  }, []);

  const moveStatus = useCallback(async (key: string, dir: 'up' | 'down') => {
    const arr = statusesRef.current;
    const idx = arr.findIndex(s => s.key === key);
    if (idx < 0) return;
    const si = dir === 'up' ? idx - 1 : idx + 1;
    if (si < 0 || si >= arr.length) return;
    const a = arr[idx], b = arr[si];
    try {
      await Promise.all([
        PATCH(`/api/admin/lead-statuses/${encodeURIComponent(a.key)}`, { sort_order: b.sort_order }),
        PATCH(`/api/admin/lead-statuses/${encodeURIComponent(b.key)}`, { sort_order: a.sort_order }),
      ]);
      const next = [...arr];
      next[idx] = { ...b, sort_order: a.sort_order };
      next[si]  = { ...a, sort_order: b.sort_order };
      setStatuses(next); statusesRef.current = next;
      setReloadKey(k => k + 1);
      notifyLsChanged();
    } catch (e) { showToast(`Failed to reorder: ${(e as Error).message}`, true); }
  }, []);

  const addStatus = useCallback(async () => {
    const k = newKey.trim().toUpperCase();
    const l = newLabel.trim();
    const s = newStage || null;
    if (!k) { setAddErr('Key is required.'); return; }
    if (!l) { setAddErr('Display label is required.'); return; }
    setAddErr('');
    try {
      const created = await POST<LeadStatus>('/api/admin/lead-statuses', { key: k, label: l, stage: s });
      const next = [...statusesRef.current, created];
      setStatuses(next); statusesRef.current = next;
      setNewKey(''); setNewStage(''); setNewLabel('');
      setReloadKey(rk => rk + 1);
      notifyLsChanged();
    } catch (e) { setAddErr((e as Error).message || 'Failed to add status.'); }
  }, [newKey, newLabel, newStage]);


  useEffect(() => {
    W.saveAllLeadStatuses   = saveAll;
    W.moveLeadStatus        = (key: string, dir: 'up' | 'down') => moveStatus(key, dir);
    W.addLeadStatus         = addStatus;
    W.loadLeadStatusesAdmin = fetchStatuses;
    W.loadHubspotStatus     = fetchHubStatus;
    return () => {
      delete W.saveAllLeadStatuses;
      delete W.moveLeadStatus;
      delete W.addLeadStatus;
      delete W.loadLeadStatusesAdmin;
      delete W.loadHubspotStatus;
    };
  }, [saveAll, moveStatus, addStatus, fetchStatuses, fetchHubStatus]);

  const badge = (() => {
    if (!hubStatus) return { text: 'Checking…', bg: '#f3f4f6', color: '#6b7280' };
    if (hubStatus.connected) return { text: 'Connected', bg: '#dcfce7', color: '#166534' };
    if (hubStatus.code === 'HUBSPOT_RATE_LIMIT') {
      const secs = hubStatus.cooldownSecondsRemaining;
      return { text: secs && secs > 0 ? `Rate limited — retrying in ${secs} s` : 'Rate limited — rechecking…', bg: '#fef3c7', color: '#92400e' };
    }
    if (hubStatus.code === 'NO_TOKEN')  return { text: 'No token set', bg: '#fee2e2', color: '#991b1b' };
    if (hubStatus.code === 'ERROR')     return { text: 'Could not check', bg: '#fef3c7', color: '#92400e' };
    return { text: 'Not connected — check your token', bg: '#fee2e2', color: '#991b1b' };
  })();

  const real    = statuses.filter(s => !s.is_null_row);
  const nullRow = statuses.find(s => s.is_null_row);

  return (
    <Stack spacing={2}>
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" sx={{ mb: 1 }}>Integrations</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Connection status for external services used by Measure Once.
          </Typography>

          <Box id="hubspot-status-row" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, p: 1.25, borderRadius: 1, border: 1, borderColor: 'divider' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Box component="svg" width={18} height={18} viewBox="0 0 18 18" fill="none" sx={{ flexShrink: 0 }}>
                <rect width="18" height="18" rx="4" fill="#FF7A59" />
                <text x="9" y="13" textAnchor="middle" fontSize="10" fontWeight="700" fill="#fff" fontFamily="sans-serif">HS</text>
              </Box>
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

          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, mt: 1.5, p: 1.25, borderRadius: 1, border: 1, borderColor: 'divider' }}>
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>Re-sync sub-statuses to HubSpot</Typography>
              <Typography variant="caption" color="text.secondary">
                Push the current sub-status list to HubSpot as <Box component="code" sx={{ fontSize: '0.8em' }}>hw_lead_substatus</Box> enumeration options. Use this to recover from a sync failure.
              </Typography>
            </Box>
            <Button
              variant="outlined"
              size="small"
              startIcon={syncingHubspot ? <CircularProgress size={14} color="inherit" /> : <SyncIcon />}
              disabled={syncingHubspot}
              onClick={syncSubstatusesToHubSpot}
              sx={{ flexShrink: 0 }}
            >
              {syncingHubspot ? 'Syncing…' : 'Re-sync now'}
            </Button>
          </Box>

          <Divider sx={{ my: 3 }} />

          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, mb: 2 }}>
            <Box>
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Lead Statuses</Typography>
              <Typography variant="body2" color="text.secondary">
                Define the HubSpot lead status values and their display labels. Statuses marked
                "Excl. from Sales" are hidden from the Sales board.
              </Typography>
            </Box>
            <Button variant="contained" onClick={saveAll} sx={{ flexShrink: 0 }}>Save</Button>
          </Box>

          <div id="lead-statuses-table-wrap">
            {loading ? (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1 }}>
                <CircularProgress size={16} />
                <Typography variant="body2" color="text.secondary">Loading…</Typography>
              </Box>
            ) : (!nullRow && !real.length) ? (
              <p className="admin-msg admin-msg--muted">No statuses configured yet.</p>
            ) : (
              <Box sx={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
                  <thead>
                    <tr>
                      <th style={{ ...TH, textAlign: 'center' }}>Order</th>
                      <th style={TH}>Stage</th>
                      <th style={TH}>Key</th>
                      <th style={TH} title="4-character shorthand used to prefix sub-status keys">Shorthand</th>
                      <th style={TH}>Display Label</th>
                      <th style={{ ...TH, textAlign: 'center' }}>Excl. from Sales</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nullRow && <NullStatusRow key={`${nullRow.key}-${reloadKey}`} status={nullRow} />}
                    {real.map((s, i) => (
                      <StatusRow key={`${s.key}-${reloadKey}`} status={s} index={i} total={real.length} onMove={moveStatus} />
                    ))}
                  </tbody>
                </table>
              </Box>
            )}
          </div>

          <Box sx={{ mt: 3, p: 2, borderRadius: 1, border: 1, borderColor: 'divider', bgcolor: 'background.default' }}>
            <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>Add new status</Typography>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ alignItems: { md: 'flex-end' } }}>
              <TextField size="small" label="Key (e.g. AWAITING_PHOTOS)" placeholder="KEY"
                value={newKey} onChange={(e) => setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
                slotProps={{ htmlInput: { id: 'ls-new-key', maxLength: 64 }}} sx={{ flex: 1 }} />
              <Box sx={{ minWidth: 160, display: 'flex', flexDirection: 'column' }}>
                <Typography component="label" htmlFor="ls-new-stage" variant="caption" color="text.secondary" sx={{ mb: 0.5 }}>Stage</Typography>
                <select id="ls-new-stage" value={newStage} onChange={(e) => setNewStage(e.target.value)}
                  style={{ height: 40, padding: '8px 12px', borderRadius: 4, border: '1px solid rgba(0,0,0,0.23)', background: '#fff', font: 'inherit' }}>
                  {STAGE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </Box>
              <TextField size="small" label="Display label" placeholder="Human-readable label"
                value={newLabel} onChange={(e) => setNewLabel(e.target.value)}
                slotProps={{ htmlInput: { id: 'ls-new-label', maxLength: 128 }}} sx={{ flex: 2 }} />
              <Button variant="contained" onClick={addStatus}>Add status</Button>
            </Stack>
            {addErr && <Typography variant="caption" color="error" sx={{ mt: 1, display: 'block' }}>{addErr}</Typography>}
            <div id="ls-add-error" style={{ display: 'none' }} />
          </Box>
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
                        <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
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

export default SettingsPage;
