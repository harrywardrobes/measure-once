import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Typography from '@mui/material/Typography';
import type { SxProps, Theme } from '@mui/material/styles';

/**
 * Shared catalogue-select primitive.
 *
 * Every visit type picks values from the same `{ id, name }` catalogue lists
 * (handles, furniture ranges, door styles). This renders one or more labelled
 * `<Select>` dropdowns from those lists so the markup is not duplicated across
 * the Design Visit wizard and the Survey Visit wizard.
 *
 * Optionally, a dropdown can carry a pairing `suggestion` (sourced from
 * `catalog_pairings`). When the suggested id differs from the current value a
 * small "Suggested: …" hint with an Apply action is shown beneath the select.
 * The feature is fully backward-compatible: dropdowns without a `suggestion`
 * render exactly as before, so the Design Visit wizard is unaffected unless
 * pairings are supplied.
 */
export interface CatalogueOption {
  id: string | number;
  name: string;
}

export interface CatalogueSuggestion {
  /** Suggested option id, as a string. */
  id: string;
  /** Display name of the suggested option. */
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
  /**
   * Optional pairing suggestion. When present and its id differs from `value`,
   * a "Suggested: …" hint with an Apply button is shown beneath the select.
   * Pass `null`/`undefined` to show no suggestion (default).
   */
  suggestion?: CatalogueSuggestion | null;
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
        const currentValue = d.value ? String(d.value) : '';
        const showSuggestion =
          d.suggestion != null &&
          d.suggestion.id !== '' &&
          String(d.suggestion.id) !== currentValue;
        return (
          <FormControl key={d.label} fullWidth size="small" sx={d.sx ?? { mb: 1.5 }}>
            <InputLabel>{d.label}</InputLabel>
            <Select
              label={d.label}
              value={currentValue}
              onChange={(e) => d.onChange(e.target.value)}
            >
              <MenuItem value="">{d.noneLabel ?? '— none —'}</MenuItem>
              {d.options.map((o) => (
                <MenuItem key={o.id} value={String(o.id)}>
                  {o.name}
                </MenuItem>
              ))}
            </Select>
            {showSuggestion && (
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.75,
                  mt: '6px',
                }}
              >
                <Typography
                  variant="caption"
                  sx={{ color: 'var(--neutral-600)' }}
                >
                  Suggested: <strong>{d.suggestion!.name}</strong>
                </Typography>
                <Button
                  size="small"
                  variant="text"
                  onClick={() => d.onChange(String(d.suggestion!.id))}
                  sx={{
                    minWidth: 0,
                    px: '6px',
                    py: 0,
                    fontSize: '.72rem',
                    textTransform: 'none',
                  }}
                >
                  Apply
                </Button>
              </Box>
            )}
          </FormControl>
        );
      })}
    </>
  );
}

export default CatalogueDropdowns;
