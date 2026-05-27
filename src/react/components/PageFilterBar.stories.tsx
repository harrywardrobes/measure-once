import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
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
        <span style={{ padding: '6px 12px', background: '#E8E3D8', borderRadius: 4 }}>Chip A</span>
        <span style={{ padding: '6px 12px', background: '#E8E3D8', borderRadius: 4 }}>Chip B</span>
        <span style={{ padding: '6px 12px', background: '#E8E3D8', borderRadius: 4 }}>Chip C</span>
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
    sx: { px: 2, py: 1, bgcolor: '#F6F1E7', borderBottom: '1px solid #D9D2C2' },
    children: (
      <>
        <span style={{ padding: '6px 12px', background: '#D9D2C2', borderRadius: 4 }}>Filter 1</span>
        <span style={{ padding: '6px 12px', background: '#D9D2C2', borderRadius: 4 }}>Filter 2</span>
        <span style={{ padding: '6px 12px', background: '#D9D2C2', borderRadius: 4 }}>Filter 3</span>
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
      <span
        key={i}
        style={{ padding: '6px 14px', background: '#E8E3D8', borderRadius: 4, flexShrink: 0, whiteSpace: 'nowrap' }}
      >
        Item {i + 1}
      </span>
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
