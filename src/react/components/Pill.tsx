import React from 'react';
import Chip from '@mui/material/Chip';
import { useTheme } from '@mui/material/styles';

/**
 * <Pill/> — small status pill used across the React island.
 *
 * Renders an MUI `<Chip size="small">` themed with the Harry Wardrobes stage /
 * status colours from `theme.palette.stage`. Legacy variants
 * (`neutral` / `success` / `danger` / `warn` / `info`) still work — they map
 * onto MUI's semantic palette so existing callers (e.g. legacy renderPill
 * call sites being ported to React) keep their meaning.
 *
 * A `stage` prop is also accepted for the lead-status pills on the
 * customers / customer-detail pages — `<Pill stage="sales" label="Sales" />`
 * picks up the `--stage-sales-*` palette automatically.
 */
export type PillVariant = 'neutral' | 'success' | 'danger' | 'warn' | 'info';

export interface PillProps {
  label: React.ReactNode;
  variant?: PillVariant;
  stage?: string;
  className?: string;
}

const VARIANTS = new Set<PillVariant>(['neutral', 'success', 'danger', 'warn', 'info']);

export function Pill({ label, variant, stage, className }: PillProps) {
  const theme = useTheme();
  const stageColor = stage ? theme.palette.stage[stage] : undefined;

  if (stageColor) {
    return (
      <Chip
        size="small"
        label={label}
        className={className}
        sx={{
          bgcolor: stageColor.light,
          color: stageColor.text,
          fontWeight: 600,
          borderRadius: theme.radius.pill / 2,
        }}
      />
    );
  }

  const v: PillVariant = variant && VARIANTS.has(variant) ? variant : 'neutral';
  const COLOR_MAP: Record<PillVariant, 'default' | 'success' | 'error' | 'warning' | 'info'> = {
    neutral: 'default',
    success: 'success',
    danger:  'error',
    warn:    'warning',
    info:    'info',
  };
  return (
    <Chip
      size="small"
      label={label}
      color={COLOR_MAP[v]}
      className={className}
      sx={{ fontWeight: 600 }}
    />
  );
}

export default Pill;
