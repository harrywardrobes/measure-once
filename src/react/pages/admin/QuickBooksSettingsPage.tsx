import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
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
  IconButton,
  InputAdornment,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import ErrorOutlinedIcon from '@mui/icons-material/ErrorOutlined';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import { GET, PUT } from '../../utils/api';
import { usePageTitle } from '../../hooks/usePageTitle';

interface QbStatus {
  connected: boolean;
  company?: string;
  environment?: 'sandbox' | 'production';
  code?: string;
}

interface QbSettings {
  copyMeEmail: string;
  copyMeMode: 'cc' | 'bcc';
  depositPercent: number;
  paymentStages: PaymentStage[];
}

interface PaymentStage {
  label: string;
  percent: number;
}

const W = window as unknown as Record<string, unknown>;

function showToast(msg: string, err?: boolean) {
  if (typeof W.toast === 'function') (W.toast as (m: string, e?: boolean) => void)(msg, err);
}

function isValidEmail(v: string) {
  return v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

export function QuickBooksSettingsPage() {
  usePageTitle('QuickBooks Settings · Measure Once');

  const [status,   setStatus]   = useState<QbStatus | null>(null);
  const [settings, setSettings] = useState<QbSettings | null>(null);
  const [loading,  setLoading]  = useState(true);

  const [copyMeEmail,    setCopyMeEmail]    = useState('');
  const [copyMeMode,     setCopyMeMode]     = useState<'cc' | 'bcc'>('bcc');
  const [depositPercent, setDepositPercent] = useState('10');
  const [paymentStages,  setPaymentStages]  = useState<PaymentStage[]>([]);

  const [saving, setSaving] = useState(false);

  const emailError = !isValidEmail(copyMeEmail)
    ? 'Enter a valid email address, or leave blank to disable.'
    : '';

  const depositError = (() => {
    if (depositPercent === '') return '';
    const n = Number(depositPercent);
    if (isNaN(n) || n < 0 || n > 100) return 'Enter a percentage between 0 and 100.';
    return '';
  })();

  const stageErrors: string[] = paymentStages.map(s => {
    if (!s.label.trim()) return 'Label is required.';
    const n = Number(s.percent);
    if (isNaN(n) || n < 0 || n > 100) return 'Percentage must be 0–100.';
    return '';
  });
  const hasStageErrors = stageErrors.some(Boolean);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [st, sg] = await Promise.all([
        GET<QbStatus>('/api/quickbooks/status'),
        GET<QbSettings>('/api/admin/qb-settings'),
      ]);
      setStatus(st);
      setSettings(sg);
      setCopyMeEmail(sg.copyMeEmail ?? '');
      setCopyMeMode(sg.copyMeMode === 'cc' ? 'cc' : 'bcc');
      setDepositPercent(String(sg.depositPercent ?? 10));
      setPaymentStages(Array.isArray(sg.paymentStages) ? sg.paymentStages : []);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const handleSave = useCallback(async () => {
    if (emailError || depositError || hasStageErrors) return;
    setSaving(true);
    try {
      const updated = await PUT<QbSettings>('/api/admin/qb-settings', {
        copyMeEmail,
        copyMeMode,
        depositPercent: depositPercent === '' ? 0 : Number(depositPercent),
        paymentStages,
      });
      setSettings(updated);
      showToast('QuickBooks settings saved.');
    } catch (e) {
      showToast((e as Error).message || 'Failed to save settings.', true);
    } finally {
      setSaving(false);
    }
  }, [copyMeEmail, copyMeMode, depositPercent, paymentStages, emailError, depositError, hasStageErrors]);

  const addStage = useCallback(() => {
    setPaymentStages(prev => [...prev, { label: '', percent: 0 }]);
  }, []);

  const removeStage = useCallback((idx: number) => {
    setPaymentStages(prev => prev.filter((_, i) => i !== idx));
  }, []);

  const updateStageLabel = useCallback((idx: number, label: string) => {
    setPaymentStages(prev => prev.map((s, i) => i === idx ? { ...s, label } : s));
  }, []);

  const updateStagePercent = useCallback((idx: number, percent: string) => {
    setPaymentStages(prev => prev.map((s, i) => i === idx ? { ...s, percent: Number(percent) } : s));
  }, []);

  const isDirty = settings !== null && (
    copyMeEmail    !== (settings.copyMeEmail ?? '') ||
    copyMeMode     !== (settings.copyMeMode === 'cc' ? 'cc' : 'bcc') ||
    depositPercent !== String(settings.depositPercent ?? 10) ||
    JSON.stringify(paymentStages) !== JSON.stringify(settings.paymentStages)
  );

  if (loading) {
    return (
      <Box sx={{ p: 3, display: 'flex', justifyContent: 'center' }}>
        <CircularProgress size={32} />
      </Box>
    );
  }

  return (
    <Stack spacing={3} sx={{ p: { xs: 2, sm: 3 }, maxWidth: 720 }}>

      {/* Connection info — read-only */}
      <Card variant="outlined">
        <CardContent>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', mb: 1.5 }}>
            <ReceiptLongIcon color="action" />
            <Typography variant="h6">Connection</Typography>
          </Stack>

          {status?.connected ? (
            <Stack spacing={1}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <CheckCircleOutlinedIcon color="success" fontSize="small" />
                <Typography variant="body2">
                  Connected to <strong>{status.company}</strong>
                </Typography>
                {status.environment && (
                  <Chip
                    label={status.environment}
                    size="small"
                    color={status.environment === 'sandbox' ? 'warning' : 'success'}
                    variant="outlined"
                  />
                )}
              </Stack>
              <Typography variant="body2" color="text.secondary">
                To reconnect or disconnect, use the <strong>Connect to QuickBooks</strong>{' '}
                button on the <em>Invoices</em> page.
              </Typography>
            </Stack>
          ) : status?.code === 'KEY_MISSING' ? (
            <Stack spacing={1.5}>
              <Alert severity="error">
                QuickBooks cannot connect — the <strong>QB_TOKEN_ENCRYPTION_KEY</strong>{' '}
                secret is not configured. Add it in Replit Secrets, then reconnect via
                the <em>Invoices</em> page.
              </Alert>
            </Stack>
          ) : status?.code === 'TOKEN_UNREADABLE' ? (
            <Stack spacing={1.5}>
              <Alert severity="warning">
                QuickBooks is disconnected — the encryption key used to store your tokens
                may be missing or has been rotated. Reconnect via the <em>Invoices</em> page
                to restore invoice access.
              </Alert>
            </Stack>
          ) : (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <ErrorOutlinedIcon color="error" fontSize="small" />
              <Typography variant="body2" color="error.main">
                Not connected. Visit the <em>Invoices</em> page to connect to QuickBooks.
              </Typography>
            </Stack>
          )}
        </CardContent>
      </Card>

      {/* Email CC / BCC settings */}
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" gutterBottom>Copy-me on emails</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            When QuickBooks sends an invoice or estimate email, this address will automatically
            be added as a CC or BCC recipient on every send.
          </Typography>

          <Stack spacing={2.5}>
            <TextField
              label="Copy-me email address"
              value={copyMeEmail}
              onChange={e => setCopyMeEmail(e.target.value)}
              error={!!emailError}
              helperText={emailError || 'Leave blank to disable copy-me.'}
              size="small"
              fullWidth
              slotProps={{ htmlInput: { maxLength: 254 } }}
            />

            <FormControl>
              <FormLabel>Mode</FormLabel>
              <RadioGroup
                row
                value={copyMeMode}
                onChange={e => setCopyMeMode(e.target.value as 'cc' | 'bcc')}
              >
                <FormControlLabel value="bcc" control={<Radio size="small" />} label="BCC (hidden)" />
                <FormControlLabel value="cc"  control={<Radio size="small" />} label="CC (visible to recipient)" />
              </RadioGroup>
            </FormControl>
          </Stack>
        </CardContent>
      </Card>

      {/* Deposit percentage */}
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" gutterBottom>Deposit</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Default deposit percentage used when creating a deposit invoice for an accepted deal.
          </Typography>

          <TextField
            label="Deposit percentage"
            value={depositPercent}
            onChange={e => setDepositPercent(e.target.value)}
            error={!!depositError}
            helperText={depositError || 'e.g. 10 for a 10% deposit invoice'}
            size="small"
            sx={{ width: 200 }}
            slotProps={{
              htmlInput: { inputMode: 'numeric' as const, pattern: '[0-9]*' },
              input: { endAdornment: <InputAdornment position="end">%</InputAdornment> },
            }}
          />
        </CardContent>
      </Card>

      {/* Payment stages */}
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" gutterBottom>Payment stages</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Optional list of named payment stages shown when creating staged invoices (e.g.
            50% on order, 50% on delivery). Each stage has a label and a percentage of the
            total order value.
          </Typography>

          <Stack spacing={1.5}>
            {paymentStages.length === 0 && (
              <Alert severity="info" variant="outlined" sx={{ fontSize: '0.82rem' }}>
                No payment stages configured. Click <strong>Add stage</strong> to add one.
              </Alert>
            )}

            {paymentStages.map((stage, idx) => (
              <Stack key={idx} direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
                <TextField
                  label="Label"
                  value={stage.label}
                  onChange={e => updateStageLabel(idx, e.target.value)}
                  error={!!stageErrors[idx] && !stage.label.trim()}
                  helperText={!stage.label.trim() ? stageErrors[idx] : ''}
                  size="small"
                  sx={{ flex: 1 }}
                  slotProps={{ htmlInput: { maxLength: 80 } }}
                />
                <TextField
                  label="Percentage"
                  value={stage.percent === 0 ? '' : String(stage.percent)}
                  onChange={e => updateStagePercent(idx, e.target.value)}
                  error={!!stageErrors[idx] && !!stage.label.trim()}
                  helperText={stage.label.trim() && stageErrors[idx] ? stageErrors[idx] : ''}
                  size="small"
                  sx={{ width: 130 }}
                  slotProps={{
                    htmlInput: { inputMode: 'numeric' as const },
                    input: { endAdornment: <InputAdornment position="end">%</InputAdornment> },
                  }}
                />
                <Tooltip title="Remove stage">
                  <IconButton
                    size="small"
                    onClick={() => removeStage(idx)}
                    sx={{ mt: 0.5 }}
                    aria-label="Remove payment stage"
                  >
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
            ))}

            <Box>
              <Button
                size="small"
                startIcon={<AddIcon />}
                onClick={addStage}
                variant="outlined"
              >
                Add stage
              </Button>
            </Box>
          </Stack>
        </CardContent>
      </Card>

      <Divider />

      <Stack direction="row" spacing={2} sx={{ justifyContent: 'flex-end' }}>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={saving || !isDirty || !!emailError || !!depositError || hasStageErrors}
        >
          {saving ? 'Saving…' : 'Save settings'}
        </Button>
      </Stack>
    </Stack>
  );
}
