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
          'Fixed bottom navigation bar. When every visible item fits directly (4 or fewer) all tabs render in the bar and there is no "More" button. The primary/overflow split (with a "More" button that opens a bottom Drawer) only appears when there are more visible items than fit. The active tab is highlighted; when an active page lives in the overflow set "More" shows as selected.',
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof BottomNav>;

export const MemberHomeSelected: Story = {
  name: 'Member — Home selected',
  render: () => {
    history.replaceState(null, '', NAV[0].href);
    (window as { __moHeaderUser?: { privilege_level: string } }).__moHeaderUser = { privilege_level: 'viewer' };
    return <BottomNav />;
  },
  parameters: {
    docs: {
      description: {
        story:
          'Member view: bar shows Home, Customers, Projects — all three fit, so there is no "More" button. Home is active (filled icon, accent border).',
      },
    },
  },
};

export const MemberProjectsSelected: Story = {
  name: 'Member — Projects selected (accent colour)',
  render: () => {
    history.replaceState(null, '', '/projects');
    (window as { __moHeaderUser?: { privilege_level: string } }).__moHeaderUser = { privilege_level: 'viewer' };
    return <BottomNav />;
  },
  parameters: {
    docs: {
      description: {
        story:
          'Member view with Projects active — uses the Projects stage accent colour for the icon and border.',
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
          'No tab matches the current path — every icon uses its outlined variant and nothing is highlighted.',
      },
    },
  },
};

export const ManagerHomeSelected: Story = {
  name: 'Manager — Home selected',
  render: () => {
    history.replaceState(null, '', NAV[0].href);
    (window as { __moHeaderUser?: { privilege_level: string } }).__moHeaderUser = { privilege_level: 'manager' };
    return <BottomNav />;
  },
  parameters: {
    docs: {
      description: {
        story:
          'Manager view: bar shows Home, Customers, Projects, Invoices — all four fit, so there is no "More" button. Home is active.',
      },
    },
  },
};

export const ManagerProjectsSelected: Story = {
  name: 'Manager — Projects selected (accent colour)',
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
  name: 'Manager — Invoices selected (direct tab)',
  render: () => {
    history.replaceState(null, '', '/invoices');
    (window as { __moHeaderUser?: { privilege_level: string } }).__moHeaderUser = { privilege_level: 'manager' };
    return <BottomNav />;
  },
  parameters: {
    docs: {
      description: {
        story:
          'Manager view with Invoices active. Invoices is the manager-only fourth tab and fits directly in the bar — it is highlighted in place, with no "More" button.',
      },
    },
  },
};
