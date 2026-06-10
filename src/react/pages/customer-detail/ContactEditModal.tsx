import React, { useState, useEffect } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import Typography from '@mui/material/Typography';
import { Contact } from './types';
import { updateRecentCustomer } from '../../utils/formatters';

// ── Types ──────────────────────────────────────────────────────────────────────

type FormValues = {
  firstname: string;
  lastname: string;
  email: string;
  phone: string;
  mobilephone: string;
  hs_whatsapp_phone_number: string;
  address: string;
  city: string;
  zip: string;
};

type ActivePhoneField = 'phone' | 'mobilephone' | 'hs_whatsapp_phone_number' | null;

export interface ContactEditModalProps {
  contact: Contact;
  open: boolean;
  onClose: () => void;
  onSaved: (updated: Contact) => void;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function toFormValues(contact: Contact): FormValues {
  const p = contact.properties;
  return {
    firstname:               p.firstname               || '',
    lastname:                p.lastname                || '',
    email:                   p.email                   || '',
    phone:                   p.phone                   || '',
    mobilephone:             p.mobilephone             || '',
    hs_whatsapp_phone_number: p.hs_whatsapp_phone_number || '',
    address:                 p.address                 || '',
    city:                    p.city                    || '',
    zip:                     p.zip                     || '',
  };
}

function draftKey(contactId: string): string {
  return `mo-contact-edit-${contactId}`;
}

function toPersistedDraft(values: FormValues): Omit<FormValues, 'phone' | 'mobilephone' | 'hs_whatsapp_phone_number'> {
  const { phone, mobilephone, hs_whatsapp_phone_number, ...safeValues } = values;
  return safeValues;
}

function activePhoneField(values: FormValues): ActivePhoneField {
  if (values.phone)                   return 'phone';
  if (values.mobilephone)             return 'mobilephone';
  if (values.hs_whatsapp_phone_number) return 'hs_whatsapp_phone_number';
  return null;
}

// Small badge shown next to the phone field that is currently used in the header.
function HeaderBadge() {
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: '0.68rem',
        fontWeight: 600,
        lineHeight: 1,
        padding: '2px 7px',
        borderRadius: 4,
        background: 'var(--orchid-tint)',
        color: 'var(--orchid)',
        letterSpacing: '0.01em',
        verticalAlign: 'middle',
      }}
    >
      Shown in header
    </span>
  );
}

// ── Component ──────────────────────────────────────────────────────────────────

