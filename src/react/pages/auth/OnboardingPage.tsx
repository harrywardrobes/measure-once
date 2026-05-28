import React from 'react';
import { BRAND_COLORS } from '../../theme';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import GlobalStyles from '@mui/material/GlobalStyles';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

const LOGO_URL = '/harry-wardrobes-logo.png';
const bodyStyles = { 'html, body': { margin: 0, padding: 0, minHeight: '100vh', background: BRAND_COLORS.pageBackground } };
const DRAFT_KEY = 'mo:onboarding:draft';

interface FormData {
  first_name: string;
  last_name: string;
  date_of_birth: string;
  ni_number: string;
  mobile_number: string;
  ec_first_name: string;
  ec_last_name: string;
  ec_phone: string;
}

const EMPTY: FormData = {
  first_name: '', last_name: '', date_of_birth: '', ni_number: '',
  mobile_number: '', ec_first_name: '', ec_last_name: '', ec_phone: '',
};

function loadDraft(): Partial<FormData> {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}'); } catch { return {}; }
}
function saveDraft(data: FormData) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(data)); } catch {}
}
function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch {}
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <Typography variant="overline" sx={{ display: 'block', mb: 1.25, mt: 2.75, color: 'text.disabled', letterSpacing: '0.04em' }}>
      {children}
    </Typography>
  );
}

export function OnboardingPage() {
  const [form, setForm] = React.useState<FormData>(() => {
    const draft = loadDraft();
    return { ...EMPTY, ...draft };
  });
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    fetch('/api/onboarding/me')
      .then(r => {
        if (r.status === 401) { location.href = '/login'; return null; }
        if (!r.ok) return null;
        return r.json();
      })
      .then(me => {
        if (!me) return;
        if (me.onboarding_status === 'active') { location.href = '/'; return; }
        const m = me.metadata || {};
        const draft = loadDraft();
        setForm(prev => ({
          first_name:    draft.first_name    ?? me.first_name    ?? prev.first_name,
          last_name:     draft.last_name     ?? me.last_name     ?? prev.last_name,
          date_of_birth: draft.date_of_birth ?? m.date_of_birth  ?? prev.date_of_birth,
          ni_number:     draft.ni_number     ?? m.ni_number      ?? prev.ni_number,
          mobile_number: draft.mobile_number ?? m.mobile_number  ?? prev.mobile_number,
          ec_first_name: draft.ec_first_name ?? m.ec_first_name  ?? prev.ec_first_name,
          ec_last_name:  draft.ec_last_name  ?? m.ec_last_name   ?? prev.ec_last_name,
          ec_phone:      draft.ec_phone      ?? m.ec_phone       ?? prev.ec_phone,
        }));
      })
      .catch(() => {});
  }, []);

  function set(key: keyof FormData) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = key === 'ni_number' ? e.target.value.toUpperCase() : e.target.value;
      setForm(prev => {
        const next = { ...prev, [key]: val };
        saveDraft(next);
        return next;
      });
    };
  }

  async function handleSignOut() {
    await fetch('/api/logout', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' } });
    location.href = '/login?signed_out=1';
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body: FormData = {
        first_name:    form.first_name.trim(),
        last_name:     form.last_name.trim(),
        date_of_birth: form.date_of_birth,
        ni_number:     form.ni_number.trim(),
        mobile_number: form.mobile_number.trim(),
        ec_first_name: form.ec_first_name.trim(),
        ec_last_name:  form.ec_last_name.trim(),
        ec_phone:      form.ec_phone.trim(),
      };
      const r = await fetch('/api/onboarding/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) {
        setError(data.error || 'Could not save your profile.');
        return;
      }
      clearDraft();
      location.href = '/';
    } catch {
      setError('Network error — please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', p: 4 }}>
      <GlobalStyles styles={bodyStyles} />
      <Paper
        elevation={0}
        sx={{ width: '100%', maxWidth: 680, p: 4, border: '1px solid', borderColor: 'divider', borderRadius: 3, boxShadow: '0 1px 3px rgba(0,0,0,.04)' }}
      >
        <Box sx={{ textAlign: 'center', mb: 3.5 }}>
          <Box component="img" src={LOGO_URL} alt="Harry Wardrobes" sx={{ maxWidth: 180, width: '100%', height: 'auto' }} />
        </Box>

        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 2.5 }}>
          <Box>
            <Typography variant="h5" sx={{ fontWeight: 700, mb: 0.5, letterSpacing: '-0.01em' }}>
              Complete your profile
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Before you can use Measure Once, please fill in your details below.
            </Typography>
          </Box>
          <Button variant="text" onClick={handleSignOut} sx={{ color: 'text.secondary', textDecoration: 'underline', flexShrink: 0, ml: 2 }}>
            Sign out
          </Button>
        </Box>

        <Box component="form" onSubmit={handleSubmit}>
          <SectionLabel>Personal details</SectionLabel>
          <Grid container spacing={1.75}>
            <Grid size={6}>
              <TextField label="First name" fullWidth required slotProps={{ htmlInput: { maxLength: 100 } }} value={form.first_name} onChange={set('first_name')} />
            </Grid>
            <Grid size={6}>
              <TextField label="Last name" fullWidth required slotProps={{ htmlInput: { maxLength: 100 } }} value={form.last_name} onChange={set('last_name')} />
            </Grid>
            <Grid size={6}>
              <TextField label="Date of birth" type="date" fullWidth required slotProps={{ inputLabel: { shrink: true } }} value={form.date_of_birth} onChange={set('date_of_birth')} />
            </Grid>
            <Grid size={6}>
              <TextField
                label="National Insurance number" fullWidth required
                slotProps={{ htmlInput: { maxLength: 20, style: { textTransform: 'uppercase' } } }}
                value={form.ni_number} onChange={set('ni_number')}
              />
            </Grid>
            <Grid size={6}>
              <TextField label="Mobile number" type="tel" fullWidth required slotProps={{ htmlInput: { maxLength: 30 } }} value={form.mobile_number} onChange={set('mobile_number')} />
            </Grid>
          </Grid>

          <SectionLabel>Emergency contact</SectionLabel>
          <Grid container spacing={1.75}>
            <Grid size={6}>
              <TextField label="First name" fullWidth required slotProps={{ htmlInput: { maxLength: 100 } }} value={form.ec_first_name} onChange={set('ec_first_name')} />
            </Grid>
            <Grid size={6}>
              <TextField label="Last name" fullWidth required slotProps={{ htmlInput: { maxLength: 100 } }} value={form.ec_last_name} onChange={set('ec_last_name')} />
            </Grid>
            <Grid size={12}>
              <TextField label="Mobile number" type="tel" fullWidth required slotProps={{ htmlInput: { maxLength: 30 } }} value={form.ec_phone} onChange={set('ec_phone')} />
            </Grid>
          </Grid>

          {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}

          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mt: 3, pt: 2.5, borderTop: '1px solid', borderColor: 'divider' }}>
            <Typography variant="caption" color="text.secondary">All fields are required.</Typography>
            <Button id="submit-btn" type="submit" variant="contained" disabled={busy} sx={{ minHeight: 40 }}>
              {busy ? 'Saving…' : 'Save & continue'}
            </Button>
          </Box>
        </Box>
      </Paper>
    </Box>
  );
}

export default OnboardingPage;
