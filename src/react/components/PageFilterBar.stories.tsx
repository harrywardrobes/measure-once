import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import { PageFilterBar } from './PageFilterBar';

const meta: Meta<typeof PageFilterBar> = {
  title: 'Components/Filters/PageFilterBar',
  tags: ['autodocs'],
  component: PageFilterBar,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Thin horizontal layout wrapper used around any combination of filter controls (StageTabGroup, FilterChipRow, SortSelect, etc.). Provides consistent gap, horizontal overflow scrolling, and hidden scrollbars. Pass `sx` to add custom padding, borders, or backgrounds.',
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof PageFilterBar>;

export const Default: Story = {
  args: {
    children: (
      <>
        <Box component="span" sx={{ px: '12px', py: '6px', bgcolor: 'action.selected', borderRadius: '4px' }}>Chip A</Box>
        <Box component="span" sx={{ px: '12px', py: '6px', bgcolor: 'action.selected', borderRadius: '4px' }}>Chip B</Box>
        <Box component="span" sx={{ px: '12px', py: '6px', bgcolor: 'action.selected', borderRadius: '4px' }}>Chip C</Box>
      </>
    ),
  },
  parameters: {
    docs: {
      description: { story: 'Default layout: items laid out with gap, no extra padding.' },
    },
  },
};

export const WithBackground: Story = {
  args: {
    sx: { px: 2, py: 1, bgcolor: 'background.default', borderBottom: '1px solid', borderColor: 'divider' },
    children: (
      <>
        <Box component="span" sx={{ px: '12px', py: '6px', bgcolor: 'divider', borderRadius: '4px' }}>Filter 1</Box>
        <Box component="span" sx={{ px: '12px', py: '6px', bgcolor: 'divider', borderRadius: '4px' }}>Filter 2</Box>
        <Box component="span" sx={{ px: '12px', py: '6px', bgcolor: 'divider', borderRadius: '4px' }}>Filter 3</Box>
      </>
    ),
  },
  parameters: {
    docs: {
      description: {
        story: 'With `sx` overrides: paper background and a bottom divider — typical page toolbar usage.',
      },
    },
  },
};

export const ManyItems: Story = {
  args: {
    sx: { px: 2 },
    children: Array.from({ length: 14 }, (_, i) => (
      <Box
        key={i}
        component="span"
        sx={{ px: '14px', py: '6px', bgcolor: 'action.selected', borderRadius: '4px', flexShrink: 0, whiteSpace: 'nowrap' }}
      >
        Item {i + 1}
      </Box>
    )),
  },
  parameters: {
    docs: {
      description: {
        story: 'Overflow scrolling: 14 items that exceed the container width scroll horizontally with hidden scrollbars.',
      },
    },
  },
};