export function ContactEditModal({ contact, open, onClose, onSaved }: ContactEditModalProps) {
  const [values,  setValues]  = useState<FormValues>(() => toFormValues(contact));
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);

  const savedValues = toFormValues(contact);
  const hasUnsavedChanges = (Object.keys(savedValues) as (keyof FormValues)[]).some(
    (k) => values[k] !== savedValues[k],
  );

  // Restore draft or reset to contact values each time the modal opens.
  useEffect(() => {
    if (!open) return;
    setError(null);
    const baseValues = toFormValues(contact);
    try {
      const raw = localStorage.getItem(draftKey(contact.id));
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<FormValues>;
        setValues({ ...baseValues, ...parsed });
        return;
      }
    } catch { /* noop — fall through to fresh values */ }
    setValues(baseValues);
  }, [open, contact]);

  // Persist draft whenever form values change while the modal is open.
  useEffect(() => {
    if (!open) return;
    try {
      localStorage.setItem(draftKey(contact.id), JSON.stringify(toPersistedDraft(values)));
    } catch { /* noop */ }
  }, [values, open, contact.id]);

  function handleRequestClose() {
    if (saving) return;
    if (hasUnsavedChanges) {
      setConfirmDiscardOpen(true);
    } else {
      onClose();
    }
  }

  function handleDiscard() {
    try { localStorage.removeItem(draftKey(contact.id)); } catch { /* noop */ }
    setConfirmDiscardOpen(false);
    onClose();
  }

  function handleChange(field: keyof FormValues) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      setValues(prev => ({ ...prev, [field]: e.target.value }));
    };
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, string> = {
        firstname:               values.firstname,
        lastname:                values.lastname,
        email:                   values.email,
        phone:                   values.phone,
        mobilephone:             values.mobilephone,
        hs_whatsapp_phone_number: values.hs_whatsapp_phone_number,
        address:                 values.address,
        city:                    values.city,
        zip:                     values.zip,
      };
      const res = await fetch(`/api/contacts/${encodeURIComponent(contact.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      try { localStorage.removeItem(draftKey(contact.id)); } catch { /* noop */ }
      const updated: Contact = {
        ...contact,
        properties: { ...contact.properties, ...values },
      };
      updateRecentCustomer(updated);
      // Notify other tabs so they can patch the contact name without a full reload.
      try {
        if (typeof BroadcastChannel !== 'undefined') {
          const ch = new BroadcastChannel('contact_properties_changed');
          ch.postMessage({
            contactId: contact.id,
            props: {
              firstname: values.firstname,
              lastname:  values.lastname,
              email:     values.email,
              zip:       values.zip,
            },
          });
          ch.close();
        }
      } catch { /* BroadcastChannel not available */ }
      onSaved(updated);
      onClose();
    } catch (e) {
      setError((e as Error).message || 'Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  const activePh = activePhoneField(values);

  return (
    <>
    <Dialog open={open} onClose={handleRequestClose} fullWidth maxWidth="sm">
      <DialogTitle>Edit contact</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}

          <Stack direction="row" spacing={2}>
            <TextField
              label="First name"
              value={values.firstname}
              onChange={handleChange('firstname')}
              fullWidth
              size="small"
              autoComplete="off"
            />
            <TextField
              label="Last name"
              value={values.lastname}
              onChange={handleChange('lastname')}
              fullWidth
              size="small"
              autoComplete="off"
            />
          </Stack>

          <TextField
            label="Email"
            type="email"
            value={values.email}
            onChange={handleChange('email')}
            fullWidth
            size="small"
            autoComplete="off"
          />

          <TextField
            label="Direct phone"
            type="tel"
            value={values.phone}
            onChange={handleChange('phone')}
            fullWidth
            size="small"
            autoComplete="off"
            helperText={activePh === 'phone' ? <HeaderBadge /> : undefined}
          />

          <TextField
            label="Mobile phone"
            type="tel"
            value={values.mobilephone}
            onChange={handleChange('mobilephone')}
            fullWidth
            size="small"
            autoComplete="off"
            helperText={activePh === 'mobilephone' ? <HeaderBadge /> : undefined}
          />

          <TextField
            label="WhatsApp number"
            type="tel"
            value={values.hs_whatsapp_phone_number}
            onChange={handleChange('hs_whatsapp_phone_number')}
            fullWidth
            size="small"
            autoComplete="off"
            helperText={activePh === 'hs_whatsapp_phone_number' ? <HeaderBadge /> : undefined}
          />

          <TextField
            label="Address"
            value={values.address}
            onChange={handleChange('address')}
            fullWidth
            size="small"
            autoComplete="off"
          />

          <Stack direction="row" spacing={2}>
            <TextField
              label="City"
              value={values.city}
              onChange={handleChange('city')}
              fullWidth
              size="small"
              autoComplete="off"
            />
            <TextField
              label="Postcode"
              value={values.zip}
              onChange={handleChange('zip')}
              fullWidth
              size="small"
              autoComplete="off"
            />
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleRequestClose} disabled={saving}>Cancel</Button>
        <Button onClick={() => void handleSave()} variant="contained" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
    <Dialog open={confirmDiscardOpen} onClose={() => setConfirmDiscardOpen(false)} maxWidth="xs" fullWidth>
      <DialogTitle>Discard changes?</DialogTitle>
      <DialogContent>
        <Typography variant="body2">You have unsaved changes — are you sure you want to discard them?</Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setConfirmDiscardOpen(false)}>Keep editing</Button>
        <Button color="error" onClick={handleDiscard}>Discard changes</Button>
      </DialogActions>
    </Dialog>
    </>
  );
}
