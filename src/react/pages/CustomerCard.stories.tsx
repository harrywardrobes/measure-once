import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Box, Card, CardActionArea, Chip, CircularProgress, Stack, Typography } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { STAGE_COLORS } from '../theme';

const meta: Meta = {
  title: 'Features/Pages/CustomerCard',
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          "The **CustomerCard** component shown on the Customers page. Cards display contact details, pipeline stage pills, and invoice/customer-number chips. When a card action handler is configured for the contact's primary stage/lead-status, an **action strip** appears at the bottom — tinted with the stage colour. A **\"Continue designing\"** strip appears when the contact has a saved draft design visit. Clicking the strip opens the handler modal; clicking the rest of the card navigates to the customer detail page.",
      },
    },
  },
};
export default meta;

type Story = StoryObj;

// ── Shared demo card shell ──────────────────────────────────────────────────

const DEFAULT_STAGE_LABELS: Record<string, string> = {
  sales: 'Sales',
  designvisit: 'Design Visit',
  survey: 'Survey',
  order: 'Order',
  workshop: 'Workshop',
  packing: 'Packing',
  delivery: 'Delivery',
  installation: 'Installation',
  aftercare: 'Aftercare',
};

interface DemoRoom {
  room: string;
  stageKey: string;
}

interface DemoCardProps {
  name: string;
  email?: string;
  phone?: string;
  leadStatusLabel?: string;
  substatusLabel?: string;
  customerNum?: string;
  rooms?: DemoRoom[];
  actionLabel?: string;
  actionStageKey?: string;
  showContinueDesigning?: boolean;
  continuingDesign?: boolean;
  showInvoiceBadge?: boolean;
}

function StagePill({ stageKey, label }: { stageKey: string; label: string }) {
  const sc = STAGE_COLORS[stageKey] || STAGE_COLORS.sales;
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        fontSize: '0.72rem',
        fontWeight: 700,
        px: '8px',
        py: '2px',
        borderRadius: '999px',
        bgcolor: sc.light,
        color: sc.text,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </Box>
  );
}

