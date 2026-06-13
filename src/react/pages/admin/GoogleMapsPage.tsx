import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  FormControlLabel,
  FormLabel,
  InputAdornment,
  Link,
  Radio,
  RadioGroup,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import ErrorOutlinedIcon from '@mui/icons-material/ErrorOutlined';
import MapIcon from '@mui/icons-material/Map';
import RefreshIcon from '@mui/icons-material/Refresh';
import { GET, PUT, POST } from '../../utils/api';
import { usePageTitle } from '../../hooks/usePageTitle';
import { COUNTRIES } from '../../../../shared/address';
import { invalidateGoogleMapsConfig } from '../../lib/googleMapsConfig';

const CLOUD_CONSOLE_CREDENTIALS_URL =
  'https://console.cloud.google.com/google/maps-apis/credentials';

type SurfaceId = 'customerInfo' | 'designVisit' | 'arrangeVisit' | 'contactEdit';

interface SurfaceFlags {
  autocomplete: boolean;
  mapPreview: boolean;
}

interface GoogleMapsSettings {
  enabled: boolean;
  autocomplete: {
    countries: string[];
    language: string;
    types: 'address' | 'establishment' | 'geocode';
    debounceMs: number;
    minChars: number;
    sessionTokens: boolean;
  };
  surfaces: Record<SurfaceId, SurfaceFlags>;
  mapPreview: {
    enabled: boolean;
    zoom: number;
    mapType: 'roadmap' | 'satellite' | 'hybrid' | 'terrain';
  };
  fallback: {
    mode: 'silent' | 'notice';
    allowManualEntry: boolean;
  };
}

interface SettingsResponse {
  settings: GoogleMapsSettings;
  keyPresent: boolean;
  keyLast4: string | null;
}

interface CheckResult {
  ok: boolean;
  latencyMs?: number;
  status?: string | number;
  error?: string;
}

interface TestResponse {
  ok: boolean;
  keyPresent: boolean;
  keyLast4?: string | null;
  error?: string;
  checks: Record<string, CheckResult>;
}

interface Diagnostics {
  today: Record<string, number>;
  month: Record<string, number>;
  recentErrors: Array<{
    timestamp: string;
    api: string;
    surface: string | null;
    errorCode: string | null;
    message: string | null;
  }>;
}

const SURFACE_LABELS: Record<SurfaceId, string> = {
  customerInfo: 'Customer info form (public)',
  designVisit: 'Design visit wizard',
  arrangeVisit: 'Arrange visit modal',
  contactEdit: 'Customer contact editor',
};

const W = window as unknown as Record<string, unknown>;
function showToast(msg: string, err?: boolean) {
  if (typeof W.toast === 'function') (W.toast as (m: string, e?: boolean) => void)(msg, err);
}

