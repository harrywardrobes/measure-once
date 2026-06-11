import React from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import DialogTitle from '@mui/material/DialogTitle';
import Tooltip from '@mui/material/Tooltip';
import { DEMO_TOOLTIP } from './demoData';

type DialogTitleProps = React.ComponentProps<typeof DialogTitle>;

/**
 * DialogTitle that shows a "Demo preview" chip in the top-right when `demo` is
 * true. Falls back to a plain DialogTitle otherwise so existing layouts and
 * test ids are untouched in normal use.
 */
export function DemoDialogTitle({
  demo,
  children,
  ...rest
}: { demo?: boolean; children: React.ReactNode } & DialogTitleProps) {
  if (!demo) return <DialogTitle {...rest}>{children}</DialogTitle>;
  return (
    <DialogTitle {...rest}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
        <Box component="span" sx={{ minWidth: 0 }}>{children}</Box>
        <Chip label="Demo preview" size="small" color="info" variant="outlined" sx={{ flexShrink: 0 }} />
      </Box>
    </DialogTitle>
  );
}

/**
 * Wraps a (typically disabled) action button so a tooltip explaining demo mode
 * still appears on hover. MUI tooltips need a non-disabled wrapper element, so
 * the child is wrapped in a span. When `demo` is false the child is returned
 * unchanged.
 */
export function DemoActionTooltip({
  demo,
  children,
}: { demo?: boolean; children: React.ReactElement }) {
  if (!demo) return children;
  return (
    <Tooltip title={DEMO_TOOLTIP}>
      <span style={{ display: 'inline-flex' }}>{children}</span>
    </Tooltip>
  );
}
