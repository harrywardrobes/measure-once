import type { Meta, StoryObj } from '@storybook/react';
import {
  PageLoadingSkeleton,
  CustomersPageSkeleton,
  CalendarPageSkeleton,
  HomePageSkeleton,
  ProfilePageSkeleton,
  AdminTeamPageSkeleton,
  AdminPermissionsPageSkeleton,
  AdminRequestsPageSkeleton,
  AdminAuditLogPageSkeleton,
  AdminSettingsPageSkeleton,
  CardActionsPageSkeleton,
  ActionHandlersPageSkeleton,
  LoginPageSkeleton,
  ProjectsPageSkeleton,
} from './PageLoadingSkeleton';

const meta: Meta = {
  title: 'Components/Skeletons/PageSkeletons',
  tags: ['autodocs'],
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Shape-matched Suspense fallback skeletons for each page. All rendered with `forceVisible` so they appear immediately without the 200 ms delay.',
      },
    },
  },
};
export default meta;

type Story = StoryObj;

export const PageLoading: Story = {
  name: 'PageLoadingSkeleton',
  render: () => <PageLoadingSkeleton forceVisible />,
};

export const Customers: Story = {
  name: 'CustomersPageSkeleton',
  render: () => <CustomersPageSkeleton forceVisible />,
};

export const Calendar: Story = {
  name: 'CalendarPageSkeleton',
  render: () => <CalendarPageSkeleton forceVisible />,
};

export const Home: Story = {
  name: 'HomePageSkeleton',
  render: () => <HomePageSkeleton forceVisible />,
};

export const Profile: Story = {
  name: 'ProfilePageSkeleton',
  render: () => <ProfilePageSkeleton forceVisible />,
};

export const AdminTeam: Story = {
  name: 'AdminTeamPageSkeleton',
  render: () => <AdminTeamPageSkeleton forceVisible />,
};

export const AdminPermissions: Story = {
  name: 'AdminPermissionsPageSkeleton',
  render: () => <AdminPermissionsPageSkeleton forceVisible />,
};

export const AdminRequests: Story = {
  name: 'AdminRequestsPageSkeleton',
  render: () => <AdminRequestsPageSkeleton forceVisible />,
};

export const AdminAuditLog: Story = {
  name: 'AdminAuditLogPageSkeleton',
  render: () => <AdminAuditLogPageSkeleton forceVisible />,
};

export const AdminSettings: Story = {
  name: 'AdminSettingsPageSkeleton',
  render: () => <AdminSettingsPageSkeleton forceVisible />,
};

export const CardActions: Story = {
  name: 'CardActionsPageSkeleton',
  render: () => <CardActionsPageSkeleton forceVisible />,
};

export const ActionHandlers: Story = {
  name: 'ActionHandlersPageSkeleton',
  render: () => <ActionHandlersPageSkeleton forceVisible />,
};

export const Login: Story = {
  name: 'LoginPageSkeleton',
  render: () => <LoginPageSkeleton forceVisible />,
};

export const Projects: Story = {
  name: 'ProjectsPageSkeleton',
  render: () => <ProjectsPageSkeleton forceVisible />,
};
