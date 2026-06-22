import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Box, Card, CardActionArea, Chip, CircularProgress, Stack, Typography } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { STAGE_COLORS, STATUS_COLORS } from '../theme';
import { STAGE_LABELS as DEFAULT_STAGE_LABELS } from '../utils/stageKeys';

const meta: Meta = {
  title: 'Features/Pages/CustomerCard',
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          "The **CustomerCard** component shown on the Customers page. Cards display contact details, lead status, and invoice/customer-number chips. When a card action handler is configured for the contact's primary stage/lead-status, an **action strip** appears at the bottom — tinted with the stage colour. A **\"Continue designing\"** strip appears when the contact has a saved draft design visit. Clicking the strip opens the handler modal; clicking the rest of the card navigates to the customer detail page.",
      },
    },
  },
};
export default meta;

type Story = StoryObj;

// ── Shared demo card shell ──────────────────────────────────────────────────


interface DemoRoom {
  room: string;
  stageKey: string;
}

interface DemoCardProps {
  name: string;
  email?: string;
  phone?: string;
  leadStatusLabel?: string;
  customerNum?: string;
  rooms?: DemoRoom[];
  actionLabel?: string;
  actionStageKey?: string;
  showContinueDesigning?: boolean;
  continuingDesign?: boolean;
  showInvoiceBadge?: boolean;
  /** When true, the strip is label-only (no handler) — non-interactive, no chevron. */
  labelOnly?: boolean;
}


function DemoCustomerCard({
  name,
  email = 'jane@example.com',
  phone,
  leadStatusLabel,
  customerNum,
  rooms = [{ room: 'Main', stageKey: 'sales' }],
  actionLabel,
  actionStageKey,
  showContinueDesigning = false,
  continuingDesign = false,
  showInvoiceBadge = false,
  labelOnly = false,
}: DemoCardProps) {
  const primaryStageKey = rooms[0]?.stageKey || 'sales';
  const stageColors = STAGE_COLORS[actionStageKey || primaryStageKey];
  const actionTint = showContinueDesigning ? 'success.light' : (stageColors?.light || STATUS_COLORS.neutral.bg);
  const actionTextColor = showContinueDesigning ? 'success.dark' : (stageColors?.text || STATUS_COLORS.neutral.text);
  const multiRoom = rooms.length > 1;

  const hasStrip = actionLabel || showContinueDesigning;
  const stripLabel = showContinueDesigning
    ? continuingDesign
      ? 'Opening…'
      : 'Continue designing'
    : actionLabel;
  const isInteractive = !labelOnly;

  return (
    <Card variant="outlined" sx={{ width: '100%', maxWidth: 360, overflow: 'hidden' }}>
      <CardActionArea
        component="a"
        href="#"
        onClick={(e: React.MouseEvent) => e.preventDefault()}
        sx={{ p: 2, display: 'block' }}
      >
        {/* Two-column layout on md+; single column on mobile — mirrors real CustomerCard */}
        <Box sx={{ display: 'flex', gap: 2, flexDirection: { xs: 'column', md: 'row' }, alignItems: { md: 'flex-start' } }}>
          {/* Left column — name */}
          <Box sx={{ flex: '1 1 0', minWidth: 0 }}>
            <Typography
              variant="subtitle1"
              noWrap
              sx={{ display: 'flex', alignItems: 'center', minWidth: 0 }}
            >
              <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {name}
              </Box>
            </Typography>
          </Box>
          {/* Right column — lead-status chip, matching the real CustomerCard layout */}
          <Box sx={{ flex: '0 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: { xs: 'flex-start', md: 'flex-end' }, gap: 0.75 }}>
            {leadStatusLabel ? (
              <Chip label={leadStatusLabel} size="small" color="primary" variant="outlined" />
            ) : null}
          </Box>
        </Box>

        <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap' }}>
          {email ? <Chip label={email} size="small" variant="outlined" /> : null}
          {phone ? <Chip label={phone} size="small" variant="outlined" /> : null}
          {showInvoiceBadge ? (
            <Chip label="1 invoice" size="small" color="success" variant="outlined" />
          ) : null}
          {customerNum ? (
            <Chip label={customerNum} size="small" color="secondary" variant="outlined" />
          ) : null}
        </Stack>
      </CardActionArea>

      {hasStrip && (
        <Box
          role={isInteractive ? 'button' : undefined}
          tabIndex={isInteractive ? -1 : undefined}
          title={isInteractive ? (stripLabel || 'Run action') : undefined}
          onClick={isInteractive ? (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); } : undefined}
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            px: 2,
            py: '9px',
            bgcolor: actionTint,
            borderTop: '1px solid',
            borderColor: 'divider',
            cursor: isInteractive ? (continuingDesign ? 'wait' : 'pointer') : 'default',
            opacity: continuingDesign ? 0.7 : 1,
            transition: 'opacity 0.15s, filter 0.12s',
            '&:hover': (isInteractive && !continuingDesign) ? { filter: 'brightness(0.96)' } : undefined,
          }}
        >
          <Typography sx={{ color: actionTextColor, fontWeight: 600, fontSize: '0.78rem' }}>
            {stripLabel}
          </Typography>
          {isInteractive && (continuingDesign ? (
            <CircularProgress size={12} sx={{ color: actionTextColor }} />
          ) : (
            <ChevronRightIcon sx={{ fontSize: 15, color: actionTextColor, flexShrink: 0 }} />
          ))}
        </Box>
      )}
    </Card>
  );
}

