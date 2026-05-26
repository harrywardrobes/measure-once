import React from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Chip from '@mui/material/Chip';

export interface FilterChip {
  key: string;
  label: string;
  /**
   * Optional count appended to the label as "(N)". Pass `undefined` to omit.
   */
  count?: number;
}

export interface FilterChipRowProps {
  chips: FilterChip[];
  /** The currently-active chip key. Empty string means "no filter / all". */
  value: string;
  onChange: (key: string) => void;
}

/**
 * FilterChipRow — horizontally scrollable row of MUI Chip filter buttons.
 *
 * Active chip: `variant="filled"` + `color="primary"`.
 * Inactive chips: `variant="outlined"`.
 *
 * Used by CustomersPage for lead-status and sub-status rows and available for
 * any future filter surface.
 */
export function FilterChipRow({ chips, value, onChange }: FilterChipRowProps) {
  return (
    <Box sx={{ overflowX: 'auto', pb: 0.5, scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' } }}>
      <Stack direction="row" spacing={1} sx={{ flexWrap: 'nowrap' }}>
        {chips.map((chip) => {
          const active = value === chip.key;
          const label =
            chip.count !== undefined ? `${chip.label} (${chip.count})` : chip.label;
          return (
            <Chip
              key={chip.key}
              label={label}
              variant={active ? 'filled' : 'outlined'}
              color={active ? 'primary' : 'default'}
              onClick={() => onChange(chip.key)}
              size="small"
              sx={{ flexShrink: 0 }}
            />
          );
        })}
      </Stack>
    </Box>
  );
}

export default FilterChipRow;
