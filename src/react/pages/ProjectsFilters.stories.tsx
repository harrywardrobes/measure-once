import React, { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import {
  Box,
  Checkbox,
  Chip,
  FormControlLabel,
  Popover,
  Typography,
} from '@mui/material';
import FilterListIcon from '@mui/icons-material/FilterList';
import { BRAND_COLORS, RADIUS } from '../theme';
import { PageFilterBar } from '../components/PageFilterBar';

const meta: Meta = {
  title: 'Features/Pages/ProjectsFilters',
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Contextual filter controls added to the Projects page: a **Staleness chip** (shown when the Sales or Design Visit stage is active) and a **Substage multi-select** (shown when the active stage has substage definitions). Both values are persisted to localStorage.',
      },
    },
  },
};
export default meta;

type Story = StoryObj;

// ── StalenessChip demo ──────────────────────────────────────────────────────

function StalenessDemo({ defaultActive = false }: { defaultActive?: boolean }) {
  const [active, setActive] = useState(defaultActive);
  return (
    <PageFilterBar sx={{ p: '8px 16px', border: `1px solid ${BRAND_COLORS.stone}`, borderRadius: 1 }}>
      <Typography sx={{ fontSize: '0.78rem', color: BRAND_COLORS.ink4, mr: 1 }}>Stage: Sales</Typography>
      <Chip
        label="Stale >30d"
        size="small"
        variant={active ? 'filled' : 'outlined'}
        onClick={() => setActive((v) => !v)}
        title={active ? 'Showing contacts not updated in the last 30 days — click to clear' : 'Filter to contacts not updated in the last 30 days'}
        sx={{
          fontSize: '0.72rem',
          height: 24,
          fontWeight: 600,
          cursor: 'pointer',
          bgcolor: active ? '#fef3c7' : undefined,
          color: active ? '#92400e' : undefined,
          borderColor: active ? '#fde68a' : BRAND_COLORS.stone,
          '& .MuiChip-label': { px: '8px' },
          '&:hover': { bgcolor: active ? '#fde68a' : BRAND_COLORS.stone },
        }}
      />
    </PageFilterBar>
  );
}

export const StalenessChipOff: Story = {
  name: 'Staleness chip — off (default)',
  render: () => <StalenessDemo defaultActive={false} />,
};

export const StalenessChipOn: Story = {
  name: 'Staleness chip — active',
  render: () => <StalenessDemo defaultActive={true} />,
};

// ── SubstageFilter demo ─────────────────────────────────────────────────────

const DEMO_SUBSTAGES = [
  { id: 'design_accepted', label: 'Design Accepted' },
  { id: 'unqualified', label: 'Unqualified' },
  { id: 'not_suitable', label: 'Not Suitable' },
  { id: 'bad_timing', label: 'Bad Timing' },
  { id: 'no_response_x3', label: 'No Response ×3' },
];

function SubstageFilterDemo({ defaultHidden = [] }: { defaultHidden?: string[] }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set(defaultHidden));
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const toggle = (id: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <PageFilterBar sx={{ p: '8px 16px', border: `1px solid ${BRAND_COLORS.stone}`, borderRadius: 1 }}>
      <Typography sx={{ fontSize: '0.78rem', color: BRAND_COLORS.ink4, mr: 1 }}>Stage: Survey</Typography>
      <Box
        component="button"
        onClick={(e: React.MouseEvent<HTMLButtonElement>) =>
          setAnchor(anchor ? null : e.currentTarget)
        }
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          fontSize: '0.75rem',
          fontWeight: 600,
          fontFamily: 'inherit',
          color: anchor || hidden.size > 0 ? '#fff' : BRAND_COLORS.ink3,
          background: anchor || hidden.size > 0 ? BRAND_COLORS.plum : 'transparent',
          border: `1.5px solid ${anchor || hidden.size > 0 ? BRAND_COLORS.plum : BRAND_COLORS.stone}`,
          borderRadius: `${RADIUS.pill}px`,
          px: '10px',
          py: '3px',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          transition: 'background 0.12s, color 0.12s, border-color 0.12s',
          WebkitTapHighlightColor: 'transparent',
          '&:hover': {
            background: anchor || hidden.size > 0 ? BRAND_COLORS.plum : BRAND_COLORS.stone,
          },
        }}
      >
        <FilterListIcon sx={{ fontSize: 13 }} />
        <span>Substages</span>
        {hidden.size > 0 && (
          <Box
            component="span"
            sx={{
              fontSize: '0.65rem',
              fontWeight: 700,
              bgcolor: 'rgba(255,255,255,0.25)',
              borderRadius: '999px',
              px: '5px',
              py: '1px',
              ml: '2px',
            }}
          >
            {hidden.size} hidden
          </Box>
        )}
      </Box>
      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{
          paper: {
            sx: {
              mt: '6px',
              minWidth: 168,
              p: 1.5,
              border: `1.5px solid ${BRAND_COLORS.stone}`,
              borderRadius: 1.5,
            },
          },
        }}
      >
        <Typography
          variant="caption"
          sx={{
            display: 'block',
            fontWeight: 700,
            color: BRAND_COLORS.ink4,
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
            fontSize: '0.68rem',
            mb: 1,
          }}
        >
          Show substages
        </Typography>
        {DEMO_SUBSTAGES.map((opt) => (
          <FormControlLabel
            key={opt.id}
            control={
              <Checkbox
                size="small"
                checked={!hidden.has(opt.id)}
                onChange={() => toggle(opt.id)}
                sx={{ py: 0.25, '& .MuiSvgIcon-root': { fontSize: 16 } }}
              />
            }
            label={opt.label}
            sx={{
              display: 'flex',
              m: 0,
              '& .MuiFormControlLabel-label': { fontSize: '0.8rem', fontWeight: 500 },
            }}
          />
        ))}
      </Popover>
    </PageFilterBar>
  );
}

