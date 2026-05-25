import type { Meta, StoryObj } from '@storybook/react';
import { BottomNav, NAV } from './BottomNav';

const meta: Meta<typeof BottomNav> = {
  title: 'UI/BottomNav',
  component: BottomNav,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Fixed bottom navigation bar. The **selected** tab renders its filled icon variant; all others use the outlined variant. Each `NavItem` must supply both `Icon` and `IconOutlined` so this contract holds for every tab.',
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof BottomNav>;

export const NoneSelected: Story = {
  name: 'None selected (outlined icons)',
  render: () => {
    history.replaceState(null, '', '/unknown');
    return <BottomNav />;
  },
  parameters: {
    docs: {
      description: {
        story: 'No tab matches the current path — every icon uses its outlined variant.',
      },
    },
  },
};

export const FirstTabSelected: Story = {
  name: 'First tab selected (Home — filled icon)',
  render: () => {
    history.replaceState(null, '', NAV[0].href);
    return <BottomNav />;
  },
  parameters: {
    docs: {
      description: {
        story:
          'The first tab (Home) is active: its icon switches to the filled variant and the accent border appears. All other tabs remain outlined.',
      },
    },
  },
};

export const LastTabSelected: Story = {
  name: 'Last tab selected (Ideas — filled icon)',
  render: () => {
    history.replaceState(null, '', NAV[NAV.length - 1].href);
    return <BottomNav />;
  },
  parameters: {
    docs: {
      description: {
        story:
          'The last tab (Ideas) is active: its icon switches to the filled variant and the accent border appears. All other tabs remain outlined.',
      },
    },
  },
};
