import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { BRAND_COLORS, STAGE_COLORS, RADIUS } from '../theme';

const meta: Meta = {
  title: 'Tokens/Overview',
  parameters: { layout: 'padded' },
};
export default meta;

type Story = StoryObj;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box sx={{ mb: 5 }}>
      <Typography variant="h5" sx={{ fontWeight: 700, mb: 2 }}>{title}</Typography>
      {children}
    </Box>
  );
}

function SwatchGrid({ children }: { children: React.ReactNode }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 1.5 }}>
      {children}
    </Box>
  );
}

function Swatch({ name, hex, themePath, cssVar }: { name: string; hex: string; themePath: string; cssVar: string }) {
  return (
    <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
      <Box sx={{ height: 64, bgcolor: hex, borderBottom: '1px solid', borderColor: 'divider' }} />
      <Box sx={{ p: 1.25 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{name}</Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', display: 'block' }}>
          {hex.toUpperCase()}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.disabled', fontFamily: 'monospace', display: 'block', fontSize: 10 }}>
          {themePath}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.disabled', fontFamily: 'monospace', display: 'block', fontSize: 10 }}>
          var({cssVar})
        </Typography>
      </Box>
    </Paper>
  );
}

export const BrandColours: Story = {
  name: 'Brand Colours',
  render: () => (
    <Section title="Brand Colours">
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Neutral paper/stone/ink scales and orchid/plum/walnut accents.
        Reference via <code>theme.palette.brand.&lt;name&gt;</code> or <code>var(--name)</code> in CSS.
      </Typography>
      <SwatchGrid>
        {(Object.entries(BRAND_COLORS) as [string, string][]).map(([name, hex]) => (
          <Swatch
            key={name}
            name={name}
            hex={hex}
            themePath={`palette.brand.${name}`}
            cssVar={`--${name.replace(/([A-Z])/g, '-$1').toLowerCase()}`}
          />
        ))}
      </SwatchGrid>
    </Section>
  ),
};

export const StageColours: Story = {
  name: 'Stage Colours',
  render: () => (
    <Section title="Stage Colours">
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Three tokens per stage — solid <code>bg</code>, tinted <code>light</code>, dark <code>text</code>.
        Used on lead-status pills, stage badges, and the bottom nav.
      </Typography>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {Object.entries(STAGE_COLORS).map(([key, c]) => (
          <Paper key={key} variant="outlined" sx={{ p: 1.5, display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
            <Box sx={{ minWidth: 140 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700, textTransform: 'capitalize' }}>{key}</Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace' }}>
                palette.stage.{key}
              </Typography>
            </Box>
            <Chip size="small" label="Sample pill" sx={{ bgcolor: c.light, color: c.text, fontWeight: 600 }} />
            {(['bg', 'light', 'text'] as const).map((slot) => (
              <Box key={slot} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                <Box sx={{ width: 22, height: 22, bgcolor: c[slot], border: '1px solid', borderColor: 'divider', borderRadius: 0.5 }} />
                <Box>
                  <Typography variant="caption" sx={{ fontFamily: 'monospace', display: 'block' }}>
                    .{slot} · {c[slot].toUpperCase()}
                  </Typography>
                  <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.disabled', display: 'block', fontSize: 10 }}>
                    var(--stage-{key}-{slot})
                  </Typography>
                </Box>
              </Box>
            ))}
          </Paper>
        ))}
      </Box>
    </Section>
  ),
};

export const TypographyScale: Story = {
  name: 'Typography',
  render: () => {
    const theme = useTheme();
    const variants = [
      'h1','h2','h3','h4','h5','h6',
      'subtitle1','subtitle2',
      'body1','body2',
      'button','caption','overline',
    ] as const;
    return (
      <Section title="Typography">
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Every MUI typography variant, themed with Open Sans. Reference via{' '}
          <code>{`<Typography variant="h3">`}</code>.
        </Typography>
        <Paper variant="outlined" sx={{ p: 2 }}>
          {variants.map((v) => {
            const spec = theme.typography[v] as { fontSize?: string | number; fontWeight?: number | string; lineHeight?: number | string };
            return (
              <Box key={v} sx={{ py: 1.25, borderBottom: '1px solid', borderColor: 'divider', display: 'flex', alignItems: 'baseline', gap: 2, flexWrap: 'wrap', '&:last-child': { borderBottom: 'none' } }}>
                <Box sx={{ minWidth: 120, flexShrink: 0 }}>
                  <Typography variant="subtitle2" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{v}</Typography>
                  <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace' }}>
                    {spec.fontSize} · w{spec.fontWeight}
                  </Typography>
                </Box>
                <Typography variant={v} sx={{ flex: 1 }}>
                  The quick brown fox jumps over the lazy dog
                </Typography>
              </Box>
            );
          })}
        </Paper>
      </Section>
    );
  },
};

export const SpacingScale: Story = {
  name: 'Spacing',
  render: () => {
    const theme = useTheme();
    const steps = [0.5, 1, 1.5, 2, 3, 4, 6, 8] as const;
    return (
      <Section title="Spacing">
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          MUI 8px spacing scale. Reference via <code>theme.spacing(n)</code> or <code>{`sx={{ p: 2 }}`}</code> (= 16px).
        </Typography>
        <Paper variant="outlined" sx={{ p: 2 }}>
          {steps.map((n) => {
            const px = parseFloat(theme.spacing(n));
            return (
              <Box key={n} sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 0.75 }}>
                <Box sx={{ minWidth: 130, flexShrink: 0 }}>
                  <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>theme.spacing({n})</Typography>
                </Box>
                <Box sx={{ width: px, height: 14, bgcolor: 'primary.main', borderRadius: 0.5, minWidth: 2 }} />
                <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
                  {px}px
                </Typography>
              </Box>
            );
          })}
        </Paper>
      </Section>
    );
  },
};

export const RadiiTokens: Story = {
  name: 'Radii',
  render: () => {
    const entries = Object.entries(RADIUS) as [string, number][];
    return (
      <Section title="Radii">
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Corner-radius tokens from <code>RADIUS</code>. Reference via <code>theme.radius.&lt;key&gt;</code>{' '}
          or <code>var(--radius-&lt;key&gt;)</code> in CSS.
        </Typography>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
          {entries.map(([key, px]) => (
            <Paper key={key} variant="outlined" sx={{ p: 2, textAlign: 'center', minWidth: 110 }}>
              <Box
                sx={{
                  width: 64, height: 64, bgcolor: 'primary.light',
                  borderRadius: `${px}px`,
                  mx: 'auto', mb: 1,
                  border: '2px solid', borderColor: 'primary.main',
                }}
              />
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{key}</Typography>
              <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
                {px === 999 ? '999px (pill)' : `${px}px`}
              </Typography>
              <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.disabled', display: 'block', fontSize: 10 }}>
                var(--radius-{key})
              </Typography>
            </Paper>
          ))}
        </Box>
      </Section>
    );
  },
};
