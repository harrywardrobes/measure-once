import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { SortSelect } from './SortSelect';

const CUSTOMERS_SORT_OPTIONS = [
  { value: 'priority', label: 'Priority first' },
  { value: 'newest', label: 'Newest first' },
  { value: 'name-asc', label: 'Name A–Z' },
  { value: 'name-desc', label: 'Name Z–A' },
];

const meta: Meta<typeof SortSelect> = {
  title: 'Components/Filters/SortSelect',
  tags: ['autodocs'],
  component: SortSelect,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'Standard MUI outlined FormControl + InputLabel + Select for sort-order dropdowns. A unique `labelId` is derived from the `label` prop so multiple instances on the same page stay accessible.',
      },
    },
  },
  argTypes: {
    label: { control: 'text' },
    minWidth: { control: { type: 'number', min: 80, max: 400, step: 10 } },
  },
};
export default meta;

type Story = StoryObj<typeof SortSelect>;

export const Default: Story = {
  args: {
    value: 'priority',
    options: CUSTOMERS_SORT_OPTIONS,
    label: 'Sort by',
    onChange: () => {},
  },
  parameters: {
    docs: {
      description: {
        story:
          'Customers page sort options — "Priority first" is the default selected value (pins no-status contacts to the top, then newest-first within each group).',
      },
    },
  },
};

export const NonDefaultSelected: Story = {
  args: {
    value: 'name-asc',
    options: CUSTOMERS_SORT_OPTIONS,
    label: 'Sort by',
    onChange: () => {},
  },
  parameters: {
    docs: {
      description: { story: 'A non-default option selected — "Name A–Z".' },
    },
  },
};

export const CustomLabel: Story = {
  args: {
    value: 'newest',
    label: 'Order by',
    options: CUSTOMERS_SORT_OPTIONS,
    onChange: () => {},
  },
  parameters: {
    docs: {
      description: { story: 'Custom `label` prop — the InputLabel and aria attributes update automatically.' },
    },
  },
};

export const NarrowWidth: Story = {
  args: {
    value: 'priority',
    label: 'Sort by',
    minWidth: 100,
    options: CUSTOMERS_SORT_OPTIONS,
    onChange: () => {},
  },
  parameters: {
    docs: {
      description: { story: '`minWidth` reduced to 100 px for a tight toolbar layout.' },
    },
  },
};

export const WideWidth: Story = {
  args: {
    value: 'priority',
    label: 'Sort by',
    minWidth: 240,
    options: CUSTOMERS_SORT_OPTIONS,
    onChange: () => {},
  },
  parameters: {
    docs: {
      description: { story: '`minWidth` increased to 240 px — label has more room to breathe.' },
    },
  },
};

export const Interactive: Story = {
  render: () => {
    const [val, setVal] = useState('priority');
    return (
      <SortSelect
        value={val}
        onChange={setVal}
        options={CUSTOMERS_SORT_OPTIONS}
        label="Sort by"
      />
    );
  },
  parameters: {
    docs: {
      description: { story: 'Fully interactive — select a different option to see the controlled value update.' },
    },
  },
};

export const TwoInstances: Story = {
  render: () => {
    const [sort, setSort] = useState('priority');
    const [group, setGroup] = useState('stage');
    return (
      <div style={{ display: 'flex', gap: 12 }}>
        <SortSelect value={sort} onChange={setSort} options={CUSTOMERS_SORT_OPTIONS} label="Sort by" />
        <SortSelect
          value={group}
          onChange={setGroup}
          options={[
            { value: 'stage', label: 'Stage' },
            { value: 'assignee', label: 'Assignee' },
            { value: 'none', label: 'None' },
          ]}
          label="Group by"
          minWidth={140}
        />
      </div>
    );
  },
  parameters: {
    docs: {
      description: {
        story: 'Two instances side-by-side — unique `labelId` derivation keeps aria attributes non-conflicting.',
      },
    },
  },
};
