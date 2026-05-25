import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Toggle } from './Toggle';

const meta: Meta<typeof Toggle> = {
  title: 'UI/Toggle',
  component: Toggle,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <div className="admin-page">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof Toggle>;

export const On: Story = { args: { checked: true } };
export const Off: Story = { args: { checked: false } };
export const Disabled: Story = { args: { checked: true, disabled: true } };

export const Interactive: Story = {
  render: () => {
    const [on, setOn] = useState(true);
    return <Toggle checked={on} onChange={setOn} title={on ? 'Disable' : 'Enable'} />;
  },
};
