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

interface DevContact {
  id: string;
  properties: Record<string, string | undefined>;
}

const W = window as unknown as Record<string, unknown>;

function callApi(method: string, path: string, body?: unknown): Promise<unknown> {
  if (typeof W.api === 'function') {
    return (W.api as (m: string, p: string, b?: unknown) => Promise<unknown>)(method, path, body);
  }
  return fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).then(r => r.ok ? r.json() : r.json().then((e: { error?: string }) => { throw new Error(e.error || r.statusText); }));
}

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
}

export function SettingsPage() {
  const [statuses, setStatuses] = useState<LeadStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [hubStatus, setHubStatus] = useState<HubStatus | null>(null);
  const [devMode, setDevMode] = useState(false);
  const [devContacts, setDevContacts] = useState<DevContact[]>([]);
  const [devLoading, setDevLoading] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newStage, setNewStage] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [addErr, setAddErr] = useState('');
  const [digestSettings, setDigestSettings] = useState<DigestSettings | null>(null);
  const [digestSending, setDigestSending] = useState(false);

  const statusesRef = useRef<LeadStatus[]>([]);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatuses = useCallback(async () => {
    try {
      const data = await callApi('GET', '/api/admin/lead-statuses') as LeadStatus[];
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
      const data = await callApi('GET', '/api/hubspot/status') as HubStatus;
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
      const data = await callApi('GET', '/api/admin/conflict-digest-settings') as DigestSettings;
      setDigestSettings(data);
    } catch {}
  }, []);

  const sendDigestNow = useCallback(async () => {
    setDigestSending(true);
    try {
      const data = await callApi('POST', '/api/admin/conflict-digest/send-now') as { sent: boolean; lastSentAt: string | null };
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

  const initDevSection = useCallback(async () => {
    let dm = false;
    try {
      const d = await callApi('GET', '/api/admin/hubspot/dev-mode') as { devMode?: boolean };
      dm = d?.devMode === true;
    } catch {}
    setDevMode(dm);
    if (!dm) return;
    setDevLoading(true);
    try {
      let contacts: DevContact[] = [];
      let page = 1; let total = 1;
      do {
        const d = await callApi('GET', `/api/contacts-all?all=1&limit=100&page=${page}`) as { results?: DevContact[]; totalPages?: number };
        if (!d) break;
        contacts = contacts.concat(d.results || []);
        total = d.totalPages || 1;
        page++;
      } while (page <= total);
      setDevContacts(contacts.filter(c => c.properties?.hw_test_user === 'true'));
    } catch {}
    setDevLoading(false);
  }, []);

  useEffect(() => {
    fetchHubStatus();
    fetchStatuses();
    initDevSection();
    fetchDigestSettings();
    return () => { if (cooldownRef.current) clearInterval(cooldownRef.current); };
  }, [fetchHubStatus, fetchStatuses, initDevSection, fetchDigestSettings]);

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
        const updated = await callApi('PATCH', `/api/admin/lead-statuses/${encodeURIComponent(key)}`, diff) as LeadStatus;
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
        callApi('PATCH', `/api/admin/lead-statuses/${encodeURIComponent(a.key)}`, { sort_order: b.sort_order }),
        callApi('PATCH', `/api/admin/lead-statuses/${encodeURIComponent(b.key)}`, { sort_order: a.sort_order }),
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
      const created = await callApi('POST', '/api/admin/lead-statuses', { key: k, label: l, stage: s }) as LeadStatus;
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
    W.loadDevTestUsers      = initDevSection;
    return () => {
      delete W.saveAllLeadStatuses;
      delete W.moveLeadStatus;
      delete W.addLeadStatus;
      delete W.loadLeadStatusesAdmin;
      delete W.loadHubspotStatus;
      delete W.loadDevTestUsers;
    };
  }, [saveAll, moveStatus, addStatus, fetchStatuses, fetchHubStatus, initDevSection]);

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

      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" sx={{ mb: 0.5 }}>Conflict digest</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            A weekly email is automatically sent to admins listing team members whose onboarding
            conflicts have been unresolved for 7 or more days.
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
              "Send now" bypasses the 7-day gate and sends immediately if there are stale conflicts.
            </Typography>
          )}
        </CardContent>
      </Card>

      {devMode && (
        <Card variant="outlined" id="dev-test-users-section">
          <CardContent>
            <Box sx={{ mb: 2 }}>
              <Typography variant="h6">Dev test users</Typography>
              <Typography variant="body2" color="text.secondary">
                Contacts currently marked as dev test users in HubSpot (<code>hw_test_user = true</code>).
                Toggling is done directly in HubSpot.
              </Typography>
            </Box>

            <Box id="dev-test-users-list">
              {devLoading ? (
                <p className="admin-msg admin-msg--muted">Loading contacts…</p>
              ) : !devContacts.length ? (
                <p className="admin-msg admin-msg--muted">No dev test users found.</p>
              ) : devContacts.map(c => {
                const first = c.properties?.firstname || '';
                const last  = c.properties?.lastname  || '';
                const name  = [first, last].filter(Boolean).join(' ') || `Contact ${c.id}`;
                const email = c.properties?.email || '';
                return (
                  <Box key={c.id} id={`dtu-row-${c.id}`} sx={{ display: 'flex', alignItems: 'center', py: 0.75, borderBottom: '1px solid #f3f4f6', gap: 1.5 }}>
                    <Box>
                      <Typography variant="body2" sx={{ fontWeight: 500 }}>{name}</Typography>
                      {email && <Typography variant="caption" color="text.secondary">{email}</Typography>}
                    </Box>
                  </Box>
                );
              })}
            </Box>
          </CardContent>
        </Card>
      )}
    </Stack>
  );
}

export default SettingsPage;
