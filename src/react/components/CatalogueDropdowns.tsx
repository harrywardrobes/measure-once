import React from 'react';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import type { SxProps, Theme } from '@mui/material/styles';

/**
 * Shared catalogue-select primitive.
 *
 * Every visit type picks values from the same `{ id, name }` catalogue lists
 * (handles, furniture ranges, door styles). This renders one or more labelled
 * `<Select>` dropdowns from those lists so the markup is not duplicated across
 * the Design Visit wizard (and, in future, the Survey visit).
 */
export interface CatalogueOption {
  id: string | number;
  name: string;
}

export interface CatalogueDropdownSpec {
  /** Field label (also the accessible name). */
  label: string;
  /** Currently selected id, as a string ('' for none). */
  value: string;
  /** Catalogue items to offer. */
  options: CatalogueOption[];
  /** Called with the newly selected id (string), '' when cleared. */
  onChange: (value: string) => void;
  /** Text for the empty/clear option. Defaults to '— none —'. */
  noneLabel?: string;
  /** Hide the dropdown entirely when there are no options. Defaults to true. */
  hideWhenEmpty?: boolean;
  /** Override the FormControl sx (defaults to a bottom margin). */
  sx?: SxProps<Theme>;
}

export interface CatalogueDropdownsProps {
  dropdowns: CatalogueDropdownSpec[];
}

export function CatalogueDropdowns({ dropdowns }: CatalogueDropdownsProps) {
  return (
    <>
      {dropdowns.map((d) => {
        const hideWhenEmpty = d.hideWhenEmpty !== false;
        if (hideWhenEmpty && d.options.length === 0) return null;
        return (
          <FormControl key={d.label} fullWidth size="small" sx={d.sx ?? { mb: 1.5 }}>
            <InputLabel>{d.label}</InputLabel>
            <Select
              label={d.label}
              value={d.value ? String(d.value) : ''}
              onChange={(e) => d.onChange(e.target.value)}
            >
              <MenuItem value="">{d.noneLabel ?? '— none —'}</MenuItem>
              {d.options.map((o) => (
                <MenuItem key={o.id} value={String(o.id)}>
                  {o.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        );
      })}
    </>
  );
}

export default CatalogueDropdowns;
