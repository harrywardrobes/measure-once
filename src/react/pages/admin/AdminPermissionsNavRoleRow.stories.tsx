import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import {
  Box, Chip, IconButton, Stack, Tooltip, Typography,
} from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import TuneIcon from '@mui/icons-material/Tune';
import { NAV } from '../../components/BottomNav';

// ── Types (mirrored from AdminPermissionsPage) ──────────────────────────────

type NavRoleRowProps = {
  roleName: string;
  isCustomized: boolean;
  roleNavKeys: string[];
  defaultNavKeys: string[];
};

// ── Visual slice: a single nav-role row ─────────────────────────────────────
// This component mirrors the row rendering from AdminPermissionsPage (lines
// 221-276) so we can story both the "inheriting" and "customised" states
// without needing to boot the full page or mock its API calls.

function NavRoleRow({ roleName, isCustomized, roleNavKeys, defaultNavKeys }: NavRoleRowProps) {
  return (
    <Stack
      direction="row"
      spacing={1.5}
      sx={{
        p: 1,
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        flexWrap: 'wrap',
        gap: 1,
        alignItems: 'center',
      }}
    >
      <Typography variant="body2" sx={{ flex: 1, fontWeight: 600, minWidth: 100 }}>
        {roleName}
      </Typography>

      <Stack direction="row" spacing={0.5} sx={{ flex: 1, flexWrap: 'wrap', alignItems: 'center' }}>
        {isCustomized ? (
          roleNavKeys.map((k) => {
            const item = NAV.find((n) => n.key === k);
            return item ? (
              <Chip key={k} label={item.label} size="small" variant="outlined" />
            ) : null;
          })
        ) : (
          <>
            <Tooltip
              title="This role inherits the Default layout — changes to the Default row will apply here automatically. Click the tune icon to give this role its own custom layout."
              arrow
            >
              <Chip
                label="Inheriting default"
                size="small"
                icon={<InfoOutlinedIcon />}
                sx={{ fontStyle: 'italic', cursor: 'help' }}
              />
            </Tooltip>
            {defaultNavKeys.map((k) => {
              const item = NAV.find((n) => n.key === k);
              return item ? (
                <Chip
                  key={k}
                  label={item.label}
                  size="small"
                  variant="outlined"
                  sx={{ opacity: 0.45 }}
                />
              ) : null;
            })}
          </>
        )}
        <Tooltip title="Edit navigation layout">
          <IconButton size="small" onClick={() => undefined}>
            <TuneIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
    </Stack>
  );
}

// ── Fixture data ─────────────────────────────────────────────────────────────

const DEFAULT_NAV_KEYS = ['home', 'customers', 'projects'];
const CUSTOM_NAV_KEYS  = ['home', 'customers', 'projects', 'invoices'];

// ── Meta ──────────────────────────────────────────────────────────────────────

const meta: Meta<typeof NavRoleRow> = {
  title: 'Admin/Permissions/NavRoleRow',
  component: NavRoleRow,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'A single nav-role row from the **Manage job roles** section of the Permissions admin panel. ' +
          'Each row shows the role name alongside its navigation-layout chips. ' +
          'When `is_customized` is **false** the row shows an "Inheriting default" badge and ' +
          'faded (opacity 0.45) preview chips for whatever the Default row currently has set. ' +
          'When `is_customized` is **true** the row shows the role\'s own chips at full opacity. ' +
          'Introduced alongside the nav-role permissions feature; Storybook stories added when the design system gallery was extended to cover the new row.',
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof NavRoleRow>;

// ── Stories ───────────────────────────────────────────────────────────────────

export const InheritingDefault: Story = {
  name: 'Inheriting default',
  args: {
    roleName: 'Surveyor',
    isCustomized: false,
    roleNavKeys: DEFAULT_NAV_KEYS,
    defaultNavKeys: DEFAULT_NAV_KEYS,
  },
  parameters: {
    docs: {
      description: {
        story:
          'Role with `is_customized: false`. ' +
          'Shows the **"Inheriting default"** badge (italic chip with info icon and tooltip) ' +
          'followed by faded (opacity 0.45) preview chips reflecting the current Default layout. ' +
          'This is the state a new role starts in before an admin gives it a custom layout.',
      },
    },
  },
};

export const Customised: Story = {
  name: 'Customised layout',
  args: {
    roleName: 'Designer',
    isCustomized: true,
    roleNavKeys: CUSTOM_NAV_KEYS,
    defaultNavKeys: DEFAULT_NAV_KEYS,
  },
  parameters: {
    docs: {
      description: {
        story:
          'Role with `is_customized: true`. ' +
          'Shows the role\'s own navigation chips at full opacity — no "Inheriting default" badge. ' +
          'The admin has explicitly assigned Home, Customers, Projects and Invoices to this role.',
      },
    },
  },
};

export const BothStates: Story = {
  name: 'Both states side by side',
  render: () => (
    <Stack spacing={1} sx={{ maxWidth: 640 }}>
      <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5 }}>
        Inheriting (no custom layout set)
      </Typography>
      <NavRoleRow
        roleName="Surveyor"
        isCustomized={false}
        roleNavKeys={DEFAULT_NAV_KEYS}
        defaultNavKeys={DEFAULT_NAV_KEYS}
      />

      <Box sx={{ mt: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5 }}>
          Customised layout
        </Typography>
      </Box>
      <NavRoleRow
        roleName="Designer"
        isCustomized={true}
        roleNavKeys={CUSTOM_NAV_KEYS}
        defaultNavKeys={DEFAULT_NAV_KEYS}
      />
    </Stack>
  ),
  parameters: {
    docs: {
      description: {
        story:
          'Both states rendered together for easy visual comparison. ' +
          '"Surveyor" inherits the Default layout (Home, Customers, Calendar shown faded). ' +
          '"Designer" has a customised layout (Home, Customers, Projects, Invoices at full opacity).',
      },
    },
  },
};