export const SubstageFilterNoneHidden: Story = {
  name: 'Substage filter — none hidden',
  render: () => <SubstageFilterDemo defaultHidden={[]} />,
};

export const SubstageFilterSomeHidden: Story = {
  name: 'Substage filter — 2 hidden',
  render: () => <SubstageFilterDemo defaultHidden={['unqualified', 'not_suitable']} />,
};

// ── Combined demo ───────────────────────────────────────────────────────────

export const CombinedFiltersBar: Story = {
  name: 'Both filters — combined bar (Survey stage)',
  render: () => {
    const [stale, setStale] = useState(false);
    const [hidden, setHidden] = useState<Set<string>>(new Set(['unqualified']));
    const [anchor, setAnchor] = useState<HTMLElement | null>(null);

    const toggle = (id: string) =>
      setHidden((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });

    return (
      <PageFilterBar sx={{ p: '8px 16px', border: `1px solid ${BRAND_COLORS.stone}`, borderRadius: 1 }}>
        <Typography sx={{ fontSize: '0.78rem', color: BRAND_COLORS.ink4, mr: 1 }}>Stage: Survey</Typography>
        <Chip
          label="Stale >30d"
          size="small"
          variant={stale ? 'filled' : 'outlined'}
          onClick={() => setStale((v) => !v)}
          sx={{
            fontSize: '0.72rem',
            height: 24,
            fontWeight: 600,
            cursor: 'pointer',
            bgcolor: stale ? '#fef3c7' : undefined,
            color: stale ? '#92400e' : undefined,
            borderColor: stale ? '#fde68a' : BRAND_COLORS.stone,
            '& .MuiChip-label': { px: '8px' },
            '&:hover': { bgcolor: stale ? '#fde68a' : BRAND_COLORS.stone },
          }}
        />
        <Box
          component="button"
          onClick={(e: React.MouseEvent<HTMLButtonElement>) =>
            setAnchor(anchor ? null : e.currentTarget)
          }
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            fontSize: '0.75rem',
            fontWeight: 600,
            fontFamily: 'inherit',
            color: anchor || hidden.size > 0 ? '#fff' : BRAND_COLORS.ink3,
            background: anchor || hidden.size > 0 ? BRAND_COLORS.plum : 'transparent',
            border: `1.5px solid ${anchor || hidden.size > 0 ? BRAND_COLORS.plum : BRAND_COLORS.stone}`,
            borderRadius: `${RADIUS.pill}px`,
            px: '10px',
            py: '3px',
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          <FilterListIcon sx={{ fontSize: 13 }} />
          <span>Substages</span>
          {hidden.size > 0 && (
            <Box component="span" sx={{ fontSize: '0.65rem', fontWeight: 700, bgcolor: 'rgba(255,255,255,0.25)', borderRadius: '999px', px: '5px', py: '1px', ml: '2px' }}>
              {hidden.size} hidden
            </Box>
          )}
        </Box>
        <Popover
          open={Boolean(anchor)}
          anchorEl={anchor}
          onClose={() => setAnchor(null)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          transformOrigin={{ vertical: 'top', horizontal: 'left' }}
          slotProps={{ paper: { sx: { mt: '6px', minWidth: 168, p: 1.5, border: `1.5px solid ${BRAND_COLORS.stone}`, borderRadius: 1.5 } } }}
        >
          <Typography variant="caption" sx={{ display: 'block', fontWeight: 700, color: BRAND_COLORS.ink4, letterSpacing: '0.05em', textTransform: 'uppercase', fontSize: '0.68rem', mb: 1 }}>
            Show substages
          </Typography>
          {DEMO_SUBSTAGES.map((opt) => (
            <FormControlLabel
              key={opt.id}
              control={<Checkbox size="small" checked={!hidden.has(opt.id)} onChange={() => toggle(opt.id)} sx={{ py: 0.25, '& .MuiSvgIcon-root': { fontSize: 16 } }} />}
              label={opt.label}
              sx={{ display: 'flex', m: 0, '& .MuiFormControlLabel-label': { fontSize: '0.8rem', fontWeight: 500 } }}
            />
          ))}
        </Popover>
      </PageFilterBar>
    );
  },
};
