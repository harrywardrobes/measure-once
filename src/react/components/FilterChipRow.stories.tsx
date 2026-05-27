import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { FilterChipRow } from './FilterChipRow';

const LEAD_STATUS_CHIPS = [
  { key: '', label: 'All', count: 42 },
  { key: 'new', label: 'New', count: 8 },
  { key: 'contacted', label: 'Contacted', count: 14 },
  { key: 'qualified', label: 'Qualified', count: 11 },
  { key: 'proposal', label: 'Proposal', count: 5 },
  { key: 'won', label: 'Won', count: 4 },
];

const meta: Meta<typeof FilterChipRow> = {
  title: 'Components/Filters/FilterChipRow',
  tags: ['autodocs'],
  component: FilterChipRow,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Horizontally scrollable row of MUI Chip filter buttons. Active chip: `variant="filled"` + `color="primary"`. Inactive chips: `variant="outlined"`. An empty string `value` represents "no filter / all".',
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof FilterChipRow>;

export const Default: Story = {
  args: {
    chips: LEAD_STATUS_CHIPS,
    value: '',
    onChange: () => {},
  },
  parameters: {
    docs: {
      description: { story: '"All" chip active (empty string key) — shows counts appended to each label.' },
    },
  },
};

export const WithActiveFilter: Story = {
  args: {
    chips: LEAD_STATUS_CHIPS,
    value: 'qualified',
    onChange: () => {},
  },
  parameters: {
    docs: {
      description: { story: '"Qualified" chip is active — filled primary colour, others outlined.' },
    },
  },
};

export const NoCounts: Story = {
  args: {
    chips: [
      { key: '', label: 'All' },
      { key: 'open', label: 'Open' },
      { key: 'closed', label: 'Closed' },
      { key: 'pending', label: 'Pending' },
    ],
    value: 'open',
    onChange: () => {},
  },
  parameters: {
    docs: {
      description: { story: 'Chips with no `count` — labels render without the "(N)" suffix.' },
    },
  },
};

const MANY_CHIP_COUNTS = [12, 7, 23, 4, 18, 9, 31, 2, 15, 6, 27, 11];

export const ManyChips: Story = {
  args: {
    chips: Array.from({ length: 12 }, (_, i) => ({
      key: `filter-${i}`,
      label: `Filter ${i + 1}`,
      count: MANY_CHIP_COUNTS[i],
    })),
    value: 'filter-3',
    onChange: () => {},
  },
  parameters: {
    docs: {
      description: {
        story: '12 chips — excess chips scroll horizontally with hidden scrollbars.',
      },
    },
  },
};

export const Interactive: Story = {
  render: () => {
    const [active, setActive] = useState('');
    return (
      <FilterChipRow
        chips={LEAD_STATUS_CHIPS}
        value={active}
        onChange={setActive}
      />
    );
  },
  parameters: {
    docs: {
      description: { story: 'Click any chip to toggle the active filter.' },
    },
  },
};