// ── Stories ─────────────────────────────────────────────────────────────────

export const NoActionStrip: Story = {
  name: 'No action strip',
  parameters: {
    docs: {
      description: {
        story:
          'A standard customer card with no handler configured for this stage. The card navigates to the customer detail page on click.',
      },
    },
  },
  render: () => (
    <DemoCustomerCard
      name="Sarah Johnson"
      email="sarah@example.com"
      phone="07700 900 123"
      leadStatusLabel="Qualified"
      customerNum="C-0042"
      rooms={[{ room: 'Main', stageKey: 'sales' }]}
    />
  ),
};

export const WithActionStrip: Story = {
  name: 'With action strip (handler matched)',
  parameters: {
    docs: {
      description: {
        story:
          "A handler is configured for the card's stage/lead-status combination. The coloured strip uses the primary stage's colour from `STAGE_COLORS`.",
      },
    },
  },
  render: () => (
    <DemoCustomerCard
      name="Alex Johnson"
      email="alex@example.com"
      leadStatusLabel="Interested"
      rooms={[{ room: 'Main', stageKey: 'designvisit' }]}
      actionLabel="Book Design Visit"
      actionStageKey="designvisit"
    />
  ),
};

export const WithContinueDesigning: Story = {
  name: 'With "Continue designing" strip (draft visit)',
  parameters: {
    docs: {
      description: {
        story:
          'When the handler type is `start_design_visit` and a draft visit exists for this contact, the strip shows "Continue designing" with a green tint regardless of stage colour.',
      },
    },
  },
  render: () => (
    <DemoCustomerCard
      name="Sam Williams"
      email="sam@example.com"
      leadStatusLabel="Design visit booked"
      rooms={[{ room: 'Main', stageKey: 'designvisit' }]}
      showContinueDesigning
    />
  ),
};

export const ContinueDesigningLoading: Story = {
  name: '"Continue designing" — loading state',
  parameters: {
    docs: {
      description: {
        story:
          'While the draft visit is being fetched after the strip is tapped, the strip shows "Opening…" with a spinner and a wait cursor.',
      },
    },
  },
  render: () => (
    <DemoCustomerCard
      name="Sam Williams"
      email="sam@example.com"
      leadStatusLabel="Design visit booked"
      rooms={[{ room: 'Main', stageKey: 'designvisit' }]}
      showContinueDesigning
      continuingDesign
    />
  ),
};

