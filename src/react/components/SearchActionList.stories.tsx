import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { SearchActionList, type SearchAction } from './SearchActionList';

const SAMPLE: SearchAction[] = [
  { id: 'new-customer', label: 'New customer',    category: 'Action',   hint: 'Create a new customer record' },
  { id: 'go-customers', label: 'All customers',   category: 'Navigate', hint: 'Browse your customer list' },
  { id: 'go-home',      label: 'Home dashboard',  category: 'Navigate', hint: 'Go to the main dashboard' },
  { id: 'go-sales',     label: 'Sales board',     category: 'Navigate', hint: 'Manage leads and open deals' },
  { id: 'sign-out',     label: 'Sign out',        category: 'Account',  hint: 'End your current session' },
];

const meta: Meta<typeof SearchActionList> = {
  title: 'UI/SearchActionList',
  component: SearchActionList,
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div className="admin-page" style={{ maxWidth: 720 }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof SearchActionList>;

export const Default: Story = {
  render: () => {
    const [actions, setActions] = useState(SAMPLE);
    const [disabled, setDisabled] = useState(new Set<string>(['go-home']));
    return (
      <SearchActionList
        actions={actions}
        disabled={disabled}
        onToggle={(id, on) => {
          const next = new Set(disabled);
          if (on) next.delete(id); else next.add(id);
          setDisabled(next);
        }}
        onReorder={ids => setActions(ids.map(id => actions.find(a => a.id === id)!).filter(Boolean))}
      />
    );
  },
};

export const Loading: Story = {
  args: { actions: [], disabled: new Set(), onToggle: () => {}, onReorder: () => {}, loading: true },
};

export const Empty: Story = {
  args: { actions: [], disabled: new Set(), onToggle: () => {}, onReorder: () => {} },
};
