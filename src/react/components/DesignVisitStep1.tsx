import React, { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DateTimePicker } from '@mui/x-date-pickers/DateTimePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { AddressInput } from './AddressInput';
import { CatalogueDropdowns, type CatalogueSuggestion } from './CatalogueDropdowns';
import type { StructuredAddress } from '../../../shared/address';

export interface Step1Data {
  visitDate: string;
  duration: string;
  structuredAddress: StructuredAddress;
  designerName: string;
  handleId: string;
  furnitureRangeId: string;
  termsAccepted: boolean;
}

export interface CatalogueItem {
  id: string | number;
  name: string;
}

export interface DesignVisitStep1Props {
  initialData: Step1Data;
  handles: CatalogueItem[];
  furnitureRanges: CatalogueItem[];
  termsText: string;
  termsVersionNumber?: number | null;
  onDataChange: (data: Step1Data) => void;
  /** Label for the name field. Defaults to 'Designer name'. */
  nameLabel?: string;
  /** Placeholder for the name field. Defaults to 'e.g. Sarah Jones'. */
  namePlaceholder?: string;
  /** idPrefix for the AddressInput. Defaults to 'dv-step1-address'. */
  addressIdPrefix?: string;
  /** Google Maps autocomplete surface for the address. Defaults to 'designVisit'. */
  addressSurface?: React.ComponentProps<typeof AddressInput>['surface'];
  /**
   * Optional pairing suggestion for the Handle dropdown (sourced from
   * catalog_pairings). When supplied and it differs from the current handle a
   * "Suggested: …" hint with an Apply action is shown. Defaults to none, so
   * the Design Visit wizard is unaffected.
   */
  handleSuggestion?: CatalogueSuggestion | null;
}

/** Parse a stored visitDate string to a Dayjs value, or null if empty/invalid. */
function parseVisitDate(s: string): Dayjs | null {
  if (!s) return null;
  const d = dayjs(s);
  return d.isValid() ? d : null;
}

/** Serialise a Dayjs value back to the YYYY-MM-DDTHH:mm string used for
 *  storage and API submission.  Returns '' when value is null or invalid
 *  (e.g. mid-way through manual keyboard entry). */
function formatVisitDate(v: Dayjs | null): string {
  return v && v.isValid() ? v.format('YYYY-MM-DDTHH:mm') : '';
}

export function DesignVisitStep1({
  initialData,
  handles,
  furnitureRanges,
  termsText,
  onDataChange,
  nameLabel = 'Designer name',
  namePlaceholder = 'e.g. Sarah Jones',
  addressIdPrefix = 'dv-step1-address',
  addressSurface = 'designVisit',
  handleSuggestion = null,
}: DesignVisitStep1Props) {
  const [data, setData] = useState<Step1Data>(() => ({ ...initialData }));

  const onDataChangeRef = useRef(onDataChange);
  useEffect(() => { onDataChangeRef.current = onDataChange; }, [onDataChange]);

  // Sync parent with the initialized state (which may include restored draft
  // values) so the wizard's source-of-truth is correct even if the user
  // clicks Next without touching any field.
  useEffect(() => {
    onDataChangeRef.current(data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = useCallback((patch: Partial<Step1Data>) => {
    setData(prev => {
      const next = { ...prev, ...patch };
      onDataChangeRef.current(next);
      return next;
    });
  }, []);

  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <Box>
        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', mb: 1.5 }}>
          <DateTimePicker
            label="Visit date & time"
            value={parseVisitDate(data.visitDate)}
            onChange={(v: Dayjs | null) => update({ visitDate: formatVisitDate(v) })}
            slotProps={{
              textField: {
                size: 'small',
                fullWidth: true,
              },
            }}
          />
          <TextField
            label="Duration (minutes)"
            type="number"
            size="small"
            fullWidth
            slotProps={{ htmlInput: { min: 15, max: 1440, step: 15 } }}
            value={data.duration}
            onChange={e => update({ duration: e.target.value })}
          />
        </Box>

        <Box sx={{ mb: 1.5 }}>
          <AddressInput
            value={data.structuredAddress}
            onChange={(next) => update({ structuredAddress: next })}
            idPrefix={addressIdPrefix}
            surface={addressSurface}
          />
        </Box>

        <TextField
          label={nameLabel}
          size="small"
          fullWidth
          placeholder={namePlaceholder}
          slotProps={{ htmlInput: { maxLength: 200 } }}
          value={data.designerName}
          onChange={e => update({ designerName: e.target.value })}
          sx={{ mb: 1.5 }}
        />

        <CatalogueDropdowns
          dropdowns={[
            {
              label: 'Handle selection',
              value: data.handleId,
              options: handles,
              onChange: (v) => update({ handleId: v }),
              noneLabel: '— select handle —',
              suggestion: handleSuggestion,
            },
            {
              label: 'Furniture range',
              value: data.furnitureRangeId,
              options: furnitureRanges,
              onChange: (v) => update({ furnitureRangeId: v }),
              noneLabel: '— select range —',
            },
          ]}
        />

        {termsText && (
          <>
            <Typography
              variant="caption"
              sx={{ fontWeight: 600, color: 'var(--neutral-600)', display: 'block', mb: '4px', mt: '12px' }}
            >
              Terms &amp; Conditions
            </Typography>
            <Box
              sx={{
                background: 'var(--neutral-50)',
                border: '1px solid var(--neutral-200)',
                borderRadius: '8px',
                p: '10px 12px',
                fontSize: '.78rem',
                color: 'var(--neutral-600)',
                maxHeight: 120,
                overflowY: 'auto',
                whiteSpace: 'pre-wrap',
                mb: '6px',
                lineHeight: 1.5,
              }}
            >
              {termsText}
            </Box>
          </>
        )}

        <FormControlLabel
          control={
            <Checkbox
              checked={data.termsAccepted}
              onChange={e => update({ termsAccepted: e.target.checked })}
              size="small"
              sx={{ mt: '-2px' }}
            />
          }
          label={
            <Typography sx={{ fontSize: '.82rem', color: 'var(--neutral-700)' }}>
              Customer has read and accepted the terms &amp; conditions
            </Typography>
          }
          sx={{ mt: '10px', alignItems: 'flex-start' }}
        />
      </Box>
    </LocalizationProvider>
  );
}

export default DesignVisitStep1;