export const MultiRoomWithStrip: Story = {
  name: 'Multi-room card with action strip',
  parameters: {
    docs: {
      description: {
        story:
          'The primary stage is the first active room (rooms sorted by stage descending). The strip colour matches the primary stage.',
      },
    },
  },
  render: () => (
    <DemoCustomerCard
      name="Chris Taylor"
      email="chris@example.com"
      customerNum="C-0117"
      rooms={[
        { room: 'Kitchen', stageKey: 'order' },
        { room: 'Bedroom', stageKey: 'survey' },
      ]}
      actionLabel="Confirm Order"
      actionStageKey="order"
    />
  ),
};

export const SalesStageAction: Story = {
  name: 'Sales stage — action strip',
  render: () => (
    <DemoCustomerCard
      name="Dana Brown"
      email="dana@example.com"
      phone="07700 911234"
      leadStatusLabel="New lead"
      rooms={[{ room: 'Main', stageKey: 'sales' }]}
      actionLabel="Follow Up Call"
      actionStageKey="sales"
    />
  ),
};

export const SurveyStage: Story = {
  name: 'Action strip — Survey stage',
  render: () => (
    <DemoCustomerCard
      name="Tom Richards"
      email="tom@example.com"
      rooms={[{ room: 'Main', stageKey: 'survey' }]}
      actionLabel="Schedule Survey"
      actionStageKey="survey"
    />
  ),
};

export const InstallationStage: Story = {
  name: 'Action strip — Installation stage',
  render: () => (
    <DemoCustomerCard
      name="Priya Patel"
      email="priya@example.com"
      rooms={[{ room: 'Main', stageKey: 'installation' }]}
      actionLabel="Schedule Installation"
      actionStageKey="installation"
    />
  ),
};

export const WithInvoiceBadge: Story = {
  name: 'With invoice badge + action strip',
  parameters: {
    docs: {
      description: {
        story: 'Invoice badge and action strip can both appear simultaneously.',
      },
    },
  },
  render: () => (
    <DemoCustomerCard
      name="Daniel Kim"
      email="daniel@example.com"
      leadStatusLabel="Won"
      customerNum="C-0887"
      rooms={[{ room: 'Main', stageKey: 'delivery' }]}
      actionLabel="Confirm Delivery"
      actionStageKey="delivery"
      showInvoiceBadge
    />
  ),
};

export const LabelOnlyStripOrder: Story = {
  name: 'Label-only strip — ORDER stage (no handler)',
  parameters: {
    docs: {
      description: {
        story:
          'When an admin configures a text label for a non-sales stage in Card Actions (but no handler), the strip shows with the stage colour tint but is **non-interactive** — no chevron, default cursor. This now works for ORDER, WORKSHOP, PACKING, DELIVERY, INSTALLATION, and AFTERCARE stages.',
      },
    },
  },
  render: () => (
    <DemoCustomerCard
      name="Oliver Wright"
      email="oliver@example.com"
      rooms={[{ room: 'Main', stageKey: 'order' }]}
      actionLabel="Order confirmed — awaiting workshop"
      actionStageKey="order"
      labelOnly
    />
  ),
};

export const AllStageVariants: Story = {
  name: 'All stage colour variants',
  parameters: {
    docs: {
      description: {
        story: 'One card per pipeline stage, showing each stage colour tinting the action strip.',
      },
    },
  },
  render: () => (
    <Stack spacing={2} sx={{ maxWidth: 360 }}>
      {Object.entries(DEFAULT_STAGE_LABELS).map(([stageKey, stageLabel]) => (
        <DemoCustomerCard
          key={stageKey}
          name={`Demo Customer — ${stageLabel}`}
          email="demo@example.com"
          rooms={[{ room: 'Main', stageKey }]}
          actionLabel={`Action for ${stageLabel}`}
          actionStageKey={stageKey}
        />
      ))}
    </Stack>
  ),
};