function DemoCustomerCard({
  name,
  email = 'jane@example.com',
  phone,
  leadStatusLabel,
  substatusLabel,
  customerNum,
  rooms = [{ room: 'Main', stageKey: 'sales' }],
  actionLabel,
  actionStageKey,
  showContinueDesigning = false,
  continuingDesign = false,
  showInvoiceBadge = false,
}: DemoCardProps) {
  const primaryStageKey = actionStageKey || rooms[0]?.stageKey || 'sales';
  const stageColors = STAGE_COLORS[primaryStageKey];
  const actionTint = showContinueDesigning ? '#F0FDF4' : (stageColors?.light || '#f3f4f6');
  const actionTextColor = showContinueDesigning ? '#15803d' : (stageColors?.text || '#374151');
  const multiRoom = rooms.length > 1;

  const hasStrip = actionLabel || showContinueDesigning;
  const stripLabel = showContinueDesigning
    ? continuingDesign
      ? 'Opening…'
      : 'Continue designing'
    : actionLabel;

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
          {/* Right column — lead-status chip + optional substatus chip, matching the real CustomerCard layout */}
          <Box sx={{ flex: '0 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: { xs: 'flex-start', md: 'flex-end' }, gap: 0.75 }}>
            {leadStatusLabel ? (
              <Chip label={leadStatusLabel} size="small" color="primary" variant="outlined" />
            ) : null}
            {substatusLabel ? (
              <Chip label={substatusLabel} size="small" variant="outlined" />
            ) : null}
          </Box>
        </Box>

        <Stack direction="row" spacing={0.75} sx={{ mt: 1, flexWrap: 'wrap' }}>
          {rooms.map((r, idx) => {
            const lbl = DEFAULT_STAGE_LABELS[r.stageKey] || r.stageKey;
            const pillText = multiRoom && r.room && r.room !== 'Main' ? `${lbl} — ${r.room}` : lbl;
            return <StagePill key={idx} stageKey={r.stageKey} label={pillText} />;
          })}
        </Stack>

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
          role="button"
          tabIndex={-1}
          title={stripLabel || 'Run action'}
          onClick={(e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            px: 2,
            py: '9px',
            bgcolor: actionTint,
            borderTop: '1px solid',
            borderColor: 'divider',
            cursor: continuingDesign ? 'wait' : 'pointer',
            opacity: continuingDesign ? 0.7 : 1,
            transition: 'opacity 0.15s, filter 0.12s',
            '&:hover': continuingDesign ? undefined : { filter: 'brightness(0.96)' },
          }}
        >
          <Typography sx={{ color: actionTextColor, fontWeight: 600, fontSize: '0.78rem' }}>
            {stripLabel}
          </Typography>
          {continuingDesign ? (
            <CircularProgress size={12} sx={{ color: actionTextColor }} />
          ) : (
            <ChevronRightIcon sx={{ fontSize: 15, color: actionTextColor, flexShrink: 0 }} />
          )}
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

// ── Substatus chip stories ───────────────────────────────────────────────────

export const SubstatusWithLeadStatus: Story = {
  name: 'Substatus chip — lead status + substatus set',
  parameters: {
    docs: {
      description: {
        story:
          'When both `hs_lead_status` and `hw_lead_substatus` are set and a matching label is found in `substatusMap`, **both chips** appear in the right column. The lead-status chip uses `color="primary"` (blue outlined); the substatus chip uses the default neutral outlined style, stacked below.',
      },
    },
  },
  render: () => (
    <DemoCustomerCard
      name="Emma Clarke"
      email="emma@example.com"
      phone="07700 900 456"
      leadStatusLabel="Interested"
      substatusLabel="Ready to book"
      rooms={[{ room: 'Main', stageKey: 'sales' }]}
    />
  ),
};

export const SubstatusLeadStatusOnly: Story = {
  name: 'Substatus chip — lead status set, no substatus',
  parameters: {
    docs: {
      description: {
        story:
          'When `hs_lead_status` is set but `hw_lead_substatus` is absent (or has no matching label in `substatusMap`), only the lead-status chip appears. The substatus chip is not rendered.',
      },
    },
  },
  render: () => (
    <DemoCustomerCard
      name="Marcus Lee"
      email="marcus@example.com"
      leadStatusLabel="Qualified"
      rooms={[{ room: 'Main', stageKey: 'designvisit' }]}
    />
  ),
};

export const SubstatusNeitherSet: Story = {
  name: 'Substatus chip — neither lead status nor substatus set',
  parameters: {
    docs: {
      description: {
        story:
          'When neither `hs_lead_status` nor `hw_lead_substatus` is set, no status chips are rendered at all. The right column is empty and the card shows only stage pills and contact-detail chips.',
      },
    },
  },
  render: () => (
    <DemoCustomerCard
      name="Fatima Hassan"
      email="fatima@example.com"
      phone="07700 912 345"
      rooms={[{ room: 'Main', stageKey: 'survey' }]}
    />
  ),
};

export const NarrowWidthBothChips: Story = {
  name: 'Substatus chip — narrow width (mobile stacking)',
  parameters: {
    viewport: {
      defaultViewport: 'mobile2',
    },
    docs: {
      description: {
        story:
          'At ~375 px (mobile viewport) the right column switches to `alignItems: flex-start`, so the lead-status chip and substatus chip both align to the **left edge** below the contact name. This mirrors the real CustomerCard responsive layout (`alignItems: { xs: "flex-start", md: "flex-end" }`) and lets designers verify that both chips are visible and correctly stacked when the card is narrow.',
      },
    },
  },
  render: () => (
    <DemoCustomerCard
      name="Emma Clarke"
      email="emma@example.com"
      phone="07700 900 456"
      leadStatusLabel="Interested"
      substatusLabel="Ready to book"
      rooms={[{ room: 'Main', stageKey: 'sales' }]}
    />
  ),
};

