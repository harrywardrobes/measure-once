import React, { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import CloudOffIcon from '@mui/icons-material/CloudOff';
import { readRecords } from '../lib/offlineDb';
import {
  filterSortPaginateCachedContacts,
  type PaginatedContact,
} from '../hooks/usePaginatedContacts';
import { CONTACT_SEARCH_DEBOUNCE_MS } from '../constants/timings';

function contactDisplayName(c: PaginatedContact): string {
  const p = c.properties || {};
  const name = [p.firstname, p.lastname].filter(Boolean).join(' ').trim();
  return name || p.email || p.customer_number || c.id;
}

function contactSecondary(c: PaginatedContact): string {
  const p = c.properties || {};
  return [p.email, p.phone].filter(Boolean).join(' · ');
}

/**
 * Existing-customer search picker. Online → `/api/contacts-all`; offline (or on
 * failure) → the device's cached customer list. Calls `onPick` with the chosen
 * contact's id + display name (or null when cleared). Shared by the "Add photos"
 * and "Photo inbox → assign" flows.
 */
export function ContactSearchPicker({
  onPick,
  label = 'Customer',
  autoFocus = true,
}: {
  onPick: (sel: { id: string; name: string } | null) => void;
  label?: string;
  autoFocus?: boolean;
}) {
  const [inputValue, setInputValue] = useState('');
  const [options, setOptions] = useState<PaginatedContact[]>([]);
  const [loading, setLoading] = useState(false);
  const [fromCache, setFromCache] = useState(false);
  const [open, setOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
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
            // fall through to offline cache on any failure
          }
        }
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
  }, [inputValue]);

  return (
    <Box>
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
        onChange={(_e, value) =>
          onPick(value ? { id: value.id, name: contactDisplayName(value) } : null)
        }
        noOptionsText={
          inputValue.trim()
            ? loading
              ? 'Searching…'
              : 'No matching customers found'
            : 'Start typing to search'
        }
        renderOption={(props, option) => {
          const secondary = contactSecondary(option);
          const { key: _key, ...liProps } = props as React.HTMLAttributes<HTMLLIElement> & { key?: string };
          return (
            <li {...liProps} key={option.id}>
              <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <Typography sx={{ fontSize: '.9rem', fontWeight: 500 }}>
                  {contactDisplayName(option)}
                </Typography>
                {secondary && (
                  <Typography sx={{ fontSize: '.78rem', color: 'text.secondary' }} noWrap>
                    {secondary}
                  </Typography>
                )}
              </Box>
            </li>
          );
        }}
        renderInput={(params) => {
          const inputProps =
            (params as unknown as { InputProps: Record<string, unknown> }).InputProps || {};
          return (
            <TextField
              {...params}
              label={label}
              placeholder="Search customers…"
              autoFocus={autoFocus}
              size="small"
              slotProps={{
                input: {
                  ...inputProps,
                  endAdornment: (
                    <>
                      {loading ? <CircularProgress color="inherit" size={18} /> : null}
                      {inputProps.endAdornment as React.ReactNode}
                    </>
                  ),
                },
              }}
            />
          );
        }}
      />
      {fromCache && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 1, color: 'text.secondary' }}>
          <CloudOffIcon sx={{ fontSize: 16 }} />
          <Typography sx={{ fontSize: '.78rem' }}>
            Offline — showing customers saved on this device.
          </Typography>
        </Box>
      )}
    </Box>
  );
}

export default ContactSearchPicker;
