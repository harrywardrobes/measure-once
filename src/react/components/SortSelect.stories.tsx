import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { SortSelect } from './SortSelect';

const SORT_OPTIONS = [
  { value: 'name_asc', label: 'Name A–Z' },
  { value: 'name_desc', label: 'Name Z–A' },
  { value: 'date_asc', label: 'Oldest first' },
  { value: 'date_desc', label: 'Newest first' },
  { value: 'stage', label: 'By stage' },
];

const meta: Meta<typeof SortSelect> = {
  title: 'Filter & Toolbar/SortSelect',
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
    value: 'name_asc',
    options: SORT_OPTIONS,
    onChange: () => {},
  },
  parameters: {
    docs: {
      description: { story: 'Default label ("Sort") and default minWidth (160 px).' },
    },
  },
};

export const CustomLabel: Story = {
  args: {
    value: 'date_desc',
    label: 'Order by',
    options: SORT_OPTIONS,
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
    value: 'stage',
    label: 'Sort',
    minWidth: 100,
    options: SORT_OPTIONS,
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
    value: 'name_asc',
    label: 'Sort by',
    minWidth: 240,
    options: SORT_OPTIONS,
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
    const [val, setVal] = useState('name_asc');
    return (
      <SortSelect
        value={val}
        onChange={setVal}
        options={SORT_OPTIONS}
        label="Sort"
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
    const [sort, setSort] = useState('name_asc');
    const [group, setGroup] = useState('stage');
    return (
      <div style={{ display: 'flex', gap: 12 }}>
        <SortSelect value={sort} onChange={setSort} options={SORT_OPTIONS} label="Sort" />
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
