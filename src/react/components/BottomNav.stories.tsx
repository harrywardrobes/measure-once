import type { Meta, StoryObj } from '@storybook/react';
import { BottomNav, NAV } from './BottomNav';

const meta: Meta<typeof BottomNav> = {
  title: 'Components/Navigation/BottomNav',
  tags: ['autodocs'],
  component: BottomNav,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Fixed bottom navigation bar. Shows exactly 4 items: 3 role-relevant primary tabs + a "More" button. Tapping "More" opens a bottom Drawer with the remaining tabs. The active tab is highlighted whether it is in the bar or the drawer; when the active page is in the drawer, "More" shows as selected.',
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof BottomNav>;

export const MemberHomeSelected: Story = {
  name: 'Member — Home selected (bar tab)',
  render: () => {
    history.replaceState(null, '', NAV[0].href);
    (window as { __moHeaderUser?: { privilege_level: string } }).__moHeaderUser = { privilege_level: 'viewer' };
    return <BottomNav />;
  },
  parameters: {
    docs: {
      description: {
        story:
          'Member view: bar shows Home, Calendar, Trades + More. Home is active (filled icon, accent border).',
      },
    },
  },
};

export const MemberIdeasSelected: Story = {
  name: 'Member — Ideas selected (overflow → More highlighted)',
  render: () => {
    history.replaceState(null, '', '/ideas');
    (window as { __moHeaderUser?: { privilege_level: string } }).__moHeaderUser = { privilege_level: 'viewer' };
    return <BottomNav />;
  },
  parameters: {
    docs: {
      description: {
        story:
          'Member view with the active page (Ideas) in the overflow set. The "More" button shows as selected in the bar.',
      },
    },
  },
};

export const MemberNoneSelected: Story = {
  name: 'Member — None selected (outlined icons)',
  render: () => {
    history.replaceState(null, '', '/unknown');
    (window as { __moHeaderUser?: { privilege_level: string } }).__moHeaderUser = { privilege_level: 'viewer' };
    return <BottomNav />;
  },
  parameters: {
    docs: {
      description: {
        story:
          'No tab matches the current path — every icon uses its outlined variant, More button is not highlighted.',
      },
    },
  },
};

export const ManagerHomeSelected: Story = {
  name: 'Manager — Home selected (bar tab)',
  render: () => {
    history.replaceState(null, '', NAV[0].href);
    (window as { __moHeaderUser?: { privilege_level: string } }).__moHeaderUser = { privilege_level: 'manager' };
    return <BottomNav />;
  },
  parameters: {
    docs: {
      description: {
        story:
          'Manager view: bar shows Home, Customers, Projects + More. Home is active.',
      },
    },
  },
};

export const ManagerProjectsSelected: Story = {
  name: 'Manager — Projects selected (bar tab, accent colour)',
  render: () => {
    history.replaceState(null, '', '/projects');
    (window as { __moHeaderUser?: { privilege_level: string } }).__moHeaderUser = { privilege_level: 'manager' };
    return <BottomNav />;
  },
  parameters: {
    docs: {
      description: {
        story:
          'Manager view with Projects active — uses the Projects stage accent colour for the icon and border.',
      },
    },
  },
};

export const ManagerInvoicesSelected: Story = {
  name: 'Manager — Invoices selected (overflow → More highlighted)',
  render: () => {
    history.replaceState(null, '', '/invoices');
    (window as { __moHeaderUser?: { privilege_level: string } }).__moHeaderUser = { privilege_level: 'manager' };
    return <BottomNav />;
  },
  parameters: {
    docs: {
      description: {
        story:
          'Manager view with the active page (Invoices) in the overflow set. The "More" button shows as selected.',
      },
    },
  },
};
