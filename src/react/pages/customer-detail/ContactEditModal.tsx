import React, { useState, useEffect } from 'react';
import { CONTACT_EDIT_DRAFT_PREFIX } from '../../constants/localStorageKeys';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import { Contact } from './types';
import { AddressInput } from '../../components/AddressInput';
import { emptyAddress, type StructuredAddress } from '../../../../shared/address';
import { updateRecentCustomer } from '../../utils/formatters';
import { useDiscardGuard } from '../../hooks/useDiscardGuard';
import { useBeforeUnloadGuard } from '../../hooks/useBeforeUnloadGuard';
import { DiscardConfirmDialog } from '../../components/modals/DiscardConfirmDialog';
import { FullScreenModal } from '../../components/modals/FullScreenModal';
import { broadcastLeadStatusChange } from '../../utils/broadcastLeadStatus';

// ── Types ──────────────────────────────────────────────────────────────────────

type FormValues = {
  firstname: string;
  lastname: string;
  email: string;
  phone: string;
  mobilephone: string;
  structuredAddress: StructuredAddress;
};

type ActivePhoneField = 'phone' | 'mobilephone' | null;

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
    firstname:         p.firstname         || '',
    lastname:          p.lastname          || '',
    email:             p.email             || '',
    phone:             p.phone             || '',
    mobilephone:       p.mobilephone       || '',
    structuredAddress: p.structuredAddress || emptyAddress(),
  };
}

function draftKey(contactId: string): string {
  return CONTACT_EDIT_DRAFT_PREFIX + contactId;
}

function toPersistedDraft(values: FormValues): Omit<FormValues, 'phone' | 'mobilephone'> {
  const { phone: _phone, mobilephone: _mobilephone, ...safeValues } = values;
  return safeValues;
}

function activePhoneField(values: FormValues): ActivePhoneField {
  if (values.phone)       return 'phone';
  if (values.mobilephone) return 'mobilephone';
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

  const savedValues = toFormValues(contact);
  const hasUnsavedChanges = (Object.keys(savedValues) as (keyof FormValues)[]).some(
    (k) => k === 'structuredAddress'
      ? JSON.stringify(values.structuredAddress) !== JSON.stringify(savedValues.structuredAddress)
      : values[k] !== savedValues[k],
  );

  // Only guard while the modal is actually open. Once it closes — whether the
  // user saved or discarded — there is nothing to warn about. Leaving the guard
  // armed after a save lets a background contact re-fetch (which re-normalises
  // the address, e.g. addressLines [] ↔ ['','']) keep `hasUnsavedChanges` true,
  // wrongly triggering the page-exit warning even though the save succeeded.
  const dirty = open && hasUnsavedChanges;

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

  function handleDiscard() {
    try { localStorage.removeItem(draftKey(contact.id)); } catch { /* noop */ }
    onClose();
  }

  const { confirmOpen: confirmDiscardOpen, handleRequestClose, handleKeepEditing } = useDiscardGuard(
    dirty,
    handleDiscard,
    saving,
  );
  useBeforeUnloadGuard(dirty);

  function handleChange(field: 'firstname' | 'lastname' | 'email' | 'phone' | 'mobilephone') {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      setValues(prev => ({ ...prev, [field]: e.target.value }));
    };
  }

  function handleAddressChange(next: StructuredAddress) {
    setValues(prev => ({ ...prev, structuredAddress: next }));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        firstname:         values.firstname,
        lastname:          values.lastname,
        email:             values.email,
        phone:             values.phone,
        mobilephone:       values.mobilephone,
        structuredAddress: values.structuredAddress,
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
      broadcastLeadStatusChange(contact.id, {
        firstname: values.firstname,
        lastname:  values.lastname,
        email:     values.email,
        zip:       values.structuredAddress.postalCode,
      });
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
    <FullScreenModal
      open={open}
      onClose={handleRequestClose}
      disableClose={saving}
      title="Edit contact"
      footer={
        <>
          <Button onClick={handleRequestClose} disabled={saving}>Cancel</Button>
          <Button onClick={() => void handleSave()} variant="contained" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
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

          <AddressInput
            value={values.structuredAddress}
            onChange={handleAddressChange}
            disabled={saving}
            idPrefix="contact-edit-address"
            surface="contactEdit"
            postcodeFirst
          />
        </Stack>
    </FullScreenModal>
    <DiscardConfirmDialog
      open={confirmDiscardOpen}
      onKeepEditing={handleKeepEditing}
      onDiscard={handleDiscard}
    />
    </>
  );
}
