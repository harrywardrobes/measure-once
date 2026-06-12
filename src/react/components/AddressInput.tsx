import React, { useCallback } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControl from '@mui/material/FormControl';
import IconButton from '@mui/material/IconButton';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import TextField from '@mui/material/TextField';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import {
  COUNTRIES,
  HOME_COUNTRY_CODE,
  MAX_ADDRESS_LINES,
  emptyAddress,
  type StructuredAddress,
} from '../../../shared/address';

/**
 * Per-country labels for the locality / administrative-area / postal fields.
 * Falls back to the generic set for any country not explicitly listed so the
 * form always shows sensible wording.
 */
interface AddressLabels {
  locality: string;
  administrativeArea: string;
  postalCode: string;
}

const LABELS_BY_COUNTRY: Record<string, AddressLabels> = {
  GB: { locality: 'Town / City', administrativeArea: 'County', postalCode: 'Postcode' },
  US: { locality: 'City', administrativeArea: 'State', postalCode: 'ZIP code' },
};

const DEFAULT_LABELS: AddressLabels = {
  locality: 'City',
  administrativeArea: 'State / Province / Region',
  postalCode: 'Postal code',
};

function labelsFor(countryCode: string): AddressLabels {
  return LABELS_BY_COUNTRY[(countryCode || '').toUpperCase()] || DEFAULT_LABELS;
}

export interface AddressInputProps {
  /** The controlled structured-address value. */
  value: StructuredAddress;
  /** Called with the next value on every edit. */
  onChange: (next: StructuredAddress) => void;
  /** When true, the first address line, locality and postcode show as required. */
  required?: boolean;
  /** Disable every field (e.g. while submitting). */
  disabled?: boolean;
  /** Optional id prefix so multiple inputs on a page keep unique labels. */
  idPrefix?: string;
}

/**
 * Structured address entry: 1–5 dynamic street lines, locality, administrative
 * area, postal code and a country selector (defaults to GB). Field labels adapt
 * to the selected country. Fully controlled — the parent owns the value.
 */
export function AddressInput({
  value,
  onChange,
  required = false,
  disabled = false,
  idPrefix = 'address',
}: AddressInputProps) {
  // Normalise the incoming value so there is always at least one line to edit.
  const addr: StructuredAddress = {
    addressLines: value?.addressLines?.length ? value.addressLines : [''],
    locality: value?.locality ?? '',
    administrativeArea: value?.administrativeArea ?? '',
    postalCode: value?.postalCode ?? '',
    countryCode: value?.countryCode || HOME_COUNTRY_CODE,
  };
  const labels = labelsFor(addr.countryCode);

  const emit = useCallback(
    (patch: Partial<StructuredAddress>) => {
      onChange({ ...addr, ...patch });
    },
    [addr, onChange],
  );

  const updateLine = useCallback(
    (index: number, text: string) => {
      const lines = [...addr.addressLines];
      lines[index] = text;
      emit({ addressLines: lines });
    },
    [addr.addressLines, emit],
  );

  const addLine = useCallback(() => {
    if (addr.addressLines.length >= MAX_ADDRESS_LINES) return;
    emit({ addressLines: [...addr.addressLines, ''] });
  }, [addr.addressLines, emit]);

  const removeLine = useCallback(
    (index: number) => {
      const lines = addr.addressLines.filter((_, i) => i !== index);
      emit({ addressLines: lines.length ? lines : [''] });
    },
    [addr.addressLines, emit],
  );

  return (
    <Box>
      {addr.addressLines.map((line, i) => (
        <Box key={i} sx={{ display: 'flex', alignItems: 'flex-start', gap: '6px', mb: 1 }}>
          <TextField
            label={i === 0 ? 'Address line 1' : `Address line ${i + 1}`}
            size="small"
            fullWidth
            required={required && i === 0}
            disabled={disabled}
            placeholder={i === 0 ? 'e.g. 12 Baker Street' : undefined}
            slotProps={{ htmlInput: { maxLength: 200 } }}
            value={line}
            onChange={e => updateLine(i, e.target.value)}
          />
          {addr.addressLines.length > 1 && (
            <IconButton
              aria-label={`Remove address line ${i + 1}`}
              size="small"
              disabled={disabled}
              onClick={() => removeLine(i)}
              sx={{ mt: '4px' }}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          )}
        </Box>
      ))}

      {addr.addressLines.length < MAX_ADDRESS_LINES && (
        <Button
          size="small"
          startIcon={<AddIcon />}
          onClick={addLine}
          disabled={disabled}
          sx={{ mb: 1.5, textTransform: 'none' }}
        >
          Add address line
        </Button>
      )}

      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', mb: 1 }}>
        <TextField
          label={labels.locality}
          size="small"
          fullWidth
          required={required}
          disabled={disabled}
          slotProps={{ htmlInput: { maxLength: 120 } }}
          value={addr.locality}
          onChange={e => emit({ locality: e.target.value })}
        />
        <TextField
          label={labels.administrativeArea}
          size="small"
          fullWidth
          disabled={disabled}
          slotProps={{ htmlInput: { maxLength: 120 } }}
          value={addr.administrativeArea}
          onChange={e => emit({ administrativeArea: e.target.value })}
        />
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <TextField
          label={labels.postalCode}
          size="small"
          fullWidth
          required={required}
          disabled={disabled}
          slotProps={{ htmlInput: { maxLength: 32 } }}
          value={addr.postalCode}
          onChange={e => emit({ postalCode: e.target.value })}
        />
        <FormControl fullWidth size="small" disabled={disabled}>
          <InputLabel id={`${idPrefix}-country-label`}>Country</InputLabel>
          <Select
            labelId={`${idPrefix}-country-label`}
            label="Country"
            value={addr.countryCode}
            onChange={e => emit({ countryCode: String(e.target.value) })}
          >
            {COUNTRIES.map(c => (
              <MenuItem key={c.code} value={c.code}>{c.name}</MenuItem>
            ))}
          </Select>
        </FormControl>
      </Box>
    </Box>
  );
}

export { emptyAddress };
export default AddressInput;
