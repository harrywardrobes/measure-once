import React from 'react';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import ToggleButton from '@mui/material/ToggleButton';
import Box from '@mui/material/Box';
import { BRAND_COLORS } from '../theme';

export interface StageTab {
  key: string;
  label: string;
  /** Optional customer count displayed muted to the right of the label. */
  count?: number;
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
  /**
   * When true, tabs stretch equally to fill available width on md+ screens.
   * On smaller viewports the group scrolls horizontally (no wrapping).
   */
  fullWidth?: boolean;
}

/**
 * StageTabGroup — wraps MUI ToggleButtonGroup + ToggleButton for stage-filter
 * tab bars. Active tab fills with the stage's brand colour when one is
 * supplied via `stageColors`, falling back to the plum token.
 *
 * This is the canonical tab implementation shared by CustomersPage and
 * ProjectsPage. Pass the STAGE_COLORS map (or a subset) as `stageColors`.
 *
 * Selection is handled via `onClick` on each button (not via the group's
 * `onChange`) so that clicking the already-active tab still fires the handler
 * — important for filter-change side-effects such as resetting the page to 1.
 */
export function StageTabGroup({ value, onChange, tabs, stageColors, fullWidth }: StageTabGroupProps) {
  return (
    <ToggleButtonGroup
      exclusive
      value={value}
      aria-label="Stage filter"
      sx={{
        display: 'flex',
        flexWrap: 'nowrap',
        ...(fullWidth && { width: { md: '100%' } }),
      }}
    >
      {tabs.map((t) => {
        const colour = stageColors?.[t.key] ?? null;
        const selected = value === t.key;
        const activeBg = colour?.bg ?? BRAND_COLORS.plum;

        return (
          <ToggleButton
            key={t.key}
            data-testid={`stage-filter-tab-${t.key}`}
            data-tab-key={t.key}
            value={t.key}
            onClick={() => onChange(t.key)}
            sx={{
              whiteSpace: 'nowrap',
              textTransform: 'none',
              fontWeight: selected ? 600 : 500,
              fontSize: { xs: '0.8125rem', sm: '0.875rem' },
              letterSpacing: 0,
              py: { xs: 1, sm: 1.25 },
              px: { xs: 1.5, sm: 2 },
              lineHeight: 1.4,
              ...(fullWidth && {
                flex: { md: 1 },
                minWidth: { xs: 'max-content', md: 0 },
              }),
              ...(selected
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
                : {
                    color: 'text.secondary',
                    '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
                  }),
            }}
          >
            {t.label}
            {t.count != null && t.count > 0 && (
              <Box
                component="span"
                sx={{
                  ml: 0.625,
                  fontSize: '0.78em',
                  fontWeight: 400,
                  opacity: selected ? 0.65 : 0.5,
                  letterSpacing: 0,
                }}
              >
                {t.count}
              </Box>
            )}
          </ToggleButton>
        );
      })}
    </ToggleButtonGroup>
  );
}

export default StageTabGroup;
