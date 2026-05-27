import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import { GlobalHeader } from '../components/GlobalHeader';

const meta: Meta<typeof GlobalHeader> = {
  title: 'Navigation/GlobalHeader',
  component: GlobalHeader,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Fixed top app bar rendered on every page. Shows back navigation, search, service-status indicators, and role-gated shortcuts. Admin users see additional Admin panel and Design system icon buttons.',
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof GlobalHeader>;

export const MemberView: Story = {
  name: 'Member — standard nav (no admin buttons)',
  render: () => {
    history.replaceState(null, '', '/');
    (window as { __moHeaderUser?: { privilege_level: string } }).__moHeaderUser = { privilege_level: 'member' };
    return (
      <Box sx={{ minHeight: 80 }}>
        <GlobalHeader />
      </Box>
    );
  },
  parameters: {
    docs: {
      description: {
        story: 'Member view: Admin panel and Design system buttons are hidden.',
      },
    },
  },
};

export const AdminView: Story = {
  name: 'Admin — shows Admin panel + Design system buttons',
  render: () => {
    history.replaceState(null, '', '/');
    (window as { __moHeaderUser?: { privilege_level: string } }).__moHeaderUser = { privilege_level: 'admin' };
    return (
      <Box sx={{ minHeight: 80 }}>
        <GlobalHeader />
      </Box>
    );
  },
  parameters: {
    docs: {
      description: {
        story:
          'Admin view: both the Shield (Admin panel) button and the AutoStories (Design system) button are rendered immediately after the Customers icon.',
      },
    },
  },
};

export const AdminStorybookActive: Story = {
  name: 'Admin — Design system button active (on /storybook)',
  render: () => {
    history.replaceState(null, '', '/storybook/');
    (window as { __moHeaderUser?: { privilege_level: string } }).__moHeaderUser = { privilege_level: 'admin' };
    return (
      <Box sx={{ minHeight: 80 }}>
        <GlobalHeader />
      </Box>
    );
  },
  parameters: {
    docs: {
      description: {
        story:
          'When the current path starts with /storybook the Design system button renders in the active highlight style.',
      },
    },
  },
};

export const AdminAdminActive: Story = {
  name: 'Admin — Admin panel button active (on /admin)',
  render: () => {
    history.replaceState(null, '', '/admin');
    (window as { __moHeaderUser?: { privilege_level: string } }).__moHeaderUser = { privilege_level: 'admin' };
    return (
      <Box sx={{ minHeight: 80 }}>
        <GlobalHeader />
      </Box>
    );
  },
  parameters: {
    docs: {
      description: {
        story:
          'When the current path starts with /admin the Admin panel button shows the active highlight; Design system button does not.',
      },
    },
  },
};
