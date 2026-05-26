import React from 'react';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';

export interface SortOption {
  value: string;
  label: string;
}

export interface SortSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SortOption[];
  /** Label shown in the InputLabel. Defaults to "Sort". */
  label?: string;
  /** Minimum width of the FormControl in px. Defaults to 160. */
  minWidth?: number;
}

/**
 * SortSelect — standard MUI outlined FormControl + InputLabel + Select for
 * sort-order dropdowns. Uses default MUI outlined styling with no custom
 * border-radius or border-colour overrides.
 *
 * Pass an `id`-safe label string; a unique `labelId` is derived from it
 * automatically so multiple instances on the same page stay accessible.
 */
export function SortSelect({
  value,
  onChange,
  options,
  label = 'Sort',
  minWidth = 160,
}: SortSelectProps) {
  const labelId = `sort-select-label-${label.toLowerCase().replace(/\s+/g, '-')}`;
  const selectId = `sort-select-${label.toLowerCase().replace(/\s+/g, '-')}`;

  return (
    <FormControl size="small" sx={{ minWidth, flexShrink: 0 }}>
      <InputLabel id={labelId}>{label}</InputLabel>
      <Select
        labelId={labelId}
        id={selectId}
        label={label}
        value={value}
        onChange={(e) => onChange(String(e.target.value))}
      >
        {options.map((o) => (
          <MenuItem key={o.value} value={o.value}>
            {o.label}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}

export default SortSelect;
