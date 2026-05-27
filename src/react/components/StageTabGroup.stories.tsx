import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { StageTabGroup } from './StageTabGroup';
import { STAGE_COLORS } from '../theme';

const SAMPLE_TABS = [
  { key: 'sales', label: 'Sales' },
  { key: 'designvisit', label: 'Design Visit' },
  { key: 'survey', label: 'Survey' },
  { key: 'order', label: 'Order' },
  { key: 'workshop', label: 'Workshop' },
];

const meta: Meta<typeof StageTabGroup> = {
  title: 'Components/Filters/StageTabGroup',
  tags: ['autodocs'],
  component: StageTabGroup,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Wraps MUI ToggleButtonGroup + ToggleButton for stage-filter tab bars. The active tab fills with the stage\'s brand colour from `stageColors`, falling back to the plum token. Ignores null changes so a value is always selected.',
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof StageTabGroup>;

export const Default: Story = {
  args: {
    value: 'sales',
    tabs: SAMPLE_TABS,
    onChange: () => {},
  },
  parameters: {
    docs: {
      description: { story: 'No `stageColors` supplied — active tab uses the plum fallback colour.' },
    },
  },
};

export const WithStageColors: Story = {
  args: {
    value: 'sales',
    tabs: SAMPLE_TABS,
    stageColors: STAGE_COLORS,
    onChange: () => {},
  },
  parameters: {
    docs: {
      description: {
        story: 'Full `STAGE_COLORS` map passed — each active tab shows its pipeline brand colour.',
      },
    },
  },
};

export const Interactive: Story = {
  render: () => {
    const [active, setActive] = useState('sales');
    return (
      <StageTabGroup
        value={active}
        onChange={setActive}
        tabs={SAMPLE_TABS}
        stageColors={STAGE_COLORS}
      />
    );
  },
  parameters: {
    docs: {
      description: { story: 'Click any tab to change the active stage. Null changes are ignored.' },
    },
  },
};

export const SingleTab: Story = {
  args: {
    value: 'survey',
    tabs: [{ key: 'survey', label: 'Survey' }],
    stageColors: STAGE_COLORS,
    onChange: () => {},
  },
  parameters: {
    docs: {
      description: { story: 'Edge case: only one tab — always shown as selected.' },
    },
  },
};

export const ManyTabs: Story = {
  args: {
    value: 'aftercare',
    tabs: Object.keys(STAGE_COLORS).map((k) => ({ key: k, label: k[0].toUpperCase() + k.slice(1) })),
    stageColors: STAGE_COLORS,
    onChange: () => {},
  },
  parameters: {
    docs: {
      description: {
        story: 'All pipeline stages at once — wraps onto a second line via `flexWrap: wrap`.',
      },
    },
  },
};
