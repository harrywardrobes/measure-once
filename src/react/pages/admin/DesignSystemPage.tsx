import React, { useState } from 'react';
import { Box, Tabs, Tab } from '@mui/material';
import { ComponentShowcase } from '../../components/ComponentShowcase';
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
} from '../../components/PageLoadingSkeleton';

const SKELETON_ENTRIES: Array<{
  name: string;
  Component: (props: { forceVisible?: boolean }) => React.ReactElement | null;
}> = [
  { name: 'PageLoadingSkeleton',          Component: PageLoadingSkeleton },
  { name: 'CustomersPageSkeleton',        Component: CustomersPageSkeleton },
  { name: 'CalendarPageSkeleton',         Component: CalendarPageSkeleton },
  { name: 'HomePageSkeleton',             Component: HomePageSkeleton },
  { name: 'ProfilePageSkeleton',          Component: ProfilePageSkeleton },
  { name: 'AdminTeamPageSkeleton',        Component: AdminTeamPageSkeleton },
  { name: 'AdminPermissionsPageSkeleton', Component: AdminPermissionsPageSkeleton },
  { name: 'AdminRequestsPageSkeleton',    Component: AdminRequestsPageSkeleton },
  { name: 'AdminAuditLogPageSkeleton',    Component: AdminAuditLogPageSkeleton },
  { name: 'AdminSettingsPageSkeleton',    Component: AdminSettingsPageSkeleton },
  { name: 'CardActionsPageSkeleton',      Component: CardActionsPageSkeleton },
  { name: 'ActionHandlersPageSkeleton',   Component: ActionHandlersPageSkeleton },
  { name: 'LoginPageSkeleton',            Component: LoginPageSkeleton },
  { name: 'ProjectsPageSkeleton',         Component: ProjectsPageSkeleton },
];

/**
 * Admin → Design system tab (#tab-designsystem).
 *
 * Hosts the in-app design-system gallery. The "Skeletons" inner tab renders
 * every page-loading skeleton with `forceVisible` so they appear immediately
 * without any network interaction or loading delay.
 *
 * The design-system-skeletons end-to-end test (test/design-system-skeletons/run.js)
 * relies on this page: it activates #tab-designsystem, clicks the "Skeletons"
 * inner tab, then asserts that each ComponentShowcase card contains at least one
 * .MuiSkeleton-root element.
 */
export function DesignSystemPage() {
  const [tab, setTab] = useState(0);

  return (
    <Box sx={{ p: 3 }}>
      <Tabs
        value={tab}
        onChange={(_, v: number) => setTab(v)}
        sx={{ mb: 3 }}
      >
        <Tab label="Skeletons" />
      </Tabs>

      {tab === 0 && (
        <Box className="ds-section">
          {SKELETON_ENTRIES.map(({ name, Component }) => (
            <ComponentShowcase key={name} name={name}>
              <Component forceVisible />
            </ComponentShowcase>
          ))}
        </Box>
      )}
    </Box>
  );
}
