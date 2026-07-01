import React, { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import CircularProgress from '@mui/material/CircularProgress';
import CloudOffIcon from '@mui/icons-material/CloudOff';
import PersonAddAltIcon from '@mui/icons-material/PersonAddAlt';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { readRecords } from '../lib/offlineDb';
import { filterSortPaginateCachedContacts, type PaginatedContact } from '../hooks/usePaginatedContacts';
import { CONTACT_SEARCH_DEBOUNCE_MS } from '../constants/timings';

/**
 * Result of choosing who a standalone design visit is for.
 *
 * `existing` — an established CRM contact (from the live search when online, or
 * the device's cached customer list when offline). Carries the real HubSpot
 * contact id so the wizard + submission behave exactly as the in-app flow.
 *
 * `new` — a brand-new customer not yet in the CRM. Carries the raw details plus
 * a `clientSubmissionId` minted once here; the server matches-or-creates the
 * HubSpot contact at submit time (all HubSpot I/O stays server-side, so this
 * works offline and syncs later). The id also de-dupes offline replays.
 */
export interface ExistingCustomerSelection {
  mode: 'existing';
  contactId: string;
  contactName: string;
  contactEmail?: string;
  contactPhone?: string;
}

export interface NewCustomerSelection {
  mode: 'new';
  newContact: { name: string; email?: string; phone?: string };
  clientSubmissionId: string;
}

export type SelectedCustomer = ExistingCustomerSelection | NewCustomerSelection;

/** Display/identity name for a cached or fetched contact. */
function contactDisplayName(c: PaginatedContact): string {
  const p = c.properties || {};
  const name = [p.firstname, p.lastname].filter(Boolean).join(' ').trim();
  return name || p.email || p.customer_number || c.id;
}

function contactSecondary(c: PaginatedContact): string {
  const p = c.properties || {};
  return [p.email, p.phone].filter(Boolean).join(' · ');
}

function newClientSubmissionId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch { /* fall through */ }
  // Fallback for environments without crypto.randomUUID (vary by index/time is
  // not available in this scope, so combine two random segments).
  return `dv-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function CustomerSelectStep({ onSelect }: { onSelect: (sel: SelectedCustomer) => void }) {
  const [mode, setMode] = useState<'search' | 'new'>('search');

  // ── Existing-customer search ──────────────────────────────────────────────
  const [inputValue, setInputValue] = useState('');
  const [options, setOptions] = useState<PaginatedContact[]>([]);
  const [loading, setLoading] = useState(false);
  const [fromCache, setFromCache] = useState(false);
  const [open, setOpen] = useState(false);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── New-customer form ─────────────────────────────────────────────────────
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newError, setNewError] = useState('');

  useEffect(() => {
    if (mode !== 'search') return;
    const q = inputValue.trim();
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!q) {
      setOptions([]);
      setLoading(false);
      setFromCache(false);
      return;
    }

    timerRef.current = setTimeout(() => {
      if (abortRef.current) abortRef.current.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);

      void (async () => {
        const online = typeof navigator === 'undefined' || navigator.onLine !== false;
        if (online) {
          try {
            const qs = new URLSearchParams({ q, limit: '8', sort: 'newest' });
            const res = await fetch(`/api/contacts-all?${qs}`, {
              signal: ctrl.signal,
              headers: { Accept: 'application/json' },
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = (await res.json()) as { results?: PaginatedContact[] };
            if (ctrl.signal.aborted) return;
            setOptions(data.results || []);
            setFromCache(false);
            setLoading(false);
            return;
          } catch (e) {
            if ((e as { name?: string }).name === 'AbortError') return;
            // Fall through to the offline cache on any network/server failure.
          }
        }

        // Offline (or the live search failed): search the device's cached
        // customer list written through by the customers list / page warm-up.
        try {
          const cached = await readRecords<PaginatedContact>('customers');
          if (ctrl.signal.aborted) return;
          const { results } = filterSortPaginateCachedContacts(cached, {
            leadStatus: '',
            stage: '',
            sortBy: 'name-asc',
            search: q,
            showArchived: true,
            page: 1,
            limit: 8,
          });
          setOptions(results);
          setFromCache(true);
        } catch {
          setOptions([]);
        } finally {
          if (!ctrl.signal.aborted) setLoading(false);
        }
      })();
    }, CONTACT_SEARCH_DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [inputValue, mode]);

  function submitNewCustomer() {
    const name = newName.trim();
    if (!name) {
      setNewError('Please enter the customer’s name.');
      return;
    }
    onSelect({
      mode: 'new',
      newContact: {
        name,
        email: newEmail.trim() || undefined,
        phone: newPhone.trim() || undefined,
      },
      clientSubmissionId: newClientSubmissionId(),
    });
  }

  if (mode === 'new') {
    return (
      <Box sx={{ pt: 2, px: 1 }}>
        <Typography sx={{ fontSize: '1.05rem', fontWeight: 600, color: 'var(--ink-1)', mb: 0.5 }}>
          New customer
        </Typography>
        <Typography sx={{ fontSize: '.85rem', color: 'var(--neutral-600)', mb: 2 }}>
          We’ll add this customer to the CRM when the visit syncs. Email is recommended —
          it’s where the customer’s sign-off link is sent.
        </Typography>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.75 }}>
          <TextField
            label="Name"
            required
            value={newName}
            onChange={(e) => { setNewError(''); setNewName(e.target.value); }}
            error={!!newError}
            helperText={newError || ' '}
            autoFocus
            fullWidth
            slotProps={{ htmlInput: { maxLength: 200 } }}
          />
          <TextField
            label="Email"
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            fullWidth
            slotProps={{ htmlInput: { maxLength: 200 } }}
          />
          <TextField
            label="Phone"
            value={newPhone}
            onChange={(e) => setNewPhone(e.target.value)}
            fullWidth
            slotProps={{ htmlInput: { maxLength: 60 } }}
          />
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mt: 2.5 }}>
          <Link
            component="button"
            type="button"
            onClick={() => { setNewError(''); setMode('search'); }}
            sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontSize: '.85rem', cursor: 'pointer' }}
          >
            <ArrowBackIcon sx={{ fontSize: 16 }} /> Back to search
          </Link>
          <Button variant="contained" onClick={submitNewCustomer} sx={{ textTransform: 'none', fontWeight: 600 }}>
            Start visit
          </Button>
        </Box>
      </Box>
    );
  }

  return (
    <Box sx={{ pt: 2, px: 1 }}>
      <Typography sx={{ fontSize: '1.05rem', fontWeight: 600, color: 'var(--ink-1)', mb: 0.5 }}>
        Who is this design visit for?
      </Typography>
      <Typography sx={{ fontSize: '.85rem', color: 'var(--neutral-600)', mb: 2 }}>
        Search by name, email or phone, then complete the visit on this device. It syncs
        automatically when you’re back online.
      </Typography>

      <Autocomplete<PaginatedContact, false, false, false>
        open={open && inputValue.trim().length > 0}
        onOpen={() => setOpen(true)}
        onClose={() => setOpen(false)}
        options={options}
        loading={loading}
        filterOptions={(x) => x}
        getOptionLabel={contactDisplayName}
        isOptionEqualToValue={(a, b) => a.id === b.id}
        inputValue={inputValue}
        onInputChange={(_e, v) => setInputValue(v)}
        value={null}
        blurOnSelect
        clearOnBlur={false}
        onChange={(_e, value) => {
          if (!value) return;
          onSelect({
            mode: 'existing',
            contactId: value.id,
            contactName: contactDisplayName(value),
            contactEmail: value.properties?.email,
            contactPhone: value.properties?.phone,
          });
        }}
        noOptionsText={
          inputValue.trim()
            ? (loading ? 'Searching…' : 'No matching customers found')
            : 'Start typing to search'
        }
        renderOption={(props, option) => {
          const secondary = contactSecondary(option);
          const { key: _key, ...liProps } = props as React.HTMLAttributes<HTMLLIElement> & { key?: string };
          return (
            <li {...liProps} key={option.id}>
              <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <Typography sx={{ fontSize: '.9rem', fontWeight: 500, color: 'var(--ink-1)' }}>
                  {contactDisplayName(option)}
                </Typography>
                {secondary && (
                  <Typography sx={{ fontSize: '.78rem', color: 'var(--neutral-600)' }} noWrap>
                    {secondary}
                  </Typography>
                )}
              </Box>
            </li>
          );
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            label="Customer"
            placeholder="Search customers…"
            autoFocus
            slotProps={{
              ...params.slotProps,
              input: {
                ...params.slotProps.input,
                endAdornment: (
                  <>
                    {loading ? <CircularProgress color="inherit" size={18} /> : null}
                    {params.slotProps.input.endAdornment}
                  </>
                ),
              },
            }}
          />
        )}
      />

      {fromCache && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 1.25, color: 'var(--neutral-600)' }}>
          <CloudOffIcon sx={{ fontSize: 16 }} />
          <Typography sx={{ fontSize: '.78rem' }}>
            Offline — showing customers saved on this device.
          </Typography>
        </Box>
      )}

      <Button
        onClick={() => { setNewError(''); setMode('new'); }}
        startIcon={<PersonAddAltIcon />}
        sx={{ mt: 2, textTransform: 'none', fontWeight: 600 }}
      >
        Can’t find them? Add a new customer
      </Button>
    </Box>
  );
}

export default CustomerSelectStep;