export function GoogleMapsPage() {
  usePageTitle('Google Maps · Measure Once');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [keyPresent, setKeyPresent] = useState(false);
  const [keyLast4, setKeyLast4] = useState<string | null>(null);
  const [settings, setSettings] = useState<GoogleMapsSettings | null>(null);
  const [draft, setDraft] = useState<GoogleMapsSettings | null>(null);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResponse | null>(null);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    try {
      const res = await GET<SettingsResponse>('/api/admin/google-maps-settings');
      setSettings(res.settings);
      setDraft(res.settings);
      setKeyPresent(res.keyPresent);
      setKeyLast4(res.keyLast4);
    } catch (e) {
      showToast((e as Error).message || 'Failed to load Google Maps settings.', true);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchDiagnostics = useCallback(async () => {
    setDiagLoading(true);
    try {
      setDiag(await GET<Diagnostics>('/api/admin/google-maps/diagnostics'));
    } catch {
      /* non-fatal */
    } finally {
      setDiagLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
    fetchDiagnostics();
  }, [fetchSettings, fetchDiagnostics]);

  const patch = useCallback((updater: (d: GoogleMapsSettings) => GoogleMapsSettings) => {
    setDraft((prev) => (prev ? updater(prev) : prev));
  }, []);

  const handleSave = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const res = await PUT<SettingsResponse>('/api/admin/google-maps-settings', { settings: draft });
      setSettings(res.settings);
      setDraft(res.settings);
      setKeyPresent(res.keyPresent);
      setKeyLast4(res.keyLast4);
      // Drop the cached client config so live surfaces pick up the new settings
      // on their next mount without a full page reload.
      invalidateGoogleMapsConfig();
      showToast('Google Maps settings saved.');
    } catch (e) {
      showToast((e as Error).message || 'Failed to save settings.', true);
    } finally {
      setSaving(false);
    }
  }, [draft]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await POST<TestResponse>('/api/admin/google-maps/test-connection'));
    } catch (e) {
      setTestResult({ ok: false, keyPresent, error: (e as Error).message, checks: {} });
    } finally {
      setTesting(false);
      fetchDiagnostics();
    }
  }, [keyPresent, fetchDiagnostics]);

  const isDirty = !!draft && !!settings && JSON.stringify(draft) !== JSON.stringify(settings);

  if (loading || !draft) {
    return (
      <Box sx={{ p: 3, display: 'flex', justifyContent: 'center' }}>
        <CircularProgress size={32} />
      </Box>
    );
  }

  const highErrorRate = !!diag && diag.recentErrors.length >= 5;
  const testFailed = !!testResult && !testResult.ok;

  return (
    <Stack spacing={3} sx={{ p: { xs: 2, sm: 3 }, maxWidth: 760 }}>
      {!keyPresent ? (
        <Alert severity="warning">
          No <code>GOOGLE_PLACES_API_KEY</code> secret is configured. Address autocomplete and map
          previews stay disabled until a key is added — create one in the{' '}
          <Link href={CLOUD_CONSOLE_CREDENTIALS_URL} target="_blank" rel="noopener noreferrer">
            Google Cloud Console
          </Link>{' '}
          and add it to your Secrets.
        </Alert>
      ) : draft.enabled && (testFailed || highErrorRate) ? (
        <Alert severity="warning">
          Google Maps is reporting errors
          {testFailed ? ' (the latest connection test failed)' : ' from recent client traffic'}.
          Check the API key restrictions and quota in the{' '}
          <Link href={CLOUD_CONSOLE_CREDENTIALS_URL} target="_blank" rel="noopener noreferrer">
            Google Cloud Console
          </Link>
          , then re-run the connection test below.
        </Alert>
      ) : null}

      {/* 1 — Connection & health */}
      <Card variant="outlined">
        <CardContent>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', mb: 1.5 }}>
            <MapIcon color="action" />
            <Typography variant="h6">Connection &amp; health</Typography>
          </Stack>

          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
            {keyPresent ? (
              <>
                <CheckCircleOutlinedIcon color="success" fontSize="small" />
                <Typography variant="body2">
                  API key configured (ending <strong>…{keyLast4}</strong>)
                </Typography>
              </>
            ) : (
              <>
                <ErrorOutlinedIcon color="error" fontSize="small" />
                <Typography variant="body2" color="error.main">
                  No <code>GOOGLE_PLACES_API_KEY</code> secret configured — autocomplete and map
                  previews stay off until a key is added.
                </Typography>
              </>
            )}
          </Stack>

          <Stack direction="row" spacing={2} sx={{ mt: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button
              variant="outlined"
              size="small"
              onClick={handleTest}
              disabled={testing || !keyPresent}
              startIcon={testing ? <CircularProgress size={14} /> : undefined}
            >
              {testing ? 'Testing…' : 'Test connection'}
            </Button>
            <Link
              href={CLOUD_CONSOLE_CREDENTIALS_URL}
              target="_blank"
              rel="noopener noreferrer"
              variant="body2"
            >
              Manage API keys &amp; restrictions →
            </Link>
          </Stack>

          {testResult && (
            <Box sx={{ mt: 2 }}>
              <Alert severity={testResult.ok ? 'success' : 'error'} variant="outlined" sx={{ mb: 1 }}>
                {testResult.ok
                  ? 'All Google APIs responded successfully.'
                  : testResult.error || 'One or more Google APIs failed — see details below.'}
              </Alert>
              <Stack spacing={0.5}>
                {Object.entries(testResult.checks).map(([api, c]) => (
                  <Stack key={api} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    {c.ok ? (
                      <CheckCircleOutlinedIcon color="success" fontSize="small" />
                    ) : (
                      <ErrorOutlinedIcon color="error" fontSize="small" />
                    )}
                    <Typography variant="body2" sx={{ minWidth: 110, textTransform: 'capitalize' }}>
                      {api}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {c.ok
                        ? `${c.latencyMs ?? '?'} ms`
                        : c.error || `status ${c.status ?? 'error'}`}
                    </Typography>
                  </Stack>
                ))}
              </Stack>
            </Box>
          )}
        </CardContent>
      </Card>

      {/* 2 — Master switch */}
      <Card variant="outlined">
        <CardContent>
          <FormControlLabel
            control={
              <Switch
                checked={draft.enabled}
                onChange={(e) => patch((d) => ({ ...d, enabled: e.target.checked }))}
              />
            }
            label={
              <Box>
                <Typography variant="h6">Enable Google Maps features</Typography>
                <Typography variant="body2" color="text.secondary">
                  Master switch. When off, every surface falls back to plain manual address entry
                  and no map previews are shown.
                </Typography>
              </Box>
            }
          />
        </CardContent>
      </Card>

      {/* 3 — Autocomplete behaviour */}
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" gutterBottom>Autocomplete behaviour</Typography>
          <Stack spacing={2.5} sx={{ mt: 1 }}>
            <Autocomplete
              multiple
              size="small"
              options={COUNTRIES.map((c) => c.code)}
              value={draft.autocomplete.countries}
              onChange={(_e, v) =>
                patch((d) => ({
                  ...d,
                  autocomplete: { ...d.autocomplete, countries: v.slice(0, 5) },
                }))
              }
              getOptionLabel={(code) =>
                COUNTRIES.find((c) => c.code === code)?.name || code
              }
              renderValue={(value, getItemProps) =>
                value.map((code, index) => {
                  const { key, ...rest } = getItemProps({ index });
                  return <Chip key={key} {...rest} size="small" label={code} />;
                })
              }
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Country restrictions"
                  helperText="Up to 5 countries. Predictions are limited to these."
                />
              )}
            />

            <TextField
              label="Language"
              size="small"
              value={draft.autocomplete.language}
              onChange={(e) =>
                patch((d) => ({ ...d, autocomplete: { ...d.autocomplete, language: e.target.value } }))
              }
              sx={{ width: 200 }}
              helperText="BCP-47 code, e.g. en-GB"
              slotProps={{ htmlInput: { maxLength: 10 } }}
            />

            <FormControl>
              <FormLabel>Result type</FormLabel>
              <RadioGroup
                row
                value={draft.autocomplete.types}
                onChange={(e) =>
                  patch((d) => ({
                    ...d,
                    autocomplete: { ...d.autocomplete, types: e.target.value as GoogleMapsSettings['autocomplete']['types'] },
                  }))
                }
              >
                <FormControlLabel value="address" control={<Radio size="small" />} label="Addresses" />
                <FormControlLabel value="establishment" control={<Radio size="small" />} label="Businesses" />
                <FormControlLabel value="geocode" control={<Radio size="small" />} label="Geocode (regions)" />
              </RadioGroup>
            </FormControl>

            <Stack direction="row" spacing={2}>
              <TextField
                label="Debounce"
                size="small"
                value={String(draft.autocomplete.debounceMs)}
                onChange={(e) =>
                  patch((d) => ({
                    ...d,
                    autocomplete: { ...d.autocomplete, debounceMs: Number(e.target.value) || 0 },
                  }))
                }
                sx={{ width: 150 }}
                slotProps={{
                  htmlInput: { inputMode: 'numeric' as const },
                  input: { endAdornment: <InputAdornment position="end">ms</InputAdornment> },
                }}
              />
              <TextField
                label="Minimum characters"
                size="small"
                value={String(draft.autocomplete.minChars)}
                onChange={(e) =>
                  patch((d) => ({
                    ...d,
                    autocomplete: { ...d.autocomplete, minChars: Number(e.target.value) || 1 },
                  }))
                }
                sx={{ width: 170 }}
                slotProps={{ htmlInput: { inputMode: 'numeric' as const } }}
              />
            </Stack>

            <FormControlLabel
              control={
                <Switch
                  checked={draft.autocomplete.sessionTokens}
                  onChange={(e) =>
                    patch((d) => ({
                      ...d,
                      autocomplete: { ...d.autocomplete, sessionTokens: e.target.checked },
                    }))
                  }
                />
              }
              label="Use session tokens (recommended — reduces billing)"
            />
          </Stack>
        </CardContent>
      </Card>

      {/* 4 — Per-surface visibility */}
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" gutterBottom>Per-surface visibility</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Choose which forms show the address search box and the map preview.
          </Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Surface</TableCell>
                <TableCell align="center">Autocomplete</TableCell>
                <TableCell align="center">Map preview</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(Object.keys(SURFACE_LABELS) as SurfaceId[]).map((sid) => (
                <TableRow key={sid}>
                  <TableCell>{SURFACE_LABELS[sid]}</TableCell>
                  <TableCell align="center">
                    <Switch
                      size="small"
                      checked={draft.surfaces[sid].autocomplete}
                      onChange={(e) =>
                        patch((d) => ({
                          ...d,
                          surfaces: {
                            ...d.surfaces,
                            [sid]: { ...d.surfaces[sid], autocomplete: e.target.checked },
                          },
                        }))
                      }
                    />
                  </TableCell>
                  <TableCell align="center">
                    <Switch
                      size="small"
                      checked={draft.surfaces[sid].mapPreview}
                      onChange={(e) =>
                        patch((d) => ({
                          ...d,
                          surfaces: {
                            ...d.surfaces,
                            [sid]: { ...d.surfaces[sid], mapPreview: e.target.checked },
                          },
                        }))
                      }
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* 5 — Static map previews */}
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" gutterBottom>Static map previews</Typography>
          <Stack spacing={2.5} sx={{ mt: 1 }}>
            <FormControlLabel
              control={
                <Switch
                  checked={draft.mapPreview.enabled}
                  onChange={(e) =>
                    patch((d) => ({ ...d, mapPreview: { ...d.mapPreview, enabled: e.target.checked } }))
                  }
                />
              }
              label="Show static map thumbnails next to saved addresses"
            />
            <Stack direction="row" spacing={2}>
              <TextField
                label="Zoom"
                size="small"
                value={String(draft.mapPreview.zoom)}
                onChange={(e) =>
                  patch((d) => ({ ...d, mapPreview: { ...d.mapPreview, zoom: Number(e.target.value) || 1 } }))
                }
                sx={{ width: 120 }}
                slotProps={{ htmlInput: { inputMode: 'numeric' as const } }}
                helperText="1–21"
              />
              <FormControl>
                <FormLabel>Map type</FormLabel>
                <RadioGroup
                  row
                  value={draft.mapPreview.mapType}
                  onChange={(e) =>
                    patch((d) => ({
                      ...d,
                      mapPreview: { ...d.mapPreview, mapType: e.target.value as GoogleMapsSettings['mapPreview']['mapType'] },
                    }))
                  }
                >
                  <FormControlLabel value="roadmap" control={<Radio size="small" />} label="Roadmap" />
                  <FormControlLabel value="satellite" control={<Radio size="small" />} label="Satellite" />
                  <FormControlLabel value="hybrid" control={<Radio size="small" />} label="Hybrid" />
                  <FormControlLabel value="terrain" control={<Radio size="small" />} label="Terrain" />
                </RadioGroup>
              </FormControl>
            </Stack>
          </Stack>
        </CardContent>
      </Card>

      {/* 6 — Fallback behaviour */}
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" gutterBottom>Fallback behaviour</Typography>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <FormControl>
              <FormLabel>When autocomplete is unavailable</FormLabel>
              <RadioGroup
                value={draft.fallback.mode}
                onChange={(e) =>
                  patch((d) => ({
                    ...d,
                    fallback: { ...d.fallback, mode: e.target.value as 'silent' | 'notice' },
                  }))
                }
              >
                <FormControlLabel value="silent" control={<Radio size="small" />} label="Silently fall back to manual entry" />
                <FormControlLabel value="notice" control={<Radio size="small" />} label="Show a short notice above the fields" />
              </RadioGroup>
            </FormControl>
            <FormControlLabel
              control={
                <Switch
                  checked={draft.fallback.allowManualEntry}
                  onChange={(e) =>
                    patch((d) => ({ ...d, fallback: { ...d.fallback, allowManualEntry: e.target.checked } }))
                  }
                />
              }
              label="Always allow manual address entry"
            />
          </Stack>
        </CardContent>
      </Card>

      {/* 7 — Usage & diagnostics */}
      <Card variant="outlined">
        <CardContent>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1.5 }}>
            <Typography variant="h6" sx={{ flexGrow: 1 }}>Usage &amp; diagnostics</Typography>
            <Button
              size="small"
              startIcon={diagLoading ? <CircularProgress size={14} /> : <RefreshIcon fontSize="small" />}
              onClick={fetchDiagnostics}
              disabled={diagLoading}
            >
              Refresh
            </Button>
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            Google API request counts — combining server-side connection tests with live
            autocomplete, place-details and map-preview traffic reported by the browser — plus the
            most recent errors.
          </Typography>

          <Table size="small" sx={{ mb: 2 }}>
            <TableHead>
              <TableRow>
                <TableCell>API</TableCell>
                <TableCell align="right">Today</TableCell>
                <TableCell align="right">This month</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {Array.from(
                new Set([...Object.keys(diag?.today || {}), ...Object.keys(diag?.month || {})]),
              ).map((api) => (
                <TableRow key={api}>
                  <TableCell sx={{ textTransform: 'capitalize' }}>{api}</TableCell>
                  <TableCell align="right">{diag?.today?.[api] ?? 0}</TableCell>
                  <TableCell align="right">{diag?.month?.[api] ?? 0}</TableCell>
                </TableRow>
              ))}
              {!diag || (Object.keys(diag.today).length === 0 && Object.keys(diag.month).length === 0) ? (
                <TableRow>
                  <TableCell colSpan={3}>
                    <Typography variant="body2" color="text.secondary">No requests recorded yet.</Typography>
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>

          <Typography variant="subtitle2" gutterBottom>Recent errors</Typography>
          {diag && diag.recentErrors.length > 0 ? (
            <Stack spacing={0.5}>
              {diag.recentErrors.map((err, i) => (
                <Typography key={i} variant="caption" color="text.secondary">
                  <strong>{new Date(err.timestamp).toLocaleString()}</strong> · {err.api}
                  {err.surface ? ` · ${err.surface}` : ''}
                  {err.errorCode ? ` — ${err.errorCode}` : ''}
                  {err.message ? `: ${err.message}` : ''}
                </Typography>
              ))}
            </Stack>
          ) : (
            <Typography variant="body2" color="text.secondary">No recent errors.</Typography>
          )}
        </CardContent>
      </Card>

      <Divider />

      <Stack direction="row" spacing={2} sx={{ justifyContent: 'flex-end' }}>
        <Button variant="contained" onClick={handleSave} disabled={saving || !isDirty}>
          {saving ? 'Saving…' : 'Save settings'}
        </Button>
      </Stack>
    </Stack>
  );
}

export default GoogleMapsPage;
