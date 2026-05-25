import React, { useState } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  Divider,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';

/**
 * Admin → Settings tab (#tab-settings).
 *
 * MUI shell that renders the same legacy mount divs and inputs the existing
 * loaders (loadHubspotStatus / loadLeadStatusesAdmin / loadDevTestUsers) and
 * inline save handlers in public/admin.html still target by id. Selectors
 * preserved verbatim so test:lead-status-sync and the legacy save paths keep
 * working unchanged.
 */

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

function callGlobal(name: string, ...args: unknown[]): void {
  const fn = (window as unknown as Record<string, unknown>)[name];
  if (typeof fn === 'function') (fn as (...a: unknown[]) => unknown)(...args);
}

export function SettingsPage() {
  const [newKey, setNewKey] = useState('');
  const [newStage, setNewStage] = useState('');
  const [newLabel, setNewLabel] = useState('');

  return (
    <Stack spacing={2}>
      {/* ── Integrations + Lead Statuses ──────────────────────────────── */}
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" sx={{ mb: 1 }}>Integrations</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Connection status for external services used by Measure Once.
          </Typography>

          <Box
            id="hubspot-status-row"
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 2,
              p: 1.25,
              borderRadius: 1,
              border: 1,
              borderColor: 'divider',
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Box
                component="svg"
                width={18}
                height={18}
                viewBox="0 0 18 18"
                fill="none"
                sx={{ flexShrink: 0 }}
              >
                <rect width="18" height="18" rx="4" fill="#FF7A59" />
                <text
                  x="9"
                  y="13"
                  textAnchor="middle"
                  fontSize="10"
                  fontWeight="700"
                  fill="#fff"
                  fontFamily="sans-serif"
                >
                  HS
                </text>
              </Box>
              <Typography variant="body2" fontWeight={600}>HubSpot CRM</Typography>
            </Box>
            <span id="hubspot-status-badge" className="adm-status-badge">Checking…</span>
          </Box>

          <Divider sx={{ my: 3 }} />

          <Box
            sx={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: 2,
              mb: 2,
            }}
          >
            <Box>
              <Typography variant="subtitle1" fontWeight={600}>Lead Statuses</Typography>
              <Typography variant="body2" color="text.secondary">
                Define the HubSpot lead status values and their display labels. Statuses marked
                "Excl. from Sales" are hidden from the Sales board.
              </Typography>
            </Box>
            <Button
              variant="contained"
              onClick={() => callGlobal('saveAllLeadStatuses')}
              sx={{ flexShrink: 0 }}
            >
              Save
            </Button>
          </Box>

          {/* Legacy renderLeadStatusesTable() writes the <table> here. */}
          <div id="lead-statuses-table-wrap">
            <p className="admin-msg admin-msg--muted">Loading…</p>
          </div>

          <Box
            sx={{
              mt: 3,
              p: 2,
              borderRadius: 1,
              border: 1,
              borderColor: 'divider',
              bgcolor: 'background.default',
            }}
          >
            <Typography variant="subtitle2" fontWeight={600} sx={{ mb: 1.5 }}>
              Add new status
            </Typography>
            <Stack
              direction={{ xs: 'column', md: 'row' }}
              spacing={1.5}
              alignItems={{ md: 'flex-end' }}
            >
              <TextField
                size="small"
                label="Key (e.g. AWAITING_PHOTOS)"
                placeholder="KEY"
                value={newKey}
                onChange={(e) =>
                  setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))
                }
                inputProps={{ id: 'ls-new-key', maxLength: 64, className: 'field adm-key-input' }}
                sx={{ flex: 1 }}
              />
              {/*
                Native <select> at id `ls-new-stage` (not MUI Select) so the
                legacy inline addLeadStatus() handler in public/admin.html
                can read document.getElementById('ls-new-stage').value
                unchanged. The TextField below uses the native input the same
                way for the same reason.
              */}
              <Box sx={{ minWidth: 160, display: 'flex', flexDirection: 'column' }}>
                <Typography
                  component="label"
                  htmlFor="ls-new-stage"
                  variant="caption"
                  color="text.secondary"
                  sx={{ mb: 0.5 }}
                >
                  Stage
                </Typography>
                <select
                  id="ls-new-stage"
                  className="field"
                  value={newStage}
                  onChange={(e) => setNewStage(e.target.value)}
                  style={{
                    height: 40,
                    padding: '8px 12px',
                    borderRadius: 4,
                    border: '1px solid rgba(0,0,0,0.23)',
                    background: '#fff',
                    font: 'inherit',
                  }}
                >
                  {STAGE_OPTIONS.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </Box>
              <TextField
                size="small"
                label="Display label"
                placeholder="Human-readable label"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                inputProps={{ id: 'ls-new-label', maxLength: 128, className: 'field' }}
                sx={{ flex: 2 }}
              />
              <Button
                variant="contained"
                onClick={() => {
                  callGlobal('addLeadStatus');
                  // addLeadStatus reads from the inputs and clears them on success;
                  // sync our React state from the DOM after the call settles.
                  setTimeout(() => {
                    const k = (document.getElementById('ls-new-key') as HTMLInputElement | null)?.value || '';
                    const st = (document.getElementById('ls-new-stage') as HTMLSelectElement | null)?.value || '';
                    const lb = (document.getElementById('ls-new-label') as HTMLInputElement | null)?.value || '';
                    setNewKey(k);
                    setNewStage(st);
                    setNewLabel(lb);
                  }, 50);
                }}
              >
                Add status
              </Button>
            </Stack>
            <div id="ls-add-error" className="adm-msg-err-xs hidden" />
          </Box>
        </CardContent>
      </Card>

      {/* ── Dev test users (hidden in production) ─────────────────────── */}
      <Card
        variant="outlined"
        id="dev-test-users-section"
        className="hidden"
      >
        <CardContent>
          <Box sx={{ mb: 2 }}>
            <Typography variant="h6">Dev test users</Typography>
            <Typography variant="body2" color="text.secondary">
              In development mode the customer list is filtered to contacts marked below. Toggle a
              contact to include or exclude it from the dev view.
            </Typography>
          </Box>

          <Box
            id="dev-filter-toggle-row"
            sx={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 2,
              p: 1.5,
              borderRadius: 1,
              border: 1,
              borderColor: 'divider',
              mb: 1,
            }}
          >
            <Box>
              <Typography variant="body2" fontWeight={600}>Dev filter</Typography>
              <Typography variant="caption" color="text.secondary">
                When ON, only contacts marked below appear in the Customers list and lead-status
                counts. Turn OFF to see all HubSpot contacts as in production.
              </Typography>
            </Box>
            {/* Legacy `setDevFilter(this.checked)` needs the native checkbox at this id. */}
            <label className="ss-toggle flex-shrink-0" title="Toggle dev filter">
              <input
                type="checkbox"
                id="dev-filter-global-toggle"
                defaultChecked
                onChange={(e) => callGlobal('setDevFilter', e.currentTarget.checked)}
              />
              <span className="ss-toggle-track" />
            </label>
          </Box>
          <div id="dev-filter-toggle-label" className="adm-dtu-status-badge">Dev filter: ON</div>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mt: 2 }}>
            <Button
              variant="outlined"
              id="dev-backfill-btn"
              onClick={() => callGlobal('backfillTestUserDefaults')}
            >
              Set unset contacts to false
            </Button>
            <span id="dev-backfill-result" className="adm-text-muted-sm" />
          </Box>

          <Box id="dev-test-users-list" className="adm-dtu-list" sx={{ mt: 2 }}>
            <p className="admin-msg admin-msg--muted">Loading…</p>
          </Box>
        </CardContent>
      </Card>
    </Stack>
  );
}

export default SettingsPage;
