import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
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
} from '../components/PageLoadingSkeleton';

const meta: Meta = {
  title: 'Admin/DesignSystemPage',
  tags: ['autodocs'],
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Gallery of all 14 page-level Suspense skeleton variants. ' +
          'Each ComponentShowcase card renders a skeleton with `forceVisible` ' +
          'so it is immediately visible without the 200 ms delay.',
      },
    },
  },
};
export default meta;

type Story = StoryObj;

// ── ComponentShowcase ─────────────────────────────────────────────────────────
// Lightweight labelled wrapper used by the AllSkeletons story. The
// `data-component-showcase` attribute lets the e2e test find each card and
// verify that a .MuiSkeleton-root element is present inside it.

function ComponentShowcase({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Box
      data-component-showcase={label}
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 2,
        overflow: 'hidden',
        mb: 3,
      }}
    >
      <Box
        sx={{
          px: 2,
          py: 1,
          borderBottom: '1px solid',
          borderColor: 'divider',
          bgcolor: 'action.hover',
        }}
      >
        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
          {label}
        </Typography>
      </Box>
      <Box>{children}</Box>
    </Box>
  );
}

// ── Stories ───────────────────────────────────────────────────────────────────

export const AllSkeletons: Story = {
  name: 'All 14 page skeletons',
  render: () => (
    <Box sx={{ maxWidth: 800, mx: 'auto', py: 2 }}>
      <ComponentShowcase label="PageLoadingSkeleton">
        <PageLoadingSkeleton forceVisible />
      </ComponentShowcase>

      <ComponentShowcase label="CustomersPageSkeleton">
        <CustomersPageSkeleton forceVisible />
      </ComponentShowcase>

      <ComponentShowcase label="CalendarPageSkeleton">
        <CalendarPageSkeleton forceVisible />
      </ComponentShowcase>

      <ComponentShowcase label="HomePageSkeleton">
        <HomePageSkeleton forceVisible />
      </ComponentShowcase>

      <ComponentShowcase label="ProfilePageSkeleton">
        <ProfilePageSkeleton forceVisible />
      </ComponentShowcase>

      <ComponentShowcase label="AdminTeamPageSkeleton">
        <AdminTeamPageSkeleton forceVisible />
      </ComponentShowcase>

      <ComponentShowcase label="AdminPermissionsPageSkeleton">
        <AdminPermissionsPageSkeleton forceVisible />
      </ComponentShowcase>

      <ComponentShowcase label="AdminRequestsPageSkeleton">
        <AdminRequestsPageSkeleton forceVisible />
      </ComponentShowcase>

      <ComponentShowcase label="AdminAuditLogPageSkeleton">
        <AdminAuditLogPageSkeleton forceVisible />
      </ComponentShowcase>

      <ComponentShowcase label="AdminSettingsPageSkeleton">
        <AdminSettingsPageSkeleton forceVisible />
      </ComponentShowcase>

      <ComponentShowcase label="CardActionsPageSkeleton">
        <CardActionsPageSkeleton forceVisible />
      </ComponentShowcase>

      <ComponentShowcase label="ActionHandlersPageSkeleton">
        <ActionHandlersPageSkeleton forceVisible />
      </ComponentShowcase>

      <ComponentShowcase label="LoginPageSkeleton">
        <LoginPageSkeleton forceVisible />
      </ComponentShowcase>

      <ComponentShowcase label="ProjectsPageSkeleton">
        <ProjectsPageSkeleton forceVisible />
      </ComponentShowcase>
    </Box>
  ),
};
