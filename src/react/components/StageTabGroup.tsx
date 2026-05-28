import React from 'react';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import ToggleButton from '@mui/material/ToggleButton';
import { BRAND_COLORS } from '../theme';

export interface StageTab {
  key: string;
  label: string;
}

export interface StageColorEntry {
  bg: string;
  text?: string;
}

export interface StageTabGroupProps {
  value: string;
  onChange: (value: string) => void;
  tabs: StageTab[];
  /**
   * Optional colour map from tab key to `{ bg, text? }`. When the active tab
   * has an entry here the button is filled with that colour; otherwise it falls
   * back to the brand plum token.
   */
  stageColors?: Record<string, StageColorEntry>;
}

/**
 * StageTabGroup — wraps MUI ToggleButtonGroup + ToggleButton for stage-filter
 * tab bars. Active tab fills with the stage's brand colour when one is
 * supplied via `stageColors`, falling back to the plum token.
 *
 * This is the canonical tab implementation shared by CustomersPage and
 * ProjectsPage. Pass the STAGE_COLORS map (or a subset) as `stageColors`.
 */
export function StageTabGroup({ value, onChange, tabs, stageColors }: StageTabGroupProps) {
  return (
    <ToggleButtonGroup
      size="small"
      exclusive
      value={value}
      onChange={(_, v: string | null) => {
        if (v !== null) onChange(v);
      }}
      aria-label="Stage filter"
      sx={{ flexWrap: 'wrap' }}
    >
      {tabs.map((t) => {
        const colour = stageColors?.[t.key] ?? null;
        const selected = value === t.key;
        const activeBg = colour?.bg ?? BRAND_COLORS.plum;

        return (
          <ToggleButton
            key={t.key}
            value={t.key}
            sx={
              selected
                ? {
                    bgcolor: activeBg,
                    color: 'common.white',
                    borderColor: activeBg,
                    '&:hover': { bgcolor: activeBg, opacity: 0.9 },
                    '&.Mui-selected': {
                      bgcolor: activeBg,
                      color: 'common.white',
                      '&:hover': { bgcolor: activeBg, opacity: 0.9 },
                    },
                  }
                : undefined
            }
          >
            {t.label}
          </ToggleButton>
        );
      })}
    </ToggleButtonGroup>
  );
}

export default StageTabGroup;
